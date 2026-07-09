# WorldX-Map Multi-Venue Publication Strategy v0.1

> Date: 2026-07-09
> Principle: do not lock the paper to one journal or one novelty story before empirical results. Maintain one shared research asset pool and multiple venue-compatible narratives.

## 1. Shared Research Asset Pool

All routes reuse the same core assets:

- frozen prompt benchmark
- structured world specifications
- generated map artifacts
- region / element human bbox gold
- present / absent labels
- walkability masks
- A* and reachability evaluator
- DirectCoord / GridCoord / SoM-style / GOG / GOG-V outputs
- latency / call count / cost logs
- model provenance and commit hashes

The asset pool is stable; the paper narrative is selected after Pilot and Main Study results.

## 2. Route A — Game Systems / PCG

### Core story

Natural-language world specification -> visual map -> executable game structure.

### Main question

Can open-ended generated maps be compiled into runtime-consumable spatial structures with measurable functional validity?

### Candidate venues

- IEEE Transactions on Games
- Entertainment Computing
- Games: Research and Practice

### Required evidence

- structured vs raw synthesis
- runtime A* tests
- required-region reachability
- object approachability
- human functional map evaluation
- repair cost / reliability

### When to choose

Choose this route if:

- end-to-end executability is strong
- navigation metrics are convincing
- GOG is useful but not necessarily dominant

### Primary contribution structure

1. specification-to-executable map compilation
2. generative grounding as a system mechanism
3. multi-level functional evaluation

## 3. Route B — Visual Grounding / Multimedia

### Core story

Query-conditioned image editing creates a controlled visual measurement signal for spatial grounding.

### Main question

Does generative overlay grounding outperform direct coordinate prediction and mark-based alternatives on open-ended stylized targets?

### Candidate venues

- IEEE Transactions on Multimedia
- ACM Transactions on Multimedia Computing, Communications, and Applications
- multimedia / multimodal special issues where scope matches

### Required evidence

- DirectCoord
- GridCoord
- SoM-style baseline
- GOG
- GOG-V
- region / element stratification
- small / large target stratification
- cross-model editor / verifier subset
- ideally one non-game image domain for external validity

### When to choose

Choose this route if:

- GOG clearly wins or has a strong robustness advantage
- the effect generalizes across models or at least across multiple visual styles
- a second non-game benchmark confirms the mechanism is not game-map-specific

### Primary contribution structure

1. GOG method
2. deterministic difference recovery
3. evaluation benchmark for open-ended stylized grounding

### Risk

Without cross-domain evidence, a general multimedia journal may view the method as too game-specific.

## 4. Route C — Graphics / Visual Computing

### Core story

Open-ended raster map synthesis followed by structural recovery and engine-compatible compilation.

### Main question

Can visually generated stylized maps be converted into editable, navigable 2D scene representations while preserving open-ended appearance?

### Candidate venues

- IEEE Transactions on Visualization and Computer Graphics (stretch)
- Computers & Graphics
- The Visual Computer

### Required evidence

- strong visual examples
- structure recovery accuracy
- editability / runtime representation
- navigation validity
- failure analysis
- reproducibility artifact

### When to choose

Choose this route if:

- visual synthesis quality is strong
- recovered structures are stable
- system figures and qualitative comparisons are compelling
- GOG alone is not strong enough for a general grounding paper

### Risk

TVCG is a stretch unless the graphics/visual-computing contribution becomes broader and deeper than the current game-map system.

## 5. Route D — Applied AI / General Intelligent Systems

### Core story

A modular multimodal agent pipeline converts unconstrained language into executable spatial representations with verification and abstention.

### Candidate venues

- broader applied AI journals, selected only after final results and scope check

### Required evidence

- cross-model generalization
- robustness
- ablation
- cost / latency
- strong reproducibility

### When to choose

Choose this route if:

- the end-to-end system is strong
- venue-specific game or graphics framing is less compelling

## 6. Result-Driven Decision Rules

### Case 1 — GOG wins strongly

Observed pattern:

- higher primary grounding endpoint
- lower missing rate or NCE
- no major absent-target false-positive penalty
- stable across region / element groups

Decision:

- prioritize Route B
- keep Route A as fallback
- add cross-model and non-game subset before submission

### Case 2 — GOG is mixed, end-to-end runtime is strong

Observed pattern:

- GOG only wins on some target types
- TMJ runtime, A*, RRR, IOA are strong
- structured specification materially helps

Decision:

- prioritize Route A
- frame GOG as one mechanism, not the sole novelty

### Case 3 — Visual system is strong, runtime is moderate

Observed pattern:

- high-quality generated maps
- useful structural recovery
- compelling qualitative figures
- navigation evidence not dominant

Decision:

- prioritize Route C, especially Computers & Graphics / The Visual Computer

### Case 4 — GOG fails

Observed pattern:

- DirectCoord / SoM-style dominates GOG

Decision:

- do not force GOG
- pivot to specification-to-executable compilation
- retain GOG as negative result / ablation / engineering mechanism only

### Case 5 — End-to-end system also weak

Decision:

- do not submit prematurely
- narrow to benchmark / evaluation contribution only if that asset is genuinely strong

## 7. What Must Not Be Frozen Yet

Do not freeze before Pilot/Main Study:

- final title
- final journal
- final primary novelty wording
- whether Functional Traversability is a contribution or a component
- whether GOG is the headline method
- whether the paper is game-system-first or grounding-first

## 8. What Should Stay Frozen

Keep frozen:

- no fabricated results
- same-map comparison for grounding methods
- human gold independent from pipeline reviewer
- absent targets remain in the denominator / false-positive analysis
- Pilot / Dev / Test separation
- model / commit provenance
- no Test-time threshold tuning

## 9. Immediate Operational Change

The next manuscript version should be venue-neutral at the research-core level.

Maintain three front-matter variants:

- `intro_games.md`
- `intro_grounding.md`
- `intro_graphics.md`

Maintain one shared Method core.

Maintain one shared experiment repository, with optional route-specific add-ons:

- Game route add-on: runtime evaluator and human functional score
- Grounding route add-on: SoM-style baseline, cross-model, non-game subset
- Graphics route add-on: editability study, richer qualitative analysis, vector figures

The final target venue is selected only after the evidence profile is visible.
