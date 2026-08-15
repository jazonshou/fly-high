# Aerolith

Aerolith is an original, endless-flight browser simulator inspired by the calm, procedural rhythm of *slow roads*. It combines a deterministic terrain world, a fixed-step six-degree-of-freedom light-aircraft model, generated audio, and a deliberately lightweight Three.js renderer. There are no remote services or downloaded game assets at runtime.

## Run locally

Requirements: Node.js 22.13 or newer and a current desktop browser with WebGL 2 and Web Workers.

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A world seed is placed in the URL; copying that URL reproduces the same terrain, runway, and wind field.

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
| `C` | Cycle chase, cockpit, and orbit cameras |
| `H` | Cycle full, minimal, and hidden HUD |
| `R` | Restart the current runway or airborne start |
| `Esc` or `P` | Pause / resume |

Keyboard, optional pointer-lock mouse yoke, standard gamepads, and non-standard joystick/HOTAS devices are supported. Standard pads use the left stick for roll/pitch, right-stick X for rudder, shoulder buttons for power, and face/trigger controls for braking. A fourth axis is treated as an absolute throttle on non-standard flight controllers. Input sensitivity, dead zone, pitch inversion, and mouse flight are configurable.

## What is implemented

- Fixed 120 Hz simulation in a dedicated Web Worker, decoupled from render FPS, with a 60 Hz state stream interpolated for smooth presentation.
- Six-degree-of-freedom rigid-body integration with lift, induced/parasitic drag, sideslip, control-surface authority, propeller thrust, gravity, angular damping, load factor, and ground interaction.
- Nonlinear angle-of-attack response, gradual stall onset, buffet warning, flap/trim effects, runway takeoff and landing, wheel braking, and crash/reset handling.
- Direct/unassisted control is the default and imposes no attitude or altitude hold. Pilot damping and Scenic attitude control are explicit opt-in modes layered around the same aircraft model.
- The minimal title screen keeps the live Scenic attract flight visible behind only **Start** and seed controls. **Start** atomically hands that exact in-progress state to the selected pilot mode; runway and configurable-AGL airborne restarts remain available from pause.
- Deterministic multi-octave terrain and biome sampling with runway flattening, continuous borders, carved valleys, ridged/craggy mountain relief, geology-aware coloring, close-range grass/herb ground cover, mixed clustered forests, and spatially varying gusts.
- A second Worker generates transferable terrain tiles through a bounded nearest-first queue. Near terrain is pooled at the selected quality while a coarse far LOD keeps the horizon filled.
- Floating-origin rendering, stale-work rejection, geometry/material reuse, instanced mixed-species trees and volumetric cloud clusters, capped device pixel ratio, dynamic resolution scaling, and three quality presets.
- Procedural aircraft, runway, anisotropically filtered terrain microtexture, instanced ground plants, depth-stable dielectric Fresnel water with filtered ripples, atmospheric sky, textured cloud volumes, real medium/high-quality shadows, a low-altitude contact shadow, engine, wind, ground rumble, flap servo, stall, and touchdown presentation—no asset download pipeline is required.
- Dawn, daylight, and golden-hour lighting plus clear, breezy, and gusty/cloudy weather presets that affect both presentation and the physical wind field.
- Chase, cockpit, and orbit cameras; responsive flight instruments; accessibility and performance settings; synthesized Web Audio; URL-shareable seeds.
- Unit tests for world determinism/continuity, runway safety, flight dynamics, stall behavior, controls, URL seeds, and settings validation.

## Architecture

```text
React UI / input / audio
          │ controls + commands
          ▼
SimulationClient ─────► simulation.worker.ts ─────► 120 Hz flight model
          ▲                       │                         │
          │ interpolated snapshots └─── terrain + wind ────┘
          │
FlightRenderer ───────► Three.js scene + floating origin + pooled tiles
          │
          └──► TerrainGenerationClient ──► terrain.worker.ts
                          bounded queue       transferable tile buffers
```

The simulation and renderer exchange plain immutable snapshots. Neither the physics model nor world generation imports Three.js, which keeps the deterministic core testable in Node and makes future rendering changes independent of flight behavior.

Important source areas:

- `src/sim/` — aircraft constants, aerodynamics, rigid-body state, telemetry, and fixed-step integration.
- `src/world/` — seeded noise, terrain/biome/runway sampling, wind, and typed tile generation.
- `src/workers/` — independent simulation and terrain workers, protocols, and the bounded terrain scheduler.
- `src/render/` — aircraft, sky, terrain pooling, cameras, adaptive resolution, and diagnostics.
- `src/input/`, `src/audio/`, `src/settings/`, `src/ui/` — browser-facing systems.

Implementation notes and measured acceptance bands are documented in `docs/FLIGHT_MODEL.md`, `docs/CALIBRATION.md`, and `docs/PERFORMANCE.md`.

## Performance targets

The medium preset is the baseline: a bounded near grid and coarse far grid around the aircraft, instanced detail, one in-flight terrain job, a 60 Hz state stream, and a renderer that lowers its internal pixel ratio after sustained slow frames. The performance overlay can be enabled in Flight Setup to inspect FPS, frame time, draw calls, triangles, and resident terrain tiles.

Suggested QA devices:

- Desktop integrated GPU at 1920×1080: target 60 FPS on medium.
- Older/lower-power laptop: target at least 30 FPS on low.
- High-DPI display: verify adaptive pixel ratio prevents fill-rate collapse.

## Development commands

```bash
npm run lint       # ESLint
npm run typecheck  # strict TypeScript
npm test           # all Vitest suites
npm run test:sim   # flight-model suite
npm run test:world # world-generation suite
npm run benchmark  # deterministic flight scenarios
npm run build      # production bundle
```

## Current scope

This build intentionally focuses on a single believable trainer aircraft and an endless procedural region. It does not yet include multiplayer, streamed real-world scenery, navigation databases, detailed cockpit switch simulation, or mobile touch controls. Those are expansion areas, not dependencies for the current playable loop.
