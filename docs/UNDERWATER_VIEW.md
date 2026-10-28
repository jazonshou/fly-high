# Underwater view: the water column, the sea's underside, caustics and bubbles

What the camera shows once it is under the water in a car session: the
walker diving, or the character camera dipping under the surface (walking
plan, "Underwater view"). The code is `src/render/webgpu/underwater/`. Only
car sessions build it (`FlightRenderer`, a surface vehicle of class `car`);
aircraft and boat sessions never construct any of it.

Above the water nothing changes. The underwater pass and the underside
variant are separate from the above-water shaders, not branches in them;
they run only while the camera is submerged, and each is drawn once at load
(drawing nothing) so its pipeline is built before the first dive.

## When the camera is under

`CameraWaterSampler` (`cameraWater.ts`) samples the water at the render
camera every frame on the main thread: the sea through a sea twin of the
drawn spectrum (all but its sub-8 m cascade), lakes and rivers through
hydrology's water source. `submerged` means the camera is below that
surface. The character camera keeps a clearance band either side of it
(0.15 m + 0.07 Hs) so a frame never straddles the surface.
`FlightRenderer.cameraUnderwaterDepth()` reports the depth (0 above water).

## The water column (`WaterColumnPass`, `underwaterLight.ts`)

One water type for the whole view: the one at the camera, from the same
chemistry and optics the water shaders colour the surface with (the sea's
`oceanConstituents` at the camera's depth and province, a lake's or river's
from hydrology), with 30% of its particles (phytoplankton, sediment, rock
flour; `UNDERWATER_PARTICLE_SHARE`). The surface seen from above keeps them
all; under it the view is that much clearer, so a dive shows what is around
it. Dissolved colour is kept, so a peaty lake stays brown. Per colour
channel:

- Beam attenuation `c = a + b`, from the shaders' absorption `a` and
  backscatter `b_b`. Pure water scatters half its light backward and
  particles 1.83% (Petzold), so `b = b_w / 0.5 + (b_b - b_bw) / 0.0183`.
  Clear open sea is c = 0.28 / 0.061 / 0.023 per metre (red, green, blue):
  red gone in a few metres, blue carrying for tens.
- Diffuse attenuation `K = (a + b_b) / mu`: the sun's share along its
  refracted beam, the sky's along 0.842, the mean cosine of a uniform sky
  refracted into the 48.6 degree cone.
- The water's own light: straight down it is the deep column's upwelling
  radiance (what the surface shaders' `applyUnderwaterBeerLambert` veils
  with); toward the horizon and up it brightens as `3^(1 + mu)` (3 times
  level, 9 times straight up), the shape measured light fields have outside
  Snell's window.

A full-screen pass at the head of the post chain (it owns the scene target
and its depth; with MSAA it reads the resolved r32float depth) fades every
pixel toward that light over the metres of water to what it hits, and dims
what it hits by the light left at its depth:
`dim = f_sun e^(-K_sun z) C + (1 - f_sun) e^(-K_sky z)`, with `C` the
caustic gain below. A ray climbing past the surface stops at it.

What a diver sees, `4.8 / c` in green, at the shots' camera spots:

| Water | All the particles (the surface's) | The view's 30% |
|---|---|---|
| Marina basin, 3 m deep | 1.0 m | 3.1 m |
| Home shelf, 13-21 m deep | 3.0 m | 8.8 m |
| Tropical shelf, 13 m deep | 7.2 m | 19.3 m |
| Offshore, 91 m deep | 27.5 m | 48.5 m |

## The eye under the water (`UnderwaterAdaptation`)

The eye adapts to the light left at its depth: the luminance of the sun's
and the sky's light `e^(-K z)` down, as a share of its value just under the
surface. Its gain eases toward the reciprocal of that share, at most 16
(four stops), in log space with a 0.5 s time constant: 95% of the way in
1.5 s. Just under the surface the gain is 1, the exposure above it, and
back above the water it is 1 again at once. The column multiplies all it
shows by the gain. It is worked out on the CPU, like rod vision's display
gain: the one exposure curve stays the tone map's, which a write every frame
would make every material re-check its defines for.

## The sea's underside (`OceanUnderside`)

A variant of the ocean material on the sea's own disk, with the same
cascade displacement and marina shelter. It draws instead of the sea (the
above-water surface is hidden, `setSurfaceHidden`) while the camera is in
the sea, and never otherwise.

From below a facet is a window and a mirror at once. A ray meeting it at
angle i leaves into the air at sin t = n sin i (n = 1.333). Inside 48.6
degrees the sky and the sun come through, squeezed into Snell's window,
brightened n^2 and dimmed by the exact unpolarised Fresnel transmittance.
Past it the facet is a perfect mirror of the water below (total internal
reflection), whose light is the column's `3^(1 + mu)` distribution. The sun
is a normalised lobe that holds the sun's irradiance (clamped at 30,000 for
the half-float targets), as wide as the sun's disc plus the spread the
sub-pixel waves give it.

| Tier | `underwaterSnellWindow` | What the underside is |
|---|---|---|
| 0 | off | flat: one window of analytic sky and sun, one mirror, no texture reads |
| 1-3 | on | the sea's own facets (five cascades' slopes and the capillary tail), the sky from the environment probe the sea reflects above water |

## Caustics (`underwaterCaustics`, tier 2 and up)

The column multiplies the sun's share of `dim` by the sea's caustic sheet
where each ray lands under the water: the same `WATER_CAUSTIC_WGSL` bands
the sea's bed uses from above, fed from the cascades' stored Jacobians and
the capillary tail. Each cascade fades out as a pixel's footprint reaches
0.15 to 0.5 of its wavelength, and the refracted-beam gate ends them at
24 m. They fall on whatever the column sees under the water: the bed, the
piles, the walker. In a lake or river only the capillary tail folds light,
as it does for a lake's bed seen from above (inland water carries no
Jacobian).

## Bubbles (`UnderwaterBubbles`)

The walker's breath, visual only. A burst of 28 bubbles as the head goes
under, a breath of 7 every 3 to 5 s (the first 2.5 to 4.5 s after the
plunge, as `personVoice` breathes) and a trickle between. A bubble rises at
a clean bubble's terminal speed, `0.3 (1 - e^(-r / 1.2 mm))` m/s, swells
with Boyle's law on the way up, and leaves at the surface. All of them are
one draw of camera-facing discs, at most 64, in the scene only while any
are alive.

## Cost

| Tier | Budget while submerged | What runs |
|---|---|---|
| 0 | 0.2 ms | the column, a flat underside |
| 1 | 0.4 ms | adds Snell's window |
| 2 | 0.6 ms | adds caustics |
| 3 | 0.8 ms | the same as tier 2 |

Draw calls while submerged: the column is one full-screen pass, and on the
multisampled tiers the scene target's depth resolve is one more; the
underside replaces the sea's draw (no change); the bubbles add one while
any are alive. Above the water: none of it, after one primed frame each at
load.

## Tests

| Test | What it holds |
|---|---|
| `tests/render.camera-water.test.ts` | the camera's side of the sea and of a drawn lake; the sea twin's one-point path; dry ground; the weather |
| `tests/render.underwater-light.test.ts` | c, K and the upwelling from the shaders' optics; the view's visibility at the shots' spots; the light left with depth; the eye's adaptation; the environment field read on the CPU |
| `tests/render.webgpu-msaa-owner.test.ts` | the column heads the chain and owns the scene target's samples |
| `tests/render.underwater-bubbles.test.ts` | rise speeds, Boyle, the burst, the breaths, leaving at the surface |
| `tests/render.webgpu-water-extraction.test.ts` | the sea's composed WGSL hashes unchanged |
| `tests/gpu/underwater-column.test.ts` | the column on a real adapter, and the eye's gain |
| `tests/gpu/ocean-underside.test.ts` | both underside variants against the textbook Fresnel and Snell values; nothing drawn while primed |
| `tests/gpu/underwater-caustics.test.ts` | a folded sea's web on the floor; a lake keeps the capillary tail only; nothing past the 24 m gate |

## Known limits

- A lake's or river's surface seen from below keeps its own path: the
  hydrology shader veils it with `applyUnderwaterBeerLambert` over the
  camera's distance, and the column fades that same distance again. There
  is no lake underside variant yet.
- No light shafts and no suspended particles.
- The bubbles keep `personVoice`'s breathing rhythm but are not tied to
  its sound.
