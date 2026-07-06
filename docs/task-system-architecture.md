# 任务系统架构

## 目标

任务系统用于承载新手引导、NPC 委托、世界事件、多人协作目标和后续剧情任务。当前已实现账号级新手引导，架构上按“任务定义 -> 目标进度 -> 目标奖励 -> 奖励发放记录”分层，避免以后每新增一种任务目标或奖励都改动核心业务模块。

任务进度属于账号维度。任务可以声明作用域为 `account`、`world`、`timeline` 或 `map`，但进度写入必须带明确账号身份，不能隐式落到全局状态。

## 设计原则

- 任务系统只消费程序事件，不直接接管资源、背包、地图、模拟、NPC 对话等核心模块。
- 任务定义集中维护，目标和奖励都用结构化合同描述。
- 同一个事件可以推进多个目标，例如一次 `collect_resource` 可以同时推进“采集一次”和“累计采集十次”。
- 进度更新是幂等上限更新，重复上报不会超过目标所需进度。
- 每个任务目标可以单独配置奖励，目标首次完成时自动发放，发放记录防止重复领取。

## 核心模型

### TaskDefinition

```ts
type TaskDefinition = {
  id: string;
  scopeType: "account" | "world" | "timeline" | "map";
  title: string;
  description: string;
  objectives: TaskObjectiveDefinition[];
  rewards: TaskRewardDefinition[];
  repeatable?: boolean;
  metadata?: Record<string, unknown>;
};
```

### TaskObjectiveDefinition

```ts
type TaskObjectiveDefinition = {
  id: string;
  kind:
    | "event_count"
    | "visit_world"
    | "collect_resource"
    | "talk_to_npc"
    | "generate_item"
    | "place_item"
    | "run_tick"
    | "generate_map_node";
  eventType: TutorialTaskEventType;
  label: string;
  description: string;
  requiredCount: number;
  rewards?: TaskRewardDefinition[];
  target?: {
    worldId?: string;
    timelineId?: string;
    mapId?: string;
    npcId?: string;
    itemCategory?: string;
    resourceType?: string;
    featureId?: string;
    flagKey?: string;
  };
  metadata?: Record<string, unknown>;
};
```

`kind` 表示目标语义，`eventType` 表示由哪个程序事件推进，`target` 用于后续加条件过滤。比如“和指定 NPC 对话”“在某个世界采集资源”“摆放某类家具”都不需要新增进度表结构。

### TaskRewardDefinition

```ts
type TaskRewardDefinition = {
  id: string;
  kind:
    | "resource"
    | "item_definition"
    | "unlock_feature"
    | "world_flag"
    | "relationship_delta"
    | "none";
  label: string;
  quantity?: number;
  target?: {
    resourceType?: string;
    itemDefinitionId?: string;
    featureId?: string;
    flagKey?: string;
  };
  metadata?: Record<string, unknown>;
  claimMode: "auto" | "manual" | "none";
};
```

当前版本已接入资源奖励自动发放。后续如果奖励类型扩展到物品、功能解锁、世界 flag 或 NPC 关系变化，应抽出独立 `TaskRewardExecutor`，由它处理不同奖励类型的执行。

## 数据存储

账号数据库 `auth.db` 当前表：

```sql
account_tutorial_task_progress (
  user_id TEXT,
  objective_id TEXT,
  current_count INTEGER,
  completed_at TEXT,
  updated_at TEXT
)
```

当前进度表只保存账号和目标进度。因为目标定义中的 `id` 保持稳定，后续可以在不迁移已有进度的情况下增加目标字段、奖励字段和条件过滤字段。

奖励发放记录表：

```sql
account_tutorial_task_reward_claims (
  user_id TEXT,
  task_id TEXT,
  objective_id TEXT,
  reward_id TEXT,
  claimed_at TEXT,
  PRIMARY KEY (user_id, task_id, objective_id, reward_id)
)
```

该表用于保证每个账号、每个任务目标、每个奖励只发一次。

## API

- `GET /api/tasks/tutorial`：读取当前账号新手任务，返回目标进度、每个目标的奖励和发放状态。
- `POST /api/tasks/tutorial/progress`：上报任务事件，body 为 `{ eventType, count? }`。
- `POST /api/tasks/tutorial/reset`：重置当前账号新手任务，主要用于测试。

后续建议扩展：

- `GET /api/tasks`：读取账号可见任务列表。
- `POST /api/tasks/:taskId/progress`：通用任务事件上报。
- `POST /api/tasks/:taskId/rewards/:rewardId/claim`：手动领取奖励。

## 当前新手目标

- 进入一个世界。
- 采集一次资源。
- 和 NPC 对话一次。
- 生成一个物品。
- 摆放一个物品。
- 推进一次世界运行。
- 生成一个地图节点。

当前每个新手目标都有独立资源奖励，完成一个目标立即自动发放一次。

## 事件来源

后端在关键成功路径推进任务：

- `/api/world/enter` -> `enter_world`
- `/api/build/collect` -> `collect_resource`
- `/api/items/generate` -> `generate_item`
- `/api/items/place` -> `place_item`
- `/api/sandbox/chat/message` -> `talk_to_npc`
- `/api/simulation/tick` -> `run_tick`
- `/api/build/map/expand` -> `generate_map_node`

前端监听部分 EventBus 事件补报进度，作为刷新、多端和异步 UI 的兜底。后续如果引入多人实时任务，服务端事件应作为权威进度来源，前端只做乐观刷新和展示。

## 后续扩展路径

1. 增加 `TaskRegistry`，集中注册新手任务、剧情任务、NPC 委托、世界事件任务。
2. 增加目标过滤器，根据 `target` 判断事件是否命中目标。
3. 增加通用 `TaskRewardExecutor`，支持物品、功能解锁、世界 flag、NPC 关系变化等非资源奖励。
4. 增加任务链依赖，例如完成新手任务后解锁 NPC 委托。
5. 增加多人协作任务，进度来源仍按账号隔离写入，展示层再聚合队伍或世界成员进度。
