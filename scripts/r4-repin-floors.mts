/**
 * R4: re-pin every per-shot delivery floor from N clean runs.
 *
 * The rules are NOT invented here — they are `PerfCaptureShotCeilings`'s own,
 * transcribed so the arithmetic is mechanical and reviewable:
 *
 *   minFps / minWallClockFps = floor(min-across-runs x 0.85)
 *   maxFrameIntervalMsP95    = ceil(max-across-runs x 1.2, 0.1)
 *   hitchCount               = max(2 x measured, 3)
 *   maxFrameMs               = 50   (the strict tier-1 gate)
 *   p999FrameMs              = min(50, ceil(max-across-runs x 1.5))
 *
 * Three runs minimum, because a single cool-host run samples the favourable
 * end of a ~20% thermal band — measured, not assumed: the same-tree spread on
 * `reference-viewport` was 74.0 / 115.1 / 120.1 fps within one session.
 *
 *   npx tsx scripts/r4-repin-floors.mts <report.json> <report.json> <report.json>
 */
import { readFileSync } from "node:fs";

interface Shot {
  name: string;
  fps?: number;
  wallClockFps?: number;
  frameIntervalMsP95?: number;
  hitchCount?: number;
  p999FrameMs?: number;
  maxFrameMs?: number;
  drawCalls?: number;
}

const paths = process.argv.slice(2);
if (paths.length < 3) {
  console.error("need at least three run reports — one run is a thermometer reading");
  process.exit(1);
}
const runs = paths.map((p) => {
  const d = JSON.parse(readFileSync(p, "utf8"));
  return (d.shots ?? d) as Shot[];
});
console.log(`${runs.length} runs, ${runs[0]!.length} shots each\n`);

const names = runs[0]!.map((s) => s.name);
const rows: string[] = [];
let anyMissing = false;

for (const name of names) {
  const across = runs.map((r) => r.find((s) => s.name === name));
  if (across.some((s) => !s)) {
    console.log(`  ${name}: MISSING from at least one run — skipped`);
    anyMissing = true;
    continue;
  }
  const shots = across as Shot[];
  const pick = (f: (s: Shot) => number | undefined) =>
    shots.map(f).filter((v): v is number => typeof v === "number");

  const fps = pick((s) => s.fps);
  const wall = pick((s) => s.wallClockFps);
  const p95 = pick((s) => s.frameIntervalMsP95);
  const hitch = pick((s) => s.hitchCount);
  const p999 = pick((s) => s.p999FrameMs);
  const draws = pick((s) => s.drawCalls);

  const minFps = Math.floor(Math.min(...fps) * 0.85);
  const minWall = Math.floor(Math.min(...wall) * 0.85);
  const maxP95 = Math.ceil(Math.max(...p95) * 1.2 * 10) / 10;
  const hitchCeil = Math.max(2 * Math.max(...hitch), 3);
  const p999Ceil = Math.min(50, Math.ceil(Math.max(...p999) * 1.5));

  // Cross-run spread is the evidence that the host was clean. Gate 0-a
  // recorded +/-0.5 fps; anything much wider means these are not three CLEAN
  // runs and the floors below are pinned on noise.
  const spread = Math.max(...wall) - Math.min(...wall);
  const drawSpread = draws.length ? Math.max(...draws) - Math.min(...draws) : 0;
  const flag = spread > 3 ? "  <-- WIDE SPREAD, review before pinning" : "";
  if (drawSpread !== 0) {
    console.log(`  ${name}: drawCalls vary across runs (${draws.join("/")}) — NOT host-independent`);
  }

  rows.push(
    `    // ${name}: wallClockFps ${wall.map((v) => v.toFixed(1)).join(" / ")}`
    + ` (spread ${spread.toFixed(2)}), p95 ${p95.map((v) => v.toFixed(1)).join(" / ")}`
    + `\n    ceilings: { maxFrameMs: 50, p999FrameMs: ${p999Ceil}, hitchCount: ${hitchCeil},`
    + ` minFps: ${minFps}, minWallClockFps: ${minWall}, maxFrameIntervalMsP95: ${maxP95} },`,
  );
  console.log(
    `  ${name.padEnd(30)} minWall ${minWall}  minFps ${minFps}`
    + `  p95<= ${maxP95}  hitch<= ${hitchCeil}  p999<= ${p999Ceil}${flag}`,
  );
}

console.log(`\n--- rows ---\n${rows.join("\n")}`);
if (anyMissing) console.log("\nWARNING: at least one shot was missing from a run.");
