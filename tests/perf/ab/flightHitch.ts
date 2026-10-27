/**
 * The one render the perf agent hands a delta other than 1/60 s: the frame of
 * an emulated hitch (`FlightRequest.hitch`), where the main thread stood still
 * while the simulation flew on. It lives here and not in agent.ts because
 * tests/render.wildlife-capture-pin.test.ts holds every render in agent.ts to
 * 1/60 s, the delta the capture's pins rest on; a hitch happens only in a
 * flight leg, never in a shot's settle or capture.
 */

import type { FlightVisualState } from "../../../src/game/types";
import type { FlightRenderer } from "../../../src/render/FlightRenderer";

/** The delta FlightGame's render loop hands the renderer after a frame this long: clamped to 1/240-0.1 s. */
export function hitchFrameDeltaSeconds(milliseconds: number): number {
  return Math.min(0.1, Math.max(1 / 240, milliseconds / 1_000));
}

export function renderAfterHitch(target: FlightRenderer, state: FlightVisualState, milliseconds: number): void {
  target.render(state, hitchFrameDeltaSeconds(milliseconds));
}
