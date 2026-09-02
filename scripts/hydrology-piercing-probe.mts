/**
 * Does analytic hydrology water intersect the terrain it is draped over?
 *
 * Jason's in-flight report — "blue blotches over the green terrain", "hard
 * geometric shapes that go through the terrain", "especially near water,
 * but also away from it" — reads as WATER GEOMETRY versus ground, not
 * shading (a splat weight or wetness term paints ON the surface and cannot
 * pass through it). The analytic world's rivers are ribbons draped over
 * UNCARVED terrain at `terrainHeight + riverSurfaceOffsetMeters` (0.16 m),
 * sampled at centerline stride; lakes fill a basin to a surface height whose
 * rim is found at generation stride. Between samples and across a ribbon's
 * width nothing constrains the terrain to stay below the water surface —
 * `HydrologyGeneration`'s own R-24 docblock records the family ("a
 * photoreal ribbon lying down an uncarved hillside… worse than no river")
 * and defers real carving to `5-12`.
 *
 * This probe measures the intersection directly, CPU-only: generate the
 * shipping analytic hydrology for a region, then sample the SAME terrain
 * field on a fine grid inside every river ribbon footprint and lake plate,
 * and count where ground rises above the water surface. Composes the real
 * chain exactly as `hydrology.worker.ts` does — createWorld → sampleTerrain
 * → generateHydrology — no re-derivation.
 *
 * Registered prediction: piercings are COMMON (ribbon edges and lake rims),
 * worst on rough convex terrain. A near-zero result refutes the
 * generation-time form and promotes the render-time one (CDLOD geomorph
 * raising rendered terrain through generation-true water).
 */
import { generateHydrology } from "../src/render/webgpu/water/HydrologyGeneration";
import { appendContainedLake, type HydrologyMeshArrays } from "../src/render/webgpu/water/HydrologySystem";
import { createWorld, sampleTerrain, type TerrainSample, type WorldDefinition } from "../src/world";

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const sampleTarget: TerrainSample = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  slope: 0,
  moisture: 0,
  temperature: 0,
  biome: 0,
  biomeName: "water",
  color: { r: 0, g: 0, b: 0 },
  airportInfluence: 0,
  isRunway: false,
};
const ground = (x: number, z: number): number =>
  sampleTerrain(world as WorldDefinition, x, z, sampleTarget).height;

const centerArgX = Number(process.argv[2]);
const centerArgZ = Number(process.argv[3]);
const centers: Array<readonly [number, number]> = Number.isFinite(centerArgX)
  ? [[centerArgX, centerArgZ || 0] as const]
  : [
      [0, 0], [14_400, 0], [-14_400, 0], [0, 14_400], [0, -14_400],
      [14_400, 14_400], [-14_400, 14_400], [14_400, -14_400], [-14_400, -14_400],
    ];

const regions = centers.map(([cx, cz]) => {
  const hydrology = generateHydrology({
    worldSeed: world.seed,
    centerX: cx,
    centerZ: cz,
    terrainSample: (x, z) => {
      const sample = sampleTerrain(world as WorldDefinition, x, z, sampleTarget);
      return { height: sample.height, moisture: sample.moisture };
    },
  });
  const s = hydrology.statistics;
  console.log(`region (${cx}, ${cz}): candidates ${s.candidateSourceCount}, traced `
    + `${s.tracedSourceCount}, rivers ${s.riverCount}, lakes ${s.lakeCount}`);
  return hydrology;
});
const hydrology = {
  rivers: regions.flatMap((r) => r.rivers),
  lakes: regions.flatMap((r) => r.lakes),
};

interface Piercing {
  readonly x: number;
  readonly z: number;
  readonly meters: number;
  readonly owner: string;
}

const STEP_ALONG = 2;
const CROSS_SAMPLES = 5;
let riverSamples = 0;
let riverPierced = 0;
const worst: Piercing[] = [];
const note = (p: Piercing): void => {
  worst.push(p);
  worst.sort((a, b) => b.meters - a.meters);
  if (worst.length > 8) worst.pop();
};

for (const river of hydrology.rivers) {
  let pierced = 0;
  let max = 0;
  for (let i = 1; i < river.points.length; i++) {
    const p0 = river.points[i - 1]!;
    const p1 = river.points[i]!;
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(length / STEP_ALONG));
    const nx = -dz / length;
    const nz = dx / length;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = p0.x + dx * t;
      const cz = p0.z + dz * t;
      const cy = p0.y + (p1.y - p0.y) * t;
      const width = p0.widthMeters + (p1.widthMeters - p0.widthMeters) * t;
      for (let c = 0; c < CROSS_SAMPLES; c++) {
        const offset = ((c / (CROSS_SAMPLES - 1)) - 0.5) * width * 0.9;
        const gx = cx + nx * offset;
        const gz = cz + nz * offset;
        const rise = ground(gx, gz) - cy;
        riverSamples++;
        if (rise > 0) {
          pierced++;
          riverPierced++;
          if (rise > max) max = rise;
          if (rise > (worst[worst.length - 1]?.meters ?? 0)) {
            note({ x: gx, z: gz, meters: rise, owner: river.id });
          }
        }
      }
    }
  }
  if (pierced > 0) {
    console.log(`river ${river.id}: pierced ${pierced} samples, max ${max.toFixed(2)} m, `
      + `length ${river.lengthMeters.toFixed(0)} m`);
  }
}

let lakeSamples = 0;
let lakePierced = 0;
for (const lake of hydrology.lakes) {
  const xs = lake.boundary.map((p) => p.x);
  const zs = lake.boundary.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const inside = (px: number, pz: number): boolean => {
    let odd = false;
    for (let i = 0, j = lake.boundary.length - 1; i < lake.boundary.length; j = i++) {
      const a = lake.boundary[i]!;
      const b = lake.boundary[j]!;
      if ((a.z > pz) !== (b.z > pz)
        && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) odd = !odd;
    }
    return odd;
  };
  let pierced = 0;
  let max = 0;
  const step = Math.max(2, (maxX - minX) / 64);
  for (let gx = minX; gx <= maxX; gx += step) {
    for (let gz = minZ; gz <= maxZ; gz += step) {
      if (!inside(gx, gz)) continue;
      lakeSamples++;
      const rise = ground(gx, gz) - lake.surfaceHeight;
      if (rise > 0) {
        pierced++;
        lakePierced++;
        if (rise > max) max = rise;
        if (rise > (worst[worst.length - 1]?.meters ?? 0)) {
          note({ x: gx, z: gz, meters: rise, owner: lake.id });
        }
      }
    }
  }
  if (pierced > 0) {
    console.log(`lake ${lake.id}: pierced ${pierced} of its grid, max ${max.toFixed(2)} m, `
      + `surface ${lake.surfaceHeight.toFixed(1)} m, radius ${lake.radiusMeters.toFixed(0)} m, `
      + `center (${lake.centerX.toFixed(0)}, ${lake.centerZ.toFixed(0)})`);
  }
}

console.log("----");
console.log(`rivers: ${hydrology.rivers.length}, samples ${riverSamples}, pierced ${riverPierced} `
  + `(${(100 * riverPierced / Math.max(1, riverSamples)).toFixed(1)}%)`);
console.log(`lakes: ${hydrology.lakes.length}, samples ${lakeSamples}, pierced ${lakePierced} `
  + `(${(100 * lakePierced / Math.max(1, lakeSamples)).toFixed(1)}%)`);
for (const p of worst) {
  console.log(`worst: ${p.meters.toFixed(2)} m above water at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) [${p.owner}]`);
}

// MESH-level containment: measure the actual emitted appendContainedLake
// arrays (the fix's acceptance instrument). For every triangle, sample its
// vertices, edge midpoints and centroid: residual = ground − surface.
// Positive residual is terrain through drawn water — the defect. Expect it
// bounded by sub-grid terrain detail, not the polygon-level metres above.
console.log("---- mesh-level (appendContainedLake) ----");
let meshTriangles = 0;
let meshPierced = 0;
let meshWorst = 0;
let meshWorstOwner = "";
for (const lake of hydrology.lakes) {
  const arrays: HydrologyMeshArrays = {
    positions: [], normals: [], uvs: [], indices: [], flowData: [], waterData: [],
  };
  appendContainedLake(arrays, lake, ground);
  const positions = arrays.positions;
  const indices = arrays.indices;
  let lakeWorst = 0;
  for (let t = 0; t < indices.length; t += 3) {
    meshTriangles += 1;
    const ax = positions[indices[t]! * 3]!;
    const az = positions[indices[t]! * 3 + 2]!;
    const bx = positions[indices[t + 1]! * 3]!;
    const bz = positions[indices[t + 1]! * 3 + 2]!;
    const cx = positions[indices[t + 2]! * 3]!;
    const cz = positions[indices[t + 2]! * 3 + 2]!;
    const probePoints: Array<readonly [number, number]> = [
      [ax, az], [bx, bz], [cx, cz],
      [(ax + bx) / 2, (az + bz) / 2],
      [(bx + cx) / 2, (bz + cz) / 2],
      [(cx + ax) / 2, (cz + az) / 2],
      [(ax + bx + cx) / 3, (az + bz + cz) / 3],
    ];
    for (const [px, pz] of probePoints) {
      const residual = ground(px, pz) - lake.surfaceHeight;
      if (residual > 0.01) {
        meshPierced += 1;
        if (residual > lakeWorst) lakeWorst = residual;
        if (residual > meshWorst) {
          meshWorst = residual;
          meshWorstOwner = lake.id;
        }
      }
    }
  }
  console.log(`lake ${lake.id}: mesh triangles ${indices.length / 3}, worst residual `
    + `${lakeWorst.toFixed(3)} m`);
}
console.log(`mesh: ${meshTriangles} triangles, pierced probe points ${meshPierced}, `
  + `worst residual ${meshWorst.toFixed(3)} m${meshWorstOwner ? ` [${meshWorstOwner}]` : ""}`);
