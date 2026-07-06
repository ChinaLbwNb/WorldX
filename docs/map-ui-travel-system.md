# 地图系统重构规划：独立地图 + 地图 UI 传送

## 结论

地图扩展不再把多个区域拼成一张越来越大的背景图。新的世界由多张独立本地地图组成，玩家通过地图 UI 选择已存在的地图节点并传送过去。扩展时选择一个已有地图节点，再选择它周围仍为空的方向，生成一张新的独立地图并加入世界地图拓扑。

本方案明确放弃旧“大图拼接世界”的兼容。旧测试世界或已扩展世界只保留最初的原始地图作为 `map_origin`，其他由扩展产生的拼接图、拼接 TMJ、稀疏 chunk 空洞和坐标迁移逻辑都可以删除或忽略。

## 为什么替换拼接大图

旧方案已经暴露出系统性问题：

- 拼接背景图会触碰 WebGL 纹理尺寸、加载时间、显存和小地图下载成本。
- 稀疏十字形扩展最终仍会落到一个包围矩形里，空洞要靠黑图或阻塞格兜底，前端显示和寻路都变复杂。
- west/north 需要移动旧地图坐标，玩家、NPC、事件、资源点、world.json、TMJ 对象都要一起迁移，风险很高。
- 角色大小如果按整张地图尺寸计算，扩图后角色会突然变大或变小。
- 生成模型拿拼接后的大图做参考时，容易复制已有区域，审查模型也难稳定判断“局部扩展是否合格”。
- 正常游戏的地图逻辑更接近“场景切换/区域选择”，不是无限把所有场景压进同一张大图。

因此新目标不是继续修补拼接，而是把“地图扩展”改成“新增可传送地图节点”。

## 产品形态

### 玩家体验

1. 游戏中打开地图 UI。
2. UI 显示当前世界已经存在的地图节点，按东西南北拓扑摆放。
3. 当前所在地图高亮。
4. 点击已存在地图节点，后端记录目标地图，玩家传送到该地图默认出生点或上次离开位置。
5. 点击已有节点旁边的空方向，可以发起扩展生成新地图。
6. 扩展完成后，新地图节点出现在地图 UI 中，玩家可以点击进入。

地图内不显示传送门、边界出口、出口点标记。传送能力集中在地图 UI，避免把生成质量绑定到边缘是否画出入口。

### 地图拓扑

世界地图是一个稀疏网格：

```text
          [map_north_2]
                |
[map_west] - [map_origin] - [map_east]
                |
          [map_south]
```

每张地图是一个完整的小场景，拥有自己的背景图、TMJ、碰撞网格、location、mainAreaPoint、resource/object。地图之间通过地图 UI 传送，不共享像素坐标，也不要求东南西北边界连通。

## 新数据模型

### 全局 world.json

`world.json` 从“单张地图运行配置”升级为“世界总配置 + 当前激活地图”。保留现有角色、资源、时间线等全局字段，新增：

```ts
type WorldMapNode = {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  status: "available" | "generating" | "failed";
  mapDir: string;
  previewImage: string;
  defaultSpawnPointId?: string;
  createdAt: string;
  source?: {
    fromMapId?: string;
    prompt?: string;
    model?: string;
  };
};

type WorldMapLink = {
  fromMapId: string;
  toMapId: string;
  label?: string;
};

type MapSpawnPoint = {
  mapId: string;
  id: string;
  name: string;
  x: number;
  y: number;
  default?: boolean;
};

type WorldConfig = {
  activeMapId: string;
  mapNodes: WorldMapNode[];
  mapLinks: WorldMapLink[];
  mapSpawnPoints: MapSpawnPoint[];
};
```

旧的 `chunks`、`expansionExits`、west/north offset、拼接 TMJ 坐标规则在新架构中废弃。

### 单地图目录

每个地图节点有独立目录：

```text
output/worlds/<worldId>/
  world.json
  maps/
    map_origin/
      metadata.json
      06-background.png
      background-preview.png
      background-tiles/
        manifest.json
        tile-0-0.png
      06-final.tmj
      world-fragment.json
      generation-report.json
```

其中：

- `metadata.json` 记录地图尺寸、tileSize、生成模型、来源方向、预览图路径。
- `06-background.png` 是该地图自己的完整背景，不参与跨地图拼接。
- `background-tiles/` 仍可保留，用于规避单张图过大导致的 WebGL 问题。
- `06-final.tmj` 只描述当前地图内部的碰撞、区域、交互对象。
- `world-fragment.json` 只包含当前地图的 `locations`、`mainAreaPoints`、`resources`、`objects` 等局部语义。
- `generation-report.json` 保存视觉审查、程序化验证和耗时指标。

### 玩家位置

玩家位置从单一 `{ x, y }` 升级为：

```ts
type PlayerAvatarState = {
  mapId: string;
  x: number;
  y: number;
  lastPositionsByMap?: Record<string, { x: number; y: number }>;
};
```

传送规则：

- 如果玩家曾经到过目标地图，优先回到该地图上次位置。
- 否则使用目标地图 `defaultSpawnPointId`。
- 如果默认点不可走，后端用 `findWalkablePixelNear()` 修正到最近可行走点。

NPC 第一版可以只在当前激活地图内模拟和渲染。后续再扩展为多地图后台模拟。

## 后端 API

### 读取地图 UI 状态

```http
GET /api/world/maps
```

返回：

```ts
{
  activeMapId: string;
  maps: WorldMapNode[];
  links: WorldMapLink[];
  currentPlayerMapId: string;
}
```

前端只展示已有地图节点；新地图生成由用户 prompt 触发，不再计算东南西北空位。

### 传送到已有地图

```http
POST /api/world/map/enter
body: { targetMapId: string }
```

返回：

```ts
{
  activeMapId: string;
  targetMapId: string;
  spawn: { x: number; y: number };
  requiresReload: true;
}
```

后端动作：

1. 校验 `targetMapId` 存在且 `status=available`。
2. 保存玩家当前地图离开位置。
3. 计算目标地图出生点。
4. 更新 `player_avatar.mapId/x/y` 和 `world.json.activeMapId`。
5. 调用 `worldManager.loadMap(targetMapId)` 重新加载 TMJ、碰撞、location、resource。
6. 返回 `requiresReload: true`，前端刷新或重启 Phaser 场景。

### 生成新地图节点

```http
POST /api/build/map/expand
body: {
  prompt: string;
}
```

`/api/build/map/expand` 是保留的兼容路径名，实际行为是根据用户提示词生成独立地图节点。新地图通过地图 UI 传送进入；旧 `direction/sourceMapId/exitPointId` 扩展请求不再支持。

生成 job 状态：

```ts
{
  id: string;
  type: "map-node-generate";
  prompt: string;
  targetMapId?: string;
  status: "queued" | "running" | "completed" | "error";
  progress: number;
  phase?: string;
  validation?: {
    passed: boolean;
    issues: string[];
  };
  timings?: Record<string, number>;
}
```

## 生成管线

新管线生成的是独立地图包：

```text
MapNodeContract
  -> standalone map image generation
  -> annotation
  -> collision grid extraction
  -> local semantic validation
  -> write maps/<mapId> package
  -> append mapNodes/spawnPoints
  -> frontend map UI refresh
```

### MapNodeContract

```ts
type MapNodeContract = {
  worldId: string;
  sourceMapId: string;
  targetMapId: string;
  styleReference: {
    sourcePreviewImage: string;
    sourceSummary: string;
    worldTheme: string;
  };
  generation: {
    width: number;
    height: number;
    tileSize: number;
    model: string;
    prompt: string;
  };
  validationRules: {
    minWalkableRatio: number;
    requireDefaultSpawn: boolean;
    requireMainAreaPoint: boolean;
    requireResourceOrObject: boolean;
  };
};
```

这里可以把当前地图作为风格参考，但模型输出必须是一张完整新场景，不需要和边缘无缝拼接，也不需要东南西北方向语义。

### 提示词原则

- 明确这是“同一世界中的独立传送地图”，不是旧图的复制或延长画布。
- 要求保留世界风格、俯视/横切视角、可行走道路密度、建筑尺度。
- 要求生成完整可玩的本地场景，有 1 个默认出生点附近的开阔可走区域。
- 要求包含可被标注的 location、mainAreaPoint、resource/object。
- 不再要求边界条带、seam blending、旧出口对新入口。

### 审查标准

视觉审查改成适合独立地图的评分：

```ts
{
  playableMapScore: number;
  styleConsistencyScore: number;
  topDownGameReadinessScore: number;
  semanticRichnessScore: number;
  annotationReadinessScore: number;
  duplicationRiskScore: number;
  fatalIssues: string[];
}
```

程序化验证必须通过：

- `06-final.tmj` 尺寸与背景图一致。
- 可行走网格比例在阈值内。
- 最大可行走连通分量足够大。
- default spawn 在地图内且可走。
- 每个 mainAreaPoint、resource、object 在地图内。
- resource/object 不落在阻塞格上，或能修正到邻近可走点。
- `world-fragment.json` 中的 location/object id 不与其他地图冲突，建议加 `mapId` 前缀。

视觉审查不再因为“边界衔接不好”判失败，因为新架构没有边界拼接要求。

## 前端改造

### 地图资源加载

`BootScene` 和 `WorldScene` 不再固定加载 `/assets/map/06-background.png` 和 `/assets/map/06-final.tmj`，而是根据后端返回的 `activeMapId` 加载：

```text
/assets/maps/<mapId>/06-final.tmj
/assets/maps/<mapId>/background-tiles/manifest.json
/assets/maps/<mapId>/background-preview.png
```

旧的大图拼接产物不再作为运行时资源保留。已迁移世界只保留 `maps/map_origin/` 中的原始地图节点和后续独立地图节点；根目录 `map/` 属于历史拼接结构，清理后不再通过 `/assets/map/...` 暴露。

地图切换时第一版沿用完整刷新策略，确保 Phaser 纹理、TMJ、碰撞、资源点全部重新初始化。后续再做无刷新场景切换。

### 地图 UI

新增 `WorldMapPanel`：

- 以网格或节点图展示 `mapNodes`。
- 当前地图高亮。
- `available` 地图可点击传送。
- `generating` 地图显示进度，不可传送。
- 提供新地图描述输入框，点击后调用 `generateMapNode({ prompt })`。
- 每个节点显示地图名、缩略图和状态。

`BuildPanel` 里的旧四方向扩图按钮下线，地图生成入口改为 prompt 输入。资源成本、生成进度和错误提示仍复用 BuildPanel 的 job 展示能力。

### 小地图

小地图只展示当前本地地图，不再试图展示整个世界拓扑。世界拓扑由 `WorldMapPanel` 负责。

## 后端运行时改造

### WorldManager

新增核心能力：

```ts
loadMap(mapId: string): Promise<void>
getActiveMapId(): string
getMapAssets(mapId: string): MapAssetPaths
getLocations(mapId?: string): Location[]
getMainAreaPoints(mapId?: string): MainAreaPoint[]
getResourceNodes(mapId?: string): ResourceNode[]
```

`worldSize`、`collisionGrid`、`locations`、`resourceNodes` 都变成“当前 active map 的运行时缓存”。

### ResourceManager

资源发现只扫描当前地图的 `world-fragment.json` 和 TMJ，不跨地图混合。传送后执行：

```ts
resourceManager.rediscoverForMap(activeMapId)
```

### PlayerManager

在线玩家状态必须带 `mapId`。客户端只渲染同一 `mapId` 的玩家和 NPC。这样可以避免“其他地图玩家堆在右上角”或 fallback 图形污染当前场景。

### Simulation

第一版策略：

- 当前 active map 的角色正常模拟、感知和移动。
- 不在当前地图的角色暂停精细寻路，只保留状态。
- 角色跨地图移动暂不自动发生，后续用剧情事件或任务系统驱动。

这比试图一次性做多地图后台模拟更稳。

## 清理和迁移策略

用户已确认旧大图世界不用兼容，因此实现时按以下策略处理：

1. 找到当前世界的原始地图资产，作为 `maps/map_origin/`。
2. 如果当前世界只有被拼接后的 `06-background.png`，优先从备份或生成历史中恢复原图。
3. 原图确认后，删除或归档以下旧扩展产物：
   - 拼接后的 `06-background.png`
   - 拼接后的 `06-final.tmj`
   - `background-tiles/` 中基于拼接大图生成的瓦片
   - `chunks`
   - `expansionExits`
   - `expansion-contract.json`
   - 拼接扩展临时目录和中间图
4. 初始化 `mapNodes=[map_origin]`、`activeMapId=map_origin`、空 `mapLinks`。
5. 玩家和 NPC 放回 `map_origin` 默认出生点或原图内最近可走点。

删除动作必须在实施阶段显式备份后执行：

```text
backups/
  before-map-ui-travel-<timestamp>/
```

即使不兼容旧大图，也不直接无备份删除用户资产。

## 分阶段实施计划

### Phase 0：冻结旧拼接扩图入口

- 移除旧 chunk 拼接扩图设计文档入口，避免继续按废弃方案实现。
- 后端 `POST /api/build/map/expand` 保留为兼容路径，但实现改为独立地图节点生成。
- 明确 README 中新方案是当前实施方向。

验收：

- 前端不再诱导用户触发旧拼接扩图。
- 文档入口不会让开发者继续按旧 chunk 拼接方案实现。

### Phase 1：数据结构和原图归档

- 新增 `mapNodes`、`activeMapId`、`mapLinks`、`mapSpawnPoints` 类型。
- 实现一次性初始化脚本：把当前原图迁移到 `maps/map_origin/`。
- 清理旧扩展图的计划先 dry-run，打印将删除/归档的文件。
- 生成 `map_origin/metadata.json` 和 `map_origin/world-fragment.json`。

验收：

- `world.json` 可以表达单地图世界。
- 服务端可以从 `map_origin` 加载背景、TMJ、碰撞、location、resource。
- dry-run 能列出旧拼接产物，不误删原图。

### Phase 2：按 activeMapId 加载地图

- `WorldManager.loadMap(mapId)` 替代固定路径加载。
- 静态资源路由支持 `/assets/maps/<mapId>/...`。
- `BootScene`、`WorldScene`、`MapControls` 改成按 active map 加载。
- 角色缩放以当前地图原始尺寸为基准，不受世界拓扑影响。

验收：

- 启动游戏后能正常显示 `map_origin`。
- 小地图、碰撞、点击移动、资源采集都正常。
- 没有绿色底、空背景、全员右上角 fallback。

### Phase 3：地图 UI 传送

- 新增 `GET /api/world/maps`。
- 新增 `POST /api/world/map/enter`。
- 新增前端 `WorldMapPanel`。
- 玩家状态和 websocket payload 带 `mapId`。
- 客户端只显示同地图实体。

验收：

- 至少两个手工准备的地图节点之间可以切换。
- 切换后 Phaser 场景刷新，背景、碰撞、资源点全部变成目标地图。
- 玩家位置在目标地图可走区域内。

### Phase 4：独立地图生成扩展

- 新增 `MapNodeContract`。
- 新增或改造扩展脚本，让它输出 `maps/<targetMapId>/`，不拼接旧图。
- 生成完成后只追加 `mapNodes`、`mapLinks`、`mapSpawnPoints`。
- 扩展方向只影响地图拓扑和 prompt 语义。
- 视觉审查改为独立地图评分。
- 程序化验证失败时删除新地图临时目录，不污染 `world.json`。

验收：

- 输入不同用户 prompt，连续生成多个独立地图节点。
- 新节点可从地图 UI 点击传送进入。
- 每次生成的图片尺寸恒定，不依赖已有地图数量。
- `world.json` 不出现拼接坐标迁移字段。

### Phase 5：清理旧拼接逻辑

- 已删除 `chunks`、`expansionExits` UI；运行时不再返回 `expansionExits` 给前端。
- 已删除 west/north 旧坐标迁移逻辑。
- 已删除拼接 TMJ/background 的写入路径。
- 保留基础地图生成和单地图标注管线。
- 已更新 `docs/architecture.md` 和 `docs/generation-pipeline.md`，把“地图扩展”收口为“地图节点生成”。

验收：

- 代码里没有仍会覆盖全局 `06-background.png` 拼接大图的在线扩展路径。
- 文档和 README 只把旧方案作为废弃背景，不作为当前路线。

## 测试计划

### 静态检查

- `npx.cmd tsc -p server/tsconfig.json --noEmit`
- `npx.cmd tsc -p client/tsconfig.json --noEmit`
- `node --check` 检查新增或修改的 `.mjs` 脚本。
- README 和 docs 链接存在。
- 所有新增/修改文本文件 UTF-8 可读写。

### API 测试

- `GET /api/world/maps` 返回地图节点和 activeMapId。
- `POST /api/world/map/enter { userCharacterId, mapId }` 能切换该用户角色到已有地图。
- `POST /api/build/map/expand { prompt }` 创建独立地图生成 job。
- job 失败不会修改 `world.json`。
- job 成功后 `mapNodes` 多一个节点，`mapSpawnPoints` 多一个出生点。

### 浏览器模拟用户测试

- 启动服务，打开游戏。
- 看到 `map_origin` 正常渲染。
- 打开地图 UI。
- 点击已有地图节点，确认跳转后背景和小地图都换成目标地图。
- 玩家能点击移动，NPC 不堆叠在右上角。
- 资源点能采集，BuildPanel 资源数更新。
- 从地图 UI 触发新地图生成，等待 job 完成。
- 新节点出现后点击进入，确认新地图可玩。

### 生成速度数据

每次生成记录：

- `contractMs`
- `imageGenerationMs`
- `annotationMs`
- `collisionExtractionMs`
- `visionReviewMs`
- `programmaticValidationMs`
- `writePackageMs`
- `totalMs`
- 使用模型名和输入图片数量。

独立地图方案预计比拼接方案更容易稳定提速，因为不需要：

- 读取越来越大的拼接图。
- 生成边界条带工作画布。
- seam blending。
- 全图 TMJ 合并。
- west/north DB 坐标迁移。
- 大背景重新切片所有瓦片。

## 风险和取舍

- 地图 UI 传送牺牲了“从边缘自然走到隔壁地图”的连续感，但换来更稳定的生成、加载和运行时状态。
- 多地图后台模拟可以后置，第一版只保证当前地图体验稳定。
- 旧拼接测试世界不兼容会减少迁移负担，但必须保留备份，避免误删用户原始资产。
- 如果某些玩法确实需要地图内入口，后续可以把入口做成普通交互点，但不作为地图扩展生成的必要条件。

## 当前决策

- 当前实施方向：独立地图节点 + 地图 UI 传送。
- 地图内不显示传送门或出口点。
- 旧大图拼接世界不做兼容。
- 只保留原始地图作为 `map_origin`。
- 每次扩展只生成一张恒定尺寸的新地图。
- 前端切图第一版使用完整刷新，优先保证正确性。

## 当前实现状态

第一版运行时骨架和真实独立地图生成链路已经落地：

- 旧世界启动时会自动把当前 `map/` 复制为 `maps/map_origin/`。
- `GET /api/world/maps` 返回世界地图节点和当前 active map。
- `POST /api/world/map/enter` 可以把指定用户角色切到已有节点，并要求前端刷新。
- 在线 `POST /api/build/map/expand` 已停止调用旧拼接大图脚本，改为根据用户 prompt 创建独立地图节点包并追加 `mapNodes/mapSpawnPoints`。
- `BootScene`、小地图和静态资源路由已支持 `/assets/maps/<mapId>/...`。
- `MapExpander` 调用 `generators/map/src/generate-map-node.mjs` 生成真实独立地图包，不再复制源地图。
- 地图节点生成会先写入 `<targetDir>.tmp-*`，视觉审查和程序化验证通过后才 rename 到正式目录。
- Step 1 视觉审查在地图节点生成中是硬门槛；审查最终失败会中止 job 并清理临时目录。
- 生成包包含 `map-node-contract.json`、`metadata.json`、`world-fragment.json`、`generation-report.json`、`06-background.png`、`06-final.tmj` 和 `background-tiles/`。
- `world-fragment.json` 负责提供新地图局部 `locations`、`mainAreaPoints` 和资源 object；传送出生点使用生成包内最近可走点。

当前测试数据：

- 旧方向版临时脚本直跑：`map_origin -> north`，总耗时约 132 秒，Step 1 第 2 次通过，walkable ratio 37.9%，validation 通过。
- Prompt-only 版本需重新记录生成速度和通过率数据。

仍需继续优化：

- Step 1 视觉审查仍可能因视角或建筑入口失败，需要继续收敛 prompt 和评分标准，降低重试次数。
- 生成耗时目前主要由 Step 1 多轮生图和视觉审查决定，后续可以继续对比 `MaaS_Ge_3_pro_image_20260528`、`MaaS_Ge_2.5_flash_image_20251002` 等生图模型。
- 浏览器自动化中 Playwright locator click 对当前 Phaser 页面偶发超时，坐标点击可完成测试；这更像测试工具交互问题，不是用户界面阻断。
