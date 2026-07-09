# WorldX-Map

基于生成式覆盖定位的自然语言世界规格到可执行二维游戏地图编译方法

*Compiling Natural-Language World Specifications into Executable 2D Game Maps via Generative Overlay Grounding*

> 文档状态 论文初稿 v0.2。Problem Formulation、Method 与 Experimental Setup 已按当前仓库实现成稿；Results 保持空白。正式投稿前需完成系统文献检索、双标注员金标与冻结测试集实验。

## 摘要

生成式视觉模型能够根据开放自然语言描述产生内容丰富的二维游戏地图，但输出通常仍是栅格图像。游戏运行时需要可行走/碰撞网格、功能区域、交互对象及其空间坐标。直接从风格多变的生成图中恢复这些结构并不稳定：目标类别开放，区域边界常由功能语义而非固定视觉类别决定，小型对象的像素坐标又容易受到尺度影响。

本文提出 WorldX-Map，一套从自然语言世界描述到可执行二维地图表示的任务特定训练-free 管线。系统先将用户描述转换为结构化世界规格，并将地图计划、功能区域与交互对象作为条件注入视觉合成。针对生成图中的区域与对象定位，本文提出 Generative Overlay Grounding（GOG）：图像编辑模型不直接预测坐标，而是按目标语义在原图上生成颜色编码覆盖层；随后使用确定性图像差分、颜色方向判别、连通域恢复与边界裁剪得到空间框。对于角色可通行空间，系统采用功能语义驱动的 cyan overlay，并将覆盖证据转换为离散网格，保留窄通道并移除孤立噪声。最终结果被编译为 Tiled-compatible TMJ，其中包含背景层、碰撞层、语义区域与交互对象。

本文以四个研究问题组织证据链：结构化世界规格是否改善功能遵循；GOG 是否优于直接坐标预测；恢复出的可行走结构是否支持下游导航；verification-guided repair 的质量收益与计算成本如何变化。RQ2 pilot 协议已在真实模型调用前冻结。当前初稿不报告未完成实验的方向性结论。

关键词：procedural content generation；game map generation；visual grounding；image editing；multimodal models；traversability；executable map

## 1. 引言

语言驱动的环境生成正在快速越过“单一素材生成”。Holodeck [2] 使用语言模型规划 3D 场景及空间关系；Scenethesis [9] 将语言规划与视觉引导的布局细化结合；WorldGen [6] 直接面向可遍历、可交互且可在标准游戏引擎中编辑的 3D 世界；SceneFoundry [11] 进一步强调带功能关节对象与可行走空间的交互式场景；Word2Minecraft [14] 则从结构化故事生成可玩的 Minecraft 关卡。由此，本文不把“自然语言生成世界”本身当作主要创新。更具体的问题是：当开放式视觉生成已经产出一张地图图像后，怎样把它变成游戏运行可消费的结构。

一张视觉上合理的俯视地图并不自动等于可执行地图。角色移动需要离散的 walkability/collision grid；剧情与行为调度需要功能区域；交互系统需要对象位置与交互属性。传统 tile-based PCG 可以直接在离散表示上生成内容，但开放式图像生成没有固定 tile vocabulary。用户可能要求北宋夜市、现代便利店、火星科研站或悬疑古寺。相同的“可进入区域”在不同风格下没有统一像素模板，生成图中的目标甚至可能缺失。本文因此把 synthesis fidelity、spatial grounding 与 executability 分开评价。

最直接的结构恢复方案是让视觉语言模型读取地图并返回 bounding boxes。然而，grounding 仍是多模态系统的独立瓶颈。SeeAct [7] 显示，高层视觉理解与计划能力并不自动转化为可靠的低层 grounding；VGent [12] 甚至显式把高层推理与 bbox 预测拆成模块。对风格化生成地图，这个问题更难：类别开放，小目标缺少检测器先验，功能区域边界又不一定对应标准物体类别。单次自回归坐标输出把语义识别、空间估计和坐标序列化压在同一生成步骤里，错误来源难以分离。

视觉提示提供了另一条路线。Set-of-Mark（SoM）[1] 先借助现成分割模型得到区域，再叠加 marks 供多模态模型引用；Image Difference Grounding [8] 研究根据语言在成对图像中定位真实变化；InterCoG [10] 则先进行 grounding，再用 grounding 结果提高复杂场景中的图像编辑精度。WorldX-Map 采用相反的数据流：让图像编辑模型根据目标语义主动产生指定颜色的覆盖层，再把这次受控编辑当作可计算信号，通过原图/编辑图差分恢复几何结构。也就是 editing → grounding，而非 grounding → editing。

这一设计来自一个具体工程观察：对于开放语义目标，生成式编辑模型可以把“我认为目标在哪里”外显为颜色覆盖；颜色覆盖又能被确定性算法解释。原图与编辑图的 block-level 差分提供变化证据，目标颜色方向约束降低背景编辑噪声，连通域把局部证据恢复成区域。生成模型负责开放语义理解，确定性算子负责机器结构提取。两部分边界清楚，也允许单独消融。

WorldX-Map 将 GOG 嵌入完整编译管线。用户描述先被规划为结构化世界规格；视觉生成阶段显式接收 map plan、regions 与 interactive elements；区域、对象和可行走空间从同一张冻结地图中恢复；最终输出 Tiled-compatible TMJ，而非只保存 PNG。本文的贡献设计为三项：GOG 作为主方法；从结构化世界规格到可执行地图表示的编译框架；面向角色移动语义的 functional traversability recovery。Iterative repair 不作为独立首创，只作为可靠性机制和成本—质量研究对象。

## 2. 相关工作

### 2.1 语言驱动的环境与世界生成

语言驱动环境生成已覆盖 3D 场景规划、资产放置、空间约束和可探索世界。Holodeck [2] 通过 LLM 产生空间关系约束并优化布局；Scenethesis [9] 把语言规划与视觉引导的结构提取、布局细化结合；WorldGen [6] 直接从文本生成可遍历、可交互且可在标准游戏引擎中编辑的 3D 世界；SceneFoundry [11] 面向具有功能关节对象和导航空间的交互式场景；Word2Minecraft [14] 从结构化故事生成带空间和玩法约束的关卡。这些工作把 novelty baseline 推高到“功能世界”。WorldX-Map 不主张 text-to-world 本身新，而研究开放二维生成图之后的结构恢复与可执行编译。

### 2.2 视觉 Grounding 与视觉提示

视觉 grounding 要根据语言表达定位图像区域。SoM [1] 使用现成 segmentation 模型先划分图像，再叠加 alphanumeric marks、masks 或 boxes，帮助大型多模态模型引用区域。SeeAct [7] 在网页代理中进一步表明，强视觉理解并不自动解决 grounding；VGent [12] 通过模块化设计拆开高层推理和低层 bbox 预测；Thinking with Visual Grounding [13] 则把点/框 grounding 直接嵌入视觉推理过程。WorldX-Map 与这些工作共享“显式空间证据”动机，但不依赖预先分割的候选区域，也不训练新的 bbox decoder。

### 2.3 图像差分与 Grounding-aware Editing

Image Difference Grounding [8] 根据自然语言在成对图像中定位变化，说明“差分 + 语言”本身已经是明确研究方向。但它处理的是输入图像之间真实存在的变化，并训练专门模型定位差异。InterCoG [10] 面向复杂多实体场景中的精确图像编辑，先进行位置推理和视觉 grounding，再用 boxes/masks 约束编辑。GOG 与二者都不同：差分不是外部事件，而是系统主动生成的受控颜色编辑；编辑输出不是最终任务，而是中间测量介质；最终几何由确定性算法恢复。

### 2.4 迭代反馈与修正

Self-Refine [3] 等工作已经系统研究生成—反馈—再生成。WorldX-Map 的地图合成、区域/元素定位和 walkability 标注均包含 review 或 selective retry，但本文不把 repair loop 作为主要创新。实验上使用 same-run Attempt 1 vs Final 的配对设计，并把 reviewer outage、缺陷修复率、新缺陷引入率、调用次数、延迟和成本分开记录。

### 2.5 PCG 评价

PCG 评价不存在单一通用指标。近期 level-generation evaluation 工作 [4] 与 PCG Benchmark [5] 强调按任务区分质量、可控性、多样性及问题特定指标。对 WorldX-Map，只报告图像偏好或 reviewer pass rate 不能支撑“可执行”主张。本文因此同时采用人工 present/absent 与 bbox 金标、walkability mask、A* 可达性、required-region reachability 和 interactive-object approachability。

### 2.6 近邻工作边界与候选创新点

基于当前检索，本文不把 text-to-world、visual marks、iterative refinement 或 image-difference grounding 单独声称为首次。候选核心创新更窄：在开放式生成地图中，把图像编辑模型当作语义标注器，使其根据自然语言查询产生人工颜色覆盖，再将受控编辑通过确定性差分反演为 bbox/grid，并接入 specification-to-executable compilation。正式投稿前仍需系统文献检索；“首次”表述暂不使用。

| Work | Primary direction | Spatial interface | Training / prior | Relation to WorldX-Map |
| --- | --- | --- | --- | --- |
| SoM [1] | Segmentation → marks → LMM reasoning | pre-segmented regions + marks | off-the-shelf segmentation | GOG generates marks from the semantic query, then recovers geometry |
| IDG [8] | paired images + text → change grounding | difference regions | trained grounding model | GOG creates a controlled edit; difference is an intermediate measurement signal |
| InterCoG [10] | grounding → image editing | boxes / masks | grounding-aware training | opposite direction: WorldX uses editing → grounding |
| VGent [12] | reasoning → modular bbox prediction | detector proposals / boxes | trained decoder + MLLM encoder | WorldX does not require proposal boxes or a task-specific decoder |
| WorldGen [6] / SceneFoundry [11] | text → interactive 3D world | 3D layout / assets / walkable space | mixed generative + procedural | nearby at system level; WorldX focuses raster-to-executable 2D recovery |
| WorldX-Map | text → raster → overlay → geometry → TMJ | generated overlays, bbox, grid, TMJ | no task-specific training in current pipeline | candidate contribution under test |

## 3. 问题定义

给定开放自然语言世界描述 p ∈ 𝒫，目标是生成可执行二维地图 M。

$$
M = (I, G, R, E)
$$

其中 I 为视觉背景图像；G ∈ {0,1}^{H_g×W_g} 为离散网格，本文约定 0 表示 walkable，1 表示 blocked；R={r_i} 为语义功能区域集合；E={e_j} 为可交互对象集合。

$$
r_i = (id_i, n_i, b_i, a_i, m_i)
$$

$$
e_j = (id_j, n_j, b_j, u_j)
$$

区域中的 b_i=(x₁,y₁,x₂,y₂) 表示空间框，a_i 表示可用动作或交互属性；对象中的 u_j 保存交互配置。系统先构造中间世界规格 S=P(p)。其地图相关部分包含 map description、map plan、规划区域 R*、规划对象 E* 与其他约束。

$$
S_map = {D, P_m, R*, E*, C}
$$

R* 和 E* 是期望目标，不保证视觉合成后一定真实出现。因此评价时必须保留 absent targets，不能只对成功出现的目标计算定位精度。本文把错误分为 synthesis fidelity、spatial grounding 与 executability 三层，避免把“目标没生成出来”和“目标存在但没定位到”混为同一错误。

## 4. 方法

### 4.1 总体管线

$$
p → S → I → {R, E, G} → M
$$

实现上分为六个阶段：结构条件化地图生成；压缩到统一模型输入分辨率；并行执行区域定位、交互对象定位和 walkability 标注；将 walkability overlay 转换为离散网格；把定位结果映射回 world coordinates；编译背景层、碰撞层与对象层，输出 TMJ。区域、对象和 walkability 从同一张压缩地图并行恢复。

*Figure 1. WorldX-Map overall pipeline. The figure separates generative semantic interpretation from deterministic structure recovery and TMJ compilation.*

### 4.2 结构化世界规格

规划器将用户描述映射到结构化规格 S。与直接生成一段 image prompt 相比，规格显式包含 mapDescription、mapPlan.buildingMode、compositionNotes、worldFunctionSummary、regionDesignNotes、regions 与 interactiveElements。区域用于角色可进入并在其中行走的空间；交互对象用于角色靠近后触发行为。两类目标在 grounding 阶段分开处理。

$$
T = R* ∪ E*
$$

$$
t_k = (id_k, n_k, d_k, v_k, l_k)
$$

其中 d_k 是功能描述，v_k 是俯视视觉描述，l_k 是位置提示。当前世界规划限制 regions 与 interactiveElements 合计不超过 8 项。

### 4.3 结构条件化地图合成

$$
I^(a) = G_img(D, P_m, R*, E*, C^(a))
$$

a 表示生成尝试轮次，C^(a) 为到当前轮累计的附加约束。当前实现固定 16:9 输出并保存每轮中间图。生成后，视觉 reviewer 检查 top-down 构图、规划目标、道路与建筑边界等约束。如果 reviewer 返回 prompt adjustments，系统使用语言模型把反馈压缩为额外约束后再次生成。

$$
C^(a+1) = C^(a) ∪ A(F^(a))
$$

本文实验不会用 reviewer 自己的 pass 作为主要质量证据。地图功能遵循由独立人工标注评价。

### 4.4 Generative Overlay Grounding

#### 4.4.1 目标分批与颜色编码

GOG 对区域和交互对象分别执行。每批最多 4 个目标。当前颜色集合为 cyan、magenta、yellow 与 electric blue，批内每个目标分配唯一颜色。图像编辑模型接收原图、目标描述与颜色图例，输出颜色标记图。

$$
|B_q| ≤ 4
$$

$$
C = {(0,255,255), (255,0,255), (255,255,0), (0,128,255)}
$$

$$
Ĩ = G_edit(I, B_q, {c_k})
$$

#### 4.4.2 Block-level 差分

原图被缩放到标记图尺寸。根据标记图宽度选择 block size：宽度不超过 1500 时取 4，1500–3000 取 6，更大时取 8。对每个 block 计算原图与标记图的平均 RGB。

$$
o_b = (1/|b|) Σ_{x∈b} I(x),   m_b = (1/|b|) Σ_{x∈b} Ĩ(x)
$$

$$
d_b = m_b - o_b
$$

当 ||d_b||₂ < 12 时，该 block 被视为没有足够编辑证据。

#### 4.4.3 颜色方向得分

$$
t_{b,k} = c_k - o_b
$$

$$
α_{b,k} = (d_bᵀ t_{b,k}) / ||t_{b,k}||₂²
$$

当前实现要求 0.08 ≤ α_{b,k} ≤ 1.2。用投影重建差分并计算重建误差：

$$
d̂_{b,k} = α_{b,k} t_{b,k}
$$

$$
ε_{b,k} = ||d_b - d̂_{b,k}||₂
$$

若 ε_{b,k}>26，则拒绝该颜色解释。颜色接近增益为：

$$
g_{b,k} = ||o_b - c_k||₂ - ||m_b - c_k||₂
$$

若 g_{b,k}<5 且 α_{b,k}<0.2，同样拒绝。最终得分为：

$$
s_{b,k} = 90α_{b,k} + 0.25g_{b,k} - 0.6ε_{b,k}
$$

block 选择最高得分颜色，并要求最高分至少为 12。这个设计检测的是像素变化是否可以由“朝目标颜色移动”解释，而不是简单判断编辑图像素是否接近纯色。

#### 4.4.4 连通域恢复

所有通过阈值的 blocks 形成 label grid。对每个目标颜色执行四邻域 flood fill。面积小于 4 blocks 的组件删除。设最大组件面积为 A_max，保留组件满足：

$$
A_c ≥ max(4, 0.15 A_max)
$$

被保留组件的几何并集形成初始 bbox。

#### 4.4.5 边界裁剪与坐标映射

当前实现从四边向内裁剪，直到最外侧行或列中目标 label 的覆盖率达到 0.35；随后使用 3% inset。最后按原图与标记图尺寸比映射回原始输入图坐标，并夹在有效边界内。

#### 4.4.6 Verification 与 selective retry

GOG first pass 只包含 overlay 与确定性提取。完整 GOG-V 会把恢复框绘制回地图，由视觉模型确认。若 reviewer 返回 problematic ids，系统只清空这些目标的 bbox，下一轮只重做 missing 或 problematic targets。

$$
T_pending^(a+1) = T_missing^(a) ∪ T_problematic^(a)
$$

为避免实验被 fail-open 污染，当前实验分支区分 verified_pass、verified_fail、verifier_unavailable 与 not_required/not_run。API 异常或不可解析响应不会再自动计为 pass。已恢复 bbox 可以保留，但 reviewPassed=false。

*Figure 2. Generative Overlay Grounding (GOG). A controlled color edit is converted into machine-recoverable geometry through directional difference evidence, connected components, and boundary refinement.*

| 模块 | 条件/阈值 | 当前实现 |
| --- | --- | --- |
| 差分预筛 | ||d_b||₂ | ≥ 12 |
| 方向投影 | α | 0.08–1.2 |
| 重建误差 | ε_rec | ≤ 26 |
| 颜色接近增益 | g | g<5 且 α<0.2 时拒绝 |
| block label | max score | ≥ 12 |
| 组件最小面积 | A_c | ≥ 4 blocks |
| 相对组件面积 | A_c/A_max | ≥ 0.15 |
| 边缘裁剪 | coverage | ≥ 0.35 |
| 最终 inset | ratio | 0.03 |

### 4.5 Functional Traversability Recovery

#### 4.5.1 功能语义标注

可行走区域不是“道路类别”的同义词。系统要求覆盖角色能够实际踩踏并通过的道路、广场、桥面、室内空地和必要入口，同时排除厚墙、水域、家具等障碍。图像编辑模型生成 cyan overlay，生成后经过视觉 review；失败反馈追加到下一轮标注约束。

$$
I_w = G_edit^walk(I, S)
$$

#### 4.5.2 Tile evidence

对 tile 内每个像素，设 (ΔR,ΔG,ΔB)=I_w(x)-I(x)。strong cyan pixel 满足 ΔG≥18、ΔB≥18、ΔR≤8；weak cyan pixel 满足 ΔG≥10、ΔB≥10、ΔR≤14，且不属于 strong 集合。

$$
C_s(g) = N_strong / N
$$

$$
C_w(g) = (N_strong + N_weak) / N
$$

$$
S_c(g) = min(ΔḠ, ΔB̄) - ΔR̄
$$

当前实现将 tile 判为 walkable，当 strong coverage≥0.22，或 weak coverage≥0.38 且 cyanShift≥8、平均 ΔG≥8、平均 ΔB≥8。实现输出中 0 编码 walkable，1 编码 blocked。

#### 4.5.3 窄通道恢复

对当前 blocked tile，如果左右两侧均 walkable，或上下两侧均 walkable，则视为潜在 bridge。只有存在中等 cyan 证据时才恢复：strong coverage≥0.08，或 weak coverage≥0.18 且 cyanShift≥5。该步骤只恢复直线桥接 tile，不进行全局闭运算。

#### 4.5.4 清理

后处理只删除孤立单格 walkable 噪声。如果一个 walkable tile 的四邻域中没有任何 walkable tile，则改为 blocked。实现刻意不填补 blocked gaps，避免扩大模型没有真实标记的区域。所有阈值将在正式实验前于 Dev split 冻结。

### 4.6 可执行地图编译

WorldX-Map 将恢复结构编译为 Tiled-compatible TMJ。输出包含 background image layer、collision tile layer、regions object group 与 interactive_objects object group。区域对象写入 id、description、regionType、actions 和 adjacentRegions；交互对象写入 objectId 与序列化 interactions。当前实验分支兼容旧字段 suggestedInteractions。

压缩图上的区域和对象坐标按原始图宽度比例映射回 world coordinates；背景图缩放到 gridWidth×tileSize 与 gridHeight×tileSize。文件格式正确不等于“可执行”已经得到验证，因此正式实验将使用 A* 与对象接近性测试检查下游运行时结构。

## 5. 实验设计

### 5.1 研究问题

| RQ | 问题 | 核心比较 | 结论边界 |
| --- | --- | --- | --- |
| RQ1 | 结构化 world specification 是否改善功能忠实度？ | Raw / Structured / Full | 无实验前不写“提高” |
| RQ2 | GOG 是否优于直接坐标预测？ | DirectCoord / GridCoord / GOG / GOG-V | 全文主实验 |
| RQ3 | 恢复的 traversability 是否支持导航？ | Walkability variants | 必须有 path-level 指标 |
| RQ4 | Repair 的质量收益与成本如何变化？ | Attempt 1 / Final | same-run paired |

### 5.2 RQ2 Pilot

Pilot 协议冻结为 v1.1，共 10 条中英文 prompt，覆盖 Historical、Modern、Sci-fi、Mystery、Social 五类主题，Indoor、Outdoor、Mixed 三类拓扑和 Low/High 两档复杂度。四个方法共享同一张 02-compressed-map.png、同一 target list、同一 mapDescription；region 与 element 分批，每批最多 4 个 targets。Pilot 只用于诊断研究方向和实验管线，不承担最终 confirmatory claim。

### 5.3 RQ2 Baselines

| 方法 | 输入/机制 | 是否 verifier | 说明 |
| --- | --- | --- | --- |
| DirectCoord | 原图 + targets → VLM bbox JSON | 否 | 最直接坐标基线 |
| GridCoord | 坐标网格图 + targets → VLM bbox JSON | 否 | 控制坐标辅助 |
| GOG | first-pass overlay → diff → components → bbox | 否 | 核心方法 |
| GOG-V | GOG + confirmation + selective retry | 是 | 完整可靠性机制 |

*Figure 3. Matched RQ2 evaluation protocol. All grounding methods receive the same frozen map, target list, map description, target-type batching, and maximum batch size. The figure contains no experimental result.*

### 5.4 Ground Truth

每个规划 target 保留在数据集中。标注员判断 present=true/false。present=true 时给出 bbox；present=false 时 bbox=null。Region bbox 覆盖可用于角色进入或活动的可见功能 footprint；element bbox 紧贴可见对象。正式主实验使用两名独立标注员与 adjudication，标注员不能看到任何方法预测。

### 5.5 Grounding Metrics

$$
IoU(B_p,B_g) = |B_p ∩ B_g| / |B_p ∪ B_g|
$$

$$
NCE = ||c_p - c_g||₂ / √(W² + H²)
$$

Pilot primary metrics 为 meanIoUAll、meanNCEAll、Recall@0.3 与 Missing Rate。Missing prediction 在 all-target 指标中计 IoU=0、NCE=1。Secondary metrics 包括 localized-only IoU/NCE、Recall@0.5、absentFalsePositiveRate 与 presenceAccuracy。对 present=false 目标，如果方法仍输出 located bbox，则记为 false positive。

### 5.6 Navigation Metrics

$$
PRA = # correct reachability decisions / N
$$

$$
RRR = # reachable required regions / # required regions
$$

$$
IOA = # approachable objects / # present objects
$$

$$
LCCR = |C_max| / |𝒲|
$$

### 5.7 统计分析

连续配对指标以 paired bootstrap 95% CI 为主，并报告 Wilcoxon signed-rank 作为补充。二元配对结果使用 McNemar。多因素分析计划采用 mixed-effects model：

$$
Score ~ Method + Complexity + Topology + Language + (1|Prompt)
$$

报告 effect size 与 95% CI。正式实验前指定 primary endpoint；多个主指标同时检验时进行多重比较控制。

## 6. 结果

本节仍为空白。v0.2 新增文献与图示不改变这一边界：没有真实模型运行、人工金标和统计检验，不填任何方向性数字。

| 结果冻结规则 尚未运行正式实验。本节禁止填“预计数字”或方向性结论。只有冻结协议下的真实结果可以进入正文。 |
| --- |

| Method | IoU ↑ | NCE ↓ | Recall@0.3 ↑ | Miss ↓ | Absent FP ↓ |
| --- | --- | --- | --- | --- | --- |
| DirectCoord | — | — | — | — | — |
| GridCoord | — | — | — | — | — |
| GOG | — | — | — | — | — |
| GOG-V | — | — | — | — | — |

6.1 Structured Conditioning：待填 Presence、Placement、Violation、Human Functional Score。

6.2 Spatial Grounding：待填 DirectCoord、GridCoord、GOG、GOG-V 的主指标、置信区间与按 target type 的分层结果。

6.3 Walkability and Navigation：待填 Pixel IoU、PRA、RRR、IOA、LCCR 与 False Traversal Rate。

6.4 Repair Cost–Quality：待填 Attempt 1 vs Final 的 defect resolution、new defects、calls、latency 与 cost。

## 7. 讨论

本节在正式结果后重写。当前只固定解释框架：GOG 的收益来自更高 bbox 精度还是更低 missing rate；小型 element 与大型 region 是否呈现不同误差模式；verifier 是否通过 abstention 降低风险并牺牲 coverage；pixel-level walkability 与 path-level validity 是否一致；repair 的边际收益在哪一轮开始下降。

如果 GOG 没有优于 DirectCoord，不强行维持 superiority claim。论文主线将转向 specification-to-executable compilation，并把 GOG 作为可行机制或失败分析。

## 8. 局限性

- 模型依赖：GOG 依赖图像编辑模型保持原图结构并服从人工颜色覆盖指令。不同模型的 identity preservation 和颜色忠实度可能不同。
- 启发式阈值：颜色差分、组件过滤与 walkability conversion 包含手工阈值。正式实验需要 Dev/Test 隔离与 sensitivity analysis。
- 二维 bbox 表示有限：对不规则区域，bbox 会包含非目标空间。未来可以直接输出 mask 或 polygon。
- 开放世界规模有限：当前世界规划把 regions 与 interactive elements 合计限制在 8 项，适合微型世界，不代表大型开放世界。
- 运行时验证尚待完成：生成 TMJ 只证明结构格式存在。可执行和可导航主张必须等待 A*、region reachability 与 object approachability 实验。
- 人工标注成本：风格化区域边界存在主观差异。主实验需要双标注员一致性和 adjudication。
## 9. 结论

本文提出 WorldX-Map 的方法框架，将开放自然语言世界描述转换为结构化规格，生成俯视地图，再从生成视觉结果中恢复区域、交互对象和可行走拓扑，最终编译为 TMJ。核心方法 GOG 使用生成式颜色覆盖作为语义理解与确定性几何恢复之间的中间接口。

当前论文初稿只陈述方法与实验设计。GOG 是否优于直接坐标预测、结构规格是否改善功能遵循、walkability 是否提高导航有效性，将由冻结实验协议决定。正式结果出来前，不写方向性结论。

## 参考文献（工作版）

[1] Yang, J., Zhang, H., Li, F., Zou, X., Li, C., Gao, J. Set-of-Mark Prompting Unleashes Extraordinary Visual Grounding in GPT-4V. arXiv:2310.11441, 2023.

[2] Yang, Y., Sun, F.-Y., Weihs, L., et al. Holodeck: Language Guided Generation of 3D Embodied AI Environments. arXiv:2312.09067, 2023.

[3] Madaan, A., Tandon, N., Gupta, P., et al. Self-Refine: Iterative Refinement with Self-Feedback. arXiv:2303.17651, 2023.

[4] Withington, O., Cook, M., Tokarchuk, L. On the Evaluation of Procedural Level Generation Systems. arXiv:2404.18657, 2024.

[5] Khalifa, A., Gallotta, R., Barthet, M., Liapis, A., Togelius, J., Yannakakis, G. N. The Procedural Content Generation Benchmark: An Open-source Testbed for Generative Challenges in Games. arXiv:2503.21474, 2025.

[6] Wang, D., Jung, H., Monnier, T., et al. WorldGen: From Text to Traversable and Interactive 3D Worlds. arXiv:2511.16825, 2025.

[7] Zheng, B., Gou, B., Kil, J., Sun, H., Su, Y. GPT-4V(ision) is a Generalist Web Agent, if Grounded. arXiv:2401.01614, 2024.

[8] Wang, W., Zhao, Z., Zhang, Y., et al. Image Difference Grounding with Natural Language. arXiv:2504.01952, 2025.

[9] Ling, L., Lin, C.-H., Lin, T.-Y., et al. Scenethesis: A Language and Vision Agentic Framework for 3D Scene Generation. arXiv:2505.02836, 2025.

[10] Wan, Y., Li, F., Wang, C., Wu, H., Shao, M., Zuo, W. InterCoG: Towards Spatially Precise Image Editing with Interleaved Chain-of-Grounding Reasoning. arXiv:2603.01586, 2026.

[11] Chen, C.-T., Hsu, Y.-C., Liu, Y.-W., et al. SceneFoundry: Generating Interactive Infinite 3D Worlds. arXiv:2601.05810, 2026.

[12] Kang, W., Kuen, J., Ren, M., et al. VGent: Visual Grounding via Modular Design for Disentangling Reasoning and Prediction. arXiv:2512.11099, 2025.

[13] Zhang, J., Deng, Y., Chang, K.-W., Wang, W. Thinking with Visual Grounding. arXiv:2606.16122, 2026.

[14] Huang, S., Nasir, M. U., James, S., Togelius, J. Word2Minecraft: Generating 3D Game Levels through Large Language Models. arXiv:2503.16536, 2025.

## 附录 A. 实现对应表（内部审稿用）

v0.2 说明：本附录仍用于内部审稿。Related Work 与 Figure 1–3 已更新；Results 仍未填。

| 论文模块 | 当前仓库实现 |
| --- | --- |
| Structured World Specification | orchestrator/prompts/design-world.md |
| Structure-Conditioned Synthesis | generators/map/src/steps/step1-generate-map.mjs |
| Region GOG | generators/map/src/steps/step3-resolve-designed-regions.mjs |
| Element GOG | generators/map/src/steps/step3.2-locate-elements.mjs |
| Overlay extraction | generators/map/src/utils/overlay-extraction.mjs |
| Walkability overlay | generators/map/src/steps/step4-walkable-areas.mjs |
| Grid conversion | generators/map/src/steps/step5-compute-grid.mjs + utils/image-utils.mjs |
| TMJ compilation | generators/map/src/steps/step6-build-output.mjs + utils/tmj-builder.mjs |
| RQ2 pilot | paper/worldx-map/ |
