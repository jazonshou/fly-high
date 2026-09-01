import { describe, expect, it } from "vitest";
import {
  COMPUTE_DISPATCH_SEED_COST_MS,
  type ComputeBudgetClient,
} from "../src/render/webgpu/core/ComputeBudget";
import { FRAME_BUDGET_MS } from "../src/render/webgpu/core/PerformanceBudget";

/**
 * Makes the cost-versus-row relationship VISIBLE, because it decides whether a
 * client's reservation exists at all and nothing measured it.
 *
 * `planComputeAdmissions`' reservation pass admits a dispatch only while
 * `spentHere + costMs <= ceilingMs`, whole-or-nothing, with the ceiling set to
 * the client's own `FRAME_BUDGET_MS` row. So **the reservation protects a
 * client only if ONE dispatch fits inside that row.** Where it does not, the
 * pass is a silent no-op and the client falls through to the surplus pass,
 * where the ceiling is the whole cap and priority alone decides.
 *
 * That is not automatically a defect — `terrainCompute` is documented as never
 * fitting, deliberately, and the floor of one is its admission path. So this
 * pins the SET of non-fitting pairs with a reason for each. A NEW one appearing
 * fails the build, which is what catches the next `occlusionCompute` without
 * forcing a premature row change.
 *
 * **The cost that matters is the one production SUBMITS, not the client's own
 * seed.** The channel bake submits at the occlusion+splat PAIR cost to the
 * occlusion client (`TerrainClipmapSystem.ts:1532-1545`) — priced against two
 * rows, reserved against one, so it can never fit. Both halves of that are
 * individually correct: the pairing is a correctness requirement (a slot's two
 * bakes publish together or material 0 renders at weight 0 permanently, because
 * a slot is baked once), and submitting to the lower-priority client is honest
 * queue behaviour. **Do not "fix" the pairing.** The seam between two correct
 * decisions is where the defect lives.
 *
 * **The obvious repair is insufficient, recorded here so nobody spends a day on
 * it:** reserving the pair against the SUM of both rows still fails —
 * occlusion 0.25 + splat 0.3 = 0.55 < 0.7 at tier 2 (only Ultra's 0.9 passes).
 * The tier 0-2 rows are undersized for the paired work as measured, so this is
 * a ROW CHANGE plus a fidelity trade (6-11's table), not an accounting patch.
 *
 * **Scope limit, deliberately prominent.** These are the SEED estimates. The
 * running meter replaces them from real dispatch timestamps, and the seeds sit
 * at the conservative end of measured bands (terrain 1.16-1.91, occlusion
 * 0.19-0.30, splat 0.10-0.39). A run where occlusion and splat converge low
 * could fit tier 3's row and possibly tier 2's. **So this table is what the
 * system does from cold, and on any frame where estimates run high** — not an
 * invariant over every frame. The dynamic half needs the reference host.
 */

const TIERS = [0, 1, 2, 3] as const;
type Tier = (typeof TIERS)[number];

const SEED = COMPUTE_DISPATCH_SEED_COST_MS;

/**
 * The demands production actually submits, at the cost it actually submits
 * them at. Keyed by a label rather than by client, because one client can be
 * submitted at more than one cost.
 */
interface ProductionDemand {
  readonly label: string;
  readonly client: ComputeBudgetClient;
  readonly costMs: number;
}

const PRODUCTION_DEMANDS: readonly ProductionDemand[] = [
  // One height page. `TerrainClipmapSystem.pumpComputeClients` submits at the
  // client's own estimate.
  { label: "terrainCompute (height page)", client: "terrainCompute", costMs: SEED.terrainCompute },
  // The eroded-world height client. No demand at all in the shipped analytic
  // world, which is why it does not appear in the tier-2 picture below.
  { label: "erosionCompute (page DAG dispatch)", client: "erosionCompute", costMs: SEED.erosionCompute },
  // THE ONE THIS TEST EXISTS FOR: a channel slot's occlusion+splat pair,
  // submitted to the LOWER-priority client at the COMBINED cost.
  {
    label: "occlusionCompute (paired channel bake)",
    client: "occlusionCompute",
    costMs: SEED.occlusionCompute + SEED.splatCompute,
  },
  // A season re-bake is the splat dispatch alone.
  { label: "splatCompute (season re-bake)", client: "splatCompute", costMs: SEED.splatCompute },
  // One ring's placement dispatch; the field submits three per frame.
  { label: "groundCoverCompute (one ring)", client: "groundCoverCompute", costMs: SEED.groundCoverCompute },
];

/** `label @ tier` for every pair whose ONE dispatch does not fit its own row. */
function unreservedPairs(): string[] {
  const out: string[] = [];
  for (const demand of PRODUCTION_DEMANDS) {
    for (const tier of TIERS) {
      const rowMs = FRAME_BUDGET_MS[tier][demand.client];
      if (demand.costMs > rowMs + 1e-9) out.push(`${demand.label} @ tier ${tier}`);
    }
  }
  return out.sort();
}

/**
 * Every pair that cannot use its reservation today, with the reason it is
 * tolerated. Adding a row here is a decision; a pair appearing that is NOT
 * here is a regression.
 */
const KNOWN_UNRESERVED: readonly string[] = [
  // Documented in COMPUTE_DISPATCH_SEED_COST_MS: one height page is ~1.9 ms
  // against a 1.6 ms row even at Ultra, so no height page is ever admitted
  // through the two-pass plan and `4.5-B2(b)`'s floor of one is terrain's only
  // admission path. Deliberate and recorded.
  "terrainCompute (height page) @ tier 0",
  "terrainCompute (height page) @ tier 1",
  "terrainCompute (height page) @ tier 2",
  "terrainCompute (height page) @ tier 3",
  // 0.24 against a 0.2 row at Low only; fits from tier 1 up.
  "erosionCompute (page DAG dispatch) @ tier 0",
  // THE UNDOCUMENTED ONE. 0.3 + 0.4 = 0.7 against rows of 0.1/0.2/0.25/0.4, so
  // the paired bake can never be reserved at ANY tier — including Ultra. The
  // ComputeBudget docblock names this exact client as the thing the reservation
  // pass protects ("stops a burst of terrain pages from starving the occlusion
  // bake"), and for the paired bake that protection does not exist.
  "occlusionCompute (paired channel bake) @ tier 0",
  "occlusionCompute (paired channel bake) @ tier 1",
  "occlusionCompute (paired channel bake) @ tier 2",
  "occlusionCompute (paired channel bake) @ tier 3",
  // A season re-bake at 0.4 fits only Ultra's 0.5 row.
  "splatCompute (season re-bake) @ tier 0",
  "splatCompute (season re-bake) @ tier 1",
  "splatCompute (season re-bake) @ tier 2",
].toSorted();

describe("compute budget: does one dispatch fit the client's own row? (reservation reachability)", () => {
  it("pins the set of client/tier pairs whose reservation is a no-op", () => {
    expect(
      unreservedPairs(),
      "A client/tier pair appeared (or disappeared) from the set whose single dispatch "
      + "does not fit its own FRAME_BUDGET_MS row. For such a pair the reservation pass "
      + "is a silent no-op and the client is surplus-only, decided by priority alone. "
      + "If this is intended, add it to KNOWN_UNRESERVED with the reason.",
    ).toEqual(KNOWN_UNRESERVED);
  });

  it("records that only the LOWEST-priority client keeps its reservation at tier 2 in the shipped world", () => {
    // The shipped world is analytic, so `erosionCompute` has no demand at all
    // (`TerrainClipmapSystem` selects it only when worldEvolution === "eroded").
    const analyticTier2 = PRODUCTION_DEMANDS
      .filter((d) => d.client !== "erosionCompute")
      .filter((d) => d.costMs <= FRAME_BUDGET_MS[2][d.client] + 1e-9)
      .map((d) => d.label);

    // This is the audit's headline, pinned so it cannot quietly change: the
    // two-pass design collapses to strict priority plus the floor of one for
    // every client that matters, which is what the second pass exists to
    // prevent. `groundCoverCompute` is LAST in COMPUTE_BUDGET_CLIENTS and is
    // the only client whose reservation survives.
    expect(
      analyticTier2,
      "The set of tier-2 clients keeping a reservation in the analytic world changed.",
    ).toEqual(["groundCoverCompute (one ring)"]);
  });

  it("shows summing both rows still does not admit the paired bake below Ultra", () => {
    // Recorded so the obvious repair is not attempted and quietly found to
    // change nothing.
    const pairCost = SEED.occlusionCompute + SEED.splatCompute;
    const bothRowsFit = TIERS.filter(
      (tier: Tier) =>
        pairCost <= FRAME_BUDGET_MS[tier].occlusionCompute + FRAME_BUDGET_MS[tier].splatCompute + 1e-9,
    );
    expect(
      bothRowsFit,
      "Reserving the pair against the SUM of both rows admits it only where this says. "
      + "If tiers 0-2 appear here, the rows were resized and the audit note is stale.",
    ).toEqual([3]);
  });
});
