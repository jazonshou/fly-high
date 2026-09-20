# Sun glitter: why the sparkle read as static, and what replaced it

**Status: shipped as `W-11` on `jazonshou/water-sun-glitter`.**

Jason's report, verbatim: *"I like how there are sparkles to try and highlight
the glint from the sun reflecting on the water. However, it simply doesn't look
very realistic right now. Right now it looks like static that feels out of place
with the terrain/rest of the water."*

He was right, and the word he chose was the diagnosis. It was static: a
per-pixel white-noise field hashed on SCREEN coordinates, welded to the display
while the sea moved underneath it.

## The frame that reproduces it

No shot in the capture set framed the regime he photographed. `water-25ft` sits
8 m up, where the ripples are resolved and the far-field sparkle is faded out;
`coast-10km-lowsun` sits 800 m up with the sun ASTERN, so it frames the matte
side of the sea and no glitter path at all. Between them is the band where a
pixel covers 0.1–1 m of sea, looking INTO the sun — which is where an aircraft
spends its time and where the sparkle statistic switches on.

`water-400ft-glitter` (120 m MSL over the same coast, sun 12° off the nose,
dusk) is that frame, and it is committed as a permanent baselined shot. **The
defect shipped because nothing looked there**, which is the general lesson: a
term that fades in on a footprint window needs a shot inside that window.

Two diagnostic poses were used and then removed from the shot list. Recorded so
they can be re-shot: a steep look-down (same coast, 460 m MSL, 38° down, sun 12°
off) for the near-normal case where the glare floor binds, and a rotation pair
(120 m, pitch 12.0° vs 12.5°, same position, same simulation time) for the
anchoring measurement below.

## What was wrong

| # | Defect | Evidence |
|---|---|---|
| 1 | The gain was hashed on `fragmentInputs.position.xy` — the SCREEN pixel. The pattern was anchored to the display, not the water | Rotating the camera 0.5° moves the sea ~10 px down the frame; the speck layer correlated **0.841 at zero shift** and 0.044 where the water went |
| 2 | The exponent cap `k ≤ 24` was deciding the variance of every water pixel in the programme | A categorical capture of `glintExpectedCount` reads n < 0.01 over the whole sea and n < 0.1 in the path's core. The cap corresponds to n = 0.085, so every pixel in every glitter path was ON it |
| 3 | At that cap the gain is a CONTINUOUS smear, not an event: 13% of cells above 1×, a spread of mid-greys | Which is what television static is made of. A real glitter path is sparse bright points, not a grey mottle |
| 4 | `WATER_GLINT_FACET_LENGTH_METERS = 0.06` was a guess, and 3.5× too coarse | It is what pinned the count below the cap everywhere |
| 5 | A mean-one multiplicative gain is NOT mean-one after a compressive tone map | The glitter path's mean luminance read 0.276 with the sparkle on against **0.393** with it off. The sparkle was throwing away 30% of the path's brightness while making it uglier |
| 6 | The whitecap flecks had the same screen hash, and were drawn per PIXEL over a 12 m² patch | At 5 km a cap covers seventeen pixels; seventeen independent draws over one patch is pixel salt with a cap's name on it |

## What it is now

**A glint is a discrete EVENT, not a noisy lobe.** Where a patch of sea holds
less than one sun-aiming facet, the truth is that almost every patch holds none
and the few that do hold a mirror image of the sun. The gain is a Bernoulli of
probability `n` paid at `1/n` (Poisson to first order; `P(N≥2)` is under a
quarter of a percent across the window it owns), handing over to the previous
continuous gain above a count of a few. Mean exactly 1 and variance 1/n as
before, so the physics contract is unchanged.

The consequence worth writing down: a firing cell's radiance is `lobe/n`, and
the lobe and `n` carry the same `D(h)·(n·h)`, so **that ratio does not depend on
where in the glitter path the cell is**. Every glint is the same brightness —
the sun's own mirror image — and what the glitter path varies is how MANY there
are. That is what Cox & Munk's photographs and the NOAA glitter note describe,
and it is what the old continuous gain could not produce.

**The cell is a square patch of WATER on a power-of-two world grid.** Side is
`2^floor(log2(target))`, taken by clearing the float's mantissa, so it is
exactly constant between level boundaries and the grid is anchored. The leftover
scale is spent as a **stochastic quadtree**: a coarse cell either acts as one
cell of side `2s` or as its four children, chosen by a hash of the coarse cell,
with the probability set so the expected cell area is the target area exactly.
That is a parameter-space blend rather than an output blend — no visible band at
the level change, no doubled draw, one extra hash.

Square in world space on purpose. A glinting facet is an isotropic patch of sea
and its image is whatever the projection makes of it — a horizontal dash at a
grazing angle, as photographs of glitter near the horizon show. A
footprint-shaped cell would be a world-anisotropic patch, which nothing physical
is.

**Every cell keeps its own clock**, so glints are born and die independently
rather than on one number shared by the frame.

**The payout is capped mean-preservingly.** `min(1/n, 256)`, with whatever the
cap withholds moved into a smooth pedestal `1 − n·payout` rather than discarded,
so the mean stays exactly 1. This is the opposite of the old exponent cap, which
changed the distribution and said nothing about where the energy went.

**The whitecap fleck's cell is the CAP**, 12 m², so its count reduces to the
coverage itself and a cell that fires is a whole white cap rather than an
8%-opaque smudge.

## What it measures

**Anchoring, on rendered pixels.** Camera pitched 12.0° → 12.5°, position and
simulation clock frozen, so only the view moves and the sea slides ~10 px down
the frame. Correlation of the high-pass speck layer over a 400×220 window in the
glitter path:

| build | correlation at zero shift | best shift |
| --- | ---: | --- |
| before | **0.841** | dy = 0 (0.044 at dy = −10) |
| after | **−0.001** | dy = −10 px at 0.674 |

**Persistence, on the CPU mirrors** (45 m/s straight cruise, 120 m, 1/60 s
steps, camera 12 km from the world origin so a scale-driven defect is visible):

| range band | anisotropy | cells spanned along range | n per cell | follow-the-water | fixed screen pixel, after | fixed screen pixel, before |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200–500 m | 2.9 | 1.94 | 0.042 | **0.941** | 0.161 | **0.959** |
| 500–1200 m | 6.5 | 2.92 | 0.503 | **0.934** | 0.345 | **0.912** |

Read the last two columns together: the old rule held a glint on a fixed screen
pixel while the water flowed underneath it, and the new rule holds it on the
water. Past 1200 m the count per cell is 2.8 and rising, which is the continuous
branch — there are no discrete glints left to flicker.

**Brightness.** In the same window: 0.276 before, **0.320** after, against 0.393
for the smooth lobe with no sparkle at all. The change gives back about two
thirds of the brightness a mean-one gain was losing through the tone map, while
being MORE discrete rather than less.

**Bloom is not doing the work.** Tier 1 (which is what Jason's default settings
resolve to: `quality: "medium"`, `renderingMode: "balanced"` → tier 1) has bloom
on. With `bloomEnabled: false` and everything else identical, the worst 64 px
tile moves 3.8/255 and that tile is the wet-sand sheen by the spit, not the
glitter; the glitter window's statistics are identical to three decimals. So the
look is the same on the tiers where bloom is unfunded, and the 1.5 px glare
floor and bloom do not double up.

**Headroom.** 276 near-clipped pixels on the whole frame (a clean daylight
baseline reads 56; a blown-out light source reads in the thousands), 0 on the
steep look-down. No isolated bright disc anywhere off the path.

## If you are here again — three rules this wave paid for

**1. A screen-space hash welds a temporal effect to the screen.** Any per-pixel
random field keyed on `fragmentInputs.position.xy` (or `gl_FragCoord`) is
stationary in the DISPLAY while the scene moves under it, and that is what reads
as television static however fine the grain is. **Test for it by rotating the
camera with the world and the clock frozen** — two captures, same position, same
simulation time, half a degree of pitch apart — and correlating the high-pass
residual at zero shift. A screen-anchored field scores near 1 there; a
world-anchored one scores near 0 and peaks where the geometry says the world
went. It costs two captures and one script and it is the only cheap test that
separates the two.

**2. A world lattice sized directly from the pixel footprint re-rolls every
frame in flight.** The cell size is then a continuous function of range, so
every cell boundary at world coordinate `p` moves by `p·(ds/s)` — tens of cells
per frame at ordinary cruise speeds, i.e. a complete re-roll. **Quantise the
scale to powers of two** and spend the remainder as a stochastic choice between
two levels. Take the power of two by CLEARING THE FLOAT'S MANTISSA, not with
`exp2(floor(log2(x)))`: the bit trick is exact, so a CPU mirror and its shader
agree to the bit, while the log/exp pair rounds either side of a boundary and
puts the two in different cells. **A parked screenshot cannot see any of this.**

**3. A mean-one gain with a cap silently becomes "everything sits on the cap".**
Capping the shape parameter of a distribution does not bound an outlier, it
MOVES THE WHOLE POPULATION: once every pixel's parameter is past the cap, the
cap is the only thing deciding the variance, and it decides it identically
everywhere. Before believing a stochastic term is doing what its derivation
says, **capture the parameter itself** — a categorical colour map of the count
or the exponent, written straight to the beauty buffer — and check the frame
shows a gradient rather than one flat colour. If a cap is genuinely needed, cap
the OUTPUT and move the withheld expectation into a smooth pedestal, which
leaves the mean exact and says where the energy went.

## Traps hit, and what generalises

**A lattice whose scale is a continuous function of the footprint is anchored to
nothing.** The first version of this change built the cell grid from the inverse
of the fragment's screen-to-world Jacobian, which gives exactly one cell per
pixel at any grazing angle and is elegant and wrong: the cell SIZE then varies
with range, so a cell boundary at world coordinate `p` moves by `p·(ds/s)`
whenever the footprint changes. Measured on this shot's own geometry at 45 m/s,
that is **28.6 cells of shift per frame at 500 m** and 7.1 at 1 km — every cell
id under every pixel changes every frame and the whole field re-rolls. **It
would have looked perfect in a parked screenshot and been static again the
moment Jason flew.** This is why the glint literature quantises the grid scale
to discrete levels; it is not an optimisation. `render.webgpu-water-glint-motion.test.ts`
pins the arithmetic.

**A power-of-two grid is also the numerically exact one.** `world / side` with
`side = 2^k` is an exponent shift, so it is exact in floating point at any world
coordinate the renderer can reach. A grid whose side was the raw footprint would
be losing bits at 10⁴ m from the origin in f32.

**`exp2(floor(log2(x)))` and `2 ** Math.floor(Math.log2(x))` are not the same
function.** The GPU parity test caught a world coordinate landing on a cell
boundary that read −18009 on the CPU and −18010 on the GPU. Both are quantising
to a power of two; they round either side of the boundary. Taking the side by
CLEARING THE MANTISSA is exact by construction on both sides, and cheaper. For a
quantity a cell index is computed from, an ULP is not a tolerance — one off is a
different glint.

**A glare floor on the cell's AREA is not a glare floor.** Written that way it
widened grazing cells to 3.5 px and printed a coarse gravel texture, while doing
nothing where single-pixel salt actually lives. The floor belongs on the cell's
WIDE screen axis (the footprint's minor world extent), where it binds at near-
normal incidence — looking down at a bay from altitude — and cannot bind at a
grazing angle, where the projection already makes the cell wide.

**One payout ceiling cannot serve two features.** 64 was chosen against the
glints and silently bound on the whitecaps, whose natural payout is 115 — the
number that makes a cell carrying a cap fully white. At 64 it was spending 45%
of Monahan's coverage as a uniform haze instead of as flecks, which is exactly
the defect `W-9` removed. The parity test's probe set is what surfaced it.

**"Lockstep" was an overstatement and is retracted.** The old phase was
`floor(time·rate)`, one number for the whole frame, and it is easy to describe
that as the sea blinking in unison. Measured, the cross-fade spreads the visible
transitions anyway: the largest share of glint births in any single frame is
**4.2%** for the shared clock against **2.5%** for per-cell clocks, on a 1.7%
uniform floor. Per-cell clocks halve a real concentration; they do not remove a
strobe, because there was not one. The screen anchoring was the defect.

**SSIM against a committed baseline is not a property of the code alone.** It is
a property of the code AND the shot list. `night-moonlit` read 0.9618 against
its baseline on a six-shot filtered run and 0.9905 on a three-shot one, with the
SAME tree — 26/255 on the worst tile, from the list alone, because
`VITE_PERF_SHOTS` changes the streaming history each shot arrives with. The
previous wave recorded this at 0.5–0.8/255 for water shots; on the
ground-texture wave's night shot it is two orders of magnitude larger, enough to
flip a gate. **Arm-to-arm at an IDENTICAL list is bit-exact** (two runs of the
same tree agreed to 0.0/255), and that is the only instrument for "did my change
move this shot". This nearly cost a false regression report: the diff image was
over moonlit ground, which a water-only change cannot touch.

**Nine shots already drift against their baselines on `jazonshou/House-Keeping`,
through nobody's current change.** The terrain wave promoted twenty baselines at
`0ed07bc`; `night-moonlit`, `night`, `water-3m`, `water-25ft`,
`coast-10km-lowsun`, `winter-noon`, `cruise-horizon`, `cruise-sun-30` and
`dusk-mesopic` were not among them. A baseline SSIM failure on those is not
evidence about the change in front of you until a full candidate absorbs it.

**The viewer's world is random.** `FlightGame` initialises its seed state to
`0x51a7e`, but on mount `readSeedFromUrl()` returns `createRandomSeed()` when
there is no `?seed=` parameter, and writes the result into the URL. A pose from
a screenshot is therefore **not reproducible** without the seed from the address
bar — `water-400ft-glitter` is the nearest equivalent to Jason's frame by
construction, not a reproduction of it.

**The payout cap's correction is real and nearly invisible, and both halves of
that are worth recording.** Raising it 64 → 256 stops the ceiling binding on the
whitecap flecks, where the natural payout is 115. Measured arm-to-arm at an
identical shot list, it moves `slant-10km`, `cruise-horizon` and
`cdlod-transition` by at most **0.1/255** on the worst 64 px tile, with
near-clipped pixel counts identical (7, 3, 0). That is because those shots'
whitecap coverage is small at their winds and footprints — the frames that would
show it are a fresh breeze at range, which the set does not currently hold. So
it is a correctness fix with no visible effect on today's frames, not a
look change, and it should not be credited with one.

## Known limits and follow-ups

- **Cox & Munk's slope ANISOTROPY is not implemented.** They split the total as
  `σ_along² = 3.16e-3·U` and `σ_cross² = 0.003 + 1.92e-3·U`, which sum to the
  `0.003 + 5.12e-3·U` anchor already in the code, so it is free of the total. At
  this world's 9.6 m/s that is a variance ratio of 1.42 and an RMS-slope ratio
  of 1.19, i.e. a glitter path 19% longer along the wind. It was dropped because
  the path's visible shape is already set by sun elevation (the NOAA note puts
  width/length at `sin(elevation)`, 0.12 at this shot's sun — an 8:1 ellipse), so
  a 1.19 modulation is a couple of percent of the signature, and buying it means
  touching the shared sun lobe, the count and the Fresnel. Self-contained
  follow-up; the numbers are here so nobody re-derives them.
- **A grazing pixel spans 2–4 world cells along range and samples one.** That
  undersamples along range. Measured follow-the-water persistence is 0.94 in
  both discrete bands, so it is not producing flicker and the 1-D occupancy sum
  that would fix it was not built. If a future pose makes it visible, the fix is
  to evaluate the expected count over the cells the pixel spans rather than
  sampling one.
- **The facet length is a tuned number inside a physically bounded range**, and
  the docblock says so. What it stands in for is the decorrelation length of the
  slope the renderer has not resolved, which is a band: bounded below by the
  capillary scale (17.2 mm, the gravity-capillary minimum-phase-speed
  wavelength) and above by the pixel footprint. 0.0172 m is the bottom of that
  band. It does not enter the mean.
- **`water-400ft-glitter` carries a baseline but no delivery floor.** Floors are
  derived from three runs on the pinned reference adapter and this shot was
  authored on a host that is not it, where every floor already fails under load.
  It is declared as an unpinned probe in `tests/delivery-floors.test.ts` and as
  an unmeasured shot in `PERF_CAPTURE_CEILING_PROVENANCE`, both with that
  reason. It becomes pinnable the moment somebody runs it on the reference host.

## Sources

Cox & Munk, *Measurement of the roughness of the sea surface from photographs of
the sun's glitter* (JOSA 44, 1954) — the slope statistics every sea-surface BRDF
is anchored to, and the anisotropic split above. Lynch, Dearborn & Lock,
*Glitter and glints on water* (Applied Optics 50, 2011) — glitter rides the
capillary waves rather than the gravity waves carrying them, and a glint's
creation and annihilation is an optical catastrophe, so glints are born and die
in pairs along curves. NOAA Physical Sciences Laboratory, *Glittering light on
water* — the glitter pattern is roughly elliptical with `width/length ≈
sin(elevation)`, its angular length is four times the maximum wave-slope angle,
and it is "many bright points of light that come and go, blending together to
form a smooth path… when viewed at a distance", which is the sentence this whole
change implements. Deliot & Belcour, *Real-Time Rendering of Glinty Appearances
using Distributed Binomial Laws on Anisotropic Grids* (I3D 2023) — grids fitted
to the footprint, and blending LOD PARAMETERS rather than outputs. Zirr &
Kaplanyan, *Real-time Rendering of Procedural Multiscale Materials* (I3D 2016) —
footprint-driven multiscale hierarchies for temporal stability. Jakob, Hašan,
Yan, Marschner & Ramamoorthi, *Discrete Stochastic Microfacet Models* (SIGGRAPH
2014) — counting facets rather than integrating them, which is the model the
discrete gain here is a cheap real-time form of.
