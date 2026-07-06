import { Router } from "express";
import type { Request, Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import * as inventoryStore from "../../store/inventory-store.js";
import * as userCharacterStore from "../../store/user-character-store.js";
import { generateUserCharacterAssets } from "../../core/user-character-asset-generator.js";
import { removeAccountAssetPath } from "../../utils/account-assets.js";
import { canUserAccessWorld, findWorldById } from "../../utils/world-directories.js";

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
  const rm = appContext.resourceManager;
  const costs = rm.getBuildCosts();
  let chargedCost = 0;
  if (generateAppearance) {
    const spendResult = rm.spendResources(userId, costs.character);
    if (!spendResult.success) {
      res.status(400).json({
        error: spendResult.reason,
        required: costs.character,
        current: spendResult.newAmount,
      });
      return;
    }
    chargedCost = costs.character;
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
      if (chargedCost > 0) {
        rm.addResources(userId, chargedCost);
      }
      res.status(500).json({
        error: `用户角色素材生成失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }
  const created = appContext.playerManager.getPlayer(state.id, userId) ?? state;
  res.json({
    userId,
    cost: chargedCost,
    resources: rm.getResourceAmount(userId),
    character: toUserCharacter(created),
  });
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
	    const world = findWorldById(oldPresence.worldId);
	    if (!world) {
	      res.status(404).json({ error: "World not found for character presence" });
	      return;
	    }
	    if (!canUserAccessWorld(world, userId)) {
	      res.status(403).json({ error: "You do not have access to this world" });
	      return;
	    }
	    const mapState = appContext.mapPackageLoader.getMapNodesState(world.dir, oldPresence.currentMapId);
	    const targetMap = mapState.mapNodes.find((map) => map.id === targetMapId);
	    if (!targetMap) {
	      res.status(404).json({ error: `Map not found: ${targetMapId}` });
	      return;
	    }
	    if (targetMap.status !== "available") {
	      res.status(400).json({ error: `Map is not available: ${targetMapId}` });
	      return;
	    }
	    const spawn = appContext.mapPackageLoader.getDefaultSpawnForMap(world.dir, targetMapId);
	    appContext.playerManager.updatePlayer(userCharacterId, {
	      worldId: oldPresence.worldId,
	      timelineId: oldPresence.timelineId,
	      currentMapId: targetMapId,
	      mode: "avatar",
	      location: "main_area",
	      mainAreaPointId: spawn.mainAreaPointId,
	      x: spawn.x,
	      y: spawn.y,
	    });
	    const state = appContext.playerManager.getPlayer(userCharacterId, userId);
	    if (!state) throw new Error("User character not found after map travel");
	    const presence = appContext.playerManager.getPlayerPresence(state.id);
	    const scope = {
	      worldId: presence.worldId,
	      timelineId: presence.timelineId,
	      mapId: presence.currentMapId,
	    };
	    appContext.mapRuntimeRegistry.ensureRuntime(scope);
	    appContext.mapRuntimeRegistry.updateResourceNodes(
	      scope,
	      appContext.mapPackageLoader.discoverResourceNodes(world.dir, targetMapId),
	    );
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
	      travel: {
	        activeMapId: targetMapId,
	        targetMapId,
	        spawn: { x: spawn.x, y: spawn.y },
	        requiresReload: true,
	      },
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
    const sourceUserCharacterId = typeof req.body?.sourceUserCharacterId === "string"
      ? req.body.sourceUserCharacterId.trim()
      : "";
    const sourcePlayer = sourceUserCharacterId && sourceUserCharacterId !== userCharacterId
      ? appContext.playerManager.getPlayer(sourceUserCharacterId, userId)
      : null;
    const sourceOldPresence = sourcePlayer
      ? appContext.playerManager.getPlayerPresence(sourcePlayer.id)
      : null;
    const sourceWasOnline = sourcePlayer?.isOnline === true;
    const before = appContext.playerManager.getPlayer(userCharacterId, userId);
    const wasOnline = before?.isOnline === true;
    let state = before;
    if (!state) throw new Error("User character not found after selection");

    const oldPresence = appContext.playerManager.getPlayerPresence(state.id);
    let presence = oldPresence;
    let world = findWorldById(presence.worldId);
    const sourcePresence = resolveSelectionSourcePresence(sourceUserCharacterId, userCharacterId, userId);
    if (sourcePresence) {
      presence = sourcePresence;
      world = findWorldById(presence.worldId);
      if (!world) {
        res.status(404).json({ error: "World not found for source character presence" });
        return;
      }
      if (!canUserAccessWorld(world, userId)) {
        res.status(403).json({ error: "You do not have access to the source character world" });
        return;
      }
      const spawn = appContext.mapPackageLoader.getDefaultSpawnForMap(world.dir, presence.currentMapId);
      appContext.playerManager.updatePlayer(userCharacterId, {
        worldId: presence.worldId,
        timelineId: presence.timelineId,
        currentMapId: presence.currentMapId,
        mode: "avatar",
        location: "main_area",
        mainAreaPointId: spawn.mainAreaPointId,
        x: spawn.x,
        y: spawn.y,
      });
      state = appContext.playerManager.getPlayer(userCharacterId, userId);
      if (!state) throw new Error("User character not found after selection update");
      presence = appContext.playerManager.getPlayerPresence(state.id);
    }

    if (!world) {
      res.status(404).json({ error: "World not found for character presence" });
      return;
    }
    if (!canUserAccessWorld(world, userId)) {
      res.status(403).json({ error: "You do not have access to this world" });
      return;
    }
    const scope = {
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    };
    appContext.mapRuntimeRegistry.ensureRuntime(scope);
    appContext.mapRuntimeRegistry.updateResourceNodes(
      scope,
      appContext.mapPackageLoader.discoverResourceNodes(world.dir, presence.currentMapId),
    );
    if (sourcePlayer && sourceOldPresence && sourceWasOnline) {
      appContext.playerManager.setOnline(sourcePlayer.id, false);
      appContext.eventBus.emit("user_character_presence_changed", {
        playerId: sourcePlayer.id,
        oldPresence: sourceOldPresence,
        newPresence: null,
        player: sourcePlayer,
        wasOnline: true,
      });
    }
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

function resolveSelectionSourcePresence(
  sourceUserCharacterId: string,
  targetUserCharacterId: string,
  userId: string,
): { worldId: string; timelineId: string; currentMapId: string } | null {
  if (sourceUserCharacterId && sourceUserCharacterId !== targetUserCharacterId) {
    const source = appContext.playerManager.getPlayer(sourceUserCharacterId, userId);
    if (source) return appContext.playerManager.getPlayerPresence(source.id);
  }

  const fallback = appContext.playerManager
    .getAllPlayers(userId)
    .filter((character) => character.id !== targetUserCharacterId)
    .map((character) => appContext.playerManager.getPlayerPresence(character.id))
    .find((presence) => {
      const world = findWorldById(presence.worldId);
      return Boolean(world && canUserAccessWorld(world, userId));
    });

  return fallback ?? null;
}

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
