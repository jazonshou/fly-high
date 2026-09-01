// Night-look acceptance metrics — the NIGHT_LOOK_ARCHITECTURE.md §3 instrument.
//
//   node scripts/night-look-metrics.mjs <shot.png> [label]
//
// Scores one captured frame on the night-look metrics. The gate values and
// the RED DEMONSTRATION record (two metric designs died on the rejected
// baselines before hueDiversity survived) live in the architecture doc; this
// script is the measurement, the doc is the contract. The production gate
// lands in perf-capture via the litRegion pattern once Jason approves a round.
import fs from "node:fs";
import { createRequire } from "node:module";
const { PNG } = createRequire(import.meta.url)("pngjs");

const [path, label] = process.argv.slice(2);
const img = PNG.sync.read(fs.readFileSync(path));
const { width: W, height: H, data } = img;

const luma = (i) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;

// Bands in viewport fractions (mirrors the litRegion convention).
const TERRAIN = { y0: 0.45, y1: 0.95 };
const SKY = { y0: 0.02, y1: 0.25 };
const LAMP_FLOOR = 0.9; // the lit-gate's calibrated floor

const terrainLumas = [];
// LUMINANCE-WEIGHTED colorfulness, not mean relative saturation. The first
// draft used mean sat over pixels with max>=8 and PASSED Jason's rejected
// frames at 0.2953: near-black quantization noise ([8,3,1] -> sat 0.875)
// dominates an unweighted mean, so the metric measured noise, not the grey
// world he saw. Weighting by luma makes invisible pixels contribute nothing:
// colorfulness = sum(sat_i * luma_i) / sum(luma_i).
let satLumaSum = 0, lumaSum = 0, satCount = 0;
for (let y = Math.floor(TERRAIN.y0 * H); y < Math.floor(TERRAIN.y1 * H); y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const L = luma(i);
    terrainLumas.push(L);
    const mx = Math.max(data[i], data[i + 1], data[i + 2]);
    const mn = Math.min(data[i], data[i + 1], data[i + 2]);
    const sat = mx ? (mx - mn) / mx : 0;
    satLumaSum += sat * L;
    lumaSum += L;
    satCount++;
  }
}
terrainLumas.sort((a, b) => a - b);
const terrainMedian = terrainLumas[Math.floor(terrainLumas.length / 2)] ?? 0;
const chromaSat = lumaSum > 0 ? satLumaSum / lumaSum : 0;

// HUE DIVERSITY — the metric that actually captures "black and white".
// Second red-arm failure taught this: the rejected frame reads 0.295
// luminance-weighted saturation because SCOTOPIC_TINT is itself ~53%
// saturated blue — the frame is a CYANOTYPE, one hue everywhere, and that
// is what Jason called black and white. So measure hue UNIFORMITY: among
// visibly colored pixels (sat >= 0.15, luma >= 0.02) in the terrain band,
// the luminance fraction whose hue sits > 30 degrees off the dominant hue.
// A tinted-monochrome frame reads ~0; a world holding green grass, blue
// water and warm light reads high.
function hueDegrees(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return null;
  const d = mx - mn;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
let vx = 0, vy = 0;
const colored = []; // [hueDeg, luma]
for (let y = Math.floor(TERRAIN.y0 * H); y < Math.floor(TERRAIN.y1 * H); y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const L = luma(i);
    if (L < 0.02) continue;
    const mx = Math.max(data[i], data[i + 1], data[i + 2]);
    const mn = Math.min(data[i], data[i + 1], data[i + 2]);
    if (!mx || (mx - mn) / mx < 0.15) continue;
    const h = hueDegrees(data[i], data[i + 1], data[i + 2]);
    if (h === null) continue;
    const rad = (h * Math.PI) / 180;
    vx += Math.cos(rad) * L;
    vy += Math.sin(rad) * L;
    colored.push([h, L]);
  }
}
const dominantHue = ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
let offLuma = 0, coloredLuma = 0;
for (const [h, L] of colored) {
  coloredLuma += L;
  const d = Math.abs(((h - dominantHue + 540) % 360) - 180);
  if (d > 30) offLuma += L;
}
const hueDiversity = coloredLuma > 0 ? offLuma / coloredLuma : 0;

let blueSum = 0, skyCount = 0;
for (let y = Math.floor(SKY.y0 * H); y < Math.floor(SKY.y1 * H); y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    blueSum += (data[i + 2] - (data[i] + data[i + 1]) / 2) / 255;
    skyCount++;
  }
}
const skyBlue = skyCount ? blueSum / skyCount : 0;

let lampSatSum = 0, lampCount = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (luma(i) >= LAMP_FLOOR) {
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      const mn = Math.min(data[i], data[i + 1], data[i + 2]);
      lampSatSum += mx ? (mx - mn) / mx : 0;
      lampCount++;
    }
  }
}
const lampSat = lampCount ? lampSatSum / lampCount : 0;

console.log(`${label ?? path} (${W}x${H})`);
console.log(`  terrainBandMedianLuma  ${terrainMedian.toFixed(4)}   (moonlit target [0.15, 0.30]; moonless [0.06, 0.14])`);
console.log(`  chromaSaturation       ${chromaSat.toFixed(4)} over ${satCount} px  (proposed floor ~0.15)`);
console.log(`  skyBlueDominance       ${skyBlue.toFixed(4)}   (proposed floor ~0.02, ceiling ~0.25)`);
console.log(`  lampMeanSaturation     ${lampSat.toFixed(4)} over ${lampCount} px  (proposed floor ~0.15; "not all white")`);
console.log(`  hueDiversity           ${hueDiversity.toFixed(4)} over ${colored.length} colored px, dominant ${dominantHue.toFixed(0)} deg  (proposed floor ~0.15)`);
