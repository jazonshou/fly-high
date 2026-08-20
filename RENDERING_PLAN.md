# fly high Rendering Overhaul — Implementation Plan

**Status:** definitive. Supersedes the seven subsystem designs and the two reviews as the working reference.
**Basis:** `TERRAIN_AUDIT.md` (root-cause analysis, treated as established fact), seven subsystem designs (~105 work items), a feasibility review by a staff graphics engineer (binding corrections), and a coherence/sequencing review by a program lead (binding merges, cuts and ordering).
**Target hardware:** Apple M2 Pro MacBook Pro — 16-core GPU (~5.7 TFLOPS FP32), 10 CPU cores (6 performance + 4 efficiency), 16 GB unified memory, 3024×1964 display at DPR 2 (CSS ~1512×982 = 1.485 Mpx).
**Engine:** Babylon `@babylonjs/core` 9.21.2 on the WebGPU backend. No engine or API migration is proposed, considered, or permitted.

> **Amended 2026-08-18 by [`PRE_PHASE_4_REALIGNMENT.md`](PRE_PHASE_4_REALIGNMENT.md), which is binding over this file where they differ.**
> That review found one uncovered user goal (the aircraft's own appearance, §1 there), two shipped defects that are literally the performance bar (§2), a performance gate that measures idle time and compares images that are 20.5% black (§3), and a season that today is only the sun's declination (§4). Phases 4–7 below are still the pre-Phase-0 tables; §8 there lists what a Phase 4 plan must absorb before it is written. The corrected ledger is §9 there, not §0.3 here.
>
> **Amended 2026-08-19.** Phase 4 is now governed by [`PHASE_4_EXECUTION_PLAN.md`](PHASE_4_EXECUTION_PLAN.md) (46.5 d, binding); Gate 7A executed 2026-08-19. Only Phases 5–7 (less 7A) remain pre-Phase-0 tables.

---

## 0. What this plan does and does not do

### 0.1 What it does

It closes the twelve root causes in `TERRAIN_AUDIT.md §2` in an order chosen so that **every phase leaves the sim runnable and visibly better**, and so that the cheapest high-impact work lands first. It moves terrain generation, erosion, material synthesis, occlusion baking and vegetation scatter onto the GPU. It replaces a pointwise analytic height function with a landscape-evolution pipeline, so the terrain becomes the residue of a simulated process rather than a sum of noise. It gives the renderer a measurement harness and a budget contract so the next regression fails a test instead of being discovered by the user.

### 0.2 What it explicitly does not do

| Not doing | Why |
|---|---|
| Another engine or API migration | The audit is unambiguous: commit `5ef9a0f` changed the engine and produced zero pixels of improvement while deleting the detail texture, AO, SSR, temporal accumulation, MSAA and the budget system. `MaterialPluginBase` is nowhere near a ceiling — this codebase's own `CloudShadowMaterialPlugin.ts:148,:179` binds a texture through a plugin on the terrain material. |
| TAA | No depth or velocity infrastructure exists anywhere in `src/`. It ghosts on 400k vegetation instances with no per-instance motion vectors, and it fights the cloud system's existing temporal resolve. 4× MSAA is genuinely cheap on Apple TBDR (resolve-only bandwidth) and is the right answer here. −4 days, −29 MiB, −one unowned prepass. |
| Screen-space reflections on water | The sky environment cube covers ≥80% of every water reflection. SSR needs the same missing depth/velocity infrastructure. Deferred past this program. |
| Hex-tiling de-tiler | Three-scale rotated de-tiling plus non-repeating splat modulation already removes the repeat. −2 days. |
| ~~Weather/season material variants~~ | **Reinstated.** The user has since asked for selectable seasons and times of day. See §1.6 — now a first-class input threaded through the environment director, the land-cover classifier and vegetation, not a late material variant. **+7.0 days** for seasons and the environment clock, plus **+3.0 days** for flyable (unlit) night. |
| Precipitation, wind-driven rain, snowfall, lightning | Distinct from *seasons*. The three existing weather presets (`clear`/`breezy`/`cloudy`) keep working and drive coverage, turbidity and wind; no new precipitation simulation is in scope. |
| A cirrus ray-march layer | Wind shear (3 lines, real payoff) is kept and folded into cloud shape; the separate cirrus slab is deferred. −1 day. |
| A second shallow-water FFT cascade set | Shoaling and depth-limited breaking are kept; the extra cascade set is not. −1 day. |
| A CPU land-cover classifier, and a separate CPU→GPU classifier port | Write the classifier in WGSL once, keep a TypeScript mirror only as a test oracle. −7 days and avoids implementing something the plan later deletes. |
| A 6-worker terrain pool with a 75 MB LRU JS cache | The page atlas *is* the cache, and `vertex-displacement` deletes the worker path. Widening `activeRequestId` to a slot map is a 0.5-day change; that is all we build. −3.5 days and one architectural U-turn. |
| Houses, villages, cottages, barns, towers and dirt roads | Removed outright per user instruction (§3.5). |
| More noise octaves as a fix for realism | The composed spectrum was measured and is already a smooth monotone power law from 32 km to 32 m with no band gap. The problem is causal structure, not spectral energy. The one genuine hole is 8–43 m, addressed as a bounded item. |
| A new noise basis to remove "world grain" | Measured: the value-noise lattice is isotropic to 1.002:1 and its orientation bias collapses to ~1.3:1 in the composed field. The grain is `geology.ts:41-42`'s hard-coded 35° rotation (23.6:1). Replaced by a per-region tectonic fabric. |

### 0.3 Effort and calendar, stated honestly

**Total: ~278 effort-days across 7 phases.** For a solo developer at a realistic 4.5 productive days per week that is **~61 weeks, i.e. ~14 months**. At 5 d/wk it is ~12 months. This is after removing ~58 days of cross-design duplication and ~15 days of scope cuts, and after adding 8.5 days for seasons and the environment clock (§1.6) and 41.5 days for full night operations and airfield detail (Phase 7).

There is a defensible **v1 cut line after Phase 4 at ~156 days (≈ 8 months)**, at which point nine of the ten user goals are served and the tenth (terrain *shape* and river/lake *geometry*) is not. Phases 5–6 are the terrain-shape and water-body payload and are the reason the program is long. Do not attempt to reorder them earlier — §2.0 explains why.

> **Superseded 2026-08-18.** Both figures in the paragraph above are wrong and they contradict §2's own cut-line note ("Eight of nine user goals … ~147 days"). Neither counts Phase 0 (16.8 d), both use the stale 48.6 d Phase 1 figure, and the coverage claim is measured against a `G1`–`G10` list that is **not defined anywhere in this repository** — which is how §0.4's G-A gap survived three planning documents. The corrected total is **≈316 days** with a **≈199-day cut line**: see [`PRE_PHASE_4_REALIGNMENT.md`](PRE_PHASE_4_REALIGNMENT.md) §9.

The single most likely schedule slip is erosion parameter tuning. Budget 2× the stated days for Phase 5's erosion items; that risk is already reflected in the numbers below (the designs said 11 days for macro drainage plus page erosion; this plan carries 17 with a stated range of 15–25).

### 0.4 The goals this program is measured against

`G1`–`G10` are referenced throughout this file and defined nowhere. These three, in the user's own terms, are the coverage authority and supersede them. Every phase exit checklist certifies against these.

| | Goal | The test |
|---|---|---|
| **G-A** | **Genuine, realistic graphics** — clouds, water, *where water is placed*, mountains, terrain surface, trees, *where trees are placed*, all other foliage, **and what the plane looks like**. | Every named element has a costed item with exit criteria. Until 2026-08-18 the aircraft had none; Gate A closes it. |
| **G-B** | **Graphics align with season and time of day.** | Scrubbing the clock changes what the *world* looks like, not only where the sun is. Today it changes only the sun. |
| **G-C** | **Medium settings run with no flicker, no lag, no inconsistency on a MacBook Pro.** | A measured number at the reference viewport, asserted in CI. "Medium" is **tier 1** (`quality: medium` + `mode: balanced`). |

---

## 1. Architecture shift

### 1.1 Today vs after

| Concern | Today | After |
|---|---|---|
| Height authority | `sampleNaturalTerrainHeight(seedHash, x, z)` — a pure pointwise function (`src/world/terrain.ts:31, 93-102`), evaluated per vertex on one CPU worker (`src/world/tile.ts:151`) | A GPU-generated, GPU-eroded r32float **page atlas**. The analytic kernel becomes the *tectonic uplift input* to landscape evolution, not the terrain itself |
| Terrain geometry | 172 separate `Mesh` objects, 765,184 triangles, 20.71 MB of vertex/index buffers, rebuilt as you fly (`TerrainClipmapSystem.ts:528-530, 598-604`) | One shared 33×33 unit grid, thin-instanced 192–448 times through a CDLOD quadtree; height read in the vertex shader from the atlas. 1 draw call |
| LOD | A resolution lookup table on `(tier, level)` only (`TerrainClipmapSystem.ts:231-235`), no camera distance, no altitude, no geomorphing, 24 m skirts | Screen-space error against measured per-node deviation, with geomorphing that closes cracks analytically. Skirts deleted, `backFaceCulling = true` |
| Normals | A fixed 2 m analytic central difference at every LOD (`terrain.ts:18, 133-139`), 24–35° mean error at 128 m spacing | Central difference on the page's own texel grid, in the fragment shader, at the level's own spacing — automatically LOD-consistent and band-limited |
| Surface material | One `PBRMaterial` with no textures, `roughness = 0.93` uniformly, an 8-bit per-vertex colour from a threshold cascade (`TerrainClipmapSystem.ts:271-286`, `terrain.ts:217-226`) | Ten procedurally synthesised land-cover materials in two `Texture2DArray`s (albedo+height, normal+roughness+AO), height-blended by per-page splat weights from a continuous softmaxed classifier, triplanar on slopes, per-material BRDF |
| Atmosphere | `Scene.FOGMODE_EXP2` with one `Color3` (`AtmosphereSystem.ts:265-267`); water and clouds receive none of it | One shared analytic aerial-perspective WGSL include consumed by terrain, water, rivers, vegetation, aircraft, airport and the cloud composite, sharing the sky's own phase functions and LUTs |
| Indirect light | `scene.environmentTexture` never set; `environmentIntensity` is a dead uniform; one unshadowed `HemisphericLight` at 4.4% of the light budget | A physical-sky environment cube → SH irradiance + a 128 px specular probe. `HemisphericLight` retired in the same commit. Then baked per-page sky visibility, bent normals and horizon maps |
| Shadows | `CascadedShadowGenerator(4096, sun, true, camera)`, 4 cascades, 16 km, PCF, ~840 un-culled draws (`AtmosphereSystem.ts:196-209`) | Depth-only near-field CSM (3×1536, 1.8 km, PCSS) for aircraft/trees/rocks. Terrain-vs-terrain shadowing moves to the baked horizon map — one fetch, no cascade, no bias, works to the horizon |
| Rivers/lakes | A greedy 16-direction downhill walker at 90 m steps (`HydrologyGeneration.ts:317-400`) pasting flat blue ribbons on slopes that have no channel | Geometry built from the erosion pass's exported channel graph and lake mask, with carved beds, hydraulic-geometry widths, real confluences and deltas |
| Resolution control | One governor taking the **worst** p95 of frame-interval, CPU and GPU, lowering pixel count for CPU-bound frames (`QualityProfile.ts:164-175`, `FlightRenderer.ts:903-937`) | Governor A (GPU p95 only, anti-ratchet, absolute pixel cap) and Governor B (CPU p95, an ordered ladder of CPU-work levers). The HUD says which fired |
| Measurement | None. `FrameGraph.passTimings` is computed and thrown away (`FrameGraph.ts:127-132`) | Per-pass attribution, a budget contract asserted in CI, and a fixed-seed screenshot harness |

### 1.2 What moves to the GPU

Nine workloads, all following the pattern `SpectralOceanSystem.ts` already proves on this stack (`createCompute` at `:459-470`, storage textures at `:430-452`, explicit `bindingsMapping`, 8×8 workgroups, `fastMode = true` after a compile barrier at `:718`):

height generation, landscape evolution (depression fill / flow accumulation / stream power / talus), horizon-and-sky-visibility baking, land-cover classification and splat rasterisation, material texture synthesis, atmosphere LUTs, cloud noise volumes, vegetation scatter and cull, ocean slope derivation and mipping.

Today the only file in `src/render/` containing `ComputeShader` or `dispatch(` is `SpectralOceanSystem.ts`. The 16-core M2 Pro GPU idles while one JS thread grinds integer hashes: 181 `valueNoise2D` calls and 1,026 lattice hashes per vertex, 40.6 ms per 65²-resolution page, on one core with nine idle. See §6 for the full inventory.

### 1.3 How render and physics stay consistent

**This is the one thing in the plan that is game-breaking if we get it wrong, so it gets its own contract.**

The invariant, stated once and enforced by tests: **the surface the aircraft touches and the surface on screen are produced by the same authority.**

Today they agree by construction — `simulation.worker.ts:79,83` and `spawn.ts:85,92,128` call `sampleTerrainCollision`/`sampleTerrainCollisionHeight` (`terrain.ts:113-125, 161-183`), and the render path calls the same kernel through `tile.ts`. The plan preserves that agreement at every phase boundary:

**Phases 1–3 — safe by arithmetic.** `bandlimit-reference` threads a `filterWidthMeters` through the kernel and cuts octaves shorter than `2 × filterWidth`. The finest wavelength anywhere in the kernel is 43 m (`geology.ts:30-34`). L0 has 8 m spacing and L1 has 16 m, so the cutoff is a **no-op at L0 and L1**; divergence begins only at L2 (32 m spacing). Physics only matters within metres of the ground, which is always inside L0. Collision keeps `filterWidth = 0` (full kernel). *Test:* assert `sampleTerrainHeight(x, z, 0) === sampleTerrainHeight(x, z, 8)` to within 1 mm over 4096 sampled points.

**Phase 4 — safe by parity.** The GPU becomes the height authority, but `wgsl-kernel` is a bit-exact port, so the CPU analytic path remains a valid oracle. This requires two corrections, both binding:
- `unitFloatFromHash` (`seed.ts:56-58`) is `(hash >>> 0) * (1/2^32)` computed in f64; f32 cannot reproduce it above 2²⁴. Change **both** sides to `f32(hash >> 8u) * (1.0 / 16777216.0)`. 24 bits is 16× more than a noise lattice needs and is now bit-identical across languages.
- The kernel divides raw world coordinates by small constants (`/43`, `/105`, `/850`). At |x| = 5×10⁶ m, f32 spacing is ~1.6×10⁻² of a lattice cell, so CPU (f64) and GPU (f32) will disagree about which cell a boundary point falls in and the noise jumps. **Add a per-octave domain wrap** — subtract an integer multiple of the lattice period, computed in f64 on the CPU and passed in the page-origin uniform — before any `floor`/`fract` in WGSL. Without this, a parity test sampled near the origin passes and the sim breaks at 500 km.

Consequence, and it saves 4 days on the critical path: **`collision-readback` is not needed in Phase 4.** Ship `vertex-displacement` without it. Between Phase 4 and Phase 5 the GPU height *is* the analytic kernel and the CPU path agrees exactly.

**Phase 5 — the readback contract.** Erosion breaks parity permanently, so collision must read the eroded grid.

1. After an L0 page's erosion completes, `heightAtlas.readPixels(0, 0, buffer, false, true, slotX+gutter, slotY+gutter, 256, 256)` into a pooled `Float32Array(65536)` (256 KiB). Verify `COPY_SRC` usage is present on the storage texture before depending on this; the fallback is a compute copy into a `StorageBuffer` and `StorageBuffer.read()`.
2. `postMessage({type:'terrainPage', level:0, tileX, tileZ, heights}, [heights.buffer])` to the simulation worker. `next.config.ts` sets no COOP/COEP so `SharedArrayBuffer` is unavailable; transferables at ~1–2 per second in cruise are genuinely fine.
3. The worker keeps a `Map` of at most 25 pages (a 5×5 ring) and samples with **Catmull-Rom bicubic**. Bilinear on a 2 m grid produces C0 kinks that a landing-gear model reads as bumps.
4. **Fallback authority:** the eroded level-6 macro grid (128 m/texel, 512², 1 MiB) is transferred to the worker once at world load. This matters specifically for `crashRecoverySurfaceHeight` (`spawn.ts:78-100`), which samples a *ring of radii* around an arbitrary crash point at recovery time and is routinely outside the 5×5 L0 ring. Without it, a crash recovery can place the aircraft below visible terrain.
5. **Runway invariant:** `sampleTerrainCollisionHeight` short-circuits when `getAirportInfluence >= 1` (`terrain.ts:118-125`) and `sampleTerrainCollision` returns before any height sampling on the runway branch (`:163-172`). The new earthworks profile **must keep influence exactly 1.0 inside the apron**. This is a test, not a note.
6. **Determinism guard:** `vitest.config.ts` sets `environment: "node"`, so after this lands `tests/sim.flight.test.ts` would silently exercise the analytic fallback — a *different* landscape from the rendered one — and the only regression guard on physics/render agreement would evaporate. Require both a **"collision samples served by fallback" counter** (any non-zero value below 500 m AGL is a bug, surfaced in the HUD) **and** a headless parity harness before merging.

**Named owner of the invariant:** `src/render/webgpu/terrain/TerrainCollisionMirror.ts` + `src/sim/terrainGrid.ts`. The analytic CPU kernel survives only as (a) the uplift field consumed by the GPU and (b) the above-500 m-AGL fallback.

### 1.4 Single owners — decided, not open

Review found five files claimed as `newFiles` by two or three designs and four incompatible page geometries. Resolved:

| Artefact | Owner | Decision |
|---|---|---|
| `src/render/webgpu/world/payload.ts` | terrain-geometry | Already specifies the correct architecture (`QuantizedHeightPage`, `QuantizedMaterialPage`, `QuantizedSurfacePage`, `WorldPageLifecycle`, `calculateWorldPageStreamingPriority`) and is dead code imported only by two tests. Make the renderer consume it. Every channel addition goes through one PR against this file. |
| `TerrainPageAtlas.ts` | terrain-geometry | One height atlas (r32float) + a family of channel atlases. Terrain-material consumes, does not create. |
| **Page geometry — one number** | terrain-geometry | **Height: 256 core + 4 gutter = 264².** **All other channels: 128 core + 4 gutter = 136².** Gutter is 4 everywhere. No 132², no 260², no 66². |
| `TerrainErosionCompute.ts` | terrain-geometry | |
| Aerial-perspective include | lighting/atmosphere | `AerialPerspective.ts`. Water, clouds, vegetation, aircraft, airport all consume. Nobody re-derives. |
| Sky env cube / IBL | lighting/atmosphere | `SkyEnvironmentProbe.ts` → `scene.environmentTexture`. Water consumes it in ~0.5 d. |
| Quality-tier table + governors | performance | `QualityProfile.ts` + `AdaptiveGovernor.ts` + `PerformanceBudget.ts`. Every other subsystem contributes **rows of data**, not work items. |
| Runway earthworks profile | terrain-material | Owns materials, markings, wear and the earthworks profile. Terrain-geometry contributes the erosion exclusion mask only. |
| Vegetation density function | vegetation | `densityField.ts`. Terrain-material *reads* it for the canopy splat channel; it does not reimplement it. |
| `MAX_TERRAIN_HEIGHT` | terrain-geometry | Stays 2,200 m until Phase 5. Rises to 4,500 m with `tectonic-skeleton`, in the same commit that churns the screenshot baselines. |
| Channel-graph extractor (previously unowned, on the critical path) | water | `ChannelNetwork.ts`, 2 days, Phase 5. |
| `src/workers/detail.worker.ts` | vegetation | |

### 1.5 Resolved user decisions

**The airport hangars — kept and expanded.** They were the only structures surviving `remove-buildings`, and the only scale reference on final approach. Decision: keep them *and* give them real detail. Today they are three `CreateBox` calls at 46×14–18×34 m sharing one flat metal material (`AirportSystem.ts:72-83`) — genuine placeholder boxes. **Phase 7 Gate 7D** replaces them with a parametric generator (roof profiles, ribbed cladding, sliding doors, vents, gutters, interiors) plus airfield furniture — windsock, fuel tanks, fence, signage, GSE. `AirportSystemOptions.includeHangars` is dropped; hangars are no longer optional. `remove-buildings` (`1B-5`) still deletes the procedural village houses and never touched `AirportSystem.ts`.

**Night — full night operations.** See §1.6 and Phase 7.

### 1.6 Season and time of day

**Requirement:** the user must be able to select between different seasons and times of day.

**The governing decision: two continuous scalars, not presets.** Today `TimeOfDayPreset = "dawn" | "day" | "golden"` (`src/game/types.ts:14`) selects one of three hardcoded colour sets in `presetFor()` (`AtmosphereSystem.ts:93-125`). That enum is the trap — every added state multiplies the hand-tuned constants, and there is no way to sit *between* two of them. Phase 1 deletes `presetFor()` anyway (item `1C-1`), so the replacement is:

```ts
interface EnvironmentClock {
  dayOfYear: number;      // [0, 365) — drives solar declination and the biosphere
  solarTimeHours: number; // [0, 24)  — drives hour angle
}
// World-level, set at generation:
interface WorldDefinition { latitudeDegrees: number; /* … */ }
```

The existing named presets survive **as UI sugar only** — "Dawn", "Golden hour", "Midsummer", "Late autumn" are buttons that write these two scalars. The renderer never branches on a name. `TimeOfDayPreset` stays in `src/settings` as a preset *label*; it stops being a rendering input.

**Why this is cheap here and expensive later.** Item `1C-1` already specifies solar position "from a NOAA formula". That formula's inputs are latitude, longitude, day-of-year and time — **seasonal sun path is already in its signature.** Declination swings ±23.44°, which changes maximum sun elevation, day length, sunrise/sunset azimuth and the length and direction of every shadow. Taking `dayOfYear` at `1C-1` costs ~0.5 day. Retrofitting it after Phase 4 means re-threading a uniform through the WGSL include chain, its TypeScript mirror, the classifier signature and the page-atlas cache key — several days and a churned screenshot baseline.

**The threading rule, which is the whole point of writing this down now:**

> `dayOfYear` is a parameter of the land-cover classifier's signature from the moment the classifier is first written (Phase 4, item `4-6`), not an addition to it. Same for the vegetation density and appearance fields (`1B-7`, `2-18`) and the surface plugin's palette (`3-10`).

**What actually responds to season** — four systems, deliberately bounded:

| System | Seasonal response | Item | Days |
|---|---|---|---|
| Sun and sky | Declination → elevation, day length, shadow direction/length, twilight duration. Falls out of the NOAA formula. | `1C-1` | +0.5 |
| Vegetation | Deciduous species tint and shed (crown alpha and colour on a leaf-out/leaf-fall curve); conifers hold. Winter adds slope-weighted snow on canopy and rock. Species *mix* is climatic and does **not** change with season. | `2-18` | 2.0 |
| Ground cover | Grass and shrub albedo/roughness ride a spring-green → summer → autumn-gold → dormant-brown curve; spring adds wetness darkening. A **palette modulation of existing splat weights**, not new texture arrays. | `3-10` | 2.0 |
| Snowline | Snow suitability shifts with a seasonal temperature lapse, so the snowline migrates down in winter and retreats to peaks in summer. Not a binary — one more term in the softmax, with the same jitter that keeps the treeline ragged. Plus the season-bucket cache key below. | `4-6` | +1.0 |

**Total: 5.5 days for seasons**, plus `1C-9` (1.5 d) for the clock and UI that time-of-day needs regardless — **7.0 days**. Night is costed separately below.

**Explicitly not responding:** terrain geometry (erosion runs on geological time, not annual), river courses, lake extents, and the FFT ocean spectrum. Lake and river *ice* is deferred — it needs a separate material and a frozen-surface physics answer, and the user did not ask for it.

**Cache-key consequence, decided now.** Splat pages baked in Phase 4 become a function of `dayOfYear`. The atlas keys on a quantised season bucket (24 buckets ≈ 15-day resolution) and the existing `WorldPageLifecycle` epoch invalidates on bucket change. Continuous scrubbing then cross-fades between two adjacent buckets in the shader rather than re-baking every frame. This costs one extra channel-atlas slot and must be designed into `TerrainPageAtlas.ts` in Phase 4 — it is roughly free there and a re-architecture afterwards.

**Night — decided: full night operations.** Making time of day continuous means night exists, and the user has chosen the complete version: moon, stars, aircraft lighting, runway and hangar lighting. This is a substantial body of work and it gets its own phase (**Phase 7**, §2, 41.5 days). Phase 1 carries only `1C-10 night-sky-basic` (1.5 d) so that scrubbing into the small hours during Phases 1–6 looks *unfinished* rather than *broken*.

**The finding that makes this affordable.** My earlier estimate assumed this stack had no path to many simultaneous lights. It does. Babylon 9.21.2 ships `Lights/Clustered/clusteredLightContainer.pure.ts` — a forward+ / clustered light system that extends `Light`, so it plugs into the **existing** PBR forward path with no deferred-rendering rewrite, no G-buffer, and no conflict with MSAA. On WebGPU it clusters via atomic writes into storage buffers (`:43-44`), with configurable `horizontalTiles`/`verticalTiles` and depth slices, and `ClusteredLightContainer.IsLightSupported()` gates point and spot lights. Babylon also ships `Lights/IES/iesLoader.ts` for real photometric profiles — which is precisely what airfield lighting demands, because a PAPI is *defined* by its vertical angular cutoffs and runway edge lights are sharply directional.

**The architectural split that keeps it cheap.** A full airfield is 150–300 light sources, and clustering all of them as illuminating lights would be wasteful. Separate the two roles:

| Role | Examples | Implementation | Count |
|---|---|---|---|
| **Lights you *see*** | Runway edge, threshold, centreline, TDZ, PAPI, approach system, taxiway edge, aircraft nav/strobe/beacon, obstruction lights | Instanced emissive billboards with HDR intensity, IES-driven directional visibility, atmospheric extinction and bloom coupling. They illuminate **nothing**. | 150–300, one draw |
| **Lights that *illuminate*** | Landing and taxi lights, hangar and apron floods, interior spill through open doors | Real clustered spot/point lights through `ClusteredLightContainer` | 4–20 active |

Nearly every light on an airfield is in the first category — you look *at* it, it does not meaningfully light the ground. Getting this split right is the difference between night costing ~40 days and being infeasible.

---

## 2. Phases

### 2.0 Why this order

The audit's highest-value item — landscape evolution, which "does more for realism than everything else on this list combined" — sits behind nine serial predecessors, most of which produce no visible change. The critical path to carved rivers is ~52 strictly serial days even after all duplication is removed. There is no parallelism for a solo developer to exploit.

Two consequences drive the ordering:

1. **The cheap wins go first and they are genuinely dramatic.** Phase 1 closes audit root causes #3 (normals), #4 (band-limiting), #5 (aerial perspective), #6 (indirect light), #10 (CPU parallelism), #11 (governor ratchet) and #12 (FOV) — seven of twelve — and fixes the cloud bug. It is 44 days and it will not look like 44 days of work; it will look like a different renderer.
2. **Clouds and vegetation come before the terrain rebuild, deliberately.** They serve user goals G3 and G4, they are cheap relative to their goal coverage, and they are the only substantial visible work that does not depend on the 35-day terrain chain. Putting them after would leave five months of staring at playdough cones and popcorn clouds.

Each phase below has internal gates. **A gate is a shippable commit.** No gate leaves the sim worse.

---

### Phase 1 — Foundation, correctness and the atmosphere spine

**Goal.** Make the renderer measurable, stop it silently degrading, fix the two complaints the user named specifically, and close the four audit root causes that cost the least per unit of realism.

**What you will see.** Clouds stay in the sky. The picture stops going soft on its own. Distant mountains catch light along their actual ridges instead of a phantom 2 m surface, and the horizon stops crawling. A 3,000 m ridge 20 km out finally sits 20 km out. Shadowed and north-facing slopes hold cool blue skylight instead of crushing toward black; at golden hour a ridge splits warm on the sun side and cool on the shade side. Edges stop shimmering. No villages. No trees on the runway. The 176 m tree lattice is gone. Terrain arrives with the aircraft instead of seconds behind it.

#### Gate 1A — Truth and guardrails (10.3 d)

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 1A-1 | `perf-harness` — expose `FrameGraph.passTimings` through `RenderDiagnostics`; budget-probe GPU attribution via `FrameGraphPass.enabled`; `npm run perf:capture` screenshot baselines | 3.0 | — | `FrameGraph.ts:29-30, 97, 112, 127-132` already has cadence, `enabled` and timings. Nothing consumes them. |
| 1A-2 | `frame-budget-contract` — `PerformanceBudget.ts`: per-tier `FRAME_BUDGET_MS`, `estimateGpuMemoryMiB()`, `MEMORY_CEILING_MIB`, `assertWithinBudget()` | 2.0 | — | Fails `npm test` on overspend. |
| 1A-3 | `webgpu-test-harness` — decide and wire the WebGPU-capable test environment | 1.0 | — | `vitest.config.ts` is `environment: "node"`; every WGSL parity/compile test across all seven designs has no adapter today. Playwright + Chromium `--enable-unsafe-webgpu --use-angle=metal`, or a documented manual verify page. **Decide before any Phase 4 work.** |
| 1A-4 | **Cloud bug**: `verify-flip` → `fix-temporal-flip` → `fix-double-blend` → `getViewMatrix(true)` | 0.8 | — | See §4. Highest value-per-hour item in the program. |
| 1A-5 | `csm-memory` — depth-only shadow RTT | 0.5 | — | See §5.4. **No distance change** — that is gated on horizon maps. |
| 1A-6 | `split-governor` + absolute pixel cap + DPR clamp | 2.0 | 1A-2 | See §5.5. `FlightRenderer.ts:903-906` multiplies by DPR instead of capping. |
| 1A-7 | **Vertex-plugin spike** — `MaterialPluginBase` vertex stage + `ShadowDepthWrapper` | 1.0 | — | Two later architectures rest on this. See §7 R1. Do it on day one. |

**Exit criteria.** `npm test` fails on a budget overspend. `npm run perf:capture` produces three committed baselines. The HUD reports `activeGovernor`, `gpuP95Ms`, `cpuP95Ms`, `renderPixels`. Rolling the aircraft rolls the clouds in the correct direction. The default render target is 1.5 Mpx, not 5.94 Mpx.
**Demo state.** *"Clouds stay put, and the picture stopped getting blurry."* Default per-pixel cost drops ~4× from the pixel cap alone.

#### Gate 1B — Cheap correctness on the existing architecture (16.8 d)

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 1B-1 | `normals-from-grid` — halo=1, central-difference the tile's own grid, delete the 4 extra kernel calls, `includeClimate: false` | 1.5 | — | 40.6 ms → ~8 ms per page. Recompute `slope` for classification from the same grid normal. |
| 1B-2 | `bandlimit-reference` — spacing-aware octave cutoff with a smoothstep fade | 2.5 | 1B-1 | **Careful:** `fbm2D` normalises by `amplitudeSum`; divide by the *untruncated* sum or coarse terrain gets systematically taller. |
| 1B-3 | `lod-ladder-and-altitude` — constant 65 for tiers 1–2 (33 at tier 0), add `y` to `TerrainObserver`, 3D distance in priority | 0.5 | — | Interim, deleted by CDLOD. Worth it because it makes the sim shippable through Phases 1–4. Kills the 4:1 T-junction at `TerrainClipmapSystem.ts:231-235`. |
| 1B-4 | Terrain worker slot map — widen `activeRequestId` to `Map<workerIndex, requestId>`, `clamp(2, hardwareConcurrency − 4, 6)` workers | 0.5 | — | 6 on this machine. **No LRU cache** — the page atlas is the cache. |
| 1B-5 | `remove-buildings` | 0.5 | — | Delete outright, do not flag; `git` restores it. Grep verified: exactly `detail/{index,types,generation,WorldDetailRuntime}.ts` + two tests. `AirportSystem.ts` is untouched. |
| 1B-6 | `detail-exclusion-mask` — airport / water / clearance, multiplicative not boolean | 0.75 | 1B-5 | Fixes a live bug: nothing in `detail/` reads `airportInfluence`, so trees grow across the graded apron. Airfields are *mown grass* — suppress trees and rocks, cap grass height at ~0.15 m, do not suppress grass. |
| 1B-7 | `placement-density-field` — continuous density from lapse-rate elevation, moisture, slope, **aspect**, ragged treeline, glade/disturbance fields | 2.5 | 1B-6 | HUD readout of stems/ha; tune to 300–800 closed forest, 20–80 open woodland, 0–5 above treeline. |
| 1B-8 | `grid-regression-test` | 0.5 | 1B-7 | **Land before `blue-noise-scatter`, not after.** |
| 1B-9 | `blue-noise-scatter` — density-adaptive jitter cell `clamp(sqrt(1/density), 3, 90)` m + domain warp + O(n) rank thinning | 2.0 | 1B-8 | The measured 176 m lattice is ~20× a crown diameter, hence glaring. A 3–8 m period in closed forest is under 1× a crown diameter, hence physically hidden. |
| 1B-10 | `detail-worker-offload` | 1.5 | 1B-9 | Removes the measured 3.09 ms/cell from the main thread — the single largest contributor to the CPU p95 that drove the ratchet. |
| 1B-11 | `msaa` + FOV fix | 1.5 | 1A-5 | `antialias: true`; MSAA requested on the first post-process (`toneMap.samples`) because the hand-built chain at `FlightRenderer.ts:446-465` forces an offscreen target. FXAA only when `msaaSamples === 1`. FOV: `FOVMODE_HORIZONTAL_FIXED` at ~62° — change the constructor (`:351`), `chaseCameraProfile` (`:139`) *and* the cockpit fallback (`:771`, currently 72° — cockpit must be **narrower** than chase). Also `enableSpecularAntiAliasing = true` and `anisotropicFilteringLevel = 16` (both absent repo-wide). |
| 1B-12 | `basis-reprojection` — camera-relative ray basis, not a cached view-projection matrix | 1.5 | 1A-4 | The delta camera must be computed from **absolute world positions** across the floating-origin rebase, not `camera.position`, which jumps 4096 m at `FlightRenderer.ts:869-870`. |
| 1B-13 | `ocean-fft-halfprecision` — rgba32float → rgba16float ping-pong | 1.0 | — | **Split the normalisation per axis** (fold `1/N` into the last stage of each axis). Moving the full `1/(N·N)` to the first pass makes intermediates 1.5e-6…1.5e-4 — straddling fp16's smallest normal, 6.1e-5 — and you lose the small waves. Test both an upper bound (<60000) and a lower bound (>1e-3). |

**Exit criteria.** Page generation ≤ 9 ms at res 65. Band-limit acceptance test: RMS error vs a 12×12 box average < 0.25 × spacing at 32/64/128/256/512 m (today: 3.05/7.11/16.10/35.44/60.23 m). Scatter spectrum test passes. Zero building prototypes registered over a 100 km² scan. Main-thread detail generation ≤ 0.3 ms/frame.
**Demo state.** *"The horizon stopped crawling, the forest looks like a forest, and there are no cottages."*

#### Gate 1C — The atmosphere spine (18.0 d)

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 1C-1 | `env-director` — one continuous `EnvironmentState`; solar position from a NOAA formula **taking `dayOfYear` + `latitudeDegrees`**; turbidity expressed once | 2.5 | — | `EnvironmentState.ts:88-101` already carries Rayleigh/Mie/ozone coefficients, 120,000 lux and a 0.004675 rad sun radius as **dead code** referenced only by a test. Make it the single source of truth; delete `presetFor()`. The NOAA formula already needs day-of-year — take it now (§1.6). +0.5 d over the pre-season estimate. |
| 1C-2 | `single-exposure` — one relative-EV100 | 1.5 | 1C-1 | Verified triple exposure: `AtmosphereSystem.ts:73` + `FlightRenderer.ts:443` + `SpectralOceanSystem.ts:967-968`/`HydrologySystem.ts:676-677` + `VolumetricCloudSystem.ts:878`. Use `exposure = 1.08 × 2^(EV100_ref − EV100)` so today's day+clear look is preserved exactly. Replace the magic `/5.2` normalisers with a named `sunIlluminanceNormalized`. |
| 1C-3 | `atmosphere-luts` — transmittance 256×64 and multiple-scattering 32×32, rgba16f, on env change only | 2.0 | 1C-1 | Bruneton/Hillaire. Plus a TypeScript mirror `evaluateTransmittance()` with a 1% agreement test — the CPU path is needed by exposure and by the IBL spherical harmonics. 138 KiB total. |
| 1C-4 | **`aerial-include`** — the shared analytic aerial-perspective WGSL include | 5.0 | 1C-2, 1C-3 | See §3.6. The single biggest change in the plan. |
| 1C-5 | `physical-sky` — `skyRadiance()` from the same include, plus a real sun disc with limb darkening | 2.0 | 1C-4 | Terrain haze and sky then agree **by construction** — they are literally the same integral. |
| 1C-6 | `ibl` — SH irradiance + a 128 px specular cube → `scene.environmentTexture`; retire `HemisphericLight`; `specularIntensity` 0.22 → 1.0 everywhere | 3.0 | 1C-5 | See §3.6. `specularIntensity` lives in three files (`TerrainClipmapSystem.ts:280`, `WorldDetailRuntime.ts:1107`, `AirportSystem.ts:111`) and they **must move together**. |
| 1C-7 | Water consumes AP + earth curvature; ocean radius 120 km → 40 km | 1.0 | 1C-4 | `displaced.y -= dot(localXZ, localXZ) / (2 × 6371000)` before the world transform. Without curvature the flat disk's vanishing line sits at eye level. **Reconcile with `camera.maxZ` = 45 km** — a 60 km disk inside a 45 km far plane is clipped and the horizon vanishes. |
| 1C-8 | Clouds `radiometry-and-haze` | 1.5 | 1C-4 | |
| 1C-9 | `environment-clock` — `EnvironmentClock` scalars, `WorldDefinition.latitudeDegrees`, settings plumbing, and the UI: two continuous sliders plus named preset buttons that write them | 1.5 | 1C-1 | §1.6. `SettingsPanel.tsx:407-422` already has the Time-of-day and Weather selects — the selects become preset *buttons* over sliders. `TimeOfDayPreset` survives as a label, not a rendering input. |
| 1C-10 | `night-sky-basic` — sun below horizon handled without breaking, twilight-through-night exposure range, placeholder moon disc and star dome | 1.5 | 1C-5, 1C-9 | **Deliberately minimal.** Full night is Phase 7. This item exists only so that scrubbing the clock past dusk during Phases 1–6 looks unfinished rather than broken. Do not gold-plate it — Phase 7 replaces the moon and stars outright. |

**Exit criteria.** `scene.environmentTexture` is non-null; `REFLECTION` is defined on the terrain effect. Startup assertion: `imageProcessingConfiguration.applyByPostProcess === true` (the PBR hook's correctness depends on it) and `scene.fogMode === FOGMODE_NONE` (otherwise fog and AP both apply). No shader source in `src/` contains an exposure multiply. `camera.maxZ` = 45,000; `terrainRings` reduced by one per tier. Aerial-perspective opacity at the outermost ring ≥ 95%.
**Demo state.** *"Distance reads as distance — and I can scrub the time of day and the season, and the sun moves correctly for both."* Audit root causes #5 and #6 both closed.

**Phase 1 total: 48.6 days.** (45.1 before seasons; +0.5 on `1C-1`, +1.5 `1C-9`, +1.5 `1C-10`.)

> **Superseded 2026-08-19.** Phase 1 shipped at **43.0 d** (2026-08-17).

---

### Phase 2 — Sky, sea surface and living ground

**Goal.** Deliver user goals G3 (clouds), G4 (vegetation) and the *surface* half of G2 (ocean) — the substantial visible work that does not depend on the terrain chain.

**What you will see.** Cumulus with flat bases, cauliflower tops and ragged translucent edges; genuinely varied sizes and opacities; no repeat over a 200 km leg; interior depth, a real silver lining, and shaded sides that hold blue skylight. Individual cloud shadows with recognisable shapes sweep across the ground. The distant sea stops boiling and becomes smooth, matte and correctly hazed; sun glitter concentrates into one coherent moving path; wave crests glow translucent teal when backlit. Trees have leaves; silhouettes break up against the sky; backlit crowns glow. Grass returns. Rocks have varied silhouettes and sit tilted into the slope. Forest extends to the horizon.

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 2-1 | `noise-bake` — tileable 3D Perlin-Worley, detail and curl volumes on the GPU at startup | 2.0 | — | Ship 3D storage textures; Babylon's WGSL processor maps 3D texture functions and 3D storage textures are WebGPU core. Replaces ~80 ALU hash ops per density sample with 1–2 fetches: 3–6× cheaper per sample. |
| 2-2 | `cloud-shape` + wind shear — weather map, cloud-type vertical profiles, coverage remap, detail erosion | 2.5 | 2-1 | |
| 2-3 | `anti-tiling` — toroidal weather clipmap + dual-scale shape sampling | 1.5 | 2-2 | |
| 2-4 | `cloud-lighting` — multiple-scattering octaves, directional powder, dual-lobe HG with silver lining | 2.0 | 2-2 | The largest single "not plastic" change in the cloud subsystem. Fix the phase/MS constants from the literature first; tune only `densityMultiplier` and extinction. |
| 2-5 | `adaptive-march` — distance-adaptive step, empty-space skipping, low-res coverage prepass | 2.0 | 2-3, 2-4 | Target 2–4× fewer density samples at equal quality. |
| 2-6 | `cloud-budget-tiers` — absolute cloud pixel cap | 1.0 | 2-5, 1B-12 | |
| 2-7 | `cloud-shadow-rework` — sun-space footprint, 512² over 24 km = 47 m/texel, single-altitude coverage march, haze-coupled strength | 2.5 | 1C-4 | Removes the `1/sunDirection.y` blow-up at low sun. 0.26 M density evaluations per update instead of 3.7 M for a naive march — *cheaper than today* while 7.5× sharper. |
| 2-8 | `ocean-slope-mips` — store **slopes** not normalised normals, mip the cascades, Toksvig/LEAN variance → roughness, per-vertex cascade fade below Nyquist | 4.0 | — | See §7 R6 for the mip-write constraint. *"Now it looks like the ocean."* |
| 2-9 | `water-sun-and-foam` — one solid-angle-correct GGX lobe (Karis representative point), lit textured foam, wave-crest SSS | 3.0 | 1C-6 | Delete `pow(·,3200)`/`pow(·,1800)` and the arbitrary `×2.6`/`×4.0` gains. Extract shared helpers into `WaterShaders.ts` so ocean and inland water cannot drift apart again — they already have. |
| 2-10 | `retire-planar-reflection` | 1.5 | 2-9 | −0.5 to −1.0 ms/frame amortised. Keep `acceptsInlandPlanarReflection` and the lake hysteresis logic if the lake path survives; it is correct and non-obvious. |
| 2-11 | `foliage-texture-atlas` — procedural leaf/needle/bark, **alpha dilation** + **Castano coverage preservation** | 2.0 | — | Both are non-negotiable and both are the usual reason procedural foliage fails. Without dilation every leaf gets a dark halo; without coverage preservation foliage evaporates with distance. Test: mip-N coverage within 3% of mip-0. |
| 2-12 | `card-trees` — branch skeletons, 40–70 foliage quads, generated tangents, `subSurface.isTranslucencyEnabled` | 4.0 | 2-11, 1A-7 | +1 day over the design's estimate for `ShadowDepthWrapper` (§7 R1) — without it, alpha-tested foliage casts solid cone shadows, which is worse than today. Alpha **test**, not blend. No stochastic alpha (no TAA). |
| 2-13 | `wind-three-band` | 1.0 | 2-12 | |
| 2-14 | `lod-dither-crossfade` — Bayer + per-instance hash, at every LOD switch *and* at the cull radius | 1.5 | 2-12 | Pin the dither to output resolution, or land after 1A-6 so the governor floor is 0.75 and the pattern does not crawl. |
| 2-15 | `procedural-rocks` — displaced icospheres, flat vs smooth normals per lithology, terrain-normal-aligned instances | 2.0 | 1B-9 | Do the full-rotation instance matrix in the same commit as the compact instance format so the layout changes once. |
| 2-16 | `grass-ground-cover` — patches not blades, `1/d` density ramp, 32 B compact instances, ferns/heather/reeds | 2.5 | 2-13, 1B-9 | Closes the audit's "single most damaging failure mode": no scale reference below 7 m on approach. Grass radius is the **first** tier knob. |
| 2-17 | `octahedral-impostors` — hemi-octahedral 4×4 bake, **three-view barycentric blend** | 6.0 | 2-12, 2-14 | Corrected from the design's 3 days. View snapping is what makes cheap impostors flicker when the aircraft banks. |
| 2-18 | `seasonal-foliage` — deciduous leaf-out/leaf-fall curve driving crown tint and alpha; slope-weighted canopy and rock snow | 2.0 | 2-17, 1C-9 | §1.6. Species *mix* stays climatic and does not change with season. **Bake the impostor atlas per season bucket** (4 buckets × the existing atlas) or winter trees impostor as summer ones at range — check the added slots against the §5.2 ceiling. |

**Exit criteria.** Cloud pass ≤ 2.5 ms at Balanced. No repeated cloud group over a 200 km straight leg (visual gate). Ocean pass ≤ 1.8 ms. Foliage mip coverage test passes. Grass at Balanced ≤ 0.9 M triangles. Impostor/LOD1 average colour matches within a few percent across a full sun sweep.
**Demo state.** *"The sky and the trees look real."* G3 and G4 served.
**Phase 2 total: 43.0 days.** (41.0 + 2.0 for `2-18` seasonal foliage.)

> **Superseded 2026-08-19.** Phase 2 shipped at **54.5 d** as amended (43.0 base + 1.0 `B1`–`B7` + 4.0 realignment §6 / `R-18`–`R-24` + 6.5 `B8`).

---

### Phase 3 — Terrain surface and the runway

**Goal.** Close audit root cause #1 — *there is no surface material system, not a weak one, none* — and user goals G6 (runway) and G9 (nothing looks like plastic).

**What you will see.** The terrain stops being an airbrushed wash of eight hues. Grass, rock, scree, sand and snow acquire real sub-metre structure. Cliffs get rock structure that follows the surface instead of a stretched top-down smear. Material boundaries look like one surface sitting on another rather than a soft gradient. Snow glints; wet rock goes dark and glossy; dry grass goes matte; banking over terrain at low sun changes how the ground looks. The runway sits *in* the ground with visible embankments, worn asphalt, ragged grass-invaded edges, faded scuffed markings and black rubber lobes at both touchdown zones — no circular plateau, no floating slab, no z-fighting stripes.

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 3-1 | `material-array-gpu` — ten procedurally synthesised land-cover materials in two `Texture2DArray`s, periodic noise, Toksvig mip reducer, debug viewer **on day one** | 8.0 | — | Corrected from 4 days: ten hand-tuned recipes alone are ~4 days and the mip pipeline plus viewer are another 4. See §3.2 and §7 R6. |
| 3-2 | `surface-plugin` — `TerrainSurfacePlugin`, vertex participation, texture-array bindings, regex roughness/AO injection, footprint from `dpdx/dpdy` | 4.0 | 3-1, 1A-7 | Ships the **provisional vertex-colour splat path** so it is visibly better on its own before splat pages exist. Drop the dead GLSL branch (`TerrainMaterialPlugin.ts:104-194`). |
| 3-3 | `microdetail-fix` — footprint gating, real gradients, texture-sourced detail, specular AA | 1.0 | 3-2 | Deletes `1.0 - smoothstep(1200, 4200, terrainCameraDistance)` (`TerrainMaterialPlugin.ts:76`), which switches the micro-detail off at exactly the distance where vertex normals become worst, and shrinks the 0.38-cell forward difference (which is not measuring a gradient at all) to a ≤0.05-cell central difference. |
| 3-4 | `detile-scales` — three decorrelated rotated world scales with UV warping | 1.5 | 3-2 | **Use 13.7° and 61.2°, not the deleted build's 36.3°** — that is within 1.3° of the 35° geological fabric the audit measures at 23.6:1 anisotropy, and aligning with it reinforces the exact artefact we are removing. |
| 3-5 | `triplanar-texture` — true triplanar **texture** projection, explicit gradients, RNM normal blending, sign-flipped per-plane UVs | 2.5 | 3-2, 3-1 | 2-axis fast path mandatory from Balanced up (§7 R3). Tier 0 uses a slope-stretched planar projection. |
| 3-6 | `height-blend` — N-way height blending with footprint-widened transition depth | 1.0 | 3-2 | Normalise each material's height channel to mean 0.5 in synthesis or one layer dominates. |
| 3-7 | `per-material-brdf` — per-material roughness/F0, Oren-Nayar diffuse roughness, wetness response | 2.0 | 3-6, 1C-6 | **Hard gate on IBL.** Babylon 9 already computes `diffuseRoughness` on the same line as `roughness` (`pbr.fragment.js:240`) and has full `BASE_DIFFUSE_ROUGHNESS` support — snow 0.7, sand 0.55, grass 0.4, rock 0.35 gives the retroreflective brightening that makes those surfaces look real at low sun, for near-zero cost. |
| 3-8 | `runway-earthworks` — three-zone cut/fill profile, 0.35 m crown, noise-modulated blend distance, median site elevation | 2.5 | — | CPU kernel now, ported to WGSL in Phase 4. **Must keep `getAirportInfluence` exactly 1.0 inside the apron** (§1.3). |
| 3-9 | `runway-surface` — asphalt/concrete/paint material layers, ragged SDF-driven edge, skid lobes, worn markings; delete the box meshes | 5.0 | 3-8, 3-1 | Driven by the **analytic airport SDF** evaluated in the fragment shader (`airport.ts:76-81` `sdRoundedRect`), *not* by splat weights — which is what decouples it from Phase 4 and lets it ship here. Deletes `AirportSystem.ts:23-70`. |
| 3-10 | `seasonal-palette` — `dayOfYear`-driven albedo/roughness modulation of the land-cover materials in the surface plugin | 2.0 | 3-7, 1C-9 | §1.6. A per-material seasonal tint/roughness curve sampled in `TerrainSurfacePlugin`, **not** new texture arrays — the arrays stay season-independent and only their weighting changes. Keep the runway and rock materials season-invariant. |

**Exit criteria.** Top-down `|natural − final|` debug render: the 0.5 m contour around the airport is **not** a closed convex curve. Babylon regex-injection compile test passes (fails CI on a Babylon bump instead of silently reverting roughness to 0.93). Terrain raster ≤ 2.6 ms at Balanced including surface, de-tile and triplanar. Material arrays 512² at Low/Balanced/High, 1024² at Ultra only.
**Demo state.** *"The ground has a surface, and the runway looks like a runway."* Audit root cause #1 closed.
**Phase 3 total: 29.5 days.** (27.5 + 2.0 for `3-10` seasonal palette.)

> **Superseded 2026-08-19.** Phase 3 is **30.25 d** per [`PHASE_3_EXECUTION_PLAN.md`](PHASE_3_EXECUTION_PLAN.md) and the realignment (`C1`–`C7`, `R-26`).
>
> **SHIPPED 2026-08-19.** All ten items landed, plus `R-26`. Twelve deviations are recorded in that plan's §14.2; the four that change what this section says are: `3-1` synthesises on the CPU rather than in a compute shader (a GPU mip 0 would have to be read back before `C2`'s CPU Toksvig reduction, costing more than it saves); **Ultra's material array edge is 512², not 1024²**, which supersedes this section's exit criterion; the eight published tiling periods are **not** mutually prime and were re-cut to distinct primes in decimetres; and the `SurfaceMaterial` enum order is load-bearing as an *ecotone axis* — `3-2` interpolates the material id and brackets it, so indices 0–5 are the biome primaries in climatic order. Assertion 67 (terrain raster ≤ 2.6 ms at Balanced) is carried open: the renderer has no per-pass GPU timer.

---

### Phase 4 — The terrain GPU spine

> **Executed per [`PHASE_4_EXECUTION_PLAN.md`](PHASE_4_EXECUTION_PLAN.md), which is binding over this table.** It re-prices the phase at 46.5 d, adds `4-0` (spine contract), `4-0b` (= `6-10` moved), `4-8a` and `4-10`, splits `4-8`, and corrects four items that are fatal as written: `thinInstanceSetBuffer(…, 8)` throws, PCSS cannot run on Phase 1's depth-only CSM, `getCustomRenderList` cannot cull CDLOD nodes, and `terrainQueue.ts` must not be deleted. §5.3's Ultra 1 m L0 row and the `|x| = 5×10⁶ m` parity criterion are struck.

**Goal.** Replace 172 CPU-built meshes with one GPU-fed CDLOD quadtree over a page atlas, and bake the occlusion that makes lighting describe real shape. This is the enabling phase for everything in Phases 5–6 and it is the plan's biggest incrementality risk — several items promise no visible change by design.

**What you will see.** L0 texel spacing goes from 8 m to 2 m, so the ground gains real shape on approach. LOD popping disappears completely — no jolt when crossing a boundary, no cracks, no skirt lines on ridge silhouettes. A mountain filling the screen at 20 km refines on its own merit while a flat plain at 3 km stays cheap. Ridges cast real shadows across valleys at 40 km, where the CSM has never reached. Material identity stops being a coin flip between distant vertices; treelines follow altitude and aspect with a ragged natural edge.

**Mitigation for the dark stretch (mandatory, not optional):** build a false-colour debug overlay for the atlas, page residency and every baked channel **before** the items that consume them. Every gate below must have something on screen.

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 4-1 | `wgsl-kernel` — the height kernel as a shared WGSL include, bit-exact hashing, per-octave domain wrap | 3.5 | 1B-2, 1A-3 | See §1.3. `avalanche`/`mixSeed`/`hashCoordinates` port literally. Clamp `pow` bases: `pow(0, x)` is indeterminate in WGSL. |
| 4-2 | `page-atlas` — one r32float height atlas, slot-keyed, with indirection through thin-instance attributes | 4.0 | 4-1 | 264² slots. Reuse `WorldPageLifecycle`, `calculateWorldPageStreamingPriority` and `compareWorldPageCacheEvictionOrder` from the dead `world/` architecture verbatim. Surplus slots **are** the LRU cache. |
| 4-3 | `gpu-height-generate` — compute generation with 2×2 rotated-grid supersampling | 3.0 | 4-2 | 8×8 workgroups. Create `ComputeShader` objects **once** and rebind uniforms per page. Second dispatch: parallel min/max reduction for the CDLOD AABB. |
| 4-4 | `vertex-displacement` — vertex-texture displacement + fragment-computed normals; retire the terrain worker | 4.0 | 4-3, 1A-7 | +1 day over the design for `ShadowDepthWrapper` (§7 R1). Manual bilinear via 4 `textureLoad`s (r32float is not filterable in core WebGPU). Deletes `TerrainGenerationClient`, `terrain.worker.ts`, `terrainProtocol.ts`, `terrainQueue.ts`. |
| 4-5 | `cdlod-quadtree` — screen-space error + geomorphing, one draw call | 5.0 | 4-4 | `maxDeviationFromParent × pixelsPerMeter(distance3D) > τ`. Delete `TERRAIN_SKIRT_DEPTH_METERS`, `buildTerrainIndicesWithSkirt` and friends, then set `backFaceCulling = true`. Supply a **per-cascade thin-instance subset** — Babylon's WebGPU `objectRenderer` has no `isInFrustum` on the render-list path (`objectRenderer.js:713`) and re-prepares the list per cascade (`:626`). |
| 4-6 | `wgsl-classifier` + `page-splat-atlas` — continuous softmaxed land-cover classifier and splat page rasterisation, merged, WGSL-first, **`dayOfYear` in the signature** | 7.0 | 4-3, 3-6, 1C-9 | See §3.2. TypeScript mirror kept only as a golden-value test oracle. +1.0 d for the seasonal snow-pack term and the **24-bucket season cache key** on the splat atlas, with a two-bucket shader cross-fade so scrubbing the season never re-bakes per frame (§1.6). Designing the key in here is roughly free; adding it later is a re-architecture. |
| 4-7 | `page-occlusion-bake` — sky visibility (GTAO horizon-arc form), bent normal, 8-azimuth horizon map, merged into one owner and one format | 5.0 | 4-3, 1C-6 | Four designs baked this four ways at three resolutions. One bake, 136² channel pages, 16 azimuths × 24 steps, marching a **coarse global height pyramid** beyond the page (512 m/texel over 128 km, 256² r32float = 256 KiB) so there is no shadow discontinuity at page edges. |
| 4-8 | `csm-nearfield` — 3×1536, 1.8 km, PCSS, per-cascade `getCustomRenderList` frustum culling | 2.0 | 4-7 | **Now** it is safe to shorten the distance: the horizon map covers everything beyond. Doing it earlier leaves distant mountains unshadowed for months. |
| 4-9 | `retire-cpu-terrain-path` + runway earthworks ported to WGSL | 1.0 | 4-5, 3-8 | |

**Exit criteria.** Kernel parity: `|h_GPU − h_CPU| < 0.05 m` over 4,096 Halton points at five filter widths *and* at |x| = 5×10⁶ m. Terrain draw calls ≤ 12. Terrain vertex/index buffers ≤ 3 MiB. `sim.flight.test.ts` ground clearance never negative. Shadow render list contains zero terrain nodes. Cross-level consistency: a level-N page's splat weights equal the box average of the four level-(N−1) pages beneath it to within quantisation.
**Demo state.** *"2 m ground detail, no popping, and mountains shadow each other to the horizon."*
**Phase 4 total: 34.5 days.** (33.5 + 1.0 for the season term and cache key in `4-6`.)

**— v1 cut line: Phases 1–4, ~147 days ≈ 7.5 months. Eight of nine user goals served. G1's *generation* half and G2's rivers/lakes are what remains. —**

> **Superseded 2026-08-19** (correcting figures from 2026-08-18 and the Phase 4 re-price). The v1 cut line is **≈217 days** per the reconciled ledger (see the Phase totals note), and coverage is certified against **G-A/G-B/G-C** (§0.4) — not a count against the undefined `G1`–`G10`.

---

### Phase 5 — Landscape evolution

> **Governed by [`PHASE_5_EXECUTION_PLAN.md`](PHASE_5_EXECUTION_PLAN.md) (57.25 d, binding over this table), written 2026-08-19.** It adds `5-0` (evolution contract), `5-A` (the single activation commit satisfying R10) and `5-13` (riparian exclusion); splits `5-8` and moves the tectonic uplift **ahead of** `5-3` so erosion is tuned once, against its final input; moves `5-10`/`5-11` to the head of the phase for an early visible payoff; defines the macro flood's domain (1024² × 512 m, world-anchored, open rim — no plan document had defined one); re-prices `5-5`, `5-11` and `5-12` against the tree as it is; and **strikes §5.3's tier-dependent erosion-scope and Ultra "+50% iterations" rows** — tier-dependent erosion output would make the collision surface a function of a graphics setting, the same rule that struck the Ultra 1 m L0 row. It also creates **Gate B — the felt frame (7.25 d, before Gate A and Phase 4)** from the 2026-08-19 flight-test reports; reconciled programme ≈343 d, v1 cut line ≈224 d.

**Goal.** Break the `h = f(x, z)` contract. This is audit root cause #2 and the single largest realism change in the program.

**What you will see.** From cruise, the world stops reading as crumpled cloth. Dendritic drainage networks at every scale. Continuous ridge divides that do not dead-end, because a ridge is now literally the boundary between two catchments. Trunk valleys with a downstream end. V-notched headwaters, alluvial fans, talus cones, floodplains. Smooth alluvial valley floors under angular rock crests. Gullies and rills on hillsides at 500 ft. Continental spines instead of isolated round lumps, and the pervasive 35° world grain replaced by a fabric that turns with each mountain range. A real continental shelf and abyssal plain instead of a flat −105 m floor.

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 5-1 | `erosion-hydrology-contract` — the export list, as a typed interface + tests | 3.0 | — | **Write this first, before erosion implementation.** It is a specification, not code. The best-specified item in the whole design set. |
| 5-2 | `collision-readback` + macro fallback grid + crash-recovery coverage | 4.5 | 4-3, 5-1 | §1.3. +0.5 day over the design for `crashRecoverySurfaceHeight`. |
| 5-3 | `macro-drainage` — eager L8 multigrid Planchon–Darboux + MFD accumulation + one incision pass | 9.0 | 5-1, 5-2 | Range 8–14. The **coarse global flood is the sole authority on base levels and lake spill elevations**; fine pages may refine an existing lake but may never create one. Build the false-colour flow/lake overlay **before** tuning anything. |
| 5-4 | `hierarchical-page-erosion` — per-page erosion seeded by the parent, provably seam-exact | 8.0 | 5-3 | Range 7–14. Seam theorem: talus and Jacobi propagate ≤1 texel/iteration, max radius max(32,24,16)=32 texels < 64-texel halo ⇒ adjacent pages compute bit-identical edges. **Assert exact equality on the 4-texel overlap in a test.** |
| 5-5 | `aux-page-channels` — flowAccum, lakeDepth, soilDepth into the channel atlas | 2.0 | 5-4 | `soilDepth = f(slope, curvature, log A)` is what produces the crest/valley roughness contrast. |
| 5-6 | `runway-erosion-mask` — `K = 0`, `repose = 0` inside apron+batter; perimeter drainage diversion | 1.0 | 5-4, 4-9 | Real airfields have a perimeter ditch; this is why rivers approaching the field behave instead of terminating at a wall. |
| 5-7 | `fine-band` — 24 m and 9 m ridged octaves in the **uplift/lithology** field, masked by soil depth, curvature and fabric | 3.0 | 5-4 | Put them in the uplift, not the height, so erosion *acts* on them rather than decorating the result. Most of the 8–43 m band is filled for free by talus (5–20 m facets) and incision (10–50 m gullies). |
| 5-8 | `tectonic-skeleton` — Lloyd-relaxed plates, linear orogens, per-region structural fabric, lithology-driven erodibility, real bathymetric profile | 5.0 | 5-4 | Replaces `geology.ts:41-42`'s global 35° constant. Blend the fabric as a **2D direction vector with double-angle encoding**, not as a scalar angle, or you get a visible tear. Raises `MAX_TERRAIN_HEIGHT` to 4,500 m — land with 5-4 so the screenshot baseline churns once. |
| 5-9 | `channel-graph` — thinned vector channel network with confluence topology | 2.0 | 5-5 | Previously unowned, on the critical path. Now owned by water. |
| 5-10 | `bathymetry-clipmap` — 2-level toroidal R16F bed elevation | 4.0 | 5-5 | Store `bedElevation − seaLevel` clamped to ±256 m in L0 so the shallow band gets ~0.06 m precision. |
| 5-11 | `water-depth-optics` — Beer-Lambert with real absorption, analytic refracted bed shading, single-scatter turbidity, soft shoreline | 4.0 | 5-10, 2-9 | Deep water is blue because red is absorbed ~20× faster. Give rivers a lower `alphaIndex` than the ocean and rely on the depth test. |
| 5-12 | `carved-rivers-lakes` — 5-lane ribbons from the channel graph, marching-squares lake polygons at the spill elevation | 6.0 | 5-9, 5-11 | Deletes `traceDownhillPath` (`HydrologyGeneration.ts:317-404`), `buildSourceCandidates`, `smoothTrace`, the width heuristics and `buildBasinLake`. Raise `maximumRivers` (10) and `maximumRiverWidthMeters` (22) — a trunk river should reach 100–300 m. |

**Exit criteria.** Pit density < 0.1/km² at 50 m sampling (today: 8.5). 500 m transect FFT: smooth power law down to ~6 m (today it falls off a cliff at 43 m). 20 m RMS curvature contrast valley:crest ≥ 3:1 (today 1.18:1). Gradient-orientation anisotropy in the 30–50° band < 1.3:1 globally while remaining strongly anisotropic locally along each range (today 2.7:1 at every probe scale). Erosion seam test: exact equality. Collision-fallback counter zero below 500 m AGL over the full `sim.flight.test.ts` profile. Every channel terminates at the sea or at a lake with a real outlet.
**Demo state.** *"It looks like a landscape that something happened to."*
**Phase 5 total: 51.5 days.**

---

### Phase 6 — Water in motion, ecology and final tiers

**Goal.** Finish user goal G2 (ripples, waves, surf), close the vegetation/terrain handoff, move scatter to the GPU, and land honest quality tiers on measured numbers.

**What you will see.** Rivers visibly flow, speeding up in constrictions, with standing waves that hold position over rapids. Lakes glassy when small, choppy when large. A living surf line that surges and recedes in time with the incoming swell; wet sand darkening behind it. Caustics on shallow beds. Dark dendritic threads of riparian woodland tracing every drainage line; forest filling valleys and thinning on wind-scoured ridges; the treeline rising and falling with shelter. Distant forest as textured woodland to the horizon instead of ending at a circle. Talus cones fanning below cliffs. From cruise, the vegetation pattern starts explaining the terrain instead of decorating it.

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 6-1 | `river-flow-advection` — dual-phase flow-map advection, three scales, standing waves on steep grade, fetch-limited lake chop | 4.0 | 2-8, 5-12 | Adding a capillary cascade requires raising the 5-cascade cap (`OceanConfig.ts:163-165`), and `resolution` is a **single global config field** — a per-cascade N needs a schema change. The Nyquist assertion `minimumWavelength >= 2·patchLength/resolution` will throw at 0.05 m: the legal floor for an 8 m patch at N=256 is **0.0625 m**. `assertAscending` forces the new cascade to index 0, renumbering every existing cascade — audit `updateEveryNFrames`, the unrolled `sampleNormalFoam` loop and `QualityProfile.oceanCascades`. |
| 6-2 | `shoreline-foam-runup` — depth-driven breaking band, Hunt run-up, shore-normal streaks, wet-sand persistence | 3.0 | 5-11, 6-1 | Derive the run-up phase from the **same cascade the visible swell comes from**, or the surf beats out of time with the waves arriving. |
| 6-3 | `shallow-water-dispersion` — shoaling + depth-limited breaking (options a+b only) | 2.0 | 5-10 | Gate to depth < 60 m, always inside the finely-tessellated inner rings. |
| 6-4 | `caustics` — Jacobian-driven, gated to shallow pixels | 2.0 | 5-11, 2-8 | Very high perceived quality per day. |
| 6-5 | `terrain-wetness` — implemented in the terrain surface plugin from the water-side field definition | 1.5 | 3-7, 6-2 | `roughness = mix(r, r*0.35 + 0.02, wet)`, `albedo *= mix(1.0, 0.62, wet)`. Two instructions; makes riverbanks, tidal flats and wet rock read correctly. |
| 6-6 | `ecology-channels` — riparian corridors, shelter and soil depth from the page channels | 2.5 | 5-5, 1B-7 | Three channels, each with a **named ground-layer consumer**, or the item produces data nothing reads. **Riparian** → reed/fern archetype weight and a wet-litter darkening in the forest-floor splat. **Shelter** → moss weight (moss lives where wind does not reach) and deadfall accumulation. **Soil depth** → litter depth and clutter density. +0.5 d also drops `densityField`'s glade floor (0.3 today, so openings never actually open) toward 0 with a sharper transition, adds one hard-edged disturbance class (windthrow/burn/cut) so some forest edges are genuinely hard, and adds a margin term — shorter, bushier stems where closure gradient is high — so a forest has an edge profile. Net stem count *falls*. |
| 6-7 | `talus-scree-placement` | 1.5 | 5-5, 2-15 | |
| 6-8 | `canopy-terrain-handoff` — canopy closure and grass cover as splat channels; canopy height added to terrain height at LOD ≥ 3 | 2.5 | 6-6, 2-17 | Single owner (vegetation) for the density function; both designs admit duplicating it is the failure mode. Lets the impostor radius **drop** from 4 km to ~2.5 km, saving ~110,000 instances. **The recovered instance and frame budget is spent on the card-tree LOD radius and on impostor texels per view — not on raising `vegetationDistance` or `vegetationDensity`** (§5.3's vegetation trade-off rule). |
| 6-9 | `gpu-scatter` — compute scatter and cull, CPU-readback count as the **default** | 5.0 | 6-8, 4-6 | See §7 R4. Indirect draw is an optimisation behind a loud startup capability assertion, not the primary path. **Cheaper scatter does not authorise more plants:** any surplus is booked against §5.3's fidelity list, and `6-11` may not raise a count row without a fidelity row moving in the same commit. |
| 6-10 | `compute-scheduler` — shared amortised-compute budget with a per-frame millisecond meter | 2.0 | 1A-1 | Slices erosion's 30–80 iterations across frames using the epoch machinery in `world/lifecycle.ts` that already models exactly this and is dead code. Governor B gains lever 0: shrink the compute budget before touching anything visual. |
| 6-11 | `quality-tiers-v2` — four tiers on measured numbers, asserted in CI | 3.0 | all | See §5.3. Expect the first real capture to move several rows by 30–50%. |
| 6-12 | Documentation truth pass — `README.md:54-60`, `docs/PERFORMANCE.md:41,61-76`, pinned by a test that reads the profile table | 1.0 | 6-11 | These currently misreport terrain rings, cascade counts, ocean resolution, cloud scale and skirt depth, and claim "Rayleigh/Mie-style scattering" for a three-colour `mix()`. **This is why the regressions went unnoticed.** |

**Exit criteria.** All four tiers pass `assertWithinBudget()` at three viewport sizes. Balanced holds 60 fps on the reference M2 Pro with erosion, textured terrain, flowing rivers and 3 km of vegetation, measured by `perf:capture`, not by impression. README and PERFORMANCE.md assertions pass.
**Demo state.** *"Everything the user asked for, at a frame rate that is a number and not a hope."*
**Phase 6 total: 30.0 days.** (29.5 + 0.5 for `6-6`'s glade floor, disturbance class and forest-edge profile, added 2026-08-18 with the vegetation-quality amendments. `PRE_PHASE_4_REALIGNMENT.md` moves `6-10` out to Phase 4, so the net is ~28.0.)

---

### Phase 7 — Night operations and airfield identity

**Goal.** Deliver the complete night experience — moon, stars, night vision, and real airfield and aircraft lighting — and replace the three placeholder hangar boxes with an airfield that has a recognisable identity.

**What you will see.** A night approach: the rotating beacon picks out the field from ten miles, the approach lights sequence you in, the PAPI shows two red and two white and changes as you drift off the glideslope, the runway edge lights resolve from a smear into individual sources, your landing light throws a cone through the haze onto asphalt, and the hangar apron floods pick out corrugated metal with rust streaking down from the bolt lines. In daylight the same hangars have ribbed cladding, sliding doors you can see the tracks on, roof vents, gutters, a windsock that actually reads the wind, and a perimeter fence.

**Why it is its own phase.** It depends on the whole atmosphere spine (Phase 1), the material synthesis infrastructure (Phase 3) and the runway surface (`3-9`). It is also cleanly separable — the sim is complete and shippable without it, which makes it the right place to put 40 days of scope.

#### Gate 7A — Night sky and human night vision (7.5 d) — **EXECUTED 2026-08-19**

> Ran between Phase 2 and Phase 3 per `PRE_PHASE_4_REALIGNMENT.md` §5 (`R-17`),
> in the order that realignment set: `7-3` → `7-1` → `7-2`. Four deviations
> are recorded, each with its reason; `ARCHITECTURE.md`'s decision log carries
> the full rationale.
>
> 1. **The catalogue is authored, not vendored.** ~190 stars to magnitude
>    ~3.6 with their real J2000 positions, magnitudes and colour indices, plus
>    a background generated to the observed magnitude-count law below that —
>    rather than the Yale BSC's 9,100 as a shipped data file. The row's own
>    stated reason for wanting real data ("makes constellations correct") is a
>    property of the bright end, every other asset in this renderer is
>    synthesised from the seed, and the transcription is guarded by geometry
>    (Orion's belt, the Dipper's pointers, the Summer Triangle, the Southern
>    Cross) rather than by review.
> 2. **Night's absolute scale is art-directed; everything relative is
>    physical.** The sun-to-full-moon range is 4.8 × 10⁵ against an fp16
>    beauty target with a 6.1 × 10⁻⁵ floor, so a photometric night needs a
>    scene pre-exposure the programme does not have and `1C-2` deliberately
>    did not build. Two named constants carry the level; phase, the opposition
>    surge, altitude, distance, magnitude ratios, extinction and spectral
>    colour are all computed, and `7-2` reads the true lux for the rod/cone
>    decision. **`7-4` meets the same 10⁵ range with light points and is where
>    the pre-exposure decision belongs.**
> 3. **The rod response half-saturates at the scene's key luminance**, not the
>    physical adapted luminance — measured: the physical σ drives every pixel
>    to saturation and returns a flat grey frame. The perceptual call
>    (`rodFraction`) stays physical.
> 4. **Moonlight does not cast shadows.** A second cascade set would double
>    the shadow row for a light whose shadows sit below resolvable contrast at
>    0.25 lux; `7-9`'s night tier is where that trade is measured.
>
> Both constants the realignment named are reopened and both are derived:
> `exposureForState`'s 2.6 clamp becomes `MAX_EXPOSURE` (the curve's own value
> at the scotopic hand-over illuminance, 4.698), and `ambientIntensity`'s
> unconditional 0.05 now follows the sky's illuminance, exactly 0.05 at the
> reference key. `1C-10`'s 40-lux skylight floor — the actual cause of "at
> 22:00 the ground is black" — is replaced by a twilight tail running to a
> 0.0015 lux airglow floor.


| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 7-1 | `moon` — ephemeris position, phase from `dayOfYear`, disc with an albedo/normal map, moonlight as a second directional light, earthshine on the dark limb | 3.0 | 1C-10 | Full-moon ground illuminance is ~0.25 lux against the sun's ~120,000 — a factor of ~5×10⁵, which is why `1C-2`'s single-exposure work is a hard prerequisite. Moonlight is reflected sunlight, so it is only slightly reddened (~4100 K), **not** the blue that films use; the blue you perceive is the Purkinje shift in `7-2`, and faking it in the light colour instead is the classic mistake. |
| 7-2 | `scotopic-vision` — rod/cone blend by adapted luminance, Purkinje shift, desaturation, acuity loss, adaptation hysteresis | 2.5 | 7-1 | The single largest "it actually feels like night" item, and it is a post-process, not a lighting change. Below ~0.03 cd/m² human vision is rod-only: colour discrimination collapses, blues brighten relative to reds, and acuity drops. Without this, night is just dim daylight. Bound the adaptation rate (light→dark is much slower than dark→light) or flying past a floodlight strobes the whole image. |
| 7-3 | `star-field` — Yale Bright Star catalogue (~9,100 stars, ~120 KB), sidereal rotation from `dayOfYear` + `solarTimeHours` + latitude, magnitude→luminance, atmospheric extinction near the horizon, Milky Way band | 2.0 | 7-1 | Real catalogue data is small enough to embed and makes constellations correct, which is worth more than procedural noise. Extinction matters: stars must *fade out* toward the horizon, not run into the ground. Point sprites with a magnitude-driven PSF, resolution-independent. |

**Exit criteria.** Adapted luminance spans day→full-moon→starlight without clipping or crushing. Star field rotates correctly for the selected date, time and latitude and is extinguished below ~10° elevation. Moon phase matches `dayOfYear`.
**Demo state.** *"Night looks like night, not like someone turned the brightness down."*

#### Gate 7B — The lighting engine (11.0 d)

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 7-4 | `clustered-lighting` — stand up `ClusteredLightContainer`, tune tiles and depth slices, integrate with `TerrainSurfacePlugin` and the aerial-perspective include, per-tier light budget | 4.0 | 3-2, 1C-4 | §1.6. Verify `IsLightSupported()` against this engine configuration **on day one of the gate** — it gates everything downstream. Tile count trades clustering cost against shading cost; start 16×8 and measure. Confirm clustered lights compose with the material plugin's injected code rather than fighting it. |
| 7-5 | `light-points` — instanced emissive billboards for the ~200 lights you *see*: HDR intensity, IES-driven directional visibility, atmospheric extinction, bloom coupling, distance-based PSF growth | 4.0 | 7-4, 7-2 | The other half of the §1.6 split, and the reason this phase is 40 days rather than infeasible. One instanced draw. Feed `Lights/IES/iesLoader.ts` profiles so a PAPI is invisible off-axis and edge lights dim correctly off-centreline. Each point needs a smooth **near→far transition from a lit quad to a pure glow** or lights pop as you approach. |
| 7-6 | `light-volumetrics` — cone shafts for landing lights and floods through haze | 3.0 | 7-5, 1C-4 | Reuse the aerial-perspective include's participating-media terms rather than inventing a second fog model. Billboard cones with a soft depth intersection are enough; a full march is not warranted. Highest cut candidate in the phase if the budget bites. |

**Exit criteria.** 200+ light points and 16 clustered illuminating lights hold the tier frame budget. No light-count-dependent shader recompilation during flight.
**Demo state.** *"The airfield reads from ten miles out."*

#### Gate 7C — Airfield and aircraft lighting (9.0 d)

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 7-7 | `airfield-lighting` — runway edge (white, amber final 600 m), threshold (green/red bidirectional), centreline, TDZ, **PAPI** with correct angular transition, approach lighting system, taxiway blue edge and green centreline, rotating beacon (alternating white/green for a civil field), lit wind cone | 4.0 | 7-5, 3-9 | Generated from `AirportDefinition` (`src/world/airport.ts`), not hand-placed, so it survives a seed change. The PAPI is the one piece that must be *numerically* right — it is a flyable instrument, and its red/white transition near 3° is the whole point. Bidirectional threshold lights show green to arrivals and red to departures from the same fixture. |
| 7-8 | `aircraft-lighting` — nav lights with correct split angles (red port 110°, green starboard 110°, white tail 140°), red anti-collision beacon ~45 fpm, white strobes ~60 fpm at wingtips and tail, landing and taxi lights as clustered spots, cockpit instrument glow | 3.0 | 7-4, 7-5 | The split angles are what make traffic readable at night — you infer heading from which colours you can see. Beacon and strobes are on separate timers and must not be in phase. Landing lights are the main *illuminating* lights in the sim. |
| 7-9 | `night-perf-tiers` — light budget per tier, cluster resolution scaling, light-point LOD and culling, night shadow policy | 2.0 | 7-6, 7-8 | Night is a different workload from day: fewer shadow casters, far more lights. It needs its own tier row, not a scaled daytime one. |

**Exit criteria.** A full night circuit is flyable on Balanced within budget. PAPI indication matches the geometric glideslope to within 0.1°. Nav-light colours correctly identify another aircraft's heading.
**Demo state.** *"I flew a night approach and the PAPI talked me down."*

#### Gate 7D — Hangars and airfield identity (14.0 d)

| ID | Item | Days | Depends on | Notes |
|---|---|---|---|---|
| 7-10 | `parametric-hangar` — a generator replacing the three boxes: gabled and arched roof profiles, ribbed corrugated cladding, sliding door tracks and panels with open/closed states, clerestory window strips, ridge vents, gutters and downspouts, service doors, pilasters, concrete skirt | 5.0 | 3-1 | Replaces `AirportSystem.ts:72-83` — currently three `CreateBox` calls at 46×14–18×34 m with one flat metal material. Corrugation is **geometry on the silhouette and a normal map inboard**; doing it all in the normal map leaves a straight edge that gives the box away. Parameterise on bay count, so hangars vary without new code. |
| 7-11 | `hangar-materials` — procedural corrugated metal (normal + roughness), vertical rust and streak weathering, oxidation biased by aspect, concrete with form-tie marks | 2.5 | 7-10, 3-1 | Reuses the Phase 3 synthesis infrastructure — no new pipeline. Weathering driven by a downward-flow accumulation term from bolt lines, gutter mouths and roof edges is what stops it reading as clean CAD. |
| 7-12 | `hangar-interior` — interior shell visible through open doors, dark PBR interior, emissive strip lighting at night, a parked aircraft silhouette | 2.0 | 7-10, 7-4 | An open door onto a black void is worse than a closed door. Interior spill through open doors is one of the better night set-pieces and costs one clustered light. |
| 7-13 | `airfield-furniture` — wind-driven animated windsock, fuel tanks, perimeter fence, runway/taxiway signage with emissive faces, tie-down anchors, ground support equipment, apron markings | 3.5 | 7-10, 3-9 | The windsock reads from `src/world/wind.ts`, which already exists — a genuinely cheap authenticity win, and a usable instrument on approach. Signage doubles as night light points via `7-5`. |
| 7-14 | `obstruction-lighting` — red obstruction lights on hangar roofs and masts, apron floodlighting | 1.0 | 7-13, 7-5 | |

**Exit criteria.** No `CreateBox` primitive remains in `AirportSystem.ts`. Hangars are visually distinct from one another under the same seed. The windsock tracks the simulated wind vector.
**Demo state.** *"It looks like an airfield somebody actually operates."*

**Phase 7 total: 41.5 days.**

**Internal cut line.** If the budget bites, `7-6` (volumetrics, 3.0), `7-12` (interior, 2.0) and half of `7-13` (furniture, ~1.5) can defer without breaking anything else — a **35.0-day** Phase 7 that still delivers a flyable, lit night approach and detailed hangars.

> **Amended 2026-08-19.** Gate 7A (7.5 d) executed 2026-08-19, between Phase 2 and Phase 3 per the realignment; the remaining Phase 7 is **7B/7C/7D = 34.0 d**. The 35.0-day internal cut line above predates 7A's removal — the same cuts against the remaining 34.0 d leave 27.5 d.

---

**Program total: 278.1 days.**

> **Corrected 2026-08-19: ≈330 days.** See the Phase totals note. The figure above predates Phase 0 and every execution plan; the 2026-08-18 correction of ≈316 in turn predates [`PHASE_4_EXECUTION_PLAN.md`](PHASE_4_EXECUTION_PLAN.md) re-pricing Phase 4 at 46.5 d.

---

## 3. Subsystem specifications

### 3.1 Terrain geometry — heightfield, LOD, erosion

**Today.** `sampleNaturalTerrainHeight(seedHash, x, z)` (`terrain.ts:31`) is a closure over `(x, z)` alone; every term in the sum at `:93-102` is pointwise. `tile.ts:151` evaluates it once per vertex with no filtering. `TerrainClipmapSystem.ts:231-235` picks resolution from `(tier, level)` with no camera distance and no altitude — `TerrainObserver` (`:66-71`) cannot see `y` at all, which is why 28.4% of triangles sit under the fuselage. There is no geomorphing anywhere in the codebase; `applyToMesh(mesh, false)` at `:604` and the absence of any morph factor confirm it.

**Target.**

1. **Band-limiting first (1B-2).** Thread `filterWidthMeters` through `sampleNaturalTerrainHeight`, `sampleGeologicalRelief`, `sampleTerrainMoisture` and `sampleTerrainTemperature`. In `fbm2D`/`ridgedFbm2D`, terminate the octave loop when `wavelength < 2 × filterWidth` and fade the last octave with `smoothstep(2·fw, 3.2·fw, wavelength)` so the cutoff is C1-continuous in spacing — a hard cutoff pops when a page changes level. Apply the same amplitude scaling to the single-octave `valueNoise2D` calls in `geology.ts`. **This makes coarse pages cheaper, not more expensive:** a 512 m-spacing page drops from 34 noise evals per height to ~14. *Why it matters:* today the coarse mesh is not a blurred version of the fine one — it sits on an arbitrary phase of the 43–160 m noise and is a genuinely different landscape, which is why the horizon crawls and why `mix(fine, coarse, morph)` is meaningless until this lands.

2. **The atlas (4-2).** One r32float texture per tier: 3168² (144 slots) / 3696² (196) / 4224² (256) at Low/Balanced/High-Ultra, all well under the 8192 `maxTextureDimension2D`. Slot = 256 core + 4 gutter = 264². Level L texel = `2 × 2^L` m, page extent = `512 × 2^L` m — identical to the existing addressing, and `pageKey.ts`'s `worldPageBounds(address, 512)` already computes it. Indirection is a `uniform array<vec4f, 256>` of `(slotU, slotV, originX, originZ)` plus a parallel array of `(texelSize, minH, maxH, maxDeviationFromParent)`; the node passes its slot index as a **thin-instance attribute**, so no indirection fetch is needed.

3. **CDLOD (4-5).** Split when `maxDeviationFromParent × pixelsPerMeter(distance3D) > τ`, with `pixelsPerMeter(d) = viewportHeight / (2·d·tan(fovY/2))`. τ = 4.0/3.0/2.0/1.5 px by tier; hard node budget 160/240/320/448. One 33×33 unit grid `Mesh` (2,048 triangles), `thinInstanceSetBuffer('terrainNode', data, 8)`. Geomorph in `CUSTOM_VERTEX_UPDATE_POSITION`: compute `morphK` from the node's distance band (Strugar 2009), snap the grid position to the parent's even-vertex lattice, `posMorphed = mix(pos, posSnapped, morphK)`, sample height at `posMorphed` from both this node's slot and the parent's, and `mix` by the same `morphK`. **At morphK = 1 the fine node's edge is exactly the parent's edge, so cracks close analytically** — which is what lets skirts be deleted, which is what lets `backFaceCulling = true`.

4. **Landscape evolution (5-3, 5-4).** The inversion that makes this work: the analytic kernel stops being the terrain and becomes the **uplift rate field** `U`. Pipeline per page, all texture-native (WGSL atomics live on storage buffers, not textures, so the accumulation must be atomic-free):
   - **Depression fill** — multigrid Planchon–Darboux, `W = max(Z, min_n(W_n + ε))`, ε = 1e-3 m/texel, 8 relaxations at each of 6 mip levels, coarse to fine. Records `lakeDepth = W − Z` as a free gift to hydrology. *Verify by checking every lake texel has exactly one receiver.*
   - **Flow accumulation** — atomic-free hierarchical gather, `A(c) = 1 + Σ w_n·A(n)` over the 8 neighbours draining into `c`, MFD weights `w ∝ max(0, slope)^1.1` normalised; 60 relaxations at 1/16 res, prolongate, 40 at 1/8, … 20 at full res.
   - **Stream power** — implicit FastScape as Jacobi: `z_i = (z_i + C·z_receiver)/(1 + C)`, `C = K·A^0.5·dt/L`, 24 iterations, unconditionally stable.
   - **Thermal/talus** — mass-conserving two-pass: pass A computes each cell's excess above `tan(repose)·texelSize` toward each lower neighbour and writes a signed delta; pass B applies. 32 iterations.
   - **Hierarchy.** Every page runs the same kernel, parameterised by texel size, seeded by its already-eroded parent: `Z = bicubic(parentZ) + bandLimitedDetail(texelSize)`, `A = bicubic(parentA) × 0.25`, `receiverHint = parentFlowDir`. Only bounded-propagation operators run per page (local pit-breach limited to 16 texels — **never** the global multigrid fill, which stays at the parent). Scratch 384² = 256 core + 64 halo.
   - **The seam theorem.** Talus and Jacobi propagate exactly 1 texel per iteration; max propagation radius = max(32, 24, 16) = 32 texels < the 64-texel halo. A perturbation at the scratch boundary cannot reach the page core. Therefore adjacent pages compute **bit-identical** values at their shared edge: no feather, no stitching, no ordering dependency. This is asserted as an equality test, and it is the only reason per-page erosion is tractable.
   - **Binding constraint from the water design:** depression filling is a *global* operation. A per-page priority flood produces inconsistent spill elevations at seams and a lake straddling a page will have two surfaces and visibly tear. The coarse global flood at L8 is the **sole authority** on base levels and lake spill elevations.

**Cut from this subsystem:** nothing of substance. `lod-ladder-and-altitude` is deliberately throwaway.

### 3.2 Terrain surface material

**Today.** The entire material is seven lines (`TerrainClipmapSystem.ts:271-286`): no albedo texture, no bump, no detail map, no metallic texture. `vertexData.uvs` is never assigned (`:600-603`) and no tangents are generated, so Babylon's `NORMALMAP` and `DETAIL` paths are structurally unreachable. Repo-wide search for image assets returns **zero files**. All appearance lives in an 8-bit per-vertex colour chosen by a threshold cascade — and past 5 km, the fraction of adjacent vertices landing in different biomes is 41–50%, which is the value you get from **independent random draws**.

**Target.**

- **Ten synthesised materials, two `Texture2DArray`s (3-1).** Array A = linear albedo RGB + surface height in A; Array B = normal.xy in RG, roughness in B, cavity AO in A. 512² at Low/Balanced/High, 1024² at Ultra only (review's memory cut: −65 MiB). Per-material world tiling periods are **mutually prime** (grass 2.4 m, forest floor 3.1 m, scree 3.7 m, sand 4.3 m, rock 5.7 m, snow 6.9 m, asphalt 7.4 m, concrete 9.1 m) so two layers never repeat in phase. Every noise primitive must be **periodic on the texture's cell grid** — wrap cell indices modulo the octave frequency, exactly as the deleted `periodicNoise01` did.
  *(Shipped `3-1`, 2026-08-19: the eight periods above are **not** mutually prime — as decimetres, 3.7 and 7.4 are an exact 2:1 and 24/57/69 share a factor of 3 — so every period is now a distinct prime number of decimetres, assertion 52. Two further storage decisions were forced by shipping RGBA8 arrays and are recorded in `PHASE_3_EXECUTION_PLAN.md` §14.2 D-3-8: albedo is stored as `sqrt(linear)` and squared on read, because linear RGBA8 leaves forest floor a dozen usable levels; and every layer is high-passed against its own local mean, because a layer that still carries metre-scale energy at mip 6 shows its whole tiling period as a quilt.)*

  Two recipe details carry disproportionate weight. **Rock:** two directional fracture families as half-plane bands at ±dip with per-block random phase — this is what makes rock read as bedding and jointing rather than crumple — plus roughness 0.45–0.72 **with ±0.08 variance per block**. Adjacent blocks having visibly different gloss is by itself most of the difference between rock and plastic. **The mip reducer:** average the normal *vector*, renormalise, and fold the lost length back into roughness with a Toksvig term, `rough' = sqrt(rough² + k·(1 − |avgN|))`. Five lines, and the single most important anti-plastic measure at distance — without it, distant terrain gets a false sharp highlight from a normal map that has been averaged into flatness.
- **The plugin (3-2).** `TerrainSurfacePlugin extends MaterialPluginBase`, constructed with `enable = false` (as `CloudShadowMaterialPlugin.ts:87-94` does) so a shader is never compiled with unbound samplers. Roughness and AO cannot be set from any standard hook — `CUSTOM_FRAGMENT_BEFORE_LIGHTS` runs before they exist — so use the `!regex` injection form against `pbr.fragment.js:240` and `:245`. **Note the shipped WGSL is minified with no spaces around `=` and three declarations on one line at `:240`**; anchor the regexes tightly and keep the compile-time assertion test, which is the only thing that will catch a Babylon bump. A texture needed in both stages must be declared in **both** `CUSTOM_VERTEX_DEFINITIONS` and `CUSTOM_FRAGMENT_DEFINITIONS` — `getSamplers` has no shaderType parameter; visibility is derived from where the declaration is emitted.
  Per-page addressing costs zero net memory: `TerrainClipmapSystem.ts:530-543` already allocates a `Float32Array(vertexCount*4)` colour buffer whose alpha is a constant 1. Repurpose it 1:1 as `terrainPageAddress = (pageU, pageV, atlasSlot, spare)` and set `mesh.useVertexColors = false`. *(Shipped `3-2` with the execution plan's lane layout instead — `(materialIdA, materialIdB, weightB, atlasSlot)`, per Phase 4 §4 D4 — and `useVertexColors = false` as stated.)*
- **The classifier (4-6).** Replace `classifyBiome`'s threshold cascade with ten smooth suitability functions, softmaxed, top-4 renormalised. Drivers: elevation with a **real 0.0065 K/m lapse rate** (replacing the ad-hoc `/2450` at `terrain.ts:205`); slope measured **at the page's own texel spacing** from the page's own gutter-bearing grid — a 40 km mountain face must be classified by the visible face, not by 4 m microslope; aspect against sun azimuth and prevailing wind (`src/world/wind.ts` already exists); moisture with an orographic term; a topographic wetness index (real `ln((1+A)/(tan S + ε))` once erosion lands, a curvature-convergence proxy before then, swappable in one line); soil depth `exp(-slope/0.35)·(0.4 + 0.6·saturate(0.5 − k·curvature))`; and a snow-pack logistic that bares off cliffs and sticks on lee flats, **offset by the seasonal temperature lapse from `dayOfYear`** so the snowline migrates rather than switching (§1.6).
  **The specific fix for iso-contour boundaries:** perturb the *drivers*, not the outputs — `elev += fbm(x/430)·38 + fbm(x/95)·9`, `moisture += fbm(x/210)·0.12`, `T += fbm(x/310)·0.9 K` — and jitter the softmax temperature itself, `τ = 0.09·(1 + 0.6·fbm(x/70))`, so ecotone *sharpness* varies. Uniform-sharpness boundaries are as much a tell as straight ones.
  **Supersample 2×2 per texel and average the weight vectors, not the argmax.** This is the prefiltering that per-vertex point classification structurally cannot do, and it is the albedo analogue of band-limiting: it is what makes a coarse page a *filtered* version of the fine page rather than a different one.
- **Sampling (3-4, 3-5, 3-6).** Three decorrelated rotated world scales (macro ~2048 m, patch ~176 m at 13.7°, micro ~28 m at 61.2°) with `uv_{n+1} += (rgb_n.rg − 0.5)·warpAmount`, footprint-faded with the deleted build's tuned bands. True triplanar **texture** projection above `1 − |n.y| > 0.22`, with sign-flipped per-plane UVs (untreated, this produces a visible reflection seam down every ridge), `textureSampleGrad` with explicit gradients (implicit derivatives under branchy weights produce hard mip bands across slopes), and RNM normal blending in world space (never lerp tangent-space normals). N-way height blend `k_i = h_i + w_i; b_i = max(k_i − (max k − d), 0)` with `d = mix(0.06, 0.5, saturate(fp/3))`.

**Cut:** hex-tiling, the CPU classifier, the separate GPU classifier port. *(Seasonal variation is no longer cut — see §1.6.)*

### 3.3 Water

**Today.** Ocean is a `ShaderMaterial` (`SpectralOceanSystem.ts:832`) whose fragment shader ends at `:421` with no distance term — and Babylon's `ShaderMaterial` has **no fog path whatsoever**. The ocean draws to 120 km fully saturated while terrain at 120 km is 100% fog colour. `HydrologyGeneration.ts:317-400` traces rivers with a greedy 16-direction walker at 90 m steps; it is working correctly and faithfully reporting that the field it was given has no drainage. Nothing writes back into height, so rivers are flat blue ribbons on slopes, sometimes ending in mid-air.

**Target, in four layers:**

1. **Optics on the existing surface (Phase 1–2).** Aerial perspective and earth curvature (1C-7). Slope-not-normal storage with mipping and Toksvig variance → roughness (2-8) — the fix that turns distant sea from a boiling sparkle field into a smooth, matte, correctly-hazed surface. One solid-angle-correct sun lobe via Karis's representative-point method with `alpha' = clamp(alpha + sunAngularRadius/(2·distanceToHorizon), alpha, 1)` and energy normalised by `(alpha/alpha')²`; lit Lambertian foam with an advected Worley break-up mask; wave-crest subsurface scattering driven by the summed displacement's `y`, which the vertex shader already computes at `:288-292` and currently discards (2-9). Environment cube reflections from the shared IBL probe, `roughnessToMip` calibrated so α = 0.075 lands at mip 0 and α = 0.34 at mip 2 — water roughness never exceeds ~0.34, so a box mip chain suffices and no GGX convolution is needed.
2. **Depth (Phase 5).** A 2-level toroidal bathymetry clipmap, then Beer-Lambert with real absorption coefficients (~0.45/0.07/0.02 m⁻¹ RGB for clear water — red is absorbed 20× faster than blue, which is *why* deep water is blue), analytic Snell-refracted bed shading against the terrain albedo (stable, works off-screen, needs no scene colour copy), single-scattering turbidity (what makes shallow water *glow* rather than being a dark bed seen through a filter), and a soft shoreline `alpha = smoothstep(0, 0.4 m, depth)`. Handle the camera below the surface: flip the normal, swap to total-internal-reflection Fresnel (critical angle 48.6°, giving Snell's window), and apply Beer-Lambert as a fog.
3. **Geometry (Phase 5).** Rivers and lakes rebuilt from the erosion pass's channel graph and lake mask, with widths from hydraulic geometry (`w ∝ Q^0.5`, `d ∝ Q^0.4`, `Q = k·A^0.7`) **exported rather than recomputed**, so carving and rendering agree exactly. Five ribbon lanes with a feathered outer pair; arc-length resampling and a proper Frenet frame so banks stay perpendicular through tight bends; confluences merged at the junction node rather than overlapping ribbons; lakes from marching squares → Douglas-Peucker → ear clipping with holes, every vertex at the exported spill elevation so the surface is exactly flat; deltas where the graph reaches the sea.
4. **Motion (Phase 6).** Dual-phase flow-map advection (Vlachos), three scales with independent speeds, amplitude scaled by exported flow speed; world-locked standing waves where grade is steep — real rapids are water moving *through* a wave that stays put; fetch-limited lake chop so a pond stays glassy and a big lake gets real chop; depth-driven surf with Hunt run-up; Jacobian caustics.

**Cut:** SSR, the second shallow-water FFT cascade set.

### 3.4 Clouds

**Today.** Three compounding defects, all verified — see §4 for the rotation bug specifically. Beyond that: density is evaluated analytically with ~80 ALU hash ops per sample; the shape has no weather map, no vertical profile and no cloud types; the field visibly repeats; and the lighting has no multiple-scattering approximation.

**Target.** Bake tileable 3D Perlin-Worley base, detail and curl volumes once at startup (~20 ms, 8.1 MiB) and replace analytic density with 1–2 volume fetches — 3–6× cheaper per sample, which is the budget that buys everything else. Then a weather map driving coverage, cloud type and base height; per-type vertical profiles giving cumulus a flat base and a cauliflower top and stratus a flat sheet; coverage-driven remap; detail erosion at the edges. Toroidal weather clipmap plus dual-scale shape sampling so a 200 km leg never shows the same group twice. Lighting: multiple-scattering octaves (energy, extinction and phase each decaying per octave), directional powder, dual-lobe Henyey-Greenstein with a silver lining — fix the phase and MS constants from the literature first and tune only `densityMultiplier` and extinction, because this is easy to over-tune into milk. Distance-adaptive step length with empty-space skipping and a low-resolution coverage prepass: 2–4× fewer samples at equal quality. Wind shear between the deck's base and top (3 lines) so cumulus lean downwind instead of standing as vertical pillars.

Cloud shadows get a sun-space orthographic footprint (removing the `1/sunDirection.y` blow-up), 512² over 24 km = 47 m/texel, and a single-altitude coverage approximation instead of a 14-step vertical march — 0.26 M density evaluations per update versus 3.7 M for a naive march, i.e. *cheaper than today* while 7.5× sharper. Shadow strength is multiplied by the fragment's aerial-perspective transmittance so distant terrain is not double-darkened by shadows it should be too hazy to show.

**Cut:** the separate cirrus ray-march slab (wind shear is kept).

### 3.5 Vegetation, ground cover and rocks

**Today.** `createTreeCrown` (`WorldDetailRuntime.ts:1063-1092`) builds 9-sided opaque cones and icospheres. Placement uses cluster/patch lattices with a measured **176 m period** — roughly 20× a tree crown diameter, hence glaring — and an O(n²) all-pairs Poisson filter (~73k pair tests per cell). Generation runs inline on the main thread at 3.09 ms per 512 m cell against a 2 ms budget. Nothing in `detail/` reads `airportInfluence`, so trees grow across the graded apron. There is no ground cover at all.

**Target.**

- **Removal (1B-5).** Villages, buildings, the road prop: delete, do not flag. Dead-but-compiling code is exactly what produced the 1,100-line orphaned `payload.ts`. Hangars stay behind a flag (§1.5).
- **Placement (1B-7, 1B-9).** One continuous density function, never a switch: lapse-rate elevation, moisture as a smoothstep, slope as a soil-retention proxy falling to zero by ~38° (the angle of repose), **aspect** (`dot(normalize(n.xz), sunwardXZ)`) giving conifers on cool north faces and open grass on warm south faces at ±25% density plus a strong species shift, a ragged treeline `base + aspect·120 + shelter·80 + fbm(p/2400)·90` with tree *height* scaled by the same factor so trees become 2 m krummholz before disappearing, and multiplicative glade and disturbance fields. **Clumping expressed as a field has no centre and no radius, therefore nothing circular to see** — this is the precise answer to "NO artificial clusters of trees."
  Scatter: a jitter grid whose cell size is a *continuous function of local density*, `clamp(sqrt(1/density), 3, 90)` m — because the period varies continuously with a continuous field, **no constant period exists anywhere in the image**. Plus a domain warp `p += 0.6·cell·vec2(noise(p/37), noise(p/37+91))` and O(n) rank-order thinning replacing the O(n²) filter. Placement stays a pure function of world position, so page boundaries can never be visible and floating-origin rebases can never make anything slide.
  Guarded by a spectral regression test that lands **first**: no peak outside DC and the intended 220 m/380 m ecological bands above 1.15× the local radial mean; a 16-bin phase histogram within [0.92, 1.08] of uniform for any candidate period 3–200 m (today's code measures 0.83–1.17 and would correctly fail).
- **Appearance (2-11 … 2-17).** Alpha-tested foliage cards on species-specific branch skeletons, hemispherically distributed and tilted outward so the crown reads as volume from every angle; **rendered trunks with per-species taper, root flare, a primary fork on broadleaves and a per-instance lean**; three to five crown variants per species so neighbours are not clones, plus per-instance character modifiers (lean, broken top, thinned crown) from the spare bits of the variant byte; **per-instance tint with real hue and saturation variance, stand-correlated, not a brightness multiplier**; **baked crown occlusion so interiors are darker than sunlit tips**; generated tangents (which do not exist anywhere in this codebase, and without which Babylon's `NORMALMAP` path is unreachable); `subSurface.isTranslucencyEnabled` with intensity ~0.8 — **backlit foliage glowing instead of crushing to black is the strongest single not-plastic cue for vegetation**. Grass as patches (12–16 crossed tapered blades, ~48 tris, 2.5 m²) with a `1/d` density ramp so *screen-space* blade density is roughly constant, plus ferns/heather/reeds at ~15% of the budget, habitat-weighted rather than sprinkled uniformly, so the world is not one uniform green fuzz. **Ground clutter — fallen logs, stumps, branch litter and moss cushions — rides the rock instancing path, denser under canopy and in hollows.** Shrubs are card geometry on the same terms as trees, not smooth blobs beside them. Rocks as displaced icospheres with per-lithology flat-vs-smooth normals (the shading-model difference reads as lithology more than colour does), aligned ~60% toward the terrain normal, sunk by `radius·(0.12 + 0.25·hash)`.
- **Handoff (6-8).** Beyond the impostor radius, canopy closure becomes a terrain splat channel: albedo mixes toward a dark desaturated canopy texture, roughness toward 0.96, `ao *= 1 − 0.35·closure`, and canopy height is added to terrain height at LOD ≥ 3 only (128 m+ spacing, canopy scale far below Nyquist) so a forested ridgeline silhouette is right. The ramp is exactly complementary to the impostor dither fade, so coverage is conserved and there is no seam.

### 3.6 Lighting, atmosphere and post

**Today.** Three lines of `FOGMODE_EXP2` with one `Color3` (`AtmosphereSystem.ts:265-267`), no height falloff, no view-direction dependence, and **5× weaker than the pre-migration build**. Water and clouds receive none of it. `scene.environmentTexture` is never set, so `environmentIntensity = 0.64` / `0.7` / `0.62` are dead uniforms and `finalIrradiance`/`finalRadianceScaled` are compiled out. The entire indirect budget is one unshadowed `HemisphericLight` at 0.203 against direct 4.657 — 4.4% of the light budget where clear-midday diffuse is 10–15%. Exposure is applied three times on different curves.

**Target.**

- **`aerial-include` (1C-4) — analytic, not a froxel volume.** This is a deliberate architectural choice with three reasons specific to this renderer: (1) a froxel volume is built from one camera's frustum, and this renderer needs haze on three cameras — main, planar reflection, and six IBL faces; (2) 32 depth slices over 45 km are 1.4 km thick, unusable near the camera without depth linearisation against a reversed-Z buffer this codebase does not expose; (3) Apple Silicon has abundant ALU and constrained bandwidth, so ~60 ALU + 2 LUT fetches is the cheaper resource.
  The integral, in closed form: for a ray of length `d` from camera altitude `h0` to fragment altitude `h1`, optical depth per exponential species is exactly `τ = σ·H/sin θ·(exp(−h0/H) − exp(−h1/H))`, with the `sin θ → 0` limit `d·exp(−h0/H)`; `H` = 8000 m (Rayleigh), 1200 m (Mie); ozone via the standard tent integrated in closed form. In-scatter uses the **same** Rayleigh `3/(16π)(1+μ²)` and Henyey-Greenstein phase functions the sky uses, so haze and sky agree by construction. Height falloff is what makes looking *down* from cruise clear instead of milky — the view you spend most of a flight in.
  **Two guards, both load-bearing.** The hook is `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` (`pbr.fragment.js:624`), immediately after `pbrBlockImageProcessing`, which under `IMAGEPROCESSINGPOSTPROCESS` is only a clamp — so `finalColor` is linear HDR there. That depends on `applyByPostProcess === true`; **assert it at startup**. And `#include<fogFragment>` runs at `:622`, so `scene.fogMode` must be `FOGMODE_NONE` or fog and AP both apply; **assert that too**.
  Consumers: terrain via the plugin hook, ocean at `SpectralOceanSystem.ts:421`, rivers at `HydrologySystem.ts:539/:258`, vegetation/wildlife/aircraft/airport via an `AerialPerspectiveRegistry` + plugin copying the exact shape of `CloudShadowReceiverRegistry`, and the cloud composite via `applyAerialPerspectiveAtDistance`. Then drop `camera.maxZ` 120 km → 45 km and one terrain ring per tier: beyond 45 km analytic transmittance is under 5%, and L5–L7 are ~16% of all terrain triangles for zero visible contribution. **Net cost is negative.**
- **`ibl` (1C-6).** Diffuse: a TypeScript mirror of `skyRadiance()` evaluated over a 16×16×6 cube of directions → `CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial` — a pure array API, microseconds, testable in Node, no GPU readback. Specular: a 128 px `isCube` RTT, `TEXTURETYPE_HALF_FLOAT`, `gammaSpace = false`, mipped, `CUBIC_MODE`, one face per frame. Assign **before** `scene.whenReadyAsync()` so the `REFLECTION` variant compiles during startup rather than stalling frame one.
  **Three things must happen in the same commit** or the result looks like a regression: raise `specularIntensity` 0.22 → 1.0 and `environmentIntensity` → 1.0 in all three files; retire the `HemisphericLight` (or drop it to ~0.05 as a ground-bounce term) so skylight is not double-counted; validate SH irradiance against the analytic reference (a uniform sky of radiance L must give irradiance πL).
  **Sequencing that the audit is emphatic about: IBL before AO.** Multiplying a 4.4% ambient term by an occlusion factor is invisible. GTAO added first would produce no perceptible change and you would reasonably conclude AO doesn't matter.
- **Occlusion (4-7).** Per-page, one compute dispatch: march 16 azimuths × 24 geometric steps outward on the page's own grid and a coarse global pyramid beyond it; integrate sky visibility in the **GTAO horizon-arc form** against the surface normal (not `1 − mean(sin θ)` — the cosine weighting and normal projection are what make valleys read as valleys rather than a uniform darkening); emit a cosine-weighted bent normal, octahedrally encoded, used as the IBL diffuse lookup direction; store 8 of the 16 azimuth angles as a horizon map. At runtime, interpolate `h(φ_sun)` **in angle, not linearly in the packed byte** (or ridge shadows wobble) and `sunVis = smoothstep(h − δ, h + δ, sunElevation)` with δ from the sun's 0.00935 rad angular diameter so the penumbra is physically sized. Combine with the material's cavity AO as `min(macroV, microAO)`, not a product, so the two do not double-darken.
- **Post.** 4× MSAA (2× at Low), sun-disc bloom thresholded well above any surface radiance so only the disc and specular glitter contribute, and the two-governor controller.

### 3.7 Performance architecture and GPU compute

**Today.** One terrain worker with one job in flight (`TerrainGenerationClient.ts:48,125`) — at High the resident set of ~172 pages is ~3.9 s of wall clock on one core with nine idle. No cache at any layer; rings 0–7 all cover the observer, so the same region is regenerated eight times at eight spacings with zero sharing. `FrameGraph.passTimings` is measured and discarded. The governor takes the **worst** p95 across three streams and lowers pixel count, which cannot move any of the dominant CPU costs — a one-way ratchet, which is mechanically "the graphics have not improved and performance has taken a hit," in one function.

**Target.** §5 for the budget and governors, §6 for the compute inventory. The three structural pieces:

- **`PerformanceBudget.ts`** — per-tier `FRAME_BUDGET_MS` as a per-subsystem record, `estimateGpuMemoryMiB(profile, viewport)` summing every allocation from first principles, `MEMORY_CEILING_MIB`, and `assertWithinBudget()`. Calibrate once against `scene.textures` byte totals plus `engine._bufferManager` and pin a fudge factor.
- **`AdaptiveGovernor.ts`** — two governors, pure functions over sample arrays, fully unit-testable without a GPU (§5.5).
- **`ComputeScheduler.ts`** — registered workloads declare `{name, estimatedMicroseconds(dispatchCount), priority, preemptible, maxSlicesPerFrame}`; a per-frame microsecond budget admits dispatches, carrying unspent budget forward up to 2× for one frame. Erosion's 30–80 iterations are sliced across frames with the page held in a `generating` lifecycle state — the epoch machinery in `world/lifecycle.ts` already models exactly this and is dead code. Cost estimates self-calibrate from the whole-frame GPU counter when only one workload ran in a window, so no per-pass timestamp plumbing is needed. Governor B gains lever 0: shrink the compute budget before touching anything visual.

---

## 4. The cloud bug

The user's most concrete complaint. Three designers gave three mutually exclusive diagnoses; the feasibility review traced the full Y-convention chain independently and settled it. **The root cause below is verified. Do not re-litigate it.**

### 4.1 Root cause

`renderTargetUv()` at `src/render/webgpu/clouds/VolumetricCloudSystem.ts:292-296` is an unconditional vertical mirror whose stated premise is false:

```wgsl
fn renderTargetUv(screenUv: vec2f) -> vec2f {
  // ProceduralTexture's interpolated vUV is bottom-left based, while WebGPU
  // texture coordinates address render targets from the top-left.
  return vec2f(screenUv.x, 1.0 - screenUv.y);
}
```

The premise ignores a compensation Babylon already applies:

1. `Engines/WebGPU/webgpuShaderProcessorsWGSL.pure.js:331` appends `vertexOutputs.position.y = vertexOutputs.position.y * internals.yFactor_;` to **every** non-pure WGSL vertex shader.
2. `Engines/webgpuEngine.pure.js:2833-2834` binds `_ubInvertY` (created at `:501` as `Float32Array([-1, 0])`) whenever `_currentRenderTarget` is set and `_disableEngineYFlip` is false — and it defaults false (`Engines/WebGPU/webgpuRenderTargetWrapper.js:26`). **yFactor = −1 for every render target, +1 for the canvas.**
3. `ShadersWGSL/procedural.vertex.js` sets `vUV = position*0.5 + 0.5`. With yFactor = −1, `vUV.y = 1` → clip y = −1 → framebuffer bottom row → sampled back at texture `v = 1`. **`vUV.y` ≡ texture `v` for any `ProceduralTexture`.**

So the helper introduces a vertical mirror that should not exist. `update()` (`:915-919`) repoints `cloudSampler` at the temporal output whenever it renders (`setTexture("cloudSampler", cloudOutput)` at `:920`), so the mirror is what reaches the screen. **A vertical mirror turns a roll of +θ into −θ, which reads exactly as "clouds rotate with the aircraft."**

The composite (`:366-372`) is **correct**, by cancellation: `webgpuShaderProcessorsWGSL.pure.js:287-293` gates the fragCoord fix on the literal `fragmentInputs.position` (the composite writes `input.position`, so it is never injected) *and* on `yFactor == 1` (the beauty pass renders into an RTT because `ImageProcessingPostProcess` + `FxaaPostProcess` are attached at `FlightRenderer.ts:446-465`). The shell's own geometry flip cancels the top-left fragCoord convention.

**The fix is to remove the spurious flip in the temporal pass, not to add one to the composite.**

### 4.2 The exact fix

**Step 0 — `verify-flip` (2 minutes, do it first).** Bypass the temporal pass for one run and check whether the inversion disappears; then write `vec4f(0, 0, step(0.5, vUV.y), 1)` and check which half of the screen goes opaque. Revert both edits immediately. This is definitive attribution before any real edit.

**Step 1 — `fix-temporal-flip` (0.2 d).** Delete `renderTargetUv()` and **all three of its uses together**. The history fetch currently *accidentally cancels*: history content is `H(v) = T(1−v)`, read at `1−p`, yielding `T(p)` — correct. Removing only the `current` fetch would break reprojection. Call `resetTemporalHistory()` **in the same commit**, or the first frames blend correct current against mirrored history.

**Step 2 — record the latent fragility.** Composite correctness *depends on a post-process being attached*. Remove FXAA + tonemap and the composite inverts. Leave a comment saying so, and keep `composite-postprocess` on the roadmap (it moves the composite to `vUV` and removes the dependency) rather than descoping it.

**Step 3 — `fix-double-blend` (0.3 d).** The composite shell is a BACKSIDE sphere with `backFaceCulling = false` (`:481`), so both hemispheres rasterise and premultiplied blending applies twice per pixel — which is why cloud edges read as a hard grey wall instead of translucent wisps. **Caveat:** `webgpuEngine.pure.js:2798-2803` inverts `frontFace` for render targets, so simply setting `backFaceCulling = true` may cull the wrong hemisphere. Expect to also flip `sideOrientation`; verify visually, then re-tune `densityMultiplier`/`extinctionPerMeter` — the clouds will look thin at first, and that is the correct starting point, not a bug.

> **Phase 0 outcome (2026-08-17): the double-blend mechanism was refuted by measurement.** `tests/gpu/cloud-shell-culling.test.ts` compares a premultiplied 0.5-alpha shell against an idempotent alpha-1 control: the camera-centered shell blends **once** per pixel, cull on or off (each view ray crosses the surface once; the second hemisphere is clipped behind the camera). `backFaceCulling = true` was enabled anyway as protection if the shell ever de-centers — BACKSIDE stays correct in offscreen passes because Babylon's yFactor winding flip and frontFace inversion cancel — and the warmed pipeline descriptor now keys `frontFace: 1` to match. **Consequence for later phases:** no `densityMultiplier`/extinction re-tune happened, and the grey-wall edge appearance, if still observed, is *not* a blending artifact — expect it to be addressed by `2-4 cloud-lighting` (powder/phase/multi-scatter), not by geometry state.

**Step 4 — `getViewMatrix(true)` (part of 1A-4).** `VolumetricCloudSystem.ts:890` calls `camera.getTransformationMatrix()` inside the frame graph's volumetrics phase, *before* `scene.render()`; that method multiplies cached matrices without recomputing. `FlightRenderer.ts:809` lerps FOV every frame, guaranteeing staleness. Call `this.camera.getViewMatrix(true)` at the top of `update()`. This is real, and it causes reprojection drag — but it cannot produce a mirror or a counter-rotation, so it is a second defect, not the cause.

**Step 5 — `basis-reprojection` (1.5 d, gate 1B).** Reproject in camera-relative space using the previous frame's ray basis instead of a cached view-projection matrix, which removes the stale-matrix class of bug by construction. **Correction that must be spelled out or it will be implemented wrong:** the delta camera must be computed from **absolute world positions** across the floating-origin rebase, not from `camera.position`, which is local and jumps 4096 m at `FlightRenderer.ts:869-870` — exactly the frames the item is meant to survive. Put a pure-TS round-trip test in `CloudReprojection.ts` (ray → reproject → same uv).

**Total: ~2.5 days for the user's most concrete complaint, of which the actual rotation fix is 0.3.**

---

## 5. Performance budget

All figures are estimates for the reference machine with a stated range. `perf-harness` (1A-1) replaces them with measurements; expect the first real capture to move several rows by 30–50%.

### 5.1 The machine, stated in numbers

| | Value | Consequence |
|---|---|---|
| GPU | Apple M2 Pro, 16 cores, ~5.7 TFLOPS FP32 | ~2× the ALU the subsystem designs assumed ("8–10 cores, 2.6–4.5 TFLOPS") — the budgets below are correspondingly less tight |
| Memory bandwidth | ~200 GB/s unified | ~2× the design assumption (68–120 GB/s). Still shared with CPU and the browser compositor |
| CPU | 10 cores (6P + 4E); `navigator.hardwareConcurrency` = 10 | Terrain worker pool = `clamp(2, hwConcurrency − 4, 6)` = **6**. Leaves 4 for main thread, sim worker, hydrology worker and browser |
| Memory | 16 GB unified | GPU allocations compete with the browser inside it. Ceilings in §5.2 |
| Display | 3024×1964, DPR 2; CSS window ~1512×982 | **Native DPR 2 is a 5.94 Mpx buffer.** Default must be logical resolution, 1.485 Mpx, with good AA |
| TBDR | Apple tile-based deferred | MSAA costs the resolve, not the full 4× bandwidth. Alpha test defeats hidden-surface removal — keep foliage in a separate render group after opaque terrain |

**The pixel arithmetic is the single largest performance lever in the plan.** `FlightRenderer.ts:903-906` computes `Math.min(2, devicePixelRatio) * renderScale` — a *multiply*, not a cap. At tier 2, `renderScale = 1.0` renders 5.94 Mpx: 61% more than 1440p, on an integrated GPU, before any of this work. Capping Balanced at 1.5 Mpx is a **4.0× reduction in every per-pixel cost** and it is one clamp.

### 5.2 Memory budget (MiB, GPU-resident, estimated)

| Allocation | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Terrain height atlas (r32float, 264² slots) | 38 | 55 | 55 | 71 |
| Terrain channel atlases (splat + surface + occlusion + aux, 136² slots) | 42 | 72 | 87 | 110 |
| Erosion scratch (6 × 384² r32float, reused forever) | 3.5 | 3.5 | 3.5 | 3.5 |
| Material arrays (2 × RGBA8 × 10 layers + mips) | 5.4 | 56 | 56 | 114 |
| *— as shipped at `3-1` (derived from `materialArrayEdge`, not declared)* | *6.7* | *26.7* | *26.7* | *26.7* |
| Shadow maps (depth-only near-field) | 6 | 18 | 27 | 48 |
| Ocean (fp16 FFT working set + slope mips) | 8 | 18 | 20 | 26 |
| Bathymetry clipmap | 1 | 2 | 4 | 4 |
| Clouds (noise volumes + 2 history + shadow) | 12 | 16 | 20 | 26 |
| Vegetation (instances + impostor atlas + foliage/bark/rock/canopy) | 14 | 28 | 38 | 44 |
| Atmosphere LUTs + sky env cube | 1.2 | 1.2 | 1.2 | 1.2 |
| Framebuffers (HDR RGBA16F ×2 + depth32 + bloom) | 22 | 34 | 54 | 90 |
| MSAA (colour + depth, at the pixel cap) | 0 | 72 | 115 | 96 (2×) |
| Misc meshes, pipelines, shader cache | 30 | 40 | 45 | 50 |
| **Estimated total** | **183** | **416** | **526** | **684** |
| **Ceiling** | **260** | **480** | **700** | **1000** |
| Headroom | 30% | 13% | 25% | 32% |

**Framing that makes this palatable:** today's High shadow map alone is **~768 MiB** — larger than this plan's entire Balanced allocation, and ~4.7% of the machine's total 16 GB, for a buffer PCF never reads.

Derivation, verified against Babylon 9.21.2 (both the audit's 512 MiB and an earlier 384 MiB estimate were too low):

- `AtmosphereSystem.ts:196` calls `new CascadedShadowGenerator(4096, sun, true, camera)` — the 5th parameter `useRedTextureType` is **not passed**, and `shadowGenerator.js:634` assigns `this._useRedTextureType = !!useRedTextureType`, so it is **`false`**, not `true`. `shadowGenerator.js:693` therefore selects texture format **5 (RGBA)**, not 6 (R). Babylon's JSDoc at `:556` states the default explicitly: `(default: false)`.
- `usefullFloatFirst = true` selects the `textureFloatRender && textureFloatLinearFiltering` branch first, but `float32-filterable` is absent — `FlightRenderer.ts:319-320` requests only `timestamp-query` with `enableAllFeatures: false` — so it falls through to **half-float** (`_textureType = 2`).
- Net format is **RGBA16F**, 8 bytes/texel: `4096² × 4 cascades × 8 B` = **512 MiB colour**, plus `4096² × 4 × 4 B` = **256 MiB** depth = **768 MiB**.

Because `filter = FILTER_PCF` (`AtmosphereSystem.ts:209`) binds only the depth texture, the entire 512 MiB colour attachment is allocated, cleared and written every frame and never sampled. Work item `1A-5` reclaims it with a depth-only RTT — raising that fix from a rounding error to the single largest memory win in Phase 1.

Balanced is the tightest row at 13% headroom. First cuts if it overshoots, in order: material arrays 256² at Balanced (−28), MSAA 2× at Balanced (−36), channel atlas slot count 196 → 144 (−18).

### 5.3 Redesigned `QualityProfile`

| Parameter | Low | **Balanced (default)** | High | Ultra |
|---|---|---|---|---|
| Frame target | 60 fps | 60 fps | 60 fps | 30 fps |
| `maxRenderPixels` | 1.00 M | **1.50 M** | 2.40 M | 4.00 M |
| Effective DPR on 1512×982 | 0.82 | **1.00** | 1.27 | 1.64 |
| `msaaSamples` | 1 (+ FXAA) | 4 | 4 | 4 |
| GPU memory ceiling | 260 MiB | 480 MiB | 700 MiB | 1000 MiB |
| CDLOD τ / node budget | 4.0 px / 160 | 3.0 px / 240 | 2.0 px / 320 | 1.5 px / 448 |
| L0 texel spacing | 4 m | 2 m | 2 m | 1 m |
| Erosion scope | macro (L8) only | macro + pages L ≤ 3 | all pages | all pages, +50% iterations |
| Erosion compute cap | 0.2 ms | 0.4 ms | 0.7 ms | 1.2 ms |
| Terrain compute cap | 0.4 ms | 0.7 ms | 1.0 ms | 1.6 ms |
| Shadows | 2 × 1024 @ 900 m, PCF | 3 × 1280 @ 1400 m, PCF | 3 × 1536 @ 1800 m, PCSS | 4 × 2048 @ 2400 m, PCSS |
| Material array edge | 256² | 512² | 512² | ~~1024²~~ **512²** *(`3-1`, CPU synthesis — see `PHASE_3_EXECUTION_PLAN.md` §14.2 D-3-2)* |
| Triplanar | off (slope-stretched planar) | 2-axis fast path | 3-axis | 3-axis |
| Height-blend max materials | 2 | 3 | 4 | 4 |
| Ocean cascades / N | 3 @ 128 | 4 @ 256 | 5 @ 256 | 6 @ 256 (+ capillary) |
| Cloud integration scale / pixel cap | 0.30 / 0.35 M | 0.45 / 0.70 M | 0.55 / 1.00 M | 0.70 / 1.60 M |
| Grass radius / patches | 90 m / 6 k | 150 m / 18 k | 220 m / 33 k | 320 m / 52 k |
| Card-tree LOD radius (near + mid) | 700 m | 1,100 m | 1,500 m | 2,000 m |
| Impostor radius | 2.0 km | 3.0 km | 4.0 km | 6.0 km |
| `vegetationDistance` (= impostor radius) | 2.0 km | 3.0 km | 4.0 km | 6.0 km |
| `vegetationDensity` (rendered stems/ha multiplier) | 0.45 | 0.75 | 1.00 | 1.00 |
| Terrain workers | 3 | 6 | 6 | 6 |
| `camera.maxZ` | 45 km | 45 km | 45 km | 45 km |
| Ocean presentation radius | 40 km | 40 km | 40 km | 40 km |

Three tier rules learned from the review's overshoot analysis: **triplanar's 2-axis fast path is mandatory from Balanced up**, not a High-only optimisation; **grass radius is the first knob the tier scales**, because grass is the largest single triangle consumer; **bloom is High+ only**.

> **Enforced 2026-08-19 by the vegetation perf-debt pass.** The card-tree LOD
> radius and impostor-radius rows below are now the rendered-density law's own
> band radii, asserted by `tests/render.webgpu-rendered-density.test.ts` —
> Gate 2C shipped 4.5 km of impostor band at Balanced and 8.0 km at High
> against a table that says 3.0 and 4.0, which is exactly the "sat outside
> every cut ladder" the amendment below describes.

**Three vegetation rows were missing from this table until 2026-08-18 and are now here because they are the rows that actually decide how many plants exist.** `vegetationDistance` and `vegetationDensity` shipped in `QualityProfile.ts` from Phase 1 and appeared in no plan table, so they sat outside every cut ladder — and the shipped tier-2 values (8 km, 1.00) bought roughly 95% more rendered stems than Balanced for a 5.6% increase in the vegetation frame row. `vegetationDistance` is now **defined equal to the tier's impostor radius**: beyond it, `6-8`'s canopy splat is the only vegetation representation, so a value larger than the impostor radius describes plants that are not drawn.

### The vegetation trade-off rule

**When the vegetation frame or memory budget binds, reduce the *number* of plants before the *fidelity* of any plant.**

This is a user decision, recorded 2026-08-18 after flight testing: *"I'm okay with having fewer trees/forests if it means that the trees we do get or the foliage we do get actually look like real foliage/plants."* Three places in this programme already happened to cut count first; none of them said so as a rule, and none of them bound the two rows above. It is a rule now.

**The ordered levers, when the budget binds:**

1. Rendered stems/ha, and grass patch density.
2. Card-tree LOD radius, then grass radius, then impostor radius (and `vegetationDistance` with it).
3. The instance cap.
4. Impostor texels per view — **at Low only**.

**Not budget knobs, at any tier:** foliage quads per crown (`2-12`), crown variants per species (`2-12`), the trunk profile (`2-12`), blades per grass patch (`2-16`), the non-grass ground-cover share (`2-16`), foliage atlas resolution, alpha dilation, coverage-preserving mips (`2-11`), subsurface translucency (`2-12`), baked crown occlusion (`2-12`), or per-instance tint/scale/orientation variance (`2-11a`). These are what make a plant read as a plant. **A world with half as many correct trees is closer to the goal than a world full of cones.**

**The ratchet:** `4-10` and `6-11` may not raise a count row without a fidelity row moving in the same commit, and any surplus that later work frees — `6-8`'s recovered instances, `6-9`'s cheaper scatter — is booked against the fidelity list, not against count.

### 5.4 GPU frame budget at Balanced (1.5 Mpx, 60 fps)

Frame 16.67 ms − 1.5 ms compositor/present/submit − 1.5 ms pacing headroom = **13.7 ms controllable**.

| Row | Target | Range | Note |
|---|---|---|---|
| Terrain raster (CDLOD, 1 draw, ~0.9 M tri, surface + de-tile + 2-axis triplanar + horizon fetch) | 2.6 | 2.0–3.4 | The review found the original 2.6 allocation omitted surface-plugin, de-tiling and triplanar; the 2-axis mandate and 512² arrays bring it back inside |
| Terrain compute (height + normal/AO/horizon), amortised **cap** | 0.7 | hard cap | Not an average — the scheduler enforces it |
| Erosion compute, amortised **cap** | 0.4 | hard cap | |
| Splat/classifier compute, amortised **cap** | 0.25 | hard cap | |
| Shadows (3 × 1280 near field, no terrain, per-cascade culled) | 1.1 | 0.8–1.6 | Terrain leaves the caster list entirely once horizon maps land |
| Water (ocean FFT fp16 0.55 + ocean/river raster 1.05) | 1.6 | 1.2–2.2 | |
| Clouds (integration at 0.45 + temporal + composite + shadow) | 2.2 | 1.7–3.0 | Post-`adaptive-march`; the only subsystem that comes in under its original allocation |
| Vegetation (scatter/cull compute + alpha-tested draws + impostors) | 1.8 | 1.3–2.6 | Alpha test defeats TBDR hidden-surface removal; separate render group after opaque. **Not met — measured 5.0× over at Balanced and quantified 2026-08-19.** Vegetation is a DRAW-CALL workload (2-12: ~26 µs each, Δgpu linear in Δdraws, triangle deltas ~0), draws scale with (chunks × meshes), and §5.3's trade-off rule puts crown variants per species outside every budget ladder — so no permitted lever reaches this row. The perf-debt pass took every one that exists (−1,201 draws across the capture set) and priced the structural remainder: merging crown and trunk into one mesh is fidelity-neutral and takes tier 1 from 347 to 186 draws, with `6-9`'s GPU scatter beyond it. See `renderedDensity.ts`'s `VEGETATION_DRAW_CEILING`. |
| Atmosphere (sky dome; AP is inline in each material) | 0.4 | 0.3–0.6 | |
| Post (bloom + tonemap + MSAA resolve) | 0.9 | 0.6–1.4 | |
| **Total** | **11.95** | 10.0–16.4 | **1.75 ms headroom** at the target |

Ultra (4.0 Mpx, 30 fps, ~30 ms controllable) scales the per-pixel rows by 2.7× and raises quality: terrain raster 6.0, compute caps 1.6/1.2/0.5, shadows 2.6, water 4.0, clouds 5.5, vegetation 3.6, atmosphere 0.9, post 1.9 = **27.8 ms**.

### 5.5 The fixed render-scale governor

Delete `worstFrameTimingPercentile95` (`QualityProfile.ts:164-175`) and its call site. Replace with `AdaptiveGovernor.ts`, all pure functions over sample arrays, fully unit-testable with no GPU.

**Signals** (120-frame windows): `gpuP95` from `engine.getGPUFrameTimeCounter()`, requiring `timestamp-query` and ≥8 fresh samples (reuse the existing `freshFrameTiming` staleness check); `cpuP95` from the existing `performance.now()` bracket; `intervalP95` present-to-present. When GPU timing is unavailable, synthesise `gpuProxy = max(0, intervalP95 − cpuP95)`; if `gpuProxy < 2 ms`, classify CPU-bound and **explicitly do not touch resolution** — today this case silently lowers it.

**Arbiter.** `gpuBound` when `gpuP95 > cpuP95 × 1.15`; `cpuBound` when `cpuP95 > gpuP95 × 1.15`; else `balanced`. Exactly one governor actuates per window in the bound cases.

**Governor A (resolution, GPU-bound only).** Target 13.7 ms (60 fps tiers) / 30.0 ms (Ultra). Step down 0.05 when `gpuP95 > target × 1.10`; up 0.025 when `gpuP95 < target × 0.80`. Cooldown 90 frames down, 240 up (asymmetric, so it does not oscillate). **Floor raised 0.62 → 0.75** — below that the image degrades faster than the frame time improves. **Anti-ratchet:** record `gpuP95` immediately before and after every downward step; if two consecutive downward steps each yield <4% improvement, the workload is resolution-insensitive — restore the pre-step scale, latch `resolutionInsensitive = true`, hand control to Governor B, re-arm after 30 s or a profile change. **Absolute cap:** in `applyRenderScale`, clamp to `min(renderScale, sqrt(maxRenderPixels / cssPixels))` *before* `setHardwareScalingLevel`, and change `Math.min(2, dpr) * renderScale` to a per-tier DPR **ceiling**. Note `adaptToDeviceRatio: false`, so the pixel cap belongs inside `applyRenderScale`.

**Governor B (CPU work, CPU-bound only).** Consumes `FrameGraph.passTimings` — already collected at `FrameGraph.ts:127-132` and currently thrown away — so it knows which pass to cut. Ordered ladder, cheapest-looking damage first, one step per window, two-window hysteresis, recovers one step after 4 consecutive windows with `cpuP95 < 6 ms`:

0. GPU compute budget (erosion/splat/bake cadence)
1. Terrain page requests admitted per frame 8 → 4 → 2
2. Detail cell budget 2.0 → 1.25 → 0.75 ms and cap 24 → 16 → 8
3. Planar reflection cadence 3 → 5 → 8 frames *(row retired once `retire-planar-reflection` lands — reconcile with the budget contract)*
4. Cloud shadow cadence 2 → 3 → 4
5. Active animal budget 128 → 48 → 16
6. Shadow caster distance 2.5 → 1.8 → 1.2 km
7. Vegetation distance −25%

It never touches resolution.

**HUD.** Extend `RenderDiagnostics` (`src/game/types.ts:68`) with `activeGovernor: 'gpu-resolution' | 'cpu-work' | 'balanced' | 'holding' | 'no-gpu-timing'`, `gpuP95Ms`, `cpuP95Ms`, `cpuWorkLevel` (index + which lever moved last), `resolutionInsensitive`, `renderPixels`, `topPassesByCpuMs`, and the collision-fallback counter. Render them in `src/ui/Hud.tsx`. **The user must be able to see why the picture changed.**

> **Phase 0 outcome (2026-08-17), binding on `1A-6b`:** `1A-6a` landed the absolute cap *inside* `applyRenderScale` (`FlightRenderer.ts`), which now returns whether the effective hardware scaling level actually changed and gates `graph.invalidateHistory` on that — so governor steps that the pixel cap absorbs no longer reset cloud history. Engine mapping is three-tier for now: `maxRenderPixels` 1.0/1.5/2.4 Mpx and `maxDevicePixelRatio` 1/1.5/2 on tiers 0/1/2; Ultra's 4.0 Mpx row arrives with this item's four-tier table. **Design input for Governor A's anti-ratchet:** when the cap binds, `renderScale` steps are no-ops on the effective scale — that state is detectable from `applyRenderScale`'s return value and should feed the `resolutionInsensitive` latch directly instead of waiting for two ineffective-step measurements.

---

## 6. GPU compute inventory

All follow the `SpectralOceanSystem.ts` pattern: `new ComputeShader(name, engine, {computeSource}, {entryPoint, bindingsMapping})` with an explicit binding map (`WebGPUComputeContext` throws without it), storage textures via `RawTexture.Create*StorageTexture`, `shader.dispatch(gx, gy, gz)`, `fastMode = true` after a compile barrier. Create pipeline objects **once**; rebind uniforms per invocation.

| # | Workload | Type | Cadence | Texture / buffer formats | Workgroup | Est. cost | Phase |
|---|---|---|---|---|---|---|---|
| 1 | Height generation (2×2 rotated-grid supersample) | compute | ≤2 pages/frame, on demand | r32float atlas, 264² slot | 8×8×1 | ~0.35 ms/page | 4 |
| 2 | Page min/max reduction (CDLOD AABB) | compute | with #1 | r32float scratch | 16×16×1 | <0.05 ms/page | 4 |
| 3 | Depression fill (multigrid Planchon–Darboux) | compute | eager L8 at load; 1–2 pages/frame | r32float ping-pong 384² | 16×16 (18×18 workgroup tile) | ~48 dispatches/page | 5 |
| 4 | Flow accumulation (MFD, atomic-free hierarchical gather) | compute | with #3 | r32float 384² | 8×8×1 | ~120 relaxations/page | 5 |
| 5 | Stream power (implicit FastScape Jacobi) | compute | with #3 | r32float ping-pong | 8×8×1 | 24 iterations/page | 5 |
| 6 | Thermal/talus (mass-conserving, two-pass) | compute | with #3 | rg32float delta | 8×8×1 | 32 iterations/page | 5 |
| | *(#3–#6 combined: ~440 dispatches and ~1.0 ms GPU per page; scratch 6 × 384² r32float ≈ 3.5 MiB reused forever)* | | | | | | |
| 7 | Sky-visibility / bent-normal / horizon bake (16 az × 24 steps) | compute | once per page | rgba8 + rg8, 136² slot | 8×8×1 | ~0.3 ms/page | 4 |
| 8 | Land-cover classifier + splat rasterisation (2×2 supersampled) | compute | once per page | rgba8 array ×2, 136² slot | 8×8×1 | ~0.2 ms/page | 4 |
| 9 | Material array synthesis (10 recipes, periodic noise) | compute | startup + seed change | RGBA8 array 512²×10 ×2 | 8×8×1 | 8–25 ms once | 3 |
| 10 | Material mip reduce (vector-average + Toksvig) | compute per layer, or CPU worker fallback | with #9 | same | 8×8×1 | ~3 ms once | 3 |
| 11 | Atmosphere transmittance LUT (40-step march) | compute | on env change | rgba16float 256×64 | 8×8×1 | ~0.2 ms | 1 |
| 12 | Multiple-scattering LUT (64 dirs × 20 steps) | compute | on env change | rgba16float 32×32 | 8×8×1 | ~0.2 ms | 1 |
| 13 | Sky environment cube + mips | fragment RTT | 1 face/frame | rgba16float 128²×6 | — | ~0.03 ms/frame | 1 |
| 14 | Cloud noise volumes (Perlin-Worley base, detail, curl) | compute 3D | startup | r8unorm 128³ + 32³ + rgba8 32³ | 4×4×4 | ~20 ms once | 2 |
| 15 | Cloud weather clipmap (toroidal) | compute | few k texels/frame | rgba8 512² | 8×8×1 | negligible | 2 |
| 16 | Cloud shadow map (sun-space, single-altitude coverage) | compute | every 2–4 frames | r16float 512² | 8×8×1 | ~0.1 ms | 2 |
| 17 | Ocean FFT (existing, converted to fp16) | compute | per frame per cascade | rgba16float 256² ping-pong | 8×8×1 | ~0.55 ms total | 1 |
| 18 | Ocean slope derivation + mip reduce | compute | per frame per cascade | rgba16float mipped | 8×8×1 | +0.02 ms | 2 |
| 19 | Bathymetry clipmap update (toroidal strip copy) | compute | on camera texel crossing | r16float 1024² ×2 | 8×8×1 | <0.05 ms | 5 |
| 20 | Vegetation scatter (density → candidate instances) | compute | on cell change | `StorageBuffer` (Storage \| Vertex) | 64×1×1 | <0.5 ms | 6 |
| 21 | Vegetation cull + LOD partition + count | compute | per frame | `StorageBuffer` + indirect | 64×1×1 | ~0.3 ms @ 400 k | 6 |

Two platform notes that will otherwise cost a day each:

- **3D storage textures are fine.** Babylon's WGSL processor maps 3D texture functions (`webgpuShaderProcessorsWGSL.pure.js:~195`) and 3D storage textures are WebGPU core. Ship #14 as 3D; the `texture_storage_2d_array` workaround is unnecessary.
- **Storage textures can only be written at mip 0.** `webgpuHardwareTexture.js:71-78` always creates `viewForWriting` with `mipLevelCount = 1, baseMipLevel = 0`, and `ComputeShader.setStorageTexture` takes no mip index. See §7 R6.

---

## 7. Risks and fallbacks

**R1 — `MaterialPluginBase` vertex participation, and shadow casters.** *Verified supportive:* `webgpuShaderProcessor.js:89` / `webgpuShaderProcessorsWGSL.pure.js:210` derive bind-group visibility from the stage the WGSL declaration appears in, so a texture declared in `CUSTOM_VERTEX_DEFINITIONS` gets VERTEX visibility; `getAttributes`, `getUniforms({arraySize})` and the `!regex` replacement all exist. **Fatal as originally written:** `Lights/Shadows/shadowGenerator.js` builds its own shadow-map effect and never consults the plugin manager (zero hits for `getCustomCode`, `pluginManager`, `customShaderNameResolve`). Terrain displaced only in the PBR vertex shader would cast shadows from the undisplaced flat grid, and alpha-tested foliage would cast solid cone shadows.
> **Corrected approach:** `material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene, { remappedVariables: [...] })` — honoured at `shadowGenerator.js:940` and `:1137-1145`, and it re-uses the base material's vertex shader so plugin code participates. Applies to `vertex-displacement` (4-4) and `card-trees` (2-12); +1 day each, already in the numbers. **Mitigation: the 1-day spike (1A-7) on day one, before any commitment.** Fallback if it fails: a dedicated `ShaderMaterial` for terrain — the ocean already does this successfully — at the cost of reimplementing PBR, CSM receiving and the cloud-shadow plugin.
> **Phase 0 outcome (2026-08-17): validated — the fallback is not needed.** The spike ran as an automated GPU test (`tests/gpu/shadow-depth-wrapper.test.ts`) and the premise holds, composed with `CloudShadowMaterialPlugin` on the same material. Two corrections to the incantation above, binding on `2-12`, `3-2` and `4-4`: **(a)** no `remappedVariables` are needed for a `PBRMaterial` with plugins in WGSL; **(b)** the wrapper must be constructed and assigned **before the material's first effect compiles** — it learns about base-material effects only through `onEffectCreatedObservable`, and attached later it silently falls back to the undisplaced default depth pass. Create wrapper at material construction time, always. Verbatim record in `ARCHITECTURE.md`.

**R2 — Erosion: seam exactness and parameter tuning. Most likely item to slip.** The seam theorem holds only if every operator really propagates ≤1 texel/iteration; the multigrid depression fill does not, which is why it is confined to the coarse eager levels. A per-page priority flood gives a lake straddling a seam two different surface elevations, which tears visibly.
> **Fallbacks:** (a) the coarse global flood at L8 is the **sole authority** on base levels and lake spill elevations — fine pages may refine an existing lake but may never create one; (b) build the false-colour flow-accumulation / lake-depth dev overlay **before** tuning anything visual — non-optional; (c) the 17 days budgeted here are already 1.5× the design estimate, with a stated range of 15–25.

**R3 — Frame and memory budget overshoot at Balanced and High.** Summing every design's own claims gave ~17–19 ms against a 13.5 ms allocation and ~707 MiB against 550. The cut ladder is already applied in §5.2/5.3: material arrays 512² except Ultra, one merged page-channel atlas family, MSAA 2× at Ultra, 2-axis triplanar mandatory from Balanced, grass radius as the first knob, hex-tiling cut.
> **Fallback: enforce it in CI** via `assertWithinBudget()` from gate 1A, so overshoot fails a test instead of being discovered by the user.

**R4 — GPU-driven indirect draws depend on Babylon private state.** `_currentDrawContext.indirectDrawBuffer` and `setIndirectData`'s instance-count early-return are verified present in 9.21.2 but are not public API. **Additionally missed by both designs:** `indirectDrawBuffer` lives on a **per-DrawWrapper, per-render-pass-id** `WebGPUDrawContext`. A mesh drawn in the main pass, N shadow cascades and the reflection pass has a *different* indirect buffer per pass, each with its own `_currentInstanceCount`. Writing one from compute fixes exactly one pass.
> **Corrected approach:** GPU-cull the main pass only and use a conservative count for shadow/reflection passes (+1 day, in the numbers). **Make the CPU-readback count path the default**, with indirect behind a startup capability assertion that fails loudly, plus a unit test asserting the private field still exists so a Babylon bump fails in CI rather than silently in the renderer. Pin `@babylonjs/core`.

**R5 — No measurement harness exists, and almost every item is a visual change with no unit-testable output.** The audit's closing paragraph identifies missing measurement as *the reason the regressions went unnoticed*: reading the project's own documentation does not reveal that texturing, AO and ground cover were dropped.
> **Fallback: none. Build it first (gate 1A).** Fixed seed, fixed camera, DPR 1, 1280×720, three shots (500 ft AGL, 10 km slant, 10,000 ft looking down). Headless-GPU jobs on a self-hosted macOS runner or a documented local `npm run perf:capture`; the pure-function budget assertions need no GPU and run in normal CI.

**R6 — Storage textures cannot be written at any mip but 0.** `webgpuHardwareTexture.js:71-78`; `ComputeShader.setStorageTexture` takes no mip index. So "a compute mip-reduce kernel writing the full mip chain" is not expressible.
> **Corrected approach for `ocean-slope-mips`:** once *slopes* (not normalised normals) are stored, a plain box filter is correct, so call `engine._textureHelper.generateMipmaps(hwTexture, mipCount, 0, encoder)` directly. Private API — add a startup capability assertion. Verify the texture carries `RENDER_ATTACHMENT` usage; a STORAGE-only texture cannot be mipmapped by Babylon's render-based generator, and `rgbaStorage` (`SpectralOceanSystem.ts:430-452`) currently passes `generateMipMaps = false`. Fallback: a chain of `ProceduralTexture` passes into a mipped RTT.
> **Separate, verified issue for `material-array-gpu`:** `thinWebGPUEngine.js:89-91` calls `generateMipmaps(..., faceIndex 0)` and `webgpuTextureHelper.js:716` treats faceIndex as the *layer* — so **only layer 0 of a 2D array gets mips**. Implement the CPU-reduce + `RawTexture2DArray.updateMipLevel(data, level)` fallback **first**, because it is the path that certainly works; the per-layer loop is the optimisation.

**R7 — fp16 FFT underflow.** Covered in 1B-13. The failure mode is silent: you lose the small waves and get banding on cascade 0.

**R8 — CPU/GPU kernel divergence far from the origin.** Covered in §1.3. The failure mode is a parity test that passes near the origin and a sim that breaks at 500 km.

**R9 — Physics/render mismatch.** Covered in §1.3 with four named holes and their fixes. **A mismatch is game-breaking; treat every item in that subsection as a hard gate on the Phase 5 merge.**

**R10 — Seed churn and screenshot baselines.** Three items change every seed's world: `unitFloatFromHash` (4-1, slightly), `tectonic-skeleton` and `hierarchical-page-erosion` (5-8, 5-4, completely). **Land them together so the baselines rebase once.** *(Phase 0 outcome, 2026-08-17: the `unitFloatFromHash` change was pulled into `0-4` and has already landed — measured churn is < 0.2 mm of terrain, every threshold test passed unchanged, and no screenshot baseline existed to rebase. Only the Phase 5 pair remains as a churn event; do not re-land the hash change at `4-1`.)* Related open question: erosion is iterative floating-point on the GPU — deterministic on a given device, not guaranteed identical across GPU vendors. If anything ever needs cross-machine reproducibility (replays, shared seeds, server validation), the collision mirror must become the transmitted authority rather than something each client regenerates.

**R11 — MSAA mechanics through a hand-built post chain.** `antialias: false` is confirmed at `FlightRenderer.ts:323` and the chain is hand-built at `:446-465`, not `DefaultRenderingPipeline`. Setting `toneMap.samples` is the documented route, but the multisample colour and depth attachment sample counts must agree, and the scene depth buffer is created by the first post-process's RTT.
> **Widen the spike to cover:** the ocean/hydrology `ShaderMaterial` passes, which now rasterise into a 4× target, and the cloud composite's pinned `z = w × 1e-7` under reversed-Z GEQUAL. Fallback: `DefaultRenderingPipeline` with `samples = 4`. Note alpha-to-coverage is off, so alpha-tested foliage gets **no** MSAA benefit — MSAA fixes ridge lines, runway edges and wing silhouettes, not tree canopies. `enableSpecularAntiAliasing` + `anisotropicFilteringLevel = 16` + the Toksvig mip term cover what MSAA misses.

---

## 8. Measurement

**Nothing in this plan is considered done until it is measured.** The audit is explicit that missing measurement is why the regressions went unnoticed.

### 8.1 Instrumentation (gate 1A)

- `FrameGraph.passTimings` surfaced through `RenderDiagnostics` as ring-buffered p50/p95 per pass. Zero new measurement code — it is already computed and discarded.
- **Budget probe mode.** Babylon exposes only whole-frame GPU time. Rather than fork its timestamp plumbing, exploit `FrameGraphPass.enabled: () => boolean` (`FrameGraph.ts:30`): cycle each pass off for 120 frames, record the `gpuP95` delta, attribute it. One sweep of 6–10 passes takes ~15 s and produces an honest per-pass GPU table. HUD-triggered, never in normal play.
- **Counters:** dispatches/frame, compute invocations/frame, page-atlas occupancy, cache hit rate, workers busy, bytes uploaded/frame, estimated vs actual GPU memory, and **collision samples served by fallback**.
- **HUD governor panel** per §5.5, so the user can answer "did that change help?" with a number.

### 8.2 CI assertions (no GPU required)

| Assertion | Guards against |
|---|---|
| `estimateGpuMemoryMiB(tier) ≤ MEMORY_CEILING_MIB[tier]` at 3 viewport sizes | Memory overshoot |
| Declared per-subsystem ms sums ≤ `FRAME_BUDGET_MS[tier]` | Frame overshoot |
| Governor state machine on synthetic traces: a CPU-bound trace (cpuP95 22 ms, gpuP95 6 ms) leaves `renderScale` unchanged over 50 windows and moves `cpuWorkLevel`; a GPU-bound trace lowers resolution and stops after two ineffective steps | The ratchet returning |
| Terrain ring coverage vs `camera.maxZ`, and aerial-perspective opacity at the outermost ring | The README's false claims |
| Band-limit: RMS error vs a 12×12 box average < 0.25 × spacing at 32/64/128/256/512 m | Horizon crawl |
| Height invariance under filter width at L0: `\|h(x,z,0) − h(x,z,8)\| < 1 mm` | Physics/render divergence in Phase 1 |
| Erosion seam: pages (0,0) and (1,0) **exactly equal** on the 4-texel overlap | Visible page seams |
| Pit density < 0.1/km² at 50 m sampling | Undrained basins (today: 8.5/km²) |
| 500 m transect FFT: smooth power law to ~6 m | The 8–43 m spectral hole (today it cliffs at 43 m) |
| 20 m RMS curvature contrast valley:crest ≥ 3:1 | Uniform roughness (today 1.18:1) |
| Gradient-orientation anisotropy in the 30–50° band < 1.3:1 globally | The 35° world grain (today 2.7:1 at every scale) |
| Scatter spectrum: no peak outside DC and the 220/380 m bands above 1.15× radial mean; phase histogram in [0.92, 1.08]; stems/ha in [300, 800] in forest | The tree lattice returning |
| Cross-level splat consistency: a level-N page equals the box average of its four children to within quantisation | Distant terrain re-rolling its colours |
| Foliage mip-N alpha coverage within 3% of mip-0 | Distant foliage evaporating |
| No shader source in `src/` contains an exposure multiply | Triple exposure returning |
| The Babylon regex injection tokens appear in the processed effect source | A Babylon bump silently reverting roughness to 0.93 |
| Indirect-draw private-field capability assertion | A Babylon bump silently breaking vegetation |
| `getAirportInfluence === 1.0` everywhere inside the apron | Runway spawn and friction breaking |
| `sim.flight.test.ts`: ground clearance never negative; fallback counter zero below 500 m AGL | Aircraft sinking into or floating above terrain |
| SH irradiance for a uniform sky of radiance L equals πL | A silently wrong IBL |
| fp16 FFT intermediates: upper bound < 60000 **and** lower bound > 1e-3 on the largest cascade | Underflow banding |
| README/PERFORMANCE.md values read from the profile table | Documentation drifting from code again |

### 8.3 GPU-dependent (self-hosted macOS runner or local)

- `npm run perf:capture` — fixed seed, fixed camera, fixed weather/time, DPR 1, 1280×720. Three shots: 500 ft AGL on approach, 10 km slant range, 10,000 ft looking down. Tile-wise mean/variance + small SSIM against committed baselines with a tolerance; numeric report stored as an artifact.
- **Kernel parity:** `|h_GPU − h_CPU| < 0.05 m` over 4,096 Halton points at five filter widths, sampled both near the origin **and at |x| = 5×10⁶ m**.
- Shader compile assertions for every WGSL include.

**Gate every future change on the screenshot pair. Backend choice is not a quality lever; a screenshot is.**

---

## Appendix: work item index

| ID | Item | Phase | Days | Depends on |
|---|---|---|---|---|
| 1A-1 | perf-harness | 1A | 3.0 | — |
| 1A-2 | frame-budget-contract | 1A | 2.0 | — |
| 1A-3 | webgpu-test-harness | 1A | 1.0 | — |
| 1A-4 | cloud bug: verify-flip → fix-temporal-flip → fix-double-blend → getViewMatrix(true) | 1A | 0.8 | — |
| 1A-5 | csm-memory (depth-only RTT) | 1A | 0.5 | — |
| 1A-6 | split-governor + pixel cap + DPR clamp | 1A | 2.0 | 1A-2 |
| 1A-7 | vertex-plugin + ShadowDepthWrapper spike | 1A | 1.0 | — |
| 1B-1 | normals-from-grid | 1B | 1.5 | — |
| 1B-2 | bandlimit-reference | 1B | 2.5 | 1B-1 |
| 1B-3 | lod-ladder-and-altitude *(interim)* | 1B | 0.5 | — |
| 1B-4 | terrain worker slot map (6 workers) | 1B | 0.5 | — |
| 1B-5 | remove-buildings | 1B | 0.5 | — |
| 1B-6 | detail-exclusion-mask | 1B | 0.75 | 1B-5 |
| 1B-7 | placement-density-field | 1B | 2.5 | 1B-6 |
| 1B-8 | grid-regression-test | 1B | 0.5 | 1B-7 |
| 1B-9 | blue-noise-scatter | 1B | 2.0 | 1B-8 |
| 1B-10 | detail-worker-offload | 1B | 1.5 | 1B-9, 1B-4 |
| 1B-11 | msaa + FOV fix | 1B | 1.5 | 1A-5 |
| 1B-12 | basis-reprojection | 1B | 1.5 | 1A-4 |
| 1B-13 | ocean-fft-halfprecision | 1B | 1.0 | — |
| 1C-1 | env-director (NOAA solar, dayOfYear) | 1C | 2.5 | — |
| 1C-2 | single-exposure | 1C | 1.5 | 1C-1 |
| 1C-3 | atmosphere-luts | 1C | 2.0 | 1C-1 |
| 1C-4 | **aerial-include** | 1C | 5.0 | 1C-2, 1C-3 |
| 1C-5 | physical-sky | 1C | 2.0 | 1C-4 |
| 1C-6 | **ibl** (+ specularIntensity 1.0, retire HemisphericLight) | 1C | 3.0 | 1C-5 |
| 1C-7 | water AP + earth curvature + 40 km ocean radius | 1C | 1.0 | 1C-4 |
| 1C-8 | clouds radiometry-and-haze | 1C | 1.5 | 1C-4 |
| 1C-9 | environment-clock (season + time UI) | 1C | 1.5 | 1C-1 |
| 1C-10 | night-sky-basic (placeholder) | 1C | 1.5 | 1C-5, 1C-9 |
| 2-1 | cloud noise-bake | 2 | 2.0 | — |
| 2-2 | cloud-shape + wind shear | 2 | 2.5 | 2-1 |
| 2-3 | cloud anti-tiling | 2 | 1.5 | 2-2 |
| 2-4 | cloud-lighting | 2 | 2.0 | 2-2 |
| 2-5 | adaptive-march | 2 | 2.0 | 2-3, 2-4 |
| 2-6 | cloud-budget-tiers | 2 | 1.0 | 2-5, 1B-12 |
| 2-7 | cloud-shadow-rework | 2 | 2.5 | 1C-4 |
| 2-8 | ocean-slope-mips | 2 | 4.0 | — |
| 2-9 | water-sun-and-foam | 2 | 3.0 | 1C-6 |
| 2-10 | retire-planar-reflection | 2 | 1.5 | 2-9 |
| 2-11 | foliage-texture-atlas | 2 | 2.0 | — |
| 2-12 | card-trees (+ ShadowDepthWrapper) | 2 | 4.0 | 2-11, 1A-7 |
| 2-13 | wind-three-band | 2 | 1.0 | 2-12 |
| 2-14 | lod-dither-crossfade | 2 | 1.5 | 2-12 |
| 2-15 | procedural-rocks | 2 | 2.0 | 1B-9 |
| 2-16 | grass-ground-cover | 2 | 2.5 | 2-13, 1B-9 |
| 2-17 | octahedral-impostors | 2 | 6.0 | 2-12, 2-14 |
| 2-18 | seasonal-foliage | 2 | 2.0 | 2-17, 1C-9 |
| 3-1 | material-array-gpu | 3 | 8.0 | — |
| 3-2 | surface-plugin | 3 | 4.0 | 3-1, 1A-7 |
| 3-3 | microdetail-fix | 3 | 1.0 | 3-2 |
| 3-4 | detile-scales | 3 | 1.5 | 3-2 |
| 3-5 | triplanar-texture | 3 | 2.5 | 3-2, 3-1 |
| 3-6 | height-blend | 3 | 1.0 | 3-2 |
| 3-7 | per-material-brdf | 3 | 2.0 | 3-6, 1C-6 |
| 3-8 | runway-earthworks | 3 | 2.5 | — |
| 3-9 | runway-surface | 3 | 5.0 | 3-8, 3-1 |
| 3-10 | seasonal-palette | 3 | 2.0 | 3-7, 1C-9 |
| 4-1 | wgsl-kernel (+ domain wrap) | 4 | 3.5 | 1B-2, 1A-3 |
| 4-2 | page-atlas | 4 | 4.0 | 4-1 |
| 4-3 | gpu-height-generate | 4 | 3.0 | 4-2 |
| 4-4 | vertex-displacement (+ ShadowDepthWrapper) | 4 | 4.0 | 4-3, 1A-7 |
| 4-5 | cdlod-quadtree | 4 | 5.0 | 4-4 |
| 4-6 | wgsl-classifier + page-splat-atlas | 4 | 7.0 | 4-3, 3-6, 1C-9 |
| 4-7 | page-occlusion-bake (skyVis + bent normal + horizon) | 4 | 5.0 | 4-3, 1C-6 |
| 4-8 | csm-nearfield | 4 | 2.0 | 4-7 |
| 4-9 | retire-cpu-terrain-path + earthworks → WGSL | 4 | 1.0 | 4-5, 3-8 |
| 5-1 | erosion-hydrology-contract *(spec)* | 5 | 3.0 | — |
| 5-2 | collision-readback + macro fallback + crash recovery | 5 | 4.5 | 4-3, 5-1 |
| 5-3 | macro-drainage | 5 | 9.0 *(8–14)* | 5-1, 5-2 |
| 5-4 | hierarchical-page-erosion | 5 | 8.0 *(7–14)* | 5-3 |
| 5-5 | aux-page-channels | 5 | 2.0 | 5-4 |
| 5-6 | runway-erosion-mask | 5 | 1.0 | 5-4, 4-9 |
| 5-7 | fine-band | 5 | 3.0 | 5-4 |
| 5-8 | tectonic-skeleton | 5 | 5.0 | 5-4 |
| 5-9 | channel-graph extractor | 5 | 2.0 | 5-5 |
| 5-10 | bathymetry-clipmap | 5 | 4.0 | 5-5 |
| 5-11 | water-depth-optics | 5 | 4.0 | 5-10, 2-9 |
| 5-12 | carved-rivers-lakes | 5 | 6.0 | 5-9, 5-11 |
| 6-1 | river-flow-advection | 6 | 4.0 | 2-8, 5-12 |
| 6-2 | shoreline-foam-runup | 6 | 3.0 | 5-11, 6-1 |
| 6-3 | shallow-water-dispersion (a+b) | 6 | 2.0 | 5-10 |
| 6-4 | caustics | 6 | 2.0 | 5-11, 2-8 |
| 6-5 | terrain-wetness | 6 | 1.5 | 3-7, 6-2 |
| 6-6 | ecology-channels | 6 | 2.0 | 5-5, 1B-7 |
| 6-7 | talus-scree-placement | 6 | 1.5 | 5-5, 2-15 |
| 6-8 | canopy-terrain-handoff | 6 | 2.5 | 6-6, 2-17 |
| 6-9 | gpu-scatter (CPU-readback default) | 6 | 5.0 | 6-8, 4-6 |
| 6-10 | compute-scheduler | 6 | 2.0 | 1A-1 |
| 6-11 | quality-tiers-v2 | 6 | 3.0 | all |
| 6-12 | documentation truth pass | 6 | 1.0 | 6-11 |

| 7-1 | moon (ephemeris, phase, moonlight) | 7 | 3.0 | 1C-10 |
| 7-2 | scotopic-vision (Purkinje, adaptation) | 7 | 2.5 | 7-1 |
| 7-3 | star-field (BSC catalogue, sidereal) | 7 | 2.0 | 7-1 |
| 7-4 | clustered-lighting | 7 | 4.0 | 3-2, 1C-4 |
| 7-5 | light-points (instanced emissive + IES) | 7 | 4.0 | 7-4, 7-2 |
| 7-6 | light-volumetrics | 7 | 3.0 | 7-5, 1C-4 |
| 7-7 | airfield-lighting (PAPI, edge, approach) | 7 | 4.0 | 7-5, 3-9 |
| 7-8 | aircraft-lighting (nav, beacon, strobe, landing) | 7 | 3.0 | 7-4, 7-5 |
| 7-9 | night-perf-tiers | 7 | 2.0 | 7-6, 7-8 |
| 7-10 | parametric-hangar | 7 | 5.0 | 3-1 |
| 7-11 | hangar-materials (corrugated, weathering) | 7 | 2.5 | 7-10, 3-1 |
| 7-12 | hangar-interior | 7 | 2.0 | 7-10, 7-4 |
| 7-13 | airfield-furniture (windsock, fence, signage) | 7 | 3.5 | 7-10, 3-9 |
| 7-14 | obstruction-lighting | 7 | 1.0 | 7-13, 7-5 |

### Phase totals

**Superseded 2026-08-18 — this table predates Phase 0 and both execution plans. Use [`PRE_PHASE_4_REALIGNMENT.md`](PRE_PHASE_4_REALIGNMENT.md) §9.** It has no Phase 0 row (16.8 d, shipped); Phase 1 shipped at 43.0 d, not 48.6; Phase 2 is 48.0 d after `B1`–`B7` and `R-18`–`R-24`; Phase 3 is 30.25 d after `C1`–`C7` and `R-26`. The corrected programme is **≈316 days** with the cut line at **≈199**.

| Phase | Days | Cumulative | Calendar (4.5 d/wk) |
|---|---|---|---|
| 0 — Architecture shift *(shipped)* | 16.8 | 16.8 | ~4 weeks |
| 1 — Foundation, correctness, atmosphere *(shipped)* | 43.0 | 59.8 | ~13 weeks |
| 2Z — Evaluation surface + governor + seasonal kernel *(shipped)* | 6.0 | 65.8 | ~15 weeks |
| 2 — Sky, sea surface, living ground *(shipped)* | 48.0 *(54.5 after the B8 vegetation-quality amendments, +6.5, 2026-08-18)* | 113.8 | ~25 weeks |
| 7A — Night sky and night vision *(moved out of Phase 7; shipped)* | 7.5 | 121.3 | ~27 weeks |
| 3 — Terrain surface and the runway | 30.25 | 151.6 | ~34 weeks |
| A — The things you look at (aircraft, wildlife) | 12.75 | 164.3 | ~37 weeks |
| 4 — The terrain GPU spine | ~38.5 *(46.5 per the binding `PHASE_4_EXECUTION_PLAN.md`)* | **~202.8** ← *v1 cut line* | ~45 weeks |
| 5 — Landscape evolution | 51.5 | 254.3 | ~57 weeks |
| 6 — Water in motion, ecology, final tiers | ~28.0 *(~27.5 — `6-10` moved to Phase 4 per `PHASE_4_EXECUTION_PLAN.md` D2)* | 282.3 | ~63 weeks |
| 7 — Airfield lighting and identity (7B/7C/7D) | 34.0 | **~316** | **~70 weeks** |

> **Reconciled ledger, 2026-08-19.** Shipped through Phase 2.5: **127.8 d** (Phase 0 = 16.8, Phase 1 = 43.0, Gate 2Z = 4.0, R-11/R-13 = 2.0, Phase 2 = 54.5 as amended, Gate 7A = 7.5). Remaining: Phase 3 = 30.25, Gate A = 12.75, Phase 4 = 46.5 (binding), Phase 5 = 51.5, Phase 6 ≈ 27.5, Phase 7 = 34.0. v1 cut line (through Phase 4) **≈217 d** (~48 weeks at 4.5 d/wk); programme **≈330 d** (~73 weeks). The rows and cumulative column above are kept as the 2026-08-18 record.

### First week, in order

> **Historical, marked 2026-08-19.** Every step below shipped in Phase 0 / Gate 1A (2026-08-17). Kept as a record of the original sequencing; it is not a to-do list.

1. `verify-flip` → `fix-temporal-flip` → `fix-double-blend` → `getViewMatrix(true)`. Ship it alone, first. It fixes the user's loudest complaint in under a day.
2. `split-governor` + the absolute pixel cap. **Nothing else can be judged visually until the renderer stops silently trading resolution for nothing.**
3. `csm-memory` — the depth-only shadow RTT. Cascade count and size only; **hold the distance** until horizon maps land.
4. The `MaterialPluginBase` vertex + `ShadowDepthWrapper` spike. Two later architectures rest on it.
5. Decide the WebGPU test harness. Every WGSL parity test in Phases 4–5 blocks on it.
