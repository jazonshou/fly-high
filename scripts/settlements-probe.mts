/**
 * The settlement layout on a window round the home airport's road head: how
 * many buildings, of what kinds, per 100 km² of land, how often a plot is
 * refused, and how long each region takes. Optionally a map.
 *
 * `npx tsx scripts/settlements-probe.mts [seed] [--province name] [--half metres] [--map out.png]`
 *
 * Generates the settlement regions exactly as the roads worker would
 * (`settlementRegion`), so the numbers are the game's.
 */
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { createWorld } from "@/src/world";
import type { ClimateProvinceName } from "@/src/world/climateProvince";
import { ROAD_LAYERS, RoadNetwork, roadRegionOf } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { settlementRegion, type SettlementRegion } from "@/src/world/settlements/settlementRegion";
import { sampleTerrainHeightBeforeEarthworks } from "@/src/world/terrain";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const province = flag("--province") as ClimateProvinceName | undefined;
const mapPath = flag("--map");
const half = Number(flag("--half") ?? 6_000);
const valued = new Set(["--province", "--map", "--half"]);
const seedArg = args.find((arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1] ?? ""));
const world = createWorld(seedArg ?? undefined, province ? { climateProvince: province } : {});
const head = airportRoadHead(world)!;
const network = new RoadNetwork(world);

const rx0 = roadRegionOf(head.startX - half);
const rx1 = roadRegionOf(head.startX + half);
const rz0 = roadRegionOf(head.startZ - half);
const rz1 = roadRegionOf(head.startZ + half);

// The roads first, as the worker builds them before the settlements near them.
const roadStart = performance.now();
for (const layer of ROAD_LAYERS) {
  for (let rz = rz0; rz <= rz1; rz += 1) for (let rx = rx0; rx <= rx1; rx += 1) network.region(layer, rx, rz);
}
const roadMs = performance.now() - roadStart;

const regions: SettlementRegion[] = [];
const regionMs: number[] = [];
for (let rz = rz0; rz <= rz1; rz += 1) {
  for (let rx = rx0; rx <= rx1; rx += 1) {
    const start = performance.now();
    regions.push(settlementRegion(network, rx, rz));
    regionMs.push(performance.now() - start);
  }
}
const minX = rx0 * 2_048;
const minZ = rz0 * 2_048;
const maxX = (rx1 + 1) * 2_048;
const maxZ = (rz1 + 1) * 2_048;
let land = 0;
let cells = 0;
for (let x = minX + 125; x < maxX; x += 250) {
  for (let z = minZ + 125; z < maxZ; z += 250) {
    cells += 1;
    if (sampleTerrainHeightBeforeEarthworks(world, x, z) > world.seaLevel) land += 1;
  }
}
const landKm2 = (land * 250 * 250) / 1e6;
const layouts = regions.flatMap((region) => region.layouts);
const buildings = layouts.flatMap((layout) => layout.buildings);
const tried = layouts.reduce((sum, layout) => sum + layout.tried, 0);
const refused = layouts.reduce((sum, layout) => sum + layout.refused, 0);
const segments = regions.reduce((sum, region) => sum + region.infrastructure.segments.length, 0);
const near = (radius: number) => buildings.filter((b) => Math.hypot(b.record.x - head.startX, b.record.z - head.startZ) <= radius).length;
console.log(`seed ${world.seed}  province ${province ?? "natural"}  road head (${head.startX.toFixed(0)}, ${head.startZ.toFixed(0)})`);
console.log(`window ${(maxX - minX) / 1_000} x ${(maxZ - minZ) / 1_000} km (${regions.length} regions), land ${landKm2.toFixed(0)} km2 of ${(cells * 0.0625).toFixed(0)}`);
console.log(`roads ${roadMs.toFixed(0)} ms; settlements ${regionMs.reduce((a, b) => a + b, 0).toFixed(0)} ms (worst region ${Math.max(...regionMs).toFixed(0)} ms)`);
const refusedBy = new Map<string, number>();
for (const layout of layouts) for (const [reason, count] of Object.entries(layout.refusedBy)) refusedBy.set(reason, (refusedBy.get(reason) ?? 0) + count);
console.log(`plots tried ${tried}, refused ${refused} (${((100 * refused) / Math.max(1, tried)).toFixed(0)}%: ${[...refusedBy].map(([k, v]) => `${k} ${v}`).join(", ")}), segments ${segments}`);
const byKind = new Map<string, { settlements: number; buildings: number }>();
for (const layout of layouts) {
  const key = `${layout.site.kind}|${layout.site.style}`;
  const entry = byKind.get(key) ?? { settlements: 0, buildings: 0 };
  entry.settlements += 1;
  entry.buildings += layout.buildings.length;
  byKind.set(key, entry);
}
console.log("\nkind        style      settlements  buildings");
for (const [key, entry] of [...byKind.entries()].sort()) {
  const [kind, style] = key.split("|");
  console.log(`${kind!.padEnd(11)} ${style!.padEnd(10)} ${String(entry.settlements).padStart(11)} ${String(entry.buildings).padStart(10)}`);
}
const archetypes = new Map<string, number>();
for (const b of buildings) archetypes.set(b.record.archetype, (archetypes.get(b.record.archetype) ?? 0) + 1);
console.log(`\narchetypes: ${[...archetypes.entries()].sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`\nbuildings: ${buildings.length} (${((100 * buildings.length) / Math.max(1, landKm2)).toFixed(0)} per 100 km2 of land); ${near(2_000)} within 2 km, ${near(5_000)} within 5 km of the road head`);
console.log(`JSON ${JSON.stringify({ province: province ?? "natural", landKm2, buildings: buildings.length, within2: near(2_000), within5: near(5_000), tried, refused, segments, roadMs, settlementMs: regionMs.reduce((a, b) => a + b, 0), worstRegionMs: Math.max(...regionMs) })}`);

if (mapPath) {
  const size = 900;
  const scale = (maxX - minX) / size;
  const rgb = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = minX + (px + 0.5) * scale;
      const z = maxZ - (py + 0.5) * scale;
      const h = sampleTerrainHeightBeforeEarthworks(world, x, z) - world.seaLevel;
      const o = (py * size + px) * 3;
      if (h < 0) [rgb[o], rgb[o + 1], rgb[o + 2]] = [40, 70, 110];
      else {
        const shade = Math.max(0, Math.min(1, h / 600));
        [rgb[o], rgb[o + 1], rgb[o + 2]] = [70 + 110 * shade, 110 + 80 * shade, 60 + 120 * shade];
      }
    }
  }
  const plot = (x: number, z: number, radius: number, colour: readonly [number, number, number]) => {
    const cx = (x - minX) / scale;
    const cy = (maxZ - z) / scale;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const o = (py * size + px) * 3;
        [rgb[o], rgb[o + 1], rgb[o + 2]] = colour;
      }
    }
  };
  for (const layer of ROAD_LAYERS) {
    for (let rz = rz0; rz <= rz1; rz += 1) {
      for (let rx = rx0; rx <= rx1; rx += 1) {
        for (const piece of network.region(layer, rx, rz).pieces) {
          const steps = Math.ceil(Math.hypot(piece.bx - piece.ax, piece.bz - piece.az) / scale);
          for (let k = 0; k <= steps; k += 1) {
            const t = k / Math.max(1, steps);
            plot(piece.ax + (piece.bx - piece.ax) * t, piece.az + (piece.bz - piece.az) * t, 0,
              piece.classId === 0 ? [200, 140, 60] : piece.classId === 1 ? [235, 235, 235] : [20, 20, 20]);
          }
        }
      }
    }
  }
  const colours: Record<string, readonly [number, number, number]> = {
    hamlet: [230, 40, 40], farmstead: [250, 160, 30], roadside: [120, 220, 255], outpost: [170, 60, 220],
    cabin: [250, 240, 60], lookout: [255, 120, 220], lighthouse: [255, 255, 255],
  };
  for (const layout of layouts) {
    for (const b of layout.buildings) plot(b.record.x, b.record.z, 2, colours[layout.site.kind]!);
  }
  writeFileSync(mapPath, png(size, size, rgb));
  console.log(`map: ${mapPath} (${size} px, ${scale.toFixed(1)} m a pixel, north up)`);
}

function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
