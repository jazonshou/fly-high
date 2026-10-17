import { describe, expect, it } from "vitest";
import {
  applyFlightAssistance,
  calculateDragCoefficient,
  calculateEngineThrust,
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FAST_JET,
  FIXED_TIME_STEP,
  FlightSimulator,
  LIGHT_TRAINER,
  aircraftDefinition,
  standardAirDensity,
  type AircraftDefinition,
  type FlightControls,
  type FlightState,
} from "../src/sim";
import { createSimulationSpawn } from "../src/game/spawn";
import { aircraftSpec } from "../src/aircraft/catalogue";
import {
  createWorld,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  sampleWind,
} from "../src/world";

const FLAT_RUNWAY = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  friction: 1.15,
} as const;

function advance(
  simulator: FlightSimulator,
  seconds: number,
  controls: (simulator: FlightSimulator) => FlightControls,
): void {
  for (let index = 0; index < Math.round(seconds / FIXED_TIME_STEP); index += 1) {
    simulator.step(FIXED_TIME_STEP, controls(simulator));
  }
}

function expectFiniteState(state: FlightState): void {
  expect([
    state.time,
    state.position.x,
    state.position.y,
    state.position.z,
    state.velocity.x,
    state.velocity.y,
    state.velocity.z,
    state.orientation.x,
    state.orientation.y,
    state.orientation.z,
    state.orientation.w,
    state.angularVelocity.x,
    state.angularVelocity.y,
    state.angularVelocity.z,
    state.dynamics.airspeed,
    state.dynamics.loadFactor,
  ].every(Number.isFinite)).toBe(true);
}

function runSustainedFlight(aircraft: AircraftDefinition, airspeed: number): FlightSimulator {
  const cruiseGear = aircraft.retractableGear ? 0 : 1;
  const simulator = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: 3_000, z: 0 },
      heading: Math.PI / 2,
      pitch: (2.4 * Math.PI) / 180,
      airspeed,
      controls: { ...DEFAULT_CONTROLS, throttle: 0.72, gear: cruiseGear },
    },
    controls: { ...DEFAULT_CONTROLS, throttle: 0.72, gear: cruiseGear },
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  advance(simulator, 30, (current) => applyFlightAssistance(
    { ...DEFAULT_CONTROLS },
    "scenic",
    { ...DEFAULT_CONTROLS, throttle: 0.9, gear: cruiseGear },
    current.state,
    current.telemetry(),
  ));
  return simulator;
}

describe("fast jet flight model", () => {
  it("places its airborne spawn at the exact requested wheel AGL", () => {
    const world = createWorld(0x51a7e);
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: createSimulationSpawn(world, "airborne", 975, "jet"),
      environment: {
        terrain: (x, z) => sampleTerrainCollision(world, x, z),
        terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
      },
    });

    expect(simulator.telemetry().altitudeAgl).toBeCloseTo(975, 8);
    expect(simulator.state.onGround).toBe(false);
    // The catalogue figure is an EQUIVALENT airspeed at sea level; the spawn
    // converts it for the air it starts in, so the true airspeed here is
    // higher and the throttle is richer. Asserting the RELATIONSHIP rather
    // than either raw number — this test is about the wheel AGL anyway, and
    // pinning the catalogue value would just re-break when it next moves.
    const spawnAirspeed = simulator.telemetry().airspeed;
    expect(spawnAirspeed).toBeGreaterThan(aircraftSpec("jet").spawn.airborneAirspeed);
    expect(spawnAirspeed).toBeLessThan(aircraftSpec("jet").spawn.airborneAirspeed * 1.3);
    expect(simulator.state.actuators.throttle)
      .toBeGreaterThanOrEqual(aircraftSpec("jet").spawn.airborneThrottle);
    expect(simulator.state.actuators.gear).toBe(0);
  });

  it("cycles retractable gear through a timed transit and accounts for gear and speed-brake drag", () => {
    const cleanDrag = calculateDragCoefficient(0, FAST_JET.clZero, 0, FAST_JET, 0, 0);
    const gearDrag = calculateDragCoefficient(0, FAST_JET.clZero, 0, FAST_JET, 1, 0);
    const brakeDrag = calculateDragCoefficient(0, FAST_JET.clZero, 0, FAST_JET, 0, 1);
    expect(gearDrag).toBeGreaterThan(cleanDrag + 0.04);
    expect(brakeDrag).toBeGreaterThan(cleanDrag + 0.15);

    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 2_000, z: 0 },
        airspeed: 120,
        controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      environment: { gravity: 0, wind: { x: 0, y: 0, z: 0 } },
    });
    advance(simulator, 1, () => ({ ...DEFAULT_CONTROLS, gear: 1, throttle: 0 }));
    expect(simulator.state.actuators.gear).toBeCloseTo(FAST_JET.gearCycleRate, 2);
    advance(simulator, 2, () => ({ ...DEFAULT_CONTROLS, gear: 1, throttle: 0 }));
    expect(simulator.state.actuators.gear).toBe(1);
    advance(simulator, 2.5, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0 }));
    expect(simulator.state.actuators.gear).toBe(0);

    const parked = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: { onGround: true, terrainHeight: 0, controls: { ...DEFAULT_CONTROLS, throttle: 0 } },
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    advance(parked, 3, () => ({ ...DEFAULT_CONTROLS, throttle: 0, brake: 1, gear: 0 }));
    expect(parked.state.actuators.gear).toBe(1);
    expect(parked.state.crashed).toBe(false);
  });

  it("treats a gear-up runway contact as airframe damage", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 0.68, z: 0 },
        velocity: { x: 0, y: -1.2, z: 68 },
        pitch: 0,
        controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });

    advance(simulator, 0.25, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0 }));
    expect(simulator.state.crashed).toBe(true);
    expect(simulator.state.onGround).toBe(true);
    expect(simulator.state.actuators.gear).toBe(0);
  });

  it("uses the brake command as an aerodynamic speed brake away from wheel contact", () => {
    const createCruise = () => new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 2_000, z: 0 },
        airspeed: 145,
        pitch: 0,
        controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      environment: { gravity: 0, airDensity: 1.225, wind: { x: 0, y: 0, z: 0 } },
    });
    const clean = createCruise();
    const braking = createCruise();
    advance(clean, 2, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0, brake: 0 }));
    advance(braking, 2, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0, brake: 1 }));

    expect(braking.state.onGround).toBe(false);
    expect(braking.state.actuators.brake).toBe(1);
    expect(braking.telemetry().airspeed).toBeLessThan(clean.telemetry().airspeed - 10);
  });

  it("has linear dry throttle response and the low-bypass engine's lapse", () => {
    // Everything here is measured at or below the reheat gate, so it describes
    // the CORE engine. The afterburner has its own test below; mixing the two
    // is what makes a thrust curve impossible to reason about.
    //
    // The expected ratios are Mattingly's low-bypass mixed-flow correlation
    // worked by hand against the standard atmosphere, with the F110's 1.10
    // throttle ratio: theta0 = theta (1 + 0.2 M^2), delta0 = delta (1 + 0.2 M^2)^3.5,
    // and dry thrust delta0 [1 - 3.8 (theta0 - 1.10) / theta0] once theta0 passes
    // the ratio.
    const gate = FAST_JET.afterburner?.engageThrottle ?? 1;
    const seaLevelStatic = calculateEngineThrust(FAST_JET, gate, 1.225, 0);
    const ratio = (density: number, speed: number) =>
      calculateEngineThrust(FAST_JET, gate, density, speed) / seaLevelStatic;
    const tropopause = standardAirDensity(11_000);

    // 76.3 kN of F110-GE-129 dry thrust, at the gate, standing still.
    expect(seaLevelStatic).toBeCloseTo(FAST_JET.maxStaticThrust * gate, 8);
    expect(calculateEngineThrust(FAST_JET, gate * 0.5, 1.225, 0))
      .toBeCloseTo(seaLevelStatic * 0.5, 8);
    // Standing still the engine sees static pressure: 22,632 Pa of 101,325 at
    // the tropopause.
    expect(ratio(tropopause, 0)).toBeCloseTo(0.2234, 4);
    // Ram recovery. At Mach 0.6 on the deck theta0 is 1.072, under the limit,
    // so thrust follows delta0 = 1.072^3.5: a quarter more than static. This
    // is what the old density-only model could not do, and why the F-16
    // could not reach Mach 2.
    expect(ratio(1.225, 0.6 * 340.294)).toBeCloseTo(1.2755, 3);
    // Past the limit it falls: Mach 1.2 on the deck is theta0 1.288.
    expect(ratio(1.225, 1.2 * 340.294)).toBeCloseTo(1.08, 3);
    // And at Mach 2 above the tropopause, theta0 1.353, about half static.
    expect(ratio(tropopause, 2 * 295.07)).toBeCloseTo(0.504, 3);
    // Far enough past the limit the correlation reaches zero; it never goes
    // below it.
    expect(ratio(1.225, 750)).toBe(0);
    expect(calculateEngineThrust(FAST_JET, gate, 0, 0)).toBe(0);
    expect(calculateEngineThrust(FAST_JET, 0, 1.225, 0)).toBe(0);
  });

  it("lights the afterburner only in the last of the throttle, and adds to dry thrust", () => {
    // The gate is the whole point of modelling reheat additively rather than
    // as a bigger engine: below it the aeroplane flies on the core alone, and
    // the last sliver of throttle travel is where it transforms.
    const burner = FAST_JET.afterburner;
    expect(burner).not.toBeNull();
    if (!burner) throw new Error("the F-16 must have an afterburner");

    const dryAtGate = calculateEngineThrust(FAST_JET, burner.engageThrottle, 1.225, 0);
    const justBelow = calculateEngineThrust(FAST_JET, burner.engageThrottle - 0.01, 1.225, 0);
    const full = calculateEngineThrust(FAST_JET, 1, 1.225, 0);
    const halfway = calculateEngineThrust(FAST_JET, (burner.engageThrottle + 1) / 2, 1.225, 0);

    // Nothing extra below the gate: just below it is pure dry thrust.
    expect(justBelow).toBeCloseTo(FAST_JET.maxStaticThrust * (burner.engageThrottle - 0.01), 8);
    // 76.3 kN dry plus 54.7 kN of reheat is the engine's published 131 kN.
    expect(full).toBeCloseTo(FAST_JET.maxStaticThrust + burner.thrustBoost, 8);
    expect(full).toBeCloseTo(131_000, 8);
    // Half the remaining travel gives half the boost, on top of dry thrust
    // that is still climbing.
    expect(halfway).toBeCloseTo(
      FAST_JET.maxStaticThrust * ((burner.engageThrottle + 1) / 2) + burner.thrustBoost * 0.5,
      8,
    );
    // The gate is worth having: full power is materially more than the core.
    expect(full).toBeGreaterThan(dryAtGate * 1.9);
    // Reheat lapses with the air like the core does. An afterburner is not a
    // rocket and must not become one as the air thins: standing still at the
    // tropopause, full reheat is the same 22% of its sea-level figure.
    expect(calculateEngineThrust(FAST_JET, 1, standardAirDensity(11_000), 0) / full)
      .toBeCloseTo(0.2234, 4);
    // But reheat lapses more gently with Mach than the dry engine (3.5 per
    // unit of theta0 over the limit, not 3.8), so at Mach 2 up high the
    // nozzle's share of the thrust has grown.
    const machTwo = 2 * 295.07;
    const highWet = calculateEngineThrust(FAST_JET, 1, standardAirDensity(11_000), machTwo);
    const highDry = calculateEngineThrust(FAST_JET, burner.engageThrottle, standardAirDensity(11_000), machTwo);
    expect(highWet / highDry).toBeGreaterThan(full / dryAtGate);
  });

  it("gives the airliner and the Global a big fan's thrust lapse", () => {
    // Mattingly's high-bypass correlation, delta0 (1 - 0.49 sqrt(M)), checked
    // against what the real engines do rather than against itself: about a
    // fifth of the sea-level static rating is left for the climb at 35,000 ft
    // and Mach 0.85, and about a fifth of it is gone by rotation.
    for (const aircraft of [aircraftDefinition("airliner"), aircraftDefinition("bizjet")]) {
      const staticThrust = calculateEngineThrust(aircraft, 1, 1.225, 0);
      expect(staticThrust).toBeCloseTo(aircraft.maxStaticThrust, 6);
      const cruiseDensity = standardAirDensity(10_668);
      const cruise = calculateEngineThrust(aircraft, 1, cruiseDensity, 0.85 * 296.54);
      expect(cruise / staticThrust).toBeGreaterThan(0.18);
      expect(cruise / staticThrust).toBeLessThan(0.24);
      const rotation = calculateEngineThrust(aircraft, 1, 1.225, 75);
      expect(rotation / staticThrust).toBeGreaterThan(0.75);
      expect(rotation / staticThrust).toBeLessThan(0.85);
      // A fan never gains thrust with speed at a fixed altitude.
      let previous = staticThrust;
      for (let speed = 10; speed <= 300; speed += 10) {
        const thrust = calculateEngineThrust(aircraft, 1, 1.225, speed);
        expect(thrust).toBeLessThanOrEqual(previous);
        previous = thrust;
      }
    }
  });

  it("sustains materially more speed than the unchanged trainer", () => {
    const trainer = runSustainedFlight(LIGHT_TRAINER, 56);
    const jet = runSustainedFlight(FAST_JET, 155);
    const trainerTelemetry = trainer.telemetry();
    const jetTelemetry = jet.telemetry();

    expectFiniteState(trainer.state);
    expectFiniteState(jet.state);
    expect(trainer.state.crashed).toBe(false);
    expect(jet.state.crashed).toBe(false);
    expect(trainerTelemetry.airspeed).toBeGreaterThan(50);
    expect(trainerTelemetry.airspeed).toBeLessThan(70);
    // A clean F-16 settles faster than the fictional sport jet this replaced,
    // which topped out near 260. The ceiling was 320 against 295 measured;
    // with ram recovery in the engine model (2026-10-12) the same 30 s at
    // 3,000 m and 0.9 throttle, a little reheat, reaches 337, so it is 360.
    expect(jetTelemetry.airspeed).toBeGreaterThan(240);
    expect(jetTelemetry.airspeed).toBeLessThan(360);
    expect(jetTelemetry.airspeed).toBeGreaterThan(trainerTelemetry.airspeed * 3.3);
  });

  it("stays controllable across the menu-Scenic to neutral-Direct handoff", () => {
    const world = createWorld(0x51a7e);
    const spawn = createSimulationSpawn(world, "airborne", 975, "jet");
    const wind = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn,
      environment: {
        terrain: (x, z) => sampleTerrainCollision(world, x, z),
        terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
        wind,
      },
    });
    const assisted = { ...DEFAULT_CONTROLS };
    const requested = { ...DEFAULT_CONTROLS, ...spawn.controls };

    advance(simulator, 4, (current) => {
      sampleWind(
        world,
        current.state.position.x,
        current.state.position.y,
        current.state.position.z,
        current.state.time,
        wind,
      );
      return applyFlightAssistance(
        assisted,
        "scenic",
        requested,
        current.state,
        current.telemetry(),
      );
    });
    const handoffAltitude = simulator.state.position.y;
    const handoffTime = simulator.state.time;
    // What the handoff does IN THE MOMENT is the thing this test is named for,
    // so it is measured directly: a mode change must not step the attitude.
    const pitchBeforeHandoff = simulator.telemetry().pitch;
    const retention = new DirectPitchRetention();
    let maximumPitch = Math.abs(simulator.telemetry().pitch);
    let maximumClimbRate = Math.max(0, simulator.telemetry().verticalSpeed);
    let pitchOneSecondAfter = pitchBeforeHandoff;

    advance(simulator, 30, (current) => {
      sampleWind(
        world,
        current.state.position.x,
        current.state.position.y,
        current.state.position.z,
        current.state.time,
        wind,
      );
      const telemetry = current.telemetry();
      maximumPitch = Math.max(maximumPitch, Math.abs(telemetry.pitch));
      maximumClimbRate = Math.max(maximumClimbRate, telemetry.verticalSpeed);
      if (current.state.time - handoffTime <= 1) pitchOneSecondAfter = telemetry.pitch;
      return retention.apply(
        assisted,
        requested,
        current.state,
        telemetry,
      );
    });

    const altitudeGain = simulator.state.position.y - handoffAltitude;
    const finalTelemetry = simulator.telemetry();
    expectFiniteState(simulator.state);
    expect(retention.isArmed).toBe(false);
    expect(simulator.state.crashed).toBe(false);
    // The handoff itself is a no-op on attitude. This is the assertion that
    // actually tests the handoff, and it does not care what aeroplane it is.
    expect(Math.abs(pitchOneSecondAfter - pitchBeforeHandoff) * 180 / Math.PI)
      .toBeLessThan(3);

// Everything below describes the AEROPLANE afterwards, so the numbers
    // are this airframe's. They were pitch < 6 deg and climb < 12 m/s, which
    // described a 5,850 kg sport jet spawning at 155 m/s.
    //
    // The F-16 briefly did far worse than that — 20 degrees and 83 m/s — on a
    // 0.65 spawn throttle that was most of a 76 kN engine under 11 tonnes.
    // That was fixed in the aeroplane rather than in this test: its
    // `airborneThrottle` is 0.20 now, chosen so the spawn is approximately
    // trimmed level, and hands-off it never leaves the 2.4-degree spawn
    // attitude. These bounds are back to describing a settled aeroplane.
    expect((maximumPitch * 180) / Math.PI).toBeLessThan(8);
    expect(maximumClimbRate).toBeLessThan(20);
    // Climbing gently is fine; descending is not.
    expect(altitudeGain).toBeGreaterThan(-60);
    expect(altitudeGain).toBeLessThan(220);
    expect(finalTelemetry.airspeed).toBeGreaterThan(140);
    expect(finalTelemetry.airspeed).toBeLessThan(260);
  });

  it("rotates and lifts off gently from a runway", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        onGround: true,
        terrainHeight: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.015 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.015 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    let liftoffTime: number | null = null;
    let liftoffDistance: number | null = null;
    let liftoffAirspeed: number | null = null;

    for (let index = 0; index < Math.round(30 / FIXED_TIME_STEP); index += 1) {
      const groundSpeed = simulator.telemetry().groundSpeed;
      simulator.step(FIXED_TIME_STEP, {
        ...DEFAULT_CONTROLS,
        throttle: 1,
        trim: 0.015,
        pitch: liftoffTime === null && groundSpeed > 62 ? 0.3 : 0,
      });
      if (
        liftoffTime === null &&
        !simulator.state.onGround &&
        simulator.telemetry().altitudeAgl > 0.5
      ) {
        liftoffTime = simulator.state.time;
        liftoffDistance = Math.hypot(simulator.state.position.x, simulator.state.position.z);
        liftoffAirspeed = simulator.telemetry().airspeed;
      } else if (
        liftoffTime !== null &&
        simulator.state.time - liftoffTime >= 2
      ) {
        break;
      }
      if (simulator.state.crashed) break;
    }

    expect(liftoffTime).not.toBeNull();
    expect(liftoffTime ?? 99).toBeLessThan(15);
    expect(liftoffDistance ?? 9_999).toBeLessThan(650);
    expect(liftoffAirspeed ?? 0).toBeGreaterThan(75);
    // 99.4 m/s against a 100 ceiling before ram recovery; the reheat roll now
    // gains a little more speed during the rotation and lifts off at 100.1,
    // over essentially the same 434 m (442 before).
    expect(liftoffAirspeed ?? 999).toBeLessThan(103);
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.state.peakImpactSpeed).toBeLessThan(1);
    expect(simulator.telemetry().altitudeAgl).toBeGreaterThan(5);
    expect(simulator.telemetry().airspeed).toBeGreaterThan(50);
    expect(Math.abs(simulator.telemetry().pitch)).toBeLessThan((18 * Math.PI) / 180);
  });

  it("supports a gentle gear-down landing, combined braking, and a second takeoff", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 1.54, z: -30 },
        velocity: { x: 0, y: -1.15, z: 78 },
        pitch: (3 * Math.PI) / 180,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.08, flaps: 1, gear: 1 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.08, flaps: 1, gear: 1 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    let touchdownTime: number | null = null;
    let stoppedTime: number | null = null;
    let secondLiftoffTime: number | null = null;
    let reboundAgl = 0;

    for (let index = 0; index < Math.round(45 / FIXED_TIME_STEP); index += 1) {
      const telemetry = simulator.telemetry();
      let controls: FlightControls;
      if (touchdownTime === null) {
        controls = { ...DEFAULT_CONTROLS, throttle: 0.06, flaps: 1, gear: 1, pitch: 0.04 };
      } else if (stoppedTime === null) {
        controls = { ...DEFAULT_CONTROLS, throttle: 0, flaps: 1, gear: 1, brake: 1 };
      } else {
        controls = {
          ...DEFAULT_CONTROLS,
          throttle: 1,
          flaps: 0.5,
          gear: 1,
          pitch: telemetry.groundSpeed > 75 ? 0.2 : 0,
        };
      }
      simulator.step(FIXED_TIME_STEP, controls);

      if (touchdownTime === null && simulator.state.onGround) {
        touchdownTime = simulator.state.time;
      }
      if (touchdownTime !== null && stoppedTime === null) {
        // A bounced landing would push the wheels back off the runway.
        reboundAgl = Math.max(reboundAgl, simulator.telemetry().altitudeAgl);
      }
      if (
        touchdownTime !== null &&
        stoppedTime === null &&
        simulator.state.onGround &&
        simulator.telemetry().groundSpeed < 1
      ) {
        stoppedTime = simulator.state.time;
      }
      if (
        stoppedTime !== null &&
        !simulator.state.onGround &&
        simulator.telemetry().altitudeAgl > 1
      ) {
        secondLiftoffTime = simulator.state.time;
        break;
      }
      if (simulator.state.crashed) break;
    }

    expect(touchdownTime).not.toBeNull();
    expect(stoppedTime).not.toBeNull();
    expect(secondLiftoffTime).not.toBeNull();
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.state.peakImpactSpeed).toBeLessThan(3);
    // The oleos absorb the touchdown instead of throwing the aircraft back
    // into the air: the wheels stay on the runway from touchdown to a stop.
    expect(reboundAgl).toBeLessThan(0.25);
    expect(simulator.state.actuators.gear).toBeGreaterThanOrEqual(0.98);
  });

  it("detects the jet nose striking before its gear or centre of gravity", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 5.5, z: 0 },
        velocity: { x: 0, y: -20, z: 0 },
        pitch: -Math.PI / 2,
        controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });

    simulator.step(FIXED_TIME_STEP);

    expect(simulator.state.crashed).toBe(true);
    expect(simulator.state.onGround).toBe(true);
    expect(simulator.telemetry().altitudeAgl).toBe(0);
    expect(simulator.state.peakImpactSpeed).toBeGreaterThan(8.5);
    // The F-16's radome reaches x 7.5, further forward than the fictional
    // airframe's 5.86, so a nose-down strike holds the CG higher.
    expect(simulator.state.position.y).toBeCloseTo(7.506, 3);
    expect(simulator.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(simulator.state.angularVelocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("keeps aggressive high-speed jet dynamics finite and structurally bounded", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 12_000, z: 0 },
        heading: Math.PI / 2,
        pitch: -0.2,
        bank: 0.35,
        airspeed: 180,
        velocity: { x: 340, y: 0, z: 0 },
      },
      environment: {
        airDensity: 0.05,
        gravity: 0,
        wind: { x: 0, y: 0, z: 0 },
      },
    });
    simulator.step(FIXED_TIME_STEP, { ...DEFAULT_CONTROLS, throttle: 1 });
    expect(simulator.telemetry().airspeed).toBeGreaterThan(330);
    let maximumRollRate = 0;
    let maximumYawRate = 0;
    let maximumPitchRate = 0;
    let maximumRateChange = 0;

    for (let index = 0; index < Math.round(8 / FIXED_TIME_STEP); index += 1) {
      const previousRate = { ...simulator.state.angularVelocity };
      const direction = Math.floor(simulator.state.time / 0.9) % 2 === 0 ? 1 : -1;
      simulator.step(FIXED_TIME_STEP, {
        ...DEFAULT_CONTROLS,
        throttle: 1,
        pitch: direction,
        roll: -direction,
        yaw: direction,
      });
      maximumRollRate = Math.max(
        maximumRollRate,
        Math.abs(simulator.state.angularVelocity.x),
      );
      maximumYawRate = Math.max(
        maximumYawRate,
        Math.abs(simulator.state.angularVelocity.y),
      );
      maximumPitchRate = Math.max(
        maximumPitchRate,
        Math.abs(simulator.state.angularVelocity.z),
      );
      maximumRateChange = Math.max(
        maximumRateChange,
        Math.abs(simulator.state.angularVelocity.x - previousRate.x) / FIXED_TIME_STEP,
        Math.abs(simulator.state.angularVelocity.y - previousRate.y) / FIXED_TIME_STEP,
        Math.abs(simulator.state.angularVelocity.z - previousRate.z) / FIXED_TIME_STEP,
      );
    }

    expectFiniteState(simulator.state);
    expect(simulator.state.crashed).toBe(false);
    expect(maximumRollRate).toBeLessThanOrEqual(4.26);
    expect(maximumYawRate).toBeLessThanOrEqual(2.36);
    expect(maximumPitchRate).toBeLessThanOrEqual(3.11);
    expect(maximumRateChange).toBeLessThan(12);
    expect(simulator.state.dynamics.airspeed).toBeLessThanOrEqual(350);
    expect(Math.abs(simulator.state.velocity.x)).toBeLessThanOrEqual(350);
    expect(Math.abs(simulator.state.velocity.y)).toBeLessThanOrEqual(350);
    expect(Math.abs(simulator.state.velocity.z)).toBeLessThanOrEqual(350);
  });

  it("keeps the propeller branch power-limited above the static cap", () => {
    // Re-pinned for the Cessna 150: 74,600 W and a 1,650 N static cap, where
    // the previous fictional trainer had 132,000 W and 2,650 N. The SHAPE is
    // what this asserts and what must not regress — thrust is the static cap
    // until the power limit undercuts it, and strictly proportional to
    // throttle. At 50 m/s the power limit is 74,600 x 0.8 / 50 = 1,193.6 N,
    // below the cap, so the propeller is power-limited there and the cap is
    // what governs the standing start.
    expect(calculateEngineThrust(LIGHT_TRAINER, 1, 1.225, 0)).toBeCloseTo(1_650, 8);
    expect(calculateEngineThrust(LIGHT_TRAINER, 1, 1.225, 50)).toBeCloseTo(1_193.6, 6);
    expect(calculateEngineThrust(LIGHT_TRAINER, 0.5, 1.225, 50)).toBeCloseTo(596.8, 6);
  });
});
