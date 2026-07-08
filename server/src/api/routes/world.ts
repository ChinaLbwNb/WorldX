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
import * as authStore from "../../store/auth-store.js";
import { onlinePlayers } from "../../services/online-players.js";
import { isMultiplayerMode } from "../../utils/app-mode.js";
import {
  GENERATED_WORLDS_DIR,
  LIBRARY_WORLDS_DIR,
  listGeneratedWorlds,
  listLibraryWorlds,
  findWorldById,
  canUserAccessWorld,
  canUserManageWorld,
  canUserOwnWorld,
  writeWorldAccessMetadata,
  getUserWorldRole,
  type WorldVisibility,
} from "../../utils/world-directories.js";
import { recordTutorialTaskEvent } from "../../store/tutorial-task-store.js";

const router = Router();

function requireMultiplayerMode(res: Response): boolean {
  if (isMultiplayerMode) return true;
  res.status(404).json({ error: "API route not found in classic mode" });
  return false;
}

const worldInvites = new Map<string, {
  id: string;
  inviterUserId: string;
  inviterPlayerId: string;
  inviterName: string;
  targetUserId: string;
  targetPlayerId: string;
  worldId: string;
  worldName: string;
  role: accountAssets.WorldMemberRole;
  createdAt: number;
  expiresAt: number;
}>();
const WORLD_INVITE_TTL_MS = 60_000;

function rejectIfSimulationBusy(res: Response): boolean {
  if (!isSimulationBusy()) return false;
  res.status(409).json({
    error: getSimulationBusyMessage(),
    activeSimulationTicks: getActiveSimulationTicks(),
    canSwitchContext: false,
  });
  return true;
}

function isLibraryWorldDir(worldDir: string): boolean {
  return findWorldById(path.basename(worldDir))?.source === "library";
}

function getTimelineMetaForUser(worldDir: string, timelineId: string | null | undefined, userId: string) {
  if (!timelineId) return null;
  return appContext.timelineManager
    .listTimelines(worldDir, isLibraryWorldDir(worldDir) ? undefined : userId)
    .find((timeline) => timeline.id === timelineId) ?? null;
}

function resolveUserCharacterWorldContext(req: any, res: Response): {
  userId: string;
  userCharacterId: string;
  world: NonNullable<ReturnType<typeof findWorldById>>;
  presence: ReturnType<typeof appContext.playerManager.getPlayerPresence>;
} | null {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.query?.userCharacterId === "string"
    ? req.query.userCharacterId
    : typeof req.body?.userCharacterId === "string"
      ? req.body.userCharacterId
      : "";
  if (!userCharacterId) return null;
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
  return { userId, userCharacterId, world, presence };
}

function pruneExpiredWorldInvites(): void {
  const now = Date.now();
  for (const [id, invite] of worldInvites) {
    if (invite.expiresAt <= now) {
      worldInvites.delete(id);
    }
  }
}

function makeInviteId(): string {
  return `world_invite_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

router.get("/time", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const scoped = resolveUserCharacterWorldContext(req, res);
  if (scoped) {
    const timeline = getTimelineMetaForUser(scoped.world.dir, scoped.presence.timelineId, scoped.userId);
    const worldInfo = appContext.mapPackageLoader.getWorldPackageInfo(
      scoped.world.dir,
      scoped.presence.currentMapId,
      {
        timelineId: scoped.presence.timelineId,
        timelineTickCount: timeline?.tickCount ?? 0,
      },
    );
    res.json(buildWorldTimeInfo(timeline?.lastGameTime ?? { day: 1, tick: 0 }, worldInfo.sceneConfig));
    return;
  }
  res.json(buildWorldTimeInfo(appContext.worldManager.getCurrentTime()));
});

function currentTimelineForUser(userId: string | undefined, worldDir: string): string | null {
  const timelines = appContext.timelineManager.listTimelines(worldDir, userId);
  const worldId = path.basename(worldDir);
  const activePresenceTimeline = userId
    ? appContext.playerManager
      .getAllPlayers(userId)
      .map((character) => appContext.playerManager.getPlayerPresence(character.id))
      .find((presence) => (
        presence.worldId === worldId
        && timelines.some((timeline) => timeline.id === presence.timelineId)
      ))
    : undefined;
  if (activePresenceTimeline) return activePresenceTimeline.timelineId;
  const current = appContext.timelineManager.getCurrentTimelineId();
  if (current && timelines.some((timeline) => timeline.id === current)) return current;
  return timelines[0]?.id ?? null;
}

function currentPublicWorldTimeline(world: NonNullable<ReturnType<typeof findWorldById>>): string | null {
  const timelines = appContext.timelineManager.listTimelines(world.dir);
  const timelineIds = new Set(timelines.map((timeline) => timeline.id));
  const onlineTimeline = onlinePlayers
    .list({ worldId: world.id })
    .find((player) => timelineIds.has(player.timelineId))?.timelineId;
  if (onlineTimeline) return onlineTimeline;
  return currentTimelineForUser(undefined, world.dir);
}

function resolveTimelineForWorldEntry(
  world: NonNullable<ReturnType<typeof findWorldById>>,
  userId: string,
): string {
  if (world.source === "library") {
    let timelineId = currentPublicWorldTimeline(world);
    if (!timelineId) {
      timelineId = appContext.timelineManager.createTimeline(world.dir);
    }
    return timelineId;
  }
  const configuredOwnerExists = world.ownerUserId
    && world.ownerUserId !== "system"
    && authStore.getUserById(world.ownerUserId);
  const timelineOwnerId = configuredOwnerExists
    ? world.ownerUserId
    : userId;
  let timelineId = currentTimelineForUser(timelineOwnerId, world.dir);
  if (!timelineId) {
    timelineId = appContext.timelineManager.createTimeline(world.dir, timelineOwnerId);
  }
  accountAssets.ensureTimelineAsset({
    userId,
    worldId: world.id,
    timelineId,
  });
  return timelineId;
}

router.get("/info", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const userId = getRequestUserId(req);
  const scoped = resolveUserCharacterWorldContext(req, res);
  if (scoped) {
    const timeline = getTimelineMetaForUser(scoped.world.dir, scoped.presence.timelineId, userId);
    res.json(appContext.mapPackageLoader.getWorldPackageInfo(
      scoped.world.dir,
      scoped.presence.currentMapId,
      {
        timelineId: scoped.presence.timelineId,
        timelineTickCount: timeline?.tickCount ?? 0,
      },
    ));
    return;
  }
  const wm = appContext.worldManager;
  const currentWorldDir = appContext.getWorldDir();
  res.json({
    worldName: wm.getWorldName(),
    worldDescription: wm.getWorldDescription(),
    originalPrompt: wm.getOriginalPrompt(),
    currentWorldId: currentWorldDir ? path.basename(currentWorldDir) : null,
    currentTimelineId: currentWorldDir
      ? currentTimelineForUser(isLibraryWorldDir(currentWorldDir) ? undefined : userId, currentWorldDir)
      : null,
    sceneConfig: wm.getSceneConfig(),
    sceneRuntime: buildSceneRuntimeInfo(wm.getSceneConfig()),
    worldActions: wm.getWorldActions(),
    mainAreaPoints: wm.getMainAreaPoints(),
    worldSize: wm.getWorldSize(),
    mainAreaDialogueRadiusPx: wm.getMainAreaDialogueDistanceThreshold(),
    timelineTickCount: appContext.timelineManager.getTickCount(),
  });
});

router.get("/maps", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.query.userCharacterId === "string" ? req.query.userCharacterId : "";
  if (userCharacterId) {
    const character = appContext.playerManager.getPlayer(userCharacterId, userId);
    if (!character) {
      res.status(404).json({ error: "User character not found" });
      return;
    }
    const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const world = findWorldById(presence.worldId);
    if (!world) {
      res.status(404).json({ error: "World not found for character presence" });
      return;
    }
    if (!canUserAccessWorld(world, userId)) {
      res.status(403).json({ error: "You do not have access to this world" });
      return;
    }
    res.json({
      ...appContext.mapPackageLoader.getMapNodesState(world.dir, presence.currentMapId),
      mapRuntimes: appContext.mapRuntimeRegistry.getRuntimesForWorld(
        presence.worldId,
        presence.timelineId,
      ),
    });
    return;
  }
  const worldId = appContext.getWorldDir()?.split(/[\\/]/).pop() ?? "";
  res.json({
    ...appContext.worldManager.getMapNodesState(),
    mapRuntimes: appContext.mapRuntimeRegistry.getRuntimesForWorld(
      worldId,
      appContext.timelineManager.getCurrentTimelineId() ?? undefined,
    ),
  });
});

router.get("/online", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const requestedCharacterId = typeof req.query.userCharacterId === "string" ? req.query.userCharacterId : "";
  const userId = getRequestUserId(req);
  const requestedCharacter = requestedCharacterId
    ? appContext.playerManager.getPlayer(requestedCharacterId, userId)
    : null;
  if (requestedCharacterId && !requestedCharacter) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  const requestedPresence = requestedCharacterId
    ? appContext.playerManager.getPlayerPresence(requestedCharacterId)
    : null;
  const currentWorldDir = appContext.getWorldDir();
  const worldId = requestedPresence?.worldId ?? (currentWorldDir ? path.basename(currentWorldDir) : "");
  const timelineId = requestedPresence?.timelineId ?? appContext.timelineManager.getCurrentTimelineId() ?? "";
  const activeMapId = requestedPresence?.currentMapId ?? appContext.worldManager.getActiveMapId();
  const world = worldId ? findWorldById(worldId) : null;
  const players = onlinePlayers.list({ worldId, timelineId }).map((player) => ({
    ...player,
    isSelf: player.userId === userId,
    isCurrentMap: player.mapId === activeMapId,
  }));
  const allPlayers = onlinePlayers.list().map((player) => ({
    ...player,
    isSelf: player.userId === userId,
    isCurrentMap: player.worldId === worldId && player.timelineId === timelineId && player.mapId === activeMapId,
  }));
  res.json({
    worldId,
    timelineId,
    activeMapId,
    canManage: world ? canUserManageWorld(world, userId) : false,
    players,
    allPlayers,
  });
});

router.post("/online/invite", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
  pruneExpiredWorldInvites();
  const scoped = resolveUserCharacterWorldContext(req, res);
  if (!scoped) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!canUserManageWorld(scoped.world, scoped.userId)) {
    res.status(403).json({ error: "Only the world owner or admin can invite online players" });
    return;
  }

  const targetPlayerId = typeof req.body?.targetPlayerId === "string" ? req.body.targetPlayerId.trim() : "";
  const role = accountAssets.normalizeWorldMemberRole(req.body?.role ?? "viewer");
  if (!targetPlayerId) {
    res.status(400).json({ error: "targetPlayerId is required" });
    return;
  }
  const target = onlinePlayers.get(targetPlayerId);
  if (!target) {
    res.status(404).json({ error: "Target player is not online" });
    return;
  }
  if (target.userId === scoped.userId) {
    res.status(400).json({ error: "Cannot invite yourself" });
    return;
  }
  if (target.worldId === scoped.world.id) {
    res.status(400).json({ error: "Target player is already in this world" });
    return;
  }

  const inviter = onlinePlayers.get(scoped.userCharacterId);
  const invite = {
    id: makeInviteId(),
    inviterUserId: scoped.userId,
    inviterPlayerId: scoped.userCharacterId,
    inviterName: inviter?.playerName || "世界房主",
    targetUserId: target.userId,
    targetPlayerId: target.playerId,
    worldId: scoped.world.id,
    worldName: scoped.world.worldName,
    role,
    createdAt: Date.now(),
    expiresAt: Date.now() + WORLD_INVITE_TTL_MS,
  };
  worldInvites.set(invite.id, invite);
  const sent = onlinePlayers.send(target.playerId, {
    type: "world_invite_received",
    data: {
      id: invite.id,
      inviterUserId: invite.inviterUserId,
      inviterName: invite.inviterName,
      worldId: invite.worldId,
      worldName: invite.worldName,
      role: invite.role,
      expiresAt: invite.expiresAt,
    },
  });
  if (!sent) {
    worldInvites.delete(invite.id);
    res.status(404).json({ error: "Target player is not online" });
    return;
  }
  res.json({ ok: true, inviteId: invite.id, targetPlayerId: target.playerId, expiresAt: invite.expiresAt });
});

router.post("/online/invites/:inviteId/respond", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
  pruneExpiredWorldInvites();
  const inviteId = String(req.params.inviteId);
  const accepted = req.body?.accepted === true;
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId.trim() : "";
  const userId = getRequestUserId(req);
  const invite = worldInvites.get(inviteId);
  if (!invite) {
    res.status(404).json({ error: "Invite not found or expired" });
    return;
  }
  if (invite.targetUserId !== userId) {
    res.status(403).json({ error: "This invite belongs to another account" });
    return;
  }
  worldInvites.delete(inviteId);

  if (!accepted) {
    onlinePlayers.send(invite.inviterPlayerId, {
      type: "world_invite_declined",
      data: { inviteId, targetPlayerId: invite.targetPlayerId },
    });
    res.json({ ok: true, accepted: false });
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
  const world = findWorldById(invite.worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  accountAssets.ensureWorldMember({
    worldId: invite.worldId,
    userId,
    role: invite.role,
    invitedByUserId: invite.inviterUserId,
  });
  accountAssets.ensureWorldAsset({
    userId,
    worldId: invite.worldId,
    source: "user",
    visibility: world.visibility,
  });
  onlinePlayers.send(invite.inviterPlayerId, {
    type: "world_invite_accepted",
    data: { inviteId, targetPlayerId: invite.targetPlayerId, targetUserId: userId },
  });
  res.json({
    ok: true,
    accepted: true,
    worldId: invite.worldId,
    worldName: invite.worldName,
    role: invite.role,
  });
});

router.post("/online/kick", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const targetPlayerId = typeof req.body?.playerId === "string" ? req.body.playerId : "";
  if (!targetPlayerId) {
    res.status(400).json({ error: "playerId is required" });
    return;
  }

  const target = onlinePlayers.get(targetPlayerId);
  if (!target) {
    res.status(404).json({ error: "Online player not found" });
    return;
  }
  const worldId = target.worldId;
  const world = worldId ? findWorldById(worldId) : null;
  const userId = getRequestUserId(req);
  if (!world || !canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner or admin can kick online players" });
    return;
  }

  if (target.userId === userId) {
    res.status(400).json({ error: "Cannot kick yourself" });
    return;
  }
  if (target.userId === world.ownerUserId) {
    res.status(403).json({ error: "World owner cannot be kicked" });
    return;
  }

  const kicked = onlinePlayers.kick(targetPlayerId, "kicked_by_world_manager");
  accountAssets.removeWorldMember(worldId, target.userId);
  res.json({ ok: kicked, playerId: targetPlayerId });
});

router.post("/map/enter", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
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
    const character = appContext.playerManager.getPlayer(userCharacterId, userId);
    if (!character) throw new Error("User character not found after map enter");
    const presence = appContext.playerManager.getPlayerPresence(character.id);
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
      playerId: character.id,
      oldPresence,
      newPresence: presence,
      player: character,
      wasOnline,
    });
    recordTutorialTaskEvent(userId, "enter_world");
    res.json({
      ok: true,
      userId,
      travel: {
        activeMapId: targetMapId,
        targetMapId,
        spawn: { x: spawn.x, y: spawn.y },
        requiresReload: true,
      },
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
  if (!requireMultiplayerMode(res)) return;
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

  let world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  if (!canUserAccessWorld(world, userId)) {
    res.status(403).json({ error: "You do not have access to this world" });
    return;
  }
  if (
    !canUserManageWorld(world, userId)
    && world.source !== "library"
    && !accountAssets.getWorldMemberRole(world.id, userId)
  ) {
    accountAssets.ensureWorldMember({
      worldId: world.id,
      userId,
      role: "viewer",
      invitedByUserId: world.ownerUserId,
    });
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    const requestedWorld = world;
    // Library worlds are shared public spaces. Enter them in place; do not create
    // per-account copies, otherwise default worlds drift into duplicate states.
    const mapsState = appContext.mapPackageLoader.getMapNodesState(world.dir);
    const defaultMapId =
      mapsState.mapNodes.find((map) => map.id === "map_origin" && map.status === "available")?.id
      ?? mapsState.mapNodes.find((map) => map.status === "available")?.id
      ?? mapsState.activeMapId;

    if (!appContext.playerManager.getPlayer(userCharacterId, userId)) {
      res.status(404).json({ error: "User character not found in selected world" });
      return;
    }

    const before = appContext.playerManager.getPlayer(userCharacterId, userId);
    const oldPresence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const wasOnline = before?.isOnline === true;
    const timelineId = resolveTimelineForWorldEntry(world, userId);
    const spawn = appContext.mapPackageLoader.getDefaultSpawnForMap(world.dir, defaultMapId);
    appContext.playerManager.updatePlayer(userCharacterId, {
      worldId: world.id,
      timelineId,
      currentMapId: defaultMapId,
      mode: "avatar",
      location: "main_area",
      mainAreaPointId: spawn.mainAreaPointId,
      x: spawn.x,
      y: spawn.y,
    });
    const character = appContext.playerManager.getPlayer(userCharacterId, userId);
    if (!character) throw new Error("User character not found after world enter");
    const presence = appContext.playerManager.getPlayerPresence(character.id);
    const scope = {
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    };
    appContext.mapRuntimeRegistry.ensureRuntime(scope);
    appContext.mapRuntimeRegistry.updateResourceNodes(
      scope,
      appContext.mapPackageLoader.discoverResourceNodes(world.dir, defaultMapId),
    );
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
      requestedWorldId: requestedWorld.id,
      privateCopy: null,
      defaultMapId,
      travel: {
        activeMapId: defaultMapId,
        targetMapId: defaultMapId,
        spawn: { x: spawn.x, y: spawn.y },
        requiresReload: true,
      },
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
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.query.userCharacterId === "string" ? req.query.userCharacterId : "";
  let currentWorldId = currentWorldDir ? path.basename(currentWorldDir) : null;
  let currentTimelineId = currentWorldDir
    ? currentTimelineForUser(isLibraryWorldDir(currentWorldDir) ? undefined : userId, currentWorldDir)
    : null;

  if (userCharacterId) {
    const character = appContext.playerManager.getPlayer(userCharacterId, userId);
    if (!character) {
      res.status(404).json({ error: "User character not found" });
      return;
    }
    const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const world = findWorldById(presence.worldId);
    if (!world) {
      res.status(404).json({ error: "World not found for character presence" });
      return;
    }
    if (!canUserAccessWorld(world, userId)) {
      res.status(403).json({ error: "You do not have access to this world" });
      return;
    }
    currentWorldId = presence.worldId;
    currentTimelineId = presence.timelineId;
  }

  const mapWorld = (world: { id: string; worldName: string; dir: string; source: string; ownerUserId?: string; visibility?: string }) => ({
    id: world.id,
    worldName: world.worldName,
    source: world.source,
    ownerUserId: world.ownerUserId,
    visibility: world.visibility,
    canManage: world.ownerUserId === userId || getUserWorldRole(world as any, userId) === "admin",
    role: getUserWorldRole(world as any, userId),
    isCurrent: world.id === currentWorldId,
    timelineCount: appContext.timelineManager
      .listTimelines(world.dir, world.source === "library" ? undefined : userId)
      .length,
  });

  res.json({
    currentWorldId,
    currentTimelineId,
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
  if (!requireMultiplayerMode(res)) return;
  const worldId = String(req.params.worldId);
  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  const userId = getRequestUserId(req);
  if (!canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner or admin can update this world" });
    return;
  }
  const visibility = req.body?.visibility;
  if (visibility !== "private" && visibility !== "unlisted" && visibility !== "public") {
    res.status(400).json({ error: "visibility must be private, unlisted, or public" });
    return;
  }
  const metadata = writeWorldAccessMetadata(world.dir, {
    ownerUserId: world.ownerUserId,
    visibility: visibility as WorldVisibility,
  });
  accountAssets.ensureWorldAsset({
    userId: metadata.ownerUserId,
    worldId,
    source: "user",
    visibility: visibility as WorldVisibility,
    createdAt: metadata.createdAt,
  });
  res.json({ ok: true, worldId, metadata });
});

router.get("/worlds/:worldId/members", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
  const worldId = String(req.params.worldId);
  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  const userId = getRequestUserId(req);
  if (!canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner or admin can view members" });
    return;
  }
  res.json({ worldId, members: accountAssets.listWorldMembers(worldId) });
});

router.post("/worlds/:worldId/members", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
  const worldId = String(req.params.worldId);
  const targetUserId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const role = accountAssets.normalizeWorldMemberRole(req.body?.role);
  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  const userId = getRequestUserId(req);
  if (!canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner or admin can add members" });
    return;
  }
  if (!targetUserId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  if (targetUserId === world.ownerUserId) {
    res.status(400).json({ error: "World owner is implicit and cannot be added as a member" });
    return;
  }
  accountAssets.ensureWorldMember({ worldId, userId: targetUserId, role, invitedByUserId: userId });
  res.json({ ok: true, worldId, member: { userId: targetUserId, role } });
});

router.delete("/worlds/:worldId/members/:userId", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
  const worldId = String(req.params.worldId);
  const targetUserId = String(req.params.userId);
  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  const userId = getRequestUserId(req);
  if (!canUserManageWorld(world, userId)) {
    res.status(403).json({ error: "Only the world owner or admin can remove members" });
    return;
  }
  if (targetUserId === userId) {
    res.status(400).json({ error: "World owner cannot remove themselves" });
    return;
  }
  accountAssets.removeWorldMember(worldId, targetUserId);
  res.json({ ok: true, worldId, removedUserId: targetUserId });
});

router.delete("/worlds/:worldId", (req, res) => {
  if (!requireMultiplayerMode(res)) return;
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
  if (!canUserOwnWorld(world, userId)) {
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

router.get("/locations", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const scoped = resolveUserCharacterWorldContext(req, res);
  if (scoped) {
    res.json(appContext.mapPackageLoader.getLocations(scoped.world.dir, scoped.presence.currentMapId));
    return;
  }
  res.json(appContext.worldManager.getAllLocations());
});

router.get("/locations/:id/state", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const scoped = resolveUserCharacterWorldContext(req, res);
  if (scoped) {
    const state = appContext.mapPackageLoader.getLocationState(
      scoped.world.dir,
      scoped.presence.currentMapId,
      req.params.id,
    );
    if (!state) {
      res.status(404).json({ error: "Location not found" });
      return;
    }
    res.json(state);
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
