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

## 4. Summarize

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
