/**
 * Does the menu flight stay where it was put?
 *
 * Jason's report: *"if I stay on the menu screen for a long time, the plane
 * keeps defaulting to flying higher and higher."* This flies the attract
 * flight headlessly for half an hour of simulated time per aircraft kind, on
 * pinned seeds, and reports what the altitude actually did.
 *
 * **It runs the SHIPPED control path, not a model of it.** The worker module
 * cannot be imported (it dereferences `self` at module scope, starts a
 * `setInterval` on load, and exports nothing), so the supervision was extracted
 * into `src/sim/attract.ts` and both the worker and this probe call it. The
 * terrain look-ahead is re-created here because it is worker-side wiring, and
 * it is re-created from the same constants and the same sampler.
 *
 *   npx tsx scripts/attract-hold-probe.mts [--legacy] [--no-turn] [kind ...]
 *
 * `--legacy` flies the OLD behaviour — neutral controls, Scenic's 2.5 degree
 * nose-up neutral, nothing supervising it — which is the "before" column.
 * `--no-turn` keeps the altitude hold but refuses to turn away, which is the
 * climb-only variant.
 */
import {
  AttractHold,
  attractScanOffset,
  attractScanSamples,
  ATTRACT_SCAN_TRAVEL_METERS,
  ATTRACT_SCAN_TURN_RADIANS,
  attractClimbRateFor,
  attractScanDistance,
  aircraftDefinition,
  applyFlightAssistance,
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  shouldReseedAttract,
  stallSpeed,
  AIRCRAFT_KINDS,
  type AircraftKind,
  type FlightControls,
} from "../src/sim";
import { airborneAirspeedForAircraft, createSimulationSpawn } from "../src/game/spawn";
import { createWorld, sampleTerrainCollision, sampleTerrainCollisionHeight } from "../src/world";

/** Half an hour of simulated flight, the length Jason's complaint is about. */
const SIMULATED_SECONDS = 1_800;
/** The player's default setting, and what the hold is asked to keep. */
const TARGET_CLEARANCE = 450;



interface Run {
  readonly kind: AircraftKind;
  readonly seed: number;
  readonly clearanceMin: number;
  readonly clearanceMax: number;
  readonly clearanceMean: number;
  readonly mslMin: number;
  readonly mslMax: number;
  readonly worstClimb: number;
  readonly worstDescent: number;
  readonly resets: number;
  readonly turningFraction: number;
  readonly finalClearance: number;
}

function flyOne(
  kind: AircraftKind,
  seed: number,
  variant: "legacy" | "hold" | "hold-no-turn",
): Run {
  const world = createWorld(seed);
  const aircraft = aircraftDefinition(kind);
  const seaLevel = world.seaLevel;
  const heightAt = (x: number, z: number): number =>
    Math.max(sampleTerrainCollisionHeight(world, x, z), seaLevel);

  let simulator = new FlightSimulator({
    aircraft,
    spawn: createSimulationSpawn(world, "airborne", TARGET_CLEARANCE, kind),
    environment: {
      terrain: (x, z) => sampleTerrainCollision(world, x, z),
      terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
      seaLevel,
    },
  });
  let hold = new AttractHold(simulator.controls.throttle);
  const attractControls: FlightControls = { ...DEFAULT_CONTROLS, ...simulator.controls };
  const out = { pitch: 0, roll: 0, throttle: 0 };
  const assisted: FlightControls = { ...DEFAULT_CONTROLS };

  const scan = { ahead: 0, left: 0, right: 0, distance: attractScanDistance(0) };
  let scanX = Number.NaN;
  let scanZ = Number.NaN;

  const scanTrack = (
    x: number, z: number, hx: number, hz: number, distance: number,
    altitude: number, groundSpeed: number,
  ): number => {
    const samples = attractScanSamples(distance);
    let steepest = -Infinity;
    for (let i = 1; i <= samples; i += 1) {
      const along = attractScanOffset(i, samples, distance);
      const height = heightAt(x + hx * along, z + hz * along);
      steepest = Math.max(steepest, attractClimbRateFor(height, along, altitude, groundSpeed));
    }
    return steepest;
  };

  let clearanceMin = Infinity;
  let clearanceMax = -Infinity;
  let clearanceSum = 0;
  let mslMin = Infinity;
  let mslMax = -Infinity;
  let worstClimb = -Infinity;
  let worstDescent = Infinity;
  let resets = 0;
  let turningSteps = 0;
  let samples = 0;

  const steps = Math.round(SIMULATED_SECONDS / FIXED_TIME_STEP);
  for (let step = 0; step < steps; step += 1) {
    const telemetry = simulator.telemetry();
    const position = simulator.state.position;

    if (variant !== "legacy") {
      const travelled = Math.hypot(position.x - scanX, position.z - scanZ);
      if (!(travelled < ATTRACT_SCAN_TRAVEL_METERS)) {
        scanX = position.x;
        scanZ = position.z;
        scan.distance = attractScanDistance(telemetry.groundSpeed);
        const heading = telemetry.heading; // radians, see the worker
        const hx = Math.sin(heading);
        const hz = Math.cos(heading);
        const cos = Math.cos(ATTRACT_SCAN_TURN_RADIANS);
        const sin = Math.sin(ATTRACT_SCAN_TURN_RADIANS);
        const alt = position.y;
        const gs = telemetry.groundSpeed;
        scan.ahead = scanTrack(position.x, position.z, hx, hz, scan.distance, alt, gs);
        scan.left = scanTrack(
          position.x, position.z, hx * cos + hz * sin, hz * cos - hx * sin, scan.distance, alt, gs,
        );
        scan.right = scanTrack(
          position.x, position.z, hx * cos - hz * sin, hz * cos + hx * sin, scan.distance, alt, gs,
        );
      }
      hold.update(
        {
          clearance: telemetry.altitudeAgl,
          targetClearance: TARGET_CLEARANCE,
          // Climb-only refuses to turn: feed it a track it must climb over.
          requiredClimbRate: scan.ahead,
          requiredClimbRateLeft: variant === "hold-no-turn" ? scan.ahead : scan.left,
          requiredClimbRateRight: variant === "hold-no-turn" ? scan.ahead : scan.right,
          verticalSpeed: telemetry.verticalSpeed,
          groundSpeed: telemetry.groundSpeed,
          equivalentAirspeed: telemetry.indicatedAirspeed,
          targetAirspeed: airborneAirspeedForAircraft(kind),
          stallSpeed: stallSpeed(aircraft, simulator.state.actuators.flaps),
          dt: FIXED_TIME_STEP,
        },
        out,
      );
      attractControls.pitch = out.pitch;
      attractControls.roll = variant === "hold-no-turn" ? 0 : out.roll;
      attractControls.throttle = out.throttle;
      if (hold.isTurning && variant !== "hold-no-turn") turningSteps += 1;
    }

    simulator.setControls(
      applyFlightAssistance(assisted, "scenic", attractControls, simulator.state, telemetry),
    );
    simulator.step(FIXED_TIME_STEP);

    const after = simulator.telemetry();
    if (shouldReseedAttract(simulator.state.crashed, after.altitudeAgl)) {
      resets += 1;
      simulator = new FlightSimulator({
        aircraft,
        spawn: createSimulationSpawn(world, "airborne", TARGET_CLEARANCE, kind),
        environment: {
          terrain: (x, z) => sampleTerrainCollision(world, x, z),
          terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
          seaLevel,
        },
      });
      hold = new AttractHold(simulator.controls.throttle);
      Object.assign(attractControls, DEFAULT_CONTROLS, simulator.controls);
      scanX = Number.NaN;
      scanZ = Number.NaN;
      continue;
    }

    if (step % 30 === 0) {
      clearanceMin = Math.min(clearanceMin, after.altitudeAgl);
      clearanceMax = Math.max(clearanceMax, after.altitudeAgl);
      clearanceSum += after.altitudeAgl;
      mslMin = Math.min(mslMin, simulator.state.position.y);
      mslMax = Math.max(mslMax, simulator.state.position.y);
      worstClimb = Math.max(worstClimb, after.verticalSpeed);
      worstDescent = Math.min(worstDescent, after.verticalSpeed);
      samples += 1;
    }
  }

  return {
    kind,
    seed,
    clearanceMin,
    clearanceMax,
    clearanceMean: clearanceSum / Math.max(samples, 1),
    mslMin,
    mslMax,
    worstClimb,
    worstDescent,
    resets,
    turningFraction: turningSteps / Math.max(steps, 1),
    finalClearance: simulator.telemetry().altitudeAgl,
  };
}

/** Pinned: two ordinary worlds and one chosen for its mountains. */
const SEEDS: readonly { readonly seed: number; readonly label: string }[] = [
  { seed: 0x51a7e, label: "default" },
  { seed: 0x2c0de, label: "second" },
  { seed: 0x7a1b3, label: "mountainous" },
];

const argv = process.argv.slice(2);
const variant = argv.includes("--legacy")
  ? "legacy"
  : argv.includes("--no-turn") ? "hold-no-turn" : "hold";
const kinds = argv.filter((a) => !a.startsWith("--")) as AircraftKind[];
const selected = kinds.length > 0 ? kinds : [...AIRCRAFT_KINDS];

console.log(`attract hold probe - variant ${variant}, ${SIMULATED_SECONDS} s per run\n`);
console.log(
  "kind     seed          clearance min/mean/max      MSL min/max        worst climb/descent  resets  turning",
);
for (const kind of selected) {
  for (const { seed, label } of SEEDS) {
    const r = flyOne(kind, seed, variant);
    console.log(
      `${kind.padEnd(8)} ${label.padEnd(12)} `
      + `${r.clearanceMin.toFixed(0).padStart(6)}/${r.clearanceMean.toFixed(0).padStart(6)}/${r.clearanceMax.toFixed(0).padStart(7)}  `
      + `${r.mslMin.toFixed(0).padStart(6)}/${r.mslMax.toFixed(0).padStart(7)}  `
      + `${r.worstClimb.toFixed(2).padStart(7)}/${r.worstDescent.toFixed(2).padStart(7)}  `
      + `${String(r.resets).padStart(5)}  ${(r.turningFraction * 100).toFixed(0).padStart(4)}%`,
    );
  }
}
