/**
 * What a 747-400 glass-cockpit page reads, and the slice of a 2D canvas it draws
 * with. Types and one example state: no Babylon, no DOM at runtime, so the pages
 * and their tests run under Node and the painter (a DynamicTexture's context) is
 * the only caller that ever touches a real canvas.
 *
 * UNITS are the display's, not the simulator's: knots, feet, feet a minute,
 * degrees, percent. `instrumentMappings.ts` owns the conversion from the
 * simulator's SI state (metres a second, metres, +nose up, +right wing down);
 * whoever paints a page converts there, once, and hands the page this.
 */
export interface DisplayState {
  /** Degrees, +right wing down. */
  readonly bankDeg: number;
  /** Degrees, +nose up. */
  readonly pitchDeg: number;
  readonly airspeedKt: number;
  readonly groundSpeedKt: number;
  readonly altitudeFtMsl: number;
  readonly verticalSpeedFpm: number;
  /** Degrees, 0..360; a value outside is wrapped, not rejected. */
  readonly headingDeg: number;
  /** One per engine, 0 to about 110; the dials clamp at 110. One to four engines is the layout's design range. */
  readonly n1Percent: readonly number[];
  readonly gearDown: boolean;
  readonly flapDeg: number;
  /** 0 stowed to 1 fully deployed. */
  readonly spoilers: number;
  readonly throttlePercent: number;
}

/** Level cruise: the state every page test starts from, and the one the painter can show before the sim's first frame. */
export const DISPLAY_STATE_LEVEL: DisplayState = Object.freeze({
  bankDeg: 0,
  pitchDeg: 2.5,
  airspeedKt: 415,
  groundSpeedKt: 420,
  altitudeFtMsl: 5_000,
  verticalSpeedFpm: 0,
  headingDeg: 90,
  n1Percent: Object.freeze([88, 88, 88, 88]),
  gearDown: false,
  flapDeg: 0,
  spoilers: 0,
  throttlePercent: 70,
});

/**
 * A paint a real context accepts. The pages only ever assign colour strings, but
 * the type carries the real context's union so that a `CanvasRenderingContext2D`
 * IS a `DisplayContext2D` (property types are checked covariantly, so declaring
 * `string` here would reject the real context; `tests/render.cockpit-display-
 * pages.test.ts` holds the assignability at compile time).
 */
export type DisplayPaint = string | CanvasGradient | CanvasPattern;

/**
 * The subset of `CanvasRenderingContext2D` the pages draw with, and nothing
 * more: it is what a recording context in the tests must implement, and every
 * member here is one the pages call. Signatures match lib.dom's, with the
 * optional parameters the pages never pass left off.
 */
export interface DisplayContext2D {
  fillStyle: DisplayPaint;
  strokeStyle: DisplayPaint;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(radians: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  rect(x: number, y: number, width: number, height: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;
}
