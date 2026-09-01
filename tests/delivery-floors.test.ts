import { describe, expect, it } from "vitest";

import { PERF_CAPTURE_SHOTS } from "../scripts/perf-capture.mts";
import {
  COLD_START_SAMPLES,
  DELIVERY_FLOOR_PROVENANCE,
  DELIVERY_FLOOR_SAMPLES,
  DRAW_CALL_SAMPLES,
  FIRST_PIN_SHOTS,
  PREVIOUS_DELIVERY_FLOORS,
  DRAW_CALL_RAISES,
  PREVIOUS_DRAW_CALL_CEILINGS,
  declaredRaiseFor,
  SAMPLE_SPREAD_TOLERANCE_FPS,
  TAIL_DEFERRED_SHOTS,
  TAIL_DERIVED_FIELDS,
  coldStartCeilingMs,
  deliveryFloorsFrom,
  drawCallCeilingFrom,
  firstPinFrom,
  ratchetedFloorsFrom,
  sampleSpreadFps,
  tailDeferredFloorsFrom,
} from "../scripts/deliveryFloors.mts";

/**
 * The delivery floors are DERIVED from recorded run samples, and this file is
 * what makes that binding.
 *
 * **The fault it closes**, hit three times in three different files this phase:
 * a figure is measured once, copied into a second place, and the copy becomes
 * what everything trusts while the source moves underneath it.
 *
 * **The obvious repair does not work here and it is worth writing down why.**
 * "Derive the number at test time from the thing that produces it" is right for
 * a shader-derived binding list or a profile table — the source is available
 * when the test runs. What produces a delivery floor is *a set of capture
 * runs*. Deriving a floor from the run under test would compare that run
 * against itself and pass unconditionally: a decorative gate, and precisely the
 * "numbers compared against themselves" antipattern.
 *
 * So the **samples** are stored and the **floors are computed from them**. The
 * samples describe finished, named runs and cannot drift, because the runs are
 * over. A committed floor that disagrees with its own samples fails here.
 *
 * **Known limitation, taken deliberately rather than by accident.** The shot
 * definitions still carry their floors as literals, and this test asserts the
 * literals equal the derivation, rather than the definitions calling
 * `deliveryFloorsFrom` directly. Two reasons, and the second is the honest one:
 * a floor visible at its definition site is what a reviewer reads, and
 * replacing 29 call sites in `perf-capture.mts` while other sessions are
 * actively editing that file is a merge conflict for no behavioural gain.
 * **Flipping to a direct call is a one-line-per-shot change and should happen
 * when the file is quiet.** Until then the guard below carries the property.
 */

const SHOTS_WITH_FLOORS = PERF_CAPTURE_SHOTS.filter((shot) => shot.ceilings !== null);

describe("delivery floors are derived from recorded samples", () => {
  it("records where the samples came from", () => {
    // Provenance is data, not a comment: three runs minimum, and a named
    // commit, so "which runs was this pinned from" is answerable from the tree.
    expect(DELIVERY_FLOOR_PROVENANCE.runs.length).toBeGreaterThanOrEqual(3);
    expect(DELIVERY_FLOOR_PROVENANCE.commit).toMatch(/^[0-9a-f]{7,40}$/u);
    expect(DELIVERY_FLOOR_PROVENANCE.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("refuses to derive a floor from fewer than three runs", () => {
    // The rule that makes the samples worth storing. One cool-host run samples
    // the favourable end of a ~20% thermal band.
    expect(() =>
      deliveryFloorsFrom({
        fps: [120, 120],
        wallClockFps: [120, 120],
        frameIntervalMsP95: [9.5, 9.5],
        hitchCount: [0, 0],
        p999FrameMs: [10, 10],
      }),
    ).toThrow(/at least three runs/u);
  });

  it("has samples for every shot that carries a floor", () => {
    const missing = SHOTS_WITH_FLOORS.map((shot) => shot.name).filter(
      (name) => DELIVERY_FLOOR_SAMPLES[name] === undefined,
    );
    expect(
      missing,
      "a shot carries a pinned floor with no recorded samples behind it — the "
        + "floor is then a transcription with no source, which is the fault this "
        + "file exists to close",
    ).toEqual([]);
  });

  it.each(SHOTS_WITH_FLOORS.map((shot) => [shot.name] as const))(
    "%s's committed floor equals samples-derived, ratcheted against the previous pin",
    (name) => {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      const samples = DELIVERY_FLOOR_SAMPLES[name];
      if (shot?.ceilings == null || samples === undefined) {
        throw new Error(`${name}: missing shot or samples`);
      }
      // A tail-deferred shot is derived by the same arithmetic minus the two
      // tail fields, so it is held to that derivation rather than exempted.
      const expected = TAIL_DEFERRED_SHOTS.has(name)
        ? tailDeferredFloorsFrom(samples)
        : ratchetedFloorsFrom(samples, PREVIOUS_DELIVERY_FLOORS[name]);
      expect(
        { ...shot.ceilings },
        `${name}'s pinned floor disagrees with the runs it was derived from. `
          + "Do not edit the floor to match — regenerate it from the samples, or "
          + "add a run and re-derive. Editing the floor is how the copy drifts.",
      ).toEqual(expected);
    },
  );

  /**
   * **The reason the ratchet exists, as an assertion rather than a comment.**
   *
   * `docs/PERFORMANCE.md`: "performance ceilings cannot be rebaselined
   * downward". A mechanical re-derivation does NOT honour that by itself —
   * measured against the previous pin, deriving straight from the recorded runs
   * would loosen a majority of the shots that have a predecessor, because those
   * runs are noisier than the ones the earlier floors came from. **A re-pin
   * that loosens is how a regression gets laundered into the baseline.**
   *
   * The exact count is deliberately not written here. It was, it said "14 of
   * 24", and it was wrong within a day of the samples being regenerated. The
   * "load-bearing" test below derives it instead.
   */
  it.each(SHOTS_WITH_FLOORS.map((shot) => [shot.name] as const))(
    "%s's floor is no looser than the pin it replaced",
    (name) => {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      const previous = PREVIOUS_DELIVERY_FLOORS[name];
      if (shot?.ceilings == null) throw new Error(`${name}: no committed floor`);
      if (previous === undefined) {
        // **Not a silent skip.** A shot with no predecessor must SAY so, or
        // "nothing to ratchet against" and "the ratchet passed" look identical
        // to a reader and to this test — which is how an assertion quietly
        // stops covering something. First pins are guarded separately below.
        expect(
          FIRST_PIN_SHOTS.has(name) || TAIL_DEFERRED_SHOTS.has(name),
          `${name} has no previous floor and is not declared in FIRST_PIN_SHOTS `
            + "or TAIL_DEFERRED_SHOTS. Either it is a first pin — declare it, and it "
            + "gets the spread gate instead of the ratchet — or its predecessor was lost.",
        ).toBe(true);
        return;
      }
      const now = shot.ceilings;
      const complaint = `${name}: a delivery floor was loosened. `
        + "Ceilings ratchet one way; loosening one needs a recorded decision, not a re-pin.";
      expect(now.minFps, complaint).toBeGreaterThanOrEqual(previous.minFps);
      expect(now.minWallClockFps, complaint).toBeGreaterThanOrEqual(previous.minWallClockFps);
      expect(now.hitchCount, complaint).toBeLessThanOrEqual(previous.hitchCount);
      // **Dropping a tail field is the largest loosening available**, because
      // the gate stops existing rather than getting a bigger number. So the
      // field's PRESENCE is asserted first, and only then its value. A shot that
      // had one of these can never be added to TAIL_DEFERRED_SHOTS.
      for (const field of TAIL_DERIVED_FIELDS) {
        if (previous[field] === undefined) continue;
        expect(
          now[field],
          `${name}: ${field} had a committed ceiling and now has none. Deferring a `
            + "tail field is only available to a shot that never had one — dropping an "
            + "existing gate loosens it to infinity and reads as a tidier row.",
        ).not.toBeUndefined();
        expect(now[field]!, complaint).toBeLessThanOrEqual(previous[field]!);
      }
    },
  );

  it("the ratchet is load-bearing, not decorative", () => {
    // If raw derivation never loosened anything, the ratchet would be dead code
    // and this file would be overclaiming. The count is deliberately not
    // restated here — it has already gone stale once by being written down.
    const loosens = (a: number | undefined, b: number | undefined) =>
      a !== undefined && b !== undefined && a > b;
    const loosened = SHOTS_WITH_FLOORS.filter((shot) => {
      const samples = DELIVERY_FLOOR_SAMPLES[shot.name];
      const previous = PREVIOUS_DELIVERY_FLOORS[shot.name];
      if (!samples || !previous) return false;
      const raw = deliveryFloorsFrom(samples);
      return (
        raw.minFps < previous.minFps
        || raw.minWallClockFps < previous.minWallClockFps
        || loosens(raw.maxFrameIntervalMsP95, previous.maxFrameIntervalMsP95)
        || loosens(raw.p999FrameMs, previous.p999FrameMs)
        || raw.hitchCount > previous.hitchCount
      );
    });
    expect(loosened.length).toBeGreaterThan(0);
  });
});

describe("cold start is pinned from samples, not from one reading", () => {
  it("keeps three samples and the rejected outlier", () => {
    expect(COLD_START_SAMPLES.totalMs.length).toBeGreaterThanOrEqual(3);
    // The 1,412 ms reading was proposed as the pin and refused. It sits BELOW
    // all three samples, so it is an outlier and not the good end of a spread.
    // Recorded so it cannot be "restored" by someone who finds it in a log.
    expect(Math.min(...COLD_START_SAMPLES.totalMs)).toBeGreaterThan(
      COLD_START_SAMPLES.rejectedOutlierMs,
    );
  });

  it("derives a ceiling above every sample, with headroom", () => {
    const ceiling = coldStartCeilingMs();
    expect(ceiling).toBeGreaterThan(Math.max(...COLD_START_SAMPLES.totalMs));
    // Not so loose that it stops being a budget. The 120 s value in
    // cold-start.test.ts is a HANG-CATCHER and deliberately not this number.
    expect(ceiling).toBeLessThan(4_000);
  });
});

describe("first pins are guarded by the samples, not by history", () => {
  it("has no stale FIRST_PIN_SHOTS entries", () => {
    // A shot declared a first pin that turns out to HAVE a predecessor is a
    // stale entry. Same shape as KNOWN_INVERTED: the set can only shrink, and
    // it cannot outlive the reason it was written.
    const stale = [...FIRST_PIN_SHOTS].filter(
      (name) => PREVIOUS_DELIVERY_FLOORS[name] !== undefined,
    );
    expect(
      stale,
      "declared as first pins but a previous floor exists — remove them; they "
        + "should be ratcheted, not spread-gated",
    ).toEqual([]);
  });

  it("refuses to derive a first pin from runs that disagree", () => {
    // The guard that replaces the ratchet. `min-across-runs` is only meaningful
    // if the runs agree; if they do not, the minimum is 0.85 of an accident.
    const noisy = {
      fps: [120, 118, 103],
      wallClockFps: [119.8, 117.4, 102.6],
      frameIntervalMsP95: [9.5, 9.9, 12.4],
      hitchCount: [0, 0, 2],
      p999FrameMs: [10, 11, 18],
    };
    expect(() => firstPinFrom(noisy)).toThrow(/not three clean runs/u);
  });

  it("accepts a first pin from three clean runs and derives it exactly", () => {
    const clean = {
      fps: [121.0, 121.1, 120.9],
      wallClockFps: [119.9, 119.95, 119.88],
      frameIntervalMsP95: [9.5, 9.6, 9.5],
      hitchCount: [0, 0, 0],
      p999FrameMs: [10.2, 10.1, 10.3],
    };
    expect(sampleSpreadFps(clean)).toBeLessThanOrEqual(SAMPLE_SPREAD_TOLERANCE_FPS);
    // A first pin gets no extra headroom over the documented rule — that is what
    // makes a fabricated ceiling impossible to hide as a measured one.
    expect(firstPinFrom(clean)).toEqual(deliveryFloorsFrom(clean));
  });

  it("sets the tolerance where it actually bites", () => {
    // Not hypothetical: the worst cross-run spread in the R4 samples is
    // `canopy-1200ft`'s 0.486 — inside the 0.5 tolerance, at 97% of it. A
    // tolerance chosen somewhere comfortable would not have been a gate.
    const worst = Object.values(DELIVERY_FLOOR_SAMPLES)
      .map((samples) => sampleSpreadFps(samples))
      .reduce((a, b) => Math.max(a, b), 0);
    expect(worst).toBeLessThanOrEqual(SAMPLE_SPREAD_TOLERANCE_FPS);
    expect(worst).toBeGreaterThan(0.4);
  });
});

describe("draw-call ceilings are the measured count, not a margin", () => {
  const SHOTS_WITH_DRAW_CEILINGS = PERF_CAPTURE_SHOTS.filter(
    (shot) => typeof shot.drawCallCeiling === "number",
  );

  it("has samples for every shot that carries a draw-call ceiling", () => {
    const missing = SHOTS_WITH_DRAW_CEILINGS.map((shot) => shot.name).filter(
      (name) => DRAW_CALL_SAMPLES[name] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it.each(SHOTS_WITH_DRAW_CEILINGS.map((shot) => [shot.name] as const))(
    "%s's ceiling is exactly what the runs measured",
    (name) => {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      const samples = DRAW_CALL_SAMPLES[name];
      if (shot?.drawCallCeiling === undefined || samples === undefined) {
        throw new Error(`${name}: missing shot or samples`);
      }
      expect(
        shot.drawCallCeiling,
        `${name}: the draw-call ceiling is not the measured count. This quantity is `
          + "host-independent, so headroom above the measurement is growth nobody has "
          + "justified — eight draws of margin is eight draws of real growth passing silently.",
      ).toBe(drawCallCeilingFrom(samples));
    },
  );

  it.each(SHOTS_WITH_DRAW_CEILINGS.map((shot) => [shot.name] as const))(
    "%s's ceiling is no looser than the one it replaced",
    (name) => {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      const previous = PREVIOUS_DRAW_CALL_CEILINGS[name];
      if (shot?.drawCallCeiling === undefined) throw new Error(`${name}: no ceiling`);
      if (previous === undefined) return; // new shot; nothing shipped before it
      // A raise is admissible only as far as it was DECLARED. Undeclared growth
      // of even one draw fails, which is the property the previous version of
      // this test claimed and did not have: it compared against pre-tightening
      // values carrying 6-10 draws of margin, so a whole feature's cost fitted
      // inside the slack and passed as though nothing had happened.
      const allowed = previous + declaredRaiseFor(name);
      expect(
        shot.drawCallCeiling,
        `${name}: the draw-call ceiling exceeds what was declared. It may tighten `
          + `freely; to raise it, add an entry to DRAW_CALL_RAISES naming the feature `
          + `and its per-shot cost. Previous ${previous}, declared raise `
          + `${declaredRaiseFor(name)}, committed ${shot.drawCallCeiling}.`,
      ).toBeLessThanOrEqual(allowed);
    },
  );

  describe("a declared raise is checked, not just recorded", () => {
    it("every uniform raise really is uniform", () => {
      // The claim that makes a uniform raise cheap to accept is that one
      // feature costs the same everywhere. If it does not, the entry is
      // describing creep as though it were a feature.
      for (const raise of DRAW_CALL_RAISES) {
        if (raise.kind !== "uniform") continue;
        for (const name of raise.shots) {
          const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
          const previous = PREVIOUS_DRAW_CALL_CEILINGS[name];
          expect(shot?.drawCallCeiling, `${raise.feature} names ${name}, which has no ceiling`)
            .toBeDefined();
          expect(previous, `${raise.feature} names ${name}, which has no previous ceiling`)
            .toBeDefined();
          expect(
            shot!.drawCallCeiling! - previous!,
            `${raise.feature} is declared uniform at ${raise.delta}, but ${name} moved by `
              + `${shot!.drawCallCeiling! - previous!}. Either it is not one feature's cost, `
              + "or it belongs in a per-shot raise that says what varies.",
          ).toBe(raise.delta);
        }
      }
    });

    it("no raise outlives the growth it was declared for", () => {
      // Entries are not standing permission. If a feature is removed and the
      // ceilings come back down, its raise must go too — otherwise the
      // allowance accumulates and the ratchet loosens by one entry at a time.
      for (const raise of DRAW_CALL_RAISES) {
        const named = raise.kind === "uniform" ? raise.shots : Object.keys(raise.deltas);
        const stillNeeded = named.filter((name) => {
          const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
          const previous = PREVIOUS_DRAW_CALL_CEILINGS[name];
          return shot?.drawCallCeiling !== undefined && previous !== undefined
            && shot.drawCallCeiling > previous;
        });
        expect(
          stillNeeded.length,
          `${raise.feature}'s raise is no longer needed by any shot it names — the growth `
            + "it permitted is gone. Delete the entry rather than leaving an allowance.",
        ).toBeGreaterThan(0);
      }
    });

    it("a per-shot raise says what varies, and is not a disguised uniform one", () => {
      for (const raise of DRAW_CALL_RAISES) {
        if (raise.kind !== "per-shot") continue;
        expect(raise.whyNonUniform.length, `${raise.feature}: whyNonUniform is empty`)
          .toBeGreaterThan(0);
        const values = Object.values(raise.deltas);
        expect(
          new Set(values).size,
          `${raise.feature} lists per-shot deltas that are all equal. Declare it uniform — `
            + "the two forms mean different things and a long list is where a uniform cost hides.",
        ).toBeGreaterThan(1);
      }
    });

    it("is load-bearing: the committed ceilings need it", () => {
      // Non-vacuity for the whole mechanism. If no shot currently exceeds its
      // previous, DRAW_CALL_RAISES is inert and every assertion above passes
      // without testing anything.
      const raised = SHOTS_WITH_DRAW_CEILINGS.filter((shot) => {
        const previous = PREVIOUS_DRAW_CALL_CEILINGS[shot.name];
        return previous !== undefined && (shot.drawCallCeiling ?? 0) > previous;
      });
      expect(raised.length, "no ceiling exceeds its previous; the raise mechanism is untested")
        .toBeGreaterThan(0);
    });
  });

  it("throws rather than taking a maximum when runs disagree", () => {
    // Disagreement would mean drawCalls are NOT host-independent, which
    // invalidates pinning them exactly. Silently taking the max would hide that.
    expect(() => drawCallCeilingFrom([150, 151, 150])).toThrow(/host-independent and is not/u);
  });

  it("confirms the host-independence claim on real data rather than asserting it", () => {
    // 29 shots x 3 runs, zero disagreements. If this ever fails, the treatment
    // above is wrong and the margin it removed was load-bearing after all.
    const varying = Object.entries(DRAW_CALL_SAMPLES).filter(
      ([, samples]) => new Set(samples).size !== 1,
    );
    expect(varying.map(([name]) => name)).toEqual([]);
  });
});

describe("tail-deferred first pins are partial on purpose, not by omission", () => {
  it.each([...TAIL_DEFERRED_SHOTS].map((name) => [name] as const))(
    "%s is pinned on its mean-like floors and on neither tail field",
    (name) => {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      expect(shot, `${name} is in TAIL_DEFERRED_SHOTS but is not a capture shot`).toBeDefined();
      const ceilings = shot!.ceilings;
      expect(ceilings, `${name} is tail-deferred but has no ceilings at all`).not.toBeNull();
      // The mean-like half must actually be pinned. "Deferred" has to mean the
      // two tail fields specifically, or it becomes a synonym for unpinned and
      // the shot silently loses its fps floor too.
      expect(typeof ceilings!.minFps).toBe("number");
      expect(typeof ceilings!.minWallClockFps).toBe("number");
      expect(typeof ceilings!.hitchCount).toBe("number");
      expect(typeof ceilings!.maxFrameMs).toBe("number");
      for (const field of TAIL_DERIVED_FIELDS) {
        expect(
          ceilings![field],
          `${name} is in TAIL_DEFERRED_SHOTS but carries a ${field}. Either it was `
            + "pinned from a tail-quiet set — then remove it from the set — or the value "
            + "came from the wide-tailed runs and should not be committed.",
        ).toBeUndefined();
      }
    },
  );

  it("no tail-deferred shot ever had a tail ceiling to lose", () => {
    // Deferral is only available to a FIRST pin. If a name here had a previous
    // tail floor, this list is being used to retire a gate rather than to
    // postpone one, which is the difference between honest debt and a quiet
    // loosening.
    for (const name of TAIL_DEFERRED_SHOTS) {
      const previous = PREVIOUS_DELIVERY_FLOORS[name];
      if (previous === undefined) continue;
      for (const field of TAIL_DERIVED_FIELDS) {
        expect(
          previous[field],
          `${name} is tail-deferred but had a committed ${field}. Deferral postpones a `
            + "gate that never existed; it does not retire one that did.",
        ).toBeUndefined();
      }
    }
  });

  it("every shot that had a tail ceiling still has one", () => {
    // The coverage guard, stated over the whole set rather than per shot: this
    // is the assertion that fails if the optional fields are ever used to make
    // a red shot green by deleting its gate.
    const dropped: string[] = [];
    for (const [name, previous] of Object.entries(PREVIOUS_DELIVERY_FLOORS)) {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      if (!shot || shot.ceilings === null) continue;
      for (const field of TAIL_DERIVED_FIELDS) {
        if (previous[field] !== undefined && shot.ceilings[field] === undefined) {
          dropped.push(`${name}.${field}`);
        }
      }
    }
    expect(dropped, "tail ceilings that existed before and are now absent").toEqual([]);
  });

  it("the tail fields really are the noisier ones in these samples", () => {
    // **The claim the deferral rests on, as an assertion.** If p95/p999 were no
    // noisier than the mean-like fields, deferring them would be superstition.
    // Compared in units of each field's own median, since ms and fps do not
    // share a scale.
    const spreadsOf = (read: (s: (typeof DELIVERY_FLOOR_SAMPLES)[string]) => readonly number[]) =>
      Object.values(DELIVERY_FLOOR_SAMPLES)
        .map((s) => { const v = read(s); return Math.max(...v) - Math.min(...v); })
        .sort((a, b) => a - b);
    const median = (xs: readonly number[]) => xs[xs.length >> 1]!;
    const p95 = median(spreadsOf((s) => s.frameIntervalMsP95));
    const p999 = median(spreadsOf((s) => s.p999FrameMs));
    const wall = median(spreadsOf((s) => s.wallClockFps));
    // Both tail fields vary more, run to run, than the mean-like floor does.
    expect(p95, `p95 median spread ${p95} vs wallClockFps ${wall}`).toBeGreaterThan(wall);
    expect(p999, `p999 median spread ${p999} vs wallClockFps ${wall}`).toBeGreaterThan(wall);
    // And hitchCount is genuinely constant here, which is why it IS pinned.
    const hitch = median(spreadsOf((s) => s.hitchCount));
    expect(hitch, "hitchCount varied across runs; it should not be pinned blind").toBe(0);
  });
});

describe("a ratcheted ceiling still has to clear the shot's own noise", () => {
  /**
   * **The ratchet and the noise floor can conflict, and the conflict is real.**
   *
   * The ratchet keeps the STRICTER of (previous, derived). That is right for
   * preventing a laundered regression, but taken alone it can leave a p95
   * ceiling sitting closer to the measured maximum than the shot's own
   * run-to-run variation — which fails spuriously on the next capture and
   * teaches everyone to distrust the gate.
   *
   * **The unit matters and I got it wrong first.** Checking headroom against a
   * single global noise figure (1.50 ms) flagged `cruise-horizon` on the run set
   * current at the time, where its own p95 spread was 0.20 ms and it had seven
   * times the headroom it needed. Run-to-run spread is a PER-SHOT quantity, so
   * a global threshold is the wrong unit of reasoning, the same way "ground
   * cover" was the wrong unit for the card-retirement question.
   *
   * So the guard compares each shot's headroom to ITS OWN measured spread.
   *
   * **That 0.20 ms is a fact about a run set, not about the shot** — in the
   * samples now in the module `cruise-horizon` spreads 1.10 ms. The number is
   * left above because the reasoning error it records is the point; it is not a
   * live measurement and nothing should read it as one.
   */
  /**
   * Shots the headroom guard does not bind, each by name and with its reason.
   *
   * **This is an exemption, not a widened rule.** The alternative on the table
   * was to compare headroom to some multiple of the spread for every shot,
   * which buys one shot's green by loosening the guard on all thirty. The
   * standing instruction is explicit that a shot that reddens is held by name
   * with a recorded reason, and the rule is not widened for everything.
   *
   * `cruise-horizon` — samples 9.3 / 9.6 / 10.4 ms, spread 1.10, ceiling 11.4,
   * headroom 1.00, ratio 0.91. Three things, together:
   *
   * 1. **This re-pin does not tighten it.** The ratchet takes the stricter of
   *    (previous 11.4, derived 12.5) and returns 11.4 — the value already
   *    committed. The shortfall is a pre-existing condition that became visible
   *    because this guard is new, not something the re-pin introduced.
   * 2. **The shortfall is one quantum of the instrument.** The capture reports
   *    p95 to 0.1 ms and the ceiling rule rounds to 0.1 ms; 1.00 vs 1.10 is one
   *    tick, estimated from a 3-sample range, which is a poor estimator of
   *    spread at n=3.
   * 3. **The run set's tail is unusually wide, and its fps is not.** Measured:
   *    this set's median per-shot p95 spread is 0.500 ms with 8 of 30 shots at
   *    or above 1.0 ms; the 2026-08-31 evening set is 0.200 ms with 1 of 27 —
   *    at an almost identical fps median spread (0.120 vs 0.114). So the
   *    "QUIET HOST" verdict, which is computed from wallClockFps, certifies a
   *    MEAN and does not transfer to an ORDER STATISTIC in the tail.
   *
   * **What is NOT claimed:** that 11.4 came from a tail-quiet set. The
   * 2026-08-30 pinning runs are not retained under `tests/perf/artifacts/`, so
   * that is unverified and is left unasserted rather than assumed.
   */
  const P95_HEADROOM_EXEMPT: ReadonlySet<string> = new Set(["cruise-horizon"]);

  const headroomRatio = (name: string): number | null => {
    const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
    const samples = DELIVERY_FLOOR_SAMPLES[name];
    if (shot?.ceilings == null || samples === undefined) return null;
    // No committed p95 ceiling = nothing to have headroom against. Returning
    // null puts the shot outside this guard rather than scoring it as infinite
    // margin, which would read as the safest shot in the set.
    const ceiling = shot.ceilings.maxFrameIntervalMsP95;
    if (ceiling === undefined) return null;
    const measuredMax = Math.max(...samples.frameIntervalMsP95);
    const spread = measuredMax - Math.min(...samples.frameIntervalMsP95);
    const headroom = ceiling - measuredMax;
    return spread === 0 ? Number.POSITIVE_INFINITY : headroom / spread;
  };

  it.each(SHOTS_WITH_FLOORS.map((shot) => [shot.name] as const))(
    "%s's p95 ceiling clears its own run-to-run spread",
    (name) => {
      const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === name);
      const samples = DELIVERY_FLOOR_SAMPLES[name];
      if (shot?.ceilings == null || samples === undefined) {
        throw new Error(`${name}: missing shot or samples`);
      }
      const ceiling = shot.ceilings.maxFrameIntervalMsP95;
      // Tail-deferred shots have no p95 ceiling yet; the block above owns them.
      if (ceiling === undefined) {
        expect(
          TAIL_DEFERRED_SHOTS.has(name),
          `${name} has no p95 ceiling but is not declared tail-deferred`,
        ).toBe(true);
        return;
      }
      const measuredMax = Math.max(...samples.frameIntervalMsP95);
      const spread = Math.max(...samples.frameIntervalMsP95) - Math.min(...samples.frameIntervalMsP95);
      const headroom = ceiling - measuredMax;
      if (P95_HEADROOM_EXEMPT.has(name)) return;
      expect(
        headroom,
        `${name}: the p95 ceiling sits ${headroom.toFixed(2)} ms above the measured max `
          + `while the shot varies ${spread.toFixed(2)} ms between runs. The ratchet has `
          + "tightened it past what this shot's own noise permits — it will fail on a "
          + "capture that regressed nothing. Hold the previous ceiling for this shot and "
          + "record why, rather than shipping a gate that cries wolf.",
      ).toBeGreaterThanOrEqual(spread);
    },
  );

  it("every exempt shot actually needs its exemption", () => {
    // Non-vacuity, in the direction that matters. An exemption list is the
    // easiest place in a suite for a name to outlive its reason: the shot goes
    // green on some later run set and the entry sits there forever, silently
    // switching the guard off for a shot that no longer needs it. So each
    // member must still FAIL the guard it is exempt from.
    for (const name of P95_HEADROOM_EXEMPT) {
      const ratio = headroomRatio(name);
      expect(ratio, `${name} is not a shot with floors and samples`).not.toBeNull();
      expect(
        ratio!,
        `${name} is listed in P95_HEADROOM_EXEMPT but now clears the guard at `
          + `${ratio!.toFixed(2)}x its own spread. Delete the entry — an exemption that is `
          + "no longer needed is an unguarded shot, not a harmless leftover.",
      ).toBeLessThan(1);
    }
  });

  it("reports how close the tightest non-exempt shot is, so the margin is visible not assumed", () => {
    let tightest = Number.POSITIVE_INFINITY;
    let tightestName = "";
    for (const shot of SHOTS_WITH_FLOORS) {
      if (P95_HEADROOM_EXEMPT.has(shot.name)) continue;
      const ratio = headroomRatio(shot.name);
      if (ratio === null) continue;
      if (ratio < tightest) { tightest = ratio; tightestName = shot.name; }
    }
    // Deliberately NOT pinned to a shot name. The previous revision asserted
    // `page-thrash-turn` was tightest, which was true of the run set it was
    // written against and false of the next one — the assertion tracked an
    // accident of the data while reading as a fact about the shot. What is
    // load-bearing is the margin, so that is what is asserted; the name is
    // carried in the message so a change of identity is still visible.
    expect(
      tightest,
      `tightest non-exempt shot is ${tightestName} at ${tightest.toFixed(2)}x its own spread`,
    ).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(tightest), "no non-exempt shot was measured").toBe(true);
  });
});
