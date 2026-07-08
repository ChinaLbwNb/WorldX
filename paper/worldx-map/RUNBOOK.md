# RQ2 Pilot Runbook

This is the shortest end-to-end path from frozen prompts to pilot metrics.

## Preconditions

- Install the repository dependencies.
- Configure the same WorldX model environment variables used by normal generation.
- Keep model identifiers fixed during one pilot version.
- Do not edit `benchmark/pilot-prompts.json` or `configs/rq2-pilot.json` after runs begin.

The actual map generation and DirectCoord/GridCoord calls require valid model API credentials. GOG extraction and bbox evaluation are deterministic once artifacts exist.

## A. Smoke test one map

Generate only P01 and retain all intermediate artifacts:

```bash
npm run paper:rq2:generate -- --only P01
```

The command writes:

```text
paper/worldx-map/runs/pilot-manifest.json
```

Run all four methods for P01:

```bash
npm run paper:rq2:run -- --only P01
```

Expected local outputs:

```text
paper/worldx-map/runs/P01/
├── targets.json
├── direct.json
├── grid.json
├── grid-overlay.png
├── gog.json
└── gog-v.json
```

Initialize an annotation file:

```bash
npm run paper:rq2:init-gold -- \
  --targets paper/worldx-map/runs/P01/targets.json \
  --annotator A1 \
  --out paper/worldx-map/runs/P01/gold.json
```

Edit `gold.json` manually:

- set `annotationStatus` to `complete` only when every target has been reviewed
- `present=true` requires a pixel bbox
- `present=false` requires `bbox=null`
- do not delete absent requested targets

Evaluate the completed P01 annotation:

```bash
npm run paper:rq2:pilot-eval -- --only P01
```

## B. Full ten-map pilot

Generate all frozen maps sequentially:

```bash
npm run paper:rq2:generate
```

Resume safely after an interruption:

```bash
npm run paper:rq2:generate
```

Successful map IDs already recorded in the manifest are skipped by default.

Run all four methods for successful maps:

```bash
npm run paper:rq2:run
```

The batch runner also resumes successful method-map pairs by default.

Initialize one gold file per map. Example:

```bash
for id in P01 P02 P03 P04 P05 P06 P07 P08 P09 P10; do
  npm run paper:rq2:init-gold -- \
    --targets paper/worldx-map/runs/$id/targets.json \
    --annotator A1 \
    --out paper/worldx-map/runs/$id/gold.json
done
```

After annotation is complete:

```bash
npm run paper:rq2:pilot-eval
```

Primary output:

```text
paper/worldx-map/runs/pilot-summary.json
```

## C. Failure isolation

Continue generation after a failed map:

```bash
npm run paper:rq2:generate -- --continue-on-error 1
```

Continue method execution after a failed method-map pair:

```bash
npm run paper:rq2:run -- --continue-on-error 1
```

Rerun one method on one map:

```bash
npm run paper:rq2:run -- --only P01 --methods direct --resume 0
```

## D. Integrity checks before reading results

Verify all of the following before looking at aggregate metrics:

1. All four methods used the same `02-compressed-map.png` per map.
2. All four methods used the same `targets.json` per map.
3. Raw DirectCoord and GridCoord model responses are preserved.
4. `GOG` was reconstructed from first-pass overlay artifacts without verifier output.
5. `GOG-V` records verifier outages as `verifier_unavailable`.
6. Every gold target was reviewed; absent targets were retained.
7. No extraction threshold was changed after viewing pilot aggregate metrics.

## E. Decision

Apply the frozen rule in `configs/rq2-pilot.json`:

- **Go**: retain GOG as the main paper contribution.
- **Partial-Go**: narrow the claim to robustness if precision does not improve.
- **No-Go**: do not force GOG as the main contribution; pivot the paper toward specification-to-executable compilation.
