import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildJobStatus } from "../types/build.js";
import type { CharacterProfile } from "../types/index.js";
import type { CharacterManager } from "./character-manager.js";
import type { WorldManager } from "./world-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "../..");
const GENERATOR_SCRIPT = path.resolve(SERVER_ROOT, "../generators/character/src/index.mjs");
const GENERATOR_OUTPUT_DIR = path.resolve(SERVER_ROOT, "../output/characters");

const TOTAL_STEPS = 4;

interface BuildJob extends BuildJobStatus {
  charId?: string;
  charName?: string;
  prompt: string;
}

export class CharacterBuilder {
  private jobs = new Map<string, BuildJob>();

  constructor(
    private worldManager: WorldManager,
    private characterManager: CharacterManager,
    private getWorldDir: () => string | undefined,
  ) {}

  /**
   * 启动一个角色生成任务。
   * 返回 jobId，可用于轮询进度。
   */
  startBuildJob(prompt: string): { jobId: string } {
    const jobId = `char_build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: BuildJob = {
      jobId,
      status: "running",
      progress: 0,
      message: "角色生成任务已加入队列",
      createdAt: Date.now(),
      prompt,
    };
    this.jobs.set(jobId, job);

    // 异步启动生成流程
    this.runBuildJob(jobId, prompt).catch((err) => {
      console.error(`[CharacterBuilder] Job ${jobId} failed:`, err);
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
    const { prompt: _prompt, ...status } = job;
    void _prompt;
    return status as BuildJobStatus;
  }

  private async runBuildJob(jobId: string, prompt: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const worldDir = this.getWorldDir();
    if (!worldDir) {
      throw new Error("No active world");
    }

    const worldVisualContext = this.worldManager.getWorldDescription() || "";

    // 构造命令参数
    const args: string[] = [
      GENERATOR_SCRIPT,
      prompt,
      "--role",
      "居民",
      "--world-visual-context",
      worldVisualContext,
    ];

    job.message = "启动角色生成管线...";

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let charId: string | null = null;
    let charName: string | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdoutBuffer += text;
      process.stdout.write(text);

      // 解析 charId
      const idMatch = text.match(/ID:\s+(\S+)/);
      if (idMatch && !charId) {
        charId = idMatch[1];
        const j = this.jobs.get(jobId);
        if (j) j.charId = charId!;
      }

      // 解析 charName
      const nameMatch = text.match(/Name:\s+(.+)/);
      if (nameMatch && !charName) {
        charName = nameMatch[1].trim();
        const j = this.jobs.get(jobId);
        if (j) j.charName = charName!;
      }

      // 解析步骤进度
      const stepMatch = text.match(/\[.*Step (\d+)\]\s+(.+)/);
      if (stepMatch) {
        const stepNum = parseInt(stepMatch[1], 10);
        const stepMsg = stepMatch[2].trim();
        const progress = Math.round(((stepNum - 1) / TOTAL_STEPS) * 100);
        const j = this.jobs.get(jobId);
        if (j) {
          j.progress = Math.max(j.progress, progress);
          j.message = stepMsg;
        }
      }

      // 检测完成
      if (text.includes("=== Done!")) {
        const j = this.jobs.get(jobId);
        if (j) {
          j.progress = 100;
          j.message = "角色精灵图生成完成，正在加入世界...";
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
          const errorMsg = stderrBuffer.trim() || `Generator exited with code ${code}`;
          reject(new Error(errorMsg));
        }
      });
      child.on("error", reject);
    });

    if (!charId) {
      throw new Error("Failed to parse character ID from generator output");
    }

    // 生成完成：复制资源 + 加入世界
    await this.finalizeCharacter(jobId, charId, charName || charId, prompt, worldDir);
  }

  private async finalizeCharacter(
    jobId: string,
    charId: string,
    charName: string,
    description: string,
    worldDir: string,
  ): Promise<void> {
    const sourceDir = path.join(GENERATOR_OUTPUT_DIR, charId);
    const targetDir = path.join(worldDir, "characters", charId);

    // 1. 复制角色精灵图资源到世界目录
    fs.mkdirSync(targetDir, { recursive: true });

    const filesToCopy = ["spritesheet.png", "metadata.json"];
    const optionalFiles = ["spritesheet-raw.png", "reference.png"];

    for (const file of [...filesToCopy, ...optionalFiles]) {
      const src = path.join(sourceDir, file);
      const dst = path.join(targetDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }

    // 读取元数据
    const metaPath = path.join(sourceDir, "metadata.json");
    let meta: Record<string, unknown> | null = null;
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      } catch {
        meta = null;
      }
    }

    // 2. 构建 CharacterProfile 并保存到世界 config/characters 目录
    const profile = this.buildCharacterProfile(charId, charName, description);

    const configDir = path.join(worldDir, "config", "characters");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, `${charId}.json`),
      JSON.stringify(profile, null, 2),
    );

    // 3. 加入 characterManager（运行时注册 + 初始化 state）
    // 使用 main_area 随机可行走点作为初始位置
    const center = this.worldManager.getMainAreaCenterPixel();
    const walkable = this.worldManager.findWalkablePixelNear(center.x, center.y);

    this.characterManager.addCharacter(profile, {
      location: "main_area",
      // mainAreaPointId 由 addCharacter 内部自动分配（通过 buildInitialCharacterState）
      ...(walkable ? {} : {}),
    });

    // 4. 更新 job 状态为完成
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "done";
      job.progress = 100;
      job.message = `角色 "${charName}" 已生成并加入世界`;
      job.finishedAt = Date.now();
      job.charId = charId;
      job.charName = charName;
    }

    console.log(`[CharacterBuilder] Character ${charName} (${charId}) added to world`);
  }

  private buildCharacterProfile(
    id: string,
    name: string,
    description: string,
  ): CharacterProfile {
    return {
      id,
      name,
      role: "居民",
      nickname: name,
      startPosition: "main_area",
      backstory: `${name}是最近来到这里的${description.slice(0, 50)}。`,
      appearanceHint: description,
      coreMotivation: "在这个世界中过好自己的生活",
      coreValues: ["平静的生活"],
      speakingStyle: "自然、贴近角色设定",
      fears: [],
      preferredLocations: ["main_area"],
      preferredActivities: [],
      socialStyle: "extrovert",
      extraversionLevel: 0.6,
      intuitionLevel: 0.5,
      skills: [],
      writeDiary: false,
      fourthWallCandidate: false,
      tags: ["generated"],
      initialMemories: [],
      isStatic: true,
    };
  }
}
