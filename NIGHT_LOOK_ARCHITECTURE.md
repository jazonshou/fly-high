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
  make everything below garish. On the landed tip the shoulder reads
  0.17–0.23 against the 0.15 floor — the lamp gate is a REGRESSION GUARD,
  not a driver. Sample-size guard as everywhere (0 lamp pixels =
  instrument failure, never a pass).
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
