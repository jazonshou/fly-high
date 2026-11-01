import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { InlineStructureMeshBuilder, KIT_STRUCTURE_ARRAYS } from "@/src/render/structures/InlineStructureMeshBuilder";
import {
  STRUCTURE_THIN_ARCHETYPES,
  STRUCTURE_THIN_INDOOR,
  STRUCTURE_THIN_NEAR_METERS,
} from "@/src/render/structures/structureMeshArrays";
import {
  STRUCTURE_NORMAL_ROUGHNESS_GAIN,
  structurePlaceholderTexel,
  structureTexturePlans,
  type StructureTexturePlans,
} from "@/src/render/structures/structureTextures";
import { mipChainByteFactor } from "@/src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { TOKSVIG_ROUGHNESS_GAIN } from "@/src/render/webgpu/terrain/MaterialArraySynthesis";
import {
  STRUCTURE_BASE_ROUGHNESS,
  StructureMaterialPlugin,
  STRUCTURE_MATERIAL_WGSL,
} from "@/src/render/webgpu/structures/StructureMaterialPlugin";
import {
  StructureSystem,
  type StructureMeshBuild,
  type StructureMeshBuilder,
  type StructureSetName,
  type StructureTextureUpload,
} from "@/src/render/webgpu/structures/StructureSystem";
import { STRUCTURE_SURFACES } from "@/src/world/structures/structureModel";
import { STRUCTURE_TEXTURE_LAYERS, structureSurfaceTextureTable, type StructureTextureEdge } from "@/src/world/structures/kit/kitTextures";
import { SETTLEMENT_STREAM_WINDOW } from "@/src/world/settlements/settlementStreaming";
import type { StructureRecord } from "@/src/world/structures/structureRecord";
import { TERRAIN_SURFACE_INJECTION_ANCHORS } from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * The structure renderer's bookkeeping on a null engine: a set's build lands
 * as a new mesh that replaces the old, one build per set is in flight at a
 * time (the latest decision waits for it), the near shells are the one
 * shadow caster where the profile casts, meshes follow the floating origin,
 * and the tier rows are data; the kit's material arrays are asked for once
 * at the profile's edge and bound to every textured role (never the glass).
 * And the kit's arrays are what the renderer uploads: each set's level, one
 * centre per building, wound for this scene.
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

/** A builder whose builds (and material arrays) land only when the test says. */
class HeldBuilder implements StructureMeshBuilder {
  readonly asked: { set: StructureSetName; ids: number[]; originX: number; originZ: number; resolve: (build: StructureMeshBuild) => void }[] = [];
  readonly texturesAsked: { edge: StructureTextureEdge; resolve: (plans: StructureTexturePlans) => void; reject: (error: Error) => void }[] = [];

  textures(edge: StructureTextureEdge): Promise<StructureTexturePlans> {
    return new Promise((resolve, reject) => this.texturesAsked.push({ edge, resolve, reject }));
  }

  /** The arrays' bytes don't matter here: an edge-1 stand-in of the right shape. */
  landTextures(index: number): void {
    const ask = this.texturesAsked[index]!;
    const level = { edge: 1, layerCount: STRUCTURE_TEXTURE_LAYERS.length, mipLevelCount: 1, packedLevels: [new Uint8Array(52)], totalBytes: 52 };
    ask.resolve({ edge: ask.edge, detail: level, normal: level });
  }

  build(set: StructureSetName, records: readonly StructureRecord[], originX: number, originZ: number): Promise<StructureMeshBuild> {
    return new Promise((resolve) => {
      this.asked.push({ set, ids: records.map((r) => r.id), originX, originZ, resolve: (build) => resolve(build) });
    });
  }

  land(index: number): void {
    const ask = this.asked[index]!;
    ask.resolve(KIT_STRUCTURE_ARRAYS(ask.set, [], ask.originX, ask.originZ));
  }

  dispose(): void {}
}

/** Uploads that record what they made and what was let go (a null engine has no array textures). */
function fakeUploads() {
  const made: { edge: number; disposed: boolean; detail: BaseTexture; normal: BaseTexture }[] = [];
  const upload: StructureTextureUpload = (_scene, plans) => {
    const entry = { edge: plans.edge, disposed: false, detail: { name: `detail-${plans.edge}` } as BaseTexture, normal: { name: `normal-${plans.edge}` } as BaseTexture };
    made.push(entry);
    return { detail: entry.detail, normal: entry.normal, dispose: () => { entry.disposed = true; } };
  };
  return { made, upload };
}

function rig(builder: StructureMeshBuilder, casts = true, structureTextureEdge: 0 | StructureTextureEdge = 0, upload?: StructureTextureUpload) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const system = new StructureSystem(scene, {
    structureNearRadiusMeters: 400,
    structureFarRadiusMeters: 4_000,
    structureOpenBuildings: 4,
    structureNearCastsShadows: casts,
    structureTextureEdge,
  }, builder, null, upload);
  return { scene, system, dispose: () => { system.dispose(); scene.dispose(); engine.dispose(); } };
}

function pluginOf(system: StructureSystem, role: string): StructureMaterialPlugin {
  const material = system.materials.find((m) => m.name === `structures-${role}`)!;
  return material.pluginManager!.getPlugin("structure-surface") as StructureMaterialPlugin;
}

const flush = async () => {
  for (let k = 0; k < 4; k += 1) await Promise.resolve();
};

describe("the structure renderer", () => {
  it("draws each set's landed build as a new mesh, and empties a set whose buildings leave", async () => {
    const { system, dispose } = rig(new InlineStructureMeshBuilder());
    system.apply([{ key: "settlements:0:0", structures: [record(1, 100, 50), record(2, 130, 60), record(3, 2_500, 0)] }], []);
    system.update({ x: 100, y: 400, z: 0 });
    expect(system.pendingWork).toBeGreaterThan(0);
    await flush();
    expect(system.pendingWork).toBe(0);
    const stats = system.statistics;
    expect(stats.farBuildings).toBe(3);
    expect(stats.nearBuildings).toBe(2);
    expect(stats.farTriangles).toBeGreaterThan(0);
    expect(system.meshes.map((mesh) => mesh.name).sort()).toEqual(["structures-far", "structures-near"]);
    const far = system.meshes.find((mesh) => mesh.name === "structures-far")!;

    // A region more: the far set is rebuilt, as a new mesh, and the old one goes.
    system.apply([{ key: "settlements:1:0", structures: [record(4, 3_000, 900)] }], []);
    system.update({ x: 100, y: 400, z: 0 });
    await flush();
    const rebuilt = system.meshes.find((mesh) => mesh.name === "structures-far")!;
    expect(rebuilt).not.toBe(far);
    expect(far.isDisposed()).toBe(true);
    expect(system.statistics.farBuildings).toBe(4);

    system.apply([], ["settlements:0:0", "settlements:1:0"]);
    system.update({ x: 100, y: 400, z: 0 });
    await flush();
    expect(system.meshes).toEqual([]);
    expect(rebuilt.isDisposed()).toBe(true);
    dispose();
  });

  it("keeps one build a set in flight, and builds the latest decision once it lands", async () => {
    const builder = new HeldBuilder();
    const { system, dispose } = rig(builder);
    system.apply([{ key: "settlements:0:0", structures: [record(1, 0, 0)] }], []);
    system.update({ x: 0, y: 400, z: 0 });
    const farAsks = () => builder.asked.filter((ask) => ask.set === "far");
    expect(farAsks()).toHaveLength(1);
    // Two more changes while it is out: neither is asked for yet.
    system.apply([{ key: "settlements:1:0", structures: [record(2, 3_000, 0)] }], []);
    system.update({ x: 0, y: 40, z: 0 });
    system.apply([{ key: "settlements:2:0", structures: [record(3, 3_100, 0)] }], []);
    system.update({ x: 0, y: 40, z: 0 });
    expect(farAsks()).toHaveLength(1);
    expect(system.pendingWork).toBeGreaterThanOrEqual(2);
    builder.land(builder.asked.indexOf(farAsks()[0]!));
    await flush();
    // The latest, only.
    expect(farAsks()).toHaveLength(2);
    expect(farAsks()[1]!.ids).toEqual([1, 2, 3]);
    dispose();
  });

  it("casts only the near shells, where the profile casts", async () => {
    for (const casts of [true, false]) {
      const { system, dispose } = rig(new InlineStructureMeshBuilder(), casts);
      system.apply([{ key: "settlements:0:0", structures: [record(1, 10, 10), record(2, 1_500, 0)] }], []);
      system.update({ x: 0, y: 40, z: 0 });
      await flush();
      const collected: Mesh[] = [];
      system.addShadowCasters((mesh) => collected.push(mesh));
      expect(collected.map((mesh) => mesh.name)).toEqual(casts ? ["structures-near"] : []);
      dispose();
    }
  });

  it("places each mesh at its build origin less the floating origin, and binds the camera in that frame", async () => {
    const { system, dispose } = rig(new InlineStructureMeshBuilder());
    system.apply([{ key: "settlements:0:0", structures: [record(1, 5_010, -2_990)] }], []);
    system.update({ x: 5_000.4, y: 40, z: -3_000.6 });
    await flush();
    system.setFloatingOrigin(4_096, -2_048);
    for (const mesh of system.meshes) {
      expect(mesh.position.x).toBe(5_000 - 4_096);
      expect(mesh.position.z).toBe(-3_001 + 2_048);
    }
    system.update({ x: 5_020, y: 40, z: -3_010 });
    const near = system.materials.find((material) => material.name === "structures-near")!;
    const plugin = near.pluginManager!.getPlugin("structure-surface") as StructureMaterialPlugin;
    expect(plugin.binding!.cameraX).toBeCloseTo(20, 9);
    expect(plugin.binding!.cameraZ).toBeCloseTo(-9, 9);
    dispose();
  });

  it("takes its radii from the profile, the blocks no further than the settlements stream", () => {
    const rows = [0, 1, 2, 3].map((tier) => {
      const [quality, mode] = ([["low", "balanced"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"]] as const)[tier]!;
      return resolveWebGpuQualityProfile(quality, mode);
    });
    expect(rows.map((p) => p.structureNearRadiusMeters)).toEqual([250, 400, 600, 800]);
    expect(rows.map((p) => p.structureOpenBuildings)).toEqual([2, 4, 6, 6]);
    expect(rows.map((p) => p.structureNearCastsShadows)).toEqual([false, true, true, true]);
    // High's 700 MiB ceiling has no room for the 512 set (PerformanceBudget's structures lane).
    expect(rows.map((p) => p.structureTextureEdge)).toEqual([0, 256, 256, 512]);
    for (const profile of rows) {
      const { system, dispose } = rig(new InlineStructureMeshBuilder());
      system.setProfile(profile);
      system.update({ x: 0, y: 0, z: 0 });
      const far = system.materials.find((material) => material.name === "structures-far")!;
      const plugin = far.pluginManager!.getPlugin("structure-surface") as StructureMaterialPlugin;
      expect(plugin.binding!.farRadiusMeters).toBe(Math.min(profile.structureFarRadiusMeters, SETTLEMENT_STREAM_WINDOW));
      expect(plugin.binding!.thinNearRadiusMeters).toBe(Math.min(STRUCTURE_THIN_NEAR_METERS, profile.structureNearRadiusMeters));
      dispose();
    }
  });

  it("passes two varyings, under the inter-stage limit beside the PBR stage's own", () => {
    // Five (colour, indoor, uv, surface, dither) took the flight renderer's
    // PBR vertex stage (haze, cloud shadows, cascades: 13) to 18 of WebGPU's
    // 16 inter-stage locations, and every structure pipeline failed to build.
    const declared = (wgsl: string) => [...wgsl.matchAll(/^varying (\w+): (\w+);/gm)].map((match) => `${match[1]}: ${match[2]}`);
    expect(declared(STRUCTURE_MATERIAL_WGSL.vertexDefinitions)).toEqual(["structureColourIndoorV: vec4f", "structureUvSurfaceShareV: vec4f"]);
    expect(declared(STRUCTURE_MATERIAL_WGSL.fragmentDefinitions)).toEqual(declared(STRUCTURE_MATERIAL_WGSL.vertexDefinitions));
  });

  it("hooks the shader where the sun and the sky can be cut indoors, and where the layers set roughness and cavity", () => {
    // The indoor cut rides each directional light's own colour, as the terrain's horizon shadow does;
    // the layers' roughness and cavity ride the terrain's own anchors in main.
    expect(Object.keys(STRUCTURE_MATERIAL_WGSL.fragmentInjections)).toEqual([
      TERRAIN_SURFACE_INJECTION_ANCHORS.sunLightColor,
      TERRAIN_SURFACE_INJECTION_ANCHORS.ambientOcclusion,
      TERRAIN_SURFACE_INJECTION_ANCHORS.roughness,
    ]);
    expect(STRUCTURE_MATERIAL_WGSL.fragmentBeforeFinalColor).toContain("finalIrradiance *= structureSkyShare;");
    expect(STRUCTURE_MATERIAL_WGSL.fragmentBeforeFinalColor).toContain("finalRadianceScaled *= structureSkyShare;");
  });
});

describe("the kit's material arrays", () => {
  it("are asked for once at a textured edge, held as pending work, and bound to every role but the glass", async () => {
    const builder = new HeldBuilder();
    const uploads = fakeUploads();
    const { system, dispose } = rig(builder, true, 256, uploads.upload);
    expect(builder.texturesAsked.map((ask) => ask.edge)).toEqual([256]);
    expect(system.pendingWork).toBe(1);
    for (const role of ["far", "near", "open"]) expect(pluginOf(system, role).textured).toBe(true);
    expect(pluginOf(system, "glass").textured).toBe(false);
    // Until they land, the materials read their placeholders.
    expect(pluginOf(system, "near").textures).toBeNull();
    builder.landTextures(0);
    await flush();
    expect(system.pendingWork).toBe(0);
    expect(uploads.made.map((entry) => entry.edge)).toEqual([256]);
    for (const role of ["far", "near", "open"]) expect(pluginOf(system, role).textures?.detail).toBe(uploads.made[0]!.detail);
    expect(pluginOf(system, "glass").textures).toBeNull();
    expect(system.statistics.textureEdge).toBe(256);
    // The same edge again asks for nothing.
    system.setProfile({ ...system["profile"], structureTextureEdge: 256 });
    expect(builder.texturesAsked).toHaveLength(1);
    dispose();
    expect(uploads.made[0]!.disposed).toBe(true);
  });

  it("asks again at a new edge, lets the old arrays go once the new are in, and drops them all at edge 0", async () => {
    const builder = new HeldBuilder();
    const uploads = fakeUploads();
    const { system, dispose } = rig(builder, true, 256, uploads.upload);
    builder.landTextures(0);
    await flush();
    const profile = system["profile"];
    system.setProfile({ ...profile, structureTextureEdge: 512 });
    expect(builder.texturesAsked.map((ask) => ask.edge)).toEqual([256, 512]);
    // The 256 set stays drawn until the 512 one is in.
    expect(uploads.made[0]!.disposed).toBe(false);
    builder.landTextures(1);
    await flush();
    expect(uploads.made.map((entry) => entry.edge)).toEqual([256, 512]);
    expect(uploads.made[0]!.disposed).toBe(true);
    expect(pluginOf(system, "far").textures?.detail).toBe(uploads.made[1]!.detail);

    system.setProfile({ ...profile, structureTextureEdge: 0 });
    expect(uploads.made[1]!.disposed).toBe(true);
    for (const role of ["far", "near", "open"]) {
      expect(pluginOf(system, role).textured).toBe(false);
      expect(pluginOf(system, role).textures).toBeNull();
    }
    expect(system.statistics.textureEdge).toBe(0);
    dispose();
  });

  it("lets go of a set that lands after the profile left its edge, and asks for the profile's", async () => {
    const builder = new HeldBuilder();
    const uploads = fakeUploads();
    const { system, dispose } = rig(builder, true, 256, uploads.upload);
    const profile = system["profile"];
    system.setProfile({ ...profile, structureTextureEdge: 512 });
    // One request at a time: the 512 one waits for the 256 one.
    expect(builder.texturesAsked.map((ask) => ask.edge)).toEqual([256]);
    builder.landTextures(0);
    await flush();
    expect(uploads.made).toEqual([]);
    expect(builder.texturesAsked.map((ask) => ask.edge)).toEqual([256, 512]);
    expect(system.pendingWork).toBe(1);
    builder.landTextures(1);
    await flush();
    expect(uploads.made.map((entry) => entry.edge)).toEqual([512]);
    dispose();
  });

  it("keeps the placeholders when the arrays cannot be made, and does not ask again", async () => {
    const builder = new HeldBuilder();
    const { system, dispose } = rig(builder, true, 256, fakeUploads().upload);
    builder.texturesAsked[0]!.reject(new Error("no"));
    await flush();
    expect(system.pendingWork).toBe(0);
    expect(system.statistics.textureFailures).toBe(1);
    system.update({ x: 0, y: 40, z: 0 });
    expect(builder.texturesAsked).toHaveLength(1);
    dispose();
  });

  it("are the kit's layers, fully mipped, the bytes the memory budget counts", () => {
    const plans = structureTexturePlans(256);
    for (const array of [plans.detail, plans.normal]) {
      expect(array.layerCount).toBe(STRUCTURE_TEXTURE_LAYERS.length);
      expect(array.mipLevelCount).toBe(9);
      expect(array.packedLevels.map((level) => level.length)).toEqual(
        [256, 128, 64, 32, 16, 8, 4, 2, 1].map((edge) => edge * edge * 4 * STRUCTURE_TEXTURE_LAYERS.length),
      );
      expect(array.totalBytes).toBeCloseTo(STRUCTURE_TEXTURE_LAYERS.length * 256 * 256 * 4 * mipChainByteFactor(256), 6);
    }
    // The terrain arrays' Toksvig gain.
    expect(STRUCTURE_NORMAL_ROUGHNESS_GAIN).toBe(TOKSVIG_ROUGHNESS_GAIN);
  });

  it("puts the kit's surface table in the shader, and flat placeholders that leave a part its colour", () => {
    const table = structureSurfaceTextureTable();
    const wgsl = STRUCTURE_MATERIAL_WGSL.fragmentDefinitions;
    const rows = [...wgsl.matchAll(/vec4f\(([^)]*)\)/g)].map((match) => match[1]!.split(",").map(Number));
    expect(rows).toHaveLength(STRUCTURE_SURFACES.length);
    rows.forEach((row, id) => row.forEach((value, k) => expect(value).toBeCloseTo(table[id * 4 + k]!, 6)));
    const detail = structurePlaceholderTexel("detail", STRUCTURE_BASE_ROUGHNESS);
    // albedo = mix(rgb, colour * rgb * 2, a): the colour, to 0.4%.
    expect(detail[3]).toBe(255);
    expect(Math.abs((detail[0] / 255) * 2 - 1)).toBeLessThan(0.004);
    const normal = structurePlaceholderTexel("normal", STRUCTURE_BASE_ROUGHNESS);
    expect([normal[0], normal[1], normal[3]]).toEqual([128, 128, 255]);
    expect(normal[2] / 255).toBeCloseTo(STRUCTURE_BASE_ROUGHNESS, 2);
  });
});

describe("the kit's arrays for each set", () => {
  it("are blocks far, shells near and open buildings with glass, each vertex carrying its building's centre", () => {
    const records = [record(1, 100, 50), record(2, -40, 300, { heading: -2.2, storeys: 1 })];
    const far = KIT_STRUCTURE_ARRAYS("far", records, 64, 32);
    const near = KIT_STRUCTURE_ARRAYS("near", records, 64, 32);
    const open = KIT_STRUCTURE_ARRAYS("open", records, 64, 32);
    expect(far.glass).toBeNull();
    expect(near.glass).toBeNull();
    expect(open.glass!.triangles).toBeGreaterThan(0);
    // The kit's budgets: 20-60 a block, hundreds a shell, more open.
    expect(far.opaque.triangles).toBeLessThanOrEqual(2 * 60);
    expect(near.opaque.triangles).toBeGreaterThan(far.opaque.triangles * 4);
    expect(open.opaque.triangles).toBeGreaterThan(near.opaque.triangles);
    // Indoor light only where there are rooms.
    expect(near.opaque.indoor.some((value) => value > 0)).toBe(false);
    expect(open.opaque.indoor.some((value) => value > 0)).toBe(true);
    for (const { opaque } of [far, near, open]) {
      expect(opaque.positions.length / 3).toBe(opaque.centre.length / 2);
      const centres = new Set<string>();
      for (let i = 0; i < opaque.centre.length; i += 2) centres.add(`${opaque.centre[i]},${opaque.centre[i + 1]}`);
      expect([...centres].sort()).toEqual([`${100 - 64},${50 - 32}`, `${-40 - 64},${300 - 32}`].sort());
    }
  });

  it("mark the thin-member buildings' far and near vertices for their nearer handoff, and nothing else", () => {
    const windmill = record(1, 100, 50, { archetype: "windmill" });
    const house = record(2, -40, 300);
    expect(STRUCTURE_THIN_ARCHETYPES.has("windmill")).toBe(true);
    expect(STRUCTURE_THIN_ARCHETYPES.has("house")).toBe(false);
    for (const set of ["far", "near", "open"] as const) {
      const { opaque } = KIT_STRUCTURE_ARRAYS(set, [windmill, house], 0, 0);
      const marks = { windmill: new Set<number>(), house: new Set<number>() };
      for (let v = 0; v < opaque.indoor.length; v += 1) {
        const which = Math.abs(opaque.centre[v * 2]! - windmill.x) < 1e-3 ? "windmill" : "house";
        if (set !== "open" || opaque.indoor[v]! <= 0) marks[which].add(opaque.indoor[v]!);
      }
      if (set === "open") {
        // Open buildings carry their rooms' light, never the mark.
        expect([...marks.windmill, ...marks.house].every((value) => value !== STRUCTURE_THIN_INDOOR)).toBe(true);
      } else {
        expect([...marks.windmill]).toEqual([STRUCTURE_THIN_INDOOR]);
        expect([...marks.house]).toEqual([0]);
      }
    }
    // And the vertex stage reads it: the thin radius where the mark is set, the near radius elsewhere.
    expect(STRUCTURE_MATERIAL_WGSL.vertexUpdatePosition).toContain(
      "select(structureRanges.x, structureRanges.w, vertexInputs.structureIndoor < -0.5)",
    );
  });

  it("wind every face the other way round from its normal, this right-handed scene's front faces", () => {
    // The kit winds by the right-hand rule; drawn so, the blocks vanished on
    // the GPU and the shells showed their insides (tests/gpu/structure-system).
    const records = [record(1, 100, 50), record(2, -40, 300, { heading: -2.2, storeys: 1 })];
    for (const set of ["far", "near", "open"] as const) {
      const build = KIT_STRUCTURE_ARRAYS(set, records, 64, 32);
      for (const arrays of [build.opaque, build.glass]) {
        if (!arrays) continue;
        const { positions: p, normals: n, indices } = arrays;
        let along = 0;
        let against = 0;
        for (let t = 0; t < indices.length; t += 3) {
          const [a, b, c] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
          const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
          const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
          const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
          const dot = cross[0]! * n[a]! + cross[1]! * n[a + 1]! + cross[2]! * n[a + 2]!;
          if (dot > 1e-9) along += 1;
          else if (dot < -1e-9) against += 1;
        }
        expect(along, `${set}: faces wound along their normal`).toBe(0);
        expect(against).toBeGreaterThan(0);
      }
    }
  });
});
