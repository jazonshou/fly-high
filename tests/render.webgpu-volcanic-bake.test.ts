import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { LAND_COVER_SPLAT_BAKE_WGSL } from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  SPLAT_JOB_FLOATS,
  terrainPageSplatWgsl,
} from "../src/render/webgpu/terrain/PageOcclusionBake";
import {
  SurfaceMaterial,
  volcanicFallbackMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  TerrainClipmapSystem,
  type TerrainComputeFactory,
} from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import { VOLCANIC_OVERLAY_WGSL } from "../src/render/webgpu/terrain/VolcanicOverlayKernel";
import { createWorld } from "../src/world";

/**
 * Volcanic land, phase 2: the GPU wiring of the splat bake.
 *
 * The PLUMBING: one sample of the landform include's ground per bake texel, at
 * the kernel's own page-local coordinates and the page's landform base,
 * reaching the classifier's three inputs; the low tier's remap carried as
 * data; and the closure lane thinned only where the ground is volcanic. Parity
 * off volcanic ground follows from the classifier's own proof
 * (tests/render.webgpu-land-cover-volcanic.test.ts): every new term is zero or
 * identity there. The ground's values are the overlay's own parity
 * (tests/gpu/volcanic-overlay-parity.test.ts).
 */

const fnCount = (source: string, name: string): number =>
  [...source.matchAll(new RegExp(`\\bfn ${name}\\(`, "gu"))].length;

describe("volcanic land (phase 2): the splat bake", () => {
  const bake = LAND_COVER_SPLAT_BAKE_WGSL;
  const main = bake.slice(bake.indexOf("fn bakeSplat("));

  it("composes the landform include's ground sampler into the page-splat bake exactly once", () => {
    const composed = terrainPageSplatWgsl();
    expect(composed.split(VOLCANIC_OVERLAY_WGSL)).toHaveLength(2);
    expect(fnCount(composed, "terrainVolcanicGround")).toBe(1);
    expect(composed).toContain(
      "fn terrainVolcanicGround(base: vec4f, local: vec2f, filterWidth: f32) -> vec3f {");
  });

  it("samples the ground ONCE per texel, at the kernel's page-local point", () => {
    const call = "splatVolcanicGround = terrainVolcanicGround(\n"
      + "    splatVolcanicBase(), vec2f(localX, localZ), job.shape.x);";
    expect(bake.split("terrainVolcanicGround(")).toHaveLength(2);
    expect(main).toContain(call);
    // Same point and frame as the province and the moisture chains: localX/Z
    // are metres from the kernel page origin the job selected.
    expect(main.indexOf("kSelectPage(u32(job.shape.z));")).toBeLessThan(main.indexOf(call));
    expect(main).toContain("let localX = job.placement.x + (f32(id.x) + 0.5) * job.shape.x;");
    expect(main.indexOf("let province = terrainClimateProvince(localX, localZ);"))
      .toBeLessThan(main.indexOf(call));
    // Before any canopy, tap or classification reads it, and never inside a loop.
    expect(main.indexOf(call)).toBeLessThan(main.indexOf("let canopy = splatCanopy("));
    expect(main.indexOf(call)).toBeLessThan(main.indexOf("for (var tap"));
    expect(bake).toContain("var<private> splatVolcanicGround: vec3f;");
  });

  it("measures from the selected page's landform base row", () => {
    expect(bake).toContain(
      "fn splatVolcanicBase() -> vec4f {\n  return terrainKernelPages[kPageIndex].landformBase;\n}");
    expect(bake.split("splatVolcanicBase()")).toHaveLength(3);
  });

  it("feeds the classifier's three inputs from that sample at every tap", () => {
    const input = bake.slice(bake.indexOf("fn splatLandCoverInput("), bake.indexOf("fn splatClassify("));
    expect(input).toContain("input.lavaCover = splatVolcanicGround.x;");
    expect(input).toContain("input.tephraCover = splatVolcanicGround.y;");
    expect(input).toContain("input.volcanicAge = splatVolcanicGround.z;");
    expect(input).toContain("return input;");
    expect(bake).toContain(
      "return classifyLandCover(splatLandCoverInput(job, localX, localZ, shift, tap, province, sandCover));");
  });

  it("thins the closure lane by the bare share on volcanic ground only", () => {
    expect(main).toContain("var closure = canopy.x;");
    expect(main).toContain("if (splatVolcanicGround.x > 0.0 || splatVolcanicGround.y > 0.0) {");
    expect(main).toMatch(
      /closure = closure \* \(1\.0 - landCoverVolcanicBareShare\(\s*splatLandCoverInput\(job, localX, localZ, job\.placement\.z, centreTap, province, sandCover\)\)\);/u);
    expect(main).toContain(
      "textureStore(splatWeightLo, texel, vec4f(aligned.weightsLo.xyz, closure));");
  });
});

describe("volcanic land (phase 2): tier 0's remap, as data", () => {
  const bake = LAND_COVER_SPLAT_BAKE_WGSL;

  it("carries the datum in a seventh job lane, after the airports', that the host's stride counts", () => {
    const struct = bake.slice(bake.indexOf("struct SplatJob {"), bake.indexOf("};", bake.indexOf("struct SplatJob {")));
    const lanes = [...struct.matchAll(/^\s+(\w+): vec4f,$/gmu)].map((match) => match[1]);
    expect(lanes).toEqual(["slots", "shape", "placement", "airport", "runway", "airportSet", "volcanic"]);
    expect(SPLAT_JOB_FLOATS).toBe(lanes.length * 4);
    const host = readFileSync(
      new URL("../src/render/webgpu/terrain/PageOcclusionBake.ts", import.meta.url), "utf8");
    expect(host).toContain("jobs[base + 24] = this.volcanicMaterials ? 1 : 0;");
  });

  it("remaps Basalt and Tephra through volcanicFallbackMaterial, before anything selects", () => {
    expect(bake).toContain(
      `if (id == ${SurfaceMaterial.Basalt}u) { return ${volcanicFallbackMaterial(SurfaceMaterial.Basalt)}u; }`);
    expect(bake).toContain(
      `if (id == ${SurfaceMaterial.Tephra}u) { return ${volcanicFallbackMaterial(SurfaceMaterial.Tephra)}u; }`);
    expect(bake).toContain("if (job.volcanic.x > 0.5) { return id; }");
    const supersample = bake.slice(bake.indexOf("fn splatSupersample("), bake.indexOf("struct SeasonalLandCoverWeights"));
    expect(supersample).toContain("let id = splatVolcanicMaterial(job, u32(weights.ids[slot]));");
    expect(supersample).toContain("accumulated[id] = accumulated[id] + weights.weights[slot] * 0.25;");
    // The accumulation is the only place an id enters the texel's vector.
    expect(supersample.match(/accumulated\[u32\(/gu)).toBeNull();
  });
});

/** A compute seam that completes everything and records the splat bake's datum. */
function volcanicRecordingFactory() {
  const datum: boolean[] = [];
  const baked: string[][] = [];
  const factory: TerrainComputeFactory = ({ heightAtlas, existingPyramid }) => ({
    pageGenerator: {
      generate: async (slots) => {
        await Promise.resolve();
        for (const slot of slots) {
          if (!slot.token) continue;
          heightAtlas.residency.complete(slot.key, slot.token, {
            minHeightMeters: 0,
            maxHeightMeters: 100,
            maxDeviationFromParent: 4,
          });
        }
      },
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    occlusionBake: {
      bake: async (slots) => slots,
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    splatBake: {
      setVolcanicMaterials: (enabled) => { datum.push(enabled); },
      bake: async (slots) => {
        baked.push(slots.map((slot) => JSON.stringify(slot.key)));
        return slots;
      },
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    pyramid: existingPyramid ?? {
      recenter: async () => undefined,
      isResident: true,
      dispose: () => undefined,
    },
  });
  return { factory, datum, baked };
}

describe("volcanic land (phase 2): the clipmap hands the bake its datum", () => {
  it("at construction, and re-bakes every resident splat when it flips", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("volcanic-datum", { worldEvolution: "analytic" });
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const recording = volcanicRecordingFactory();
    const system = new TerrainClipmapSystem(scene, world, profile, { computeFactory: recording.factory });
    const observer = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };
    const pump = async (count: number, start: number) => {
      for (let frame = 0; frame < count; frame += 1) {
        system.update(observer, start + frame);
        for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
      }
    };
    try {
      expect(recording.datum).toEqual([profile.volcanicMaterials]);
      await pump(8, 1);
      const resident = system.atlases.channel.residency.entries
        .filter((slot) => slot.lifecycle.state === "resident" && slot.bakedSeasonDay !== null);
      expect(resident.length).toBeGreaterThan(0);

      // The same atlas shape with the datum flipped: no reshape, so only the
      // re-bake path can repaint what is resident. Every resident splat is
      // owed at once...
      const flipped = { ...profile, volcanicMaterials: !profile.volcanicMaterials };
      const before = recording.baked.length;
      system.setProfile(flipped);
      expect(recording.datum).toEqual([profile.volcanicMaterials, flipped.volcanicMaterials]);
      for (const slot of resident) expect(slot.bakedSeasonDay).toBeLessThan(0);
      // ...and re-baked in place under the new datum.
      await pump(16, 100);
      const rebaked = new Set(recording.baked.slice(before).flat());
      for (const slot of resident) {
        expect(rebaked.has(JSON.stringify(slot.key)), `${JSON.stringify(slot.key)} kept the old datum`)
          .toBe(true);
        expect(slot.bakedSeasonDay).toBeGreaterThanOrEqual(0);
      }
      // A profile change that leaves the datum alone owes nothing.
      system.setProfile({ ...flipped });
      expect(recording.datum).toHaveLength(2);
      expect(system.atlases.channel.residency.entries
        .filter((slot) => slot.bakedSeasonDay !== null && slot.bakedSeasonDay < 0)).toHaveLength(0);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
