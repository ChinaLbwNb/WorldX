import path from "node:path";
import { Router, type Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import {
  getActiveSimulationTicks,
  getSimulationBusyMessage,
  isSimulationBusy,
} from "../../services/simulation-activity.js";
import { canUserAccessWorld, findWorldById } from "../../utils/world-directories.js";

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

type TimelineRouteContext = {
  worldDir: string;
  worldId: string;
  currentTimelineId: string | null;
  currentMapId: string;
  userCharacterId: string;
};

function currentTimelineForUser(timelines: Array<{ id: string }>, preferredTimelineId?: string | null): string | null {
  if (preferredTimelineId && timelines.some((timeline) => timeline.id === preferredTimelineId)) {
    return preferredTimelineId;
  }
  const current = appContext.timelineManager.getCurrentTimelineId();
  if (current && timelines.some((timeline) => timeline.id === current)) return current;
  return timelines[0]?.id ?? null;
}

function getRequestedUserCharacterId(req: { query?: unknown; body?: unknown }): string {
  const query = req.query as Record<string, unknown> | undefined;
  const body = req.body as Record<string, unknown> | undefined;
  if (typeof query?.userCharacterId === "string") return query.userCharacterId;
  if (typeof body?.userCharacterId === "string") return body.userCharacterId;
  return "";
}

function resolveTimelineContext(req: Parameters<Parameters<typeof router.get>[1]>[0], userId: string): TimelineRouteContext | { error: string; status: number } {
  const userCharacterId = getRequestedUserCharacterId(req);
  if (userCharacterId) {
    const character = appContext.playerManager.getPlayer(userCharacterId, userId);
    if (!character) return { status: 404, error: "User character not found" };
    const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
    const world = findWorldById(presence.worldId);
    if (!world) return { status: 404, error: "World not found for character presence" };
    if (!canUserAccessWorld(world, userId)) return { status: 403, error: "You do not have access to this world" };
    return {
      worldDir: world.dir,
      worldId: world.id,
      currentTimelineId: presence.timelineId || null,
      currentMapId: presence.currentMapId,
      userCharacterId,
    };
  }

  const worldDir = appContext.getWorldDir();
  if (!worldDir) return { status: 503, error: "No world loaded" };
  return {
    worldDir,
    worldId: path.basename(worldDir),
    currentTimelineId: appContext.timelineManager.getCurrentTimelineId(),
    currentMapId: appContext.worldManager.getActiveMapId(),
    userCharacterId: "",
  };
}

function isTimelineContextError(
  context: TimelineRouteContext | { error: string; status: number },
): context is { error: string; status: number } {
  return "error" in context;
}

function timelineOwnerFilterForContext(context: TimelineRouteContext, userId: string): string | undefined {
  const world = findWorldById(context.worldId);
  return world?.source === "library" ? undefined : userId;
}

function isLibraryTimelineContext(context: TimelineRouteContext): boolean {
  return findWorldById(context.worldId)?.source === "library";
}

// GET /timelines — list timelines for current world
router.get("/", (req, res) => {
  const userId = getRequestUserId(req);
  const context = resolveTimelineContext(req, userId);
  if (isTimelineContextError(context)) {
    res.status(context.status).json({ error: context.error });
    return;
  }

  const timelines = appContext.timelineManager.listTimelines(
    context.worldDir,
    timelineOwnerFilterForContext(context, userId),
  );
  res.json({
    timelines,
    currentTimelineId: currentTimelineForUser(timelines, context.currentTimelineId),
    worldId: context.worldId,
  });
});

// GET /timelines/all — all worlds + all timelines (for management modal)
router.get("/all", (req, res) => {
  const userId = getRequestUserId(req);
  const groups = appContext.timelineManager.listAllTimelinesGrouped(userId);
  const allTimelines = groups.flatMap((group) => group.timelines);
  const context = resolveTimelineContext(req, userId);
  res.json({
    groups,
    currentTimelineId: currentTimelineForUser(
      allTimelines,
      isTimelineContextError(context) ? null : context.currentTimelineId,
    ),
  });
});

// GET /timelines/current — current timeline info
router.get("/current", (req, res) => {
  const userId = getRequestUserId(req);
  const context = resolveTimelineContext(req, userId);
  if (isTimelineContextError(context)) {
    res.status(context.status).json({ error: context.error });
    return;
  }

  const timelines = appContext.timelineManager.listTimelines(
    context.worldDir,
    timelineOwnerFilterForContext(context, userId),
  );
  const currentId = currentTimelineForUser(timelines, context.currentTimelineId);
  const current = timelines.find((t) => t.id === currentId);
  if (!current) {
    res.status(404).json({ error: "Current timeline not found" });
    return;
  }

  res.json({ timeline: current });
});

// POST /timelines — create new timeline
router.post("/", (req, res) => {
  const userId = getRequestUserId(req);
  const context = resolveTimelineContext(req, userId);
  if (isTimelineContextError(context)) {
    res.status(context.status).json({ error: context.error });
    return;
  }
  if (isLibraryTimelineContext(context)) {
    res.status(403).json({ error: "Public worlds use a single fixed timeline." });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    const isActiveWorld = appContext.getWorldDir()
      && path.resolve(appContext.getWorldDir()!) === path.resolve(context.worldDir);
    const timelineId = isActiveWorld
      ? (appContext.createNewTimeline(userId), appContext.timelineManager.getCurrentTimelineId())
      : appContext.timelineManager.createTimeline(context.worldDir, userId);
    if (context.userCharacterId && timelineId) {
      appContext.playerManager.updatePlayer(context.userCharacterId, {
        worldId: context.worldId,
        timelineId,
        currentMapId: context.currentMapId,
      });
      appContext.mapRuntimeRegistry.ensureRuntime({
        worldId: context.worldId,
        timelineId,
        mapId: context.currentMapId,
      });
    }
    res.json({
      ok: true,
      timelineId,
      worldId: context.worldId,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /timelines/:id/load — switch to this timeline
router.post("/:id/load", (req, res) => {
  const userId = getRequestUserId(req);
  const context = resolveTimelineContext(req, userId);
  if (isTimelineContextError(context)) {
    res.status(context.status).json({ error: context.error });
    return;
  }

  const timelineId = req.params.id;
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const timelines = appContext.timelineManager.listTimelines(
    context.worldDir,
    timelineOwnerFilterForContext(context, userId),
  );
  if (!timelines.find((t) => t.id === timelineId)) {
    res.status(404).json({ error: "Timeline not found" });
    return;
  }
  if (userCharacterId && !appContext.playerManager.getPlayer(userCharacterId, userId)) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    const isActiveWorld = appContext.getWorldDir()
      && path.resolve(appContext.getWorldDir()!) === path.resolve(context.worldDir);
    if (isActiveWorld) {
      appContext.switchTimeline(timelineId, userId);
    }
    let character: ReturnType<typeof appContext.playerManager.getPlayer> = null;
    let presence: { worldId: string; timelineId: string; currentMapId: string } | null = null;
    if (userCharacterId) {
      const beforePresence = appContext.playerManager.getPlayerPresence(userCharacterId);
      appContext.playerManager.updatePlayer(userCharacterId, {
        worldId: context.worldId,
        timelineId,
        currentMapId: beforePresence.currentMapId || context.currentMapId,
        mode: "avatar",
      });
      character = appContext.playerManager.getPlayer(userCharacterId, userId);
      if (character) {
        presence = appContext.playerManager.getPlayerPresence(character.id);
        appContext.mapRuntimeRegistry.ensureRuntime({
          worldId: presence.worldId,
          timelineId: presence.timelineId,
          mapId: presence.currentMapId,
        });
        appContext.eventBus.emit("user_character_presence_changed", {
          playerId: character.id,
          oldPresence: null,
          newPresence: presence,
          player: character,
          wasOnline: character.isOnline,
        });
      }
    }
    res.json({ ok: true, timelineId, character, presence });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /timelines/:id — delete a timeline from current world
router.delete("/:id", (req, res) => {
  const userId = getRequestUserId(req);
  const context = resolveTimelineContext(req, userId);
  if (isTimelineContextError(context)) {
    res.status(context.status).json({ error: context.error });
    return;
  }

  const timelineId = req.params.id;
  if (isLibraryTimelineContext(context)) {
    res.status(403).json({ error: "Public world timelines cannot be deleted." });
    return;
  }
  if (timelineId === context.currentTimelineId) {
    res.status(409).json({ error: "Cannot delete the currently active timeline." });
    return;
  }

  try {
    appContext.timelineManager.deleteTimeline(
      context.worldDir,
      timelineId,
      timelineOwnerFilterForContext(context, userId),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /timelines/:id/events — return events.jsonl content for replay
router.get("/:id/events", (req, res) => {
  const userId = getRequestUserId(req);
  const context = resolveTimelineContext(req, userId);
  if (isTimelineContextError(context)) {
    res.status(context.status).json({ error: context.error });
    return;
  }

  const timelineId = req.params.id;
  const timelines = appContext.timelineManager.listTimelines(
    context.worldDir,
    timelineOwnerFilterForContext(context, userId),
  );
  if (!timelines.find((timeline) => timeline.id === timelineId)) {
    res.status(404).json({ error: "Timeline not found" });
    return;
  }
  try {
    const frames = appContext.timelineManager.readTimelineEvents(context.worldDir, timelineId);
    res.json({ frames });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /timelines/world/:worldId/:timelineId — delete a timeline from any world
router.delete("/world/:worldId/:timelineId", (req, res) => {
  const userId = getRequestUserId(req);
  const { worldId, timelineId } = req.params;

  if (!worldId || worldId.includes("..") || worldId.includes("/")) {
    res.status(400).json({ error: "Invalid world id" });
    return;
  }

  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  if (world.source === "library") {
    res.status(403).json({ error: "Public world timelines cannot be deleted." });
    return;
  }

  const currentWorldDir = appContext.getWorldDir();
  const isCurrentWorld = currentWorldDir && path.resolve(currentWorldDir) === path.resolve(world.dir);
  if (isCurrentWorld && timelineId === appContext.timelineManager.getCurrentTimelineId()) {
    res.status(409).json({ error: "Cannot delete the currently active timeline." });
    return;
  }

  try {
    appContext.timelineManager.deleteTimeline(
      world.dir,
      timelineId,
      timelineOwnerFilterForContext(
        {
          worldDir: world.dir,
          worldId: world.id,
          currentTimelineId: null,
          currentMapId: "",
          userCharacterId: "",
        },
        userId,
      ),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
