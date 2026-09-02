import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";

/**
 * Every system that CAN be rebased must actually BE rebased.
 *
 * **The failure this prevents is silent and total.** The renderer shifts the
 * world origin every 4,096 m flown (`FLOATING_ORIGIN_THRESHOLD`). A system that
 * declares `setFloatingOrigin` but is never called on the rebase path keeps its
 * geometry in absolute coordinates while the camera moves to origin-relative
 * ones — so it does not drift a little, it leaves the frustum entirely. For a
 * clustered light it is worse than invisible: the inverse-square falloff reads
 * the position, so **it lights the wrong place** rather than merely drawing in
 * it.
 *
 * **This is a call-site guard, and it exists because a capability test cannot
 * cover this.** `setFloatingOrigin` has unit tests proving it moves what it is
 * asked to move; every one of them passes on a system the renderer never calls.
 * The gap is not in the law, it is in the wiring — the same shape as a windsock
 * that reads the aircraft's wind and points convincingly, and as `buildHangar`
 * parenting onto a root it is handed while nothing checks that anyone hands it
 * one.
 *
 * ---------------------------------------------------------------------------
 * **THREE RENDERER BINDINGS AUDITED AND DELIBERATELY LEFT UNGUARDED.** Recorded
 * here rather than in a message, so the next author of those files reads it:
 *
 *  - **`setAerialPerspective`, 10 call sites.** The strongest candidate by
 *    count — most sites, most chance one is missed — and NOT guarded because it
 *    was mid-flight on the dusk arch when this was written. A guard landing
 *    under the thing most likely to change is a collision, not coverage.
 *  - **`setColors`, 1 site.** Harder than it looks: it fires only on a PAPI
 *    indication TRANSITION, so a useful guard must assert the *condition*, not
 *    the call. A guard asserting the wrong one is worse than none, because it
 *    reads as coverage.
 *  - **`setCameraPosition`, 1 site.** One site, low severity.
 *
 * Severity is why `setFloatingOrigin` was the one taken: the others degrade a
 * frame, and an unrebased system leaves it.
 *
 * **No gap today** — all six declaring systems are called, and all six inside
 * `updateFloatingOrigin` rather than only at construction. Verified before this
 * file was written, so the guard is preventive on a measured baseline rather
 * than hopeful on an assumed one. It catches `7-14` and `7-15` by arithmetic
 * rather than by someone noticing an airfield 4 km away in a frame.
 */

const RENDERER = "src/render/FlightRenderer.ts";

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Files declaring a `setFloatingOrigin` method — derived, never listed. */
function declaringFiles(): string[] {
  return sourceFiles("src/render")
    .filter((file) => file !== RENDERER)
    .filter((file) => /^\s{2}setFloatingOrigin\s*\(/m.test(readSource(file)));
}

/** Distinct `this.x.setFloatingOrigin` receivers inside the rebase method. */
function rebasedReceivers(): string[] {
  const source = readSource(RENDERER);
  const start = source.indexOf("private updateFloatingOrigin(");
  expect(start, `${RENDERER} has no updateFloatingOrigin`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  private ", start + 10);
  const body = source.slice(start, end === -1 ? undefined : end);
  return [...new Set(
    [...body.matchAll(/this\.([A-Za-z]+)\??\.setFloatingOrigin/g)].map((m) => m[1]!),
  )].sort();
}

describe("floating-origin coverage", () => {
  it("finds the systems and the call sites at all", () => {
    // Non-vacuity first: both scans below are regex over source, and a regex
    // that silently matches nothing turns every assertion here into a tautology
    // over empty sets — which is the exact failure this file is guarding
    // against, one level up.
    expect(declaringFiles().length, "no system declares setFloatingOrigin — the scan is broken")
      .toBeGreaterThanOrEqual(6);
    expect(rebasedReceivers().length, "no rebase calls found — the scan is broken")
      .toBeGreaterThanOrEqual(6);
  });

  it("rebases exactly as many systems as declare the method", () => {
    const declaring = declaringFiles();
    const rebased = rebasedReceivers();
    expect(
      rebased.length,
      `${declaring.length} system(s) declare setFloatingOrigin but ${rebased.length} `
      + `are rebased. Declaring: ${declaring.map((f) => f.split("/").pop()).join(", ")}. `
      + `Rebased: ${rebased.join(", ")}. A system that declares the method and is `
      + "not called does not drift — it leaves the frustum entirely at the first "
      + "rebase, and a clustered light LIGHTS the wrong place because the falloff "
      + "reads the position. Wire it in updateFloatingOrigin.",
    ).toBe(declaring.length);
  });

  it("rebases on the rebase path, not only at construction", () => {
    // The subtler version: a system initialised once with (0, 0) and never
    // called again looks wired and is not. Every receiver called anywhere in
    // the renderer must also be called inside `updateFloatingOrigin`.
    const source = readSource(RENDERER);
    const everywhere = [...new Set(
      [...source.matchAll(/this\.([A-Za-z]+)\??\.setFloatingOrigin/g)].map((m) => m[1]!),
    )].sort();
    const rebased = rebasedReceivers();
    const initialisedOnly = everywhere.filter((name) => !rebased.includes(name));
    expect(
      initialisedOnly,
      "these are given an origin somewhere but never on the rebase path, so they "
      + "hold their construction-time origin forever",
    ).toEqual([]);
  });
});
