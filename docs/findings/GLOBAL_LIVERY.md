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

## Phase 3a: the panes, cast and built once

The pane is now what the type has and what the GPU draws.

- **The outline:** a rounded rectangle 0.37 x 0.56 m (superellipse exponent 4),
  0.192 m^2 = 298 in^2 against the type's 300. The row is unchanged: 14 a side
  from x 8.8 at a 0.92 m pitch, centred at y 0.38.
- **The seat:** every grid point (7 x 11 a pane) is cast straight out of the
  body onto the fuselage's OWN triangles (`SkinCaster`, the 747 glazing's
  caster), and `skinPanel` builds the pane from those points 6 mm proud and
  30 mm deep. The 28 panes merge into one mesh, `bizjet-cabin-windows`, so it
  is still one draw.
- **Measured by ray over the whole window,** 5,054 rays a side
  (`tests/render.bizjet-cabin-windows.test.ts`): the glass stands 4.06-6.77 mm
  proud of the skin everywhere, the low end being where a cell's chord crosses
  a facet crease. Two controls: the skin read against itself is exactly flush,
  and a pane built 4 mm sunk by the same tools reads as sunk.
- **Nothing is written into a buffer after it is made.**
  `tests/render.aircraft-vertex-buffer-writes.test.ts` watches every
  `VertexBuffer.update` during every airframe's build and fails any whose
  buffer is not updatable. Its positive control is a box written the old way,
  and on the tree before this change it flagged exactly one write in the
  fleet: the Global's pane bow.
- **Geometry:** checked mesh by mesh against 58f8b28, the Global's other 95
  meshes are bit-identical; the old base mesh (54 vertices) is gone and the new
  one is 7,896 vertices and 8,512 triangles.

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

## Phase 3b: the flight deck, six panes cast from the top view

The flight deck was a raked box across the nose and a thick slab each side,
sunk into the skin so that what showed was wherever they cut it: no posts, no
pillars, and a band two-thirds the type's length. It is now the type's six
panes: a windshield either side of a centre post, then a forward and an aft
side pane a side, behind a swept pillar and either side of a mid post, with
the top edge one line from the crown at the post, back and down round the
section to the aft edge.

**The outline is read off the top view** (p. 31, 65.14 px/m, nose tip on row
101), row by row at 0.05 m stations: where the glass starts and stops across
the section, and where the silhouette is. Each edge is kept as metres aft of
the nose tip and degrees round the section from the crown, asin(z /
half-width); the starboard side is the reference and port is the mirror
(port's windshield is washed out by a reflection in the render). The
silhouette jumps at 1.7-1.9 m aft where the pitot probes stand off the skin,
and the half-width there is interpolated across them.

| edge | from | to |
|---|---|---|
| windshield bottom | 1.69 m aft, 4 deg (beside the post) | 2.21 m, 44 deg |
| windshield top | 2.22 m, 4 deg | 2.57 m, 31 deg |
| forward side bottom | 2.28 m, 50 deg | 2.85 m, 63.5 deg |
| forward side top | 2.62 m, 35 deg | 2.93 m, 42 deg |
| aft side bottom | 2.91 m, 64.5 deg | 3.40 m, 68 deg |
| aft side top | 2.99 m, 44 deg | 3.40 m, 51 deg |

The mid post is not resolved in the top view; both starboard renders put it
half way along the side glazing, leaning aft at the top, and that is where it
is. The glazing ends square at 3.40 m aft (3.42 starboard, 3.37 port). The
bottom of the side glazing is the mean of the two sides, which differ by up to
5 degrees where the starboard render's shading darkens the skin beside the
glass. Cross-checks: the starboard render (p. 35), solved for a camera 10
degrees above, puts the aft pane's top edge 53 degrees round the section, and
the top view puts it at 51.

**Why station and angle, not heights: the nose is not the type's.** Against the
top view, the model's nose is 0.12-0.23 m narrower in half-width from 1.3 to
3.5 m aft of the tip (type 0.86 / 1.15 / 1.21 / 1.28 / 1.34 at 1.3 / 2.0 / 2.5
/ 3.0 / 3.5 m; model 0.74 / 0.92 / 1.02 / 1.11 / 1.19). Against the port render,
solved for a camera about 28 degrees below, its crown is 0.2-0.27 m higher
above the stripe where the windshield sits: the type's nose drops steeply ahead
of the flight deck, under a brow, and the model's is a smooth ogive. Heights
copied off the type would float off or sink into this nose. The same station
and the same angle round the section put every corner in the same place ON the
nose, so the glass is where the type's is on whatever nose it is cast onto,
and a re-lofted nose re-casts it with no new table. What it cannot fix is that
the windshield sits higher on this nose than on the type's: from R it runs from
el +2.6 at the post to +13.9, where the type's windshield is below the pilots'
eyes. That is the nose, and it is not in this change.

**How it is built** is the 747's: every grid point is the sightline from R =
(11.90, 0.78, 0), the centreline at the eye's station and height, through the
outline's point on the loft's section, cast onto the fuselage's and radome's
own triangles; `skinPanel` lays the glass 12 mm proud and 30 mm deep, and the
six panes merge into `bizjet-flight-deck-glazing`. The centre post is the same
over +-4 degrees of the crown (0.13 m across; the type's measures 0.13). The
panes are the cabin windows' dark, not the glass material: that is 71 %
see-through, the only thing behind a pane laid on the skin is the white skin,
and it read as a pale tint where the type reads black with the sky in it. From
the seat the panes are hidden, as the glass was.

**The radome had a lip.** It started at its 13.1 ring, inside the fuselage, so
at the fuselage's capped end (13.2) it stood 3.8 cm inside the skin at the
crown: a forward-facing step round the nose, which the 2a table's note called
hidden. It was not, and the windshield crosses it. Cast across the step, the
glass's outer face went under the fuselage's edge (5.2 mm on the windshield,
measured). The radome's 13.2 ring is now the fuselage's own, and the livery
table is exact from 13.2 forward.

`tests/render.bizjet-flight-deck.test.ts` holds it:
- every grid point on its sightline and 12 mm out along the skin's normal;
- every point within 5.7 mm and 0.11 degrees of the outline, with a control
  that moves the windshield 0.1 m and 5 degrees and reads exactly that;
- the outer face 4.5 mm or more outside the skin and the inner 19.6 mm or
  more inside it at every cell centre, with the old radome as the control;
- every face drawn from its own side (from outside, from R and from the left
  seat), with a reversed pane as the control;
- port mirroring starboard to the skin's own 1.5 mm triangulation asymmetry;
- the top edge running monotonically back and down from the post, stepping
  only across the pillar and the mid post.

**The corner table**, which the cockpit's eye and kit are solved against, is
`npx tsx scripts/airliner-glazing-table.mts --airframe bizjet`; the 747's is the
same script without the flag, and its output is unchanged. From the left-seat
eye (11.90, 0.78, -0.52), straight ahead is glass from -0.5 to +17.2 degrees.
Through the middle of each pane at the horizon it runs:
- the port windshield, -1.9 to +12.8;
- the port forward side, -17.5 to +23.4;
- the port aft side, -25.7 to +18.2.

The cockpit kit still places its posts and overhead against the old box
(`cockpit/bizjetCockpit.ts` keeps its own copy of the box). Five of
`render.cockpit-bizjet`'s tests read the box and fail until the kit is
re-solved against this table. That is the cockpit engineer's, by design.

Geometry, checked mesh by mesh against 0ba7987:
- gone: the three glass boxes;
- new: `bizjet-flight-deck-glazing`, 1,440 vertices and 1,512 triangles;
- re-cast: the post;
- changed: the radome, one ring;
- unchanged: the other 91 meshes, bit-identical.

## Phase 3c, part 1: the nose as wide as the type's, and one surface

**The width.** Half-widths, top view, with the pitot probes (which stand off
the skin 1.6-2.2 m aft of the tip) median-filtered out and the cabin
normalised to the model's 1.345 (the top view reads 1.359 there, a 1 %
scale):

| m aft of the tip | type | before | built |
|---|---|---|---|
| 1.3 | 0.851 | 0.73 | 0.851 |
| 2.0 | 1.10 | 0.92 | 1.10 |
| 2.5 | 1.201 | 1.02 | 1.201 |
| 3.0 | 1.272 | 1.11 | 1.272 |
| 3.5 | 1.322 | 1.19 | 1.315 |

The value at 2.0 m is the least certain: the probes cover 1.6-2.2 m, and the
bridge across them reads 1.08 linear and 1.12 as a monotone cubic. My first
reading, 1.15, had the probes in it. The widening starts at the 9.5 ring (5.5 m
aft), which is unchanged, and runs to the 14.4 ring. The last two rings, 14.7
and the tip at 15, are the radome's as they were, and the sim's two radome
contact points at (15, 0.1) and (15, -0.4) still straddle the tip.

**One surface.** The nose was a separate capped radome lofted from 13.1,
inside the fuselage's capped end at 13.2. `ComputeNormals` averages a ring's
normals over every face on it, the cap's included, so the fuselage's last ring
was shaded as though it faced half forward. That is the crease round the nose
under the windshield in the 3b abeam frame: 34 degrees between the two lofts'
normals at 13.2, measured. The nose is now the fuselage loft's own rings,
18 where there were 8. The worst turn between consecutive rings is 7.2
degrees, at the tip where the nose turns fastest. `bizjet-radome` is gone, and
with it the cap the cockpit had to hide.

Across the old join, at every 15 degrees of azimuth, the normals 2 cm either
side of 13.2 now agree within 0.65 degrees. The gate is 5, as for the 747's
join. The same instrument reads 34 degrees at worst on the old nose, and over 5
at all 24 azimuths.

The centre post is in `cockpitParts` with the glass. From the seat the 12 mm
proud, 30 mm deep strip is a slab end-on across the windscreen, and the kit
lines it from inside on the same grid, as the 747's does.

**The height is held.** Each new ring's crown and keel are the old tables' at
its station. Where the old kinks (11.6 and 13.2) now fall between rings the
chord cuts the corner, by at most 2.1 cm at the crown and 0.8 cm at the keel.

**What moved, and what did not.** Checked mesh by mesh against d52ccc2:
- gone: `bizjet-radome`, 207 vertices and 400 triangles;
- grown: `bizjet-fuselage`, from 394 to 884 vertices;
- re-cast onto the wider nose, counts unchanged: the flight-deck glazing and
  the post;
- `bizjet-cabin-windows`: at most 0.16 mm;
- unchanged, bit-identical: the other 89 meshes.

Every fuselage vertex to 9.5 m is bit-identical, and every normal to 4.5 m. The
9.5 ring's normals turned 1.77 degrees, because they average the new span
forward of it. That is why the cabin row moved at all: its cast points are
identical, and the first windows' normals interpolate the 9.5 ring's. No loft
that widens forward of 9.5 can hold those normals.

`tests/render.bizjet-nose.test.ts` holds each claim against the nose as it
was, built from that build's own tables:
- the widths, within 3 cm of the type, where the old nose was 0.1 m or more
  narrower at every station;
- the crown and keel held;
- the cabin bit-identical, with a control on the first ring forward;
- the window row;
- the tip ring and the contact points;
- the smooth shading, against the old 34-degree crease.

The 3b glazing tests pass on the new nose. The outer face is now 7.5 mm or
more out (was 4.5) and the inner face 29.4 mm or more in (was 19.6). The lip
control is kept, cast onto the pre-3b tables written into the test. It reads
5.9 mm under.

**The flight deck on the wider nose** (corner table): the windshield's outer
corner moves out from z 0.67 to 0.80, heights unchanged. From the left-seat
eye, straight ahead is glass from +0.7 to +18.2 degrees (was -0.5 to +17.2).
Through the middles of the port panes at the horizon:
- the windshield, -1.9 to +17.1;
- the forward side pane, -14.9 to +19.7;
- the aft side pane, -20.7 to +13.3.

The eye has 0.34 m of skin above it and 0.48 m to the port wall.

**Part 2, the crown, is measured but not built.**
- **The camera.** It is solved from the port render (p. 29) with a pinhole
  camera, fitted to the window row at the top view's stations (6.40 + 0.915 k m
  aft) and to both silhouettes of the cabin cylinder. The fit is 0.82 px RMS:
  67 m out, 15 degrees below, f 5,516 px. The gold stripe cross-checks it to
  about 0.1 m along the cabin.
- **The type's crown through it:**

  | m aft of the tip | 1.0 | 1.4 | 1.8 | 2.2 | 2.6 | 3.0 |
  |---|---|---|---|---|---|---|
  | type, y (m) | -0.15 | +0.06 | +0.25 | +0.44 | +0.82 | +0.93 |
  | below the model's (m) | 0.7 | 0.65 | 0.63 | 0.55 | 0.28 | 0.27 |

  The tip sits near y -0.6, where the model's is -0.15.
- **Why it is not built yet.** At those heights the windshield would lie
  entirely below any plausible seated eye. Every constraint on the camera is
  in the cabin, and the nose is extrapolated from it (a worse-constrained solve
  moved the tip by 40 px). So the direction is certain (lower, flatter and
  drooped ahead of the flight deck) and the magnitude is not yet good to 3 cm.
- **What would pin it.** A second, independent camera (p. 35, from above),
  and a decision on the tip, whose contact points the sim owns.

## Phase 3c, part 2: the crown lowered for a seated eye

**What decided it was the seat, not the silhouette.** The cockpit engineer's
K0 on part 1's nose found the windshield a slot 17.2 degrees tall from the
catalogue eye (11.90, 0.78, -0.52), and no eye in their grid reached 24. So I
took the windshield as cast, by station and angle round the section, and
measured it straight ahead from the seat while scaling the camera fit's drop
by s, with the tip held. The opening is set by the EYE's height:
- **Crown drop:** it slides the window down without growing it. From 0.78,
  s 0 gives 17.2 degrees, s 0.2 gives 16.5 and s 0.45 gives 15.3.
- **Crown raise:** +0.3 m reaches 25 degrees, but wholly above the horizon,
  over a hump above the cabin crown.
- **Eye at 0.60:** 23.6 degrees at most.
- **Eye at 0.55** (1.21 m above the -0.66 floor, a seated eye): 24-26 degrees
  at any s, with straight ahead inside the glass only once s reaches 0.45.
- **Past s 0.5:** with the tip held, the nose ahead of the windshield goes
  flat and the windshield's foot casts past it.

So the crown is **s = 0.45** of the camera fit: the largest the held tip
allows. It is drawn as a monotone cubic through the held tip (0, 0.3 and 0.6 m
aft), the scaled drop at 1.8-4.0 m aft and the cabin from 5.5, with rings added
at 11.75 and 12.25 for the brow. Nothing rises going forward. The keel and the
widths are part 1's.

| m aft of the tip | 1.3 | 1.8 | 2.2 | 2.6 | 3.0 | 3.5 |
|---|---|---|---|---|---|---|
| crown, part 1 | 0.669 | 0.867 | 0.987 | 1.095 | 1.203 | 1.311 |
| crown, part 2 | 0.489 | 0.596 | 0.762 | 0.960 | 1.079 | 1.259 |

**From the seated eye (11.90, 0.55, -0.52), on the built glass**
(`tests/render.bizjet-seat-view.test.ts`; the corner table with `--eye
11.9,0.55,-0.52`):
- **Straight ahead:** the port windshield spans -0.60 to +25.55 degrees, 26.2
  tall, with the horizon inside it.
- **The windshield's corners,** as azimuth / elevation / range:
  bottom-inboard -17.8 / +1.0 / 1.47, bottom-outboard +17.4 / -1.2 / 0.94,
  top-outboard +11.4 / +26.1 / 0.61, top-inboard -26.5 / +13.3 / 1.01.
- **Through the middle of each port pane at the horizon:** the windshield
  -1.9 to +26.2, the forward side pane -5.6 to +34.3, the aft side pane -8.7
  to +29.7.
- **Room at the seat:** 0.472 m of skin straight up, 0.401 m to the nearest
  skin and 0.442 m to the nearest glass. From the old eye on part 1's nose it
  was 0.341 / 0.302 / 0.38, the numbers K0 measured independently. 0.3 m ahead
  of the seat it is 0.379 / 0.331 / 0.347.
- **The windshield's foot** casts 1.701 m aft, on the loft. The control, the
  same table with two rings sunk 12 cm, moves it to 1.911.
- **The blend into the held tip:** the turn between consecutive rings, over
  every radial, grows steadily at 3.8, 6.3, 8.9 and 12.2 degrees into 13.7,
  14.1, 14.4 and 14.7.
- **What else moved:**
  - the windshield's rake at the post goes from 17 to 22 degrees;
  - the post runs y 0.56-0.77, where it ran 0.83-0.99;
  - the side panes' tops sit at 0.78-0.82 (were 0.83-0.91) and their bottoms
    at 0.45-0.49 (were 0.52-0.65).

From the catalogue eye at 0.78 the same windshield is -11.35 to +5.35
degrees, and every table pin at that eye moves. That eye is the cockpit
engineer's to re-solve against these numbers.

**The seats follow the eye.** They were a tilted box and a headrest at fixed
coordinates, the box's top at about 0.60, which a seated eye at 0.55 would
have had over it. `bizjetSeats.ts` now places them from
`catalogue.cockpitEye`:
- a base from the floor (-0.66) to a cushion 0.80 m under the eye;
- a back to the shoulders, 0.17 m under the eye;
- a headrest behind the head that reaches past the eye.

`tests/render.bizjet-seats.test.ts` reads the catalogue's eye and holds the
cushion offset on the built meshes, so re-solving the eye moves the seats with
it.

The second camera (p. 35 against p. 29) still has to confirm or trim s. The
table is parametric, so a trim is one re-pin.

## Phase 3c, part 3: the full requirement, and the tip released

**The requirement part 2 was built to was incomplete.** It asked only that the
horizon be inside the glass, and part 2's windshield reached 1 degree under it.
On final approach the aim point sits 6-8 degrees under the body axis (a
3-degree glide plus nose-up pitch), where part 2 put the glareshield. The full
requirement, from the seated eye (11.90, 0.55, -0.52), straight ahead:
- the windshield spans -10 to +10 degrees or more;
- it is at least 24 degrees tall;
- the horizon is inside it.

For reference, the type's design eye sees about 15-17 degrees down over the
nose, and the other flight decks here give 8.3-18.6.

**The drop sets the span; the tip only has to get out of the way.** Studied
over s (fraction of the camera fit's crown) and the tip ring's height:
- **How far down the pilot sees is set by s alone.** At s 0.9 straight ahead
  runs -13.2 to +13.2; at s 1.0 it runs -15.7 to +10.4, with 0.4 degrees to
  spare at the top.
- **The tip only needs to be low enough** that the nose ahead of the
  windshield falls faster than the windshield foot's sightline, so the foot
  lands on the nose:
  - s 1.0 needs a tip at -0.6 or lower;
  - s 0.9 needs -0.45 or lower;
  - s 0.8 needs -0.4 or lower.
- **The eye's latitude is narrow.** At s 0.9 the eye can sit at 0.55-0.58; at
  0.80 of the fit, 0.55-0.60. An eye at 0.65 never works.

**Built:** s = 0.9 and the tip at -0.45, the least droop that works there. That
is where the starboard render puts the tip: at the gold line's height, with the
gold running into it. The crown is a monotone cubic from the tip, through 0.9 of
the fit at 1.0-4.0 m aft, to the cabin from 5.5. The keel runs through part 1's
at 1.8-5.5 m aft and droops forward of that to the tip; the widths are part 1's.
The crown drops 0.60 / 0.56 / 0.44 / 0.25 / 0.10 m at 1.3 / 1.8 / 2.2 / 3.0 /
3.5 m aft.

**From the seated eye, on the built glass** (`render.bizjet-seat-view`):
- **Straight ahead:** the windshield spans -12.65 to +13.95 degrees, 26.6
  tall. From 0.78 it is -22.5 to -7.7, wholly below the horizon, which is why
  the eye comes down.
- **Room:** at the seat, 0.368 m of skin straight up, 0.306 m to the nearest
  skin and 0.394 m to the nearest glass. 0.3 m ahead of the seat, 0.262 /
  0.234 / 0.270. The old eye on part 1's nose had 0.341 / 0.302.
- **The windshield's foot** casts at x 13.29. The sunk-ring control moves it to
  1.95 m aft.
- **The turn between rings** is 3.5-6.1 degrees from 13.35 to the last ring
  before the tip, and 13.3 at the brow's crest (11.75).
- **What moved:**
  - the windshield's rake at the post goes to 30 degrees;
  - the side panes' tops come to 0.67-0.74 and their bottoms to 0.33-0.44.

**The sim moves with the tip.** The two radome contact points in
`GLOBAL_8000.airframeContactPoints` go from (15, 0.1) and (15, -0.4) to
(15, -0.20) and (15, -0.70). That keeps them 0.15 m above and below the tip,
as before. `render.bizjet-nose` reads the BUILT tip against them, so a tip that
moves without them fails; the control is the old points, one of which would sit
inside the new tip. The sim reads them in five places:
- the broad-phase radius, 15.0003 -> 15.016;
- the lowest clearance and the ground resolve: a nose-down touch now registers
  0.3 m lower;
- the spawn pose;
- the airframe-strike impact speed.

The airborne start height is unaffected, because the gear is lower at the start
pitch. All of `sim.*` passes: 21 files, 233 tests.

**The livery follows.** The gold's last two knots, (14.4, -0.40) and
(15, -0.20), rose to meet the old tip. They are gone, and the line holds -0.45
into the drooped tip. The line also fades out earlier: from 14.4, where it
held full to 14.6. The drooped tip's ring is 0.2 m tall, about the 2x gold's
own 0.18, so a line held full to 14.6 painted most of the tip cone's flanks: a
gold chin from the front, where the type's line runs out to a point. At the
14.7 ring it is 0.43 of full now, where it was 0.80. This is a change to the
texture alone: all 95 meshes are bit-identical to 8d5deeb.

**Registered, for the second camera and for Jason** (the frames show all
three):
- **The tip's height.** At -0.45 the upper line flattens a little into the tip:
  the crown's slope goes from 0.49 to 0.24 m per metre over the last metre, a
  short "beak". The camera fit's own tip is nearer -0.6. A tip at -0.55 with
  the same crown still passes the requirement (-13.2..+13.2, the foot at
  x 13.29, the crown monotone) and would straighten the line. But it moves the
  radome contact points to (15, -0.30) / (15, -0.80), so a nose-down touch
  registers 0.1 m lower again, and it re-pins the tip and the digests.
- **The brow.** From abeam the crown shows a knee just above the windshield's
  top edge, where the 11.75 crest turns 13.3 degrees ring to ring. Does the
  type's crown turn that sharply there, or flow?
- **The tip's closing radius**, 0.1 m, is the old radome's, carried over. From
  abeam the tip reads sharper than a radome. Is 0.1 the type's?

## Stage 2b, and what it is not

The swoosh, the fin tip and the winglet tips are part images on each part's own
UVs, one material each (the 747's spoiler-rim pattern), because vertex colour
cannot come back. The navy scheme's fin, winglet and tailplane marks use the same
mechanism. Titles and logos need a rasteriser, as on the 747, and are not in it.
