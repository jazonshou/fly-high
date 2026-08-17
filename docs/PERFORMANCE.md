# WebGPU performance strategy

fly high's active renderer is a Babylon.js `WebGPUEngine` implementation. It keeps memory, generation, simulation, and draw work bounded while the deterministic coordinate space remains effectively endless.

## Runtime contract

- WebGPU, Web Workers, and a hardware-accelerated adapter are required. Startup requests a high-performance adapter and rejects a software/fallback adapter.
- There is **no WebGL fallback and no Canvas fallback**. An unsupported device receives a startup error rather than a reduced renderer.
- The engine runs with compatibility mode disabled, a right-handed scene, reversed-Z depth, no MSAA, a 0.08 m near plane, and a 120 km far plane.
- The optional `timestamp-query` feature enables GPU timing in diagnostics. It is not required for rendering.
- Device loss is terminal for the current renderer instance. Simulation/rendering pause and the user must reload to recreate the adapter, device, and every GPU resource.
- WebGPU normally requires a secure browser context; local development at `localhost` is accepted.

## Frame architecture

The game-owned frame graph declares system order while Babylon owns WebGPU command encoding, attachment transitions, and submission:

| Order | Pass | Work |
| ---: | --- | --- |
| 1 | `flight-presentation` | Aircraft transform, camera, and atmosphere state. |
| 2 | `world-page-visibility` | Terrain pages, detail cells, wildlife, and velocity-aware residency/LOD. |
| 3 | `shared-planar-water-reflection` | One manually scheduled, opaque-only scene capture for the ocean or nearest relevant lake. |
| 4 | `spectral-ocean-compute` | Ocean compute dispatches plus paged river/lake material updates. |
| 5 | `volumetric-cloud-integration` | Low-resolution cloud integration, temporal resolve, and world-space transmittance projection. |
| 6 | `hdr-present` | Babylon scene render, half-float ACES image processing, final FXAA, and presentation. |

The renderer makes its floating-origin decision immediately before frame-graph execution. Camera cuts, floating-origin shifts, display resizes, atmosphere/profile changes, and dynamic-resolution changes invalidate the cloud system's temporal history through the graph. Floating-origin rebases occur on a 2,048 m grid after either horizontal camera-relative component reaches 4,096 m. Absolute world coordinates remain in the simulation and deterministic generators; only render-facing positions are rebased.

## CPU and GPU ownership

“WebGPU renderer” does not mean that all procedural work is a compute shader. The current split is intentional:

| System | Generation/simulation | GPU presentation |
| --- | --- | --- |
| Flight model | Dedicated Worker, fixed 120 Hz; 60 Hz snapshots | Interpolated procedural aircraft meshes |
| Terrain | Deterministic CPU sampling in the terrain Worker, with a deferred CPU fallback | Babylon PBR geometry-clipmap pages |
| World-page contract | CPU page keys, quantized payload validation, lifecycle/cache metadata, and velocity priority | Defines upload/residency boundaries; it does not itself issue draw work |
| Ocean | Native WebGPU compute: spectrum initialization/evolution, Stockham 2D IFFT, displacement, normals, Jacobian, and foam | WGSL displaced water with Fresnel, GGX sun glint, sky/cloud response, foam, and a bounded scene-reflection capture |
| Rivers and lakes | Deterministic, velocity-ahead region generation in a cancellable Worker, with a scheduled CPU fallback | Crossfaded flow-aligned meshes with WGSL ripples, Fresnel, sun/sky/cloud response, and nearest-lake scene reflection |
| Clouds | Procedural density is evaluated during the WGSL fragment ray march | Low-resolution integration, ping-pong temporal resolve, representative-depth composition, and a bounded transmittance map sampled by world-space receivers |
| Atmosphere | Small CPU preset/state updates | Analytic HDR WGSL sky, Rayleigh/Mie-style scattering, sun, ambient, and fog |
| Trees, rocks, villages | Deterministic CPU detail-cell generation and LOD selection | Spatially chunked Babylon thin instances with per-instance color and tree wind deformation |
| Wildlife | Deterministic CPU population and bounded fixed-step AI | Interpolated current thin-instance transforms for procedural animals |

The only active general-purpose GPU compute simulation in the current frame is the spectral ocean. Terrain, hydrology, ecology/settlements, and wildlife are deliberately CPU-generated or CPU-simulated and rendered through WebGPU. Clouds are a fragment-shader volume ray march, not an FFT or compute-fluid simulation. This distinction is important when profiling CPU generation versus GPU shading.

The flight simulation never depends on render cadence. Its collision path also avoids paying for visual biome/material sampling: a dedicated terrain query returns only height, normal, runway state, and friction; ordinary airborne steps use a height-only early reject before requesting per-wheel normals; high-AGL telemetry can reuse a center height; and the exactly flat airport platform bypasses terrain noise. These CPU savings remain independent of the rendering overhaul.

## Resolved quality tiers

Scenery quality and rendering intent are combined into one effective tier:

| Scenery quality | Performance | Balanced | Ultra |
| --- | ---: | ---: | ---: |
| Low | 0 | 0 | 1 |
| Medium | 0 | 1 | 2 |
| High | 1 | 2 | 2 |

The effective tier resolves these bounded targets:

| Budget | Tier 0 | Tier 1 | Tier 2 |
| --- | ---: | ---: | ---: |
| Initial/internal render-scale ceiling | 0.72 | 0.86 | 1.00 |
| Terrain clipmap levels | 8 | 8 | 8 |
| Shadow map | 1,024 | 2,048 | 4,096 |
| Shadow cascades | 2 | 3 | 4 |
| Shadow distance | 4.5 km | 9 km | 16 km |
| Ocean FFT resolution per cascade | 128² | 256² | 256² |
| Active ocean cascades | 3 | 4 | 5 |
| Cloud resolution-scale profile value | 0.25 | 0.50 | 0.60 |
| Requested cloud primary steps | 40 | 72 | 96 |
| Cloud light-step profile value | 4 | 6 | 6 |
| Vegetation radius | 2 km | 4.5 km | 8 km |
| Vegetation density multiplier | 0.45 | 0.75 | 1.00 |
| Active-animal budget | 16 | 48 | 128 |

These are profile values, not claims that each row owns a separate framebuffer. The spectral configuration defines all five requested cascades, so the active allocation is 3/4/5. All terrain tiers retain the inexpensive far levels needed to cover the 120 km view; quality changes near-page vertex density rather than exposing a finite terrain edge.

Terrain page resolution, ocean presentation density, FFT topology, and every other renderer budget follow the resolved tier rather than raw scenery quality alone. Live tier changes replace resident terrain pages behind their existing geometry and build new ocean compute textures/pipelines before atomically swapping them. The ACES/FXAA post stack is the same across quality profiles.

## Terrain and world paging

- Terrain uses camera-relative geometry-clipmap pages with a 512 m base extent. Each coarser level doubles extent. Its indices are hole-punched cell-by-cell against the exact union of resident finer page bounds, preventing both overlap and streaming holes during partial residency. Every page also carries an 80 m vertical edge skirt to hide unequal-density T-junctions at page and LOD boundaries.
- A ring radius of two bounds each level to at most a 5×5 candidate neighborhood before hollowing. Eight levels cover beyond the camera far plane; low tiers keep the same horizon with much cheaper far-page resolution rather than exposing a terrain edge.
- The fine level predicts along aircraft velocity, while coarser levels remain observer-centered. This prioritizes pages likely to enter view during fast flight.
- `TerrainGenerationClient` prefers a dedicated terrain Worker and uses a maximum queued count of 128. The clipmap refills missing far requests as earlier work drains, so the queue bound cannot permanently omit horizon pages. If that Worker cannot be created or fails, a deferred one-job-at-a-time CPU path runs the same generator. The simulation Worker remains a game requirement. Quality/generation changes cancel pending requests; late stale responses are discarded.
- Pages outside the desired set receive a 90-frame grace period before eviction, limiting boundary churn.
- Page resolution follows the resolved tier: Tier 0 uses 33 samples at level 0 and 17 farther out; Tier 1 uses 65 for levels 0–1 and 33 beyond; Tier 2 uses 65 for levels 0–2 and 33 beyond.
- Existing deterministic world sampling supplies continuous terrain, ravines/valleys, ridged mountains, biomes, geology color, runway flattening, and collision data. A PBR material plugin adds camera-stable macro geology, slope strata, and near-field triplanar micro-normal detail. Terrain generation remains CPU work, not a compute shader.
- `src/render/webgpu/world/` defines the next-stage portable paging contract: canonical keys; quantized height, material, surface, and hydrology payloads; validation; CPU-ready/uploading/resident/evicting lifecycle states; cache metadata; and velocity-aware streaming scores. The active clipmap renderer remains worker-fed and does not yet claim a persistent on-disk page cache.

## Spectral ocean and inland water

The ocean is the renderer's native WebGPU compute workload:

- Seeded Gaussian initialization builds band-limited JONSWAP-style spectra.
- Time evolution produces conjugate frequency-domain waves.
- Horizontal and vertical Stockham passes perform the 2D inverse FFT.
- A derivation pass produces half-float displacement and normal/foam textures from float working textures. Jacobian compression drives breaking-wave foam, which decays temporally.
- Tier 0 allocates 128² with three cascades; Tier 1 allocates 256² with four; Tier 2 allocates 256² with all five. The fifth cascade covers the largest 16,384 m patch and updates every eighth frame. Active cascades span different patch lengths and update cadences so farther, slower bands need not dispatch every frame.
- The camera-centered ocean presentation surface is a single crack-free 120 km radial grid. Tier 0/1/2 use 96×128, 144×192, or 192×256 radial/angular topology; a fifth-power distribution concentrates sub-metre radial spacing near the aircraft and grows cells toward the fogged far plane.
- The WGSL surface combines multi-cascade geometric displacement with per-fragment slope/normal and foam sampling, dielectric Fresnel, GGX sun glint, sky/cloud color, depth tint, and height-aware cloud transmittance on direct sunlight. Ocean and inland-water shaders also bind Babylon's existing cascaded-shadow depth array through its public matrices and comparison sampler; cascade splits/blends follow live quality changes, and only direct solar glare/scatter is attenuated. This reuses the terrain/scenery shadow render instead of scheduling a water-only pass. One shared planar capture adds nearby terrain, aircraft, and settlement geometry while its alpha mask and plane validity fall back to the analytic sky/cloud response wherever capture data is absent.
- Lower-cadence far cascades accumulate elapsed time before applying foam decay, so their half-life is independent of update cadence. Live quality changes initialize replacement compute resources before swapping away the active ocean.

Rivers and lakes are a separate hydrology path. A cancellable Worker generates overlapping, deterministic world regions ahead of aircraft velocity while the old region remains active; a no-hole two-phase opacity handoff publishes the replacement without a blank or translucent midpoint. The main-thread fallback uses the same generator and yields between scheduled jobs. Region meshes remain bounded, floating-origin aware, and disposable. Globally anchored source cells are enumerated over a maximum-trace-length halo, traced and width-resolved in source-owned domains, then clipped to the page. This preserves incoming downstream reaches whose headwaters lie outside the next page. A job rejects configurations exceeding 100 halo source cells or 300,000 theoretical direction samples rather than silently applying a page-local top-N that could alter geography. The flow/ripple shader shares atmosphere, sun, the height-aware cloud-shadow projection, and the live cascaded sun-shadow receiver with the ocean. A nearby current-region lake may consume the shared capture; rivers, retired paging geometry, other elevations, and the ocean during a lake capture are explicitly gated back to analytic Fresnel. There is no shallow-water compute solver in the current implementation.

The reflection target is deliberately small and amortized: Tier 0/1/2 use 192×108 every eighth frame, 320×180 every fifth frame, or 480×270 every third frame after a short startup warmup. It is a single non-recursive target with an opaque finite-distance caster predicate; water, volumetric clouds, glass, particles, and the infinite sky are excluded. A lake must pass distance and projected-angular-size thresholds, with mild hysteresis, so a tiny lake below a high-altitude camera cannot steal the ocean pass. Transparent clear alpha acts as the per-pixel confidence mask, so the physically shaded atmosphere remains the mandatory fallback instead of reflecting black or stale geometry.

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

## Detail, settlements, and wildlife

World detail is deterministic and page-owned rather than attached to transient terrain meshes:

- Default detail cells are 512 m. Terrain biome, slope, moisture, height, and deterministic hashes choose pine, cedar, oak, birch, rocks, and sparse settlement content.
- Villages are owned by larger deterministic macro cells so a settlement cannot be duplicated at a page seam. Buildings align along a rendered road axis and near LOD adds separate doors and reflective window panels.
- Near and mid LODs use deterministic far thinning. Velocity-ahead selection reduces pop-in during fast travel.
- Generation is cooperatively time-sliced to 0.75, 1.25, or 2 ms per update, with hard caps of 8, 16, or 24 cells and resident caps of 128, 384, or 896 cells for the three effective density bands. At least one pending cell is admitted so streaming cannot starve when a dense cell exceeds its target slice.
- Thin-instance batches reuse low-poly procedural species/building topology and shared materials, and are partitioned into deterministic 8×8-cell presentation chunks. Each batch owns its lightweight Babylon `Geometry` because matrix/color/wind thin-instance streams are geometry-owned; this prevents one chunk from replacing another chunk's GPU buffers. Babylon frustum-culls the resulting bounds independently, so one visible tree no longer submits every offscreen resident instance. Unchanged chunk buffers survive incremental neighboring-cell generation; changed chunks publish immutable replacement buffers and retire the previous revision after a short WebGPU-safe grace window.
- Per-instance color supplies variation. A lightweight PBR vertex deformation consumes each tree's phase, compliance, height, and stable selection from `instanceWind`, producing asynchronous crown and trunk sway without CPU transform updates.
- A floating-origin change rebuilds camera-relative matrices for every affected presentation chunk. The shared cascaded-shadow system still receives all eligible chunks rather than only those visible to the main camera.

Wildlife uses deterministic 800 m cells, a default 2 km activation radius, and active budgets of 16, 48, or 128 animals (with a hard safety cap of 512). Birds currently include gulls and hawks; ground animals include deer and boar.

- AI advances at a fixed 30 Hz and limits catch-up work. Far agents update expensive behavior less often.
- Bird flocking uses a bounded spatial hash and local-neighbor queries instead of all-pairs behavior.
- Distance LOD reduces procedural body parts for far animals. The 30 Hz simulation stores previous/current poses and render frames interpolate position, heading, wing phase, and gait before uploading one current matrix buffer.
- Population selection predicts ahead of aircraft velocity and remains seeded by world/cell identity, so paging does not reshuffle the ecosystem.

## HDR color, FXAA, and resolution

- The scene has no active prepass or TAA pipeline. Engine antialiasing is disabled, so no MSAA render target is allocated.
- An explicit full-resolution `ImageProcessingPostProcess` uses a half-float texture and the scene's ACES configuration with exposure 1.08 and contrast 1.04.
- A full-resolution `FxaaPostProcess` follows tone mapping and writes through an unsigned-byte target. There is no active bloom or sharpening stage.
- Browser device pixel ratio is capped at 2. The effective hardware scale combines that cap with the internal render scale.
- Every 120 rendered frames, the renderer sorts CPU frame durations and evaluates p95. Above 18 ms it lowers internal scale by 0.04; below 13.5 ms it raises scale by 0.02; otherwise it holds. The profile value is the ceiling and 0.62 is the current floor.
- The controller uses the worse of CPU and full-frame GPU p95 when `timestamp-query` is available. The GPU counter covers compute, render-target/post, and main presentation work; adapters without timestamp queries safely fall back to CPU timing.

## Diagnostics and regression testing

The performance overlay exposes:

- FPS and frame time.
- CPU frame time and GPU frame time when `timestamp-query` is available.
- Draw calls, triangles, geometries, and textures.
- Resident terrain pages and visible detail/wildlife thin instances.
- Active animals and river/lake counts.
- Requested rendering mode, active render scale, cloud step request, and ocean FFT resolution/cascade count.
- WebGPU adapter label, backend, and render-technique identifier. The fallback reason is always `null` for a successfully created renderer because there is no alternate backend.

For performance changes, test a fixed URL seed, camera mode, weather/time preset, altitude, viewport size, device-pixel ratio, scenery quality, and rendering intent. Record the adapter and browser version. Compare at least a 30-second steady sample after terrain/detail residency and shader/pipeline compilation settle; renderer creation, first compute-pipeline compilation, first audio unlock, and a fresh page-streaming burst are not representative steady state.

Suggested acceptance targets are 60 FPS at 1920×1080 on balanced/medium for a modern discrete GPU, and 60 FPS on performance/low or at least 30 FPS on balanced/medium for a modern integrated GPU. These are QA targets, not guaranteed minimums across every WebGPU adapter.
