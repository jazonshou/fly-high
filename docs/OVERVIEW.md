# fly high: project overview

fly high is an endless flight simulator that runs in the browser. It is written in TypeScript and React, and renders with Babylon.js on WebGPU. A seed generates the whole world, so there is always more land, sea and airports ahead. Start here; the other docs go deeper on one part each.

## What you can do

- **Fly four aircraft:** a Cessna 150 trainer, an F-16C, a Bombardier Global 8000 and a Boeing 747-8. Each has its own flight model, cockpit, instruments and livery. Cameras: chase, cockpit, orbit, top and front.
- **Land anywhere you like, or let it land for you.** Airports are generated ahead of you as you fly, and autoland flies a circuit, approach and flare to the nearest one, going around when an approach cannot end in a landing.
- **Drive and boat (Beta).** A Land Cruiser 76 drives on generated roads and off-road, and a 21 ft runabout starts from a home marina. Both sit behind the Beta button on the start screen.
- **Benchmark your machine** with `?bench=1`, which flies a fixed route and reports frame delivery.

## The world

| Part | What it is | Code |
| --- | --- | --- |
| Terrain | Paged on the GPU at several levels of detail, with erosion, rivers and lakes, landforms, volcanic land and dunes | `src/world/`, `src/render/webgpu/terrain/` |
| Climate | Provinces that set biome, tree species and ground cover: temperate, boreal, tundra, desert, savanna and tropical coast | `src/world/climateProvince.ts` and neighbours |
| Water | A spectral ocean with shore run-up, inland water from the hydrology worker, and a sea model shared with the boat and car | `src/render/webgpu/water/`, `src/sim/water/` |
| Sky and light | Physically based sky and atmosphere, volumetric clouds, sunset, dusk and night with moon, stars and lamps | `src/render/webgpu/atmosphere/`, `clouds/`, `lighting/` |
| Life | Trees, bushes and ground cover; birds and ground animals | `src/render/webgpu/detail/`, `wildlife/` |
| Built world | Spawned airports, roads, settlements and generated, weathered buildings | `src/world/roads/`, `settlements/`, `structures/`, `src/render/roads/`, `structures/` |

## How it fits together

- **Game shell** (`src/game/FlightGame.tsx`) owns the page: start screen, settings, HUD, input and the frame loop.
- **Simulation** runs in a worker (`src/sim/`, `src/workers/simulation.worker.ts`): rigid-body flight dynamics, landing gear and ground handling, assists, autoland, the car's tyres and driveline, and the boat's hydrostatics and planing.
- **Renderer** (`src/render/FlightRenderer.ts`) owns the frame graph and every GPU system under `src/render/webgpu/`. Each artifact has one owner, which the architecture tests enforce.
- **Workers** (`src/workers/`) build terrain pages, erosion, materials, hydrology, vegetation detail, roads, buildings and airport sites off the main thread.
- **Quality tiers.** Low, Medium and High quality plus an Ultra mode resolve to four tiers. An adaptive governor trims work at run time to hold the frame rate, falling back to an even 30 fps on Low.

## Checks

| Command | What it guards | Where it runs |
| --- | --- | --- |
| `npm run lint`, `npm run typecheck`, `npm test` | Logic, world generation and render contracts in Node | CI on every push |
| `npm run test:gpu` | Behaviour that needs a real WebGPU adapter | CI on macOS |
| `npm run perf:capture` | 39 screenshot baselines in `tests/perf/baseline/`, draw-call ceilings and frame delivery | CI on macOS |
| `npm run perf:ab` | A main-against-branch timing comparison | CI on SwiftShader and macOS |
| `npm run perf:flight` | Hitches over a scripted flight | Locally |

Merging to `main` deploys the static build to GitHub Pages.

## Documentation

- [PERFORMANCE.md](PERFORMANCE.md): frame budgets, quality tiers, the capture harness, and the log of rebaselines and draw-call ceilings. The `docs-truth` test checks its tables against the code.
- [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md): the rules the code must keep, such as single owners and the physics/render height invariant.
- [architecture/NIGHT_LOOK_ARCHITECTURE.md](architecture/NIGHT_LOOK_ARCHITECTURE.md): how the world looks from dusk to night.
- [FLIGHT_MODEL.md](FLIGHT_MODEL.md) and [CALIBRATION.md](CALIBRATION.md): the aircraft physics and how each type is calibrated.
- [CAR_MODEL.md](CAR_MODEL.md) and [BOAT_MODEL.md](BOAT_MODEL.md): the Land Cruiser and the runabout.
- [ARCHIVE.md](ARCHIVE.md): where the removed plans, findings and scripts went.
