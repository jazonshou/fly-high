# Why the aeroplane sat off-centre and looked tilted

*Measured against `jazonshou/House-Keeping` at `bb078a7`, fixed on
`jazonshou/aircraft-fixes` at `3f1af43` and `74da0a7`. Instruments:
`scripts/aircraft-framing-probe.mts` (headless) and
`scripts/aircraft-framing-inflight.mts` (the shipped page, at frame rate).*

The report was: *"When I fly the Aster (and less so with the Vesper), the
entire plane feels tilted to the right a little and shifted to the left of the
screen a little."*

Four things can produce that and code reading cannot tell them apart, because
each one is locally plausible. Only one of them was true, and it was not the
one anybody guessed first.

## What it was not

**Not the mesh.** The trainer's built airframe is its own mirror image: 62
meshes, 6,333 vertices, bounding box z exactly `[-5.685, +5.685]`, vertex
centroid z `+0.035` on an 11.4 m span. The only unmirrored parts are the pitot
tube and the landing light, both real single-sided fittings. Every roll-axis
rotation is a matched pair. The jet is the same, centroid z `-0.001`.

**Not the flight model.** Hands-off for 60 s, averaged over the last 30, in the
`open-skies` world across all four weather settings:

| | calm | clear | breezy (default) | cloudy |
|---|---|---|---|---|
| trainer mean bank | 0.000° | −0.005° | −0.005° | +0.002° |
| jet mean bank | 0.000° | +0.085° | +0.118° | +0.136° |
| mean sideslip, either | 0.000° | ≤0.012° | ≤0.012° | ≤0.012° |

Breezy put 9.37 m/s of wind on the aeroplane and it did exactly what an
aeroplane does: it crabbed, wings level, sideslip inside a hundredth of a
degree. **A crosswind hypothesis was current and reasonable when this started
— dihedral turning a standing sideslip into a standing bank — and the
measurement refuted it.** There is no standing sideslip to turn into anything.

**Not the viewport.** `.flight-canvas` is `position: absolute; inset: 0` over a
full-viewport shell (`src/game/flight.css:21-28`).

## What it was: two defects in the chase rig

### 1. The rig disagreed with itself about which way is up

`cameraBankFollow` says exterior views adopt 18% of the aircraft's bank, and
the camera's own up vector honoured that. The rig's POSITION and aim point did
not: both were raised along the aircraft's up at full strength. The two
therefore disagreed by 82% of the bank angle.

That matters because the airframe is not on the view axis. The camera sits
5.1 m up the body axis and aims at a point 1.25 m up it, which leaves the
aeroplane hanging about 3.3 m BELOW the line of sight — and rolling the frame
under an off-axis object slides it sideways. Measured, identical on both
airframes:

| bank | shift | apparent roll |
|---|---|---|
| 2° | −0.31% of width | 1.65° |
| 5° | −0.78% | 4.14° |
| 10° | −1.56% | 8.27° |
| 20° | −3.09% | 16.57° |
| 30° | −4.57% | 24.91° |

A RIGHT bank puts the airframe LEFT of centre and makes it look tilted RIGHT —
the report's exact words, in the right directions, at a fixed ratio.

The fix builds every offset on one blended vertical. It blends from
WINGS-LEVEL rather than from world up, which keeps pitch following at full
strength: an unbanked frame is untouched at any pitch attitude, and every
perf-capture shot is unbanked
(`orientationFromYawPitchBank(yaw, pitch, 0)`). Measured after: `0.00%` at
every bank angle on both airframes, with the intended horizon-levelling intact
(16.57° → 15.84° at 20° of bank).

### 2. The smoothing never converged, and it lagged along the TRACK

`cameraPresentationResponse` is a first-order lag, and it was applied to an
ABSOLUTE world position that is itself translating at flight speed. A
first-order lag chasing a ramp does not converge — it settles `speed × tau`
behind, with `tau = 1/7 s`. Measured against a profile asking for 13.5 m: the
trainer's camera sat at 22.1 m and the jet's at 31.4 m. The profile's
carefully tuned distances were unreachable.

**The lag lay along the aircraft's ground TRACK, not along its nose.** An
aeroplane in a steady wind crabs, so the camera sat off the nose by the crab
angle, permanently, with the wings level. That is the constant bias:

| world | arm | camera off nose | airframe off centre |
|---|---|---|---|
| open-skies | base | −0.867° | −1.28% LEFT |
| open-skies | fixed | +0.007° | 0.00% |
| crosswind-a | base | +2.820° | +3.95% RIGHT |
| crosswind-a | fixed | −0.008° | 0.00% |
| crosswind-b | base | +2.797° | +3.93% RIGHT |
| crosswind-b | fixed | −0.005° | 0.00% |
| headwind-c | base | −1.312° | −1.88% LEFT |
| headwind-c | fixed | −0.006° | 0.00% |

All at breezy, hands-off, bank under 0.23°. Up to 63 px of 1600, in a direction
that depends on the wind relative to heading — which is why it read as a fixed
property of the aeroplane rather than a turn artifact.

**And this is "less so with the Vesper".** On one world at one wind: trainer
3.95% off centre with the camera 2.82° off its nose; jet 3.03% and 1.63°. The
crab angle goes as crosswind ÷ airspeed and the jet flies 2.7× faster.

The fix smooths the offset FROM the aircraft, which has no steady-state error,
and then asks for the old trail explicitly along the NOSE so the settled
framing players already know is preserved. Matched A/B, same world, same
flight state (bank 0.1307° vs 0.1308°): off centre −0.78% → 0.00%, camera off
nose −0.531° → +0.004°, distance 22.12 → 21.60 m, ndcY −0.3239 → −0.3206, which
is 1.5 px of 900.

### The two-line near-miss

The first cut of fix 2 derived the offset from the camera's absolute position
each frame and smoothed that. It measured **29.4 m instead of 20.9** and was
one review away from shipping. Re-deriving the offset each frame reintroduces
exactly the error it removes: the stored camera position is a frame behind the
aircraft, so the implied offset arrives already short by one frame of travel
and the filter settles `((1−r)/r)·speed·dt` — the same `speed × tau` — away
from what was asked for. **The offsets have to be persistent state.** Nothing
about the code looks wrong; only a number catches it.

## What else fell out

**The ailerons were on the wrong wings, on both airframes.** The node named
`starboard-aileron` was built at z = −2.4 on the trainer and −2.76 on the jet —
the port wing — while `applyCommonPose` drove it with `pose.starboardAileron`.
Every layer agreed with the layer next to it and the pose signs were correct,
so nothing that consults a name could catch it.

**The rudder was inverted, on both airframes.** Right rudder swung the trailing
edge to port. The nosewheel beside it was already correct, so on the ground the
wheel and the rudder disagreed with each other — which is how it was caught.

`tests/render.webgpu-control-surface-sides.test.ts` now reads the WORLD
position of each surface's trailing edge after a real `update()` and asserts
which way the metal moves, identifying each aileron by where it IS rather than
by its name. **A name-based test cannot catch this class of bug**, which is why
it survived; the existing name-based assertions passed throughout.

**The wingtip contact points did not sit on the wing.** `airframeContactPoints`
carried the trainer's wingtips at y = 0.20 while `trainerVisual` builds the
wing chord plane at y = 0.28. Small, but nothing in the codebase checked the
correspondence at all. `tests/sim.wingtip-strike.test.ts` now pins it, and
covers a wing-low touchdown for every airframe.

## Two traps for anyone measuring a rendered frame here

**Headless Chromium renders only on demand.** A free-running sampler sees ONE
frame in eight seconds; a screenshot is what produces a frame. This kind of
measurement has to run headed.

**`scene.onAfterRenderObservable` never fires.** `FlightRenderer` drives its
own frame pipeline — `engine._activeRenderLoops` is empty while `frameId`
advances — so hooking a scene render observable silently samples nothing. Poll
instead. And an observer that throws kills the render loop outright, which
presents as "the engine stopped" rather than as an error.

## Three instrument bugs that produced confident wrong numbers

Every one of these returned a plausible figure rather than an error, which is
the only reason they are worth writing down.

- **A ground spawn is solved without consulting the environment.**
  `createFlightState` places the wheels on y = 0 whatever the terrain sampler
  says, so a harness that put the surface at the airport's 24 m buried the
  aeroplane and the collision response fired it out at 61 m/s. It reported a
  **0 m take-off roll**.
- **Heading 0 flies along +Z, not +X.** Measuring ground distance on one axis
  reported **zero kilometres** for every straight-ahead run, including a climb
  that plainly covered 18 km.
- **An entry transient trips the stall flag.** A heavy aeroplane entered at
  cruise speed and asked to hold altitude pulls hard enough on the way in to
  exceed the critical angle, so a Global 8000 measured a **clean stall of
  311 kt**. The guard is to cross-check every flown stall against the
  definition's own lift curve and print both;
  `scripts/aircraft-performance.mts` does, and where the two agree (the
  trainer's 24.1 against 23.9, the Global's flapped 57.8 against 57.8) the
  figure can be trusted.

## Named follow-up: the propeller thrust model

`calculateEngineThrust` caps propeller thrust at a FLAT `maxStaticThrust`
until the power limit bites, where a real fixed-pitch propeller's thrust decays
continuously from the moment it starts moving. Consequences for the Cessna 150,
measured: service ceiling **18,628 ft against a book 12,650**, and best rate of
climb at **44 m/s where the real aeroplane's is near 30**. Stall, maximum level
speed and take-off roll are unaffected and land on the type's figures.

Out of scope here because the function is shared with the jet and pinned by
three assertions in `tests/sim.jet.test.ts`. Whoever takes it: the fix is a
speed-dependent propeller efficiency rather than a constant, and it will move
both airframes.

## Deliberate deviations recorded here so they are not re-litigated

- The Cessna 150's real main-wheel track is 1.63 m. The mains sit at ±1.2 m
  (2.4 m track) because the narrower figure makes this ground model twitchy in
  a crosswind landing.
- The Global 8000 flies at a 40,000 kg light ramp weight, not its 52,163 kg
  MTOW, because the world's only runway is 1,320 m and the type needs about
  1,890 m at maximum weight. Both numbers are in `src/sim/aircraft.ts`.
  Measured at 40 t: a **942 m take-off roll** (378 m of margin) and a **436 m
  landing roll** (884 m). Its 31.7 m span on 34 m of pavement leaves 1.15 m
  under each wingtip, and more than **11.1 degrees of bank on the runway
  strikes a winglet** — both fair consequences of bringing this aeroplane to a
  light field, and both deliberate.
- The Cessna 150 climbs at about 1,050 ft/min against the type's 670, chosen
  by Jason so that crossing this world's mountains is not a chore. It is one
  number — `maxStaticThrust` — and stall, approach and maximum level speed are
  measurably identical across the whole sweep, so nothing else about the
  aeroplane is fictional. `tests/sim.trainer-performance.test.ts` pins both the
  shipped climb and that invariance.
