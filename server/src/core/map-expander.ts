import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildJobStatus } from "../types/build.js";
import type { WorldManager } from "./world-manager.js";
import type { ResourceManager } from "./resource-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "../..");
const EXPAND_SCRIPT = path.resolve(SERVER_ROOT, "../generators/map/src/expand-map.mjs");

const TOTAL_STEPS = 6;

type ExpandDirection = "north" | "south" | "east" | "west";

interface ExpandJob extends BuildJobStatus {
  direction: ExpandDirection;
  worldDir: string;
}

export class MapExpander {
  private jobs = new Map<string, ExpandJob>();

  constructor(
    private worldManager: WorldManager,
    private getWorldDir: () => string | undefined,
    private resourceManager?: ResourceManager,
  ) {}

  /**
   * 启动一个地图扩展任务。
   * 返回 jobId，可用于轮询进度。
   */
  startExpandJob(direction: ExpandDirection): { jobId: string } {
    const worldDir = this.getWorldDir();
    if (!worldDir) {
      throw new Error("No active world");
    }

    const jobId = `map_expand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: ExpandJob = {
      jobId,
      status: "running",
      progress: 10,
      message: `地图扩展任务已加入队列（方向: ${direction}）`,
      createdAt: Date.now(),
      direction,
      worldDir,
    };
    this.jobs.set(jobId, job);

    // 异步启动扩展流程
    this.runExpandJob(jobId, direction, worldDir).catch((err) => {
      console.error(`[MapExpander] Job ${jobId} failed:`, err);
      const j = this.jobs.get(jobId);
      if (j && j.status === "running") {
        j.status = "error";
        j.error = err instanceof Error ? err.message : String(err);
        j.finishedAt = Date.now();
      }
    });

    return { jobId };
  }

  /**
   * 查询任务状态。
   */
  getJobStatus(jobId: string): BuildJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    // 返回时去掉内部字段
    const { direction: _direction, worldDir: _worldDir, ...status } = job;
    void _direction;
    void _worldDir;
    return status as BuildJobStatus;
  }

  private async runExpandJob(
    jobId: string,
    direction: ExpandDirection,
    worldDir: string,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.progress = 10;
    job.message = "准备地图扩展...";

    const args: string[] = [
      EXPAND_SCRIPT,
      "--worldDir",
      worldDir,
      "--direction",
      direction,
    ];

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdoutBuffer += text;
      process.stdout.write(text);

      // 解析步骤进度
      // 格式: [Step N] message
      const stepMatch = text.match(/\[Step (\d+)\]\s+(.+)/);
      if (stepMatch) {
        const stepNum = parseInt(stepMatch[1], 10);
        const stepMsg = stepMatch[2].trim();
        // 进度映射: Step1=10% (设计), Step2=30% (图像生成), Step3=55% (压缩+融合),
        //           Step4=70% (标注), Step5=85% (网格计算), Step6=100% (拼接保存)
        const progressMap: Record<number, number> = {
          1: 10,
          2: 30,
          3: 55,
          4: 70,
          5: 85,
          6: 100,
        };
        const progress = progressMap[stepNum] ?? 50;
        const j = this.jobs.get(jobId);
        if (j) {
          j.progress = Math.max(j.progress, progress);
          j.message = stepMsg;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrBuffer += text;
      process.stderr.write(text);
    });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Try to extract error from last JSON line
          const errorMatch = stdoutBuffer.match(/"ok":\s*false.*?"error":\s*"([^"]+)"/);
          const errorMsg = errorMatch
            ? errorMatch[1]
            : stderrBuffer.trim() || `Expand script exited with code ${code}`;
          reject(new Error(errorMsg));
        }
      });
      child.on("error", reject);
    });

    // 扩展完成：通知 WorldManager 重新加载地图数据（碰撞网格、世界尺寸、区域、主区域点）
    try {
      this.worldManager.reloadAfterExpansion();
    } catch (err) {
      console.warn(`[MapExpander] Failed to reload world manager: ${err}`);
    }

    // 重新发现资源点（新区域可能包含新的资源采集点）
    if (this.resourceManager) {
      try {
        this.resourceManager.rediscoverAfterExpansion();
      } catch (err) {
        console.warn(`[MapExpander] Failed to rediscover resource nodes: ${err}`);
      }
    }

    // 解析最终结果获取详细信息
    let newGridWidth = 0, newGridHeight = 0, newRegions = 0, newElements = 0;
    const resultMatch = stdoutBuffer.match(/\{[^{}"']*"ok"\s*:\s*true[^{}]*\}/);
    if (resultMatch) {
      try {
        const result = JSON.parse(resultMatch[0]);
        newGridWidth = result.newGridWidth || 0;
        newGridHeight = result.newGridHeight || 0;
        newRegions = result.newRegions || 0;
        newElements = result.newElements || 0;
      } catch {
        // ignore parse errors
      }
    }

    // 更新 job 状态为完成
    const j = this.jobs.get(jobId);
    if (j) {
      j.status = "done";
      j.progress = 100;
      j.message = `地图扩展完成（方向: ${direction}），新网格 ${newGridWidth}x${newGridHeight}，新增 ${newRegions} 个区域、${newElements} 个元素。刷新页面查看新地图。`;
      j.finishedAt = Date.now();
    }

    console.log(`[MapExpander] Map expansion to ${direction} complete (job ${jobId})`);
  }
}
