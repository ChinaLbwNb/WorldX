import type { WorldManager } from "./world-manager.js";
import type { ResourceNodeConfig, ResourceResult, BuildCosts } from "../types/build.js";
import * as worldState from "../store/world-state-store.js";
import { getWorldDir } from "../utils/config-loader.js";
import fs from "node:fs";
import path from "node:path";

const PLAYER_RESOURCES_KEY = "player_resources";
const DEFAULT_RESOURCE_AMOUNT = 10; // 给玩家一些初始资源以便立即体验
const DEFAULT_RESOURCE_PER_CLICK = 1;
const DEFAULT_COOLDOWN_MS = 2000;

/** 默认建造价格配置 */
export const DEFAULT_BUILD_COSTS: BuildCosts = {
  character: 20,
  mapExpand: 50,
};

// 自动识别为资源点的关键词（中英文）
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

export class ResourceManager {
  private resourceNodes: Map<string, ResourceNodeConfig> = new Map();
  private cooldowns: Map<string, number> = new Map(); // objectId -> lastCollectTime

  constructor(private worldManager: WorldManager) {}

  initialize(): void {
    this.discoverResourceNodes();
    // 确保玩家资源键存在于全局状态中
    const existing = worldState.getGlobalState(PLAYER_RESOURCES_KEY);
    if (existing === null) {
      worldState.setGlobalState(PLAYER_RESOURCES_KEY, String(DEFAULT_RESOURCE_AMOUNT));
    }
  }

  /**
   * Re-discover resource nodes after map expansion.
   * Clears existing nodes and re-runs the discovery process,
   * picking up new resource nodes from the expanded map.
   */
  rediscoverAfterExpansion(): void {
    console.log("[ResourceManager] Re-discovering resource nodes after expansion...");
    this.resourceNodes.clear();
    this.cooldowns.clear();
    this.discoverResourceNodes();
    console.log(`[ResourceManager] Discovered ${this.resourceNodes.size} resource nodes`);
  }

  /**
   * 发现资源点：
   * 1. 先从 location objects 中找 id 以 resource_ 开头的
   * 2. 再从 TMJ 的 interactive_objects 层中找关键词匹配的
   * 3. 如果还没有，就从所有 regions 里挑几个自动变成资源点
   */
  private discoverResourceNodes(): void {
    // 方式1：从 location objects 中找显式标记的资源点
    const locations = this.worldManager.getAllLocations();
    for (const loc of locations) {
      for (const obj of loc.objects) {
        if (!obj.id.startsWith("resource_")) continue;
        const objRecord = obj as unknown as Record<string, unknown>;
        const node: ResourceNodeConfig = {
          id: obj.id,
          name: obj.name,
          locationId: obj.locationId || loc.id,
          pixelX: this.extractNumberFromObject(objRecord, "pixelX", 0),
          pixelY: this.extractNumberFromObject(objRecord, "pixelY", 0),
          width: this.extractNumberFromObject(objRecord, "width", 64),
          height: this.extractNumberFromObject(objRecord, "height", 64),
          resourcePerClick: this.extractNumberFromObject(objRecord, "resourcePerClick", DEFAULT_RESOURCE_PER_CLICK),
          cooldownMs: this.extractNumberFromObject(objRecord, "cooldownMs", DEFAULT_COOLDOWN_MS),
        };
        this.resourceNodes.set(obj.id, node);
      }
    }

    // 方式2：从 TMJ 中读取 interactive_objects，自动识别资源点
    if (this.resourceNodes.size === 0) {
      this.discoverFromTMJ();
    }

    // 方式3：如果还是没有，创建一个默认资源点（在地图中心）
    if (this.resourceNodes.size === 0) {
      this.createDefaultResourceNode();
    }
  }

  /** 从 TMJ 文件的 interactive_objects 层发现资源点 */
  private discoverFromTMJ(): void {
    const worldDir = getWorldDir();
    if (!worldDir) return;

    const tmjPath = path.join(worldDir, "map", "06-final.tmj");
    if (!fs.existsSync(tmjPath)) return;

    try {
      const tmj = JSON.parse(fs.readFileSync(tmjPath, "utf-8"));
      const tileSize = tmj.tilewidth ?? 8;

      for (const layer of tmj.layers ?? []) {
        if (layer.type !== "objectgroup") continue;
        const objects = layer.objects ?? [];

        for (const obj of objects) {
          const name = (obj.name ?? obj.type ?? "") as string;
          if (!name) continue;

          // 检查是否匹配资源关键词
          const lowerName = name.toLowerCase();
          const isResource = RESOURCE_KEYWORDS.some((kw) =>
            lowerName.includes(kw.toLowerCase()),
          );

          if (isResource || layer.name === "interactive_objects") {
            const nodeId = `resource_${obj.id ?? obj.name?.replace(/\s+/g, "_") ?? Math.random().toString(36).slice(2, 8)}`;
            // TMJ 坐标是左上角，转成中心点
            const pixelX = (obj.x ?? 0) + (obj.width ?? 0) / 2;
            const pixelY = (obj.y ?? 0) + (obj.height ?? 0) / 2;

            const node: ResourceNodeConfig = {
              id: nodeId,
              name: `${name}（资源点）`,
              locationId: this.guessLocationId(name, layer.name),
              pixelX: Math.round(pixelX),
              pixelY: Math.round(pixelY),
              width: Math.round(obj.width ?? 64),
              height: Math.round(obj.height ?? 64),
              resourcePerClick: DEFAULT_RESOURCE_PER_CLICK,
              cooldownMs: DEFAULT_COOLDOWN_MS,
            };

            if (!this.resourceNodes.has(nodeId)) {
              this.resourceNodes.set(nodeId, node);
            }
          }
        }
      }

      // 限制最多 6 个资源点，避免太多
      if (this.resourceNodes.size > 6) {
        const entries = Array.from(this.resourceNodes.entries()).slice(0, 6);
        this.resourceNodes = new Map(entries);
      }
    } catch (e) {
      console.warn("[ResourceManager] Failed to parse TMJ for resource nodes:", e);
    }
  }

  /** 根据名字猜测所在区域 */
  private guessLocationId(objName: string, layerName: string): string {
    const allLocations = this.worldManager.getAllLocations();
    if (allLocations.length === 0) return "main_area";

    // 优先匹配名字包含的
    const lowerName = objName.toLowerCase();
    for (const loc of allLocations) {
      if (lowerName.includes(loc.id.toLowerCase()) || lowerName.includes(loc.name.toLowerCase())) {
        return loc.id;
      }
    }
    return "main_area";
  }

  /** 创建默认资源点（在主区域中心附近） */
  private createDefaultResourceNode(): void {
    const center = this.worldManager.getMainAreaCenterPixel();
    const node: ResourceNodeConfig = {
      id: "resource_default_crystal",
      name: "神秘水晶（资源点）",
      locationId: "main_area",
      pixelX: Math.round(center.x + 80),
      pixelY: Math.round(center.y + 60),
      width: 64,
      height: 64,
      resourcePerClick: DEFAULT_RESOURCE_PER_CLICK,
      cooldownMs: DEFAULT_COOLDOWN_MS,
    };
    this.resourceNodes.set(node.id, node);
  }

  /** 从 object 的任意属性中提取数字（利用类型断言访问额外字段） */
  private extractNumberFromObject(
    obj: Record<string, unknown>,
    key: string,
    defaultValue: number,
  ): number {
    const val = obj[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string") {
      const parsed = Number(val);
      if (Number.isFinite(parsed)) return parsed;
    }
    return defaultValue;
  }

  /** 获取所有资源点配置 */
  getAllResourceNodes(): ResourceNodeConfig[] {
    return Array.from(this.resourceNodes.values());
  }

  /** 获取指定资源点配置 */
  getResourceNode(objectId: string): ResourceNodeConfig | undefined {
    return this.resourceNodes.get(objectId);
  }

  /** 获取当前资源数量 */
  getResourceAmount(): number {
    const raw = worldState.getGlobalState(PLAYER_RESOURCES_KEY);
    const amount = raw !== null ? Number(raw) : DEFAULT_RESOURCE_AMOUNT;
    return Number.isFinite(amount) ? amount : DEFAULT_RESOURCE_AMOUNT;
  }

  /**
   * 采集资源
   * @param playerId 玩家 ID（预留，目前单玩家）
   * @param objectId 资源点 ID
   */
  collectResource(playerId: string, objectId: string): ResourceResult {
    const node = this.resourceNodes.get(objectId);
    if (!node) {
      return {
        success: false,
        newAmount: this.getResourceAmount(),
        reason: `Resource node not found: ${objectId}`,
      };
    }

    // 检查冷却
    const now = Date.now();
    const lastCollect = this.cooldowns.get(objectId) ?? 0;
    if (now - lastCollect < node.cooldownMs) {
      return {
        success: false,
        newAmount: this.getResourceAmount(),
        reason: `Resource node is on cooldown. Wait ${node.cooldownMs - (now - lastCollect)}ms`,
      };
    }

    // 增加资源
    const currentAmount = this.getResourceAmount();
    const newAmount = currentAmount + node.resourcePerClick;
    worldState.setGlobalState(PLAYER_RESOURCES_KEY, String(newAmount));

    // 更新冷却时间
    this.cooldowns.set(objectId, now);

    return {
      success: true,
      newAmount,
    };
  }

  /**
   * 消费资源
   * @param amount 消耗数量
   */
  spendResources(amount: number): ResourceResult {
    if (amount < 0) {
      return {
        success: false,
        newAmount: this.getResourceAmount(),
        reason: "Amount must be non-negative",
      };
    }

    const currentAmount = this.getResourceAmount();
    if (currentAmount < amount) {
      return {
        success: false,
        newAmount: currentAmount,
        reason: `Insufficient resources. Need ${amount}, have ${currentAmount}`,
      };
    }

    const newAmount = currentAmount - amount;
    worldState.setGlobalState(PLAYER_RESOURCES_KEY, String(newAmount));

    return {
      success: true,
      newAmount,
    };
  }

  /**
   * 增加资源（用于失败时退还等场景）
   * @param amount 增加数量
   */
  addResources(amount: number): number {
    if (amount <= 0) return this.getResourceAmount();
    const currentAmount = this.getResourceAmount();
    const newAmount = currentAmount + amount;
    worldState.setGlobalState(PLAYER_RESOURCES_KEY, String(newAmount));
    return newAmount;
  }

  /** 获取建造价格配置 */
  getBuildCosts(): BuildCosts {
    return { ...DEFAULT_BUILD_COSTS };
  }

  /** 检查资源点是否处于冷却中 */
  isOnCooldown(objectId: string): boolean {
    const node = this.resourceNodes.get(objectId);
    if (!node) return false;
    const lastCollect = this.cooldowns.get(objectId) ?? 0;
    return Date.now() - lastCollect < node.cooldownMs;
  }

  /** 获取资源点剩余冷却时间（毫秒） */
  getRemainingCooldownMs(objectId: string): number {
    const node = this.resourceNodes.get(objectId);
    if (!node) return 0;
    const lastCollect = this.cooldowns.get(objectId) ?? 0;
    const elapsed = Date.now() - lastCollect;
    return Math.max(0, node.cooldownMs - elapsed);
  }
}
