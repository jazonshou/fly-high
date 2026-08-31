#!/usr/bin/env node
/**
 * `6-11.1` — read a tier sweep, but only after deciding whether it is readable.
 *
 * The sweep compares tiers against each other while being, itself, a multi-hour
 * GPU workload on a host known to swing 3x with heat. That makes thermal drift
 * CORRELATED with the independent variable rather than merely noisy, and
 * correlated drift does not average out — a monotonic ramp would read as
 * "higher tiers cost more", which is precisely the finding the sweep exists to
 * produce.
 *
 * So this refuses to print a tier table until the control readings say the run
 * was sound. `tier-sweep.sh` runs one fixed configuration (canonical tier 1)
 * first, middle and last; if those three disagree materially, the tier rows are
 * not comparable to each other and the honest output is "void, re-run", not a
 * table with a caveat nobody will carry forward.
 *
 * Usage: node scripts/tier-sweep-analyse.mjs <sweep-dir>
 */
import { readFileSync, readdirSync } from "node:fs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/tier-sweep-analyse.mjs <sweep-dir>");
  process.exit(2);
}

/**
 * How far the three control readings may spread before the run is void.
 *
 * 5% is not a comfort threshold, it is roughly the smallest tier-to-tier
 * difference the sweep is trying to resolve. If the control moves as much as
 * the effect, the effect is unmeasurable — there is no arithmetic that
 * recovers it, which is why this voids rather than annotates.
 */
const CONTROL_SPREAD_LIMIT = 0.05;

const reports = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const report = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    return { file: f, report };
  })
  .filter((r) => r.report.shots?.length)
  .sort((a, b) => (a.report.sweep?.order ?? 0) - (b.report.sweep?.order ?? 0));

if (reports.length === 0) {
  console.error(`no usable reports in ${dir}`);
  process.exit(2);
}

const meanFps = (report) =>
  report.shots.reduce((sum, s) => sum + s.wallClockFps, 0) / report.shots.length;

const controls = reports.filter((r) => (r.report.sweep?.label ?? "").startsWith("control-"));

console.log("=== thermal control ===");
if (controls.length < 2) {
  console.log(`Only ${controls.length} control reading(s). The run carries no thermal witness,`);
  console.log("so its tier rows cannot be shown to be comparable. Treat as VOID.");
  process.exit(1);
}
for (const c of controls) {
  console.log(
    `  ${c.report.sweep.label.padEnd(10)} order=${String(c.report.sweep.order).padStart(2)} `
    + `mean ${meanFps(c.report).toFixed(1)} fps  (${c.report.sweep.startedAt})`,
  );
}
const controlValues = controls.map((c) => meanFps(c.report));
const controlMin = Math.min(...controlValues);
const controlMax = Math.max(...controlValues);
const spread = (controlMax - controlMin) / controlMax;
console.log(`  spread: ${(spread * 100).toFixed(1)}%  (limit ${(CONTROL_SPREAD_LIMIT * 100).toFixed(0)}%)`);

if (spread > CONTROL_SPREAD_LIMIT) {
  console.log("");
  console.log("SWEEP VOID — the control drifted by more than the effect being measured.");
  console.log("The tier rows below would be a thermal ramp wearing a tier label, so they are");
  console.log("not printed. Re-run on a colder host, with longer cool-downs, or in chunks.");
  console.log("This is the sweep-scale form of §1.2's A->B->A rule: a control that moves as");
  console.log("much as the signal means there is no signal to read.");
  process.exit(1);
}

console.log("  controls agree — tier rows are comparable.\n");
console.log("=== tier rows ===");
console.log(
  "config".padEnd(18) + "tier".padEnd(6) + "viewport".padEnd(12)
  + "meanFps".padEnd(10) + "minFps".padEnd(9) + "p95".padEnd(8)
  + "renderPx".padEnd(11) + "capBound",
);
for (const { report } of reports) {
  const label = report.sweep?.label ?? "?";
  if (label.startsWith("control-")) continue;
  const shots = report.shots;
  const mean = meanFps(report);
  const min = Math.min(...shots.map((s) => s.wallClockFps));
  const p95 = Math.max(...shots.map((s) => s.frameIntervalMsP95));
  const px = Math.max(...shots.map((s) => s.renderPixels));
  const vp = `${shots[0].viewportWidth}x${shots[0].viewportHeight}`;
  const requested = shots[0].viewportWidth * shots[0].viewportHeight
    * shots[0].renderScale ** 2;
  // The cap is why two viewport columns can be the same workload; a table that
  // does not say so reports resolution scaling that never happened.
  const capBound = px < requested * 0.995 ? "YES" : "no";
  console.log(
    label.padEnd(18) + String(report.captureEnvironment?.tier ?? "?").padEnd(6)
    + vp.padEnd(12) + mean.toFixed(1).padEnd(10) + min.toFixed(1).padEnd(9)
    + p95.toFixed(1).padEnd(8) + String(px).padEnd(11) + capBound,
  );
}
console.log("");
console.log("`capBound: YES` means the tier's maxRenderPixels cap bound this row, so it is");
console.log("NOT measuring the viewport it names — two such rows at one tier are the same");
console.log("workload with different presentation.");
