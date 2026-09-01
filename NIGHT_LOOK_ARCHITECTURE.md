# Night Look Architecture — the appearance of the world after dark

**Created 2026-09-01. Owner: Senior Principal Engineer (flight-simulator-78), per
Jason's direct mandate ("you should lead in architecting how things look at
night"), ratified by the PM with the Phase 7 Lead's 7-4a work and measured
constants as load-bearing inputs.** Binding order: `ARCHITECTURE.md` decision
log → this document → `PHASE_7_EXECUTION_PLAN.md` §5 (7-4) where they touch.
Deviations land in the Phase 7 §11 log per house rule.

---

## 0. The mandate, verbatim

Jason flew the night captures (`night-moonlit` and `night`, at head after the
lamp calibration) and rejected the look:

> - *"I don't like how everything is black and white — that's not what night
>   looks like"*
> - *"I want to see more blue and there should be a stronger lighting affect
>   from the moon. It's okay if it's not perfectly realistic — the moon can be
>   stronger than expected and there can be more blue in the sky than
>   expected."*
> - *"The run way lights should not all be white — they should be yellow and
>   stuff and should look realistic"*
> - *"…it should be much lighter, less blurry/black/white and more colorful
>   and peaceful"* (stars explicitly deprioritised for now)
> - **"Exaggerated colors are okay, sometimes."**

Reference image: a Red Dead Redemption 2 night — deep saturated blue sky, a
landscape you can READ, grass and water holding their own hue, warm light
sources against the cool field.

**The design target is therefore CINEMATIC night (film "day-for-night"), not
physiological night.** This is a deliberate trade, not a misunderstanding of
rod vision: the physiological model the renderer shipped (achromatic rod
pathway, acuity blur, Naka–Rushton compression) was CORRECT physiology and is
the wrong product. The docblock guard in `ScotopicVision.ts` (Jason's words
embedded at the constants) exists so nobody "fixes" this back toward realism.

---

## 1. Ground truth — why the night looked the way it did

Every complaint maps to a measured mechanism. This section is the diagnosis
of record; §2 is the design that answers it.

**The pipeline at night** (rodFraction ≥ threshold): scene HDR → ScotopicVision
(slot 0: acuity blur → rod luminance `dot(scene, [0.03, 0.42, 0.55])` →
Naka–Rushton `nits/(nits+σ)` with σ = the frame's scene-key luminance → display
gain → highlight term → tint) → ACES (one exposure curve, ceiling
`MAX_EXPOSURE = 4.698`) → FXAA. Bloom is tier-gated on top.

| Jason's words | Mechanism, measured |
|---|---|
| "black and white" | The rod path collapses RGB to a scalar (`dot` with the rod weights) and re-tints with one fixed vector — **hue destruction is total at rodFraction 1** by construction. |
| "much lighter" | The whole rod response output maps under `SCOTOPIC_MID_GREY_TARGET = 0.16` after the exposure multiply — a ~40-byte display ceiling for everything that is not a highlight-term source. The response's three usable decades (half-saturation at scene-linear 5.731e-4) serve moonlit terrain correctly in RELATIVE terms; the OUTPUT mapping is what pins the whole image dark. |
| "stronger moon" | `MOON_PEAK_LIGHT_INTENSITY` was 0.055 scene units; moon illuminance is fed physically (7.09e-2 lux at the `night-moonlit` clock — real, and dim). |
| "less blurry" | Acuity blur at `0.6 + 2.4·rod` texels — physiologically defensible, dominant cause of the "soup" read. |
| lamps "not all white" | Two causes: the highlight term is ACHROMATIC (`highlight` is a scalar added inside the tint multiply, so a lamp's own colour dies in the rod `dot`), and fixture colour temperatures were uniform. |

Supporting measurements this design trusts (all 2026-09-01, instruments
validated by control arms): the response ladder
([night-exposure-ladder] — half-saturation 5.731e-4, 99% of output spent by
5.7e-2 scene); σ live at `night-moonlit` = 5.9459 (scene key) vs physical
adapted 0.00387 cd/m²; `SCENE_UNIT_TO_NITS = 7345.6`;
`displayGain = 0.16/4.698 = 0.034057`; lamp calibration
`AIRFIELD_LAMP_SCENE_SCALE = 5.7e5` anchored to E = I/d² physics; the lit-gate
(floor 0.90 / 200 px) armed in capture.

**Standing warning, measured twice:** do NOT feed σ the physical adapted
luminance. Compression WORSENS as σ falls (σ at the physical 8e-5 yields a
1.0000:1 uniform grey field that passes every capture gate). The rod range is
misplaced relative to the display mapping, not missing.

---

## 2. The design — three signal classes, one ladder

The night image is architected as three signal classes with different
perceptual treatments, replacing the single achromatic pipe:

### 2.1 Ambient class (terrain, sky, clouds, water) — "day-for-night"

- **Level, by ground anchor.** The night look's brightness is set by ONE
  art-directed anchor per ladder rung: *the display value moonlit mid-albedo
  terrain should read.* **ANCHORS UPDATED FROM JASON'S ROUND-1 REACTION
  (2026-09-01):** he called the round-1 `night-moonlit` frame — terrain-band
  median **0.1237** — *"on the right track"*, and `dusk-mesopic` at
  **0.3467** *"wayyy too bright"*. So: moonlit anchor **[0.10, 0.16]**
  (my provisional floor of 0.15 sat ABOVE his taste — the range moved DOWN,
  and the planned `SCOTOPIC_MID_GREY_TARGET` lift 0.16 → 0.30 is
  **CANCELLED**: round 1's moon+retention changes already landed the moonlit
  rung at his level). Moonless `night`: provisional **[0.05, 0.10]**,
  awaiting his word. Mesopic `dusk-mesopic`: **[0.15, 0.24]** provisional
  (the rod-interpolated point between day 0.38 and approved night 0.124 is
  ≈0.19). The anchor is calibrated against the captured artifact
  (terrain-band median), never against a formula, because the scene-key
  theory and the frame have already disagreed once today.

  **The twilight dimming (round 2, RE-KEYED — the §5 risk fired and Jason
  chose Option B):** dusk was NOT regressed by the probe — both candidate
  mechanisms died by arithmetic (the moon lift added 0.0071 scene units at
  dusk's 3.8°-altitude moon, sub-percent; dusk's exposure computes to 3.851,
  unclamped) and no pre-probe dusk frame exists (7-0-a's shot was never
  baselined; round 1 was its first human viewing). His reaction is a fresh
  ANCHOR — and his choice, verbatim *"golden hour bright and warm, blue hour
  properly dark"*, keys the dip to SUN ELEVATION: two targets minutes apart
  in elevation and similar in raw luminance, which adaptation-keying could
  not separate. As landed (`twilightExposureDipFactor`, EnvironmentDirector):
  the dip rises over sun-sine +0.02→−0.05, holds at 0.45 through the blue
  hour (−0.05→−0.16), releases −0.16→−0.26 — window edges DERIVED from the
  shipping ephemeris (golden hour 19.0h = +0.111 above the window;
  `dusk-mesopic` 20.45h = −0.109 mid-hold, factor 0.5500, targeting ≈0.19
  from 0.347; `night-moonlit` 23.75h = −0.369, 0.11 of sine below the
  release, factor exactly 1.0000 — the ONE approved frame pinned by shape).
  Verified numerically across nine ladder points before capture. Companion
  finding (`326f94e`, the Lead): `MOON_PEAK_LIGHT_INTENSITY` CANNOT brighten
  moonlit ground at any value — ground and σ are the same quantity, the
  ratio is 0.5 by construction; it is a CONTRAST lever (shadows 2.65×
  darker at 0.18), so "stronger moon" belongs to exposure work, not that
  constant.
- **Colour: partial chroma retention.** `SCOTOPIC_CHROMA_RETENTION`
  (probe-landed at 0.65) — the rod response still sets luminance; the scene's
  own hue survives at retention strength (`sceneHue = soft/dot(soft, W)`, so
  neutral input stays exactly neutral). §2.2's per-pixel cone weight extends
  this upward for bright pixels; the 0.65 base is the FLOOR for the dim
  field.
- **Blue: two separate levers, named apart.** (a) The rod TINT chromaticity
  (`SCOTOPIC_TINT`, normalised to luminance 1) — the cool cast of the whole
  field; (b) the night SKY's own colour (atmosphere path under moonlight) —
  the deep-blue gradient of the reference image. The probe touches both;
  the architecture keeps them independently tunable because Jason may want a
  blue sky over neutral ground.

  **Round 1 proved the separation is not optional: the probe's bluer tint
  moved `skyBlueDominance` the WRONG way (0.0017 → 0.0012)** — chroma
  retention returned the sky's own near-neutral darkness, beating the tint.
  The sky must carry blue RADIANCE. Design (round 2): the moon becomes a
  night source of the SAME shared aerial-perspective integral that already
  produces the day sky — the moonlit sky IS Rayleigh-scattered moonlight,
  so the deep-blue gradient, the horizon falloff, and the blue depth-haze
  on night terrain all fall out of the owned integral and agree with each
  other by construction (exactly the 1C-5 property, extended to night).
  Mechanics: below sun elevation −8° the aerial binding's source swaps to
  the moon (blend over −4°…−8°), with three mitigations named now —
  `sunDiscVisibility` gates off the sun-disc branch (the moon's disc is
  drawn separately), the moon-phase term gets the TRUE sun direction via a
  dedicated uniform (it currently reads `aerialSunDirection` and would
  self-light the moon to permanently full), and the radiance scale
  `NIGHT_SKY_MOON_RADIANCE_SCALE` is art-directed (the physical scale is
  ~450,000× below visible — the docblock at `MOON_PEAK_LIGHT_INTENSITY`
  already records why absolute night levels are chosen, relative ones
  physical), tuned by capture against `skyBlueDominance` targeting
  ~[0.04, 0.12] (day reads 0.147).
- **Blur: near-zero.** Probe-landed at `0.25 + 0.75·rod` texels. The
  architecture treats acuity blur as an art knob with a low ceiling, not a
  physiological obligation.

### 2.2 Source class (lamps, stars, moon disc) — per-pixel cone chroma

**Mechanism (shape credited to the Principle Engineer, adopted as the design):
a lamp bright enough to see is bright enough to see in colour.** A runway
light at approach range is a PHOTOPIC source against a scotopic background —
which is exactly why real red/white PAPIs and green/red threshold bars work
at night — so chroma survival is decided PER PIXEL by the pixel's own
luminance, through the same physiology that already decides the frame-wide
blend: `cone(pixel) = 1 − rodFractionForAdaptedLuminance(sharpNits)`, and the
pixel's chroma keep is `max(SCOTOPIC_CHROMA_RETENTION, cone(pixel))`, in the
pixel's OWN hue. Dim ground keeps the art-directed 0.65; a lamp, the moon's
disc, or any future bright source recovers its full fixture colour with a
smooth physiological transition between. The SHARP sample feeds it — the
same reasoning that made 7-4a read sharp rather than blurred.

Measured basis (PE, 2026-09-01): the shipped lamps render at saturation
median 0.020 with ZERO clipped pixels (peak channel 251) and a BLUE-leading
residual — `SCOTOPIC_TINT` showing through, not any fixture colour. The mix
at rodFraction 1 discards all chroma by construction; this class restores it
where the eye would.

**Two clean separations this design guarantees:** `cone(pixel)` is keyed to
SCENE nits, and the §2.1 level lift moves only the DISPLAY mapping — so
lifting the field cannot accidentally push ground into full chroma. And the
7-4a highlight term keeps its measured law unchanged (log2 above σ, gain
0.06, 2.384:1 across the source decades vs 1.0100:1 without): the §2.1
ladder move changes where GROUND maps, not where sources sit relative to the
response — they remain 3–5 decades above ground where the curve has spent
99% of its output, so the term stays for measured reasons, not deference.

Fixture input hues are the PE's half: `AIRFIELD_LAMP_RGB.white` derived from
the Planckian locus at ~2700 K (incandescent edge lights — Jason's "yellow
and stuff"), plus the existing green/red directional colours; invisible until
this class lands, so both land in the same round with attribution carried by
the PE's lamp-pixel saturation/hue instrument rather than by sequencing.

### 2.3 Moon as key light

- Intensity: probe-landed 0.055 → 0.18 (~3.3×). Jason has sanctioned further
  ("stronger than expected"); the knob stays free through iteration.
- The moon's SPECULAR path on water (glitter lane) is part of the reference
  look and rides the existing sun-specular machinery at the moon's direction —
  priced only after Jason reacts to round 2, since it may already read well
  at the higher intensity.
- Moonlight SHADOWS stay with 7-9's existing trade (Gate 7A handed it there);
  this document does not reopen it.

### 2.4 The ladder

Three pinned rungs, one blend variable (rodFraction, unchanged — the
perceptual call stays physical even though the look is art):

| rung | shot | anchor (terrain-band median) | retention | notes |
|---|---|---|---|---|
| mesopic | `dusk-mesopic` | interpolated | interpolated | the only rodFraction ∈ (0,1) shot; pins the blend |
| scotopic, moonlit | `night-moonlit` | [0.15, 0.30] | 0.65 (probe) | the flagship frame |
| scotopic, moonless | `night` | [0.06, 0.14] | 0.65 | darkness with legible shapes |

Daylight is UNTOUCHED by every change in this document: the scotopic pass
remains a bit-for-bit copy above the pass threshold, and the acceptance
instrument (§3) asserts it.

### 2.5 Derived vs art-directed — the constant registry

Art-directed (Jason's sanction, tuned by iteration): ground anchors,
`SCOTOPIC_MID_GREY_TARGET`, `SCOTOPIC_CHROMA_RETENTION`, `SCOTOPIC_TINT`,
blur base/scale, `MOON_PEAK_LIGHT_INTENSITY`, fixture colour temperatures,
night-sky chroma. Derived (physics, do not art-direct): moon illuminance
(ephemeris), `SCENE_UNIT_TO_NITS`, σ-as-scene-key mechanism, rod-fraction
thresholds, lamp candela ratios and `AIRFIELD_LAMP_SCENE_SCALE` (anchored to
E = I/d²), the highlight term's log law. **Every art constant lives beside a
comment naming which of Jason's sentences it serves** — the probe started
this pattern and it is now the rule for the night path.

**Colour reference frame (PE's derivation, canonised):** night fixture and
source colours are authored in the AMBIENT-ADAPTED frame — the observer is
adapted to ~4,100 K moonlight, not D65. A D65-referred 2700 K blackbody
(`[1.000, 0.417, 0.100]`) is MORE saturated than the amber caution fixtures
and would destroy the white/amber coding; the adapted value
(`[1.0, 0.78, 0.52]`) separates from amber in both green and blue. **The
white/amber SEPARATION is a pinned joint invariant** — it depends on both
the fixture colours and the chroma-retention floor, so a retention retune
below ~0.65 must re-check the separation test, which pins the property
rather than the values.

### 2.6 Twilight regime — the dusk inversion and the missing arch

**Jason's round-3 rejection, verbatim (2026-09-01):** *"the trees are way
too light and the mountains are light two [sic] — which contrasts strangely
with the super dark backdrop."* The frame is `optc2-round/dusk-mesopic.png`
(tree `f9c7bcd`, which contains the landed dip).

**Read this first: the dip was live in the rejected frame and it worked.**
Canonical `terrainBandMedianLuma` (night-look-metrics.mjs) reads **0.2485**
post-dip against the **0.347** pre-dip figure — the §2.1 dimming did its
job, and Jason rejected the result anyway. So do not reach for "dip
harder": a deeper dip multiplies EXPOSURE, which dims sky and ground by the
same factor and **cannot change their order**. The complaint is the ORDER.

*Instrument provenance, because two instruments already disagreed here:* a
quick strip-band probe (skyground.mjs, horizontal sixths of the frame) read
mid-frame trees at 0.350 on the same PNG — numerically identical to the
pre-dip 0.347 by coincidence, which briefly looked like "the dip never
applied". The canonical metric samples a different population (the §3
terrain band, which excludes the near forest that fills the lower half of
this vantage). Every number in this section names its instrument; the
canonical metric is authoritative for anchors, and the strip bands are used
ONLY for the sky/ground relation, where the canonical instrument has no
sky reading.

**The measured inversion (strip bands, rejected frame):** upper sky
**0.080**, lower sky 0.088, far terrain 0.089, mid terrain (forest)
**0.350** — the ground outglows the sky ~4×. Reality at −6° civil dusk is
the reverse by one to two orders: zenith ~2–10 cd/m² against unlit ground
~0.2 cd/m². A lit foreground under a darker sky is the grammar of a
COMPOSITE, which is exactly Jason's *"contrasts strangely"*.

**And the backdrop is not merely dark — it is colourless.**
`skyBlueDominance` on the rejected frame is **−0.0091** (canonical metric):
the twilight sky has NO blue at all (mean upper-sky RGB 21,20,22 — neutral;
strip-band instrument). This is a MISSING MODEL, not a mis-tuned one:

- The day scatter model's terms gate on `max(sunY, 0)` — collapsed.
- The night-sky model (moon-scatter + stars) is at `nightStrength`
  `(−sunY − 0.03)/0.25` = **0.316** — one third strength.
- Nothing models the **twilight arch** — the deep-blue upper dome that
  ozone (Chappuis-band) absorption produces from sunlight crossing the
  upper atmosphere after sunset. The dome falls into a trough between two
  models and renders neutral grey-black. There is no term to turn up.

**Why the ground stays lit while the dome dies — the floor regime.**
`ambientIntensity = 0.05 × max(skylightScale, NIGHT_AMBIENT_FLOOR_SCALE)`.
At dusk-mesopic, `skylightScale` = 2.672 lux / reference ≈ **3×10⁻⁵**; the
floor is **0.2**. Two facts scale this from nudge to regime:

1. The floor is **10× the physical skylight scale at sunset** (≈0.021), so
   the `max()` snaps to 0.2 while the sun is still up (~10°) and ambient is
   then CONSTANT from late afternoon through midnight. The only twilight
   decline the ground sees is the dip's ×0.55 — while the real sky falls
   three orders of magnitude.
2. The floor's stated reasons (its 7-2 docblock) are **night constraints**:
   the fp16 beauty buffer cannot carry a physical 10⁻⁹ ambient, and the rod
   pathway needs non-zero input. Both bind at FULL NIGHT — and full night
   carries Jason's approved frame. Neither binds at dusk, where the moon
   and the (missing) arch supply light and 10⁻³-scale values are fp16-fine.
   Twilight inherits a night constant by accident of `max()`.

**The fix is one architecture item, not two tunings** — and it is also
Jason's other standing ask (*"incorporate more blue (dark blue) into the
night sky to light up surroundings a bit more"*). Sky dome and skylight
must become the same quantity:

- **(a) A twilight-arch term in the dome** (AerialPerspective sky WGSL): a
  deep-blue zenith with the warm horizon residual left to the existing
  scatter remnant. Chromaticity from the palette's own art-directed
  twilight rows (the −12°/0° zenith anchors are already the right blue —
  reuse them so dome and light rig finally share a source). Magnitude keyed
  to sun elevation in the SAME window family as the dip: zero above sunset
  (daylight bit-identical by construction), peak through the hold band,
  **zero at and below the −0.26 release** so the approved night frames are
  untouched by shape, exactly as the dip pinned them.

  **ROUND 1 FIRED STOP CONDITION 3 AND RESHAPED (a) — recorded, because
  the first mechanism is the obvious one and the next person will reach
  for it.** The first cut rode the binding's `aerialAmbient` slot, which
  `applyAerialPerspective` paints onto EVERY distant terrain pixel; the
  IBL compounded it; and σ (sun + moon + hemispheric only) never learned
  the new radiance while (b)'s floor cut lowered its ambient term — scene
  radiance up, key down, and the Naka–Rushton auto-centring re-exposed
  the whole frame upward. Measured: terrain 0.2523 → 0.5313 (rose 2.1×
  where it had to fall), sky 0.0846 → 0.4992 (5.9× ≈ 3.7× arch × 1.6×
  recentring — the arithmetic reconstructs from the mechanism). Jason,
  on the frame: *"it should not look like an oil spill."* As reshaped:
  the arch is a binding field consumed ONLY inside `skyRadiance()` —
  dome and IBL probe receive it, the terrain haze does not (twilight air
  is optically thin without a sun to scatter through; mountains
  silhouette against the blue, which is the point) — with the
  horizon-bright gradient EXPLICIT (`TWILIGHT_ARCH_ZENITH_FALLOFF`, not
  borrowed from `(1 − t)`), and **σ taught the arch's ground irradiance
  in closed form** (`TWILIGHT_ARCH_KEY_FACTOR = 1 − ⅔·falloff`, derived
  from the gradient so the two cannot drift, zero outside the window so
  day and night σ stay bit-identical). The general fix — σ integrates
  the whole dome — is a larger refactor this term approximates exactly
  for the arch's share.

- **(a″) ROUND 2 STOPPED AGAIN, AND THE MECHANISM WAS THE ADAPTATION'S
  INPUT — resolved physically, no ladder amendment.** With the arch
  sky-path-only and σ taught, the sky display stayed pinned (~0.49)
  across a 2.3× σ change — the saturation signature: at rod 0.73 the
  response re-centres ground and compresses sky/ground toward ≲2:1, and
  every radiance knob is inert against it (two rounds are the evidence).
  The first-draft answer — art-temper the rod fraction through the
  window — was HELD by the PM, whose counter-hypothesis proved out:
  `adaptedLuminanceCdM2` was Lambertian GROUND only, and at twilight the
  brightest thing in a pilot's visual field is the sky dome. Adaptation
  is what fills the FIELD. Field-weighted (SKY_VIEW_FRACTION 0.45, dome
  = the PHYSICAL illuminance model's diffuse sky / π — NEVER the
  rendered art dome, which is ~3000× physical at night and would slam
  rod to 0 and kill the approved look), the model's own arithmetic
  gives: noon 0→0, golden 0→0, dusk **0.732→0.361**, both nights 1→1
  exactly (the physical sky term is zero below sine −0.31 — night
  survives structurally, not by tolerance). §2.4's *"the perceptual
  call stays physical"* SURVIVES — the call was always physical; its
  input was wrong. Pinned at all five ladder clocks. Deferred with a
  named trigger: the σ-side sky term (scene units) is correct
  arithmetic but moves the night rod image 1–2% against a triple-pinned
  quantity — it is cut ONLY if round 3 still shows compression, with
  the night delta quantified first.

- **(a⁗) ROUND S — the below-horizon SUN was the crown-warmer, and round
  M's double stop is what found it.** The moon recession moved the
  crowns 2.3% (1.166→1.139, target <1.0) and the ratio FELL — both
  pre-registered stops fired, killing the moon attribution. The failure
  pattern plus one code line identified the real mechanism:
  `sunIntensity = palette.intensity × overcastDimming` with NO horizon
  gate, and the palette lerping 1.1@0° → 0.0@−12° LINEARLY — a warm
  directional at ~0.54 (10% of noon) burning from a sun 6° below the
  horizon, which σ multiplies by `max(sunY, 0)` = ZERO. A σ-blind warm
  directional, the arch defect class, pre-existing and bigger than
  everything tuned around it. Retrodicts all six capture rounds,
  including both failed predictions. THE FIX IS A SPLIT: the DIRECTIONAL
  light (and σ, through the shared variable — they now agree) gets a
  narrow GEOMETRIC gate, exactly 1 at/above sine +0.02 and 0 at/below
  −0.02 — a horizon fact, deliberately NOT the twilight art window, with
  a divergence assertion so nobody can route one through the other —
  while the SCATTER path (snapshot `sunIlluminanceNormalized` → aerial
  source, clouds, water glint) keeps the ungated palette ramp: the
  atmosphere genuinely sees a below-horizon sun and the sunset afterglow
  must survive. Also from round M, recorded: receding a light AND its σ
  term together is a NO-OP on the rodded component and a BRIGHTENER of
  everything that light does not illuminate — the coupling behaved
  exactly as built; the darkening prediction was the error
  (auto-centring, third appearance).

- **(a‴) ROUND M — the moon RECEDES through twilight (consumer #6), a
  correctness fix taken without waiting on taste** — its crown
  attribution WITHDRAWN by its own capture (see a⁗); the recession
  stands on the physical over-share alone. The cream tree
  crowns survived every dusk round because they were never dome-lit:
  crowns measured R/B 1.618 (null) and 1.17 (rA) while the ENTIRE dome
  measured R/B 0.14 at six elevations — the crown colour barely
  responded to the dome flipping from near-black to deep blue, which is
  a measurement that the dome is not the cause. The warm directional is
  the MOON: `MOON_PEAK_LIGHT_INTENSITY` is a night calibration, and
  carried into civil twilight unwindowed it made the moon comparable to
  the whole sky's ground irradiance — a real 2.7-lux dusk sky swamps a
  ≤0.25-lux moon ~10×. Hidden while the rod path processed the warmth
  away; exposed when field adaptation routed dusk through the raw path
  (the second night-calibrated constant that fix has surfaced — the
  lamps were the first). `MOON_TWILIGHT_RECESSION` 0.9 scales the
  intensity AT ITS DERIVATION so the light and σ's moon term recede
  together by construction; exactly 1 at and below the release, so the
  night frames and the moon anchor's arithmetic are byte-for-byte
  shipped. Tuned against the crown-warmth patches (dusk pooled R/B must
  cross below 1.0), never against night.

- **(a′) The lamps are the window's FOURTH consumer** (dome, floor, σ,
  lamps — one window, none can drift). Jason's second dusk complaint,
  verbatim: *"Airport lights are way too bright/spread out given the
  current lighting conditions."* Mechanism confirmed at source: the lamp
  daylight gate returned the literal 1 for the whole of civil twilight,
  so lamps burned at full NIGHT calibration at −6.12°. The gate's early
  return moves from the horizon to the −0.26 release — same syntactic
  no-reach-through promise, same edge as everything else in this section
  — and through the twilight band the lamps ramp by
  `AIRFIELD_LAMP_TWILIGHT_CUT × twilightArchStrength`, now asserted
  illuminance-blind per-lux across the band. `AIRFIELD_LAMP_SCENE_SCALE`
  does not move. The shipped 500× step at the sunset crossing second is
  recorded at the function as pre-existing and out of scope.
- **(b) Ground ambient rides the dome down.** Replace the constant floor
  with a windowed one: `floor(sine) = 0.2 × smooth01` over the same
  sunset→release window, so the floor is reached EXACTLY at the arch
  release (−0.26) and `max(skylightScale, floor)` ramps through twilight
  instead of flat-lining at sunset. At and below the release the expression
  is the shipped `max(…, 0.2)` — **the approved night frames and the
  floor's fp16/rod rationale are preserved by construction, not by
  re-measurement**. At dusk-mesopic the floor becomes ≈0.038: ground falls
  ~5×, sky rises via (a), and the order flips from both sides.
- **(c) Night ambient takes the dome's chromaticity — RESOLVED WITHOUT A
  NEW MECHANISM (deviation from this note's first draft, logged).**
  Reading the code showed the hemispheric's palette rows are ALREADY the
  arch's blue: both twilight zenith anchors normalize to the same
  chromaticity within 1% (−12° → (0.141, 0.353, 1.0); 0° →
  (0.136, 0.364, 1.0)) — which is exactly where `TWILIGHT_ARCH_TINT`
  comes from, so dome and light rig now share a source by derivation.
  And the dome's new blue reaches materials through the IBL probe
  re-render (the probe integrates the same `skyRadiance` the arch rides).
  A second chroma path through `ambient.diffuse` would re-open risk (3)
  for no observable gain. Revisit ONLY if capture shows ground ambient
  reading warm against the new sky.

**Acceptance is a RELATION, not a brightness target:** at `dusk-mesopic`,
sky-band median MUST exceed terrain-band median (new §3 metric
`skyGroundRatio`, floor ≥ 1.5 provisional, real-world ~10×; strip-band sky
numerator over canonical terrain-band denominator, both named in the
metric's output). A relation cannot be satisfied by darkening everything,
and it survives any later exposure change — it is also literally what Jason
described. Endpoint pins: `night-moonlit` terrain median stays in the §2.1
anchor and its `skyBlueDominance` may only move by (c)'s deliberate,
metric'd amount; golden hour (+0.111) is above every window — untouched.

**Risks named:** (1) clouds read the snapshot `ambientColor`, which lags
the arch — twilight clouds may sit warm against the new blue for a frame
family; follow-up, not blocking. (2) A brighter twilight dome washes early
stars — correct behaviour (stars belong after the blue hour), but the §3
star metrics run at night rungs only, so no gate moves. (3) (c) touches
every material's ambient below sunset; the day-identity guard is the
window's zero above sunset, and the §3 daylight bit-identity assertion
stays the backstop.

---

## 3. The acceptance instrument — and its own red demonstration

Jason's eye is the judge; the instrument exists so his judgment, once given,
is PINNED. Extend the capture report the way `litRegion` was built (computed
from the artifact at capture, asserted in the gate block, baseline-independent,
sample-size checked):

- `terrainBandMedianLuma` — the §2.1 anchor, per night shot, gated to its
  rung's range once Jason approves a round.
- `hueDiversity` — among visibly colored terrain-band pixels (relative
  saturation ≥ 0.15, luma ≥ 0.02), the LUMINANCE FRACTION whose hue sits
  more than 30° off the frame's luminance-weighted dominant hue. This is the
  "black and white" gate, and its definition was earned the hard way — see
  the demonstration record below.
- `skyBlueDominance` — mean `B − (R+G)/2` over the sky band; a product of
  blueness AND brightness, which is what "more blue in the sky" means
  (positive and bounded: deep blue, not cyan, not black).
- `lampMeanSaturation` — mean relative saturation among lamp pixels **in the
  0.45–0.60 luminance SHOULDER band within a lamp mask (4 px of a ≥0.90
  core), never at the peak** (PE, measured on `122f9fa` with clean
  provenance): saturation rises monotonically as brightness falls (cores
  0.017, shoulder 0.174–0.233), the cores read neutral 245,245,245 with only
  15/443 hard-clipped — that is the ACES shoulder desaturating highlights
  toward white BY DESIGN, and a bright core reads white to the eye too. A
  gate at the core would measure the tone map and tuning to beat it would
  make everything below garish. Sample-size guard as everywhere (0 lamp
  pixels = instrument failure, never a pass).

  **A SATURATION SCALAR CANNOT GATE THIS LINE — round 2 proved it (PM,
  2026-09-01).** The round-2 shoulder read 0.2434 while a quarter of its
  pixels carried the WRONG hue. The metric measures HOW MUCH colour, never
  WHICH: *ask what a PASS looks like if the feature is WRONG rather than
  absent — identical.* The gate is now `lampOffFixtureFraction` — hue in
  (160°, 345°), outside every fixture colour — measured on the round-2
  control at **27.5% by count / 15.2% by chroma**. The lamp line stays OPEN
  (half-delivered) until Jason sees the frames and the finding together.

  **The corrected account, reached through three wrong headlines between two
  careful readers — recorded because the failure was the BUCKETS, not the
  pixels.** First reading: "34.1% violet" (PM) — but the violet bucket
  [260°, 360°) swept the red end of the wheel, and 45 of its 77 pixels were
  PAPI/threshold REDS at 345–360° rendering CORRECTLY (pure red survives
  the tint R-dominant). Second reading: "82% warm" (architect) — the
  wrap-window [345°, 70°) counted the same correct reds as if they answered
  Jason's amber question. Third: "violet concentrates in the dim half" —
  backwards, because bright red fixtures inflated the bright band's
  "violet". The dump of the SAME 134 pixels settles it: ~34% correct red,
  ~26% correct amber, **13% flipped WHITES at cyan/blue (the tint flip is
  B-dominant, hue ≈230°) + ~16% magenta-violet — the true off-fixture
  population, concentrated around white fixtures.** And a finding inside
  the finding: flipped whites HUE-CAMOUFLAGE against the cyan moonlit
  background (background reads 63.7% cyan/blue), so enrichment-vs-background
  analysis structurally cannot see the largest defect population — it reads
  as depletion. Buckets now live AT the metric definition, fixture-aligned,
  with count and chroma-weight both reported; an undocumented bucket
  boundary is a headline generator.

  **The settled numbers (metric v3, round-2 control), after both readers'
  buckets failed once more:** the PM's red bucket never wrapped 0° ("red
  0.3%" was wrong about the largest population in the frame), and the
  architect produced three inconsistent figures for one quantity (a gated
  denominator, a bin miscount, and the fine bins' true 39.6%) — the
  saturation gate's bias is the camouflage trap ONE LEVEL DOWN: a sat≥0.05
  floor on the denominator silently drops the DILUTED flipped whites, the
  exact population the metric exists to see (it moved off-fixture from
  39.6% to 27.5%). Metric v3 therefore: NO saturation gate on counts; the
  345° boundary DERIVED, not chosen (pure red rotates only −1.4° through
  the tint, so <345° cannot be a barely-tinted red) — and [330°, 345°) is
  attribution-AMBIGUOUS (reachable by red glow legitimately compositing
  over the blue background) so it is reported separately, never assigned.
  Readings: **strict off-fixture 31.3% by count / 14.2% by chroma;
  ambiguous 8.2%** — the packet quotes the honest range 31–40% with the
  boundary named, per the PM. The good news for Jason's sentence: the
  COLOURED fixtures he asked for are working; the defect is narrower and
  specific to white.

  **Two named traps out of this exchange, beside the false-pass form:**
  (1) *an enrichment test is blind to any defect whose signature matches
  the background it normalizes against* — the flipped whites read as
  depletion, not enrichment (PM's naming, architect's catch); (2) *a
  saturation/quality floor on a metric's denominator silently biases
  against low-quality instances of the very defect under study* — the same
  blindness, built into the instrument's own gate.

  **Mechanism, confirmed at the source (ScotopicVision.ts:297-301):** the
  rod tint multiplies the HUE-RETAINED branch — `tint · rodLuminance · hue`
  — so retained warm chroma is blue-flipped: warm `[1.0, 0.78, 0.52]` ×
  tint `[0.72, 0.94, 1.55]` = `[0.72, 0.73, 0.81]`, B now the max. The
  violet ring is the ACUITY-BLUR HALO: pixels 2–4 px from a core whose
  SHARP sample is ground-level (the 1.7 px PSF's tail is ~1e-7 there and
  bloom feeds in after this pass), so `pixelCone ≈ 0` by construction and
  the halo takes the full tint on its blur-borrowed warm hue. The field
  never showed this because its own hues are cool — tint × cool stays cool
  and reads as the intended cast; only warm content flips, and warm content
  arrived in the same round that deepened its chroma. Fix menu, held for
  Jason's eye per the round protocol: (a) soften the tint's blue dominance
  (moves the approved field), (b) un-tint the hue-retained branch —
  `mix(tint·lum, hue·lum, chromaKeep)` — hues go TRUE everywhere, the blue
  cast survives only in the achromatic fraction (also moves the approved
  field, toward truer greens), (c) fade the tint by the pixel's retained
  chroma so only near-neutral content is cast. None lands before his
  reaction; a violet-ringed lamp is a look some night films choose on
  purpose.
- `chromaSaturation` (luminance-weighted) — REPORTED, NOT GATED: it
  distinguishes tinted-grey from true-grey in diagnosis but cannot gate
  (see below).
- Daylight null: all metrics asserted UNCHANGED on `reference-viewport`
  and `winter-noon` — the day frames are the control arm and must stay
  bit-stable through every night change (the scotopic pass-through leg).

**The demonstration record (2026-09-01, run against the rejected frames
before any gate value was trusted — house rule):** two metric designs died
on the red arm before one survived. (1) Mean relative saturation over
non-black pixels read **0.2953** on the rejected `night-moonlit` — a PASS of
its intended floor — because near-black quantization noise ([8,3,1] → sat
0.875) dominates an unweighted mean. (2) Luminance-weighted saturation read
**0.2954** — still a pass — because `SCOTOPIC_TINT` is itself ~53% saturated
blue: the rejected frame is a CYANOTYPE, one hue everywhere, and that is
what "black and white" means perceptually. (3) `hueDiversity` reads
**0.0000** on both rejected frames (460,800 colored pixels, every one within
30° of the dominant 220° blue), **0.2046** on the day null (dominant 110°
green), **0.0286** on the dusk-glint frame (a golden-hour frame is genuinely
hue-concentrated — the mesopic rung's floor must respect that). Surviving
red-arm readings on the rejected frames: median luma 0.0894 (moonlit,
fails [0.15, 0.30]) / 0.0583 (moonless — MARGINAL against [0.06, 0.14];
that anchor waits for Jason's reaction), sky blue 0.0017/0.0012 (fail 0.02),
hue diversity 0.0000/0.0000 (fails 0.15). The lamp metric is vacuous on the
baselines (they predate the lamp calibration — 0 pixels, which the guard
must flag); its red reading is the PE's direct measurement of the shipped
lamps: saturation median **0.020** against the 0.15 floor. Day-null pins:
median 0.3824, diversity 0.2046, sky blue 0.1467.

An instrument that passes the frames Jason rejected is measuring the wrong
thing — recalibrate before proceeding. It happened twice in one hour to
this document's own §3; the demonstration is not a formality.

**The control-frame criterion, corrected after it fired wrong (2026-09-01):**
round 2's control adjudication was escalated because the architect issued
two contradictory sentences in one hour — "moves at all beyond ~0.1% =
leak" to the PM, "night-moonlit's pixels move globally by design" to the
Lead. The correct criterion is SIGN-BASED, not tolerance-based, and derives
from what each mechanism CAN do: the twilight dip can only DIM (its factor
is ≤ 1 everywhere, and exactly 1 at the control's clock by window
arithmetic), so the terrain median must not FALL; the moon-sky can only ADD
(in-scatter), so sky-blue must RISE; residual median movement attributes to
the moon-sky within its reach (measured round 2: +1.8%, with sky-blue
0.0012 → 0.0347). A tolerance number without a sign is a criterion that
contradicts the design it guards. If a decomposition to the digit is ever
needed, one same-tree arm at `NIGHT_SKY_MOON_STRENGTH = 0` separates sky
from dip exactly.

---

## 4. Sequencing, pens, and the host

Round-based, one look-change set per capture round, Jason reacting to frames:

1. **Round 1 — the tactical probe + warm fixture whites (as executed).**
   The Lead's probe (chroma retention 0.65, tint leaned blue, blur cut,
   moon 0.18) plus the PE's ambient-adapted warm white
   (`[1.0, 0.78, 0.52]`), captured together and sent to Jason immediately —
   iteration beats polish, and his reaction calibrates the §2.1 anchors.
   Framed to him as a probe, not the design. **Provenance rule enforced by
   the sequencer: the probe LANDS before its capture becomes round 1 of
   record** — a frame captured against uncommitted state has no provenance
   (this morning's worktree-calibration trap, generalised). Attribution in
   the round-1 report names BOTH authors' changes; the retention is the
   Lead's, the fixture colour the PE's, none of round 1 is the architect's.
2. **Round 2 — AS BUILT (2026-09-01, my pen, all suites green):** (a) the
   twilight dip, Option B sun-elevation-keyed per Jason's choice, endpoints
   pinned by the window's shape; (b) per-pixel cone chroma — **σ-RELATIVE**,
   not absolute: the pixel reads photopic between 4× and 64× the frame's
   adapted level (log-space smoothstep on the sharp nits). An absolute
   cd/m² threshold was drafted first and CAUGHT BY COMPOSITION before any
   capture: sharpNits is in scene-key-scaled units ~three orders above
   physical, so an absolute photopic threshold of 3.0 lands inside the
   moonlit ground's own range and would have stripped tint and retention
   from the entire approved field — the misplaced-ladder trap in a new
   costume. Hue follows the sharp-sample rule (blurred hue dilutes a point
   source toward grey — the seam 7-4a fixed for luminance, found open for
   hue independently twice); the rod tint fades to neutral with cone (the
   blue cast cannot sit on a bright source); (c) the §2.1 moon-as-aerial-
   source night sky with all three mitigations (phase reads a dedicated
   true-sun uniform — the 7-1 anti-solar pin updated to guard the same
   property against the NEW failure shape; disc gated by nightness; a
   moonless night never swaps and stays honestly dark). The originally
   planned mid-grey lift is CANCELLED (round 1 landed the moonlit anchor).
   The FOUR-FRAME reaction set: `golden-hour` (+5.0°) and `blue-hour`
   (−3.0°) probe shots appended with ephemeris-BISECTED clocks
   (19.148h/20.047h, day 179 — appended at the list END; a mid-list insert
   renumbers canonical indices and moves every pinned wave phase), plus
   `dusk-mesopic` (the mover, 0.347 → ≈0.19 expected) and `night-moonlit`
   (the UNCHANGED control — dip factor exactly 1.0000 there, and Jason will
   look for that whether or not we say it). Attribution inside rounds is
   carried by instruments, not sequencing.
3. **Rounds 3+ — iterate on Jason's reactions.** Knobs move inside the §2.5
   registry; anything structural comes back to this document first.
4. **R7-1 — spent ONCE at approval.** Jason approves a round → acceptance
   metrics pinned from those frames → solitary rebaseline (it is unspent and
   reserved for exactly this). No night baseline moves before it.

**Host order (PM enforces):** SWE II 1's lamp-cost measurement → Lead's round-1
capture → acceptance-metric red-demonstration (cheap, CPU-side against
on-disk PNGs, needs no host slot) → round-2 capture → … → R7-1.

**Pen protocol (PM's, restated as binding here):** claim-before-edit with an
ack for every night-path file; changes to the rod blend and to lamp chroma
look like each other in a frame — the hazard is attribution, not merge.
Sync to the resolved tip, never a named commit.

---

## 5. What would make this design wrong

- **If Jason's round-1 reaction contradicts the ground-anchor premise** (e.g.
  he wants the sky bright but the ground DARK — a silhouette look), §2.1's
  anchor becomes a two-band contract (sky band + terrain band anchored
  separately). The instrument already measures both bands, so the pivot is a
  re-aim, not a rebuild.
- **If chroma retention at the level lift produces colour noise** (chroma
  amplified in near-black regions reads as speckle), the luminance-weighted
  retention in §2.1 stops being optional and enters round 2.
- **If the chromatic highlight breaks the red-fixture measurement** (red
  lamps measured 230 vs white 232 through the ACHROMATIC term; carrying hue
  changes that arithmetic), re-run the PE's all-red/all-white arms before
  trusting any lamp conclusion again — the log2 law must keep both visible.
- **If the day-null ever moves**, the scotopic pass-through contract broke and
  every conclusion above it is suspect — that leg of the instrument is the
  design's own control arm.
- **Anything here that contradicts a measurement wins by losing:** the
  measurement wins, this document gets a deviation entry, per house rule.
