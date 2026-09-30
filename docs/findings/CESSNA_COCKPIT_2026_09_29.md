# The Cessna's cockpit: from boxes to a cabin

**Status: steps 1 (the deck and the board) and 3 (the A-pillars and the door
frames) built. Steps 2, 4, 5 and 6 follow in that order, one commit each.**

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
them: the panel's half-width of 0.42 stood 2.8 cm OUTSIDE the glass at its top
(the cabin's half-width at x 2.08 is 0.3915). Their four long edges read as five hard edges, 2,680 px of them. The
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
z -0.32 / -0.22 / -0.12. Jason made the call in the PM's place, and the PM,
answering later, ruled the same (3.3 degrees off the eye's line is invisible; a
floating rim is not).

The cabin's inner line at the panel station, at the dials' height, is 0.3957 out.
The airspeed rim, at |z| 0.40, stood 4.3 mm OUTSIDE it; at -0.32 it is 3.6 cm
inside. The old
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

## S3: the A-pillars and the door frames

**What was there.**
- **The posts:** two 8-sided struts, r 12 mm, standing vertical at azimuth -35 from just below the sill to y 0.27,
  ending in mid-air above the frame. The port one was a 165 px bar down the left edge, 172,800 px.
- **Each door:** three boxes (a panel to a knee at -0.2, a slab leaning in from there to the sill, and a 40 x 20 mm cap
  along it), with a seam where the slabs met and a square fore end. The door had 5 hard edges at 303372e and 9 after
  S1.
- **A gap in the cabin's side:** between the door's fore end and the board's end, the white cowl and the sky showed
  through.

**Where the pillar can go: measured, not chosen.** The glass stands only 0.14 m outboard of the eye, and the roof
slab's outboard front corner is 6 cm ahead of it. A pillar up the windscreen's forward edge from the deck's end into
the roof therefore crosses the view. I rasterised candidate routes through the cockpit camera (1080p, near-plane
clipped), each a tube r 20 -> 14 mm, 2 cm inside the cabin line:

| route | px | where it stands |
|---|---|---|
| the old post (control) | 172,800 | az -35, full height |
| foot at the deck's end (x 2.0) | 110,000 to 132,000 | az -11 to -18, across the left windscreen |
| foot at x 1.7 to 1.9 | 140,000 to 295,000 | az -13 to -35 |
| in the vertical plane through the eye at az -40 | 90,800 | at the frame's edge |
| **in that plane at az -41** | **58,000 alone, 49,192 in the census** | **the frame's left edge** |
| at az -42 | 25,000 | nearly all out of the frame |

The PM's budget (90,000) leaves only the edge. The lens is horizontal-fixed, so the frame's edge is at -37.5 at every
aspect.

**What is there now.**

- **Each A-pillar** is one `sweptTube` (new in cockpitPrimitives, append-only): r 20 mm at its foot to 14 at its end,
  rings carried by rotation-minimising frames, shaded smooth, including the taper. It runs in three parts:
  - it rises from inside the rail along the glass, in the plane at az -41, so it stands as one column at the frame's
    edge: a band 56 to 72 px wide from the frame's bottom up to row 220 of 1,080;
  - it then bends aft into a **cant rail** along the crown over the door, out of the frame (az -45 to -90);
  - it turns in and up into the roof slab's side behind the eye, ending inside the slab at its mid-thickness.

  The cant rail is needed because the crown is too low over the pilot to turn into the roof ahead of him: the slab's
  edge stands only 2.5 cm under the glass. Two first tries failed there:
  - turned straight into the roof, the pillar crossed the crown up to 3 cm **outside** the glass;
  - bent into the roof along its own plane, which runs through the eye, it passed 10 cm from the eye and covered
    165,000 px.

- **Each door frame** is three pieces on the same stations along x, merged into one mesh:
  - **the rail:** a round of r 15 mm along the sill (`sweptTube`). Its crest is 0.5 mm over the deck's top and the
    glass's 2 cm inside the glass at every point of its round.
  - **the face** under it, tucked up into the rail, down to the **notch**. The notch is where the glass's foot meets
    the tube's shoulder: the cabin line turns in there, so no one convex section can run past it.
  - **the panel** from the notch to the floor, 1 cm inside the tube's wall. Its inner face is the face's run on in one
    straight line, so neither the notch nor the old knee is a seam.

- **The deck's ends and the board's are buried** in the rails and the faces (Jason's "sweep into the door frame").
  They are square ends now, with the S1 fillets gone. The deck's round meets the rail's round at the rail's crest, as
  the F-16's rail runs into its sills.

**Four things the numbers decided.**
- **The face hangs from the rail's underside, not its inner side.** Hung from the inner side, the face stood 2 to
  9 mm into the airspeed dial's sight line and hid 3.2% of it. From the underside it starts 1.5 cm further out.
- **The rail's crest follows the deck line's sight plane forward of the deck's round.** Run on level, it rose over the
  deck line and showed its forward end (3 short edges). The deck line is a ROW of the picture: height over depth along
  the view (x), not over distance, which was my first criterion and left one edge showing. Forward of the round's
  touching point the crest falls halfway to the hood, which falls away faster.
- **The rail has a station at that kink.** Straight between stations 4 cm apart, the crest dipped 0.1 mm under the
  deck's round, whose end then showed (5 px).
- **The deck keeps a lead-in station 1 mm in from each buried end.** `sweptSolid` averages a round's end point over the
  triangles that meet there, and at a sweep's end station its two walls meet it 1:2 (2:1 at the other end). With the
  end stations alone, the cove line was shaded 15 degrees differently at its two ends.

**Measured, S1 -> S3** (1080p, the census, near-plane clipped):

| | S1 | S3 |
|---|---|---|
| port post / pillar px | 177,258 | 49,192 |
| mid-air ends | 2 | 0: the tops in the roof slab, the feet in the rails |
| door hard edges | 9 (5 at 303372e) | 0 |
| deck and board end-junction creases | 10 (261 px) | 0 |
| pillar hard edges | 0 (8-sided, facet silhouettes) | 0 |
| airspeed dial hidden | 0.0% | 0.0% |
| cabin side open under the rail | the cowl and the sky, beside the board | 0 px |
| bare board px | 302,726 | 283,906 |
| cockpit draws | 15 | 15 |
| trainer build (Node, cold / warm) | 186 / 73 ms | 229 / 78 ms |

**The build time was 8 s at first.** Every rail centre and pillar station bisected its outboard distance, and every
probe sampled the cabin line, itself a bisection on the loft's phase. The largest u at which a round of radius r keeps
its clearance is in closed form: the minimum over its points of (half-width - clearance - r cos a), because a point's
allowance does not depend on u. With that, the rail centres memoised and the pillar solved once and mirrored, the
trainer builds within 43 ms of S1.

**The pillar folded twice before the pins were right.**
- **A root finder returned a stale bracket end.** The regula falsi (Illinois) did not stop on the root: a step that
  landed on it with a rounding-positive value left the other end where it was, and the halvings walked it back into
  the bracket. Two stations came back 2 cm out of line, and the tube folded at 46 to 173 degrees. It now stops at
  |f| < 1e-12.
- **Stations bunched at the top.** The last two stood 0.7 mm apart where the tube turns into its bend, and the turn
  tilted one ring 2 mm behind the other: another fold.

The split-shading hard-edge test cannot see either. The tube's vertices are shared, so a fold is shaded smooth. The
pin is geometric: every two faces sharing an edge meet at under 30 degrees (the 16 chords meet at 22.5).

**Pins** (`tests/render.cockpit-trainer.test.ts`), each with its control:
- **the port pillar's rings:** in the plane at az -41, 20 -> 14 mm, no fold, the cant rail wholly beyond the frame's
  edge, the starboard pillar out of the view;
- **the pillar's area:** at most 90,000 px, in at least 75% of the rows, at most 150 px into the view;
- **clearance and ends:** every vertex of both pillars in the closed roof slab, in the rail, or 2 cm (less the
  canopy's 6 mm facet sag) inside the glass; the top cap and last ring in the slab; the foot's centre in the rail;
- **the door frames:** inside the cabin (added to S1's clearance pin), with the outer face at most 3 cm off the tube's
  wall;
- **hard edges:** none on the deck, the board, the port door or the port pillar, outside the deck's designed cove;
- **the buried ends:** no edge of the deck's or the board's ends shows. Control: without the door frames, both do;
- **the cabin's side:** every pixel under the port rail is drawn. Control: the door 4 cm outboard opens more than 500 px;
- **the airspeed dial:** still unobstructed.

The drawn-faces test also caught one real defect: the board's end-cap fan started from a point on its own rear face,
laying slivers in that face's plane. It now starts from the front foot.

**Mutations.** Seven are caught, each by the pin meant for it:

| mutation | caught by |
|---|---|
| the plane at -38 | the area pin |
| the end under the roof | the ends pin |
| no kink station | the hard-edge and buried-ends pins |
| the face from the rail's inner side | the dial, cabin-side and hard-edge pins |
| bunched stations | the fold pin |
| the board's fan from its rear foot | drawn faces, both offsets |
| the deck's upper end 5 mm out | the buried-ends and hard-edge pins |

An eighth, the bend not held to the glass's inset, is not caught, and cannot be at this handle length. Unheld, the
bend stands 0.07 mm past the 2 cm line, far under the pin's 6 mm facet allowance. The hold stays as a construction
guarantee, and it is not counted.

**Mesh-by-mesh against S1** (dfa5598). On the trainer:
- the doors moved (72 -> 2,110 vertices each);
- the deck moved (756 -> 252) and the board (852 -> 276), their fillets gone;
- the two posts are gone and the two pillars new;
- the other 60 of 66 meshes are bit-identical.

Every mesh of the jet, the Global and the 747 is bit-identical. The trainer's loft-crown digests are re-pinned on
its line: seam 27cfab12 -> 69e4f7c8, taper 9d958c4a -> 5e234af0.

