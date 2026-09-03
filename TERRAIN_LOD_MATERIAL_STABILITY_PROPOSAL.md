# Making land-cover survive a LOD change

**Design proposal, not a patch.** The defect is measured; the fix is a choice
between three shapes and the evidence favours one. Companion to
`TERRAIN_MICROSLOPE_FINDING.md`, which established the measurements quoted here.

## The defect, and it was already named

**Assertion 85 in `tests/gpu/terrain-splat-bake.test.ts` describes it exactly**,
carried open through two plans and written at `4.5-D3`:

> *"the surface CHANGES MATERIAL when a page changes LOD — a ground that turns
> from forest to rock as you fly toward it"*

Rock is selected by slope. Slope in this world has **no scale-stable content**:
the cliff-angle population is short-baseline roughness sitting on gentle
landform, and it empties entirely by a 512 m differencing baseline. Since each
page classifies at its own texel spacing, the same ground is a different
material at every level.

Quantified, on 1089 land points classified at each level's own baseline with a
central difference:

| level | 0 (2 m) | 2 (8 m) | 4 (32 m) | 6 (128 m) | 8 (512 m) |
|---|---|---|---|---|---|
| rock | 15.61% | 14.51% | 10.56% | 4.41% | **0.64%** |

**At the coarsest level the renderer paints 0.64% rock on ground that is 15.61%
rock. It loses 96% of the rock area** — and recovers it progressively as you
approach, which is the grey growing in.

## Why the estimator fix did not close it, and a caution

Replacing the bake's forward difference with a central one took assertion 85
from 99.1% to **100.0%** dominant-cover agreement on the page it tests. **That is
not the same as scale stability, and it should not be read as one.** The table
above is measured *with* the central difference; the collapse is still 24×. The
estimator fix removed a bias in *how* slope is measured; it did not change *what*
slope is measured from, which is a band-limited height page.

## Why a threshold move cannot work

Any threshold on slope inherits slope's scale dependence. Lowering the rock
threshold to recover distant rock necessarily floods near ground with rock,
because the same constant meets a 2 m-baseline slope up close and a 512 m one at
range. **There is no value of the constant that is right at both ends** — the
same structure as the gate that compared a ceiling to a floor.

## Option A — classify everything at one fixed baseline

**Rejected, on residency and on measurement.**

Fixing the baseline *fine* (say 8 m) is not available: at distance the fine pages
are not resident, and that is the entire point of the clipmap. The bake reads
the atlas by design and cannot reach data that was never streamed.

Fixing it *coarse* is available — coarse data is resident at every level — but
the table above is what it produces: **0.64% rock everywhere**, which deletes
cliffs up close. The near endpoint is the one users are looking at.

## Option B — give the classifier a scale-stable slope statistic

**Measured, and it works, with an honest residual.**

The quantity a coarse texel should carry is the **mean of its children's fine
slopes**, not the slope of its averaged height. Those differ by exactly the
variance term that filtering destroys. Same points, same classifier:

| level | 0 (2 m) | 2 (8 m) | 4 (32 m) | 6 (128 m) | 8 (512 m) | collapse |
|---|---|---|---|---|---|---|
| current: slope of coarse height | 15.61% | 14.51% | 10.56% | 4.41% | 0.64% | **24×** |
| proposed: mean of fine slopes | 15.61% | 15.15% | 13.77% | 11.66% | **9.64%** | **1.6×** |

**A 24× collapse becomes 1.6×.** The residual is not error and should not be
tuned away: a 512 m texel genuinely contains a mixture of steep and gentle
ground, so its mean slope is honestly lower than a cliff's. **That residual is
the part a per-texel scalar cannot represent, and it is what splat weights are
for** — the right answer at coarse level is "30% rock" rather than "not rock".

## Recommendation — Option B, in the shape this repo already uses

**Pass the classifier a `filterWidthMeters` and derive its slope input over that
width**, exactly as `4-6b`/D12 did on the density side — the precedent that
assertion 85's own docblock points at when it names this defect class.
`VegetationDensityInput.filterWidthMeters` is the model: full-bandwidth (0) for
CPU callers, and a page bake passes its texel width. `BathymetryClipmap` already
passes `filterWidthMeters: texel`.

Concretely: `LandCoverInput` gains a filter width; the bake passes
`job.shape.y`; the slope input becomes the mean fine slope over that width
rather than a difference of band-limited heights. **The weight machinery needs no
change** — the parent already supersamples 2×2 and re-selects a top-4 from the
average, per assertion 85's docblock. The gap is the input, not the filtering.

## What must be established before building it

1. **Where the fine slope comes from at coarse levels.** The mean-of-fine-slopes
   statistic needs sub-texel information that the coarse height page does not
   carry. Either it is computed once and propagated down the page pyramid, or
   the height page gains a roughness channel alongside height. **This is the
   real cost and the real design question, and I have not resolved it.**
2. **Whether the analytic field can supply it directly in the bake.** Cheaper if
   so, but it would put classification back on a path other than the atlas,
   which is the coupling `5-12a` warns about.
3. **Frame cost.** Option B is a wider filter, not a bigger threshold; the tap
   count depends on (1).

## Validation, if it is built

The table in Option B is the acceptance test: **classify the same ground at
every level and require the rock fraction to be flat within the mixture
residual**, rather than requiring dominance agreement on one page pair.
Assertion 85 should be kept and strengthened to that form — it is the right
assertion measured too narrowly, and it passed at 99.1% throughout the period
the defect was at its worst.

## Provenance

All figures: seed `phase1-perf-baseline`, central-difference slope, classifier
read directly rather than modelled. The 1089-point sample is smaller than the
15,974-point sweep in `TERRAIN_MICROSLOPE_FINDING.md` because the
mean-of-fine-slopes arm costs 36 height samples per point per level; the two
agree at the levels they share to within 1.4 pp. **The proposed column is a 6×6
Monte-Carlo estimate of the child mean, not an exact reduction** — it establishes
the shape of the improvement, not its final magnitude.
