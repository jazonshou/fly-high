# The Global's exterior: what was wrong, measured, and the livery as an image

2026-09-22. Jason: *"the exterior of the Bombardier is very blurry and not very
detailed. The exterior windows are also out of place."* Phase 1 measured the
aeroplane against the type before anything moved; phase 2a (this change) makes
the livery an image. Phases 3a (the cabin panes), 3b (the flight-deck glazing)
and 4 (after-frames, gates, promotion) follow.

## Ground truth

Bombardier's own Global 7500 brochures: the 2018 edition (globaljets.net) and
the February 2021 edition (resources.globalair.com). Published: overall length
33.8 m, span 31.7 m, height 8.2 m; cabin 1.88 m high, 2.44 m wide, 16.59 m long;
the standard layout's four suites with six windows each. Per-window area, 300
sq in (19 dm²), is Wikipedia's, citing Bombardier. No per-side window count is
published anywhere I read.

Geometry is measured off the 2018 brochure's renders at 300 dpi: the top view
(p. 31) and the two side views (p. 29 port, p. 35 starboard). The top view gives
two scales that disagree by 5 % (65.1 px/m from the span, 62.1 px/m from the
length), so stations are quoted as ranges. The side renders are perspective, so
heights there are quoted in WINDOW HEIGHTS measured at each window, which
cancels most of the camera.

## Phase 1: the row, the paint, the blur

What agrees with the type, within the source:

- count, 14 a side (the top view's marks; the starboard render also shows the
  overwing exit's window, the port one the entry door ahead of the row);
- stations: the first window 6.2 m aft of the nose tip against 6.3-6.6, the
  last 18.2 against 18.3-19.2;
- pitch, 0.92 m against 0.92-0.97;
- height: in plan view the window's top edge sits 0.17-0.20 m inboard of the
  silhouette, which on the 1.345 m section is a top edge at y 0.65-0.71; the
  model's is 0.65.

What does not:

- **size**: a 12-sided oval 0.385 x 0.539 m is 0.156 m², 241 sq in, 20 % short
  of 300; the type's pane is a tall rounded rectangle, and the width agrees
  (0.36-0.38 m from width/pitch in the side renders);
- **the paint**: a navy band a window tall centred ON the row, the gold directly
  under it at y +0.056. The type is white, with a thin gold cheatline well below
  the row -- see phase 2a -- and no navy in either brochure;
- **the flight deck**: one raked slab and a side slab each side, whose visible
  outlines are wherever they cut the skin; the type has six panes in one band;
- a **drawing defect**: every cabin pane draws only 0.452 of its 0.539 m, its
  bottom cut flat at y ~0.19. A CPU ray cast does not reproduce the cut, and
  first suggested the pane's fan chords crossing the skin's facets. That was
  wrong: the cause is that the pane the GPU draws is not the one any CPU
  instrument reads (see "The flat cut" below).

The floor: not published. The published 1.88 m cabin height in a 2.69 m section
puts it at or below y -0.66, so the model's sill (0.11) is 0.77 m above it -- a
normal seated sill. The old comment's "floor around -0.45" cannot be right:
-0.45 + 1.88 = 1.43, above the 1.345 m skin.

**The blur is magnification, not mips.** The body's 64-pixel paint tile was laid
once over the 33.5 m body (u is the station): 0.52 m per texel lengthwise, 0.13 m
round. At 40 m in the frames' 62-degree lens that is 28 x 7 screen pixels per
texel, so the sampler reads the base level magnified and the mip chain (FI-5)
never engages. The tile's panel grid, seam, soot and filler drew as half-metre
smears: four dark rings at stations -13.1, -5.4, 2.6 and 9.6, a soot streak along
28 m of the lower port flank, two 3 m filler patches, and a bare-metal radome from
the leading-edge wear.

## Phase 2a: the livery as an image

**Why an image.** The scheme was vertex colour, on the lofts, fin, tailplane,
winglets and nacelles, plus an all-white colour fill on every other body mesh so
a merge could not drop the channel. That channel was the body material's 16th
fragment input live and the 17th in a reflection or fog pass, where the device
refuses the pipeline (the variant rig: 5 and 12 device errors, nothing drawn). It
also drew at the mesh's resolution, 0.18 m round and 1.6-6.5 m between ribs.

**What changed.**

- `bizjetLivery.ts` builds a 1024 x 256 image (3.3 cm a texel both ways; 1.33 MiB
  with its chain) in the pattern of `airlinerLivery.ts`: u the body station
  (x + 18.5) / 33.5, v the loft phase, every height solved per column on
  `GLOBAL_LIVERY_SECTIONS`, uploaded through the hand-built mip boundary.
- The body's three section tables now live in that module and the lofts are
  built from them, so the image is solved on the surface the renderer draws.
- The fuselage, radome and tailcone wear it as `bizjet-skin`, on UV1. The skin's
  relief is the body recipe with the grid, seam, rivets, soot, filler and wear
  off (two new recipe switches, `fillerStrength` and `rivetStrength`, default 1
  and byte-identical elsewhere). The wings and tail keep the body recipe
  unchanged.
- No mesh the body or the skin paints carries a colour channel.
  `render.bizjet-livery` pins that with a positive control, and the variant
  rig's two `KNOWN_OVER_BUDGET` rows are deleted.
- The scheme is a parameter (`GlobalLiveryScheme`): the house scheme ships; the
  navy scheme's fuselage band and nacelles are one constant away.

**The house cheatline is not level.** Sill to gold centre, in window heights,
window counted from the front:

- port render: w1 1.29, w2 1.08, w4 0.89, w6 0.67, w8 0.43, w10 0.18;
- starboard render: w2 0.85, w4 0.71, w6 0.54, w8 0.35, w10 0.14, w11 0.05; from
  w12 aft there is no gold under the row at all.

Taken as the mean, with the sill at 0.11 and a 0.54 m window: -0.41 at window 2,
rising about 3.4 degrees along the row to meet the sill line at window 11
(x ~ -0.4). Forward of the row it runs level at about -0.45 and rises into the
radome tip. On the type, where it meets the row it becomes the aft swoosh, which
crosses the crown at x ~ -4 to -7 (top view, 19-21.5 m aft of the nose); the fin
tip is gold too. Those are stage 2b, and until then the line fades out over the
metre aft of window 11. The two grey pinstripes run 0.165 and 0.32 m below the
gold (0.17/0.33 in the port render, 0.16/0.30 in the starboard). The belly grey
starts at -0.95, below the pinstripes, where the old -0.52 edge would have greyed
them out at the front of the row.

Colours: the gold (197, 158, 85) and grey (171, 167, 165) are sampled off the top
view, lit from above; the base is the body paint's 0xf2f4f3, so the skin meets
the wing without a step. All three are to tune from a frame.

**Measured on the GPU (2026-09-22, 20:56, on the commit that made this
change):** Gate A's rig reads `bizjet-body` 14 (its worst mesh is now the belly
fairing) and `bizjet-skin` 14, headroom 2 each. The variant rig, with the
container: day, night and cockpit 15 and 15; reflection and fog 16 and 16, with
no device error and the target drawn (peak luminance 254, where both passes read
0 with 5 and 12 errors before). With `KNOWN_OVER_BUDGET` empty the test's
both-ways check passes. Frames at the four phase-1 poses show the smears gone,
the skin white, the windows reading dark on it, and the gold rising aft.

## The flat cut: the pane's bow never reached the GPU

The frame with the fuselage hidden settles it. With the skin, window 6 draws
from y 0.640 down to 0.199; without it, from 0.641 down to 0.127 -- the whole
pane. So the skin hides the pane's lower part. Every CPU instrument says it
should not: the ray cast has the pane 0.5-6.6 mm proud there, and also has it
1-3 mm BEHIND the skin at y 0.48-0.56, where the GPU draws it.

The pattern is a FLAT pane, and the mechanism is a Babylon trap. The bow is
written by mutating the array `getVerticesData` returns and then calling
`updateVerticesData`. On a buffer created non-updatable -- `CreateCylinder`'s
default -- `Buffer.update` calls `create`, which does nothing once the GPU buffer
exists, and says nothing. But `getVerticesData` hands back the buffer's own
array, so the in-place mutation changed the CPU copy every instrument reads,
while the GPU kept the flat cylinder uploaded at construction. That pane's outer
face sits at seat + 35 mm, and it crosses the skin at y 0.19: exactly the cut.
(`createNormals` goes through `setVerticesData`, which replaces the buffer, so
the GPU did get the bowed NORMALS.) `LightPoints.ts` met the same trap once, as a
dark airfield. The seating table in `GLOBAL_WINDOW_SEATING_2026_09_20.md` read
the same CPU copy, so its "every vertex within 9 mm" was never the GPU's.

Not fixed here: phase 3a replaces the pane. Its construction has to reach the
GPU through a buffer written once (or updatable), and its standing test has to
catch an `updateVerticesData` on a non-updatable buffer, since no Node read of
the mesh can.

## The stripe's thickness, for Jason to pick

Jason, on the 2a frames: "looking good", and the stripe "running across the
body" thicker. As drawn, the 0.09 m gold is 5 px wide in the 40 m abeam frame
(2560 px, 62-degree lens) -- about 2.4 px in a 1280-wide view -- and on the
shaded flank it renders dark olive (67, 68, 45) on a blue-grey skin (115, 140,
161): it reads by luminance, not by hue, and at that width it reads as a
hairline.

`globalHouseScheme(stripeScale)` draws the group at any scale; 1 is byte for
byte the 2a image. The pinstripes scale WITH the gold and the gaps do not: on
lit previews at the 40 m frame's scale, pinstripes held at 0.03 m are 0.8 of a
pixel in a 1280-wide view and dissolve into shimmer under a thicker gold, while
scaled ones stay lines (1.6 px at 2x, 2.4 at 3x) and keep the type's roughly 3:1
proportion; scaled gaps would carry the second pinstripe off the flank at the
front of the row. The group is 0.38 m tall at 1x, 0.53 at 2x, 0.68 at 3x.

**Jason picked 2x** from the lit previews: the shipped scheme is
`globalHouseScheme(2)`, a 0.18 m gold with 0.06 m pinstripes. Scale 1 stays
pinned byte for byte to the 2a image as the reference, and frames of 1x and 2x,
abeam and three-quarter, come from the next GPU window.

## Stage 2b, and what it is not

The swoosh, the fin tip and the winglet tips are part images on each part's own
UVs, one material each (the 747's spoiler-rim pattern), because vertex colour
cannot come back. The navy scheme's fin, winglet and tailplane marks use the same
mechanism. Titles and logos need a rasteriser, as on the 747, and are not in it.
