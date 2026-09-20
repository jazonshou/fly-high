# Tall mountains: what was wrong with them, what changed, and what was tried and dropped

Wave M, 2026-09-19. Branch `jazonshou/terrain-mountains`.

The report, with a viewer frame and a reference photograph: the peaks of tall
mountains are *"a smooth surface with patterns on it ... wallpaper glued to
smooth mountains"*, they are *"a bit too sharp/jagged"*, and the ground *"still
looks blurry"* up close. The reference is a broad alpine massif: light grey
fractured rock ONLY on the steep faces, gullies and buttresses running down the
fall line, grass on every gentler slope right up to the rock, scree aprons.

Three separate defects, at three scales, with three different owners:

| scale | defect | owner | fix |
| --- | --- | --- | --- |
| 100 m – 3 km | massifs are clusters of needles | the height kernel | `M-1`, `MOUNTAIN_SHAPE` |
| 1 – 60 m | faces carry no relief, only patterns | the fragment shader | `M-2`, `RockRelief.ts` |
| what grows where | a mountain is grey from base to summit | the land-cover classifier | `M-3`, the alpine partition |

## 1. Shape (`M-1`)

### What the mountains actually were

Measured on the shipped analytic kernel — which is the DEFAULT world
(`DEFAULT_WORLD_EVOLUTION = "analytic"`; the eroded path is parked because it is
CPU-bound) — over mountain ground (`mountainRegion` > 0.3, above 300 m), slope
from a 30 m central difference, seeds `terra1` / `alps22` / `kilo77`:

* median slope **45.5 / 53.0 / 53.9 degrees**; P90 64–71 degrees;
* ground steeper than 60 degrees: **18% / 33% / 36%**;
* at the CORE of a massif (±1.8 km of a summit): 55 degrees median, 37–39% cliff;
* one summit profile: 430 m of rise in 100 m horizontal, 77 degrees. The viewer
  frame of it is a striped obelisk.

Alpine terrain is about 30 degrees at the median with a mode at the angle of
repose (33–37 degrees) and a few per cent of rock face (DiBiase et al. 2012, San
Gabriel Mountains LiDAR). So it was not "a bit" too sharp: a third of every
massif was at cliff angle.

Per-term RMS slope on that ground: the mountain term 0.92–1.23 m/m by itself,
`rockyKnolls` 0.49–0.63 (heavy-tailed, P90 1.1), `sampleGeologicalRelief`
0.38–0.64, the foothill term 0.26, `cragDetail` 0.25 — and the last four are
all SCALED UP by `mountainRegion`.

**The cause is relief per wavelength, not sharp crests.** The mountain term was
1,390 m of ridged relief on a 2,550 m base wavelength, and `ridgedFbm2D`'s octave
gain times its lacunarity is 0.52 × 2.03 = 1.06: every octave contributes the
SAME slope at its own crest however small it is. Where five crests coincide the
slopes add, and `pow(ridges, 1.58)` then concentrates the rise at the crest.

### What did not work, measured on the same sample mask

* **Rounding the ridge cusp** (`1 - sqrt(v² + c²)`, c 0.12–0.25, even with the
  gain cut to 0.36): median 45.5 → 41–43 degrees, cliff 18% → 12–15%. Invisible
  in a silhouette. This was the first guess and it was wrong.
* **Parameters alone** (exponent 1.58 → 1.0; crag amplitude 360 → 200): 45.5 → 44
  degrees, 18% → 16%.
* Both together: cliff 33% → 20–23%. Still needles.
* A body written as `amplitude × mountainRegion²`. It fixes the needles, and
  then the BODY draws a range-front escarpment round every massif, because it
  ramps ~1,100 m in across the 0.29-wide band `mountainRegion` itself ramps
  over. Core cliff 12.1% on `terra1`; cutting ridge relief 760 → 680 m under it
  moved that to 12.0%, which is how the body was identified as the source.
* A body that is not ramped in from the coast: an 800 m sea cliff wherever a
  massif abuts the sea (`land` cuts the height over ~1 km).

An independent toy (an agent's, importing nothing from the repo, same octave
structure, every model rescaled to equal relief) ranks the operators the same
way: cusp rounding 48 → 44 degrees, octave gain 0.52 → 0.40 48 → 38 degrees and
cliff 21.5% → 7.8%, and moving relief into a long-wave body dominates both. It
also found that `pow(·, 1.58)` moves cliffs the WRONG way (21.5% → 23.1%) and
that derivative-damped fbm makes the distribution bimodal without capping
cliffs, and makes the lattice artefact below worse on a value-noise basis.

### What landed

`MOUNTAIN_SHAPE` in `src/world/terrain.ts`, one frozen object, injected into the
WGSL twin in `TerrainKernel.ts`:

1. **A massif body.** Height is carried by a lift read off the broad mountain
   field over a band about twice as wide as `mountainRegion`'s, ramped in with
   distance from the coast. The ridge term then only has to draw the ridges.
2. **A soft ridge channel**, built from the SAME five octave samples as the
   shipped one — no extra noise evaluation, and the ridge lines lie exactly
   where they did — with a rounded cusp and a gain of 0.40, so slope falls with
   scale the way it does on weathered ground.
3. **Knoll, crag and fracture relief damped** by `1 - 0.78 × mountainRegion`,
   where they used to be scaled up by it.

**What it measures now** (same masks, three seeds): region median slope 31.4 /
34.9 / 36.2 degrees with 1.8 / 2.9 / 2.8% steeper than 60; massif core 39.7 /
35.7 / 36.5 degrees with 7.2 / 4.0 / 5.1% cliff (shipped: 55 degrees, 37–39%);
tallest peak within 60 km of spawn 1,728 / 1,778 / 1,960 m (shipped 1,690 /
1,670 / 1,664); mountain-ground P95 height 980 / 993 / 938 m (shipped 786 / 809
/ 751): fewer, bigger mountains. Distinct summits at or above 1,200 m fall from
26 / 59 / 29 to 25 / 36 / 17, and that comparison flatters the shipped world,
whose count is inflated by needle tops each standing 900 m from the next. A
taller arm (body 1,000 m over the narrow band, ridge 760 m: peaks to 2,120 m,
twice the summits) was built and shown; the owner chose "slightly lower and
more realistic". Musgrave crest weighting on the soft channel was measured too
and moved core slope by under 0.7 degrees at equal height, so it was not
adopted.

**Containment.** The reshaped height is blended in by
`smoothstep(0.2, 0.65, mountainRegion) × smoothstep(20 m, 140 m, shippedHeight)`,
both read off the SHIPPED field; where that product is zero the function
returns the shipped arithmetic untouched. Measured with the real kernels, base
tree against this one, exact double equality:

* airfield siting: 0 of 50 seeds differ, 0 of a further 3,000, and all 142
  catalogue regions assess bit-identically in every field;
* coastline: 0 sign flips in 202,005 samples; not one sample at or below 20 m
  moved;
* land moved by more than 0.5 m / 5 m / 50 m: 23–30% / 18–24% / 8–13%, at
  most 700–1,017 m (intra-massif valleys lifted by the body);
* the parked eroded path: function text identical, 102,010 samples
  bit-identical;
* there are exactly two copies of the natural-height formula (CPU and WGSL),
  both reshaped, and no third; physics collides with the texels the renderer
  draws, and CPU/WGSL parity is ≤ 3.6 mm at every radius and filter width.

"Airfields do not move" is not "nothing near an airfield moves": 6 of the 142
catalogue airfields have moved ground inside 3 km (nearest 1,910 m from a
runway centre, at most 13.6 m), none inside 1 km. The first draft of the
constant's docblock claimed 0.00 m within 3 km from five seeds; the sweep
corrected it.

**What it costs the capture suite.** Of the 38 perf shots, 3 RE-RESOLVE
(`mountain-close` and `terrain-material-1600ft-down` move 13.79 km, `cliff-60m`
6.07 km, because `locate` searches on slope, and the steep-face predicates now
accept 15–17 candidates in the search disc where they accepted 105–112), 31 are
reframed, 3 are unchanged, and `high-10000ft-down`, an MSL shot, has 417 m more
ground under it (2,037 m of clearance). A near-total rebaseline.

It also broke eight pins in three placement suites with the SHIPPED classifier
still in place, because rocks and species read slope: two hand-off digests (377
of 4,096 probes on moved terrain; dominant material changed at 35, all Rock →
ForestFloor or Grass), the scree suite (its mountain fixture's mean slope went
0.489 → 0.281; rocks 106 → 91; the failure-face band 72 → 13), and the mountain
patch diagnostic, whose vantage re-resolved. That last one is worth reading:
the 13–100 m rock/grass patch confetti it diagnoses is STILL THERE on the
reshaped massifs (chords 24–28 m, mineral boundaries ~8 m wide and 100%
slope-driven), and its counterfactual — classify from a slope averaged over a
33 m box — now removes 49% of the chords for 2.7 points of Rock.

### The lattice "maze", which this wave does NOT fix

A CPU hillshade of any hill in this world shows rectilinear structure at
100–1,000 m. The cause is exact: on every lattice line the quintic fade's
derivative is zero, so value noise's gradient there is purely along the line's
normal, and EVERY contour of value noise crosses EVERY lattice line at a right
angle. Ridged noise draws its crests along contours, so crests are forced
rectilinear at every cell border: one ridged value octave has 45.8% of its
gradient energy within 7.5 degrees of an axis, against 16.7% for an isotropic
field. Per-octave rotation repairs the statistic and not the base octave; a
smooth warp barely moves it (20.4% → 19.8%). The fix is a gradient-noise basis
for NEW mountain channels behind the same gates; it is a named follow-up.

## 2. Rock at range (`M-2`)

### Why a face read as wallpaper

Measured from the app at 0.4–2.4 km. The Rock tile (5.9 m) is high-passed and
mean-fitted by design, so past a 1.5 m footprint a face is one grey. The mesh
at that range is 8–32 m per vertex and band-limited to its own texel, so it
carries no relief under ~60 m. What was drawn in between was two octaves of
SMOOTH value noise (71 m, 23 m) and a strata term keyed on ALTITUDE. Smooth
noise on a smooth mesh is airbrush; and a field that is constant along a
contour IS a contour line, however it is broken up. Wave Q had already given
that term two incommensurate octaves and an along-strike mask, and it still
ringed every peak. A pattern that is statistically independent of the form it
is drawn on reads as glued on, which is the whole of the word "wallpaper".

It was also charcoal. Rock's reference albedo was 0.166 luminance — a basalt —
so a sunlit face sat BELOW the meadow under it (Grass 0.160, DryGrass 0.212).
And it was glossy at range: the tile's normals converge to flat with the
footprint fade while its roughness stayed in the tile's own 0.45–0.72 band.

### What landed (`RockRelief.ts`, composed by `TerrainSurfacePlugin`)

After the shape was fixed the owner named the two things he still wanted gone:
*"weird black horizontal lines on some side faces"* and *"the grey/smooth
texture that makes it look fake"*. Those are the acceptance test.

1. **No strata, of any kind.** The altitude-keyed octave is deleted, and a test
   asserts that world Y only ever enters the relief paired with a horizontal
   coordinate. Deleting it also takes eight hashes off every fragment inside
   the meso band: it was evaluated on all ground and gated by steepness after.
2. **A crag field.** Five incommensurate octaves (251 / 109 / 43 / 17.3 / 6.7 m)
   of gradient noise, alternately BILLOWED (`|n|`: sharp concave creases) and
   RIDGED (`-|n|`: sharp convex edges), stretched 2.2× along world Y, and
   evaluated on the two vertical world planes with the material's own
   triplanar weights. The planes are fixed in the world, so the field is exact
   in absolute coordinates and cannot slide with the view or with CDLOD; and on
   any face steep enough to be rock the fall line lies close to the vertical of
   its dominant plane, so the grain runs downslope with no per-fragment frame.
   The first three octaves are the COARSE set: they organise a face into a few
   big gullies and buttresses with detail inside them.
3. **One field for light, colour and cover.** The normal, the ambient
   occlusion and the tone derive from the same field, and the noise changes
   sign across every crease, so adjacent blocks differ in tone the way adjacent
   faces of rock do. A slow field scales fracture density from clean slab to
   rubble. The rock/turf BOUNDARY reads the same field (below).
   **Couloirs** read the coarse creases too, from 380 m below the snowline.
4. **Snow relief.** A snowfield was ONE albedo on a smooth mesh, a white blob.
   Wind drift: two anisotropic gradient-noise octaves in a fixed wind frame.
5. **Roughness at range** (Toksvig's argument): what the vanished normals
   carried comes back as roughness, 0.86, by the same footprint fade.
6. Rock's reference albedo 0.166 → 0.236: the dark end of the light rocks.

7. **The rock/turf boundary.** The classifier draws rock against turf along a
   suitability iso-line, and on smooth terrain that is a smooth curve: from the
   air every rock patch was a decal with a clean outline. A debug tint (red =
   page-pair rock, green = fallback rock, blue = page trust) settled WHICH path
   draws those outlines, after three fixes aimed at the wrong one: it is the
   baked page pair, not the fragment fallback. A page's pair share is a softmax
   of suitabilities, so the share is a ramp one texel wide with flat ends, but
   its LOGIT is linear in the suitability difference: a ramp tens of metres
   wide. The boundary signal is added there, so 0 and 1 stay fixed points (pure
   ground stays pure; a tongue only grows from rock that is present) while a
   10 % share can be carried past a half. The signal is the crag field's signed
   block field re-weighted toward the octaves a tongue is the size of (0.3 /
   0.5 / 0.65 over 251 / 109 / 43 m) plus isotropic octaves at 23, 8.9, 3.4 and
   1.3 m: lobed by the first, ragged with islets by the rest. The last two are
   only resolved from under ~150 m, where an outline drawn by the 8.9 m octave
   alone is a smooth camouflage blob. The push opens slowly over a share of
   0.004-0.08, because the page's 8-bit share reaches zero along a smooth
   envelope and a push that is whole by 0.02 runs every tongue out to it. The same signal pushes
   the fallback's slope driver, so the two representations agree at the range
   where one hands over to the other.

Everything is zero-mean or mean-one, world-anchored, footprint-faded per
octave, gated to steep rock or snow, and behind the W-1 tier lane.

### Tried and dropped, each with a frame

* **Fall-line ribs from a pivoted phasor blend** (the construction in
  Johansen's 2026 erosion filter), aligned to the mesh normal's contour
  direction. A field aligned with a per-fragment direction cannot be evaluated
  in absolute coordinates — a one-degree turn at 40 km moves the phase by
  hundreds of periods — so the phase was taken about a jittered pivot per cell
  and four cells blended as unit phasors. It works exactly as designed and
  reads as DRAPED FABRIC: one wavelength, one profile, every rib parallel.
  Regularity is the tell, not direction.
* **Bedding on a tilted plane** with ledge shading, to replace the altitude
  strata honestly. Tilted, warped, exposed in patches, notched by the gullies —
  and it still drew dark lines across faces, which is the defect the owner
  named. A bed is a line; the owner does not want lines.
* **Billow octaves only.** Every sharp line concave, every face a pillow: at
  250 m it looked like melted wax. Rock breaks along convex edges too.
* **One cusp rounding for every octave.** What keeps a 109 m crease from
  sparkling at 5 km makes a 6.7 m one look soft at 250 m.
* **Relief weighted by cover × a slope window.** At a patch's edge cover is
  partial and slope sits under the window, so rock was drawn flat and unshaded,
  lighter than its creased interior: a pale rim round every patch, which looked
  like a gravel halo and was not one.

* **The boundary as an additive push on the pair share**, limited to 0.45 so
  pure ground stayed pure, reading the crease-minus-edge LINE signal. The share
  only leaves 0 or 1 inside one texel, so the outline moved about 10 m, against
  a signal whose shortest wavelength was 43 m and which is zero off the lines:
  every patch kept its decal outline. Also shot: the same push on the fallback
  slope driver alone (the wrong path), and a slope perturbation in the bake
  (moves patches, and cannot carry anything finer than a page texel).

## 3. What grows where (`M-3`)

A massif rendered grey from base to summit for two reasons, and the second was
hidden behind the first. The shape was mostly cliff, so `steep × 1.25` won it
legitimately. And above ~900 m no vegetated material had ANY suitability on
gentle ground: Grass and DryGrass carry `lowland` (dead by 900 m), Shrub dies
over 1,150–1,650 m, and Rock was `steep × 1.25 + alpine × 0.55` — 0.55 on
perfectly level alpine ground.

The partition, every term of it multiplied by `alpine` so the law at or below
420 m is bit-identical to the shipped one (proved over 6.7 M suitabilities
against a frozen copy, and against literals captured from the base tree):

* **alpine turf** on ground under ~35–47 degrees, below the snow band, down to
  a cold limit lowland sward does not tolerate;
* **rock needs slope at altitude**: `alpine × (0.25 + 0.30 × slopeRamp)`;
  `steep × 1.25` and steep's window are untouched (the coefficient is
  calibrated against that window — moving it once took Rock from 19% to 35% of
  land);
* **scree** in the repose-angle band, stronger where dry.

Snow sheds over 39–55 degrees where it shed over 60–72, in the classifier and
in the fragment's fallback: at the old threshold a snowfield on a reshaped
massif showed no rock at all. That is the one term here that is NOT gated on
`alpine` — a winter snowline reaches the lowlands. The fragment's far-field
fallback, which stands in for the classifier on coarse pages, got the same
slope requirement on its altitude rock, or a massif is green up close and grey
from 10 km.

Measured on the reshaped terrain, three seeds, 78,915 samples above 500 m,
dominant material, first cut of the partition: Rock 40.2% → 19.6%, Grass 19.8%
→ 39.2%, Gravel 0% → 9.1%; under 25 degrees Rock 23.9% → 4.3%; over 55 degrees
Rock stays at 99%. The first cut had four shortfalls, all produced by its own
spec and all found by measuring rather than looking: turf reached 45–50 degree
ground (it used the classifier's `gentle`, which is still 0.5 at 54 degrees);
scree peaked in the 35–45 degree band; a bare rock belt sat under the snow; dry
massifs stayed heath. Each is fixed in both twins.

**The parity test could not see any of this.** `land-cover-bake-parity`'s three
pages top out at 337 m — 0 of 3,254 probes above 420 m. An alpine page was
added.

## 4. The blocked hemisphere is not black (`M-4`)

The occlusion bake measures how much SKY a texel sees, and the fragment
multiplied ALL ambient by it. But the share of the hemisphere the sky does not
fill is filled by the terrain that blocks it, which is itself lit. A wall in a
gully lost its skylight and the bounce from the slope opposite, and rendered
near-black at noon (kilo77's west face from 900 m: about 12/255), so the relief
`M-2` draws inside it could not be seen. The blocked share now returns a quarter
of what open sky there would: ground albedo near 0.18, seen half in sun and half
in shade. Ambient only; the horizon shadow still owns the sun. W-1's vigour and
direct-light terms keep reading the raw openness, because they are statements
about how much sky a sward sees.

Measured in a quiet window at one identical nine-shot filtered list, three
runs (A, A again, A + the floor), mean absolute difference per channel out of
255:

* same-arm control: at most 0.007 on every shot, worst 32 px tile 0.65 except
  `mountain-close` at 2.48. Arm B can be read against it.
* must not move: `night` 0.014, `night-moonlit` 0.018, `hills-dusk-glint`
  0.016, `dusk-mesopic` 0.070; no pixel over 8.
* must not glow: `canopy-1200ft` 0.060, `grove-forest-2m` 0.119,
  `forest-500ft-sunbehind` 0.070.
* where it acts: `mountain-close` 1.91 (mean luma 63.7 to 65.8), `cliff-60m`
  3.21 (92.5 to 95.9), 0.08 % of pixels over 8.

By eye, kilo77's west face at 12.5 h and 15.5 h: the shaded wall stays clearly
darker and cooler than the lit one, with its creases visible inside it.

## Follow-ups this wave leaves

* **The third-material hem.** The fragment's gather reports two ids, so the
  boundary push only exists where rock is one of them. Where rock falls to third
  behind two swards the pair holds no rock and the outline cannot pass: from
  ~200 m, looking down, the foot of a patch still ends on that smooth line. The
  gather already accumulates every id; returning rock's own share alongside the
  pair would let a tongue cross it. It changes the oracle the GPU regression
  shares with the renderer, so it is its own change.
* **Scree cannot tell the head of a face from its foot** without a curvature
  lane; it is keyed on slope alone, and an apron belongs below.
* **Patch confetti on massifs.** Classifying on a ~33 m slope box instead of the
  texel's own slope removes 49 % of boundary chords in a counterfactual.
* **The value-noise lattice "maze"** (section 1) wants a gradient-noise basis for
  the ridge channel; **a geometry erosion filter** would give drainage the
  analytic kernel cannot.
* **A dome-like crest** on terra1's inland massif from its own shoulder and from
  12 km: the lever is ridge amplitude on the body's crest.
* **Snow domes read soft** beside the rock around them (kilo77-approach): the
  drift relief has a strength dial and that frame is where to turn it.

## Sources

Shape: Musgrave, *Procedural Fractal Terrains*; Quilez, *fBm*, *More noise*,
*Gradient noise derivatives*, *Domain warping* (iquilezles.org/articles);
de Carpentier, *Scape: procedural extensions* (Swiss and Jordan turbulence);
KdotJPG, *The Perlin problem: moving past square noise*; Johansen, *Fast and
gorgeous erosion filter* and *Phacelle* (blog.runevision.com, 2026);
DiBiase et al. 2012, *Hillslope response to tectonic forcing in threshold
landscapes*; Tzathas et al. 2024, *Physically-based analytical erosion for fast
terrain generation*; Red Blob Games, *Making maps with noise functions*.
Shading: Andersson 2007, *Terrain rendering in Frostbite using procedural shader
splatting*; McAuley and Moore, *Terrain rendering in Far Cry 5* (GDC 2018);
*Ghost Recon Wildlands: terrain tools and technology* (GDC 2017); Toksvig 2005,
*Mipmapping normal maps*; Mikkelsen 2022, *Practical real-time hex-tiling*.
