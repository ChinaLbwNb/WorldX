export type WorldXMode = "classic" | "multiplayer";

const rawMode = (process.env.WORLDX_MODE ?? "").trim().toLowerCase();

export const WORLDX_MODE: WorldXMode =
  rawMode === "multiplayer" ? "multiplayer" : "classic";

export const isMultiplayerMode = WORLDX_MODE === "multiplayer";
export const isClassicMode = WORLDX_MODE === "classic";

