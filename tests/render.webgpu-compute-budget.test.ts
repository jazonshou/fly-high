import { describe, expect, it } from "vitest";
import {
  COMPUTE_BUDGET_CLIENTS,
  ComputeBudget,
  computeBudgetCapMs,
  planComputeAdmissions,
  type ComputeBudgetClient,
} from "../src/render/webgpu/core/ComputeBudget";
import { FRAME_BUDGET_MS } from "../src/render/webgpu/core/PerformanceBudget";
import {
  GPU_WORK_MAX_LEVEL,
  createGovernorState,
  governorConfigForProfile,
  gpuWorkLeverName,
  nextGovernorDecision,
  observeRenderScaleApplication,
  workLeverSettingsFor,
  type GovernorSignals,
} from "../src/render/webgpu/core/AdaptiveGovernor";

/**
 * `4-0b`'s gate (assertions 71 and 72). The compute caps in
 * `PerformanceBudget.ts` claimed to be "amortised hard caps enforced by their
 * schedulers" while no scheduler existed. These are the properties that make
 * the claim true.
 */
describe("shared amortised-compute meter (4-0b)", () => {
  const rows = FRAME_BUDGET_MS[1];

  it("caps at the sum of the four compute rows and scales with the governor", () => {
    const expected =
      rows.terrainCompute + rows.splatCompute + rows.occlusionCompute + rows.erosionCompute;
    expect(computeBudgetCapMs(rows)).toBeCloseTo(expected, 9);
    expect(computeBudgetCapMs(rows, 0.5)).toBeCloseTo(expected * 0.5, 9);
    expect(computeBudgetCapMs(rows, 5)).toBeCloseTo(expected, 9);
    expect(computeBudgetCapMs(rows, -1)).toBe(0);
  });

  // Assertion 71.
  it("admits four over-requesting clients in priority order under one cap", () => {
    // Each client asks for four times the cap on its own. Before this meter,
    // a banked turn that admitted many pages at once spent three separate
    // caps in one frame.
    const plan = planComputeAdmissions(
      COMPUTE_BUDGET_CLIENTS.map((client) => ({ client, count: 40, costMs: 0.1 })),
      rows,
    );
    expect(plan.spentMs).toBeLessThanOrEqual(plan.capMs + 1e-9);
    expect(plan.deferredDispatches).toBeGreaterThan(0);

    // Every client keeps its own published row — reservation before surplus,
    // so a burst of page bakes cannot starve the occlusion bake outright and
    // the per-row caps still mean something.
    for (const entry of plan.admissions) {
      const rowMs = rows[entry.client];
      expect(entry.admittedMs, entry.client)
        .toBeGreaterThanOrEqual(Math.min(rowMs, 0.1) - 1e-9);
      expect(entry.admittedMs, entry.client).toBeLessThanOrEqual(plan.capMs + 1e-9);
    }
    // Priority governs the SURPLUS, which is the only part that is contested:
    // once a client is deferred, nothing below it in the order may have taken
    // more than its own row.
    let sawDeferred = false;
    for (const client of COMPUTE_BUDGET_CLIENTS) {
      const entry = plan.admissions.find((row) => row.client === client)!;
      if (sawDeferred) {
        expect(entry.admittedMs, `${client} took surplus past a deferred client`)
          .toBeLessThanOrEqual(rows[client] + 1e-9);
      }
      if (entry.admitted < entry.requested) sawDeferred = true;
    }
    expect(sawDeferred).toBe(true);
  });

  it("gives the surplus to the highest-priority client that wants it", () => {
    // Only terrain is hungry: it may spend the whole cap, not just its row.
    const plan = planComputeAdmissions(
      [{ client: "terrainCompute", count: 100, costMs: 0.05 }],
      rows,
    );
    expect(plan.spentMs).toBeGreaterThan(rows.terrainCompute);
    expect(plan.spentMs).toBeLessThanOrEqual(plan.capMs + 1e-9);
  });

  it("admits a dispatch whole or not at all", () => {
    // Half a page bake is not a cheaper page bake.
    const cap = computeBudgetCapMs(rows);
    const plan = planComputeAdmissions(
      [{ client: "terrainCompute", count: 3, costMs: cap * 0.7 }],
      rows,
    );
    expect(plan.admissions[0]!.admitted).toBe(1);
    expect(plan.spentMs).toBeCloseTo(cap * 0.7, 9);
  });

  it("prices a merged demand at the more expensive estimate", () => {
    const plan = planComputeAdmissions(
      [
        { client: "terrainCompute", count: 1, costMs: 0.05 },
        { client: "terrainCompute", count: 1, costMs: 0.4 },
      ],
      rows,
    );
    expect(plan.admissions[0]!.requested).toBe(2);
    expect(plan.spentMs).toBeCloseTo(0.8, 9);
  });

  it("rejects malformed demands rather than silently admitting them", () => {
    expect(() =>
      planComputeAdmissions([{ client: "terrainCompute", count: 1, costMs: Number.NaN }], rows),
    ).toThrow(RangeError);
    expect(() =>
      planComputeAdmissions([{ client: "terrainCompute", count: 1.5, costMs: 1 }], rows),
    ).toThrow(RangeError);
  });

  it("runs the live meter across frames and smooths measured costs", () => {
    const budget = new ComputeBudget(1);
    expect(budget.budgetScale).toBe(1);
    budget.beginFrame();
    budget.submit("terrainCompute", 6, 0.2);
    budget.submit("occlusionCompute", 6, 0.2);
    const first = budget.resolve();
    // Idempotent within a frame: producers read the same answer twice.
    expect(budget.resolve()).toBe(first);
    expect(budget.admitted("terrainCompute"))
      .toBeGreaterThanOrEqual(budget.admitted("occlusionCompute"));

    // Governor rung 0 shrinks the cap, and fewer dispatches are admitted.
    const beforeScale = first.spentMs;
    budget.setBudgetScale(0.35);
    budget.beginFrame();
    budget.submit("terrainCompute", 6, 0.2);
    budget.submit("occlusionCompute", 6, 0.2);
    expect(budget.resolve().spentMs).toBeLessThan(beforeScale);

    // A measured cost moves the running estimate but does not replace it.
    const seeded = budget.estimatedCostMs("terrainCompute");
    budget.observeDispatchCostMs("terrainCompute", seeded * 4);
    const moved = budget.estimatedCostMs("terrainCompute");
    expect(moved).toBeGreaterThan(seeded);
    expect(moved).toBeLessThan(seeded * 4);
    budget.observeDispatchCostMs("terrainCompute", Number.NaN);
    expect(budget.estimatedCostMs("terrainCompute")).toBe(moved);
  });

  it("keeps every client's estimate seeded from its published row", () => {
    const budget = new ComputeBudget(2);
    for (const client of COMPUTE_BUDGET_CLIENTS) {
      expect(budget.estimatedCostMs(client as ComputeBudgetClient))
        .toBe(FRAME_BUDGET_MS[2][client]);
    }
  });
});

describe("Governor B rung 0 (4-0b)", () => {
  const config = governorConfigForProfile({ tier: 1, renderScale: 0.86 });

  // Assertion 71's governor half: rung 0 fires before any visible lever.
  it("sheds the compute cap before touching anything the pilot can see", () => {
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 4, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    state = nextGovernorDecision(state, gpuBound, config);
    // The reference-machine state (R-6): the pixel cap absorbs the first
    // resolution step, so the latch fires and only the GPU ladder is left.
    state = observeRenderScaleApplication(state, false, config);
    expect(state.resolutionInsensitive).toBe(true);

    const levers: string[] = [];
    for (let window = 0; window < 24 && state.gpuWorkLevel < GPU_WORK_MAX_LEVEL; window += 1) {
      const before = state.gpuWorkLevel;
      state = nextGovernorDecision(state, gpuBound, config);
      if (state.gpuWorkLevel > before) levers.push(gpuWorkLeverName(state.gpuWorkLevel)!);
    }
    expect(levers[0]).toBe("compute-budget");
    expect(levers[1]).toBe("compute-budget");
    expect(levers.slice(2)).not.toContain("compute-budget");
    // The first visible lever only moves after the compute cap is exhausted.
    expect(levers.indexOf("cloud-shadow-cadence")).toBeGreaterThan(1);
  });

  // Assertion 72.
  it("never recovers a work step while the frame is GPU-bound", () => {
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 4, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    state = nextGovernorDecision(state, gpuBound, config);
    state = observeRenderScaleApplication(state, false, config);
    for (let window = 0; window < 40; window += 1) {
      const before = state.gpuWorkLevel;
      const beforeCpu = state.cpuWorkLevel;
      state = nextGovernorDecision(state, gpuBound, config);
      expect(state.gpuWorkLevel).toBeGreaterThanOrEqual(before);
      expect(state.cpuWorkLevel).toBeGreaterThanOrEqual(beforeCpu);
    }
    expect(workLeverSettingsFor(state.cpuWorkLevel, state.gpuWorkLevel).computeBudgetScale)
      .toBeLessThan(1);
  });
});
