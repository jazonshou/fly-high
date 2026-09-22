/**
 * Does the band THIN over the wing root? Visible navy extent per station,
 * against the intended `CHEATLINE` heights, along lines of points ON the
 * starboard skin, projected through the frame's own camera (a frame from
 * `livery-flank-frames.mts`).
 *
 *   npx tsx scripts/livery-band-height.mts <frame.json> [...]
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { CHEATLINE, MAIN_DECK_DOORS } from "../src/render/webgpu/aircraft/airlinerLivery";

const S = [
  [-26, 3.08, 3.08, 0.16, 3.08], [-20, 3.25, 3.25, 0, 3.25], [-6, 3.25, 3.25, 0, 3.25],
  [0, 3.265, 3.25, 0.015, 3.23], [5, 3.35, 3.25, 0.1, 3.14], [9, 3.525, 3.25, 0.275, 2.94],
  [13, 3.685, 3.25, 0.435, 2.76], [17, 3.785, 3.25, 0.535, 2.65], [21, 3.82, 3.25, 0.57, 2.61],
  [26, 3.825, 3.25, 0.575, 2.6], [28, 3.575, 3, 0.675, 2.45], [29.6, 3.15, 2.6, 0.65, 2.2],
  [30.6, 2.55, 2.05, 0.6, 1.8],
] as const;
const at = (x: number) => {
  for (let i = 1; i < S.length; i += 1) if (x <= S[i]![0]) {
    const a = S[i - 1]!, b = S[i]!, t = (x - a[0]) / (b[0] - a[0]);
    return a.map((v, k) => v + (b[k]! - v) * t);
  }
  return [...S[S.length - 1]!];
};
const skinZ = (x: number, y: number) => {
  const [, yR, zR, yO, cZ] = at(x);
  const c = (y - yO!) / yR!;
  if (Math.abs(c) > 1) return NaN;
  const rise = Math.max(0, c), lift = rise * rise * (3 - 2 * rise);
  return Math.sqrt(1 - c * c) * (zR! + (cZ! - zR!) * lift);
};
const DOORS = MAIN_DECK_DOORS.map((door) => door.x);
const INTENDED = `${CHEATLINE.bottomY.toFixed(2)}..${CHEATLINE.topY.toFixed(2)}, ${(CHEATLINE.topY - CHEATLINE.bottomY).toFixed(2)} m`;

for (const file of process.argv.slice(2)) {
  const f = JSON.parse(readFileSync(file, "utf8"));
  const { data, info } = await sharp(f.png).raw().toBuffer({ resolveWithObject: true });
  const W: number[] = f.W, VP: number[] = f.VP;
  const project = (p: number[]) => {
    const w = [0, 1, 2].map((k) => p[0]! * W[k]! + p[1]! * W[4 + k]! + p[2]! * W[8 + k]! + W[12 + k]!);
    const cx = w[0]! * VP[0]! + w[1]! * VP[4]! + w[2]! * VP[8]! + VP[12]!;
    const cy = w[0]! * VP[1]! + w[1]! * VP[5]! + w[2]! * VP[9]! + VP[13]!;
    const cw = w[0]! * VP[3]! + w[1]! * VP[7]! + w[2]! * VP[11]! + VP[15]!;
    return [((cx / cw + 1) / 2) * info.width, ((1 - cy / cw) / 2) * info.height];
  };
  const lum = (px: number, py: number) => {
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= info.width || y >= info.height) return NaN;
    const i = (y * info.width + x) * info.channels;
    return 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  };
  console.log(`\n=== ${f.label} @ ${f.distance} m: visible navy extent per station (intended ${INTENDED})`);
  const heights: { x: number; h: number }[] = [];
  for (let x = -24; x <= 26; x += 2) {
    const door = DOORS.some((d) => Math.abs(d - x) < 0.8);
    let top = NaN, bottom = NaN, offFrame = false;
    for (let y = CHEATLINE.topY + 0.1; y >= CHEATLINE.bottomY - 0.4; y -= 0.01) {
      const z = skinZ(x, y); if (!Number.isFinite(z)) continue;
      const p = project([x, y, z]);
      const L = lum(p[0]!, p[1]!);
      if (!Number.isFinite(L)) { offFrame = true; break; }
      // navy: dark, well below the white skin (~110-190 in these frames) and the grey belly
      if (L < 45) { if (!Number.isFinite(top)) top = y; bottom = y; }
    }
    if (offFrame) continue;
    const h = Number.isFinite(top) ? top - bottom : 0;
    heights.push({ x, h });
    console.log(`  x=${String(x).padStart(3)}  ${Number.isFinite(top) ? `navy ${top.toFixed(2)} .. ${bottom.toFixed(2)}  height ${h.toFixed(2)} m` : "NO NAVY"}${door ? "   (door station)" : ""}`);
  }
  const clean = heights.filter((r) => !DOORS.some((d) => Math.abs(d - r.x) < 0.8));
  const hs = clean.map((r) => r.h).sort((a, b) => a - b);
  console.log(`  clean stations: ${clean.length}; height min ${hs[0]?.toFixed(2)} median ${hs[Math.floor(hs.length / 2)]?.toFixed(2)} max ${hs[hs.length - 1]?.toFixed(2)} m`);
}
