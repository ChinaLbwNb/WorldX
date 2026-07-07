# Step 11 — Real-model matched pilot setup

Date: 2026-07-07

## Action

Built a fixed matched pilot protocol for the first real-model experiment.

Added:

- `experiments/worldx-paper/pilot-prompts.v0.json`
- `experiments/worldx-paper/check-env.mjs`
- `experiments/worldx-paper/run-pilot.mjs`
- `experiments/worldx-paper/compare-pilot.mjs`

The pilot uses the same five prompts across the same three variants:

1. `full`
2. `first_pass_no_repair`
3. `no_map_structure_conditioning`

The selected prompts cover:

- historical
- modern urban
- science fiction
- mystery
- social / relationship

## Evidence

Local syntax checks were executed with Node.js v22.16.0:

- `check-env.mjs` — syntax check passed
- `run-pilot.mjs` — syntax check passed
- `compare-pilot.mjs` — syntax check passed

The environment preflight was executed in the current task execution environment and returned:

- `ORCHESTRATOR_API_KEY`: absent
- `IMAGE_GEN_API_KEY`: absent
- `VISION_API_KEY`: absent
- `SIMULATION_API_KEY`: absent

The preflight exited with code `2`, as designed when required generation credentials are unavailable.

The pilot comparator is matched by prompt ID: ablated runs are paired with the corresponding `full` run for the same prompt before deltas are computed.

A synthetic matched-comparison test was executed with three prompt IDs across all three variants. The test asserted:

- matched pair count = `3`
- `first_pass_no_repair.deltaE2E = -1/3`
- `first_pass_no_repair.deltaLatencyMs = -40`
- `no_map_structure_conditioning.deltaRegionRetention = -1/3`

All assertions passed.

## Conclusion

The repository now has a concrete, fixed pilot protocol for comparing the same prompts across three variants.

The matched comparator has passed a synthetic logic test for prompt pairing and selected delta calculations.

The current task execution environment is **not capable of running the real-model pilot** because the required generation credentials are unavailable there.

This is an environment limitation, not evidence that the WorldX project configuration is missing on the user's own machine.

## Do not conclude

- The real-model pilot has run.
- The full system is better than either ablation.
- Review-driven regeneration improves quality.
- Structured map conditioning improves quality.
- The pilot scripts are production-ready solely because syntax and synthetic checks passed.

## Next step

Run the environment preflight in a WorldX runtime that has the configured model credentials.

If preflight passes:

1. run `5 prompts × 3 variants = 15 world-generation attempts`;
2. generate `comparison.json` using the matched comparator;
3. manually inspect all failures and at least one success per domain;
4. append Step 12 with measured results and explicit supported / unsupported conclusions.
