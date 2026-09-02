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
is inverted. Tier 3 buys strictly more work at the same render scale and the
same 4× MSAA, for a target that is already 2.4× missed.

> **CORRECTED 2026-09-01.** This paragraph used to read "raises `shadowMapSize`
> 1536→2048, `shadowCascades` 3→4, `oceanCascades` 5→6 and `vegetationDistance`
> 4000→5000". Two of those are wrong — **`oceanCascades` does not change (5 at
> both tiers)** and **`vegetationDistance` goes to 6000, not 5000** — and the
> list is four of **thirteen** differing fields. The full enumeration, diffed
> from the resolved profiles, is in *What actually differs between tier 2 and
> tier 3* below. **Nothing in this file attributes the 21% to any one field.**

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

## The mechanism for finding 2, derived from the artifact

**Added 2026-09-01. Derivation from the shipped profile and source, NOT a new
capture** — the split between what is measured and what is derived is kept
explicit below because the two carry different weight.

**Tier 2 and tier 3 are identical on every term except shadows.** Resolved from
`resolveWebGpuQualityProfile` rather than read off the source table, because the
table is not keyed by tier and eyeballing which block is which is how you
attribute a row to the wrong tier:

| tier | renderScale | msaa | bloom | shadowMap | cascades | shadow texels |
|---|---|---|---|---|---|---|
| 0 | 0.72 | 1 | false | 1024 | 2 | 2.10 M |
| 1 | 0.86 | 1 | **true** | 1280 | 2 | 3.28 M |
| 2 | 1 | 4 | false | 1536 | 3 | 7.08 M |
| 3 | 1 | 4 | false | 2048 | 4 | **16.78 M** |

`renderScale`, `msaaSamples` and `bloomEnabled` are all HELD CONSTANT across the
t2/t3 pair. **So MSAA cannot be the differentiator between these two tiers** —
it is the same 4x on both — and the tier1->tier2 MSAA reasoning above must not
be carried across the t2/t3 step. **The only terms that differ are the two
shadow ones**, plus `oceanCascades` and `vegetationDistance`.

**CORRECTION, same day, before this section was quoted anywhere.** The table's
last column is ALLOCATION, and this section first read it as render cost. It is
not, and the difference is the whole size of the effect:

- **allocated** texels: `size x size x numCascades` — the ratio above, **2.370x**
- **rendered** texels: the Principle Engineer's cascade finding shows the map is
  rendered ONCE regardless of `numCascades`, so t3/t2 is `2048^2 / 1536^2` =
  **1.778x**

I verified that chain independently on OUR engine rather than inheriting it,
because it was traced in the WebGL file and we ship WebGPU. It holds in both:
`Engines/WebGPU/Extensions/engine.renderTarget.pure.js:46` has the same
`fullOptions.noColorAttachment ? null` as the WebGL path, so `_texture` is null;
`thinTexture.js:77` returns `is2DArray === false` whenever `_texture` is null;
and `renderTargetTexture.pure.js` gates its per-layer loop on
`(this.is2DArray || this.is3D) && !this.isMulti`, falling through to a single
`_renderToTarget(0, ...)`. **The layer loop is skipped, so `_renderToTarget` is
invoked once rather than `numCascades` times.** What that costs on the GPU is
the falsifier's question, not this file's: flipping `noColorAttachment` to false
should move cost per casting mesh from 2.00 to `1 + numCascades`.

**The finding below does not share that premise, which is why it is stated
separately.** Whether one cascade layer renders or four, the sun's shadow pass
RUNS at night, and the lever skips all of it either way. The cascade question
changes the SIZE of the night waste, not whether it exists.

**And at night that entire term is spent on a light of intensity exactly zero.**
`paletteForElevation`'s lowest anchor is -12 degrees at `intensity: 0.0`, and
the function clamps to it below that. Sun elevation at each night clock, from
the codebase's own `solarApparentPosition` composed with
`equatorialToWorldRows` (the composition `render.night-clock-moonlight.test.ts`
exists to publish), with a non-vacuity check so a probe that returns a constant
cannot pass as a measurement:

    sanity: day 171 noon (12.5h)     +67.59 deg   <- the probe moves
    night shot (moonless)  171@23.75  -21.48 deg  -> intensity 0.0 (clamped)
    moonlit control        179@23.75  -21.73 deg  -> intensity 0.0 (clamped)
    night preset           356@23.75  -68.20 deg  -> intensity 0.0 (clamped)

**The cascades render anyway.** Four independent reads, each of which would
break the chain on its own:

- `AtmosphereSystem` constructs the `DepthOnlyCascadedShadowGenerator` on
  `this.sun` once, at construction, and only ever writes `sun.intensity`
  thereafter — **the light is never disabled**, and Babylon renders a shadow map
  on light ENABLEMENT, not on intensity.
- `scene.shadowsEnabled` is **never written** anywhere in `src` — grep for
  `shadowsEnabled\s*=` returns nothing. It is read twice, as a guard, and holds
  Babylon's default `true` forever.
- `light.shadowEnabled` is likewise **never written**: two reads, both guards,
  zero writes.
- No `refreshRate` is set on the shadow map, so it is `RENDER_EVERY_FRAME`.
  Casters are re-collected every frame from terrain, detail, wildlife, the
  airport and the aircraft, gated on DISTANCE (`shadowCasterDistanceMeters`)
  and never on time of day.

**So at every night pose the renderer runs a full sun shadow pass — 4.19 M
rendered texels at tier 3, 2.36 M at tier 2, against 16.78 M and 7.08 M
ALLOCATED — for a directional light contributing nothing to the image.**

That is a mechanism for both halves of finding 2 at once, and the two halves now
have different owners:

- **why tier 3 costs ~21% more frame time than tier 2 at night** — NOT
  ATTRIBUTED, and this section originally said shadows and was wrong to. See
  the field enumeration immediately below: shadows are one contributor of
  several, and nothing here isolates them.
- **why 82-85% of its pixels come out bit-identical anyway** — if the cascade
  finding holds, tier 3's extra cascades are ALLOCATED AND NEVER RENDERED INTO,
  so the fourth cascade cannot change a pixel by construction. **That is a
  stronger explanation than "the extra fidelity is invisible at night", and it
  is the reason this writeup must not reach Jason before the falsifier lands:**
  "the top tier is a bad trade" and "the top tier is broken and fixable" are
  different conversations.

**The lever already exists and its consumers already handle it.** Setting
`shadowEnabled = false` on the sun light reallocates nothing and recompiles
nothing — it is a boolean on a light. Both readers already do the right thing
when it is false: `FlightRenderer.buildDetailSunShadowSnapshot` returns `null`,
and `SunShadowReceiver` sets `sunShadowValid = 0` and returns early. This is the
"both halves of every shortening trade" check that 7-9's own body demands, and
here the second half is already written — which is unusual and worth saying,
because the `4-8b` precedent that clause exists for is the case where it was not.

**NOT MEASURED: the frame-time saving.** Everything above is derivation from the
artifact. What a night capture with sun shadows disabled actually delivers is
unmeasured, and needs a quiet host. **Predicting the sign is easy and predicting
the magnitude is not**, so no number is offered here.

### What actually differs between tier 2 and tier 3 — all of it

The list earlier in this file (`shadowMapSize`, `shadowCascades`,
`oceanCascades`, `vegetationDistance`) is **incomplete and has two errors**.
Enumerated by diffing the two RESOLVED profiles field by field rather than
reading the source table:

| field | tier 2 | tier 3 |
|---|---|---|
| `maxRenderPixels` | 2,400,000 | 4,000,000 |
| `frameTargetMs` | 13.7 | 30 |
| `renderedDensityLaw` far radius | 4,000 | 6,000 |
| `groundCoverLaw` rings | 15/40/95 m | 18/48/110 m |
| `grassRadiusMeters` | 220 | 320 |
| `cdlodPixelThreshold` | 2 | 1.5 |
| `cdlodNodeBudget` | 448 | 640 |
| `shadowMapSize` | 1,536 | 2,048 |
| `shadowCascades` | 3 | 4 |
| `shadowDistance` | 1,800 | 2,400 |
| `cloudResolutionScale` | 0.6 | 0.7 |
| `maxCloudPixels` | 1,000,000 | 1,600,000 |
| `vegetationDistance` | 4,000 | 6,000 |

**The two errors in the earlier list.** `oceanCascades` does NOT change — it is
5 at both tiers, so "5 -> 6" is wrong. And `vegetationDistance` goes to **6,000**,
not 5,000.

**`maxRenderPixels` is ruled out as a confound FOR THIS SWEEP, by the artifact
rather than by assumption.** All nine archived reports record a 1280x720
viewport — **921,600 px, below BOTH caps** — so neither tier clamps and both
arms rendered the same pixel count. **This does not generalise: at the sweep's
1440p viewport (3,686,400 px) tier 2 WOULD clamp to 2.4 M and tier 3 would not,
a 1.54x pixel difference, and the tiers would no longer be comparable at all.**
Anyone repeating this at another viewport must re-check that first.

**So the 21% is unattributed.** Thirteen fields differ; several — cdlod node
budget, ground cover radii, cloud resolution — cost frame time at night just as
they do by day, because geometry is drawn regardless of what lights it.
Per-pass attribution is not available here for the reason already recorded:
`gpuPassMs.mainPass` is bimodal on this host. **The night shadow finding above
stands on its own mechanism and does not depend on winning this attribution.**

## The plan's suggested light-point lever is attached to almost nothing

7-9's body lists "light-point LOD and cull radii" as a night tier field. Priced
before building it, because a governor lever attached to nothing is the specific
failure the GPU ladder's own comment records (`2-10` retired the
planar-reflection rungs *with their system*).

The shipped airfield draws **406 light points** in one draw call —
`airfieldLightPoints` 394 (it emits up to two per fixture, one per runway end,
so the 279 FIXTURES are not the population), `signLightPoints` 4, `papiLamps` 8.
Each is a quad whose rendered radius is
`max(uniforms.lightPsfPixels, projectedRadiusPixels)` — **floored at 1.7 px**,
which bounds the far field, and growing only within tens of metres:

| kind | radius | resolves above the PSF floor only within |
|---|---|---|
| centreline / touchdown | 0.10 m | 31.8 m |
| edge / threshold | 0.12 m | 38.1 m |
| approach | 0.14 m | 44.5 m |
| PAPI | 0.16 m | 50.8 m |

- all 406 at the floor: **4,693 px = 0.226%** of a 1080p frame
- 24 lamps resolved at 10 m plus the rest at the floor: **9,903 px = 0.478%**

**So culling every light point in the scene recovers under half a percent of
frame pixels**, and they are cheap fragments — a Gaussian, an IES row lookup and
aerial perspective, with no shadow lookup and no clustered light loop. This is
an area bound rather than a cost bound, so a large per-fragment constant would
scale it; it would take a **200x** per-fragment penalty for this lever to reach
the size of the shadow term above.

**Recommendation: do not build the light-point rung.** The shadow term is three
orders of magnitude larger and is already established as a night-specific waste.

## Status of these numbers

**Acceptance reports, not standing baselines**, per 7-9's own pins. Only the
canonical tier-1 set remains the regression gate.

Reports archived in the main tree at
`tests/perf/artifacts/run-archive/7-9-tier-sweep/` — eight tier arms plus the
34-shot `ratchet-full` run the draw-call table came from. The PNGs stay in the
capture worktree; the reports carry every number quoted above.
