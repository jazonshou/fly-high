# Cliff-angle ground is an artifact of the differencing baseline

**Status: open latent defect. NOT the cause of Jason's strips** — that hunt moved
on, and this finding is recorded here so it is not lost with it.

## The claim

**There is no terrain at cliff angle in this world.** Every face that classifies
as rock-steep is short-baseline roughness sitting on gentle landform. Measure the
same ground over a longer baseline and the population does not shrink — it
empties.

## The measurement

`slope = 1 - normal.y`, so the thresholds in `LandCoverClassifier` are steeper
than they look:

| slope | 0.24 | 0.30 | 0.35 | 0.40 | 0.45 | 0.58 |
|---|---|---|---|---|---|---|
| incline | 41° | 46° | 49° | **53°** | **57°** | 65° |

Rock going 0→100% between 53° and 57° is a defensible rule. Bare rock at 55° is
correct. **The rule is not the problem; its input is.**

Slope from central differences at four baselines, seed `phase1-perf-baseline`,
fraction of land at ≥0.40 (≥53°), with contiguous run lengths along scanlines
sampled at the same baseline:

| baseline | land ≥53° | median run | p90 run | max run |
|---|---|---|---|---|
| 8 m | **11.84%** | 32 m | 144 m | 2312 m |
| 32 m | 8.61% | 64 m | 224 m | 1984 m |
| 128 m | 3.20% | 128 m | 512 m | 1792 m |
| 512 m | **0.00%** | — | — | — |

**At 512 m the population is empty — not small, empty.** So the 11.84% at 8 m is
not a landform that coarse sampling under-resolves; it is roughness that fine
sampling manufactures.

Across seeds at the 8 m baseline (≥53°): baseline 13.9%, charlie 5.8%,
bravo 2.7%, delta 1.1%, alpha 0.5%. Present everywhere, **but a 28-fold spread.**

## Instrument control

The finite-difference slope was checked against the engine's own
`1 - normal.y` from `sampleTerrain` over 225 land points: mean |diff| **0.0066**,
means 0.0778 (probe) vs 0.0805 (engine). The distribution above is a fact about
the terrain, not about the probe's arithmetic.

## Why it matters

`sampleTerrainSurface`'s own docblock already names this failure mode:

> *"The tile path computes slope from its own grid normal — at the tile's
> spacing — and must classify from that same slope, or rock and scree colour at
> 40 km is assigned by 4 m microslope."*

The rule exists precisely so this cannot happen. **Whether it holds on the live
path is not established here** — that is worth checking on its own merits, and
it is the actionable next step. If any painter classifies coarse ground from a
fine-baseline normal, this table is what it will paint.

## What this is not

It was hunted as the cause of Jason's grey strips and **it does not fit**, on two
counts that were visible before the frame was:

1. **Seed spread.** 0.5% to 13.9% across five seeds, against a report of
   strips in *literally every* world.
2. **Shape.** Roughness ribbons vary in width along their length. The band in
   `tests/perf/baseline/terrain-material-1600ft-down.png` is continuous and of
   near-uniform width — nearer this table's `max` than its `median`.

Both were reasons to doubt it, and both were flagged before it was ruled out.
Recorded here so the next person does not re-run the hunt.

---

# Live-path check: the bake honours the rule, and that is what causes the pop

**Which painter this section is about: the GPU splat bake**
(`LAND_COVER_SPLAT_BAKE_WGSL`), which is what paints the ground the player sees.
Not the CPU law, and not `TerrainSurfacePlugin`'s fallback axis.

## The rule is honoured

`splatSlopeAspect` differences adjacent **height-atlas** texels and divides by
`job.shape.y`, which `PageOcclusionBake` fills from
`terrainTexelSizeMeters(level)`. So slope is computed at the page's own spacing,
per level, correctly normalised. **The docblock's stated fear — 40 km ground
classified by 4 m microslope — does not happen on this path.**

| level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| slope baseline | 2 m | 4 m | 8 m | 16 m | 32 m | 64 m | 128 m | 256 m | 512 m |

## And that is precisely why the same ground is a different material at each level

Because cliff-angle ground is roughness rather than landform (table above),
classifying each level at its own spacing means **near ground is legitimately
rocky and the same far ground legitimately is not.** The same 15,974 land
points, classified at each level's own baseline:

| level | baseline | Rock | texels flipping material vs previous level |
|---|---|---|---|
| 0 | 2 m | **17.01%** | — |
| 1 | 4 m | 16.78% | 1.02% |
| 2 | 8 m | 16.53% | 1.83% |
| 3 | 16 m | 15.88% | 3.06% |
| 4 | 32 m | 14.33% | 4.39% |
| 5 | 64 m | 12.25% | 6.42% |
| 6 | 128 m | 8.70% | **6.77%** |
| 7 | 256 m | 5.22% | 5.91% |
| 8 | 512 m | **2.41%** | 3.96% |

**A 7× swing in rock coverage between nearest and farthest, and up to 6.77% of
texels changing material at a single ring transition.** Grey grows in as you
approach. This is a material LOD pop, and it is the *consequence of the correct
rule* meeting a slope signal that has no scale-stable content — so it cannot be
fixed by moving a threshold. Either the classifier's slope input needs a
scale-stable definition (one baseline for classification regardless of the
level being baked), or rock needs a term that survives filtering.

## A second, separable defect: the estimator is biased

`splatSlopeAspect` uses a **forward** difference (`here`, `east`, `south`), which
has O(h) truncation error against a central difference's O(h²). Same points,
same baselines, fraction at ≥0.40:

| baseline | forward | central | ratio |
|---|---|---|---|
| 2 m | 15.07% | 15.01% | 1.00× |
| 8 m | 14.63% | 13.84% | 1.06× |
| 32 m | 12.52% | 10.02% | 1.25× |
| 128 m | 6.36% | 3.26% | **1.95×** |

**At coarse levels the bake reports nearly twice the steep ground a central
difference would**, so the LOD swing above is *understated* — an unbiased
estimator would put level 8 lower still. The forward form is also **asymmetric**:
the gradient it computes is centred half a texel toward +x/+z from the texel it
paints, which is **256 m of misregistration at level 8**. Both are fixed by the
same change, at the cost of one extra tap per axis.

## Caveat

These numbers classify the **analytic** height field at each level's baseline, as
a stand-in for the baked height atlas. That substitution is supported by the
atlas measuring ~2 m from the CPU field on terrain with hundreds of metres of
relief, but it is a substitution, and the LOD-pop magnitudes would be worth
re-reading off the atlas itself before anyone tunes against them.

---

# The estimator fix, and what it did to the numbers above

`splatSlopeAspect` now uses a **central** difference. Everything below was
measured with `dc`'s gutter fix already in the tree, so the arms differ only in
the estimator.

## On the atlas, not the analytic stand-in

`tests/gpu/terrain-splat-bake.test.ts`'s assertion 85 — a page's cover against
its four children's, which is the LOD pop measured on the **baked atlas**:

| | dominant-cover agreement | worst axis step where it disagrees |
|---|---|---|
| forward | 99.1% | 1 |
| central | **100.0%** | **0** |

**Cross-LOD disagreement on that page goes to zero.** CPU-vs-bake parity is
unchanged (5.81 / 4.00 / 3.01 / 2.27 against 5.81 / 4.03 / 2.92 / 2.27) — a
prediction that it would improve was wrong; those disagreements are not
slope-driven.

## The ratio shortcut does not rescue this quantity

A ratio is usually steadier than its endpoints under estimator choice. **Here it
is the opposite, and the reason is worth recording.** Rock coverage by level:

| level | 0 (2 m) | 2 (8 m) | 4 (32 m) | 6 (128 m) | 8 (512 m) | ratio L0/L8 |
|---|---|---|---|---|---|---|
| forward | 17.01% | 16.53% | 14.33% | 8.70% | 2.41% | **7.1×** |
| central | 16.94% | 15.83% | 12.27% | 5.45% | **0.68%** | **24.9×** |

**The far endpoint approaches zero, so the ratio is a small-denominator
quantity** and moves 3.5× where the endpoints move much less. What survives
estimator choice is the **near** endpoint (17.01% vs 16.94%, 0.4% apart) and the
**monotone fall**, not the ratio.

**So state it as: rock coverage falls monotonically from ~17% at the finest
level to somewhere between 0.7% and 2.4% at the coarsest.** The shape is
established; the far endpoint carries the uncertainty. And note the correct
estimator makes the pop **worse**, not better — the earlier table understated it,
as predicted.

## Frame delta

Same-tree A/B, arms differing only in the estimator. Comparing against committed
baselines would have folded in unrelated work, so the arms are compared to each
other:

| shot | pixels changed | mean \|Δ\| | worst |
|---|---|---|---|
| high-10000ft-down | **30.01%** | 7.2 | 122 |
| slant-10km | 12.76% | 6.0 | 171 |
| cliff-60m | 11.39% | 8.5 | 216 |
| mountain-close | 10.81% | 5.1 | 86 |
| terrain-material-1600ft-down | 8.43% | 2.4 | 63 |
| cdlod-transition | 4.44% | 6.0 | 131 |

Five shots outside the capture list were byte-identical across arms (0.00%),
so the comparison is not measuring capture noise.

**The ordering is the mechanism's own prediction:** the error is O(h) in the
page texel, so the higher and more distant the shot, the more it moves.
`high-10000ft-down` sits on the coarsest pages and moves most, by a factor of
seven over `cdlod-transition`. **That ordering is the strongest evidence the
change does what it claims** — it was predicted before it was measured.

**These shots will need re-baselining, and the movement is an improvement rather
than a regression.** The baseline comparison itself must be run on a current
tree; the arms above were captured from a worktree 230 commits behind, so its
absolute SSIM against committed baselines means nothing.
