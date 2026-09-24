/**
 * Which perf shots have birds in frame, and how big — predicted in Node.
 *
 *   npx tsx scripts/wildlife-shot-birds.mts
 *
 * With the wildlife pinned at each shot's time pin (the perf harness's wildlife pin),
 * a shot's birds at capture are a function of the seed and the shot alone, so
 * they can be computed without a GPU: resolve each shot's pose exactly as the
 * harness does, run the SHIPPED `WildlifeSystem` (NullEngine) from a fresh
 * population — which is what the pin leaves — through the harness's frames to
 * the captured one, and project every bird through the shot's camera.
 *
 * A bird counts at any size: a sub-pixel bird still changes a few pixels.
 * It also flies the same flocks on for 200 s and reports how often a bird
 * is in frame then — what an UNPINNED capture of the pose can show.
 *
 * And it lists the shots whose DRAW COUNT depends on wildlife history: deer and
 * boar draw legs, antlers and tusks only at near LOD, and every wildlife batch
 * is drawn in or out of frame.
 *
 * The camera is the renderer's own, at rest (`scripts/wildlifeShotCamera.mts`):
 * the chase and cockpit rigs composed from the renderer's pure rig functions and
 * projected through a Babylon camera set up as the renderer's. It used to be a
 * hand-built approximation, exact only wings level at zero pitch, which put
 * points 118-157 px from where the render drew them on the banked motion shots
 * (tests/render.wildlife-shot-camera.test.ts holds the new one to 0.1 px).
 *
 * APPROXIMATIONS, both on the side of reporting a bird rather than missing one:
 *  - terrain, tree and cloud occlusion are ignored, so a bird behind a ridge or
 *    a boar under a crown counts;
 *  - bird shadows are not counted.
 * The capture-side check on `bd7a584` (docs/findings/WILDLIFE_CAPTURE_PIN_2026_09_22.md)
 * is the check on it.
 *
 * `resolvePlacement` below MIRRORS the harness's (tests/perf/perf-capture.test.ts);
 * if the harness's changes, this one must follow.
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { densityField } from "../src/render/webgpu/detail/densityField";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import { WildlifeSystem, type BirdAgent, type GroundAnimalAgent, type WildlifeAgent } from "../src/render/webgpu/wildlife";
import { createWildlifePrototypeGeometry } from "../src/render/webgpu/wildlife/appearance";
import { createWorld, sampleTerrain, sampleTerrainHeight } from "../src/world";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_MEASURE_FRAMES,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_TEMPORAL_FRAMES,
  PERF_CAPTURE_WIDTH,
  headingVectorFromYaw,
  locateShotOffset,
  yawForSunBearing,
  type PerfCaptureShotDefinition,
} from "./perf-capture.mts";
import { wildlifeShotCamera } from "./wildlifeShotCamera.mts";

// The harness's renders from the pin to the captured frame (see its comments).
const STATIC_FRAMES_FROM_PIN = 150 + 4 + PERF_CAPTURE_MEASURE_FRAMES + 1;
const MOTION_FRAMES_FROM_PIN = STATIC_FRAMES_FROM_PIN + PERF_CAPTURE_TEMPORAL_FRAMES + 600;
const MOTION_DRAIN_FRAMES = 600;
const PROFILE = resolveWebGpuQualityProfile("medium", "balanced");
const DEG = Math.PI / 180;
/** `assignWildlifeLod`'s ground-animal near distance. */
const GROUND_NEAR_METERS = 460;

// A bird's drawn size: wing tip to wing tip across both wings.
function spanMeters(species: "gull" | "hawk"): number {
  const wing = createWildlifePrototypeGeometry(`bird-${species}-wing`).positions;
  let maxX = 0;
  for (let i = 0; i < wing.length; i += 3) maxX = Math.max(maxX, Math.abs(wing[i]!));
  return 2 * maxX + 0.2;
}
const SPAN = { gull: spanMeters("gull"), hawk: spanMeters("hawk") };

type V = { x: number; y: number; z: number };

const world = createWorld(PERF_CAPTURE_SEED, { worldEvolution: "analytic" });
const airportX = world.airport?.centerX ?? 0;
const airportZ = world.airport?.centerZ ?? 0;

// ---- MIRROR of the harness's resolvePlacement ----
function resolvePlacement(shot: PerfCaptureShotDefinition): { offsetXMeters: number; offsetZMeters: number } {
  const fallback = { offsetXMeters: shot.offsetXMeters, offsetZMeters: shot.offsetZMeters };
  if (!shot.locate || shot.locate === "fixed") return fallback;
  if (shot.locate === "forest") {
    return locateShotOffset((x, z) => {
      for (const [dx, dz] of [[0, 0], [250, 0], [-250, 0], [0, 250], [0, -250]] as const) {
        if (sampleTerrain(world, airportX + x + dx, airportZ + z + dz).biomeName !== "forest") return false;
      }
      return true;
    }) ?? fallback;
  }
  if (shot.locate === "grassland") {
    return locateShotOffset((x, z) => {
      for (const [dx, dz] of [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]] as const) {
        const sample = sampleTerrain(world, airportX + x + dx, airportZ + z + dz);
        if (sample.biomeName !== "grassland") return false;
        if (sample.slope > 0.08) return false;
        if (sample.isRunway) return false;
        if (sample.airportInfluence < 0.35 || sample.airportInfluence > 0.85) return false;
      }
      return true;
    }, { stepMeters: 120, maxRadiusMeters: 3_000 }) ?? fallback;
  }
  if (shot.locate === "mountain") {
    return locateShotOffset((x, z) => {
      const here = sampleTerrain(world, airportX + x, airportZ + z);
      if (here.height < world.seaLevel + 5 || here.slope > 0.3) return false;
      let steep = 0;
      for (const ahead of [400, 650, 900] as const) {
        const face = sampleTerrain(world, airportX + x + ahead, airportZ + z);
        if (face.slope > 0.4 && face.height > here.height + 180) steep += 1;
      }
      return steep >= 2;
    }, { stepMeters: 400, maxRadiusMeters: 20_000 }) ?? fallback;
  }
  if (shot.locate === "cliff") {
    return locateShotOffset((x, z) => {
      const here = sampleTerrain(world, airportX + x, airportZ + z);
      if (here.height < world.seaLevel + 5 || here.slope > 0.3) return false;
      let steep = 0;
      for (const ahead of [120, 200, 280] as const) {
        const face = sampleTerrain(world, airportX + x + ahead, airportZ + z);
        if (face.slope > 0.45 && face.height > here.height + 60) steep += 1;
      }
      return steep >= 2;
    }, { stepMeters: 300, maxRadiusMeters: 20_000 }) ?? fallback;
  }
  if (shot.locate === "canopy-backlit") {
    const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
    const heading = headingVectorFromYaw(yawForSunBearing(
      sunDirectionForClock(clock, world.latitudeDegrees), shot.relativeSunBearingDegrees ?? 0));
    return locateShotOffset((x, z) => {
      for (let ahead = 0; ahead <= 2_400; ahead += 200) {
        const sx = airportX + x + heading.x * ahead;
        const sz = airportZ + z + heading.z * ahead;
        const sample = sampleTerrain(world, sx, sz);
        if (sample.biomeName === "water") return false;
        const field = densityField(world.sourceSeedHash, {
          x: sx, z: sz, heightMeters: sample.height, seaLevelMeters: world.seaLevel,
          slope: sample.slope, moisture: sample.moisture, normalX: sample.normal.x,
          normalZ: sample.normal.z, airportInfluence: sample.airportInfluence,
          dayOfYear: clock.dayOfYear, filterWidthMeters: 0,
        });
        if (field.treeStemsPerSquareMeter < 0.006 || field.heightFactor < 0.35) return false;
      }
      return true;
    }, { stepMeters: 500, maxRadiusMeters: 18_000 }) ?? fallback;
  }
  if (shot.locate === "coast") {
    return locateShotOffset((x, z) => {
      if (sampleTerrainHeight(world, airportX + x, airportZ + z) > world.seaLevel - 2) return false;
      return sampleTerrainHeight(world, airportX + x + 3_000, airportZ + z) > world.seaLevel + 5;
    }, { maxRadiusMeters: 20_000 }) ?? fallback;
  }
  throw new Error(`unmirrored locate mode ${String(shot.locate)}`);
}
// ---- end mirror ----

const rows: string[] = [];
const withBirds: string[] = [];
const unpinnedWithBirds: string[] = [];
const drawVolatile: string[] = [];
for (const shot of PERF_CAPTURE_SHOTS) {
  if ((shot.worldEvolution ?? "analytic") !== "analytic") {
    rows.push(`${shot.name.padEnd(34)} (eroded world — not modelled)`);
    continue;
  }
  const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
  const placement = resolvePlacement(shot);
  let x = airportX + placement.offsetXMeters;
  let z = airportZ + placement.offsetZMeters;
  const ground = sampleTerrainHeight(world, x, z);
  const altitude = shot.altitudeAglMeters !== null ? ground + shot.altitudeAglMeters : shot.altitudeMslMeters!;
  let yaw = shot.relativeSunBearingDegrees !== undefined
    ? yawForSunBearing(sunDirectionForClock(clock, world.latitudeDegrees), shot.relativeSunBearingDegrees)
    : 0;
  const isMotion = shot.kind === "motion";
  const bank = isMotion ? shot.bankDegrees ?? 0 : 0;
  const turnRate = isMotion ? (9.81 * Math.tan(bank * DEG)) / Math.max(20, shot.airspeedMetersPerSecond) : 0;

  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  // A fresh system is exactly what the pin leaves: no agents, clocks at zero.
  const wildlife = new WildlifeSystem(scene, {
    worldSeed: world.seed,
    terrainSample: (sx, sz) => sampleTerrain(world, sx, sz),
  });
  const observer = () => {
    const h = headingVectorFromYaw(yaw);
    return { x, y: altitude, z, velocityX: shot.airspeedMetersPerSecond * h.x, velocityY: 0, velocityZ: shot.airspeedMetersPerSecond * h.z };
  };
  let stepped = 0;
  const step = () => {
    wildlife.update(observer(), { x: 0, y: 0, z: 0 }, PROFILE, 1 / 60);
    stepped += 1;
  };
  for (let f = 0; f < 154; f += 1) step(); // settle + drain, parked
  const moving = PERF_CAPTURE_MEASURE_FRAMES + (isMotion ? PERF_CAPTURE_TEMPORAL_FRAMES : 0);
  for (let f = 0; f < moving; f += 1) {
    if (isMotion) {
      yaw += (turnRate / DEG) / 60;
      const h = headingVectorFromYaw(yaw);
      x += (shot.airspeedMetersPerSecond * h.x) / 60;
      z += (shot.airspeedMetersPerSecond * h.z) / 60;
    }
    step();
  }
  for (let f = 0; f < (isMotion ? MOTION_DRAIN_FRAMES : 0) + 1; f += 1) step(); // drain, then the capture
  const expected = isMotion ? MOTION_FRAMES_FROM_PIN : STATIC_FRAMES_FROM_PIN;
  if (stepped !== expected) throw new Error(`${shot.name}: stepped ${stepped} frames, the harness renders ${expected}`);
  const agents = () => (wildlife as unknown as { agents: WildlifeAgent[] }).agents;
  // Deer and boar draw their legs, antlers and tusks only at "near" LOD (within
  // GROUND_NEAR_METERS of the aircraft, `assignWildlifeLod`), and every
  // wildlife batch is drawn whether or not it is in frame. So which animals are
  // near decides the DRAW COUNT, even on a shot with no animal in view.
  const nearGround = () => agents()
    .filter((agent): agent is GroundAnimalAgent => agent.kind === "ground")
    .filter((agent) => Math.hypot(agent.position.x - x, agent.position.y - altitude, agent.position.z - z) <= GROUND_NEAR_METERS)
    .map((agent) => agent.species).sort().join(",");
  const pinnedNearGround = nearGround();
  const birds = agents().filter((agent): agent is BirdAgent => agent.kind === "bird");

  // The camera at capture: the renderer's rig at rest, around the aircraft.
  const width = shot.viewportWidth ?? PERF_CAPTURE_WIDTH;
  const height = shot.viewportHeight ?? PERF_CAPTURE_HEIGHT;
  const camera = wildlifeShotCamera({
    cameraMode: shot.cameraMode,
    aircraft: { x, y: altitude, z },
    yawDegrees: yaw,
    pitchDownDegrees: shot.pitchDownDegrees,
    bankDegrees: bank,
    airspeedMetersPerSecond: shot.airspeedMetersPerSecond,
    width,
    height,
    terrainHeight: (sx, sz) => sampleTerrain(world, sx, sz).height,
  });
  const pixelsPerRadian = camera.pixelsPerRadian;
  const project = (position: V) => {
    const p = camera.project(position);
    return p && { ...p, px: Math.round(p.x), py: Math.round(p.y) };
  };
  const inFrame: { px: number; distance: number; at: string }[] = [];
  let nearMiss = 0;
  for (const bird of birds) {
    const p = project(bird.position);
    if (!p) continue;
    const size = (SPAN[bird.species] / p.depth) * pixelsPerRadian;
    if (p.ax <= 1 && p.ay <= 1) inFrame.push({ px: size, distance: p.distance, at: `(${p.px},${p.py})` });
    else if (p.ax <= 1.15 && p.ay <= 1.15) nearMiss += 1;
  }
  const visible = inFrame.filter((b) => b.px >= 1);
  const largest = inFrame.reduce((m, b) => Math.max(m, b.px), 0);
  const nearest = inFrame.reduce((m, b) => Math.min(m, b.distance), Infinity);
  rows.push(
    `${shot.name.padEnd(34)} ${shot.cameraMode.padEnd(7)} birds active ${String(birds.length).padStart(2)}`
    + `  in frame ${String(inFrame.length).padStart(2)} (>=1 px ${String(visible.length).padStart(2)})`
    + `  largest ${largest.toFixed(1).padStart(5)} px  nearest ${Number.isFinite(nearest) ? `${nearest.toFixed(0).padStart(5)} m` : "      -"}`
    + (nearMiss ? `  +${nearMiss} just outside` : ""),
  );
  if (inFrame.length > 0) withBirds.push(`${shot.name} (${inFrame.length}, largest ${largest.toFixed(1)} px)`);
  if (inFrame.length > 0) {
    rows.push(`${"".padEnd(36)}at ${inFrame.sort((a, b) => b.px - a.px).map((b) => `${b.at} ${b.px.toFixed(1)}px`).join(" ")}`);
  }
  // UNPINNED: the same flocks, flown on for 200 s and sampled every 0.5 s —
  // how often an unpinned capture of this pose has a bird in frame, any size.
  let samplesWithBird = 0;
  const otherNearSets = new Set<string>();
  const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const SAMPLES = 400;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    for (let f = 0; f < 30; f += 1) step();
    const flying = agents().filter((agent): agent is BirdAgent => agent.kind === "bird");
    const near = nearGround();
    if (near !== pinnedNearGround) otherNearSets.add(near || "none");
    let any = false;
    for (const bird of flying) {
      const p = project(bird.position);
      if (p === null || p.ax > 1 || p.ay > 1) continue;
      any = true;
      box.x0 = Math.min(box.x0, p.px); box.x1 = Math.max(box.x1, p.px);
      box.y0 = Math.min(box.y0, p.py); box.y1 = Math.max(box.y1, p.py);
    }
    if (any) samplesWithBird += 1;
  }
  const unpinned = samplesWithBird / SAMPLES;
  rows[rows.length - (inFrame.length > 0 ? 2 : 1)] += `  | unpinned: bird in frame ${(100 * unpinned).toFixed(0).padStart(3)}% of instants`
    + (samplesWithBird > 0 ? `, within x ${box.x0}-${box.x1} y ${box.y0}-${box.y1}` : "");
  if (unpinned > 0) unpinnedWithBirds.push(`${shot.name} (${(100 * unpinned).toFixed(0)}%)`);
  if (otherNearSets.size > 0) {
    drawVolatile.push(`${shot.name}: pinned near [${pinnedNearGround || "none"}], unpinned also [${[...otherNearSets].join("] [")}]`);
  }
  camera.dispose();
  wildlife.dispose();
  scene.dispose();
  engine.dispose();
}
console.log(`span: gull ${SPAN.gull.toFixed(2)} m, hawk ${SPAN.hawk.toFixed(2)} m; budget ${PROFILE.activeAnimalBudget} animals\n`);
for (const row of rows) console.log(row);
console.log(`\nPINNED — ${withBirds.length} of ${PERF_CAPTURE_SHOTS.length} shots with a bird in frame at capture (count, largest):\n  ${withBirds.join("\n  ")}`);
console.log(`\nUNPINNED — ${unpinnedWithBirds.length} shots can have one (share of instants):\n  ${unpinnedWithBirds.join("\n  ")}`);
console.log(`\nDRAW-COUNT VOLATILE UNPINNED — ${drawVolatile.length} shots whose near deer/boar set changes with history:\n  ${drawVolatile.join("\n  ") || "none"}`);
