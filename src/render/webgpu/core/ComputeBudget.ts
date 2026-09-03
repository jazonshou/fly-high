import {
  FRAME_BUDGET_MS,
  type PerformanceTier,
  type SubsystemBudgetMs,
} from "./PerformanceBudget";
import type { WebGpuQualityProfile } from "./QualityProfile";

/**
 * The shared amortised-compute meter (`4-0b`; `6-10` moved forward).
 *
 * INVARIANT THIS FILE OWNS: every GPU compute producer in the renderer is
 * admitted by ONE per-frame millisecond meter, in a declared priority order,
 * under ONE cap — and the governor can shrink that cap before any visible
 * quality lever moves.
 *
 * **This exists because the caps already claimed to be enforced and were
 * not.** `PerformanceBudget.ts` documents `terrainCompute`, `splatCompute`,
 * `occlusionCompute` and `erosionCompute` as *"amortised hard caps enforced by
 * their schedulers"*. No scheduler existed. `FrameGraphPass.cadence` is an
 * integer frame divisor (`frameIndex % cadence === 0`) and nothing else, so
 * with no shared meter a banked turn that admits many pages at once spends
 * three separate caps in one frame. Governor B's ladder had no compute rung
 * either, which meant its first available response to a compute spike was to
 * cut something the pilot can see.
 *
 * Class P: pure arithmetic over numbers and a budget table. No Babylon
 * import, Node-testable.
 */

/**
 * The compute clients, IN PRIORITY ORDER.
 *
 * Height first: without a generated page there is no ground, and every other
 * producer reads the height page this one writes. Erosion near the back: it
 * runs on geological time (`5-4`), so deferring a dispatch by a frame is
 * invisible by construction — which is exactly what makes it the right thing
 * to defer.
 *
 * `6-9` — **`groundCoverCompute` is last, and the position is load-bearing.**
 * Wave G shipped the per-frame ground-cover field OUTSIDE this meter (plan
 * G-1 named the client and never created it), so the one place that is
 * supposed to know what the frame spends on compute could not see the only
 * compute client that runs EVERY frame. It is admitted here now, and its
 * priority is the lowest for a measured reason: the placement kernel writes a
 * PERSISTENT lane buffer, so a deferred dispatch leaves last frame's records
 * standing — world-anchored roots on world-anchored ground, a camera-frame
 * older. Nothing else in this table degrades that gracefully; a deferred
 * height page is missing ground and a deferred erosion dispatch is a page
 * that never converges.
 *
 * Being last is NOT by itself what makes the ground-cover producer's LATE
 * declaration safe, and the measurement is worth recording because the
 * plausible argument is wrong: the terrain pump declares and reads inside
 * `terrain.update`, which the renderer runs first, and a later `submit`
 * invalidates the cached plan. Adding a lower-priority client's demand DOES
 * move an earlier client's admission, because the RESERVATION pass runs for
 * every client before the surplus pass — so a new reservation legitimately
 * precedes a higher-priority client's surplus, and occlusion was measured
 * dropping from two dispatches to one. The fix is in the meter rather than in
 * the argument: reading an admission SETTLES it (see `ComputeBudget.settled`).
 * `tests/render.webgpu-compute-budget.test.ts` pins the property directly.
 */
export const COMPUTE_BUDGET_CLIENTS = [
  "terrainCompute",
  "splatCompute",
  "occlusionCompute",
  "erosionCompute",
  "groundCoverCompute",
] as const;

export type ComputeBudgetClient = (typeof COMPUTE_BUDGET_CLIENTS)[number];

/** One client's demand for a frame: `count` dispatches at `costMs` each. */
export interface ComputeDispatchRequest {
  readonly client: ComputeBudgetClient;
  readonly count: number;
  /** Estimated GPU milliseconds for ONE dispatch. */
  readonly costMs: number;
}

export interface ComputeAdmission {
  readonly client: ComputeBudgetClient;
  readonly requested: number;
  readonly admitted: number;
  readonly admittedMs: number;
}

export interface ComputeAdmissionPlan {
  readonly capMs: number;
  readonly spentMs: number;
  readonly admissions: readonly ComputeAdmission[];
  readonly deferredDispatches: number;
}

function clientRowMs(rows: SubsystemBudgetMs, client: ComputeBudgetClient): number {
  return rows[client];
}

/** Sum of every compute row: the cap the meter enforces. */
export function computeBudgetCapMs(rows: SubsystemBudgetMs, scale = 1): number {
  const total = COMPUTE_BUDGET_CLIENTS.reduce(
    (sum, client) => sum + clientRowMs(rows, client),
    0,
  );
  return total * Math.max(0, Math.min(1, scale));
}

/**
 * Admit dispatches in priority order under one cap.
 *
 * Two passes, and the two-pass shape is the point:
 *
 *  1. **Reservation.** Each client, in priority order, may take up to its own
 *     `FRAME_BUDGET_MS` row. This is what stops a burst of terrain pages from
 *     starving the occlusion bake for a whole banked turn — the published
 *     per-row caps still mean something.
 *  2. **Surplus.** Whatever the cap has left is offered in priority order, so
 *     an idle erosion frame lets terrain generation run ahead.
 *
 * A dispatch is admitted whole or not at all: half a page bake is not a
 * cheaper page bake.
 */
export function planComputeAdmissions(
  requests: readonly ComputeDispatchRequest[],
  rows: SubsystemBudgetMs,
  scale = 1,
  committed: readonly ComputeAdmission[] = [],
): ComputeAdmissionPlan {
  const capMs = computeBudgetCapMs(rows, scale);
  const settled = new Map<ComputeBudgetClient, ComputeAdmission>();
  for (const entry of committed) settled.set(entry.client, entry);
  const demand = new Map<ComputeBudgetClient, { count: number; costMs: number }>();
  for (const request of requests) {
    if (settled.has(request.client)) continue;
    if (!Number.isFinite(request.costMs) || request.costMs < 0) {
      throw new RangeError(`Compute cost for ${request.client} must be finite and non-negative`);
    }
    if (!Number.isInteger(request.count) || request.count < 0) {
      throw new RangeError(`Compute dispatch count for ${request.client} must be a whole number`);
    }
    const existing = demand.get(request.client);
    if (existing) {
      // Merge at the more expensive estimate: two producers of the same
      // client must not average away the worse one.
      existing.count += request.count;
      existing.costMs = Math.max(existing.costMs, request.costMs);
    } else {
      demand.set(request.client, { count: request.count, costMs: request.costMs });
    }
  }

  const admitted = new Map<ComputeBudgetClient, number>();
  const spentPerClient = new Map<ComputeBudgetClient, number>();
  // `6-9`: a client whose admission has already been READ is settled — its
  // dispatches are encoded and its spend is a fact. It is excluded from both
  // passes and its milliseconds are charged to the cap up front, so a later
  // client's demand competes for what is genuinely left rather than
  // re-opening a decision the renderer has already acted on.
  let spentMs = 0;
  for (const entry of settled.values()) spentMs += entry.admittedMs;

  const take = (client: ComputeBudgetClient, ceilingMs: number): void => {
    const entry = demand.get(client);
    if (!entry || entry.costMs <= 0) {
      if (entry && entry.costMs <= 0) {
        // A zero-cost dispatch is free; admitting it costs nothing and
        // refusing it would deadlock a producer whose estimate has not warmed.
        //
        // ACCUMULATE, never assign. `take` is called TWICE per client — once
        // in the reservation pass and once in the surplus pass — and the first
        // call zeroes `entry.count` after banking it. Assigning `entry.count`
        // on the second call therefore wrote back 0 and silently un-admitted
        // the client, which is the exact absorbing state the branch above
        // exists to prevent: a cold-estimate producer would be refused every
        // frame, observe no cost, never warm its estimate, and never run.
        // Found by the `6-11` admission audit; `render.webgpu-compute-
        // starvation.test.ts` pins it at every tier.
        admitted.set(client, (admitted.get(client) ?? 0) + entry.count);
        entry.count = 0;
      }
      return;
    }
    let taken = admitted.get(client) ?? 0;
    let spentHere = spentPerClient.get(client) ?? 0;
    while (
      entry.count > 0
      && spentHere + entry.costMs <= ceilingMs + 1e-9
      && spentMs + entry.costMs <= capMs + 1e-9
    ) {
      entry.count -= 1;
      taken += 1;
      spentHere += entry.costMs;
      spentMs += entry.costMs;
    }
    admitted.set(client, taken);
    spentPerClient.set(client, spentHere);
  };

  for (const client of COMPUTE_BUDGET_CLIENTS) {
    if (settled.has(client)) continue;
    take(client, clientRowMs(rows, client));
  }
  // Surplus pass: the ceiling is the whole cap, so priority alone decides.
  for (const client of COMPUTE_BUDGET_CLIENTS) {
    if (settled.has(client)) continue;
    take(client, capMs);
  }

  // ---------------------------------------------------------------------
  // `4.5-B2(b)` — the floor of one.
  //
  // The compute ladder's stated intent is that deferring a page bake by a
  // frame is invisible. What was actually happening at `computeBudgetScale`
  // 0.35 (Governor B GPU rung 2) was that the HIGHEST-priority client admitted
  // zero dispatches forever while the lower-priority occlusion client still
  // admitted two — a priority inversion, and terrain streaming stopped for the
  // rest of the session. Once a client is starved to zero it never observes a
  // cost, so its estimate never falls and it never recovers: the state is
  // absorbing.
  //
  // So the highest-priority client with demand always gets one dispatch. It
  // lives INSIDE the owner rather than as a pump-side bypass, so everything is
  // still admitted through `ComputeBudget` (the `4-0b` invariant survives).
  // The consequence, stated because Phase 5's unwritten assertion 105 has to
  // be authored for it: the cap can be exceeded by exactly one dispatch.
  // ---------------------------------------------------------------------
  for (const client of COMPUTE_BUDGET_CLIENTS) {
    // A settled client already had its own floor applied in the plan it was
    // read from; skipping rather than breaking hands the floor to the highest
    // priority client still being decided.
    if (settled.has(client)) continue;
    const entry = demand.get(client);
    if (!entry) continue;
    if ((admitted.get(client) ?? 0) > 0 || entry.count <= 0) break;
    entry.count -= 1;
    admitted.set(client, 1);
    spentPerClient.set(client, (spentPerClient.get(client) ?? 0) + entry.costMs);
    spentMs += entry.costMs;
    break;
  }

  let deferredDispatches = 0;
  const admissions: ComputeAdmission[] = [...settled.values()];
  for (const [client, entry] of demand) {
    const count = admitted.get(client) ?? 0;
    const requested = count + entry.count;
    deferredDispatches += entry.count;
    admissions.push({
      client,
      requested,
      admitted: count,
      admittedMs: spentPerClient.get(client) ?? 0,
    });
  }
  admissions.sort(
    (first, second) =>
      COMPUTE_BUDGET_CLIENTS.indexOf(first.client) - COMPUTE_BUDGET_CLIENTS.indexOf(second.client),
  );
  return Object.freeze({ capMs, spentMs, admissions, deferredDispatches });
}

/** How quickly a measured dispatch cost replaces the running estimate. */
const COST_ESTIMATE_SMOOTHING = 0.25;

/**
 * `4.5-B2(a)` — the seed each client's PER-DISPATCH estimate starts at, in
 * milliseconds, before any measurement exists.
 *
 * These used to be seeded at the client's whole per-frame BUDGET ROW, on the
 * reasoning that "before any measurement exists, the budget table IS the best
 * estimate available". It is not: a row is what a client may spend across a
 * whole frame and an estimate is what ONE dispatch costs. Combined with
 * `observeDispatchCostMs` having had zero call sites, that seed was the whole
 * of the admission-starvation defect.
 *
 * Measured on the reference adapter through `timestamp-query` by
 * `tests/gpu/terrain-compute-cost.test.ts`, which re-measures and fails if a
 * pinned value drifts more than 4x. One figure per client rather than per
 * tier: a dispatch's cost is set by the page geometry, which takes no tier
 * argument. Observed across four runs on the same adapter — 1.16-1.91 for
 * terrain, 0.19-0.30 for occlusion, 0.10-0.39 for splat — which is why the
 * band is wide and the seeds sit at the conservative end.
 *
 * **The measurement is bigger than the budget row, and that is the finding.**
 * One height page costs ~1.9 ms of GPU (264² texels × 4× supersampling through
 * the ~750-line kernel), against a 0.7 ms tier-1 `terrainCompute` row and a
 * 1.55 ms whole-compute cap. So NO height page can ever be admitted through
 * the normal two-pass plan, at any tier, and the `4.5-B2(b)` floor of one is
 * not a corner-case safety net — it is the terrain client's only admission
 * path until either the kernel gets cheaper or the meter learns to amortise a
 * dispatch across frames. Both are recorded in `PHASE_4_5_EXECUTION_PLAN.md`
 * §10 as inputs to Phase 5/6; neither is attempted here, because the floor
 * already delivers ~1 page per pump and 25 pages is a 0.4 s cold spawn.
 */
export const COMPUTE_DISPATCH_SEED_COST_MS: Readonly<Record<ComputeBudgetClient, number>> =
  Object.freeze({
    // Measured 1.91 ms/page at L3 (four supersamples). L0 takes one sample and
    // is ~4x cheaper; the running estimate tracks whatever mix is streaming.
    terrainCompute: 1.9,
    // Measured 0.385 ms/page: the classifier over 136² channel texels, twice
    // (both resident season buckets).
    splatCompute: 0.4,
    // Measured 0.301 ms/page: 16 azimuths × 24 steps over 136² texels.
    occlusionCompute: 0.3,
    // `W-1d` / `W-4`: the stage table's weighted dispatch is 0.229 ms for the
    // multi-frame page-erosion DAG at the 384² scratch — 37.4 ms of GPU over
    // 163 dispatches (48 seed bands, 16 geology bands, 2 breach, 1 decode, 24
    // stream-power, 64 talus, 8 fine-band). This client seed rounds that up to
    // 0.24 ms. The producer prices each SUBMIT at its current stage's own
    // measured figure (TERRAIN_EROSION_STAGE_SEED_COST_MS, next to the
    // shaders); this client-level number is what the meter reports before the
    // producer's first submit and what the CPU-worker fallback path books
    // against.
    // Re-measured by the concentrated complete-page and grouped one-sided
    // guards in tests/gpu/terrain-page-erosion-cost.test.ts.
    erosionCompute: 0.24,
    // `6-9`, measured: 0.047-0.096 ms is ONE ring's placement dispatch at
    // tier 1 on the reference adapter (107,592 lanes across the three rings,
    // 64-lane workgroups, the composed archetype law and the compaction
    // atomics included), converged through the meter's own smoothing over
    // ~50 frames and observed across three runs on the same adapter under
    // load. The band is wide for the same reason the terrain seeds' is: a
    // dispatch this short has a genuinely noisy timestamp counter.
    // The field submits one dispatch per ring per frame — three at every tier
    // — so this is a per-RING figure and the frame's demand is three of them,
    // 0.14-0.29 ms against the 0.18 ms tier-1 `groundCoverCompute` row. The
    // row is deliberately not sized for the noisy upper end: exceeding it
    // costs a DEFERRED outer ring, which keeps last frame's records on
    // world-anchored ground and is the graceful degradation this client was
    // put last in the priority order to get. Seeded
    // deliberately above the measurement so a cold frame under-admits rather
    // than over-spends, and re-measured with a 4x drift alarm by
    // tests/gpu/ground-cover-compute.test.ts. The running estimate replaces
    // it from the dispatch's own timestamp counter — GroundCoverSystem is in
    // the timing policy's TIMED_ON_PURPOSE list precisely because this meter
    // consumes it.
    groundCoverCompute: 0.06,
  });

/**
 * The live meter: per-frame admission plus a running per-client cost estimate
 * fed by whatever timing the renderer can actually observe.
 *
 * Producers do not measure themselves into compliance — they DECLARE a demand
 * (`submit`), the meter answers once (`resolve`), and the producers dispatch
 * only what came back. That ordering is what makes the cap a cap rather than a
 * post-hoc report.
 */
export class ComputeBudget {
  private rows: SubsystemBudgetMs;
  private scale = 1;
  private readonly pending: ComputeDispatchRequest[] = [];
  private readonly costEstimateMs = new Map<ComputeBudgetClient, number>();
  private plan: ComputeAdmissionPlan | null = null;
  /**
   * `6-9`: clients whose admission has already been READ this frame.
   *
   * The renderer's producers do not all declare before any of them reads:
   * `TerrainClipmapSystem.pumpComputeClients` declares and reads inside
   * `terrain.update`, and the per-frame ground-cover field runs afterwards.
   * A late `submit` invalidates the cached plan, and a re-plan that could
   * move an admission the renderer has ALREADY dispatched against would make
   * the meter's answer a fiction. Reading an admission therefore settles it:
   * its dispatch count is fixed for the frame and its milliseconds are
   * charged to the cap, so a later client competes for what is left.
   */
  private readonly settled = new Map<ComputeBudgetClient, ComputeAdmission>();

  /**
   * Takes the PROFILE, not a tier, so the tier read stays inside `core/` where
   * the budget tables live — the boundary rule, not a stylistic choice.
   */
  constructor(profile: WebGpuQualityProfile) {
    this.rows = FRAME_BUDGET_MS[profile.tier as PerformanceTier];
    for (const client of COMPUTE_BUDGET_CLIENTS) {
      // `4.5-B2(a)`: a measured PER-DISPATCH constant, never the per-frame row.
      // See COMPUTE_DISPATCH_SEED_COST_MS.
      this.costEstimateMs.set(client, COMPUTE_DISPATCH_SEED_COST_MS[client]);
    }
  }

  setProfile(profile: WebGpuQualityProfile): void {
    this.rows = FRAME_BUDGET_MS[profile.tier as PerformanceTier];
  }

  /**
   * Governor B rung 0. Shrinking the compute cap is the FIRST thing the GPU
   * ladder does, before cloud-shadow cadence, shadow-caster distance or
   * vegetation distance — none of which the pilot can fail to notice.
   */
  setBudgetScale(scale: number): void {
    this.scale = Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : 1;
  }

  get budgetScale(): number {
    return this.scale;
  }

  get capMs(): number {
    return computeBudgetCapMs(this.rows, this.scale);
  }

  /** The running per-dispatch estimate a client's demand is priced at. */
  estimatedCostMs(client: ComputeBudgetClient): number {
    return this.costEstimateMs.get(client) ?? 0;
  }

  /**
   * Feed back a MEASURED per-dispatch cost. Exponentially smoothed, because a
   * single slow dispatch (a shader compile, a stall behind an unrelated pass)
   * must not permanently reprice a client.
   */
  observeDispatchCostMs(client: ComputeBudgetClient, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    const previous = this.costEstimateMs.get(client) ?? milliseconds;
    this.costEstimateMs.set(
      client,
      previous + (milliseconds - previous) * COST_ESTIMATE_SMOOTHING,
    );
  }

  beginFrame(): void {
    this.pending.length = 0;
    this.plan = null;
    this.settled.clear();
  }

  /**
   * Declare a demand for this frame. Priced at the client's running estimate.
   *
   * A client that has already been READ this frame is settled: its demand is
   * ignored rather than re-planned, because the renderer has acted on the
   * answer it was given.
   */
  submit(client: ComputeBudgetClient, count: number, costMs = this.estimatedCostMs(client)): void {
    if (count <= 0 || this.settled.has(client)) return;
    this.pending.push({ client, count: Math.floor(count), costMs });
    this.plan = null;
  }

  /** Resolve every submitted demand at once. Idempotent within a frame. */
  resolve(): ComputeAdmissionPlan {
    this.plan ??= planComputeAdmissions(
      this.pending,
      this.rows,
      this.scale,
      [...this.settled.values()],
    );
    return this.plan;
  }

  /** Dispatches this frame's plan admits for a client. Settles the client. */
  admitted(client: ComputeBudgetClient): number {
    const entry = this.resolve().admissions.find((row) => row.client === client);
    if (entry && !this.settled.has(client)) this.settled.set(client, entry);
    return entry?.admitted ?? 0;
  }
}
