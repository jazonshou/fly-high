import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import { RoadSurfaceMaterialPlugin } from "../src/render/webgpu/roads/RoadSurfaceMaterialPlugin";
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
  DEFAULT_DETILE_WARP,
  GROUND_GRAIN_ANISOTROPY_LIMIT,
  GROUND_GRAIN_CRUNCH,
  GROUND_GRAIN_GAINS,
  GROUND_GRAIN_RELIEF_FADE,
  GROUND_GRAIN_SCALES,
  GROUND_GRAIN_SEABED_FADE,
  GROUND_GRAIN_TONE_FADE,
  TerrainSurfacePlugin,
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
      GROUND_GRAIN_CHANNEL_STD.crunch,
    ];
    targets.forEach((target, index) => {
      const measured = std(channel(layer.albedoHeight, index)) / 255;
      expect(measured, `channel ${index}`).toBeGreaterThan(target * 0.75);
      expect(measured, `channel ${index}`).toBeLessThan(target * 1.1);
    });
    expect(std(channel(layer.normalMaterial, 0))).toBeGreaterThan(10);
  });

  it("keeps the crunch's contrast at every mip, where the tone's sits in its broadest", () => {
    // The crunch exists because the other channels are red: what a mip level
    // adds over the level above it (its Laplacian band) is the contrast a
    // pixel reading that level sees at its own scale. The tone's finest band
    // is a fraction of its broadest, so a fine footprint saw smooth ground;
    // the crunch's equal octaves keep every band within a factor of two.
    const plan = planMippedTextureArray([layer.albedoHeight], EDGE, "box");
    const chains = plan.layerChains[0]!;
    const bands = (index: number): number[] => {
      const out: number[] = [];
      for (let level = 0; EDGE >> (level + 2) >= 1; level += 1) {
        const edge = EDGE >> level;
        const fine = chains[level]!;
        const coarse = chains[level + 1]!;
        const differences: number[] = [];
        for (let y = 0; y < edge; y += 1) {
          for (let x = 0; x < edge; x += 1) {
            differences.push(fine[(y * edge + x) * 4 + index]!
              - coarse[((y >> 1) * (edge >> 1) + (x >> 1)) * 4 + index]!);
          }
        }
        out.push(std(differences) / 255);
      }
      return out;
    };
    const crunch = bands(3).slice(0, 5);
    const tone = bands(0).slice(0, 5);
    expect(crunch[0]).toBeGreaterThan(0.06);
    for (const band of crunch) expect(band).toBeGreaterThan(crunch[0]! * 0.45);
    expect(Math.max(...crunch)).toBeLessThan(crunch[0]! * 1.2);
    expect(tone[0]).toBeLessThan(Math.max(...tone) * 0.4);
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

/** A material plugin's fragment WGSL, every injection joined in order. */
function fragmentWgsl(make: (material: PBRMaterial) => { getCustomCode: TerrainSurfacePlugin["getCustomCode"] }): string {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("ground-grain-test", scene);
  try {
    const code = make(material).getCustomCode("fragment", ShaderLanguage.WGSL) as Record<string, string>;
    return Object.values(code).join("\n");
  } finally {
    material.dispose(true, true);
    scene.dispose();
    engine.dispose();
  }
}

describe("the shader reads the grain safely", () => {
  const plugin = readSource("src/render/webgpu/terrain/TerrainSurfacePlugin.ts");
  // The grain's reads are composed from generators the roads' ribbon shares,
  // so their order and form are checked in the WGSL the terrain compiles.
  const fragment = fragmentWgsl((material) => new TerrainSurfacePlugin(material));

  it("reads the layer only behind its uniform switch", () => {
    // tuning.z is 1 exactly when the bound arrays carry the layer; a build
    // without it must never read past the ten materials.
    const gate = fragment.indexOf("if (uniforms.terrainSurfaceTuning.z > 0.5) {");
    const firstFetch = fragment.indexOf("terrainGroundGrainFetch(\n      terrainGrainUv0");
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
      const branch = fragment.indexOf(`if (terrainGrainShare${index} > 0.0) {`);
      const fetch = fragment.indexOf(`terrainGroundGrainFetch(\n      terrainGrainUv${index}`);
      expect(branch).toBeGreaterThan(-1);
      expect(fetch).toBeGreaterThan(branch);
    }
    for (const index of [0, 1]) {
      const branch = fragment.indexOf(`if (terrainGrainRelief${index} > 0.0) {`);
      const fetch = fragment.indexOf(`terrainGroundGrainGradient(\n      terrainGrainUv${index}`);
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
    expect(fragment).toContain("uniforms.terrainSurfaceWetness.y - terrainAbsolutePosition.y);");
  });

  it("measures the footprint by its major axis, which is what sets an isotropic read's mip", () => {
    expect(fragment).toContain("return max(max(length(worldDdx), length(worldDdy)), 1e-9);");
    expect(fragment).toContain(
      "let terrainGrainFootprint = terrainGroundGrainFootprint(terrainWorldDdx.xz, terrainWorldDdy.xz);",
    );
  });

  it("mottles the distant canopy the handoff paints", () => {
    expect(plugin).toContain("vec3f(${TERRAIN_CANOPY_ALBEDO}) * terrainGrainCanopy");
  });

  it("samples at an explicit level, isotropic, one trilinear tap per read", () => {
    // House rule since 2-8: any sample under a branch carries explicit
    // derivatives or an explicit level. The grain's extra anisotropic taps
    // would only resolve zero-mean noise along the line of sight, and they were
    // most of its cost, so it reads isotropically: one trilinear tap at the
    // mip the footprint's major axis picks, which is what a gradient read
    // limited to anisotropy 1 does, computed once per scale rather than by the
    // sampler on every read.
    expect(GROUND_GRAIN_ANISOTROPY_LIMIT).toBe(1);
    expect(GROUND_GRAIN_ANISOTROPY_LIMIT).toBeLessThan(DEFAULT_ANISOTROPY_LIMIT);
    expect(fragment).toContain(
      `textureSampleLevel(terrainSurfaceAlbedo, terrainSurfaceAlbedoSampler,\n    uv, ${GROUND_GRAIN_LAYER}, level);`,
    );
    expect(fragment).toContain(
      `textureSampleLevel(terrainSurfaceNormal, terrainSurfaceNormalSampler,\n    uv, ${GROUND_GRAIN_LAYER}, level);`,
    );
    // A scale's level is log2 of the footprint in its own texels: the
    // frame's uniform scale is 1 / period.
    expect(plugin).toContain("return log2(footprintMeters * edgeTexels * ${inverse});");
    for (const index of [0, 1, 2]) {
      expect(fragment).toContain(
        `let terrainGrainLevel${index} = terrainGroundGrainLevel${index}(terrainGrainFootprint, terrainGrainEdge);`,
      );
    }
    // The materials keep the full cap: only the grain is coarsened.
    expect(plugin).toContain(
      "return terrainSurfaceLimitAnisotropyTo(ddx, ddy, ${DEFAULT_ANISOTROPY_LIMIT.toFixed(1)});",
    );
  });

  it("picks the mip a gradient read limited to anisotropy 1 would", () => {
    // The limiter inflates the shorter axis to the longer one, so the
    // limited footprint's axes are both the major axis, and an isotropic
    // read's level is log2 of that length in texels. Each scale's frame is a
    // rotation times 1 / period, which leaves lengths scaled by 1 / period.
    type V = readonly [number, number];
    const len = (v: V) => Math.hypot(v[0], v[1]);
    const edge = 512;
    for (const scale of GROUND_GRAIN_SCALES) {
      const a = (scale.rotationDegrees * Math.PI) / 180;
      const k = 1 / scale.periodMeters;
      const frame = (v: V): V => [
        k * (Math.cos(a) * v[0] - Math.sin(a) * v[1]),
        k * (Math.sin(a) * v[0] + Math.cos(a) * v[1]),
      ];
      for (const [dx, dy] of [
        [[0.4, 0.1], [0.3, 9.5]],
        [[2.0, -0.3], [0.05, 0.02]],
        [[1.0, 1.0], [-1.0, 1.0]],
      ] as [V, V][]) {
        const major = Math.max(len(dx), len(dy));
        const limited = [dx, dy].map((v) => {
          const s = major / Math.max(len(v), 1e-8);
          return frame([v[0] * s, v[1] * s]);
        });
        const gradientLevel = Math.log2(Math.max(len(limited[0]!), len(limited[1]!)) * edge);
        const explicitLevel = Math.log2(major * edge * k);
        expect(explicitLevel).toBeCloseTo(gradientLevel, 9);
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

describe("the roads' ribbon carries the grain the paint under it has", () => {
  const terrain = fragmentWgsl((material) => new TerrainSurfacePlugin(material));
  const ribbon = fragmentWgsl((material) => new RoadSurfaceMaterialPlugin(material, "ribbon"));
  // The terrain's names as the ribbon's: terrainSurfaceValue is roadSurfaceValue.
  const asRibbon = (wgsl: string) => wgsl.replace(/terrain(?=[A-Z])/g, "road");
  const between = (wgsl: string, start: string, end: string) => {
    const from = wgsl.indexOf(start);
    const to = wgsl.indexOf(end, from);
    expect(from, start).toBeGreaterThan(-1);
    expect(to, end).toBeGreaterThan(from);
    return wgsl.slice(from, to);
  };
  const fn = (wgsl: string, name: string) => between(wgsl, `fn ${name}(`, "\n}\n");

  it("reads it only from arrays that carry the layer", () => {
    // The arrays carry the layer exactly where the tier runs the patchwork.
    const gate = ribbon.indexOf(`textureNumLayers(roadSurfaceAlbedo) > ${GROUND_GRAIN_LAYER}u`);
    const branch = ribbon.indexOf("if (roadGroundPatchworkOn > 0.5) {");
    const fetch = ribbon.indexOf("roadGroundGrainFetch(\n      roadGrainUv0");
    expect(gate).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(gate);
    expect(fetch).toBeGreaterThan(branch);
  });

  it("at the point the terrain reads it, through the same noise and de-tile warp", () => {
    for (const name of ["SurfaceHash", "SurfaceValue", "SurfaceValue2", "SurfaceValueGrad", "SurfaceDecodeNormal"]) {
      expect(fn(ribbon, `road${name}`), name).toBe(asRibbon(fn(terrain, `terrain${name}`)));
    }
    // The terrain's warp amount is a uniform it never changes from its default.
    expect(fn(ribbon, "roadSurfaceDetileWarp")).toBe(asRibbon(fn(terrain, "terrainSurfaceDetileWarp")
      .replace("uniforms.terrainSurfaceTuning.x", String(DEFAULT_DETILE_WARP))));
    expect(ribbon).toContain("let roadGrainXz = roadPosition + roadSurfaceDetileWarp(roadPosition, roadFootprint);");
    expect(terrain).toContain("let terrainGrainXz = terrainAbsolutePosition.xz + terrainWarp;");
    expect(terrain).toContain(
      "let terrainWarp = terrainSurfaceDetileWarp(terrainAbsolutePosition.xz, terrainFootprintMajor);",
    );
  });

  it("with the terrain's reads, fades, gains and relief (a seal's tone only)", () => {
    for (const index of [0, 1, 2]) {
      for (const name of ["Frame", "Level", "Uv"]) {
        expect(fn(ribbon, `roadGroundGrain${name}${index}`)).toBe(asRibbon(fn(terrain, `terrainGroundGrain${name}${index}`)));
      }
    }
    for (const name of ["Footprint", "Fetch", "Gradient"]) {
      expect(fn(ribbon, `roadGroundGrain${name}`)).toBe(asRibbon(fn(terrain, `terrainGroundGrain${name}`)));
    }
    // The reads but their point and the sea's fade (a road never lies under the sea).
    const reads = (wgsl: string, p: string) => between(wgsl, `let ${p}GrainUv0`, `let ${p}GrainShown`)
      + between(wgsl, `let ${p}GrainShare0`, `${p}GrainLevel2);\n  }\n`);
    expect(reads(ribbon, "road")).toBe(asRibbon(reads(terrain, "terrain")));
    const tone = (wgsl: string, p: string) => between(wgsl, `let ${p}GrainToneGain`, `* ${p}GrainClump));`);
    expect(tone(ribbon, "road")).toBe(asRibbon(tone(terrain, "terrain")));
    const relief = (wgsl: string, p: string) => between(wgsl, "  // Relief from the two finer scales", `${p}GrainLevel1);\n  }\n`);
    expect(relief(ribbon, "road")).toBe(asRibbon(relief(terrain, "terrain")));
    // A seal takes the tone and not the relief: it is rolled flat, as the terrain's pavement is.
    expect(ribbon).toMatch(/if \(!roadSealed\) \{\n  \/\/ Relief from the two finer scales/);
  });
});

describe("the crunch shadows the sward, and the sward is matte", () => {
  const plugin = readSource("src/render/webgpu/terrain/TerrainSurfacePlugin.ts");
  // The reads come from a generator the roads' ribbon shares, so they are
  // counted in the WGSL the terrain compiles.
  const fragment = fragmentWgsl((material) => new TerrainSurfacePlugin(material));

  it("reads the crunch from the three texels already fetched", () => {
    // No new fetch: the crunch is the albedo array's fourth channel, and the
    // composite has exactly the three reads it had before it.
    expect(plugin).toContain(
      "let terrainGrainCrunch = terrainGrain0.w + 0.8 * terrainGrain1.w + terrainGrain2.w;",
    );
    expect(fragment.split("terrainGroundGrainFetch(\n").length - 1).toBe(3);
  });

  it("dims the sun through the direct multiplier and the sky through the cavity", () => {
    // Direct and ambient each once: the sun's share rides the same multiplier
    // as the canopy and scrub shadows, faded out under runway paint.
    expect(plugin).toContain("* mix(terrainGrainDirect, 1.0, clamp(terrainRunwayPaved, 0.0, 1.0));");
    expect(plugin).toContain("terrainCavity *= max(0.25, 1.0 + ${terrainWgslFloat(GROUND_GRAIN_CRUNCH.ambient)}");
    // Looking down-sun the gaps hide behind what shades them.
    expect(plugin).toContain("terrainGrainShadowsSeen * terrainGrainCrunch");
    expect(GROUND_GRAIN_CRUNCH.hotspot).toBeGreaterThan(0);
    expect(GROUND_GRAIN_CRUNCH.hotspot).toBeLessThan(1);
  });

  it("puts the most crunch on vegetation and the least on snow", () => {
    const { gains } = GROUND_GRAIN_CRUNCH;
    expect(gains.vegetation).toBe(Math.max(gains.vegetation, gains.rock, gains.snow, gains.other));
    expect(gains.snow).toBe(Math.min(gains.vegetation, gains.rock, gains.snow, gains.other));
    // Bounded both ways: a gap never goes black, and never brightens past
    // what a lit top can.
    expect(plugin).toContain("terrainGrainDirect = max(0.25, 1.0 + ");
  });

  it("trims the sward's specular to the vegetation materials' own", () => {
    // Grass and shrub crowns already render at CANOPY_SURFACE_SPECULAR; the
    // ground under them carried the full lobe, the milky sheen.
    expect(plugin).toContain(
      "terrainF0 * (1.0 - ${terrainWgslFloat(1 - CANOPY_SURFACE_SPECULAR)} * terrainSwardShare)",
    );
    const share = plugin.slice(plugin.indexOf("let terrainSwardShare = "));
    expect(share.slice(0, 220)).toContain("terrainGroundVegetation");
    // Paint, the canopy's own trimmed share and wet ground keep theirs.
    expect(share.slice(0, 220)).toContain("(1.0 - clamp(terrainRunwayPaved, 0.0, 1.0))");
    expect(share.slice(0, 220)).toContain("(1.0 - terrainCanopySurface)");
    expect(share.slice(0, 220)).toContain("(1.0 - terrainWetness)");
  });
});
