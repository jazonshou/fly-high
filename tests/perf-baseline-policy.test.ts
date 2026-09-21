import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PERF_CAPTURE_SHOTS } from "../scripts/perf-capture.mts";

/**
 * A COMMITTED BASELINE THAT NOTHING COMPARES AGAINST PASSES FOREVER AND SHOWS
 * NOTHING.
 *
 * `perf-capture` reads a shot's baseline only when `comparesToBaseline` is
 * true — and it defaults to true, so the flag exists to turn comparison OFF.
 * It is set false while a new shot waits for its first promotion, because
 * `readBaselinePixels` runs with `required = !REBASELINE` and a shot with no
 * committed baseline is FATAL to a normal capture.
 *
 * The trap is the other order. Promote the PNG and forget the flag and the
 * suite stays green over a shot it has stopped looking at. `scripts/
 * r4-flip-compares-to-baseline.mts` was written for exactly this during a
 * previous promotion, says so in its own header — "a shot with a baseline and
 * `comparesToBaseline: false` passes forever while showing nothing … the
 * instrument failure this phase produced most often" — and carries a hardcoded
 * list of five names. It was a guard for one promotion, not a standing one.
 *
 * This is the standing one.
 */

const BASELINES = new Set(
  readdirSync("tests/perf/baseline")
    .filter((file) => file.endsWith(".png"))
    .map((file) => file.slice(0, -4)),
);

const comparesToBaseline = (shot: (typeof PERF_CAPTURE_SHOTS)[number]): boolean =>
  (shot as { comparesToBaseline?: boolean }).comparesToBaseline ?? true;

/**
 * Shots that keep a committed baseline they deliberately do NOT compare
 * against, each with the reason, because a blind baseline is otherwise exactly
 * what this file exists to catch.
 *
 * All three are TEMPORAL shots. Their question is not "does this frame still
 * look like this" but "does this frame look like the one before it" —
 * geomorph popping, flicker through a banked turn, hitching under page
 * admission — and they are gated on CONSECUTIVE-FRAME SSIM, hitch count and
 * residency depth instead. The committed PNG is review evidence, not a gate.
 *
 * Adding a name here should cost a sentence saying which gate replaces the
 * image, the way `delivery-floors` makes becoming a probe cost one.
 */
const IMAGE_GATE_REPLACED: Readonly<Record<string, string>> = {
  "motion-banked-turn": "gated on consecutive-frame SSIM through the turn, not on a baseline",
  "page-thrash-turn": "gated on hitch count and residency depth, not on an image",
  "cdlod-transition": "gated on consecutive-frame SSIM, which is what geomorph popping is",
};

describe("every committed baseline is actually compared against", () => {
  it("has a shot list and a baseline directory to check at all", () => {
    // The exposure column. Everything below is a filter over these two, and a
    // filter over nothing passes.
    expect(PERF_CAPTURE_SHOTS.length).toBeGreaterThan(30);
    expect(BASELINES.size).toBeGreaterThan(20);
  });

  it("never compares a shot that has no committed baseline", () => {
    // This one is also fatal at capture time, but failing here costs seconds
    // instead of a full run.
    const comparing = PERF_CAPTURE_SHOTS.filter(comparesToBaseline).map((shot) => shot.name);
    expect(comparing.filter((name) => !BASELINES.has(name))).toEqual([]);
    expect(comparing.length, "nothing compares to a baseline at all").toBeGreaterThan(20);
  });

  it("leaves no committed baseline unexamined, except the three declared above", () => {
    const blind = PERF_CAPTURE_SHOTS
      .filter((shot) => BASELINES.has(shot.name) && !comparesToBaseline(shot))
      .map((shot) => shot.name);
    expect(
      blind.filter((name) => !(name in IMAGE_GATE_REPLACED)),
      "a promotion committed a baseline and left `comparesToBaseline: false`; "
      + "the suite is green over a shot it has stopped looking at",
    ).toEqual([]);
  });

  it("keeps the declared list honest: each named shot still has a blind baseline", () => {
    // Without this, a name whose flag was later flipped to true would sit here
    // forever looking like a live exception — the stale-exception failure the
    // rudder gate's DECLARED_UNRAKED avoided by asserting its entries still
    // fail.
    for (const [name, reason] of Object.entries(IMAGE_GATE_REPLACED)) {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      expect(shot, `${name} is declared here but is not a shot any more`).toBeDefined();
      expect(BASELINES.has(name), `${name} is declared here but has no baseline`).toBe(true);
      expect(comparesToBaseline(shot!), `${name} now compares; remove it from the list`).toBe(false);
      expect(reason.length, `${name} needs a reason, not an empty string`).toBeGreaterThan(20);
    }
  });
});
