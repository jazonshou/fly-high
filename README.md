# fly high

An endless-flight browser simulator. Fly a small aircraft over a procedurally generated world of terrain, forests, rivers, ocean, wildlife, weather, and a real day and night sky. Everything is generated at runtime from a seed, so sharing the URL shares the exact same world.

Built with TypeScript, React, and Babylon.js on WebGPU.

## Requirements

- Node.js 22.13 or newer
- A current desktop browser with WebGPU support
- A hardware GPU. Software rendering is not supported.

## Run it

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and press **Start**.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Nose down / nose up |
| `A` / `D` | Bank left / bank right |
| `Q` / `E` | Rudder left / rudder right |
| `+` / `−` (or `Shift` / `Ctrl`) | Throttle up / down |
| `F` / `V` | Extend / retract flaps |
| `↑` / `↓` | Elevator trim |
| `Space` | Wheel brakes |
| `C` | Cycle camera |
| `H` | Cycle HUD |
| `R` | Restart |
| `Esc` or `P` | Pause / resume |

Gamepads and joysticks are supported too. Sensitivity, dead zone, pitch inversion, and mouse flight can be changed in settings.

## Test and build

```bash
npm run verify        # lint, typecheck, tests, and production build
npm test              # deterministic test suite
npm run test:gpu      # WebGPU tests (needs a real GPU)
npm run perf:capture  # screenshot and frame-time capture suite
npm run build         # production bundle (Cloudflare Worker)
npm run build:pages   # static bundle for GitHub Pages
```

## Documentation

- [docs/FLIGHT_MODEL.md](docs/FLIGHT_MODEL.md), [docs/CALIBRATION.md](docs/CALIBRATION.md), [docs/PERFORMANCE.md](docs/PERFORMANCE.md): how the aircraft, its calibration, and the performance budgets work.
- [docs/architecture/](docs/architecture/): the architecture contract the code must satisfy.
- [docs/plans/](docs/plans/): the rendering programme and each phase's execution plan.
- [docs/findings/](docs/findings/): audits, measured defects, and review briefs.
- [docs/status/](docs/status/): closeout, handover, and outcome records. Start with [PROJECT_CLOSEOUT_2026_09_02.md](docs/status/PROJECT_CLOSEOUT_2026_09_02.md).

## License

[Apache License 2.0](LICENSE)
