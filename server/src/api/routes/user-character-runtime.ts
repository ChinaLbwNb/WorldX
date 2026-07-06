import { Router } from "express";
import type { Request, Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";

const router = Router();

router.get("/avatar", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.query.userCharacterId === "string" ? req.query.userCharacterId : "";
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  const state = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!state) {
    res.status(404).json({ error: "User character runtime not found" });
    return;
  }
  res.json(state);
});

router.post("/avatar/move", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  const location = typeof req.body?.location === "string" ? req.body.location : "main_area";
  const mainAreaPointId = typeof req.body?.mainAreaPointId === "string" ? req.body.mainAreaPointId : null;

  if (!userCharacterId || !Number.isFinite(x) || !Number.isFinite(y)) {
    res.status(400).json({ error: "userCharacterId, x and y are required" });
    return;
  }
  if (!appContext.playerManager.getPlayer(userCharacterId, userId)) {
    res.status(404).json({ error: "User character runtime not found" });
    return;
  }

  appContext.playerManager.updatePosition(userCharacterId, x, y, location, mainAreaPointId);
  res.json({ ok: true });
});

router.post("/mode", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const mode = req.body?.mode;

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (mode !== "avatar" && mode !== "god") {
    res.status(400).json({ error: 'mode must be "avatar" or "god"' });
    return;
  }
  if (!appContext.playerManager.getPlayer(userCharacterId, userId)) {
    res.status(404).json({ error: "User character runtime not found" });
    return;
  }

  appContext.playerManager.setMode(userCharacterId, mode);
  appContext.eventBus.emit("user_character_mode_changed", { userCharacterId, mode });
  res.json({ ok: true, mode });
});

export default router;
