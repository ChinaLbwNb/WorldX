import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import * as actorInteractionStore from "../../store/actor-interaction-store.js";
import type {
  ActorInteractionKind,
  ActorInteraction,
  ActorRef,
  PresenceScope,
} from "../../types/index.js";

const router = Router();

const VALID_KINDS = new Set<ActorInteractionKind>([
  "chat",
  "trade",
  "gift",
  "inspect",
  "assist",
  "conflict",
]);

const VALID_STATUSES = new Set<ActorInteraction["status"]>([
  "requested",
  "active",
  "completed",
  "cancelled",
  "failed",
]);

router.get("/", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.query.userCharacterId === "string" ? req.query.userCharacterId : "";
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  const actor = parseActorQuery(req.query.actorType, req.query.actorId);
  const status = typeof req.query.status === "string" && VALID_STATUSES.has(req.query.status as ActorInteraction["status"])
    ? req.query.status as ActorInteraction["status"]
    : undefined;
  const limit = Number(req.query.limit);

  const scopeResult = resolveUserCharacterScope(userId, userCharacterId);
  if (!scopeResult.ok) {
    res.status(scopeResult.status).json({ error: scopeResult.error });
    return;
  }

  const interactions = actorInteractionStore.listActorInteractions({
    scope: scopeResult.scope,
    actor: actor ?? { actorType: "user_character", actorId: userCharacterId },
    status,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  res.json({ scope: scopeResult.scope, interactions });
});

router.post("/", (req, res) => {
  const userId = getRequestUserId(req);
  const initiatorUserCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
  const target = parseActorBody(req.body?.target);
  const payload = normalizePayload(req.body?.payload);

  if (!initiatorUserCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!VALID_KINDS.has(kind as ActorInteractionKind)) {
    res.status(400).json({ error: "Invalid interaction kind" });
    return;
  }
  if (!target) {
    res.status(400).json({ error: "target actor is required" });
    return;
  }

  const scopeResult = resolveUserCharacterScope(userId, initiatorUserCharacterId);
  if (!scopeResult.ok) {
    res.status(scopeResult.status).json({ error: scopeResult.error });
    return;
  }
  const targetResult = validateTargetActor(scopeResult.scope, target);
  if (!targetResult.ok) {
    res.status(targetResult.status).json({ error: targetResult.error });
    return;
  }

  const initiator: ActorRef = { actorType: "user_character", actorId: initiatorUserCharacterId };
  const interaction = actorInteractionStore.createActorInteraction({
    scope: scopeResult.scope,
    kind: kind as ActorInteractionKind,
    initiator,
    target,
    status: "requested",
    payload,
  });

  appContext.eventBus.emit("actor_interaction_started", {
    scope: scopeResult.scope,
    interaction,
    actor: { userId, userCharacterId: initiatorUserCharacterId },
  });
  res.json({ ok: true, scope: scopeResult.scope, interaction });
});

router.patch("/:id", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const status = typeof req.body?.status === "string" ? req.body.status : "";
  const payloadPatch = normalizePayload(req.body?.payload);

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!VALID_STATUSES.has(status as ActorInteraction["status"])) {
    res.status(400).json({ error: "Invalid interaction status" });
    return;
  }

  const scopeResult = resolveUserCharacterScope(userId, userCharacterId);
  if (!scopeResult.ok) {
    res.status(scopeResult.status).json({ error: scopeResult.error });
    return;
  }

  try {
    const current = actorInteractionStore.getActorInteraction(req.params.id);
    if (!current) {
      res.status(404).json({ error: "Actor interaction not found" });
      return;
    }
    if (!sameScope(current.scope, scopeResult.scope)) {
      res.status(403).json({ error: "Actor interaction is outside the current character scope" });
      return;
    }
    if (!actorMatches(current.initiator, userCharacterId) && !actorMatches(current.target, userCharacterId)) {
      res.status(403).json({ error: "Current character is not part of this interaction" });
      return;
    }
    const interaction = actorInteractionStore.updateActorInteractionStatus(
      current.id,
      status as ActorInteraction["status"],
      payloadPatch,
    );
    appContext.eventBus.emit("actor_interaction_updated", {
      scope: scopeResult.scope,
      interaction,
      actor: { userId, userCharacterId },
    });
    res.json({ ok: true, scope: scopeResult.scope, interaction });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function resolveUserCharacterScope(
  userId: string,
  userCharacterId: string,
): { ok: true; scope: PresenceScope } | { ok: false; status: number; error: string } {
  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) return { ok: false, status: 404, error: "User character not found" };
  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  return {
    ok: true,
    scope: {
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    },
  };
}

function validateTargetActor(
  scope: PresenceScope,
  target: ActorRef,
): { ok: true } | { ok: false; status: number; error: string } {
  if (target.actorType === "user_character") {
    const targetPlayer = appContext.playerManager.getPlayer(target.actorId);
    if (!targetPlayer) return { ok: false, status: 404, error: "Target user character not found" };
    const targetPresence = appContext.playerManager.getPlayerPresence(target.actorId);
    if (
      targetPresence.worldId !== scope.worldId ||
      targetPresence.timelineId !== scope.timelineId ||
      targetPresence.currentMapId !== scope.mapId
    ) {
      return { ok: false, status: 409, error: "Target user character is not in the same scope" };
    }
    return { ok: true };
  }

  if (target.actorType === "npc") {
    try {
      appContext.characterManager.getProfile(target.actorId);
      return { ok: true };
    } catch {
      return { ok: false, status: 404, error: "Target NPC not found" };
    }
  }

  return { ok: false, status: 400, error: "Unsupported target actor type" };
}

function parseActorBody(raw: unknown): ActorRef | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const actorType = value.actorType;
  const actorId = value.actorId;
  if ((actorType !== "user_character" && actorType !== "npc") || typeof actorId !== "string" || !actorId.trim()) {
    return null;
  }
  return { actorType, actorId: actorId.trim() };
}

function parseActorQuery(actorType: unknown, actorId: unknown): ActorRef | null {
  if ((actorType !== "user_character" && actorType !== "npc") || typeof actorId !== "string" || !actorId.trim()) {
    return null;
  }
  return { actorType, actorId: actorId.trim() };
}

function normalizePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function sameScope(a: PresenceScope, b: PresenceScope): boolean {
  return a.worldId === b.worldId && a.timelineId === b.timelineId && a.mapId === b.mapId;
}

function actorMatches(actor: ActorRef, userCharacterId: string): boolean {
  return actor.actorType === "user_character" && actor.actorId === userCharacterId;
}

export default router;
