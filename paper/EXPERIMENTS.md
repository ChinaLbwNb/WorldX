# WorldX Experimental Plan

## 0. Core thesis

WorldX studies **prompt-to-executable-world generation**: converting an open-ended natural-language description into a structured, grounded, runnable world.

The autonomous agent runtime is used as a downstream execution probe. It is **not** claimed as the primary algorithmic contribution.

---

## 1. Research questions

### RQ1 — End-to-end generation reliability

Can WorldX reliably transform diverse natural-language prompts into complete runnable worlds?

Recommended benchmark:
- 100 prompts
- 10 domains, 10 prompts per domain
- 3 random seeds per prompt when budget allows

Suggested domains:
1. historical
2. modern urban
3. science fiction
4. fantasy
5. mystery
6. disaster / survival
7. school / campus
8. workplace
9. social / relationship
10. surreal / open-ended

Metrics:
- World Design Success Rate
- Map Generation Success Rate
- Character Generation Success Rate
- Grounding Success Rate
- Config Synthesis Success Rate
- Runtime Boot Success Rate
- End-to-End Executable Success Rate
- Mean / p95 generation latency
- Mean retries per stage
- Estimated API cost per successful world

Primary metric:

`E2E Executable Success = runnable worlds / attempted prompts`

---

### RQ2 — Prompt and cross-modal alignment

Does the generated world preserve the user's intent across planning, visual generation, and runtime configuration?

Evaluate:
- Prompt ↔ World Design alignment
- Prompt ↔ Map alignment
- World Design ↔ Map alignment
- Character Description ↔ Character Asset alignment
- Planned Region ↔ Grounded Region alignment
- Planned Interactive Element ↔ Grounded Element alignment

Protocol:
- automatic VLM judge on full benchmark
- human evaluation on a stratified subset
- blind pairwise comparison where possible

Suggested 1–5 ratings:
- semantic fidelity
- visual coherence
- style consistency
- region recognizability
- interaction affordance plausibility

Do not rely on LLM/VLM-as-judge alone. Use a human-audited subset.

---

### RQ3 — Executability

Are generated worlds actually operational rather than merely visually plausible?

#### Static validity
- TMJ parse success
- collision layer validity
- region layer validity
- interactive object validity
- character anchor validity
- spawn validity

#### Spatial executability
- walkable area ratio
- reachable region ratio
- reachable interactive object ratio
- spawn-to-region path success
- spawn-to-object path success

Recommended deterministic probe:
- sample target regions / objects
- run A* or the project's navigation logic from spawn
- report success rate and path length

#### Runtime executability
- server boot success
- crash-free 100-tick rollout
- crash-free 500-tick rollout
- valid action rate
- invalid target rate
- navigation completion rate

The agent runtime is an execution probe here, not a claimed contribution.

---

### RQ4 — Cross-stage consistency

Does information survive the complete pipeline?

Trace:

`User Prompt → World Design → Generated Map → Vision Grounding → TMJ → Runtime Config`

Metrics:
- Planned Region Retention Rate
- Planned Element Retention Rate
- Region ID Consistency
- Element ID Consistency
- Character Asset / Config Match Rate
- Character Anchor Validity
- Runtime Location Coverage

For a manually annotated subset:
- region localization IoU
- element localization IoU

A key example should trace one entity such as:

`pawn shop → generated visual region → detected region box → TMJ region → runtime location`

---

### RQ5 — Robustness and efficiency

How does the pipeline behave under prompt complexity and model stochasticity?

Stratify prompts by:
- number of characters
- number of regions
- number of interactive elements
- visual style complexity
- instruction length

Metrics:
- E2E success by complexity bucket
- retries by complexity bucket
- latency
- token usage
- image calls
- vision calls
- total estimated cost

---

## 2. Main baselines

### B0 — Raw Prompt → Map

Use the raw user prompt directly for map generation. No structured world planning. Produce a generic runtime config.

Purpose:
- test whether the structured planning stage is necessary

### B1 — Structured Plan, No Review/Repair

Use WorldX structured world planning and first-pass asset generation, but disable visual review-driven retries.

Purpose:
- isolate the value of the self-feedback loop

### B2 — Structured Plan + Generation, No Semantic Grounding

Generate map assets but replace region/element grounding with a generic single-location runtime config.

Purpose:
- test whether grounding is necessary for agent-ready worlds

### B3 — Full WorldX

Complete pipeline.

Important:
- do not force direct quantitative comparison with systems whose task, modality, or runtime contract is materially different
- use such systems mainly for related work or qualitative discussion unless an equivalent benchmark can be constructed

---

## 3. Ablation study

### A0 — Full WorldX

Reference system.

### A1 — w/o Structured World Planning

Remove the LLM-generated structured world specification.
Condition downstream generation only on the raw user prompt.

Expected tests:
- prompt alignment
- cross-stage consistency
- E2E executability

### A2 — w/o Structured Region / Element Conditioning

Keep the world planner, but remove map-plan, region, and interactive-element summaries from map generation conditioning.

Expected tests:
- planned region retention
- planned element retention
- world-design ↔ map consistency

### A3 — w/o Visual Review-and-Repair Loop

Use the first generated map without review-driven prompt adjustment and regeneration.

Current implementation evidence:
- Step 1 generates a map
- a vision model reviews it
- failed reviews can be converted into additional constraints
- generation retries with accumulated constraints

Expected tests:
- map quality
- prompt alignment
- E2E success
- latency / cost trade-off

### A4 — w/o Region Grounding

Disable designed-region localization / confirmation.
Use a generic location mapping or another explicitly documented heuristic baseline.

Expected tests:
- runtime location coverage
- region reachability
- cross-stage consistency

### A5 — w/o Interactive Element Grounding

Disable element localization.

Expected tests:
- grounded element coverage
- reachable interactive object ratio
- valid interaction rate

### A6 — w/o Walkability Grounding

Replace the vision-derived walkability map with a documented heuristic baseline.

Expected tests:
- path success
- unreachable target rate
- collision validity

### A7 — w/o Shared Cross-Stage Specification

Let map and character generation consume only the raw prompt rather than a shared structured world design.

Expected tests:
- map-character style consistency
- character-world consistency
- region / character semantic coherence

### Optional efficiency ablation — sequential vs parallel asset generation

This is an efficiency study rather than a core quality contribution.
Measure:
- wall-clock latency
- failure isolation

---

## 4. Minimum result tables

### Table 1 — End-to-end reliability

Columns:
- Method
- Design Success
- Map Success
- Character Success
- Grounding Success
- Runtime Boot
- E2E Executable Success

### Table 2 — Alignment

Columns:
- Method
- Prompt↔Design
- Prompt↔Map
- Design↔Map
- Character↔World
- Human Preference

### Table 3 — Executability

Columns:
- Method
- Valid TMJ
- Reachable Regions
- Reachable Objects
- Navigation Success
- Crash-Free 500 Ticks

### Table 4 — Ablation

Rows:
- Full
- w/o Planner
- w/o Region/Element Conditioning
- w/o Review/Repair
- w/o Region Grounding
- w/o Element Grounding
- w/o Walkability Grounding

Columns:
- E2E Success
- Alignment
- Region Retention
- Object Reachability
- Navigation Success
- Cost

### Table 5 — Efficiency

Columns:
- Method
- Latency Mean
- Latency p95
- Image Calls
- Vision Calls
- Retries
- Estimated Cost

---

## 5. Statistical protocol

Recommended:
- multiple random seeds for stochastic generation
- report mean and confidence interval where meaningful
- pairwise tests for matched prompts
- bootstrap confidence intervals for human preference and success-rate differences
- predefine failure criteria before running the benchmark

Do not select only successful demos.

---

## 6. Required engineering work before claiming results

1. Build a fixed prompt benchmark file.
2. Add deterministic run IDs / seed recording where supported.
3. Add an experiment runner that records stage-level success/failure.
4. Add machine-readable metrics JSON per run.
5. Add static world validator.
6. Add deterministic navigation probe.
7. Add runtime rollout harness.
8. Add ablation flags rather than manually editing code between runs.
9. Add cost / latency logging.
10. Freeze model versions and prompts for the final experiment.

---

## 7. Paper-writing rule

Do not write claims such as "improves", "outperforms", "significantly", or "robust" until the corresponding experiment is complete.

The paper should be written around the measured evidence, not around README marketing language.
