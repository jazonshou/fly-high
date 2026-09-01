import { describe, expect, it } from "vitest";
import {
  COMPUTE_BUDGET_CLIENTS,
  COMPUTE_DISPATCH_SEED_COST_MS,
  computeBudgetCapMs,
  planComputeAdmissions,
  type ComputeBudgetClient,
} from "../src/render/webgpu/core/ComputeBudget";
import {
  FRAME_BUDGET_MS,
  type PerformanceTier,
} from "../src/render/webgpu/core/PerformanceBudget";

/**
 * The admission audit: can a compute client be STARVED?
 *
 * The failure class, hit twice in one day in unrelated subsystems (the
 * `fine-band` deadlock, and `6-11`'s global horizon bake): a GPU producer that
 * is correct, compiled and correctly bound can still win no admission and
 * never run. Every unit test passes, because they all call the producer
 * directly. A capture shows no pixel movement, which reads as "correctly
 * inert" — so the green result becomes the argument that the dead feature is
 * fine.
 *
 * This file answers the question at the meter rather than at the GPU.
 * `planComputeAdmissions` is a pure function of (demand, rows, scale), so a
 * Node test over it is not a compromise forced by a thermal window — it is the
 * sharper instrument. A GPU test answers the same question with dispatch
 * noise, one tier, and one demand pattern; this answers it for every client,
 * every tier and every governor rung, exhaustively.
 *
 * What it is NOT: proof that a producer's output becomes resident. That needs
 * the real pump and lives in `tests/gpu/terrain-horizon-pyramid.test.ts`
 * ("ARMS through the real pump"). The two are complementary — this one proves
 * the meter CAN admit the client, that one proves the renderer DOES.
 */

const TIERS: readonly PerformanceTier[] = [0, 1, 2, 3];

/** One dispatch of every client, priced at its own measured seed. */
function fullDemand() {
  return COMPUTE_BUDGET_CLIENTS.map((client) => ({
    client,
    count: 1,
    costMs: COMPUTE_DISPATCH_SEED_COST_MS[client],
  }));
}

function admittedFor(
  plan: ReturnType<typeof planComputeAdmissions>,
  client: ComputeBudgetClient,
): number {
  return plan.admissions.find((a) => a.client === client)?.admitted ?? 0;
}

describe("ComputeBudget starvation audit", () => {
  it("records which clients cannot fund one dispatch from their OWN row", () => {
    // The reservation pass gives each client up to its own row. A client whose
    // measured per-dispatch cost exceeds that row is admitted ZERO there and
    // survives only on surplus or the floor-of-one — i.e. it is starvable in
    // principle, and the rest of this file measures whether it starves in
    // practice. This is a LEDGER, not a failure: it is asserted so the set
    // cannot grow silently.
    const overRow: string[] = [];
    for (const tier of TIERS) {
      for (const client of COMPUTE_BUDGET_CLIENTS) {
        const row = FRAME_BUDGET_MS[tier][client];
        const cost = COMPUTE_DISPATCH_SEED_COST_MS[client];
        if (cost > row) overRow.push(`${client}@${tier} (${cost} > ${row})`);
      }
    }
    // Measured 2026-08-31 on 1e526f9. Every entry means "one dispatch does not
    // fit this client's own row at this tier".
    expect(overRow).toEqual([
      "terrainCompute@0 (1.9 > 0.4)",
      "splatCompute@0 (0.4 > 0.15)",
      "occlusionCompute@0 (0.3 > 0.1)",
      "erosionCompute@0 (0.24 > 0.2)",
      "terrainCompute@1 (1.9 > 0.7)",
      "splatCompute@1 (0.4 > 0.25)",
      "occlusionCompute@1 (0.3 > 0.2)",
      "terrainCompute@2 (1.9 > 1)",
      "splatCompute@2 (0.4 > 0.3)",
      "occlusionCompute@2 (0.3 > 0.25)",
      "terrainCompute@3 (1.9 > 1.6)",
    ]);
    // groundCoverCompute is the ONLY client that funds itself from its own row
    // at every tier — which is exactly why `6-9` could make the per-frame
    // producer a client without the table moving.
    expect(overRow.filter((e) => e.startsWith("groundCoverCompute"))).toEqual([]);
  });

  it("FINDING: erosionCompute starves at tier 0 with all five competing", () => {
    // The property that matters: with all five competing at their measured
    // costs, does anybody get zero? A client starved to zero while demand
    // exists is a feature invisible for that frame — and if the condition
    // persists, invisible forever.
    //
    // MEASURED 2026-08-31 on 1e526f9 — and the shape is NOT what priority
    // order would suggest, which is why it is measured rather than reasoned:
    //
    //   tier 0 (cap 0.95): erosionCompute starves. Its seed (0.24) exceeds its
    //     own row (0.20) so reservation admits nothing, and by the surplus
    //     pass the cheaper clients ahead have spent the cap down to 0.19.
    //   tier 1 (cap 1.73): nobody starves.
    //   tier 2 (cap 2.45): splatCompute AND occlusionCompute starve. Here
    //     terrain's 1.9 ms FITS the cap, so it is taken in the surplus pass
    //     rather than as the floor's one over-cap dispatch — and having eaten
    //     1.9 of 2.45 it leaves too little for either 0.4 or 0.3.
    //   tier 3 (cap 4.05): nobody starves.
    //
    // So the worst tier is not the smallest one. Tier 2 starves MORE clients
    // than tier 0, because an expensive client that fits the cap is more
    // damaging than one that does not: the floor-of-one gives the over-cap
    // client exactly one dispatch and stops, while a fits-the-cap client takes
    // its fill in the surplus pass.
    //
    // Why this is pinned rather than fixed: the repair is a budget row, and
    // the tier table is `6-11`'s to move — tier 2 has 0.050 ms of frame slack,
    // so any row change is a trade rather than an edit. Reported, not silently
    // patched. `occlusionCompute` starving at tier 2 is the one to act on: it
    // is the row the page channel bakes AND `6-11`'s global horizon bake share.
    const expected: Record<number, readonly string[]> = {
      0: ["erosionCompute"],
      1: [],
      2: ["splatCompute", "occlusionCompute"],
      3: [],
    };
    for (const tier of TIERS) {
      const plan = planComputeAdmissions(fullDemand(), FRAME_BUDGET_MS[tier]);
      const starved = COMPUTE_BUDGET_CLIENTS
        .filter((client) => admittedFor(plan, client) === 0);
      expect(
        starved,
        `tier ${tier}: starvation set changed`
        + ` (cap ${computeBudgetCapMs(FRAME_BUDGET_MS[tier]).toFixed(2)} ms)`,
      ).toEqual(expected[tier]);
    }
  });

  it("lets one over-cap client crowd the table, but not empty it", () => {
    // `terrainCompute` costs 1.9 ms measured, which exceeds the WHOLE compute
    // cap at tiers 0-2 (1.05 / 1.73 / 2.45 ms). The floor-of-one hands it a
    // dispatch anyway — deliberately, so the highest-priority client cannot
    // fall into an absorbing state — and that one dispatch then crowds the
    // frame.
    //
    // I PREDICTED this starves everything below it. Measured, it does not:
    // the reservation pass runs BEFORE the floor and banks whatever fits each
    // client's own row first, so the cheap clients are already admitted by the
    // time terrain takes its over-cap dispatch. Recording the measurement
    // rather than the prediction, because the prediction was wrong.
    // Tiers 0 and 1 ONLY: their caps (1.05 / 1.73) are below terrain's 1.9 ms.
    // Tier 2's cap is 2.45, so terrain fits and takes its dispatch through the
    // ordinary surplus pass instead — a different regime, measured above.
    for (const tier of [0, 1] as const) {
      const cap = computeBudgetCapMs(FRAME_BUDGET_MS[tier]);
      expect(COMPUTE_DISPATCH_SEED_COST_MS.terrainCompute).toBeGreaterThan(cap);
      const plan = planComputeAdmissions(fullDemand(), FRAME_BUDGET_MS[tier]);
      expect(admittedFor(plan, "terrainCompute"), `tier ${tier} floor-of-one`).toBe(1);
      // The documented `4.5-B2(b)` allowance: the cap may be exceeded by
      // exactly one dispatch. Everything else must still fit inside it.
      const spent = COMPUTE_BUDGET_CLIENTS.reduce(
        (sum, client) =>
          sum + admittedFor(plan, client) * COMPUTE_DISPATCH_SEED_COST_MS[client],
        0,
      );
      expect(
        spent - COMPUTE_DISPATCH_SEED_COST_MS.terrainCompute,
        `tier ${tier}: the cap is exceeded by more than the floor's one dispatch`,
      ).toBeLessThanOrEqual(cap + 1e-9);
    }
  });

  it("still admits the lower clients once the hungry one is satisfied", () => {
    // The saving grace, and the reason the above is survivable: page streaming
    // is bursty, not continuous. On a frame where terrain wants nothing, the
    // rest of the table is admitted normally. This asserts the recovery, so a
    // change that made terrain demand permanent would fail HERE rather than as
    // an invisible dead feature three items later.
    for (const tier of TIERS) {
      const withoutTerrain = fullDemand().filter((r) => r.client !== "terrainCompute");
      const plan = planComputeAdmissions(withoutTerrain, FRAME_BUDGET_MS[tier]);
      for (const request of withoutTerrain) {
        // tier 0's erosionCompute is the one exception, and it is NOT about
        // terrain being busy — see the FINDING above. It starves on the row
        // arithmetic alone, so idling the biggest client does not rescue it.
        if (tier === 0 && request.client === "erosionCompute") {
          expect(admittedFor(plan, request.client)).toBe(0);
          continue;
        }
        expect(
          admittedFor(plan, request.client),
          `tier ${tier}: ${request.client} not admitted even with terrain idle`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("keeps the floor-of-one alive at every governor rung", () => {
    // Governor B rung 0 shrinks the compute cap FIRST, before any lever the
    // pilot can see. `4.5-B2(b)` exists because at scale 0.35 the
    // highest-priority client was admitting zero forever while a lower one
    // still ran — a priority inversion whose state is absorbing, since a
    // starved client observes no cost, so its estimate never falls and it
    // never recovers. Assert the floor holds all the way down.
    for (const tier of TIERS) {
      for (const scale of [1, 0.75, 0.5, 0.35, 0.2, 0.05, 0]) {
        const plan = planComputeAdmissions(fullDemand(), FRAME_BUDGET_MS[tier], scale);
        const total = COMPUTE_BUDGET_CLIENTS
          .reduce((sum, client) => sum + admittedFor(plan, client), 0);
        expect(
          total,
          `tier ${tier} scale ${scale}: no client admitted at all — the compute`
          + " ladder has an absorbing state",
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("never lets a zero-cost client deadlock a producer whose estimate is cold", () => {
    // A client whose measured estimate has not warmed prices at 0. The planner
    // admits those free rather than refusing them, because refusing would mean
    // a producer that has never run can never run — it observes no cost, so
    // its estimate never warms. Same absorbing-state shape as the floor.
    for (const tier of TIERS) {
      const cold = COMPUTE_BUDGET_CLIENTS.map((client) => ({ client, count: 2, costMs: 0 }));
      const plan = planComputeAdmissions(cold, FRAME_BUDGET_MS[tier]);
      for (const client of COMPUTE_BUDGET_CLIENTS) {
        expect(
          admittedFor(plan, client),
          `tier ${tier}: cold-estimate ${client} refused, and cannot warm`,
        ).toBe(2);
      }
    }
  });

  it("covers every client in COMPUTE_BUDGET_CLIENTS", () => {
    // The audit is only exhaustive while the list is. A sixth client added
    // without a row, a seed cost, or a thought about starvation fails here.
    expect(COMPUTE_BUDGET_CLIENTS.length).toBe(5);
    for (const client of COMPUTE_BUDGET_CLIENTS) {
      expect(COMPUTE_DISPATCH_SEED_COST_MS[client], `${client} has no seed cost`)
        .toBeGreaterThan(0);
      for (const tier of TIERS) {
        expect(FRAME_BUDGET_MS[tier][client], `${client} has no row at tier ${tier}`)
          .toBeGreaterThan(0);
      }
    }
  });
});
