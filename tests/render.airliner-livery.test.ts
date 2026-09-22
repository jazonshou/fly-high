import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { LoftSection } from "../src/render/webgpu/aircraft/builders";
import {
  AIRLINER_LIVERY_SECTIONS,
  AIRLINER_LIVERY_STATION_RANGE,
  CHEATLINE,
  DOOR_HEIGHT,
  DOOR_WIDTH,
  LIVERY_HEIGHT,
  LIVERY_NAVY,
  LIVERY_WIDTH,
  MAIN_DECK_DOORS,
  MAIN_DECK_FLOOR_Y,
  MAIN_DECK_WINDOW_Y,
  buildAirlinerLivery,
  buildAirlinerLiveryImage,
  buildLiveryMipChain,
  createAirlinerLiveryTexture,
  phaseOfHeight,
  type LiveryImage,
} from "../src/render/webgpu/aircraft/airlinerLivery";

/**
 * The airliner livery image, asserted at the TEXEL against
 * `docs/findings/AIRLINER_LIVERY_GENERATOR_SPEC.md`.
 *
 * Every assertion that looks for a colour also asserts the opposite colour
 * somewhere it should be, in the same test. Without that a generator returning
 * a uniform image passes: "the window row is white" is true of a blank sheet.
 *
 * THE ONE THAT MATTERS is the level band (5 and 5b). v is an angle, so a band
 * at constant world height is a curve in the image -- 0.0445 of a circuit,
 * about 23 texels, between the cabin and x = 30.6. A generator that paints a
 * straight row passes every other test here and reproduces the defect the
 * texture exists to remove. 5 pins the bow to a tolerance, and 5b feeds the
 * same check a deliberately straight row painted by this file and asserts
 * that the check FAILS on it, by the 23 texels the contract predicts. A check
 * that cannot fail on the thing it guards against is not evidence.
 */

const WHITE = [255, 255, 255] as const;
const NAVY = LIVERY_NAVY;

const livery = buildAirlinerLivery();

function texel(image: LiveryImage, column: number, row: number): readonly [number, number, number, number] {
  const index = (row * image.width + column) * 4;
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!, image.data[index + 3]!];
}

function columnOf(image: LiveryImage, x: number): number {
  const { minimumX, length } = AIRLINER_LIVERY_STATION_RANGE;
  return Math.floor(((x - minimumX) / length) * image.width);
}

function rowOf(image: LiveryImage, phase: number): number {
  return Math.min(image.height - 1, Math.floor(phase * image.height));
}

/** The v of a world height at a station, throwing where the body is not that tall. */
function phaseAt(x: number, y: number, flank: "starboard" | "port" = "starboard"): number {
  const phase = phaseOfHeight(AIRLINER_LIVERY_SECTIONS, x, y, flank);
  if (phase === undefined) throw new Error(`y = ${y} is off the body at x = ${x}`);
  return phase;
}

function isWhite(t: readonly [number, number, number, number]): boolean {
  return t[0] === WHITE[0] && t[1] === WHITE[1] && t[2] === WHITE[2];
}

function isNavy(t: readonly [number, number, number, number]): boolean {
  return t[0] === NAVY[0] && t[1] === NAVY[1] && t[2] === NAVY[2];
}

function nearerNavyThanWhite(t: readonly [number, number, number, number]): boolean {
  const toNavy = Math.hypot(t[0] - NAVY[0], t[1] - NAVY[1], t[2] - NAVY[2]);
  const toWhite = Math.hypot(t[0] - WHITE[0], t[1] - WHITE[1], t[2] - WHITE[2]);
  return toNavy < toWhite;
}

/**
 * The band's top-edge row in a column: walking the starboard flank from the
 * crown toward the keel, the first texel nearer navy than white. Reads the
 * IMAGE, not the solve, so it measures what was painted.
 */
function bandTopRow(image: LiveryImage, column: number): number {
  for (let row = 0; row < image.height / 2; row += 1) {
    if (nearerNavyThanWhite(texel(image, column, row))) return row;
  }
  throw new Error(`no band in column ${column}`);
}

/** The level-band check, shared by test 5 and its reverse control. */
function levelBandBow(image: LiveryImage): { cabinRow: number; noseRow: number; bowV: number } {
  const cabinRow = bandTopRow(image, columnOf(image, -20));
  const noseRow = bandTopRow(image, columnOf(image, 30.6));
  return { cabinRow, noseRow, bowV: (noseRow - cabinRow) / image.height };
}

/** Stations clear of every door, frame line and the wing-root tone. */
const CLEAR_STATIONS = [-20, -6, 0, 5, 9, 13, 17, 21, 26, 29.6] as const;

describe("airliner livery image", () => {
  it("1: is 2048 x 512 RGBA, opaque everywhere, and not a uniform sheet", () => {
    expect(livery.width).toBe(LIVERY_WIDTH);
    expect(livery.height).toBe(LIVERY_HEIGHT);
    expect(livery.data.length).toBe(livery.width * livery.height * 4);
    let transparent = 0;
    let white = 0;
    let navy = 0;
    for (let index = 0; index < livery.data.length; index += 4) {
      if (livery.data[index + 3] !== 255) transparent += 1;
      const t = [livery.data[index]!, livery.data[index + 1]!, livery.data[index + 2]!, 255] as const;
      if (isWhite(t)) white += 1;
      else if (isNavy(t)) navy += 1;
    }
    expect(transparent, "every alpha must be 255").toBe(0);
    // The opposite of "opaque and white": there is a band, and it is a
    // minority of the sheet. 2 m of band round 20 m of section over 55 m of
    // 60 is about 8 %; a sheet that is all one thing fails both bounds.
    expect(white / (livery.width * livery.height)).toBeGreaterThan(0.6);
    expect(navy / (livery.width * livery.height)).toBeGreaterThan(0.05);
    expect(navy / (livery.width * livery.height)).toBeLessThan(0.2);
  });

  it("2: is deterministic -- two builds are byte-identical", () => {
    const second = buildAirlinerLivery();
    // `Object.is`, not `.not.toBe`: the matcher deep-compares both 4 MB arrays
    // element by element to compose its message, which took 8.5 s. Measured.
    expect(Object.is(second.data, livery.data)).toBe(false);
    expect(Buffer.from(second.data).equals(Buffer.from(livery.data))).toBe(true);
  });

  it("encodes the scheme's linear navy as sRGB 27, 58, 107", () => {
    expect([...LIVERY_NAVY]).toEqual([27, 58, 107]);
  });

  it("3: keeps the band BELOW the window line -- window row white, band navy, both flanks", () => {
    for (const x of CLEAR_STATIONS) {
      const column = columnOf(livery, x);
      for (const flank of ["starboard", "port"] as const) {
        const windowRow = rowOf(livery, phaseAt(x, MAIN_DECK_WINDOW_Y, flank));
        const bandRow = rowOf(livery, phaseAt(x, (CHEATLINE.topY + CHEATLINE.bottomY) / 2, flank));
        expect(
          isWhite(texel(livery, column, windowRow)),
          `x = ${x} ${flank}: the main-deck window row (row ${windowRow}) is not white: `
            + `${texel(livery, column, windowRow).join(",")}`,
        ).toBe(true);
        expect(
          isNavy(texel(livery, column, bandRow)),
          `x = ${x} ${flank}: the band's centre (row ${bandRow}) is not navy: `
            + `${texel(livery, column, bandRow).join(",")}`,
        ).toBe(true);
      }
    }
  });

  it("4: paints the cheatline's edges as EDGES -- at most 2 intermediate texels per boundary", () => {
    // Stations outside the wing-root tone, so the walk below the band meets
    // white rather than the tone.
    for (const x of [-10, 20] as const) {
      const column = columnOf(livery, x);
      const centreRow = rowOf(livery, phaseAt(x, (CHEATLINE.topY + CHEATLINE.bottomY) / 2));
      const walks = [
        { name: "top", from: rowOf(livery, phaseAt(x, MAIN_DECK_WINDOW_Y)), to: centreRow },
        { name: "bottom", from: centreRow, to: rowOf(livery, phaseAt(x, CHEATLINE.bottomY - 0.5)) },
      ];
      for (const walk of walks) {
        let intermediate = 0;
        let whites = 0;
        let navies = 0;
        for (let row = walk.from; row <= walk.to; row += 1) {
          const t = texel(livery, column, row);
          if (isWhite(t)) whites += 1;
          else if (isNavy(t)) navies += 1;
          else intermediate += 1;
        }
        expect(
          intermediate,
          `x = ${x}, ${walk.name} edge: measured ${intermediate} texels neither white nor full navy `
            + `across the boundary (rows ${walk.from}..${walk.to}); the spec allows 2`,
        ).toBeLessThanOrEqual(2);
        // Both sides of the boundary were actually walked.
        expect(whites, `x = ${x}, ${walk.name} edge: no white texel in the walk`).toBeGreaterThan(0);
        expect(navies, `x = ${x}, ${walk.name} edge: no navy texel in the walk`).toBeGreaterThan(0);
      }
    }
  });

  it("5: the band CURVES -- its top edge at x = 30.6 is 0.040..0.049 of a circuit from x = -20", () => {
    // The contract's measured numbers, straight from the solve.
    expect(phaseAt(-20, CHEATLINE.topY)).toBeCloseTo(0.2696, 3);
    expect(phaseAt(30.6, CHEATLINE.topY)).toBeCloseTo(0.3141, 3);
    // And from the painted image, which is what the GPU will see.
    const bow = levelBandBow(livery);
    expect(
      bow.bowV,
      `band top edge: row ${bow.cabinRow} at x = -20, row ${bow.noseRow} at x = 30.6, `
        + `bow ${bow.bowV.toFixed(4)} of a circuit; the contract measured 0.0445`,
    ).toBeGreaterThanOrEqual(0.04);
    expect(bow.bowV).toBeLessThanOrEqual(0.049);
  });

  it("5b: REVERSE CONTROL -- a straight row fails the same check by ~23 texels at the nose", () => {
    // Painted HERE, not by the generator: the band's own cabin rows carried
    // straight forward at constant v, which is exactly the row a generator
    // that forgot section 3 of the contract would paint.
    const straight: LiveryImage = {
      width: livery.width,
      height: livery.height,
      data: new Uint8Array(livery.width * livery.height * 4).fill(255),
    };
    const topRow = rowOf(straight, phaseAt(-20, CHEATLINE.topY));
    const bottomRow = rowOf(straight, phaseAt(-20, CHEATLINE.bottomY));
    const first = columnOf(straight, CHEATLINE.aftEndX);
    const last = columnOf(straight, CHEATLINE.forwardEndX);
    for (let column = first; column <= last; column += 1) {
      for (let row = topRow; row <= bottomRow; row += 1) {
        for (const r of [row, straight.height - 1 - row]) {
          const index = (r * straight.width + column) * 4;
          straight.data[index] = NAVY[0];
          straight.data[index + 1] = NAVY[1];
          straight.data[index + 2] = NAVY[2];
        }
      }
    }
    const control = levelBandBow(straight);
    const real = levelBandBow(livery);
    // Anchored to the same cabin row, so the whole difference is at the nose.
    expect(control.cabinRow).toBe(real.cabinRow);
    // The check of test 5 must FAIL on it...
    expect(
      control.bowV,
      `the straight row measured a bow of ${control.bowV.toFixed(4)}, inside the 0.040..0.049 `
        + "window: the level-band check cannot tell a straight row from the curve",
    ).toBeLessThan(0.04);
    // ...and by the amount the contract predicts: 0.0445 x 512 = 22.8 texels.
    const texelsOff = Math.abs(control.noseRow - real.noseRow);
    expect(
      texelsOff,
      `straight row sits ${texelsOff} texels from the level band at x = 30.6 (rows `
        + `${control.noseRow} vs ${real.noseRow}); the contract predicts about 23`,
    ).toBeGreaterThanOrEqual(21);
    expect(texelsOff).toBeLessThanOrEqual(25);
  });

  it("6: paints no band where the body is too short -- and does where it is not", () => {
    // Synthetic table: the barrel pinches to yRadius 1.0 at x = 4, where the
    // band's bottom edge at -1.40 is below the keel and |rise| > 1.
    const pinched: readonly LoftSection[] = [
      { x: -26, yRadius: 3.25, zRadius: 3.25, yOffset: 0 },
      { x: 4, yRadius: 1, zRadius: 3.25, yOffset: 0 },
      { x: 34, yRadius: 3.25, zRadius: 3.25, yOffset: 0 },
    ];
    expect(phaseOfHeight(pinched, 4, CHEATLINE.bottomY)).toBeUndefined();
    expect(phaseOfHeight(pinched, 4, CHEATLINE.topY)).toBeDefined();
    const image = buildAirlinerLiveryImage({ sections: pinched });
    const pinchedColumn = columnOf(image, 4);
    let nonWhite = 0;
    for (let row = 0; row < image.height; row += 1) {
      if (!isWhite(texel(image, pinchedColumn, row))) nonWhite += 1;
    }
    expect(nonWhite, `column at x = 4 has ${nonWhite} non-white texels; the body is not that tall there`)
      .toBe(0);
    // The opposite: where the same table IS tall enough, the band is there.
    const tallColumn = columnOf(image, -20);
    const tallBand = rowOf(image, phaseOfHeight(pinched, -20, (CHEATLINE.topY + CHEATLINE.bottomY) / 2)!);
    expect(isNavy(texel(image, tallColumn, tallBand))).toBe(true);
  });

  it("7: outlines door 2 darker than the skin beside it, with a dark window", () => {
    const door = MAIN_DECK_DOORS.find((candidate) => candidate.name === "2")!;
    const eyeY = 0.8;
    const jamb = columnOf(livery, door.x + DOOR_WIDTH / 2);
    const skin = columnOf(livery, door.x + DOOR_WIDTH / 2 + 0.3);
    for (const flank of ["starboard", "port"] as const) {
      const row = rowOf(livery, phaseAt(door.x, eyeY, flank));
      const outline = texel(livery, jamb, row);
      const beside = texel(livery, skin, row);
      expect(isWhite(beside), `${flank}: skin beside door 2 is ${beside.join(",")}, not white`).toBe(true);
      expect(
        Math.max(outline[0], outline[1], outline[2]),
        `${flank}: door 2's jamb is ${outline.join(",")}, not darker than the white beside it`,
      ).toBeLessThan(200);
      // The sill and the lintel, on the door's centreline.
      const centre = columnOf(livery, door.x);
      const lintel = texel(livery, centre, rowOf(livery, phaseAt(door.x, MAIN_DECK_FLOOR_Y + DOOR_HEIGHT, flank)));
      expect(Math.max(lintel[0], lintel[1], lintel[2]), `${flank}: no lintel line`).toBeLessThan(200);
      // Its window, and clear skin above the lintel.
      const pane = texel(livery, centre, rowOf(livery, phaseAt(door.x, 0.27, flank)));
      expect(Math.max(pane[0], pane[1], pane[2]), `${flank}: door window is ${pane.join(",")}`).toBeLessThan(60);
      const above = texel(livery, centre, rowOf(livery, phaseAt(door.x, MAIN_DECK_FLOOR_Y + DOOR_HEIGHT + 0.3, flank)));
      expect(isWhite(above), `${flank}: skin above door 2 is ${above.join(",")}`).toBe(true);
    }
  });

  it("8: bleeds nothing to the seam -- the first and last columns are white top to bottom", () => {
    for (const column of [0, livery.width - 1]) {
      for (let row = 0; row < livery.height; row += 1) {
        const t = texel(livery, column, row);
        expect(isWhite(t), `column ${column} row ${row} is ${t.join(",")}`).toBe(true);
      }
    }
    // The opposite, so a blank sheet does not pass: the band exists one
    // station in.
    expect(isNavy(texel(livery, columnOf(livery, 0), rowOf(livery, phaseAt(0, -0.9))))).toBe(true);
  });

  it("honours the section's squareness rather than assuming an ellipse", () => {
    const round: readonly LoftSection[] = [
      { x: 0, yRadius: 3, zRadius: 3, yOffset: 0 },
      { x: 10, yRadius: 3, zRadius: 3, yOffset: 0 },
    ];
    const squared: readonly LoftSection[] = round.map((section) => ({ ...section, squareness: 4 }));
    const ellipse = phaseOfHeight(round, 5, -1.5)!;
    const superellipse = phaseOfHeight(squared, 5, -1.5)!;
    expect(ellipse).toBeCloseTo(Math.acos(-0.5) / (2 * Math.PI), 6);
    expect(superellipse).toBeCloseTo(Math.acos(-0.25) / (2 * Math.PI), 6);
    expect(phaseOfHeight(round, 5, -1.5, "port")).toBeCloseTo(1 - ellipse, 9);
  });
});

describe("airliner livery mip chain and upload", () => {
  const chain = buildLiveryMipChain(livery);

  it("box-filters to 1 x 1 through twelve levels, every one opaque", () => {
    expect(chain).toHaveLength(Math.log2(LIVERY_WIDTH) + 1);
    expect(chain[0]).toBe(livery);
    for (let level = 1; level < chain.length; level += 1) {
      const above = chain[level - 1]!;
      const here = chain[level]!;
      expect(here.width).toBe(Math.max(1, above.width / 2));
      expect(here.height).toBe(Math.max(1, above.height / 2));
      expect(here.data.length).toBe(here.width * here.height * 4);
      for (let index = 3; index < here.data.length; index += 4) {
        if (here.data[index] !== 255) throw new Error(`level ${level}: alpha ${here.data[index]} at ${index}`);
      }
    }
    const last = chain[chain.length - 1]!;
    expect([last.width, last.height]).toEqual([1, 1]);
    // The 1 x 1 level is the sheet's mean: mostly white, pulled toward navy
    // by the band. Not white, or the band was lost on the way down.
    expect(last.data[0]).toBeGreaterThan(180);
    expect(last.data[0]).toBeLessThan(255);
  });

  it("averages exactly the 2 x 2 block above it, across the band's edge included", () => {
    const x = 20;
    const column = columnOf(livery, x);
    const edgeRow = rowOf(livery, phaseAt(x, CHEATLINE.topY));
    const level1 = chain[1]!;
    for (const [c, r] of [[column, edgeRow], [column, edgeRow + 6], [10, 10]] as const) {
      const c1 = Math.floor(c / 2);
      const r1 = Math.floor(r / 2);
      for (let channel = 0; channel < 4; channel += 1) {
        const sum = texel(livery, 2 * c1, 2 * r1)[channel]!
          + texel(livery, 2 * c1 + 1, 2 * r1)[channel]!
          + texel(livery, 2 * c1, 2 * r1 + 1)[channel]!
          + texel(livery, 2 * c1 + 1, 2 * r1 + 1)[channel]!;
        expect(texel(level1, c1, r1)[channel]).toBe(Math.round(sum / 4));
      }
    }
  });

  it("uploads under NullEngine as one RawTexture with the chain's level count", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const texture = createAirlinerLiveryTexture(scene, chain);
      expect(texture.getSize()).toEqual({ width: LIVERY_WIDTH, height: LIVERY_HEIGHT });
      expect(texture.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
      expect(texture.wrapV).toBe(Texture.WRAP_ADDRESSMODE);
      expect(texture.name).toBe("airliner-livery");
      expect(scene.textures).toContain(texture);
      texture.dispose();
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
