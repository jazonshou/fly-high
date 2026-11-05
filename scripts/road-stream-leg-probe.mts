/**
 * What the streamed roads (and the settlements laid out along them) put on
 * the infrastructure stage over a straight leg, in Node: the regions the
 * stream controller would hold each second (`roadStreamRegions`, installed
 * as soon as they are wanted, the worst case for the window's size), the
 * stage's segments and bins, and what the GPU's own copy of it
 * (`TerrainInfrastructurePack` with the streamed minimum) does as they come
 * and go: list relayouts, table rehashes, fresh packs.
 *
 *   npx tsx scripts/road-stream-leg-probe.mts [--seconds 300] [--speed 250]
 *     [--start 7271,-37795,135] [--layers major,track,settlements]
 *
 * The defaults are docs/PERFORMANCE.md's jet leg ("Roads at jet speed").
 * Yaw is perf-flight's: degrees, forward (cos, -sin).
 */
import { parseArgs } from "node:util";
import { TerrainInfrastructurePack } from "@/src/render/webgpu/terrain/TerrainInfrastructureKernel";
import { createWorld } from "@/src/world";
import {
  infrastructureIndex,
  infrastructureIndexChanges,
  installInfrastructureRegions,
  type InfrastructureRegion,
} from "@/src/world/infrastructure";
import { landformCoreCenter } from "@/src/world/landforms";
import { roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import { roadNetworkFor } from "@/src/world/roads/roadNetwork";
import {
  ROAD_STREAM_KEEP_MARGIN,
  roadStreamRegionKey,
  roadStreamRegions,
  type RoadStreamLayer,
} from "@/src/world/roads/roadStreaming";
import { settlementRegion } from "@/src/world/settlements/settlementRegion";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "300" },
    speed: { type: "string", default: "250" },
    start: { type: "string", default: "7271,-37795,135" },
    layers: { type: "string", default: "major,track,settlements" },
  },
});
const seconds = Number(values.seconds);
const speed = Number(values.speed);
const [startX, startZ, yawDegrees] = values.start!.split(",").map(Number) as [number, number, number];
const layers = new Set(values.layers!.split(",") as RoadStreamLayer[]);
const yaw = (yawDegrees * Math.PI) / 180;
const velocityX = Math.cos(yaw) * speed;
const velocityZ = -Math.sin(yaw) * speed;

const world = createWorld();
const network = roadNetworkFor(world);
const origin = landformCoreCenter(world);

const built = new Map<string, { region: InfrastructureRegion; layer: RoadStreamLayer; ms: number }>();
function build(layer: RoadStreamLayer, rx: number, rz: number): InfrastructureRegion {
  const key = roadStreamRegionKey(layer, rx, rz);
  const cached = built.get(key);
  if (cached) return cached.region;
  const started = performance.now();
  const region = layer === "settlements"
    ? settlementRegion(network, rx, rz).infrastructure
    : roadRegionInfrastructure(network, network.region(layer, rx, rz));
  built.set(key, { region, layer, ms: performance.now() - started });
  return region;
}

const installed = new Map<string, InfrastructureRegion>();
let index = infrastructureIndex(world);
const staticSegments = index.segments.length;
let pack: TerrainInfrastructurePack | null = null;
let freshPacks = 0;
let peak = { segments: 0, bins: 0, second: 0, settlementSegments: 0, structures: 0 };

for (let second = 0; second <= seconds; second += 1) {
  const observer = { x: startX + velocityX * second, z: startZ + velocityZ * second, velocityX, velocityZ };
  const kept = new Set(roadStreamRegions(observer, ROAD_STREAM_KEEP_MARGIN)
    .filter((region) => layers.has(region.layer))
    .map((region) => roadStreamRegionKey(region.layer, region.rx, region.rz)));
  const install: InfrastructureRegion[] = [];
  for (const region of roadStreamRegions(observer)) {
    if (!layers.has(region.layer)) continue;
    const key = roadStreamRegionKey(region.layer, region.rx, region.rz);
    if (installed.has(key)) continue;
    const infrastructure = build(region.layer, region.rx, region.rz);
    installed.set(key, infrastructure);
    install.push(infrastructure);
  }
  const remove = [...installed.keys()].filter((key) => !kept.has(key));
  for (const key of remove) installed.delete(key);
  if (install.length === 0 && remove.length === 0) continue;
  installInfrastructureRegions(world, install, remove);
  const next = infrastructureIndex(world);
  if (!pack) {
    pack = new TerrainInfrastructurePack(next, world.seaLevel, origin, true, true);
    freshPacks += 1;
  } else {
    const changes = infrastructureIndexChanges(index, next);
    const ranges = changes ? pack.update(next, changes) : null;
    if (!ranges) {
      pack = new TerrainInfrastructurePack(next, world.seaLevel, origin, true, true);
      freshPacks += 1;
    }
  }
  index = next;
  let live = 0;
  let settlementSegments = 0;
  let structures = 0;
  for (const [key, region] of installed) {
    live += region.segments.length;
    if (key.startsWith("settlements:")) {
      settlementSegments += region.segments.length;
      structures += region.structures?.length ?? 0;
    }
  }
  if (live > peak.segments) peak = { segments: live, bins: next.bins.size, second, settlementSegments, structures };
}

const builds = [...built.values()];
const byLayer = (layer: RoadStreamLayer) => builds.filter((entry) => entry.layer === layer);
const quantile = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
console.log(`leg: ${seconds} s at ${speed} m/s from (${startX}, ${startZ}) yaw ${yawDegrees}; layers ${[...layers].join(", ")}`);
console.log(`static segments ${staticSegments}`);
console.log(`peak streamed segments ${peak.segments} (settlements ${peak.settlementSegments}, ${peak.structures} buildings) in ${peak.bins} bins at ${peak.second} s`);
console.log(`GPU copy: ${freshPacks} packs, ${pack?.relayouts.lists ?? 0} list relayouts, ${pack?.relayouts.table ?? 0} table rehashes`);
for (const layer of ["major", "track", "settlements"] as const) {
  const entries = byLayer(layer);
  if (entries.length === 0) continue;
  const ms = entries.map((entry) => entry.ms).sort((a, b) => a - b);
  const segments = entries.reduce((sum, entry) => sum + entry.region.segments.length, 0);
  console.log(`${layer}: ${entries.length} regions built, ${segments} segments; build ms p50 ${quantile(ms, 0.5).toFixed(1)} p95 ${quantile(ms, 0.95).toFixed(1)} max ${ms.at(-1)!.toFixed(1)} total ${ms.reduce((a, b) => a + b, 0).toFixed(0)}`);
}
