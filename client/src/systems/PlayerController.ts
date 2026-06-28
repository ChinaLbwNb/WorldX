import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { MapManager } from "../systems/MapManager";
import { PathfindingManager } from "../systems/PathfindingManager";
import { CameraController } from "../systems/CameraController";
import { CharacterSprite } from "../objects/CharacterSprite";
import { createCharacterDisplayMetrics, SPRITE_FRAME_HEIGHT, SPRITE_FRAME_WIDTH } from "../config/game-config";
import { networkManager } from "../systems/NetworkManager";
import { apiClient } from "../ui/services/api-client";

const PLAYER_SPEED_PX_PER_SEC = 300;
const POSITION_SYNC_INTERVAL_MS = 200;

export type PlayerMode = "avatar" | "god";

export interface PlayerAvatarData {
  id: string;
  name: string;
  mode: PlayerMode;
  location: string;
  mainAreaPointId: string | null;
  x: number;
  y: number;
  currentAction: string | null;
  currentActionTarget: string | null;
  isOnline: boolean;
  isControlledByLLM: boolean;
  appearance: {
    color: number;
    sizeScale: number;
    spriteKey?: string;
    spriteUrl?: string;
    assetStatus?: "pending" | "ready" | "error";
    prompt?: string;
    sourceCharId?: string;
  };
  inventory: Array<{ itemId: string; name: string; quantity: number }>;
}

export class PlayerController {
  private scene: Phaser.Scene;
  private mapManager: MapManager;
  private pathfinder: PathfindingManager;
  private cameraController: CameraController;
  private eventBus: Phaser.Events.EventEmitter;

  playerSprite: CharacterSprite | null = null;
  mode: PlayerMode = "avatar";
  private isMoving = false;
  private targetPosition: { x: number; y: number } | null = null;
  private lastServerSyncTime = 0;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private clickMoveEnabled = true;
  private entityLayer: Phaser.GameObjects.Container;
  private mapPixelWidth: number;
  private mapPixelHeight: number;
  private borrowedSpriteId: string | null = null;
  private playerId: string | null = null;
  /** WebSocket 连接时收到的玩家数据 */
  private playerData: PlayerAvatarData | null = null;
  private pendingFocusPulse = false;
  private handleSetPlayerMode = (mode: PlayerMode) => {
    void this.setMode(mode);
  };
  private handleNetworkConnected = (data: any) => {
    if (!data?.playerId || !data?.player) return;
    void this.applyLocalPlayerData({
      playerId: data.playerId,
      player: data.player,
    });
  };
  private handleLocalUserCharacterChanged = (character: any) => {
    if (!character?.id) return;
    void this.applyLocalPlayerData({
      playerId: character.id,
      player: {
        id: character.id,
        name: character.name,
        mode: "avatar",
        location: character.location,
        mainAreaPointId: character.mainAreaPointId,
        x: character.x,
        y: character.y,
        currentAction: null,
        currentActionTarget: null,
        isOnline: character.online ?? true,
        isControlledByLLM: false,
        appearance: character.appearance,
        inventory: character.inventory ?? [],
      },
    });
  };
  private handleClickMoveEnabled = (enabled: boolean) => {
    this.clickMoveEnabled = enabled;
  };
  private handlePointerDown = (pointer: Phaser.Input.Pointer) => {
    if (!this.clickMoveEnabled || this.mode !== "avatar") return;
    if (pointer.rightButtonDown()) return;

    const worldPoint = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.moveTo(worldPoint.x, worldPoint.y);
  };

  constructor(
    scene: Phaser.Scene,
    mapManager: MapManager,
    pathfinder: PathfindingManager,
    cameraController: CameraController,
    entityLayer: Phaser.GameObjects.Container,
    mapPixelWidth: number,
    mapPixelHeight: number,
  ) {
    this.scene = scene;
    this.mapManager = mapManager;
    this.pathfinder = pathfinder;
    this.cameraController = cameraController;
    this.eventBus = EventBus.instance;
    this.entityLayer = entityLayer;
    this.mapPixelWidth = mapPixelWidth;
    this.mapPixelHeight = mapPixelHeight;
  }

  async initialize(): Promise<void> {
    // 立即设置输入（不等待 WebSocket）
    this.setupKeyboardInput();
    this.setupClickMove();
    this.setupEventListeners();

    // 立即获取精灵图（同步，不依赖 WebSocket）
    try {
      const characters = await apiClient.getCharacters();
      if (characters.length > 0) {
        this.borrowedSpriteId = characters[0].id;
      }
    } catch {
      // 忽略
    }

    await this.bootstrapSelectedUserCharacter();

    // 连接成功后立即创建本地用户角色；进入地图就是操控自己的角色。
    void this.waitForConnection().then(() => {
      if (this.playerData && !this.playerSprite) {
        void this.createPlayerSprite({ ...this.playerData, mode: "avatar" }).then(() => {
          console.log("[UserCharacterController] Local user character ready:", this.playerId);
          this.focusSelf(true);
          this.eventBus.emit("player_mode_changed", "avatar");
        });
      }
    });
  }

  private async bootstrapSelectedUserCharacter(): Promise<void> {
    const selectedId = networkManager.getSelectedUserCharacterId();
    console.log("[UserCharacterController] Bootstrap selected id:", selectedId || "(none)");
    if (!selectedId || this.playerSprite) return;
    try {
      const response = await apiClient.getUserCharacters();
      const character = response.characters.find((item) => item.id === selectedId);
      if (!character) {
        console.warn("[UserCharacterController] Selected user character not found for current user:", selectedId);
        return;
      }
      this.playerId = character.id;
      this.playerData = {
        id: character.id,
        name: character.name,
        mode: "avatar",
        location: character.location,
        mainAreaPointId: character.mainAreaPointId,
        x: character.x,
        y: character.y,
        currentAction: null,
        currentActionTarget: null,
        isOnline: character.online,
        isControlledByLLM: false,
        appearance: character.appearance,
        inventory: character.inventory,
      };
      await this.createPlayerSprite(this.playerData);
      console.log("[UserCharacterController] Bootstrapped selected user character:", selectedId);
    } catch (error) {
      console.warn("[UserCharacterController] Failed to bootstrap selected user character:", error);
    }
  }

  private waitForConnection(): Promise<void> {
    return new Promise((resolve) => {
      const connected = networkManager.getConnectedPlayerData();
      if (connected?.player) {
        this.playerId = connected.playerId;
        this.playerData = connected.player;
        resolve();
        return;
      }
      const handler = (data: any) => {
        this.playerId = data.playerId;
        this.playerData = data.player;
        this.eventBus.off("network_connected", handler);
        resolve();
      };
      this.eventBus.on("network_connected", handler);
    });
  }

  private async applyLocalPlayerData(data: { playerId: string; player: PlayerAvatarData }): Promise<void> {
    const previousPlayerId = this.playerId;
    this.playerId = data.playerId;
    this.playerData = { ...data.player, mode: "avatar" };
    this.mode = "avatar";
    this.isMoving = false;
    this.targetPosition = null;
    if (this.playerSprite) {
      this.playerSprite.destroy();
      this.playerSprite = null;
    }
    await this.createPlayerSprite(this.playerData);
    this.eventBus.emit("local_player_id_changed", {
      previousPlayerId,
      playerId: this.playerId,
    });
    this.eventBus.emit("player_mode_changed", "avatar");
  }

  private async createPlayerSprite(state: PlayerAvatarData): Promise<void> {
    if (this.playerSprite) {
      this.playerSprite.destroy();
      this.playerSprite = null;
    }
    const displayMetrics = createCharacterDisplayMetrics(
      this.mapPixelWidth,
      this.mapPixelHeight,
    );

    const ownSpriteId = await this.ensureUserCharacterTexture(state);
    const spriteCharId = ownSpriteId ?? this.borrowedSpriteId ?? this.findAnySpriteTexture() ?? this.playerId ?? "player_1";

    this.playerSprite = new CharacterSprite(this.scene, state.x, state.y, {
      characterId: spriteCharId,
      name: state.name,
      color: state.appearance?.color ?? 0xffd700,
      displayMetrics,
    });

    this.playerSprite.setDepth(20);
    this.playerSprite.currentLocationId = state.location;
    this.playerSprite.mainAreaPointId = state.mainAreaPointId;

    this.entityLayer.add(this.playerSprite);

    this.focusSelf(true);
    if (this.pendingFocusPulse) {
      this.pendingFocusPulse = false;
      this.focusSelf(true);
    }
  }

  focusSelf(showPulse = false): void {
    if (!this.playerSprite) {
      this.pendingFocusPulse = showPulse || this.pendingFocusPulse;
      return;
    }
    console.log("[UserCharacterController] Camera following user character:", this.playerId);
    this.scene.cameras.main.startFollow(this.playerSprite, true, 0.08, 0.08);
    this.cameraController.setKeyboardPanEnabled(false);

    if (!showPulse) return;
    const pulse = this.scene.add.container(this.playerSprite.x, this.playerSprite.y).setDepth(80);
    const ring = this.scene.add.graphics();
    ring.lineStyle(4, 0xffd54a, 0.95);
    ring.strokeCircle(0, 0, 34);
    pulse.add(ring);
    this.entityLayer.add(pulse);
    this.scene.tweens.add({
      targets: pulse,
      scale: 2.2,
      alpha: 0,
      duration: 850,
      ease: "Cubic.easeOut",
      onComplete: () => pulse.destroy(),
    });
  }

  /** 在已加载的纹理中查找任意精灵图 */
  private findAnySpriteTexture(): string | null {
    for (const key of this.scene.textures.getTextureKeys()) {
      if (key.startsWith("char_")) return key;
    }
    return null;
  }

  private async ensureUserCharacterTexture(state: PlayerAvatarData): Promise<string | null> {
    const spriteUrl = state.appearance?.spriteUrl;
    const spriteKey = state.appearance?.spriteKey || (state.id ? `user_character_${state.id}` : "");
    if (!spriteUrl || !spriteKey) return null;
    if (this.scene.textures.exists(spriteKey)) return spriteKey;
    return new Promise((resolve) => {
      this.scene.load.spritesheet(spriteKey, spriteUrl, {
        frameWidth: SPRITE_FRAME_WIDTH,
        frameHeight: SPRITE_FRAME_HEIGHT,
      });
      this.scene.load.once(Phaser.Loader.Events.COMPLETE, () => {
        if (this.scene.textures.exists(spriteKey)) {
          this.scene.textures.get(spriteKey).setFilter(Phaser.Textures.FilterMode.LINEAR);
          resolve(spriteKey);
          return;
        }
        resolve(null);
      });
      this.scene.load.once("loaderror", () => resolve(null));
      this.scene.load.start();
    });
  }

  private setupKeyboardInput(): void {
    if (!this.scene.input.keyboard) return;
    this.keys = {
      W: this.scene.input.keyboard.addKey("W", false),
      A: this.scene.input.keyboard.addKey("A", false),
      S: this.scene.input.keyboard.addKey("S", false),
      D: this.scene.input.keyboard.addKey("D", false),
    };
  }

  private setupClickMove(): void {
    this.scene.input.on("pointerdown", this.handlePointerDown);
  }

  private setupEventListeners(): void {
    this.eventBus.on("set_player_mode", this.handleSetPlayerMode);
    this.eventBus.on("network_connected", this.handleNetworkConnected);
    this.eventBus.on("local_user_character_changed", this.handleLocalUserCharacterChanged);
    this.eventBus.on("set_click_move_enabled", this.handleClickMoveEnabled);
    this.eventBus.on("focus_user_character", this.handleFocusUserCharacter, this);
  }

  private handleFocusUserCharacter(): void {
    this.focusSelf(true);
  }

  update(delta: number): void {
    if (this.mode !== "avatar" || !this.playerSprite) return;
    this.handleKeyboardMovement(delta);
    this.syncPositionToServer();
  }

  private handleKeyboardMovement(delta: number): void {
    if (!this.playerSprite) return;
    const speed = PLAYER_SPEED_PX_PER_SEC * (delta / 1000);
    let dx = 0;
    let dy = 0;

    if (this.keys.W?.isDown) dy -= speed;
    if (this.keys.S?.isDown) dy += speed;
    if (this.keys.A?.isDown) dx -= speed;
    if (this.keys.D?.isDown) dx += speed;

    if (dx === 0 && dy === 0) {
      this.isMoving = false;
      this.playerSprite.setWalkDirection(0, 0);
      return;
    }

    this.isMoving = true;
    this.targetPosition = null;

    const newX = this.playerSprite.x + dx;
    const newY = this.playerSprite.y + dy;

    const grid = this.mapManager.pixelToGrid(newX, newY);
    if (this.mapManager.isWalkable(grid.gx, grid.gy)) {
      this.playerSprite.setPosition(newX, newY);
      this.playerSprite.setWalkDirection(dx, dy);
    }
  }

  private async moveTo(x: number, y: number): Promise<void> {
    if (!this.playerSprite) return;

    const startGrid = this.mapManager.pixelToGrid(
      this.playerSprite.x,
      this.playerSprite.y,
    );
    const endGrid = this.mapManager.pixelToGrid(x, y);

    if (!this.mapManager.isWalkable(endGrid.gx, endGrid.gy)) return;

    const path = await this.pathfinder.findPath(
      startGrid.gx, startGrid.gy, endGrid.gx, endGrid.gy,
    );

    if (path && path.length > 0) {
      this.targetPosition = { x, y };
      this.playerSprite.walkAlongPath(path, () => {
        this.targetPosition = null;
      });
    }
  }

  private syncPositionToServer(): void {
    if (!this.playerSprite || !this.playerId) return;

    const now = performance.now();
    if (now - this.lastServerSyncTime < POSITION_SYNC_INTERVAL_MS) return;
    this.lastServerSyncTime = now;

    const location = this.mapManager.getLocationAtPixel(
      this.playerSprite.x,
      this.playerSprite.y,
    );

    networkManager.sendPosition(
      this.playerSprite.x,
      this.playerSprite.y,
      location || "main_area",
      this.playerSprite.mainAreaPointId,
    );
  }

  async setMode(mode: PlayerMode): Promise<void> {
    if (mode === this.mode) return;
    this.mode = mode;

    if (this.playerId) {
      networkManager.sendMode(mode);
    }

    if (mode === "god") {
      if (this.playerSprite) {
        this.playerSprite.destroy();
        this.playerSprite = null;
      }
      this.scene.cameras.main.stopFollow();
      this.cameraController.setKeyboardPanEnabled(true);
    } else {
      // 使用 WebSocket 连接时收到的玩家数据，或从 API 获取
      let state = this.playerData;
      if (!state) {
        try {
          state = await apiClient.getPlayerAvatar();
        } catch {
          // 忽略
        }
      }
      void this.createPlayerSprite(state ?? {
        id: this.playerId ?? "player_1",
        name: "旅行者",
        mode: "avatar",
        location: "main_area",
        mainAreaPointId: null,
        x: this.mapPixelWidth / 2,
        y: this.mapPixelHeight / 2,
        currentAction: null,
        currentActionTarget: null,
        isOnline: true,
        isControlledByLLM: false,
        appearance: { color: 0xffd700, sizeScale: 1.0 },
        inventory: [],
      });
    }

    this.eventBus.emit("player_mode_changed", mode);
  }

  toggleMode(): void {
    const newMode = this.mode === "avatar" ? "god" : "avatar";
    void this.setMode(newMode);
  }

  destroy(): void {
    if (this.playerSprite) {
      this.playerSprite.destroy();
      this.playerSprite = null;
    }
    this.scene.cameras.main.stopFollow();
    this.cameraController.setKeyboardPanEnabled(true);
    this.scene.input.off("pointerdown", this.handlePointerDown);
    this.eventBus.off("set_player_mode", this.handleSetPlayerMode);
    this.eventBus.off("network_connected", this.handleNetworkConnected);
    this.eventBus.off("local_user_character_changed", this.handleLocalUserCharacterChanged);
    this.eventBus.off("set_click_move_enabled", this.handleClickMoveEnabled);
    this.eventBus.off("focus_user_character", this.handleFocusUserCharacter, this);
  }
}
