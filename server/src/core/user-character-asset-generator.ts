import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlayerAppearance } from "../types/index.js";
import { getAccountAssetDir } from "../utils/account-assets.js";
import { getDataDir } from "../utils/data-dir.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "../..");
const GENERATOR_SCRIPT = path.resolve(SERVER_ROOT, "../generators/character/src/index.mjs");
const GENERATOR_OUTPUT_DIR = getDataDir("characters");

export type UserCharacterAssetResult = {
  appearance: PlayerAppearance;
  assetDir: string;
  sourceCharId: string;
};

export async function generateUserCharacterAssets(params: {
  userCharacterId: string;
  name: string;
  prompt: string;
  worldVisualContext: string;
}): Promise<UserCharacterAssetResult> {
  const { userCharacterId, name, prompt, worldVisualContext } = params;
  const sourceCharId = await runCharacterGenerator({
    name,
    prompt,
    worldVisualContext,
  });

  const sourceDir = path.join(GENERATOR_OUTPUT_DIR, sourceCharId);
  const targetDir = getAccountAssetDir("user-characters", userCharacterId);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of ["spritesheet.png", "metadata.json", "spritesheet-raw.png", "reference.png"]) {
    const src = path.join(sourceDir, file);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(targetDir, file));
  }

  const finalMetaPath = path.join(targetDir, "user-character-asset.json");
  fs.writeFileSync(
    finalMetaPath,
    JSON.stringify(
      {
        userCharacterId,
        sourceCharId,
        name,
        prompt,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    assetDir: targetDir,
    sourceCharId,
    appearance: {
      color: 0xffd700,
      sizeScale: 1,
      spriteKey: `user_character_${userCharacterId}`,
      spriteUrl: `/assets/account/user-characters/${encodeURIComponent(userCharacterId)}/spritesheet.png`,
      assetStatus: "ready",
      prompt,
      sourceCharId,
    },
  };
}

function runCharacterGenerator(params: {
  name: string;
  prompt: string;
  worldVisualContext: string;
}): Promise<string> {
  const args = [
    GENERATOR_SCRIPT,
    params.prompt,
    "--name",
    params.name,
    "--role",
    "用户角色",
    "--world-visual-context",
    params.worldVisualContext,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CHAR_OUTPUT_DIR: GENERATOR_OUTPUT_DIR },
    });
    let stdout = "";
    let stderr = "";
    let charId = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      process.stdout.write(text);
      const idMatch = text.match(/ID:\s+(\S+)/);
      if (idMatch) charId = idMatch[1];
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Character generator exited with code ${code}`));
        return;
      }
      if (!charId) {
        const idMatch = stdout.match(/ID:\s+(\S+)/);
        charId = idMatch?.[1] ?? "";
      }
      if (!charId) {
        reject(new Error("Failed to parse generated character asset id"));
        return;
      }
      resolve(charId);
    });
  });
}
