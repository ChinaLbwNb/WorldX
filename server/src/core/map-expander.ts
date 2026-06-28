import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildJobStatus } from "../types/build.js";
import type { WorldManager } from "./world-manager.js";
import type { ResourceManager } from "./resource-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "../..");
const MAP_NODE_SCRIPT = path.resolve(SERVER_ROOT, "../generators/map/src/generate-map-node.mjs");

const TOTAL_STEPS = 6;

interface ExpandJob extends BuildJobStatus {
  prompt: string;
  targetMapId?: string;
  worldDir: string;
  logs: string[];
}

interface StartExpandJobInput {
  prompt?: string;
  ownerUserId: string;
}

export class MapExpander {
  private jobs = new Map<string, ExpandJob>();

  constructor(
    private worldManager: WorldManager,
    private getWorldDir: () => string | undefined,
    private resourceManager?: ResourceManager,
  ) {}

  /**
   * 启动一个独立地图节点生成任务。
   * 返回 jobId，可用于轮询进度。
   */
  startExpandJob(input: StartExpandJobInput): { jobId: string } {
    const worldDir = this.getWorldDir();
    if (!worldDir) {
      throw new Error("No active world");
    }
    const request = this.resolveMapNodeRequest(input);

    const jobId = `map_expand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: ExpandJob = {
      jobId,
      status: "running",
      progress: 10,
      message: "地图节点生成任务已加入队列",
      createdAt: Date.now(),
      prompt: request.prompt,
      worldDir,
      logs: [],
    };
    this.jobs.set(jobId, job);

    this.runExpandJob(jobId, request, worldDir).catch((err) => {
      console.error(`[MapExpander] Job ${jobId} failed:`, err);
      const j = this.jobs.get(jobId);
      if (j && j.status === "running") {
        j.status = "error";
        j.error = err instanceof Error ? err.message : String(err);
        j.finishedAt = Date.now();
      }
      if (this.resourceManager) {
        try {
          this.resourceManager.addResources(request.ownerUserId, this.resourceManager.getBuildCosts().mapExpand);
        } catch (refundError) {
          console.warn(`[MapExpander] Failed to refund map expansion cost: ${refundError}`);
        }
      }
    });

    return { jobId };
  }

	  private resolveMapNodeRequest(input: StartExpandJobInput): {
    sourceMapId: string;
    gridX: number;
    gridY: number;
    prompt: string;
    ownerUserId: string;
  } {
    const state = this.worldManager.getWorldMapsState();
    const prompt = (input.prompt || "").trim();
    if (!prompt) {
      throw new Error("prompt is required for map node generation");
    }
    const sourceMapId = state.activeMapId;
    const occupied = new Set(state.maps.map((map) => `${map.gridX},${map.gridY}`));
    let gridX = state.maps.length;
    while (occupied.has(`${gridX},0`)) {
      gridX += 1;
    }
    return { sourceMapId, gridX, gridY: 0, prompt, ownerUserId: input.ownerUserId };
  }

  /**
   * 查询任务状态。
   */
  getJobStatus(jobId: string): BuildJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const { prompt: _prompt, targetMapId: _targetMapId, worldDir: _worldDir, ...status } = job;
    void _prompt;
    void _targetMapId;
    void _worldDir;
    return status as BuildJobStatus;
  }

  private async runExpandJob(
    jobId: string,
    request: { sourceMapId: string; gridX: number; gridY: number; prompt: string; ownerUserId: string },
    worldDir: string,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.progress = 20;
    job.message = "准备独立地图节点生成...";

    const sourceDir = this.worldManager.getMapDir(request.sourceMapId);
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      throw new Error(`Source map package not found: ${request.sourceMapId}`);
    }

    const targetMapId = `map_${request.gridX}_${request.gridY}_${Date.now().toString(36)}`;
    const targetDir = path.join(worldDir, "maps", targetMapId);
    job.targetMapId = targetMapId;
    const createdAt = new Date().toISOString();

    const result = await this.runMapNodeGenerator({
      jobId,
      worldDir,
      sourceMapId: request.sourceMapId,
      targetMapId,
      targetDir,
      prompt: request.prompt,
    });

    const metadataPath = path.join(targetDir, "metadata.json");
    let metadata: { name?: string } = {};
    if (fs.existsSync(metadataPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { name?: string };
      } catch {
        metadata = {};
      }
    }
    const targetName = result?.targetName || metadata.name || "新地图";
    const spawn =
      result?.spawn && Number.isFinite(result.spawn.x) && Number.isFinite(result.spawn.y)
        ? { x: Math.round(result.spawn.x), y: Math.round(result.spawn.y) }
        : this.worldManager.getMainAreaCenterPixel();

    job.progress = 70;
    job.message = "更新世界地图拓扑...";
    this.worldManager.appendMapNode(
      {
        id: targetMapId,
        name: targetName,
        gridX: request.gridX,
        gridY: request.gridY,
        status: "available",
        mapDir: targetMapId,
        previewImage: "background-preview.png",
        defaultSpawnPointId: `${targetMapId}_spawn`,
        createdAt,
        source: {
          fromMapId: request.sourceMapId,
          prompt: request.prompt,
          model: process.env.IMAGE_GEN_MODEL || result?.model || undefined,
        },
      },
      {
        mapId: targetMapId,
        id: `${targetMapId}_spawn`,
        name: "入口空地",
        ...spawn,
        default: true,
      },
    );

    const j = this.jobs.get(jobId);
    if (j) {
      j.status = "done";
      j.progress = 100;
      j.message = `地图节点已生成：${targetName}。打开地图 UI 可传送查看。`;
      j.finishedAt = Date.now();
      j.requiresReload = false;
      j.validation = result?.validation || { passed: true, issues: [] };
    }

    console.log(`[MapExpander] Map node ${targetMapId} created from ${request.sourceMapId} (${jobId})`);
  }

  private async runMapNodeGenerator(input: {
    jobId: string;
    worldDir: string;
    sourceMapId: string;
    targetMapId: string;
    targetDir: string;
    prompt: string;
  }): Promise<any> {
    const args = [
      MAP_NODE_SCRIPT,
      "--worldDir",
      input.worldDir,
      "--sourceMapId",
      input.sourceMapId,
      "--targetMapId",
      input.targetMapId,
      "--targetDir",
      input.targetDir,
      "--prompt",
      input.prompt,
    ];

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdoutBuffer += text;
      process.stdout.write(text);
      this.recordJobOutput(input.jobId, text);
      this.updateProgressFromOutput(input.jobId, text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrBuffer += text;
      process.stderr.write(text);
      this.recordJobOutput(input.jobId, text);
    });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const parsed = this.parseScriptResult(stdoutBuffer);
        const message = parsed?.error || stderrBuffer.trim() || `Map node generator exited with code ${code}`;
        this.cleanupFailedMapPackage(input.targetDir);
        reject(new Error(message));
      });
      child.on("error", reject);
    });

    const result = this.parseScriptResult(stdoutBuffer);
    if (!result?.ok) {
      throw new Error(result?.error || "Map node generator did not return success");
    }
    return result;
  }

  private cleanupFailedMapPackage(targetDir: string): void {
    fs.rmSync(targetDir, { recursive: true, force: true });
    const parent = path.dirname(targetDir);
    const base = path.basename(targetDir);
    if (!fs.existsSync(parent)) return;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${base}.tmp-`)) {
        fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
      }
    }
  }

  private recordJobOutput(jobId: string, text: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const lines = text.split("\n").filter(Boolean);
    job.logs.push(...lines);
    if (job.logs.length > 500) {
      job.logs = job.logs.slice(-300);
    }
  }

  private updateProgressFromOutput(jobId: string, text: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (text.includes("Step 1")) {
      job.progress = Math.max(job.progress, 30);
      job.message = "正在生成新地图图片...";
    } else if (text.includes("Step 3") || text.includes("Step 4")) {
      job.progress = Math.max(job.progress, 60);
      job.message = "正在标注区域、元素和可行走区域...";
    } else if (text.includes("Step 6")) {
      job.progress = Math.max(job.progress, 85);
      job.message = "正在生成地图包...";
    } else if (text.includes("Building world fragment")) {
      job.progress = Math.max(job.progress, 92);
      job.message = "正在验证地图包...";
    }
  }

  private parseScriptResult(stdout: string): any | null {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
      } catch {
        // keep scanning
      }
    }
    return null;
  }
}
