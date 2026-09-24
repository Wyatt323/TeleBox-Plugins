import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { safeGetMe } from "@utils/authGuards";

function getReplyMessageId(msg: Api.Message): number | undefined {
  const typed = msg as Api.Message & {
    replyTo?: { replyToMsgId?: number };
    replyToMsgId?: number;
  };
  return typed.replyTo?.replyToMsgId ?? typed.replyToMsgId;
}

function getMessageText(msg: Api.Message): string {
  return String((msg as any).message || (msg as any).text || "");
}

function toId(value: unknown): string {
  if (value && typeof value === "object" && "value" in value) {
    return String((value as { value: unknown }).value);
  }
  return String(value ?? "");
}

function explicitlyMentionsMe(msg: Api.Message, myId: string, myUsername: string): boolean {
  if ((msg as any).mentioned === true) return true;

  const text = getMessageText(msg);
  for (const entity of (msg.entities || []) as Api.TypeMessageEntity[]) {
    if (entity instanceof Api.MessageEntityMentionName) {
      if (toId((entity as any).userId) === myId) return true;
      continue;
    }
    if (entity instanceof Api.MessageEntityMention && myUsername) {
      const mention = text.slice(entity.offset, entity.offset + entity.length).replace(/^@/, "");
      if (mention.toLowerCase() === myUsername.toLowerCase()) return true;
    }
  }
  return false;
}

class BanAdSpamPlugin extends Plugin {
  name = "ban_ad_spam";
  description = "收到回复消息中的 @提及 和 ban广告 后，自动对目标消息回复 /spam";
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {};

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    try {
      if ((msg as any).out || !msg.client || !msg.peerId) return;

      const text = getMessageText(msg);
      if (!text.toLowerCase().includes("ban广告")) return;

      const replyMessageId = getReplyMessageId(msg);
      if (!replyMessageId) return;

      const me = await safeGetMe(msg.client);
      if (!me) return;
      const myId = toId(me.id);
      const myUsername = me.username || "";
      if (!explicitlyMentionsMe(msg, myId, myUsername)) return;

      await msg.client.sendMessage(msg.peerId, {
        message: "/spam",
        replyTo: replyMessageId,
      });
      console.log(`[ban_ad_spam] 已对目标消息 ${replyMessageId} 回复 /spam`);
    } catch (error) {
      console.error("[ban_ad_spam] 自动举报失败:", error);
    }
  };
}

export default new BanAdSpamPlugin();
