# 7-9: the night tier ladder is broken above tier 1

**Measured 2026-09-01 in a worktree pinned at `1a4c1ac`, on a quiet host
(load 3.4–3.8), warm-up discarded, two runs per tier.** Shots: `night`,
`night-moonlit`, `dusk-mesopic`.

## The measurement

| shot | tier 0 | tier 1 | tier 2 | tier 3 | within-tier spread |
|---|---|---|---|---|---|
| `night` | 121.6 | 121.3 | **23.1** | **19.1** | ≤ 1.5 fps |
| `night-moonlit` | 121.6 | 121.1 | **23.4** | **18.8** | ≤ 1.3 fps |
| `dusk-mesopic` | 121.7 | 123.8 | **23.5** | **19.9** | ≤ 2.9 fps |

Best-of-2 per cell. **Contention can only lower fps and raise frame times, so
the maximum is the consistent estimator here and the mean is not** — the same
reason the minimum is used for millisecond figures.

## Two findings, and the second is the serious one

**1. Tiers 2 and 3 both miss their own frame targets, by a wide margin.**
Tier 2's `frameTargetMs` is 13.7 (≈73 fps) and it delivers 23. Tier 3's is 30
(≈33 fps) and it delivers 19. The within-tier spread is 1.3–2.9 fps against a
~98 fps step, so this is not a resolution problem.

**2. Tier 3 is SLOWER than tier 2, consistently, on all three shots.** A quality
ladder whose top rung delivers less than the rung below it is not mistuned, it
is inverted. Tier 3 raises `shadowMapSize` 1536→2048, `shadowCascades` 3→4,
`oceanCascades` 5→6 and `vegetationDistance` 4000→5000 at the same render scale
and the same 4× MSAA, so it buys strictly more work for a target that is already
2.4× missed.

## The pixel evidence makes finding 2 worse

Run-to-run floor and tier steps, as DISTRIBUTIONS rather than means — a mean is
exactly what a half-missing population looks like, which is how four degenerate
triangles moved a winding score from −1.000 to −0.818 and still passed.

| comparison | identical | 1–2 | 3–8 | 9–24 | 25–64 | 65+ |
|---|---|---|---|---|---|---|
| floor, any tier, r1 vs r2 | **99.88–100.00%** | ≤0.06 | ≤0.04 | ≤0.02 | ≤0.01 | ≤0.01 |
| `night` t1→t2 | 48.08% | 31.84 | 18.22 | 1.68 | 0.10 | 0.07 |
| `night` **t2→t3** | **85.40%** | 9.60 | 4.10 | 0.90 | 0.00 | 0.00 |
| `night-moonlit` **t2→t3** | **82.04%** | 7.79 | 5.62 | 3.59 | 0.89 | 0.07 |
| `dusk-mesopic` **t2→t3** | **83.36%** | 6.63 | 2.54 | 2.53 | 1.73 | 3.21 |

**The run-to-run floor is essentially zero**, so every step above is resolved by
three orders of magnitude and none of this is noise.

**TIER 3 LEAVES 82–85% OF PIXELS BIT-IDENTICAL TO TIER 2, and most of what it
does change moves by 8/255 or less — while costing ~21% more frame time**
(23 → 19 fps). Compare `t1→t2`, which changes half the frame and is a real
visual step.

**So the ladder's top rung is not merely inverted, it is inverted for almost
nothing.** Whatever tier 3 buys over tier 2 — a 2048 shadow map, a fourth
cascade, a sixth ocean cascade, 1 km more vegetation — is close to invisible at
these three night poses, and is paid for at 21% of the frame.

**Scope: night only.** Tier 3's extra vegetation distance and shadow resolution
plausibly matter far more in daylight, where long shadows and distant tree lines
are visible. **This says tier 3 is a bad trade AT NIGHT, not that it is a bad
tier.** That distinction decides whether 7-9's answer is a night-specific tier
row — which is what the item exists to add — or a change to tier 3 itself.

## Two things that must not be dropped when this is quoted

**TIERS 0 AND 1 ARE FRAME-CAPPED. Their numbers are a ceiling, not a
measurement.** `wallClockFps` reads 120.0–120.1 on every shot at both tiers —
that is a cap. **So the tier 1 → tier 2 step is a LOWER BOUND** and the true
headroom at tiers 0 and 1 is unknown. Nothing here says tier 1 is "fast enough";
it says tier 1 is fast enough to hit the cap.

**THE MSAA EXPLANATION IS SUGGESTIVE AND IS NOT PROOF.** `msaaSamples` goes
1 → 4 at tier 2 and `renderScale` 0.86 → 1.0, so the sample count goes
680,900 → 3,686,400 — **5.41×**, against a measured fps drop of **5.25×**. That
match is close enough to be quoted as a conclusion later, which is exactly why
it is labelled here: **because tier 1 is capped, the real ratio may be larger
and MSAA would then be only part of the cause.** `vegetationCastsShadows` also
flips false → true at tier 2, which is what nearly doubles draw calls
(181 → 351). Neither has been isolated.

## What was NOT measured

- **Day.** All three shots are night. Whether the cliff is night-specific or a
  general tier-2 cost is unknown, and the two have different remedies.
- **The reference adapter.** This is one host. The delivery contract is defined
  on the pinned reference adapter and this is not necessarily it.
- **Per-pass GPU time.** `gpuPassMs.mainPass` is bimodal on this host — 4.6×
  swings on byte-identical geometry, time-ordered rather than arm-ordered — so
  no per-pass attribution is offered. See the note in the
  `GPU_TIMING_ENABLED` docblock.

## Status of these numbers

**Acceptance reports, not standing baselines**, per 7-9's own pins. Only the
canonical tier-1 set remains the regression gate.

Reports archived in the main tree at
`tests/perf/artifacts/run-archive/7-9-tier-sweep/` — eight tier arms plus the
34-shot `ratchet-full` run the draw-call table came from. The PNGs stay in the
capture worktree; the reports carry every number quoted above.
