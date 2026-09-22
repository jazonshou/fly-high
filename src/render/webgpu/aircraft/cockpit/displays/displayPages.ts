import type { DisplayContext2D, DisplayPaint, DisplayState } from "./displayState";

/**
 * The 747-400's four glass-cockpit pages, drawn flat onto a 2D canvas context:
 * the PFD, the ND in its expanded-arc map mode, and the upper and lower EICAS.
 * Whoever paints a DynamicTexture calls one page per screen, or `drawDisplayAtlas`
 * for all six screens at once on one texture.
 *
 * THREE RULES, and the tests hold each:
 *  - DETERMINISTIC. No clock, no randomness: the same state draws the same
 *    call log, so a texture need only be repainted when the state changes.
 *  - RESOLUTION-INDEPENDENT. Every length is a fraction of the page's width
 *    or height, laid out for the 747's 0.22 x 0.15 m screens (aspect 1.47,
 *    `AIRLINER_SCREENS`) and sensible on a square. Fonts are
 *    `Math.round(h * factor)px`, and nothing measures text.
 *  - FINITE. Any finite state draws finite arguments: every reading is clamped
 *    or wrapped before it becomes a coordinate, tapes iterate by count and not
 *    by accumulating a value, and nothing divides by an engine count of zero.
 *
 * COLOURS are Boeing's: white for scales and boxes, green for what is active,
 * magenta for what is commanded, cyan for labels and ranges, amber for
 * cautions, and a blue-over-brown attitude ball.
 */
export const DISPLAY_COLOURS = Object.freeze({
  background: "#000",
  white: "#fff",
  green: "#00ff5a",
  magenta: "#ff4dff",
  cyan: "#33e0ff",
  amber: "#ffb000",
  red: "#ff2a2a",
  sky: "#1e6fd9",
  ground: "#7a4b1e",
  /** The tapes' backing: Boeing's tapes sit on a grey band, not on the black. */
  tape: "#3c3c3c",
});

const DEG = Math.PI / 180;
/** Canvas angles run clockwise from 3 o'clock, so 12 o'clock is a quarter turn back. */
const TWELVE_OCLOCK = -Math.PI / 2;

export type DisplayPage = "pfd" | "nd" | "eicas-upper" | "eicas-lower";
export type DrawPage = (ctx: DisplayContext2D, w: number, h: number, state: DisplayState) => void;

export interface DisplaySlot {
  readonly page: DisplayPage;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// ---- arithmetic ------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function wrap360(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** The signed short way round from one heading to another, in [-180, 180). */
function headingDelta(fromDeg: number, toDeg: number): number {
  return wrap360(toDeg - fromDeg + 180) - 180;
}

/** A heading as the three-digit box shows it: 359.999 rounds to 360, which is 000. */
function headingText(headingDeg: number): string {
  return String(Math.round(wrap360(headingDeg)) % 360).padStart(3, "0");
}

// ---- primitives ----------------------------------------------------------------------

function line(ctx: DisplayContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function triangle(ctx: DisplayContext2D, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.fill();
}

/** Text at a size proportional to the page: `factor` is the font's height as a fraction of `h`. */
function text(
  ctx: DisplayContext2D,
  h: number,
  factor: number,
  s: string,
  x: number,
  y: number,
  colour: DisplayPaint,
  align: CanvasTextAlign = "center",
): void {
  ctx.font = `${Math.round(h * factor)}px monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = colour;
  ctx.fillText(s, x, y);
}

/** A white-framed black box with a white reading in it: the airspeed, altitude, heading and N1 readouts. */
function readoutBox(ctx: DisplayContext2D, h: number, factor: number, s: string, x: number, y: number, width: number, height: number): void {
  ctx.fillStyle = DISPLAY_COLOURS.background;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.005;
  ctx.strokeRect(x, y, width, height);
  text(ctx, h, factor, s, x + width - 0.08 * width, y + height / 2, DISPLAY_COLOURS.white, "right");
}

function clearPage(ctx: DisplayContext2D, w: number, h: number): void {
  ctx.setLineDash([]);
  ctx.fillStyle = DISPLAY_COLOURS.background;
  ctx.fillRect(0, 0, w, h);
}

// ---- the PFD's attitude geometry ------------------------------------------------------

/**
 * Where the PFD's ball sits: centred, a little above the middle, so the roll
 * scale and its index clear the FMA row above (index base at 0.10 h, FMA text
 * to 0.073 h) and the heading box fits under it (ball bottom 0.76 h, box top
 * 0.775 h); its radius; and half the length of the horizon line, which is four
 * radii so that the line still crosses the whole disc at the pitch clamp under
 * any bank (the offset is at most 0.625 h, the disc reaches 0.3 h past that,
 * and 1.2 h covers both with room).
 */
export function pfdGeometry(w: number, h: number): {
  readonly ballCentre: { readonly x: number; readonly y: number };
  readonly ballRadius: number;
  readonly horizonHalfLength: number;
} {
  return { ballCentre: { x: 0.5 * w, y: 0.46 * h }, ballRadius: 0.3 * h, horizonHalfLength: 1.2 * h };
}

/** Pixels the horizon moves DOWN the screen for nose-up pitch: one degree is h/40, clamped at 25 degrees so the horizon never leaves the ball. */
export function pfdHorizonOffsetPx(pitchDeg: number, h: number): number {
  return (clamp(pitchDeg, -25, 25) * h) / 40;
}

/**
 * The rotation the sky, the ground and the horizon are drawn under, for a bank.
 *
 * THE DERIVATION. In a right bank (bank > 0, right wing down) the aeroplane has
 * rolled clockwise about its nose, so the world, seen from the seat, has turned
 * ANTI-clockwise: the horizon's right end rises and its left end drops; at a full
 * 90 degrees it is vertical with the ground on the right. The renderer already
 * holds the 3D ball to exactly this (`tests/render.cockpit-instruments.test.ts`,
 * "the right end of the horizon UP (smaller y)", measured against the world
 * horizon projected through the cockpit camera), and the HUD draws its horizon
 * with CSS `rotate(-bank)`. A canvas `rotate(a)` with a positive `a` turns
 * CLOCKWISE on the screen, because y runs down: the local point (1, 0) lands at
 * (cos a, sin a), which is right and DOWN. The horizon is the local segment
 * (-L, 0) to (L, 0), so its right end lands at y = L sin a, and for that to be
 * ABOVE the left end (smaller y) in a right bank, `a` must be negative: MINUS
 * the bank. The test holds the drawn endpoints to it.
 */
export function attitudeRotationRadians(bankDeg: number): number {
  return -bankDeg * DEG;
}

// ---- the PFD ---------------------------------------------------------------------------

/** The sky, the ground, the horizon and the pitch ladder, inside the ball's disc, under bank and pitch. */
function drawAttitudeBall(ctx: DisplayContext2D, w: number, h: number, state: DisplayState): void {
  const { ballCentre, ballRadius, horizonHalfLength: L } = pfdGeometry(w, h);
  const pxPerDeg = h / 40;
  ctx.save();
  ctx.beginPath();
  ctx.arc(ballCentre.x, ballCentre.y, ballRadius, 0, 2 * Math.PI);
  ctx.clip();
  ctx.translate(ballCentre.x, ballCentre.y);
  ctx.rotate(attitudeRotationRadians(state.bankDeg));
  const offset = pfdHorizonOffsetPx(state.pitchDeg, h);
  ctx.translate(0, offset);
  ctx.fillStyle = DISPLAY_COLOURS.sky;
  ctx.fillRect(-L, -L, 2 * L, L);
  ctx.fillStyle = DISPLAY_COLOURS.ground;
  ctx.fillRect(-L, 0, 2 * L, L);
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.006;
  line(ctx, -L, 0, L, 0);
  // The ladder: nose-up degrees are ABOVE the horizon (smaller y), so that when the
  // aeroplane pitches up and the horizon drops, the matching rung meets the symbol.
  // A rung is a horizontal line at one height on the ball, and the rotation keeps
  // every point's distance from the centre, so a rung further from the centre than
  // the radius is wholly outside the disc under any bank: it is not drawn, which
  // keeps its numbers' anchors on the page as well as its ink off the clip.
  const rungs = [-20, -15, -10, -5, 5, 10, 15, 20].filter((deg) => Math.abs(offset - deg * pxPerDeg) <= ballRadius);
  ctx.lineWidth = h * 0.004;
  const numberedHalf = 0.12 * h;
  for (const deg of rungs) {
    const half = deg % 10 === 0 ? numberedHalf : 0.06 * h;
    line(ctx, -half, -deg * pxPerDeg, half, -deg * pxPerDeg);
  }
  // Its numbers stand on blue and brown: a thin black halo keeps them legible at a texture's few pixels a glyph.
  ctx.font = `${Math.round(h * 0.04)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = DISPLAY_COLOURS.background;
  ctx.lineWidth = h * 0.008;
  ctx.fillStyle = DISPLAY_COLOURS.white;
  for (const deg of rungs.filter((rung) => rung % 10 === 0)) {
    for (const x of [-numberedHalf - 0.05 * h, numberedHalf + 0.05 * h]) {
      ctx.strokeText(String(Math.abs(deg)), x, -deg * pxPerDeg);
      ctx.fillText(String(Math.abs(deg)), x, -deg * pxPerDeg);
    }
  }
  ctx.restore();
}

/**
 * The roll scale is FIXED to the screen and the pointer turns with the sky: a
 * Boeing sky pointer, which points at the zenith, so in a right bank it sits
 * left of the fixed index (the same rotation as the horizon, minus the bank).
 */
function drawRollScale(ctx: DisplayContext2D, w: number, h: number, bankDeg: number): void {
  const { ballCentre, ballRadius } = pfdGeometry(w, h);
  const R = ballRadius * 1.04;
  ctx.save();
  ctx.translate(ballCentre.x, ballCentre.y);
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.005;
  ctx.beginPath();
  ctx.arc(0, 0, R, TWELVE_OCLOCK - 60 * DEG, TWELVE_OCLOCK + 60 * DEG);
  ctx.stroke();
  // no tick at zero: the fixed index IS the zero mark, as on Boeing's scale
  for (const deg of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const length = deg % 30 === 0 ? 0.05 * h : 0.03 * h;
    const a = deg * DEG;
    line(ctx, R * Math.sin(a), -R * Math.cos(a), (R + length) * Math.sin(a), -(R + length) * Math.cos(a));
  }
  ctx.fillStyle = DISPLAY_COLOURS.white;
  const t = 0.03 * h;
  // the fixed index, seated on the arc and pointing down at it
  triangle(ctx, 0, -R - 0.005 * h, -t, -R - 0.005 * h - 1.4 * t, t, -R - 0.005 * h - 1.4 * t);
  ctx.rotate(attitudeRotationRadians(bankDeg));
  // the sky pointer, inside the arc, pointing up at the scale
  triangle(ctx, 0, -R + 0.01 * h, -t, -R + 0.01 * h + 1.4 * t, t, -R + 0.01 * h + 1.4 * t);
  ctx.restore();
}

/** The aeroplane: two wing bars and a centre square, white-edged black, fixed at the ball's centre. */
function drawAircraftSymbol(ctx: DisplayContext2D, w: number, h: number): void {
  const { ballCentre: c } = pfdGeometry(w, h);
  ctx.fillStyle = DISPLAY_COLOURS.background;
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.006;
  const barLength = 0.12 * h;
  const barHeight = 0.018 * h;
  for (const x of [c.x - 0.26 * h, c.x + 0.26 * h - barLength]) {
    ctx.fillRect(x, c.y - barHeight / 2, barLength, barHeight);
    ctx.strokeRect(x, c.y - barHeight / 2, barLength, barHeight);
  }
  const square = 0.024 * h;
  ctx.fillRect(c.x - square / 2, c.y - square / 2, square, square);
  ctx.strokeRect(c.x - square / 2, c.y - square / 2, square, square);
}

interface TapeSpec {
  /** The tape's rectangle on the page. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The reading the tape is centred on. */
  readonly value: number;
  /** Units from the centre to the top or bottom edge. */
  readonly halfRange: number;
  readonly tickEvery: number;
  readonly labelEvery: number;
  /** Ticks below this are not drawn (an airspeed tape has no negative side); null for none. */
  readonly floor: number | null;
  /** Ticks on the tape's right edge (airspeed, facing the ball) or its left (altitude). */
  readonly ticksOnRight: boolean;
}

/** A vertical tape that slides so its centre reads `value`; larger values are higher on the screen. */
function drawTape(ctx: DisplayContext2D, h: number, spec: TapeSpec): void {
  const centreY = spec.y + spec.height / 2;
  const pxPerUnit = spec.height / 2 / spec.halfRange;
  const first = Math.ceil((spec.value - spec.halfRange) / spec.tickEvery) * spec.tickEvery;
  // by count, not by accumulating: adding a tick to a huge value never advances it
  const count = Math.floor((2 * spec.halfRange) / spec.tickEvery) + 1;
  const tickX = spec.ticksOnRight ? spec.x + spec.width : spec.x;
  const tickDirection = spec.ticksOnRight ? -1 : 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(spec.x, spec.y, spec.width, spec.height);
  ctx.clip();
  ctx.fillStyle = DISPLAY_COLOURS.tape;
  ctx.fillRect(spec.x, spec.y, spec.width, spec.height);
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.004;
  for (let k = 0; k < count; k += 1) {
    const v = first + k * spec.tickEvery;
    if (spec.floor !== null && v < spec.floor) continue;
    const y = centreY - (v - spec.value) * pxPerUnit;
    const labelled = v % spec.labelEvery === 0;
    const length = labelled ? 0.035 * h : 0.02 * h;
    line(ctx, tickX, y, tickX + tickDirection * length, y);
    if (labelled) {
      const labelX = tickX + tickDirection * (length + 0.01 * h);
      text(ctx, h, 0.04, String(v), labelX, y, DISPLAY_COLOURS.white, spec.ticksOnRight ? "right" : "left");
    }
  }
  ctx.restore();
}

function drawAirspeedTape(ctx: DisplayContext2D, w: number, h: number, airspeedKt: number): void {
  const { ballCentre, ballRadius } = pfdGeometry(w, h);
  const tape = { x: 0.05 * w, y: ballCentre.y - ballRadius, width: 0.14 * w, height: 2 * ballRadius };
  drawTape(ctx, h, { ...tape, value: airspeedKt, halfRange: 60, tickEvery: 10, labelEvery: 20, floor: 0, ticksOnRight: true });
  // The readout box overhangs the tape's inner edge, as Boeing's does, so its pointer edge touches the scale.
  readoutBox(ctx, h, 0.06, String(Math.round(airspeedKt)), tape.x, ballCentre.y - 0.04 * h, tape.width + 0.02 * w, 0.08 * h);
}

/** The altitude readout is rounded to 20 feet, Boeing's resolution, and drawn as plain digits: "5000". */
function drawAltitudeTape(ctx: DisplayContext2D, w: number, h: number, altitudeFt: number): void {
  const { ballCentre, ballRadius } = pfdGeometry(w, h);
  const tape = { x: 0.8 * w, y: ballCentre.y - ballRadius, width: 0.13 * w, height: 2 * ballRadius };
  drawTape(ctx, h, { ...tape, value: altitudeFt, halfRange: 600, tickEvery: 100, labelEvery: 500, floor: null, ticksOnRight: false });
  readoutBox(ctx, h, 0.06, String(Math.round(altitudeFt / 20) * 20), tape.x - 0.02 * w, ballCentre.y - 0.04 * h, tape.width + 0.02 * w, 0.08 * h);
}

/** Vertical speed: a linear scale to 3,000 feet a minute either way, a needle to the reading, and digits beyond 100. */
function drawVerticalSpeed(ctx: DisplayContext2D, w: number, h: number, verticalSpeedFpm: number): void {
  const { ballCentre } = pfdGeometry(w, h);
  const scaleX = 0.955 * w;
  const halfHeight = 0.25 * h;
  const pxPerFpm = halfHeight / 3000;
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.004;
  line(ctx, scaleX, ballCentre.y - halfHeight, scaleX, ballCentre.y + halfHeight);
  for (const fpm of [-2000, -1000, 0, 1000, 2000]) {
    const y = ballCentre.y - fpm * pxPerFpm;
    line(ctx, scaleX, y, scaleX + 0.015 * w, y);
    if (fpm !== 0) text(ctx, h, 0.035, String(Math.abs(fpm) / 1000), scaleX + 0.03 * w, y, DISPLAY_COLOURS.white);
  }
  const needleY = ballCentre.y - clamp(verticalSpeedFpm, -3000, 3000) * pxPerFpm;
  ctx.lineWidth = h * 0.006;
  line(ctx, 0.995 * w, ballCentre.y, scaleX, needleY);
  if (Math.abs(verticalSpeedFpm) > 100) {
    const digits = String(Math.round(Math.abs(verticalSpeedFpm) / 50) * 50);
    const y = verticalSpeedFpm > 0 ? ballCentre.y - halfHeight - 0.04 * h : ballCentre.y + halfHeight + 0.04 * h;
    text(ctx, h, 0.04, digits, scaleX + 0.02 * w, y, DISPLAY_COLOURS.white, "right");
  }
}

/** The heading strip under the ball: 40 degrees either side of the heading, ticks every 10, the tens labelled every 30, the heading boxed above. */
function drawHeadingStrip(ctx: DisplayContext2D, w: number, h: number, headingDeg: number): void {
  const heading = wrap360(headingDeg);
  const left = 0.22 * w;
  const right = 0.78 * w;
  const centreX = 0.5 * w;
  const top = 0.87 * h;
  const pxPerDeg = (right - left) / 80;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, h - top);
  ctx.clip();
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.004;
  line(ctx, left, top, right, top);
  const base = Math.round(heading / 10) * 10;
  for (let k = -5; k <= 5; k += 1) {
    const tick = base + k * 10;
    const x = centreX + headingDelta(heading, tick) * pxPerDeg;
    const labelled = tick % 30 === 0;
    line(ctx, x, top, x, top + (labelled ? 0.035 * h : 0.02 * h));
    if (labelled) text(ctx, h, 0.04, String(wrap360(tick) / 10), x, top + 0.07 * h, DISPLAY_COLOURS.white);
  }
  ctx.restore();
  ctx.fillStyle = DISPLAY_COLOURS.white;
  triangle(ctx, centreX, top, centreX - 0.015 * h, top - 0.025 * h, centreX + 0.015 * h, top - 0.025 * h);
  readoutBox(ctx, h, 0.05, headingText(headingDeg), centreX - 0.06 * w, 0.775 * h, 0.12 * w, 0.065 * h);
}

/** The flight-mode annunciator: fixed placeholders until an autopilot exists to report modes. */
function drawFma(ctx: DisplayContext2D, w: number, h: number): void {
  for (const [x, mode] of [
    [0.3, "SPD"],
    [0.5, "LNAV"],
    [0.7, "VNAV PTH"],
  ] as const) {
    text(ctx, h, 0.045, mode, x * w, 0.05 * h, DISPLAY_COLOURS.green);
  }
}

export const drawPfd: DrawPage = (ctx, w, h, state) => {
  clearPage(ctx, w, h);
  drawAttitudeBall(ctx, w, h, state);
  drawRollScale(ctx, w, h, state.bankDeg);
  drawAircraftSymbol(ctx, w, h);
  drawAirspeedTape(ctx, w, h, state.airspeedKt);
  drawAltitudeTape(ctx, w, h, state.altitudeFtMsl);
  drawVerticalSpeed(ctx, w, h, state.verticalSpeedFpm);
  drawHeadingStrip(ctx, w, h, state.headingDeg);
  drawFma(ctx, w, h);
};

// ---- the ND ----------------------------------------------------------------------------

/**
 * Expanded-arc map mode at a 40 nm range: own ship at the bottom centre, the
 * compass arc 60 degrees either side of the heading with the heading at the
 * top, a dashed ring at half range, and the track straight up. The arc's
 * radius is the smaller of 0.68 h and 0.52 w so the labels beyond it stay on the
 * page on the 747's 1.47 aspect and on a square alike.
 */
export const drawNd: DrawPage = (ctx, w, h, state) => {
  clearPage(ctx, w, h);
  const heading = wrap360(state.headingDeg);
  const own = { x: 0.5 * w, y: 0.86 * h };
  const R = Math.min(0.68 * h, 0.52 * w);
  ctx.save();
  ctx.translate(own.x, own.y);
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.004;
  ctx.setLineDash([0.02 * h, 0.02 * h]);
  for (const [fraction, range] of [
    [0.5, "20"],
    [1, "40"],
  ] as const) {
    ctx.beginPath();
    ctx.arc(0, 0, R * fraction, TWELVE_OCLOCK - 60 * DEG, TWELVE_OCLOCK + 60 * DEG);
    ctx.stroke();
    const a = -55 * DEG;
    text(ctx, h, 0.04, range, R * fraction * Math.sin(a) - 0.01 * w, -R * fraction * Math.cos(a), DISPLAY_COLOURS.cyan, "right");
  }
  ctx.setLineDash([]);
  const base = Math.round(heading / 10) * 10;
  for (let k = -6; k <= 6; k += 1) {
    const tick = base + k * 10;
    const delta = headingDelta(heading, tick);
    if (Math.abs(delta) > 60) continue;
    const a = delta * DEG;
    const labelled = tick % 30 === 0;
    const length = labelled ? 0.035 * h : 0.02 * h;
    line(ctx, R * Math.sin(a), -R * Math.cos(a), (R + length) * Math.sin(a), -(R + length) * Math.cos(a));
    if (labelled) {
      text(ctx, h, 0.04, String(wrap360(tick) / 10), (R + 0.055 * h) * Math.sin(a), -(R + 0.055 * h) * Math.cos(a), DISPLAY_COLOURS.white);
    }
  }
  ctx.strokeStyle = DISPLAY_COLOURS.magenta;
  ctx.lineWidth = h * 0.006;
  line(ctx, 0, 0, 0, -R);
  ctx.fillStyle = DISPLAY_COLOURS.white;
  triangle(ctx, 0, -0.035 * h, -0.025 * h, 0.02 * h, 0.025 * h, 0.02 * h);
  ctx.restore();
  // the heading box at the top, its digits framed, and the pointer under it at the arc's top
  text(ctx, h, 0.045, "HDG", 0.5 * w - 0.07 * w, 0.06 * h, DISPLAY_COLOURS.cyan, "right");
  readoutBox(ctx, h, 0.05, headingText(state.headingDeg), 0.5 * w - 0.055 * w, 0.025 * h, 0.11 * w, 0.07 * h);
  text(ctx, h, 0.045, "MAG", 0.5 * w + 0.07 * w, 0.06 * h, DISPLAY_COLOURS.green, "left");
  ctx.fillStyle = DISPLAY_COLOURS.white;
  triangle(ctx, own.x, own.y - R, own.x - 0.015 * h, own.y - R - 0.03 * h, own.x + 0.015 * h, own.y - R - 0.03 * h);
  // ground speed and true airspeed, top left: cyan labels, white values
  text(ctx, h, 0.045, "GS", 0.02 * w, 0.06 * h, DISPLAY_COLOURS.cyan, "left");
  text(ctx, h, 0.045, String(Math.round(state.groundSpeedKt)), 0.08 * w, 0.06 * h, DISPLAY_COLOURS.white, "left");
  text(ctx, h, 0.045, "TAS", 0.2 * w, 0.06 * h, DISPLAY_COLOURS.cyan, "left");
  text(ctx, h, 0.045, String(Math.round(state.airspeedKt)), 0.28 * w, 0.06 * h, DISPLAY_COLOURS.white, "left");
};

// ---- the EICAS's gauges ---------------------------------------------------------------

/** An arc gauge sweeps 225 degrees clockwise from 7:30 to 3 o'clock, the readout in the open sector under it. */
const GAUGE_SWEEP = 225 * DEG;
const GAUGE_START = 135 * DEG;
const N1_FULL_SCALE = 110;
const EGT_FULL_SCALE = 1000;

/** The angle, canvas convention, of a fraction of a gauge's full scale; clamped, so an over-limit reading pins the needle. */
function gaugeAngle(fraction: number): number {
  return GAUGE_START + GAUGE_SWEEP * clamp(fraction, 0, 1);
}

export interface DialPlacement {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * Where the upper EICAS puts one dial per engine: across the left four-fifths
 * of the page (the right fifth holds the flap gauge), radius the smaller of
 * 0.15 h and two-fifths of the pitch so four fit on the 747's aspect and one
 * does not balloon. `rowY` and `radiusScale` place the smaller EGT row.
 */
export function eicasDialLayout(w: number, h: number, engineCount: number, rowY = 0.3, radiusScale = 1): readonly DialPlacement[] {
  const placements: DialPlacement[] = [];
  const pitch = (0.8 * w) / Math.max(engineCount, 1);
  const radius = Math.min(0.15 * h, 0.4 * pitch) * radiusScale;
  for (let i = 0; i < engineCount; i += 1) placements.push({ x: pitch * (i + 0.5), y: rowY * h, radius });
  return placements;
}

interface GaugeSpec {
  readonly fraction: number;
  readonly tickFractions: readonly number[];
  readonly redlineFraction: number;
  /** A magenta command bug on the arc, or null for a gauge nothing commands. */
  readonly commandFraction: number | null;
}

/**
 * The gauge's arc, ticks, redline, command bug and needle, drawn at unit
 * radius under a scale so one routine serves the N1 row and the smaller EGT
 * row; line widths are in radii and scale with it. Text is NOT drawn here: a
 * font under a scale would round to zero pixels, so labels go on in page space.
 */
function drawArcGauge(ctx: DisplayContext2D, dial: DialPlacement, spec: GaugeSpec): void {
  const radial = (fraction: number, r0: number, r1: number) => {
    const a = gaugeAngle(fraction);
    line(ctx, r0 * Math.cos(a), r0 * Math.sin(a), r1 * Math.cos(a), r1 * Math.sin(a));
  };
  ctx.save();
  ctx.translate(dial.x, dial.y);
  ctx.scale(dial.radius, dial.radius);
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  ctx.arc(0, 0, 1, gaugeAngle(0), gaugeAngle(1));
  ctx.stroke();
  for (const fraction of spec.tickFractions) radial(fraction, 0.82, 1);
  ctx.strokeStyle = DISPLAY_COLOURS.red;
  ctx.lineWidth = 0.06;
  radial(spec.redlineFraction, 0.82, 1.1);
  if (spec.commandFraction !== null) {
    ctx.strokeStyle = DISPLAY_COLOURS.magenta;
    ctx.lineWidth = 0.08;
    radial(spec.commandFraction, 1.02, 1.16);
  }
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = 0.07;
  radial(spec.fraction, 0, 1);
  ctx.restore();
}

/** The labels a gauge's ticks carry, in page space, just outside the arc. */
function drawGaugeLabels(ctx: DisplayContext2D, h: number, dial: DialPlacement, labels: readonly (readonly [number, string])[]): void {
  for (const [fraction, label] of labels) {
    const a = gaugeAngle(fraction);
    text(ctx, h, 0.03, label, dial.x + 1.24 * dial.radius * Math.cos(a), dial.y + 1.24 * dial.radius * Math.sin(a), DISPLAY_COLOURS.white);
  }
}

/** A gauge's digital readout, boxed in the open sector under and right of its hub. */
function drawGaugeReadout(ctx: DisplayContext2D, h: number, dial: DialPlacement, reading: string): void {
  const r = dial.radius;
  readoutBox(ctx, h, 0.045, reading, dial.x - 0.35 * r, dial.y + 0.45 * r, 1.2 * r, 0.42 * r);
}

/** The N1 a lever commands: idle at 25 percent and 0.9 a percent of lever, so the level state's 70 percent lever commands the 88 it shows. */
function commandedN1(throttlePercent: number): number {
  return 25 + 0.9 * throttlePercent;
}

/** A stand-in EGT until the sim models one: 350 degrees C at idle and 4.2 a percent of N1 (720 at 88). */
function egtDegreesC(n1Percent: number): number {
  return 350 + n1Percent * 4.2;
}

/** The flap gauge: a vertical scale from 0 to 30 with the 747's detents ticked, the pointer at the reading. */
function drawFlapGauge(ctx: DisplayContext2D, w: number, h: number, flapDeg: number): void {
  const x = 0.9 * w;
  const top = 0.3 * h;
  const bottom = 0.72 * h;
  const pxPerDeg = (bottom - top) / 30;
  text(ctx, h, 0.04, "FLAPS", x, 0.24 * h, DISPLAY_COLOURS.cyan);
  ctx.strokeStyle = DISPLAY_COLOURS.white;
  ctx.lineWidth = h * 0.004;
  line(ctx, x, top, x, bottom);
  for (const detent of [0, 1, 5, 10, 20, 25, 30]) {
    const y = top + detent * pxPerDeg;
    line(ctx, x, y, x + 0.02 * w, y);
    text(ctx, h, 0.03, String(detent), x + 0.03 * w, y, DISPLAY_COLOURS.white, "left");
  }
  const pointerY = top + clamp(flapDeg, 0, 30) * pxPerDeg;
  ctx.fillStyle = DISPLAY_COLOURS.white;
  triangle(ctx, x, pointerY, x - 0.025 * w, pointerY - 0.02 * h, x - 0.025 * w, pointerY + 0.02 * h);
}

/**
 * Primary engine indications: a row of N1 dials, a smaller row of EGT arcs
 * under them, the air-data and fuel block along the top, the flap gauge down
 * the right, and the gear and speedbrake annunciations along the bottom.
 */
export const drawEicasUpper: DrawPage = (ctx, w, h, state) => {
  clearPage(ctx, w, h);
  text(ctx, h, 0.04, "TAT", 0.02 * w, 0.06 * h, DISPLAY_COLOURS.cyan, "left");
  text(ctx, h, 0.04, "+12c", 0.1 * w, 0.06 * h, DISPLAY_COLOURS.white, "left");
  text(ctx, h, 0.04, "TOTAL FUEL", 0.86 * w, 0.06 * h, DISPLAY_COLOURS.cyan, "right");
  text(ctx, h, 0.04, "140.0", 0.98 * w, 0.06 * h, DISPLAY_COLOURS.white, "right");
  const engines = state.n1Percent.length;
  const n1Dials = eicasDialLayout(w, h, engines);
  const egtDials = eicasDialLayout(w, h, engines, 0.62, 0.6);
  const n1Command = commandedN1(state.throttlePercent) / N1_FULL_SCALE;
  const n1Labels = [20, 40, 60, 80, 100].map((percent) => [percent / N1_FULL_SCALE, String(percent / 10)] as const);
  state.n1Percent.forEach((n1, i) => {
    const n1Dial = n1Dials[i]!;
    drawArcGauge(ctx, n1Dial, {
      fraction: n1 / N1_FULL_SCALE,
      tickFractions: [0, 20, 40, 60, 80, 100].map((percent) => percent / N1_FULL_SCALE),
      redlineFraction: 100 / N1_FULL_SCALE,
      commandFraction: n1Command,
    });
    drawGaugeLabels(ctx, h, n1Dial, n1Labels);
    drawGaugeReadout(ctx, h, n1Dial, n1.toFixed(1));
    const egtDial = egtDials[i]!;
    const egt = egtDegreesC(n1);
    drawArcGauge(ctx, egtDial, {
      fraction: egt / EGT_FULL_SCALE,
      tickFractions: [0, 0.25, 0.5, 0.75, 1],
      redlineFraction: 950 / EGT_FULL_SCALE,
      commandFraction: null,
    });
    drawGaugeReadout(ctx, h, egtDial, String(Math.round(egt)));
  });
  text(ctx, h, 0.035, "N1", 0.83 * w, 0.3 * h, DISPLAY_COLOURS.cyan, "left");
  text(ctx, h, 0.035, "EGT", 0.83 * w, 0.62 * h, DISPLAY_COLOURS.cyan, "left");
  drawFlapGauge(ctx, w, h, state.flapDeg);
  if (state.gearDown) text(ctx, h, 0.045, "GEAR DOWN", 0.02 * w, 0.84 * h, DISPLAY_COLOURS.green, "left");
  if (state.spoilers > 0.5) text(ctx, h, 0.045, "SPEEDBRAKE", 0.02 * w, 0.93 * h, DISPLAY_COLOURS.amber, "left");
};

// ---- the lower EICAS -------------------------------------------------------------------

/**
 * Secondary engine page: one column per engine, cyan labels down the left,
 * white values. N2 and fuel flow follow N1 by fixed derivations (N2 60 + 0.35
 * N1; fuel flow 2.0 + 0.06 N1 in thousands of kilograms an hour) and the oil
 * and vibration rows are constants, until the sim reports them.
 */
const SECONDARY_ROWS: readonly (readonly [string, (n1: number) => string])[] = [
  ["N2", (n1) => (60 + n1 * 0.35).toFixed(1)],
  ["FF", (n1) => (2 + n1 * 0.06).toFixed(1)],
  ["OIL PRESS", () => "48"],
  ["OIL TEMP", () => "92"],
  ["VIB", () => "0.6"],
];

export const drawEicasLower: DrawPage = (ctx, w, h, state) => {
  clearPage(ctx, w, h);
  const engines = state.n1Percent.length;
  const columnWidth = (0.64 * w) / Math.max(engines, 1);
  const columnX = (i: number) => 0.34 * w + columnWidth * (i + 0.5);
  state.n1Percent.forEach((_, i) => text(ctx, h, 0.045, String(i + 1), columnX(i), 0.1 * h, DISPLAY_COLOURS.cyan));
  SECONDARY_ROWS.forEach(([label, value], row) => {
    const y = 0.25 * h + row * 0.15 * h;
    text(ctx, h, 0.045, label, 0.03 * w, y, DISPLAY_COLOURS.cyan, "left");
    state.n1Percent.forEach((n1, i) => text(ctx, h, 0.05, value(n1), columnX(i), y, DISPLAY_COLOURS.white));
  });
};

// ---- the atlas -------------------------------------------------------------------------

const PAGES: Readonly<Record<DisplayPage, DrawPage>> = {
  pfd: drawPfd,
  nd: drawNd,
  "eicas-upper": drawEicasUpper,
  "eicas-lower": drawEicasLower,
};

/**
 * Every screen on one texture: each slot is clipped to its rectangle and drawn
 * in its own coordinates. The gutters are cleared to black first, so a
 * texture's bilinear sampling at a slot's edge bleeds black, not a neighbour.
 */
export function drawDisplayAtlas(
  ctx: DisplayContext2D,
  atlasWidth: number,
  atlasHeight: number,
  slots: readonly DisplaySlot[],
  state: DisplayState,
): void {
  clearPage(ctx, atlasWidth, atlasHeight);
  for (const slot of slots) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(slot.x, slot.y, slot.w, slot.h);
    ctx.clip();
    ctx.translate(slot.x, slot.y);
    PAGES[slot.page](ctx, slot.w, slot.h, state);
    ctx.restore();
  }
}
