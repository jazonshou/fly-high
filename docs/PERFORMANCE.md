# WebGPU performance strategy

fly high's active renderer is a Babylon.js `WebGPUEngine` implementation. It keeps memory, generation, simulation, and draw work bounded while the deterministic coordinate space remains effectively endless.

> Current release scope and acceptance state are summarized in
> [`PROJECT_CLOSEOUT_2026_09_02.md`](status/PROJECT_CLOSEOUT_2026_09_02.md). Historical
> promotion measurements below remain evidence; `PERF_CAPTURE_SHOTS` is the authority for
> the live append-only capture list.

## Runtime contract

- WebGPU, Web Workers, and a hardware-accelerated adapter are required. Startup requests a high-performance adapter and rejects a software/fallback adapter.
- There is **no WebGL fallback and no Canvas fallback**. An unsupported device receives a startup error rather than a reduced renderer.
- The engine runs with compatibility mode disabled, a right-handed scene, reversed-Z depth, MSAA on the offscreen beauty target per tier, a 0.08 m near plane, and a 45 km far plane (1C-4: the shared aerial perspective is ≥95% opaque beyond it).
- Continuous `timestamp-query` observers are disabled in gameplay: a controlled reference capture measured a 4.7 ms p95 observer tax and only 49 resolved samples in 240 frames. A pinned diagnostic capture can request them explicitly before device creation; they are never required for rendering.
- Device loss is terminal for the current renderer instance. Simulation/rendering pause and the user must reload to recreate the adapter, device, and every GPU resource.
- WebGPU normally requires a secure browser context; local development at `localhost` is accepted.

## Frame architecture

The game-owned frame graph declares system order while Babylon owns WebGPU command encoding, attachment transitions, and submission:

| Order | Pass | Work |
| ---: | --- | --- |
| 1 | `flight-presentation` | Aircraft transform, camera, and atmosphere state. |
| 2 | `world-page-visibility` | Terrain pages, detail cells, wildlife, and velocity-aware residency/LOD. |
| 3 | `shared-planar-water-reflection` | Retired (2-10): the sky environment probe carries water reflections; the receiver contract and lake-plane hysteresis survive for a future lake capture (5-12). |
| 4 | `spectral-ocean-compute` | Ocean compute dispatches, bathymetry toroidal-strip updates, and river/lake material updates. |
| 5 | `volumetric-cloud-integration` | Low-resolution cloud integration, temporal resolve, and world-space transmittance projection. |
| 6 | `hdr-present` | Babylon scene render, the scotopic (rod-vision) pass when required, half-float ACES image processing, final FXAA, and presentation. |

The renderer makes its floating-origin decision immediately before frame-graph execution. Camera cuts, floating-origin shifts, display resizes, atmosphere/profile changes, and dynamic-resolution changes invalidate the cloud system's temporal history through the graph. Floating-origin rebases occur on a 2,048 m grid after either horizontal camera-relative component reaches 4,096 m. Absolute world coordinates remain in the simulation and deterministic generators; only render-facing positions are rebased.

## CPU and GPU ownership

“WebGPU renderer” does not mean that all procedural work is a compute shader. The current split is intentional:

| System | Generation/simulation | GPU presentation |
| --- | --- | --- |
| Flight model | Dedicated Worker, fixed 120 Hz; 60 Hz snapshots; independent fixed 120 Hz control/action pump | Simulation-time presentation with a recent-minimum, queue-delay-resistant worker-clock estimate, fixed 1/60 s presentation delay, monotone pause/resume floor and at most 50 ms velocity/body-rate coasting; procedural aircraft meshes |
| Terrain | **Analytic worlds — the shipped default — use the GPU kernel.** Eroded worlds are a shelved opt-in (see below); Gate W gave them GPU producers (`TerrainMacroErosionGpu.ts`, `TerrainPageErosionGpu.ts`) beside the retained CPU-worker reference, and the simulation Worker samples L0 → macro → analytic recovery. | Completed r32float atlas pages feed the CDLOD ground; eroded pages upload through the same atlas and become visible only at final publication. |
| World-page contract | CPU page keys, quantized payload validation, lifecycle/cache metadata, velocity priority, and the canonical flow/lake/soil/shore fields | Defines heterogeneous upload/residency boundaries; it does not itself issue draw work |
| Ocean | Native WebGPU compute: spectrum initialization/evolution, Stockham 2D IFFT, displacement, slopes and slope moments, Jacobian, and foam | WGSL displaced water with Fresnel, GGX sun glint, sky/cloud response, foam, and probe-fed environment reflections (the planar capture is retired, 2-10) |
| Rivers and lakes | Eroded worlds extract one deterministic channel graph from the canonical macro export. Explicit analytic compatibility worlds retain the velocity-ahead tracer Worker and scheduled CPU fallback. | Graph-backed or legacy geometry uses the shared WGSL water response and bathymetry depth field. |
| Clouds | GPU-baked noise and weather-density volumes | WebGPU compute ray march, temporal resolve, and transmittance/shadow map; a `ShaderMaterial` composites the resolved result |
| Atmosphere | CPU solar position, transmittance LUT bake, and per-frame haze binding | Analytic HDR WGSL sky and aerial perspective from one shared closed-form Rayleigh/Mie/ozone integral; Babylon fog is permanently off |
| Trees, rocks, shrubs | Deterministic CPU detail-cell generation and LOD selection | Spatially chunked Babylon thin instances with per-instance color and tree wind deformation |
| Wildlife | Deterministic CPU population and bounded fixed-step AI | Interpolated current thin-instance transforms for procedural animals |

The spectral ocean remains the only active general-purpose GPU *simulation* in
the frame **of the shipping (analytic) world**. Terrain also uses compute for
analytic page generation and channel bakes, and bathymetry uses compute for
bounded toroidal strip updates. Clouds are a compute-shader volume ray
march, but not a general-purpose fluid simulation. This distinction is
load-bearing when attributing worker CPU time, upload time, and GPU shading.

> **Corrected 2026-08-31 (`6-12`).** This paragraph previously read *"Phase 5
> erosion itself is presently a deterministic CPU-worker reference, not the
> plan's final GPU erosion implementation."* **Both halves are now wrong, in
> opposite directions, and the net answer is still "erosion does not run in the
> shipping frame" — for a completely different reason.**
>
> - **A GPU erosion producer exists.** Phase 6's Gate W built it:
>   `TerrainMacroErosionGpu.ts` and `TerrainPageErosionGpu.ts`, taking the macro
>   leg from ~1,779 ms to ~825 ms and the page path to ~1.4 pages/s against the
>   CPU path's 0.2–0.5. So the CPU worker is no longer the only implementation.
> - **But the eroded world is shelved.** Jason flew it on 2026-08-31, found no
>   relief at all — flat page-shaped plates with water between them — and
>   terminated it as an executive decision. Phase 6 §8 resolved **NO**, which the
>   plan explicitly sanctions: the analytic default ships on, eroded stays behind
>   its `?world=eroded` flag, and that is not a phase failure. The code is
>   **parked, not deleted** (~19 days of work, roughly working).
>
> The practical consequence for anyone attributing frame cost: **no erosion of
> either kind executes in a shipping frame**, so erosion cannot explain a
> measurement taken on the default world. `TerrainPageHydrology` is eroded-only
> by design and is likewise dark. `6-1` (flow advection, standing waves, lake
> chop) **shipped entirely dark** for the same reason — it is driven by eroded-
> only lake polygons and resampled river lanes — as do the inland halves of
> `6-2`/`6-3`/`6-4`. Their ocean halves are live and visible.

The flight simulation never depends on render cadence. Its collision path also avoids paying for visual biome/material sampling: a dedicated terrain query returns only height, normal, runway state, and friction; ordinary airborne steps use a height-only early reject before requesting per-wheel normals; high-AGL telemetry can reuse a center height; and the exactly flat airport platform bypasses terrain noise. These CPU savings remain independent of the rendering overhaul.

## Resolved quality tiers

Scenery quality and rendering intent are combined into one effective tier:

| Scenery quality | Performance | Balanced | Ultra |
| --- | ---: | ---: | ---: |
| Low | 0 | 0 | 1 |
| Medium | 0 | 1 | 2 |
| High | 1 | 2 | 3 |

The effective tier resolves these bounded targets (mirrors `QualityProfile.ts`,
which is the source of truth — this table is documentation, and Gate 2Z's
audit is why it now carries all four tiers):

| Budget | Tier 0 | Tier 1 | Tier 2 | Tier 3 (Ultra) |
| --- | ---: | ---: | ---: | ---: |
| Initial/internal render-scale ceiling | 0.72 | 0.86 | 1.00 | 1.00 |
| Absolute pixel cap (1A-6a) | 1.0 Mpx | 1.5 Mpx | 2.4 Mpx | 4.0 Mpx |
| Device-pixel-ratio ceiling | 1 | 1.5 | 2 | 2 |
| MSAA samples (offscreen beauty target) | 1 | 1 | 4 | 4 |
| CDLOD node budget (`4-5`, re-tuned at `4.5-A1`) | 224 | 320 | 448 | 640 |
| CDLOD split threshold, pixels (`4-5`) | 4 | 3 | 2 | 1.5 |
| Finest streamed page level (`4-0`) | 1 | 0 | 0 | 0 |
| Height-atlas slots / channel-atlas slots (`4-0`) | 144 / 100 | 196 / 196 | 256 / 256 | 256 / 256 |
| Terrain material array edge (3-0) | 256² | 512² | 512² | 512² |
| Terrain triplanar projection (3-5) | planar (slope-stretched) | 2-axis | 3-axis | 3-axis |
| Ground patchwork (W-1) | off | on | on | on |
| Climate province field (far biome tones, `ClimateProvinceField.ts`) | off | on | on | on |
| Volcanic materials (Basalt, Tephra) | off | on | on | on |
| Height-blend max materials (3-6) | 2 | 3 | 4 | 4 |
| Shadow map (`4-8b`) | 1,024 | 1,280 | 1,536 | 2,048 |
| Shadow cascades (`4-8b`, D15, `7-CSM`) | 2 | 2 | 2 | 2 |
| Shadow distance (`4-8b`) | 900 m | 1.4 km | 1.8 km | 2.4 km |
| Vegetation casts shadows (`4.5-C1`) | no | no | yes | yes |
| Ocean FFT resolution per cascade | 128² | 128² | 256² | 256² |
| Active ocean cascades | 3 | 4 | 5 | 5 |
| Cloud resolution-scale profile value | 0.25 | 0.45 | 0.60 | 0.70 |
| Requested cloud primary steps | 40 | 60 | 96 | 96 |
| Cloud light-step profile value | 4 | 6 | 6 | 6 |
| Vegetation radius (= impostor radius = the density law's far band) | 2 km | 3 km | 4 km | 6 km |
| Card-tree LOD radius (near + mid band) | 700 m | 1,100 m | 1,500 m | 2,000 m |
| Rendered stems/ha at crown closure (near band) | 55 | 78 | 79 | 79 |
| Impostor floor share (fraction of the near cap drawn in SOME representation beyond the near radius; the gap under the geometry share is 2D impostors) | 0.20 | 0.30 | 0.35 | 0.40 |
| Vegetation density multiplier | 0.45 | 0.75 | 1.00 | 1.00 |
| Active-animal budget | 16 | 48 | 128 | 128 |
| Volcanic steam wisp cap (`volcanicSteamMaxWisps`; 0 = no mesh) | 0 | 128 | 192 | 256 |
| Frame target | 13.7 ms | 13.7 ms | 13.7 ms | 30 ms |

Ultra's material array edge is 512², not §5.3's published 1024²: `3-1`
synthesises the ten layers on the CPU (measured 1.07 s at 512², ~4.3 s at
1024²), and several seconds of blocked main thread at startup is not worth a
resolution the de-tiling warp and 16× anisotropy largely mask. The row reopens
if synthesis moves to GPU compute. Both arrays together are 6.7 MiB at tier 0
(the ten base materials) and 34.7 MiB above it (those ten, the volcanic pair
and the ground grain), derived from the tier's edge and layer data rather than
declared, so the memory row cannot disagree with the knobs.

These are profile values, not claims that each row owns a separate framebuffer. The spectral configuration defines all five requested cascades, so the active allocation is 3/4/5/5. Terrain tiers retain the inexpensive far levels needed to reach the 45 km far plane (guaranteed coverage is 512·2^rings meters; tier 0 stops at 32.8 km behind ~89% haze opacity); quality changes near-page vertex density rather than exposing a finite terrain edge. Tier 3 is a 30 fps tier that spends its frame on pixels.

`worldEvolution` is world content and is invariant across this tier table. The
Phase-5 memory rows in `PerformanceBudget.ts` deliberately reserved the target
GPU macro, erosion-scratch and channel-graph layouts while the CPU reference was
still the only producer. Gate W subsequently added the GPU macro and hybrid GPU
page DAG described below; those old reservations remain budget provenance, not
a substitute for the live GPU inventory. The two 1024² R16F bathymetry textures
are a live 4 MiB allocation on an adapter that exposes `texture-formats-tier1`
(Chrome); on a core-only adapter (Firefox 155) the clipmap stores `rgba16float`
instead and the same two textures are 16 MiB, and the estimator's bathymetry row
follows the live format. The macro height additionally has a read-only GPU
storage upload for bathymetry sampling. A historical production-shape CPU-reference
run for seed `phase5-production-benchmark` measured 3,174 ms sampling
uplift/erodibility/repose plus 4,323 ms evolution, 7,497 ms total. That result
missed the eroded experiment's 1.5 s load target and is neither a shipping-world
startup measurement nor the later GPU producer's cost.

The eroded startup critical path is longer than the macro algorithm alone.
(This section predates `G0-1`: the shipped default is **analytic**, so the
figures below measure the opt-in eroded path — reachable with `?world=eroded`
— not what a default load costs. Phase 6 Gate W has since rebuilt this path;
its numbers supersede these.) `FlightRenderer.create()` starts and awaits macro evolution, initializes
the bathymetry clipmap from that authority, then completes scene readiness and
terrain pre-warm; only after the renderer resolves does the game construct the
simulation client and begin its frame loop. A bathymetry WGSL declaration used
the reserved word `target`; Babylon stopped polling its failed
`dispatchWhenReady` path but left the Promise pending, so this sequence could
hold the load screen forever without surfacing an error. The declaration is now
`targetTexel`, the module is compiled by a real-adapter test, bathymetry compute
readiness rejects on compile error, timeout, abort or disposal, and the renderer
owns an outer startup deadline. A clean eroded development reload
reached the start screen in **11,098 ms**; a cache-busted navigation against the
built production server reached it in **13,255 ms** and then entered the cockpit
with no reported error. The accompanying Node/build and then-current Chromium
WebGPU checks passed. These counts and timings are retained historical evidence,
not current suite totals, cold/reference-machine measurements, or satisfaction
of the eroded experiment's 1.5 s target.

Terrain page resolution, ocean presentation density, FFT topology, and every other renderer budget follow the resolved tier rather than raw scenery quality alone. Live tier changes replace resident terrain pages behind their existing geometry and build new ocean compute textures/pipelines before atomically swapping them. ACES remains the common presentation transform; bloom is funded only at tier 1, scotopic vision attaches by luminance, and FXAA is the sample-count-1 fallback rather than a universal stack member.

## Terrain and world paging

Phase 4 replaced the CPU geometry-clipmap outright. Phase 5 keeps that
presentation spine and changes the height authority behind it:

- **The default world is analytic; eroded is an explicit, parked experiment.**
  `?world=eroded` begins a cell-centred, world-anchored 1024² × 512 m macro
  evolution in a Worker while device resources are constructed, then waits for
  the canonical result before eroded terrain, graph hydrology, and bathymetry
  become visible. The shipping analytic path does not pay that startup cost.
  The eroded runtime export remains tier-independent and reusable by every
  consumer if that experiment is resumed.
- **The parked eroded implementation has GPU production passes and a retained
  CPU-worker reference.** `TerrainMacroErosionGpu` and
  `TerrainPageErosionGpu` execute the production macro/page work through the
  shared compute meter; the staged Worker remains the correctness oracle and
  supplies the CPU-owned portions of the hybrid DAG. The atlas admits one page
  at a time so stale flight-path work cannot fill the queue. Coarse pages seed
  from the macro authority and fine pages can seed from resident parents; the
  full runway earthworks mask is protected, and the page producer supplies
  deterministic strictly-downhill, acyclic receiver overrides around its
  perimeter. This path remains maintained but is not the shipping default.
- **Evolution is inspectable without a capture.** The terrain debug overlay's
  live macro preview exposes flow accumulation, lake mask, drainage base levels,
  double-angle fabric and erodibility alongside the Phase-4 residency views.

- **One mesh draws the ground.** A single 33×33 unit grid is thin-instanced
  over a CDLOD node set. Node span is `64·2^L` m across 32 quads, which is
  exactly the level's own `2·2^L` m page texel spacing — nodes and pages sample
  the same lattice by construction. Terrain submits one beauty draw plus one
  caster draw per shadow cascade.
- **Selection is a global screen-space-error priority queue** (`4.5-A1`): the
  node with the largest MEASURED deviation-to-pixels is split first, whatever
  its level, until the node budget is spent. The per-level loop it replaced
  converged with the whole world at L5–L7 regardless of altitude. A 2:1
  neighbour clamp is enforced as a precondition on splitting, because the
  crack closure is analytic (a node morphs onto its parent's lattice) and
  guarantees seam identity across one level only — which is what lets skirts be
  deleted and back-face culling be true.
- **A node is never split on a guess.** `maxDeviationFromParent` is measured by
  the generation pass as the largest second difference over the page; a page
  with no measurement is drawn coarse and never split.
- **Analytic pages are GPU-generated; eroded pages use a staged hybrid DAG.**
  The analytic path retains one compute dispatch per admitted batch and the
  `4.5-B1` split publication of texels before bounds. Eroded seed, geology,
  breach, stream-power, talus, and fine-band stages execute on the GPU; ordered
  MFD, deterministic inputs, readback handoffs, and final hydrology/statistics
  remain in the Worker. The final stored page uploads into the same r32float
  atlas, and residency is withheld until the complete DAG and L0 collision
  publication finish. It never exposes a half-evolved slot.
- **Detail and wildlife share the collision height ladder.**
  `TerrainConsumerAuthority` adapts L0 → macro → analytic height, normal and
  slope for those consumers while leaving the established analytic climate and
  material fields intact. Eroded worlds therefore do not place ecology against
  a second, analytic-only ground surface.
- **One meter paces every terrain producer.** Analytic height generation,
  occlusion, splat bakes, and the GPU stages of the eroded page DAG feed measured
  dispatch costs back from `timestamp-query`. The hybrid DAG's Worker stages do
  not manufacture GPU samples; its staged producer retains explicit admission
  demand while those asynchronous handoffs are in flight. A measured analytic
  height page costs ~1.9 ms of GPU, more than the whole compute cap, so the
  highest-priority client with demand retains the floor of one dispatch.
- **Channel families ride a second atlas**: sky visibility and a bent normal,
  an 8-azimuth horizon field, the season-keyed land-cover splat weights, and
  invariant flow accumulation, lake depth, soil depth and signed shore
  distance resources. The four Phase-5 fields use heterogeneous formats and
  become resident atomically with their page; only after all four uploads and
  slot residency does the runtime publish the aux page to the detail authority.
  Flow/TWI currently feeds the land-cover classifier and signed shore distance
  feeds the live riparian density path; lake and soil remain exposed for later
  consumers.
  The original sampled surface families retain BILINEAR filtering (`4.5-A2`)
  — the material axis is ordered so a filtered
  primary id lands between two materials that actually meet, and only the
  primary lane may be read that way.
- **A page with no channel slot falls back to a per-VERTEX ecotone walk**
  against the height the vertex shader just displaced to (`4.5-A3`), so the
  fallback is a gradient at vertex spacing rather than one material across the
  whole node.
- **Surface appearance (Phase 3).** One PBR material plugin owns albedo,
  normal, roughness, ambient occlusion and micro-detail. Ten synthesised
  land-cover materials live in two mipped `Texture2DArray`s at 16× anisotropy;
  the fragment brackets the interpolated material id along the ecotone axis,
  adds a slope/snow override at fragment resolution, and height-blends the
  survivors. Candidates whose blend weight is negligible are skipped rather
  than sampled and multiplied by zero. Distant mips carry a Toksvig roughness
  term so a normal map averaged into flatness cannot leave a false sharp
  highlight behind. The ten ~110 ms layer syntheses run in a worker
  (`4.5-C2b`); the four terrain compute pipelines are pre-warmed behind the
  load screen, because Babylon 9.21 compiles a compute pipeline synchronously
  on its first dispatch.
- **The runway is not a mesh.** A three-zone cut/fill earthworks profile
  (`terrain/RunwayEarthworks.ts`) shapes the ground, the collision fast path
  evaluates the same profile, and the pavement, markings and rubber are
  painted inside the airport's analytic SDF in the same fragment shader. The
  visual pavement edge is that exact SDF, matching the tyre-friction boundary.
- `src/render/webgpu/world/` remains the one page-identity, payload,
  lifecycle, cache-metadata and streaming-priority authority; the terrain atlas
  consumes it verbatim rather than keeping a second residency map.
- **The far ground follows the climate province (2026-10-24).** Past the
  trusted pages the macro fallback assumed the temperate world (Grass, rock
  and snow on real elevation, one canopy paint), so a taiga, tundra, desert or
  tropical forest changed colour with viewing distance. `ClimateProvinceField.ts`
  streams a 128² window of the province around the camera (1.25 km texels,
  nearest-first, at most 512 work units a frame, no allocation per frame) and
  bakes each texel's far tone on the CPU (`ProvinceFarTone.ts`: a thermal
  lift, a sward base tone and a signed canopy share, all as deltas, so the
  temperate core is `x + x * 0` and renders bit-identical) into two half-float
  textures, 160 KiB. The CDLOD vertex stage takes one bilinear, repeat-wrapped
  sample of each per vertex. The tone rides lanes the terrain already
  interpolates (the beauty pipeline has no spare fragment input), and
  shadow-depth passes skip the read. Behind the
  define `TERRAIN_PROVINCE_FIELD` from the tier flag `terrainProvinceField`:
  compiled out on Low, which pays nothing and allocates nothing.
  **Cost** (`npm run perf:ab -- --base 62bade0`, cloud SwiftShader, Medium):
  GPU time SAME on all five shots, approach +0.4%, cruise +2.1% (re-run
  -2.0%), forest +0.5%, ground +0.5%, water +1.3% (re-run with the shadow
  skip -0.6%); draw calls unchanged; inventoried GPU memory +0.25 MiB; every
  default shot's pixels identical to the base. The shadow skip took the CSM
  pass from +8-18% to water's +3.6% (-0.3% to +6.3%). Baselines and draw-call
  ceilings are unchanged.
  **Re-measured on CI against main (2026-10-25)**, with every biome merged:
  cruise +2.0% on an EPYC 7763, and the same commit with
  `--head-profile-override {"terrainProvinceField":false}` read cruise -1.2%
  on a 7763, so the field itself was 3.2% of the cruise frame, over the 2% a
  feature may spend (the cloud runs above read it as noise). Water +3.1% and
  ground +4.0% with the field came from a 9V45 against +0.1% and +0.5%
  without it on a 7763, so they do not isolate it (see "Cloud A/B"). The
  vertex stage then loaded four RGBA32F texels per vertex, mixed them
  bilinearly and evaluated the tone's seven smoothsteps and two divides on the
  result. The tone is now baked per texel on the CPU (1.5 us a texel warm, 0.5
  of it the tone), which leaves the vertex two filtered samples.
  **After the bake** (`9d5f98e`, perf-ab run 40148770740 against main,
  SwiftShader GPU time, all SAME, draw calls unchanged): approach +2.0% (EPYC
  9V74), cruise +1.0%, forest +1.3%, ground +0.5%, water +0.7% (EPYC 7763).
  Against the field-off run on the same CPU model, the field now costs cruise
  about 2.2% (was 3.2%), water about 0.6% and ground nothing measurable. The
  macOS runner's advisory A/B (Apple M1 GPU, frame wall time) read -0.5% to
  +1.0%, cruise +0.5% (-0.2% to +1.2%). A second dispatch (run 40148782563)
  drew an EPYC 9V45 for cruise and read +3.7%: the main pass +3.9% (+1.1% on
  the 7763), and the cloud raymarch, which this branch does not touch, +8.2%
  beside a bloom composite at -5.6%, with the arms' pixels matching. As with
  the sea's sky (2026-10-20), the 9V45 weighs this work more than the other
  models do; the hardware run does not show it.

### Landforms: sand seas (2026-10-24)

The dune stage (`src/world/landforms.ts`, `src/world/dunes.ts`, the WGSL twin in `terrain/TerrainLandformKernel.ts`) adds crescent sand seas to arid lowland past 150 km from the start airport. It is world geometry: the aircraft lands on it, so physics, every quality tier and every bake must see the same dunes, and it cannot be switched off on Low. Instead its cost is confined to bakes, and the airport's surroundings never pay it.

- **Where it runs.** The stage is a pure function of world position between the natural height and the runway earthworks. Within 120 km of the start airport its core mask is zero and it returns the natural height untouched (the occlusion march reaches about 120 km, so nothing in view changes); it ramps to full by 150 km. Inside an erg it adds the dune field and a sand cover that turns the ground bake's material to the golden Sand, thins trees and ground cover, and keeps lakes and rivers out. `?landforms=dunes` (or `createWorld(seed, { landforms: { dunes: true } })`) forces it everywhere but a 5→8 km runway clearance, for review and tests; it is read from the URL and never saved.
- **Per frame: nothing.** No pass, draw call, pipeline, uniform buffer or texture was added. The height page generator, the height pyramid and the bathymetry clipmap call the stage after the natural height; the splat bake reads the sand cover. Those pipelines are the ones already pre-warmed behind the load screen, so no compile moves into flight. The one new binding, `terrainLandformData`, is a 16-byte placeholder registered with `GpuBufferInventory` (the volcanic overlay fills it with its site index). The CPU path writes into scratch objects and allocates nothing per sample, and the far-field erg weight returns before the natural-terrain sample wherever the core, the climate or the erg patch rules a point out.
- **The far field.** Zero-trust pages (L5 and coarser) refuse a Sand pair and draw the Grass base, so the far province field's sand lane carries the dune stage's far erg weight (`sampleErgFarWeight`, 1.25 km texels) and the far tone paints Sand over an erg. A sampled texel costs about 4.0 µs against the province's 1.5 µs, and the field charges it `CLIMATE_PROVINCE_FIELD_LANDFORM_COST` extra units, so a frame's bake stays about 0.8 ms. Its early outs (the core, wet country, outside an erg patch) cost nothing extra and read 0, so around the airport the far tone is still x + 0. Low has no province field, so there a far erg keeps the Grass base.
- **CPU samples.** Measured in Node: a terrain height inside an erg costs 9.1 µs against the natural kernel's 8.1 µs. Physics, the detail worker and hydrology pay that only inside a sand sea.
- **Spawned airports** (2026-10-25, with main's airport network). A spawn search surveys and grades its sites on the landformed ground (`sampleTerrainHeightBeforeEarthworks`) and refuses sand seas (`inSandSea`). Inside the core the height is the natural kernel, as before, and the veto is a distance test (0.5 µs). In an arid erg the veto is one natural kernel evaluation (about 10 µs) per surveyed centre, 160 per spawn, and each height probe pays the stage's ~1.5 µs. All of it runs on the spawn worker, never the main thread.
- **Bake cost on a real GPU.** `terrainLandforms` returns the natural height after a gain test and one distance test. Inside the core every texel of a page takes that same early return, so a real GPU never enters the dune field there; only pages that straddle the 120-150 km ramp diverge.
- **Bake cost on SwiftShader, which runs both sides of every branch.** Measured on this host (median of interleaved runs, warmed pipelines): a height page costs 15-25% more wall clock with the stage compiled in, whether the page is inside the core or in an erg, and a splat bake 10-13% more. The first splat compile takes about 1.4 s longer, behind the load screen. These are bake times, which the A/B's settled frames do not include; they show up as streaming time on CI's SwiftShader runs.
- **Flight hitches** (`npm run perf:flight`, medium, SwiftShader, 6 legs of 240 frames each way): around the airport (biomes branch `73c344f` vs `22fc510`), the steady flight after the first leg reads render() p50 12.2 / 12.4 ms, p99 120 / 113 ms, long tasks 27 / 26, and the same 1 pipeline compile. The first leg out of the settled shot read 1.5 s more long-task time in the head in that run, all in world page visibility; it did not repeat in the steady legs. Over a forced high desert with and without the erg (both `22fc510`, start inside the erg), the erg flight was cheaper: render() p50 7.5 vs 9.8 ms, long tasks 20 vs 49, heap per frame 1.9 vs 2.4 MiB, because sand replaces trees and ground cover.
- **The A/B gate** (`npm run perf:ab -- --base origin/main --head a45de37`, a cloud session's SwiftShader, 16 rounds): GPU time SAME on `cruise-horizon` +0.2%, `forest-500ft-sunbehind` -0.2%, `ground-2m-lowsun` -0.8% and `water-25ft` +0.0%; `approach-500ft` read +0.1% but inconclusive (-1.3% to +7.8%), since a typecheck shared the host during its rounds. Rerun alone on the final head (`dead891`, which also carries the biomes branch's far province field), it read SAME +0.7% (-0.4% to +1.4%), with frames within 1/255 of main's and 0.1 KiB more uploaded per frame. In the first run, draw calls and GPU work were identical on all five. Against the biomes branch alone (`5257480` → `4d0ee74`, `--rounds 0`), `approach-500ft` and `ground-2m-lowsun` rendered identical frames. Against main, `ground-2m-lowsun` differed on 31% of its pixels at low amplitude, with 46 vs 45 resident pages: a leftover streamed page, which reads 0 pixels different when both arms hold the same pages (measured by the dry biomes work).
- **Draw calls, baselines and delivery floors unchanged.** Inside the core the stage returns the natural height bit for bit, so every committed baseline and draw-call ceiling stands; none were re-pinned.

## Spectral ocean and inland water

The ocean is the renderer's native WebGPU compute workload:

- Seeded Gaussian initialization builds band-limited JONSWAP-style spectra.
- Time evolution produces conjugate frequency-domain waves.
- Horizontal and vertical Stockham passes perform the 2D inverse FFT.
- A derivation pass produces half-float displacement, slope moments, Jacobian, and foam textures from float working textures. Jacobian compression drives breaking-wave foam, which decays temporally.
- Tier 0 allocates 128² with three cascades; Tier 1 allocates 128² with four; Tiers 2 and 3 allocate 256² with all five. The fifth cascade covers the largest 16,384 m patch and updates every eighth frame. Active cascades span different patch lengths and update cadences so farther, slower bands need not dispatch every frame.
- The camera-centered ocean presentation surface is one crack-free radial grid. Its established fifth-power detail lattice remains bounded to 40 km; only the final existing ring moves to a coarse 90 km coverage radius, which covers the corners of the 45 km far plane without adding topology or coarsening the near field. Tiers 0/1 use 96×128 or 144×192 radial/angular topology and tiers 2/3 share 192×256.
- The WGSL surface combines multi-cascade geometric displacement with per-fragment slope/normal and foam sampling, dielectric Fresnel, GGX sun glint, sky/cloud color, depth tint, and height-aware cloud transmittance on direct sunlight. Ocean and inland-water shaders also bind Babylon's existing cascaded-shadow depth array through its public matrices and comparison sampler; cascade splits/blends follow live quality changes, and only direct solar glare/scatter is attenuated. This reuses the terrain/scenery shadow render instead of scheduling a water-only pass. Environment reflections sample the shared sky environment probe cube with roughness-mapped mips; the planar scene capture that used to add nearby geometry is retired (2-10), and its surviving receiver contract idles at zero validity so the analytic sky/cloud response remains the fallback.
- Lower-cadence far cascades accumulate elapsed time before applying foam decay, so their half-life is independent of update cadence. Live quality changes initialize replacement compute resources before swapping away the active ocean.
- A shared two-level bathymetry clipmap stores `bedElevation − seaLevel` at
  16 m/texel over 16.4 km and 128 m/texel over 131 km. Both 1024² levels are
  R16F and update only newly exposed toroidal strips after their initial fill.
  R16F is a storage format only behind the optional `texture-formats-tier1`
  feature, so on an adapter without it (Firefox 155) both levels fall back to
  `rgba16float` storage — the same half-float in `.r`, four times the memory —
  rather than refusing to start.
  Analytic mode samples the historical terrain kernel exactly. Eroded mode
  bilinearly samples the canonical cell-centred macro height and blends back to
  analytic across the macro domain's 16-texel rim. In eroded mode, the
  clipmap's own update dispatch also overlays fully resident L0 erosion pages
  from the terrain height atlas, feathers macro-facing borders over two near
  texels, and invalidates affected footprints on admission, eviction, or slot
  movement. Water consumers retain one unchanged bathymetry binding surface.
- Shared depth optics apply Beer-Lambert attenuation, a soft shoreline,
  turbidity, underwater-interface handling and air-to-water refraction of the
  bed coordinate. The refracted substrate colour is still a deterministic
  analytic mineral proxy; it does not sample the terrain material arrays.

Rivers and lakes have two explicit content paths. Eroded worlds consume the
single deterministic `ChannelNetwork` extracted from the canonical macro
export; that geometry remains resident and never enters the legacy paging
tracer. Analytic compatibility worlds retain the cancellable, velocity-ahead
region Worker, its no-hole two-phase handoff, and the scheduled main-thread
fallback. Keeping the old carve proxies and tracer in this mode is deliberate
compatibility, not a second producer for eroded geography. Both presentations
share bathymetry, atmosphere, cloud and cascaded-sun-shadow inputs. The planar
capture remains retired, and there is no shallow-water compute solver.

The planar scene-reflection capture is retired (2-10): with the sky environment probe live on both water materials and water roughness capped at 0.34, the probe cube covers what the mirror pass existed for, at zero extra cameras. The receiver contract survives bound to a zero-confidence fallback texel, so the physically shaded atmosphere remains the mandatory fallback instead of reflecting black or stale geometry. The lake distance and projected-angular-size thresholds, with their mild hysteresis, are also preserved for the future lake capture (5-12), so a tiny lake below a high-altitude camera still cannot claim the reflection plane.

## Volumetric clouds and atmosphere

- Clouds occupy a camera-centered back-face shell and are ray-marched in WGSL between approximately 1.5 km and 7.2 km altitude.
- A layered three-octave base field plus separate broad structure and erosion evaluations combines weather shape, a vertical profile, coverage, humidity, and wind advection, producing deterministic variation rather than repeated cloud cards.
- Lighting uses Beer extinction, direct sun transmittance, forward/backward Henyey–Greenstein lobes, ambient sky contribution, and a powder-style edge term. Stochastic jitter reduces structured banding; early transmittance exit limits dense-cloud work.
- The low-resolution integration buffer stores direct light, ambient light, opacity, and a representative scattering distance. A ping-pong temporal pass reprojects history, rejects it by depth confidence, and neighborhood-clamps the retained radiance.
- Opaque depth remains available during the full-resolution composite. The shell projects the representative scattering point and writes its reversed-Z fragment depth, so the dominant cloud layer depth-tests against terrain; intersections within the ray-marched volume remain a representative-depth approximation rather than an exact scene-depth-truncated integration.
- A camera-centered procedural transmittance map updates on a bounded quality-dependent cadence. Terrain, ocean, rivers, lakes, aircraft, airport structures, vegetation, villages, and wildlife project each real world-space receiver back to the map's reference plane along the inverse sun ray, so receiver height shifts the lookup correctly. One registry resolves the floating-origin binding per frame for the fixed shared PBR material set; thin instances add no receiver-side CPU state. Transparent glass and emissive lights are excluded, and the former fictitious y=0 fullscreen darkening overlay is not used.
- Camera cuts, rebases, resizes, relevant settings changes, and render-scale changes invalidate temporal history; the next valid samples rebuild it without retaining stale depth.
- Atmosphere, clouds, ocean, and hydrology share sun direction/color, sky and ambient response, fog, coverage, humidity, and surface advection from one time/weather snapshot. The FFT spectrum deliberately retains its construction-time prevailing swell until a topology rebuild instead of resetting long ocean waves with every gust.

Cloud cost is primarily fill rate multiplied by ray steps and density-light sampling. Tier 2 is capped at 0.60 resolution, 96 primary steps, and 6 light steps because every output pixel is still integrated each frame; checkerboard reconstruction is not yet active. At 1080p this reduces the upper-bound nested density/light sample opportunity by roughly half versus the former 0.67/112/8 profile before early exits. Measure actual GPU time at multiple altitudes and view angles; a clear horizon and a camera inside dense cloud are not equivalent workloads.

### Volcanic steam

`VolcanicSteamSystem` draws steam over volcanic vents as camera-facing sprites in ONE instanced draw, and only while a vent is within 15 km of the camera; otherwise the mesh is disabled, so it is never submitted. The temperate core has no vents, so every core baseline gains no draw. Tier 0's `volcanicSteamMaxWisps` is 0, which builds no mesh or material at all. The first frame after load draws once with a collapsed, transparent instance so the WebGPU render pipeline exists before any vent comes into range.

- The vent query (`volcanicVentsInBounds`, reusing one `out` array) runs only when the camera crosses a 2 km cell. It keeps the 48 vents nearest the cell centre within 15 km plus half the cell's diagonal. A new vent's ground height costs one terrain sample, at most 8 a frame. The old wisps stay live until the new set is written in one 12 KiB upload.
- The per-frame update is a cell check, a range check over at most 48 vents and a clock write. It does no instance writes and allocates nothing. Rise, downwind drift, growth and fade are evaluated in the vertex shader.
- Each wisp is lit per vertex with the cloud model, so the fragment work is two value-noise octaves and one scene-depth load. Near-camera wisps fade out and collapse, which bounds overdraw when the camera flies through a plume.

## Detail and wildlife

World detail is deterministic and page-owned rather than attached to transient terrain meshes (villages and buildings were deleted in 1B-5; the airfield is the only settlement content):

- Default detail cells are 512 m. Terrain biome, climate temperature, slope, moisture, height, and deterministic hashes choose tree and shrub species and rock variants.
- Near and mid LODs use deterministic far thinning. Velocity-ahead selection reduces pop-in during fast travel.
- Generation is cooperatively time-sliced to 0.75, 1.25, or 2 ms per update, with hard caps of 8, 16, or 24 cells and resident caps of 128, 384, or 896 cells for the three effective density bands. At least one pending cell is admitted so streaming cannot starve when a dense cell exceeds its target slice (after a worker failure, since 2026-10-25, inline cells wait for credit instead; see the presentation-synthesis item below).
- Thin-instance batches reuse low-poly procedural species/building topology and shared materials, and are partitioned into deterministic 8×8-cell presentation chunks. Each batch owns its lightweight Babylon `Geometry` because instance streams are geometry-owned; this prevents one chunk from replacing another chunk's GPU buffers. Babylon frustum-culls the resulting conservative prototype-aware bounds independently, so one visible tree no longer submits every offscreen resident instance.
- Presentation synthesis is a second bounded stage after cell generation. The dedicated detail Worker retains the generated cell object graphs behind non-reused tokens, advances exactly one immutable packed chunk in at most 4,096 synthesis units or 4 ms per macrotask, and transfers exact 32-byte instance streams and bounds to the main thread. The main thread owns only lightweight resident descriptors, validates every token, batch key, byte length, bound and entity/record envelope before adoption, then synchronously publishes the complete result while the old chunk, statistics, mesh identities and GPU buffers remain live. While a build runs the worker posts a `presentationProgress` heartbeat after its first slice and then at most every `DETAIL_WORKER_HEARTBEAT_MILLISECONDS` (100 ms), and cells posted meanwhile wait their turn: each runs once the build has had its share of slices (a fifth of the last cell's time, 4 to 8 ms), and all of them run when the build ends or before any command that changes what a cell reads. The browser worker yields between slices through a self-posted MessageChannel message, which has none of a nested `setTimeout(0)`'s 4 ms clamp. A worker that reports an error or goes silent past a watchdog is replaced at the start of the next update by a new one on the same seed and live world, up to `DETAIL_WORKER_RESPAWN_LIMIT` (2) times per runtime; its cells are requested again, and every chunk keeps its last bytes until they are back. Past that limit, in a world whose terrain pages were transferred to the worker (an eroded world), or when a worker build fails or answers with a malformed result, the runtime fails closed to the bounded inline builder, which retains its 65,536-unit/3 ms update cap; inline cells then run on credit (an update earns one generation time slice, a cell starts only when the credit covers the running average cell cost, and each cell is charged what it took), which bounds the average main-thread time per update, not one cell. Authority-level generation and presentation watchdogs cannot be reset indefinitely by motion: cancel and reissue do not reset them. The watchdogs time the WORKER. The presentation watchdog charges silence: a heartbeat from the build the runtime holds, or an accepted answer, restarts it; it holds still while the demand is the main thread's to finish (a publication streaming, an inline build, an answer already queued); and it resets when the presentation sweep goes idle. Generation is timed only while the worker holds a request, any answer (current or stale) is progress, and its update count applies only after the worker's first answer. Either watchdog expires after 240 charged updates and at least `DETAIL_WORKER_WATCHDOG_MINIMUM_MILLISECONDS` (2,000 ms) of charged time, or after 8,000 ms whatever the count, and time without updates (a hidden tab, a long main-thread stall) is not charged past 100 ms per gap. Worker presentation demand that goes `DETAIL_WORKER_CONVERGENCE_MILLISECONDS` (30,000 ms) without an accepted build is counted and reported as a convergence stall, never failed over. Until 2026-10-25 the presentation watchdog expired after 240 updates OR 8 s counted from the first update with demand, through publication streaming, and every failure was a fallback for the session (see "Flight stutter" and "Medium/balanced choppiness" below). Exact cell-to-observer lower bounds skip only arrays for which the legacy per-item radial predicate would reject every placement. Frontier targets are reevaluated at their documented 64 m quantum independently of the coarser paging signature; a completed observer-sensitive snapshot farther than the 96 m membership/ground-cover validity envelope is canceled rather than published. If an abnormally slow machine lets the previously published snapshot cross that boundary first, its meshes are disabled fail-closed while retaining their CPU writers and WebGPU buffers; the valid replacement re-enables them only through the normal synchronous commit. This suppression remains explicit pending detail work, so it cannot masquerade as stable capture or shorten GPU resource lifetime. Superseding ordinary observer/cell signatures otherwise drain after the finite snapshot so continuous motion cannot starve publication; representation or floating-origin changes cancel safely, and a rebase translates live, non-suppressed chunks immediately. CPU writers/bounds are pooled at one spare per prototype. Existing GPU buffers update in place when capacity permits; growth and removal use the unchanged submission-safe pool/grace path so an unsent WebGPU bundle can never reference destroyed instance storage. Renderer diagnostics count unfinished detail cells and staged/backlogged chunks, and deterministic capture settling requires that count to reach zero before any shot may be accepted or published as a candidate.
- Per-instance color supplies variation. A lightweight PBR vertex deformation consumes each tree's phase, compliance, height, and stable selection from `instanceWind`, producing asynchronous crown and trunk sway without CPU transform updates.
- `densityField.ts` owns a 7.2 × 5.4 km forest-fraction field in addition to the continuous stand field. Its 260 m glades reach a 0.02 authored-density floor, thresholded windthrow supplies a genuinely hard edge, and the published edge margin makes generated stems shorter and crowns broader. This changes where and how much forest grows; it deliberately does not change species/stand selection.
- A floating-origin change immediately translates every live presentation batch by its build-origin delta while the bounded rebuild sweep catches up. The detail shader receives the same offset for pre-world band culling and impostor facing. The shared cascaded-shadow system still receives all eligible chunks rather than only those visible to the main camera.

Wildlife uses deterministic 800 m cells, a default 2 km activation radius, and active budgets of 16, 48, or 128 animals (with a hard safety cap of 512). Birds include gulls and hawks; ground animals include deer and boar. Their species-specific procedural bodies, wings, antlers and tusks still occupy exactly ten shared prototype batches, with feather, fur and keratin PBR variants rather than per-animal meshes.

- AI advances at a fixed 30 Hz and limits catch-up work. Far agents update expensive behavior less often.
- Bird flocking uses a bounded spatial hash and local-neighbor queries instead of all-pairs behavior.
- Distance LOD reduces procedural body parts for far animals. The 30 Hz simulation stores previous/current poses and render frames interpolate position, heading, wing phase, and gait before uploading one current matrix buffer.
- Population selection predicts ahead of aircraft velocity and remains seeded by world/cell identity, so paging does not reshuffle the ecosystem.

Gate A adds only small, fixed steady allocations. The worst live aircraft surface set is about 0.188 MiB (64² albedo, normal and packed-material mip chains per paint recipe) inside the existing miscellaneous allowance. Wildlife uses 37,716 bytes of prototype position/normal/index data plus the unchanged 1,310,720-byte thin-matrix buffers, 1.286 MiB total inside the other-detail allowance.

## HDR color, FXAA, and resolution

- The scene has no active prepass or TAA pipeline. Engine context antialiasing is disabled; MSAA lives on the offscreen beauty target, which is owned by whichever post-process is currently FIRST in the camera's chain (1B-11), at the per-tier sample counts above. That owner is not fixed: the scotopic pass detaches in photopic daylight, so ownership moves between rod vision, bloom and the tone map with the time of day and the tier. `FlightRenderer.applyFirstPassOwnership` derives it. FXAA is the sample-count-1 fallback.
- An explicit full-resolution `ImageProcessingPostProcess` uses a half-float texture and the scene's ACES configuration with exposure 1.08 and contrast 1.04.
- A full-resolution FXAA pass (`FxaaSharpenPass`, Babylon's FXAA 3.11 ported so the sharpen can ride in it; at a zero amount it is the stock pass, pixel for pixel) follows tone mapping at the sample-count-1 tiers, reading an unsigned-byte target.
- A final contrast-adaptive sharpen (AMD FidelityFX RCAS) restores the acutance FXAA and the browser's bilinear canvas upscale remove, at every tier that sets `sharpenAmount` above zero (tier 1 0.7, tiers 2/3 0.4; tier 0 off). Where FXAA runs it is FUSED into the FXAA pass (`FxaaSharpenPass`, 2026-10-24): FXAA already fetches the centre and its four-neighbour cross, which is RCAS's whole footprint, so the sharpen adds a few dozen ALU per pixel and no fetch, pass, draw or target. At the multisampled tiers it is a pass of its own after the tone map (`SharpenPass`: 5 taps, one LDR target counted in the framebuffer row, one more full-screen draw). Whichever runs is last: `applyProfile` detaches both and re-attaches the profile's one.
- Bloom (7-5) runs between rod vision and the tone map, on scene-referred linear radiance: a full-resolution soft-knee bright pass, a half-resolution separable Gaussian (9 taps, sigma 2.0), and an additive composite at intensity 0.08. It is enabled at tier 1 only — tier 0 is unmeasured rather than refused, tiers 2 and Ultra are unfunded. The bright pass is full resolution deliberately: it becomes the first post-process whenever the scotopic pass detaches, and the first pass's ratio sets the size of the target the scene renders into.
- The device pixel ratio is capped per tier (1/1.5/2/2) and the total scale product is clamped by the tier's absolute pixel cap (1A-6a) — no display can raise rendered pixels past it.
- Two governors adapt per 120-frame window (1A-6b, repaired by R-11): Governor A uses presentation interval minus measured CPU time as its normal GPU/pacing proxy, steps resolution by 0.05 down / 0.025 up to a 0.75 floor, undoes and latches against steps that do not improve the same timing domain, and — when latched or floored — sheds GPU-cost work levers (cloud-shadow cadence, shadow-caster distance, vegetation distance). Governor B sheds CPU-cost levers (terrain-page requests, detail generation slice, animal budget) only on CPU-bound windows. Explicit timestamp captures can substitute a GPU signal, but unlike the old policy normal gameplay does not burn frame time merely to decide how to save it.
- Diagnostics additionally track a rolling 600-frame window for p95s and the Z-2 hitch metrics (max frame, p999, hitch count against 2× the tier frame target); >250 ms stalls are counted there even though the governors' own p95 ignores them.

## Diagnostics and regression testing

The performance overlay exposes:

- FPS, current frame interval, and start-to-start frame-interval p95.
- CPU frame time; explicit diagnostic captures also expose labelled GPU timing epochs and sample freshness.
- Draw calls, triangles, geometries, and textures.
- Resident terrain pages and visible detail/wildlife thin instances.
- Active animals and river/lake counts, with WATER GEN ON MAIN THREAD after a hydrology fallback, and (since 2026-10-25) VEG WORKER RESTARTED xN after vegetation worker respawns and VEG GEN ON MAIN THREAD after its fallback.
- Requested rendering mode, active render scale, cloud step request, and ocean FFT resolution/cascade count.
- WebGPU adapter label, backend, and render-technique identifier. The fallback reason is always `null` for a successfully created renderer because there is no alternate backend.

The game reads these every 500 ms, and since 2026-10-25 only while the diagnostics setting is on or the terrain viewer's HUD is up (`src/game/diagnosticsCadence.ts`): a read walks every desired detail cell and inventories GPU memory.

### Gate B frame attribution

Frame interval, CPU duration and GPU duration overlap; they are not additive.
The renderer pairs each start-to-start interval with the CPU work from the
frame that just ended. Babylon's asynchronous GPU counter does not expose a
submitted-frame identifier, so its distribution cannot be safely correlated
with either value. Consequently `presentWaitMs` and `presentWaitP95Ms` remain
`null` until a correlatable timestamp source exists. This is intentional: a
difference of independent p95s is neither the p95 of per-frame residuals nor a
literal present/compositor timer.

Before Gate B tuning, the nine committed sub-30-fps shots occupied 34.4–45.5 ms
intervals from sustained fps, against 5.3–7.4 ms CPU p95 and 11.8–20.45 ms GPU
p95. `interval − max(cpu,gpu)` therefore left a 17.3–33.6 ms aggregate
pacing/uncaptured envelope. That range motivated the new interval diagnostic;
it is an inference across aggregates, not a field emitted by the runtime.

For performance changes, test a fixed URL seed, camera mode, weather/time preset, altitude, viewport size, device-pixel ratio, scenery quality, and rendering intent. Record the adapter and browser version. Compare at least a 30-second steady sample after terrain/detail residency and shader/pipeline compilation settle; renderer creation, first compute-pipeline compilation, first audio unlock, and a fresh page-streaming burst are not representative steady state.

The required medium/balanced acceptance contract on the pinned reference
adapter is at least 60 raw wall-clock FPS, frame-interval p95 at most 16.67 ms,
at most five intervals over 27.4 ms per 240 frames, and no interval over 50 ms.
There is no 30 FPS medium/balanced escape hatch. Other adapters remain useful
diagnostics, but cannot lower the reference contract.

## Night (Gate 7A)

Night is a separate workload, and it is deliberately cheap:

- **Stars** are one additive draw of ~4,700 magnitude-driven point sprites —
  ~190 authored bright stars carrying real J2000 positions and colour indices,
  and a background generated to the observed magnitude-count law. The sprite
  is sized in PIXELS in clip space, so the adaptive governor's render scale
  cannot change a star's apparent size. Atmospheric extinction is applied per
  star from the Kasten–Young air mass, which is why faint stars go out near
  the horizon before bright ones. The whole field is disabled above civil
  twilight.
- **The moon** costs one branch in the sky fragment and one directional
  light. It does not cast shadows (see `7-9`).
- **Scotopic vision** is one full-screen pass ahead of the tone map only while
  the resolved rod fraction is nonzero. Photopic daylight detaches the pass
  entirely and transfers first-pass/MSAA ownership to the existing half-float,
  ratio-one ACES pass, avoiding a full-resolution copy without changing its
  input. When night returns, scotopic is reattached at slot zero and retakes
  the multisampled beauty target before ACES.

**Night is not rendered at photometric scale, and that is a recorded
decision.** The sun-to-full-moon range is 4.8 × 10⁵ against an fp16 beauty
target whose smallest normal value is 6.1 × 10⁻⁵. Covering it needs a scene
pre-exposure applied to every light and every shader that writes radiance —
which is precisely what assertion 29 forbids a shader from doing. Two named
constants carry the absolute level; every relative quantity (phase, the
opposition surge, altitude, distance, magnitude ratios, extinction, spectral
colour) is computed, and the rod/cone decision reads the true illuminance.
`7-4`'s clustered lighting meets the same range with light points and is
where the pre-exposure decision belongs.

## Vegetation: a draw-call workload, and an open frame row

`2-12` measured the currency directly: every (species, variant, band) mesh is
one draw per presentation chunk per pass at ~26 µs of GPU, `Δgpu` tracked
`Δdraws` linearly across all the capture shots, and triangle deltas
measured ~0. Two consequences the vegetation perf-debt pass made concrete:

- **The capture report carries `vegetationBatches`** — frustum-surviving
  vegetation batches, the number the frame row is actually spent on. Without
  it the row could not be measured at all, only asserted.
- **§5.4's 1.8 ms vegetation row is not met, and cannot be met by any lever
  §5.3's vegetation trade-off rule permits.** Draws scale with (chunks ×
  meshes); a presentation chunk is 4,096 m, wider than the whole near+mid
  field at every tier, so band radii and stem counts barely move the number,
  and crown variants per species are explicitly not a budget knob. The pass
  took every available lever (far-band impostor meshes 7 → 1 per chunk,
  §5.3's published band radii, instance-buffer reuse and recycling) for
  −1,201 draw calls across the capture set, and priced the structural
  remainder in `renderedDensity.ts`: `VEGETATION_DRAW_CEILING` is what the
  renderer meets and the submission ratio beside it is the gap. (That ratio is
  now named `VEGETATION_DRAW_SUBMISSION_RATIO`; the historical
  `VEGETATION_FRAME_DEBT_RATIO` symbol no longer exists in `src/` or `tests/`,
  and the ceilings themselves have been re-pinned twice since this pass — read
  `renderedDensity.ts` for the live values rather than any number quoted here.)
- **Gate B did not erase that debt by accounting.** A crown/trunk prototype
  merge reduced modeled draws but moved trunks from the opaque depth pre-fill
  into the alpha-test path. All five core sub-30-fps captures regressed by
  0.78–2.09 ms GPU; only one of all nine improved by at least 2 ms. The merge
  was rejected and reverted, so the split-runtime ceilings and debt ratios
  remain the truthful values.
- **`4.5-C1` took the one large lever that was left: vegetation no longer
  CASTS shadows below tier 2.** The near band was resubmitted once per cascade,
  which is 148 of tier 1's 347 modelled draws and 3.85 of its 9.02 modelled ms
  — the largest single term, and outside §5.3's ladder (D15 is the precedent:
  it cut a tier-2 cascade specifically to reduce vegetation shadow draws).
  Trees keep the shadows they receive. Measured 445 → 397 draw calls at the
  reference viewport, against 148 modelled: the model counts every
  presentation chunk a band's disc touches and the frustum drops most of them,
  so its ORDERING is right and its magnitude is not. Ceilings re-pinned to
  160/200/500/650, debt ratios to 3.28/2.87/6.32/4.56.
  > **Superseded 2026-08-31 (`6-12`). Both figures above are historical: they
  > are what `4.5-C1` pinned, not what the tree holds.** `VEGETATION_DRAW_CEILING`
  > is now **`[50, 58, 440, 515]`** — tiers 0 and 1 fell by roughly 3x after
  > `6-8`'s canopy handoff and `6-9`'s GPU scatter, and tier 3 rose. Asserted
  > against the constant by `tests/docs-truth.test.ts`.
  >
  > **`VEGETATION_FRAME_DEBT_RATIO` no longer exists.** Grep for it: zero hits in
  > `src/` and zero in `tests/`. It survives only in prose — here, in
  > `ARCHITECTURE.md` (three rows), `PROJECT_OVERVIEW.md` (two) and
  > `PHASE_2_EXECUTION_PLAN.md` — where four documents quote a constant the
  > renderer does not define, each carrying a specific four-number tuple no code
  > produces. This is the decorative-list rule's sharpest form: not a list that
  > drifted from its artifact, but a list whose artifact was **deleted** while
  > every document describing it stayed green, because prose has no compiler.
  > The debt ratio it expressed — modelled draws over the renderer's ceiling — is
  > now read directly off `estimateVegetationDrawCalls` against
  > `VEGETATION_DRAW_CEILING`; there is no stored ratio to quote.
- **§7's next lever down does not measure.** `grassRadiusMeters` 150 → 110 at
  tier 1 is ranked at "~7 ms extra in ground-level shots". It moves
  ground-cover instances 3,372 → 1,836 at the `ground-2m-lowsun` pose — the
  knob works — and that shot's GPU p95 by 0.11 ms, which is noise. Left at
  §5.3's Balanced row; `6-11` owns the re-tier and now has a measurement to
  start from rather than an estimate.

### The far field exists (tree LOD continuity, 2026-09-13)

The rendered-density law carries a second floor, **`impostorFloorShare`**
(the "Impostor floor share" row of the tier table: 0.20 / 0.30 / 0.35 / 0.40).
It is the share of the near cap drawn in SOME representation beyond the near
radius; the gap between the geometry share (still floored at 0.045/0.035) and
this floor is drawn as 2D octahedral impostors, inside the mid band from the
crossover `near / √floor` (~274 m at Balanced) as well as beyond it, and the
GPU thins per stem against the live camera range (the canopy key rides the
phase lane). Before it, the impostor band inherited the geometry floor —
~3.5 stems/ha beyond ~700 m at Balanced — and a stem's first frame was its
cell's rebuild on approach. The change is a §5.3 count-row raise, booked there
as the user's own amendment; the woody triangle ceilings
(`WOODY_TRIANGLE_BUDGETS` 710k / 2.3 M / 3.55 M / 7.6 M) and the tier-3
`detailInstanceBudget` row (420 k) moved with the law and are pinned against it.

Measured on the M2 Pro at Balanced, back-to-back on the same host:
`forest-line-highsun` 101.5 fps (baseline tree) → 101.1 fps (fill at 0.30).
The first cut measured 67 fps at every floor tried — `detailTreeStemKey`
clamped the keys of stems the near cap never draws into the lane instead of
rejecting them, and the near band drew the whole authored field. Impostor
fragments now fetch only the stem's season bucket (three albedo fetches, not
six). Vegetation baselines were re-promoted for this change; see the
re-promotion note under the shot table.

**2026-09-14 follow-up.** The first landing cut impostor records at
`far + slack` from the build-time observer, which made the far cull edge a
frontier: chunks straddling it re-baked every 64 m with their whole impostor
set, the sweep fell behind in flight, and the far band arrived cell by cell as
a straight-edged patchwork with hitches. Impostor records now have no outer
membership edge (the shader culls at the live range), the far edge is not a
frontier term, and impostor-only stems build through a block-charged fast path
— a far chunk rebuilds when a cell generates, never when the observer moves. Two smaller fixes rode with it: the impostor exclusion no longer
applies to cells beyond the mid envelope (it was leaving the widest crowns of
every far cell without any record), and cell residency reaches one cull fade
past the impostor radius so a new cell publishes outside the live cull and
dithers in; `detailInstanceBudget` rows 150 k / 260 k / 560 k for tiers 1–3. Each impostor batch keeps a per-cell AABB of its records (from the
packed positions at publication) and rebuilds its bounding box every update
from the cells inside the live cull only, hiding the batch when none is — so
frustum culling sees exactly the records that can draw, the residency lead adds
no draw on the static shots, and their ceilings stand. The three moving shots
gain one real draw each (the far band's chunk is now published, with in-cull
records in frame, at the sample instant) and their ceilings move by one.

### The tropical coast's palms (2026-10-24)

The tropical coast biome (`src/world/tropicalCoast.ts`, one weight from the
climate province's raw offsets, exactly 0 in the temperate core and on the
warm and dry plateaus) adds a fourth tree prototype family, the palm, and
moves nothing inside the core: every new term is `x + 0 * k` there, and the
species branch draws its extra random only where the weight is above zero.

- **Draws: one cohort per chunk, so the families stay at three.** Palms grow
  only with oak, maple and birch (`TREE_SPECIES_COHORTS`); conifers and willow
  fade out over the weight's first 0.3 and palms only begin at 0.7, so a
  broadleaf-only belt lies between them. A tropical chunk submits two
  families (oak, palm) where a temperate one submits three, and the draw
  model prices the costlier cohort, so `VEGETATION_DRAW_CEILING` and the
  submission ratios are unchanged. The exception is a band disk that reaches
  across a steep province ecotone and sees both cohorts: there a chunk can
  submit all four families (tier 0 models 54.2 draws against its 50 ceiling).
  Measured on five seeds over 400 km squares, tier 1's 1.1 km mid disk does
  so on 0.05-2.0% of the world, 4-12% of the places that see a palm
  (`tests/world.tropical-coast.test.ts` re-measures one seed).
- **A closed canopy from wider crowns, not more stems.** The tropical
  broadleaf's crown radius is 1.22× at full weight while its exclusion
  kernel keeps the unspread crown, so the stand and the rendered-density
  caps keep their stems and instance counts; the cost is crown fill, which
  the forced-tropical timing below measures. Palms take up to 85% of the
  stems on the beach ridge and a tenth of the forest above 16 m.
- **Triangles inside the law's allowances**: near palms 848-944 (≤ 1,500),
  mid 300-316 (≤ 340). The mid mesh keeps every other frond and every other
  rachis segment, widened 1.2× to hold its coverage.
- **Memory falls, though three layers were added.** The palm needs a frond
  card and a bark layer in the foliage atlas (18 → 20 layers, 6.0 → 6.67 MiB)
  and the eighth and last impostor row (the variant byte's three species bits
  are now full). Evergreens bake ONE impostor layer for both season buckets,
  since their bare bake was byte-identical to the leafed one, so the impostor
  arrays go from 14 to 12 layers (9.33 → 8.0 MiB). Net: tier 0 at
  2560×1440@2 estimates 258.87 MiB against its 260 ceiling (259.63 before),
  every tier 0.76 MiB lower. Conifer impostors are pixel-identical.
- **The far band: one shader edit, no new work.** Its season bucket was chosen
  by three `season > selector` comparisons (one per blended view); it is now
  one comparison and a tint test (`season > selector && tint.a < 0.999`)
  shared by the three, so a stem the generator kept in full leaf (an
  evergreen, or a tropical broadleaf with no cold season) never reads its
  bare bucket. No baseline moves: summer shots never select bare, and on
  `winter-noon` (day 355) every deciduous stem's leaf fraction is 0.
- **Ground is bake time only.** The land-cover bake's beach band reaches
  8 m instead of 3 m at full weight and its wave-washed gravel strip fades
  out (CPU and WGSL twins). No new material layer: the beach is the
  existing Sand.
- **The sea: data, plus one per-pixel bed term (the biome's only new
  per-pixel work).** The environment field (a 96² CPU bake) carries 20% of
  a tropical coast's runoff, so its water is clear, and its unused B channel
  carries the tropical weight as reef carbonate. The ocean vertex reads
  `.xyz` of the sample it already took (its province varying goes vec3 →
  vec4: the same inter-stage location), and `analyticWaterBedAlbedo` mixes
  by it toward a near-white coral sand that covers 70-95% of the bed instead
  of 0-32% and stays pale to 18-60 m instead of 8-45 m. **Cost, per ocean
  fragment: three mixes, one extra smoothstep and two multiply-adds**,
  beside the bed's existing sin and the radiance model's exps; SwiftShader
  runs it on every ocean fragment whatever the carbonate, so the core shots
  measure it: water-25ft −0.3%, cruise-horizon +0.5% GPU, both SAME (below).
  **Identity at 0:** every term is `mix(x, y, carbonate)` and the channel is
  0 outside the tropics; inland water passes a literal 0.0.
  `tests/gpu/water-bed-carbonate.test.ts` runs the shipped bed beside the
  pre-carbonate one on a real adapter, with the carbonate read from a buffer
  so no compiler folds it. On SwiftShader they agree to the bit on all 360
  probes; a first cut that shifted the silt fade's smoothstep edges by the
  carbonate did NOT (last-bit differences at 18 m: runtime edges lower
  differently from literal ones), so the fade is two literal-edged
  smoothsteps mixed by the carbonate. **Metal is the exception:** its
  compiler contracts and reassociates f32, so on the macOS suite 20 of 1,080
  channels round apart in the last bits even at a carbonate of 0, and the
  test holds Metal to 1e-4 of albedo (a fortieth of a display level; a
  0.001 carbonate leak would show as ~3e-4). So the core sea is
  bit-identical on SwiftShader (water-25ft and cruise-horizon rendered
  identical frames) and within that rounding on Metal, where no source-level
  gate can promise bits: any edit to a shader can change how Metal rounds
  it.
- **Timing** (cloud A/B, SwiftShader, 16 rounds; GPU gated at 5%, CPU a 15%
  guard). Against the climate provinces head before the dry and cold merges
  (5053f6b, this branch's first cut of the bed): GPU SAME on all six:
  approach-500ft −0.1%, cruise-horizon −1.1%, forest-500ft-sunbehind −0.2%,
  ground-2m-lowsun +0.3%, water-25ft +0.4%, and forest-500ft-sunbehind's
  framing inside a forced tropical province +0.3% (palms and the spread
  crowns). Draws identical on every shot (248, 201, 249, 122, 225; 266
  forced). The CPU guard was SAME on three and unresolved on three
  (water-25ft +11.1%, interval +0.7% to +22.3%; ground −6.7%; forest
  +1.2%), none clearing its 15%; nothing in this branch runs on the main
  thread per frame. Pixels: identical on approach, cruise, ground and water;
  forest-500ft-sunbehind 0.16% (26 px over 8/255, all on the horizon band,
  where a natural tropical province lies ~96 km out). With the final bed,
  against the cold and dry merges (069b496, so this branch's whole change
  on top of them): water-25ft GPU SAME −0.3% (−1.1% to +0.5%), CPU SAME;
  cruise-horizon GPU SAME +0.5% (−0.5% to +1.4%), CPU unresolved +5.4%;
  draws 225 and 201 unchanged, and both shots rendered identical frames.

## Visual fix-pack (2026-08-25)

The four flight-test reports of 2026-08-25 (plastic foliage/ground, plastic
close-up water, smooth/tearing mountains, the fighter's look and feel) landed
as `VISUAL_FIXPACK_PLAN.md`, with the representational decisions recorded in
ARCHITECTURE.md's decision log (fix-pack rows). The cost discipline: every
addition is ALU-only or measured against the reference host before shipping —
the terrain meso band, water capillary band and crown cluster shading are
noise-function work inside existing passes; the one draw-count addition (the
near-band crown fringe) was measured at ~4 ms of p95 at its first size and
shipped at half that size for ~0 ms. The capture set gains `water-25ft`, the
first shot that puts the camera near the water. The measured tier row below
was re-taken at the fix-pack close — same host, same contract, all sixteen
prior shots plus the new one.

## Promoted Phase 6/R4 tier row (historical baseline)

The earlier 15–20 FPS measurements were traced to continuous Babylon WebGPU
timestamp observers, not to unmeasured compositor idle. Babylon resolved and
mapped timestamp buffers through extra submissions while returning only 49
whole-frame samples in a 240-frame window. A controlled reference A/B measured
86.92 FPS / 13.6 ms p95 with those observers enabled and 120.25 FPS / 8.9 ms
p95 with them disabled: a 4.7 ms p95 tax and 38% throughput loss. Gameplay now
uses the interval-minus-CPU governor signal; timestamp observation is an
explicit create-time diagnostic only.

The first twenty-four rows below preserve the Phase 6 `R1`+`R2`+`R3`
historical snapshot promoted **2026-08-31** from the reviewed candidate at
`tests/perf/artifacts/rebaseline-candidates/2026-08-31T16-39-53.222Z` on
Apple Metal 3 / headless Chrome 151, medium/balanced, with 240 measured frames
per shot after deterministic residency drain. The normal shots use the shipped
0.86 render scale; `reference-viewport` retains its 1.485 Mpx scale-1
cap-stress contract.

The **current committed baseline set** contains thirty PNGs. R4 re-promoted all
thirty together at `090bf2f` on 2026-09-01 after three complete idle-host runs;
the six rows appended at the bottom of this table came from that promotion.
Their immutable input samples and candidate-directory provenance live in
`scripts/deliveryFloors.mts`. The table therefore preserves two named
historical snapshots rather than pretending its thirty rows came from one run.

**Re-promoted 2026-09-03 — all thirty images, visual evidence only.** Every
committed PNG was replaced from the reviewed candidate at
`tests/perf/artifacts/rebaseline-candidates/2026-09-03T15-48-09.890Z` (Apple M2 Pro /
Metal, headless Chrome for Testing 151, medium/balanced, canonical viewport),
the first capture of the rendered ocean after three fixes landed together: the
bathymetry kernel's double-applied rectangle origin (`7b2d08b` reverted), the
translucent airframe's depth pre-pass holing the sea behind the propeller disc
(`core/RenderingGroups.ts`), and the withdrawal of the water-only Earth-curvature
drop (`1C-7`). Each is a row in `ARCHITECTURE.md`'s decision log. Every frame was
reviewed individually before the copy; the sanctioned churn is the sea itself —
the previous set showed the terrain bed wearing water shading, because the
spectral ocean had never rendered — plus the Phase 7 night and airfield-lighting
work that landed after R4 (`night-moonlit` moved from 0.48 SSIM for that reason
alone). In that run every visual, temporal, renderer-error, settling and
lit-region gate passed; its 13 failures were all delivery floors, on an unpinned
host with the Node unit suite running concurrently, so **the table's rows and
the delivery floors were deliberately NOT re-pinned** — the rows below remain
the floor provenance and the reference-machine contract, and a clean
reference-adapter run is still owed before any floor moves.

> **Corrected 2026-08-31 (`6-12`). The paragraph above previously described the
> 2026-08-26 polish-pass promotion and claimed seventeen shots.** Three things
> were wrong, and the third is the one worth keeping:
> 1. **The shot count was seven short.** Waves P/Q/R appended `grove-forest-2m`,
>    `grove-meadow-2m`, `hills-dusk-glint`, `mountain-close`,
>    `forest-line-highsun`, `cliff-60m` and `water-3m`. Shots are APPEND-ONLY and
>    canonical-index-keyed, so a stale count is not a cosmetic error — it implies
>    a different index mapping than the one the harness uses.
> 2. **The promotion was superseded.** Phase 6 rebaselined on 2026-08-31.
> 3. **It was internally impossible and nobody noticed**: it claimed promotion
>    *on 2026-08-25* from a candidate stamped *2026-08-26T17-55-18.868Z* — a
>    promotion one day before the run it promoted. A date that cannot be true is
>    the cheapest possible signal that a paragraph is no longer maintained, and
>    it sat in the document through two phases.
>
> **Every figure in this section is now derived from that candidate's
> `report.json`, which was verified byte-identical to all 24 committed PNGs
> before being quoted** (`cmp` over the set: 24 identical, 0 differing, 0
> missing). It is quoted rather than re-measured because `perf:capture` may not
> run for this pass — see the standing thermal note in §Capture harness.

> **Later correction, 2026-09-03.** Neither promotion validated ocean run-up,
> shelf dispersion, or caustics in rendered pixels. The component code and its
> green gates existed, but the fp16 ocean spectrum was non-finite and the ocean
> presentation remained NaN-collapsed until the current continuation. The mesh
> first became visible at `2131a60`. These rows consequently describe the
> pre-ocean-presentation renderer; they are historical comparison and floor
> provenance, not performance or visual acceptance evidence for the current
> rendered-ocean tree. The IMAGES were re-shot from the rendered-ocean tree on
> 2026-09-03 (candidate `2026-09-03T15-48-09.890Z`, promotion note above the
> table); the rows' delivery figures are unchanged.

The promotion did sanction the other visible Phase 6 churn — wetness, ecology
channels, talus, the rebuilt canopy handoff, and GPU scatter. **Only 5 of the 21
comparable shots stayed at or above 0.99 SSIM; the other 16 moved**, and that
movement is the substantive thing the promotion blessed rather than an artifact
of it. (The three motion shots — `motion-banked-turn`, `page-thrash-turn`, and
`cdlod-transition` — record `null` SSIM by design, which is why 21 compare and
not 24.) The pre-ocean-presentation tree came out slightly faster against the
strict tier-1 contract; that conclusion does not transfer to the current tree.

**Delivery floors were deliberately NOT re-pinned at this promotion.** One
cool-host run samples the favourable end of a roughly 20% thermal band, so the
existing 98–102 floors stand and re-pinning waits for a later run with at least
three samples. A single green capture is evidence that the tree is fast; it is
not evidence about where the floor belongs.

| Shot | raw wall FPS | interval p95 | >16.67 ms | >27.4 ms | max | draws | inventoried |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `approach-500ft` | 120.1 | 9.4 ms | 0 | 0 | 10.3 ms | 150 | 484.9 MiB |
| `slant-10km` | 120.0 | 9.2 ms | 0 | 0 | 9.6 ms | 132 | 484.3 MiB |
| `high-10000ft-down` | 120.0 | 9.2 ms | 0 | 0 | 9.8 ms | 72 | 485.0 MiB |
| `reference-viewport` | 120.3 | 9.3 ms | 0 | 0 | 10.1 ms | 151 | 492.3 MiB |
| `cruise-horizon` | 119.9 | 9.1 ms | 0 | 0 | 12.2 ms | 129 | 484.9 MiB |
| `winter-noon` | 120.1 | 9.2 ms | 0 | 0 | 10.1 ms | 150 | 484.9 MiB |
| `night` | 120.1 | 9.2 ms | 0 | 0 | 9.7 ms | 152 | 484.9 MiB |
| `night-moonlit` | 120.0 | 9.8 ms | 0 | 0 | 10.7 ms | 152 | 485.1 MiB |
| `dusk-mesopic` | 100.4 | 11.4 ms | 0 | 0 | 13.5 ms | 248 | 368.5 MiB |
| `motion-banked-turn` | 117.7 | 9.8 ms | 1 | 0 | 18.1 ms | 155 | 484.7 MiB |
| `page-thrash-turn` | 118.7 | 9.7 ms | 0 | 0 | 12.3 ms | 154 | 484.7 MiB |
| `cdlod-transition` | 119.9 | 9.1 ms | 0 | 0 | 10.3 ms | 122 | 483.9 MiB |
| `cruise-sun-30` | 119.9 | 9.0 ms | 0 | 0 | 11.0 ms | 131 | 484.0 MiB |
| `forest-500ft-sunbehind` | 120.2 | 9.2 ms | 0 | 0 | 9.9 ms | 151 | 484.7 MiB |
| `coast-10km-lowsun` | 120.0 | 9.0 ms | 0 | 0 | 9.6 ms | 127 | 483.9 MiB |
| `ground-2m-lowsun` | 119.9 | 9.5 ms | 0 | 0 | 10.5 ms | 121 | 485.0 MiB |
| `canopy-1200ft` | 119.8 | 9.1 ms | 0 | 0 | 12.8 ms | 113 | 484.7 MiB |
| `runway-on-approach` | 120.1 | 9.4 ms | 0 | 0 | 10.4 ms | 161 | 485.7 MiB |
| `water-25ft` | 120.0 | 9.3 ms | 0 | 0 | 13.9 ms | 130 | 483.9 MiB |
| `grove-forest-2m` | 120.2 | 9.1 ms | 0 | 0 | 9.6 ms | 120 | 484.7 MiB |
| `grove-meadow-2m` | 120.1 | 9.4 ms | 0 | 0 | 10.6 ms | 134 | 484.8 MiB |
| `hills-dusk-glint` | 120.1 | 9.2 ms | 0 | 0 | 9.8 ms | 147 | 484.7 MiB |
| `mountain-close` | 120.1 | 9.3 ms | 0 | 0 | 9.8 ms | 174 | 486.0 MiB |
| `forest-line-highsun` | 120.2 | 9.2 ms | 0 | 0 | 9.6 ms | 147 | 484.7 MiB |
| `cliff-60m` | 120.1 | 9.1 ms | 0 | 0 | 10.1 ms | 163 | 486.4 MiB |
| `water-3m` | 120.0 | 9.4 ms | 0 | 0 | 10.0 ms | 90 | 483.9 MiB |
| `veg-seam-1600ft-oblique` | 120.2 | 9.9 ms | 0 | 0 | 10.7 ms | 108 | 484.9 MiB |
| `veg-seam-near-500ft` | 120.2 | 9.6 ms | 0 | 0 | 10.7 ms | 116 | 484.9 MiB |
| `terrain-material-1600ft-down` | 119.8 | 9.2 ms | 0 | 0 | 13.9 ms | 93 | 486.4 MiB |
| `horizon-shadow-far-annulus` | 119.9 | 9.6 ms | 0 | 0 | 10.7 ms | 91 | 485.8 MiB |
| `canopy-backlit-lowsun` | 120.3 | 10.0 ms | 0 | 0 | 10.6 ms | 102 | 485.6 MiB |
| `golden-hour` | 98.7 | 11.4 ms | 0 | 0 | 15.1 ms | 247 | 368.5 MiB |
| `blue-hour` | 100.1 | 11.4 ms | 0 | 0 | 14.8 ms | 247 | 368.5 MiB |
| `night-beacon-offset` | 100.7 | 11.4 ms | 0 | 0 | 13.3 ms | 249 | 368.5 MiB |
| `apron-hangar-variety` | 120.2 | 9.8 ms | 0 | 0 | 11.0 ms | 117 | 368.5 MiB |
| `sunset-sunward` | 98.4 | 11.5 ms | 0 | 0 | 14.0 ms | 246 | 368.5 MiB |
| `approach-lights-outboard` | 96.3 | 12.0 ms | 0 | 0 | 14.0 ms | 266 | 368.5 MiB |
| `lake-island-piercing` | 120.0 | 9.7 ms | 0 | 0 | 10.6 ms | 91 | 368.5 MiB |
| `water-400ft-glitter` | 119.7 | 9.5 ms | 0 | 0 | 12.5 ms | 87 | 248.4 MiB |
All twenty-four shots in the Phase 6 snapshot cleared the strict FPS, p95,
hitch-count and maximum-frame contract on the pre-ocean-presentation tree, with
Phase 6's wetness, ecology, talus, canopy handoff, and GPU scatter live and
**delivery gates enforced**
(`deliveryGatesEnforced: true` in that run's `captureEnvironment`): minimum wall
throughput **117.73 FPS**, worst p95 **9.80 ms**, worst single frame **18.10
ms**, zero intervals over 27.4 ms and zero hitches. Peak inventoried GPU memory
was **492.3 MiB** at `reference-viewport`, against the 495 MiB pinned ceiling —
**2.7 MiB, or 0.5%, of measured headroom**. R4 subsequently cleared and
re-promoted the current thirty-shot baseline as one set and derived its standing
floors from the three stored runs. In both promotions every final
terrain/detail pending count was zero, and the raw-device validation listener,
Babylon/console gates, GPU drain, black/uniform-frame policy and temporal checks
passed before artifacts were accepted.

**Current continuation status (2026-09-03).** The ocean presentation is now
finite and bounded to a 90 km radius. A targeted recapture passed the explicit
seam, faceting, and gap review. The latest full candidate,
`2026-09-03T04-19-09.608Z`, is nevertheless `NOT APPROVABLE`: its generic tier-1
gate passed (minimum wall throughput **71.84 FPS**, worst p95 **16.10 ms**, at
most **3** intervals over 16.67 ms in any shot, and zero intervals over 27.4 ms
or hitches), but **63** per-shot ratchet assertions failed across **21 of 31**
pinned shots. Two orphaned GPU suites were concurrently using the same integrated
GPU, so this run is not valid regression-attribution evidence and cannot justify
floor changes. It must be rerun on a genuinely idle reference machine. No floor
or baseline was promoted, re-pinned, or loosened from that run.

**Superseded the same day.** Candidate `2026-09-03T15-48-09.890Z`, captured after
the bathymetry-origin, airframe draw-order and water-datum fixes, passed every
non-delivery gate and was promoted as the current thirty-image baseline set
after a frame-by-frame review (see the promotion note above the table). Its
delivery numbers are still not reference-adapter evidence — unpinned host,
concurrent load — and no floor was re-pinned or loosened.

The GPU and capture projects now keep independent `.vite-gpu` and `.vite-perf`
optimizer caches with complete, discovery-disabled Babylon dependency sets. On
macOS they launch full Chrome for Testing through a checked-in shim that preserves
Playwright's CDP descriptors while redirecting browser stderr before detached
crashpad helpers can inherit Playwright's pipe. A cold-cache **58-file / 130-test**
GPU run consequently passed and exited normally in **134.83 s**; this changes test
harness ownership only and does not alter renderer feature flags or acceptance
thresholds.

> **Amended 2026-09-22.** Those caches were per project but not per checkout.
> Every worktree resolves `node_modules` to one directory, and Vite hashes the
> project `root` into the optimizer's metadata, so a run from a second worktree
> re-optimized the first worktree's cache under a live run ("Must call super
> constructor", "CascadedShadowMap is not supported by the current engine").
> Every Vite and Vitest config now takes its `cacheDir` from
> `scripts/checkoutCacheDir.ts`: `node_modules/.vite-<kind>-<checkout>-<hash of
> the resolved checkout path>`. `tests/checkout-cache-dir.test.ts` finds every
> config by walking the tree and fails if one is left on a shared cache.

> **Corrected 2026-08-31 (`6-12`).** The figures above were the 2026-08-25
> fix-pack's (120.6 FPS / 9.4 ms / 17.6 ms across seventeen shots). Two further
> claims in the superseded text were wrong:
> - It listed **"the F-22"** among the live fix-pack changes. The tree ships the
>   **Vesper J-45**: the F-22 was reverted at Jason's explicit request in the
>   2026-08-26 polish pass, and the only surviving mention anywhere in `src/` is
>   a historical note in `stabilityAugmentation.ts:60` explaining why the yaw
>   gain differs from the airframe that no longer ships. This document was the
>   last place in the repository still asserting the F-22 as current.
> - The **worst-frame figure got worse, not better** (17.6 → 18.10 ms), on
>   `motion-banked-turn`, which is also the shot setting the fps floor. That is
>   the one row here trending the wrong way, and it is the shot the delivery
>   floors are least able to speak to on a single run — see the note on floors
>   above.
Independent review of every image found the formerly black approach populated,
the high-altitude terrain free of categorical altitude lobes and Rock
screen-door pattern, continuous winter snow, a straight analytic runway edge,
and continuous close-tree bark/crowns.

A candidate is review evidence, never an automatic baseline mutation: the
capture has no write path into `tests/perf/baseline`, promotion is a separate
deliberate action after review, and performance ceilings cannot be rebaselined
downward.

### Re-promotion 2026-09-17 — the ground patchwork (W-1)

Twenty baselines were re-promoted from candidate `2026-09-17T23-40-35.447Z`
after a frame-by-frame review of all 38 shots, for one sanctioned change: the
ground patchwork (docs/findings/GROUND_TEXTURE_W1.md). Jason's report was that
open, treeless ground *"is very flat and fake"* from altitude.

**What was wrong.** At 213 m AGL the 2.3–2.9 m material tiles sample near mip 7
— their own reference colour — because `3-1` high-passes every layer and
`fitAlbedoToReference` pins its mean, and the micro fade converges every
patterned channel once the anisotropy-limited footprint passes 1.5–10 m. Both
are correct and both are load-bearing. Between the tile and the 176 m macro
wash the only structure was fix-pack `T1`'s meso band, ±13% of tone at 71 m and
±8% at 23 m, in smooth value noise. Open ground was therefore one colour times
a smooth ramp.

**What it gained**, land-masked against the same harness on the merged base
(mean absolute RGB difference, share of pixels past 4/255, 16-px block
luminance std as a texture proxy):

| region | MAD | moved | block-std |
| --- | --- | --- | --- |
| terrain-material-1600ft-down, meadow crop | 5.66 | 50% | 5.52 → 8.09 (+46.5%) |
| high-10000ft-down, grass slopes | 3.60 | 36% | 3.07 → 4.31 (+40.4%) |
| viewer pose 213 m / 17°, lush | 5.24 | 52% | 1.87 → 3.76 (+101%) |
| viewer pose 213 m / 17°, dry | 5.13 | 52% | 1.71 → 3.57 (+109%) |

Rock, snow, sand, water and pavement are untouched by construction: the whole
block rides the vegetated share. The pure-water shots moved 0.06 and 0.19 of
255, which is run-to-run noise.

**What it costs.** Two runs per arm on the M2 Pro (NOT the pinned reference
host), `report.json` deleted between runs; same-arm noise floor 2.6% at worst.

| shot | base fps | branch fps | delta | base p95 ms | branch p95 ms |
| --- | --- | --- | --- | --- | --- |
| mountain-close | 117.1 | 107.4 | −8.3% | 10.6 | 11.5 |
| terrain-material-1600ft-down | 114.0 | 105.2 | −7.7% | 10.8 | 11.6 |
| winter-noon | 114.2 | 107.3 | −6.0% | 10.5 | 11.2 |
| approach-500ft | 114.3 | 108.2 | −5.4% | 10.2 | 11.3 |
| ground-2m-lowsun | 112.1 | 110.3 | −1.6% | 11.2 | 11.0 |
| canopy-1200ft | 114.7 | 113.2 | −1.4% | 10.6 | 10.5 |
| high-10000ft-down | 121.3 | 121.5 | +0.2% | 9.7 | 9.6 |
| cruise-horizon | 121.2 | 121.3 | +0.1% | 9.5 | 9.5 |

Draw calls and triangle counts are identical in both arms on every shot: this
is ALU on vegetated fragments and moves no batch. The cost lands where close
vegetated ground fills the frame and nowhere else. Tier 0 skips the block
entirely through a uniform lane (no new shader permutation): at that tier a
lush pose is capture-noise-identical to the pre-change build, 0.26 of 255 with
no pixel past 4/255. To give back roughly a third of the cost at tiers 1–3, set
`GROUND_VIGOUR_FINE_AMPLITUDE` to 0 in `GroundPatchwork.ts`; that is the whole
rollback.

**Margin worth knowing before a CI floor failure is diagnosed.**
`terrain-material-1600ft-down` measures 104.5–105.8 fps on this host against a
102 floor. This host is not the pinned reference and floors are never re-pinned
from an unpinned host, so the reference margin is larger — but if that shot
ever trips its floor on the reference host, this wave is the first place to
look. Nine shots already failed their fps floors on this host BEFORE this
change (reference-viewport, motion-banked-turn, forest-line-highsun,
forest-500ft-sunbehind, hills-dusk-glint, grove-meadow-2m, canopy-backlit-lowsun,
cdlod-transition, page-thrash-turn); grove-forest-2m joined them after it.

**Ten shots were left alone** because they moved at or under the 0.5-of-255
noise floor the base arm measures against its own baselines: cruise-horizon,
winter-noon, night-moonlit, canopy-backlit-lowsun, cruise-sun-30,
coast-10km-lowsun, water-25ft, ground-2m-lowsun, night and water-3m. Eight more
shots have no committed baseline and were not promoted.

### Re-promotion 2026-09-17 — water colour (W-7 through W-10)

Sixteen baselines were re-promoted from candidate
`2026-09-17T23-24-55.654Z` after a frame-by-frame review of all 38 shots, for
one sanctioned change: the water-colour wave
(docs/findings/WATER_COLOUR_2026_09_17.md). Jason's report was that the water
is *"basically always the same — light blue with white foam"* and *"from a
distance still looks like plastic"*. Four measurements answer it.

**What was wrong.** `5-11` carried ONE optical water type for every water body
in every world, and its in-scatter was ~25x too bright in green: deep water
emitted (0.030, 0.140, 0.120) at the reference key where clear ocean emits
(0.0008, 0.0056, 0.0203). It was lit by a grey scalar, so it kept its teal hue
under an orange sunset. Its sub-pixel slope variance was a sum of independent
estimates that overshot Cox & Munk's measurement and hit the roughness clamp —
a probe capture (roughness written to the beauty buffer) read near, mid and far
sea all within a few per cent of the ceiling, which is one BRDF for the whole
sea. And its foam came from a tuned Jacobian threshold rather than from wind.

**What it is now.** A water body is two spectra built from four concentrations
through published mass-specific spectra; the sea's concentrations come from its
own depth and a province field baked from the terrain's temperature and
moisture, lakes' and rivers' from their catchment at mesh build; the body is
lit by the scene's own coloured irradiance; the far field's variance is
anchored to Cox & Munk minus what the rendered normal already carries; foam
coverage is Monahan's wind law at Koepke's reflectance; and the sea has wind
shelter in the lee of coasts, Langmuir windrows, and the terrain occlusion of
its reflected sky that inland water has had since `6-11`.

**The frame review.** Fourteen of the thirty committed baselines are within
0.2/255 of the candidate — every pure-terrain, forest, canopy, runway and apron
pose — and every shot that moved past 1/255 has sea or a lake in frame. The
sixteen promoted, by how far they moved (mean absolute difference, /255):
`water-25ft` 19.5, `water-3m` 15.6, `cdlod-transition` 15.4,
`motion-banked-turn` 12.3, `page-thrash-turn` 8.1, `forest-line-highsun` 7.6,
`hills-dusk-glint` 6.4, `coast-10km-lowsun` 4.7, `forest-500ft-sunbehind` 4.2,
`terrain-material-1600ft-down` 4.2, `cruise-horizon` 3.8, `slant-10km` 2.3,
`winter-noon` 2.2, `reference-viewport` 1.9, `approach-500ft` 1.7,
`cruise-sun-30` 1.4. SSIM against the retired frames, where the harness
computes it: `water-3m` 0.791, `water-25ft` 0.847,
`terrain-material-1600ft-down` 0.915, `coast-10km-lowsun` 0.947,
`forest-500ft-sunbehind` 0.961, `cruise-horizon` 0.965, `reference-viewport`
0.972, `hills-dusk-glint` 0.975, `slant-10km` 0.975, `winter-noon` 0.979,
`approach-500ft` 0.979, `cruise-sun-30` 0.987, `forest-line-highsun` 0.996.
The headline A/B is `cdlod-transition`'s near sea magnified: bright teal under
heavy white speckle before, deep navy-slate with sparse whitecaps and visible
wind lanes after.

**NOT promoted, and why.** Five shots moved 0.3-0.6/255 with no water in frame
(`runway-on-approach`, `horizon-shadow-far-annulus`, `grove-forest-2m`,
`mountain-close`, `canopy-backlit-lowsun`) and three moved under 0.2
(`night-moonlit`, `veg-seam-1600ft-oblique`, `high-10000ft-down`). The last two
and `canopy-backlit-lowsun` were checked directly on the BASE arm against these
same committed frames: 0.157 / 0.009 / 0.207 on base against 0.165 / 0.009 /
0.326 on the branch, i.e. the same differences with or without this wave. The whole
diff touches seven source files — four water ones, the environment field, the
renderer's construction of it, and `AtmosphereSystem` exporting
`PEAK_SUN_INTENSITY` where the literal 5.2 stood — with zero lines in
`terrain/`, `detail/` or `clouds/`, so these are capture noise or pre-existing
staleness rather than water. Their baselines stand.

**Performance: no measurable cost.** Guarded A/B on this host, same tree, arms
switched back to back, four runs of the branch arm and three of the base arm,
alternating:

base fps -> branch fps (delta), with frame-interval p95 base -> branch. The
per-shot table above is the only pipe table this document may carry — its row
count is pinned against the committed PNGs — so this one is a list:

- `water-3m` 122.1 -> 121.8 (-0.29%), p95 10.37 -> 10.10
- `water-25ft` 121.4 -> 121.8 (+0.26%), p95 9.70 -> 10.10
- `coast-10km-lowsun` 121.6 -> 121.6 (-0.01%), p95 9.87 -> 9.90
- `cruise-horizon` 121.6 -> 121.5 (-0.03%), p95 9.80 -> 9.97
- `slant-10km` 121.5 -> 121.7 (+0.10%), p95 9.97 -> 10.05
- `reference-viewport` 88.3 -> 88.4 (+0.08%), p95 13.53 -> 12.90
- `ground-2m-lowsun` (control) 111.1 -> 111.3 (+0.17%), p95 10.67 -> 10.82
- `forest-500ft-sunbehind` (control) 102.6 -> 102.6 (+0.00%), p95 11.60 -> 11.22

Same-arm spread over four runs: median 0.82%, max 2.63%. Every shot is inside
±0.29%, a third of the noise floor. **Method note, and a trap worth naming:** an
A/B that switches arms by checking source in and out reads the harness's report
between runs — the mutable one a capture overwrites, not the timestamped copy
inside `tests/perf/artifacts/rebaseline-candidates/<ISO>/` — and a run that
DIES leaves the previous arm's report in place — a dropped browser connection did exactly that
here, and the stale numbers were caught only because eight shots matched the
previous arm to 0.1 fps, which is not a thing that happens. The arms above were
re-run with a guard that deletes the report before each arm and fails if none
is written, and `PerfCaptureReport` now carries `capturedAtIso` so a consumer
can compare it against its own start time.

**Delivery floors were NOT re-pinned**, and the candidate is stamped NOT
APPROVABLE: it ran on this unpinned M2 Pro with a second session capturing
concurrently, and its 21 gate failures are 20 delivery floors plus one
draw-call ceiling. That ceiling is not water's: `canopy-backlit-lowsun` reads
249 draws against its 246 ceiling on BOTH arms, as do `forest-line-highsun`
(258), `cdlod-transition` (209) and `water-25ft` (238) — identical between
base and branch, so it is stale in the same family as the `ground-2m-lowsun`
and `canopy-1200ft` staleness the terrain workstream reported.

**Cold start: no regression, and one thing moved off the critical path.** The
candidate script runs `cold-start` first and short-circuits on failure, and on
a busy host it did (2534 ms against the 2300 ms reference-host deadline), so
the candidates were captured directly with `VITE_PERF_REBASELINE=1`. Measured
three times per arm, alternating, while the machine was still shared: branch
2326 / 2254 / 2140 ms (mean 2240) against base 2102 / 2062 / 2301 ms (mean
2155), spreads 186 and 239 ms — overlapping, with the base's own worst run over
the deadline. Re-measured on a quiet machine with the deferred first bake in
place: branch 2167 / 2057 / 2026 ms (mean 2083) against base 2073 / 2007 /
2092 ms (mean 2057). A 26 ms gap inside an 85-141 ms spread, and both arms
comfortably inside the deadline. Scene-shader readiness, where the larger
water shaders would show, is 470-523 ms on the branch against 461-532 on base.
The one piece of real startup CPU this wave added — the environment field's
first bake — is now deferred past the first frame, because cold start's
time-to-ready waits for the first GPU-complete frame and the field has no
business on that path; the cost of waiting is one frame at the neutral
mid-province fallback, which is the province where its own contrast curve is
the identity.

**Open items** (also in the findings note): inland chemistry is latent in the
default analytic world (one ~100 m pond per 28 km window, no rivers at all —
rivers exist only in eroded worlds); glacial turquoise needs a lake above
~900 m and this seed's lakes sit at 29-223 m; the pale shallow margin is thin
because the coast profile drops 3 m within 0-40 m of the waterline, which is
terrain's to change; and the surf-zone foam reads from directly overhead as a
lace of repeated cells.

### Re-promotion 2026-09-14 — tree LOD continuity

Nineteen of the thirty committed baselines were re-promoted from candidate
`2026-09-14T19-12-19.208Z` after a frame-by-frame review, for one sanctioned
change: the impostor fill (`impostorFloorShare`, "The far field exists" above).
Every diverged frame shows the same thing — forest that used to end a few
hundred metres out now continues to the horizon, and nothing else moved:
`approach-500ft`, `slant-10km`, `reference-viewport`, `winter-noon`, `night`,
`night-moonlit`, `forest-500ft-sunbehind`, `ground-2m-lowsun`, `canopy-1200ft`,
`runway-on-approach`, `grove-meadow-2m`, `hills-dusk-glint`, `mountain-close`,
`forest-line-highsun`, `cliff-60m`, `veg-seam-1600ft-oblique`,
`veg-seam-near-500ft`, `terrain-material-1600ft-down`, `canopy-backlit-lowsun`.
Unchanged (SSIM ≥ 0.985 against the committed frame): `high-10000ft-down`,
`cruise-horizon`, `cruise-sun-30`, `grove-forest-2m`,
`horizon-shadow-far-annulus`.

**The four water shots were deliberately NOT re-promoted** (`water-3m`,
`water-25ft`, `coast-10km-lowsun`, `cruise-horizon`): a concurrent far-field
ocean branch owns those baselines and re-shoots them on merge. Their shoreline
forest diverges by the same mechanism (0.983 / 0.984 / 0.967 SSIM here), so
they will read as diverged until that re-shoot lands with both changes in the
tree.

**Delivery floors were NOT re-pinned**, and the candidate's fps column is not
evidence of anything: it ran on this unpinned M2 Pro under a peer session's
load (the last seven shots at ~30 fps). The frame-rate evidence for the change
is the back-to-back single-shot A/B on the same host recorded above
(`forest-line-highsun` 101.5 → 101.1, `canopy-1200ft` 109 → 113,
`veg-seam-1600ft-oblique` 121 → 122, `forest-500ft-sunbehind` 105.2 → 104.9,
`approach-500ft` 117.4 → 114.3, `veg-seam-near-500ft` 114.6 → 116.3).

### Re-promotion 2026-09-14 — the far sea (wave S)

Eight of the thirty-eight committed baselines were re-promoted from candidate
`2026-09-14T19-50-42.206Z` after a frame-by-frame review, for one sanctioned
change: the ocean's far field now carries its variance and not just its mean
(ARCHITECTURE.md decision log, "The far sea keeps its variance, not just its
mean"). The candidate was shot with the tree-LOD continuity change already in
the tree, so the water shots that section left diverged land here once, with
both changes. Every re-promoted frame has open sea in it, and a luminance
heatmap against its committed frame shows the change confined to the sea:
`water-25ft` (0.959 SSIM), `coast-10km-lowsun` (0.961), `water-3m` (0.963),
`forest-line-highsun` (0.974), `hills-dusk-glint` (0.981),
`forest-500ft-sunbehind` (0.984), `cruise-horizon` (0.989), `slant-10km`
(0.993). What the frames show is the same four things: sun glitter that is
discrete sparkle instead of a smeared streak, a sea that sits darker than the
horizon sky at grazing angles (the rough-interface Fresnel), drifting wind
lanes across the mid-range sea, and — where the wind and the light allow —
whitecap flecks. Not re-promoted: `grove-forest-2m` (0.987, a ground-level
forest frame with no sea; run-to-run foliage variance) and everything at
≥ 0.995 (`winter-noon`, `cruise-sun-30`, `approach-500ft`,
`reference-viewport` and the rest), whose sea, if any, is too far or too
small in frame for the change to register.

The evidence that the change does what it claims is the +2 s simulation-time
A/B on `coast-10km-lowsun` and `water-25ft` recorded in the decision log:
before, the open sea's two-second luminance change was 3/255 at 5 km, 1/255 at
8 km and zero past 12 km; after, the glitter path changes 12-16/255 at every
range and the sunless mid-range sea carries drifting roughness lanes. The far
plate past ~12 km on a calm world is unchanged, which is the physics.

**Delivery floors were NOT re-pinned.** The candidate ran on this unpinned
M2 Pro; its 32 gate failures were all delivery floors (fps, wall-clock fps,
frame-interval p95, p999) plus the vegetation draw-call ceiling on
`canopy-backlit-lowsun` (249 against 246) that predates this change, and none
was a visual, temporal, renderer-error, settling or lit-region gate. The two
near-water shots that carry floors (`water-3m`, `water-25ft`) cleared them in
this run, so the added far-field fragment work — one hash and a `pow` per
pixel for the sparkle, two value-noise octaves for the lanes, and a bounded
cell search for the flecks that returns early wherever its result is unused —
is inside the budget those floors express. A clean reference-adapter run is
still owed before any floor moves.

### Re-promotion 2026-09-14 — the far field, second pass

The same eight sea baselines were re-promoted from candidate
`2026-09-14T21-39-26.316Z` after a frame-by-frame review, for one sanctioned
change: the second pass of wave S (ARCHITECTURE.md decision log, "The far
field, second pass"). Driving the terrain viewer at the user's reported pose
found four defects the first pass had shipped — scrolling horizontal lines
over parked terrain, a drifting grid of dark blobs in the glitter path, valley
lakes rendered as white sheets, and 37 fps with the sea in the lower half of
the frame — and this pass fixes them: the whitecap flecks are a one-hash
twinkle instead of a per-pixel cell search, the far gust's lattice is warped
and its coarse octave is a vertex varying, the cloud shadow marches the cloud
slab with a stable per-texel jitter, and inland water composes the far field
and occludes its reflected sky against the terrain's global horizon field.
Re-promoted, with the SSIM against the frame promoted this morning:
`forest-line-highsun` (0.980), `cruise-horizon` (0.984), `water-25ft` (0.988,
worst tile 0.57 — the sparkle in the glitter path is a different random draw
at the shot's simulation time), `slant-10km` (0.990), `water-3m` (0.993),
`coast-10km-lowsun` (0.995), `hills-dusk-glint` (0.995),
`forest-500ft-sunbehind` (0.997). Only the first three would have failed a
visual gate against the morning's frames; the other five are re-shot so every
committed sea frame shows the shipped sea. The cloud-shadow change touches
every daylight frame with terrain, and every other shot stayed at ≥ 0.987
SSIM with its worst tile ≥ 0.74 — the shadow map's east-west stripes are gone
and its shadows are otherwise in the same places — so nothing else moved.

Evidence, measured live in the viewer at 8296, 16955, 662 m MSL at golden
hour: facing the sun over the sea 37 → 120 fps; 20 m over the sea facing the
sun 120 fps; parked terrain's maximum row change per half second 26 → 0.04
of 255; the hill lakes grey-blue under the dusk sky instead of white.

**Delivery floors were NOT re-pinned.** The candidate ran on this unpinned
M2 Pro under a load average of 12 from concurrent sessions; its 34 gate
failures were 23 delivery floors (fps, wall-clock fps, frame-interval p95,
p999, and the strict tier-1 frame-delivery gate on `water-3m`, which read
70.7 fps in that run) and 11 draw-call ceilings. Re-measured alone on the
idle host afterwards, `water-3m` and `water-25ft` ran at 121.6 and 121.9 fps
with a 10.2 ms frame-interval p95 and zero hitches, inside every floor they
carry, so the far-field rewrite costs nothing the near-water shots can
measure. The draw-call ceilings were not a water finding: nine shots, water
and no-water alike, sat exactly one draw above their ceiling in that run
because a chunk resident one cull fade past the impostor radius carried an
impostor batch the shader killed to the last vertex and the engine still
submitted; `397c7b6` (tree-LOD continuity) hides such a batch from its
per-cell bounds, returning `forest-line-highsun`, `canopy-1200ft`,
`grove-forest-2m`, `forest-500ft-sunbehind`, `hills-dusk-glint` and
`page-thrash-turn` to their ceilings, and declares the remaining real +1 on
the moving `slant-10km` and `cdlod-transition` shots as the
"tree-lod-residency-lead" raise in `scripts/deliveryFloors.mts`. No visual,
temporal, renderer-error, settling or lit-region gate failed. A clean
reference-adapter run is still owed before any floor moves.

### Where this contract is enforced

The table above is a **reference-adapter** contract, and only the reference
adapter is held to it. A GitHub-hosted macOS runner renders the same frames —
every SSIM gate passes there against the committed baselines — but delivers
them at about a quarter of the rate: 12.9–50.0 wall-clock fps, mean 27.8, on
the 31 shots with floors (run 37346470016, 2026-10-05). Its detail Worker does
run; an earlier note here said it never came up, but the same run's motion
shots publish 8, 13 and 22 Worker builds with no inline fallback. Gating that
host against these rows would measure the runner rather than the change, which
is what the cloud A/B below measures instead.

So the renderer workflow sets `VITE_PERF_UNPINNED_HOST=1`, which reports the
delivery rows instead of asserting them and names every row it declined to
gate. Everything independent of host speed still gates there, and that is most
of the instrument's value: uncaptured GPU errors, Babylon/console errors,
blank-or-structureless frames, the render-scale pin, the settling fences, the
resident-slot capacity bound, the temporal-stability floors and every SSIM
comparison. A local `npm run perf:capture` never sets the flag and stays fully
strict, and a rebaseline candidate is refused outright on an unpinned host.

## Cloud A/B

The delivery floors can only be measured on the reference adapter, but a
regression check does not need them. It needs to know whether a change makes
the same frames cost more, and that is a relative question any machine can
answer by running the change and its base side by side. `npm run perf:ab`
does that on any host that runs Chromium: a cloud session, a hosted Linux or
macOS runner, or a laptop.

```
npm run perf:ab                                   # working tree vs its merge-base with origin/main
npm run perf:ab -- --base main --shots cruise-horizon,approach-500ft
npm run perf:ab -- --base origin/main --head <branch>   # a pushed branch, from any checkout
npm run perf:ab -- --aa                           # both arms the head: this host's noise floor
npm run perf:ab -- --rounds 0 --shots all         # counts, draw calls and pixels only
npm run perf:ab -- --climate-province boreal --shots approach-500ft   # inside a forced biome
npm run perf:ab -- --help
```

It writes `report.md`, `report.json` and both arms' screenshots under
`tests/perf/artifacts/ab/`, and prints the report. The default shots are one
per major system: `cruise-horizon` (terrain, sky and clouds to the horizon),
`forest-500ft-sunbehind` (canopy and impostors), `ground-2m-lowsun` (ground
cover), `approach-500ft` (aircraft and airport) and `water-25ft` (ocean).

Every canonical shot sits in the temperate core around the airport, where the
climate provinces are exactly 0, so none of them can see a biome. To time or
photograph one, `--climate-province <preset>` forces every shot's world into
that province in both arms (a shot's own `climateProvince` field does the same
for one appended scratch shot; no canonical shot carries one). Both arms need
climate provinces: an arm whose `createWorld` ignores the option fails the shot
rather than render the temperate world. The run is off the capture's settings,
so the ceilings are shown, not gated, and no baseline is compared. The cold
biomes' before/after pairs were taken this way (base: the province branch
without them; four poses at medium, GPU time the same or faster on all four).

**How it measures.** Each arm is a production build of
`tests/perf/ab/agent.html`, made from that arm's source with the running
checkout's harness copied in, so the two differ only in the code under test.
Each arm runs in a headless Chromium of its own (below). Per shot, in
canonical order, both arms:

1. place the shot exactly as the capture does: seed, renderer options, cockpit
   rig, render scale, clock, placement (`tests/perf/shotPlacement.ts`, shared
   with the capture), pose and camera;
2. stream to rest under the capture's stability rule, with the frame's own
   draws dropped (`tests/perf/gpuDrawGate.ts`). Bakes, such as the sky probe,
   the cloud ambient LUT and mip chains, still draw, so the world that results
   is the world the capture streams;
3. render the difference if one arm streamed fewer frames, because every
   cadence in the renderer keys on the frame index;
4. apply the capture's time, ocean and wildlife pins, and settle 12 frames,
   counting the GPU work of the last 8 exactly (`tests/perf/gpuWorkCounters.ts`);
5. take turns, ABBA then BAAB, rendering frames fenced to GPU idle. Every pass
   is timed by timestamp queries the harness injects
   (`tests/perf/gpuPassTiming.ts`) and named for the frame-graph pass and the
   render target or compute shader that issued it, and `renderer.render()` is
   timed on the main thread;
6. photograph the same final frame.

**A browser per arm.** With both arms as pages of one browser, their WebGPU
devices share a GPU process, and there the A/A's two arms did not render the
same frame: in four runs out of four, one arm's terrain horizon bake waited on
a compute pipeline that became ready only after Babylon's `dispatchWhenReady`
had stopped polling. It gives up after 3,000 tries, about 30 s, and settles
neither way, so `GlobalHeightPyramid.bakeHorizon` stayed in flight for the rest
of the session, that arm never published the horizon field, and its water lost
its terrain occlusion: 279,159 pixels of `cruise-horizon`, every one of them
water, up to 22 levels in 255 brighter. With a browser each, the two arms'
frames are identical. The latch itself is a renderer hazard on any host whose
first compile of that pipeline is that slow, and `recenter`,
`PageOcclusionBake`, `TerrainPageAtlas` and `TerrainPageErosionGpu` await the
same call; the ocean, bathymetry and macro-erosion paths already use bounded
replacements.

**What fails the run** (exit 1):

- a GPU-time or CPU-time verdict of SLOWER on any shot;
- a draw-call or inventoried-memory ceiling that the head breaches and the
  base did not. The ceilings, like the baselines, are pinned for the
  capture's own settings (the trainer, medium quality, balanced mode, each
  shot's render scale), so a run with `--aircraft`, `--quality`, `--mode`,
  `--render-scale` or `--climate-province` shows them without gating on them;
- a renderer error in the head, or a shot that does not settle.

Each round gives one paired observation per metric, the log ratio of the arms'
totals. Consecutive frames of one arm are not independent, so the round is the
unit. A verdict is SLOWER only when Wilcoxon's exact signed-rank test,
Holm-adjusted across every gated shot and metric, is below 0.05 (below 0.05 /
n in each part of a run split n ways with `--part`, so that the parts together
keep 0.05) AND the Hodges–Lehmann estimate of head/base is at least 1 +
threshold. SAME needs the whole distribution-free interval inside ±threshold.
Anything else is INCONCLUSIVE: the run exits 0 with a warning that says to run
more rounds, because an inconclusive result is not a pass, and says about how
many rounds would clear it if nothing changed: an interval narrows with the
square root of the rounds. The thresholds are 5% in GPU time (in the frame's
wall time where passes cannot be timed) and 15% in CPU time; `--threshold` and
`--cpu-threshold` change them. `scripts/perfAbStats.mts` holds the method and
`tests/perf-ab-stats.test.ts` pins it, including its power and false-alarm
rate on simulated runs.

CPU time is a guard (`--cpu-gate`): a slowdown it resolves fails the run, but
an interval too wide to clear a change is listed as not cleared instead of
holding the run inconclusive. On SwiftShader it is too noisy to do more: in
three A/A runs, 32 rounds in all, one round's ratio scattered by 11–26% in
CPU time against 4% in GPU time, and 2,000 sixteen-round A/A runs resampled
from those rounds read SAME in 99.7% of cases for GPU time at 5%, but in only
57% for CPU time at 15%. On the macOS runner the two browsers' CPU times can
sit apart with both running one renderer (below). So a CPU-side change is
caught when it is large, and a small one is not ruled out.

**Two browsers of one build differ a little.** With both arms one build, one
browser can still sit a fixed fraction faster than the other for a whole run,
and by another fraction in the next. On GitHub's Linux runner, where one
round's GPU-time ratio scatters by only 0.1–0.3% on SwiftShader, the head's
GPU time sat from −0.2% to +0.8% off the base's over nine A/A shots in two
runs, and its CPU time 2–7% slower on every shot of one run and 0–7% faster on
every shot of the other. On the macOS runner they spread by about 0.8% in wall
time, less than its rounds' own scatter, and by about 3% in CPU time (standard
deviations over 20 A/A shots). More rounds measure an offset more precisely
but do not shrink it, so the thresholds sit well clear of them: 5% is six
times the largest offset in SwiftShader GPU time, while a threshold of 1%
would be calling the browsers rather than the change.

**What it reports besides the verdict**, each of which is exact rather than
statistical: per-frame work counts (draws, vertices, instances, dispatches,
workgroups, attachment pixels, pipeline switches, uploads, creations) per pass
for both arms; the renderer's diagnostics; the passes whose GPU time moved
most; a pixel diff of head against base on the same frame and rasteriser; and
each arm's SSIM against the committed baseline. A pass is named for its
render target, which is not always its shader: Babylon renders the scene into
the first post-process's input, so on `cruise-horizon` the main scene is the
pass `render:hdr-present › PostProcessRTT-bloom-bright`.

**What it does not time.** A frame here is `renderer.render()` and the GPU
work it submits. The flight model, the detail Worker and anything else off
the render path are outside it, so a change that only moves simulation cost
reads as SAME.

**What each host can see.**

- **SwiftShader**, Chrome's CPU implementation of Vulkan, is what every Linux
  host without a GPU runs, including hosted runners and cloud sessions. It is
  the default off macOS. It ranks shading, fill, overdraw, vertex and dispatch
  work the way a GPU does, so more pixels, heavier shaders, extra passes and
  extra draws all show. It over-weights texture filtering, MSAA and
  transcendentals, and it cannot see memory bandwidth or tile memory: the
  reference adapter is a tile-based Apple GPU, where MSAA and some
  render-target traffic are nearly free. A SwiftShader verdict on a change of
  that kind is a lead to confirm on the macOS runner, not a ruling.
- **The hosted macOS runner's GPU** (`--gpu hardware`, the default on macOS)
  is Metal on Apple silicon, the same family as the reference adapter: a
  virtual M1 with 3 CPUs, at about a quarter of its frame rate. It offers no
  timestamp queries, so no pass is timed there. The fenced frame's wall time,
  from `render()` to GPU idle, is gated instead of GPU time, and it is far
  noisier (below).

**Measured** (2026-10-12, a cloud session: 4 CPUs, Chromium 141, SwiftShader,
16 rounds, on `cruise-horizon` unless another shot is named):

- **A/A** (`--aa`, both arms one build): GPU time SAME, −0.8% (−2.7% to
  +1.3%); CPU time SAME, +0.0% (−12.6% to +14.3%); draw calls 200 → 200;
  every work count and every pixel identical. A frame cost 5.8 s of
  SwiftShader GPU time, and the shot 14 minutes
  (`docs/evidence/perf-ab-aa-cruise-horizon-2026-10-12.json`).
- **A known regression**, the head's clouds at twice tier 1's resolution
  (`--aa --head-profile-override {"cloudResolutionScale":0.9}`): GPU time
  SLOWER, +8.1% (+5.5% to +11.3%). The cloud raymarch went from 153 to 601 ms
  per frame and its workgroups from exactly 2,170 to 8,680, and the two
  frames stayed identical, because the shot's sky has no cloud in view
  (`docs/evidence/perf-ab-positive-control-cruise-horizon-2026-10-12.json`).
- **A/A on two more default shots**, `forest-500ft-sunbehind` and
  `water-25ft`: GPU time SAME on both, +2.0% (−0.7% to +3.6%) and −0.9%
  (−3.8% to +1.8%); draw calls, work counts and pixels identical. CPU time
  did not clear `water-25ft`, +7.2% (+0.6% to +19.7%), which is the case
  the guard is for: the run reads "no regression found" rather than
  inconclusive. The shots took 21 and 20 minutes
  (`docs/evidence/perf-ab-aa-forest-water-2026-10-12.json`).
- **The A/A with both arms in one browser**, as the first version ran it
  (8 rounds): the same timings, but 279,159 pixels differ
  (`docs/evidence/perf-ab-shared-browser-aa-cruise-horizon-2026-10-12.json`;
  "A browser per arm" above).
- **A real change**, pull request #20 (a final RCAS sharpen and a
  multi-scale ground grain) against main, on `cruise-horizon` and
  `ground-2m-lowsun`: REGRESSION. Draw calls 200 → 201 and 121 → 122, each
  one render pass more, breaching both ceilings; GPU time SLOWER, +13.7%
  (+10.4% to +15.7%) and +9.0% (+7.1% to +10.9%), nearly all of it in the main
  scene pass, where the grain's terrain material work lands, while the
  sharpen's own pass stays under half a per cent of the frame. Texture work
  is what SwiftShader over-weights, so that cost is a lead for the macOS
  runner rather than a ruling
  (`docs/evidence/perf-ab-pr20-sharpen-grain-2026-10-12.json`).

**Measured on the Linux runner** (2026-10-12, `ubuntu-latest`: 4 CPUs,
SwiftShader, 16 rounds, the five default shots). Like the macOS runner's
below, both runs are A/As in effect: the base is `main`, and the head is the
A/B's own branch, which changes no renderer code. Their figures are read from
the job logs, which print every round
(`docs/evidence/perf-ab-swiftshader-runner-2026-10-12.json`).

- **The pull request's first complete run**: no regression. GPU time read SAME
  on all five shots, from −0.2% to +0.8%; draw calls, work counts and pixels
  were identical; CPU time read from −6.9% to −0.3%, inside the guard. One
  round's GPU-time ratio scattered by 0.15–0.33%, a tenth or less of what it
  does in a cloud session, so every interval was a few tenths of a point wide
  and excluded zero: what they resolve there is the offset between the run's
  two browsers (above). An earlier run, cancelled by a push after four shots,
  read those four shots' GPU time 0.0% to +0.7% off and their CPU time 2–7%
  slower.
- **Two and a half hours in one job.** A frame cost 9.4–20 s of GPU time on
  that runner, and 6.6–16 s on the cancelled run's, so a shot took 20–36
  minutes: streaming, the settle and 16 rounds of four frames. The five took
  8,993 s, which is why the workflow now runs them as five parts in parallel
  (below).

**Measured on the macOS runner** (2026-10-12 and 13, `macos-latest`: Apple M1
(Virtual), 3 CPUs, Chromium 151, Metal, on the five default shots unless fewer
are named). Every run below is an A/A in effect: the base is `main`, and the
head is the A/B's own branch, which adds the harness both arms share and
changes no renderer code. The runner's artifacts cannot be fetched from a
cloud session, so the figures are read from the job logs
(`docs/evidence/perf-ab-macos-runner-2026-10-12.json`).

- **Twenty rounds of four frames a turn**, the first default, on the pull
  request twice: every verdict INCONCLUSIVE. One round's wall-time ratio
  scattered by 13–23% (18% pooled) and its CPU-time ratio by 23–44%, at
  1.4–1.7 s a round, so the wall-time intervals were 11–23 points wide,
  around estimates from −8.1% to +2.0%. Between the two runs the host's own
  speed moved far more than that: a shot's median frame differed by up to
  1.7 times, in either direction (`cruise-horizon` 74 then 43 ms,
  `forest-500ft-sunbehind` 95 then 113 ms), and the paired ratio absorbs
  it.
- **One frame a turn, 120 rounds**, on `cruise-horizon`, `ground-2m-lowsun`
  and `water-25ft`: a round scattered by 20–26%, barely more, in a sixth of
  the time (0.28 s a round), because neighbouring frames move together.
  Per second of runner time that is about three times the precision. Wall
  time still read INCONCLUSIVE on all three, +2.1% to +5.3% with intervals
  of ±4–5%; CPU time read SAME on two.
- **One frame a turn, 320 rounds**, the second default, three times:
  dispatched on the branch, then twice on the pull request. Frame wall time
  read SAME on 12 of the 15 shots, from −1.8% to +2.1% with intervals of
  ±1.4–3.0%. The other three read INCONCLUSIVE: `cruise-horizon` in the second
  run, +1.5% (−2.0% to +5.2%), and in the third `cruise-horizon`, +3.0% (+0.4%
  to +5.8%), and `forest-500ft-sunbehind`, −2.9% (−5.4% to −0.5%): estimates
  1.5–3% off, which the rounds' scatter and an offset between the run's
  browsers (above) can produce together, with intervals too wide around them
  to stay inside 5%. Each run took 13–14 minutes. CPU time read the head 8.7%
  faster on `approach-500ft` in the first run (−12.5% to −4.7%), 1.2% slower
  in the second and 7.2% faster in the third, with both arms one renderer:
  offsets again, which is why CPU time is a guard at 15% here as on
  SwiftShader. Every CPU interval of the three runs sits inside it.
- **One frame a turn, 640 rounds**, the default since, dispatched on the
  branch: frame wall time SAME on all five shots, from −0.8% to +0.6% with
  intervals of ±0.8–1.6%, and CPU time SAME on all five, in 21 minutes. Twice
  the rounds narrow an interval by √2, which around the same estimates would
  have read the three INCONCLUSIVE shots above SAME, and the job still ends
  well before the SwiftShader parts (below).
- **Resident terrain pages differ; wanted pages do not.** In five of the six
  five-shot runs the head arm came to rest holding one or two more terrain
  pages than the base, on 24 of their 25 shots
  (`residentTerrainPages: 36 → 37` and so on), and in the other the base held
  two to five more on all five; in the three-shot run they never differed, nor
  in any SwiftShader run so far. A page stays in the atlas until its slot is
  needed, so the count includes pages an arm's stream wanted earlier and no
  longer does, and two browsers sharing three CPUs need not stream alike:
  `approach-500ft` streamed 420 frames in the base and 540 in the head in one
  run, 480 and 390 in another. The report gives the pages each arm wants
  (`wantedTerrainPages`) beside a resident-page difference, and in all three
  runs that had it the two arms wanted the same pages on every shot (22 to
  32). Draw calls and GPU work counts were identical throughout, and at most
  0.04% of a frame's pixels differed (SSIM 1.0000).

**Where it runs.** `.github/workflows/perf-ab.yml` runs both hosts on every
pull request that touches the renderer: `swiftshader` gates, and `hardware` is
advisory. `swiftshader` runs as five jobs in parallel, each given
`--part i/5`: every fifth shot in canonical order from the i-th, tested at
0.05 / 5 so that the five together keep the run's 0.05 (Bonferroni across the
parts, Holm within each). With the default shots each job takes one, so the
gate waits on the slowest shot, which took 36 minutes in the single job,
rather than on all five. A part opens its two browsers afresh, so its shots
stream after only the earlier shots of that part, in both arms alike.
`hardware` runs its five shots in one job, in about 21 minutes. Its rounds are
set from the A/A runs above, but it times whole frames on a virtual GPU whose
speed differs from one runner to the next, so it is a second opinion on
SwiftShader's verdicts, from the GPU family that matters, rather than a gate.
Either can be started by hand (`workflow_dispatch`) with a base, a shot list,
a round count and further options; a shot list is split between the five parts
the same way. In `args`, a JSON value is written without quotes or spaces, for
example `--head-profile-override {"cloudResolutionScale":0.9}`. The report is
at the end of the A/B step's log and in the job summary.

**Draw-call ceilings.** A draw call is counted, not timed, so the A/B's counts
are exact on any host once both arms have streamed to rest, and its base →
head column is the change's own draw-call delta: the Mac-free counterpart of
`scripts/decompose-draw-calls.sh` for a `MEASURED_DRAW_DELTAS` entry, with
`--rounds 0` to skip the timing. Pull request #20 above reads `200 → 201`
and `121 → 122`, the +1 its full macOS capture had measured on every shot,
and its work counts name the pass that draws it.

**What still needs the reference Mac.**

- **Moving a delivery floor.** The A/B says whether a change is slower, not
  how fast the reference adapter runs it.
- **Promoting baseline images.** A candidate is refused on an unpinned host,
  and the A/B's photographs are not candidates: they are taken at another
  instant than the capture's (after a 12-frame settle and the measured
  rounds, not 150 settle frames), and on SwiftShader on another rasteriser
  too. The instant is most of the difference. Against the committed
  baselines they score SSIM 0.986 on `cruise-horizon` but 0.83 on
  `ground-2m-lowsun`, whose grass and foliage sway with time, and on the
  macOS runner's Metal they score about the same as on SwiftShader:
  `water-25ft` reads 0.706 on both. What the A/B does show is exactly which
  pixels a change moved, which is what a reviewer needs before any
  promotion.

## Flight stutter: `npm run perf:flight` (2026-10-24)

The A/B times a settled shot, which is the steady cost. A player's frames
also carry the work of flying into terrain nobody has seen yet: cells and
pages streaming in, worker results landing on the main thread, a pipeline
compiled the first time a material meets a new state, and the garbage all of
it leaves. None of that shows in a settled shot, and all of it shows as a
hitch. `npm run perf:flight` measures it, with the same agent page and arms
as the A/B:

```
npm run perf:flight -- --base origin/main            # working tree vs main, 6 legs x 240 frames
npm run perf:flight -- --base 264b760 --head main --legs 8
npm run perf:flight -- --profile --heap-profile --no-minify   # V8 CPU and heap profiles per leg
node scripts/cpuprofile-spikes.mts <arm>-leg2.cpuprofile        # what the long frames ran
node scripts/heapprofile-summary.mts <arm>-leg2.heapprofile 30 --frames 240
npm run perf:flight -- --base origin/main --settle-trials 12 --fail-on-worker-fallback   # fresh-region settles; exit 1 on a head trip
npm run perf:flight -- --base origin/main --legs 4 --leg-frames 600 --hang-detail-worker 2:300   # does a silent worker recover?
```

Both arms start from the same settled shot (`approach-500ft` by default) and
fly the same scripted path, terrain following at 120 m/s, in legs that
alternate ABBA. Every frame records `render()`'s main-thread time and each
frame-graph pass's share of it, the time the main thread spends on whatever
is queued behind the frame (worker results, buffer maps), the JS heap grown
(`--enable-precise-memory-info`), pipelines and shader modules created, and
each new Babylon effect with the defines that set it apart from the nearest
one compiled before it, at load included (an effect the engine hands back
from its cache is not listed). Tasks over 50 ms come from the Long Tasks API, and
each leg reports whether vegetation is still generated on its worker (since
2026-10-25, the detail-worker verdict below). The
frame's own draws are dropped by default (`gpuDrawGate.ts`; `--draws` keeps
them), so on SwiftShader a frame costs its CPU work and its compute. CPU
milliseconds are this host's and only compare the arms; counts are exact.

**Options** (`npm run perf:flight -- --help` prints them; the rows marked
2026-10-25 were added for the choppiness investigation below):

| Option | What it does |
| --- | --- |
| `--base <ref>`, `--head <ref>` | the arms (default: the merge-base of HEAD and origin/main, and the working tree) |
| `--shot <name>` | the canonical shot to start from (default `approach-500ft`) |
| `--start <x,z[,yaw]>` | begin the flight here (world metres, yaw in degrees) instead of at the shot's pose |
| `--legs <n>`, `--leg-frames <n>` | legs per arm (default 6) and frames per leg (default 240, 4 s of flight) |
| `--speed <m/s>`, `--clearance <m>`, `--bank <deg>` | ground speed (default 120), height kept above the terrain (150), constant bank (0 flies straight) |
| `--burst-legs` (2026-10-25) | alternate the legs between 250 and 60 m/s instead (ABBA keeps each leg's speed equal in both arms) |
| `--park-legs` (2026-10-25) | hold still (0 m/s) on odd legs and fly on even ones: a stop on the runway, then the roll |
| `--camera chase\|cockpit` | default chase |
| `--weather clear\|breezy\|cloudy` (2026-10-25) | default clear, as the capture; the game's default is breezy |
| `--quality`, `--mode`, `--aircraft` | renderer settings (default medium, balanced, trainer) |
| `--draws`, `--fence-every <n>` | keep the frame's own draws (slow on a software adapter); fence to GPU idle every n frames (default 4) |
| `--base-world <json>`, `--head-world <json>` | options merged into that arm's `createWorld` (a landform or province under test) |
| `--kill-detail-worker <leg>:<frame>` (2026-10-25) | fail the vegetation worker in both arms before that frame of that leg (legs from 1, frames from 0) with an error event, as a crashed worker script |
| `--hang-detail-worker <leg>:<frame>` (2026-10-25) | the same, but terminate the worker with no event: a silent worker (a separate run from `--kill-detail-worker`) |
| `--settle-trials <k>`, `--trial-frames <n>` (2026-10-25) | after the legs, k independent fresh-region settles of n frames (default 600): in each, both arms at once build a new renderer and hold still over the next land start (a spiral out from the home airport that skips the sea), as in the stream to rest |
| `--emulate-hitch <ms>@<leg>:<frame>` (2026-10-25) | that frame stands for a main thread blocked `<ms>` while the simulation flew on: path and simulation time advance by `<ms>`, render()'s delta is FlightGame's clamp of it (0.1 s at most); every other frame stays 1/60 s |
| `--frame-dump <from>-<to>` (2026-10-25) | read those frames of the hitch's leg back as each renders (no extra render) and write them as PNGs under `<out>/frames`; needs `--emulate-hitch` and `--draws` |
| `--gpu swiftshader\|hardware`, `--chromium <path>` | the adapter (default hardware on macOS, SwiftShader elsewhere) and the browser |
| `--profile`, `--heap-profile`, `--no-minify` | a V8 CPU profile, and a V8 sampling heap profile, per arm per leg; unminified builds so profiles name functions (each moves the timings) |
| `--fail-on-worker-fallback` (2026-10-25) | exit 1 when the arm built from the commit under test TRIPPED (below) |
| `--under-test <ref>` (2026-10-25) | the commit `--fail-on-worker-fallback` asks about (default the head; name it when the arms are swapped) |
| `--out <dir>` | default `tests/perf/artifacts/flight/<timestamp>` |

**The detail-worker verdict** (2026-10-25, `scripts/perfFlightVerdict.mts`).
The agent samples the vegetation runtime's watchdog clocks after every frame
(`tests/perf/ab/detailWatchdog.ts`), and `report.md` ends with a table per
arm and phase (the concurrent stream to rest, each leg, each settle trial)
and a line per commit:

- **TRIPPED**: by the end of the phase the runtime had timed its worker out,
  restarted it or fallen back to generating cells on the main thread, or had
  no worker. The counters are the renderer's, so a trip stays on every later
  phase of that arm; a settle trial, on a renderer of its own, stands alone.
- **would-trip**: spans the runtime charged its worker 2,000 ms or more,
  which trip its 240-update deadline at 120 Hz although the harness runs far
  slower. On `19543c0` a span is a whole demand episode; on a runtime with
  heartbeats it is a silence. The count is an estimate, not a bound: on
  `19543c0` it also counts a clock left set while the presentation sweep
  was idle, which trips only if demand comes back first (see "Medium/balanced
  choppiness" below).
- A worker failed on purpose (`--kill-detail-worker`, `--hang-detail-worker`)
  is not a trip: its leg and those after it say whether the runtime
  RECOVERED (restarted it; RECOVERING while the restart is due at its next
  update) or FELL BACK, and only trips beyond that failure count.
- With them: the longest charged span on each clock (presentation /
  generation), accepted worker builds' latency in wall ms, render() p50 and
  p95, heap allocated per frame, long tasks, frames per second, and head/base
  ratios for the first leg, the legs after it and the settle trials.

**What it found.** Main (6d91220) against the commit before PR #19
(264b760), 6 x 240 frames: no new CPU cost from the three October PRs
(render() p50 12.0 vs 11.6 ms, 25 vs 30 long tasks), but both arms carried
the same older stutter: about 2% of frames were main-thread stalls of 100 to
500 ms, and the frame allocated 3.2 MB of garbage. Profiles put every stall
in `world-page-visibility`, in `generateDetailCell`: vegetation cells were
being generated on the MAIN thread. The detail worker's generation watchdog
had fallen back to inline generation, permanently, because it charged the
worker for time in which nothing was asked of it: the agent's 22 s between
the settle and the flight, with no update in between, read as 22 s without
an answer on the first update back. In the browser the same thing happens
whenever requestAnimationFrame stops for 8 s with cells still missing (a
hidden tab, a window covered by another app on macOS) and, on a 120 Hz
display, whenever the worker takes 2 s (240 updates) to answer its first
request. Either way the rest of the session generates 512 m cells inline, a
stall every few frames. The watchdog now times only an outstanding request,
counts any answer, applies the update count after the first answer, and
lifts update gaps (`DETAIL_WORKER_WATCHDOG_UPDATE_GAP_ALLOWANCE_MILLISECONDS`);
a worker that stops answering while frames run still falls back
(tests/render.webgpu-detail-worker-runtime.test.ts).

*Superseded in part on 2026-10-25.* This fix covered the generation
watchdog (its gap allowance also lifted update gaps off the presentation
clock). The presentation watchdog kept its 240 updates OR 8 s from the
first update with demand, and it was still tripping a working worker; see
"Medium/balanced choppiness: the vegetation worker's watchdog (2026-10-25)"
below. A worker that stops answering is now replaced, up to twice, before
generation falls back.

The same flight, 4 x 240 frames, after the first leg (SwiftShader host,
trainer, medium/balanced):

| | main (worker fell back) | watchdog fix (worker kept) |
| --- | --- | --- |
| render() ms p50 / p95 / p99 / max | 12.5 / 39.6 / 138.0 / 253.8 | 10.4 / 20.1 / 29.2 / 92.3 |
| frame CPU ms mean | 17.7 | 11.9 |
| frames over 4x the median | 29 | 3 |
| long tasks: count / total ms / worst | 29 / 3148 / 259 | 3 / 208 / 92 |
| JS heap allocated per frame | 3.3 MB | 1.7 MB |

**Still open** (smaller, and each its own change):

- One effect compiles mid-flight: the wildlife keratin PBR (clearcoat; the
  first antler, tusk or beak in view), a one-time compile of ~120 KiB of
  WGSL. Compiling it at load needs the meshes in the state they will draw in
  (thin instances, shadow defines). The vegetation PBR variant without
  `DETAIL_BAND_FADES` listed here before is compiled at load: until
  `f86a866` the probe's recorder, installed after the renderer loaded, took
  the engine's cached copy for a compile. *Closed 2026-10-25* by `6a80b12`
  (each wildlife batch primes its pipelines at startup): in the Metal flights
  below every main arm compiled this 123.9 KiB effect mid-flight and no arm
  of the fix did.
- 1.7 MB of garbage per frame: the terrain clipmap's node selection and
  buffer writes (~1 MB: per-node objects and string page keys) and the
  wildlife step (~0.5 MB: per-step arrays and vector clones). Young
  collections absorb it; it is not a stall source on its own. Still open.
- The sky probe's spherical-harmonics bake runs on the main thread whenever
  the camera's altitude changes by 500 m: 1,536 `evaluateSkyRadiance` calls,
  1.3 ms on this host before PR #22 and 3.6 ms (high sun) to ~9 ms (low sun)
  since. One frame per 500 m of climb; it could be spread over six frames
  (one cube face each) with identical results. *Sliced 2026-10-25*
  (`e149d4d`, `8adc324`, `49e666e`, `4dc648a`; below): bit-identical, not
  yet measured in a browser flight (perf:flight neither climbs 500 m on
  purpose nor records a re-light).

**The October PRs' steady cost, together.** Each of PRs #19, #20 and #22
passed the 5% gate alone; together, against 264b760 (CI run 40117858194):

| Shot | SwiftShader GPU | macOS runner wall (advisory) |
| --- | --- | --- |
| approach-500ft | +5.0% (+4.4..+5.5) | +1.9% (+0.6..+3.2) |
| cruise-horizon | +4.1% (+4.0..+4.3) | +3.2% (+1.9..+4.5) |
| forest-500ft-sunbehind | +3.7% (+3.6..+3.8) | +2.9% (+2.0..+3.8) |
| ground-2m-lowsun | +4.7% (+3.9..+5.5) | +2.5% (+1.9..+3.1) |
| water-25ft | +6.4% (+5.9..+6.7) | +4.8% (+4.1..+5.6) |

SwiftShader runs both sides of every branch, so it charges the per-point sun
on every shot; a real GPU skips it above a 33° sun. The rule for new work is
to budget each feature at about 2% on medium, not the gate's 5%.

## The final sharpen, fused into FXAA (2026-10-24)

PR #20's RCAS sharpen ran at tier 1 as a pass of its own after FXAA: a
second full-screen draw, five taps per pixel, and an LDR target the size of
the raster that FXAA wrote and the sharpen read back. FXAA already fetches
the centre and its four-neighbour cross, which is RCAS's whole footprint, so
the sharpen now rides inside the FXAA pass (`FxaaSharpenPass`, a port of
Babylon's FXAA 3.11 run with Babylon's own FXAA vertex shader). The
multisampled tiers, which run no FXAA, keep the standalone `SharpenPass`.

**Same look.** At a zero amount the port is Babylon's FXAA pixel for pixel
(`tests/gpu/final-sharpen.test.ts`). With the sharpen on, the fused pass
solves RCAS's lobe against the cross before FXAA, which has more contrast
than the smoothed cross the separate pass saw, so on the pixels FXAA moved
the lobe comes out smaller; `FXAA_MOVED_SHARPEN_GAIN` (1.2) makes it up.
Calibrated on real tier-1 frames captured before FXAA at tier 1's own 0.86
render scale, each run through both chains, and measured as displayed (the
1100x619 raster upscaled to the 1280x720 viewport, as the capture and the
browser do):

| Shot | FXAA moved | Fine contrast*, FXAA then RCAS | fused, no gain | gain 1.15 | gain 1.2 | mean distance from the two-pass frame at 1.2 |
| --- | --- | --- | --- | --- | --- | --- |
| ground-2m-lowsun | 20.4% of pixels | 9.19 | 8.86 (-3.6%) | 9.11 (-0.9%) | 9.21 (+0.2%) | 0.55/255 |
| approach-500ft | 18.2% of pixels | 10.41 | 9.82 (-5.7%) | 10.16 (-2.5%) | 10.28 (-1.2%) | 0.70/255 |

\* Mean absolute 4-neighbour Laplacian of luma, on the displayed image;
FXAA alone reads 6.24 and 7.45. On the raster itself, which the upscale
softens, 1.2 runs a little over (+2.6% and +1.4%; 1.15 read +1.3% and
-0.3% there, which is where it was first calibrated, at render scale 1).
The harness reproduces the real pipeline: the end-to-end A/B frames of the
two-pass and the 1.15 build read 10.41 -> 10.16 and 9.19 -> 9.10 on these
shots, as above.

Calibration recipe (reusable for any post-process change): a local branch
that makes the pass a no-op at a profile value, and a capture that copies
the raw raster (`tests/perf/ab/agent.ts`, `capture()`, destination size =
raster size), give the pass's real input via `npm run perf:ab -- --base X
--head X --rounds 0 --head-profile-override ...`; a throwaway `tests/gpu`
harness then feeds that PNG through candidate chains on SwiftShader.

**Cost** (CI run 40126495030, the pass fused without the gain, against
`e06252f`; the gain is a multiply):

| Shot | SwiftShader GPU | macOS runner wall (advisory) |
| --- | --- | --- |
| approach-500ft | -0.5% (-0.6..-0.4) | +0.1% (-1.6..+1.8) |
| cruise-horizon | -0.4% (medians 5,884 -> 5,859 ms) | +0.1% (-0.9..+1.0) |
| forest-500ft-sunbehind | -0.3% (-0.4..-0.1) | -0.2% (-0.7..+0.3) |
| ground-2m-lowsun | -0.2% (-0.4..+0.1) | -0.3% (-1.1..+0.5) |
| water-25ft | -0.2% (medians 7,042 -> 7,031 ms) | -0.8% (-1.6..-0.0) |

Every tier-1 shot draws one call fewer and estimates 3.0 MiB less at the
capture viewport (6.6 MiB at 2560x1440@2). The separate pass had cost about
half a per cent of the frame, so this is close to all of what moving the
sharpen to the high tiers would have saved, without losing it on medium.

Draw-call ceilings: every tier-1 shot now reads its ceiling minus one. The
`final-sharpen` entry in `DRAW_CALL_RAISES` stays, as the raise mechanism
requires, until the next re-pin moves all 32 ceilings down by one and
retires it.

**The ground grain, read at an explicit mip.** The other half of PR #20's
cost is the ground grain's five extra array reads on terrain. They were
`textureSampleGrad` with limited gradients; at anisotropy 1 that is one
trilinear tap at the mip the footprint's major axis picks, so the shader now
computes that level once per scale and reads with `textureSampleLevel`
(frames move 0.01-0.08/255 on the macOS runner). CI run 40130714082, against
the fused sharpen:

| Shot | SwiftShader GPU | macOS runner wall (advisory) |
| --- | --- | --- |
| approach-500ft | +0.4% (+0.1..+0.7) | +0.7% (-0.9..+2.3) |
| cruise-horizon | -0.5% (-0.7..-0.4) | +0.6% (-0.4..+1.6) |
| forest-500ft-sunbehind | -0.3% (-1.1..-0.1) | -1.1% (-1.7..-0.5) |
| ground-2m-lowsun | -0.6% (-0.7..-0.5) | -0.6% (-1.2..-0.1) |
| water-25ft | -0.1% (-0.5..+0.4) | -0.8% (-1.4..-0.2) |

A small win, largest where the grain is (`ground-2m-lowsun` on both
rasterisers), kept. Many GPUs run explicit-gradient reads at a reduced
rate, which an explicit level avoids and SwiftShader does not model. Not
tried: fewer octaves or a distance fade on the grain, since both change the
look Jason approved.

## Spawned airports and the nearest-airport marker (2026-10-24)

Once the aircraft is 14 km from every airport, a new one is placed 5 to 9 km
away (`AIRPORT_SPAWN_POLICY`, `src/world/airportNetwork.ts`), up to eight in
the world. None of the capture's shots spawns one, so no draw-call ceiling
moves and no baseline is re-promoted (the windsock change below moves 17
pixels of one shot). What a spawn costs, and where:

- **The site search** runs on its own worker (`airportSpawn.worker.ts`): one
  certified site assessment takes 60 to 310 ms, too long for the main thread
  or the simulation worker. The main thread checks the trigger once a second
  and installs a found airport with `withAirports`, a list copy.
- **The marker** is a DOM overlay moved with a transform, so it draws
  nothing. The render loop projects into scratch objects and writes the
  element only when its half-pixel position, angle or label changed; the
  readout is rebuilt four times a second.
- **Terrain** carries a fixed set of eight airport slots in the page
  generator, the runway painter and the splat bake, compiled at load, so a
  spawn writes uniforms and never compiles a pipeline. Per fragment, each
  airport after the first costs one `vec2` difference, a `dot` and a
  compare; a one-airport world runs that loop zero times. Memory: the
  earthworks buffer grows from 64 B to 528 B, the splat airport table adds
  256 B and the painter's uniform arrays 256 B; no texture, no atlas growth.
  `TerrainClipmapSystem.setAirports` (0.34 ms) only queues the change: a
  per-frame scan of 64 atlas slots finds the resident pages the new
  airport's grading reaches, and they are regenerated in place through the
  existing compute meter, about one page a frame (about 1.9 ms GPU per
  height page and 0.7 ms per channel pair, measured on the test host). A
  spawn 15 km out rebuilt 9 of 41 resident height pages over 9 frames, none
  at L0. An eroded world still grades its home field only.
- **The airfield** (hangars, tower, windsock, fence, fuel farm, signs, lamps
  and floods) is built on the home field's materials in steps under a 1 ms
  budget per frame (about 120 to 150 frames a field). It creates no
  material or texture, and every merged mesh draws with a shader variant the
  home field already compiled: each group keeps the index width (16 or 32
  bit) the home meshes of its material have, since Babylon keys a define on
  it, and every windsock is scaled a hair off uniform along its length
  (`WINDSOCK_LENGTH_SCALE`), since Babylon keys another on that.
  `tests/render.webgpu-spawned-airfields.test.ts` compares each merged
  mesh's defines with the home field's. Its meshes merge into 7 draws; lamps
  ride the home light-point draw and floods take clustered lights reserved
  at startup (13 + 18 of the batch's 32). Per tier
  (`spawnedAirfields` in `QualityProfile.ts`):

  | | Low | Medium | High / Ultra |
  | --- | --- | --- | --- |
  | Fields built | 0 | 1 | 2 |
  | Build / cull distance | none | 6 / 4 km | 8 / 6 km |
  | Shadow casting | no | no | yes (up to 12 shadow draws) |
  | Fields with floods | 0 | 1 | 3 |

  On low nothing is built, lit or reserved.
- **Vegetation** keeps off a spawned field, and only the detail cells its
  reach meets regenerate, on the worker, while the old cells keep drawing.

**Measured.** With a spawned field in view on medium (scratch shots, not
committed): draws 227 to 234 on a 1.2 km final and 210 to 217 from 1.5 km
abeam, about 50 k more triangles and 2.0 MiB more inventoried GPU memory.

Cloud A/B, the airport work and autoland (`09f4dac`) against main
(`6d91220`), SwiftShader, 16 rounds, in five parts: every shot SAME, draw
calls unchanged.

| Shot | GPU time | Draw calls | Pixels |
| --- | --- | --- | --- |
| approach-500ft | -2.5% (-3.7..-1.3) | 248 → 248 | 0.85% differ (see below) |
| cruise-horizon | -2.2% (-3.6..-0.1) | 201 → 201 | identical |
| forest-500ft-sunbehind | -0.3% (-1.8..+1.0) | 249 → 249 | identical |
| ground-2m-lowsun | -2.6% (-4.2..-1.4) | 122 → 122 | identical |
| water-25ft | -2.0% (-3.3..-0.4) | 225 → 225 | identical |

`approach-500ft` comes to rest with 36 or 37 resident terrain pages (both
arms want 24), whichever commit renders it. The same commit (`e2ddbb6`) came
to rest with 37 as one A/B's base and 36 as another's head. Counts-only A/Bs
of each merged commit against its parent rendered identical frames on
`ground-2m-lowsun` every time; on `approach-500ft` every pair differed by
that flip alone, the same 0.85% of pixels, with every other count equal.

**Stutter** (`npm run perf:flight -- --base origin/main`: six legs of 240
frames at 120 m/s on medium, SwiftShader, the frame's draws dropped; the
figures are the five legs after the first). For a spawn, a scratch change to
the harness (not committed) installs a field 5 km ahead and 1.5 km aside as
leg 2 begins, from the approach shot, so the home field drew first:

| | main | `fc4e890`, no spawn | `f86a866`, a field spawned |
| --- | --- | --- | --- |
| render() ms p50 / p99 / max | 12.3 / 98.7 / 219.3 | 9.9 / 29.3 / 53.4 | 9.8 / 26.0 / 95.6 |
| frames over 4x the median | 26 | 4 | 2 |
| long tasks: count / total ms | 27 / 2,779 | 2 / 105 | 1 / 95 |
| pipelines / shader modules created | 1 / 2 | 2 / 2 | 2 / 2 |

Main's column is from the no-spawn run; the spawn run's own main arm read
the same (24 long tasks, 2,325 ms). No head leg built vegetation inline. The
spawn's leg peaked at 36.4 ms. The one long task came three legs later, over
the home field, in `world-page-visibility`, where the no-spawn run has its
own (53 ms) and an earlier spawn run had none. The spawn created no pipeline
and no shader module: the head's counts are the no-spawn run's, and its one
listed compile is the wildlife keratin PBR both arms make.

Before `df1445e` and `bc9c41f` a spawn compiled one variant, 85 KiB of WGSL:
a spawned sock streaming at another bore than the home sock's drew with a
different `NONUNIFORMSCALING`. The home sock could do the same alone, on
main, when the wind at its mast crossed 15 kt. Keeping every sock off
uniform moves 17 pixels of `ground-2m-lowsun` by at most 20/255 (the home
sock, at a distance; every other pixel and count identical in a counts-only
A/B). A real spawn site found by the search (`c6d8aab`, flown from 4.5 km
out with `--start 19740.8,-13155.1,-17.02`) read no long task and no frame
over 4x the median after the spawn, render max 35.0 ms against main's
211.4 ms.

### Compare CI parts on one CPU model (2026-10-25)

Each SwiftShader part of the CI gate runs on whichever runner CPU it draws
(so far an AMD EPYC 7763, 9V74 or 9V45), and the report's header names it.
The models weigh work differently. The 9V45 runs about twice as fast as a
7763 and read the biomes PR's cruise at +3.7% against main where a 7763
read +1.0%; on it, passes the PR does not touch moved by 5-8% (the cloud
raymarch +8.2%, the bloom composite -5.6%, with identical pixels). Within
one model, run-to-run spread is about 1%. So attribute a change only between
parts on the same CPU model, and use the macOS runner's advisory A/B to
break a tie: it read the same cruise at +0.5% (-0.2% to +1.2%).

## Medium/balanced choppiness: the vegetation worker's watchdog (2026-10-25)

Jason, 2026-10-25: medium/balanced feels much choppier than before. What
was found is a watchdog that took a busy vegetation worker for a dead one,
and a failover that then lasted the whole session.

**The cause.** The detail (vegetation) worker generates cells and packs
their chunks. Its presentation watchdog in `WorldDetailRuntime` failed the
worker over when a build took too long, and that failover is permanent: the
worker is disposed and every vegetation cell after it is generated on the
main thread, a stall every few frames (as in "Flight stutter" above). On
main (`19543c0`, unchanged at `05f17b4`) that clock

- started at the first update with any worker presentation demand and ran
  on through main-thread publication streaming and every cancel and reissue,
  until a build was accepted, and
- expired after 240 updates OR 8,000 ms of charged time.

240 updates are 2 s on a 120 Hz display, and a fresh region's builds could
take longer than that: the worker ran a whole queued cell between every
pair of 4 ms build slices, and yielded between slices through a nested
`setTimeout(0)`, which clamps to 4 ms. On a machine drawing 9 to 12 frames
a second while a region settles, the 8 s arm trips instead. 2026-10-24's
fix had reworked only the generation watchdog (and lifted update gaps off
both clocks). The evidence:

- A unit model (`tests/render.webgpu-detail-worker-liveness.test.ts`: one
  worker thread and a 120 Hz main thread in virtual time, cell costs from
  the cloud host scaled to a Mac) trips `19543c0` when the session parks for
  3 s after a fill and then flies east: 58 ms into the flight, with the
  clock 366 updates old (`7d300de`). The trip itself was not seen in a
  browser, because perf:flight never moved after such a hold, but what it
  needs was: main's presentation clock left set, unchecked, while the
  aircraft held still. Settle trial 2 ended with main's clock still open in
  9 of the 11 main arms that ran settle trials (wave 1 job 1, wave 1.5 jobs
  0-7), at 7.3 to 12.2 s (151 to 309 updates). In 7 of them it was already
  past main's own 240 updates or 8 s with no trip, so nothing was checking
  it, and the first sweep with demand would have found it expired. Main
  ended both parked legs of wave 1's park-then-fly job with no span open.
- In the browser, on the macOS runner's GPU (below): main charged its
  worker 2 s or more 28 times across wave 1's eight jobs (an estimate of
  its trips at 120 Hz, not a bound; see wave 1), and in wave 1.5 it tripped
  outright in 4 of 10 arms, all on the 8 s arm, while a region settled at
  9 to 12 frames a second. The fix and the worker fix alone did neither in
  22 arms, outside the one leg where the worker was hung on purpose.

Why it showed now is not pinned down. The 240-update deadline is older
than the October merges: it is on main by 2026-09-22 (`a4c8762`). Near
home the biome and landform merges left a cell's cost where it was: 95.6
ms at `c43eb86` and 94.8 ms at `19543c0`, the mean of 64 cells generated on
the cloud host (a scratch bench, not committed). Away from home it depends
on the ground, 36 cells each: 150 km south a cell went from 68.9 to 79.4
ms (+15%), 200 km east from 123.5 to 101.8 ms (-18%, where the trees are
gone), and a forced dunes or volcanic world (`19543c0` only, 12 km east of
home) takes 140 to 145 ms.

**The fix** (`git log origin/main..HEAD` on the branch, based on
`05f17b4`). The worker and its watchdog:

| Commit | Subject |
| --- | --- |
| `a6aed08`, `1cebeca` | Teach the detail-worker protocol a build heartbeat before any worker sends it; Post a heartbeat between detail-worker build slices |
| `e5077a3` | Time detail-worker silence, not slowness, in the presentation watchdog |
| `7d6809c` | Let detail-worker builds go ahead of queued cells to halve build latency |
| `2734df2` | Respawn a failed detail worker before falling back to the main thread |
| `aef41c1` | Reset the worker clocks when the presentation sweep goes idle |
| `e8a1f47` | Show in the diagnostics panel when the vegetation worker failed |

All but `e8a1f47` are in the build that waves 1 and 1.5 flew (below).

- A build posts a heartbeat after its first slice and then at most every
  `DETAIL_WORKER_HEARTBEAT_MILLISECONDS` (100 ms).
- The presentation clock charges only silence. A heartbeat from the build
  the runtime holds, or an accepted answer, restarts it; it holds still
  while the demand is the main thread's (a publication streaming, an inline
  build, an answer queued); it resets when the presentation sweep goes idle.
  Cancel and reissue still do not reset it, so motion cannot keep a dead
  worker alive.
- Both watchdogs expire after 240 charged updates AND at least
  `DETAIL_WORKER_WATCHDOG_MINIMUM_MILLISECONDS` (2,000 ms), so 240 updates
  never mean less than 2 s of silence (2 s at 120 and 240 Hz, 4 s at 60
  Hz), or after 8,000 ms whatever the count. A gap between updates is still
  charged at most 100 ms.
- Cells posted while a build runs wait. Each runs once the build has had
  its turn of slices (a fifth of the last cell's time, 4 to 8 ms), and all
  run when it ends. The browser worker yields through a self-posted
  MessageChannel message, which has no clamp. In the unit model, at 30 ms a
  cell, the longest build fell from 521 to 286 ms while a region's fill took
  4-6% longer (`7d6809c`); the worker also runs flat out during a build
  where it used to idle for part of every slice.
- A worker that errors or goes silent is replaced at the next update by a
  new one on the same seed and live world, up to `DETAIL_WORKER_RESPAWN_LIMIT`
  (2) times per runtime, and only then does generation fall back. After a
  fallback, inline cells run on credit instead of one whole cell every
  update. A worker in an eroded world (its terrain pages were transferred
  to it), and a build that fails or answers malformed, still fall back at
  once (`2734df2`, `1fae8ec`).
- Demand that goes `DETAIL_WORKER_CONVERGENCE_MILLISECONDS` (30,000 ms)
  without an accepted build is counted and reported, never failed over.
- A respawn, a fallback or a convergence stall warns once per kind
  (`console.warn`, "detail worker ..."), and the diagnostics panel's detail
  line adds VEG WORKER RESTARTED xN or VEG GEN ON MAIN THREAD.

Main-thread work that also hitched a medium/balanced flight. The last column
says whether the build that waves 1 and 1.5 flew (`5dd5ecb`: the branch
through `4ae68b4`, on `19543c0`) had it working, and whether perf:flight
can show it at all: the harness pins the render scale (the governor never
steps) and drives `FlightRenderer` without `FlightGame` or the HUD.

| Commit | Subject | What it changes | In waves 1, 1.5 |
| --- | --- | --- | --- |
| `e513c6f` | Apply render-scale steps at the next frame's start so no drawn frame is discarded | the governor's step forced a resize after `endFrame`, throwing the drawn frame away | in the build, not exercised: perf:flight pins the render scale |
| `b0ecd8b` | Poll renderer diagnostics only while something shows them, and skip unchanged airport readouts | a 2 Hz read walked every desired detail cell with the panel closed (it is off by default); now only while the setting is on or the viewer HUD is up (`75d4626`) | in the build, not exercised: the poll is `FlightGame`'s, which perf:flight does not run |
| `6a80b12` | Prime each wildlife batch's pipelines at startup so the first antler does not hitch | the keratin PBR compiled at the first antler, 35-87 ms on Metal once a session | yes |
| `73e1cbb` | Cache generated wildlife cells so a cell crossing generates only new cells | a cell crossing regenerated the whole window; 5 km at 250 m/s generates 71 cells instead of 617 (unit test) | no: the renderer turns it on in `69746b7` |
| `02f875f` | Bake the ground-cover tile in 32 m steps to hold a low frame near its budget | below the gate every frame baked a whole row, 12.6-15.2 ms p50 on the cloud host; in 32 m steps under 1.5 ms, 2.9-3.2 ms there (the pace floor binds) | no: only with the game's height-only sampler (`69746b7`, `904c309`), which perf:flight does not pass |
| `69746b7` | Read height-only terrain where a consumer needs only the height | the camera clamp, spawned airfields, ground-cover tile and birds stop paying for normals and classification; bit-identical heights | no |
| `e149d4d`, `8adc324`, `49e666e`, `4dc648a` | Slice the sky irradiance bake so a climb's re-light can spread over frames; Slice the in-flight sky re-light so a climb spreads it over frames; Land the sliced sky re-light's cloud LUT on a frame of its own; Re-light the sky at once after a teleport, not over a sliced rebake | each 500 m of climb re-lit the sky in one frame; now 0.5 ms of sampling a frame, then SH, specular cube and cloud LUT each on a frame of its own. An environment change, a teleport and the capture (`skyRebake: "sync"`) re-light at once | no: `e149d4d`'s sliced bake was in the build, but nothing called it before `8adc324` |
| `05e9b1d`, `af053f8` | Measure the chase camera's ground speed over simulation time; Divide the chase trail's distance by simulation time only from 1/240 s up | a hitch read as a burst of speed and threw the chase camera back, then forward | no |

Each measured figure in that table comes from its commit's message. The
remaining commits on the branch are follow-ups and tests (`31c1de0`,
`fa2ffc8`, `7d300de`, `3e8f908`, `3492803`, `e107d26`, `bc89123`,
`08eade3`, `6a3d0e2`, `ccbc1e4`, `b9ec5ec`, `f6646e9`, `7a9a190`,
`41838e9`, `cb0fc03`, `3548966`) and the perf:flight harness
(`882569a` to `b4d5fa4`, and `4ae68b4`: the probe, the verdict and the
options marked 2026-10-25 above).

**Where the flights are kept.** Both waves ran a temporary workflow whose
matrix is in `.github/workflows/perf-flight.yml` at `1c8d792` (wave 1) and
`01e9aa6` (wave 1.5). Those two commits, and the builds flown (`5dd5ecb`
and `0058f56`), are on no branch now: the investigation branch was
rewritten for wave 2. They resolve by SHA only in a clone that still holds
them, or from the run pages. `5dd5ecb` and `0058f56` are the branch through
`4ae68b4` and through `fa2ffc8` rebased onto `19543c0`, with the same
patches to `src`, `tests` and `scripts` up to hunk offsets. The text and
tables below give every job's arguments. Artifact
`perf-flight-<job>-<run>-1` holds each job's `report.md` and `report.json`,
and the artifacts expire 14 days after the runs (about 2026-11-08).

**Wave 1** (CI run 40208129275). macOS runner, `--gpu hardware --draws`,
medium/balanced, trainer, chase camera, from `approach-500ft` at 250 m/s in
600-frame legs (`--speed 250 --leg-frames 600`); main is `19543c0`, the fix
`5dd5ecb`. Jobs 0-2 and 6-8 fly breezy weather (`--weather breezy`), 3-5
clear. No arm TRIPPED in wave 1 (the runner drew 10 to 41 frames a second,
so 240 updates took about 6 s or more).

Main's would-trip count is an estimate of its trips at 120 Hz, not a bound.
It over-counts: main checks its clock only while the presentation sweep
runs, and the sweep can go idle with the clock still set (the stale epoch
`aef41c1` removes); the probe charges that time too, and a stale span trips
only if demand comes back before a sweep without demand clears it. One main
span (job 1, settle trial 2) reached 8,966 ms without tripping the 8 s arm,
so main was not checking that clock then. It can also under-count: the
harness drew 10 to 41 frames a second, and the part of any gap between
updates past 100 ms is not charged, where a 120 Hz session, with no such
gaps, would charge the same wall time in full. The fix resets its clock
when the sweep goes idle, so its count holds no stale spans.

| Job | Flight | Would-trip spans, main / fix | Longest charged span, ms, main / fix | Accepted build latency p50, ms, main / fix |
| --- | --- | --- | --- | --- |
| 0 | park then fly (`--park-legs`), 4 legs | 3 / 0 | 2,667 / 465 | 549 / 115 |
| 1 | 2 legs, then 12 settle trials (`--settle-trials 12 --trial-frames 600`) | 17 / 0 | 8,966 / 616 | 293 / 159 |
| 2 | far east (`--start 160000,0,90`), 6 legs | 2 / 0 | 3,454 / 634 | 129 / 37 |
| 3 | forced boreal province (`--base-world` and `--head-world` `{"climateProvince":"boreal"}`), 6 legs | 1 / 0 | 3,306 / 1,110 | 130 / 46 |
| 4 | kill the worker at leg 2, frame 300 (`--kill-detail-worker 2:300`); 4 legs | 1 / 0 | 3,258 / 669 | 460 / 64 |
| 5 | hang the worker at leg 2, frame 300 (`--hang-detail-worker 2:300`); 4 legs | 1 / 0 | 3,477 / 479 | 473 / 69 |
| 6 | near home, 6 legs | 2 / 0 | 4,110 / 553 | 128 / 76 |
| 7 | as 6 with the arms swapped (`--under-test 5dd5ecb`) | 1 / 0 | 4,454 / 818 | 112 / 51 |
| 8 | A/A of the fix | - / 0 and 0 | - / 447 and 774 | - / 47 and 63 |

The counts are the verdict's `wouldTrip` summed over the stream to rest,
the legs and the trials; the longest span is the larger of the two clocks
(the fix's 1,110 ms is job 3's generation clock; its longest presentation
span was 884 ms). Job 5 leaves out the hung leg, where both arms' clocks
ran to the hang's detection (main 7,986 ms, the fix 7,722 ms): that is
the hang, not a false trip. Latency pools every accepted build of the job;
main's in jobs 4 and 5 stop at its fallback. Across jobs the fix answered
builds 1.7 to 7.2 times sooner (3.1 at the median); pooled over jobs 0-7,
main 149 ms p50 (3,546 builds) and the fix 72 ms (6,062). Jobs 1, 2, 3, 6
and 7 also passed `--fail-on-worker-fallback`, which changes no
measurement.

Killed or hung, main FELL BACK to main-thread generation and the fix
RECOVERED on a new worker (the legs after the first, legs 2 to 4):

| | kill: main | kill: fix | hang: main | hang: fix |
| --- | --- | --- | --- | --- |
| render() ms p50 / p95 / p99 | 10.7 / 63.7 / 113.6 | 7.7 / 14.7 / 23.9 | 13.5 / 72.7 / 141.5 | 11.2 / 21.3 / 33.1 |
| long tasks: count / total ms | 125 / 10,805 | 4 / 205 | 138 / 13,249 | 8 / 566 |

The fix noticed the hung worker on the 240-update arm, after 7,781 ms of
charged silence (the runtime's `workerMaxSilenceMilliseconds`) and about
10 s of wall time at 20 frames a second; at 120 Hz that arm takes 2 s.

With no trip and no fault (jobs 0-3, 6 and 7), steady flight is even:
render() p50 after the first leg, fix over main, 0.95 to 1.05 (the A/A
read 0.95), p95 0.66 to 1.11. Every main arm compiled the wildlife keratin
effect (123.9 KiB of WGSL) mid-flight; the fix created no shader module
except in job 2, where both arms compiled the far east's hydrology water
and a plain PBR variant. The first leg read the fix 1% to 20% slower in all
eight jobs (1.15 with the fix as the base), which is why wave 1.5 flew
both orders.

**Wave 1.5** (CI run 40210471637). Every job: 4 legs of 600 frames at 250
m/s in breezy weather, then 4 settle trials of 600 frames (`--legs 4
--leg-frames 600 --speed 250 --weather breezy --settle-trials 4
--trial-frames 600`), otherwise as wave 1. A third build, the worker fix
only (`0058f56`: the branch through `fa2ffc8`, the worker commits and the
harness without the main-thread work), was flown to separate the two
halves. Under perf:flight the fix differs from it in effect only by the
wildlife prime (`6a80b12` and its follow-ups): the render-scale step and
the diagnostics poll are not exercised, and the cell cache, the tile's
32 m steps and the sliced sky re-light were not switched on in that build
(table above).

| Job | Base / head | TRIPPED | Would-trip spans, base / head | render() p50 head / base: first leg, legs after it, settle trials |
| --- | --- | --- | --- | --- |
| 0 | main / fix | none | 5 / 0 | 1.147, 0.992, 1.012 |
| 1 | main / fix | none | 8 / 0 | 0.865, 1.019, 1.016 |
| 2 | main / fix | none | 6 / 0 | 1.214, 1.043, 1.040 |
| 3 | fix / main | main, in the stream to rest | 0 / 8 | 1.078, 1.085, 1.018 |
| 4 | fix / main | none | 0 / 9 | 0.883, 1.000, 0.979 |
| 5 | fix / main | none | 0 / 9 | 1.048, 0.978, 0.994 |
| 6 | main / worker fix only | main, in the stream to rest | 10 / 0 | 0.860, 0.758, 1.016 |
| 7 | worker fix only / main | none | 0 / 8 | 0.964, 1.000, 0.981 |
| 8 | worker fix only / fix | none | 0 / 0 | 0.843, 0.953, 0.985 |
| 9 | fix / worker fix only | none | 0 / 0 | 0.884, 1.034, 1.013 |
| 10 | main / main (A/A) | both: the base in trial 4, the head in trial 2 | 9 / 9 | 1.065, 0.951, 0.983 |

Main charged 81 would-trip spans in its 10 arms and TRIPPED in 4. The fix
(8 arms) and the worker fix only (4 arms) neither tripped nor charged a
span of 2 s; their longest were 1,242 ms and 1,502 ms. All four trips were
the 8 s arm: the tripping span read 7,995 to 8,023 ms at the last frame
before the trip, and none of the four had reached 240 updates (117 to
190). The 81 over-counts as wave 1's 28 does: in settle trial 2, eight
main arms (jobs 0-7) ended with a span still open at 7.3 to 12.2 s (up to
309 updates), six of them past main's own limits with no trip, so main
was not checking them. Accepted build latency, pooled p50 over every arm of
each build: main 148 ms, the fix 89 ms, the worker fix only 87 ms.

| Trip | Where, at frames/s | The leg after it (jobs 3, 6) or the trial it tripped in (job 10): render() ms p50 / p95, long tasks | The other arm, same phase |
| --- | --- | --- | --- |
| job 3, main (head) | stream to rest, 10.0 | leg 1: 18.0 / 88.6, 47 | fix: 16.7 / 40.8, 20 |
| job 6, main (base) | stream to rest, 11.9 | leg 1: 17.9 / 99.2, 47 | worker fix only: 15.4 / 43.0, 25 |
| job 10, main (base) | settle trial 4, 11.8 | trial 4: 22.8 / 196.3, 182 | main, not tripped there: 13.9 / 71.0, 62 |
| job 10, main (head) | settle trial 2, 9.3 | trial 2: 26.3 / 235.9, 228 | main, not tripped there: 16.8 / 82.0, 80 |

Over legs 2 to 4 the two arms that tripped in the stream to rest read
render() p50 / p95 / p99 14.0 / 51.6 / 101.0 ms with 98 long tasks (job 3)
and 15.3 / 51.9 / 108.4 ms with 96 (job 6), against 12.9 / 25.3 / 54.7 ms
with 22 and 11.6 / 24.4 / 49.4 ms with 19 in the other arm.

The first leg's cost is not settled. Single runs put the fix's first leg
anywhere from 13% faster to 21% slower than main's, and runs in the same
arm order spread as widely (jobs 0-2: 0.865 to 1.214), so one run says
little. The estimates below pool both orders (geometric means of head over
base, half the difference of the two orders) and leave out job 3, whose
main fell back in the stream to rest and generated cells on the main thread
for all four legs, which makes the fix look cheaper. On the first leg, jobs
0-2, 4 and 5 read the fix over main +5.2% at p50 with one standard error
of 6.7% (+3.2%, SE 6.1%, with job 3), and wave 1's one matched pair of
orders, jobs 6 and 7, reads +9%; wave 1 had the fix's first leg slower in
all eight jobs. A first-leg cost of a few percent is possible and not
shown. After the first leg the fix reads +1.4% (SE 0.9%; -0.1% with job 3),
and the settle trials, on fresh renderers that job 3's trip does not
reach, +1.3% (SE 0.7%): a steady cost of about 1-2% at p50 that may be
real. Which arm was the head moved the main / fix pairs by 1-3%, but in
jobs 8 and 9 the head's first leg was 16% and 12% faster than the base's,
whichever build it was. The fix over the worker fix only, from that one
pair: -4.0% at p50 after the first leg and -2.3% on the first leg, inside
the A/A runs' 5-7% (job 10 here, job 8 of wave 1).

**What is expected not to change** (pending the CI capture check).

- Still images. The 39 perf baselines (`tests/perf/baseline`) are expected
  unchanged, and that is pending the CI capture check on the branch.
  perf:capture passes `skyRebake: "sync"` and the capture time pin makes
  the A/B agent's renderer synchronous, so every re-light lands in one frame
  as before; the ground-cover tile's bytes are the same at every budget and
  with either sampler; the height-only sampler equals the full sample's
  height bit for bit (`tests/render.live-terrain-height.test.ts`); a steady
  frame keeps the chase camera's old division bit for bit; construction,
  profile changes and the capture pin keep the forced render-scale path; and
  the capture respawn ends a pending wildlife prime.
- Draw-call ceilings. They are pinned per shot as `drawCallCeiling` in
  `PERF_CAPTURE_SHOTS` (`scripts/perf-capture.mts`; 32 of its 39 shots
  carry one), with raises in `DRAW_CALL_RAISES`
  (`scripts/deliveryFloors.mts`), and checked by
  `tests/delivery-floors.test.ts`. No commit on the branch touches those
  files or `tests/perf/baseline`. The only new draws are the wildlife
  prime's zero-matrix instances (they rasterise nothing), which last until
  each batch's pipelines exist and which a capture respawn ends, so no
  shot's count is expected to move; the capture check is to confirm it
  (wave 2, below).
- The steady GPU cost (perf:ab) of the branch is not recorded in this
  section.

### Wave 2: the whole branch on `05f17b4` (PLACEHOLDER)

**PLACEHOLDER: wave 2 is running; this subsection is filled in when it
finishes.** Waves 1 and 1.5 flew `5dd5ecb` on the old main, which had
neither the wildlife cell cache nor the height-only reads, the sliced sky
re-light, the chase camera's ground speed or the diagnostics line working.
Wave 2 flies the branch as it stands on `05f17b4`, but perf:flight can
show only some of that: the wildlife cell cache is on in every arm of the
fix; the chase camera's ground speed is what an `--emulate-hitch` job
flies; the height-only reads still pay a full analytic sample each, since
perf:flight passes no `terrainHeight` (in an eroded world they skip only
the pages' normal and slope); the sliced sky re-light runs only after 500 m
of altitude change, which perf:flight neither asks for nor records; the
render-scale step, the diagnostics poll
and the diagnostics line are outside it (pinned render scale, no
`FlightGame`, no HUD); and the ground-cover tile's 32 m steps are not
exercised at all (no height-only sampler). To fill in: the CI run id and
the commit that holds its matrix, the jobs and their arguments, which of
the commits above each job exercised, the would-trip and TRIPPED counts,
render() and long tasks per arm, and the capture check's result on the 39
baselines and the draw-call ceilings.

## Capture harness

`npm run perf:capture` renders the authoritative `PERF_CAPTURE_SHOTS` list. Entries whose
`comparesToBaseline` value is true read their committed image from `tests/perf/baseline`;
diagnostic/probe entries deliberately run without one. The thirty committed PNGs and the
thirty-row table above therefore describe the promoted comparison set, not the length of
the live capture list. Notes that matter when reading its output:

- A normal capture treats `tests/perf/baseline` as strictly read-only and
  hard-fails a missing or dimension-mismatched committed image. Diagnostic
  screenshots and `report.json` are written only to the ignored
  `tests/perf/artifacts/` directory.
- `npm run perf:capture:candidate` cannot be filtered. It buffers the exact
  full canonical shot set through capture, then writes the diagnostic frames
  and report to a fresh timestamped directory beneath
  `tests/perf/artifacts/rebaseline-candidates/` with a `NOT APPROVABLE` status
  before evaluating the visual, temporal, renderer-error and strict tier-1
  performance gates. Only a run that passes every gate replaces that status
  with `APPROVABLE`. It has no baseline promotion path; copying an approved
  candidate into the committed set is a separate, deliberate review action.
- Medium/balanced has one non-negotiable raw frame-delivery gate over each
  240-frame window: at least 60 wall-clock fps, frame-interval p95 at most
  16.67 ms, at most five intervals over 27.4 ms, and no interval over 50 ms.
  The historical trimmed fps and renderer counters remain in the report for
  diagnosis, but cannot rescue a strict-gate failure.
- Visual comparison is not a whole-frame grayscale average. The capture gates
  luma SSIM, independent R/G/B SSIM, RGB SSIM over the lower 60% of the frame,
  and the least-similar 64 px tile. A stable sky therefore cannot dilute a
  broken terrain/tree patch, and equal-luminance hue splotches still fail.
- Baseline similarity cannot certify that either image contains its intended
  subject. Every screenshot independently needs non-black mean luminance,
  mean within-tile variance above 0.0001, and at least half of its 32 px tiles
  at variance 0.00001 or greater. The 10,000 ft downward terrain shot also has
  a pure camera/world placement contract requiring at least 95% of a 41×23
  reconstructed cockpit frustum to hit terrain before sea. This rejects both
  a true black submit and the obsolete uniform open-ocean view even if a stale
  baseline matches it perfectly.

- The steady capture begins after renderer creation and therefore cannot catch
  a startup Promise that never settles. Cold time-to-ready, startup-stage
  timings, timeout and console-error status are a separate measurement; the
  11,098 ms development reload and 13,255 ms built-server navigation above are
  diagnostic evidence, not that acceptance result. The gate fails on **timeout
  or console error**, because the failure class this guards — the `5-10` startup
  Promise — hung with no error at all, so an error check alone cannot catch it.

  **Built 2026-08-31 and closed 2026-09-02 (`6-11` item 3):
  `tests/perf/cold-start.test.ts`.** Nothing in the project measured startup
  before it — the shot capture boots one renderer and holds it for the whole
  list, so its numbers are a warm steady state and describe none of the first
  seconds a player meets. `npm run perf:cold-start` owns a fresh-browser run;
  every canonical capture command runs that command first and selects only
  `perf-capture.test.ts` in its second process. Thus scheduler order or file
  parallelism cannot turn the cold measurement into a warmed one. Two design
  points are load-bearing:
  - **Both failure halves are required, and neither is redundant.** The `4.5-0`
    crash hung with *no* error, so an error-only check watches it hang forever;
    the eroded world logged nothing while taking ~90 s, so a timeout-only check
    calls that healthy right up until it crosses.
  - **"Ready" means a readable, GPU-complete frame**, not that `create()` or
    `render()` returned. Completion includes the render, same-task synchronous
    canvas readback, the raw GPU submitted-work fence, and one event-loop task
    for asynchronous error delivery. A renderer that resolves and cannot draw
    is the black-frame failure wearing a green hat.

  **The analytic-default deadline is 2,300 ms to strengthened readiness.** It is
  derived, not transcribed: the three retained fresh-browser reference-host ready
  totals are **1,817.7 / 1,815.4 / 1,821.3 ms**. Their diagnostic split is
  **1,537.6 / 1,537.1 / 1,542.6 ms** through `FlightRenderer.create()` plus
  **280.1 / 278.3 / 278.7 ms** through completed frame delivery; the create-only
  values are not readiness evidence. The median 1,817.7 ms plus 25% startup
  headroom is 2,272.125 ms, rounded up to 50 ms. All three completed frames
  reported **12 terrain tiles** and **1.81%** lower-outer-frame horizontal detail;
  those semantic checks run after the readiness clock stops. A final canonical
  confirmation also passed at **1,809.0 ms ready** (1,529.5 ms create + 279.5 ms
  completion) with the same 12-tile and 1.81% semantic result.
  `scripts/deliveryFloors.mts` owns the retained paired samples and derivation;
  `tests/delivery-floors.test.ts` pins the result to 2,300 ms, and the executable
  cold-start test enforces it on the reference host.
  Hosted/unpinned runs report the same number while retaining the timeout,
  console/renderer-error, readable-frame, terrain-draw, and trace-coverage gates.
  `COLD_START_HANG_CEILING_MS = 120_000` remains a
  separate hang catcher and must not be quoted as a budget. Likewise, W-1's
  1.5 s figure is the parked **eroded** experiment's target, not the shipping
  analytic deadline.

  **D-26's missing attribution is closed.** The old trace timed selected
  Promises, so synchronous constructors and direct awaits disappeared between
  them. The replacement is a sequence of disjoint checkpoints: every wall-clock
  millisecond in `FlightRenderer.create()` belongs to exactly one interval,
  intervals are marked sync/async, and the test fails if their sum differs from
  the measured total by 5 ms or more. A representative pre-optimization run
  from the current 1,751–1,768 ms set attributed all 1,765 ms with a 0.0 ms gap:
  **detail-runtime construction 942 ms**, scene shader readiness 408 ms,
  hydrology startup 81 ms, airport construction 74 ms, and atmosphere/cloud
  construction 66 ms. Detail alone was 53% of the total and 72% of the old
  1,302 ms unnamed remainder.

  The causal duplication was exact: `WorldDetailRuntime` planned and uploaded
  the foliage atlas, then the impostor planner synthesized the same seeded
  foliage plan again before sampling its mip 0. Three isolated Node readings
  put one redundant plan at 449 / 425 / 413 ms. Production now shares the first
  immutable plan with both uploads; a full-mip byte-parity test protects both
  impostor arrays. This removes deterministic duplicate CPU work without
  changing atlas resolution, content, or GPU memory. Three independent
  fresh-browser runs after the change measured create **1,574 / 1,524 / 1,541
  ms** and trace gap **0.0 ms** on all three. Their historical **81 / 82 / 83
  ms** suffixes measured only how long `renderer.render()` took to return; they
  predate synchronous readback, the GPU fence, and the error-delivery task, so
  they are retained as render-call diagnostics and are **not readiness
  measurements**. Detail construction fell to **731 / 704 / 717 ms**. Thus
  every post-change create is at least 177 ms (10%) below every 1,751–1,768 ms
  pre-change reading; the strengthened final samples above own readiness and
  headroom.

- `VITE_PERF_SHOTS=name[,name]` runs a subset. A full capture is ~4–6 minutes,
  which is the wrong feedback loop for diagnosing one bad shot; the filter
  refuses to run alongside `VITE_PERF_REBASELINE` so a partial run cannot be
  mistaken for a reviewable candidate.
- `npm run material:preview` writes a terrain-material contact sheet to
  `tests/perf/artifacts/` — ten materials across, five channels at three
  footprints down. It is the tool the recipes are tuned against; the artifacts
  directory is gitignored because the repo ships no image assets by design.
- Phase 3 rebaselined the whole set. Net effect on the capture machine:
  **−70 draw calls on every shot** (`3-9` deleted the runway boxes and the
  apron), GPU p95 **down on twelve of thirteen** shots, frame rate up on ten.
  The one regression is `canopy-1200ft` (10.86 → 12.16 ms GPU p95), whose floor
  was re-pinned 27 → 24 — a 45°-down cockpit shot over forest is mostly
  near-field terrain between the trees, where ten mipped materials cost most
  and no airport meshes were deleted to pay for them.
- The committed `minFps`/`hitchCount` ceilings were measured on the reference
  M-series machine. They are **not** portable: the same build on a different
  box, or on a hot one, moves GPU p95 by several milliseconds on shots it
  cannot possibly have touched. `drawCalls`, `vegetationBatches` and
  `triangles` are load-independent and are the right counters to compare
  across machines.
- Gate B's one sanctioned vegetation capture accepted the new forest/glade
  pixels but did not re-pin a performance floor. Repeated full WebGPU runs on
  the capture host also slowed one-batch high-altitude scenes, so the recorded
  floor failure remains evidence of host pacing/thermal state rather than a
  claimed budget improvement.
- Gate A's sanctioned close capture adds 35–46 aircraft draws per scene and
  measured −0.21 to +0.45 ms GPU p95 against the immediately preceding Gate-B
  state. The hot host again missed `approach-500ft` (18.2 versus its unchanged
  24 fps floor), while interval/CPU/GPU p95 were 63.4/5.6/17.64 ms. No floor
  moved. Its production material test also removed the last renderer-error
  allowlist: cloud+aerial and aerial-only PBR effect variants must now compile
  with distinct cache keys and zero missing-sampler warnings.

## W-11 promotion — sun glitter (2026-09-19)

Three baselines promoted from the full candidate
`tests/perf/artifacts/rebaseline-candidates/2026-09-20T02-53-31.461Z/`:
`water-400ft-glitter` (new), `water-25ft` and `water-3m`. The sparkle that
stood in for sun glitter was a white-noise field hashed on the SCREEN pixel; it
is now a discrete glint on a power-of-two world grid. See
`docs/findings/WATER_SUN_GLITTER_2026_09_19.md`.

Measured cost, two arms per side, report deleted between arms and
`capturedAtIso` checked:

- Same-arm noise floor first, so the comparison has a stated resolution: median
  0.21%, worst 0.96% (`hills-dusk-glint`, the heaviest shot in the list).
- `slant-10km` 121.10 → 121.20 (+0.08%), `coast-10km-lowsun` 121.10 → 120.90
  (−0.17%), `water-25ft` 121.15 → 121.05 (−0.08%), `hills-dusk-glint` 93.40 →
  93.35 (−0.05%), `water-3m` 121.35 → 121.35 (0.00%), `water-400ft-glitter`
  120.95 → 121.25 (+0.25%).
- Every shot inside ±0.25% against that floor, with mixed signs, so this is
  noise rather than a small cost. The new shot is the heaviest case for the new
  code and moved least in the direction of a cost.
- Draw calls byte-identical on every shot in both arms (223 / 235 / 238 / 258 /
  237 / 234). Nothing new is drawn: the change is a different arithmetic inside
  one fragment, with one extra hash and about ten flops.
- Cold start 2048.0 ms against its 2300 ms deadline (create 1693.1, completion
  354.9, gap 0.0). W-11 adds no first-frame work, and it did not move.

Which shots the change actually moves, candidate against candidate at an
IDENTICAL shot list, worst 64 px tile: `water-400ft-glitter` 38.0/255,
`water-25ft` 29.2/255, `water-3m` 3.8/255. Everything else is at or under the
floor — and the floor needs stating rather than assuming, because four shots
with no water in them at all (`forest-line-highsun` 0.7, `canopy-backlit-lowsun`
0.6, `cdlod-transition` 1.0, `motion-banked-turn` 1.0) put candidate-to-
candidate noise on this machine at about 1/255, the two motion shots highest
because their gate is temporal. `cruise-sun-30` at 1.5/255 and `cruise-horizon`
at 0.8/255 do contain distant water and the diffs lie on it, but that is not
separable from run noise and they were NOT promoted on it.

Left drifting deliberately, with their SSIM against committed baselines in this
candidate: `night-moonlit` 0.9904, `cruise-sun-30` 0.9887, `winter-noon` 0.9894,
`canopy-backlit-lowsun` 0.9875, `coast-10km-lowsun` 0.9926, `cruise-horizon`
0.9928, `forest-line-highsun` 0.9952, `ground-2m-lowsun` 0.9985, `slant-10km`
0.9985, `hills-dusk-glint` 0.9985, `night` 0.9987,
`terrain-material-1600ft-down` 0.9989. **None of these is W-11.** They are the
shots the ground-texture wave did not re-promote at `0ed07bc`, plus ordinary
drift; `night-moonlit` is the proof, reading 0.9904 here and 0.9905 on the base
arm with none of the glitter code in the tree, and bit-identical between arms at
an identical list. A red SSIM gate on those shots is not evidence about the
change in front of you until a later full candidate absorbs them.

Two provenance notes on the new row. Its `inventoried` figure (248.4 MiB) is
measured under the CURRENT inventory definition and is not comparable with the
older rows above, which predate it. And `water-400ft-glitter` carries a
draw-call ceiling of 234 but no delivery floors: draw counts are
host-independent — the same 234 came back on both arms of the A/B with the
whole water shading replaced underneath, and in the candidate — while frame
timings are not, and this host is not the pinned reference adapter. It is
declared in `DECLARED_DRAW_ONLY` and `DECLARED_PROBES` in
`tests/delivery-floors.test.ts`, and in `PERF_CAPTURE_CEILING_PROVENANCE`'s
`unmeasuredShots`, each with that reason. Its floors want three runs on the
reference host.

Suites at the promotion: Node 1933 passed / 1 skipped over 202 files,
typecheck and lint clean, and the GPU suite **134/135 under contention,
135/135 quiet**. The one failure is `tests/gpu/ground-cover-compute.test.ts`
on a timing assertion (`measured 0.2530 ms vs seed 0.06 ms`), a ground-cover
placement budget with no water in it. It passed 135/135 in the exclusive perf
window on this same `src/`, passes in isolation, and fails only in a full run
while two other sessions are working the same GPU. Recorded here so it is not
rediscovered as a regression: it is contention on a shared machine, and a
timing gate is the thing that measures it.

The candidate is stamped not approvable, and that is unrelated to this change:
the delivery floors ran host-honest and three vegetation shots failed them
(`forest-line-highsun` 92.2 vs 103, `canopy-backlit-lowsun` 92.5 vs 103 and
draws 249 against a stale 246 ceiling, `hills-dusk-glint` p95 12.5 vs 11.8).
Those are the known stale-on-this-host rows.

### Promotion 2026-09-22 — the aircraft wave, on the world-only perf cockpit rig

All thirty-nine baselines promoted from candidate `2026-09-22T05-40-42.875Z`, captured on this
unpinned M2 Pro at House-Keeping `bcfbea5`. Thirty-one existing PNGs replaced
and **eight promoted for the first time**, with their `comparesToBaseline`
flags flipped in the same commit — a baseline nothing compares against passes
forever and shows nothing, which `tests/perf-baseline-policy.test.ts` now
fails on.

**The run.** 39 of 39 shots had their gates evaluated. 45 gate failures, and
**every one a delivery floor** — no draw-call ceiling, no visual, temporal,
renderer-error, settling or lit-region gate failed. **Delivery floors were NOT
re-pinned**: they fail on this host under any tree, and a clean
reference-adapter run is still owed before any floor moves. Cold start is on
file for this host for the first time at **2124.8 ms against its 2300 ms
deadline** — inside the reference-host budget with 175 ms to spare.

**Three candidates exist and only the last is promoted.** `2026-09-22T04-19-31.104Z`
(51 failures) and `2026-09-22T04-30-10.407Z` (47) were captured before the
world-only rig; both are retained as the evidence behind the temporal and
draw-call findings below, and neither is a baseline.

**Twelve cockpit draw-call ceilings re-pinned DOWN to their exact measured
counts, no margin** (follow-up commit at bed4d51, after this promotion). The
world-only rig draws no aircraft mesh in the cockpit shots and removed
**exactly 151 draw calls from every one of them**, which had left each ceiling
147-189 above what the shot measures — slack no plausible regression could
breach, and the draw-call twin of a baseline nothing compares against.

    high-10000ft-down             223 -> 72     veg-seam-1600ft-oblique   255 -> 108
    ground-2m-lowsun              268 -> 121    veg-seam-near-500ft       263 -> 116
    canopy-1200ft                 260 -> 113    terrain-material-1600ft   282 -> 93
    grove-forest-2m               267 -> 120    horizon-shadow-far-ann.   238 -> 91
    grove-meadow-2m               281 -> 134    canopy-backlit-lowsun     246 -> 102
    water-3m                      237 -> 90     water-400ft-glitter       234 -> 87

**They are the measurement, not the measurement plus headroom.**
`tests/delivery-floors.test.ts` requires exactly that — *"this quantity is
host-independent, so headroom above the measurement is growth nobody has
justified"* — and `drawCallCeilingFrom` requires three runs that agree and
refuses to take a maximum. A first attempt at measured + 4 was reverted when
that test caught it.

**Three runs, and all thirty-nine counts agreed across all three**: the
promotion candidate `2026-09-22T05-40-42.875Z` plus two full captures on the
merged tree. Not two — the third was needed, and the host-independence claim
was exercised rather than asserted. The two new captures were run NORMAL rather
than rebaselining, so they also verified that this promotion reproduces:
**every one of the 36 compared shots passed its SSIM gates against the
baselines promoted above**, lowest 0.9986, nineteen at exactly 1.000, and every
failure in both runs was a delivery floor.

They must be FULL captures. A filtered run does not reproduce a shot's draw
count (`page-thrash-turn` reads 253 in a full run and 259 in a single-shot
one), for the same reason it cannot supply a hitch count: the shot arrives with
a different streaming history.

`PREVIOUS_DRAW_CALL_CEILINGS` is refreshed for the twelve in the same commit
and every raise that named them is spent into it, so the ratchet compares
against what ships. **`canopy-backlit-lowsun`'s +3 vegetation overrun — 249
against a 246 ceiling, carried as a known exception since 2026-09-03 — folds
into its measured 102 and is retired.** It was never the cockpit's: with the
cockpit's 151 draws gone it still sat 3 higher against its old ceiling than the
other eleven, which is the same conclusion reached twice by different routes.

**Per shot, the cause of its difference from the baseline it replaces.**
A = the Cessna's crown-seam normal weld, a shading change down the fuselage
top, which only chase shots can see. B = the perf cockpit rig became
world-only, so the fourteen cockpit shots lost their entire foreground.
C = terrain far field with the far-sward dial ON, Jason's choice. D = water
skyline. E = the chase rig's bank-blended re-centring, which by measurement
moves only the two banked shots. NEW = promoted for the first time, judged on
its own merits because no before exists.

- `approach-500ft` — A+C
- `slant-10km` — A+C
- `high-10000ft-down` — B+C
- `reference-viewport` — A+C
- `cruise-horizon` — A+C
- `winter-noon` — A+C
- `night` — A+C
- `night-moonlit` — A+C
- `dusk-mesopic` — NEW+A+C
- `motion-banked-turn` — E+C
- `page-thrash-turn` — E+C
- `cdlod-transition` — C
- `cruise-sun-30` — A+C
- `forest-500ft-sunbehind` — A+C
- `coast-10km-lowsun` — A+D+C
- `ground-2m-lowsun` — B+C
- `canopy-1200ft` — B+C
- `runway-on-approach` — A+C
- `water-25ft` — A+D+C
- `grove-forest-2m` — B+C
- `grove-meadow-2m` — B+C
- `hills-dusk-glint` — A+C
- `mountain-close` — A+C
- `forest-line-highsun` — A+C
- `cliff-60m` — A+C
- `water-3m` — B+D+C
- `veg-seam-1600ft-oblique` — B+C
- `veg-seam-near-500ft` — B+C
- `terrain-material-1600ft-down` — B+C
- `horizon-shadow-far-annulus` — B+C
- `canopy-backlit-lowsun` — B+C
- `golden-hour` — NEW+A+C
- `blue-hour` — NEW+A+C
- `night-beacon-offset` — NEW+A+C
- `apron-hangar-variety` — NEW+B+C
- `sunset-sunward` — NEW+A+C
- `approach-lights-outboard` — NEW+A+C
- `lake-island-piercing` — NEW+B+C
- `water-400ft-glitter` — B+D+C

**Cause E is confined to two shots and both are evidence-only.**
`motion-banked-turn` (45°) and `page-thrash-turn` (60°) are the only shots in
the table with any bank, and both gate temporally rather than on their PNG.
Their per-shot `minConsecutiveSsim` floors were re-pinned from 0.67 to 0.60 and
0.75 respectively before this capture — see
`docs/findings/TEMPORAL_FLOORS_2026_09_21.md` for the bisect that found the
0.0300 step and the fps-versus-metric control that proved the metric
deterministic.

### Promotion 2026-09-23 — eleven movers from the end of the wave

Eleven baselines replaced from candidate `2026-09-23T02-15-57.995Z`, captured on
this unpinned M2 Pro at House-Keeping `e9d902d`. The other twenty-eight are
unchanged: against the old baselines they read rgbSsim 0.9973 or higher.

**The run.** 39 of 39 shots had their gates evaluated. 58 gate failures across 20
shots, **every one a timing gate**: measured and wall-clock fps floors, p95
interval, worst frame and p999 on the two banked shots, the two strict delivery
gates, and `page-thrash-turn`'s hitch count, 4 against a ceiling of 3. No
visual, temporal, draw-call, renderer-error or readback gate failed.
**Delivery floors were NOT re-pinned**, as at every promotion on this host.
Cold start reached ready at **2229.1 ms against its 2300 ms deadline**.

**The A/A floor.** A second full capture on the same tree, run normally, was
compared shot by shot with the candidate. On every shot the mean difference is
0.024/255 or less (worst `forest-line-highsun`) and 0.08 % of pixels or fewer
move by more than 8/255. Draw counts agree on 38 of 39 shots.
`terrain-material-1600ft-down` read 87 in the candidate and 93 in the second
run. It read 93 in the nine full captures before them, so the 87 is the shot's
first disagreement; it stays at its ceiling of 93 and is under investigation.
*(Resolved at the 2026-09-23 re-pin below: 87 on three pinned runs, the
wildlife pin, as predicted.)*

**The sea is pinned, measured.** No sea moved more than 0.011/255 between the
two runs. Their shots' own streaming histories were 16,620 frames apart: the
candidate took the 360-frame minimum on 35 shots, and the normal run 31,560
frames in total. The unpinned ocean split runs by 0.12-0.40/255, and the
falsifier registered before the capture (any sea at 0.1 or more) did not fire.
Off the sea, what moves is D-5, the splat queue, FI-5 and the trainer's
recent frame and roof changes, and all of it reproduces in the A/A.

**Per shot, the cause of its difference from the baseline it replaces.**
S = the queued splat bake (`58c1eaa`): after a season change the forest had been
drawn as sand, and the old baselines had captured that beige floor. T = D-5, more
of the meso band on alpine turf (`dd7c18d`). F = FI-5 (`e9d902d`): hand-built mip
chains are kept and sampled instead of Babylon's, which changes crown-edge
coverage and aircraft paint by single pixels. R = the chase camera's bank-blended
height (`0162a6a`), which reframes only the banked shots. O = the ocean's cascade
phase pinned for captures (`a4c8762`), which puts every water shot in one phase
class.

- `apron-hangar-variety` — S+F: the sand detector reads 20.1 % -> 0.0 %, with no seam where the old page edge ran
- `approach-lights-outboard` — S+F: sand 11.2 % -> 0.0 %
- `high-10000ft-down` — T+F: near-band contrast 11.82 -> 13.00, the D-5 figure recorded at its merge; rock, snow and ridgelines unchanged
- `motion-banked-turn` — R: evidence-only, gated temporally
- `page-thrash-turn` — R: evidence-only, gated temporally
- `water-3m` — O+F: its sea moves 0.37/255 against the old baseline, because the pin changes its cascade class; A/A sea 0.0064, whole frame 0.0041
- `water-25ft` — O+F: sea 0.19/255 against the old baseline, for the same reason; A/A sea 0.0049, whole frame 0.0030
- `water-400ft-glitter` — O+F: A/A sea 0.0107, whole frame 0.0079
- `coast-10km-lowsun` — O+F: A/A sea 0.0096, whole frame 0.0017
- `hills-dusk-glint` — O+F: A/A sea 0.0043, whole frame 0.0010
- `lake-island-piercing` — O+F: A/A 0.0000

**Owed: twenty draw-call ceilings sit above what their shots measure.**
Eighteen chase shots read exactly 14 draws under their ceilings,
`coast-10km-lowsun` 16 and `mountain-close` 55. The counts are identical in
every full capture since 2026-09-22, both runs of this window included, and the
2026-09-22 promotion re-pinned only the twelve cockpit shots. They are not
re-pinned here: a ceiling is pinned from three full runs that agree, on the tree
going forward. Those three runs come at the next churn point, the wildlife
capture pin, which moves birds out of some frames. Thirteen of the fourteen are
named: `da86f47` made the trainer's interior cockpit-only, eleven meshes and
among them the one shadow caster, which is 11 main-pass and 2 cascade draws.
The rest (1 on every chase shot, 3 on `coast-10km-lowsun`, 42 on
`mountain-close`) are world-side, and a short bisection names them before the
re-pin.

### Re-pin 2026-09-23 — twenty-one draw-call ceilings at the wildlife-pin churn point

Twenty-one `drawCallCeiling` values re-pinned at House-Keeping `bd7a584` from
three full captures that agree on every shot's count: the REBASELINE candidate
`rebaseline-candidates/2026-09-23T04-50-34.261Z/` and two normal captures of the
same tree (2026-09-23T04-57-55.457Z and 05-05-13.308Z). With the ocean cascade
and the wildlife pinned, the three agreed on pixels too: 0.003/255 mean at most
on any shot, no pixel moving by more than 8/255. All three evaluated 39 of 39
shots, and every gate failure (40, 40 and 32) was a delivery floor.

**Why they were slack.** Twenty ceilings had sat above their shots' counts in
every full capture since 2026-09-22: the eighteen chase shots by 14,
`coast-10km-lowsun` by 16 and `mountain-close` by 55. Nothing went red, because
the capture gate is `<=`. A draw-call bisection with the wildlife switched off
(three shots, nine arms, differences of arms only) named the causes:

- `da86f47`: the trainer's interior made cockpit-only, 11 meshes = 11 main-pass
  + 2 cascade draws. -13 on the eighteen chase shots and coast.
- `1bf4209`, the mountains wave: -2 on `coast-10km-lowsun`, -56 on
  `mountain-close`.
- -1 on every shot from a span of 22 non-merge `src` commits the arms did not
  isolate: reachable from `4a4390f^1` but not from `1bf4209`, `c0b1356^1` or
  `91b10a2`. The trainer-glazing trio `9e4cd74`, `6a1e498` and `d20a00f` is the
  likely cause.
- `4a4390f`, `c0b1356` and `91b10a2`: 0 on all three shots.
- The pairs summed to the endpoint difference to within that -1 (-1 / -3 / -57
  from `1510b74` to `da86f47^1`, for reference-viewport / coast /
  mountain-close).

So the chase shots' -14 is -13 - 1 and coast's -16 is -13 - 2 - 1, both exactly.
`mountain-close` moved -55 against -70 from the arms; the remaining +15 is
wildlife near-LOD, history-dependent before the pin, and is not measured.
`terrain-material-1600ft-down` moves 93 -> 87 for the same reason: deer and boar
draw near-LOD parts only within 460 m, so its count depended on where the animals
had wandered, and 87 is the count predicted for every pinned run.

**The ratchet.** `PREVIOUS_DRAW_CALL_CEILINGS` is refreshed to the new counts for
the twenty shots it holds. That spends every entry in `DRAW_CALL_RAISES`, since
each named only those twenty (`csm-cascade-decoupling`, `since-pin-global`,
`since-pin-airfield`, `airfield-lighting`, `bloom`,
`tree-lod-residency-lead`); their growth is inside the new snapshot. Every
ceiling tightened; none rose.

An empty raise list made two of `tests/delivery-floors.test.ts`'s guards
unsatisfiable: both required SOME live raise. They are replaced by a coupling
(the list is empty if and only if no committed ceiling exceeds its previous) and
a synthetic positive control that runs the same accounting checks on
constructed states and asserts each fails where it should. Mutations confirmed
it: disabling the checks turns the control red; a still-needed raise missing
fails through the ratchet and the coupling; a raise added while nothing is
raised fails through the coupling, the accounting and the outlived check.

### Promotion 2026-09-23 — all thirty-nine at the wildlife-pin churn point

All 39 baselines replaced, byte-identical (sha1-verified), from candidate
`tests/perf/artifacts/rebaseline-candidates/2026-09-23T04-50-34.261Z/`, captured at House-Keeping `bd7a584`. The candidate and two normal
captures of the same tree agree on every shot to 0.003/255 mean, with no pixel
moving by more than 8/255 and identical draw counts in all three runs (the
three-run A/A). The water engineer accepted the 30 shots
`scripts/wildlife-shot-birds.mts` gives birds (24 with a bird in frame once the
wildlife is pinned, 6 that can show one only unpinned). Every clearly visible
bird sits at its predicted pixel; the faint ones were confirmed statistically
(candidate differs from baseline at 59 % of the 188 predicted spots against 7 %
at controls 15 px away); and the falsifier, a bird where none is predicted, fired
0 times across 37 inspected strong changes.

**All thirty-nine, not only the bird shots**, so the baselines are one
generation again. 28 came from `19216c3` and carry work merged since
and never promoted, because those shots stayed inside their gates; leaving some
of them behind would keep a two-generation set for no reason.

**Each row says what moved.** Pixels moving by 3 levels or more against the old
baseline, the water review's threshold, because a gull on a light sky moves only
3-8 levels. They are mapped against the predicted bird positions (14 px radius)
and, in the chase shots, the trainer's screen box, which is approximate on the
two banked shots (`tests/perf/artifacts/rebaseline-candidates/2026-09-23T04-50-34.261Z/moved-map.png`, drawn at > 8 levels, and
`tests/perf/artifacts/rebaseline-candidates/2026-09-23T04-50-34.261Z/promotion-split.json`, at both thresholds).

- F = FI-5 (`4d8b2a8`): crown-edge coverage from hand-built mip chains. The
  terrain engineer confirmed the crown speckle is FI-5, and that the splat queue
  (`ce48b1a`) and D-5 (`2e3b281`), which also postdate these baselines, moved
  none of these shots.
- C = the Cessna's cabin. The trainer's 70 meshes were hashed one by one under
  NullEngine at the old baselines' capture tree `bcfbea5` and at `bd7a584`, and
  exactly two differ: `trainer-cabin-roof` (16 -> 84 vertices, the roof as a
  closed solid) and `windscreen-center-frame` (76 -> 779), from `1c79768`,
  `6c66ac0` and `b760485`, merged as `37d24da`. No other trainer mesh, the
  glazing included, changed. The old baselines show a solid glazed cabin where
  the candidate shows the frame and the interior through the glass.
- O = the ocean's cascade phase pinned for captures (`a4c8762`), which also
  postdates the `19216c3` baselines: sea glints and foam move wherever sea is in
  frame. "World" in the catch-up rows is F, plus O where there is sea.
- W = the wildlife pin.

Catch-up, baselines from `19216c3`:

- `approach-500ft` — catch-up since 19216c3, 14744 px >= 3/255: aircraft 2467 (C), world 12261 (F/O), birds 16 (W)
- `blue-hour` — catch-up since 19216c3, 2021 px >= 3/255: aircraft 834 (C), world 1178 (F/O), birds 9 (W)
- `canopy-1200ft` — catch-up since 19216c3, 11362 px >= 3/255: world 11063 (F/O), birds 299 (W)
- `canopy-backlit-lowsun` — catch-up since 19216c3, 8247 px >= 3/255: world 8221 (F/O), birds 26 (W)
- `cdlod-transition` — catch-up since 19216c3, 3016 px >= 3/255: aircraft 724 (C), world 2292 (F/O); no birds
- `cliff-60m` — catch-up since 19216c3, 1403 px >= 3/255: aircraft 1002 (C), world 401 (F/O); birds only unpinned, so its old baseline's birds are not separable (W, accepted by the water engineer)
- `cruise-horizon` — catch-up since 19216c3, 3225 px >= 3/255: aircraft 739 (C), world 2486 (F/O); no birds
- `cruise-sun-30` — catch-up since 19216c3, 10878 px >= 3/255: aircraft 796 (C), world 10082 (F/O); no birds
- `dusk-mesopic` — catch-up since 19216c3, 8505 px >= 3/255: aircraft 1697 (C), world 6799 (F/O), birds 9 (W)
- `forest-500ft-sunbehind` — catch-up since 19216c3, 9272 px >= 3/255: aircraft 2479 (C), world 6739 (F/O), birds 54 (W)
- `forest-line-highsun` — catch-up since 19216c3, 11926 px >= 3/255: aircraft 2556 (C), world 8872 (F/O), birds 498 (W)
- `golden-hour` — catch-up since 19216c3, 8680 px >= 3/255: aircraft 1816 (C), world 6856 (F/O), birds 8 (W)
- `ground-2m-lowsun` — catch-up since 19216c3, 4113 px >= 3/255: world 4113 (F/O), birds 0 (W)
- `grove-forest-2m` — catch-up since 19216c3, 568 px >= 3/255: world 568 (F/O); birds only unpinned, so its old baseline's birds are not separable (W, accepted by the water engineer)
- `grove-meadow-2m` — catch-up since 19216c3, 4986 px >= 3/255: world 4958 (F/O), birds 28 (W)
- `horizon-shadow-far-annulus` — catch-up since 19216c3, 801 px >= 3/255: world 801 (F/O); birds only unpinned, so its old baseline's birds are not separable (W, accepted by the water engineer)
- `mountain-close` — catch-up since 19216c3, 1813 px >= 3/255: aircraft 1097 (C), world 716 (F/O); birds only unpinned, so its old baseline's birds are not separable (W, accepted by the water engineer)
- `night` — catch-up since 19216c3, 1054 px >= 3/255: aircraft 915 (C), world 135 (F/O), birds 4 (W)
- `night-beacon-offset` — catch-up since 19216c3, 8349 px >= 3/255: aircraft 1719 (C), world 6579 (F/O), birds 51 (W)
- `night-moonlit` — catch-up since 19216c3, 8356 px >= 3/255: aircraft 1738 (C), world 6567 (F/O), birds 51 (W)
- `reference-viewport` — catch-up since 19216c3, 11839 px >= 3/255: aircraft 3069 (C), world 8770 (F/O), birds 0 (W)
- `runway-on-approach` — catch-up since 19216c3, 11283 px >= 3/255: aircraft 840 (C), world 10443 (F/O), birds 0 (W)
- `slant-10km` — catch-up since 19216c3, 7443 px >= 3/255: aircraft 1617 (C), world 5826 (F/O); no birds
- `sunset-sunward` — catch-up since 19216c3, 3091 px >= 3/255: aircraft 980 (C), world 2104 (F/O), birds 7 (W)
- `terrain-material-1600ft-down` — catch-up since 19216c3, 52 px >= 3/255: world 52 (F/O); no birds
- `veg-seam-1600ft-oblique` — catch-up since 19216c3, 15567 px >= 3/255: world 15458 (F/O), birds 109 (W)
- `veg-seam-near-500ft` — catch-up since 19216c3, 12708 px >= 3/255: world 12708 (F/O); no birds
- `winter-noon` — catch-up since 19216c3, 1788 px >= 3/255: aircraft 1024 (C), world 751 (F/O), birds 13 (W)

Recent, baselines from `35e03d3`:

- `approach-lights-outboard` — W + residual: birds 0 of 384 px >= 3/255, world 384
- `apron-hangar-variety` — W + residual: birds 43 of 72 px >= 3/255, world 29
- `coast-10km-lowsun` — residual only, no birds: 56 px >= 3/255, world 56
- `high-10000ft-down` — residual only, no birds: 9 px >= 3/255, world 9
- `hills-dusk-glint` — W + residual: birds 220 of 291 px >= 3/255, world 55, aircraft 16
- `lake-island-piercing` — residual only, no birds: 7 px >= 3/255, world 7
- `motion-banked-turn` — W + residual: birds only unpinned (its old baseline's), 200 px >= 3/255, world 133, aircraft 67
- `page-thrash-turn` — W + residual: its only change is an 80 px speck cluster at (803-835, 487-498), 55 px from the probe's three boar, on the 60-degree banked shot where the probe's chase-roll model is approximate; accepted by the water engineer as evidence-only, temporally gated
- `water-25ft` — W + residual: birds only unpinned (its old baseline's), 120 px >= 3/255, world 102, aircraft 18
- `water-3m` — W + residual: birds 14 of 139 px >= 3/255, world 125
- `water-400ft-glitter` — W + residual: birds 6 of 204 px >= 3/255, world 198

## Re-promotion 2026-10-13 — sharper scenery (final sharpen + ground grain)

Two changes from the "Sharper scenery" thread, both visual and both perf-sensitive. **Neither has been timed yet**: the thread had no GPU, its screenshots come from SwiftShader in headless Chromium (good for looking at frames, meaningless for timing), and the hosted macOS runner that captured the full list below does not gate delivery. Draw counts and visual gates are measured; the costs below are expected, to be confirmed by the first capture that can time them.

- **Final RCAS sharpen** (`lighting/SharpenPass.ts`, profile `sharpenAmount`). Expected cost at tier 1: one extra full-screen pass at the render raster (~0.68 Mpx at the canonical 1280x720 shot, ~1.5 Mpx at the reference panel), five texture taps per pixel, plus one 4 B/px LDR target. **Draw calls: +1 per frame on every tier-1 shot**, re-pinned below as the uniform `DRAW_CALL_RAISES` entry `final-sharpen`. Estimate rows: tier 1 rises by 6.6 MiB at the 2560x1440@2 viewport (the LDR target), tiers 2/3 by 10.5/17.6 MiB; tier 0 is unchanged because the pass is off there.
- **Ground grain** (`terrain/GroundGrainSynthesis.ts`, read in `TerrainSurfacePlugin`). One more layer in each terrain material array (index 10, after the ten materials), built in the synthesis worker only where `terrainGroundPatchwork` is on (tiers 1-3). Memory: +1/10 of the material-array row, 2.67 MiB at 512² with mips. Fragment cost on terrain: up to three extra array fetches from array A and two from array B (all `textureSampleGrad`, isotropic: `GROUND_GRAIN_ANISOTROPY_LIMIT` = 1 against the materials' 16; `textureSampleLevel` at the footprint's mip since 2026-10-24, see "The final sharpen, fused into FXAA"), each skipped where it cannot show (the relief past mip 6, the tone past mip 8.5, everything under 3 m of sea), and a few dozen ALU, inside a uniform branch on `terrainSurfaceTuning.z` that is off at tier 0. No draw-call change. Startup: one more ~0.3-0.5 s worker job, off the main thread.

**First full capture, 2026-10-12** (PR #20's macOS run 38217280044 at `3d96334`, hosted runner, so no delivery gate). Draw calls: all 32 shots with a ceiling read exactly ceiling + 1, which is the sharpen's quad; staged as `final-sharpen` in `MEASURED_DRAW_DELTAS`. Visual gates: 24 shots fail, every one with ground in frame (lowest whole-frame SSIM: `lake-island-piercing` 0.824, `terrain-material-1600ft-down` 0.851, `cliff-60m` 0.877, `high-10000ft-down` 0.884, `mountain-close` 0.897). The 15 shots dominated by water, night or sky still pass (moved, but inside their gates): `night`, `night-moonlit`, `night-beacon-offset`, `dusk-mesopic`, `blue-hour`, `golden-hour`, `sunset-sunward`, `water-3m`, `water-25ft`, `water-400ft-glitter`, `coast-10km-lowsun`, `canopy-backlit-lowsun`, `motion-banked-turn`, `page-thrash-turn`, `cdlod-transition`. All thirty-nine were re-promoted from one reviewed capture, below.

**Draw re-pin, 2026-10-12.** Three full macOS captures on the hosted runner agree on every shot: runs 38217280044 (`3d96334`), 38221252437 (`4ae62d1`) and 38263651854 (`5dc696c`) each read all 32 ceiling shots at exactly their committed ceiling + 1, no shot at +0 or +2. So every `drawCallCeiling` in `scripts/perf-capture.mts` and every `DRAW_CALL_SAMPLES` row moves up by one, and `final-sharpen` leaves `MEASURED_DRAW_DELTAS` for a uniform `DRAW_CALL_RAISES` entry (delta 1, commit `ea99c02`) naming the 20 shots in `PREVIOUS_DRAW_CALL_CEILINGS`. The other twelve moved by the same +1 but sit outside the raise mechanism, as `deliveryFloors.mts` explains. `PREVIOUS_DRAW_CALL_CEILINGS` is not refreshed, so the raise stays visible until the next snapshot spends it.

**Timed on SwiftShader, 2026-10-12** (the cloud A/B, `npm run perf:ab` from the "Cloud performance testing" branch, 16 ABBA rounds per shot, GPU time = sum of pass timestamps; SwiftShader over-weights texture filtering, so read these as an upper bound on the shape of the cost, not as Mac milliseconds):

| arms | `cruise-horizon` | `ground-2m-lowsun` |
| --- | --- | --- |
| main → first cut (`4ae62d1`) | +13.7% (+10.4 to +15.7) | +9.0% (+7.1 to +10.9) |
| first cut → grain switched off at runtime | -8.8% (-11.8 to -6.5) | — |
| first cut → `sharpenAmount` 0 (A/A override) | -1.6% (-3.4 to +1.5), within noise | — |
| first cut → grain anisotropy capped at 4 | -2.7% (-4.5 to -0.8), frames SSIM 0.9999 | -3.0% (-5.4 to -0.7), SSIM 0.9999 |
| capped → grain without its two normal reads (probe, not shipped) | -1.7% (-5.0 to +1.1) | — |
| main → cap-4 branch (`5dc696c`) | +8.0% (+5.9 to +9.9) | +6.4% (+4.0 to +8.9) |
| main → isotropic reads + relief fade | +4.0% (+1.5 to +6.3), inconclusive in the cloud | +1.7% (+0.1 to +3.3) |
| cap-4 branch → + tone and seabed fades too (pixels only) | frames SSIM 0.9985, 159 px past 4/255 | SSIM 0.9991; `water-25ft` 0.9999 |

So the grain is the cost and the sharpen is noise; the cost is spread across the five fetches and their arithmetic rather than one of them, and the normal reads were kept because dropping them changed 35% of the frame for 1.7%. All of it lands in the scene pass.

**The A/B gate, 2026-10-13.** Once the cloud A/B gated renderer PRs (#21), GitHub's Linux runner read the cap-4 branch at `7eca23c` as a regression: GPU time +7.0% on `approach-500ft`, +8.5% on `cruise-horizon` and +7.3% on `water-25ft`, each interval about ±0.3%. The water shot pays because the seabed under the sea is shaded before the water covers it. So the grain now reads isotropically, and each fetch is skipped where its mips have already averaged it flat or where 3 m of sea hides it. Frames moved by 0.1/255 against the cap-4 grain (table above). On `d6661b5` the same gate (perf-ab run 38363925244) read all five shots as the same as main: GPU time +1.0% on `approach-500ft`, +1.5% on `cruise-horizon`, +1.1% on `water-25ft`, +2.5% on `ground-2m-lowsun` and +4.3% (+4.0% to +4.6%) on `forest-500ft-sunbehind`, the closest to the limit. The macOS runner's advisory A/B passed on all five as well.

**All thirty-nine baselines promoted 2026-10-13, from the hosted macOS runner.** Source: PR #20's gated capture at `96d09ef` (gpu-tests run 38295338700, artifact `perf-capture-38295338700-1`, zip sha256 `3f5a22b92cec9b40…`). It is an ordinary capture under `VITE_PERF_UNPINNED_HOST=1`, not an APPROVABLE `rebaseline-candidates/` directory, because the harness refuses a candidate on an unpinned host; Jason chose to promote from CI's frames. That is sound for pixels, though not for timing, because the runner reproduces the committed frames rather than approximating them:

- **Against the committed baselines.** Main's own capture on the same runner at `c1b5491` (run 38287881265) reads 0.000-0.019/255 mean absolute difference and no pixel past 4/255 on fourteen shots. The other twenty-five carry 0.07-0.27/255 of main's own drift since `2cecbad`, on the trainer's panel lines and on far ridge edges (0.6-1.9% of pixels), which passes every gate on main and is folded in here as catch-up.
- **Run to run.** The PR's captures at `5dc696c` (run 38263651854) and `96d09ef`, the same rendering code, agree to at most 0.025/255 with no pixel past 4/255 on all thirty-nine.

**Reviewed frame by frame** against main's capture on the same runner. Grass, dirt and forest floor gain a mottled grain, rock reads crisper, and tree and aircraft edges are slightly sharper. No shot gains a black or blown-out pixel, and no tiling shows at 1,600 or 10,000 ft. Mean luminance moves by less than 0.5/255 everywhere except `grove-forest-2m` (-2.4, darker patches on the forest floor), `lake-island-piercing` (+1.2) and `cliff-60m` (-1.0). By shot, main → this PR on the runner:

| shots | mean abs diff /255 | pixels past 4/255 |
| --- | --- | --- |
| the 24 that failed: `lake-island-piercing`, `cliff-60m`, `terrain-material-1600ft-down`, `high-10000ft-down`, `mountain-close` (largest five) | 1.07-6.42 | 4.9-76.8% |
| the 12 compared shots that passed: night, dusk, golden hour, water, coast, backlit canopy | 0.23-1.23 | 0.1-8.3% |
| the 3 blind baselines: `motion-banked-turn`, `page-thrash-turn`, `cdlod-transition` | 0.99-1.35 | 9.3-14.4% |

**Why all thirty-nine rather than the 24 that failed.** The sharpen touches every frame, and some passing shots now sit at the edge of their gate (`golden-hour` whole-frame SSIM 0.9865 against 0.985), so a partial promotion would leave the next change on those shots failing for this PR's reason. The last promotion, at the wildlife-pin churn point (2026-09-23), was also a whole set.

**Delivery floors were NOT re-pinned**: the hosted runner does not gate frame delivery, so this PR's frame time on the reference adapter is still unmeasured.

What a re-baseline needs to confirm: the tier-1 frame p95 on the terrain-heavy shots (`terrain-material-1600ft-down`, `veg-seam-1600ft-oblique`, `high-10000ft-down`, `approach-500ft`) moves by no more than the sharpen pass plus five fetches, and every shot's draw count rises by exactly one (now pinned, above).

## Re-promotion 2026-10-17 — sunset sky (each point's own sun)

PR #22 lights each point of the haze and the sky with the sun that point sees, instead of one sun transmittance taken at the camera. At a low sun this turns main's brown and pink smog into a blue zenith over a gold horizon. Across sun sines 0.45-0.55 (26.7-33.4°) every path's sun blends to the camera's, so above that window noon frames are main's again.

- **What it costs.** All of it is in the shared aerial block (`atmosphere/AerialPerspective.ts`), which the sky dome, terrain, ocean, rivers, the cloud composite and light points all include. Each species' sun is evaluated at its scattering centroid: a Chapman column for both species from one exponential, an ozone slant, and the Earth's curvature tilt by series terms. That is two evaluations per fragment for a surface or a cloud, and four for the sky (a two-point Gauss-Laguerre pair per species). A real GPU skips them above the window, where a uniform branch takes the camera's sun; SwiftShader does not skip them. No new uniforms, textures, passes or memory.
- **Draw calls unchanged**: all 32 ceiling shots read exactly their ceiling (run 39005416151).

**The A/B gate** (perf-ab on GitHub's Linux runner, SwiftShader GPU time against main):

| head | `approach-500ft` | `cruise-horizon` | `forest-500ft-sunbehind` | `ground-2m-lowsun` | `water-25ft` |
| --- | --- | --- | --- | --- | --- |
| `4d4a7ab` (run 38993059756): per-point sun at every sun height | +2.9% | +4.7% | +4.3% | +3.0% | +3.9% |
| `42bf9f6` (run 38997844652): the sky's pair switched off above 30° on a uniform | | +5.1%, failed | | | |
| `d19b591` (run 39001012484): the haze's shortcuts switched on uniforms too | +7.7% | +10.1% | +9.3% | +7.5% | +9.9% |
| `e1407b8` (run 39005416166): no runtime branches, cheaper evaluations | +1.4% | +4.5% | +2.4% | +1.9% | +3.7% |

The lesson: **SwiftShader executes both sides of every branch, a uniform's included** (a zero-trip loop as well, measured on a compute microbenchmark). So the 30° switches, written to save work on a real GPU, added the shortcut's work to the full evaluation on CI. `e1407b8` removes every runtime branch inside the per-point sun: the sky's pair is a literal, the Chapman column selects its side, and series terms and squarings replace trig and `pow`. One uniform branch is left around it (`cameraWeight < 1.0`): above the window it saves the whole evaluation on a real GPU, and SwiftShader, which runs it anyway, pays nothing extra for it. It also shares one exponential between the two species' densities, since their scale heights split 24 km into 3 and 20. The macOS runner's advisory A/B on the same head read +0.8% to +2.2%, all SAME.

**All thirty-nine baselines promoted 2026-10-17 from the hosted macOS runner**, the same way as 2026-10-13. Source: PR #22's capture at `e1407b8` (gpu-tests run 39005416151, artifact `perf-capture-39005416151-1`, zip sha256 `c37db853dc412c29…`). Jason approved the low-sun look from the PR's before/after frames. Reproducibility: every shot with a sun below the window is identical, at 0.012/255 or less, to the capture at `42bf9f6` (run 38997844652), whose per-point sun there is the same math before the cost rewrite.

By shot, committed baselines → this capture:

| shots | mean abs diff /255 | pixels past 4/255 |
| --- | --- | --- |
| the largest five, all low sun: `hills-dusk-glint`, `coast-10km-lowsun`, `water-400ft-glitter`, `water-25ft`, `winter-noon` | 17.5-21.8 | 95-99.9% |
| the other shots with a sun below 33°: `water-3m`, `golden-hour`, `forest-500ft-sunbehind`, `horizon-shadow-far-annulus`, `canopy-backlit-lowsun`, `grove-meadow-2m`, `ground-2m-lowsun`, `mountain-close`, `cruise-sun-30` | 3.8-14.0 | 69-99.9% |
| the high-sun shots: approach, cruise, terrain, vegetation, airport | 0.24-1.82 | 0.06-9.2% |
| `night-moonlit`, `night-beacon-offset`: the moon's light through the same per-point column | 1.06 | 20% |
| `night`, `blue-hour`, `sunset-sunward`, `dusk-mesopic` | 0.03-0.32 | 0.34% or less |

**Why all thirty-nine.** The window changes every shot with a sun below 33°, and the high-sun shots carry the runner's own drift since `7eca23c`. Promoting from one capture keeps the set consistent, as on 2026-10-13.

**Delivery floors were NOT re-pinned**: the hosted runner does not gate frame delivery.

### The sea's visible-facet sky (`4218a35`), promoted 2026-10-20

The ocean reflects the mean ray of the facets a viewer sees (`waterFacetReflection`, WATER_FAR_FIELD_WGSL (5)) instead of the mirror ray, so a rough far sea reflects the sky some degrees up rather than the horizon haze. It adds a few square roots and divisions to the ocean fragment, and no texture reads, passes or uniforms.

**The A/B gate** at `4218a35` (perf-ab run 39009665124, against main, SwiftShader GPU time):

| shot | GPU | runner CPU | the same shot at `e1407b8` |
| --- | --- | --- | --- |
| `approach-500ft` | +1.6% | Intel Xeon 8573C | +1.4%, same CPU |
| `cruise-horizon` | +4.7% | AMD EPYC 7763 | +4.5%, same CPU |
| `forest-500ft-sunbehind` | +4.7% (+4.2% to +5.0%), inconclusive | AMD EPYC 9V45 | +2.4% on an EPYC 9V74 |
| `ground-2m-lowsun` | +1.5% | AMD EPYC 7763 | +1.9%, same CPU |
| `water-25ft` | +1.9% | AMD EPYC 7763 | +3.7% on an EPYC 9V45 |

On the same CPU model each shot moved by 0.4% or less; the two larger moves swap CPU models, and `water-25ft`, which shows the most sea, fell. So the sea's cost is within the runners' spread, and the 9V45 weighs the per-point sun more than the other models. `forest-500ft-sunbehind` is the shot closest to the 5% gate. The macOS runner's advisory A/B read +0.8% to +2.0%, all SAME.

**Draw calls unchanged**: the capture at `4218a35` (gpu-tests run 39009665122) matches `e1407b8`'s on every shot.

**All thirty-nine baselines promoted 2026-10-20** from that capture (artifact `perf-capture-39009665122-1`, zip sha256 `1106474601fd7fe8…385f`). Jason approved the sea from its before/after frames. Committed baselines → this capture:

| shots | mean abs diff /255 |
| --- | --- |
| `water-3m` (the white flecks on the far lake gone) | 3.18 |
| the other shots with sea in view: `motion-banked-turn`, `water-25ft`, `forest-line-highsun`, `forest-500ft-sunbehind`, `hills-dusk-glint`, `water-400ft-glitter` | 1.03-1.87, on sea pixels only |
| everything else | 0.56 or less |

Before promotion the capture failed the visual gates on `water-3m`, `water-25ft`, `forest-line-highsun` and `forest-500ft-sunbehind` (whole-frame SSIM 0.916-0.984 against 0.985), all from sea pixels.

**Delivery floors were NOT re-pinned**: the hosted runner does not gate frame delivery.

## Volcanic land, 2026-10-24

Volcanic fields are a height stage after the sand seas (`natural -> dunes -> volcanic overlay -> earthworks`, `src/world/volcanism.ts`). In a natural world they start 120 km from home, with one field guaranteed just past that; `?landforms=volcanic` forces a field 30 km out for review. The temperate core lists no site, so every pixel there is the overlay's identity. Steam has its own section above ("Volcanic steam").

### Site index (`VolcanicSiteIndexStream`)

The GPU reads the sites from ONE storage buffer, `terrainLandformData`, which page generation, the height pyramid, the sea-depth bake and the splat bake all bind. It lists the sites within 72 km of its centre in 4 km bins, relative to the landform core centre, so two indexes pack a site into the same bits and an in-place upload never changes a page both cover.

- **Memory.** 256 KiB initial capacity; forced volcanic starts measured 77-87 KiB of index. It grows by reallocation only if a world ever needs more.
- **Load.** `prime` packs the spawn's index synchronously behind the load screen: 3.8 ms in a natural world (no site near home), 113 ms in a forced volcanic world (Node). This is load time, not a frame.
- **Flight.** The index is rebuilt after 4 km of drift, packed in slices of at most 1 ms of main thread a frame (the 2 ms rule, with room) and uploaded whole once packed: about 21 frames in a natural world and 85 in a forced one, so the 72 km reach keeps every page inside the 45 km far plane covered meanwhile. Steady state is one distance check a frame and allocates nothing.
- **Coverage.** While a build is under way (after a teleport), a page the index does not cover waits rather than caching a bake without its volcanoes. Coarse pages are wider than any index (the L9 roots are 262 km), so they bake with part of it, recording the coverage they had, and are refreshed in place (height, then occlusion and splat) once their part within 50 km of the observer leaves that coverage. The scan runs every 1 km of travel or on a new upload, and refreshes at most 2 pages a frame, after any new page (`TERRAIN_LANDFORM_REFRESH`).
- **Per texel.** Each bake looks up one 4 km bin and loops over that bin's sites, which is zero sites everywhere in the temperate core.

### Materials (Basalt, Tephra)

Two surface materials appended after Concrete, Basalt (id 10) and Tephra (id 11), so the ground grain moves from array index 10 to 12 (`GROUND_GRAIN_LAYER`). The profile datum `volcanicMaterials` is off at tier 0 and on at tiers 1-3 (the tier row above).

- **Memory.** Tiers 1-3: two more layers in each terrain material array, +5.33 MiB at 512² with mips, so both arrays are 34.7 MiB (thirteen layers: the ten base materials, the volcanic pair and the grain). Tier 0 is unchanged at 6.7 MiB: the splat bake paints Basalt as Rock and Tephra as Gravel there (`volcanicFallbackMaterial`), from a seventh `SplatJob` lane, after main's airport lane (+16 B per job), so its ten-layer arrays and ten-material gather never meet an id they lack.
- **Terrain fragment.** The sparse splat gather adds each texel's weights into per-material totals, then picks the two largest. The totals live in vec4 buckets of four materials, one switch arm per bucket, so ten and twelve materials both use three arms; under `TERRAIN_SURFACE_VOLCANIC` the pick scans twelve candidates instead of ten. The result is bit-identical to one scalar per material. The bucketing matters on SwiftShader, which executes every switch arm: a twelve-arm scalar switch cost the gather 1.5x the ten-arm one, and pushed two volcanic-only A/B shots past 2% GPU (approach +2.2%, water +3.7%). The bucketed twelve-material gather takes about 0.8x the old ten-arm time (1M invocations, `terrainSparseSplatGatherWgsl`). The number of fetches per pixel does not change. The define follows the layers actually bound, so tier 0 compiles the ten-material gather. No draw-call change.
- **Splat bake.** One `terrainVolcanicGround` sample per texel (the landform include, over the site index), shared by every tap and both seasons; one remap per accumulated id; and a closure-lane branch taken only on volcanic ground. Off volcanic ground the classification is bit-identical (`tests/render.webgpu-land-cover-volcanic.test.ts`).
- **Spawned airports** (2026-10-25, with main's airport network). The spawn survey's height already includes the overlay (`sampleTerrainHeightBeforeEarthworks`). `spawnedAirportGroundAllowed` also refuses ground with more than 5% lava and tephra, or within 1.5 km of an edifice's base; not the whole footprint, which would refuse almost every runway within 25 km of a field's centre. It costs about 7-8 µs per surveyed point (Node; one ground sample and one site query), about 1.4 ms per spawn, all on the spawn worker.
- **Startup.** Two more synthesis-worker jobs, off the main thread: Basalt ~0.83 s and Tephra ~0.59 s at 512² (Node; Rock is ~1.23 s). The main-thread mip reduction in `uploadSurfaceMaterialArrays` grows with the layer count, from ~190 ms to ~223 ms at 512² (Node). It was already one step over the 2 ms budget and stays on the main thread; moving it into the synthesis worker is open.

### Timing

Measured on the CI runners (`perf-ab.yml`) at `050a5d9`, the five default shots, none of which shows volcanic ground. No draw-call change on any shot. Inventoried GPU memory +5.6 MiB (280.2 -> 285.8 MiB on approach), the two material layers.

- **Volcanic alone** (the pull request's run, base the dunes branch at `dead891`): all five SAME on SwiftShader, all on the EPYC 7763: approach -0.2%, cruise -0.9%, forest -0.3%, ground +0.2%, water -1.2% GPU. The macOS runner's advisory A/B read -0.4% to +0.9% frame time, all SAME. Volcanic ground costs nothing where there is none, well inside the 2% budget; the bucketed gather (below) is cheaper than the ten-arm one it replaced (0.8x over 1M invocations), which fits four shots reading faster.
- **Against main** (the whole biome stack plus volcanic, base `6d91220`): all five SAME on SwiftShader: approach -0.2% (EPYC 7763), cruise +3.5% (EPYC 9V45), forest -0.7% (9V45), ground -2.2% (Xeon 8370C), water -1.0% (7763). The macOS runner read +0.5% to +1.6%, all SAME. Cruise's +3.5% is the scene pass (+2.9%) and the cloud raymarch (+49%, 72 -> 108 ms a frame). No cloud code differs between main and this head, and on the 7763 the same raymarch moved +0.1% (the stack against main at `82c97e9`) and +0.3% (volcanic alone), so this is how the 9V45 weighs the biome stack, not volcanic ground.
- **After merging main's airport network** (`dc7743b`, base the dunes branch at `7d6b300`, which carries main at `c43eb86`): all five SAME on SwiftShader and none slower: approach -1.4% (EPYC 7763), cruise -0.6% (7763), forest -1.2% (9V74), ground -1.4% (7763), water -1.6% (9V74) GPU. No draw-call, pass or pipeline change. The macOS runner's advisory A/B read frame time +0.7% to +2.3% and main-thread CPU +1.3% to +2.6% (0.2 to 0.75 ms), inside its 5% and 15% gates; before the merge both read about 0. The water shot's frame differs from its base (SSIM 0.98, the swell in another place), but not from volcanic: the head frame matches the dunes branch's own A/B frames (`cdcc4d9` and `7d6b300`) bit for bit, while the base frame, the same tree as `7d6b300`, came out as a different frame. On the SwiftShader runners the water frame is not reproducible run to run, so a water pixel diff there says nothing about a change.
- **The gather, before and after.** With twelve scalar switch arms the same volcanic-alone A/B (at `06a0da7`) read approach +2.2%, cruise +1.6%, forest +1.4%, ground +1.0% and water +3.7%: two shots over budget, because SwiftShader executes every arm of the switch in every terrain pixel. `8fdf0b7` keeps the totals in vec4 buckets, three arms for twelve materials; the result is bit-identical.
- **A control that is not one.** A run with `--head-profile-override {"volcanicMaterials":false}` read the same as the shipped profile (+1.3% to +3.4%). On the tiers with the ground grain the arrays keep the volcanic pair (the grain's layer index follows it) and the gather follows the layers bound, so the override changes nothing there; it only differs on tier 0, which has no grain.

## Tree species from the climate temperature (2026-10-25): no baseline moves

`classifyDetailSample` (`detail/generation.ts`) chose between the upland and
lowland tree sets, and picked the shrub species, from `0.66 - height / 2450`
plus the province offset. It now reads the sample's climate temperature, the
one the ground's bake reads (the 11 km climate field, the lapse rate and the
province offset), so a stand turns upland where its ground does. A sampler
with no temperature keeps the stand-in. Jason chose the switch on 2026-10-25.
Tree positions, counts and sizes do not change; only species can.

**What changes in the temperate core** (perf seed, 373 detail cells every 6 km
within 66 km of the airport): 7 cells, 12 of 403,624 trees (oak to spruce 5,
spruce to maple 2, pine to birch 2, and one each of spruce to cedar, cedar to
spruce and spruce to oak) and 1,811 of 768,012 shrubs (0.24%). The largest
group is six trees on a slope at 980-990 m, 54 km east of the airport (cell
131, -55), where the real temperature (0.21) is colder than the stand-in's
(0.26): five oaks become spruces and a spruce becomes a cedar.

**No shot sees one.** The macOS capture at `9d5f98e` (gpu-tests run
40148770639, artifact `perf-capture-40148770639-1`, zip sha256
`e5fb992a9dd9308d…c57c9e988`) against the capture before it (`8324439`, run
40140784416): at most 0.0062/255 mean absolute difference
(`forest-line-highsun`, sea sparkle and foliage shimmer), and `mountain-close`,
`terrain-material-1600ft-down` and `canopy-1200ft` are identical. Against the
committed baselines it is at most 0.0075/255. Two captures of the same code on
that runner differ by up to 0.025/255, so nothing is promoted and every
baseline stays. The before/after of the six trees is a scratch perf:ab render
(`--rounds 0`), not a committed shot.

**Cost: none.** The classifier reads a field the sampler already returns; the
A/B at `9d5f98e` is in "Terrain and world paging" above.
