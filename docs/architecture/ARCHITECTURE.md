# fly high — Architecture Reference

**Status: normative.** This file is the live architectural contract, enforced by
[`src/render/webgpu/owners.ts`](../../src/render/webgpu/owners.ts) and
[`tests/architecture.boundaries.test.ts`](../../tests/architecture.boundaries.test.ts):
adding a second definition of an owned artifact fails `npm test` with a message
naming the owner. This file is what the code must satisfy *today*. Section
marks such as §1.3 and item ids such as `0-4` refer to the rendering plan this
contract came from, now archived with its decision log (see
[`../ARCHIVE.md`](../ARCHIVE.md)).

---

## 1. Single owners

Every artifact below has exactly one owner and one definition site. Consumers
import; they do not re-derive. Rows marked *planned* name the plan item that
creates the file — the ownership decision is already binding.

| Artifact | Owner | Definition site | Status |
|---|---|---|---|
| World-page payload schema — every page channel | terrain-geometry | `src/render/webgpu/world/payload.ts` | live |
| Page geometry — one number | terrain-geometry | `src/render/webgpu/world/pageGeometry.ts` | live |
| Terrain spine contract — slot geometry, atlas sizing, the season key, the node record, the parity criterion | terrain-geometry | `src/render/webgpu/terrain/TerrainSpineContract.ts` | live (`4-0`) |
| Terrain evolution contract — macro domain, height-authority ladder, erosion/hydrology exports and hydraulic geometry | terrain-geometry | `src/render/webgpu/terrain/TerrainEvolutionContract.ts` | live (`5-0`/`5-1`) |
| Shared amortised-compute meter | performance | `src/render/webgpu/core/ComputeBudget.ts` | live (`4-0b`, = `6-10` moved) |
| Guarded `ShadowDepthWrapper` factory — the one construction site | lighting | `src/render/webgpu/core/guardedShadowDepthWrapper.ts` | live (`4.5-0`) |
| Off-thread terrain material synthesis — worker, protocol and client | terrain-material | `src/workers/materialSynthesis.worker.ts`, `src/workers/materialSynthesisProtocol.ts`, `src/render/webgpu/terrain/MaterialSynthesisClient.ts` | live (`4.5-C2b`) |
| Terrain height kernel (WGSL) — the transliteration of `src/world/{seed,noise,geology,terrain}.ts` | terrain-geometry | `src/render/webgpu/terrain/TerrainKernel.ts` | live (`4-1`) |
| Volcanic site index — the overlay's WGSL twin, the packed index, and the stream every landform bake binds (pages wider than it are baked with part of it and refreshed in place as the observer moves) | terrain-geometry | `src/render/webgpu/terrain/VolcanicOverlayKernel.ts`, `src/render/webgpu/terrain/VolcanicSiteIndexStream.ts` | live (volcanic land) |
| `TerrainPageAtlas` + residency + page generation, including heterogeneous hydrology resources | terrain-geometry | `src/render/webgpu/terrain/TerrainPageAtlas.ts` | live (`4-2`, `4-3`, extended `5-5`) |
| Terrain debug overlay — atlas residency plus macro flow/lakes/base-levels/fabric/erodibility | terrain-geometry | `src/render/webgpu/terrain/TerrainDebugOverlay.ts` | live (`4-3`, extended `5-3`) |
| Global height pyramid — the coarse field the occlusion bake marches beyond a page | terrain-geometry | `src/render/webgpu/terrain/GlobalHeightPyramid.ts` | live (`4-7`) |
| Page occlusion bake — sky visibility, bent normal, 8-azimuth horizon; and the land-cover splat bake | terrain-geometry | `src/render/webgpu/terrain/PageOcclusionBake.ts` | live (`4-7`, `4-6`) |
| CDLOD quadtree — node selection, morph, the node record, the one grid | terrain-geometry | `src/render/webgpu/terrain/TerrainQuadtree.ts` | live (`4-5`) |
| Land-cover classification — the sole authority for ground, tree species and wildlife habitat | terrain-material | `src/render/webgpu/terrain/LandCoverClassifier.ts` | live (`4-6`, `R-27`) |
| Vegetation density field (WGSL) — one shared include, never a copy | vegetation | `src/render/webgpu/detail/densityFieldWgsl.ts` | live (`4-6b`) |
| Bounded priority queue — the VEGETATION worker's queue | vegetation | `src/workers/boundedPriorityQueue.ts` | live (renamed from `terrainQueue.ts` at `4-4`) |
| Page-evolution reference producer — bounded operators, page builder, client, protocol and worker | terrain-geometry | `src/render/webgpu/terrain/TerrainErosionCompute.ts`, `src/render/webgpu/terrain/TerrainPageErosion.ts`, `src/render/webgpu/terrain/TerrainPageErosionClient.ts`, `src/workers/terrainErosionProtocol.ts`, `src/workers/terrainErosion.worker.ts` | live (`5-3`/`5-4`; CPU-worker reference) |
| Macro evolution producer and runtime — algorithm, client, protocol, worker and activation orchestration | terrain-geometry | `src/render/webgpu/terrain/TerrainMacroEvolution.ts`, `src/render/webgpu/terrain/TerrainMacroEvolutionClient.ts`, `src/render/webgpu/terrain/TerrainEvolutionRuntime.ts`, `src/workers/terrainMacroEvolutionProtocol.ts`, `src/workers/terrainMacroEvolutionRuntime.ts`, `src/workers/terrainMacroEvolution.worker.ts` | live (`5-3`; CPU-worker reference) |
| Per-page hydrology fields — flow, lake depth, soil depth and signed shore distance | terrain-geometry | `src/render/webgpu/terrain/TerrainPageHydrology.ts` | live (`5-5`) |
| Simulation terrain readback authority — L0 ring and macro fallback | simulation | `src/workers/terrainAuthority.ts` | live (`5-2`) |
| Rich terrain-sample authority adapter — evolved height/normal/slope for detail and wildlife | terrain-geometry | `src/render/webgpu/terrain/TerrainConsumerAuthority.ts` | live (`5-2` consumer closure) |
| Aerial-perspective WGSL include | lighting | `src/render/webgpu/atmosphere/AerialPerspective.ts` | live (`1C-4`) |
| Volumetric cloud shader modules — raymarch, temporal resolve, shadow | clouds | `src/render/webgpu/nature/CloudShaders.ts` | live (`2-0`) |
| Volcanic steam — vent wisps, one instanced draw lit by the cloud model | clouds | `src/render/webgpu/volcanic/VolcanicSteamSystem.ts` | live (volcanic phase 5) |
| Atmosphere GPU resources — transmittance LUT texture, sky-ambient LUT, blue noise, scene depth | lighting | `src/render/webgpu/atmosphere/AtmosphereGpuResources.ts` | live (`2-0a`) |
| Sky environment probe / IBL | lighting | `src/render/webgpu/atmosphere/SkyEnvironmentProbe.ts` | live (`1C-6`) |
| Celestial ephemeris — solar right ascension, moon position/phase/illuminance, the clock's Julian date | lighting | `src/render/webgpu/atmosphere/Ephemeris.ts` | live (`7-1`) |
| Star catalogue — every star drawn, the sidereal frame, star photometry | lighting | `src/render/webgpu/atmosphere/StarCatalogue.ts` | live (`7-3`) |
| Star field renderer | lighting | `src/render/webgpu/atmosphere/StarField.ts` | live (`7-3`) |
| Scotopic vision — rod/cone blend, Purkinje shift, acuity loss | lighting | `src/render/webgpu/atmosphere/ScotopicVision.ts` | live (`7-2`) |
| Quality tiers + governors | performance | `src/render/webgpu/core/QualityProfile.ts` (+ `AdaptiveGovernor.ts` `1A-6b`, `PerformanceBudget.ts` `1A-2`) | live |
| Surface material contract — the ten land-cover identities and their BRDF constants | terrain-material | `src/render/webgpu/terrain/surfaceMaterials.ts` | live (`3-0`; `4-6` inherits the enum) |
| Terrain material arrays — the ten synthesised layers, both `Texture2DArray`s | terrain-material | `src/render/webgpu/terrain/MaterialArraySynthesis.ts` (recipes, Class P) + `src/render/webgpu/terrain/MaterialArrayUpload.ts` (the GPU boundary) | live (`3-1`, split at `4.5-C2b`) |
| Terrain surface appearance — albedo, normal, roughness, AO, micro-detail, seasonal palette | terrain-material | `src/render/webgpu/terrain/TerrainSurfacePlugin.ts` | live (`3-2`; supersedes `TerrainMaterialPlugin`) |
| Runway surface painter — the analytic airport SDF, markings, rubber, ragged edge | terrain-material | `src/render/webgpu/terrain/RunwaySurface.ts` | live (`3-9`) |
| Runway earthworks profile | terrain-material | `src/render/webgpu/terrain/RunwayEarthworks.ts` | live (`3-8`; Class K — physics reads it too) |
| Vegetation density function, kilometre forest provinces and edge morphology | vegetation | `src/render/webgpu/detail/densityField.ts` | live (`1B-7`; Gate B `B-3`) |
| `MAX_TERRAIN_HEIGHT` (4,500 m) | terrain-geometry | `src/world/terrain.ts` | live (`5-A`) |
| Landform stage — the height stages after the natural kernel (natural → dunes → volcanic overlay → earthworks), the landform core, forced landforms (`WorldOptions.landforms`, `?landforms=`) and the sand cover they leave | terrain-geometry | `src/world/landforms.ts` (sand seas: `src/world/dunes.ts`) | live (sand seas, 2026-10-24; Class K — physics reads it too) |
| Landform stage (WGSL) — the transliteration of `landforms.ts`/`dunes.ts`, the `terrainLandformData` binding and its swappable source | terrain-geometry | `src/render/webgpu/terrain/TerrainLandformKernel.ts` | live (2026-10-24) |
| Channel-graph extractor | water | `src/render/webgpu/water/ChannelNetwork.ts` | live (`5-9`) |
| Bathymetry clipmap | water | `src/render/webgpu/water/BathymetryClipmap.ts` | live (`5-10`) |
| Rendered-density law — stems/ha bands, falloff, woody triangle budgets | vegetation | `src/render/webgpu/detail/renderedDensity.ts` | live (`R-21`) |
| CPU texture-array mip reducer (coverage/Toksvig kernels) | performance | `src/render/webgpu/core/TextureArrayMips.ts` | live (`2-11`; `3-1` reuses) |
| Compact 32-byte instance record + its vertex-stage decoder | vegetation | `src/render/webgpu/detail/instanceFormat.ts` (+ `DetailInstanceMaterialPlugin.ts`) | live (`2-11a`) |
| Stand field — dominant mix, stand age, tint centre as a continuous field | vegetation | `src/render/webgpu/detail/standField.ts` | live (`2-11b`) |
| Foliage atlas — all 16 card layers + the layer-index map | vegetation | `src/render/webgpu/detail/FoliageAtlas.ts` | live (`2-11`; first sampler `2-12`) |
| Shared water shading helpers — fresnel, GGX assemblies, reflected sky | water | `src/render/webgpu/water/WaterShaders.ts` | live (`2-8a`) |
| `detail.worker.ts` | vegetation | `src/workers/detail.worker.ts` | live (`1B-10`) |
| Aircraft form, materials and cockpit presentation | aircraft | `src/render/webgpu/aircraft/` | live (Gate `A-1`–`A-4`) |
Phase 0 added four more contracts under the same enforcement: the environment
clock (`src/world/environmentClock.ts`), the simulation terrain authority
(`src/sim/terrainGrid.ts`), the terrain collision mirror
(`src/render/webgpu/terrain/TerrainCollisionMirror.ts`), and the shared
receiver registry (`src/render/webgpu/core/SharedReceiverRegistry.ts`).

**The channel rule.** Every addition of a page channel goes through one PR
against `payload.ts`. No page-channel type is declared anywhere else.

**The tier rule.** Subsystems contribute *data fields* to
`WebGpuQualityProfile`; they do not branch on `profile.tier` with their own
constant tables. Three pre-Phase-0 readers are grandfathered in the boundary
test; the list only shrinks.

## 2. Page geometry — one number

- Base page extent: **512 m** (level `n` extent = `512 · 2ⁿ`)
- Gutter: **4 samples**, every page kind, extending *outside* the page
- Height core: **256** (stored edge 264)
- Every other channel core: **128** (stored edge 136)
- Core sample `(row, column)` lives at stored index
  `(row + gutter) · storedEdge + (column + gutter)`; the world coordinate of
  core sample `i` is `pageOrigin + i · texelSize`.

No 132², no 260², no 66². The same addressing convention serves Phase 1's tile
halo (`gutter = 1`) and Phase 4's atlas (`gutter = 4`).

## 3. The physics/render consistency invariant (§1.3)

**The surface the aircraft touches and the surface on screen are produced by
the same authority.** The default `worldEvolution: "analytic"` world uses the
historical pointwise kernel for both surfaces. The opt-in `"eroded"` world
(**shelved 2026-08-31 — flag-only, reachable solely via `?world=eroded`**;
§8 resolved NO) renders completed evolution pages and serves physics from the
fixed ladder **L0 readback → macro grid → analytic recovery**. A graphics tier
never changes that content choice.

> Corrected by `6-12`, 2026-08-31. This paragraph read "the default `"eroded"`
> world" and described analytic as the explicit opt-in — **the two were
> transposed**, and `DEFAULT_WORLD_EVOLUTION` has been `"analytic"` at
> `src/world/world.ts:33` throughout. It was false when written and became false
> a second way when eroded was shelved. It mattered more than an ordinary stale
> line because it sits in §3, the physics/render consistency invariant — the
> section describing the surface the aircraft collides with — in the document
> the boundary test treats as normative.

- Every physics terrain query routes through `src/sim/terrainGrid.ts`. The
  boundary test forbids direct collision-kernel imports anywhere else. The
  worker-side implementation is `src/workers/terrainAuthority.ts`: complete L0
  Catmull-Rom stencils win, the cell-centred macro grid is the deterministic
  fallback, and an incomplete L0 edge is never clamped into a false hit.
- The renderer publishes the macro grid once and transfers completed L0 page
  cores only after atlas upload and collision readback. Simulation owns the
  counters. `RenderDiagnostics.collisionSamplesServedByFallback` reports the
  worker's `analyticServed` count; it is not a render-side proxy counter.
- `TerrainConsumerAuthority.ts` is the only adapter from that height ladder to
  a rich `TerrainSample`. Detail and wildlife retain the analytic climate and
  material fields, but derive height, normal and slope from the evolved
  authority (and preserve authored airport earthworks exactly). Eroded-page
  hydrology is built before erosion scratch disposal, transferred with the
  final page, uploaded to all four heterogeneous channel resources, and only
  then atomically marked resident and published to this consumer authority.
- The invariant tests live in `tests/sim.terrain-authority.test.ts` and
  `tests/sim.terrain-authority-ladder.test.ts`: runway
  influence exactly 1.0 across the apron; ground clearance never negative over
  a real-terrain profile; render-path heights equal physics-path heights at L0
  (exact at f32 storage precision); the crash-recovery ring fully served by the
  active authority; and incomplete page stencils fall through legally.

> **Amended 2026-08-19 by `3-8`.** They no longer pass trivially. The runway
> earthworks gave the apron a 0.35 m camber, and `sampleTerrainCollision`'s
> runway branch returned before any height sampling — so the aircraft would
> have touched down on a plane up to 0.35 m from the surface on screen, worst
> at the edges where a crosswind landing puts you. The four tests above would
> **not** have caught it: they assert `getAirportInfluence == 1.0`, which stays
> true. The influence was fine; the height behind it was what changed.
>
> The fix is structural rather than local: the profile is a named function
> (`terrain/RunwayEarthworks.ts`) and BOTH authorities call it — the renderer
> through `sampleFilteredTerrainHeight`, physics through
> `sampleTerrainCollisionHeight`'s fast path, which still evaluates one
> analytic expression with no noise. Two invariants joined the suite:
>
> - **63** — collision height inside the apron equals the rendered earthworks
>   profile to within 1 mm, with a non-vacuity check that the camber is
>   actually being applied.
> - **64** — the 0.5 m `|natural − final|` contour is not a closed convex
>   curve, disproved constructively by two points inside whose midpoint is
>   outside. A convex contour means the profile is still a disc.
>
> The contact normal follows the camber too: a flat normal on a cambered
> surface is the same lie one derivative up.

### The sea (boats, 2026-10-26)

**A hull floats on the sea on screen.** The same rule holds one fluid over:
the water a boat's hull samples and the water the ocean draws are one
authority, the `sea-surface-authority` row in `owners.ts`.

- The spectrum is defined once, TypeScript and WGSL side by side
  (`src/sim/water/spectrum.ts`, `spectrumWgsl.ts`). The GPU ocean transforms
  it; the CPU `SeaTwin` (`src/sim/water/seaTwin.ts`) sums the same waves. Each
  wave's phase is keyed on the wave, never on the texel, so every quality tier
  draws the same waves in the bands it has. The twin carries bands 1-4
  (8-2048 m); the 0.5-8 m band is ripple a hull's displacement averages away.
  A tier that does not draw a band the twin floats on hands the presentation
  `SeaTwin.undrawnHeave` to make up the difference.
- Session inputs are shared: `resolveSeaSpectrumConfig(world, weather)` builds
  both, and a weather change rebuilds the GPU h0 and calls `SeaTwin.setConfig`
  at the same simulation time. The twin's clock is the worker's
  `state.simulationTime`; the ocean is evolved on the same time.
- Waves travel downwind and the surface gathers onto their crests. The
  evolution shader and the twin read the same two signs from `spectrum.ts`
  (`OCEAN_TIME_SIGN`, `OCEAN_CHOP_SIGN`), so the crest a hull rides is the
  crest drawn, moving the same way, with the foam on it.
- A marina basin calms the sea through one analytic field
  (`src/sim/water/shelter.ts`, at most 4 ellipses, exactly 1 outside them).
  The ocean's vertex stage multiplies its displacement by it and the twin
  multiplies its waves by the same packed numbers. There is no texture.
- No other module may sum, sample or approximate the sea for physics. A new
  vessel takes the twin through `HullWaterSampler`; a new rendered surface that
  must sit on the waves includes `OCEAN_SURFACE_DISPLACEMENT_WGSL`.
- The invariant tests: `tests/world.sea-twin.test.ts` (the twin equals an f64
  FFT of the spectrum within 0.1 mm, phases hold 1e-6 rad over an hour, the
  same waves under every tier profile, the shelter equals the shader's in f32,
  the sea travels downwind with its folds on the crests)
  and `tests/gpu/ocean-twin-parity.test.ts` (the shipping compute pipeline's
  displacement texture equals the twin within fp16, and the vertex stage's
  shelter WGSL equals the twin's).

## 4. Season and time of day (§1.6)

The rendering inputs are two continuous scalars — `EnvironmentClock
{ dayOfYear, solarTimeHours }` (`src/world/environmentClock.ts`) plus
`WorldDefinition.latitudeDegrees` (default 45°N). `TimeOfDayPreset` survives
only as a UI label; after `1C-1` the renderer never branches on it.

**The threading rule:** `dayOfYear` is part of every seasonal field function's
signature *from the moment it is first written* — the vegetation density field
(`1B-7`), the appearance field (`2-18`), the surface palette (`3-10`), the
land-cover classifier (`4-6`). The boundary test checks each of these files
for an environment-clock reference as it comes into existence.

**Amended 2026-08-19 (`3-10`).** The surface palette landed and left the
planned marker behind: `surfaceSeasonalResponse(spec, dayOfYear,
latitudeDegrees)` lives in `terrain/TerrainSurfacePlugin.ts` and the boundary
test now enforces the rule on it rather than deferring. It is **anchored**, the
way every `R-13` term is: the raw seasonal curve is divided by its own value at
`TERRAIN_REFERENCE_DAY_OF_YEAR`, so at the midsummer default clock the tint is
exactly (1, 1, 1), the roughness delta is exactly 0, and the shipped world is
untouched. The same anchoring governs the fragment snow blanket, which is
driven by the snowline's DESCENT below its reference altitude and therefore
contributes nothing at the reference day — the classifier already owns the
base snowline, and a second unanchored blanket at the same altitude drew
closed white iso-contours around every mountain in the first capture.

**Amended 2026-08-19 (Gate 7A).** The clock carries no YEAR, and the moon's
phase repeats every 29.53 days rather than every 365 — so `Ephemeris.ts`
anchors it to a named reference epoch (`EPHEMERIS_REFERENCE_JULIAN_DAY`,
2026-01-01). Moon phase is then a deterministic function of `dayOfYear`,
which is what `7-1` asks for, and a pinned capture clock produces a pinned
moon. Two solar models now exist by necessity: `EnvironmentDirector` keeps
owning the sun's rendered DIRECTION (the NOAA elevation/azimuth every
lighting consumer reads) and `Ephemeris` owns the equatorial position the
sidereal frame needs. They are held to agreement by test — declination within
0.4°, the low-precision series' own error — rather than by hope.

**Amended 2026-08-18 (`PRE_PHASE_4_REALIGNMENT.md` §4, `R-13`).** The rule had a
hole: the check is *syntactic*, and the one file that most needed the clock was not
in the family. `src/world/terrain.ts` carries `classifyBiome` — which decides snow
at `temperature < 0.2 || height > seaLevel + 1_520` — and §5 makes it the
source `4-1` transliterates into WGSL, so `4-6`'s seasonal classifier would have
been transliterated from a kernel with no clock: exactly the retrofit this rule
exists to prevent. **Landed per `R-13` (recorded 2026-08-19):**
`seasonalTemperatureOffsetK(dayOfYear, latitudeDegrees)` is a pure kernel function
in `src/world/terrain.ts`, and the file joined `SEASONAL_FIELD_FAMILY` in the same
commit — deliberately *without* threading the offset into
`sampleTerrainTemperature`/`classifyBiome`, which stay climatic (the `R-13`
decision-log row below: snow is appearance, not classification).
`EnvironmentDirector` fills `snowCoverage` from the same kernel; `surfaceWetness`
and `precipitation` remain deliberately 0 until a precipitation model owns them
(the R-16 recorded decision — nothing renders precipitation in Phases 2–5; the
`2-1` weather bake carries the channel for that future consumer).

## 5. Kernel portability (0-4)

`src/world/{seed,noise,terrain,geology}.ts` is simultaneously the physics
authority (until `5-2`) and the source `4-1` transliterates into WGSL:

- `unitFloatFromHash` returns a **24-bit** quotient — exactly representable in
  f32 on both sides.
- Every noise lattice is periodic with `NOISE_LATTICE_WRAP_PERIOD_CELLS`
  (2¹⁷ cells); coordinates are wrap-reduced in f64 before any floor. The wrap
  is an exact no-op within ±65,536 cells of the origin (≥ 2.8×10⁶ m at the
  finest octave).
- `pow` bases are explicitly `max(0, …)` so `4-1` is a transliteration.
- `filterWidthMeters` is a **required positional parameter** of
  `sampleNaturalTerrainHeight`, `sampleGeologicalRelief`,
  `sampleTerrainMoisture`, `sampleTerrainTemperature` — a behavioural no-op
  (`0` everywhere) until `1B-2` lands band-limiting. Collision keeps `0`
  forever.

## 6. Test environments (0-8)

Two Vitest projects: `vitest.config.ts` (Node — every pure assertion, runs in
seconds, part of `npm run verify`) and `vitest.gpu.config.ts`
(`npm run test:gpu` — headless Chromium via Playwright with
`--enable-unsafe-webgpu --use-angle=metal`, full-Chromium `channel:
"chromium"`; the headless shell has no GPU). GPU tests live in `tests/gpu/`
and are excluded from the Node project. Run `test:gpu` explicitly and at every
gate boundary.

Neither project is a portability oracle: both compile through whatever Tint
build ships with the local Chromium, and Tint accepts WGSL the specification
rejects. Where a construct is known to differ, assert it **statically over the
sources** in the Node project instead (assertion 51b is the standing example).

---

## 7. A test whose premise can drift must assert that premise (7-13)

**When a test is only meaningful because some condition holds, and that
condition could change without anyone touching the test, assert the condition
as a separate named assertion.** Word its failure to say *the premise died*,
not *the feature broke* — the two demand completely different responses and a
generic failure message sends the reader to the wrong one.

The failure it prevents is a test that **stays green while ceasing to test
anything**. This has now happened four times in one phase, in four unrelated
subsystems:

- the winding guard whose hand-written roster omitted `buildBladeRibbon`, so
  the live blades were in no test at all;
- `TERRAIN_SAMPLED_BINDINGS` hand-maintained against a shader nobody compared
  it to, stale in **both** directions;
- `foliage-material-compile` pinning an inter-stage peak of 16 while
  production compiled 15 — the instant `forceIrradianceInFragment`'s default
  flipped, the rig measured a permutation that no longer shipped;
- the windsock's crosswind validation seed, where runway heading and
  prevailing wind are the same hash expression called with *different* hashes,
  so the 85.9° separation at `hangar-a` is **seed-dependent, not structural**.
  A later change to seeding or the region catalogue turns it into a 5° seed,
  and the test passes while proving nothing.

Only the last was caught before shipping, and only because it was written
before the test rather than after the test failed. **That is the cheap moment;
there is no other one.**

Derive the roster from whatever enumerates the parts rather than listing it by
hand, and anchor on the compiled artifact rather than on a model of it — a
guard that *models* the thing stays green after the thing changes.

**A worked example — of getting this wrong.** `createWorld` takes its seed
**positionally**, and `hashSeed` iterates `text.length`. An object has no
`.length`, so the loop never runs and the function returns its untouched FNV
offset basis — meaning *every* object seed hashes to the **empty-string
constant**, not merely to each other:

    hashSeed({seed: "alpha"}) == hashSeed({seed: "beta"}) == hashSeed("") == 1947474976

This was measured, and then broadcast as a live hazard to five sessions —
"every seed-varying test silently measures one world". **It was not a live
hazard.** `WorldSeed = string | number`, so an object seed is `TS2345`,
`npm run typecheck` runs in CI on every PR, and no call site passes one. The
measurement had used an `as any` cast: **the probe switched off the guard that
prevents the bug, and then reported the bug as reachable.**

So the rule above applies to measurements as much as to tests. **Before
reporting what a probe found, state what a probe would find if the defect were
already prevented** — and check that your probe did not disable that
prevention to run at all. A cast, a mock, a relaxed config or a direct call
past a validator all create the condition they then discover.

The residue is genuine but small: types bind TypeScript callers only, so an
`as any`, a `.mts` script or a trusted worker payload still reaches the silent
constant. `normalizeSeed` throws on a non-string, non-number seed for that
reason, naming the empty-string collision in its message.

---

## 8. A guard that reads source must strip comments (7-10)

**Use `readSource` from `tests/support/sourceText.ts`. Reach for `rawSource`
only when the assertion is genuinely ABOUT the prose, and say so at the call
site.**

The reason is structural rather than stylistic, and it is why care does not
defend against it:

> **A comment that explains a defect necessarily NAMES it.** So the files most
> likely to be searched for a forbidden identifier are exactly the ones whose
> docblocks explain why it is forbidden — and a guard searching raw text finds
> the explanation and passes.

**Five instances in one evening, across three sessions, none found by review.**
Every one was found by running the control: mutate the thing the guard exists
to catch and watch whether it goes red.

- **The worst held an open decision.** A guard titled *"7-9: PCSS stays
  declined"* asserted `FILTER_PCF` appears in `QualityProfile.ts`, where it
  occurs **exactly once, inside a comment**. The shipped assignment is
  `AtmosphereSystem.ts`. Changing the filter left it green — a guard that could
  not see the only change it existed to catch. Repaired to read the file that
  makes the decision.
- **Two were in the repair for the first one.** A guard written to catch
  format-blind memory arithmetic asserted the function body matched `/format/`;
  a mutation renaming the parameter `unusedFormat` kept it green. Strengthened
  to require the format CONSTANTS by name — then a second mutation deleting a
  `TEXTURETYPE_SHORT` branch ALSO stayed green, because the comment above the
  branch explains the SHORT defect by name.
- **One was in the opposite direction**: a regex hunting a removed vacuous
  assertion matched the comment *explaining* the vacuity that had just been
  removed, and reported a repaired file as still broken.

**The related rule, for the same reason:** assert on CONSTANTS and expressions,
not on words. `Constants.TEXTUREFORMAT_R` cannot be satisfied by an identifier
called `unusedFormat`; `/format/` can. A channel count cannot be computed
without naming the format constants, which is what makes naming them the thing
that cannot be faked.

**And the check that finds these is cheap and mechanical:** a presence
assertion on a token that appears in the target's comments and NOT in its code
is a proof, not a suspicion. It cannot distinguish a deliberate prose anchor
from a defect — a human has to — but it reduces "41 files search raw text" to a
list short enough to read.

---

## Decision log

The dated log of decisions from August to October 2026 (about 180 KB) was
removed on 2026-11-14; the code and the sections above carry its results. Read
it with `git show afa81e6:docs/architecture/ARCHITECTURE.md`.
