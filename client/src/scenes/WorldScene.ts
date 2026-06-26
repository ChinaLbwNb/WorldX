import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { MapManager } from "../systems/MapManager";
import { PathfindingManager } from "../systems/PathfindingManager";
import { CharacterMovement } from "../systems/CharacterMovement";
import { PlaybackController } from "../systems/PlaybackController";
import { CameraController } from "../systems/CameraController";
import { CharacterSprite } from "../objects/CharacterSprite";
import { PlayerSprite } from "../objects/PlayerSprite";
import { getCharacterColor, actionToEmoji, createCharacterDisplayMetrics, SPRITE_FRAME_WIDTH, SPRITE_FRAME_HEIGHT } from "../config/game-config";
import { apiClient } from "../ui/services/api-client";
import type { CharacterInfo, DialogueEventData, SimulationEvent, BuildState } from "../types/api";

/** Normalized resource node with frontend-friendly field names. */
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

// Frontend-only dialogue playback tuning. Search these names to adjust pacing.
const FRONTEND_DIALOGUE_BUBBLE_MS = 5000;
const FRONTEND_DIALOGUE_INNER_MONOLOGUE_TAIL_MS = 1500;

export class WorldScene extends Phaser.Scene {
  private mapManager!: MapManager;
  private pathfinder!: PathfindingManager;
  private characterMovement!: CharacterMovement;
  private characterSprites: Map<string, CharacterSprite> = new Map();
  private playbackController!: PlaybackController;
  private cameraController!: CameraController;
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
  private playerSprite: PlayerSprite | null = null;
  private buildState: BuildState | null = null;
  private resourceNodes: Map<string, ResourceNodeNormalized> = new Map();
  private resourceMarkers: Phaser.GameObjects.Container | null = null;
  private collectButtonContainer: Phaser.GameObjects.Container | null = null;
  private collectButtonBg: Phaser.GameObjects.Graphics | null = null;
  private collectButtonText: Phaser.GameObjects.Text | null = null;
  private nearbyResourceObjectId: string | null = null;
  private readonly COLLECT_INTERACTION_RADIUS = 120;

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

    const hasBg = this.textures.exists("world-base");
    let bgWidth = 8192;
    let bgHeight = 4608;
    if (hasBg) {
      const bg = this.add.image(0, 0, "world-base").setOrigin(0, 0);
      bgWidth = bg.width;
      bgHeight = bg.height;
      console.log(`[WorldScene] Background loaded: ${bgWidth}x${bgHeight}`);
    } else {
      console.warn("[WorldScene] Background texture not found, using fallback");
      this.add.rectangle(bgWidth / 2, bgHeight / 2, bgWidth, bgHeight, 0x2d4a3e);
    }

    this.entityLayer = this.add.container(0, 0);
    this.entityLayer.setDepth(10);
    this.mapPixelWidth = bgWidth;
    this.mapPixelHeight = bgHeight;
    this.setupInteractiveObjectHover();

    this.pathfinder = new PathfindingManager(this.mapManager);

    const initialCenter = { x: bgWidth / 2, y: bgHeight / 2 };
    this.cameraController = new CameraController(this, bgWidth, bgHeight, initialCenter);
    console.log("[WorldScene] Camera centered on:", initialCenter);

    this.characterMovement = new CharacterMovement(
      this.mapManager,
      this.pathfinder,
      this.characterSprites
    );

    this.playbackController = new PlaybackController(this.eventBus);
    this.playbackController.on("event", this.handleSimEvent, this);

    this.eventBus.on("follow_character", (charId: string) => {
      const sprite = this.characterSprites.get(charId);
      if (sprite) this.cameraController.followCharacter(sprite);
    });
    this.eventBus.on("unfollow_character", () => {
      this.cameraController.stopFollowing();
    });
    this.eventBus.on("dev_advance_tick", () => {
      this.playbackController.devAdvanceTick();
    });
    this.eventBus.on("set_auto_play", (enabled: boolean) => {
      if (this.playbackController.getMode() === "replay") {
        this.playbackController.setReplayAutoPlay(enabled);
      } else {
        this.playbackController.setAutoPlay(enabled);
      }
    });
    this.eventBus.on("set_tick_interval", (intervalMs: number) => {
      this.playbackController.setTickIntervalMs(intervalMs);
    });
    this.eventBus.on("set_cycle_ticks", (cycleTicks: number) => {
      this.playbackController.setCycleTicks(cycleTicks);
    });
    this.eventBus.on("start_replay", (timelineId: string) => {
      void this.playbackController.startReplay(timelineId);
    });
    this.eventBus.on("stop_replay", () => {
      this.playbackController.stopReplay();
    });
    this.eventBus.on("replay_ended", () => {
      void this.syncCharactersFromServer();
    });
    this.eventBus.on("set_replay_mode", (payload: { active: boolean }) => {
      this.isReplaying = payload.active;
    });
    this.eventBus.on("replay_init", (initFrame: any) => {
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
    this.eventBus.on("tick_playback_started", onTickPlaybackStarted);
    this.eventBus.on("tick_playback_events_flushed", onTickPlaybackEventsFlushed);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.eventBus.off("toggle_debug_walkable_overlay", onToggleWalkableOverlay);
      this.eventBus.off("toggle_debug_region_bounds_overlay", onToggleRegionBoundsOverlay);
      this.eventBus.off("toggle_debug_main_area_points_overlay", onToggleMainAreaPointsOverlay);
      this.eventBus.off("toggle_debug_interactive_objects_overlay", onToggleInteractiveObjectsOverlay);
      this.eventBus.off("time_update", onTimeUpdate);
      this.eventBus.off("scene_sync_characters", onSceneSyncCharacters);
      this.eventBus.off("tick_playback_started", onTickPlaybackStarted);
      this.eventBus.off("tick_playback_events_flushed", onTickPlaybackEventsFlushed);
    });

    this.initAsync();
  }

  private async initAsync() {
    try {
      const worldInfo = await apiClient.getWorldInfo();
      this.mapManager.setMainAreaPoints(worldInfo.mainAreaPoints || []);
      if (this.regionBoundsOverlay || this.mainAreaPointsOverlay || this.interactiveObjectsOverlay) {
        this.refreshDebugOverlays();
      }
    } catch (e) {
      console.warn("[WorldScene] Failed to load world navigation:", e);
    }

    try {
      await this.initCharacters();
    } catch (e) {
      console.warn("[WorldScene] Failed to load characters:", e);
    }

    try {
      await this.initPlayerAndBuild();
    } catch (e) {
      console.warn("[WorldScene] Failed to init player/build:", e);
    }

    try {
      await this.playbackController.initialize();
    } catch (e) {
      console.warn("[WorldScene] Failed to initialize playback:", e);
    }

    console.log("[WorldScene] Async init complete, sprites:", this.characterSprites.size);

    // Try upgrading any circle-fallback sprites to proper sprites if
    // textures became available during async init (safety net for timing).
    this.upgradeCharacterSprites();
  }

  /** Try upgrading all character sprites from circle fallback to sprite sheets. */
  private upgradeCharacterSprites(): void {
    let upgraded = 0;
    for (const sprite of this.characterSprites.values()) {
      if (sprite.tryUpgradeToSprite()) {
        upgraded++;
      }
    }
    if (upgraded > 0) {
      console.log(`[WorldScene] Upgraded ${upgraded} characters to sprite mode`);
    }
  }

  private async initCharacters() {
    await this.syncCharactersFromServer();
  }

  private async initPlayerAndBuild() {
    try {
      const state = await apiClient.getBuildState();
      this.buildState = state;
      this.resourceNodes.clear();
      for (const node of state.resourceNodes) {
        // Map API fields (id, pixelX, pixelY) to frontend-friendly names
        // (objectId, x, y) and add a remaining count for UI purposes.
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
          remaining: 999, // unlimited conceptually, cooldown-based
        };
        this.resourceNodes.set(normalized.objectId, normalized);
      }

      const displayMetrics = createCharacterDisplayMetrics(this.mapPixelWidth, this.mapPixelHeight);
      const px = state.playerState.pixelX || this.mapPixelWidth / 2;
      const py = state.playerState.pixelY || this.mapPixelHeight / 2;

      this.playerSprite = new PlayerSprite(this, px, py, { displayMetrics });
      this.entityLayer.add(this.playerSprite);

      this.setupResourceMarkers();
      this.setupGroundClickHandler();
      this.setupResourceInteraction();
      this.setupCollectButton();

      this.eventBus.emit("build_state_updated", state);
    } catch (e) {
      console.warn("[WorldScene] Build system not available:", e);
    }
  }

  /**
   * Create glowing visual markers on the map for each resource node.
   * Each marker is a semi-transparent glowing ring + 💎 icon, with hover effect.
   */
  private setupResourceMarkers(): void {
    if (this.resourceNodes.size === 0) return;

    this.resourceMarkers = this.add.container(0, 0);
    this.resourceMarkers.setDepth(8);

    console.log(`[WorldScene] Creating ${this.resourceNodes.size} resource markers`);

    for (const node of this.resourceNodes.values()) {
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;

      const marker = this.add.container(centerX, centerY);

      // Outer glow ring (pulsing)
      const glowRing = this.add.graphics();
      const glowRadius = Math.max(node.width, node.height) * 0.7;
      glowRing.lineStyle(3, 0x55efc4, 0.6);
      glowRing.strokeCircle(0, 0, glowRadius);
      glowRing.setAlpha(0.8);

      // Inner filled circle (semi-transparent highlight
      const innerFill = this.add.graphics();
      innerFill.fillStyle(0x55efc4, 0.15);
      innerFill.fillCircle(0, 0, glowRadius * 0.7);

      // Diamond emoji / icon in the center
      const icon = this.add.text(0, 0, "💎", {
        fontSize: `${Math.min(node.width * 0.6)}px`,
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
      }).setOrigin(0.5, 0.5);

      // Pulsing animation for the glow ring
      const glowTween = this.tweens.add({
        targets: { scale: 1 },
        scale: 1.25,
        duration: 1800,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
        onUpdate: (tween) => {
          const s = (tween.targets[0] as { scale: number }).scale;
          glowRing.setScale(s);
          glowRing.setAlpha(0.9 - (s - 1) * 2);
        },
      });

      // Store references for hover state
      marker.setData("node", node);
      marker.setData("glowRing", glowRing);
      marker.setData("glowTween", glowTween);
      marker.setData("icon", icon);
      marker.setData("innerFill", innerFill);

      // Make the marker interactive (use a larger hit area for easier clicking)
      const hitRadius = glowRadius * 1.3;
      marker.setSize(hitRadius * 2, hitRadius * 2);
      marker.setInteractive(
        new Phaser.Geom.Circle(0, 0, hitRadius),
        Phaser.Geom.Circle.Contains,
      );

      // Hover effects
      marker.on("pointerover", () => {
        const ring = marker.getData("glowRing") as Phaser.GameObjects.Graphics;
        const iconEl = marker.getData("icon") as Phaser.GameObjects.Text;
        if (ring) {
          ring.clear();
          ring.lineStyle(4, 0xffffff, 0.9);
          ring.strokeCircle(0, 0, glowRadius * 1.15);
        }
        if (iconEl) {
          iconEl.setScale(1.15);
        }
        // Show the resource name tooltip
        this.showResourceTooltip(centerX, centerY - node.height / 2 - 10, node.name);
      });

      marker.on("pointerout", () => {
        const ring = marker.getData("glowRing") as Phaser.GameObjects.Graphics;
        const iconEl = marker.getData("icon") as Phaser.GameObjects.Text;
        if (ring) {
          ring.clear();
          ring.lineStyle(3, 0x55efc4, 0.6);
          ring.strokeCircle(0, 0, glowRadius);
        }
        if (iconEl) {
          iconEl.setScale(1);
        }
        this.hideResourceTooltip();
      });

      // Click handler — move player to resource & collect
      marker.on("pointerdown", () => {
        this.handleResourceClick(node.objectId);
      });

      marker.add([innerFill, glowRing, icon]);
      this.resourceMarkers.add(marker);
    }

    // Sort markers by Y for proper depth ordering
    this.resourceMarkers.list.sort((a, b) => (a as Phaser.GameObjects.Container).y - (b as Phaser.GameObjects.Container).y);
  }

  private resourceTooltipContainer: Phaser.GameObjects.Container | null = null;
  private resourceTooltipBg: Phaser.GameObjects.Graphics | null = null;
  private resourceTooltipText: Phaser.GameObjects.Text | null = null;

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
    const padX = 12;
    const padY = 6;

    this.resourceTooltipBg.clear();
    this.resourceTooltipBg.fillStyle(0x000000, 0.75);
    this.resourceTooltipBg.fillRoundedRect(
      -textW / 2 - padX,
      -textH / 2 - padY,
      textW + padX * 2,
      textH + padY * 2,
      6,
    );

    this.resourceTooltipContainer.setPosition(x, y);
    this.resourceTooltipContainer.setVisible(true);
  }

  private hideResourceTooltip(): void {
    this.resourceTooltipContainer?.setVisible(false);
  }

  private setupGroundClickHandler(): void {
    // Use the main camera's input to detect clicks on empty ground.
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
      if (!this.playerSprite) return;
      if (this.playerSprite.isMoving) return;

      // Check if we clicked on a character sprite or UI element - if so, skip ground move.
      const clickedOnSprite = currentlyOver.some(
        (obj) => obj instanceof CharacterSprite || obj === this.playerSprite
      );
      if (clickedOnSprite) return;

      // Check if we clicked on an interactive object (resource node)
      const clickedOnObject = currentlyOver.some((obj) => {
        return obj instanceof Phaser.GameObjects.Zone;
      });
      if (clickedOnObject) return;

      // Check if we clicked on a resource marker
      if (this.resourceMarkers) {
        const clickedOnMarker = currentlyOver.some((obj) => {
          // Walk up the parent chain to see if we're inside a resource marker
          let current: any = obj;
          while (current) {
            if (current === this.resourceMarkers) return true;
            current = current.parentContainer;
          }
          return false;
        });
        if (clickedOnMarker) return;
      }

      // Get world position from pointer
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const targetX = Phaser.Math.Clamp(worldPoint.x, 32, this.mapPixelWidth - 32);
      const targetY = Phaser.Math.Clamp(worldPoint.y, 32, this.mapPixelHeight - 32);

      this.movePlayerTo(targetX, targetY);
    });
  }

  private async movePlayerTo(targetX: number, targetY: number): Promise<void> {
    if (!this.playerSprite) return;

    // Optimistic: start moving locally first for responsiveness
    this.playerSprite.moveToPosition(targetX, targetY, () => {
      this.updateNearbyResource();
    });

    // Sync with server in the background
    try {
      const result = await apiClient.movePlayer(targetX, targetY);
      if (result.ok && result.playerState) {
        // If server returns a different position, snap to it gently
        const serverX = result.playerState.pixelX;
        const serverY = result.playerState.pixelY;
        const dist = Phaser.Math.Distance.Between(
          this.playerSprite.x,
          this.playerSprite.y,
          serverX,
          serverY
        );
        if (dist > 10 && !this.playerSprite.isMoving) {
          this.playerSprite.moveToPosition(serverX, serverY);
        }
      }
    } catch (e) {
      console.warn("[WorldScene] Failed to sync player move:", e);
    }
  }

  private setupResourceInteraction(): void {
    // Add click handlers for resource nodes via the interactive object zones
    for (const object of this.mapManager.getInteractiveObjects()) {
      const node = this.resourceNodes.get(object.objectId);
      if (!node) continue;

      // Find the existing zone and add a click handler
      const zones = this.children.getAll().filter(
        (child) =>
          child instanceof Phaser.GameObjects.Zone &&
          child.x === object.x &&
          child.y === object.y
      );

      for (const zone of zones) {
        (zone as Phaser.GameObjects.Zone).on("pointerdown", () => {
          this.handleResourceClick(node.objectId);
        });
      }
    }
  }

  private handleResourceClick(objectId: string): void {
    if (!this.playerSprite) return;
    const node = this.resourceNodes.get(objectId);
    if (!node) return;

    // Calculate the interaction position (in front of the object)
    const targetX = node.x + node.width / 2;
    const targetY = node.y + node.height + 20;

    const dist = Phaser.Math.Distance.Between(
      this.playerSprite.x,
      this.playerSprite.y,
      targetX,
      targetY
    );

    if (dist <= this.COLLECT_INTERACTION_RADIUS) {
      // Player is already nearby, show collect button
      this.showCollectButton(objectId);
    } else {
      // Move player to the resource first
      this.movePlayerTo(targetX, targetY);
    }
  }

  private setupCollectButton(): void {
    this.collectButtonContainer = this.add.container(0, 0);
    this.collectButtonContainer.setDepth(30);
    this.collectButtonContainer.setVisible(false);

    this.collectButtonBg = this.add.graphics();
    this.collectButtonText = this.add
      .text(0, 0, "采集", {
        fontSize: "14px",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        color: "#ffffff",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);

    this.collectButtonContainer.add([this.collectButtonBg, this.collectButtonText]);

    // Make button interactive
    this.collectButtonContainer.setSize(80, 32);
    this.collectButtonContainer.setInteractive(
      new Phaser.Geom.Rectangle(-40, -16, 80, 32),
      Phaser.Geom.Rectangle.Contains
    );
    this.collectButtonContainer.on("pointerdown", () => {
      if (this.nearbyResourceObjectId) {
        this.collectResource(this.nearbyResourceObjectId);
      }
    });
    this.collectButtonContainer.on("pointerover", () => {
      this.collectButtonText?.setStyle({ color: "#a3f7bf" });
    });
    this.collectButtonContainer.on("pointerout", () => {
      this.collectButtonText?.setStyle({ color: "#ffffff" });
    });
  }

  private showCollectButton(objectId: string): void {
    if (!this.collectButtonContainer || !this.collectButtonBg || !this.collectButtonText) return;

    const node = this.resourceNodes.get(objectId);
    if (!node) return;

    this.nearbyResourceObjectId = objectId;

    const btnW = 80;
    const btnH = 32;
    this.collectButtonBg.clear();
    this.collectButtonBg.fillStyle(0x00b894, 0.9);
    this.collectButtonBg.fillRoundedRect(-btnW / 2, -btnH / 2, btnW, btnH, 8);
    this.collectButtonBg.lineStyle(2, 0xffffff, 0.3);
    this.collectButtonBg.strokeRoundedRect(-btnW / 2, -btnH / 2, btnW, btnH, 8);

    const btnX = node.x + node.width / 2;
    const btnY = node.y - 20;
    this.collectButtonContainer.setPosition(btnX, btnY);
    this.collectButtonContainer.setVisible(true);
  }

  private hideCollectButton(): void {
    this.collectButtonContainer?.setVisible(false);
    this.nearbyResourceObjectId = null;
  }

  private updateNearbyResource(): void {
    if (!this.playerSprite) return;

    let nearestNode: ResourceNodeNormalized | null = null;
    let nearestDist = Infinity;

    for (const node of this.resourceNodes.values()) {
      const nodeCenterX = node.x + node.width / 2;
      const nodeCenterY = node.y + node.height / 2;
      const dist = Phaser.Math.Distance.Between(
        this.playerSprite.x,
        this.playerSprite.y,
        nodeCenterX,
        nodeCenterY
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
    try {
      const result = await apiClient.collectResource(objectId);
      if (result.success) {
        // Update local resource node
        const node = this.resourceNodes.get(objectId);
        if (node) {
          // Decrement remaining count
          node.remaining = Math.max(0, node.remaining - 1);
        }

        // Update build state with new resources
        if (this.buildState) {
          this.buildState.resources = result.resources;
        }

        this.eventBus.emit("resource_collected", {
          objectId,
          gained: result.amount,
          resources: result.resources,
        });

        this.eventBus.emit("build_state_updated", this.buildState);

        // Hide button if depleted
        if (node && node.remaining <= 0) {
          this.hideCollectButton();
        }
      }
    } catch (e) {
      console.warn("[WorldScene] Failed to collect resource:", e);
    }
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
    const characters = await apiClient.getCharacters();
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

    // Preload all character spritesheets dynamically (no dependency on BootScene timing)
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
        // Try upgrading from circle fallback if sprite is now available
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

  /** Dynamically load character spritesheets via Phaser Loader. */
  private loadCharacterSpritesheets(charIds: string[]): Promise<void> {
    return new Promise((resolve) => {
      let remaining = charIds.length;
      if (remaining === 0) {
        resolve();
        return;
      }

      for (const charId of charIds) {
        this.load.spritesheet(charId, `/assets/characters/${charId}/spritesheet.png`, {
          frameWidth: SPRITE_FRAME_WIDTH,
          frameHeight: SPRITE_FRAME_HEIGHT,
        });
      }

      this.load.once("complete", () => {
        // Apply LINEAR filter to all loaded character textures
        for (const charId of charIds) {
          if (this.textures.exists(charId)) {
            this.textures.get(charId).setFilter(Phaser.Textures.FilterMode.LINEAR);
          }
        }
        resolve();
      });

      this.load.once("loaderror", () => {
        // Even if some fail, continue
        remaining--;
        if (remaining <= 0) resolve();
      });

      this.load.start();
    });
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
    if (!this.isReplaying) {
      this.characterMovement?.updateAmbientMovement(performance.now());
    }
    const zoom = this.cameras.main.zoom;
    for (const sprite of this.characterSprites.values()) {
      sprite.syncOverlayZoom(zoom);
    }
    this.playerSprite?.syncOverlayZoom(zoom);
    if (this.entityLayer) {
      this.entityLayer.list.sort((a, b) => {
        const ay = a instanceof CharacterSprite
          ? a.getSortFootY()
          : a instanceof PlayerSprite
          ? a.getSortFootY()
          : (a as Phaser.GameObjects.Sprite).y || 0;
        const by = b instanceof CharacterSprite
          ? b.getSortFootY()
          : b instanceof PlayerSprite
          ? b.getSortFootY()
          : (b as Phaser.GameObjects.Sprite).y || 0;
        return ay - by;
      });
    }
  }
}
