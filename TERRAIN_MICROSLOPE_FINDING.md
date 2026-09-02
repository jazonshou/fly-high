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
