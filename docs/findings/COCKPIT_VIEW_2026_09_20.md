# The cockpit view was broken by its lens, its eye and its hidden skin

**Status: built for the Cessna, the Global and the 747, moving instruments
included. The F-16 has its coaming, board and HUD frame (phase F1) and its two
MFDs drawing the PFD and the map (phase F2); its UFC is not built.**

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
ball of sky half, ground half and pitch bar under ONE pivot node (since removed: the
screens draw real PFD and map pages now, see "The Global's screens draw pages too"), two windscreen
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
| Global attitude ball (REMOVED; its PFD page draws attitude now) | `bank`, `pitch` (degrees) | the ball's horizon turned by MINUS the bank; the pitch bar slid down 1 mm a degree of nose-up, clamped at 25 |
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

*Built against the flat window boxes; superseded by "The 747 rebuilt round the re-lofted glass" below, when the nose was re-lofted and the panes cast by angle.*

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
| pages | the six screens sample one 1320 x 600 atlas, six 440 x 300 slots, redrawn at 15 Hz (`cockpit/displays/`). There was a 3D attitude ball here instead, `buildAttitudeBall` on the PFD's upper two-thirds, from before the screens could draw anything; it came out when the pages went in (see "The screens draw pages, and the ball came out") |
| overhead | underside at the lowest pane top (y 3.137), the plan raked to follow the glass's top edge across the port No.1 pane and across the crown gap |
| pillar | a trapezoid plate in the plane of the crown between the No.1 panes, z +-0.618 at the bottom to +-0.175 at the overhead: the model's panes leave a V of open crown 0.5 m wide at the top and 1.2 m at the bottom, which reads as sky with the shell hidden |
| post | radius 0.025 in the seam between the No.1 and No.2 panes, which is a wedge 0.35 m wide at the bottom and 0.1 at the top. The design post ends where it meets the overhead's underside; its MESH runs 0.08 m on past that along its own axis (`AIRLINER_POST.buryMetres`), so no cut end shows |

The pillar and the post are on the INTERIOR material, the one the board, the overhead and the seats
are on, and are merged into `airliner-cockpit-interior` with the board and the overhead they hang
from; the hood and the dash are the only parts on the glareshield's own matte material. It was
built the other way first, and read wrong twice. On the airframe's glossy dark material the pillar's
big face showed a sheen of the sky. On the glareshield's matte one, which then had no ambient light
(a glareshield must not reflect in the windscreen; it takes the sky's diffuse light since the F-16's
phase F1, see there), any face the sun missed read (0, 0, 0):
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
allowance, and asserts the convention first on a `build.box` the pilot plainly sees, both ways (drawn
from outside, culled from inside), so a flipped convention cannot pass. (On the Cessna that box is
its mechanical ball's pitch bar. On the 747 and the Global it was their PFD balls' pitch bars until
the balls came out; it is each pilot's PFD SCREEN box now, which is the same kind of thing: one box,
closed and convex, wound by Babylon itself.) A second assertion holds every flat-shaded
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
did not move on any aircraft (89 drawn, 58 casters, 205 draws; seven cockpit-only meshes on the 747 --
four now that the ball is gone, and eleven on the Global then, eight now. The rows of this table that
name `airliner-pfd-*` and `bizjet-pfd-*` are a record of what WAS measured on meshes that no longer
exist; only the `trainer-attitude-*` rows describe meshes that are still built).

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

## The screens draw pages, and the ball came out

**What the screens show.** Four page kinds -- PFD, ND in expanded-arc map mode, upper and lower
EICAS -- across the six screens, drawn flat onto one 2D canvas and uploaded as ONE emissive texture
(`cockpit/displays/`). Six screens, one atlas, one material, one draw: each screen box is given the
UVs of its own slot before the merge, so the merged mesh samples six pictures out of one image. The
pages are deterministic (no clock, no randomness), resolution-independent (every length a fraction of
the slot) and finite (every reading clamped or wrapped before it becomes a coordinate).

**Why the 3D attitude ball came out.** It was built when the screens were dark rectangles, and it
stood a millimetre in front of the pilot's PFD. Once the PFD page drew its own horizon there were TWO
attitude indicators on that screen, the solid one in front of the drawn one, hiding most of it. The
page's attitude is held to the HUD's own numbers by `tests/render.cockpit-display-state.test.ts`
(they agree to a tenth of a degree), so what came out is the redundant one. The Cessna keeps its
ball, because that aeroplane's instrument is MECHANICAL. The Global kept its until its own screens
drew pages, and then it went too (next section).

**What the removal moved, every number read rather than accepted.** Cockpit-only meshes on the 747:
7 -> 4 (the ball's three pieces hung from the pivot that turned them, so they could not be merged
into anything). Cockpit view's draw delta: 7 -> 4, three draws fewer, and the pilot sees MORE of the
PFD rather than less. Geometry census: -600 vertices and -612 indices, which is exactly two
`solidPlate` halves of 96 triangles (288 vertices each) and a 24-vertex box of 12; the position sum
fell by 600 times the PFD's own place; the area by 0.0162 m^2; the signed volume did not move at two
decimals, because the halves are closed solids of about half a cubic centimetre. The airframe's
EXTENTS did not move at all. The perf rig is unaffected either way: it draws no aircraft at all
(`PERF_COCKPIT_RIG`).

**The atlas's resolution was measured, not argued.** The question was whether to go from 440 x 300
slots (a 1320 x 600 atlas) to 660 x 450 (1980 x 900). Both were timed in the LIVE app on this machine
(M2 Pro, WebGPU, the 747 in cockpit view, 60 interleaved samples each, one update per animation
frame, the texture bound to the screens and proven live before and after every sample):

| atlas | draw six pages | `getImageData` | `RawTexture.update` | total, median | p90 | at 15 Hz |
| --- | --- | --- | --- | --- | --- | --- |
| 1320 x 600 (now) | 0.3 ms | 2.0 ms | 1.0 ms | **3.3 ms** | 3.5 ms | 50 ms/s |
| 1980 x 900 | 0.3 ms | 3.7 ms | 0.2 ms | **4.2 ms** | 4.6 ms | 63 ms/s |

**The decision is to stay at 1320 x 600**, on the rule the PM set (1.5 ms an update) and on a second
measurement that says the extra pixels would not be seen: at the viewport these frames were taken on
(canvas 1244 x 933 device pixels) the pilot's PFD occupies 252 x 177 of them, so a 440 x 300 slot is
already oversampled by about 1.7x. Two 4x crops of the PFD at the two atlas sizes, same state, same
camera, differ only in the crispness of a few tick marks. The crossover is arithmetic: 440 x 300
starts to UNDER-sample when the canvas is about 2,170 px wide, so a full-screen 4K player (PFD about
778 x 546) would see the difference. That is a reason to revisit it with the cost fixed, not a reason
to pay 0.9 ms more an update today.

**The cost is dominated by a readback, and that is structural for now.** `getImageData` is 2.0 of the
3.3 ms and exists only because the bytes have to reach the GPU through a `RawTexture`. The direct
canvas upload would delete it, and this engine build has neither `createDynamicTexture` nor
`updateDynamicTexture` (both measured `undefined` on the live `WebGPUEngine`); importing the
extension that adds them broke the app's startup outright when it was tried. Registered, not fixed.

**The measurement trap, because the first run of it was wrong.** The first timings used two textures
created for the probe and bound to nothing. Something in the app disposed them after the first round,
and a disposed `RawTexture.update` costs 0.13 ms -- five times FASTER than the smaller atlas, which is
how the contradiction announced itself. A disposed texture's upload looks exactly like a fast one. The
numbers above come from textures that were bound to the screens (so the frame visibly showed what was
uploaded) and whose internal texture was asserted non-null on both sides of every sample.

## The Global's screens draw pages too, and its ball came out

**One mechanism, two decks.** What was per-aeroplane in `displayAtlas.ts` -- which screens there are
in build order, what page each shows, how many across the atlas is -- is a `DisplayLayout` now:
`AIRLINER_DISPLAYS` (six, three across) and `BIZJET_DISPLAYS` (four, two across). Everything else is
shared: the canvas, the `RawTexture`, the upload, the emissive material, the 15 Hz counter, the UV
remap by NORMAL before the merge. The slot shape is shared because it MEASURED the same: all four of
the Global's built screen boxes are 0.2200 x 0.1500 x 0.0030, aspect 1.4667, exactly the 747's. (The
engineer had remembered them as 0.20 x 0.14 and said so to the PM; the built mesh settled it.) So the
Global's atlas is two 440 x 300 slots across and two down, 880 x 600.

**Pages: a PFD outboard and a map inboard for each seat, and no EICAS.** The built panel is two
mirrored pairs with no engine screen, and the EICAS page prints the literal text "N1" beside its dials
while this aeroplane's engine readout in this game is N2 (`catalogue.ts`). An engine page here would
print a label the game's own HUD contradicts; parameterising the page's label per airframe is a page
change, registered below. Only the PORT pair is ever seen: from the solved eye the port screens sit at
azimuth -10.8 and +10.8 (elevation -22.2) and the starboard pair at +54.9 and +61.0, outside the 75
degree frame.

**The ball went for the 747's reason, on the same kind of evidence.** Cockpit-only meshes 11 -> 8. The
seam and taper digests were re-pinned after building the Global at f9d2672 in a scratch worktree and
diffing mesh by mesh, positions and indices as the digests define them: of 99 meshes exactly three
are gone (the sky and ground halves, 288 vertices each, and the pitch bar, 24), none is new, none
changed, the other 96 bit-identical; 10,861 -> 10,261 vertices. The attitude-ball suite keeps only
the Cessna's row.

**The picture agrees with the aeroplane, measured on the rendered pixels.** In a 20 degree right bank
the PFD's drawn horizon, fitted across the middle of the ball from the frame the GPU drew (60 boundary
points, residual 0.26 px), reads -19.61 degrees in screen coordinates against a bank of +19.41 read
off the built fuselage's own starboard axis at the same instant: the same angle to 0.2 degrees, and
the sense a right bank should give. An earlier sample agreed to 0.08. The instrument's null reads were
checked, not trusted: at 27 degrees nose-down it found no horizon, and the frame shows why -- the ball
is all ground, with the -15 and -20 rungs tilted by the bank. (The -10 rung is past the disc's edge at
that pitch: the page clamps pitch at 25, so the horizon sits 0.625 of the page height below centre
and the -10 rung 0.375 of it, outside a ball of radius 0.3. An earlier draft of this paragraph said
"-10 and -20"; the review of this change caught it against the page's own arithmetic.)

**What one update costs.** Timed in the live app alongside the 747's atlas as a control, 40
interleaved samples each, textures bound and proven live on both sides of every sample:

| atlas | draw | `getImageData` | `RawTexture.update` | total, median | p90 | at 15 Hz |
| --- | --- | --- | --- | --- | --- | --- |
| 880 x 600 (Global) | 0.2 ms | 1.6 ms | 0.65 ms | **2.4 ms** | 2.9 ms | 36 ms/s |
| 1320 x 600 (747, control) | 0.3 ms | 1.9 ms | 1.0 ms | **3.15 ms** | 3.7 ms | 47 ms/s |

The control reproduces the previous day's 3.3 ms, so the Global's number is not a quieter machine.
The readback still dominates, and it does not scale down in proportion to the pixels: two-thirds of
the pixels cost 84% of the readback, so part of it is a fixed cost per call.

**A stale picture on every return to the cockpit, found by review rather than by a frame.** The
redraw counter only runs while the cockpit is in view, so on leaving it stops wherever it was, often
just after a redraw. The first entry was fine (the counter starts due); every later one waited out the
rest of its 1/15 s, and for up to three frames behind an instant camera cut the screens showed the
attitude, heading and altitude from when the pilot LAST LEFT. The 747 had the same defect since its
pages went in. The counter is now one shared `displayRedrawClock` with an `invalidate()`, which both
visuals call on the way into cockpit view (and only on the way in: entering twice without leaving does
not force a redraw).

**Tests that could not fail before now can.** The displays test runs every row for both decks. Its
UV check reads v as well as u (slots in one column share a u range, so a screen pointed at the wrong
row passed a u-only check), holds each face's top edge to its slot's top row (the orientation the
first live 747 frame got wrong), and measures each screen's aspect off the BUILT face. No two slots may
overlap, since a summed area cannot see two stacked on each other. Synthetic layouts one to three rows
deep hold the sizing rule at depths neither real deck has. A live block stands a minimal `document`
in front of one build (the only thing an aircraft build touches in `document` is `createDisplayAtlas`)
and wraps the atlas texture's `update`, so the real path -- canvas, pages, the UPLOAD, the 15 Hz
clock, the redraw on re-entry -- runs under `NullEngine`, where `RawTexture` and its `update`
measurably work. The display airframe's two constants are held to their producers: engines counted off
the built fans AND inlets (two counts, so a pattern that matched nothing cannot read as a
zero-engine aeroplane), full flap from the animation's own pose.

Twenty mutations, run with no dev server up: nineteen killed. Among them are nine that passed the whole
suite at some point before these tests existed: the atlas sized from the other deck's layout, the
redraw deleted, the 747's four engines on the Global, the upload deleted (every screen black), every
slot collapsed onto the top row, the redraw at 30 Hz, the atlas fixed at two rows deep, no redraw on
re-entry, and the pages upside down. The one survivor, the 747 at two columns instead of three, is
EQUIVALENT: six screens tile 2 x 3 and 3 x 2 alike, into the same number of pixels, and nothing
observable changes. (The same mutation on the Global, three columns for four screens, is killed: four
does not tile three across.)

**An independent review of this change**, three reviewers on correctness, test soundness and the
truth of the prose, each finding checked by a separate agent told to refute it, confirmed eleven
findings and refuted nine. Every confirmed one is fixed above or in the code comments: the re-entry
defect, the four test gaps behind the mutations just listed, a comment that said
`render.cockpit-display-state.test.ts` flies the simulator (it builds its states by hand), the ladder
rungs in the null-read frame, and five places where prose still gave the Global a ball.

**The atlas now belongs to the visual that made it (a later fix).** The atlas texture was created
against the scene and registered with nothing, so `visual.dispose()` left it behind. In one scene, five
build-and-dispose cycles held five atlases: 15.84 MB on the 747, 10.56 MB on the Global. It now goes on
`build.textures`, which `build.disposeMaterials()` frees with the paint synthesis's textures. Its canvas
is sized to zero when it goes, and after the fix the same five cycles hold nothing.

What this was NOT, measured: a leak on every aircraft switch in the app. That was first reported, and I
repeated it. But the app rebuilds the whole renderer on a switch and disposes its scene, and
`scene.dispose()` frees every texture in the scene, an orphaned `RawTexture` included. So the shipped app
never piled atlases up. The defect bit only a visual disposed while its scene lives on: the tests, and
any later in-scene aircraft swap.

## The Global rebuilt round its six-pane band (K0, K1, K2)

The Global's flight deck was a raked glass slab across the nose and a slab each side, and its kit hung off
them: the overhead under the slab's top edge, two free struts at +-34 degrees, a sill at y 0.52. The plane
engineer replaced them with the type's six panes. They are laid out on the body by station aft of the nose
tip and by angle round the section, read off the brochure's top view, and cast onto the skin from R
(11.90, 0.78, 0) (phase 3b, docs/findings/GLOBAL_LIVERY.md). The centre post is cast the same way and hidden
from the seat. Nothing the old kit hung off exists any more, so the kit is rebuilt, parametric on the glass,
and it has now stood on five noses without an edit.

**K0 found the nose, not the eye, was the constraint.** On the first cast nose (c252859) the windshield was a
slot about 15 degrees tall from any seat eye: it lay nearly flat, rising 0.16 m over 0.53 m at the post.
Part 2 lowered the crown for a SEATED eye at 0.55 (1.21 m over the -0.66 floor), and every written target was
met there. The one that had not been written down was down-vision. A flight deck you can land from sees the
aim point on final, 6 to 8 degrees under the body axis (the type's design eye sees 15 to 17 down), and the
glass reached 1.15 under the horizon. Part 3 dropped the tip and the crown. Its K2 frames showed the
windshield's top falling from +14 outboard to +1.3 at the post, a post only 0.30 m tall on the skin, and the
right-hand windshield under the horizon. Part 4 raised the roof on a silhouette that turned out to have been
traced along a reflection band 0.12 to 0.20 m low. Part 5 (eeb1606) put the crown on the corrected line.

**The eye, (11.90, 0.55, -0.52), on part 5's glass** (through the pane's hole in the skin):
- the port windshield runs -10.65..+26.70 straight ahead (37.35 degrees; its outer face -10.20..+27.25, the
  plane engineer's table reproduced byte for byte);
- straight ahead is inside the glass, and the down-vision is past -10;
- both windshields' tops stand over the horizon at the post (+13.38 and +12.39; +27.31 outboard);
- the centre post rises 0.51 m on the skin, its head reads +12.89, and the whole post is in the 16:9 frame;
- there is 0.51 m of skin over the eye.
The seats are placed from the eye (bizjetSeats.ts).

**The frame is a lining cast on the panes' own lines.** Seventeen `skinPanel` strips, cast from R with the
glass's own caster onto the same fuselage triangles. Every edge point comes from the same `outlinePoint` the
glass is cast through, at the panes' own grid fractions:
- the MEMBERS between neighbouring panes: the centre post (between the windshields' inboard edges), the
  windshield / side pillar, the mid post, and 0.10 m of aft end;
- a SILL under every pane and member, and a CROWN over each, straight down (up) in R's elevation to -40
  (+60).
So a lining edge that meets a pane IS that pane's edge, and neighbouring strips share whole columns: no
T-junction. It is 2 cm deep (0.008 out, 0.012 in), the 747's K3 depth. From the seat the windshield / side
pillar reads 8.0 to 9.5 degrees wide, which is the type's ~0.1 m member at 0.7 m; 0.6 to 0.9 of that is
side face.

**A sill cap along the side panes' bottom edges.** From the seat, the wall under the forward side pane is a
large flat area. It is lining, not a missing window: at az -30 the pane's glass ends a few degrees under the
horizon. So a ledge runs the whole top row of each side sill:
- 0.05 m inboard and 0.02 m deep, level with the pane's bottom edge;
- its outboard row IS the sill's top row on the lining's inner face, bit for bit;
- it covers no glass: from above, its inboard edge reads lower than the pane's.
In the frame it reads as a lit ledge 1.4 to 1.7 degrees tall.

**The lip, this type's rule: the highest straight lip that covers no glass.** The windshield's bottom edge is
not level from the seat, so no straight lip can sit within a degree of it all along, the way the 747's does.
This one meets the glass where the edge is lowest, and the sill, window frame on the interior material, fills
the rest.
- The rule: a line along z at the face reads tan(el) = (y - eye) cos(az) / d, and a glass point reads its own
  slope (p.y - eye) / (p.x - eye) in the same form. So the highest clear lip is the LEAST slope, closed form
  (`highestClearLip`), checked against K0's own bisection on elevations.
- The span: post to post, ending at the windshield's pillars. Out to the shell, a lower lip is also a wider
  one, and on part 3's nose the side panes' low inboard corners half a metre off then held it down (11.49
  against 3.96).
- The value: on part 5's built sills' rims it reads **10.880**, the catalogue's deck line 10.88, near the old
  Global kit's 10.00 and within the other decks' 8.3 to 18.6. The skin-level edge gives 11.182; the rim stands
  0.3 degree higher. It is held by the windshield's bottom at the post end.
- The face grows with the deck line: max(0.02, 0.08 tan(deck + 3)). At a fixed 0.02 the wedge's top fell 14
  degrees, and a sweep of the catalogue's value for the HUD found its forward corner showing over the lip past
  a 14 degree deck line (15 read 14.89). (The wedge is gone since P1a, below: a rounded edge on the same line.)
- The HUD fits over deck lines from 2.31 to 15 on all five window shapes.

**The screens** hang 1.5 degrees under the lip's underside, the pilot's pair on the eye's own z. 76.2% of
each is in the 16:9 frame (the floor is 35%), and the outboard one clears the skin by 0.31 m. (Since P1a they
hang under the deck's edge on a leaned face, 71.4%: below.)

**What the tests hold** (tests/render.cockpit-bizjet.test.ts, 34):
- the corner table, read off the built panes at test time, not copied;
- the targets, in one block;
- culling calibrated on the lip's wedge before any ray is believed (the fuselage is DRAWN from inside and
  culled);
- no shell face drawn toward the pilot inside the body, with a reversed-winding control;
- the whole frame cast: no hidden skin shows, and no lining footprint lies over a pane;
- the seams; the members' rays; the sill caps;
- the lip rule against the built sills, the lip's span, and its face;
- the deck line by the HUD's instrument (10.8801) and by ray;
- the screens in the frame, and the clearance from the built skin;
- the pillar reading thin.
Thirteen mutations, each caught by a named test: the eye back at 0.78, a pillar 2 degrees off its edge, a
plate inside out, a display slot moved, the lining at 0.10 m, the lip left at 10.00, the lip out to the
shell, no centre sill, the crowns a degree above the glass, no post strip, the screens hung from the lip's
top, the caps not built, and the wedge's face fixed at 0.02.
Two of them survived part 5's first run, each for a reason, and were pinned directly:
- the lip span: part 5's higher side panes put no glass under a wider lip either;
- the face rule: at 10.88 its own answer IS 0.02.

**Instruments the noses read wrong, and why.** None was a defect of the kit.
- A seam test must judge SEAMS. With R 0.14 m under part 3's roof, the crowns' free top rows converge
  overhead, and two passed within 7.6 mm without meeting.
- From a high eye the drooped nose's outside shows through the windshield. That is the world, not an end cap,
  so the test counts only shell faces met before the ray leaves the body.
- A quad's diagonal does not mirror, and on a steep nose a corner stands 9.3 mm off its mirror image.
- Part 4 and part 5 run the crown straight from the post's foot, which leaves a shallow concave crease under
  the windshield, and a lining chord across it stands up to 5 mm OUTSIDE the skin. The skin is culled from
  inside, so it still covers the view, and a lining hit counts within the lining's own 8 mm proud. (A first
  map of that crease reported 897 open rays: it had left out the lining's rims. Single rays traced by hand
  settled it.)
- The pillar test sampled fixed elevations, and on part 4 there is no pillar at -8. It now reads a quarter,
  half and three quarters up the pillar's own height.

**K2, the frames** (part 5; the pilot's left seat, 16:9, the sim paused, one world seed). Every frame
asserted, from the live scene: the eye at the catalogue's (11.90, 0.55, -0.52) to the millimetre; the lens 75
degrees horizontal-fixed; the lip's top at the kit's own height (0.4251); the kit's four meshes visible from
the seat and none from the chase camera.
- Level: it reads as a flight deck. A big windshield from about -10 to +27 degrees, terrain ahead and below
  it, the post a dark band at az +20 to +31 with the starboard windshield beyond, and the windshield / side
  pillar at left. The ceiling runs across the top, then the lip, and both displays about three-quarters in
  the frame. At far left, the forward side pane with the sill cap's lit ledge along its bottom.
- Rolled right (23.9 read; the roll ran on past 20 before the pause).
- On final, by a served rewrite of the airborne start alone (1.9 km short of the threshold; nothing in the
  tree), in scenic mode with the wings level (2.95). The capture refuses a frame with more than 5 degrees of
  bank (it did once, at 5.5) or with the kit over the aim point. The aim point reads -4.86 under the body axis
  and is in the glass. Its height assumed the spawn's 120 m; the hold had climbed to 168 m, so the true aim
  point is about 1.5 degrees lower, still 4 degrees above the windshield's bottom straight ahead. The frame
  shows grass at the computed point, not the runway.
- The 4x crops of the post and the pillar are an even face, with no hairline or seam.
- The chase frame has no kit in it.

**Parts 6 and 6b, the V over the windshield (49916b4, then cc16f33's filleted V; re-pinned on
jazonshou/global-nose-repin).** The plane engineer's V drops the windshield's bottom edge outboard. On part 6 the
sill's rim read -14.77 at az -12, and 6b's fillet raised it to -11.93.
- **The deck line stays 10.88.** The highest straight lip that hides no glass read 15.085 on part 6, which would
  have left the pilot's screens at 38%; on 6b it reads 12.184. So the glareshield hides the V's low outboard
  corner, as a real glareshield hides a windshield's lower corners. On 6b it hides 0.00 degree straight ahead and
  1.30 at most (az -12), pinned at 0.3 and 1.6. Part 6 read 0.52 and 4.21 and was pinned at 0.6 and 4.3.
- **The pilot sees down to -10.50 straight ahead,** the glass's own rim (the pin is -10). The aim point on final is
  clear.
- **The lip and the board end 5 cm inside the shell AS BUILT,** measured by the caster the glass was cast with, at
  the lip's top and underside along the wedge. That is half-width 0.776, 1.3 cm inboard of the pillars' feet. The
  pillar's lining covers the rest, and the whole-frame test finds no hidden skin showing.
  - The section functions describe the loft's rings. On 6b the facets stand up to 4 mm inside them, more than a
    margin can be trusted to within, so a span read off `globalSectionHalfWidth` came to 4.4 cm of the built shell.
- **The lining's post takes the V's ridge as a column,** as the glass post does. A chord from edge to edge runs up
  to 2.4 cm under the ridge. That is more than the seam test's centimetre, so a strip that left the ridge out would
  part from its neighbour with no vertex near enough to be judged; the ridge and the post's shared foot and head
  are pinned directly.
- **K0 from the seated eye on 6b, at the skin's hole:**
  - windshield tops 12.06 at the post, 18.56 outboard, 11.17 starboard at the post;
  - post head 11.62 (the goal is 10), rising 0.404 m on the skin;
  - pillar 8.10 to 9.67 degrees wide, its side face 0.62 to 0.74;
  - the screens 76.2% in the frame;
  - one reveal ray; the lining at least 10 mm inside the skin.
- **Eight mutations, all caught:** the lip a degree higher; the old rule's 15.09 (by the screens' 65%); the ridge
  dropped from the post, from everything, or from the crown alone; the old 1 cm margin; the shell read from the
  section function instead of the built facets; the lip out to the pillars regardless.

## The Cessna's centre frame ends in structure, at both ends

**What was wrong.** `windscreen-center-frame` is an exterior strut up the middle of the Cessna's
windscreen. Its top stopped at (2.0, 0.21, 0), 0.38 m short of the cabin roof, whose panel reaches only
x 1.62; between them the glass crown is flat. From the pilot's seat the top first read as a flat end
disc lit against the sky, then (after the taper, bd5d947) as a spike ending in the sky. The foot had the
same fault, found by this change's own survey rather than by eye: the design foot stands 8 to 49 mm
ABOVE the cowl deck (the deck under it is y -0.047..-0.050), so the bottom ring floated and its end disc
faced forward and down at anyone ahead of the aeroplane.

**Measured before building, and neither briefed option survived it.** A ray survey of the player's
75-degree frame (0.5 degree cells, 14,008 in the frame; the canopy hidden as the cockpit camera hides
it; back faces culled by the measured convention). The cabin is low over the pilot: the eye is at
(1.38, 0.12, -0.26), under the roof, and the glass crown at the windscreen top is 7 cm above it and
0.67 m from it, +5.9 degrees. Any roof edge at the windscreen top therefore lands just above the horizon.

| option | cells | share of frame | against the 44-cell apex | within +-15 deg of dead ahead |
| --- | --- | --- | --- | --- |
| run the roof forward to x 2.03 | 1,750 | 12.5% | 40x | 935 |
| a header bow across the windscreen top | 446 | 3.2% | 10x | 187 |
| **the frame turns aft along the crown into the roof** | **276** | **2.0%** | **6x** | **0** |
| the same at half radius | 143 | 1.0% | 3x | 0 |

The third is built: all of its cost is in the upper right, where the strut was already going, and it
turns the strut into one member that meets the roof. As built it costs 278 cells, 277 of which were sky.
Half radius was cheaper but would have read as a wire stepping off a strut.

**How it is built.** Three primitives merged under the frame's own name:
- the bar from under the deck to the corner;
- a ball at the corner;
- a bar aft to x 1.60, 2 cm inside the roof's front edge and within its thickness (the slab is
  y 0.18..0.23, the bar 0.181..0.229). It runs half sunk in the glass crown, which passes through it.

The bars' axes bend 42 degrees at the corner.

The foot runs 0.10 m past the design foot along the axis, the way the 747's seam post runs into its
overhead. Measured as the bottom ring's least cover under the deck: 0.082 m only just gets it under
(0.9 mm), 0.089 m is the least for the 5 mm the test asks, and 0.10 m gives 11.8 mm.

**The ball is 3% over the bars' radius, with sixteen segments, and both are measured.** At the bars'
own radius the bars' octagonal end rings lie ON the sphere the faceted ball is inscribed in. So 12 of the
14 distinct corner-ring positions poke out between its vertices at ANY tessellation: by 0.32 mm at eight
segments and 0.12 mm at sixteen. A 4x crop of the elbow showed that as a notch. More segments only
shrink it; radius is what closes it. At 1.03 all fourteen are inside by at least 0.60 mm, and sixteen
segments keep the knuckle round rather than faceted where it sits in the pilot's upper-right view:
1,296 triangles, still one draw.

**The roof slab was see-through at its edges, and burying the end there exposed it.** An independent
review found this; my survey had not. `build.planform` winds a slab's thin edge walls against its caps,
the same shared-builder defect as `verticalProfile`, so every wall of `trainer-cabin-roof` was back-face
culled from outside. At grazing angles the roof's edge was see-through. The crown bar's buried end showed
through it as a 1-3 px dark fleck from the orbit camera in a banked turn, near the roof's plane, and my
exterior viewpoints had all been 20 degrees or more above that plane.

The roof is now rebuilt with its winding decided by geometry: `solidPlate`'s core, split out as
`solidified()`. The refactor is exact: every other plate on all three aircraft keeps a bit-identical
digest. The roof is the same surface: the same 28 triangles over the same 16 positions, with an identical
set of position+UV pairs.

**That fix also corrects the roof's shading, and that is a visible change.** The planform's normals were
averaged across its caps and its inside-out walls, and all 16 of its vertices are on its rim. So the flat
roof was shaded like a pillow: its top face's normals were tilted 25 to 70 degrees from vertical, 46 on
average. They are now exactly vertical, top and underside.

**Exterior gate, mesh by mesh against ea63db1, positions and indices.** Two of the trainer's 70 meshes
differ:
- the roof: the same surface, rewound and flat-shaded, 16 -> 84 vertices;
- the frame: 76 -> 779 vertices, 64 -> 1,360 triangles, most of it the ball.

The other 68, the jet's 78, the Global's 96 and the 747's 93 are bit-identical. The seam and taper
digests are re-pinned on that evidence.

**Perf.** The 14 cockpit-mode shots draw no aircraft (`PERF_COCKPIT_RIG`), so nothing moves there. The
25 chase shots (of the 39; the other 14 are the cockpit shots) fly the trainer by default, and they DO move. At the chase rig's rest position (13.5 m
back, 5.1 m up, 62 degrees, 1280 x 720):
- The junction geometry changes the nearest opaque surface of only 4 of 921,600 pixels. From straight
  behind, the new bar lies in front of the strut.
- The roof is the nearest surface on 702 pixels, 412 at the full-speed 15.7 m, and all of them change
  shading with its normals.

The end-of-wave promotion absorbs both. The 25, as `PERF_CAPTURE_SHOTS` names them:
approach-500ft, slant-10km, reference-viewport, cruise-horizon, winter-noon, night, night-moonlit,
dusk-mesopic, motion-banked-turn, page-thrash-turn, cdlod-transition, cruise-sun-30,
forest-500ft-sunbehind, coast-10km-lowsun, runway-on-approach, water-25ft, hills-dusk-glint,
mountain-close, forest-line-highsun, cliff-60m, golden-hour, blue-hour, night-beacon-offset,
sunset-sunward, approach-lights-outboard. (Commit 1c79768's message says 26; that count came from a grep
that also matched the type declaration. 25 is read off the shot table itself.)

**The see-through edge, before and after, in the live app.** Rendered in one paused flight, with the
aircraft and the world frozen, by rewinding only the roof's 16 wall triangles back to the planform's
order between captures:
- A grazing view 3.5 m off the port side in the roof's plane: 3,533 pixels change between before and
  after, against a control of 0 (two "after" captures three frames apart). Before, the roof's whole port
  edge is a dark and green line through which the slab's inside and the far side show; after, it is a
  solid wall.
- At the review's own orbit pose (25.8 m, 62 degrees, 880 px wide): within 4 px of the buried end, 5
  pixels change and 0 in the control. That is the fleck, at the size the review predicted, measured
  because it is too small to see.

**Tests and mutations.** The old apex tests are replaced by the member's own claims:
- full radius right to the corner, read off the strut's OWN side triangles (a position filter at the
  corner also caught the crown bar's ring, and could not fail);
- BOTH bars' corner rings centred on the corner and inside the ball's convex facets, each ring
  separately;
- the bottom ring under the deck, cast from above and nudged 0.1 mm off the fuselage's crown seam;
- everything aft of the roof's front edge inside the slab, and every face of the slab facing out;
- the member's faces drawn from the seat, with a control that finds them culled when wound backwards;
- no end disc the nearest drawn surface from the seat or from 240 exterior viewpoints (every 30 degrees
  round, six of ten elevations within 5 degrees of the roof's plane, at 4 m and at 25 m), with a
  positive control that finds discs when only the member is in the scene.

Occluders are taken from a box round the whole cabin. A first box left out the roof's aft wall, and a
ray from dead astern travelled inside the slab to the buried end: a false alarm, and the reason the box
now takes in the whole roof.

Twelve mutations, all killed:
- an unsolidified roof;
- the strut tapered to a point inside the ball, and at half thickness (both passed the first version);
- the strut ending 1 cm short, and the crown bar starting 1 cm aft (both passed the first knuckle test);
- the foot buried 0.085 m, and not at all;
- the ball at the bars' own radius, and no ball;
- the aft end 1 cm short of the roof, and riding out of the slab's top;
- the member wound backwards.

**The review itself**: three reviewers (geometry, test soundness, truth of the prose), each finding
handed to a separate agent told to refute it. Six confirmed and seven refuted; all six are fixed above:
the see-through slab, the two vacuous tests, the bury margin, the segment claim, and +6.4 degrees
that was +5.9.

## The F-16's cockpit, phase F1: a coaming over the nose, a bare board and the HUD's frame

**What was wrong.** From the F-16's eye (2.22, 0.94, 0; the catalogue's, not moved) the old cockpit
was a tilted `jet-glare-shield` box whose top read -11 degrees straight ahead, with the panel board's
top standing above it as the silhouette at -9.3, five round dials and their needles on the board that
the box hid, and nothing of the aeroplane above the horizon. On the type the
pilot sits high under a bubble, and what frames the forward view is the HUD's combiner frame standing
on the coaming.

**What is built** (`cockpit/jetCockpit.ts`; every number held to the built mesh by
`tests/render.cockpit-jet.test.ts`):
- **The coaming**, a wedge, not a tilted box: top surface from (2.92, 0.739) to (3.50, 0.710),
  underside 0.60, plan half-width 0.38 at the near edge narrowing to 0.26 at the far edge (0.76 m across
  to 0.52), vertical sides,
  flat-shaded, closed (`solidPlate`, narrowed by `sculptSolid`). Its near edge reads -16.0 straight
  ahead, its far edge -10.19. It stays an ordinary exterior part (the dark hood seen through the
  glass from outside), never a shadow caster, on the matte glareshield material.
- **The board**, one bare box, face 1 mm ahead of the coaming's near face, from the tub's top up to 2 cm
  inside the coaming, half-width 0.355. It is the first surface nowhere in the 16:9 frame: out to
  az +-28.5 everything below -16 is the coaming's near face, and beyond that the world through the
  glass. The ten dial and needle meshes are gone.
- **The HUD frame**, the jet's one cockpit-only mesh: two uprights and a top bar, untapered rods of
  8 mm radius (16 mm across, about 20 px at 1600; at the first 12 mm they were 30 px and the frame read
  as a black doorway),
  in one vertical plane at x 3.05, the uprights at az +-6.5 and the bar at +4.5, a box containing the
  game's HUD symbology at (0, 0). No glass plate. The feet are buried 0.03 m in the coaming, and every
  rod end faces away from the eye (feet down, tops up, the bar's ends outboard), so no end disc is ever
  drawn from the seat.

**Three decisions, each moved a number the design had.**

| | design | built | why |
| --- | --- | --- | --- |
| coaming far edge | -13.0 | **-10.19** | from the eye the air-data probe's tip reads -10.41 and the radome's crown -11.23. The radome is off the cockpit camera's layer mask; the probe is not, and at -13.0 it stood 2.6 degrees clear of the coaming, a needle with nothing under it. An F-16 pilot does not see the nose. (Before this phase the old board's top hid it, at -9.3; the new edge is 0.9 degrees lower.) |
| HUD frame station | x 3.15 | **x 3.05** | the design assumed a canopy crown of 1.10 there. The built loft's is 1.088 on the centreline and 1.05 over the bar's ends, so the frame (then 12 mm rods) cleared the glass by 0.021. At 3.05, 0.1 m nearer the eye with the same angles and 8 mm rods, it clears by **0.074**, at its top corners (both the distance from each vertex to the nearest glass triangle; the test holds it at >= 0.05). |
| coaming material | the airframe's dark | **matte glareshield** (the frame's instance) | with image-based light the near-flat top caught the sky at grazing angles and read as a pale shelf; the real hood is matte from outside too. |

The coaming's silhouette across azimuth, read off its own triangles: -10.19 straight ahead, -9.99 at
its far corners (az +-11.5; a straight edge reads highest off-centre), falling along the top side edge
to -10.95 at az 15. Its highest vertex anywhere in the frame is a far corner, at -9.99. Straight ahead the window
is open from the coaming's edge to the bar's underside (-10.1 to +3.55, every ray empty), and the
uprights rise out of the coaming's top at -13.95.

**The canopy, shown against hidden, on the GPU** (one frozen pose in the air, the sim paused, the pause
dialog hidden in the capture page only). In cockpit view the glass is alpha 0.16, albedo #0A1219,
two-sided, roughness 0.03, image light 0.75, radiance and specular over alpha. It changed 587,820 of
the 1,440,000 pixels by more than 8/255, against 2,127 for two captures of the same state one second
apart and 7,242 after hiding and restoring it. What it does is a uniform tint, about 6% darker in
luminance and slightly blue (red 7-8% darker, green 6%, blue 4%): sky high
(77, 119, 156) shown against (83, 126, 163) hidden; sky near the horizon (128, 161, 183) against
(139, 171, 191); ground (104, 126, 133) against (112, 134, 139). It does not wash the sky out, so it is
not why the view "reads as sky"; the coaming's top is unchanged by it (no glass between it and the eye).

**The glareshield takes the sky's light, on all four decks.** The first F-16 frames read as a black
slab with a black doorway on it: the coaming's near face (0, 1, 1), the rods (0, 0, 0). The shared
`glareshieldMaterial` had no image-based light, so every face the sun missed rendered black -- the
747 pillar's black void again (the pillar and the post had moved to the interior material for it).
The pale shelf that material was built against was the sky REFLECTED at a grazing angle, and
`metallicF0Factor` 0 already removes every reflection (F0 and F90 both zero). So the material now
takes the sky's diffuse light at full strength (`GLARESHIELD_IMAGE_LIGHT` 1, what every other surface
gets), and the rods went from 12 mm to 8 mm radius.

Measured live, one frozen pose per deck: the sim paused, a mask for each mesh on the material made by
hiding it, and the material's image light swept on the page. Luma is out of 255, and the noise
between two frames of the same state was 0 to 5 px.

| deck, pose | surface | before (0) | after (1) |
| --- | --- | --- | --- |
| F-16, air (sun ahead) | coaming near face | 1.2 | 15.5 |
| | rods, core | 0.0 | 17.2 |
| | coaming top, sunlit | 55.2 | 60.9 (+10%) |
| F-16, air (second pose) | coaming near face | 16.0 | 25.4 |
| | rods, core | 2.1 / 6.6 | 18.9 / 21.4 |
| | coaming top, sunlit | 54.2 | 59.9 (+10%) |
| F-16, runway (final frame) | near face / rods / top | -- | 23.1 / 24.7-28.2 / 60.9 |
| 747, air | hood top | 54.5 | 60.0 (+10%) |
| | hood and dash face | 17.0-17.2 | 27.4-27.7 |
| | pillar and post | on the interior material: unchanged | |
| Global, air | glareshield top | 55.3 | 60.8 (+10%) |
| | glareshield face | 12.7 | 24.4 |
| Cessna, air | hood, whole | 38.4 | 47.1 (+23%) |

A small term, which was the first plan, is too small. On the F-16 at the first pose the near face read
1.5 at 0.1, 4.6 at 0.2, 8.2 at 0.35, 10.0 at 0.5 and 13.1 at 0.75. Past 1 the sunlit top goes over +10%:
at the second pose, 1.25 gave the near face 27.8 and the top +13%, and 1.5 gave 29.6 and +15%. The
upward faces gain about 1.7 times what the aft faces gain, because they see more sky. So at the first
pose the near face (15.5) and the rods (17.2) sit just under the ~18 wanted while the tops sit at the
+10% ceiling. The hoods still read matte and near-black from every seat, and the 747's pillars do not
move. The cockpit-mode perf shots do not see it: their rig is world-only and draws no part of the
aeroplane (`FlightRenderer.ts`). Whether a chase shot sees a hood through its glass was not measured.

**Budget.** Outside cockpit view the jet spends 174 draws (184 before: the ten dials and needles are
gone). In cockpit view the cockpit camera's layer mask drops exactly the fuselage, the radome and the
spine and adds the frame; the 54 shadow casters do not change with the view.

**The gate.** Every other jet mesh (66 of them) is where f9d2672 had it, world positions to the
micrometre and indices, mesh by mesh; the jet goes 78 meshes to 69. The seam and taper digests are
re-pinned for the jet alone.

**Known limits, recorded rather than fixed:**
- *The eye and the nose disagree.* The radome's crown reads -11.23 from this eye; on the type the
  over-the-nose line is nearer -15. A nose-loft or eye question for a later pass.
- *The 2D HUD crosses the 3D frame.* The pitch ladder is CSS and the frame is geometry, so at some window
  shapes a ladder line crosses an upright. A real combiner frame does the same; the bar stays at +4.5.
- *No side walls this pass.* At the frame's bottom corners the pilot sees the world through the glass.
  The canopy sill is the first surface nowhere in the frame: out to about az 22 it is inside the frame
  but behind the coaming, and beyond that it is below the frame's bottom (it reads -42.4 at az 90). So
  its see-through planform walls (registered from the Cessna junction) are not met here.
- *Composed for 16:10 and wider.* The lens is fixed horizontally, so a squarer window shows more below
  the coaming: at 3:2 the board's face appears as a band of the interior's grey under the coaming's
  near face (1.7% of the frame), at 4:3 5.1% and the canopy sill at the bottom corners, at 5:4 6.9%.
  At 16:9 the sill's nearest approach to the frame's bottom is 4.1 degrees (az 27.5); at 16:10, 2.0.
  Nothing locks the aspect ratio.
- *No cockpit glow at night.* The dials' markings were the F-16's only emissive cockpit part and went
  with them; nothing in its cockpit lit up at night until F2's displays (below).
- *F2's displays* go on the coaming's near face, the only part of the panel the pilot sees: the band
  y 0.638 (the frame's bottom straight ahead at 16:9) to 0.739. Built in F2 (below), standing proud
  of that face from y 0.585 to 0.735.

## The F-16's MFDs, phase F2: two square screens standing proud of the coaming's face

**Where.** The type's two MFDs, a 6-inch bezel around a 4-inch screen, on the panel under the HUD.
Here that panel is the coaming's near face at x 2.92, which from the eye is only a 10 cm band in
frame (-16.0 at its top edge, the frame's bottom at 16:9 below it). So each MFD stands PROUD of the
face on its own bezel, and the frame shows the top of it, as it shows a real pilot at this lens.

Measured before building (F2-0), and three things in the brief did not survive it:
- *The height.* A 0.15 bezel tilted 15 degrees with its bottom at y 0.595 has its top at 0.740, over
  the 0.735 ceiling. Anything above 0.739 stands proud of the coaming's top surface, from the seat
  and from outside.
- *The tilt's direction.* "Top toward the pilot" points the screen 15 degrees DOWN, away from an eye
  that looks down at it. Built instead: tilted BACK about the top edge, bottom standing 3.9 cm out
  toward the pilot. That is how a panel faces a pilot who looks down at it. Measured in 3D from the eye
  to the screen's centre at the MFDs' +-14.4 azimuth, the face's normal is 15.2 degrees off the
  sightline (cos 0.965), against 39.3 (0.774) for the top toward the pilot and 25.9 (0.900) upright.
  (The F2-0 figures, 8, 38 and 22, were in the vertical plane only.)
- *The frame's bottom at the MFDs.* The 16:9 frame is a rectangle, so its bottom is -23.35 only
  straight ahead. At the MFDs' azimuth, +-14.4, it is -22.7. Centred in its bezel, a 0.102 screen is
  57% in frame. Lifting it 6 mm within the bezel (18 mm of border above it, 30 mm below; a choice
  of this game's, since the type's bezel carries buttons on all four sides) gives 63%, against the
  60% the brief asked for.

**As built** (`cockpit/jetCockpit.ts`, `JET_MFD`):
- Bezels 0.15 square, 0.02 thick, at z +-0.17. The 0.19 between them is the UFC's, which is not built.
- The back top edge sits 1 mm off the face plane, turned back 15 degrees about it. The front top
  corner is at the 0.735 ceiling.
- Screens 0.102 square, 1 mm proud of the bezel, lifted 6 mm.
- The bezels have a dark grey of their own (`jet-mfd-bezel`, albedo 0x101010), the type's. On the
  interior grey, as first built, they read as light slabs: 79/255 against the coaming face's 20.5,
  measured live at one frozen pose. At 0x10 the lit face reads 41 (the side border 39), twice the coaming's
  face. The screens use the atlas's emissive material when there is a 2D canvas, and a flat
  instrument face under Node.
- Both meshes are cockpit-only. The kit is 3 meshes (the frame, the bezels, the screens): cockpit
  view spends +2 draws, and outside cockpit view is unchanged at 174.

Read from the eye straight down each MFD's centre line (az +-14.40), by ray on the built mesh:

| edge | elevation |
| --- | --- |
| near face above, down to | -16.22 |
| bezel top | -16.23 |
| screen top | -17.70 |
| frame's bottom, 16:9 | -22.69 |
| screen bottom | -25.62 |
| bezel bottom | -27.88 (then the board) |

**Pages.** The port screen draws the PFD and the starboard the map: the existing pages, through the
shared atlas. The atlas is 800 x 400, two square 400 x 400 slots, because a slot is the shape of its
screen. `DisplayLayout` has a per-deck slot size for this, and the 747 and the Global keep the shared
440 x 300. Their drawn atlases were digested on ac4eafe before the change (every painter call at one
flight state), and still match call for call.

The redraw is wired as the Global's: the shared 15 Hz clock, invalidated on the way into cockpit
view, a flat material headless (`displaysLive` false). The F-16 is now a third deck in the shared
display suite, so the live path covers it too: the canvas and texture are sized from its own layout,
it draws and uploads on the first cockpit frame, redraws at exactly 15 Hz, redraws at once on
coming back into the cockpit, gives the atlas back on dispose, and treats a late redraw as harmless.
Its engine count (1) is counted off the built turbine hub and inlet, and its flap travel (20) comes
from the animation's pose.

**Square pages, and the one drawing change.** The pages were laid out for 440 x 300 and draw from
the slot's own width and height, so a square does not squash them: every arc is drawn under a
transform with equal axes, held from the recorded instructions against a 1.2 x 1 stretch that the
check does catch. But the extra height crowded them. The PFD's attitude disc (radius 0.3 h, 120 px)
touched its altitude tape and came within 4 px of its airspeed tape, and its altitude and airspeed
readouts overlapped it by 8 and 4 px. The ND's +-60 degree labels' anchors were 0.8 px from the
slot's sides and their text ran past them. Two changes, each leaving 440 x 300 exactly as it was:
- ONE parameter, `pageRoundScale(w, h) = min(h, 300 w / 440)`: the height a 440 x 300 page would have
  at this width, exactly h on the other decks' slots (an exact division), 272.7 on the F-16's. It
  sizes the PFD's whole attitude instrument: disc, pitch scale, rungs and their numbers, roll scale,
  aircraft symbol.
- A third term in the ND rose's min(): the radius at which its +-60 degree labels' TEXT keeps 20 px
  from the slot's sides. It is 206.1 on 440 x 300, above the 204 in use there, and 178.2 on the
  square (with the labels' font from the page scale, below), where it binds. (Sizing the rose from the page scale as well changed nothing on any deck,
  so it is not done.)
Two things follow from those two changes: the tapes span the disc's height, so on
the square they shorten with it (y 102 to 266 instead of 64 to 304, more knots per pixel), and the
ND's rings, ticks, track line and heading pointer are drawn from the rose's radius, so they move in
with it.

**The review found three more places where h-sized text met w-sized boxes on the square**, and the
same parameter fixes them. The PFD's altitude labels (16 px from h in a 52 px tape from w) were
clipped by 14 px at 15,000 ft. The altitude readout's 24 px digits ran 17 px out of its 60 px box.
The ND's "HDG" overlapped the TAS value by 4.8 px. Every `text()` and `readoutBox()` call on the PFD
and the ND now takes `pageRoundScale` as its text size. So does the readout boxes' frame width, which
`readoutBox` takes from the same argument (2.0 to 1.36 px on the square). On 440 x 300 that
is h, and the digests still match. On the square, every piece of PFD and ND text is inside its
readout box or page on both axes, and across its scrolling tape or strip. That is held on all three
decks at five-digit altitudes. HDG clears the TAS value by at least 10 px. The rose's label-room
term uses the labels' new font, so the rose is 178.2.

**What of each page is seen.** The game has no head movement, so the rows of a page below the
frame's bottom are never seen: 0 to 250 of 400, derived from the built screen and the frame's bottom
at the MFDs' azimuth. At 0.86 h, the ND's own ship (344) and its 20 nm ring were below that. Own ship
and the rose's centre now stand at 0.86 of the page's round scale: 258 on 440 x 300, as before, and
234.5 on the square. There own ship's lowest point is at 242.5, in view, and the empty band under the
header closes. The arc's top then runs under the heading box. A label drawn there was covered only
within about 4 degrees of its own heading; further off, a fragment of it stuck out past the box's
edge, at about a quarter of all headings (a review sweep). So a rose label whose text would touch the
heading box is not drawn: the box shows the heading. On the square that leaves the top label out at
about 54% of headings. On 440 x 300 no label comes within 3 px of the box, so every label is still
drawn there (a 1-degree sweep of 360 on all three decks holds both). (0.62 h, 248, would keep that
label 4 px under the box but put own ship's base 5.6 px below the frame.) The PFD's heading strip stays below the frame; it repeats the
HUD's heading tape. So does the lower half of its vertical-speed scale, which is still sized from h
(y 84 to 284): the descent digits are never seen and the -2000 label is cut by the frame's edge. The
HUD shows V/S.

The first cut sized the disc alone. It cleared the tapes, but left the wing bars overhanging the
smaller disc by 22 px a side and the disc holding +-8.2 degrees of pitch where the other decks hold
12. So the square's attitude instrument is now the 440 x 300 one at 272.7/300 scale. In the 400 x 400
slot, from the recorded instructions:
- The disc (radius 81.8) is 34.2 px from the airspeed box, 42.2 from its tape, 30.2 from the altitude
  box and 38.2 from its tape.
- The wing bars are 10.9 px inside the disc.
- The disc holds 12.0 degrees of pitch, measured the same way on the 747's page.
- The rose (radius 178.2) keeps its +-60 degree labels' text 20.0 px ("15") and 23.3 px ("3") from the
  slot's sides, where the 747's 440 x 300 gives 21.8 and 25.4. (Text widths are taken as a monospace
  0.6 em a character, in the code and the test alike; the live atlas's glyphs are measured in F2-2.)
  Sized from the page scale alone (185.5) the labels' anchors were 20 px in but their text only 10.7
  and 15.5.
- The 747's and the Global's atlases are call-for-call identical to ac4eafe (the digests pinned before
  the change).

**The F-16's atlas is mipmapped.** Each 400-texel slot lands on about 190 screen pixels at this lens,
2.1 texels a pixel (the 747's 1.19, the Global's 1.03). Bilinear sampling at that ratio skips texels.
Measured in the live app with the sim paused and the camera shifted sideways by a fraction of a pixel,
right before it renders:

| camera shift | PFD screen, bilinear | mipmapped | ND screen, bilinear | mipmapped |
| --- | --- | --- | --- | --- |
| none (control) | 0 | 0 | 0 | 0 |
| 0.15 mm, about 1/4 px | 161 | 0 | 136 | 0 |
| 0.3 mm, about 1/2 px | 222 | 2 | 211 | 3 |
| 0.6 mm, about 1 px | 292 | 72 | 296 | 43 |

The counts are pixels of a 152 x 73 screen region whose brightness changed by more than 24 levels of 255.
Any vibration or camera motion shimmers the bilinear screens. Mipmapped (trilinear, the engine making the
chain from level 0 on each upload), the text went from dots to legible in the 4x crop. The upload's CPU
cost is the same, 0.10 ms median over about 40 uploads either way; the mip chain is made on the GPU,
which that number does not see. `DisplayLayout.mipmaps` is on for the F-16 alone; the turbofans' screens
are barely minified and stay as they were.

**Live checks (F2-2).** The attitude disc's flat sky and ground in the live atlas's readback span
162 x 162 texels, an aspect of exactly 1.00. The labels' font measures 13.25 px for "15" against the
13.2 the page and tests assume (0.6 em a character). The cockpit camera draws 71 - 3 (the skin its mask
hides) - 2 (the reheat cones, disabled) = 66 of the jet's meshes, as pinned; in the air the ten
landing-gear meshes are disabled too (gear up), 56.

## The 747 rebuilt round the re-lofted glass (K0, K1)

The plane engineer re-lofted the nose and replaced the six flat window boxes with panes CAST by angle
from R (29.9, 2.93, 0) onto the skin (docs/findings/AIRLINER_NOSE_GLAZING.md): No.1 az 2.5..24 /
el -18..+12, No.2 26..54 / -15..+10, No.3 56..75 / -12..+8, a 2 degree pillar gap at 25 and 55, a centre
post strip over +-1 in a +-2.5 gap. The old kit was placed against copied box corners, and six of its tests
went red by design. This is the kit rebuilt to the new glass, and the eye re-chosen for it.

**The eye (K0).** `scripts/airliner-eye-grid.mts` reads candidate eyes against the BUILT panes' outer faces
(the glazing table's method: a sightline through a pillar gap that grazes a rim is not glass). The targets:
0.50..0.55 m to port, where the type's seat spacing puts the captain; straight ahead in the middle third of
port No.1's azimuth run at the horizon; the post at +10..+16; No.1's opening at least 28 degrees; the glass
at least 1.4 m ahead. The chosen eye is **(29.85, 2.93, -0.50)**: No.1 -8.8..+11.6, the No.1 / No.2 pillar
-10.7..-8.9, the post +13.1..+14.8, the opening 30.4, the glass 1.90 m. It keeps the old eye's height (the
pilot's eye height is what stays when the seat moves inboard; the crown is higher there, so the headroom
grew, 0.522 -> 0.615). From the old eye (29.9, 2.93, -0.72) the pilot looked through the outboard edge of
their own No.1, the pillar 1.8..3.7 degrees left of straight ahead; that eye is the test's control. The seats
moved under the new eye (+-0.50).

**The displays decided the glareshield (K1 step 0).** The lip has to sit within a degree of No.1's bottom
edge, which from this eye reads -16.88 at its inboard end and -18.10 at its outboard end, while the 16:9
frame's bottom is -23.35 straight ahead: five degrees for the screens. With the old recipe (a hood 0.1 m aft
of the panel's face, screens 1.5 degrees under its underside) not one screen was in the frame. What
fits: the glareshield FLUSH with the face (a 0.02 m lip and nothing aft of it), the screens 0.25 degrees
under it, vertical, and the face at 0.85 m, the top of the type's range. The lip and the frame's bottom are
angles, so the band between them is the same at any distance, and a screen further away is fewer degrees
tall: 36.8% of each top-row screen is in the frame at 0.75, 43.5% at 0.85.

**The lip** reads -18.04 straight ahead: the LOWEST line along z that leaves no more than a degree of sill
between itself and No.1's outer bottom edge anywhere along it (the sill runs -0.45..+1.00; the lip covers
0.45 of glass at No.1's outboard end). Its section is a wedge whose top falls away forward at 21.8 degrees,
steeper than the 18.04 sight line over it, so nothing of it or of the board behind it shows above the lip.
A box's far top corner would stand 1.6 cm over that sight line and become the edge instead.

**The frame is a LINING cast with the glass.** Everything between, above and below the panes is one
`skinPanel` per rectangle of R's sky that is not glass, cast from R onto the same skin with the same caster
and laid at the panes' own 0.04 out and 0.06 in: under each pane a sill, over it a crown, between
neighbours a pillar as tall as the taller one, and either side of the post the gap to No.1. Nine strips, two
across the centreline and seven a side, read from `FLIGHT_DECK_PANES` rather than typed. The edges are
therefore the panes' edges at every point, and a re-loft moves the frame with the glass. The strips are
cast on ONE set of grid lines (the panes' and the post's edges, with lines no more than 5 degrees apart
between them), so that two strips meet at the same points: sampled on rows of their own, neighbours crossed
their shared seam on different chords, which part by a fraction of a millimetre, and K2's first live frame
showed hairlines of sky along the crown's seams. A test now finds no T-junction anywhere in the frame (105
with the old sampling). They are skin panels, not `solidPlate`s, because the pane edges are curves on a curved nose and a plate is flat; the
builder winds them by geometry to the same rule (the cross product into the solid), and the drawn-faces walk
reads zero culled on all four meshes at both offsets. The whole lining, sills included, is on the flight
deck's interior material (the seats') in one mesh with the board: the sill is the bottom of the window
frame, a lighter surround over the dark hood, as the type has it. The glareshield is the lip alone.

**The centre post** is the plane engineer's cast strip, and the cockpit camera draws it now: it left
`cockpitParts`, and the shell and the glazing stay there. From the eye its inner face is 2.02 m away, drawn
by the GPU's rule and shaded toward the seat; hidden, the same ray meets nothing. It is walked by the
drawn-faces test beside the kit, at zero.

**The deck line** is the lip. The merged field means the deck's highest ROW anywhere across the frame
(the 2D HUD keeps above it), measured by the HUD layout's own instrument. With the sills on the glareshield
that row was the sill under No.2's inboard corners, 15.49, while straight ahead read 17.32, and the HUD
layout's row test failed at 17.32. With the sill as frame the deck is the lip, a line along z, so one row
across the whole frame: the instrument reads 18.039 and the ray straight ahead 18.040.
`catalogue.cockpitDeckLineDegrees` records 18.04, and both the 747 test and the HUD deck-line test hold it.
Above the lip straight ahead the grey sill runs 0.72 degrees up to No.1's bottom edge (-17.32).

**A correction to K0.** The K0 report said the fuselage loft's forward end cap at x 30.80 FACES the pilot
between the eye and the glass. It is between them, and a sightline straight ahead crosses it, but it is
wound OUTWARD (it faces the nose): the test's calibrated winding says the GPU culls it from the seat. The
claim came from a ray cast, which meets a face whichever way it faces. The shell stays hidden from the
cockpit camera either way.

| quantity (from the eye, 16:9, 75 degrees) | target | measured |
| --- | --- | --- |
| No.1 at the horizon / pillar / post | ahead in the middle third / - / +10..+16 | -8.8..+11.6 / -10.7..-8.9 / +13.1..+14.8 |
| No.1's opening, glass ahead, headroom | >= 28, >= 1.4 m, the crown's | 30.4, 1.90 m, 0.615 m |
| lip straight ahead | the lowest with the sill <= 1 | -18.04 (sill -0.45..+1.00) |
| deck line (the deck's highest row; straight ahead) | catalogue +-0.02; +-0.2 | 18.039; 18.040 (catalogue 18.04) |
| PFD / ND / upper EICAS in the frame | >= 35% | 42.9% each on a 21 x 21 grid (43.5% exact) |
| lower EICAS, starboard ND and PFD | - | 0% (under the frame; beyond its right edge) |
| holes in the picture | glass only | 0 rays of skin showing, 0 of the kit over a pane's middle |
| lining, inner face / rims | inside the skin / no further out than the glass | 0.069 m inside at the tightest / 0.065 m out at the farthest |
| seams between frame pieces | no T-junction | none (105 with each strip on rows of its own) |
| board and lip against the outer skin | >= 0.01 m | 0.160 m |

**Cost.** Still four cockpit-only meshes; the cockpit camera draws 91 of the airframe's meshes where it
drew 90 (the post); the exterior camera's 89 did not move. The airframe grew by 2,522 vertices and 7,128
indices (the lining's 2,692 and the lip's 24, less the overhead, hood, dash, pillar and seam post), and
building it costs a few milliseconds at most: NullEngine medians of 15 builds read 48 to 53 ms across runs,
against the base's 48. The 747's and the
Global's display atlases draw call for call as they did: the slots and pages are unchanged, and only the
screens' places moved.

**Retired:** `scripts/airliner-eye-solve.mts` and `scripts/airliner-cockpit-clearance.mts`, which solved
and measured against the flat window boxes. The grid above replaces the first; the second's numbers are
printed by `tests/render.cockpit-airliner.test.ts`, which holds them.

## The 747's window frames thinned (K3)

Jason, on K2's frame: the window frames "look thick" and "bulky, low quality". Measured from the eye (0.01
degree steps along each member at el -8, 0 and +4, each ray's first drawn triangle classed by where
`skinPanel` wrote it as the inner face, the side faces (the rims) or the outer face):

| member (from the eye) | physical face | as built in K1/K2 | of it, side faces | the type (PM) |
| --- | --- | --- | --- | --- |
| port No.1 / No.2 pillar, az -9, 1.77 m | 6.5 cm | 3.65 / 3.83 / 4.00 | 1.80 / 1.89 / 2.19 | ~15 cm, 4.5 |
| centre post and its gaps, az 14, 2.02 m | 16.3 cm (post 6.5 + 2 x 4.9) | 5.44 / 5.49 / 5.51 | 0.9 - 1.1 | ~12 cm, 3.6 |
| starboard No.1 / No.2 pillar, az 36, 2.13 m | 6.6 cm | 1.8 - 1.9 | 0.05 - 0.12 | |

The pillars were never wide: they are less than half the type's width. What read as bulk was the lining's
depth. As the glass's own 0.10 m slab, its side faces showed down each pillar as a second, lit tone, half
the pillar's apparent width. Thinner linings, measured the same way, gave the side faces a linear scale:
0.05 m deep, the pillar 2.9 degrees (side 1.0); 0.02 m, 2.3 (side 0.4).

**The PM's decision, built:** the lining is 0.02 m deep, 0.008 out of the skin and 0.012 in
(`AIRLINER_LINING.proud` and `.depth`). The pillars keep their 6.5 cm faces and read 2.23 / 2.33 / 2.38
degrees with 0.36 / 0.37 / 0.44 of side; a test holds them under 2.6 with under 0.5 of side.

**The centre member.** It read 4.76 with the thin lining, because the glazing's centre gap was +-2.5 at R.
The plane engineer narrowed it to +-`CENTRE_POST_HALF_AZIMUTH` (a shared constant) and widened their post
to fill it (1a0ec56), so the kit's gap strips retire. At 1.6 the member read 3.12 from the seat; built at
1.8, 1.9 and 2.0 it read 3.48, 3.67 and 3.85 (over the 3.8 ceiling, the lining's 0.2 of side counting), so
the constant settled at 1.9 (4251e15). Their post is the glass's 0.10 m slab, and against
the 2 cm lining it stood 4.8 cm into the cabin: K3's frames showed its top end as a lit block where it met the
crown, and a stripe of its side down its length. So it went back with the shell and the glass among the parts
the cockpit camera does not draw (the exterior camera draws it as before), and the lining covers its place, a
strip across the centreline on the lining's own lines: one tone with the pillars, no end faces, watertight
with the crown and the sill. From the eye it reads 3.69 / 3.67 / 3.66 degrees at el -8 / 0 / +4, face 3.5 and
side 0.2, against the type's 3.6 and a 3.8 ceiling; a test holds it under 3.8. The lip holds at -18.57:
pane one's bottom edge now reaches inboard to 1.9, and the sill there reads under a degree.

**What the depth moved, re-derived rather than re-pinned.** The opening the pilot sees is now the thin
lining's, so the bottom of the view over No.1 is the sill's own top edge, 0.008 out of the skin, not the
hidden glass's outer face at 0.04: it reads -17.41 (inboard) to -18.66 (outboard) where the glass's read
-16.88 to -18.10. The lip, solved against it by the same rule (the lowest line leaving no more than a
degree of sill), drops from -18.04 to -18.57; the sill runs -0.45 to 0.99. The top row of screens,
hanging 0.25 degrees under it, is 37.8% in the frame where it was 43.5% (a panel at 0.75 m would give
31.7%). The deck line is the lip, one row across the frame: 18.5688 by the HUD layout's instrument,
18.570 by ray; the catalogue records 18.57, and both HUD tests pass with their files unchanged. The
whole-frame test now classes a sightline as glass when it crosses a pane's hole in the SKIN (its grid at
skin level), and allows half a degree at an edge, where the rim reads widest (No.2's top, 1.3 m away and
seen at a slant). The no-T-junction test and the drawn-faces walk stay at zero.

## The Global's panel, integrated (P0, P1a)

Jason: the instrumentation read as a box pasted at the bottom of the screen. P0 measured why, from the seat,
on the merged kit (6638484) and its level frame. Each tone sample was a pixel projected from a built point
and confirmed by ray to be that part; the projection matched the live capture to 0.2 px.
- **It was the geometry, not a flat tone.** The board was a vertical slab (0 degrees of lean). A 1.7 degree
  band of lip sat flush on it, with no step, rail or shadow. The board's own gradient, top to bottom, was
  19.4% of its mean, so it was not a flat-luma rectangle.
- **The bezels were the brightest thing low in the frame:** luma 81 against the board's 28 to 32. They were
  square rims around screens that stood 1 mm PROUD of them.
- **At the left the board just stopped,** at az -22.8, against 14.7 degrees of flat wall lining.
- **The 747's board** (K3's frame) is the same kind of object: vertical and flush, and the bezels read 164
  against its 54. Their marking is emissive at 0.7 against the Global's 0.175.

**P1a, the deck as the pilot reads it, top to bottom** (`bizjetGlareshieldSection`, `bizjetPanelFace`). A first
build (7dc8801) was revised on the PM's decisions; both are recorded.
- **The glareshield's ROUNDED aft edge,** r 0.0125. The deck line's sight line is tangent to it, and the tangent
  is a vertex, so the silhouette is the catalogue's 10.88 exactly: one row of the picture, with the rule, the
  HUD and the whole-frame glass test unchanged. Its upper side faces the sky.
- **The aft face,** dropping 0.005 under the round.
- **A 45 degree COVE,** 0.010 forward and 0.010 down, facing down and aft, to the panel's face. The first build
  had a flat underside (normal -y) running 0.03 forward. That was 0.16 m under the eye and never seen from the
  seat. The cove is seen: its normal leans toward the eye at every corner, and it faces the image light's lower
  half. It is the shade under a glareshield, from geometry alone. Its tone is measured in the level frame.
- **The deck's edge,** from the tangent to the cove's foot, reads **2.342 degrees** straight ahead (the round
  1.28, the drop 0.42, the cove 0.64) against the design's ceiling of 2.5. The first build's round r 0.02 and
  0.015 drop made it 3.3.
- **The hood** falls forward at 12 degrees for 0.18 m. That is steeper than the 10.88 degree sight line, so
  none of it shows. Its underside falls with it from the cove's foot, one plate of constant thickness, so the
  solid stays convex. At these radii a flat underside would leave the hood -7.8 mm thick, which is refused at
  build.
- **The board's face, leaned back 15 degrees** about its top edge at the cove's foot. The type's panel is
  fairly upright. Its normal is 5.40 degrees off the eye from the centre of the pilot's pair of screens (the
  bound is 8) and 11.6 from each screen's own centre. The design first asked for 12 degrees "so the normal
  points at the eye within 3": the pair's centre is about 20.4 degrees under the eye, so no lean near 12 can
  do that. The first build aimed it exactly at 21.9, which reads like a laptop's screen; that stays a
  documented one-constant alternative. The lean pivots at the top, so the foot swings aft (still below the
  frame) and the cove meets the face.

**What the pilot sees now:** under the round's lit rim, a dark aft face and the cove, then the board. The
screens ride the face, their top edge 0.8 degree under the cove's foot. **71.4%** of each is in the frame by the
test's ray grid (the design asks 65%; the first build's 61.9% missed it). Every kit vertex clears the skin by
0.19 m or more.

**Tests** (tests/render.cockpit-bizjet.test.ts, 39): the round on the sight line at deck lines 5, 10.88 and 11.5;
the hood's top and underside falling together; the PM's ranges written out, with the deck's edge at most 2.5; the
cove by its built normals, facing the eye, and by ray; the board square to the leaned normal; the screens square
to the face, 1 mm into the board and 1 mm proud of their bezels, and at least 65% in the frame; the aim at most 8
degrees, with an upright-board control. The two loft digests are re-pinned. Mesh by mesh against 6638484, only
the four kit meshes changed (the glareshield from 8 to 52 triangles).

Sixteen mutations, all caught:
- the PM's three: lean 0; the cove flattened; the hood sloping up (refused at build by a guard, and, with the
  guard removed, caught by eight tests, both glass tests among them);
- thirteen more: the edge too tall; the tangent not a vertex; the board, the screens and the bezels each left
  unturned; the board turned the wrong way; the round on the wrong side of the line; the screens hung from the
  round; the 21.9 alternative; the old 1.5 degree gap; the old round; the cove at 30 degrees; the hood's
  underside flat.

One instrument lied on the way: a corner finder at 1e-9 found all four float32 corners of a screen at one lean
and two at another. It works at 2 micrometres, and a sweep of the lean fails only the aim test.

**Measured next, in the level frame:** the cove's tone against the board 10 cm lower, as a number with no
threshold. If it does not read as shade, an AO gradient in a board-only albedo on the board's existing UV is
the reserve (no new varying).

**P1b, the bezels.** In P0 they were square pale plates (luma 81, against the board's 28) under screens standing
1 mm PROUD of them. Each is now a frame round its screen (`bizjetScreenStack`, `bizjetBezelFacets`), square to the
leaned face:
- **The stack:** the frame's back is 1 mm inside the board and its front 6 mm out. A 4 mm chamfer at 45 degrees
  runs round its outer edge, down to 2 mm out.
- **The opening** is the screen plus a 2 mm gap each side. The screen is a 0.5 mm plate whose face stands
  **3 mm behind** the frame's front.
- **Behind the gap,** a well on the instrument face's near-black. From 10 to 20 degrees off the face, the screen's
  own edge hides the far side's gap, as a recessed screen's does; the near side and the top show.

**Materials.** The frame is on a Global-only bezel material, 0x2c3034, with the board's roughness and metalness and
NO emissive. By albedo alone it is 1.41 times the board's luma; the design asks 1.3 to 1.6, measured in the next
frames. The chamfered rim stays on the shared marking material, so the night glow (`applyGlow`) is the rim's alone.
The display material is untouched: the recess is geometry, so the display gains no varying.

**Two closed solids.** The frame (the ring from the opening to the chamfer's shoulder) and the rim (the band from
the shoulder to the edge) are each closed on their own. The drawn-faces test walks each mesh alone: a frame left
open where the rim covers it showed rays meeting its inside faces. They are built by a new primitive, `facetMesh`:
flat quads wound by a given outward normal, for a solid no centroid rule can wind (a frame's centroid is in its
hole).

**The count.** The kit is six meshes: the glareshield, the interior, the screens, the frames, the rims and the
wells. That is two more draws than P1a; the pages and their digests are unchanged. Against 92ef8e9, the screens
and the frames change, the rims and wells are new, and the other 89 meshes are bit-identical.

**Tests** (41): the frame's size and opening; the stack's planes, to a hundredth of a millimetre; the chamfer by its
built normals (45 degrees, all four sides, 4 mm across); by ray, the recess (3 mm), the gap (the well) and the
frame's face; the materials (no emissive on the frame, the glow on the rim, the albedo ratio).

Eleven mutations, all caught:
- the PM's four: no chamfer, the screen proud, the frame on the old marking material, emissive on the frame;
- seven more: no gap, the frame as light as the old bezel or as dark as the board, the chamfer at 30 degrees, the
  frame left open under the rim, `facetMesh`'s winding reversed, no wells.

One instrument was stale in the test file: its `partOf` counted every bezel as a 12-triangle box.

**On the V (P1a and P1b carried onto 7766139).** The deck's full width is sized where it stands, at the round, the
cove and the board's top back corner. There it reaches the windshield's pillars, with 9 cm of shell to spare.
- **The hood is TAPERED in plan** (`bizjetHoodTaper`, by `sculptSolid`, the F-16 coaming's way). It keeps 5 cm inside
  the V's shell as built at every station, from 0.789 at the cove to 0.745 at its forward end. It cannot be seen from
  the seat.
- **Why the taper and the carry-over are one commit.** An untapered hood cannot be both inside the skin and wide: sized
  over the hood's depth, the whole deck narrows to 0.705 m and the outboard screen hangs past the board's end.
- **The pillars' feet are CAST** from R onto the skin, as the glass and the pillar's lining are. The outline's own
  point stands 4.5 mm outboard of the facets it is cast onto, and the deck had run 2.5 mm past the glass's pillar.
- **Tests** (43): a named taper test (the aft part at the deck's width, the forward end drawn in, every vertex 5 cm
  inside the shell at its own station).
- **Mutations, ten, all caught:** no taper; the whole glareshield narrowed to the hood's end; the taper with no margin;
  the pillar foot from the outline; the deck sized over the hood; and one each of P1a's, P1b's and the re-pin's.

**P1c, the side consoles** (`bizjetSideConsoleFacets`), one each side.
- **An armrest-height console would stand wholly under the frame.** The wall it was for is 0.5 to 0.7 m ahead,
  where the frame's bottom is 0.28 m under the eye: at eye - 0.45 it covered 0% of the wall. So each console's top
  is the sill cap's, widened: level with the side pane's bottom edge (it covers no glass, by the cap's own rule),
  from the cap's inboard edge to the board's end, which it meets flush.
- **The cap's inboard edge IS the console's top edge,** vertex for vertex, on the cap's own columns: no T-junction.
- **A 2 cm lip runs along its inboard top edge,** over a 45 degree cove, with the face set back under it (the rail's
  idea). The face runs down to the board's foot, and the outboard side follows the shell down from the cap, 5 cm
  inside it.
- **It runs aft to x 11.85.** The seat's base stands inboard of its face.

**6b moved the goal.** The 21 degrees of wall was part 5's nose. On 6b the forward side pane comes down to -16 to
-18 degrees in those columns, and under its sill band and its cap only 1.3 to 4.5 degrees of wall was left. The
console takes all of that: with it, the bare wall is 0.4 to 1.3 degrees a column (the sill's band between the
glass and the cap), against 2.5 to 5.7 without. In the frame it reads as a lit ledge under the cap.

**Two traps on the way:**
- The console's section is not convex (the lip overhangs the set-back face), so no centroid gives every face's
  outside. It is taken from the section's own winding, and the drawn-faces test caught the first build's culled
  coves.
- A rule that never engages on this nose (the outboard side following a shell narrower below) survived its
  mutation as an equivalent, and is pinned on a shell given to it.

**Tests** (48): the wall under the cap, per column, with a no-console control; the seam on the caps; the lip and
the cove by the built normals; no glass covered; inside the skin (0.064 m at the tightest); the seats clear; the
shell rule. Seven mutations, all caught:
- the top at armrest height; the face 10 cm outboard; the console removed;
- off the cap's vertices; no lip; the faces oriented by a centroid; the outboard side not following the shell.

The kit is seven meshes. Against 43d360d only the new consoles mesh changes; the other 93 are bit-identical.

**For the 747's turn (noted, not built):** its lip-to-bottom band is only 4.78 degrees with the screens at
37.8%, so the same deck must cost the screens nothing: the round and the drop at their minimum, and the gap
0.5 degree. Its bezels need a material of their own: dark, 1.3 to 1.6 times the board by day, with the night
glow on the rim only. The marking material they use now is shared with the panel's labels.

## Not done, and one thing to know

**The Global's perf-rig eye.** The perf harness puts the eye on the centreline,
which puts the Global's centre post dead ahead (a bar 18% of the frame at the top
and 12% at the hood, azimuth +-5.2), so a Global cockpit perf shot would need a
lateral eye. The 14 cockpit-mode perf shots fly the trainer, so nothing is
affected today. Their foreground is now the new panel, dials, hood, cowl stand-in
and posts on top of the hidden tube, with lens and eye still pinned, so any
baseline comparison of those shots sees a foreground change and no framing
change.

**The 2D HUD sits on the upper EICAS.** In cockpit view the game's own "ACTUAL" thrust and trim box
is drawn over the right-hand screen's upper half. Both are correct on their own; nothing has decided
which gives way in cockpit view. Registered for the PM, not changed here.

**For the plane engineer's register, from the Cessna junction:** `build.planform` winds its edge walls
against its caps, as `verticalProfile` does, so a planform's walls are culled from outside and its edge
is see-through at grazing angles. The Cessna's roof is fixed here with `solidified()`. The F-16's three
planforms (`jetVisual.ts`: the canopy sill, the shelves, the panels) are built the same way and were not
touched. The F-16's sill is never seen from the seat (behind the coaming out to about az 22, below
the frame beyond), so phase F1 did not meet it; side walls would.

**For the register, from the displays' own measurements:** the engine page's label should come from
the airframe (N1 on the 747, N2 on the Global and the F-16, RPM on the Cessna) before an engine page
goes on any aeroplane but the 747 -- a page change; the atlas upload pays a CPU readback (1.6 ms on the
Global, 1.9 on the 747) that a direct canvas upload would delete, if an engine extension can be
imported without breaking startup; and a 4K player would out-resolve the 440 x 300 slot (the
crossover is a canvas about 2,170 px wide).

**Not built:** the F-16's UFC, between the MFDs.
Baselines are not promoted here; the single end-of-wave promotion absorbs the change.

**Built in P1c (above), once the Global's next kit item: an armrest / side console.** From the seat, the wall under the
forward side pane runs 15 to 18 degrees from the pane's bottom edge (about -3 at az -24) down to the frame's
bottom (-21.5 at az -24, -18.9 at the corner). The sill cap breaks the glass-to-wall edge with a ledge 1.4
to 1.7 degrees tall; the rest is one flat tone of lining.
