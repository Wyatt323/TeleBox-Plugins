import { Api, type TelegramClient } from "teleproto";
import { Button } from "teleproto/tl/custom/button";
import { CallbackQuery, CallbackQueryEvent } from "teleproto/events";
import { Plugin } from "@utils/pluginBase";
import { safeGetMe } from "@utils/authGuards";

const VOTE_TTL_MS = 5 * 60 * 1000;
const REQUIRED_VOTES = 3;

type Vote = {
  peer: any;
  client: TelegramClient;
  targetMessageId: number;
  voteMessage: Api.Message;
  voters: Set<string>;
  expiresAt: number;
  completed: boolean;
};

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

function voteText(vote: Vote): string {
  const remaining = Math.max(0, Math.ceil((vote.expiresAt - Date.now()) / 1000));
  return `🛡️ <b>Ban 投票</b>\n\n同意人数：<b>${vote.voters.size}/${REQUIRED_VOTES}</b>\n有效期：${remaining} 秒\n\n点击下方按钮投票，同一用户只能投一次。`;
}

function buildVoteButton(count: number, token: string): Api.KeyboardInlineButton {
  return Button.inline(`✅ 同意 Ban（${count}/${REQUIRED_VOTES}）`, `ban_ad_spam:${token}`);
}

class BanAdSpamPlugin extends Plugin {
  name = "ban_ad_spam";
  description = "ban广告触发 5 分钟、3 人同意的 /spam 投票";
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {};
  eventHandlers = [
    {
      event: new CallbackQuery({ match: /^ban_ad_spam:/ }),
      handler: async (event: unknown) => this.handleVote(event as CallbackQueryEvent),
    },
  ];

  private votes = new Map<string, Vote>();
  private sequence = 0;

  private cleanupVotes(): void {
    const now = Date.now();
    for (const [token, vote] of this.votes) {
      if (vote.completed || vote.expiresAt <= now) this.votes.delete(token);
    }
  }

  private async handleVote(event: CallbackQueryEvent): Promise<void> {
    const data = Buffer.from(event.data || []).toString("utf8");
    const token = data.slice("ban_ad_spam:".length);
    const vote = this.votes.get(token);
    if (!vote || vote.completed || vote.expiresAt <= Date.now()) {
      await event.answer({ message: "这项投票已结束", alert: true });
      this.votes.delete(token);
      return;
    }

    const senderId = toId(event.query.userId);
    if (!senderId) {
      await event.answer({ message: "无法识别投票用户", alert: true });
      return;
    }
    if (vote.voters.has(senderId)) {
      await event.answer({ message: "你已经投过票了", alert: true });
      return;
    }

    vote.voters.add(senderId);
    if (vote.voters.size >= REQUIRED_VOTES) {
      vote.completed = true;
      await vote.client.sendMessage(vote.peer, {
        message: "/spam",
        replyTo: vote.targetMessageId,
      });
      await event.answer({ message: "已达到 3 人同意，已执行 /spam" });
      await event.edit({ text: "✅ <b>投票通过</b>\n已达到 3 人同意，已回复 /spam。", parseMode: "html", buttons: [] });
      this.votes.delete(token);
      return;
    }

    await event.answer({ message: `投票成功：${vote.voters.size}/${REQUIRED_VOTES}` });
    await event.edit({ text: voteText(vote), parseMode: "html", buttons: [[buildVoteButton(vote.voters.size, token)]] });
  }

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    try {
      this.cleanupVotes();
      if ((msg as any).out || !msg.client || !msg.peerId) return;

      const text = getMessageText(msg);
      if (!text.toLowerCase().includes("ban广告")) return;
      const targetMessageId = getReplyMessageId(msg);
      if (!targetMessageId) return;

      const me = await safeGetMe(msg.client);
      if (!me || !explicitlyMentionsMe(msg, toId(me.id), me.username || "")) return;

      const token = `${Date.now()}_${++this.sequence}`;
      const vote: Vote = {
        peer: msg.peerId,
        client: msg.client,
        targetMessageId,
        voteMessage: msg,
        voters: new Set<string>(),
        expiresAt: Date.now() + VOTE_TTL_MS,
        completed: false,
      };
      const voteMessage = await msg.client.sendMessage(msg.peerId, {
        message: voteText(vote),
        replyTo: targetMessageId,
        buttons: [[buildVoteButton(0, token)]],
        parseMode: "html",
      });
      console.log(`[ban_ad_spam] 投票消息已发送 id=${voteMessage.id} markup=${(voteMessage as any).replyMarkup?.className || "none"}`);
      vote.voteMessage = voteMessage;
      this.votes.set(token, vote);
      setTimeout(() => {
        const current = this.votes.get(token);
        if (!current || current.completed) return;
        this.votes.delete(token);
        current.voteMessage.edit({ text: "⌛ <b>Ban 投票已超时</b>", parseMode: "html", buttons: [] }).catch(() => undefined);
      }, VOTE_TTL_MS);
    } catch (error) {
      console.error("[ban_ad_spam] 创建投票失败:", error);
    }
  };
}

export default new BanAdSpamPlugin();
