import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";
import { VEGETATION_DRAW_CEILING } from "../src/render/webgpu/detail/renderedDensity";
import { PERF_CAPTURE_SHOTS } from "../scripts/perf-capture.mts";
import { readSource } from "./support/sourceText";

/**
 * `6-12` — the documentation truth pass, and the pin that makes it one.
 *
 * **Why this file exists.** Phase 6's central finding, earned three separate
 * ways, is that *a hand-maintained list or figure asserted only against a limit
 * — never against the thing it models — is decorative*. It passes forever while
 * drifting arbitrarily far from reality, and every number quoted from it
 * inherits the drift. `6-12` corrected a batch of stale documentation; without
 * this file that correction would itself be decorative, because prose has no
 * compiler and nothing would notice it going stale again.
 *
 * **The stronger half of the rule is why the tests below compare rather than
 * merely check shape:** a decorative claim has no immune response to
 * REGRESSION either. A doc table nothing asserts against can be un-fixed by an
 * ordinary merge the day after it is corrected, in total silence. Deriving the
 * expected values from the artifact is what protects the fix, not just what
 * finds the bug.
 *
 * So every expectation here reads **code** and compares it to **prose**. None
 * of them checks that a table is tidy, well-formed, or internally consistent —
 * those are the checks that let `TERRAIN_SAMPLED_BINDINGS` drift in both
 * directions for months while passing.
 *
 * **These tests are deliberately allowed to be annoying.** Changing a shipped
 * tier value turns them red, and the fix is to update the documentation in the
 * same commit. That is the entire point: the cost of the red test is the cost
 * of keeping the docs true, paid at the moment the author still knows why.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERFORMANCE_MD = readSource(join(REPO_ROOT, "docs/PERFORMANCE.md"));
const RENDERING_PLAN_MD = readSource(join(REPO_ROOT, "RENDERING_PLAN.md"));
const BASELINE_DIR = join(REPO_ROOT, "tests/perf/baseline");

/** The (quality, mode) pair resolving to each tier — `QUALITY_WEIGHT + MODE_WEIGHT`. */
const TIER_INPUTS: readonly (readonly [QualityLevel, RenderingMode])[] = [
  ["low", "balanced"],
  ["medium", "balanced"],
  ["high", "balanced"],
  ["high", "ultra"],
];

const PROFILES = TIER_INPUTS.map(([quality, mode]) => resolveWebGpuQualityProfile(quality, mode));

/**
 * Pull the four tier cells out of the markdown row whose label cell contains
 * `label`. Throws rather than returning null when the row is missing: a doc
 * table that lost the row it is being checked against must fail loudly, not
 * silently pass with nothing to compare. (That vacuity is failure mode #4 in
 * the family this phase catalogued.)
 */
function tierRow(markdown: string, label: string): number[] {
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith("|") && line.split("|")[1]?.includes(label));
  if (row === undefined) {
    throw new Error(
      `docs-truth: no table row whose label contains ${JSON.stringify(label)}. `
        + "The row was renamed or deleted — update this test WITH the doc, not instead of it.",
    );
  }
  const cells = row
    .split("|")
    .slice(2, 6)
    .map((cell) => cell.replace(/,/gu, "").trim());
  const numbers = cells.map((cell) => {
    const match = /-?\d+(?:\.\d+)?/u.exec(cell);
    if (match === null) throw new Error(`docs-truth: cell ${JSON.stringify(cell)} holds no number`);
    return Number.parseFloat(match[0]);
  });
  if (numbers.length !== 4) {
    throw new Error(`docs-truth: row ${JSON.stringify(label)} has ${numbers.length} tier cells, expected 4`);
  }
  return numbers;
}

/**
 * Row labels of the resolved-tier table, walked from its header to the first
 * non-table line. **Filtering for lines starting with "|" runs this table into
 * the next one** — the first cut of this helper did that and collected the shot
 * table's rows as well, which the completeness guard then reported as
 * uncovered.
 */
function tierTableRowLabels(): string[] {
  const lines = PERFORMANCE_MD.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| Budget | Tier 0"));
  if (header === -1) throw new Error("docs-truth: the resolved-tier table header is gone");
  const out: string[] = [];
  for (let i = header + 2; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("|")) break;
    out.push(line.split("|")[1]!.trim());
  }
  return out;
}

/**
 * Pull a TWO-VALUE tier row — cells shaped `144 / 100` — as a pair of arrays.
 *
 * **`tierRow` reads the first number in each cell, which is not a shortcoming
 * until a cell holds two.** Testing the atlas row with it would have been worse
 * than declaring it unverifiable: the first numbers are `144, 196, 256, 256`,
 * which is `heightAtlasSlots` EXACTLY. The row would have passed in perpetuity
 * with `channelAtlasSlots` compared to nothing — and **only tier 1
 * discriminates the two fields**, since tiers 2-4 are `196/196` and `256/256`.
 * One coincidence between a real check and a permanently half-blind one.
 */
function tierRowPair(markdown: string, label: string): [number[], number[]] {
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith("|") && line.split("|")[1]?.includes(label));
  if (row === undefined) {
    throw new Error(
      `docs-truth: no table row whose label contains ${JSON.stringify(label)}. `
        + "The row was renamed or deleted — update this test WITH the doc, not instead of it.",
    );
  }
  const cells = row.split("|").slice(2, 6).map((cell) => cell.replace(/,/gu, "").trim());
  if (cells.length !== 4) {
    throw new Error(`docs-truth: row ${JSON.stringify(label)} has ${cells.length} tier cells, expected 4`);
  }
  const first: number[] = [];
  const second: number[] = [];
  for (const cell of cells) {
    const matches = cell.match(/-?\d+(?:\.\d+)?/gu);
    // EXACTLY two: a cell that quietly becomes single-valued fails loudly
    // rather than reading as "both fields agree".
    if (matches === null || matches.length !== 2) {
      throw new Error(
        `docs-truth: cell ${JSON.stringify(cell)} in row ${JSON.stringify(label)} holds `
          + `${matches?.length ?? 0} numbers, expected exactly 2 (shaped "144 / 100")`,
      );
    }
    first.push(Number.parseFloat(matches[0]!));
    second.push(Number.parseFloat(matches[1]!));
  }
  return [first, second];
}

describe("6-12 documentation truth: docs/PERFORMANCE.md resolved-tier table", () => {
  /**
   * The table's own preamble calls `QualityProfile.ts` "the source of truth —
   * this table is documentation". That sentence was true and unenforced, which
   * is exactly the shape that drifts. Now it is enforced.
   */
  const TIER_ROW_CHECKS: readonly (readonly [string, (p: (typeof PROFILES)[number]) => number])[] = [
    ["MSAA samples", (p: (typeof PROFILES)[number]) => p.msaaSamples],
    ["CDLOD node budget", (p: (typeof PROFILES)[number]) => p.cdlodNodeBudget],
    ["CDLOD split threshold", (p: (typeof PROFILES)[number]) => p.cdlodPixelThreshold],
    ["Finest streamed page level", (p: (typeof PROFILES)[number]) => p.finestResidentLevel],
    ["Height-blend max materials", (p: (typeof PROFILES)[number]) => p.heightBlendMaxMaterials],
    ["Shadow map", (p: (typeof PROFILES)[number]) => p.shadowMapSize],
    ["Shadow cascades", (p: (typeof PROFILES)[number]) => p.shadowCascades],
    ["Initial/internal render-scale ceiling", (p: (typeof PROFILES)[number]) => p.renderScale],
    // Added when the coverage gap below was found: these ten parse cleanly and
    // were all CORRECT at the time, so nothing here fixes a drift — they close
    // the distance between what this block checks and what the table publishes.
    ["Terrain material array edge", (p: (typeof PROFILES)[number]) => p.materialArrayEdge],
    ["Ocean FFT resolution per cascade", (p: (typeof PROFILES)[number]) => p.oceanResolution],
    ["Active ocean cascades", (p: (typeof PROFILES)[number]) => p.oceanCascades],
    ["Cloud resolution-scale", (p: (typeof PROFILES)[number]) => p.cloudResolutionScale],
    ["Requested cloud primary steps", (p: (typeof PROFILES)[number]) => p.cloudPrimarySteps],
    ["Cloud light-step", (p: (typeof PROFILES)[number]) => p.cloudLightSteps],
    ["Active-animal budget", (p: (typeof PROFILES)[number]) => p.activeAnimalBudget],
    ["Frame target", (p: (typeof PROFILES)[number]) => p.frameTargetMs],
    ["Rendered stems/ha", (p: (typeof PROFILES)[number]) => p.renderedDensityLaw.nearStemsPerHectare],
    // The doc writes kilometres and the profile holds metres, so this row needs
    // the scale rather than a second parser.
    ["Vegetation radius", (p: (typeof PROFILES)[number]) => p.vegetationDistance / 1000],
  ];

  it.each(TIER_ROW_CHECKS.map((row) => [row[0], row[1]] as const))(
    "row %s matches the shipped profile", (label, read) => {
    expect(
      tierRow(PERFORMANCE_MD, label as string),
      `docs/PERFORMANCE.md's "${label}" row no longer matches QualityProfile.ts. `
        + "Update the doc in this commit — the profile is the authority.",
    ).toEqual(PROFILES.map(read as (p: (typeof PROFILES)[number]) => number));
  });

  /**
   * **A GREEN ON THIS BLOCK MUST MEAN "THE TABLE MATCHES THE PROFILE", NOT
   * "THE ROWS SOMEBODY LISTED MATCH THE PROFILE".**
   *
   * Until this guard existed the block pinned 9 of the table's 26 rows and
   * nothing anywhere said which 17 were outside it. That is not hypothetical:
   * landing the cascade cut, `docs-truth` failed on exactly two rows, those two
   * were updated, and **the other 24 were never checked** — had any of them gone
   * stale in the same commit the suite would have reported green and the doc
   * would have shipped believed-verified. The population was self-selecting, so
   * its PASS meant something far narrower than any reader takes it to mean.
   *
   * **The row list is derived from the TABLE, never from a roster**, so a row
   * added tomorrow is covered tomorrow — by failing here until someone decides
   * which side it belongs on.
   *
   * **Every unverifiable row carries a REASON, not just a name.** A bare name
   * list decays into a skip list; a reason list forces the next reader to decide
   * whether the reason still holds. Four of the seven below could become
   * checkable with a better parser, and saying so is the point.
   */
  const DECLARED_UNVERIFIABLE: readonly (readonly [string, string])[] = [
    ["Device-pixel-ratio ceiling",
      "No profile field. The ceiling is applied against the live device DPR in "
      + "FlightRenderer, not resolved into the profile, so there is nothing here to compare."],
    ["Terrain triplanar projection",
      "Non-numeric: `planar (slope-stretched)` / `2-axis` / `3-axis`. `tierRow` "
      + "throws on a cell with no number."],
    ["Shadow distance",
      "MIXED UNITS within one row — `900 m | 1.4 km | 1.8 km | 2.4 km` — so a "
      + "single scale factor cannot convert it. Fixable by normalising the doc "
      + "row to metres, which is a doc change and needs its author."],
    ["Vegetation casts shadows",
      "Non-numeric (`no` / `yes`). The field is a boolean; comparing it needs a "
      + "predicate parser rather than a number parser."],
    ["Card-tree LOD radius",
      "No profile field. The near+mid band radius is derived inside the detail "
      + "runtime from renderedDensityLaw, not published as a scalar."],
    ["Vegetation density multiplier",
      "No profile field. It is applied as a governor lever "
      + "(vegetationDistanceScale) rather than resolved per tier."],
  ];

  it("every row of the table is either CHECKED or DECLARED unverifiable with a reason", () => {
    // Stop at the FIRST non-table line. Filtering for "|" first would run this
    // table into the next one — the first attempt did exactly that and picked up
    // rows from the shot table further down the file.
    const rows = tierTableRowLabels();

    // Rows checked by a STANDALONE `it` rather than by the `it.each` roster.
    // These must be named here or the coverage leg reports them uncovered —
    // a manual step that fails LOUDLY, which is why it is not auto-discovered.
    const checkedKeys = [
      ...TIER_ROW_CHECKS.map((row) => row[0]),
      "Absolute pixel cap",
      "Height-atlas slots / channel-atlas slots",
    ];
    const declaredKeys = DECLARED_UNVERIFIABLE.map((row) => row[0]);
    const covered = new Set([...checkedKeys, ...declaredKeys]);
    const uncovered = rows.filter((label) => ![...covered].some((c) => label.includes(c)));

    // EXACTLY one, not at least one. A row that is both checked AND declared
    // unverifiable passes the `uncovered` test above while the file says two
    // contradictory things about it — and that is not hypothetical: the
    // two-number-cell parser makes `Height-atlas slots / channel-atlas slots`
    // checkable, so whoever lands it must drop the declaration in the SAME
    // commit. Without this leg the contradiction would be invisible.
    const both = rows.filter(
      (label) => checkedKeys.some((c) => label.includes(c))
        && declaredKeys.some((d) => label.includes(d)),
    );
    expect(
      both,
      "These rows are BOTH checked against the profile and declared unverifiable. "
      + "A row cannot be both: remove it from DECLARED_UNVERIFIABLE in the same "
      + "commit that adds its check.",
    ).toEqual([]);
    expect(
      uncovered,
      "These rows of docs/PERFORMANCE.md's resolved-tier table are neither checked "
      + "against the profile nor declared unverifiable. A green here would then mean "
      + "\"the listed rows match\", which is not what anyone reads it as. Either add a "
      + "check or add a row to DECLARED_UNVERIFIABLE with the reason it cannot be one.",
    ).toEqual([]);
  });

  it("NON-VACUITY — the row list really was parsed out of the table", () => {
    // If the walk found nothing, `uncovered` is empty and the guard passes while
    // comparing two empty lists — the exact false pass this family exists to
    // make impossible. And an upper bound too: the first attempt ran past the
    // table's end into the next one and collected 32 labels.
    const rows = tierTableRowLabels();
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.length, "the walk ran past the end of the tier table").toBeLessThan(30);
    expect(TIER_ROW_CHECKS.length + DECLARED_UNVERIFIABLE.length).toBeGreaterThan(20);
  });

  it("every declared-unverifiable row carries a real reason", () => {
    for (const [label, reason] of DECLARED_UNVERIFIABLE) {
      expect(reason.length, `${label}: reason too short to be one`).toBeGreaterThan(60);
    }
  });

  it("states the pixel cap in Mpx matching maxRenderPixels", () => {
    expect(tierRow(PERFORMANCE_MD, "Absolute pixel cap")).toEqual(
      PROFILES.map((p) => p.maxRenderPixels / 1_000_000),
    );
  });

  it("states BOTH atlas slot counts matching the shipped profile", () => {
    const [heightSlots, channelSlots] = tierRowPair(
      PERFORMANCE_MD,
      "Height-atlas slots / channel-atlas slots",
    );
    expect(
      heightSlots,
      "docs/PERFORMANCE.md's height-atlas slot counts no longer match QualityProfile.ts.",
    ).toEqual(PROFILES.map((p) => p.heightAtlasSlots));
    expect(
      channelSlots,
      "docs/PERFORMANCE.md's CHANNEL-atlas slot counts no longer match QualityProfile.ts. "
        + "This is the half a first-number-only parser could never see.",
    ).toEqual(PROFILES.map((p) => p.channelAtlasSlots));
  });
});

describe("6-12 documentation truth: RENDERING_PLAN.md §5.3 staleness annotation", () => {
  /**
   * §5.3 is a DESIGN table and is deliberately left as written — it records what
   * the tier decisions were argued against. What must stay true is `6-12`'s
   * annotation naming the rows that no longer ship. If someone changes a shipped
   * value, the annotation becomes wrong in the same way the table already was,
   * so it is pinned to the profile too.
   */
  const annotation = RENDERING_PLAN_MD.slice(
    RENDERING_PLAN_MD.indexOf("### 5.3 Redesigned"),
    RENDERING_PLAN_MD.indexOf("| Parameter | Low |"),
  );

  /** Prose in the annotation is a blockquote and hard-wrapped; compare on flat text. */
  const flattened = annotation.replace(/^>\s?/gmu, "").replace(/\s+/gu, " ");

  /**
   * The annotation is a three-column table (row / published / shipped), so the
   * tier values live inside ONE cell as a slash-separated list rather than in
   * four cells. Parse the LAST cell and take the leading number of each
   * segment — which is the cascade count for the ocean row, and the value
   * itself for the rest.
   */
  function shippedCell(label: string): number[] {
    const row = annotation
      .split("\n")
      .map((line) => line.replace(/^>\s?/u, ""))
      .find((line) => line.startsWith("|") && line.split("|")[1]?.includes(label));
    if (row === undefined) {
      throw new Error(
        `docs-truth: §5.3 annotation has no row for ${JSON.stringify(label)}. `
          + "If the annotation was restructured, update this test WITH it.",
      );
    }
    const cells = row.split("|").filter((cell) => cell.trim().length > 0);
    const last = cells.at(-1);
    if (last === undefined) {
      throw new Error(`docs-truth: §5.3 annotation row ${JSON.stringify(label)} has no cells`);
    }
    const shipped = last.replace(/\*/gu, "");
    return shipped.split("/").map((segment) => {
      const match = /-?\d+(?:\.\d+)?/u.exec(segment);
      if (match === null) throw new Error(`docs-truth: segment ${JSON.stringify(segment)} has no number`);
      return Number.parseFloat(match[0]);
    });
  }

  it("still carries the 6-12 staleness annotation", () => {
    expect(
      flattened,
      "RENDERING_PLAN.md §5.3's 6-12 annotation was removed. The table below it is "
        + "the Phase-4 design, not the shipped profile; without the annotation it reads as current.",
    ).toContain("no longer describe what ships");
  });

  it.each([
    ["msaaSamples", (p: (typeof PROFILES)[number]) => p.msaaSamples],
    ["CDLOD node budget", (p: (typeof PROFILES)[number]) => p.cdlodNodeBudget],
  ])("annotated shipped row %s matches the profile", (label, read) => {
    expect(
      shippedCell(label as string),
      `§5.3's annotation claims a shipped ${label} that QualityProfile.ts contradicts.`,
    ).toEqual(PROFILES.map(read as (p: (typeof PROFILES)[number]) => number));
  });

  it("annotates the ocean row with the shipped cascade counts", () => {
    // Ultra's §5.3 row (cascade 6 + capillary) was never built — tier 3 matches
    // tier 2's ocean, per the tier-3 return in QualityProfile.ts.
    expect(shippedCell("Ocean cascades")).toEqual(PROFILES.map((p) => p.oceanCascades));
    expect(PROFILES.map((p) => p.oceanCascades)).toEqual([3, 4, 5, 5]);
  });
});

describe("6-12 documentation truth: vegetation ceilings", () => {
  it("quotes the live VEGETATION_DRAW_CEILING", () => {
    const quoted = `[${VEGETATION_DRAW_CEILING.join(", ")}]`;
    expect(
      PERFORMANCE_MD,
      `docs/PERFORMANCE.md must quote the current ceiling ${quoted}. `
        + "It previously carried 160/200/500/650, two generations stale.",
    ).toContain(quoted);
  });

  /**
   * `VEGETATION_FRAME_DEBT_RATIO` was deleted from the renderer while four
   * documents went on quoting it, each with a specific four-number tuple no
   * code produced. This is the decorative-list rule's sharpest form: not a list
   * that drifted from its artifact, but a list whose artifact was DELETED,
   * invisibly, because prose has no compiler.
   *
   * The guard is bidirectional on purpose. If the symbol is ever reintroduced,
   * this fails — and it should, because the documentation now explicitly states
   * that it does not exist, and that statement would silently become false.
   */
  it("keeps VEGETATION_FRAME_DEBT_RATIO absent from src/, as the docs now assert", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (/\.tsx?$/u.test(entry.name)) {
          if (readSource(absolute).includes("VEGETATION_FRAME_DEBT_RATIO")) {
            offenders.push(absolute.slice(REPO_ROOT.length + 1));
          }
        }
      }
    };
    walk(join(REPO_ROOT, "src"));
    expect(
      offenders,
      "VEGETATION_FRAME_DEBT_RATIO reappeared in src/. docs/PERFORMANCE.md states it "
        + "no longer exists — update that statement in the same commit.",
    ).toEqual([]);
  });
});

describe("6-12 documentation truth: the committed capture baseline", () => {
  const baselineFiles = readdirSync(BASELINE_DIR);
  const shots = baselineFiles.filter((name) => name.endsWith(".png"));

  it("holds PNGs only — no numeric record without a write path", () => {
    /**
     * `tests/perf/baseline/report.json` was a 17-shot fossil beside 24 PNGs,
     * last written two phases earlier. It was deleted by `6-12` rather than
     * refreshed, because it had **no write path**: `report.json` is regenerated
     * by every capture into the gitignored `tests/perf/artifacts/`, so keeping
     * the committed copy current meant a human remembering, forever.
     *
     * It was not merely stale, it was a trap — a plausible numeric record in
     * the one directory a reader expects to hold committed truth. A session
     * did in fact read the wrong one and drew a meaningless comparison. An
     * instrument with no consumer is dead weight; an instrument with no
     * consumer in a location that implies authority is worse than nothing.
     */
    expect(
      baselineFiles.filter((name) => !name.endsWith(".png")),
      "Only PNGs belong in tests/perf/baseline. A committed numeric record needs a "
        + "write path; without one it is a fossil that reads as authoritative.",
    ).toEqual([]);
  });

  it("has a shot count docs/PERFORMANCE.md agrees with", () => {
    const table = PERFORMANCE_MD.slice(PERFORMANCE_MD.indexOf("| Shot | raw wall FPS"));
    const rows = table
      .split("\n")
      .slice(2)
      .filter((line) => line.startsWith("|"));
    expect(
      rows.length,
      `docs/PERFORMANCE.md's per-shot table has ${rows.length} rows against ${shots.length} `
        + "committed baseline PNGs. Shots are APPEND-ONLY and canonical-index-keyed, so a "
        + "stale count implies a different index mapping than the harness uses.",
    ).toBe(shots.length);
  });

  /**
   * **6-12 demonstrated its own headline defect, and this is the fix.**
   *
   * The truth pass worked a LIST of known-suspect locations. `vitest.perf.config.ts:9`
   * was not on that list, and it claimed the capture "renders the sixteen
   * canonical shots" while the list held 24 — stale by eight, in a file the
   * recorded untruth list never named. A pass driven by a list of suspects will
   * always miss the location nobody listed; that is the same shape as the
   * sampler comment, where the list was the instrument and the instrument did
   * not cover the artifact.
   *
   * So this assertion does not read a curated set of files. **It scans the
   * whole tree** for any claim of the form "<N> canonical shot(s)" and requires
   * N to equal the list. The count itself is deliberately never spelled out in
   * prose any more — `vitest.perf.config.ts` now points at `PERF_CAPTURE_SHOTS`
   * as the only authority, because a hardcoded number goes stale on the next
   * append and this exact defect returns.
   */
  it("lets no file in the tree claim a canonical shot count that disagrees with the list", () => {
    const WORDS: Record<string, number> = {
      twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
      seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
      "twenty-one": 21, "twenty-two": 22, "twenty-three": 23, "twenty-four": 24,
      "twenty-five": 25, "twenty-six": 26, "twenty-seven": 27, "twenty-eight": 28,
      "twenty-nine": 29, thirty: 30, "thirty-one": 31, "thirty-two": 32,
    };
    const offenders: string[] = [];
    const skip = new Set(["node_modules", ".git", ".claude", "dist", "dist-pages", "build"]);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (/\.(ts|mts|mjs|md|json)$/u.test(entry.name)) {
          const text = readSource(absolute);
          const pattern = /([A-Za-z-]+|\d{1,3})\s+canonical\s+shots?\b/giu;
          for (const match of text.matchAll(pattern)) {
            const raw = (match[1] ?? "").toLowerCase();
            const claimed = /^\d+$/u.test(raw) ? Number.parseInt(raw, 10) : WORDS[raw];
            if (claimed === undefined) continue; // "the canonical shots" etc.
            if (claimed !== PERF_CAPTURE_SHOTS.length) {
              offenders.push(
                `${absolute.slice(REPO_ROOT.length + 1)}: claims ${claimed} canonical shots, list has ${PERF_CAPTURE_SHOTS.length}`,
              );
            }
          }
        }
      }
    };
    walk(REPO_ROOT);
    expect(
      offenders,
      "A stale canonical shot count. Shots are APPEND-ONLY and canonical-index-keyed, "
        + "so a wrong count implies a different index mapping than the harness uses. "
        + "Prefer pointing at PERF_CAPTURE_SHOTS over restating the number.",
    ).toEqual([]);
  });

  it("names every committed shot in that table", () => {
    const table = PERFORMANCE_MD.slice(PERFORMANCE_MD.indexOf("| Shot | raw wall FPS"));
    const missing = shots
      .map((name) => name.replace(/\.png$/u, ""))
      .filter((name) => !table.includes(`\`${name}\``));
    expect(missing, "baseline shots absent from the documented table").toEqual([]);
  });
});
