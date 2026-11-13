import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { DetailInstanceMaterialPlugin } from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import {
  SHRUB_THICKET_LONE_SHARE,
  SHRUB_THICKET_PEAK,
  densityField,
  shrubThicketAt,
} from "../src/render/webgpu/detail/densityField";
import {
  GROUND_OBJECT_REACH_GROW_SHARE,
  GROUND_OBJECT_REACH_METERS_PER_METER,
  GROUND_OBJECT_REACH_START_SCALE,
  SHRUB_BODY_CORE_GROW_SHARE,
  SHRUB_BODY_CORE_REACH_METERS_PER_METER,
  SHRUB_BODY_CORE_SCALE,
  SHRUB_BODY_CORE_SHADE,
  SHRUB_BODY_FAR_RADIUS_SHARE,
  SHRUB_BODY_GRAIN_FREQUENCY,
  SHRUB_BODY_GRAIN_NORMAL,
  SHRUB_BODY_GRAIN_TONE_FLOOR,
  SHRUB_BODY_GRAIN_TONE_SPAN,
  SHRUB_BODY_HEIGHT_SHARE,
  SHRUB_BODY_RADIUS_SHARE,
  SHRUB_BODY_SWAP_METERS_PER_METER,
  SHRUB_CARD_REACH_METERS_PER_METER,
  SHRUB_OPEN_DRAWN_PER_HECTARE,
  SHRUB_UNDERSTORY_DRAWN_PER_HECTARE,
  groundObjectDrawnScale,
  groundObjectReachMeters,
} from "../src/render/webgpu/detail/groundObjects";
import { TerrainBiome } from "../src/world";
import { hashSeed } from "../src/world/seed";
import {
  SCATTER_BLOCK_METERS,
  SCATTER_HALO_METERS,
  SHRUB_MAX_HEIGHT_METERS,
  SHRUB_THICKET_JITTER_SPAN,
  generateDetailCell,
} from "../src/render/webgpu/detail/generation";
import {
  detailPrototypeWorldRadius,
  detailRadialScaleForWorldRadius,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  SHRUB_CARD_LAYER_REPEAT,
  SHRUB_VARIANT_COUNTS,
  buildShrubBodyFarPrototype,
  buildShrubBodyPrototype,
  buildShrubPrototype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import {
  TREE_GROUND_SHADOW_FRAGMENT_WGSL,
  TREE_GROUND_SHADOW_VERTEX_WGSL,
} from "../src/render/webgpu/detail/TreeGroundShadowMaterial";
import { groundObjectShadowRecord } from "../src/render/webgpu/detail/treeGroundShadow";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { readSource } from "./support/sourceText";

/**
 * Bushes and boulders (2026-11-12, `groundObjects.ts`): the reach law, its two
 * shader transliterations, the body's shape, the shadow's record and the
 * thicket pattern. The records a build emits are pinned in
 * `render.webgpu-detail-presentation-build.test.ts`.
 */

/** One pixel on a 1080-line frame at the 60 degree vertical field of view, radians. */
const PIXEL_RADIANS = (60 * Math.PI) / 180 / 1080;

describe("ground object reach law", () => {
  it("draws an object while it stands about three pixels tall", () => {
    const threePixels = 1 / (3 * PIXEL_RADIANS);
    expect(threePixels).toBeGreaterThan(340);
    expect(threePixels).toBeLessThan(347);
    // The constant is rounded down from that: a little over three pixels.
    expect(GROUND_OBJECT_REACH_METERS_PER_METER).toBeLessThanOrEqual(threePixels);
    expect(GROUND_OBJECT_REACH_METERS_PER_METER).toBeGreaterThan(threePixels * 0.8);
  });

  it("reaches in proportion to height, up to the tier's cap", () => {
    expect(groundObjectReachMeters(1, 1_100)).toBe(GROUND_OBJECT_REACH_METERS_PER_METER);
    expect(groundObjectReachMeters(0.5, 1_100)).toBe(GROUND_OBJECT_REACH_METERS_PER_METER / 2);
    expect(groundObjectReachMeters(6, 1_100)).toBe(1_100);
    expect(groundObjectReachMeters(1.2, 150, SHRUB_CARD_REACH_METERS_PER_METER)).toBeCloseTo(108, 12);
    expect(groundObjectReachMeters(2, 150, SHRUB_CARD_REACH_METERS_PER_METER)).toBe(150);
    for (const [height, cap] of [[0, 1_100], [-1, 1_100], [Number.NaN, 1_100], [1, 0], [1, Number.NaN]]) {
      expect(groundObjectReachMeters(height!, cap!)).toBe(0);
    }
  });

  it("grows an object in from the edge of its reach and never pops", () => {
    const reach = 300;
    expect(groundObjectDrawnScale(reach, reach)).toBe(0);
    expect(groundObjectDrawnScale(reach + 1, reach)).toBe(0);
    expect(groundObjectDrawnScale(100, 0)).toBe(0);
    // Just inside the edge it is at its start scale: about one pixel tall.
    expect(groundObjectDrawnScale(reach - 1e-6, reach)).toBeCloseTo(GROUND_OBJECT_REACH_START_SCALE, 6);
    expect(GROUND_OBJECT_REACH_START_SCALE * 3).toBeLessThan(1.2);
    // Full size over all but the last share of the reach.
    const full = reach * (1 - GROUND_OBJECT_REACH_GROW_SHARE);
    expect(groundObjectDrawnScale(full, reach)).toBe(1);
    expect(groundObjectDrawnScale(0, reach)).toBe(1);
    let previous = 1;
    for (let distance = full; distance < reach; distance += 2) {
      const scale = groundObjectDrawnScale(distance, reach);
      expect(scale).toBeLessThanOrEqual(previous);
      expect(scale).toBeGreaterThanOrEqual(GROUND_OBJECT_REACH_START_SCALE);
      previous = scale;
    }
    // A reach too short for its grow share to span a metre grows in over one.
    expect(groundObjectDrawnScale(2.5, 3)).toBeCloseTo(
      GROUND_OBJECT_REACH_START_SCALE + (1 - GROUND_OBJECT_REACH_START_SCALE) * 0.5, 12);
  });

  it("keeps the solid body the bush's surface until its leaf cards can carry it", () => {
    // The body turns into the core when the bush stands about fifty pixels tall.
    const pixels = 1 / (SHRUB_BODY_CORE_REACH_METERS_PER_METER * PIXEL_RADIANS);
    expect(pixels).toBeGreaterThan(45);
    expect(pixels).toBeLessThan(60);
    // That is well inside the cards' own reach, so they are there to take over.
    expect(SHRUB_BODY_CORE_REACH_METERS_PER_METER).toBeLessThan(SHRUB_CARD_REACH_METERS_PER_METER * 0.5);
    expect(SHRUB_BODY_CORE_GROW_SHARE).toBeGreaterThan(0);
    expect(SHRUB_BODY_CORE_GROW_SHARE).toBeLessThanOrEqual(1);
    // The core sits inside the cards, which reach the bush's full size.
    expect(SHRUB_BODY_CORE_SCALE * SHRUB_BODY_RADIUS_SHARE).toBeLessThan(0.7);
    expect(SHRUB_BODY_CORE_SCALE * SHRUB_BODY_HEIGHT_SHARE).toBeLessThan(0.7);
    expect(SHRUB_BODY_CORE_SHADE).toBeGreaterThan(0.3);
    expect(SHRUB_BODY_CORE_SHADE).toBeLessThan(0.8);
    expect(SHRUB_BODY_HEIGHT_SHARE).toBeLessThan(1);
    expect(SHRUB_BODY_RADIUS_SHARE).toBeLessThan(1);
  });

  it("draws the body's shape only while it can be seen, and a stand-in past that", () => {
    // The clump hands over when the bush stands about ten pixels tall.
    const pixels = 1 / (SHRUB_BODY_SWAP_METERS_PER_METER * PIXEL_RADIANS);
    expect(pixels).toBeGreaterThan(8);
    expect(pixels).toBeLessThan(12);
    // Past the core's range, so the clump is the lit surface for a stretch,
    // and inside the reach, so the stand-in has a stretch of its own.
    expect(SHRUB_BODY_SWAP_METERS_PER_METER).toBeGreaterThan(SHRUB_BODY_CORE_REACH_METERS_PER_METER * 3);
    expect(SHRUB_BODY_SWAP_METERS_PER_METER).toBeLessThan(GROUND_OBJECT_REACH_METERS_PER_METER * 0.5);
    // One mound covers what the clump's three do between them.
    expect(SHRUB_BODY_FAR_RADIUS_SHARE).toBeGreaterThan(0.6);
    expect(SHRUB_BODY_FAR_RADIUS_SHARE).toBeLessThanOrEqual(1);
    // The stand-in is there from where the clump starts to shrink: at that
    // range the clump is still full size, so nothing shows the swap.
    const height = 1.4;
    const swap = groundObjectReachMeters(height, 1_100, SHRUB_BODY_SWAP_METERS_PER_METER);
    const standInStart = swap * (1 - GROUND_OBJECT_REACH_GROW_SHARE);
    expect(groundObjectDrawnScale(standInStart, swap)).toBeCloseTo(1, 12);
    expect(groundObjectDrawnScale(standInStart + 1, swap)).toBeLessThan(0.99);
    expect(groundObjectDrawnScale(standInStart, groundObjectReachMeters(height, 1_100))).toBe(1);
  });

  it("keeps the understory's old budget and opens the cap on open ground", () => {
    expect(SHRUB_UNDERSTORY_DRAWN_PER_HECTARE).toBe(60);
    expect(SHRUB_OPEN_DRAWN_PER_HECTARE).toBeGreaterThan(SHRUB_UNDERSTORY_DRAWN_PER_HECTARE * 3);
  });

  it("gives ground objects the tier's ground shadow range, within the mid band", () => {
    for (const [quality, mode] of [
      ["low", "performance"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"],
    ] as const) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      expect(profile.treeGroundShadowRangeMeters).toBeGreaterThan(
        profile.renderedDensityLaw.near.outerRadiusMeters);
      expect(profile.treeGroundShadowRangeMeters).toBeLessThanOrEqual(
        profile.renderedDensityLaw.mid.outerRadiusMeters);
    }
  });

  it("gives boulders that range too, but for the tier whose draw row cannot carry them that far", () => {
    for (const [quality, mode] of [
      ["low", "performance"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"],
    ] as const) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      // Further than a boulder went before it had a reach of its own.
      expect(profile.boulderRangeMeters).toBeGreaterThan(
        profile.renderedDensityLaw.near.outerRadiusMeters * 2);
      expect(profile.boulderRangeMeters).toBeLessThanOrEqual(profile.treeGroundShadowRangeMeters);
      if (profile.tier >= 1) {
        expect(profile.boulderRangeMeters).toBe(profile.treeGroundShadowRangeMeters);
      } else {
        // 250 m: a boulder up to 0.83 m tall keeps its whole three-pixel reach.
        expect(profile.boulderRangeMeters).toBe(250);
        expect(groundObjectReachMeters(0.83, profile.boulderRangeMeters)).toBeLessThan(250);
      }
    }
  });

  it("names the tallest bush the generator authors", () => {
    // A mature hazel. Its body's swap range is the furthest the body batch
    // draws, which is what the draw model prices it at.
    expect(SHRUB_MAX_HEIGHT_METERS).toBeCloseTo(3.35, 12);
    const generation = readSource("src/render/webgpu/detail/generation.ts");
    expect(generation).toContain(
      "export const SHRUB_MAX_HEIGHT_METERS = SHRUB_SAPLING_HEIGHT_METERS + SHRUB_HAZEL_GROWTH_METERS;");
    expect(generation).toMatch(
      /SHRUB_SAPLING_HEIGHT_METERS\s*\+ maturity \* \(species === "hazel" \? SHRUB_HAZEL_GROWTH_METERS : 2\.1\)\) \* heightFactor/u);
  });
});

describe("ground object shaders", () => {
  it("transliterates the reach law in the detail vertex stage, behind its own define", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new PBRMaterial("ground-object-test", scene);
      const plugin = new DetailInstanceMaterialPlugin(material);
      const vertex = plugin.getCustomCode("vertex", ShaderLanguage.WGSL)!;
      const position = vertex["CUSTOM_VERTEX_UPDATE_POSITION"]!;
      // min(height * metres per metre, cap), times the record's share of it.
      expect(position).toContain(
        "let detailSizeReach = min(\n  detailHeight * uniforms.detailSizeRange.x, uniforms.detailSizeRange.y)\n"
          + "  * (floor(floor(vertexInputs.instanceState.x * 255.0 + 0.5) / 2.0) / 127.0);",
      );
      // groundObjectDrawnScale: true camera distance, a grow stretch of at least a metre.
      expect(position).toContain(
        "(detailSizeReach - distance(detailInstancePositionW, scene.vEyePosition.xyz))\n"
          + "    / max(detailSizeReach * uniforms.detailSizeRange.z, 1.0),",
      );
      expect(position).toContain(
        "detailLocal = detailLocal * mix(uniforms.detailSizeRange.w, 1.0, detailSizeGrow);");
      // Past the reach the instance is collapsed in the vertex stage: no
      // fragment discard, so the opaque body keeps its early-Z.
      expect(position).toContain(
        "#ifdef DETAIL_SIZE_RANGE\n"
          + "if (detailSizeGrow <= 0.0 || detailInsideInner) { positionUpdated = vec3f(0.0, -100000.0, 0.0); }\n"
          + "#endif",
      );
      // A stand-in is collapsed the same way inside the range of the mesh it
      // stands in for: that mesh's reach times the share drawn at full size.
      expect(position).toContain(
        "let detailInnerReach = min(\n  detailHeight * uniforms.detailSizeInner.x, uniforms.detailSizeInner.y)\n"
          + "  * uniforms.detailSizeInner.z;",
      );
      expect(position).toContain(
        "let detailInsideInner =\n"
          + "  distance(detailInstancePositionW, scene.vEyePosition.xyz) < detailInnerReach;",
      );
      // The core: smaller, fully occluded and darker inside its range.
      expect(position).toContain(
        "detailLocal = detailLocal * mix(1.0, uniforms.detailSizeCore.w, detailCoreGrow);");
      expect(position).toContain("detailOcclusionOut = detailOcclusionOut * (1.0 - detailCoreGrow);");
      expect(position).toContain(
        `detailTintOut.rgb * mix(1.0, ${SHRUB_BODY_CORE_SHADE.toFixed(2)}, detailCoreGrow)`);
      // Everything the rule adds sits behind the define, so a material that
      // never asks for it compiles the shader it always did.
      const withoutRule = position.replace(/#ifdef DETAIL_SIZE_RANGE[\s\S]*?#endif\n?/gu, "");
      expect(withoutRule).not.toMatch(
        /detailSize(?:Range|Core|Inner|Reach|Grow)|detailCore(?:Reach|Grow)|detailInnerReach|detailInsideInner/u);
      expect(plugin.getUniforms().ubo!.map((entry) => entry.name))
        .toEqual(expect.arrayContaining(["detailSizeRange", "detailSizeCore", "detailSizeInner"]));
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("turns the define on only for a usable reach", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const plugin = new DetailInstanceMaterialPlugin(new PBRMaterial("ground-object-define", scene));
      const defines: Record<string, unknown> = {};
      plugin.prepareDefines(defines as never);
      expect(defines["DETAIL_SIZE_RANGE"]).toBe(false);
      plugin.setSizeRange(300, 1_100, 0.2, 0.35);
      plugin.prepareDefines(defines as never);
      expect(defines["DETAIL_SIZE_RANGE"]).toBe(true);
      for (const [metersPerMeter, cap] of [[0, 1_100], [300, 0], [Number.NaN, 1_100]]) {
        plugin.setSizeRange(metersPerMeter!, cap!, 0.2, 0.35);
        plugin.prepareDefines(defines as never);
        expect(defines["DETAIL_SIZE_RANGE"]).toBe(false);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("lights a bush's body by leaf clumps of a bush's size, and leaves a crown's as they were", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const plugin = new DetailInstanceMaterialPlugin(new PBRMaterial("ground-object-grain", scene));
      const fragment = plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!;
      // One grain for the tone and for the normal: the same scaled coordinate,
      // so each octave's footprint fade moves with its clump size.
      const albedo = fragment["CUSTOM_FRAGMENT_UPDATE_ALBEDO"]!;
      const lights = fragment["CUSTOM_FRAGMENT_BEFORE_LIGHTS"]!;
      for (const [code, name] of [[albedo, "detailClusterCoord"], [lights, "crownClusterCoord"]] as const) {
        expect(code).toContain(
          `let ${name} = (fragmentInputs.vPositionW.xz + uniforms.detailWorldOrigin.xy\n`
            + "  + vec2f(fragmentInputs.vPositionW.y * 0.53, fragmentInputs.vPositionW.y * 0.31))\n"
            + "  * uniforms.detailClusterGrain.x;",
        );
      }
      expect(albedo).toContain(
        "* (uniforms.detailClusterGrain.y + uniforms.detailClusterGrain.z * detailClusterMix);");
      expect(lights).toContain("  * uniforms.detailClusterGrain.w;\nnormalW = normalize(");
      expect(plugin.getUniforms().ubo!.map((entry) => entry.name)).toContain("detailClusterGrain");

      const grain = (): readonly number[] => {
        let written: readonly number[] = [];
        plugin.bindForSubMesh({
          updateFloat: () => undefined,
          updateFloat2: () => undefined,
          updateFloat3: () => undefined,
          updateFloat4: (name: string, x: number, y: number, z: number, w: number) => {
            if (name === "detailClusterGrain") written = [x, y, z, w];
          },
          updateFloatArray: () => undefined,
          updateArray: () => undefined,
          updateVector3: () => undefined,
          updateVector4: () => undefined,
          updateColor3: () => undefined,
          updateColor4: () => undefined,
          updateMatrix: () => undefined,
          setTexture: () => undefined,
        } as never);
        return written;
      };
      // Until told otherwise a material is a crown: the tone and the normal
      // this path had before a bush's body shared it.
      expect(grain()).toEqual([1, 0.84, 0.32, 1]);
      plugin.setClusterGrain(
        SHRUB_BODY_GRAIN_FREQUENCY,
        SHRUB_BODY_GRAIN_TONE_FLOOR,
        SHRUB_BODY_GRAIN_TONE_SPAN,
        SHRUB_BODY_GRAIN_NORMAL,
      );
      expect(grain()).toEqual([
        SHRUB_BODY_GRAIN_FREQUENCY,
        SHRUB_BODY_GRAIN_TONE_FLOOR,
        SHRUB_BODY_GRAIN_TONE_SPAN,
        SHRUB_BODY_GRAIN_NORMAL,
      ]);
    } finally {
      scene.dispose();
      engine.dispose();
    }

    // The mean tone is a crown's, so a body past the grain's reach, and its
    // stand-in, are the colour they were.
    expect(SHRUB_BODY_GRAIN_TONE_FLOOR + SHRUB_BODY_GRAIN_TONE_SPAN / 2).toBeCloseTo(0.84 + 0.32 / 2, 12);
    // The shader's two octaves are 1 / 1.35 m and 1 / 3.7 m on a crown. On a
    // bush the coarse one is smaller than a small bush and still two pixels
    // wide at 60 m, and the fine one is two pixels wide at 20 m, where the
    // body takes over from the core.
    const coarse = 1 / (1.35 * SHRUB_BODY_GRAIN_FREQUENCY);
    const fine = 1 / (3.7 * SHRUB_BODY_GRAIN_FREQUENCY);
    expect(coarse).toBeLessThan(0.25);
    expect(coarse / (60 * PIXEL_RADIANS)).toBeGreaterThan(2);
    expect(fine / (SHRUB_BODY_CORE_REACH_METERS_PER_METER * PIXEL_RADIANS)).toBeGreaterThan(2);
    // Both bodies take it, so nothing changes where the stand-in takes over.
    const runtime = readSource("src/render/webgpu/detail/WorldDetailRuntime.ts");
    expect(runtime).toMatch(
      /const createBodyMaterial = [\s\S]*?setClusterGrain\(\s*SHRUB_BODY_GRAIN_FREQUENCY,\s*SHRUB_BODY_GRAIN_TONE_FLOOR,\s*SHRUB_BODY_GRAIN_TONE_SPAN,\s*SHRUB_BODY_GRAIN_NORMAL,\s*\)/u,
    );
    expect(runtime.match(/setClusterGrain\(/gu)?.length).toBe(1);
  });

  it("draws a bush's or boulder's shadow by the same reach, with no trunk and no handover", () => {
    const vertex = TREE_GROUND_SHADOW_VERTEX_WGSL;
    expect(vertex).toContain("let groundObject = vertexInputs.instanceState.y * 255.0 < 0.5;");
    expect(vertex).toContain(
      "let objectReach = min(height * uniforms.treeShadowObjects.x, uniforms.treeShadowObjects.y)\n"
        + "    * (floor(floor(vertexInputs.instanceState.x * 255.0 + 0.5) / 2.0) / 127.0);",
    );
    expect(vertex).toContain(
      "(objectReach - distanceMeters) / max(objectReach * uniforms.treeShadowObjects.z, 1.0),");
    expect(vertex).toContain("let drawn = select(stemDrawn, objectDrawn, groundObject);");
    expect(vertex).toContain("realEdge > 0.0 && !groundObject);");
    expect(vertex).toMatch(/let trunkOpacity = select\(\n[\s\S]*?0\.0,\n\s*groundObject\);/u);
  });

  it("leaves the object's own body out of its shadow, as the body is drawn", () => {
    const vertex = TREE_GROUND_SHADOW_VERTEX_WGSL;
    // The body's size right now is the detail plugin's core rule, on the same
    // true camera distance.
    expect(vertex).toContain(
      "let coreReach = min(height * uniforms.treeShadowCore.x, uniforms.treeShadowCore.y);");
    expect(vertex).toContain(
      "(coreReach - distanceMeters) / max(coreReach * uniforms.treeShadowCore.z, 1.0), 0.0, 1.0);");
    expect(vertex).toContain(
      "1.0, mix(1.0, uniforms.treeShadowCore.w, vertexInputs.instanceState.w), coreGrow);");
    // A tree's shadow has no body to leave out: a negative radius says so.
    expect(vertex).toContain("select(-1.0, crownRadius * ownScale, groundObject));");
    expect(vertex).toContain(
      "vertexOutputs.shadowOwn = vec4f(-eyeFoot * ownStartThrow, -eyeFoot * ownEndThrow);");
    const fragment = TREE_GROUND_SHADOW_FRAGMENT_WGSL;
    expect(fragment).toContain("ownRadius > 0.0);");
    expect(fragment).toContain("max(crown * notOwn, trunk)");
    expect(fragment).toContain("(1.0 - sky * notOwn)");
  });

  it("feeds both shaders the same law from the runtime", () => {
    const runtime = readSource("src/render/webgpu/detail/WorldDetailRuntime.ts");
    // The body and its shadow: one reach law, one cap.
    expect(runtime).toMatch(
      /setGroundObjectReach\(\s*GROUND_OBJECT_REACH_METERS_PER_METER,\s*groundObjectRangeMeters,\s*GROUND_OBJECT_REACH_GROW_SHARE,\s*\)/u,
    );
    // The core rule, restated per metre of the body's height, to both.
    const core = /\(\s*SHRUB_BODY_CORE_REACH_METERS_PER_METER \/ SHRUB_BODY_HEIGHT_SHARE,\s*profile\.renderedDensityLaw\.near\.outerRadiusMeters,\s*SHRUB_BODY_CORE_GROW_SHARE,\s*SHRUB_BODY_CORE_SCALE,\s*\)/gu;
    expect(runtime.match(core)?.length).toBe(2);
    expect(runtime).toContain("entry.plugin.setSizeCore(");
    expect(runtime).toContain("this.treeGroundShadow?.setGroundObjectCore(");
    // The stand-in starts where the clump starts to shrink: the clump's own
    // reach law and cap, and the share of it drawn at full size.
    expect(runtime).toMatch(
      /entry\.plugin\.setSizeInner\(\s*entry\.inner\.metersPerMeter,\s*groundObjectRangeMeters,\s*1 - entry\.inner\.growShare,\s*\)/u,
    );
    expect(runtime).toMatch(
      /farMaterial,\s*GROUND_OBJECT_REACH_METERS_PER_METER,\s*GROUND_OBJECT_REACH_GROW_SHARE,\s*GROUND_OBJECT_REACH_START_SCALE,\s*"tier",\s*false,\s*\{\s*metersPerMeter: SHRUB_BODY_SWAP_METERS_PER_METER,\s*growShare: GROUND_OBJECT_REACH_GROW_SHARE,\s*\},\s*\)/u,
    );
    // The tier's two bush and boulder rules reach the build and the rock
    // material, and a change of either rebuilds the batches.
    expect(runtime).toMatch(
      /const boulderRangeMeters = Math\.min\(\s*groundObjectRangeMeters,\s*Math\.max\(0, profile\.boulderRangeMeters\),\s*\)/u);
    expect(runtime).toContain(
      "const openDrawnPerHectare = shrubOpenDrawnPerHectare(profile.vegetationDensity);");
    expect(runtime).toContain(
      ': entry.cap === "boulder" ? boulderRangeMeters : groundObjectRangeMeters,');
    // A build issued before the first update draws to the reference cap,
    // not to a cap of nothing.
    expect(runtime).toContain("private shrubOpenDrawnPerHectare = SHRUB_OPEN_DRAWN_PER_HECTARE;");
    expect(runtime.match(/boulderRangeMeters: this\.boulderRangeMeters,/gu)?.length).toBe(2);
    expect(runtime.match(/shrubOpenDrawnPerHectare: this\.shrubOpenDrawnPerHectare,/gu)?.length)
      .toBe(2);
    expect(runtime.match(/^\s*this\.boulderRangeMeters,\n\s*this\.shrubOpenDrawnPerHectare,$/gmu)?.length)
      .toBe(2);
    expect(runtime).toMatch(
      /rockMaterial,\s*GROUND_OBJECT_REACH_METERS_PER_METER,\s*GROUND_OBJECT_REACH_GROW_SHARE,\s*GROUND_OBJECT_REACH_START_SCALE,\s*"boulder",\s*\)/u);
    expect(runtime).toMatch(
      /bodyMaterial,\s*SHRUB_BODY_SWAP_METERS_PER_METER,\s*GROUND_OBJECT_REACH_GROW_SHARE,\s*GROUND_OBJECT_REACH_START_SCALE,\s*"tier",\s*true,\s*\)/u,
    );
  });
});

describe("bush body prototype", () => {
  it("is a clump of three low-polygon mounds on the opaque crown layer", () => {
    const body = buildShrubBodyPrototype(1);
    // One mound of 30 triangles and two of 15.
    expect(body.indices.length / 3).toBe(60);
    expect(body.positions.length / 3).toBe(48);
    let minY = Infinity;
    let maxY = -Infinity;
    let maxRadius = 0;
    for (let index = 0; index < body.positions.length; index += 3) {
      minY = Math.min(minY, body.positions[index + 1]!);
      maxY = Math.max(maxY, body.positions[index + 1]!);
      maxRadius = Math.max(maxRadius, Math.hypot(body.positions[index]!, body.positions[index + 2]!));
    }
    // It starts below the ground, so no slope shows a gap under it, and its
    // top is the unit height the record's height lane scales.
    expect(minY).toBeLessThan(-0.1);
    expect(maxY).toBeCloseTo(1, 6);
    expect(maxRadius).toBeGreaterThan(0.85);
    expect(maxRadius).toBeLessThan(1.3);
    // Not one dome: the outline is wider one way than the other.
    const span = (axis: 0 | 2): number => {
      let low = Infinity;
      let high = -Infinity;
      for (let index = axis; index < body.positions.length; index += 3) {
        low = Math.min(low, body.positions[index]!);
        high = Math.max(high, body.positions[index]!);
      }
      return high - low;
    };
    expect(Math.abs(span(0) - span(2))).toBeGreaterThan(0.05);
    // Deterministic from its seed.
    expect(buildShrubBodyPrototype(1).positions).toEqual(body.positions);
  });

  it("has a 12-triangle stand-in of the same height for when the shape cannot be seen", () => {
    const far = buildShrubBodyFarPrototype(1);
    expect(far.indices.length / 3).toBe(12);
    let minY = Infinity;
    let maxY = -Infinity;
    let maxRadius = 0;
    for (let index = 0; index < far.positions.length; index += 3) {
      minY = Math.min(minY, far.positions[index + 1]!);
      maxY = Math.max(maxY, far.positions[index + 1]!);
      maxRadius = Math.max(maxRadius, Math.hypot(far.positions[index]!, far.positions[index + 2]!));
    }
    // The same foot below the ground and the same unit height as the clump,
    // so one height lane serves both records of a bush.
    expect(minY).toBeLessThan(-0.1);
    expect(maxY).toBeCloseTo(1, 6);
    expect(maxRadius).toBeGreaterThan(0.7);
    expect(maxRadius).toBeLessThan(1.3);
    expect(far.indices.length).toBeLessThan(buildShrubBodyPrototype(1).indices.length / 4);
    expect(buildShrubBodyFarPrototype(1).positions).toEqual(far.positions);
  });
});

describe("bush leaf cards", () => {
  const SPECIES = ["juniper", "hazel", "sage"] as const;

  it("stand on the bush's body at every size the bush comes in", () => {
    const seed = 7;
    const body = buildShrubBodyPrototype(seed);
    for (const species of SPECIES) {
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        const cards = buildShrubPrototype(species, variant, seed);
        // The cards' radial unit is the body's, over the body's share of the
        // bush's radius: so a point at the same x in both prototypes is the
        // same place in the world, for a squat bush and a tall one.
        expect(cards.radialUnit).toBeCloseTo(body.boundingRadius / SHRUB_BODY_RADIUS_SHARE, 12);
        for (const [height, radius] of [[0.6, 0.48], [3.2, 1.7]] as const) {
          const cardMetersPerUnit = detailPrototypeWorldRadius(
            1, height, detailRadialScaleForWorldRadius(radius, height, cards.radialUnit!));
          const bodyHeight = height * SHRUB_BODY_HEIGHT_SHARE;
          const bodyMetersPerUnit = detailPrototypeWorldRadius(
            1,
            bodyHeight,
            detailRadialScaleForWorldRadius(
              radius * SHRUB_BODY_RADIUS_SHARE, bodyHeight, body.boundingRadius),
          );
          expect(cardMetersPerUnit).toBeCloseTo(bodyMetersPerUnit, 9);
        }

        // 26 to 32 cards, four vertices each.
        const cardCount = cards.positions.length / 12;
        expect(cards.triangleCount).toBe(cardCount * 2);
        expect(cardCount).toBeGreaterThanOrEqual(26);
        expect(cardCount).toBeLessThanOrEqual(32);
        let low = 0;
        let middle = 0;
        let high = 0;
        let offAxis = 0;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let card = 0; card < cardCount; card += 1) {
          let x = 0;
          let y = 0;
          let z = 0;
          for (let corner = 0; corner < 4; corner += 1) {
            const at = (card * 4 + corner) * 3;
            x += cards.positions[at]! / 4;
            y += cards.positions[at + 1]! / 4;
            z += cards.positions[at + 2]! / 4;
            minY = Math.min(minY, cards.positions[at + 1]!);
            maxY = Math.max(maxY, cards.positions[at + 1]!);
          }
          // In the body's units a card's centre is on or just off the body:
          // inside the body's own reach plus the card's stand-off, and under
          // the bush's height.
          expect(Math.hypot(x, z)).toBeLessThan(body.boundingRadius * 1.15);
          expect(y).toBeLessThan(1);
          if (y < 0.4) low += 1;
          else if (y <= 0.65) middle += 1;
          else high += 1;
          if (Math.hypot(x, z) > body.boundingRadius * 0.35) offAxis += 1;
        }
        // They cover the body from its skirt to its top, and stand round its
        // outside; on bare stems most of them sat near the axis.
        // Fewest up top, where the mounds have the least surface.
        expect(low).toBeGreaterThanOrEqual(8);
        expect(middle).toBeGreaterThanOrEqual(4);
        expect(high).toBeGreaterThanOrEqual(3);
        expect(offAxis / cardCount).toBeGreaterThan(0.6);
        // The topmost leaf is the bush's height, and none is far underground.
        expect(maxY).toBeCloseTo(1, 6);
        expect(minY).toBeGreaterThan(-0.12);
      }
    }
  });

  it("show each layer twice over, so a leaf is a leaf's size", () => {
    expect(SHRUB_CARD_LAYER_REPEAT).toBe(2);
    for (const species of SPECIES) {
      const cards = buildShrubPrototype(species, 0, 3);
      for (let card = 0; card < cards.positions.length / 12; card += 1) {
        const us = [0, 1, 2, 3].map((corner) => cards.uvs[(card * 4 + corner) * 2]!);
        const vs = [0, 1, 2, 3].map((corner) => cards.uvs[(card * 4 + corner) * 2 + 1]!);
        expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(SHRUB_CARD_LAYER_REPEAT, 6);
        expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(SHRUB_CARD_LAYER_REPEAT, 6);
        // Each card starts somewhere else on the layer.
        expect(Math.min(...us)).toBeGreaterThanOrEqual(0);
        expect(Math.min(...us)).toBeLessThan(1);
      }
      // A card's edge on the typical bush (radius 0.65 of height; x and z
      // are in the body's units, y in the bush's height): under a third of
      // the bush's height. A hazel leaf is two fifths of its layer, so a
      // fifth of a card: about 9 cm on a 1.5 m bush.
      const across = 0.65 / cards.radialUnit!;
      const edge = Math.hypot(
        (cards.positions[3]! - cards.positions[0]!) * across,
        cards.positions[4]! - cards.positions[1]!,
        (cards.positions[5]! - cards.positions[2]!) * across,
      );
      expect(edge).toBeGreaterThan(0.1);
      expect(edge).toBeLessThan(0.34);
    }
    // The atlas wraps, which the repeat needs: nothing sets it to clamp.
    const atlas = readSource("src/render/webgpu/detail/FoliageAtlas.ts");
    expect(atlas).not.toMatch(/CLAMP_ADDRESSMODE/u);
  });
});

describe("ground object shadow record", () => {
  const source = {
    x: 1_204.5,
    y: 88.25,
    z: -730.75,
    normal: { x: 0.3, y: 2, z: -0.4 },
    heightMeters: 1.1,
    radiusMeters: 0.7,
    opacity: 0.75,
    standDensityShare: 0.4,
    outlinePhase: 0.6,
    reachShare: 0.5,
    bodyHasCore: true,
  };

  it("carries the solid's size, a dome's shape, and the lanes the shader reads", () => {
    const record = groundObjectShadowRecord(source, { x: 1_000, y: 80, z: -700 });
    expect([record.x, record.y, record.z]).toEqual([204.5, 8.25, -30.75]);
    expect(record.heightScaleMeters).toBe(1.1);
    expect(record.radialScale * record.heightScaleMeters).toBeCloseTo(0.7, 12);
    // Variant 0 is what tells the shader this is not a tree.
    expect(record.variant).toBe(0);
    // A dome from the ground up: centre and half-depth both at half its height.
    expect(record.tint).toEqual([0.5, 0.5, 0.75, 0.4]);
    expect(record.fade).toBe(0.5);
    expect(record.windPhase).toBe(0.6);
    expect(record.windResponse).toBe(1);
    expect(groundObjectShadowRecord({ ...source, bodyHasCore: false }, { x: 0, y: 0, z: 0 }).windResponse)
      .toBe(0);
  });

  it("lies on the ground's slope, and on level ground when given no usable normal", () => {
    const up = (q: readonly number[]): number[] => {
      const [x, y, z, w] = q as [number, number, number, number];
      return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    };
    const length = Math.hypot(0.3, 2, -0.4);
    const tilted = up(groundObjectShadowRecord(source, { x: 0, y: 0, z: 0 }).quaternion);
    expect(tilted[0]).toBeCloseTo(0.3 / length, 6);
    expect(tilted[1]).toBeCloseTo(2 / length, 6);
    expect(tilted[2]).toBeCloseTo(-0.4 / length, 6);
    for (const normal of [{ x: 0, y: 0, z: 0 }, { x: 0.2, y: -1, z: 0 }]) {
      const level = up(groundObjectShadowRecord({ ...source, normal }, { x: 0, y: 0, z: 0 }).quaternion);
      expect(level[0]).toBeCloseTo(0, 9);
      expect(level[1]).toBeCloseTo(1, 9);
      expect(level[2]).toBeCloseTo(0, 9);
    }
  });

  it("clamps what a byte lane cannot hold", () => {
    const record = groundObjectShadowRecord(
      { ...source, opacity: 1.4, standDensityShare: -0.2, reachShare: 3 }, { x: 0, y: 0, z: 0 });
    expect(record.tint[2]).toBe(1);
    expect(record.tint[3]).toBe(0);
    expect(record.fade).toBe(1);
  });
});

describe("thickets", () => {
  const seed = hashSeed("ground-objects-thickets");

  it("is a pure function of the seed and the place, between a lone share and a peak", () => {
    let cores = 0;
    let clear = 0;
    let sum = 0;
    let count = 0;
    for (let z = -4_000; z < 4_000; z += 37) {
      for (let x = -4_000; x < 4_000; x += 41) {
        const sample = shrubThicketAt(seed, x, z);
        expect(sample.core).toBeGreaterThanOrEqual(0);
        expect(sample.core).toBeLessThanOrEqual(1);
        expect(sample.factor).toBeCloseTo(
          SHRUB_THICKET_LONE_SHARE + (SHRUB_THICKET_PEAK - SHRUB_THICKET_LONE_SHARE) * sample.core, 12);
        if (sample.core > 0.99) cores += 1;
        if (sample.core < 0.01) clear += 1;
        sum += sample.factor;
        count += 1;
      }
    }
    expect(shrubThicketAt(seed, 123.5, -77.25)).toEqual(shrubThicketAt(seed, 123.5, -77.25));
    // Another world has its thickets somewhere else.
    const other = hashSeed("another");
    let moved = 0;
    for (let x = 0; x < 4_000; x += 53) {
      if (Math.abs(shrubThicketAt(other, x, 310).core - shrubThicketAt(seed, x, 310).core) > 0.5) moved += 1;
    }
    expect(moved).toBeGreaterThan(5);
    // Most open ground has no thicket on it, a real share of it is solid
    // thicket, and the two roughly cancel: the land carries about as many
    // bushes as an even spread would.
    expect(clear / count).toBeGreaterThan(0.5);
    expect(cores / count).toBeGreaterThan(0.08);
    expect(cores / count).toBeLessThan(0.4);
    expect(sum / count).toBeGreaterThan(0.6);
    expect(sum / count).toBeLessThan(1.6);
  });

  it("varies by region: scrub country next to clean grassland", () => {
    // Thicket cover over 500 m squares: some nearly bare, some mostly scrub.
    const shares: number[] = [];
    for (let blockZ = -8; blockZ < 8; blockZ += 1) {
      for (let blockX = -8; blockX < 8; blockX += 1) {
        let cores = 0;
        let count = 0;
        for (let z = 0; z < 500; z += 25) {
          for (let x = 0; x < 500; x += 25) {
            if (shrubThicketAt(seed, blockX * 500 + x, blockZ * 500 + z).core > 0.5) cores += 1;
            count += 1;
          }
        }
        shares.push(cores / count);
      }
    }
    shares.sort((a, b) => a - b);
    expect(shares[Math.floor(shares.length * 0.1)]!).toBeLessThan(0.08);
    expect(shares[Math.floor(shares.length * 0.9)]!).toBeGreaterThan(0.3);
  });

  it("applies to open country's bushes and leaves a closed stand's understory even", () => {
    let open = 0;
    let closed = 0;
    let closedShare = 0;
    let openShare = 0;
    for (let z = -12_000; z <= 12_000; z += 300) {
      for (let x = -12_000; x <= 12_000; x += 300) {
        const sample = densityField(seed, {
          x,
          z,
          heightMeters: 220,
          seaLevelMeters: 0,
          slope: 0.04,
          moisture: 0.62,
          dayOfYear: 172,
          filterWidthMeters: 0,
        });
        expect(sample.shrubThicketShare).toBeGreaterThanOrEqual(0);
        expect(sample.shrubThicketShare).toBeLessThanOrEqual(1);
        if (sample.shrubStemsPerSquareMeter <= 0) continue;
        if (sample.canopyClosure > 0.8) {
          closed += 1;
          closedShare += sample.shrubThicketShare;
        } else if (sample.canopyClosure < 0.05) {
          open += 1;
          openShare += sample.shrubThicketShare;
        }
      }
    }
    expect(open).toBeGreaterThan(50);
    expect(closed).toBeGreaterThan(50);
    expect(openShare / open).toBeGreaterThan(0.6);
    expect(closedShare / closed).toBeLessThan(0.15);
  });

  it("gives neighbouring pages the same bushes along the edge they share", () => {
    // A thicket's stem may stand outside its own subcell, so outside its
    // block: by half a subcell for each subcell of span past the first, and a
    // sparse block is one subcell. A page reads one block past its halo, so
    // it sees every stem that can land in the halo while that reach is no
    // more than a block less the halo.
    expect(((SHRUB_THICKET_JITTER_SPAN - 1) / 2) * SCATTER_BLOCK_METERS)
      .toBeLessThanOrEqual(SCATTER_BLOCK_METERS - SCATTER_HALO_METERS);

    // Then the pages' size does not matter: a square generated as one page
    // and as four holds the same stems, each exactly once. Solid thicket
    // country, and thin country whose blocks are a subcell or two.
    type Stem = { readonly id: string };
    const byId = (list: readonly Stem[]): readonly Stem[] =>
      [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const SMALL = 256;
    for (const [moisture, enough, enoughAlongSeams] of [[0.8, 3_000, 150], [0.26, 200, 15]] as const) {
      const generate = (cellX: number, cellZ: number, cellSizeMeters: number) => generateDetailCell({
        worldSeed: "infrastructure-plants",
        cellX,
        cellZ,
        cellSizeMeters,
        terrainSample: () => ({
          height: 40,
          slope: 0.02,
          moisture,
          biome: TerrainBiome.FOREST,
          airportInfluence: 0,
        }),
        seaLevelMeters: 0,
      });
      let alongSeams = 0;
      let total = 0;
      for (const [squareX, squareZ] of [[0, 0], [1, 5], [-2, 3]] as const) {
        const whole = generate(squareX, squareZ, SMALL * 2);
        const quarters = [0, 1].flatMap((dz) => [0, 1].map((dx) => (
          generate(squareX * 2 + dx, squareZ * 2 + dz, SMALL)
        )));
        for (const kind of ["shrubs", "trees"] as const) {
          const parts: readonly Stem[] = quarters.flatMap((quarter): readonly Stem[] => quarter[kind]);
          expect(new Set(parts.map((stem) => stem.id)).size).toBe(parts.length);
          expect(byId(parts)).toEqual(byId(whole[kind]));
        }
        const seamX = (squareX * 2 + 1) * SMALL;
        const seamZ = (squareZ * 2 + 1) * SMALL;
        for (const shrub of whole.shrubs) {
          total += 1;
          if (
            Math.abs(shrub.x - seamX) < SCATTER_HALO_METERS
            || Math.abs(shrub.z - seamZ) < SCATTER_HALO_METERS
          ) alongSeams += 1;
        }
      }
      // Armed: bushes stand in the band the pages must agree on.
      expect(total).toBeGreaterThan(enough);
      expect(alongSeams).toBeGreaterThan(enoughAlongSeams);
    }
  });
});
