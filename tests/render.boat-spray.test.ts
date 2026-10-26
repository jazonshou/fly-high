import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INITIAL_VISUAL_STATE,
  MAX_BOAT_SPRAY_ROOTS,
  type BoatVisualState,
  type FlightVisualState,
} from "../src/game/types";
import {
  BOAT_SPRAY_FRAGMENT_WGSL,
  BOAT_SPRAY_VERTEX_WGSL,
  BoatSpraySystem,
  createSprayDropletSample,
  sampleSprayDroplet,
  SPRAY_BUDGET_SHARES,
  SPRAY_CHUNK_DROPLETS,
  SPRAY_CLOCK_PERIOD_SECONDS,
  SPRAY_EMISSION_HZ,
  SPRAY_FLOATS_PER_DROPLET,
  SPRAY_HELD_SECONDS,
  SPRAY_INSTANCE_CAPACITY,
  SPRAY_MAX_LIFETIME_SECONDS,
  SPRAY_REANCHOR_METERS,
  sprayAge,
  sprayClock,
  type BoatSprayGeometry,
} from "../src/render/webgpu/boat/BoatSpraySystem";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import { waterDownwellingRadiance } from "../src/render/webgpu/water/WaterShaders";
import { WATER_RENDERING_GROUP_ID } from "../src/render/webgpu/core/RenderingGroups";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

const GEOMETRY: BoatSprayGeometry = { propellerHub: [-2.25, -0.55, 0], tiltPivot: [-1.95, 0.2, 0] };

/** Chine roots a planing hull reports: four a side along the wetted run. */
function chineRoots(count: number, jet: number): number[] {
  const roots: number[] = [];
  for (let root = 0; root < count; root += 1) {
    const side = root % 2 === 0 ? 1 : -1;
    roots.push(0.4 - 0.35 * Math.floor(root / 2), -0.36, side * 1.02, jet);
  }
  return roots;
}

function boat(overrides: Partial<BoatVisualState> = {}): BoatVisualState {
  return {
    kind: "boat",
    speedThroughWater: 0,
    gear: "neutral",
    lever: 0,
    steerAngle: 0,
    trim: 0,
    trimAngle: 0,
    tabPort: 0,
    tabStarboard: 0,
    depthUnderKeel: 12,
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
  };
}

const KNOTS = 0.514444;

/** A boat running east (+X) at `speed`, on the water at the origin at t = 0. */
function running(time: number, speed: number, payload: BoatVisualState, x0 = 0): FlightVisualState {
  return {
    ...INITIAL_VISUAL_STATE,
    position: { x: x0 + speed * time, y: 0.15, z: 40 },
    velocity: { x: speed, y: 0, z: 0 },
    airspeed: speed,
    altitude: 0.15,
    altitudeAgl: 0.15,
    simulationTime: time,
    onGround: false,
    vehicle: payload,
  };
}

const PLANING = boat({
  speedThroughWater: 35 * KNOTS,
  gear: "forward",
  lever: 0.85,
  planing: 1,
  trim: 0.4,
  trimAngle: 0.07,
  sprayRoots: chineRoots(8, 16),
  sprayRootCount: 8,
});

function run(system: BoatSpraySystem, seconds: number, fps: number, payload: BoatVisualState, start = 0): void {
  // From frame 0, so every frame rate starts the lattice on the same tick.
  const frames = Math.round(seconds * fps);
  for (let frame = start === 0 ? 0 : 1; frame <= frames; frame += 1) {
    const time = start + frame / fps;
    system.update(running(time, 35 * KNOTS, payload));
  }
}

describe("boat spray", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("caps each tier at 256 / 1,024 / 4,096, inside the ring and in whole upload chunks", () => {
    const caps = [
      resolveWebGpuQualityProfile("low", "balanced"),
      resolveWebGpuQualityProfile("medium", "balanced"),
      resolveWebGpuQualityProfile("high", "balanced"),
      resolveWebGpuQualityProfile("high", "ultra"),
    ].map((profile) => profile.boatSprayParticleCap);
    expect(caps).toEqual([256, 1_024, 4_096, 4_096]);
    for (const cap of caps) {
      expect(cap).toBeLessThanOrEqual(SPRAY_INSTANCE_CAPACITY);
      expect(cap % SPRAY_CHUNK_DROPLETS).toBe(0);
      const system = new BoatSpraySystem(scene, { cap, geometry: GEOMETRY });
      expect(system.capacity).toBe(cap);
      expect(system.mesh!.forcedInstanceCount).toBe(cap);
      expect(system.instanceData!.length).toBe(cap * SPRAY_FLOATS_PER_DROPLET);
      system.dispose();
    }
    // The budget shares leave headroom, so a full sheet + rooster + mist never overwrites live drops.
    expect(SPRAY_BUDGET_SHARES.sheet + SPRAY_BUDGET_SHARES.rooster + SPRAY_BUDGET_SHARES.mist).toBeLessThan(1);
  });

  it("creates nothing at a cap of 0, and tears down and rebuilds on a cap change", () => {
    const meshes = scene.meshes.length;
    const materials = scene.materials.length;
    const none = new BoatSpraySystem(scene, { cap: 0, geometry: GEOMETRY });
    run(none, 1, 60, PLANING);
    expect(none.mesh).toBeNull();
    expect(none.instanceData).toBeNull();
    expect(none.drawing).toBe(false);
    expect(none.birthCount).toBe(0);
    expect(scene.meshes.length).toBe(meshes);
    expect(scene.materials.length).toBe(materials);

    none.setCap(1_000);
    expect(none.capacity).toBe(960);
    expect(none.mesh).not.toBeNull();
    none.setCap(0);
    expect(none.mesh).toBeNull();
    expect(scene.meshes.length).toBe(meshes);
    expect(scene.materials.length).toBe(materials);
    none.dispose();
  });

  it("primes once, then draws nothing for a boat at rest or an aircraft session", () => {
    for (const payload of [boat({ moored: true }), null]) {
      const system = new BoatSpraySystem(scene, { cap: 256, geometry: GEOMETRY });
      system.update({ ...running(0, 0, boat()), vehicle: payload });
      expect(system.drawing).toBe(true);
      for (let frame = 1; frame < 30; frame += 1) {
        system.update({ ...running(frame / 60, 0, boat()), vehicle: payload });
      }
      expect(system.drawing).toBe(false);
      expect(system.birthCount).toBe(0);
      system.dispose();
    }
  });

  it("throws sheets from the roots once planing, and stops drawing when they have all fallen", () => {
    const system = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
    run(system, 2, 60, PLANING);
    expect(system.drawing).toBe(true);
    const live = system.liveCount();
    // Steady state is near the budget, never the whole ring.
    expect(live).toBeGreaterThan(0.5 * (SPRAY_BUDGET_SHARES.sheet + SPRAY_BUDGET_SHARES.rooster) * 1_024);
    expect(live).toBeLessThan(1_024);

    // Off the plane with no roots: no new spray, and the mesh goes once the last droplet is down.
    const idle = boat({ speedThroughWater: 1 });
    run(system, SPRAY_MAX_LIFETIME_SECONDS + 0.2, 60, idle, 2);
    expect(system.liveCount()).toBe(0);
    expect(system.drawing).toBe(false);
    system.dispose();
  });

  it("raises the rooster tail only on the plane, and the mist only while ventilating", () => {
    const displacing = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
    run(displacing, 1, 60, boat({ planing: 0.2, propellerImmersion: 1 }));
    expect(displacing.birthCount).toBe(0);
    displacing.dispose();

    const rooster = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
    run(rooster, 1, 60, boat({ planing: 1, propellerImmersion: 1 }));
    expect(rooster.birthCount).toBeGreaterThan(50);
    // Born behind the transom and climbing.
    const records = rooster.instanceData!;
    const anchor = rooster.anchor;
    const state = running(1, 35 * KNOTS, PLANING);
    let behind = 0;
    for (let droplet = 0; droplet < rooster.birthCount; droplet += 1) {
      const at = droplet * SPRAY_FLOATS_PER_DROPLET;
      const age = sprayAge(sprayClock(1), records[at + 3]!);
      const bornX = records[at]! + anchor.x;
      // Where the hull was at the droplet's birth.
      const hullX = state.position.x - 35 * KNOTS * age;
      if (bornX < hullX - 1.5) behind += 1;
      expect(records[at + 5]!).toBeGreaterThan(0);
    }
    expect(behind).toBe(rooster.birthCount);
    rooster.dispose();

    const venting = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
    run(venting, 1, 60, boat({ ventilating: true, lever: 1, propellerImmersion: 0.3 }));
    expect(venting.birthCount).toBeGreaterThan(20);
    venting.dispose();
  });

  it("throws a held hull's spray in the hull's own frame, as a camera riding along sees it", () => {
    const speed = 35 * KNOTS;
    const wind = { windX: 3, windZ: -2 };
    const held = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY, ...wind });
    const moving = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY, ...wind });
    for (let frame = 0; frame <= 90; frame += 1) {
      const state = running(frame / 60, speed, PLANING);
      // A pinned capture: the clock runs, the velocity says 35 kn, the hull stays put.
      held.update({ ...state, position: { x: 0, y: 0.15, z: 40 } });
      moving.update(state);
    }
    expect(moving.referenceVelocity).toEqual({ x: 0, z: 0 });
    expect(held.referenceVelocity.x).toBeCloseTo(speed, 9);
    // The air the droplets relax to is the wind the boat feels.
    const windOf = (system: BoatSpraySystem) => (system as unknown as { windUniform: { x: number; z: number } }).windUniform;
    expect(windOf(held).x).toBeCloseTo(3 - speed, 9);
    expect(windOf(moving).x).toBeCloseTo(3, 9);

    // The same lattice and the same draws, droplet for droplet: the held
    // one's velocity is less the hull's, and it was born where the hull is.
    expect(held.birthCount).toBe(moving.birthCount);
    const a = held.instanceData!;
    const b = moving.instanceData!;
    let compared = 0;
    // Both rings wrap alike, so slot for slot.
    for (let droplet = 0; droplet < held.capacity; droplet += 1) {
      const at = droplet * SPRAY_FLOATS_PER_DROPLET;
      const birth = a[at + 3]!;
      if (a[at + 7] === 0 || birth < SPRAY_HELD_SECONDS + 2 / 60) continue;
      compared += 1;
      expect(b[at + 3]).toBe(birth);
      expect(a[at]!).toBeCloseTo(b[at]! - speed * birth, 3);
      expect(a[at + 2]!).toBeCloseTo(b[at + 2]!, 4);
      expect(a[at + 4]!).toBeCloseTo(b[at + 4]! - speed, 4);
      expect(a[at + 5]!).toBeCloseTo(b[at + 5]!, 4);
      expect(a[at + 6]!).toBeCloseTo(b[at + 6]!, 4);
    }
    expect(compared).toBeGreaterThan(100);

    // Moving again: back in the world's frame on the next frame.
    held.update(running(91 / 60, speed, PLANING));
    expect(held.referenceVelocity).toEqual({ x: 0, z: 0 });
    held.dispose();
    moving.dispose();
  });

  it("is deterministic: the same spray at 30, 60 and 144 frames a second", () => {
    const sample = (fps: number): Float32Array => {
      const system = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
      run(system, 1.5, fps, PLANING);
      const copy = Float32Array.from(system.instanceData!);
      system.dispose();
      return copy;
    };
    const at60 = sample(60);
    for (const fps of [30, 144]) {
      const other = sample(fps);
      expect(other.length).toBe(at60.length);
      let worst = 0;
      for (let index = 0; index < at60.length; index += 1) worst = Math.max(worst, Math.abs(other[index]! - at60[index]!));
      expect(worst).toBeLessThan(1e-3);
    }
  });

  it("emits on the 120 Hz lattice and drops a long hitch's backlog rather than bursting", () => {
    const system = new BoatSpraySystem(scene, { cap: 4_096, geometry: GEOMETRY });
    run(system, 1, 60, PLANING);
    const perSecond = system.birthCount;
    // A one-second hitch: at most the frame's emission budget is replayed.
    system.update(running(2, 35 * KNOTS, PLANING));
    expect(system.birthCount - perSecond).toBeLessThan(perSecond / 4);
    expect(SPRAY_EMISSION_HZ).toBe(120);
    system.dispose();
  });

  it("folds the sheets of every root into one budget, whatever the root count", () => {
    const few = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
    run(few, 1, 60, boat({ planing: 0, sprayRoots: chineRoots(2, 16), sprayRootCount: 2 }));
    const many = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
    run(many, 1, 60, boat({ planing: 0, sprayRoots: chineRoots(MAX_BOAT_SPRAY_ROOTS, 16), sprayRootCount: MAX_BOAT_SPRAY_ROOTS }));
    expect(many.birthCount).toBeGreaterThan(few.birthCount);
    // Never past the sheet share's steady-state rate.
    expect(many.birthCount).toBeLessThanOrEqual(Math.ceil((SPRAY_BUDGET_SHARES.sheet * 1_024) / 1.2) + MAX_BOAT_SPRAY_ROOTS);
    // Slow jets throw nothing.
    const slow = new BoatSpraySystem(scene, { cap: 1_024, geometry: GEOMETRY });
    run(slow, 1, 60, boat({ planing: 0, sprayRoots: chineRoots(8, 2), sprayRootCount: 8 }));
    expect(slow.birthCount).toBe(0);
    few.dispose();
    many.dispose();
    slow.dispose();
  });

  it("flies each droplet ballistically and fades it out before it lands back in the sea", () => {
    const system = new BoatSpraySystem(scene, { cap: 256, geometry: GEOMETRY });
    run(system, 0.25, 60, PLANING);
    const records = system.instanceData!;
    const sample = createSprayDropletSample();
    const birth = records[3]!;
    const life = records[7]!;
    sampleSprayDroplet(records, 0, sprayClock(birth + 0.001), 0, 0, sample);
    expect(sample.x).toBeCloseTo(records[0]!, 1);
    expect(sample.y).toBeCloseTo(records[1]!, 1);
    sampleSprayDroplet(records, 0, sprayClock(birth + life * 0.3), 0, 0, sample);
    expect(sample.alpha).toBeGreaterThan(0);
    expect(sample.y).toBeGreaterThan(records[1]!);
    sampleSprayDroplet(records, 0, sprayClock(birth + life + 0.01), 0, 0, sample);
    expect(sample.alpha).toBe(0);
    // Through the clock's wrap, the age is continuous.
    expect(sprayAge(0.5, SPRAY_CLOCK_PERIOD_SECONDS - 0.5)).toBeCloseTo(1, 9);
    system.dispose();
  });

  it("re-anchors every 2 km of travel without moving a droplet in the world", () => {
    const system = new BoatSpraySystem(scene, { cap: 256, geometry: GEOMETRY });
    const start = SPRAY_REANCHOR_METERS - 40;
    for (let frame = 1; frame <= 30; frame += 1) {
      system.update(running(frame / 60, 35 * KNOTS, PLANING, start));
    }
    const before = Float32Array.from(system.instanceData!);
    const anchorBefore = system.anchor.x;
    system.update(running(31 / 60, 35 * KNOTS, PLANING, start + SPRAY_REANCHOR_METERS * 2));
    expect(system.anchor.x).not.toBe(anchorBefore);
    const after = system.instanceData!;
    // A droplet born before the jump sits where it was in the world.
    expect(after[0]! + system.anchor.x).toBeCloseTo(before[0]! + anchorBefore, 2);
    system.dispose();
  });

  it("draws in the water group after the ocean and the steam, premultiplied, without writing depth", () => {
    const system = new BoatSpraySystem(scene, { cap: 256, geometry: GEOMETRY });
    const mesh = system.mesh!;
    expect(mesh.renderingGroupId).toBe(WATER_RENDERING_GROUP_ID);
    expect(mesh.alphaIndex).toBeGreaterThan(2);
    const material = mesh.material as ShaderMaterial;
    expect(material.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    expect(material.disableDepthWrite).toBe(true);
    expect(BOAT_SPRAY_VERTEX_WGSL).toContain("aerialPerspective(");
    expect(BOAT_SPRAY_FRAGMENT_WGSL).toContain("discard");
    system.dispose();
  });
});

describe("the light on the spray", () => {
  it("is the sea's own sun and sky, split so the sun lights the clump and not a level surface", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const system = new BoatSpraySystem(scene, { cap: 256, geometry: GEOMETRY });
    const atmosphere = {
      sunDirection: new Vector3(0.4, 0.5, 0.77).normalize(),
      sunColor: new Color3(1, 0.86, 0.7),
      sunIlluminanceNormalized: 0.62,
      skyZenith: new Color3(0.2, 0.36, 0.7),
      skyHorizon: new Color3(0.86, 0.66, 0.5),
      skylightIlluminanceNormalized: 0.7,
      windDirection: new Vector2(0, 1),
    } as unknown as AtmosphereSnapshot;
    system.setAtmosphere(atmosphere);
    const downwelling = waterDownwellingRadiance(
      [0.62, 0.86 * 0.62, 0.7 * 0.62],
      [0.2, 0.36, 0.7],
      [0.86, 0.66, 0.5],
      0.7,
      atmosphere.sunDirection.y,
      1,
    );
    const { sun, sky } = system.lighting;
    const elevation = atmosphere.sunDirection.y;
    expect(sun.x * elevation + sky.x).toBeCloseTo(downwelling[0], 6);
    expect(sun.y * elevation + sky.y).toBeCloseTo(downwelling[1], 6);
    expect(sun.z * elevation + sky.z).toBeCloseTo(downwelling[2], 6);
    // The sun's share alone is the sun's colour: the sky's is the sky's.
    expect(sun.y / sun.x).toBeCloseTo(0.86, 6);
    expect(sky.z).toBeGreaterThan(0);
    // The shader takes that and nothing else for its light: no second sun.
    const body = BOAT_SPRAY_VERTEX_WGSL.slice(BOAT_SPRAY_VERTEX_WGSL.indexOf("@vertex"));
    expect(body).toContain("uniforms.spraySun");
    expect(body).toContain("uniforms.spraySky");
    expect(body).not.toContain("aerialSunRadiance");
    expect(body).not.toContain("skyRadiance(");
    system.dispose();
    scene.dispose();
    engine.dispose();
  });
});
