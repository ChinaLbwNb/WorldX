# WorldX Research Log

This file records each research step using the same structure:

- **Action**: what was changed or inspected
- **Evidence**: concrete repository artifacts, code paths, measurements, or test outputs
- **Conclusion**: what can currently be claimed
- **Do not conclude**: claims that are not yet supported
- **Next step**: the next falsifiable action

The log is append-only in spirit. When a conclusion changes, add a new entry rather than silently rewriting history.

---

## 2026-07-07 — Step 1: Define the research contribution boundary

### Action

Reviewed the WorldX README and core orchestration/runtime code to determine which parts are original research contributions.

### Evidence

- README describes one-sentence world generation, map/character generation, autonomous agents, memory, multi-day evolution, god mode, and timelines.
- The project uses a generative-agent-style runtime inspired by existing Stanford Generative Agents / small-town agent work.
- The user explicitly clarified that the autonomous agent world component is based on others' work and is not a novel contribution.

### Conclusion

The paper should **not** claim a novel autonomous-agent architecture, novel memory mechanism, or novel social simulation method.

The current research scope is:

> Natural-language prompt → structured world design → multimodal asset generation → grounding → executable runtime configuration.

The downstream agent runtime is treated as an execution substrate / execution probe.

### Do not conclude

- WorldX introduces a new generative-agent architecture.
- WorldX introduces a new agent memory method.
- WorldX introduces a new emergent-social-simulation algorithm.

### Next step

Define one core paper claim and a small number of contribution points around the generation pipeline.

---

## 2026-07-07 — Step 2: Define the paper claim structure

### Action

Separated the single core claim from supporting contribution points.

### Evidence

The repository contains distinct stages for:

1. LLM-based structured world design.
2. Map and character asset generation.
3. Vision-based region, element, and walkability processing.
4. TMJ and runtime configuration synthesis.

### Conclusion

Current core claim hypothesis:

> Open-ended natural-language descriptions can be transformed into executable agent worlds through a structured multi-stage generation and grounding pipeline.

Current contribution hypotheses:

1. Structured semantic world planning.
2. Multimodal generation and grounding.
3. Executable runtime configuration synthesis.

These are **hypotheses pending experiments**, not established results.

### Do not conclude

- The pipeline improves quality over baselines.
- The pipeline is robust.
- The pipeline outperforms prior systems.

No such conclusion is valid before experiments.

### Next step

Design experiments that can falsify each contribution hypothesis.

---

## 2026-07-07 — Step 3: Switch to experiment-first paper workflow

### Action

Changed the paper workflow from "write sections first" to "design experiments first".

### Evidence

Created:

- `paper/EXPERIMENTS.md`

The plan defines:

- RQ1: end-to-end reliability
- RQ2: prompt and cross-modal alignment
- RQ3: executability
- RQ4: cross-stage consistency
- RQ5: robustness and efficiency

It also defines candidate baselines, ablations, result tables, and statistical protocol.

### Conclusion

WorldX should be evaluated as a **system pipeline**, not by demos alone.

The minimum evidence must include:

- end-to-end success
- alignment
- executability
- cross-stage consistency
- ablation
- efficiency / cost

### Do not conclude

- The paper is ready because the system works in demos.
- Attractive generated examples are sufficient evidence.

### Next step

Build a reproducible experiment harness before writing result claims.

---

## 2026-07-07 — Step 4: Build benchmark prompt set v0

### Action

Created:

- `experiments/worldx-paper/benchmark-prompts.v0.json`

Current v0 composition:

- 30 prompts
- 10 domains
- 3 prompts per domain

Domains:

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

### Evidence

The benchmark file is committed on branch `paper/worldx-v0`.

### Conclusion

The prompt benchmark is sufficient for **harness smoke testing and small pilot experiments**.

### Do not conclude

- 30 prompts are sufficient for final publication-quality generalization claims.
- The benchmark is representative of all open-ended world-generation requests.

### Next step

Run pilot experiments, inspect failure modes, then expand to a frozen larger benchmark, likely 100+ prompts.

---

## 2026-07-07 — Step 5: Build world-output validator and reachability metrics

### Action

Created:

- `experiments/worldx-paper/lib/validate-world.mjs`

The validator checks expected generated artifacts and computes static execution metrics.

### Evidence

The validator reads/checks:

- `world-design.json`
- `map/06-final.tmj`
- `map/06-background.png`
- `config/world.json`
- `config/scene.json`
- `config/characters/*.json`

It computes:

- stage success
- end-to-end executable flag
- character / region / element retention ratios
- walkable ratio
- reachable walkable ratio
- reachable region ratio
- reachable element ratio
- spawn validity

Reachability is computed from the collision grid using deterministic graph traversal rather than LLM-agent behavior.

### Conclusion

The experiment infrastructure can evaluate whether a generated world is structurally present and spatially reachable without conflating map quality with LLM-agent intelligence.

### Do not conclude

- A world marked executable by this validator is behaviorally rich.
- A static reachability pass proves successful long-horizon runtime behavior.
- The validator has been validated on a large corpus of real generated worlds.

### Next step

Run the validator on real generated outputs and compare automatic decisions with manual inspection.

---

## 2026-07-07 — Step 6: Add validator self-test fixture

### Action

Created:

- `experiments/worldx-paper/self-test.mjs`

The test constructs a synthetic 5×5 world fixture with:

- collision grid
- region
- interactive element
- spawn
- world config
- scene config
- character config

It also creates a deliberately broken collision layer.

### Evidence

Repository-side evidence confirms the self-test code contains assertions for:

- valid world → `valid === true`
- valid world → `e2eExecutable === true`
- reachable region ratio → `1`
- reachable element ratio → `1`
- broken collision length → `valid === false`

### Conclusion

The repository now contains a positive and negative test specification for the validator.

### Do not conclude

Important evidence caveat:

- Presence of the self-test code is not the same as a reproducibly captured CI execution result.
- Until CI or a committed test log records execution, do not claim repository-level automated test pass status solely from file existence.

### Next step

Add CI or a reproducible local test command whose output is captured in experiment logs.

---

## 2026-07-07 — Step 7: Build sequential benchmark runner

### Action

Created:

- `experiments/worldx-paper/run-benchmark.mjs`

### Evidence

The runner:

- reads the prompt benchmark
- invokes the existing `orchestrator/src/index.mjs`
- detects newly created world directories
- records process exit status
- records duration
- runs the world validator
- writes per-run JSON
- writes stdout/stderr logs
- appends `runs.jsonl`

### Conclusion

The repository now has a reproducible harness design for stage-level and end-to-end measurements.

### Do not conclude

- Real 30-prompt or 100-prompt benchmark results exist.
- Real model E2E success rate is known.

No real large-scale model run has yet been recorded in this research log.

### Next step

Run a small real-model pilot before scaling.

---

## 2026-07-07 — Step 8: Build result summarizer

### Action

Created:

- `experiments/worldx-paper/summarize-results.mjs`

### Evidence

The summarizer aggregates:

- process success rate
- E2E executable success rate
- stage success rates
- mean latency
- p95 latency
- retention metrics
- spatial metrics
- per-domain summaries

### Conclusion

The experiment pipeline can convert per-run JSONL into paper-table-ready aggregate metrics.

### Do not conclude

- Any aggregate number is meaningful before real runs exist.

### Next step

Use the same summarizer for full-system and ablation runs.

---

## 2026-07-07 — Step 9: Add initial ablation variants

### Action

Created:

- `experiments/worldx-paper/variants.v0.json`

Current variants:

1. `full`
2. `first_pass_no_repair`
3. `no_map_structure_conditioning`

Also added one experiment-only environment flag in:

- `generators/map/src/steps/step1-generate-map.mjs`

Flag:

- `WORLDX_ABLATION_DISABLE_MAP_STRUCTURE_CONDITIONING=1`

### Evidence

`first_pass_no_repair` sets:

- `STEP1_MAX_RETRIES=0`

`no_map_structure_conditioning` removes:

- map plan summary
- region summary
- interactive-element summary

from the map generation/review conditioning path.

### Conclusion

Two important hypotheses can now be tested:

1. Does review-driven regeneration improve final outcomes enough to justify cost/latency?
2. Does structured map conditioning improve alignment, retention, or executability?

### Do not conclude

- Either ablation is worse than full WorldX.
- The review loop improves quality.
- Structured conditioning improves quality.

These remain unanswered until matched experiments are run.

### Next step

Run matched prompt sets across the three variants and compare the same metrics.

---

## 2026-07-07 — Step 10: Verify branch-level change scope

### Action

Compared:

- base: `main`
- head: `paper/worldx-v0`

### Evidence

At the time of comparison, the branch was ahead of `main` and not behind.

Most changes were new files under:

- `paper/`
- `experiments/worldx-paper/`

One core-generation file was modified only to add the experiment ablation switch:

- `generators/map/src/steps/step1-generate-map.mjs`

Default full behavior remains active unless the ablation environment variable is explicitly set.

### Conclusion

The experiment work is isolated on a dedicated paper branch, and the first core-code modification is experiment-gated.

### Do not conclude

- The branch is production-ready.
- The ablation switch has been proven behavior-preserving under all conditions.

### Next step

Add regression checks for `full` variant behavior and begin real pilot runs.

---

## Current overall conclusion

### Supported now

- The research contribution boundary is defined.
- The paper is experiment-first.
- A v0 benchmark exists.
- A static validator exists.
- Reachability metrics exist.
- A batch runner exists.
- A summarizer exists.
- Initial ablation variants exist.

### Not supported yet

- Real E2E success rate.
- Evidence that full WorldX beats baselines.
- Evidence that review/repair improves results.
- Evidence that structured conditioning improves results.
- Publication-quality robustness claims.
- Publication-quality generalization claims.

### Immediate next action

Run a small matched real-model pilot across:

- `full`
- `first_pass_no_repair`
- `no_map_structure_conditioning`

using the same prompt subset, then append the observed results and conclusions to this log.
