import { Router } from "express";
import type { Request, Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import * as inventoryStore from "../../store/inventory-store.js";
import * as userCharacterStore from "../../store/user-character-store.js";
import { generateUserCharacterAssets } from "../../core/user-character-asset-generator.js";
import { removeAccountAssetPath } from "../../utils/account-assets.js";

const router = Router();

function toUserCharacter(state: ReturnType<typeof appContext.playerManager.getStateNoThrow>) {
  if (!state) return null;
  const presence = appContext.playerManager.getPlayerPresence(state.id);
  return {
    id: state.id,
    name: state.name,
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    currentMapId: presence.currentMapId,
    location: state.location,
    mainAreaPointId: state.mainAreaPointId,
    x: state.x,
    y: state.y,
    appearance: state.appearance,
    inventory: state.inventory,
    online: state.isOnline,
  };
}

router.get("/", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  appContext.playerManager.createStarterUserCharactersForNewAccount(userId);
  const characters = appContext.playerManager
    .getAllPlayers(userId)
    .map((state) => toUserCharacter(state))
    .filter((state): state is NonNullable<typeof state> => Boolean(state));
  res.json({ userId, characters });
});

router.post("/", async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const rawPrompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const prompt = rawPrompt || rawName;
  const generateAppearance = req.body?.generateAppearance !== false;
  const name = rawName.slice(0, 24) || prompt.slice(0, 24);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const state = appContext.playerManager.createUserCharacter(name, userId);
  if (generateAppearance && prompt) {
    try {
      const result = await generateUserCharacterAssets({
        userCharacterId: state.id,
        name,
        prompt,
        worldVisualContext: appContext.worldManager.getWorldDescription() || "",
      });
      appContext.playerManager.updatePlayer(state.id, {
        appearance: result.appearance,
      });
    } catch (error) {
      appContext.playerManager.deleteUserCharacter(state.id, userId);
      res.status(500).json({
        error: `用户角色素材生成失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }
  const created = appContext.playerManager.getPlayer(state.id, userId) ?? state;
  res.json({ userId, character: toUserCharacter(created) });
});

router.post("/:id/enter-map", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = String(req.params.id || "");
  const targetMapId = typeof req.body?.mapId === "string" ? req.body.mapId : "";
  if (!targetMapId) {
    res.status(400).json({ error: "mapId is required" });
    return;
  }
  if (!appContext.playerManager.getPlayer(userCharacterId, userId)) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  try {
    const before = appContext.playerManager.getPlayer(userCharacterId, userId);
    const oldPresence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const wasOnline = before?.isOnline === true;
    const travel = appContext.worldManager.travelToMap(targetMapId);
    appContext.resourceManager.rediscoverForMap(targetMapId);
    appContext.syncActiveMapRuntimeResources();
    const state = appContext.playerManager.enterActiveMap(userCharacterId, userId);
    if (!state) throw new Error("User character not found after map travel");
    const presence = appContext.playerManager.getPlayerPresence(state.id);
    appContext.mapRuntimeRegistry.ensureRuntime({
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    });
    appContext.eventBus.emit("user_character_presence_changed", {
      playerId: state.id,
      oldPresence,
      newPresence: presence,
      player: state,
      wasOnline,
    });
    res.json({
      ok: true,
      userId,
      travel,
      character: toUserCharacter(state),
      presence,
      requiresReload: true,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/:id/select", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = String(req.params.id || "");
  if (!appContext.playerManager.getPlayer(userCharacterId, userId)) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  try {
    const before = appContext.playerManager.getPlayer(userCharacterId, userId);
    const oldPresence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const wasOnline = before?.isOnline === true;
    const state = appContext.playerManager.enterActiveMap(userCharacterId, userId);
    if (!state) throw new Error("User character not found after selection");
    const presence = appContext.playerManager.getPlayerPresence(state.id);
    appContext.mapRuntimeRegistry.ensureRuntime({
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    });
    appContext.eventBus.emit("user_character_presence_changed", {
      playerId: state.id,
      oldPresence,
      newPresence: presence,
      player: state,
      wasOnline,
    });
    res.json({
      ok: true,
      userId,
      character: toUserCharacter(state),
      presence,
      requiresReload: false,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.patch("/:id", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = String(req.params.id || "");
  const state = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!state) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const name = rawName.slice(0, 24);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  appContext.playerManager.updatePlayer(userCharacterId, { name });
  const updated = appContext.playerManager.getPlayer(userCharacterId, userId);
  res.json({ ok: true, userId, character: toUserCharacter(updated) });
});

router.delete("/:id", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = String(req.params.id || "");
  const check = userCharacterStore.canDeleteUserCharacter(userCharacterId, userId);
  if (!check.ok) {
    const status = check.reason === "User character not found" ? 404 : 409;
    res.status(status).json({ error: check.reason });
    return;
  }
  const deleted = appContext.playerManager.deleteUserCharacter(userCharacterId, userId);
  if (!deleted) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  removeAccountAssetPath(`user-characters/${userCharacterId}`);
  res.json({ ok: true, deletedCharacterId: userCharacterId });
});

router.get("/:id/inventory", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userCharacterId = String(req.params.id || "");
  const state = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!state) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  inventoryStore.migrateUserCharacterInventoryToAccount(userId);
  res.json({
    userId,
    userCharacterId,
    owner: { ownerType: "account", ownerId: userId },
    items: inventoryStore.getInventoryForOwner({ ownerType: "account", ownerId: userId }),
  });
});

export default router;
