/** 用户角色在线/控制模式。保留 god 仅兼容旧接口；新 UI 不再把它作为玩家模式。 */
export type AvatarMode = "avatar" | "god";

/** 玩家外观 */
export interface PlayerAppearance {
  spriteKey?: string;
  spriteUrl?: string;
  assetStatus?: "pending" | "ready" | "error";
  prompt?: string;
  sourceCharId?: string;
  color: number;
  sizeScale: number;
}

/** 背包物品 */
export interface InventoryItem {
  itemId: string;
  name: string;
  quantity: number;
}

/** 玩家化身运行时状态 */
export interface PlayerAvatarState {
  id: string;
  name: string;
  mode: AvatarMode;
  location: string;
  mainAreaPointId: string | null;
  x: number;
  y: number;
  currentAction: string | null;
  currentActionTarget: string | null;
  actionStartTick: number;
  actionEndTick: number;
  isOnline: boolean;
  isControlledByLLM: boolean;
  appearance: PlayerAppearance;
  inventory: InventoryItem[];
}

/** 用户拥有的可操作角色。NPC 不使用该结构。 */
export interface UserCharacter {
  id: string;
  userId: string;
  name: string;
  appearance: PlayerAppearance;
  inventory: InventoryItem[];
  createdAt?: string;
  updatedAt?: string;
}

/** 用户角色在当前时间线/地图里的运行时状态。 */
export interface UserCharacterRuntime {
  characterId: string;
  worldId: string;
  timelineId: string;
  currentMapId: string;
  location: string;
  mainAreaPointId: string | null;
  x: number;
  y: number;
  isOnline: boolean;
  isControlledByLLM: boolean;
  currentAction: string | null;
  currentActionTarget: string | null;
  actionStartTick: number;
  actionEndTick: number;
}

/** 当前阶段的 Presence 与 Runtime 等价，后续可扩展连接、设备和会话信息。 */
export type UserPresence = UserCharacterRuntime;

/** 玩家记忆 */
export interface PlayerMemory {
  id: string;
  playerId: string;
  type: "observation" | "experience" | "conversation" | "reflection";
  content: string;
  gameDay: number;
  gameTick: number;
  importance: number;
  emotionalValence: number;
  emotionalIntensity: number;
  relatedCharacters: string[];
  relatedLocation: string;
  tags: string[];
}
