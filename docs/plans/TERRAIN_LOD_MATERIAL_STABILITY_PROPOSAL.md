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

---

## 2026-09-02 feasibility follow-up — no production patch yet

The shipping analytic path was traced end to end after this proposal was
written:

1. `TerrainPageGenerator` writes one band-limited `r32float` height per height
   texel. It retains no sub-texel moment.
2. `PageSplatBake` receives that atlas plus one band-limited terrain-kernel page
   uniform per job. `splatSlopeAspect` differences the stored heights.
3. The classifier is run four times per season bucket. The two bucket vectors
   are aligned and stored; no later stage has enough information to repair the
   slope input.

That makes the source question concrete. **The classifier cannot derive a mean
fine slope from the value it receives.** A `filterWidthMeters` member by itself
would be metadata attached to missing data, not an implementation.

### Direct analytic evaluation is effective, but does not fit the compute row

A second deterministic control sampled 749 land points from the same
`phase1-perf-baseline` world. The current band-limited central difference went
from **15.62% steep at L0 to 0.00% at L8** on that subset. A 2×2 stratified mean
of full-bandwidth 2 m slopes stayed at **15.75% at L0 and 9.75% at L8** when its
footprint was the height texel. This independently reproduces the proposal's
shape with fewer taps. It is evidence that the missing moment is causal; it is
not approval of a four-tap estimator. Re-running the exact L8 control gives
**9.7463%** for that 512 m height-texel footprint. Widening the same four points
to the 1,024 m channel-texel footprint gives **12.6836%**; that was the 12.68%
figure quoted in the follow-up status, but it is a different filter support.
The 9.75% value is authoritative here because the proposal explicitly passes
`job.shape.y`, the height-texel width.

Four slope samples still require four height evaluations each. Even if the
result is computed once per channel texel and shared by both seasons, one
136×136 splat page therefore adds:

```
136 × 136 × 4 slopes × 4 heights = 295,936 full-bandwidth height evaluations
295,936 × 34 value-noise calls       = 10,061,824 value-noise calls
```

That is deliberately the optimistic lower bound. Applying a separate four-tap
mean at each of the bake's four outer splat samples would multiply it by four.

For scale, the measured L3 height-page dispatch performs 264×264×4 = 278,784
height evaluations and is pinned at **1.9 ms/page**. The existing whole splat
dispatch is pinned at **0.4 ms/page**, while its Balanced frame row is only
**0.25 ms**. The direct route's lower-bound work is already larger than the
entire measured height-page sample count, and its evaluations are
full-bandwidth rather than the cheaper coarse kernel. This comparison is a
workload lower bound, not a GPU timing claimed for an unbuilt shader. It is
enough to reject inlining the estimator into the splat bake without first
funding and measuring a new compute row.

It has an authority cost as well. It is valid only while the analytic kernel is
the height authority, must fall back to the atlas for the shelved eroded mode,
and must include or explicitly blend out the runway earthworks. Shipping an
unconditional analytic read would repeat the cross-authority coupling warned
about by `5-12a`.

### A full-resolution companion channel does not fit the current memory pin

The smallest straightforward persistent representation is one unsigned byte
per channel texel, keyed by height slot so it exists before channel admission.
At Balanced's 196 slots it costs **3.06 MiB for the 128² cores**, or **3.46 MiB
with the required 136² gutter**. The last accepted analytic capture inventories
**492.3 MiB against a 495 MiB ceiling**, leaving about **2.7 MiB**. Thus even the
core-only form exceeds the measured headroom, while omitting the gutter makes
bilinear reads disagree at page edges. R16 and R32 forms cost 6.91 and 13.83 MiB
respectively.

Packing to four bits could fit, but it is not a free format substitution: over
the classifier's 0.24–0.58 steepness transition, full-range UNORM4 advances in
0.067 steps. That quantisation is large enough to move a material boundary and
needs its own visual and distribution evidence. It is not justified here.

### Resident-child propagation cannot supply coarse-first pages

The atlas is deliberately coarse-first and pages are independently
generatable. Requiring fine children before their parent reverses that contract;
an L8 page has 65,536 L0 descendants. A reduction over resident children would
therefore either leave the first coarse view without the statistic or defeat
the reason the clipmap exists. The reduction source must be independently
available, not opportunistically resident.

### Smallest architecture-compliant future shape

The viable design is a **derived roughness/slope-moment authority**, not another
classifier rule:

- Build a world-anchored, coarse-first slope-moment pyramid or clipmap from the
  active height authority. For analytic worlds its producer may compose the
  shared terrain kernel and runway earthworks; an eroded-world revival must
  derive it from evolved height rather than silently using the analytic field.
- The finest statistic has a minimum support near **33 m**, then reductions
  carry the mean of child slopes. A coarse value is a mixture moment, never the
  slope of an averaged height.
- `PageSplatBake` samples that one source at the channel footprint and passes
  the resulting slope to the existing classifier. The top-four/seasonal weight
  machinery remains unchanged.
- Fund its storage and generation explicitly before implementation. A toroidal
  multi-level field may be smaller than one value per resident page texel, but
  its coverage, recenter seams, startup availability and compute admission are
  design inputs, not details to guess inside the splat shader.

This is the smallest form that preserves coarse-first residency, one active
height authority, bounded work, and scale-stable content. Choosing its spatial
extent/levels and funding either memory or dispatch time are the exact blockers
left open.

### The visual-scale counterfactual narrows the target, but is not a flight sign-off

The canonical `mountain-close` diagnostic now holds every non-slope classifier
input fixed and box-averages the existing normalised slope. On 57,602 qualifying
samples, the baseline has 2,146 material chords in the reported 12–100 m band,
3,289 Grass/DryGrass↔Rock crossings, and 23.25% Rock. The measured alternatives
are:

| slope support | reported-scale chords | mineral crossings | Rock |
|---|---:|---:|---:|
| current point slope | 2,146 | 3,289 | 23.25% |
| 33 m (16 m half-width) | 1,307 | 1,955 | 21.83% |
| 65 m (32 m half-width) | 867 | 1,304 | 19.36% |
| 129 m (64 m half-width) | 441 | 607 | 15.00% |

The 33 m support is the first production candidate: it removes 39% of the
reported-scale chords and 41% of mineral crossings while moving Rock only
1.42 percentage points. The 65 m row is a stronger 60% patch reduction at a
3.89-point Rock cost; 129 m identifies the destructive end of the sweep. These
are CPU classifier counterfactuals, **not rendered frames and not user visual
confirmation**. A future producer must move this quantitative diagnostic and a
reviewed visual baseline together.

### Acceptance gate required with that producer

Assertion 85 remains useful, but its L4↔L3 dominant-id membership is blind to
the 24× endpoint collapse. The implementation change must add a shipping-path
gate that reads **Rock weight/area over the same world ground** at L0, L2, L4,
L6 and L8. It must require at least 500 land samples, require the finest level
to contain at least 10% Rock (non-vacuity), and require the coarsest Rock share
to retain at least half of the finest share. That last bound comfortably admits
the measured 1.6× mixture residual and rejects 15.61% → 0.64% by construction.
The mountain patch-population diagnostic is the independent near-field guard;
neither test substitutes for the other.
