# "The spoilers don't activate when the brake is applied" — they did; the chase camera couldn't see them

Jason, 2026-09-23, on the 747. The brake DID raise the panels. What failed was what reached the screen.
The fix does three things: the sim decides when the ground spoilers deploy, the Global gets the same rule,
and the deployment is made legible from the chase camera.

## What was there

Measured end to end, headless: the 747 in `FlightSimulator` on a flat runway, the visual state the worker
builds, the pose, and the built visual on a NullEngine.

- **The brake chain was intact.** Space (or the gamepad) gives `controls.brake`, which slews into
  `actuators.brake` at 5/s. The worker copies it with `onGround`, and the pose rotated the hinges.
- **A braked landing roll** (70 m/s, idle, brake from t = 1 s): the actuator reached 1.00 by 1.5 s and
  `onGround` held true on every frame. The panels turned exactly the designed angles, read from their
  stowed-vs-deployed world matrices: 44.7° on all twelve on the ground, and in the air 20.1° on the
  flight panels with the ground panels at 0.
- **Both faces of every panel wind as a Babylon box does,** so a raised panel's underside is drawn.
- **What the camera saw:** the 747's chase camera is 112 m back and 34 m up, about a 17° sightline to the
  wing. Counted with a drawn-faces z-buffer on one wing at 1600 × 1000:
  - on the ground, braking changed 645 px, 10 px at the tallest;
  - in the air, 97 px, 3 px at the tallest. A 20° panel is within 3° of edge-on to that sightline.
  - A raised panel also uncovered the same white wing it had lain on.
- **The Global had the rule reversed.** Its four panels a side rode the F-16's single `speedBrake` angle,
  39° in the air and on the ground alike, so its inboard GROUND spoiler stood up in flight.
- **Nothing deployed the spoilers without the brake held.** There was no touchdown deployment, and the
  sim's lift dump re-derived `brake · (onGround ? 0.62 : 0.12)` separately from the visual.

## The rule, owned by the sim

`ActuatorState.groundSpoilers` is 0..1, driven by `groundSpoilerDemand` on an airframe with
`AircraftDefinition.groundSpoilers` (the 747 and the Global). The speedbrake is treated as always armed,
since nothing in the cockpit disarms it.

- **Deploy on the ground** when the throttle is at idle (≤ 0.05) above 15 m/s, which covers a touchdown or
  a rejected take-off, **or** with the wheel brake at any speed. Travel is 2.5 per second, so fully out in
  0.4 s.
- **Stow in the air.** There the brake is the flight speed brake only.
- **The lift dump reads the same number:** `max(groundSpoilers · 0.62, brake · 0.12)`. The panels' drag
  reads `max(brake, groundSpoilers)`.
- **The F-16 and the trainer** have no ground spoilers and keep their brake-driven dump bit for bit.
- **The landing roll changes:** an idle touchdown now dumps lift with no brake held, which is the type's
  behaviour.
- **The visual state carries `groundSpoilers`.** The worker copies it and the client lerps it. The pose
  reads it and never re-derives it from the brake and the wheels: a second producer of the same fact would
  be free to disagree with the lift the aeroplane flies by.
- **The cockpit displays' spoiler annunciation** is the larger of the two.

## The angles and the bay

The angles are chosen, not transcribed.

- **747:** 60° full on the ground and a 25° flight speed brake. These are the type's figures in round
  numbers; the flight detent is a partial deployment. Roll adds 25.8° on the down-going wing, and the
  airborne sum is capped at 44.7°.
- **Global:** keeps its 39°, now on the ground only, and takes a 25° speed brake on its three
  multi-function panels. The inboard ground spoiler stays stowed in the air. It has no roll mix, which it
  was never given.
- **The bay:** a matte near-black plate on the skin under each 747 panel, 2–4 mm proud, inset 2 cm and
  0.2 % of chord from the panel's outline.
  - Stowed, it lies inside the panel, whose top is 12 mm proud and bottom 48 mm under the skin, so nothing
    shows. Reversed-Z float32 depth resolves about 0.01 mm at 112 m.
  - Raised, a panel leans back over its bay like a lean-to, and the chase camera looks under it onto the
    dark floor.
  - Cost: one draw for all twelve, on the tyres' material. The inlets' `dark` would have been free, but at
    0.28 roughness it mirrors the sky at the chase's grazing angle and reads grey.
  - It casts no shadow.

**Legibility at the 747's chase** (starboard wing, 1600 × 1000, grey Lambert with per-mesh albedo): pixels
whose shade changes by more than 12/255 when the brake goes on.

| option | ground roll | in flight |
|---|---|---|
| before (44.7 / 20.1, no bay) | 597 px, mean Δ 101, tallest 10 px | 120 px, mean Δ 65, tallest 4 px |
| 60 / 25, no bay | 803 px, mean Δ 117, tallest 13 px | 131 px, mean Δ 66, tallest 4 px |
| before angles + bay | 670 px, mean Δ 146, tallest 10 px | 133 px, mean Δ 117, tallest 4 px |
| **60 / 25 + bay (shipped)** | **876 px, mean Δ 151, tallest 13 px** | **153 px, mean Δ 128, tallest 4 px** |

On the ground the summed change is 2.2 times what it was. In the air it is 2.5 times, but still only 4 px
tall. A 25° panel against a 17° sightline cannot be made tall from behind; it reads as a dark slit over the
outboard panels.

The Global, at its 38 m chase: 651 px, 7 px tall, on the ground; 174 px, 2 px tall, in the air.

## Instruments

- `tests/sim.ground-spoilers.test.ts` covers:
  - a real touchdown at idle, which deploys the panels with no brake, and not before the wheels are down;
  - the brake at taxi speed, which deploys them where idle alone does not;
  - a take-off roll under power, and the brake in the air, which do not;
  - the lift coefficient the sim flies by, which falls by the dump against a lever a hair above idle;
  - the jet and the trainer, which are unchanged.

  Three mutations each turn exactly the intended tests red: no touchdown arming, no wheels-down check, and
  the old brake-driven dump.
- `tests/render.spoiler-chase.test.ts` checks the panels at the renderer's chase pose, at 3200 × 2000 for
  sample density.
  - **The panel's angle by ray:** the plane through the drawn hit points on a raised panel, against the
    panel's stowed plane. It reads 60.03, 60.09 and 25.04° on the 747, and 25.00 and 38.96° on the Global.
  - **The bays:** seen when deployed; stowed, none from the chase or a grazing sweep (the null).
  - **The Global's split rule.**
  - **Controls:** a box drawn from outside and never from inside, and a known tilt read back to 0.001°.
  - **Pinned figures:** the decided angles are literals, because comparing with the table the pose reads
    passed a mutation back to the old travel.
  - **Faces used:** only the plate's broad faces. Near edge-on its 35–60 mm rim is a large share of what
    the camera sees, and a fit through rim and face together was 2–3° off, stable at five times the
    resolution.
- `tests/support/drawnFaceRaster.ts` is the z-buffer. `scene.pickWithRay` could not do this: on Babylon
  9.21 under a NullEngine, a box picked from above and from below both returned the centre's distance, with
  no picked point.

## Live confirmation

On the shipped page, with the game's own Space key held for 2.5 s. Each starboard panel's turn is read from its
world matrix relative to the aircraft root, stowed against braked (a9fb2f2, 2026-09-23, 18:33-18:36):

| airframe | runway | airborne |
|---|---|---|
| 747 | ground 60.00°, flight 60.00° | ground 0.01°, flight 24.99° |
| Global | all four 38.96° | ground spoiler off (0.00°), multi-function 25.00° |

- Every panel returned to 0 on release.
- The static bay mesh read 0.00° throughout, the control.
- Gate A (`tests/gpu/aircraft-material-compile`) and the variants print (`aircraft-render-variants`) were green,
  8/8, with the bays on the tyres' existing material.
