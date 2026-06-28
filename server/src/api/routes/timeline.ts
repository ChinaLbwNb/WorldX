import path from "node:path";
import { Router, type Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import {
  getActiveSimulationTicks,
  getSimulationBusyMessage,
  isSimulationBusy,
} from "../../services/simulation-activity.js";
import { findWorldById } from "../../utils/world-directories.js";

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

function currentTimelineForUser(timelines: Array<{ id: string }>): string | null {
  const current = appContext.timelineManager.getCurrentTimelineId();
  if (current && timelines.some((timeline) => timeline.id === current)) return current;
  return timelines[0]?.id ?? null;
}

// GET /timelines — list timelines for current world
router.get("/", (req, res) => {
  const userId = getRequestUserId(req);
  const worldDir = appContext.getWorldDir();
  if (!worldDir) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }

  const timelines = appContext.timelineManager.listTimelines(worldDir, userId);
  res.json({
    timelines,
    currentTimelineId: currentTimelineForUser(timelines),
  });
});

// GET /timelines/all — all worlds + all timelines (for management modal)
router.get("/all", (req, res) => {
  const userId = getRequestUserId(req);
  const groups = appContext.timelineManager.listAllTimelinesGrouped(userId);
  const allTimelines = groups.flatMap((group) => group.timelines);
  res.json({
    groups,
    currentTimelineId: currentTimelineForUser(allTimelines),
  });
});

// GET /timelines/current — current timeline info
router.get("/current", (req, res) => {
  const userId = getRequestUserId(req);
  const worldDir = appContext.getWorldDir();
  const timelineId = appContext.timelineManager.getCurrentTimelineId();
  if (!worldDir || !timelineId) {
    res.status(503).json({ error: "No active timeline" });
    return;
  }

  const timelines = appContext.timelineManager.listTimelines(worldDir, userId);
  const currentId = currentTimelineForUser(timelines);
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
  const worldDir = appContext.getWorldDir();
  if (!worldDir) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    appContext.createNewTimeline(userId);
    res.json({
      ok: true,
      timelineId: appContext.timelineManager.getCurrentTimelineId(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /timelines/:id/load — switch to this timeline
router.post("/:id/load", (req, res) => {
  const userId = getRequestUserId(req);
  const worldDir = appContext.getWorldDir();
  if (!worldDir) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }

  const timelineId = req.params.id;
  const timelines = appContext.timelineManager.listTimelines(worldDir, userId);
  if (!timelines.find((t) => t.id === timelineId)) {
    res.status(404).json({ error: "Timeline not found" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  try {
    appContext.switchTimeline(timelineId, userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /timelines/:id — delete a timeline from current world
router.delete("/:id", (req, res) => {
  const userId = getRequestUserId(req);
  const worldDir = appContext.getWorldDir();
  if (!worldDir) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }

  const timelineId = req.params.id;
  if (timelineId === appContext.timelineManager.getCurrentTimelineId()) {
    res.status(409).json({ error: "Cannot delete the currently active timeline." });
    return;
  }

  try {
    appContext.timelineManager.deleteTimeline(worldDir, timelineId, userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /timelines/:id/events — return events.jsonl content for replay
router.get("/:id/events", (req, res) => {
  const userId = getRequestUserId(req);
  const worldDir = appContext.getWorldDir();
  if (!worldDir) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }

  const timelineId = req.params.id;
  const timelines = appContext.timelineManager.listTimelines(worldDir, userId);
  if (!timelines.find((timeline) => timeline.id === timelineId)) {
    res.status(404).json({ error: "Timeline not found" });
    return;
  }
  try {
    const frames = appContext.timelineManager.readTimelineEvents(worldDir, timelineId);
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

  const currentWorldDir = appContext.getWorldDir();
  const isCurrentWorld = currentWorldDir && path.resolve(currentWorldDir) === path.resolve(world.dir);
  if (isCurrentWorld && timelineId === appContext.timelineManager.getCurrentTimelineId()) {
    res.status(409).json({ error: "Cannot delete the currently active timeline." });
    return;
  }

  try {
    appContext.timelineManager.deleteTimeline(world.dir, timelineId, userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
