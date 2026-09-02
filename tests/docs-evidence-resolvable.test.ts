import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A document citing a capture frame as EVIDENCE must cite an IMMUTABLE one.
 *
 * **The problem is not that files go missing. It is that they come back
 * different.** `tests/perf/artifacts/<shot>.png` is a single fixed path that
 * every capture run overwrites (`ARTIFACT_DIR` in the driver). So a citation to
 * it does not name a frame — it names "whatever was captured most recently".
 *
 * **Measured, and this is why it matters:** `RESOLUTION_PLAN.md` cites
 * `tests/perf/artifacts/cdlod-transition.png` for *"cyan rectangles over a
 * headland"*. That path resolves today, and the frame at it is a clean
 * coastline from a later run. **A reader following the citation sees no defect
 * and concludes the report was wrong.** A missing file at least announces
 * itself; this one answers confidently in the negative.
 *
 * **Immutable places to cite instead:** `tests/perf/baseline/<shot>.png`, which
 * is committed and changes only by review, or a timestamped
 * `tests/perf/artifacts/rebaseline-candidates/<ISO>/` directory, which no later
 * run reuses.
 *
 * **Population is DOCUMENT prose, not code.** A test naming
 * `tests/perf/artifacts/jet-preview.png` is declaring its own output path;
 * demanding immutability there would be wrong.
 */

/** Mutable-path citations that predate this rule, each with what now carries the claim. */
const DECLARED_STALE_CITATIONS: readonly (readonly [string, string])[] = [
  ["RESOLUTION_PLAN.md",
    "A-1/A-2/A-3 cite four fixed artifact paths. The frames they described have "
    + "been overwritten by later runs — the files resolve and show clean scenes. "
    + "A-1's claim is now carried by the COMMITTED baseline "
    + "tests/perf/baseline/coast-10km-lowsun.png, which still exhibits the "
    + "artifact and is immutable by review. Do not 'fix' these citations by "
    + "regenerating: a fresh capture is a different frame and cannot support a "
    + "claim made about the original."],
];

function docCitations(): { path: string; doc: string; pinned: boolean }[] {
  const docs = execFileSync("git", ["ls-files", "*.md", "docs/*.md"], { cwd: ROOT })
    .toString().split("\n").filter(Boolean);
  const out: { path: string; doc: string; pinned: boolean }[] = [];
  for (const doc of docs) {
    const lines = readFileSync(join(ROOT, doc), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/tests\/perf\/artifacts\/[A-Za-z0-9._/-]+\.(?:png|json)/gu)) {
        // PHASE_4_5's pattern: name the mutable path only to say why it is NOT
        // the source, and pin the real evidence in docs/evidence/. A mention
        // accompanied by a pin is the CORRECT form, not an offence — the guard
        // must not punish the one document that already does this right.
        const context = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
        out.push({ path: m[0], doc, pinned: context.includes("docs/evidence/") });
      }
    });
  }
  return out;
}

/** A path no later run reuses: a timestamped candidate directory. */
const isImmutable = (p: string): boolean => /\/rebaseline-candidates\/[^/]+\//u.test(p);

describe("evidence cited by documents is immutable", () => {
  it("finds citations at all", () => {
    // Non-vacuity: a regex that stops matching makes this whole file green.
    expect(docCitations().length, "no artifact citations found — the scan is broken")
      .toBeGreaterThan(0);
  });

  it("cites no mutable artifact path as evidence", () => {
    const declared = new Set(DECLARED_STALE_CITATIONS.map(([doc]) => doc));
    const offenders = [...new Set(
      docCitations()
        .filter(({ path }) => !isImmutable(path))
        .filter(({ pinned }) => !pinned)
        .filter(({ doc }) => !declared.has(doc))
        .map(({ doc, path }) => `${doc} cites ${path}`),
    )];
    expect(
      offenders,
      "A document cites tests/perf/artifacts/<name>, which EVERY capture run "
      + "overwrites. THE QUESTION IS NOT HOW TO MAKE THIS GREEN. Cite something "
      + "that cannot change under the reader. THE PROJECT ALREADY HAS THIS "
      + "PATTERN and exactly one document uses it: PHASE_4_5_EXECUTION_PLAN.md "
      + "pins its numbers at docs/evidence/<name>-<ISO>.json and names the "
      + "mutable path only to explain why it is not the source. Copy that: pin "
      + "into docs/evidence/, or cite tests/perf/baseline/<shot>.png (committed, "
      + "changes only by review) or a timestamped rebaseline-candidates/<ISO>/. If the frame you meant is gone, "
      + "add the document to DECLARED_STALE_CITATIONS and say what now carries "
      + "the claim — a citation that resolves to the wrong frame is worse than "
      + "one that fails, because it answers confidently.",
    ).toEqual([]);
  });

  it("declares no document that has stopped citing mutable paths", () => {
    const offending = new Set(docCitations()
      .filter((c) => !isImmutable(c.path) && !c.pinned).map(({ doc }) => doc));
    for (const [doc] of DECLARED_STALE_CITATIONS) {
      expect(offending.has(doc), `${doc} no longer cites a mutable path — remove its declaration`)
        .toBe(true);
    }
  });
});
