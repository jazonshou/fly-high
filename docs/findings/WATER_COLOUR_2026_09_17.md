# Water colour: what was wrong, what it is now, and what is still open

**Status: shipped as W-7 through W-10 on `jazonshou/water-environment-color`.**
Jason's report, verbatim: the water is *"basically always the same - light blue
with white foam"*, and *"from a distance still looks like plastic"*. Both turned
out to be one thing — the renderer was not measuring anything about the water —
and the fix is four measurements.

## What was wrong

| # | Defect | Evidence |
|---|---|---|
| 1 | One optical water type for every sea, lake and river in every world: absorption `[0.45, 0.07, 0.02]` and an in-scatter of `vec3f(0.018, 0.115, 0.105)`, both literals | `5-11`'s depth include; a temperate forest inlet rendered as a tropical lagoon (`terrain-material-1600ft-down`) |
| 2 | That in-scatter is ~25x too bright in green. Deep water emitted `(0.030, 0.140, 0.120)` at the reference key where clear ocean emits `(0.0008, 0.0056, 0.0203)` | Calibrated against the renderer's own lighting: sun 5.2, Babylon's Lambertian 1/PI. A bright diffuse sheet under a thin reflection IS the plastic look |
| 3 | The body was lit by `max(sunIlluminanceNormalized, skylightIlluminanceNormalized)` — a grey SCALAR, which cannot carry an illuminant | `coast-10km-lowsun`: cyan lagoons under an orange sunset, beside land that had gone warm and dark |
| 4 | Sub-pixel slope variance was a SUM of independent estimates (every faded cascade's band variance plus five capillary octave tails) reaching ~0.09-0.12 where Cox & Munk measure 0.052 at this world's 9.6 m/s — past the roughness clamp | A probe capture (roughness written to the beauty buffer) read near, mid and far sea all within a few per cent of the ceiling. One BRDF everywhere, and the wave-S gust lanes clipped away |
| 5 | Foam coverage came from a tuned Jacobian threshold, not from wind | Monahan & O'Muircheartaigh give 0.87% at this wind; the frames carried several times that, as white static over a dark sea |

## What it is now

**A water body is two spectra** (absorption and backscatter), and its colour is
derived from them by Lee et al.'s quasi-single-scattering reflectance plus the
Maritorena/Lee shallow-water column-and-bed split, with the real refracted solar
path and the lengthening upwelling path. `WaterShaders.ts`.

**Those spectra come from four concentrations** — chlorophyll, CDOM, sediment,
glacial rock flour — through published mass-specific spectra.
`WaterConstituents.ts`, validated against the measured reflectance of clear
ocean, green coastal water, a humic lake, a glacial lake and a muddy river.

**The concentrations come from the environment.** The sea reads its own depth
(Case 1 to Case 2; this world's bed reaches only ~110 m, so the shelf IS the
coast) and a province field baked from the terrain's own temperature and
moisture fields. Lakes and rivers get theirs at mesh build from elevation,
temperature, moisture, depth, area and stream power — pure functions of world
position, so page seams cannot step.

**The light is the scene's.** Downwelling irradiance with its colour, split into
the collimated share (which the caustic sheet focuses) and the diffuse share
(which nothing does), on the terrain's own irradiance scale so a water
reflectance and a land albedo are comparable quantities.

**The far field is anchored and varied.** Total sub-pixel slope variance is
Cox-Munk's, minus what the rendered normal already carries; foam coverage is
Monahan's wind law with the spectrum deciding only where; reflectance splits
into Koepke's effective 0.22 for a whitecap and 0.5 for surf; the wind is
sheltered in the lee of coasts by a four-tap upwind march of the bathymetry; and
Langmuir windrows move the coverage into wind-aligned lines without adding any.

Measured: open-water macro variation (8-px block std) 2.39 -> 5.12 at
cruise-horizon's mid distance; open-sea speckle energy below the pre-change
baseline while the surf band is untouched.

## Still open

- **The pale shallow margin is thin, and it is the terrain's.** Transects
  seaward from six coastlines: the bed reaches 3 m depth within 0-40 m of the
  waterline on four of them, 10 m within 40-600 m. The turquoise-over-sand band
  is narrow because the shoreline gradient is steep. Widening it is a coast
  profile change, which belongs to terrain.
- **The default world has almost no inland water.** Seven 28.8 km windows around
  the default seed's spawn: at best one lake each (radius 85-120 m, elevations
  29-223 m), and zero rivers anywhere — rivers exist only in eroded worlds. The
  inland chemistry is real and tested but rarely met in the shipping world.
- **Glacial turquoise needs a lake above ~900 m**, where the elevation lapse
  makes the water genuinely cold. The default seed's lakes sit far below that,
  so that regime is currently unreachable. Lowering the threshold would put
  milky turquoise in a temperate forest, which is the same error as the tropical
  lagoon this wave removed.
- **Slicks** (surfactant damping of the 5-15 cm band, which needs wind under
  ~6 m/s) are researched but not implemented; the default world's 9.6 m/s wind
  would leave them inert. They are the next cheap source of far-field variation
  if a calmer world wants one.
