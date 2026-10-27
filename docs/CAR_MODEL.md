# Car model: the Land Cruiser 76

How the Land Cruiser drives, climbs, crawls, brakes and tips over, what each
part of the model is taken from, which numbers are published and which are
estimates, and how the results compare with the published figures. The code
is `src/sim/ground/`; every physical number is in one record,
`LANDCRUISER_76` (`src/vehicles/landcruiser76.ts`), marked published, derived
or estimate. The drawn car reads the same record (`LC76_GEOMETRY`).

## The car

A 76 Series five-door wagon (GXL): ladder frame, a rigid front axle on coils
with a Panhard rod, a rigid rear axle on leaf springs, part-time four-wheel
drive with a two-speed transfer case (high 1.000, low 2.488) and lockable
front and rear differentials. The 2.8 L 1GD-FTV turbo diesel (150 kW, 500 Nm
with the automatic, 450 Nm with the manual) drives either the six-speed
automatic (final drive 4.300) or the five-speed manual (4.100). 2,300 kg at
kerb, CG about 0.80 m up with 52% on the front axle (an estimate, set so the
tilt table tips at about 40 degrees), 265/70 R16 tyres.

Frames: body +X forward, +Y up, +Z to the right, origin at the kerb CG (axles
included), 1.31 m behind the front axle. Heading is `atan2(forward.x,
forward.z)` and decreases in a right turn (D-6), as an aircraft's does.
`steer` +1 turns right.

## The step

`GroundVehicleSimulator.step` runs at the sim's 120 Hz. Each step finds every
tyre's contact plane once, reads the driver's controls through the gearbox's
pedal rule, runs the driver aids, then takes 4 substeps at 480 Hz: a wheel's
spin mode (2.6 kg m^2 against a tyre very stiff in slip) is far too fast for
120 Hz. About 26 states:

- the chassis: the sprung mass as a 6-DOF `RigidBody` about its own centre of
  mass (`SPRUNG_CM_OFFSET` from the body origin);
- each solid axle's heave and roll against the frame. Tyre forces along the
  frame's vertical go to the axle; the rest go to the frame, the longitudinal
  at the contact patch and the lateral at the roll centre, whose moment rolls
  the axle. Springs, digressive dampers, anti-roll bars, progressive bump
  stops and droop stops act between each axle and the frame, and the links'
  anti-dive and anti-squat are an internal force pair;
- the engine speed and the four wheel spins (the driveline solver), and one
  windup state between the propeller shafts in 4H and 4L;
- each tyre's two TMeasy deflection states.

The step is deterministic (bit-identical over ten minutes of identical
inputs) and allocates nothing once V8 has optimised it, apart from
classifying a new surface cell (see Surfaces) and the one call a step into
the water authority, whose `sample(x, z, out)` takes two numbers V8 boxes
when it has not inlined the call: besides keeping to scratch objects, no
other number crosses a call in the hot path. V8 boxes a double
passed to or returned from a call it does not inline, and `Math.hypot` boxes
its arguments, so the step's sizes, the speed and the slope are fields, the
components take their inputs as fields or objects, and lengths are square
roots of sums. A choice between a computed double and a double argument
(`k === 5 ? -halfTread : halfTread`) is boxed too; a sign times the argument
is not. On rolling ground a step costs about 30 to 40 us here, inside the
plan's 60 us on the tuning box (`tests/sim.car-budget.test.ts`).

A field that will hold fractions starts from `DOUBLE_ZERO`
(`src/sim/ground/doubleZero.ts`), not 0. V8 gives a field the
representation of the first number stored in it, so a field that starts at
the integer 0 re-shapes its object at its first fraction, and every
optimised function that has seen the old shape is thrown away. On the
simulator that is nearly the whole step: the first 4H shift (the windup),
scrape, bump stop or ford each cost a run of 13 to 22 steps of 1 to 6 ms
on the show drive below. Starting from the double, that stretch of the
drive has 3 or 4 steps over 1 ms, none over 1.5, and the drive ends on the
same bits.

On a real world, with the lattice, the colliders and the water composite
under it, a step on this cloud box (which runs the reference kernel about
1.6 times slower than the tuning box) costs about 51 us parked and about
62 us crawling, against about 30 and 33 us on the test rig's analytic
ground: about 32 and 39 us on the tuning box. Two things brought it down
from about 74 and 82 us: each lattice cell's 4 x 4 nodes are kept for the
rest of the step (a tyre's eight samples fall in one or two cells), and a
dry wheel skips its water turn until it has moved (see Water). What is left
over the rig is the soil on grass, the hull's probes against the lattice and
the colliders, and the nodes' expiry reads.

## The start

A car starts where the worker puts it, but waits there, still and not
simulated, until the published L0 terrain pages answer everywhere within
8 m of it, the bicubic stencil's neighbours included
(`SurfaceVehicleEnvironment.groundReady`, backed by `TerrainAuthority.covers`
in the worker). It would otherwise settle on the macro grid's or the
analytic kernel's height and drop or jump when the page lands. While it
waits the payload's `settling` is true. It drops any lattice node read
before the pages landed, then seats itself on the ground at its static ride
height. A worker no renderer feeds gives up after 10 s
(`GROUND_WAIT_SECONDS`) and settles on whatever answers; tests and probes
pass no `groundReady` and never wait (`tests/sim.car-spawn.test.ts`).

## Recovery

R in a car session sends the worker `{ type: "recover" }`
(`SimulationClient.recover`), which the car alone takes: the aircraft's and
the boats' restarts are untouched, and the pause menu's Restart still starts
the drive over on the apron (or, after a crash, on the wheels where the car
came to rest). The car keeps a ring of the last 16 safe spots: at most one a
second, with all four tyres carrying over 500 N, the body under 25 degrees
off level, no wheel over water, the engine dry and the car neither rolled
nor wrecked, and only once it has moved 3 m from the last spot, so a parked
car keeps its history. `recover` puts the body origin back on the newest
spot at its heading, level, stopped and through the spawn gate, so it seats
on the ground at its next step as a start does (and waits if the pages
there have gone). The engine restarts dry, the box goes to P (or first with
the clutch open), the cabin drains, and the wreck, the roll, the ruts, the
tyres' slip and the axles' motion are cleared; the setup, range, locks, tyre
pressures, lights and downhill assist stay as they were, and the input is
left alone, so the press counts carry on. A spot the car is still within
2 m of is dropped for the one before, so a second press, or a press while
stuck where the last spot was taken, goes one spot further back; the oldest
is kept. With no spot yet, it comes upright where it lies. The worker posts
the result as a fresh start, so the renderer cuts to it
(`tests/sim.car-recovery.test.ts`).

## Contact

Each tyre is a disc sampled at five points round its lower arc and two across
the tread (`wheelContact.ts`). Each sample's ground point and gradient give a
tangent plane; the disc's penetration of it is R_eff - (C - G).n, with
R_eff = R sqrt(1 - (a.n)^2). A plane counts only where the disc's deepest
point against it falls in that sample's own stretch of the arc, the deepest
trusted plane wins, and one more sample at its contact point refines it. At
an edge (a ramp's toe, a step) the buried rim point is the contact, so a tyre
climbs a ledge. The substeps read the step's plane.

The ground is the physics terrain authority's 2 m lattice, cached round the
car (`terrainPatch.ts`) and evaluated with the authority's own bicubic
Catmull-Rom, so where a page is resident the car rolls on exactly the drawn
ground. One authority height costs about 13 us in Node; the cache reads each
node once as the car reaches it, and within a step it keeps each cell's
4 x 4 patch for the next lookup in that cell, so the spline reads no node
twice a step.

The hull is spheres on the frame and axles (bumpers, sills, tank guard,
diffs, tow bar, roof) that meet the ground and the world's colliders with a
stiff penalty and Coulomb friction; `touching(part)` reports each part.

## The marina's decks

Under the pier is the dredged bed, and behind the quay face is the quay cut
(the apron's front drops to the bed inside the wall). So the tyres also roll
on the marina's decks (`deckGround.ts`):

- the pier deck;
- the gangway;
- the quay wall's coping, 10 cm proud of the apron.

Each deck is the top face of its box in `homeMarina(world).boxes`. Those are
the records the hull collides with and the renderer draws, so the deck a tyre
rolls on is the box the bumper meets.

- **Ground in its plan.** Inside a top face's plan, the face is the ground.
  Its edges are steps, and the tyre contact climbs and rolls off them like
  any ledge.
- **Only from above.** A tyre whose centre is under a deck's top does not see
  that deck. So a wheel in the basin by the wall, or under the pier, keeps
  the bed, and the hull meets the deck as the collider it is.
- **Tyres only.** The decks are the tyres' ground and not the hull's, so no
  probe is pushed by both a deck and its box.
- **Surface.** The coping is concrete. The pier and gangway are timber: about
  four fifths of asphalt's grip dry, slightly more rolling resistance, and
  2 mm of roughness from the plank joints. That is a judgement, not a
  measurement.
- **What is left out.** The pontoons and fingers float (they are the boat's
  kinematic colliders), the buildings are colliders only, and posts and
  bollards are not ground.

The apron's front needs one more fix. The quay cut is a 4.5 m face in 0.7 m,
far sharper than the authority's 2 m lattice can hold. Its Catmull-Rom rings
over the apron behind the wall, with humps of 0.55 m and holes of 1.4 m
within 2.5 m of the coping, none of them drawn. Before this fix, a car
driven at the quay was stopped by an unseen 38 cm step in front of the
coping.

The apron is level at the quay deck by construction, so the car reads it
that way. Along each quay wall, from the cut's top back 5.66 m, the ground is
the quay deck's height. That distance is as far as the spline's 4 x 4 patch
reaches, two lattice cells on a diagonal. Beyond it, the authority is within
4 cm of the apron. The strip is not a collider, so it is the hull's ground as
well as the tyres'.

Measured in `sim.car-deck.test.ts`, on the default world's marina:

- **From the apron onto the pier.** At 2 m/s, the car drives off the apron,
  over the coping and out along the pier deck. Every contact in the coping's
  plan is on its top, and every contact in the pier's plan is on the deck.
  No tyre ever goes below the deck. It brakes to a stop on the timber with
  all four wheels loaded.
- **To the coping's edge.** At 1 m/s, the car climbs the coping and brakes
  with its front tyres within half a metre of the edge. It stands there with the front
  tyres on the coping, over terrain that is the quay cut, more than half a
  metre down.

## What it hits

The worker builds one collider world per car session (`carColliders.ts`)
from the records the renderer draws from, so what the car hits is what is on
screen:

- the home marina's structures, the ones the boats' hulls meet;
- each airport's hangars, as boxes from a metre under the lowest ground under
  the footprint to the eaves over the highest. The ground comes from the
  renderer's own 2 m footprint samples (`hangarSite`) and the box turns by
  the hangar's yaw;
- each airport's tower base, as a capsule of its plan radius, and its fuel
  tanks, each a horizontal capsule on its saddles. That makes ten colliders
  an airport, rebuilt only when the airport list changes;
- the guardrails of each streamed infrastructure region
  (`InfrastructureRegion.rails`), one group a region, which come and go with
  the worker's infrastructure updates.

A guardrail is one box per pair of points. Its face is on the rail's line,
facing the road along n = (dz, -dx), and the box runs 2 m deep behind it,
from 1.5 m under the ground to 3 m over. At each bend there is an upright
capsule behind the face. The collider is bigger than the beam because a
probe is a point and a box pushes a point out through its nearest face. A
beam-sized box would throw the bumper over the top or out of the back long
before the rail had given its half metre, and at a bend the box's end face
would be the nearest one.

The hull picks its contact law from the collider's material:

| Law | Per-probe spring | Damper | Friction | Notes |
| --- | --- | --- | --- | --- |
| Buildings and the marina | 800 kN/m | 20 kN s/m | 0.4 | Rigid. A first touch closing faster than 12 m/s wrecks the car. |
| Guardrails | 25 kN/m to 0.6 m in | 2 kN s/m | 0.25 | Past 0.6 m a wall-stiff stop joins in (the posts). Coming back out, the springs give back a fifth of their force, as a bent beam does, so a car is not thrown back off it. A beam is there to take a shallow hit, so the 12 m/s rule judges the closing speed still left when the give reaches the stop. |

Measured on a straight rail, hands off at the impact:

| Impact | Rail gives | After 4 s |
| --- | --- | --- |
| 80 km/h, 20° | 0.41 m | Running along the rail at 0.68 of its speed. 8 mm of lift, under 1° of roll. |
| 100 km/h, 25° | 0.59 m | Running along it, not wrecked. |
| 100 km/h, 30° | 0.64 m | Running along it at 0.60 of its speed. It closes at 13.6 m/s, but has under 12 m/s left at the stop. |
| 100 km/h, 35° | 0.68 m | Running along it, not wrecked. |
| 80 km/h, 45° | 0.73 m | Wrecked. |
| 60 km/h, 90° | 0.66 m | Stopped against the rail, not wrecked. |
| 100 km/h, 90° | 0.75 m | Wrecked, at rest against the rail, on the road side. |

## Tyres

TMeasy (Rill, Road Vehicle Dynamics, 2011): each direction is a curve of
initial slope, peak and sliding level, interpolated in load between the
nominal and twice it; combined slip uses TMeasy's generalised slip, so
braking in a turn trades grip as a real tyre does. Rill's first-order
deflection dynamics give a relaxation length of about half a metre at speed
and a carcass spring and damper at a standstill, so a braked car stands on a
slope without jitter. The radial stiffness follows the pressure (2.4 bar on
the road, 1.2 for sand). Asphalt is the curves' reference; other hard
surfaces scale the friction, and soft ground replaces the curves with the
soil's (below).

## Surfaces

Each tyre reads the material the splat bake paints under it, from the same
authorities (`surface.ts`): the runway rectangle, then a streamed or static
infrastructure segment's paint where it covers at least half the point
(asphalt, concrete, gravel, or a track: gravel with a track's friction and
ruts), then the land-cover classifier on the world's surface sample with the
canopy closure and grass cover the bake hands it (`densityField`, thinned on
sand as the bake thins it). The natural ground is classified at the centre of
its 4 m cell (the L0 splat texel) on the car's own ground there and cached
over a 64 m square, at most one new cell a step; a classification costs about
25 us and allocates (the classifier returns its weights), so the cache keeps
the step's average cost flat. The cache and the terrain lattice are dropped
when the world or its streamed road regions change, so a road's cut or fill
reaches the tyres as it reaches the drawn ground.

The calendar is the renderer's. Settings' `dayOfYear` goes to the worker in
`initialize`, and `applySettings` sends each new one (`{ type: "dayOfYear" }`)
beside the renderer's clock; a new day drops the cached cells, not the
lattice. The cells are classified with the bake's own season law, from the
same modules (`paintedSeason`): the bake is keyed on the clock's bucketed day
(`seasonBakeDayOfYear`, shared with `TerrainClipmapSystem`), classifies at the
seasonal temperature shift (`seasonalTemperatureShift`) of that day's two
resident buckets' centres, puts both on one material basis
(`alignSeasonalLandCoverWeights`), and the fragment cross-fades them by the
clock day's own `seasonBucketBlend(day).t`. The car takes the dominant
material of that same fade, so winter's snowline comes down the hills under
the tyres as it does on screen. The fragment's own macro snow blanket (a
perturbed band for coarse pages) is not followed; on L0 pages the classifier
already holds the snow.

Against the bake's own answer restated on the CPU (four taps, the bake's
canopy drivers, both season buckets and the fade), the worker's material maps
to the same soil model at 1,235 of 1,236 land cells over six forced provinces
at midsummer, and at all 1,236 in mid-January (`sim.car-terrain`); the bake's
erosion and soil-depth channels have no CPU twin.

| Surface | Friction | Rolling resistance | Roughness (RMS) | Soil |
|---|---|---|---|---|
| Asphalt, concrete | 1.0 | 0.012 | 0 | hard |
| Gravel | 0.65 | 0.020 | 6 mm | hard |
| Track | 0.70 | 0.025 | 12 mm | hard |
| Rock, lava | 0.75, 0.80 | 0.018, 0.020 | 20, 25 mm | hard |
| Sand | soil | 0.012 + compaction | 3 mm | dry sand |
| Grass, dry grass, forest floor, shrub | soil | 0.012 + compaction | 8 to 12 mm | sandy loam, to clay as it gets wet |
| Snow, deep (5 cm and more) | soil | 0.012 + compaction | 3 mm | snow, over its depth |
| Snow, packed (under 5 cm) | 0.25 | 0.015 | 3 mm | hard |
| Tephra | soil | 0.012 + compaction | 8 mm | coarse sand |

Wet loam is mud: the classifier's wetness blends sandy loam towards the
clayey soil between 0.6 and 0.9 (a smoothstep), and the payload's
`wheelWetness` carries it for the spray.

Snow's depth is its share of the painted mix (`snowDepthOf`): none at a 0.4
share, the snowfield's edge, and Wong's full 0.2 m soft layer at 0.9 and up,
a smoothstep between. The classifier's snow weight is the height above the
seasonal snowline, shed by steep faces, so a cover the season has only just
brought down, or one on a steep face, is thin. Under 5 cm the tyres pack it
onto the ground beneath: a hard surface at a quarter of dry asphalt's grip
(Wong's table 1.3: 0.2 on packed snow, 0.8 to 0.9 on dry asphalt;
`describeSnow`). Deeper, it is Wong's snow
soil (table 2.3), its sinkage stopped at the snow's depth, the firm ground
under it. A tyre under water keeps the snow's depth; only loam turns to mud.

## Soft ground

Bekker-Wong terramechanics (Wong, Theory of Ground Vehicles, 4th ed.,
chapters 2 and 5; `soil.ts`), with the soils of Wong's table 2.3:

| Soil | n | k_c | k_phi | c (kPa) | phi | K (m) | Depth (m) |
|---|---|---|---|---|---|---|---|
| Dry sand | 1.1 | 990 | 1,528,430 | 1.04 | 28 | 0.025 | 0.35 |
| Sandy loam | 0.7 | 5,270 | 1,515,040 | 1.72 | 29 | 0.025 | 0.15 |
| Clayey soil | 0.5 | 13,190 | 692,150 | 4.14 | 13 | 0.03 | 0.30 |
| Snow | 1.6 | 4,370 | 196,720 | 1.03 | 19.7 | 0.04 | 0.20 |
| Tephra | 1.1 | 990 | 1,528,430 | 0 | 34 | 0.03 | 0.30 |

K (the shear deformation modulus) is not in the table; 2.5 to 4 cm follows
Wong's measured shear curves. The depths (the soft layer over firm ground)
and tephra's row are estimates.

- Sinkage: the tyre's flat, 2 sqrt(D delta) long, presses the soil as a
  plate of the tread's width, p = (k_c / b + k_phi) z^n. A softer tyre has a
  longer flat and a lower pressure, so it sinks less: why airing down gets a
  car through sand. The sinkage presses in within 50 ms and lifts only as the
  tyre rolls onto fresh soil.
- Compaction resistance, b k z^(n+1) / (n+1), against the tyre's travel,
  building like friction over the first 5 cm/s. It is the work of pressing
  virgin soil ahead of the tyre, to the static sinkage of its present load
  and pressure plus whatever its slip digs: a tyre aired down in the hole it
  made at road pressure does not press that soil again, and rises out of it
  as it rolls.
- Thrust: Janosi-Hanamoto's tau = (c + p tan phi)(1 - e^(-j/K)), integrated
  over the patch, is the tyre's longitudinal curve (the initial slope F l /
  2K, 83% of the capacity A c + W tan phi at i l / K = 6, the sliding level
  at full slip); sideways the soil holds 85% of it. TMeasy's combined slip
  and deflection dynamics then work on soil as on asphalt.
- Slip sinkage: past 20% slip a tyre digs its rut deeper, 5% of its static
  sinkage for each patch length of tread that slips, and rolling fills the
  rut back in over a patch length. Spinning in place it digs towards the
  firm layer, faster where it sinks more, which is how a car bogs.

## Roughness

Under the lattice's 2 m the ground carries an ISO 8608-like profile
(`roughness.ts`): eight sinusoids in fixed directions at log-spaced
wavelengths from 0.5 to 4 m, amplitudes as the square root of the
wavelength (the n^-2 displacement spectrum), unit RMS, scaled by the
surface's roughness. It is keyed by world position, so a bump is always in
the same place and the two tyres of an axle meet different ones; asphalt has
none.

## Engine and turbo

The torque curve is the steady state with boost built. A diesel's pedal asks
for fuel, so steady part-throttle torque is the pedal's share of the curve.
The turbo limits it in a transient: the smoke limit is the curve times
(0.5 + 0.5 x boost), and boost builds towards the pedal with a lag that
shortens with rpm (below 1,200 rpm it lengthens in proportion), so a pedal
stamped from idle gives half the curve at first. Earlier the model also
scaled boost by rpm, which counted the curve's own low-rpm shape twice: the
automatic sat at 812 rpm on a 20 degree slope and rolled back. An idle
governor adds fuel below 750 rpm, the fuel cuts near 4,000, motoring friction
grows with rpm, the engine stalls below 380 and the starter brings it back
with the pedal (or the clutch) down.

## Driveline

The engine and the four wheels are five speeds; everything that turns at a
fixed ratio to the wheels (propeller shafts, the transmission output and, in
gear, the turbine or clutch disc) is folded into the wheels' mass matrix.
What can slip or lock is a constraint row solved by projected Gauss-Seidel
each substep (Catto 2005): the dry clutch or the converter's lockup clutch,
the four brakes, the parking pawl and the transmission-drum handbrake as
friction rows; a locked differential as a bilateral row; the windup spring
between the shafts in 4H and 4L as a soft row (Catto 2011). The torque
converter's fluid coupling (K 10.77, stall ratio 2.0) is a smooth torque.

The automatic shifts on a throttle-dependent schedule with kickdown and
locks up from third; a sequential mode holds the gear the driver picks. The
manual is worked by an auto-clutch (the default) or the player's pedal. The
auto-clutch launches at an rpm that rises with throttle and opens before the
engine can stall: it reads the input shaft's rate and opens when the shaft
would fall under 1.1 x idle within 1.5 release times off the throttle, or as
soon as the engine drops under 85% of idle. With the player's clutch the car
stalls if the clutch is let out in gear at idle.

## The pedals and direction

W is the accelerator and S the brake. At a stop, holding S for 0.3 s selects
reverse, and in reverse S drives and W brakes; holding W at a stop in reverse
selects drive. Only a fresh press does it: S held through the stop keeps the
car stopped and braked, as a brake pedal does on a hill, and S let up and
pressed again, once stopped, backs it up. The same holds for W from reverse.
The manual follows the rule with the auto-clutch; with the player's clutch it
is a plain H-pattern through R, N and 1 to 5 on the shift keys.

## Driver aids

- ABS works per wheel above 1.5 m/s, so the car steers while it stops. It
  follows the pattern of Bosch's cycle:
  - past 14% braking slip, the pressure drops at once to 70% of the level the
    wheel locked at;
  - it holds there until the wheel spins back up. A wheel still locked after
    30 ms, usually a rear one the dive has unloaded, keeps bleeding;
  - it then steps back to 95% of the lock level and builds again.

  The first version bled a locking wheel towards nothing and built it back
  slowly. That cycled 2H's free front wheels so far that a stop from 10 m/s
  took 9.0 m. Now it takes 6.6 m, against 5.8 m in 4H, which couples the
  axles. Neither locks a wheel for more than a few steps.
- Traction control brakes a wheel that spins more than 3 rad/s faster than
  the other on its axle, in either direction of travel. It stands down while
  a locker is in, and `tractionControl = false` turns it off for tests.
- Downhill assist (the automatic, 4L, neither pedal) holds about 5 km/h on
  the brakes.
- Hill-start assist holds the brakes for up to 2 s on slopes over 3 degrees
  once the driver lets the brake up, until the drive pulls uphill with 5% to
  spare over gravity's pull along the car.

## Against the published numbers

| Check | Published | Model | Test |
|---|---|---|---|
| Ride height and axle loads at rest | CG 0.80 m, 52:48 | 0.798 m, 52.0:48.0 | `sim.car-chassis` |
| Approach and departure angles (static, SAE J1100) | 33 and 23 degrees | 32.8 and 23.0 | `sim.car-chassis` |
| Turning circle, kerb to kerb | 12.6 m | 12.75 m | `sim.car-chassis` |
| Tilt table | about 40 degrees (estimate) | tips between 38 and 42 | `sim.car-chassis` |
| Crawl ratio in first, 4L | 38.51 (AT), 48.69 (MT) | 38.51, 48.69 | `sim.car-driveline` |
| 100 to 0 km/h on dry asphalt | none published; the test allows 38 to 50 m | 42.3 m with ABS, in 3.1 s | `sim.car-driveline` |
| 10 m/s to 0 on dry asphalt, 2H and 4H | v^2 / 2g at the tyres' peak friction of 1 is 5.1 m | 6.6 m in 2H, 5.8 m in 4H, no wheel locked | `sim.car-driveline` |
| Holds on a 20 degree slope for a minute | under 1 cm (the plan's test) | under 6 mm (brake in D; handbrake alone in 4H) | `sim.car-driveline` |

The published approach and departure angles are static: SAE J1100 measures
them on the car at rest, as the steepest plane tangent to the loaded tyre
that clears everything ahead of (behind) the axle, and the chassis test
measures them that way from the hull's geometry. Driven onto a ramp at idle
creep, the leading tyre and springs squash as the axle takes the ramp, so the
bumper first touches at about 31 degrees in front and the tow bar at 22
behind, 1 to 2 degrees under the published figures. The dynamic test keeps a
wide band (clear 4 degrees under, touching 1 to 2 over) and the hull is not
tuned to it.

## Water

The car reads the water authority at the tyres' contacts, one tyre a step
in turn and all four at a start. In the worker each answer costs a
terrain height sample (about 13 us in Node), so asking for all four every
step doubled the car's step; the water a tyre has rolled towards in the four
steps (33 ms) since it was last asked is near enough. While all four tyres
are dry, a tyre passes its turn until it has rolled 0.3 m from where it last
asked or a quarter of a second has gone (a lake can be posted round a parked
car), so a parked or crawling car does not spend a fifth of its step asking
about water that is not there; from about 9 m/s every turn is taken. Whether
a tyre is under the surface is decided every step from its contact now. The wading depth is
the highest surface over the lowest contact. A tyre under the surface
reports no material and full wetness for the effects, and its bed is wet:
loam turns to mud, snow keeps its depth and hard ground keeps 80% of its grip.

- Buoyancy: the body's plan is eight columns, each reading the water at its
  nearer wheel, so a car half into a river floats at one end. A column
  displaces its share of the running gear (0.35 m^3 between the ground
  clearance and the floor) and of the body's sealed 5.2 m^3 above the floor,
  lifting at the immersed part's middle; each wheel displaces its submerged
  disc segment of 0.126 m^3, on its axle. Fresh water is 1,000 kg/m^3, the
  sea 1,025.
- The cabin floods towards the water's height up the body through the door
  seals, to within 5% in 60 s, and drains three times faster on land. At
  about 1 m of water the sealed body floats the car off its wheels until it
  floods.
- Drag on the wetted front (C_D 1.05) and side (1.2) below the surface, 85%
  solid under the floor, and on the plan in heave, all on the velocity
  through the water: a river's current, the sample's velocity, pushes the
  car downstream.
- The intake sits 0.7 m above the ground at the front of the engine bay. Water
  over it at the front wheels hydrolocks the engine: it stops and will not
  restart until a recovery.

The authority is the sea's still level and the lakes and rivers the
renderer draws, in one `WaterSurfaceComposite` (`src/sim/water/`). In a car
session (only there: nothing else reads them yet), the renderer's
`HydrologySystem` posts each resident region's rivers and lakes as it lands
and ends it after its crossfade. The worker keeps a region the car
is within a kilometre of, so a region paged out behind a car still in its
lake stays until the car has left. A river is its ribbon, the stations'
surface out to the half width with the current along it; a lake is its level
inside its ring. Either is water only over a bed below it. Where neither has
water the sea answers untouched, and where both do, a river or lake wins
only from a few centimetres above sea level, blending into the sea so a
river runs into it without a step.

The water path allocates nothing (`sim.car-budget`) while the authority's
call is monomorphic, as the worker's single authority is; a getter's double
return or a double argument to a call V8 does not inline is boxed, so the
column height and gravity travel in fields.

## Off the road

| Check | The plan's test | Model | Test |
|---|---|---|---|
| Sand and air-down | bogs from a stop on a 5 degree dune face at 2.4 bar; drives out at 1.2 | 2H at 60% pedal: 0.3 m and a 26 cm rut at 2.4 bar; aired down where it stood, 56 m in 15 s | `sim.car-terrain` |
| Steep climb | 30 degrees from a standstill in 4L; fails on loose ground in 2H | 4L at 60% pedal climbs over 20 m on rock and asphalt; 2H on gravel slides back | `sim.car-terrain` |
| Cross-axle ditch | open diffs with traction control off: stuck; traction control: crosses slowly; rear locker: crosses | a 0.7 m ditch at 45 degrees at a crawl in 4L: open diffs stop with the light wheels at 22 rad/s; traction control crosses after a stall, braking wheels spinning to 8 rad/s; the rear locker crosses with them under 5 | `sim.car-terrain` |
| Underbody | the hull scrapes and high-centres from the geometry | a berm between the tracks: 0.25 m clears, 0.32 m drags the diffs and the car goes on, 0.42 m beaches it on the axles | `sim.car-terrain` |
| Surface parity | the worker's material maps to the bake's soil model at least 98% of the time | 1,235 of 1,236 land cells, six provinces, at midsummer; 1,236 of 1,236 in mid-January | `sim.car-terrain` |
| Seasonal snow | the car drives the snow that is drawn | in the temperate and boreal provinces, cells that are loam on day 171 and that the bake paints loam then are snow on day 15 when the bake paints them snow, read again from the same cache after the day changes | `sim.car-terrain` |
| Snow | packed snow is slippery; deep snow is soft | 4H from 10 m/s: packed snow stops in 3.8 times asphalt's distance (23 m against 6 m); parked on 0.2 m of deep snow the tyres sink to the ground under it, and half throttle takes 6.6 s to 10 m/s against asphalt's 4.5 | `sim.car-terrain` |
| Wading | a 0.6 m ford at walking pace is fine; 0.9 m floods the intake and stops the engine | 0.6 m: across at 1.4 m/s, engine running; 0.9 m: drowned on the way down, short of the deep bed | `sim.car-water` |
| Current | a 1.5 m/s river at 0.7 m pushes the car measurably downstream during a crossing | held square to the bank, it crabs 1.3 m downstream over a 30 m crossing; unsteered, the light rear swings downstream and the car yaws upstream | `sim.car-water` |
| Floating | (the plan's buoyancy and 60 s cabin flooding) | parked under 1.6 m of still water: afloat at first, on its wheels again after 90 s | `sim.car-water` |

On a 30 degree slope in 2H only the rear tyres pull: they carry about 56% of
the car's weight there, so the climb needs a friction of about 0.9. Asphalt
(1.0) makes it; rock (0.75) and gravel (0.65) do not. In 4L both axles pull
and gravel's 0.65 is still marginal at 30 degrees (atan 0.65 is 33 degrees
before rolling resistance): the car creeps a few metres and stops, as loose
stone on that grade does.

## Driving the world

`scripts/ground-vehicle-probe.mts` drives the car headless over the real
world, built as the worker builds the car's: the terrain with the road
regions round the home airport installed (their earthworks and paint), the
airports', marina's and guardrails' colliders, and the sea and the posted
rivers in one water composite, in still air. A scripted driver steers by pure
pursuit along a 2 m line, follows a speed profile with a PI on the
accelerator, and when stuck backs 4 m off in R and tries again. It drives
three legs on five seeds in each of the six forced climate provinces, which
change the surfaces but not the ground, so a seed's routes are the same in
every province. The step times are this cloud box's (about 1.6 times slower
than the tuning box), after the first 2 s of a leg.

| Leg | Finished | Stuck events | Rolled | Mean speed | Peak pitch, roll | Step: mean, 99.9%, worst |
|---|---|---|---|---|---|---|
| Open country: 2 km in 250 m legs from the airport road head, 4H at up to 36 km/h, roads crossed at a walk | 30 of 30 | 0 | 0 | 32.8 km/h | 21.6, 30.8 degrees | 95 us, 1.3 ms, 11 ms |
| The steepest fall-line climb within 4 km, 4L from rest at 3 m/s | 24 of 30 | 18 | 0 | 9.3 km/h | 31.3, 12.3 degrees | 89 us, 1.8 ms, 7.4 ms |
| A ford posted across the open line (10 m wide, 0.5 m deep, 1 m/s), at 2 m/s | 30 of 30 | 0 | 0 | 13.3 km/h | 6.7, 5.8 degrees | 91 us, 1.8 ms, 8.8 ms |

- Open country. Seed 2's line stops at 1 km, where no bearing passes the
  line's tests. The worst roll, 30.8 degrees on seed 3 in every province, is
  a gravel road crossed on a diagonal at 2.5 m/s: one front wheel drops into
  the 0.5 m ditch while the diagonal rear climbs the far wall and the other
  front tyre unloads. Before the line kept to roads at grade it crossed one in
  a cut on seed 3, and the car climbed the 30 degree batter on the forest
  floor and rolled, in five provinces of six.
- The climb. The default seed's slope averages 15.6 degrees over its 120 m
  and reaches 30 over 10 m: the car stops at 126 m on about 31 degrees in
  every province, three tries each, on forest floor, grass and dry grass
  alike. Their sandy loam's shear gives out there in 4L (asphalt and rock
  climb 30 degrees; see Off the road). The other seeds' slopes, 15 to 18
  degrees on average and up to 24, are climbed at 10 km/h.
- The fords are crossed at 13 km/h with 0.50 to 0.60 m at the deepest
  wheel, the engine running.
- The step. At speed on the real world a step costs about 90 to 100 us here,
  about 60 on the tuning box. Of that the substeps are about 62 us (the tyres
  32, the soil 6), the contacts against the lattice 14, the hull's probes 15
  and forces 13, the water 11 (the calm sea's bed is a terrain height, about
  13 us, on each turn the dry poll takes) and the surfaces 9. The slow steps
  (1 to 2 ms at the 99.9th percentile, 4 to 11 ms at worst) follow no event
  of the drive and do not repeat from run to run. About half fall in a
  young-generation collection (1 to 3 ms, up to 9) of the probe's own
  garbage; a handful are V8 compiling the first second from rest; the rest
  are this box. A fixed, allocation-free 100 us loop timed the same way here
  has 20 to 58 of every 106,000 runs over 1 ms and its worst at 4 to 8.5 ms.
  New lattice nodes (13 us each) and a new surface cell (25 us) do not make
  a slow step on their own. `PROBE_SLOW=1000` lists every step over 1 ms with
  what happened in it.

The show drive, on the default world: from the car's start on the apron
round onto the sealed airport road, along it in 2H to its end, onto the
gravel in 4H, along it to the steepest 200 m of gravel climb within reach,
and through a ford posted across the gravel beyond. 5.26 km in 442 s, no
stuck event; the step 96 us mean, 0.98 ms at the 99.9th percentile, 6.2 ms
worst.

| Stretch | m | s | Average km/h | Top km/h | Climb m | Peak pitch, roll | Wading m | Range, gears | Tyres on |
|---|---|---|---|---|---|---|---|---|---|
| Apron, a U-turn onto the road head | 80 | 20 | 14.3 | 17.3 | -2.5 | 10.0, 10.1 | 0 | 2H, 1-2 | grass 66%, asphalt 34% |
| Airport road | 1,377 | 85 | 58.1 | 63.0 | -13.0 | 4.4, 3.5 | 0 | 2H, 1-5 | asphalt |
| Hairpin onto the gravel | 45 | 15 | 10.9 | 15.8 | 1.9 | 26.4, 31.7 | 0 | 2H to 4H, 1-2 | gravel 67%, grass 23%, asphalt 10% |
| Gravel | 3,180 | 234 | 48.8 | 53.0 | 18.6 | 4.5, 5.0 | 0 | 4H, 1-5 | gravel |
| Gravel junctions, at a walk | 56 | 18 | 11.3 | 18.4 | 0.5 | 13.7, 20.3 | 0 | 4H, 1-2 | gravel 71%, asphalt 29% |
| Gravel climb, 7.7% over 205 m | 204 | 15 | 49.3 | 50.9 | 15.7 | 7.0, 0.5 | 0 | 4H, 4 | gravel |
| Gravel beyond | 232 | 18 | 46.6 | 50.9 | 10.7 | 4.0, 0.9 | 0 | 4H, 2-4 | gravel |
| To the ford | 34 | 17 | 7.2 | 15.9 | 1.0 | 2.8, 0.7 | 0 | 4H, 1-2 | gravel |
| Ford, 10 m wide, 0.5 m deep, 1 m/s | 14 | 7 | 6.8 | 7.8 | 0.1 | 1.4, 0.7 | 0.64 | 4H, 1 | water 72%, gravel 28% |
| Out of the ford | 41 | 11 | 14.0 | 16.5 | -0.4 | 3.3, 0.9 | 0 | 4H, 1-2 | gravel |

Two of its stretches are the roads', not the car's. The sealed road ends at
the end of its own gravel road, which leaves at 143 degrees: tighter than the
car's lock, so at full lock and a walk it runs 6 m wide of the line through
the ditch and onto the batter (a driver would take it in three points). And
where that gravel road crosses the sealed road there is a 0.6 m step. On a
rig, a 0.5 m V ditch 1.5 m wide (the gravel class's, 34 degree walls) bottoms
a tyre on its rim at 100 to 140 kN when hit at 3.5 to 5 m/s at 30 to 50
degrees, and can roll the car; at 2.5 m/s it is crossed at any angle without rolling, and a
3 m wide ditch of the same depth (18 degree walls) rolled it in no case.
