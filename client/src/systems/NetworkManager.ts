import { EventBus } from "../EventBus";

const LS_PLAYER_ID = "worldx_player_id";
const LS_PLAYER_NAME = "worldx_player_name";
const LS_INVITE_CODE = "worldx_invite_code";
const LS_USER_ID = "worldx_user_id";
const LS_AUTH_TOKEN = "worldx_auth_token";
const LS_USER_CHARACTER_ID = "worldx_user_character_id";

type PlayerData = {
  id: string;
  name: string;
  mode: "avatar" | "god";
  worldId?: string;
  timelineId?: string;
  currentMapId?: string;
  x: number;
  y: number;
  location: string;
  mainAreaPointId: string | null;
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
};

export class NetworkManager {
  private ws: WebSocket | null = null;
  private playerId: string | null = null;
  private eventBus = EventBus.instance;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private connectedPlayerData: { playerId: string; player: PlayerData } | null = null;
  /** 被服务端拒绝（如邀请码错误）后置 true，停止自动重连 */
  private rejected = false;

  constructor() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // 连到 /ws 路径：dev 模式由 vite 代理转发到 3100；prod 由服务端直接处理。
    this.url = `${protocol}//${window.location.host}/ws`;
  }

  /** 构造带握手参数的 WS 地址：昵称 / 邀请码 / 已有玩家ID（用于重连复用身份） */
  private buildUrl(): string {
    const params = new URLSearchParams();
    const name = localStorage.getItem(LS_PLAYER_NAME);
    const code = localStorage.getItem(LS_INVITE_CODE);
    const uid = this.getUserId();
    const token = localStorage.getItem(LS_AUTH_TOKEN);
    const pid = this.playerId ?? localStorage.getItem(LS_USER_CHARACTER_ID) ?? localStorage.getItem(LS_PLAYER_ID);
    if (name) params.set("name", name);
    if (code) params.set("code", code);
    if (token) params.set("token", token);
    if (uid) params.set("uid", uid);
    if (pid) params.set("pid", pid);
    const qs = params.toString();
    return qs ? `${this.url}?${qs}` : this.url;
  }

  connect(): void {
    if (!this.getAuthToken()) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.buildUrl());

    this.ws.onopen = () => {
      console.log("[Network] WebSocket connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {
        // 忽略解析错误
      }
    };

    this.ws.onclose = () => {
      if (this.rejected) {
        console.log("[Network] WebSocket closed by server (join rejected), not reconnecting");
        return;
      }
      console.log("[Network] WebSocket disconnected, reconnecting in 3s...");
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => {
      // onclose 会处理重连
    };
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case "connected": {
        this.playerId = msg.data.playerId;
        this.connectedPlayerData = {
          playerId: msg.data.playerId,
          player: msg.data.player,
        };
        // 持久化玩家ID，刷新/断线重连时复用同一化身
        if (this.playerId) localStorage.setItem(LS_PLAYER_ID, this.playerId);
        this.eventBus.emit("network_connected", msg.data);
        break;
      }

      case "join_rejected": {
        // 邀请码错误等：停止自动重连，交给 UI 处理
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.rejected = true;
        this.eventBus.emit("join_rejected", msg.data);
        break;
      }

      case "kicked": {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.rejected = true;
        this.eventBus.emit("player_kicked", msg.data);
        try {
          this.ws?.close();
        } catch {
          // Ignore close races.
        }
        break;
      }

      case "players_online": {
        this.eventBus.emit("players_online", msg.data);
        break;
      }

      case "player_joined": {
        this.eventBus.emit("player_joined", msg.data);
        break;
      }

      case "player_left": {
        this.eventBus.emit("player_left", msg.data);
        break;
      }

      case "player_moved": {
        this.eventBus.emit("player_moved", msg.data);
        break;
      }

      case "player_mode_changed": {
        this.eventBus.emit("remote_player_mode_changed", msg.data);
        break;
      }

      case "player_chat": {
        this.eventBus.emit("player_chat", msg.data);
        break;
      }

      case "npc_typing":
      case "npc_chat":
      case "npc_chat_error": {
        this.eventBus.emit(msg.type, msg.data);
        break;
      }

      case "simulation_events":
      case "simulation_status":
      case "highlight_detected":
        // 这些事件由现有系统处理，通过 EventBus 转发
        this.eventBus.emit(msg.type, msg.data);
        break;
    }
  }

  getPlayerId(): string | null {
    return this.playerId;
  }

  getConnectedPlayerData(): { playerId: string; player: PlayerData } | null {
    return this.connectedPlayerData;
  }

  getUserId(): string {
    const value = (localStorage.getItem(LS_USER_ID) ?? "").trim();
    if (value) return value.slice(0, 64);
    localStorage.setItem(LS_USER_ID, "local_user");
    return "local_user";
  }

  setUserId(userId: string): void {
    const value = userId.trim().slice(0, 64) || "local_user";
    localStorage.setItem(LS_USER_ID, value);
  }

  setAuthSession(userId: string, token: string): void {
    this.setUserId(userId);
    localStorage.setItem(LS_AUTH_TOKEN, token);
  }

  getAuthToken(): string {
    return localStorage.getItem(LS_AUTH_TOKEN) ?? "";
  }

  clearAuthSession(): void {
    localStorage.removeItem(LS_AUTH_TOKEN);
    this.switchUser("local_user");
  }

  switchUser(userId: string): void {
    this.setUserId(userId);
    this.clearSelectedUserCharacter();
  }

  clearSelectedUserCharacter(): void {
    this.disconnect({ notifyServer: true });
    localStorage.removeItem(LS_USER_CHARACTER_ID);
    localStorage.removeItem(LS_PLAYER_ID);
    localStorage.removeItem(LS_PLAYER_NAME);
    this.playerId = null;
    this.connectedPlayerData = null;
    this.rejected = false;
  }

  /** UI 设置身份（昵称 + 邀请码），写入 localStorage，下次连接生效 */
  setIdentity(name: string, code: string): void {
    localStorage.setItem(LS_PLAYER_NAME, name.trim().slice(0, 24));
    localStorage.setItem(LS_INVITE_CODE, code.trim());
    this.rejected = false;
  }

  setSelectedUserCharacter(characterId: string, name: string): void {
    localStorage.setItem(LS_USER_CHARACTER_ID, characterId);
    localStorage.setItem(LS_PLAYER_ID, characterId);
    localStorage.setItem(LS_PLAYER_NAME, name.trim().slice(0, 24));
    this.playerId = characterId;
    this.connectedPlayerData = null;
    this.rejected = false;
  }

  getSelectedUserCharacterId(): string {
    return localStorage.getItem(LS_USER_CHARACTER_ID) ?? localStorage.getItem(LS_PLAYER_ID) ?? "";
  }

  /** UI 重新连接（如修改身份后重试） */
  reconnect(): void {
    this.rejected = false;
    this.disconnect({ notifyServer: true });
    this.connectedPlayerData = null;
    this.connect();
  }

  disconnect(options: { notifyServer?: boolean } = {}): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ws) return;
    if (options.notifyServer && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "player_disconnect", data: {} }));
      } catch {
        // Ignore disconnect races.
      }
    }
    this.ws.onclose = null;
    this.ws.close();
    this.ws = null;
  }

  getStoredName(): string {
    return localStorage.getItem(LS_PLAYER_NAME) ?? "";
  }

  getStoredCode(): string {
    return localStorage.getItem(LS_INVITE_CODE) ?? "";
  }

  send(type: string, data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  sendPosition(x: number, y: number, location: string, mainAreaPointId: string | null): void {
    this.send("player_move", { x, y, location, mainAreaPointId });
  }

  sendMode(mode: "avatar" | "god"): void {
    this.send("player_mode", { mode });
  }

  sendChat(message: string): void {
    this.send("player_chat", { message });
  }

  /** 公屏 @NPC：请求某个 AI 角色公开回复 */
  sendNpcChat(characterId: string, message: string): void {
    this.send("npc_chat", { characterId, message });
  }

}

export const networkManager = new NetworkManager();
