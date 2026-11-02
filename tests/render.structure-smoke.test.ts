import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { InlineStructureMeshBuilder } from "@/src/render/structures/InlineStructureMeshBuilder";
import { structureSetArrays } from "@/src/render/structures/structureMeshArrays";
import {
  STRUCTURE_SMOKE_ARCHETYPES,
  STRUCTURE_SMOKE_RANGE_METERS,
  STRUCTURE_SMOKE_SHARE,
  STRUCTURE_SMOKE_WISPS,
  structureSmokeFlues,
  structureSmokeStrength,
  writeStructureSmokeWisps,
} from "@/src/render/structures/structureSmoke";
import {
  createSteamWispSample,
  sampleSteamWisp,
  STEAM_FLOATS_PER_WISP,
  STEAM_SMOKE_ALBEDO,
  STEAM_SMOKE_SEED_OFFSET,
  VOLCANIC_STEAM_VERTEX_WGSL,
  VolcanicSteamSystem,
  type SteamWispWriter,
} from "@/src/render/webgpu/volcanic/VolcanicSteamSystem";
import { StructureSystem, type StructureSmokeSink } from "@/src/render/webgpu/structures/StructureSystem";
import { STRUCTURE_KIT } from "@/src/world/structures/kit/structureKit";
import { STRUCTURE_STYLE_CLIMATE } from "@/src/world/structures/kit/kitWeathering";
import { STRUCTURE_ARCHETYPES, STRUCTURE_STYLES, type StructureRecord } from "@/src/world/structures/structureRecord";
import { createWorld } from "@/src/world";

/** Chimney smoke (structures S5, High and Ultra): the homes' stoves, as wisps of the steam's draw. */

function record(id: number, x: number, z: number, overrides: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id,
    archetype: "house",
    style: "boreal",
    x,
    z,
    heading: 0.6,
    width: 10,
    depth: 8,
    storeys: 2,
    floorY: 30,
    baseY: 29.4,
    entryY: 29.6,
    foundation: "plinth",
    seed: id,
    settlement: 1,
    settlementKind: "hamlet",
    basalt: false,
    ...overrides,
  };
}

/** A boreal house with a chimney that smokes. */
function smokingHouse(x: number, z: number, from = 1): StructureRecord {
  for (let id = from; ; id += 1) {
    const r = record(id, x, z, { seed: id * 7 + 3 });
    if (structureSmokeStrength(r) > 0 && STRUCTURE_KIT.drawn(r, "block").chimneys.length > 0) return r;
  }
}

describe("chimney smoke", () => {
  it("comes from homes' stoves, a share by climate, the same buildings every time", () => {
    for (const archetype of STRUCTURE_ARCHETYPES) {
      if (!STRUCTURE_SMOKE_ARCHETYPES.has(archetype)) expect(structureSmokeStrength(record(5, 0, 0, { archetype }))).toBe(0);
    }
    for (const style of STRUCTURE_STYLES) {
      let smoking = 0;
      const n = 4_000;
      for (let id = 1; id <= n; id += 1) {
        const strength = structureSmokeStrength(record(id, 0, 0, { style }));
        if (strength > 0) {
          smoking += 1;
          expect(strength).toBeGreaterThanOrEqual(0.5);
          expect(strength).toBeLessThanOrEqual(1);
        }
      }
      expect(Math.abs(smoking / n - STRUCTURE_SMOKE_SHARE[STRUCTURE_STYLE_CLIMATE[style]])).toBeLessThan(0.03);
    }
    expect(structureSmokeStrength(record(77, 0, 0))).toBe(structureSmokeStrength(record(77, 500, 900)));
  });

  it("leaves from the kit's flue, the same at every level, over the stack or the stovepipe", () => {
    let masonry = 0;
    let pipes = 0;
    for (let id = 1; id < 120; id += 1) {
      const house = record(id, 0, 0, { seed: id * 31 + 7, style: id % 2 ? "boreal" : "desert" });
      const flues = STRUCTURE_KIT.drawn(house, "block").chimneys;
      expect(STRUCTURE_KIT.drawn(house, "closed").chimneys).toEqual(flues);
      expect(STRUCTURE_KIT.drawn(house, "open").chimneys).toEqual(flues);
      if (flues.length === 0) continue;
      expect(flues).toHaveLength(1);
      // Above the roof, inside the footprint.
      const flue = flues[0]!;
      expect(flue.y).toBeGreaterThan(5);
      expect(Math.abs(flue.x)).toBeLessThan(house.width / 2);
      expect(Math.abs(flue.z)).toBeLessThan(house.depth / 2);
      // The closed shell has geometry right under it: the stack's cap or the pipe's collar.
      const { opaque } = structureSetArrays("near", [house], 0, 0, false);
      const c = Math.cos(house.heading);
      const s = Math.sin(house.heading);
      const wx = flue.x * c + flue.z * s;
      const wz = -flue.x * s + flue.z * c;
      let below = Infinity;
      for (let v = 0; v < opaque.positions.length; v += 3) {
        const dx = opaque.positions[v]! - wx;
        const dz = opaque.positions[v + 2]! - wz;
        const dy = house.floorY + flue.y - opaque.positions[v + 1]!;
        if (Math.hypot(dx, dz) < 0.5 && dy >= -1e-4) below = Math.min(below, dy);
      }
      expect(below).toBeLessThan(0.25);
      if (flue.y > 7.5) masonry += 1;
      else pipes += 1;
    }
    expect(masonry + pipes).toBeGreaterThan(20);
  });

  it("is carried out of a set build with each flue's building", () => {
    const a = smokingHouse(1_000, 2_000);
    const b = record(9_999, 1_050, 2_000, { archetype: "barn" });
    const build = structureSetArrays("far", [b, a], 900, 1_900);
    const flues = structureSmokeFlues(build.chimneys, [b, a], 900, 1_900);
    expect(flues).toHaveLength(1);
    const own = STRUCTURE_KIT.drawn(a, "block").chimneys[0]!;
    const c = Math.cos(a.heading);
    const s = Math.sin(a.heading);
    expect(flues[0]!.x).toBeCloseTo(a.x + own.x * c + own.z * s, 3);
    expect(flues[0]!.z).toBeCloseTo(a.z - own.x * s + own.z * c, 3);
    expect(flues[0]!.y).toBeCloseTo(a.floorY + own.y, 3);
  });

  it("rises off the flue, bends downwind and is drawn grey", () => {
    const flue = { x: 5_000, y: 42, z: -3_000, strength: 1, seed: 1234 };
    const calm = new Float32Array(STRUCTURE_SMOKE_WISPS * STEAM_FLOATS_PER_WISP);
    const windy = new Float32Array(STRUCTURE_SMOKE_WISPS * STEAM_FLOATS_PER_WISP);
    writeStructureSmokeWisps(flue, 4_000, -2_000, 0, STRUCTURE_SMOKE_WISPS, calm, 0);
    writeStructureSmokeWisps(flue, 4_000, -2_000, 8, STRUCTURE_SMOKE_WISPS, windy, 0);
    const sample = createSteamWispSample();
    for (let wisp = 0; wisp < STRUCTURE_SMOKE_WISPS; wisp += 1) {
      const at = wisp * STEAM_FLOATS_PER_WISP;
      expect(calm[at]).toBe(1_000);
      expect(calm[at + 1]).toBe(42);
      expect(calm[at + 2]).toBe(-1_000);
      expect(calm[at + 8]).toBeGreaterThanOrEqual(STEAM_SMOKE_SEED_OFFSET);
      expect(windy[at + 7]).toBeLessThan(calm[at + 7]!);
      // Half way through its life, a puff is metres above the flue, a few metres across.
      const lifetime = 960 / calm[at + 4]!;
      const time = ((0.5 - calm[at + 5]! + 1) % 1) * lifetime;
      sampleSteamWisp(calm, wisp, time, 1, 0, 0, sample);
      expect(sample.age).toBeCloseTo(0.5, 3);
      expect(sample.y - 42).toBeGreaterThan(5);
      expect(sample.sizeMeters).toBeGreaterThan(0.5);
      expect(sample.sizeMeters).toBeLessThan(3.5);
      // With wind it is carried off downwind.
      sampleSteamWisp(windy, wisp, time, 1, 0, 8, sample);
      expect(sample.x - 1_000).toBeGreaterThan(5);
      // It leaves the flue at once, so the plume stays joined to the chimney:
      // a few per cent into its life a puff is already at full strength.
      const early = ((0.05 - calm[at + 5]! + 1) % 1) * lifetime;
      sampleSteamWisp(calm, wisp, early, 1, 0, 0, sample);
      expect(sample.alpha).toBeGreaterThan(0.9 * calm[at + 6]!);
      expect(sample.y - 42).toBeLessThan(2);
    }
    // The shader greys a smoke wisp (its seed flag) and only those.
    expect(VOLCANIC_STEAM_VERTEX_WGSL).toContain(`let smoke = recordC.x >= ${STEAM_SMOKE_SEED_OFFSET}.0;`);
    expect(VOLCANIC_STEAM_VERTEX_WGSL).toContain("select(vec3f(1.0), STEAM_SMOKE_ALBEDO, smoke)");
    expect(Math.max(...STEAM_SMOKE_ALBEDO)).toBeLessThan(0.7);
  });

  it("rides the steam's draw after the vents', within its cap, with no vent near", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("volcanic-steam", { airport: false });
    const steam = new VolcanicSteamSystem(scene, world, {
      maxWisps: 20,
      groundHeight: () => 0,
      queryVents: (_w, _a, _b, _c, _d, out) => {
        out.length = 0;
        return out;
      },
    });
    for (let frame = 0; frame < 4; frame += 1) steam.update(0, 0, frame);
    expect(steam.drawing).toBe(false);
    const flue = { x: 300, y: 12, z: 400, strength: 1, seed: 9 };
    const writer: SteamWispWriter = (ax, az, wind, out, offset) => {
      for (let i = 0; i < 4; i += 1) writeStructureSmokeWisps(flue, ax, az, wind, STRUCTURE_SMOKE_WISPS, out, offset + i * STRUCTURE_SMOKE_WISPS * STEAM_FLOATS_PER_WISP);
    };
    steam.setExtraWisps(4 * STRUCTURE_SMOKE_WISPS, writer);
    // 24 asked for, 20 allowed.
    expect(steam.extraWispCount).toBe(20);
    steam.update(0, 0, 5);
    expect(steam.drawing).toBe(true);
    expect(steam.mesh!.forcedInstanceCount).toBe(20);
    const records = steam.instanceData!;
    expect(records[8]).toBeGreaterThanOrEqual(STEAM_SMOKE_SEED_OFFSET);
    steam.setExtraWisps(0, null);
    steam.update(0, 0, 6);
    expect(steam.extraWispCount).toBe(0);
    expect(steam.drawing).toBe(false);
    steam.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("is chosen near the camera from the far set, on the tiers that smoke", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const calls: number[] = [];
    const sink: StructureSmokeSink = { setExtraWisps: (count) => calls.push(count) };
    for (const smoke of [true, false]) {
      calls.length = 0;
      const system = new StructureSystem(scene, {
        structureNearRadiusMeters: 400,
        structureFarRadiusMeters: 3_000,
        structureOpenBuildings: 0,
        structureNearCastsShadows: false,
        structureTextureEdge: 0,
        structureLampPoints: 0,
        structureChimneySmoke: smoke,
      }, new InlineStructureMeshBuilder(), null);
      system.setSmoke(sink);
      const near1 = smokingHouse(300, 0);
      const near2 = smokingHouse(600, 200, near1.id + 1);
      const far = smokingHouse(2_500, 0, near2.id + 1);
      system.apply([{ key: "settlements:0:0", structures: [near1, near2, far] }], []);
      for (let frame = 0; frame < 6; frame += 1) {
        system.update({ x: 0, y: 50, z: 0 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // The two within 1.5 km smoke; the one at 2.5 km does not.
      expect(calls.at(-1)).toBe(smoke ? 2 * STRUCTURE_SMOKE_WISPS : 0);
      expect(system.smokingChimneys).toBe(smoke ? 2 : 0);
      if (smoke) {
        // Flying on towards the far one: chosen again past 100 m, and it joins.
        system.update({ x: 2_500 - STRUCTURE_SMOKE_RANGE_METERS + 100, y: 50, z: 0 });
        expect(system.smokingChimneys).toBe(3);
      }
      system.dispose();
      expect(calls.at(-1)).toBe(0);
    }
    scene.dispose();
    engine.dispose();
  });
});
