# Open ground from the air: what was flat, what fixed it, and what was tried and dropped

Wave W-1, 2026-09-17. Branch `jazonshou/terrain-ground-texture`.

The report: *"when I look down from a high point on areas without trees, the
texture is very flat"*, with a reference photograph of rolling savanna —
patchy yellow-green at every scale, scattered bush clumps that read as three
dimensional, an eroded gully, ragged ecotone edges.

## What the ground actually was

Measured from the app, not from the code, at 213 m AGL over open rangeland
(seed `terra1`, -5,000 / -18,400) and from the perf shots:

* The material tiles are 2.3 m (Grass) and 2.9 m (DryGrass). At 213 m AGL and
  17° down the footprint at frame centre is ~0.85 m minor / 2.9 m major, so
  the tile samples near mip 7: its own mean.
* `LOW_FREQUENCY_KEEP = 0.32` high-passes each layer, and `fitAlbedoToReference`
  pins the mean. Both are correct — they are what stops a tile drawing its
  period across a hillside — and together they mean the tile contributes
  nothing but its reference colour at that range.
* Between the tile and the 176 m macro wash there was only fix-pack `T1`'s
  meso band: 71 m at ±13% of tone, 23 m at ±8%, both smooth value noise, with
  the normal perturbation derated to 0.4x on flat ground.
* So open ground was one colour times a smooth wash. That is the whole defect.

## What landed

`GroundPatchwork.ts` (new), composed by `TerrainSurfacePlugin`:

1. **Dryness remap.** Perturbs the fragment's own dryness — the driver, not the
   output — and converts it to a ratio between the Grass and DryGrass reference
   albedos in LOG space, so it can run past both ends without a clamp
   rectifying the driver and moving the material's integrated albedo.
2. **Vigour.** A second axis, rich dark green to pale yellow-green, for ground
   the classifier calls pure Grass, where the dryness axis has nothing to say.
   A stack of soft-THRESHOLDED masks (one per octave) plus a ridged crease
   term, not another noise sum: the existing macro wash is already ±17% of
   smooth noise, and its smoothness is why it reads as airbrush. Its amplitude
   scales up as the dryness mosaic runs out — 2.3x on pure lush, 1x where both
   covers exist — and the mean-one correction scales with the gain SQUARED,
   because scaling a field by g scales its variance by g².
3. **Bare ground**, 6-17 m, floored on lush ground and rising with dryness and
   slope.
4. **Scrub.** A procedural bush canopy as a HEIGHT FIELD: crown mask, dome
   normal, ambient occlusion and a two-tap sun-direction cast shadow all read
   off one evaluation, so they cannot disagree about where a bush is.
5. **Relief.** The `T1` meso normal's flat-ground derate lifts on vegetated
   ground.

## Traps found, in the order they cost time

**A resident page is not a baked page.** The channel slot's residency completes
only after the occlusion bake returns, but the mesh carries the slot lane from
the moment it is assigned, so for a frame or two every lane of the occlusion
texel reads zero. As sky visibility that means "no sky", and any consumer that
reads it as a moisture or cavity cue paints a patch across the frame while it
streams. The bake's ALPHA is the validity signal and was designed as one (it
carries the bent normal's vertical sign so "enclosed" differs from "unwritten").
The AO path had the same exposure and now shares the guard.

**The no-page fallback is green.** Below the page-splat confidence floor the
shader uses "one continuous Grass base", and Grass's reference albedo is a lush
green, so for up to ~14 s after a cold jump a DRY biome renders as meadow. This
is pre-existing — the base build does it identically, proved with a teleport
A/B at 120 ms — but any new term that trusts the fallback's dryness amplifies
it. The lush half of the remap is therefore gated on `terrainClassStrength`,
and unclassified ground is carried a third of the way toward dry so the
assumption is climate-neutral rather than lush.

**A jittered stamp lattice cannot pay for itself here.** Confining crown,
shadow, occlusion ring and parallax inside one cell drives the jitter span
toward zero as the features grow, and a lattice with no jitter is the visible
grid this shader has removed three times. The alternative — a neighbourhood
walk — is the far-sea whitecap draft's 15 ms/frame. A thresholded gradient-noise
field has no cells to line up and returns an analytic gradient for free.

**A flat threshold gives worms, not bushes.** Perlin noise thresholded low
produces long filaments wherever it runs just above the threshold. Squaring the
clearance drops those and keeps the true maxima, and the squared profile also
gives the dome its curvature: `d(h²) = 2h·dh`.

**A domain warp makes marbling, not organic outlines.** The first vigour build
ran its coarse field through the de-tile warp, on the theory that a curl-free
multi-scale displacement buys organic patch outlines for free. What it buys is
camouflage: the warp is a smooth ~40 m displacement, and pushing a smooth field
through it turns compact patches into long swirled bands. The capture is kept
as evidence. Octaves are decorrelated by rotation and salt instead.

**Stressed grass goes yellow, not bright.** The same build's colour axis raised
blue with red toward the pale end, so "pale" meant brighter rather than
yellower, and the ground interleaved green against tan — two materials, which
is what camouflage IS. Red up hard, green a little, blue down.

**Uniform edge hardness is a camouflage tell on its own.** Threshold softness
is therefore a field, and each mask reads the OTHER octave's: a mask whose
softness reads its own field gets the same width at every boundary it draws,
because a boundary is where that field is zero.

**A crease on a field's zero set outlines that field's own patches.** The ridged
term sits on an iso-line offset from zero for exactly that reason.

**`sample` and `patch` are WGSL reserved words**, and a backtick in a comment
inside a WGSL template literal ends the template. Both cost a compile cycle.

**`RUNWAY_SDF_WGSL` is composed into a compute shader too**, so a helper added
there may not read `uniforms`. Take the frame as a parameter.

## Tried and dropped: real shrubs on dry rangeland

The vegetation system already scatters shrubs in grassland and adding more
costs ZERO extra draw calls — the batch key is `prototype@chunk`, so instance
count is free, and the six shrub keys exist in every chunk that has any shrub.
Tier 1 budgets them at 60/ha inside 150 m, falling to a 2.7/ha floor by ~707 m,
hard-cut at the mid band (1,100 m) with no impostor. Every shrub range test is
horizontal, so altitude does not cull them.

**Dry rangeland gets none of that**, because the shrub law runs through
`smoothstep(0.2, 0.5, moisture)` (`densityField.ts:748-760`) and semi-arid
ground sits below 0.2. That is backwards — shrub-steppe is what grows where
grass thins — and it is exactly the ground the report is about.

A dry lobe was built and reverted: `DRY_SHRUB_FLOOR = 0.55` over moisture
`[0.02, 0.2]`, disjoint from the ramp by construction (it reaches zero at 0.2,
where the ramp leaves zero) so no moister biome moves a stem, in
`densityField.ts` and its WGSL twin together. It worked mechanically and the
vegetation suites stayed green. It was dropped for three reasons:

* the crowns read as bright lettuce-green on tan rangeland, and the moisture
  bleach applied to the instance tint did not change them — the crown colour
  lives in the foliage material/atlas path, which is a vegetation-appearance
  change, not a density constant;
* draws went 64 → 70/79 at the test poses and the app's own fps became
  unstable standing still (200/81/84/90/36/162 over 90 s) in a way that smells
  like generation and presentation churn over the ~46k placements the
  residency disc then holds, which could not be pinned down in the time box;
* no far representation exists past 1,100 m.

Anyone picking this up starts from those three, not from the density constant.

## The cost, and the one-line way to give it back

Measured on the M2 Pro against the base commit, two runs per arm (same-arm
noise floor: base 2.6% max, branch 2.2% max):

| shot | base fps | branch fps | delta |
| --- | --- | --- | --- |
| mountain-close | 115.6 / 118.6 | 106.4 / 108.4 | −8.3% |
| terrain-material-1600ft-down | 114.7 / 113.2 | 104.5 / 105.8 | −7.7% |
| winter-noon | 114.8 / 113.5 | 107.3 / 107.2 | −6.0% |
| approach-500ft | 114.9 / 113.7 | 108.9 / 107.4 | −5.4% |
| ground-2m-lowsun | 112.2 / 111.9 | 111.5 / 109.1 | −1.6% |
| canopy-1200ft | 115.4 / 114.0 | 112.5 / 113.8 | −1.4% |
| high-10000ft-down | 121.1 / 121.4 | 121.2 / 121.7 | +0.2% |
| cruise-horizon | 121.0 / 121.3 | 121.0 / 121.5 | +0.1% |

Draw calls and triangle counts are identical in both arms on every shot: this is
ALU on vegetated fragments and nothing else. Worst p95 is 11.6 ms against the
tier-1 contract's 16.67 ms.

**Tier 0 skips the whole block** through a uniform branch (no define, so no new
shader permutation): at that tier a lush pose is capture-noise-identical to the
base build, 0.26 of 255 mean absolute difference with no pixel past 4/255.

**To give back roughly a third of the cost at tiers 1–3**, set
`GROUND_VIGOUR_FINE_AMPLITUDE` to 0 in `GroundPatchwork.ts`. That is the whole
change: the 18 m octave's evaluation is already behind its own weight guard, so
zeroing the amplitude skips it. What it costs is the near field's finest patch
structure, which is most visible below about 500 m.

## Named follow-ups

* **The near band's soft blobs.** In the bottom third of a 213 m frame the
  patches are soft-edged with no fine structure, because painted scrub is
  correctly gated out below 0.3 m/px and real shrubs do not exist on dry
  ground. Far better than the flat base, but it is where the next wave pays.
* **Dry-rangeland shrubs**, with the numbers in this file's "tried and dropped"
  section as the starting point.
* **Rock and gravel at range**, deferred by agreement: Toksvig-style roughness
  from unresolved normal variance, plus fracture-scale albedo and normal
  breakup in the same missing band. `high-10000ft-down`'s rock is the shot.
* **Move the coarse octaves to the vertex stage.** The 163 m and 53 m fields
  are smooth at near-LOD vertex spacing, so evaluating them per vertex and
  thresholding per pixel on the interpolated value would take most of the hash
  work out of the fragment stage. It needs care at far CDLOD levels, where
  vertex spacing approaches the 53 m wavelength and the interpolation would
  start eating the field — which is exactly why it is a follow-up and not a
  last-minute change.

## Instruments that worked

* **Teleport A/B for streaming defects**: same script, both arms, frames at
  120 ms / 600 ms / 1.5 s / 4 s / 10 s / 20 s after a cold jump. This is what
  separated "my term" from "pre-existing fallback" in one run.
* **Pixel-settle before capture**: a 64×36 in-page thumbnail compared between
  frames, inside a `requestAnimationFrame` (an out-of-band readback of a WebGPU
  canvas is all zeros). A fixed timer shot frames where the terrain had not
  arrived and the sea showed through.
* **Headless FFT of a synthesised tile** for the near-field grid: the `|k| ≤ 4`
  albedo power is the tiling-repeat signature, and it is measurable in seconds
  under vitest against `synthesizeSurfaceMaterial`.
* **The perf harness for cost**, not the viewer: the viewer is vsync-capped at
  120 fps and swings 145-175 fps on the same arm uncapped, which is wider than
  the effect being measured.
* **Land-masked A/B metrics** for "did anything actually change": mean absolute
  RGB difference, the share of pixels past 4/255, and 16-px block luminance std
  over the land region, cropped to the meadow when a frame is mostly canopy.
  A whole-frame number over a forest shot hides a meadow change completely.
