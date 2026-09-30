# The Cessna's cockpit: from boxes to a cabin

**Status: steps 1 (the deck and the board), 3 (the A-pillars and the door frames),
2 (the panel's face) and 4 (the overhead) built. Steps 5 and 6 follow, one commit
each.**

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

## S2: the panel's face

**What was there.** Three flat discs, 8 mm thick with 90 degree rims, their faces
plain dark with no marks, on an empty board: 283,906 px of bare board after S3.

**What is there now.** The draw count is unchanged: the three gauge meshes became
three others.

- **`trainer-dial-faces`**, the display atlas's screens: the three dial faces and
  the two radios' windows.
  - **The faces** are static pages of a new atlas layout, `TRAINER_DISPLAYS`:
    square 256-texel slots, mipmapped, drawn once, since nothing on them moves.
  - **Airspeed:** the 150's handbook arcs (white 42-85, green 47-107, yellow
    107-141) and the red line at 141, a mark every 5 knots from 40, numerals
    every 20.
  - **Altimeter:** a mark every 20 feet, numerals 0 to 9.
  - **Attitude:** a bank scale (10, 20, 30, 45, 60, 90 each side) and the index,
    in the 5 mm ring round the ball.
  - **The marks sit at the needles' angles.** The pages call the same mapping
    functions the needles are turned by (`airspeedNeedleDegrees`,
    `altimeterNeedleDegrees`), so a needle points at the number it reads.
  - **Each part gets its slot's UVs before the merge.** U runs with the pilot's
    right; V runs against up, as the screens' do.
- **`trainer-dial-bezels`**, on the shared rim (`BEZEL_RIM`) and its glow law,
  driven from the trainer's `setLightState`. Each bezel is a ring 6 mm wide, 3 mm
  proud, with a 2 mm 45 degree chamfer outside and a 1 mm one inside, round a
  face recessed 2 mm.
  - **Each is one solid**, not the Global's frame plus rim. Two solids each close
    themselves at the chamfer's shoulder with a face 135 degrees to their front,
    and the pilot sees that edge.
  - **The chamfers are shaded as rounds.** Their ends take the faces' normals
    either side, so they read as eased edges. A flat-shaded 45 degree chamfer is a
    split edge exactly at the census's threshold.
- **`trainer-panel-fittings`**:
  - **the radio stack:** two units 160 x 40 mm with 3 mm rounded edges at the
    panel's centre, right of the dials. Each has a raised window (COM 122.80,
    NAV 110.50 on the atlas) and two knobs.
  - **four rocker switches** under the airspeed dial and the attitude indicator.
- **The needles and the ball, restaged into the well.**
  - **The needles** are 1.2 mm thick (the hub 1.6), 0.3 mm off the face.
  - **The ball** is 0.029 in radius (it was 0.036), 0.6 mm thick, and its bar
    stands 2.7 mm proud, under the bezel's front at 3.
- **One new primitive, `loopSolid`** (cockpitPrimitives, append-only). It carries
  a profile round a circle or a rounded rectangle, shaded smooth round the loop
  and flat across the profile, except for rounds. A band between two points at
  u = -radius is the inside of a capped rectangle and is left out: made, its
  corners met the visible cap in 90 degree edges.

**Measured** (1080p, the census, near-plane clipped):

| | S3 | S2 |
|---|---|---|
| dial rim hard edges | 3 (the discs' rims) | 0 |
| hard edges on the faces, the bezels, the fittings | none of them existed | 0 |
| airspeed marks: count, nearest on the screen, thinnest | none | 25, 9.8 px apart, 1.83 px |
| attitude marks | none | 12, 10.5 px apart, 1.71 px |
| altimeter marks | none | 50, 7.5 px apart, 1.71 px |
| visible face | the 80 mm disc | 123 px across |
| bare board px | 283,906 | 238,996 |
| cockpit draws | 15 | 15 |
| trainer build (Node, cold / warm) | 229 / 78 ms | 213 / 101 ms |

**Not met: the bare board, 238,996 against the PM's 200,000.** The two 160 x 40 mm
units cover about 40,000 px and the four rockers about 2,000; the right third of
the board is still bare. A 150 carries a tachometer and a small engine cluster
(oil temperature and pressure, fuel) right of the radios. On the atlas those
would cost no draw and bring the board to about 190,000. They are asked of the
PM, not built. The pin ratchets the board at 240,000.

**The census's depth tolerance.** It is 1.5 mm plus 0.4% of the distance, 4.3 mm
at the dials, and it read BURIED edges within it as seen. The backs 1 mm into the
board showed 428 false hard edges on the bezels. Everything's back is now 6 mm in,
the paddles' 12: a paddle's back, rocked 12 degrees, stood only 4.5 mm under its
base's face. The pins use the same test, so the same margin applies to them.

**Pins** (`tests/render.cockpit-trainer.test.ts`, "the Cessna's panel face"):
- the bezel's geometry, and its material and glow law;
- the faces as the atlas's screens, each slot mapped the right way round, and
  flat where there is no canvas;
- the marks: at least 12 per dial inside the visible face, 3 px apart and 1.2 px
  wide on the screen;
- the numerals and the arcs;
- the needle against its numeral on the screen: 100 knots at the 100, 500 feet at
  the 5, within 2 degrees;
- the radios' text inside their windows' band;
- the radio stack's size and place, and the switches' row;
- the bare board;
- no hard edge on the three new meshes.

The instruments pins moved with the restaging: the needle's origin on the built
face's centre, its 0.9 mm stand-off, and the ball in its well. The HUD's kit dial
rectangles (`tests/support/cockpitDisplayRects.ts`) now describe the face as built
and the bezel round it; the 2D HUD layout did not move.

**Mutations.** Six are caught, each by its pin:

| mutation | caught by |
|---|---|
| the airspeed page's scale 150 against the needle's 160 | the marks, numerals and needle pins |
| the face flush with the bezel's front | the bezel, ball and hard-edge pins |
| a square inner bezel edge | the hard-edge pin |
| the atlas's v running with up | the UV pin |
| hairline minor marks | the marks pin |
| the capped rectangle's inner wall made | the hard-edge pin |

**Still owed: a GPU check.** Gate A must compile the trainer's new display
material on the adapter against the 15-of-16 budget, which no Node test can see.
A live frame is also owed, to see the pages the way the texture draws them.

**Mesh-by-mesh against S3** (fc9579e). On the trainer:
- the three gauge meshes are gone, and the faces, bezels and fittings are new;
- the two needles and the ball's three parts moved;
- the other 58 of 66 meshes are bit-identical.

Every mesh of the jet, the Global and the 747 is bit-identical. The trainer's
loft-crown digests are re-pinned on its line: seam 32cb1a38, taper 592b2530.

## S4: the overhead

**What was there.** The roof slab's bare underside and edges were seen from the
seat, 3 hard edges and 132,209 px, and open sky elsewhere overhead. There was no
compass and no visors.

**The header's depth, measured before building.** The roof slab's underside edge is
at x 1.62, y 0.18: 6 cm above the eye and 24 cm ahead of it. Straight ahead, the
windscreen's top was at +14.0.
- **As specified,** a full 25 mm-radius bar hung under that edge puts its bottom
  at y 0.155, and the windscreen's top comes down to about +8. That leaves a
  16-degree slit between the deck (-8.3) and the header; a 150's header sits
  nearer +15 to +20.
- **What was built** (put to the PM before building) keeps the round but lets it
  stand only 12 mm under the ceiling.

**What is there now.** One more draw (16 cockpit meshes), on a new material, the
cabin's fabric.

- **`trainer-headliner`**: the headliner, one smooth solid under the slab and the
  glass crown outboard of it.
  - **Its shape:** a rounded rectangle in plan, 0.61 m across and 2.5 cm inside
    the glass at the ceiling's height, from x 1.2 to the slab's front edge. Its
    ceiling is 2 mm under the slab, so it covers the slab from inside.
  - **The header is its rim:** a round of 25 mm radius standing 12 mm under the
    ceiling, run into it by a concave 10 mm fillet (a new option of `loopSolid`),
    so the ceiling, the fillet and the round meet on one normal each.
  - **The visors, merged into it:** two, 300 x 120 x 8 mm, with round edges and
    10 mm corners, stowed flat behind the header. Their outer ends run under the
    side rim.
- **The compass**, merged into the dark fittings: a 60 x 60 x 70 mm box with 8 mm
  round edges and a dark face toward the pilot. It hangs on a 4 mm stalk that runs
  up into the windscreen centre frame's crown member, as a 150's hangs from its
  windscreen's centre strip.

**Measured**, at 1080p:

| | S2 | S4 |
|---|---|---|
| roof slab seen from the seat | 132,209 px, 3 hard edges | 0 px (the headliner hides it) |
| hard edges on the headliner | none of it existed | 0 |
| windscreen's top, straight ahead | +14.0 | +13.25 |
| visors' front edge, straight ahead | none | +14.83 |
| compass | none | its centre at el +2.85, az +24.3 |
| cockpit draws | 15 | 16 |
| trainer build (Node, cold / warm) | 213 / 101 ms | 217 / 108 ms |

**Two departures from the specification, both measured.**
- **The compass sits at +2.85, not the survey's +3.9.** That placement put the
  compass's centre at y 0.16, which leaves no room: the crown member it hangs from
  has its underside at y 0.185 at that station, and the box is 60 mm high.
- **The upper-left corner stays open sky.** It is the windscreen's upper-left,
  between the headliner's port side (|z| 0.305) and the glass (0.38). The
  headliner cannot run further out there: where its rim rises toward the crown, the
  glass is only 0.33 out.

**Pins** (`tests/render.cockpit-trainer.test.ts`, "the Cessna's overhead"):
- **the roof slab:** no pixel of it from the seat. Control: without the headliner,
  more than 50,000 px of it.
- **the windscreen's top:** straight ahead, between +12.8 and +13.6.
- **the visors:** their size, and their front at +13.5 to +15.5 straight ahead,
  the eye meeting a visor's underside just over it.
- **the compass:** its size, its place in the frame, and its stalk's top, off the
  built mesh, inside the built centre frame.
- **the headliner:** added to the hard-edge pin, and to the 2-cm glass clearance
  (its top inside the slab is exempt).
- **every new part's shading:** no vertex normal of the pass's new meshes points
  into its own solid.

The drawn-faces test's kit size is re-pinned on the trainer's line (15 -> 16).

**Mutations.** Six are caught:

| mutation | caught by |
|---|---|
| the headliner 20 cm narrower each side | the roof, windscreen-top and visor pins |
| a full bar hung 3.7 cm under the edge | the windscreen-top and visor pins |
| the fillet shaded as a convex round | the new shading pin only |
| the headliner's top 2 cm up, 13 mm from the glass outboard of the slab | the clearance pin |
| the visors run on under the header | the visor pin |
| the stalk stopping under the frame | the compass pin |

The fillet mutation was MISSED at first. Its dark band is geometry-smooth, so no
hard-edge test could see it; the shading pin was written for it.

**Mesh-by-mesh against S2** (d2b64ff). On the trainer:
- `trainer-headliner` is new;
- `trainer-panel-fittings` moved (the compass and its stalk joined it);
- the other 65 of 67 meshes are bit-identical.

Every mesh of the jet, the Global and the 747 is bit-identical. The trainer's
loft-crown digests are re-pinned on its line: seam a8ea15d2, taper 6b090dea.

