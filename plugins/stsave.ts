import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { safeGetMe } from "@utils/authGuards";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { Api, TelegramClient } from "teleproto";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const CONFIG_DIR = createDirectoryInAssets("stsave");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const execFileAsync = promisify(execFile);
const MAX_STATIC_STICKER_BYTES = 512 * 1024;
const MAX_VIDEO_STICKER_BYTES = 256 * 1024;
const VIDEO_STICKER_FPS = 30;
const VIDEO_CRF_STEPS = [24, 30, 36, 42, 48, 54, 58, 62, 63];

type StickerKind = "static" | "animated" | "video";

interface StickerSaverConfig {
  pack: string;
  defaultEmoji: string;
}

interface StickerInfo {
  kind: StickerKind;
  emoji: string;
  document: Api.InputDocument;
  source: Api.Document;
}

interface DetectedInput {
  mode: "sticker" | "image" | "video";
  sticker?: StickerInfo;
}

const DEFAULT_CONFIG: StickerSaverConfig = {
  pack: "",
  defaultEmoji: "⭐",
};

function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function loadConfig(): StickerSaverConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      saveConfig(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // Seamlessly migrate the previous three-pack format. Prefer the value shared
    // by all types; otherwise use static/video/animated in that order.
    const legacyPacks = parsed?.packs && typeof parsed.packs === "object" ? parsed.packs : {};
    const pack = typeof parsed?.pack === "string"
      ? parsed.pack.trim()
      : String(legacyPacks.static || legacyPacks.video || legacyPacks.animated || "").trim();
    return {
      pack,
      defaultEmoji: typeof parsed?.defaultEmoji === "string" && parsed.defaultEmoji.trim()
        ? parsed.defaultEmoji.trim()
        : DEFAULT_CONFIG.defaultEmoji,
    };
  } catch (error) {
    console.error("[stsave] 读取配置失败:", error);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: StickerSaverConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const temp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(temp, CONFIG_PATH);
}

export function stickerKindFromMime(mimeType: string): StickerKind | undefined {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "application/x-tgsticker") return "animated";
  if (mime === "video/webm") return "video";
  if (mime === "image/webp" || mime === "image/png") return "static";
  return undefined;
}

export function normalizePackName(value: string): string {
  return value.trim().replace(/^https?:\/\/t\.me\/addstickers\//i, "").split(/[?#]/)[0];
}

export function isValidPackName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(value);
}

function kindLabel(kind: StickerKind): string {
  return kind === "static" ? "静态" : kind === "animated" ? "动态 TGS" : "视频 WebM";
}

function extractStickerInfo(message: Api.Message, defaultEmoji: string): StickerInfo {
  const document = message.sticker;
  if (!(document instanceof Api.Document)) {
    throw new Error("请回复一张有效贴纸（支持静态、动态 TGS 和视频 WebM）");
  }

  const kind = stickerKindFromMime(document.mimeType || "");
  if (!kind) {
    throw new Error(`暂不支持这种贴纸格式：${document.mimeType || "未知"}`);
  }

  const stickerAttr = document.attributes?.find(
    (attr): attr is Api.DocumentAttributeSticker => attr instanceof Api.DocumentAttributeSticker,
  );
  const emoji = stickerAttr?.alt?.trim() || defaultEmoji;

  return {
    kind,
    emoji,
    source: document,
    document: new Api.InputDocument({
      id: document.id,
      accessHash: document.accessHash,
      fileReference: document.fileReference || Buffer.alloc(0),
    }),
  };
}

function stickerSetKinds(result: Api.messages.StickerSet): Set<StickerKind> {
  const kinds = new Set<StickerKind>();
  for (const document of result.documents) {
    if (!(document instanceof Api.Document)) continue;
    const kind = stickerKindFromMime(document.mimeType || "");
    if (kind) kinds.add(kind);
  }
  return kinds;
}

function stickerSetAcceptsKind(result: Api.messages.StickerSet, kind: StickerKind): boolean {
  const kinds = stickerSetKinds(result);
  return kinds.size === 0 || kinds.has(kind);
}

function detectInput(message: Api.Message, defaultEmoji: string): DetectedInput {
  if (message.sticker instanceof Api.Document) {
    return { mode: "sticker", sticker: extractStickerInfo(message, defaultEmoji) };
  }
  if (message.photo instanceof Api.Photo) return { mode: "image" };

  if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document) {
    const document = message.media.document;
    const mime = (document.mimeType || "").toLowerCase();
    const attrs = document.attributes || [];
    const isAnimatedImage = mime === "image/gif" || attrs.some((attr) => attr instanceof Api.DocumentAttributeAnimated);
    if (mime.startsWith("image/") && !isAnimatedImage) return { mode: "image" };
    if (mime.startsWith("video/") || mime === "image/gif" || isAnimatedImage) return { mode: "video" };
  }

  throw new Error("请回复贴纸、图片、GIF 或视频");
}

async function downloadMessageBuffer(client: TelegramClient, message: Api.Message): Promise<Buffer> {
  const downloaded = await client.downloadMedia(message, {});
  if (Buffer.isBuffer(downloaded)) return downloaded;
  if (typeof downloaded === "string" && fs.existsSync(downloaded)) return fs.readFileSync(downloaded);
  throw new Error("下载回复媒体失败");
}

async function convertImageToWebp(input: Buffer): Promise<Buffer> {
  let quality = 92;
  let best: Buffer = Buffer.from([]);
  while (quality >= 45) {
    const candidate = await sharp(input, { animated: false })
      .rotate()
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        withoutEnlargement: false,
      })
      .webp({ quality, alphaQuality: 100, effort: 6 })
      .toBuffer();
    best = candidate;
    if (candidate.length <= MAX_STATIC_STICKER_BYTES) break;
    quality -= 8;
  }
  if (!best.length || best.length > MAX_STATIC_STICKER_BYTES) {
    throw new Error(`转换后的静态贴纸超过 512KB（${Math.ceil(best.length / 1024)}KB）`);
  }
  return best;
}

async function convertVideoToWebm(input: Buffer): Promise<Buffer> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(os.tmpdir(), `stsave_video_${unique}.input`);
  const outputPath = path.join(os.tmpdir(), `stsave_video_${unique}.webm`);
  try {
    fs.writeFileSync(inputPath, input);
    let best: Buffer = Buffer.from([]);
    for (const crf of VIDEO_CRF_STEPS) {
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", inputPath,
        "-t", "3",
        "-vf", `scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=${VIDEO_STICKER_FPS}`,
        "-an", "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-deadline", "good", "-cpu-used", "3",
        "-row-mt", "1", "-tile-columns", "1",
        "-b:v", "0", "-crf", String(crf),
        "-auto-alt-ref", "0",
        "-metadata:s:v:0", "alpha_mode=1",
        outputPath,
      ]);
      const candidate = fs.readFileSync(outputPath);
      if (candidate.length) best = candidate;
      if (candidate.length <= MAX_VIDEO_STICKER_BYTES) break;
    }
    if (!best.length || best.length > MAX_VIDEO_STICKER_BYTES) {
      throw new Error(`转换后的 WebM 超过 256KB（${Math.ceil(best.length / 1024)}KB）`);
    }
    return best;
  } finally {
    for (const file of [inputPath, outputPath]) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function errorCode(error: any): string {
  return String(error?.errorMessage || error?.message || error || "");
}

function friendlyError(error: any): string {
  const code = errorCode(error);
  if (code.includes("STICKERSET_INVALID")) return "贴纸包不存在或名称无效";
  if (code.includes("STICKERS_TOO_MUCH")) return "贴纸包已满，请切换其他贴纸包";
  if (code.includes("STICKERSET_NOT_MODIFIED")) return "这张贴纸可能已经在目标贴纸包中";
  if (code.includes("STICKERSET_OWNER_ANONYMOUS")) return "无法确认贴纸包所有者";
  if (code.includes("STICKER_VIDEO_LONG")) return "视频贴纸不能超过 3 秒";
  if (code.includes("STICKER_VIDEO_BIG")) return "视频贴纸文件过大";
  if (code.includes("STICKER_PNG_DIMENSIONS")) return "静态贴纸尺寸不符合 Telegram 要求";
  if (code.includes("FILE_REFERENCE_EXPIRED")) return "贴纸文件引用已过期，请重新发送或转发这张贴纸后再保存";
  if (code.includes("FLOOD_WAIT")) return `操作过于频繁，请稍后重试：${code}`;
  return code || "未知错误";
}

class StsavePlugin extends Plugin {
  name = "stsave";
  description = `⭐ 保存贴纸到自己的贴纸包（静态 / 动态 / 视频）\n` +
    `<code>${mainPrefix}stsave help</code>`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    stsave: async (msg) => this.handleCommand(msg),
    st: async (msg) => this.handleCommand(msg),
  };

  private helpText(): string {
    return `⭐ <b>贴纸保存插件</b>\n\n` +
      `<b>保存贴纸或转换媒体：</b>\n` +
      `回复贴纸、图片、GIF 或视频发送 <code>${mainPrefix}stsave</code>\n` +
      `• 静态贴纸原样保存；普通图片自动转成 512px WebP 静态贴纸。\n` +
      `• TGS 保留原始矢量 60 FPS；视频/GIF 自动转成 30 FPS VP9 WebM 视频贴纸。\n` +
      `静态、TGS 和 WebM 三种格式全部保存到同一个混合贴纸包。\n\n` +
      `<b>指定本次保存到某个包：</b>\n` +
      `<code>${mainPrefix}stsave to 包短名称</code>\n\n` +
      `<b>设置唯一目标贴纸包：</b>\n` +
      `<code>${mainPrefix}stsave set 包短名称</code>\n` +
      `<code>${mainPrefix}st set 包短名称</code>\n\n` +
      `<b>恢复自动选包：</b>\n` +
      `<code>${mainPrefix}stsave auto</code>\n\n` +
      `<b>其他：</b>\n` +
      `<code>${mainPrefix}stsave status</code> — 查看设置\n` +
      `<code>${mainPrefix}stsave emoji ⭐</code> — 设置无标签贴纸的默认表情\n\n` +
      `未设置固定包时，插件会自动创建一个混合贴纸包。`;
  }

  private async handleCommand(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化" });
      return;
    }

    try {
      const parts = (msg.message || msg.text || "").trim().split(/\s+/);
      const sub = (parts[1] || "").toLowerCase();
      const config = loadConfig();

      if (sub === "help" || sub === "h") {
        await msg.edit({ text: this.helpText(), parseMode: "html", linkPreview: false });
        return;
      }

      if (sub === "status" || (sub === "" && !msg.isReply)) {
        await this.showStatus(msg, config);
        return;
      }

      if (sub === "emoji") {
        const emoji = parts.slice(2).join(" ").trim();
        if (!emoji) throw new Error("请提供默认表情，例如：.stsave emoji ⭐");
        config.defaultEmoji = emoji;
        saveConfig(config);
        await msg.edit({ text: `✅ 默认表情已设置为 ${htmlEscape(emoji)}`, parseMode: "html" });
        return;
      }

      if (sub === "set") {
        const legacyTypeSyntax = ["static", "animated", "video"].includes((parts[2] || "").toLowerCase());
        const packName = normalizePackName(parts[legacyTypeSyntax ? 3 : 2] || "");
        if (!isValidPackName(packName)) {
          throw new Error("贴纸包短名称无效：必须以字母开头，只能包含字母、数字、下划线，长度 3-64");
        }
        await this.validateConfiguredPack(client, packName);
        config.pack = packName;
        saveConfig(config);
        await msg.edit({
          text: `✅ 唯一目标贴纸包已设置为 <a href="https://t.me/addstickers/${htmlEscape(packName)}">${htmlEscape(packName)}</a>\n静态、TGS、WebM 都会保存到这里。`,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      if (sub === "auto" || sub === "clear") {
        config.pack = "";
        saveConfig(config);
        await msg.edit({ text: "✅ 已恢复自动选择/创建一个混合贴纸包" });
        return;
      }

      const replied = await safeGetReplyMessage(msg);
      if (!replied) throw new Error("请回复贴纸、图片、GIF 或视频后再发送命令");
      const detected = detectInput(replied, config.defaultEmoji);
      let sticker: StickerInfo;

      if (detected.mode === "sticker" && detected.sticker) {
        sticker = detected.sticker;
      } else {
        await msg.edit({
          text: detected.mode === "image"
            ? "⏳ 正在将图片转换为静态 WebP 贴纸…"
            : "⏳ 正在将视频/GIF转换为 30 FPS WebM 视频贴纸…",
        });
        const conversionMode: "image" | "video" = detected.mode === "image" ? "image" : "video";
        sticker = await this.convertAndUploadMedia(client, replied, conversionMode, config.defaultEmoji);
      }

      let oneTimePack = "";
      if (sub === "to") {
        oneTimePack = normalizePackName(parts[2] || "");
        if (!isValidPackName(oneTimePack)) throw new Error("请提供正确的贴纸包短名称");
      } else if (sub && sub !== "save") {
        throw new Error(`未知子命令：${sub}`);
      }

      await msg.edit({ text: `⏳ 正在保存${kindLabel(sticker.kind)}贴纸…` });
      const me = await safeGetMe(client);
      if (!(me instanceof Api.User)) throw new Error("无法获取当前账号信息");

      const configured = oneTimePack || config.pack || "";
      const target = configured
        ? await this.resolveConfiguredTarget(client, configured, sticker.kind)
        : await this.findAutomaticTarget(client, me, sticker.kind);

      if (target.create) {
        await this.createPack(client, me, target.packName, sticker);
      } else {
        await this.addSticker(client, target.packName, sticker);
      }

      await msg.edit({
        text: `✅ <b>贴纸保存成功</b>\n\n` +
          `类型：${kindLabel(sticker.kind)}\n` +
          `贴纸包：<a href="https://t.me/addstickers/${htmlEscape(target.packName)}">${htmlEscape(target.packName)}</a>`,
        parseMode: "html",
        linkPreview: false,
      });
    } catch (error: any) {
      console.error("[stsave] 保存失败:", error);
      await msg.edit({
        text: `❌ <b>保存失败：</b>${htmlEscape(friendlyError(error))}\n\n` +
          `发送 <code>${mainPrefix}stsave help</code> 查看用法。`,
        parseMode: "html",
      });
    }
  }

  private async showStatus(msg: Api.Message, config: StickerSaverConfig): Promise<void> {
    const value = config.pack
      ? `<a href="https://t.me/addstickers/${htmlEscape(config.pack)}">${htmlEscape(config.pack)}</a>`
      : "自动选择/创建";
    await msg.edit({
      text: `⭐ <b>stsave 设置</b>\n\n` +
        `唯一混合贴纸包：${value}\n` +
        `保存类型：静态 WebP / 动态 TGS / 视频 WebM\n` +
        `默认表情：${htmlEscape(config.defaultEmoji)}\n\n` +
        `回复贴纸、图片、GIF 或视频发送 <code>${mainPrefix}st</code> 即可保存。`,
      parseMode: "html",
      linkPreview: false,
    });
  }

  private async convertAndUploadMedia(
    client: TelegramClient,
    message: Api.Message,
    mode: "image" | "video",
    emoji: string,
  ): Promise<StickerInfo> {
    const input = await downloadMessageBuffer(client, message);
    const converted = mode === "image"
      ? await convertImageToWebp(input)
      : await convertVideoToWebm(input);
    const kind: StickerKind = mode === "image" ? "static" : "video";
    const extension = mode === "image" ? "webp" : "webm";
    const tempPath = path.join(
      os.tmpdir(),
      `stsave_upload_${Date.now()}_${Math.random().toString(36).slice(2)}.${extension}`,
    );

    try {
      fs.writeFileSync(tempPath, converted);
      const attributes: Api.TypeDocumentAttribute[] = [
        new Api.DocumentAttributeSticker({
          alt: emoji,
          stickerset: new Api.InputStickerSetEmpty(),
        }),
        new Api.DocumentAttributeFilename({ fileName: `sticker.${extension}` }),
      ];
      if (mode === "image") {
        attributes.splice(1, 0, new Api.DocumentAttributeImageSize({ w: 512, h: 512 }));
      }

      const uploaded = await client.sendFile("me", {
        file: tempPath,
        forceDocument: false,
        attributes,
      });
      if (!uploaded || !(uploaded.media instanceof Api.MessageMediaDocument)) {
        throw new Error("上传转换后的贴纸失败");
      }
      const document = uploaded.media.document;
      if (!(document instanceof Api.Document)) throw new Error("无法获取转换后的贴纸文档");
      try { await uploaded.delete({ revoke: true }); } catch {}
      return {
        kind,
        emoji,
        source: document,
        document: new Api.InputDocument({
          id: document.id,
          accessHash: document.accessHash,
          fileReference: document.fileReference || Buffer.alloc(0),
        }),
      };
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  private async getSet(client: TelegramClient, packName: string): Promise<Api.messages.StickerSet | undefined> {
    try {
      const result = await client.invoke(new Api.messages.GetStickerSet({
        stickerset: new Api.InputStickerSetShortName({ shortName: packName }),
        hash: 0,
      }));
      return result instanceof Api.messages.StickerSet ? result : undefined;
    } catch (error: any) {
      if (errorCode(error).includes("STICKERSET_INVALID")) return undefined;
      throw error;
    }
  }

  private async validateConfiguredPack(
    client: TelegramClient,
    packName: string,
  ): Promise<void> {
    const set = await this.getSet(client, packName);
    if (!set) return; // Allows creating this short name on first save.
    if (!set.set.creator) throw new Error("该贴纸包不是当前账号创建的，无法向其中添加贴纸");
  }

  private async resolveConfiguredTarget(
    client: TelegramClient,
    packName: string,
    kind: StickerKind,
  ): Promise<{ packName: string; create: boolean }> {
    const set = await this.getSet(client, packName);
    if (!set) return { packName, create: true };
    if (!set.set.creator) throw new Error("目标贴纸包不是当前账号创建的");
    if (set.set.count >= 120) throw new Error("目标贴纸包已满，请设置或使用其他贴纸包");
    if (!stickerSetAcceptsKind(set, kind)) {
      console.warn(`[stsave] 目标包 ${packName} 当前没有 ${kind}，将尝试混合格式添加`);
    }
    return { packName, create: false };
  }

  private automaticBase(me: Api.User): string {
    const identity = (me.username || `user_${me.id.toString()}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^[^a-z]+/, "u_");
    return `${identity}_stsave`.slice(0, 58);
  }

  private async findAutomaticTarget(
    client: TelegramClient,
    me: Api.User,
    kind: StickerKind,
  ): Promise<{ packName: string; create: boolean }> {
    const base = this.automaticBase(me);
    for (let index = 1; index <= 99; index++) {
      const packName = `${base}_${index}`.slice(0, 64);
      const set = await this.getSet(client, packName);
      if (!set) return { packName, create: true };
      if (!set.set.creator) continue;
      if (set.set.count >= 120) continue;
      return { packName, create: false };
    }
    throw new Error("自动寻找可用贴纸包失败，请手动设置贴纸包短名称");
  }

  private async createPack(
    client: TelegramClient,
    me: Api.User,
    packName: string,
    sticker: StickerInfo,
  ): Promise<void> {
    const owner = me.username ? `@${me.username}` : "我的";
    await client.invoke(new Api.stickers.CreateStickerSet({
      userId: "me",
      title: `${owner} 收藏 · stsave 混合贴纸包`,
      shortName: packName,
      stickers: [new Api.InputStickerSetItem({
        document: sticker.document,
        emoji: sticker.emoji,
      })],
      software: "TeleBox stsave",
    }));
  }

  private async addSticker(
    client: TelegramClient,
    packName: string,
    sticker: StickerInfo,
  ): Promise<void> {
    await client.invoke(new Api.stickers.AddStickerToSet({
      stickerset: new Api.InputStickerSetShortName({ shortName: packName }),
      sticker: new Api.InputStickerSetItem({
        document: sticker.document,
        emoji: sticker.emoji,
      }),
    }));
  }
}

export default new StsavePlugin();

