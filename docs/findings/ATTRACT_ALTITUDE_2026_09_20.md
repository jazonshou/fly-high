# The menu flight climbed to 32,000 feet

**Status: shipped on `jazonshou/attract-altitude`.**

Jason's report, verbatim: *"Currently, if I stay on the menu screen for a long
time, the plane keeps defaulting to flying higher and higher. Can you prevent it
from happening and ensure that it stays at a set altitude?"* And on scope:
*"Hitting water shouldn't count as a crash for now — nothing should change about
impact."*

## The cause is one line, and it is not a drift

The menu runs a live flight with `attractMode` on, which forces Scenic and holds
neutral pilot controls. Scenic is an attitude-command law and its neutral is not
level — `src/sim/assists.ts` commands `2.5deg + requested.pitch * 14deg`. A
neutral stick therefore asks for 2.5 degrees nose-up, forever, with the power on.

**The demo was not drifting upward. It was being told to climb and nothing ever
told it to stop.**

And 2.5 degrees is not "level-ish for the trainer" either. Measured by sweeping
commanded pitch until vertical speed settles at zero:

| throttle | trainer | jet | bizjet |
| --- | ---: | ---: | ---: |
| 0.60 | +1.25° | −2.25° | −0.50° |
| 0.75 | +0.25° | −2.50° | −0.75° |
| 0.90 | −0.50° | −2.50° | −1.00° |

Scenic's neutral is above level for **every** aeroplane at **every** throttle —
2.25° nose-high for the trainer at cruise and a full 5° for the jet. The level
attitude also moves with throttle, so there is no single trim figure even for one
aeroplane, and the spread across kinds is 3.75°, a quarter of Scenic's entire
±14° authority.

## What it did, and what it does now

Half an hour of simulated flight per aeroplane, three pinned seeds, target
clearance 450 m (the player's default). `scripts/attract-hold-probe.mts`.

| | before: max clearance | before: mean | after: mean | after: max |
| --- | ---: | ---: | ---: | ---: |
| trainer | 1,677 m | 1,123 m | 445 m | 606 m |
| jet | 4,907 m | 3,138 m | 919 m | 1,321 m |
| bizjet | **9,760 m** | 7,568 m | 1,269 m | 1,597 m |

The Global 8000 was flying itself to 32,000 ft on the menu screen — its service
ceiling. Before the fix its *minimum* vertical speed over half an hour was
**+0.11 m/s**: it never descended once, on any seed, in any aeroplane.

Re-seeds per half hour, which is the honest cost side of this change:

| | before | after |
| --- | ---: | ---: |
| trainer | 3 / 0 / 0 | 3 / 0 / 1 |
| jet | 0 / 0 / 0 | 1 / 2 / 1 |
| bizjet | 0 / 0 / 0 | 0 / 0 / 0 |

The jets used to re-seed *never*, because at 4.9 and 9.8 km they were nowhere
near the ground. Flying them at a sane height puts them back among the terrain,
and the jet now re-seeds once or twice in half an hour. That is a real
consequence of doing what was asked, not an accident, and it is why the terrain
avoidance below exists at all. The trainer's numbers are unchanged — its 3
re-seeds on the default seed are pre-existing.

## The design, and the four numbers that had to stop being constants

An **outer loop** writes the pilot-side `pitch`, `roll` and `throttle` that
Scenic then flies (`src/sim/attract.ts`). Scenic itself is untouched, so the
inner attitude loop, its damping and its stall recovery behave exactly as they do
for a player, and every call site sits under `attractMode`.

**PI on vertical speed, and the integral is the design.** The controller is never
told a trim attitude; it finds each airframe's own. That is what will make it
work for the F-16 and 747-8 that do not exist yet. Anti-windup freezes the
integrator while the command is saturated.

**Airspeed outranks altitude.** Below 1.25 × `stallSpeed(aircraft)` the loop
stops being an altitude hold: it lowers the nose and adds power whatever the
altitude error says. An altitude hold that will not give up altitude is a stall
with extra steps.

**Throttle is rate-limited** to 0.06 of travel a second, so it cannot be heard
hunting on the menu.

Then the four things that could not be constants, each of which was a constant
first and was measured into submission:

1. **Clearance is a TIME, not a height.** 450 m is generous in a Cessna and
   marginal in a Global 8000, because what height buys you is time, and a bizjet
   spends it four and a half times faster. The floor is 6 seconds of flight:
   282 m for the trainer (so it never binds, and the trainer holds exactly the
   player's setting), 930 m for the jet, 1,260 m for the Global. **This one
   change took the bizjet from twelve re-seeds per half hour to zero.**
2. **The turn is a RATE, not a bank.** An 18° bank turns the trainer at 3.9°/s —
   90° in 23 s and 1.1 km — and the Global at 0.87°/s, which needs 103 s and
   **21.7 km**. A bizjet banked 18° is not avoiding a mountain, it is flying into
   it slightly sideways. A standard-rate turn is the same 3°/s for everyone and
   the bank falls out of the speed. (It saturates above 168.6 m/s, where Scenic's
   42° ceiling binds; the Global turns at 2.4°/s. That is Scenic's limit, named
   rather than hidden.)
3. **The look-ahead is SECONDS, not metres.** A 6 km horizon is two minutes of
   warning for the trainer and thirty-nine seconds for the jet. Ninety seconds
   at every speed, capped at 20 km.
4. **Terrain is reduced by the climb it DEMANDS, not by how high it is.** See
   below — this was the worst of the bugs.

## Five bugs I put in and had to measure back out

Each of these produced a confident, plausible-looking wrong answer rather than an
error, which is the only reason they are worth writing down.

**1. The instrument fell into the trap it was measuring.** The first run of the
level-attitude sweep started every aeroplane at 60 m/s — fine for a trainer,
below the stall for both jets. They fell out of the sky, and the probe reported a
level pitch of exactly the sweep's lower bound with a residual vertical speed of
`0.000` for all six jet cases. What gave it away was that `0.000` three times
over is what a *crashed* aeroplane reads, not what a converged sweep reads. The
fix was to enter at 1.6 × each aeroplane's own stall speed — and there is no
`stallSpeed` FIELD, only a derived function, with a docblock that exists
specifically to warn that reading the field returns `undefined` and every
comparison against it silently passes.

**2. The turn was about the wrong thing.** The first trigger asked "can I hold
the full 450 m over this?", so in ordinary hill country the answer was almost
always no: measured, the demo spent 98%, 62% and 56% of three half-hour runs in a
turn. It had stopped cruising and started circling. The turn is about not hitting
anything — 150 m of clearance, not 450.

**3. The scan had a blind spot where it mattered most.** Samples were spread from
15% of the horizon outward, on the reasoning that the point under the aeroplane
is already known from telemetry. At a 4.6 km horizon that put the nearest sample
690 m ahead. Traced: the aeroplane climbed at its maximum for eighty seconds
while the ground beneath it rose from 482 m to 542 m, and the scan calmly
reported 281 m ahead. It flew into a hill it was looking straight over the top
of, three times, at exactly 480-second intervals.

**4. A max over heights forgets where the heights are.** With the blind spot
closed, the scan reduced to its highest point and compared that against the
height the aeroplane could gain over the *whole* horizon. A ridge 500 m ahead was
judged against a 4.4 km climb budget; the arithmetic said "you will clear it by
328 m" and the aeroplane arrived with 65. The reduction has to be by the climb
*rate* each point demands, which is the only form that carries the distance.

**5. Even spacing steps over ridge crests.** 350 m apart over 5 km, the scan
reported a peak of 277 m ahead while the ground *directly beneath* the aeroplane
was already 316 m. It was not looking too far or too close — it was looking
through the hills. The two ends of the scan do different jobs: the near field
decides whether *this* ridge is cleared and an error there is metres from the
ground, while the far field only has to notice a mountain early enough to start a
turn. Quadratic spacing gives the near field ~25 m and the far field ~600 m out
of the same budget.

## What this does not fix

- **Scenic's nose-high neutral affects players too.** A pilot in Scenic who lets
  go of the stick also climbs, for exactly the same reason the demo did. Out of
  scope here (player flight must stay bit-identical) but it is the same defect
  with a person in the seat.
- **The hand-off still steps.** At `takeControl` the control *law* changes:
  Scenic's attitude command gives way to the player's mode, and in Unassisted
  that is a byte-for-byte pass-through, so commanded surfaces jump from whatever
  was holding the attitude to zero and the aeroplane departs into its phugoid.
  This change fixes the *state* handed over — level flight at a sensible height
  and speed, for the first time — but not the control discontinuity, which would
  mean touching trim or the mode transition.
- **The jet re-seeds once or twice per half hour** (see the table). Every
  mechanism above reduced it; none removed it. A demo that flies indefinitely at
  a sane height through generated mountains will sometimes lose.
- **Lakes and rivers** are not in the look-ahead — it maxes against sea level
  only, so the demo will not dive at a coastline but does not know a lake is
  there. Consistent with the AGL work's deferral, and for the same reason.

## Provenance

No capture baseline can move: no perf shot runs the attract flight (`attractMode`
appears nowhere in `scripts/perf-capture.mts` or the capture test), and the
harness places its cameras from its own terrain sampler rather than from sim
telemetry.

The worker cannot be imported — it dereferences `self` at module scope, starts a
`setInterval` on load and exports nothing — so the supervision was extracted into
`src/sim/attract.ts` and the worker and the probe call the same code. The
measured thing is the shipped thing. Scan geometry lives in that module too,
because two callers run it and a probe that scanned differently would be
measuring a lookalike.
