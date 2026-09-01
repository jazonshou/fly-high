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
  terrain should read.* Target for `night-moonlit`: terrain-band median
  luminance in **[0.15, 0.30] display** (≈38–76 bytes; RDR2-readable), from
  today's near-black. Moonless `night`: **[0.06, 0.14]** — darker, still
  legible as shapes. The knob is the scotopic output mapping
  (`SCOTOPIC_MID_GREY_TARGET`, first move 0.16 → ~0.30) and, if range demands
  it, a night pre-exposure ahead of the response — but the anchor is the
  CONTRACT; the constants serve it. The anchor is calibrated against the
  captured artifact (terrain-band median), never against a formula, because
  the scene-key theory and the frame have already disagreed once today.
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
- `lampMeanSaturation` — mean relative saturation among lit-gate pixels;
  floor asserts "not all white" structurally, with the lit-gate's pixel count
  as the sample-size guard (0 lamp pixels = instrument failure, never a pass).
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
2. **Round 2 — the level + per-pixel cone chroma (mine).** Ground anchor
   lift (mid-grey → ~0.30 starting value) and §2.2's cone-chroma, under my
   pen, taken from the Lead after round 1 lands. Warm white then reaches its
   FULL saturation through cone-chroma (round 1 shows it diluted to the
   0.65 retention floor). Attribution inside rounds is carried by
   instruments, not sequencing: the PE's lamp-pixel saturation/hue histogram
   decomposes lamp changes, the terrain-band metrics decompose the level,
   and the day-null guards both.
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
