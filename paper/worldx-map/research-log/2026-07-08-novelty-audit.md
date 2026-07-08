# Research Log — 2026-07-08 Novelty Audit

## Action

Performed a targeted nearest-neighbor literature audit for the proposed Generative Overlay Grounding (GOG) mechanism. The search focused on 2025-2026 work involving visual grounding, image-editing models, training-free grounded segmentation, image differences, explicit visual marks, and grounding-aware editing.

Primary sources inspected:

- Set-of-Mark Prompting Unleashes Extraordinary Visual Grounding in GPT-4V — arXiv:2310.11441
- Visual Position Prompt for MLLM based Visual Grounding — arXiv:2503.15426
- Image Difference Grounding with Natural Language — arXiv:2504.01952
- Segment Anyword: Mask Prompt Inversion for Open-Set Grounded Segmentation — arXiv:2505.17994
- InterCoG: Towards Spatially Precise Image Editing with Interleaved Chain-of-Grounding Reasoning — arXiv:2603.01586
- Early Semantic Grounding in Image Editing Models for Zero-Shot Referring Image Segmentation — arXiv:2605.13122

## Evidence

### 1. SoM is a direct visual-prompting neighbor, but the dataflow differs

SoM first obtains regions from off-the-shelf segmentation models, overlays marks, and then asks a multimodal model to reason over the marked image.

GOG instead starts from a language target and asks a generative image editor to externalize its target understanding as a color-coded edit; deterministic image differencing then recovers geometry.

Difference:

```text
SoM: segmentation -> marks -> multimodal reasoning
GOG: semantic query -> generated color overlay -> deterministic geometry recovery
```

### 2. VPP confirms that direct coordinate grounding is a recognized weakness of MLLMs

VPP-LLaVA introduces explicit position prompts to improve spatial grounding. This supports the motivation for including DirectCoord and GridCoord baselines, but it also means the paper cannot imply that coordinate weakness is a new observation.

### 3. Image Difference Grounding is close in terminology but solves a different task

IDG localizes meaningful differences between two images according to natural-language instructions. Its image pair contains real/constructed visual differences to be queried.

GOG intentionally creates the second image as a machine-readable semantic overlay and then extracts the induced difference. The difference image is an intermediate protocol, not the target phenomenon.

### 4. Segment Anyword weakens any broad claim around training-free open-set grounded segmentation

Segment Anyword uses frozen diffusion-model cross-attention to derive mask prompts for open-set grounded segmentation. Therefore GOG must not claim novelty merely from being training-free or open-set.

### 5. InterCoG is a strong 2026 neighbor in grounding-aware image editing

InterCoG performs textual position reasoning, then visual grounding by generating highlighted bounding boxes and masks, then uses that reasoning chain for editing. It also adds training objectives and a 45K dataset.

This is close because it explicitly generates pixel-space visual grounding artifacts. However, its goal is precise editing; it is trained; and the generated boxes/masks are reasoning artifacts inside an editing framework.

GOG's defensible distinction is the black-box use of an existing image editor as a semantic externalizer, followed by deterministic output-space recovery for downstream executable structure.

### 6. Early Semantic Grounding is the closest conceptual threat

This 2026 work explicitly argues that instruction-based image editing models inherently perform language-conditioned grounding and repurposes their internal representations for zero-shot referring image segmentation. It is training-free and uses attention/features from the model at an early denoising step.

This directly weakens the broad novelty claim:

> "Image editing models can be used for grounding."

That claim is no longer defensible.

The remaining distinction is:

- GOG is black-box with respect to the editor;
- GOG does not access attention maps, denoising states, or internal features;
- GOG operates on the final edited output image;
- user-specified colors form an explicit machine-readable communication channel;
- deterministic differencing converts that channel into bbox geometry;
- the method is embedded in a specification-to-executable game-map compiler rather than a standard RIS benchmark pipeline.

## Conclusion

The novelty statement must be narrowed.

Do **not** position GOG as:

- the first use of image editing models for visual grounding;
- a new observation that image editors internally localize edit targets;
- the first training-free open-set grounded segmentation method;
- the first use of generated masks/boxes as visual grounding artifacts.

Recommended core claim:

> GOG is a black-box, training-free output-space grounding protocol that asks a pretrained image editor to externalize language-conditioned target understanding as user-specified color edits, then deterministically recovers geometry from the induced image differences for executable map compilation.

Recommended research emphasis:

1. black-box compatibility with proprietary or closed image editors;
2. no access to internal attention/features;
3. deterministic extraction and auditable failure modes;
4. compatibility with arbitrary stylized generated maps;
5. downstream executable structure recovery.

## Do not conclude

- Do not claim "first" before a broader systematic search.
- Do not claim GOG is superior to feature-based grounding before experiments.
- Do not claim model-agnostic behavior before cross-model tests.
- Do not claim pixel-accurate segmentation; current output is primarily bbox plus walkability grid.
- Do not claim the image editor is unchanged by the overlay request unless identity preservation is measured.

## Next step

1. Revise manuscript Related Work and Contributions around the narrowed claim.
2. Add a novelty-positioning comparison table.
3. Keep RQ2 DirectCoord and GridCoord baselines.
4. Add a future/optional feature-based grounding comparator if model internals are available; do not block the main black-box study on it.
5. Add an identity-preservation metric for overlay generation so that GOG cannot hide geometry drift behind successful differencing.
