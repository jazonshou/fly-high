import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QualityLevel, RequestedRenderingMode } from "../src/game/types";
import { resolveGovernedWork } from "../src/render/governedWork";
import {
  CPU_WORK_MAX_LEVEL,
  GPU_WORK_MAX_LEVEL,
  cpuWorkLeverName,
  gpuWorkLeverName,
  workLeverSettingsFor,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveCloudShadowSchedule } from "../src/render/webgpu/clouds/runtimePolicy";
import {
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import { resolveDetailGenerationBudget } from "../src/render/webgpu/detail/generationBudget";
import { readSource } from "./support/sourceText";

/**
 * PR B (G3): every rung on both ladders sheds real work on every tier.
 *
 * The ladders used to hold absolute caps, and a cap at or above the tier's
 * own value moved a number and cut nothing: 48 animals against tier 0's 16,
 * 1,800 m of shadow casters against tier 1's 1,400 m of shadow, a cloud
 * shadow every 3 frames against a schedule that was already 3 or 4. Each
 * such rung cost the governor two windows and the pilot nothing back.
 *
 * The check is on the quantity each subsystem ends up using, computed the
 * way its consumer combines the lever with the profile (the source pins
 * below hold those formulas still). Two levers are checked by value only:
 * the page-request budget and the compute scale. The pump's own queue may
 * admit fewer pages than 8, and a 1.9 ms page bake rides the compute
 * budget's floor of one (R5 §2.5), so their effect is not provable here.
 *
 * The INSTRUMENT runs the same detector over bench-b1's absolute ladder,
 * kept below as a fixture, and must find exactly the no-ops design §4.3
 * lists: a detector that finds nothing proves nothing.
 */

/** What the subsystems use, for one pair of ladder levels. */
interface Effective {
  readonly requests: number;
  readonly compute: number;
  /** The worker path admits this many detail requests per update (∞ uncapped). */
  readonly workerCells: number;
  /** The inline path's slice is the smaller of the profile's and the cap. */
  readonly inlineCells: number;
  readonly inlineMs: number;
  readonly animals: number;
  /** Frames between cloud-shadow updates: higher sheds. */
  readonly cloudInterval: number;
  readonly casters: number;
  readonly vegetation: number;
  readonly gate: number;
}

type DetailPath = "worker" | "inline";

/** Whether the rung that moved `lever` cut its quantity, from `before` to `after`. */
function shed(lever: string, before: Effective, after: Effective, path: DetailPath): boolean {
  switch (lever) {
    case "terrain-page-requests": return after.requests < before.requests;
    case "compute-budget": return after.compute < before.compute;
    case "detail-cell-budget":
      return path === "worker"
        ? after.workerCells < before.workerCells
        : after.inlineCells < before.inlineCells || after.inlineMs < before.inlineMs;
    case "animal-budget": return after.animals < before.animals;
    case "cloud-shadow-cadence": return after.cloudInterval > before.cloudInterval;
    case "shadow-caster-distance": return after.casters < before.casters;
    case "vegetation-distance": return after.vegetation < before.vegetation;
    case "ground-cover-gate": return after.gate < before.gate;
    default: throw new Error(`no effect is known for lever ${lever}`);
  }
}

/** The rungs, by level, whose lever cut nothing on one tier. */
function noOps(
  at: (cpuLevel: number, gpuLevel: number) => Effective,
  path: DetailPath,
): { readonly cpu: number[]; readonly gpu: number[] } {
  const cpu: number[] = [];
  const gpu: number[] = [];
  for (let level = 1; level <= CPU_WORK_MAX_LEVEL; level += 1) {
    if (!shed(cpuWorkLeverName(level)!, at(level - 1, 0), at(level, 0), path)) cpu.push(level);
  }
  for (let level = 1; level <= GPU_WORK_MAX_LEVEL; level += 1) {
    if (!shed(gpuWorkLeverName(level)!, at(0, level - 1), at(0, level), path)) gpu.push(level);
  }
  return { cpu, gpu };
}

/** The shipped ladders, through `resolveGovernedWork` and each consumer's formula. */
function shipped(profile: WebGpuQualityProfile) {
  const base = resolveDetailGenerationBudget(profile);
  const schedule = resolveCloudShadowSchedule(profile).updateEveryNFrames;
  return (cpuLevel: number, gpuLevel: number): Effective => {
    const work = resolveGovernedWork(profile, workLeverSettingsFor(cpuLevel, gpuLevel));
    const cap = work.detailGenerationCap;
    return {
      requests: work.terrainPageRequestsPerUpdate,
      compute: work.computeBudgetScale,
      workerCells: cap?.maximumCells ?? Number.POSITIVE_INFINITY,
      inlineCells: cap === null ? base.maximumCells : Math.min(base.maximumCells, cap.maximumCells),
      inlineMs: cap === null ? base.maximumMilliseconds : Math.min(base.maximumMilliseconds, cap.maximumMilliseconds),
      animals: work.activeAnimalBudget,
      cloudInterval: Math.max(schedule, work.cloudShadowIntervalFloor ?? 1),
      casters: Math.min(profile.shadowDistance, work.shadowCasterDistanceMeters),
      vegetation: work.vegetationDistance,
      gate: work.groundCoverGateScale,
    };
  };
}

/** bench-b1's absolute ladder, frozen here as the instrument's fixture. */
const ABSOLUTE_CPU = [
  { requests: 8 }, { requests: 4 }, { requests: 2 },
  { detailMs: 1.25, detailCells: 16 }, { detailMs: 0.75, detailCells: 8 },
  { animalCap: 48 }, { animalCap: 16 },
] as const;
const ABSOLUTE_GPU = [
  { compute: 0.6 }, { compute: 0.35 },
  { cloudFloor: 3 }, { cloudFloor: 4 },
  { casterMeters: 1_800 }, { casterMeters: 1_200 },
  { vegetationScale: 0.75 },
  { gate: 0.6 }, { gate: 0.3 },
] as const;

interface AbsoluteLevers {
  requests: number;
  detailMs: number;
  detailCells: number;
  animalCap: number;
  compute: number;
  cloudFloor: number | null;
  casterMeters: number;
  vegetationScale: number;
  gate: number;
}

function absolute(profile: WebGpuQualityProfile) {
  const base = resolveDetailGenerationBudget(profile);
  const schedule = resolveCloudShadowSchedule(profile).updateEveryNFrames;
  return (cpuLevel: number, gpuLevel: number): Effective => {
    const levers: AbsoluteLevers = {
      requests: Number.POSITIVE_INFINITY,
      detailMs: 2,
      detailCells: 24,
      animalCap: Number.POSITIVE_INFINITY,
      compute: 1,
      cloudFloor: null,
      casterMeters: Number.POSITIVE_INFINITY,
      vegetationScale: 1,
      gate: 1,
    };
    for (const step of ABSOLUTE_CPU.slice(0, cpuLevel)) Object.assign(levers, step);
    for (const step of ABSOLUTE_GPU.slice(0, gpuLevel)) Object.assign(levers, step);
    // bench-b1's FlightRenderer.applyWorkLevels: no cap at the full notch.
    const capped = !(levers.detailMs >= 2 && levers.detailCells >= 24);
    return {
      requests: levers.requests,
      compute: levers.compute,
      workerCells: capped ? levers.detailCells : Number.POSITIVE_INFINITY,
      inlineCells: capped ? Math.min(base.maximumCells, levers.detailCells) : base.maximumCells,
      inlineMs: capped ? Math.min(base.maximumMilliseconds, levers.detailMs) : base.maximumMilliseconds,
      animals: Math.min(profile.activeAnimalBudget, levers.animalCap),
      cloudInterval: Math.max(schedule, levers.cloudFloor ?? 1),
      casters: Math.min(profile.shadowDistance, levers.casterMeters),
      vegetation: profile.vegetationDistance * levers.vegetationScale,
      gate: levers.gate,
    };
  };
}

const TIERS: readonly [string, WebGpuQualityProfile][] = [
  ["T0", resolveWebGpuQualityProfile("low", "balanced")],
  ["T1", resolveWebGpuQualityProfile("medium", "balanced")],
  ["T2", resolveWebGpuQualityProfile("high", "balanced")],
  ["T3", resolveWebGpuQualityProfile("high", "ultra")],
];

const PAIRS: readonly [QualityLevel, RequestedRenderingMode][] = (["low", "medium", "high"] as const)
  .flatMap((quality) => (["performance", "balanced", "ultra"] as const).map(
    (mode) => [quality, mode] as [QualityLevel, RequestedRenderingMode],
  ));

describe("every governor rung sheds work on every tier", () => {
  it("INSTRUMENT — bench-b1's absolute ladder reports exactly its known no-ops", () => {
    const expected: Record<string, Record<DetailPath, { cpu: number[]; gpu: number[] }>> = {
      // GPU: cloud floors 3 and 4 against a 4-frame schedule, casters 1,800
      // and 1,200 m against 900 m of shadow. CPU: animals 48 and 16 against
      // 16, and inline, a detail slice that was already 8 cells / 0.75 ms.
      T0: { worker: { cpu: [6, 7], gpu: [3, 4, 5, 6] }, inline: { cpu: [4, 5, 6, 7], gpu: [3, 4, 5, 6] } },
      T1: { worker: { cpu: [6], gpu: [3, 5] }, inline: { cpu: [4, 6], gpu: [3, 5] } },
      // 1,800 m of casters against exactly 1,800 m of shadow.
      T2: { worker: { cpu: [], gpu: [5] }, inline: { cpu: [], gpu: [5] } },
      T3: { worker: { cpu: [], gpu: [] }, inline: { cpu: [], gpu: [] } },
    };
    for (const [tier, profile] of TIERS) {
      for (const path of ["worker", "inline"] as const) {
        expect(noOps(absolute(profile), path), `${tier}, ${path} detail`).toEqual(expected[tier]![path]);
      }
    }
  });

  it("THE GUARD — the shipped ladders have no no-op rung on any tier", () => {
    for (const [tier, profile] of TIERS) {
      for (const path of ["worker", "inline"] as const) {
        expect(noOps(shipped(profile), path), `${tier}, ${path} detail`).toEqual({ cpu: [], gpu: [] });
      }
    }
  });

  it("THE GUARD — nor for any quality and mode", () => {
    for (const [quality, mode] of PAIRS) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      for (const path of ["worker", "inline"] as const) {
        expect(noOps(shipped(profile), path), `${quality} ${mode}, ${path} detail`).toEqual({ cpu: [], gpu: [] });
      }
    }
  });

  it("resolves the tier 1 rungs to the values design §4.3 lists", () => {
    const at = shipped(resolveWebGpuQualityProfile("medium", "balanced"));
    expect([4, 5].map((level) => [at(level, 0).workerCells, at(level, 0).inlineMs]))
      .toEqual([[11, 1.25 * 0.66], [5, 1.25 * 0.33]]);
    expect([6, 7].map((level) => at(level, 0).animals)).toEqual([24, 12]);
    expect([3, 4].map((level) => at(0, level).cloudInterval)).toEqual([4, 5]);
    expect(at(0, 5).casters).toBeCloseTo(980, 9);
    expect(at(0, 6).casters).toBe(700);
    expect(at(0, 7).vegetation).toBe(2_250);
  });
});

describe("the consumers combine levers with the profile as this test assumes", () => {
  const source = (...path: string[]) => readSource(join(import.meta.dirname, "..", "src", ...path));

  it("pins each consumer's formula", () => {
    expect(source("render", "webgpu", "clouds", "VolumetricCloudSystem.ts"))
      .toContain("Math.max(this.shadowSchedule.updateEveryNFrames, this.shadowIntervalFloor ?? 1)");
    expect(source("render", "webgpu", "terrain", "TerrainClipmapSystem.ts"))
      .toContain("Math.min(this.profile.shadowDistance, maxDistanceMeters)");
    const detail = source("render", "webgpu", "detail", "WorldDetailRuntime.ts");
    expect(detail).toContain("this.generationBudgetCap?.maximumCells ?? Number.POSITIVE_INFINITY");
    expect(detail).toContain("maximumCells: Math.min(resolvedBudget.maximumCells, cap.maximumCells)");
    expect(detail).toContain(
      "maximumMilliseconds: Math.min(resolvedBudget.maximumMilliseconds, cap.maximumMilliseconds)",
    );
  });

  it("hands the subsystems the governed values", () => {
    const renderer = source("render", "FlightRenderer.ts");
    expect(renderer).toContain("const work = resolveGovernedWork(this.profile, settings);");
    expect(renderer).toContain("this.detail.setGenerationBudgetCap(work.detailGenerationCap);");
    expect(renderer).toContain("this.clouds.setShadowIntervalFloor(work.cloudShadowIntervalFloor);");
    expect(renderer).toContain("gateScale: this.governedWork.groundCoverGateScale,");
    expect(renderer).toContain(
      "this.terrain.addShadowCasters(collect, this.governedWork.shadowCasterDistanceMeters);",
    );
    expect(renderer).toContain("activeAnimalBudget: work.activeAnimalBudget,");
    expect(renderer).toContain("vegetationDistance: work.vegetationDistance,");
  });
});
