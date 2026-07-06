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
  MapNodesState,
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
  const headers = { ...(init?.headers ?? {}), "x-user-id": getStoredUserId() };
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

function withUserCharacterQuery(path: string, userCharacterId?: string): string {
  if (!userCharacterId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}userCharacterId=${encodeURIComponent(userCharacterId)}`;
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
  role?: "owner" | "admin" | "builder" | "viewer" | "public" | null;
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
  allPlayers?: OnlinePlayerInfo[];
}

export interface WorldMemberInfo {
  userId: string;
  role: "admin" | "builder" | "viewer";
  invitedByUserId: string | null;
  createdAt: string;
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

export type TutorialTaskEventType =
  | "enter_world"
  | "collect_resource"
  | "talk_to_npc"
  | "generate_item"
  | "place_item"
  | "run_tick"
  | "generate_map_node";

export type TaskScopeType = "account" | "world" | "timeline" | "map";

export type TaskObjectiveKind =
  | "event_count"
  | "visit_world"
  | "collect_resource"
  | "talk_to_npc"
  | "generate_item"
  | "place_item"
  | "run_tick"
  | "generate_map_node";

export type TaskRewardKind =
  | "resource"
  | "item_definition"
  | "unlock_feature"
  | "world_flag"
  | "relationship_delta"
  | "none";

export interface TaskTargetInfo {
  worldId?: string;
  timelineId?: string;
  mapId?: string;
  npcId?: string;
  itemCategory?: string;
  resourceType?: string;
  featureId?: string;
  flagKey?: string;
}

export interface TutorialObjectiveInfo {
  id: string;
  kind: TaskObjectiveKind;
  eventType: TutorialTaskEventType;
  label: string;
  description: string;
  requiredCount: number;
  currentCount: number;
  completed: boolean;
  completedAt: string | null;
  target?: TaskTargetInfo;
  rewards: TaskRewardInfo[];
  metadata?: Record<string, unknown>;
}

export interface TaskRewardInfo {
  id: string;
  kind: TaskRewardKind;
  label: string;
  quantity?: number;
  target?: TaskTargetInfo;
  metadata?: Record<string, unknown>;
  claimMode: "auto" | "manual" | "none";
  claimed: boolean;
  claimedAt: string | null;
}

export interface TutorialTaskInfo {
  id: string;
  scopeType: TaskScopeType;
  title: string;
  description: string;
  status: "active" | "completed";
  progress: {
    completed: number;
    total: number;
    percent: number;
  };
  objectives: TutorialObjectiveInfo[];
  rewards: TaskRewardInfo[];
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

export interface ItemTransferInfo {
  id: string;
  userId: string;
  worldId: string;
  timelineId: string;
  mapId: string;
  itemInstanceId: string;
  quantity: number;
  fromOwner: { ownerType: string; ownerId: string } | null;
  toOwner: { ownerType: string; ownerId: string } | null;
  kind: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  item: InventoryItemInfo | null;
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
  getWorldTime(userCharacterId?: string): Promise<WorldTimeInfo> {
    return fetchJSON(withUserCharacterQuery("/world/time", userCharacterId));
  },

  getWorldInfo(userCharacterId?: string): Promise<WorldInfo> {
    return fetchJSON(withUserCharacterQuery("/world/info", userCharacterId));
  },

  getGeneratedWorlds(userCharacterId?: string): Promise<GeneratedWorldListResponse> {
    return fetchJSON(withUserCharacterQuery("/world/worlds", userCharacterId));
  },

  getLocations(userCharacterId?: string): Promise<LocationInfo[]> {
    return fetchJSON(withUserCharacterQuery("/world/locations", userCharacterId));
  },

  getCharacters(userCharacterId?: string): Promise<CharacterInfo[]> {
    return fetchJSON(withUserCharacterQuery("/characters", userCharacterId));
  },

  getCharacterDetail(id: string, userCharacterId?: string): Promise<CharacterDetail> {
    return fetchJSON(withUserCharacterQuery(`/characters/${id}`, userCharacterId));
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
    userCharacterId?: string;
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
    userCharacterId?: string;
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
    userCharacterId?: string;
    worldId?: string;
    timelineId?: string;
    mapId?: string;
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

  getWorldMembers(worldId: string): Promise<{ worldId: string; members: WorldMemberInfo[] }> {
    return fetchJSON(`/world/worlds/${encodeURIComponent(worldId)}/members`);
  },

  addWorldMember(
    worldId: string,
    userId: string,
    role: "admin" | "builder" | "viewer" = "viewer",
  ): Promise<{ ok: boolean; worldId: string; member: { userId: string; role: string } }> {
    return postJSON(`/world/worlds/${encodeURIComponent(worldId)}/members`, { userId, role });
  },

  removeWorldMember(worldId: string, userId: string): Promise<{ ok: boolean; worldId: string; removedUserId: string }> {
    return deleteJSON(`/world/worlds/${encodeURIComponent(worldId)}/members/${encodeURIComponent(userId)}`);
  },

  getOnlinePlayers(userCharacterId?: string): Promise<OnlinePlayersResponse> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return fetchJSON(`/world/online${query}`);
  },

  kickOnlinePlayer(playerId: string): Promise<{ ok: boolean; playerId: string }> {
    return postJSON("/world/online/kick", { playerId });
  },

  inviteOnlinePlayer(input: {
    userCharacterId: string;
    targetPlayerId: string;
    role?: "admin" | "builder" | "viewer";
  }): Promise<{ ok: boolean; inviteId: string; targetPlayerId: string; expiresAt: number }> {
    return postJSON("/world/online/invite", input);
  },

  respondWorldInvite(input: {
    inviteId: string;
    accepted: boolean;
    userCharacterId?: string;
  }): Promise<{ ok: boolean; accepted: boolean; worldId?: string; worldName?: string; role?: string }> {
    return postJSON(`/world/online/invites/${encodeURIComponent(input.inviteId)}/respond`, {
      accepted: input.accepted,
      userCharacterId: input.userCharacterId,
    });
  },

  // --- Timeline APIs ---

  getTimelines(userCharacterId?: string): Promise<{ timelines: TimelineMeta[]; currentTimelineId: string | null; worldId?: string }> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return fetchJSON(`/timelines${query}`);
  },

  getCurrentTimeline(userCharacterId?: string): Promise<{ timeline: TimelineMeta }> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return fetchJSON(`/timelines/current${query}`);
  },

  createNewTimeline(userCharacterId?: string): Promise<{ ok: boolean; timelineId: string; worldId?: string }> {
    return postJSON("/timelines", userCharacterId ? { userCharacterId } : {});
  },

  loadTimeline(timelineId: string, userCharacterId?: string): Promise<{
    ok: boolean;
    timelineId?: string;
    character?: UserCharacterInfo | null;
    presence?: { worldId: string; timelineId: string; currentMapId: string } | null;
  }> {
    return postJSON(`/timelines/${encodeURIComponent(timelineId)}/load`, userCharacterId ? { userCharacterId } : {});
  },

  deleteTimeline(timelineId: string, userCharacterId?: string): Promise<{ ok: boolean }> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return deleteJSON(`/timelines/${encodeURIComponent(timelineId)}${query}`);
  },

  getTimelineEvents(timelineId: string, userCharacterId?: string): Promise<{ frames: TimelineFrame[] }> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return fetchJSON(`/timelines/${encodeURIComponent(timelineId)}/events${query}`);
  },

  getAllTimelinesGrouped(userCharacterId?: string): Promise<{
    groups: TimelineWithWorld[];
    currentTimelineId: string | null;
  }> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return fetchJSON(`/timelines/all${query}`);
  },

  deleteTimelineFromWorld(
    worldId: string,
    timelineId: string,
  ): Promise<{ ok: boolean }> {
    return deleteJSON(
      `/timelines/world/${encodeURIComponent(worldId)}/${encodeURIComponent(timelineId)}`,
    );
  },

  // --- User character runtime APIs ---

  getUserCharacterRuntimeAvatar(userCharacterId: string): Promise<{
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
    return fetchJSON(`/user-character-runtime/avatar?userCharacterId=${encodeURIComponent(userCharacterId)}`);
  },

  updateUserCharacterPosition(params: {
    userCharacterId: string;
    x: number;
    y: number;
    location: string;
    mainAreaPointId: string | null;
  }): Promise<{ ok: boolean }> {
    return postJSON("/user-character-runtime/avatar/move", params);
  },

  setUserCharacterMode(userCharacterId: string, mode: "avatar" | "god"): Promise<{ ok: boolean }> {
    return postJSON("/user-character-runtime/mode", { userCharacterId, mode });
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

  deleteUser(userId: string): Promise<{
    ok: boolean;
    result: {
      deletedUserId: string;
      deletedCharacters: number;
      deletedItemInstances: number;
      deletedWorldAssets: number;
      deletedWorldDirectories: string[];
      preservedActiveWorlds: string[];
      deletedTimelineAssets: number;
      removedAssetDirs: string[];
      cleanedTimelineDbs: number;
    };
  }> {
    return deleteJSON(`/users/${encodeURIComponent(userId)}`);
  },

  getUserCharacters(): Promise<{ characters: UserCharacterInfo[] }> {
    return fetchJSON("/user-characters");
  },

  createUserCharacter(
    name: string,
    options?: { prompt?: string; generateAppearance?: boolean },
  ): Promise<{ character: UserCharacterInfo; cost?: number; resources?: number }> {
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

  getItemTransfers(status: "requested" | "completed" | "cancelled" | "failed" = "requested"): Promise<{
    userId: string;
    status: string;
    incoming: ItemTransferInfo[];
    outgoing: ItemTransferInfo[];
  }> {
    return fetchJSON(`/items/transfers?status=${encodeURIComponent(status)}`);
  },

  requestItemTransfer(params: {
    userCharacterId: string;
    entryId: string;
    targetUserId: string;
  }): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    transfer: ItemTransferInfo;
  }> {
    return postJSON("/items/transfer/request", params);
  },

  requestItemTrade(params: {
    userCharacterId: string;
    offerEntryId: string;
    targetUserId: string;
    requestedEntryId: string;
  }): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    transfer: ItemTransferInfo;
  }> {
    return postJSON("/items/trade/request", params);
  },

  getTradeCandidates(params: {
    userCharacterId: string;
    targetUserId: string;
  }): Promise<{
    scope: { worldId: string; timelineId: string; mapId: string };
    targetUserId: string;
    items: InventoryItemInfo[];
  }> {
    const search = new URLSearchParams();
    search.set("userCharacterId", params.userCharacterId);
    search.set("targetUserId", params.targetUserId);
    return fetchJSON(`/items/trade/candidates?${search.toString()}`);
  },

  respondItemTransfer(transferId: string, accept: boolean): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    transfer: ItemTransferInfo;
  }> {
    return postJSON(`/items/transfer/${encodeURIComponent(transferId)}/respond`, { accept });
  },

  cancelItemTransfer(transferId: string): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    transfer: ItemTransferInfo;
  }> {
    return postJSON(`/items/transfer/${encodeURIComponent(transferId)}/cancel`);
  },

  placeInventoryItem(params: {
    userCharacterId: string;
    entryId: string;
    x: number;
    y: number;
    rotation?: number;
    footprintTiles?: { width: number; height: number };
    visualScale?: number;
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

  getMapItemPlacements(params?: { mapId?: string; userCharacterId?: string }): Promise<{
    scope: { worldId: string; timelineId: string; mapId: string };
    placements: MapItemPlacementInfo[];
  }> {
    const search = new URLSearchParams();
    if (params?.mapId) search.set("mapId", params.mapId);
    if (params?.userCharacterId) search.set("userCharacterId", params.userCharacterId);
    const suffix = search.toString() ? `?${search.toString()}` : "";
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

  dropInventoryItem(params: {
    userCharacterId: string;
    entryId: string;
  }): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    kind: "drop";
    item: InventoryItemInfo;
  }> {
    return postJSON("/items/drop", params);
  },

  useInventoryItem(params: {
    userCharacterId: string;
    entryId: string;
  }): Promise<{
    ok: boolean;
    scope: { worldId: string; timelineId: string; mapId: string };
    kind: "use";
    item: InventoryItemInfo;
  }> {
    return postJSON("/items/use", params);
  },

  enterMapWithUserCharacter(
    userCharacterId: string,
    mapId: string,
  ): Promise<{ ok: boolean; character: UserCharacterInfo; requiresReload: boolean }> {
    return postJSON("/world/map/enter", { userCharacterId, mapId });
  },

  selectUserCharacter(
    userCharacterId: string,
    sourceUserCharacterId?: string,
  ): Promise<{ ok: boolean; character: UserCharacterInfo; requiresReload: boolean }> {
    return postJSON(`/user-characters/${encodeURIComponent(userCharacterId)}/select`, {
      sourceUserCharacterId,
    });
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

  getTutorialTask(): Promise<{ userId: string; task: TutorialTaskInfo }> {
    return fetchJSON("/tasks/tutorial");
  },

  reportTutorialTaskEvent(
    eventType: TutorialTaskEventType,
    count = 1,
  ): Promise<{ userId: string; task: TutorialTaskInfo }> {
    return postJSON("/tasks/tutorial/progress", { eventType, count });
  },

  resetTutorialTask(): Promise<{ userId: string; task: TutorialTaskInfo }> {
    return postJSON("/tasks/tutorial/reset");
  },

  // --- 建造系统 API（资源为联机全局共享池）---

  getBuildState(userCharacterId?: string): Promise<BuildState> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return fetchJSON(`/build/state${query}`);
  },

  getMapNodes(userCharacterId?: string): Promise<MapNodesState> {
    const query = userCharacterId ? `?userCharacterId=${encodeURIComponent(userCharacterId)}` : "";
    return fetchJSON(`/world/maps${query}`);
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

  buildCharacter(prompt: string, userCharacterId: string): Promise<{ ok: boolean; jobId: string }> {
    return postJSON("/build/character", { prompt, userCharacterId });
  },

  getCharacterBuildJob(jobId: string): Promise<BuildJobStatus> {
    return fetchJSON(`/build/character/jobs/${encodeURIComponent(jobId)}`);
  },

  generateMapNode(input: { prompt: string; userCharacterId: string }): Promise<{ ok: boolean; jobId: string }> {
    return postJSON("/build/map/expand", input);
  },

  getMapExpandJob(jobId: string): Promise<BuildJobStatus> {
    return fetchJSON(`/build/map/jobs/${encodeURIComponent(jobId)}`);
  },
};
