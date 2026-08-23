import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";

const mainPrefix = getPrefixes()[0] || ".";
const MAX_OUTPUT = 3800;

type Target = {
  peer: any;
  messageId: number;
  label: string;
};

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getText(msg: Api.Message): string {
  return String((msg as any).message || (msg as any).text || "").trim();
}

function getReplyId(msg: Api.Message): number | undefined {
  const replyTo = (msg as any).replyTo;
  return replyTo?.replyToMsgId || (msg as any).replyToMsgId || undefined;
}

function parseMessageLink(value: string): { peer: string; messageId: number; label: string } | null {
  const match = value.match(/^https?:\/\/t\.me\/(?:c\/(\d+)|([A-Za-z0-9_]+))\/(\d+)(?:\?.*)?$/i);
  if (!match) return null;
  const internalId = match[1];
  const username = match[2];
  const messageId = Number(match[3]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  if (internalId) {
    return { peer: `-100${internalId}`, messageId, label: `c/${internalId}/${messageId}` };
  }
  return { peer: username!, messageId, label: `${username}/${messageId}` };
}

function getSenderLabel(message: any): string {
  const sender = message.sender || message.from;
  if (sender) {
    const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
    if (name) return name;
    if (sender.username) return `@${sender.username}`;
    if (sender.title) return sender.title;
  }
  const senderId = message.senderId || message.fromId?.userId || message.fromId?.channelId;
  return senderId ? String(senderId) : "未知用户";
}

function formatDate(message: any): string {
  const date = message.date;
  if (!date) return "未知时间";
  const value = date instanceof Date ? date : new Date(Number(date) * 1000);
  if (Number.isNaN(value.getTime())) return "未知时间";
  return value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function extractMessages(result: any): any[] {
  return Array.isArray(result?.messages) ? result.messages : [];
}

async function resolveTarget(msg: Api.Message, argument: string): Promise<Target | null> {
  const link = argument ? parseMessageLink(argument) : null;
  if (argument && !link) return null;

  if (link) {
    const peer = await (msg.client as any).getInputEntity(link.peer);
    return { peer, messageId: link.messageId, label: link.label };
  }

  const replyId = getReplyId(msg);
  if (!replyId) return null;
  return { peer: await msg.getInputChat(), messageId: replyId, label: `当前会话/${replyId}` };
}

async function fetchAllReplies(msg: Api.Message, target: Target): Promise<any[]> {
  const client = msg.client as any;
  const replies: any[] = [];
  const seen = new Set<number>();
  let offsetId = 0;

  for (let page = 0; page < 100; page += 1) {
    const result = await client.invoke(new Api.messages.GetReplies({
      peer: target.peer,
      msgId: target.messageId,
      offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit: 100,
      maxId: 0,
      minId: 0,
      hash: 0,
    }));
    const batch = extractMessages(result);
    if (batch.length === 0) break;

    let added = 0;
    for (const item of batch) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      replies.push(item);
      added += 1;
    }
    if (!added || batch.length < 100) break;

    const ids = batch.map((item) => Number(item.id)).filter(Number.isFinite);
    const nextOffset = Math.min(...ids);
    if (!nextOffset || nextOffset === offsetId) break;
    offsetId = nextOffset;
  }

  return replies.sort((a, b) => Number(a.id) - Number(b.id));
}

class ThreadReplyStatsPlugin extends Plugin {
  name = "tj";
  description = `统计指定消息的全部回复\n<code>${mainPrefix}tj 链接</code> 或回复消息后发送 <code>${mainPrefix}tj</code>`;

  private async reply(msg: Api.Message, text: string): Promise<void> {
    await msg.client.sendMessage(msg.peerId, {
      message: text,
      parseMode: "html",
    });
  }

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    tj: async (msg) => {
      const text = getText(msg);
      const parts = text.split(/\s+/).filter(Boolean);
      const argument = parts.slice(1).join(" ");

      try {
        const target = await resolveTarget(msg, argument);
        if (!target) {
          await this.reply(msg, `用法：\n<code>${mainPrefix}tj https://t.me/c/1821626401/1686</code>\n或回复目标消息后发送 <code>${mainPrefix}tj</code>`);
          return;
        }

        const replies = await fetchAllReplies(msg, target);
        if (replies.length === 0) {
          await this.reply(msg, `目标消息 <code>${htmlEscape(target.label)}</code> 暂无回复。`);
          return;
        }

        const lines = replies.map((reply, index) => {
          const body = getText(reply).replace(/\s+/g, " ").trim() || "[非文本消息]";
          return `${index + 1}. <b>${htmlEscape(getSenderLabel(reply))}</b> | ${htmlEscape(formatDate(reply))}\n   ${htmlEscape(body)}`;
        });
        const header = `📋 <b>目标消息 ${htmlEscape(target.label)} 的回复</b>\n共 ${replies.length} 条\n\n`;
        const output = header + lines.join("\n");
        if (output.length <= MAX_OUTPUT) {
          await this.reply(msg, output);
          return;
        }

        await this.reply(msg, `${header}回复较多，以下为完整列表：`);
        for (let start = 0; start < lines.length; start += 1) {
          let chunk = "";
          while (start < lines.length && (chunk.length + lines[start].length + 1) <= MAX_OUTPUT) {
            chunk += `${lines[start]}\n`;
            start += 1;
          }
          start -= 1;
          await msg.client.sendMessage(msg.peerId, { message: chunk.trim(), parseMode: "html" });
        }
      } catch (error) {
        console.error("[tj] 统计消息回复失败:", error);
        await this.reply(msg, `❌ 统计失败：${htmlEscape(error instanceof Error ? error.message : error)}`);
      }
    },
  };
}

export default new ThreadReplyStatsPlugin();
