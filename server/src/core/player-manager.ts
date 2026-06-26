import type { WorldManager } from "./world-manager.js";
import type { PlayerState, PlayerMoveResult } from "../types/build.js";

const PLAYER_NAME = "Player";
const SPAWN_SEARCH_RADIUS_PX = 300;

export class PlayerManager {
  private player: PlayerState | null = null;

  constructor(private worldManager: WorldManager) {}

  initialize(): void {
    this.spawnPlayer();
  }

  /** 初始化玩家，出生在 main_area 中心附近的可行走点 */
  private spawnPlayer(): void {
    const center = this.worldManager.getMainAreaCenterPixel();
    const spawnPoint = this.worldManager.findWalkablePixelNear(
      center.x,
      center.y,
      SPAWN_SEARCH_RADIUS_PX,
    );

    const pixelX = spawnPoint?.x ?? center.x;
    const pixelY = spawnPoint?.y ?? center.y;

    this.player = {
      id: "player",
      name: PLAYER_NAME,
      pixelX,
      pixelY,
      resources: 0,
      isMoving: false,
    };
  }

  /** 获取玩家状态 */
  getPlayerState(): PlayerState {
    if (!this.player) {
      throw new Error("Player not initialized");
    }
    return { ...this.player };
  }

  /**
   * 移动玩家到指定像素坐标
   * 检查目标是否可行走
   */
  moveTo(pixelX: number, pixelY: number): PlayerMoveResult {
    if (!this.player) {
      return {
        success: false,
        reason: "Player not initialized",
      };
    }

    // 验证坐标合法性
    if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
      return {
        success: false,
        playerState: { ...this.player },
        reason: "Invalid pixel coordinates",
      };
    }

    // 检查目标位置是否可行走
    if (!this.worldManager.isPixelWalkable(pixelX, pixelY)) {
      // 尝试找到最近的可行走点
      const nearest = this.worldManager.findWalkablePixelNear(pixelX, pixelY, 100);
      if (!nearest) {
        return {
          success: false,
          playerState: { ...this.player },
          reason: "Target position is not walkable",
        };
      }
      // 移动到最近的可行走点
      this.player.pixelX = nearest.x;
      this.player.pixelY = nearest.y;
      this.player.isMoving = false;
      return {
        success: true,
        playerState: { ...this.player },
        reason: "Target not walkable, moved to nearest walkable position",
      };
    }

    this.player.pixelX = pixelX;
    this.player.pixelY = pixelY;
    this.player.isMoving = false;

    return {
      success: true,
      playerState: { ...this.player },
    };
  }

  /** 同步玩家的资源数量（从 ResourceManager 读取） */
  updateResources(amount: number): void {
    if (!this.player) return;
    this.player.resources = amount;
  }

  /** 重置玩家位置（用于重新生成世界等场景） */
  resetPlayer(): void {
    this.spawnPlayer();
  }
}
