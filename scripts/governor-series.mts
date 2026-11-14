/**
 * The governor's path through a throttle-probe run, one line per change,
 * from the report's 1 Hz `stateSeries` (throttle-probe.mts writes it in
 * every scenario).
 *
 * Built for PR B part 2b's D5 run (design §21.7): urgency, the spent count,
 * exhaustion, the even fallback's phase and divisor, the CPU and GPU levels
 * and the render scale, with the drawn fps and interval p95 beside them. A
 * line is printed when any of those but the spent count, fps or p95 changes,
 * so a run of identical samples reads as one line. Time is seconds from the
 * first sample.
 *
 * Usage: tsx scripts/governor-series.mts <report.json>
 */
import { readFileSync } from "node:fs";

interface Sample {
  t: number;
  cpuL?: number;
  gpuL?: number;
  scale?: number;
  urgent?: boolean | null;
  spent?: number | null;
  exhausted?: boolean | null;
  fallback?: { phase?: string } | null;
  cadence?: { divisor?: number } | null;
  fps?: number | null;
  intervalP95?: number | null;
}

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: <report.json>");
const report = JSON.parse(readFileSync(file, "utf8")) as { stateSeries?: Sample[] };
const series = report.stateSeries ?? [];
if (series.length === 0) throw new Error(`${file} has no stateSeries`);

const fixed = (value: number | null | undefined, digits: number): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a";

const t0 = series[0]!.t;
let previous = "";
for (const sample of series) {
  const phase = sample.fallback?.phase ?? "off";
  const divisor = sample.cadence?.divisor;
  const key = [sample.urgent, sample.exhausted, phase, divisor, sample.cpuL, sample.gpuL, fixed(sample.scale, 3)].join();
  if (key === previous) continue;
  previous = key;
  console.log([
    `${fixed((sample.t - t0) / 1_000, 0).padStart(4)} s`,
    `urgent=${sample.urgent ?? "n/a"}`,
    `spent=${sample.spent ?? "n/a"}`,
    `exhausted=${sample.exhausted ?? "n/a"}`,
    `phase=${phase}`,
    `divisor=${divisor ?? "n/a"}`,
    `cpuL=${sample.cpuL ?? "n/a"}`,
    `gpuL=${sample.gpuL ?? "n/a"}`,
    `scale=${fixed(sample.scale, 2)}`,
    `fps=${fixed(sample.fps, 1)}`,
    `p95=${fixed(sample.intervalP95, 1)} ms`,
  ].join("  "));
}
