import path from "node:path";
import type { AppContext } from "../services/app-context.js";
import type { CharacterProfile, CharacterState } from "../types/index.js";
import { loadCharacterProfilesFromWorldDir } from "./config-loader.js";

export interface ScopedCharacterRuntime {
  profile: CharacterProfile;
  state: CharacterState;
  isActiveRuntimeWorld: boolean;
}

export function fallbackStateForProfile(profile: CharacterProfile): CharacterState {
  return {
    characterId: profile.id,
    location: profile.startPosition || "main_area",
    mainAreaPointId: null,
    currentAction: null,
    currentActionTarget: null,
    actionStartTick: 0,
    actionEndTick: 0,
    emotionValence: 0,
    emotionArousal: 0,
    curiosity: 5,
    dailyPlan: null,
  };
}

export function isActiveRuntimeWorld(ctx: AppContext, worldDir?: string): boolean {
  if (!worldDir) return true;
  const activeWorldDir = ctx.getWorldDir();
  if (!activeWorldDir) return false;
  return path.resolve(activeWorldDir) === path.resolve(worldDir);
}

export function resolveScopedCharacterRuntime(
  ctx: AppContext,
  characterId: string,
  worldDir?: string,
): ScopedCharacterRuntime {
  const activeRuntimeWorld = isActiveRuntimeWorld(ctx, worldDir);
  let profile: CharacterProfile;

  if (worldDir) {
    const scopedProfile = loadCharacterProfilesFromWorldDir(worldDir).find((item) => item.id === characterId);
    if (!scopedProfile) {
      throw new Error("Character not found in scoped world");
    }
    profile = scopedProfile;
  } else {
    profile = ctx.characterManager.getProfile(characterId);
  }

  let state: CharacterState;
  if (activeRuntimeWorld) {
    try {
      state = ctx.characterManager.getState(profile.id);
    } catch {
      state = fallbackStateForProfile(profile);
    }
  } else {
    state = fallbackStateForProfile(profile);
  }

  return {
    profile,
    state,
    isActiveRuntimeWorld: activeRuntimeWorld,
  };
}
