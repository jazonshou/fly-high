/**
 * Which shots did MY change move, and by how much?
 *
 * The only exact answer to that question is arm-to-arm: the same shot list
 * captured on the base commit and on the branch, compared to each other. It is
 * not "SSIM against the committed baseline" — the baselines drift for reasons
 * that have nothing to do with the change under test, and a FILTERED shot list
 * changes the streaming history each shot arrives with, which has been measured
 * moving a frame by 26/255 on the base arm with no code change at all.
 *
 * So this compares two artifact directories captured at an IDENTICAL list and
 * says, per shot, whether the pixels differ and where. The renderer is
 * deterministic, so an untouched shot is expected to be bit-identical; anything
 * that is not is a real consequence of the change and needs looking at.
 *
 *   # one arm per worktree, same list, report.json deleted before each
 *   npm run perf:capture           # in the base worktree
 *   cp -r tests/perf/artifacts /tmp/arm-base
 *   npm run perf:capture           # in the branch worktree
 *   npx tsx scripts/perf-arm-compare.mts /tmp/arm-base tests/perf/artifacts
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "./frame-forensics.mts";

const baseDir = process.argv[2];
const branchDir = process.argv[3];
if (!baseDir || !branchDir) {
  console.error("usage: perf-arm-compare.mts <baseArtifactDir> <branchArtifactDir>");
  process.exit(2);
}

/** Shot frames only: the temporal-* series and report.json are not shots. */
function shots(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".png") && !name.startsWith("temporal-"))
    .sort();
}

interface Difference {
  readonly name: string;
  readonly changed: number;
  readonly total: number;
  readonly maxDelta: number;
  readonly meanDelta: number;
  readonly box: readonly [number, number, number, number] | null;
}

function compare(name: string): Difference | string {
  const basePath = join(baseDir!, name);
  const branchPath = join(branchDir!, name);
  if (!existsSync(basePath)) return `${name}: missing from the base arm`;
  if (!existsSync(branchPath)) return `${name}: missing from the branch arm`;
  const a = decodePng(basePath);
  const b = decodePng(branchPath);
  if (a.width !== b.width || a.height !== b.height) {
    return `${name}: dimensions differ (${a.width}x${a.height} vs ${b.width}x${b.height})`;
  }
  let changed = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const offset = (y * a.width + x) * 4;
      const delta = Math.max(
        Math.abs(a.data[offset]! - b.data[offset]!),
        Math.abs(a.data[offset + 1]! - b.data[offset + 1]!),
        Math.abs(a.data[offset + 2]! - b.data[offset + 2]!),
      );
      if (delta === 0) continue;
      changed += 1;
      sumDelta += delta;
      if (delta > maxDelta) maxDelta = delta;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return {
    name,
    changed,
    total: a.width * a.height,
    maxDelta,
    meanDelta: changed === 0 ? 0 : sumDelta / changed,
    box: changed === 0 ? null : [x0, y0, x1, y1],
  };
}

const names = shots(baseDir);
const moved: Difference[] = [];
const identical: string[] = [];
const problems: string[] = [];

for (const name of names) {
  const result = compare(name);
  if (typeof result === "string") problems.push(result);
  else if (result.changed === 0) identical.push(result.name);
  else moved.push(result);
}

console.log(`base   ${baseDir}`);
console.log(`branch ${branchDir}`);
console.log(`${names.length} shots compared\n`);
console.log(`BIT-IDENTICAL: ${identical.length}`);
for (const name of identical) console.log(`  ${name}`);

console.log(`\nMOVED: ${moved.length}`);
moved.sort((a, b) => b.changed - a.changed);
for (const shot of moved) {
  const percent = ((shot.changed / shot.total) * 100).toFixed(3);
  const [x0, y0, x1, y1] = shot.box!;
  console.log(
    `  ${shot.name.padEnd(30)} ${percent.padStart(8)}% of pixels  `
    + `max ${String(shot.maxDelta).padStart(3)}/255  mean ${shot.meanDelta.toFixed(1).padStart(5)}  `
    + `box x ${x0}..${x1} y ${y0}..${y1}`,
  );
}

if (problems.length > 0) {
  console.log(`\nPROBLEMS: ${problems.length}`);
  for (const problem of problems) console.log(`  ${problem}`);
}

// A shot list that differs between the arms invalidates the whole comparison,
// so say so loudly rather than quietly comparing the intersection.
const branchOnly = shots(branchDir).filter((name) => !names.includes(name));
if (branchOnly.length > 0) {
  console.log(`\nSHOT LISTS DIFFER — the branch arm has ${branchOnly.length} shot(s) the base arm does not:`);
  for (const name of branchOnly) console.log(`  ${name}`);
  console.log("This comparison is NOT valid. Re-run both arms at the same list.");
}
console.log("");
