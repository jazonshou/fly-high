# Both box rudders turned about a line running through themselves

The F-16's and the 747's rudders were boxes tilted about their own centres —
how a box fakes a swept panel against a vertical hinge. Measured on the built
meshes, on the centre plane:

| | 747 box rudder |
|---|---|
| hinge node | (−31.40, 3.15) |
| panel's leading-edge corner | (−29.54, 4.50) — **1.86 m forward of its own hinge** |
| root chord | (−32.15, 3.24) → (−29.54, 4.50), i.e. **tilted 25.9° from horizontal** |

Two separate defects in one shape. The hinge line ran *through* the panel
rather than along its edge, so raking the axis swung the two edges opposite
ways and sent the trailing edge to PORT on right rudder — which is why both
sat in `DECLARED_UNRAKED` rather than being fixed by an axis change. And the
tilt rotated the **chords**, which a real raked fin never does: its span leans
and its chords stay level.

## The fix is shearing, not rotating

A panel does not need to be rotated to sit on a raked line. The leading edge
leans with the fin while the chords stay level — which `airfoilWing` draws
natively, because it interpolates leading and trailing x independently along
the span. Both rudders are now built the way the **Global's** rudder already
was, that being the one raked rudder in the fleet that worked: an aerofoil
stood on end, its leading edge ON the fin's trailing edge, hinged through
`yawHingeAlong`.

| | before | after |
|---|---|---|
| F-16 axis vs its own hinge line | (in `DECLARED_UNRAKED`) | **0.000002°** |
| 747 axis vs its own hinge line | (in `DECLARED_UNRAKED`) | **0.0000009°** |
| leading edge movement, full travel both ways | — | **0.0 mm**, against 247 mm / 198 mm at the trailing edge |
| samples inside the fin, three deflections | — | **0 of 840** each |

`DECLARED_UNRAKED` is now empty. It was asserted to STILL FAIL, which is what
kept it from rotting and what told the gate the day the rudders were fixed.

The 747's rudder also makes the tail the right length: the fin's root chord
goes from 11.0 m to 13.2, towards the real aeroplane's 13. The old tilted box
added only 0.65 m there, so the tail was short as well as wrong.

## A square trailing edge has two answers

The first attempt used `verticalProfile` — a constant-thickness panel. It
placed the hinge correctly and `render.webgpu-control-surface-sides` failed
anyway: **right rudder put the aft-most vertex at z −0.194 where it had been
+0.400**, on a panel that was in fact swinging correctly to starboard.

A constant-thickness panel ends in a square edge two vertices wide. As it
swings, the far face's corner becomes the aft-most one, and a test that reads
"the aft-most vertex" reads the deflection backwards. `airfoilWing` tapers to a
sharp trailing edge, so there is one aft-most vertex and one answer. The
airframe's own comment had warned of exactly this — *"a rudder as thick as its
own swing would make 'which way did the trailing edge go' ambiguous"* — about
the box it was describing, and it was just as true of its replacement.

## THE INSTRUMENT THAT WAS WRONG

> `scene.multiPickWithRay` returns **one `PickingInfo` per mesh** — the nearest
> hit — **not every crossing**. So counting its results and taking the parity
> asks "did the ray hit this mesh at all", which is 1 for a point sitting
> *outside* with the mesh in front of it exactly as much as for a point inside.

Every clearance number taken that way is weaker than it looks, **including the
F-16 airbrake figures already reported and merged**. Containment is now counted
with Möller–Trumbore against the target's own world-space triangles, all of
them, three directions with a majority vote.

Re-run on the correct instrument, the airbrake conclusion **holds**: 0 of
38,880 samples enclosed across all nine brake × elevator poses. What does not
survive is the *evidence* for the intermediate breach that moved the hinge —
that reading was taken with the flawed test. The overlap was real by arithmetic
(the vertical plate's far edge swept 211 mm forward into a region the
stabilator occupied in all three axes), but it was never re-measured.

A second trap sits on top of the first: a containment test **cannot classify a
point lying exactly on the boundary**, and a rudder's leading edge lies exactly
on the fin's trailing-edge surface by construction. Eight vertices read as
"inside" for that reason alone. Samples are now shrunk 5 mm toward the panel's
own centre before testing, so the question asked is whether the panel
penetrates by more than the width of a seam.

## Instruments

`scripts/rudder-frames.mts` — chase and rear three-quarter frames, neutral /
full right / full left, with the deflection **measured** as the hinge node's
rotation from rest, `acos((trace−1)/2)`. A frame disagreeing with its caption by
more than a degree fails the run. It aims at the **rudder**, not the fuselage
centroid: on a 70 m aeroplane those are 30 m apart and a camera parked "behind
the centroid" ends up beside the nose with the tail out of frame.

It also filters hinge nodes on `^rudder$` rather than `/rudder/`, because
`rudder-mount` and `rudder-frame` are nodes too and writing a yaw on the MOUNT
turns the hinge axis itself rather than the panel about it.
