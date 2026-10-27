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
inputs) and allocates nothing once V8 has optimised it: besides keeping to
scratch objects, no number crosses a call in the hot path. V8 boxes a double
passed to or returned from a call it does not inline, and `Math.hypot` boxes
its arguments, so the step's sizes, the speed and the slope are fields, the
components take their inputs as fields or objects, and lengths are square
roots of sums. A choice between a computed double and a double argument
(`k === 5 ? -halfTread : halfTread`) is boxed too; a sign times the argument
is not. On rolling ground a step costs about 30 to 40 us here, inside the
plan's 60 us on the tuning box (`tests/sim.car-budget.test.ts`).

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
node once as the car reaches it.

The hull is spheres on the frame and axles (bumpers, sills, tank guard,
diffs, tow bar, roof) that meet the ground and the world's colliders with a
stiff penalty and Coulomb friction; `touching(part)` reports each part.

## Tyres

TMeasy (Rill, Road Vehicle Dynamics, 2011): each direction is a curve of
initial slope, peak and sliding level, interpolated in load between the
nominal and twice it; combined slip uses TMeasy's generalised slip, so
braking in a turn trades grip as a real tyre does. Rill's first-order
deflection dynamics give a relaxation length of about half a metre at speed
and a carcass spring and damper at a standstill, so a braked car stands on a
slope without jitter. The radial stiffness follows the pressure (2.4 bar on
the road, 1.2 for sand). Asphalt is the curves' reference; other surfaces
scale the friction.

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

- ABS holds about 14% braking slip per wheel above 1.5 m/s, bleeding and
  restoring each wheel's pressure, so the car steers while it stops.
- Traction control brakes a wheel that spins more than 3 rad/s faster than
  the other on its axle, in either direction of travel.
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
| 100 to 0 km/h on dry asphalt | none published; the test allows 38 to 50 m | 47.1 m with ABS | `sim.car-driveline` |
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
