export type WorldXMode = "classic" | "multiplayer";

const rawMode = (import.meta.env.VITE_WORLDX_MODE ?? "").trim().toLowerCase();

export const WORLDX_MODE: WorldXMode =
  rawMode === "multiplayer" ? "multiplayer" : "classic";

export const isMultiplayerMode = WORLDX_MODE === "multiplayer";

