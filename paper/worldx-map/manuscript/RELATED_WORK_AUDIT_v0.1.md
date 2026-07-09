# WorldX-Map Related Work Audit v0.1

> 状态：工作审计稿，日期 2026-07-08。用途是约束 novelty claim，不替代正式系统综述。当前禁止写“首次提出”。

## 1. 当前候选主创新

最窄、也最可防守的候选主张：

> 在开放式生成地图中，把图像编辑模型当作语义标注器，使其根据自然语言查询生成指定人工颜色覆盖；再把这次受控编辑作为测量信号，通过确定性图像差分、颜色方向证据和连通域恢复 bbox/grid，并接入从世界规格到可执行地图的编译链路。

简写：

```text
semantic query
  -> controlled generative color overlay
  -> deterministic difference evidence
  -> connected components / bbox / grid
  -> executable map structure
```

暂定名称：**Generative Overlay Grounding (GOG)**。

## 2. 不能作为主创新的内容

### 2.1 Text-to-world

已有语言驱动环境和世界生成工作已经覆盖：

- Holodeck — arXiv:2312.09067
- Scenethesis — arXiv:2505.02836
- WorldGen — arXiv:2511.16825
- SceneFoundry — arXiv:2601.05810
- Word2Minecraft — arXiv:2503.16536

因此不能把“一句话生成世界”“自然语言到可交互世界”单独写成主要 novelty。

### 2.2 Visual marks

Set-of-Mark Prompting — arXiv:2310.11441 已经明确使用视觉 marks 帮助大型多模态模型引用区域。因此不能把“用颜色/标记辅助 grounding”写成首次。

### 2.3 Image difference grounding

Image Difference Grounding with Natural Language — arXiv:2504.01952 已经研究成对图像差异的语言 grounding。因此不能把“图像差分用于 grounding”单独写成首次。

### 2.4 Grounding-aware image editing

InterCoG — arXiv:2603.01586 研究 grounding 如何提高精细图像编辑。因此不能笼统声称“首次结合 grounding 和 image editing”。

### 2.5 Iterative refinement

Self-Refine — arXiv:2303.17651 等工作已经覆盖生成—反馈—修正。WorldX-Map 的 review / retry 只能作为可靠性机制，不能单独做主创新。

## 3. 与最接近工作的方向差异

| Work | Data flow | 主要目标 | 与 GOG 的关键差异 |
| --- | --- | --- | --- |
| SoM | segmentation -> marks -> LMM reasoning | 让模型引用候选区域 | GOG 不先依赖分割候选；mark 由语义查询驱动生成，随后反演几何 |
| IDG | paired real images + text -> changed region | 定位真实变化 | GOG 主动制造受控颜色变化；差分是内部测量信号 |
| InterCoG | grounding -> editing | 提高图像编辑空间精度 | GOG 方向相反：editing -> grounding |
| VGent | reasoning -> modular bbox prediction | 提高 visual grounding | GOG 不训练 task-specific bbox decoder，也不要求 proposal boxes |
| Thinking with Visual Grounding | visual reasoning <-> points/boxes | 推理过程中显式 grounding | GOG 用生成式覆盖产生可确定性提取的中间视觉表示 |
| WorldGen / SceneFoundry | text -> interactive 3D world | 生成可遍历交互世界 | 系统层近邻；WorldX-Map 聚焦 raster-to-executable 2D structure recovery |

## 4. 当前可用的审慎表述

### 方法级

可以写：

> We introduce Generative Overlay Grounding (GOG), a training-free protocol that externalizes open-ended semantic localization as controlled color overlays and deterministically recovers spatial structures from the induced edits.

更保守：

> We investigate a generative-overlay grounding protocol in which an image editing model externalizes semantic localization as controlled color edits, followed by deterministic structure recovery.

### 差异级

可以写：

> Unlike pre-segmentation-based marking, paired-image change grounding, or grounding-guided editing, GOG uses query-conditioned editing to create an intermediate measurement signal and then recovers geometry from that signal.

### 系统级

可以写：

> WorldX-Map integrates structured specification planning, open-ended visual synthesis, generative overlay grounding, functional traversability recovery, and Tiled-compatible compilation in a single 2D map pipeline.

## 5. 暂时禁止的表述

- “首次提出生成式覆盖定位”
- “首个自然语言到可执行地图系统”
- “首个无训练视觉 grounding 方法”
- “首次用 image editing 做 grounding”
- “GOG 优于直接 bbox”
- “输出地图可执行 / 可导航”

前三类需要更完整的系统检索；后三类需要冻结实验。

## 6. 需要实验才能成立的 Claim

| Claim | 最低证据 |
| --- | --- |
| GOG 比 direct coordinate grounding 更可靠 | 同图 DirectCoord/GridCoord/GOG + human bbox GT + paired CI |
| GOG-V 提高可靠性 | same targets + independent gold + outage-aware verifier status + risk/coverage |
| structured specification 改善 functional fidelity | Raw vs Structured 配对 + independent presence/placement/violation labels |
| traversability recovery 支持导航 | human mask + A* + PRA/RRR/IOA |
| executable map | TMJ runtime validation；只生成文件不够 |

## 7. 当前结论

现阶段最合理的论文边界仍然是：

> **一个核心方法：GOG；一个系统框架：Specification-to-Executable Compilation；一个下游验证：Functional Traversability。**

近邻文献把 novelty 压得更窄，但没有消除这个方向。真正决定 GOG 能否作为主贡献的，不是命名，而是 RQ2：在完全匹配输入、批大小和目标列表的条件下，它是否比 DirectCoord / GridCoord 提供更好的定位精度或更低的 missing risk。
