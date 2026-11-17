# WebGPU performance

fly high renders with a Babylon.js `WebGPUEngine`. It keeps memory, generation, simulation and draw work bounded while the deterministic coordinate space stays effectively endless. This page is the performance reference: the runtime contract, what each quality tier spends, how each system keeps its cost bounded, and how a change is measured. `QualityProfile.ts` is the source of truth for every tier value and `PERF_CAPTURE_SHOTS` for the capture list; the tables here mirror them, and `tests/docs-truth.test.ts` checks that they agree. Item ids such as `4.5-A1` or `6-12` refer to the archived rendering plans ([ARCHIVE.md](ARCHIVE.md)).

Two rules for new work:

- **Budget a feature at about 2% of a Medium frame**, not the A/B gate's 5%. Three October pull requests each passed the gate alone and together cost 4 to 6% on SwiftShader ("Measured costs").
- **Log every baseline promotion and draw-ceiling change** as a row of "Rebaseline and draw-ceiling log", newest first, and add a feature's measured cost to "Measured costs". The dated write-ups this page carried until 2026-11-17 are in git history: `git show 70fb152:docs/PERFORMANCE.md`.

## Runtime contract

- WebGPU, Web Workers, and a hardware-accelerated adapter are required. Startup requests a high-performance adapter and rejects a software/fallback adapter.
- There is **no WebGL fallback and no Canvas fallback**. An unsupported device receives a startup error rather than a reduced renderer.
- The engine runs with compatibility mode disabled, a right-handed scene, reversed-Z depth, MSAA on the offscreen beauty target per tier, a 0.08 m near plane, and a 45 km far plane (1C-4: the shared aerial perspective is ≥95% opaque beyond it).
- Continuous `timestamp-query` observers are disabled in gameplay: a controlled reference capture measured a 4.7 ms p95 observer tax and only 49 resolved samples in 240 frames. A pinned diagnostic capture can request them explicitly before device creation; they are never required for rendering.
- The frame loop draws on every Nth display refresh (Settings → Frame rate, `src/game/framePacer.ts`).
  - "60 fps (smooth)", the default at every tier, uses N = floor(refresh / 60), so frames stay evenly spaced: 60-100 Hz displays draw every refresh, 120 and 240 Hz draw 60, 144 Hz draws 72 and 165 Hz draws 82.5.
  - "30 fps" uses N = round(refresh / 30). "Match display" draws every refresh, the loop every build before PR B ran.
  - Under "60 fps (smooth)", tier 0 falls back to an even rate near 30 fps when its governor is exhausted (see the governor bullets).
  - The period is confirmed only on evidence render cost cannot stretch, so a slow machine cannot relax its own target through the period: ticks that draw nothing for a reason render cost cannot touch (the startup probe's quiet lead, which renderer creation waits for at every setting, a re-probe while paused or when the pause menu turns pacing on, ticks the pacer skips with time to spare or to measure the display), or drawn ticks faster than the rate held before. The lead lasts 24 ticks or 300 ms, and longer, up to 1 s, until 13 ticks have come with no 250 ms gap between them, so a late first frame or a stall cannot leave it too short to read, however many ticks came before the stall; only stalls that leave no 13 such ticks within the 1 s can. A tick that draws nothing only asks for the next frame, so the tick after a skip comes one refresh later: a ring of those one slower refresh apart is a display that slowed down, followed without a pause. Firefox on macOS can stamp a tick several ms early, never late, so under frames of two refreshes the pacer's own skips are the early-stamped ticks: those, and probe ticks during renderer creation, never confirm a rate. A faster period wins only on runs of quiet deltas, or on most spans of four deltas where dense jitter leaves too few quiet ones. A grid fit over every tick says which rate near the clean evidence the display runs at, common or not (112, 175 or 222 Hz), and withdraws a confirmation the ticks keep contradicting; it moves no rate on its own, and none runs over the probe ticks of renderer creation, which miss vsyncs at random (`src/game/framePacer.ts`). The re-probe skips 24 ticks when the flight pauses, and again on the first paused tick after the tab was hidden or the loop stalled; where frames of two refreshes may hide a faster display, or the ticks contradict the held rate, the pacer skips up to 24 single ticks to measure it, once per rate it holds until the flight pauses. The frame that ends either gap is left out of diagnostics and the governor's window, so neither shows as a stall. A variable-refresh display that presents each frame when it is ready gives the ticks no grid to sit on, so there the confirmation can come and go a few times a minute, but no further round of skips repeats frames. What no tick shows stays unmeasured until a pause. At "60", a display that slows to a rate whose ticks all sit on the old rate's grid (240 or 120 to 60 Hz) is drawn on every tick, so the frames are right while the reported rate stays the old one; so does a change of under 6% between rates drawn on every refresh (72 and 75 Hz, 48 and 50 Hz) at a light load, and 144 to 100 Hz under frames of two refreshes or more can take tens of seconds. "Match display" skips no tick and re-probes on no pause, so there a display that changes rate is followed only where it speeds up by more than 10%: the frames are the same at every rate, and the governor reads the old period, unconfirmed where the ticks contradict it.
  - The capture, perf:ab and perf:flight harnesses call `render()` themselves and never pace, so the even fallback never applies there.
- The sun-shadow map and the cloud-depth pass refresh every Nth presented frame (`shadowRefreshFrames`, `cloudDepthRefreshFrames`: every 2nd at tier 0, every frame above it). N is converted only when the paced cadence is slower than the tier's (the 30 fps setting, or the governor's even fallback), to keep the same rate in Hz: at the 30 fps setting, and at every rate the fallback draws, tier 0's 2 becomes 1, so its sun shadow and cloud depth stay at 30 Hz under a 30 fps fallback. A host that misses its target under the 60 fps setting still counts presented frames, so there a held map is older in time. Under governor pressure a rung adds one presented frame at any tier. On equal intervals the cloud depth runs a frame off the sun-shadow map, so only a frame a reset forces (an invalidation, an interval change, or Babylon redrawing a map whose casters were not ready) carries both passes, and the next frame moves the depth off again. A held map keeps the light matrices it was drawn with, and Babylon's receivers read them with it; the detail system's far band copies them a pass before the map redraws, so on a redraw frame it reads the previous draw's. Every history invalidation (display resize, camera cut or mode change, floating-origin shift, profile or atmosphere change) forces both fresh (`src/render/refreshHold.ts`).
- Device loss is terminal for the current renderer instance. Simulation/rendering pause and the user must reload to recreate the adapter, device, and every GPU resource. That holds from the moment the engine exists: a loss while the renderer is still starting fails startup with the same advice (`src/render/webgpu/core/GpuDeviceLossLatch.ts`). Babylon's own restore is never relied on: it would bring the uploaded raw textures back empty, since their CPU copies are dropped after upload (`src/render/webgpu/core/TextureCpuMirror.ts`).
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

**Pipelines compile off the frame.** Babylon builds a render pipeline synchronously inside the first draw that needs it, so the first frame that shows a new material waits for its shader compile: the nose-down freeze of 2026-10-27, 0.6 to 1.8 s on the macOS runner, when the near-ground detail first came into view. `src/render/webgpu/core/AsyncPipelineCompiles.ts` changes that for the detail materials and the grass blades. A draw whose pipeline is not built starts `createRenderPipelineAsync` and skips that one draw, so an object appears a frame or a few late instead of the frame stopping; a pipeline the device refuses asynchronously is built synchronously at its next draw, so its error still reaches the uncaptured-error guard. Each detail prototype's first published batch draws wherever it is (`alwaysSelectAsActiveMesh`) until its pipelines are ready, and the blades' placement kernel is built with `createComputePipelineAsync`, so most compiles finish while the scenery streams in. Wildlife primes its pipelines at startup. Captures call `setSynchronous(true)`, so a shot's frames still build pipelines in the frame, as the baselines' did. Pinned by `tests/render.webgpu-async-pipeline-compiles.test.ts` and `tests/gpu/async-pipeline-compiles.test.ts`.

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

**No erosion runs in a shipping frame.** The eroded world has GPU producers (`TerrainMacroErosionGpu.ts`, `TerrainPageErosionGpu.ts`) beside the CPU-worker reference, but it has been parked behind `?world=eroded` since 2026-08-31, when it flew as flat page-shaped plates with water between them; the analytic world is the default. So erosion cannot explain a measurement taken on the default world. `TerrainPageHydrology` and the inland halves of flow advection, standing waves and lake chop are driven by eroded-only data and are dark too; their ocean halves are live.

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
| Absolute pixel cap (1A-6a) | 0.85 Mpx | 1.5 Mpx | 2.4 Mpx | 4.0 Mpx |
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
| Tree ground shadow range (`treeGroundShadowRangeMeters`; a decal under every drawn tree inside it, 0 = none) | 450 m | 1,100 m | 1,200 m | 2,000 m |
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
| Boat spray particle cap (`boatSprayParticleCap`; boat sessions only) | 256 | 1,024 | 4,096 | 4,096 |
| Boat wake trail seconds (`boatWakeTrailSeconds`; boat sessions only) | 12 | 24 | 40 | 40 |
| Vehicle particle budget (`vehicleParticleBudget`; car sessions only) | 32 | 128 | 256 | 384 |
| Tyre track segments (`tyreTrackSegments`; car sessions only) | 0 | 256 | 512 | 1,024 |
| L0 terrain round a car (`vehicleNearTerrainL0RadiusMeters`; car sessions only; 0 = the floor is already L0) | 160 m | 0 | 0 | 0 |
| L0 terrain geomorph band (`vehicleNearTerrainL0BandMeters`; the outer part of that disc) | 64 m | 0 | 0 | 0 |
| Road ribbon range (`roadRibbonRangeMeters`; the 128 m chunks in reach drawn as one, a slot each) | 150 m | 500 m | 800 m | 1,200 m |
| Guardrail draw range (`barrierDrawRangeMeters`; the 128 m chunks in reach drawn as one, a slot each) | 300 m | 600 m | 900 m | 1,200 m |
| Home marina casts shadows (`marinaCastsShadows`; within 1.5 km) | no | yes | yes | yes |
| Structure near radius (`structureNearRadiusMeters`; the kit's closed shells, dithered over 40 m into the blocks) | 250 m | 400 m | 600 m | 800 m |
| Structure far radius (`structureFarRadiusMeters`; the blocks, drawn no further than the 3.9 km the settlements stream) | 2,500 m | 4,000 m | 6,000 m | 8,000 m |
| Buildings drawn open (`structureOpenBuildings`; rooms and glass, within 40 m of the camera) | 2 | 4 | 6 | 6 |
| Structure shells cast shadows (`structureNearCastsShadows`; the near set, one caster) | no | yes | yes | yes |
| Structure texture edge (`structureTextureEdge`; the kit's 13 material layers, texels; 0 = part colours alone) | 0 | 256 | 256 | 512 |
| Building light points (`structureLampPoints`; lit windows past the near radius, mast and lighthouse lights, in the one light-point draw) | 256 | 1,024 | 2,048 | 2,048 |
| Chimney smoke (`structureChimneySmoke`; homes' stoves within 1.5 km, wisps of the steam's one draw) | no | no | yes | yes |
| CSM refresh interval (frames at the tier's frame rate; G5) | 2 | 1 | 1 | 1 |
| Cloud-depth refresh interval (frames at the tier's frame rate; G5) | 2 | 1 | 1 | 1 |
| Governor pixel floor (share of the capped pixels; G4) | 0.6 | 0.6 | 0.5625 | 0.5625 |
| Even fallback rate when the governor is exhausted (Hz, 0 = none; G6) | 30 | 0 | 0 | 0 |
| Frame target | 13.7 ms | 13.7 ms | 13.7 ms | 30 ms |

Ultra's material array edge is 512², not §5.3's published 1024²: `3-1`
synthesises the ten layers on the CPU (measured 1.07 s at 512², ~4.3 s at
1024²), and several seconds of blocked main thread at startup is not worth a
resolution the de-tiling warp and 16× anisotropy largely mask. The row reopens
if synthesis moves to GPU compute. Both arrays together are 6.7 MiB at tier 0
(the ten base materials) and 34.7 MiB above it (those ten, the volcanic pair
and the ground grain), derived from the tier's edge and layer data rather than
declared, so the memory row cannot disagree with the knobs.

Low's L0 terrain round a car draws the ground within 160 m of the wheels on the 2 m lattice the car's physics drives on, not Low's 4 m one. The selector splits it after the tier's own nodes and outside `cdlodNodeBudget`, so it never trades nodes with the far field: at most 183 more nodes (`terrainNearFloorNodeAllowance`, measured 96 to 120 on rough ground), in the same single terrain draw, geomorphing to L1 over its outer 64 m. The shadow casters draw the tier's own selection, so the patch costs the beauty and cloud-depth passes only: GPU +2.2 to +4.3% on Low in car scenes. Aircraft and boat sessions never build it.

These are profile values, not claims that each row owns a separate framebuffer. The spectral configuration defines all five requested cascades, so the active allocation is 3/4/5/5. Terrain tiers retain the inexpensive far levels needed to reach the 45 km far plane (guaranteed coverage is 512·2^rings meters; tier 0 stops at 32.8 km behind ~89% haze opacity); quality changes near-page vertex density rather than exposing a finite terrain edge. Tier 3 is a 30 fps tier that spends its frame on pixels.

`worldEvolution` is world content and is invariant across this tier table. The two 1024² R16F bathymetry textures are a live 4 MiB allocation on an adapter that exposes `texture-formats-tier1` (Chrome); on a core-only adapter (Firefox 155) the clipmap stores `rgba16float` instead and the same two textures are 16 MiB, and the estimator's bathymetry row follows the live format. The eroded world's startup, macro evolution in a worker before the renderer resolves, is not paid by the analytic default. The renderer owns an outer startup deadline, and bathymetry compute readiness rejects on compile error, timeout, abort or disposal, so a pipeline that fails to compile cannot hold the load screen forever.

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
  **Cost**: after the per-texel bake (`9d5f98e`), about 2.2% of the cruise frame and 0.6% of water on SwiftShader against the field switched off on the same CPU model, and -0.5 to +1.0% frame time on the macOS runner; +0.25 MiB of inventoried GPU memory; no draw call, baseline or ceiling moved.

### Landforms: sand seas

The dune stage (`src/world/landforms.ts`, `src/world/dunes.ts`, the WGSL twin in `terrain/TerrainLandformKernel.ts`) adds crescent sand seas to arid lowland past 150 km from the start airport. It is world geometry: the aircraft lands on it, so physics, every quality tier and every bake must see the same dunes, and it cannot be switched off on Low. Instead its cost is confined to bakes, and the airport's surroundings never pay it.

- **Where it runs.** The stage is a pure function of world position between the natural height and the runway earthworks. Within 120 km of the start airport its core mask is zero and it returns the natural height untouched (the occlusion march reaches about 120 km, so nothing in view changes); it ramps to full by 150 km. Inside an erg it adds the dune field and a sand cover that turns the ground bake's material to the golden Sand, thins trees and ground cover, and keeps lakes and rivers out. `?landforms=dunes` (or `createWorld(seed, { landforms: { dunes: true } })`) forces it everywhere but a 5→8 km runway clearance, for review and tests; it is read from the URL and never saved.
- **Per frame: nothing.** No pass, draw call, pipeline, uniform buffer or texture was added. The height page generator, the height pyramid and the bathymetry clipmap call the stage after the natural height; the splat bake reads the sand cover. Those pipelines are the ones already pre-warmed behind the load screen, so no compile moves into flight. The one new binding, `terrainLandformData`, is a 16-byte placeholder registered with `GpuBufferInventory` (the volcanic overlay fills it with its site index). The CPU path writes into scratch objects and allocates nothing per sample, and the far-field erg weight returns before the natural-terrain sample wherever the core, the climate or the erg patch rules a point out.
- **The far field.** Zero-trust pages (L5 and coarser) refuse a Sand pair and draw the Grass base, so the far province field's sand lane carries the dune stage's far erg weight (`sampleErgFarWeight`, 1.25 km texels) and the far tone paints Sand over an erg. A sampled texel costs about 4.0 µs against the province's 1.5 µs, and the field charges it `CLIMATE_PROVINCE_FIELD_LANDFORM_COST` extra units, so a frame's bake stays about 0.8 ms. Its early outs (the core, wet country, outside an erg patch) cost nothing extra and read 0, so around the airport the far tone is still x + 0. Low has no province field, so there a far erg keeps the Grass base.
- **CPU samples.** Measured in Node: a terrain height inside an erg costs 9.1 µs against the natural kernel's 8.1 µs. Physics, the detail worker and hydrology pay that only inside a sand sea.
- **Spawned airports** (2026-10-25, with main's airport network). A spawn search surveys and grades its sites on the landformed ground (`sampleTerrainHeightBeforeEarthworks`) and refuses sand seas (`inSandSea`). Inside the core the height is the natural kernel, as before, and the veto is a distance test (0.5 µs). In an arid erg the veto is one natural kernel evaluation (about 10 µs) per surveyed centre, 160 per spawn, and each height probe pays the stage's ~1.5 µs. All of it runs on the spawn worker, never the main thread.
- **Bake cost on a real GPU.** `terrainLandforms` returns the natural height after a gain test and one distance test. Inside the core every texel of a page takes that same early return, so a real GPU never enters the dune field there; only pages that straddle the 120-150 km ramp diverge.
- **Bake cost on SwiftShader, which runs both sides of every branch.** Measured on this host (median of interleaved runs, warmed pipelines): a height page costs 15-25% more wall clock with the stage compiled in, whether the page is inside the core or in an erg, and a splat bake 10-13% more. The first splat compile takes about 1.4 s longer, behind the load screen. These are bake times, which the A/B's settled frames do not include; they show up as streaming time on CI's SwiftShader runs.
- **Frames and draws.** Inside the core the stage returns the natural height bit for bit, so no baseline or draw ceiling moved, and the A/B read GPU time the same on the default shots. Over a forced erg, flight was cheaper than over the same desert without one (render() p50 7.5 against 9.8 ms), because sand replaces trees and ground cover.

### Volcanic fields

Volcanic fields are a height stage after the sand seas (`natural -> dunes -> volcanic overlay -> earthworks`, `src/world/volcanism.ts`). In a natural world they start 120 km from home; `?landforms=volcanic` forces a field 30 km out for review. The temperate core lists no site, so every pixel there is the overlay's identity. Steam is under "Volcanic steam".

- **Site index** (`VolcanicSiteIndexStream`). The GPU reads the sites from one storage buffer, `terrainLandformData`, which page generation, the height pyramid, the sea-depth bake and the splat bake all bind: the sites within 72 km in 4 km bins, in a 256 KiB buffer (forced volcanic starts measured 77 to 87 KiB). The spawn's index is packed behind the load screen (3.8 ms in a natural world, 113 ms in a forced one); in flight it is rebuilt after 4 km of drift in slices of at most 1 ms a frame. A page the index does not cover waits rather than caching a bake without its volcanoes, and coarse pages refresh in place, at most 2 a frame (`TERRAIN_LANDFORM_REFRESH`).
- **Materials.** Basalt (id 10) and Tephra (id 11) follow Concrete, so the ground grain sits at array index 12 (`GROUND_GRAIN_LAYER`). On tiers 1 to 3 (`volcanicMaterials`) they add 5.33 MiB to the material arrays; tier 0 paints Basalt as Rock and Tephra as Gravel (`volcanicFallbackMaterial`). The splat gather keeps its per-material totals in vec4 buckets of four, three switch arms for twelve materials: SwiftShader runs every arm, and a twelve-arm scalar switch had cost two volcanic-only shots 2.2% and 3.7%.
- **Cost.** All five default shots read the same on SwiftShader and the macOS runner (none shows volcanic ground), no draw call changed, and inventoried GPU memory rose 5.6 MiB, the two layers. Basalt and Tephra add 0.83 s and 0.59 s of synthesis-worker time at startup, and the main-thread mip reduction in `uploadSurfaceMaterialArrays` grows from about 190 to 223 ms; moving it into the worker is open.

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

World detail is deterministic and page-owned rather than attached to transient terrain meshes (the old villages and buildings were deleted in 1B-5; the generated settlements stream with the roads, drawn by `StructureSystem` in at most four draws):

- Default detail cells are 512 m. Terrain biome, climate temperature, slope, moisture, height, and deterministic hashes choose tree and shrub species and rock variants.
- Near and mid LODs use deterministic far thinning. Velocity-ahead selection reduces pop-in during fast travel.
- Generation is cooperatively time-sliced to 0.75, 1.25, or 2 ms per update, with hard caps of 8, 16, or 24 cells and resident caps of 128, 384, or 896 cells for the three effective density bands. At least one pending cell is admitted so streaming cannot starve when a dense cell exceeds its target slice (after a worker failure, since 2026-10-25, inline cells wait for credit instead; see the presentation-synthesis item below).
- Thin-instance batches reuse low-poly procedural species/building topology and shared materials, and are partitioned into deterministic 8×8-cell presentation chunks. Each batch owns its lightweight Babylon `Geometry` because instance streams are geometry-owned; this prevents one chunk from replacing another chunk's GPU buffers. Babylon frustum-culls the resulting conservative prototype-aware bounds independently, so one visible tree no longer submits every offscreen resident instance, and a batch is drawn only when one of its 256 m blocks is in view ("Culling a batch by blocks").
- Presentation synthesis is a second bounded stage after cell generation. The dedicated detail Worker retains each generated cell behind a non-reused token as packed columns (`packDetailCell`: every number the build reads a Float64Array element, every name a code; about 103 B a placement in Node against about 530 B for the object graph, so 88 Low bench cells hold 38 MiB instead of 196 MiB, plus 24 B a tree and a bush for the ground shadows and solid bushes), which the presentation build reads through cursors into the same bytes; the inline fallback packs its cells the same way. It advances exactly one immutable packed chunk in at most 4,096 synthesis units or 4 ms per macrotask, and transfers exact 32-byte instance streams and bounds to the main thread. The main thread owns only lightweight resident descriptors, validates every token, batch key, byte length, bound and entity/record envelope, then copies each batch into a pooled CPU writer (the transferred buffer is garbage within the update, so it dies young instead of living, promoted, until the next publication) and synchronously publishes the complete result while the old chunk, statistics, mesh identities and GPU buffers remain live. While a build runs the worker posts a `presentationProgress` heartbeat after its first slice and then at most every `DETAIL_WORKER_HEARTBEAT_MILLISECONDS` (100 ms), and cells posted meanwhile wait their turn: each runs once the build has had its share of slices (a fifth of the last cell's time, 4 to 8 ms), and all of them run when the build ends or before any command that changes what a cell reads. The browser worker yields between slices through a self-posted MessageChannel message, which has none of a nested `setTimeout(0)`'s 4 ms clamp. A worker that reports an error or goes silent past a watchdog is replaced at the start of the next update by a new one on the same seed and live world, up to `DETAIL_WORKER_RESPAWN_LIMIT` (2) times per runtime; its cells are requested again, and every chunk keeps its last bytes until they are back. Past that limit, in a world whose terrain pages were transferred to the worker (an eroded world), or when a worker build fails or answers with a malformed result, the runtime fails closed to the bounded inline builder, which retains its 65,536-unit/3 ms update cap; inline cells then run on credit (an update earns one generation time slice, a cell starts only when the credit covers the running average cell cost, and each cell is charged what it took), which bounds the average main-thread time per update, not one cell. Authority-level generation and presentation watchdogs cannot be reset indefinitely by motion: cancel and reissue do not reset them. The watchdogs time the WORKER. The presentation watchdog charges silence: a heartbeat from the build the runtime holds, or an accepted answer, restarts it; it holds still while the demand is the main thread's to finish (a publication streaming, an inline build, an answer already queued); and it resets when the presentation sweep goes idle. Generation is timed only while the worker holds a request, any answer (current or stale) is progress, and its update count applies only after the worker's first answer. Either watchdog expires after 240 charged updates and at least `DETAIL_WORKER_WATCHDOG_MINIMUM_MILLISECONDS` (2,000 ms) of charged time, or after 8,000 ms whatever the count, and time without updates (a hidden tab, a long main-thread stall) is not charged past 100 ms per gap. Worker presentation demand that goes `DETAIL_WORKER_CONVERGENCE_MILLISECONDS` (30,000 ms) without an accepted build is counted and reported as a convergence stall, never failed over. Exact cell-to-observer lower bounds skip only arrays for which the legacy per-item radial predicate would reject every placement. Frontier targets are reevaluated at their documented 64 m quantum independently of the coarser paging signature; a completed observer-sensitive snapshot farther than the 96 m membership/ground-cover validity envelope is canceled rather than published. If an abnormally slow machine lets the previously published snapshot cross that boundary first, its meshes are disabled fail-closed while retaining their CPU writers and WebGPU buffers; the valid replacement re-enables them only through the normal synchronous commit. This suppression remains explicit pending detail work, so it cannot masquerade as stable capture or shorten GPU resource lifetime. Superseding ordinary observer/cell signatures otherwise drain after the finite snapshot so continuous motion cannot starve publication; representation or floating-origin changes cancel safely, and a rebase translates live, non-suppressed chunks immediately. CPU writers/bounds go back to one pool shared by every prototype once nothing reads their bytes (a cancelled build or publication, the writer an in-place publication displaced, a retired batch after its grace window), and recycled GPU allocations drop Babylon's `_data` mirror so it cannot pin or alias a reused writer. The pool serves best fit by capacity (a batch must fill more than a quarter of the writer, and new writers are powers of two of at least 32 records, so a small batch never keeps a large buffer alive; requiring more than half moved slack from live writers into the pool and, off the bench route, retained more in all). An inline build sizes each writer from the live batch it replaces, else from the prototype's latest batch, moves a full one into a pooled writer that holds twice its records, and swaps one left with four times its records or more for one that fits before publishing. The pool is capped at 64 KiB per cell of the profile's cell budget, at most 16 MiB (8 MiB on Low, 16 MiB on Medium and High), dropping the longest-idle writer first; `presentationRebuildDiagnostics` reports its size and bytes and the lifetime `cpuWriterAllocations`, `cpuWriterPoolHits`, `cpuWriterPoolDrops`, `cpuWriterGrowths` and `cpuWriterRefits`. On a simulated bench route the long-lived writer buffers made per second fell from 3.5 to 0.08 MiB/s on Low and from 9.1 to 0.11 MiB/s on Medium, for about twice the resident writer memory (5.8 against 2.5 MiB on Low, 12.1 against 6.2 MiB on Medium). Existing GPU buffers update in place when capacity permits; growth and removal use the unchanged submission-safe pool/grace path so an unsent WebGPU bundle can never reference destroyed instance storage. Renderer diagnostics count unfinished detail cells and staged/backlogged chunks, and deterministic capture settling requires that count to reach zero before any shot may be accepted or published as a candidate.
- Per-instance color supplies variation. A lightweight PBR vertex deformation consumes each tree's phase, compliance, height, and stable selection from `instanceWind`, producing asynchronous crown and trunk sway without CPU transform updates.
- `densityField.ts` owns a 7.2 × 5.4 km forest-fraction field in addition to the continuous stand field. Its 260 m glades reach a 0.02 authored-density floor, thresholded windthrow supplies a genuinely hard edge, and the published edge margin makes generated stems shorter and crowns broader. This changes where and how much forest grows; it deliberately does not change species/stand selection.
- A floating-origin change immediately translates every live presentation batch by its build-origin delta while the bounded rebuild sweep catches up. The detail shader receives the same offset for pre-world band culling and impostor facing. The shared cascaded-shadow system still receives all eligible chunks rather than only those visible to the main camera.

Wildlife uses deterministic 800 m cells, a default 2 km activation radius, and active budgets of 16, 48, or 128 animals (with a hard safety cap of 512). Birds include gulls and hawks; ground animals include deer and boar. Their species-specific procedural bodies, wings, antlers and tusks still occupy exactly ten shared prototype batches, with feather, fur and keratin PBR variants rather than per-animal meshes.

- AI advances at a fixed 30 Hz and limits catch-up work. Far agents update expensive behavior less often.
- Bird flocking uses a bounded spatial hash and local-neighbor queries instead of all-pairs behavior.
- Distance LOD reduces procedural body parts for far animals. The 30 Hz simulation stores previous/current poses and render frames interpolate position, heading, wing phase, and gait before uploading one current matrix buffer.
- Population selection predicts ahead of aircraft velocity and remains seeded by world/cell identity, so paging does not reshuffle the ecosystem.

Gate A adds only small, fixed steady allocations. The worst live aircraft surface set is about 0.188 MiB (64² albedo, normal and packed-material mip chains per paint recipe) inside the existing miscellaneous allowance. Wildlife uses 37,716 bytes of prototype position/normal/index data plus the unchanged 1,310,720-byte thin-matrix buffers, 1.286 MiB total inside the other-detail allowance.

### Ground detail

What stands between a tree and the ground (pull request #47, 2026-11-12 to 14):

- **Tree ground shadows** (`treeGroundShadow.ts`, `TreeGroundShadowMaterial.ts`). Every stem with a tree record inside the tier's `treeGroundShadowRangeMeters` emits one more 32-byte record, drawn as a multiplying decal: the crown's ellipse thrown along the sun, a trunk strip and a patch of sky shade. It removes only the direct-sun share of the ground's light, so it fades under cloud. One batch per presentation chunk in range, which bushes' shadows share.
- **Open ground's own trees** (`densityField.ts` and its shader twin). A second, far thinner stand outside the closed forest: lone trees, copses and groves, at most 56 stems/ha. A thin stand's trees hand to their impostors at 2.3 to 2.7 near radii (`detailSparseStandStemKey`), so a far lone tree costs no mesh batch.
- **Bushes and boulders** (`groundObjects.ts`, `presentationBuild.ts`) are drawn while they stand about three pixels tall: 300 m of range per metre of height, capped by the tier's ground shadow range. A bush is its leaf cards, a 60-triangle body under them, and a 12-triangle stand-in past that.
- **The ground up close** (`MaterialArraySynthesis.ts`, `TerrainSurfacePlugin.ts`). Within about five metres of the camera, `TERRAIN_MICRO_DETAIL` reads the material a fragment shows most of a second time, 3.3 times finer: one trilinear tap from each array and no new texture. A first cut that read every layer again through the anisotropic sampler cost 13.6% at `ground-2m-lowsun` on SwiftShader and was dropped.
- **Leaf cards hand over by size.** Between 50 and 100 m a tree's near-shell cards shrink and its mid-shell cards grow, each about the twig it grows from, with the two shells' areas summing to one shell at every range, instead of a dither (`DetailInstanceMaterialPlugin.ts`). The pivot rides the tangent lane these meshes already upload, so it costs no attribute or byte.

### Culling a batch by blocks

A vegetation batch is one prototype's instances over a 4,096 m presentation chunk, and Babylon frustum-tests it by one box over all of them, so every batch in the chunk under the camera passed whichever way the camera looked. `DetailInstanceBounds` also keeps a box per 256 m block (`DETAIL_CULL_BLOCK_METERS`), filled in the pass that packs the records, on the worker or inline, and the blocks cross the worker boundary with the batch. A batch mesh's `isInFrustum` answers Babylon's whole-box test first and then asks whether any block's box touches the frustum (`installDetailBlockFrustumTest`, `blockFrustumTest.ts`). It can only turn a yes into a no, and only for a batch none of whose instances' bounds touch the frustum, so it cannot change a pixel; frames were byte-identical before and after at every placement compared. Render-target lists (the shadow casters on High and Ultra) do not frustum-test their meshes, so a tree behind the camera still casts. A block's slot is its lattice index modulo 17 (`DETAIL_CULL_BLOCK_SLOTS`; a chunk is sixteen blocks wide and, unaligned, touches seventeen).

The test costs 2 to 35 µs a frame for every batch together. It took the 32 capture shots that carried a draw ceiling from 6,110 draws to 5,918 (`mountain-close` from 39 vegetation batches to 7), and on a draw-bound GPU that is the frame: the macOS runner pays about a third of a millisecond a draw, whatever the draw draws.

## HDR color, FXAA, and resolution

- The scene has no active prepass or TAA pipeline. Engine context antialiasing is disabled; MSAA lives on the offscreen beauty target, which is owned by whichever post-process is currently FIRST in the camera's chain (1B-11), at the per-tier sample counts above. That owner is not fixed: the scotopic pass detaches in photopic daylight, so ownership moves between rod vision, bloom and the tone map with the time of day and the tier. `FlightRenderer.applyFirstPassOwnership` derives it. FXAA is the sample-count-1 fallback.
- An explicit full-resolution `ImageProcessingPostProcess` uses a half-float texture and the scene's ACES configuration with exposure 1.08 and contrast 1.04.
- A full-resolution FXAA pass (`FxaaSharpenPass`, Babylon's FXAA 3.11 ported so the sharpen can ride in it; at a zero amount it is the stock pass, pixel for pixel) follows tone mapping at the sample-count-1 tiers, reading an unsigned-byte target.
- A final contrast-adaptive sharpen (AMD FidelityFX RCAS) restores the acutance FXAA and the browser's bilinear canvas upscale remove, at every tier that sets `sharpenAmount` above zero (tier 1 0.7, tiers 2/3 0.4; tier 0 off). Where FXAA runs it is FUSED into the FXAA pass (`FxaaSharpenPass`, 2026-10-24): FXAA already fetches the centre and its four-neighbour cross, which is RCAS's whole footprint, so the sharpen adds a few dozen ALU per pixel and no fetch, pass, draw or target. At the multisampled tiers it is a pass of its own after the tone map (`SharpenPass`: 5 taps, one LDR target counted in the framebuffer row, one more full-screen draw). Whichever runs is last: `applyProfile` detaches both and re-attaches the profile's one.
- Bloom (7-5) runs between rod vision and the tone map, on scene-referred linear radiance: a full-resolution soft-knee bright pass, a half-resolution separable Gaussian (9 taps, sigma 2.0), and an additive composite at intensity 0.08. It is enabled at tier 1 only — tier 0 is unmeasured rather than refused, tiers 2 and Ultra are unfunded. The bright pass is full resolution deliberately: it becomes the first post-process whenever the scotopic pass detaches, and the first pass's ratio sets the size of the target the scene renders into.
- The device pixel ratio is capped per tier (1/1.5/2/2) and the total scale product is clamped by the tier's absolute pixel cap (1A-6a) — no display can raise rendered pixels past it; unpinned, the governor's resolution step then applies to the capped frame (G4). Pinned captures keep the cap-only rule.
- Two governors adapt per 120-frame window (1A-6b, repaired by R-11 and PR B). They read the frame loop's requestAnimationFrame deltas, the cadence the pilot sees presented; diagnostics keep the start-to-start interval. While the flight is paused they judge nothing, since the static scene says nothing about flight, and the window restarts on pause and on resume. Each window is first judged against the presentation cadence. The target is 16.67 ms, and 33.3 ms on Ultra. The 30 fps setting judges against its paced interval: 33.3 ms where 30 divides the refresh rate, 40 ms at 50 and 75 Hz, 34.7 ms at 144 Hz and 36.4 ms at 165 Hz. The even fallback (below) judges against the interval it draws: 33.3 ms at 60 Hz. A presented interval is late when it is more than half a refresh past the slowest whole number of refreshes the target allows (25 ms at 60 Hz, 20.8 ms on a 120 Hz display paced to 60), so no interval vsync can produce sits on the threshold. Until the display period is confirmed (on ticks that draw nothing, or a faster period than any frame could make), late means 15% over the target (19.17 ms; 38.33 ms on Ultra), lowered by the same rule only for a period observed faster than 128 Hz.
  - A window with at most 5% of its frames late is **on cadence**, and nothing is shed. After four on-cadence windows whose pooled late share is at most 2.5%, one step recovers: a GPU-cost rung first, then a CPU-cost rung (only while render() p95 is within 0.9 of the target, or of the longest interval still on time where that is shorter: 12.5 ms at 144 Hz, where a frame makes two refreshes or is late), then +0.025 scale. It recovers on trial: two windows, or for the terrain-page, detail, animal, CDLOD and vegetation rungs four windows and a streaming backlog no higher than when the rung came back and not growing (in flight it rarely reads 0), waiting at most two windows more for that. A trial that goes off cadence restores the step and backs that ladder off for 30, 60, then 120 s. The strikes outlive a passed trial, one is forgiven per 120 s without a failure, and a re-shed within 30 s of a passed trial counts as a failure. These spans are counted in windows of frames at the paced interval: 15, 30, 60, 60 and 15 at 60 fps, 18, 36, 72, 72 and 18 at 72 fps.
  - Off cadence, a render() p95 over the GPU target (13.7 ms; 30 ms on Ultra) reads as CPU-bound: vsync puts the presented p95 on a whole refresh (33.3 ms at 60 Hz once more than 5% of frames are late), so the interval cannot split such a frame any finer. Under that, Governor A uses presentation interval minus measured CPU time as its GPU proxy; a split that neither the proxy nor the CPU explains is pacing-bound. It steps resolution 0.05 at a time, applied after the pixel cap (G4), down to the tier's governor pixel floor: 0.6 of the capped pixels at tiers 0-1 and 0.5625 at tiers 2-3, never below 0.4 Mpx. A step that would leave less than half a step above the floor goes to the floor, and a frame within 4% of the 0.4 Mpx minimum lands on it, so every step changes the pixels by about 4% or more or not at all: a 0.05 step by about 10% or more, one back onto the floor after a recovery step by 6% or more, and one onto the minimum by 3.85% or more; a step that changes nothing counts as one that bought nothing. On presented intervals it steps only after two off-cadence windows in a row. A step counts only if the next window, in the same timing domain, is on cadence or cuts the late share by a quarter (from over 2% late, and by at least 3 frames), the mean interval by 4% or the p95 by 4%. Two steps that do not are undone and latched.
  - When latched or floored, Governor A sheds GPU-cost rungs, each relative to the tier's own setting: shared compute ×0.6/×0.35, cloud-shadow cadence +1 frame, the cloud view march ×0.75 (fewer, longer steps, so rays keep their reach), shadow-caster distance ×0.7, vegetation distance ×0.75, cloud-shadow cadence +2, the cloud march ×0.6, shadow-caster distance ×0.5, ground-cover gate ×0.6/×0.3.
  - Governor B sheds CPU-cost rungs (terrain-page requests 8 per update; the cloud-depth pass and then the sun-shadow map each refreshed one presented frame less often; detail generation slice ×0.66; CDLOD node budget ×0.85; animal budget ×0.5; page requests 4; CDLOD budget ×0.75 with its split threshold ×4/3, eased in at 0.05 px a frame (3 → 4 px in 20 frames at Medium; 27 at Low, 14 at High, 10 at Ultra); detail ×0.33 with animals ×0.25; page requests 2) on CPU-bound windows, and on pacing-bound ones once resolution is latched, before any GPU rung. So does a window that reads GPU-bound only because shedding took render() p95 just under the GPU target: with the ladder part shed, resolution latched and no timestamps, a render() p95 at or over 0.9 of that target sheds the next CPU rung first. With its ladder spent, a CPU-bound window holds while render() p95 is at or over 0.9 of the target. Under that a resolution step may still be tried; GPU rungs follow only when steps that worked took the scale to its floor, and a latch from such windows holds while they last.
  - A window whose mean presented interval is over 1.5× the target (40 fps at 60) is urgent: once a miss has lasted two windows, an urgent window sheds a rung by itself instead of every second window. A window that is off cadence with nothing left to shed for the side that bound it, at a mean over 1.2× the target, is spent; four spent windows in a row make the governor exhausted (diagnostics `governorExhausted`). Where a confirmed display period cannot show the target (30 or 50 Hz under the 60 fps setting), both are judged against the display's own interval instead, so the display does not make the machine urgent or exhausted. A resolution latch set before the GPU ladder reached its top is re-armed once it has, so resolution is tried again with every rung shed before the governor counts as spent; that re-try neither resets nor advances the count.
  - Under the 60 fps setting, tier 0 (`cadenceFallbackHz` 30) answers exhaustion with an even fallback (PR B part 2b, G6): the pacer draws at the even divisor nearest that rate that the machine can hold (30 fps at 60, 90, 120, 180, 240 and 360 Hz; 36 at 72 Hz; 33.3 at 100 Hz; at 75, 144, 165, 170 and 200 Hz 37.5, 36, 33, 34 or 33.3 fps if the machine's frames fit, else 25, 28.8, 27.5, 28.3 or 28.6), and the governor judges against that interval and only sheds. A trial at the setting's cadence follows after 60 s, then after 120 s once one has failed: two on-cadence windows whose pooled late share is calm end the fallback and the governor recovers at 60, and so do four on-cadence windows that never pool calm, so a trial lasts at most four windows (8 s at 60 Hz); a trial that fails clearly (under 50 fps) settles it, and so do two failed trials; an engage does only when it is an early re-entry that makes three failed trials or more (below). Settled, the governor recovers at the fallback's rate and tries 60 again at most every 300 s, from full quality only. Only a display period the governor trusts allows it, so 30 and 50 Hz displays never fall back; nor do "Match display" and "30 fps". The machine's frames fit a divisor when their mean is at most 5% of a refresh past its interval. Engaged or settled, one that then misses it for two windows in a row in which the governor moved no lever moves to the slower one where there is one: the governor sheds what it still can at the faster divisor first, and a window that sheds a rung, takes a resolution step or has one undone starts the count again, as does a change of cadence. A failed trial chooses the divisor again from what that trial's window measured, its mean interval at the setting's cadence, so a stall that moved an engaged machine to the slower divisor holds it there only until the next failed trial. It never chooses a faster divisor than its floor does: the shorter of the mean interval of the window that engaged the fallback and the interval the trial left. Engaged, the floor is always the engage's, since engaged tests the state that was exhausted, so a trial that lands in a lighter stretch keeps the divisor the exhausting load needed (under alternating load at 75, 144 and 165 Hz, the faster one was raised back within about 25 s). Where the floor holds the slower divisor against the trial's own reading, the reading is kept, and a settled machine retries it 300 s later (below): the window that engaged can be heavier than everything after it (startup streaming, a spike on that window), and without the retry a machine that holds the faster divisor kept the slower one for the session. It moves a machine to a faster divisor only if that window shows it calm there: a mean at most 2.5% of a refresh past the divisor's interval, and no more than 5% of its frames longer than it. Otherwise the slower divisor stays, since a machine that only just fits the faster one is often more than 5% late there and would be raised back within two minutes; one trial window is a small sample, so a machine close to 5% late can still pass it. A failed trial that lands on a slower divisor than an interval kept already (one a raise rose from, engaged or settled), or else than the interval it left, keeps that one to retry, as a raise keeps the one it rose from (below), with the retries counted so far: with nothing kept before, it waits as after a raise; with one kept, the wait already running goes on, but ends no sooner than 120 s after the trial. Before, a stall on the window of the trial that settles, or one that raised an engaged machine and lasted through its trial, held a machine that holds the faster divisor on the slower one for the session, since one that holds it only shed never reaches full quality at the slower one for another trial. An engaged raise's interval costs what a settled raise's does: a machine at 50 ms a frame engaged at 2.04 refreshes at 75 Hz holds divisor 2 shed for three windows and is raised 16 s later, then retries it 300 s after that raise and 600 s after the next, 12.6% late from 900 s against 0.6% with nothing kept. Settled, a trial runs only from full quality, which a machine that held the faster divisor only shed never reaches at the slower one, so a raise to the slower divisor there starts a wait instead, on a clock of its own: 300 s after it, on the first on-cadence window with no recovery trial open, the faster divisor is tried again, and the governor sheds there what it must to hold it, as before the raise. The retry comes before the trial at 60, at full quality too, since a trial at full quality reads the slower divisor; the trial then waits at least 120 s, so the retry's switch and the trial's pair never share two minutes. A trial that fails after a retry is floored at the faster divisor the retry returned to, not the engage's, so a machine that reaches full quality there, whose trial at 60 then fails every 300 s, stays on it (floored at the engage's, each such trial put it back on the slower divisor, 70 to 80% of the time at 75, 144 and 165 Hz); one whose reading picks the slower divisor keeps the faster one to retry. A machine that cannot hold the faster divisor even fully shed is raised again after shedding everything, drawing late for one to one and a half minutes, so each retry that ends in a raise doubles the wait, to 600 s and then 1200 s at most, and a longer wait already running is kept; a retry that lasts 300 s without a raise starts the count again, and so does a failed trial that keeps nothing to retry; one that keeps the interval it left keeps the count, so a machine whose load grew for good retries no more often than the backoff allows. A raise that leaves the divisor where it was, as every raise at 60 Hz does, keeps nothing to retry and starts no wait, and no raise moves the trial's wait. So where a machine holds the faster divisor once a heavier stretch is over, a stretch on the window that engages the fallback, on the trial that settles it, or one that raises it, engaged or settled, holds it on the slower divisor until a retry about five minutes after it settles or is raised, not the session; a lasting one is retried 5, 10 and then 20 minutes after each raise. A fallback that comes back after a passed trial counts as a failed trial, however long after, until 240 s off after the passed trial forgives the failed trials; they are kept when the setting moves away and back. While that makes two failed trials or fewer, it engages, so its trial follows after 120 s and reads the load after the stretch that exhausted the governor: settled at the engage, on that stretch's mean with nothing kept to retry, a machine that held the faster divisor once it ended kept the slower one for the session. Once it makes three failed trials or more, it settles at the engage: engaged every time, a load that alternates heavy and light stretches passed each trial in a light one and engaged again in the next heavy one for the whole session (at 165 Hz, 58 ms a frame for 60 s in every 170 and 11 ms between: 21 engages, never settled, and twelve 120 s windows with more than two switches after the first 20 minutes). Settled so, it keeps the passed trial's window mean to retry where that is on a faster divisor than the engaging window's mean: that trial measured the machine holding 60, so the faster divisor is retried 300 s later, and a machine that cannot hold it is raised again, with the backoff. An engage with no passed trial behind it (failed trials kept through a setting moved away and back, or a display period that lost the governor's trust and got it back) engages whatever it carries, so its trial measures: settled at the engage, with no passed trial to keep, a machine heavy only on that window kept the slower divisor for the session. The faster divisor is retried only where a measurement says the machine could hold it: the interval a raise rose from, a failed trial's calm reading there, the interval a failed trial left, or, for an engage that settles, the passed trial's window mean. So a machine heavy both on the window that engages the fallback and through its first trial keeps nothing to retry, and stays on the slower divisor until a settled trial, which runs only from full quality there, reads the faster one calm (kept, and retried 300 s later), or until the fallback ends: a passed trial, the setting moved away from "60 fps", a display period the governor no longer trusts, or a new governor: a change of Graphics or Rendering setting resets it, and a change of aircraft, vehicle or world builds a new renderer with a fresh one. The clocks count judged windows, so a pause delays a trial by its length. Diagnostics show the phase (`cadenceFallback`), the HUD's GOV line too, and a trial's windows report the mode `fallback-trial`. `governorExhausted` stays true in every phase but off, though the engage zeroes the spent count.
  - Explicit timestamp captures can substitute a GPU signal, but normal gameplay does not burn frame time merely to decide how to save it. A pinned capture freezes both governors at level 0, where every rung hands its subsystem the profile's own value.
- Diagnostics additionally track a rolling 600-frame window for p95s and the Z-2 hitch metrics (max frame, p999, hitch count against 2× the tier frame target: 27.4 ms, 60 ms on Ultra; only the 30 fps setting or the fallback raises it, to twice its GPU target (the paced interval less 3.33 ms), which is 60 ms at 60, 120 and 240 Hz, 62.8 ms at 144 Hz and 73.3 ms at 50 and 75 Hz at the 30 fps setting, and 60 ms under the fallback at 60 Hz; never a period measured from slow frames); >250 ms stalls are counted there even though the governors' own p95 ignores them. Each interval is judged once, against the threshold in force when it was drawn, and keeps that verdict while it stays in the window: the diagnostics' `hitchThresholdMs` is the threshold now, and a change of cadence (the setting, or the fallback engaging, starting a trial or ending) never judges the window again, so it neither shows the window's frames at 30 as hitches when a 60 fps trial starts nor hides the hitches drawn at 60 when the fallback engages.

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

## Vegetation: a draw-call workload

Every (species, variant, band) mesh is one draw per presentation chunk per pass, at about 26 µs of GPU on the reference Mac (`2-12`): GPU time tracked draws linearly across the capture shots, and triangle deltas measured about zero. So vegetation's cost is counted in batches, not stems.

- **The capture report carries `vegetationBatches`**, the frustum-surviving vegetation batches, the number the vegetation frame row is spent on.
- **The ceiling is `VEGETATION_DRAW_CEILING`** in `renderedDensity.ts`: **`[50, 62, 448, 529]`** by tier, asserted against the constant by `tests/docs-truth.test.ts`. The draw model `estimateVegetationDrawCalls` is read against it, and `VEGETATION_DRAW_SUBMISSION_RATIO` beside it is the gap between modelled and submitted draws. The older `VEGETATION_FRAME_DEBT_RATIO` no longer exists in `src/` or `tests/`, and a test fails if it comes back. A presentation chunk is wider than the whole near and mid field at every tier, so band radii and stem counts barely move the draw count, and crown variants per species are not a budget knob.
- **Vegetation casts shadows only from tier 2** (`4.5-C1`). The near band was resubmitted once per cascade, the largest single term of tier 1's draws; trees still receive shadows everywhere.
- **The far field is always drawn in some representation** (`impostorFloorShare`, the tier table's "Impostor floor share" row). Beyond the near radius the gap between the geometry share and that floor is drawn as 2D octahedral impostors, thinned per stem on the GPU against the live camera range. Impostor records have no outer membership edge, so a far chunk rebuilds when a cell generates, never when the observer moves, and each impostor batch rebuilds its bounding box from the cells inside the live cull.
- **One tree cohort per chunk.** Palms grow only with oak, maple and birch (`TREE_SPECIES_COHORTS`), so a tropical chunk submits two families where a temperate one submits three, and the draw model prices the costlier cohort; only a band disc across a steep province ecotone sees all four (0.05 to 2.0% of the world at tier 1). Evergreens bake one impostor layer for both season buckets.
- **A merged crown and trunk prototype was tried and reverted** (Gate B). It cut modelled draws but moved trunks from the opaque depth pre-fill into the alpha-test path, and all five core sub-30-fps captures regressed by 0.78 to 2.09 ms of GPU.

## Capture harness

`npm run perf:capture` renders the authoritative `PERF_CAPTURE_SHOTS` list. Entries whose `comparesToBaseline` value is true read their committed image from `tests/perf/baseline`; diagnostic and probe entries deliberately run without one, so the committed PNGs and the per-shot table below describe the promoted comparison set, not the length of the live capture list. Notes that matter when reading its output:

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
- **Cold start** is a separate measurement (`tests/perf/cold-start.test.ts`, `npm run perf:cold-start`), because the steady capture begins after renderer creation and cannot catch a startup Promise that never settles. Every canonical capture command runs it first, in a fresh browser. It fails on timeout or console error, and needs both: the `5-10` startup Promise hung with no error at all, and the eroded world took about 90 s while logging nothing. "Ready" means a readable, GPU-complete frame: the render, a synchronous canvas readback, the GPU submitted-work fence and one task for asynchronous error delivery. The analytic default's deadline is **2,300 ms**: the median of three reference-host ready totals (1,817.7 ms) plus 25%, rounded up to 50 ms. `scripts/deliveryFloors.mts` keeps the samples and `tests/delivery-floors.test.ts` pins the result; hosted runs report it without gating it. `COLD_START_HANG_CEILING_MS = 120_000` is a separate hang catcher, not a budget. The startup trace splits every millisecond of `FlightRenderer.create()` into disjoint checkpoints and fails if their sum differs from the total by 5 ms or more.
- `VITE_PERF_SHOTS=name[,name]` runs a subset. A full capture is ~4–6 minutes,
  which is the wrong feedback loop for diagnosing one bad shot; the filter
  refuses to run alongside `VITE_PERF_REBASELINE` so a partial run cannot be
  mistaken for a reviewable candidate.
- `npm run material:preview` writes a terrain-material contact sheet to
  `tests/perf/artifacts/` — ten materials across, five channels at three
  footprints down. It is the tool the recipes are tuned against; the artifacts
  directory is gitignored because the repo ships no image assets by design.
- The committed `minFps`/`hitchCount` ceilings were measured on the reference
  M-series machine. They are **not** portable: the same build on a different
  box, or on a hot one, moves GPU p95 by several milliseconds on shots it
  cannot possibly have touched. `drawCalls`, `vegetationBatches` and
  `triangles` are load-independent and are the right counters to compare
  across machines.

A candidate is review evidence, never an automatic baseline mutation: the capture has no write path into `tests/perf/baseline`, promotion is a separate deliberate action after review, and performance ceilings cannot be rebaselined downward. The delivery floors and draw ceilings are pinned in `scripts/perf-capture.mts` and `scripts/deliveryFloors.mts` and checked by `tests/delivery-floors.test.ts`; a floor re-pin takes the stricter of the previous and the derived value, field by field.

### The per-shot table

The table below is the reference adapter's delivery record against the medium/balanced contract ("Diagnostics and regression testing") and the provenance of the delivery floors. Its first twenty-four rows are the Phase 6 snapshot promoted on 2026-08-31 (Apple Metal 3, headless Chrome 151, medium/balanced, 240 measured frames per shot after the residency drain); R4 appended six on 2026-09-01 from three idle-host runs, and the rows below those belong to shots appended later. The figures predate the rendered ocean and everything since, so they are not today's frame rates; `scripts/deliveryFloors.mts` keeps the immutable input samples. Normal shots use the shipped 0.86 render scale; `reference-viewport` keeps its 1.485 Mpx scale-1 cap-stress contract. There is one row per committed baseline PNG, which `tests/docs-truth.test.ts` checks.

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

### Draw-call ceilings

A draw call is counted, not timed, so its count is exact on any host once a shot has streamed to rest. Each shot that carries a `drawCallCeiling` in `PERF_CAPTURE_SHOTS` (`scripts/perf-capture.mts`) is pinned at the exact count three full macOS captures agree on, with no margin, and `tests/delivery-floors.test.ts` checks the ceilings against `DRAW_CALL_SAMPLES`. A ceiling moves two ways:

- **Down**, whenever three captures agree on a lower count. A ceiling never takes the largest count seen: `drawCallCeilingFrom` refuses samples that disagree ("Do not take the maximum: find out why it varies").
- **Up**, only through the ratchet in `scripts/deliveryFloors.mts`. `PREVIOUS_DRAW_CALL_CEILINGS` is a snapshot, and a ceiling above it needs a `DRAW_CALL_RAISES` entry that names the change and equals what its shots moved. A measured delta waiting to become a raise is staged in `MEASURED_DRAW_DELTAS`. A re-pin that lowers ceilings refreshes the snapshot and spends the raises inside it.

The cloud A/B's base → head draw column is a change's own draw delta, measured without a Mac (`--rounds 0` skips the timing), and its work counts name the pass that draws it.

#### The banked turn has no draw ceiling

`motion-banked-turn` reads its count where a 45° turn ends, and the vegetation drawn there depends on the worker's timing, not on the pose. A presentation chunk across a band edge carries the observer in its signature, quantised to 64 m (`DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS`), and its build takes the observer's position at the frame the build starts. The turn enters its last quantum 43 m before it stops and the held frames after it re-bake nothing, so the final pose holds a near band centred anywhere in those 43 m: at the same camera the picture harness counted 247, 250, 252 and 253 draws from bakes 43, 32, 21 and 0 m back. An exact ceiling on that fails a pull request that changed nothing, so since `ee332aa` (2026-11-13) the shot has none, and `tests/delivery-floors.test.ts` names it; only a motion shot can be declared so. Its consecutive-frame SSIM over 24 frames in motion and its delivery floors still gate it.

The other two motion shots keep exact ceilings, each for its own reason: `page-thrash-turn` enters its last quantum 4 m before it stops (19 vegetation batches at every bake it can end on), and the one vegetation batch in `cdlod-transition`'s frame is a far impostor chunk, which has no band edge. Both hold because of where a track ends and what a frame shows, not by construction, so a change to a motion shot's speed, start or frame count, or to the 64 m quantum, is a reason to measure it again.

### Promoting baselines

Since 2026-10-13 baselines are promoted from the hosted macOS runner's capture (`.github/workflows/gpu-tests.yml`), an ordinary capture of the pull request:

1. The capture fails the visual gates where the change moves pixels, and nothing else.
2. Jason approves the look from before-and-after frames.
3. The PNGs are copied from that run's `perf-capture-<run>-1` artifact. Promote every shot the code moves, including those that moved inside their gates, so that a baseline is what the code draws; promote all thirty-nine from one capture when a change touches every frame.
4. A row in the log below records the run, the commit and what moved.

The hosted runner does not gate frame delivery, so its promotions never re-pin a delivery floor. Two captures of the same code on it differ by up to about 0.025/255, which is not a reason to promote.

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

**A poll that never gives up.** A browser each was not enough on a slower
4-CPU runner, where the two browsers still compile their pipelines at the same
time. On CI's EPYC 7763 runners the base arm of `approach-500ft` and
`forest-500ft-sunbehind` lost the race on the splat bake
(`terrain-page-splat`): it drew the shot without its baked ground cover (no
lake beaches, other ground and mountain material), about 5% cheaper, so the
head read SLOWER by that much. The frames repeated bit for bit run to run, and
the work counts and draws matched a normal base exactly. On a host held to two
CPUs, both arms latched on the splat bake and the horizon pyramid; main's arm
settled anyway, because its settle check does not count a channel page
waiting on its splat, while the land PR's head waited for it and never
settled. So the agent replaces `ComputeShader.dispatchWhenReady` in both arms
with a poll that keeps trying until `dispatch()` succeeds: a slow first
compile now delays a bake instead of losing it. On the same two-CPU host both
arms then settled in 360 frames, with no bake left waiting, and the base drew
its beaches again. Nothing else about the dispatch changes, and the
renderer's own latch is still there for a fix of its own.

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

**Calibration**, 2026-10-12 and 13 (16 rounds unless named; the numbers are pinned in `docs/evidence/`):

| Run | Host | Result | Evidence |
| --- | --- | --- | --- |
| A/A, `cruise-horizon` | cloud session, SwiftShader | GPU time same -0.8% (-2.7% to +1.3%); CPU time same +0.0% (-12.6% to +14.3%); every work count and pixel identical. A frame cost 5.8 s of SwiftShader GPU time | `perf-ab-aa-cruise-horizon-2026-10-12.json` |
| A/A, `forest-500ft-sunbehind` and `water-25ft` | cloud session | GPU time same, +2.0% and -0.9%; CPU time did not clear `water-25ft` (+7.2%, +0.6% to +19.7%), the case the guard is for | `perf-ab-aa-forest-water-2026-10-12.json` |
| A known regression: the head's clouds at twice tier 1's resolution | cloud session | GPU time slower +8.1% (+5.5% to +11.3%); the cloud raymarch 153 → 601 ms and its workgroups 2,170 → 8,680, with identical frames | `perf-ab-positive-control-cruise-horizon-2026-10-12.json` |
| A/A with both arms in one browser, 8 rounds | cloud session | the same timings, but 279,159 pixels differ ("A browser per arm") | `perf-ab-shared-browser-aa-cruise-horizon-2026-10-12.json` |
| Pull request #20 (RCAS sharpen and ground grain) against main | cloud session | regression: one draw more, breaching both ceilings; GPU time +13.7% and +9.0%, nearly all in the main scene pass | `perf-ab-pr20-sharpen-grain-2026-10-12.json` |
| Effective A/A on the five default shots | `ubuntu-latest`, SwiftShader | GPU time same, -0.2% to +0.8%; one round scatters 0.15 to 0.33%, so the intervals resolve the browsers' offset; 20 to 36 minutes a shot, hence five parts | `perf-ab-swiftshader-runner-2026-10-12.json` |
| Effective A/A on the five default shots | `macos-latest` (Apple M1, virtual), frame wall time | 20 rounds of four frames: all inconclusive, a round scattering 13 to 23%. One frame a turn, 320 rounds: same on 12 of 15 shots. 640 rounds, the default: same on all five, ±0.8 to 1.6%, in 21 minutes | `perf-ab-macos-runner-2026-10-12.json` |

On the macOS runner the arms can come to rest holding one or two different resident terrain pages, since a page stays in the atlas until its slot is needed; the report gives the pages each arm wants (`wantedTerrainPages`), which matched on every shot, and at most 0.04% of a frame's pixels differed.

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
set from the A/A runs above (640, one frame a turn), but it times whole frames on a virtual GPU whose
speed differs from one runner to the next, so it is a second opinion on
SwiftShader's verdicts, from the GPU family that matters, rather than a gate.
Either can be started by hand (`workflow_dispatch`) with a base, a shot list,
a round count and further options; a shot list is split between the five parts
the same way. In `args`, a JSON value is written without quotes or spaces, for
example `--head-profile-override {"cloudResolutionScale":0.9}`. The report is
at the end of the A/B step's log and in the job summary.

**Compare CI parts on one CPU model.** Each SwiftShader part runs on whichever runner CPU it draws (so far an AMD EPYC 7763, 9V74 or 9V45), and the report's header names it. The models weigh work differently: the 9V45 runs about twice as fast as a 7763 and read the biomes PR's cruise at +3.7% against main where a 7763 read +1.0%, with passes the PR does not touch moving by 5 to 8%. Within one model, run-to-run spread is about 1%. So attribute a change only between parts on the same CPU model, and use the macOS runner's advisory A/B to break a tie.

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

## Flight stutter: `npm run perf:flight`

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
each leg reports whether vegetation is still generated on its worker (the
detail-worker verdict below). The
frame's own draws are dropped by default (`gpuDrawGate.ts`; `--draws` keeps
them), so on SwiftShader a frame costs its CPU work and its compute. CPU
milliseconds are this host's and only compare the arms; counts are exact.

**Options** (`npm run perf:flight -- --help` prints them):

| Option | What it does |
| --- | --- |
| `--base <ref>`, `--head <ref>` | the arms (default: the merge-base of HEAD and origin/main, and the working tree) |
| `--shot <name>` | the canonical shot to start from (default `approach-500ft`) |
| `--start <x,z[,yaw]>` | begin the flight here (world metres, yaw in degrees) instead of at the shot's pose |
| `--legs <n>`, `--leg-frames <n>` | legs per arm (default 6) and frames per leg (default 240, 4 s of flight) |
| `--speed <m/s>`, `--clearance <m>`, `--bank <deg>` | ground speed (default 120), height kept above the terrain (150), constant bank (0 flies straight) |
| `--burst-legs` | alternate the legs between 250 and 60 m/s instead (ABBA keeps each leg's speed equal in both arms) |
| `--park-legs` | hold still (0 m/s) on odd legs and fly on even ones: a stop on the runway, then the roll |
| `--camera chase\|cockpit` | default chase |
| `--weather clear\|breezy\|cloudy` | default clear, as the capture; the game's default is breezy |
| `--quality`, `--mode`, `--aircraft` | renderer settings (default medium, balanced, trainer) |
| `--draws`, `--fence-every <n>` | keep the frame's own draws (slow on a software adapter); fence to GPU idle every n frames (default 4) |
| `--base-world <json>`, `--head-world <json>` | options merged into that arm's `createWorld` (a landform or province under test) |
| `--kill-detail-worker <leg>:<frame>` | fail the vegetation worker in both arms before that frame of that leg (legs from 1, frames from 0) with an error event, as a crashed worker script |
| `--hang-detail-worker <leg>:<frame>` | the same, but terminate the worker with no event: a silent worker (a separate run from `--kill-detail-worker`) |
| `--settle-trials <k>`, `--trial-frames <n>` | after the legs, k independent fresh-region settles of n frames (default 600): in each, both arms at once build a new renderer and hold still over the next land start (a spiral out from the home airport that skips the sea), as in the stream to rest |
| `--emulate-hitch <ms>@<leg>:<frame>` | that frame stands for a main thread blocked `<ms>` while the simulation flew on: path and simulation time advance by `<ms>`, render()'s delta is FlightGame's clamp of it (0.1 s at most); every other frame stays 1/60 s |
| `--frame-dump <from>-<to>` | read those frames of the hitch's leg back as each renders (no extra render) and write them as PNGs under `<out>/frames`; needs `--emulate-hitch` and `--draws` |
| `--gpu swiftshader\|hardware`, `--chromium <path>` | the adapter (default hardware on macOS, SwiftShader elsewhere) and the browser |
| `--profile`, `--heap-profile`, `--no-minify` | a V8 CPU profile, and a V8 sampling heap profile, per arm per leg; unminified builds so profiles name functions (each moves the timings) |
| `--fail-on-worker-fallback` | exit 1 when the arm built from the commit under test TRIPPED (below) |
| `--under-test <ref>` | the commit `--fail-on-worker-fallback` asks about (default the head; name it when the arms are swapped) |
| `--out <dir>` | default `tests/perf/artifacts/flight/<timestamp>` |

**The detail-worker verdict** (`scripts/perfFlightVerdict.mts`).
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
  heartbeats it is a silence. The count is an estimate, not a bound.
- A worker failed on purpose (`--kill-detail-worker`, `--hang-detail-worker`)
  is not a trip: its leg and those after it say whether the runtime
  RECOVERED (restarted it; RECOVERING while the restart is due at its next
  update) or FELL BACK, and only trips beyond that failure count.
- With them: the longest charged span on each clock (presentation /
  generation), accepted worker builds' latency in wall ms, render() p50 and
  p95, heap allocated per frame, long tasks, frames per second, and head/base
  ratios for the first leg, the legs after it and the settle trials.

**The bake section** (`scripts/perfFlightBakes.mts`). The
renderer spreads two bakes over frames: the sky probe's re-light every 500 m
of climb, and the ground-cover tile below the blades' fade height. The agent
reads `FlightRenderer.getBakeStatsForCapture()` after every frame of a leg,
outside the frame's timed and heap windows (`tests/perf/ab/bakeProbe.ts`),
and `report.md` ends with a table for each:

- Sky: per arm and leg, over all legs and per settle trial, the sliced re-lights landed, their frames, the worst
  sliced frame's ms with its work (begin, advance, land, cube, LUT), the
  sliced frames at or over 1 ms, and the one-frame re-lights (a renderer's
  first frame, a teleport, an environment change: synchronous by design, so
  outside the 1 ms target). Each sliced re-light is then followed frame by
  frame from its begin to the frame after its LUT, with render() and the
  `flight-presentation` and `hdr-present` passes against their leg medians,
  because the specular cube's six faces render in the scene pass, outside
  the refresh's own ms (`report.md` follows the first 6 re-lights and lists
  the first 40 frames or calls of each list; `report.json` has them all).
- Ground cover: per arm and leg, over all legs and per settle trial, tile-bake calls, ms per call p50 / p95 /
  max, calls at or over 2 ms (the 1.5 ms budget and one 32 m step), those
  with neither a collection during render() nor a pace-floor hold,
  pace-floor calls and tiles completed, then each call at or over 2 ms with
  what its frame says.
- An arm that never reached a bake reads **Not exercised** with how to reach
  it: a re-light needs about 1,200 frames of climb (`--clearance 1500
  --speed 250 --legs 2 --leg-frames 720`); the tile bakes only below 55 to
  110 m above the ground, by tier (`--clearance 30 --speed 70
  --start=<x,z>`). A build without `getBakeStatsForCapture` reads n/a.
- The page is not cross-origin isolated, so the bake clocks read in 0.1 ms
  steps, and a reading at a target counts with those over it.

perf:flight builds both arms' renderers with the game's two terrain
samplers, the full sample and the height alone (`AgentConfig.gameTerrainHeight`,
`tests/perf/ab/terrainSamplers.ts`), so the ground-cover tile bakes in 32 m
steps as in the game. A build without `FlightRendererOptions.terrainHeight`
(before `69746b7`) ignores the second and bakes whole rows on the full
sample, as its game did; the report's settings line says so. perf:ab never
passes it, so its renderers and baselines are made as the capture's are
(`tests/perf-flight-bakes.test.ts`).

**Still open**: about 1.7 MB of garbage a frame, from the terrain clipmap's node selection and buffer writes (about 1 MB: per-node objects and string page keys) and the wildlife step (about 0.5 MB), which young collections absorb; and the sky probe's re-light, sliced over frames since 2026-10-25, still lands Babylon's spherical-harmonics converter in one call (0.5 to 3.9 ms on the macOS runner).

### Roads at jet speed

Roads stream round the observer (gravel 12 km, tracks 5 km, both leaning 20 s ahead along the velocity, in 2 km regions), and each road change rebuilds in place every resident terrain page whose domain it touches (`TerrainClipmapSystem.infrastructureChanged`). At jet speed that was most of the cost: a 250 m/s leg at 3,000 ft over road country cost about 3 ms more a frame with roads streaming than without, 0.6 ms of it the road code. So:

- While the observer moves faster than `ROAD_DEFERRED_MIN_SPEED` (50 m/s), rebuilds of pages of level 5 and coarser (16 km and wider, where a 7 m road covers under 5% of a texel) are pooled into one change, which goes ahead once it slows, stops or has travelled `ROAD_DEFERRED_MAX_TRAVEL` (8 km). A capture holds its aircraft still at the pose's speed, so it still waits for every page.
- The road index's streamed pack starts at 24,576 segments, 16,384 table slots and 131,072 list entries (about 2.7 MB on the GPU), so the jet's window (13,941 segments in 4,125 bins) packs without a rehash every 20 s.

The leg is `npm run perf:flight -- --base <ref> --legs 4 --leg-frames 360 --speed 250 --clearance 914 --start 7271,-37795,135`, and `scripts/road-stream-leg-probe.mts` replays its start and speed in Node. Over it the deferral took render() p50 from 12.5 to 11.0 ms and the vegetation's build latency p95 from 14 to 15 s to 4 to 8 s, against 1.5 to 1.8 s with roads off; a road change still marks its cells stale, which is the rest of that gap. Pinned by `tests/render.webgpu-terrain-roads-rebuild.test.ts` and `tests/render.infrastructure-gpu-bins.test.ts`.

## In-app benchmark (?bench=1)

`?bench=1` turns the game into a benchmark anyone can run in their own
browser, on the deployed build:
`https://jazonshou.github.io/fly-high/?bench=1`. It measures what a player's
machine does with the shipped game, tier by tier, so the tier work (PR B:
the governor's recovery and the 60 fps frame pacing; next, Auto moving weak
machines to Low) has a "before" and an "after" from real computers rather
than from SwiftShader. Without the
flag a player runs nothing new: FlightGame parses the URL once more and
finds nothing, the bench's code and styles sit in their own chunk that only a
dynamic `import()` under the flag fetches, and the frame loop is the one
players run (`tests/bench.inert.test.ts`). A player does download a little
more: the few game functions the bench calls and players do not (the spawn
and flight-state builders, the renderer's startup trace) live in modules the
entry chunk already holds, so the bundler keeps them there, which adds about
10 KB (4 KB gzipped) to the Pages entry chunk.

**How to run it.** Open the link, plug in the laptop, maximise the window
(full screen does not survive the reloads between flights), close games and
video calls, and press **Start benchmark**. The intro first checks the
machine: WebGPU (missing, no adapter, a software-only adapter or a limit
short of what the game needs each block the run and offer a device-only
report instead), the graphics adapter, the screen and the browser's idle
frame rate. The game then flies itself once per tier, reloading the page
between flights, and ends on the report. Do not touch anything, and keep the
tab in front: hiding the tab voids the flight in progress, as does resizing
the window or moving it to a screen with another pixel ratio; each flight
gets two tries. Esc, or the run chip's **Stop**, asks before it stops, and
the report then shows the flights that finished. Progress lives in one
tab-scoped `sessionStorage` key, `flyhigh.bench.v1`, which **Exit** clears; a
page that cannot read what the key holds (the game was updated mid-run, say)
says so and offers **Start over** and **Exit**. The player's settings
(`aerolith.settings.v3`) are never written, and the report carries their hash
at the start and the end to show it.

| URL parameter | What it does |
| --- | --- |
| `tiers=1,0,2,1` | the tiers to fly, in order (0 Low, 1 Medium, 2 High, 3 Ultra), one to eight; the default flies Medium, Low, High and Medium again |
| `mode=pinned` | the GPU comparison pass: each tier renders its whole pixel budget at a fixed scale, with per-pass GPU timing on, whatever the governor would do |
| `hud=0` | flies without the HUD (it is on by default, as a player sees it) |
| `fps=display` | the Frame rate setting every flight uses: `60`, `display` or `30`. Without it, shipped mode flies the players' default (60) and pinned mode Match display, so a fast display does not cap a GPU comparison; any other value makes the report non-standard. Run and step URLs always carry it |
| `quick=1` | for development: 20 s flights, and an 8 s settle cap with rest checks 30 frames apart so it can rest inside it; the report says it is non-standard |

**How long it takes.** Each flight is a page load, a 1 s idle frame-rate
probe, the renderer's start-up, a settle on the runway while the scenery
streams in, and 75 s of flight. The settle ends when three checks in a row
find nothing pending and the visible instance count unchanged, or at 20 s;
checks start at 4 s and are at least a second and 120 frames apart, because
each one walks the GPU memory inventory and the detail cells, so at 60 Hz the
earliest end is 10 s. The default four flights take about 7 minutes on a
typical machine and up to about 9 on one that is slow to start; the intro
shows the estimate for the chosen tiers. A flight under 5 fps from 3 s to
20 s stops there, because the rest would take minutes and say nothing new.

**The flight.** A player's first minute, the same on every machine: from the
runway threshold of the bench world (seed `00762m`), a 15 s roll from 0 to
60 m/s along the centreline, a 15 s climb-out from 60 to 120 m/s, then a
terrain-following cruise at 120 m/s and 150 m above the ground. Two windows
are measured: `ground`, from 3 s into the roll to lift-off, and `air`, from
30 s to the end. The headline numbers are the air window's.

**What the report says.** Every frame's interval is taken from the
`requestAnimationFrame` timestamps of the frame loop; the report gives, per
window, fps (1000 over the mean interval), the interval percentiles, slow
frames per 240 (over 27.4 ms; 60 ms on Ultra; at the 30 fps setting
twice its GPU target, the paced interval less 3.33 ms: 60 ms where 30
divides the refresh rate and 62.8 ms at 144 Hz; under the fallback the
same rule at the interval it draws, 60 ms at 60 Hz),
stutters over 50 and 100 ms, `render()`'s main-thread time, pipelines
compiled, long tasks, the governor's decisions and shares, and, in pinned
mode, GPU milliseconds. Each governor decision records whether its window
was urgent, the spent count, whether the governor was exhausted and the
even fallback's phase; the events count urgent sheds, exhausted windows,
and the fallback's engages, trials, failed trials, exits and settles. Each
flight also records its pacing: the frame-rate setting and what the build
does with it, the cadence at the first and last frames (the divisor, the
display rate, whether the rate was confirmed on ticks that drew nothing or a
faster period than any frame could make, and the fallback's rate while it
holds), and the bench's rAF ticks against the frames the game rendered.
Each interval is judged against the cadence that paced it, the one the
frame that ends it was drawn under: the pacer skips and draws by a new
cadence from the tick on which it sets it, so that cadence decided when
the frame before left the screen. At 60 Hz the first 33.3 ms interval of
the fallback is therefore the fallback's slot, not a missed refresh; an
interval the fallback paced is a hitch only past its threshold (60 ms) and
a missed refresh only past its slot plus half a refresh (41.7 ms), and the
vsync buckets count each interval in the slots of the cadence that paced
it. The frames drawn under the fallback are reported as
`pacing.fallbackFrames` and `fallbackShare`. A standard flight is 75 s, and the
fallback takes longer than that to engage on the machines it is for, so
`fallbackShare` usually reads 0; the bench is not the instrument for the
fallback. At every setting the game waits for its display probe's quiet
lead before it creates the renderer (0.3 s, up to 1 s where the first
frames come late or stall), which builds before PR B did not; the start-up trace charges
that wait to its first stage, WebGPU capability discovery, so that stage
reads up to 0.3 s longer than before PR B, and up to 1 s on such a start.
Each tier gets a plain label, the worse of its two windows:

| Label | Meaning |
| --- | --- |
| Smooth | p99 interval within the tier's slow-frame threshold, and at most 1 slow frame per 240 |
| Mostly smooth | at most 6 slow frames per 240 |
| Choppy | more than that, or the flight stopped early under 5 fps |
| Limited by browser or display at N fps | the browser or display held frames under 50 Hz (a power saver, a 30 Hz cap), so the tier says nothing about the game |
| Did not run | voided, failed, skipped or stopped |

The run's verdict checks the run against itself: the default plan flies
Medium first and last, and **valid** means those two flights' mean fps agree
within 10% and the window kept its size. The two are compared over the air
window, or, when either stopped early, over the stretch the early check
reads (3 s to 20 s), which both flew. **Void** means they did not (a
throttling laptop, another program, a window resized between them); those
two are the only rules that void a run, and every number is still in the
report. A check flight that fell back to the even rate while the other did
not is a warning, not a third rule: it names the flight and the share of its
frames drawn under the fallback, because that flight's fps mixes two
cadences. On Low the fallback can engage in a flight's last second, and
whether it does can depend only on how long the settle ran, so the two fps
can agree within 1% with only one of them fallen back; a fallback long
enough to move the compared fps by more than 10% voids the run by the first
rule.
**Incomplete** is a run that was stopped or whose check flight did not
finish, and **unchecked** a plan of one flight, or one that does not start
and end on the same tier. Everything else worth knowing (a display under 50 Hz, a refresh rate
that moved, a coarse timer, a settle that hit its cap, a battery
discharging, focus lost, a denied wake lock) is a warning beside the
numbers, and the first flight in the tab is marked, because it pays the
cold shader and pipeline caches.

**Where reports go.** **Download report (.json)** saves the full report
(`fly-high.bench/4`, `fly-high-bench-<vendor>-<time>.json`; a `/3` report
has no fallback fields and judged every frame against the cadence at the
flight's first frame, and its tier-0 governor could not fall back, so `/3`
and `/4` steps are not comparable at tier 0; the profiles of a `/4` report
carry `cadenceFallbackHz`, so their fingerprints differ from `/3`'s; a `/2`
report has no urgency, spent-window or exhaustion fields, judged the pixel
cap at the applied scale, and its governor shed without urgency, so `/2`
and `/3` steps are not comparable; a `/1` report was flown without frame
pacing); it is the one to keep. **Open GitHub issue** copies a compact
report to the clipboard and opens a prefilled issue to paste it into, and
**Copy short summary** gives a few lines for a chat. A report kept as evidence is
committed as `docs/evidence/bench-<label>-<ISO>.json`, where the label names
the machine (for example `bench-rtx3050-laptop-2026-10-26T09-14-03Z.json`),
and cited from here by that path. **Run the GPU comparison pass** flies the
same tiers in pinned mode and keeps the shipped run in the same report.

**Merge requirement.** The bench adds one read-only method to the renderer
(`readBenchProbe`) and exports one pure governor function, and changes
nothing else a player runs; the 39 reference pictures in
`tests/perf/baseline` must not move. Before merging, build Pages for the
base and the head and compare the entry chunk (`assets/index-*.js`): it
should grow by about 10 KB, and no session chunk or stylesheet should be
fetched without the flag. The Pages build writes the commit it
was made from into `index.html` as `<meta name="fly-high-commit">`, which
the reports name; no bundled file holds it, so a deploy renames no chunk. The Pages deploy waits only for the
`verify` job, so a green `gpu-tests` run on the pull request (the perf
capture against those pictures) is a merge requirement for the bench's pull
request.

## Rebaseline and draw-ceiling log

Newest first. Add a row for every baseline promotion and every draw-ceiling change, with the capture it came from. "Run" is a `gpu-tests` workflow run on the hosted macOS runner; a timestamp is a candidate directory under `tests/perf/artifacts/rebaseline-candidates/` on the reference Mac.

| Date | Change | Baselines | Draw ceilings | Source |
| --- | --- | --- | --- | --- |
| 2026-11-14 | Solid trunks and the leaf-card handoff (#47, `24f289e`) | 5: `grove-meadow-2m`, `ground-2m-lowsun` and `grove-forest-2m`, which failed their gates where trees stand 50 to 100 m off, and `apron-hangar-variety` and `approach-lights-outboard`, which moved inside theirs | none | capture of `732f642`, run 43648593383 |
| 2026-11-13 | Terrain realism, all steps, and block culling (#47, `873e3a0`, `ee332aa`) | all 39, from the capture of `7beb285`; 24 had failed a visual gate | 27 lowered to the counts three captures of `7beb285` agree on (runs 43417533903, 43417542941, 43422970097), none raised; the snapshot refreshed and the `final-sharpen`, `generated-buildings` and `tree-ground-shadows` raises spent. `ee332aa` removed `motion-banked-turn`'s ceiling ("The banked turn has no draw ceiling") | run 43417533903 |
| 2026-11-12 | Tree ground shadows (#47) | none (promoted with the rest on 2026-11-13) | 21 raised: sixteen by 1, four by 2 (`ground-2m-lowsun`, `runway-on-approach`, `grove-meadow-2m`, `horizon-shadow-far-annulus`), `canopy-backlit-lowsun` by 3; raise `tree-ground-shadows` for the thirteen in the snapshot | runs 43204262725 (two attempts, `1a7f1d3`) and 43218894856 (`8ded9e1`) |
| 2026-11-03 | Dusk lighting (#42) | 3: `blue-hour`, `dusk-mesopic`, `sunset-sunward` | none | capture of `65460e4`, run 41564357707 |
| 2026-11-03 | Generated buildings (#41) | none | 14 raised to their measured counts: the seven in the snapshot by raise `generated-buildings` (+1 on six, +4 on `page-thrash-turn`), the other seven outside the raise mechanism | runs 41360179301, 41363835761, 41368280700 |
| 2026-11-01 | Roads and the Land Cruiser (#37) | all 39 | none; fourteen shots left exactly at their ceiling | capture of `6df1197`, run 40928082863 |
| 2026-10-29 | Terrain texture: the sward's shadow and sheen (#32) | all 39 | none | capture of `7c31403`, run 40559669040 |
| 2026-10-27 | The Boats PR's sea (#31) | all 39 | none | capture of `f2c2d51`, run 40461650012 |
| 2026-10-24 | The sharpen fused into FXAA | none | every tier-1 shot reads its ceiling minus one; `final-sharpen` stayed until the 2026-11-13 re-pin spent it | CI run 40126495030 |
| 2026-10-20 | The sea's visible-facet sky (`4218a35`) | all 39 | none | run 39009665122 |
| 2026-10-17 | Sunset sky: each point's own sun (#22) | all 39 | none | capture of `e1407b8`, run 39005416151 |
| 2026-10-13 | Sharper scenery: RCAS sharpen and ground grain (#20) | all 39, the first promotion from the hosted macOS runner | 2026-10-12: all 32 raised by 1, the sharpen's pass, as raise `final-sharpen` (`ea99c02`), from runs 38217280044, 38221252437 and 38263651854 | capture of `96d09ef`, run 38295338700 |
| 2026-09-23 | All thirty-nine at the wildlife-pin churn point (`bd7a584`) | all 39, byte-identical to candidate `2026-09-23T04-50-34.261Z`; which shots moved is in `tests/perf/artifacts/rebaseline-candidates/2026-09-23T04-50-34.261Z/promotion-split.json` | **Re-pin 2026-09-23**: 21 re-pinned at `bd7a584` from that candidate and two normal captures (`2026-09-23T04-57-55.457Z`, `05-05-13.308Z`) that agree on every count; none rose, and `PREVIOUS_DRAW_CALL_CEILINGS` was refreshed. What had left them slack, from a draw-call bisection with the wildlife held out, is listed in `scripts/deliveryFloors.mts` | reference M2 Pro |
| 2026-09-23 | Eleven movers from the end of the aircraft wave (`e9d902d`) | 11, candidate `2026-09-23T02-15-57.995Z` | none | reference M2 Pro |
| 2026-09-22 | The aircraft wave, on the world-only perf cockpit rig (`bcfbea5`) | all 39, eight for the first time; candidate `2026-09-22T05-40-42.875Z` | 12 cockpit ceilings lowered to their exact counts (`bed4d51`) | reference M2 Pro |
| 2026-09-19 | W-11: sun glitter | 3: `water-400ft-glitter` (new), `water-25ft`, `water-3m`; candidate `2026-09-20T02-53-31.461Z` | none | reference M2 Pro |
| 2026-09-17 | W-7 to W-10: water colour | 16, candidate `2026-09-17T23-24-55.654Z` | none | reference M2 Pro |
| 2026-09-17 | W-1: the ground patchwork | 20, candidate `2026-09-17T23-40-35.447Z` | none | reference M2 Pro |
| 2026-09-14 | The far field, second pass (wave S) | 8 sea shots, candidate `2026-09-14T21-39-26.316Z` | the real +1 on the moving `slant-10km` and `cdlod-transition`, as raise `tree-lod-residency-lead` | reference M2 Pro |
| 2026-09-14 | The far sea keeps its variance (wave S) | 8, candidate `2026-09-14T19-50-42.206Z` | none | reference M2 Pro |
| 2026-09-14 | Tree LOD continuity: the impostor fill | 19 of 30, candidate `2026-09-14T19-12-19.208Z` | none | reference M2 Pro |
| 2026-09-03 | The rendered ocean | all 30 images, candidate `2026-09-03T15-48-09.890Z`; the per-shot rows and delivery floors unchanged | none | reference M2 Pro |
| 2026-09-01 | R4 | all 30 at `090bf2f`; delivery floors derived from three idle-host runs | | reference Mac |
| 2026-08-31 | Phase 6 R1 to R3 | 24, candidate `2026-08-31T16-39-53.222Z`: the first rows of the per-shot table | | reference Mac |

## Measured costs

Newest first. "SwiftShader" is the cloud A/B's gating GPU time on the default shots; "macOS" is the macOS runner's advisory frame wall time. The full write-ups are in `git show 70fb152:docs/PERFORMANCE.md`.

| Date | Change | What it cost |
| --- | --- | --- |
| 2026-11-14 | Solid trunks and the leaf-card handoff (#47) | No count of GPU work changes. SwiftShader `forest-500ft-sunbehind` +1.9% (the vertex stage, which SwiftShader runs on the CPU) and `ground-2m-lowsun` +0.0%; macOS +0.0% and 5.6% faster. A first cut that scaled the leaf picture inside a full-size card cost 6 to 7% and was dropped. |
| 2026-11-13 | Culling a batch by blocks (#47) | 2 to 35 µs a frame. Draws on the 32 ceiling shots 6,110 → 5,918. macOS against main with all of #47: `mountain-close` -2.7% (+22.2% before block culling), `terrain-material-1600ft-down` +0.5% (+10.6%), `ground-2m-lowsun` 6.1% faster; `hamlet-300ft` +4.8%, four added batches all in view, about 0.1 ms on the reference Mac. |
| 2026-11-13 | The ground up close (#47) | SwiftShader `ground-2m-lowsun` +0.9%, `cruise-horizon` +0.4%. |
| 2026-11-12 | Bushes and boulders (#47) | SwiftShader `ground-2m-lowsun` -2.6%, `hamlet-300ft` 11.1% faster (fewer alpha-tested cards at range); `VEGETATION_DRAW_CEILING` rose from `[50, 58, 440, 515]` to its current values; about 1 MiB of GPU memory. |
| 2026-11-12 | Open ground's own trees (#47) | SwiftShader `cruise-horizon` -0.9%, `hamlet-300ft` +0.3% with 233 → 246 draws; handing thin stands to their impostors early took the hamlet to 236 and `water-25ft` from 232 to 226. |
| 2026-11-12 | Tree ground shadows (#47) | One draw per presentation chunk in range. SwiftShader +0.3%, +1.1% and +2.5% (approach, forest, ground); macOS -0.2 to +2.5%; GPU memory +0.15 MiB on Medium and High, +0.92 MiB on Ultra. |
| 2026-11-03 | Generated buildings (#41) | At most four draws, whatever the number of buildings, on one material. SwiftShader -0.4 to +0.4% on a 7763 rerun (one +4.0% read was the 9V45 runner); macOS +1.0 to +1.7%, all same. |
| 2026-11-02 | Dusk lighting (#42) | Two more exponentials per sky fragment, a few dozen flops a frame on the CPU inside the twilight window; draws and GPU work unchanged. |
| 2026-11-01 | Roads and the Land Cruiser (#37) | One draw more on sixteen shots, a road surface in view. SwiftShader +0.9 to +3.9%, all same; macOS same on four, `approach-500ft` inconclusive at +3.5%. |
| 2026-10-28 | Roads at jet speed | About 3 ms a frame at 250 m/s before the coarse-page deferral ("Roads at jet speed"). |
| 2026-10-27 | Terrain texture: crunch and sward specular (#32) | No new texture reads, textures, passes or draws. SwiftShader -0.9 to +1.2%, macOS -1.1 to +0.7%. |
| 2026-10-27 | Pipelines compiled off the frame | Worst nose-down frame on the macOS runner 0.62 to 1.75 s → 0.12 to 0.34 s, and no pipeline built inside a frame ("Frame architecture"). |
| 2026-10-26 | The home marina | Four meshes drawn by distance and fixtures in the light-point draw; +2.1 MiB of static buffers in every session; `water-25ft`, the shot nearest it, same (-0.1%). |
| 2026-10-25 | The vegetation worker's watchdog (choppiness on Medium) | The presentation watchdog took a busy worker for a dead one, and the failover generated every cell on the main thread for the rest of the session. On the macOS runner main tripped in 4 of 10 arms while a region settled; the fix (heartbeats, respawn, credit-paced inline cells: "Detail and wildlife") in none of 22. |
| 2026-10-25 | Tree species from the climate temperature | None; no shot sees a changed tree. |
| 2026-10-24 | Volcanic land | All five same; +5.6 MiB, the two material layers ("Volcanic fields"). |
| 2026-10-24 | Sand seas | Nothing per frame; bakes 15 to 25% longer on SwiftShader ("Landforms: sand seas"). |
| 2026-10-24 | Spawned airports and autoland | Default shots same (-0.3 to -2.6%). A spawned field in view adds about 7 draws, 50 k triangles and 2.0 MiB on Medium, and a spawn compiles no pipeline. |
| 2026-10-24 | The far climate province field | About 2.2% of the cruise frame after the per-texel bake ("Terrain and world paging"). |
| 2026-10-24 | The sharpen fused into FXAA; the ground grain read at an explicit mip | SwiftShader -0.2 to -0.5%, with one draw and 3.0 MiB less on every tier-1 shot; the explicit mip -0.6 to +0.4%. |
| 2026-10-24 | Tropical coast: palms and the reef sea | All same; every tier's GPU memory estimate 0.76 MiB lower, since evergreens bake one impostor layer. |
| 2026-10-24 | Pull requests #19, #20 and #22 together, against `264b760` | SwiftShader +3.7 to +6.4%, macOS +1.9 to +4.8%: why a feature is budgeted at about 2%. |
| 2026-10-20 | The sea's visible-facet sky | SwiftShader `approach-500ft` +1.6%, `cruise-horizon` +4.7%. |
| 2026-10-17 | Sunset sky: each point's own sun (#22) | The final cut (`e1407b8`) +1.4 to +4.5% on SwiftShader, which runs both sides of every branch; a real GPU skips the per-point sun above a 33° sun. |
| 2026-09-19 | W-11: sun glitter | Within ±0.25% on the reference Mac, inside its noise floor; draws identical. |
| 2026-09-13 | Tree LOD continuity: the impostor fill | `forest-line-highsun` 101.5 → 101.1 fps on the reference Mac. |
| 2026-08 | Vegetation shadows off below tier 2 (`4.5-C1`) | 445 → 397 draw calls at the reference viewport. |
| 2026-08-25 | The visual fix-pack | ALU-only additions inside existing passes; the near-band crown fringe cost about 4 ms of p95 at its first size and shipped at half that size for about 0. |
