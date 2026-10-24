import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import {
  GROUND_GRAIN_CHANNEL_STD,
  GROUND_GRAIN_LAYER,
  surfaceArrayLayerIds,
  synthesizeGroundGrainLayer,
  synthesizeSurfaceArrayLayer,
} from "../src/render/webgpu/terrain/GroundGrainSynthesis";
import { synthesizeSurfaceMaterial } from "../src/render/webgpu/terrain/MaterialArraySynthesis";
import { SURFACE_MATERIALS } from "../src/render/webgpu/terrain/surfaceMaterials";
import { planMippedTextureArray } from "../src/render/webgpu/core/TextureArrayMips";
import { TOKSVIG_ROUGHNESS_GAIN } from "../src/render/webgpu/terrain/MaterialArraySynthesis";
import {
  DEFAULT_ANISOTROPY_LIMIT,
  GROUND_GRAIN_ANISOTROPY_LIMIT,
  GROUND_GRAIN_GAINS,
  GROUND_GRAIN_RELIEF_FADE,
  GROUND_GRAIN_SCALES,
  GROUND_GRAIN_SEABED_FADE,
  GROUND_GRAIN_TONE_FADE,
} from "../src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * The ground grain: a texture layer the terrain reads at three world scales
 * so the ground has structure at the pixel from every flying height. What has
 * to be true for that to add detail WITHOUT moving the scene's colour or
 * drawing a seam is checked here; what it looks like is the screenshots' job.
 */

const EDGE = 128;
const SEED = "fly-high";
const layer = synthesizeGroundGrainLayer(SEED, EDGE);

function channel(bytes: Uint8Array, index: number): number[] {
  const out: number[] = [];
  for (let texel = 0; texel < bytes.length / 4; texel += 1) out.push(bytes[texel * 4 + index]!);
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

describe("the grain layer's place in the arrays", () => {
  it("sits directly after every material, and only when asked for", () => {
    expect(GROUND_GRAIN_LAYER).toBe(SURFACE_MATERIALS.length);
    const without = surfaceArrayLayerIds(false, true);
    const withGrain = surfaceArrayLayerIds(true, true);
    expect(without).toEqual(SURFACE_MATERIALS.map((spec) => spec.id));
    expect(withGrain).toEqual([...without, GROUND_GRAIN_LAYER]);
    // A grain array keeps the volcanic layers whatever the tier says, because
    // the grain's index follows them.
    expect(surfaceArrayLayerIds(true, false)).toEqual(withGrain);
    // Material ids are their own layer indices, which is what lets the
    // shader's layer index and the worker's id be the same number.
    SURFACE_MATERIALS.forEach((spec, index) => expect(spec.id).toBe(index));
  });

  it("dispatches by id: a material id still builds that material", () => {
    const viaDispatch = synthesizeSurfaceArrayLayer(SURFACE_MATERIALS[0]!.id, SEED, 16);
    const direct = synthesizeSurfaceMaterial(SURFACE_MATERIALS[0]!.id, SEED, 16);
    expect(viaDispatch.albedoHeight).toEqual(direct.albedoHeight);
    expect(synthesizeSurfaceArrayLayer(GROUND_GRAIN_LAYER, SEED, 16).albedoHeight)
      .toEqual(synthesizeGroundGrainLayer(SEED, 16).albedoHeight);
  });
});

describe("the grain is a pure, tiling, mean-neutral field", () => {
  it("is a pure function of (seed, edge)", () => {
    const again = synthesizeGroundGrainLayer(SEED, EDGE);
    expect(again.albedoHeight).toEqual(layer.albedoHeight);
    expect(again.normalMaterial).toEqual(layer.normalMaterial);
    const other = synthesizeGroundGrainLayer("another-seed", EDGE);
    expect(other.albedoHeight).not.toEqual(layer.albedoHeight);
  });

  it("centres every albedo-array channel on 0.5", () => {
    // THE PROPERTY THE SHADER RELIES ON. The box mip chain converges each
    // channel to its mean, and the shader reads 0.5 as "no change": a channel
    // off-centre would tint every cover at range by its offset times its gain.
    for (let index = 0; index < 4; index += 1) {
      expect(Math.abs(mean(channel(layer.albedoHeight, index)) - 127.5), `channel ${index}`)
        .toBeLessThan(1);
    }
  });

  it("converges to 0.5 at the 1x1 mip, through the shipped box kernel", () => {
    const plan = planMippedTextureArray([layer.albedoHeight], EDGE, "box");
    const tail = plan.layerChains[0]![plan.mipLevelCount - 1]!;
    for (let index = 0; index < 4; index += 1) {
      expect(Math.abs(tail[index]! - 127.5), `channel ${index}`).toBeLessThanOrEqual(1.5);
    }
    // And the normal array reduces to a flat normal (Toksvig).
    const normals = planMippedTextureArray([layer.normalMaterial], EDGE, {
      kind: "toksvig",
      roughnessGain: TOKSVIG_ROUGHNESS_GAIN,
    });
    const flat = normals.layerChains[0]![normals.mipLevelCount - 1]!;
    expect(Math.abs(flat[0]! - 127.5)).toBeLessThanOrEqual(2);
    expect(Math.abs(flat[1]! - 127.5)).toBeLessThanOrEqual(2);
  });

  it("carries the contrast it was asked for (non-vacuous)", () => {
    // Without this, a flat 0.5 layer passes every test above.
    const targets = [
      GROUND_GRAIN_CHANNEL_STD.tone,
      GROUND_GRAIN_CHANNEL_STD.moisture,
      GROUND_GRAIN_CHANNEL_STD.clumps,
      GROUND_GRAIN_CHANNEL_STD.height,
    ];
    targets.forEach((target, index) => {
      const measured = std(channel(layer.albedoHeight, index)) / 255;
      expect(measured, `channel ${index}`).toBeGreaterThan(target * 0.75);
      expect(measured, `channel ${index}`).toBeLessThan(target * 1.1);
    });
    expect(std(channel(layer.normalMaterial, 0))).toBeGreaterThan(10);
  });

  it("has no seam at the wrap", () => {
    // The layer repeats across the whole world at three scales; a seam would
    // be a line every 26 m. Neighbour differences ACROSS the wrap must look
    // like neighbour differences anywhere else.
    const tone = channel(layer.albedoHeight, 0);
    const at = (x: number, y: number) => tone[y * EDGE + x]!;
    let interior = 0;
    let seam = 0;
    for (let y = 0; y < EDGE; y += 1) {
      seam += Math.abs(at(0, y) - at(EDGE - 1, y)) + Math.abs(at(y, 0) - at(y, EDGE - 1));
      interior += Math.abs(at(EDGE / 2, y) - at(EDGE / 2 - 1, y))
        + Math.abs(at(y, EDGE / 2) - at(y, EDGE / 2 - 1));
    }
    expect(seam).toBeLessThan(interior * 1.6);
  });
});

describe("the shader reads the grain safely", () => {
  const plugin = readSource("src/render/webgpu/terrain/TerrainSurfacePlugin.ts");

  it("reads the layer only behind its uniform switch", () => {
    // tuning.z is 1 exactly when the bound arrays carry the layer; a build
    // without it must never read past the ten materials.
    const gate = plugin.indexOf("if (uniforms.terrainSurfaceTuning.z > 0.5) {");
    const firstFetch = plugin.indexOf("terrainGroundGrainFetch(\n      terrainGrainUv0");
    expect(gate).toBeGreaterThan(-1);
    expect(firstFetch).toBeGreaterThan(gate);
    expect(plugin).toContain("setArrays(albedoHeight: BaseTexture, normalMaterial: BaseTexture, groundGrain = false)");
    expect(plugin).toContain("this.groundGrain = groundGrain ? 1 : 0;");
    expect(/"terrainSurfaceTuning",[\s\S]{0,400}this\.groundGrain,/.test(plugin)).toBe(true);
  });

  it("lands after the macro wash and before the runway paint", () => {
    const wash = plugin.indexOf("terrainAlbedo *= terrainMacroVariation * terrainMacroHue;");
    const grain = plugin.indexOf("${GROUND_GRAIN_COMPOSITE_WGSL}");
    const runway = plugin.indexOf("terrainRunwaySurface(\n  terrainAbsolutePosition");
    expect(wash).toBeGreaterThan(-1);
    expect(grain).toBeGreaterThan(wash);
    expect(runway).toBeGreaterThan(grain);
  });

  it("skips each fetch where it could not show, and fades into the skip", () => {
    // Every fetch sits behind its own share: a zero share costs no read, and
    // a skipped scale reads as zero, which the composite takes as no change.
    for (const index of [0, 1, 2]) {
      const branch = plugin.indexOf(`if (terrainGrainShare${index} > 0.0) {`);
      const fetch = plugin.indexOf(`terrainGroundGrainFetch(\n      terrainGrainUv${index}`);
      expect(branch).toBeGreaterThan(-1);
      expect(fetch).toBeGreaterThan(branch);
    }
    for (const index of [0, 1]) {
      const branch = plugin.indexOf(`if (terrainGrainRelief${index} > 0.0) {`);
      const fetch = plugin.indexOf(`terrainGroundGrainGradient(\n      terrainGrainUv${index}`);
      expect(branch).toBeGreaterThan(-1);
      expect(fetch).toBeGreaterThan(branch);
    }
    // The relief flattens in the mips long before the tone does, so it goes
    // first; both fades are ramps, not cuts, so nothing pops at the boundary.
    expect(GROUND_GRAIN_RELIEF_FADE.start).toBeLessThan(GROUND_GRAIN_RELIEF_FADE.end);
    expect(GROUND_GRAIN_RELIEF_FADE.end).toBeLessThan(GROUND_GRAIN_TONE_FADE.start);
    expect(GROUND_GRAIN_TONE_FADE.start).toBeLessThan(GROUND_GRAIN_TONE_FADE.end);
    // Past one period per footprint the layer's last mip is its mean.
    expect(GROUND_GRAIN_TONE_FADE.end).toBeLessThan(1);
    // Under the sea, by the still water level the wetness block also reads.
    expect(GROUND_GRAIN_SEABED_FADE.start).toBeLessThan(GROUND_GRAIN_SEABED_FADE.end);
    expect(plugin).toContain("uniforms.terrainSurfaceWetness.y - terrainAbsolutePosition.y);");
  });

  it("measures the footprint the sampler's mip choice follows", () => {
    // Area over the major axis: the minor axis of the (limited) footprint.
    expect(plugin).toContain(
      "return abs(ddx.x * ddy.y - ddx.y * ddy.x) / max(major, 1e-9);",
    );
    const footprint = (dx: readonly [number, number], dy: readonly [number, number]) =>
      Math.abs(dx[0] * dy[1] - dx[1] * dy[0]) / Math.max(Math.hypot(...dx), Math.hypot(...dy));
    // An axis-aligned 1 x 8 footprint: the minor axis is 1.
    expect(footprint([1, 0], [0, 8])).toBeCloseTo(1, 12);
    // A circle stays its radius at any rotation.
    expect(footprint([0.6, 0.8], [-0.8, 0.6])).toBeCloseTo(1, 12);
  });

  it("mottles the distant canopy the handoff paints", () => {
    expect(plugin).toContain("vec3f(${TERRAIN_CANOPY_ALBEDO}) * terrainGrainCanopy");
  });

  it("samples with explicit gradients, limited to the grain's own anisotropy", () => {
    // House rule since 2-8: any sample under a branch carries explicit
    // gradients. The grain's fetches go through the materials' limiter, at
    // a lower cap: the extra taps only resolve zero-mean noise along the line
    // of sight, and they were most of the grain's cost. At 1 the reads are
    // isotropic, one filtered tap each.
    expect(GROUND_GRAIN_ANISOTROPY_LIMIT).toBeLessThan(DEFAULT_ANISOTROPY_LIMIT);
    expect(GROUND_GRAIN_ANISOTROPY_LIMIT).toBeGreaterThanOrEqual(1);
    // Limited once, in world space, then carried through each scale's frame
    // (a rotation times a uniform scale, which keeps the ratio).
    expect(plugin).toContain(
      "terrainSurfaceLimitAnisotropyTo(\n    worldDdx, worldDdy, ${GROUND_GRAIN_ANISOTROPY_LIMIT.toFixed(1)});",
    );
    expect(plugin).toContain(
      "let terrainGrainLimited = terrainGroundGrainLimit(terrainWorldDdx.xz, terrainWorldDdy.xz);",
    );
    expect(plugin).toContain(
      "textureSampleGrad(terrainSurfaceAlbedo, terrainSurfaceAlbedoSampler,\n    uv, ${GROUND_GRAIN_LAYER}, frame * ddx, frame * ddy);",
    );
    expect(plugin).toContain(
      "textureSampleGrad(terrainSurfaceNormal, terrainSurfaceNormalSampler,\n    uv, ${GROUND_GRAIN_LAYER}, frame * ddx, frame * ddy);",
    );
    // The materials keep the full cap: only the grain is coarsened.
    expect(plugin).toContain(
      "return terrainSurfaceLimitAnisotropyTo(ddx, ddy, ${DEFAULT_ANISOTROPY_LIMIT.toFixed(1)});",
    );
  });

  it("limiting once in world space equals limiting each scale's footprint", () => {
    // The WGSL limiter, transcribed: inflate the shorter axis until the
    // ratio is within the cap. Each scale's frame is a rotation times a
    // uniform scale, so it commutes with the limiter; that is what lets one
    // limit in world space serve all five fetches.
    type V = readonly [number, number];
    const len = (v: V) => Math.hypot(v[0], v[1]);
    const limit = (dx: V, dy: V, cap: number): [V, V] => {
      const lx = Math.max(len(dx), 1e-8);
      const ly = Math.max(len(dy), 1e-8);
      const minor = Math.max(lx, ly) / cap;
      const sx = Math.max(1, minor / lx);
      const sy = Math.max(1, minor / ly);
      return [[dx[0] * sx, dx[1] * sx], [dy[0] * sy, dy[1] * sy]];
    };
    for (const scale of GROUND_GRAIN_SCALES) {
      const a = (scale.rotationDegrees * Math.PI) / 180;
      const k = 1 / scale.periodMeters;
      // Column-major like WGSL's mat2x2f(cos, sin, -sin, cos).
      const frame = (v: V): V => [
        k * (Math.cos(a) * v[0] - Math.sin(a) * v[1]),
        k * (Math.sin(a) * v[0] + Math.cos(a) * v[1]),
      ];
      for (const [dx, dy] of [
        [[0.4, 0.1], [0.3, 9.5]],
        [[2.0, -0.3], [0.05, 0.02]],
        [[1.0, 1.0], [-1.0, 1.0]],
      ] as [V, V][]) {
        const once = limit(dx, dy, GROUND_GRAIN_ANISOTROPY_LIMIT).map(frame);
        const each = limit(frame(dx), frame(dy), GROUND_GRAIN_ANISOTROPY_LIMIT);
        for (let axis = 0; axis < 2; axis += 1) {
          for (let c = 0; c < 2; c += 1) {
            expect(once[axis]![c]!).toBeCloseTo(each[axis]![c]!, 12);
          }
        }
      }
    }
  });

  it("uses three incommensurate scales and keeps snow nearly untouched", () => {
    const periods = GROUND_GRAIN_SCALES.map((scale) => scale.periodMeters);
    expect(periods).toHaveLength(3);
    for (let index = 1; index < periods.length; index += 1) {
      const ratio = periods[index]! / periods[index - 1]!;
      expect(ratio).toBeGreaterThan(4);
      // Not a power of two, so no two lattices line up.
      expect(Math.abs(Math.log2(ratio) - Math.round(Math.log2(ratio)))).toBeGreaterThan(0.1);
    }
    expect(GROUND_GRAIN_GAINS.tone.snow).toBeLessThan(GROUND_GRAIN_GAINS.tone.vegetation / 4);
    expect(GROUND_GRAIN_GAINS.clumps.snow).toBe(0);
  });
});
