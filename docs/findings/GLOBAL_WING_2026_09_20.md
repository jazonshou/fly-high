# The Global's flaps were not deploying, they were being wrung out

**Status: shipped on `jazonshou/global-wing`, merged to House-Keeping as
`bee956d`.**

Jason, on the Bombardier: *"A lot of the lines on the Bombardier still feel
misaligned and the wing as a whole feels a bit glitchy. Can you investigate and
fix it so that it's more accurate to the actual plane?"*

Three defects were under that note. Two were planform and fit. The third is why
it read as broken rather than as imprecise, and it was not in this aeroplane's
file at all.

## The one that mattered

`applyCommonPose` (`src/render/webgpu/aircraft/airframeRig.ts`) deflects every
control surface on every airframe by writing `rotation.z` — a rotation about
the **wing's** z axis. For an unswept hinge that is the same axis as the
surface's own. The Global's trailing edge is swept 23 degrees and it is not.

Each flap's hinge node sits at the panel's inboard end, so the panel's outboard
end lies about 2 m **aft** of the axis it was being turned about, and a 30
degree rotation drops that end by `2 sin(30)` = 1 m more than the root.

Measured on the built mesh in a `NullEngine`, paired vertex by vertex between
the flaps-0 and full-flap poses:

| | inner flap root | inner flap break |
|---|---|---|
| vertical travel | 0.634 m | **1.471 m** |
| chordwise travel | 163 mm aft | **64 mm FORWARD** |

A rigid panel apparently twisting 0.84 m across 4.8 m of span, with one end
travelling the wrong way. From the chase camera the trailing edge tore open far
enough to see terrain through the wing.

Each hinge now takes its deflection as a rotation about its own hinge **line**.
The build frame is untouched — `conformToWingSection` maps vertices back to
wing coordinates and would have to be reworked for a yawed parent — so the
change is an axis, not a rebuild. The axis is kept pointing outboard on both
wings, because reproducing the unswept behaviour is the requirement and a
flipped axis deflects one wing the wrong way.

After: the leading edge drops 0.087–0.094 m at **every** station, the
trailing-edge drop tapers with the chord as it must (1.079 m at the root
station to 0.794 m at the break, the flap chord tapering in the same ratio),
nothing moves forward, and port matches starboard to the millimetre.

## Two statistics that lied, and the one that did not

**Per-span-band means are contaminated** when the thing being measured moves in
z. A rotation about a swept axis shifts vertices spanwise, so a fixed band
catches different vertices at each pose. Run that way the flap "dropped" 0.29 m
at one station and 0.59 m at the next — noise, and small enough to look like
sampling. Pairing by vertex index gave 0.634 and 1.471.

**Min/max extremes are not a pairing either.** The mesh's forwardmost vertex at
one pose need not be the forwardmost at another.

What worked was pairing by index and keying stations off **local** z, the frame
the panel was built in, which does not move with the deflection.

## The slot, and a fix that did nothing

The remaining question was daylight between the fixed wing's trailing edge and
the flap. Overlap was present and was not the answer: measured at the wing's
own trailing-edge station, the flap's leading edge stood 0.512 m forward of it
at flaps 0, 0.427 m at take-off and 0.403 m at full flap, while the vertical
slot opened from −0.196 m (flap tucked **inside** the wing) to 0.111 m and then
0.410 m. Overlap in plan is not closure in section.

A cove-door mechanism was built for that — a dark panel on the fixed wing,
sized per frame to span the slot mouth — and then **removed**. Across sixty
chase-like eye points the frames were byte-identical with and without it, while
it punched up to 0.31 m through the flap's lower skin. It was closing a slot
that the hinge-axis fix had already closed.

What remained was the 80 mm slot at the flap break, `z = 6.22..6.30`. That gap
is deliberate — a real closed-up wing shows one — but it is swept 23 degrees,
which makes it a slot a chase camera looks straight down: 118 mm of apparent
width at flaps 0, 314 mm at take-off, 311 mm at full flap, and **every** leak
found anywhere on the wing was at that one station. It is sealed with 140 mm
more flap on the inner segment's tip, built from the same section law and the
same conform so it cannot stand proud at the tucked nose, in the dark paint,
reaching 60 mm into the outer flap's root.

## The instruments

**Ray cast from a sweep of eye points, not one camera.** Parallel rays at a
fixed span station are the wrong instrument for a swept trailing edge: a camera
behind the fuselage looks *along* the slot, so a sight line enters at one span
station and leaves at another. The probe casts from 3 ranges x 5 elevations x 4
azimuths, classifies each ray by first hit, and scans each image column for a
run of sky **bracketed by fixed wing on one side and flap on the other** —
daylight between the aeroplane's own surfaces, not around it.

**The control is what makes the result mean anything.** The first version of
this probe reported "closed" with the fix in *and* with it out — it was broken,
and a broken rig fails toward "nothing happened". Every run since reports the
seal-removed control beside the result. With the seal: CLOSED at flaps 0,
take-off and full flap. Without it: 118 / 314 / 311 mm.

**In-game frames, with the flap proved in the frame.**
`scripts/flap-joint-frames.mts` drives the shipped page rather than a mesh
harness, because the acceptance question is what a player sees. Two guards
earned their place:

- The crop is placed by **projection** — the fixed wing's and both flaps' world
  bounding boxes pushed through the live view-projection — so the rectangle
  contains the joint by construction, whatever the camera did.
- The flap angle is **measured** off the hinge node in the same frame (`2
  acos(w)` of its quaternion, since the hinge no longer carries an Euler angle)
  and asserted against the setting the frame's name claims. A frame captioned
  "full flap" whose panels were blown back is pixel-for-pixel a frame of a
  clean fixed wing. The first in-flight attempt deployed straight from the
  airborne spawn and caught the aeroplane at 348 kt, 2.3 G and 9,400 ft/min in
  a zoom climb; it would have been sent as a pass.

That frame is also taken in a shallow **descent**. In level flight the chase
camera sits barely above the wing plane, the deployed flap hides behind the
wing's own upper surface, and the joint is not in view at all — a frame that
shows a clean wing and proves nothing.

The before/after frames are not cited by path on purpose: per
`tests/docs-evidence-resolvable.test.ts`, a regenerated frame is a different
frame and cannot support a claim made about the original. Regenerate them the
way they were made: run `scripts/flap-joint-frames.mts` — which only exists
from `bee956d^2` — twice against the same dev server, once on the merged tree
and once with `src/render/webgpu/aircraft/bizjetVisual.ts` replaced by the copy
at `bee956d^2~3`, the last commit before the hinge fix. Swapping the one file
rather than the whole tree is what keeps the camera, the seed and the
instrument identical across the pair.

## The gate

`tests/render.swept-flap-hinge.test.ts` compares two independent routes to the
same direction: the rotation axis recovered from the node's own world matrices
(the skew-symmetric part of `R(rest)^-1 R(deployed)`) against the hinge line
read off the panel's leading edge at its extreme span stations. Neither route
consults a declaration.

The first version of this gate was wrong and **failed on the fixed mesh**: it
asserted the *magnitude* of the leading-edge travel against the Fowler
translation, which quietly assumes the leading-edge vertex lies exactly on the
axis. It does not — the section tapers, so its offset varies about 17 mm across
a panel.

Its positive control is the pre-fix mesh, where it fails all four panels and
names the defect: *"deflects about an axis 22.7 deg off its own hinge line ...
axis (-0.000, 0.044, 0.999)"*. 22.7 degrees inboard of the kink and 26.2
outboard are exactly those panels' own sweeps, and the printed axis **is** the
wing's z axis. On the fixed mesh the same number is 0.23–0.40 degrees.

It is **scoped to the Global on purpose**. The F-16's flaperon
(`jetVisual.ts`) and ailerons and the 747-8's flaps (`airlinerVisual.ts`) are
built the same way and are expected to fail it, which is why it is worth having
before that fix rather than after.

## Follow-ups

**The same defect is on two other airframes**, and the 747-8's is far worse
than the Global's was: its inner flap spans 7.5 m against the Global's 4.8, on
a hinge line at 70% chord of a wing swept 37.5 degrees at the quarter chord.
The Cessna is genuinely exempt — its flap is built with `rootLeadingX` and
`tipLeadingX` both 0, because the wing is constant-chord and its hinge line is
parallel to +Z; `trainerVisual.ts` says so in the comment above that panel. Spoilers on both jets are axis-aligned
boxes with their node at their own station, so `rotation.z` is the right axis
for them.

**Elevators and the rudder are not covered** by the Global's fix. Both fins are
swept. The rudder needs a different mechanism: `applyCommonPose` writes
`rotation.y` for it, and yaw is the **outermost** of Babylon's Euler rotations,
applied in the parent's frame — so no orientation on the rudder's own node can
change its axis, and it needs an intermediate parent carrying the rake.

**`scripts/frame-crop.mts` returned scanline garbage** decoding a 1920x1080
Playwright `page.screenshot` PNG. Its decoder is `decodePng` in
`scripts/frame-forensics.mts`, shared by `perf-arm-compare`, `frame-bbox`,
`worst-tile-locate`, `lit-diff`, `blade-luminance-move` and `ab-shape`. **This
is a flag, not a verdict:** it was only observed on Playwright output, and
those instruments consume perf-capture PNGs, which have not been re-checked.
Nobody should conclude their A/B crops are wrong on the strength of this.
`flap-joint-frames.mts` sidesteps it by having the browser clip natively, so
the frame never round-trips a decoder.
