/**
 * 建造系统类型定义
 */

/** 玩家状态 */
export interface PlayerState {
  id: "player";
  name: string;
  pixelX: number;  // 像素坐标
  pixelY: number;
  resources: number;  // 资源数量
  isMoving: boolean;
}

/** 资源点配置（扩展自 ObjectConfig） */
export interface ResourceNodeConfig {
  id: string;
  name: string;
  locationId: string;
  pixelX: number;
  pixelY: number;
  width: number;
  height: number;
  resourcePerClick: number;  // 每次点击获得的资源
  cooldownMs: number;  // 冷却时间(毫秒)
}

/** 建造价格配置 */
export interface BuildCosts {
  character: number;  // 生成新角色消耗
  mapExpand: number;  // 扩展地图消耗
}

/** 资源操作结果 */
export interface ResourceResult {
  success: boolean;
  newAmount: number;
  reason?: string;
}

/** 玩家移动结果 */
export interface PlayerMoveResult {
  success: boolean;
  playerState?: PlayerState;
  reason?: string;
}

/** 建造 Job 状态 */
export interface BuildJobStatus {
  jobId: string;
  status: "running" | "done" | "error";
  progress: number;
  message?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}
