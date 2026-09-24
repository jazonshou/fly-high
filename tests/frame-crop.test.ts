import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng } from "../scripts/frame-forensics.mts";
import { magnifyRegion } from "../scripts/frame-crop.mts";

/**
 * `frame-crop` produced SCANLINE GARBAGE from every Playwright screenshot, for
 * months, and never said a word about it.
 *
 * The decoder was innocent. Playwright writes its screenshots as THREE-channel
 * RGB when the page is opaque, and the crop indexed the decoded buffer at
 * `* 4`. That walks a third of a pixel further along at every pixel and a whole
 * row further every three, which comes out as a sheared, striped version of the
 * real image — recognisable enough that it was twice mistaken for a rendering
 * fault before anyone suspected the tool. `decodePng` had always reported
 * `channels`. Nothing read it.
 *
 * So this file pins two different things: that the decoder REFUSES a PNG it
 * cannot decode rather than returning something plausible, and that the crop
 * honours the channel count it is handed.
 */

/** A PNG header with whatever IHDR fields a case wants to be wrong. */
function png(fields: {
  width?: number; height?: number; bitDepth?: number;
  colorType?: number; interlace?: number; idat?: Buffer;
}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(fields.width ?? 2, 0);
  ihdr.writeUInt32BE(fields.height ?? 2, 4);
  ihdr.writeUInt8(fields.bitDepth ?? 8, 8);
  ihdr.writeUInt8(fields.colorType ?? 6, 9);
  ihdr.writeUInt8(fields.interlace ?? 0, 12);
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    // The decoder does not verify CRCs, so zero is honest here rather than
    // pretending to a checksum this file never computes.
    return out;
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...(fields.idat ? [chunk("IDAT", fields.idat)] : []),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 2x2 RGBA PNG that really does decode, as the control for the four above. */
function validPng(): Buffer {
  const stride = 2 * 4;
  const raw = Buffer.alloc(2 * (stride + 1));
  for (let y = 0; y < 2; y += 1) {
    raw.writeUInt8(0, y * (stride + 1));               // filter: none
    for (let i = 0; i < stride; i += 1) raw.writeUInt8((y * stride + i) & 0xff, y * (stride + 1) + 1 + i);
  }
  return png({ idat: deflateSync(raw) });
}

const dir = mkdtempSync(join(tmpdir(), "frame-crop-"));
function write(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("decodePng refuses what it cannot decode", () => {
  it("throws on a file that is not a PNG at all", () => {
    const path = write("not.png", Buffer.from("this is not a PNG file at all", "ascii"));
    expect(() => decodePng(path)).toThrow(/is not a PNG/);
  });

  it("throws on a bit depth it does not handle", () => {
    const path = write("deep.png", png({ bitDepth: 16 }));
    expect(() => decodePng(path)).toThrow(/bit depth 16/);
  });

  it("throws on an interlaced PNG", () => {
    const path = write("interlaced.png", png({ interlace: 1, idat: deflateSync(Buffer.alloc(8)) }));
    expect(() => decodePng(path)).toThrow(/interlaced/);
  });

  it("throws on a colour type it does not handle", () => {
    const path = write("grey.png", png({ colorType: 0, idat: deflateSync(Buffer.alloc(8)) }));
    expect(() => decodePng(path)).toThrow(/colour type 0/);
  });

  it("throws on a truncated pixel stream rather than zero-filling it", () => {
    // One row short. A decoder that padded would hand back a plausible image
    // with a black stripe, which is the quiet lie this whole file is about.
    const stride = 2 * 4;
    const short = Buffer.alloc(1 * (stride + 1));
    const path = write("short.png", png({ idat: deflateSync(short) }));
    expect(() => decodePng(path)).toThrow(/inflated to \d+ bytes, expected \d+/);
  });

  it("DECODES a valid PNG, so the five refusals above are not just a broken decoder", () => {
    const image = decodePng(write("good.png", validPng()));
    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
    expect(image.channels).toBe(4);
    expect(image.data.length).toBe(2 * 2 * 4);
  });
});

describe("magnifyRegion honours the channel count it is handed", () => {
  /** A 2x2 image whose four pixels are distinguishable. */
  function image(channels: 3 | 4) {
    const pixels = [[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]];
    const data = Buffer.alloc(4 * channels);
    pixels.forEach((rgb, index) => {
      rgb.forEach((value, c) => data.writeUInt8(value, index * channels + c));
      if (channels === 4) data.writeUInt8(255, index * channels + 3);
    });
    return { width: 2, height: 2, channels, data };
  }

  for (const channels of [3, 4] as const) {
    it(`reads the right pixels from a ${channels}-channel frame`, () => {
      const crop = magnifyRegion(image(channels), 0, 0, 2, 2, 1);
      expect(crop.width).toBe(2);
      expect(crop.height).toBe(2);
      // Bottom-right of the 2x2 is the fourth pixel: 100, 110, 120.
      expect([crop.rgba[12], crop.rgba[13], crop.rgba[14]]).toEqual([100, 110, 120]);
      // Top-right is the second: 40, 50, 60. With the channel count ignored
      // and 4 assumed, a 3-channel frame yields 40? no — it yields 50, 60, 70,
      // one channel along, which is precisely the shear that produced the
      // stripes.
      expect([crop.rgba[4], crop.rgba[5], crop.rgba[6]]).toEqual([40, 50, 60]);
      expect(crop.rgba[7], "alpha is forced opaque").toBe(255);
    });
  }

  it("refuses a frame whose data length does not match its own dimensions", () => {
    const broken = { width: 2, height: 2, channels: 3 as const, data: Buffer.alloc(11) };
    expect(() => magnifyRegion(broken, 0, 0, 2, 2, 1))
      .toThrow(/needs 12 bytes, got 11/);
  });

  it("refuses a scale that is not a positive integer", () => {
    expect(() => magnifyRegion(image(3), 0, 0, 2, 2, 0)).toThrow(/positive integer/);
    expect(() => magnifyRegion(image(3), 0, 0, 2, 2, 1.5)).toThrow(/positive integer/);
  });
});
