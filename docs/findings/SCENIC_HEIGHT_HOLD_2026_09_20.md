# Letting go of the stick in Scenic now holds height

**Status: shipped on `jazonshou/scenic-hold`.**

Jason, asked whether hands-off in Scenic should hold height or keep flying the
neutral attitude: *"Yes, hold height"*.

This is the second half of [the menu-flight
climb](ATTRACT_ALTITUDE_2026_09_20.md). That one fixed the demo; the cause it
found applies to the player just as much. `src/sim/assists.ts` commands
`2.5deg + requested.pitch * 14deg`, so a centred stick in Scenic asks for two and
a half degrees nose-up, forever. The menu flight climbed to its ceiling because
nobody was watching it for twenty minutes. A player letting go climbs for the
identical reason, just slowly enough to read as drift rather than as a command —
which is exactly what let it survive this long.

## What was built

`ScenicAltitudeHold` (`src/sim/scenicHold.ts`) writes the **pilot-side** pitch
axis that Scenic then flies. Scenic itself is untouched: the bank law, the
coordinated yaw, the damping and the stall recovery all behave as before, and
Pilot and Direct never see this. The command is always

    requested.pitch = learnedTrim + stick

on **both** sides of the deadband, which is what makes moving the stick off
centre and back produce no step.

The PI core came out of `attract.ts` into `src/sim/verticalSpeedPitch.ts`
(`VerticalSpeedPitchTrim`) so both holds are one implementation rather than two
that drift apart. `scripts/attract-hold-probe.mts` reports the same heights and
the same zero re-seeds across the extraction.

It levels off **where the aeroplane ended up**: height is captured only once the
vertical speed has settled, never at the instant of release, so a pilot who
climbs and lets go stays at the top of the climb rather than being flown back
down. Airspeed outranks height, as in the attract law.

## The part worth reading: five places the commanded attitude could step

Scenic is attitude-command, so whatever the hold writes becomes commanded
attitude *directly*. Every place the hold changes its mind about who is flying
is a place the attitude can jump, and a jump is felt as a twitch. All five below
were **measured** — commanded attitude logged frame by frame over real flights,
steps counted against a 0.3° bar — not reasoned about.

Two of the five were found by *flying* and three by *reading the code and then
going to measure*. That ratio is the useful part: the three scenarios the brief
asked for would have shipped the other three defects.

The first measurement attempt found **zero** crossings and **zero** steps, and
that was the probe's fault, not good news: its terrain varied with `x`, the
aeroplane flew along `z` with `x` pinned at 0, and the ground was therefore dead
flat. A clean result from an instrument that never touched the case reads
exactly like a clean result from a system that works.

### 1. The engagement height, which was a condition and had to be a latch

30 m of clearance keeps the hold out of the take-off roll and the rotation. It
was tested **every frame**, so dropping back below it called `reset()`.

| aeroplane | 30 m crossings, hands-off at 40 m over ridges | steps > 0.3° | worst |
| --- | ---: | ---: | ---: |
| trainer | 2 | 2 | 2.48° |
| jet | 7 | 7 | 7.15° |
| bizjet | 4 | 4 | 3.48° |

Every crossing stepped, and every one of them was at clearance 30.0 m with the
wheels up. **The pilot had done nothing; the ground underneath had risen.**

It is now a latch: it engages once, the first time the aeroplane is 30 m clear
after leaving the ground — when the trim is still zero, so engaging costs
nothing — and stays engaged until the wheels are down. After the change the same
flights cross the line **16, 27 and 62** times (more, because the hold now
actually holds height while the ground moves under it) with **zero** steps.

### 2. The speed floor, which deleted the trim in one frame

Not at the gate at all — steps of 11.9°–14.0° at 200–360 m, repeating roughly
every 18 seconds through a hands-off idle glide. `11.91° = 0.85 × 14` and
`14.00° = 1.0 × 14`: the whole learned trim, gone in a single frame, because the
floor did `integral = min(integral, 0)` and `return min(pitch, -recovery)` the
instant the shortfall went positive. The nose dropped, the speed came back, the
trim rebuilt, and the floor fired again — a 12° square wave in commanded pitch.

Both are now continuous in `recovery`: the trim **bleeds** (identity at
`recovery` 0, most of it gone in a second at 1) and the command **blends**
toward the floor's own rather than switching to it. Authority at deep shortfall
is unchanged. **This one was live in the merged attract law too**, since the core
is shared; the attract probe is unchanged across the fix because the menu flight
holds power and rarely sits on the boundary.

### 3. Touchdown, which took three tries

- Delete the trim when the wheels touch → steps by the whole trim, **up to 14°**.
- Decay only the trim over a second → better, still **1.71°/3.48°/3.71°**,
  because the *proportional* term went in the same frame.
- Keep the law running and fade its authority → fixes the touchdown frame, but
  leaves the law chasing the gear's own bounce; the jets showed **2.07°** steps
  on the roll.
- **Freeze what the hold last added and ramp that to zero over a second** →
  continuous by construction. Touchdown: **0.00°** on all three.

A runway start has nothing to hand back, so it is still exactly the stick from
frame one. The ramp is shared with the **bounce** case, found by reading rather
than by flying: a firm landing leaves the ground again below 30 m, and ending
the ramp there because the wheels came up would drop the remainder in one frame
— the exact failure the ramp exists to prevent.

### 4. Crossing the deadband, which had two discontinuities at one boundary

Found by reading. Hands-off, the hold's demand is the height correction;
displaced, it is the aeroplane's own vertical speed. Switching between them **at**
the boundary steps the command by `P` times the difference. And the centred
branch ignored the stick that the displaced branch honoured — worth 0.35° on its
own. Measured in flight, off a captured height:

| aeroplane | worst step | at stick |
| --- | ---: | ---: |
| trainer | 1.04° | **0.025** |
| jet | 1.34° | **0.025** |
| bizjet | **4.88°** | **0.025** |

Every one of them at the deadband exactly. The demand now hands over *across*
the deadband and the stick is added on both sides, so the two branches are one
expression; the same measurement reads 0.00°, 0.00° and 0.02°.

The first attempt to measure this one was also wrong, in a way worth recording:
it froze altitude and airspeed at a synthetic 56 m/s for every aeroplane, which
put the bizjet below its own stall with the speed floor pinned on, and with the
state frozen the integrator wound up against a world that never responded. It
reported **14.51°** — a number that was not a measurement of anything.

### 5. The hand-off from the menu flight

`takeControl` swaps the supervisor for the pilot's hold on one frame, mid-cruise.
Both run the same law over the same aeroplane, so the trim is already known —
the menu flight has spent minutes finding it. The worker hands it across in the
`handoff` branch (`scenicAltitudeHold.adopt(attractHold.verticalTrim)`).
Re-learning from zero instead would walk the whole trim back into the commanded
pitch over the first seconds of the pilot's flight: a sag, then a recovery, on
the one transition they are guaranteed to be watching.

## Final measurement

| aeroplane | scenario | 30 m crossings | steps > 0.3° | touchdown |
| --- | --- | ---: | ---: | ---: |
| trainer | hands-off low over ridges | 16 | 0 | — |
| trainer | hands-off idle descent to land | 1 | 0 | 0.00° |
| jet | hands-off low over ridges | 27 | 0 | — |
| jet | hands-off idle descent to land | 1 | 0 | 0.00° |
| bizjet | hands-off low over ridges | 62 | 0 | — |
| bizjet | hands-off idle descent to land | 1 | 1 (0.46°) | 0.00° |
| trainer | deadband crossing off a captured height | — | 0 | — |
| jet | deadband crossing off a captured height | — | 0 | — |
| bizjet | deadband crossing off a captured height | — | 0 (0.02°) | — |

The single remaining 0.46° is mid-air at 372 m on the bizjet, at speed/stall
**1.235** against a floor at **1.250** — inside the band where the floor fades
in, which is where it should be. It is a frame and a half of normal control
movement, not a discontinuity.

**The attract law did not move.** `scripts/attract-hold-probe.mts` was run on
this branch and on the merged `jazonshou/House-Keeping` tree in an isolated
worktree, and the two outputs are byte-identical: nine runs of half an hour,
zero re-seeds, minimum clearance 165 m. The shared core changed, but the menu
flight holds power and never sits on the speed-floor boundary, so nothing it
does was touched.

## What this does not do

- **Pilot and Direct are untouched.** Direct's hand-off could seed
  `controls.trim` from the same learned number; that is a separate question and
  is with Jason, unbuilt.
- **It is not terrain avoidance.** Hands-off at 15 m over a ridge holds 15 m over
  where the aeroplane was, because that is what holding height means. It is
  still strictly better than before, when the same situation commanded a climb.
- **It is not an autopilot.** The captured height is held at 0.02 m/s per metre,
  capped at 1.2 m/s. Its only job is to stop a drift over minutes; if it were
  strong enough to be felt as a correction it would have overstepped, because
  the pilot did not ask for an autopilot — they let go of the stick.

## Gates

`tests/sim.scenic-hold.test.ts` is written kind-agnostic over `AIRCRAFT_KINDS`,
so the F-16 and 747-8 are tested by it the day they merge rather than the day
somebody remembers, and every threshold is derived from the aeroplane's own
`stallSpeed()` and catalogue cruise rather than from a number that happened to
suit the trainer. It covers hands-off level, settle-and-capture, climb-then-
release, push-over, idle descent, ground pass-through, the deadband crossing,
the latch, the touchdown hand-back, the speed floor's continuity, and the
attract hand-off. `tests/sim.attract-hold.test.ts` pins the worker's call sites
as source text, including that `adopt` is called from exactly one place.
