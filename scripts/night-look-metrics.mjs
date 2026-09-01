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
const skyLumas = [];
for (let y = Math.floor(SKY.y0 * H); y < Math.floor(SKY.y1 * H); y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    blueSum += (data[i + 2] - (data[i] + data[i + 1]) / 2) / 255;
    skyLumas.push(luma(i));
    skyCount++;
  }
}
const skyBlue = skyCount ? blueSum / skyCount : 0;

// §2.6 — the silhouette RELATION: sky-band median over terrain-band median,
// both from THIS script's bands (SKY y 0.02-0.25, TERRAIN y 0.45-0.95 —
// instrument named because two "terrain band" instruments disagreed by 40%
// on 2026-09-01). A relation cannot be satisfied by darkening everything
// and survives any later exposure change. Twilight-only gate: at dusk the
// sky must outglow the ground (floor >= 1.5; reality at civil dusk is
// ~10x); at night a moonlit ground under a dark sky legitimately reads
// below 1, so night rungs carry no floor on this metric.
skyLumas.sort((a, b) => a - b);
const skyMedian = skyLumas[Math.floor(skyLumas.length / 2)] ?? 0;
const skyGroundRatio = terrainMedian > 0 ? skyMedian / terrainMedian : Infinity;

// Lamp chroma is read on the SHOULDER (0.45-0.60 luminance within 4 px of a
// >=0.90 core), never at the peak: the ACES shoulder desaturates bright
// cores toward white BY DESIGN (measured: cores 245,245,245 with 15/443
// hard-clipped; saturation rises monotonically as brightness falls), and a
// core-sampled gate measures the tone map, not the chroma path. A viewer
// reads a light's colour on its halo; so does this metric.
const coreMask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (luma((y * W + x) * 4) >= LAMP_FLOOR) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W) coreMask[yy * W + xx] = 1;
        }
      }
    }
  }
}
// ...and WHICH hue that chroma is (PM + this session, 2026-09-01): a
// saturation scalar certified a mis-hued shoulder, and then an UNDOCUMENTED
// BUCKET BOUNDARY generated three wrong headlines between two careful
// readers ("34% violet" filed correct PAPI/threshold reds at 345-360 under
// violet>=260; "82% warm" wrap-counted the same reds as amber). Buckets,
// therefore documented AT the definition and aligned to the FIXTURE SET:
//   fixture-correct: [345,70) red-through-amber  +  [95,150] threshold green
//   off-fixture:     (160,345) cyan through magenta - where flipped WHITES
//                    land (the tint flip is B-dominant, hue ~230) and where
//                    they hue-camouflage against the cyan moonlit background,
//                    invisible to enrichment analysis by construction.
// lampOffFixtureFraction gates the line; count and chroma-weight both
// reported. A pass on quantity with a fail on hue is the feature landing
// WRONG rather than absent, which the scalar cannot see.
// Bucket justification, derived not chosen (2026-09-01): pure PAPI red
// through the tint rotates only -1.4 deg (red x tint stays R-dominant at
// ~358.6), so a pixel below 345 cannot be a barely-tinted red — but
// 330..345 IS reachable by red glow COMPOSITING over the cyan-blue
// moonlit background (additive red-over-blue reads magenta at the edges,
// photographically true), so that band's attribution is genuinely
// ambiguous and is REPORTED SEPARATELY, never assigned. No saturation
// gate on the count denominators: a sat floor excludes exactly the
// diluted flipped whites the metric exists to see (measured: the gate
// moved off-fixture from 39.6% to 27.5% by silently dropping them).
const HUE_OFF_LO = 160, HUE_AMBIG_LO = 330, HUE_CORRECT_LO = 345;
let lampSatSum = 0, lampCount = 0;
let offChroma = 0, totalChroma = 0;
let offCount = 0, ambigCount = 0, neutralCount = 0, classifiedCount = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!coreMask[y * W + x]) continue;
    const i = (y * W + x) * 4;
    const L = luma(i);
    if (L < 0.45 || L > 0.6) continue;
    const mx = Math.max(data[i], data[i + 1], data[i + 2]);
    const mn = Math.min(data[i], data[i + 1], data[i + 2]);
    const sat = mx ? (mx - mn) / mx : 0;
    lampSatSum += sat;
    lampCount++;
    const h = hueDegrees(data[i], data[i + 1], data[i + 2]);
    if (h === null) { neutralCount++; continue; }
    classifiedCount++;
    totalChroma += sat;
    const off = h > HUE_OFF_LO && h < HUE_AMBIG_LO;
    const ambiguous = h >= HUE_AMBIG_LO && h < HUE_CORRECT_LO;
    if (off) { offChroma += sat; offCount++; }
    else if (ambiguous) ambigCount++;
  }
}
const lampSat = lampCount ? lampSatSum / lampCount : 0;
const lampOffFixtureChroma = totalChroma > 0 ? offChroma / totalChroma : 0;
const lampOffFixtureCount = classifiedCount > 0 ? offCount / classifiedCount : 0;
const lampAmbiguousCount = classifiedCount > 0 ? ambigCount / classifiedCount : 0;

console.log(`${label ?? path} (${W}x${H})`);
console.log(`  terrainBandMedianLuma  ${terrainMedian.toFixed(4)}   (moonlit target [0.15, 0.30]; moonless [0.06, 0.14])`);
console.log(`  chromaSaturation       ${chromaSat.toFixed(4)} over ${satCount} px  (proposed floor ~0.15)`);
console.log(`  skyBlueDominance       ${skyBlue.toFixed(4)}   (proposed floor ~0.02, ceiling ~0.25)`);
console.log(`  skyGroundRatio         ${skyGroundRatio.toFixed(4)}   (sky median ${skyMedian.toFixed(4)} / terrain median; DUSK floor 1.5, no night floor)`);
console.log(`  lampShoulderSaturation ${lampSat.toFixed(4)} over ${lampCount} px in 0.45-0.60 near cores  (floor 0.15; "not all white")`);
console.log(`  lampOffFixture         count ${lampOffFixtureCount.toFixed(4)} / chroma ${lampOffFixtureChroma.toFixed(4)} in (160,330); ambiguous[330,345) ${lampAmbiguousCount.toFixed(4)}; neutral ${neutralCount} px  (ceiling TBD from Jason)`);
console.log(`  hueDiversity           ${hueDiversity.toFixed(4)} over ${colored.length} colored px, dominant ${dominantHue.toFixed(0)} deg  (proposed floor ~0.15)`);
