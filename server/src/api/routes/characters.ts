import { Router } from "express";
import type { Request, Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getEmotionLabel } from "../../core/emotion-manager.js";
import { CharacterManager } from "../../core/character-manager.js";
import { resolveActionLabel } from "../../utils/action-labels.js";
import { getRequestUserId } from "../request-user.js";
import { canUserAccessWorld, findWorldById } from "../../utils/world-directories.js";
import { loadCharacterProfilesFromWorldDir } from "../../utils/config-loader.js";
import { fallbackStateForProfile } from "../../utils/scoped-character-runtime.js";
import type { CharacterProfile, CharacterState } from "../../types/index.js";

const router = Router();

function getScopedWorld(req: Request, res: Response) {
  const userCharacterId = typeof req.query?.userCharacterId === "string" ? req.query.userCharacterId : "";
  if (!userCharacterId) return null;
  const userId = getRequestUserId(req);
  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return null;
  }
  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  const world = findWorldById(presence.worldId);
  if (!world) {
    res.status(404).json({ error: "World not found for character presence" });
    return null;
  }
  if (!canUserAccessWorld(world, userId)) {
    res.status(403).json({ error: "You do not have access to this world" });
    return null;
  }
  return { world, presence };
}

function buildCharacterListItem(profile: CharacterProfile, state: CharacterState) {
  const currentActionLabel = resolveActionLabel({
    actionId: state.currentAction,
    targetId: state.currentActionTarget,
    locationId: state.location,
    getWorldAction: (actionId) => appContext.worldManager.getWorldAction(actionId),
    getLocationObjects: (locationId) => appContext.worldManager.getLocationObjects(locationId),
  });
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    nickname: profile.nickname,
    location: state.location,
    mainAreaPointId: state.mainAreaPointId,
    emotion: getEmotionLabel(state.emotionValence, state.emotionArousal),
    currentAction: state.currentAction,
    currentActionLabel,
    anchor: profile.anchor || null,
  };
}

// GET /characters
router.get("/", (req, res) => {
  const scoped = getScopedWorld(req, res);
  if (res.headersSent) return;
  if (scoped) {
    try {
      const profiles = loadCharacterProfilesFromWorldDir(scoped.world.dir);
      const result = profiles.map((profile) => {
        let state: CharacterState;
        try {
          state = appContext.characterManager.getState(profile.id);
        } catch {
          state = fallbackStateForProfile(profile);
        }
        return buildCharacterListItem(profile, state);
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const profiles = appContext.characterManager.getAllProfiles();
  const result = profiles.map((p) => buildCharacterListItem(p, appContext.characterManager.getState(p.id)));
  res.json(result);
});

// GET /characters/:id
router.get("/:id", (req, res) => {
  const scoped = getScopedWorld(req, res);
  if (res.headersSent) return;
  if (scoped) {
    try {
      const profile = loadCharacterProfilesFromWorldDir(scoped.world.dir).find((item) => item.id === req.params.id);
      if (!profile) {
        res.status(404).json({ error: "Character not found" });
        return;
      }
      let state: CharacterState;
      try {
        state = appContext.characterManager.getState(profile.id);
      } catch {
        state = fallbackStateForProfile(profile);
      }
      const currentActionLabel = resolveActionLabel({
        actionId: state.currentAction,
        targetId: state.currentActionTarget,
        locationId: state.location,
        getWorldAction: (actionId) => appContext.worldManager.getWorldAction(actionId),
        getLocationObjects: (locationId) => appContext.worldManager.getLocationObjects(locationId),
      });
      res.json({
        profile,
        state: {
          ...state,
          currentActionLabel,
        },
        emotionLabel: getEmotionLabel(state.emotionValence, state.emotionArousal),
      });
      return;
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  try {
    const profile = appContext.characterManager.getProfile(req.params.id);
    const state = appContext.characterManager.getState(req.params.id);
    const currentActionLabel = resolveActionLabel({
      actionId: state.currentAction,
      targetId: state.currentActionTarget,
      locationId: state.location,
      getWorldAction: (actionId) => appContext.worldManager.getWorldAction(actionId),
      getLocationObjects: (locationId) => appContext.worldManager.getLocationObjects(locationId),
    });
    res.json({
      profile,
      state: {
        ...state,
        currentActionLabel,
      },
      emotionLabel: getEmotionLabel(state.emotionValence, state.emotionArousal),
    });
  } catch {
    res.status(404).json({ error: "Character not found" });
  }
});

// GET /characters/:id/diary
router.get("/:id/diary", (req, res) => {
  const gameDay = req.query.day ? Number(req.query.day) : undefined;
  const entries = appContext.characterManager.getDiaryEntries(
    req.params.id,
    gameDay,
  );
  res.json(entries);
});

// PATCH /characters/:id/profile
router.patch("/:id/profile", (req: Request, res: Response) => {
  const charId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    appContext.characterManager.getProfile(charId);
  } catch {
    return res.status(404).json({ error: "Character not found" });
  }
  const patch = req.body ?? {};
  const allowed = CharacterManager.EDITABLE_FIELDS as readonly string[];
  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return res.status(400).json({ error: `Non-editable fields: ${unknown.join(", ")}` });
  }
  const updated = appContext.characterManager.patchProfile(charId, patch);
  res.json({ ok: true, profile: updated });
});

// PATCH /characters/:id/runtime-state
router.patch("/:id/runtime-state", (req: Request, res: Response) => {
  const charId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    appContext.characterManager.getProfile(charId);
  } catch {
    return res.status(404).json({ error: "Character not found" });
  }

  const { mainAreaPointId } = req.body ?? {};
  if (mainAreaPointId !== undefined && mainAreaPointId !== null && typeof mainAreaPointId !== "string") {
    return res.status(400).json({ error: "mainAreaPointId must be a string or null" });
  }

  appContext.characterManager.updateState(charId, {
    mainAreaPointId: mainAreaPointId ?? null,
  });
  const state = appContext.characterManager.getState(charId);
  res.json({ ok: true, state });
});

// GET /characters/:id/memories — public memories (limited, excludes internal tags)
router.get("/:id/memories", (req, res) => {
  const memories = appContext.characterManager.memoryManager.getRecentMemories(
    req.params.id,
    20,
  );
  const result = memories.map((m) => ({
    content: m.content,
    gameDay: m.gameDay,
    type: m.type,
  }));
  res.json(result);
});

export default router;
