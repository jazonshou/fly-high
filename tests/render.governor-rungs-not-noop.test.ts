import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QualityLevel, RequestedRenderingMode } from "../src/game/types";
import { resolveGovernedWork } from "../src/render/governedWork";
import { refreshIntervalAtCadence } from "../src/render/refreshHold";
import {
  CPU_WORK_MAX_LEVEL,
  GPU_WORK_MAX_LEVEL,
  cpuWorkLeverName,
  governorConfigForProfile,
  gpuWorkLeverName,
  workLeverSettingsFor,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveCloudShadowSchedule } from "../src/render/webgpu/clouds/runtimePolicy";
import type { PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import {
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import { resolveDetailGenerationBudget } from "../src/render/webgpu/detail/generationBudget";
import {
  resolveVolumetricCloudConfig,
  scaleCloudMarch,
  type VolumetricCloudConfig,
} from "../src/render/webgpu/nature/CloudConfig";
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
 *
 * PR B part 2 (G5) adds five levers, each judged on what its consumer ends
 * up with: the cloud view march's steps, the CSM and cloud-depth refresh
 * intervals at the tier's own rate and at the 30 fps setting (a rung must
 * add a presented frame at both), and the CDLOD node budget and split
 * threshold.
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
  /** The cloud view march's step count. */
  readonly viewSteps: number;
  /** Frames between CSM renders at the tier's own rate and at the 30 fps setting: higher sheds. */
  readonly shadowInterval: readonly number[];
  /** The same for cloud-scene-depth. */
  readonly cloudDepthInterval: readonly number[];
  readonly cdlodBudget: number;
  /** The CDLOD split threshold in pixels: higher sheds. */
  readonly cdlodThreshold: number;
}

type DetailPath = "worker" | "inline";

/** A refresh rung must add a presented frame at every cadence, not only at the tier's own. */
function everyLonger(after: readonly number[], before: readonly number[]): boolean {
  return after.every((frames, index) => frames > before[index]!);
}

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
    case "cloud-march": return after.viewSteps < before.viewSteps;
    case "shadow-refresh": return everyLonger(after.shadowInterval, before.shadowInterval);
    case "cloud-depth-refresh": return everyLonger(after.cloudDepthInterval, before.cloudDepthInterval);
    // A threshold that only ever coarsens; its own notch is pinned below.
    case "cdlod-node-budget":
      return after.cdlodBudget < before.cdlodBudget && after.cdlodThreshold >= before.cdlodThreshold;
    case "detail-and-animal-budget":
      return shed("detail-cell-budget", before, after, path) && shed("animal-budget", before, after, path);
    default: throw new Error(`no effect is known for lever ${lever}`);
  }
}

/** Each rung's lever, from level 1, for the two ladders a detector walks. */
interface Ladders {
  readonly cpu: readonly string[];
  readonly gpu: readonly string[];
}

const SHIPPED_LADDERS: Ladders = {
  cpu: Array.from({ length: CPU_WORK_MAX_LEVEL }, (_, index) => cpuWorkLeverName(index + 1)!),
  gpu: Array.from({ length: GPU_WORK_MAX_LEVEL }, (_, index) => gpuWorkLeverName(index + 1)!),
};

/** The rungs, by level, whose lever cut nothing on one tier. */
function noOps(
  at: (cpuLevel: number, gpuLevel: number) => Effective,
  path: DetailPath,
  ladders: Ladders = SHIPPED_LADDERS,
): { readonly cpu: number[]; readonly gpu: number[] } {
  const cpu: number[] = [];
  const gpu: number[] = [];
  ladders.cpu.forEach((lever, index) => {
    if (!shed(lever, at(index, 0), at(index + 1, 0), path)) cpu.push(index + 1);
  });
  ladders.gpu.forEach((lever, index) => {
    if (!shed(lever, at(0, index), at(0, index + 1), path)) gpu.push(index + 1);
  });
  return { cpu, gpu };
}

/** The view march as the cloud system resolves it from a profile (`VolumetricCloudSystem.resolveConfig`). */
function profileMarch(profile: WebGpuQualityProfile): VolumetricCloudConfig {
  return resolveVolumetricCloudConfig({
    maximumViewSteps: Math.max(8, Math.min(192, profile.cloudPrimarySteps)),
    lightSteps: Math.max(2, Math.min(16, profile.cloudLightSteps)),
  });
}

/** The 30 fps setting on a 60 Hz display: tiers 0-2 present every 33.3 ms. */
const THIRTY_FPS: PresentationCadence = { frameCapHz: 30, divisor: 2, displayPeriodMs: 1_000 / 60, periodConfirmed: true };

/** The shipped ladders, through `resolveGovernedWork` and each consumer's formula. */
function shipped(profile: WebGpuQualityProfile) {
  const base = resolveDetailGenerationBudget(profile);
  const schedule = resolveCloudShadowSchedule(profile).updateEveryNFrames;
  const march = profileMarch(profile);
  // FlightRenderer.syncRefreshHolds: the profile's rate at the cadence, then the governor's frames.
  const cadences = [governorConfigForProfile(profile), governorConfigForProfile(profile, THIRTY_FPS)];
  const interval = (frames: number, extraFrames: number) => cadences.map((config) =>
    refreshIntervalAtCadence(frames, config.tierPresentationTargetMs, config.presentationTargetMs) + extraFrames);
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
      viewSteps: scaleCloudMarch(march, work.cloudMarchScale).maximumViewSteps,
      shadowInterval: interval(work.shadowRefreshFrames, work.shadowRefreshExtraFrames),
      cloudDepthInterval: interval(work.cloudDepthRefreshFrames, work.cloudDepthRefreshExtraFrames),
      // The terrain's beauty buffers hold the profile's budget, so a lower one is never clamped.
      cdlodBudget: work.cdlodNodeBudget,
      cdlodThreshold: work.cdlodPixelThreshold,
    };
  };
}

/**
 * bench-b1's absolute ladder, frozen here as the instrument's fixture, each
 * rung with its lever: the shipped ladder's names no longer line up with it.
 */
const ABSOLUTE_CPU = [
  ["terrain-page-requests", { requests: 8 }],
  ["terrain-page-requests", { requests: 4 }],
  ["terrain-page-requests", { requests: 2 }],
  ["detail-cell-budget", { detailMs: 1.25, detailCells: 16 }],
  ["detail-cell-budget", { detailMs: 0.75, detailCells: 8 }],
  ["animal-budget", { animalCap: 48 }],
  ["animal-budget", { animalCap: 16 }],
] as const;
const ABSOLUTE_GPU = [
  ["compute-budget", { compute: 0.6 }],
  ["compute-budget", { compute: 0.35 }],
  ["cloud-shadow-cadence", { cloudFloor: 3 }],
  ["cloud-shadow-cadence", { cloudFloor: 4 }],
  ["shadow-caster-distance", { casterMeters: 1_800 }],
  ["shadow-caster-distance", { casterMeters: 1_200 }],
  ["vegetation-distance", { vegetationScale: 0.75 }],
  ["ground-cover-gate", { gate: 0.6 }],
  ["ground-cover-gate", { gate: 0.3 }],
] as const;
const ABSOLUTE_LADDERS: Ladders = {
  cpu: ABSOLUTE_CPU.map(([lever]) => lever),
  gpu: ABSOLUTE_GPU.map(([lever]) => lever),
};

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
  const steps = profileMarch(profile).maximumViewSteps;
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
    for (const [, step] of ABSOLUTE_CPU.slice(0, cpuLevel)) Object.assign(levers, step);
    for (const [, step] of ABSOLUTE_GPU.slice(0, gpuLevel)) Object.assign(levers, step);
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
      // bench-b1 had none of the G5 levers.
      viewSteps: steps,
      shadowInterval: [profile.shadowRefreshFrames],
      cloudDepthInterval: [profile.cloudDepthRefreshFrames],
      cdlodBudget: profile.cdlodNodeBudget,
      cdlodThreshold: profile.cdlodPixelThreshold,
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
        expect(noOps(absolute(profile), path, ABSOLUTE_LADDERS), `${tier}, ${path} detail`).toEqual(expected[tier]![path]);
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
    expect([4, 9].map((level) => [at(level, 0).workerCells, at(level, 0).inlineMs]))
      .toEqual([[11, 1.25 * 0.66], [5, 1.25 * 0.33]]);
    expect([6, 9].map((level) => at(level, 0).animals)).toEqual([24, 12]);
    expect([3, 7].map((level) => at(0, level).cloudInterval)).toEqual([4, 5]);
    expect(at(0, 5).casters).toBeCloseTo(980, 9);
    expect(at(0, 9).casters).toBe(700);
    expect(at(0, 6).vegetation).toBe(2_250);
  });

  it("cuts each quantity at the levels plan §4.2 puts its notches, on every tier", () => {
    // PR B part 2 (K1): every lever's first notch before any second. The CSM
    // rung is at CPU level 3 (Jason's verdict on the held shadow: accepted);
    // rejected, it would be 10 and the rungs after it one level earlier.
    const cuts: Record<string, (before: Effective, after: Effective) => boolean> = {
      requests: (before, after) => after.requests < before.requests,
      cloudDepth: (before, after) => everyLonger(after.cloudDepthInterval, before.cloudDepthInterval),
      shadow: (before, after) => everyLonger(after.shadowInterval, before.shadowInterval),
      detail: (before, after) => after.workerCells < before.workerCells,
      cdlodBudget: (before, after) => after.cdlodBudget < before.cdlodBudget,
      cdlodThreshold: (before, after) => after.cdlodThreshold > before.cdlodThreshold,
      animals: (before, after) => after.animals < before.animals,
      compute: (before, after) => after.compute < before.compute,
      cloudShadow: (before, after) => after.cloudInterval > before.cloudInterval,
      march: (before, after) => after.viewSteps < before.viewSteps,
      casters: (before, after) => after.casters < before.casters,
      vegetation: (before, after) => after.vegetation < before.vegetation,
      gate: (before, after) => after.gate < before.gate,
    };
    const none = Object.fromEntries(Object.keys(cuts).map((name) => [name, []]));
    for (const [tier, profile] of TIERS) {
      const at = shipped(profile);
      const levels = (max: number, pair: (level: number) => [number, number]) =>
        Object.fromEntries(Object.entries(cuts).map(([name, cut]) => [name, Array.from({ length: max }, (_, index) => index + 1)
          .filter((level) => cut(at(...pair(level - 1)), at(...pair(level))))]));
      expect(levels(CPU_WORK_MAX_LEVEL, (level) => [level, 0]), `${tier} CPU`).toEqual({
        ...none,
        requests: [1, 7, 10],
        cloudDepth: [2],
        shadow: [3],
        detail: [4, 9],
        cdlodBudget: [5, 8],
        cdlodThreshold: [8],
        animals: [6, 9],
      });
      expect(levels(GPU_WORK_MAX_LEVEL, (level) => [0, level]), `${tier} GPU`).toEqual({
        ...none,
        compute: [1, 2],
        cloudShadow: [3, 7],
        march: [4, 8],
        casters: [5, 9],
        vegetation: [6],
        gate: [10, 11],
      });
    }
  });

  it("resolves the G5 rungs to the values design §2.6 lists, on every tier", () => {
    // [view steps at GPU levels 0, 4 and 8], [CDLOD budget at CPU levels 0, 5 and 8], [threshold at 0 and 8].
    const expected: Record<string, { steps: number[]; budget: number[]; threshold: number[] }> = {
      T0: { steps: [40, 30, 24], budget: [224, 190, 156], threshold: [4, 16 / 3] },
      T1: { steps: [60, 45, 36], budget: [320, 272, 224], threshold: [3, 4] },
      T2: { steps: [96, 72, 58], budget: [448, 380, 313], threshold: [2, 8 / 3] },
      T3: { steps: [96, 72, 58], budget: [640, 544, 448], threshold: [1.5, 2] },
    };
    for (const [tier, profile] of TIERS) {
      const at = shipped(profile);
      const want = expected[tier]!;
      expect([0, 4, 8].map((level) => at(0, level).viewSteps), tier).toEqual(want.steps);
      expect([0, 5, 8].map((level) => at(level, 0).cdlodBudget), tier).toEqual(want.budget);
      expect(at(0, 0).cdlodThreshold, tier).toBe(want.threshold[0]);
      expect(at(8, 0).cdlodThreshold, tier).toBeCloseTo(want.threshold[1]!, 12);
      // Each march notch stretches both step lengths by the realized step ratio, so rays keep their reach.
      const march = profileMarch(profile);
      for (const [scale, steps] of [[0.75, want.steps[1]!], [0.6, want.steps[2]!]] as const) {
        const scaled = scaleCloudMarch(march, scale);
        expect(scaled.minimumStepMeters, `${tier} ×${scale}`).toBeCloseTo(70 * (want.steps[0]! / steps), 9);
        expect(scaled.maximumStepMeters, `${tier} ×${scale}`).toBeCloseTo(900 * (want.steps[0]! / steps), 9);
      }
      // [the tier's own rate, the 30 fps setting]. The profile's interval is a
      // rate, converted to the cadence; the rung adds a presented frame after.
      const own = profile.shadowRefreshFrames;
      expect(at(0, 0).shadowInterval, tier).toEqual([own, 1]);
      expect(at(3, 0).shadowInterval, tier).toEqual([own + 1, 2]);
      expect(at(0, 0).cloudDepthInterval, tier).toEqual([profile.cloudDepthRefreshFrames, 1]);
      expect(at(2, 0).cloudDepthInterval, tier).toEqual([profile.cloudDepthRefreshFrames + 1, 2]);
    }
    // The values above that must be exact in floating point are.
    expect(3 * (4 / 3)).toBe(4);
    expect(1.5 * (4 / 3)).toBe(2);
    expect(at08(640)).toBe(448);
    expect(Math.round(96 * 0.6)).toBe(58);
  });
});

/** The second CDLOD notch's budget, as `resolveGovernedWork` floors it. */
function at08(budget: number): number {
  return Math.floor(budget * 0.7);
}

describe("the consumers combine levers with the profile as this test assumes", () => {
  const source = (...path: string[]) => readSource(join(import.meta.dirname, "..", "src", ...path));

  it("pins each consumer's formula", () => {
    const clouds = source("render", "webgpu", "clouds", "VolumetricCloudSystem.ts");
    expect(clouds).toContain("Math.max(this.shadowSchedule.updateEveryNFrames, this.shadowIntervalFloor ?? 1)");
    expect(clouds).toContain("maximumViewSteps: Math.max(8, Math.min(192, profile.cloudPrimarySteps)),");
    expect(clouds).toContain("}), this.marchScale);");
    const terrain = source("render", "webgpu", "terrain", "TerrainClipmapSystem.ts");
    expect(terrain).toContain("Math.min(this.profile.shadowDistance, maxDistanceMeters)");
    expect(terrain).toContain("nodeBudget: this.options.nodeBudgetOverride ?? this.governedNodeBudget ?? this.profile.cdlodNodeBudget,");
    expect(terrain).toContain("pixelThreshold: this.slewPixelThreshold(),");
    const renderer = source("render", "FlightRenderer.ts");
    expect(renderer).toContain(
      "refreshIntervalAtCadence(work.shadowRefreshFrames, tier, shown) + work.shadowRefreshExtraFrames",
    );
    expect(renderer).toContain(
      "refreshIntervalAtCadence(work.cloudDepthRefreshFrames, tier, shown) + work.cloudDepthRefreshExtraFrames",
    );
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
    expect(renderer).toContain("this.terrain.setGovernedSelection(work.cdlodNodeBudget, work.cdlodPixelThreshold);");
    expect(renderer).toContain("this.clouds.setGovernedMarchScale(work.cloudMarchScale);");
  });
});
