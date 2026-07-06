import { z } from "zod";
import type { AppContext } from "../services/app-context.js";
import { resolveScopedCharacterRuntime } from "../utils/scoped-character-runtime.js";

/**
 * 公屏 @NPC 一次性对话生成。
 *
 * 复用架空对话（sandbox-chat）的思路：把 NPC 当下状态 + 相关记忆快照出来，
 * 生成一句符合人设的公开回复。**不写数据库、不产生记忆、不触发主模拟**。
 *
 * 与 sandbox-chat 的区别：这是「公屏」场景，多个玩家可同时 @ 同一个 NPC，
 * 因此按 characterId 维护一份共享的近期对话上下文（含提问者昵称），让 NPC 有连贯感。
 */

const ReplySchema = z.object({ reply: z.string().min(1) });

const MAX_HISTORY = 16; // 每个 NPC 保留的近期对话条数（双向）
const HISTORY_IDLE_MS = 20 * 60 * 1000; // 20 分钟无人 @ 则清空该 NPC 上下文

interface NpcThread {
  history: { role: "user" | "character"; content: string }[];
  lastActiveAt: number;
}

const threads = new Map<string, NpcThread>();

function getThread(threadKey: string, now: number): NpcThread {
  const existing = threads.get(threadKey);
  if (existing && now - existing.lastActiveAt <= HISTORY_IDLE_MS) {
    return existing;
  }
  const fresh: NpcThread = { history: [], lastActiveAt: now };
  threads.set(threadKey, fresh);
  return fresh;
}

export interface NpcReplyResult {
  reply: string;
  character: { id: string; name: string };
}

/**
 * 生成 NPC 对公屏提问的回复。
 * @param nowMs 由调用方传入的时间戳（websocket 层用 Date.now()）。
 */
export async function generateNpcReply(
  ctx: AppContext,
  characterId: string,
  askerName: string,
  question: string,
  nowMs: number,
  options: { worldDir?: string; threadScopeId?: string } = {},
): Promise<NpcReplyResult> {
  const { profile, state, isActiveRuntimeWorld } = resolveScopedCharacterRuntime(
    ctx,
    characterId,
    options.worldDir,
  );
  const gameTime = ctx.worldManager.getCurrentTime();

  const thread = getThread(options.threadScopeId ?? characterId, nowMs);

  // 提问内容前缀提问者昵称，让 NPC 知道是谁在公屏里跟它说话
  const askerLabel = askerName.trim() || "一位旅行者";
  const userContent = `${askerLabel}：${question}`;

  const keywordSource = [
    question,
    ...thread.history.slice(-4).map((h) => h.content),
  ].join(" ");
  const contextKeywords = keywordSource
    .split(/[\s，。！？,.!?；;:：]+/)
    .filter((k) => k.length >= 2)
    .slice(0, 20);

  const memories = isActiveRuntimeWorld
    ? ctx.characterManager.memoryManager.retrieveMemories({
        characterId,
        currentTime: gameTime,
        contextKeywords,
        relatedLocation: state.location,
        topK: 8,
      })
    : [];
  const memoriesBlock =
    memories.length > 0 ? memories.map((m) => `- ${m.content}`).join("\n") : "";

  const messages = ctx.promptBuilder.buildSandboxChatMessages({
    profile,
    state,
    memoriesBlock,
    userIdentity: "", // 公屏场景：提问者身份已写进每条消息前缀
    transcript: thread.history,
    latestUserMessage: userContent,
  });

  const result = await ctx.llmClient.call({
    messages,
    schema: ReplySchema,
    options: {
      taskType: "sandbox_chat",
      characterId,
      temperature: 0.9,
    },
  });

  const reply = result.data.reply.trim();

  thread.history.push({ role: "user", content: userContent });
  thread.history.push({ role: "character", content: reply });
  if (thread.history.length > MAX_HISTORY) {
    thread.history.splice(0, thread.history.length - MAX_HISTORY);
  }
  thread.lastActiveAt = nowMs;

  return { reply, character: { id: profile.id, name: profile.name } };
}
