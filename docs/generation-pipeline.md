# WorldX 地图生成管线技术文档

## 概述

WorldX 的地图生成管线是一个多阶段、多模型协作的自动化流程，从一段自然语言描述出发，最终产出一张可交互的游戏地图——包含背景图、碰撞网格、功能区域标注、可交互元素标注和可行走区域数据。整个管线由 6 个步骤组成，其中 3 个标注步骤并行执行以缩短总耗时。

管线的核心设计理念是**自反馈循环**：每个关键步骤都包含"生成 → 多模态审查 → 失败则调整提示词重试"的闭环，通过多轮迭代保证输出质量。

```
用户提示词 + 世界设计
        │
   Step 1: 文生图（含多模态审查自反馈）
        │
   Step 2: 图像压缩
        │
   ┌────┼────┐
   │    │    │     ← 三步并行
 Step3  3.2  4
   │    │    │
   └────┼────┘
        │
   Step 5: 可行走网格计算（CV算法）
        │
   Step 6: TMJ构建 + 背景图重采样 + 输出
```

## AI 模型分工

管线使用三个不同定位的 AI 模型，各司其职：

| 模型 | 定位 | 调用方式 | 用于哪些步骤 |
|------|------|----------|-------------|
| MaaS_Ge_2.5_flash_image_20251002 | 图像生成/编辑 | 文生图 / 图生图 | Step 1 地图生成、Step 3/3.2 彩色叠加、Step 4 可行走标注、扩展 Step 2 区域生成 |
| gemini-3.1-pro-preview | 多模态视觉审查 | 文本+图像输入 | Step 1 审查、Step 3/3.2 区域确认、Step 4 审查、扩展 Step 2 审查 |
| gemini-2.5-pro-preview | 推理/设计 | 纯文本对话 | Step 1 提示词调整、扩展 Step 1 新区域设计 |

图像生成模型通过 OpenRouter API 调用，支持文生图（`generateImage`）和图生图（`editImage`）两种模式。视觉审查模型接收文本提示词和一张或多张图片（转为 base64 data URL），返回结构化 JSON 判断。推理模型用于需要逻辑推理的任务，如将审查反馈整理为可执行的提示词约束、设计新区域的内容规划。

所有模型调用都经过 `withRetry` 包装，最多 2 次连续失败重试。推理模型还具备**结构化输出能力降级机制**：优先尝试 `response_format: { type: "json_object" }`，若遇到不支持错误则自动缓存降级为纯提示词模式，后续调用直接走降级路径。

## Step 1：地图生成

入口函数 `generateMap(userPrompt, worldDesign, save, { originalUserPrompt })`。

### 自反馈循环

Step 1 的核心是一个最多 4 轮（`MAX_RETRIES + 1`）的生成-审查循环：

1. **加载提示词**：`loadPrompt("step1-map-generation.md", ...)` 装载模板，填入世界设计摘要（区域规划、元素规划、地图计划、全局动作）。首轮无额外约束，后续轮次会累积上轮审查反馈。

2. **文生图**：调用 `generateImage(prompt, { aspectRatio: "16:9", imageSize: MAP_IMAGE_SIZE })`。图像尺寸由 `MAP_IMAGE_SIZE_K` 环境变量控制（支持 1K/2K/4K 三档），4K 模式下生成约 4096×2304 的地图。

3. **缩小审查**：用 `resizeImage(mapBuffer, 1024)` 将生成图缩小到 1024px 宽度，送入 `geminiProVisionJSON` 做视觉审查。审查提示词要求检查 16 项：俯视角度、建筑横切状态、入口缺口形态、道路连通性、无人物/文字、IP 忠实度等。

4. **通过判断**：`review.pass` 为 true 则返回；否则进入调整流程。

5. **提示词调整**：调用推理模型 `chat()` 将审查返回的 `promptAdjustments`（英文列表）整理为中文约束文本，累积拼接到 `additionalConstraints` 变量中，供下一轮生成使用。

### 提示词约束要点

Step 1 的生成提示词包含 17 条硬约束，关键包括：

- 接近 90 度正俯视视角，不允许透视或等距视角
- 可进入建筑必须是横切状态（无屋顶，能看到室内布局），入口是墙壁上的 `||` 型缺口（无门、无门框）
- 景观建筑可保留完整屋顶
- 道路必须连通且不被遮挡
- 绝对不能出现人物或文字
- 建筑之间有道路连接，功能区分布合理

## Step 2：图像压缩

入口函数 `compressMap(originalBuffer)`。

压缩步骤不改分辨率，只优化文件体积以减少后续标注步骤的 token 消耗。生成三个候选变体：

1. **原始 PNG**：直接使用输入
2. **无损 PNG 重压缩**：`compressionLevel: 9, effort: 10, adaptiveFiltering: true`
3. **低损调色板 PNG**：`palette: true, quality: 95, colors: 256, dither: 0.25`

三个候选按字节数升序排序，选最小的作为输出。对于游戏地图这类色块分明、细节相对简单的图像，调色板模式通常能取得最佳压缩率。

## Step 3：功能区域标注

入口函数 `resolveDesignedRegions(compressedBuffer, worldDesign, userPrompt, save)`。

### 三阶段循环

Step 3 同样采用自反馈循环（默认 2 轮重试），每轮包含三个阶段：

**Phase A — 批量彩色叠加**：将 `worldDesign.regions` 中待定位的区域分批（每批最多 4 个），每批调用 `editImage()` 让图像生成模型在压缩地图上画轴对齐矩形。每个区域分配一种颜色（青/品红/黄/蓝四色循环），矩形要求 4px 边框 + 55-70% 半透明填充。生成后调用 `extractRegionBoxesFromMarkedImage()` 通过图像 diff 提取每个颜色对应的边界框。

**Phase B — 画标注图**：用 `drawBoundingBoxes()` 在原图上叠加品红色矩形框和区域 id 标签，生成一张人类和模型都能看懂的标注可视化图。

**Phase C — 多模态确认**：将原始压缩图和标注图一起送入 `geminiProVision`，让模型判断哪些区域的标注存在问题（完全偏离、严重偏大、覆盖其他区域、id 不匹配）。模型返回 `problematic_region_ids` 和反馈文本。问题区域的坐标被清除，重新标记为 pending 进入下一轮；反馈文本累积为下一轮的约束。

### 颜色叠加提取算法

`extractRegionBoxesFromMarkedImage` 是 Step 3 的核心算法，工作原理：

1. **block 自适应**：根据图像宽度选择 block 大小（≤1500px→4, ≤3000px→6, 否则 8）
2. **逐 block 比较**：将原图和标注图按 block 网格对齐，计算每个 block 内的平均 RGB 差值
3. **颜色评分**：对有显著差异的 block，用 `scoreColorOverlay()` 基于-alpha 混合模型评分。该函数模拟半透明叠加过程：计算原始色到目标色的向量，估算 alpha 值（0.08≤alpha≤1.2 为有效），再计算重建误差。评分 = `alpha×90 + closenessGain×0.25 - reconstructionError×0.6`
4. **连通域分析**：对同一颜色的 block 用栈式 4 邻接 floodFill 求连通域，取面积≥最大域面积 15% 的域求并集边界框
5. **边界裁剪**：`TRIM_THRESHOLD=0.35` 裁掉稀疏边缘行/列，`INSET_RATIO=0.03` 向中心内缩 3%，消除叠加溢出

### 坐标缩放

`scaleRegions(regions, origWidth, compressedWidth)` 将区域坐标从压缩图分辨率缩放回原始生成图分辨率，比例因子 = `origWidth / compressedWidth`。

## Step 3.2：可交互元素标注

入口函数 `locateElements(compressedBuffer, worldDesign, userPrompt, save)`。

逻辑与 Step 3 几乎完全镜像，区别在于：

- 数据源是 `worldDesign.interactiveElements` 而非 `regions`
- 框颜色使用青色 `rgba(0,200,200,0.95)`（Step 3 用品红）
- 确认提示词更宽松：有明显重叠即通过，不确定的判通过
- 可忽略无法在图中找到对应位置的元素

## Step 4：可行走区域标注

入口函数 `generateWalkableMap(compressedMapBuffer, userPrompt, worldDesign, save)`。

### 标注方式

调用 `editImage(prompt, compressedMapBuffer, { imageSize: "1K" })` 让图像生成模型在可行走区域叠加纯青色 RGB(0, 255, 255)，不透明度 70-80%。提示词要求：

- 主路必须连通
- 功能区内部可达
- 打通狭窄门框（1 格宽走廊要标记为可行走）
- 禁止穿墙
- 停车场、花坛等非行走区域不标

### 审查循环

与 Step 1 类似的自反馈循环，审查时将原图和标注图双图对比送入 `geminiProVisionJSON`。审查优先检查主路连通性和功能区可达性，小瑕疵可接受。失败时直接将 `promptAdjustments` 拼接到 `additionalInstructions`（不经推理模型整理），进入下一轮重试。

## Step 5：可行走网格计算

入口函数 `computeGrid(originalBuffer, markedBuffer, origWidth)`。

这是整个管线中最关键的 CV（计算机视觉）步骤，将像素级的可行走标注转化为瓦片级的碰撞网格。

### 计算流程

1. **确定 tile 大小**：`BLOCK_SIZE = getTileSize()`，与图像尺寸档位线性相关（4K→16px, 2K→8px, 1K→4px）

2. **对齐分辨率**：将原始地图图上采样到标注图的尺寸（`fit: "fill"`），确保两图像素一一对应。这一步绝不缩小标注图，因为缩小会稀释青色信号导致检测率下降。

3. **缩放计算**：`scale = markWidth / origWidth`，`actualBlockSize = round(tileSizeAtSource × scale)`

4. **逐块比较**：每个 block 内逐像素累加 RGB 值，计算原图与标注图的 delta。对每个像素检测青色特征：
   - 强青像素：`deltaG ≥ 18 && deltaB ≥ 18 && deltaR ≤ 8`
   - 弱青像素：`deltaG ≥ 10 && deltaB ≥ 10 && deltaR ≤ 14`

5. **可行走判定**：block 内强青覆盖率 ≥ 22%，或弱青覆盖率 ≥ 38% 且整体青色偏移 ≥ 8，则判定为可行走（grid 值 = 0），否则为阻塞（grid 值 = 1）

6. **细走廊救援**：被判定为阻塞的格，若其水平或垂直两端都是可行走格，且有中等青色证据（强青覆盖率 ≥ 8%），则保留为可行走。这防止 1 格宽的走廊因信号不足被侵蚀

### 网格清理

`cleanupGrid(rawGrid)` 做形态学清理：仅移除"4 邻接全是阻塞"的孤立可行走格（单格噪声），不填充阻塞间隙。这保证门框、走廊等狭窄通道不被误清。

## Step 6：输出构建

入口函数 `buildOutput({ grid, gridWidth, gridHeight, tileSize, regions, elements, backgroundImage })`。

### 坐标转换

在 `index.mjs` 中，Step 3/3.2 输出的区域/元素坐标已经通过 `fromCompressedToWorld` 从压缩图分辨率缩放到原始生成图分辨率。

### 背景图重采样

用 sharp 将原始生成图 resize 到 `gridWidth × tileSize` × `gridHeight × tileSize`（精确 tile 对齐），作为最终背景图 `06-background.png`。

### TMJ 构建

`buildTMJ()` 生成 Tiled 兼容的 JSON 文件 `06-final.tmj`，包含 4 个图层：

| 图层 | 类型 | 内容 |
|------|------|------|
| background | imagelayer | 指向 `06-background.png`，记录 imagewidth/imageheight |
| collision | tilelayer | 一维数组（行优先），0=可行走，1=阻塞 |
| regions | objectgroup | 每个功能区域含 properties: id, description, regionType, actions, adjacentRegions |
| interactive_objects | objectgroup | 每个可交互元素含 properties: objectId, interactions |

## 独立地图节点生成管线

当前在线地图扩展使用 `generators/map/src/generate-map-node.mjs`，目标是生成一个可单独加载的地图节点目录，而不是把新图拼接到原背景上。

CLI 用法：

```bash
node generators/map/src/generate-map-node.mjs \
  --worldDir <worldDir> \
  --sourceMapId <mapId> \
  --targetMapId <targetMapId> \
  --targetDir <worldDir>/maps/<targetMapId> \
  --prompt <new-map-description>
```

生成流程：

1. 读取 `world.json`、当前 active map 信息和用户新地图描述，构造 `map-node-contract.json`。
2. 根据世界主题、源地图名和用户 prompt 生成独立地图 prompt。prompt 明确禁止画面内出现文字、标题、标签、箭头、UI、水印、地图名、区域名或出生点标记。
3. 构造局部 `worldDesign`，使用自然地点名和物件名提供区域、道路和资源点语义，避免把“默认出生点”“地图地标”这类 UI 词送进画面。
4. 调用通用 `runMapPipeline()` 完成 Step 1-6：生图、压缩、区域标注、元素标注、可行走标注、网格计算和 TMJ 输出。
5. 地图节点生成启用 `requireStep1Review: true`，Step 1 视觉审查最终失败会直接中止，不再带着不合格背景继续生成 TMJ。
6. 基于 `06-final.tmj` 构造 `world-fragment.json`，包含该地图局部 `locations`、`mainAreaPoints` 和资源 object。
7. 运行程序化验证：地图资产存在、TMJ 尺寸合法、collision layer 完整、可行走比例合理、出生点落在可走格、局部语义不为空。
8. 验证通过后将 `<targetDir>.tmp-*` rename 为正式目录；验证失败或脚本异常时清理临时目录。

后端 `MapExpander` 在脚本成功后只追加 `mapNodes` 和 `mapSpawnPoints`。用户 prompt 决定新地图主题；当前 active map 只作为风格和世界观参考，不再触发方向拓扑、背景拼接、碰撞合并或 west/north 坐标迁移。当前运行时数据合同只使用 `mapNodes`。

近期测试数据：

- 旧方向版脚本直跑 `map_origin -> north`：总耗时约 132 秒，Step 1 第 2 次通过，validation 通过。
- 旧方向版 API 全链路 `map_origin -> north`：总耗时约 134 秒，Step 1 第 3 次通过，validation 通过，生成的 `06-final.tmj` 可通过 `/assets/maps/<mapId>/06-final.tmj` 访问。

## NPC 与用户角色 spritesheet 生成管线

`generators/character/` 提供的是底层 spritesheet 生成能力，而不是某一种业务实体。当前有两条业务入口复用它：

- **账号用户角色生成**：入口在“我的角色”面板，API 走 `/api/user-characters`。生成出的 spritesheet 写入账号级资产目录 `output/account-assets/user-characters/<userCharacterId>/`，并记录到账号用户角色表。它会进入“我的角色”列表，可由用户切换和操控。
- **世界 NPC 生成**：入口在建造面板“生成 NPC”，API 走 `/api/build/character`。生成出的 spritesheet 写入当前世界的 `characters/<npcId>/`，配置写入 `config/characters/<npcId>.json`，并加入世界 NPC/Simulation 系统。它不写账号用户角色表，也不会进入“我的角色”列表。

这两条入口可以共用图像模型、参考模板、背景裁切和 metadata 解析，但不能共用数据归属、权限判断或前端列表展示。

## 旧拼接地图扩展管线（已移除）

旧的拼接扩图实现已经从源码中移除。当前线上扩图只保留“独立地图节点生成”路径：

- 后端入口仍是 `/api/build/map/expand`，但语义是 `prompt -> new map node`。
- 生成脚本是 `generators/map/src/generate-map-node.mjs`。
- 世界数据只写入 `mapNodes` 和 `mapSpawnPoints`。
- 不再生成或维护 `chunks`、`expansionExits`、拼接背景图、合并 TMJ、west/north 坐标迁移或出口点合同。

旧测试世界若仍含根目录 `map/`、`chunks` 或 `expansionExits`，应先迁移到 `maps/map_origin/` 后再进入运行时。

## 配置参数

### 图像尺寸与 Tile 大小

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| 图像尺寸档位 | `MAP_IMAGE_SIZE_K` | 1 | 支持 1/2/4，决定生成图分辨率 |
| Tile 像素大小 | `BLOCK_SIZE` | (K/4)×16 | 4K→16px, 2K→8px, 1K→4px |

### 超时与重试

| 参数 | 环境变量 | 默认值 |
|------|---------|--------|
| Step 1 生成超时 | `STEP1_GENERATE_TIMEOUT_MS` | 180000 |
| Step 1 审查超时 | `STEP1_REVIEW_TIMEOUT_MS` | 90000 |
| Step 1 重试次数 | `STEP1_MAX_RETRIES` | 3 |
| Step 3 叠加超时 | `STEP3_OVERLAY_TIMEOUT_MS` | 240000 |
| Step 3 重试次数 | `STEP3_MAX_RETRIES` | 2 |
| Step 4 重试次数 | `STEP4_MAX_RETRIES` | 3 |
| 扩展生成超时 | `EXPAND_GENERATE_TIMEOUT_MS` | 240000 |
| 扩展审查超时 | `EXPAND_REVIEW_TIMEOUT_MS` | 120000 |
| 扩展重试次数 | `EXPAND_MAX_RETRIES` | 3 |

### 模型配置

| 模型 | 环境变量前缀 | 默认模型 |
|------|-------------|---------|
| 图像生成 | `IMAGE_GEN_*` | MaaS_Ge_2.5_flash_image_20251002 |
| 视觉审查 | `VISION_*` | google/gemini-3.1-pro-preview |
| 推理设计 | `ORCHESTRATOR_*` | google/gemini-2.5-pro-preview |

每个前缀支持 `*_BASE_URL`、`*_API_KEY`、`*_MODEL` 三个环境变量。

## 数据流总结

```
userPrompt + worldDesign.json
        │
        ▼
[Step 1] generateImage ──→ originalMap (Buffer)
        │   ↑ geminiProVision 审查自反馈
        ▼
[Step 2] compressMap ──→ compressedMap (更小 Buffer, 同分辨率)
        │
        ├─→ [Step 3]   editImage(彩色叠加) → extractBoxes(diff) → confirm(geminiPro) → regions[]
        ├─→ [Step 3.2] editImage(彩色叠加) → extractBoxes(diff) → confirm(geminiPro) → elements[]
        └─→ [Step 4]   editImage(青色标注) → review(geminiPro) → walkableMap (Buffer)
                                                    │
                                                    ▼
              [Step 5] computeWalkableGrid(originalMap, walkableMap) → grid[][]
                                                    │
                                                    ▼
              [Step 6] scaleCoords(regions/elements) + sharp.resize(originalMap → bgSize)
                      → buildTMJ() → 06-final.tmj + 06-background.png
```

核心数据契约：所有坐标先在压缩图分辨率下确定，最后统一通过 `origWidth / compressedWidth` 比例缩放到世界坐标；碰撞网格通过青色像素 diff 逐 block 检测生成；扩展管线在拼接时通过 smoothstep 融合消除接缝，通过网格偏移合并碰撞数据。
