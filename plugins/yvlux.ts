// YVLU Plugin - 生成文字语录贴纸 (TGS + MP4 + 自定义文字 + API配置 完整增强版)
//@ts-nocheck
// 导入网络请求、实用工具库
import axios from "axios";
import _ from "lodash";
// 导入 TeleBox 插件系统的相关依赖
import { getPrefixes, dealCommandPluginWithMessage, getCommandFromMessage } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto"; // 统一使用 teleproto 以匹配新版架构
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import { getGlobalClient } from "@utils/runtimeManager";
import { reviveEntities } from "@utils/tlRevive";
import { sleep } from "teleproto/Helpers";
import dayjs from "dayjs";
// 【BUG 修复】：彻底移除了 CustomFile 的导入，避免原型链冲突引发 [object Object] 类型异常
import * as zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";

// 将 execFile 转换为 Promise 版本以便于在 async/await 中使用
const execFileAsync = promisify(execFile);

// 定义全局的超时时间，防止 API 请求卡死
const timeout = 60000; 
// Python 路径配置，可根据宿主环境的虚拟环境进行修改
const PYTHON_PATH = "python3"; 

// ===================== 辅助函数区域 =====================

/**
 * 知识点：计算字符串的哈希值
 * 用于在无法获取用户确切 ID 时，根据用户名生成一个相对唯一且固定的数字标识
 */
const hashCode = (s: any) => {
  const l = s.length;
  let h = 0;
  let i = 0;
  if (l > 0) {
    while (i < l) {
      h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
    }
  }
  return h;
};

/**
 * 知识点：判断 Buffer 数据是否为 WebM 视频格式
 * 通过读取文件头部的 4 个字节 (魔数 Magic Number) 进行匹配
 * WebM EBML Header: 0x1A 0x45 0xDF 0xA3
 */
function isWebmFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  return (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}

/**
 * 知识点：判断 Buffer 数据是否为 TGS 贴纸格式
 * TGS 本质上是经过 gzip 压缩的 Lottie JSON 动画文件
 * gzip 的魔数是: 0x1F 0x8B
 */
function isTgsFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 2) return false;
  return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * 知识点：检查系统是否具备 TGS 转码为 WebM 的依赖环境
 * 1. 检查 Python 的 rlottie_python 库是否安装
 * 2. 检查 ffmpeg 是否可用
 */
async function checkTgsDependencies(): Promise<{ ok: boolean; message: string }> {
  try {
    await execFileAsync(PYTHON_PATH, ["-c", "from rlottie_python import LottieAnimation"]);
  } catch (e) {
    return {
      ok: false,
      message: "缺少 rlottie-python 依赖，请运行: pip3 install rlottie-python Pillow --break-system-packages",
    };
  }
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch (e) {
    return {
      ok: false,
      message: "缺少 ffmpeg，请安装: apt-get install -y ffmpeg",
    };
  }
  return { ok: true, message: "" };
}

/**
 * 知识点：将 TGS 动画转换为 WebM 视频格式
 * 过程：TGS ->(rlottie)-> GIF ->(ffmpeg)-> WebM (VP9 + Yuva420p 支持透明通道)
 */
async function convertTgsToWebm(tgsBuffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  // 生成唯一标识防止文件冲突
  const uniqueId = Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const tgsPath = path.join(tmpDir, `sticker_${uniqueId}.tgs`);
  const gifPath = path.join(tmpDir, `sticker_${uniqueId}.gif`);
  const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

  try {
    fs.writeFileSync(tgsPath, tgsBuffer);

    // 构建并执行 Python 脚本，将 TGS 转为 GIF
    const pythonScript = `
import sys
from rlottie_python import LottieAnimation
anim = LottieAnimation.from_tgs(sys.argv[1])
anim.save_animation(sys.argv[2])
`;
    await execFileAsync(PYTHON_PATH, ["-c", pythonScript, tgsPath, gifPath]);

    // 使用 ffmpeg 将 GIF 转为透明通道的 WebM
    await execFileAsync("ffmpeg", [
      "-i", gifPath, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
      "-b:v", "400k", "-auto-alt-ref", "0", "-an", "-y", webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    // 无论成功还是失败，最终都要清理临时文件，防止存储空间泄漏
    try { fs.unlinkSync(tgsPath); } catch (e) {}
    try { fs.unlinkSync(gifPath); } catch (e) {}
    try { fs.unlinkSync(webmPath); } catch (e) {}
  }
}

/**
 * 知识点：检测是否为动态 WebP
 * 通过解析 RIFF 头部并向下搜索 'ANIM' 块来确定 WebP 中是否包含动画帧
 */
function isAnimatedWebP(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;

  // 检查 RIFF + WEBP 头
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return false;
  }

  // 搜索 ANIM 块
  for (let i = 12; i < buffer.length - 4; i++) {
    if (buffer.toString("ascii", i, i + 4) === "ANIM") {
      return true;
    }
  }
  return false;
}

/**
 * 知识点：检测是否为 MP4 格式视频
 * 读取偏移量 4-8 字节，匹配 'ftyp' 魔数
 */
function isMp4Format(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  const ftyp = buffer.toString("ascii", 4, 8);
  return ftyp === "ftyp";
}

/**
 * 知识点：将 MP4/GIF 视频转换为 WebM 格式
 * 使用 ffmpeg，开启 VP9 编码器和透明通道像素格式 (yuva420p)
 */
async function convertMp4ToWebm(mp4Buffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  const uniqueId = Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const mp4Path = path.join(tmpDir, `video_${uniqueId}.mp4`);
  const webmPath = path.join(tmpDir, `video_${uniqueId}.webm`);

  try {
    fs.writeFileSync(mp4Path, mp4Buffer);

    await execFileAsync("ffmpeg", [
      "-i", mp4Path, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
      "-b:v", "400k", "-auto-alt-ref", "0", "-an", "-y", webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    try { fs.unlinkSync(mp4Path); } catch (e) {}
    try { fs.unlinkSync(webmPath); } catch (e) {}
  }
}

/**
 * 知识点：手动解析 WebP 文件的二进制头信息来获取图片宽和高
 * 支持 VP8(有损), VP8L(无损), VP8X(扩展) 三种编码格式的头部解析
 */
function getWebPDimensions(imageBuffer: any): { width: number; height: number } {
  try {
    // 如果是 WebM 格式，直接返回 Telegram 规定的贴纸标准默认尺寸
    if (isWebmFormat(imageBuffer)) {
      return { width: 512, height: 512 };
    }

    if (imageBuffer.length < 30) throw new Error("Invalid WebP file: too short");
    if (imageBuffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("Invalid WebP file: missing RIFF header");
    if (imageBuffer.toString("ascii", 8, 12) !== "WEBP") throw new Error("Invalid WebP file: missing WEBP signature");

    const chunkHeader = imageBuffer.toString("ascii", 12, 16);

    if (chunkHeader === "VP8 ") {
      // VP8 格式：宽高信息在偏移 26 和 28 处，占 14 bits
      const width = imageBuffer.readUInt16LE(26) & 0x3fff;
      const height = imageBuffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    } else if (chunkHeader === "VP8L") {
      // VP8L 格式：位操作提取宽高
      const data = imageBuffer.readUInt32LE(21);
      const width = (data & 0x3fff) + 1;
      const height = ((data >> 14) & 0x3fff) + 1;
      return { width, height };
    } else if (chunkHeader === "VP8X") {
      // VP8X 格式：24位整数提取
      const width = (imageBuffer.readUInt32LE(24) & 0xffffff) + 1;
      const height = (imageBuffer.readUInt32LE(27) & 0xffffff) + 1;
      return { width, height };
    }

    console.warn("Unknown WebP format, using default dimensions");
    return { width: 512, height: 768 };
  } catch (error) {
    console.warn("Failed to parse WebP dimensions:", error);
    return { width: 512, height: 768 };
  }
}

/**
 * 知识点：从不同的 Peer 类型中提取纯数字 ID
 */
const getPeerNumericId = (peer?: Api.TypePeer): number | undefined => {
  if (!peer) return undefined;
  if (peer instanceof Api.PeerUser) return peer.userId;
  if (peer instanceof Api.PeerChat) return -peer.chatId; // ChatID 转换为负数
  if (peer instanceof Api.PeerChannel) return -peer.channelId; // ChannelID 转换为负数
  return undefined;
};

/**
 * 知识点：解析消息转发头部 (Forward Header) 的发送者信息
 * 针对隐私保护设置导致无法直接获取发信人的情况提供回退降级方案
 */
const resolveForwardSenderFromHeader = async (forwardHeader: Api.MessageFwdHeader, client: any) => {
  if (!forwardHeader) return undefined;

  const displayName = forwardHeader.fromName || forwardHeader.savedFromName || forwardHeader.postAuthor || "";
  const fallbackName = displayName || "未知来源";

  const peerCandidates = [
    forwardHeader.fromId,
    forwardHeader.savedFromPeer,
    forwardHeader.savedFromId,
  ].filter(Boolean);

  for (const peer of peerCandidates) {
    try {
      const entity = await client?.getEntity(peer as any);
      if (entity) {
        return entity;
      }
    } catch (error) {
      const errMsg = (error?.errorMessage || error?.message || "").toString();
      // 忽略因频道私有化报出的权限错误
      if (!errMsg.includes("CHANNEL_PRIVATE")) {
        console.warn("解析转发发送者失败", error);
      }
    }
  }

  // 降级：构造一个虚拟的用户实体
  return {
    id: getPeerNumericId(forwardHeader.fromId || forwardHeader.savedFromId || forwardHeader.savedFromPeer) || hashCode(fallbackName),
    firstName: fallbackName,
    lastName: "",
    username: forwardHeader.postAuthor || undefined,
    title: fallbackName,
    name: fallbackName,
  };
};

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
// 使用 yvlux 避免与官方 yvlu 插件的命令重名；保留配置目录 assets/yvlu，迁移时不会丢失现有设置。
const pluginName = "yvlux";
const commandName = `${mainPrefix}${pluginName}`;

// 包含自定义修改后的 Help 文档字符串
const help_text = `
<b>🎨 YVLU 语录生成器 (增强版)</b>

<b>1. 生成语录</b>
• <code>${commandName} [数量]</code> - 回复消息，生成最近 N 条
• <code>${commandName} r [数量]</code> - 包含被引用(Reply)的消息进行生成
• <code>${commandName} &lt;自定义文字&gt;</code> - <b>修改回复消息的内容</b>为自定义文字进行生成

<b>2. 贴纸包管理</b>
• <code>${commandName} s</code> - 回复图片/贴纸，将其直接保存到你的专属贴纸包
• <code>${commandName} config sticker &lt;名称&gt;</code> - 设置/修改贴纸包 ShortName

<b>3. API 设置</b>
• <code>${commandName} api [URL]</code> - 设置自定义后端 Quote API
• <code>${commandName} api reset</code> - 重置为默认后端 API
`;

/**
 * 知识点：Telegram 消息实体 (Entity) 映射转换器
 * 将 MTProto 协议里的内联样式、URL、提及、隐藏文字等转换为 quote-api 可识别的 JSON 结构
 */
function getChatMemberRank(message: Api.Message, sender: any): Promise<string> {
  if (!sender || !message.client) return Promise.resolve("");
  return (async () => {
    try {
      const chat = await message.getInputChat();
      const participantResult = await (message.client as any).getParticipant(chat, sender);
      const rank = participantResult?.participant?.rank ?? participantResult?.rank;
      return typeof rank === "string" ? rank.trim() : "";
    } catch {
      // 私聊或无法读取成员信息时没有群内标签。
      return "";
    }
  })();
}

function convertEntities(entities: Api.TypeMessageEntity[]): any[] {
  if (!entities) return [];

  return entities.map((entity) => {
    const baseEntity = {
      offset: entity.offset,
      length: entity.length,
    };

    if (entity instanceof Api.MessageEntityBold) {
      return { ...baseEntity, type: "bold" };
    } else if (entity instanceof Api.MessageEntityItalic) {
      return { ...baseEntity, type: "italic" };
    } else if (entity instanceof Api.MessageEntityUnderline) {
      return { ...baseEntity, type: "underline" };
    } else if (entity instanceof Api.MessageEntityStrike) {
      return { ...baseEntity, type: "strikethrough" };
    } else if (entity instanceof Api.MessageEntityCode) {
      return { ...baseEntity, type: "code" };
    } else if (entity instanceof Api.MessageEntityPre) {
      return { ...baseEntity, type: "pre" };
    } else if (entity instanceof Api.MessageEntityCustomEmoji) {
      const documentId = (entity as any).documentId;
      const custom_emoji_id = documentId?.value?.toString() || documentId?.toString() || "";
      return { ...baseEntity, type: "custom_emoji", custom_emoji_id };
    } else if (entity instanceof Api.MessageEntityUrl) {
      return { ...baseEntity, type: "url" };
    } else if (entity instanceof Api.MessageEntityTextUrl) {
      return { ...baseEntity, type: "text_link", url: (entity as any).url || "" };
    } else if (entity instanceof Api.MessageEntityMention) {
      return { ...baseEntity, type: "mention" };
    } else if (entity instanceof Api.MessageEntityMentionName) {
      return { ...baseEntity, type: "text_mention", user: { id: (entity as any).userId } };
    } else if (entity instanceof Api.MessageEntityHashtag) {
      return { ...baseEntity, type: "hashtag" };
    } else if (entity instanceof Api.MessageEntityCashtag) {
      return { ...baseEntity, type: "cashtag" };
    } else if (entity instanceof Api.MessageEntityBotCommand) {
      return { ...baseEntity, type: "bot_command" };
    } else if (entity instanceof Api.MessageEntityEmail) {
      return { ...baseEntity, type: "email" };
    } else if (entity instanceof Api.MessageEntityPhone) {
      return { ...baseEntity, type: "phone_number" };
    } else if (entity instanceof Api.MessageEntitySpoiler) {
      return { ...baseEntity, type: "spoiler" };
    }

    return baseEntity;
  });
}

// ===================== 类定义区域 =====================

/**
 * 知识点：定义配置文件的接口格式，规范化管理持久化状态
 */
interface YvluConfig {
  stickerSetShortName: string;
  apiUrl: string;
  _comment?: string;
}

// 通过 Base64 解码隐蔽地存储默认 API 路径，增加一定安全性
const DEFAULT_API_URL = JSON.parse(
  Buffer.from(
    "eyJ1cmwiOiJodHRwczovL3F1b3RlLWFwaS1lbmhhbmNlZC56aGV0ZW5nc2hhLmV1Lm9yZy9nZW5lcmF0ZS53ZWJwIn0=",
    "base64"
  ).toString("utf-8")
).url;


class YvluPlugin extends Plugin {
  // 设置插件帮助描述（会被核心管理器抓取显示）
  description: string = `\n生成文字语录贴纸\n\n${help_text}`;
  private config: YvluConfig | null = null;
  private configPath: string = "";

  /**
   * 知识点：生命周期函数 onLoad
   * 在插件挂载时初始化存储目录和默认的 config.json 文件
   */
  async onLoad() {
    const configDir = createDirectoryInAssets("yvlu");
    this.configPath = path.join(configDir, "config.json");

    console.log(`yvlu 配置文件路径: ${this.configPath}`);

    if (!fs.existsSync(this.configPath)) {
      const defaultConfig: YvluConfig = {
        stickerSetShortName: "",
        apiUrl: "",
        _comment: "shortName 只能包含字母、数字和下划线; apiUrl为空时使用默认",
      };
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
      console.log(`已创建默认配置文件: ${this.configPath}`);
    }

    await this.loadConfig();
  }

  /**
   * 知识点：加载本地配置文件
   * 提供异常捕获，防止因为 JSON 格式错误导致整个插件卡死
   */
  async loadConfig() {
    try {
      if (!this.configPath || this.configPath === "") {
        const configDir = createDirectoryInAssets("yvlu");
        this.configPath = path.join(configDir, "config.json");
      }

      if (!fs.existsSync(this.configPath)) {
        this.config = { stickerSetShortName: "", apiUrl: "" };
        return;
      }

      const configData = fs.readFileSync(this.configPath, "utf-8");
      this.config = JSON.parse(configData);
    } catch (error) {
      console.error("加载 yvlu 配置失败:", error);
      this.config = { stickerSetShortName: "", apiUrl: "" };
    }
  }

  /**
   * 知识点：持久化保存最新配置至硬盘
   */
  async saveConfig() {
    if (this.config && this.configPath) {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    }
  }

  /**
   * 知识点：调用后端 quote-api 核心函数
   * 发送组装好的 JSON 给远端，要求返回 arraybuffer 流 (贴纸图片或动图)
   */
  async generateQuote(quoteData: any): Promise<{ buffer: Buffer; ext: string }> {
    try {
      let url = this.config?.apiUrl;
      // 检查当前配置中是否有自定义地址，没有则使用默认
      if (!url || !url.trim()) url = DEFAULT_API_URL;

      const response = await axios({
        method: "post",
        timeout,
        url: url,
        data: quoteData,
        responseType: "arraybuffer",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "TeleBox/0.2.1",
        },
      });

      console.log("quote-api响应状态:", response.status);
      // 返回的永远视为 webp，如果是动图，内部实际会是 webm
      return { buffer: response.data, ext: "webp" };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error(`quote-api请求失败:`, {
          status: error.response?.status,
          statusText: error.response?.statusText,
        });
      } else {
        console.error(`调用quote-api失败: ${error}`);
      }
      throw error;
    }
  }

  // 核心指令注册器
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    yvlux: async (msg: Api.Message, trigger?: Api.Message) => {
      const start = Date.now();
      const args = msg.message.split(/\s+/);
      const subCmd = args[1]?.toLowerCase();

      let count = 1;
      let r = false;
      let valid = false;
      let customText: string | undefined;

      // ================= 路由控制 =================
      // 1. 配置管理路由
      if (subCmd === "config") {
        await this.handleConfigCommand(msg, args.slice(2));
        return;
      }

      // 2. API 管理路由 (自定义功能合并)
      if (subCmd === "api") {
        await this.handleApiCommand(msg, args.slice(2));
        return;
      }

      // 3. 保存贴纸/图片路由
      if (subCmd === "s") {
        await this.handleSaveStickerToSet(msg);
        return;
      }

      // ================= 语录生成解析 =================
      if (!args[1] || /^\d+$/.test(args[1])) {
        // 命令：yvlu 或 yvlu 3
        count = parseInt(args[1]) || 1;
        valid = true;
      } else if (subCmd === "r") {
        // 命令：yvlu r 3
        r = true;
        count = parseInt(args[2]) || 1;
        valid = true;
      } else {
        // 匹配自定义文字 (自定义功能合并：正则剔除了前缀命令，保留剩余所有的字符串片段)
        customText = msg.message.replace(/^\S+\s+/, "");
        valid = true;
      }

      if (valid) {
        let replied = await msg.getReplyMessage();
        if (!replied) {
          await msg.edit({ text: "请回复一条消息" });
          return;
        }
        if (count > 5) {
          await msg.edit({ text: "太多了 哒咩，最多 5 条！" });
          return;
        }

        await msg.edit({ text: "正在生成语录贴纸..." });

        try {
          const client = await getGlobalClient();

          // 逆序抓取目标上下文消息
          const messages = await msg.client?.getMessages(replied?.peerId, {
            offsetId: replied!.id - 1,
            limit: count,
            reverse: true,
          });

          if (!messages || messages.length === 0) {
            await msg.edit({ text: "未找到消息" });
            return;
          }

          const items = [] as any[];
          let previousUserIdentifier: string | null = null;

          for await (const [i, message] of messages.entries()) {
            // 获取发送者信息
            let sender: any = await message.getSender();

            // 如果无法直接获取发送者（可能是以频道身份发言），尝试从 peerId 找回
            if (!sender) {
              try {
                const peerId = (message as any).peerId || (message as any).fromId;
                if (peerId) sender = await client.getEntity(peerId);
              } catch (e) {
                console.warn("从 peerId 获取发送者失败", e);
              }
            }

            // 检查转发状态，若存在，覆盖发件人信息为原始发件人
            if (message.fwdFrom) {
              let forwardedSender = message.forward?.sender || message.forward?.chat;
              if (!forwardedSender) {
                try { forwardedSender = await message.forward?.getSender(); } catch (error) {}
              }
              if (!forwardedSender) {
                forwardedSender = await resolveForwardSenderFromHeader(message.fwdFrom, client);
              }
              if (!forwardedSender) {
                const fallbackName = "未知来源";
                forwardedSender = {
                  id: hashCode(fallbackName),
                  firstName: fallbackName,
                  lastName: "",
                  title: fallbackName,
                  name: fallbackName,
                };
              }
              sender = forwardedSender;
            }

            if (!sender) {
              await msg.edit({ text: "无法获取消息发送者信息" });
              return;
            }

            // 组装用户元数据
            const userId = (sender as any).id?.toString();
            const name = (sender as any).name || "";
            const firstName = (sender as any).firstName || (sender as any).title || "";
            const lastName = (sender as any).lastName || "";
            const username = (sender as any).username || "";
            const chatMemberRank = await getChatMemberRank(message, sender);
            const displayName = chatMemberRank
              ? `${name || `${firstName} ${lastName}`.trim()} [${chatMemberRank}]`
              : name;
            const emojiStatus = (sender as any).emojiStatus?.documentId?.toString() || null;

            // 根据前序用户标识决定是否连通气泡（不在气泡旁绘制头像）
            const currentUserIdentifier = userId || hashCode(name || `${firstName}|${lastName}` || `user_${i}`).toString();
            const shouldShowAvatar = currentUserIdentifier !== previousUserIdentifier;
            previousUserIdentifier = currentUserIdentifier;

            // 下载用户头像 (仅需渲染的时候才进行网络请求)
            let photo: { url: string } | undefined = undefined;
            if (shouldShowAvatar) {
              try {
                const buffer = await client.downloadProfilePhoto(sender as any, { isBig: false });
                if (Buffer.isBuffer(buffer) && buffer.length > 0) {
                  const base64 = buffer.toString("base64");
                  photo = { url: `data:image/jpeg;base64,${base64}` };
                }
              } catch (e) {
                console.warn("下载用户头像失败", e);
              }
            }

            // ================= 自定义文字覆盖逻辑 (合并项) =================
            // i === 0 意味着这是你刚刚 Reply 对准的那条消息
            if (i === 0) {
              let replyTo = (trigger || msg)?.replyTo;
              if (customText) {
                // 如果传入了自定义文字，强行替换文案并清空原本的排版样式（Entities）
                message.message = customText;
                message.entities = [];
              } else if (replyTo?.quoteText) {
                // 如果使用了 Telegram 原生部分文字引用功能，覆盖为引用文本
                message.message = replyTo.quoteText;
                message.entities = replyTo.quoteEntities;
              }
            }

            const entities = convertEntities(message.entities || []);

            // ================= 回复块(Reply Header)构造逻辑 =================
            let replyBlock: any | undefined;
            if (r) {
              try {
                const replyHeader: any = (message as any).replyTo;
                // 1) 优先尝试提取 quote（局部引用回复）
                if (replyHeader?.quote && replyHeader.quoteText) {
                  let replyName = "unknown";
                  let replyChatId: number | undefined = undefined;
                  try {
                    const repliedMsg = await message.getReplyMessage();
                    if (repliedMsg) {
                      const repliedSender = await repliedMsg.getSender();
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst = (repliedSender as any).firstName || (repliedSender as any).title || "";
                        const rLast = (repliedSender as any).lastName || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || (repliedSender as any).username || "unknown";
                      }
                    }
                  } catch {}

                  const revived = reviveEntities(replyHeader.quoteEntities);
                  const replyEntities = convertEntities(revived || []);

                  replyBlock = {
                    name: replyName,
                    text: replyHeader.quoteText,
                    entities: replyEntities,
                    ...(replyChatId ? { chatId: replyChatId } : {}),
                  };
                } 
                // 2) 如果是标准的全局回复
                else if ((message as any).isReply || replyHeader?.replyToMsgId) {
                  try {
                    const repliedMsg = await message.getReplyMessage();
                    if (repliedMsg) {
                      const repliedSender = await repliedMsg.getSender();
                      let replyName = "unknown";
                      let replyChatId: number | undefined;
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst = (repliedSender as any).firstName || (repliedSender as any).title || "";
                        const rLast = (repliedSender as any).lastName || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || (repliedSender as any).username || "unknown";
                      }

                      const replyText = repliedMsg.message || "";
                      const replyEntities = convertEntities(repliedMsg.entities || []);

                      if (replyText) {
                        replyBlock = {
                          name: replyName,
                          text: replyText,
                          entities: replyEntities,
                          ...(replyChatId ? { chatId: replyChatId } : {}),
                        };
                      }
                    }
                  } catch {}
                }
              } catch (e) {
                console.warn("处理回复引用失败: ", e);
              }
            }

            // ================= 媒体(多媒体文件)下载与格式转换逻辑 =================
            let media: { url: string } | undefined = undefined;
            try {
              if (message.media) {
                let mediaTypeForQuote: string | undefined = undefined;
                // 检测它是否为 Sticker(贴纸属性)
                const isSticker =
                  message.media instanceof Api.MessageMediaDocument &&
                  (message.media as Api.MessageMediaDocument).document &&
                  ((message.media as Api.MessageMediaDocument).document as any).attributes?.some(
                    (a: any) => a instanceof Api.DocumentAttributeSticker
                  );

                if (isSticker) {
                  mediaTypeForQuote = "sticker";
                } else {
                  mediaTypeForQuote = "photo";
                }

                const mimeType = (message.media as any).document?.mimeType;
                const isTgsSticker = isSticker && mimeType === "application/x-tgsticker";
                const isGifOrMp4 = mimeType === "video/mp4" || mimeType === "image/gif";
                // 如果是动态内容，我们不能只下载缩略图(thumb)
                const isAnimatedContent = (isSticker && (mimeType === "video/webm" || mimeType === "image/webp" || isTgsSticker)) || isGifOrMp4;

                const buffer = await (message as any).downloadMedia({
                  ...(isAnimatedContent ? {} : { thumb: 1 }),
                });

                if (Buffer.isBuffer(buffer)) {
                  let finalBuffer = buffer;
                  let finalMime = mimeType;

                  // TGS 转 WebM 逻辑注入
                  if (isTgsSticker || isTgsFormat(buffer)) {
                    try {
                      const depCheck = await checkTgsDependencies();
                      if (!depCheck.ok) {
                        console.error(`[yvlu] ${depCheck.message}`);
                      } else {
                        console.log(`[yvlu] 检测到 TGS 贴纸，开始转换为 WebM...`);
                        finalBuffer = await convertTgsToWebm(buffer);
                        finalMime = "video/webm";
                        console.log(`[yvlu] TGS -> WebM 转换成功，大小: ${finalBuffer.length}`);
                      }
                    } catch (convertError) {
                      console.error(`[yvlu] TGS 转换失败:`, convertError);
                    }
                  } 
                  // MP4/GIF 转 WebM 逻辑注入
                  else if (isGifOrMp4 || isMp4Format(buffer)) {
                    try {
                      console.log(`[yvlu] 检测到 GIF/MP4，开始转换为 WebM...`);
                      finalBuffer = await convertMp4ToWebm(buffer);
                      finalMime = "video/webm";
                      console.log(`[yvlu] MP4 -> WebM 转换成功，大小: ${finalBuffer.length}`);
                    } catch (convertError) {
                      console.error(`[yvlu] MP4 转换失败:`, convertError);
                    }
                  }

                  const mime = finalMime || (mediaTypeForQuote === "sticker" ? "image/webp" : "image/jpeg");
                  const base64 = finalBuffer.toString("base64");
                  media = { url: `data:${mime};base64,${base64}` };
                }
              }
            } catch (e) {
              console.error("下载媒体失败", e);
            }

            items.push({
              from: {
                id: userId ? parseInt(userId) : hashCode(sender.name || `${firstName}|${lastName}`),
                name: shouldShowAvatar ? displayName : "",
                first_name: shouldShowAvatar ? firstName || undefined : undefined,
                last_name: shouldShowAvatar ? lastName || undefined : undefined,
                username: photo && shouldShowAvatar ? username || undefined : undefined,
                photo,
                emoji_status: shouldShowAvatar ? emojiStatus || undefined : undefined,
              },
              text: message.message || "",
              entities: entities,
              avatar: shouldShowAvatar,
              media,
              ...(replyBlock ? { replyMessage: replyBlock } : {}),
            });
          }

          // 核心网络请求数据装配
          const quoteData = {
            type: "quote",
            format: "webp", // 强行指定后端生成 webp（包含 webm 帧容器）
            backgroundColor: "#1b1429",
            width: 512,
            height: 768,
            scale: 2,
            emojiBrand: "apple", // Emoji 样式设为苹果风
            messages: items,
          };

          const quoteResult = await this.generateQuote(quoteData);
          const imageBuffer = quoteResult.buffer;
          const imageExt = quoteResult.ext; 

          if (!imageBuffer || imageBuffer.length === 0) {
            await msg.edit({ text: "生成的图片数据为空" });
            return;
          }

          console.log(`[yvlu] API返回: buffer长度=${imageBuffer?.length}, ext=${imageExt}`);

          try {
            // 解析生成好的 WebP 文件，计算其尺寸以及确认它是否为动态图片(webm/webp animated)
            const dimensions = getWebPDimensions(imageBuffer);
            const isWebm = isWebmFormat(imageBuffer);
            const isAnimated = isAnimatedWebP(imageBuffer);

            console.log(`检测到的图片尺寸: ${dimensions.width}x${dimensions.height}, 格式: ${isWebm ? "webm" : "webp"}, 动态: ${isWebm || isAnimated}`);

            // 【BUG 修复】：摒弃 CustomFile，无论动态静态，统一使用操作系统临时文件路径传递，底层 fs 流能完美解析
            const os = await import("os");
            const tmpDir = os.tmpdir();
            const uniqueId = Date.now().toString();

            if (isWebm) {
              const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

              try {
                fs.writeFileSync(webmPath, imageBuffer);
                // 必须走文件路径上传，Telegram Client 针对 WebM 贴纸有特殊的二进制封装要求
                await client.sendFile(msg.peerId, {
                  file: webmPath,
                  attributes: [
                    new Api.DocumentAttributeSticker({
                      alt: "📝",
                      stickerset: new Api.InputStickerSetEmpty(),
                    }),
                  ],
                  replyTo: replied?.id,
                });
                console.log("[yvlu] 动态贴纸发送成功 (webm)");
              } finally {
                try { fs.unlinkSync(webmPath); } catch (e) {}
              }
            } else {
              const staticPath = path.join(tmpDir, `sticker_${uniqueId}.${imageExt}`);
              
              try {
                fs.writeFileSync(staticPath, imageBuffer);

                const stickerAttr = new Api.DocumentAttributeSticker({
                  alt: "📝",
                  stickerset: new Api.InputStickerSetEmpty(),
                });
                const imageSizeAttr = new Api.DocumentAttributeImageSize({
                  w: dimensions.width,
                  h: dimensions.height,
                });
                const filenameAttr = new Api.DocumentAttributeFilename({
                  fileName: `sticker.${imageExt}`,
                });

                await client.sendFile(msg.peerId, {
                  file: staticPath, // 直接传入 String 文件路径
                  forceDocument: false, 
                  attributes: [stickerAttr, imageSizeAttr, filenameAttr],
                  replyTo: replied?.id,
                });

                console.log("[yvlu] 静态贴纸发送成功");
              } finally {
                try { fs.unlinkSync(staticPath); } catch (e) {}
              }
            }
          } catch (fileError) {
            console.error(`发送文件失败: ${fileError}`);
            await msg.edit({ text: `发送文件失败: ${fileError}` });
            return;
          }

          // 生成和发送完成：显式 revoke，确保命令对所有聊天成员撤回。
          await msg.delete({ revoke: true });

          const end = Date.now();
          console.log(`语录生成耗时: ${end - start}ms`);
        } catch (error) {
          console.error(`语录生成失败: ${error}`);
          await msg.edit({ text: `语录生成失败: ${error}` });
        }
      } else {
        // 命令无法匹配任何规则时，弹出使用帮助菜单
        await msg.edit({ text: help_text, parseMode: "html" });
      }
    },
  };

  /**
   * 知识点：处理配置贴纸包命令 (config)
   */
  async handleConfigCommand(msg: Api.Message, args: string[]) {
    try {
      await this.loadConfig();

      if (args.length === 0) {
        const configInfo = `
<b>📋 当前配置:</b>

<b>贴纸包名称:</b> <code>${this.config?.stickerSetShortName || "(未设置)"}</code>
${this.config?.stickerSetShortName ? `<b>贴纸包链接:</b> t.me/addstickers/${this.config.stickerSetShortName}` : ""}

<b>API URL:</b> <code>${this.config?.apiUrl || "默认"}</code>

<b>配置文件路径:</b>
<code>${this.configPath}</code>

<b>可用配置命令:</b>
<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称
<code>${commandName} api [URL]</code> - 设置 API
`;
        await msg.edit({ text: configInfo, parseMode: "html" });
        return;
      }

      const subCommand = args[0].toLowerCase();

      switch (subCommand) {
        case "sticker":
        case "stickerset":
        case "set": {
          const newName = args.slice(1).join("_");

          if (!newName) {
            await msg.edit({ text: `❌ 请提供贴纸包名称\n用法: <code>${commandName} config sticker 贴纸包名称</code>`, parseMode: "html" });
            return;
          }

          // Telegram ShortName 规范检测
          if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
            await msg.edit({ text: "❌ 贴纸包名称只能包含字母、数字和下划线", parseMode: "html" });
            return;
          }

          if (newName.length < 1 || newName.length > 64) {
            await msg.edit({ text: "❌ 贴纸包名称长度应在 1-64 个字符之间", parseMode: "html" });
            return;
          }

          this.config!.stickerSetShortName = newName;
          await this.saveConfig(); // 持久化更新
          
          await msg.edit({ text: `✅ 贴纸包名称已设置为: <code>${newName}</code>\n贴纸包链接: t.me/addstickers/${newName}`, parseMode: "html" });
          break;
        }

        default:
          await msg.edit({
            text: `❌ 未知的配置项: <code>${subCommand}</code>\n\n可用配置命令:\n<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称`,
            parseMode: "html",
          });
      }
    } catch (error: any) {
      console.error("处理配置命令失败:", error);
      await msg.edit({ text: `❌ 配置操作失败: ${error.message || error}` });
    }
  }

  /**
   * 知识点：处理修改后台 API 请求地址的指令 (api)
   * 包含了容错机制如补全 https 前缀，规范化后缀路由 (/generate.webp)
   */
  async handleApiCommand(msg: Api.Message, args: string[]) {
    try {
      await this.loadConfig();
      const sub = args[0];

      if (!sub) {
        await msg.edit({ text: `当前 API: <code>${this.config?.apiUrl || "默认"}</code>\n使用 <code>${commandName} api reset</code> 恢复默认。`, parseMode: "html" });
      } else if (sub.toLowerCase() === "reset") {
        this.config!.apiUrl = "";
        await this.saveConfig();
        await msg.edit({ text: "✅ API 已重置为默认值。" });
      } else {
        let url = sub;
        if (!url.startsWith("http")) url = "https://" + url;
        // 如果给出的地址缺少标准后缀，强制为其补全
        if (!url.includes("/generate")) url = url.replace(/\/$/, "") + "/generate.webp";
        
        this.config!.apiUrl = url;
        await this.saveConfig();
        await msg.edit({ text: `✅ API 已更新设为: \n<code>${url}</code>`, parseMode: "html" });
      }
    } catch (error: any) {
      console.error("处理 API 设置失败:", error);
      await msg.edit({ text: `❌ 操作失败: ${error.message || error}` });
    }
  }

  /**
   * 知识点：捕获用户对某张图片/贴纸的回复并将其吸纳进自己预设的贴纸包中
   */
  async handleSaveStickerToSet(msg: Api.Message) {
    try {
      await this.loadConfig();

      if (!this.config || !this.config.stickerSetShortName || this.config.stickerSetShortName.trim() === "") {
        await msg.edit({ text: `❌ 未配置贴纸包!\n请执行指令: <code>${commandName} config sticker &lt;贴纸包简称&gt;</code> 进行设置。`, parseMode: "html" });
        return;
      }

      const replied = await msg.getReplyMessage();
      if (!replied) {
        await msg.edit({ text: "❌ 请回复一张贴纸或图片" });
        return;
      }

      if (!replied.media) {
        await msg.edit({ text: "❌ 回复的消息不包含媒体素材" });
        return;
      }

      const client = await getGlobalClient();

      let isSticker = false;
      let isPhoto = false;
      let documentToAdd: Api.InputDocument | null = null;

      // 解析 Telegram 内部的文件数据结构
      if (replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.attributes) {
          isSticker = doc.attributes.some((a: any) => a instanceof Api.DocumentAttributeSticker);
        }
        if (isSticker && doc.id && doc.accessHash) {
          documentToAdd = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (replied.media instanceof Api.MessageMediaPhoto) {
        isPhoto = true;
      }

      if (!isSticker && !isPhoto) {
        await msg.edit({ text: "❌ 不支持的媒体类型,请回复贴纸或图片" });
        return;
      }

      // 验证云端是否存在该贴纸包
      let stickerSetExists = false;
      try {
        const stickerSet = await client.invoke(
          new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({
              shortName: this.config.stickerSetShortName,
            }),
            hash: 0,
          })
        );
        stickerSetExists = stickerSet instanceof Api.messages.StickerSet;
      } catch (error: any) {
        if (error.errorMessage === "STICKERSET_INVALID") {
          stickerSetExists = false;
        } else {
          throw error;
        }
      }

      // 若未创建过，触发底层的贴纸包创建协议
      if (!stickerSetExists) {
        await this.createStickerSet(client, msg, replied, isSticker, isPhoto);
        return;
      }

      // 对现有的包执行 AddStickerToSet 追加动作
      if (isSticker && documentToAdd) {
        try {
          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document: documentToAdd,
                emoji: "📝", // 默认 Emoji 映射
              }),
            })
          );
          await msg.edit({ text: `✅ 已成功添加到贴纸包!\n传送门: t.me/addstickers/${this.config.stickerSetShortName}` });
        } catch (error: any) {
          console.error("添加贴纸失败:", error);
          await msg.edit({ text: `❌ 添加贴纸失败: ${error.message || error}` });
        }
        return;
      }

      // 如果是对静态相片进行操作，需要先把图片作为文件重新走一次上传通道
      if (isPhoto) {
        try {
          const buffer = await replied.downloadMedia();
          if (!Buffer.isBuffer(buffer)) {
            await msg.edit({ text: "❌ 图片流提取失败" });
            return;
          }

          // 【BUG 修复】：摒弃 CustomFile，直接给 Buffer 添加 name 属性，完美欺骗底层的 isBuffer 检测
          const bufferFile = Buffer.from(buffer) as any;
          bufferFile.name = "sticker.png";

          const file = await client.uploadFile({
            file: bufferFile,
            workers: 1,
          });

          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document: file as any,
                emoji: "📝",
              }),
            })
          );

          await msg.edit({ text: `✅ 图像已成功上链贴纸包!\n传送门: t.me/addstickers/${this.config.stickerSetShortName}` });
        } catch (error: any) {
          console.error("处理图片上链失败:", error);
          await msg.edit({ text: `❌ 图片转换上链失败: ${error.message || error}` });
        }
        return;
      }
    } catch (error: any) {
      console.error("保存贴纸异常:", error);
      await msg.edit({ text: `❌ 操作中止: ${error.message || error}` });
    }
  }

  /**
   * 知识点：创建全新的属于当前机器人的/用户的 Telegram 贴纸包
   */
  async createStickerSet(client: any, msg: Api.Message, replied: Api.Message, isSticker: boolean, isPhoto: boolean) {
    try {
      let firstSticker: any = null;

      if (isSticker && replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.id && doc.accessHash) {
          firstSticker = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (isPhoto) {
        const buffer = await replied.downloadMedia();
        if (!Buffer.isBuffer(buffer)) {
          await msg.edit({ text: "❌ 首帧源文件下载破损" });
          return;
        }

        // 【BUG 修复】：通过 Buffer 与 name 属性的挂载，替换易引发引用碰撞的 CustomFile
        const bufferFile = Buffer.from(buffer) as any;
        bufferFile.name = "sticker.png";

        firstSticker = await client.uploadFile({
          file: bufferFile,
          workers: 1,
        });
      }

      if (!firstSticker) {
        await msg.edit({ text: "❌ 无法装配封面的数据矩阵" });
        return;
      }

      const me = await client.getMe();

      // 发起协议级的创建动作 (CreateStickerSet)
      await client.invoke(
        new Api.stickers.CreateStickerSet({
          userId: me,
          title: `${this.config!.stickerSetShortName}`,
          shortName: this.config!.stickerSetShortName,
          stickers: [
            new Api.InputStickerSetItem({
              document: firstSticker,
              emoji: "📝",
            }),
          ],
        })
      );

      await msg.edit({ text: `✅ 贴纸集合创建竣工，并已录入首图!\n传送门: t.me/addstickers/${this.config!.stickerSetShortName}` });
    } catch (error: any) {
      console.error("生成贴纸包骨架失败:", error);
      await msg.edit({ text: `❌ 核心结构创立失败: ${error.message || error}` });
    }
  }
}

// 导出单例类的实例，供插件注册机抓取
export default new YvluPlugin();