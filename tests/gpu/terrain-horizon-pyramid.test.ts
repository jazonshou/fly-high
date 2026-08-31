import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { TerrainClipmapSystem } from "../../src/render/webgpu/terrain/TerrainClipmapSystem";
import { createWorld, sampleTerrainHeight } from "../../src/world";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import {
  HORIZON_FIELD_AZIMUTHS_MARCHED,
  HORIZON_FIELD_AZIMUTHS_STORED,
  HORIZON_FIELD_MARCH_STEPS,
} from "../../src/render/webgpu/terrain/HorizonField";
import {
  TERRAIN_HEIGHT_PYRAMID_EDGE,
  TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
  TERRAIN_HORIZON_PYRAMID_EDGE,
  TERRAIN_HORIZON_PYRAMID_TEXEL_METERS,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { hashSeed } from "../../src/world/seed";

/**
 * `6-11`'s correctness gate: the GLOBAL horizon field.
 *
 * The design's whole claim is that far vegetation and near terrain run ONE
 * horizon operator, so the thing worth testing is not "the dispatch ran" but
 * "the dispatch computed the operator". This file therefore carries a CPU
 * oracle of the same march — the house's measured-criteria parity doctrine
 * (`D-3`) — rather than a self-consistency check that a broken bake could
 * also pass.
 *
 * A green compile would give you none of these: an all-zero field (the bake
 * never landed), a constant field (a broken world->texel mapping), and a field
 * marched with the azimuths transposed all compile perfectly.
 */

const SEED_HASH = hashSeed("horizon-pyramid");
/** Somewhere with relief, and far from the origin so world-scale ids are real. */
const OBSERVER_X = 41_000;
const OBSERVER_Z = -27_500;
const REACH_METERS = 45_000;

async function withScene<T>(run: (engine: WebGPUEngine, scene: Scene) => Promise<T>): Promise<T> {
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
    return await run(engine, scene);
  } finally {
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

/** The composition hole, on the CPU: clamped nearest load of the height pyramid. */
function heightAt(
  heights: Float32Array,
  originX: number,
  originZ: number,
  worldX: number,
  worldZ: number,
): number {
  const clamp = (value: number) =>
    Math.min(TERRAIN_HEIGHT_PYRAMID_EDGE - 1, Math.max(0, Math.floor(value)));
  const texelX = clamp((worldX - originX) / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
  const texelZ = clamp((worldZ - originZ) / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
  return heights[texelZ * TERRAIN_HEIGHT_PYRAMID_EDGE + texelX]!;
}

/**
 * The oracle: `horizonFieldMarch` + `horizonFieldPack`, transliterated.
 *
 * Deliberately written from the WGSL's shape rather than shared with it — a
 * transliteration that imported the answer would assert nothing.
 */
function oracleHorizon(
  heights: Float32Array,
  originX: number,
  originZ: number,
  worldX: number,
  worldZ: number,
): number[] {
  const centreHeight = heightAt(heights, originX, originZ, worldX, worldZ);
  const growth = Math.pow(
    REACH_METERS / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
    1 / (HORIZON_FIELD_MARCH_STEPS - 1),
  );
  const slopes: number[] = [];
  for (let azimuth = 0; azimuth < HORIZON_FIELD_AZIMUTHS_MARCHED; azimuth += 1) {
    const angle = (azimuth + 0.5) * ((Math.PI * 2) / HORIZON_FIELD_AZIMUTHS_MARCHED);
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    let maxSlope = 0;
    let radius = TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
    for (let step = 0; step < HORIZON_FIELD_MARCH_STEPS; step += 1) {
      const sampled = heightAt(
        heights, originX, originZ, worldX + dirX * radius, worldZ + dirZ * radius);
      maxSlope = Math.max(maxSlope, (sampled - centreHeight) / radius);
      radius *= growth;
    }
    slopes.push(maxSlope);
  }
  const stored: number[] = [];
  for (let index = 0; index < HORIZON_FIELD_AZIMUTHS_STORED; index += 1) {
    const slope = Math.max(slopes[index * 2]!, slopes[index * 2 + 1]!);
    stored.push(slope / Math.sqrt(1 + slope * slope));
  }
  return stored;
}

interface Baked {
  readonly heights: Float32Array;
  readonly horizonA: Uint8Array;
  readonly horizonB: Uint8Array;
  readonly originX: number;
  readonly originZ: number;
}

async function bakeGlobalHorizon(): Promise<Baked> {
  return withScene(async (engine, scene) => {
    const pyramid = new GlobalHeightPyramid(scene, engine, SEED_HASH);
    await pyramid.recenter(OBSERVER_X, OBSERVER_Z);
    expect(pyramid.isResident).toBe(true);
    // Before any horizon bake the field must read NOT resident, so a consumer
    // has something unambiguous to fall back on.
    expect(pyramid.isHorizonResident).toBe(false);
    expect(pyramid.needsHorizonBake).toBe(true);

    expect(await pyramid.bakeHorizon()).toBe(true);
    expect(pyramid.isHorizonResident).toBe(true);
    // Idempotent: nothing moved, so nothing is owed.
    expect(pyramid.needsHorizonBake).toBe(false);
    expect(await pyramid.bakeHorizon()).toBe(false);

    const heights = await pyramid.heightTexture!.readPixels() as Float32Array;
    const horizonA = await pyramid.horizonTextureA!.readPixels() as Uint8Array;
    const horizonB = await pyramid.horizonTextureB!.readPixels() as Uint8Array;
    const result: Baked = {
      heights,
      horizonA,
      horizonB,
      originX: pyramid.horizonOriginX,
      originZ: pyramid.horizonOriginZ,
    };
    pyramid.dispose();
    return result;
  });
}

/** The eight stored azimuths at a horizon texel, decoded from the two layers. */
function storedAt(baked: Baked, texelX: number, texelZ: number): number[] {
  const offset = (texelZ * TERRAIN_HORIZON_PYRAMID_EDGE + texelX) * 4;
  return [
    baked.horizonA[offset]! / 255,
    baked.horizonA[offset + 1]! / 255,
    baked.horizonA[offset + 2]! / 255,
    baked.horizonA[offset + 3]! / 255,
    baked.horizonB[offset]! / 255,
    baked.horizonB[offset + 1]! / 255,
    baked.horizonB[offset + 2]! / 255,
    baked.horizonB[offset + 3]! / 255,
  ];
}

describe("global horizon pyramid (6-11)", () => {
  it("spans exactly what the height pyramid spans", () => {
    // The consumer maps world -> texel by one divide against a published
    // origin. A span mismatch would shear that mapping silently.
    expect(TERRAIN_HORIZON_PYRAMID_EDGE * TERRAIN_HORIZON_PYRAMID_TEXEL_METERS)
      .toBe(TERRAIN_HEIGHT_PYRAMID_EDGE * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
  });

  it("marches the same operator the page bake does, to rgba8 quantisation", async () => {
    const baked = await bakeGlobalHorizon();

    // The field must not be all-zero (bake never landed) or constant (a broken
    // world->texel mapping reads one texel everywhere). Both compile.
    const centre = storedAt(baked, 64, 64);
    const values: number[] = [];
    for (let texel = 16; texel < 112; texel += 8) {
      values.push(...storedAt(baked, texel, texel));
    }
    const spread = Math.max(...values) - Math.min(...values);
    expect(centre.some((value) => value > 0)).toBe(true);
    expect(spread).toBeGreaterThan(0.02);

    // The parity criterion. rgba8 quantises to 1/255 = 0.0039, and the GPU
    // rounds f32 where the oracle accumulates in f64, so the bound is the
    // quantisation step plus a rounding allowance — measured, not conceded.
    const tolerance = 1 / 255 + 1e-3;
    let worst = 0;
    let compared = 0;
    for (let texelZ = 12; texelZ < TERRAIN_HORIZON_PYRAMID_EDGE - 12; texelZ += 11) {
      for (let texelX = 12; texelX < TERRAIN_HORIZON_PYRAMID_EDGE - 12; texelX += 11) {
        const worldX = baked.originX
          + (texelX + 0.5) * TERRAIN_HORIZON_PYRAMID_TEXEL_METERS;
        const worldZ = baked.originZ
          + (texelZ + 0.5) * TERRAIN_HORIZON_PYRAMID_TEXEL_METERS;
        const expected = oracleHorizon(baked.heights, baked.originX, baked.originZ, worldX, worldZ);
        const actual = storedAt(baked, texelX, texelZ);
        for (let index = 0; index < HORIZON_FIELD_AZIMUTHS_STORED; index += 1) {
          worst = Math.max(worst, Math.abs(expected[index]! - actual[index]!));
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(400);
    expect(worst, `worst |gpu - oracle| over ${compared} stored azimuths`)
      .toBeLessThan(tolerance);
  });

  it("ARMS through the real pump, under streaming competition", async () => {
    // The failure this exists for: every other test in this file drives
    // `bakeHorizon()` directly. None of them proves the renderer ever CALLS
    // it. The bake is admitted through `ComputeBudget`'s `occlusionCompute`
    // row, which it shares with the page/splat bakes, and during a cold spawn
    // that row is saturated by page streaming — so a term that is correct,
    // compiled and bound can still never arm, and would ship as a feature
    // that silently does nothing while its unit tests stay green.
    //
    // This drives the same real chain `terrain-streaming-convergence` does and
    // asserts the field becomes RESIDENT, i.e. an admission was actually won
    // and a dispatch completed, with page demand competing for the same row.
    const field = await withScene(async (engine, scene) => {
      void engine;
      const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const system = new TerrainClipmapSystem(scene, world, profile);
      const spawnX = world.airport?.centerX ?? 0;
      const spawnZ = world.airport?.centerZ ?? 0;
      const observer = {
        x: spawnX,
        y: sampleTerrainHeight(world, spawnX, spawnZ) + 250,
        z: spawnZ,
        velocityX: 0,
        velocityZ: 0,
        pixelsPerMeterAtUnitDistance: 720 / (2 * Math.tan((60 * Math.PI) / 360)),
      };
      let armedAtFrame = -1;
      let snapshot: TerrainClipmapSystem["globalHorizonField"] = null;
      for (let frame = 1; frame <= 400; frame += 1) {
        system.update(observer, frame);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const current = system.globalHorizonField;
        if (current && armedAtFrame < 0) {
          armedAtFrame = frame;
          snapshot = current;
        }
      }
      const result = { armedAtFrame, snapshot: snapshot ?? system.globalHorizonField };
      system.dispose();
      return result;
    });

    expect(
      field.snapshot,
      "the global horizon field never became resident under the real pump — the "
      + "far-field term would compile out and ship doing nothing",
    ).not.toBeNull();
    // Early, not eventually: it must arm while the capture is still settling,
    // or the first frames of every session are silently unshadowed.
    expect(field.armedAtFrame).toBeGreaterThan(0);
    expect(field.armedAtFrame).toBeLessThan(200);
    expect(Number.isFinite(field.snapshot!.originX)).toBe(true);
    expect(Number.isFinite(field.snapshot!.originZ)).toBe(true);
    expect(field.snapshot!.spanMeters).toBe(
      TERRAIN_HORIZON_PYRAMID_EDGE * TERRAIN_HORIZON_PYRAMID_TEXEL_METERS);
  }, 240_000);

  it("puts the horizon on the side the terrain is actually higher", async () => {
    const baked = await bakeGlobalHorizon();
    // An azimuth-indexing or origin-sign bug survives every check above: the
    // field would still be non-degenerate and still match an oracle that
    // shares the same bug. It cannot survive this one, which reads the height
    // field directly and asks whether the horizon points at the high ground.
    //
    // Stored azimuth s covers marched pair (2s, 2s+1), centred on
    // s*pi/4 + pi/8 — so s=0 looks +X/+Z-ish and s=4 looks the opposite way.
    let checked = 0;
    let agreed = 0;
    for (let texelZ = 20; texelZ < TERRAIN_HORIZON_PYRAMID_EDGE - 20; texelZ += 7) {
      for (let texelX = 20; texelX < TERRAIN_HORIZON_PYRAMID_EDGE - 20; texelX += 7) {
        const worldX = baked.originX
          + (texelX + 0.5) * TERRAIN_HORIZON_PYRAMID_TEXEL_METERS;
        const worldZ = baked.originZ
          + (texelZ + 0.5) * TERRAIN_HORIZON_PYRAMID_TEXEL_METERS;
        const stored = storedAt(baked, texelX, texelZ);
        // Compare the two opposed stored azimuths with the strongest contrast.
        for (let index = 0; index < 4; index += 1) {
          const opposite = index + 4;
          const delta = stored[index]! - stored[opposite]!;
          if (Math.abs(delta) < 0.05) continue;
          const angle = (index * 2 + 1) * (Math.PI / HORIZON_FIELD_AZIMUTHS_MARCHED);
          // Probe well beyond one texel so the answer is about relief, not noise.
          const probe = 6 * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
          const here = heightAt(baked.heights, baked.originX, baked.originZ, worldX, worldZ);
          const toward = heightAt(
            baked.heights, baked.originX, baked.originZ,
            worldX + Math.cos(angle) * probe, worldZ + Math.sin(angle) * probe) - here;
          const away = heightAt(
            baked.heights, baked.originX, baked.originZ,
            worldX - Math.cos(angle) * probe, worldZ - Math.sin(angle) * probe) - here;
          if (Math.abs(toward - away) < 30) continue;
          checked += 1;
          if (Math.sign(delta) === Math.sign(toward - away)) agreed += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    // Not 100%: a 45 km march can be dominated by a ridge far outside the
    // 6-texel probe, which is the field working correctly rather than a fault.
    expect(agreed / checked, `${agreed}/${checked} azimuth pairs point at the high ground`)
      .toBeGreaterThan(0.75);
  });
});
