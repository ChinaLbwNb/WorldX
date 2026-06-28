import { Router } from "express";
import type { Request, Response } from "express";
import { appContext } from "../../services/app-context.js";

const router = Router();

/**
 * GET /api/player/avatar — 获取当前玩家化身状态
 */
router.get("/avatar", (_req: Request, res: Response) => {
  const state = appContext.playerManager.getStateNoThrow();
  if (!state) {
    return res.status(404).json({ error: "Player avatar not initialized" });
  }
  res.json(state);
});

/**
 * POST /api/player/avatar/move — 更新玩家位置（客户端实时同步）
 * body: { playerId: string, x: number, y: number, location: string, mainAreaPointId?: string }
 */
router.post("/avatar/move", (req: Request, res: Response) => {
  const { playerId, x, y, location, mainAreaPointId } = req.body ?? {};

  if (typeof playerId !== "string" || typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "playerId, x and y are required" });
  }

  appContext.playerManager.updatePosition(
    playerId,
    x,
    y,
    typeof location === "string" ? location : "main_area",
    typeof mainAreaPointId === "string" ? mainAreaPointId : null,
  );

  res.json({ ok: true });
});

/**
 * POST /api/player/avatar/interact — 玩家发起交互
 * body: { actionType: string, targetId: string, interactionId?: string }
 */
router.post("/avatar/interact", async (req: Request, res: Response) => {
  const { playerId, actionType, targetId, interactionId } = req.body ?? {};

  if (typeof playerId !== "string" || typeof actionType !== "string" || typeof targetId !== "string") {
    return res.status(400).json({ error: "playerId, actionType and targetId are required" });
  }

  try {
    const gameTime = appContext.worldManager.getCurrentTime();

    let duration = 1;
    if (actionType === "interact_object" && interactionId) {
      const interactions = appContext.worldManager.getAvailableInteractions(targetId);
      const interaction = interactions.find((i) => i.id === interactionId);
      if (interaction) duration = interaction.duration;
    } else if (actionType === "world_action") {
      const worldActions = appContext.worldManager.getWorldActions();
      const action = worldActions.find((a) => a.id === interactionId);
      if (action) duration = action.duration;
    }

    const startTick = gameTime.tick;
    const endTick = startTick + duration;

    appContext.playerManager.startAction(playerId, actionType, targetId, startTick, endTick);

    res.json({ ok: true, action: { actionType, targetId, interactionId, startTick, endTick } });
  } catch (error) {
    res.status(500).json({
      error: "interaction failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/player/mode — 切换玩家模式
 * body: { playerId: string, mode: "avatar" | "god" }
 */
router.post("/mode", (req: Request, res: Response) => {
  const { playerId, mode } = req.body ?? {};

  if (typeof playerId !== "string") {
    return res.status(400).json({ error: "playerId is required" });
  }
  if (mode !== "avatar" && mode !== "god") {
    return res.status(400).json({ error: 'mode must be "avatar" or "god"' });
  }

  appContext.playerManager.setMode(playerId, mode);
  appContext.eventBus.emit("player_mode_changed", { playerId, mode });

  res.json({ ok: true, mode });
});

export default router;