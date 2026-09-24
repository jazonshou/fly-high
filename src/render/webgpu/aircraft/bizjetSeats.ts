/**
 * THE GLOBAL'S CREW SEATS, placed FROM the pilots' eye (`catalogue.cockpitEye`)
 * so the two cannot drift apart when the eye is re-solved.
 *
 * They were one tilted box and a headrest at fixed coordinates, the box's top
 * near y 0.60: fine under the old eye at 0.78, and above a seated eye at 0.55
 * (phase 3c, part 2), which put the cushion over the pilot's eyes. A seat is
 * sat IN: the cushion is 0.80 m under the eye (a seated eye height), the back
 * stops at the shoulders, and only the headrest reaches past the eye.
 *
 * Pure geometry: `bizjetVisual.ts` builds the boxes, the tests read the same
 * numbers.
 */

import { aircraftSpec } from "../../../aircraft/catalogue";

/** The cabin floor: the published 1.88 m cabin inside the 1.345 m section puts it at or below this. */
export const GLOBAL_FLOOR_Y = -0.66;

export const GLOBAL_SEAT = Object.freeze({
  /** The cushion's top is this far below the eye: a seated eye height. */
  cushionBelowEye: 0.8,
  /** The seat's centre is this far aft of the eye (the eye is over the front of the cushion). */
  behindEye: 0.05,
  /** The base, cushion on top, from the floor up: its footprint. */
  length: 0.5,
  width: 0.5,
  /** The back stands behind the base, from the cushion to the shoulders. */
  backThickness: 0.12,
  backWidth: 0.48,
  backTopBelowEye: 0.17,
  /** The headrest, centred on the eye's height, behind the head. */
  headrestBehindSeat: 0.28,
  headrestLength: 0.24,
  headrestHeight: 0.3,
  headrestWidth: 0.4,
});

export interface SeatBox {
  /** Centre, body metres (x forward, y up); z is the seat's distance from the centreline. */
  readonly x: number;
  readonly y: number;
  readonly length: number;
  readonly height: number;
  readonly width: number;
}

export interface GlobalSeatPlacement {
  readonly base: SeatBox;
  readonly back: SeatBox;
  readonly headrest: SeatBox;
  /** Each seat's distance from the centreline: the eye's. */
  readonly z: number;
  readonly cushionTop: number;
}

/** The seats under an eye; by default the catalogue's. */
export function globalSeatPlacement(
  eye: { readonly forward: number; readonly up: number; readonly right: number } = aircraftSpec("bizjet").cockpitEye,
): GlobalSeatPlacement {
  const s = GLOBAL_SEAT;
  const cushionTop = eye.up - s.cushionBelowEye;
  if (!(cushionTop > GLOBAL_FLOOR_Y + 0.2)) throw new RangeError(`an eye at ${eye.up} puts the cushion on the floor`);
  const seatX = eye.forward - s.behindEye;
  const base = { x: seatX, y: (GLOBAL_FLOOR_Y + cushionTop) / 2, length: s.length, height: cushionTop - GLOBAL_FLOOR_Y, width: s.width };
  const backTop = eye.up - s.backTopBelowEye;
  const back = {
    x: seatX - s.length / 2 - s.backThickness / 2,
    y: (cushionTop + backTop) / 2,
    length: s.backThickness,
    height: backTop - cushionTop,
    width: s.backWidth,
  };
  const headrest = {
    x: seatX - s.headrestBehindSeat,
    y: eye.up - 0.02,
    length: s.headrestLength,
    height: s.headrestHeight,
    width: s.headrestWidth,
  };
  return { base, back, headrest, z: Math.abs(eye.right), cushionTop };
}
