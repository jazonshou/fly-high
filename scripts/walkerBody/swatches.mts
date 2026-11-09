/**
 * Corners of the atlas MakeHuman's UV layout leaves empty, for the geometry
 * the bake adds that has no body UVs of its own: the bands at the garments'
 * edges, and the eyes. A band takes a strip of its garment's swatch, its
 * length along U (squeezed to fit) and its width along V.
 *
 * UVs here are OBJ's: V up from the image's bottom row.
 */
export interface UvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export const SWATCH = Object.freeze({
  jacket: { u0: 0.6, v0: 0.9, u1: 0.83, v1: 0.994 },
  trousers: { u0: 0.006, v0: 0.898, u1: 0.17, v1: 0.994 },
} as const satisfies Record<string, UvRect>);

/** The eyes' square (both eyes share it: they are painted alike). */
export const EYE_RECT: UvRect = Object.freeze({ u0: 0.84, v0: 0.86, u1: 0.98, v1: 1.0 });

export interface Strip {
  readonly u: (along: number) => number;
  readonly v0: number;
  readonly v1: number;
}

export interface SwatchCursor {
  strip(rect: UvRect, length: number, height?: number, perMetre?: number): Strip;
}

/** Strips `height` tall, stacked down each swatch; a strip's U is `perMetre` per metre, squeezed to the swatch's width. */
export function swatchCursor(height = 0.007, defaultPerMetre = 0.18): SwatchCursor {
  const used = new Map<UvRect, number>();
  return {
    strip(rect, length, tall = height, perMetre = defaultPerMetre) {
      const top = used.get(rect) ?? rect.v1;
      const v1 = top;
      const v0 = v1 - tall;
      used.set(rect, v0 - 0.002);
      if (v0 < rect.v0) throw new Error("walker body: a swatch is full");
      const width = rect.u1 - rect.u0;
      const k = Math.min(perMetre, width / Math.max(length, 1e-6));
      return { u: (along) => rect.u0 + along * k, v0, v1 };
    },
  };
}
