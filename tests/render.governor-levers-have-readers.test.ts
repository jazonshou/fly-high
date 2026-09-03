import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CPU_WORK_MAX_LEVEL,
  GPU_WORK_MAX_LEVEL,
  cpuWorkLeverName,
  gpuWorkLeverName,
  workLeverSettingsFor,
} from "../src/render/webgpu/core/AdaptiveGovernor";

/**
 * **Every `WorkLeverSettings` field must be READ by something OUTSIDE the
 * governor, and every ladder rung must move a field.**
 *
 * The GPU ladder already states this rule in prose — `2-10` retired the
 * planar-reflection rungs *with their system*, and the comment left behind says
 * **"a governor lever must never be attached to nothing."** That is the rule.
 * Until now it was only a comment, which is the same standing as
 * `MOON_PEAK_LIGHT_INTENSITY`'s docblock had while the constant was inert.
 *
 * **Why OUTSIDE the governor, unlike the quality-profile guard next door.** A
 * profile field whose only reader sits beside its declaration is still wired —
 * `hitchThresholdMilliseconds` reads `frameTargetMs` inside `QualityProfile.ts`
 * and that counts. A LEVER is different in kind: the governor is what *writes*
 * it. A lever the governor sets and only the governor reads has no effect on
 * the renderer at all — it is a number moving in a loop. So the reader has to
 * be somewhere the frame is actually built.
 *
 * **This exists now because `7-9` is about to add a lighting rung**, and the
 * levers it was drafted against do not survive contact with the code:
 * `clusteredLighting`'s geometry reallocates three GPU resources so it is
 * profile data and cannot be a runtime lever (recorded in its own docblock),
 * the clustered light COUNT is a shader define so moving it would recompile
 * during flight (which `7-9`'s pins forbid), and the light-point population
 * prices out at 0.23-0.48% of frame pixels. **A rung attached to any of those
 * would look exactly like a rung attached to something.**
 *
 * The instrument legs come first and are not decoration: a scanner with a
 * too-permissive pattern reports a clean sweep over every lever and proves
 * nothing, which is the failure mode this whole family of guards keeps hitting.
 */

const SRC = "src";
const GOVERNOR = join("src", "render", "webgpu", "core", "AdaptiveGovernor.ts");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Block and line comments removed, so a mention in prose cannot count as a read. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ");
}

const ALL_PATHS = sourceFiles(SRC);
/** Everything except the governor itself — see the docblock on why it is excluded. */
const OUTSIDE_GOVERNOR = ALL_PATHS
  .filter((path) => path !== GOVERNOR)
  .map((path) => stripComments(readFileSync(path, "utf8")));

function readerCount(name: string): number {
  const pattern = new RegExp(String.raw`(\.${name}\b|\["${name}"\]|\['${name}'\])`, "u");
  return OUTSIDE_GOVERNOR.filter((code) => pattern.test(code)).length;
}

/** The artifact: whatever the shipping ladder actually produces at full quality. */
const LEVER_FIELDS = Object.keys(workLeverSettingsFor(0, 0));

describe("every governor lever has a reader outside the governor", () => {
  it("INSTRUMENT — the detector reports an unread name as unread, and a real one as read", () => {
    expect(readerCount("aLeverNoLadderHasEverHad")).toBe(0);
    expect(readerCount("shadowCasterDistanceMeters")).toBeGreaterThan(0);
  });

  it("INSTRUMENT — a name that appears ONLY in a comment is not counted as read", () => {
    // Synthetic on purpose, for the reason the sibling guard records: naming a
    // live symbol only defers the fixture's retirement to whoever wires it.
    const inComment = [
      "// 7-9 will read .aSyntheticLeverField once the rung lands",
      "/* and .aSyntheticLeverField is discussed here too */",
    ].join("\n");
    const inCode = "const v = this.workLeverSettings.aSyntheticLeverField * 2;";
    const mentions = (code: string): boolean =>
      new RegExp(String.raw`\.aSyntheticLeverField\b`, "u").test(stripComments(code));

    expect(mentions(inComment), "a commented mention was counted as a reader").toBe(false);
    expect(mentions(inCode), "a real property access was not counted as a reader").toBe(true);
    // Stripping that ate the code would also report no readers anywhere.
    expect(stripComments(inCode)).toContain("workLeverSettings.aSyntheticLeverField");
  });

  it("INSTRUMENT — the governor file is genuinely excluded from the scan", () => {
    // If the exclusion silently failed, every lever would appear read by its own
    // declaration site and the guard would pass unconditionally.
    expect(ALL_PATHS, "the governor path is not what this test thinks it is")
      .toContain(GOVERNOR);
    expect(OUTSIDE_GOVERNOR.length).toBe(ALL_PATHS.length - 1);
  });

  it("the lever list is non-vacuous and comes from the shipped ladder", () => {
    expect(LEVER_FIELDS.length).toBeGreaterThan(5);
    expect(LEVER_FIELDS).toContain("groundCoverGateScale");
    expect(LEVER_FIELDS).toContain("computeBudgetScale");
  });

  it("THE GUARD — no governor lever is attached to nothing", () => {
    const inert = LEVER_FIELDS.filter((name) => readerCount(name) === 0);
    expect(
      inert,
      `these governor levers are READ BY NOTHING outside the governor: ${inert.join(", ")}. `
      + "The GPU ladder's own comment states the rule: a governor lever must never be "
      + "attached to nothing. Such a lever moves under load, costs a ladder step that "
      + "could have shed real work, and changes no pixel. Wire it, or do not land the rung.",
    ).toEqual([]);
  });

  it("THE GUARD — every ladder rung actually moves a lever field", () => {
    // The companion failure: a rung whose `apply` returns settings identical to
    // the step before it. That is a step the governor spends 120 frames on and
    // gets nothing for, and it is invisible because the ladder still "works".
    const stuck: string[] = [];
    for (const [label, max, nameAt, at] of [
      ["CPU", CPU_WORK_MAX_LEVEL, cpuWorkLeverName,
        (level: number) => workLeverSettingsFor(level, 0)],
      ["GPU", GPU_WORK_MAX_LEVEL, gpuWorkLeverName,
        (level: number) => workLeverSettingsFor(0, level)],
    ] as const) {
      for (let level = 1; level <= max; level += 1) {
        const before = at(level - 1) as unknown as Record<string, unknown>;
        const after = at(level) as unknown as Record<string, unknown>;
        const moved = LEVER_FIELDS.filter((f) => before[f] !== after[f]);
        if (moved.length === 0) {
          stuck.push(`${label} rung ${level - 1}->${level} (${nameAt(level - 1) ?? "?"})`);
        }
      }
    }
    expect(
      stuck,
      `these ladder rungs change no lever value: ${stuck.join(", ")}. `
      + "A rung that applies the same settings as the step below it costs a 120-frame "
      + "window and sheds nothing.",
    ).toEqual([]);
  });
});
