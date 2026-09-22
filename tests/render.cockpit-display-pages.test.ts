import { describe, expect, it } from "vitest";
import {
  attitudeRotationRadians,
  DISPLAY_COLOURS,
  drawDisplayAtlas,
  drawEicasLower,
  drawEicasUpper,
  drawNd,
  drawPfd,
  eicasDialLayout,
  pfdGeometry,
  pfdHorizonOffsetPx,
  type DisplaySlot,
  type DrawPage,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayPages";
import { DISPLAY_STATE_LEVEL, type DisplayContext2D, type DisplayState } from "../src/render/webgpu/aircraft/cockpit/displays/displayState";
import { createRecordingContext, transformedPoints, type RecordedCall, type TransformedPoint } from "./support/recordingContext";

/**
 * The 747's glass-cockpit pages, drawn into a recording context and asked WHERE
 * things landed, not whether the code ran.
 *
 * The recording context replays the transform stack to give absolute
 * coordinates, so the horizon's tilt, the N1 needle's angle and each atlas
 * slot's text are asserted on the screen, in pixels. A replay that is wrong
 * would let a wrong page pass, so the replay has a positive control of its own:
 * a hand-worked translate/rotate/scale sequence with the answer written down.
 *
 * THE HORIZON'S SENSE is the one the renderer already measured: in a right bank
 * the horizon's right end is UP, smaller y (`tests/render.cockpit-instruments.
 * test.ts`, the world horizon projected through the cockpit camera; the HUD's
 * CSS rotate(-bank) agrees). The brief's later wording asked for the opposite,
 * and lost to the measurement.
 */

// The 747's 0.22 x 0.15 m screen at 2,000 px a metre.
const W = 440;
const H = 300;
const DEG = Math.PI / 180;

/** A real canvas context must be usable where the pages want one; this fails to compile otherwise. */
const realContextFits: CanvasRenderingContext2D extends DisplayContext2D ? true : false = true;

const PAGES: readonly (readonly [string, DrawPage])[] = [
  ["pfd", drawPfd],
  ["nd", drawNd],
  ["eicas-upper", drawEicasUpper],
  ["eicas-lower", drawEicasLower],
];

function stateWith(overrides: Partial<DisplayState>): DisplayState {
  return { ...DISPLAY_STATE_LEVEL, ...overrides };
}

function draw(page: DrawPage, state: DisplayState, w = W, h = H): readonly RecordedCall[] {
  const ctx = createRecordingContext();
  page(ctx, w, h, state);
  return ctx.calls;
}

function drawnTexts(calls: readonly RecordedCall[]): string[] {
  return calls.filter((call) => call.method === "fillText").map((call) => String(call.args[0]));
}

/** Consecutive moveTo/lineTo pairs, as segments in absolute coordinates. */
function segments(points: readonly TransformedPoint[]): { readonly from: TransformedPoint; readonly to: TransformedPoint }[] {
  const pairs: { from: TransformedPoint; to: TransformedPoint }[] = [];
  points.forEach((from, i) => {
    const to = points[i + 1];
    if (from.method === "moveTo" && to?.method === "lineTo" && to.index === from.index + 1) pairs.push({ from, to });
  });
  return pairs;
}

const length = (segment: { from: TransformedPoint; to: TransformedPoint }) => Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);

describe("the recording context", () => {
  it("accepts a real CanvasRenderingContext2D", () => {
    expect(realContextFits).toBe(true);
  });

  it("replays translate, rotate, scale, save and restore to the points worked by hand", () => {
    const ctx = createRecordingContext();
    ctx.strokeStyle = "#abc";
    ctx.save();
    ctx.translate(10, 20);
    ctx.rotate(Math.PI / 2);
    // (5, 0) turned a quarter turn clockwise on a y-down screen is (0, 5), then moved: (10, 25)
    ctx.lineTo(5, 0);
    ctx.save();
    ctx.fillStyle = "#123";
    ctx.scale(2, 3);
    // (1, 1) scaled is (2, 3); turned, (-3, 2); moved, (7, 22)
    ctx.moveTo(1, 1);
    ctx.restore();
    // the scale AND the inner fillStyle are gone, the rotation remains: (0, 1) turned is (-1, 0); moved, (9, 20)
    ctx.fillText("x", 0, 1);
    ctx.restore();
    // back to the identity
    ctx.arc(3, 4, 1, 0, 1);
    // order matters: translating inside the rotation is not translating before it
    ctx.rotate(Math.PI / 2);
    ctx.translate(5, 0);
    ctx.lineTo(0, 0);
    const points = transformedPoints(ctx.calls);
    expect(points.map((p) => [p.method, Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6])).toEqual([
      ["lineTo", 10, 25],
      ["moveTo", 7, 22],
      ["fillText", 9, 20],
      ["arc", 3, 4],
      ["lineTo", 0, 5],
    ]);
    expect(points.map((p) => p.strokeStyle)).toEqual(["#abc", "#abc", "#abc", "#abc", "#abc"]);
    expect(points.map((p) => p.fillStyle)).toEqual(["#000000", "#123", "#000000", "#000000", "#000000"]);
    expect(points[2]?.text).toBe("x");
    expect(ctx.calls[0]).toEqual({ method: "set:strokeStyle", args: ["#abc"] });
  });
});

describe("determinism", () => {
  it.each(PAGES)("%s draws the same log twice for the same state", (_, page) => {
    const banked = stateWith({ bankDeg: 17, pitchDeg: -4, verticalSpeedFpm: -800, headingDeg: 312.4 });
    const first = draw(page, banked);
    const second = draw(page, banked);
    expect(first.length).toBeGreaterThan(50);
    expect(second).toEqual(first);
  });

  it("the atlas draws the same log twice", () => {
    const slots: DisplaySlot[] = [
      { page: "pfd", x: 0, y: 0, w: W, h: H },
      { page: "nd", x: W, y: 0, w: W, h: H },
    ];
    const a = createRecordingContext();
    const b = createRecordingContext();
    drawDisplayAtlas(a, 2 * W, H, slots, DISPLAY_STATE_LEVEL);
    drawDisplayAtlas(b, 2 * W, H, slots, DISPLAY_STATE_LEVEL);
    expect(b.calls).toEqual(a.calls);
  });
});

describe("every argument is finite for extreme finite states", () => {
  function nonFinite(calls: readonly RecordedCall[]): string[] {
    const faults: string[] = [];
    calls.forEach((call, i) => {
      call.args.forEach((arg, j) => {
        if (typeof arg === "number" && !Number.isFinite(arg)) faults.push(`#${i} ${call.method} arg ${j} = ${arg}`);
        // a NaN that reached a readout is a string by then
        if (typeof arg === "string" && /NaN|Infinity/.test(arg)) faults.push(`#${i} ${call.method} arg ${j} = "${arg}"`);
        if (Array.isArray(arg) && arg.some((v) => !Number.isFinite(v))) faults.push(`#${i} ${call.method} arg ${j} = [${arg.join(", ")}]`);
      });
    });
    return faults;
  }

  const grid: DisplayState[] = [];
  for (const bankDeg of [-180, 180])
    for (const pitchDeg of [-90, 90])
      for (const airspeedKt of [0, 1200])
        for (const altitudeFtMsl of [-1500, 60000])
          for (const verticalSpeedFpm of [-20000, 20000])
            for (const headingDeg of [-10, 370, 359.999])
              for (const n1Percent of [[], [0], [130, 130, 130, 130]])
                grid.push(stateWith({ bankDeg, pitchDeg, airspeedKt, altitudeFtMsl, verticalSpeedFpm, headingDeg, n1Percent }));

  it.each(PAGES)("%s: across the 288-state grid", (_, page) => {
    expect(grid).toHaveLength(288);
    for (const state of grid) {
      const faults = nonFinite(draw(page, state));
      expect(faults, JSON.stringify(state)).toEqual([]);
    }
  });

  it.each(PAGES)("%s: across the secondary fields, and on a square page", (_, page) => {
    for (const flapDeg of [-5, 0, 45])
      for (const spoilers of [0, 0.5, 1])
        for (const throttlePercent of [-10, 0, 100, 150])
          for (const groundSpeedKt of [0, 900])
            for (const [w, h] of [
              [W, H],
              [256, 256],
            ] as const) {
              const state = stateWith({ flapDeg, spoilers, throttlePercent, groundSpeedKt, gearDown: true });
              expect(nonFinite(draw(page, state, w, h)), JSON.stringify(state)).toEqual([]);
            }
  });
});

describe("the PFD's attitude ball", () => {
  /** The horizon is the one white segment as long as the geometry says it is; the test insists there is exactly one. */
  function horizon(state: DisplayState): { readonly left: TransformedPoint; readonly right: TransformedPoint } {
    const { horizonHalfLength } = pfdGeometry(W, H);
    const found = segments(transformedPoints(draw(drawPfd, state))).filter(
      (segment) => segment.from.strokeStyle === DISPLAY_COLOURS.white && Math.abs(length(segment) - 2 * horizonHalfLength) < 1e-6,
    );
    expect(found, "exactly one horizon-length white line").toHaveLength(1);
    const [a, b] = [found[0]!.from, found[0]!.to];
    return a.x < b.x ? { left: a, right: b } : { left: b, right: a };
  }

  it("clamps the pitch offset at 25 degrees, h/40 a degree, nose-up moving the horizon DOWN", () => {
    expect(pfdHorizonOffsetPx(10, H)).toBeCloseTo(75, 9);
    expect(pfdHorizonOffsetPx(-10, H)).toBeCloseTo(-75, 9);
    expect(pfdHorizonOffsetPx(60, H)).toBe(pfdHorizonOffsetPx(25, H));
    expect(pfdHorizonOffsetPx(-90, H)).toBe(pfdHorizonOffsetPx(-25, H));
  });

  it("turns the ball by MINUS the bank", () => {
    expect(attitudeRotationRadians(20)).toBeCloseTo(-20 * DEG, 12);
    expect(attitudeRotationRadians(0)).toBe(-0);
  });

  it("in a 20 degree RIGHT bank the horizon's right end is UP the screen (smaller y), tilted 20 degrees", () => {
    const { left, right } = horizon(stateWith({ bankDeg: 20, pitchDeg: 0 }));
    expect(right.y).toBeLessThan(left.y);
    expect(Math.atan2(right.y - left.y, right.x - left.x) / DEG).toBeCloseTo(-20, 6);
  });

  it("in a 20 degree LEFT bank the horizon's right end is DOWN the screen (larger y)", () => {
    const { left, right } = horizon(stateWith({ bankDeg: -20, pitchDeg: 0 }));
    expect(right.y).toBeGreaterThan(left.y);
    expect(Math.atan2(right.y - left.y, right.x - left.x) / DEG).toBeCloseTo(20, 6);
  });

  it("wings level and 10 degrees nose up: the horizon lies level, BELOW the ball's centre by the offset", () => {
    const { left, right } = horizon(stateWith({ bankDeg: 0, pitchDeg: 10 }));
    const { ballCentre } = pfdGeometry(W, H);
    expect(left.y).toBeCloseTo(ballCentre.y + pfdHorizonOffsetPx(10, H), 6);
    expect(right.y).toBeCloseTo(left.y, 9);
    expect(left.x + right.x).toBeCloseTo(2 * ballCentre.x, 6);
  });

  it("wings level and 10 degrees nose DOWN: the horizon is above the centre by the same offset", () => {
    const { left } = horizon(stateWith({ bankDeg: 0, pitchDeg: -10 }));
    expect(left.y).toBeCloseTo(pfdGeometry(W, H).ballCentre.y - 75, 6);
  });

  it("draws only the rungs the disc can show: the 20s scroll in as the nose comes up", () => {
    // only the ladder's numbers carry a halo, so strokeText counts them alone
    const halos = (state: DisplayState) => draw(drawPfd, state).filter((c) => c.method === "strokeText").map((c) => String(c.args[0]));
    const level = halos(stateWith({ pitchDeg: 0 }));
    // the 10 rungs at 0.25 h are inside the 0.3 h disc, both sides numbered; the 20s at 0.5 h are not
    expect(level.filter((t) => t === "10")).toHaveLength(4);
    expect(level.filter((t) => t === "20")).toHaveLength(0);
    const noseUp = halos(stateWith({ pitchDeg: 20 }));
    // the horizon has dropped 0.5 h: the +20 rung is at the centre and the +10 at 0.25 h; the -10 and -20 are off the disc
    expect(noseUp.filter((t) => t === "20")).toHaveLength(2);
    expect(noseUp.filter((t) => t === "10")).toHaveLength(2);
    // no anchor leaves the page at the pitch clamp under a steep bank
    for (const p of transformedPoints(draw(drawPfd, stateWith({ pitchDeg: 25, bankDeg: 60 }))).filter((p) => p.method === "strokeText")) {
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(H);
    }
  });
});

describe("what the pages write", () => {
  it("the PFD shows the airspeed, the altitude as plain digits, and the heading as three digits", () => {
    const texts = drawnTexts(draw(drawPfd, DISPLAY_STATE_LEVEL));
    expect(texts).toContain("415");
    expect(texts).toContain("5000");
    expect(texts).toContain("090");
    expect(texts).toEqual(expect.arrayContaining(["SPD", "LNAV", "VNAV PTH"]));
  });

  it("the PFD wraps and zero-pads the heading, and rounds the altitude to 20 feet", () => {
    expect(drawnTexts(draw(drawPfd, stateWith({ headingDeg: 370 })))).toContain("010");
    expect(drawnTexts(draw(drawPfd, stateWith({ headingDeg: -10 })))).toContain("350");
    expect(drawnTexts(draw(drawPfd, stateWith({ headingDeg: 359.999 })))).toContain("000");
    expect(drawnTexts(draw(drawPfd, stateWith({ altitudeFtMsl: 5_012 })))).toContain("5020");
  });

  it("the PFD's vertical-speed digits appear beyond 100 feet a minute and not within", () => {
    expect(drawnTexts(draw(drawPfd, stateWith({ verticalSpeedFpm: 1_480 })))).toContain("1500");
    expect(drawnTexts(draw(drawPfd, stateWith({ verticalSpeedFpm: 60 })))).not.toContain("50");
  });

  it("the ND shows the heading, the ground speed and the airspeed as TAS, labels in cyan", () => {
    const points = transformedPoints(draw(drawNd, DISPLAY_STATE_LEVEL)).filter((p) => p.method === "fillText");
    const byText = (t: string) => points.filter((p) => p.text === t);
    expect(byText("090")).toHaveLength(1);
    expect(byText("420")).toHaveLength(1);
    expect(byText("415")).toHaveLength(1);
    expect(byText("GS")[0]?.fillStyle).toBe(DISPLAY_COLOURS.cyan);
    expect(byText("TAS")[0]?.fillStyle).toBe(DISPLAY_COLOURS.cyan);
    expect(byText("HDG")[0]?.fillStyle).toBe(DISPLAY_COLOURS.cyan);
    expect(byText("20")[0]?.fillStyle).toBe(DISPLAY_COLOURS.cyan);
    expect(byText("40")[0]?.fillStyle).toBe(DISPLAY_COLOURS.cyan);
  });

  it("the upper EICAS shows one N1 readout per engine to a decimal, and the gear only when it is down", () => {
    const four = drawnTexts(draw(drawEicasUpper, DISPLAY_STATE_LEVEL));
    expect(four.filter((t) => t === "88.0")).toHaveLength(4);
    expect(four).not.toContain("GEAR DOWN");
    expect(four).not.toContain("SPEEDBRAKE");
    const two = drawnTexts(draw(drawEicasUpper, stateWith({ n1Percent: [50, 61.26], gearDown: true, spoilers: 0.7 })));
    expect(two.filter((t) => t === "50.0")).toHaveLength(1);
    expect(two.filter((t) => t === "61.3")).toHaveLength(1);
    expect(two).toContain("GEAR DOWN");
    expect(two).toContain("SPEEDBRAKE");
    expect(drawnTexts(draw(drawEicasUpper, stateWith({ n1Percent: [] })))).not.toContain("88.0");
  });

  it("the upper EICAS paints the gear green and the speedbrake amber, and shows no speedbrake at half", () => {
    const points = transformedPoints(draw(drawEicasUpper, stateWith({ gearDown: true, spoilers: 1 })));
    expect(points.find((p) => p.text === "GEAR DOWN")?.fillStyle).toBe(DISPLAY_COLOURS.green);
    expect(points.find((p) => p.text === "SPEEDBRAKE")?.fillStyle).toBe(DISPLAY_COLOURS.amber);
    expect(drawnTexts(draw(drawEicasUpper, stateWith({ spoilers: 0.5 })))).not.toContain("SPEEDBRAKE");
  });

  it("the lower EICAS derives N2 and fuel flow from N1, one column per engine", () => {
    const points = transformedPoints(draw(drawEicasLower, DISPLAY_STATE_LEVEL)).filter((p) => p.method === "fillText");
    // N2 = 60 + 0.35 x 88 = 90.8; FF = 2.0 + 0.06 x 88 = 7.28
    expect(points.filter((p) => p.text === "90.8")).toHaveLength(4);
    expect(points.filter((p) => p.text === "7.3")).toHaveLength(4);
    expect(points.filter((p) => p.text === "48")).toHaveLength(4);
    expect(points.find((p) => p.text === "OIL PRESS")?.fillStyle).toBe(DISPLAY_COLOURS.cyan);
    expect(points.find((p) => p.text === "90.8")?.fillStyle).toBe(DISPLAY_COLOURS.white);
    // the four columns sit in ascending x, all to the right of the labels
    const n2 = points.filter((p) => p.text === "90.8").map((p) => p.x);
    expect([...n2].sort((a, b) => a - b)).toEqual(n2);
    expect(Math.min(...n2)).toBeGreaterThan(points.find((p) => p.text === "N2")!.x);
  });
});

describe("the upper EICAS's N1 dial", () => {
  const dial = eicasDialLayout(W, H, 1)[0]!;

  /** The needle is the one white segment that starts at the dial's hub; its angle is canvas convention, degrees. */
  function needleAngle(n1: number): number {
    const points = transformedPoints(draw(drawEicasUpper, stateWith({ n1Percent: [n1] })));
    const fromHub = segments(points).filter((s) => s.from.strokeStyle === DISPLAY_COLOURS.white && Math.hypot(s.from.x - dial.x, s.from.y - dial.y) < 1e-6);
    expect(fromHub, "one white segment from the hub").toHaveLength(1);
    const needle = fromHub[0]!;
    // the tip reaches the arc: the scale replay puts it one radius out, in pixels
    expect(length(needle)).toBeCloseTo(dial.radius, 6);
    return Math.atan2(needle.to.y - dial.y, needle.to.x - dial.x) / DEG;
  }

  it("sweeps 225 degrees over 0 to 110 percent: 0 to 100 is 204.5 degrees clockwise", () => {
    const swept = (((needleAngle(100) - needleAngle(0)) % 360) + 360) % 360;
    expect(Math.abs(swept - (225 * 100) / 110)).toBeLessThan(0.5);
  });

  it("at 100 percent the needle lies on the red radial", () => {
    const points = transformedPoints(draw(drawEicasUpper, stateWith({ n1Percent: [100] })));
    const red = segments(points).filter((s) => s.from.strokeStyle === DISPLAY_COLOURS.red && Math.abs(Math.hypot(s.from.x - dial.x, s.from.y - dial.y) - 0.82 * dial.radius) < 1e-6);
    expect(red, "one red radial on the N1 dial").toHaveLength(1);
    const radial = Math.atan2(red[0]!.to.y - dial.y, red[0]!.to.x - dial.x) / DEG;
    expect(Math.abs(needleAngle(100) - radial)).toBeLessThan(0.01);
  });

  it("pins the needle at 110 for an over-limit reading while the readout says what the engine said", () => {
    expect(needleAngle(130)).toBeCloseTo(needleAngle(110), 6);
    expect(drawnTexts(draw(drawEicasUpper, stateWith({ n1Percent: [130] })))).toContain("130.0");
  });

  it("lays the dials out one per engine, in a row, at one radius", () => {
    for (const engines of [1, 2, 3, 4]) {
      const dials = eicasDialLayout(W, H, engines);
      expect(dials).toHaveLength(engines);
      expect(new Set(dials.map((d) => d.radius)).size).toBe(1);
      expect(new Set(dials.map((d) => d.y)).size).toBe(1);
      dials.forEach((d, i) => {
        if (i > 0) expect(d.x - dials[i - 1]!.x).toBeGreaterThan(2 * d.radius);
        expect(d.x - d.radius).toBeGreaterThan(0);
        expect(d.x + d.radius).toBeLessThan(0.8 * W);
      });
    }
    expect(eicasDialLayout(W, H, 0)).toEqual([]);
  });
});

describe("the atlas", () => {
  const slots: readonly DisplaySlot[] = [
    { page: "pfd", x: 0, y: 0, w: W, h: H },
    { page: "nd", x: W, y: 0, w: W, h: H },
    { page: "eicas-upper", x: 2 * W, y: 0, w: W, h: H },
    { page: "eicas-lower", x: 0, y: H, w: W, h: H },
    { page: "nd", x: W, y: H, w: W, h: H },
    { page: "pfd", x: 2 * W, y: H, w: W, h: H },
  ];
  const EXPECTED_TEXT: Readonly<Record<DisplaySlot["page"], string>> = { pfd: "415", nd: "HDG", "eicas-upper": "88.0", "eicas-lower": "OIL PRESS" };

  it("clips each of six slots to its rectangle and draws its page's text inside it", () => {
    const ctx = createRecordingContext();
    drawDisplayAtlas(ctx, 3 * W, 2 * H, slots, DISPLAY_STATE_LEVEL);
    const calls = ctx.calls;
    const points = transformedPoints(calls);
    // a slot is rect -> clip -> translate with the slot's own numbers
    const slotStarts = slots.map((slot) => {
      const starts = calls
        .map((call, i) => i)
        .filter(
          (i) =>
            calls[i]?.method === "rect" &&
            calls[i + 1]?.method === "clip" &&
            calls[i + 2]?.method === "translate" &&
            JSON.stringify(calls[i]?.args) === JSON.stringify([slot.x, slot.y, slot.w, slot.h]) &&
            JSON.stringify(calls[i + 2]?.args) === JSON.stringify([slot.x, slot.y]),
        );
      expect(starts, `one clip for the ${slot.page} slot at ${slot.x}, ${slot.y}`).toHaveLength(1);
      return starts[0]!;
    });
    expect([...slotStarts].sort((a, b) => a - b)).toEqual(slotStarts);
    slots.forEach((slot, k) => {
      const from = slotStarts[k]!;
      const to = slotStarts[k + 1] ?? calls.length;
      const texts = points.filter((p) => p.method === "fillText" && p.index > from && p.index < to);
      expect(texts.length, `${slot.page} wrote text`).toBeGreaterThan(5);
      expect(texts.map((p) => p.text)).toContain(EXPECTED_TEXT[slot.page]);
      for (const p of texts) {
        expect(p.x, `${slot.page} "${p.text}" x`).toBeGreaterThanOrEqual(slot.x);
        expect(p.x, `${slot.page} "${p.text}" x`).toBeLessThanOrEqual(slot.x + slot.w);
        expect(p.y, `${slot.page} "${p.text}" y`).toBeGreaterThanOrEqual(slot.y);
        expect(p.y, `${slot.page} "${p.text}" y`).toBeLessThanOrEqual(slot.y + slot.h);
      }
    });
  });

  it("draws every slot's page exactly as the page draws alone, offset by the slot", () => {
    const ctx = createRecordingContext();
    drawDisplayAtlas(ctx, 3 * W, 2 * H, slots, DISPLAY_STATE_LEVEL);
    const atlasTexts = transformedPoints(ctx.calls).filter((p) => p.method === "fillText");
    const alone = slots.flatMap((slot) =>
      transformedPoints(draw(PAGES.find(([name]) => name === slot.page)![1], DISPLAY_STATE_LEVEL))
        .filter((p) => p.method === "fillText")
        .map((p) => [p.text, Math.round(p.x + slot.x), Math.round(p.y + slot.y)]),
    );
    expect(atlasTexts.map((p) => [p.text, Math.round(p.x), Math.round(p.y)])).toEqual(alone);
  });
});
