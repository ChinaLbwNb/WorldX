# WorldX-Map Paper Experiments

This directory contains the reproducible experiment harness for the WorldX-Map paper.

The first frozen experiment is **RQ2**:

> Does generative overlay grounding improve spatial localization accuracy over direct coordinate prediction?

## Pilot scope

- 10 fixed prompts: `benchmark/pilot-prompts.json`
- 4 methods: `DirectCoord`, `GridCoord`, `GOG`, `GOG-V`
- Primary metrics: mean IoU over all present targets, normalized center error, Recall@0.3, missing rate
- Frozen protocol: `configs/rq2-pilot.json`

Do not silently edit a frozen prompt set or protocol after runs begin. Create a new version.

## Directory layout

```text
paper/worldx-map/
├── annotations/            # human gold labels
├── baselines/              # DirectCoord, GridCoord, GOG adapters
├── benchmark/              # frozen prompt and target specifications
├── configs/                # frozen experiment protocols
├── evaluation/             # deterministic metrics
└── runs/                   # local outputs; do not commit API secrets
```

## 1. Generate the ten pilot maps

Generate one world per fixed prompt. Preserve intermediate map artifacts.

Recommended environment setting:

```bash
KEEP_GENERATION_ARTIFACTS=1
```

For each map, retain at least:

```text
world-design.json
map/02-compressed-map.png
map/03-overlay-batch-*.png
map/03.2-overlay-batch-*.png
map/03-regions.json
map/03-elements.json
map/metadata.json
logs/map-pipeline.log
```

The RQ2 comparison must use the same `02-compressed-map.png` for all four methods.

## 2. Build a target specification

Create one target JSON per map using `benchmark/target-schema.example.json`.

Every planned region and interactive element must remain in the target list. Do not delete a target because it is missing from the rendered image.

## 3. Human annotation

Use `annotations/ground-truth.example.json`.

For each planned target:

- `present=true`: provide a pixel-space bounding box
- `present=false`: set `bbox=null`

For regions, box the visible functional footprint. For small interactive elements, tightly box the visible object.

The main study should use two independent annotators plus adjudication. The ten-map pilot may start with one annotator to validate plumbing, but those labels must not be presented as final inter-annotator evidence.

## 4. Run DirectCoord

```bash
node paper/worldx-map/baselines/direct-coord.mjs \
  --image output/worlds/<world>/map/02-compressed-map.png \
  --targets paper/worldx-map/runs/P01/targets.json \
  --out paper/worldx-map/runs/P01/direct.json
```

This baseline receives the unmodified map and predicts pixel bounding boxes directly.

## 5. Run GridCoord

```bash
node paper/worldx-map/baselines/grid-coord.mjs \
  --image output/worlds/<world>/map/02-compressed-map.png \
  --targets paper/worldx-map/runs/P01/targets.json \
  --grid-out paper/worldx-map/runs/P01/grid-overlay.png \
  --out paper/worldx-map/runs/P01/grid.json
```

This baseline receives the same map with the repository's artificial coordinate grid overlay.

## 6. Recover first-pass GOG predictions

```bash
node paper/worldx-map/baselines/gog-first-pass.mjs \
  --run output/worlds/<world>/map \
  --world-design output/worlds/<world>/world-design.json \
  --map-id P01 \
  --out paper/worldx-map/runs/P01/gog.json
```

This adapter reads only first-attempt overlay artifacts:

- `03-overlay-batch-N.png`
- `03.2-overlay-batch-N.png`

It then reruns deterministic color-difference extraction. No verifier result is used. This is the clean `GOG` condition.

## 7. Collect GOG-V predictions

```bash
node paper/worldx-map/baselines/gog-verified.mjs \
  --run output/worlds/<world>/map \
  --world-design output/worlds/<world>/world-design.json \
  --log output/worlds/<world>/logs/map-pipeline.log \
  --map-id P01 \
  --out paper/worldx-map/runs/P01/gog-v.json
```

The adapter audits the log. A confirmation-call failure is recorded as `verifier_unavailable`, even if legacy pipeline metadata says `reviewPassed=true`. This prevents fail-open events from being counted as successful verification.

## 8. Evaluate one map-method pair

```bash
node paper/worldx-map/evaluation/evaluate-bbox.mjs \
  --gold paper/worldx-map/runs/P01/gold.json \
  --pred paper/worldx-map/runs/P01/direct.json \
  --out paper/worldx-map/runs/P01/direct.metrics.json
```

Reported metrics:

- `meanIoUAll`: missing prediction counts as IoU 0
- `meanIoULocated`: localized predictions only
- `meanNCEAll`: missing prediction counts as NCE 1
- `meanNCELocated`: localized predictions only
- `recallAt03`
- `recallAt05`
- `missingRate`

The primary paper metrics are defined in `configs/rq2-pilot.json`.

## 9. Aggregate pilot metrics

```bash
node paper/worldx-map/evaluation/aggregate-bbox.mjs \
  --files paper/worldx-map/runs/P01/direct.metrics.json,paper/worldx-map/runs/P02/direct.metrics.json \
  --out paper/worldx-map/runs/direct.summary.json
```

Add all map-level metric files for a method. The aggregator pools target-level rows rather than averaging already-averaged map metrics.

## Go / Partial-Go / No-Go decision

The frozen decision rule lives in `configs/rq2-pilot.json`.

The pilot is diagnostic. It decides whether GOG remains the main paper contribution. It is not the final hypothesis test and should not be reported as confirmatory evidence.

## Experiment integrity rules

1. Same map image across all four methods.
2. Same target list across all four methods.
3. Missing rendered targets remain in the dataset.
4. Raw VLM responses are retained.
5. Model identifiers and timestamps are retained.
6. Verifier outages are never counted as passes.
7. Threshold changes require a versioned protocol.
8. Main-study test maps must be separated from threshold-development maps.
