import { EventEmitter } from "node:events";
import { WorldManager } from "../core/world-manager.js";
import { CharacterManager } from "../core/character-manager.js";
import { PlayerManager } from "../core/player-manager.js";
import { ResourceManager } from "../core/resource-manager.js";
import { MapRuntimeRegistry } from "../core/map-runtime-registry.js";
import { CharacterBuilder } from "../core/character-builder.js";
import { MapExpander } from "../core/map-expander.js";
import { ItemGenerator } from "../core/item-generator.js";
import { LLMClient } from "../llm/llm-client.js";
import { PromptBuilder } from "../llm/prompt-builder.js";
import { SimulationEngine } from "../simulation/simulation-engine.js";
import { DecisionMaker } from "../simulation/decision-maker.js";
import { DialogueGenerator } from "../simulation/dialogue-generator.js";
import { initDatabase, closeDb } from "../store/db.js";
import { reloadConfigs } from "../utils/config-loader.js";
import { TimelineManager } from "./timeline-manager.js";
import type { SceneConfig } from "../types/index.js";
import type { InitFrameCharacter } from "./timeline-manager.js";

export class AppContext {
  worldManager!: WorldManager;
  characterManager!: CharacterManager;
  playerManager!: PlayerManager;
  resourceManager!: ResourceManager;
  mapRuntimeRegistry = new MapRuntimeRegistry();
  characterBuilder!: CharacterBuilder;
  mapExpander!: MapExpander;
  itemGenerator!: ItemGenerator;
  llmClient!: LLMClient;
  promptBuilder!: PromptBuilder;
  decisionMaker!: DecisionMaker;
  dialogueGenerator!: DialogueGenerator;
  simulationEngine!: SimulationEngine;
  timelineManager = new TimelineManager();

  eventBus = new EventEmitter();

  private worldDirPath?: string;
  private sceneConfigOverride: Partial<SceneConfig> | null = null;
  private _initialized = false;
  private tickEventsHandlerRegistered = false;

  async initialize(worldDirPath?: string): Promise<void> {
    this.worldDirPath = worldDirPath;

    if (worldDirPath) {
      const timelineId = this.timelineManager.initialize(worldDirPath);
      const dbPath = this.timelineManager.getTimelineDbPath(worldDirPath, timelineId);
      initDatabase(dbPath);
      this.rebuildRuntime();
      this.beginRecording();
    } else {
      initDatabase();
      this.buildMinimalRuntime();
    }

    this.registerTickEventsHandler();
    this._initialized = true;
  }

  get hasWorld(): boolean {
    return !!this.worldDirPath;
  }

  getWorldDir(): string | undefined {
    return this.worldDirPath;
  }

  switchWorld(worldDirPath: string, userId?: string): void {
    this.timelineManager.stopRecording();
    closeDb();

    this.worldDirPath = worldDirPath;
    reloadConfigs();

    const timelineId = this.timelineManager.initialize(worldDirPath, undefined, userId);
    const dbPath = this.timelineManager.getTimelineDbPath(worldDirPath, timelineId);
    initDatabase(dbPath);

    this.rebuildRuntime();
    this.beginRecording();
    this.eventBus.emit("simulation_status", { status: "idle" });
  }

  switchTimeline(timelineId: string, userId?: string): void {
    if (!this.worldDirPath) return;

    this.timelineManager.stopRecording();
    closeDb();

    this.timelineManager.initialize(this.worldDirPath, timelineId, userId);
    const dbPath = this.timelineManager.getTimelineDbPath(this.worldDirPath, timelineId);
    initDatabase(dbPath);

    reloadConfigs();
    this.rebuildRuntime();
    this.beginRecording();
    this.eventBus.emit("simulation_status", { status: "idle" });
  }

  createNewTimeline(userId?: string): void {
    if (!this.worldDirPath) return;

    const userCharacterSnapshots = this.playerManager?.captureUserCharacterSnapshots() ?? [];
    this.timelineManager.stopRecording();
    closeDb();

    const newId = this.timelineManager.createTimeline(this.worldDirPath, userId);
    const dbPath = this.timelineManager.getTimelineDbPath(this.worldDirPath, newId);
    initDatabase(dbPath);

    reloadConfigs();
    this.rebuildRuntime();
    if (userCharacterSnapshots.length > 0) {
      this.playerManager.seedUserCharacterSnapshots(userCharacterSnapshots);
    }
    this.beginRecording();
    this.eventBus.emit("simulation_status", { status: "idle" });
  }

  resetWorldState(): void {
    this.createNewTimeline();
  }

  setDevTickDurationMinutes(minutes: number): void {
    this.sceneConfigOverride = {
      ...(this.sceneConfigOverride ?? {}),
      tickDurationMinutes: minutes,
    };
    this.createNewTimeline();
  }

  private beginRecording(): void {
    const characters = this.getInitFrameCharacters();
    this.timelineManager.startRecording(characters);
  }

  private getInitFrameCharacters(): InitFrameCharacter[] {
    const characters: InitFrameCharacter[] = [];

    if (this.characterManager) {
      characters.push(
        ...this.characterManager.getAllProfiles().map((profile) => {
          const state = this.characterManager.getState(profile.id);
          return {
            id: profile.id,
            name: profile.name,
            location: state?.location ?? "",
            mainAreaPointId: state?.mainAreaPointId ?? null,
          };
        }),
      );
    }

    // 用户角色和 NPC 分开管理，但回放初始帧仍记录所有当前用户角色。
    for (const playerState of this.playerManager?.getAllPlayers() ?? []) {
      characters.push({
        id: playerState.id,
        name: playerState.name,
        location: playerState.location,
        mainAreaPointId: playerState.mainAreaPointId,
      });
    }

    return characters;
  }

  private registerTickEventsHandler(): void {
    if (this.tickEventsHandlerRegistered) return;
    this.tickEventsHandlerRegistered = true;

    this.eventBus.on("tick_events", ({ gameTime, events }) => {
      this.timelineManager.appendTickEvents(gameTime, events);
    });
  }

  private buildMinimalRuntime(): void {
    if (!this.llmClient) {
      this.llmClient = new LLMClient();
    }
    if (!this.itemGenerator) {
      this.itemGenerator = new ItemGenerator(this.llmClient);
    }
    if (!this.promptBuilder) {
      this.promptBuilder = new PromptBuilder();
      this.promptBuilder.initialize();
    }
  }

  private rebuildRuntime(): void {
    this.mapRuntimeRegistry.reset();
    this.worldManager = new WorldManager();
    this.worldManager.initialize(this.worldDirPath);
    if (this.sceneConfigOverride) {
      this.worldManager.applySceneConfigOverride(this.sceneConfigOverride);
    }

    this.characterManager = new CharacterManager(this.worldManager);
    this.characterManager.initialize();

    this.playerManager = new PlayerManager(
      this.worldManager,
      () => (this.worldDirPath ? this.worldDirPath.split(/[\\/]/).pop() ?? null : null),
      () => this.timelineManager.getCurrentTimelineId(),
    );
    this.playerManager.initialize();

    // 建造系统：资源采集（全局共享池）、角色生成、地图扩展。
    // 不依赖建造用的单机 PlayerManager —— 资源存于 world_state 全局状态。
    this.resourceManager = new ResourceManager(this.worldManager);
    this.resourceManager.initialize();
    this.syncActiveMapRuntimeResources();
    this.characterBuilder = new CharacterBuilder(
      this.worldManager,
      this.characterManager,
      () => this.getWorldDir(),
    );
    this.mapExpander = new MapExpander(
      this.worldManager,
      () => this.getWorldDir(),
      this.resourceManager,
    );

    if (!this.llmClient) {
      this.llmClient = new LLMClient();
    }
    if (!this.itemGenerator) {
      this.itemGenerator = new ItemGenerator(this.llmClient);
    }

    this.characterManager.memoryManager.setLLMClient(this.llmClient);

    if (!this.promptBuilder) {
      this.promptBuilder = new PromptBuilder();
      this.promptBuilder.initialize();
    }
    this.promptBuilder.setContentLanguage(this.worldManager.getContentLanguage());

    this.decisionMaker = new DecisionMaker(
      this.llmClient,
      this.promptBuilder,
      this.characterManager,
      this.worldManager,
    );

    this.dialogueGenerator = new DialogueGenerator(
      this.llmClient,
      this.promptBuilder,
      this.characterManager,
      this.worldManager,
    );

    this.simulationEngine = new SimulationEngine(
      this.worldManager,
      this.characterManager,
      this.playerManager,
      this.llmClient,
      this.promptBuilder,
    );
  }

  getCurrentPresenceScope(mapId: string = this.worldManager.getActiveMapId()) {
    return {
      worldId: this.worldDirPath ? this.worldDirPath.split(/[\\/]/).pop() ?? "unknown" : "unknown",
      timelineId: this.timelineManager.getCurrentTimelineId() ?? "unknown",
      mapId,
    };
  }

  syncActiveMapRuntimeResources(): void {
    if (!this.worldManager || !this.resourceManager) return;
    this.mapRuntimeRegistry.updateResourceNodes(
      this.getCurrentPresenceScope(this.worldManager.getActiveMapId()),
      this.resourceManager.getAllResourceNodes(),
    );
  }
}

export const appContext = new AppContext();
