# The 747's twelve spoilers did one thing; the aeroplane's do three

> **Superseded in part, 2026-09-23** (`GROUND_SPOILERS_2026_09_23.md`): the ground spoilers now deploy on the
> sim's `groundSpoilers` (touchdown at idle, or the brake on the wheels) rather than on brake and wheels in the
> pose, full travel is 60 degrees and the flight speed brake 25, and a dark bay lies under each panel.

Every panel took one angle from one number, so the aeroplane had no roll
spoilers and its inboard panels deployed in flight — which they never do.

## How the real mix works

The twelve panels split into **inboard ground spoilers** and **outboard flight
spoilers**.

- The **ground spoilers** deploy only on the ground. On touchdown they dump the
  wing's remaining lift on to the wheels. In the air they stay stowed.
- The **flight spoilers** do double duty. They rise symmetrically as the **speed
  brake**, and they also rise **differentially with roll input, on the
  down-going wing only**, to augment the ailerons.
- The two demands are **summed on each wing and limited to the panel's travel**,
  so an aeroplane speed-braking and rolling hard right does not ask its
  starboard panels for more than they have.

That arrangement is the aeroplane's and is standard for large transports.
**The angles are not transcribed.** They are chosen for how they read at chase
range, and are marked as such in `animation.ts` rather than presented as a
manual's figures:

| | radians | degrees |
|---|---|---|
| full travel (ground, and the cap on the sum) | 0.78 | 44.7 |
| speed brake in flight | 0.35 | 20.1 |
| what full roll input adds, down-going wing | 0.45 | 25.8 |

Measured across the states that matter:

| state | ground | port | starboard |
|---|---:|---:|---:|
| clean, level | 0.0 | 0.0 | 0.0 |
| speed brake, in flight | 0.0 | 20.1 | 20.1 |
| hard right roll, no brake | 0.0 | 0.0 | **25.8** |
| hard left roll, no brake | 0.0 | **25.8** | 0.0 |
| brake **and** hard right roll | 0.0 | 20.1 | **44.7** (capped) |
| on the ground, brake | **44.7** | 44.7 | 44.7 |

## The sign, and why it needs a control

A positive pilot roll is right-wing-down, so right stick raises the
**starboard** panels. That reads equally true backwards to anyone not holding
the body-axis contract in their head, which is why
`render.webgpu-control-surface-sides` pins it on the built meshes' trailing-edge
heights — **and then drives the same nodes with the two wings' angles swapped
and asserts the same measurement reports the opposite**. A test that only ever
sees the correct mix cannot tell you it would have noticed the wrong one.

The ground/flight split has its own control: the null "a ground spoiler did not
deploy in flight" is asserted beside "the flight panels DID rise on the same
command", so it is about the group rather than about the brake being ignored.

## What this broke, and what that exposed

`render.swept-flap-hinge` dropped from fifteen airliner surfaces to **thirteen**
the moment the ground spoilers stopped deploying in flight — its pose is
airborne, so it could no longer drive them. That is the gate doing its job: a
surface this sweep cannot move is a surface it is not testing. Its pose is now
`onGround: true`, which costs nothing (every other surface deflects on the
ground too) and covers the two hinges again.

## The frames

`scripts/spoiler-turn-frames.mts` captures the 747 **in a real bank**, and its
first run **refused to shoot**: the scenic flight holds its wings level, and
four minutes of polling saw bank between −1 and 0 degrees with no split. Rather
than writing angles on to the spoiler nodes — which would have photographed the
capture script rather than the aeroplane — it now **holds the game's own roll
key**. The sim rolls the aeroplane, the pose reads the aileron the aeroplane is
actually using, and the mix does the rest.

Captured: **bank 20.7° with the starboard wing low, port panels 0.0°, starboard
panels 14.3°, ground spoilers stowed.** The script asserts in flight that the
raised panels are on the low wing and throws if they are not, so a frame showing
the mix backwards cannot be written.
