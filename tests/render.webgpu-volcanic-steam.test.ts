import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VOLUMETRIC_CLOUD_CONFIG } from "../src/render/webgpu/nature/CloudConfig";
import { WATER_RENDERING_GROUP_ID } from "../src/render/webgpu/core/RenderingGroups";
import {
  createSteamWispSample,
  sampleSteamWisp,
  STEAM_CYCLE_PERIOD_SECONDS,
  STEAM_FLOATS_PER_WISP,
  STEAM_INSTANCE_CAPACITY,
  STEAM_MAX_WISPS_PER_VENT,
  STEAM_QUERY_CELL_METERS,
  STEAM_VENT_RANGE_METERS,
  steamClock,
  steamWindFlow,
  steamWispCount,
  VOLCANIC_STEAM_FRAGMENT_WGSL,
  VOLCANIC_STEAM_VERTEX_WGSL,
  VolcanicSteamSystem,
  writeSteamWisps,
  type SteamVentQuery,
} from "../src/render/webgpu/volcanic/VolcanicSteamSystem";
import { createWorld, type WorldDefinition } from "../src/world";
import type { VolcanicVent } from "../src/world/volcanism";

const BASE_WORLD = createWorld("volcanic-steam", { airport: false });

function windWorld(radians: number, speed: number): WorldDefinition {
  return { ...BASE_WORLD, prevailingWindRadians: radians, prevailingWindSpeed: speed };
}

/** A query over a fixed list: centres inside the box, the stub's contract. */
function injected(
  vents: readonly VolcanicVent[],
  calls?: { count: number; outs?: VolcanicVent[][] },
): SteamVentQuery {
  return (_world, minX, minZ, maxX, maxZ, out) => {
    if (calls) {
      calls.count += 1;
      calls.outs?.push(out);
    }
    out.length = 0;
    for (const vent of vents) {
      if (vent.x >= minX && vent.x <= maxX && vent.z >= minZ && vent.z <= maxZ) out.push(vent);
    }
    return out;
  };
}

const flatGround = (x: number, z: number): number => 300 + x * 0.001 + z * 0.002;

/** Enough updates at one camera position for every height sample and the swap. */
function settle(system: VolcanicSteamSystem, x: number, z: number, time = 0): void {
  for (let frame = 0; frame < 16; frame += 1) system.update(x, z, time);
}

/** The clock reading at which wisp `index` is `age` through its cycle. */
function clockForAge(records: Float32Array, index: number, age: number): number {
  const at = index * STEAM_FLOATS_PER_WISP;
  const cycles = records[at + 4]!;
  const phase = records[at + 5]!;
  const offset = ((age - phase) % 1 + 1) % 1;
  return (offset * STEAM_CYCLE_PERIOD_SECONDS) / cycles;
}

const VIGOROUS: VolcanicVent = { x: 1_200, z: -800, radiusMeters: 150, strength: 1, seed: 0x1234 };
const GENTLE: VolcanicVent = { x: -2_500, z: 3_100, radiusMeters: 40, strength: 0.5, seed: 0xbeef };
const COLD: VolcanicVent = { x: 400, z: 600, radiusMeters: 300, strength: 0, seed: 0x77 };

describe("volcanic steam", () => {
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

  it("creates nothing at a wisp cap of 0 — no mesh, no material, no query", () => {
    const calls = { count: 0 };
    const meshes = scene.meshes.length;
    const materials = scene.materials.length;
    const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 0,
      groundHeight: flatGround,
      queryVents: injected([VIGOROUS], calls),
    });
    for (let frame = 0; frame < 8; frame += 1) system.update(VIGOROUS.x, VIGOROUS.z, frame);
    expect(system.hasGpuResources).toBe(false);
    expect(system.mesh).toBeNull();
    expect(system.instanceData).toBeNull();
    expect(system.drawing).toBe(false);
    expect(scene.meshes.length).toBe(meshes);
    expect(scene.materials.length).toBe(materials);
    expect(calls.count).toBe(0);
    system.dispose();
  });

  it("draws nothing and keeps the mesh disabled when no vent is in range", () => {
    // The stub generator and an empty injection both answer "no vents".
    for (const queryVents of [undefined, injected([])]) {
      const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
        maxWisps: 128,
        groundHeight: flatGround,
        ...(queryVents ? { queryVents } : {}),
      });
      // The first frame is the pipeline-priming draw: one collapsed,
      // transparent instance.
      system.update(0, 0, 0);
      expect(system.drawing).toBe(true);
      expect(system.mesh!.forcedInstanceCount).toBe(1);
      expect(Array.from(system.instanceData!.subarray(0, STEAM_FLOATS_PER_WISP))).toEqual(
        new Array(STEAM_FLOATS_PER_WISP).fill(0),
      );
      for (let frame = 1; frame < 30; frame += 1) {
        system.update(frame * 100, 0, frame);
        expect(system.drawing).toBe(false);
        expect(system.mesh!.isEnabled()).toBe(false);
      }
      expect(system.wispCount).toBe(0);
      system.dispose();
    }
  });

  it("turns on only once a vent is within 15 km of the camera", () => {
    const vent: VolcanicVent = { x: 0, z: 0, radiusMeters: 100, strength: 1, seed: 9 };
    const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 128,
      groundHeight: flatGround,
      queryVents: injected([vent]),
    });
    // 15.5 km east: inside the cell's query reach, outside the draw range.
    const far = STEAM_VENT_RANGE_METERS + 500;
    settle(system, far, 0);
    expect(system.ventCount).toBe(1);
    expect(system.drawing).toBe(false);
    // 500 m closer and inside the vent's radius of the range, in the same
    // 2 km cell (14,000-16,000 m), so no re-query either.
    const queries = system.ventQueryCount;
    system.update(STEAM_VENT_RANGE_METERS, 0, 1);
    expect(system.ventQueryCount).toBe(queries);
    expect(system.drawing).toBe(true);
    system.update(far, 0, 2);
    expect(system.drawing).toBe(false);
    system.dispose();
  });

  it("emits strength-scaled wisps from each steaming vent, nearest first, placed on its floor", () => {
    const heights = new Map<string, number>();
    const ground = (x: number, z: number): number => {
      const height = flatGround(x, z);
      heights.set(`${x},${z}`, height);
      return height;
    };
    const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 256,
      groundHeight: ground,
      queryVents: injected([GENTLE, COLD, VIGOROUS]),
    });
    settle(system, 1_000, -500);
    const vigorous = steamWispCount(VIGOROUS);
    const gentle = steamWispCount(GENTLE);
    expect(vigorous).toBe(STEAM_MAX_WISPS_PER_VENT);
    expect(gentle).toBe(5);
    expect(steamWispCount(COLD)).toBe(0);
    expect(system.ventCount).toBe(2);
    expect(system.wispCount).toBe(vigorous + gentle);
    expect(system.mesh!.forcedInstanceCount).toBe(vigorous + gentle);
    expect(system.drawing).toBe(true);
    // The cold vent is never even height-sampled.
    expect(heights.has(`${COLD.x},${COLD.z}`)).toBe(false);

    // The anchor is the camera's 2 km cell centre.
    expect(system.anchorX).toBe(STEAM_QUERY_CELL_METERS / 2);
    expect(system.anchorZ).toBe(-STEAM_QUERY_CELL_METERS / 2);
    const records = system.instanceData!;
    const check = (vent: VolcanicVent, first: number, count: number): void => {
      for (let wisp = first; wisp < first + count; wisp += 1) {
        const at = wisp * STEAM_FLOATS_PER_WISP;
        const x = records[at]! + system.anchorX;
        const z = records[at + 2]! + system.anchorZ;
        expect(Math.hypot(x - vent.x, z - vent.z)).toBeLessThanOrEqual(0.75 * vent.radiusMeters + 1e-3);
        expect(records[at + 1]).toBeCloseTo(flatGround(vent.x, vent.z), 3);
        expect(records[at + 3]).toBeGreaterThan(0);
        expect(records[at + 6]).toBeGreaterThan(0);
        expect(Number.isInteger(records[at + 4])).toBe(true);
      }
    };
    // Nearest the cell centre first: the vigorous vent is ~360 m away.
    check(VIGOROUS, 0, vigorous);
    check(GENTLE, vigorous, gentle);
    system.dispose();
  });

  it("scales number, size and opacity with strength", () => {
    // The same wisp count at both strengths, so the jitter draws are the same
    // and the means compare the strength law alone.
    const mean = (strength: number, lane: number): number => {
      const vent = { ...VIGOROUS, strength };
      const count = STEAM_MAX_WISPS_PER_VENT;
      const out = new Float32Array(count * STEAM_FLOATS_PER_WISP);
      writeSteamWisps(vent, 0, 0, 0, 5, count, out, 0);
      let sum = 0;
      for (let wisp = 0; wisp < count; wisp += 1) sum += out[wisp * STEAM_FLOATS_PER_WISP + lane]!;
      return sum / count;
    };
    let previous = 0;
    for (const strength of [0.1, 0.3, 0.6, 1]) {
      const count = steamWispCount({ ...VIGOROUS, strength });
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
    expect(steamWispCount({ ...VIGOROUS, strength: 0 })).toBe(0);
    expect(steamWispCount({ ...VIGOROUS, strength: -1 })).toBe(0);
    expect(steamWispCount({ ...VIGOROUS, strength: Number.NaN })).toBe(0);
    expect(mean(1, 3)).toBeGreaterThan(mean(0.3, 3) * 1.2);
    expect(mean(1, 6)).toBeGreaterThan(mean(0.3, 6) * 1.2);
    expect(mean(1, 7)).toBeGreaterThan(mean(0.3, 7) * 1.5);
  });

  it("leans downwind: the plume drifts along the wind and turns with it", () => {
    const along = (radians: number, speed: number): { x: number; z: number; rise: number } => {
      const flowX = Math.sin(radians);
      const flowZ = Math.cos(radians);
      const count = steamWispCount(VIGOROUS);
      const records = new Float32Array(count * STEAM_FLOATS_PER_WISP);
      writeSteamWisps(VIGOROUS, 100, VIGOROUS.x, VIGOROUS.z, speed, count, records, 0);
      const young = createSteamWispSample();
      const old = createSteamWispSample();
      let x = 0;
      let z = 0;
      let rise = 0;
      for (let wisp = 0; wisp < count; wisp += 1) {
        sampleSteamWisp(records, wisp, clockForAge(records, wisp, 0.05), flowX, flowZ, speed, young);
        sampleSteamWisp(records, wisp, clockForAge(records, wisp, 0.9), flowX, flowZ, speed, old);
        expect(old.age).toBeCloseTo(0.9, 3);
        x += old.x - young.x;
        z += old.z - young.z;
        rise += old.y - young.y;
      }
      return { x: x / count, z: z / count, rise: rise / count };
    };
    // Towards the east (+X), at 8 m/s.
    const east = along(Math.PI / 2, 8);
    expect(east.rise).toBeGreaterThan(50);
    expect(east.x).toBeGreaterThan(40);
    expect(Math.abs(east.z)).toBeLessThan(east.x * 0.2);
    // Towards the south (-Z): the same plume, turned.
    const south = along(Math.PI, 8);
    expect(south.z).toBeLessThan(-40);
    expect(Math.abs(south.x)).toBeLessThan(-south.z * 0.2);
    // Calm: it climbs and does not travel; a gale bends it over.
    const calm = along(Math.PI / 2, 0);
    expect(Math.abs(calm.x)).toBeLessThan(5);
    const gale = along(Math.PI / 2, 20);
    expect(gale.x).toBeGreaterThan(east.x);
    expect(gale.rise).toBeLessThan(east.rise);
    expect(gale.x / gale.rise).toBeGreaterThan(east.x / east.rise);
  });

  it("reads the wind from the world: the direction it blows towards, and its speed", () => {
    // Clockwise from north, towards: 0 is north (+Z), 90 degrees east (+X).
    const north = steamWindFlow(windWorld(0, 5));
    expect(north.x).toBeCloseTo(0, 12);
    expect(north.z).toBeCloseTo(1, 12);
    const east = steamWindFlow(windWorld(Math.PI / 2, 5));
    expect(east.x).toBeCloseTo(1, 12);
    expect(east.z).toBeCloseTo(0, 12);
    // The world's speed reaches the records: a windier world bends every
    // wisp's rise down by the same law.
    const rises = (speed: number): number[] => {
      const system = new VolcanicSteamSystem(scene, windWorld(Math.PI / 2, speed), {
        maxWisps: 64,
        groundHeight: flatGround,
        queryVents: injected([VIGOROUS]),
      });
      settle(system, VIGOROUS.x, VIGOROUS.z);
      const records = system.instanceData!;
      const out: number[] = [];
      for (let wisp = 0; wisp < system.wispCount; wisp += 1) {
        out.push(records[wisp * STEAM_FLOATS_PER_WISP + 7]!);
      }
      system.dispose();
      return out;
    };
    const calm = rises(0);
    const windy = rises(14);
    expect(windy.length).toBe(calm.length);
    for (let wisp = 0; wisp < calm.length; wisp += 1) {
      expect(windy[wisp]! / calm[wisp]!).toBeCloseTo(0.5, 5);
    }
  });

  it("wraps its clock seamlessly: every wisp's cycle count is a whole number", () => {
    const count = steamWispCount(VIGOROUS);
    const records = new Float32Array(count * STEAM_FLOATS_PER_WISP);
    writeSteamWisps(VIGOROUS, 0, 0, 0, 6, count, records, 0);
    const before = createSteamWispSample();
    const after = createSteamWispSample();
    for (let wisp = 0; wisp < count; wisp += 1) {
      sampleSteamWisp(records, wisp, STEAM_CYCLE_PERIOD_SECONDS - 1e-3, 0, 1, 6, before);
      sampleSteamWisp(records, wisp, STEAM_CYCLE_PERIOD_SECONDS, 0, 1, 6, after);
      const step = Math.abs(after.age - before.age);
      expect(Math.min(step, 1 - step)).toBeLessThan(1e-3);
    }
    expect(steamClock(STEAM_CYCLE_PERIOD_SECONDS * 7 + 12.5)).toBeCloseTo(12.5, 6);
    expect(steamClock(-1)).toBeCloseTo(STEAM_CYCLE_PERIOD_SECONDS - 1, 6);
    expect(steamClock(Number.NaN)).toBe(0);
  });

  it("gives each vent one look from its own seed, whatever else is in range", () => {
    const write = (vent: VolcanicVent, count: number): Float32Array => {
      const out = new Float32Array(count * STEAM_FLOATS_PER_WISP);
      writeSteamWisps(vent, 50, 0, 0, 7, count, out, 0);
      return out;
    };
    const count = steamWispCount(VIGOROUS);
    expect(write(VIGOROUS, count)).toEqual(write(VIGOROUS, count));
    expect(write({ ...VIGOROUS, seed: VIGOROUS.seed + 1 }, count)).not.toEqual(write(VIGOROUS, count));
    // A partial share keeps the first wisps of the vent's own sequence.
    expect(write(VIGOROUS, 5)).toEqual(write(VIGOROUS, count).subarray(0, 5 * STEAM_FLOATS_PER_WISP));

    // Through the system: the vigorous vent alone, then with a nearer vent
    // ahead of it in the instance order. Its records are the same values.
    const nearer: VolcanicVent = { x: 1_050, z: -950, radiusMeters: 60, strength: 0.8, seed: 0x42 };
    const alone = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 256,
      groundHeight: flatGround,
      queryVents: injected([VIGOROUS]),
    });
    const crowded = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 256,
      groundHeight: flatGround,
      queryVents: injected([VIGOROUS, nearer, GENTLE]),
    });
    settle(alone, 1_000, -1_000);
    settle(crowded, 1_000, -1_000);
    const ahead = steamWispCount(nearer);
    expect(crowded.wispCount).toBe(ahead + count + steamWispCount(GENTLE));
    expect(crowded.instanceData!.subarray(
      ahead * STEAM_FLOATS_PER_WISP,
      (ahead + count) * STEAM_FLOATS_PER_WISP,
    )).toEqual(alone.instanceData!.subarray(0, count * STEAM_FLOATS_PER_WISP));
    alone.dispose();
    crowded.dispose();
  });

  it("caps instances at the tier's limit, dropping the farthest vents first", () => {
    const field: VolcanicVent[] = [];
    // In a row east of the cell centre (1 km, 1 km), so nearest is index order.
    for (let index = 0; index < 20; index += 1) {
      field.push({ x: 1_000 + index * 400, z: 1_000, radiusMeters: 160, strength: 1, seed: index + 1 });
    }
    const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 50,
      groundHeight: flatGround,
      queryVents: injected(field),
    });
    settle(system, 900, 900);
    expect(system.wispCount).toBe(50);
    // 24 + 24 from the two nearest, 2 from the third: the first records of its
    // own sequence.
    const third = field[2]!;
    const expected = new Float32Array(2 * STEAM_FLOATS_PER_WISP);
    writeSteamWisps(third, flatGround(third.x, third.z), system.anchorX, system.anchorZ,
      BASE_WORLD.prevailingWindSpeed, 2, expected, 0);
    expect(system.instanceData!.subarray(48 * STEAM_FLOATS_PER_WISP, 50 * STEAM_FLOATS_PER_WISP))
      .toEqual(expected);
    // Clamped to capacity, and 0 tears everything down.
    system.setMaxWisps(100_000);
    settle(system, 900, 900);
    expect(system.wispCount).toBe(STEAM_INSTANCE_CAPACITY);
    system.setMaxWisps(0);
    expect(system.hasGpuResources).toBe(false);
    expect(scene.getMeshByName("volcanic-steam")).toBeNull();
    system.setMaxWisps(64);
    expect(system.hasGpuResources).toBe(true);
    settle(system, 900, 900);
    expect(system.wispCount).toBe(64);
    system.dispose();
    expect(scene.getMeshByName("volcanic-steam")).toBeNull();
  });

  it("re-queries vents only on a 2 km cell change and time-slices the ground samples", () => {
    const calls = { count: 0, outs: [] as VolcanicVent[][] };
    let samples = 0;
    const field: VolcanicVent[] = [];
    for (let index = 0; index < 30; index += 1) {
      field.push({ x: index * 300, z: -index * 200, radiusMeters: 50, strength: 0.7, seed: 100 + index });
    }
    const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 256,
      groundHeight: (x, z) => {
        samples += 1;
        return flatGround(x, z);
      },
      queryVents: injected(field, calls),
    });
    system.update(10, 10, 0);
    expect(calls.count).toBe(1);
    expect(samples).toBe(8);
    // The set is not live until every height is in.
    expect(system.wispCount).toBe(0);
    settle(system, 10, 10);
    expect(samples).toBe(30);
    expect(system.ventCount).toBe(30);
    const records = system.instanceData;
    for (let frame = 0; frame < 500; frame += 1) {
      system.update(10 + frame * 3, 10 + frame * 2, frame / 60);
    }
    expect(calls.count).toBe(1);
    expect(system.instanceData).toBe(records);
    // Crossing into the next cell re-queries once, and only new vents are
    // sampled again (none here: the same 30 are in reach).
    system.update(STEAM_QUERY_CELL_METERS + 10, 10, 10);
    expect(calls.count).toBe(2);
    settle(system, STEAM_QUERY_CELL_METERS + 10, 10);
    expect(calls.count).toBe(2);
    expect(samples).toBe(30);
    // One `out` array, reused by every query.
    expect(calls.outs[1]).toBe(calls.outs[0]);
    system.dispose();
  });

  it("allocates nothing in the per-frame update", () => {
    const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 256,
      groundHeight: flatGround,
      queryVents: injected([VIGOROUS, GENTLE]),
    });
    settle(system, 1_000, -500);
    expect(system.drawing).toBe(true);
    const frames = 20_000;
    const run = (): number => {
      const before = process.memoryUsage().heapUsed;
      for (let frame = 0; frame < frames; frame += 1) {
        system.update(1_000 + (frame % 50), -500, frame / 60);
      }
      return process.memoryUsage().heapUsed - before;
    };
    // Code below the optimising tier boxes doubles (about 16 B a call here, in
    // the harness loop as much as in the update), and when the optimiser takes
    // over is the machine's business: alone it is the fourth run of 20,000,
    // inside the full suite it can be a hundred. So keep running until the
    // optimised code shows, within a budget only an allocation exhausts.
    // Clean means grown by under 32 KB, 1.6 B a call, and it must hold for
    // three runs in a row: one 12-byte object a call is 240 KB a run, and a
    // collection that happens to land a run near zero cannot do it thrice.
    const clean = (grown: number): boolean => grown >= 0 && grown < 32 * 1024;
    const deadline = performance.now() + 20_000;
    let streak = 0;
    let last = Number.NaN;
    while (streak < 3 && performance.now() < deadline) {
      last = run();
      streak = clean(last) ? streak + 1 : 0;
    }
    expect(streak, `last run grew the heap by ${last} B`).toBe(3);
    system.dispose();
  });

  it("draws in the water group after both water surfaces, blended premultiplied, without writing depth", () => {
    const system = new VolcanicSteamSystem(scene, BASE_WORLD, {
      maxWisps: 32,
      groundHeight: flatGround,
      queryVents: injected([VIGOROUS]),
    });
    const mesh = system.mesh!;
    const material = mesh.material as ShaderMaterial;
    expect(mesh.renderingGroupId).toBe(WATER_RENDERING_GROUP_ID);
    expect(mesh.alphaIndex).toBe(2);
    expect(mesh.isPickable).toBe(false);
    expect(material.disableDepthWrite).toBe(true);
    expect(material.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    expect(material.needAlphaBlending()).toBe(true);
    // A non-zero forced count from construction, so the effect compiled at
    // load is the instanced permutation that draws.
    expect(mesh.forcedInstanceCount).toBeGreaterThanOrEqual(1);
    system.dispose();
  });

  it("lights with the cloud model through the shared aerial include", () => {
    const code = VOLCANIC_STEAM_VERTEX_WGSL.replace(/\/\/[^\n]*/g, "");
    for (const call of ["aerialSunTransmittanceAt(", "skyRadiance(", "aerialPerspective(", "aerialMiePhase("]) {
      expect(code).toContain(call);
    }
    const cloud = DEFAULT_VOLUMETRIC_CLOUD_CONFIG;
    expect(code).toContain(`STEAM_FORWARD_G: f32 = ${cloud.forwardPhaseG}`);
    expect(code).toContain(`STEAM_BACKWARD_G: f32 = ${cloud.backwardPhaseG}`);
    expect(code).toContain(`STEAM_BACKWARD_BLEND: f32 = ${cloud.backwardPhaseBlend}`);
    expect(code).toContain(`STEAM_MULTIPLE_SCATTERING: f32 = ${cloud.multipleScatteringFactor}`);
    expect(code).toContain(`STEAM_AMBIENT_STRENGTH: f32 = ${cloud.ambientStrength}`);
    expect(code).toContain("haze.transmittance");
    expect(code).toContain("haze.inScatter");
    const fragment = VOLCANIC_STEAM_FRAGMENT_WGSL.replace(/\/\/[^\n]*/g, "");
    expect(fragment).toContain("textureLoad(steamSceneDepth");
  });
});
