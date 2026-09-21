# The cockpit view was broken by its lens, its eye and its hidden skin

**Status: built for the Cessna, the Global and the 747, moving instruments
included. The F-16 is not done.**

Jason: *"Currently, the first person/cockpit view for all aircrafts are pretty
broken. ... I want the views to look like the player is actually flying from the
cockpit."* Two decisions came back through the PM afterwards: the lens is 75
degrees (*"2 is good"*), and the instruments should move (*"3 yes"*: built, see "The
instruments move" below).

## What was wrong, measured

**The lens was a telephoto, and the comment said otherwise.** The flight camera
is `FOVMODE_HORIZONTAL_FIXED`, so the cockpit's `56` was 56 degrees HORIZONTAL:
33.5 vertical at 16:9, azimuth +-28, elevation +-16.7. Every dial sat 17 to 25
degrees below the eye, which is below the frame. It is now 75 horizontal (azimuth
+-37.5, elevation +-23.35), one constant, `COCKPIT_HORIZONTAL_FOV_DEGREES`. The
perf harness keeps 56, and the eye on the centreline, through `PERF_COCKPIT_RIG`
passed as `FlightRendererOptions.cockpitRigOverride`, so the 14 cockpit-mode perf
shots keep their framing.

**The eye was on the centreline, between the seats.** `CockpitEyeSpec` gained
`right` (metres, +starboard): trainer -0.26, Global -0.52, 747 -0.72, F-16 0.
(The 747 stayed at 0 until its flight deck was rebuilt around a left-seat eye:
see "The 747's cockpit".) The aim point carries the same offset so the view stays
parallel to the body axis.

**The Global's eye stood above its own windscreen.** The catalogue had it at
(11.6, 1.05); the pane is a 0.16 m slab raked 34 degrees whose top edge is at y
0.98, so from the seat the whole windscreen read -4 to -27 degrees, under the
horizon. `scripts/global-eye-solve.mts` searched for an eye that sits inside the
glass's own vertical span, sees its top edge at +14 to +18 degrees, keeps the
nearest glass 0.55 m away and 0.15 m of skin above the head. The feasible region
is a thin sliver (forward 11.85 to 11.95 at up 0.78, nothing at all above up
0.81): further aft the top edge drops under +14, further forward the pane's
top-back corner comes inside 0.55 m. The eye is its middle, (11.90, 0.78,
-0.52): top edge +15.1, bottom -21.3, glass 0.605 m away, 0.31 m of skin above.
Every angle is computed twice, by corner arithmetic and by ray-casting the built
mesh, and they agree to 0.02 degrees.

**The interiors were slabs and the glass hid them.** A panel board with round
dials on it, a fuselage the camera could not show, and glass built with
`transmission`, which draws as an opaque slab from inside.

## What changed

**Cockpit-only parts.** `CommonRig.cockpitOnlyParts`: meshes that are invisible
until cockpit view is on and are never shadow casters
(`configureCockpitOnlyParts` enforces both in one place; `setCockpitVisibility`
toggles them). Only the flight camera and the cascaded shadow generator's caster
list draw aircraft meshes, so `isVisible` is enough and no layer bit is used.
`metadata.cockpitOnly` marks them so a frame script can assert from the live
scene that none is drawn outside cockpit view.

**The Cessna.** Its fuselage is a CLOSED tube whose cabin-section top skin is the
window sill, and the eye is 0.12 m above it, so the pilot would look down onto
the outside of the skin: the tube stays hidden, with the glass, and what used to
show only by being inside it is rebuilt as cockpit-only parts to the angles
below (`cockpit/trainerCockpit.ts`): a cowl stand-in lofted from the fuselage's
own rings, the panel with its hood, five real-size dials in the real order, two
windscreen posts, door panels with sill caps. Hood top -8.35 degrees, the main
dial row centred -15 and the second -21, each dial 6.5 degrees across, the cowl
rising to -4.7, the left post's axis at azimuth -35.

**The Global.** The eye above, and (`cockpit/bizjetCockpit.ts`): a panel and a
matte black hood (top edge -10.0 degrees), four flat screens 0.22 by 0.15 with
dark-grey bezels (the pilot's pair centred on the eye's own z, top edge 1.5
degrees under the hood's underside), the pilot's left screen carrying an attitude
ball of sky half, ground half and pitch bar under ONE pivot node, two windscreen
posts (the left one's axis at azimuth -34, raked like the glass, its foot at the
sill as far forward as the shell allows), an overhead from the glass's top edge
to 0.3 m behind the eye, and side walls with sill caps. Hidden from the cockpit
camera: the glass and the radome. Visible again: the fuselage and the centre
post.

**Three things learned that would have been wrong to guess.**

- **A loft's rear end cap faces the pilot.** `build.loft` caps both ends with
  outward normals. The Global's radome starts at x 13.1, so its cap faces -x,
  straight at the seat, and back-face culling cannot hide a face that points at
  you: with the radome visible it was a black disc over 317 of the 2,800 cells
  of the probe's frame. It is the only face of the radome the seat can see, so
  the radome stays in `cockpitParts`.
- **Babylon's picking ignores back-face culling.** With the Global's fuselage
  drawn again and the eye inside it, a ray that ignores culling hits the inside
  of the skin everywhere and never sees the sky. The tests and the probe
  calibrate the winding sign on a closed box (the sign that hits it from outside
  and misses it from inside) and use `multiPickWithRay` with a triangle
  predicate. `mesh.intersects` wants a LOCAL-space ray, not a world one: use
  scene picking.
- **`mergeStatic` leaves the merged mesh's origin at the aircraft origin**, with
  the vertices baked in body coordinates. A merged Cessna needle therefore cannot
  rotate about its dial's centre. Measured: position (0, 0, 0), pivot (0, 0, 0),
  no rotation, dial at (2.068, -0.065, -0.360).

## Evidence

The angles above are read off the BUILT meshes by ray, not derived from the
constants: `tests/render.cockpit-trainer.test.ts` and
`tests/render.cockpit-bizjet.test.ts` write the targets as literals and measure
the built glass, so moving a builder constant cannot move its own expectation.
Each test has a control: twenty mutations of the Cessna's cockpit and thirty-three
of the Global's (the old eye, the radome visible, the fuselage hidden again, a
post through the wall, an overhead 5 cm low, a bezel back on the pale material,
...) each make at least one test fail, and each file is restored afterwards.
`scripts/cockpit-view-probe.mts` prints the frame as a character map and the
angles of every part; `scripts/cockpit-shell-clearance.mts` and
`scripts/bizjet-cockpit-clearance.mts` print how far each part stands inside its
shell; `scripts/cockpit-frames.mts` photographs the shipped page and refuses to
save a frame whose HUD, scene kind (read from the live scene), eye or lens is not
what it claims.

**The Global's overhead pokes through the crown, on purpose.** The windscreen is
a flat 1.44 m pane on a nose whose crown falls away sideways: at the pilot's z the
crown is 0.881 m high at x 12.63 against the glass's top edge at 0.976, so the
overhead's front edge stands 0.095 m above the skin there (0.125 with its own
thickness), and its outer ends run past the shell. Nothing can see it (it is
cockpit-only and the cockpit camera culls the shell from inside). A ceiling that
followed the crown would make the opening's top edge read about +11 degrees
instead of +15.

## The instruments move (Step I)

Jason, via the PM: needles that move with airspeed, altitude, vertical speed and
RPM, and an attitude ball (*"3 yes"*). They are driven from the same
`FlightVisualState` fields the 2D HUD reads, in fixed AVIATION units whatever the
HUD's units setting (`cockpit/instrumentMappings.ts`, a pure module):

| dial | reads | mapping (degrees clockwise from 12 o'clock as the pilot sees it) |
| --- | --- | --- |
| Cessna airspeed | `airspeed` (m/s, equivalent) x 1.94384 kt | -150 at 0 to +150 at 160 kt, clamped |
| Cessna altimeter | `altitude` (m above sea level) x 3.28084 ft | one needle, 360 per 1,000 ft, wraps |
| Cessna vertical speed | `verticalSpeed` (m/s) x 196.85 ft/min | -90 at 0, 0 at +2,000, -180 at -2,000, clamped |
| Cessna engine | `engineRpm` (prop RPM) | -135 at 0 to +135 at 2,750, clamped |
| Global attitude ball | `bank`, `pitch` (degrees) | the ball's horizon turns by MINUS the bank; the pitch bar slides down 1 mm a degree of nose-up, clamped at 25 |
| Cessna attitude ball | `bank`, `pitch` (degrees) | the same ball at 0.75 of the size (radius 0.036 on the 0.08 dial): the bar slides 0.75 mm a degree, clamped at 25 |

The Cessna's attitude dial first had no mapping and its needle stood at 12
o'clock; it now wears the Global's ball (see "The Cessna's attitude ball" below)
and has no needle. The update runs inside the visual's `update()` and only while cockpit view is on (the
visual already received the whole state every frame; no plumbing was needed).

**The sign is held to the SCREEN, not to an angle.** A dial's normal points TOWARD
the pilot, and a positive right-handed rotation about an axis pointing at the
viewer looks ANTI-clockwise to that viewer, so a needle turned by +angle runs
backwards while every angle-in/angle-out test passes. `tests/render.cockpit-instruments.test.ts`
projects each needle's hub and tip through the cockpit camera (built from the
renderer's own `cockpitRigPositionsToRef`, with Babylon's projection and the y-down
screen convention written once in `tests/support/cockpitProjection.ts`) at two
readings and requires the tip to have moved clockwise; the ball's horizon is held to
the WORLD horizon projected through the same camera, within a degree, with the sky
half on the sky's side and the pitch bar on the ground side for a climb. Every
reading is also held to the number the HUD renders for the same state, and the
altimeter test stands on ground that is not at 0 m (altitude 1,600, height above
ground 1,500), because at sea level the two differ by a gear offset and a dial wired
to the wrong field would pass. Twenty-two mutations (each sign flipped, each dial
wired to the wrong field or scale, the update ungated, the origin not re-framed, ...)
each fail a test.

**Two defects in the state the instruments read**, both found by measuring, both
fixed with their own commits: the extrapolated render state's bank was the NEGATIVE
of the simulator's (`updateVisualAnglesFromOrientation` called body +Z port, which
D-6 corrected on 2026-09-01), and bank was interpolated linearly, so +170 and -170
degrees averaged to wings level.

**What the perf harness's fixed states put on the dials.** Its states are
`INITIAL_VISUAL_STATE` with the shot's airspeed and altitude and an orientation, so
vertical speed is 0 (the needle at 9 o'clock), the engine is 2,250 RPM (+85.9
degrees), pitch and bank read 0 whatever the orientation, and the rest is the shot's
own: eleven of the fourteen cockpit shots fly at 0 m/s (airspeed needle on its
-150 stop), `canopy-1200ft` at 62 m/s = 120.5 kt (+76.0), `high-10000ft-down` at
92 m/s = 178.8 kt (clamped at +150). The altimeter reads the shot's altitude above
sea level: `high-10000ft-down` 3,048 m = 10,000 ft (12 o'clock), `water-3m` 4 m =
13 ft (+4.7), `water-400ft-glitter` 120 m = 394 ft (+141.7); the shots placed by
height above the terrain read the terrain's height plus that, which depends on the
world. All deterministic, so the fourteen cockpit shots differ from before in their
foreground and nothing else.

**The Cessna's attitude ball.** The attitude dial has the Global's ball at 0.75 of its
size and no needle. The ball's builder moved out of the Global's cockpit into
`buildAttitudeBall` (`cockpit/cockpitPrimitives.ts`); the Global's 99 meshes are
bit-identical before and after, positions and indices. On the Cessna: radius 0.036 on
the 0.08 m dial (4 mm of face shows round it), sky and ground 1.5 mm in front of the
face, the bar 1.5 mm in front of them, the bar the Global's 0.07 x 0.003 scaled to
0.0525 x 0.00225, sliding 0.75 mm a degree (`pitchBarOffsetMetres` takes the ball's
radius) and clamped at 25 degrees, where its corners are 3.1 mm inside the rim (the
Global's 4.1). The dial's normal points TOWARD the pilot and a ball's pivot must point
AWAY, so the ball hangs from a frame node whose axes are the pivot's (X the normal
reversed, Y up the leaning face, Z the pilot's right); the sign of the turn was taken
from the screen-space test and not from the Global's code, and a ball framed like a
needle (X toward him) fails it. The panel leans 6.9 degrees off the image plane and the
dial sits 15 degrees below the eye, so the Cessna's ball horizon is 0.46 degrees off
the world's on the screen at a 20 degree bank (the Global's is exact): inside the
test's one degree, where a flipped sign is out by 40. In the perf harness the ball
reads level (its states carry pitch and bank 0) and the attitude needle is gone.

## The 747's cockpit

**What was wrong, measured.** From the catalogue's eye (28.8, 3.1, 0) the live frame
was two huge dark slabs and a wall of panel. `airliner-flight-deck-glazing` is a PBR with
refraction on (`airliner-glass`, alpha 0.29, `subSurface.isRefractionEnabled`), and a
refractive material draws as an opaque slab from INSIDE, so the port and starboard No.1
panes filled the frame; the probe printed the same glass as "looked through" and hid it.
The instrument board was laid out about the centreline, 1.15 m ahead, its top edge at
-9.7 degrees and two of its five dials below the frame (elevation -27.8 and -28.0). And
the seats stood 2 m behind the glass, which, and not the eye, is what capped the view:
with the seats where they were, no eye near them could read the port No.1 pane, the only
glass straight ahead of a left-seat pilot, above +5 or below -7.

**The eye is solved, not chosen** (`scripts/airliner-eye-solve.mts`), against the BUILT
glazing, with the same constraints as the Global's: y inside the glazing's span (2.623 to
3.218); the pane's top edge +T and its bottom edge -T or lower straight ahead; at least
0.55 m from the glass (the exact point-to-triangle distance); at least 0.15 m of skin
above. Held to the Global's own +14 to +18 no eye satisfies them: 0 of 8,721 grid points.
With the old panel and the old seats treated as movable, the pilots sitting close behind
the windscreen as they do on the real aeroplane, the maximum is T 9.53 at (29.915, 2.935),
bound by the glass distance. The catalogue takes the round point with a margin,
**(29.90, 2.93, -0.72)**: top +9.64, bottom -9.39, T 9.39, glass 0.558 m, skin 0.474 m.
The analytic edge arithmetic and a ray-cast of the built triangles agree to 0.05 degrees at
four eyes; at the old station (28.8, 3.1) the same pane reads +0.9 / -9.2, at (29.1, 2.95)
+5.3 / -7.0. The deck is built AROUND that eye (`cockpit/airlinerCockpit.ts`):

| part | built to |
| --- | --- |
| seats, headrests | moved forward with the pilot: the port seat's centre 0.05 m aft of the eye (x 29.85), its rear-top corner 0.15 m below it; symmetric; the pilot's is the PORT seat, the mesh NAMED first-officer |
| panel | rear face 0.75 m ahead (x 30.65), half-width 1.30: the shell's OUTER half-width at the hood's far top edge is 1.323, less 2 cm |
| hood | far top edge at -10.0 degrees (y 2.7837); aft-edge underside -14.4 |
| dash | the hood's top surface carried on down 8.2 degrees to the glazing's lowest bottom edge (31.843, 2.623). The glass's bottom edge straight ahead reads -9.35 and the hood's far edge -10.0, so without it a 0.6 to 1 degree band of the hidden nose shows between them |
| screens | six, 0.22 x 0.15, laid out about the SEATS: the PFDs on the seat lines (z -0.72 and +0.72), the NDs and the EICAS 0.245 inboard of each other. The pilot's PFD is straight ahead (azimuth 0), his ND at +18.2 and the EICAS at +33.4; three of the six are in the 75 degree frame |
| PFD ball | `buildAttitudeBall`, the Global's and the Cessna's builder and mapping, on the PFD's upper two-thirds; the screen-space ground-truth test now runs over all three |
| overhead | underside at the lowest pane top (y 3.137), the plan raked to follow the glass's top edge across the port No.1 pane and across the crown gap |
| pillar | a trapezoid plate in the plane of the crown between the No.1 panes, z +-0.618 at the bottom to +-0.175 at the overhead: the model's panes leave a V of open crown 0.5 m wide at the top and 1.2 m at the bottom, which reads as sky with the shell hidden |
| post | radius 0.025 in the seam between the No.1 and No.2 panes, which is a wedge 0.35 m wide at the bottom and 0.1 at the top. The design post ends where it meets the overhead's underside; its MESH runs 0.08 m on past that along its own axis (`AIRLINER_POST.buryMetres`), so no cut end shows |

The pillar and the post are on the INTERIOR material, the one the board, the overhead and the seats
are on, and are merged into `airliner-cockpit-interior` with the board and the overhead they hang
from; the hood and the dash are the only parts on the glareshield's own matte material. It was
built the other way first, and read wrong twice. On the airframe's glossy dark material the pillar's
big face showed a sheen of the sky. On the glareshield's matte one, which has no ambient light by
design (a glareshield must not reflect in the windscreen), any face the sun misses reads (0, 0, 0):
the pillar was a black hole in the picture beside a blue-grey ceiling, and the post a black bar beside
a blue-grey pillar, which reads as two different aeroplanes. On the interior material both read the
ceiling's own colour, (19, 29, 38) against the ceiling's (19, 27, 33). Seven cockpit-only meshes in
all, one draw fewer than the first build: four static (the board, the overhead, the pillar and the post;
the hood and the dash; the screens; the bezels) and the ball's three. There are no side walls and no
pedestal: a frame and MAP B show nothing there. The glazing joins `cockpitParts`, and the old panel,
gauges and needles are deleted.

**The post's two cut ends.** The top is buried (above); the foot is not, because the shelf hides it. Over
the post's whole angular extent on a 0.06 degree grid the lowest point of it that any ray meets is 0.111 m
above the foot (y 2.741 against the foot's 2.652), and the highest is the overhead's underside (y 3.137),
where it enters the plate. A test holds both.

**Angles against their targets, and clearances** (`scripts/airliner-cockpit-clearance.mts`
prints these; `tests/render.cockpit-airliner.test.ts` holds them):

| quantity | target | measured |
| --- | --- | --- |
| port No.1 pane, top / bottom straight ahead | T >= 9 | +9.60 / -9.35 (ray-cast) |
| glass distance, skin above | >= 0.55 m, >= 0.15 m | 0.558 m, 0.474 m |
| hood's far top edge | -10.0 +-0.1 | -10.00 |
| shelf's top edge straight ahead | over the glass's bottom (-9.35), under -8.5 | -9.14 |
| opening's top edge straight ahead | at or under the glass's top (+9.60) | +8.80 (azimuth -30: 10.04 against the glass's 21.30; -8: 9.38 against 10.60) |
| PFD, ND, EICAS azimuth | 0, 17.5..19, 32.5..34.5 | 0.00, 18.22, 33.35 |
| screens' top edge | 1.5 under the hood's underside | -15.86 |
| seam post foot / design top azimuth | -30..-22 / -16..-12 | -28.00 / -13.23 |
| seat centre aft of the eye, top below it | 0.05 m, 0.15 m | 0.05, 0.15 |

Clearance from the shell's outer skin (positive is inside): the panel board 0.035 m, the hood
and the dash 0.018 m, the screens and bezels 0.56 m and up, the ball 0.67 m and up; nothing
outside. The OVERHEAD pokes through the crown on purpose, as the Global's does (nothing can
see it: it is cockpit-only and the shell is hidden from the cockpit camera): 0.596 m above the
crown at its outboard corner (30.857, 3.167, -1.400) and 0.417 m sideways past the skin, where the
Global's was 0.846 m. The pillar and the post stand up to 0.137 m proud of the skin, at the
post's foot, because they are placed against the glazing's built corners and the panes stand half
proud of the nose: the port No.1 pane's own corners are 0.178 m outside it. Everything stands
behind the glazing's bottom line (x 31.843), the pillar's 0.04 plate 1.4 cm past it.

**Traps found**

- The shell's OUTER envelope is the LAST crossing of a ray from the centreline. The fuselage and
  the radome are two overlapping closed lofts, so the FIRST crossing hits the fuselage loft's
  internal wall (0.99 at x 30.5 where the skin is 1.45), and a parity count says "outside" from
  anywhere inside their overlap. Only the nose loft exists ahead of x 30.6. The crossings are the
  mesh's own triangles (`scripts/rayCrossings.mts`), because `pickWithRay` returns one hit per mesh.
- Between the panes the model has open wedges of skin (the seam, the crown gap). With the shell
  hidden they read as sky, so the test asks for no sky directly under or over any pane's OWN edge,
  and for solid below the shelf and above the overhead's edge, not for "no sky near the glass".
- `verticalProfile` triangulates as a fan: only convex outlines work. The overhead's plan, the dash
  and the pillar are convex; a notch would triangulate wrongly.
- No loft end cap faces the pilot: the only caps ahead of the eye are the fuselage's front end (x
  30.6, wound outward, so culled from behind) and the radome's tip (x 34); the radome's rear cap
  (28 m^2) is at x 25.5, 4.4 m behind the pilot. The Global's radome, whose rear cap blacked out its
  windscreen, is the case this rules out. A test holds it on the shell's own triangles, with a control
  (the same cap DOES face a viewer behind it) and a mutation that puts the eye behind it.
- The perf rig's centreline eye looks straight at the pillar, so a 747 perf shot would need a lateral
  eye, as the Global's does; the 14 cockpit perf shots fly the trainer, so nothing is affected.
- The probe printed refractive glass as see-through; it now prints it as OPAQUE-FROM-INSIDE, so MAP B
  agrees with the renderer.

**Pins that moved, each with its reason in the test.** The draw bounds (97 meshes, 64 casters, 225
draws) did NOT move, and a new test pins that and says why: cockpit-only parts are invisible outside
cockpit view and never cast (89 drawn, 205 draws today; the kit is +7 non-casting draws in cockpit view
only). What moved: the authored-parts total 134 -> 144 (-11 old panel, gauges and needles, +21 kit); the
enclosed-parts pattern and its count 53 -> 63; `cockpitParts` gains the glazing; the two isVisible
loops exempt cockpit-only parts; the folded-parts count 68 -> 71 (the ball's pieces hang from the
pivot); the geometry census (10,711 -> 11,163 vertices, the arithmetic in the test); the seam digests
(the 747's to `d6f31000`, the trainer's to `c6fcfb25` and the Global's to `a8ce6a25`) and the taper
digests of the trainer and the Global, each checked mesh by mesh against House-Keeping's tip: the
747's other 88 of 91 meshes are bit-identical, the trainer's and the Global's differ by their ball's
two halves alone (2 of 70, 2 of 99) and the jet's 78 do not move; the rig test's 747 branch, which
joined the two-seat rule.

**Controls.** Thirty mutations of the cockpit, each turning at least one test red: the eye at the old
station, on the centreline, 0.4 m too far forward, or behind the radome's rear cap (7 to 9 tests each);
the seats aft, low or at their old station; the glazing left visible; the hood at -8; the dash removed
or narrowed; the overhead low, narrow or straight; the pillar a sliver; the post a hair or back at 0.03;
the pillar and post on the wrong material (the first shape: see below); the PFD off the pilot's line; the screens' top edge; the panel
too wide or lifted; the ball off its screen, turned the wrong way (6 tests; the ball's horizon 40 degrees
out), its bar sliding up (9), or updating outside cockpit view; the kit not made cockpit-only, visible in
every view, or casting; and a stale copy of the glazing's constants, as after a nose re-loft.

**Controls on the final shape** (pillar and post on the interior material, merged into the interior mesh,
the post buried; each run with the dev server down and the tree clean afterwards). Every one turns a test
red: the pillar and post back on the hood's matte material in a mesh of their own, the shape this branch
started with (14 tests: the names, the materials, the draw bound, the clearances); the post's top not
buried (3, among them the burial test), or its mesh not lengthened while the constant says it is (3), or
buried 0.4 m so it stands proud of the skin (3); the dash removed (4); the pillar a sliver (4, among them the
crown-gap fill); the post a hair or at radius 0.03 (3 each); the pillar and post swapped in the merge order
(10); the kit not cockpit-only (5), visible in every view (2) or casting (3); the ball turned the wrong way
(6, the horizon 40 degrees out). One control that did NOT bite is worth keeping: removing the dash does not
uncover the post's foot, because the hood's far edge (-10 degrees) hides a foot that reads -12.9. The
foot-hidden test goes red when the hood's edge is dropped to -15 (6 tests). The six drawn-faces mutations
below give the same results on this layout.

**For the plane engineer's register.** Even with the pilot moved forward the opening is about 19 degrees
tall (+9.6 / -9.4 through the port No.1 pane) where the type's is nearer 35. Cause: the model's six panes
lie 45 to 53 degrees UP on the nose crown and sit far forward (No.1: outward normal 53.4 degrees up,
turned 50 degrees toward the nose), and the crown itself (3.10 m at x 31.0, z -0.72) is the ceiling of
every one of them, so no eye and no glass edit can read +14. Fixing that is a nose re-loft, not cockpit
work.

## Drawn faces: the plates were built inside out and every ray-cast test was green

**What was wrong, measured.** In the first 747 frame the windscreen pillar, a fifth of the frame,
was a black void with the ground showing under it: its bottom edge at row 605 and the glareshield's
shelf at row 626, twenty rows of terrain between them, and the shelf itself 13 rows too low at the
centre (row 631 where the geometry puts it at 618). The overhead, the dash and the pillar of the 747,
and the attitude ball's two halves on all three aircraft, were built inside out: the GPU culled the
face the pilot faces and drew the far one from inside, lit by normals that point into the solid. The
balls hid it, being emissive, and a suite of ray-cast tests passed throughout.

**The trap, in plain words.** A ray cast hits a triangle whichever way it faces. The GPU does not draw
a triangle that faces away. `verticalProfile` extrudes an outline and does not reverse its triangles,
and Babylon's right-handed normal is the inverse of the mathematical one, so an outline wound
counter-clockwise in its own x/y is built inside out. A clockwise outline is not enough either: the
builder winds its thin edge WALLS the opposite way to its caps, so a pilot standing beside a plate
sees a shell with one side missing. That inconsistency is the shared builder's, it is registered for
the plane engineer, and it is not fixed here (`builders.ts` is not this branch's to edit).

**The instrument: the first face the GPU draws.** From the catalogue eye, over the frame (azimuth
-37..37, elevation -21..21, one degree), the nearest triangle of each cockpit-only mesh, and whether
the GPU draws it. The convention was MEASURED on a `build.box` face that visibly renders: a drawn
face's `cross(p1 - p0, p2 - p0)` points INTO the solid, so it is drawn if `dot(cross, rayDirection) > 0`.
`tests/render.cockpit-drawn-faces.test.ts` runs it on the Cessna, the Global and the 747 with ZERO
allowance, and asserts the convention first on the pitch bar's box, both ways (drawn from outside,
culled from inside), so a flipped convention cannot pass. A second assertion holds every flat-shaded
triangle (three equal vertex normals: a box, a plate, a half) to a normal that faces the eye, so the
plates' own normals cannot be written inward with every other test green. Every mesh must be hit by
more than zero rays, because void has to look different from clean: the needles, the pitch bars and
the halves are sampled on a 0.1 degree grid over their own extent, and so are the starboard posts and
door, which lie outside the frame.

| mesh | culled nearest faces, before | after |
| --- | --- | --- |
| `airliner-cockpit-interior` (board, overhead) | 970 of 1,784 rays | 0 |
| `airliner-glareshield` (hood, dash) | 38 of 355 | 0 |
| `airliner-windscreen-frame` (pillar, post; since merged into `airliner-cockpit-interior`) | 342 of 459 | 0 |
| `airliner-pfd-sky`, `-ground` | 19 of 19, 14 of 14 | 0 |
| `bizjet-pfd-sky`, `-ground` | 25 of 25, 8 of 8 | 0 |
| `trainer-attitude-sky`, `-ground` | 17 of 17, 11 of 11 | 0 |

**The helpers** (`cockpitPrimitives.ts`). `clockwise(outline)` returns an outline wound clockwise
whichever way it came. `solidPlate(build, name, outline, thickness, material, parent)` builds the plate
with `verticalProfile`, then decides each triangle's winding BY GEOMETRY (a drawn face's cross product
points into the solid, so a triangle whose cross product points away from the solid's centroid has two
vertices swapped) and gives every triangle three vertices of its own with a flat normal pointing out.
It does not read the builder's index order, so it survives the builder being fixed. The overhead, the
dash, the pillar and both halves of every ball go through it. A plate has a dozen triangles, so three
vertices each is cheap; the census arithmetic is in the draw-budget test. Draw counts and mesh counts
did not move on any aircraft (89 drawn, 58 casters, 205 draws; seven cockpit-only meshes on the 747).

**A single grid read zero by luck.** A grid on round angles can graze an edge built to a round angle
(the hood's far top edge is built at -10.00 degrees, which is a grid line: the ray at azimuth 0,
elevation -10 picked either face by rounding and read "culled" once) and it can miss a 2 mm rim
altogether. The first version of the test asserted zero on one 1 degree grid and read zero for the
ball halves. The same instrument on grids offset by a fraction of a degree:

| grid offset | culled nearest faces |
| --- | --- |
| 0 | none |
| 0.13 | `bizjet-pfd-sky` 1 |
| 0.37 | `bizjet-pfd-sky` 2 |
| 0.61 | `airliner-pfd-sky` 1, `airliner-pfd-ground` 2 |
| 0.83 | `bizjet-pfd-ground` 1, `airliner-pfd-sky` 1 |

So the halves were routed through `solidPlate` as well, the test samples them on the fine grid, where
the rim is the nearest face for up to 4 percent of the rays that touch a half (75 of 1,949 on the 747's
ground half), and it runs at two offsets, 0.37 and 0.61, the two that found rim rays.

**Controls, each run with the dev server down and the tree clean afterwards.** `solidPlate`'s winding
step skipped: red on all three aircraft at both offsets, 31 and 29 rays culled on the 747's pillar and
up to 75 on a half. Its normals written as +cross: every flat face's normal faces away, red on the
plates and the halves. The 747's overhead built by `build.verticalProfile` with its plan as handed
over: 918 and 931 of the 1,700 rays that touch the interior mesh culled, red. The halves back to
`clockwise` alone: red on all three aircraft at both offsets, 3 to 75 culled per half. The test's own
convention flipped: nine red, among them the box control on all three aircraft. One mutation survives
on purpose: `clockwise` made the identity inside `solidPlate`, because the geometric rule never reads
the outline's direction; it stays as a cap-winding courtesy to the builder.

**The 747's frame, predicted and measured** (1600 x 900 PNG, f 1042.6 px, horizon row 450; the frames
are `airliner-air.png` and `airliner-runway.png` of the final build):

| | predicted | measured |
| --- | --- | --- |
| shelf's top edge straight ahead | row ~618 (was 631) | **618** |
| pillar's bottom edge | row ~615, on the shelf, no terrain under it (was 605, twenty rows of ground) | **615**, on the shelf |
| pillar colour | "no longer pure black after the winding fix" | (0, 0, 0) after the winding fix; (19, 29, 38) on the interior material |
| the post's top end | hidden by the overhead | visible as a lit cap at about (555, 190) until the mesh was buried; hidden after |

Two of the four were wrong, and the reasons are worth keeping. The pillar was black for TWO independent
reasons: its faces were inside out (the winding fix, which is real: the terrain under it is gone), AND it
was on a material with no ambient light, on a face turned from the sun. Fixing the first left the second
in place, so "not pure black after the winding fix" was false. The post's top end could not have been
hidden by the overhead as built, because the post ended exactly on the overhead's underside plane (y 3.137,
both): a rod that meets a ceiling shows its end to anyone below it. It is hidden by running the mesh on into
the plate.

**Why the ball's colour moved.** Routing the ball's two halves through `solidPlate` changed how they shade,
and it is the record of why. The halves are lit PBR (albedo 0x6f93ad / 0x7d5a3a plus only 0.35 / 0.30
emissive), so the shading follows the normals. The old pillowed, inward-facing normals caught the sky's image
light as a diagonal gradient with a near-white corner at the sky's upper left, which was a lighting accident and
not a design; flat face-on normals give each half ONE colour, which is what an instrument face looks like.
Mean RGB over each half's disc at level flight (pivot 0.00 degrees, bar 0 m), before and after:

| | sky, before | sky, after | ground, before | ground, after |
| --- | --- | --- | --- | --- |
| Cessna | (156, 176, 190) | (135, 159, 177) | (110, 101, 88) | (124, 116, 102) |
| Global | (147, 162, 172) | (141, 158, 169) | (95, 89, 78) | (128, 118, 104) |
| 747 | (143, 160, 173) | (104, 130, 149) | (97, 90, 79) | (93, 89, 80) |

The sky's upper-left highlight went (187, 199, 207) -> (136, 160, 178) on the Cessna, (165, 176, 182) ->
(142, 159, 169) on the Global and (168, 181, 189) -> (106, 132, 153) on the 747. There is no banding, the
horizon bar, the sky/ground split and the rim are unchanged, and the emissive intensities were left alone on
purpose. The 747's ball is the dimmest of the three under the same materials.

**For the plane engineer's register.** `AircraftBuildContext.verticalProfile` winds its thin edge walls
opposite to its caps, and a counter-clockwise outline builds inside out. `solidPlate` works round both;
the builder is untouched.

## Not done, and one thing to know

**The Global's perf-rig eye.** The perf harness puts the eye on the centreline,
which puts the Global's centre post dead ahead (a bar 18% of the frame at the top
and 12% at the hood, azimuth +-5.2), so a Global cockpit perf shot would need a
lateral eye. The 14 cockpit-mode perf shots fly the trainer, so nothing is
affected today. Their foreground is now the new panel, dials, hood, cowl stand-in
and posts on top of the hidden tube, with lens and eye still pinned, so any
baseline comparison of those shots sees a foreground change and no framing
change.

**Not built:** the F-16's cockpit. Baselines are not promoted here; the single end-of-wave
promotion absorbs the change.
