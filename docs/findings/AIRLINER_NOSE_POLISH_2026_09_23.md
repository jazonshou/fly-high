# The 747's nose, polished (2026-09-23)

Jason: "The nose of the 747 looks a bit wonky; make it accurate." This is the part of that which ships without
moving the flight deck: the skin behind the flight deck eases onto its roof instead of diving at it, the keel
sweeps up without turning back, and the tip is round instead of a flat disc. The glass, the cockpit kit and the
eye are where they were.

## What was wrong, in the outline

Read through `outlineBreaks(unionOutline(...))` (the outer skin's crown, keel and plan, station by station, as the
ruled surface the loft draws), the hand-ringed nose at ae8ca49:

| where | hand rings | polished |
|---|---|---|
| crown at 28 | -19.8 deg (the forehead dives at 24 deg) | +0.2 |
| crown at 29.2 | +15.7 (bends back UP into the roof over the pilots) | +1.2 |
| worst crown turn, 26 to 30.8 | 19.8 | 3.2 (at 26.2) |
| crown at 31.4, the brow | -37.6 | -37.6, kept |
| keel at 32.4 | -16.5 (the sweep turns back down: a chin) | 0.0 |
| keel, worst downward turn from 26 on | -16.5 | -0.6 (29.6) |
| keel, 26 to 29.2 | +9.9, -10.6, +9.1 at 26, 27.2, 28: a step up to -3.04 and back | under 1.4 a ring |
| keel at 33.4 | +46.0, onto the disc | +2.6, into the round tip |
| tip | flat disc 0.68 x 0.62 m at x 34 | pole at x 34; last ring 0.28 x 0.24 m, 9 mm behind it |
| the tip closure's worst turn, the fan to the pole included | 46.0 (onto the disc) | 9.0, under the ring's own 12.86 round |
| the crown's DIP below a convex roof (hump to brow) | 0.23 m at 29.2 | 0.12 m at 29.0 |

The dip is the crown's depth below the straight line from the hump to the brow at 31.4, which is the roof a convex
nose would have. The 0.12 m left is what raising the roof would remove (see below): the blend eases onto a roof
that is still too low, and cannot lift it without moving the glass.

## What changed

- `FUSELAGE_SECTIONS`: the hand rings 27.2 and 28 are gone; `blendRings` puts fifteen rings, 26.2 to 29.0, on a
  C1 cubic in each outline line (crown, keel, widest point, half-width, and the crown's half-width as a fraction of
  it). Each end takes the slope of the strip beyond it, 21 -> 26 and 29.2 -> 29.6, so the only turns are small ones
  at many rings. `AIRLINER_LIVERY_SECTIONS` calls the same function on the same rings, and the livery-mesh test
  still reads the built rings back against it.
- `NOSE_SECTIONS`: the buried rings behind 29.2 are those blend rings scaled about their centres, 0.97 at 26 rising
  evenly to the 29.2 ring's own 1/1.004. 33.4 keeps its upper half and takes `lowerYRadius` 0.86, which carries the
  keel on at the 31.4 -> 32.4 slope to -1.11 (it was -1.45). `closeOnPole` then closes each radius from 33.4 onto a
  pole at x 34, y -0.25, as `r0 * sqrt(1 - u) * (1 + beta * u)`: vertical at the pole (round), and on the incoming
  strip's slope at 33.4 (no corner). The tip's radii of curvature come out 0.82 m (crown), 0.73 (keel) and 1.04 (plan);
  Boeing's plan view (D6-58326-3 Rev E, p2-5) draws about 0.95.
- The loft closes on the pole (`endPoleX`) instead of a flat fan.
- `sim/aircraft.ts`: the two radome contacts move from the disc's edges, (34, 0.2) and (34, -0.4), to the closure's
  crown and keel at x 33.9, (33.9, 0.16) and (33.9, -0.62), about 5 mm inside the metal.
- `lowerYRadius` is read by the livery's height solve, as the loft reads it.

## What did not move, and what moved without its skin moving

- The nose's rings 29.2, 30.4, 31.4 and 32.4, and 33.4's upper half, are bit-identical, paired by station
  (tests/render.airliner-nose-join.test.ts); so are the fuselage's first ten rings, -26 to 26. The glass is cast onto
  exactly those strips.
- Mesh by mesh against ae8ca49, in POSITIONS AND INDICES: 92 of the 747's 96 meshes, and all 94 of the Global's, are
  bit-identical. That digest does not read thin-instance matrices, and it missed one: the cabin window line is ONE box
  thin-instanced 228 times, and ten of its instances moved (the next section). Four meshes moved in the digest:
  - `airliner-fuselage-shell`: this change (729 -> 1,686 vertices).
  - `airliner-flight-deck-glazing`: 0.42 mm at most.
  - `airliner-windscreen-center-post`: 0.26 mm at most.
  - `airliner-cockpit-interior`, the kit's lining: 7.7 mm at most, at x 33.43 on the new tip.

  The last three are cast from R and stand off the skin along its SHADING NORMALS. The new rings either side of the
  nose's 29.2 and 33.4 rings turn those normals, though not the positions.
- All 37 cockpit tests pass unchanged, the pane corner table's 1 mm pin included.

## The trap: a buried loft's normals still shade the crossing

The first build scaled every buried ring by 0.97, as the old 28 ring was. The join test failed at the crown:
6.0 degrees between the two skins' normals at the crossing (x 29.8), against its 5. The cause was the 29.0 ring,
0.97 of the fuselage's. Its crown sat 6 cm UNDER the nose's 29.2 crown, which is 0.996 of the fuselage's. So the
nose's last buried strip rose into 29.2, and 29.2's vertex normal tipped back. The glass stands off along that
normal, and it had moved 2.1 mm. Ramping the scale up to 0.996 at 29.2 fixed the crossing, and the glass came back
to 0.42 mm.

A buried loft is not invisible: its vertex normals are shared with the rings that carry the visible surface.

## What this does not fix, and why

The nose is still too SHORT ahead of the glass: the windscreen sits 1.4-3.8 m aft of the tip, Boeing's 4.5-6.4
(D6-58326-3 Rev E, side view p2-7). The strip from 32.4 to 33.4 carries the No.1 panes' forward corners (x 32.07 to
32.60), and the corner table holds them to 1 mm: moving 33.4's upper half by 2 cm fails it. So the radome cannot
grow forward without re-casting the glass. The shelf over the pilots and the brow at 31.4 stay too. The No.1 panes
are cast onto the strips either side of the brow, and the roof carries No.2 and No.3. Boeing's drawing puts the root of the problem further back: the model's
eye sits 6.18 m over the belly, at the bottom edge of Boeing's windscreen face (about 6.25-7.47 m). A Boeing-shaped
nose round that eye leaves the lowest designed sightlines (No.1 down to -18 deg) exiting onto the radome. A nose
that is accurate needs the flight deck about 0.7 m higher: the eye, the glass design, the kit, the floor and the
seats (B''). The Boeing-registered loft that assumes it is built and unmerged on jazonshou/747-nose-reloft (7f07e3e).

## Mutations: each is caught by a test aimed at it

Each was applied to `airlinerVisual.ts` alone and run against the 747's nose, cockpit, glazing, livery, digest and
census tests. Every one also fails the geometry digest and the census; this table lists only the tests aimed at it.

| mutation | caught by |
|---|---|
| the flat cap back (no `endPoleX`) | the cockpit's cap census (a fourth cap, at the tip) |
| the keel reversal at 32.4 back (33.4's lower radius 1.2) | the outline test; the join test's 33.4 lower-half pairing |
| 2 cm on 33.4's upper half | the 1 mm corner table; the join test's station pairing |
| 1 cm on 30.4, under the glass | the corner table; the join test; the outline test |
| the hand ring's hard corner at 27.2 | the outline test; the join crossing (normals); the livery transcription and cheatline |

## Re-pins, each with its reason in the test

- Digest (loft-crown-seam): the four meshes above.
- Census (draw budget): 16,027 -> 16,984 vertices and 66,084 -> 71,628 indices, all of it in the shell:
  - fuselage +13 rings, +377 vertices and +2,184 indices;
  - nose from 8 rings and two flat caps to 28 rings, one cap and a pole, +580 and +3,360.

  The extents did not move.
- Paint density along the body: 33.38 -> 33.17 texels/m, with the paint itself byte-identical. The figure is a
  median over the shell's triangles, and more of them are now the nose's.
- The cockpit's cap census: three caps (-26, 25.5, 30.8), because there is no flat cap at 34 now.
- The radome's v steps: 28 rings read, 0.678 .. 1.315 of the loft's own step.
- For the cabin windows (2026-09-24): the digest now reads thin-instance matrices (the 747's pin 5cb70892; the jet's
  8e254ead with its geometry unchanged). The census's positionSum.z 5.8467 -> 5.4175 and positionSquares 12688599.61 ->
  12688157.61, derived in the test.

## The GPU frames (2026-09-24), and the cabin windows they caught

Gate A is green on d30bb05: the 747's varyings are 15/16, and there are 0 errors in every variant of all four
airframes. Before/after pairs at five poses, b2748f3 against d30bb05 (headed, `?seed=g7500`), all at a matched
render scale. They confirm what the CPU frames showed. The forehead eases onto the roof, the tip's silhouette is one
curve, and the chin's flat disc with its concentric shading arcs is gone.

The tip does show faint radial SPOKES converging on the pole, seen head-on at 10 m and invisible from the chase.
They are the loft's 28 segments round the ring meeting at one point, 12.86 degrees apart. Densifying the closure's
rings along x would not remove them. They are accepted.

**The frames caught what the digest could not: the two forward upper-deck windows read as light boxes.**
- Each window was placed on the IDEAL section at its height: the smooth ellipse the rings describe.
- The loft draws that section as 28 flat facets. So each pane stood proud of the drawn skin by the facet's sag at
  its height. A facet-sag prediction reproduced the measured gaps in both trees.
- The blend slid the forward upper-deck heights mid-facet: 5.7 -> 17.6 mm proud at x 28.04. The instances there
  turned by up to 7.9 degrees between the trees, and against the skin's smooth normal they sit 8.7 and 11.3 degrees
  off.

Measuring every pane showed the ideal placement had been off all along:
- The main deck stood 0.5-20.2 mm proud, 16.3 along the barrel, where its 0.2 m height lands 3.5 degrees round from
  a ring vertex. It varies as the section's centre moves: 0.5 at x 7.4, about 20 forward of x 14.
- The upper-deck panes were turned 5.3-7.4 degrees below their skin, because the plain ellipse's gradient leaves out
  the crown taper.

**The fix seats all 228 on the skin as drawn.**
- Each centre is cast straight out from the centreline at the window's height onto the fuselage loft's own triangles.
- Each face is laid along the skin's normal there, with the width along the body.

The normal is NOT the fuselage's shading normal, and the first seating learned that the hard way. A capped loft's
end fan shares its ring's vertices. The buried aft cap at x -26 therefore tilts that ring's normals 35 degrees aft,
and the tilt interpolates forward across the 6 m strip to x -20. The first seating's aft panes were turned 2.6 to 25
degrees off a skin that slopes 1.4 there. Its own test read the turn against those same normals and called it zero.

An adversarial review caught it. The windows now read the side strips only, with normals recomputed without the caps
and the crown seam welded as the loft welds it (`windowSkin`). The glass keeps its caster and is bit-identical.

The visible skin between x -25 and -20 is still SHADED with the cap-tilted normals. That predates this change and is
logged as a follow-up.

`tests/render.airliner-cabin-windows.test.ts` shares nothing with the placement but the built triangles. The gap is
read along each pane's own face normal. The turn is read against the ANALYTIC normal of the loft's ruled surface,
from `FUSELAGE_SECTIONS` and `loftSectionPoint`.

The pins:
- centre within 2 mm of the drawn skin (measured 0.000);
- face within 2 degrees of the smooth normal (measured 1.6, the 28-facet ring's own interpolation);
- width along the body within 1 degree;
- every pane at its design station and height.

Two controls fail it. The old ideal placement fails: median main-deck gap 16.3 mm, forward upper deck 17.9, the
upper deck turned at least 5.3 degrees. The first seating, rebuilt on the capped shading normals, fails: all 16 aft
panes over the pin, 25.2 degrees at the aft-most.

Four mutations fail it:
- a 3 mm outward offset;
- every pane spun 90 degrees about its normal;
- the stations shifted 0.28 m;
- the capped normals put back.

What moved: the pane centres by a median of 16 mm (at most 24), and the faces onto the smooth normal. Against
d30bb05, nothing else moved: every mesh's world matrix, normals, UVs and material are the same, the glazing and the
kit included.

The geometry digest (`render.loft-crown-seam`) now reads thin-instance matrices too, so the jet's pin moved with its
geometry unchanged. The census re-pins two sums, positionSum.z and positionSquares, from the centres alone. A
symmetric box's 24 vertices sum to 24 times its centre, and the loft's split diagonal mirrors the wrong way on one
flank, so mirrored panes now differ by -2.0 to +3.2 mm.

The window fix's own GPU pair (abeam el 0 and el 5) is owed.

