/**
 * Rank a V8 sampling heap profile (from `perf-flight.mts --heap-profile`) by
 * the bytes allocated at each site, and by each function's inclusive bytes.
 *
 * The profile is taken with collected objects included, so it counts garbage
 * as well as what survives: the per-frame allocation that feeds the
 * collector. Pass `--frames <n>` to read each row per frame.
 *
 * Usage: node scripts/heapprofile-summary.mts <file.heapprofile> [topN] [--frames n]
 */
import { readFileSync } from "node:fs";

interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }
interface HeapNode { callFrame: CallFrame; selfSize: number; children: HeapNode[] }

const args = process.argv.slice(2);
const framesAt = args.indexOf("--frames");
const frames = framesAt >= 0 ? Number(args[framesAt + 1]) : 0;
const positional = args.filter((_, index) => framesAt < 0 || (index !== framesAt && index !== framesAt + 1));
const [file, topArg] = positional;
if (!file) throw new Error("usage: <file.heapprofile> [topN] [--frames n]");
const top = Number(topArg ?? 30);
const profile = JSON.parse(readFileSync(file, "utf8")) as { head: HeapNode };

function where(frame: CallFrame): string {
  const url = frame.url.replace(/\?.*$/, "").split("/").slice(-1)[0] || "(native)";
  return `${frame.functionName || "(anonymous)"} ${url}:${frame.lineNumber + 1}`;
}

const self = new Map<string, number>();
const inclusive = new Map<string, number>();
let total = 0;
function walk(node: HeapNode, ancestors: readonly string[]): number {
  const key = where(node.callFrame);
  let sum = node.selfSize;
  self.set(key, (self.get(key) ?? 0) + node.selfSize);
  total += node.selfSize;
  const chain = ancestors.includes(key) ? ancestors : [...ancestors, key];
  for (const child of node.children) sum += walk(child, chain);
  if (!ancestors.includes(key)) inclusive.set(key, (inclusive.get(key) ?? 0) + sum);
  return sum;
}
walk(profile.head, []);

const unit = frames > 0 ? "KiB/frame" : "KiB";
const scale = (bytes: number) => (frames > 0 ? bytes / frames : bytes) / 1024;
function table(title: string, map: Map<string, number>): void {
  console.log(`\n== ${title} (total ${scale(total).toFixed(1)} ${unit}) ==`);
  for (const [name, bytes] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${(100 * bytes / total).toFixed(1).padStart(5)}%  ${scale(bytes).toFixed(1).padStart(9)} ${unit}  ${name}`);
  }
}
table("allocated at (self)", self);
table("allocated under (inclusive)", inclusive);
