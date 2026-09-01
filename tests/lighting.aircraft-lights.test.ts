import { describe, expect, it } from "vitest";
import {
  NAV_LIGHT_ARC_DEGREES,
  BEACON_PERIOD_SECONDS,
  STROBE_PERIOD_SECONDS,
  BEACON_FLASHES_PER_MINUTE,
  STROBE_FLASHES_PER_MINUTE,
  BEACON_DUTY,
  STROBE_DUTY,
  STROBE_PHASE_OFFSET,
  flashPhase,
  LANDING_LIGHT_MAX_AGL_METERS,
  navLightAtAzimuth,
  navLightVisibleFrom,
  beaconLit,
  strobeLit,
  landingLightOn,
  cockpitInstrumentGlow,
  COCKPIT_GLOW_NIGHT_MULTIPLE,
  type AircraftNavLight,
} from "../src/render/webgpu/lighting/AircraftLighting";
import { PERF_CAPTURE_SHOTS, PERF_CAPTURE_DEFAULT_CLOCK } from "../scripts/perf-capture.mts";

/**
 * `7-8`'s three pins, asserted as stated:
 *   - split angles verified by SAMPLING VISIBILITY AROUND THE AIRFRAME
 *   - beacon and strobe provably out of phase with each other
 *   - landing light off in all the default-clock shots
 */

describe("nav light split angles (7-8)", () => {
  it("partitions the full circle — every bearing sees exactly one light", () => {
    // Sampled around the airframe rather than checked at the boundaries, which
    // is how the pin is worded: a gap or an overlap of a fraction of a degree
    // is what an endpoint test misses and an observer sees as a light that
    // blinks out on a slow turn.
    const seen = new Map<AircraftNavLight, number>();
    for (let a = -180; a < 180; a += 0.05) {
      const light = navLightAtAzimuth(a);
      seen.set(light, (seen.get(light) ?? 0) + 1);
      // Exactly one: the other two must NOT claim this bearing.
      const claimants = (["port", "starboard", "tail"] as const)
        .filter((l) => navLightVisibleFrom(l, a));
      expect(claimants, `bearing ${a.toFixed(2)} deg`).toEqual([light]);
    }
    // All three actually occur — a partition into one light would satisfy the
    // uniqueness check above and be useless.
    expect([...seen.keys()].sort()).toEqual(["port", "starboard", "tail"]);
  });

  it("gives each light the arc the regulation states", () => {
    const width = (light: AircraftNavLight) => {
      let n = 0;
      const STEP = 0.01;
      for (let a = -180; a < 180; a += STEP) if (navLightVisibleFrom(light, a)) n += 1;
      return n * STEP;
    };
    expect(width("starboard")).toBeCloseTo(NAV_LIGHT_ARC_DEGREES.starboard, 1);
    expect(width("port")).toBeCloseTo(NAV_LIGHT_ARC_DEGREES.port, 1);
    expect(width("tail")).toBeCloseTo(NAV_LIGHT_ARC_DEGREES.tail, 1);
    // The property that makes it a partition rather than three cones.
    expect(
      NAV_LIGHT_ARC_DEGREES.port
      + NAV_LIGHT_ARC_DEGREES.starboard
      + NAV_LIGHT_ARC_DEGREES.tail,
    ).toBe(360);
  });

  it("puts red to port and green to starboard, so heading is inferable", () => {
    // The whole point of the split: an observer off the LEFT wing sees red.
    // `D-6` corrected the geometry; this asserts the LAW agrees with it, so a
    // future re-derivation of either cannot silently disagree with the other.
    expect(navLightAtAzimuth(-90)).toBe("port");
    expect(navLightAtAzimuth(90)).toBe("starboard");
    expect(navLightAtAzimuth(180)).toBe("tail");
    expect(navLightAtAzimuth(0)).toBe("starboard");
  });
});

describe("beacon and strobe phase (7-8)", () => {
  it("are provably NOT the same signal", () => {
    // The pin. Sampled finely over a full beat period: there must exist times
    // where one is lit and the other dark, in BOTH directions — otherwise one
    // lamp is wired to the other's timer and nothing downstream would notice.
    let beaconOnly = 0;
    let strobeOnly = 0;
    for (let t = 0; t < 12; t += 0.001) {
      const b = beaconLit(t);
      const s = strobeLit(t);
      if (b && !s) beaconOnly += 1;
      if (s && !b) strobeOnly += 1;
    }
    expect(beaconOnly, "the beacon is never lit alone").toBeGreaterThan(0);
    expect(strobeOnly, "the strobe is never lit alone").toBeGreaterThan(0);
  });

  it("does not put both lamps at phase 0 in every captured frame", () => {
    // THE CAPTURE TRAP, asserted rather than described. Shots are spaced 120 s
    // apart and both rates divide it exactly — 120/BEACON = 90 and
    // 120/STROBE = 120, both whole — so every shot samples an identical phase.
    expect(Number.isInteger(120 / BEACON_PERIOD_SECONDS)).toBe(true);
    expect(Number.isInteger(120 / STROBE_PERIOD_SECONDS)).toBe(true);
    // Without the offset both would be lit at every sample. With it, the
    // canonical frame carries one lit and one dark, so a capture can tell them
    // apart and a swap between them is visible.
    for (const k of [0, 1, 2, 5, 17]) {
      const t = k * 120;
      expect(beaconLit(t), `t=${t}: beacon should be lit at phase 0`).toBe(true);
      expect(strobeLit(t), `t=${t}: strobe should be dark at phase 0`).toBe(false);
    }
  });

  it("flashes at the rates the regulation names", () => {
    const count = (lit: (t: number) => boolean) => {
      let edges = 0;
      // Seeded FALSE, not `lit(0)`: the beacon is lit at t = 0 and the strobe
      // is not, so seeding from the signal counts 45 edges for one lamp and 44
      // for the other purely because of where each starts. That asymmetry is
      // the strobe's phase offset leaking into the instrument rather than a
      // difference in rate.
      let prev = false;
      for (let t = 0; t < 60; t += 0.0005) {
        const now = lit(t);
        if (now && !prev) edges += 1;
        prev = now;
      }
      return edges;
    };
    // 45 and 60 flashes per minute, counted as rising edges over 60 s.
    expect(count(beaconLit)).toBe(BEACON_FLASHES_PER_MINUTE);
    expect(count(strobeLit)).toBe(STROBE_FLASHES_PER_MINUTE);
  });

  it("keeps the strobe visibly shorter than the beacon", () => {
    // What distinguishes them to the eye when the rates are close. A strobe
    // with a beacon's duty reads as a second beacon.
    expect(STROBE_DUTY).toBeLessThan(BEACON_DUTY / 2);
  });
});

describe("landing light gating (7-8)", () => {
  it("is off in every default-clock shot, which all fly gear down", () => {
    // The pin, checked against the REAL shot list rather than a remembered
    // one. Every capture shot flies `gear: 1, onGround: false`, so a
    // gear-driven light would switch on in all of them and churn baselines
    // that have nothing to do with night.
    const defaults = PERF_CAPTURE_SHOTS.filter((s) => {
      const c = s.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
      return c.dayOfYear === PERF_CAPTURE_DEFAULT_CLOCK.dayOfYear
        && c.solarTimeHours === PERF_CAPTURE_DEFAULT_CLOCK.solarTimeHours;
    });
    expect(defaults.length, "no default-clock shots found — filter is wrong").toBeGreaterThan(5);
    for (const shot of defaults) {
      const agl = shot.altitudeAglMeters ?? 0;
      expect(
        landingLightOn({ altitudeAglMeters: agl, gear: 1, switchOn: false }),
        `${shot.name}: the landing light must be off with the switch off`,
      ).toBe(false);
    }
  });

  it("stays off at altitude even with gear down AND the switch on", () => {
    // The three shots the plan names by name.
    for (const agl of [3_048, 10_000, 1_500]) {
      expect(landingLightOn({ altitudeAglMeters: agl, gear: 1, switchOn: true })).toBe(false);
    }
    expect(LANDING_LIGHT_MAX_AGL_METERS).toBeLessThan(1_500);
  });

  it("comes on only when all three conditions hold", () => {
    const base = { altitudeAglMeters: 100, gear: 1, switchOn: true };
    expect(landingLightOn(base)).toBe(true);
    expect(landingLightOn({ ...base, switchOn: false })).toBe(false);
    expect(landingLightOn({ ...base, gear: 0 })).toBe(false);
    expect(landingLightOn({ ...base, altitudeAglMeters: 5_000 })).toBe(false);
    expect(landingLightOn({ ...base, altitudeAglMeters: Number.NaN })).toBe(false);
  });
});

describe("lamp-phase coverage of the capture set (7-0-a / 7-8)", () => {
  // The harness's own formula, mirrored so this test measures what the capture
  // will actually sample rather than what the shot list says.
  const timeFor = (index: number, shot: { simulationTimeOffsetSeconds?: number }) =>
    500 + index * 120 + (shot.simulationTimeOffsetSeconds ?? 0);

  it("captures BOTH states of both flashing lamps somewhere in the set", () => {
    const states = PERF_CAPTURE_SHOTS.map((shot, index) => {
      const t = timeFor(index, shot);
      return { name: shot.name, beacon: beaconLit(t), strobe: strobeLit(t) };
    });
    // Without an offset shot every entry is beacon-lit and strobe-dark, so all
    // four of these are the coverage that the lattice destroys.
    expect(states.some((s) => s.beacon), "no shot captures the beacon LIT").toBe(true);
    expect(states.some((s) => !s.beacon), "no shot captures the beacon DARK").toBe(true);
    expect(states.some((s) => s.strobe), "no shot captures the strobes LIT").toBe(true);
    expect(states.some((s) => !s.strobe), "no shot captures the strobes DARK").toBe(true);
  });

  it("keeps the offset shot clear of a duty edge", () => {
    // A shot perched on a transition would flip state under any change to the
    // periods or the duty, turning an unrelated edit into a baseline churn.
    const offsetShots = PERF_CAPTURE_SHOTS
      .map((shot, index) => ({ shot, index }))
      .filter(({ shot }) => (shot.simulationTimeOffsetSeconds ?? 0) !== 0);
    expect(offsetShots.length, "no shot carries a simulation-time offset").toBeGreaterThan(0);
    for (const { shot, index } of offsetShots) {
      const t = timeFor(index, shot);
      const bp = flashPhase(t, BEACON_PERIOD_SECONDS);
      const sp = flashPhase(t, STROBE_PERIOD_SECONDS, STROBE_PHASE_OFFSET);
      // Distance to the nearest edge of each lamp's duty window.
      const beaconMargin = Math.min(Math.abs(bp - BEACON_DUTY), 1 - bp);
      const strobeMargin = Math.min(sp, Math.abs(STROBE_DUTY - sp));
      expect(beaconMargin, `${shot.name}: beacon sits on a duty edge`).toBeGreaterThan(0.02);
      expect(strobeMargin, `${shot.name}: strobe sits on a duty edge`).toBeGreaterThan(0.02);
    }
  });
});

describe("cockpit instrument glow (7-8)", () => {
  it("is EXACTLY 1 in daylight, so no cockpit-mode shot can churn", () => {
    // `toBe(1)`, not `toBeCloseTo`. Eleven capture shots use `cameraMode:
    // "cockpit"`, and the multiplier is applied to each airframe's own
    // authored value — the trainer's 0.42 and the jet's 0.7. Only the literal
    // 1 leaves `authored * multiple === authored` bit-for-bit; 0.9999 moves
    // every one of them for no visible reason.
    for (const lux of [1.11e5, 1.014e5, 5e4, 3.4]) {
      expect(cockpitInstrumentGlow(0.92456, lux)).toBe(1);
    }
  });

  it("raises the panel at night, and never darkens it below daylight", () => {
    // Below the horizon: full night value.
    for (const sunY of [-0.001, -0.10669, -0.36585, -0.36896]) {
      expect(cockpitInstrumentGlow(sunY, 1.5e-3)).toBe(COCKPIT_GLOW_NIGHT_MULTIPLE);
    }
    // A panel is never DIMMER than its daylight setting — that would be a
    // pilot losing instruments as the light fades, the opposite of the point.
    for (let sunY = -1; sunY <= 1; sunY += 0.01) {
      for (const lux of [0, 1, 3.4, 1e3, 1.11e5]) {
        expect(cockpitInstrumentGlow(sunY, lux)).toBeGreaterThanOrEqual(1);
        expect(cockpitInstrumentGlow(sunY, lux)).toBeLessThanOrEqual(COCKPIT_GLOW_NIGHT_MULTIPLE);
      }
    }
  });

  it("fades through twilight rather than snapping at the horizon", () => {
    // The sun crossing zero is not the moment a panel becomes unreadable, and
    // a step there would pop the whole cockpit in one frame on a dawn scrub.
    const justAbove = cockpitInstrumentGlow(1e-6, 0.5);
    expect(justAbove).toBeGreaterThan(1);
    expect(justAbove).toBeLessThanOrEqual(COCKPIT_GLOW_NIGHT_MULTIPLE);
    // Monotone in illuminance: brighter ambient never means a brighter panel.
    let previous = COCKPIT_GLOW_NIGHT_MULTIPLE + 1;
    for (const lux of [0, 0.5, 1, 2, 3.4, 10, 1e3]) {
      const value = cockpitInstrumentGlow(0.2, lux);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it("keeps the panel lit when the sun is NaN", () => {
    // A NaN sun taking the dark branch would black out the instruments. The
    // airfield law defaults the other way for the same reason inverted: there,
    // full effect is the safe failure; here, a readable panel is.
    expect(cockpitInstrumentGlow(Number.NaN, 1e5)).toBe(COCKPIT_GLOW_NIGHT_MULTIPLE);
  });
});
