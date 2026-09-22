/**
 * Measure a livery frame at PROJECTED positions -- nothing is located by
 * searching the image for a colour.
 *
 *   npx tsx scripts/livery-measure.mts <frame.json> [<frame.json> ...]
 *
 * For each frame: pixels per metre on the flank; the band's top-edge transition
 * width (10%-90%) along lines of points ON THE SKIN at several stations; and
 * pane-vs-skin contrast for both window rows, from the window mesh's own pane
 * centres.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

// FUSELAGE_SECTIONS, transcribed from airlinerVisual.ts (x, yRadius, zRadius, yOffset, crownZRadius).
// crownZRadius is here and not in AIRLINER_LIVERY_SECTIONS: it moves z, which
// the height solve never needs and a point ON the skin does.
const S = [
  [-26, 3.08, 3.08, 0.16, 3.08], [-20, 3.25, 3.25, 0, 3.25], [-6, 3.25, 3.25, 0, 3.25],
  [0, 3.265, 3.25, 0.015, 3.23], [5, 3.35, 3.25, 0.1, 3.14], [9, 3.525, 3.25, 0.275, 2.94],
  [13, 3.685, 3.25, 0.435, 2.76], [17, 3.785, 3.25, 0.535, 2.65], [21, 3.82, 3.25, 0.57, 2.61],
  [26, 3.825, 3.25, 0.575, 2.6], [28, 3.575, 3, 0.675, 2.45], [29.6, 3.15, 2.6, 0.65, 2.2],
  [30.6, 2.55, 2.05, 0.6, 1.8],
] as const;
const at = (x: number) => {
  for (let i = 1; i < S.length; i += 1) {
    if (x <= S[i]![0]) {
      const a = S[i - 1]!, b = S[i]!, t = (x - a[0]) / (b[0] - a[0]);
      return a.map((v, k) => v + (b[k]! - v) * t);
    }
  }
  return [...S[S.length - 1]!];
};
/** Starboard skin z at (x, y), the loft's own superellipse (squareness 2) with the crown taper. */
const skinZ = (x: number, y: number) => {
  const [, yR, zR, yO, cZ] = at(x);
  const c = (y - yO!) / yR!;
  if (Math.abs(c) > 1) return NaN;
  const rise = Math.max(0, c), lift = rise * rise * (3 - 2 * rise);
  return Math.sqrt(1 - c * c) * (zR! + (cZ! - zR!) * lift);
};

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
  const lumAt = (px: number, py: number) => {
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    const L = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) return NaN;
      const i = (y * info.width + x) * info.channels;
      return 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    };
    return L(x0, y0) * (1 - fx) * (1 - fy) + L(x0 + 1, y0) * fx * (1 - fy)
      + L(x0, y0 + 1) * (1 - fx) * fy + L(x0 + 1, y0 + 1) * fx * fy;
  };
  const box = (px: number, py: number, r: number) => {
    const v: number[] = [];
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) v.push(lumAt(px + dx, py + dy));
    return v.filter(Number.isFinite).reduce((a, b) => a + b, 0) / v.filter(Number.isFinite).length;
  };
  const median = (v: number[]) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? NaN; };

  // pixels per metre along the flank, at the main-deck row
  const a = project([0, 0.2, skinZ(0, 0.2)]), b = project([1, 0.2, skinZ(1, 0.2)]);
  const pxPerM = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);

  // band top edge: 10%-90% transition width along a vertical line ON the skin
  const edges: string[] = [], widthsM: number[] = [], widthsPx: number[] = [];
  for (const x of [-18, -12, -6, 0, 6, 12, 18, 22]) {
    const ys: number[] = [], L: number[] = [], P: number[][] = [];
    // +-0.30 and plateaus 0.12-0.28 from the edge: the whole scan stays under
    // the main-deck pane bottoms (y = 0.02) for a top edge at -0.30 or lower.
    // At +-0.35 the first samples fell on a pane, read dark, and the 90 %
    // crossing landed on sample 0 -- a "38 cm" edge that was the scan window.
    for (let y = f.bandTop + 0.30; y >= f.bandTop - 0.30; y -= 0.005) {
      const z = skinZ(x, y); if (!Number.isFinite(z)) continue;
      const p = project([x, y, z]);
      ys.push(y); P.push(p); L.push(lumAt(p[0]!, p[1]!));
    }
    const hi = median(L.filter((_, i) => ys[i]! >= f.bandTop + 0.12 && ys[i]! <= f.bandTop + 0.28));
    const lo = median(L.filter((_, i) => ys[i]! <= f.bandTop - 0.12 && ys[i]! >= f.bandTop - 0.28));
    if (!(hi - lo > 25)) { edges.push(`x=${x}: NO EDGE (plateaus ${hi.toFixed(0)}/${lo.toFixed(0)}; occluded or off-frame)`); continue; }
    const n = L.map((v) => (v - lo) / (hi - lo));
    // The edge: the first sample under 10 %, and the LAST sample at or above
    // 90 % before it -- not the first under 90 %, which a dark pane or seam
    // above the edge can supply.
    const i10 = n.findIndex((v) => v < 0.1);
    let i90 = -1;
    for (let i = 0; i < i10; i += 1) if (n[i]! >= 0.9) i90 = i;
    if (i90 < 0 || i10 < 0) { edges.push(`x=${x}: edge not crossed`); continue; }
    const wm = ys[i90]! - ys[i10]!, wp = Math.hypot(P[i10]![0]! - P[i90]![0]!, P[i10]![1]! - P[i90]![1]!);
    widthsM.push(wm); widthsPx.push(wp);
    edges.push(`x=${String(x).padStart(3)}: ${(wm * 100).toFixed(1)} cm = ${wp.toFixed(1)} px  (skin ${hi.toFixed(0)} -> band ${lo.toFixed(0)})`);
  }

  // window rows: pane centre vs the skin midway to the next pane in the same row
  const rows: Record<string, { pane: number[]; skin: number[] }> = { main: { pane: [], skin: [] }, upper: { pane: [], skin: [] } };
  const r = pxPerM > 40 ? 2 : 1;
  for (const deck of ["main", "upper"] as const) {
    const panes = (f.panes as { deck: string; body: number[] }[]).filter((p) => p.deck === deck)
      .sort((p, q) => p.body[0]! - q.body[0]!);
    for (let i = 0; i + 1 < panes.length; i += 1) {
      const p = panes[i]!.body, q = panes[i + 1]!.body;
      if (Math.abs(q[0]! - p[0]! - 0.56) > 0.05) continue; // adjacent panes only
      const pc = project(p), mc = project([(p[0]! + q[0]!) / 2, (p[1]! + q[1]!) / 2, (p[2]! + q[2]!) / 2]);
      if (pc[0]! < 4 || pc[0]! > info.width - 4 || pc[1]! < 4 || pc[1]! > info.height - 4) continue;
      rows[deck]!.pane.push(box(pc[0]!, pc[1]!, r));
      rows[deck]!.skin.push(box(mc[0]!, mc[1]!, r));
    }
  }
  console.log(`\n=== ${f.label} @ ${f.distance} m  (${f.png.split("/").pop()}, ${pxPerM.toFixed(1)} px/m, band top y=${f.bandTop})`);
  console.log(`  band top edge, 10-90%: median ${(median(widthsM) * 100).toFixed(1)} cm = ${median(widthsPx).toFixed(1)} px`);
  for (const e of edges) console.log(`    ${e}`);
  for (const deck of ["main", "upper"] as const) {
    const pane = median(rows[deck]!.pane), skin = median(rows[deck]!.skin);
    console.log(`  ${deck.padEnd(5)} row: n=${rows[deck]!.pane.length}  pane ${pane.toFixed(1)}  skin ${skin.toFixed(1)}  `
      + `difference ${(skin - pane).toFixed(1)}  Weber ${((skin - pane) / skin).toFixed(3)}  ratio ${(skin / pane).toFixed(2)}`);
  }
}
