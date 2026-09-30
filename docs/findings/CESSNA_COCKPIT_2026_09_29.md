# The Cessna's cockpit: from boxes to a cabin

**Status: all six steps built: 1 (the deck and the board), 3 (the A-pillars and the
door frames), 2 (the panel's face), 4 (the overhead), 5 (the centre frame and the
cowl's nose) and 6 (the yokes). Then S2b: the tachometer and the engine cluster
that meet S2's bare-board line. The final GPU frames follow.**

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

## S5: the centre frame and the cowl's nose

**What was there.**
- **The centre frame** was three primitives merged under one name: a round 48 mm
  bar up the windscreen, a ball at the corner, and a bar aft along the glass crown
  into the roof slab. The ball closed the gap where the two bars bend 42 degrees.
  The pilot saw it as a knuckle: 62,278 px, 6 hard edges (108 px) and a facet
  silhouette along the crown bar.
- **The cowl's nose** was the shell's last ring, closed on a flat cap. The pilot
  saw its rim as a line across the cowl's top at about -3 degrees: six edges,
  175 px.

**A correction to the plan's wording.** The plan's "the cowl's aft cap" came from
my P0 survey, which named the wrong end. The rim the pilot sees is the NOSE, at
x 3.70. The aft cap, at x 2.42, is at -9 degrees, under the deck line, and hidden.

**What is there now.** No new draw and no new material: 16 cockpit meshes, as at S4.

- **`windscreen-center-frame`: one tapered strip.**
  - **Its path** (`TRAINER_CENTRE_FRAME` and `trainerCentreFramePath`, in
    `trainerShell.ts`) keeps the old axis and both ends. The foot is buried 10 cm
    past the design foot, under the cowl deck; the end is 2 cm inside the closed
    roof slab, at its mid-thickness.
  - **The corner** is a 6 cm fillet, where the ball was.
  - **The section** is an ellipse, 34 x 22 mm at the foot, tapering to 24 x 16 at
    the roof. The wider axis is across the glass, as a windscreen's centre strip
    is.
  - **The shading** is smooth, round the ellipse and along the strip.
  - **How it is built:** by `sweptTube`, which gained an elliptical section (the
    `halfDepths` option), 24 segments round and 17 rings.
- **The cowl stand-in's lip.** Four rings run on past the shell's nose, each the
  nose section shrunk by the fall of a 15 mm quarter-round (`TRAINER_COWL_LIP`).
  - The first band leaves the shell tangent to it.
  - The flat cap now faces straight ahead, away from the eye, and is culled.
  - The lip's front is at x 3.715, short of the spinner's back face at 3.74.
  - The shell is untouched. The stand-in is drawn only in cockpit view.
  - Its u coordinate is measured over the shell's own sections, as before, so
    its paint does not move.
- **The compass is re-hung.** S4 hung it from the crown bar's underside, which was
  8 mm inside the glass there. The strip is 18 mm through at the compass and
  stands 7 mm OUTSIDE the glass, so a box hung from its underside would be 3 mm
  through the glass. The box is now hung by the glass instead: its top is 5 mm
  under the glass's crown line over its front face. Its stalk runs up through
  the glass to the strip's axis.

**Measured**, at 1080p (the census, near-plane clipped):

| | S4 | S5 |
|---|---|---|
| centre frame | 62,278 px; 6 hard edges (108 px); 1 facet silhouette | 29,340 px; 0; 0 |
| cowl's nose rim | 6 creases seen (175 px) | 0 |
| compass centre | el +2.85, az +24.3 | el +3.24 (screen row +3.56), az +24.3 |
| cockpit draws | 16 | 16 |
| trainer build (Node, cold / warm) | 217 / 108 ms | 237 / 114 ms |

The survey placed the compass at +3.9 as a screen row, which is atan(dy/dx). The
pins' elevation is atan2(dy, the horizontal range): the compass is 24 degrees
right of the eye's line, so the two differ.

**The census had a bug, found by a mutation.** Its split-shading test paired each
face's vertex by winding order. A face's winding runs the edge it shares the other
way from its neighbour's, so the test compared the normal at one end of the edge
with the normal at the other. Its "hard" therefore meant any seen crease of 45
degrees or more whose shading varied along the edge, split or smooth. Now fixed.
Re-run on S4:
- only two meshes' labels change, the cowl's and the glareshield's;
- the cowl's six rim creases are SMOOTH-shaded, because the loft's cap shares its
  rim's vertices: one averaged normal, and a 92-degree crease all the same;
- no zero reported for S1 to S4 moves: every mesh those steps held at no hard
  edge still has none. The pins never had the bug; they pair by position.

**Pins** (`tests/render.cockpit-trainer.test.ts`):
- **"the Cessna's windscreen centre frame"**, rewritten:
  - One mesh, not merged, exterior, on `trainer-dark`.
  - **Its shape:** every vertex on the design ellipse about the design centreline,
    within 2%. That is the axis, the fillet and the taper, and a ball, a round
    bar, a sharp corner or an untapered strip all fail it. At least five rings run
    round the fillet, and the foot is 34 x 22 mm.
  - **No facet line and no knuckle:** neighbouring faces meet at under 30 degrees
    round the strip and under 10 along it.
  - **Its size on screen:** between 15,000 and 45,000 px of the frame.
  - **Kept from before:**
    - the bottom ring under the cowl deck;
    - everything aft of the roof's front edge inside the closed slab;
    - its faces drawn from the seat;
    - no end disc the nearest drawn surface, from the seat or from any exterior
      angle, with the member-only positive control.
- **The hard-edge pin** now covers the strip and the cowl. It also samples each
  edge within a pixel of the line: a silhouette crease has its mesh on one side
  only, so the pixel under the line is as often what lies beyond it.
- **A crease pin for S5's two parts, of ANY shading.** It is needed because the
  pin above asks for split shading, and the lipless rim is smooth. Its control is
  the stand-in with its lip cut off and a flat, smooth-shaded fan in its place:
  the pin sees more than three creases on it, none of them split-shaded.
- **The cowl stands on the shell:** as before, up to x 3.7. Past it, the lip: its
  front 15 mm on, and its top 15 mm down.
- **The compass:** its elevation is above +3.1, and its top is at least 4 mm under
  the glass.

**Mutations.** Six are caught, each on substance (the non-vacuity counts no longer
depend on the segment count):

| mutation | caught by |
|---|---|
| an octagonal strip (8 segments) | facet pin (65 degrees between faces), crease pin |
| a sharp corner (a 5 mm fillet) | ellipse pin (45% off), facet pin, crease pin |
| no taper | ellipse pin (42% off) |
| the old round 48 mm member, filleted | ellipse pin, 64,775 px, end-disc pin |
| no lip on the cowl's nose | the crease pin, the lip pin |
| the compass hung from the strip's underside | the compass pin (its top 5 mm through the glass) |

The lipless nose was first caught by the lip's vertex count alone. The hard-edge
pin missed it twice, for the two reasons above: the rim is smooth-shaded, and it
is a silhouette.

**Mesh-by-mesh against S4** (bb261f1). On the trainer, three meshes moved:
- `windscreen-center-frame`: 779 -> 458 vertices;
- `trainer-cowl-standin`: 52 -> 152, the lip;
- `trainer-panel-fittings`: positions only, the compass.

The trainer's other 64 of 67 meshes, and every mesh of the jet, the Global and the
747, are bit-identical. The trainer's loft-crown digests are re-pinned on its
line: seam 0ab2abdb, taper c2acc0f3.

## S6: the yokes

**What was there.** No yokes. The cockpit camera is fixed and level, so the frame's
bottom is -23.35 degrees. On type, the pilot's yoke hub is under the eye, 0.32 m aft
of the board and 0.25 m below the eye (y -0.13), and its horns rise 0.08 over it. The
horn tops would then stand at -24.7 degrees, 35 px under the bottom of the 16:9
frame, and the pilot would see no yoke at all.

**What is there now:** one mesh, `trainer-yokes`, on the fittings' dark (no new
material). Each seat has:
- **a ram's-horn wheel**, one tube from horn tip to horn tip: each horn a 30 mm
  grip standing straight up and domed at its top, bending at its foot into a 22 mm
  arm that rises 15 degrees inboard to the hub, the two arms meeting over a fillet
  inside the boss;
- **a boss** round the hub, its aft edge rounded;
- **a column**, and **a collar** where the column enters the board.

**The 4 cm.** Both yokes are RAISED 4 cm from type (`TRAINER_YOKE.raise`), as the PM
asked, so the pilot's horn tops show. They are now 100 px above the frame's bottom
at 16:9; the bar was 15.

**Two departures from type, both forced by the cabin, both measured.**
- **The wheel is narrower.** The door's inner face stands 12.5 cm outboard of the
  eye at the horn tops' height (|z| 0.385 at y -0.01). The survey's horns, 0.15
  either side of a hub under the eye, would be about 3 cm into the door. The hub
  stays under the eye, and the horns are 0.105 either side of it, their outer faces
  1.6 cm off the door. The grips are 21 cm apart, against about 30 on type. The
  other way to fit was a type-width wheel with its hub 3 cm inboard of the eye,
  which puts the yoke off-centre in the frame. That choice is put to the PM.
- **The column falls about 14 degrees forward** from the hub, and enters the board
  under the switch row (at y -0.17). There is no level route:
  - at the raised hub's height, a column would pass between the airspeed's and the
    attitude's bezels, a gap narrower than its 40 mm collar;
  - at the height on type, it would pass through the switches.

  The column is 29 degrees and more under the eye's line. Only the top of its
  collar shows, at the frame's bottom centre, as a column's boot at the panel does;
  the copilot's collar clips the bottom-right corner.

**Measured**, at 1080p (the census, near-plane clipped):

| | S5 | S6 |
|---|---|---|
| pilot's horn tops above the frame's bottom | none built (on type: 35 px under it) | 100 px (the outboard at col 609, the inboard at 1311) |
| yokes | none | 23,320 px; 0 hard edges; 0 facet silhouettes |
| bare board | 238,996 px | 225,202 px (the yokes' collar and horn cover part of it) |
| horns off the door | none | 1.64 cm at least |
| columns' ends behind the board's face | none | 17.3 mm at least |
| cockpit draws | 16 | 17 |
| trainer build (Node, cold / warm) | 237 / 114 ms | 224 / 114 ms |

**Pins** (`tests/render.cockpit-trainer.test.ts`, "the Cessna's yokes"):
- **Built as designed:** one mesh of both seats' wheels, bosses, columns and collars,
  on `trainer-dark`. Each hub is midway between its horns, under its seat's eye.
  The horn tops are at the height on type plus the 4 cm, 0.32 m aft of the board's
  face (read off the built board).
- **The PM's accept line:** the pilot's two horn tops SEEN at least 15 px above the
  frame's bottom at 16:9, off the raster. Control: the same tops 4 cm lower, on
  type, project under the frame.
- **The door:** every vertex of the outboard horn at least 1.5 cm inside the door's
  inner face.
- **The column:** every yoke vertex within 3 cm of the board at least 5 mm under the
  switch row (the collars' rounded aft rims are the highest, 9.9 mm under). Each
  column's end ring, vertex by vertex, is 6 mm or more behind the board's face.
- **Added to the existing lists:** the hard-edge pin, the any-shading crease pin
  and the shading pin now cover the yokes.

The buried-ends pin's control now leaves the yokes out as well as the doors: the
outboard horn stands in front of the board's port end and hid one of the edges
that control counts. The drawn-faces test's kit size is re-pinned on the trainer's
line (16 -> 17).

**Mutations.** Six are caught:

| mutation | caught by |
|---|---|
| no raise (the yokes on type) | the accept-line pin (0 px above the bottom), the hub pin |
| the survey's width (horns 0.15 either side) | the door pin (2.9 cm into the door) |
| a level column at the raised hub's height | the column pin (7 cm above where it may be) |
| flat-topped horns (no dome) | the hard-edge and crease pins (40 edges), the hub and door pins |
| the hub 3 cm inboard of the eye | the hub pin |
| the column stopping at the board's face | the burial pin (-2.7 mm), the hard-edge and crease pins |

The burial pin first measured at the column's centre. It caught an unburied column
by 0.01 mm: the column's end is square to the column, which falls 14 degrees, and
the board leans its top forward. It now measures every vertex of the end ring.
- **The bury went from 12 to 20 mm**, on my estimate that the collar's top edge was
  only about 4.5 mm in.
- **Measured, it was 9.3 mm in**, already past the 6 mm the depth tolerance asks. So
  the deeper bury is margin, not a fix; it is now 17.3 mm at least.

**Mesh-by-mesh against S5** (a06be92). On the trainer, `trainer-yokes` is new; the
other 67 of 68 meshes, and every mesh of the jet, the Global and the 747, are
bit-identical. The trainer's loft-crown digests are re-pinned on its line: seam
d29a2b1f, taper cba133b7.

**Across the six steps:**
- cockpit draws 15 -> 17, within the PM's +8;
- no new material since S4's headliner fabric, which carries no texture;
- Gate A (the inter-stage audit) is still owed on the GPU for the trainer's
  display material (S2), the one new material with a texture;
- the deck line held throughout.

## S2b: the tachometer and the engine cluster

**Why.** S2 left 238,996 px of bare board against the PM's 200,000. The PM's answer
to the question I left then: add the type's engine gauges.
- Their brief: detail on the board, not new flight instruments. Both are smaller
  than the three main dials, and lower or outboard, so the main row still reads as
  the row.
- Jason's "three dials" (2026-09-23) still holds for the MAIN dials: the pin holds
  exactly airspeed, attitude and altimeter.

**What is there now.**
- **The tachometer**, right of the radio stack and 12 mm under the row's line.
  - Its face is 27 mm in radius, against the dials' 34, in the dials' bezel section
    on the same rim.
  - Its page has the 150's green arc (2,000 to 2,750 RPM) and a red line at 2,750,
    which is the catalogue's maximum. It is marked every 100 RPM and numbered in
    hundreds, 0 to 35.
  - Its needle is the dials' scaled with its face, turned by `engineRpm`: -135
    degrees at 0 to +135 at 3,500 (`tachometerNeedleDegrees`). One more draw
    (cockpit meshes 17 -> 18).
- **The engine cluster**, under the radio stack, its right edge on theirs.
  - One face of 125 x 30 mm, in a rectangular ring of the same section.
  - It is a static page of four small gauges, fuel L and R and oil T and P, with
    their needles drawn on it. It needs no draw.
  - **Why its right edge is on the stack's:** the pilot's inboard horn stands in
    front of the board to the left, over z -0.037 in the cluster's rows. As built,
    its ring is 1.6 cm clear of the horn. Centred under the stack, the ring's end
    would pass 2 mm behind it; a cluster the stack's full width would lose 2 cm.
- **Both faces are atlas screens,** so the atlas grows from 5 slots to 7 (three rows
  of 256 px).
- **The needle builder is one helper now,** shared by the dials and the
  tachometer. The airspeed and altimeter needles are bit-identical.

**Measured**, at 1080p (the census, near-plane clipped):

| | S6 | S2b |
|---|---|---|
| bare board | 225,202 px | 193,764 px (the line is 200,000) |
| dial faces mesh (faces, windows, tachometer, cluster) | 33,885 px | 54,010 px |
| bezels | 14,131 px | 24,996 px |
| hard edges on faces, bezels | 0, 0 | 0, 0 |
| cockpit draws | 17 | 18 |

**Pins:**
- **In `tests/render.cockpit-trainer.test.ts`:**
  - **Size and section:** both rings on the dials' section, the tachometer
    27 mm to their 34 and the cluster 125 x 30 mm. Their faces sit under the rings.
  - **Placement:**
    - the tachometer right of the stack and under the row's centre;
    - the cluster under the stack;
    - both in the frame, and 99% or more of each face SEEN (the tachometer's
      needle counts as seen).
  - **Atlas:** both faces map onto their own slots, the cluster onto its band.
  - **Pages:** the tachometer's numerals and arcs, its red line at the catalogue's
    maximum; the cluster's four gauges and labels inside the face the pilot sees.
  - **Marks:** the tachometer's 36 resolvable at 1080p.
  - **Needle to numeral:** 2,500 RPM at the 25.
  - **The bare board** at 200,000 px or less.
- **In `tests/render.cockpit-instruments.test.ts`:** the tachometer's needle joins
  the other needles' pins. Its origin is on its face's centre; it rests at 12
  o'clock; it turns clockwise on the screen and sweeps without reversing; it sits
  at the literal angle. It also agrees with the HUD's RPM readout to within the
  HUD's rounding (10 RPM).

**Mutations.** Six are caught:

| mutation | caught by |
|---|---|
| the tachometer's needle never turned | five needle pins (HUD agreement: 1,750 against 700) |
| the tachometer as big as the dials | the size pin |
| a cluster the stack's full width | the full-view pin (96.5% of its face seen) |
| the tachometer on the row's line | the placement pin |
| the cluster's gauges drawn below its face | the page pin |
| the cluster's face mapped onto the whole slot | the UV pin |

**Two misses on the way, both corrected.**
- **The comment overclaimed.** My first cluster-placement mutation (centred under
  the stack) was missed, and it was right to be: that is not a defect. It exposed
  a comment that claimed the horn forced the right-aligned placement. The horn's
  edge was then measured, and the numbers above replaced that claim.
- **The pins' windows were too narrow.** The full-view pin's sample grid, and the
  ring and UV pins' windows, were fixed at a 125 mm cluster. A wider cluster
  therefore fell outside them and was caught by the wrong pins. All three now
  derive from the cluster's size.

**Mesh-by-mesh against S6** (c154cbb). On the trainer:
- `trainer-tach-needle` is new;
- `trainer-dial-faces` and `trainer-dial-bezels` moved (the new faces and rings
  joined them);
- the other 66 of 69 meshes are bit-identical, both dial needles included.

Every mesh of the jet, the Global and the 747 is bit-identical. The trainer's
loft-crown digests are re-pinned on its line: seam 12714b2c, taper 3af28e04.

An unused import that S5 left in `trainerVisual.ts` is gone (eslint).

## S4 addendum: the header's outline is fair

**The PM's caution** (after S4, from the 747): a bar laid on an uneven surface
inherits its lumps, so pin the header rim's lower outline within 1 px of a fitted
smooth curve at 1080p.

**The pin.** In each column that starts in the headliner and meets open glass under
it, the header's lowest row is its outline. Each point must be within 1 px of a
least-squares quadratic through the points within 40 columns of it. Control: the
same outline with a lump 3 px deep and 12 columns wide fails.

**What it found first was not the header.**
- The first run read 2.46 px, at a sharp kink at column 812.
- I took that for the corner's 15-degree chords, since the port corner is only
  0.14 to 0.24 m ahead of the eye. At 24 chords the kink stayed (1.88 px).
- It is the port visor. The visors are merged into the headliner's mesh. At the
  port corner the visor's straight front edge (x 1.565) is lower on the screen than
  the header curving aft over it, so for columns 516 to 812 the "outline" was the
  visor's edge, meeting the header's curve in a kink.
- The pin now keeps only points forward of the visors (x = eye + raster depth, at
  x 1.575 or more).
- **Measured at S4's own 6 chords: 0.76 px** worst, over 818 columns (915 to 1919).
  At 24 chords it was 0.55. So the corner stays at 6 and no mesh moves.
- **For the frames:** the port visor's front edge is seen below the header at the
  port corner, a straight edge meeting the header's curve. It is a stowed visor
  seen as it is, not a lump.

**Mutations.** The corners at 6, 8 and 12 chords all pass: the header is fair at
S4's resolution. What the pin does catch is the visor-and-header junction (2.46 px),
when the visors are not excluded, and the in-test lump.

**The visor pin was hardened** on the way. It measured the port visor off the merged
mesh inside a box that also held the corner's concave fillet once the corners were
finer: 8.1 mm read for 8. The box now stops at z -0.2, where the corner begins.

## S2 fix from the live frame: the radios' frequencies

**What the frame showed.** The first live frame (the GPU slot after S6 and S2b)
showed each radio's large active frequency running into its standby: "122.80" over
"121.50". The browser's bold monospace is about 0.6 em a character, so at the S2
sizes (0.62 and 0.42 of the band) the two texts overlapped by 32 px of the slot's
256. No Node test could see it: the pin checked the texts were in the band, not
that they were apart.

**The fix.** The label, the active frequency and the standby are re-sized to 0.26,
0.5 and 0.36 of the band and re-placed (`TRAINER_RADIO_TEXT`). They are sized for a
0.62 em advance, a little wider than the faces are.

**The pin** (`tests/render.cockpit-trainer.test.ts`) reads each text's extent across
the slot, from its own font and alignment in the recorded calls, at that advance.
The label stands at least 2 px clear of the active frequency, and the active at
least 8 px clear of the standby, on both radios, all inside the window. Control:
the S2 layout fails it, the active 32 px into the standby.

## Rebased onto Fix-Cockpits 7fc2280

The branch was rebased after the final frames, onto Fix-Cockpits 7fc2280: the 747's
cockpit refinements on top of the trainer's 512 paint (f052e2d) and the F-16's
wave.

**The conflicts.** Both sides were kept in each.
- **The display pages** (S2 and S2b): the 747's `clock` page beside the trainer's.
- **KIT_SIZE** (S4, S6, S2b): the 747's 9 and the F-16's 9, with the trainer's 16,
  17 and 18 at each step.

**Checks.**
- The trainer's tests passed on the new base at every step that conflicted.
- Upstream never changed the trainer's digests (only the jet's and the 747's), so
  each step's trainer pins stand as they were.

**Re-measured at the tip.**
- The trainer's 69 meshes are bit-identical to the tip before the rebase: the paint
  merge is texture only.
- The census is identical: bare board 193,764 px, and the same hard edges.
- The repo's cockpit frames script (`scripts/cockpit-frames.mts`) now expects the
  trainer's 18 cockpit-only meshes.

## S7: the yokes' grips, the compass's face, the headliner's corners

**The PM's review of the final frame (7be1ef7).** Everything else was accepted.
Three things were asked of this step.

**1. The yokes.** The horns read as two domed bollards with a glossy hot spot,
about 105 px wide.
- **The grip section** is now 22 mm across the view and 30 mm fore and aft,
  a flattened grip as a hand holds it. The hub stays under the eye (look call A)
  and the horn tops stay at the same height.
- **The cap** is a low ellipsoid 4 mm high: 0.36 of the half-width, where the old
  hemisphere was 1.0.
- **The material** is the yokes' own matte (`trainer-yoke`): the board's colour at
  roughness 0.95 and metallic 0. On the fittings' glossy dark, the horns read 1.6 to
  1.9 times the board's luma in the day frame, and the column's collar 2.9 times.
  The target, 1.2 to 1.4 times, is read in the GPU frame.
- **Measured:**
  - each horn is 79 px wide on the screen (the pin is 85 or less);
  - the yokes take 20,592 px (23,320 before);
  - the least gap to the door is 1.40 cm (1.64 before). The flatter caps keep the
    grip's full width to 4 mm under its top, where the door's rail comes a
    centimetre inboard. The pin is now 1.3 cm.

**2. The compass.** It was a blank box, 185 x 135 px.
- **The box** is now 60 x 46 x 70 mm, swept round its window (`compassBoxProfile`):
  - the window is 32 x 18 mm with corners 4 mm round, and a ring of the dials'
    bezel section on the dials' rim material, 8 mm inside the aft face;
  - behind the window is a cavity 6 mm inside the box's walls, so a ray through
    the window meets the card or the cavity, never the world behind the compass;
  - the box's height follows from its width and its window's; it was 60.
- **The lubber line** is a 1.2 mm rod down the window's middle, 1 mm in front of the
  card, on the rim material. Its ends are buried in the ring.
- **The card** is a drum 22 mm in radius and 30 mm tall, its face 7 mm behind the
  box's. It is one more draw (19 cockpit meshes), on the display material.
  - It turns about the vertical with the heading: the card keeps its north and the
    aeroplane turns about it.
  - Its numerals are a static page of the atlas: two rows of 180 degrees, marked
    every 5 and numbered every 30 (N 3 6 E 12 15 S 21 24 W 30 33).
  - Each heading is printed a half turn from where it faces the seat, so the
    heading reads under the lubber line and the card reads backwards, as a 150's
    does.
- **Its centre** is at +3.88 degrees (+3.24 before; the survey's +3.9). Only the
  box's height changed; its top is where it was.
- **Measured:** the card is 2,252 px, all of it through the window. The fittings
  (with the smaller box) are 64,023 -> 50,951 px.

**3. The headliner's corners** now have 24 chords, where they had 6. The header's
outline forward of the visors is 0.55 px off a fair curve, where it was 0.76.

**Across the frame:**
- no hard edge on the yokes, the bezels, the fittings or the card;
- bare board 195,128 px (the narrower horns uncover 1,364 of it);
- cockpit draws 18 -> 19.

**Four traps, each met on the way:**
- **`loopSolid` closes every section.** A profile that does not start and end on
  its loop's core (u at minus the radius) gets a band from its last point to its
  first. My first box's band cut diagonally through the box. The box's section now
  starts at the cavity's middle and ends at the front face's, both capped.
- **A ring's back edge.** On a dial it is buried in the board; in the compass's
  window it was a hard edge over the cavity. The compass's ring rounds that corner
  (1 mm), where the window's tunnel meets the cavity.
- **An open drum.** The eye is under the compass, so along some rays the nearest
  face of an open drum is its inside. The drum is capped.
- **A turning mesh.** The shading pin paired world positions with local normals, and
  read the card, turned by the heading, as shaded into itself. It now turns the
  normals with the mesh.

**Pins** (`tests/render.cockpit-trainer.test.ts`):
- **The yokes:**
  - their matte;
  - each horn's section and cap off the built mesh: 22 x 30 mm, the cap at most
    0.4 of the half-width, the top where it was;
  - each horn's width on the screen, 85 px or less, off the raster.
- **The compass:**
  - the ring 3 mm or more inside the aft face, across and up;
  - the window's corners 3 mm or more round, and its opening's width at the front;
  - the lubber line in the window;
  - the card on the faces' material;
  - the card under the lubber line reading N, 3, E, S, W and 33 at 0, 30, 90, 180,
    270 and 330;
  - every vertex of the card within the box's walls, and every card pixel from the
    seat within the window's opening.
- **Kept:**
  - the hard-edge pin now covers the compass's ring and lubber line (in the bezels);
  - the drawn-faces walk covers the card;
  - the shading pin covers the card, with world normals;
  - the header's fairness pin.

**Mutations.** Six are caught:

| mutation | caught by |
|---|---|
| round 30 mm grips (as S6) | the horn's width (105 px), the door gap |
| hemispherical caps (as S6) | the cap's height (1.0 of the half-width) |
| the yokes on the fittings' glossy dark | the matte |
| the card turned the wrong way | the heading (33 under the lubber line at 30) |
| the card printed without its half turn | the heading (S at 0) |
| a drum too big for the box | inside the box |

One mutation was first MISSED, and it found dead code. A helper giving a heading's
place on the card was exported but never used by the page, so mutating it changed
nothing. It is gone, and the half turn is mutated in the page itself.

**Mesh-by-mesh against the rebased tip** (07fae0e). On the trainer:
- `trainer-compass-card` is new;
- the yokes, the headliner, the fittings and the bezels moved;
- the other 65 of 70 meshes are bit-identical.

Every mesh of the jet, the Global and the 747 is bit-identical. The trainer's
digests are re-pinned on its line: seam 0d9cc1fc, taper 412d75a4.

**The GPU slot** (the PM's grant, 2026-10-01).
- **Gate A:** 8/8 pass. `trainer-yoke` is 13/16 in the rig, 14 live. The card now
  leads `trainer-display` at 14/16 in the rig, 15 live.
- **Two frames:** the trainer's air pose at 1080p by day. Both have HUD COCKPIT, the
  eye and the lens asserted, 19 cockpit-only meshes, no page errors, and the same
  two resource 404s as every earlier frame.
- **The yokes' luma against the bare board's (27.6):**

| | horns | the column's collar patch |
|---|---|---|
| on the fittings' glossy dark (7be1ef7) | 1.6 to 1.9x | 2.9x |
| on the board's own colour, matte (9114774) | 1.10 and 1.16x | 2.51x |
| on 1.2 times the board's colour (the one tune the slot allows) | **1.23 and 1.30x** | 2.72x |

  - The horns are in the PM's 1.2 to 1.4. Their sides read 1.04 to 1.07 times the
    board and their caps 3.6 times.
  - The collar's patch is mostly the column's top, which faces the sky: 3.53
    times. The collar ring's sides read 2.17 times.
  - A matte surface's luma here follows which way it faces, so one shared colour
    cannot put the horns and the column in the band together. The option, put to the
    PM: the columns and collars on a darker matte of their own, one more draw.
- **The PM's re-read, which withdrew that band.** At 1.2 times the board's colour
  the grips read as grey posts with pale tops. A 150's yoke is black plastic:
  darker than the board on its sides, its sky-lit tops only a little above it. The
  target became the tops (the caps and the column's top) at 1.2 to 1.6 times the
  board, and the sides at 0.4 to 0.7. It stays one shared matte, with no extra draw;
  two tunes were allowed.

| yokes' colour | frame's heading | board | caps | column's top | sides |
|---|---|---|---|---|---|
| 0x202c30 | 161 | 27.6 | 3.59x | 3.53x | 1.06x |
| 0x050708 | 87 | 43.2 | 0.91x | 0.87x | 0.44x |
| **0x0b0f11** (kept) | 92 | 41.5 | **1.35x** | **1.29x** | **0.60x** |

  - The tunes were sized from the power law the frames fit: luma goes as the albedo
    to 0.43 to 0.61, lowest for the sky-lit tops and highest for the sides.
  - The ratio is to the board in the same frame, and the scenic start's heading is
    random. At headings 87 and 92 the board is in the sun (41 to 43); at 161 it is
    not (27.6). The tops, lit by the sky, change much less, so at 161 the same black
    would read about twice the board on its tops.
  - Nothing pins the colour; the matte's roughness (0.95) and metallic (0) are
    pinned. At heading 92 the compass reads E under the lubber line, with 12 to its
    left and 6 to its right.
- **The compass**, at headings 163 and 161: the lubber line stands between S (left)
  and 15 (right), 11 to 13 degrees from 15, where those headings fall on a card
  that reads backwards. The card is legible at 2x.
  - Through the window's right side, the tunnel's wall shows at the 24 degree angle
    it is seen at.
- **The header's port corner** is a curve at 2x; its straight runs are gone.

## Rebased again, onto Fix-Cockpits d86e6b3

d86e6b3 has the Global's cockpit refinements, on top of 2917372 (the performance
work) and 7fc2280.

**The conflicts.** Both sides were kept in each.
- **`cockpitPrimitives.ts`:** the Global appended `smoothSheet`, `roundedBox` and
  `roundedCylinder` where S3 appended `sweptTube`. The file is resolved as the
  Global's, with exactly S3's appended lines after it (S3's change is a pure append).
- **The display pages:** the Global's `standby` page, beside the 747's `clock` and the
  trainer's pages.
- **KIT_SIZE and the cockpit frames script:** the Global's 9 with the trainer's own
  count at each step.

**Re-measured at the tip.**
- The trainer's tests passed at every step that conflicted.
- The trainer's 70 meshes are bit-identical to before this rebase, and the census is
  identical (bare board 195,128 px).
- 218 trainer-touching tests pass; tsc and eslint are clean.
