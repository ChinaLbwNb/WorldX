import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import { canUserAccessWorld, canUserBuildWorld, findWorldById } from "../../utils/world-directories.js";
import type { PresenceScope } from "../../types/index.js";
import type { GeneratedWorldSummary } from "../../utils/world-directories.js";
import { recordTutorialTaskEvent } from "../../store/tutorial-task-store.js";

const router = Router();
const npcCharacterJobOwners = new Map<string, string>();

function getCharacterScope(userCharacterId: string, userId: string): PresenceScope | null {
  if (!userCharacterId) return null;
  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) return null;
  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  return {
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: presence.currentMapId,
  };
}

function getCharacterWorldScope(
  userCharacterId: string,
  userId: string,
): { scope: PresenceScope; world: GeneratedWorldSummary } | null {
  const scope = getCharacterScope(userCharacterId, userId);
  if (!scope) return null;
  const world = findWorldById(scope.worldId);
  if (!world) return null;
  return { scope, world };
}

function ensureRuntimeResourceNodes(scope: PresenceScope): void {
  const snapshot = appContext.mapRuntimeRegistry.ensureRuntime(scope);
  if (snapshot.resourceNodesReady) return;
  const world = findWorldById(scope.worldId);
  if (!world) return;
  const resourceNodes = appContext.mapPackageLoader.discoverResourceNodes(world.dir, scope.mapId);
  appContext.mapRuntimeRegistry.updateResourceNodes(scope, resourceNodes);
}

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
  const userCharacterId = typeof req.query?.userCharacterId === "string" ? req.query.userCharacterId : "";
  const characterScope = getCharacterScope(userCharacterId, userId);
  const rm = appContext.resourceManager;
  const resources = rm.getResourceAmount(userId);
  let center = appContext.worldManager.getMainAreaCenterPixel();
  let mapNodesState = appContext.worldManager.getMapNodesState();
  let resourceNodes = rm.getAllResourceNodes();
  let runtimeScope: PresenceScope | null = null;
  if (userCharacterId && !characterScope) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  if (characterScope) {
    const world = findWorldById(characterScope.worldId);
    if (!world) {
      res.status(404).json({ error: "World not found for character presence" });
      return;
    }
    if (!canUserAccessWorld(world, userId)) {
      res.status(403).json({ error: "You do not have access to this world" });
      return;
    }
    mapNodesState = appContext.mapPackageLoader.getMapNodesState(world.dir, characterScope.mapId);
    center = appContext.mapPackageLoader.getMapCenterPixel(world.dir, characterScope.mapId);
    ensureRuntimeResourceNodes(characterScope);
    const runtime = appContext.mapRuntimeRegistry.getRuntimeWithResources(characterScope);
    resourceNodes = runtime?.resourceNodes ?? [];
    runtimeScope = characterScope;
  }

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
    resourceNodes,
    mapNodes: mapNodesState,
    mapRuntimes: appContext.mapRuntimeRegistry.getRuntimesForWorld(
      runtimeScope?.worldId ?? appContext.getWorldDir()?.split(/[\\/]/).pop() ?? "",
      runtimeScope?.timelineId ?? appContext.timelineManager.getCurrentTimelineId() ?? undefined,
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
  let scopedResourceNode: typeof amountNode | null = null;
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
    const world = findWorldById(scope.worldId);
    if (!world) {
      res.status(404).json({ success: false, error: "World not found for character presence" });
      return;
    }
    if (!canUserAccessWorld(world, userId)) {
      res.status(403).json({ success: false, error: "You do not have access to collect resources in this world" });
      return;
    }
    ensureRuntimeResourceNodes(scope);
    const scopedNode = appContext.mapRuntimeRegistry.getResourceNode(scope, objectId);
    if (!scopedNode) {
      res.status(404).json({
        success: false,
        resources: rm.getResourceAmount(userId),
        error: `Resource node not found in current map runtime: ${objectId}`,
      });
      return;
    }
    scopedResourceNode = scopedNode;
    amountNode = scopedNode;
  }

  const result = scopedResourceNode
    ? rm.collectScopedResource(userCharacterId || "player", scopedResourceNode, userId)
    : rm.collectResource(userCharacterId || "player", objectId, userId);
  if (result.success) {
    recordTutorialTaskEvent(userId, "collect_resource");
  }
  res.json({
    success: result.success,
    resources: result.newAmount,
    amount: result.success ? amountNode?.resourcePerClick ?? 0 : 0,
    reason: result.reason,
    scope,
  });
});

/**
 * POST /build/character  body: { prompt, userCharacterId }
 * 花费账号资源，为当前世界生成地图 NPC（异步 job）。
 *
 * 注意：账号用户角色只允许从“我的角色”面板创建；建造面板生成的是世界内容。
 */
router.post("/character", (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId.trim() : "";
  const userId = getRequestUserId(req);
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  const scoped = getCharacterWorldScope(userCharacterId, userId);
  if (!scoped) {
    res.status(404).json({ error: "User character world presence not found" });
    return;
  }
  const { scope, world } = scoped;
  if (!world || !canUserBuildWorld(world, userId)) {
    res.status(403).json({ error: "You need builder permission to generate NPCs in this world" });
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

  let startedJobId = "";
  try {
    const worldInfo = appContext.mapPackageLoader.getWorldPackageInfo(world.dir, scope.mapId, {
      timelineId: scope.timelineId,
    });
    const result = appContext.characterBuilder.startBuildJob(prompt, {
      worldDir: world.dir,
      worldVisualContext: worldInfo.worldDescription || worldInfo.originalPrompt || "",
      failureMessage: "NPC 生成失败，资源已退还",
      onFailure: () => {
        rm.addResources(userId, costs.character);
      },
    });
    startedJobId = result.jobId;
    npcCharacterJobOwners.set(result.jobId, userId);
    res.json({ ok: true, jobId: result.jobId });
  } catch (err) {
    if (!startedJobId) {
      rm.addResources(userId, costs.character);
    }
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /build/character/jobs/:jobId
 */
router.get("/character/jobs/:jobId", (req, res) => {
  const userId = getRequestUserId(req);
  const jobOwner = npcCharacterJobOwners.get(req.params.jobId);
  const job = appContext.characterBuilder.getJobStatus(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (jobOwner !== userId) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

/**
 * POST /build/map/expand  body: { prompt: string, userCharacterId: string }
 * 生成独立地图节点（异步 job）。新地图通过地图 UI 传送进入，不做方向扩展或边界拼接。
 */
router.post("/map/expand", (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId.trim() : "";
  const userId = getRequestUserId(req);

  const allowedFields = new Set(["prompt", "userCharacterId"]);
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
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  const scoped = getCharacterWorldScope(userCharacterId, userId);
  if (!scoped) {
    res.status(404).json({ error: "User character world presence not found" });
    return;
  }
  const { scope, world } = scoped;
  if (!world || !canUserBuildWorld(world, userId)) {
    res.status(403).json({ error: "You need builder permission to generate map nodes in this world" });
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
    const { jobId } = appContext.mapExpander.startExpandJob({
      prompt,
      ownerUserId: userId,
      worldDir: world.dir,
      sourceMapId: scope.mapId,
    });
    recordTutorialTaskEvent(userId, "generate_map_node");
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
