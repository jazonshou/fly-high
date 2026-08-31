import { describe, expect, it } from "vitest";
import {
  COMPUTE_BUDGET_CLIENTS,
  COMPUTE_DISPATCH_SEED_COST_MS,
  ComputeBudget,
  computeBudgetCapMs,
  planComputeAdmissions,
} from "../src/render/webgpu/core/ComputeBudget";
import { FRAME_BUDGET_MS } from "../src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
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

  it("caps at the sum of every compute row and scales with the governor", () => {
    // `6-9` added a fifth client. The cap is the sum of the CLIENTS' rows, so
    // this sums them from the client list rather than by hand — a sixth
    // client added without a row would now fail here instead of quietly
    // widening the cap.
    const expected = COMPUTE_BUDGET_CLIENTS.reduce(
      (sum, client) => sum + rows[client],
      0,
    );
    expect(expected).toBeCloseTo(
      rows.terrainCompute + rows.splatCompute + rows.occlusionCompute
        + rows.erosionCompute + rows.groundCoverCompute,
      9,
    );
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
    const budget = new ComputeBudget(resolveWebGpuQualityProfile("medium", "balanced"));
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

  it("4.5-B2(a): seeds every estimate at a measured PER-DISPATCH cost", () => {
    // It used to seed at the client's whole per-frame ROW, which prices one
    // page bake at everything the frame may spend on page bakes. That is 5-10x
    // over, and it is the whole of the admission-starvation defect: with the
    // rows, tier 1 admitted two height pages per pump at scale 1 and NONE at
    // Governor B's GPU rung 2.
    const budget = new ComputeBudget(resolveWebGpuQualityProfile("high", "balanced"));
    for (const client of COMPUTE_BUDGET_CLIENTS) {
      expect(budget.estimatedCostMs(client))
        .toBe(COMPUTE_DISPATCH_SEED_COST_MS[client]);
      // Non-vacuous: a seed that happened to equal the row would leave the
      // defect in place at that client.
      expect(COMPUTE_DISPATCH_SEED_COST_MS[client], client)
        .toBeLessThan(FRAME_BUDGET_MS[2][client] * 2);
    }
  });

  // Assertion 114.
  it("assertion 114: admits a height page at Governor B's deepest compute rung", () => {
    // The verified starvation: at computeBudgetScale 0.35 the tier-1 cap is
    // 0.54 ms, every client was priced at its whole row, and terrain admitted
    // ZERO — forever, because a starved client observes no cost and its
    // estimate never falls — while the LOWER-priority occlusion client still
    // admitted two. A priority inversion that stops terrain streaming for the
    // session.
    for (const scale of [1, 0.6, 0.35]) {
      const plan = planComputeAdmissions(
        [
          { client: "terrainCompute", count: 12, costMs: rows.terrainCompute },
          { client: "occlusionCompute", count: 12, costMs: rows.occlusionCompute },
        ],
        rows,
        scale,
      );
      const terrain = plan.admissions.find((entry) => entry.client === "terrainCompute")!;
      expect(terrain.admitted, `scale ${scale}`).toBeGreaterThanOrEqual(1);
    }
    // The floor is a FLOOR, not a bypass: it fires only for the highest
    // priority client with demand, and only when that client got nothing.
    const starved = planComputeAdmissions(
      [{ client: "occlusionCompute", count: 4, costMs: 99 }],
      rows,
      0.35,
    );
    expect(starved.admissions.find((entry) => entry.client === "occlusionCompute")!.admitted)
      .toBe(1);
    // …and it costs at most one dispatch of overspend, which is what Phase 5's
    // cap assertions have to be authored for.
    expect(starved.spentMs).toBeLessThanOrEqual(starved.capMs + 99);
    expect(starved.deferredDispatches).toBe(3);
  });

  // Assertion 113.
  it("assertion 113: estimates converge to within 3x of the observed cost", () => {
    const budget = new ComputeBudget(resolveWebGpuQualityProfile("medium", "balanced"));
    const observed = 0.042;
    for (let batch = 0; batch < 12; batch += 1) {
      budget.observeDispatchCostMs("terrainCompute", observed);
    }
    const estimate = budget.estimatedCostMs("terrainCompute");
    expect(estimate).toBeLessThanOrEqual(observed * 3);
    expect(estimate).toBeGreaterThanOrEqual(observed / 3);
    // The seed is far enough from the observation for that to mean something.
    expect(COMPUTE_DISPATCH_SEED_COST_MS.terrainCompute).toBeGreaterThan(observed * 3);
  });

  // Assertion 112.
  it("assertion 112: two clients in one frame share one cap", () => {
    const budget = new ComputeBudget(resolveWebGpuQualityProfile("medium", "balanced"));
    budget.beginFrame();
    budget.submit("terrainCompute", 20, 0.1);
    budget.submit("occlusionCompute", 20, 0.1);
    const shared = budget.resolve();
    expect(shared.spentMs).toBeLessThanOrEqual(shared.capMs + 1e-9);

    // The defect shape, so the assertion is not vacuous: a second beginFrame
    // inside the same frame — which is exactly what TerrainClipmapSystem's two
    // pumps used to do — wipes the first plan and spends a fresh cap.
    budget.beginFrame();
    budget.submit("occlusionCompute", 20, 0.1);
    const second = budget.resolve();
    expect(second.spentMs + shared.spentMs).toBeGreaterThan(shared.capMs);
  });
});

/**
 * `6-9` — wave G's first debt. The per-frame ground-cover field ran OUTSIDE
 * this meter: plan `G-1` named the client, nothing created it, and the one
 * place that is supposed to know what a frame spends on compute could not see
 * the only client that dispatches every frame.
 */
describe("groundCoverCompute admission (6-9)", () => {
  const rows = FRAME_BUDGET_MS[1];

  it("is a real client with a real row, ordered LAST", () => {
    expect(COMPUTE_BUDGET_CLIENTS).toContain("groundCoverCompute");
    expect(COMPUTE_BUDGET_CLIENTS[COMPUTE_BUDGET_CLIENTS.length - 1])
      .toBe("groundCoverCompute");
    for (const tier of [0, 1, 2, 3] as const) {
      expect(FRAME_BUDGET_MS[tier].groundCoverCompute, `tier ${tier}`).toBeGreaterThan(0);
    }
    expect(COMPUTE_DISPATCH_SEED_COST_MS.groundCoverCompute).toBeGreaterThan(0);
  });

  it("admits the field's three rings on a calm frame", () => {
    const plan = planComputeAdmissions(
      [{
        client: "groundCoverCompute",
        count: 3,
        costMs: COMPUTE_DISPATCH_SEED_COST_MS.groundCoverCompute,
      }],
      rows,
    );
    expect(plan.admissions[0]!.admitted).toBe(3);
    expect(plan.deferredDispatches).toBe(0);
    // Three rings must fit inside the client's OWN row, not only inside the
    // shared cap: the reservation pass is what stops a burst of page bakes
    // from starving the field on a streaming frame.
    expect(3 * COMPUTE_DISPATCH_SEED_COST_MS.groundCoverCompute)
      .toBeLessThanOrEqual(rows.groundCoverCompute + 1e-9);
  });

  it("defers the field before any higher-priority client, floor included", () => {
    // Every client over-requests. Ground cover is last, so it is the first to
    // be deferred — and the floor of one belongs to the HIGHEST-priority
    // client with demand, never to this one.
    const plan = planComputeAdmissions(
      COMPUTE_BUDGET_CLIENTS.map((client) => ({ client, count: 40, costMs: 0.3 })),
      rows,
    );
    const ground = plan.admissions.find((row) => row.client === "groundCoverCompute")!;
    expect(ground.requested).toBe(40);
    expect(ground.admitted).toBeLessThan(ground.requested);
    // `4.5-B2(b)`: the cap may be exceeded by EXACTLY one dispatch, and only
    // for the highest-priority starved client. If ground cover were taking
    // the floor the overshoot would be attributed to it instead.
    expect(plan.spentMs).toBeLessThanOrEqual(plan.capMs + 0.3 + 1e-9);
  });

  it("takes the anti-starvation floor only when nothing outranks it", () => {
    // A dispatch priced far above the whole cap: without the floor this
    // client would admit zero forever, and — because a starved client never
    // observes a cost — its estimate would never fall. The absorbing state
    // `4.5-B2(b)` exists to prevent, in the newest client.
    const cap = computeBudgetCapMs(rows);
    const alone = planComputeAdmissions(
      [{ client: "groundCoverCompute", count: 3, costMs: cap * 4 }],
      rows,
    );
    expect(alone.admissions[0]!.admitted).toBe(1);
    expect(alone.spentMs).toBeGreaterThan(alone.capMs);

    // With a higher-priority client also starved, the floor goes to THAT one
    // and ground cover waits.
    const contested = planComputeAdmissions(
      [
        { client: "terrainCompute", count: 1, costMs: cap * 4 },
        { client: "groundCoverCompute", count: 3, costMs: cap * 4 },
      ],
      rows,
    );
    expect(contested.admissions.find((row) => row.client === "terrainCompute")!.admitted).toBe(1);
    expect(
      contested.admissions.find((row) => row.client === "groundCoverCompute")!.admitted,
    ).toBe(0);
  });

  it("cannot disturb an already-read admission by declaring late", () => {
    // The ordering hazard `pumpComputeClients` documents: the renderer runs
    // `terrain.update` (which declares AND reads) before the ground-cover
    // update, so this client always submits after a read, and `submit`
    // invalidates the cached plan.
    //
    // Being LAST in the priority order is NOT enough on its own — measured:
    // the reservation pass runs for every client before the surplus pass, so
    // a new low-priority RESERVATION precedes a high-priority client's
    // SURPLUS and occlusion dropped from two dispatches to one. What makes it
    // safe is that reading an admission SETTLES the client: its count is
    // frozen and its milliseconds are charged to the cap.
    const budget = new ComputeBudget(resolveWebGpuQualityProfile("medium", "balanced"));
    budget.beginFrame();
    budget.submit("terrainCompute", 4, 0.3);
    budget.submit("occlusionCompute", 4, 0.2);
    const terrainFirst = budget.admitted("terrainCompute");
    const occlusionFirst = budget.admitted("occlusionCompute");
    const spentFirst = budget.resolve().spentMs;

    budget.submit("groundCoverCompute", 3, 0.06);
    expect(budget.admitted("terrainCompute")).toBe(terrainFirst);
    expect(budget.admitted("occlusionCompute")).toBe(occlusionFirst);
    // And the late client only ever gets what was left over.
    expect(budget.resolve().spentMs).toBeGreaterThanOrEqual(spentFirst);
    expect(budget.resolve().spentMs).toBeLessThanOrEqual(budget.capMs + 0.3 + 1e-9);
  });
});

/**
 * `6-9` — wave G's second debt (`P-5`, unimplemented and unrecorded at the
 * time). The most responsive GPU lever in the renderer had no rung.
 */
describe("Governor GPU ladder: the ground-cover rung (6-9 / P-5)", () => {
  const config = governorConfigForProfile({ tier: 1, renderScale: 0.86 });

  it("sheds the gate LAST, after every cheaper GPU lever", () => {
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 4, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    state = nextGovernorDecision(state, gpuBound, config);
    state = observeRenderScaleApplication(state, false, config);
    const levers: string[] = [];
    for (let window = 0; window < 40 && state.gpuWorkLevel < GPU_WORK_MAX_LEVEL; window += 1) {
      const before = state.gpuWorkLevel;
      state = nextGovernorDecision(state, gpuBound, config);
      if (state.gpuWorkLevel > before) levers.push(gpuWorkLeverName(state.gpuWorkLevel)!);
    }
    expect(state.gpuWorkLevel).toBe(GPU_WORK_MAX_LEVEL);
    expect(levers[levers.length - 1]).toBe("ground-cover-gate");
    expect(levers.indexOf("ground-cover-gate"))
      .toBeGreaterThan(levers.lastIndexOf("vegetation-distance"));
    // Two notches, like rung 0: one step per 120-frame window, and a single
    // notch from full to nothing is a cliff at the one pose the whole system
    // exists for.
    expect(levers.filter((lever) => lever === "ground-cover-gate")).toHaveLength(2);
  });

  it("moves the gate monotonically and never above the profile's own", () => {
    let previous = 1;
    for (let level = 0; level <= GPU_WORK_MAX_LEVEL; level += 1) {
      const scale = workLeverSettingsFor(0, level).groundCoverGateScale;
      expect(scale).toBeLessThanOrEqual(previous);
      expect(scale).toBeGreaterThan(0);
      previous = scale;
    }
    expect(workLeverSettingsFor(0, 0).groundCoverGateScale).toBe(1);
    expect(workLeverSettingsFor(0, GPU_WORK_MAX_LEVEL).groundCoverGateScale).toBeLessThan(1);
  });

  it("recovers only from a calm, non-GPU-bound window (R-11)", () => {
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 4, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    state = nextGovernorDecision(state, gpuBound, config);
    state = observeRenderScaleApplication(state, false, config);
    for (let window = 0; window < 40 && state.gpuWorkLevel < GPU_WORK_MAX_LEVEL; window += 1) {
      state = nextGovernorDecision(state, gpuBound, config);
    }
    expect(workLeverSettingsFor(0, state.gpuWorkLevel).groundCoverGateScale).toBeLessThan(1);
    const calm: GovernorSignals = { gpuP95Ms: 5, cpuP95Ms: 5, intervalP95Ms: 16 };
    const top = state.gpuWorkLevel;
    for (let window = 0; window < 8; window += 1) {
      state = nextGovernorDecision(state, calm, config);
    }
    expect(state.gpuWorkLevel).toBeLessThan(top);
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
