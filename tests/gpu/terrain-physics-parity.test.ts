import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  TERRAIN_HEIGHT_PARITY_CRITERIA,
  TERRAIN_HEIGHT_SLOT_EDGE,
  terrainTexelSizeMeters,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
} from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { sampleGroundContact, sampleGroundHeight } from "../../src/sim/terrainGrid";
import { createWorld } from "../../src/world";

/**
 * Assertion 76 — the §1.3 invariant's GPU half, against the REAL height atlas.
 *
 * Its Node-side sibling is `sim.terrain-authority.test.ts`'s assertion 77.
 * Duplicated rather than moved: `npm run verify` does not run this project, so
 * a move would delete the invariant from CI. What each half can see is
 * different, and both are needed — Node proves the two kernels are the same
 * FUNCTION at L0, and this proves the surface actually written into the atlas
 * is that function's values.
 *
 * The normal half is new. Nothing asserted that collision NORMALS match render
 * normals, and `4-4` is the item that could have broken them: `sampleTerrainNormal`
 * is a 2 m central difference, and the render surface is now the page's own
 * texel grid — which at L0 is exactly 2 m, and at no other level is.
 */

const PAGE = createWorldPageAddress(0, 6, -3);

describe("terrain page / physics parity (4-4, 4-9)", () => {
  it("matches the physics authority in height and in normal at L0", async () => {
    const world = createWorld("terrain-physics-parity");
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    let scene: Scene | null = null;
    try {
      await engine.initAsync();
      engine.runRenderLoop(() => {});
      scene = new Scene(engine);
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const atlas = new TerrainPageAtlas(scene, profile, {
        kind: "height",
        worldRevision: "physics-parity",
      });
      const generator = new TerrainPageGenerator(
        engine,
        atlas,
        world.seedHash,
        world.airport ?? null,
      );
      atlas.residency.beginFrame(1);
      const request = atlas.residency.request(invariantSlotKey(PAGE), PAGE)!;
      await generator.generate([request.slot]);
      const origin = atlas.slotOrigin(request.slot.slotIndex);
      const heights = await atlas.texture()!.readPixels(
        0, 0, undefined, true, false,
        origin.u, origin.v, TERRAIN_HEIGHT_SLOT_EDGE, TERRAIN_HEIGHT_SLOT_EDGE,
      ) as Float32Array;
      generator.dispose();
      atlas.dispose();

      const texel = terrainTexelSizeMeters(0);
      // The collision normal is a 2 m central difference, and the L0 page's
      // texel spacing IS 2 m — the one level where the two grids coincide.
      expect(texel).toBe(2);
      const originX = PAGE.x * WORLD_PAGE_BASE_EXTENT_METERS;
      const originZ = PAGE.z * WORLD_PAGE_BASE_EXTENT_METERS;
      const at = (column: number, row: number): number =>
        heights[(row + WORLD_PAGE_GUTTER) * TERRAIN_HEIGHT_SLOT_EDGE + column + WORLD_PAGE_GUTTER]!;

      let worstHeight = 0;
      let worstNormalDegrees = 0;
      let compared = 0;
      for (let row = 4; row < 252; row += 9) {
        for (let column = 4; column < 252; column += 9) {
          const x = originX + column * texel;
          const z = originZ + row * texel;
          worstHeight = Math.max(worstHeight, Math.abs(at(column, row) - sampleGroundHeight(world, x, z)));

          // The page's own central difference, at the same 2 m footprint the
          // collision solver uses.
          const gradientX = (at(column + 1, row) - at(column - 1, row)) / (2 * texel);
          const gradientZ = (at(column, row + 1) - at(column, row - 1)) / (2 * texel);
          const inverse = 1 / Math.hypot(gradientX, 1, gradientZ);
          const page = [-gradientX * inverse, inverse, -gradientZ * inverse] as const;
          const contact = sampleGroundContact(world, x, z, {
            height: 0,
            normal: { x: 0, y: 1, z: 0 },
            isRunway: false,
            friction: 0.86,
          });
          const dot = page[0] * contact.normal.x + page[1] * contact.normal.y
            + page[2] * contact.normal.z;
          worstNormalDegrees = Math.max(
            worstNormalDegrees,
            (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI,
          );
          compared += 1;
        }
      }
      console.log(
        `L0 page vs physics over ${compared} texels: max |Δh| = `
        + `${(worstHeight * 1_000).toFixed(3)} mm, max normal angle = `
        + `${worstNormalDegrees.toFixed(3)}°`,
      );
      expect(compared).toBeGreaterThan(700);
      expect(worstHeight).toBeLessThan(TERRAIN_HEIGHT_PARITY_CRITERIA.physicsToleranceMeters);
      // A degree of disagreement is the wheels feeling a slope the screen does
      // not show. The two differences are over the same 2 m footprint of the
      // same surface, so what is left is f32 accumulation, not a model gap.
      expect(worstNormalDegrees).toBeLessThan(1);
    } finally {
      scene?.dispose();
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 240_000);
});
