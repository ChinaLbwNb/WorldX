import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

function resolveDataRoot(): string {
  const configured = process.env.WORLDX_DATA_DIR?.trim();
  if (!configured) return path.join(PROJECT_ROOT, "output");
  return path.resolve(PROJECT_ROOT, configured);
}

export const WORLDX_DATA_DIR = resolveDataRoot();

export function getDataDir(...segments: string[]): string {
  return path.join(WORLDX_DATA_DIR, ...segments);
}

export function ensureDataDir(...segments: string[]): string {
  const dir = getDataDir(...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

