# WorldX Paper Experiments

This directory contains the reproducible experiment harness for the WorldX paper.

## 1. Self-test

```bash
node experiments/worldx-paper/self-test.mjs
```

This test uses a synthetic fixture and does not call external models.

## 2. Dry-run benchmark

```bash
node experiments/worldx-paper/run-benchmark.mjs --dry-run --limit 3
```

## 3. Run benchmark

Configure the same model environment variables required by WorldX, then run:

```bash
node experiments/worldx-paper/run-benchmark.mjs \
  --prompts experiments/worldx-paper/benchmark-prompts.v0.json \
  --limit 30
```

Each prompt is executed sequentially. The runner records process status, generation latency, detected world directory, stage-level validation, retention, and reachability metrics.

## 4. Run ablation variants

Variant definitions live in `variants.v0.json`.

Full system:

```bash
node experiments/worldx-paper/run-benchmark.mjs \
  --variant full \
  --limit 30
```

First-pass map without review-driven regeneration:

```bash
node experiments/worldx-paper/run-benchmark.mjs \
  --variant first_pass_no_repair \
  --limit 30
```

Remove structured map-plan, region, and interactive-element summaries from the map generation and review prompts:

```bash
node experiments/worldx-paper/run-benchmark.mjs \
  --variant no_map_structure_conditioning \
  --limit 30
```

## 5. Run the fixed matched pilot

First verify that the current runtime has the required generation credentials without printing secret values:

```bash
node experiments/worldx-paper/check-env.mjs
```

Then run the same five prompts across all three variants:

```bash
node experiments/worldx-paper/run-pilot.mjs \
  --id pilot-v0
```

This produces:

```text
experiments/worldx-paper/pilot-results/pilot-v0/
├── pilot-manifest.json
├── full/
├── first_pass_no_repair/
└── no_map_structure_conditioning/
```

Compare matched runs by prompt ID:

```bash
node experiments/worldx-paper/compare-pilot.mjs \
  --pilot experiments/worldx-paper/pilot-results/pilot-v0
```

The comparator writes:

```text
comparison.json
```

The pilot is intentionally small:

- 5 fixed prompts
- 3 variants
- 15 total generation attempts

Its purpose is to validate metric sensitivity and failure modes before expanding to 30 or 100 prompts.

## 6. Summarize

```bash
node experiments/worldx-paper/summarize-results.mjs \
  --input experiments/worldx-paper/results/<RUN>/runs.jsonl
```

## Metrics in v0

- stage success
- end-to-end executable success
- generation latency
- character / region / element retention
- walkable ratio
- reachable walkable ratio
- reachable region ratio
- reachable interactive element ratio

## Important scope

The autonomous agent runtime is treated as a downstream execution probe, not as a primary algorithmic contribution.
