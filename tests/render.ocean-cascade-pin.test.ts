import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  OceanCascadeClock,
  resolveSpectralOceanConfig,
} from "../src/render/webgpu/nature/OceanConfig";

/**
 * The perf harness pins the ocean's cascade cadence at each shot's time pin.
 *
 * THE DEFECT. The ocean evolves each wave cascade only on the frames its
 * cadence allows (`shouldUpdateOceanCascade`: every 1, 1, 2 and 4 frames on
 * tier 1), and it counts frames on a counter that one renderer carries across
 * every shot of a capture run. The streaming loop before each shot is paced by
 * wall-clock time, so the counter's value at a shot's capture varies between
 * runs of identical code, and its residue decides whether the every-4th-frame
 * cascade (128-512 m waves) was last evolved at the capture instant or a frame
 * earlier. Measured 2026-09-22 over six full captures: two phase classes per
 * static water shot, ~0.12-0.19/255 mean apart over roughly 28 % of the near
 * sea, flipping between runs of identical code — and wholesale under
 * VITE_PERF_SHOTS. It is what the alpine-turf A/B read as glints "seeing the
 * land through the reflection probe"; the probe renders only sky.
 *
 * THE FIX. `OceanCascadeClock.pinForCapture`, called by the harness at the
 * same instant it pins simulation time, so every shot's capture lands on one
 * cadence phase whatever streamed before it.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. It drives the SHIPPED clock —
 * the object `SpectralOceanCompute.update` ticks — through the harness's own
 * render sequence, and shows the dispatch schedule the capture sees no longer
 * depends on history. Every claim here has its unpinned twin run beside it as
 * the positive control, because a determinism test that passes on the broken
 * code is a test of nothing. The sea PIXELS are shown bit-identical by the
 * GPU test on the shipped ocean (tests/gpu/ocean-cascade-pin.test.ts) and by
 * the before/after re-capture. Foam is outside the pin: it carries a few
 * seconds of pre-pin history of its own, a named floor measured there.
 */

// The harness's render calls from the time pin to the captured frame
// (tests/perf/perf-capture.test.ts): 150 settle + 4 drain + 240 measure + 1.
const FRAMES_FROM_PIN_TO_CAPTURE = 150 + 4 + 240 + 1;

/**
 * Every cadence any tier runs. Each tier takes a PREFIX of the default
 * cascades — `resolveProfileSpectralOceanConfig` is
 * `resolveSpectralOceanConfig({ resolution }).cascades.slice(0, oceanCascades)`
 * — so the defaults hold every cadence in use.
 */
const ALL_CADENCES = resolveSpectralOceanConfig().cascades.map(
  (cascade) => cascade.updateEveryNFrames,
);

/** The capture's own profile: report.json records tier 1, medium, balanced. */
const CAPTURE_CADENCES = resolveSpectralOceanConfig().cascades
  .slice(0, resolveWebGpuQualityProfile("medium", "balanced").oceanCascades)
  .map((cascade) => cascade.updateEveryNFrames);

/**
 * Runs one shot's frames through a fresh clock that has already counted
 * `framesBeforePin` (every earlier shot, plus this shot's own streaming), and
 * returns, per cadence, every post-pin frame on which it dispatched.
 */
function postPinSchedule(
  cadences: readonly number[],
  framesBeforePin: number,
  pin: boolean,
): number[][] {
  const clock = new OceanCascadeClock();
  for (let frame = 0; frame < framesBeforePin; frame += 1) clock.tick();
  if (pin) clock.pinForCapture();
  const schedule = cadences.map((): number[] => []);
  for (let frame = 0; frame < FRAMES_FROM_PIN_TO_CAPTURE; frame += 1) {
    clock.tick();
    cadences.forEach((cadence, index) => {
      if (clock.dispatches(cadence)) schedule[index]!.push(frame);
    });
  }
  return schedule;
}

/** How many frames before the captured frame each cascade last evolved. */
function lastEvolvedBeforeCapture(schedule: readonly number[][]): number[] {
  return schedule.map((frames) => FRAMES_FROM_PIN_TO_CAPTURE - 1 - frames[frames.length - 1]!);
}

/**
 * The cumulative streaming counts at water-25ft in the six captures that
 * settled the mechanism (run1..run3 of 2026-09-22 and the alpine-turf OFF/ON
 * pair), in that order. The pixels split them {run1, run3, OFF} against
 * {run2, ON}. The fixed per-shot render calls add the same constant to every
 * run, so they cannot change which runs share a class.
 */
const MEASURED_WATER_25FT_HISTORIES = [15_060, 14_190, 14_280, 14_580, 14_430] as const;
const MEASURED_PIXEL_CLASSES = [0, 1, 0, 0, 1] as const;

describe("the capture's ocean cadence, before the pin (the positive control)", () => {
  it("reproduces the two pixel classes the six captures measured", () => {
    // If the unpinned clock did not split these runs the way their pixels
    // did, this file would be modelling something other than the defect.
    const offsets = MEASURED_WATER_25FT_HISTORIES.map((history) =>
      lastEvolvedBeforeCapture(postPinSchedule(CAPTURE_CADENCES, history, false)).join(","),
    );
    const classOf = new Map<string, number>();
    const classes = offsets.map((key) => {
      if (!classOf.has(key)) classOf.set(key, classOf.size);
      return classOf.get(key)!;
    });
    expect(classes).toEqual([...MEASURED_PIXEL_CLASSES]);
  });

  it("differs only in the every-4th-frame cascade, as the pixels did", () => {
    // Streaming counts are multiples of 30 (the loop exits on frame%30==29),
    // so histories differ by 0 or 2 mod 4. A 2-frame difference must leave
    // the every-frame and every-2nd-frame cascades alone and move only the
    // every-4th — the 128-512 m waves the captures showed moving.
    const a = lastEvolvedBeforeCapture(postPinSchedule(CAPTURE_CADENCES, 900, false));
    const b = lastEvolvedBeforeCapture(postPinSchedule(CAPTURE_CADENCES, 902, false));
    CAPTURE_CADENCES.forEach((cadence, index) => {
      if (cadence === 4) expect(a[index], `cadence ${cadence}`).not.toBe(b[index]);
      else expect(a[index], `cadence ${cadence}`).toBe(b[index]);
    });
  });
});

describe("the capture's ocean cadence, pinned", () => {
  it("is the same schedule whatever streamed before the shot, on every cadence any tier runs", () => {
    // Every residue up to the slowest cadence, plus the six measured runs.
    const histories = [
      ...Array.from({ length: 2 * Math.max(...ALL_CADENCES) }, (_, frame) => frame),
      ...MEASURED_WATER_25FT_HISTORIES,
    ];
    const reference = postPinSchedule(ALL_CADENCES, histories[0]!, true);
    for (const history of histories) {
      expect(postPinSchedule(ALL_CADENCES, history, true), `history ${history}`).toEqual(reference);
    }
    // And the same histories unpinned are NOT all one schedule, so the
    // equality above is a property of the pin rather than of the sample.
    const unpinned = new Set(histories.map((history) =>
      JSON.stringify(postPinSchedule(ALL_CADENCES, history, false))));
    expect(unpinned.size).toBeGreaterThan(1);
  });
  // No "the pin keeps each cascade's cadence" test: the pin happens before the
  // window, so the gaps inside it equal the cadence for ANY pin. Written, it
  // passed with the pin stubbed out — a test of nothing, so it is not here.
});

describe("the pin is capture-only and sits at the time pin", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const rel = (path: string) => relative(ROOT, path).split("\\").join("/");
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  const THIS_FILE = rel(fileURLToPath(import.meta.url));
  function sourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "artifacts") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) found.push(path);
    }
    return found;
  }
  const PIN_NAMES = /pinOceanCascadePhaseForCapture|pinCascadePhaseForCapture|pinCascadeClockForCapture|\bpinForCapture\b/;

  it("the ocean counts frames only through the clock", () => {
    const ocean = read("src/render/webgpu/water/SpectralOceanSystem.ts");
    expect(ocean).toContain("this.clock.tick();");
    expect(ocean).toContain("this.clock.dispatches(cascadeConfig.updateEveryNFrames)");
    // A second, private frame counter would reintroduce the history.
    expect(ocean).not.toMatch(/\bframeIndex\b/);
  });

  it("under src/, is named only along the renderer -> ocean -> clock chain", () => {
    const allowed = new Set([
      "src/render/FlightRenderer.ts",
      "src/render/webgpu/water/SpectralOceanSystem.ts",
      "src/render/webgpu/nature/OceanConfig.ts",
    ]);
    const offenders = sourceFiles(join(ROOT, "src"))
      .map(rel)
      .filter((path) => !allowed.has(path) && PIN_NAMES.test(read(path)));
    // Mid-flight, a pin makes every slow cascade dispatch out of turn.
    expect(offenders).toEqual([]);
  });

  it("outside src/, is called by the perf harness alone", () => {
    const callers = [...sourceFiles(join(ROOT, "tests")), ...sourceFiles(join(ROOT, "scripts"))]
      .map(rel)
      .filter((path) => path !== THIS_FILE && !path.startsWith("tests/gpu/ocean-cascade-pin"))
      .filter((path) => PIN_NAMES.test(read(path)));
    expect(callers).toEqual(["tests/perf/perf-capture.test.ts"]);
  });

  it("pins once per shot, after the time pin and before the settle", () => {
    // Before the time pin, the streaming loop would count on past it; after
    // the first settle frame, the settle would start on a history-dependent
    // phase. Either way the fix silently stops working.
    const harness = read("tests/perf/perf-capture.test.ts");
    const timePin = harness.indexOf("simulationTime = 500 + canonicalShotIndex * 120");
    const cadencePin = harness.indexOf("renderer.pinOceanCascadePhaseForCapture();");
    const settle = harness.indexOf("for (let settle = 0; settle < 150; settle += 1)");
    expect(timePin).toBeGreaterThan(-1);
    expect(cadencePin).toBeGreaterThan(timePin);
    expect(settle).toBeGreaterThan(cadencePin);
    expect(harness.match(/renderer\.pinOceanCascadePhaseForCapture\(\)/g)).toHaveLength(1);
  });
});
