# Ground steering, braking and a firmer autoland, 2026-10-25

Jason asked for three things: A and D steer the aeroplane on the ground, and
the autoland keeps it parallel to the runway; braking stops it without the
long creep at the end; and the autoland a bit more aggressive, within the
physics. All three meet in the tyres, so they changed together.

## Tyres, brakes and steering (`applyGroundForces`, simulation.ts)

Before, every tyre was a viscous damper: rolling force `|v| * (450 + 7000 *
brake)` and side force `|v| * 8000` per leg, not scaled by load. Measured on a
flat dry runway (`npx tsx scripts/ground-handling-probe.mts`):

| Aircraft | Full brake from 30 m/s | ... with 5% power left | Last 2 m/s | A/D at 3 m/s |
| --- | --- | --- | --- | --- |
| trainer | 4.2 s | 4.4 s | 0.2 s | nothing |
| jet | 4.8 s | never stops (0.17 m/s) | 0.5 s | nothing |
| bizjet | 8.0 s | never stops (0.37 m/s) | 2.0 s | nothing |
| 747 | 42.3 s | never stops (2.5 m/s) | 12.5 s | nothing |

Now:

- **Wheel brakes are friction brakes on the main gear**: brake x 0.68 x the
  wheel's load, fading only in the last 0.3 m/s; the nosewheel is unbraked,
  as on the real aeroplanes. Held brakes hold the aeroplane while the thrust
  is less than they can hold, so a lever left at 5% no longer creeps.
- **A friction circle** (peak 0.85 x load) shares each braked tyre's grip
  between braking and cornering, so the nosewheel steers under full braking.
- **Cornering is load-scaled**: slip angle x load x 6 per radian. The old
  fixed figure was ten times too stiff on the trainer at speed and left the
  747's track ten seconds behind its nose.
- **The roll axis is a tiller on the ground**: the nosewheel steers on
  `yaw + roll`, clamped. Its angle fades with speed so the turn never asks
  more than 0.35 g or half the lateral acceleration that would tip the
  aeroplane over its gear (static turnover: trainer 0.89 g, jet 0.51 g,
  Global 0.68 g, 747 0.87 g). Full A/D at 40 m/s is a gentle 0.1-0.3 g turn
  on every type; Q/E keeps the rudder's aerodynamic authority as before.
- The artificial yaw grip now damps toward the yaw rate the steered nosewheel
  asks for (`v tan(angle) / wheelbase`) instead of toward zero, which had
  held the 747's full-lock turn to a 600 m circle against its geometry's 120.
- The parked lock needs every wheel on the ground, so a heavy that lands on
  one wheel at a large bank is no longer frozen there.

| Aircraft | Full brake from 30 m/s | ... with 5% power left | Last 2 m/s | Full lock at 3 m/s |
| --- | --- | --- | --- | --- |
| trainer | 6.3 s | 6.4 s | 0.3 s | 6 m radius |
| jet | 6.9 s | 7.5 s | 0.3 s | 10 m |
| bizjet | 5.7 s | 5.9 s | 0.3 s | 48 m |
| 747 | 5.8 s | 6.1 s | 0.3 s | 106 m |

The trainer and the F-16 stop a little slower from high speed than before
(the trainer from 60 m/s in 11.4 s, was 7.7): their old brakes braked the
nosewheel too and, being viscous, gave more than friction allows at speed.
About 0.5 g on the mains is what a light aeroplane's brakes give.

`tests/sim.ground-handling.test.ts` pins all of it per type: the stop and
the hold against power, steering under braking, the taxi circle against the
geometric `v / R`, the gentle turn at 40 m/s, and the roll axis left to the
ailerons in the air.

## Autoland

Thirteen flights of the autoland test (`npx tsx scripts/autoland-summary.mts`;
seed `0x51a7e`, real terrain and wind, 1320 m runway). Times are from
engagement; the heading is the nose's angle to the runway at the stop.

| Flight | Touchdown s, before / after | Rollout s | Sink m/s | Touchdown m | Stop m | Heading at stop |
| --- | --- | --- | --- | --- | --- | --- |
| trainer, airborne start | 375 / 329 | 12 / 8 | 0.65 / 0.77 | 313 / 308 | 467 / 433 | 0.07 / 0.04 |
| trainer, pointed away | 342 / 316 | 11 / 8 | 0.66 / 0.77 | 312 / 306 | 464 / 414 | 0.09 / -0.04 |
| trainer, 400 m high, 1.5 km out | 381 / 257 | 13 / 8 | 0.68 / 0.77 | 316 / 306 | 495 / 416 | -0.12 / -0.06 |
| trainer, microburst | 533 / 428 | 11 / 9 | 0.67 / 0.78 | 312 / 308 | 465 / 434 | 0.12 / 0.03 |
| jet, airborne start | 281 / 243 | 21 / 19 | 0.72 / 0.90 | 400 / 360 | 989 / 1020 | -0.21 / -0.01 |
| jet, pointed away | 277 / 259 | 21 / 19 | 0.72 / 0.91 | 403 / 359 | 996 / 1018 | 0.21 / -0.01 |
| jet, microburst | 473 / 328 | 21 / 19 | 0.72 / 0.90 | 398 / 359 | 988 / 1016 | -0.19 / -0.01 |
| bizjet, airborne start | 355 / 267 | 24 / 19 | 0.79 / 0.93 | 394 / 360 | 976 / 1006 | -0.51 / -0.02 |
| bizjet, pointed away | 324 / 301 | 24 / 19 | 0.81 / 0.93 | 397 / 357 | 985 / 999 | 0.47 / -0.02 |
| bizjet, microburst | 651 / 470 | 24 / 18 | 0.79 / 0.92 | 395 / 359 | 978 / 1004 | -0.67 / -0.02 |
| 747, airborne start | 373 / 271 | 58 / 20 | 1.03 / 1.08 | 344 / 331 | 1230 / 995 | -5.67 / -0.07 |
| 747, pointed away | 334 / 310 | 58 / 19 | 1.05 / 1.07 | 347 / 334 | 1259 / 997 | 6.03 / -0.06 |
| 747, microburst | 665 / 474 | 57 / 19 | 1.04 / 1.08 | 345 / 327 | 1243 / 987 | -5.73 / -0.07 |

Every flight lands on its first approach, or on its second after the
microburst's go-around, as before. What changed:

- **Parallel to the runway.** The rollout's centreline loop now uses the new
  tyres' lag, `v / (6 g)`, about a second, and points the nose at most 3
  degrees off the runway, fading that out between 18 and 8 m/s so it stops
  square to the runway. With every wheel down the roll axis steers the
  nosewheel, so the rollout stops flying the ailerons once the nose is down.
- **A replan bug.** After a replan the step measured its progress along the
  old path against the new plan's final, read that final as passed, and put
  the landing flap and gear out at once: the 747 flew 13 km at approach speed
  fully configured, and so did every second approach after a go-around.
  Fixing it alone saved the 747 29 s and the go-arounds 75-100 s.
- **Tighter turns**: planned at 35 degrees of bank (30 for the heavies),
  flown up to 40 (35): 1.3 and 1.2 g, inside the 2 and 1.5 g load limits; the
  angle-of-attack ceiling still binds below the stall. A start faster than
  the en-route speed plans a turn it can fly at that speed.
- **Steeper descent**: up to 80% of the idle, fully dragged descent gradient
  the airframe has (D/W), capped at 6 degrees, where it used 60% and 4.5.
- **Later slow-down**: en-route speed is held until there is just room to
  slow to the pattern speed at 0.6 m/s^2 plus 3 km; the heavies' shortest
  stabilised final is 60 s instead of 75, still joined above the gate.
- **Firmer flare**: a shorter flare constant (1.3 + 0.35 x gainScale s) and
  touchdown targets of 0.7 m/s (light) and 0.8 (Global); the 747 stays 0.9.
  Less float, touchdowns nearer the aim point, all under the test's 1.2.
- **Quicker stop**: the autobrake holds at least 3.5 m/s^2 (0.36 g, an
  airliner's highest landing setting, about 60% of what the tyres give) and
  comes on at 1.5 per second; it plans on the friction-limited `v^2 / 2a`.

`tests/sim.autoland.test.ts` now also asks for the stop within 24 s of the
touchdown and the nose within 1.5 degrees of the runway below 30 m/s and 0.5
at the stop. The trainer's too-high start turns round onto the other end of
the runway now (the steeper descent makes that the shorter way to lose the
height), so that test asks for at least a full reversal, not a circuit.

## The nosewheel as drawn

`resolveAircraftAnimationPose` drew the nosewheel from the rudder alone at a
fixed travel. It now draws the simulator's own angle (`nosewheelSteeringAngle`)
from the pedals and A/D together, fading with groundspeed: fully over at taxi
speed with either A/D or Q/E, nearly straight at 40 m/s. Before/after shots:
/mnt/project-files/ground-handling/nosewheel-*.png.
