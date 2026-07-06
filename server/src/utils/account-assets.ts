import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./data-dir.js";

const ACCOUNT_ASSETS_ROOT = getDataDir("account-assets");

export function getAccountAssetsRoot(): string {
  fs.mkdirSync(ACCOUNT_ASSETS_ROOT, { recursive: true });
  return ACCOUNT_ASSETS_ROOT;
}

export function getAccountAssetDir(kind: "items" | "user-characters", id?: string): string {
  const dir = id ? path.join(getAccountAssetsRoot(), kind, id) : path.join(getAccountAssetsRoot(), kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeAccountAssetPath(assetPath: string | null | undefined): string | null {
  if (!assetPath) return null;
  const normalized = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("../")) return null;
  if (!normalized.startsWith("items/") && !normalized.startsWith("user-characters/")) return null;
  const root = getAccountAssetsRoot();
  const fullPath = path.resolve(root, normalized);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(fullPath)) return null;
  fs.rmSync(fullPath, { recursive: true, force: true });
  return normalized;
}
