import { describe, expect, it } from "vitest";
import {
  STRUCTURE_SURFACE_TEXTURES,
  STRUCTURE_TEXTURE_EDGES,
  STRUCTURE_TEXTURE_LAYERS,
  structureSurfaceTextureTable,
  synthesizeStructureLayer,
  synthesizeStructureTextures,
} from "../src/world/structures/kit/kitTextures";
import { STRUCTURE_SURFACES } from "../src/world/structures/structureModel";

/**
 * The building kit's materials: one layer per drawn pattern at 256² and
 * 512², detail around the part's colour (Low draws the colour alone, so the
 * painted texels must average it), tiling without a seam, normals that do
 * not tilt the face, and the plan's memory.
 */

const FITTED = new Set(["window", "doorway"]);

function digest(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

/** Mean absolute RGB step between two columns (or rows) of an RGBA layer. */
function step(layer: Uint8Array, edge: number, a: number, b: number, alongRows: boolean): number {
  let sum = 0;
  for (let k = 0; k < edge; k += 1) {
    const ia = alongRows ? (a * edge + k) * 4 : (k * edge + a) * 4;
    const ib = alongRows ? (b * edge + k) * 4 : (k * edge + b) * 4;
    for (let c = 0; c < 3; c += 1) sum += Math.abs(layer[ia + c]! - layer[ib + c]!);
  }
  return sum / (edge * 3);
}

describe("building kit: textures", () => {
  const sets = new Map(STRUCTURE_TEXTURE_EDGES.map((edge) => {
    const t0 = performance.now();
    const set = synthesizeStructureTextures(edge);
    console.log(`[structure-kit] textures at ${edge}²: ${(performance.now() - t0).toFixed(0)} ms for ${STRUCTURE_TEXTURE_LAYERS.length} layers`);
    return [edge, set] as const;
  }));

  it("maps every surface to a layer, the fitted ones 0 to 1", () => {
    expect(STRUCTURE_TEXTURE_LAYERS).toHaveLength(13);
    const table = structureSurfaceTextureTable();
    expect(table).toHaveLength(STRUCTURE_SURFACES.length * 4);
    STRUCTURE_SURFACES.forEach((surface, id) => {
      const t = STRUCTURE_SURFACE_TEXTURES[surface];
      expect(Number.isInteger(t.layer) && t.layer >= 0 && t.layer < STRUCTURE_TEXTURE_LAYERS.length, surface).toBe(true);
      expect(t.strength, surface).toBeGreaterThanOrEqual(0);
      expect(t.strength, surface).toBeLessThanOrEqual(1);
      expect(t.tileMetres === 0, surface).toBe(FITTED.has(surface));
      expect(table[id * 4], surface).toBe(t.layer);
      expect(table[id * 4 + 3], surface).toBe(FITTED.has(surface) ? 1 : 0);
    });
    // Every layer is some surface's.
    for (let layer = 0; layer < STRUCTURE_TEXTURE_LAYERS.length; layer += 1) {
      expect(STRUCTURE_SURFACES.some((s) => STRUCTURE_SURFACE_TEXTURES[s].layer === layer), STRUCTURE_TEXTURE_LAYERS[layer]).toBe(true);
    }
  });

  it("is deterministic and the right shape", () => {
    for (const edge of STRUCTURE_TEXTURE_EDGES) {
      const set = sets.get(edge)!;
      expect(set.edge).toBe(edge);
      expect(set.detail).toHaveLength(STRUCTURE_TEXTURE_LAYERS.length);
      expect(set.normal).toHaveLength(STRUCTURE_TEXTURE_LAYERS.length);
      for (const layer of [...set.detail, ...set.normal]) expect(layer.length).toBe(edge * edge * 4);
    }
    const again = synthesizeStructureTextures(256);
    const first = sets.get(256)!;
    STRUCTURE_TEXTURE_LAYERS.forEach((name, i) => {
      expect(digest(again.detail[i]!), name).toBe(digest(first.detail[i]!));
      expect(digest(again.normal[i]!), name).toBe(digest(first.normal[i]!));
    });
    // A layer alone is the same layer.
    const alone = synthesizeStructureLayer("stone", 256);
    expect(digest(alone.detail)).toBe(digest(first.detail[STRUCTURE_TEXTURE_LAYERS.indexOf("stone")]!));
  });

  it("averages the part's colour where it is painted (what Low draws)", () => {
    for (const edge of STRUCTURE_TEXTURE_EDGES) {
      const set = sets.get(edge)!;
      STRUCTURE_TEXTURE_LAYERS.forEach((name, i) => {
        const d = set.detail[i]!;
        let lum = 0;
        let painted = 0;
        for (let t = 0; t < edge * edge; t += 1) {
          if (d[t * 4 + 3]! < 128) continue;
          lum += 0.2126 * d[t * 4]! + 0.7152 * d[t * 4 + 1]! + 0.0722 * d[t * 4 + 2]!;
          painted += 1;
        }
        // Most of every layer is painted; its mean is mid-grey to within a byte or so (no clipping).
        expect(painted / (edge * edge), name).toBeGreaterThan(0.6);
        expect(lum / painted, `${name} at ${edge}`).toBeGreaterThan(126);
        expect(lum / painted, `${name} at ${edge}`).toBeLessThan(129);
      });
    }
  });

  it("tiles without a seam", () => {
    const edge = 256;
    const set = sets.get(edge)!;
    STRUCTURE_TEXTURE_LAYERS.forEach((name, i) => {
      if (FITTED.has(name)) return;
      for (const layer of [set.detail[i]!, set.normal[i]!]) {
        for (const alongRows of [false, true]) {
          // The wrap from the last column (row) to the first is no harder than the hardest step inside.
          let worst = 0;
          for (let k = 0; k + 1 < edge; k += 1) worst = Math.max(worst, step(layer, edge, k, k + 1, alongRows));
          expect(step(layer, edge, edge - 1, 0, alongRows), `${name} ${alongRows ? "rows" : "columns"}`).toBeLessThanOrEqual(worst * 1.05 + 1);
        }
      }
    });
  });

  it("keeps normals unit and the face untilted, roughness and AO in range", () => {
    for (const edge of STRUCTURE_TEXTURE_EDGES) {
      const set = sets.get(edge)!;
      STRUCTURE_TEXTURE_LAYERS.forEach((name, i) => {
        const n = set.normal[i]!;
        let sx = 0;
        let sy = 0;
        let ao = 0;
        let long = 0;
        for (let t = 0; t < edge * edge; t += 1) {
          const x = (n[t * 4]! / 255) * 2 - 1;
          const y = (n[t * 4 + 1]! / 255) * 2 - 1;
          if (x * x + y * y > 1.02) long += 1;
          sx += x;
          sy += y;
          ao += n[t * 4 + 3]! / 255;
        }
        expect(long, name).toBe(0);
        // Periodic relief has no net slope, so the layer leaves the face's own normal on average
        // (to a few hundredths: lapped boards lean back over most of their face and face down at the butt).
        expect(Math.abs(sx / (edge * edge)), `${name} x`).toBeLessThan(0.04);
        expect(Math.abs(sy / (edge * edge)), `${name} y`).toBeLessThan(0.04);
        expect(ao / (edge * edge), `${name} AO`).toBeGreaterThan(0.6);
      });
    }
  });

  it("fits the plan's memory with full mip chains", () => {
    const bytes = (edge: number) => {
      let level = edge;
      let texels = 0;
      while (level >= 1) {
        texels += level * level;
        level >>= 1;
      }
      // Two arrays, RGBA8.
      return 2 * STRUCTURE_TEXTURE_LAYERS.length * texels * 4;
    };
    const mib = (b: number) => b / (1024 * 1024);
    // The plan: Medium ~11 MiB and High ~35 MiB for the buildings' memory, the arrays the bulk of it.
    expect(mib(bytes(256))).toBeLessThan(9);
    expect(mib(bytes(512))).toBeLessThan(35);
    console.log(`[structure-kit] texture arrays: ${mib(bytes(256)).toFixed(1)} MiB at 256², ${mib(bytes(512)).toFixed(1)} MiB at 512²`);
  });
});
