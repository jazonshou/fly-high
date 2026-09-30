/**
 * Map a generated (line, column) in a dev-server bundle back to its original
 * source file, from a standard v3 source map.
 *
 * Exists because Vite's optimised dependency bundles are named after one of
 * their modules (`chunk-*.js`, `engineStore-*.js`), so a V8 profile row's URL
 * cannot say whether the time is Babylon's, React's or ours. The source map
 * can. Only `sources` is resolved; names are not needed.
 *
 * Class P: pure, no Node or DOM APIs.
 */

export interface SourceMapV3 {
  readonly version: number;
  readonly sources: readonly string[];
  readonly mappings: string;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/** Decode one VLQ-encoded segment into its signed integer fields. */
export function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = DIGIT.get(char);
    if (digit === undefined) throw new Error(`bad base64 digit ${char}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/** Per generated line: sorted [generatedColumn, sourceIndex] pairs. */
export type LineIndex = readonly (readonly [number, number])[][];

export function indexSourceMap(map: SourceMapV3): LineIndex {
  const lines: [number, number][][] = [];
  let source = 0;
  for (const line of map.mappings.split(";")) {
    const segments: [number, number][] = [];
    let column = 0;
    if (line.length > 0) {
      for (const raw of line.split(",")) {
        if (raw.length === 0) continue;
        const fields = decodeVlqSegment(raw);
        column += fields[0] ?? 0;
        if (fields.length >= 4) {
          source += fields[1]!;
          segments.push([column, source]);
        }
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** Original source for a 0-based generated line/column, or null if unmapped. */
export function lookupSource(
  map: SourceMapV3,
  index: LineIndex,
  line: number,
  column: number,
): string | null {
  const segments = index[line];
  if (!segments || segments.length === 0) return null;
  let best: readonly [number, number] | null = null;
  for (const segment of segments) {
    if (segment[0] <= column) best = segment;
    else break;
  }
  best ??= segments[0]!;
  return map.sources[best[1]] ?? null;
}

/**
 * Coarse origin of a profile frame's code. `servedFromDependency` is whether
 * the served URL was a dependency bundle: a dependency map lists its sources
 * RELATIVE to the bundle (`../../react-dom/cjs/...`), with no `node_modules`
 * segment, so the package name alone decides, and an unrecognised dependency
 * source is never counted as ours.
 */
export function originOf(
  source: string,
  servedFromDependency: boolean,
): "ours" | "babylon" | "react" | "next/vinext" | "other-dep" {
  if (/@babylonjs[\\/]/.test(source)) return "babylon";
  if (/(^|[\\/])(react|react-dom|scheduler)[\\/]/.test(source)) return "react";
  if (/(^|[\\/])(next|vinext|@vitejs|react-server-dom-webpack)[\\/]/.test(source)) return "next/vinext";
  if (servedFromDependency || /node_modules[\\/]/.test(source)) return "other-dep";
  return "ours";
}
