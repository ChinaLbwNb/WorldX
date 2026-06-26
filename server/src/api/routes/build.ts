import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import type { BuildJobStatus } from "../../types/build.js";

const router = Router();

/**
 * GET /build/state
 * 返回建造系统状态：资源、玩家状态、建造价格
 */
router.get("/state", (_req, res) => {
  const rm = appContext.resourceManager;
  const pm = appContext.playerManager;

  const resources = rm.getResourceAmount();
  const playerState = pm.getPlayerState();
  // 同步玩家资源数量
  pm.updateResources(resources);
  playerState.resources = resources;

  res.json({
    resources,
    playerState,
    costs: rm.getBuildCosts(),
    resourceNodes: rm.getAllResourceNodes(),
  });
});

/**
 * POST /build/collect
 * body: { objectId }
 * 采集资源
 */
router.post("/collect", (req, res) => {
  const objectId = typeof req.body?.objectId === "string" ? req.body.objectId : "";
  if (!objectId) {
    res.status(400).json({ success: false, error: "objectId is required" });
    return;
  }

  const rm = appContext.resourceManager;
  const pm = appContext.playerManager;
  const playerState = pm.getPlayerState();

  const result = rm.collectResource(playerState.id, objectId);

  if (result.success) {
    pm.updateResources(result.newAmount);
  }

  res.json({
    success: result.success,
    resources: result.newAmount,
    amount: result.success ? rm.getResourceNode(objectId)?.resourcePerClick ?? 0 : 0,
    reason: result.reason,
  });
});

/**
 * POST /build/player/move
 * body: { pixelX, pixelY }
 * 移动玩家
 */
router.post("/player/move", (req, res) => {
  const pixelX = Number(req.body?.pixelX);
  const pixelY = Number(req.body?.pixelY);

  if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
    res.status(400).json({
      success: false,
      error: "pixelX and pixelY must be valid numbers",
    });
    return;
  }

  const pm = appContext.playerManager;
  const result = pm.moveTo(pixelX, pixelY);

  res.json({
    success: result.success,
    playerState: result.playerState,
    reason: result.reason,
  });
});

/**
 * POST /build/character
 * body: { prompt }
 * 花资源生成新角色（异步 job，调用 character generator 管线）
 */
router.post("/character", (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  if (!appContext.hasWorld) {
    res.status(400).json({ error: "No active world" });
    return;
  }

  const rm = appContext.resourceManager;
  const costs = rm.getBuildCosts();

  // 检查资源是否足够
  const spendResult = rm.spendResources(costs.character);
  if (!spendResult.success) {
    res.status(400).json({
      error: spendResult.reason,
      required: costs.character,
      current: spendResult.newAmount,
    });
    return;
  }

  const { jobId } = appContext.characterBuilder.startBuildJob(prompt);
  res.json({ jobId });
});

/**
 * GET /build/character/jobs/:jobId
 * 查询角色生成进度
 */
router.get("/character/jobs/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = appContext.characterBuilder.getJobStatus(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(job);
});

/**
 * POST /build/map/expand
 * body: { direction: "north"|"south"|"east"|"west" }
 * 扩展地图（异步 job，调用 MapExpander）
 */
router.post("/map/expand", (req, res) => {
  const direction = req.body?.direction as string;
  const validDirections = ["north", "south", "east", "west"];

  if (!validDirections.includes(direction)) {
    res.status(400).json({
      error: `direction must be one of: ${validDirections.join(", ")}`,
    });
    return;
  }

  if (!appContext.hasWorld) {
    res.status(400).json({ error: "No active world" });
    return;
  }

  const rm = appContext.resourceManager;
  const costs = rm.getBuildCosts();

  // 检查资源是否足够
  const spendResult = rm.spendResources(costs.mapExpand);
  if (!spendResult.success) {
    res.status(400).json({
      error: spendResult.reason,
      required: costs.mapExpand,
      current: spendResult.newAmount,
    });
    return;
  }

  try {
    const { jobId } = appContext.mapExpander.startExpandJob(
      direction as "north" | "south" | "east" | "west",
    );
    res.json({ jobId });
  } catch (err) {
    // 启动失败，退还资源
    rm.addResources(costs.mapExpand);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /build/map/jobs/:jobId
 * 查询地图扩展进度
 */
router.get("/map/jobs/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = appContext.mapExpander.getJobStatus(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(job);
});

export default router;
