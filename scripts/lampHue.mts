/**
 * Hue classification for lamp pixels — a SUPPLIED COMPONENT, deliberately not
 * wired into any acceptance gate.
 *
 * **Why this exists.** The lamp acceptance metric measures chroma MAGNITUDE
 * (`saturation`), and magnitude cannot tell you which colour arrived. A third
 * of the round-2 lamp glow measured VIOLET — a hue in no fixture, produced by
 * `SCOTOPIC_TINT`'s 1.55 blue coefficient overrunning a warm lamp — and a
 * saturation floor passed it, because magenta clears a saturation floor exactly
 * as well as amber does. **A metric that cannot fail on the wrong answer is not
 * measuring the thing anyone cares about.**
 *
 * **Why it is not a gate.** The band, the weighting and the floor belong with
 * whoever owns the metrics script, and they should be designed after Jason
 * reacts rather than before. This supplies the classification only.
 *
 * **The buckets are a choice and that is worth saying.** Two implementations
 * with different sector boundaries will report different percentages for the
 * same frame, so a number from this is only comparable against another number
 * from this. Boundaries follow the standard HSV sectors, with `amber` split out
 * of orange because it is an aviation colour with a specific meaning here.
 */

export type LampHue =
  | "neutral" | "red" | "amber" | "yellow" | "green"
  | "cyan" | "blue" | "violet" | "magenta";

/**
 * Below this saturation a pixel carries no usable hue and is reported
 * `neutral` rather than assigned one. Without it, near-grey pixels get a hue
 * from floating-point noise and the histogram fills with whatever the noise
 * favours — the ACES-desaturated lamp CORES would each be assigned a colour.
 */
export const LAMP_HUE_NEUTRAL_BELOW = 0.06;

/** HSV hue angle in degrees, or null when the pixel is achromatic. */
export function hueAngle(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return null;
  const chroma = max - min;
  if (chroma / max < LAMP_HUE_NEUTRAL_BELOW) return null;
  let h: number;
  if (max === r) h = 60 * (((g - b) / chroma) % 6);
  else if (max === g) h = 60 * ((b - r) / chroma + 2);
  else h = 60 * ((r - g) / chroma + 4);
  return (h + 360) % 360;
}

/** Standard HSV sectors, with aviation amber split out of orange. */
export function classifyHue(r: number, g: number, b: number): LampHue {
  const h = hueAngle(r, g, b);
  if (h === null) return "neutral";
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "amber";
  if (h < 70) return "yellow";
  if (h < 165) return "green";
  if (h < 195) return "cyan";
  if (h < 255) return "blue";
  if (h < 285) return "violet";
  return "magenta";
}

/** Counts by hue over a pixel list, plus the fraction each represents. */
export function hueHistogram(
  pixels: readonly (readonly [number, number, number])[],
): Record<LampHue, number> {
  const out = {
    neutral: 0, red: 0, amber: 0, yellow: 0, green: 0,
    cyan: 0, blue: 0, violet: 0, magenta: 0,
  } as Record<LampHue, number>;
  for (const [r, g, b] of pixels) out[classifyHue(r, g, b)] += 1;
  return out;
}

/** Saturation, the magnitude metric this component exists to supplement. */
export function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  return max <= 0 ? 0 : (max - Math.min(r, g, b)) / max;
}
