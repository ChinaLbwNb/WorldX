import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { MapManager } from "../systems/MapManager";
import { PathfindingManager } from "../systems/PathfindingManager";
import { CharacterMovement } from "../systems/CharacterMovement";
import { PlaybackController } from "../systems/PlaybackController";
import { CameraController } from "../systems/CameraController";
import { CharacterSprite } from "../objects/CharacterSprite";
import { isMultiplayerMode } from "../config/app-mode";
import { getCharacterColor, actionToEmoji, createCharacterDisplayMetrics, SPRITE_FRAME_WIDTH, SPRITE_FRAME_HEIGHT } from "../config/game-config";
import { UserCharacterController } from "../systems/UserCharacterController";
import { networkManager } from "../systems/NetworkManager";
import { RemoteUserCharacterManager } from "../systems/RemoteUserCharacterManager";
import { apiClient } from "../ui/services/api-client";
import type { InventoryItemInfo, ItemTransferInfo, MapItemPlacementInfo } from "../ui/services/api-client";
import type { CharacterInfo, DialogueEventData, SimulationEvent, BuildState } from "../types/api";
import { withAssetAuth } from "../utils/asset-url";

/** 资源点（前端友好字段名，由 API 的 BuildResourceNode 归一化而来）。 */
interface ResourceNodeNormalized {
  objectId: string;
  name: string;
  locationId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  resourcePerClick: number;
  cooldownMs: number;
  remaining: number;
}

type DialoguePlaybackTurn = {
  speaker: string;
  content: string;
  innerMonologue?: string;
  participants?: string[];
};

type DialoguePlaybackLane = {
  queue: DialoguePlaybackTurn[];
  timer: Phaser.Time.TimerEvent | null;
};

type BackgroundTileManifest = {
  width: number;
  height: number;
  tiles: Array<{
    key: string;
    path: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

type ItemPlacementMode = {
  item: InventoryItemInfo;
  footprintTiles: { width: number; height: number };
  visualScale: number;
  rotation: number;
};

type ItemTransferEventPayload = {
  scope?: { worldId: string; timelineId: string; mapId: string };
  transfer?: ItemTransferInfo;
  actor?: { userId?: string; userCharacterId?: string };
  target?: { userId?: string };
};

const ITEM_PLACEMENT_MIN_VISUAL_SCALE = 0.5;
const ITEM_PLACEMENT_MAX_VISUAL_SCALE = 3;
const ITEM_PLACEMENT_VISUAL_SCALE_STEP = 0.1;
const ITEM_PLACEMENT_ROTATION_STEP_DEG = 15;

// Frontend-only dialogue playback tuning. Search these names to adjust pacing.
const FRONTEND_DIALOGUE_BUBBLE_MS = 5000;
const FRONTEND_DIALOGUE_INNER_MONOLOGUE_TAIL_MS = 1500;

function getScopedUserCharacterId(): string | undefined {
  if (!isMultiplayerMode) return undefined;
  return networkManager.getSelectedUserCharacterId() || networkManager.getPlayerId() || undefined;
}

export class WorldScene extends Phaser.Scene {
  private mapManager!: MapManager;
  private pathfinder!: PathfindingManager;
  private characterMovement!: CharacterMovement;
  private characterSprites: Map<string, CharacterSprite> = new Map();
  private playbackController!: PlaybackController;
  private cameraController!: CameraController;
  private playerController!: UserCharacterController;
  private remotePlayerManager!: RemoteUserCharacterManager;
  private eventBus!: Phaser.Events.EventEmitter;
  private entityLayer!: Phaser.GameObjects.Container;
  private dialoguePlaybackLanes: Map<string, DialoguePlaybackLane> = new Map();
  private dialogueEventChain: Promise<void> = Promise.resolve();
  private mapPixelWidth = 8192;
  private mapPixelHeight = 4608;
  private walkableOverlay: Phaser.GameObjects.Graphics | null = null;
  private regionBoundsOverlay: Phaser.GameObjects.Container | null = null;
  private mainAreaPointsOverlay: Phaser.GameObjects.Graphics | null = null;
  private interactiveObjectsOverlay: Phaser.GameObjects.Container | null = null;
  private interactiveHoverGraphics: Phaser.GameObjects.Graphics | null = null;
  private interactiveHoverLabelContainer: Phaser.GameObjects.Container | null = null;
  private interactiveHoverLabelText: Phaser.GameObjects.Text | null = null;
  private interactiveHoverLabelBg: Phaser.GameObjects.Graphics | null = null;
  private lastObservedDay: number | null = null;
  private isReplaying = false;
  private tickPlaybackActive = false;
  private tickPlaybackEventsFlushed = false;
  private pendingPlaybackAsyncOps = 0;
  private pendingDialogueCleanupTimers = 0;
  private playbackCompletionCheckTimer: Phaser.Time.TimerEvent | null = null;
  // 建造/资源系统（本地用户角色由 UserCharacterController 管理）
  private buildState: BuildState | null = null;
  private resourceNodes: Map<string, ResourceNodeNormalized> = new Map();
  private resourceMarkers: Phaser.GameObjects.Container | null = null;
  private collectButtonContainer: Phaser.GameObjects.Container | null = null;
  private collectButtonHitZone: Phaser.GameObjects.Zone | null = null;
  private collectButtonBg: Phaser.GameObjects.Graphics | null = null;
  private collectButtonText: Phaser.GameObjects.Text | null = null;
  private nearbyResourceObjectId: string | null = null;
  private readonly COLLECT_INTERACTION_RADIUS = 120;
  private resourceTooltipContainer: Phaser.GameObjects.Container | null = null;
  private resourceTooltipBg: Phaser.GameObjects.Graphics | null = null;
  private resourceTooltipText: Phaser.GameObjects.Text | null = null;
  private itemPlacementLayer: Phaser.GameObjects.Container | null = null;
  private itemPlacementPreview: Phaser.GameObjects.Container | null = null;
  private itemPlacementPreviewGraphics: Phaser.GameObjects.Graphics | null = null;
  private itemPlacementPreviewImage: Phaser.GameObjects.Image | null = null;
  private itemPlacementPreviewText: Phaser.GameObjects.Text | null = null;
  private activeItemPlacement: ItemPlacementMode | null = null;
  private itemPlacementBusy = false;
  private loadingItemAssetKeys: Set<string> = new Set();
  private itemActionMenu: Phaser.GameObjects.Container | null = null;
  private itemActionMenuPlacementId: string | null = null;
  private transferRequestQueue: ItemTransferInfo[] = [];
  private activeTransferRequest: ItemTransferInfo | null = null;
  private transferRequestModal: Phaser.GameObjects.Container | null = null;
  private transferRequestBusy = false;
  private sceneEventCleanups: Array<() => void> = [];
  private multiplayerEventCleanups: Array<() => void> = [];

  constructor() {
    super("WorldScene");
  }

  create() {
    console.log("[WorldScene] create() called");
    this.eventBus = EventBus.instance;
    let tiledJSON: any = null;

    try {
      tiledJSON = this.cache.json.get("world-map");
      this.mapManager = new MapManager();
      this.mapManager.loadFromTiledJSON(tiledJSON);
      console.log("[WorldScene] Map parsed:", this.mapManager.getAllLocationIds());
    } catch (e) {
      console.error("[WorldScene] Failed to parse map:", e);
      this.mapManager = new MapManager();
    }

    const backgroundTiles = this.cache.json.get("world-background-tiles") as BackgroundTileManifest | undefined;
    const hasBg = this.textures.exists("world-base");
    const tiledMapSize = this.getTiledMapPixelSize(tiledJSON);
    let bgWidth = tiledMapSize.width;
    let bgHeight = tiledMapSize.height;
    const backgroundLayer = this.add.container(0, 0).setDepth(-50);
    if (backgroundTiles?.tiles?.length) {
      bgWidth = backgroundTiles.width;
      bgHeight = backgroundTiles.height;
      let renderedTiles = 0;
      const missingTiles: BackgroundTileManifest["tiles"] = [];
      for (const tile of backgroundTiles.tiles) {
        if (!this.textures.exists(tile.key)) {
          missingTiles.push(tile);
          continue;
        }
        backgroundLayer.add(this.add.image(tile.x, tile.y, tile.key).setOrigin(0, 0));
        renderedTiles += 1;
      }
      console.log(`[WorldScene] Tiled background loaded: ${bgWidth}x${bgHeight}, tiles=${renderedTiles}/${backgroundTiles.tiles.length}`);
      if (missingTiles.length > 0) {
        console.warn(`[WorldScene] Missing background tile texture(s), queueing runtime load: ${missingTiles.map((tile) => tile.key).join(", ")}`);
        this.load.once(Phaser.Loader.Events.COMPLETE, () => {
          let repairedTiles = 0;
          for (const tile of missingTiles) {
            if (!this.textures.exists(tile.key)) continue;
            backgroundLayer.add(this.add.image(tile.x, tile.y, tile.key).setOrigin(0, 0));
            repairedTiles += 1;
          }
          console.log(`[WorldScene] Runtime background tile repair loaded ${repairedTiles}/${missingTiles.length}`);
        });
        const mapAssetPrefix = String(this.registry.get("mapAssetPrefix") || "/assets/maps/map_origin");
        for (const tile of missingTiles) {
          this.load.image(tile.key, withAssetAuth(`${mapAssetPrefix}/${tile.path}`));
        }
        this.load.start();
      }
      if (renderedTiles < backgroundTiles.tiles.length) {
        console.warn("[WorldScene] Incomplete background tiles rendered, showing fallback underneath");
        this.add.rectangle(bgWidth / 2, bgHeight / 2, bgWidth, bgHeight, 0x0b1020).setDepth(-100);
        this.add.text(24, 24, `Background tiles ${renderedTiles}/${backgroundTiles.tiles.length}`, {
          fontFamily: "Arial",
          fontSize: "24px",
          color: "#ffffff",
          backgroundColor: "#1f2937",
          padding: { x: 10, y: 6 },
        }).setScrollFactor(0).setDepth(10000);
      }
    } else if (hasBg) {
      const rendered = this.renderWorldBaseBackground(backgroundLayer);
      bgWidth = rendered.width;
      bgHeight = rendered.height;
      console.log(`[WorldScene] Background loaded: ${bgWidth}x${bgHeight} (${rendered.mode})`);
    } else {
      console.warn("[WorldScene] Background texture not found, using fallback");
      const fallbackBg = this.add.rectangle(bgWidth / 2, bgHeight / 2, bgWidth, bgHeight, 0x0b1020).setDepth(-100);
      void this.loadDomTiledBackground(backgroundLayer, fallbackBg);
    }

    this.entityLayer = this.add.container(0, 0);
    this.entityLayer.setDepth(10);
    this.itemPlacementLayer = this.add.container(0, 0);
    this.itemPlacementLayer.setDepth(8);
    this.mapPixelWidth = bgWidth;
    this.mapPixelHeight = bgHeight;
    this.setupInteractiveObjectHover();

    this.pathfinder = new PathfindingManager(this.mapManager);

    const initialCenter = this.getInitialCameraCenter(bgWidth, bgHeight);
    this.cameraController = new CameraController(this, bgWidth, bgHeight, initialCenter);
    console.log("[WorldScene] Camera centered on:", initialCenter);

    this.characterMovement = new CharacterMovement(
      this.mapManager,
      this.pathfinder,
      this.characterSprites
    );

    this.playerController = new UserCharacterController(
      this,
      this.mapManager,
      this.pathfinder,
      this.cameraController,
      this.entityLayer,
      this.mapPixelWidth,
      this.mapPixelHeight,
    );

    this.remotePlayerManager = new RemoteUserCharacterManager(
      this,
      this.entityLayer,
      this.mapPixelWidth,
      this.mapPixelHeight,
    );

    if (isMultiplayerMode) {
      this.setupItemPlacementMode();
      this.setupMapItemRealtimeEvents();
      this.setupTransferRequestOverlay();
    }

    // 先注册多人事件处理器，再连接 WebSocket（避免丢消息）
    if (isMultiplayerMode) {
      this.setupMultiplayerEvents();
    }
    // 已选用户角色足以复用账号角色身份；昵称仅作为旧入口兼容。
    // 没有角色也没有昵称时仍交给 JoinGate，避免创建匿名旅行者。
    if (isMultiplayerMode && (networkManager.getSelectedUserCharacterId() || networkManager.getStoredName())) {
      networkManager.connect();
    }

    this.playbackController = new PlaybackController(this.eventBus);
    this.playbackController.on("event", this.handleSimEvent, this);

    this.onSceneEvent("follow_character", (charId: string) => {
      const sprite = this.characterSprites.get(charId);
      if (sprite) this.cameraController.followCharacter(sprite);
    });
    this.onSceneEvent("unfollow_character", () => {
      this.cameraController.stopFollowing();
    });
    this.onSceneEvent("dev_advance_tick", () => {
      this.playbackController.devAdvanceTick();
    });
    this.onSceneEvent("set_auto_play", (enabled: boolean) => {
      if (this.playbackController.getMode() === "replay") {
        this.playbackController.setReplayAutoPlay(enabled);
      } else {
        this.playbackController.setAutoPlay(enabled);
      }
    });
    this.onSceneEvent("set_tick_interval", (intervalMs: number) => {
      this.playbackController.setTickIntervalMs(intervalMs);
    });
    this.onSceneEvent("set_cycle_ticks", (cycleTicks: number) => {
      this.playbackController.setCycleTicks(cycleTicks);
    });
    this.onSceneEvent("start_replay", (timelineId: string) => {
      void this.playbackController.startReplay(timelineId);
    });
    this.onSceneEvent("stop_replay", () => {
      this.playbackController.stopReplay();
    });
    this.onSceneEvent("replay_ended", () => {
      void this.syncCharactersFromServer();
    });
    this.onSceneEvent("set_replay_mode", (payload: { active: boolean }) => {
      this.isReplaying = payload.active;
    });
    this.onSceneEvent("replay_init", (initFrame: any) => {
      this.handleReplayInit(initFrame);
    });
    const onTimeUpdate = (time: { day: number }) => {
      this.lastObservedDay = time.day;
    };
    const onSceneSyncCharacters = () => {
      void this.trackPlaybackAsync(this.handleSceneDayChange());
    };
    const onTickPlaybackStarted = () => {
      this.tickPlaybackActive = true;
      this.tickPlaybackEventsFlushed = false;
      if (this.playbackCompletionCheckTimer) {
        this.playbackCompletionCheckTimer.remove(false);
        this.playbackCompletionCheckTimer = null;
      }
    };
    const onTickPlaybackEventsFlushed = () => {
      this.tickPlaybackEventsFlushed = true;
      this.scheduleTickPlaybackCompletionCheck();
    };
    const onToggleWalkableOverlay = (visible: boolean) => {
      this.setWalkableOverlayVisible(visible);
    };
    const onToggleRegionBoundsOverlay = (visible: boolean) => {
      this.setRegionBoundsOverlayVisible(visible);
    };
    const onToggleMainAreaPointsOverlay = (visible: boolean) => {
      this.setMainAreaPointsOverlayVisible(visible);
    };
    const onToggleInteractiveObjectsOverlay = (visible: boolean) => {
      this.setInteractiveObjectsOverlayVisible(visible);
    };
    this.eventBus.on("toggle_debug_walkable_overlay", onToggleWalkableOverlay);
    this.eventBus.on("toggle_debug_region_bounds_overlay", onToggleRegionBoundsOverlay);
    this.eventBus.on("toggle_debug_main_area_points_overlay", onToggleMainAreaPointsOverlay);
    this.eventBus.on("toggle_debug_interactive_objects_overlay", onToggleInteractiveObjectsOverlay);
    this.eventBus.on("time_update", onTimeUpdate);
    this.eventBus.on("scene_sync_characters", onSceneSyncCharacters);
    this.eventBus.on("npc_roster_changed", onSceneSyncCharacters);
    this.eventBus.on("tick_playback_started", onTickPlaybackStarted);
    this.eventBus.on("tick_playback_events_flushed", onTickPlaybackEventsFlushed);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.eventBus.off("toggle_debug_walkable_overlay", onToggleWalkableOverlay);
      this.eventBus.off("toggle_debug_region_bounds_overlay", onToggleRegionBoundsOverlay);
      this.eventBus.off("toggle_debug_main_area_points_overlay", onToggleMainAreaPointsOverlay);
      this.eventBus.off("toggle_debug_interactive_objects_overlay", onToggleInteractiveObjectsOverlay);
      this.eventBus.off("time_update", onTimeUpdate);
      this.eventBus.off("scene_sync_characters", onSceneSyncCharacters);
      this.eventBus.off("npc_roster_changed", onSceneSyncCharacters);
      this.eventBus.off("tick_playback_started", onTickPlaybackStarted);
      this.eventBus.off("tick_playback_events_flushed", onTickPlaybackEventsFlushed);
      this.cancelItemPlacementMode(false);
      this.hideItemActionMenu();
      this.destroyTransferRequestModal();
      this.clearSceneEvents();
      this.clearMultiplayerEvents();
      this.playerController?.destroy();
      this.remotePlayerManager?.destroy();
      networkManager.disconnect();
    });

    this.initAsync();
  }

  private renderWorldBaseBackground(
    backgroundLayer: Phaser.GameObjects.Container,
  ): { width: number; height: number; mode: "single" | "tiled" } {
    const texture = this.textures.get("world-base");
    const source = texture.getSourceImage() as CanvasImageSource & { width?: number; height?: number };
    const sourceWidth = Math.floor(Number(source?.width ?? 0));
    const sourceHeight = Math.floor(Number(source?.height ?? 0));
    const maxTextureSize = this.getMaxTextureSize();
    const shouldTile = Boolean(sourceWidth > 0 && sourceHeight > 0)
      && (sourceWidth > Math.min(2048, maxTextureSize) || sourceHeight > Math.min(2048, maxTextureSize));

    if (!shouldTile) {
      const bg = this.add.image(0, 0, "world-base").setOrigin(0, 0);
      backgroundLayer.add(bg);
      return { width: bg.width, height: bg.height, mode: "single" };
    }

    const tileSize = Math.max(256, Math.min(1024, maxTextureSize || 1024));
    let renderedTiles = 0;
    for (let y = 0; y < sourceHeight; y += tileSize) {
      for (let x = 0; x < sourceWidth; x += tileSize) {
        const width = Math.min(tileSize, sourceWidth - x);
        const height = Math.min(tileSize, sourceHeight - y);
        const key = `world-base-canvas-tile-${x}-${y}`;
        if (!this.textures.exists(key)) {
          const tileTexture = this.textures.createCanvas(key, width, height);
          if (!tileTexture) continue;
          const ctx = tileTexture.getContext();
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
          tileTexture.refresh();
        }
        backgroundLayer.add(this.add.image(x, y, key).setOrigin(0, 0));
        renderedTiles += 1;
      }
    }
    console.log(`[WorldScene] Rendered tiled background from source image: ${renderedTiles} tile(s), maxTexture=${maxTextureSize}`);
    return { width: sourceWidth, height: sourceHeight, mode: "tiled" };
  }

  private getMaxTextureSize(): number {
    const renderer = this.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer | Phaser.Renderer.Canvas.CanvasRenderer;
    const gl = "gl" in renderer ? renderer.gl : null;
    if (!gl) return 4096;
    return Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
  }

  private async loadDomTiledBackground(
    backgroundLayer: Phaser.GameObjects.Container,
    fallbackBg: Phaser.GameObjects.Rectangle,
  ): Promise<void> {
    const backgroundUrl = String(this.registry.get("mapBackgroundUrl") || `${this.registry.get("mapAssetPrefix") || "/assets/maps/map_origin"}/06-background.png`);
    try {
      const separator = backgroundUrl.includes("?") ? "&" : "?";
      const image = await this.loadHtmlImage(withAssetAuth(`${backgroundUrl}${separator}runtimeDomTile=${Date.now()}`));
      const rendered = this.renderImageAsCanvasTiles(backgroundLayer, image);
      if (rendered.tiles <= 0) {
        console.warn(`[WorldScene] DOM tiled background produced no tiles: ${backgroundUrl}`);
        return;
      }
      this.mapPixelWidth = rendered.width;
      this.mapPixelHeight = rendered.height;
      this.cameraController?.updateMapBounds(rendered.width, rendered.height);
      fallbackBg.destroy();
      console.log(`[WorldScene] DOM tiled background loaded: ${rendered.width}x${rendered.height}, tiles=${rendered.tiles}`);
    } catch (error) {
      console.warn(`[WorldScene] DOM tiled background failed: ${backgroundUrl}`, error);
    }
  }

  private loadHtmlImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = document.createElement("img");
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Image failed to decode: ${url}`));
      image.src = url;
    });
  }

  private renderImageAsCanvasTiles(
    backgroundLayer: Phaser.GameObjects.Container,
    image: HTMLImageElement,
  ): { width: number; height: number; tiles: number } {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const tileSize = Math.max(256, Math.min(1024, this.getMaxTextureSize() || 1024));
    let renderedTiles = 0;
    for (let y = 0; y < sourceHeight; y += tileSize) {
      for (let x = 0; x < sourceWidth; x += tileSize) {
        const width = Math.min(tileSize, sourceWidth - x);
        const height = Math.min(tileSize, sourceHeight - y);
        const key = `world-base-canvas-tile-${x}-${y}`;
        if (!this.textures.exists(key)) {
          const tileTexture = this.textures.createCanvas(key, width, height);
          if (!tileTexture) continue;
          const ctx = tileTexture.getContext();
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(image, x, y, width, height, 0, 0, width, height);
          tileTexture.refresh();
        }
        backgroundLayer.add(this.add.image(x, y, key).setOrigin(0, 0));
        renderedTiles += 1;
      }
    }
    return { width: sourceWidth, height: sourceHeight, tiles: renderedTiles };
  }

  private getTiledMapPixelSize(tiledJSON: any): { width: number; height: number } {
    const width = Number(tiledJSON?.width) * Number(tiledJSON?.tilewidth);
    const height = Number(tiledJSON?.height) * Number(tiledJSON?.tileheight);
    return {
      width: Number.isFinite(width) && width > 0 ? width : 8192,
      height: Number.isFinite(height) && height > 0 ? height : 4608,
    };
  }

  private async initAsync() {
    try {
      const worldInfo = await apiClient.getWorldInfo(getScopedUserCharacterId());
      this.mapManager.setMainAreaPoints(worldInfo.mainAreaPoints || []);
      const pointCenter = this.getMainAreaPointsCenter();
      if (pointCenter) {
        this.cameraController.panTo(pointCenter.x, pointCenter.y, 0);
      }
      if (this.regionBoundsOverlay || this.mainAreaPointsOverlay || this.interactiveObjectsOverlay) {
        this.refreshDebugOverlays();
      }
      if (isMultiplayerMode) {
        await this.reloadMapItemPlacements();
      }
    } catch (e) {
      console.warn("[WorldScene] Failed to load world navigation:", e);
    }

    try {
      await this.initCharacters();
    } catch (e) {
      console.warn("[WorldScene] Failed to load characters:", e);
    }

    // 传递 NPC 精灵图 ID 给远程玩家管理器
    const npcIds = Array.from(this.characterSprites.keys());
    if (isMultiplayerMode) {
      this.remotePlayerManager.setBorrowedSpriteIds(npcIds);
    }

    try {
      await this.playbackController.initialize();
    } catch (e) {
      console.warn("[WorldScene] Failed to initialize playback:", e);
    }

    if (isMultiplayerMode) {
      try {
        await this.playerController.initialize();
      } catch (e) {
        console.warn("[WorldScene] Failed to initialize player:", e);
      }
    }

    if (isMultiplayerMode) {
      try {
        await this.initBuildSystem();
      } catch (e) {
        console.warn("[WorldScene] Failed to init build system:", e);
      }
    }

    console.log("[WorldScene] Async init complete, sprites:", this.characterSprites.size);

    // 时序兜底：异步初始化期间若精灵图才就绪，把仍是圆形 fallback 的角色升级为精灵。
    this.upgradeCharacterSprites();
  }

  private async initCharacters() {
    await this.syncCharactersFromServer();
  }

  private getInitialCameraCenter(bgWidth: number, bgHeight: number): { x: number; y: number } {
    const visibleLocations = this.mapManager.getVisibleLocations();
    if (visibleLocations.length > 0) {
      const minX = Math.min(...visibleLocations.map((loc) => loc.x));
      const minY = Math.min(...visibleLocations.map((loc) => loc.y));
      const maxX = Math.max(...visibleLocations.map((loc) => loc.x + loc.width));
      const maxY = Math.max(...visibleLocations.map((loc) => loc.y + loc.height));
      return {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
      };
    }
    return { x: bgWidth / 2, y: bgHeight / 2 };
  }

  private getMainAreaPointsCenter(): { x: number; y: number } | null {
    const points = this.mapManager.getMainAreaPoints();
    if (points.length === 0) return null;
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  }

  /**
   * 初始化资源采集 / 建造系统。
   * 本地用户角色由 UserCharacterController 管理，这里只接入资源点、标记、采集按钮，
   * 不创建任何用户角色精灵、不接管点击移动（采集就近检测挂在本地用户角色上）。
   */
  private async initBuildSystem(): Promise<void> {
    try {
      const userCharacterId = getScopedUserCharacterId();
      const state = await apiClient.getBuildState(userCharacterId);
      this.buildState = state;
      this.resourceNodes.clear();
      for (const node of state.resourceNodes) {
        const normalized: ResourceNodeNormalized = {
          objectId: node.id,
          name: node.name,
          locationId: node.locationId,
          x: node.pixelX - node.width / 2,
          y: node.pixelY - node.height / 2,
          width: node.width,
          height: node.height,
          resourcePerClick: node.resourcePerClick,
          cooldownMs: node.cooldownMs,
          remaining: 999, // 概念上无限，受冷却时间限制
        };
        this.resourceNodes.set(normalized.objectId, normalized);
      }

      this.setupResourceMarkers();
      this.setupResourceInteraction();
      this.setupCollectButton();

      this.eventBus.emit("build_state_updated", state);
    } catch (e) {
      console.warn("[WorldScene] Build system not available:", e);
    }
  }

  /** 当前本地用户角色精灵（avatar 模式下存在，god 模式为 null）。 */
  private getLocalAvatarSprite(): CharacterSprite | null {
    return this.playerController?.playerSprite ?? null;
  }

  /** 资源点直接复用地图里的可交互对象，不再额外绘制独立资源素材。 */
  private setupResourceMarkers(): void {
    this.resourceMarkers?.destroy(true);
    this.resourceMarkers = null;
  }

  private showResourceTooltip(x: number, y: number, text: string): void {
    if (!this.resourceTooltipContainer) {
      this.resourceTooltipContainer = this.add.container(0, 0);
      this.resourceTooltipContainer.setDepth(50);
      this.resourceTooltipBg = this.add.graphics();
      this.resourceTooltipText = this.add.text(0, 0, "", {
        fontSize: "13px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: "#ffffff",
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 2,
      }).setOrigin(0.5, 0.5);
      this.resourceTooltipContainer.add([this.resourceTooltipBg, this.resourceTooltipText]);
    }
    if (!this.resourceTooltipBg || !this.resourceTooltipText) return;

    this.resourceTooltipText.setText(text);
    const textW = this.resourceTooltipText.width;
    const textH = this.resourceTooltipText.height;
    this.resourceTooltipBg.clear();
    this.resourceTooltipBg.fillStyle(0x000000, 0.75);
    this.resourceTooltipBg.fillRoundedRect(-textW / 2 - 12, -textH / 2 - 6, textW + 24, textH + 12, 6);
    this.resourceTooltipContainer.setPosition(x, y);
    this.resourceTooltipContainer.setVisible(true);
  }

  private hideResourceTooltip(): void {
    this.resourceTooltipContainer?.setVisible(false);
  }

  private setupResourceInteraction(): void {
    for (const object of this.mapManager.getInteractiveObjects()) {
      const node = this.resourceNodes.get(object.objectId);
      if (!node) continue;
      const zones = this.children.getAll().filter(
        (child) =>
          child instanceof Phaser.GameObjects.Zone &&
          child.x === object.x &&
          child.y === object.y,
      );
      for (const zone of zones) {
        (zone as Phaser.GameObjects.Zone).on(
          "pointerdown",
          (
            _pointer: Phaser.Input.Pointer,
            _localX: number,
            _localY: number,
            event: Phaser.Types.Input.EventData,
          ) => {
            event.stopPropagation();
          this.handleResourceClick(node.objectId);
          },
        );
      }
    }
  }

   /**
   * 点击资源点：若本地化身已在采集半径内则弹出采集按钮；
   * 否则不接管移动（用户角色用 UserCharacterController 的点击/键盘走过去）。
   */
  private handleResourceClick(objectId: string): void {
    const avatar = this.getLocalAvatarSprite();
    if (!avatar) return;
    const node = this.resourceNodes.get(objectId);
    if (!node) return;
    const targetX = node.x + node.width / 2;
    const targetY = node.y + node.height + 20;
    const dist = Phaser.Math.Distance.Between(avatar.x, avatar.y, targetX, targetY);
    if (dist <= this.COLLECT_INTERACTION_RADIUS) {
      this.showCollectButton(objectId);
    }
  }

  private setupCollectButton(): void {
    this.collectButtonContainer = this.add.container(0, 0);
    this.collectButtonContainer.setDepth(30);
    this.collectButtonContainer.setVisible(false);

    this.collectButtonHitZone = this.add
      .zone(0, 0, 88, 40)
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true });
    this.collectButtonBg = this.add.graphics();
    this.collectButtonText = this.add
      .text(0, 0, "采集", {
        fontSize: "14px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: "#ffffff",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);

    this.collectButtonContainer.add([this.collectButtonHitZone, this.collectButtonBg, this.collectButtonText]);
    this.collectButtonContainer.setSize(88, 40);

    this.collectButtonHitZone.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.setCollectButtonPressed(true);
      if (this.nearbyResourceObjectId) {
        this.collectResource(this.nearbyResourceObjectId);
      }
    });
    this.collectButtonHitZone.on("pointerup", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.setCollectButtonPressed(false);
    });
    this.collectButtonHitZone.on("pointerupoutside", (_pointer: Phaser.Input.Pointer, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.setCollectButtonPressed(false);
    });
    this.collectButtonHitZone.on("pointerover", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.setCanvasCursor("pointer");
      this.collectButtonText?.setStyle({ color: "#a3f7bf" });
    });
    this.collectButtonHitZone.on("pointerout", (_pointer: Phaser.Input.Pointer, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.setCanvasCursor("default");
      this.setCollectButtonPressed(false);
      this.collectButtonText?.setStyle({ color: "#ffffff" });
    });
  }

  private setCanvasCursor(cursor: string): void {
    const canvas = this.sys.game.canvas;
    if (canvas) {
      canvas.style.cursor = cursor;
    }
  }

  private setupItemPlacementMode(): void {
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.activeItemPlacement) return;
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.updateItemPlacementPreview(worldPoint.x, worldPoint.y);
    });
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.activeItemPlacement || this.itemPlacementBusy) return;
      if (pointer.rightButtonDown()) {
        this.cancelItemPlacementMode(true);
        return;
      }
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      void this.placeActiveItem(worldPoint.x, worldPoint.y);
    });
    this.input.keyboard?.on("keydown-ESC", () => {
      if (this.activeItemPlacement) this.cancelItemPlacementMode(true);
    });
    this.input.keyboard?.on("keydown", (event: KeyboardEvent) => {
      if (!this.activeItemPlacement || this.itemPlacementBusy) return;
      if (event.key === "[" || event.key === "-" || event.key === "_") {
        this.adjustActiveItemPlacementScale(-ITEM_PLACEMENT_VISUAL_SCALE_STEP);
        event.preventDefault();
      } else if (event.key === "]" || event.key === "=" || event.key === "+") {
        this.adjustActiveItemPlacementScale(ITEM_PLACEMENT_VISUAL_SCALE_STEP);
        event.preventDefault();
      } else if (event.key.toLowerCase() === "q" || event.key === "," || event.key === "<") {
        this.adjustActiveItemPlacementRotation(-ITEM_PLACEMENT_ROTATION_STEP_DEG);
        event.preventDefault();
      } else if (event.key.toLowerCase() === "e" || event.key === "." || event.key === ">") {
        this.adjustActiveItemPlacementRotation(ITEM_PLACEMENT_ROTATION_STEP_DEG);
        event.preventDefault();
      }
    });
    this.onSceneEvent("begin_item_placement", (payload: { item: InventoryItemInfo }) => {
      this.beginItemPlacement(payload.item);
    });
    this.onSceneEvent("cancel_item_placement", () => {
      this.cancelItemPlacementMode(true);
    });
  }

  private setupMapItemRealtimeEvents(): void {
    const handleMapItemsChanged = () => {
      void this.reloadMapItemPlacements();
    };
    this.eventBus.on("map_item_placed", handleMapItemsChanged);
    this.eventBus.on("map_item_picked_up", handleMapItemsChanged);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.eventBus.off("map_item_placed", handleMapItemsChanged);
      this.eventBus.off("map_item_picked_up", handleMapItemsChanged);
    });
  }

  private setupTransferRequestOverlay(): void {
    this.onSceneEvent("item_transfer_requested", (payload: ItemTransferEventPayload) => {
      this.enqueueIncomingTransferRequest(payload);
    });
    this.onSceneEvent("item_transfer_completed", (payload: ItemTransferEventPayload) => {
      this.removeTransferRequest(payload.transfer?.id);
    });
    this.onSceneEvent("item_transfer_cancelled", (payload: ItemTransferEventPayload) => {
      this.removeTransferRequest(payload.transfer?.id);
    });
  }

  private enqueueIncomingTransferRequest(payload: ItemTransferEventPayload): void {
    const transfer = payload.transfer;
    const currentUserId = networkManager.getUserId();
    if (!transfer || transfer.status !== "requested") return;
    if (transfer.toOwner?.ownerType !== "account" || transfer.toOwner.ownerId !== currentUserId) return;
    if (this.activeTransferRequest?.id === transfer.id) return;
    if (this.transferRequestQueue.some((item) => item.id === transfer.id)) return;
    this.transferRequestQueue.push(transfer);
    this.showNextTransferRequest();
  }

  private removeTransferRequest(transferId?: string): void {
    if (!transferId) return;
    this.transferRequestQueue = this.transferRequestQueue.filter((item) => item.id !== transferId);
    if (this.activeTransferRequest?.id === transferId) {
      this.destroyTransferRequestModal();
      this.activeTransferRequest = null;
      this.transferRequestBusy = false;
      this.showNextTransferRequest();
    }
  }

  private showNextTransferRequest(): void {
    if (this.activeTransferRequest || this.transferRequestBusy) return;
    const next = this.transferRequestQueue.shift();
    if (!next) return;
    this.activeTransferRequest = next;
    this.renderTransferRequestModal(next);
  }

  private renderTransferRequestModal(transfer: ItemTransferInfo): void {
    this.destroyTransferRequestModal();
    const width = 430;
    const height = transfer.kind === "trade" ? 224 : 196;
    const x = Math.round(this.scale.width / 2 - width / 2);
    const y = 108;
    const container = this.add.container(x, y).setDepth(5000).setScrollFactor(0);
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.35);
    shadow.fillRoundedRect(5, 7, width, height, 14);
    const bg = this.add.graphics();
    bg.fillStyle(0x111827, 0.97);
    bg.fillRoundedRect(0, 0, width, height, 14);
    bg.lineStyle(2, 0x60a5fa, 0.75);
    bg.strokeRoundedRect(0, 0, width, height, 14);
    const accent = this.add.graphics();
    accent.fillStyle(transfer.kind === "trade" ? 0xf59e0b : 0x38bdf8, 1);
    accent.fillRoundedRect(0, 0, 6, height, 3);

    const title = this.add.text(24, 20, transfer.kind === "trade" ? "交换请求" : "赠送请求", {
      fontSize: "20px",
      fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
      color: "#f8fafc",
      fontStyle: "bold",
    });
    const fromName = stringMetadata(transfer.metadata, "fromCharacterName") || "其他玩家";
    const itemName = transfer.item?.name || "未知物品";
    const headline = transfer.kind === "trade"
      ? `${fromName} 想用「${itemName}」交换你的物品`
      : `${fromName} 想赠送你「${itemName}」`;
    const body = this.add.text(24, 58, headline, {
      fontSize: "15px",
      fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
      color: "#dbeafe",
      wordWrap: { width: width - 48 },
      lineSpacing: 5,
    });
    const detailText = transfer.kind === "trade"
      ? `将换走你的物品：${stringMetadata(transfer.metadata, "requestedItemName") || "未指定"}`
      : "接受后物品会进入你的账号背包。";
    const detail = this.add.text(24, 111, detailText, {
      fontSize: "13px",
      fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
      color: "#94a3b8",
      wordWrap: { width: width - 48 },
    });
    const accept = this.createTransferModalButton(width - 208, height - 56, 88, 36, transfer.kind === "trade" ? "交换" : "接收", 0x2563eb, () => {
      void this.respondToActiveTransferRequest(true);
    });
    const reject = this.createTransferModalButton(width - 108, height - 56, 84, 36, "拒绝", 0x374151, () => {
      void this.respondToActiveTransferRequest(false);
    });
    const close = this.add
      .text(width - 26, 24, "×", {
        fontSize: "22px",
        fontFamily: "Arial, sans-serif",
        color: "#cbd5e1",
      })
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true });
    close.on("pointerdown", (_pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.deferActiveTransferRequest();
    });

    container.add([shadow, bg, accent, title, body, detail, ...accept, ...reject, close]);
    this.transferRequestModal = container;
    this.tweens.add({
      targets: container,
      y: y + 8,
      alpha: { from: 0, to: 1 },
      duration: 160,
      ease: "Sine.easeOut",
    });
  }

  private createTransferModalButton(
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
    color: number,
    onClick: () => void,
  ): Phaser.GameObjects.GameObject[] {
    const bg = this.add.graphics();
    bg.fillStyle(color, 0.96);
    bg.fillRoundedRect(x, y, width, height, 9);
    bg.lineStyle(1, 0xffffff, 0.18);
    bg.strokeRoundedRect(x, y, width, height, 9);
    const text = this.add.text(x + width / 2, y + height / 2, label, {
      fontSize: "15px",
      fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
      color: "#ffffff",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5);
    const zone = this.add.zone(x + width / 2, y + height / 2, width, height)
      .setInteractive({ useHandCursor: true });
    zone.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      if (!this.transferRequestBusy) onClick();
    });
    zone.on("pointerover", () => {
      bg.clear();
      bg.fillStyle(lightenColor(color), 1);
      bg.fillRoundedRect(x, y, width, height, 9);
      bg.lineStyle(1, 0xffffff, 0.26);
      bg.strokeRoundedRect(x, y, width, height, 9);
    });
    zone.on("pointerout", () => {
      bg.clear();
      bg.fillStyle(color, 0.96);
      bg.fillRoundedRect(x, y, width, height, 9);
      bg.lineStyle(1, 0xffffff, 0.18);
      bg.strokeRoundedRect(x, y, width, height, 9);
    });
    return [bg, text, zone];
  }

  private async respondToActiveTransferRequest(accept: boolean): Promise<void> {
    const transfer = this.activeTransferRequest;
    if (!transfer || this.transferRequestBusy) return;
    this.transferRequestBusy = true;
    try {
      await apiClient.respondItemTransfer(transfer.id, accept);
      this.flashPlacementMessage(
        accept
          ? transfer.kind === "trade" ? "交换已完成" : "已接收物品"
          : transfer.kind === "trade" ? "已拒绝交换" : "已拒绝赠送",
        accept,
      );
      this.eventBus.emit("inventory_changed");
      this.destroyTransferRequestModal();
      this.activeTransferRequest = null;
      this.transferRequestBusy = false;
      this.showNextTransferRequest();
    } catch (error) {
      this.transferRequestBusy = false;
      this.flashPlacementMessage(error instanceof Error ? error.message : "交易处理失败", false);
    }
  }

  private deferActiveTransferRequest(): void {
    if (!this.activeTransferRequest || this.transferRequestBusy) return;
    this.transferRequestQueue.push(this.activeTransferRequest);
    this.activeTransferRequest = null;
    this.destroyTransferRequestModal();
    this.time.delayedCall(250, () => this.showNextTransferRequest());
  }

  private destroyTransferRequestModal(): void {
    this.transferRequestModal?.destroy(true);
    this.transferRequestModal = null;
  }

  private beginItemPlacement(item: InventoryItemInfo): void {
    if (!item.placeable) return;
    this.activeItemPlacement = {
      item,
      footprintTiles: this.normalizeFootprintFromItem(item),
      visualScale: 1,
      rotation: 0,
    };
    this.itemPlacementBusy = false;
    this.eventBus.emit("set_click_move_enabled", false);
    this.setCanvasCursor("copy");
    this.ensureItemPlacementPreview();
    this.prepareItemPlacementPreviewAsset(item);
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.updateItemPlacementPreview(worldPoint.x, worldPoint.y);
    this.eventBus.emit("item_placement_mode_changed", { active: true, item });
  }

  private cancelItemPlacementMode(emit = true): void {
    this.activeItemPlacement = null;
    this.itemPlacementBusy = false;
    this.itemPlacementPreview?.setVisible(false);
    this.eventBus.emit("set_click_move_enabled", true);
    this.setCanvasCursor("default");
    if (emit) {
      this.eventBus.emit("item_placement_mode_changed", { active: false });
    }
  }

  private adjustActiveItemPlacementScale(delta: number): void {
    if (!this.activeItemPlacement) return;
    const current = this.activeItemPlacement.visualScale;
    this.activeItemPlacement.visualScale = normalizeItemVisualScale(current + delta);
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.updateItemPlacementPreview(worldPoint.x, worldPoint.y);
  }

  private adjustActiveItemPlacementRotation(deltaDegrees: number): void {
    if (!this.activeItemPlacement) return;
    this.activeItemPlacement.rotation = normalizeItemRotationDegrees(this.activeItemPlacement.rotation + deltaDegrees);
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.updateItemPlacementPreview(worldPoint.x, worldPoint.y);
  }

  private ensureItemPlacementPreview(): void {
    if (this.itemPlacementPreview) return;
    this.itemPlacementPreview = this.add.container(0, 0).setDepth(90);
    this.itemPlacementPreviewGraphics = this.add.graphics();
    this.itemPlacementPreviewImage = this.add.image(0, 0, "").setOrigin(0.5, 0.5).setAlpha(0.88).setVisible(false);
    this.itemPlacementPreviewText = this.add
      .text(0, 0, "", {
        fontSize: "13px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: "#ffffff",
        backgroundColor: "rgba(0,0,0,0.58)",
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 1);
    this.itemPlacementPreview.add([this.itemPlacementPreviewGraphics, this.itemPlacementPreviewImage, this.itemPlacementPreviewText]);
  }

  private updateItemPlacementPreview(pixelX: number, pixelY: number): void {
    if (!this.activeItemPlacement || !this.itemPlacementPreview || !this.itemPlacementPreviewGraphics || !this.itemPlacementPreviewText) return;
    const preview = this.itemPlacementPreview;
    const graphics = this.itemPlacementPreviewGraphics;
    const label = this.itemPlacementPreviewText;
    const tileSize = this.mapManager.tileSize;
    const tileX = Math.floor(pixelX / tileSize);
    const tileY = Math.floor(pixelY / tileSize);
    const { width, height } = this.activeItemPlacement.footprintTiles;
    const start = this.getFootprintStartTile(tileX, tileY, width, height);
    const ok = this.isFootprintWalkable(start.gx, start.gy, width, height);
    const x = start.gx * tileSize;
    const y = start.gy * tileSize;
    const rectW = width * tileSize;
    const rectH = height * tileSize;

    preview.setVisible(true);
    preview.setPosition(x, y);
    graphics.clear();
    graphics.fillStyle(ok ? 0x38d87a : 0xff5b5b, 0.28);
    graphics.fillRect(0, 0, rectW, rectH);
    graphics.lineStyle(2, ok ? 0xa6f0c6 : 0xffb3b3, 0.95);
    graphics.strokeRect(0, 0, rectW, rectH);
    this.updateItemPlacementPreviewImage(rectW, rectH, ok);
    const scaleLabel = `${Math.round(this.activeItemPlacement.visualScale * 100)}%`;
    const rotationLabel = `${Math.round(this.activeItemPlacement.rotation)}°`;
    label.setText(ok
      ? `点击摆放 · ${scaleLabel} · ${rotationLabel} · [ ]缩放 Q/E旋转`
      : `不可摆放 · ${scaleLabel} · ${rotationLabel}`);
    label.setPosition(rectW / 2, -5);
  }

  private prepareItemPlacementPreviewAsset(item: InventoryItemInfo): void {
    const asset = getItemAssetDescriptor(item.metadata, item.definitionId);
    if (!asset) {
      this.itemPlacementPreviewImage?.setVisible(false);
      return;
    }
    this.loadItemAssetTexture(asset, () => {
      if (this.activeItemPlacement?.item.entryId !== item.entryId) return;
      const pointer = this.input.activePointer;
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.updateItemPlacementPreview(worldPoint.x, worldPoint.y);
    });
  }

  private updateItemPlacementPreviewImage(width: number, height: number, ok: boolean): void {
    if (!this.activeItemPlacement || !this.itemPlacementPreviewImage) return;
    const asset = getItemAssetDescriptor(this.activeItemPlacement.item.metadata, this.activeItemPlacement.item.definitionId);
    if (!asset || !this.textures.exists(asset.key)) {
      this.itemPlacementPreviewImage.setVisible(false);
      return;
    }
    if (this.itemPlacementPreviewImage.texture.key !== asset.key) {
      this.itemPlacementPreviewImage.setTexture(asset.key);
    }
    const scale = Math.min(width / Math.max(1, this.itemPlacementPreviewImage.width), height / Math.max(1, this.itemPlacementPreviewImage.height))
      * 0.92
      * this.activeItemPlacement.visualScale;
    this.itemPlacementPreviewImage
      .setPosition(width / 2, height / 2)
      .setScale(scale)
      .setRotation(Phaser.Math.DegToRad(this.activeItemPlacement.rotation))
      .setAlpha(ok ? 0.9 : 0.42)
      .setTint(ok ? 0xffffff : 0xffb3b3)
      .setVisible(true);
  }

  private async placeActiveItem(pixelX: number, pixelY: number): Promise<void> {
    if (!this.activeItemPlacement || this.itemPlacementBusy) return;
    if (!isMultiplayerMode) return;
    const placement = this.activeItemPlacement;
    const tileSize = this.mapManager.tileSize;
    const tileX = Math.floor(pixelX / tileSize);
    const tileY = Math.floor(pixelY / tileSize);
    const start = this.getFootprintStartTile(tileX, tileY, placement.footprintTiles.width, placement.footprintTiles.height);
    if (!this.isFootprintWalkable(start.gx, start.gy, placement.footprintTiles.width, placement.footprintTiles.height)) {
      this.flashPlacementMessage("这里不能摆放", false);
      return;
    }

    const userCharacterId = getScopedUserCharacterId() || "";
    if (!userCharacterId) {
      this.flashPlacementMessage("请先选择角色", false);
      return;
    }

    this.itemPlacementBusy = true;
    try {
      const result = await apiClient.placeInventoryItem({
        userCharacterId,
        entryId: placement.item.entryId,
        x: tileX * tileSize + tileSize / 2,
        y: tileY * tileSize + tileSize / 2,
        rotation: placement.rotation,
        footprintTiles: placement.footprintTiles,
        visualScale: placement.visualScale,
      });
      this.renderMapItemPlacement(result.placement);
      this.applyPlacementCollision([result.placement], "append");
      this.eventBus.emit("item_placed", result);
      this.eventBus.emit("inventory_changed");
      this.flashPlacementMessage("已摆放", true);
      this.cancelItemPlacementMode(true);
    } catch (error) {
      this.itemPlacementBusy = false;
      this.flashPlacementMessage(error instanceof Error ? error.message : "摆放失败", false);
    }
  }

  private async reloadMapItemPlacements(): Promise<void> {
    if (!isMultiplayerMode) return;
    try {
      const userCharacterId = getScopedUserCharacterId();
      const response = await apiClient.getMapItemPlacements({ userCharacterId });
      this.itemPlacementLayer?.removeAll(true);
      this.applyPlacementCollision(response.placements, "replace");
      for (const placement of response.placements) {
        this.renderMapItemPlacement(placement);
      }
    } catch (error) {
      console.warn("[WorldScene] Failed to load map item placements:", error);
    }
  }

  private renderMapItemPlacement(placement: MapItemPlacementInfo): void {
    if (!this.itemPlacementLayer) return;
    const footprint = normalizeFootprintObject(placement.metadata?.footprintTiles);
    const tileSize = this.mapManager.tileSize;
    const centerTileX = Number(placement.metadata?.tileX ?? Math.floor(placement.x / tileSize));
    const centerTileY = Number(placement.metadata?.tileY ?? Math.floor(placement.y / tileSize));
    const start = this.getFootprintStartTile(centerTileX, centerTileY, footprint.width, footprint.height);
    const x = start.gx * tileSize;
    const y = start.gy * tileSize;
    const collisionWidth = footprint.width * tileSize;
    const collisionHeight = footprint.height * tileSize;
    const visualScale = normalizeItemVisualScale(placement.metadata?.visualScale);
    const visualSize = getItemVisualSize(footprint, visualScale);
    const rotationRadians = normalizeItemRotationRadians(placement.rotation);
    const visualX = x + collisionWidth / 2 - visualSize.width / 2;
    const visualY = y + collisionHeight / 2 - visualSize.height / 2;

    const container = this.add.container(visualX, visualY).setDepth(8);
    container.setData("placementId", placement.id);
    container.setSize(visualSize.width, visualSize.height);
    const children: Phaser.GameObjects.GameObject[] = [];
    const fallbackChildren = this.createItemPlacementFallback(placement, visualSize.width, visualSize.height, rotationRadians);
    children.push(...fallbackChildren);
    const hitZone = this.add
      .zone(visualSize.width / 2, visualSize.height / 2, Math.max(visualSize.width, 32), Math.max(visualSize.height, 32))
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true });
    hitZone.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      pointer.event?.stopPropagation?.();
      this.showItemActionMenu(placement, visualX + visualSize.width / 2, visualY);
      });
    container.add([...children, hitZone]);
    this.itemPlacementLayer.add(container);
    this.attachItemAssetSprite(container, placement, visualSize.width, visualSize.height, fallbackChildren, rotationRadians);
  }

  private createItemPlacementFallback(
    placement: MapItemPlacementInfo,
    width: number,
    height: number,
    rotationRadians: number,
  ): Phaser.GameObjects.GameObject[] {
    const group = this.add.container(width / 2, height / 2).setRotation(rotationRadians);
    const shape = this.add.graphics();
    shape.fillStyle(colorForItemName(placement.name), 0.84);
    shape.fillRoundedRect(-width / 2, -height / 2, width, height, 8);
    shape.lineStyle(2, 0xffffff, 0.42);
    shape.strokeRoundedRect(-width / 2, -height / 2, width, height, 8);
    const label = this.add
      .text(0, 0, placement.name.slice(0, 6), {
        fontSize: "13px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0.5);
    group.add([shape, label]);
    return [group];
  }

  private showItemActionMenu(placement: MapItemPlacementInfo, x: number, y: number): void {
    this.hideItemActionMenu();
    this.itemActionMenuPlacementId = placement.id;
    const canPickup =
      placement.placedBy?.ownerType === "account"
      && placement.placedBy.ownerId === networkManager.getUserId();
    const menu = this.add.container(x, Math.max(8, y - 10)).setDepth(120);
    const bg = this.add.graphics();
    bg.fillStyle(0x101923, 0.94);
    bg.fillRoundedRect(-58, -42, 116, 40, 8);
    bg.lineStyle(1, 0xffffff, 0.18);
    bg.strokeRoundedRect(-58, -42, 116, 40, 8);
    const ownershipLabel = this.add
      .text(canPickup ? -34 : -24, -22, canPickup ? "收回" : "他人物品", {
        fontSize: "13px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        color: canPickup ? "#c9f8d9" : "#9aa7b5",
        fontStyle: canPickup ? "bold" : "normal",
      })
      .setOrigin(0.5, 0.5);
    if (canPickup) {
      ownershipLabel.setInteractive({ useHandCursor: true });
    }
    const close = this.add
      .text(canPickup ? 31 : 35, -22, "关闭", {
        fontSize: "13px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        color: "#d7e2ef",
      })
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true });
    if (canPickup) {
      ownershipLabel.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        void this.pickupMapItem(placement.id);
      });
    }
    close.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.hideItemActionMenu();
    });
    menu.add([bg, ownershipLabel, close]);
    this.itemActionMenu = menu;
  }

  private hideItemActionMenu(): void {
    this.itemActionMenu?.destroy(true);
    this.itemActionMenu = null;
    this.itemActionMenuPlacementId = null;
  }

  private async pickupMapItem(placementId: string): Promise<void> {
    if (!isMultiplayerMode) return;
    const userCharacterId = getScopedUserCharacterId() || "";
    if (!userCharacterId) {
      this.flashPlacementMessage("请先选择角色", false);
      return;
    }
    try {
      const result = await apiClient.pickupMapItem({ userCharacterId, placementId });
      this.hideItemActionMenu();
      await this.reloadMapItemPlacements();
      this.eventBus.emit("inventory_changed");
      this.eventBus.emit("item_picked_up", result);
      this.flashPlacementMessage("已拾取", true);
    } catch (error) {
      this.flashPlacementMessage(error instanceof Error ? error.message : "拾取失败", false);
    }
  }

  private attachItemAssetSprite(
    container: Phaser.GameObjects.Container,
    placement: MapItemPlacementInfo,
    width: number,
    height: number,
    fallbackChildren: Phaser.GameObjects.GameObject[],
    rotationRadians: number,
  ): void {
    const assetUrl = typeof placement.metadata?.assetUrl === "string" ? placement.metadata.assetUrl : "";
    if (!assetUrl) return;
    const asset = getItemAssetDescriptor(placement.metadata, placement.definitionId);
    if (!asset) return;

    const addSprite = () => {
      if (!this.textures.exists(asset.key) || !container.active) return;
      const image = this.add.image(width / 2, height / 2, asset.key).setOrigin(0.5, 0.5);
      const scale = Math.min(width / Math.max(1, image.width), height / Math.max(1, image.height)) * 1.05;
      image.setScale(scale);
      image.setRotation(rotationRadians);
      image.setDepth(1);
      container.add(image);
      container.bringToTop(image);
      for (const child of fallbackChildren) {
        child.destroy();
      }
    };

    this.loadItemAssetTexture(asset, addSprite);
  }

  private loadItemAssetTexture(asset: ItemAssetDescriptor, onReady: () => void): void {
    if (this.textures.exists(asset.key)) {
      onReady();
      return;
    }
    if (this.loadingItemAssetKeys.has(asset.key)) {
      this.load.once(Phaser.Loader.Events.COMPLETE, onReady);
      return;
    }
    this.loadingItemAssetKeys.add(asset.key);
    if (asset.kind === "svg" || asset.url.toLowerCase().endsWith(".svg")) {
      this.load.svg(asset.key, withAssetAuth(asset.url), { width: 96, height: 96 });
    } else {
      this.load.image(asset.key, withAssetAuth(asset.url));
    }
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      this.loadingItemAssetKeys.delete(asset.key);
      onReady();
    });
    this.load.once("loaderror", () => {
      this.loadingItemAssetKeys.delete(asset.key);
      console.warn("[WorldScene] Failed to load placed item asset:", asset.url);
    });
    this.load.start();
  }

  private normalizeFootprintFromItem(item: InventoryItemInfo): { width: number; height: number } {
    return normalizeFootprintObject(item.metadata?.footprintTiles);
  }

  private isFootprintWalkable(tileX: number, tileY: number, width: number, height: number): boolean {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (!this.mapManager.isWalkable(tileX + dx, tileY + dy)) return false;
      }
    }
    return true;
  }

  private getFootprintStartTile(tileX: number, tileY: number, width: number, height: number): { gx: number; gy: number } {
    return {
      gx: tileX - Math.floor((width - 1) / 2),
      gy: tileY - Math.floor((height - 1) / 2),
    };
  }

  private applyPlacementCollision(placements: MapItemPlacementInfo[], mode: "replace" | "append"): void {
    const tiles = placements.flatMap((placement) => this.getBlockedTilesForPlacement(placement));
    if (mode === "replace") {
      this.mapManager.setPlacementBlockedTiles(tiles);
    } else {
      this.mapManager.addPlacementBlockedTiles(tiles);
    }
    this.pathfinder?.rebuildGrid();
  }

  private getBlockedTilesForPlacement(placement: MapItemPlacementInfo): Array<{ gx: number; gy: number }> {
    if (placement.metadata?.blocksMovement === false) return [];
    const footprint = normalizeFootprintObject(placement.metadata?.footprintTiles);
    const tileSize = this.mapManager.tileSize;
    const centerTileX = Number(placement.metadata?.tileX ?? Math.floor(placement.x / tileSize));
    const centerTileY = Number(placement.metadata?.tileY ?? Math.floor(placement.y / tileSize));
    const start = this.getFootprintStartTile(centerTileX, centerTileY, footprint.width, footprint.height);
    const tiles: Array<{ gx: number; gy: number }> = [];
    for (let dy = 0; dy < footprint.height; dy++) {
      for (let dx = 0; dx < footprint.width; dx++) {
        tiles.push({ gx: start.gx + dx, gy: start.gy + dy });
      }
    }
    return tiles;
  }

  private flashPlacementMessage(message: string, ok: boolean): void {
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const text = this.add
      .text(worldPoint.x, worldPoint.y - 24, message, {
        fontSize: "15px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: ok ? "#a6f0c6" : "#ffb3b3",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(95);
    this.tweens.add({
      targets: text,
      y: text.y - 36,
      alpha: 0,
      duration: 900,
      ease: "Cubic.easeOut",
      onComplete: () => text.destroy(),
    });
  }

  private showCollectButton(objectId: string): void {
    if (!this.collectButtonContainer || !this.collectButtonBg || !this.collectButtonText) return;
    const node = this.resourceNodes.get(objectId);
    if (!node) return;
    // 按钮位置固定，避免每帧重画
    if (this.nearbyResourceObjectId === objectId && this.collectButtonContainer.visible) return;

    this.nearbyResourceObjectId = objectId;
    this.drawCollectButton(false);
    this.collectButtonContainer.setPosition(node.x + node.width / 2, node.y - 20);
    this.collectButtonContainer.setData("baseY", this.collectButtonContainer.y);
    this.collectButtonContainer.setScale(0.96);
    this.collectButtonContainer.setAlpha(0);
    this.collectButtonContainer.setVisible(true);
    this.tweens.killTweensOf(this.collectButtonContainer);
    this.tweens.add({
      targets: this.collectButtonContainer,
      scale: 1,
      alpha: 1,
      duration: 140,
      ease: "Back.easeOut",
    });
  }

  private drawCollectButton(pressed: boolean): void {
    if (!this.collectButtonBg) return;
    const btnW = 80;
    const btnH = 32;
    this.collectButtonBg.clear();
    this.collectButtonBg.fillStyle(pressed ? 0x078b72 : 0x00b894, pressed ? 1 : 0.92);
    this.collectButtonBg.fillRoundedRect(-btnW / 2, -btnH / 2, btnW, btnH, 8);
    this.collectButtonBg.lineStyle(2, pressed ? 0xa3f7bf : 0xffffff, pressed ? 0.8 : 0.35);
    this.collectButtonBg.strokeRoundedRect(-btnW / 2, -btnH / 2, btnW, btnH, 8);
  }

  private setCollectButtonPressed(pressed: boolean): void {
    if (!this.collectButtonContainer) return;
    const baseY = Number(this.collectButtonContainer.getData("baseY") ?? this.collectButtonContainer.y);
    this.drawCollectButton(pressed);
    this.tweens.killTweensOf(this.collectButtonContainer);
    this.tweens.add({
      targets: this.collectButtonContainer,
      scaleX: pressed ? 0.94 : 1,
      scaleY: pressed ? 0.9 : 1,
      y: baseY + (pressed ? 2 : 0),
      duration: pressed ? 70 : 130,
      ease: pressed ? "Sine.easeOut" : "Back.easeOut",
    });
  }

  private hideCollectButton(): void {
    this.collectButtonContainer?.setVisible(false);
    this.setCanvasCursor("default");
    this.nearbyResourceObjectId = null;
  }

   /**
   * 每帧检查本地化身是否靠近资源点，靠近则显示采集按钮。
   * 位置来自 UserCharacterController，god 模式（无化身）下不显示。
   */
  private updateNearbyResource(): void {
    const avatar = this.getLocalAvatarSprite();
    if (!avatar || this.resourceNodes.size === 0) {
      if (this.nearbyResourceObjectId) this.hideCollectButton();
      return;
    }

    let nearestNode: ResourceNodeNormalized | null = null;
    let nearestDist = Infinity;
    for (const node of this.resourceNodes.values()) {
      const dist = Phaser.Math.Distance.Between(
        avatar.x,
        avatar.y,
        node.x + node.width / 2,
        node.y + node.height / 2,
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestNode = node;
      }
    }

    if (nearestNode && nearestDist <= this.COLLECT_INTERACTION_RADIUS && nearestNode.remaining > 0) {
      this.showCollectButton(nearestNode.objectId);
    } else {
      this.hideCollectButton();
    }
  }

  private async collectResource(objectId: string): Promise<void> {
    if (!isMultiplayerMode) return;
    try {
      const userCharacterId = getScopedUserCharacterId();
      const result = await apiClient.collectResource(objectId, userCharacterId);
      if (result.success) {
        const node = this.resourceNodes.get(objectId);
        // 在资源点头顶播放 +N 飘字 + 采集波纹反馈
        if (node) {
          this.spawnCollectFeedback(node, result.amount);
        }
        if (this.buildState) {
          this.buildState.resources = result.resources;
        }
        this.eventBus.emit("resource_collected", {
          objectId,
          gained: result.amount,
          resources: result.resources,
        });
        this.eventBus.emit("build_state_updated", this.buildState);
        if (node && node.remaining <= 0) {
          this.hideCollectButton();
        }
      } else {
        this.spawnCollectStatus(result.reason || "采集失败", 0xff7675);
      }
    } catch (e) {
      console.warn("[WorldScene] Failed to collect resource:", e);
      this.spawnCollectStatus(e instanceof Error ? e.message : "采集失败", 0xff7675);
    }
  }

  /**
   * 采集反馈动画：资源点头顶弹出 +N 金色飘字（上浮淡出），
   * 同时在资源点中心扩散一圈绿色波纹，让采集动作清晰可见。
   */
  private spawnCollectFeedback(node: ResourceNodeNormalized, amount: number): void {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const topY = node.y - 4;

    // +N 金色飘字
    const floater = this.add
      .text(cx, topY, `+${amount}`, {
        fontSize: "22px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: "#ffd700",
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(61);
    floater.setScale(0.6);
    // 先快速弹大再上浮淡出
    this.tweens.add({
      targets: floater,
      scale: 1,
      duration: 160,
      ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: floater,
      y: topY - 56,
      alpha: 0,
      duration: 900,
      delay: 120,
      ease: "Cubic.easeOut",
      onComplete: () => floater.destroy(),
    });

    // 绿色采集波纹（container 居中缩放）
    const rippleC = this.add.container(cx, cy).setDepth(59);
    const ring = this.add.graphics();
    const radius = Math.max(node.width, node.height) * 0.45;
    ring.lineStyle(3, 0x55efc4, 0.9);
    ring.strokeCircle(0, 0, radius);
    rippleC.add(ring);
    rippleC.setScale(0.5);
    this.tweens.add({
      targets: rippleC,
      scale: 1.7,
      alpha: 0,
      duration: 650,
      ease: "Cubic.easeOut",
      onComplete: () => rippleC.destroy(),
    });
  }

  private spawnCollectStatus(message: string, color: number): void {
    const avatar = this.getLocalAvatarSprite();
    const x = avatar?.x ?? this.cameras.main.midPoint.x;
    const y = (avatar?.y ?? this.cameras.main.midPoint.y) - 42;
    const text = this.add
      .text(x, y, message.replace(/^API \d+[:：]?\s*/, ""), {
        fontSize: "15px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: `#${color.toString(16).padStart(6, "0")}`,
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center",
        wordWrap: { width: 260 },
      })
      .setOrigin(0.5, 1)
      .setDepth(62);
    this.tweens.add({
      targets: text,
      y: y - 48,
      alpha: 0,
      duration: 1200,
      ease: "Cubic.easeOut",
      onComplete: () => text.destroy(),
    });
  }

  private setupMultiplayerEvents(): void {
    this.clearMultiplayerEvents();
    const on = (eventName: string, handler: (...args: any[]) => void) => {
      this.eventBus.on(eventName, handler);
      this.multiplayerEventCleanups.push(() => this.eventBus.off(eventName, handler));
    };

    on("user_character_joined", (data: any) => {
      if (data.mode && data.mode !== "avatar") return;
      const localPlayerId = networkManager.getPlayerId() || networkManager.getSelectedUserCharacterId();
      if (data.id === localPlayerId) return;
      this.remotePlayerManager.addPlayer({
        id: data.id,
        name: data.name,
        x: data.x,
        y: data.y,
        borrowedSpriteId: this.getFirstNpcSpriteId(),
        appearance: data.appearance,
      });
    });

    on("user_character_left", (data: any) => {
      this.remotePlayerManager.removePlayer(data.playerId);
    });

    on("user_character_moved", (data: any) => {
      this.remotePlayerManager.updatePosition(data.playerId, data.x, data.y);
    });

    on("user_characters_online", (data: any[]) => {
      const spriteId = this.getFirstNpcSpriteId();
      const localPlayerId = networkManager.getPlayerId() || networkManager.getSelectedUserCharacterId();
      const remoteIds = new Set<string>();
      for (const player of data) {
        if (player.mode && player.mode !== "avatar") continue;
        if (player.id === localPlayerId) continue;
        remoteIds.add(player.id);
        this.remotePlayerManager.addPlayer({
          id: player.id,
          name: player.name,
          x: player.x,
          y: player.y,
          borrowedSpriteId: spriteId,
          appearance: player.appearance,
        });
      }
      this.remotePlayerManager.retainOnly(remoteIds);
    });

    on("local_user_character_id_changed", (data: { previousPlayerId?: string | null; playerId?: string | null }) => {
      this.remotePlayerManager.clear();
      if (data.previousPlayerId) {
        this.remotePlayerManager.removePlayer(data.previousPlayerId);
      }
      if (data.playerId) {
        this.remotePlayerManager.removePlayer(data.playerId);
      }
    });

    on("remote_user_character_mode_changed", (data: any) => {
      if (data.mode === "god") {
        this.remotePlayerManager.removePlayer(data.playerId);
      }
    });

    on("user_character_chat", (data: any) => {
      const entry = this.remotePlayerManager.sprites.get(data.playerId);
      if (entry?.sprite) {
        entry.sprite.showBubble(data.message, 5000);
      }
    });
  }

  private onSceneEvent(eventName: string, handler: (...args: any[]) => void): void {
    this.eventBus.on(eventName, handler);
    this.sceneEventCleanups.push(() => this.eventBus.off(eventName, handler));
  }

  private clearSceneEvents(): void {
    for (const cleanup of this.sceneEventCleanups.splice(0)) {
      cleanup();
    }
  }

  private clearMultiplayerEvents(): void {
    for (const cleanup of this.multiplayerEventCleanups.splice(0)) {
      cleanup();
    }
  }

  private getFirstNpcSpriteId(): string | null {
    const ids = Array.from(this.characterSprites.keys());
    return ids.length > 0 ? ids[0] : null;
  }

  private handleReplayInit(initFrame: { characters: { id: string; name: string; location: string; mainAreaPointId: string | null }[] }) {
    const displayMetrics = createCharacterDisplayMetrics(this.mapPixelWidth, this.mapPixelHeight);
    const zoom = this.cameras.main.zoom;
    const mainAreaOccupants = new Map<string, string[]>();

    for (const char of initFrame.characters) {
      if (char.location !== "main_area" || !char.mainAreaPointId) continue;
      const occupants = mainAreaOccupants.get(char.mainAreaPointId) ?? [];
      occupants.push(char.id);
      mainAreaOccupants.set(char.mainAreaPointId, occupants);
    }

    for (const [index, char] of initFrame.characters.entries()) {
      const charInfo: CharacterInfo = {
        id: char.id,
        name: char.name,
        role: "",
        nickname: "",
        location: char.location,
        mainAreaPointId: char.mainAreaPointId,
        emotion: "neutral",
        currentAction: null,
      };
      const pos = this.getCharacterPlacement(charInfo, mainAreaOccupants);
      let sprite = this.characterSprites.get(char.id);

      if (!sprite) {
        const color = getCharacterColor(index);
        sprite = new CharacterSprite(this, pos.x, pos.y, {
          characterId: char.id,
          name: char.name,
          color,
          displayMetrics,
        });
        sprite.enableClick((id) => this.eventBus.emit("character_clicked", id));
        this.entityLayer.add(sprite);
        this.characterSprites.set(char.id, sprite);
      }

      this.applyCharacterSnapshotToSprite(sprite, charInfo, pos, zoom);
    }
  }

  private async syncCharactersFromServer(): Promise<void> {
    const characters = await apiClient.getCharacters(networkManager.getSelectedUserCharacterId() || undefined);
    console.log("[WorldScene] Got characters:", characters.length);
    const zoom = this.cameras.main.zoom;
    const displayMetrics = createCharacterDisplayMetrics(this.mapPixelWidth, this.mapPixelHeight);
    const mainAreaOccupants = new Map<string, string[]>();
    const seenCharacterIds = new Set<string>();

    for (const char of characters) {
      if (char.location !== "main_area" || !char.mainAreaPointId) continue;
      const occupants = mainAreaOccupants.get(char.mainAreaPointId) ?? [];
      occupants.push(char.id);
      mainAreaOccupants.set(char.mainAreaPointId, occupants);
    }

    // 动态补加载缺失的角色精灵图（不依赖 BootScene 时序，主要服务于
    // 建造系统运行时新生成的角色）。
    const charsToLoad = characters.filter((c) => !this.textures.exists(c.id));
    if (charsToLoad.length > 0) {
      console.log(`[WorldScene] Loading ${charsToLoad.length} character spritesheets...`);
      await this.loadCharacterSpritesheets(charsToLoad.map((c) => c.id));
      console.log(`[WorldScene] Character spritesheets loaded`);
    }

    for (const [index, char] of characters.entries()) {
      seenCharacterIds.add(char.id);
      const pos = this.getCharacterPlacement(char, mainAreaOccupants);
      let sprite = this.characterSprites.get(char.id);

      if (!sprite) {
        const color = getCharacterColor(index);
        sprite = new CharacterSprite(this, pos.x, pos.y, {
          characterId: char.id,
          name: char.name,
          color,
          displayMetrics,
        });
        sprite.enableClick((id) => this.eventBus.emit("character_clicked", id));
        this.entityLayer.add(sprite);
        this.characterSprites.set(char.id, sprite);
      } else {
        // 精灵图若此时才就绪，从圆形 fallback 升级为精灵体
        sprite.tryUpgradeToSprite();
      }

      this.applyCharacterSnapshotToSprite(sprite, char, pos, zoom);
    }

    for (const [charId, sprite] of Array.from(this.characterSprites.entries())) {
      if (seenCharacterIds.has(charId)) continue;
      sprite.destroy();
      this.characterSprites.delete(charId);
    }
  }

  /** 通过 Phaser Loader 动态加载角色精灵图。 */
  private loadCharacterSpritesheets(charIds: string[]): Promise<void> {
    return new Promise((resolve) => {
      let remaining = charIds.length;
      if (remaining === 0) {
        resolve();
        return;
      }
      for (const charId of charIds) {
        const characterAssetPrefix = String(this.registry.get("characterAssetPrefix") || "/assets/characters");
        this.load.spritesheet(charId, withAssetAuth(`${characterAssetPrefix}/${encodeURIComponent(charId)}/spritesheet.png`), {
          frameWidth: SPRITE_FRAME_WIDTH,
          frameHeight: SPRITE_FRAME_HEIGHT,
        });
      }
      this.load.once("complete", () => {
        for (const charId of charIds) {
          if (this.textures.exists(charId)) {
            this.textures.get(charId).setFilter(Phaser.Textures.FilterMode.LINEAR);
          }
        }
        resolve();
      });
      this.load.once("loaderror", () => {
        remaining--;
        if (remaining <= 0) resolve();
      });
      this.load.start();
    });
  }

  /** 尝试把所有还在用圆形 fallback 的角色精灵升级为精灵图。 */
  private upgradeCharacterSprites(): void {
    let upgraded = 0;
    for (const sprite of this.characterSprites.values()) {
      if (sprite.tryUpgradeToSprite()) upgraded++;
    }
    if (upgraded > 0) {
      console.log(`[WorldScene] Upgraded ${upgraded} characters to sprite mode`);
    }
  }

  private getCharacterPlacement(
    char: CharacterInfo,
    mainAreaOccupants: Map<string, string[]>,
  ): { x: number; y: number } {
    return (
      (char.location === "main_area" && char.mainAreaPointId
        ? this.mapManager.getMainAreaPlacement(char.mainAreaPointId, char.id, {
            occupantIds: mainAreaOccupants.get(char.mainAreaPointId) ?? [char.id],
          })
        : null) ||
      this.mapManager.getRandomWalkablePointInLocation(char.location, {
        preferInset: this.mapManager.isPinnedLocation(char.location),
      }) ||
      { x: 400, y: 300 }
    );
  }

  private applyCharacterSnapshotToSprite(
    sprite: CharacterSprite,
    char: CharacterInfo,
    pos: { x: number; y: number },
    zoom: number,
  ): void {
    sprite.stopMoving();
    sprite.clearTransientUi();
    sprite.setPosition(pos.x, pos.y);
    sprite.currentLocationId = char.location;
    sprite.mainAreaPointId = char.mainAreaPointId ?? null;
    sprite.profileAnchor = char.anchor || null;
    sprite.setCurrentAction(char.currentAction);
    sprite.setActionIcon(actionToEmoji(char.currentAction));
    sprite.setActionLabel(null);
    sprite.setMovementAnchor({
      x: pos.x,
      y: pos.y,
      pinned: this.mapManager.isPinnedLocation(char.location) || !!char.anchor,
    });
    sprite.syncOverlayZoom(zoom);
  }

  private async handleSceneDayChange(): Promise<void> {
    this.clearDialoguePlayback();
    try {
      await this.syncCharactersFromServer();
    } catch (error) {
      console.warn("[WorldScene] Failed to sync characters after scene change:", error);
    }
  }

  private clearDialoguePlayback(): void {
    for (const lane of this.dialoguePlaybackLanes.values()) {
      lane.queue = [];
      lane.timer?.remove(false);
      lane.timer = null;
    }
    this.dialoguePlaybackLanes.clear();
    for (const sprite of this.characterSprites.values()) {
      sprite.stopMoving();
      sprite.clearTransientUi();
    }
    this.scheduleTickPlaybackCompletionCheck();
  }

  private handleSimEvent(event: SimulationEvent) {
    switch (event.type) {
      case "movement": {
        const destination = event.data?.to ?? event.data?.toLocation ?? event.location;
        if (event.actorId && destination) {
          const sprite = this.characterSprites.get(event.actorId);
          sprite?.setCurrentAction(null);
          sprite?.setActionIcon("");
          sprite?.setActionLabel(null);
          const pointId =
            typeof event.data?.toPointId === "string" ? event.data.toPointId : null;
          void this.trackPlaybackAsync(
            this.characterMovement.moveToLocation(event.actorId, destination, {
              force: true,
              mainAreaPointId: pointId,
            }),
          );
          this.maybeShowActionMonologue(event);
        }
        break;
      }

      case "action_start": {
        const sprite = this.characterSprites.get(event.actorId!);
        const actionId = event.data?.action ?? event.data?.interactionId ?? event.data?.actionType ?? null;
        if (sprite) {
          sprite.setCurrentAction(actionId);
          sprite.setActionIcon(actionToEmoji(actionId));
          const actionType = event.data?.actionType;
          if (actionType === "interact_object") {
            sprite.setActionLabel(event.data?.interactionName || actionToEmoji(actionId) || null);
          } else {
            sprite.setActionLabel(null);
          }
        }
        const objectId = event.data?.objectId ?? event.targetId;
        if (objectId && event.actorId && event.data?.actionType === "interact_object") {
          void this.trackPlaybackAsync(
            this.characterMovement.moveToObject(event.actorId, objectId),
          );
        }
        this.maybeShowActionMonologue(event);
        break;
      }

      case "action_end": {
        const sprite = this.characterSprites.get(event.actorId!);
        if (sprite) {
          sprite.setCurrentAction(null);
          sprite.setActionIcon("");
          sprite.setActionLabel(null);
        }
        break;
      }

      case "dialogue":
        this.dialogueEventChain = this.trackPlaybackAsync(
          this.dialogueEventChain
            .then(() => this.handleDialogue(event))
            .catch((error) => {
              console.warn("[WorldScene] Failed to handle dialogue event:", error);
            }),
        );
        break;

      case "event_triggered":
        this.eventBus.emit("global_event", event);
        break;
    }

    this.eventBus.emit("sim_event", event);
  }

  private async handleDialogue(event: SimulationEvent) {
    const dialogue = event.data as DialogueEventData;
    if (!dialogue) return;

    if (dialogue.participants?.length === 2) {
      const [idA, idB] = dialogue.participants;
      const spriteA = this.characterSprites.get(idA);
      const spriteB = this.characterSprites.get(idB);
      if (dialogue.phase === "complete") {
        this.setDialogueActionState(dialogue.participants, "post_dialogue");
      } else {
        this.setDialogueActionState(dialogue.participants, "in_conversation");
      }
      if (spriteA && spriteB) {
        if (dialogue.phase === "turn" && dialogue.turnIndexStart === 0) {
          await this.reconcileDialogueParticipantLocations(
            dialogue.participants,
            event.location,
          );
          const runtimePatch = await this.characterMovement.approachForDialogue(idA, idB);
          if (runtimePatch?.mainAreaPointId && !this.isReplaying) {
            void apiClient.patchCharacterRuntimeState(idA, runtimePatch).catch((error) => {
              console.warn("[WorldScene] Failed to persist dialogue landing point:", error);
            });
          }
        } else {
          spriteA.faceTowards(spriteB.x, spriteB.y);
          spriteB.faceTowards(spriteA.x, spriteA.y);
        }
      }
    }

    this.eventBus.emit("dialogue", event);

    if (dialogue.phase === "turn" && dialogue.turns?.length) {
      const laneKey = this.getDialogueLaneKey(dialogue);
      const lane = this.getOrCreateDialoguePlaybackLane(laneKey);
      dialogue.turns.forEach((turn) => {
        lane.queue.push({
          speaker: turn.speaker,
          content: turn.content,
          innerMonologue: turn.innerMonologue,
          participants: dialogue.participants,
        });
      });
      this.playNextDialogueTurn(laneKey);
    } else if (dialogue.phase === "complete" && dialogue.participants?.length) {
      this.pendingDialogueCleanupTimers += 1;
      this.time.delayedCall(1200, () => {
        for (const participantId of dialogue.participants || []) {
          const sprite = this.characterSprites.get(participantId);
          if (!sprite || sprite.currentAction !== "post_dialogue") continue;
          sprite.setCurrentAction(null);
          sprite.setActionIcon("");
        }
        this.pendingDialogueCleanupTimers = Math.max(0, this.pendingDialogueCleanupTimers - 1);
        this.scheduleTickPlaybackCompletionCheck();
      });
    }
  }

  private async reconcileDialogueParticipantLocations(
    participantIds: string[],
    locationId?: string,
  ): Promise<void> {
    if (!locationId) return;

    await Promise.all(
      participantIds.map(async (participantId) => {
        const sprite = this.characterSprites.get(participantId);
        if (!sprite || sprite.currentLocationId === locationId) return;

        await this.characterMovement.moveToLocation(participantId, locationId, {
          force: true,
        });
      }),
    );
  }

  private setDialogueActionState(participantIds: string[], action: string | null) {
    for (const participantId of participantIds) {
      const sprite = this.characterSprites.get(participantId);
      if (!sprite) continue;
      sprite.setCurrentAction(action);
      sprite.setActionIcon(actionToEmoji(action));
      sprite.setActionLabel(null);
    }
  }

  private getDialogueLaneKey(dialogue: DialogueEventData): string {
    if (dialogue.conversationId) {
      return dialogue.conversationId;
    }
    return [...(dialogue.participants ?? [])].sort().join("__");
  }

  private getOrCreateDialoguePlaybackLane(laneKey: string): DialoguePlaybackLane {
    let lane = this.dialoguePlaybackLanes.get(laneKey);
    if (!lane) {
      lane = { queue: [], timer: null };
      this.dialoguePlaybackLanes.set(laneKey, lane);
    }
    return lane;
  }

  private playNextDialogueTurn(laneKey: string) {
    const lane = this.dialoguePlaybackLanes.get(laneKey);
    if (!lane) {
      this.scheduleTickPlaybackCompletionCheck();
      return;
    }
    if (lane.timer || lane.queue.length === 0) {
      if (!lane.timer && lane.queue.length === 0) {
        this.dialoguePlaybackLanes.delete(laneKey);
        this.scheduleTickPlaybackCompletionCheck();
      }
      return;
    }

    const nextTurn = lane.queue.shift();
    if (!nextTurn) {
      this.dialoguePlaybackLanes.delete(laneKey);
      this.scheduleTickPlaybackCompletionCheck();
      return;
    }

    const bubbleDuration = FRONTEND_DIALOGUE_BUBBLE_MS;
    const playbackDuration =
      bubbleDuration + (nextTurn.innerMonologue ? FRONTEND_DIALOGUE_INNER_MONOLOGUE_TAIL_MS : 0);

    if (nextTurn.participants?.length === 2) {
      const [idA, idB] = nextTurn.participants;
      const spriteA = this.characterSprites.get(idA);
      const spriteB = this.characterSprites.get(idB);
      if (spriteA && spriteB) {
        spriteA.faceTowards(spriteB.x, spriteB.y);
        spriteB.faceTowards(spriteA.x, spriteA.y);
      }
    }

    const sprite = this.characterSprites.get(nextTurn.speaker);
    if (sprite) {
      sprite.showBubble(nextTurn.content, bubbleDuration, {}, nextTurn.innerMonologue);
    }

    lane.timer = this.time.delayedCall(
      playbackDuration,
      () => {
        lane.timer = null;
        if (lane.queue.length === 0) {
          this.dialoguePlaybackLanes.delete(laneKey);
        }
        this.playNextDialogueTurn(laneKey);
      },
    );
  }

  private maybeShowActionMonologue(event: SimulationEvent): void {
    const monologue = event.innerMonologue;
    if (!monologue || !event.actorId) return;
    const sprite = this.characterSprites.get(event.actorId);
    if (!sprite) return;
    sprite.showMonologue(monologue);
  }

  private trackPlaybackAsync<T>(promise: Promise<T>): Promise<T> {
    if (!this.tickPlaybackActive) return promise;
    this.pendingPlaybackAsyncOps += 1;
    return promise.finally(() => {
      this.pendingPlaybackAsyncOps = Math.max(0, this.pendingPlaybackAsyncOps - 1);
      this.scheduleTickPlaybackCompletionCheck();
    });
  }

  private scheduleTickPlaybackCompletionCheck(delayMs = 0): void {
    if (!this.tickPlaybackActive) return;
    if (this.playbackCompletionCheckTimer) return;
    this.playbackCompletionCheckTimer = this.time.delayedCall(delayMs, () => {
      this.playbackCompletionCheckTimer = null;
      this.maybeCompleteTickPlayback();
    });
  }

  private maybeCompleteTickPlayback(): void {
    if (!this.tickPlaybackActive || !this.tickPlaybackEventsFlushed) return;
    if (this.pendingPlaybackAsyncOps > 0) return;
    if (this.pendingDialogueCleanupTimers > 0) return;
    if (this.hasPendingDialoguePlayback()) return;

    this.tickPlaybackActive = false;
    this.tickPlaybackEventsFlushed = false;
    this.eventBus.emit("tick_playback_complete");
  }

  private hasPendingDialoguePlayback(): boolean {
    for (const lane of this.dialoguePlaybackLanes.values()) {
      if (lane.timer || lane.queue.length > 0) {
        return true;
      }
    }
    return false;
  }

  private setWalkableOverlayVisible(visible: boolean): void {
    if (visible && !this.walkableOverlay) {
      this.walkableOverlay = this.buildWalkableOverlay();
    }
    this.walkableOverlay?.setVisible(visible);
  }

  private setRegionBoundsOverlayVisible(visible: boolean): void {
    if (visible && !this.regionBoundsOverlay) {
      this.regionBoundsOverlay = this.buildRegionBoundsOverlay();
    }
    this.regionBoundsOverlay?.setVisible(visible);
  }

  private setMainAreaPointsOverlayVisible(visible: boolean): void {
    if (visible && !this.mainAreaPointsOverlay) {
      this.mainAreaPointsOverlay = this.buildMainAreaPointsOverlay();
    }
    this.mainAreaPointsOverlay?.setVisible(visible);
  }

  private setInteractiveObjectsOverlayVisible(visible: boolean): void {
    if (visible && !this.interactiveObjectsOverlay) {
      this.interactiveObjectsOverlay = this.buildInteractiveObjectsOverlay();
    }
    this.interactiveObjectsOverlay?.setVisible(visible);
  }

  private refreshDebugOverlays(): void {
    const regionBoundsVisible = this.regionBoundsOverlay?.visible ?? false;
    const mainAreaPointsVisible = this.mainAreaPointsOverlay?.visible ?? false;
    const interactiveObjectsVisible = this.interactiveObjectsOverlay?.visible ?? false;

    this.regionBoundsOverlay?.destroy(true);
    this.regionBoundsOverlay = null;
    this.mainAreaPointsOverlay?.destroy();
    this.mainAreaPointsOverlay = null;
    this.interactiveObjectsOverlay?.destroy(true);
    this.interactiveObjectsOverlay = null;

    if (regionBoundsVisible) {
      this.regionBoundsOverlay = this.buildRegionBoundsOverlay();
      this.regionBoundsOverlay.setVisible(true);
    }
    if (mainAreaPointsVisible) {
      this.mainAreaPointsOverlay = this.buildMainAreaPointsOverlay();
      this.mainAreaPointsOverlay.setVisible(true);
    }
    if (interactiveObjectsVisible) {
      this.interactiveObjectsOverlay = this.buildInteractiveObjectsOverlay();
      this.interactiveObjectsOverlay.setVisible(true);
    }
  }

  private buildWalkableOverlay(): Phaser.GameObjects.Graphics {
    const graphics = this.add.graphics();
    graphics.setDepth(4);
    graphics.fillStyle(0x4da3ff, 0.22);
    graphics.lineStyle(1, 0x7db8ff, 0.16);

    const tileSize = this.mapManager.tileSize;
    for (let gy = 0; gy < this.mapManager.gridHeight; gy++) {
      let runStart: number | null = null;
      for (let gx = 0; gx <= this.mapManager.gridWidth; gx++) {
        const walkable = gx < this.mapManager.gridWidth && this.mapManager.isWalkable(gx, gy);
        if (walkable) {
          if (runStart == null) runStart = gx;
          continue;
        }
        if (runStart == null) continue;

        const width = (gx - runStart) * tileSize;
        const x = runStart * tileSize;
        const y = gy * tileSize;
        graphics.fillRect(x, y, width, tileSize);
        graphics.strokeRect(x, y, width, tileSize);
        runStart = null;
      }
    }

    return graphics;
  }

  private buildRegionBoundsOverlay(): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0);
    container.setDepth(16);

    const boxes = this.add.graphics();
    boxes.lineStyle(2, 0xffd166, 0.95);
    boxes.fillStyle(0xffd166, 0.08);
    container.add(boxes);

    for (const location of this.mapManager.getVisibleLocations()) {
      boxes.fillRect(location.x, location.y, location.width, location.height);
      boxes.strokeRect(location.x, location.y, location.width, location.height);

      const label = this.add.text(
        location.x + 6,
        Math.max(6, location.y - 22),
        location.name || location.id,
        {
          fontSize: "14px",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          color: "#ffe7a8",
          backgroundColor: "rgba(0, 0, 0, 0.65)",
          padding: { left: 6, right: 6, top: 3, bottom: 3 },
          stroke: "#000000",
          strokeThickness: 2,
        },
      );
      label.setDepth(17);
      container.add(label);
    }

    return container;
  }

  private buildMainAreaPointsOverlay(): Phaser.GameObjects.Graphics {
    const pointMarkers = this.add.graphics();
    pointMarkers.setDepth(16);
    pointMarkers.lineStyle(2, 0xffffff, 0.92);
    pointMarkers.fillStyle(0x4da3ff, 0.95);

    for (const point of this.mapManager.getMainAreaPoints()) {
      pointMarkers.fillCircle(point.x, point.y, 6);
      pointMarkers.strokeCircle(point.x, point.y, 6);
      pointMarkers.fillStyle(0xe8f4ff, 0.95);
      pointMarkers.fillCircle(point.x, point.y, 2);
      pointMarkers.fillStyle(0x4da3ff, 0.95);
    }

    return pointMarkers;
  }

  private setupInteractiveObjectHover() {
    this.interactiveHoverGraphics = this.add.graphics();
    this.interactiveHoverGraphics.setDepth(15);
    
    this.interactiveHoverLabelContainer = this.add.container(0, 0);
    this.interactiveHoverLabelContainer.setDepth(16);
    this.interactiveHoverLabelContainer.setVisible(false);

    this.interactiveHoverLabelBg = this.add.graphics();
    this.interactiveHoverLabelText = this.add.text(0, 0, "", {
      fontSize: "18px",
      fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 2,
    });
    
    this.interactiveHoverLabelContainer.add([this.interactiveHoverLabelBg, this.interactiveHoverLabelText]);

    let currentHoveredObjectId: string | null = null;

    for (const object of this.mapManager.getInteractiveObjects()) {
      const zone = this.add.zone(object.x, object.y, object.width, object.height);
      zone.setOrigin(0, 0);
      zone.setInteractive();
      
      zone.on("pointerover", () => {
        if (!this.interactiveHoverGraphics || !this.interactiveHoverLabelContainer || !this.interactiveHoverLabelBg || !this.interactiveHoverLabelText) return;
        
        currentHoveredObjectId = object.objectId;

        // Draw highlight
        this.interactiveHoverGraphics.clear();
        this.interactiveHoverGraphics.lineStyle(2, 0xffffff, 0.8);
        this.interactiveHoverGraphics.fillStyle(0xffffff, 0.15);
        
        // Use a rounded rectangle for a slightly softer look
        this.interactiveHoverGraphics.fillRoundedRect(object.x, object.y, object.width, object.height, 4);
        this.interactiveHoverGraphics.strokeRoundedRect(object.x, object.y, object.width, object.height, 4);
        
        // Show label
        this.interactiveHoverLabelText.setText(object.name || object.objectId);
        
        // Measure text bounds to draw a nice rounded background
        const textWidth = this.interactiveHoverLabelText.width;
        const textHeight = this.interactiveHoverLabelText.height;
        const bgPaddingX = 12;
        const bgPaddingY = 8;
        
        this.interactiveHoverLabelBg.clear();
        this.interactiveHoverLabelBg.fillStyle(0x000000, 0.75);
        this.interactiveHoverLabelBg.fillRoundedRect(
          -bgPaddingX, 
          -bgPaddingY, 
          textWidth + bgPaddingX * 2, 
          textHeight + bgPaddingY * 2, 
          6 // border radius
        );
        
        // Position text inside container
        this.interactiveHoverLabelText.setPosition(0, 0);
        
        // Position the whole container
        const containerX = object.x + object.width / 2 - textWidth / 2;
        const containerY = Math.max(10 + bgPaddingY, object.y - textHeight - bgPaddingY - 4);
        
        this.interactiveHoverLabelContainer.setPosition(containerX, containerY);
        this.interactiveHoverLabelContainer.setVisible(true);
      });
      
      zone.on("pointerout", () => {
        if (currentHoveredObjectId === object.objectId) {
          if (!this.interactiveHoverGraphics || !this.interactiveHoverLabelContainer) return;
          this.interactiveHoverGraphics.clear();
          this.interactiveHoverLabelContainer.setVisible(false);
          currentHoveredObjectId = null;
        }
      });
    }
  }

  private buildInteractiveObjectsOverlay(): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0);
    container.setDepth(16);

    const boxes = this.add.graphics();
    boxes.lineStyle(2, 0x55efc4, 0.95);
    boxes.fillStyle(0x55efc4, 0.1);
    container.add(boxes);

    for (const object of this.mapManager.getInteractiveObjects()) {
      boxes.fillRect(object.x, object.y, object.width, object.height);
      boxes.strokeRect(object.x, object.y, object.width, object.height);

      const label = this.add.text(
        object.x + 6,
        Math.max(6, object.y - 22),
        object.name || object.objectId,
        {
          fontSize: "14px",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          color: "#c8fff0",
          backgroundColor: "rgba(0, 0, 0, 0.65)",
          padding: { left: 6, right: 6, top: 3, bottom: 3 },
          stroke: "#000000",
          strokeThickness: 2,
        },
      );
      label.setDepth(17);
      container.add(label);
    }

    return container;
  }

  update(_time: number, delta: number) {
    this.cameraController?.update();
    this.pathfinder?.update();
    this.playbackController?.update(delta);
    if (isMultiplayerMode) {
      this.playerController?.update(delta);
      this.updateNearbyResource();
    }
    if (!this.isReplaying) {
      this.characterMovement?.updateAmbientMovement(performance.now());
    }
    const zoom = this.cameras.main.zoom;
    for (const sprite of this.characterSprites.values()) {
      sprite.syncOverlayZoom(zoom);
    }
    // 本地用户角色也需要同步 DOM 标签位置
    if (isMultiplayerMode && this.playerController?.playerSprite) {
      this.playerController.playerSprite.syncOverlayZoom(zoom);
    }
    // 远程玩家 DOM 标签同步
    if (isMultiplayerMode) {
      this.remotePlayerManager?.syncZoom(zoom);
    }
    if (this.entityLayer) {
      this.entityLayer.list.sort((a, b) => {
        const ay = a instanceof CharacterSprite ? a.getSortFootY() : (a as Phaser.GameObjects.Sprite).y || 0;
        const by = b instanceof CharacterSprite ? b.getSortFootY() : (b as Phaser.GameObjects.Sprite).y || 0;
        return ay - by;
      });
    }
  }
}

function normalizeFootprintObject(raw: unknown): { width: number; height: number } {
  if (!raw || typeof raw !== "object") return { width: 1, height: 1 };
  const value = raw as Record<string, unknown>;
  return {
    width: Math.max(1, Math.min(16, Math.floor(Number(value.width) || 1))),
    height: Math.max(1, Math.min(16, Math.floor(Number(value.height) || 1))),
  };
}

function getItemVisualSize(footprint: { width: number; height: number }, visualScale = 1): { width: number; height: number } {
  const visualTilePx = 32;
  const scale = normalizeItemVisualScale(visualScale);
  return {
    width: Math.max(24, Math.max(48, footprint.width * visualTilePx) * scale),
    height: Math.max(24, Math.max(48, footprint.height * visualTilePx) * scale),
  };
}

function normalizeItemVisualScale(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(ITEM_PLACEMENT_MIN_VISUAL_SCALE, Math.min(ITEM_PLACEMENT_MAX_VISUAL_SCALE, Math.round(value * 10) / 10));
}

function normalizeItemRotationDegrees(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeItemRotationRadians(raw: unknown): number {
  return Phaser.Math.DegToRad(normalizeItemRotationDegrees(raw));
}

type ItemAssetDescriptor = {
  key: string;
  url: string;
  kind: string;
};

function getItemAssetDescriptor(metadata: Record<string, unknown> | undefined, fallbackId: string): ItemAssetDescriptor | null {
  const url = typeof metadata?.assetUrl === "string" ? metadata.assetUrl : "";
  if (!url) return null;
  const rawKey = typeof metadata?.assetKey === "string" && metadata.assetKey
    ? metadata.assetKey
    : `item_asset_${fallbackId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const kind = typeof metadata?.assetKind === "string" ? metadata.assetKind : "";
  return { key: rawKey, url: withAssetAuth(url), kind };
}

function colorForItemName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const palette = [0x9b6b43, 0x6b8f71, 0x8a7bb8, 0xb88752, 0x5b8aa8, 0x9d6f7f];
  return palette[hash % palette.length];
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function lightenColor(color: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + 24);
  const g = Math.min(255, ((color >> 8) & 0xff) + 24);
  const b = Math.min(255, (color & 0xff) + 24);
  return (r << 16) | (g << 8) | b;
}
