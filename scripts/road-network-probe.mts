/**
 * The road network of one world, headless, as tables:
 * `npx tsx scripts/road-network-probe.mts [seed] [--map out.png]`.
 *
 * Generates every region of both layers inside its window round the home
 * airport's road head (the observer a car starts at), timing each region, and
 * prints per class: lengths, piece counts, the deepest fill and cut, the
 * steepest grade, how many edges needed steep pitches, crossings, and why
 * the edges with no road have none. `--map` writes a plan of the ground with
 * the roads on it (tracks orange, gravel white, the sealed road black), 20 m
 * a pixel over the major layer's window.
 *
 * `tests/world.roads-*.test.ts` hold the network to the same limits.
 */
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { createWorld } from "@/src/world";
import { ROAD_CLASS, ROAD_CLASSES, roadClass, type RoadClassId } from "@/src/world/roads/roadClasses";
import {
  ROAD_LAYERS,
  RoadNetwork,
  roadLayerWindow,
  roadRegionOf,
  ROAD_REGION_METERS,
  type RoadEdgeFailure,
  type RoadGeometry,
  type RoadPiece,
} from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { roadGroundHeight } from "@/src/world/roads/roadTerrain";

const args = process.argv.slice(2);
const mapIndex = args.indexOf("--map");
const mapPath = mapIndex >= 0 ? args[mapIndex + 1] : undefined;
const seedArg = args.find((arg, index) => !arg.startsWith("--") && index !== mapIndex + 1);
const world = seedArg === undefined
  ? createWorld()
  : createWorld(Number.isFinite(Number(seedArg)) ? Number(seedArg) : seedArg);
const head = airportRoadHead(world);
if (!head) {
  console.log("No home airport: no roads.");
  process.exit(0);
}
const network = new RoadNetwork(world);

// ---- generation, region by region -------------------------------------------------------------------------

const pieces: RoadPiece[] = [];
const centreX = roadRegionOf(head.startX);
const centreZ = roadRegionOf(head.startZ);
console.log(`seed ${String(world.seed)}  road head (${head.startX.toFixed(0)}, ${head.startZ.toFixed(0)})`);
console.log("\nlayer   window  regions  pieces  pads  edges   total ms  mean ms  worst ms");
for (const layer of ROAD_LAYERS) {
  const reach = Math.ceil(roadLayerWindow(layer) / ROAD_REGION_METERS);
  const times: number[] = [];
  let padCount = 0;
  let pieceCount = 0;
  const before = network.builtEdgeCount;
  for (let dz = -reach; dz <= reach; dz += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const start = performance.now();
      const region = network.region(layer, centreX + dx, centreZ + dz);
      times.push(performance.now() - start);
      pieces.push(...region.pieces);
      pieceCount += region.pieces.length;
      padCount += region.pads.length;
    }
  }
  const total = times.reduce((sum, time) => sum + time, 0);
  console.log(
    `${layer.padEnd(6)} ${(roadLayerWindow(layer) / 1000).toFixed(0).padStart(5)} km ${String(times.length).padStart(8)} `
    + `${String(pieceCount).padStart(7)} ${String(padCount).padStart(5)} ${String(network.builtEdgeCount - before).padStart(6)} `
    + `${total.toFixed(0).padStart(10)} ${(total / times.length).toFixed(0).padStart(8)} ${Math.max(...times).toFixed(0).padStart(9)}`,
  );
}

// ---- per class --------------------------------------------------------------------------------------------

const geometries = new Map<number, RoadGeometry>();
const failures = new Map<RoadClassId, Map<RoadEdgeFailure, number>>();
for (const spec of ROAD_CLASSES) {
  const window = spec.id === ROAD_CLASS.airport ? 0 : spec.windowMeters;
  const box = {
    minX: head.startX - window,
    minZ: head.startZ - window,
    maxX: head.startX + window,
    maxZ: head.startZ + window,
  };
  for (const edge of network.edgesNear(spec.id, box)) {
    const geometry = network.geometry(edge);
    if (geometry) {
      geometries.set(edge.id, geometry);
      continue;
    }
    const reason = network.failure(edge) ?? "route";
    let byReason = failures.get(spec.id);
    if (!byReason) failures.set(spec.id, (byReason = new Map()));
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
}
console.log("\nclass    roads   km  pieces  mean m  fill m  cut m  grade  pitched  crossings  no road");
for (const spec of ROAD_CLASSES) {
  const roads = [...geometries.values()].filter((geometry) => geometry.edge.classId === spec.id);
  let length = 0;
  let pieceCount = 0;
  let fill = 0;
  let cut = 0;
  let grade = 0;
  let pitched = 0;
  let crossings = 0;
  for (const road of roads) {
    length += road.station[road.station.length - 1]!;
    pieceCount += road.pieces.length;
    fill = Math.max(fill, road.stats.maxFill);
    cut = Math.max(cut, road.stats.maxCut);
    grade = Math.max(grade, road.stats.maxGrade);
    if (road.stats.gradeRelaxed) pitched += 1;
    crossings += road.stats.crossings;
  }
  const failed = [...(failures.get(spec.id) ?? new Map<RoadEdgeFailure, number>()).entries()]
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  console.log(
    `${spec.name.padEnd(7)} ${String(roads.length).padStart(5)} ${(length / 1000).toFixed(1).padStart(5)} `
    + `${String(pieceCount).padStart(7)} ${(length / Math.max(1, pieceCount)).toFixed(1).padStart(7)} `
    + `${fill.toFixed(1).padStart(7)} ${cut.toFixed(1).padStart(6)} ${grade.toFixed(3).padStart(6)} `
    + `${String(pitched).padStart(8)} ${String(crossings).padStart(10)}  ${failed || "-"}`,
  );
}
const airportEdge = network.airportEdge();
if (airportEdge) {
  const road = network.geometry(airportEdge)!;
  console.log(`\nsealed road: ${airportEdge.key}, ${(road.station[road.station.length - 1]! / 1000).toFixed(2)} km, `
    + `${road.pieces.length} pieces, steepest ${road.stats.maxGrade.toFixed(3)}`);
} else {
  console.log("\nsealed road: none (no gravel node a route reaches)");
}

// ---- the map ----------------------------------------------------------------------------------------------

if (mapPath) {
  const half = roadClass(ROAD_CLASS.gravel).windowMeters * 0.6;
  const size = Math.round((2 * half) / 20);
  const pixel = (2 * half) / size;
  const rgb = new Uint8Array(size * size * 3);
  const originX = head.startX - half;
  const originZ = head.startZ - half;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const height = roadGroundHeight(world, originX + (column + 0.5) * pixel, originZ + (size - row - 0.5) * pixel);
      const k = (row * size + column) * 3;
      if (height < world.seaLevel) {
        rgb.set([40, 70, 140], k);
      } else {
        const v = Math.min(255, 60 + (height - world.seaLevel) * 0.25);
        rgb.set([v * 0.8, v, v * 0.7], k);
      }
    }
  }
  const colours: Record<RoadClassId, readonly number[]> = {
    [ROAD_CLASS.track]: [200, 140, 60],
    [ROAD_CLASS.gravel]: [250, 250, 250],
    [ROAD_CLASS.airport]: [20, 20, 20],
  };
  for (const piece of pieces) {
    const length = Math.hypot(piece.bx - piece.ax, piece.bz - piece.az);
    const steps = Math.max(1, Math.ceil(length / (pixel * 0.5)));
    for (let s = 0; s <= steps; s += 1) {
      const x = piece.ax + ((piece.bx - piece.ax) * s) / steps;
      const z = piece.az + ((piece.bz - piece.az) * s) / steps;
      const column = Math.floor((x - originX) / pixel);
      const row = size - 1 - Math.floor((z - originZ) / pixel);
      if (column < 0 || row < 0 || column >= size || row >= size) continue;
      rgb.set(colours[piece.classId], (row * size + column) * 3);
    }
  }
  writePng(mapPath, size, size, rgb);
  console.log(`\nmap: ${mapPath} (${size} px, ${pixel.toFixed(0)} m a pixel, north up)`);
}

function writePng(path: string, width: number, height: number, rgb: Uint8Array): void {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) Buffer.from(rgb.subarray(y * width * 3, (y + 1) * width * 3)).copy(raw, y * (width * 3 + 1) + 1);
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}
