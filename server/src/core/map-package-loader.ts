import fs from "node:fs";
import path from "node:path";
import type {
  LocationConfig,
  MainAreaPointConfig,
  MapSpawnPointConfig,
  SceneConfig,
  WorldActionConfig,
  WorldConfig,
  WorldMapLinkConfig,
  WorldMapNodeConfig,
  WorldSizeConfig,
} from "../types/index.js";
import type { ResourceNodeConfig } from "../types/build.js";
import { buildSceneRuntimeInfo, type SceneRuntimeInfo } from "../utils/time-helpers.js";

export interface PlacementFootprintValidation {
  ok: boolean;
  tileX: number;
  tileY: number;
  checkedTiles: Array<{ gx: number; gy: number; walkable: boolean }>;
  issues: string[];
  mapId: string;
  tileSize: number;
}

interface CollisionGrid {
  mapId: string;
  gridWidth: number;
  gridHeight: number;
  tileSize: number;
  collisionData: number[];
}

export interface PackageMapNodesState {
  currentWorldId: string;
  activeMapId: string;
  mapNodes: WorldMapNodeConfig[];
  links: WorldMapLinkConfig[];
  currentPlayerMapId: string;
}

export interface PackageMapSpawn {
  x: number;
  y: number;
  mainAreaPointId: string | null;
}

export interface PackageWorldInfo {
  worldName: string;
  worldDescription: string;
  originalPrompt?: string;
  currentWorldId: string;
  currentTimelineId: string | null;
  sceneConfig: SceneConfig;
  sceneRuntime: SceneRuntimeInfo;
  worldActions: WorldActionConfig[];
  mainAreaPoints: MainAreaPointConfig[];
  worldSize: WorldSizeConfig | null;
  mainAreaDialogueRadiusPx: number;
  timelineTickCount: number;
}

export interface PackageLocationState {
  location: LocationConfig;
  objects: Array<{
    objectId: string;
    state: string;
    stateDescription: string;
    currentUsers: string[];
  }>;
  characters: Array<{
    id: string;
    name: string;
    action: string | null;
  }>;
}

const DEFAULT_TILE_SIZE = 32;
const ORIGIN_MAP_ID = "map_origin";
const DEFAULT_RESOURCE_PER_CLICK = 1;
const DEFAULT_COOLDOWN_MS = 0;
const DEFAULT_DIALOGUE_RADIUS_PX = 180;
const RESOURCE_KEYWORDS = [
  "矿", "矿石", "水晶", "宝石", "金矿", "银矿", "铁矿",
  "树", "森林", "木材", "木头", "果树",
  "泉", "井", "水源", "河流", "湖泊",
  "药草", "草药", "花丛", "蘑菇",
  "宝箱", "宝藏", "金币", "财富",
  "mine", "ore", "crystal", "gem", "gold", "silver", "iron",
  "tree", "forest", "wood", "lumber",
  "spring", "well", "water",
  "herb", "flower", "mushroom",
  "chest", "treasure", "coin",
  "statue", "fountain", "forge", "anvil",
];

export class MapPackageLoader {
  private collisionCache = new Map<string, CollisionGrid>();
  private resourceNodeCache = new Map<string, ResourceNodeConfig[]>();

  validatePlacementFootprint(
    worldDir: string,
    mapId: string,
    pixelX: number,
    pixelY: number,
    footprintTiles: { width: number; height: number } = { width: 1, height: 1 },
  ): PlacementFootprintValidation {
    const grid = this.loadCollisionGrid(worldDir, mapId);
    const tileSize = grid?.tileSize ?? DEFAULT_TILE_SIZE;
    const tileX = Math.floor(pixelX / tileSize);
    const tileY = Math.floor(pixelY / tileSize);
    const width = Math.max(1, Math.min(16, Math.floor(footprintTiles.width || 1)));
    const height = Math.max(1, Math.min(16, Math.floor(footprintTiles.height || 1)));
    const startX = tileX - Math.floor((width - 1) / 2);
    const startY = tileY - Math.floor((height - 1) / 2);
    const checkedTiles: Array<{ gx: number; gy: number; walkable: boolean }> = [];
    const issues: string[] = [];

    if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
      return {
        ok: false,
        tileX,
        tileY,
        checkedTiles,
        issues: ["Placement coordinate must be finite."],
        mapId,
        tileSize,
      };
    }

    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const gx = startX + dx;
        const gy = startY + dy;
        const walkable = grid ? isTileWalkable(grid, gx, gy) : true;
        checkedTiles.push({ gx, gy, walkable });
        if (!walkable) {
          issues.push(`Tile ${gx},${gy} is blocked or outside map ${mapId}.`);
        }
      }
    }

    return {
      ok: issues.length === 0,
      tileX,
      tileY,
      checkedTiles,
      issues,
      mapId,
      tileSize,
    };
  }

  getMapDir(worldDir: string, mapId: string): string | null {
    if (!worldDir || !isSafeMapId(mapId)) return null;
    const config = readWorldConfig(worldDir);
    const mapNode = findMapNode(config, mapId);
    const mapDirName = mapNode?.mapDir || mapId;
    const candidate = path.resolve(worldDir, "maps", mapDirName);
    const mapsRoot = path.resolve(worldDir, "maps");
    if (!candidate.startsWith(mapsRoot + path.sep) && candidate !== mapsRoot) return null;
    if (fs.existsSync(candidate)) return candidate;
    if (mapId === ORIGIN_MAP_ID) {
      const legacyMapDir = path.resolve(worldDir, "map");
      if (fs.existsSync(legacyMapDir)) return legacyMapDir;
    }
    return candidate;
  }

  getMapNodesState(worldDir: string, activeMapId: string = ORIGIN_MAP_ID): PackageMapNodesState {
    const config = readWorldConfig(worldDir);
    const mapNodes = normalizeMapNodes(config, config.worldName ?? "初始地图");
    const safeActiveMapId = mapNodes.some((map) => map.id === activeMapId) ? activeMapId : ORIGIN_MAP_ID;
    return {
      currentWorldId: path.basename(path.resolve(worldDir)),
      activeMapId: safeActiveMapId,
      mapNodes,
      links: Array.isArray(config.mapLinks) ? config.mapLinks : [],
      currentPlayerMapId: safeActiveMapId,
    };
  }

  getWorldPackageInfo(
    worldDir: string,
    mapId: string,
    options: { timelineId?: string | null; timelineTickCount?: number } = {},
  ): PackageWorldInfo {
    const config = readMergedMapWorldConfig(worldDir, mapId);
    const sceneConfig = normalizeSceneConfig(config.scene);
    return {
      worldName: config.worldName || "未命名世界",
      worldDescription: config.worldDescription || "",
      originalPrompt: config.originalPrompt,
      currentWorldId: path.basename(path.resolve(worldDir)),
      currentTimelineId: options.timelineId ?? null,
      sceneConfig,
      sceneRuntime: buildSceneRuntimeInfo(sceneConfig),
      worldActions: Array.isArray(config.worldActions) ? config.worldActions : [],
      mainAreaPoints: Array.isArray(config.mainAreaPoints) ? config.mainAreaPoints : [],
      worldSize: normalizeWorldSize(config.worldSize) ?? this.getTmjWorldSize(worldDir, mapId),
      mainAreaDialogueRadiusPx: DEFAULT_DIALOGUE_RADIUS_PX,
      timelineTickCount: options.timelineTickCount ?? 0,
    };
  }

  getLocations(worldDir: string, mapId: string): LocationConfig[] {
    const config = readMergedMapWorldConfig(worldDir, mapId);
    return Array.isArray(config.locations) ? config.locations : [];
  }

  getLocationState(worldDir: string, mapId: string, locationId: string): PackageLocationState | null {
    const location = this.getLocations(worldDir, mapId).find((item) => item.id === locationId);
    if (!location) return null;
    return {
      location,
      objects: (location.objects ?? []).map((object) => ({
        objectId: object.id,
        state: object.defaultState,
        stateDescription: object.defaultState,
        currentUsers: [],
      })),
      characters: [],
    };
  }

  getMapCenterPixel(worldDir: string, mapId: string): { x: number; y: number } {
    const grid = this.loadCollisionGrid(worldDir, mapId);
    if (grid) {
      return {
        x: Math.round((grid.gridWidth * grid.tileSize) / 2),
        y: Math.round((grid.gridHeight * grid.tileSize) / 2),
      };
    }
    const worldSize = readWorldConfig(worldDir).worldSize;
    if (worldSize && Number.isFinite(worldSize.width) && Number.isFinite(worldSize.height)) {
      return {
        x: Math.round(worldSize.width / 2),
        y: Math.round(worldSize.height / 2),
      };
    }
    return { x: 0, y: 0 };
  }

  private getTmjWorldSize(worldDir: string, mapId: string): WorldSizeConfig | null {
    const grid = this.loadCollisionGrid(worldDir, mapId);
    if (!grid) return null;
    return {
      width: grid.gridWidth * grid.tileSize,
      height: grid.gridHeight * grid.tileSize,
      tileSize: grid.tileSize,
      gridWidth: grid.gridWidth,
      gridHeight: grid.gridHeight,
    };
  }

  getDefaultSpawnForMap(worldDir: string, mapId: string): PackageMapSpawn {
    const config = readWorldConfig(worldDir);
    const spawnPoints = normalizeMapSpawnPoints(config.mapSpawnPoints);
    const explicit = spawnPoints.find((point) => point.mapId === mapId && point.default)
      || spawnPoints.find((point) => point.mapId === mapId);
    if (explicit) {
      const safe = this.findWalkablePixelNear(worldDir, mapId, explicit.x, explicit.y, 20);
      return {
        ...(safe ?? { x: explicit.x, y: explicit.y }),
        mainAreaPointId: explicit.id,
      };
    }
    const center = this.getMapCenterPixel(worldDir, mapId);
    return {
      ...(this.findWalkablePixelNear(worldDir, mapId, center.x, center.y, 50) ?? center),
      mainAreaPointId: null,
    };
  }

  discoverResourceNodes(worldDir: string, mapId: string): ResourceNodeConfig[] {
    const cacheKey = `${path.resolve(worldDir)}::${mapId}`;
    const cached = this.resourceNodeCache.get(cacheKey);
    if (cached) return [...cached];

    const config = readWorldConfig(worldDir);
    const nodes = [
      ...discoverWorldConfigResourceNodes(config),
      ...this.discoverTmjResourceNodes(worldDir, mapId),
    ];
    const unique = new Map<string, ResourceNodeConfig>();
    for (const node of nodes) {
      if (!unique.has(node.id)) unique.set(node.id, node);
    }
    const result = Array.from(unique.values()).slice(0, 6);
    this.resourceNodeCache.set(cacheKey, result);
    return [...result];
  }

  clearCache(): void {
    this.collisionCache.clear();
    this.resourceNodeCache.clear();
  }

  private discoverTmjResourceNodes(worldDir: string, mapId: string): ResourceNodeConfig[] {
    const mapDir = this.getMapDir(worldDir, mapId);
    if (!mapDir) return [];
    const tmjPath = path.join(mapDir, "06-final.tmj");
    if (!fs.existsSync(tmjPath)) return [];

    try {
      const tmj = JSON.parse(fs.readFileSync(tmjPath, "utf-8")) as {
        layers?: Array<{ type?: string; name?: string; objects?: Array<Record<string, unknown>> }>;
      };
      const nodes: ResourceNodeConfig[] = [];
      for (const layer of tmj.layers ?? []) {
        if (layer.type !== "objectgroup") continue;
        for (const obj of layer.objects ?? []) {
          const name = String(obj.name ?? obj.type ?? "").trim();
          const layerName = String(layer.name ?? "");
          if (!name && layerName !== "interactive_objects") continue;
          const lowerName = name.toLowerCase();
          const isResource =
            layerName === "interactive_objects" ||
            RESOURCE_KEYWORDS.some((keyword) => lowerName.includes(keyword.toLowerCase()));
          if (!isResource) continue;
          const objectId = extractStringProperty(obj, "objectId");
          const fallbackName = name || objectId || "资源点";
          const nodeId = objectId || `resource_${String(obj.id ?? fallbackName).replace(/\s+/g, "_")}`;
          const width = extractNumber(obj, "width", 64);
          const height = extractNumber(obj, "height", 64);
          nodes.push({
            id: nodeId,
            name: fallbackName,
            locationId: extractStringProperty(obj, "locationId") || "main_area",
            pixelX: Math.round(extractNumber(obj, "x", 0) + width / 2),
            pixelY: Math.round(extractNumber(obj, "y", 0) + height / 2),
            width: Math.round(width),
            height: Math.round(height),
            resourcePerClick: extractNumber(obj, "resourcePerClick", DEFAULT_RESOURCE_PER_CLICK),
            cooldownMs: extractNumber(obj, "cooldownMs", DEFAULT_COOLDOWN_MS),
          });
        }
      }
      return nodes;
    } catch (error) {
      console.warn(`[MapPackageLoader] Failed to discover resource nodes for ${mapId}:`, error);
      return [];
    }
  }

  private loadCollisionGrid(worldDir: string, mapId: string): CollisionGrid | null {
    const cacheKey = `${path.resolve(worldDir)}::${mapId}`;
    const cached = this.collisionCache.get(cacheKey);
    if (cached) return cached;

    const mapDir = this.getMapDir(worldDir, mapId);
    if (!mapDir) return null;
    const tmjPath = path.join(mapDir, "06-final.tmj");
    if (!fs.existsSync(tmjPath)) return null;

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
        return null;
      }
      const grid: CollisionGrid = {
        mapId,
        gridWidth,
        gridHeight,
        tileSize,
        collisionData: collisionData as number[],
      };
      this.collisionCache.set(cacheKey, grid);
      return grid;
    } catch (error) {
      console.warn(`[MapPackageLoader] Failed to load collision grid for ${mapId}:`, error);
      return null;
    }
  }

  private findWalkablePixelNear(
    worldDir: string,
    mapId: string,
    pixelX: number,
    pixelY: number,
    radiusTiles: number,
  ): { x: number; y: number } | null {
    const grid = this.loadCollisionGrid(worldDir, mapId);
    if (!grid) return { x: pixelX, y: pixelY };
    const originX = Math.floor(pixelX / grid.tileSize);
    const originY = Math.floor(pixelY / grid.tileSize);
    if (isTileWalkable(grid, originX, originY)) return { x: pixelX, y: pixelY };
    for (let radius = 1; radius <= radiusTiles; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const gx = originX + dx;
          const gy = originY + dy;
          if (!isTileWalkable(grid, gx, gy)) continue;
          return {
            x: gx * grid.tileSize + grid.tileSize / 2,
            y: gy * grid.tileSize + grid.tileSize / 2,
          };
        }
      }
    }
    return null;
  }
}

function readWorldConfig(worldDir: string): Partial<WorldConfig> {
  const configPath = path.join(worldDir, "config", "world.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<WorldConfig>;
  } catch {
    return {};
  }
}

function readMergedMapWorldConfig(worldDir: string, mapId: string): Partial<WorldConfig> {
  const config = readWorldConfig(worldDir);
  const fragment = readMapWorldFragment(worldDir, config, mapId);
  if (!fragment) return config;
  return {
    ...config,
    locations: Array.isArray(fragment.locations) ? fragment.locations : config.locations,
    mainAreaPoints: Array.isArray(fragment.mainAreaPoints) ? fragment.mainAreaPoints : config.mainAreaPoints,
    worldSize: fragment.worldSize || config.worldSize,
    worldActions: Array.isArray(fragment.worldActions) ? fragment.worldActions : config.worldActions,
  };
}

function readMapWorldFragment(
  worldDir: string,
  config: Partial<WorldConfig>,
  mapId: string,
): Partial<WorldConfig> | null {
  const mapNode = findMapNode(config, mapId);
  const mapDirName = mapNode?.mapDir || mapId;
  if (!isSafeMapId(mapDirName)) return null;
  const fragmentPath = path.join(worldDir, "maps", mapDirName, "world-fragment.json");
  if (!fs.existsSync(fragmentPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(fragmentPath, "utf-8")) as Partial<WorldConfig>;
  } catch (error) {
    console.warn(`[MapPackageLoader] Failed to parse map world fragment: ${fragmentPath}`, error);
    return null;
  }
}

function normalizeSceneConfig(raw: Partial<SceneConfig> | undefined): SceneConfig {
  const sceneType = raw?.sceneType === "open" ? "open" : "closed";
  const tickDurationMinutes = Number.isFinite(raw?.tickDurationMinutes)
    ? Math.max(1, Number(raw?.tickDurationMinutes))
    : 15;
  const startTime = typeof raw?.startTime === "string" && raw.startTime.trim()
    ? raw.startTime.trim()
    : "08:00";
  const displayFormat =
    raw?.displayFormat === "ancient_chinese" || raw?.displayFormat === "fantasy"
      ? raw.displayFormat
      : "modern";
  const multiDayRaw = raw?.multiDay;
  return {
    sceneType,
    startTime,
    tickDurationMinutes,
    maxTicks: sceneType === "open" && Number.isFinite(raw?.maxTicks)
      ? Math.max(1, Number(raw?.maxTicks))
      : null,
    displayFormat,
    description: typeof raw?.description === "string" ? raw.description : "",
    multiDay: {
      enabled: sceneType === "open" ? Boolean(multiDayRaw?.enabled) : false,
      endOfDayText: typeof multiDayRaw?.endOfDayText === "string" ? multiDayRaw.endOfDayText : "",
      newDayText: typeof multiDayRaw?.newDayText === "string" ? multiDayRaw.newDayText : "",
      nextDayStartTime: typeof multiDayRaw?.nextDayStartTime === "string" && multiDayRaw.nextDayStartTime.trim()
        ? multiDayRaw.nextDayStartTime.trim()
        : startTime,
    },
  };
}

function normalizeWorldSize(value: WorldSizeConfig | undefined): WorldSizeConfig | null {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
  return {
    width: Number(value.width),
    height: Number(value.height),
    tileSize: Number.isFinite(value.tileSize) ? Number(value.tileSize) : undefined,
    gridWidth: Number.isFinite(value.gridWidth) ? Number(value.gridWidth) : undefined,
    gridHeight: Number.isFinite(value.gridHeight) ? Number(value.gridHeight) : undefined,
  };
}

function findMapNode(config: Partial<WorldConfig>, mapId: string): WorldMapNodeConfig | null {
  const mapNodes = Array.isArray(config.mapNodes) ? config.mapNodes : [];
  const node = mapNodes.find((item) => item.id === mapId);
  if (node) return node;
  if (mapId === ORIGIN_MAP_ID) {
    return {
      id: ORIGIN_MAP_ID,
      name: "初始地图",
      gridX: 0,
      gridY: 0,
      mapDir: ORIGIN_MAP_ID,
      previewImage: "background-preview.png",
      status: "available",
      createdAt: new Date(0).toISOString(),
    };
  }
  return null;
}

function normalizeMapNodes(config: Partial<WorldConfig>, originName: string): WorldMapNodeConfig[] {
  const maps = Array.isArray(config.mapNodes) ? config.mapNodes : [];
  const normalized = maps
    .filter((map): map is WorldMapNodeConfig =>
      !!map &&
      typeof map.id === "string" &&
      isSafeMapId(map.id) &&
      typeof map.gridX === "number" &&
      typeof map.gridY === "number",
    )
    .map((map) => ({
      ...map,
      mapDir: map.mapDir || map.id,
      previewImage: map.previewImage || "background-preview.png",
      status: map.status || "available",
      createdAt: map.createdAt || new Date(0).toISOString(),
    }));
  if (!normalized.some((map) => map.id === ORIGIN_MAP_ID)) {
    normalized.unshift({
      id: ORIGIN_MAP_ID,
      name: originName || "初始地图",
      gridX: 0,
      gridY: 0,
      mapDir: ORIGIN_MAP_ID,
      previewImage: "background-preview.png",
      status: "available",
      createdAt: new Date(0).toISOString(),
    });
  }
  return normalized;
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

function discoverWorldConfigResourceNodes(config: Partial<WorldConfig>): ResourceNodeConfig[] {
  const nodes: ResourceNodeConfig[] = [];
  for (const loc of config.locations ?? []) {
    for (const obj of loc.objects ?? []) {
      if (!obj.id.startsWith("resource_")) continue;
      const record = obj as unknown as Record<string, unknown>;
      nodes.push({
        id: obj.id,
        name: obj.name,
        locationId: obj.locationId || loc.id,
        pixelX: extractNumber(record, "pixelX", 0),
        pixelY: extractNumber(record, "pixelY", 0),
        width: extractNumber(record, "width", 64),
        height: extractNumber(record, "height", 64),
        resourcePerClick: extractNumber(record, "resourcePerClick", DEFAULT_RESOURCE_PER_CLICK),
        cooldownMs: extractNumber(record, "cooldownMs", DEFAULT_COOLDOWN_MS),
      });
    }
  }
  return nodes;
}

function extractNumber(obj: Record<string, unknown>, key: string, defaultValue: number): number {
  const direct = obj[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string") {
    const parsed = Number(direct);
    if (Number.isFinite(parsed)) return parsed;
  }
  const prop = extractPropertyValue(obj, key);
  if (typeof prop === "number" && Number.isFinite(prop)) return prop;
  if (typeof prop === "string") {
    const parsed = Number(prop);
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultValue;
}

function extractStringProperty(obj: Record<string, unknown>, key: string): string {
  const direct = obj[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const prop = extractPropertyValue(obj, key);
  return typeof prop === "string" && prop.trim() ? prop.trim() : "";
}

function extractPropertyValue(obj: Record<string, unknown>, key: string): unknown {
  const props = obj.properties;
  if (!Array.isArray(props)) return undefined;
  const prop = props.find((item) =>
    item &&
    typeof item === "object" &&
    (item as Record<string, unknown>).name === key,
  ) as Record<string, unknown> | undefined;
  return prop?.value;
}

function isTileWalkable(grid: CollisionGrid, gx: number, gy: number): boolean {
  if (gx < 0 || gy < 0 || gx >= grid.gridWidth || gy >= grid.gridHeight) return false;
  return grid.collisionData[gy * grid.gridWidth + gx] === 0;
}

function isSafeMapId(mapId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(mapId);
}
