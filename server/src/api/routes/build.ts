import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import { generateUserCharacterAssets } from "../../core/user-character-asset-generator.js";
import type { BuildJobStatus } from "../../types/build.js";

const router = Router();
type AccountCharacterBuildJob = BuildJobStatus & {
  userId: string;
  prompt: string;
  characterId?: string;
  characterName?: string;
};

const accountCharacterJobs = new Map<string, AccountCharacterBuildJob>();

/**
 * 建造系统 API。
 *
 * 账号说明：资源、用户角色、背包和生成资产都归属当前登录账号。地图节点和
 * 摆放位置属于当前 world/timeline/map 运行态。
 */

/**
 * GET /build/state
 * 返回：全局资源、建造价格、资源点列表。
 * playerState 仅为兼容客户端类型的占位（移动/位置由联机系统管理）。
 */
router.get("/state", (req, res) => {
  const userId = getRequestUserId(req);
  const rm = appContext.resourceManager;
  const resources = rm.getResourceAmount(userId);
  const center = appContext.worldManager.getMainAreaCenterPixel();

  res.json({
    resources,
    playerState: {
      id: "player",
      name: "共享资源",
      pixelX: center.x,
      pixelY: center.y,
      resources,
      isMoving: false,
    },
    costs: rm.getBuildCosts(),
    resourceNodes: rm.getAllResourceNodes(),
    worldMaps: appContext.worldManager.getWorldMapsState(),
    mapRuntimes: appContext.mapRuntimeRegistry.getRuntimesForWorld(
      appContext.getWorldDir()?.split(/[\\/]/).pop() ?? "",
      appContext.timelineManager.getCurrentTimelineId() ?? undefined,
    ),
  });
});

/**
 * POST /build/collect  body: { objectId, userCharacterId? }
 * 采集资源到全局共享池。带 userCharacterId 时会按 PresenceScope 校验资源点归属。
 */
router.post("/collect", (req, res) => {
  const objectId = typeof req.body?.objectId === "string" ? req.body.objectId : "";
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const userId = getRequestUserId(req);
  if (!objectId) {
    res.status(400).json({ success: false, error: "objectId is required" });
    return;
  }

  const rm = appContext.resourceManager;
  let amountNode = rm.getResourceNode(objectId);
  let scope: { worldId: string; timelineId: string; mapId: string } | null = null;

  if (userCharacterId) {
    const character = appContext.playerManager.getPlayer(userCharacterId, userId);
    if (!character) {
      res.status(404).json({ success: false, error: "User character not found" });
      return;
    }
    const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
    scope = {
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    };
    appContext.mapRuntimeRegistry.ensureRuntime(scope);
    const scopedNode = appContext.mapRuntimeRegistry.getResourceNode(scope, objectId);
    if (!scopedNode) {
      res.status(404).json({
        success: false,
        resources: rm.getResourceAmount(userId),
        error: `Resource node not found in current map runtime: ${objectId}`,
      });
      return;
    }
    amountNode = scopedNode;
  }

  const result = rm.collectResource(userCharacterId || "player", objectId, userId);
  res.json({
    success: result.success,
    resources: result.newAmount,
    amount: result.success ? amountNode?.resourcePerClick ?? 0 : 0,
    reason: result.reason,
    scope,
  });
});

/**
 * POST /build/character  body: { prompt }
 * 花费账号资源生成账号用户角色（异步 job）。
 */
router.post("/character", (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const userId = getRequestUserId(req);
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

  const spendResult = rm.spendResources(userId, costs.character);
  if (!spendResult.success) {
    res.status(400).json({
      error: spendResult.reason,
      required: costs.character,
      current: spendResult.newAmount,
    });
    return;
  }

  const jobId = `account_char_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job: AccountCharacterBuildJob = {
    jobId,
    userId,
    prompt,
    status: "running",
    progress: 0,
    message: "账号角色生成任务已开始",
    createdAt: Date.now(),
  };
  accountCharacterJobs.set(jobId, job);
  void runAccountCharacterBuildJob(jobId, userId, prompt, costs.character);
  res.json({ ok: true, jobId });
});

/**
 * GET /build/character/jobs/:jobId
 */
router.get("/character/jobs/:jobId", (req, res) => {
  const userId = getRequestUserId(req);
  const job = accountCharacterJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.userId !== userId) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const { prompt: _prompt, userId: _userId, ...safeJob } = job;
  void _prompt;
  void _userId;
  res.json(safeJob);
});

async function runAccountCharacterBuildJob(
  jobId: string,
  userId: string,
  prompt: string,
  cost: number,
): Promise<void> {
  const job = accountCharacterJobs.get(jobId);
  if (!job) return;
  const name = prompt.slice(0, 24) || "我的角色";
  let characterId: string | null = null;
  try {
    job.progress = 10;
    job.message = "创建账号角色资产...";
    const state = appContext.playerManager.createUserCharacter(name, userId);
    characterId = state.id;
    job.characterId = state.id;
    job.characterName = state.name;

    job.progress = 25;
    job.message = "生成角色素材...";
    const result = await generateUserCharacterAssets({
      userCharacterId: state.id,
      name: state.name,
      prompt,
      worldVisualContext: appContext.worldManager.getWorldDescription() || "",
    });

    job.progress = 85;
    job.message = "保存账号角色素材...";
    appContext.playerManager.updatePlayer(state.id, {
      appearance: result.appearance,
    });
    const created = appContext.playerManager.getPlayer(state.id, userId);

    job.status = "done";
    job.progress = 100;
    job.message = `账号角色「${created?.name ?? state.name}」已生成`;
    job.finishedAt = Date.now();
    job.requiresReload = false;
    (job as AccountCharacterBuildJob & { result?: unknown }).result = {
      characterId: state.id,
      characterName: created?.name ?? state.name,
      assetUrl: result.appearance.spriteUrl,
    };
  } catch (error) {
    if (characterId) {
      appContext.playerManager.deleteUserCharacter(characterId, userId);
    }
    appContext.resourceManager.addResources(userId, cost);
    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
    job.message = "账号角色生成失败，资源已退还";
    job.finishedAt = Date.now();
  }
}

/**
 * POST /build/map/expand  body: { prompt: string }
 * 生成独立地图节点（异步 job）。新地图通过地图 UI 传送进入，不做方向扩展或边界拼接。
 */
router.post("/map/expand", (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const userId = getRequestUserId(req);

  const allowedFields = new Set(["prompt"]);
  const unsupportedField = Object.keys(req.body ?? {}).find((key) => !allowedFields.has(key));
  if (unsupportedField) {
    res.status(400).json({
      error: `Unsupported map expansion request field: ${unsupportedField}`,
    });
    return;
  }

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

  const spendResult = rm.spendResources(userId, costs.mapExpand);
  if (!spendResult.success) {
    res.status(400).json({
      error: spendResult.reason,
      required: costs.mapExpand,
      current: spendResult.newAmount,
    });
    return;
  }

  try {
    const { jobId } = appContext.mapExpander.startExpandJob({ prompt, ownerUserId: userId });
    res.json({ ok: true, jobId });
  } catch (err) {
    // 启动失败，退还资源
    rm.addResources(userId, costs.mapExpand);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /build/map/jobs/:jobId
 */
router.get("/map/jobs/:jobId", (req, res) => {
  const job = appContext.mapExpander.getJobStatus(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

export default router;
