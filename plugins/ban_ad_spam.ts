import { Api } from "teleproto";
import { Raw } from "teleproto/events";
import { Plugin } from "@utils/pluginBase";
import { safeGetMe } from "@utils/authGuards";

const VOTE_TTL_MS = 5 * 60 * 1000;
const REQUIRED_VOTES = 3;
const APPROVAL_REACTION = "👍";

type Vote = {
  peer: any;
  client: any;
  targetMessageId: number;
  voteMessageId: number;
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

function reactionIsApproval(reaction: any): boolean {
  return reaction instanceof Api.ReactionEmoji && reaction.emoticon === APPROVAL_REACTION;
}

function reactionUserCount(result: any): number {
  if (!Array.isArray(result?.reactions)) return 0;
  return result.reactions.filter((item: any) => reactionIsApproval(item.reaction)).length;
}

function voteText(count: number, expiresAt: number): string {
  const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `🛡️ <b>Ban 投票</b>\n\n同意人数：<b>${count}/${REQUIRED_VOTES}</b>\n有效期：${remaining} 秒\n\n请对本消息添加 👍 表示同意。`;
}

class BanAdSpamPlugin extends Plugin {
  name = "ban_ad_spam";
  description = "ban广告触发 5 分钟、3 个 👍 同意的 /spam 投票";
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {};
  eventHandlers = [
    {
      event: new Raw({ types: [Api.UpdateMessageReactions] }),
      handler: async (update: unknown) => this.handleReactionUpdate(update as Api.UpdateMessageReactions),
    },
  ];

  private votes = new Map<string, Vote>();
  private sequence = 0;

  private voteKey(peer: unknown, messageId: number): string {
    return `${String(peer)}:${messageId}`;
  }

  private async countApprovals(vote: Vote): Promise<number> {
    const result = await vote.client.getReactionUsers(vote.peer, vote.voteMessageId, {
      reaction: APPROVAL_REACTION,
      limit: 100,
    });
    return reactionUserCount(result);
  }

  private async handleReactionUpdate(update: Api.UpdateMessageReactions): Promise<void> {
    for (const vote of this.votes.values()) {
      if (vote.completed || vote.expiresAt <= Date.now()) continue;
      if (update.msgId !== vote.voteMessageId) continue;

      try {
        const count = await this.countApprovals(vote);
        console.log(`[ban_ad_spam] vote message=${vote.voteMessageId} 👍=${count}/${REQUIRED_VOTES}`);
        if (count < REQUIRED_VOTES) {
          await vote.client.editMessage(vote.peer, {
            message: vote.voteMessageId,
            text: voteText(count, vote.expiresAt),
            parseMode: "html",
          });
          return;
        }

        vote.completed = true;
        await vote.client.sendMessage(vote.peer, {
          message: "/spam",
          replyTo: vote.targetMessageId,
        });
        await vote.client.editMessage(vote.peer, {
          message: vote.voteMessageId,
          text: "✅ <b>投票通过</b>\n已达到 3 个 👍，已回复 /spam。",
          parseMode: "html",
        });
        this.votes.delete(this.voteKey(vote.peer, vote.voteMessageId));
      } catch (error) {
        console.error("[ban_ad_spam] 处理 reaction 投票失败:", error);
      }
    }
  }

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    try {
      for (const [key, vote] of this.votes) {
        if (vote.expiresAt <= Date.now() || vote.completed) this.votes.delete(key);
      }
      if ((msg as any).out || !msg.client || !msg.peerId) return;

      const text = getMessageText(msg);
      if (!text.toLowerCase().includes("ban广告")) return;
      const targetMessageId = getReplyMessageId(msg);
      if (!targetMessageId) return;

      const me = await safeGetMe(msg.client);
      if (!me || !explicitlyMentionsMe(msg, toId(me.id), me.username || "")) return;

      const voteMessage = await msg.client.sendMessage(msg.peerId, {
        message: voteText(0, Date.now() + VOTE_TTL_MS),
        replyTo: targetMessageId,
        parseMode: "html",
      });
      const vote: Vote = {
        peer: msg.peerId,
        client: msg.client,
        targetMessageId,
        voteMessageId: voteMessage.id,
        expiresAt: Date.now() + VOTE_TTL_MS,
        completed: false,
      };
      this.votes.set(this.voteKey(msg.peerId, voteMessage.id), vote);
      console.log(`[ban_ad_spam] reaction vote created message=${voteMessage.id} target=${targetMessageId}`);

      setTimeout(() => {
        const key = this.voteKey(msg.peerId, voteMessage.id);
        const current = this.votes.get(key);
        if (!current || current.completed) return;
        this.votes.delete(key);
        current.client.editMessage(current.peer, {
          message: current.voteMessageId,
          text: "⌛ <b>Ban 投票已超时</b>。",
          parseMode: "html",
        }).catch(() => undefined);
      }, VOTE_TTL_MS);
    } catch (error) {
      console.error("[ban_ad_spam] 创建 reaction 投票失败:", error);
    }
  };
}

export default new BanAdSpamPlugin();
