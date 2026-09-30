# The Cessna's cockpit: from boxes to a cabin

**Status: step 1 of 6 (the deck and the board) built. Steps 3, 2, 4, 5 and 6
follow in that order, one commit each.**

Jason, 2026-09-29: *"no need to go overboard, but make sure the details are
there"*; two or three main dials are enough; the cockpit should feel real, with
walls and bars that read as one organic piece rather than blocks pressed
together. The PM's plan, in the order it runs:

| step | what | accept |
|---|---|---|
| S1 | rounded deck wall to wall, board to the walls, door clear of the dials | glareshield + board hard edges 5 -> 0; airspeed hidden 9.0% -> 0 |
| S3 | A-pillars and the door frame as swept rounds, ending into the roof | port post <= 90k px; mid-air ends 2 -> 0; door hard edges 5 -> 0 |
| S2 | bezels, dial faces with ticks, a 2-unit radio stack, a rocker row | bare board 324k -> <= 200k px; rim hard edges 3 -> 0; >= 12 ticks per dial |
| S4 | headliner and header bar, compass, two sun visors | roof hard edges 3 -> 0; compass at el +3.9, visors at +14 |
| S5 | the centre frame as one tapered strip; the cowl's aft cap | <= 45k px, no facet silhouette; rim 1 -> 0 |
| S6 | yokes, raised 4 cm so the horn tops show | >= 15 px above the frame's bottom at 16:9 |

Across all six steps:
- the deck line holds;
- every vertex stays 2 cm inside the glass and the roof;
- new surfaces are smooth-shaded, with no chord bands;
- cockpit draws rise by 8 at most;
- inter-stage inputs stay within 15/16;
- digests are re-pinned only on the trainer's line, and mesh by mesh.

## How it is measured

All frames here are 1920 x 1080, taken level from the eye (1.38, 0.12, -0.26)
through the 75-degree lens. The cockpit camera does not look around, so this one
frame is everything the pilot sees.

**The census clips at the near plane.** The shared drawn-face raster
(`tests/support/drawnFaceRaster.ts`, `rasterise`) skips any triangle with a
vertex within 5 cm of the eye, or behind it. The door panels and sills run past
the pilot's shoulder, so they vanished from it completely: the first survey read
the doors as 0 px. `rasteriseClipped` (same file) clips each triangle against a
2 cm near plane, using the same drawn-face rule. The pins below use it.

**A hard edge** is one that meets all of these:
- the faces meet at more than 46 degrees;
- the shading is split across the edge;
- at least one face points toward the pilot;
- depth-confirmed samples show it is really in front.

A 58-degree crease on smooth normals is a facet silhouette, not a hard edge, and
it is counted separately.

**The mesh-by-mesh digest** compares every field of every mesh against 303372e,
for all four airframes: positions, indices, normals, UVs, world matrix, thin
instances, material and visibility. A step may move only the meshes it names.

## S1: the deck and the board

**What was there.** Two boxes: a 0.84 m panel and a 2 cm hood slab laid on top.
Both had square ends that stopped in mid-air short of the walls, or poked through
them. Their four long edges read as five hard edges, 2,680 px of them. The
port door's forward end came across the airspeed dial and hid 9.0% of it.

**What is there now.**

- **The deck** (`trainer-glareshield`) is one swept solid, running across the
  cabin from wall to wall, 2 cm inside the cabin line on each side.
  - Its section is `roundedDeckSection`: a nose of radius 2.5 cm (6 segments)
    set tangent to the deck-line sight plane. That tangency is what makes the
    deck's edge a single screen row.
  - A 45-degree cove, 1 cm deep, runs down into the board, and the hood falls
    away 12 degrees forward, out of sight.
  - Its ends turn into the walls on a 2 cm round. At its first station the end
    faces aft; at its last it faces 78.8 degrees round toward the wall, in steps
    of under 25 degrees.

- **The board** (`trainer-instrument-panel`) is a swept solid too, following its
  own rear face.
  - Each point of it sits 2 cm inside the cabin, measured at that point's own
    station and height. Measuring at the rear face instead left the front top
    corner 1.1 cm outside the glass.
  - Below the cove, the board may flare out to the walls at 45 degrees; above
    it, it may not reach past the deck.
  - Its ends have the same 2 cm round as the deck's.

- **The cabin line** is the ruled surface of the fuselage and canopy lofts,
  whichever is wider at each point (`trainerCabinHalfWidth`). The half-width at
  any height comes from bisecting on the section's phase.

  The canopy's sections moved to `trainerShell.ts` as `TRAINER_CANOPY_SECTIONS`
  so the cockpit can read them. The move is bit-identical across all 331 meshes.

- **The door cap strip** stops at x 1.9, aft of the dial row.

**The deck line did not move.** The HUD is placed from the catalogue's
`cockpitDeckLineDegrees`, 8.31. That value is the old hood's front edge, whose
top face was in view. The old aft edge read 8.35. The new deck is built on the
catalogue value, so the HUD, the dial rects and the deck-line pins are untouched.

**The dial row moved 4 cm inboard.** Airspeed, attitude and altimeter now sit at
z -0.32 / -0.22 / -0.12. This was Jason's call, made in the PM's place.

The airspeed rim, at |z| 0.40, stood 4.3 mm OUTSIDE the cabin line. The old
0.84 m board carried it only because the camera hid the skin it poked through.
A board that follows the walls cannot. The instruments tests now find the dial
plane from the board's own face normals (`builtPanelFace`), not from the panel's
world matrix.

**Measured, 303372e -> S1:**

| | 303372e | S1 |
|---|---|---|
| deck hard edges | 4 (2,542 px) | 0 in the open; 6 (45 px) at the left end |
| board hard edges | 1 (138 px) | 0 in the open; 4 (216 px) at the left end |
| the cove's two lines (designed, excluded by name) | none | round to cove 1,105 px (a facet line, shared normals); cove to board 1,103 px |
| bare board px | 323,995 | 302,726 |
| airspeed dial hidden by the door | 9.0% | 0.0% |
| cockpit draws | 15 | 15 |

**Not met yet: the "5 -> 0" accept.** No hard edge is left in the open. But
where the deck and the board end at the port wall, their rounded ends still meet
the door panel along short creases: 10 edges, 261 px. Most of it is the board's,
216 px down its 45-degree flare. The pin ratchets these at 6 edges per mesh. The
cove's two full-width lines are the design (a 45-degree cove of 1 cm), as on the
Global and the F-16.

Jason chose where they go (in the PM's place): in S3, the deck's ends sweep aft
and down into the rounded door frame, as the F-16's rail does, so there is no
free end at all. The board's end meets the same frame.

**Pins** (`tests/render.cockpit-trainer.test.ts`, "the Cessna's deck and board"):
- **No chord bands.** Along the round's chord edges, shading jumps by less than
  0.5 degrees. Control: the flat faces jump by more than 5.
- **No hard edge in the open** on the deck or the board, outside the designed
  cove and the end junctions. Control: the attitude pitch bar shows more than 3.
- **Every vertex inside the cabin.** 2 cm, less 6 mm for facet sag, against the
  canopy as built above the tube top; at least 0 against the tube below it.
- **The ends turn into the walls on a round.** Along the left end, the yaw of
  the aft-face normals starts under 1 degree, ends past 75, and moves under 25
  per step.
- **Every dial is on the board.** A ray cast sideways through the board from
  each gauge vertex, 2 cm forward, hits it.
- **The airspeed dial is clear.** Its pixel count is the same with the door as
  without it. Control: moving the port door by (0.15, -0.05, 0.05) hides more
  than 500 px.

**Mutations.** Each of these fails at least one pin:
- square ends (r 0.5 mm);
- a flat nose (no round);
- zero clearance;
- the old dial row;
- deck line 8.6.

**Mesh-by-mesh.** On the trainer, 12 of 66 meshes moved:
- the deck (24 -> 756 vertices);
- the board (24 -> 852);
- both doors;
- the eight dial meshes, by world matrix only.

Every other airframe is bit-identical. The trainer's loft-crown digests are
re-pinned on its own line: seam 1f9a6faa -> 27cfab12, taper c44794a2 -> 9d958c4a.
