import { decodePng, luminance, pixelAt } from "./frame-forensics.mts";
for (const shot of process.argv.slice(2)) {
  const before = decodePng(`tests/perf/baseline/${shot}.png`);
  const after = decodePng(`tests/perf/artifacts/${shot}.png`);
  const W = Math.min(before.width, after.width), H = Math.min(before.height, after.height);
  let brighter = 0, darker = 0, total = 0, maxGain = 0, sumGain = 0;
  let bx = 0, by = 0;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const a = pixelAt(before, x, y), b = pixelAt(after, x, y);
    const ya = luminance(a[0], a[1], a[2]), yb = luminance(b[0], b[1], b[2]);
    total += 1;
    const d = yb - ya;
    if (d > 0.004) brighter += 1; else if (d < -0.004) darker += 1;
    if (d > maxGain) { maxGain = d; bx = x; by = y; }
    sumGain += d;
  }
  console.log(`${shot}: brighter ${(100*brighter/total).toFixed(3)}%  darker ${(100*darker/total).toFixed(3)}%  `
    + `meanDeltaY ${(sumGain/total).toFixed(6)}  maxGain ${maxGain.toFixed(4)} at (${bx},${by})`);
}
