# Ground up close: why descending added nothing, and what was done about it

The owner's third complaint in the 2026-09-19 wave:

> The current ground texture looks good from a distance. However, even when I
> zoom in, the ground still looks blurry and similar to what it looks like from
> a far distance. I'd like the ground texture to increase in fidelity up close
> so it looks less fake and plasticy.

This note records what that was, measured, and what landed against it. It
follows `GROUND_TEXTURE_W1.md` (the 3-150 m band) one band lower.

## 0. The tiling band (`D-0`)

Found on the way, and the first thing the eye finds on open ground: a sward
tile with power on the Fourier lines at |k| <= 4 cycles per tile draws its own
period across a field however the shader warps it. From 30 m above dry
grassland one dark feature of the DryGrass tile stood in a regular lattice of
identical stamps across half the frame.

`flattenLowFrequency` was supposed to own that band and cannot: a box high-pass
has its first null at 3 cycles per tile and gain at 4, so whatever a recipe
leaves there comes through. `suppressTilingBand` is an exact notch on those
lines, evaluated on a 64 x 64 box reduction (16 samples per cycle at k = 4), so
it is a few hundred thousand multiply-adds per channel rather than an FFT, and
it touches nothing at k >= 5, which is where the 5-50 cm content a sward is
made of lives. Applied to Grass and DryGrass after `flattenLowFrequency`,
keeping 0.3 of the band's amplitude.

Measured at seed "fly-high", edge 512, decoded linear luminance, absolute power
in the band: Grass 4.65e-5 to 4.27e-6, DryGrass 2.35e-5 to 2.13e-6, an 11-fold
cut on both, holding at a second seed and at the low tier's edge. No assertion
pinned the swards' band before; the only spectral pin in the suite was Rock's
crossed-fracture ceiling.

Synthesis runs in `materialSynthesis.worker.ts`, off the main thread, so the
notch is not on cold start's time-to-ready path: a sward tile takes about
170 ms to synthesise on this host with it in.

## 1. Why descending added nothing (`D-3`)

The frames shot to verify the notch showed what the complaint actually was. At
8 m, 30 m and 80 m above a meadow the ground was a featureless gradient with
specks on it, identical in character to the view from 213 m.

Read term by term: a sward's material tile is 2 m across and its content is
blades and tufts under ~10 cm, deliberately flattened below 0.5 cycles per
metre so it cannot show its repeat. `W-1`'s patchwork starts at 18 m (vigour's
fine octave) and 6.1 m (the bare openings' fine octave). Between them NOTHING in
the shader had a wavelength: no term from 0.2 m to 6 m. By 8 m up the tile has
minified to its mean, and from there to the patchwork the ground is a gradient.
Descending from 600 m to 10 m added no information to the frame, which is what
"blurry" means. Reworking the tile's content cannot answer it: tile content
only resolves under ~5 m AGL, and in a CPU preview its tussocks repeat as rows.

`SwardRelief.ts` is that band: four incommensurate octaves (4.3 / 1.7 / 0.71 /
0.31 m) of the ground block's own integer-hashed gradient noise, world-anchored
in absolute metres, each faded by footprint and SKIPPED once it has, with the
whole function returning after one compare once the coarsest has gone, so from
cruise altitude it costs nothing. Each octave's tone is the noise pushed through
a soft edge (blotches with outlines, not a gradient), tinted toward straw when
pale and toward green when dark, because that is the axis a sward varies along;
its relief is the plain noise at about 2 % of the wavelength, so light agrees
with colour without the ground becoming a surface of objects. Zero-mean (pinned:
mean under 0.003, sigma 8.4 %), so the scene mean, the bounce and `W-1`'s
calibration do not move. It composes with `W-1` rather than stacking on it: its
weight is `terrainGroundVegetation` (which already carries the airfield
exclusion, and is zero on rock, snow, sand and pavement) less opened soil,
steered by the patchwork's own dryness, 0.8 on lush ground to 1.3 on dry. Inside
the patchwork's tier lane; `SWARD_RELIEF_STRENGTH = 0` is the rollback, and the
octave count is one constant. Opened soil keeps 0.45 of the band: with none, a
bare opening was a smooth plastic blob the moment the sward round it had
texture.

Evidence, same tree with the rollback dial at zero as the "before" arm: at 8, 30
and 80 m AGL on lush and dry ground, noon and an 18.3 h sun, the before column
is a blurred gradient at every altitude and the after column is grassland.
Relief was shot at 2.5 % of the wavelength first and trimmed to 2 %: right at
noon, and at an 8 m eye under a 10 degree sun every hollow was a black streak,
because a normal offset casts no penumbra to soften itself. Shimmer, which is
what a band at these wavelengths risks: forward flight in 1 cm steps (sub-pixel
at both altitudes, so any frame-to-frame change is aliasing and not texture
translating), band on against band off, mean absolute change per channel of
255: 0.27 against 0.24 at 30 m AGL and 1.44 against 1.41 at 8 m (blades in the
wind are the rest), with the share of pixels changing by more than 24 identical
on both arms. At 2 m steps the band doubles the mean change at 30 m (4.8-5.8
against 2.5-2.7) with the same share of large changes, which is texture moving
across the frame as it should.

### Shot and dropped

* **Billowed octaves** (rounded tops, sharp hollows: the profile of a clump).
  Read as rumpled cloth. A gradient noise's zero set is a network of long
  meandering lines, and a crease drawn along it is a ripple, not a gap between
  clumps.
* **Cellular tussock domes**, one per jittered cell, present in a minority of
  cells, with a shaded skirt. Read as raindrop rings on a pond: a perfect circle
  with a dark rim is the one shape a meadow never shows from above.

## 2. Blades lit like the ground they stand on (`D-2`)

Inside 7 m a ground-cover blade's normal was its own ribbon normal, which is
near-horizontal: under a high sun N.L of 0 to 0.37 against about 0.93 for the
ground beneath it. At a 2 m eye the dark half of the blades rendered at 0.43 of
the ground and bluer (sky-lit only): black spikes on every near meadow. The
blend toward the ground's normal is now floored at 0.6, and the root albedo is
0.7 where it was 0.5: the root is already darkened by the shadow map and the
ambient term, and halving its albedo as well counted the same occlusion twice.

The floor alone left half the blades black, and the frame said why:
`twoSidedLighting` negates the WHOLE normal on a back face, and with the floor
in, most of that normal is the ground's. Every blade seen from behind was lit
from underneath: N.L below zero under any sun, ambient only. The fragment now
mirrors the normal back above the horizon, which keeps the blade's own share
reversed (that IS what the back of a ribbon faces) and restores the ground's:
exact on level ground. At a 2 m and an 8 m eye at noon no blade renders black;
at 18.3 h they take the low sun and cast their shadows as before.

## 3. Dry country from cruise height: painted regions, and what is left of them

Reported from 6,000 ft AGL in the orbit camera (world 1GVEIKQ): across green
lowland, large flat-toned pinkish-brown regions with crisp, rounded,
vector-drawn outlines, reading as a map overlay. They are the dry-grass biome:
the page pair (Grass, DryGrass), khaki under blue airlight. Not from this wave:
the lowland law is pinned bit-identical, and the mechanism dates from
2026-08-28.

Wherever a page is not fully trusted, which from that height is nearly all the
ground in frame, the seam feather fades the blend toward the page's PRIMARY
material alone. Wave R did that on purpose: a coarse texel's sub-texel mixture
of rock and grass is wrong while its primary is not, and fading identity to
grass had repainted every distant mountain green. But it applied to every pair,
and for two swards the mixture is a CLIMATE gradient hundreds of metres wide,
smooth at any texel size. Throwing it away turns that gradient into a
categorical switch along the half-share contour of a kilometre-scale moisture
field. A pair of two swards (cover share at least 0.9: Grass, DryGrass, Shrub)
now fades toward its own mixture; every pair with rock, gravel, snow, sand,
pavement or forest floor in it keeps the primary. No samples: layer1 is already
sampled whenever its weight clears 0.004.

Settled by one A/B on the same world and pose with only the fade target
changed: every region becomes a soft, wide ecotone and nothing else in the
frame moves. The distant-mountain case was shot before and after at
kilo77-approach and alps22-far: mean absolute difference 0.01 and 0.17 of 255,
rock stays rock.

Left, and logged rather than widened into this change:

* **Forest-floor regions kept rectilinear edges** after this change; that was a
  different mechanism and is section 4.
* **Low tier** never samples layer1 in its two-material path and keeps the hard
  dry/lush edge; a sample was not spent on the weakest hardware.

## 4. Forest floor from cruise height: a canopy for each coarse tap

After section 3 one kind of region still read as painted: dark-green ground with
stair-stepped, axis-aligned sides and single-texel rectangular holes. A debug
tint (red = forest floor's share of the pair, green = shrub, blue = page trust,
yellow = airfield mask) showed it is ground with ForestFloor in its pair, not
the airfield mask and not a page-level boundary.

The first diagnosis was wrong in a way worth recording: "the bake's 2x2
supersample cannot antialias closure". It does not sample closure 2x2 at all.
`bakeSplat` called `splatCanopy` ONCE per channel texel, at the centre, and
handed that value to all four classify taps of both seasons. The docstring gave
the reason, and it is sound where it was written for: closure is band-limited
at a fixed 60 m, so taps up to 16 m apart would read four copies of one number.
From a 64 m texel up the taps sit 32-128 m apart and the argument fails. Closure
is a THRESHOLDED function of the 260 m and 130 m glade octaves, so on a 128 or
256 m texel it was a binary field sampled once, near its own Nyquist, and
ForestFloor is gated on it.

From `LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS` (the closure channel's own band
limit, so level 4 and up) each of the existing 2x2 taps now reads its own
canopy, sampled once and shared by both seasons. A coarse texel then holds a
stand's coverage in five steps and bilinear filtering does the rest. Levels 0-3
hand all four taps the centre's canopy, bit-for-bit what the bake did before,
so nothing the trees are planted from can move; and the closure LANE stored
beside the weights stays the centre sample at EVERY level, because the far
canopy and the hand-off read it and must agree with the planted trees. Both are
pinned. The bake-parity test's CPU model now follows the bake's tap pattern
(lowland agreement 85.1 %, from 84.9 %); no placement digest reads the bake, so
none was re-pinned.

By frame, same world and pose: rectangular holes with hard corners become
rounded, soft-edged glades and the straight sides become gradients; the holes
themselves remain, because they are real 130-260 m glades. Near-range frames at
a stand's edge and rock at range are unchanged (mean absolute difference 0.01
of 255 on the rock frames).

Costed and rejected: a 4x4 tap grid with a canopy per tap (about six times the
bake per coarse page, ~2.3 ms against a 1.55 ms whole-compute cap); closure-only
4x4 (3.4x, and biased, because the classifier of a MEAN closure over-grows
forest floor at a stand's edge through the gate's nonlinearity); dithering the
gather position in the fragment (a per-fragment cost on exactly the pages that
fill a cruise frame, and it moves every categorical boundary, rock included).
Priced in a quiet window, one tree with the tap gate toggled, off / on / off /
on. Splat bake per level-5 page: 0.44 and 0.61 ms off, 0.96 and 0.79 ms on; the
same-arm spread (0.17) is about half the effect, so the honest statement is
"+0.2 to +0.5 ms per coarse page" and no tighter (the timer is noisy on short
dispatches: the untouched fine-level bake read 0.19-0.33 ms across the same four
runs while terrain and occlusion held to a hundredth). An estimate from lattice
counts had said +0.19: a canopy sample costs several classify taps, not one and
a half. Nothing downstream moved: cold start's time-to-ready 2,008-2,029 ms on
both arms against a 2,300 ms deadline (one first-run outlier on the OFF arm
discarded), and on page-thrash-turn and cdlod-transition the fps, p999, max
frame and hitch count are the same on all four runs, because a bake is one
floor-admitted dispatch per pump either way. Coarse splat plus its paired
occlusion bake is about 1.05 ms against the 1.55 ms whole-compute cap, and
`terrain-compute-cost` now times a level-5 batch and bounds exactly that (it
priced level-3 pages only, which never take the branch, so the change had been
invisible to the one instrument that prices a bake).

That was measured with every tap recomputing its moisture chain. As shipped, a
coarse tap's moisture and climate are evaluated once and shared by its canopy
sample and both of its seasonal classifications: 5 moisture chains per coarse
texel where there were 13 and 4 climate chains where there were 8, the same
function of the same inputs, so the bake's output does not change (the parity
test's histogram is digit-for-digit the same).

Re-priced as shipped with eight interleaved pairs (same level-5 pages, tap gate
toggled, load 2.4-2.7 with a browser on the GPU throughout). Coarse splat bake
per page: off mean 0.224 ms, on mean 0.234 ms; paired on-off median +0.013 ms,
sd 0.011, 7 of 8 pairs positive; same-arm sd 0.009 and the untouched fine-level
bake's sd 0.009. The effect is the size of the control's noise, so the run does
not price it to a figure: the tap path costs a coarse page no more than about
+0.02 ms, roughly 4-6 %, probably not zero. The coarse channel pair is about
0.42 ms against the 1.55 ms cap.

A correction to the paragraph above. "A canopy sample costs several classify
taps" was a wrong inference from absolute figures. As RATIOS inside one window
the lattice-count model was right both times: it predicted 142 / 86 = 1.65x for
a canopy per tap with every chain recomputed and 82 / 86 = 0.95x with the
chains shared, and the windows measured 1.66x and 1.04x.

An observation, not a finding, because it cannot be proved from here: the OFF
arm is identical shader work in both windows and read 0.44-0.61 ms in the quiet
one and 0.21-0.24 ms in the busy one, while the fine-level bake read about 0.2
in both and the long terrain dispatch went the other way (2.0 then 2.9-3.0 ms).
The likeliest reading is GPU clocking: on a genuinely quiet machine the GPU
idles down between sub-millisecond dispatches and times them slow and
erratically (same-arm spread 0.17 ms), and something else holding the GPU up
makes them fast and tight (0.009). The rule that follows does not depend on the
explanation being right: on this host only WITHIN-WINDOW, interleaved ratios are
comparable; absolute sub-millisecond figures are not comparable between windows;
and "quiet" is not automatically the better condition for timing a short
dispatch (it is still the right condition for fps and frame-time work). A cheap
test for a later wave, not run here: keep a fixed dummy compute dispatch
running to hold the clock up and time the same bake with it off and on, in one
interleaved series; if the short dispatch gets faster and tighter with the
dummy on, it is clocking.

## 5. The brown polygon under the aeroplane: a page that said nothing

Reported from 2,900 ft in the orbit camera over dry country (world LIVERY): a
large brown, fully detailed region under and round the aeroplane, bounded by
dead-straight edges meeting at corners, with greener, softer country beyond. A
polygon laid on the ground, following the aircraft.

The first hypothesis was that section 3's feather had put a tone step on the
page-trust boundary. It had not, and the A/B said so: with the feather disabled
the straight edge is unchanged and the old hard blob comes back beside it; with
`W-1`'s assumed dryness disabled it softens slightly and stays. A tint of "is a
page splat in use at all" put the line exactly on a gate, not on a ramp:
`terrainSurfacePageSplat` returns before its gather when confidence is under
0.1, confidence is 1 - 0.2 x level, so a page at level 5 and up (128 m texels,
which from cruise height is everything beyond about 2 km) says NOTHING, and the
fragment falls back to "one continuous Grass base": green, in every biome. At
level 4, where trust is only 0.10, the feather's target is the page's own
materials. So the edge was the page's dry pair against Grass-by-assumption,
straight because levels are per page. It predates this wave (it is the "green
no-page fallback" `GROUND_TEXTURE_W1.md` logged), and section 3 had made it
slightly better.

A resident page too coarse to trust may now name a pair of SWARDS for the
feather to fade toward, at zero trust (the splat's confidence lane carries -1,
so class strength is exactly zero and nothing else the page says is used). Same
bar and same reasoning as section 3: the mixture of two swards is a climate
gradient, smooth at any texel size, which is the one thing a 128-256 m texel can
be believed about. Any pair with a real share of rock, gravel, snow, sand,
pavement or forest floor keeps the Grass base and the fragment-derived third
candidate exactly as before, so no coarse page paints a single-material plate
and distant mountains do not move. The pair mixes by the page's share with no
height winner (a coarse texel has no height evidence). One dial,
`TERRAIN_FAR_SWARD_READ`: 0 off, 1 the nearest texel's own top two (3 loads),
2 the bilinear sparse gather (12); the early return existed on purpose, because
these fragments are most of a cruise frame.

By frame, same world and pose: the polygon is gone and dry country carries its
tone to the horizon; the cheap and the full read differ by 0.7 of 255 with no
visible texel steps in the cheap one. Where the next boundary sits: there is
none inside the view. Levels 5 and 6 fade toward the same kind of target, so the
5/6 page edge carries no step, and the tint shows the far sward in use out to
the horizon. What remains is texels whose pair holds a non-sward (hills, forest
edge, shore): they keep the Grass base, with stair-stepped outlines at 128-256 m
in the TINT, and in lush hill country they draw no visible edge because the
sward mixture there is nearly Grass anyway. In dry hills they could; not seen in
the frames shot, and logged.

**Price: FULL decided, CHEAP NOT YET PRICED, and that is a condition of the
merge.** One tree, dial toggled, four interleaved rounds of off / cheap / full on
`cruise-horizon` and `high-10000ft-down` at a swept 2560x1440 viewport (both
shots sit on the 120 fps cap at the canonical size on a quiet machine, which
would hide a 1-2 % cost; that cap is also why "nothing at cruise" was easy to
say earlier in this wave, and it should be read with that in mind). Another
renderer was on the GPU throughout and the OFF arm's spread against itself was
7.5 % and 5.3 %, where two quiet windows earlier had given 0.0-0.4 %. So:

* FULL costs on the order of 10-20 % of a cruise frame (paired medians -13 %
  and -4 %, mostly one-signed; a canonical-size round agreed in kind at -17 %
  and -22 %). It does not ship under any reading, and the early return it
  replaces is vindicated. It stays behind the dial, three lines, only so a
  later pricing run can show what is not being bought.
* CHEAP could not be priced: paired +6.8 / -0.5 / -8.2 / +2.3 % and -4.1 / -2.0
  / +0.3 / +1.4 %, signs split two and two, medians +0.9 % and -0.9 %, against
  that 5-7 % floor. Not distinguishable from zero; nothing up to about 4-5 %
  excluded. It is a quarter of FULL's texture work with none of its ten-way
  accumulate, which is an argument and not a measurement.

CHEAP merged ON, on the condition that it be priced on a machine with nothing
else rendering before any baseline promotion. It has been, twice, the same
evening, with the owner's own game tab hidden (same-arm spread back to
0.2-0.6 %, where it had been 5-7 %):

* Six interleaved rounds, off against cheap, swept viewport: `high-10000ft-down`
  paired -1.41 / -0.99 / -1.32 / -1.72 / -1.97 / +0.08 %, median -1.36 %
  (+0.11 ms a frame); `cruise-horizon` median -0.04 %.
* Six interleaved rounds, off / cheap / a third state (below):
  `high-10000ft-down` cheap -2.15 / -2.23 / -1.48 / -2.55 / -1.81 / -2.30 %,
  median -2.19 % (+0.19 ms); `cruise-horizon` 0.00 %. All twelve pairs negative.

So CHEAP costs **1.4 to 2.2 % on `high-10000ft-down`, and that is a LOWER
bound**: the OFF arm sits on the 120 fps cap even at the swept viewport (the
harness reports 1.50 M rendered pixels, not the 2.7 M that size should give, so
the window is evidently clamped), and its true headroom is hidden.
`cruise-horizon` is on the cap on every arm: "cannot see", not "free". An
attempt to get off the cap with the HIGH quality tier was abandoned after one
arm: at that tier and viewport the shots run at 9 fps and one arm takes four
minutes, which prices nothing. There is still no uncapped far-field shot on this
host.

**A retraction.** After the first series I gave a confident account of where
the cost went: that naming a pair put every far fragment on the three-material
path to sample a second layer which, at 128-256 m a texel, is minified to its
mean anyway. A third dial state was built on that account (the primary sward as
the no-splat path's one base layer, its albedo scaled by the ratio of the two
reference albedos, no second layer sampled; parked on the local branch
`jazonshou/terrain-far-sward-reference-tone`). Priced beside cheap it came in at
-1.90 % against -2.19 %: 0.3 % apart, inside the same-arm noise. The second
layer was NOT the cost. What the two states share is: three point loads and a
top-two selection on every far fragment, and a base layer that now changes per
128 m texel where one Grass layer used to serve the whole far field. That is a
hypothesis, and is labelled as one this time.

Against the line set for this change (about 1 % at cruise) neither state
qualifies, and whether the polygon or 2 % of a worst-case look-down frame is the
worse thing to ship was a product decision, put to the owner.

**Decided, 2026-09-20: it stays ON.** The owner's words, relayed by the project
manager: "Let's keep it on for now." He had the merged | cheap | full frames in
front of him and a plain account of the cost: 1.4 to 2.2 % on the look-down shot
as a lower bound, invisible on his own machine at the frame cap, more on a
weaker GPU, with the ~1 % rule pointing the other way. It is an owner's override
of that rule, made knowingly. `TERRAIN_FAR_SWARD_READ` stays at 1, the baseline
candidate is captured with it on, and the priced cost above is ACCEPTED, not
unmeasured. "For now" means the biome-tone map below remains the real fix, for a
later wave; when it lands this read and its dial go. The order was kept: price,
decide, promote.

**The real fix**, now thought to be the right one and not a fallback: a
low-resolution BIOME-TONE MAP for the whole streaming window, one bilinear
sample per fragment where this reads three point loads and sorts them, used by
far ground AND by unresident pages, which also removes the half-second of green
after a jump. Its cost is a new resource, its bake, and a binding against the
16-sampler limit; it is its own piece of work.

Left: an UNRESIDENT page still has no source. After a 9 km jump at 300 m AGL the
whole frame is Grass-green for about half a second and then takes its dry tone
at once, with no polygon; in flight the coarse pages stream ahead of the
aircraft, so it should not show, but a fast enough aircraft could outrun them.
The honest fix is a low-resolution biome-tone map for the whole streaming
window: a new resource and a new binding against the 16-sampler limit. Low tier
is unchanged: its two-material path never samples the second layer.

## 6. High turf from 10,000 ft: more of the meso band, not new octaves (`D-5`)

Reported at the promotion review (2026-09-21): from `high-10000ft-down` the reshaped massifs' turf reads green
and flat. It is not bare. Fix-pack T1's meso band lays two soft value-noise octaves, 71 m and 23 m, over all
ground (normal, tone, hue, roughness), and W-1 gave vegetated ground about twice their slope; at that shot's
2-5 m footprint both are at full weight and they are the wavy streaks on the turf. What was missing was
AMOUNT: a gain tuned for lowland meadow from a few hundred metres reads as flat paint from 2-10 km.

`TurfRelief.ts` raises that band's slope and tone on alpine turf only, by `1 + TURF_RELIEF_STRENGTH x gate`,
inside the meso block, so it evaluates no noise of its own. The owner chose 2x (strength 1) from frames of
2x and 3x beside the mock he had approved. Measured on one tree at the same pose and hash: near-field
luminance contrast (std, of 255) 11.82 -> 13.00 at 2x (3x: 14.54; the approved mock: 13.95); 0.56 % of
pixels change by more than 8/255 (3x: 7.1 %); mean luminance on the land -0.7/255 (3x: -1.6: a rougher
normal loses a little irradiance under a high sun, which is physical). Price at 2560 x 1440, three interleaved
rounds, off-arm spread 0.2 fps: -0.6 % on `high-10000ft-down`, within the 1.6 fps spread on `slant-10km`.

### Built first and dropped: billowed octaves at 120 m and 45 m

The first build added hummock relief of its own: two rotated gradient-noise octaves, billowed with a rounded
cusp, calibrated to the microrelief of real alpine meadow (2.9 degrees RMS slope, 2.5 % tone sigma at
strength 1), band-limited by the ground block's octave-weight law, CPU twin pinned to the WGSL on the GPU
(worst slope difference 8.5e-6). It cost 6.0 % on `high-10000ft-down` (-5.1 / -6.5 / -6.4 against a same-round
off arm) and did not read: under that shot's 67.6 degree sun near-field contrast moved 11.82 -> 11.85 / 11.94 /
12.08 at 1x / 2x / 3x; with the sun at 18.5 h the massif's own cast shadows take most of the turf and the lit
patches did not change at 3x (0.14 % of pixels over 8/255); it only read at 6x, about 17 degrees RMS, which is
not physical and costs the same. The cost is per covered pixel (-6.0 % where the gate opens on 76 % of the
frame, -1.3 % where it opens on 4 %): 32 integer multiplies of the ground hash per pixel, not the octave
count (the three-octave prototype cost 6.5 %). The first sizing of its heights at 2.5 % of the wavelength
measured 11.5 degrees RMS: the unit-variance noise's gradient is about 3.3 per wavelength, so height over
wavelength is not slope for this field.

### The gate, and the two defects a review found in it

Sward only (grass, dry grass, heath: `groundCoverOf >= 0.9`, the seam feather's own bar; forest floor at 0.55
and scree at 0.15 are out, rock, snow, sand and pavement are zero) x the airfield exclusion x (1 - canopy
closure) x the classifier's alpine ramp (420-980 m) x gentle ground (fading out over 33-40 degrees, gone where
the classifier's `steep` begins) x a fade-in over a 0.6-2 m footprint, where D-3's coarsest octave has just
faded (0.54-1.46 m) x W-1's tier switch. A verified multi-reviewer pass found two leaks in the first cut, both
fixed:

* The sward share was read off the blend weights, but on an untrusted page the seam feather re-targets what is
  DRAWN to the primary (plus the fragment's third candidate) for any pair that is not two swards. A scree or
  snow primary with a sward secondary got the term at the secondary's blend share (about 0.3-0.4 on L2-L4
  pages, exactly the band's range). The share is now re-targeted inside the feather the same way the layers
  are: `mix((s_lower (1 - pair) + s_upper pair)(1 - third), share, classStrength)`.
* There was no canopy term. Beyond the trusted pages the fallback cannot name forest floor, and an upper forest
  belt in a cool climate classifies as turf or heath, so the term reached ground the canopy handoff paints as
  forest. It now multiplies by (1 - closure) like the scrub gate; the closure read moved above the patchwork
  branch (same value, read once).

Evidence, gate tinted red on the same hash: `high-10000ft-down` 75.9 % of the frame with every rock patch left
uncoloured and clean-edged; `slant-10km` 4.0 % (far ridge tops); `winter-noon` 0 % (snow); `canopy-1200ft`,
`forest-line-highsun` 0 %, and with altitude and range taken out of the gate the forest floor under dense trees
stays uncoloured while the meadow beside it reddens; `approach-500ft` 0.9 %, `grove-meadow-2m` 0.2 %;
`cliff-60m`, `mountain-close`, `terrain-material-1600ft-down` 0-0.1 % (range). Beyond the trusted pages the
exclusion is only as good as the fallback, which knows grass, slope rock and snow and nothing else; every
vegetated-ground term shares that limit.

Tests (`render.webgpu-turf-relief.test.ts`): the share table and its threshold, the alpine ramp and the slope
limit against both twins of the classifier, the fade-in against D-3, every factor of the gain, the fold at
strength 0, the gain declared inside the meso block and multiplied into exactly its slope and its tone, the
share lines of both material paths and the feather's re-target, and that everything the gain reads is declared
above it. Nine mutations each fail it: forest floor admitted, the gain declared outside the meso block, the
alpine ramp moved to 300 m, the feather re-target removed, the canopy factor removed, the gain dropped from
the tone, dropped from the slope, the tier switch removed, and the dial set to B.

What moves, all 39 shots captured on one tree with the gain on and off. The run-to-run floor is that same off
arm against the promoted baselines, over all 39 shots: mean 0.000-0.017 of 255 (highest `forest-line-highsun`
0.017, `mountain-close` 0.008). `high-10000ft-down` moves by a mean of 1.26/255, with 0.56 % of pixels over 8/255;
it is the shot the term is for. `cruise-sun-30` 0.064 and `slant-10km` 0.040 are far ridge tops, with 0.01 % of
pixels at most over 8/255. `water-25ft` 0.150 and `water-400ft-glitter` 0.072 are not turf: the capture harness
never resets the ocean's frame counter, so wall-clock-paced streaming in earlier shots decides which frame the
every-4th-frame wave cascade last updated before the pinned capture time; a turf-free pair on one tree
reproduces the delta, and a same-phase turf-free capture matches the turf-ON sea (verified by the water
engineer). `approach-500ft` 0.008 is also that class: its lake moved, 8.8 % of lake pixels, 7.9/255 at most, and
it is excluded from turf by the code path, not by a measurement. `cruise-horizon` 0.019. Every other shot is
at 0.017 or under, inside the floor. So one shot re-baselines.
