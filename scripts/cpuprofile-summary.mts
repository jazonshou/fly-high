/**
 * Rank a V8 .cpuprofile (from throttle-probe.mts) by self time and by
 * inclusive time, per function and per source file.
 *
 * Self time says where the CPU actually burns; inclusive time says which
 * caller to cut. Both are reported as a share of the profiled wall time, so a
 * row reads directly as "this much of every throttled frame".
 *
 * Usage: tsx scripts/cpuprofile-summary.mts <file.cpuprofile> [topN]
 */
import { readFileSync } from "node:fs";

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

const [file, topArg] = process.argv.slice(2);
if (!file) throw new Error("usage: <file.cpuprofile> [topN]");
const top = Number(topArg ?? 40);
const profile = JSON.parse(readFileSync(file, "utf8")) as CpuProfile;

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

// Per-node self time from sample deltas (µs). Delta i belongs to sample i.
const selfUs = new Map<number, number>();
for (let i = 0; i < profile.samples.length; i += 1) {
  const id = profile.samples[i]!;
  const dt = profile.timeDeltas[i + 1] ?? 0;
  selfUs.set(id, (selfUs.get(id) ?? 0) + dt);
}
const totalUs = profile.endTime - profile.startTime;

function shortUrl(url: string): string {
  if (!url) return "(native)";
  const clean = url.replace(/\?.*$/, "");
  const nm = clean.match(/node_modules\/(?:\.vite[^/]*\/deps\/)?(.*)$/);
  if (nm) return `dep:${nm[1]}`;
  const src = clean.match(/\/(src\/.*)$/);
  if (src) return src[1]!;
  return clean.split("/").slice(-2).join("/");
}
function key(frame: CallFrame): string {
  return `${frame.functionName || "(anonymous)"} ${shortUrl(frame.url)}:${frame.lineNumber + 1}`;
}

const selfByFn = new Map<string, number>();
const selfByFile = new Map<string, number>();
const inclusiveByFn = new Map<string, number>();
for (const [id, us] of selfUs) {
  const node = byId.get(id)!;
  selfByFn.set(key(node.callFrame), (selfByFn.get(key(node.callFrame)) ?? 0) + us);
  const f = shortUrl(node.callFrame.url);
  selfByFile.set(f, (selfByFile.get(f) ?? 0) + us);
  // Inclusive: charge every distinct ancestor function once per sample chain.
  const seen = new Set<string>();
  let cursor: number | undefined = id;
  while (cursor !== undefined) {
    const k = key(byId.get(cursor)!.callFrame);
    if (!seen.has(k)) {
      seen.add(k);
      inclusiveByFn.set(k, (inclusiveByFn.get(k) ?? 0) + us);
    }
    cursor = parent.get(cursor);
  }
}

function table(title: string, map: Map<string, number>, n: number): void {
  console.log(`\n== ${title} (of ${(totalUs / 1e3).toFixed(0)} ms profiled) ==`);
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  for (const [name, us] of rows) {
    console.log(`${(100 * us / totalUs).toFixed(1).padStart(5)}%  ${(us / 1e3).toFixed(0).padStart(6)} ms  ${name}`);
  }
}
table("self time by function", selfByFn, top);
table("self time by file", selfByFile, Math.min(top, 30));
table("inclusive time by function", inclusiveByFn, top);
