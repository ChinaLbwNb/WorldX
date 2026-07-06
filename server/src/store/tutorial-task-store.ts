import { getAuthDb } from "./auth-store.js";

export type TutorialTaskEventType =
  | "enter_world"
  | "collect_resource"
  | "talk_to_npc"
  | "generate_item"
  | "place_item"
  | "run_tick"
  | "generate_map_node";

export type TaskScopeType = "account" | "world" | "timeline" | "map";

export type TaskStatus = "active" | "completed";

export type TaskObjectiveKind =
  | "event_count"
  | "visit_world"
  | "collect_resource"
  | "talk_to_npc"
  | "generate_item"
  | "place_item"
  | "run_tick"
  | "generate_map_node";

export type TaskRewardKind =
  | "resource"
  | "item_definition"
  | "unlock_feature"
  | "world_flag"
  | "relationship_delta"
  | "none";

export type TaskTarget = {
  worldId?: string;
  timelineId?: string;
  mapId?: string;
  npcId?: string;
  itemCategory?: string;
  resourceType?: string;
  featureId?: string;
  flagKey?: string;
};

export type TaskObjectiveDefinition = {
  id: string;
  kind: TaskObjectiveKind;
  eventType: TutorialTaskEventType;
  label: string;
  description: string;
  requiredCount: number;
  target?: TaskTarget;
  rewards?: TaskRewardDefinition[];
  metadata?: Record<string, unknown>;
};

export type TaskRewardDefinition = {
  id: string;
  kind: TaskRewardKind;
  label: string;
  quantity?: number;
  target?: TaskTarget;
  metadata?: Record<string, unknown>;
  claimMode: "auto" | "manual" | "none";
};

export type TaskDefinition = {
  id: string;
  scopeType: TaskScopeType;
  title: string;
  description: string;
  objectives: TaskObjectiveDefinition[];
  rewards: TaskRewardDefinition[];
  repeatable?: boolean;
  metadata?: Record<string, unknown>;
};

export type TutorialObjectiveView = {
  id: string;
  kind: TaskObjectiveKind;
  eventType: TutorialTaskEventType;
  label: string;
  description: string;
  requiredCount: number;
  currentCount: number;
  completed: boolean;
  completedAt: string | null;
  target?: TaskTarget;
  rewards: TaskRewardView[];
  metadata?: Record<string, unknown>;
};

export type TaskRewardView = TaskRewardDefinition & {
  claimed: boolean;
  claimedAt: string | null;
};

export type TutorialTaskView = {
  id: string;
  scopeType: TaskScopeType;
  title: string;
  description: string;
  status: TaskStatus;
  progress: {
    completed: number;
    total: number;
    percent: number;
  };
  objectives: TutorialObjectiveView[];
  rewards: TaskRewardView[];
};

const TUTORIAL_TASK_ID = "tutorial_first_steps";

const TUTORIAL_TASK: TaskDefinition = {
  id: TUTORIAL_TASK_ID,
  scopeType: "account",
  title: "新手引导",
  description: "完成这些基础目标，熟悉 WorldX 的核心玩法。",
  objectives: [
    {
      id: "enter_world",
      kind: "visit_world",
      eventType: "enter_world",
      label: "进入一个世界",
      description: "选择任意世界，并用你的账号角色进入默认地图。",
      requiredCount: 1,
      rewards: [
        {
          id: "enter_world_resource",
          kind: "resource",
          label: "资源",
          quantity: 20,
          target: { resourceType: "account_resource" },
          claimMode: "auto",
        },
      ],
    },
    {
      id: "collect_resource",
      kind: "collect_resource",
      eventType: "collect_resource",
      label: "采集一次资源",
      description: "靠近地图上的可交互资源点，点击采集按钮获得资源。",
      requiredCount: 1,
      target: { resourceType: "account_resource" },
      rewards: [
        {
          id: "collect_resource_bonus",
          kind: "resource",
          label: "资源",
          quantity: 20,
          target: { resourceType: "account_resource" },
          claimMode: "auto",
        },
      ],
    },
    {
      id: "talk_to_npc",
      kind: "talk_to_npc",
      eventType: "talk_to_npc",
      label: "和 NPC 对话一次",
      description: "打开单人聊天或公屏 @NPC，完成一次和 NPC 的对话。",
      requiredCount: 1,
      rewards: [
        {
          id: "talk_to_npc_resource",
          kind: "resource",
          label: "资源",
          quantity: 20,
          target: { resourceType: "account_resource" },
          claimMode: "auto",
        },
      ],
    },
    {
      id: "generate_item",
      kind: "generate_item",
      eventType: "generate_item",
      label: "生成一个物品",
      description: "在背包里输入描述，生成一个账号资产物品。",
      requiredCount: 1,
      rewards: [
        {
          id: "generate_item_resource",
          kind: "resource",
          label: "资源",
          quantity: 20,
          target: { resourceType: "account_resource" },
          claimMode: "auto",
        },
      ],
    },
    {
      id: "place_item",
      kind: "place_item",
      eventType: "place_item",
      label: "摆放一个物品",
      description: "从背包选择可摆放物品，并放到当前地图上。",
      requiredCount: 1,
      rewards: [
        {
          id: "place_item_resource",
          kind: "resource",
          label: "资源",
          quantity: 20,
          target: { resourceType: "account_resource" },
          claimMode: "auto",
        },
      ],
    },
    {
      id: "run_tick",
      kind: "run_tick",
      eventType: "run_tick",
      label: "推进一次世界运行",
      description: "点击开始运行或推进 tick，让世界由模拟系统运转一次。",
      requiredCount: 1,
      rewards: [
        {
          id: "run_tick_resource",
          kind: "resource",
          label: "资源",
          quantity: 20,
          target: { resourceType: "account_resource" },
          claimMode: "auto",
        },
      ],
    },
    {
      id: "generate_map_node",
      kind: "generate_map_node",
      eventType: "generate_map_node",
      label: "生成一个地图节点",
      description: "从地图/建造入口输入提示词，生成世界里的新地图节点。",
      requiredCount: 1,
      rewards: [
        {
          id: "generate_map_node_resource",
          kind: "resource",
          label: "资源",
          quantity: 20,
          target: { resourceType: "account_resource" },
          claimMode: "auto",
        },
      ],
    },
  ],
  rewards: [],
};

const TUTORIAL_EVENT_TYPES = new Set<TutorialTaskEventType>(
  TUTORIAL_TASK.objectives.map((objective) => objective.eventType),
);

function ensureTable(): void {
  getAuthDb().exec(`
    CREATE TABLE IF NOT EXISTS account_tutorial_task_progress (
      user_id TEXT NOT NULL,
      objective_id TEXT NOT NULL,
      current_count INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, objective_id),
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_tutorial_task_progress_user
      ON account_tutorial_task_progress(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS account_tutorial_task_reward_claims (
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      objective_id TEXT NOT NULL,
      reward_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (user_id, task_id, objective_id, reward_id),
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_tutorial_task_reward_claims_user
      ON account_tutorial_task_reward_claims(user_id, task_id, claimed_at);
  `);
}

function getClaimedRewards(userId: string): Map<string, string> {
  const rows = getAuthDb()
    .prepare(
      `SELECT objective_id, reward_id, claimed_at
       FROM account_tutorial_task_reward_claims
       WHERE user_id = ? AND task_id = ?`,
    )
    .all(userId, TUTORIAL_TASK.id) as Array<{
      objective_id: string;
      reward_id: string;
      claimed_at: string;
    }>;
  return new Map(rows.map((row) => [`${row.objective_id}:${row.reward_id}`, row.claimed_at]));
}

function toRewardViews(
  rewards: TaskRewardDefinition[] | undefined,
  objectiveId: string,
  claimedRewards: Map<string, string>,
): TaskRewardView[] {
  return (rewards ?? []).map((reward) => {
    const claimedAt = claimedRewards.get(`${objectiveId}:${reward.id}`) ?? null;
    return {
      ...reward,
      claimed: Boolean(claimedAt),
      claimedAt,
    };
  });
}

function grantObjectiveRewards(
  userId: string,
  objective: TaskObjectiveDefinition,
  claimedAt: string,
): void {
  const rewards = objective.rewards ?? [];
  if (rewards.length === 0) return;
  const db = getAuthDb();
  const insertClaim = db.prepare(
    `INSERT OR IGNORE INTO account_tutorial_task_reward_claims
      (user_id, task_id, objective_id, reward_id, claimed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const ensureResources = db.prepare(
    `INSERT OR IGNORE INTO account_resources (user_id, amount)
     VALUES (?, 10)`,
  );
  const addResources = db.prepare(
    `UPDATE account_resources
     SET amount = amount + ?, updated_at = datetime('now')
     WHERE user_id = ?`,
  );

  for (const reward of rewards) {
    if (reward.claimMode === "none") continue;
    const result = insertClaim.run(userId, TUTORIAL_TASK.id, objective.id, reward.id, claimedAt);
    if (result.changes <= 0) continue;
    if (reward.kind === "resource") {
      const amount = Math.max(0, Math.floor(Number(reward.quantity ?? 0)));
      if (amount > 0) {
        ensureResources.run(userId);
        addResources.run(amount, userId);
      }
    }
  }
}

export function getTutorialTask(userId: string): TutorialTaskView {
  ensureTable();
  const db = getAuthDb();
  const rows = getAuthDb()
    .prepare(
      `SELECT objective_id, current_count, completed_at
       FROM account_tutorial_task_progress
       WHERE user_id = ?`,
    )
    .all(userId) as Array<{
      objective_id: string;
      current_count: number;
      completed_at: string | null;
    }>;
  const progress = new Map(rows.map((row) => [row.objective_id, row]));
  const grantBackfilledRewards = db.transaction(() => {
    for (const objective of TUTORIAL_TASK.objectives) {
      const row = progress.get(objective.id);
      const currentCount = Math.min(
        Math.max(Number(row?.current_count ?? 0), 0),
        objective.requiredCount,
      );
      if (currentCount >= objective.requiredCount) {
        grantObjectiveRewards(userId, objective, row?.completed_at ?? new Date().toISOString());
      }
    }
  });
  grantBackfilledRewards();
  const claimedRewards = getClaimedRewards(userId);
  const objectives = TUTORIAL_TASK.objectives.map((objective) => {
    const row = progress.get(objective.id);
    const currentCount = Math.min(
      Math.max(Number(row?.current_count ?? 0), 0),
      objective.requiredCount,
    );
    return {
      ...objective,
      currentCount,
      completed: currentCount >= objective.requiredCount,
      completedAt: row?.completed_at ?? null,
      rewards: toRewardViews(objective.rewards, objective.id, claimedRewards),
    };
  });
  const completed = objectives.filter((objective) => objective.completed).length;
  const total = objectives.length;
  return {
    id: TUTORIAL_TASK.id,
    scopeType: TUTORIAL_TASK.scopeType,
    title: TUTORIAL_TASK.title,
    description: TUTORIAL_TASK.description,
    status: completed >= total ? "completed" : "active",
    progress: {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    },
    objectives,
    rewards: TUTORIAL_TASK.objectives.flatMap((objective) =>
      toRewardViews(objective.rewards, objective.id, claimedRewards),
    ),
  };
}

export function recordTutorialTaskEvent(
  userId: string,
  eventType: TutorialTaskEventType,
  count = 1,
): TutorialTaskView {
  ensureTable();
  const objectives = TUTORIAL_TASK.objectives.filter((item) => item.eventType === eventType);
  if (objectives.length === 0) return getTutorialTask(userId);
  const increment = Math.max(1, Math.floor(Number(count) || 1));
  const db = getAuthDb();
  const existingQuery = db.prepare(
    `SELECT current_count, completed_at
     FROM account_tutorial_task_progress
     WHERE user_id = ? AND objective_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO account_tutorial_task_progress
      (user_id, objective_id, current_count, completed_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, objective_id) DO UPDATE SET
       current_count = excluded.current_count,
       completed_at = COALESCE(account_tutorial_task_progress.completed_at, excluded.completed_at),
       updated_at = datetime('now')`,
  );
  const updateObjectives = db.transaction(() => {
    for (const objective of objectives) {
      const existing = existingQuery.get(userId, objective.id) as
        | { current_count?: number; completed_at?: string | null }
        | undefined;
      const current = Math.max(Number(existing?.current_count ?? 0), 0);
      const next = Math.min(objective.requiredCount, current + increment);
      const completedAt = existing?.completed_at || (next >= objective.requiredCount ? new Date().toISOString() : null);
      upsert.run(userId, objective.id, next, completedAt);
      if (next >= objective.requiredCount && completedAt) {
        grantObjectiveRewards(userId, objective, completedAt);
      }
    }
  });
  updateObjectives();
  return getTutorialTask(userId);
}

export function resetTutorialTask(userId: string): TutorialTaskView {
  ensureTable();
  getAuthDb()
    .prepare("DELETE FROM account_tutorial_task_progress WHERE user_id = ?")
    .run(userId);
  return getTutorialTask(userId);
}

export function isTutorialTaskEventType(value: unknown): value is TutorialTaskEventType {
  return typeof value === "string" && TUTORIAL_EVENT_TYPES.has(value as TutorialTaskEventType);
}
