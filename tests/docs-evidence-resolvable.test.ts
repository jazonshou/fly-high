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
 * **Measured, and this is why it matters:** `RESOLUTION_PLAN.md` (since removed) cited
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
// RESOLUTION_PLAN.md, the one declared document, was removed with the other
// finished-work plans (see docs/ARCHIVE.md). Declare a document here only with
// what now carries its claim.
const DECLARED_STALE_CITATIONS: readonly (readonly [string, string])[] = [];

function docCitations(): { path: string; doc: string; pinned: boolean }[] {
  const docs = execFileSync("git", ["ls-files", "*.md", "docs/*.md"], { cwd: ROOT })
    .toString().split("\n").filter(Boolean);
  const out: { path: string; doc: string; pinned: boolean }[] = [];
  for (const doc of docs) {
    const lines = readFileSync(join(ROOT, doc), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/tests\/perf\/artifacts\/[A-Za-z0-9._/-]+\.(?:png|json)/gu)) {
        // The pinned pattern: name the mutable path only to say why it is NOT
        // the source, and pin the real evidence in docs/evidence/. A mention
        // accompanied by a pin is the CORRECT form, not an offence — the guard
        // must not punish a document that does this right.
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
      + "that cannot change under the reader: pin the numbers at "
      + "docs/evidence/<name>-<ISO>.json and name the mutable path only to "
      + "explain why it is not the source. So: pin "
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
