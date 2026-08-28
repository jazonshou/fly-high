# fly high

fly high is an original, endless-flight browser simulator inspired by the calm, procedural rhythm of *slow roads*. It combines a deterministic world, a fixed-step six-degree-of-freedom light-aircraft model, synthesized audio, and a Babylon.js renderer built exclusively on WebGPU. The aircraft, terrain, vegetation, wildlife, water, atmosphere, and clouds are generated at runtime; no downloaded game-asset pipeline or remote service is required.

## Run locally

Requirements:

- Node.js 22.13 or newer.
- A current desktop browser that exposes WebGPU and Web Workers in a secure context (`localhost` is accepted for local development).
- A hardware WebGPU adapter. Software/fallback adapters are rejected.

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A world seed is placed in the URL; copying that URL reproduces the same terrain, runway, scenery, wildlife population, and wind field.

> **WebGPU is a hard requirement.** The game has no WebGL or Canvas compatibility renderer. If a hardware WebGPU device cannot be created, startup stops with an explanatory error. A lost device also stops rendering and requires a reload so the adapter, device, and GPU resources can be recreated.

For a production-like check:

```bash
npm run verify
```

`verify` runs ESLint, strict TypeScript checks, all deterministic tests, and a production build.

## Controls

| Control | Action |
| --- | --- |
| `W` / `S` | Nose down / nose up |
| `A` / `D` | Bank left / bank right |
| `Q` / `E` | Rudder left / rudder right |
| `+` / `−` (or `Shift` / `Ctrl`) | Increase / decrease throttle |
| `F` / `V` | Extend / retract flaps |
| `↑` / `↓` | Elevator trim |
| `Space` | Wheel brakes |
| `C` | Cycle chase, cockpit, and cinematic cameras |
| `H` | Cycle full, minimal, and hidden HUD |
| `R` | Restart the current runway or airborne start |
| `Esc` or `P` | Pause / resume |

Keyboard, optional pointer-lock mouse yoke, standard gamepads, and non-standard joystick/HOTAS devices are supported. Standard pads use the left stick for roll/pitch, right-stick X for rudder, shoulder buttons for power, and face/trigger controls for braking. A fourth axis is treated as an absolute throttle on non-standard flight controllers. Input sensitivity, dead zone, pitch inversion, and mouse flight are configurable.

## What is implemented

- Fixed 120 Hz simulation in a dedicated Web Worker, decoupled from render FPS, with a 60 Hz state stream presented on snapshot simulation time. A recent-minimum worker-clock estimator rejects positive queue-delay spikes, a fixed one-snapshot presentation delay avoids latency changes when delivery cadence varies, sampling never moves backwards, and a frame may coast for at most 50 ms from linear and angular velocity instead of snapping when delivery is late. Pause/resume keeps a monotone presentation floor. Pilot controls and actions are sampled by their own fixed 120 Hz pump rather than waiting for the next render frame. Exterior camera position, aim, bank-follow, up-vector and FOV ease as one rig; cockpit presentation remains exact.
- Six-degree-of-freedom rigid-body integration with lift, induced/parasitic drag, sideslip, control-surface authority, propeller thrust, gravity, angular damping, load factor, and ground interaction.
- Nonlinear angle-of-attack response, gradual stall onset, buffet warning, flap/trim effects, runway takeoff and landing, wheel braking, and crash/reset handling.
- Direct/unassisted control by default, with explicit opt-in pilot damping and Scenic attitude control layered around the same aircraft model.
- A Babylon.js `WebGPUEngine` scene using a right-handed coordinate system, reversed-Z depth, cascaded shadows, adaptive internal resolution, per-tier MSAA on the offscreen beauty target, an explicit half-float image-processing pass for ACES tone mapping, and a final FXAA pass as the no-MSAA fallback. There is no active prepass, TAA, bloom, or sharpening pipeline. The renderer reports the `forward-spectral-volumetric` technique and never selects another backend. A raw-device validation guard is attached before scene, shader, and resource construction; the first uncaptured WebGPU error terminalizes the renderer and stops the game loop with an explicit reload path instead of silently presenting black frames at display-rate FPS.
- A small explicit frame graph that orders simulation presentation, world visibility, spectral-ocean compute, volumetric-cloud integration, and final color presentation. Babylon owns command encoding and resource transitions; the game graph owns dependency order, update cadence, timings, and system invalidation hooks.
- GPU-generated terrain drawn as a single screen-space-error CDLOD quadtree. The height kernel runs as a WGSL compute shader into an r32float page atlas — one 264² slot per page, surplus slots serving as the LRU cache — and one 33×33 unit grid is thin-instanced over the selected nodes, so the whole world's ground is one draw call plus one per shadow cascade. Nodes split when their *measured* deviation from their parent subtends more than a per-tier pixel threshold, and geomorph into the parent's vertex lattice before they are replaced, so cracks close analytically and there are no skirts and no popping. The GPU kernel agrees with the physics kernel to within 4 mm anywhere in the world — the split-origin lattice addressing removes the coordinate-magnitude error entirely, so the agreement does not degrade with distance from the origin — and an L0 page matches the surface the wheels touch to 0.06 mm. Sky visibility, a bent normal and an eight-azimuth horizon map are baked per page against a coarse global height field, so a ridge shadows the valley behind it at 40 km, where a cascaded shadow map has never reached. A land-cover classifier — ten smooth suitability functions, softmaxed and top-4 renormalised — is the single authority for what the ground is made of, which trees stand on it and which animals live in them; its output is baked into season-keyed splat pages and cross-faded, so the snowline migrates with the calendar while the species mix stays climatic. One PBR material plugin owns the whole of terrain surface appearance: ten procedurally synthesised land-cover materials — grass, dry grass, forest floor, shrub, sand, gravel, rock, snow, asphalt and concrete — live in two mipped, 16×-anisotropic `Texture2DArray`s and are sampled per fragment, so material resolution is independent of mesh resolution. The plugin composes them with three decorrelated de-tiling scales, true triplanar projection with reoriented normal blending on slopes, height-based blending between materials, per-material roughness/F0/Oren-Nayar response, and a day-of-year tint and roughness curve. Distant mips fold their flattened normal maps back into roughness (a Toksvig term), which is what stops far terrain acquiring a false sharp highlight. Every GPU compute producer is admitted by one per-frame millisecond meter, and floating-origin shifts keep GPU coordinates stable on long flights.
- A WebGPU-native spectral ocean: seeded, band-limited JONSWAP-style spectra, time evolution, Stockham 2D inverse FFT, displacement/Jacobian derivation, per-cascade slope storage, and cadence-correct decayed foam across several wavelength cascades. Cascades store slopes rather than renormalised normals and carry a real mip chain sampled with explicit gradients, so range folds each band's missing energy into roughness (a Toksvig term) instead of aliasing it into sparkle, and a cascade fades out — displacement included — where its longest wavelength falls below two rendered pixels. A crack-free 40 km camera-centered radial grid (reconciled with the 45 km far plane) concentrates geometric samples near the aircraft, while fine cascade slopes/foam are combined per pixel for dielectric Fresnel, one physical GGX sun lobe, sky/cloud response, backlit crest scattering, lit foam advected with the surface, and environment reflections sampled from a bounded sky probe cube over the analytic fallback. Direct glint and sunlit scatter reuse the shared cascaded-shadow depth array as well as the cloud-transmittance map; there is no water-only shadow pass and no planar-reflection capture. FFT resources swap atomically when the live quality tier changes.
- Deterministic rivers and lakes generated from terrain samples in velocity-ahead, overlapping world regions. A cancellable hydrology Worker streams replacement regions while the current region remains visible; a no-hole two-phase crossfade hides handoff latency. Each page traces globally owned upstream sources from a bounded max-length halo before clipping stable river geometry, so a downstream reach cannot disappear merely because its headwater left the page. Flow-aligned meshes use a separate WGSL water material with ripples, Fresnel response, sun highlights, shared sky/cloud lighting, and the same cascaded sun-shadow receiver as the ocean. Rivers and lakes sample the same bounded sky-probe environment reflections as the ocean, with the stable analytic reflection as fallback.
- Camera-centered volumetric clouds ray-marched in WGSL. The density bake, the march and the shadow pass all run as WebGPU compute shaders writing storage textures, over period-wrapped 3D noise volumes baked on the GPU at startup. Coverage and humidity come from an endless field of unwrapped world-cell hashes read through a camera-following window, so the weather pattern cannot repeat at any distance; layered shape noise sampled at two incommensurate scales, erosion, height-dependent wind shear, height profile, Beer extinction, anisotropic phase functions, powder backscatter, decaying multiple-scattering octaves, sun transmittance, and stochastic per-frame sampling produce varying forms and lighting without per-cloud meshes or sprite cards. The march skips empty space and grows every stride with ray distance, so horizon-grazing rays cost what near ones do. Low-resolution integration is temporally resolved and composited at full resolution, while a bounded 24 km transmittance map supplies height-aware cloud shadows to terrain, water, vegetation and opaque PBR scenery; transparent glass and emissive lights remain optically independent.
- An analytic HDR atmosphere computed from one shared closed-form Rayleigh/Mie/ozone single-scattering integral: the WGSL sky, the aerial perspective on terrain, water, vegetation and clouds, and a limb-darkened true-angular-size sun disc all evaluate the same functions, driven by a continuous solar clock (NOAA solar position from day-of-year, solar time, and latitude) and clear/breezy/gusty-cloudy weather shared by sky, clouds, and water.
- A real night sky on the same clock. Constellations are correct: ~190 bright stars carry their true J2000 positions, magnitudes and colour indices, a background fills in to the observed magnitude-count law, and the whole field rotates with local sidereal time so the sky arrives four minutes earlier each night and turns with the seasons. Atmospheric extinction is per star, so faint stars go out near the horizon while bright ones hold. The moon has an ephemeris position, a phase drawn from the real sun–moon geometry (with the opposition surge that makes a full moon far brighter than its lit fraction suggests), maria, limb darkening, earthshine on the dark limb, and its own warm ~4,100 K directional light. A scotopic post-process then does what a human eye does below about 0.03 cd/m²: colour discrimination collapses, blues brighten relative to reds, acuity drops, and adaptation into the dark takes far longer than adaptation out of it.
- Deterministic 512 m detail pages are selected ahead of aircraft velocity and generated in a dedicated Worker. Biome, slope and moisture drive species placement, and a continuous stand field — not a block lattice — carries dominant species mix, stand age and the tint centre each stem correlates against, so no 32 m grid survives in what you see. A second, multi-kilometre density field authors whole forest and meadow provinces, genuinely open glades, hard windthrow boundaries and shorter, bushier edge growth without changing species selection. Trees, shrubs, rocks and ground cover are built from procedural prototype geometry against one seed-derived 256² foliage atlas: close and middle tree crowns are closed opaque species-shaped hulls, while small foliage cards retain coverage-preserving mips and colour-dilated transparent margins. Instances upload as a 32-byte record — position, quaternion, height/radial scale, tint, and a state byte carrying LOD selection, variant and wind phase — with the world transform built in the vertex stage; matrix instancing is gone. A coherent three-band wind model bends stems in world space, stable per-stem LOD handoffs avoid forest-wide pops, and the far band draws octahedral impostors baked from sixteen hemispherical views per species in leafed and bare season buckets. One rendered-density law owns how many woody plants are drawn per hectare at each range and what each may cost in triangles; ground cover expands into habitat-gridded patches under its own falloff. Fixed spatial presentation chunks let the main camera frustum-cull offscreen resident detail without changing deterministic page ownership. The Worker retains generated cells, builds one immutable packed chunk in bounded 4,096-unit/4 ms macrotasks, and transfers exact instance streams back without cloning the cell object graph; the main thread validates the complete result before one atomic publication while the previous complete state remains live. A bounded inline builder is the fail-closed recovery path for a corrupt, silent, or unavailable Worker. Frontier targets are reevaluated every 64 m, snapshots older than the 96 m membership/grass validity envelope cannot publish, and a live snapshot that crosses the same hard boundary is hidden fail-closed without retiring its GPU storage until a valid atomic replacement arrives. Cell lower bounds skip byte-equivalent out-of-range arrays, so dense continuous flight cannot turn a rebuild into a render-thread hitch or a stale nearby world. Floating-origin changes translate live chunks immediately and safely restart staged work.
- Deterministic wildlife pages containing recognisable procedural gulls, hawks, deer, and boar with distinct feather, fur and keratin materials. A bounded 30 Hz CPU simulation uses distance-based AI rates and a spatial hash for bird flocking; render-time interpolation then presents smooth procedural near/far animal motion without tying AI cost to frame rate. Ten shared prototype batches retain the bounded thin-instance architecture.
- Seeded multi-octave terrain and biome sampling with continuous borders, carved valleys and ravines, ridged/craggy mountain relief, geology-aware relief, and spatially varying gusts. The airport sits on a three-zone cut/fill earthworks profile with a cambered runway — and the flight physics evaluates that same profile, so the surface the aircraft touches and the surface on screen agree to within a millimetre.
- Procedural aircraft, hangars, trees, rocks, wildlife, and water surfaces. Trainer and jet aircraft use lofted bodies, finite airfoil sections, mapped paint with panels/rivets/wear/livery, clearcoat transmission glass and visible cockpit instruments. A continuous blade-to-disc crossfade replaces propeller strobing, while cockpit camera layers hide only the obstructing skin and leave its shadow caster visible. The runway itself is not a mesh: asphalt, worn centreline and threshold markings, rubber at both touchdown zones, and aggregate in the wheel paths are painted inside the same analytic signed-distance boundary used by tyre physics, so nothing is coplanar with anything and the visible edge cannot drift from friction. Shadow casters are registered with the shared cascaded-shadow system.
- The minimal title screen keeps the live Scenic attract flight visible behind only **Start** and seed controls. **Start** atomically hands that exact in-progress state to the selected pilot mode; runway and configurable-AGL airborne restarts remain available from pause.
- Synthesized Web Audio for engine, wind, ground rumble, flap servo, stall, and touchdown; URL-shareable seeds; responsive flight instruments; accessibility and performance settings.
- Unit tests for world determinism and continuity, terrain-page contracts, ecology and wildlife generation, runway safety, flight dynamics, stall behavior, controls, URL seeds, and settings validation.

## Rendering architecture

```text
React UI / input / audio
          │ controls + commands
          ▼
SimulationClient ─────► simulation.worker.ts ─────► 120 Hz flight model
          ▲                       │                         │
          │ interpolated snapshots └─── terrain + wind ────┘
          │
          └──────► FlightRenderer (Babylon.js WebGPUEngine, WebGPU only)
                              │
                              ├──► WebGpuFrameGraph
                              │      presentation → visibility → ocean compute
                              │      → cloud integration → ACES/FXAA
                              │
                              ├──► terrain quadtree ──► page atlas (compute)
                              │                            │
                              │
                              └──► atmosphere / ocean / hydrology / detail / wildlife
```

The simulation and renderer exchange plain immutable snapshots. The flight model and deterministic world sampling do not import Babylon.js, so they remain testable in Node and independent of presentation. The active renderer is `src/render/FlightRenderer.ts`; its WebGPU systems live below `src/render/webgpu/`.

Important source areas:

- `src/sim/` — aircraft constants, aerodynamics, rigid-body state, telemetry, and fixed-step integration.
- `src/world/` — seeded noise, terrain/biome/runway sampling, and wind. The one height kernel lives here and is transliterated into WGSL by the renderer, never re-derived.
- `src/workers/` — independent simulation, hydrology, and world-detail workers, protocols, and bounded schedulers. (GPU terrain pages remain compute dispatches; eroded macro/reference terrain and detail generation use their explicitly bounded CPU workers.)
- `src/render/webgpu/core/` — hardware capability gate, resolved quality profiles, and frame ordering.
- `src/render/webgpu/terrain/` and `src/render/webgpu/world/` — the terrain spine contract, the WGSL height kernel, the page atlas and its generation, the CDLOD quadtree, the occlusion and land-cover bakes, the surface material system (the ten-material contract, their procedural synthesis, the surface plugin, the runway earthworks profile and the SDF runway painter), plus canonical page keys, quantized payload contracts, validation, lifecycle states, cache metadata, and streaming priorities.
- `src/render/webgpu/water/`, `clouds/`, and `atmosphere/` — FFT ocean, paged hydrology, volumetric clouds, sky, lighting, fog, cascaded shadows, and the night sky (star catalogue, lunar/solar ephemeris, scotopic vision).
- `src/render/webgpu/detail/` and `wildlife/` — paged ecology and settlements (the foliage and impostor atlases, prototype geometry, the stand and density fields, the 32-byte instance format and its material plugin) and bounded animal generation/simulation.
- `src/render/webgpu/aircraft/` — procedural loft/airfoil geometry, deterministic surface-map synthesis, cockpit presentation and animation.
- `src/input/`, `src/audio/`, `src/settings/`, and `src/ui/` — browser-facing systems.

Implementation notes and measured acceptance bands are documented in `docs/FLIGHT_MODEL.md`, `docs/CALIBRATION.md`, and `docs/PERFORMANCE.md`.

## Quality and performance

Two settings resolve the GPU budget: scenery quality (`low`, `medium`, or `high`) and rendering intent (`performance`, `balanced`, or `ultra`). Together they select one of four bounded profiles (tiers 0–3). The balanced medium combination is the baseline; higher profiles increase the CDLOD node budget and pixel threshold, page-atlas residency, terrain material array resolution, triplanar projection axes, how many materials the surface blend may carry, vegetation, animals, cloud samples, ocean cascades, and shadow coverage, while all profiles retain inexpensive horizon terrain.

The renderer monitors rolling 120-frame start-to-start intervals and CPU p95, then adjusts internal resolution slowly between the profile ceiling and a 0.75 floor. When resolution stops buying frame time the governor latches and sheds work instead, along two disjoint ladders — CPU-cost levers and pacing/GPU-cost levers — so an interval-bound window is never silently treated as healthy. Continuous Babylon timestamp observers are disabled in gameplay because a controlled capture measured a 4.7 ms p95 observer tax for sparse results; pinned diagnostic captures can opt in explicitly. Device pixel ratio is capped per tier (1 / 1.5 / 2 / 2), MSAA runs on the offscreen beauty target at per-tier sample counts (1 / 1 / 4 / 4), and FXAA after half-float ACES color processing serves the no-MSAA tiers. Diagnostics expose frame-interval and CPU p95, the worst and 99.9th-percentile frame times and a hitch count (frames slower than twice the tier target) over a rolling 600-frame window, the active governor and the lever it moved last, draw calls, triangles, resident pages, visible instances, animals, rivers/lakes, render scale, cloud steps, ocean FFT topology, and adapter name. Explicit timing captures label their query epoch, fresh sample count, and latest-sample age rather than manufacturing a “present wait” from uncorrelated counters.

Playability acceptance targets:

- The pinned reference machine must sustain at least 60 wall-clock FPS on
  balanced/medium, with frame-interval p95 at or below 16.67 ms, no frame over
  50 ms, and at most five >27.4 ms hitches per 240-frame canonical shot. These
  ceilings are code-owned and cannot be relaxed by rebaselining screenshots.
- Other supported hardware uses the governor and bounded quality tiers; its
  selected tier is acceptable only when it meets the same raw delivery gate.
- High-DPI display: confirm adaptive render scale prevents sustained fill-rate collapse.

See `docs/PERFORMANCE.md` for exact tier budgets, subsystem ownership, streaming limits, measurement guidance, and current implementation boundaries.

## Development commands

```bash
npm run lint       # ESLint
npm run typecheck  # strict TypeScript
npm test           # all Vitest suites
npm run test:sim   # flight-model suite
npm run test:world # world-generation suite
npm run benchmark  # deterministic flight scenarios
npm run test:gpu   # WebGPU suite; needs a hardware adapter
npm run material:preview # writes the terrain-material contact sheet to tests/perf/artifacts/
npm run perf:capture   # sixteen-shot, read-only-baseline capture gate on a real GPU
npm run perf:capture:candidate # full validated candidate under tests/perf/artifacts/; never promotes
npm run build      # production bundle (Cloudflare Worker)
npm run build:pages # static bundle for GitHub Pages
```

## Continuous integration and deployment

`.github/workflows/ci.yml` runs lint, typecheck, the deterministic Vitest suites, and both production builds on every push to `main` and every pull request. Pushes to `main` that pass then publish the static bundle to GitHub Pages.

Two build targets exist on purpose. `npm run build` produces the canonical Cloudflare Worker via vinext and server-renders `app/`. GitHub Pages serves static files only, so `npm run build:pages` bundles the same `src/` tree through `static/main.tsx`, which mounts the identical `FlightGame` client root. Everything below that root is shared; only the document shell is duplicated.

`PAGES_BASE` sets the URL prefix for the static build and must match where the site is served (`/<repo>/` for a GitHub project page). To preview it locally:

```bash
PAGES_BASE=/fly-high/ npm run build:pages
PAGES_BASE=/fly-high/ npx vite preview --config vite.static.config.ts
```

CI derives `PAGES_BASE` from the repository name, so renaming the repo moves the site without a workflow edit.

The WebGPU suite (`tests/gpu`) is not in the required CI path: it needs a real adapter. `.github/workflows/gpu-tests.yml` runs it on a macOS runner on manual dispatch.

### The lockfile must resolve to the public npm registry

CI runs `npm ci` with no route to any internal mirror. If you install from behind a proxying registry, npm rewrites `resolved` in `package-lock.json` to that internal host; npm then substitutes your local registry on the way back in, so the breakage is invisible locally and fatal in CI. `tests/lockfile-registry.test.ts` fails the build when that happens. Repair it by rewriting the hosts back to `registry.npmjs.org` — versions and `integrity` hashes must stay untouched, and `integrity` is what makes the rewrite safe.

CI also pins Node 24 rather than the `engines` floor of 22, because Node 22 ships npm 10.9.x, which crashes on this lockfile's `libc`-gated optional binaries.

## Current scope

This build intentionally focuses on a single believable trainer aircraft and an endless procedural region. It does not yet include multiplayer, streamed real-world scenery, navigation databases, detailed cockpit switch simulation, or mobile touch controls. Those are expansion areas, not dependencies for the current playable loop.
