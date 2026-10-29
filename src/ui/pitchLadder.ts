/**
 * The HUD's pitch ladder, drawn CONFORMAL: through the very camera the frame was
 * rendered with, so that it lies on the world it describes.
 *
 * The zero line is the horizon, where the camera sees it; the rung marked 10 is
 * where a line of sight 10 degrees above the horizon, in the nose's direction,
 * meets the screen; and the aircraft symbol is where the nose points. Read
 * against each other, the symbol and the rungs give the pitch, and the rungs'
 * tilt is the tilt of the horizon in the picture.
 *
 * The ladder this replaced (until 2026-10-28) was a fixed drawing at the screen's
 * centre, 2.25 px a degree and turned by the full bank, and was wrong almost
 * everywhere. A degree spans 22 px in the cockpit and 26 to 29 px in the chase
 * views on a 1080p screen, so it moved a tenth as far as the world did. The chase
 * cameras look down on the aeroplane, so in level flight the real horizon is
 * 125 to 205 px above the centre on the F-16 and the trainer and 316 px on the
 * 747, where its zero line never went. And the chase camera follows only 18% of
 * the bank, so in a 60 degree bank the real horizon tilts 10 degrees and its zero
 * line crossed it at 50. In the cockpit the camera IS the body, so there only
 * the scale was wrong.
 *
 * Geometry here, writing to the page in `applyPitchLadder`, per frame and without
 * allocating, as the nearest-airport marker does (src/ui/airportMarker.ts).
 */
import type { HudCamera } from "@/src/render/types";

/** Every line of the ladder, degrees: one each 5 from the nadir to the zenith, the horizon (0) among them. */
export const PITCH_LADDER_PITCHES: readonly number[] = Object.freeze(
  Array.from({ length: 37 }, (_, index) => -90 + 5 * index),
);

/**
 * The window the ladder shows through, CSS pixels (flight.css `.pitch-ladder`),
 * centred on the nose and faded toward its edges. A degree spans 22 to 29 px on
 * a 1080p screen, so this shows the rungs 5 degrees either side of the nose; a
 * window the attitude box's size (340 x 230) lost the horizon beyond about 4
 * degrees of pitch in the chase views. In the cockpit the nose is the screen's
 * centre and so is the window, which is what keeps the deck-line clip there valid.
 */
export const PITCH_LADDER_WINDOW = Object.freeze({ width: 420, height: 340 });

/**
 * How far the window keeps from the screen's sides: inboard of the speed and
 * altitude tapes, whose inner edges are 146 px in. The chase cameras put the
 * nose up to 316 px above the centre on a 1080p screen (the 747's), so the top
 * margin is the one that matters there; it keeps the window under the top line.
 */
export const PITCH_LADDER_SIDE_MARGIN = 150;
export const PITCH_LADDER_TOP_MARGIN = 40;

/** How far from the window's centre a rung's middle can be and still show some of itself in it. */
const RUNG_REACH = Math.hypot(PITCH_LADDER_WINDOW.width, PITCH_LADDER_WINDOW.height) / 2 + 140;
/** Half the drawn length of the horizon line (Hud.tsx): longer than any window it crosses. */
export const PITCH_LADDER_HORIZON_HALF_LENGTH = 1_200;

const DEGREES = 180 / Math.PI;
/** The clip w below which a direction is treated as beside or behind the camera. */
const IN_FRONT = 1e-6;

export interface PitchLadderRung {
  /** Degrees above the horizon. */
  readonly pitch: number;
  /** Drawn this frame: in front of the camera and close enough to the window to show in it. */
  visible: boolean;
  /**
   * The rung's middle, CSS px from the WINDOW's centre, y down. Written for
   * every rung in front of the camera, drawn or not; left as it was otherwise.
   */
  x: number;
  y: number;
  /**
   * The way the rung runs on the screen, radians clockwise from the screen's +x:
   * its end on the aircraft's right when the wings are level. Its local +y
   * (90 degrees clockwise from that) therefore points to LOWER pitch, which is
   * how the drawn tips find the horizon.
   */
  angle: number;
}

export interface PitchLadderFrame {
  /** False when there is nothing to draw: no viewport, or the nose beside or behind the camera. */
  visible: boolean;
  /** Where the nose points, CSS px from the VIEWPORT's centre, y down. */
  noseX: number;
  noseY: number;
  /** The way the aircraft's wings run through the nose on the screen, radians clockwise: the symbol's tilt. */
  wingAngle: number;
  /** The window's centre, CSS px from the viewport's centre: the nose, kept clear of the screen's edges. */
  windowX: number;
  windowY: number;
  /** The nose's pitch, degrees. */
  pitch: number;
  /** Index-aligned with `PITCH_LADDER_PITCHES`. */
  readonly rungs: PitchLadderRung[];
}

export function createPitchLadderFrame(): PitchLadderFrame {
  return {
    visible: false,
    noseX: 0,
    noseY: 0,
    wingAngle: 0,
    windowX: 0,
    windowY: 0,
    pitch: 0,
    rungs: PITCH_LADDER_PITCHES.map((pitch) => ({ pitch, visible: false, x: 0, y: 0, angle: 0 })),
  };
}

/**
 * The screen direction, radians clockwise from +x, in which the image of the
 * direction (`x`, `y`, `w` in clip space) moves when it turns toward (`dx`,
 * `dy`, `dz`): the derivative of the perspective divide. 1/w^2 > 0 leaves the
 * angle alone, so it is dropped.
 */
function screenAngle(
  m: ArrayLike<number>,
  x: number,
  y: number,
  w: number,
  dx: number,
  dy: number,
  dz: number,
  halfWidth: number,
  halfHeight: number,
): number {
  const ddx = dx * m[0]! + dy * m[4]! + dz * m[8]!;
  const ddy = dx * m[1]! + dy * m[5]! + dz * m[9]!;
  const ddw = dx * m[3]! + dy * m[7]! + dz * m[11]!;
  return Math.atan2(-(ddy * w - y * ddw) * halfHeight, (ddx * w - x * ddw) * halfWidth);
}

/**
 * The ladder for one frame, written into `frame`, from the camera the frame was
 * drawn with (`FlightRenderingSystem.readHudCameraToRef`). Only DIRECTIONS are
 * projected, so where the camera stands does not matter: only which way it
 * looks, how it is rolled, and its lens.
 */
export function pitchLadderToRef(camera: Readonly<HudCamera>, frame: PitchLadderFrame): PitchLadderFrame {
  frame.visible = false;
  for (const rung of frame.rungs) rung.visible = false;
  const { width, height, forward, up } = camera;
  if (!(width > 0 && height > 0)) return frame;
  const m = camera.transform;
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  // The nose.
  const forwardLength = Math.hypot(forward.x, forward.y, forward.z);
  if (!(forwardLength > 0) || !Number.isFinite(forwardLength)) return frame;
  const fx = forward.x / forwardLength;
  const fy = forward.y / forwardLength;
  const fz = forward.z / forwardLength;
  const noseClipX = fx * m[0]! + fy * m[4]! + fz * m[8]!;
  const noseClipY = fx * m[1]! + fy * m[5]! + fz * m[9]!;
  const noseClipW = fx * m[3]! + fy * m[7]! + fz * m[11]!;
  if (!(noseClipW > IN_FRONT)) return frame;
  const noseX = (noseClipX / noseClipW) * halfWidth;
  const noseY = (-noseClipY / noseClipW) * halfHeight;
  if (!Number.isFinite(noseX) || !Number.isFinite(noseY)) return frame;
  // The right wing as the screen shows it: forward x up, in Babylon's
  // right-handed scene.
  const rightX = fy * up.z - fz * up.y;
  const rightY = fz * up.x - fx * up.z;
  const rightZ = fx * up.y - fy * up.x;

  // The nose's direction on the horizon: the meridian every rung sits on. Within
  // a whisker of the vertical it has none, and the roof's is used: pulled up to
  // the zenith the nose came from where the roof now points away from, pushed
  // down to the nadir from where it points.
  let azimuthX = fx;
  let azimuthZ = fz;
  if (Math.hypot(azimuthX, azimuthZ) < 1e-6) {
    const toward = fy > 0 ? -1 : 1;
    azimuthX = toward * up.x;
    azimuthZ = toward * up.z;
  }
  const azimuthLength = Math.hypot(azimuthX, azimuthZ);
  if (!(azimuthLength > 0)) return frame;
  azimuthX /= azimuthLength;
  azimuthZ /= azimuthLength;
  // Along the horizon to the right: azimuth x world up, the aircraft's right
  // when its wings are level.
  const alongX = -azimuthZ;
  const alongZ = azimuthX;

  const maxWindowX = Math.max(0, halfWidth - PITCH_LADDER_WINDOW.width / 2 - PITCH_LADDER_SIDE_MARGIN);
  const maxWindowY = Math.max(0, halfHeight - PITCH_LADDER_WINDOW.height / 2 - PITCH_LADDER_TOP_MARGIN);
  const windowX = Math.max(-maxWindowX, Math.min(maxWindowX, noseX));
  const windowY = Math.max(-maxWindowY, Math.min(maxWindowY, noseY));

  frame.noseX = noseX;
  frame.noseY = noseY;
  frame.wingAngle = screenAngle(m, noseClipX, noseClipY, noseClipW, rightX, rightY, rightZ, halfWidth, halfHeight);
  frame.windowX = windowX;
  frame.windowY = windowY;
  frame.pitch = Math.asin(Math.max(-1, Math.min(1, fy))) * DEGREES;
  frame.visible = Number.isFinite(frame.wingAngle);
  if (!frame.visible) return frame;

  const halfDiagonal = Math.hypot(PITCH_LADDER_WINDOW.width, PITCH_LADDER_WINDOW.height) / 2;
  for (const rung of frame.rungs) {
    const elevation = rung.pitch / DEGREES;
    const horizontal = Math.cos(elevation);
    const dx = horizontal * azimuthX;
    const dy = Math.sin(elevation);
    const dz = horizontal * azimuthZ;
    const clipX = dx * m[0]! + dy * m[4]! + dz * m[8]!;
    const clipY = dx * m[1]! + dy * m[5]! + dz * m[9]!;
    const clipW = dx * m[3]! + dy * m[7]! + dz * m[11]!;
    if (!(clipW > IN_FRONT)) continue;
    const x = (clipX / clipW) * halfWidth - windowX;
    const y = (-clipY / clipW) * halfHeight - windowY;
    const angle = screenAngle(m, clipX, clipY, clipW, alongX, 0, alongZ, halfWidth, halfHeight);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angle)) continue;
    rung.x = x;
    rung.y = y;
    rung.angle = angle;
    if (rung.pitch === 0) {
      // The horizon is a great circle, so its image is a straight line: it
      // shows when that line crosses the window, wherever along it its middle is.
      const across = Math.abs(x * Math.sin(angle) - y * Math.cos(angle));
      const along = Math.abs(x * Math.cos(angle) + y * Math.sin(angle));
      rung.visible = across <= halfDiagonal && along <= PITCH_LADDER_HORIZON_HALF_LENGTH - halfDiagonal;
    } else {
      rung.visible = Math.hypot(x, y) <= RUNG_REACH;
    }
  }
  return frame;
}

/** What the ladder's elements last showed, so a frame that changes nothing writes nothing. */
export interface PitchLadderView {
  readonly element: HTMLElement;
  readonly window: HTMLElement | null;
  readonly aircraft: HTMLElement | null;
  /** Index-aligned with `PITCH_LADDER_PITCHES`; null where the markup has no such line. */
  readonly rungs: readonly (Element | null)[];
  shown: boolean;
  windowTransform: string;
  aircraftTransform: string;
  readonly rungShown: boolean[];
  readonly rungTransform: string[];
}

export function createPitchLadderView(element: HTMLElement): PitchLadderView {
  return {
    element,
    window: element.querySelector<HTMLElement>("[data-pitch-ladder-window]"),
    aircraft: element.querySelector<HTMLElement>("[data-pitch-ladder-aircraft]"),
    rungs: PITCH_LADDER_PITCHES.map((pitch) => element.querySelector(`[data-pitch="${pitch}"]`)),
    shown: !element.hidden,
    windowTransform: "",
    aircraftTransform: "",
    rungShown: PITCH_LADDER_PITCHES.map(() => false),
    rungTransform: PITCH_LADDER_PITCHES.map(() => ""),
  };
}

/** Quarter pixels and tenths of a degree: finer than shows, coarse enough that a still frame writes nothing. */
const px = (value: number): number => Math.round(value * 4) / 4;
const deg = (radians: number): number => Math.round(radians * DEGREES * 10) / 10;

/**
 * Writes a frame onto the ladder's elements: transforms and the rungs' `display`
 * only, so the per-frame update never forces a layout, and only what changed.
 * React renders the markup once and never sets these, so it does not undo them.
 */
export function applyPitchLadder(view: PitchLadderView, frame: PitchLadderFrame | null): void {
  if (!frame || !frame.visible) {
    if (view.shown) {
      view.element.hidden = true;
      view.shown = false;
    }
    return;
  }
  if (!view.shown) {
    view.element.hidden = false;
    view.shown = true;
  }
  const windowTransform = `translate3d(${px(frame.windowX)}px, ${px(frame.windowY)}px, 0)`;
  if (view.window && windowTransform !== view.windowTransform) {
    view.window.style.transform = windowTransform;
    view.windowTransform = windowTransform;
  }
  const aircraftTransform = `translate(-50%, -50%) translate3d(${px(frame.noseX - frame.windowX)}px, `
    + `${px(frame.noseY - frame.windowY)}px, 0) rotate(${deg(frame.wingAngle)}deg)`;
  if (view.aircraft && aircraftTransform !== view.aircraftTransform) {
    view.aircraft.style.transform = aircraftTransform;
    view.aircraftTransform = aircraftTransform;
  }
  for (let index = 0; index < frame.rungs.length; index += 1) {
    const element = view.rungs[index];
    if (!element) continue;
    const rung = frame.rungs[index]!;
    if (rung.visible !== view.rungShown[index]) {
      element.setAttribute("display", rung.visible ? "inline" : "none");
      view.rungShown[index] = rung.visible;
    }
    if (!rung.visible) continue;
    const transform = `translate(${px(rung.x)} ${px(rung.y)}) rotate(${deg(rung.angle)})`;
    if (transform !== view.rungTransform[index]) {
      element.setAttribute("transform", transform);
      view.rungTransform[index] = transform;
    }
  }
}
