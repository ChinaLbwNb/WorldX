# WorldX 项目架构技术文档

## 系统总览

WorldX 是一个 AI 驱动的游戏世界生成与模拟系统。用户输入一段自然语言描述，系统自动生成包含地图、角色和交互物件的游戏世界，并支持角色自主行动模拟、玩家操控、资源采集和地图扩展。

角色、账户和物品系统的扩展边界见 [多人账户、角色交互与物品系统扩展架构](./multiplayer-items-architecture.md)。后续新增背包、地图摆放、玩家交换和角色关系时，应优先复用该文档中的 `ActorRef`、`PresenceScope`、`ItemDefinition/ItemInstance`、`InventoryEntry` 和 `MapItemPlacement` 模型。

系统分为三层：

- **生成层**（`generators/`）：独立 Node 脚本，通过 AI 模型生成地图和角色资产
- **服务层**（`server/`）：Express + SQLite，管理世界状态、模拟循环、API 路由
- **客户端**（`client/`）：Phaser 3 游戏引擎 + React UI 双栈架构

三层之间的核心交互模式是**子进程 spawn + stdout 解析**：服务层通过 `child_process.spawn` 调用生成脚本，解析 stdout 中的进度标记来跟踪任务状态。生成完成后，服务层读取产出文件（TMJ、PNG、精灵图）加载到运行时。

```
┌──────────────────────────────────────────────────────┐
│                    客户端 (Client)                     │
│  ┌──────────────┐     ┌───────────────────────────┐  │
│  │  Phaser 3     │◄──►│  React UI                 │  │
│  │  游戏引擎      │    │  TopBar/SidePanel/Build  │  │
│  │  WorldScene   │    │  MapControls/Dialogue    │  │
│  └──────┬───────┘     └───────────┬───────────────┘  │
│         │ EventBus.instance       │ fetch / SSE      │
│         │ (Phaser.Events)         │                  │
└─────────┼─────────────────────────┼──────────────────┘
          │                         │
┌─────────┼─────────────────────────┼──────────────────┐
│         │     服务层 (Server)      │                  │
│  ┌──────▼──────────────────────────▼───────────────┐ │
│  │              AppContext (单例)                    │ │
│  │  WorldManager │ CharacterManager │ MapExpander   │ │
│  │  ResourceManager│ PlayerManager │ SimulationEngine│ │
│  │  LLMClient │ DecisionMaker │ DialogueGenerator  │ │
│  └──────┬──────────────────────────────────────────┘ │
│         │ child_process.spawn                        │
│  ┌──────▼──────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ CreateJob   │  │ Character    │  │ Map         │  │
│  │ Manager     │  │ Builder      │  │ Expander    │  │
│  │ (Orchestrator)│ │ (Character   │  │ (Expand-    │  │
│  │              │  │  Generator)  │  │  map.mjs)   │  │
│  └──────────────┘  └──────────────┘  └─────────────┘  │
│         SQLite (每 timeline 独立 DB)                   │
└──────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────┐
│                   生成层 (Generators)                  │
│  orchestrator/  →  世界设计 + 地图生成 + 角色生成      │
│  generators/map/  →  6步地图生成管线 + 扩展管线        │
│  generators/character/  →  角色精灵图生成              │
│  AI Models: gemini-flash-img / gemini-pro / gemini-2.5│
└──────────────────────────────────────────────────────┘
```

## 客户端引擎层

### Phaser 3 + React 双栈架构

客户端的核心设计是**引擎与 UI 分离**。Phaser 3 负责世界渲染、角色动画、碰撞检测等游戏逻辑；React 负责所有 HUD 和面板交互。两者通过一个共享的 `EventBus.instance`（Phaser.Events.EventEmitter 单例）解耦通信，互不直接持有引用。

DOM 层次结构：
- `#game-root`：Phaser canvas，世界渲染层
- `#ui-root`：React 面板，顶层 `pointer-events: none`，各面板自行开启 `pointer-events: auto`，实现点击穿透
- `#label-root`：角色 DOM 标签和对话气泡，跟随 Phaser 坐标
- `#background-root`：创建世界时的背景动画

这种设计让 Phaser 专注于高性能渲染，而文字、列表、表单等 UI 交给 React 处理，各自发挥优势。

### 场景管理

Phaser 使用两个场景：

**BootScene** 负责资源预加载。在 `init()` 阶段先 `fetch("/api/characters")` 拉取角色清单（避免 preload 内 await 的时序问题），然后在 `preload()` 中同步队列加载：
- `06-final.tmj`（Tiled 地图 JSON，key = "world-map"）
- `06-background.png`（地图背景大图，key = "world-base"）
- 每个角色的 `spritesheet.png`（170×204 像素单帧，6×5 布局 30 帧）

**WorldScene** 是主世界场景（约 1468 行），装配了多个子系统：
- `MapManager`：解析 Tiled JSON，构建碰撞网格、区域、可交互对象
- `PathfindingManager`：基于 EasyStar.js 的 A* 寻路
- `CharacterMovement`：角色移动编排（路径执行、对话就位、环境漫游）
- `PlaybackController`：tick 推进和回放控制
- `CameraController`：相机缩放/平移/跟随

每帧 `update()` 执行：相机更新 → 寻路更新 → 回放更新 → 环境漫游 → DOM 标签缩放同步 → Y 轴深度排序。深度排序按 `getSortFootY()` 升序排列 `entityLayer` 中的所有角色，实现"近大远小、下方遮挡上方"的伪 3D 效果。

### 地图背景渲染

地图背景是一张普通图片（`this.add.image(0, 0, "world-base").setOrigin(0, 0)`），**不使用 Tiled 的瓦片渲染**。逻辑地图数据（碰撞、区域、交互对象）全部从 Tiled JSON 的 layers 解析，由 MapManager 管理。背景图仅作为视觉底图。

MapControls 的小地图用独立 `<img>` 加载同一 PNG，在 canvas 上 `drawImage` 绘制并叠加视口矩形框。

### 角色精灵图渲染

每个角色的精灵图是 170×204 像素的 30 帧 spritesheet（6 列×5 行），帧布局：
- 帧 0-5：向左行走
- 帧 6-11：向下行走
- 帧 12-17：向上行走
- 帧 18-20：站立（下/上/左右，右方向用 `flipX` 复用左方向）

精灵锚点设在 `(0.5, 0.85)`（脚部偏下），配合 `getSortFootY()` 做深度排序。行走动画帧率 8 fps。

角色显示尺寸通过 `createCharacterDisplayMetrics(mapWidth, mapHeight)` 动态计算——精灵高度约为地图宽高和的 4%，所有角色按地图比例统一缩放。这保证了不同尺寸地图上角色的视觉比例一致。

当纹理未就绪时，`CharacterSprite` 先用彩色圆形（`createCircleBody()`）作 fallback，纹理可用后 `tryUpgradeToSprite()` 热切换为精灵体。`WorldScene.syncCharactersFromServer()` 还有动态补加载机制，用 Phaser Loader 运行时加载缺失纹理。

每个角色还创建 DOM 标签（名字 + 动作 emoji + 动作 pill），挂在 `#label-root` 上。`updateDomLabelPosition()` 每帧根据相机 worldView 把世界坐标换算为屏幕坐标，`syncOverlayZoom()` 按 zoom 缩放字号。这是**混合渲染**的关键——Phaser 画精灵，DOM 画清晰文字。

## 世界交互系统

### 碰撞检测

碰撞检测基于 Tiled 的 collision tilelayer，**不使用物理引擎**：

1. `MapManager.parseCollisionLayer()` 把 TMJ 的 `data` 数组转为二维 `collisionGrid[gy][gx]`，0 = 可通行，非 0 = 阻挡
2. `isWalkable(gx, gy)` 直接查网格
3. 服务端 `WorldManager.isPixelWalkable(x, y)` 将像素坐标转瓦片索引后查碰撞网格

碰撞网格的来源是生成管线 Step 5 的 CV 计算（详见生成管线文档），通过青色像素 diff 逐 block 检测生成，并经形态学清理去除噪声。

### 寻路系统

`PathfindingManager` 基于 EasyStar.js 实现 A* 寻路：

1. `setGrid(collisionGrid)` + `setAcceptableTiles([0])` 设置网格和可通行值
2. `applyEdgeCosts()` 对邻接阻挡格的可通行格加 `EDGE_COST = 3`，让路径远离墙壁，避免角色贴墙行走
3. `findPath()` 流程：像素坐标 → 瓦片坐标 → 终点不可达时 `findNearestWalkable` 螺旋搜索最近可行走格 → A* 计算 → **后处理优化**：
   - `rebalanceStaircases`：将阶梯路径重整为批量 L 形，减少拐弯次数
   - `simplifyOrthogonalShortcuts`：用 L 形或直线捷径压缩冗余拐点
   - 转回像素坐标

角色移动用 **Tween 而非物理速度**：`CharacterSprite.walkAlongPath()` 逐段 `tweens.add({ x, y, duration })`，duration 按 `dist / speed` 计算，`speed = bodyHeight × 1.1`。

### 玩家移动

玩家角色是纯圆形精灵（绿色 0x00b894 + 脉冲发光环），无精灵图。移动控制流程：

1. `setupGroundClickHandler()` 监听 `input.pointerdown`，排除点中精灵/Zone/资源标记的情况
2. 取 `cameras.main.getWorldPoint()` 并 Clamp 到地图边界（32px 内边距）
3. `movePlayerTo(x, y)` 执行**乐观更新**：先本地 Tween 移动，同时后台 `apiClient.movePlayer(x, y)` 同步到服务端
4. 服务端校验可行走性，不可行走则 `findWalkablePixelNear` 螺旋搜索回退
5. 若服务端返回位置与本地差异 > 10px 且玩家已停，则 snap 到服务端位置

NPC 移动由模拟事件驱动，非玩家直接控制。`CharacterMovement.moveToLocation()` 根据目标位置走 A* 寻路，无路时用 `fadeTransport()`（先走 2/3 可达距离，再淡出→瞬移→淡入）。非移动状态时 `idleWander()` 按 4.5-9s 随机冷却做小范围漫游。

### 资源采集交互

资源采集是玩家与世界交互的核心玩法：

1. **资源点发现**：服务端 `ResourceManager.discoverResourceNodes()` 从 TMJ 交互对象层 + 关键词匹配发现资源点（最多 6 个），客户端通过 `getBuildState()` 获取
2. **标记显示**：`setupResourceMarkers()` 为每个资源点创建 Container——外圈发光环 + 内填充圆 + 中心 emoji，带脉冲动画
3. **就近检测**：玩家停止后 `updateNearbyResource()` 遍历资源点，距离 ≤ 120px 且 remaining > 0 时显示采集按钮
4. **采集执行**：`collectResource(objectId)` 调用 `apiClient.collectResource()`，服务端检查冷却（`cooldownMs`）后增加资源量
5. **UI 反馈**：TopBar 的 `ResourceDisplay` 检测资源增长触发 +1 弹跳动画

### 地图扩展触发

当前在线地图扩展方向已从“拼接一张更大的背景图”切换为“独立地图节点 + 地图 UI 传送”。旧拼接方案仅作为历史参考；新的运行时会把原始地图初始化为 `maps/map_origin/`，前端按 active map 加载 `/assets/maps/<mapId>/06-final.tmj` 和背景瓦片。已迁移世界不再保留根目录 `map/` 大图包，服务端也不再暴露 `/assets/map/...` 静态路由。

地图节点扩展由 React 侧的 `BuildPanel` 发起，是异步 job 模式：

1. BuildPanel 显示已有地图节点和“新地图描述”输入框
2. 检查资源 ≥ 50（默认 `mapExpand` 成本），调用 `apiClient.generateMapNode({ prompt })`
3. 服务端 `MapExpander.startExpandJob()` 扣除资源并调用 `generate-map-node.mjs` 创建独立地图节点包
4. 客户端 `setInterval(poll, 2000)` 轮询 `getMapExpandJob(jobId)` 获取进度
5. 生成完成后，`world.json` 追加 `worldMaps/mapSpawnPoints`
6. 用户在地图 UI 点击已有节点，调用 `/api/world/map/travel` 切换 active map 并刷新页面

`MapExpander` 不再拼接或复制源地图作为最终结果。它会在目标目录旁创建 `<targetDir>.tmp-*` 工作目录，真实运行地图生成、区域标注、可行走标注、TMJ 构建和 `world-fragment.json` 生成；视觉审查与程序化验证都通过后才 rename 到正式地图目录。失败时清理临时目录并退还资源，不修改 `world.json` 拓扑。

## 可行走区域系统

可行走区域是连接生成管线和运行时交互的关键纽带，贯穿整个系统架构。

### 生成阶段

在地图生成管线的 Step 4，AI 模型在压缩地图上用纯青色 RGB(0, 255, 255) 标注可行走区域。Step 5 的 CV 算法将像素级标注转化为瓦片级碰撞网格：

- 逐 block 比较原图与标注图的 RGB 差异
- 强青像素覆盖率 ≥ 22% 或弱青覆盖率 ≥ 38% 判定为可行走
- 细走廊救援机制防止 1 格宽走廊被侵蚀
- 形态学清理移除孤立噪声格

生成的碰撞网格以一维数组形式存入 TMJ 的 `collision` tilelayer（0 = 可行走，1 = 阻塞）。

### 运行时加载

服务端 `WorldManager.loadCollisionGrid()` 读取 TMJ 的 collision 层，转为 `collisionData: number[]`。同时更新 `worldSize`（`gridWidth × tileSize` × `gridHeight × tileSize`）。

客户端 `MapManager.parseCollisionLayer()` 将同样的数据转为二维 `collisionGrid`，供 `PathfindingManager` 使用。

### 地图切换重载

独立地图节点之间不共享像素坐标和碰撞网格。玩家点击地图 UI 传送时，`POST /api/world/map/travel` 更新 `activeMapId` 和玩家所在 `mapId/x/y`，随后 `WorldManager.loadMap(targetMapId)` 读取目标地图目录中的 `06-final.tmj`、碰撞网格、`world-fragment.json` 和资源 object。前端收到 `requiresReload: true` 后刷新页面或重启 Phaser 场景，确保纹理、背景瓦片、小地图和碰撞网格都来自目标地图。

### 独立地图节点验证

地图扩展不再做像素接缝融合、碰撞网格合并或 west/north 坐标迁移。每个新节点是一张完整本地地图，验证重点变为：

- `06-background.png`、`06-final.tmj`、`background-tiles/manifest.json` 存在。
- TMJ 尺寸、tileSize 和 collision layer 合法。
- 可行走比例在合理范围内，默认出生点落在可走格。
- `world-fragment.json` 至少包含一个 location 和 mainAreaPoint。
- 资源 object 写入 `pixelX/pixelY/width/height/resourcePerClick/cooldownMs`，方便 `ResourceManager` 在 active map 下精确发现。

新地图生成不再使用方向拓扑。用户 prompt 决定新节点主题；当前 active map 仅提供世界观和视觉风格参考，生成结果通过地图 UI 传送进入。

## 服务端架构

### AppContext 依赖容器

`AppContext` 是服务端的中央依赖注入容器（单例），聚合了所有管理器并通过 `EventEmitter`（`eventBus`）解耦通信。

核心生命周期方法：
- `initialize(worldDirPath?)`：初始化数据库、时间线，重建运行时
- `rebuildRuntime()`：实例化并初始化全部管理器（WorldManager → CharacterManager → ... → SimulationEngine），LLMClient 和 PromptBuilder 在重建时保留旧实例
- `switchWorld(worldDirPath)`：切换世界时关闭旧 DB → 重新加载配置 → 重建运行时 → 开始新录制
- `switchTimeline(timelineId)`：切换时间线（每个时间线独立 SQLite DB）

### WorldManager 世界状态管理

`WorldManager` 是最核心的管理器（约 1257 行），负责：

- **地图数据加载**：读取 `world.json` 配置和 `06-final.tmj`，加载碰撞网格、世界尺寸、区域配置
- **主区域点图**：从 TMJ collision 层用 BFS 推导主区域点之间的可达性邻接图，取最大连通分量作为角色出生池
- **游戏时间**：`advanceTick()` 推进时间，跨天时触发场景重置
- **可行走性查询**：`isPixelWalkable(x, y)` 像素→瓦片索引查碰撞网格
- **出生点分配**：`getSpreadMainAreaPointId()` 在最大连通分量中选未占用出生点
- **物件状态管理**：物件的运行时状态合并、占用管理（含 capacity 检查）
- **快照系统**：创建/恢复/列出快照
- **地图节点管理**：初始化 `map_origin`、按 `activeMapId` 加载地图、追加 `worldMaps/mapLinks/mapSpawnPoints`、处理地图 UI 传送

### 模拟引擎

模拟循环由 `SimulationEngine.simulateTick()` 驱动，每个 tick：

1. `WorldManager.advanceTick()` 推进游戏时间
2. `CharacterManager.tickPassiveUpdate()` 衰减角色需求（curiosity）和情绪
3. 对每个非静态角色调用 `DecisionMaker.makeDecision()` → LLM 决策
4. 执行决策（交互物件/全局动作/对话/移动/发呆）
5. `finalizeTickEvents()` 做戏剧性评分、引用提取、事件存储
6. `eventBus.emit("tick_events")` → WebSocket 广播 + Timeline 持久化

静态角色（`isStatic: true`）跳过 AI 决策循环，新生成角色默认静态。

### 生成管线交互

服务端通过 `child_process.spawn` 调用三个独立的生成管线：

| 管理器 | 脚本 | 进度解析 | 完成回调 |
|--------|------|---------|---------|
| CreateJobManager | orchestrator/src/index.mjs | 多正则解析 Phase/Step/World ID/角色进度 | 持久化日志 |
| CharacterBuilder | generators/character/src/index.mjs | `ID:`/`Name:`/`Step N`/`Done!` | 复制资源 + 注册角色 |
| MapExpander | generators/map/src/generate-map-node.mjs | `[Step N]` 6 步进度映射 | 追加 `worldMaps/mapLinks/mapSpawnPoints` |

共同模式：spawn 子进程 → 监听 stdout 实时打印 + 正则解析进度 → `close(code===0)` 判断成功 → Job 状态存内存 Map，通过 REST 轮询或 SSE 推送。

### API 路由

| 路径前缀 | 路由文件 | 核心功能 |
|---------|---------|---------|
| `/api/worlds` | worlds-create.ts | 创建世界（SSE 流式进度）、查询/取消 job |
| `/api/world` | world.ts | 世界信息、区域、切换世界、删除世界 |
| `/api/characters` | characters.ts | 角色列表、详情、日记、记忆、编辑人设 |
| `/api/build` | build.ts | 资源采集、玩家移动、生成角色、扩展地图 |
| `/api/simulation` | simulation.ts | 推进 tick/天、暂停/恢复/重置 |
| `/api/events` | events.ts | 事件查询（按天/类型/角色过滤） |
| `/api/god` | god.ts | 全局广播、角色耳语 |
| `/api/timelines` | timeline.ts | 时间线管理、回放事件 |
| `/api/sandbox/chat` | sandbox-chat.ts | 架空对话（纯内存，不持久化） |

### 实时通信

服务端有两套实时通信机制：

**SSE**（Server-Sent Events）：用于世界生成任务的流式进度推送。`GET /api/worlds/jobs/:jobId/events` 返回 `text/event-stream`，先回放历史事件，再实时订阅 `createJobManager.on("event")` 推送，15s 心跳，job 完成后关闭流。

**HTTP 轮询**：模拟推进由客户端 `PlaybackController` 在 autoPlay 下按 `tickIntervalMs` 节奏主动 POST `/simulation/tick` 触发，服务端返回该 tick 的全部事件。建造状态、角色列表、job 进度均通过 setInterval 轮询。

## 通信机制详解

### EventBus 事件系统

`EventBus.instance` 是复用 `Phaser.Events.EventEmitter` 的全局单例，同时注入 Phaser 场景和 React App，构成双向事件总线。

**Phaser → React** 方向的关键事件：

| 事件 | 触发场景 |
|------|---------|
| `time_update` | tick 推进后更新游戏时间 |
| `character_clicked` | 玩家点击角色精灵 |
| `sim_event` | 模拟事件到达（移动/动作/对话等） |
| `dialogue` | 对话事件到达 |
| `simulation_status` | 模拟状态变化（idle/running） |
| `build_state_updated` | 资源采集后更新建造状态 |
| `resource_collected` | 资源采集成功 |

**React → Phaser** 方向的关键事件：

| 事件 | 触发场景 |
|------|---------|
| `set_auto_play` | TopBar 切换自动播放 |
| `dev_advance_tick` | 手动推进一个 tick |
| `follow_character` / `unfollow_character` | 选中角色后跟随 |
| `camera_zoom_in/out/fit/reset` | 小地图缩放控制 |
| `camera_pan_to` | 小地图点击跳转 |
| `toggle_debug_*_overlay` | Dev 模式调试开关 |

WorldScene 在 `create()` 中用具名函数引用注册监听，并在 `SHUTDOWN` 时 `eventBus.off()` 清理，避免内存泄漏。

### Tick 回放同步机制

模拟事件不是即时执行的——一个 tick 可能包含多个事件（移动、对话、动作），每个事件都有动画和持续时间。PlaybackController 通过一套同步握手机制确保所有动画完成后才推进下一个 tick：

1. `emit("tick_playback_started")` — 通知 WorldScene 新 tick 开始
2. 逐个 `emit("event")` — WorldScene 处理每个事件（移动动画、对话气泡等）
3. `emit("tick_playback_events_flushed")` — 所有事件已发出
4. `WorldScene` 通过 `trackPlaybackAsync()` 计数异步操作（动画、定时器、对话链）
5. 所有异步操作完成后 `emit("tick_playback_complete")`
6. PlaybackController 收到完成信号，推进下一个 tick

跨天时有额外的遮罩握手：`emit("scene_ending")` → SceneTransition 遮罩覆盖屏幕 → `emit("scene_covered")` → 跨天 tick 在遮罩下执行 → 遮罩淡出。

## 数据持久化

### SQLite 数据库

每个时间线使用独立的 SQLite 数据库（`state.db`），包含以下表：

| 表 | 内容 |
|---|------|
| events | 模拟事件（按 tick 记录） |
| memories | 角色记忆（含衰减因子、访问计数、长期标记） |
| character_states | 角色易变状态（位置、动作、情绪、需求） |
| world_object_states | 物件运行时状态 |
| world_global_state | 全局状态（键值对，如玩家资源、对话会话） |
| diary_entries | 角色日记 |
| snapshots | 世界快照 |
| llm_call_logs | LLM 调用日志 |
| content_candidates | 内容候选（引用、摘要） |
| users | 用户账户/本地用户身份 |
| user_characters | 用户拥有的可操作角色 |
| user_character_runtime | 用户角色在世界/时间线/地图中的唯一运行态 |
| item_definitions | 物品定义 |
| item_instances | 具体物品实例 |
| inventory_entries | 角色/NPC/容器/系统的背包条目 |
| map_item_placements | 当前地图中已摆放的物品 |
| item_transfers | 物品转移、交换、拾取、摆放流水 |
| actor_relationships | 用户角色与 NPC、角色与角色之间的关系状态 |
| actor_interactions | 用户角色/NPC 交互事件 |

### 文件系统

世界目录结构：

```
output/worlds/{worldId}/
├── world.json                    # 世界配置（区域、物件、角色定义）
├── world-design.json             # AI 设计的世界描述（区域/元素/动作）
├── map/
│   ├── 06-background.png         # 地图背景图（最终输出）
│   ├── 06-final.tmj              # Tiled 地图 JSON（碰撞/区域/交互对象）
│   ├── metadata.json             # 生成元数据 + 扩展历史
│   ├── 06-background.bak-*.png   # 扩展前备份
│   └── 06-final.bak-*.tmj        # 扩展前备份
├── characters/{charId}/
│   ├── spritesheet.png           # 角色精灵图
│   └── metadata.json             # 角色元数据
├── config/characters/{charId}.json  # 角色配置文件
├── timelines/{timelineId}/
│   ├── state.db                  # 时间线独立数据库
│   └── events.jsonl              # 事件流（回放用）
└── logs/generation.log           # 生成日志
```

## 世界生成全流程

从用户输入到可交互世界的完整流程：

1. **用户提交提示词**：React 侧 `CreateWorldPage` → `apiClient.createWorld(prompt)` → `createJobManager.startJob()`
2. **Orchestrator 编排**：spawn `orchestrator/src/index.mjs`，执行 4 个 Phase：
   - Phase 1：WorldDesigner（LLM）设计世界概念、区域、角色
   - Phase 2：地图生成管线（6 步，详见生成管线文档）
   - Phase 3：角色精灵图生成（逐角色调用 character generator）
   - Phase 4：配置文件生成（world.json、角色配置）
3. **SSE 实时推送**：每个 Phase/Step 的进度通过 SSE 流推送到客户端
4. **世界加载**：生成完成后 `appContext.switchWorld(worldDir)` 加载新世界
5. **客户端启动**：BootScene 预加载资源 → WorldScene 初始化角色和玩家 → 进入可交互状态

整个生成过程通常需要数分钟（取决于 AI 模型响应速度和图像尺寸档位），客户端通过 SSE 实时显示进度。
