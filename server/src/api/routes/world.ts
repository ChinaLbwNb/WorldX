import fs from "node:fs";
import path from "node:path";
import { Router, type Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import {
  getActiveSimulationTicks,
  getSimulationBusyMessage,
  isSimulationBusy,
} from "../../services/simulation-activity.js";
import { buildSceneRuntimeInfo, buildWorldTimeInfo } from "../../utils/time-helpers.js";
import * as worldStateStore from "../../store/world-state-store.js";
import * as accountAssets from "../../store/account-asset-store.js";
import { onlinePlayers } from "../../services/online-players.js";
import {
  GENERATED_WORLDS_DIR,
  LIBRARY_WORLDS_DIR,
  listGeneratedWorlds,
  listLibraryWorlds,
  findWorldById,
  canUserAccessWorld,
  canUserManageWorld,
  writeWorldAccessMetadata,
  type WorldVisibility,
} from "../../utils/world-directories.js";

const router = Router();

function rejectIfSimulationBusy(res: Response): boolean {
  if (!isSimulationBusy()) return false;
  res.status(409).json({
    error: getSimulationBusyMessage(),
    activeSimulationTicks: getActiveSimulationTicks(),
    canSwitchContext: false,
  });
  return true;
}

router.get("/time", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  res.json(buildWorldTimeInfo(appContext.worldManager.getCurrentTime()));
});

function currentTimelineForUser(userId: string, worldDir: string): string | null {
  const timelines = appContext.timelineManager.listTimelines(worldDir, userId);
  const current = appContext.timelineManager.getCurrentTimelineId();
  if (current && timelines.some((timeline) => timeline.id === current)) return current;
  return timelines[0]?.id ?? null;
}

router.get("/info", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const wm = appContext.worldManager;
  const currentWorldDir = appContext.getWorldDir();
  const userId = getRequestUserId(req);
  res.json({
    worldName: wm.getWorldName(),
    worldDescription: wm.getWorldDescription(),
    originalPrompt: wm.getOriginalPrompt(),
    currentWorldId: currentWorldDir ? path.basename(currentWorldDir) : null,
    currentTimelineId: currentWorldDir ? currentTimelineForUser(userId, currentWorldDir) : null,
    sceneConfig: wm.getSceneConfig(),
    sceneRuntime: buildSceneRuntimeInfo(wm.getSceneConfig()),
    worldActions: wm.getWorldActions(),
    mainAreaPoints: wm.getMainAreaPoints(),
    worldSize: wm.getWorldSize(),
    mainAreaDialogueRadiusPx: wm.getMainAreaDialogueDistanceThreshold(),
    timelineTickCount: appContext.timelineManager.getTickCount(),
  });
});

router.get("/maps", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const worldId = appContext.getWorldDir()?.split(/[\\/]/).pop() ?? "";
  res.json({
    ...appContext.worldManager.getWorldMapsState(),
    mapRuntimes: appContext.mapRuntimeRegistry.getRuntimesForWorld(
      worldId,
      appContext.timelineManager.getCurrentTimelineId() ?? undefined,
    ),
  });
});

router.get("/online", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const currentWorldDir = appContext.getWorldDir();
  const worldId = currentWorldDir ? path.basename(currentWorldDir) : "";
  const world = worldId ? findWorldById(worldId) : null;
  const userId = getRequestUserId(req);
  const timelineId = appContext.timelineManager.getCurrentTimelineId() ?? "";
  const activeMapId = appContext.worldManager.getActiveMapId();
  const players = onlinePlayers.list({ worldId, timelineId }).map((player) => ({
    ...player,
    isSelf: player.userId === userId,
    isCurrentMap: player.mapId === activeMapId,
  }));
  res.json({
    worldId,
    timelineId,
    activeMapId,
    canManage: world ? canUserManageWorld(world, userId) : false,
    players,
  });
});

router.post("/online/kick", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const targetPlayerId = typeof req.body?.playerId === "string" ? req.body.playerId : "";
  if (!targetPlayerId) {
    res.status(400).json({ error: "playerId is required" });
    return;
  }

  const currentWorldDir = appContext.getWorldDir();
  const worldId = currentWorldDir ? path.basename(currentWorldDir) : "";
  const world = worldId ? findWorldById(worldId) : null;
  const userId = getRequestUserId(req);
  if (!world || !canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner can kick online players" });
    return;
  }

  const currentTimelineId = appContext.timelineManager.getCurrentTimelineId() ?? "";
  const target = onlinePlayers
    .list({ worldId, timelineId: currentTimelineId })
    .find((player) => player.playerId === targetPlayerId);
  if (!target) {
    res.status(404).json({ error: "Online player not found in current world" });
    return;
  }
  if (target.userId === userId) {
    res.status(400).json({ error: "Cannot kick yourself" });
    return;
  }

  const kicked = onlinePlayers.kick(targetPlayerId, "kicked_by_world_owner");
  res.json({ ok: kicked, playerId: targetPlayerId });
});

router.post("/map/travel", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const targetMapId = typeof req.body?.targetMapId === "string" ? req.body.targetMapId : "";
  if (!targetMapId) {
    res.status(400).json({ error: "targetMapId is required" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    const result = appContext.worldManager.travelToMap(targetMapId);
    appContext.resourceManager.rediscoverForMap(targetMapId);
    appContext.syncActiveMapRuntimeResources();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/map/enter", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const targetMapId = typeof req.body?.mapId === "string"
    ? req.body.mapId
    : typeof req.body?.targetMapId === "string"
      ? req.body.targetMapId
      : "";
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const userId = getRequestUserId(req);
  if (!targetMapId) {
    res.status(400).json({ error: "mapId is required" });
    return;
  }
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!appContext.playerManager.getPlayer(userCharacterId, userId)) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    const before = appContext.playerManager.getPlayer(userCharacterId, userId);
    const oldPresence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const wasOnline = before?.isOnline === true;
    const travel = appContext.worldManager.travelToMap(targetMapId);
    appContext.resourceManager.rediscoverForMap(targetMapId);
    appContext.syncActiveMapRuntimeResources();
    const character = appContext.playerManager.enterActiveMap(userCharacterId, userId);
    if (!character) throw new Error("User character not found after map enter");
    const presence = appContext.playerManager.getPlayerPresence(character.id);
    appContext.mapRuntimeRegistry.ensureRuntime({
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    });
    appContext.eventBus.emit("user_character_presence_changed", {
      playerId: character.id,
      oldPresence,
      newPresence: presence,
      player: character,
      wasOnline,
    });
    res.json({
      ok: true,
      userId,
      travel,
      character: {
        id: character.id,
        name: character.name,
        worldId: presence.worldId,
        timelineId: presence.timelineId,
        currentMapId: presence.currentMapId,
        location: character.location,
        mainAreaPointId: character.mainAreaPointId,
        x: character.x,
        y: character.y,
        appearance: character.appearance,
        inventory: character.inventory,
        online: character.isOnline,
      },
      presence,
      requiresReload: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/enter", (req, res) => {
  const worldId = typeof req.body?.worldId === "string" ? req.body.worldId : "";
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const userId = getRequestUserId(req);
  if (!worldId) {
    res.status(400).json({ error: "worldId is required" });
    return;
  }
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }

  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  if (!canUserAccessWorld(world, userId)) {
    res.status(403).json({ error: "You do not have access to this world" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    const currentWorldDir = appContext.getWorldDir();
    const alreadyActiveWorld =
      typeof currentWorldDir === "string"
      && path.resolve(currentWorldDir) === path.resolve(world.dir);
    const isWorldManager = canUserManageWorld(world, userId);
    if (!alreadyActiveWorld || isWorldManager) {
      appContext.switchWorld(world.dir, userId);
    }

    const mapsState = appContext.worldManager.getWorldMapsState();
    const defaultMapId =
      mapsState.maps.find((map) => map.id === "map_origin" && map.status === "available")?.id
      ?? mapsState.maps.find((map) => map.status === "available")?.id
      ?? mapsState.activeMapId;

    if (!appContext.playerManager.getPlayer(userCharacterId, userId)) {
      res.status(404).json({ error: "User character not found in selected world" });
      return;
    }

    const before = appContext.playerManager.getPlayer(userCharacterId, userId);
    const oldPresence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const wasOnline = before?.isOnline === true;
    const travel = appContext.worldManager.travelToMap(defaultMapId);
    appContext.resourceManager.rediscoverForMap(defaultMapId);
    appContext.syncActiveMapRuntimeResources();
    const character = appContext.playerManager.enterActiveMap(userCharacterId, userId);
    if (!character) throw new Error("User character not found after world enter");
    const presence = appContext.playerManager.getPlayerPresence(character.id);
    appContext.mapRuntimeRegistry.ensureRuntime({
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    });
    appContext.eventBus.emit("user_character_presence_changed", {
      playerId: character.id,
      oldPresence,
      newPresence: presence,
      player: character,
      wasOnline,
    });
    res.json({
      ok: true,
      userId,
      worldId: world.id,
      worldName: world.worldName,
      defaultMapId,
      travel,
      character: {
        id: character.id,
        name: character.name,
        worldId: presence.worldId,
        timelineId: presence.timelineId,
        currentMapId: presence.currentMapId,
        location: character.location,
        mainAreaPointId: character.mainAreaPointId,
        x: character.x,
        y: character.y,
        appearance: character.appearance,
        inventory: character.inventory,
        online: character.isOnline,
      },
      presence,
      requiresReload: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/dev/tick-duration", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }

  const tickDurationMinutes = Number(req.body?.tickDurationMinutes);
  if (![15, 30, 60].includes(tickDurationMinutes)) {
    res.status(400).json({ error: "tickDurationMinutes must be one of 15, 30, 60" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  appContext.setDevTickDurationMinutes(tickDurationMinutes);
  const wm = appContext.worldManager;
  res.json({
    ok: true,
    gameTime: buildWorldTimeInfo(wm.getCurrentTime(), wm.getSceneConfig()),
    sceneConfig: wm.getSceneConfig(),
    sceneRuntime: buildSceneRuntimeInfo(wm.getSceneConfig()),
  });
});

router.get("/worlds", (req, res) => {
  const currentWorldDir = appContext.getWorldDir();
  const currentWorldId = currentWorldDir ? path.basename(currentWorldDir) : null;
  const userId = getRequestUserId(req);

  const mapWorld = (world: { id: string; worldName: string; dir: string; source: string; ownerUserId?: string; visibility?: string }) => ({
    id: world.id,
    worldName: world.worldName,
    source: world.source,
    ownerUserId: world.ownerUserId,
    visibility: world.visibility,
    canManage: world.ownerUserId === userId,
    isCurrent: world.id === currentWorldId,
    timelineCount: appContext.timelineManager.listTimelines(world.dir, userId).length,
  });

  res.json({
    currentWorldId,
    currentTimelineId: currentWorldDir ? currentTimelineForUser(userId, currentWorldDir) : null,
    worlds: listGeneratedWorlds(userId).map(mapWorld),
    libraryWorlds: listLibraryWorlds(userId).map(mapWorld),
  });
});

router.post("/select", (req, res) => {
  const worldId = typeof req.body?.worldId === "string" ? req.body.worldId : "";
  if (!worldId) {
    res.status(400).json({ error: "worldId is required" });
    return;
  }

  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  const userId = getRequestUserId(req);
  if (!canUserAccessWorld(world, userId)) {
    res.status(403).json({ error: "You do not have access to this world" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  appContext.switchWorld(world.dir, userId);
  res.json({
    ok: true,
    currentWorldId: world.id,
    worldName: world.worldName,
  });
});

router.patch("/worlds/:worldId", (req, res) => {
  const worldId = String(req.params.worldId);
  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  const userId = getRequestUserId(req);
  if (!canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner can update this world" });
    return;
  }
  const visibility = req.body?.visibility;
  if (visibility !== "private" && visibility !== "unlisted" && visibility !== "public") {
    res.status(400).json({ error: "visibility must be private, unlisted, or public" });
    return;
  }
  const metadata = writeWorldAccessMetadata(world.dir, {
    ownerUserId: userId,
    visibility: visibility as WorldVisibility,
  });
  accountAssets.ensureWorldAsset({
    userId,
    worldId,
    source: "user",
    visibility: visibility as WorldVisibility,
    createdAt: metadata.createdAt,
  });
  res.json({ ok: true, worldId, metadata });
});

router.delete("/worlds/:worldId", (req, res) => {
  const worldId = String(req.params.worldId);
  if (!worldId || worldId.includes("..") || worldId.includes("/") || worldId.includes("\\")) {
    res.status(400).json({ error: "Invalid world id" });
    return;
  }

  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }

  if (world.source === "library") {
    res.status(403).json({ error: "Sample worlds cannot be deleted" });
    return;
  }
  const userId = getRequestUserId(req);
  if (!canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner can delete this world" });
    return;
  }

  const resolvedDir = path.resolve(world.dir);
  const resolvedRoot = path.resolve(GENERATED_WORLDS_DIR);
  if (!resolvedDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    res.status(400).json({ error: "World path is outside the generated worlds directory" });
    return;
  }

  const currentWorldDir = appContext.getWorldDir();
  if (currentWorldDir && path.resolve(currentWorldDir) === resolvedDir) {
    res.status(409).json({
      error: "Cannot delete the currently active world. Switch to another world first.",
    });
    return;
  }

  try {
    fs.rmSync(resolvedDir, { recursive: true, force: true });
    accountAssets.deleteWorldAsset(userId, worldId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to delete world: ${message}` });
    return;
  }

  res.json({ ok: true, deletedWorldId: worldId });
});

router.get("/locations", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  res.json(appContext.worldManager.getAllLocations());
});

router.get("/locations/:id/state", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const loc = appContext.worldManager.getLocation(req.params.id);
  if (!loc) {
    res.status(404).json({ error: "Location not found" });
    return;
  }

  const objects = appContext.worldManager.getLocationObjects(loc.id);
  const chars = appContext.characterManager.getCharactersAtLocation(loc.id);

  res.json({
    location: loc,
    objects: objects.map((o) => ({
      objectId: o.objectId,
      state: o.state,
      stateDescription: o.stateDescription,
      currentUsers: o.currentUsers,
    })),
    characters: chars.map((c) => ({
      id: c.profile.id,
      name: c.profile.name,
      action: c.state.currentAction,
    })),
  });
});

router.get("/global-state", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  res.json(worldStateStore.getAllGlobalState());
});

export default router;
