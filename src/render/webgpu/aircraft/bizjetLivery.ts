import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { createRawTextureFromMipChain } from "../core/MipChainUpload";
import { buildLiveryMipChain, phaseOfHeight, type LiveryImage, type LiveryRgb } from "./airlinerLivery";
import type { LoftSection } from "./builders";

/**
 * THE GLOBAL'S LIVERY, rasterised by hand into RGBA bytes, in the pattern of
 * `airlinerLivery.ts` (whose solve, mip reducer and image type this reuses).
 *
 * WHY A TEXTURE, and why now. The Global's scheme was vertex colour on the
 * body material. That cost the fragment stage one input -- UV1 + COLOR is 16 of
 * 16 live, and 17 in a reflection or fog pass, where the device refuses the
 * pipeline -- and it drew at the MESH's resolution: 0.18 m round the 48-segment
 * section and 1.6-6.5 m between ribs lengthwise, so every stripe end smeared
 * across a whole rib gap. An image on UV1 costs no input and draws to a texel.
 *
 * THE AXES are the lofts': u is the station along the body, `(x + 18.5) /
 * 33.5`, which the fuselage and tailcone already share (`bizjetVisual`
 * re-normalises it over the aeroplane's length); v is the phase round the
 * section -- 0 crown, 0.25 starboard flank, 0.5 keel, 0.75 port flank.
 *
 * v IS AN ANGLE, SO A LEVEL LINE IS A CURVE IN THE IMAGE: every height is
 * solved per texel column through `phaseOfHeight`, and nothing is painted as a
 * row. The table it is solved against is `GLOBAL_LIVERY_SECTIONS`, each loft's
 * own sections over the stations where that loft is the skin; see there for
 * the two short overlaps where it is not exact.
 *
 * 1024 x 256: 3.3 cm per texel along the body and 3.3 cm round the 8.45 m
 * cabin circumference. 1.0 MiB for the base level, 1.33 MiB with the chain.
 */
export const GLOBAL_LIVERY_WIDTH = 1024;
export const GLOBAL_LIVERY_HEIGHT = 256;
const CHANNELS = 4;

// ---------------------------------------------------------------------------
// THE BODY'S SECTIONS. The lofts in `bizjetVisual.ts` are built FROM these
// tables, so the livery is solved on the surface the renderer draws, not on a
// transcription of it.
// ---------------------------------------------------------------------------

/**
 * The cabin tube AND THE NOSE, one loft from -13.1 to the tip at 15. Also what
 * the cabin windows and the flight-deck glass are cast onto: a part can only
 * lie in a surface if it can ask where the surface is.
 *
 * THE NOSE IS ONE SURFACE (phase 3c). It was a separate capped radome from
 * 13.1, and the fuselage ended at 13.2 on a cap. `ComputeNormals` averages a
 * ring's normals over the cap's faces too, so the fuselage's last ring was
 * shaded as though it faced half forward: a crease right round the nose at
 * 13.2 in every frame, under the windshield. One loft has no seam to crease.
 *
 * THE WIDTH IS THE TYPE'S, from 4.5 m aft of the tip forward. Half-widths off
 * the brochure's top view (p. 31, with the pitot probes at 1.6-2.2 m aft
 * filtered out and the cabin normalised to 1.345, the top view reading 1.359
 * there): 0.85 at 1.3 m aft, 0.99 at 1.65, 1.10 at 2.0, 1.20 at 2.5, 1.27 at
 * 3.0, 1.32 at 3.5. The nose was 0.12-0.23 m narrower. From the 9.5 ring aft
 * every ring is the cabin's as it was, and the tip's last two rings are the
 * radome's as they were.
 *
 * THE NOSE IS THE TYPE'S SHAPE: low ahead of the flight deck, under a brow,
 * the tip drooped (phase 3c, parts 2-4). The type's nose falls away steeply
 * ahead of the windshield under a brow, and its tip is at the gold line's
 * height; this one was a smooth ogive, 0.3-0.7 m higher at 1-2 m aft of the tip
 * by a camera solved on the port render (p. 29), with its tip at -0.15. What
 * decides it is the seat: from a seated eye (11.90, 0.55, -0.52), 1.21 m above
 * the -0.66 floor, the windshield has to reach below -10 degrees straight ahead
 * (on final the aim point is 6-8 degrees under the body axis), both its top
 * corners above +10, and the centre post's head above +10.
 *
 * The crown, in (m aft of the tip, height): STRAIGHT from the tip's crown
 * (0, -0.45) to the post's foot (1.69, 0.25), on which the windshield's
 * bottom lands; then a polyline through (1.9, 0.37), a brow corner at 2.22
 * and the seat (3.1, 1.0), filleted 1.0 m round its concave corner and 0.8 m
 * round the brow, the corner set so the crown at the post's head (2.22) is
 * 0.735: the face drops hardest just under the brow. Then (3.5, 1.19), (4.0,
 * 1.25), the cabin from 5.5; a monotone cubic through all of it, sampled at
 * the rings. The keel is part 1's aft of 1.8 m and droops to the tip; the
 * widths are part 1's. THE FILLETS ARE THE GLASS'S: the panes are 8 x 8 grids
 * cast onto this skin (their cells up to 0.24 m across), and a sharper brow
 * or face puts a cell centre inside the skin (0.4 mm in, against 12 mm out
 * designed, with the brow a single knee; 7.0 mm out filleted).
 *
 * THE BROW IS A BOUNDED COMPROMISE, NOT A MEASUREMENT (part 4 (d)). The render
 * puts the crown at the post's head near 0.59, which from this eye puts the
 * post's head at +2 degrees; a level roof at 0.87 opens the view to the brief
 * but stands up to 0.29 m proud of the render. 0.735 is the least (to 5 mm)
 * that keeps the post's head, across both its edges, and both port top
 * corners above +10. It stands up to 0.20 m above the render on the face just
 * under the brow, over 0.10 only from 2.03 to 2.39 m aft, and no more than 0.10
 * above it elsewhere from 1.9 to 3.5 m aft (held by render.bizjet-nose against
 * the render's silhouette). A second camera decides the final brow; every
 * ring here is a function of those anchors and fillets.
 */
export const GLOBAL_FUSELAGE_SECTIONS: readonly LoftSection[] = [
  { x: -13.1, yRadius: 1.0, zRadius: 0.96, yOffset: 0.27 },
  { x: -10.5, yRadius: 1.23, zRadius: 1.19, yOffset: 0.12 },
  { x: -8, yRadius: 1.34, zRadius: 1.33, yOffset: 0.03 },
  { x: -2, yRadius: 1.345, zRadius: 1.345 },
  { x: 4.5, yRadius: 1.345, zRadius: 1.345 },
  { x: 9.5, yRadius: 1.335, zRadius: 1.32 },
  { x: 10.5, yRadius: 1.2834, zRadius: 1.3200, yOffset: 0.0065 },
  { x: 11, yRadius: 1.2407, zRadius: 1.3200, yOffset: 0.0093 },
  { x: 11.5, yRadius: 1.1866, zRadius: 1.3150, yOffset: 0.0034 },
  { x: 11.9, yRadius: 1.0679, zRadius: 1.2806, yOffset: -0.0679 },
  { x: 12.2, yRadius: 1.0090, zRadius: 1.2436, yOffset: -0.0813 },
  { x: 12.4, yRadius: 0.9701, zRadius: 1.2152, yOffset: -0.0848 },
  { x: 12.55, yRadius: 0.9393, zRadius: 1.1909, yOffset: -0.0905 },
  { x: 12.7, yRadius: 0.8949, zRadius: 1.1606, yOffset: -0.1096 },
  { x: 12.78, yRadius: 0.8629, zRadius: 1.1444, yOffset: -0.1280 },
  { x: 12.87, yRadius: 0.8177, zRadius: 1.1263, yOffset: -0.1575 },
  { x: 12.95, yRadius: 0.7658, zRadius: 1.1101, yOffset: -0.1952 },
  { x: 13.03, yRadius: 0.7082, zRadius: 1.0906, yOffset: -0.2384 },
  { x: 13.1, yRadius: 0.6665, zRadius: 1.0686, yOffset: -0.2677 },
  { x: 13.2, yRadius: 0.6177, zRadius: 1.0371, yOffset: -0.2996 },
  { x: 13.31, yRadius: 0.5747, zRadius: 1.0026, yOffset: -0.3247 },
  { x: 13.45, yRadius: 0.5315, zRadius: 0.9503, yOffset: -0.3459 },
  { x: 13.6, yRadius: 0.4899, zRadius: 0.8907, yOffset: -0.3643 },
  { x: 13.8, yRadius: 0.4356, zRadius: 0.8062, yOffset: -0.3886 },
  { x: 14.1, yRadius: 0.3515, zRadius: 0.6720, yOffset: -0.4287 },
  { x: 14.4, yRadius: 0.2678, zRadius: 0.5020, yOffset: -0.4693 },
  { x: 14.7, yRadius: 0.1841, zRadius: 0.3400, yOffset: -0.5098 },
  // The tip, its crown at the gold line's height (phase 3c, part 4): the sim's two
  // radome contact points straddle it 0.15 m above and below (`src/sim/aircraft.ts`,
  // held by render.bizjet-nose against the built mesh).
  { x: 15, yRadius: 0.1, zRadius: 0.1, yOffset: -0.55 },
];

/** The upswept tailcone, ending at the sim's tailcone contact point. */
export const GLOBAL_TAILCONE_SECTIONS: readonly LoftSection[] = [
  { x: -18.5, yRadius: 0.14, zRadius: 0.12, yOffset: 0.62 },
  { x: -17.2, yRadius: 0.42, zRadius: 0.36, yOffset: 0.58 },
  { x: -15.4, yRadius: 0.7, zRadius: 0.64, yOffset: 0.48 },
  { x: -12.9, yRadius: 1.02, zRadius: 0.98, yOffset: 0.25 },
];

/** u = (x - minimumX) / length on both body lofts: nose tip to tailcone tip. */
export const GLOBAL_LIVERY_STATION_RANGE = { minimumX: -18.5, length: 33.5 } as const;

/**
 * The table the image is solved on: the tailcone's sections aft of the
 * fuselage's first, then the fuselage's, which run to the nose tip.
 *
 * NOT EXACT IN ONE SHORT SPAN, and measured rather than assumed. Where a
 * loft's own neighbouring ring is not in this table, the loft interpolates
 * toward a ring this table does not have: the tailcone from -15.4 to its own
 * -12.9 ring (this table reaches the fuselage's -13.1 instead). The sections
 * differ there by at most 5.6 mm, at -13.1. The radome was a second such span
 * until the nose became part of the fuselage's loft (phase 3c): forward of
 * the cabin the table IS the loft. `render.bizjet-livery-mesh` measures the
 * drawn line on the built lofts.
 */
export const GLOBAL_LIVERY_SECTIONS: readonly LoftSection[] = [
  ...GLOBAL_TAILCONE_SECTIONS.filter((section) => section.x < GLOBAL_FUSELAGE_SECTIONS[0]!.x),
  ...GLOBAL_FUSELAGE_SECTIONS,
];

// ---------------------------------------------------------------------------
// THE SCHEME. Everything painted is a parameter, so a different scheme is a
// different object, not a redraw.
// ---------------------------------------------------------------------------

/** One line along the body: a centre height that may vary with station, a half-height, a station extent. */
export interface GlobalLiveryStripe {
  readonly name: string;
  /** sRGB bytes: the image is uploaded as an sRGB buffer and the material decodes it. */
  readonly colour: LiveryRgb;
  /**
   * The centre height as (x, y) knots, strictly increasing in x, linear
   * between them and HELD beyond the ends. A level line is two knots at one y.
   */
  readonly centre: readonly (readonly [number, number])[];
  readonly halfHeight: number;
  /** Full between the two FULL stations, smoothstepped to nothing at the two END stations. */
  readonly aftEndX: number;
  readonly aftFullX: number;
  readonly forwardFullX: number;
  readonly forwardEndX: number;
}

export interface GlobalLiveryScheme {
  readonly name: string;
  /** The body's paint where nothing else is drawn. */
  readonly base: LiveryRgb;
  /** Below `topY` the belly colour, ramped in over `feather` metres of height; null for none. */
  readonly belly: { readonly colour: LiveryRgb; readonly topY: number; readonly feather: number } | null;
  /** Painted in order, each over the ones before. */
  readonly stripes: readonly GlobalLiveryStripe[];
  /** The nacelles' paint: null leaves them in the body's own paint. */
  readonly nacelle: LiveryRgb | null;
}

/** The body paint's base, `0xf2f4f3`: the skin has to match the wing it meets. */
export const GLOBAL_BASE_WHITE: LiveryRgb = [242, 244, 243];

/**
 * A linear colour MULTIPLIED INTO the base, as the vertex paint was (vertex
 * colour multiplies albedo after the sRGB decode), encoded back to sRGB bytes.
 * So a colour carried over from the vertex scheme is the colour that scheme
 * actually drew, not its raw triple.
 */
function overBase(linear: readonly [number, number, number]): LiveryRgb {
  return [0, 1, 2].map((channel) => srgbByte(srgbToLinear(GLOBAL_BASE_WHITE[channel]!) * linear[channel]!)) as unknown as LiveryRgb;
}

/** The vertex scheme's belly grey, `[0.46, 0.50, 0.53]` over the base: 171, 179, 183. */
export const GLOBAL_BELLY_GREY: LiveryRgb = overBase([0.46, 0.5, 0.53]);

/**
 * THE TYPE'S HOUSE SCHEME, stage 2a: the gold cheatline on its measured curve,
 * the two grey pinstripes under it, the grey belly, white nacelles.
 *
 * THE LINE IS NOT LEVEL. Measured against each cabin window in both brochure
 * side renders (Bombardier's 2018 Global 7500 brochure, pp. 29 and 35), in
 * window heights so the camera's perspective cancels, sill to gold centre:
 *
 *     window (from the front)   2      4      6      8      10     11
 *     port render               1.08   0.89   0.67   0.43   0.18   -
 *     starboard render          0.85   0.71   0.54   0.35   0.14   0.05
 *
 * With the sill at y 0.11 and a window 0.54 m tall, the mean is the knots
 * below: about -0.41 at window 2 rising 3.4 degrees to meet the sill line at
 * window 11 (x ~ -0.4), where on the type it becomes the aft swoosh. Forward of
 * the row it runs level at about -0.45 into the tip, as both renders show: the
 * tip is drooped to that height (phase 3c, part 3). It rose to -0.2 to meet
 * the old tip at -0.15, and the last knot is now held to the tip. The
 * swoosh is stage 2b; until then the line and the pinstripes fade out over
 * the metre aft of window 11.
 *
 * Colours: the gold and the grey are sampled off the brochure's top view (p31),
 * lit from above; the belly is the vertex scheme's grey over the base. All
 * three are to tune from a frame.
 */
const HOUSE_GOLD_CENTRE: readonly (readonly [number, number])[] = [
  [-0.4, 0.083],
  [0.52, 0.024],
  [2.36, -0.101],
  [4.2, -0.217],
  [6.04, -0.322],
  [7.88, -0.414],
  [9.3, -0.45],
  [13.2, -0.45],
];
const offsetKnots = (knots: readonly (readonly [number, number])[], dy: number) =>
  knots.map(([x, y]) => [x, y + dy] as const);
/**
 * The line's station extent: out over the metre aft of window 11 until the
 * swoosh, and forward to a point at the tip. Forward it fades from 0.6 m aft of
 * the tip (14.4): on the drooped tip (phase 3c, part 3) the ring is 0.2 m tall,
 * about the 2x gold's own 0.18, and a line held full to 14.6 painted the tip
 * cone's flanks gold, a gold chin from the front. The type's line runs out to a
 * point there.
 */
const HOUSE_EXTENT = { aftEndX: -1.4, aftFullX: -0.4, forwardFullX: 14.4, forwardEndX: 14.95 } as const;
/** The gold as measured: 0.09 m (7-8 px against a 0.54 m window's 52 in the starboard render). */
const HOUSE_GOLD_HALF_HEIGHT = 0.045;
/** The pinstripes, 0.03 m: 1-2 px against the same window. */
const HOUSE_PINSTRIPE_HALF_HEIGHT = 0.015;
/**
 * The group's two GAPS, edge to edge: gold to the first pinstripe 0.105 m, the
 * first pinstripe to the second 0.125. With the widths above they put the
 * pinstripes' centres 0.165 and 0.32 m below the gold's (0.17/0.33 in the port
 * render, 0.16/0.30 in the starboard).
 */
const HOUSE_GAPS = [0.105, 0.125] as const;

/**
 * The house belly starts LOWER than the vertex scheme's (-0.52): at the front
 * of the row the gold is at -0.45 and its pinstripes at -0.61 and -0.77, which
 * that edge would have greyed out. From -0.95 down, the keel third.
 */
const HOUSE_BELLY = { colour: GLOBAL_BELLY_GREY, topY: -0.95, feather: 0.25 } as const;

/**
 * The house scheme with its line group `stripeScale` times as thick -- Jason
 * asked for the stripe "running across the body" thicker, and picks the scale.
 *
 * THE PINSTRIPES SCALE WITH THE GOLD, AND THE GAPS DO NOT. Measured on lit
 * previews at the 40 m frame's scale: held at 0.03 m a pinstripe is 0.8 of a
 * pixel at 40 m in a 1280-wide view, so under a thicker gold it dissolves into
 * shimmer and the group reads top-heavy; scaled it is 1.6 px at 2x and 2.4 px
 * at 3x, still a line, and the type's roughly 3:1 gold-to-pinstripe proportion
 * holds. Scaling the gaps too would carry the second pinstripe off the flank
 * at the front of the row (at 3x, 1.0 m below a gold already at -0.45), so the
 * group grows by its lines only: 0.38 m tall at 1x, 0.53 at 2x, 0.68 at 3x.
 * The knots, pinstripe offsets and belly comments above are all stated at 1x.
 */
export function globalHouseScheme(stripeScale = 1): GlobalLiveryScheme {
  if (!(stripeScale > 0)) throw new RangeError("A stripe scale must be positive");
  const gold = HOUSE_GOLD_HALF_HEIGHT * stripeScale;
  const pin = HOUSE_PINSTRIPE_HALF_HEIGHT * stripeScale;
  const first = gold + HOUSE_GAPS[0] + pin;
  const offsets = [first, first + pin + HOUSE_GAPS[1] + pin];
  return {
    name: stripeScale === 1 ? "house" : `house-x${stripeScale}`,
    base: GLOBAL_BASE_WHITE,
    belly: HOUSE_BELLY,
    stripes: [
      { name: "gold", colour: [197, 158, 85], centre: HOUSE_GOLD_CENTRE, halfHeight: gold, ...HOUSE_EXTENT },
      ...offsets.map((offset, index) => ({
        name: `pinstripe-${index + 1}`,
        colour: [171, 167, 165] as LiveryRgb,
        centre: offsetKnots(HOUSE_GOLD_CENTRE, -offset),
        halfHeight: pin,
        ...HOUSE_EXTENT,
      })),
    ],
    nacelle: null,
  };
}

/**
 * THE SHIPPED SCHEME, at 2x: Jason's pick from the 1x / 2x / 3x previews
 * (2026-09-22). A 0.18 m gold with 0.06 m pinstripes, the group 0.53 m tall.
 */
export const GLOBAL_HOUSE_STRIPE_SCALE = 2;
export const GLOBAL_HOUSE_SCHEME: GlobalLiveryScheme = globalHouseScheme(GLOBAL_HOUSE_STRIPE_SCALE);

/**
 * THE SCHEME THE VERTEX PAINT DREW, as parameters: the navy band a window tall
 * centred on the window row, the gold directly under it, navy nacelles. Kept
 * so that keeping it is a parameter, not a redraw. The fuselage half only:
 * the fin's, the winglets' and the tailplane's navy and gold are stage 2b's
 * part images.
 */
export const GLOBAL_NAVY_SCHEME: GlobalLiveryScheme = {
  name: "navy",
  base: GLOBAL_BASE_WHITE,
  belly: { colour: GLOBAL_BELLY_GREY, topY: -0.52, feather: 0.44 },
  stripes: [
    // Centred on the window row (y 0.38) and a window tall (0.539 m), the gold
    // sharing its lower edge: CHEATLINE_Y, CHEATLINE_NAVY_HALF_HEIGHT and
    // PINSTRIPE_Y as the vertex scheme defined them.
    {
      name: "navy", colour: overBase([0.006, 0.018, 0.078]), centre: [[0, 0.38], [1, 0.38]], halfHeight: 0.2695,
      aftEndX: -17.6, aftFullX: -15.6, forwardFullX: 10.4, forwardEndX: 11.6,
    },
    {
      name: "gold", colour: overBase([0.52, 0.3, 0.055]), centre: [[0, 0.0555], [1, 0.0555]], halfHeight: 0.055,
      aftEndX: -17.6, aftFullX: -15.6, forwardFullX: 10.4, forwardEndX: 11.6,
    },
  ],
  nacelle: overBase([0.006, 0.018, 0.078]),
};

// ---------------------------------------------------------------------------
// THE IMAGE
// ---------------------------------------------------------------------------

export interface GlobalLiveryOptions {
  readonly width?: number;
  readonly height?: number;
  readonly sections?: readonly LoftSection[];
}

/**
 * The livery for a scheme. Deterministic: nothing here reads a clock or a
 * random source. Base, then belly, then the stripes in order.
 */
export function buildGlobalLiveryImage(scheme: GlobalLiveryScheme, options: GlobalLiveryOptions = {}): LiveryImage {
  const width = options.width ?? GLOBAL_LIVERY_WIDTH;
  const height = options.height ?? GLOBAL_LIVERY_HEIGHT;
  const sections = options.sections ?? GLOBAL_LIVERY_SECTIONS;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError("A livery image needs positive integer dimensions");
  }
  for (const stripe of scheme.stripes) validateStripe(stripe);
  const data = new Uint8Array(width * height * CHANNELS);
  for (let index = 0; index < width * height; index += 1) {
    data.set(scheme.base, index * CHANNELS);
    data[index * CHANNELS + 3] = 255;
  }
  const raster: Raster = { width, height, data, sections };
  if (scheme.belly) paintBelly(raster, scheme.belly);
  for (const stripe of scheme.stripes) paintStripe(raster, stripe);
  return { width, height, data };
}

/** A solid image, for a part painted one colour all over (the navy scheme's nacelles). */
export function buildSolidLiveryImage(colour: LiveryRgb, size = 4): LiveryImage {
  const data = new Uint8Array(size * size * CHANNELS);
  for (let index = 0; index < size * size; index += 1) {
    data.set(colour, index * CHANNELS);
    data[index * CHANNELS + 3] = 255;
  }
  return { width: size, height: size, data };
}

/** The centre height of a stripe at a station: linear between knots, held beyond them. */
export function stripeCentreAt(stripe: GlobalLiveryStripe, x: number): number {
  const knots = stripe.centre;
  if (x <= knots[0]![0]) return knots[0]![1];
  for (let index = 1; index < knots.length; index += 1) {
    const [x1, y1] = knots[index]!;
    if (x <= x1) {
      const [x0, y0] = knots[index - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return knots[knots.length - 1]![1];
}

/** How much of a stripe is present at a station, 0..1. */
export function stripePresenceAt(stripe: GlobalLiveryStripe, x: number): number {
  return smoothStep(stripe.aftEndX, stripe.aftFullX, x) * (1 - smoothStep(stripe.forwardFullX, stripe.forwardEndX, x));
}

function validateStripe(stripe: GlobalLiveryStripe): void {
  if (stripe.centre.length < 2) throw new RangeError(`${stripe.name}: a stripe needs at least two knots`);
  for (let index = 1; index < stripe.centre.length; index += 1) {
    if (!(stripe.centre[index]![0] > stripe.centre[index - 1]![0])) {
      throw new RangeError(`${stripe.name}: knots must be strictly increasing in x`);
    }
  }
  if (!(stripe.halfHeight > 0)) throw new RangeError(`${stripe.name}: a stripe needs a positive half-height`);
  if (!(stripe.aftEndX <= stripe.aftFullX && stripe.aftFullX <= stripe.forwardFullX
    && stripe.forwardFullX <= stripe.forwardEndX)) {
    throw new RangeError(`${stripe.name}: the station extent must run aft end <= aft full <= forward full <= forward end`);
  }
}

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly sections: readonly LoftSection[];
}

function stationOfColumn(raster: Raster, column: number): number {
  return GLOBAL_LIVERY_STATION_RANGE.minimumX + ((column + 0.5) / raster.width) * GLOBAL_LIVERY_STATION_RANGE.length;
}

function blendTexel(data: Uint8Array, index: number, colour: LiveryRgb, amount: number): void {
  for (let channel = 0; channel < 3; channel += 1) {
    const base = data[index + channel]!;
    data[index + channel] = Math.round(base + (colour[channel]! - base) * amount);
  }
}

/**
 * The belly: each texel takes the colour by its OWN height, ramped over
 * `feather` metres, so the belly's edge is as soft as it was and level on
 * every section. A texel's height is the section's at the texel's centre phase.
 */
function paintBelly(raster: Raster, belly: NonNullable<GlobalLiveryScheme["belly"]>): void {
  for (let column = 0; column < raster.width; column += 1) {
    const x = stationOfColumn(raster, column);
    for (let row = 0; row < raster.height; row += 1) {
      const y = heightOfPhase(raster.sections, x, (row + 0.5) / raster.height);
      const amount = 1 - smoothStep(belly.topY - belly.feather, belly.topY, y);
      if (amount > 0) blendTexel(raster.data, (row * raster.width + column) * CHANNELS, belly.colour, amount);
    }
  }
}

/**
 * A stripe, its two edges ANTI-ALIASED by coverage as the 747's cheatline is:
 * the row an edge falls in takes the fraction of its v extent inside the
 * stripe. A stripe thinner than a texel is therefore drawn as one partial row,
 * which is what it is. Where either edge is off the body the stripe is not
 * drawn at that station at all -- never clamped onto the crown or the keel.
 */
function paintStripe(raster: Raster, stripe: GlobalLiveryStripe): void {
  for (let column = 0; column < raster.width; column += 1) {
    const x = stationOfColumn(raster, column);
    const presence = stripePresenceAt(stripe, x);
    if (presence <= 0) continue;
    const centre = stripeCentreAt(stripe, x);
    const top = phaseOfHeight(raster.sections, x, centre + stripe.halfHeight);
    const bottom = phaseOfHeight(raster.sections, x, centre - stripe.halfHeight);
    if (top === undefined || bottom === undefined) continue;
    for (const span of [{ start: top, end: bottom }, { start: 1 - bottom, end: 1 - top }]) {
      const first = Math.max(0, Math.floor(span.start * raster.height));
      const last = Math.min(raster.height - 1, Math.ceil(span.end * raster.height) - 1);
      for (let row = first; row <= last; row += 1) {
        const coverage = (Math.min((row + 1) / raster.height, span.end) - Math.max(row / raster.height, span.start))
          * raster.height;
        if (coverage <= 0) continue;
        blendTexel(raster.data, (row * raster.width + column) * CHANNELS, stripe.colour, coverage * presence);
      }
    }
  }
}

/**
 * The world height of phase `v` at station `x`: the loft's own section,
 * `y = yOffset + yRadius * cos(2 pi v)` at squareness 2 (the Global's), and
 * the superellipse's `sign(cos) |cos|^(2/n)` in general, as `phaseOfHeight`
 * inverts it.
 */
export function heightOfPhase(sections: readonly LoftSection[], x: number, v: number): number {
  let low = sections[0]!;
  let high = sections[sections.length - 1]!;
  for (let index = 1; index < sections.length; index += 1) {
    if (sections[index]!.x >= x) {
      low = sections[index - 1]!;
      high = sections[index]!;
      break;
    }
  }
  const t = Math.min(1, Math.max(0, (x - low.x) / Math.max(1e-6, high.x - low.x)));
  const yRadius = low.yRadius + (high.yRadius - low.yRadius) * t;
  const yOffset = (low.yOffset ?? 0) + ((high.yOffset ?? 0) - (low.yOffset ?? 0)) * t;
  const squareness = (low.squareness ?? 2) + ((high.squareness ?? 2) - (low.squareness ?? 2)) * t;
  const cosine = Math.cos(v * 2 * Math.PI);
  return yOffset + yRadius * Math.sign(cosine) * Math.abs(cosine) ** (2 / squareness);
}

// ---------------------------------------------------------------------------
// THE UPLOAD BOUNDARY -- the only Babylon in the file.
// ---------------------------------------------------------------------------

/**
 * Upload the livery and its chain as one `RawTexture`, through the hand-built
 * mip boundary (FI-5). u CLAMPS: the three lofts span u 0..1 exactly, and a
 * wrap would bleed the radome onto the tailcone tip. v WRAPS: the seam is the
 * duplicated crown vertex. Anisotropy 8, as the aircraft paint has.
 */
export function createGlobalLiveryTexture(
  scene: Scene,
  mips: readonly LiveryImage[],
  name = "bizjet-livery",
): RawTexture {
  const base = mips[0];
  if (!base) throw new RangeError("A livery upload needs at least the base level");
  const texture = createRawTextureFromMipChain(scene, mips.map((mip) => mip.data), base.width, base.height, {
    useSrgbBuffer: true,
  });
  texture.name = name;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  return texture;
}

/** A part painted one colour all over, as a tiny image with its chain (the navy scheme's nacelles). */
export function createSolidLiveryTexture(scene: Scene, colour: LiveryRgb, name: string): RawTexture {
  return createGlobalLiveryTexture(scene, buildLiveryMipChain(buildSolidLiveryImage(colour)), name);
}

/** The scheme's image with its box-filtered chain, ready for `createGlobalLiveryTexture`. */
export function buildGlobalLiveryMips(scheme: GlobalLiveryScheme): readonly LiveryImage[] {
  return buildLiveryMipChain(buildGlobalLiveryImage(scheme));
}

function srgbToLinear(byte: number): number {
  const encoded = byte / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function srgbByte(linear: number): number {
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

function smoothStep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
