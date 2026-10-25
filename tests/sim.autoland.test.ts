import { describe, expect, it } from "vitest";
import {
  aircraftDefinition,
  AIRCRAFT_KINDS,
  Autoland,
  autolandProfile,
  FIXED_TIME_STEP,
  FlightSimulator,
  type AircraftKind,
  type AutolandStatus,
  type FlightControls,
  type SpawnOptions,
} from "../src/sim";
import { createSimulationSpawn } from "../src/game/spawn";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import {
  createWorld,
  isPointOnRunway,
  nearestAirport,
  sampleWind,
  type AirportDefinition,
  type WorldDefinition,
} from "../src/world";

/**
 * The autoland flies the real flight model, in the real world's terrain and
 * wind, from engagement to a stop: these are those flights, measured. What
 * "gracefully" means is written down as numbers: a touchdown under 1.2 m/s on
 * the mains, a nosewheel that is lowered rather than dropped, the aeroplane
 * stopped on the runway, and no part of the envelope (angle of attack, bank)
 * exceeded on the way. "Loop around and try again" is exercised twice: by a
 * start too high and close to land straight in, which the planner answers with
 * a circuit, and by a microburst on short final, which the stabilised-approach
 * gates answer with a go-around and a second approach.
 */

const SEED = 0x51a7e;
const DEG = Math.PI / 180;

type Scenario = "spawn" | "short-high" | "away";

interface Flight {
  status: AutolandStatus;
  crashed: boolean;
  onRunway: boolean;
  peakImpact: number;
  phases: string[];
  /** Largest bank actually flown, radians, from the simulator's telemetry. */
  peakBank: number;
  /** Total heading change flown, radians: a loop shows as more than pi. */
  turned: number;
  /** Seconds from the touchdown to the stop. */
  rolloutSeconds: number;
  /**
   * Largest angle of the nose to the runway with every wheel down below
   * 30 m/s, and at the stop, radians.
   */
  slowHeadingError: number;
  stopHeadingError: number;
  runway: AirportDefinition;
  aircraftKind: AircraftKind;
}

function spawnFor(world: WorldDefinition, kind: AircraftKind, scenario: Scenario): SpawnOptions {
  const airport = world.airport!;
  const spawn = createSimulationSpawn(world, "airborne", 450, kind);
  const dirX = Math.sin(airport.headingRadians);
  const dirZ = Math.cos(airport.headingRadians);
  if (scenario === "short-high") {
    // Lined up 1.5 km short of the threshold and 400 m up: far above any
    // glidepath, so it cannot land straight in.
    const distance = airport.runwayLength / 2 + 1_500;
    spawn.position = {
      x: airport.centerX - dirX * distance,
      y: airport.elevation + 400,
      z: airport.centerZ - dirZ * distance,
    };
    spawn.heading = airport.headingRadians;
  } else if (scenario === "away") {
    spawn.heading = airport.headingRadians + Math.PI;
  }
  return spawn;
}

function flyAutoland(
  kind: AircraftKind,
  scenario: Scenario,
  { microburst = 0, seconds = 1_500 }: { microburst?: number; seconds?: number } = {},
): Flight {
  const world = createWorld(SEED);
  const contact = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86 };
  const wind = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
  const sim = new FlightSimulator({
    aircraft: aircraftDefinition(kind),
    spawn: spawnFor(world, kind, scenario),
    environment: {
      terrain: (x, z) => sampleGroundContact(world, x, z, contact),
      terrainHeight: (x, z) => sampleGroundHeight(world, x, z),
      seaLevel: world.seaLevel,
      wind,
    },
  });
  const autoland = new Autoland(sim.aircraft);
  const input = {
    state: sim.state,
    telemetry: sim.telemetry(),
    terrainHeight: (x: number, z: number) => sampleGroundHeight(world, x, z),
    seaLevel: world.seaLevel,
    dt: FIXED_TIME_STEP,
  };
  const controls: FlightControls = { ...sim.controls };
  const runway = nearestAirport(world, sim.state.position.x, sim.state.position.z)!.airport;
  expect(autoland.engage(runway, input, controls)).toBe(true);
  const phases: string[] = [autoland.status.phase];
  // A microburst: a column of sinking air 800 m across, laid 1.2 km ahead of
  // the aeroplane as it joins its first final, that dies away over 15 s once
  // that approach is abandoned. Smooth in space and time, as a real one is,
  // so what the aeroplane meets is a downdraft, not a step in the relative
  // wind (which spikes the angle of attack by itself).
  let burstX = Number.NaN;
  let burstZ = Number.NaN;
  let burstStrength = 0;
  let peakBank = 0;
  let turned = 0;
  let lastHeading = input.telemetry.heading;
  let touchdownTime = Number.NaN;
  let slowHeadingError = 0;
  const headingError = () => Math.abs(Math.atan2(
    Math.sin(sim.telemetry().heading - autoland.status.runwayHeading),
    Math.cos(sim.telemetry().heading - autoland.status.runwayHeading),
  ));
  for (let step = 0; step < seconds / FIXED_TIME_STEP; step += 1) {
    const position = sim.state.position;
    sampleWind(world, position.x, position.y, position.z, sim.state.time, wind);
    input.state = sim.state;
    input.telemetry = sim.telemetry();
    if (microburst > 0) {
      if (Number.isNaN(burstX) && autoland.status.phase === "final") {
        const speed = Math.hypot(sim.state.velocity.x, sim.state.velocity.z);
        burstX = position.x + (sim.state.velocity.x / speed) * 1_200;
        burstZ = position.z + (sim.state.velocity.z / speed) * 1_200;
        burstStrength = microburst;
      }
      if (autoland.status.attempt > 1 || autoland.status.phase === "go-around") {
        burstStrength *= Math.exp(-FIXED_TIME_STEP / 15);
      }
      if (!Number.isNaN(burstX)) {
        const r2 = ((position.x - burstX) ** 2 + (position.z - burstZ) ** 2) / 800 ** 2;
        wind.y -= burstStrength * Math.exp(-r2);
      }
    }
    if (!sim.state.onGround) peakBank = Math.max(peakBank, Math.abs(input.telemetry.bank));
    let delta = input.telemetry.heading - lastHeading;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    turned += Math.abs(delta);
    lastHeading = input.telemetry.heading;
    autoland.update(input, controls);
    if (phases.at(-1) !== autoland.status.phase) phases.push(autoland.status.phase);
    // The last touchdown: a bounce back into the air starts it again.
    if (autoland.status.phase === "rollout") {
      if (Number.isNaN(touchdownTime)) touchdownTime = sim.state.time;
    } else if (autoland.status.phase !== "landed") {
      touchdownTime = Number.NaN;
    }
    sim.setControls(controls);
    sim.step(FIXED_TIME_STEP);
    if (
      autoland.status.phase === "rollout"
      && Math.hypot(sim.state.velocity.x, sim.state.velocity.z) < 30
      && sim.state.dynamics.contactCount === sim.aircraft.gear.length
    ) {
      slowHeadingError = Math.max(slowHeadingError, headingError());
    }
    if (sim.state.crashed || autoland.status.phase === "landed" || !autoland.engaged) break;
  }
  return {
    status: { ...autoland.status },
    crashed: sim.state.crashed,
    onRunway: isPointOnRunway(runway, sim.state.position.x, sim.state.position.z),
    peakImpact: sim.state.peakImpactSpeed,
    phases,
    peakBank,
    turned,
    rolloutSeconds: sim.state.time - touchdownTime,
    slowHeadingError,
    stopHeadingError: headingError(),
    runway,
    aircraftKind: kind,
  };
}

function expectGracefulLanding(flight: Flight): void {
  const aircraft = aircraftDefinition(flight.aircraftKind);
  const profile = autolandProfile(aircraft);
  const label = `${flight.aircraftKind}: ${flight.phases.join(" > ")}`;
  expect(flight.crashed, label).toBe(false);
  expect(flight.status.phase, label).toBe("landed");
  expect(flight.onRunway, label).toBe(true);
  // Positive, aimed at 0.7-0.9 m/s by type, and firmest for the 747 on a
  // runway this short for it; a passenger would call any of these a landing,
  // not an arrival.
  expect(flight.status.touchdownSinkRate, label).toBeLessThan(1.2);
  // Mains in the touchdown zone, nowhere near the far end.
  expect(flight.status.touchdownDistance, label).toBeGreaterThan(150);
  expect(flight.status.touchdownDistance, label).toBeLessThan(flight.runway.runwayLength * 0.4);
  // The highest contact speed of any wheel, nosewheel included.
  expect(flight.peakImpact, label).toBeLessThan(1.6);
  // Inside the envelope throughout: below the stall angle, inside the bank limit.
  expect(flight.status.peakAngleOfAttack, label).toBeLessThan(aircraft.positiveStallAngle);
  expect(flight.peakBank, label).toBeLessThan(profile.maxBank + 2 * DEG);
  // A decisive stop, square to the runway: the rollout steers the nose down
  // it rather than across it ("it should make sure the plane is parallel to
  // the runway", Jason, 2026-10-25), and the autobrake holds at least 0.36 g.
  expect(flight.rolloutSeconds, label).toBeLessThan(24);
  expect(flight.slowHeadingError, label).toBeLessThan(1.5 * DEG);
  expect(flight.stopHeadingError, label).toBeLessThan(0.5 * DEG);
}

describe("autoland profile", () => {
  it("derives every aeroplane's limits from its own airframe", () => {
    for (const kind of AIRCRAFT_KINDS) {
      const aircraft = aircraftDefinition(kind);
      const profile = autolandProfile(aircraft);
      expect(profile.referenceSpeed, kind).toBeCloseTo(1.3 * profile.stallLanding, 9);
      expect(profile.patternSpeed, kind).toBeGreaterThan(profile.referenceSpeed);
      expect(profile.maxAngleOfAttack, kind).toBeLessThan(aircraft.positiveStallAngle);
      expect(profile.maxFlarePitch, kind).toBeGreaterThan(5 * DEG);
      expect(profile.groundBank, kind).toBeLessThanOrEqual(5 * DEG);
      expect(profile.energyGradient, kind).toBeGreaterThan(0);
      expect(profile.aimPoint, kind).toBeGreaterThan(120);
      expect(profile.aimPoint, kind).toBeLessThanOrEqual(300);
    }
    // The trainer aims at the painted aiming point; the 747 well short of it.
    expect(autolandProfile(aircraftDefinition("trainer")).aimPoint).toBe(300);
    expect(autolandProfile(aircraftDefinition("airliner")).aimPoint).toBeLessThan(220);
  });

  it("will not engage on the ground", () => {
    const world = createWorld(SEED);
    const sim = new FlightSimulator({
      aircraft: aircraftDefinition("trainer"),
      spawn: createSimulationSpawn(world, "runway", 450, "trainer"),
      environment: {
        terrain: (x, z) => sampleGroundContact(world, x, z, {
          height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86,
        }),
        terrainHeight: (x, z) => sampleGroundHeight(world, x, z),
        seaLevel: world.seaLevel,
        wind: { x: 0, y: 0, z: 0 },
      },
    });
    sim.step(FIXED_TIME_STEP);
    const autoland = new Autoland(sim.aircraft);
    const input = {
      state: sim.state,
      telemetry: sim.telemetry(),
      terrainHeight: (x: number, z: number) => sampleGroundHeight(world, x, z),
      seaLevel: world.seaLevel,
      dt: FIXED_TIME_STEP,
    };
    expect(autoland.engage(world.airport!, input, { ...sim.controls })).toBe(false);
    expect(autoland.engaged).toBe(false);
  });
});

describe("autoland flights", { timeout: 120_000 }, () => {
  for (const kind of AIRCRAFT_KINDS) {
    it(`lands the ${kind} from the airborne start`, () => {
      const flight = flyAutoland(kind, "spawn");
      expectGracefulLanding(flight);
      expect(flight.status.attempt).toBe(1);
    });
  }

  for (const kind of AIRCRAFT_KINDS) {
    it(`turns the ${kind} round from a start pointed away from the field`, () => {
      const flight = flyAutoland(kind, "away");
      expectGracefulLanding(flight);
      expect(flight.turned).toBeGreaterThan(Math.PI * 0.75);
    });
  }

  it("turns round to lose height when the start is too high and close to land", () => {
    const flight = flyAutoland("trainer", "short-high");
    expectGracefulLanding(flight);
    expect(flight.status.attempt).toBe(1);
    // Lined up already, so landing straight in would turn nothing: what it
    // flies instead is at least a full reversal. That was a circuit back to
    // this end until the steeper descent (2026-10-25) made the shorter way
    // round, onto the other end of the runway, the one that loses the height.
    expect(flight.turned).toBeGreaterThan(Math.PI);
  });

  // Downdraft strengths that defeat each aeroplane's stabilised approach. The
  // jets fly through anything much weaker and land off the first approach,
  // which is the right answer to a downdraft they can out-climb.
  const microbursts: Record<AircraftKind, number> = {
    trainer: 7,
    jet: 25,
    bizjet: 28,
    airliner: 28,
  };
  for (const kind of AIRCRAFT_KINDS) {
    it(`goes around from a microburst on the ${kind}'s first final, and lands on the second`, () => {
      const flight = flyAutoland(kind, "spawn", { microburst: microbursts[kind], seconds: 2_000 });
      expect(flight.phases).toContain("go-around");
      expect(flight.status.goAroundReason).not.toBeNull();
      expect(flight.status.attempt).toBe(2);
      expectGracefulLanding(flight);
    });
  }
});
