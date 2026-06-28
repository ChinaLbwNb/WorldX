import type {
  CharacterInfo,
  CharacterDetail,
  DiaryEntry,
  MemoryEntry,
  SimulationEvent,
  WorldTimeInfo,
  LocationInfo,
  GameTime,
  MainAreaPointInfo,
  SceneConfigInfo,
  SceneRuntimeInfo,
  TimelineMeta,
  TimelineWithWorld,
  TimelineFrame,
  BuildState,
  BuildJobStatus,
  WorldMapsState,
} from "../../types/api";

const API_BASE = "/api";
const LS_USER_ID = "worldx_user_id";
const LS_AUTH_TOKEN = "worldx_auth_token";

function getStoredUserId(): string {
  if (typeof localStorage === "undefined") return "local_user";
  const value = (localStorage.getItem(LS_USER_ID) ?? "").trim();
  if (value) return value.slice(0, 64);
  localStorage.setItem(LS_USER_ID, "local_user");
  return "local_user";
}

async function requestJSON<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  // 附带房间邀请码（与 WS 握手共用同一 localStorage 值），用于服务端 HTTP 门禁校验
  const code =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("worldx_invite_code") ?? ""
      : "";
  const headers = { ...(init?.headers ?? {}), "x-room-code": code, "x-user-id": getStoredUserId() };
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(LS_AUTH_TOKEN) ?? ""
      : "";
  if (token) {
    (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      // Ignore non-JSON error bodies.
    }
    throw new Error(`API ${res.status}${detail}`);
  }
  return res.json();
}

function fetchJSON<T>(path: string): Promise<T> {
  return requestJSON(path);
}

function postJSON<T>(path: string, body?: unknown): Promise<T> {
  return requestJSON(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deleteJSON<T>(path: string): Promise<T> {
  return requestJSON(path, { method: "DELETE" });
}

function patchJSON<T>(path: string, body?: unknown): Promise<T> {
  return requestJSON(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deleteJSONWithBody<T>(path: string, body?: unknown): Promise<T> {
  return requestJSON(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface WorldInfo {
  worldName: string;
  worldDescription: string;
  originalPrompt?: string;
  currentWorldId?: string | null;
  currentTimelineId?: string | null;
  sceneConfig: SceneConfigInfo;
  sceneRuntime: SceneRuntimeInfo;
  mainAreaPoints?: MainAreaPointInfo[];
  timelineTickCount?: number;
}

export type WorldSource = "user" | "library";

export interface GeneratedWorldSummary {
  id: string;
  worldName: string;
  source: WorldSource;
  ownerUserId?: string;
  visibility?: "private" | "unlisted" | "public";
  canManage?: boolean;
  isCurrent: boolean;
  timelineCount?: number;
}

export interface GeneratedWorldListResponse {
  currentWorldId: string | null;
  currentTimelineId: string | null;
  worlds: GeneratedWorldSummary[];
  libraryWorlds: GeneratedWorldSummary[];
}

export interface OnlinePlayerInfo {
  userId: string;
  playerId: string;
  playerName: string;
  worldId: string;
  timelineId: string;
  mapId: string;
  connectedAt: number;
  lastSeenAt: number;
  isSelf: boolean;
  isCurrentMap: boolean;
}

export interface OnlinePlayersResponse {
  worldId: string;
  timelineId: string;
  activeMapId: string;
  canManage: boolean;
  players: OnlinePlayerInfo[];
}

export interface UserCharacterInfo {
  id: string;
  name: string;
  worldId: string;
  timelineId: string;
  currentMapId: string;
  location: string;
  mainAreaPointId: string | null;
  x: number;
  y: number;
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
  online: boolean;
}

export interface UserAccountInfo {
  id: string;
  displayName: string;
  characterCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUserInfo {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionResponse {
  ok: boolean;
  user: AuthUserInfo;
  token: string;
  expiresAt: number;
}

export interface InventoryItemInfo {
  entryId: string;
  itemInstanceId: string;
  definitionId: string;
  name: string;
  description: string;
  category: string;
  iconKey: string | null;
  quantity: number;
  stackable: boolean;
  maxStack: number;
  placeable: boolean;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface MapItemPlacementInfo {
  id: string;
  itemInstanceId: string;
  definitionId: string;
  name: string;
  worldId: string;
  timelineId: string;
  mapId: string;
  x: number;
  y: number;
  rotation: number;
  state: string;
  placedBy: { ownerType: string; ownerId: string } | null;
  metadata: Record<string, unknown>;
}

export type CreateJobSizeK = 1 | 2 | 4;

export type CreateJobPhase = 1 | 2 | 3 | 4;

export type CreateJobEvent =
  | { kind: "job_started"; at: number; jobId: string; prompt: string; sizeK: CreateJobSizeK }
  | { kind: "phase"; at: number; phase: CreateJobPhase; label: string }
  | { kind: "step"; at: number; phase: CreateJobPhase; step: string; label: string }
  | { kind: "info"; at: number; label: string }
  | { kind: "world_id"; at: number; worldId: string }
  | { kind: "log"; at: number; stream: "stdout" | "stderr"; line: string }
  | { kind: "job_done"; at: number; worldId: string; worldName?: string }
  | { kind: "job_error"; at: number; message: string; tail: string[] };

export interface CreateJobSnapshot {
  jobId: string;
  status: "running" | "done" | "error";
  prompt: string;
  sizeK: CreateJobSizeK;
  phase: CreateJobPhase | null;
  step: string | null;
  startedAt: number;
  finishedAt: number | null;
  worldId: string | null;
  worldName: string | null;
  error: string | null;
}

export class JobConflictError extends Error {
  activeJobId: string;
  constructor(message: string, activeJobId: string) {
    super(message);
    this.name = "JobConflictError";
    this.activeJobId = activeJobId;
  }
}

export const apiClient = {
  getWorldTime(): Promise<WorldTimeInfo> {
    return fetchJSON("/world/time");
  },

  getWorldInfo(): Promise<WorldInfo> {
    return fetchJSON("/world/info");
  },

  getGeneratedWorlds(): Promise<GeneratedWorldListResponse> {
    return fetchJSON("/world/worlds");
  },

  getLocations(): Promise<LocationInfo[]> {
    return fetchJSON("/world/locations");
  },

  getCharacters(): Promise<CharacterInfo[]> {
    return fetchJSON("/characters");
  },

  getCharacterDetail(id: string): Promise<CharacterDetail> {
    return fetchJSON(`/characters/${id}`);
  },


  getDiary(id: string, day?: number): Promise<DiaryEntry[]> {
    const q = day != null ? `?day=${day}` : "";
    return fetchJSON(`/characters/${id}/diary${q}`);
  },

  getMemories(id: string): Promise<MemoryEntry[]> {
    return fetchJSON(`/characters/${id}/memories`);
  },

  getEvents(params: {
    fromDay?: number;
    toDay?: number;
    type?: string;
    actorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<SimulationEvent[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null) q.set(k, String(v));
    }
    return fetchJSON(`/events?${q}`);
  },

  getEventsByRange(from: GameTime, to: GameTime): Promise<SimulationEvent[]> {
    const q = new URLSearchParams({
      fromDay: String(from.day),
      fromTick: String(from.tick),
      toDay: String(to.day),
      toTick: String(to.tick),
    });
    return fetchJSON(`/events/range?${q}`);
  },

  getHighlights(minScore = 6, limit = 20): Promise<SimulationEvent[]> {
    return fetchJSON(`/events/highlights?minScore=${minScore}&limit=${limit}`);
  },

  simulateTick(context: {
    worldId: string;
    timelineId: string;
  }): Promise<{
    ok: boolean;
    gameTime: WorldTimeInfo;
    eventCount: number;
    events: SimulationEvent[];
    activeSimulationTicks?: number;
    canSwitchContext?: boolean;
  }> {
    return postJSON("/simulation/tick", context);
  },

  simulateDay(): Promise<{ ok: boolean; gameTime: WorldTimeInfo; eventCount: number }> {
    return postJSON("/simulation/day");
  },

  switchWorld(worldId: string): Promise<{
    ok: boolean;
    currentWorldId: string;
    worldName: string;
  }> {
    return postJSON("/world/select", { worldId });
  },

  resetWorld(): Promise<{ ok: boolean; gameTime: WorldTimeInfo }> {
    return postJSON("/simulation/reset");
  },

  setDevTickDurationMinutes(tickDurationMinutes: 15 | 30 | 60): Promise<{
    ok: boolean;
    gameTime: WorldTimeInfo;
    sceneConfig: SceneConfigInfo;
    sceneRuntime: SceneRuntimeInfo;
  }> {
    return postJSON("/world/dev/tick-duration", { tickDurationMinutes });
  },

  godBroadcast(params: {
    content: string;
    scope?: string;
    tone?: string;
    tags?: string[];
    writeMemory?: boolean;
  }): Promise<{ ok: boolean; event: SimulationEvent; memoryWrittenTo: number }> {
    return postJSON("/god/broadcast", params);
  },

  godWhisper(params: {
    characterId: string;
    content: string;
    importance?: number;
    type?: "observation" | "dream" | "reflection" | "experience";
    tags?: string[];
    emotionalValence?: number;
    emotionalIntensity?: number;
  }): Promise<{ ok: boolean; memory: MemoryEntry }> {
    return postJSON("/god/whisper", params);
  },

  sandboxChatStart(params: {
    characterId: string;
    userIdentity?: string;
  }): Promise<{
    ok: boolean;
    sessionId: string;
    character: { id: string; name: string; role: string };
  }> {
    return postJSON("/sandbox/chat/start", params);
  },

  sandboxChatSend(params: {
    sessionId: string;
    message: string;
  }): Promise<{
    ok: boolean;
    reply: string;
    character: { id: string; name: string };
  }> {
    return postJSON("/sandbox/chat/message", params);
  },

  sandboxChatGet(sessionId: string): Promise<{
    ok: boolean;
    sessionId: string;
    characterId: string;
    userIdentity: string;
    history: Array<{ role: "user" | "character"; content: string }>;
  }> {
    return fetchJSON(`/sandbox/chat/${sessionId}`);
  },

  sandboxChatClose(sessionId: string): Promise<{ ok: boolean }> {
    return postJSON("/sandbox/chat/close", { sessionId });
  },

  patchCharacterProfile(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: boolean; profile: Record<string, unknown> }> {
    return patchJSON(`/characters/${id}/profile`, patch);
  },

  patchCharacterRuntimeState(
    id: string,
    patch: { mainAreaPointId?: string | null },
  ): Promise<{ ok: boolean; state: Record<string, unknown> }> {
    return patchJSON(`/characters/${id}/runtime-state`, patch);
  },

  async createWorld(params: {
    prompt: string;
    sizeK: CreateJobSizeK;
    keepArtifacts?: boolean;
  }): Promise<{ ok: boolean; jobId: string }> {
    const res = await fetch(`${API_BASE}/worlds/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": getStoredUserId(),
        ...(localStorage.getItem(LS_AUTH_TOKEN)
          ? { Authorization: `Bearer ${localStorage.getItem(LS_AUTH_TOKEN)}` }
          : {}),
      },
      body: JSON.stringify(params),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      throw new JobConflictError(
        typeof body.error === "string" ? body.error : "Generation already running",
        typeof body.activeJobId === "string" ? body.activeJobId : "",
      );
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body.error ? `: ${body.error}` : "";
      } catch {
        // Ignore.
      }
      throw new Error(`API ${res.status}${detail}`);
    }
    return res.json();
  },

  getCurrentJob(): Promise<{ jobId: string | null; snapshot?: CreateJobSnapshot }> {
    return fetchJSON("/worlds/jobs/current");
  },

  getJobStatus(jobId: string): Promise<CreateJobSnapshot> {
    return fetchJSON(`/worlds/jobs/${encodeURIComponent(jobId)}`);
  },

  cancelCreateWorld(jobId: string): Promise<{ ok: boolean }> {
    return postJSON(`/worlds/jobs/${encodeURIComponent(jobId)}/cancel`);
  },

  subscribeJobEvents(
    jobId: string,
    onEvent: (event: CreateJobEvent) => void,
    onError?: (event: Event) => void,
  ): () => void {
    const token =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(LS_AUTH_TOKEN) ?? ""
        : "";
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${API_BASE}/worlds/jobs/${encodeURIComponent(jobId)}/events${qs}`;
    const source = new EventSource(url);
    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as CreateJobEvent;
        onEvent(parsed);
      } catch (err) {
        console.warn("[api-client] Failed to parse job event:", err);
      }
    };
    if (onError) {
      source.onerror = onError;
    }
    return () => {
      source.close();
    };
  },

  deleteWorld(worldId: string): Promise<{ ok: boolean; deletedWorldId: string }> {
    return deleteJSON(`/world/worlds/${encodeURIComponent(worldId)}`);
  },

  updateWorldVisibility(
    worldId: string,
    visibility: "private" | "unlisted" | "public",
  ): Promise<{ ok: boolean; worldId: string; metadata: { ownerUserId: string; visibility: string } }> {
    return patchJSON(`/world/worlds/${encodeURIComponent(worldId)}`, { visibility });
  },

  getOnlinePlayers(): Promise<OnlinePlayersResponse> {
    return fetchJSON("/world/online");
  },

  kickOnlinePlayer(playerId: string): Promise<{ ok: boolean; playerId: string }> {
    return postJSON("/world/online/kick", { playerId });
  },

  // --- Timeline APIs ---

  getTimelines(): Promise<{ timelines: TimelineMeta[]; currentTimelineId: string | null }> {
    return fetchJSON("/timelines");
  },

  getCurrentTimeline(): Promise<{ timeline: TimelineMeta }> {
    return fetchJSON("/timelines/current");
  },

  createNewTimeline(): Promise<{ ok: boolean; timelineId: string }> {
    return postJSON("/timelines");
  },

  loadTimeline(timelineId: string): Promise<{ ok: boolean }> {
    return postJSON(`/timelines/${encodeURIComponent(timelineId)}/load`);
  },

  deleteTimeline(timelineId: string): Promise<{ ok: boolean }> {
    return deleteJSON(`/timelines/${encodeURIComponent(timelineId)}`);
  },

  getTimelineEvents(timelineId: string): Promise<{ frames: TimelineFrame[] }> {
    return fetchJSON(`/timelines/${encodeURIComponent(timelineId)}/events`);
  },

  getAllTimelinesGrouped(): Promise<{
    groups: TimelineWithWorld[];
    currentTimelineId: string | null;
  }> {
    return fetchJSON("/timelines/all");
  },

  deleteTimelineFromWorld(
    worldId: string,
    timelineId: string,
  ): Promise<{ ok: boolean }> {
    return deleteJSON(
      `/timelines/world/${encodeURIComponent(worldId)}/${encodeURIComponent(timelineId)}`,
    );
  },

  // --- Player APIs ---

  getPlayerAvatar(): Promise<{
    id: string;
    name: string;
    mode: "avatar" | "god";
    location: string;
    mainAreaPointId: string | null;
    x: number;
    y: number;
    currentAction: string | null;
    currentActionTarget: string | null;
    isOnline: boolean;
    isControlledByLLM: boolean;
    appearance: UserCharacterInfo["appearance"];
    inventory: Array<{ itemId: string; name: string; quantity: number }>;
  }> {
    return fetchJSON("/player/avatar");
  },

  updatePlayerPosition(params: {
    x: number;
    y: number;
    location: string;
    mainAreaPointId: string | null;
  }): Promise<{ ok: boolean }> {
    return postJSON("/player/avatar/move", params);
  },

  setPlayerMode(playerId: string, mode: "avatar" | "god"): Promise<{ ok: boolean }> {
    return postJSON("/player/mode", { playerId, mode });
  },

  playerInteract(playerId: string, params: {
    actionType: string;
    targetId: string;
    interactionId?: string;
  }): Promise<{ ok: boolean; action: { actionType: string; targetId: string; interactionId?: string; startTick: number; endTick: number } }> {
    return postJSON("/player/avatar/interact", { playerId, ...params });
  },

  // --- User character APIs ---

  register(params: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<AuthSessionResponse> {
    return postJSON("/auth/register", params);
  },

  login(params: {
    username: string;
    password: string;
  }): Promise<AuthSessionResponse> {
    return postJSON("/auth/login", params);
  },

  getAuthMe(): Promise<{ ok: boolean; user: AuthUserInfo }> {
    return fetchJSON("/auth/me");
  },

  logout(): Promise<{ ok: boolean }> {
    return postJSON("/auth/logout");
  },

  getCurrentUser(): Promise<{ userId: string; user: UserAccountInfo | null }> {
    return fetchJSON("/users/me");
  },

  getUsers(): Promise<{ users: UserAccountInfo[] }> {
    return fetchJSON("/users");
  },

  createUser(displayName: string): Promise<{ userId: string; user: UserAccountInfo }> {
    return postJSON("/users", { displayName });
  },

  updateUser(userId: string, displayName: string): Promise<{ ok: boolean; user: UserAccountInfo }> {
    return patchJSON(`/users/${encodeURIComponent(userId)}`, { displayName });
  },

  deleteUser(userId: string): Promise<{ ok: boolean; deletedUserId: string }> {
    return deleteJSON(`/users/${encodeURIComponent(userId)}`);
  },

  getUserCharacters(): Promise<{ characters: UserCharacterInfo[] }> {
    return fetchJSON("/user-characters");
  },

  createUserCharacter(
    name: string,
    options?: { prompt?: string; generateAppearance?: boolean },
  ): Promise<{ character: UserCharacterInfo }> {
    return postJSON("/user-characters", {
      name,
      prompt: options?.prompt ?? name,
      generateAppearance: options?.generateAppearance ?? true,
    });
  },

  updateUserCharacter(
    userCharacterId: string,
    params: { name: string },
  ): Promise<{ ok: boolean; character: UserCharacterInfo }> {
    return patchJSON(`/user-characters/${encodeURIComponent(userCharacterId)}`, params);
  },

  deleteUserCharacter(
    userCharacterId: string,
  ): Promise<{ ok: boolean; deletedCharacterId: string }> {
    return deleteJSONWithBody(`/user-characters/${encodeURIComponent(userCharacterId)}`);
  },

  getUserCharacterInventory(
    userCharacterId: string,
  ): Promise<{ userId: string; userCharacterId: string; items: InventoryItemInfo[] }> {
    return fetchJSON(`/user-characters/${encodeURIComponent(userCharacterId)}/inventory`);
  },

  getAccountInventory(): Promise<{ userId: string; owner: { ownerType: string; ownerId: string }; items: InventoryItemInfo[] }> {
    return fetchJSON("/items/inventory");
  },

  placeInventoryItem(params: {
    userCharacterId: string;
    entryId: string;
    x: number;
    y: number;
    rotation?: number;
    footprintTiles?: { width: number; height: number };
  }): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    placement: MapItemPlacementInfo;
    validation: unknown;
  }> {
    return postJSON("/items/place", params);
  },

  generateInventoryItem(params: {
    userCharacterId: string;
    prompt: string;
  }): Promise<{
    ok: boolean;
    cost: number;
    resources: number;
    scope: { worldId: string; timelineId: string; mapId: string };
    item: InventoryItemInfo;
    design: Record<string, unknown>;
  }> {
    return postJSON("/items/generate", params);
  },

  getMapItemPlacements(mapId?: string): Promise<{
    scope: { worldId: string; timelineId: string; mapId: string };
    placements: MapItemPlacementInfo[];
  }> {
    const suffix = mapId ? `?mapId=${encodeURIComponent(mapId)}` : "";
    return fetchJSON(`/items/placements${suffix}`);
  },

  pickupMapItem(params: {
    userCharacterId: string;
    placementId: string;
  }): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    item: InventoryItemInfo;
    placement: MapItemPlacementInfo;
  }> {
    return postJSON("/items/pickup", params);
  },

  deleteInventoryItem(params: {
    userCharacterId: string;
    entryId: string;
  }): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    item: InventoryItemInfo;
    deletedAsset: string | null;
  }> {
    return postJSON("/items/delete", params);
  },

  enterMapWithUserCharacter(
    userCharacterId: string,
    mapId: string,
  ): Promise<{ ok: boolean; character: UserCharacterInfo; requiresReload: boolean }> {
    return postJSON("/world/map/enter", { userCharacterId, mapId });
  },

  selectUserCharacter(
    userCharacterId: string,
  ): Promise<{ ok: boolean; character: UserCharacterInfo; requiresReload: boolean }> {
    return postJSON(`/user-characters/${encodeURIComponent(userCharacterId)}/select`);
  },

  enterWorldWithUserCharacter(
    userCharacterId: string,
    worldId: string,
  ): Promise<{
    ok: boolean;
    worldId: string;
    worldName: string;
    defaultMapId: string;
    character: UserCharacterInfo;
    requiresReload: boolean;
  }> {
    return postJSON("/world/enter", { userCharacterId, worldId });
  },

  // --- 建造系统 API（资源为联机全局共享池）---

  getBuildState(): Promise<BuildState> {
    return fetchJSON("/build/state");
  },

  getWorldMaps(): Promise<WorldMapsState> {
    return fetchJSON("/world/maps");
  },

  travelToMap(targetMapId: string): Promise<{ activeMapId: string; targetMapId: string; spawn: { x: number; y: number }; requiresReload: boolean }> {
    return postJSON("/world/map/travel", { targetMapId });
  },

  collectResource(
    objectId: string,
    userCharacterId?: string,
  ): Promise<{
    success: boolean;
    resources: number;
    amount: number;
    reason?: string;
    scope?: { worldId: string; timelineId: string; mapId: string } | null;
  }> {
    return postJSON("/build/collect", { objectId, userCharacterId });
  },

  buildCharacter(prompt: string): Promise<{ ok: boolean; jobId: string }> {
    return postJSON("/build/character", { prompt });
  },

  getCharacterBuildJob(jobId: string): Promise<BuildJobStatus> {
    return fetchJSON(`/build/character/jobs/${encodeURIComponent(jobId)}`);
  },

  generateMapNode(input: { prompt: string }): Promise<{ ok: boolean; jobId: string }> {
    return postJSON("/build/map/expand", input);
  },

  getMapExpandJob(jobId: string): Promise<BuildJobStatus> {
    return fetchJSON(`/build/map/jobs/${encodeURIComponent(jobId)}`);
  },
};
