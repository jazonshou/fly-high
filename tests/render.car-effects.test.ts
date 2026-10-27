import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type CarVisualState, type FlightVisualState } from "../src/game/types";
import { OPAQUE_RENDERING_GROUP_ID, WATER_RENDERING_GROUP_ID } from "../src/render/webgpu/core/RenderingGroups";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  CAR_BOW_WAVE_MIN_DEPTH,
  CAR_BOW_WAVE_SEA_DEFINE,
  CAR_BOW_WAVE_VERTEX_WGSL,
  CarBowWave,
  carBowWaveOutline,
  carBowWaveSeaShare,
} from "../src/render/webgpu/ground/CarBowWave";
import {
  CAR_SOIL,
  CAR_TRACK_MAX_DARKNESS,
  CAR_DUST_WETNESS,
  CAR_MUD_WETNESS,
  carDustIntensity,
  carExhaustSoot,
  carMudIntensity,
  carTrackMark,
  carWaterIntensity,
  carWheelContacts,
  carWheelWaterDepths,
  createCarWheelContacts,
} from "../src/render/webgpu/ground/carEffectLaws";
import { createCarEffects } from "../src/render/webgpu/ground/CarEffects";
import {
  CAR_PARTICLE_BUDGET_SHARES,
  CAR_PARTICLE_CAPACITY,
  CAR_PARTICLE_CHUNK,
  CAR_PARTICLE_FLOATS,
  CAR_PARTICLE_FRAGMENT_WGSL,
  CAR_PARTICLE_MAX_LIFETIME_SECONDS,
  CAR_PARTICLE_VERTEX_WGSL,
  CarParticleSystem,
  createCarParticleSample,
  sampleCarParticle,
} from "../src/render/webgpu/ground/CarParticleSystem";
import {
  CAR_TRACK_CAPACITY,
  CAR_TRACK_CHUNK,
  CAR_TRACK_COMMIT_TURN_DEGREES,
  CAR_TRACK_FLOATS,
  CAR_TRACK_MAX_SEGMENT_METERS,
  CarTrackSystem,
} from "../src/render/webgpu/ground/CarTrackSystem";
import { LC76_TYRE_LOADED_RADIUS, LC76_TYRE_WIDTH } from "../src/render/webgpu/ground/lc76Lines";
import { SURFACE_MATERIAL_COUNT, SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { surfaceVisualState } from "../src/sim/surface";
import { CalmWaterSurface } from "../src/sim/water";
import { car as rigCar, controls as rigControls, groundOf, STEP as RIG_STEP } from "./support/carRig";

/**
 * The LandCruiser's effects (src/render/webgpu/ground/CarEffects.ts): what it
 * throws into the air, the prints it leaves, and the bow wave in a ford.
 */

const SAND = SurfaceMaterial.Sand;

function car(overrides: Partial<CarVisualState> = {}): CarVisualState {
  return {
    kind: "car",
    speed: 0,
    gearbox: "automatic",
    selector: "D",
    gear: 2,
    range: "4H",
    locks: "off",
    downhillAssist: false,
    downhillAssistActive: false,
    tractionControlActive: false,
    absActive: false,
    clutch: 1,
    engineRunning: true,
    stalled: false,
    flooded: false,
    rolled: false,
    boost: 0.5,
    headlights: "off",
    brakeLights: false,
    reversing: false,
    tyrePressure: "sand",
    tyrePressureBar: 1.2,
    wadingDepth: 0,
    settling: false,
    wheelSteer: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelSpinRate: [0, 0, 0, 0],
    wheelLoad: [6_000, 6_000, 5_300, 5_300],
    wheelSlip: [0, 0, 0, 0],
    wheelSinkage: [0.02, 0.02, 0.02, 0.02],
    wheelSurface: [SAND, SAND, SAND, SAND],
    wheelWetness: [0, 0, 0, 0],
    axleHeave: [0, 0],
    axleRoll: [0, 0],
    steeringWheel: 0,
    bumpStop: 0,
    scrape: 0,
    splash: 0,
    ...overrides,
  };
}

/** The car rolling at `speed` m/s without slip. */
function rolling(speed: number, overrides: Partial<CarVisualState> = {}): CarVisualState {
  const spin = speed / LC76_TYRE_LOADED_RADIUS;
  return car({ speed, wheelSpinRate: [spin, spin, spin, spin], ...overrides });
}

/** The car driving east (+X) at `speed`, its centre of gravity 0.8 m over flat ground at y = 0. */
function driving(time: number, speed: number, payload: CarVisualState | null, x0 = 0, throttle = 0): FlightVisualState {
  return {
    ...INITIAL_VISUAL_STATE,
    position: { x: x0 + speed * time, y: 0.8, z: 25 },
    velocity: { x: speed, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    airspeed: Math.abs(speed),
    simulationTime: time,
    onGround: true,
    crashed: false,
    throttle,
    vehicle: payload,
  };
}

function run(
  update: (state: FlightVisualState) => void,
  seconds: number,
  fps: number,
  speed: number,
  payload: CarVisualState | null,
  { start = 0, throttle = 0 } = {},
): void {
  const frames = Math.round(seconds * fps);
  for (let frame = start === 0 ? 0 : 1; frame <= frames; frame += 1) {
    update(driving(start + frame / fps, speed, payload, 0, throttle));
  }
}

const PROFILES = [
  resolveWebGpuQualityProfile("low", "balanced"),
  resolveWebGpuQualityProfile("medium", "balanced"),
  resolveWebGpuQualityProfile("high", "balanced"),
  resolveWebGpuQualityProfile("high", "ultra"),
];

describe("what each ground gives off under a tyre", () => {
  it("has one row per surface material, with no print on rock, lava or paving", () => {
    expect(CAR_SOIL).toHaveLength(SURFACE_MATERIAL_COUNT);
    for (const id of [SurfaceMaterial.Rock, SurfaceMaterial.Basalt, SurfaceMaterial.Asphalt, SurfaceMaterial.Concrete]) {
      expect(CAR_SOIL[id]!.track).toBe(0);
    }
    // Sand and ash lift most readily; a road almost never.
    expect(CAR_SOIL[SAND]!.dust).toBe(1);
    expect(CAR_SOIL[SurfaceMaterial.Asphalt]!.dust).toBeLessThan(0.05);
    // A sward's dust is its soil's colour, not its green.
    const [r, g] = CAR_SOIL[SurfaceMaterial.Grass]!.dustAlbedo;
    expect(r).toBeGreaterThan(g);
  });

  it("lifts dust off dry loose ground with speed and wheelspin, and none wet, paved or unloaded", () => {
    expect(carDustIntensity(car(), 0)).toBe(0);
    const cruising = carDustIntensity(rolling(15), 0);
    expect(cruising).toBeGreaterThan(0.8);
    // Wheelspin digs at walking pace.
    const crawl = rolling(1.5);
    expect(carDustIntensity({ ...crawl, wheelSpinRate: [20, 20, 20, 20] }, 0)).toBeGreaterThan(carDustIntensity(crawl, 0) + 0.4);
    expect(carDustIntensity(rolling(15, { wheelWetness: [0.8, 0.8, 0.8, 0.8] }), 0)).toBe(0);
    const asphalt = SurfaceMaterial.Asphalt;
    expect(carDustIntensity(rolling(15, { wheelSurface: [asphalt, asphalt, asphalt, asphalt] }), 0)).toBeLessThan(0.05);
    expect(carDustIntensity(rolling(15, { wheelLoad: [0, 6_000, 5_300, 5_300] }), 0)).toBe(0);
  });

  it("reads wetness on the simulator's scale: dust in the dry provinces, mud only where it drives as mud", () => {
    // The classifier's soil moisture, measured over the perf seed's land:
    // dry grass at 0.29 in the high desert and 0.41 in the savanna, grass at
    // 0.57 and forest floor at 0.61 in the temperate province.
    const on = (material: number, wetness: number): CarVisualState => rolling(12, {
      wheelSurface: [material, material, material, material],
      wheelWetness: [wetness, wetness, wetness, wetness],
    });
    const dryGrass = SurfaceMaterial.DryGrass;
    const grass = SurfaceMaterial.Grass;
    const desert = carDustIntensity(on(dryGrass, 0.29), 0);
    expect(desert).toBeCloseTo(carDustIntensity(on(dryGrass, 0), 0), 9);
    expect(carDustIntensity(on(dryGrass, 0.41), 0)).toBeCloseTo(desert, 9);
    const temperate = carDustIntensity(on(grass, 0.57), 0);
    expect(temperate).toBeGreaterThan(0);
    expect(temperate).toBeLessThan(0.5 * carDustIntensity(on(grass, 0.3), 0));
    // No summer meadow throws mud; the simulator's mud does, from 0.6 to 0.9.
    expect(carMudIntensity(on(grass, 0.57), 0)).toBe(0);
    expect(carMudIntensity(on(SurfaceMaterial.ForestFloor, 0.61), 0)).toBeLessThan(0.01);
    expect(carMudIntensity(on(grass, 0.75), 0)).toBeGreaterThan(0);
    expect(CAR_MUD_WETNESS).toEqual([0.6, 0.9]);
    expect(CAR_DUST_WETNESS[1]).toBeGreaterThan(CAR_MUD_WETNESS[0]);
  });

  it("flings mud only off soaked soil, more spinning, and throws water only in a ford or off a soaked road", () => {
    const grass = SurfaceMaterial.Grass;
    const wet = rolling(8, { wheelSurface: [grass, grass, grass, grass], wheelWetness: [0.9, 0.9, 0.9, 0.9] });
    expect(carMudIntensity(rolling(8, { wheelSurface: [grass, grass, grass, grass] }), 0)).toBe(0);
    expect(carMudIntensity(wet, 0)).toBeGreaterThan(0);
    expect(carMudIntensity({ ...wet, wheelSpinRate: [60, 60, 60, 60] }, 0)).toBeGreaterThan(carMudIntensity(wet, 0));
    expect(carWaterIntensity(wet, 0)).toBe(0);
    const ford = rolling(3, { wheelSurface: [-1, -1, -1, -1], wheelWetness: [1, 1, 1, 1], wadingDepth: 0.4 });
    expect(carWaterIntensity(ford, 0)).toBeGreaterThan(0.3);
    // In the air (no load) nothing, whatever the surface says.
    expect(carWaterIntensity({ ...ford, wheelLoad: [0, 0, 0, 0] }, 0)).toBe(0);
    const road = SurfaceMaterial.Asphalt;
    const soakedRoad = rolling(25, { wheelSurface: [road, road, road, road], wheelWetness: [1, 1, 1, 1] });
    expect(carWaterIntensity(soakedRoad, 0)).toBeGreaterThan(0);
    expect(carWaterIntensity({ ...soakedRoad, speed: 5 }, 0)).toBe(0);
  });

  it("smokes under load before the turbo spools, hardly on boost, and not at all off the throttle or stopped", () => {
    expect(carExhaustSoot(car({ boost: 0 }), 0)).toBe(0);
    const lag = carExhaustSoot(car({ boost: 0 }), 1);
    const spooled = carExhaustSoot(car({ boost: 1 }), 1);
    expect(lag).toBeGreaterThan(0.9);
    expect(spooled).toBeLessThan(0.3 * lag);
    expect(carExhaustSoot(car({ boost: 0, engineRunning: false }), 1)).toBe(0);
  });

  it("prints darker wet and darker and wider the deeper the tyre sinks, and not on rock unless it sinks", () => {
    const mark = { darkness: 0, halfWidth: 0 };
    const firm = carTrackMark(rolling(5, { wheelSinkage: [0, 0, 0, 0] }), 0, mark).darkness;
    expect(firm).toBeCloseTo(CAR_SOIL[SAND]!.track, 6);
    expect(mark.halfWidth).toBeCloseTo(LC76_TYRE_WIDTH / 2, 6);
    const deep = carTrackMark(rolling(5, { wheelSinkage: [0.1, 0, 0, 0] }), 0, mark);
    expect(deep.darkness).toBeGreaterThan(firm + 0.2);
    expect(deep.halfWidth).toBeGreaterThan(1.4 * (LC76_TYRE_WIDTH / 2));
    expect(carTrackMark(rolling(5, { wheelSinkage: [0.1, 0, 0, 0], wheelWetness: [1, 0, 0, 0] }), 0, mark).darkness)
      .toBeLessThanOrEqual(CAR_TRACK_MAX_DARKNESS);
    const rock = SurfaceMaterial.Rock;
    expect(carTrackMark(rolling(5, { wheelSurface: [rock, rock, rock, rock], wheelSinkage: [0, 0, 0, 0] }), 0, mark).darkness).toBe(0);
    expect(carTrackMark(rolling(5, { wheelSurface: [-1, -1, -1, -1] }), 0, mark).darkness).toBe(0);
  });

  it("finds each tyre's foot under its wheel, on the ground at rest and tilted with the axle", () => {
    const contacts = createCarWheelContacts();
    carWheelContacts(driving(0, 0, null), car({ wheelSinkage: [0, 0, 0, 0] }), contacts);
    for (const contact of contacts) {
      expect(contact.y).toBeCloseTo(0, 6);
      expect(contact.surfaceY).toBeCloseTo(0, 6);
      expect(contact.forwardX).toBeCloseTo(1, 6);
      expect(contact.loaded).toBe(true);
    }
    // Left wheels at -z, right at +z, fronts ahead of rears.
    expect(contacts[0]!.z).toBeLessThan(25);
    expect(contacts[1]!.z).toBeGreaterThan(25);
    expect(contacts[0]!.x).toBeGreaterThan(contacts[2]!.x);
    // The front axle rolled right-end-up over a 0.25 m block: the right foot rises with it.
    const rolled = car({ axleHeave: [0.125, 0], axleRoll: [Math.asin(0.25 / 1.555), 0], wheelSinkage: [0, 0, 0, 0] });
    carWheelContacts(driving(0, 0, null), rolled, contacts);
    expect(contacts[1]!.y - contacts[0]!.y).toBeCloseTo(0.25, 2);
    // A steered front wheel rolls to the right of the body's heading.
    carWheelContacts(driving(0, 0, null), car({ wheelSteer: [0.3, 0.3, 0, 0] }), contacts);
    expect(contacts[0]!.forwardZ).toBeCloseTo(Math.sin(0.3), 6);
  });

  it("puts each tyre in as much of the ford as stands over its own ground", () => {
    const contacts = createCarWheelContacts();
    const depths = [0, 0, 0, 0];
    // Out of water: no level, nothing over any tyre.
    carWheelContacts(driving(0, 0, null), car({ wheelSinkage: [0, 0, 0, 0] }), contacts);
    expect(Number.isNaN(carWheelWaterDepths(car(), contacts, depths))).toBe(true);
    expect(depths).toEqual([0, 0, 0, 0]);
    // The front axle up a 0.25 m bank, the rears in 0.4 m of water: the
    // level is the rears' ground plus the wading depth.
    const bank = car({ axleHeave: [0.125, 0], axleRoll: [Math.asin(0.25 / 1.555), 0], wheelSinkage: [0, 0, 0, 0], wadingDepth: 0.4 });
    carWheelContacts(driving(0, 0, null), bank, contacts);
    const level = carWheelWaterDepths(bank, contacts, depths);
    expect(level).toBeCloseTo(Math.min(...contacts.map((c) => c.surfaceY)) + 0.4, 9);
    expect(depths[2]).toBeCloseTo(0.4, 6);
    expect(depths[3]).toBeCloseTo(0.4, 6);
    expect(depths[1]).toBeCloseTo(depths[0]! - 0.25, 2);
    // A loaded tyre on sand under water throws water, not mud or dust.
    const wading = rolling(3, { wheelWetness: [1, 1, 1, 1], wadingDepth: 0.4 });
    expect(carWaterIntensity(wading, 0, 0.4)).toBeGreaterThan(0.3);
    expect(carMudIntensity(wading, 0, 0.4)).toBe(0);
    expect(carDustIntensity(rolling(15), 0, 0.4)).toBe(0);
    expect(carWaterIntensity(wading, 0, 0)).toBe(0);
  });
});

describe("the car's particles", () => {
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

  it("caps each tier at 32 / 128 / 256 / 384, inside the ring and in whole upload chunks", () => {
    const caps = PROFILES.map((profile) => profile.vehicleParticleBudget);
    expect(caps).toEqual([32, 128, 256, 384]);
    for (const cap of caps) {
      expect(cap).toBeLessThanOrEqual(CAR_PARTICLE_CAPACITY);
      expect(cap % CAR_PARTICLE_CHUNK).toBe(0);
      const system = new CarParticleSystem(scene, { cap });
      expect(system.capacity).toBe(cap);
      expect(system.mesh!.forcedInstanceCount).toBe(cap);
      expect(system.instanceData!.length).toBe(cap * CAR_PARTICLE_FLOATS);
      system.dispose();
    }
    const shares = CAR_PARTICLE_BUDGET_SHARES;
    expect(shares.dust + shares.throw + shares.bow + shares.exhaust).toBeLessThan(1);
  });

  it("creates nothing at a cap of 0, and tears down and rebuilds on a cap change", () => {
    const meshes = scene.meshes.length;
    const none = new CarParticleSystem(scene, { cap: 0 });
    run((state) => none.update(state), 1, 60, 15, rolling(15));
    expect(none.mesh).toBeNull();
    expect(none.birthCount).toBe(0);
    expect(scene.meshes.length).toBe(meshes);
    none.setCap(100);
    expect(none.capacity).toBe(96);
    none.setCap(0);
    expect(scene.meshes.length).toBe(meshes);
    none.dispose();
  });

  it("primes once, then draws nothing for a car at rest on paving or in another vehicle's session", () => {
    const asphalt = SurfaceMaterial.Asphalt;
    for (const payload of [car({ wheelSurface: [asphalt, asphalt, asphalt, asphalt] }), null]) {
      const system = new CarParticleSystem(scene, { cap: 128 });
      system.update(driving(0, 0, payload));
      expect(system.drawing).toBe(true);
      run((state) => system.update(state), 0.5, 60, 0, payload, { start: 0.0001 });
      expect(system.drawing).toBe(false);
      expect(system.birthCount).toBe(0);
      system.dispose();
    }
  });

  it("raises a dust cloud on dry sand at speed near its share of the budget, and none of anything else", () => {
    const system = new CarParticleSystem(scene, { cap: 256 });
    run((state) => system.update(state), 6, 60, 15, rolling(15));
    const live = system.liveCount();
    expect(live).toBeGreaterThan(0.6 * CAR_PARTICLE_BUDGET_SHARES.dust * 256);
    expect(live).toBeLessThan(256);
    const born = system.birthsBySource;
    expect(born.dust).toBe(system.birthCount);
    // Stopped: the cloud settles away and the mesh goes once the last puff is gone.
    run((state) => system.update(state), CAR_PARTICLE_MAX_LIFETIME_SECONDS + 0.2, 60, 0, car(), { start: 6 });
    expect(system.liveCount()).toBe(0);
    expect(system.drawing).toBe(false);
    system.dispose();
  });

  it("throws mud on soaked ground, water and a bow splash in a ford, and smoke under load", () => {
    const grass = SurfaceMaterial.Grass;
    const mud = new CarParticleSystem(scene, { cap: 256 });
    run((state) => mud.update(state), 2, 60, 8, rolling(8, {
      wheelSurface: [grass, grass, grass, grass], wheelWetness: [0.9, 0.9, 0.9, 0.9], wheelSpinRate: [40, 40, 40, 40],
    }));
    expect(mud.birthsBySource.mud).toBeGreaterThan(0);
    expect(mud.birthsBySource.dust).toBe(0);
    mud.dispose();

    const ford = new CarParticleSystem(scene, { cap: 256 });
    run((state) => ford.update(state), 2, 60, 3, rolling(3, {
      wheelSurface: [-1, -1, -1, -1], wheelWetness: [1, 1, 1, 1], wadingDepth: 0.5, wheelSinkage: [0, 0, 0, 0],
    }));
    expect(ford.birthsBySource.water).toBeGreaterThan(0);
    expect(ford.birthsBySource.bow).toBeGreaterThan(0);
    expect(ford.birthsBySource.dust).toBe(0);
    ford.dispose();

    // The same ford as the simulator reports it: loaded tyres on the bed's
    // sand, the water only in the wading depth.
    const bed = new CarParticleSystem(scene, { cap: 256 });
    run((state) => bed.update(state), 2, 60, 3, rolling(3, { wadingDepth: 0.5, wheelSinkage: [0, 0, 0, 0] }));
    expect(bed.birthsBySource.water).toBeGreaterThan(0);
    expect(bed.birthsBySource.bow).toBeGreaterThan(0);
    expect(bed.birthsBySource.dust).toBe(0);
    expect(bed.birthsBySource.mud).toBe(0);
    bed.dispose();

    const smoke = new CarParticleSystem(scene, { cap: 256 });
    const asphalt = SurfaceMaterial.Asphalt;
    const road = car({ boost: 0, wheelSurface: [asphalt, asphalt, asphalt, asphalt] });
    run((state) => smoke.update(state), 2, 60, 0, road, { throttle: 0 });
    expect(smoke.birthCount).toBe(0);
    run((state) => smoke.update(state), 2, 60, 0, road, { start: 2, throttle: 1 });
    expect(smoke.birthsBySource.exhaust).toBeGreaterThan(0);
    expect(smoke.birthsBySource.exhaust).toBe(smoke.birthCount);
    smoke.dispose();
  });

  it("is deterministic: the same particles at 30, 60 and 144 frames a second", () => {
    const rings = [30, 60, 144].map((fps) => {
      const system = new CarParticleSystem(scene, { cap: 128, windX: 2, windZ: 1 });
      run((state) => system.update(state), 1.5, fps, 12, rolling(12));
      const ring = Float32Array.from(system.instanceData!);
      system.dispose();
      return ring;
    });
    expect(rings[0]!.some((value) => value !== 0)).toBe(true);
    expect(Array.from(rings[1]!)).toEqual(Array.from(rings[0]!));
    expect(Array.from(rings[2]!)).toEqual(Array.from(rings[0]!));
  });

  it("lets dust drift downwind and roll along the ground, and drops a clod once it lands", () => {
    const wind = 3;
    const system = new CarParticleSystem(scene, { cap: 128, windZ: wind });
    run((state) => system.update(state), 1.5, 60, 15, rolling(15));
    const records = system.instanceData!;
    const sample = createCarParticleSample();
    let checked = 0;
    for (let particle = 0; particle < 128; particle += 1) {
      const at = particle * CAR_PARTICLE_FLOATS;
      if (records[at + 7]! <= 0) continue;
      const birth = records[at + 3]!;
      sampleCarParticle(records, particle, birth + 2.5, 0, wind, sample);
      // Two and a half seconds on, it has gone downwind, and it never sinks below the sand.
      expect(sample.z - records[at + 2]!).toBeGreaterThan(2);
      expect(sample.y).toBeGreaterThanOrEqual(records[at + 16]! + 0.3 * sample.sizeMeters);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
    system.dispose();

    // A mud clod thrown up falls back through the ground and is gone.
    const clod = new Float32Array(CAR_PARTICLE_FLOATS);
    clod.set([0, 0.3, 0, 0, 0, 2, 0, 1.2, 0.05, 0, 0.25, 0.95, 0.1, 0.08, 0.05, 1, 0, 0, 0.1, 1]);
    sampleCarParticle(clod, 0, 0.2, 0, 0, sample);
    expect(sample.alpha).toBeGreaterThan(0.5);
    sampleCarParticle(clod, 0, 0.9, 0, 0, sample);
    expect(sample.y).toBeLessThan(0);
    expect(sample.alpha).toBe(0);
  });

  it("draws in the water group with the boat spray's order, premultiplied, without writing depth", () => {
    const system = new CarParticleSystem(scene, { cap: 128 });
    const mesh = system.mesh!;
    expect(mesh.renderingGroupId).toBe(WATER_RENDERING_GROUP_ID);
    expect(mesh.alphaIndex).toBe(2.5);
    const material = mesh.material as ShaderMaterial;
    expect(material.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    expect(material.disableDepthWrite).toBe(true);
    expect(CAR_PARTICLE_VERTEX_WGSL).toContain("aerialPerspective(");
    expect(CAR_PARTICLE_VERTEX_WGSL).toContain("uniforms.carSun");
    expect(CAR_PARTICLE_FRAGMENT_WGSL).toContain("discard");
    system.dispose();
  });
});

describe("the car's tyre tracks", () => {
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

  /** Segment `slot`'s start and end points and across-vectors, world x, z (anchor-relative). */
  function segment(records: Float32Array, slot: number) {
    const at = slot * CAR_TRACK_FLOATS;
    return {
      start: [records[at]!, records[at + 2]!],
      end: [records[at + 4]!, records[at + 6]!],
      startSide: [records[at + 8]!, records[at + 9]!],
      endSide: [records[at + 10]!, records[at + 11]!],
      darkness: [records[at + 12]!, records[at + 13]!],
      sequence: records[at + 14]!,
    };
  }

  it("rings 0 / 256 / 512 / 1,024 segments, and Low builds nothing at all", () => {
    const rings = PROFILES.map((profile) => profile.tyreTrackSegments);
    expect(rings).toEqual([0, 256, 512, 1_024]);
    for (const ring of rings) {
      expect(ring).toBeLessThanOrEqual(CAR_TRACK_CAPACITY);
      expect(ring % CAR_TRACK_CHUNK).toBe(0);
    }
    const meshes = scene.meshes.length;
    const low = new CarTrackSystem(scene, { segments: 0 });
    run((state) => low.update(state), 2, 60, 10, rolling(10));
    expect(low.mesh).toBeNull();
    expect(low.drawing).toBe(false);
    expect(scene.meshes.length).toBe(meshes);
    low.dispose();
  });

  it("lays four prints across sand, joined without gaps, reaching the tyres, in 2 m straight segments", () => {
    const tracks = new CarTrackSystem(scene, { segments: 256 });
    tracks.update(driving(0, 10, rolling(10)));
    expect(tracks.drawing).toBe(false);
    run((state) => tracks.update(state), 3, 60, 10, rolling(10), { start: 0 });
    expect(tracks.drawing).toBe(true);
    // 30 m at 2 m a segment for each of four tyres.
    expect(tracks.segmentCount).toBeGreaterThanOrEqual(4 * 15);
    expect(tracks.segmentCount).toBeLessThanOrEqual(4 * 16);
    const records = tracks.instanceData!;
    const anchor = tracks.anchor;
    for (let slot = 0; slot < tracks.segmentCount; slot += 1) {
      const piece = segment(records, slot);
      expect(Math.hypot(piece.end[0]! - piece.start[0]!, piece.end[1]! - piece.start[1]!)).toBeLessThanOrEqual(CAR_TRACK_MAX_SEGMENT_METERS + 0.2);
      // Across the print: half a 265 mm tyre, a little more for the 2 cm sinkage.
      expect(Math.hypot(piece.endSide[0]!, piece.endSide[1]!)).toBeGreaterThanOrEqual(LC76_TYRE_WIDTH / 2);
    }
    // The newest segments end at the tyres' feet, 30 m on.
    const newest = Math.max(...Array.from({ length: tracks.segmentCount }, (_, slot) => segment(records, slot).end[0]! + anchor.x));
    expect(newest).toBeGreaterThan(30 + 1.3 - 0.05);
    tracks.dispose();
  });

  it("joins a curve's segments edge to edge: each starts where the last ended, across the same line", () => {
    const tracks = new CarTrackSystem(scene, { segments: 512 });
    const radius = 30;
    const speed = 10;
    for (let frame = 0; frame <= 360; frame += 1) {
      const time = frame / 60;
      const angle = (speed * time) / radius;
      // Round a circle anticlockwise seen from above, the body's +X along the path.
      const yaw = -angle;
      tracks.update({
        ...driving(time, speed, rolling(speed)),
        position: { x: radius * Math.sin(angle), y: 0.8, z: radius - radius * Math.cos(angle) },
        velocity: { x: speed * Math.cos(angle), y: 0, z: speed * Math.sin(angle) },
        orientation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
      });
    }
    const records = tracks.instanceData!;
    const pieces = Array.from({ length: tracks.segmentCount }, (_, slot) => segment(records, slot));
    let joints = 0;
    for (const after of pieces) {
      const before = pieces.find((piece) => piece.sequence < after.sequence
        && Math.hypot(piece.end[0]! - after.start[0]!, piece.end[1]! - after.start[1]!) < 1e-4);
      if (!before) continue;
      expect(after.startSide[0]).toBeCloseTo(before.endSide[0]!, 6);
      expect(after.startSide[1]).toBeCloseTo(before.endSide[1]!, 6);
      // And bends there by no more than the commit turn, plus a frame's travel.
      const bend = Math.acos(Math.min(1,
        ((before.end[0]! - before.start[0]!) * (after.end[0]! - after.start[0]!)
          + (before.end[1]! - before.start[1]!) * (after.end[1]! - after.start[1]!))
        / (Math.hypot(before.end[0]! - before.start[0]!, before.end[1]! - before.start[1]!)
          * Math.hypot(after.end[0]! - after.start[0]!, after.end[1]! - after.start[1]!))));
      expect((bend * 180) / Math.PI).toBeLessThan(CAR_TRACK_COMMIT_TURN_DEGREES + 0.5);
      joints += 1;
    }
    // Every segment but each strip's first joins the one before it.
    expect(joints).toBe(pieces.length - 4);
    tracks.dispose();
  });

  it("lays nothing on asphalt, and ends a strip where the ground stops taking a print", () => {
    const asphalt = SurfaceMaterial.Asphalt;
    const tracks = new CarTrackSystem(scene, { segments: 256 });
    run((state) => tracks.update(state), 2, 60, 10, rolling(10, { wheelSurface: [asphalt, asphalt, asphalt, asphalt], wheelSinkage: [0, 0, 0, 0] }));
    expect(tracks.segmentCount).toBe(0);
    expect(tracks.drawing).toBe(false);
    run((state) => tracks.update(state), 1, 60, 10, rolling(10), { start: 2 });
    const onSand = tracks.segmentCount;
    expect(onSand).toBeGreaterThan(0);
    run((state) => tracks.update(state), 1, 60, 10, rolling(10, { wheelSurface: [asphalt, asphalt, asphalt, asphalt], wheelSinkage: [0, 0, 0, 0] }), { start: 3 });
    expect(tracks.segmentCount).toBe(onSand);
    tracks.dispose();
  });

  it("primes the tracks behind a car first seen moving, on the ground it is given, fading out", () => {
    const groundY = (x: number) => 0.01 * x;
    const tracks = new CarTrackSystem(scene, { segments: 256, groundHeight: (x) => groundY(x) });
    tracks.update(driving(10, 10, rolling(10, { wheelSinkage: [0, 0, 0, 0] })));
    expect(tracks.segmentCount).toBe(4 * 20);
    const records = tracks.instanceData!;
    const anchor = tracks.anchor;
    let farthest = Infinity;
    for (let slot = 0; slot < tracks.segmentCount; slot += 1) {
      const at = slot * CAR_TRACK_FLOATS;
      const startX = records[at]! + anchor.x;
      expect(records[at + 1]).toBeCloseTo(groundY(startX), 5);
      farthest = Math.min(farthest, startX);
      // Each strip's far end has faded out; its end at the tyre is the print's full darkness.
      if (records[at + 3] === -40) expect(records[at + 12]).toBe(0);
      if (records[at + 7] === 0) expect(records[at + 13]).toBeCloseTo(CAR_SOIL[SAND]!.track, 6);
    }
    // 40 m (eight seconds at 10 m/s, capped) behind the rear tyres.
    expect(farthest).toBeCloseTo(100 - 1.4196 - 40, 2);
    tracks.dispose();
  });

  it("draws in the opaque group before the cloud shell, multiplying the ground, without writing depth", () => {
    const tracks = new CarTrackSystem(scene, { segments: 256 });
    const mesh = tracks.mesh!;
    expect(mesh.renderingGroupId).toBe(OPAQUE_RENDERING_GROUP_ID);
    expect(mesh.alphaIndex).toBe(0);
    const material = mesh.material as ShaderMaterial;
    expect(material.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    expect(material.disableDepthWrite).toBe(true);
    expect(material.zOffset).toBeLessThan(0);
    tracks.dispose();
  });
});

describe("the bow wave in a ford", () => {
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

  it("goes round the body's footprint, outward everywhere", () => {
    const outline = carBowWaveOutline();
    for (const point of outline) {
      expect(Math.hypot(point.nx, point.nz)).toBeCloseTo(1, 6);
      // Outward: the normal points away from the footprint's middle.
      expect(point.nx * (point.x + 0.25) + point.nz * point.z).toBeGreaterThan(0);
    }
    expect(outline[0]!.nx).toBe(1);
  });

  it("is not drawn dry, fades in wading and lies on the water: the lowest tyre's ground plus the depth", () => {
    const bow = new CarBowWave(scene);
    run((state) => bow.update(state), 1, 60, 3, rolling(3));
    expect(bow.drawing).toBe(false);
    const wading = rolling(2, { wadingDepth: 0.45, wheelSurface: [-1, -1, -1, -1], wheelSinkage: [0, 0, 0, 0] });
    run((state) => bow.update(state), 0.1, 60, 2, wading, { start: 1 });
    expect(bow.drawing).toBe(true);
    expect(bow.presence).toBeGreaterThan(0.2);
    expect(bow.presence).toBeLessThan(0.5);
    run((state) => bow.update(state), 0.5, 60, 2, wading, { start: 1.1 });
    expect(bow.presence).toBe(1);
    expect(bow.pose.y).toBeCloseTo(0.45, 5);
    // Out of the water again: gone within a third of a second or so.
    run((state) => bow.update(state), 0.4, 60, 2, rolling(2, { wadingDepth: CAR_BOW_WAVE_MIN_DEPTH / 2 }), { start: 1.6 });
    expect(bow.drawing).toBe(false);
    const mesh = bow.bowMesh;
    expect(mesh.renderingGroupId).toBe(WATER_RENDERING_GROUP_ID);
    expect(mesh.alphaIndex).toBeLessThan(2.5);
    bow.dispose();
  });

  it("rides the drawn sea's waves in the sea, and lies flat on a lake or a river above it", () => {
    // The calm level the simulator wades the car in is sea level itself.
    expect(carBowWaveSeaShare(0, 0)).toBe(1);
    expect(carBowWaveSeaShare(0.08, 0)).toBe(1);
    expect(carBowWaveSeaShare(-0.08, 0)).toBe(1);
    expect(carBowWaveSeaShare(0.25, 0)).toBeGreaterThan(0);
    expect(carBowWaveSeaShare(0.25, 0)).toBeLessThan(1);
    expect(carBowWaveSeaShare(0.4, 0)).toBe(0);
    expect(carBowWaveSeaShare(12, 0)).toBe(0);
    expect(carBowWaveSeaShare(Number.NaN, 0)).toBe(0);
    // The sea's own displacement, behind the define, and nothing of it otherwise.
    expect(CAR_BOW_WAVE_VERTEX_WGSL).toContain(`#ifdef ${CAR_BOW_WAVE_SEA_DEFINE}`);
    expect(CAR_BOW_WAVE_VERTEX_WGSL).toContain("fn oceanSurfaceDisplacement(");
    expect(CAR_BOW_WAVE_VERTEX_WGSL).toContain("oceanSurfaceDisplacement(worldXZ) * share");

    const bound: unknown[] = [];
    const ocean = { bindSurface: (material: unknown) => bound.push(material) };
    const flat = new CarBowWave(scene);
    const onSea = new CarBowWave(scene, { sea: { ocean, seaLevel: 0 } });
    const flatMaterial = flat.bowMesh.material as ShaderMaterial;
    const seaMaterial = onSea.bowMesh.material as ShaderMaterial;
    expect(flatMaterial.options.defines).not.toContain(`#define ${CAR_BOW_WAVE_SEA_DEFINE}`);
    expect(seaMaterial.options.defines).toContain(`#define ${CAR_BOW_WAVE_SEA_DEFINE}`);
    expect(seaMaterial.options.samplers).toContain("displacement0");
    // Bound only while it draws, as the boat's wake is.
    onSea.bindOcean();
    expect(bound).toHaveLength(0);
    const wading = rolling(2, { wadingDepth: 0.45, wheelSurface: [-1, -1, -1, -1], wheelSinkage: [0, 0, 0, 0] });
    run((state) => onSea.update(state), 0.5, 60, 2, wading, { start: 1 });
    onSea.bindOcean();
    expect(bound).toEqual([seaMaterial]);
    flat.dispose();
    onSea.dispose();
  });
});

describe("the car's effects together", () => {
  it("build three meshes at most, and none of the tracks' on Low", () => {
    for (const profile of PROFILES) {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const before = scene.meshes.length;
      const effects = createCarEffects(scene, { profile, world: { prevailingWindRadians: 0, prevailingWindSpeed: 4 } });
      const built = scene.meshes.length - before;
      expect(built).toBe(profile.tyreTrackSegments > 0 ? 3 : 2);
      effects.particles.dispose();
      effects.tracks.dispose();
      effects.bowWave.dispose();
      expect(scene.meshes.length).toBe(before);
      scene.dispose();
      engine.dispose();
    }
  });

  it("spray and push a bow wave off the simulator's own ford", () => {
    // The real car driven down a 3 degree beach into still water; with no
    // world its tyres report asphalt, so only the water over each tyre's
    // ground (from the wading depth) can make it a ford.
    const grade = Math.tan((3 * Math.PI) / 180);
    const height = (z: number): number => 0.6 - grade * z;
    const sim = rigCar({}, groundOf((out) => {
      out.height = height(out.z);
      out.dhdx = 0;
      out.dhdz = -grade;
    }));
    sim.setEnvironment({
      water: new CalmWaterSurface(0, (_x, z) => height(z)),
      wind: { x: 0, y: 0, z: 0 },
      bedHeight: (_x, z) => height(z),
      gravity: 9.80665,
    });
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const particles = new CarParticleSystem(scene, { cap: 256 });
    const bow = new CarBowWave(scene);
    rigControls(sim, { accelerator: 0.25 });
    let dryBirths = -1;
    let wading = 0;
    for (let step = 0; step < 120 * 12 && wading < 0.4; step += 1) {
      sim.step(RIG_STEP);
      const state = surfaceVisualState(sim.snapshot(), undefined);
      particles.update(state);
      bow.update(state);
      wading = (state.vehicle as CarVisualState).wadingDepth;
      if (wading === 0) dryBirths = particles.birthsBySource.water;
    }
    expect(wading).toBeGreaterThanOrEqual(0.4);
    expect(dryBirths).toBe(0);
    expect(particles.birthsBySource.water).toBeGreaterThan(0);
    expect(particles.birthsBySource.bow).toBeGreaterThan(0);
    expect(particles.birthsBySource.mud + particles.birthsBySource.dust).toBe(0);
    expect(bow.drawing).toBe(true);
    particles.dispose();
    bow.dispose();
    scene.dispose();
    engine.dispose();
  });
});
