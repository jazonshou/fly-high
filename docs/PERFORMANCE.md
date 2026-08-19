# WebGPU performance strategy

fly high's active renderer is a Babylon.js `WebGPUEngine` implementation. It keeps memory, generation, simulation, and draw work bounded while the deterministic coordinate space remains effectively endless.

## Runtime contract

- WebGPU, Web Workers, and a hardware-accelerated adapter are required. Startup requests a high-performance adapter and rejects a software/fallback adapter.
- There is **no WebGL fallback and no Canvas fallback**. An unsupported device receives a startup error rather than a reduced renderer.
- The engine runs with compatibility mode disabled, a right-handed scene, reversed-Z depth, MSAA on the offscreen beauty target per tier, a 0.08 m near plane, and a 45 km far plane (1C-4: the shared aerial perspective is ≥95% opaque beyond it).
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
| 6 | `hdr-present` | Babylon scene render, the scotopic (rod-vision) pass, half-float ACES image processing, final FXAA, and presentation. |

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
| Atmosphere | CPU solar position, transmittance LUT bake, and per-frame haze binding | Analytic HDR WGSL sky and aerial perspective from one shared closed-form Rayleigh/Mie/ozone integral; Babylon fog is permanently off |
| Trees, rocks, shrubs | Deterministic CPU detail-cell generation and LOD selection | Spatially chunked Babylon thin instances with per-instance color and tree wind deformation |
| Wildlife | Deterministic CPU population and bounded fixed-step AI | Interpolated current thin-instance transforms for procedural animals |

The only active general-purpose GPU compute simulation in the current frame is the spectral ocean. Terrain, hydrology, ecology, and wildlife are deliberately CPU-generated or CPU-simulated and rendered through WebGPU. Clouds are a fragment-shader volume ray march, not an FFT or compute-fluid simulation. This distinction is important when profiling CPU generation versus GPU shading.

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
| MSAA samples (offscreen beauty target) | 1 | 2 | 2 | 4 |
| Terrain clipmap levels | 6 | 7 | 7 | 7 |
| Terrain tile resolution | 33 | 65 | 65 | 65 |
| Shadow map | 1,024 | 2,048 | 4,096 | 4,096 |
| Shadow cascades | 2 | 2 | 4 | 4 |
| Shadow distance | 4.5 km | 7 km | 16 km | 16 km |
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

These are profile values, not claims that each row owns a separate framebuffer. The spectral configuration defines all five requested cascades, so the active allocation is 3/4/5/5. Terrain tiers retain the inexpensive far levels needed to reach the 45 km far plane (guaranteed coverage is 512·2^rings meters; tier 0 stops at 32.8 km behind ~89% haze opacity); quality changes near-page vertex density rather than exposing a finite terrain edge. Tier 3 is a 30 fps tier that spends its frame on pixels.

Terrain page resolution, ocean presentation density, FFT topology, and every other renderer budget follow the resolved tier rather than raw scenery quality alone. Live tier changes replace resident terrain pages behind their existing geometry and build new ocean compute textures/pipelines before atomically swapping them. The ACES/FXAA post stack is the same across quality profiles.

## Terrain and world paging

- Terrain uses camera-relative geometry-clipmap pages with a 512 m base extent. Each coarser level doubles extent. Its indices are hole-punched cell-by-cell against the exact union of resident finer page bounds, preventing both overlap and streaming holes during partial residency. Every page also carries an 80 m vertical edge skirt to hide unequal-density T-junctions at page and LOD boundaries.
- A ring radius of two bounds each level to at most a 5×5 candidate neighborhood before hollowing. Six to seven levels (per tier) cover to the 45 km far plane; low tiers keep the same horizon with much cheaper far-page resolution rather than exposing a terrain edge.
- The fine level predicts along aircraft velocity, while coarser levels remain observer-centered. This prioritizes pages likely to enter view during fast flight.
- `TerrainGenerationClient` prefers a dedicated terrain Worker and uses a maximum queued count of 128. The clipmap refills missing far requests as earlier work drains, so the queue bound cannot permanently omit horizon pages. If that Worker cannot be created or fails, a deferred one-job-at-a-time CPU path runs the same generator. The simulation Worker remains a game requirement. Quality/generation changes cancel pending requests; late stale responses are discarded.
- Pages outside the desired set receive a 90-frame grace period before eviction, limiting boundary churn.
- Page resolution follows the resolved tier as one constant per tier (1B-3): 33 at tier 0, 65 at tiers 1–3, at every level — constant per-tier resolution keeps every adjacent-level ground-sample ratio exactly 2:1, which is what killed the audit's 4:1 T-junction.
- Existing deterministic world sampling supplies continuous terrain, ravines/valleys, ridged mountains, biomes, geology color, runway flattening, and collision data. A PBR material plugin adds camera-stable macro geology, slope strata, and near-field triplanar micro-normal detail. Terrain generation remains CPU work, not a compute shader.
- `src/render/webgpu/world/` defines the next-stage portable paging contract: canonical keys; quantized height, material, surface, and hydrology payloads; validation; CPU-ready/uploading/resident/evicting lifecycle states; cache metadata; and velocity-aware streaming scores. The active clipmap renderer remains worker-fed and does not yet claim a persistent on-disk page cache.

## Spectral ocean and inland water

The ocean is the renderer's native WebGPU compute workload:

- Seeded Gaussian initialization builds band-limited JONSWAP-style spectra.
- Time evolution produces conjugate frequency-domain waves.
- Horizontal and vertical Stockham passes perform the 2D inverse FFT.
- A derivation pass produces half-float displacement and normal/foam textures from float working textures. Jacobian compression drives breaking-wave foam, which decays temporally.
- Tier 0 allocates 128² with three cascades; Tier 1 allocates 256² with four; Tier 2 allocates 256² with all five. The fifth cascade covers the largest 16,384 m patch and updates every eighth frame. Active cascades span different patch lengths and update cadences so farther, slower bands need not dispatch every frame.
- The camera-centered ocean presentation surface is a single crack-free 40 km radial grid. Tier 0/1/2 use 96×128, 144×192, or 192×256 radial/angular topology; a fifth-power distribution concentrates sub-metre radial spacing near the aircraft and grows cells toward the hazed far plane.
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

## Detail and wildlife

World detail is deterministic and page-owned rather than attached to transient terrain meshes (villages and buildings were deleted in 1B-5; the airfield is the only settlement content):

- Default detail cells are 512 m. Terrain biome, slope, moisture, height, and deterministic hashes choose tree and shrub species and rock variants.
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

- The scene has no active prepass or TAA pipeline. Engine context antialiasing is disabled; MSAA lives on the offscreen beauty target owned by the tone-map post-process (1B-11), at the per-tier sample counts above. FXAA is the no-MSAA fallback only.
- An explicit full-resolution `ImageProcessingPostProcess` uses a half-float texture and the scene's ACES configuration with exposure 1.08 and contrast 1.04.
- A full-resolution `FxaaPostProcess` follows tone mapping and writes through an unsigned-byte target. There is no active bloom or sharpening stage.
- The device pixel ratio is capped per tier (1/1.5/2/2) and the total scale product is clamped by the tier's absolute pixel cap (1A-6a) — no display can raise rendered pixels past it.
- Two governors adapt per 120-frame window (1A-6b, repaired by R-11): Governor A steps resolution only on GPU-bound windows (0.05 down / 0.025 up, floor 0.75), undoes and latches against steps that buy no GPU time, and — when latched or floored — sheds GPU-cost work levers (reflection/cloud-shadow cadence, shadow-caster distance, vegetation distance). Governor B sheds CPU-cost levers (terrain-page requests, detail generation slice, animal budget) only on CPU-bound windows. No lever is ever recovered while a window is GPU-bound.
- Diagnostics additionally track a rolling 600-frame window for p95s and the Z-2 hitch metrics (max frame, p999, hitch count against 2× the tier frame target); >250 ms stalls are counted there even though the governors' own p95 ignores them.

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
- **Scotopic vision** is one full-screen pass ahead of the tone map. Above
  civil twilight it early-outs on a uniform branch after a single sample, so
  daylight pays a copy and nothing else; being first in the chain it owns the
  offscreen beauty target and therefore MSAA.

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
`Δdraws` linearly across all thirteen capture shots, and triangle deltas
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

## Capture harness

`npm run perf:capture` renders the committed shot list against
`tests/perf/baseline`. Two notes that matter when reading its output:

- `VITE_PERF_SHOTS=name[,name]` runs a subset. A full capture is ~4–6 minutes,
  which is the wrong feedback loop for diagnosing one bad shot; the filter
  refuses to run alongside `VITE_PERF_REBASELINE` so a partial run can never
  overwrite the committed set.
- The committed `minFps`/`hitchCount` ceilings were measured on the reference
  M-series machine. They are **not** portable: the same build on a different
  box, or on a hot one, moves GPU p95 by several milliseconds on shots it
  cannot possibly have touched. `drawCalls`, `vegetationBatches` and
  `triangles` are load-independent and are the right counters to compare
  across machines.
