import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { appContext } from "../../services/app-context.js";
import { generateId } from "../../utils/id-generator.js";
import { getRequestUserId } from "../request-user.js";
import { canUserAccessWorld, findWorldById } from "../../utils/world-directories.js";
import { resolveScopedCharacterRuntime } from "../../utils/scoped-character-runtime.js";
import { recordTutorialTaskEvent } from "../../store/tutorial-task-store.js";

/**
 * 架空对话（Sandbox Chat）
 *
 * 与"上帝系统 / 耳语托梦"不同：这里把角色当下的状态 + 记忆在内存中"快照"出来，
 * 和用户进行多轮对话。**不会写入任何数据库**，不会产生新记忆、不会触发主模拟事件。
 * 会话生命周期完全绑定在这个进程的内存 Map 里，关闭 / 超时即销毁。
 */

interface SandboxSession {
  id: string;
  characterId: string;
  userCharacterId?: string;
  worldId?: string;
  timelineId?: string;
  mapId?: string;
  worldDir?: string;
  userIdentity: string;
  createdAt: number;
  lastActiveAt: number;
  history: { role: "user" | "character"; content: string }[];
}

const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 分钟未活跃回收
const MAX_HISTORY = 40; // 双向，超过则丢最早
const MAX_SESSIONS = 64;

const sessions = new Map<string, SandboxSession>();

function reapExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActiveAt > SESSION_IDLE_MS) {
      sessions.delete(id);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const entries = [...sessions.entries()].sort(
      (a, b) => a[1].lastActiveAt - b[1].lastActiveAt,
    );
    const toDrop = entries.slice(0, entries.length - MAX_SESSIONS);
    for (const [id] of toDrop) sessions.delete(id);
  }
}

const ReplySchema = z.object({ reply: z.string().min(1) });

const router = Router();

function resolveSandboxScope(req: Request, res: Response): { userCharacterId?: string; worldId?: string; timelineId?: string; mapId?: string; worldDir?: string } | null {
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId.trim() : "";
  if (!userCharacterId) return {};

  const userId = getRequestUserId(req);
  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return null;
  }

  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  const world = findWorldById(presence.worldId);
  if (!world) {
    res.status(404).json({ error: "World not found for character presence" });
    return null;
  }
  if (!canUserAccessWorld(world, userId)) {
    res.status(403).json({ error: "You do not have access to this world" });
    return null;
  }

  return {
    userCharacterId,
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: presence.currentMapId,
    worldDir: world.dir,
  };
}

/**
 * POST /api/sandbox/chat/start
 * body: { characterId: string, userIdentity?: string, userCharacterId?: string }
 */
router.post("/start", (req: Request, res: Response) => {
  reapExpired();
  const { characterId, userIdentity } = req.body ?? {};

  if (typeof characterId !== "string" || characterId.trim().length === 0) {
    return res.status(400).json({ error: "characterId is required" });
  }

  const scope = resolveSandboxScope(req, res);
  if (res.headersSent || !scope) return;

  let runtime;
  try {
    runtime = resolveScopedCharacterRuntime(appContext, characterId, scope.worldDir);
  } catch (error) {
    return res.status(404).json({ error: "character not found" });
  }

  const id = generateId();
  const now = Date.now();
  const session: SandboxSession = {
    id,
    characterId,
    userCharacterId: scope.userCharacterId,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
    mapId: scope.mapId,
    worldDir: scope.worldDir,
    userIdentity: typeof userIdentity === "string" ? userIdentity.trim() : "",
    createdAt: now,
    lastActiveAt: now,
    history: [],
  };
  sessions.set(id, session);

  const profile = runtime.profile;

  return res.json({
    ok: true,
    sessionId: id,
    character: {
      id: profile.id,
      name: profile.name,
      role: profile.role,
    },
  });
});

/**
 * POST /api/sandbox/chat/message
 * body: { sessionId: string, message: string }
 */
router.post("/message", async (req: Request, res: Response) => {
  reapExpired();
  const { sessionId, message } = req.body ?? {};

  if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
    return res.status(404).json({ error: "session not found" });
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "message is required" });
  }

  const session = sessions.get(sessionId)!;
  const userMsg = message.trim();

  const { profile, state, isActiveRuntimeWorld } = resolveScopedCharacterRuntime(
    appContext,
    session.characterId,
    session.worldDir,
  );
  const gameTime = appContext.worldManager.getCurrentTime();

  // 上下文关键词：对方的话 + 对话历史最后几句中的内容，用来挑出更相关的记忆
  const keywordSource = [
    userMsg,
    ...session.history.slice(-4).map((h) => h.content),
  ].join(" ");
  const contextKeywords = keywordSource
    .split(/[\s，。！？,.!?；;:：]+/)
    .filter((k) => k.length >= 2)
    .slice(0, 20);

  const memories = isActiveRuntimeWorld
    ? appContext.characterManager.memoryManager.retrieveMemories({
        characterId: session.characterId,
        currentTime: gameTime,
        contextKeywords,
        relatedLocation: state.location,
        topK: 8,
      })
    : [];

  const memoriesBlock =
    memories.length > 0
      ? memories.map((m) => `- ${m.content}`).join("\n")
      : "";

  const messages = appContext.promptBuilder.buildSandboxChatMessages({
    profile,
    state,
    memoriesBlock,
    userIdentity: session.userIdentity,
    transcript: session.history,
    latestUserMessage: userMsg,
  });

  try {
    const result = await appContext.llmClient.call({
      messages,
      schema: ReplySchema,
      options: {
        taskType: "sandbox_chat",
        characterId: session.characterId,
        temperature: 0.9,
      },
    });

    const reply = result.data.reply.trim();

    session.history.push({ role: "user", content: userMsg });
    session.history.push({ role: "character", content: reply });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }
    session.lastActiveAt = Date.now();
    recordTutorialTaskEvent(getRequestUserId(req), "talk_to_npc");

    return res.json({
      ok: true,
      reply,
      character: {
        id: profile.id,
        name: profile.name,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `LLM call failed: ${msg}` });
  }
});

/**
 * POST /api/sandbox/chat/close
 * body: { sessionId: string }
 */
router.post("/close", (req: Request, res: Response) => {
  const { sessionId } = req.body ?? {};
  if (typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }
  sessions.delete(sessionId);
  return res.json({ ok: true });
});

/**
 * GET /api/sandbox/chat/:sessionId
 * 用于刷新页面后恢复对话（可选）。
 */
router.get("/:sessionId", (req: Request, res: Response) => {
  const rawSessionId = req.params.sessionId;
  const sessionId =
    typeof rawSessionId === "string" ? rawSessionId : rawSessionId?.[0];
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: "session not found" });
  return res.json({
    ok: true,
    sessionId: s.id,
    characterId: s.characterId,
    userCharacterId: s.userCharacterId,
    worldId: s.worldId,
    timelineId: s.timelineId,
    mapId: s.mapId,
    userIdentity: s.userIdentity,
    history: s.history,
  });
});

export default router;
