/**
 * `7-9` / Gate 7A deviation 4: price the moonlight-shadow trade, MEASURED.
 *
 * The plan quotes a second cascade set as 12.5 MiB at tier 1 and 64 MiB at
 * tier 3, "against 2.7 MiB of headroom", and says the answer is very likely
 * still no but must be a *measured* no.
 *
 * **The trap this script exists to avoid, which it fell into first.** The
 * obvious call is `estimateGpuMemoryMiB` against `MEMORY_CEILING_MIB`. That
 * reports 112.5 MiB of tier-1 headroom and says a second cascade set FITS at
 * every tier. It is the wrong instrument, and `perf-capture.mts:193` says so
 * outright: *"Never quote `estimatedGpuMemoryMiB` as headroom. It understates
 * by ~30%."* The estimate is nonetheless the number that GATES, so a trade can
 * pass the automated check and blow the real budget. Both are printed below,
 * because the GAP between them is the answer.
 */
import {
  MEMORY_CEILING_MIB,
  estimateGpuMemoryMiB,
  estimateGpuMemoryBreakdown,
} from "../src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";
import { PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB } from "./perf-capture.mts";

const TIERS: ReadonlyArray<{ tier: 0 | 1 | 2 | 3; q: QualityLevel; m: RenderingMode }> = [
  { tier: 0, q: "low", m: "balanced" },
  { tier: 1, q: "medium", m: "balanced" },
  { tier: 2, q: "high", m: "balanced" },
  { tier: 3, q: "high", m: "ultra" },
];
const VIEWPORT = { cssWidth: 1_280, cssHeight: 720, devicePixelRatio: 1 };

/** Max `inventoriedGpuMemoryMiB` across the three 2026-09-01 promotion runs. */
const MEASURED_INVENTORY_MIB = 492.4;

/** A second cascade set is a full duplicate of the existing one. */
function duplicateCascadeMiB(q: QualityLevel, m: RenderingMode): number {
  const p = resolveWebGpuQualityProfile(q, m);
  // 4 bytes/texel is not assumed: `PerformanceBudget.ts:211`'s
  // SHADOW_DEPTH_BYTES traces Babylon's default to TEXTUREFORMAT_DEPTH32_FLOAT
  // -> WebGPU `depth32float`. The stencil branch is never selected here.
  return (p.shadowMapSize * p.shadowMapSize * p.shadowCascades * 4) / (1024 * 1024);
}

console.log("ESTIMATE — the gating number, and the WRONG instrument for headroom:");
console.log("tier  map  casc   est MiB   ceiling   apparent headroom   2nd set   'fits?'");
for (const { tier, q, m } of TIERS) {
  const p = resolveWebGpuQualityProfile(q, m);
  const used = estimateGpuMemoryMiB(p, VIEWPORT);
  const ceiling = MEMORY_CEILING_MIB[tier];
  const dup = duplicateCascadeMiB(q, m);
  console.log(
    `  ${tier}  ${String(p.shadowMapSize).padStart(4)}  ${String(p.shadowCascades).padStart(2)}`
    + `  ${used.toFixed(1).padStart(8)}  ${String(ceiling).padStart(7)}`
    + `  ${(ceiling - used).toFixed(1).padStart(17)}  ${dup.toFixed(1).padStart(7)}`
    + `  ${dup <= ceiling - used ? "yes" : "no"}`,
  );
}

const dup1 = duplicateCascadeMiB("medium", "balanced");
const headroom = PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB - MEASURED_INVENTORY_MIB;
console.log("\nINVENTORY — the instrument that binds (tier 1, the only tier it is pinned for):");
console.log(`  pinned inventory ceiling   ${PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB.toFixed(1)} MiB`);
console.log(`  measured inventory (max)   ${MEASURED_INVENTORY_MIB.toFixed(1)} MiB`);
console.log(`  real headroom              ${headroom.toFixed(1)} MiB`);
console.log(`  second cascade set costs   ${dup1.toFixed(1)} MiB`);
console.log(
  `\n  VERDICT: ${dup1 <= headroom ? "FITS" : "DOES NOT FIT"} — short by `
  + `${(dup1 - headroom).toFixed(1)} MiB, ${(dup1 / headroom).toFixed(1)}x the entire `
  + "remaining headroom.",
);
console.log(
  "\n  Tiers 0/2/3 have NO inventory measurement — the pin is tier-1 only (the\n"
  + "  sweep passes Infinity), so no honest headroom figure exists for them and\n"
  + "  the estimate column above must not be quoted as one.",
);

console.log("\nESTIMATE components at tier 1, largest first:");
const b = estimateGpuMemoryBreakdown(
  resolveWebGpuQualityProfile("medium", "balanced"), VIEWPORT,
) as unknown as Record<string, number>;
for (const [k, v] of Object.entries(b)
  .filter(([k2, v2]) => typeof v2 === "number" && k2 !== "renderPixels" && k2 !== "totalMiB")
  .sort((x, y) => (y[1] as number) - (x[1] as number))
  .slice(0, 8)) {
  console.log(`  ${k.padEnd(26)} ${(v as number).toFixed(2)} MiB`);
}
