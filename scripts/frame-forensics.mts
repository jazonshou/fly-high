/**
 * Frame forensics — measuring a committed capture PNG against the world that
 * produced it, in Node, with no GPU and no capture run.
 *
 * **Why this exists as a tool rather than as a scratch script.** The 2026-08-31
 * P0 investigation (Jason's four visual reports) was resolved almost entirely
 * by measurements of this shape: decode the committed PNG, reconstruct the
 * shot's camera, ray-march screen pixels to world XZ, and evaluate the same
 * CPU authorities the renderer consumed. Every ad-hoc script written for it
 * would have been thrown away, and the next investigation would have rebuilt
 * them — badly, because two of the subtleties below are not obvious and each
 * one produced a wrong conclusion first.
 *
 * **The three traps this module exists to make unrepeatable:**
 *
 * 1. **A frame is often TWO pixel populations, not one.** `canopy-1200ft` is
 *    lit ground plus dark crowns, and the mixing ratio varies by row. A MEAN
 *    over such a region measures the mixture's composition as much as its
 *    brightness, so two correct engineers reached opposite conclusions from the
 *    same two PNGs — mean said "uniform", median said "selective", and the dark
 *    decile said the region moved LESS than its controls. `bandStatistics`
 *    therefore returns five statistics and `compareBands` reports all of them,
 *    because reporting one is how that mistake happens.
 *
 * 2. **A world carries TWO seeds.** `createWorld`'s airport search replaces
 *    `world.seedHash`, while plants are placed from `world.sourceSeedHash`.
 *    Sampling vegetation with the wrong one silently describes a different
 *    forest. `probeWorld` takes the seed explicitly and the caller must pass
 *    `sourceSeedHash` for anything vegetation-related.
 *
 * 3. **A closure value is not a screen-coverage value.** `canopyClosure` is a
 *    Boolean-model NADIR cover fraction; what reaches the screen is capped by
 *    `CANOPY_RENDERED_CROWN_AREA_RATIO` and then scaled by
 *    `canopyRenderedShare(range)`, which at 530 m is 0.08 — so drawn crowns
 *    were 6.4% of the pixel where a naive reading said 94.5%. The remainder is
 *    carried by the terrain through `6-8`'s canopy handoff.
 *
 * Run `npx tsx scripts/frame-forensics.mts --help` for the CLI.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

// ---------------------------------------------------------------- PNG decode

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Buffer;
}

/**
 * Minimal PNG reader — 8-bit truecolour (RGB/RGBA), non-interlaced, which is
 * what `perf:capture` writes. Deliberately dependency-free: the repository has
 * no PNG library and adding one to read our own baselines is not worth a
 * dependency.
 */
export function decodePng(path: string): DecodedImage {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      if (data.length < 13) throw new Error(`${path}: truncated IHDR (${data.length} bytes)`);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`${path}: bit depth ${bitDepth} unsupported`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNG unsupported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`${path}: colour type ${colorType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  /**
   * Validate the inflated length up front so every index below is provably in
   * range. Deliberately NOT a `?? 0` fallback at the read sites: a truncated
   * stream would then decode to a plausible-looking image with zeroed rows,
   * which is exactly the quietly-lying instrument this module exists to catch.
   */
  const expected = height * (stride + 1);
  if (raw.length !== expected) {
    throw new Error(`${path}: inflated to ${raw.length} bytes, expected ${expected}`);
  }
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(pos);
    pos += 1;
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      // In range by the length check above.
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prior ? prior[i]! : 0;
      const c = prior && i >= channels ? prior[i - channels]! : 0;
      const x = row[i]!;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`${path}: unsupported row filter ${filter}`);
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// ------------------------------------------------------------------- colour

export function srgbToLinear(byteValue: number): number {
  const c = byteValue / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb255(y: number): number {
  return 255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055);
}

/** Rec.709 luminance in LINEAR light. Use this, not a mean of sRGB bytes. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function pixelAt(img: DecodedImage, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * img.channels;
  if (i < 0 || i + 2 >= img.data.length) {
    throw new RangeError(`pixel (${x}, ${y}) is outside a ${img.width}x${img.height} image`);
  }
  return [img.data.readUInt8(i), img.data.readUInt8(i + 1), img.data.readUInt8(i + 2)];
}

// --------------------------------------------------------------- statistics

export interface BandStatistics {
  /** Mean of sRGB-encoded luma — the statistic "average pixel value" reports. */
  readonly srgbMean: number;
  readonly srgbMedian: number;
  /** Mean of LINEAR luminance. */
  readonly linearMean: number;
  readonly linearMedian: number;
  /** 10th percentile of linear luminance — the dark tail. */
  readonly linearDarkDecile: number;
  /** Chromaticity r/g/b of the summed bytes; ~0.333 each is neutral. */
  readonly chromaticity: readonly [number, number, number];
}

/**
 * Five statistics, always, because which one you pick decides the answer when
 * the region is a mixture. See trap 1 in this file's header.
 */
export function bandStatistics(
  img: DecodedImage,
  y0: number,
  y1: number,
  step = 2,
): BandStatistics {
  const lin: number[] = [];
  const srgb: number[] = [];
  let R = 0;
  let G = 0;
  let B = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y += 1) {
    for (let x = 0; x < img.width; x += step) {
      const [r, g, b] = pixelAt(img, x, y);
      lin.push(luminance(r, g, b));
      srgb.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      R += r;
      G += g;
      B += b;
    }
  }
  if (!lin.length) throw new Error(`empty band ${y0}..${y1}`);
  lin.sort((a, b) => a - b);
  srgb.sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const total = R + G + B;
  // Non-empty by the guard above, so every index below is in range.
  return {
    srgbMean: mean(srgb),
    srgbMedian: srgb[srgb.length >> 1]!,
    linearMean: mean(lin),
    linearMedian: lin[lin.length >> 1]!,
    linearDarkDecile: lin[Math.floor(lin.length * 0.1)]!,
    chromaticity: [R / total, G / total, B / total],
  };
}

export interface BandComparison {
  readonly statistic: keyof Omit<BandStatistics, "chromaticity">;
  readonly subjectRatio: number;
  readonly controlRatio: number;
  readonly verdict: "selective" | "uniform" | "subject moved less";
}

/**
 * Compare a subject band against control bands across two images, on every
 * statistic. **A single-statistic answer here is not an answer** — if the
 * verdicts disagree, the region differs from its controls in composition and
 * that is the finding, not an inconsistency to resolve by picking one.
 */
export function compareBands(
  before: DecodedImage,
  after: DecodedImage,
  subject: readonly (readonly [number, number])[],
  controls: readonly (readonly [number, number])[],
): BandComparison[] {
  const stats: (keyof Omit<BandStatistics, "chromaticity">)[] = [
    "srgbMean",
    "srgbMedian",
    "linearMean",
    "linearMedian",
    "linearDarkDecile",
  ];
  const ratio = (bands: readonly (readonly [number, number])[], key: typeof stats[number]) => {
    const rs = bands.map(([y0, y1]) => {
      const b = bandStatistics(before, y0, y1);
      const a = bandStatistics(after, y0, y1);
      return a[key] / b[key];
    });
    return rs.reduce((s, v) => s + v, 0) / rs.length;
  };
  return stats.map((statistic) => {
    const subjectRatio = ratio(subject, statistic);
    const controlRatio = ratio(controls, statistic);
    const verdict =
      subjectRatio > controlRatio * 1.25
        ? "selective"
        : subjectRatio < controlRatio * 0.8
          ? "subject moved less"
          : "uniform";
    return { statistic, subjectRatio, controlRatio, verdict };
  });
}

/**
 * Scan the frame for blocks matching a chromaticity signature.
 *
 * Written because a reported "neutral grey strip" turned out to exist nowhere
 * in the image: 0 of 880 blocks fell within 0.02 of the claimed chromaticity,
 * and the brightest block anywhere was below the claimed strip median. **A
 * whole-frame search is what establishes that a signature is absent** — a
 * re-measurement at the claimed location only establishes disagreement.
 */
export function findChromaticity(
  img: DecodedImage,
  target: readonly [number, number, number],
  tolerance = 0.02,
  blockEdge = 32,
): { x: number; y: number; medianLuminance: number; distance: number }[] {
  const hits: { x: number; y: number; medianLuminance: number; distance: number }[] = [];
  for (let by = 0; by + blockEdge <= img.height; by += blockEdge) {
    for (let bx = 0; bx + blockEdge <= img.width; bx += blockEdge) {
      const ys: number[] = [];
      let R = 0;
      let G = 0;
      let B = 0;
      for (let y = by; y < by + blockEdge; y += 2) {
        for (let x = bx; x < bx + blockEdge; x += 2) {
          const [r, g, b] = pixelAt(img, x, y);
          ys.push(luminance(r, g, b));
          R += r;
          G += g;
          B += b;
        }
      }
      const t = R + G + B;
      const chroma: [number, number, number] = [R / t, G / t, B / t];
      const distance = Math.max(
        Math.abs(chroma[0] - target[0]),
        Math.abs(chroma[1] - target[1]),
        Math.abs(chroma[2] - target[2]),
      );
      if (distance <= tolerance) {
        ys.sort((a, b) => a - b);
        // Non-empty: blockEdge >= 2 guarantees at least one sample.
        hits.push({ x: bx, y: by, medianLuminance: ys[ys.length >> 1]!, distance });
      }
    }
  }
  return hits.sort((a, b) => b.medianLuminance - a.medianLuminance);
}

// --------------------------------------------------------------- projection

export interface ShotCamera {
  readonly eye: { x: number; y: number; z: number };
  readonly forward: { x: number; y: number; z: number };
  readonly up: { x: number; y: number; z: number };
  readonly right: { x: number; y: number; z: number };
  readonly width: number;
  readonly height: number;
  /** Horizontal FOV in degrees — Babylon runs FOVMODE_HORIZONTAL_FIXED here. */
  readonly horizontalFovDegrees: number;
}

/**
 * Build the camera for a cockpit-mode capture shot at yaw 0.
 *
 * The cockpit eye sits `forward * 1.15 + up * 1.12` from the aircraft origin
 * (`FlightRenderer`), the FOV is 56° horizontal, and pitch is a rotation about
 * +Z by `-pitchDown` with yaw 0 pointing along +X (`headingVectorFromYaw`).
 */
export function cockpitCamera(
  aircraft: { x: number; y: number; z: number },
  pitchDownDegrees: number,
  width = 1_280,
  height = 720,
  horizontalFovDegrees = 56,
): ShotCamera {
  const p = (pitchDownDegrees * Math.PI) / 180;
  const forward = { x: Math.cos(-p), y: Math.sin(-p), z: 0 };
  const up = { x: -Math.sin(-p), y: Math.cos(-p), z: 0 };
  const right = { x: 0, y: 0, z: 1 }; // forward × up, right-handed with +Y up
  return {
    eye: {
      x: aircraft.x + forward.x * 1.15 + up.x * 1.12,
      y: aircraft.y + forward.y * 1.15 + up.y * 1.12,
      z: aircraft.z + forward.z * 1.15 + up.z * 1.12,
    },
    forward,
    up,
    right,
    width,
    height,
    horizontalFovDegrees,
  };
}

export function rayForPixel(camera: ShotCamera, px: number, py: number) {
  const tanH = Math.tan((camera.horizontalFovDegrees * Math.PI) / 180 / 2);
  const tanV = tanH * (camera.height / camera.width);
  const ndcX = ((px + 0.5) / camera.width) * 2 - 1;
  const ndcY = 1 - ((py + 0.5) / camera.height) * 2;
  const d = {
    x: camera.forward.x + camera.right.x * ndcX * tanH + camera.up.x * ndcY * tanV,
    y: camera.forward.y + camera.right.y * ndcX * tanH + camera.up.y * ndcY * tanV,
    z: camera.forward.z + camera.right.z * ndcX * tanH + camera.up.z * ndcY * tanV,
  };
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / len, y: d.y / len, z: d.z / len };
}

/**
 * March a ray to the terrain surface. `heightAt` is the caller's sampler so
 * this module stays free of a world import (and so a caller can march against
 * a page, a pyramid, or the analytic field as it needs).
 */
export function marchToGround(
  camera: ShotCamera,
  direction: { x: number; y: number; z: number },
  heightAt: (x: number, z: number) => number,
  options: { stepMeters?: number; maxMeters?: number } = {},
): { x: number; z: number; distance: number } | null {
  const step = options.stepMeters ?? 4;
  const max = options.maxMeters ?? 6_000;
  let t = 1;
  let prev = 1;
  const below = (d: number) =>
    camera.eye.y + direction.y * d
    <= heightAt(camera.eye.x + direction.x * d, camera.eye.z + direction.z * d);
  while (t < max) {
    if (below(t)) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 40; i += 1) {
        const mid = (lo + hi) / 2;
        if (below(mid)) hi = mid;
        else lo = mid;
      }
      return {
        x: camera.eye.x + direction.x * hi,
        z: camera.eye.z + direction.z * hi,
        distance: hi,
      };
    }
    prev = t;
    t += step;
  }
  return null;
}

/**
 * Horizontal ground range for a screen row, for a camera at `altitudeAgl` over
 * flat ground. Use it to check whether a feature you can see is even reachable
 * by the mechanism you suspect: at tier 1 the `canopy-1200ft` frame spans
 * 198–678 m, while the vegetation band edges sit at 150 m and 1,196 m and the
 * shadow fade at 1,148 m — **all three off-screen**, which excluded every
 * structural candidate for that shot in one calculation.
 */
export function groundRangeForRow(
  row: number,
  altitudeAglMeters: number,
  pitchDownDegrees: number,
  width = 1_280,
  height = 720,
  horizontalFovDegrees = 56,
): { depressionDegrees: number; slantMeters: number; horizontalMeters: number } {
  const tanH = Math.tan((horizontalFovDegrees * Math.PI) / 180 / 2);
  const tanV = tanH * (height / width);
  const ndcY = 1 - ((row + 0.5) / height) * 2;
  const above = (Math.atan(ndcY * tanV) * 180) / Math.PI;
  const depression = pitchDownDegrees - above;
  const rad = (depression * Math.PI) / 180;
  return {
    depressionDegrees: depression,
    slantMeters: altitudeAglMeters / Math.sin(rad),
    horizontalMeters: altitudeAglMeters / Math.tan(rad),
  };
}

// -------------------------------------------------------------------- CLI

/** A required positional argument, or a usage error naming what was missing. */
function arg(rest: readonly (string | undefined)[], index: number, name: string): string {
  const value = rest[index];
  if (value === undefined || value === "") {
    throw new Error(`missing argument <${name}> at position ${index + 1}`);
  }
  return value;
}

/** `"y0:y1"` -> `[y0, y1]`, rejecting anything that is not two finite numbers. */
function parseBand(spec: string): [number, number] {
  const parts = spec.split(":").map(Number);
  if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`band ${JSON.stringify(spec)} is not "y0:y1"`);
  }
  return [parts[0]!, parts[1]!];
}

if (process.argv[1]?.endsWith("frame-forensics.mts")) {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help") {
    console.log(
      [
        "frame-forensics — measure a capture PNG against the world that produced it",
        "",
        "  bands <png> [y0:y1 ...]        five statistics per band",
        "  compare <before> <after> <subjectY0:Y1> <controlY0:Y1,...>",
        "  chroma <png> <r,g,b> [tol]    whole-frame chromaticity search",
        "  rows <altitudeAgl> <pitchDown>  row -> ground range table",
        "",
        "Read this file's header before trusting a single-statistic answer.",
      ].join("\n"),
    );
  } else if (command === "bands") {
    const img = decodePng(arg(rest, 0, "png path"));
    for (const spec of rest.slice(1).length ? rest.slice(1) : ["0:60"]) {
      const [y0, y1] = parseBand(spec);
      const s = bandStatistics(img, y0, y1);
      console.log(
        `${spec}  srgbMean=${s.srgbMean.toFixed(1)} srgbMed=${s.srgbMedian.toFixed(1)} `
          + `linMean=${s.linearMean.toFixed(4)} linMed=${s.linearMedian.toFixed(4)} `
          + `dark10=${s.linearDarkDecile.toFixed(4)} rgb=${s.chromaticity.map((c) => c.toFixed(3)).join("/")}`,
      );
    }
  } else if (command === "compare") {
    const before = decodePng(arg(rest, 0, "before png"));
    const after = decodePng(arg(rest, 1, "after png"));
    const parse = (s: string) => s.split(",").map(parseBand);
    for (const c of compareBands(
      before,
      after,
      parse(arg(rest, 2, "subject bands")),
      parse(arg(rest, 3, "control bands")),
    )) {
      console.log(
        `  ${c.statistic.padEnd(17)} subject x${c.subjectRatio.toFixed(2)}  `
          + `control x${c.controlRatio.toFixed(2)}  -> ${c.verdict}`,
      );
    }
  } else if (command === "chroma") {
    const img = decodePng(arg(rest, 0, "png path"));
    const parts = arg(rest, 1, "r,g,b").split(",").map(Number);
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
      throw new Error("chroma target must be three finite numbers, e.g. 0.349,0.338,0.313");
    }
    const target: [number, number, number] = [parts[0]!, parts[1]!, parts[2]!];
    const hits = findChromaticity(img, target, rest[2] ? Number(rest[2]) : 0.02);
    console.log(`${hits.length} blocks within tolerance of ${target.join("/")}`);
    for (const h of hits.slice(0, 10)) {
      console.log(`  x=${h.x} y=${h.y} medY=${h.medianLuminance.toFixed(4)} d=${h.distance.toFixed(3)}`);
    }
  } else if (command === "rows") {
    const agl = Number(arg(rest, 0, "altitudeAgl"));
    const pitch = Number(arg(rest, 1, "pitchDown"));
    console.log("row  depression  slant m  horizontal m");
    for (let row = 0; row < 720; row += 48) {
      const r = groundRangeForRow(row, agl, pitch);
      console.log(
        `${String(row).padStart(3)}  ${r.depressionDegrees.toFixed(2).padStart(9)}  `
          + `${r.slantMeters.toFixed(0).padStart(6)}  ${r.horizontalMeters.toFixed(0).padStart(10)}`,
      );
    }
  } else {
    console.error(`unknown command ${command}`);
    process.exitCode = 1;
  }
}
