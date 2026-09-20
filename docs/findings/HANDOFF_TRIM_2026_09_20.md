# Pressing Start handed you an untrimmed aeroplane

**Status: shipped on `jazonshou/direct-trim`.**

Jason, asked whether the menu-to-flight hand-off should carry the trim across:
*"Sure let's do that"*.

This is the third of the [menu flight](ATTRACT_ALTITUDE_2026_09_20.md) findings
and the last one. That one fixed the demo's climb; the
[Scenic hold](SCENIC_HEIGHT_HOLD_2026_09_20.md) fixed what the player inherited
in Scenic. Pilot and Direct still inherited nothing.

## The defect

During the menu the attract supervisor flies the aeroplane by writing
`controls.pitch`, so the elevator holding it level lives in the **pitch
actuator**. Pressing Start swapped that for the player's own controls — centred
— and `resetForSpawn` set an airborne spawn's trim to zero. `actuators.pitch`
slews at 7 per second, so the elevator was gone in about five milliseconds and
the aeroplane departed the trimmed state it had been holding.

Measured over 20 s hands-off from a settled menu flight:

| | pitch excursion | peak vertical speed |
| --- | ---: | ---: |
| trainer | 8.87° | 7.35 m/s |
| **jet** | **21.60°** | **49.70 m/s** |
| bizjet | 3.93° | 14.52 m/s |

The jet pitching 21.6° and reaching 49.7 m/s of vertical speed is the lurch and
the phugoid after it. After the fix: **1.15°/1.30 m/s, 0.07°/0.12 m/s,
0.03°/0.16 m/s**.

## The seed

`elevator = actuators.pitch + actuators.trim * TRIM_ELEVATOR_AUTHORITY`, and
that authority is **0.5** — trim authority is half of stick authority. So the
trim that reproduces a held elevator is `held / 0.5`, twice its size, carrying
the same sign: negative is nose-down elevator and a nose-down trim setting. The
value is in `controls.trim` units, the same −1..1 the arrow keys step by 0.04.
It is not an angle and not a pitch attitude.

That 0.5 used to be a bare literal in two places in `simulation.ts`. It is now
`TRIM_ELEVATOR_AUTHORITY` and the seed reads the same constant, because a seed
computed against a different number than the physics uses is a seed that does
not hold the aeroplane.

**When trim cannot carry it.** Trim saturates at ±1, so a held elevator beyond
±0.5 is more than trim can hold. `handoffPitchRemainder` returns the part that
did not fit and the caller leaves it in the pitch actuator, where it decays as
before — the old behaviour, but only for the portion trim could not take, and
only for an aeroplane held at more than half elevator when the player pressed
Start. It is not silently clipped, and a test pins that the transfer conserves
the elevator for every value including saturated ones. Measured seeds at cruise
are −0.057, −0.052 and −0.014, so this has never yet been reached.

## Why the actuators move, not just the control

Seeding `controls.trim` alone is not enough, and the reason is a rate mismatch:
`actuators.pitch` slews at **7/s** and `actuators.trim` at **0.45/s**, fifteen
times apart. The elevator would collapse in five milliseconds and refill over a
tenth of a second. Three arms, same code path:

| | peak elevator drift | drift after 1 s | pitch excursion | peak V/S |
| --- | ---: | ---: | ---: | ---: |
| jet, no seed | 0.0258 | **0.0258** | 21.60° | 49.70 m/s |
| jet, control only | 0.0240 | 0.0000 | 0.14° | 0.35 m/s |
| jet, control + actuators | **0.0000** | **0.0000** | 0.07° | 0.12 m/s |

The "after 1 s" column is the one that matters and it had to be added: a single
peak-drift number cannot tell *a tenth of a second of slew* from *an elevator
that never comes back*, and both read 0.025.

Control-only would have been enough for the outcome. The transfer is exact, so
it is what shipped: the elevator leaving the pitch actuator arrives on the trim
actuator in the same frame.

## Where the seed goes, and why that is the hard part

**The input controller owns trim.** `src/input/index.ts` holds it, steps it on
ArrowUp/ArrowDown, and re-sends it with every control message. A trim written
in the worker is therefore overwritten on the next message and the aeroplane
slews back to neutral. The seed goes through `setTrim`, mirroring the
`setThrottle` that already seeds the throttle from the live attract state at the
same point in `takeControl`.

The **main thread decides the value** and sends it in the hand-off message,
because it is the owner; the worker applies it to the actuators and holds the
same target locally until the controller's next message arrives. The worker
computes the *remainder* from the elevator it has at that instant rather than
from the seed, so the elevator is continuous even if the snapshot the main
thread read was a frame stale — a stale seed just leaves a little more in the
pitch actuator.

Order in `takeControl` is load-bearing three times and is pinned as source text:
after `resetForSpawn` (which zeroes an airborne spawn's trim), before the
hand-off message is sent, and through `setTrim` rather than anywhere else.

The HUD needs no change: it reads `visualState.trim`, which is the trim
actuator, so it shows the seeded value and the player can re-trim from it like
any other.

## Pilot mode gets it too — from the trace, not by analogy

The brief left this open. Pilot mode is a pass-through law with damping, so it
inherits the same nothing:

| | pitch excursion, no seed | with seed |
| --- | ---: | ---: |
| trainer | 8.39° | 1.13° |
| jet | 19.61° | 0.06° |
| bizjet | 3.65° | 0.03° |

Essentially identical to Direct. It is seeded. Only **Scenic** is excluded, and
must stay excluded: its height hold already adopts the menu flight's learned
trim, so seeding as well would be two mechanisms carrying one elevator.

## DirectPitchRetention does not mistake the seed for a pilot input

Retention turns a *change* in requested trim into a change of the attitude it
holds. The seed arrives as a non-zero trim on the first frame after the
hand-off, which is exactly the shape of a pilot winding the wheel. It is safe
for two independent reasons, both now tested: `lastRequestedTrim` is null after
the reset, so the first frame's delta is measured against itself and is zero;
and retention treats neutral input before the pilot has chosen an attitude as
raw flight — *"not a hidden hold of the spawn or menu-demo pitch"* — so the
trim-delta path is not even reached.

## Two instruments were wrong first

Per the standing rule, both are recorded rather than quietly fixed.

1. The first probe handed the player the **spawn throttle** instead of the live
   one. The real `takeControl` already seeds throttle from the attract state, so
   this stepped the thrust at the hand-off and drove a phugoid that had nothing
   to do with the elevator. It reported the jet getting **worse** with the
   seeding (21.60° → 28.49°), which is the opposite of the truth.
2. The first re-trim test pulled hard enough to zoom the trainer to **44°** and
   stall it, then read the stall break as the trim step's effect. "The player
   can re-trim as usual" is a difference, so it is now measured as one: the same
   flight twice, with and without the keyboard step.

## Gates

`tests/sim.handoff-trim.test.ts`, kind-agnostic over `AIRCRAFT_KINDS`. Every
flight test runs **both arms**, and the unseeded one is the positive control.
An unsettled menu flight makes a run **void**, not clean.

### The control went vacuous, and what fixed it

The first version asserted that the unseeded arm broke an absolute bound on
pitch excursion or vertical speed. On the aircraft branch four of those tests
failed — **correctly**, and the failure message said so: *"this test would pass
whether or not the seeding works"*.

The cause was that the test's **exposure** — the elevator the menu flight
happens to be holding when Start is pressed, which is exactly what an unseeded
hand-off loses — was incidental. That branch lifts a silent 180 m/s spawn clamp,
so the Global spawns at its catalogue speed and near trim. Held elevator at
catalogue cruise, before and after that change:

| | House-Keeping | aircraft branch |
| --- | ---: | ---: |
| trainer | −0.0286 | −0.0254 |
| jet | −0.0258 | −0.0015 |
| bizjet | −0.0069 | −0.0005 |
| 747-8 | — | −0.0001 |

Three of four kinds had nothing to lose. **For them "seeded" and "unseeded" were
the same experiment**, so every comparison between the arms was void — not
passed and not failed. Part of what the original control had been detecting was
the *spawn* being off-trim, not the hand-off.

Three changes make it robust, and none of them is a lowered bound:

1. **The exposure is created deliberately**, not inherited: the menu flight
   settles level at 1.2× catalogue cruise, off the zero-elevator trim point, so
   there is a real elevator to lose on every airframe. Measured exposure is then
   0.020–0.034 across all four kinds on both trees.
2. **The assertion moved to the quantity the mechanism acts on** — elevator
   continuity. The unseeded arm must lose ≥70% of the held elevator; the seeded
   arm must keep it. That is arithmetic about the elevator, so it bites for any
   real exposure *however placid the airframe's response*, which is what the
   747-8 needed.
3. **The excursion assertion became a ratio** of what the unfixed hand-off did,
   because departure is a property of the airframe and not of the mechanism.

**Faster than trim, not slower, and that was measured too.** Flying *below* the
trim speed also creates exposure — but it drives the throttle to idle, and an
aeroplane handed over at idle departs over the next twenty seconds whatever the
elevator does. At 0.75× cruise the seeded jet's excursion was no better than the
unseeded one (5.65° against 5.43°): the scenario was being measured, not the
hand-off. Above the trim point the power to sustain it is within the engine's
range and the seeded arm departs 7–11% as much as the unseeded one.

**The exposure is printed beside every result**, so a near-zero one reads as
void in the output itself rather than as a quiet pass, and a run below the floor
fails saying the *scenario* needs changing rather than the bound.

Verified by stubbing `handoffTrimSeed` to return zero: 8 tests fail on
House-Keeping and 10 on the aircraft branch, each printing both arms side by
side — with the stub they are identical, which is the point.

The attract probe is byte-identical to `bee956d`, so extracting
`TRIM_ELEVATOR_AUTHORITY` changed no flight arithmetic.
