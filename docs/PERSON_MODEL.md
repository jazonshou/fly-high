# Person model: the walker

How the walker stands, walks, runs, climbs, jumps, lands, wades, swims and
dives, what it collides with, what each part of the model is taken from,
which numbers are published and which are estimates, and what the tests
hold it to. The code is `src/sim/person/` (the walker is `walker.ts`, its
laws `walkerLaws.ts`); every number a person has is in one record, `PERSON`
(`src/vehicles/person.ts`), marked PUBLISHED or ESTIMATE. The walking plan
(2026-10-27) and Jason's answers D1-D6 set the scope: one adult on foot in a
car session, getting in and out of the Land Cruiser, never hurt by a fall
(D5), with no breath limit.

The walking session (`walkingSession.ts`: the parked car, boarding, the
prompt), the character camera and the figure are the lead's and W2's; this
document covers the walker's physics and what it reads from the world.

## The person

One adult, stature H = 1.76 m. Body proportions are Drillis and Contini's
(1966) shares of the stature: the eye at 0.936 H (1.65 m, the first-person
view), the knee at 0.285 H, the navel at 0.6 H and the nipple line at
0.72 H, which set the wading depths below.

The body is a kinematic capsule, radius 0.3 m (ESTIMATE: the shoulders and
the arms' swing) and 1.76 m tall, held as four spheres of its radius over
the feet: the foot sphere (bottom at the feet), the step sphere (bottom at
the step height, 0.4 m), the waist and the head (top at the stature).
Neighbours are at most 0.4 m apart, so the union is never thinner than
0.22 m. A
swimmer is two spheres instead: one at the eye and one at the chest, half a
metre back along the body's pitch.

Frames: world +Y up; heading 0 faces +Z and +X is heading 90 degrees, as
`FlightTelemetry.heading`; the body's +X is its facing. The state's position
is the feet (while swimming, the eye less the eye height).

## The step

`Walker.step` runs at the sim's 120 Hz, in one of five regimes: ground,
air, swim, dive and mantle. A step reads the controls (a move vector the
main thread has already turned into world axes by the camera's yaw, run,
jump, dive, rise and the look's heading and pitch), asks the water, moves
the regime, and writes the payload.

The step is deterministic (bit-identical over five minutes of identical
inputs) and allocates nothing once V8 has optimised it, apart from the two
numbers of each call into the water authority and the terrain, which V8
boxes where it does not inline the call (`tests/person.walker-alloc.test.ts`
counts them). The rules that keep it so are the car's (docs/CAR_MODEL.md,
"The step"): helpers take and return no fractional numbers (they pass them
in fields), the laws `walkerLaws.ts` states as functions are evaluated in
place from the same tables (the tests hold the two together), the rare
turns (a jump, a landing, a plunge, a mantle) are written into the hot
functions' bodies so they are optimised with them, and a field that will
hold fractions starts from -0, never the integer 0, so its object is not
re-shaped at the first fraction.

Over a lap of the test course (`tests/support/walkerCourse.ts`: a shore
rising out of a swell, a bobbing pontoon, stairs, a drop, trunks among
dunes; walking, running, jumping, wading, swimming, diving and mantling) a
step costs about 2 us on the tuning box against the plan's 20 us
(`tests/person.walker-budget.test.ts`, timed as a ratio to the reference
kernel). Swimming in the sea, the sea twin's own share comes on top: see
Water.

## Ground

The terrain is the car's: the authority's 2 m lattice read through the same
Catmull-Rom (`TerrainLatticeCache`), with the marina apron's front held
level (`DeckGround.hullGround`). Collider tops are ground too: decks,
pontoons, floors, stairs, the parked car's roof. To find the floor under
the feet the walker sweeps a sphere of its radius down the column, from the
step height above the feet to the snap-down below them. A collider face up
to 45 degrees is a floor (its own slope counts), an edge is a step (level
under the foot), and a contact steeper than 45 degrees is a wall. Where the
foot sphere meets the next riser of a stair first, the face straight under
the centre is the floor, so stairs of 0.18 m risers are climbed without
leaving the ground.

Moving across, the capsule is the three spheres from the step sphere up, so
a ledge up to 0.4 m (`stepUp`) passes under it and is then stood on; a
0.5 m one stops the walker. Walking, the feet follow drops up to 0.45 m
(`snapDown`); past that the walker falls. A moving collider under the feet
(a pontoon on the sea twin) carries the walker at its surface velocity.

Ground steeper than its material's limit cannot be climbed, and the walker
slides down it with the limit as its friction angle (so the slide starts
from rest at the limit and grows past it), steering across the fall line
with a fifth of the ground's control. The limits, by `SurfaceMaterial`
(ESTIMATES, the plan's "Slopes"; loose ground at its angle of repose):

| Surface | Limit |
| --- | --- |
| Grass, soil, forest floor, shrub, dry grass | 35 degrees |
| Rock, basalt, asphalt, concrete, collider tops | 45 degrees |
| Sand, gravel and tephra (scree) | 33 degrees |
| Snow | 30 degrees |

## Speed and turning

Walking 1.4 m/s is the preferred adult walking speed (PUBLISHED: Bohannon
and Andrews 2011, 1.3-1.4 m/s), which is also Tobler's flat 5.04 km/h. The
gait changes from walking to running at 2.0 m/s, the measured preferred
transition speed (PUBLISHED: Thorstensson and Roberthson 1987, Hreljac
1993): a Froude number v^2 / (g L) of 0.44 with leg length L = 0.53 H,
under the 0.5 where walking stops being mechanically possible (Alexander
1989). Running is 4.5 m/s (ESTIMATE). A stick's deflection asks anything
between, never under 0.3 m/s; under 0.05 is no input.

On a slope the speed is multiplied by Tobler's hiking function divided by
its flat value (Tobler 1993): exp(-3.5 (|s + 0.05| - 0.05)) for slope s
(rise over run along the move). A gentle 5% descent is fastest, about 1.19,
and a 40% descent is as slow as a 30% climb. Running softens it (ESTIMATE):
the exponent is 0.6 of the walk's, so a 10% climb keeps 81% of the run
speed where a walker keeps 71%.

The walker reaches its target speed at 8 m/s^2 and slows at 12 m/s^2,
about one stride either way. The facing turns toward the move at 540
degrees per second walking and 270 running, so a run carves a curve; 180
swimming and diving.

## Obstacles

The walker collides with two collider worlds, through `ColliderWorld`'s
`sweepSphere` and `raycast` (both exact: each shape's swept volume is
solved in closed form, and a sphere already touching a collider is stopped
only when it moves deeper in, so it can slide off a deck or a wall):

- **The world's colliders** (`CarColliders`): every airport's buildings,
  the home marina's piers, piles, pontoon floats and quay walls, the roads'
  guardrails, and the parked car as one box once it sleeps. A guardrail is
  met as its rail alone: from 0.5 m under the ground to the drawn rail's
  0.75 m top and 0.15 m deep behind its face (the car's box behind it is
  3 m tall and 2 m deep), so the strip behind a rail is open ground and a
  jump at a rail climbs it.
- **The near solids**: the trunks, rocks, logs and stumps the near view
  draws round the walker (below). Only the walker reads them; the car keeps
  trees soft.

A move is collide and slide: up to four passes, each to the first touch
less a 1 cm skin, the rest slid along the surface touched (along walls only
and upright, on the ground), the velocity losing its push into each
surface. A 2,300 kg car is not pushed.

A jump at a ledge in reach that a jump cannot clear climbs it, by the same
mantle as out of the water (below): a ledge above the step and no more than
1.0 m over the feet (`climbHeight`, ESTIMATE). So a 0.9 m wall is climbed
with a jump at it, and a 1.2 m one is not.

### The near solids

The detail worker lists the solids round the walker from the cells it
already retains, with the near view's own selection
(`src/render/webgpu/detail/nearSolidsSelection.ts`), so the walker meets
what is drawn:

- **Trunks.** A stem has a solid exactly when the near band draws it (its
  stem key at the density law's near cap), and the solid follows its drawn
  bark: the tree skeleton's trunk of its species (or family) and geometry
  variant, scaled by the record's height and radial scale, sheared by the
  "lean" character modifier and cut by the broken-top ones as the vertex
  shader does, then turned by the stem's yaw and lean. Two capsules follow
  it: from half a metre under the base to 2.5 m up, with the drawn trunk's
  radius 1.2 m up (the walker's chest), then on to the lowest branch (a
  palm's crown, never past 0.9 of the height, nor a broken top's 0.72) with
  its radius halfway. Wind sway and the crown wobble's few per cent are
  left out. Up to 2.5 m the capsules sit on the drawn bark: over every
  trunk within 48 m of a forest cell, the median ratio of a bark vertex's
  distance from the axis to the capsule's radius is between 0.8 and 1.2.
- **Rocks.** A drawn rock is a displaced icosphere squashed to the rock's
  height and sunk into the ground: its top and its ring at the placement
  fix a sphere whose cap above the ground is the rock, tilted with it.
- **Logs and stumps.** Capsules along the clutter prototypes' axes, scaled
  by the piece's size and laid on the ground as drawn.
- Grass, shrubs, branch litter and moss stay soft.

A list covers a disc round the walker: 48 m, 32 m on Low (the quality
profile's `nearSolidsRadiusMeters`). The renderer asks again once the
walker has moved 16 m from the last list's centre, or a cell under the disc
has been generated again, or the profile changed, one request at a time;
inline cells are listed on the main thread, retained ones by the worker. So
the walker is always at least 32 m (16 m on Low) inside the newest list.
Each list goes, versioned, to the simulation worker (the `nearSolids`
command; `SurfaceVehicleEnvironment.nearSolids`) and stays on the main
thread as a collider world the character camera's boom sweeps.

## Jumps, falls and landings

A jump press on the ground takes off at 2.97 m/s, raising the centre of
mass 0.45 m (ESTIMATE), with the floor's velocity. In the air the walker
keeps a fifth of the ground's control and cannot jump again; it cannot jump
out of water deeper than half its stature. Falling, it meets decks and the
terrain at the speed it hits them (a sweep of the foot sphere, so a thin
deck stops a 50 m/s fall).

Landings never hurt (D5). By the speed at touchdown, the plan's equal drops
v^2 / 2g:

| Landing speed | Drop | What happens |
| --- | --- | --- |
| under 5 m/s | under 1.3 m | a normal landing |
| 5 to 8 m/s | 1.3 to 3.3 m | a hard landing, a 0.4 s crouch |
| 8 m/s or more | over 3.3 m | a roll, 1.1 s before it can move |

The crouch and the roll lock the walker's input until they are over. The
newest spot stood on safely (dry, not sliding, not locked, still underfoot,
at least half a metre from the last) is where `recover` (R) returns it.

## Water

The walker reads the session's water authority: in a car session the
worker's `WaterSurfaceComposite(CarSea, hydrology, seaLevel)`, that is, the
boats' sea twin (the drawn ocean's spectrum, seed and weather, calmed in the
home marina's basin) and the lakes and rivers. By depth over the feet:

| Depth | At H = 1.76 m | What happens |
| --- | --- | --- |
| under 0.15 H | under 0.26 m | walking, with splashes (the footstep surface is water past 2 cm) |
| 0.15 to 0.75 H | 0.26 to 1.32 m | wading, slower the deeper |
| over 0.75 H | over 1.32 m | swimming |

Wading (ESTIMATES on Barela et al. 2006, whose adults chose about a third
of their land speed at chest depth): the speed falls from the walk speed at
0.15 H to 1.0 m/s knee deep (0.285 H), 0.6 waist deep (0.6 H) and 0.4 chest
deep (0.72 H), held there to the swimming depth; running in water goes 1.5
times as fast, never past the run. A wader is carried by up to 30% of the
current, more the deeper.

Swimming (ESTIMATES): breaststroke 0.8 m/s, crawl 1.3. The body floats with
the eye 5 cm above the local wave height, following the surface's rise and
fall (a correction at 4 per second, at most 2 m/s), and drifts with the
current. A swimmer stands again where the bottom comes within 0.7 H of the
surface, so a wave cannot flicker it between swimming and wading. The body
lies back from the eye at its stroke pitch: 1.25 rad treading water,
0.2 swimming, 0.05 crawling, changing at 2.5 rad/s.

Diving (ESTIMATES): Dive takes the swimmer under and Rise brings it up. Under
water it swims where the camera points, pitch included (the move's forward
part pitched by `lookPitch`), at 0.9 m/s or 1.4 with run; with no input it
drifts up at 0.1 m/s and settles at the surface. The current carries it
less deep down (by exp(-depth / 3 m), as the waves' orbits fade). It meets
the bed (its eye and chest spheres stay a radius above the terrain) and
every collider on the way: the marina's piles, floats and quay walls. A
plunge from a height carries on under against the water's quadratic drag
(1.5 per metre: a 1 m drop stops about 1.5 m down) and comes back up.

Climbing out: when a ledge no higher than 0.6 m over the water lies within
0.7 m ahead (a pontoon's edge, a slipway, a step of the shore), level
enough, with nothing in the way and room to stand, a mantle carries the
swimmer (or a wader from 0.4 H deep) onto it in 1.0 s. The marina's quay
walls stand higher and are not climbed. Lakes and rivers work the same way,
and a river's current pushes the swimmer downstream.

### The sea

`CarSea` asks the sea twin only where the ground under the one asking is
below the still sea or within 0.1 m of it: on land the twin is neither
stepped nor sampled, so walking costs it nothing. Before each sample the
walker focuses the twin on itself (a footprint 1.8 m by 0.6 m along its
heading), so the twin's fast path (its local expansions and the 8-32 m
band's grid) is laid round the swimmer. Coming back to the sea after a dry
spell costs one step of 0.5 to 2.4 ms while the twin resyncs its waves.

Two rules fit the walker to the drawn sea:

- The sea stands only over ground below its still level, as the ocean is
  drawn and as the car reads it: above it the terrain draws the swash. So a
  Cloudy crest running over sand 5 cm above the still sea does not wade the
  walker 0.8 m deep.
- In and by the water the walker asks one step in four (on a deck more than
  a metre above the water, one in sixteen) and carries the answer between
  by the surface's vertical velocity and slope. The swimmer's eye follows
  the twin's exact surface within 7 mm rms in Clear and 14 mm in Cloudy,
  as it did asking every step.

The twin's cost is set by its own rebuilds, which follow time rather than
samples: a swimmer's step with the twin costs about 35 us on the tuning box
(the brief's figure is 0.1 ms; `tests/person.walker-sea-budget.test.ts`).
One twin serves the walker and the parked car. While the car is still
settling in the same sea it asks first each step, so the twin follows its
wheels and the walker's answers are the twin's exact sums, about 0.2 ms
each: asked one step in four, the two together cost about 115 us a step
(the car alone about 82). A handbraked car sleeps after 1 to 8 s in Clear
surf and 10 to 24 s in Cloudy surf 0.45 to 0.75 m deep; at 0.9 m in Cloudy
surf it keeps rocking and never sleeps, which the session keeps as real.

## Payload

Each snapshot carries the `"person"` payload (`PersonVisualState`) the
figure, the camera, the HUD and the sound read: the mode (stand, walk, run,
air, land, wade, swim, dive, mantle; the session adds board and seated),
the speed over what is under the feet,
running, grounded, the ground's slope along the facing, the water's depth
over the feet, how much of the body is under (0 dry .. 1 the head under),
the eye's depth below the local surface, the swim pitch, the latest
landing's speed and age, and the footstep surface: a `SurfaceMaterial` id on
the ground, `PERSON_SURFACE_COLLIDER_BASE` plus the collider material on a
deck or floor (the near solids' are 301-304), `PERSON_SURFACE_WATER` in
water and -1 in the air.

## Tests

- `tests/person.seam.test.ts`: the walker behind `createPersonSimulator` on
  the surface seam (Tobler's flat speed, the gait switch under Froude 0.5,
  a jump's height, floating, a box collider, recovery).
- `tests/person.walker.test.ts`: the laws (slope limits, running's
  softening, the wading curve, landings) and each behaviour: walking,
  turning, slopes and slides, a 0.35 m ledge stepped and a 0.5 m one not,
  stairs, a moving pontoon, trunks, guardrails, a climbed wall, jumps,
  landings, a 50 m/s fall onto a thin deck, recovery, wading, swimming,
  a river, a slipway, mantles onto a pontoon and not a quay, diving, the
  bed and piles under water, and a plunge from a pier.
- `tests/person.walker-sea.test.ts`: the walker in a car session's sea over
  the real twin: the swell tracked within 7 and 14 mm rms with no exact
  sums, the twin left alone on land and asked from the waterline, the
  parked car's shared sea, and no sea over the swash.
- `tests/person.near-solids.test.ts` and
  `tests/render.near-solids-feed.test.ts`: every trunk the near view draws
  within 25 m has exactly one solid and no other stem has one, on every
  tier; rocks, logs and stumps the same, litter and moss none; the bark
  fit; the prototypes' shapes; the walker stopped by a trunk; the worker's
  answer, the client and the runtime's 16 m refresh.
- `tests/person.walker-budget.test.ts`, `tests/person.walker-sea-budget.test.ts`
  and `tests/person.walker-alloc.test.ts`: determinism, the budgets and
  the allocations.

## Known limits

- A pontoon bobbing on the sea twin still allocates about 140 bytes a step
  in the course (the kinematic pose's path and the colliders' box overlaps
  boxing their doubles); the allocation test keeps its pontoon still.
- The near solids leave out wind sway and the crown wobble, and a trunk is
  two straight capsules: a strongly curved trunk is followed to within the
  bark fit's spread above.
- No breath limit and no fall damage (D5).

## Sources

- Alexander, R. McN. (1989). Optimization and gaits in the locomotion of
  vertebrates. Physiological Reviews 69(4).
- Barela, A. M. F., Stolf, S. F. and Duarte, M. (2006). Biomechanical
  characteristics of adults walking in shallow water and on land. Journal
  of Electromyography and Kinesiology 16(3).
- Bohannon, R. W. and Andrews, A. W. (2011). Normal walking speed: a
  descriptive meta-analysis. Physiotherapy 97(3).
- Drillis, R. and Contini, R. (1966). Body segment parameters. Technical
  Report 1166-03, New York University School of Engineering and Science.
- Hreljac, A. (1993). Preferred and energetically optimal gait transition
  speeds in human locomotion. Medicine and Science in Sports and Exercise
  25(10).
- Thorstensson, A. and Roberthson, H. (1987). Adaptations to changing speed
  in human locomotion: speed of transition between walking and running.
  Acta Physiologica Scandinavica 131(2).
- Tobler, W. (1993). Three presentations on geographical analysis and
  modeling: non-isotropic geographic modeling. NCGIA Technical Report 93-1.
