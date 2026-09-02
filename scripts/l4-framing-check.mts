/**
 * Independent framing check for the L-4 back-lit mid/far shot.
 *
 * `SWE II 2` cannot spawn subagents to self-insulate, and an independent check
 * has caught a bad shot twice tonight: beautiful captures of open ocean, and a
 * horizon vantage with zero trees at every range in the annulus it existed to
 * exercise. Both were shots that COULD NOT FAIL — they would have captured
 * cleanly, passed every gate, and evidenced nothing.
 *
 * So this re-derives the framing from the shot parameters rather than checking
 * `SWE II 2`'s arithmetic, and asks the three questions that killed the other
 * two shots:
 *   1. Is there water in frame where there should be none?
 *   2. Is there CANOPY where the claim needs canopy?
 *   3. Are all three canopy representations (mid / far / beyond-far) present,
 *      since a mid-vs-far ratio needs both sides in one frame?
 *
 * Node-only, no GPU, no capture.
 *
 *   npx tsx scripts/l4-framing-check.mts
 */
import { rayForPixel, marchToGround, type ShotCamera } from "./frame-forensics.mts";
import { densityField } from "../src/render/webgpu/detail/densityField";
import { solarPosition } from "../src/render/webgpu/nature/EnvironmentDirector";
import { createWorld, sampleTerrain, sampleTerrainHeight } from "../src/world";

const WORLD = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const AX = WORLD.airport?.centerX ?? 0;
const AZ = WORLD.airport?.centerZ ?? 0;

// The proposed shot.
const OFFSET_X = 11_000;
const OFFSET_Z = 12_000;
const AGL = 400;
const PITCH_DOWN_DEGREES = 20;
const CLOCK_HOURS = 18.13;
const DAY = 171;
const LATITUDE = 45;

// Tier 1 band edges — the ratio needs both sides of shadowDistance and the
// impostor cull radius in one frame.
const SHADOW_DISTANCE = 1_400;
const VEGETATION_DISTANCE = 3_000;
const IMPOSTOR_CAPABLE_STEMS = 0.0075;

const sun = solarPosition({ dayOfYear: DAY, solarTimeHours: CLOCK_HOURS } as never, LATITUDE);
const sunElevationDeg = (sun.elevationRadians * 180) / Math.PI;
// solarPosition's azimuth is clockwise from north over (east, north); the world
// ground track the shader reads is atan2(z, x) with x=east, z=north.
const sunGroundAzimuth = Math.atan2(Math.cos(sun.azimuthRadians), Math.sin(sun.azimuthRadians));

console.log(
  `sun at ${CLOCK_HOURS}h day ${DAY} lat ${LATITUDE}: elevation `
  + `${sunElevationDeg.toFixed(2)} deg (SWE II 2 says 15.03), ground bearing `
  + `${((sunGroundAzimuth * 180) / Math.PI).toFixed(1)} deg`,
);

// relativeSunBearingDegrees 0 => the camera looks TOWARD the sun (back-lit,
// which is the condition L-4 is about — see impostorBacklit's own comment).
const eyeX = AX + OFFSET_X;
const eyeZ = AZ + OFFSET_Z;
const ground = sampleTerrainHeight(WORLD, eyeX, eyeZ);
const pitch = (PITCH_DOWN_DEGREES * Math.PI) / 180;
const fwdH = Math.cos(-pitch);
const forward = {
  x: Math.cos(sunGroundAzimuth) * fwdH,
  y: Math.sin(-pitch),
  z: Math.sin(sunGroundAzimuth) * fwdH,
};
// Right = forward x worldUp, normalised; up = right x forward.
const rl = Math.hypot(-forward.z, forward.x) || 1;
const right = { x: -forward.z / rl, y: 0, z: forward.x / rl };
const up = {
  x: right.y * forward.z - right.z * forward.y,
  y: right.z * forward.x - right.x * forward.z,
  z: right.x * forward.y - right.y * forward.x,
};
const camera: ShotCamera = {
  eye: { x: eyeX, y: ground + AGL, z: eyeZ },
  forward, up, right,
  width: 1_280, height: 720,
  horizontalFovDegrees: 56,
};
console.log(
  `camera offset (${OFFSET_X}, ${OFFSET_Z})  ground ${ground.toFixed(1)} m`
  + `  eye ${(ground + AGL).toFixed(1)} m  pitch ${PITCH_DOWN_DEGREES} deg`,
);

const heightAt = (x: number, z: number) => sampleTerrainHeight(WORLD, x, z);
let sky = 0;
let water = 0;
let landHits = 0;
let canopyHits = 0;
const band = { near: 0, mid: 0, far: 0, beyond: 0 };
const STRIDE = 24;

for (let py = 0; py < camera.height; py += STRIDE) {
  for (let px = 0; px < camera.width; px += STRIDE) {
    const dir = rayForPixel(camera, px, py);
    const hit = marchToGround(camera, dir, heightAt, { stepMeters: 6, maxMeters: 9_000 });
    if (!hit) { sky += 1; continue; }
    const s = sampleTerrain(WORLD, hit.x, hit.z, undefined, DAY);
    if (s.height < WORLD.seaLevel + 0.5) { water += 1; continue; }
    landHits += 1;
    // Band membership is HORIZONTAL distance (presentationBuild.ts), not slant.
    const horizontal = Math.hypot(hit.x - camera.eye.x, hit.z - camera.eye.z);
    if (horizontal < SHADOW_DISTANCE) band.near += 1;
    else if (horizontal < VEGETATION_DISTANCE) band.mid += 1;
    else if (horizontal < VEGETATION_DISTANCE * 1.6) band.far += 1;
    else band.beyond += 1;
    const f = densityField(WORLD.sourceSeedHash, {
      filterWidthMeters: 0,
      x: hit.x, z: hit.z,
      heightMeters: s.height,
      seaLevelMeters: WORLD.seaLevel,
      slope: s.slope, moisture: s.moisture,
      normalX: s.normal.x, normalZ: s.normal.z,
      dayOfYear: DAY,
    });
    if (f.treeStemsPerSquareMeter >= IMPOSTOR_CAPABLE_STEMS && f.heightFactor >= 0.4) {
      canopyHits += 1;
    }
  }
}
const total = sky + water + landHits;
console.log(
  `\nrays ${total}: sky ${((sky / total) * 100).toFixed(1)}%, `
  + `water ${((water / total) * 100).toFixed(1)}%, land ${((landHits / total) * 100).toFixed(1)}%`,
);
console.log(
  `  impostor-capable canopy on land hits: `
  + `${((canopyHits / Math.max(1, landHits)) * 100).toFixed(1)}%`,
);
console.log(
  `  horizontal band coverage — near(<${SHADOW_DISTANCE}) ${band.near}, `
  + `mid(${SHADOW_DISTANCE}-${VEGETATION_DISTANCE}) ${band.mid}, `
  + `far(${VEGETATION_DISTANCE}-4800) ${band.far}, beyond ${band.beyond}`,
);

const verdict: string[] = [];
if (water / total > 0.02) verdict.push("WATER IN FRAME — the open-ocean failure mode");
if (canopyHits / Math.max(1, landHits) < 0.15) verdict.push("TOO LITTLE CANOPY — the zero-stems failure mode");
if (band.mid < 5) verdict.push("NO MID BAND — the ratio has only one side");
if (band.far + band.beyond < 5) verdict.push("NO FAR BAND — the ratio has only one side");
console.log(
  verdict.length === 0
    ? "\nVERDICT: the shot can fail — water clear, canopy present, both sides of the ratio in frame."
    : `\nVERDICT: DO NOT LAND — ${verdict.join("; ")}`,
);
