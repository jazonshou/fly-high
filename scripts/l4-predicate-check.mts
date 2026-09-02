/**
 * Independent check of the L-4 shot: resolve the SHIPPED predicate, then frame
 * against wherever it actually lands.
 *
 * My first pass validated a hand-specified vantage `(11000, 12000)`. That is
 * not what the harness does — `locate: "canopy-backlit"` SEARCHES, and a
 * predicate that resolves to a different ring than the one framed against
 * blesses terrain the capture never sees. `SWE II 2` says it resolves to
 * `(11000, 12000)`; this re-derives that rather than taking it, and then
 * re-runs the framing at whatever comes back.
 *
 *   npx tsx scripts/l4-predicate-check.mts
 */
import {
  headingVectorFromYaw,
  locateShotOffset,
  yawForSunBearing,
  PERF_CAPTURE_DEFAULT_CLOCK,
} from "./perf-capture.mts";
import { rayForPixel, marchToGround, type ShotCamera } from "./frame-forensics.mts";
import { densityField } from "../src/render/webgpu/detail/densityField";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import { createWorld, sampleTerrain, sampleTerrainHeight } from "../src/world";

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const airportX = world.airport?.centerX ?? 0;
const airportZ = world.airport?.centerZ ?? 0;
const clock = { dayOfYear: 171, solarTimeHours: 18.13 };
const AGL = 400;
const PITCH = 20;

// ---- 1. Resolve the shipped predicate, transcribed from the test ----------
const heading = headingVectorFromYaw(
  yawForSunBearing(sunDirectionForClock(clock, world.latitudeDegrees), 0),
);
console.log(
  `heading from sun bearing 0: (${heading.x.toFixed(4)}, ${heading.z.toFixed(4)})`
  + `  = ${((Math.atan2(heading.z, heading.x) * 180) / Math.PI).toFixed(1)} deg`,
);
void PERF_CAPTURE_DEFAULT_CLOCK;

const found = locateShotOffset((x, z) => {
  for (let ahead = 0; ahead <= 2_400; ahead += 200) {
    const sx = airportX + x + heading.x * ahead;
    const sz = airportZ + z + heading.z * ahead;
    const sample = sampleTerrain(world, sx, sz);
    if (sample.biomeName === "water") return false;
    const field = densityField(world.sourceSeedHash, {
      x: sx, z: sz,
      heightMeters: sample.height,
      seaLevelMeters: world.seaLevel,
      slope: sample.slope,
      moisture: sample.moisture,
      normalX: sample.normal.x,
      normalZ: sample.normal.z,
      airportInfluence: sample.airportInfluence,
      dayOfYear: clock.dayOfYear,
      filterWidthMeters: 0,
    });
    if (field.treeStemsPerSquareMeter < 0.006 || field.heightFactor < 0.35) return false;
  }
  return true;
}, { stepMeters: 500, maxRadiusMeters: 18_000 });

console.log(
  found
    ? `predicate resolves to offset (${found.offsetXMeters}, ${found.offsetZMeters})`
    : "predicate FOUND NOTHING — the shot would fall back",
);
if (!found) process.exit(1);
const agrees = found.offsetXMeters === 11_000 && found.offsetZMeters === 12_000;
console.log(`  SWE II 2 reported (11000, 12000): ${agrees ? "AGREES" : "DISAGREES"}`);

// ---- 2. Frame against WHERE IT RESOLVED, not where it was designed -------
const eyeX = airportX + found.offsetXMeters;
const eyeZ = airportZ + found.offsetZMeters;
const ground = sampleTerrainHeight(world, eyeX, eyeZ);
const pitch = (PITCH * Math.PI) / 180;
const h = Math.cos(-pitch);
const forward = { x: heading.x * h, y: Math.sin(-pitch), z: heading.z * h };
const rl = Math.hypot(-forward.z, forward.x) || 1;
const right = { x: -forward.z / rl, y: 0, z: forward.x / rl };
const up = {
  x: right.y * forward.z - right.z * forward.y,
  y: right.z * forward.x - right.x * forward.z,
  z: right.x * forward.y - right.y * forward.x,
};
const camera: ShotCamera = {
  eye: { x: eyeX, y: ground + AGL, z: eyeZ },
  forward, up, right, width: 1_280, height: 720, horizontalFovDegrees: 56,
};
console.log(`camera ground ${ground.toFixed(1)} m, eye ${(ground + AGL).toFixed(1)} m`);

const heightAt = (x: number, z: number) => sampleTerrainHeight(world, x, z);
let sky = 0, water = 0, land = 0, canopy = 0;
const band = { near: 0, mid: 0, far: 0, beyond: 0 };
let minR = Infinity, maxR = 0;
for (let py = 0; py < camera.height; py += 24) {
  for (let px = 0; px < camera.width; px += 24) {
    const dir = rayForPixel(camera, px, py);
    const hit = marchToGround(camera, dir, heightAt, { stepMeters: 6, maxMeters: 9_000 });
    if (!hit) { sky += 1; continue; }
    const s = sampleTerrain(world, hit.x, hit.z, undefined, clock.dayOfYear);
    if (s.height < world.seaLevel + 0.5) { water += 1; continue; }
    land += 1;
    const horiz = Math.hypot(hit.x - camera.eye.x, hit.z - camera.eye.z);
    minR = Math.min(minR, horiz); maxR = Math.max(maxR, horiz);
    if (horiz < 1_400) band.near += 1;
    else if (horiz < 3_000) band.mid += 1;
    else if (horiz < 4_800) band.far += 1;
    else band.beyond += 1;
    const f = densityField(world.sourceSeedHash, {
      filterWidthMeters: 0, x: hit.x, z: hit.z,
      heightMeters: s.height, seaLevelMeters: world.seaLevel,
      slope: s.slope, moisture: s.moisture,
      normalX: s.normal.x, normalZ: s.normal.z, dayOfYear: clock.dayOfYear,
    });
    if (f.treeStemsPerSquareMeter >= 0.0075 && f.heightFactor >= 0.4) canopy += 1;
  }
}
const total = sky + water + land;
console.log(
  `\nrays ${total}: sky ${((sky / total) * 100).toFixed(1)}%, water `
  + `${((water / total) * 100).toFixed(1)}%, land ${((land / total) * 100).toFixed(1)}%`
  + `\n  canopy on land hits ${((canopy / Math.max(1, land)) * 100).toFixed(1)}%`
  + `\n  ground range ${minR.toFixed(0)}-${maxR.toFixed(0)} m`
  + `\n  bands: near ${band.near}, mid ${band.mid}, far ${band.far}, beyond ${band.beyond}`,
);
const fail: string[] = [];
if (water / total > 0.02) fail.push("water in frame");
if (canopy / Math.max(1, land) < 0.15) fail.push("too little canopy");
if (band.mid < 5) fail.push("no mid band");
if (band.far + band.beyond < 5) fail.push("no far band");
console.log(fail.length === 0
  ? "\nVERDICT: the shot can fail — predicate and framing agree."
  : `\nVERDICT: DO NOT LAND — ${fail.join("; ")}`);
