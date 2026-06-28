export type ActorType = "user_character" | "npc";

export interface ActorRef {
  actorType: ActorType;
  actorId: string;
}

export interface PresenceScope {
  worldId: string;
  timelineId: string;
  mapId: string;
}

export type ActorInteractionKind =
  | "chat"
  | "trade"
  | "gift"
  | "inspect"
  | "assist"
  | "conflict";

export interface ActorInteraction {
  id: string;
  scope: PresenceScope;
  kind: ActorInteractionKind;
  initiator: ActorRef;
  target: ActorRef;
  status: "requested" | "active" | "completed" | "cancelled" | "failed";
  payload: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ActorRelationship {
  id: string;
  scope: Pick<PresenceScope, "worldId" | "timelineId">;
  source: ActorRef;
  target: ActorRef;
  affinity: number;
  trust: number;
  tension: number;
  state: Record<string, unknown>;
  updatedAt?: string;
}
