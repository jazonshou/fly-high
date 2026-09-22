import type { DisplayContext2D, DisplayPaint } from "../../src/render/webgpu/aircraft/cockpit/displays/displayState";

/**
 * A `DisplayContext2D` that draws nothing and remembers everything: every
 * method call and every property assignment, in order, so a test under Node
 * can ask what a page drew and where, with no canvas at all.
 *
 * `transformedPoints` is what makes "where" answerable. A page draws under
 * save/translate/rotate/scale, and a raw log holds local coordinates; the replay
 * keeps the same matrix stack a canvas does and returns every point in ABSOLUTE
 * canvas coordinates, with the paint in force when it was drawn. Its own
 * arithmetic is held by a positive control in the page tests (a hand-worked
 * translate/rotate/scale sequence), because a replay that is wrong in the same
 * way as a page would pass every other test.
 */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export type RecordingContext2D = DisplayContext2D & { readonly calls: readonly RecordedCall[] };

class RecordingContext implements DisplayContext2D {
  readonly calls: RecordedCall[] = [];
  // A real context's defaults, so a page that forgot to set a style reads as one would.
  private fillPaint: DisplayPaint = "#000000";
  private strokePaint: DisplayPaint = "#000000";
  private width = 1;
  private fontValue = "10px sans-serif";
  private align: CanvasTextAlign = "start";
  private baseline: CanvasTextBaseline = "alphabetic";

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  get fillStyle(): DisplayPaint {
    return this.fillPaint;
  }
  set fillStyle(value: DisplayPaint) {
    this.fillPaint = value;
    this.record("set:fillStyle", value);
  }
  get strokeStyle(): DisplayPaint {
    return this.strokePaint;
  }
  set strokeStyle(value: DisplayPaint) {
    this.strokePaint = value;
    this.record("set:strokeStyle", value);
  }
  get lineWidth(): number {
    return this.width;
  }
  set lineWidth(value: number) {
    this.width = value;
    this.record("set:lineWidth", value);
  }
  get font(): string {
    return this.fontValue;
  }
  set font(value: string) {
    this.fontValue = value;
    this.record("set:font", value);
  }
  get textAlign(): CanvasTextAlign {
    return this.align;
  }
  set textAlign(value: CanvasTextAlign) {
    this.align = value;
    this.record("set:textAlign", value);
  }
  get textBaseline(): CanvasTextBaseline {
    return this.baseline;
  }
  set textBaseline(value: CanvasTextBaseline) {
    this.baseline = value;
    this.record("set:textBaseline", value);
  }

  save(): void {
    this.record("save");
  }
  restore(): void {
    this.record("restore");
  }
  translate(x: number, y: number): void {
    this.record("translate", x, y);
  }
  rotate(radians: number): void {
    this.record("rotate", radians);
  }
  scale(x: number, y: number): void {
    this.record("scale", x, y);
  }
  beginPath(): void {
    this.record("beginPath");
  }
  closePath(): void {
    this.record("closePath");
  }
  moveTo(x: number, y: number): void {
    this.record("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.record("lineTo", x, y);
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.record("arc", x, y, radius, startAngle, endAngle);
  }
  rect(x: number, y: number, width: number, height: number): void {
    this.record("rect", x, y, width, height);
  }
  fill(): void {
    this.record("fill");
  }
  stroke(): void {
    this.record("stroke");
  }
  clip(): void {
    this.record("clip");
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.record("fillRect", x, y, width, height);
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.record("strokeRect", x, y, width, height);
  }
  fillText(text: string, x: number, y: number): void {
    this.record("fillText", text, x, y);
  }
  strokeText(text: string, x: number, y: number): void {
    this.record("strokeText", text, x, y);
  }
  setLineDash(segments: number[]): void {
    this.record("setLineDash", [...segments]);
  }
}

export function createRecordingContext(): RecordingContext2D {
  return new RecordingContext();
}

export interface TransformedPoint {
  /** The call's position in the log, so a moveTo and the lineTo after it can be paired. */
  readonly index: number;
  readonly method: "moveTo" | "lineTo" | "arc" | "fillText" | "strokeText";
  /** Absolute canvas coordinates: an arc's centre, a text's anchor. */
  readonly x: number;
  readonly y: number;
  readonly text: string | null;
  readonly fillStyle: DisplayPaint;
  readonly strokeStyle: DisplayPaint;
}

/** The canvas matrix [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. Paints ride the same stack, as they do on a real context. */
interface ReplayState {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  fillStyle: DisplayPaint;
  strokeStyle: DisplayPaint;
}

function numberAt(call: RecordedCall, i: number): number {
  const value = call.args[i];
  if (typeof value !== "number") throw new Error(`${call.method} argument ${i} is not a number: ${String(value)}`);
  return value;
}

function paintAt(call: RecordedCall): DisplayPaint {
  const value = call.args[0];
  if (typeof value !== "string") throw new Error(`${call.method} was given a non-string paint, which no page does`);
  return value;
}

/** Every drawn point of a log in absolute coordinates, replaying the transform stack the way a canvas keeps it. */
export function transformedPoints(calls: readonly RecordedCall[]): TransformedPoint[] {
  const stack: ReplayState[] = [];
  let s: ReplayState = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, fillStyle: "#000000", strokeStyle: "#000000" };
  const points: TransformedPoint[] = [];
  const point = (index: number, method: TransformedPoint["method"], x: number, y: number, text: string | null) => {
    points.push({ index, method, x: s.a * x + s.c * y + s.e, y: s.b * x + s.d * y + s.f, text, fillStyle: s.fillStyle, strokeStyle: s.strokeStyle });
  };
  calls.forEach((call, index) => {
    switch (call.method) {
      case "save":
        stack.push({ ...s });
        break;
      case "restore": {
        // a restore with nothing saved is a no-op on a canvas too
        const saved = stack.pop();
        if (saved) s = saved;
        break;
      }
      case "translate": {
        const tx = numberAt(call, 0);
        const ty = numberAt(call, 1);
        s = { ...s, e: s.e + s.a * tx + s.c * ty, f: s.f + s.b * tx + s.d * ty };
        break;
      }
      case "rotate": {
        const cos = Math.cos(numberAt(call, 0));
        const sin = Math.sin(numberAt(call, 0));
        s = { ...s, a: s.a * cos + s.c * sin, b: s.b * cos + s.d * sin, c: -s.a * sin + s.c * cos, d: -s.b * sin + s.d * cos };
        break;
      }
      case "scale": {
        const sx = numberAt(call, 0);
        const sy = numberAt(call, 1);
        s = { ...s, a: s.a * sx, b: s.b * sx, c: s.c * sy, d: s.d * sy };
        break;
      }
      case "set:fillStyle":
        s = { ...s, fillStyle: paintAt(call) };
        break;
      case "set:strokeStyle":
        s = { ...s, strokeStyle: paintAt(call) };
        break;
      case "moveTo":
      case "lineTo":
      case "arc":
        point(index, call.method, numberAt(call, 0), numberAt(call, 1), null);
        break;
      case "fillText":
      case "strokeText": {
        const text = call.args[0];
        if (typeof text !== "string") throw new Error(`${call.method} was given a non-string`);
        point(index, call.method, numberAt(call, 1), numberAt(call, 2), text);
        break;
      }
      default:
        break;
    }
  });
  return points;
}
