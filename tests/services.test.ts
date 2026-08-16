import { describe, expect, it } from "vitest";
import { normalizedEngineSpeed } from "../src/audio";
import {
  applyDeadZone,
  keyboardBrakeCommand,
  keyboardRollCommand,
  keyboardRollDirection,
  keyboardThrottleDirection,
  responseCurve,
  slewAxis,
  smoothAxis,
  toggledGearPosition,
} from "../src/input";
import { interpolateFlightState } from "../src/game/SimulationClient";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import {
  DEFAULT_SETTINGS,
  LEGACY_SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
  seedToString,
  SETTINGS_STORAGE_KEY,
  urlWithSeed,
  validateSettings,
} from "../src/settings";
import {
  createCrashRecoverySpawn,
  createSimulationSpawn,
} from "../src/game/spawn";
import { FlightSimulator } from "../src/sim";
import {
  createWorld,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  worldToRunway,
} from "../src/world";
import {
  DEFAULT_AIRBORNE_START_AGL,
  MAX_AIRBORNE_START_AGL,
  MIN_AIRBORNE_START_AGL,
} from "../src/workers/protocol";

describe("input shaping", () => {
  it("normalizes piston RPM and jet N2 on their own engine scales", () => {
    expect(normalizedEngineSpeed("trainer", 2_600)).toBe(1);
    expect(normalizedEngineSpeed("jet", 100)).toBe(1);
    expect(normalizedEngineSpeed("jet", 80)).toBeCloseTo(0.8, 8);
  });

  it("maps A to left bank and D to right bank for taps and held keys", () => {
    // Compatibility sign for the current rendered aircraft/body basis.
    expect(keyboardRollDirection("KeyA")).toBe(1);
    expect(keyboardRollDirection("KeyD")).toBe(-1);
    expect(keyboardRollDirection("KeyQ")).toBe(0);
    expect(keyboardRollCommand(new Set(["KeyA"]))).toBe(1);
    expect(keyboardRollCommand(new Set(["KeyD"]))).toBe(-1);
    expect(keyboardRollCommand(new Set(["KeyA", "KeyD"]))).toBe(0);
  });

  it("uses Shift/Ctrl as the sole keyboard power pair", () => {
    expect(keyboardThrottleDirection(new Set(["ShiftLeft"]))).toBe(1);
    expect(keyboardThrottleDirection(new Set(["ShiftRight"]))).toBe(1);
    expect(keyboardThrottleDirection(new Set(["ControlLeft"]))).toBe(-1);
    expect(keyboardThrottleDirection(new Set(["ControlRight"]))).toBe(-1);
    expect(keyboardThrottleDirection(new Set(["ShiftLeft", "ControlLeft"]))).toBe(0);
    expect(keyboardThrottleDirection(new Set(["Equal"]))).toBe(0);
    expect(keyboardThrottleDirection(new Set(["Minus"]))).toBe(0);
    expect(keyboardThrottleDirection(new Set(["NumpadAdd"]))).toBe(0);
    expect(keyboardThrottleDirection(new Set(["NumpadSubtract"]))).toBe(0);
  });

  it("uses Space for contextual braking and G-style binary gear commands", () => {
    expect(keyboardBrakeCommand(new Set(["Space"]))).toBe(1);
    expect(keyboardBrakeCommand(new Set(["KeyB"]))).toBe(0);
    expect(toggledGearPosition(0)).toBe(1);
    expect(toggledGearPosition(0.49)).toBe(1);
    expect(toggledGearPosition(0.5)).toBe(0);
    expect(toggledGearPosition(1)).toBe(0);
  });

  it("removes small controller noise and rescales the remainder", () => {
    expect(applyDeadZone(0.04, 0.08)).toBe(0);
    expect(applyDeadZone(-0.08, 0.08)).toBe(0);
    expect(applyDeadZone(1, 0.08)).toBe(1);
    expect(applyDeadZone(-1, 0.08)).toBe(-1);
  });

  it("keeps response curves bounded and preserves signs", () => {
    expect(responseCurve(0, 1)).toBe(0);
    expect(responseCurve(0.5, 1)).toBeGreaterThan(0);
    expect(responseCurve(0.5, 1)).toBeLessThan(1);
    expect(responseCurve(-0.5, 1)).toBeLessThan(0);
    expect(responseCurve(0.2, 2)).toBeGreaterThan(responseCurve(0.2, 1.3));
  });

  it("smooths axes independently of frame size", () => {
    let sixtyHz = 0;
    let oneTwentyHz = 0;
    for (let index = 0; index < 60; index += 1) sixtyHz = smoothAxis(sixtyHz, 1, 7, 1 / 60);
    for (let index = 0; index < 120; index += 1) oneTwentyHz = smoothAxis(oneTwentyHz, 1, 7, 1 / 120);
    expect(sixtyHz).toBeCloseTo(oneTwentyHz, 5);
  });

  it("ramps keyboard axes predictably and recenters without overshoot", () => {
    let axis = 0;
    for (let index = 0; index < 6; index += 1) axis = slewAxis(axis, 1, 2, 3, 1 / 60);
    expect(axis).toBeCloseTo(0.2, 6);

    for (let index = 0; index < 4; index += 1) axis = slewAxis(axis, 0, 2, 3, 1 / 60);
    expect(axis).toBeCloseTo(0, 6);
    expect(slewAxis(0.01, 0, 2, 3, 1)).toBe(0);
  });
});

describe("settings", () => {
  it("defaults to direct pilot authority and validates airborne start height", () => {
    expect(DEFAULT_SETTINGS.aircraft).toBe("trainer");
    expect(DEFAULT_SETTINGS.flightMode).toBe("unassisted");
    expect(DEFAULT_SETTINGS.renderingMode).toBe("balanced");
    expect(validateSettings({ airborneStartAgl: -10 }).airborneStartAgl).toBe(
      MIN_AIRBORNE_START_AGL,
    );
    expect(validateSettings({ airborneStartAgl: 99_000 }).airborneStartAgl).toBe(
      MAX_AIRBORNE_START_AGL,
    );
    expect(validateSettings({ airborneStartAgl: Number.NaN }).airborneStartAgl).toBe(
      DEFAULT_AIRBORNE_START_AGL,
    );
  });

  it("clamps persisted values and ignores invalid enum members", () => {
    const result = validateSettings({
      quality: "impossible",
      renderingMode: "cinematic",
      masterVolume: 8,
      sensitivity: -100,
      mouseFlight: true,
      timeOfDay: "midnight",
      weather: "hurricane",
      aircraft: "airliner",
    });
    expect(result.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(result.renderingMode).toBe(DEFAULT_SETTINGS.renderingMode);
    expect(result.masterVolume).toBe(1);
    expect(result.sensitivity).toBe(0.35);
    expect(result.mouseFlight).toBe(true);
    expect(result.timeOfDay).toBe(DEFAULT_SETTINGS.timeOfDay);
    expect(result.weather).toBe(DEFAULT_SETTINGS.weather);
    expect(result.aircraft).toBe("trainer");
  });

  it("persists explicit flight and WebGPU quality selections in v3 storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    saveSettings(
      {
        ...DEFAULT_SETTINGS,
        flightMode: "scenic",
        renderingMode: "ultra",
        aircraft: "jet",
        airborneStartAgl: 975,
      },
      storage,
    );

    expect(values.has(SETTINGS_STORAGE_KEY)).toBe(true);
    expect(loadSettings(storage)).toMatchObject({
      flightMode: "scenic",
      renderingMode: "ultra",
      airborneStartAgl: 975,
      aircraft: "jet",
    });
  });

  it("does not migrate the old implicit Scenic default", () => {
    const storage = {
      getItem: (key: string) =>
        key === LEGACY_SETTINGS_STORAGE_KEY
          ? JSON.stringify({ quality: "high", flightMode: "scenic" })
          : null,
    };

    expect(loadSettings(storage)).toMatchObject({
      quality: "high",
      flightMode: "unassisted",
      renderingMode: "balanced",
      airborneStartAgl: DEFAULT_AIRBORNE_START_AGL,
    });
  });

  it("defaults a payload without a rendering mode and migrates legacy modes", () => {
    const storage = {
      getItem: (key: string) =>
        key === SETTINGS_STORAGE_KEY
          ? JSON.stringify({ quality: "high", flightMode: "pilot" })
          : null,
    };

    expect(loadSettings(storage)).toMatchObject({
      quality: "high",
      flightMode: "pilot",
      renderingMode: "balanced",
    });
    expect(validateSettings({ renderingMode: "balanced" }).renderingMode).toBe("balanced");
    expect(validateSettings({ renderingMode: "hybrid" }).renderingMode).toBe("balanced");
    expect(validateSettings({ renderingMode: "ray-traced" }).renderingMode).toBe("ultra");
  });

  it("creates portable seed labels and URLs", () => {
    expect(seedToString(12345)).toMatch(/^[0-9A-Z]{6,}$/);
    expect(new URL(urlWithSeed(12345, "https://example.test/game")).searchParams.get("seed")).toBe(
      seedToString(12345).toLowerCase(),
    );
  });
});

describe("flight spawn contract", () => {
  it("places airborne starts at the exact configured wheel AGL", () => {
    const world = createWorld(0x51a7e);
    const spawn = createSimulationSpawn(world, "airborne", 975);
    const simulator = new FlightSimulator({
      spawn,
      environment: {
        terrain: (x, z) => sampleTerrainCollision(world, x, z),
        terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
      },
    });

    expect(simulator.telemetry().altitudeAgl).toBeCloseTo(975, 8);
    expect(simulator.state.onGround).toBe(false);
    expect(world.airport).not.toBeNull();
    if (!world.airport || !spawn.position) throw new Error("missing generated flight region");
    const local = worldToRunway(world.airport, spawn.position.x ?? 0, spawn.position.z ?? 0);
    expect(local.along).toBeCloseTo(-world.airport.runwayLength * 0.22, 8);
    expect(local.across).toBeCloseTo(0, 8);
  });

  it("keeps runway starts on their landing gear and clamps airborne height", () => {
    const world = createWorld(0x51a7e);
    const runway = new FlightSimulator({
      spawn: createSimulationSpawn(world, "runway", 975),
      environment: {
        terrain: (x, z) => sampleTerrainCollision(world, x, z),
        terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
      },
    });
    const minimumStart = new FlightSimulator({
      spawn: createSimulationSpawn(world, "airborne", -1),
      environment: {
        terrain: (x, z) => sampleTerrainCollision(world, x, z),
        terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
      },
    });

    expect(runway.state.onGround).toBe(true);
    expect(runway.telemetry().altitudeAgl).toBe(0);
    expect(minimumStart.telemetry().altitudeAgl).toBeCloseTo(
      MIN_AIRBORNE_START_AGL,
      8,
    );
  });

  it("keeps both spawn modes inside the resolved airport region across varied seeds", () => {
    for (let index = 0; index < 32; index += 1) {
      const world = createWorld(`spawn-region-${index}-${Math.imul(index + 7, 2_246_822_519) >>> 0}`);
      const airport = world.airport;
      expect(airport).not.toBeNull();
      if (!airport) throw new Error(`spawn-region-${index} has no airport`);
      const runwaySpawn = createSimulationSpawn(world, "runway", 650);
      const airborneSpawn = createSimulationSpawn(world, "airborne", 650);
      expect(runwaySpawn.onGround).toBe(true);
      expect(runwaySpawn.heading).toBe(airport.headingRadians);
      expect(airborneSpawn.heading).toBe(airport.headingRadians);
      expect(runwaySpawn.position).toBeDefined();
      expect(airborneSpawn.position).toBeDefined();
      const runwayLocal = worldToRunway(
        airport,
        runwaySpawn.position?.x ?? Infinity,
        runwaySpawn.position?.z ?? Infinity,
      );
      const airborneLocal = worldToRunway(
        airport,
        airborneSpawn.position?.x ?? Infinity,
        airborneSpawn.position?.z ?? Infinity,
      );
      expect(runwayLocal.along).toBeCloseTo(-airport.runwayLength * 0.36, 8);
      expect(runwayLocal.across).toBeCloseTo(0, 8);
      expect(airborneLocal.along).toBeCloseTo(-airport.runwayLength * 0.22, 8);
      expect(airborneLocal.across).toBeCloseTo(0, 8);
    }
  }, 5_000);

  it("keeps an explicit airport-disabled developer world unavailable for runway spawn", () => {
    const airportless = createWorld("airportless-spawn", { airport: false });
    expect(() => createSimulationSpawn(airportless, "runway", 450)).toThrow(
      "Runway start unavailable: this world has no safe airport site",
    );
    expect(() => createSimulationSpawn(airportless, "airborne", 450)).not.toThrow();
  });

  it("recovers at the exact absolute crash X/Z above the local visible surface", () => {
    const world = createWorld(0x51a7e);
    // Both axes cross multiple 4 km renderer-origin cells. They remain absolute
    // here because Worker simulation and world sampling never use render-local coordinates.
    const crashX = 12_345.25;
    const crashZ = -8_765.5;
    const recoveryHeight = 640;
    const heading = 1.234;
    const spawn = createCrashRecoverySpawn(
      world,
      crashX,
      crashZ,
      heading,
      recoveryHeight,
      "trainer",
    );
    // Recovery scans this deterministic envelope so an impact in a valley or
    // beside a steep face cannot respawn into the surrounding relief.
    let visibleSurface = Math.max(
      world.seaLevel,
      sampleTerrainCollisionHeight(world, crashX, crashZ),
    );
    for (const radius of [180, 420, 720]) {
      for (let direction = 0; direction < 8; direction += 1) {
        const angle = (direction * Math.PI) / 4;
        visibleSurface = Math.max(
          visibleSurface,
          sampleTerrainCollisionHeight(
            world,
            crashX + Math.cos(angle) * radius,
            crashZ + Math.sin(angle) * radius,
          ),
        );
      }
    }
    const simulator = new FlightSimulator({
      spawn,
      environment: {
        terrain: { height: visibleSurface },
        terrainHeight: () => visibleSurface,
      },
    });

    expect(spawn.position?.x).toBe(crashX);
    expect(spawn.position?.z).toBe(crashZ);
    expect(spawn.heading).toBe(heading);
    expect(spawn.onGround).not.toBe(true);
    expect(spawn.controls?.throttle).toBe(0.68);
    expect(spawn.controls?.gear).toBe(1);
    expect(simulator.telemetry().altitudeAgl).toBeCloseTo(recoveryHeight, 8);
  });

  it("uses the selected aircraft's airborne configuration and rejects invalid coordinates", () => {
    const world = createWorld(0x51a7e);
    const jetRecovery = createCrashRecoverySpawn(world, 8_100, -4_200, 0.7, 510, "jet");
    const fallback = createSimulationSpawn(world, "airborne", 510, "jet");
    const invalidRecovery = createCrashRecoverySpawn(
      world,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      510,
      "jet",
    );

    expect(jetRecovery.airspeed).toBe(155);
    expect(jetRecovery.controls?.throttle).toBe(0.17);
    expect(jetRecovery.controls?.gear).toBe(0);
    expect(invalidRecovery).toEqual(fallback);
  });
});

describe("render snapshot interpolation", () => {
  it("interpolates vectors, wrapped headings, and normalized quaternions", () => {
    const first = {
      ...INITIAL_VISUAL_STATE,
      position: { x: 0, y: 100, z: 0 },
      altitudeAgl: 80,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      heading: 355,
      simulationTime: 1,
      onGround: false,
    };
    const second = {
      ...INITIAL_VISUAL_STATE,
      position: { x: 20, y: 120, z: -10 },
      altitudeAgl: 100,
      orientation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      heading: 5,
      simulationTime: 2,
      onGround: true,
    };

    const midpoint = interpolateFlightState(first, second, 0.5);

    expect(midpoint.position).toEqual({ x: 10, y: 110, z: -5 });
    expect(midpoint.altitudeAgl).toBe(90);
    expect(midpoint.heading).toBeCloseTo(0, 8);
    expect(Math.hypot(
      midpoint.orientation.x,
      midpoint.orientation.y,
      midpoint.orientation.z,
      midpoint.orientation.w,
    )).toBeCloseTo(1, 10);
    expect(midpoint.simulationTime).toBe(1.5);
    expect(midpoint.onGround).toBe(true);
  });
});
