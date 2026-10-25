/**
 * What the LONG frames in a V8 CPU profile spent their time on.
 *
 * `cpuprofile-summary.mts` ranks a whole profile, where a frame that takes
 * ten times the median weighs no more than ten ordinary ones. A hitch is
 * that one frame, so this finds the frames first: runs of consecutive samples
 * whose stack passes through `marker` (the flight agent's `renderFrame`, by
 * default), each run one frame. Runs longer than `--min-ms` are the spikes,
 * and they alone are ranked, by self time and by inclusive time.
 *
 * Read a profile from an unminified build (`perf-flight.mts --profile
 * --no-minify`), or the function names are the minifier's.
 *
 * Usage: node scripts/cpuprofile-spikes.mts <file.cpuprofile> [--min-ms 50] [--top 25] [--marker renderFrame]
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
interface CpuProfile { nodes: ProfileNode[]; startTime: number; samples: number[]; timeDeltas: number[] }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "min-ms": { type: "string", default: "50" },
    top: { type: "string", default: "25" },
    marker: { type: "string", default: "renderFrame" },
  },
});
const file = positionals[0];
if (!file) throw new Error("usage: <file.cpuprofile> [--min-ms 50] [--top 25] [--marker renderFrame]");
const minMs = Number(values["min-ms"]);
const top = Number(values.top);
const profile = JSON.parse(readFileSync(file, "utf8")) as CpuProfile;

const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

function key(frame: CallFrame): string {
  const url = frame.url.replace(/\?.*$/, "").split("/").slice(-1)[0] || "(native)";
  return `${frame.functionName || "(anonymous)"} ${url}:${frame.lineNumber + 1}`;
}

/** Stack of keys, leaf first. */
const stacks = new Map<number, string[]>();
function stackOf(id: number): string[] {
  const cached = stacks.get(id);
  if (cached) return cached;
  const keys: string[] = [];
  let cursor: number | undefined = id;
  while (cursor !== undefined) {
    keys.push(key(byId.get(cursor)!.callFrame));
    cursor = parent.get(cursor);
  }
  stacks.set(id, keys);
  return keys;
}
const inFrame = (id: number) => stackOf(id).some((entry) => entry.startsWith(`${values.marker} `));

// Sample i lasts timeDeltas[i + 1] microseconds.
interface Run { startUs: number; durationUs: number; samples: number[] }
const runs: Run[] = [];
let clock = profile.startTime;
let current: Run | null = null;
for (let index = 0; index < profile.samples.length; index += 1) {
  clock += profile.timeDeltas[index] ?? 0;
  const id = profile.samples[index]!;
  const duration = profile.timeDeltas[index + 1] ?? 0;
  if (inFrame(id)) {
    current ??= { startUs: clock, durationUs: 0, samples: [] };
    current.durationUs += duration;
    current.samples.push(index);
  } else if (current) {
    runs.push(current);
    current = null;
  }
}
if (current) runs.push(current);

const durations = runs.map((run) => run.durationUs / 1000).sort((a, b) => a - b);
const median = durations[Math.floor(durations.length / 2)] ?? 0;
const spikes = runs.filter((run) => run.durationUs / 1000 >= minMs);
console.log(`${runs.length} frames, median ${median.toFixed(1)} ms; ${spikes.length} at or over ${minMs} ms, `
  + `totalling ${(spikes.reduce((sum, run) => sum + run.durationUs, 0) / 1000).toFixed(0)} ms`);

const self = new Map<string, number>();
const inclusive = new Map<string, number>();
for (const run of spikes) {
  for (const index of run.samples) {
    const stack = stackOf(profile.samples[index]!);
    const duration = profile.timeDeltas[index + 1] ?? 0;
    self.set(stack[0]!, (self.get(stack[0]!) ?? 0) + duration);
    for (const entry of new Set(stack)) inclusive.set(entry, (inclusive.get(entry) ?? 0) + duration);
  }
}
const spikeUs = spikes.reduce((sum, run) => sum + run.durationUs, 0);
function table(title: string, map: Map<string, number>): void {
  console.log(`\n== ${title} ==`);
  for (const [name, us] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${(100 * us / Math.max(1, spikeUs)).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)} ms  ${name}`);
  }
}
table("self time in the spike frames", self);
table("inclusive time in the spike frames", inclusive);

// Each spike's own heaviest callee chain below the marker, two levels deep.
console.log("\n== each spike's largest children of the marker ==");
for (const run of spikes.slice(0, 40)) {
  const children = new Map<string, number>();
  for (const index of run.samples) {
    const stack = stackOf(profile.samples[index]!);
    const at = stack.findIndex((entry) => entry.startsWith(`${values.marker} `));
    const path = stack.slice(Math.max(0, at - 4), at).reverse().join(" > ") || "(marker itself)";
    children.set(path, (children.get(path) ?? 0) + (profile.timeDeltas[index + 1] ?? 0));
  }
  const best = [...children.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([path, us]) => `${(us / 1000).toFixed(0)} ms ${path}`);
  console.log(`${(run.durationUs / 1000).toFixed(0).padStart(5)} ms: ${best.join(" | ")}`);
}
