import fs from "node:fs";
import path from "node:path";
import type {
  LocationConfig,
  MainAreaPointConfig,
  ObjectConfig,
  ObjectRuntimeState,
  InteractionConfig,
  WorldActionConfig,
  WorldSizeConfig,
  GameTime,
  DialogueSession,
  SceneConfig,
  WorldMapNodeConfig,
  WorldMapLinkConfig,
  MapSpawnPointConfig,
  WorldConfig,
} from "../types/index.js";
import { loadWorldConfig, loadSceneConfig, setWorldDir, getWorldDir, reloadConfigs } from "../utils/config-loader.js";
import { setSceneConfig, isSceneComplete, getTicksPerScene } from "../utils/time-helpers.js";
import * as worldState from "../store/world-state-store.js";
import * as snapshotStore from "../store/snapshot-store.js";
import type { SnapshotMeta } from "../store/snapshot-store.js";

const DIALOGUE_SESSION_PREFIX = "dialogue_session:";
const MAIN_AREA_DIALOGUE_MAX_GRAPH_STEPS = Math.max(
  1,
  parseInt(process.env.MAIN_AREA_DIALOGUE_MAX_GRAPH_STEPS || "2", 10),
);
const MIN_PREFERRED_MAIN_AREA_COMPONENT_SIZE = 6;
const MIN_PREFERRED_MAIN_AREA_COMPONENT_RATIO = 0.5;
const MIN_POINT_SPACING_TILES = parseInt(process.env.MAIN_AREA_POINT_MIN_TILES || "6", 10);
const MAX_POINT_SPACING_TILES = parseInt(process.env.MAIN_AREA_POINT_MAX_TILES || "14", 10);
const MAIN_AREA_SPAWN_EDGE_PADDING_TILE_MULTIPLIER = 3;
const MAIN_AREA_SPAWN_EDGE_PADDING_RATIO = 0.03;
const MAIN_AREA_SPAWN_INTERIOR_POOL_RATIO = 0.5;
const MAIN_AREA_POINT_ADJACENCY_MULTIPLIER = parseFloat(
  process.env.MAIN_AREA_POINT_ADJACENCY_MULTIPLIER || "3",
);
const MAIN_AREA_POINT_PATH_DETOUR_MULTIPLIER = parseFloat(
  process.env.MAIN_AREA_POINT_PATH_DETOUR_MULTIPLIER || "2.5",
);
const ORIGIN_MAP_ID = "map_origin";

export interface TickAdvanceResult {
  previousTime: GameTime;
  currentTime: GameTime;
  didAdvanceDay: boolean;
  cycleTicks: number;
}

export type MainAreaZone = "东" | "南" | "西" | "北" | "中";
export interface WorldMapsState {
  currentWorldId: string;
  activeMapId: string;
  maps: WorldMapNodeConfig[];
  links: WorldMapLinkConfig[];
  currentPlayerMapId: string;
}

export class WorldManager {
  private locationConfigs: LocationConfig[] = [];
  private mainAreaPoints: MainAreaPointConfig[] = [];
  private preferredMainAreaPointIds: Set<string> | null = null;
  private mainAreaZoneMap: Map<string, MainAreaZone> = new Map();
  private worldActions: WorldActionConfig[] = [];
  private worldSize: WorldSizeConfig | null = null;
  private collisionData: number[] | null = null;
  private collisionGridWidth = 0;
  private collisionGridHeight = 0;
  private sceneConfig!: SceneConfig;
  private worldName = "unknown";
  private worldDescription = "";
  private worldSocialContext = "";
  private contentLanguage: "zh" | "en" = "zh";
  private originalPrompt = "";
  private activeMapId = ORIGIN_MAP_ID;
  private worldMaps: WorldMapNodeConfig[] = [];
  private mapLinks: WorldMapLinkConfig[] = [];
  private mapSpawnPoints: MapSpawnPointConfig[] = [];

  constructor() {}

  initialize(worldDirPath?: string): void {
    if (worldDirPath) {
      setWorldDir(worldDirPath);
    }
    this.ensureMapWorldInitialized();
    const config = loadWorldConfig();
    this.activeMapId = this.resolveActiveMapId(config);
    this.worldMaps = normalizeWorldMaps(config.worldMaps, config.worldName ?? "初始地图");
    this.mapLinks = normalizeMapLinks(config.mapLinks);
    this.mapSpawnPoints = normalizeMapSpawnPoints(config.mapSpawnPoints);
    const activeFragment = this.loadActiveMapFragment();
    const runtimeConfig = mergeWorldConfigForActiveMap(config, activeFragment);
    this.locationConfigs = normalizeLocations(
      runtimeConfig.locations,
      runtimeConfig.worldName ?? "main_area",
      runtimeConfig.worldDescription ?? "",
    );
    this.mainAreaPoints = rebuildMainAreaPointAdjacencyFromTmj(
      normalizeMainAreaPoints(runtimeConfig.mainAreaPoints),
      this.getActiveMapDir(),
    );
    this.preferredMainAreaPointIds = getLargestMainAreaPointComponent(this.mainAreaPoints);
    this.mainAreaZoneMap = computeMainAreaZones(this.mainAreaPoints);
    this.worldSize = normalizeWorldSize(runtimeConfig.worldSize) ?? inferWorldSizeFromWorldDir(this.getActiveMapDir());
    this.loadCollisionGrid();
    this.worldActions = runtimeConfig.worldActions ?? [];
    this.worldName = config.worldName ?? "unknown";
    this.worldDescription = config.worldDescription ?? "";
    this.worldSocialContext = buildWorldSocialContext(
      config.worldSocialContext,
      this.worldDescription,
    );
    this.contentLanguage = config.contentLanguage ?? "zh";
    this.originalPrompt = config.originalPrompt ?? "";
    this.sceneConfig = loadSceneConfig();

    worldState.initWorldState(this.locationConfigs);
    const restoredTime = this.restorePersistedTime();
    this.syncSceneClock(restoredTime.day);
  }

  getWorldName(): string {
    return this.worldName;
  }

  getWorldDescription(): string {
    return this.worldDescription;
  }

  getOriginalPrompt(): string {
    return this.originalPrompt;
  }

  getWorldSocialContext(): string {
    return this.worldSocialContext;
  }

  getContentLanguage(): "zh" | "en" {
    return this.contentLanguage;
  }

  getSceneConfig(): SceneConfig {
    return this.sceneConfig;
  }

  applySceneConfigOverride(override: Partial<SceneConfig>): void {
    this.sceneConfig = mergeSceneConfigOverride(this.sceneConfig, override);
    const restoredTime = this.restorePersistedTime();
    this.syncSceneClock(restoredTime.day);
  }

  getCurrentTime(): GameTime {
    const day = parseInt(worldState.getGlobalState("current_day") ?? "1", 10);
    const tick = parseInt(worldState.getGlobalState("current_tick") ?? "0", 10);
    return { day, tick };
  }

  advanceTick(): TickAdvanceResult {
    const previousTime = this.getCurrentTime();
    const { day, tick } = previousTime;
    const cycleTicks = getTicksPerScene({
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay: day,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });

    let newTick: number;
    let newDay: number;

    if (tick >= cycleTicks - 1) {
      newTick = 0;
      newDay = day + 1;
    } else {
      newTick = tick + 1;
      newDay = day;
    }

    worldState.setGlobalState("current_tick", String(newTick));
    worldState.setGlobalState("current_day", String(newDay));
    this.syncSceneClock(newDay);

    return {
      previousTime,
      currentTime: { day: newDay, tick: newTick },
      didAdvanceDay: newDay !== day,
      cycleTicks,
    };
  }

  isSceneComplete(): boolean {
    const currentTime = this.getCurrentTime();
    return isSceneComplete(currentTime.tick, {
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay: currentTime.day,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });
  }

  setTime(time: GameTime): void {
    worldState.setGlobalState("current_day", String(time.day));
    worldState.setGlobalState("current_tick", String(time.tick));
    this.syncSceneClock(time.day);
  }

  getLocation(locationId: string): LocationConfig | undefined {
    return this.locationConfigs.find((l) => l.id === locationId);
  }

  getAllLocations(): LocationConfig[] {
    return this.locationConfigs;
  }

  getActiveMapId(): string {
    return this.activeMapId;
  }

  getWorldMapsState(): WorldMapsState {
    const worldDir = getWorldDir();
    return {
      currentWorldId: worldDir ? path.basename(worldDir) : "",
      activeMapId: this.activeMapId,
      maps: this.worldMaps,
      links: this.mapLinks,
      currentPlayerMapId: this.activeMapId,
    };
  }

  getActiveMapDir(): string | null {
    return this.getMapDir(this.activeMapId);
  }

  getMapDir(mapId: string): string | null {
    const worldDir = getWorldDir();
    if (!worldDir || !isSafeMapId(mapId)) return null;
    const mapNode = this.worldMaps.find((map) => map.id === mapId);
    const mapDirName = mapNode?.mapDir || mapId;
    return path.join(worldDir, "maps", mapDirName);
  }

  getActiveMapAssetPrefix(): string {
    return `/assets/maps/${encodeURIComponent(this.activeMapId)}`;
  }

  travelToMap(targetMapId: string): { activeMapId: string; targetMapId: string; spawn: { x: number; y: number }; requiresReload: true } {
    const target = this.worldMaps.find((map) => map.id === targetMapId);
    if (!target) {
      throw new Error(`Map not found: ${targetMapId}`);
    }
    if (target.status !== "available") {
      throw new Error(`Map is not available: ${targetMapId}`);
    }
    this.updateWorldConfig((config) => {
      config.activeMapId = targetMapId;
    });
    reloadConfigs();
    this.activeMapId = targetMapId;
    this.reloadActiveMapData();
    const spawn = this.getDefaultSpawnForMap(targetMapId);
    return { activeMapId: targetMapId, targetMapId, spawn, requiresReload: true };
  }

  appendMapNode(
    map: WorldMapNodeConfig,
    spawnPoint?: MapSpawnPointConfig,
    link?: WorldMapLinkConfig,
  ): void {
    this.updateWorldConfig((config) => {
      const maps = normalizeWorldMaps(config.worldMaps, config.worldName ?? "初始地图");
      if (maps.some((candidate) => candidate.id === map.id)) {
        throw new Error(`Map already exists: ${map.id}`);
      }
      const occupied = new Set(maps.map((candidate) => `${candidate.gridX},${candidate.gridY}`));
      if (occupied.has(`${map.gridX},${map.gridY}`)) {
        throw new Error(`Map grid slot already exists: ${map.gridX},${map.gridY}`);
      }
      config.worldMaps = [...maps, map];
      if (link) {
        config.mapLinks = [...normalizeMapLinks(config.mapLinks), link];
      }
      if (spawnPoint) {
        config.mapSpawnPoints = [...normalizeMapSpawnPoints(config.mapSpawnPoints), spawnPoint];
      }
    });
    reloadConfigs();
    const config = loadWorldConfig();
    this.worldMaps = normalizeWorldMaps(config.worldMaps, config.worldName ?? "初始地图");
    this.mapLinks = normalizeMapLinks(config.mapLinks);
    this.mapSpawnPoints = normalizeMapSpawnPoints(config.mapSpawnPoints);
  }

  getMainAreaPoints(): MainAreaPointConfig[] {
    return this.mainAreaPoints;
  }

  getWorldSize(): WorldSizeConfig | null {
    return this.worldSize;
  }

  getMainAreaDialogueDistanceThreshold(): number | null {
    return null;
  }

  getMainAreaPoint(pointId: string | null | undefined): MainAreaPointConfig | undefined {
    if (!pointId) return undefined;
    return this.mainAreaPoints.find((point) => point.id === pointId);
  }

  hasMainAreaPointGraph(): boolean {
    return this.mainAreaPoints.length > 0;
  }

  hasMultipleMainAreaPoints(): boolean {
    return this.mainAreaPoints.length > 1;
  }

  getMainAreaPointZone(pointId: string | null | undefined): MainAreaZone {
    if (!pointId) return "中";
    return this.mainAreaZoneMap.get(pointId) ?? "中";
  }

  getAvailableMainAreaZones(): MainAreaZone[] {
    if (this.mainAreaZoneMap.size === 0) return [];
    return [...new Set(this.mainAreaZoneMap.values())];
  }

  pickPointInZone(zone: MainAreaZone, seed: string, excludePointId?: string | null): string | null {
    const preferred = this.getPreferredSpawnMainAreaPoints();
    const candidates = preferred.filter(
      (p) => this.mainAreaZoneMap.get(p.id) === zone && p.id !== excludePointId,
    );
    if (candidates.length === 0) return null;
    const index = Math.abs(hashString(seed)) % candidates.length;
    return candidates[index].id;
  }

  areMainAreaPointsCloseEnoughForDialogueStart(
    pointA: string | null | undefined,
    pointB: string | null | undefined,
  ): boolean {
    if (!this.hasMainAreaPointGraph()) return true;
    if (!pointA || !pointB) return false;
    if (pointA === pointB) return true;
    return this.areMainAreaPointsReachableWithinSteps(
      pointA,
      pointB,
      MAIN_AREA_DIALOGUE_MAX_GRAPH_STEPS,
    );
  }

  private areMainAreaPointsReachableWithinSteps(
    pointA: string,
    pointB: string,
    maxSteps: number,
  ): boolean {
    const start = this.getMainAreaPoint(pointA);
    const target = this.getMainAreaPoint(pointB);
    if (!start || !target) return false;

    const visited = new Set<string>([pointA]);
    const queue: Array<{ pointId: string; steps: number }> = [{ pointId: pointA, steps: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.steps >= maxSteps) continue;

      const point = this.getMainAreaPoint(current.pointId);
      for (const adjacentId of point?.adjacentPointIds || []) {
        if (adjacentId === pointB) return true;
        if (visited.has(adjacentId)) continue;
        visited.add(adjacentId);
        queue.push({ pointId: adjacentId, steps: current.steps + 1 });
      }
    }

    return false;
  }

  getInitialMainAreaPointId(seed: string): string | null {
    if (!this.hasMainAreaPointGraph()) return null;
    const points = this.getSpawnCandidateMainAreaPoints(this.getPreferredSpawnMainAreaPoints());
    const index = Math.abs(hashString(seed)) % points.length;
    return points[index]?.id ?? null;
  }

  /**
   * Pick a spawn point that avoids already-occupied points when possible.
   * Falls back to the hash-based default if every point is taken.
   */
  getSpreadMainAreaPointId(seed: string, occupied: Set<string>): string | null {
    if (!this.hasMainAreaPointGraph()) return null;
    const points = this.getPreferredSpawnMainAreaPoints();
    if (points.length === 0) return null;

    const edgeSafePoints = this.getSpawnCandidateMainAreaPoints(points);
    const free = points.filter((p) => !occupied.has(p.id));
    const edgeSafeFree = edgeSafePoints.filter((p) => !occupied.has(p.id));
    if (free.length === 0) {
      const fallbackPool = edgeSafePoints.length > 0 ? edgeSafePoints : points;
      const index = Math.abs(hashString(seed)) % fallbackPool.length;
      return fallbackPool[index]?.id ?? null;
    }

    const preferredPool = edgeSafeFree.length > 0 ? edgeSafeFree : free;
    const index = Math.abs(hashString(seed)) % preferredPool.length;
    return preferredPool[index]?.id ?? null;
  }

  pickDistantMainAreaPointId(currentPointId: string | null | undefined, seed: string): string | null {
    if (!this.hasMainAreaPointGraph()) return null;
    const points = this.getPreferredSpawnMainAreaPoints();
    const current = this.getMainAreaPoint(currentPointId);
    if (!current || !points.some((point) => point.id === current.id)) {
      return this.getInitialMainAreaPointId(seed);
    }

    const farCandidates = points.filter(
      (point) => point.id !== current.id && !current.adjacentPointIds.includes(point.id),
    );
    const candidatePool = farCandidates.length > 0
      ? farCandidates
      : points.filter((point) => point.id !== current.id);
    if (candidatePool.length === 0) return current.id;

    const ranked = [...candidatePool].sort((a, b) => {
      const distA = distanceBetweenPoints(a, current);
      const distB = distanceBetweenPoints(b, current);
      return distB - distA;
    });
    const preferredPool = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.6)));
    const pickIndex = Math.abs(hashString(`${seed}:${current.id}`)) % preferredPool.length;
    return preferredPool[pickIndex]?.id ?? preferredPool[0]?.id ?? null;
  }

  isPreferredSpawnMainAreaPoint(pointId: string | null | undefined): boolean {
    if (!pointId) return false;
    if (!this.preferredMainAreaPointIds || this.preferredMainAreaPointIds.size === 0) {
      return this.mainAreaPoints.some((point) => point.id === pointId);
    }
    return this.preferredMainAreaPointIds.has(pointId);
  }

  getWorldActions(): WorldActionConfig[] {
    return this.worldActions;
  }

  resetTransientStateForNewScene(): void {
    for (const objectState of worldState.getAllObjectStates()) {
      if (objectState.currentUsers.length === 0) continue;
      worldState.updateObjectState(objectState.objectId, {
        currentUsers: [],
      });
    }
  }

  private syncSceneClock(sceneDay: number): void {
    setSceneConfig({
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });
  }

  private restorePersistedTime(): GameTime {
    const rawDay = Number.parseInt(worldState.getGlobalState("current_day") ?? "1", 10);
    const rawTick = Number.parseInt(worldState.getGlobalState("current_tick") ?? "0", 10);

    const day = Number.isFinite(rawDay) && rawDay > 0 ? rawDay : 1;
    let tick = Number.isFinite(rawTick) && rawTick >= 0 ? rawTick : 0;

    const cycleTicks = getTicksPerScene({
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay: day,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });
    tick = Math.min(tick, Math.max(0, cycleTicks - 1));

    worldState.setGlobalState("current_day", String(day));
    worldState.setGlobalState("current_tick", String(tick));
    return { day, tick };
  }

  private getPreferredSpawnMainAreaPoints(): MainAreaPointConfig[] {
    if (!this.preferredMainAreaPointIds || this.preferredMainAreaPointIds.size === 0) {
      return this.mainAreaPoints;
    }
    const filtered = this.mainAreaPoints.filter((point) => this.preferredMainAreaPointIds?.has(point.id));
    return filtered.length > 0 ? filtered : this.mainAreaPoints;
  }

  private getSpawnCandidateMainAreaPoints(points: MainAreaPointConfig[]): MainAreaPointConfig[] {
    if (points.length <= 1) return points;
    if (!this.worldSize) return points;

    const edgePadding = this.getMainAreaSpawnEdgePaddingPx();
    const edgeSafe = edgePadding > 0
      ? points.filter(
          (point) =>
            point.x >= edgePadding &&
            point.x <= this.worldSize!.width - edgePadding &&
            point.y >= edgePadding &&
            point.y <= this.worldSize!.height - edgePadding,
        )
      : points;
    const candidatePool = edgeSafe.length > 0 ? edgeSafe : points;
    if (candidatePool.length <= 2) return candidatePool;

    const ranked = [...candidatePool].sort(
      (a, b) => this.getMainAreaPointInteriorScore(b) - this.getMainAreaPointInteriorScore(a),
    );
    const preferredCount = Math.max(
      1,
      Math.ceil(ranked.length * MAIN_AREA_SPAWN_INTERIOR_POOL_RATIO),
    );
    return ranked.slice(0, preferredCount);
  }

  private getMainAreaSpawnEdgePaddingPx(): number {
    if (!this.worldSize) return 0;
    const tileSize = this.worldSize.tileSize && Number.isFinite(this.worldSize.tileSize)
      ? this.worldSize.tileSize
      : 32;
    const proportionalPadding =
      Math.min(this.worldSize.width, this.worldSize.height) * MAIN_AREA_SPAWN_EDGE_PADDING_RATIO;
    return Math.max(tileSize * MAIN_AREA_SPAWN_EDGE_PADDING_TILE_MULTIPLIER, proportionalPadding);
  }

  private getMainAreaPointInteriorScore(point: MainAreaPointConfig): number {
    if (!this.worldSize) return 0;
    return Math.min(
      point.x,
      this.worldSize.width - point.x,
      point.y,
      this.worldSize.height - point.y,
    );
  }

  getWorldAction(actionId: string): WorldActionConfig | undefined {
    return this.worldActions.find((action) => action.id === actionId);
  }

  getAdjacentLocations(locationId: string): string[] {
    return this.getLocation(locationId)?.adjacentLocations ?? [];
  }

  getLocationObjects(locationId: string): (ObjectConfig & ObjectRuntimeState)[] {
    const loc = this.getLocation(locationId);
    if (!loc) return [];

    const runtimeStates = worldState.getObjectsByLocation(locationId);
    const stateMap = new Map(runtimeStates.map((s) => [s.objectId, s]));

    return loc.objects.map((obj) => {
      const runtime = stateMap.get(obj.id);
      return {
        ...obj,
        objectId: obj.id,
        locationId: obj.locationId,
        state: runtime?.state ?? obj.defaultState,
        stateDescription: runtime?.stateDescription ?? "",
        currentUsers: runtime?.currentUsers ?? [],
      };
    });
  }

  getAvailableInteractions(objectId: string): InteractionConfig[] {
    const objConfig = this.findObjectConfig(objectId);
    if (!objConfig) return [];

    const runtime = worldState.getObjectState(objectId);
    return objConfig.interactions.filter(
      (interaction) =>
        !Array.isArray(interaction.availableWhenState) ||
        interaction.availableWhenState.includes(runtime.state),
    );
  }

  updateObjectState(objectId: string, newState: string, description?: string): void {
    const patch: Partial<ObjectRuntimeState> = { state: newState };
    if (description !== undefined) patch.stateDescription = description;
    worldState.updateObjectState(objectId, patch);
  }

  characterStartUsingObject(objectId: string, characterId: string): boolean {
    const objConfig = this.findObjectConfig(objectId);
    if (!objConfig) return false;

    const runtime = worldState.getObjectState(objectId);
    if (runtime.currentUsers.length >= objConfig.capacity) return false;

    worldState.addUserToObject(objectId, characterId);
    return true;
  }

  characterStopUsingObject(objectId: string, characterId: string): void {
    worldState.removeUserFromObject(objectId, characterId);
  }

  getGlobal(key: string): string | null {
    return worldState.getGlobalState(key);
  }

  setGlobal(key: string, value: string): void {
    worldState.setGlobalState(key, value);
  }

  listDialogueSessions(): DialogueSession[] {
    return worldState
      .getAllGlobalState()
      .filter((entry) => entry.key.startsWith(DIALOGUE_SESSION_PREFIX))
      .map((entry) => this.parseDialogueSession(entry.key, entry.value))
      .filter((session): session is DialogueSession => session !== null);
  }

  getDialogueSession(sessionId: string): DialogueSession | null {
    const raw = worldState.getGlobalState(this.sessionKey(sessionId));
    if (!raw) return null;
    return this.parseDialogueSession(this.sessionKey(sessionId), raw);
  }

  saveDialogueSession(session: DialogueSession): void {
    worldState.setGlobalState(
      this.sessionKey(session.id),
      JSON.stringify(session),
    );
  }

  deleteDialogueSession(sessionId: string): void {
    worldState.deleteGlobalState(this.sessionKey(sessionId));
  }

  findDialogueSessionByParticipants(
    charA: string,
    charB: string,
  ): DialogueSession | null {
    return (
      this.listDialogueSessions().find((session) => {
        const participants = [...session.participants].sort();
        const pair = [charA, charB].sort();
        return participants[0] === pair[0] && participants[1] === pair[1];
      }) ?? null
    );
  }

  createSnapshot(description?: string): string {
    return snapshotStore.createSnapshot(this.getCurrentTime(), description);
  }

  restoreSnapshot(snapshotId: string): void {
    snapshotStore.restoreSnapshot(snapshotId);
  }

  listSnapshots(): SnapshotMeta[] {
    return snapshotStore.listSnapshots();
  }

  /** 检查像素坐标是否可行走 */
  isPixelWalkable(pixelX: number, pixelY: number): boolean {
    if (!this.collisionData || !this.worldSize?.tileSize) {
      // 没有碰撞数据时默认所有位置都可行走
      return true;
    }
    const tileSize = this.worldSize.tileSize;
    const gx = Math.floor(pixelX / tileSize);
    const gy = Math.floor(pixelY / tileSize);
    if (gx < 0 || gy < 0 || gx >= this.collisionGridWidth || gy >= this.collisionGridHeight) {
      return false;
    }
    return this.collisionData[gy * this.collisionGridWidth + gx] === 0;
  }

  getTileSize(): number {
    return this.worldSize?.tileSize && Number.isFinite(this.worldSize.tileSize)
      ? this.worldSize.tileSize
      : 32;
  }

  validatePlacementFootprint(
    pixelX: number,
    pixelY: number,
    footprintTiles: { width: number; height: number } = { width: 1, height: 1 },
  ): {
    ok: boolean;
    tileX: number;
    tileY: number;
    checkedTiles: Array<{ gx: number; gy: number; walkable: boolean }>;
    issues: string[];
  } {
    const tileSize = this.getTileSize();
    const tileX = Math.floor(pixelX / tileSize);
    const tileY = Math.floor(pixelY / tileSize);
    const width = Math.max(1, Math.min(16, Math.floor(footprintTiles.width || 1)));
    const height = Math.max(1, Math.min(16, Math.floor(footprintTiles.height || 1)));
    const startX = tileX - Math.floor((width - 1) / 2);
    const startY = tileY - Math.floor((height - 1) / 2);
    const checkedTiles: Array<{ gx: number; gy: number; walkable: boolean }> = [];
    const issues: string[] = [];

    if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
      return { ok: false, tileX, tileY, checkedTiles, issues: ["Placement coordinate must be finite."] };
    }

    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const gx = startX + dx;
        const gy = startY + dy;
        const walkable = this.isTileWalkable(gx, gy);
        checkedTiles.push({ gx, gy, walkable });
        if (!walkable) {
          issues.push(`Tile ${gx},${gy} is blocked or outside the map.`);
        }
      }
    }

    return {
      ok: issues.length === 0,
      tileX,
      tileY,
      checkedTiles,
      issues,
    };
  }

  /** 在中心点附近寻找一个可行走的像素点（螺旋搜索） */
  findWalkablePixelNear(centerX: number, centerY: number, maxRadiusPx = 200): { x: number; y: number } | null {
    if (!this.collisionData || !this.worldSize?.tileSize) {
      return { x: centerX, y: centerY };
    }

    const tileSize = this.worldSize.tileSize;
    const centerGx = Math.floor(centerX / tileSize);
    const centerGy = Math.floor(centerY / tileSize);
    const radiusTiles = Math.ceil(maxRadiusPx / tileSize);

    // 螺旋搜索：从中心向外扩展
    for (let r = 0; r <= radiusTiles; r++) {
      // 顶部行
      for (let dx = -r; dx <= r; dx++) {
        const gx = centerGx + dx;
        const gy = centerGy - r;
        if (this.isTileWalkable(gx, gy)) {
          return {
            x: gx * tileSize + tileSize / 2,
            y: gy * tileSize + tileSize / 2,
          };
        }
      }
      // 底部行
      for (let dx = -r; dx <= r; dx++) {
        const gx = centerGx + dx;
        const gy = centerGy + r;
        if (this.isTileWalkable(gx, gy)) {
          return {
            x: gx * tileSize + tileSize / 2,
            y: gy * tileSize + tileSize / 2,
          };
        }
      }
      // 左侧列（排除已检查的上下角）
      for (let dy = -r + 1; dy < r; dy++) {
        const gx = centerGx - r;
        const gy = centerGy + dy;
        if (this.isTileWalkable(gx, gy)) {
          return {
            x: gx * tileSize + tileSize / 2,
            y: gy * tileSize + tileSize / 2,
          };
        }
      }
      // 右侧列（排除已检查的上下角）
      for (let dy = -r + 1; dy < r; dy++) {
        const gx = centerGx + r;
        const gy = centerGy + dy;
        if (this.isTileWalkable(gx, gy)) {
          return {
            x: gx * tileSize + tileSize / 2,
            y: gy * tileSize + tileSize / 2,
          };
        }
      }
    }

    return null;
  }

  /** 获取 main_area 的中心像素坐标 */
  getMainAreaCenterPixel(): { x: number; y: number } {
    if (!this.worldSize) {
      return { x: 0, y: 0 };
    }
    return {
      x: this.worldSize.width / 2,
      y: this.worldSize.height / 2,
    };
  }

  private isTileWalkable(gx: number, gy: number): boolean {
    if (!this.collisionData) return true;
    if (gx < 0 || gy < 0 || gx >= this.collisionGridWidth || gy >= this.collisionGridHeight) {
      return false;
    }
    return this.collisionData[gy * this.collisionGridWidth + gx] === 0;
  }

  private loadCollisionGrid(): void {
    const mapDir = this.getActiveMapDir();
    if (!mapDir) return;

    const tmjPath = path.join(mapDir, "06-final.tmj");
    if (!fs.existsSync(tmjPath)) return;

    try {
      const raw = fs.readFileSync(tmjPath, "utf-8");
      const tmj = JSON.parse(raw) as {
        width?: number;
        height?: number;
        tilewidth?: number;
        layers?: Array<{ name?: string; data?: unknown }>;
      };
      const gridWidth = Number(tmj.width);
      const gridHeight = Number(tmj.height);
      const collisionData = tmj.layers?.find((layer) => layer.name === "collision")?.data;

      if (
        !Number.isFinite(gridWidth) ||
        !Number.isFinite(gridHeight) ||
        !Array.isArray(collisionData) ||
        collisionData.length !== gridWidth * gridHeight
      ) {
        return;
      }

      this.collisionData = collisionData as number[];
      this.collisionGridWidth = gridWidth;
      this.collisionGridHeight = gridHeight;

      // Also update worldSize to match new dimensions
      const tileSize = Number(tmj.tilewidth);
      if (Number.isFinite(tileSize) && this.worldSize) {
        this.worldSize = {
          ...this.worldSize,
          width: gridWidth * tileSize,
          height: gridHeight * tileSize,
          tileSize,
          gridWidth,
          gridHeight,
        };
      }
    } catch (error) {
      console.warn("[WorldManager] Failed to load collision grid:", error);
    }
  }

  /**
   * Reload active map data after travel or map-node generation.
   *
   * This performs a full reload of all world config that may have changed:
   * 1. Invalidate cached world.json and re-read it
   * 2. Re-normalize active-map locations
   * 3. Rebuild main area point adjacency graph
   * 4. Reload collision grid and world size from the active map TMJ
   */
  reloadActiveMapData(): void {
    console.log("[WorldManager] Reloading active map data...");

    // 1. Invalidate config cache so world.json is re-read from disk
    reloadConfigs();

    // 2. Re-load world config
    const config = loadWorldConfig();
    this.activeMapId = this.resolveActiveMapId(config);
    this.worldMaps = normalizeWorldMaps(config.worldMaps, config.worldName ?? "初始地图");
    this.mapLinks = normalizeMapLinks(config.mapLinks);
    this.mapSpawnPoints = normalizeMapSpawnPoints(config.mapSpawnPoints);
    const activeFragment = this.loadActiveMapFragment();
    const runtimeConfig = mergeWorldConfigForActiveMap(config, activeFragment);

    // 3. Re-normalize active-map locations
    this.locationConfigs = normalizeLocations(
      runtimeConfig.locations,
      runtimeConfig.worldName ?? "main_area",
      runtimeConfig.worldDescription ?? "",
    );

    // 4. Rebuild main area point adjacency
    this.mainAreaPoints = rebuildMainAreaPointAdjacencyFromTmj(
      normalizeMainAreaPoints(runtimeConfig.mainAreaPoints),
      this.getActiveMapDir(),
    );
    this.preferredMainAreaPointIds = getLargestMainAreaPointComponent(this.mainAreaPoints);
    this.mainAreaZoneMap = computeMainAreaZones(this.mainAreaPoints);

    // 5. Reload collision grid + world size from active map TMJ
    this.worldSize = normalizeWorldSize(runtimeConfig.worldSize) ?? inferWorldSizeFromWorldDir(this.getActiveMapDir());
    this.loadCollisionGrid();

    // 6. Update world actions/metadata in case they changed
    this.worldActions = runtimeConfig.worldActions ?? [];

    console.log(
      `[WorldManager] World reloaded: ${this.collisionGridWidth}x${this.collisionGridHeight} tiles, ` +
      `${this.worldSize?.width}x${this.worldSize?.height}px, ` +
      `${this.locationConfigs.length} locations, ${this.mainAreaPoints.length} main area points`,
    );
  }

  /** @deprecated Use reloadActiveMapData. */
  reloadAfterExpansion(): void {
    this.reloadActiveMapData();
  }

  private ensureMapWorldInitialized(): void {
    const worldDir = getWorldDir();
    if (!worldDir) return;
    const worldJsonPath = findWorldJsonPath(worldDir);
    if (!fs.existsSync(worldJsonPath)) return;
    const config = JSON.parse(fs.readFileSync(worldJsonPath, "utf-8")) as WorldConfig;
    const mapsRoot = path.join(worldDir, "maps");
    const originDir = path.join(mapsRoot, ORIGIN_MAP_ID);
    fs.mkdirSync(originDir, { recursive: true });

    const legacyMapDir = path.join(worldDir, "map");
    copyOriginMapFiles(legacyMapDir, originDir);

    const originFragmentPath = path.join(originDir, "world-fragment.json");
    if (!fs.existsSync(originFragmentPath)) {
      const fragment: Partial<WorldConfig> = {
        locations: config.locations ?? [],
        mainAreaPoints: config.mainAreaPoints ?? [],
        worldSize: config.worldSize,
        worldActions: config.worldActions,
      };
      fs.writeFileSync(originFragmentPath, `${JSON.stringify(fragment, null, 2)}\n`, "utf-8");
    }

    const metadataPath = path.join(originDir, "metadata.json");
    if (!fs.existsSync(metadataPath)) {
      const metadata = {
        id: ORIGIN_MAP_ID,
        name: config.worldName || "初始地图",
        createdAt: new Date().toISOString(),
        source: "legacy-origin",
      };
      fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
    }

    const changed =
      config.activeMapId !== ORIGIN_MAP_ID ||
      !Array.isArray(config.worldMaps) ||
      config.worldMaps.length === 0 ||
      !Array.isArray(config.mapLinks) ||
      !Array.isArray(config.mapSpawnPoints);
    if (changed) {
      config.activeMapId = config.activeMapId || ORIGIN_MAP_ID;
      config.worldMaps = normalizeWorldMaps(config.worldMaps, config.worldName ?? "初始地图");
      config.mapLinks = normalizeMapLinks(config.mapLinks);
      config.mapSpawnPoints = normalizeMapSpawnPoints(config.mapSpawnPoints);
      fs.writeFileSync(worldJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
      reloadConfigs();
    }
  }

  private resolveActiveMapId(config: WorldConfig): string {
    const maps = normalizeWorldMaps(config.worldMaps, config.worldName ?? "初始地图");
    const activeMapId = config.activeMapId || ORIGIN_MAP_ID;
    return maps.some((map) => map.id === activeMapId) ? activeMapId : ORIGIN_MAP_ID;
  }

  private loadActiveMapFragment(): Partial<WorldConfig> | null {
    const mapDir = this.getActiveMapDir();
    if (!mapDir) return null;
    const fragmentPath = path.join(mapDir, "world-fragment.json");
    if (!fs.existsSync(fragmentPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(fragmentPath, "utf-8")) as Partial<WorldConfig>;
    } catch (error) {
      console.warn(`[WorldManager] Failed to parse active map fragment: ${fragmentPath}`, error);
      return null;
    }
  }

  private updateWorldConfig(mutator: (config: WorldConfig) => void): void {
    const worldDir = getWorldDir();
    if (!worldDir) throw new Error("No active world");
    const worldJsonPath = findWorldJsonPath(worldDir);
    const config = JSON.parse(fs.readFileSync(worldJsonPath, "utf-8")) as WorldConfig;
    mutator(config);
    fs.writeFileSync(worldJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  private getDefaultSpawnForMap(mapId: string): { x: number; y: number } {
    const explicit = this.mapSpawnPoints.find((point) => point.mapId === mapId && point.default)
      || this.mapSpawnPoints.find((point) => point.mapId === mapId);
    if (explicit) {
      const safe = this.findWalkablePixelNear(explicit.x, explicit.y, 20);
      return safe ?? { x: explicit.x, y: explicit.y };
    }
    const center = this.getMainAreaCenterPixel();
    return this.findWalkablePixelNear(center.x, center.y, 50) ?? center;
  }

  private findObjectConfig(objectId: string): ObjectConfig | undefined {
    for (const loc of this.locationConfigs) {
      const obj = loc.objects.find((o) => o.id === objectId);
      if (obj) return obj;
    }
    return undefined;
  }

  private sessionKey(sessionId: string): string {
    return `${DIALOGUE_SESSION_PREFIX}${sessionId}`;
  }

  private parseDialogueSession(
    key: string,
    raw: string,
  ): DialogueSession | null {
    try {
      const parsed = JSON.parse(raw) as DialogueSession;
      if (!parsed || !Array.isArray(parsed.participants)) return null;
      return parsed;
    } catch (error) {
      console.warn(`[WorldManager] Failed to parse dialogue session ${key}:`, error);
      return null;
    }
  }
}

function normalizeLocations(
  locations: LocationConfig[] | undefined,
  worldName: string,
  worldDescription: string,
): LocationConfig[] {
  const authored = (Array.isArray(locations) ? locations : []).map((location) => ({
    ...location,
    adjacentLocations: Array.isArray(location.adjacentLocations)
      ? unique(location.adjacentLocations.filter(Boolean))
      : [],
    objects: Array.isArray(location.objects) ? location.objects : [],
  }));

  const authoredIds = authored
    .map((location) => location.id)
    .filter((locationId) => locationId && locationId !== "main_area");

  const hasMainArea = authored.some((location) => location.id === "main_area");
  const withMainArea = hasMainArea
    ? authored
    : [
        {
          id: "main_area",
          name: "主区域",
          description: worldDescription || `${worldName}中的公共活动区域`,
          adjacentLocations: [...authoredIds],
          objects: [],
        },
        ...authored,
      ];

  const allIds = new Set(withMainArea.map((location) => location.id));
  const hasAnyAuthoredAdjacency = withMainArea.some(
    (location) =>
      location.id !== "main_area" && (location.adjacentLocations?.length ?? 0) > 0,
  );

  return withMainArea.map((location) => {
    let adjacent = (location.adjacentLocations ?? []).filter(
      (adjacentId) => adjacentId !== location.id && allIds.has(adjacentId),
    );

    if (location.id === "main_area") {
      adjacent = unique([...adjacent, ...authoredIds]);
    } else if (adjacent.length === 0) {
      adjacent = hasAnyAuthoredAdjacency
        ? ["main_area"]
        : Array.from(allIds).filter((adjacentId) => adjacentId !== location.id);
    } else {
      adjacent = unique(["main_area", ...adjacent]);
    }

    return {
      ...location,
      adjacentLocations: adjacent,
    };
  });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeMainAreaPoints(points: MainAreaPointConfig[] | undefined): MainAreaPointConfig[] {
  const normalized = (Array.isArray(points) ? points : [])
    .filter(
      (point): point is MainAreaPointConfig =>
        !!point &&
        typeof point.id === "string" &&
        typeof point.x === "number" &&
        typeof point.y === "number",
    )
    .map((point) => ({
      ...point,
      name: point.name || point.id,
      adjacentPointIds: Array.isArray(point.adjacentPointIds)
        ? unique(point.adjacentPointIds.filter((adjacentId) => adjacentId && adjacentId !== point.id))
        : [],
    }));

  const validIds = new Set(normalized.map((point) => point.id));
  return normalized.map((point) => ({
    ...point,
    adjacentPointIds: point.adjacentPointIds.filter((adjacentId) => validIds.has(adjacentId)),
  }));
}

function rebuildMainAreaPointAdjacencyFromTmj(
  points: MainAreaPointConfig[],
  mapDirOverride?: string | null,
): MainAreaPointConfig[] {
  if (points.length <= 1) return points;

  const worldDir = getWorldDir();
  const tmjDir = mapDirOverride || (worldDir ? path.join(worldDir, "map") : null);
  if (!tmjDir) return points;

  const tmjPath = path.join(tmjDir, "06-final.tmj");
  if (!fs.existsSync(tmjPath)) return points;

  try {
    const raw = fs.readFileSync(tmjPath, "utf-8");
    const tmj = JSON.parse(raw) as {
      width?: number;
      height?: number;
      tilewidth?: number;
      layers?: Array<{ name?: string; data?: unknown }>;
    };
    const gridWidth = Number(tmj.width);
    const gridHeight = Number(tmj.height);
    const tileSize = Number(tmj.tilewidth);
    const collisionData = tmj.layers?.find((layer) => layer.name === "collision")?.data;

    if (
      !Number.isFinite(gridWidth) ||
      !Number.isFinite(gridHeight) ||
      !Number.isFinite(tileSize) ||
      !Array.isArray(collisionData) ||
      collisionData.length !== gridWidth * gridHeight
    ) {
      return points;
    }

    const rebuilt = attachPathBasedMainAreaPointAdjacency(
      points,
      collisionData as number[],
      gridWidth,
      gridHeight,
      tileSize,
    );
    return getLargestRawMainAreaPointComponent(rebuilt).size >
      getLargestRawMainAreaPointComponent(points).size
      ? rebuilt
      : points;
  } catch (error) {
    console.warn("[WorldManager] Failed to rebuild main area point adjacency:", error);
    return points;
  }
}

function attachPathBasedMainAreaPointAdjacency(
  points: MainAreaPointConfig[],
  collisionData: number[],
  gridWidth: number,
  gridHeight: number,
  tileSize: number,
): MainAreaPointConfig[] {
  const spacingPx = Math.max(
    tileSize * MIN_POINT_SPACING_TILES,
    Math.min(
      tileSize * MAX_POINT_SPACING_TILES,
      inferMedianNearestPointDistance(points) || tileSize * MAX_POINT_SPACING_TILES,
    ),
  );
  const adjacencyDistance = Math.max(
    tileSize * MIN_POINT_SPACING_TILES,
    spacingPx * MAIN_AREA_POINT_ADJACENCY_MULTIPLIER,
  );
  const rebuilt = points.map((point) => ({ ...point, adjacentPointIds: [] as string[] }));
  const pointMap = new Map(rebuilt.map((point) => [point.id, point]));

  for (let i = 0; i < rebuilt.length; i++) {
    for (let j = i + 1; j < rebuilt.length; j++) {
      const a = rebuilt[i];
      const b = rebuilt[j];
      if (distanceBetweenPoints(a, b) > adjacencyDistance) continue;
      if (!hasWalkablePathBetweenPoints(a, b, collisionData, gridWidth, gridHeight, tileSize)) {
        continue;
      }
      pointMap.get(a.id)?.adjacentPointIds.push(b.id);
      pointMap.get(b.id)?.adjacentPointIds.push(a.id);
    }
  }

  for (const point of rebuilt) {
    const current = pointMap.get(point.id);
    if (!current || current.adjacentPointIds.length > 0) continue;

    const nearest = rebuilt
      .filter((candidate) => candidate.id !== point.id)
      .filter(
        (candidate) =>
          distanceBetweenPoints(point, candidate) <= adjacencyDistance &&
          hasWalkablePathBetweenPoints(point, candidate, collisionData, gridWidth, gridHeight, tileSize),
      )
      .sort((a, b) => distanceBetweenPoints(point, a) - distanceBetweenPoints(point, b))[0];
    if (!nearest) continue;
    current.adjacentPointIds.push(nearest.id);
    pointMap.get(nearest.id)?.adjacentPointIds.push(point.id);
  }

  return rebuilt.map((point) => ({
    ...point,
    adjacentPointIds: unique(point.adjacentPointIds).sort(),
  }));
}

function inferMedianNearestPointDistance(points: MainAreaPointConfig[]): number | null {
  if (points.length <= 1) return null;
  const nearestDistances = points
    .map((point) =>
      Math.min(
        ...points
          .filter((candidate) => candidate.id !== point.id)
          .map((candidate) => distanceBetweenPoints(point, candidate)),
      ),
    )
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (nearestDistances.length === 0) return null;
  return nearestDistances[Math.floor(nearestDistances.length / 2)] ?? null;
}

function hasWalkablePathBetweenPoints(
  a: MainAreaPointConfig,
  b: MainAreaPointConfig,
  collisionData: number[],
  gridWidth: number,
  gridHeight: number,
  tileSize: number,
): boolean {
  const start = pointToTile(a, tileSize, gridWidth, gridHeight);
  const goal = pointToTile(b, tileSize, gridWidth, gridHeight);
  if (
    !isWalkableTile(start.x, start.y, collisionData, gridWidth, gridHeight) ||
    !isWalkableTile(goal.x, goal.y, collisionData, gridWidth, gridHeight)
  ) {
    return false;
  }

  const directSteps = Math.max(
    1,
    Math.abs(start.x - goal.x) + Math.abs(start.y - goal.y),
  );
  const maxSteps = Math.ceil(directSteps * MAIN_AREA_POINT_PATH_DETOUR_MULTIPLIER) + 12;
  const minX = Math.max(0, Math.min(start.x, goal.x) - maxSteps);
  const maxX = Math.min(gridWidth - 1, Math.max(start.x, goal.x) + maxSteps);
  const minY = Math.max(0, Math.min(start.y, goal.y) - maxSteps);
  const maxY = Math.min(gridHeight - 1, Math.max(start.y, goal.y) + maxSteps);
  const queue: Array<{ x: number; y: number; steps: number }> = [
    { x: start.x, y: start.y, steps: 0 },
  ];
  const visited = new Set([`${start.x},${start.y}`]);

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current.x === goal.x && current.y === goal.y) return true;
    if (current.steps >= maxSteps) continue;

    for (const [nx, ny] of [
      [current.x + 1, current.y],
      [current.x - 1, current.y],
      [current.x, current.y + 1],
      [current.x, current.y - 1],
    ]) {
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key)) continue;
      if (!isWalkableTile(nx, ny, collisionData, gridWidth, gridHeight)) continue;
      visited.add(key);
      queue.push({ x: nx, y: ny, steps: current.steps + 1 });
    }
  }

  return false;
}

function pointToTile(
  point: MainAreaPointConfig,
  tileSize: number,
  gridWidth: number,
  gridHeight: number,
): { x: number; y: number } {
  return {
    x: clampInt(Math.floor(point.x / tileSize), 0, gridWidth - 1),
    y: clampInt(Math.floor(point.y / tileSize), 0, gridHeight - 1),
  };
}

function isWalkableTile(
  gx: number,
  gy: number,
  collisionData: number[],
  gridWidth: number,
  gridHeight: number,
): boolean {
  if (gx < 0 || gy < 0 || gx >= gridWidth || gy >= gridHeight) return false;
  return collisionData[gy * gridWidth + gx] === 0;
}

function mergeSceneConfigOverride(base: SceneConfig, override: Partial<SceneConfig>): SceneConfig {
  const nextTickDuration =
    typeof override.tickDurationMinutes === "number" && Number.isFinite(override.tickDurationMinutes)
      ? Math.max(1, Math.floor(override.tickDurationMinutes))
      : base.tickDurationMinutes;
  let nextMaxTicks = override.maxTicks ?? base.maxTicks;

  if (
    override.tickDurationMinutes !== undefined &&
    override.maxTicks === undefined &&
    base.sceneType === "open" &&
    base.maxTicks != null
  ) {
    const cycleMinutes = Math.max(1, base.maxTicks) * base.tickDurationMinutes;
    nextMaxTicks = Math.max(1, Math.round(cycleMinutes / nextTickDuration));
  }

  return {
    ...base,
    ...override,
    tickDurationMinutes: nextTickDuration,
    maxTicks: nextMaxTicks,
    multiDay: {
      ...base.multiDay,
      ...override.multiDay,
    },
  };
}

function normalizeWorldSize(size: WorldSizeConfig | undefined): WorldSizeConfig | null {
  if (!size) return null;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  return {
    width: size.width,
    height: size.height,
    tileSize: Number.isFinite(size.tileSize) ? size.tileSize : undefined,
    gridWidth: Number.isFinite(size.gridWidth) ? size.gridWidth : undefined,
    gridHeight: Number.isFinite(size.gridHeight) ? size.gridHeight : undefined,
  };
}

function inferWorldSizeFromWorldDir(mapDirOverride?: string | null): WorldSizeConfig | null {
  const worldDir = getWorldDir();
  const tmjDir = mapDirOverride || (worldDir ? path.join(worldDir, "map") : null);
  if (!tmjDir) return null;
  const tmjPath = path.join(tmjDir, "06-final.tmj");
  if (!fs.existsSync(tmjPath)) return null;

  try {
    const raw = fs.readFileSync(tmjPath, "utf-8");
    const tmj = JSON.parse(raw) as {
      width?: number;
      height?: number;
      tilewidth?: number;
    };
    if (
      !Number.isFinite(tmj.width) ||
      !Number.isFinite(tmj.height) ||
      !Number.isFinite(tmj.tilewidth)
    ) {
      return null;
    }
    const gridWidth = Number(tmj.width);
    const gridHeight = Number(tmj.height);
    const tileSize = Number(tmj.tilewidth);
    return {
      width: gridWidth * tileSize,
      height: gridHeight * tileSize,
      tileSize,
      gridWidth,
      gridHeight,
    };
  } catch (error) {
    console.warn("[WorldManager] Failed to infer world size from TMJ:", error);
    return null;
  }
}

function normalizeWorldMaps(
  maps: WorldMapNodeConfig[] | undefined,
  originName: string,
): WorldMapNodeConfig[] {
  const normalized = Array.isArray(maps)
    ? maps
        .filter((map): map is WorldMapNodeConfig =>
          !!map &&
          typeof map.id === "string" &&
          isSafeMapId(map.id) &&
          typeof map.gridX === "number" &&
          typeof map.gridY === "number",
        )
        .map((map): WorldMapNodeConfig => {
          const status = map.status === "generating" || map.status === "failed" ? map.status : "available";
          return {
            ...map,
            name: map.name || map.id,
            status,
            mapDir: isSafeMapId(map.mapDir) ? map.mapDir : map.id,
            previewImage: map.previewImage || "background-preview.png",
            createdAt: map.createdAt || new Date().toISOString(),
          };
        })
    : [];
  if (normalized.some((map) => map.id === ORIGIN_MAP_ID)) {
    return normalized;
  }
  return [
    {
      id: ORIGIN_MAP_ID,
      name: originName || "初始地图",
      gridX: 0,
      gridY: 0,
      status: "available",
      mapDir: ORIGIN_MAP_ID,
      previewImage: "background-preview.png",
      defaultSpawnPointId: `${ORIGIN_MAP_ID}_spawn`,
      createdAt: new Date().toISOString(),
    },
    ...normalized,
  ];
}

function normalizeMapLinks(links: WorldMapLinkConfig[] | undefined): WorldMapLinkConfig[] {
  if (!Array.isArray(links)) return [];
  return links.filter((link): link is WorldMapLinkConfig =>
    !!link &&
    typeof link.fromMapId === "string" &&
    typeof link.toMapId === "string",
  );
}

function normalizeMapSpawnPoints(points: MapSpawnPointConfig[] | undefined): MapSpawnPointConfig[] {
  if (!Array.isArray(points)) return [];
  return points.filter((point): point is MapSpawnPointConfig =>
    !!point &&
    typeof point.mapId === "string" &&
    typeof point.id === "string" &&
    typeof point.x === "number" &&
    typeof point.y === "number",
  );
}

function mergeWorldConfigForActiveMap(
  config: WorldConfig,
  fragment: Partial<WorldConfig> | null,
): WorldConfig {
  if (!fragment) return config;
  return {
    ...config,
    locations: Array.isArray(fragment.locations) ? fragment.locations : config.locations,
    mainAreaPoints: Array.isArray(fragment.mainAreaPoints)
      ? fragment.mainAreaPoints
      : config.mainAreaPoints,
    worldSize: fragment.worldSize || config.worldSize,
    worldActions: Array.isArray(fragment.worldActions) ? fragment.worldActions : config.worldActions,
  };
}

function copyOriginMapFiles(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  const fileNames = ["06-background.png", "background-preview.png", "06-final.tmj"];
  for (const fileName of fileNames) {
    const source = path.join(sourceDir, fileName);
    const target = path.join(targetDir, fileName);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
  const sourceTiles = path.join(sourceDir, "background-tiles");
  const targetTiles = path.join(targetDir, "background-tiles");
  if (fs.existsSync(sourceTiles) && !fs.existsSync(targetTiles)) {
    fs.cpSync(sourceTiles, targetTiles, { recursive: true });
  }
}

function isSafeMapId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function findWorldJsonPath(worldDir: string): string {
  const rootPath = path.join(worldDir, "world.json");
  if (fs.existsSync(rootPath)) return rootPath;
  return path.join(worldDir, "config", "world.json");
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function distanceBetweenPoints(a: MainAreaPointConfig, b: MainAreaPointConfig): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getLargestMainAreaPointComponent(points: MainAreaPointConfig[]): Set<string> | null {
  if (points.length === 0) return null;

  const largest = getLargestRawMainAreaPointComponent(points);
  if (largest.size === 0) return null;

  const componentRatio = largest.size / points.length;
  if (
    largest.size < MIN_PREFERRED_MAIN_AREA_COMPONENT_SIZE ||
    componentRatio < MIN_PREFERRED_MAIN_AREA_COMPONENT_RATIO
  ) {
    return null;
  }

  return largest;
}

function getLargestRawMainAreaPointComponent(points: MainAreaPointConfig[]): Set<string> {
  const pointMap = new Map(points.map((point) => [point.id, point]));
  const reverseAdjacency = new Map<string, string[]>();
  for (const point of points) {
    for (const neighborId of point.adjacentPointIds || []) {
      if (!pointMap.has(neighborId)) continue;
      const reverse = reverseAdjacency.get(neighborId) ?? [];
      reverse.push(point.id);
      reverseAdjacency.set(neighborId, reverse);
    }
  }

  const visited = new Set<string>();
  let largest = new Set<string>();

  for (const point of points) {
    if (visited.has(point.id)) continue;

    const component = new Set<string>();
    const queue = [point.id];
    visited.add(point.id);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      component.add(currentId);
      const current = pointMap.get(currentId);
      if (!current) continue;

      const neighbors = [
        ...(current.adjacentPointIds || []).filter((neighborId) => pointMap.has(neighborId)),
        ...(reverseAdjacency.get(currentId) || []),
      ];
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    if (component.size > largest.size) {
      largest = component;
    }
  }

  return largest;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function buildWorldSocialContext(
  socialContext?: string,
  worldDescription?: string,
): string {
  const trimmedContext = typeof socialContext === "string" ? socialContext.trim() : "";
  if (trimmedContext) return trimmedContext;
  const trimmedDescription = typeof worldDescription === "string" ? worldDescription.trim() : "";
  if (trimmedDescription) return trimmedDescription;
  return "这是一个有自身日常秩序的小世界。让背景只作为处事底色，别机械复述设定。";
}

const MIN_POINTS_FOR_ZONES = 5;

function computeMainAreaZones(points: MainAreaPointConfig[]): Map<string, MainAreaZone> {
  const zoneMap = new Map<string, MainAreaZone>();
  if (points.length === 0) return zoneMap;
  if (points.length < MIN_POINTS_FOR_ZONES) {
    for (const p of points) zoneMap.set(p.id, "中");
    return zoneMap;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  if (rangeX < 1 && rangeY < 1) {
    for (const p of points) zoneMap.set(p.id, "中");
    return zoneMap;
  }

  for (const p of points) {
    const nx = rangeX > 0 ? (p.x - minX) / rangeX : 0.5;
    const ny = rangeY > 0 ? (p.y - minY) / rangeY : 0.5;
    const inCenterX = nx >= 0.3 && nx <= 0.7;
    const inCenterY = ny >= 0.3 && ny <= 0.7;
    if (inCenterX && inCenterY) {
      zoneMap.set(p.id, "中");
    } else {
      const devX = Math.abs(nx - 0.5);
      const devY = Math.abs(ny - 0.5);
      if (devX >= devY) {
        zoneMap.set(p.id, nx < 0.5 ? "西" : "东");
      } else {
        zoneMap.set(p.id, ny < 0.5 ? "北" : "南");
      }
    }
  }
  return zoneMap;
}
