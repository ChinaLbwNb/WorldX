# WorldX-Map Target Journal & Argument Design Audit v0.1

> Date: 2026-07-09
> Purpose: freeze the target venue, argument structure, experiment standard, and writing constraints before formal model runs.

## 1. Primary Target

**IEEE Transactions on Games (Regular Full Paper)**

Rationale:

- The journal explicitly covers scientific, technical, and engineering aspects of games, including AI for games, simulated worlds, graphics and animation, software engineering in games, computational game creativity, and game evaluation.
- WorldX-Map is a game-content generation and executable-structure recovery system; its strongest evidence is game-specific: functional regions, interactive objects, collision/walkability, and runtime reachability.
- This fit is stronger than reframing the work as a general graphics method for ACM TOG or as general visual computing for TVCG.

Current submission constraints to respect:

- Double-anonymous review for manuscripts submitted on or after 2025-01-01.
- Full paper target: 10 pages in IEEE two-column format before over-length charges; 10–14 pages are allowed but pages over 10 incur fees.
- Abstract: 150–200 words, one paragraph, self-contained, no references or displayed equations.
- 2–5 keywords.
- Standard IEEE Transactions format.
- Figures must remain legible when reduced to one- or two-column width; captions should be self-contained.

The 2026 Special Issue on Multi-Modal Content Generation for Games was a near-perfect topical match, but its submission deadline was 2026-03-31 and is already past. Therefore the current target is the regular issue.

## 2. Venue-Level Positioning

Do not sell the paper as:

- “one sentence generates a world”
- “multi-agent world generation”
- “a complete AI game engine”

Primary paper problem:

> How can executable game structures be recovered reliably after open-ended visual models generate a stylized 2D map?

Primary method claim:

> Generative Overlay Grounding (GOG) externalizes open-ended semantic localization as controlled color edits and recovers geometry deterministically from the induced changes.

System claim:

> WorldX-Map compiles natural-language world specifications into raster maps, spatial structures, and Tiled-compatible runtime representations.

Downstream claim:

> Functional traversability recovery is evaluated through path- and reachability-level tests, not only pixel overlap.

## 3. Lessons from Representative High-Quality Work

### 3.1 PCG Benchmark (2025)

Observed pattern:

- starts from a measurement gap, not from a method inventory
- defines explicit evaluation dimensions
- provides multiple problem variants
- tests multiple baseline algorithms
- uses repeated independent runs and confidence intervals
- avoids a single scalar “quality” claim

WorldX implication:

- every contribution must map to an observable endpoint
- use matched maps across methods
- preserve separate metrics for presence, localization, false positives, and runtime validity
- report stochastic stability on a repeated subset

### 3.2 Towards Objective Metrics for Procedurally Generated Video Game Levels

Observed pattern:

- argues that visual similarity is insufficient
- introduces simulation-based metrics using A* behavior
- tests across multiple domains
- discusses where one metric works and where it fails
- releases the evaluation framework

WorldX implication:

- RQ3 should prioritize PRA/RRR/IOA and false traversal over pixel IoU
- report disagreement cases where mask quality and navigation validity diverge
- include executable evaluator code in the artifact

### 3.3 On the Evaluation of Procedural Level Generation Systems

Observed pattern:

- distinguishes direct-representation metrics, simulated-agent evaluation, human evaluation, and comparison points
- criticizes evaluation that is only internally focused
- notes that comparison against prior systems is much stronger than ablation-only evidence
- warns that one heuristic can be misleading for multi-criteria generated content

WorldX implication:

- DirectCoord and GridCoord alone are not enough as the final main-study baseline set
- add at least one stronger nearest-neighbor grounding baseline
- keep human gold and runtime tests independent from the same reviewer used inside the pipeline
- do not collapse all outcomes into one weighted score

### 3.4 Start Small: Multi-Size Game Level Generation

Observed pattern:

- introduction isolates one concrete failure mode
- states assumptions before the method
- tests across three game domains
- uses large generated samples
- repeats experiments five times and reports mean/std
- chooses the closest external baseline and matches the testing setup
- reports speed in addition to quality/diversity/controllability

WorldX implication:

- GOG should be the single central mechanism
- state the two assumptions explicitly:
  1. semantic editing may be easier than precise coordinate serialization for open-ended targets
  2. controlled color edits provide a recoverable measurement signal
- repeat a subset multiple times
- report call count, latency, and cost

### 3.5 Holodeck / WorldGen / SceneFoundry

Observed pattern:

- system papers do not stop at visual examples
- evaluation combines artifact quality with downstream utility
- functional constraints such as traversability and collision are central
- downstream agent or navigation use provides stronger evidence than format validity

WorldX implication:

- “TMJ generated” is not enough
- the paper needs actual A* and approachability tests
- a qualitative gallery is supporting evidence only

## 4. Revised Contribution Structure

Current recommendation: reduce three parallel technical contributions to one primary method + one system + one evaluation contribution.

### C1 — Primary Method

**Generative Overlay Grounding (GOG)**

Query-conditioned image editing produces artificial color overlays; deterministic difference analysis recovers bbox/mask/grid.

### C2 — System

**Specification-to-Executable Map Compilation**

Natural language -> structured specification -> visual synthesis -> spatial recovery -> Tiled-compatible map.

### C3 — Evaluation / Benchmark Contribution

**Multi-level evaluation protocol for open-ended generated game maps**

- target presence
- bbox localization
- absent-target false positives
- traversability masks
- path reachability
- region reachability
- object approachability
- repair cost/latency

Functional traversability recovery should be described primarily as a system component unless its ablation evidence is strong enough to support a separate contribution claim.

## 5. Revised Main Experimental Design

### RQ1 — Synthesis Fidelity

Question:

> Does structured world-specification conditioning improve functional adherence of generated maps?

Methods:

- Raw Prompt
- Structured
- Full

Primary endpoints:

- Target Presence Rate
- Placement Relation Satisfaction
- Hard Constraint Violation Rate

Secondary:

- Human Functional Map Score

Design:

- paired prompts
- matched model/version/settings
- do not use the pipeline reviewer as primary judge

### RQ2 — Spatial Grounding (Primary Experiment)

Required methods:

- DirectCoord
- GridCoord
- **SoM-style segmentation/marking baseline**
- GOG
- GOG-V

Optional element-only baseline:

- open-vocabulary detector/grounder on the element subset

Why add SoM-style baseline:

- it is much closer to the actual methodological question than plain direct-coordinate prompting
- it tests whether GOG gains come from “having a visual mark interface” versus “generating the overlay from the semantic query”

Primary endpoint recommendation:

- **Recall@IoU 0.3** or **meanIoUAll**, choose one before the main test

Other metrics:

- NCE
- Recall@0.5
- Missing Rate
- absentFalsePositiveRate
- presenceAccuracy

Stratify:

- Region vs Element
- Small vs Large target
- Indoor / Outdoor / Mixed
- Chinese / English
- Low / High complexity

Statistics:

- paired bootstrap 95% CI
- Wilcoxon as supplement
- mixed-effects model for factors
- multiple-comparison control

### RQ3 — Runtime Navigational Validity

Primary endpoints:

- PRA
- RRR
- IOA

Secondary:

- Pixel IoU
- Boundary F1
- LCCR
- False Traversal Rate

Required analysis:

- show cases where pixel IoU is acceptable but navigation fails
- show cases where moderate pixel IoU still preserves path topology

### RQ4 — Repair Reliability and Cost

Matched comparison:

- same-run Attempt 1
- same-run Final

Metrics:

- Defect Resolution Rate
- New Defect Introduction Rate
- quality delta
- calls
- latency
- cost

Do not compare independently regenerated images as the main repair experiment.

## 6. Evidence Architecture

The paper should read as four linked proofs.

### Proof A — Need

Raster output lacks runtime structure.

Evidence:

- define executable output requirements
- show one example where PNG is visually plausible but lacks collision/regions/objects

### Proof B — Mechanism

GOG provides a measurable bridge from semantic reasoning to geometry.

Evidence:

- matched DirectCoord / GridCoord / SoM-style / GOG comparison
- human bbox gold
- error decomposition

### Proof C — System Utility

Recovered structures support game runtime behavior.

Evidence:

- A*
- region reachability
- object approachability

### Proof D — Reliability Boundary

Verification improves some failures at measurable cost and may abstain.

Evidence:

- same-run before/after
- outage-aware status
- risk/coverage
- latency/cost

## 7. T-Games Writing Style

### 7.1 Introduction

Target length: ~0.75–1.0 two-column page.

Recommended six-paragraph logic:

1. Capability: text-guided world/map generation is advancing.
2. Gap: generated raster maps do not contain executable runtime structure.
3. Why obvious solution fails: direct coordinate grounding is a separate bottleneck, especially for open-ended functional regions and small objects.
4. Key insight: use controlled semantic editing as an intermediate measurement signal.
5. System: specification -> synthesis -> GOG/traversability -> TMJ.
6. Contributions: 3 concise bullets.

Avoid:

- broad market motivation
- long history of PCG
- “AI is rapidly developing”
- inflated novelty adjectives
- describing all pipeline modules before the core gap

### 7.2 Related Work

Target length: ~0.75–1.0 two-column page.

Organize around unresolved boundaries, not author-by-author summaries:

- language-guided world generation
- visual grounding and marks
- image-difference / grounding-aware editing
- PCG evaluation

Each subsection must end with one sentence explaining the remaining gap.

### 7.3 Method

Target length: ~2.5–3.0 pages.

Order:

- problem formulation
- overview figure
- structured specification (brief)
- GOG (longest section)
- traversability recovery
- compilation

Put implementation constants in a compact table or supplement. Do not let threshold details dominate the conceptual story.

### 7.4 Experiments

Target length: ~3.0–3.5 pages.

Separate:

- benchmark and split
- baselines
- annotation
- metrics
- statistics
- implementation details

Results should mirror the RQs exactly.

### 7.5 Results and Discussion

Preferred pattern:

- one subsection per RQ
- open with the numeric answer
- table/figure
- effect size + CI
- mechanism interpretation
- one sentence on failure/limit

Do not write:

> “Table 3 shows our method performs well.”

Write:

> “GOG increased Recall@0.3 by Δ relative to DirectCoord under matched maps (95% CI ...), while the gain was concentrated in functional regions rather than small elements.”

## 8. Figure and Table Design

### Figures

Final manuscript figures should be:

- English-only
- vector-first (PDF/SVG/EPS where possible)
- legible at one- or two-column width
- minimal prose inside panels
- consistent colors across all figures
- captions self-contained

Current concept figures are useful drafts but not final IEEE figures because they contain too much explanatory text and are not optimized for two-column reduction.

Recommended final figures:

- Fig. 1: overall pipeline, two-column width
- Fig. 2: GOG mechanism, two-column width
- Fig. 3: matched grounding protocol + qualitative examples
- Fig. 4: walkability overlay -> grid -> A* path
- Fig. 5: failure taxonomy or risk-coverage curve

### Tables

Prioritize:

- Table I: benchmark composition
- Table II: RQ2 main grounding result
- Table III: stratified RQ2 result
- Table IV: navigation result
- Table V: repair cost-quality

Avoid a table for every implementation detail.

## 9. Immediate Changes Required for WorldX-Map v0.4

1. Retitle around executable structure recovery, not broad world generation.
2. Reframe Contribution 3 from a second mechanism to evaluation/benchmark unless RQ3 ablation is very strong.
3. Add SoM-style baseline to RQ2.
4. Pick one primary RQ2 endpoint before main testing.
5. Move most threshold constants to a compact table/supplement.
6. Rewrite Introduction to the six-paragraph T-Games structure.
7. Convert all final figures to English-only IEEE-compatible vector graphics.
8. Target 10 pages two-column; move runbook, full prompts, threshold sensitivity details, and extended qualitative galleries to supplement.
9. Keep Results blank until frozen experiments run.
10. Prepare a fully anonymized review manuscript.
