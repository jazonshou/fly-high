import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  RUNWAY_EARTHWORKS_SET_FLOATS,
  RUNWAY_EARTHWORKS_WGSL,
  packRunwayEarthworksSetUniform,
  runwayEarthworksHeightLocal,
  runwayEarthworksSetWgsl,
} from "../../src/render/webgpu/terrain/RunwayEarthworks";
import { RUNWAY_SDF_WGSL } from "../../src/render/webgpu/terrain/RunwaySurface";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import {
  createWorld,
  findSpawnedAirport,
  withAirports,
  worldAirportAt,
  worldToRunway,
  type AirportDefinition,
  type WorldDefinition,
} from "../../src/world";

/**
 * Assertion 82 for a TWO-airport world: the page generator's nearest-airport
 * earthworks (`runwayEarthworksSetWgsl`, the exact composition
 * `terrainPageGenerationWgsl` uses) agree with the CPU authority — the
 * airport `worldAirportAt` picks, through `runwayEarthworksHeightLocal` — to
 * within 1 mm across BOTH airports' apron, batter and beyond, and the
 * selection only ever disagrees with the CPU's where both leave the ground
 * natural.
 */

const KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${TERRAIN_KERNEL_WGSL}
${RUNWAY_SDF_WGSL}
${RUNWAY_EARTHWORKS_WGSL}
${runwayEarthworksSetWgsl("earthworks")}

@group(0) @binding(1) var<storage, read> earthworks: RunwayEarthworksSet;
@group(0) @binding(2) var<storage, read> probes: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  kSelectPage(0u);
  // Keep the kernel page binding reachable (see runway-earthworks-parity).
  let live = terrainKernelPages[kPageIndex].kept.w * 0.0;
  let probe = probes[id.x];
  // probe = (world x, world z, natural height, unused)
  results[id.x] = vec4f(
    terrainRunwayEarthworksNearestHeight(probe.z, probe.x, probe.y) + live,
    f32(terrainRunwayEarthworksSlot(probe.x, probe.y)),
    0.0,
    0.0,
  );
}
`;

function spawnFrom(
  world: WorldDefinition,
  x: number,
  z: number,
  heading: number,
): Readonly<AirportDefinition> | null {
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(world, x, z, heading, attempt);
    if (result === "exhausted") return null;
    if (result) return result;
  }
}

describe("runway earthworks set CPU/GPU parity (two airports)", () => {
  it("grades the nearest airport within 1 mm of the CPU authority", async () => {
    const world = createWorld("alpha");
    const home = world.airport!;
    const found = spawnFrom(world, home.centerX + 15_000, home.centerZ, Math.PI / 2);
    expect(found).toBeTruthy();
    const next = withAirports(world, [...world.airports, found!]);
    const spawned = next.airports[1]!;

    interface Probe {
      readonly x: number;
      readonly z: number;
      readonly natural: number;
    }
    const probes: Probe[] = [];
    for (const airport of next.airports) {
      const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea + airport.terrainBlendDistance + 20;
      const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth + airport.terrainBlendDistance + 20;
      const sin = Math.sin(airport.headingRadians);
      const cos = Math.cos(airport.headingRadians);
      for (let alongStep = -24; alongStep <= 24; alongStep += 1) {
        for (let acrossStep = -24; acrossStep <= 24; acrossStep += 1) {
          const along = (alongStep / 24) * halfLength;
          const across = (acrossStep / 24) * halfWidth;
          const x = airport.centerX + along * sin + across * cos;
          const z = airport.centerZ + along * cos - across * sin;
          // Natural heights straddling THIS airport's datum, so the cut/fill
          // blend runs on both sides at the second airport too.
          for (const offset of [-9, -1.5, 0, 1.5, 9]) {
            probes.push({ x, z, natural: airport.elevation + offset });
          }
        }
      }
    }
    // The perpendicular bisector, where the selection changes airport.
    const gap = Math.hypot(spawned.centerX - home.centerX, spawned.centerZ - home.centerZ);
    const unitX = (spawned.centerX - home.centerX) / gap;
    const unitZ = (spawned.centerZ - home.centerZ) / gap;
    const midX = (home.centerX + spawned.centerX) * 0.5;
    const midZ = (home.centerZ + spawned.centerZ) * 0.5;
    for (let along = -100; along <= 100; along += 1) {
      for (const across of [-2_000, 0, 2_000]) {
        probes.push({
          x: midX + along * unitX - across * unitZ,
          z: midZ + along * unitZ + across * unitX,
          natural: home.elevation,
        });
      }
    }

    const probeData = new Float32Array(probes.length * 4);
    probes.forEach((probe, index) => {
      probeData[index * 4] = probe.x;
      probeData[index * 4 + 1] = probe.z;
      probeData[index * 4 + 2] = probe.natural;
    });

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    try {
      await engine.initAsync();
      engine.runRenderLoop(() => {});
      const pageBuffer = new StorageBuffer(engine, TERRAIN_KERNEL_PAGE_BYTES);
      pageBuffer.update(new Uint8Array(buildTerrainKernelPageUniform({
        seedHash: next.seedHash, originX: 0, originZ: 0, filterWidthMeters: 0,
      })));
      const setBuffer = new StorageBuffer(engine, RUNWAY_EARTHWORKS_SET_FLOATS * 4);
      setBuffer.update(new Uint8Array(
        packRunwayEarthworksSetUniform(next.airports, next.seedHash).buffer,
      ));
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(new Uint8Array(probeData.buffer));
      const resultBuffer = new StorageBuffer(engine, probes.length * 16);

      const shader = new ComputeShader(
        "runway-earthworks-set-parity",
        engine,
        { computeSource: KERNEL },
        {
          bindingsMapping: {
            terrainKernelPages: { group: 0, binding: 0 },
            earthworks: { group: 0, binding: 1 },
            probes: { group: 0, binding: 2 },
            results: { group: 0, binding: 3 },
          },
        },
      );
      shader.setStorageBuffer("terrainKernelPages", pageBuffer);
      shader.setStorageBuffer("earthworks", setBuffer);
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
      await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
      const view = await resultBuffer.read();
      const raw = new Float32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + probes.length * 16),
      );
      engine.stopRenderLoop();

      let worst = 0;
      let worstIndex = 0;
      let gradedAtSpawned = 0;
      let disagreements = 0;
      probes.forEach((probe, index) => {
        const airport = worldAirportAt(next, probe.x, probe.z)!;
        const local = worldToRunway(airport, probe.x, probe.z);
        const expected = runwayEarthworksHeightLocal(
          airport, probe.natural, local.along, local.across, probe.x, probe.z, next.seedHash,
        );
        const slot = raw[index * 4 + 1]!;
        if (next.airports[slot] !== airport) {
          disagreements += 1;
          expect(expected, `selection split at probe ${index}`).toBe(probe.natural);
        }
        if (airport === spawned && Math.abs(expected - probe.natural) > 1e-9) gradedAtSpawned += 1;
        const delta = Math.abs(raw[index * 4]! - expected);
        if (delta > worst) {
          worst = delta;
          worstIndex = index;
        }
      });
      console.log(
        `two-airport earthworks parity over ${probes.length} probes `
        + `(${gradedAtSpawned} graded by the spawned airport, ${disagreements} bisector splits): `
        + `max |dh| = ${(worst * 1_000).toFixed(3)} mm`,
      );
      expect(gradedAtSpawned).toBeGreaterThan(1_000);
      expect(disagreements).toBeLessThanOrEqual(5);
      expect(worst, `worst probe ${worstIndex}`).toBeLessThan(0.001);

      pageBuffer.dispose();
      setBuffer.dispose();
      probeBuffer.dispose();
      resultBuffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 240_000);
});
