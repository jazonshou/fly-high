import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { KIT_STRUCTURE_ARRAYS } from "@/src/render/structures/InlineStructureMeshBuilder";
import {
  STRUCTURE_LAMP_KIND,
  STRUCTURE_LAMP_NEVER,
  STRUCTURE_LAMP_RGB,
  STRUCTURE_LAMP_STEPS,
  STRUCTURE_NIGHT_OFF,
  STRUCTURE_SCENE_UNIT_TO_NITS,
  STRUCTURE_WORK_LIT_SHARE,
  structureLampLit,
  structureLampThreshold,
  structureLitFraction,
  structureNightLighting,
} from "@/src/render/structures/structureNightLighting";
import {
  STRUCTURE_CODE_LAMP_SPAN,
  STRUCTURE_CODE_STRIDE,
  STRUCTURE_WEATHER_CODES,
  decodeStructureSurfaceCode,
  structureSurfaceCode,
} from "@/src/render/structures/structureSurfaceCode";
import { SCENE_UNIT_TO_NITS } from "@/src/render/webgpu/nature/EnvironmentDirector";
import { structureWeatherCode, structureWeathering } from "@/src/world/structures/kit/kitWeathering";
import { STRUCTURE_MATERIAL_WGSL, type StructureMaterialPlugin } from "@/src/render/webgpu/structures/StructureMaterialPlugin";
import { StructureSystem, type StructureMeshBuilder } from "@/src/render/webgpu/structures/StructureSystem";
import { STRUCTURE_SURFACES } from "@/src/world/structures/structureModel";
import { STRUCTURE_ARCHETYPES, type StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The buildings' lights at night (structures S5): who is home by the clock,
 * lit only once it is dark, each building's threshold carried on its
 * vertices for the vertex stage to compare with the share, and the
 * photometry in real units.
 */

function record(id: number, x: number, z: number, overrides: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id,
    archetype: "house",
    style: "temperate",
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

describe("the buildings' lights by the clock", () => {
  it("are on in most homes through the evening, fewer late, a few before dawn, about half by day", () => {
    expect(structureLitFraction(20)).toBeCloseTo(0.85, 6);
    expect(structureLitFraction(3)).toBeLessThan(0.12);
    expect(structureLitFraction(3)).toBeGreaterThan(0.05);
    expect(structureLitFraction(12)).toBeGreaterThan(0.4);
    expect(structureLitFraction(12)).toBeLessThan(0.55);
    // Continuous across midnight, and the clock wraps.
    expect(structureLitFraction(23.999)).toBeCloseTo(structureLitFraction(0), 3);
    expect(structureLitFraction(-4)).toBeCloseTo(structureLitFraction(20), 9);
    expect(structureLitFraction(44)).toBeCloseTo(structureLitFraction(20), 9);
    expect(structureLitFraction(Number.NaN)).toBe(0);
  });

  it("light only once it is dark, by the lamps' daylight law, in the sun's own scene units", () => {
    expect(STRUCTURE_SCENE_UNIT_TO_NITS).toBe(SCENE_UNIT_TO_NITS);
    expect(structureNightLighting(20, 0)).toBe(STRUCTURE_NIGHT_OFF);
    expect(structureNightLighting(Number.NaN, 1)).toBe(STRUCTURE_NIGHT_OFF);
    const night = structureNightLighting(20, 1);
    expect(night.litFraction).toBe(Math.fround(0.85));
    // 60 cd/m² of window and 120 lux on a room's surfaces.
    expect(night.windowScene * SCENE_UNIT_TO_NITS).toBeCloseTo(60, 9);
    expect(night.lampScene * Math.PI * SCENE_UNIT_TO_NITS).toBeCloseTo(120, 9);
    const dusk = structureNightLighting(20, 0.25);
    expect(dusk.windowScene).toBeCloseTo(night.windowScene * 0.25, 12);
    // A dark winter afternoon has its lights on too: the share by day is about half.
    expect(structureNightLighting(15, 1).litFraction).toBeGreaterThan(0.4);
    // Warm, at unit luminance.
    const [r, g, b] = STRUCTURE_LAMP_RGB;
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(1, 12);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it("give every building a threshold from its id: homes spread over the share, work buildings a quarter, props never, the lighthouse always", () => {
    for (const archetype of STRUCTURE_ARCHETYPES) expect(STRUCTURE_LAMP_KIND[archetype]).toBeDefined();
    const homes: number[] = [];
    const work: number[] = [];
    for (let id = 1; id <= 4000; id += 1) {
      const home = structureLampThreshold({ id: id * 7919, archetype: "house" });
      const barn = structureLampThreshold({ id: id * 7919, archetype: "barn" });
      // Exact multiples of the step, inside [0, never]: exact in a float32 vertex attribute.
      for (const threshold of [home, barn]) {
        expect(threshold * STRUCTURE_LAMP_STEPS).toBe(Math.round(threshold * STRUCTURE_LAMP_STEPS));
        expect(threshold).toBeGreaterThanOrEqual(0);
        expect(threshold).toBeLessThanOrEqual(STRUCTURE_LAMP_NEVER);
      }
      homes.push(home);
      work.push(barn);
    }
    const share = (thresholds: number[], litFraction: number) => thresholds.filter((t) => structureLampLit(t, litFraction)).length / thresholds.length;
    expect(share(homes, 0.85)).toBeGreaterThan(0.82);
    expect(share(homes, 0.85)).toBeLessThan(0.88);
    expect(share(homes, 0.1)).toBeGreaterThan(0.08);
    expect(share(homes, 0.1)).toBeLessThan(0.12);
    expect(share(work, 0.85)).toBeCloseTo(0.85 * STRUCTURE_WORK_LIT_SHARE, 1);
    // Monotone: a building lit at a share stays lit at every higher share.
    expect(homes.every((t) => !structureLampLit(t, 0.3) || structureLampLit(t, 0.6))).toBe(true);
    expect(structureLampThreshold({ id: 5, archetype: "mast" })).toBe(STRUCTURE_LAMP_NEVER);
    expect(structureLampThreshold({ id: 5, archetype: "windmill" })).toBe(STRUCTURE_LAMP_NEVER);
    expect(structureLampLit(STRUCTURE_LAMP_NEVER, 1)).toBe(false);
    expect(structureLampThreshold({ id: 5, archetype: "lighthouse" })).toBe(0);
    expect(structureLampLit(0, structureLitFraction(3))).toBe(true);
  });
});

describe("the surface codes on the buildings' vertices", () => {
  it("pack the id, the lamp threshold and the weather exactly in a float32, at every extreme", () => {
    const largest = structureSurfaceCode(STRUCTURE_CODE_STRIDE - 1, STRUCTURE_LAMP_NEVER, STRUCTURE_WEATHER_CODES - 1);
    expect(largest).toBeLessThan(2 ** 24);
    for (const id of [0, 7, STRUCTURE_CODE_STRIDE - 1]) {
      for (const threshold of [0, 1 / STRUCTURE_LAMP_STEPS, 0.5, 1, STRUCTURE_LAMP_NEVER]) {
        for (const weather of [0, 1, 37, STRUCTURE_WEATHER_CODES - 1]) {
          const code = structureSurfaceCode(id, threshold, weather);
          expect(Math.fround(code)).toBe(code);
          expect(decodeStructureSurfaceCode(code)).toEqual({ id, lampThreshold: threshold, weather });
        }
      }
    }
    expect(STRUCTURE_CODE_LAMP_SPAN).toBe(STRUCTURE_LAMP_STEPS * STRUCTURE_LAMP_NEVER + 1);
    expect(() => structureSurfaceCode(STRUCTURE_CODE_STRIDE, 0, 0)).toThrow(RangeError);
    expect(() => structureSurfaceCode(0, 0, STRUCTURE_WEATHER_CODES)).toThrow(RangeError);
  });

  it("carry each building's threshold and weather over its surface ids, on every opaque vertex and no glass", () => {
    const house = record(11, 100, 50);
    const barn = record(12, -40, 300, { archetype: "barn", storeys: 1 });
    const mast = record(13, 300, -80, { archetype: "mast", width: 3, depth: 3, storeys: 1 });
    expect(STRUCTURE_SURFACES.length).toBeLessThan(STRUCTURE_CODE_STRIDE);
    for (const set of ["far", "near", "open"] as const) {
      const { opaque, glass } = KIT_STRUCTURE_ARRAYS(set, [house, barn, mast], 0, 0);
      for (let v = 0; v < opaque.surface.length; v += 1) {
        const x = opaque.centre[v * 2]!;
        const building = [house, barn, mast].find((r) => Math.abs(r.x - x) < 1e-3)!;
        const decoded = decodeStructureSurfaceCode(opaque.surface[v]!);
        expect(Number.isInteger(decoded.id) && decoded.id >= 0 && decoded.id < STRUCTURE_SURFACES.length).toBe(true);
        expect(decoded.lampThreshold).toBe(structureLampThreshold(building));
        expect(decoded.weather).toBe(structureWeatherCode(structureWeathering(building)));
      }
      if (glass) expect(glass.surface.every((code) => code < STRUCTURE_CODE_STRIDE)).toBe(true);
    }
    // Unweathered (the shots' "before"): the lamp threshold alone.
    const { opaque } = KIT_STRUCTURE_ARRAYS("near", [house], 0, 0, false);
    expect(new Set([...opaque.surface].map((code) => decodeStructureSurfaceCode(code).weather))).toEqual(new Set([0]));
  });

  it("are decoded and compared in the vertex stage, and lit faces glow at the window, the doorway and indoors", () => {
    const vertex = STRUCTURE_MATERIAL_WGSL.vertexUpdatePosition;
    expect(vertex).toContain(`floor((vertexInputs.structureSurface + 0.5) / ${STRUCTURE_CODE_STRIDE}.0)`);
    expect(vertex).toContain(`floor((structureTotal + 0.5) / ${STRUCTURE_CODE_LAMP_SPAN}.0)`);
    expect(vertex).toContain(`structureSteps / ${STRUCTURE_LAMP_STEPS}.0 < uniforms.structureNight.x`);
    // The glass role (3) never lights.
    expect(vertex).toContain("(structureRole < 2.5)");
    const final = STRUCTURE_MATERIAL_WGSL.fragmentBeforeFinalColor;
    expect(final).toContain("finalEmissive +=");
    expect(final).toContain(`structureSurfaceCode - ${STRUCTURE_SURFACES.indexOf("window")}.0`);
    expect(final).toContain(`structureSurfaceCode - ${STRUCTURE_SURFACES.indexOf("doorway")}.0`);
    // The window layer's glass is the mask on the textured tiers.
    expect(STRUCTURE_MATERIAL_WGSL.fragmentBeforeLights).toContain(
      `if (structureId == ${STRUCTURE_SURFACES.indexOf("window")}u) { structureGlassMask = structureDetailTexel.a; }`,
    );
  });

  it("weather only the outside of a weathered building, never its windows or doorways, finer terms fading with distance", () => {
    const lights = STRUCTURE_MATERIAL_WGSL.fragmentBeforeLights;
    expect(lights).toContain(`floor((fragmentInputs.structureUvSurfaceShareV.z + 0.5) / ${2 * STRUCTURE_CODE_STRIDE}.0)`);
    expect(lights).toContain("if (structureWear > 0.0 && fragmentInputs.structureColourIndoorV.a <= 0.001 && !structureFitted) {");
    expect(lights).toContain("let structureFine = 1.0 - smoothstep(0.05, 0.22, structureFootprint);");
    // The UV's gradients are taken on every tier, before anything can discard.
    const begin = STRUCTURE_MATERIAL_WGSL.fragmentMainBegin;
    expect(begin.indexOf("dpdx(fragmentInputs.structureUvSurfaceShareV.xy)")).toBeLessThan(begin.indexOf("#ifdef STRUCTURE_TEXTURED"));
    expect(begin.indexOf("dpdx(fragmentInputs.structureUvSurfaceShareV.xy)")).toBeLessThan(begin.indexOf("{ discard; }"));
  });

  it("are lit by the night the system hands every role", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const builder: StructureMeshBuilder = {
      build: () => new Promise(() => {}),
      textures: () => new Promise(() => {}),
      dispose: () => {},
    };
    const system = new StructureSystem(scene, {
      structureNearRadiusMeters: 400,
      structureFarRadiusMeters: 4_000,
      structureOpenBuildings: 4,
      structureNearCastsShadows: false,
      structureTextureEdge: 0,
    }, builder, null);
    const plugins = system.materials.map((m) => m.pluginManager!.getPlugin("structure-surface") as StructureMaterialPlugin);
    expect(plugins).toHaveLength(4);
    expect(plugins.every((plugin) => plugin.night === STRUCTURE_NIGHT_OFF)).toBe(true);
    const night = structureNightLighting(21, 1);
    system.setNight(night);
    expect(plugins.every((plugin) => plugin.night === night)).toBe(true);
    system.dispose();
    scene.dispose();
    engine.dispose();
  });
});
