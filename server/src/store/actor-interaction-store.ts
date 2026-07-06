import { getDb } from "./db.js";
import { generateId } from "../utils/id-generator.js";
import type {
  ActorInteraction,
  ActorInteractionKind,
  ActorRef,
  PresenceScope,
} from "../types/index.js";

export type ActorInteractionStatus = ActorInteraction["status"];

export interface CreateActorInteractionInput {
  scope: PresenceScope;
  kind: ActorInteractionKind;
  initiator: ActorRef;
  target: ActorRef;
  status?: ActorInteractionStatus;
  payload?: Record<string, unknown>;
}

export interface ListActorInteractionsInput {
  scope: PresenceScope;
  actor?: ActorRef;
  status?: ActorInteractionStatus;
  limit?: number;
}

export function createActorInteraction(input: CreateActorInteractionInput): ActorInteraction {
  const id = `actor_interaction_${generateId()}`;
  const status = input.status ?? "requested";
  getDb().prepare(
    `INSERT INTO actor_interactions
     (id, world_id, timeline_id, map_id, kind,
      initiator_actor_type, initiator_actor_id,
      target_actor_type, target_actor_id,
      status, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope.worldId,
    input.scope.timelineId,
    input.scope.mapId,
    input.kind,
    input.initiator.actorType,
    input.initiator.actorId,
    input.target.actorType,
    input.target.actorId,
    status,
    JSON.stringify(input.payload ?? {}),
  );
  const created = getActorInteraction(id);
  if (!created) throw new Error(`Actor interaction not found after create: ${id}`);
  return created;
}

export function getActorInteraction(id: string): ActorInteraction | null {
  const row = getDb().prepare(
    `SELECT *
     FROM actor_interactions
     WHERE id = ?`,
  ).get(id) as any;
  return row ? mapRow(row) : null;
}

export function listActorInteractions(input: ListActorInteractionsInput): ActorInteraction[] {
  const clauses = [
    "world_id = ?",
    "timeline_id = ?",
    "map_id = ?",
  ];
  const params: unknown[] = [
    input.scope.worldId,
    input.scope.timelineId,
    input.scope.mapId,
  ];
  if (input.status) {
    clauses.push("status = ?");
    params.push(input.status);
  }
  if (input.actor) {
    clauses.push(`(
      (initiator_actor_type = ? AND initiator_actor_id = ?) OR
      (target_actor_type = ? AND target_actor_id = ?)
    )`);
    params.push(
      input.actor.actorType,
      input.actor.actorId,
      input.actor.actorType,
      input.actor.actorId,
    );
  }
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
  params.push(limit);
  const rows = getDb().prepare(
    `SELECT *
     FROM actor_interactions
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...params) as any[];
  return rows.map(mapRow);
}

export function updateActorInteractionStatus(
  id: string,
  status: ActorInteractionStatus,
  payloadPatch?: Record<string, unknown>,
): ActorInteraction {
  const current = getActorInteraction(id);
  if (!current) throw new Error("Actor interaction not found");
  const payload = payloadPatch
    ? { ...current.payload, ...payloadPatch }
    : current.payload;
  getDb().prepare(
    `UPDATE actor_interactions
     SET status = ?, payload = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(status, JSON.stringify(payload), id);
  const updated = getActorInteraction(id);
  if (!updated) throw new Error("Actor interaction not found after update");
  return updated;
}

function mapRow(row: any): ActorInteraction {
  return {
    id: String(row.id),
    scope: {
      worldId: String(row.world_id),
      timelineId: String(row.timeline_id),
      mapId: String(row.map_id),
    },
    kind: row.kind,
    initiator: {
      actorType: row.initiator_actor_type,
      actorId: row.initiator_actor_id,
    },
    target: {
      actorType: row.target_actor_type,
      actorId: row.target_actor_id,
    },
    status: row.status,
    payload: parseJsonObject(row.payload),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
