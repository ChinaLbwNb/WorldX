import type { PresenceScope } from "../types/index.js";
import type { ResourceNodeConfig } from "../types/build.js";

export interface MapRuntimeSnapshot {
  scope: PresenceScope;
  onlineUserCharacterIds: string[];
  resourceNodeCount: number;
  resourceNodesReady: boolean;
  lastActiveAt: string;
}

type RuntimeRecord = {
  scope: PresenceScope;
  onlineUserCharacterIds: Set<string>;
  resourceNodes: ResourceNodeConfig[];
  lastActiveAt: number;
};

function scopeKey(scope: PresenceScope): string {
  return `${scope.worldId}::${scope.timelineId}::${scope.mapId}`;
}

function now(): number {
  return Date.now();
}

export class MapRuntimeRegistry {
  private runtimes = new Map<string, RuntimeRecord>();

  ensureRuntime(scope: PresenceScope): MapRuntimeSnapshot {
    const record = this.getOrCreate(scope);
    return this.toSnapshot(record);
  }

  markUserOnline(scope: PresenceScope, userCharacterId: string): MapRuntimeSnapshot {
    const record = this.getOrCreate(scope);
    record.onlineUserCharacterIds.add(userCharacterId);
    record.lastActiveAt = now();
    return this.toSnapshot(record);
  }

  markUserOffline(scope: PresenceScope, userCharacterId: string): MapRuntimeSnapshot {
    const record = this.getOrCreate(scope);
    record.onlineUserCharacterIds.delete(userCharacterId);
    record.lastActiveAt = now();
    return this.toSnapshot(record);
  }

  updateResourceNodes(scope: PresenceScope, resourceNodes: ResourceNodeConfig[]): MapRuntimeSnapshot {
    const record = this.getOrCreate(scope);
    record.resourceNodes = [...resourceNodes];
    record.lastActiveAt = now();
    return this.toSnapshot(record);
  }

  getRuntime(scope: PresenceScope): MapRuntimeSnapshot | null {
    const record = this.runtimes.get(scopeKey(scope));
    return record ? this.toSnapshot(record) : null;
  }

  getRuntimeWithResources(scope: PresenceScope): (MapRuntimeSnapshot & { resourceNodes: ResourceNodeConfig[] }) | null {
    const record = this.runtimes.get(scopeKey(scope));
    return record
      ? { ...this.toSnapshot(record), resourceNodes: [...record.resourceNodes] }
      : null;
  }

  getResourceNode(scope: PresenceScope, objectId: string): ResourceNodeConfig | null {
    const record = this.runtimes.get(scopeKey(scope));
    return record?.resourceNodes.find((node) => node.id === objectId) ?? null;
  }

  hasResourceNode(scope: PresenceScope, objectId: string): boolean {
    return Boolean(this.getResourceNode(scope, objectId));
  }

  getAllRuntimes(): MapRuntimeSnapshot[] {
    return Array.from(this.runtimes.values())
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map((record) => this.toSnapshot(record));
  }

  getRuntimesForWorld(worldId: string, timelineId?: string): MapRuntimeSnapshot[] {
    return this.getAllRuntimes().filter((runtime) =>
      runtime.scope.worldId === worldId &&
      (!timelineId || runtime.scope.timelineId === timelineId),
    );
  }

  reset(): void {
    this.runtimes.clear();
  }

  private getOrCreate(scope: PresenceScope): RuntimeRecord {
    const key = scopeKey(scope);
    let record = this.runtimes.get(key);
    if (!record) {
      record = {
        scope: { ...scope },
        onlineUserCharacterIds: new Set(),
        resourceNodes: [],
        lastActiveAt: now(),
      };
      this.runtimes.set(key, record);
    }
    return record;
  }

  private toSnapshot(record: RuntimeRecord): MapRuntimeSnapshot {
    return {
      scope: { ...record.scope },
      onlineUserCharacterIds: Array.from(record.onlineUserCharacterIds).sort(),
      resourceNodeCount: record.resourceNodes.length,
      resourceNodesReady: record.resourceNodes.length > 0,
      lastActiveAt: new Date(record.lastActiveAt).toISOString(),
    };
  }
}
