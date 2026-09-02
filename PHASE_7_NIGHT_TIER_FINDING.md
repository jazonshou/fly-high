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

### Is skipping the night sun shadows a no-op on the image? Almost, and the exception is named

**Predicting the sign before measuring, because the failure mode is the opposite
of the obvious one.** If any shadowed term were NOT gated by the sun's
contribution, disabling shadows would BRIGHTEN the night image rather than leave
it alone, and a "free" change would ship a visible one.

**The gate is exactly zero at night, verified rather than assumed.** The water
shaders take `uniforms.sunColor` from
`atmosphere.sunColor.scale(atmosphere.sunIlluminanceNormalized)`, and
`sunIlluminanceNormalized` is `palette.intensity / PEAK_SUN_INTENSITY`. Palette
intensity is exactly 0.0 below -12 degrees, so **the uniform is (0,0,0) at every
night clock** — every term of the form `... * uniforms.sunColor *
directSunVisibility` is zero regardless of what the shadow map says. When the
lever is off, `sampleSunShadowReceiver` returns `1.0` (fully lit) at its first
line, so the substitution is 0 for 0.

**ONE TERM IS NOT GATED THAT WAY, and it is the reason this section exists.**
`SpectralOceanSystem.ts:913-914`:

    let subsurfaceScatter = vec3f(0.012, 0.13, 0.115)
      * nDotL * (0.1 + 0.12 * directSunVisibility);

It carries a `0.1 +` FLOOR and is **not** multiplied by `sunColor`, so
`directSunVisibility` moves it by up to 2.2x on its own. What saves it at night
is `nDotL = max(dot(normal, light), 0.0)` with `light = normalize(sunDirection)`
— a sun 21.5 degrees below the horizon gives a negative dot on any up-facing
normal, so the term is zero on flat water. **It is NOT zero on wave faces
steep enough to tilt toward a below-horizon sun**, which at the Cox-Munk
mean-square slope for 11 m/s (RMS slope 13.8 degrees) is a **1.56 sigma** face —
a real minority of ocean pixels rather than none:

| nDotL | shadowed | lit | delta (green, scene units) |
|---|---|---|---|
| 0.02 | 0.00026 | 0.00057 | 0.00031 |
| 0.05 | 0.00065 | 0.00143 | 0.00078 |
| 0.10 | 0.00130 | 0.00286 | 0.00156 |

**PRE-REGISTERED SIGNATURE (SWE III, before the capture — recorded here so the
capture TESTS this rather than confirms it).** If the mechanism is what we both
read, the artifact is *not* a uniform wash:

1. **Sparse speckle on wave faces**, tracking the slope tail — a few percent of
   ocean pixels, not a general brightening.
2. **Azimuthally biased toward the sun's below-horizon direction**, because only
   faces tilted THAT way clear the `nDotL` clamp. One side of each crest, not both.
3. **Strongly wind-dependent** — Cox-Munk `sigma^2 = 0.003 + 0.00512 U` puts the
   affected fraction at 0.99% at 5 m/s, 5.29% at 11 m/s, 8.16% at 15 m/s. A
   fivefold change in area between 5 and 11 m/s.

**If the capture shows UNIFORM brightening across the water, it is not this term**
and `:913` must not be "fixed" on the strength of it.

**Two corrections to my own reading, from the same source.** First, the scatter
colour is GREEN-DOMINANT and therefore lands in the rod peak: against
`SCOTOPIC_WEIGHTS = (0.03, 0.42, 0.55)` it scores **0.1182 scotopic against
0.1038 photopic, a ratio of 1.138 — MORE visible to rods than to cones.** That is
the reverse of the aviation-red case, which survived scrutiny partly because rods
weight red at 0.03. So "small in scene units" is not merely unreliable here, it is
biased in the wrong direction. Second, `directSunVisibility = cloudShadow *
sunShadow` is plausibly **≈1** at night — nothing occludes a sun that is not
there — which makes the live factor `0.1 + 0.12 = 0.22` rather than the floor
alone, roughly doubling the term. Both to be confirmed from a frame, not from
reading.

**So this is not a strict no-op and must not be quoted as one.** It is a no-op
everywhere the sun's contribution gates the shadow — which is everything except
this one ocean term — and on steep night wave faces it is a bounded brightening
of at most ~0.0016 scene units, and only where the night shadow map currently
reports shadowed at all. **Under the scotopic response small scene values are
not small display values**, so the honest close would be a pixel check on a water
shot at night.

> **THERE IS NO NIGHT WATER SHOT. Corrected 2026-09-01, before the capture.**
> This section first named `water-3m` and `water-25ft` as the check. Both are
> DAYTIME: sun elevation **+31.97** and **+11.34** degrees, computed from
> `solarApparentPosition` the same way as the night clocks above. The sun is up,
> `sunColor` is nonzero, and the entire night argument — the `intensity: 0.0`
> clamp below −12 degrees, `nDotL` failing against a below-horizon sun — does not
> apply at either vantage. **A daylight shot cannot show a night-only term.**
>
> And it is not a bad choice of two shots. **The night and water populations are
> disjoint across the whole set.** The dark band holds exactly `night`,
> `night-moonlit` and `night-beacon-offset`, and all three are the SAME airfield
> approach pose — 152 m AGL, `offsetXMeters: -2500`, chase camera down the runway
> axis. The water shots are `water-3m` (16.5 h), `water-25ft` (18.5 h) and
> `coast-10km-lowsun` (19 h). No night vantage contains water.
>
> **So the verdict is ABSENT, not null**, and the distinction is the point: this
> is a gap in the shot set, not evidence about the term. Neither water shot sets
> `windSpeed` either, so the wind-dependence leg was independently untestable —
> the smaller version of the same problem.
>
> **~~The useful bound that survives.~~ REFUTED THE SAME HOUR — do not quote it.**
> I wrote that the ungated `:913` term *"cannot affect a single frame in the
> capture set"* and that it is *"invisible to every delivery gate we have"*.
> **Both are false. `night-moonlit` contains a water surface.**
>
> **The error: inferring frame CONTENT from shot NAMES.** The name analysis above
> stands — the named sets really are disjoint and no `water-*` shot is at night.
> But "no night shot is NAMED for water" does not establish "no night shot
> CONTAINS water", and I wrote the second having checked only the first. SWE III
> went to the frame; I went to the shot table.
>
> **Confirmed independently on a DIFFERENT frame.** SWE III measured their own
> captured arms; I measured the committed baseline
> `tests/perf/baseline/night-moonlit.png`:
>
> | region (baseline, 1280x720) | B/G | luma sd |
> |---|---|---|
> | candidate water, rows 244-254 | **1.463** | **1.16** |
> | sky, rows 40-90 | 1.411 | 0.45 |
> | low terrain | 1.246 | 15.98 |
>
> Blue-dominant — the highest B/G of the three — and **13.8x smoother than
> terrain**. A row scan across 230-272 shows it bounded below by a transition at
> rows 256-262 where mean climbs 6.3 -> 19.2 and texture returns: **a shoreline,
> not a haze band.** My first window (238-252) straddled that edge and read
> sd 2.37; the band is narrower than I first drew it, which matters because a
> window including the edge dilutes a real effect with high-variance rows that
> are not water.
>
> **Status is UNTESTED, not absent.** Containing the substrate is not the same as
> being able to exhibit the effect: that water sits near the horizon where wave
> faces are sub-pixel, so the tilted-face minority is averaged inside each pixel
> rather than resolved. Leg 2's azimuthal bias in particular probably cannot
> appear at this vantage.
>
> **The decisive test needs no new vantage** and SWE III is running it: two arms
> differing only in `:913`'s floor, present versus removed, measured over that
> region rather than whole-frame. A null from that is worth far more than the
> absent recorded above, because it is **a null on a shot that could have shown
> it** — and it would properly motivate a night-over-water vantage rather than
> merely wanting one.
>
> **MEASURED, AND MY REGION WAS WRONG TOO (SWE III, same evening).** The A/B
> was run — two arms differing only in `:913`'s floor — and it settles the
> magnitude while overturning the region BOTH of us identified above.
>
> **Rows 244-254 are not ocean.** SWE III pre-registered that window from the
> smoothness plateau, exactly as agreed, and got a byte-identical A/B. Then the
> **1000x amplification control returned max delta 0 in the same window** — a
> thousandfold amplification, invisible. That cannot be a null about the term; it
> is a window containing none of the phenomenon. **The ocean actually draws at
> rows 263-265 and 313-315**, and none of our rows appear.
>
> **So the water-versus-sky discrimination we both performed was right about what
> the band LOOKS like and wrong about what DRAWS it.** Two people, two different
> frames, sound discriminators (B/G, luma sd, a shoreline edge), same wrong
> region. **Blue and smooth is necessary and nowhere near sufficient.** My table
> above stands as a description of that band and must not be read as locating the
> ocean.
>
> **At the rows where the ocean does render (y260-320, full width):**
>
> | arm | total | max | >=1px | >=2px |
> |---|---|---|---|---|
> | shipping `:913` on vs off | -0.1 | 1 | 12 | 0 |
> | 1000x amplification control | -55.4 | 14 | 148 | 64 |
> | noise floor (warm-up vs A) | -0.4 | 1 | 4 | 0 |
>
> **12 pixels at delta >= 1 against a noise floor of 4, and ZERO at delta >= 2.**
> The term is live, reaches the GPU, and contributes at most one display byte at
> this vantage. The 1000x control proves the instrument can see it, so **this is
> a NULL and not an absent** — on a shot that genuinely contains the substrate.
>
> **What only the positive control caught.** Pre-registration defends against
> tuning a parameter after seeing the data. It does not defend against a
> parameter that was WRONG WHEN FIXED, and a window containing none of the
> phenomenon yields a null indistinguishable from a real one. Neither the
> pre-registration, nor the noise floor, nor the care taken choosing the window
> separated them — only **"would this window show the effect if the effect were
> enormous?"**
>
> **Status: measured-and-small, neither fixed nor closed.** The static case is
> untouched — two adjacent terms, one gated by `sunColor` and one not, a `0.1 +`
> floor, a green-dominant colour at a 1.138 scotopic ratio. The empirical case
> for urgency is weak at every shipped vantage. The far water flattens exactly as
> predicted (1000x shows nothing where normals filter smooth) while the nearer
> rows carry the term, so **a near-field night-over-water vantage is now an
> earned open question rather than a wanted one.**
>
> **Why this correction is written here rather than replacing the text above.**
> The false claim landed in `d0c7ecc` and this correction was lost between my
> writing it and that commit; it had to be re-applied. **"No instrument can see
> it" is the specific kind of claim that stops anyone looking again**, so it must
> not sit in the record unmarked.

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

> **CORRECTED 2026-09-01: "archived in the main tree" IS FALSE.**
> `tests/perf/artifacts/` is gitignored (`.gitignore:45`) and
> `git ls-files tests/perf/artifacts/run-archive/` returns **zero tracked
> files**. These reports exist on ONE machine, in an ignored directory. They are
> in no commit, and a clean checkout has none of them. **Every number quoted
> above is therefore backed by evidence that cannot be retrieved by anyone but
> the person holding this disk** — which is the same shape as a correction that
> never lands: it reads as durable and is not. Either the archive moves
> somewhere tracked, or this sentence has to say "on the capture host only".

Reports at
`tests/perf/artifacts/run-archive/7-9-tier-sweep/` **on the capture host only** — eight tier arms plus the
34-shot `ratchet-full` run the draw-call table came from. The PNGs stay in the
capture worktree; the reports carry every number quoted above.
