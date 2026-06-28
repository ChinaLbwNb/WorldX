import { EventEmitter } from "node:events";

export type OnlinePlayerSnapshot = {
  userId: string;
  playerId: string;
  playerName: string;
  worldId: string;
  timelineId: string;
  mapId: string;
  connectedAt: number;
  lastSeenAt: number;
};

type OnlineClient = OnlinePlayerSnapshot & {
  close: (reason: string) => void;
};

class OnlinePlayersRegistry extends EventEmitter {
  private clients = new Map<string, OnlineClient>();

  upsert(input: OnlinePlayerSnapshot & { close: (reason: string) => void }): void {
    this.clients.set(input.playerId, { ...input, lastSeenAt: Date.now() });
    this.emit("changed");
  }

  updatePresence(playerId: string, presence: { worldId: string; timelineId: string; mapId: string }): void {
    const client = this.clients.get(playerId);
    if (!client) return;
    this.clients.set(playerId, {
      ...client,
      ...presence,
      lastSeenAt: Date.now(),
    });
    this.emit("changed");
  }

  remove(playerId: string): void {
    if (!this.clients.delete(playerId)) return;
    this.emit("changed");
  }

  list(scope?: { worldId?: string; timelineId?: string; mapId?: string }): OnlinePlayerSnapshot[] {
    return Array.from(this.clients.values())
      .filter((client) => {
        if (scope?.worldId && client.worldId !== scope.worldId) return false;
        if (scope?.timelineId && client.timelineId !== scope.timelineId) return false;
        if (scope?.mapId && client.mapId !== scope.mapId) return false;
        return true;
      })
      .map(({ close: _close, ...client }) => client)
      .sort((a, b) => a.connectedAt - b.connectedAt);
  }

  kick(playerId: string, reason = "kicked"): boolean {
    const client = this.clients.get(playerId);
    if (!client) return false;
    client.close(reason);
    this.remove(playerId);
    return true;
  }
}

export const onlinePlayers = new OnlinePlayersRegistry();
