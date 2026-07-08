# WorldX-Map：基于生成式覆盖定位的自然语言世界规格到可执行二维游戏地图编译方法

**English title:** WorldX-Map: Compiling Natural-Language World Specifications into Executable 2D Game Maps via Generative Overlay Grounding

> 文档状态：论文初稿 v0.1。Problem Formulation、Method 与 Experimental Setup 已按当前仓库实现成稿；Results 不填虚构数字。正式投稿前需完成系统文献检索、双标注员金标与冻结测试集实验。

## 摘要

生成式视觉模型能够根据开放自然语言描述产生内容丰富的二维游戏地图，但输出通常仍是栅格图像。游戏运行时需要可行走网格、功能区域、交互对象及其空间坐标。直接从风格多变的生成图中恢复这些结构并不稳定：目标类别开放，区域边界常由功能语义而非固定视觉类别决定，小型对象的像素坐标又容易受到尺度影响。

本文提出 WorldX-Map，一套从自然语言世界描述到可执行二维地图表示的无训练生成管线。系统先将用户描述转换为结构化世界规格，并将地图计划、功能区域与交互对象作为条件注入视觉合成。针对生成图中的区域与对象定位，本文提出 Generative Overlay Grounding（GOG）：图像编辑模型不直接预测坐标，而是按目标语义在原图上生成颜色编码覆盖层；随后使用确定性图像差分、颜色方向判别、连通域恢复与边界裁剪得到空间框。对于角色可通行空间，系统采用功能语义驱动的 cyan overlay，并将覆盖证据转换为离散网格，保留窄通道并移除孤立噪声。最终结果被编译为 Tiled-compatible TMJ，其中包含背景层、碰撞层、语义区域与交互对象。

本文将围绕四个问题展开实验：结构化世界规格是否改善功能遵循；GOG 是否优于直接坐标预测；恢复出的可行走结构是否支持下游导航；verification-guided repair 的质量收益与计算成本如何变化。当前初稿不报告未完成实验的方向性结论。

**关键词：** procedural content generation；game map generation；visual grounding；image editing；multimodal models；traversability；executable map

---

## 1. 引言

自然语言到游戏世界的生成正在从单一素材扩展到完整场景。已有工作利用大语言模型进行场景规划、对象关系推理和环境构造，也开始关注可遍历或可交互的生成世界。对二维游戏地图而言，一个仍然具体的问题是：视觉生成完成后，怎样得到游戏运行所需的结构。

一张看起来合理的俯视地图并不自动等于可执行地图。角色移动需要离散的 walkability 或 collision grid；剧情和行为调度需要功能区域；交互系统需要对象位置与交互属性。传统 tile-based PCG 可以直接在离散表示上生成内容，但开放式图像生成没有固定 tile vocabulary。用户可能要求北宋夜市、现代便利店、火星科研站或悬疑古寺。相同的“可进入区域”在不同风格下没有统一像素模式。小型对象更难直接用像素坐标稳定描述。

最直接的方案是让视觉语言模型读取地图并返回 bounding boxes。这个方案简单，但把语义识别、空间估计和坐标序列化压在一次生成中。对复杂风格图和小目标，误差来源难以分离。本文采用另一条路径：让生成模型先把自己的语义判断外显为人工颜色覆盖，再由确定性算法恢复几何结构。我们称这一协议为 Generative Overlay Grounding（GOG）。

GOG 的设计基于一个工程观察。图像编辑模型通常更擅长“把某个区域涂成指定颜色”这类视觉修改，而不是精确输出像素坐标。颜色覆盖又提供了一个可计算的中间表示。原图与编辑图的差分可以被检测，目标颜色提供方向约束，连通域可以把局部证据恢复成区域。生成模型负责开放语义理解，确定性算法负责空间提取。两者的边界清楚。

WorldX-Map 将这一机制嵌入完整管线。用户描述先被规划为结构化世界规格；视觉生成阶段显式接收地图计划、区域和交互对象；区域、对象与可行走空间从同一张冻结地图中恢复；最终输出 TMJ，而非只保存 PNG。

本文计划验证以下贡献：

1. **Generative Overlay Grounding。** 提出一种无训练空间 grounding 协议。图像编辑模型按目标语义生成颜色编码覆盖，确定性差分算法恢复 bbox。当前实现包含 block-level 差分、目标颜色方向投影、重建误差约束、颜色接近增益、连通域筛选和边界裁剪。
2. **Specification-to-Executable Map Compilation。** 将开放自然语言描述转换为结构化世界规格，再进行结构条件化视觉合成、空间恢复与 TMJ 编译，使输出包含背景、碰撞、语义区域和交互对象。
3. **Functional Traversability Recovery。** 将可行走性定义为下游角色移动语义，而非普通道路类别分割。系统从生成式 cyan overlay 中恢复网格，并显式处理窄通道与孤立噪声。

本文不会把 iterative repair 本身作为首创。相关的反馈—修正范式已有充分研究。这里的 repair 用于提高生成与 grounding 管线的可靠性，并单独测量质量—成本关系。

---

## 2. 相关工作

### 2.1 语言驱动的环境与世界生成

语言驱动环境生成已经覆盖 3D 场景规划、资产放置和可探索世界。Holodeck 使用大语言模型推理场景内容与空间关系，再结合 3D 资产构造环境。WorldGen 进一步把文本描述转换为可遍历、可交互且可在标准游戏引擎中编辑的 3D 世界。这些工作说明“text-to-world”本身已经是活跃方向。因此本文不把“一句话生成世界”作为主要创新，而聚焦二维生成地图中的可执行结构恢复。

### 2.2 视觉 Grounding 与视觉提示

视觉 grounding 通常要求模型根据语言查询定位图像中的对象或区域。Set-of-Mark（SoM）通过现成分割模型先划分图像，再叠加 marks，使大型多模态模型更容易引用视觉区域。WorldX-Map 与该思路存在近邻关系，但数据流不同。SoM 是 segmentation → marks → multimodal reasoning；GOG 是 semantic query → generative overlay → deterministic geometry extraction。本文实验将直接比较 VLM 坐标预测、坐标网格辅助预测和 GOG。

### 2.3 迭代反馈与修正

Self-Refine 等工作表明，生成、反馈和再次生成可以在不额外训练的条件下改善多类任务输出。WorldX-Map 的地图合成、区域/元素定位和 walkability 标注均包含 review 或 selective retry。本文把它视为可靠性机制，并通过 same-run before/after 对比测量其收益与额外调用成本。

### 2.4 PCG 评价

程序化关卡生成的评价缺少单一通用标准。近期综述与 benchmark 工作强调，应根据生成任务区分质量、多样性、可控性和运行时有效性。对 WorldX-Map，只报告图像美观度不足以支撑“可执行”主张。本文因此同时采用 bbox 金标、walkability mask、A* 可达性、区域可达率与交互对象可接近率。

---

## 3. 问题定义

给定开放自然语言世界描述

\[
p \in \mathcal{P},
\]

目标是生成可执行二维地图

\[
M = (I, G, R, E),
\]

其中：

- \(I\) 为视觉背景图像；
- \(G \in \{0,1\}^{H_g \times W_g}\) 为离散网格，本文约定 0 表示 walkable，1 表示 blocked；
- \(R = \{r_i\}_{i=1}^{N_R}\) 为语义功能区域集合；
- \(E = \{e_j\}_{j=1}^{N_E}\) 为可交互对象集合。

区域表示为

\[
r_i = (id_i, n_i, b_i, a_i, m_i),
\]

其中 \(id_i\) 是稳定标识，\(n_i\) 是名称，\(b_i=(x_1,y_1,x_2,y_2)\) 是空间框，\(a_i\) 是可用动作或交互属性，\(m_i\) 为其他语义元数据。

交互对象表示为

\[
e_j = (id_j, n_j, b_j, u_j),
\]

其中 \(u_j\) 保存对象交互配置。

系统先构造中间世界规格

\[
S = P(p),
\]

其主要地图字段为

\[
S_{map} = \{D, P_m, R^*, E^*, C\},
\]

其中 \(D\) 为 map description，\(P_m\) 为 map plan，\(R^*\) 与 \(E^*\) 分别是规划区域和规划对象，\(C\) 是其他约束。\(R^*\) 和 \(E^*\) 是期望目标，不保证视觉合成后一定真实出现。因此评价时必须保留 absent targets，不能只对成功出现的目标计算定位精度。

本文区分三个问题：

1. **Synthesis fidelity。** 规划目标是否实际出现在生成图中，位置关系是否遵循规格。
2. **Spatial grounding。** 对真实出现的目标，方法能否恢复准确 bbox；对未出现目标，方法是否会误报。
3. **Executability。** 恢复的网格与对象结构是否支持导航和交互接近。

这种分解避免把“目标没生成出来”和“目标存在但没定位到”混为同一错误。

---

## 4. 方法

### 4.1 总体管线

WorldX-Map 的数据流为

\[
p \rightarrow S \rightarrow I \rightarrow \{R,E,G\} \rightarrow M.
\]

实现上分为六个阶段：

1. 生成结构条件化地图；
2. 压缩到统一模型输入分辨率；
3. 并行执行区域定位、交互对象定位和 walkability 标注；
4. 将 walkability overlay 转换为离散网格；
5. 将定位结果映射回世界坐标；
6. 编译背景层、碰撞层与对象层，输出 TMJ。

区域、对象和 walkability 从同一张压缩地图并行恢复。这样可以减少下游任务之间的串行依赖，也便于在实验中冻结同一视觉输入。

### 4.2 结构化世界规格

规划器将用户描述 \(p\) 映射到结构化规格 \(S\)。与直接生成一段 image prompt 相比，WorldX 的规格显式包含地图与功能结构：

- `mapDescription`：一句话场景描述，强调时代、地点、风格和俯视构图；
- `mapPlan.buildingMode`：场景偏可进入建筑还是偏景观；
- `mapPlan.compositionNotes`：全局平面构图；
- `mapPlan.worldFunctionSummary`：场景功能；
- `mapPlan.regionDesignNotes`：区域位置关系与连通方式；
- `regions`：功能区域，包含 `placementHint`、`visualDescription`、`enterable`、`shapeConstraint` 与 interactions；
- `interactiveElements`：位于主区域中的小型可交互对象，包含位置提示、俯视外观与 interactions。

规划层约束 `regions` 与 `interactiveElements` 合计不超过 8 项。区域用于角色可进入并在其中行走的空间；交互对象用于角色靠近后触发行为。两类目标在 grounding 阶段分开处理。

形式化地，规划目标集合为

\[
T = R^* \cup E^*.
\]

每个目标 \(t_k\) 至少包含

\[
t_k=(id_k,n_k,d_k,v_k,l_k),
\]

其中 \(d_k\) 是功能描述，\(v_k\) 是俯视视觉描述，\(l_k\) 是位置提示。

### 4.3 结构条件化地图合成

地图生成器接收用户描述与结构摘要，而不是只接收原始 prompt：

\[
I^{(a)} = G_{img}(D, P_m, R^*, E^*, C^{(a)}),
\]

其中 \(a\) 表示生成尝试轮次，\(C^{(a)}\) 是到当前轮累计的附加约束。

当前实现固定 16:9 输出，并保存每轮中间图。生成后，视觉 reviewer 检查 top-down 构图、规划目标、道路与建筑边界等约束。如果 reviewer 返回 prompt adjustments，系统使用语言模型把反馈压缩为额外约束，再进入下一轮：

\[
C^{(a+1)} = C^{(a)} \cup A(F^{(a)}),
\]

其中 \(F^{(a)}\) 为审查反馈，\(A(\cdot)\) 为反馈到约束的转换。

本文实验不会用 reviewer 自己的 `pass` 作为主要质量证据。地图功能遵循由独立人工标注评价。

### 4.4 Generative Overlay Grounding

#### 4.4.1 目标分批与颜色编码

GOG 对区域和交互对象分别执行。每批最多四个目标：

\[
|B_q| \le 4.
\]

当前颜色集合为 cyan、magenta、yellow 与 electric blue：

\[
\mathcal{C}=\{(0,255,255),(255,0,255),(255,255,0),(0,128,255)\}.
\]

批内每个目标 \(t_k\) 被分配唯一颜色 \(c_k\)。图像编辑模型接收原图 \(I\)、目标描述及颜色图例，输出标记图

\[
\tilde I = G_{edit}(I, B_q, \{c_k\}).
\]

任务要求模型保持非目标内容不变，只用指定颜色覆盖目标区域或对象。

#### 4.4.2 Block-level 差分

原图被缩放到标记图尺寸。根据标记图宽度选择 block size \(s_b\)：宽度不超过 1500 时取 4，1500–3000 取 6，更大时取 8。

对每个 block \(b\)，计算原图与标记图的平均 RGB：

\[
o_b = \frac{1}{|b|}\sum_{x\in b} I(x), \qquad
m_b = \frac{1}{|b|}\sum_{x\in b} \tilde I(x).
\]

差分为

\[
d_b=m_b-o_b.
\]

若

\[
\|d_b\|_2 < 12,
\]

该 block 被视为没有足够编辑证据。

#### 4.4.3 颜色方向得分

对候选目标颜色 \(c_k\)，定义从原始颜色朝目标色的方向

\[
t_{b,k}=c_k-o_b.
\]

把实际差分投影到该方向：

\[
\alpha_{b,k}=\frac{d_b^\top t_{b,k}}{\|t_{b,k}\|_2^2}.
\]

当前实现要求

\[
0.08 \le \alpha_{b,k} \le 1.2.
\]

用投影重建差分

\[
\hat d_{b,k}=\alpha_{b,k}t_{b,k},
\]

重建误差为

\[
\epsilon_{b,k}=\|d_b-\hat d_{b,k}\|_2.
\]

若

\[
\epsilon_{b,k}>26,
\]

则拒绝该颜色解释。

颜色接近增益定义为

\[
g_{b,k}=\|o_b-c_k\|_2-\|m_b-c_k\|_2.
\]

若 \(g_{b,k}<5\) 且 \(\alpha_{b,k}<0.2\)，同样拒绝。保留候选的得分为

\[
s_{b,k}=90\alpha_{b,k}+0.25g_{b,k}-0.6\epsilon_{b,k}.
\]

block 选择最高得分颜色

\[
y_b=\arg\max_k s_{b,k},
\]

并要求

\[
\max_k s_{b,k}\ge 12.
\]

否则该 block 标记为背景。

这个设计没有直接检测“像不像纯 cyan”。它检测的是：从原始像素到编辑像素的变化，是否可以由“朝目标颜色移动”合理解释。这样可以容纳半透明覆盖和原图底色差异。

#### 4.4.4 连通域恢复

所有通过阈值的 block 形成 label grid。对每个目标颜色执行四邻域 flood fill。面积小于 4 个 blocks 的组件被删除。

设最大组件面积为 \(A_{max}\)。保留组件满足

\[
A_c \ge \max(4,0.15A_{max}).
\]

被保留组件的几何并集形成初始 bbox。

#### 4.4.5 边界裁剪与坐标映射

初始 bbox 可能包含稀疏边缘。当前实现分别计算最外侧行和列中目标 label 的覆盖率，并从四边向内裁剪，直到边缘覆盖率达到

\[
\tau_{trim}=0.35.
\]

裁剪后再使用 3% inset：

\[
\rho_{inset}=0.03.
\]

最后根据原图与标记图尺寸比映射回原始输入图坐标。所有坐标被夹在有效图像边界内。

#### 4.4.6 Verification 与 selective retry

GOG first pass 只包含 overlay 与确定性提取。完整 GOG-V 会把恢复框绘制回地图，由视觉模型确认。reviewer 返回 `problematic_region_ids` 或 `problematic_element_ids` 时，系统只清空这些目标的 bbox：

\[
T^{(a+1)}_{pending}=T^{(a)}_{missing}\cup T^{(a)}_{problematic}.
\]

下一轮只重做 pending targets。通过的目标不重复定位。

为避免论文统计被 fail-open 污染，当前实验分支把 verifier 状态区分为：

- `verified_pass`；
- `verified_fail`；
- `verifier_unavailable`；
- `not_required` / `not_run`。

API 异常或不可解析响应不会再自动计为 pass。已恢复 bbox 可以保留，但 `reviewPassed=false`。

### 4.5 Functional Traversability Recovery

#### 4.5.1 功能语义标注

可行走区域不是“道路类别”的同义词。系统 prompt 要求覆盖角色能够实际踩踏并通过的空间，包括道路、广场、桥面、室内空地和必要入口，同时排除厚墙、水域、家具等障碍。

图像编辑模型生成 cyan overlay：

\[
I_w=G_{edit}^{walk}(I,S).
\]

生成后经过视觉 review；失败反馈被追加到下一轮标注约束。

#### 4.5.2 Tile evidence

原图与 walkability overlay 被缩放到同一网格分辨率。对 tile 内每个像素，定义差分

\[
(\Delta R,\Delta G,\Delta B)=I_w(x)-I(x).
\]

strong cyan pixel 满足

\[
\Delta G\ge18 \land \Delta B\ge18 \land \Delta R\le8.
\]

weak cyan pixel 满足

\[
\Delta G\ge10 \land \Delta B\ge10 \land \Delta R\le14,
\]

且不属于 strong 集合。

对 tile \(g\)，定义

\[
C_s(g)=\frac{N_{strong}}{N},
\]

\[
C_w(g)=\frac{N_{strong}+N_{weak}}{N}.
\]

使用 tile 平均 RGB 差分计算

\[
S_c(g)=\min(\overline{\Delta G},\overline{\Delta B})-\overline{\Delta R}.
\]

当前实现判定

\[
walkable(g)=1
\]

当且仅当满足以下任一条件：

\[
C_s(g)\ge0.22,
\]

或

\[
C_w(g)\ge0.38 \land S_c(g)\ge8
\land \overline{\Delta G}\ge8
\land \overline{\Delta B}\ge8.
\]

实现输出中使用 0 编码 walkable，1 编码 blocked。

#### 4.5.3 窄通道恢复

保守阈值容易删除一格宽通道。对当前 blocked tile，如果其左右两侧均 walkable，或上下两侧均 walkable，则视为潜在 bridge。只有存在中等 cyan 证据时才恢复：

\[
C_s(g)\ge0.08
\]

或

\[
C_w(g)\ge0.18 \land S_c(g)\ge5.
\]

这一步只恢复直线桥接 tile，不进行全局闭运算。

#### 4.5.4 清理

后处理只删除孤立单格 walkable 噪声。如果一个 walkable tile 的四邻域中没有任何 walkable tile，则改为 blocked。实现刻意不填补 blocked gaps，因为自动填洞会扩大模型没有真实标记的区域。

所有阈值将在正式实验前于 Dev split 冻结；Test split 禁止继续调整。

### 4.6 可执行地图编译

WorldX-Map 将恢复结构编译为 Tiled-compatible TMJ。输出包含：

1. `background` image layer；
2. `collision` tile layer；
3. `regions` object group；
4. `interactive_objects` object group。

区域对象写入 `id`、`description`、`regionType`、`actions` 和 `adjacentRegions`。交互对象写入 `objectId` 与序列化 `interactions`。当前实验分支同时兼容旧字段 `suggestedInteractions`，避免历史数据丢失。

压缩图上的区域和对象坐标根据原始图宽度比例映射回 world coordinates；背景图缩放到 \(W_g\times tileSize\) 与 \(H_g\times tileSize\)。

文件格式正确不等同于“可执行”已经得到验证。因此正式实验将使用 A* 与对象接近性测试检查下游运行时结构。

---

## 5. 实验设计

### 5.1 研究问题

**RQ1.** Does structured world specification conditioning improve the functional fidelity of generated game maps?

比较 Raw、Structured 和 Full。关注规划目标出现、位置关系和硬约束违反。

**RQ2.** Does generative overlay grounding improve spatial localization accuracy over direct coordinate prediction?

比较 DirectCoord、GridCoord、GOG 和 GOG-V。RQ2 是主实验。

**RQ3.** Does functional traversability recovery improve downstream navigational validity?

比较不同 walkability 恢复变体，测量 pixel metrics 与 path metrics。

**RQ4.** What reliability gains are achieved by verification-guided repair, and at what computational cost?

使用同一次 run 的 Attempt 1 与 Final 做 paired comparison。

### 5.2 RQ2 Pilot

Pilot 协议冻结为 v1.1，共 10 条中英文 prompt，覆盖 Historical、Modern、Sci-fi、Mystery、Social 五类主题，Indoor、Outdoor、Mixed 三类拓扑和 Low/High 两档复杂度。

四个方法共享以下控制：

- 同一张 `02-compressed-map.png`；
- 同一 target list；
- 同一 `mapDescription`；
- region 与 element 分批；
- 每批最多 4 个 targets。

Pilot 用于诊断研究方向和实验管线，不承担最终 confirmatory claim。

### 5.3 RQ2 Baselines

**DirectCoord。** 原图、目标描述与图像尺寸输入 VLM，直接输出 pixel-space bbox JSON。

**GridCoord。** 在同一地图上增加人工坐标网格，再由同一 VLM 输出 bbox。

**GOG。** 使用第一次 overlay artifacts，运行颜色差分与几何恢复，不使用 verifier。

**GOG-V。** 使用完整 verification 与 selective retry 后的最终结果，并单独记录 `verifier_unavailable`。

### 5.4 Ground Truth

每个规划 target 保留在数据集中。标注员判断：

- `present=true`：目标在地图中真实可见，并给出 bbox；
- `present=false`：目标没有真实出现，bbox 为 null。

region bbox 覆盖可用于角色进入或活动的可见功能 footprint。element bbox 紧贴可见对象。

正式主实验使用两名独立标注员与 adjudication。标注员可看 target name、description、visualDescription 与 placementHint，但不能看到任何方法预测。

### 5.5 Grounding Metrics

对 present targets，Intersection over Union：

\[
IoU(B_p,B_g)=\frac{|B_p\cap B_g|}{|B_p\cup B_g|}.
\]

Normalized Center Error：

\[
NCE=\frac{\|c_p-c_g\|_2}{\sqrt{W^2+H^2}}.
\]

Pilot primary metrics：

- `meanIoUAll`：missing prediction 记为 0；
- `meanNCEAll`：missing prediction 记为 1；
- Recall@0.3；
- Missing Rate。

Secondary metrics：

- localized-only IoU / NCE；
- Recall@0.5；
- `absentFalsePositiveRate`；
- `presenceAccuracy`。

对 `present=false` 目标，如果方法仍输出 located bbox，则记为 false positive。这样避免方法通过“所有目标都存在”提高表面覆盖率。

### 5.6 Navigation Metrics

Path Reachability Agreement：

\[
PRA=\frac{\#\;correct\;reachability\;decisions}{N}.
\]

Required Region Reachability：

\[
RRR=\frac{\#\;reachable\;required\;regions}{\#\;required\;regions}.
\]

Interactive Object Approachability：

\[
IOA=\frac{\#\;approachable\;objects}{\#\;present\;objects}.
\]

Largest Connected Component Ratio：

\[
LCCR=\frac{|C_{max}|}{|\mathcal{W}|}.
\]

### 5.7 统计分析

连续配对指标以 paired bootstrap 95% CI 为主，并报告 Wilcoxon signed-rank 作为补充。二元配对结果使用 McNemar。多因素分析计划采用 mixed-effects model：

\[
Score \sim Method+Complexity+Topology+Language+(1|Prompt).
\]

报告 effect size 与 95% CI。正式实验前指定 primary endpoint；多个主指标同时检验时进行多重比较控制。

---

## 6. 结果

> **未运行正式实验。本节禁止填预测数字。**

### 6.1 Structured Conditioning

待填：Presence、Placement、Violation、Human Functional Score。

### 6.2 Spatial Grounding

待填：DirectCoord、GridCoord、GOG、GOG-V 的 IoU、NCE、Recall、Missing Rate、absent false positives。

### 6.3 Walkability and Navigation

待填：Pixel IoU、PRA、RRR、IOA、LCCR、False Traversal Rate。

### 6.4 Repair Cost–Quality

待填：Attempt 1 vs Final 的 defect resolution、new defects、calls、latency、cost。

---

## 7. 讨论

> 本节在正式结果后重写。当前仅保留解释框架。

计划回答：

1. GOG 的收益来自更高 bbox 精度，还是更低 missing rate；
2. 小型 element 与大型 region 是否呈现不同误差模式；
3. verifier 是否通过 abstention 降低风险，同时牺牲 coverage；
4. pixel-level walkability 与 path-level validity 是否一致；
5. repair 的边际收益在哪一轮开始下降。

如果 GOG 没有优于 DirectCoord，不强行维持 superiority claim。论文主线将转向 specification-to-executable compilation，并把 GOG 作为可行机制或失败分析。

---

## 8. 局限性

当前方法存在明确限制。

**模型依赖。** GOG 依赖图像编辑模型保持原图结构并服从人工颜色覆盖指令。不同模型的 identity preservation 和颜色忠实度可能不同。

**启发式阈值。** 颜色差分、组件过滤与 walkability conversion 包含手工阈值。正式实验需要 Dev/Test 隔离与 sensitivity analysis。

**二维 bbox 表示有限。** 对不规则区域，bbox 会包含非目标空间。未来可以直接输出 mask 或 polygon。

**开放世界规模有限。** 当前世界规划把 regions 与 interactive elements 合计限制在 8 项，适合微型世界，不代表大型开放世界。

**运行时验证尚待完成。** 生成 TMJ 只证明结构格式存在。可执行和可导航主张必须等待 A*、region reachability 与 object approachability 实验。

**人工标注成本。** 风格化区域边界存在主观差异。主实验需要双标注员一致性和 adjudication。

---

## 9. 结论

本文提出 WorldX-Map 的方法框架，将开放自然语言世界描述转换为结构化规格，生成俯视地图，再从生成视觉结果中恢复区域、交互对象和可行走拓扑，最终编译为 TMJ。核心方法 GOG 使用生成式颜色覆盖作为语义理解与确定性几何恢复之间的中间接口。

当前论文初稿只陈述方法与实验设计。GOG 是否优于直接坐标预测、结构规格是否改善功能遵循、walkability 是否提高导航有效性，将由冻结实验协议决定。正式结果出来前，不写方向性结论。

---

## 工作参考文献

[1] Yang, J., Zhang, H., Li, F., Zou, X., Li, C., Gao, J. *Set-of-Mark Prompting Unleashes Extraordinary Visual Grounding in GPT-4V*. arXiv:2310.11441, 2023.

[2] Yang, Y., Sun, F.-Y., Weihs, L., et al. *Holodeck: Language Guided Generation of 3D Embodied AI Environments*. arXiv:2312.09067, 2023.

[3] Madaan, A., Tandon, N., Gupta, P., et al. *Self-Refine: Iterative Refinement with Self-Feedback*. arXiv:2303.17651, 2023.

[4] Withington, O., Cook, M., Tokarchuk, L. *On the Evaluation of Procedural Level Generation Systems*. arXiv:2404.18657, 2024.

[5] Khalifa, A., Gallotta, R., Barthet, M., Liapis, A., Togelius, J., Yannakakis, G. N. *The Procedural Content Generation Benchmark: An Open-source Testbed for Generative Challenges in Games*. arXiv:2503.21474, 2025.

[6] Wang, D., Jung, H., Monnier, T., et al. *WorldGen: From Text to Traversable and Interactive 3D Worlds*. arXiv:2511.16825, 2025.

---

## 实现对应表（内部审稿用，投稿时移至补充材料或删除）

| 论文模块 | 当前仓库实现 |
|---|---|
| Structured World Specification | `orchestrator/prompts/design-world.md` |
| Structure-Conditioned Synthesis | `generators/map/src/steps/step1-generate-map.mjs` |
| Region GOG | `generators/map/src/steps/step3-resolve-designed-regions.mjs` |
| Element GOG | `generators/map/src/steps/step3.2-locate-elements.mjs` |
| Overlay extraction | `generators/map/src/utils/overlay-extraction.mjs` |
| Walkability overlay | `generators/map/src/steps/step4-walkable-areas.mjs` |
| Grid conversion | `generators/map/src/steps/step5-compute-grid.mjs` + `utils/image-utils.mjs` |
| TMJ compilation | `generators/map/src/steps/step6-build-output.mjs` + `utils/tmj-builder.mjs` |
| RQ2 pilot | `paper/worldx-map/` |
