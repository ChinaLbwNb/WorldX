import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

const args = parseArgs(process.argv.slice(2));
const dryRun = !args.apply;
const dataDir = resolveDataDir(args.dataDir);
const backupMaxAgeDays = args.backupDays ?? 14;

const summary = {
  mode: dryRun ? "dry-run" : "apply",
  dataDir,
  removed: [],
  kept: [],
  skipped: [],
};

main();

function main() {
  ensureSafeDataDir(dataDir);
  removeSqliteSidecars(dataDir);
  removeOldCleanupBackups(path.join(dataDir, "cleanup-backups"), backupMaxAgeDays);
  if (typeof args.keepWorlds === "number") {
    pruneGeneratedWorlds(path.join(dataDir, "worlds"), args.keepWorlds);
  }
  if (args.includeTemp) {
    removeKnownTempDirs(dataDir);
  }
  printSummary();
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    dataDir: "",
    backupDays: undefined,
    keepWorlds: undefined,
    includeTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      parsed.apply = true;
    } else if (arg === "--dry-run") {
      parsed.apply = false;
    } else if (arg === "--include-temp") {
      parsed.includeTemp = true;
    } else if (arg === "--data-dir") {
      parsed.dataDir = argv[++i] ?? "";
    } else if (arg === "--backup-days") {
      parsed.backupDays = readNonNegativeInteger(argv[++i], "--backup-days");
    } else if (arg === "--keep-worlds") {
      parsed.keepWorlds = readNonNegativeInteger(argv[++i], "--keep-worlds");
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function resolveDataDir(cliDataDir) {
  const configured = cliDataDir || process.env.WORLDX_DATA_DIR || "output";
  return path.resolve(ROOT, configured);
}

function ensureSafeDataDir(dir) {
  const resolved = path.resolve(dir);
  if (resolved === ROOT || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to clean unsafe data dir: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    summary.skipped.push({ path: relative(resolved), reason: "data dir does not exist" });
  }
}

function removeSqliteSidecars(rootDir) {
  walk(rootDir, (filePath, entry) => {
    if (!entry.isFile()) return;
    if (!filePath.endsWith(".db-wal") && !filePath.endsWith(".db-shm") && !filePath.endsWith(".sqlite-wal") && !filePath.endsWith(".sqlite-shm")) {
      return;
    }
    removePath(filePath, "sqlite-sidecar");
  });
}

function removeOldCleanupBackups(backupsDir, maxAgeDays) {
  if (!fs.existsSync(backupsDir)) {
    summary.skipped.push({ path: relative(backupsDir), reason: "cleanup-backups not found" });
    return;
  }
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(backupsDir, entry.name);
    const stat = fs.statSync(dirPath);
    if (stat.mtimeMs <= cutoffMs) {
      removePath(dirPath, `cleanup-backup older than ${maxAgeDays} days`);
    } else {
      summary.kept.push({ path: relative(dirPath), reason: "recent cleanup backup" });
    }
  }
}

function pruneGeneratedWorlds(worldsDir, keepCount) {
  if (!fs.existsSync(worldsDir)) {
    summary.skipped.push({ path: relative(worldsDir), reason: "generated worlds dir not found" });
    return;
  }
  const worlds = fs.readdirSync(worldsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(worldsDir, entry.name);
      return { dirPath, mtimeMs: fs.statSync(dirPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  worlds.forEach((world, index) => {
    if (index < keepCount) {
      summary.kept.push({ path: relative(world.dirPath), reason: `kept recent world ${index + 1}/${keepCount}` });
      return;
    }
    removePath(world.dirPath, `older generated world beyond keep-worlds=${keepCount}`);
  });
}

function removeKnownTempDirs(rootDir) {
  for (const name of ["maps", "characters", "debug-overlay-fallback"]) {
    const dirPath = path.join(rootDir, name);
    if (fs.existsSync(dirPath)) {
      removePath(dirPath, "temporary generation output");
    } else {
      summary.skipped.push({ path: relative(dirPath), reason: "temp dir not found" });
    }
  }
}

function walk(rootDir, visit) {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    visit(entryPath, entry);
    if (entry.isDirectory()) {
      walk(entryPath, visit);
    }
  }
}

function removePath(targetPath, reason) {
  if (dryRun) {
    summary.removed.push({ path: relative(targetPath), reason, dryRun: true });
    return;
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    summary.removed.push({ path: relative(targetPath), reason, dryRun: false });
  } catch (error) {
    summary.skipped.push({
      path: relative(targetPath),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function relative(targetPath) {
  return path.relative(ROOT, targetPath).replace(/\\/g, "/") || ".";
}

function printSummary() {
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) {
    console.log("\nDry-run only. Re-run with --apply to delete listed paths.");
  }
}

function printHelp() {
  console.log(`Usage: node scripts/cleanup-data.mjs [options]

Options:
  --dry-run              Preview cleanup actions. This is the default.
  --apply                Delete listed paths.
  --data-dir <path>      Override WORLDX_DATA_DIR/output for this cleanup.
  --backup-days <days>   Delete cleanup-backups older than this many days. Default: 14.
  --keep-worlds <n>      Keep only the newest n generated worlds. Omitted by default.
  --include-temp         Also remove temporary generated maps/characters/debug output.

The script never deletes library/worlds.`);
}
