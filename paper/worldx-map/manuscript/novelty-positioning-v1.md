# WorldX-Map Novelty Positioning v1

> Status: working comparison matrix for manuscript revision. Claims are deliberately narrow; no "first" claim.

| Work | Year | Primary task | Uses explicit visual marks | Requires model internals | Training / new data | Geometry source | Main distinction from GOG |
|---|---:|---|---|---|---|---|---|
| Set-of-Mark Prompting | 2023 | LMM visual reasoning / grounding | Yes; marks over pre-segmented regions | No for LMM, but uses external segmentation | No task-specific LMM training | Off-the-shelf segmentation regions | SoM starts with segmentation then adds marks; GOG asks an image editor to generate the semantic mark and recovers geometry from output differences |
| Visual Position Prompt (VPP-LLaVA) | 2025 | MLLM visual grounding | Position prompts / axis-like spatial cues | Model modification | Yes; VPP-SFT | Learned coordinate-aware grounding | GOG is black-box and extracts geometry from generated output-space edits |
| Image Difference Grounding | 2025 | Ground language-referred differences between image pairs | No | Task model | Yes; DiffGround dataset | Learned localization of semantic differences | GOG intentionally creates the second image as a machine-readable semantic overlay; the difference is a protocol intermediate |
| Segment Anyword | 2025 | Open-set grounded segmentation | No explicit output mark | Yes; diffusion cross-attention | Training-free | Internal attention-derived mask prompts | GOG does not access attention/features and can operate with closed editors |
| InterCoG | 2026 | Spatially precise instruction-based editing | Yes; generated boxes and masks | Unified model reasoning stack | Yes; GroundEdit-45K + auxiliary training | Generated visual grounding reasoning | InterCoG trains grounding-aware editing; GOG uses a pretrained editor as black-box semantic externalizer and deterministic extractor |
| Early Semantic Grounding in Image Editing Models | 2026 | Zero-shot referring image segmentation | No visible edit required | Yes; early denoising attention/features | Training-free | Internal feature separability + attention priors | Closest conceptual threat. GOG is output-space and black-box, uses final user-specified color edits and deterministic image differencing |
| **WorldX-Map GOG** | — | Recover executable structures from open-ended generated game maps | **Yes; user-specified color overlays** | **No** | **Training-free protocol** | **Deterministic difference scoring + components** | Black-box semantic externalization from an editor into machine-readable output-space marks, integrated with executable map compilation |

## Recommended manuscript claim

> We investigate a black-box, training-free output-space grounding protocol in which a pretrained image editor externalizes language-conditioned target understanding as user-specified color edits, and deterministic image differencing recovers geometry for downstream executable map compilation.

## Claims to avoid

- "Image editing models can ground targets" as a novelty claim.
- "First training-free visual grounding method."
- "First generated-mask grounding method."
- "First use of image differences for grounding."
- "Model-agnostic" before cross-model evidence.

## Required experiments after this audit

1. DirectCoord vs GridCoord vs GOG vs GOG-V on identical maps.
2. Absent-target false-positive analysis.
3. Overlay identity-preservation analysis outside human target regions.
4. Cross-model subset if budget permits.
5. Failure analysis separating semantic mis-grounding from image-editor drift.
