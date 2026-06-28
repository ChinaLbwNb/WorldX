import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AppContext } from "../services/app-context.js";
import { generateNpcReply } from "../simulation/npc-chat.js";
import * as authStore from "../store/auth-store.js";
import { onlinePlayers as onlinePlayersRegistry } from "../services/online-players.js";

interface ClientInfo {
  ws: WebSocket;
  userId: string;
  playerId: string;
  worldId: string;
  timelineId: string;
  mapId: string;
}

/** 房间邀请码：未配置则不校验（任何人可进）。 */
function getInviteCode(): string {
  return (process.env.ROOM_INVITE_CODE ?? "").trim();
}

/** 校验昵称：去空白、限长，空则回退默认。 */
function sanitizeName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim().slice(0, 24);
  return name || undefined;
}

export function setupWebSocket(server: HttpServer, ctx: AppContext): WebSocketServer {
  const wss = new WebSocketServer({ server });
  const clients = new Map<WebSocket, ClientInfo>();
  const takeoverTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function broadcast(data: unknown, excludeWs?: WebSocket): void {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client === excludeWs) continue;
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  function broadcastToPresence(
    presence: { worldId: string; timelineId: string; currentMapId?: string; mapId?: string },
    data: unknown,
    excludeWs?: WebSocket,
  ): void {
    const msg = JSON.stringify(data);
    for (const client of clients.values()) {
      if (client.ws === excludeWs) continue;
      if (!samePresence(client, presence)) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  function sendTo(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function getPlayerPresence(playerId: string): { worldId: string; timelineId: string; currentMapId: string } {
    return ctx.playerManager.getPlayerPresence(playerId);
  }

  function withPresence(player: any): any {
    const presence = getPlayerPresence(player.id);
    return {
      ...player,
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      currentMapId: presence.currentMapId,
      presence,
    };
  }

  function presenceScope(presence: { worldId: string; timelineId: string; currentMapId: string }) {
    return {
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    };
  }

  function samePresence(a: { worldId: string; timelineId: string; currentMapId?: string; mapId?: string }, b: { worldId: string; timelineId: string; currentMapId?: string; mapId?: string }): boolean {
    return a.worldId === b.worldId
      && a.timelineId === b.timelineId
      && (a.currentMapId ?? a.mapId) === (b.currentMapId ?? b.mapId);
  }

  // ===== 模拟事件广播 =====
  ctx.eventBus.on("tick_events", ({ gameTime, events }) => {
    broadcast({ type: "simulation_events", data: { gameTime, events } });
    const highlights = events.filter(
      (e: any) => e.dramScore !== undefined && e.dramScore >= 6,
    );
    for (const h of highlights) {
      broadcast({ type: "highlight_detected", data: h });
    }
  });

  ctx.eventBus.on("simulation_status", (payload) => {
    broadcast({ type: "simulation_status", data: payload });
  });

  ctx.eventBus.on("user_character_presence_changed", (payload: any) => {
    const playerId = typeof payload?.playerId === "string" ? payload.playerId : "";
    const oldPresence = payload?.oldPresence;
    const newPresence = payload?.newPresence;
    const player = payload?.player;
    const wasOnline = payload?.wasOnline === true;
    if (!playerId || !oldPresence || !newPresence || !wasOnline) return;

    if (!samePresence(oldPresence, newPresence)) {
      ctx.mapRuntimeRegistry.markUserOffline(presenceScope(oldPresence), playerId);
      broadcastToPresence(oldPresence, { type: "player_left", data: { playerId } });
    }

    for (const client of clients.values()) {
      if (client.playerId !== playerId) continue;
      client.worldId = newPresence.worldId;
      client.timelineId = newPresence.timelineId;
      client.mapId = newPresence.currentMapId;
    }
    onlinePlayersRegistry.updatePresence(playerId, {
      worldId: newPresence.worldId,
      timelineId: newPresence.timelineId,
      mapId: newPresence.currentMapId,
    });

    ctx.mapRuntimeRegistry.markUserOnline(presenceScope(newPresence), playerId);
    if (!samePresence(oldPresence, newPresence) && player) {
      broadcastToPresence(newPresence, { type: "player_joined", data: withPresence(player) });
    }
  });

  // ===== 玩家连接处理 =====
  wss.on("connection", (ws, req) => {
    // 解析握手参数：?name=昵称&code=邀请码&uid=用户ID&pid=已有用户角色ID
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const requestedName = sanitizeName(query.get("name"));
    const providedCode = (query.get("code") ?? "").trim();
    const tokenUser = authStore.getUserByToken((query.get("token") ?? "").trim());
    if (!tokenUser) {
      sendTo(ws, { type: "join_rejected", data: { reason: "auth_required" } });
      ws.close(4003, "authentication required");
      return;
    }
    const requestedUserId = tokenUser.id;
    const requestedPid = (query.get("pid") ?? "").trim();

    // 邀请码校验：配置了才校验，不匹配直接关闭连接
    const inviteCode = getInviteCode();
    if (inviteCode && providedCode !== inviteCode) {
      sendTo(ws, { type: "join_rejected", data: { reason: "invalid_code" } });
      ws.close(4001, "invalid invite code");
      return;
    }

    // 身份复用：携带了有效 pid 且该玩家存在 → 复用同一化身（断线重连/刷新）
    let player = requestedPid ? ctx.playerManager.getPlayer(requestedPid, requestedUserId) : null;
    if (player) {
      // 重连时若带了新昵称则更新
      if (requestedName && requestedName !== player.name) {
        ctx.playerManager.updatePlayer(player.id, { name: requestedName });
        player = ctx.playerManager.getPlayer(player.id, requestedUserId) ?? player;
      }
    } else {
      // 否则新建玩家
      player = ctx.playerManager.createPlayer(requestedName, requestedUserId);
    }
    const playerId = player.id;
    let closedByClient = false;

    const markDisconnected = () => {
      const clientInfo = clients.get(ws);
      clients.delete(ws);
      const lastPresence = clientInfo
        ? { worldId: clientInfo.worldId, timelineId: clientInfo.timelineId, currentMapId: clientInfo.mapId }
        : getPlayerPresence(playerId);
      ctx.mapRuntimeRegistry.markUserOffline(presenceScope(lastPresence), playerId);

      const hasOtherConnection = Array.from(clients.values()).some(
        (c) => c.playerId === playerId,
      );
      if (hasOtherConnection) return;

      const timer = takeoverTimers.get(playerId);
      if (timer) {
        clearTimeout(timer);
        takeoverTimers.delete(playerId);
      }
      ctx.playerManager.setOnline(playerId, false);
      ctx.playerManager.deactivateLLMTakeover(playerId);
      onlinePlayersRegistry.remove(playerId);
      broadcastToPresence(lastPresence, { type: "player_left", data: { playerId } });
    };

    // 清除该玩家的接管计时器
    const timer = takeoverTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      takeoverTimers.delete(playerId);
    }

    ctx.playerManager.setOnline(playerId, true);
    ctx.playerManager.setMode(playerId, "avatar");
    ctx.playerManager.deactivateLLMTakeover(playerId);
    player = ctx.playerManager.getPlayer(playerId, requestedUserId) ?? player;
    const presence = getPlayerPresence(playerId);
    clients.set(ws, {
      ws,
      userId: requestedUserId,
      playerId,
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    });
    onlinePlayersRegistry.upsert({
      userId: requestedUserId,
      playerId,
      playerName: player.name,
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      close: (reason: string) => {
        sendTo(ws, { type: "kicked", data: { reason } });
        closedByClient = true;
        markDisconnected();
        try {
          ws.close(4004, reason);
        } catch {
          // Ignore close races.
        }
      },
    });
    ctx.mapRuntimeRegistry.markUserOnline(presenceScope(presence), playerId);

    // 发送连接确认（含用户角色 ID 和 presence）
    const gameTime = ctx.worldManager.getCurrentTime();
    sendTo(ws, {
      type: "connected",
      data: { gameTime, userId: requestedUserId, playerId, player: withPresence(player), presence },
    });

    broadcastToPresence(
      presence,
      { type: "player_joined", data: withPresence(player) },
      ws,
    );

    // 发送当前同 world/timeline/map 的在线用户角色列表给新客户端。
    const onlinePlayers = ctx.playerManager.getOnlineAvatarPlayers().filter(
      (p) => p.id !== playerId && samePresence(getPlayerPresence(p.id), presence),
    ).map((p) => withPresence(p));
    sendTo(ws, {
      type: "players_online",
      data: onlinePlayers,
    });

    // ===== 处理客户端消息 =====
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "player_disconnect": {
          closedByClient = true;
          markDisconnected();
          try {
            ws.close(1000, "client disconnect");
          } catch {
            // Ignore close races.
          }
          break;
        }

        case "player_move": {
          const { x, y, location, mainAreaPointId } = msg.data ?? {};
          if (typeof x === "number" && typeof y === "number") {
            ctx.playerManager.updatePosition(
              playerId,
              x,
              y,
              typeof location === "string" ? location : "main_area",
              typeof mainAreaPointId === "string" ? mainAreaPointId : null,
            );
            // 广播位置给其他客户端
            const movedPresence = getPlayerPresence(playerId);
            broadcastToPresence(
              movedPresence,
              {
                type: "player_moved",
                data: {
                  playerId,
                  x,
                  y,
                  location,
                  mainAreaPointId,
                  worldId: movedPresence.worldId,
                  timelineId: movedPresence.timelineId,
                  currentMapId: movedPresence.currentMapId,
                  presence: movedPresence,
                },
              },
              ws,
            );
          }
          break;
        }

        case "player_mode": {
          const { mode } = msg.data ?? {};
          if (mode === "avatar" || mode === "god") {
            ctx.playerManager.setMode(playerId, mode);
            const updatedPlayer = ctx.playerManager.getPlayer(playerId);
            const modePresence = getPlayerPresence(playerId);
            broadcastToPresence(
              modePresence,
              { type: "player_mode_changed", data: { playerId, mode } },
              ws,
            );
            sendTo(ws, { type: "player_mode_changed", data: { playerId, mode } });
            if (mode === "avatar" && updatedPlayer) {
              broadcastToPresence(modePresence, { type: "player_joined", data: withPresence(updatedPlayer) }, ws);
            } else {
              broadcastToPresence(modePresence, { type: "player_left", data: { playerId } }, ws);
            }
          }
          break;
        }

        case "player_chat": {
          const { message } = msg.data ?? {};
          if (typeof message === "string" && message.trim()) {
            const player = ctx.playerManager.getPlayer(playerId);
            const chatPresence = getPlayerPresence(playerId);
            broadcastToPresence(
              chatPresence,
              {
                type: "player_chat",
                data: {
                  playerId,
                  playerName: player?.name ?? "旅行者",
                  message: message.trim(),
                },
              },
              ws, // 广播给其他人；发送方自己在本地回显
            );
          }
          break;
        }

        case "npc_chat": {
          // 公屏 @NPC：把提问广播给其他玩家，再异步生成 NPC 回复广播给所有人
          const { characterId, message } = msg.data ?? {};
          if (
            typeof characterId !== "string" ||
            typeof message !== "string" ||
            !message.trim()
          ) {
            break;
          }
          const asker = ctx.playerManager.getPlayer(playerId);
          const askerName = asker?.name ?? "旅行者";
          const question = message.trim();
          const chatPresence = getPlayerPresence(playerId);

          // 1) 提问本身作为公屏消息广播给其他人（发送方本地已回显）
          broadcastToPresence(
            chatPresence,
            {
              type: "player_chat",
              data: { playerId, playerName: askerName, message: question },
            },
            ws,
          );

          // 2) 先广播「NPC 正在输入」提示（含发送方）
          let charName = characterId;
          try {
            charName = ctx.characterManager.getProfile(characterId).name;
          } catch {
            // 角色不存在，下面统一处理
          }
          broadcastToPresence(chatPresence, {
            type: "npc_typing",
            data: { characterId, characterName: charName },
          });

          // 3) 异步生成回复并广播给所有人
          generateNpcReply(ctx, characterId, askerName, question, Date.now())
            .then((res) => {
              broadcastToPresence(chatPresence, {
                type: "npc_chat",
                data: {
                  characterId: res.character.id,
                  characterName: res.character.name,
                  message: res.reply,
                  askerName,
                },
              });
            })
            .catch((err) => {
              const reason = err instanceof Error ? err.message : String(err);
              broadcastToPresence(chatPresence, {
                type: "npc_chat_error",
                data: { characterId, characterName: charName, reason },
              });
            });
          break;
        }
      }
    });

    // ===== 断开连接 =====
    ws.on("close", () => {
      if (closedByClient) return;
      markDisconnected();
    });
  });

  return wss;
}
