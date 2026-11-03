import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  TERRAIN_INFRASTRUCTURE_WGSL,
  TerrainInfrastructureData,
  packTerrainInfrastructure,
  terrainInfrastructureDataBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainInfrastructureKernel";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
  terrainLandformInput,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import {
  applyInfrastructure,
  clearInfrastructureRegions,
  infrastructureIndex,
  installInfrastructureRegions,
} from "../../src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE } from "../../src/world/infrastructureProfiles";
import { landformCoreCenter } from "../../src/world/landforms";
import { roadRegionInfrastructure } from "../../src/world/roads/roadInfrastructure";
import { RoadNetwork, roadRegionOf, ROAD_LAYERS } from "../../src/world/roads/roadNetwork";
import { airportRoadHead } from "../../src/world/roads/roadNodes";
import { roadGroundHeight } from "../../src/world/roads/roadTerrain";
import { createWorld } from "../../src/world/world";

/**
 * The roads' earthworks (`roadEarthworkProfiles.ts`: carriageway and
 * junction pad) through the infrastructure stage's GPU twin, against the CPU
 * authority, on a real network: both layers' regions round the home
 * airport's road head, installed as streamed regions over the marina. Probes
 * walk across every piece (formation, crown, superelevation, ditch, batters,
 * the join bands) and round every pad, on the real ground and on grounds
 * above and below it, each local to its own 512 m page as a real page bake's
 * are. Agreement within 1 mm, as the runway earthworks.
 *
 * Then the GPU's own copy (`TerrainInfrastructureData`), kept in place by
 * ranged writes while the two regions go and come back with neighbours
 * installed round them: after each change it grades the same probes as the
 * CPU's index of the moment does, without a fresh pack.
 */

const KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${terrainInfrastructureDataBindingWgsl(0, 1)}
${TERRAIN_KERNEL_WGSL}
${TERRAIN_INFRASTRUCTURE_WGSL}

@group(0) @binding(2) var<storage, read> probes: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  // probe = (local x, local z, ground, page index)
  kSelectPage(u32(probe.w));
  results[id.x] = vec4f(terrainInfrastructure(probe.x, probe.y, probe.z), 0.0, 0.0, 0.0);
}
`;

const PAGE = 512;
/** Offsets from the real ground each probe point is also tried at, metres. */
const GROUND_OFFSETS: readonly number[] = [0, -3.1, -0.45, 0.35, 2.7, 9];

interface Probe {
  readonly x: number;
  readonly z: number;
  readonly ground: number;
}

describe("road earthworks CPU/GPU parity", () => {
  it("grades the roads round the airport's road head within 1 mm of the CPU authority", async () => {
    const world = createWorld();
    const head = airportRoadHead(world)!;
    expect(head).not.toBeNull();
    const network = new RoadNetwork(world);
    const rx = roadRegionOf(head.startX);
    const rz = roadRegionOf(head.startZ);
    const regions = ROAD_LAYERS.map((layer) => roadRegionInfrastructure(network, network.region(layer, rx, rz)));
    const neighbours = ROAD_LAYERS.flatMap((layer) => [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([dx, dz]) =>
      roadRegionInfrastructure(network, network.region(layer, rx + dx!, rz + dz!))));
    clearInfrastructureRegions();
    installInfrastructureRegions(world, regions);
    try {
      const index = infrastructureIndex(world);
      const roads = regions.flatMap((region) => region.segments);
      const pieces = roads.filter((segment) => segment.profile === INFRASTRUCTURE_PROFILE.carriageway);
      const pads = roads.filter((segment) => segment.profile === INFRASTRUCTURE_PROFILE.junctionPad);
      expect(pieces.length).toBeGreaterThan(50);
      expect(pads.length).toBeGreaterThan(0);
      // The sealed road's curves are superelevated somewhere in its region.
      expect(pieces.some((piece) => piece.params[2] !== 0 || piece.params[3] !== 0)).toBe(true);
      // Some ease their cross-fall out into a crossing, and some pads tilt with their top road.
      expect(pieces.some((piece) => (piece.params[7] ?? 0) !== 0)).toBe(true);
      expect(pads.some((pad) => (pad.params[3] ?? 0) !== 0 || (pad.params[4] ?? 0) !== 0)).toBe(true);
      const words = packTerrainInfrastructure(index, world.seaLevel, landformCoreCenter(world));

      const points: { x: number; z: number }[] = [];
      for (const piece of pieces) {
        const dx = piece.bx - piece.ax;
        const dz = piece.bz - piece.az;
        const length = Math.hypot(dx, dz);
        const ux = dx / length;
        const uz = dz / length;
        const outer = piece.halfWidth + piece.reach;
        // Through the join band behind a, the body, and the cap past b.
        for (const along of [-0.6, 0.37 * length, 0.81 * length, length + 0.4 * piece.halfWidth]) {
          for (let across = -outer; across <= outer; across += 0.83) {
            points.push({ x: piece.ax + ux * along + uz * across, z: piece.az + uz * along - ux * across });
          }
        }
      }
      for (const pad of pads) {
        const outer = pad.halfWidth + pad.reach;
        for (let r = 0.3; r <= outer; r += 1.1) {
          for (let k = 0; k < 24; k += 1) {
            const angle = (2 * Math.PI * k) / 24 + r * 0.07;
            points.push({ x: pad.ax + Math.sin(angle) * r, z: pad.az + Math.cos(angle) * r });
          }
        }
      }
      const probes: Probe[] = [];
      for (const { x, z } of points) {
        const ground = roadGroundHeight(world, x, z);
        for (const offset of GROUND_OFFSETS) probes.push({ x, z, ground: ground + offset });
      }

      const pageSlots = new Map<string, number>();
      const pageOrigins: { x: number; z: number }[] = [];
      const pageOf = (x: number, z: number) => {
        const px = Math.floor(x / PAGE) * PAGE;
        const pz = Math.floor(z / PAGE) * PAGE;
        const key = `${px},${pz}`;
        let slot = pageSlots.get(key);
        if (slot === undefined) {
          slot = pageOrigins.length;
          pageSlots.set(key, slot);
          pageOrigins.push({ x: px, z: pz });
        }
        return slot;
      };
      const probeData = new Float32Array(probes.length * 4);
      probes.forEach((probe, i) => {
        const slot = pageOf(probe.x, probe.z);
        const page = pageOrigins[slot]!;
        probeData[i * 4] = probe.x - page.x;
        probeData[i * 4 + 1] = probe.z - page.z;
        probeData[i * 4 + 2] = probe.ground;
        probeData[i * 4 + 3] = slot;
      });
      const landform = terrainLandformInput(world);
      const pageBytes = new Uint8Array(pageOrigins.length * TERRAIN_KERNEL_PAGE_BYTES);
      pageOrigins.forEach((page, i) => {
        pageBytes.set(new Uint8Array(buildTerrainKernelPageUniform({
          seedHash: world.seedHash, originX: page.x, originZ: page.z, filterWidthMeters: 0, landform,
        })), i * TERRAIN_KERNEL_PAGE_BYTES);
      });

      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      document.body.appendChild(canvas);
      const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
      try {
        await engine.initAsync();
        engine.runRenderLoop(() => {});
        const pageBuffer = new StorageBuffer(engine, pageBytes.byteLength);
        pageBuffer.update(pageBytes);
        const dataBuffer = new StorageBuffer(engine, words.byteLength);
        dataBuffer.update(words);
        const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
        probeBuffer.update(new Uint8Array(probeData.buffer));
        const resultBuffer = new StorageBuffer(engine, probes.length * 16);
        const shader = new ComputeShader("road-earthworks-parity", engine, { computeSource: KERNEL }, {
          bindingsMapping: {
            terrainKernelPages: { group: 0, binding: 0 },
            terrainInfrastructureData: { group: 0, binding: 1 },
            probes: { group: 0, binding: 2 },
            results: { group: 0, binding: 3 },
          },
        });
        shader.setStorageBuffer("terrainKernelPages", pageBuffer);
        shader.setStorageBuffer("probes", probeBuffer);
        shader.setStorageBuffer("results", resultBuffer);
        const compileErrors: string[] = [];
        shader.onError = (_effect, message) => { compileErrors.push(String(message)); };
        const started = performance.now();
        while (performance.now() - started < 15_000 && compileErrors.length === 0) {
          if (shader.isReady()) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(compileErrors.join(" | ")).toBe("");

        /** The probes through `data`, against the CPU's index now: (worst |dh|, probes moved, where). */
        const grade = async (data: StorageBuffer) => {
          shader.setStorageBuffer("terrainInfrastructureData", data);
          await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
          const view = await resultBuffer.read();
          const raw = new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + probes.length * 16));
          const now = infrastructureIndex(world);
          let worst = 0;
          let worstIndex = 0;
          let changed = 0;
          probes.forEach((probe, i) => {
            const expected = applyInfrastructure(now, world.seaLevel, probe.ground, probe.x, probe.z);
            if (Math.abs(expected - probe.ground) > 0.01) changed += 1;
            const delta = Math.abs(raw[i * 4]! - expected);
            if (delta > worst) {
              worst = delta;
              worstIndex = i;
            }
          });
          return { worst, changed, at: probes[worstIndex]! };
        };

        const first = await grade(dataBuffer);
        console.log(
          `road earthworks parity: ${pieces.length} pieces, ${pads.length} pads, ${pageOrigins.length} pages, `
          + `${probes.length} probes, ${first.changed} moved, max |dh| = ${(first.worst * 1_000).toFixed(3)} mm `
          + `at (${first.at.x.toFixed(2)}, ${first.at.z.toFixed(2)}) ground ${first.at.ground.toFixed(2)}`,
        );
        expect(first.changed).toBeGreaterThan(probes.length / 4);
        expect(first.worst).toBeLessThan(0.001);
        expect(infrastructureIndex(world)).toBe(index);

        // The GPU's own copy, kept in place as the regions go and come back among neighbours.
        installInfrastructureRegions(world, neighbours.slice(0, 5));
        const shared = TerrainInfrastructureData.acquire(engine, world);
        try {
          const steps: [readonly typeof regions[number][], readonly string[]][] = [
            [[neighbours[5]!], [regions[1]!.key]],
            [[neighbours[6]!], [regions[0]!.key, neighbours[2]!.key]],
            [[regions[1]!, regions[0]!], [neighbours[5]!.key, neighbours[6]!.key]],
          ];
          const packs = shared.writes.packs;
          const lines: string[] = [];
          for (const [add, remove] of steps) {
            installInfrastructureRegions(world, add, remove);
            const before = shared.writes.bytes;
            shared.setWorld(world);
            const sent = shared.writes.bytes - before;
            const result = await grade(shared.buffer);
            lines.push(`${result.changed} moved, max |dh| ${(result.worst * 1_000).toFixed(3)} mm, ${sent} bytes written`);
            expect(result.worst).toBeLessThan(0.001);
            expect(sent).toBeGreaterThan(0);
            // Less than a fresh pack of the index, in the smallest layout.
            const fresh = packTerrainInfrastructure(infrastructureIndex(world), world.seaLevel, landformCoreCenter(world));
            expect(sent).toBeLessThan(fresh.byteLength);
          }
          console.log(`in place: ${lines.join("; ")}`);
          // Every change was a ranged write: no fresh pack after the first.
          expect(shared.writes.packs).toBe(packs);
          expect(shared.writes.updates).toBe(steps.length);
        } finally {
          shared.release();
        }
        engine.stopRenderLoop();
        pageBuffer.dispose();
        dataBuffer.dispose();
        probeBuffer.dispose();
        resultBuffer.dispose();
      } finally {
        engine.dispose();
        canvas.remove();
      }
    } finally {
      clearInfrastructureRegions();
    }
  }, 240_000);
});
