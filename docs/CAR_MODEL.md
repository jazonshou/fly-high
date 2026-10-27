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
classifying a new surface cell (see Surfaces): besides keeping to
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

- ABS holds about 14% braking slip per wheel above 1.5 m/s, bleeding and
  restoring each wheel's pressure, so the car steers while it stops.
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

## Water

The car reads the water authority at each tyre's contact once a step (the
sea today; lakes and rivers once the hydrology sources reach the worker).
The wading depth is the highest surface over the lowest contact. A tyre
under the surface reports no material and full wetness for the effects, and
its bed is wet: loam turns to mud and hard ground keeps 80% of its grip.

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
