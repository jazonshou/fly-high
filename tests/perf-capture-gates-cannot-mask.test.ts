/**
 * No gate in the capture harness may abort the gates behind it.
 *
 * **THIS EXACT DEFECT HAS SHIPPED TWICE.** The per-shot gate body in
 * `tests/perf/perf-capture.test.ts` is wrapped in one `try`/`catch` that
 * collects failures into `gateFailures`. A **bare** `expect()` inside it throws,
 * is caught, and **silently skips every remaining gate for that shot** — which
 * still fails the run, but on one message, with the rest unevaluated and
 * indistinguishable from passing.
 *
 * The first time, a wall-clock miss on a loaded host hid a **495.9-against-495
 * MiB breach on `reference-viewport`**. `gateDelivery` was introduced to fix it,
 * and its docblock records the lesson — *"a non-aborting gate cannot mask
 * anything regardless of where it sits."*
 *
 * **It was then applied to a subset.** Twenty bare `expect()` calls remained.
 * On 2026-09-02 the draw-call gate (262 against a 156 ceiling) was aborting
 * every gate behind it, including the estimate re-pin trigger that had been
 * landed *deliberately failing* and had therefore **never executed once**.
 *
 * **A documented fix applied to a subset is worse than an undocumented one,
 * because the docblock then certifies a property the file does not have.** This
 * guard exists so the twenty-first call site cannot recreate it.
 *
 * **Why it reads source rather than behaviour:** the harness needs a GPU and a
 * real frame, so the Node suite cannot execute it. The property is structural —
 * *is this `expect` wrapped* — and structure is legible in the text.
 *
 * **Comments are stripped.** A guard about a masking defect, matching the
 * docblock that explains the masking defect, is the joke this project cannot
 * afford twice.
 *
 * **TWO WRAPPERS, AND THEY ARE NOT INTERCHANGEABLE.** `gateDelivery` is
 * non-aborting AND host-conditional — its failures become notes on an unpinned
 * host. `gateAlways` is non-aborting and always enforced. The first conversion
 * attempt used `gateDelivery` for all twenty, which would have made the
 * draw-call ceiling and the inventoried-memory check waivable on any unpinned
 * host; `perf-capture-policy.test.ts` caught it. **This guard therefore accepts
 * either wrapper — its subject is masking — and the policy test owns which of
 * the two is correct for a given gate.** Splitting the responsibility that way
 * keeps this one from having an opinion it cannot defend.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readSource } from "./support/sourceText";

const HARNESS = resolve(__dirname, "perf/perf-capture.test.ts");

/**
 * The per-shot gate region, located by ANCHOR rather than by line number.
 *
 * My first attempt at this located the wrong `try` — it matched an earlier one
 * at the same indent and reported "0 bare" over a three-line block that
 * contained no gates at all. **A clean answer from the wrong region is
 * indistinguishable from a clean answer.** So the anchor is the one thing only
 * this block has: a `catch` whose body pushes to `gateFailures`.
 */
function perShotGateRegion(source: string): { body: string; lines: number } {
  const lines = source.split("\n");
  const catchIndex = lines.findIndex(
    (line, i) => /\}\s*catch\s*\(/.test(line) && /gateFailures\.push/.test(lines[i + 1] ?? ""),
  );
  if (catchIndex < 0) return { body: "", lines: 0 };
  const indent = (/^\s*/.exec(lines[catchIndex]!) ?? [""])[0];
  let tryIndex = -1;
  for (let i = catchIndex; i >= 0; i -= 1) {
    if (lines[i] === `${indent}try {`) { tryIndex = i; break; }
  }
  if (tryIndex < 0) return { body: "", lines: 0 };
  return { body: lines.slice(tryIndex, catchIndex).join("\n"), lines: catchIndex - tryIndex };
}

describe("capture gates cannot mask the gates behind them", () => {
  const source = readSource(HARNESS);
  const region = perShotGateRegion(source);

  it("FINDS the per-shot gate region — every assertion below is vacuous without it", () => {
    // NON-VACUITY. A missing region yields an empty body, and "no bare expect in
    // an empty string" is true and worthless. This is the leg that fails if the
    // harness is restructured and the anchor stops matching, which is exactly
    // when a silent pass would be most expensive.
    expect(region.lines).toBeGreaterThan(100);
    expect(region.body).toContain("gateAlways(");
    expect(region.body).toContain("shot.drawCalls");
  });

  it("wraps every expect in gateDelivery, so none can abort the rest", () => {
    const bare = region.body
      .split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^\s*expect\(/.test(line))
      .map(({ i }) => i + 1);

    expect(
      bare,
      "bare expect() inside the per-shot gate try — each one silently skips every "
      + "gate after it for that shot.\n"
      + "WRAP IT IN gateAlways(() => expect(...)), NOT gateDelivery. The two are "
      + "not interchangeable: gateDelivery is ALSO host-conditional, so using it "
      + "here would relax a deterministic gate as well as stop it aborting — which "
      + "is what perf-capture-policy's \"must hold on every host\" list forbids.\n"
      + "NOTE: the closure loses TypeScript's narrowing from an enclosing guard, so "
      + "hoist the narrowed value into a const first (see clipCeiling, drawCeiling).",
    ).toEqual([]);
  });

  it("PROVES the detector can see a bare expect, on a synthetic violator", () => {
    // Without this, the assertion above is "an empty list is empty" and a
    // regex that matched nothing would look identical to a clean harness.
    const violator = [
      "      try {",
      "        gateDelivery(() => expect(a).toBe(1));",
      "        expect(b).toBe(2);",
      "      } catch (error) {",
      "        gateFailures.push(String(error));",
    ].join("\n");
    const found = perShotGateRegion(violator);
    expect(found.lines).toBeGreaterThan(0);
    const bare = found.body.split("\n").filter((l) => /^\s*expect\(/.test(l));
    expect(bare).toHaveLength(1);
  });
});
