# WebGPU performance strategy

fly high's active renderer is a Babylon.js `WebGPUEngine` implementation. It keeps memory, generation, simulation, and draw work bounded while the deterministic coordinate space remains effectively endless.

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
| Terrain | Analytic worlds use the GPU kernel. Eroded worlds eagerly build the canonical 1024² macro field in a CPU Worker, then run the deterministic bounded page reference in a second CPU Worker with one page in flight; the simulation Worker samples L0 → macro → analytic recovery. | Completed r32float atlas pages feed the CDLOD ground; eroded worker bytes upload through the same atlas and become visible only at final publication. |
| World-page contract | CPU page keys, quantized payload validation, lifecycle/cache metadata, velocity priority, and the canonical flow/lake/soil/shore fields | Defines heterogeneous upload/residency boundaries; it does not itself issue draw work |
| Ocean | Native WebGPU compute: spectrum initialization/evolution, Stockham 2D IFFT, displacement, normals, Jacobian, and foam | WGSL displaced water with Fresnel, GGX sun glint, sky/cloud response, foam, and probe-fed environment reflections (the planar capture is retired, 2-10) |
| Rivers and lakes | Eroded worlds extract one deterministic channel graph from the canonical macro export. Explicit analytic compatibility worlds retain the velocity-ahead tracer Worker and scheduled CPU fallback. | Graph-backed or legacy geometry uses the shared WGSL water response and bathymetry depth field. |
| Clouds | Procedural density is evaluated during the WGSL fragment ray march | Low-resolution integration, ping-pong temporal resolve, representative-depth composition, and a bounded transmittance map sampled by world-space receivers |
| Atmosphere | CPU solar position, transmittance LUT bake, and per-frame haze binding | Analytic HDR WGSL sky and aerial perspective from one shared closed-form Rayleigh/Mie/ozone integral; Babylon fog is permanently off |
| Trees, rocks, shrubs | Deterministic CPU detail-cell generation and LOD selection | Spatially chunked Babylon thin instances with per-instance color and tree wind deformation |
| Wildlife | Deterministic CPU population and bounded fixed-step AI | Interpolated current thin-instance transforms for procedural animals |

The spectral ocean remains the only active general-purpose GPU *simulation* in
the frame. Terrain also uses compute for analytic page generation and channel
bakes, and bathymetry uses compute for bounded toroidal strip updates. Phase 5
erosion itself is presently a deterministic CPU-worker reference, not the
plan's final GPU erosion implementation. Clouds are a fragment-shader volume
ray march, not an FFT or compute-fluid simulation. This distinction is
load-bearing when attributing worker CPU time, upload time, and GPU shading.

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
| Height-blend max materials (3-6) | 2 | 3 | 4 | 4 |
| Shadow map (`4-8b`) | 1,024 | 1,280 | 1,536 | 2,048 |
| Shadow cascades (`4-8b`, D15) | 2 | 2 | 3 | 4 |
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
| Vegetation density multiplier | 0.45 | 0.75 | 1.00 | 1.00 |
| Active-animal budget | 16 | 48 | 128 | 128 |
| Frame target | 13.7 ms | 13.7 ms | 13.7 ms | 30 ms |

Ultra's material array edge is 512², not §5.3's published 1024²: `3-1`
synthesises the ten layers on the CPU (measured 1.07 s at 512², ~4.3 s at
1024²), and several seconds of blocked main thread at startup is not worth a
resolution the de-tiling warp and 16× anisotropy largely mask. The row reopens
if synthesis moves to GPU compute. Both arrays together are 6.7 MiB at tier 0
and 26.7 MiB above it, derived from the tier's edge rather than declared, so
the memory row cannot disagree with the knob.

These are profile values, not claims that each row owns a separate framebuffer. The spectral configuration defines all five requested cascades, so the active allocation is 3/4/5/5. Terrain tiers retain the inexpensive far levels needed to reach the 45 km far plane (guaranteed coverage is 512·2^rings meters; tier 0 stops at 32.8 km behind ~89% haze opacity); quality changes near-page vertex density rather than exposing a finite terrain edge. Tier 3 is a 30 fps tier that spends its frame on pixels.

`worldEvolution` is world content and is invariant across this tier table. The
Phase-5 memory rows in `PerformanceBudget.ts` deliberately reserve the target
GPU macro, erosion-scratch and channel-graph layouts even though the current
reference producer owns those structures on CPU. They are conservative
headroom reservations, not measured live GPU inventory. The two 1024² R16F
bathymetry textures are a live 4 MiB allocation; the macro height additionally
has a read-only GPU storage upload for bathymetry sampling. A local
production-shape CPU-reference run for seed `phase5-production-benchmark`
measured 3,174 ms sampling uplift/erodibility/repose plus 4,323 ms evolution,
7,497 ms total. That result misses the 1.5 s load target and is neither a
reference-machine nor final-GPU acceptance measurement. No measured per-page
erosion cost is claimed here.

The default-eroded startup critical path is longer than the macro algorithm
alone. `FlightRenderer.create()` starts and awaits macro evolution, initializes
the bathymetry clipmap from that authority, then completes scene readiness and
terrain pre-warm; only after the renderer resolves does the game construct the
simulation client and begin its frame loop. A bathymetry WGSL declaration used
the reserved word `target`; Babylon stopped polling its failed
`dispatchWhenReady` path but left the Promise pending, so this sequence could
hold the load screen forever without surfacing an error. The declaration is now
`targetTexel`, the module is compiled by a real-adapter test, bathymetry compute
readiness rejects on compile error, timeout, abort or disposal, and the renderer
owns an outer startup deadline. A clean default-eroded development reload
reached the start screen in **11,098 ms**; a cache-busted navigation against the
built production server reached it in **13,255 ms** and then entered the cockpit
with no current error. Full Node/build verification and all **28 files / 50
tests** in the Chromium WebGPU suite pass. These timings are local functional
checks, not cold/reference-machine measurements, and do not satisfy the 1.5 s
target.

Terrain page resolution, ocean presentation density, FFT topology, and every other renderer budget follow the resolved tier rather than raw scenery quality alone. Live tier changes replace resident terrain pages behind their existing geometry and build new ocean compute textures/pipelines before atomically swapping them. The ACES/FXAA post stack is the same across quality profiles.

## Terrain and world paging

Phase 4 replaced the CPU geometry-clipmap outright. Phase 5 keeps that
presentation spine and changes the height authority behind it:

- **The default world is eroded; analytic is explicit compatibility.** Startup
  begins a cell-centred, world-anchored 1024² × 512 m macro evolution in a
  Worker while device resources are constructed, and waits for the canonical
  result before eroded terrain, graph hydrology, and bathymetry become visible.
  The runtime export is tier-independent and reused by every consumer.
- **The current erosion implementation is the CPU reference.** A second Worker
  executes fixed priority-breach, MFD/stream-power and talus operators inside a
  64-texel halo. The atlas admits one page at a time so stale flight-path work
  cannot fill the queue. Height and accumulation seed directly from the macro
  authority plus band-limited fine detail; a resident-parent dependency chain
  is not part of the current implementation. The full runway earthworks mask
  is protected from erosion, and the production page generator supplies
  deterministic strictly-downhill, acyclic receiver overrides that route
  drainage around its perimeter.
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
- **Analytic pages are GPU-generated; eroded pages are worker-generated.** The
  analytic path retains one compute dispatch per admitted batch and the
  `4.5-B1` split publication of texels before bounds. The eroded path transfers
  one final stored page, uploads it into the same r32float atlas, and withholds
  residency until its complete generation DAG and L0 collision publication
  finish. It never exposes a half-evolved slot.
- **Detail and wildlife share the collision height ladder.**
  `TerrainConsumerAuthority` adapts L0 → macro → analytic height, normal and
  slope for those consumers while leaving the established analytic climate and
  material fields intact. Eroded worlds therefore do not place ecology against
  a second, analytic-only ground surface.
- **One meter paces every terrain producer.** Analytic height generation,
  occlusion and splat bakes feed measured GPU dispatch costs back from
  `timestamp-query`. The CPU-reference erosion client uses the reserved
  `erosionCompute` admission as a pacing boundary, but supplies no GPU timing
  sample; its seeded cost is not evidence of measured erosion performance. A
  measured analytic height page costs ~1.9 ms of GPU, more than the whole
  compute cap, so the highest-priority client with demand retains the floor of
  one dispatch.
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

## Spectral ocean and inland water

The ocean is the renderer's native WebGPU compute workload:

- Seeded Gaussian initialization builds band-limited JONSWAP-style spectra.
- Time evolution produces conjugate frequency-domain waves.
- Horizontal and vertical Stockham passes perform the 2D inverse FFT.
- A derivation pass produces half-float displacement and normal/foam textures from float working textures. Jacobian compression drives breaking-wave foam, which decays temporally.
- Tier 0 allocates 128² with three cascades; Tier 1 allocates 128² with four; Tiers 2 and 3 allocate 256² with all five. The fifth cascade covers the largest 16,384 m patch and updates every eighth frame. Active cascades span different patch lengths and update cadences so farther, slower bands need not dispatch every frame.
- The camera-centered ocean presentation surface is a single crack-free 40 km radial grid. Tiers 0/1 use 96×128 or 144×192 radial/angular topology and tiers 2/3 share 192×256; a fifth-power distribution concentrates sub-metre radial spacing near the aircraft and grows cells toward the hazed far plane.
- The WGSL surface combines multi-cascade geometric displacement with per-fragment slope/normal and foam sampling, dielectric Fresnel, GGX sun glint, sky/cloud color, depth tint, and height-aware cloud transmittance on direct sunlight. Ocean and inland-water shaders also bind Babylon's existing cascaded-shadow depth array through its public matrices and comparison sampler; cascade splits/blends follow live quality changes, and only direct solar glare/scatter is attenuated. This reuses the terrain/scenery shadow render instead of scheduling a water-only pass. Environment reflections sample the shared sky environment probe cube with roughness-mapped mips; the planar scene capture that used to add nearby geometry is retired (2-10), and its surviving receiver contract idles at zero validity so the analytic sky/cloud response remains the fallback.
- Lower-cadence far cascades accumulate elapsed time before applying foam decay, so their half-life is independent of update cadence. Live quality changes initialize replacement compute resources before swapping away the active ocean.
- A shared two-level bathymetry clipmap stores `bedElevation − seaLevel` at
  16 m/texel over 16.4 km and 128 m/texel over 131 km. Both 1024² levels are
  R16F and update only newly exposed toroidal strips after their initial fill.
  Analytic mode samples the historical terrain kernel exactly. Eroded mode
  bilinearly samples the canonical cell-centred macro height and blends back to
  analytic across the macro domain's 16-texel rim. It does **not** currently
  overlay resident L0 erosion pages; that planned authority refinement remains
  open.
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

## Detail and wildlife

World detail is deterministic and page-owned rather than attached to transient terrain meshes (villages and buildings were deleted in 1B-5; the airfield is the only settlement content):

- Default detail cells are 512 m. Terrain biome, slope, moisture, height, and deterministic hashes choose tree and shrub species and rock variants.
- Near and mid LODs use deterministic far thinning. Velocity-ahead selection reduces pop-in during fast travel.
- Generation is cooperatively time-sliced to 0.75, 1.25, or 2 ms per update, with hard caps of 8, 16, or 24 cells and resident caps of 128, 384, or 896 cells for the three effective density bands. At least one pending cell is admitted so streaming cannot starve when a dense cell exceeds its target slice.
- Thin-instance batches reuse low-poly procedural species/building topology and shared materials, and are partitioned into deterministic 8×8-cell presentation chunks. Each batch owns its lightweight Babylon `Geometry` because instance streams are geometry-owned; this prevents one chunk from replacing another chunk's GPU buffers. Babylon frustum-culls the resulting conservative prototype-aware bounds independently, so one visible tree no longer submits every offscreen resident instance.
- Presentation synthesis is a second bounded stage after cell generation. The dedicated detail Worker retains the generated cell object graphs behind non-reused tokens, advances exactly one immutable packed chunk in at most 4,096 synthesis units or 4 ms per macrotask, and transfers exact 32-byte instance streams and bounds to the main thread. The main thread owns only lightweight resident descriptors, validates every token, batch key, byte length, bound and entity/record envelope before adoption, then synchronously publishes the complete result while the old chunk, statistics, mesh identities and GPU buffers remain live. A corrupt, silent, or unavailable Worker fails closed to the bounded inline builder, which retains its 65,536-unit/3 ms update cap; authority-level generation and presentation watchdogs cannot be reset indefinitely by motion. Exact cell-to-observer lower bounds skip only arrays for which the legacy per-item radial predicate would reject every placement. Frontier targets are reevaluated at their documented 64 m quantum independently of the coarser paging signature; a completed observer-sensitive snapshot farther than the 96 m membership/ground-cover validity envelope is canceled rather than published. If an abnormally slow machine lets the previously published snapshot cross that boundary first, its meshes are disabled fail-closed while retaining their CPU writers and WebGPU buffers; the valid replacement re-enables them only through the normal synchronous commit. This suppression remains explicit pending detail work, so it cannot masquerade as stable capture or shorten GPU resource lifetime. Superseding ordinary observer/cell signatures otherwise drain after the finite snapshot so continuous motion cannot starve publication; representation or floating-origin changes cancel safely, and a rebase translates live, non-suppressed chunks immediately. CPU writers/bounds are pooled at one spare per prototype. Existing GPU buffers update in place when capacity permits; growth and removal use the unchanged submission-safe pool/grace path so an unsent WebGPU bundle can never reference destroyed instance storage. Renderer diagnostics count unfinished detail cells and staged/backlogged chunks, and deterministic capture settling requires that count to reach zero before any shot may be accepted or published as a candidate.
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

- The scene has no active prepass or TAA pipeline. Engine context antialiasing is disabled; MSAA lives on the offscreen beauty target owned by the scotopic-vision post-process (1B-11), at the per-tier sample counts above. FXAA is the sample-count-1 fallback.
- An explicit full-resolution `ImageProcessingPostProcess` uses a half-float texture and the scene's ACES configuration with exposure 1.08 and contrast 1.04.
- A full-resolution `FxaaPostProcess` follows tone mapping and writes through an unsigned-byte target. There is no active bloom or sharpening stage.
- The device pixel ratio is capped per tier (1/1.5/2/2) and the total scale product is clamped by the tier's absolute pixel cap (1A-6a) — no display can raise rendered pixels past it.
- Two governors adapt per 120-frame window (1A-6b, repaired by R-11): Governor A uses presentation interval minus measured CPU time as its normal GPU/pacing proxy, steps resolution by 0.05 down / 0.025 up to a 0.75 floor, undoes and latches against steps that do not improve the same timing domain, and — when latched or floored — sheds GPU-cost work levers (cloud-shadow cadence, shadow-caster distance, vegetation distance). Governor B sheds CPU-cost levers (terrain-page requests, detail generation slice, animal budget) only on CPU-bound windows. Explicit timestamp captures can substitute a GPU signal, but unlike the old policy normal gameplay does not burn frame time merely to decide how to save it.
- Diagnostics additionally track a rolling 600-frame window for p95s and the Z-2 hitch metrics (max frame, p999, hitch count against 2× the tier frame target); >250 ms stalls are counted there even though the governors' own p95 ignores them.

## Diagnostics and regression testing

The performance overlay exposes:

- FPS, current frame interval, and start-to-start frame-interval p95.
- CPU frame time; explicit diagnostic captures also expose labelled GPU timing epochs and sample freshness.
- Draw calls, triangles, geometries, and textures.
- Resident terrain pages and visible detail/wildlife thin instances.
- Active animals and river/lake counts.
- Requested rendering mode, active render scale, cloud step request, and ocean FFT resolution/cascade count.
- WebGPU adapter label, backend, and render-technique identifier. The fallback reason is always `null` for a successfully created renderer because there is no alternate backend.

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
  renderer meets and `VEGETATION_FRAME_DEBT_RATIO` is the gap.
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
- **§7's next lever down does not measure.** `grassRadiusMeters` 150 → 110 at
  tier 1 is ranked at "~7 ms extra in ground-level shots". It moves
  ground-cover instances 3,372 → 1,836 at the `ground-2m-lowsun` pose — the
  knob works — and that shot's GPU p95 by 0.11 ms, which is noise. Left at
  §5.3's Balanced row; `6-11` owns the re-tier and now has a measurement to
  start from rather than an estimate.

## Current measured tier row

The earlier 15–20 FPS measurements were traced to continuous Babylon WebGPU
timestamp observers, not to unmeasured compositor idle. Babylon resolved and
mapped timestamp buffers through extra submissions while returning only 49
whole-frame samples in a 240-frame window. A controlled reference A/B measured
86.92 FPS / 13.6 ms p95 with those observers enabled and 120.25 FPS / 8.9 ms
p95 with them disabled: a 4.7 ms p95 tax and 38% throughput loss. Gameplay now
uses the interval-minus-CPU governor signal; timestamp observation is an
explicit create-time diagnostic only.

The following is the complete reviewable same-host WebGPU candidate written at
`tests/perf/artifacts/rebaseline-candidates/2026-08-25T04-26-48.235Z` on Apple
Metal 3 / headless Chrome 151, medium/balanced, with 240 measured frames per
shot after deterministic residency drain. The normal shots use the shipped
0.86 render scale; `reference-viewport` retains its 1.485 Mpx scale-1
cap-stress contract.

| Shot | raw wall FPS | interval p95 | >16.67 ms | >27.4 ms | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `approach-500ft` | 117.33 | 10.8 ms | 0 | 0 | 12.2 ms |
| `slant-10km` | 119.90 | 9.6 ms | 0 | 0 | 12.2 ms |
| `high-10000ft-down` | 120.02 | 9.8 ms | 0 | 0 | 10.5 ms |
| `reference-viewport` | 103.43 | 12.7 ms | 0 | 0 | 14.0 ms |
| `cruise-horizon` | 119.93 | 9.3 ms | 0 | 0 | 10.4 ms |
| `winter-noon` | 119.74 | 10.3 ms | 0 | 0 | 12.3 ms |
| `night` | 119.75 | 9.7 ms | 0 | 0 | 11.8 ms |
| `motion-banked-turn` | 94.94 | 12.9 ms | 3 | 0 | 18.7 ms |
| `page-thrash-turn` | 102.43 | 12.2 ms | 0 | 0 | 13.1 ms |
| `cdlod-transition` | 119.90 | 9.8 ms | 0 | 0 | 10.7 ms |
| `cruise-sun-30` | 119.89 | 10.0 ms | 0 | 0 | 11.0 ms |
| `forest-500ft-sunbehind` | 105.09 | 12.4 ms | 0 | 0 | 13.4 ms |
| `coast-10km-lowsun` | 119.88 | 9.9 ms | 0 | 0 | 11.6 ms |
| `ground-2m-lowsun` | 110.24 | 11.1 ms | 0 | 0 | 13.1 ms |
| `canopy-1200ft` | 105.03 | 12.1 ms | 0 | 0 | 13.9 ms |
| `runway-on-approach` | 102.73 | 11.9 ms | 0 | 0 | 13.7 ms |

All sixteen clear the strict FPS, p95, hitch-count and maximum-frame contract:
the minimum wall throughput is 94.94 FPS, the worst p95 is 12.9 ms, there are
no intervals over 27.4 ms and no hitches. Every final terrain/detail pending
count is zero. The raw-device validation listener, Babylon/console gates, GPU
drain, black/uniform-frame policy and temporal checks all passed before the
candidate was written. Independent review of every image found the formerly
black approach populated, the high-altitude terrain free of categorical
altitude lobes and Rock screen-door pattern, continuous winter snow, a straight
analytic runway edge, and continuous close-tree bark/crowns.

The candidate is review evidence, not an automatic baseline mutation. The
committed baseline remains byte-for-byte untouched; deliberate promotion is a
separate action after review, and performance ceilings cannot be rebaselined
downward.

## Capture harness

`npm run perf:capture` renders the committed shot list against
`tests/perf/baseline`. Notes that matter when reading its output:

- A normal capture treats `tests/perf/baseline` as strictly read-only and
  hard-fails a missing or dimension-mismatched committed image. Diagnostic
  screenshots and `report.json` are written only to the ignored
  `tests/perf/artifacts/` directory.
- `npm run perf:capture:candidate` cannot be filtered. It buffers the exact
  full canonical shot set, applies the visual, temporal, renderer-error and
  strict tier-1 performance gates, and only then writes
  a fresh timestamped directory beneath
  `tests/perf/artifacts/rebaseline-candidates/` for review. It has no baseline
  promotion path; copying an approved candidate into the committed set is a
  separate, deliberate review action.
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
  a startup Promise that never settles. Cold default-eroded time-to-ready,
  startup-stage timings, timeout and console-error status are a separate
  measurement; the 11,098 ms development reload and 13,255 ms built-server
  navigation above are diagnostic evidence, not that acceptance result.

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
