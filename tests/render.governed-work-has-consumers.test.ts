import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGovernedWork } from "../src/render/governedWork";
import { workLeverSettingsFor } from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { stripComments } from "./support/sourceText";

/**
 * **Every `GovernedWork` value must be CONSUMED by a subsystem**: read as
 * `work.NAME` or `governedWork.NAME` somewhere outside the two files that
 * produce it.
 *
 * `render.governor-levers-have-readers` asks the same of the lever settings,
 * and PR B part 2's study found the hole in it (G5 study §6): since G3,
 * `governedWork.ts` reads every lever to resolve it, so a new lever counts as
 * read with no subsystem wired to it at all. A rung on such a lever would
 * move a number and shed nothing. This guard moves the question one step
 * down the chain: the resolved value has to reach the frame.
 *
 * The instrument leg is not decoration: a detector that matches too much
 * reports a clean sweep and proves nothing.
 */

const PRODUCERS = new Set([
  join("src", "render", "governedWork.ts"),
  join("src", "render", "webgpu", "core", "AdaptiveGovernor.ts"),
]);
const RENDERER = join("src", "render", "FlightRenderer.ts");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const CONSUMER_SOURCES = sourceFiles("src")
  .filter((path) => !PRODUCERS.has(path))
  .map((path) => stripComments(readFileSync(path, "utf8")));

/** The artifact: whatever the resolver actually produces at full quality. */
const GOVERNED_WORK_FIELDS = Object.keys(
  resolveGovernedWork(resolveWebGpuQualityProfile("medium", "balanced"), workLeverSettingsFor(0, 0)),
);

/** The fields no source in `sources` consumes. */
function unconsumed(sources: readonly string[]): string[] {
  return GOVERNED_WORK_FIELDS.filter((name) => {
    const pattern = new RegExp(String.raw`\b(?:governedWork|work)\.${name}\b`, "u");
    return !sources.some((code) => pattern.test(code));
  });
}

describe("every governed work value has a consumer outside the governor", () => {
  it("INSTRUMENT: the detector reports a value whose one consumer is removed, and only that one", () => {
    const renderer = stripComments(readFileSync(RENDERER, "utf8"));
    expect(unconsumed([renderer])).toEqual([]);
    const severed = renderer.replace(/\bwork\.cloudMarchScale\b/gu, "1");
    expect(severed).not.toBe(renderer);
    expect(unconsumed([severed])).toEqual(["cloudMarchScale"]);
  });

  it("covers every field the resolver produces", () => {
    // 8 from PR B (G3), 7 from part 2 (G5): the cloud march, both refresh
    // intervals with their extra frames, and the CDLOD budget and threshold.
    expect(GOVERNED_WORK_FIELDS).toHaveLength(15);
    for (const name of [
      "cloudMarchScale",
      "shadowRefreshFrames",
      "shadowRefreshExtraFrames",
      "cloudDepthRefreshFrames",
      "cloudDepthRefreshExtraFrames",
      "cdlodNodeBudget",
      "cdlodPixelThreshold",
    ]) {
      expect(GOVERNED_WORK_FIELDS).toContain(name);
    }
  });

  it("finds a consumer for each", () => {
    expect(unconsumed(CONSUMER_SOURCES)).toEqual([]);
  });
});
