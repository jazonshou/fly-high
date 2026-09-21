# The cockpit view was broken by its lens, its eye and its hidden skin

**Status: shipped on `jazonshou/cockpit-view` for the Cessna and the Global.
The 747 and the F-16 are not done.**

Jason: *"Currently, the first person/cockpit view for all aircrafts are pretty
broken. ... I want the views to look like the player is actually flying from the
cockpit."* Two decisions came back through the PM afterwards: the lens is 75
degrees (*"2 is good"*), and the instruments should move (*"3 yes"*, not built
yet: see the end).

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
`right` (metres, +starboard): trainer -0.26, Global -0.52, F-16 0, and the 747
0 until its flight deck is rebuilt (its port seat is at -0.72). The aim point
carries the same offset so the view stays parallel to the body axis.

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

The Cessna's attitude dial has no mapping: its needle stays at 12 o'clock. The
update runs inside the visual's `update()` and only while cockpit view is on (the
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

## Not done, and one thing to know

**The Global's perf-rig eye.** The perf harness puts the eye on the centreline,
which puts the Global's centre post dead ahead (a bar 18% of the frame at the top
and 12% at the hood, azimuth +-5.2), so a Global cockpit perf shot would need a
lateral eye. The 14 cockpit-mode perf shots fly the trainer, so nothing is
affected today. Their foreground is now the new panel, dials, hood, cowl stand-in
and posts on top of the hidden tube, with lens and eye still pinned, so any
baseline comparison of those shots sees a foreground change and no framing
change.

**Not built:** the 747's cockpit and the F-16's (the airliner's eye keeps
`right` 0 until its flight deck is rebuilt). The Cessna's attitude dial has no
mapping and stays static. Baselines are not promoted here; the single end-of-wave
promotion absorbs the change.
