import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import type { LoftSection } from "./builders";

/**
 * THE AIRLINER'S LIVERY, rasterised by hand into RGBA bytes.
 *
 * Built to `docs/findings/AIRLINER_LIVERY_GENERATOR_SPEC.md`, in the UV
 * convention of `docs/findings/AIRLINER_LIVERY_UV.md`. The short form is
 * here so the code can be checked against it without leaving the file.
 *
 * WHY A TEXTURE. The cheatline is vertex colour today, and at the cabin the
 * fuselage has six vertices over its whole height, 0.72-0.85 m apart. The
 * paint's 0.22 m ramp falls inside one vertex gap, so what renders is a linear
 * fade across the whole gap: about 0.8 m of blur, and a resolution limit
 * rather than a tuning value. A texel edge is 3-4 cm at every range.
 *
 * WHY NO CANVAS. Every Node test runs under `NullEngine` with no 2D context,
 * so a canvas would make the image untestable headlessly. Everything here is
 * loops over a `Uint8Array`. The one Babylon dependency is the upload
 * boundary at the bottom of the file, `createAirlinerLiveryTexture`, kept thin
 * for the same reason `materialSynthesis.ts` keeps its own: the pixels and
 * the mip chain are pure and are what the tests read.
 *
 * THE AXES are the loft's, not the plan's: u is the station along the body
 * and v is the phase round the section -- 0 crown, 0.25 starboard flank, 0.5
 * keel, 0.75 port flank, 1 crown again. u is shared across the fuselage,
 * radome and tailcone as `(x + 26) / 60`, so a feature drawn at one u sits at
 * one station on all three lofts and does not step at the joins.
 *
 * THE TRAP: v IS AN ANGLE, SO A LEVEL BAND IS A CURVE IN THE IMAGE. Constant
 * world height is not constant v, because the section's radius and offset
 * change station by station. Measured, a band edge at y = -0.40 runs v 0.2696
 * at the cabin to 0.3141 at x = 30.6 -- 0.0445 of a circuit, 23 texels on the
 * 512-texel v axis. A straight row would sit level at the cabin and 23 texels
 * off at the nose. Every level feature here is therefore solved per texel
 * column through `phaseOfHeight`, and nothing is painted as a row.
 */

/**
 * 2048 x 512: 2.93 cm per texel along the body, and 4.0 cm round the 20.4 m
 * cabin circumference -- near enough isotropic. 4 MB, 5.6 MB with mips. The
 * generator takes its size from these two constants and hardcodes neither, so
 * 1024 x 512 is a one-line change if the memory is judged too much.
 */
export const LIVERY_WIDTH = 2048;
export const LIVERY_HEIGHT = 512;
const CHANNELS = 4;

export interface LiveryImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major, length width * height * 4. Straight alpha, opaque (255). */
  readonly data: Uint8Array;
}

/** The shared station parametrisation: u = (x - minimumX) / length. */
export interface LiveryStationRange {
  readonly minimumX: number;
  readonly length: number;
}

/** x from -26 to +34 maps to u 0..1, on every loft that carries the livery. */
export const AIRLINER_LIVERY_STATION_RANGE: LiveryStationRange = { minimumX: -26, length: 60 };

/**
 * The fuselage's section table, transcribed from the spec. Squareness 2
 * throughout. `crownZRadius` is left off on purpose: it leans the upper
 * flanks in, which changes z and never y, so it does not enter the height
 * solve below. It would matter only for a feature positioned by z, and none
 * here is.
 *
 * Beyond the table's ends (the radome forward of 30.6, the tailcone aft of
 * -26) the end section is HELD, the same way `skinPoint` in
 * `airlinerVisual.ts` holds it. Nothing painted here relies on that: every
 * feature sits inside -24.5..30.6 except the cheatline's forward fade, which
 * is at 0.7 % coverage by the time the held section is 1 m stale.
 */
export const AIRLINER_LIVERY_SECTIONS: readonly LoftSection[] = [
  { x: -26, yRadius: 3.08, zRadius: 3.08, yOffset: 0.16 },
  { x: -20, yRadius: 3.25, zRadius: 3.25, yOffset: 0 },
  { x: -6, yRadius: 3.25, zRadius: 3.25, yOffset: 0 },
  { x: 0, yRadius: 3.265, zRadius: 3.25, yOffset: 0.015 },
  { x: 5, yRadius: 3.35, zRadius: 3.25, yOffset: 0.1 },
  { x: 9, yRadius: 3.525, zRadius: 3.25, yOffset: 0.275 },
  { x: 13, yRadius: 3.685, zRadius: 3.25, yOffset: 0.435 },
  { x: 17, yRadius: 3.785, zRadius: 3.25, yOffset: 0.535 },
  { x: 21, yRadius: 3.82, zRadius: 3.25, yOffset: 0.57 },
  { x: 26, yRadius: 3.825, zRadius: 3.25, yOffset: 0.575 },
  { x: 28, yRadius: 3.575, zRadius: 3, yOffset: 0.675 },
  { x: 29.6, yRadius: 3.15, zRadius: 2.6, yOffset: 0.65 },
  { x: 30.6, yRadius: 2.55, zRadius: 2.05, yOffset: 0.6 },
];

// ---------------------------------------------------------------------------
// COLOURS. The image is sRGB bytes and is uploaded as an sRGB buffer, so the
// material decodes it; the scheme's source of truth stays the linear triple
// the vertex band already uses.
// ---------------------------------------------------------------------------

export type LiveryRgb = readonly [number, number, number];

/** The cheatline's linear-space navy, the rudder's own colour. */
export const CHEATLINE_LINEAR: LiveryRgb = [0.011, 0.042, 0.147];
export const LIVERY_WHITE: LiveryRgb = [255, 255, 255];
/** `CHEATLINE_LINEAR` encoded: 27, 58, 107. */
export const LIVERY_NAVY: LiveryRgb = [
  srgbByte(CHEATLINE_LINEAR[0]),
  srgbByte(CHEATLINE_LINEAR[1]),
  srgbByte(CHEATLINE_LINEAR[2]),
];
/** The door windows, near-black like the cabin panes' `dark` material. */
export const LIVERY_DOOR_WINDOW: LiveryRgb = [30, 34, 42];
/**
 * Lines and tones are MULTIPLIERS on whatever is underneath, not colours: a
 * panel line crossing the cheatline must darken the navy, and a "slightly
 * darker white" laid over navy would be a light line. 0.90 takes white to
 * 230, which is the slightly-darker white the spec asks for; 0.55 takes it to
 * 140 for a door seal that reads at the chase; 0.88 is the wing-root tone.
 * All three are decided, not measured, and are the numbers to tune from a
 * frame.
 */
export const PANEL_LINE_SHADE = 0.9;
export const DOOR_OUTLINE_SHADE = 0.55;
export const WING_ROOT_SHADE = 0.88;

// ---------------------------------------------------------------------------
// WHAT IS PAINTED, in body metres. Every y here is a world height and is
// converted to v per column; none is a row.
// ---------------------------------------------------------------------------

/**
 * Main-deck panes sit at y = 0.2 and are 0.36 m tall (transcribed from
 * `airlinerVisual.ts`), so the pane bottoms are at 0.02 and the band's top
 * edge at -0.40 leaves 0.42 m of clear white behind every pane. That is the
 * spec's "BELOW the main-deck window line", and the one placement the vertex
 * band could not make: its ~0.8 m blur could not be placed to 0.42 m.
 */
export const MAIN_DECK_WINDOW_Y = 0.2;
export const MAIN_DECK_WINDOW_HEIGHT = 0.36;

/**
 * The cheatline. Station ends follow the vertex band exactly: full from -22 to
 * 30.5 and smoothstepped to nothing by -24.5 aft and 32.5 forward, which is
 * what "dies out ... as the vertex band does now" means in that band's own
 * code. The forward fade is what lets the band be measured at x = 30.6 (the
 * last section, 99.3 % coverage) as the contract's table does.
 */
export const CHEATLINE = {
  topY: -0.4,
  bottomY: -1.4,
  aftEndX: -24.5,
  aftFullX: -22,
  forwardFullX: 30.5,
  forwardEndX: 32.5,
} as const;

/**
 * Main-deck doors. The geometry has no passenger doors, so these stations are
 * DECIDED here, from the 747-8's five doors a side (about 6.0, 16.2, 33.5,
 * 51.5 and 61 m aft of the nose on a 76.3 m aeroplane) scaled to this 72 m
 * airframe whose nose is at x = 34. Door 5 sits 1 m forward of that scaling
 * so it stays on the fuselage loft rather than the tailcone overlap and clear
 * of the -24 frame line. 1.07 x 1.93 m is a 747 Type A door. The floor is the
 * main deck's: `UPPER_DECK_FLOOR_Y` = 1.95 is documented as 2.6 m above it.
 */
export const MAIN_DECK_FLOOR_Y = -0.65;
export const DOOR_WIDTH = 1.07;
export const DOOR_HEIGHT = 1.93;
/** Two texels, 6-8 cm: a seal line that fades with the mip chain but reads at 30 m. */
export const DOOR_OUTLINE_TEXELS = 2;
/** A 0.26 x 0.35 m pane at eye height, level with the cabin window row. */
export const DOOR_WINDOW = { halfWidth: 0.13, bottomY: 0.1, topY: 0.45 } as const;
export const MAIN_DECK_DOORS: readonly { readonly name: string; readonly x: number }[] = [
  { name: "1", x: 28 },
  { name: "2", x: 18.5 },
  { name: "3", x: 2.5 },
  { name: "4", x: -14.5 },
  { name: "5", x: -22.5 },
];

/**
 * Circumferential frame lines at the body's production breaks: the tail
 * break, the rear and front spars (the wing root's trailing and leading
 * edges, -4.32 and 10.54 -- `leadingEdgeX(3)` and the Yehudi-derived root
 * trailing edge in `airlinerVisual.ts`, transcribed), and the section 41/42
 * break behind door 1. One texel wide: a real 2-3 cm panel gap, which is what
 * the mip chain is for. Decided stations; the spec names none.
 */
export const PANEL_LINE_STATIONS: readonly number[] = [-24, -4.32, 10.54, 26.5];

/**
 * The wing-root tone: the fuselage flank over the root chord, from the
 * cheatline's bottom edge down to the keel, in a slightly darker tone. Most
 * of it is under the belly fairing (its own loft, not carrying this image);
 * what shows is the flank between the band and the fairing's crown at each
 * end of the root chord. Interpreted as a fuselage feature because this image
 * is the fuselage's -- see the note on the wing at the end of the file.
 */
export const WING_ROOT_TONE = { trailingX: -4.32, leadingX: 10.54 } as const;

// ---------------------------------------------------------------------------
// THE SOLVE
// ---------------------------------------------------------------------------

export type LiveryFlank = "starboard" | "port";

interface SectionAtStation {
  readonly yRadius: number;
  readonly yOffset: number;
  readonly squareness: number;
}

/**
 * The section at a station, interpolated LINEARLY between the two that
 * bracket it. That is exact, not an approximation: the loft emits one ring per
 * section and the renderer interpolates positions linearly between rings, and
 * for a fixed phase that is algebraically the same as interpolating the two
 * parameters. Splining them would put the paint off the skin.
 */
export function sectionAtStation(sections: readonly LoftSection[], x: number): SectionAtStation {
  let low = sections[0]!;
  let high = sections[sections.length - 1]!;
  for (let index = 1; index < sections.length; index += 1) {
    if (sections[index]!.x >= x) {
      low = sections[index - 1]!;
      high = sections[index]!;
      break;
    }
  }
  const span = Math.max(1e-6, high.x - low.x);
  const t = Math.min(1, Math.max(0, (x - low.x) / span));
  return {
    yRadius: mix(low.yRadius, high.yRadius, t),
    yOffset: mix(low.yOffset ?? 0, high.yOffset ?? 0, t),
    squareness: mix(low.squareness ?? 2, high.squareness ?? 2, t),
  };
}

/**
 * The v of world height `y` at station `x`, or `undefined` where the body is
 * not that tall. Inverts the loft's own section, `y = yOffset + yRadius *
 * sign(cos) * |cos|^(2/n)`, so that at squareness 2 it is
 * `acos((y - yOffset) / yRadius) / 2pi` exactly as the contract states.
 *
 * `undefined`, never a clamp: a band edge above the crown clamped to v = 0
 * would paint the band along the crown, which is the failure the spec names.
 */
export function phaseOfHeight(
  sections: readonly LoftSection[],
  x: number,
  y: number,
  flank: LiveryFlank = "starboard",
): number | undefined {
  const section = sectionAtStation(sections, x);
  const rise = (y - section.yOffset) / section.yRadius;
  if (!(Math.abs(rise) <= 1)) return undefined;
  const cosMagnitude = Math.abs(rise) ** (section.squareness / 2);
  const cosine = Math.min(1, Math.max(-1, Math.sign(rise) * cosMagnitude));
  const phase = Math.acos(cosine) / (2 * Math.PI);
  return flank === "starboard" ? phase : 1 - phase;
}

// ---------------------------------------------------------------------------
// THE IMAGE
// ---------------------------------------------------------------------------

export interface LiveryBuildOptions {
  readonly width?: number;
  readonly height?: number;
  /** The same section table the loft is built from; tests pass synthetic ones. */
  readonly sections?: readonly LoftSection[];
  readonly stationRange?: LiveryStationRange;
}

/** The shipped livery: the airliner's own sections and size. */
export function buildAirlinerLivery(): LiveryImage {
  return buildAirlinerLiveryImage({});
}

/**
 * The livery over any section table and size. Deterministic: two calls
 * return identical bytes, because nothing here reads a clock or a random
 * source. Base white, then the features in an order where each later one
 * is entitled to darken the earlier: cheatline, wing-root tone, panel lines,
 * doors.
 */
export function buildAirlinerLiveryImage(options: LiveryBuildOptions): LiveryImage {
  const width = options.width ?? LIVERY_WIDTH;
  const height = options.height ?? LIVERY_HEIGHT;
  const sections = options.sections ?? AIRLINER_LIVERY_SECTIONS;
  const range = options.stationRange ?? AIRLINER_LIVERY_STATION_RANGE;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError("A livery image needs positive integer dimensions");
  }
  if (!(range.length > 0)) throw new RangeError("A livery station range needs a positive length");
  validateSections(sections);
  const raster: Raster = {
    width,
    height,
    data: new Uint8Array(width * height * CHANNELS).fill(255),
    sections,
    range,
  };
  paintCheatline(raster);
  paintWingRootTone(raster);
  paintPanelLines(raster);
  for (const door of MAIN_DECK_DOORS) paintDoor(raster, door.x);
  return { width, height, data: raster.data };
}

/** The loft's own preconditions, so a table the loft would refuse is refused here too. */
function validateSections(sections: readonly LoftSection[]): void {
  if (sections.length < 2) throw new RangeError("A livery needs at least two sections");
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!;
    if (index > 0 && !(section.x > sections[index - 1]!.x)) {
      throw new RangeError("Livery sections must be strictly ordered along +X");
    }
    if (!(section.yRadius > 0)) throw new RangeError("Livery section radii must be positive");
    if (!((section.squareness ?? 2) >= 2)) {
      throw new RangeError("Livery section squareness must be at least 2");
    }
  }
}

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly sections: readonly LoftSection[];
  readonly range: LiveryStationRange;
}

/** The station at a column's CENTRE, which is what its texel represents. */
function stationOfColumn(raster: Raster, column: number): number {
  return raster.range.minimumX + ((column + 0.5) / raster.width) * raster.range.length;
}

/** The column containing a station; may fall outside the image, callers clip. */
function columnOfStation(raster: Raster, x: number): number {
  return Math.floor(((x - raster.range.minimumX) / raster.range.length) * raster.width);
}

function rowOfPhase(raster: Raster, phase: number): number {
  return Math.min(raster.height - 1, Math.max(0, Math.floor(phase * raster.height)));
}

function texelIndex(raster: Raster, column: number, row: number): number {
  return (row * raster.width + column) * CHANNELS;
}

function blendTexel(data: Uint8Array, index: number, colour: LiveryRgb, amount: number): void {
  for (let channel = 0; channel < 3; channel += 1) {
    const base = data[index + channel]!;
    data[index + channel] = Math.round(base + (colour[channel]! - base) * amount);
  }
}

function shadeTexel(data: Uint8Array, index: number, factor: number): void {
  for (let channel = 0; channel < 3; channel += 1) {
    data[index + channel] = Math.round(data[index + channel]! * factor);
  }
}

function fillTexel(data: Uint8Array, index: number, colour: LiveryRgb): void {
  data[index] = colour[0];
  data[index + 1] = colour[1];
  data[index + 2] = colour[2];
}

interface PhaseSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The v spans, on both flanks, of a world-height interval at a station --
 * `undefined` if either edge is off the body. Both edges must solve: a band
 * whose bottom edge is below the keel is not painted down to the keel,
 * because "the band does not exist at that station" is the spec's rule and
 * partial bands are not in it.
 */
function phaseSpans(
  sections: readonly LoftSection[],
  x: number,
  lowY: number,
  highY: number,
): readonly PhaseSpan[] | undefined {
  const top = phaseOfHeight(sections, x, highY);
  const bottom = phaseOfHeight(sections, x, lowY);
  if (top === undefined || bottom === undefined) return undefined;
  return [
    { start: top, end: bottom },
    { start: 1 - bottom, end: 1 - top },
  ];
}

/**
 * The cheatline, with its two edges ANTI-ALIASED by coverage: the one row
 * each edge falls in takes the fraction of its v extent inside the band. So a
 * boundary is at most one partial texel, which is what makes the band's edge
 * an edge (the spec allows two), and the curve's one-texel steps between
 * columns are blended rather than stepped.
 */
function paintCheatline(raster: Raster): void {
  for (let column = 0; column < raster.width; column += 1) {
    const x = stationOfColumn(raster, column);
    const presence = smoothStep(CHEATLINE.aftEndX, CHEATLINE.aftFullX, x)
      * (1 - smoothStep(CHEATLINE.forwardFullX, CHEATLINE.forwardEndX, x));
    if (presence <= 0) continue;
    const spans = phaseSpans(raster.sections, x, CHEATLINE.bottomY, CHEATLINE.topY);
    if (!spans) continue;
    for (const span of spans) {
      const first = Math.max(0, Math.floor(span.start * raster.height));
      const last = Math.min(raster.height - 1, Math.ceil(span.end * raster.height) - 1);
      for (let row = first; row <= last; row += 1) {
        const rowStart = row / raster.height;
        const rowEnd = (row + 1) / raster.height;
        const coverage = (Math.min(rowEnd, span.end) - Math.max(rowStart, span.start)) * raster.height;
        if (coverage <= 0) continue;
        blendTexel(raster.data, texelIndex(raster, column, row), LIVERY_NAVY, coverage * presence);
      }
    }
  }
}

/** Rows whose centre v lies inside [start, end], for crisp fills. */
function rowsWithin(raster: Raster, start: number, end: number): { first: number; last: number } {
  return {
    first: Math.max(0, Math.ceil(start * raster.height - 0.5)),
    last: Math.min(raster.height - 1, Math.floor(end * raster.height - 0.5)),
  };
}

function paintWingRootTone(raster: Raster): void {
  for (let column = 0; column < raster.width; column += 1) {
    const x = stationOfColumn(raster, column);
    if (x < WING_ROOT_TONE.trailingX || x > WING_ROOT_TONE.leadingX) continue;
    const bandBottom = phaseOfHeight(raster.sections, x, CHEATLINE.bottomY);
    if (bandBottom === undefined) continue;
    // From the band's bottom edge round the keel to the band's bottom edge on
    // the other flank: one contiguous run of rows through v = 0.5.
    const rows = rowsWithin(raster, bandBottom, 1 - bandBottom);
    for (let row = rows.first; row <= rows.last; row += 1) {
      shadeTexel(raster.data, texelIndex(raster, column, row), WING_ROOT_SHADE);
    }
  }
}

/** A full ring, crown to crown through both flanks, one column wide. */
function paintPanelLines(raster: Raster): void {
  for (const station of PANEL_LINE_STATIONS) {
    const column = columnOfStation(raster, station);
    if (column < 0 || column >= raster.width) continue;
    for (let row = 0; row < raster.height; row += 1) {
      shadeTexel(raster.data, texelIndex(raster, column, row), PANEL_LINE_SHADE);
    }
  }
}

/**
 * A door: its outline as a ring of `DOOR_OUTLINE_TEXELS` inside the door's
 * rectangle, then its window. The top and bottom edges are solved per column
 * like everything else, so the outline follows the skin where the section
 * changes across the door's own width (sub-texel at the cabin, two texels at
 * door 1).
 */
function paintDoor(raster: Raster, doorX: number): void {
  const left = columnOfStation(raster, doorX - DOOR_WIDTH / 2);
  const right = columnOfStation(raster, doorX + DOOR_WIDTH / 2);
  for (let column = Math.max(0, left); column <= Math.min(raster.width - 1, right); column += 1) {
    const x = stationOfColumn(raster, column);
    const spans = phaseSpans(raster.sections, x, MAIN_DECK_FLOOR_Y, MAIN_DECK_FLOOR_Y + DOOR_HEIGHT);
    if (!spans) continue;
    const onJamb = column - left < DOOR_OUTLINE_TEXELS || right - column < DOOR_OUTLINE_TEXELS;
    for (const span of spans) {
      const first = rowOfPhase(raster, span.start);
      const last = rowOfPhase(raster, span.end);
      for (let row = first; row <= last; row += 1) {
        const onSill = row - first < DOOR_OUTLINE_TEXELS || last - row < DOOR_OUTLINE_TEXELS;
        if (onJamb || onSill) shadeTexel(raster.data, texelIndex(raster, column, row), DOOR_OUTLINE_SHADE);
      }
    }
  }
  const windowLeft = columnOfStation(raster, doorX - DOOR_WINDOW.halfWidth);
  const windowRight = columnOfStation(raster, doorX + DOOR_WINDOW.halfWidth);
  for (
    let column = Math.max(0, windowLeft);
    column <= Math.min(raster.width - 1, windowRight);
    column += 1
  ) {
    const x = stationOfColumn(raster, column);
    const spans = phaseSpans(raster.sections, x, DOOR_WINDOW.bottomY, DOOR_WINDOW.topY);
    if (!spans) continue;
    for (const span of spans) {
      const rows = rowsWithin(raster, span.start, span.end);
      for (let row = rows.first; row <= rows.last; row += 1) {
        fillTexel(raster.data, texelIndex(raster, column, row), LIVERY_DOOR_WINDOW);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// THE MIP CHAIN
// ---------------------------------------------------------------------------

/**
 * Box-filtered mips down to 1 x 1, in pure TypeScript so the tests can read
 * every level. Not `buildMipChain` from `TextureArrayMips`: that reducer is
 * square-only, and this image is 4:1. When one axis reaches 1 the filter
 * becomes 2 x 1 along the other, which is what keeps the chain going to a
 * single texel instead of stopping at 4 x 1.
 *
 * The average is taken on the sRGB bytes, as `boxReduce` there does. Strictly
 * a linear-space average is the correct one for an sRGB texture, but this
 * image is flat colours with one-texel edges, so the two differ only on edge
 * texels and by less than the chase camera's 9 cm pixel resolves. Decided,
 * and the place to revisit if a frame shows the band's edge lightening with
 * distance.
 */
export function buildLiveryMipChain(image: LiveryImage): readonly LiveryImage[] {
  if (!isPowerOfTwo(image.width) || !isPowerOfTwo(image.height)) {
    throw new RangeError("A livery mip chain needs power-of-two dimensions");
  }
  if (image.data.length !== image.width * image.height * CHANNELS) {
    throw new RangeError("Livery image data does not match its dimensions");
  }
  const levels: LiveryImage[] = [image];
  let current = image;
  while (current.width > 1 || current.height > 1) {
    current = boxReduceLevel(current);
    levels.push(current);
  }
  return levels;
}

function boxReduceLevel(source: LiveryImage): LiveryImage {
  const stepX = source.width > 1 ? 2 : 1;
  const stepY = source.height > 1 ? 2 : 1;
  const width = source.width / stepX;
  const height = source.height / stepY;
  const taps = stepX * stepY;
  const data = new Uint8Array(width * height * CHANNELS);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * CHANNELS;
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        let sum = 0;
        for (let dy = 0; dy < stepY; dy += 1) {
          for (let dx = 0; dx < stepX; dx += 1) {
            sum += source.data[((y * stepY + dy) * source.width + (x * stepX + dx)) * CHANNELS + channel]!;
          }
        }
        data[out + channel] = Math.round(sum / taps);
      }
    }
  }
  return { width, height, data };
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

// ---------------------------------------------------------------------------
// THE UPLOAD BOUNDARY -- the only Babylon in the file.
// ---------------------------------------------------------------------------

/**
 * Upload a livery and its chain as one `RawTexture`, every level explicit.
 * Works under `NullEngine`, which is how the test exercises it.
 *
 * u CLAMPS. The tailcone runs x -38..-25, which under the shared range is
 * u -0.2..0.017: wrapped, that would sample the FORWARD fuselage onto the
 * tail, cheatline and all. Clamped it repeats column 0, which is white by
 * assertion. v WRAPS: the seam is the duplicated crown vertex, and every ring
 * feature paints row 0 and the last row alike, so the wrap is invisible.
 * Anisotropy 8 as the aircraft paint has: a fuselage is seen at grazing
 * angles from every chase position.
 */
export function createAirlinerLiveryTexture(
  scene: Scene,
  mips: readonly LiveryImage[],
  name = "airliner-livery",
): RawTexture {
  const base = mips[0];
  if (!base) throw new RangeError("A livery upload needs at least the base level");
  const texture = new RawTexture(
    base.data,
    base.width,
    base.height,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    0,
    true,
    false,
    mips.length,
  );
  texture.name = name;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  for (let level = 1; level < mips.length; level += 1) {
    texture.updateMipLevel(mips[level]!.data, level);
  }
  return texture;
}

// ---------------------------------------------------------------------------

function srgbByte(linear: number): number {
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite ramp, the same shape the vertex band's ends use. */
function smoothStep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/*
 * NOT IN THIS IMAGE, and why.
 *
 * Titles and logos: they need a rasteriser, which needs a canvas or a bitmap
 * font, and both are ruled out above. Called out, as the spec asks, rather
 * than quietly skipped.
 *
 * Spoiler, flap and aileron panel lines, and nacelle lines: the spec lists
 * them, but this image's whole u x v is the fuselage -- the wing panels and
 * nacelles are separate meshes with their own per-mesh planar UVs
 * (`planarUvs` in `builders.ts`), and neither the contract nor the spec
 * defines where in this image they would map. Painting them anywhere here
 * would land on the fuselage. They need either their own image or an atlas
 * layout the wing's UVs are re-emitted against, and that is a decision for
 * the loft-and-material side, not something to invent in the generator.
 */
