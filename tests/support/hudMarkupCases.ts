import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { INITIAL_VISUAL_STATE, type CameraMode, type FlightVisualState } from "@/src/game/types";
import type { HudMode } from "@/src/settings";
import type { AircraftKind } from "@/src/sim";
import { Hud } from "@/src/ui/Hud";

/**
 * The HUD props the chase-view markup pin renders (tests/ui.hud-cockpit-layout.test.ts),
 * shared with the script that captured its golden
 * (tests/fixtures/hud-exterior-markup.json, captured on de91cef before the cockpit
 * layout existed). Every camera but the cockpit, both visible HUD modes, a cruise
 * state and an alert state, on every airframe, plus the unit and mouse variants.
 */
export interface HudMarkupCase {
  readonly name: string;
  readonly aircraft: AircraftKind;
  readonly mode: HudMode;
  readonly cameraMode: CameraMode;
  readonly state: FlightVisualState;
  readonly units: "aviation" | "metric";
  readonly mouseFlight: boolean;
}

const CRUISE: FlightVisualState = {
  ...INITIAL_VISUAL_STATE,
  airspeed: 62, altitudeAgl: 610, verticalSpeed: 1.2, heading: 274, pitch: 2, bank: 0,
  throttle: 0.72, trim: 0.1, engineRpm: 2_400, angleOfAttack: 3.4, loadFactor: 1, gear: 0,
  onGround: false, stalled: false, crashed: false, brake: 0,
};
const ALERTS: FlightVisualState = { ...CRUISE, stalled: true, brake: 0.5, bank: 75 };

const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "CHASE CAM", cockpit: "COCKPIT", cinematic: "ORBIT CAM", freefly: "FREE CAM",
};

export function hudMarkupCases(cameraModes: readonly CameraMode[]): HudMarkupCase[] {
  const cases: HudMarkupCase[] = [];
  for (const aircraft of ["trainer", "jet", "bizjet", "airliner"] as const) {
    for (const mode of ["full", "minimal"] as const) {
      for (const cameraMode of cameraModes) {
        for (const [stateName, state] of [["cruise", CRUISE], ["alerts", ALERTS]] as const) {
          cases.push({
            name: `${aircraft}/${mode}/${cameraMode}/${stateName}`,
            aircraft, mode, cameraMode, state, units: "aviation", mouseFlight: false,
          });
        }
      }
    }
  }
  cases.push({ name: "trainer/full/chase/cruise/metric", aircraft: "trainer", mode: "full", cameraMode: "chase", state: CRUISE, units: "metric", mouseFlight: false });
  cases.push({ name: "jet/full/chase/cruise/mouse", aircraft: "jet", mode: "full", cameraMode: "chase", state: CRUISE, units: "aviation", mouseFlight: true });
  return cases;
}

export function renderHudCase(c: HudMarkupCase): string {
  return renderToStaticMarkup(createElement(Hud, {
    state: c.state,
    aircraft: c.aircraft,
    mode: c.mode,
    flightMode: "unassisted",
    units: c.units,
    diagnostics: null,
    showDiagnostics: false,
    cameraMode: c.cameraMode,
    cameraLabel: CAMERA_LABELS[c.cameraMode],
    seedLabel: "1Z4K9Q",
    mouseFlight: c.mouseFlight,
  }));
}

export const EXTERIOR_CAMERAS: readonly CameraMode[] = ["chase", "cinematic", "freefly"];
