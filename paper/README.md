# WorldX Paper Workspace

Current thesis:

WorldX studies prompt-to-executable-world generation: converting natural language intent into structured, grounded, runnable worlds.

Contribution boundary:

1. Structured world planning.
2. Multimodal generation and grounding.
3. Executable runtime configuration synthesis.

The autonomous agent runtime is an execution probe, not the main contribution.

## Research logging rule

Every research step must append a conclusion entry to `RESEARCH_LOG.md`.

A step is not considered complete until the log records:

1. **Action** — what changed or was inspected.
2. **Evidence** — concrete code, artifacts, measurements, or test outputs.
3. **Conclusion** — what the evidence currently supports.
4. **Do not conclude** — claims that remain unsupported.
5. **Next step** — the next falsifiable action.

When later evidence changes an earlier conclusion, append a new entry rather than silently rewriting history.

## Status

- [x] Initial paper skeleton
- [x] Experiment plan
- [x] v0 benchmark prompt set
- [x] Static world validator
- [x] Reachability metrics
- [x] Sequential benchmark runner
- [x] Result summarizer
- [x] Initial ablation variants
- [x] Evidence-based research log
- [ ] Real-model pilot benchmark
- [ ] Full benchmark
- [ ] Human evaluation
- [ ] Main ablation table
- [ ] System figure
- [ ] Final paper results
