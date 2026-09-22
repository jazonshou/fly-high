import { describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import type { FlightVisualState } from "../src/game/types";
import {
  displayStateFromVisual,
  type DisplayAirframe,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayStateFromVisual";

/**
 * What the 747's six displays read, held to the numbers the HUD renders for the SAME state.
 *
 * The HUD's own conversions (`src/ui/Hud.tsx`) are the ground truth here, copied as literals on
 * purpose: if the adapter and the HUD ever disagree about what a knot is, the pilot sees one number
 * on the tape and another on the PFD, and this test is what notices.
 *
 * THE UNITS TRAP THIS EXISTS FOR: heading, pitch and bank arrive in `FlightVisualState` ALREADY IN
 * DEGREES (`updateVisualAnglesFromOrientation`, `src/game/SimulationClient.ts`), even though the
 * simulator's own telemetry carries them in radians. A "convert from radians" adapter would scale
 * heading by 57.3, and a test that assumed the same thing would agree with it. So the headings below
 * are checked against the HUD's formatter, which mods by 360 and is only meaningful for degrees.
 */

const AIRLINER: DisplayAirframe = Object.freeze({ engineCount: 4, fullFlapDegrees: 30 });

/** The HUD's own arithmetic, `src/ui/Hud.tsx` lines 87-89 and `formatHeading`. */
const hud = {
  speedKnots: (state: FlightVisualState) => state.airspeed * 1.94384,
  verticalSpeedFpm: (state: FlightVisualState) => state.verticalSpeed * 196.85,
  feet: (metres: number) => metres * 3.28084,
  heading: (state: FlightVisualState) => ((state.heading % 360) + 360) % 360,
};

function stateWith(overrides: Partial<FlightVisualState>): FlightVisualState {
  return { ...INITIAL_VISUAL_STATE, ...overrides } as FlightVisualState;
}

describe("the 747's display state", () => {
  it("reads speed, altitude and vertical speed in the HUD's own units", () => {
    const state = stateWith({
      airspeed: 128.6,
      altitude: 3_048,
      verticalSpeed: -7.62,
      velocity: { x: 120, y: -7.62, z: 40 },
    });
    const display = displayStateFromVisual(state, AIRLINER);
    expect(display.airspeedKt).toBeCloseTo(hud.speedKnots(state), 6);
    expect(display.airspeedKt).toBeCloseTo(249.98, 1);
    expect(display.altitudeFtMsl).toBeCloseTo(hud.feet(3_048), 6);
    expect(display.altitudeFtMsl).toBeCloseTo(10_000, 0);
    expect(display.verticalSpeedFpm).toBeCloseTo(hud.verticalSpeedFpm(state), 6);
    expect(display.verticalSpeedFpm).toBeCloseTo(-1_500, 0);
    // ALTITUDE IS MSL, NOT AGL: the HUD's tape shows altitudeAgl and a display shows this one, so a
    // state whose two differ must not read the HUD's number here
    const overTerrain = stateWith({ altitude: 3_048, altitudeAgl: 500 });
    expect(displayStateFromVisual(overTerrain, AIRLINER).altitudeFtMsl).toBeCloseTo(10_000, 0);
    expect(displayStateFromVisual(overTerrain, AIRLINER).altitudeFtMsl).not.toBeCloseTo(hud.feet(500), 0);
  });

  it("reads ground speed from the horizontal velocity, not the airspeed", () => {
    // 150 east, 200 north and a climb: ground speed is the horizontal hypotenuse, 250 m/s, and the
    // climb rate must not leak into it
    const state = stateWith({ airspeed: 100, velocity: { x: 150, y: 30, z: 200 } });
    const display = displayStateFromVisual(state, AIRLINER);
    expect(display.groundSpeedKt).toBeCloseTo(250 * 1.94384, 6);
    expect(display.groundSpeedKt).not.toBeCloseTo(display.airspeedKt, 0);
    // a pure climb has no ground speed at all
    expect(displayStateFromVisual(stateWith({ velocity: { x: 0, y: 50, z: 0 } }), AIRLINER).groundSpeedKt).toBe(0);
  });

  it("passes heading, pitch and bank through as DEGREES, and wraps heading into [0, 360)", () => {
    const state = stateWith({ heading: 237.5, pitch: -4.25, bank: 18.5 });
    const display = displayStateFromVisual(state, AIRLINER);
    expect(display.headingDeg).toBeCloseTo(hud.heading(state), 6);
    expect(display.headingDeg).toBeCloseTo(237.5, 6);
    expect(display.pitchDeg).toBeCloseTo(-4.25, 6);
    expect(display.bankDeg).toBeCloseTo(18.5, 6);
    // the control that catches a radians conversion: 237.5 degrees is NOT 237.5 radians in disguise
    expect(display.headingDeg).not.toBeCloseTo((237.5 * 180) / Math.PI % 360, 0);
    for (const [raw, wrapped] of [[-10, 350], [370, 10], [720, 0]] as const) {
      expect(displayStateFromVisual(stateWith({ heading: raw }), AIRLINER).headingDeg).toBeCloseTo(wrapped, 6);
    }
  });

  it("gives one N1 per engine, gear only at down-and-locked, flap in degrees and throttle in percent", () => {
    const display = displayStateFromVisual(
      stateWith({ engineRpm: 92.4, gear: 1, flaps: 0.5, throttle: 0.83, brake: 0.25 }),
      AIRLINER,
    );
    expect(display.n1Percent).toEqual([92.4, 92.4, 92.4, 92.4]);
    expect(display.gearDown).toBe(true);
    // half travel of the 747's 30 degrees
    expect(display.flapDeg).toBeCloseTo(15, 6);
    expect(display.throttlePercent).toBeCloseTo(83, 6);
    expect(display.spoilers).toBeCloseTo(0.25, 6);
    // in transit is NOT down: a display that says DOWN while the gear is still travelling is a lie
    for (const travelling of [0, 0.5, 0.98]) {
      expect(displayStateFromVisual(stateWith({ gear: travelling }), AIRLINER).gearDown).toBe(false);
    }
    // a two-engine airframe draws two gauges
    expect(displayStateFromVisual(stateWith({ engineRpm: 50 }), { engineCount: 2, fullFlapDegrees: 20 }).n1Percent).toHaveLength(2);
  });

  it("holds every reading finite when the state is not", () => {
    const rubbish = stateWith({
      airspeed: Number.NaN,
      altitude: Number.POSITIVE_INFINITY,
      verticalSpeed: Number.NaN,
      heading: Number.NaN,
      pitch: Number.NaN,
      bank: Number.NaN,
      engineRpm: Number.NaN,
      gear: Number.NaN,
      throttle: Number.NaN,
      flaps: Number.NaN,
      brake: Number.NaN,
      velocity: { x: Number.NaN, y: 0, z: Number.NaN },
    });
    const display = displayStateFromVisual(rubbish, AIRLINER);
    for (const [name, value] of Object.entries(display)) {
      if (name === "n1Percent") continue;
      if (typeof value === "number") expect(Number.isFinite(value), name).toBe(true);
    }
    for (const n1 of display.n1Percent) expect(Number.isFinite(n1)).toBe(true);
    expect(display.gearDown).toBe(false);
  });
});
