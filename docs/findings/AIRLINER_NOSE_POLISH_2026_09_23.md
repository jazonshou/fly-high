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
- `lowerYRadius` is read by the livery's height solve and `skinPoint`, as the loft reads it.

## What did not move, and what moved without its skin moving

- The nose's rings 29.2, 30.4, 31.4 and 32.4, and 33.4's upper half, are bit-identical, paired by station
  (tests/render.airliner-nose-join.test.ts); so are the fuselage's first ten rings, -26 to 26. The glass is cast onto
  exactly those strips.
- Mesh by mesh against ae8ca49: 92 of the 747's 96 meshes, and all 94 of the Global's, are bit-identical. Four moved:
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

The shelf over the pilots and the brow at 31.4 stay. The No.1 panes are cast onto the strips either side of the
brow, and the roof carries No.2 and No.3. Boeing's drawing puts the root of the problem further back: the model's
eye sits 6.18 m over the belly, at the bottom edge of Boeing's windscreen face (about 6.25-7.47 m). A Boeing-shaped
nose round that eye leaves the lowest designed sightlines (No.1 down to -18 deg) exiting onto the radome. A nose
that is accurate needs the flight deck about 0.7 m higher: the eye, the glass design, the kit, the floor and the
seats (B''). The Boeing-registered loft that assumes it is built and unmerged on jazonshou/747-nose-reloft (7f07e3e).

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

## Not yet verified

GPU frames and Gate A (stage 3) wait for a GPU slot. Nothing here adds a draw, a material or a varying: the shell is
still one mesh on the same material.
