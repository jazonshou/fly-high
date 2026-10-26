import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_VISUAL_STATE, type BoatVisualState, type FlightVisualState } from "../src/game/types";
import { RUNABOUT_21_WAKE_GEOMETRY } from "../src/render/webgpu/boat/BoatEffects";
import {
  BOAT_WAKE_VERTEX_WGSL,
  BoatWakeSystem,
  WAKE_FLOATS_PER_SEGMENT,
  WAKE_KELVIN_HALF_ANGLE_DEGREES,
  WAKE_REANCHOR_METERS,
  WAKE_SEGMENT_CAPACITY,
  wakeFoamStrength,
  wakeScarStrength,
  wakeSegmentTemplate,
} from "../src/render/webgpu/boat/BoatWakeSystem";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import { waterDownwellingRadiance } from "../src/render/webgpu/water/WaterShaders";

/**
 * The boat's wake (src/render/webgpu/boat/BoatWakeSystem.ts): the track it
 * lays, the trail it primes for a capture, and the Kelvin geometry the
 * shader draws from it.
 */

const boatState = (overrides: Partial<BoatVisualState> = {}): BoatVisualState => ({
  kind: "boat",
  speedThroughWater: 0,
  gear: "neutral",
  lever: 0,
  steerAngle: 0,
  trim: 0,
  trimAngle: 0,
  tabPort: 0,
  tabStarboard: 0,
  depthUnderKeel: 8,
  propellerImmersion: 1,
  moored: false,
  ventilating: false,
  capsized: false,
  planing: 0,
  wettedLength: 6,
  transomImmersion: 0.42,
  sprayRoots: [],
  sprayRootCount: 0,
  ...overrides,
});

const PLANING = boatState({ speedThroughWater: 18, gear: "forward", lever: 0.9, planing: 1 });

/** A boat at (x, z) heading `yaw` radians (about +Y: +X turns toward -Z), moving at `speed` along its bow. */
function running(time: number, x: number, z: number, yaw: number, speed: number, yawRate = 0, boat: BoatVisualState = PLANING): FlightVisualState {
  return {
    ...INITIAL_VISUAL_STATE,
    simulationTime: time,
    engineRpm: speed > 0 ? 4_800 : 700,
    position: { x, y: 0.16, z },
    velocity: { x: Math.cos(yaw) * speed, y: 0, z: -Math.sin(yaw) * speed },
    orientation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    angularVelocity: { x: 0, y: yawRate, z: 0 },
    vehicle: { ...boat, speedThroughWater: speed },
  };
}

interface Segment {
  olderX: number;
  olderZ: number;
  olderClock: number;
  newerX: number;
  newerZ: number;
  newerClock: number;
  speed: number;
}

function segment(wake: BoatWakeSystem, slot: number): Segment {
  const r = wake.segmentData;
  const at = slot * WAKE_FLOATS_PER_SEGMENT;
  const { x, z } = wake.anchor;
  return {
    olderX: r[at]! + x,
    olderZ: r[at + 1]! + z,
    olderClock: r[at + 4]!,
    newerX: r[at + 8]! + x,
    newerZ: r[at + 9]! + z,
    newerClock: r[at + 12]!,
    speed: r[at + 5]! + r[at + 13]!,
  };
}

function laidSegments(wake: BoatWakeSystem): Segment[] {
  const out: Segment[] = [];
  for (let slot = 0; slot < WAKE_SEGMENT_CAPACITY; slot += 1) {
    const s = segment(wake, slot);
    if (s.speed > 0 && Math.hypot(s.newerX - s.olderX, s.newerZ - s.olderZ) > 1e-6) out.push(s);
  }
  return out;
}

let engine: NullEngine;
let scene: Scene;
let ocean: { bindSurface: ReturnType<typeof vi.fn<(material: unknown) => void>> };
let wake: BoatWakeSystem;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  ocean = { bindSurface: vi.fn<(material: unknown) => void>() };
  wake = new BoatWakeSystem(scene, { trailSeconds: 24, geometry: RUNABOUT_21_WAKE_GEOMETRY, seaLevel: 0, ocean });
});

afterEach(() => {
  wake.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the wake's geometry", () => {
  it("opens its arms at Kelvin's half-angle, asin(1/3)", () => {
    expect(WAKE_KELVIN_HALF_ANGLE_DEGREES).toBeCloseTo(19.47, 2);
    expect(BOAT_WAKE_VERTEX_WGSL).toContain(Math.tan(Math.asin(1 / 3)).toFixed(7));
  });

  it("places every vertex on the sea's own displacement", () => {
    expect(BOAT_WAKE_VERTEX_WGSL).toContain("oceanSurfaceDisplacement(worldXZ)");
    expect(BOAT_WAKE_VERTEX_WGSL).toContain("fn oceanSurfaceDisplacement(");
  });

  it("draws a segment as the wash's four quads and two per arm, never joining bands", () => {
    const template = wakeSegmentTemplate();
    const positions = template.positions!;
    const indices = template.indices!;
    expect(positions.length / 3).toBe(22);
    expect(indices.length).toBe(8 * 6);
    for (let t = 0; t < indices.length; t += 3) {
      const bands = new Set([0, 1, 2].map((k) => positions[indices[t + k]! * 3]));
      expect(bands.size, `triangle ${t / 3}`).toBe(1);
      const ends = new Set([0, 1, 2].map((k) => positions[indices[t + k]! * 3 + 2]));
      expect(ends.size, `triangle ${t / 3} spans the segment`).toBe(2);
    }
  });

  it("starts the wake at the transom's foot on the waterline", () => {
    const [x, y, z] = RUNABOUT_21_WAKE_GEOMETRY.transom;
    expect(x).toBeCloseTo(-1.95, 6);
    expect(y).toBeLessThan(0);
    expect(y).toBeGreaterThan(-0.3);
    expect(z).toBe(0);
    expect(RUNABOUT_21_WAKE_GEOMETRY.halfBeam).toBeGreaterThan(0.9);
  });
});

describe("the white water", () => {
  it("throws none at rest, a lot on the plane, and leaves a scar behind a working propeller", () => {
    expect(wakeFoamStrength(boatState(), 700)).toBe(0);
    expect(wakeScarStrength(boatState(), 700)).toBe(0);
    expect(wakeFoamStrength(PLANING, 4_800)).toBeGreaterThan(0.9);
    const idling = boatState({ gear: "forward", speedThroughWater: 2 });
    expect(wakeScarStrength(idling, 2_000)).toBeGreaterThan(0.4);
    expect(wakeFoamStrength(idling, 2_000)).toBeLessThan(wakeFoamStrength(PLANING, 4_800));
  });
});

describe("priming", () => {
  it("lays the whole trail behind a boat that first appears running straight", () => {
    wake.update(running(100, 500, -300, 0, 18));
    expect(wake.drawing).toBe(true);
    const segments = laidSegments(wake);
    const spacing = wake.commitSpacing(18);
    expect(segments.length).toBeGreaterThan(24 * 18 / spacing - 2);
    for (const s of segments) {
      // Straight back along -X from the transom, on the centreline.
      // The records are f32 relative to the anchor.
      expect(s.olderZ).toBeCloseTo(-300, 3);
      expect(s.newerX - s.olderX).toBeCloseTo(spacing, 3);
    }
    const oldest = Math.min(...segments.map((s) => s.olderX));
    // As far back as the trail reaches, and a second more.
    expect(500 - 1.95 - oldest).toBeGreaterThanOrEqual(18 * 24);
    const newest = Math.max(...segments.map((s) => s.newerX));
    expect(newest).toBeCloseTo(500 - 1.95, 3);
  });

  it("curves the primed trail toward the inside of the turn", () => {
    // Positive body yaw rate swings the bow to port (-Z), so the track behind bends to port too.
    wake.update(running(100, 0, 0, 0, 12, 0.2));
    const segments = laidSegments(wake);
    const oldest = segments.reduce((a, b) => (b.olderX < a.olderX ? b : a));
    expect(oldest.olderZ).toBeLessThan(-5);
  });

  it("lays nothing for a boat lying at the dock, and draws nothing after the load frame", () => {
    wake.update(running(10, 0, 0, 0, 0, 0, boatState({ moored: true })));
    expect(laidSegments(wake)).toHaveLength(0);
    wake.update(running(10 + 1 / 60, 0, 0, 0, 0, 0, boatState({ moored: true })));
    expect(wake.drawing).toBe(false);
  });

  it("keeps the whole trail behind a pose a capture holds still", () => {
    // A perf shot holds one pose while its clock runs: the trail must not age out.
    for (let time = 100; time <= 130; time += 0.25) wake.update(running(time, 500, -300, 0, 18));
    expect(wake.drawing).toBe(true);
    const segments = laidSegments(wake);
    expect(segments.length).toBeGreaterThan(24 * 18 / wake.commitSpacing(18) - 2);
    expect(500 - 1.95 - Math.min(...segments.map((s) => s.olderX))).toBeGreaterThanOrEqual(18 * 24);
  });

  it("primes afresh after a jump", () => {
    wake.update(running(100, 0, 0, 0, 18));
    const first = wake.commitCount;
    wake.update(running(100 + 1 / 60, 5_000, 0, 0, 18));
    expect(wake.commitCount).toBeGreaterThan(first * 1.5);
    const segments = laidSegments(wake);
    expect(Math.min(...segments.map((s) => s.olderX))).toBeGreaterThan(4_000);
  });
});

describe("laying track", () => {
  it("commits a point every spacing along a straight run, each segment joined to the next", () => {
    const speed = 15;
    let time = 50;
    wake.update(running(time, 0, 0, 0, speed));
    const primed = wake.commitCount;
    for (let frame = 1; frame <= 600; frame += 1) {
      time += 1 / 60;
      wake.update(running(time, speed * (time - 50), 0, 0, speed));
    }
    const laid = wake.commitCount - primed;
    // A point is committed on the first frame at or past the spacing, so the
    // laid spacing is the spacing plus at most one frame's travel.
    const spacing = wake.commitSpacing(speed);
    expect(laid).toBeGreaterThanOrEqual(Math.floor((speed * 10) / (spacing + speed / 60)) - 1);
    expect(laid).toBeLessThanOrEqual(Math.ceil((speed * 10) / spacing) + 1);
    // Every laid segment's newer end is the next one's older end.
    const segments = laidSegments(wake).sort((a, b) => a.olderX - b.olderX);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]!.olderX).toBeCloseTo(segments[index - 1]!.newerX, 4);
    }
    // The head reaches the transom now.
    expect(segments[segments.length - 1]!.newerX).toBeCloseTo(speed * 10 - 1.95, 4);
  });

  it("commits early in a turn, so the trail follows the arc", () => {
    let time = 0;
    let yaw = 0;
    let x = 0;
    let z = 0;
    const speed = 10;
    const yawRate = 0.35;
    wake.update(running(time, x, z, yaw, speed));
    const primed = wake.commitCount;
    for (let frame = 0; frame < 120; frame += 1) {
      time += 1 / 60;
      yaw += yawRate / 60;
      x += Math.cos(yaw) * speed / 60;
      z -= Math.sin(yaw) * speed / 60;
      wake.update(running(time, x, z, yaw, speed, yawRate));
    }
    // Two seconds at 20 degrees a second: more commits than the straight-line spacing alone gives.
    expect(wake.commitCount - primed).toBeGreaterThan((speed * 2) / wake.commitSpacing(speed));
  });

  it("stops drawing once the trail has faded behind a boat that stopped", () => {
    let time = 0;
    wake.update(running(time, 0, 0, 0, 12));
    for (; time < 26; time += 0.5) wake.update(running(time + 0.5, 0, 0, 0, 0));
    expect(wake.drawing).toBe(false);
  });

  it("keeps world positions when it moves its anchor", () => {
    let time = 0;
    const speed = 20;
    wake.update(running(time, 0, 0, 0, speed));
    const before = laidSegments(wake).find((s) => Math.abs(s.olderX + 100) < wake.commitSpacing(speed))!;
    for (let frame = 0; frame < (WAKE_REANCHOR_METERS / speed + 5) * 60; frame += 1) {
      time += 1 / 60;
      wake.update(running(time, speed * time, 0, 0, speed));
    }
    expect(wake.anchor.x).toBeGreaterThan(WAKE_REANCHOR_METERS - 10);
    const after = laidSegments(wake).find((s) => Math.abs(s.olderX - before.olderX) < 1e-3);
    // Ring capacity may have recycled it; if it is there, it has not moved.
    if (after) expect(after.olderZ).toBeCloseTo(before.olderZ, 3);
    const head = laidSegments(wake).reduce((a, b) => (b.newerX > a.newerX ? b : a));
    expect(head.newerX).toBeCloseTo(speed * time - 1.95, 2);
  });
});

describe("binding the sea", () => {
  it("hands the wake the sea's displacement only while it draws", () => {
    wake.update(running(0, 0, 0, 0, 0, 0, boatState({ moored: true })));
    wake.update(running(1 / 60, 0, 0, 0, 0, 0, boatState({ moored: true })));
    wake.bindOcean();
    expect(ocean.bindSurface).not.toHaveBeenCalled();
    wake.update(running(1, 0, 0, 0, 12));
    wake.bindOcean();
    expect(ocean.bindSurface).toHaveBeenCalledTimes(1);
  });
});

describe("the light on the foam", () => {
  it("is the irradiance the sea lights its own surf with, from the same snapshot", () => {
    const atmosphere = {
      sunDirection: new Vector3(0.4, 0.5, 0.77).normalize(),
      sunColor: new Color3(1, 0.86, 0.7),
      sunIlluminanceNormalized: 0.62,
      skyZenith: new Color3(0.2, 0.36, 0.7),
      skyHorizon: new Color3(0.86, 0.66, 0.5),
      skylightIlluminanceNormalized: 0.7,
      windDirection: new Vector2(0, 1),
    } as unknown as AtmosphereSnapshot;
    wake.setAtmosphere(atmosphere);
    const expected = waterDownwellingRadiance(
      [0.62, 0.86 * 0.62, 0.7 * 0.62],
      [0.2, 0.36, 0.7],
      [0.86, 0.66, 0.5],
      0.7,
      atmosphere.sunDirection.y,
      1,
    );
    expect(wake.downwelling.x).toBeCloseTo(expected[0], 6);
    expect(wake.downwelling.y).toBeCloseTo(expected[1], 6);
    expect(wake.downwelling.z).toBeCloseTo(expected[2], 6);
    // The shader takes that and nothing else for its light: no second sun.
    expect(BOAT_WAKE_VERTEX_WGSL).toContain("let downwelling = uniforms.wakeDownwelling;");
    const body = BOAT_WAKE_VERTEX_WGSL.slice(BOAT_WAKE_VERTEX_WGSL.indexOf("@vertex"));
    expect(body).not.toContain("aerialSunRadiance");
  });
});
