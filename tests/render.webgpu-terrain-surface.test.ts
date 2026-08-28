import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  DETILE_MICRO_DEGREES,
  DETILE_PATCH_DEGREES,
  heightBlendWeights,
  meanSeasonalSurfaceAlbedo,
  resolveTerrainSlopeSnowCover,
  seasonalSnowlineMeters,
  surfaceSeasonalResponse,
  TERRAIN_FALLBACK_ALPINE_END_METERS,
  TERRAIN_FALLBACK_ALPINE_ROCK_STRENGTH,
  TERRAIN_FALLBACK_ALPINE_START_METERS,
  TERRAIN_MATERIAL_DETAIL_FULL_FOOTPRINT_METERS,
  TERRAIN_MATERIAL_DETAIL_ZERO_FOOTPRINT_METERS,
  TERRAIN_PAGE_SPLAT_CONFIDENCE_LOSS_PER_LEVEL,
  TERRAIN_PAGE_SPLAT_FINEST_TEXEL_METERS,
  TERRAIN_PAGE_SPLAT_MINIMUM_CONFIDENCE,
  TERRAIN_FINE_HEIGHT_GRADIENT_SCALE,
  TERRAIN_PARENT_HEIGHT_GRADIENT_SCALE,
  TERRAIN_SURFACE_INJECTION_ANCHORS,
  TERRAIN_SURFACE_INJECTION_TOKENS,
  TERRAIN_SPARSE_SPLAT_GATHER_WGSL,
  TERRAIN_SURFACE_VERTEX_WGSL,
  TerrainSurfacePlugin,
  terrainNodeLocalNormalFromHeightGradients,
  terrainPageClassificationConfidence,
  terrainCoverHeightBlendWeights,
  terrainFallbackRockCover,
  terrainMaterialDetailWeight,
  TRIPLANAR_SLOPE_THRESHOLD,
} from "../src/render/webgpu/terrain/TerrainSurfacePlugin";
import { terrainNodeSpanMeters } from "../src/render/webgpu/terrain/TerrainSpineContract";
import {
  resolveRunwaySurfaceBinding,
  RUNWAY_SURFACE_WGSL,
} from "../src/render/webgpu/terrain/RunwaySurface";
import {
  linearLuminance,
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
  surfaceMaterialSpec,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import { TERRAIN_REFERENCE_DAY_OF_YEAR } from "../src/world";
import { DEFAULT_AIRPORT } from "../src/world/airport";

/**
 * 3-2/3-3/3-4/3-5/3-6/3-7/3-10 — the terrain surface plugin.
 *
 * The assertions that need a compiled shader (57, 59, 61) live in
 * tests/gpu/terrain-surface-compile.test.ts. Everything checkable without an
 * adapter lives here, including the one that matters most on a dependency
 * bump: the regex anchors are matched against the SHIPPED Babylon source, in
 * `npm test`, so a bump fails the ordinary suite rather than waiting for a GPU
 * run.
 */

const BABYLON_WGSL = join(__dirname, "..", "node_modules", "@babylonjs", "core", "ShadersWGSL");

function shippedPbrFragmentSource(): string {
  // The anchors span pbr.fragment and one of its includes; the injection runs
  // after include resolution, so the concatenation is what the regex sees.
  const main = readFileSync(join(BABYLON_WGSL, "pbr.fragment.js"), "utf8");
  const reflectance0 = readFileSync(
    join(BABYLON_WGSL, "ShadersInclude", "pbrBlockReflectance0.js"),
    "utf8",
  );
  return `${main}\n${reflectance0}`;
}

function shippedTerrainVertexNormalConsumers(): string {
  const pbr = readFileSync(join(BABYLON_WGSL, "pbr.vertex.js"), "utf8");
  const shadow = readFileSync(join(BABYLON_WGSL, "shadowMap.vertex.js"), "utf8");
  return `${pbr}\n${shadow}`;
}

function fragmentCode(plugin: TerrainSurfacePlugin): Record<string, string> {
  const code = plugin.getCustomCode("fragment", ShaderLanguage.WGSL);
  expect(code).not.toBeNull();
  return code as Record<string, string>;
}

function withPlugin<T>(body: (plugin: TerrainSurfacePlugin, material: PBRMaterial) => T): T {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("terrain-surface-test", scene);
  const plugin = new TerrainSurfacePlugin(material);
  try {
    return body(plugin, material);
  } finally {
    material.dispose(true, true);
    scene.dispose();
    engine.dispose();
  }
}

describe("terrain surface plugin (3-2)", () => {
  it("keeps the painted runway silhouette on the analytic physics boundary", () => {
    const pavementDistance = RUNWAY_SURFACE_WGSL.indexOf("let pavementDistance = coarse;");
    const pavementMask = RUNWAY_SURFACE_WGSL.indexOf(
      "let paved = terrainRunwayMask(pavementDistance",
    );
    expect(pavementDistance).toBeGreaterThan(-1);
    expect(pavementMask).toBeGreaterThan(pavementDistance);
    expect(RUNWAY_SURFACE_WGSL).not.toMatch(
      /pavementDistance\s*=\s*[^;]*terrainSurfaceValue/,
    );
    expect(resolveRunwaySurfaceBinding(DEFAULT_AIRPORT).shape[3]).toBe(0);
  });
  it("R-3B: every regex anchor matches the shipped Babylon WGSL exactly once", () => {
    // The anchors are minified, unversioned, shipped WGSL. A `!regex` that
    // matches NOTHING is silent — which is precisely how the plan's original
    // AO anchor at :245 would have left ambient occlusion looking wired and
    // never applying. Matching more than once is the other failure: the
    // injection would land in a branch it was not written for.
    const source = shippedPbrFragmentSource();
    for (const [name, anchor] of Object.entries(TERRAIN_SURFACE_INJECTION_ANCHORS)) {
      expect(anchor.startsWith("!"), `${name} must use the !regex injection form`).toBe(true);
      const matches = source.match(new RegExp(anchor.slice(1), "g")) ?? [];
      expect(
        matches.length,
        `the ${name} anchor matched ${matches.length} times in @babylonjs/core 9.21.2 — `
        + "re-derive it against the shipped source and record the matched text verbatim",
      ).toBe(1);
    }
  });

  it("C3: the AO anchor is the reachable one, not the plan's unreachable :245", () => {
    const source = shippedPbrFragmentSource();
    // The plan's line sits inside a triple guard the terrain material never
    // satisfies — it binds no reflectivity texture, so REFLECTIVITY is never
    // defined and the line never enters the compiled shader.
    expect(source).toContain(
      "#if defined(METALLICWORKFLOW) && defined(REFLECTIVITY) && defined(AOSTOREINMETALMAPRED)",
    );
    expect(TERRAIN_SURFACE_INJECTION_ANCHORS.ambientOcclusion).not.toContain(
      "aoOut.ambientOcclusionColor=reflectivityOut",
    );
    // The reachable anchor is the unguarded ambientOcclusionBlock call, and it
    // must sit AFTER the CUSTOM_FRAGMENT_BEFORE_LIGHTS hook that declares the
    // value it consumes.
    const hook = source.indexOf("#define CUSTOM_FRAGMENT_BEFORE_LIGHTS");
    const call = source.indexOf("aoOut=ambientOcclusionBlock(");
    expect(hook).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(hook);
  });

  it("emits WGSL only, and never the superseded plugin's dead GLSL branch", () => {
    withPlugin((plugin) => {
      expect(plugin.getCustomCode("fragment", ShaderLanguage.GLSL)).toBeNull();
      expect(plugin.getCustomCode("vertex", ShaderLanguage.GLSL)).toBeNull();
      expect(plugin.getCustomCode("compute", ShaderLanguage.WGSL)).toBeNull();
      expect(plugin.getCustomCode("vertex", ShaderLanguage.WGSL)).toEqual(
        { ...TERRAIN_SURFACE_VERTEX_WGSL },
      );
      expect(plugin.isCompatible()).toBe(true);
      expect(plugin.getClassName()).toBe("TerrainSurfacePlugin");
    });
  });

  it("assertion 58 (structural half): no tangent attribute, only the splat lane", () => {
    withPlugin((plugin) => {
      const attributes: string[] = [];
      plugin.getAttributes(attributes);
      // C4: the tangent frame is analytic. A vertex tangent would be memory
      // and bandwidth spent on Babylon's NORMALMAP path, which this plugin
      // never enters because it writes normalW directly.
      expect(attributes).toEqual(["color"]);
      const samplers: string[] = [];
      plugin.getSamplers(samplers);
      // 4-7 adds the three channel-page samplers. They are declared
      // unconditionally (Babylon collects the sampler list once) and compiled
      // out by TERRAIN_SURFACE_PAGE_CHANNELS when no atlas is bound.
      expect(samplers).toEqual([
        "terrainSurfaceAlbedo",
        "terrainSurfaceNormal",
        "terrainOcclusionAtlas",
        "terrainHorizonAtlasA",
        "terrainHorizonAtlasB",
        // 4-4's vertex-texture displacement source, and 4-6's page splat.
        "terrainHeightAtlas",
        "terrainSplatId",
        "terrainSplatWeightLo",
        "terrainSplatWeightHi",
      ]);
      const uniformNames = plugin.getUniforms().ubo.map((entry) => entry.name);
      expect(uniformNames).toContain("terrainMaterialTiling");
      expect(uniformNames).toContain("terrainMaterialSeason");
      for (const entry of plugin.getUniforms().ubo) {
        if (entry.name.startsWith("terrainMaterial")) {
          expect(entry.arraySize).toBe(SURFACE_MATERIAL_COUNT);
        }
      }
    });
  });

  it("keeps the superseded plugin's good properties: absolute coordinates, no contour bands", () => {
    // Migrated from the deleted tests/render.webgpu-terrain-material.test.ts.
    withPlugin((plugin) => {
      const code = fragmentCode(plugin);
      const beforeLights = code["CUSTOM_FRAGMENT_BEFORE_LIGHTS"] ?? "";
      expect(beforeLights).toContain("terrainWorldOrigin");
      expect(beforeLights).toContain("terrainSlope");
      expect(beforeLights).toContain("normalW = normalize");
      expect(beforeLights).toContain("surfaceAlbedo = terrainAlbedo");
      // The camera-stable macro wash the deleted build had and the audit
      // wanted back — and, since 3-1 high-passes each layer, the only place
      // world-scale brightness variation now comes from.
      expect(beforeLights).toContain("terrainMacroVariation");
      expect(beforeLights.indexOf("terrainAlbedo *= terrainMacroVariation"))
        .toBeLessThan(beforeLights.indexOf("terrainRunwaySurface("));
      // Equal-elevation sine strata painted horizontal scan lines across every
      // hill at medium clipmap range. They must not come back.
      expect(beforeLights).not.toContain("sin(terrainAbsolutePosition.y");
    });
  });

  it("3-3: the distance gate is gone and the detail is footprint-driven", () => {
    withPlugin((plugin) => {
      const code = fragmentCode(plugin);
      const source = Object.values(code).join("\n");
      // Defect 1: 1.0 - smoothstep(1200, 4200, cameraDistance) switched
      // micro-detail off at exactly the range where the audit measures vertex
      // normals to be worst, and slid the detail ring across the ground with
      // the aircraft.
      expect(source).not.toContain("1200.0, 4200.0");
      expect(source).not.toMatch(/smoothstep\(\s*1200/u);
      expect(source).not.toContain("terrainCameraDistance");
      expect(source).toContain("dpdx(terrainAbsolutePosition)");
      expect(source).toContain("dpdy(terrainAbsolutePosition)");
      expect(source).toContain("terrainFootprint");
      // Defect 2: the 0.38 world-metre FORWARD difference against a 1.39 m
      // noise cell — 0.27 of a cell, one-sided — is not measuring a gradient.
      // There is no finite difference in the shader at all now: the normal is
      // read from array B, whose gradients were centrally differenced at one
      // texel by the synthesiser.
      expect(source).not.toContain("* 0.38");
      expect(source).not.toContain("terrainTriplanarNoise");
      // Defect 3: texture-sourced.
      expect(source).toContain("terrainSurfaceFetchNormal");
    });
  });

  it("derives a shared-vertex macro normal from the same fine/parent height morph", () => {
    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      const definitions = TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_DEFINITIONS;
      const position = TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_UPDATE_POSITION;
      // The sampler returns height + analytic bilinear gradient from exactly
      // the same four loads; adding separate neighbour fetches here would turn
      // a visual fix into a vertex-bandwidth regression.
      const samplerStart = definitions.indexOf("fn terrainSampleHeightGradient");
      const samplerEnd = definitions.indexOf("\n}\n#else", samplerStart);
      const sampler = definitions.slice(samplerStart, samplerEnd);
      expect(sampler.match(/textureLoad\(/gu)).toHaveLength(4);
      expect(sampler).toContain("mix(h10 - h00, h11 - h01, fraction.y)");
      expect(sampler).toContain("mix(h01 - h00, h11 - h10, fraction.x)");
      expect(position.match(/terrainSampleHeightGradient\(/gu)).toHaveLength(2);
      expect(definitions).toContain("fn terrainSurfaceCornerMorphs(packed: f32)");
      expect(definitions).toContain("16777215.0");
      expect(definitions).toContain("bits >> 6u");
      expect(definitions).toContain("bits >> 12u");
      expect(definitions).toContain("bits >> 18u");
      expect(definitions).toContain("if (!parentResident) { return 0.0; }");
      const boundaryMorphStart = definitions.indexOf("fn terrainSurfaceVertexMorphK(");
      const boundaryMorphEnd = definitions.indexOf("\n}\n`", boundaryMorphStart);
      const boundaryMorph = definitions.slice(
        boundaryMorphStart,
        boundaryMorphEnd >= 0 ? boundaryMorphEnd : undefined,
      );
      const interiorReturn = boundaryMorph.indexOf(
        "if (!(onX0 || onX1 || onZ0 || onZ1))",
      );
      const packedCornerDecode = boundaryMorph.indexOf(
        "let corners = terrainSurfaceCornerMorphs(packedCorners);",
      );
      expect(interiorReturn).toBeGreaterThanOrEqual(0);
      expect(packedCornerDecode).toBeGreaterThan(interiorReturn);
      expect(position).toContain("let vertexMorphK = terrainSurfaceVertexMorphK(");
      expect(position).toContain("(evenLattice - gridPosition) * vertexMorphK");
      expect(position).toContain("(coarse.x - fine.x) * vertexMorphK");
      expect(position).toContain("(parentGradient - fineGradient) * vertexMorphK");
      // nodeB.x is only the decoder's interior input. Geometry, height and
      // normals must never bypass the synchronized boundary value.
      expect(position.match(/nodeB\.x/gu)).toHaveLength(1);
      expect(position).toContain("sampledFine.yz * quads");
      expect(position).toContain("coarse.yz * (quads * 0.5)");
      expect(position).toContain(
        "normalUpdated = vec3f(-nodeGradient.x, 1.0, -nodeGradient.y)",
      );
      expect(position).not.toContain("normalUpdated = normalize(vec3f(-nodeGradient");
      const consumers = shippedTerrainVertexNormalConsumers();
      expect(consumers).toContain(
        "vertexOutputs.vNormalW=normalize(normalWorld*vertexOutputs.vNormalW)",
      );
      expect(consumers).toContain("vNormalW=normalize(normWorldSM*vNormalW)");

      const parentLoadBranch = position.indexOf(
        "if (vertexMorphK > 0.0 || !fineResident)",
      );
      const parentLoad = position.indexOf(
        "coarse = terrainSampleHeightGradient(nodeB.y, parentTexel.x, parentTexel.y)",
      );
      expect(parentLoadBranch).toBeGreaterThanOrEqual(0);
      expect(parentLoad).toBeGreaterThan(parentLoadBranch);
      expect(position.indexOf("let sampledFine = terrainSampleHeightGradient"))
        .toBeLessThan(parentLoadBranch);

      // normalW is now the interpolated shared-vertex macro normal. A
      // dpdx/dpdy cross is constant on each triangle and recreated the user's
      // solid colour plates through lighting, slope cover and triplanar mode.
      expect(source).toContain("let terrainGeometricNormal = normalize(normalW)");
      expect(source).not.toContain("cross(terrainWorldDdx, terrainWorldDdy)");
      // Screen derivatives remain for texture footprints/explicit gradients.
      expect(source).toContain("dpdx(terrainAbsolutePosition)");
      expect(source).toContain("dpdy(terrainAbsolutePosition)");

      const normalAt = source.indexOf("let terrainGeometricNormal = normalize(normalW)");
      const slopeAt = source.indexOf("let terrainSlope =");
      const sampleAt = source.indexOf("terrainSamplePosition, terrainGeometricNormal");
      const runwayAt = source.indexOf("terrainAbsolutePosition, terrainGeometricNormal");
      expect(normalAt).toBeGreaterThan(0);
      expect(slopeAt).toBeGreaterThan(normalAt);
      expect(sampleAt).toBeGreaterThan(slopeAt);
      expect(runwayAt).toBeGreaterThan(slopeAt);
    });
  });

  it("recovers one planar world slope across levels, morph and parent fallback", () => {
    expect(TERRAIN_FINE_HEIGHT_GRADIENT_SCALE).toBe(32);
    expect(TERRAIN_PARENT_HEIGHT_GRADIENT_SCALE).toBe(16);
    const slopeX = 0.37;
    const slopeZ = -0.21;
    const expectedLength = Math.hypot(slopeX, 1, slopeZ);
    const expected = [-slopeX / expectedLength, 1 / expectedLength, -slopeZ / expectedLength];
    const toWorld = (
      local: readonly [number, number, number],
      span: number,
    ): readonly [number, number, number] => {
      const x = local[0] / span;
      const y = local[1];
      const z = local[2] / span;
      const length = Math.hypot(x, y, z);
      return [x / length, y / length, z / length];
    };

    for (let level = 0; level <= 9; level += 1) {
      const span = terrainNodeSpanMeters(level);
      const fineTexelMeters = span / TERRAIN_FINE_HEIGHT_GRADIENT_SCALE;
      const fine = [slopeX * fineTexelMeters, slopeZ * fineTexelMeters] as const;
      const parent = [slopeX * fineTexelMeters * 2, slopeZ * fineTexelMeters * 2] as const;
      for (const morphK of [0, 0.25, 0.7, 1]) {
        const world = toWorld(
          terrainNodeLocalNormalFromHeightGradients(fine, parent, morphK),
          span,
        );
        expected.forEach((component, index) => {
          expect(world[index], `level ${level}, morph ${morphK}, component ${index}`)
            .toBeCloseTo(component, 12);
        });
      }

      // At the endpoint a child using its parent gradient must equal that
      // level+1 node using the same page as its fine source.
      const childWorld = toWorld(
        terrainNodeLocalNormalFromHeightGradients(fine, parent, 1),
        span,
      );
      const grandParent = [parent[0] * 2, parent[1] * 2] as const;
      const parentWorld = toWorld(
        terrainNodeLocalNormalFromHeightGradients(parent, grandParent, 0),
        span * 2,
      );
      parentWorld.forEach((component, index) => {
        expect(childWorld[index], `level ${level} LOD seam component ${index}`)
          .toBeCloseTo(component, 12);
      });

      // A temporarily missing fine slot inherits the resident parent's normal
      // regardless of the stale morph lane, never an up-vector flash.
      const fallback = toWorld(
        terrainNodeLocalNormalFromHeightGradients([99, -71], parent, 0.63, false),
        span,
      );
      expected.forEach((component, index) => {
        expect(fallback[index], `level ${level} fallback component ${index}`)
          .toBeCloseTo(component, 12);
      });
    }
    expect(() => terrainNodeLocalNormalFromHeightGradients([0, 0], [0, 0], -0.1))
      .toThrow(RangeError);
  });

  it("3-4: rotates at 13.7 and 61.2 degrees, never the deleted build's 36.3", () => {
    expect(DETILE_PATCH_DEGREES).toBe(13.7);
    expect(DETILE_MICRO_DEGREES).toBe(61.2);
    // 36.3 deg is within 1.3 deg of the 35 deg geological fabric the audit
    // measures at 23.6:1 anisotropy; aligning the de-tiling rotation with the
    // artefact reinforces the exact thing 5-8 exists to remove.
    for (const angle of [DETILE_PATCH_DEGREES, DETILE_MICRO_DEGREES]) {
      expect(Math.abs(angle - 36.3)).toBeGreaterThan(5);
      expect(Math.abs(angle - 35)).toBeGreaterThan(5);
    }
    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      const patchCos = Math.cos((13.7 * Math.PI) / 180).toFixed(6);
      const microCos = Math.cos((61.2 * Math.PI) / 180).toFixed(6);
      expect(source).toContain(patchCos);
      expect(source).toContain(microCos);
      // Three decorrelated scales, each footprint-faded.
      expect(source).toContain("macroWeight");
      expect(source).toContain("patchWeight");
      expect(source).toContain("microWeight");
    });
  });

  it("3-5: sign-flipped UVs, explicit gradients and RNM blending", () => {
    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      expect(TRIPLANAR_SLOPE_THRESHOLD).toBe(0.22);
      expect(source).toContain("slope > 0.22");
      // Untreated, the projection mirrors and produces a visible reflection
      // seam down every ridge.
      expect(source).toContain("let signs = sign(");
      expect(source).toContain("position.z * signs.x");
      // House rule since 2-8: any sample under a branch or a wrap gets
      // explicit gradients. There must be no implicit-derivative sample left.
      expect(source).toContain("textureSampleGrad");
      expect(source).not.toMatch(/textureSample\(/u);
      // RNM in world space — never lerp tangent-space normals.
      expect(source).toContain("fn terrainSurfaceRnm(");
      expect(source).toContain("terrainSurfaceRnm(");
      // The sampled tangent normal's U axis must be flipped by the SAME sign
      // the UV was, and the blended result's plane axis flipped back. Half of
      // that pairing is a normal pointing the wrong way on one side of every
      // ridge — the seam moved out of albedo and into lighting.
      expect(source).toContain("sampled.x * signs.x * detailWeight");
      expect(source).toContain("tangentNormal.z * signs.x");
      expect(source).toContain("sampled.x * -signs.z * detailWeight");
      // And the planar tangent frame must be degeneracy-free: the clipmap's
      // crack-guard skirts carry normals of exactly (±1, 0, 0).
      expect(source).toContain("fn terrainSurfaceTangent(");
      expect(source).not.toContain("normalize(vec3f(1.0, 0.0, 0.0) - geometricNormal");
      // The 2-axis fast path must be the DEFAULT, compiled out only when the
      // tier asks for three.
      expect(source).toContain("#ifndef TERRAIN_SURFACE_TRIPLANAR");
      expect(source).toContain("#ifdef TERRAIN_SURFACE_PLANAR_ONLY");
    });
  });

  it("assertion 60: height-blend weights are a partition of unity", () => {
    // A height blend that quietly loses energy darkens the whole terrain and
    // is very hard to see by eye.
    let state = 0x1234_5678;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
    for (let trial = 0; trial < 20_000; trial += 1) {
      const count = 2 + (trial % 2);
      const keys: number[] = [];
      for (let index = 0; index < count; index += 1) keys.push(random() * 2);
      const depth = 0.06 + random() * 0.44;
      const weights = heightBlendWeights(keys, depth);
      const sum = weights.reduce((total, value) => total + value, 0);
      expect(Math.abs(sum - 1), `keys ${keys.join(",")} depth ${depth}`).toBeLessThan(1e-4);
      for (const weight of weights) expect(weight).toBeGreaterThanOrEqual(0);
    }
    // Degenerate inputs must not produce NaN.
    expect(heightBlendWeights([0, 0, 0], 0.06).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(heightBlendWeights([], 0.1)).toEqual([]);
    // The strongest key always survives; a key a full depth below never does.
    expect(heightBlendWeights([1, 0.5], 0.2)).toEqual([1, 0]);

    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      expect(source).toContain("max(terrainKey0 - terrainKeyMax, 0.0)");
      expect(source).toContain("terrainBlendDepth");
      expect(source).toContain("clamp(terrainFootprint / 3.0, 0.0, 1.0)");
    });
  });

  it("3-7: per-material BRDF rows reach the uniform table, wetness is wired", () => {
    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      // Oren-Nayar: Babylon 9 declares diffuseRoughness on the same minified
      // line the roughness injection anchors on.
      expect(source).toContain("diffuseRoughness = terrainSurfaceDiffuseRoughness;");
      expect(source).toContain("specularEnvironmentR0 = vec3f(terrainSurfaceF0);");
      // Wired now, driven by a constant zero until 6-5 supplies the field.
      expect(source).toContain("terrainRoughness * 0.35 + 0.02");
      expect(source).toContain("mix(1.0, 0.62, terrainWetness)");
      for (const token of TERRAIN_SURFACE_INJECTION_TOKENS) {
        expect(source, `injection token ${token}`).toContain(token);
      }
    });
    // The BRDF table itself: ten distinct diffuse-roughness values, with the
    // four the plan names pinned.
    expect(surfaceMaterialSpec(SurfaceMaterial.Snow).diffuseRoughness).toBe(0.7);
    expect(surfaceMaterialSpec(SurfaceMaterial.Sand).diffuseRoughness).toBe(0.55);
    expect(surfaceMaterialSpec(SurfaceMaterial.Grass).diffuseRoughness).toBe(0.4);
    expect(surfaceMaterialSpec(SurfaceMaterial.Rock).diffuseRoughness).toBe(0.35);
  });

  it("3-2: the splat lane carries atlasSlot, reserved for 4-2 and read by 4-7", () => {
    expect(TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_DEFINITIONS).toContain("attribute color: vec4f;");
    expect(TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_DEFINITIONS).toContain("atlasSlot");
    expect(TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_MAIN_END).toContain(
      "vertexOutputs.terrainSplat = vertexInputs.color;",
    );
  });

  it("falls back to the resident parent height when a fine CDLOD slot is missing", () => {
    const source = TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_UPDATE_POSITION;
    expect(source).toContain(
      "let fine = select(coarse, sampledFine, fineResident);",
    );
    expect(source).toContain(
      "coarse = terrainSampleHeightGradient(nodeB.y, parentTexel.x, parentTexel.y);",
    );
    expect(source).not.toContain(
      "let fine = terrainSampleHeightGradient(nodeA.x, nodeTexel.x, nodeTexel.y);",
    );
    expect(source.indexOf("coarse = terrainSampleHeightGradient"))
      .toBeLessThan(source.indexOf("let fine = select(coarse"));
    expect(source).toContain(
      "let fineGradient = select(parentGradient, sampledFine.yz * quads, fineResident);",
    );
  });

  it("gathers sparse splat weights without filtering categorical material ids", () => {
    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      expect(source).toContain("textureLoad(terrainSplatId, texel, 0)");
      expect(source).toContain(TERRAIN_SPARSE_SPLAT_GATHER_WGSL);
      expect(source).toContain("terrainUpperId = terrainPageSplat.y;");
      expect(source).toContain("terrainAxisFraction = terrainPageSplat.z;");
      expect(source).not.toMatch(/textureSampleLevel\(\s*terrainSplatId/u);
      expect(source).not.toContain(
        "mix(\n  fragmentInputs.terrainSplat.xyz, terrainPageSplat",
      );
    });

    const gather = TERRAIN_SPARSE_SPLAT_GATHER_WGSL;
    // Four corners still issue one exact id and two weight loads each. The
    // optimization changes only private accumulation and candidate scanning.
    expect(gather).toContain(
      "cornerIndex < 4u; cornerIndex = cornerIndex + 1u",
    );
    expect(gather.match(/textureLoad\(terrainSplatId, texel, 0\)/gu)).toHaveLength(1);
    expect(gather.match(/textureLoad\(terrainSplatWeightLo, texel, 0\)/gu)).toHaveLength(1);
    expect(gather.match(/textureLoad\(terrainSplatWeightHi, texel, 0\)/gu)).toHaveLength(1);
    expect(gather).toContain("lane < 4u; lane = lane + 1u");

    // Dynamic private-array indexing is the regression this implementation
    // avoids. Every material has one scalar switch arm and one statically
    // ordered top-two candidate, with the original strict tie comparison.
    expect(gather).not.toMatch(/array<f32,\s*10>/u);
    expect(gather).not.toContain("accumulated[materialId]");
    expect(gather).not.toContain("accumulated[materialIndex]");
    let precedingCandidate = -1;
    for (let materialId = 0; materialId < SURFACE_MATERIAL_COUNT; materialId += 1) {
      expect(gather).toContain(`var accumulated${materialId} = 0.0;`);
      expect(gather).toContain(
        `case ${materialId}u: { accumulated${materialId} = accumulated${materialId} + weights[lane]; }`,
      );
      const candidate = gather.indexOf(`candidateWeight = accumulated${materialId};`);
      expect(candidate, `material ${materialId} top-two candidate`).toBeGreaterThan(
        precedingCandidate,
      );
      precedingCandidate = candidate;
    }
    expect(gather.match(/if \(candidateWeight > primaryWeight\)/gu)).toHaveLength(
      SURFACE_MATERIAL_COUNT,
    );
    expect(gather.match(/else if \(candidateWeight > secondaryWeight\)/gu)).toHaveLength(
      SURFACE_MATERIAL_COUNT,
    );
    expect(gather).not.toMatch(/candidateWeight\s*>=/u);
  });

  it("attenuates classification linearly per residency level", () => {
    // Wave Q re-pin (second landing): confidence is linear in log2(texel) —
    // one CONFIDENCE_LOSS_PER_LEVEL per level above the finest — because a
    // binary acceptance gate painted a razor-straight page-border seam. The
    // shader mottles this into a class strength; levels 0-4 classify at
    // descending strength, level 5+ (128 m texels) falls back entirely.
    expect(TERRAIN_PAGE_SPLAT_FINEST_TEXEL_METERS).toBe(4);
    expect(TERRAIN_PAGE_SPLAT_CONFIDENCE_LOSS_PER_LEVEL).toBe(0.2);
    expect(TERRAIN_PAGE_SPLAT_MINIMUM_CONFIDENCE).toBe(0.1);
    expect(terrainPageClassificationConfidence(0)).toBe(1);
    expect(terrainPageClassificationConfidence(4)).toBe(1);
    expect(terrainPageClassificationConfidence(8)).toBeCloseTo(0.8, 12);
    expect(terrainPageClassificationConfidence(16)).toBeCloseTo(0.6, 12);
    expect(terrainPageClassificationConfidence(32)).toBeCloseTo(0.4, 12);
    expect(terrainPageClassificationConfidence(64)).toBeCloseTo(0.2, 12);
    expect(terrainPageClassificationConfidence(128)).toBe(0);
    expect(() => terrainPageClassificationConfidence(Number.NaN)).toThrow(/texel size/u);
    expect(() => terrainPageClassificationConfidence(-1)).toThrow(/texel size/u);

    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      expect(source).toContain("let channelTexelMeters");
      expect(source).toContain("log2(max(channelTexelMeters, 4.0)");
      expect(source).toContain("if (confidence < 0.1 || uv.z <= 0.0)");
      expect(source).toContain("let terrainUsePageSplat = terrainPageSplat.w >= 0.1;");
      // The seam feather itself: class strength mottled by the cover noise,
      // fading toward the fallback's own composition in both material paths.
      expect(source).toContain("terrainPageSplat.w + terrainCoverNoise * 0.003");
      expect(source.match(/terrainClassStrength < 0\.996/gu)).toHaveLength(2);
      expect(source).toContain("* terrainClassComplement");
    });
  });

  it("uses a continuous macro fallback and retires sub-pixel material patterns", () => {
    // Fix-pack T2 re-pin: the fade now keys on the anisotropy-limited minor
    // footprint axis and runs 1.5 → 10 m (was 0.5 → 2 m on the major axis),
    // which converged every patterned channel to a flat constant within a few
    // hundred metres of slant range at flight grazing angles.
    expect(TERRAIN_MATERIAL_DETAIL_FULL_FOOTPRINT_METERS).toBe(1.5);
    expect(TERRAIN_MATERIAL_DETAIL_ZERO_FOOTPRINT_METERS).toBe(10);
    expect(terrainMaterialDetailWeight(0)).toBe(1);
    expect(terrainMaterialDetailWeight(1.5)).toBe(1);
    expect(terrainMaterialDetailWeight(5.75)).toBeCloseTo(0.5, 12);
    expect(terrainMaterialDetailWeight(10)).toBe(0);
    expect(terrainMaterialDetailWeight(20)).toBe(0);
    expect(() => terrainMaterialDetailWeight(-1)).toThrow(RangeError);

    expect(TERRAIN_FALLBACK_ALPINE_START_METERS).toBe(420);
    expect(TERRAIN_FALLBACK_ALPINE_END_METERS).toBe(980);
    // Wave R: 0.55 -> 0.85 — the classifier has no vegetated material
    // above ~900 m, so the weak alpine hand-over left distant fallback
    // mountains green.
    expect(TERRAIN_FALLBACK_ALPINE_ROCK_STRENGTH).toBe(0.85);
    expect(terrainFallbackRockCover(0, 0)).toBe(0);
    expect(terrainFallbackRockCover(420, 0)).toBe(0);
    expect(terrainFallbackRockCover(700, 0)).toBeCloseTo(0.425, 12);
    expect(terrainFallbackRockCover(980, 0)).toBeCloseTo(0.85, 12);
    expect(terrainFallbackRockCover(2_000, 1)).toBe(1);
    expect(() => terrainFallbackRockCover(0, 1.01)).toThrow(RangeError);

    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      expect(source).toContain("fn terrainSurfaceReference(materialIndex: i32)");
      expect(source).toContain("reference.rgb,");
      expect(source).toContain("layer.height = mix(0.5, albedoTexel.a, detailWeight);");
      expect(source).toContain("layer.cavity = mix(1.0, normalTexel.a, detailWeight);");
      expect(source).toContain(
        "layer.roughness = clamp(mix(reference.w, normalTexel.b, detailWeight)",
      );
      expect(source).toContain("1.50,\n  10.00,\n  terrainFootprint");
      expect(source).toContain(`var terrainAxis = ${SurfaceMaterial.Grass}.0;`);
      expect(source).toContain("let terrainUsePageSplat = false;");
      expect(source).toContain("if (!terrainUsePageSplat)");
      expect(source).toContain("terrainElevationDriver");
      // Wave Q: the alpine term left its no-splat if-block (it now scales by
    // the class complement), so the pinned indentation moved with it.
    expect(source).toContain("420.0,\n    980.0,");
      expect(source).not.toContain("fragmentInputs.terrainSplat.x");
      expect(source.match(
        /terrainBlend0 = 1\.0 - terrainThirdWeight;/gu,
      )).toHaveLength(2);
      expect(source.match(/terrainBlend2 = terrainThirdWeight;/gu)).toHaveLength(2);
    });
  });

  it("keeps the winter snow-to-slope-rock crossover continuous", () => {
    expect(resolveTerrainSlopeSnowCover(0.8, 0)).toEqual({
      materialId: SurfaceMaterial.Rock,
      weight: 0.8,
    });
    expect(resolveTerrainSlopeSnowCover(0, 0.8)).toEqual({
      materialId: SurfaceMaterial.Snow,
      weight: 0.8,
    });
    expect(resolveTerrainSlopeSnowCover(0.8, 0.8)).toEqual({
      materialId: SurfaceMaterial.Rock,
      weight: 0,
    });

    // Sweep through the old winner-takes-all boundary. The owner may change,
    // but only while its influence is zero; no near-unit cover can jump from
    // bright snow to dark rock between adjacent samples.
    const slopeRock = 0.86;
    const samples = Array.from({ length: 1_721 }, (_, index) =>
      resolveTerrainSlopeSnowCover(slopeRock, 0.774 + index * 0.0001));
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      expect(Math.abs(current.weight - previous.weight)).toBeLessThanOrEqual(0.000101);
      if (current.materialId !== previous.materialId) {
        expect(Math.max(current.weight, previous.weight)).toBeLessThanOrEqual(0.000101);
      }
    }
    expect(() => resolveTerrainSlopeSnowCover(-0.01, 0)).toThrow(RangeError);
    expect(() => resolveTerrainSlopeSnowCover(0, Number.NaN)).toThrow(RangeError);

    // Adversarial height ordering: a tall third layer used to suppress both
    // base materials even at epsilon cover, then normalise itself to one. The
    // zero-gated key and raw blend preserve the base partition through either
    // side of the Rock/Snow ownership boundary for both material caps.
    for (const baseKeys of [[0.5], [0.5, 0.5]] as const) {
      const zero = terrainCoverHeightBlendWeights(baseKeys, 1, 0, 0.06);
      const negative = terrainCoverHeightBlendWeights(baseKeys, 1, 1e-6, 0.06);
      const positive = terrainCoverHeightBlendWeights(baseKeys, 1, 1e-6, 0.06);
      expect(zero.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
      expect(negative.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
      expect(positive.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
      expect(negative).toEqual(positive);
      expect(negative.at(-1)).toBeLessThan(1e-3);
      zero.forEach((value, index) => {
        expect(Math.abs(negative[index]! - value)).toBeLessThan(1e-3);
      });
    }
    expect(() => terrainCoverHeightBlendWeights([], 0.5, 0.2, 0.06))
      .toThrow(RangeError);

    withPlugin((plugin) => {
      const source = Object.values(fragmentCode(plugin)).join("\n");
      expect(source).toContain(
        "let terrainCoverDelta = terrainSnowCover - terrainSlopeRock;",
      );
      expect(source).toContain("terrainCoverDelta > 0.0");
      expect(source).toContain("let terrainThirdWeight = abs(terrainCoverDelta);");
      expect(source).not.toContain("terrainSnowCover > terrainThirdWeight");
      expect(source).not.toContain("terrainSlopeRock) * terrainDetailWeight");
      expect(source.match(/terrainThirdWeight > 0\.0/gu)).toHaveLength(2);
      expect(source.match(
        /terrainBlend2 = terrainBlend2 \* terrainThirdWeight;/gu,
      )).toHaveLength(2);
      expect(source.match(
        /terrainKey2 = terrainThirdWeight \* \(terrainLayer2\.height \+ 1\.0\);/gu,
      )).toHaveLength(2);
      expect(source).not.toContain("terrainThirdWeight > 0.004");
    });
  });
});

describe("terrain seasonal palette (3-10)", () => {
  it("assertion 66: the response function takes dayOfYear and is anchored at the reference day", () => {
    for (const spec of SURFACE_MATERIALS) {
      const reference = surfaceSeasonalResponse(spec, TERRAIN_REFERENCE_DAY_OF_YEAR, 45);
      // Anchored exactly, the way R-13's kernel terms are: at the tuned
      // midsummer clock the shipped world must be untouched.
      expect(reference.tint[0], `${spec.name} r`).toBeCloseTo(1, 9);
      expect(reference.tint[1], `${spec.name} g`).toBeCloseTo(1, 9);
      expect(reference.tint[2], `${spec.name} b`).toBeCloseTo(1, 9);
      expect(reference.roughnessDelta, `${spec.name} roughness`).toBeCloseTo(0, 9);
    }
  });

  it("keeps rock, asphalt and concrete season-invariant while grass rides the year", () => {
    const days = [15, 80, 110, 171, 200, 260, 290, 340];
    for (const id of [SurfaceMaterial.Rock, SurfaceMaterial.Asphalt, SurfaceMaterial.Concrete]) {
      const spec = surfaceMaterialSpec(id);
      for (const day of days) {
        const response = surfaceSeasonalResponse(spec, day, 45);
        expect(response.tint, `${spec.name} on day ${day}`).toEqual([1, 1, 1]);
        expect(response.roughnessDelta).toBe(0);
      }
    }
    const grass = surfaceMaterialSpec(SurfaceMaterial.Grass);
    const autumn = surfaceSeasonalResponse(grass, 290, 45);
    const spring = surfaceSeasonalResponse(grass, 110, 45);
    // Autumn gold: red up, blue down. Spring flush: greener and darker.
    expect(autumn.tint[0]).toBeGreaterThan(1.05);
    expect(autumn.tint[2]).toBeLessThan(0.95);
    expect(spring.tint[1] / spring.tint[0]).toBeGreaterThan(1.05);
    expect(linearLuminance(spring.tint as [number, number, number]))
      .toBeLessThan(linearLuminance([1, 1, 1]));
    // Spring is wet: glossier. Winter is dry: matter.
    expect(spring.roughnessDelta).toBeLessThan(0);
    expect(surfaceSeasonalResponse(grass, 15, 45).roughnessDelta).toBeGreaterThan(0);
    // Southern hemisphere runs half a year out of phase.
    const southernAutumn = surfaceSeasonalResponse(grass, 290 - 182, -45);
    expect(southernAutumn.tint[0]).toBeGreaterThan(1.05);
  });

  it("R-26: the mean surface albedo the light rig reads moves with the season", () => {
    const summer = meanSeasonalSurfaceAlbedo(TERRAIN_REFERENCE_DAY_OF_YEAR, 45);
    const winter = meanSeasonalSurfaceAlbedo(15, 45);
    expect(linearLuminance(summer)).toBeGreaterThan(0.13);
    expect(linearLuminance(summer)).toBeLessThan(0.21);
    expect(linearLuminance(winter)).toBeGreaterThan(linearLuminance(summer) * 1.5);
    for (const albedo of [summer, winter]) {
      for (const channel of albedo) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("descends the snowline in winter and pins it at the reference day", () => {
    const seaLevel = 0;
    expect(seasonalSnowlineMeters(seaLevel, TERRAIN_REFERENCE_DAY_OF_YEAR, 45)).toBeCloseTo(
      1_520,
      6,
    );
    expect(seasonalSnowlineMeters(seaLevel, 15, 45)).toBeLessThan(1_200);
    // At the equator there is no seasonal swing to descend with.
    expect(seasonalSnowlineMeters(seaLevel, 15, 0)).toBeCloseTo(1_520, 6);
  });
});
