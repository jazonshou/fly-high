import { describe, expect, it } from "vitest";
import {
  STRUCTURE_CLIMATES,
  STRUCTURE_STYLE_CLIMATE,
  STRUCTURE_UNWEATHERED,
  STRUCTURE_WEAR_STEPS,
  structureWeatherCode,
  structureWeathering,
  weatherColour,
  type StructureWeathering,
} from "@/src/world/structures/kit/kitWeathering";
import { StructureMeshBuilder } from "@/src/world/structures/kit/kitMesh";
import { STRUCTURE_KIT } from "@/src/world/structures/kit/structureKit";
import { STRUCTURE_ARCHETYPES, STRUCTURE_STYLES, SETTLEMENT_KINDS, type StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * Weathering (Jason, 2026-11-01: buildings should "look more weathered and
 * lived in"): each building's wear from its id, its kind of place and its
 * archetype, its climate from its style, and its outdoor colours aged by
 * both, paint faded, white paint dulled, wood silvered, roofs darkened,
 * rooms and glazing left alone.
 */

function record(id: number, overrides: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, archetype: "house", style: "temperate", x: 0, z: 0, heading: 0, width: 10, depth: 8, storeys: 2,
    floorY: 0, baseY: -0.5, entryY: -0.3, foundation: "plinth", seed: id, settlement: 1,
    settlementKind: "hamlet", basalt: false, ...overrides,
  };
}

const luminance = (rgb: readonly number[]) => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
const saturation = (rgb: readonly number[]) => Math.max(...rgb) - Math.min(...rgb);

describe("the buildings' weathering", () => {
  it("gives every building its own wear, in steps, worse at outposts and on working buildings, and its style's climate", () => {
    for (const style of STRUCTURE_STYLES) expect(STRUCTURE_CLIMATES).toContain(STRUCTURE_STYLE_CLIMATE[style]);
    const mean = (overrides: Partial<StructureRecord>) => {
      let sum = 0;
      for (let id = 1; id <= 400; id += 1) {
        const weathering = structureWeathering(record(id * 7919, overrides));
        expect(weathering.wear).toBeGreaterThanOrEqual(0.1 - 1e-9);
        expect(weathering.wear).toBeLessThanOrEqual(1);
        expect(weathering.wear * STRUCTURE_WEAR_STEPS).toBeCloseTo(Math.round(weathering.wear * STRUCTURE_WEAR_STEPS), 9);
        sum += weathering.wear;
      }
      return sum / 400;
    };
    expect(mean({ settlementKind: "outpost" })).toBeGreaterThan(mean({ settlementKind: "hamlet" }) + 0.1);
    expect(mean({ archetype: "barn" })).toBeGreaterThan(mean({ archetype: "house" }) + 0.1);
    // Every combination is a valid code, and a copy of a record weathers the same.
    for (const archetype of STRUCTURE_ARCHETYPES) {
      for (const settlementKind of SETTLEMENT_KINDS) {
        const code = structureWeatherCode(structureWeathering(record(5, { archetype, settlementKind })));
        expect(Number.isInteger(code) && code >= 0 && code < 64).toBe(true);
      }
    }
    expect(structureWeathering(record(42))).toEqual(structureWeathering({ ...record(42) }));
    expect(structureWeathering(record(42, { style: "desert" })).climate).toBe("dry");
    expect(structureWeatherCode(STRUCTURE_UNWEATHERED)).toBe(0);
  });

  it("fades paint, dulls white paint rather than whitening it, silvers wood and darkens roofs, and leaves glazing alone", () => {
    const worn: StructureWeathering = { wear: 1, climate: "damp", seed: 99 };
    const out: [number, number, number] = [0, 0, 0];
    const age = (rgb: readonly number[], surface: Parameters<typeof weatherColour>[3], weathering = worn) =>
      [...weatherColour(rgb[0]!, rgb[1]!, rgb[2]!, surface, 0x123456, weathering, out)];
    const red = [0.5, 0.06, 0.04];
    expect(saturation(age(red, "clapboard"))).toBeLessThan(saturation(red) * 0.8);
    const white = [0.85, 0.85, 0.82];
    expect(luminance(age(white, "trim"))).toBeLessThan(luminance(white) * 0.8);
    const brown = [0.3, 0.15, 0.06];
    const wood = age(brown, "logs");
    expect(saturation(wood)).toBeLessThan(saturation(brown) * 0.7);
    const roof = [0.25, 0.08, 0.05];
    expect(luminance(age(roof, "tile"))).toBeLessThan(luminance(roof));
    for (const surface of ["window", "doorway", "glass", "plaster", "floor", "fabric"] as const) {
      expect(age(red, surface)).toEqual(red);
    }
    // As new, nothing changes.
    expect(age(red, "clapboard", STRUCTURE_UNWEATHERED)).toEqual(red);
    // A dry climate bleaches paint harder than a damp one.
    const dry = age(red, "clapboard", { wear: 1, climate: "dry", seed: 99 });
    expect(saturation(dry)).toBeLessThan(saturation(age(red, "clapboard")));
  });

  it("ages the outside of a building in the mesh and never its rooms, and one colour alike across its parts", () => {
    const house = record(7, { settlementKind: "outpost" });
    const weathering = structureWeathering(house);
    const drawn = STRUCTURE_KIT.drawn(house, "open");
    const plain = new StructureMeshBuilder();
    plain.append(house, drawn.parts);
    const aged = new StructureMeshBuilder();
    aged.append(house, drawn.parts, undefined, undefined, weathering);
    const a = plain.finish();
    const b = aged.finish();
    expect(b.vertices).toBe(a.vertices);
    let outsideChanged = 0;
    const byColour = new Map<string, string>();
    for (let v = 0; v < a.vertices; v += 1) {
      const before = `${a.colour[v * 3]},${a.colour[v * 3 + 1]},${a.colour[v * 3 + 2]}|${a.surface[v]}`;
      const after = `${b.colour[v * 3]},${b.colour[v * 3 + 1]},${b.colour[v * 3 + 2]}`;
      if (a.indoor[v]! > 0) {
        expect(after).toBe(before.split("|")[0]);
        continue;
      }
      if (after !== before.split("|")[0]) outsideChanged += 1;
      // Parts of one colour and surface age alike.
      if (byColour.has(before)) expect(byColour.get(before)).toBe(after);
      else byColour.set(before, after);
    }
    expect(outsideChanged).toBeGreaterThan(a.vertices * 0.2);
  });
});
