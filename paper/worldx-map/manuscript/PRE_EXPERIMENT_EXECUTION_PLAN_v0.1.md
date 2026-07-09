# WorldX-Map Pre-Experiment Execution Plan v0.1

> Date: 2026-07-09
> Goal: finish the last venue-neutral evidence layer before spending model budget.

## 1. Immediate Priority

Do not write another venue-specific manuscript yet. Do not run the 60-prompt benchmark yet.

The next step is to freeze a **shared evidence core** that supports multiple publication routes:

- Game Systems / PCG
- Visual Grounding / Multimedia
- Graphics / Visual Computing

## 2. Phase A — Evidence Matrix Freeze

Create one claim-to-evidence table with route-neutral claims.

### Shared Claim S1 — Specification Fidelity

Question:

> Does structured world specification improve target presence, placement adherence, and hard-constraint compliance?

Required evidence:

- Raw vs Structured vs Full
- same prompt set
- independent presence / placement / violation annotation

### Shared Claim S2 — Spatial Grounding

Question:

> Does GOG improve open-ended target localization relative to coordinate and mark-based alternatives?

Required methods:

- DirectCoord
- GridCoord
- SoM-style baseline
- GOG
- GOG-V

Required evidence:

- same frozen maps
- same target lists
- human present/absent + bbox gold
- missing predictions remain in denominator
- absent-target false positives reported

### Shared Claim S3 — Runtime Structure Utility

Question:

> Do recovered walkability and spatial structures preserve downstream navigation and interaction access?

Required evidence:

- human walkability mask
- A* reachability
- required-region reachability
- object approachability
- false traversal analysis

### Shared Claim S4 — Reliability / Cost

Question:

> What does verification-guided repair fix, what new errors does it introduce, and what does it cost?

Required evidence:

- same-run Attempt 1 vs Final
- independent defect labels
- calls / latency / cost
- verifier_unavailable separated from pass

## 3. Phase B — Pilot Benchmark Freeze

Use the existing 10-prompt pilot only as a diagnostic set.

Do not expand to 60 prompts before validating:

- artifact retention
- target extraction
- baseline parity
- annotation schema
- evaluator correctness
- model call stability

Pilot output decision:

- `plumbing_pass`
- `protocol_revision_required`
- `method_signal_positive`
- `method_signal_mixed`
- `method_signal_negative`

The pilot does not determine a final journal.

## 4. Phase C — Annotation Handbook

Before real model runs at scale, write an annotation handbook covering:

### Presence

- present
- absent
- ambiguous

### Region bbox

Box the visible functional footprint, not decorative surroundings.

### Element bbox

Tight box around the visible object.

### Walkability

- walkable
- blocked
- ambiguous / ignore

### Adjudication

Do not average conflicting boxes blindly.

Required reliability outputs:

- Cohen's kappa for presence
- annotator-to-annotator bbox IoU distribution
- walkability mask agreement

## 5. Phase D — Baseline Completeness

Current implemented shared methods:

- DirectCoord
- GridCoord
- GOG
- GOG-V

Next required baseline:

- SoM-style segmentation + mark interface

Reason:

This baseline separates two possible explanations:

1. GOG works because visual marks help grounding.
2. GOG works because the semantic query itself generates the overlay that is later measured.

Without this baseline, the main method claim is underdetermined.

Optional route-specific baseline:

- open-vocabulary detector / grounder on element-only targets

## 6. Phase E — Primary Endpoint Freeze

Before the Main Study, select exactly one primary RQ2 endpoint.

Recommended candidates:

- Recall@IoU 0.3
- meanIoUAll

Decision rule:

- choose Recall@IoU 0.3 if coverage / missing risk is the conceptual focus
- choose meanIoUAll if geometric precision is the conceptual focus

Do not select after seeing Main Test results.

## 7. Phase F — Result-Driven Route Decision

### Route A — Games / PCG

Choose if:

- runtime navigation evidence is strongest
- specification conditioning is useful
- GOG is mixed or only locally strong

### Route B — Grounding / Multimedia

Choose if:

- GOG clearly beats matched coordinate and mark baselines
- effect persists across target types / styles / models

### Route C — Graphics / Visual Computing

Choose if:

- visual synthesis + structure recovery + editability are strongest
- runtime and grounding signals are moderate

## 8. Immediate Deliverables Before API Keys

1. Annotation handbook v0.1
2. Claim–Evidence Matrix v0.2
3. SoM-style baseline design spec
4. Primary endpoint decision memo
5. Pilot readiness checklist
6. Three route-specific Introduction skeletons

## 9. API-Key Trigger

Ask for real model credentials only when all conditions are true:

- pilot prompt set frozen
- target schema frozen
- human annotation template frozen
- DirectCoord/GridCoord/GOG/GOG-V interfaces stable
- SoM-style baseline protocol fixed
- evaluator tests passing
- model provenance logging enabled

At that point, run only P01 first.

Do not run all ten prompts immediately.

## 10. Recommended Next Action

The very next task is:

> Write the annotation handbook and SoM-style baseline design, then update the RQ2 protocol from four methods to five matched methods.

This is the highest-value work that does not require API keys and directly reduces future reviewer objections.
