/**
 * Who the walker is: one particular man, not an average of men.
 *
 * The figure before this one took a third each of MakeHuman's three
 * population targets and nothing else, which is the mean of the means: a face
 * with no feature stronger than any other, and it read as a mask. A real face
 * is specific. So this one is chosen like a casting sheet and every choice
 * leans one way:
 *
 *   A man of about forty who works outdoors. Broad in the shoulder and the
 *   chest, not heavy. A long, square-jawed head; a strong brow over deep-set
 *   eyes; a prominent nose with a bump on the
 *   bridge, set a little to his left; a wide mouth with the corners just
 *   lifted; high cheekbones over leaner cheeks. Nothing in the face is quite
 *   symmetric. Dark brown hair, longer on top and pushed up and across, going
 *   grey at the temples; heavy brows; a short full beard, greying at the chin;
 *   skin that has seen sun.
 *
 * `SHAPE` is the sculpt: MakeHuman targets and their weights (every bundled
 * target is CC0, see `sources.mts`). `LOOK` is the paint (`textures.mts`) and
 * the hair's cut (`clothes.mts`).
 */

const MACRO = "makehuman/data/targets/macrodetails";
const T = "makehuman/data/targets";

/**
 * MakeHuman's macro model: a body is its population target at an age (young
 * is 25, old is 90, blended between) plus the "universal" target for its
 * muscle and weight at that age; detail targets add on top.
 */
export const SHAPE: Readonly<Record<string, number>> = Object.freeze({
  // Mostly one population, at about 38: five parts young to one part old.
  [`${MACRO}/caucasian-male-young.target`]: 0.6,
  [`${MACRO}/caucasian-male-old.target`]: 0.12,
  [`${MACRO}/african-male-young.target`]: 0.18,
  [`${MACRO}/asian-male-young.target`]: 0.1,
  // Muscle 0.7, weight 0.6 on MakeHuman's sliders: a man who works with his body, not a body-builder.
  [`${MACRO}/universal-male-young-maxmuscle-averageweight.target`]: 0.32,
  [`${MACRO}/universal-male-young-maxmuscle-maxweight.target`]: 0.08,
  [`${MACRO}/universal-male-young-averagemuscle-maxweight.target`]: 0.12,
  [`${T}/torso/torso-vshape-incr.target`]: 0.35,
  [`${T}/torso/torso-muscle-pectoral-incr.target`]: 0.2,
  [`${T}/armslegs/l-upperarm-shoulder-muscle-incr.target`]: 0.25,
  [`${T}/armslegs/r-upperarm-shoulder-muscle-incr.target`]: 0.25,
  [`${T}/neck/neck-scale-horiz-incr.target`]: 0.15,
  // The head: long and square at the jaw.
  [`${T}/head/head-square.target`]: 0.12,
  [`${T}/head/head-rectangular.target`]: 0.25,
  [`${T}/chin/chin-prominent-incr.target`]: 0.3,
  [`${T}/chin/chin-width-incr.target`]: 0.45,
  [`${T}/chin/chin-bones-incr.target`]: 0.6,
  // The nose: long, deep, a bump on the bridge.
  [`${T}/nose/nose-hump-incr.target`]: 0.3,
  [`${T}/nose/nose-scale-depth-incr.target`]: 0.35,
  [`${T}/nose/nose-scale-vert-incr.target`]: 0.25,
  [`${T}/nose/nose-volume-incr.target`]: 0.3,
  [`${T}/nose/nose-width2-incr.target`]: 0.2,
  // The brow forward over eyes set back, a little larger than the mean's.
  [`${T}/eyebrows/eyebrows-trans-forward.target`]: 0.45,
  [`${T}/eyebrows/eyebrows-trans-down.target`]: 0.12,
  [`${T}/eyes/l-eye-push1-in.target`]: 0.25,
  [`${T}/eyes/r-eye-push1-in.target`]: 0.25,
  [`${T}/eyes/l-eye-scale-incr.target`]: 0.35,
  [`${T}/eyes/r-eye-scale-incr.target`]: 0.35,
  // Cheekbones over leaner cheeks.
  [`${T}/cheek/l-cheek-bones-incr.target`]: 0.4,
  [`${T}/cheek/r-cheek-bones-incr.target`]: 0.4,
  [`${T}/cheek/l-cheek-volume-decr.target`]: 0.25,
  [`${T}/cheek/r-cheek-volume-decr.target`]: 0.25,
  [`${T}/mouth/mouth-scale-horiz-incr.target`]: 0.25,
  [`${T}/mouth/mouth-angles-up.target`]: 0.3,
  // A face at rest is not a blank one: the mouth's corners just drawn.
  [`${T}/expression/units/caucasian/mouth-corner-puller.target`]: 0.12,
  // No face is symmetric.
  [`${T}/asym/asym-nose-1-l.target`]: 0.35,
  [`${T}/asym/asym-jaw-1-r.target`]: 0.3,
  [`${T}/asym/asym-brown-1-l.target`]: 0.3,
  [`${T}/asym/asym-mouth-1-l.target`]: 0.25,
});

/** Colours are sRGB bytes; lengths are metres. */
export const LOOK = Object.freeze({
  /** Skin that has seen sun: a warm tan, redder over the cheekbones and the nose. */
  skin: [190, 137, 106],
  hair: {
    color: [58, 42, 30],
    greyColor: [158, 153, 146],
    /** The share of grey strands everywhere, and added at the temples. */
    grey: 0.05,
    greyTemples: 0.3,
    /**
     * The hairline: (azimuth round the head from the front, degrees; height
     * above the eyes). High across the forehead and higher at the temples,
     * where it has gone back; the sideburn in front of the ear (which spans
     * about 70 to 95 degrees round, up to 12 mm over the eyes); close over
     * the ear; down to the nape.
     */
    line: [
      [0, 0.062],
      [16, 0.064],
      [32, 0.072],
      [44, 0.066],
      [56, 0.036],
      [65, 0.006],
      [70, -0.014],
      [75, -0.008],
      [82, 0.012],
      [92, 0.018],
      [104, 0.01],
      [118, -0.02],
      [134, -0.044],
      [150, -0.066],
      [165, -0.076],
      [180, -0.079],
    ] as readonly (readonly [number, number])[],
    /** The cut: pushed up at the front, shorter to the crown, tapered at the sides to almost nothing at the nape. */
    front: 0.023,
    crown: 0.018,
    sides: 0.01,
    nape: 0.004,
    /** Combed across to his right: how far the combing leans that way, and how much higher it piles there. */
    across: 0.5,
    pile: 0.14,
    /** How fast it reaches its length in from the hairline (the power of the hairline's own ramp: under 1 is faster). */
    rise: 0.7,
    /** How deep its locks are, as a share of its length. */
    locks: 0.28,
    /** The scalp's faces are divided this many times for the hair's mesh. */
    subdivisions: 1,
  },
  brows: { color: [52, 38, 28] },
  /** A short full beard, a few shades warmer than the hair, grey coming in either side of the chin. */
  beard: { color: [70, 50, 36], greyColor: [146, 137, 126], grey: 0.05, greyChin: 0.22 },
  lips: [140, 86, 78],
  /** Hazel: green-brown at the rim, amber round the pupil. */
  iris: { rim: [74, 62, 34], middle: [122, 96, 48], ring: [150, 104, 44] },
  /** A russet brown hide, and the indigo of jeans a few years old. */
  jacket: [110, 68, 43],
  trousers: [50, 64, 98],
  boots: [88, 58, 38],
});
