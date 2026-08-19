import { deflateSync } from "node:zlib";

/**
 * 3-1's debug-viewer output format (Class P: no Babylon, no DOM, no aliased
 * import — the `scripts/perf-capture.mts` shape, driven from a test).
 *
 * `npm run material:preview` runs the 3-1 Node test with
 * `VITE_MATERIAL_PREVIEW=1`, which composes the contact sheet and writes it
 * here to `tests/perf/artifacts/material-contact-sheet.png`: ten materials
 * across, and for each of three footprints a row of albedo, normal,
 * roughness, height and cavity.
 *
 * That sheet is §11 R-3A's answer to "ten hand-tuned recipes judged by eye is
 * the largest unfalsifiable surface in the programme", and the plan is
 * explicit that it is built on day one rather than last. The artifacts
 * directory is gitignored: the sheet is a tool's output, not a committed
 * asset — the repo ships zero image files by design (`TERRAIN_AUDIT.md` §2.1).
 */

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let index = 0; index < 4; index += 1) body[index] = type.charCodeAt(index);
  body.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

/** Minimal RGBA8 PNG encoder — filter type 0 on every scanline, one IDAT. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("PNG dimensions must be positive integers");
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError(
      `PNG expected ${width * height * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}`,
    );
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  const parts = [
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** Where the preview lands, relative to the repo root. */
export const MATERIAL_PREVIEW_PATH = "tests/perf/artifacts/material-contact-sheet.png";

/** Env switch the 3-1 test reads; unset, the test never touches the filesystem. */
export const MATERIAL_PREVIEW_ENV = "VITE_MATERIAL_PREVIEW";

/** Seed and edge the preview is composed at, overridable from the environment. */
export const MATERIAL_PREVIEW_DEFAULT_SEED = "fly-high-material-preview";
export const MATERIAL_PREVIEW_DEFAULT_EDGE = 512;
export const MATERIAL_PREVIEW_CELL_EDGE = 192;
