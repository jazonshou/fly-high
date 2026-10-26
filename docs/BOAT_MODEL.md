# Boat model: the Runabout 21

How the speedboat floats, planes, turns, ventilates, slams and capsizes, what
each term is taken from, which numbers are fitted, and how the results compare
with the trials and the literature. The code is `src/sim/boat/`; the hull's
shape is `src/vehicles/boat/hullLines.ts`. `npx tsx scripts/boat-probe.mts`
prints every table below (pass section names, `rpm accel chop savitsky turns
porpoise slam`, to print only those).

## The boat

A generic 21 ft deep-V sport runabout with a 200 hp V6 outboard (decision D3):
6.55 m from the transom's bottom edge to the stem head, 2.59 m beam, 19 degrees
of deadrise at the transom warping to about 50 at the forefoot, three lifting
strakes and a reverse chine a side. 1,800 kg as driven, inertia 1,650 / 5,300 /
5,100 kg m^2 (roll, yaw, pitch), CG 1.95 m forward of the transom and 0.56 m
above the keel. The propeller is a 14.5 x 19 in three-blade stainless on a
1.85:1 gearcase; the engine curve is a 200 hp V6 four-stroke's (149 kW at
5,500 rpm, fuel cut at 6,000). Every number in `RUNABOUT_21`
(`definition.ts`) cites its source.

Frames: body +x forward, +y up, +z starboard, origin at the CG. Roll is
positive starboard down; `steer` +1 turns to starboard.

## The step

`BoatSimulator.step` runs at 120 Hz. Each step samples the water once at every
hull point (171 of them: the clipped mesh's vertices, the keel strips, the
propeller hub, gearcase, tabs, transom and CG) for height, slope, orbital
velocity and the surface's rate of change, then runs two 240 Hz substeps that
advance that sampled surface by its own derivatives. The stiff hull passes run
at 240 Hz while the sea is asked once. The sea twin's sampler gets one focus a
step, fitted at construction to every point the hull can put out over the
trim and steering range (`fitWaveFocus`), so the twin's fast path covers every
sample. Nothing in `step` allocates. On the breezy sea at 30 kn a step costs
about 0.2 ms on the tuning box (`tests/sim.boat-budget.test.ts`).

The rigid body (`src/sim/rigidBody.ts`) solves (M_RB + A) nu' = F each
substep, with A the planing strips' 6x6 added mass, so the stiff slamming
terms stay stable at a fixed step.

## Hydrostatics

Kerner's clipping (2015): every triangle of a closed coarse hull mesh is cut
against the local water surface and each submerged piece is pushed by
-rho g d n dA, integrated exactly for the linear depth field. Because the
surface is the wave surface, the Froude-Krylov wave load comes with it, and an
upright, heeled, swamped or inverted hull integrates the same way. The mesh
floats at the rest waterline the drawn boat uses and matches the lines' own
section integral to 2% (`tests/sim.boat-hydrostatics.test.ts`). A little linear
radiation damping (8% of critical in heave, pitch and roll) stands in for wave
radiation at rest and fades out as the hull starts to plane.

## Planing: 2D+t strips

`planing.ts`, after Zarnick (1978) with Wagner's splash-up and Garme's (2005)
near-transom pressure release. An earth-fixed transverse plane sees the hull's
sections pass through it aft at U: each section is a wedge driven into the
water, and the water it accelerates pushes back with the rate of change of its
momentum plus a cross-flow drag,

    f = D(m_a V)/Dt + 1/2 C_dc rho c V|V|,    m_a = k rho (pi/2) c^2,
    c = lambda d / tan(beta)   (Wagner: lambda = pi/2 once the jet runs free).

m_a DV/Dt goes to the left-hand side as added mass; the convective part and
V Dm/Dt stay explicit. Like Zarnick, the momentum term is dropped while a
section leaves the water (water does not pull).

Each section is two half-wedges, port and starboard, so heel and sideslip act
panel by panel:

- **Heel.** Each panel's slope against the local water is n_y tan(beta) +/- n_z,
  so the low panel's effective deadrise falls and its wetted beam widens: the
  planing roll stiffness.
- **Sinking, not sliding.** The wetted beam grows with the section's sinking
  across the local water line, dd/dt = n_y V - v_z n_z. A heeled hull sliding
  sideways moves along the tilted water line, not into it. (Counting the
  body-y speed alone, as the first version did, read a slide at v_z as sinking
  at v_z sin(heel); it lifted the stern in hard turns and launched the
  top-speed spin-out into the air.)
- **Oblique-asymmetric loads.** A panel's speed into the water is its own
  normal speed: the keel's penetration, the roll rate at its pressure centre,
  and the sideslip driving the leading panel deeper (+/- tan(beta) v_z). That
  presses on the water the panel already has but does not widen it. Each
  panel's force and added mass act along its own normal (n_x, n_y,
  -side tan(beta)), so a sliding deep-V's loaded leading panel pushes inboard,
  its line of action passes outboard of the CG, and the hull heels into its
  turns.
- **Chine-first entry.** Heeled past its deadrise, a panel's lowest edge is the
  chine. It wets inboard from the chine before the keel touches: a band whose
  inner edge moves at that point's sinking speed over the panel's descent, so
  a boat landing heeled off a crest takes the slam on its low side. Once the
  keel is under the whole panel is wet and its mass stops growing.
- **Strakes.** Once the Wagner jet would cross a strake the wetted beam stops at
  its edge and the panel outboard of it piles up afresh; dm/dd is taken across
  each strip from its two edges so the stall is integrated along the hull
  instead of switching strips on and off.
- **Sway.** A second slender-body strip carries the topsides once the chine is
  under (the mirrored-plate added mass k rho (pi/2) d^2) and a separated
  cross-flow drag on the section's draft, fading from the full draft at rest to
  the topsides alone on the plane, where the bottom's trailing side ventilates.

## Resistance

- Skin friction: ITTC-57 plus a 0.0004 roughness allowance, spread over the
  clipped mesh's wetted pieces and scaled to the strips' wetted bottom once the
  hull runs.
- The pre-planing hump the strips and the mesh leave out (wave-making): a
  calibrated drag peak at Fn 0.57 with its bow-up moment, and Holtrop and
  Mennen's immersed-transom term while the transom is wet, handing over to the
  dry transom's lost hydrostatic push.
- Savitsky (1964) checks the whole: the bare hull towed through its CG trims
  within a degree of his equations and drags within 15% from 16 to 36 kn
  (`tests/sim.boat-savitsky.test.ts`).

## The outboard

`propulsion.ts`: T = K_T(J) rho n^2 D^4 and Q = K_Q(J) rho n^2 D^5 on a fitted
quadratic high-pitch propeller (open-water efficiency 0.69 near J = 0.95), wake
fraction 0.04, thrust deduction 0.05, against the engine's full-throttle curve
through a crank and propeller inertia. Speed, rpm and slip all come out of the
engine curve meeting the propeller curve meeting the hull's drag; there is no
speed table.

- Ventilation: below 82% disc immersion against the local surface (behind a dry
  transom, the transom's own hollow) the blades draw air, K_T and K_Q fall to a
  quarter by 50%, and the engine flares toward the limiter. Air re-attaches
  slower than it arrives.
- Back cavitation: Barnaby's mean thrust per projected blade area against the
  static head at the shaft. Past a loading of 1.0 the blades give 40% of the
  extra open-water thrust and the torque loses half the thrust's fractional
  loss, so the hole shot slips and the engine revs up as on a real cupped
  propeller.
- The gearcase is a low-aspect fin (0.12 m^2, lift slope 3.6) along the shaft
  with its drag; it is the boat's rudder. Propeller walk and the torque
  reaction act at low speed and through the hull.

The trials the targets come from (BoatTEST's 21.5 ft sterndrive and Yamaha's
F200 bulletin) both make about 15% more pitch speed per crank rpm than this
drive, so their rpm is multiplied by 1.15 (`TRIAL_RPM_SCALE`) and their speed
kept: read off unscaled, "16 kn at 2,500 rpm" asks this propeller for 24% slip
at the end of the hump, where Savitsky's equations give the hull 3 kN of drag
it cannot make.

## Tabs and windage

Two 12 x 9 in tabs, 0-12 degrees, lift 0.046 chord span delta(deg) q (Savitsky
and Brown 1976) on the share of the tab inside the transom strip's wetted
bottom. Windage is three drag areas at a centre forward of and above the CG.

## Assists

`assists.ts` maps the aircraft's three modes:

- **Scenic** (the default): Active Trim schedules the power trim by speed and
  then holds a 4 degree running trim on the plane, trimming in with the helm
  over. The tabs level the heel running straight and, with the helm over on
  the plane, go down together while the running trim is past Day and Haag's
  porpoising limit at that speed (a hard turn bleeds speed and the bow climbs
  into it). Steering is eased at speed and backs off as the hull slides past
  12 degrees, and the throttle is eased while the propeller is blown out.
- **Pilot**: trim and tabs are the driver's; the helm turns at a limited rate.
- **Direct** ("unassisted"): everything raw, porpoising included.

## Capsize and crashes

Past 110 degrees of tilt for 4 s the boat is a wreck. Hard contacts wreck it
too: the bed at over 3 m/s into it, or carrying half its weight at over 8 m/s
along it, and the marina's piles, pontoons and moored boats past their own
impact speeds (`tests/sim.boat-grounding.test.ts`,
`tests/sim.boat-mooring.test.ts`).

## Fitted constants

`BOAT_CALIBRATION` in `definition.ts` holds every fitted number with what it
stands for, and `tests/sim.boat-performance.test.ts` pins the whole record, so
a retune is a visible change. None of them changed for the wave and turn work
below; the targets are met by the physics above.

## Results against the targets

Calm, windless deep water, Scenic, from `scripts/boat-probe.mts`:

| Target | Result |
|---|---|
| Hump at 7-9 kn at 2,000 rpm (2,300 rebased) | 7.7 kn, 2.7 degrees of trim |
| On the plane by 16 kn at 2,500 rpm (2,875 rebased) | 13.2 kn, band 13.1-17.6 |
| Every rpm row within 10% of the trials | all ten rows inside |
| Time to plane 4-5 s | 4.4 s to 16 kn |
| 0-30 mph 7-8 s | 7.7 s |
| Top speed 39-43 kn at 5,600-5,800 rpm, about 15% slip | 41.0 kn at 5,696 rpm |
| Running trim 3-5 degrees on the plane | 3.2-4.4 (3.4 at full speed) |
| Throttle chopped at 40 mph: displacement speed in 6-10 s | 7.0 s to 7 kn |
| Hard turn: heel into it 10-20, sideslip under 20 | 10.6 heel, 16.2 slip (28 kn, full wheel) |

Turns, 6 s to settle and 8 s measured:

| Assist | Wheel | From kn | Heel | Slip | Slowest kn | Radius m |
|---|---|---|---|---|---|---|
| Scenic | 1.00 | 28 | 10.6 | 16.2 | 19.6 | 37 |
| Scenic | 1.00 | 35 | 8.6 | 15.8 | 23.7 | 41 |
| Pilot | 0.50 | 28 | 10.2 | 13.6 | 22.1 | 50 |
| Pilot | 0.25 | 28 | 3.9 | 6.7 | 29.4 | 106 |
| Pilot | 1.00 | 38 | 11.3 | 31.1 | 14.8 | 23 |
| Direct | 1.00 | 38 | 11.2 | 31.1 | 14.9 | 24 |

Full wheel at 35 kn in Scenic settles to a carved turn: roll swing under
1.5 degrees and yaw-rate swing under 3 degrees/s over the last 4 s. Full lock
at top speed in Pilot or Direct asks for more yaw than the hull can carve: the
bow goes down, the bottom's lateral load moves forward of the CG and the hull
spins out (30+ degrees of slip) rather than tripping, then settles into a
sliding turn. That is Katayama and Ohashi's spin-out ("A study on spinout
phenomena of planing craft in high speed turning", ISSW 2014): an inside heel
or a sharp deceleration brings the bow down and the hydrodynamic centre
forward. The spin-outs heel at most 23-28 degrees.

## Checks against the literature

- **Savitsky (1964)**, towed bare hull: trim within a degree, drag within 15%,
  and his trend (trim falls, drag rises with speed).
- **Day and Haag (1952)**, through Savitsky's porpoising-limit fit: trimmed
  fully out at about 17 kn the running trim (7.4 degrees) sits past the limit
  (6.7) and the hull bounds 6.5 degrees peak to peak; trimmed in at 22 kn
  (4.3 against 4.4) it runs steady. Above about 30 kn the model's own limit is
  higher than the fit's: it runs steady at 3.8 degrees where the fit says 3.0.
- **Savitsky and Brown (1976)**, impact acceleration in head seas (the mean of
  the highest tenth at the CG, from Fridsma's towed prismatic models): two
  minutes into a 0.97 m significant sea on the game's sea twin at 21 kn in
  Pilot, 183 impacts, n_1/10 = 1.35 g against their 2.11 g (ratio 0.64; the
  test holds 0.6-1.4 and the absolute 1-3 g). Fridsma's models were free only
  in heave and pitch and towed at a constant speed; this hull also rolls,
  yaws and slows into each sea, which takes some of the edge off.

## Waves

`tests/sim.boat-waves.test.ts`:

- a 1 m, 80 m swell from ahead: heave 0.85-1.15 of the surface's and in phase
  with it, pitch 0.7-1.2 of the slope;
- the slam above;
- half an hour of random helm, throttle, trim, tabs and assist on the game's
  breezy sea: everything finite, under 40 m/s, under 30 wrecks;
- two minutes unmoored at rest in calm water: no drift (2 cm, 2 mm, 0.1 degree).

With chine-first entry and the sinking fix, 80 minutes on the sea twin, five
minutes at each of four headings (head on, 45 degrees either bow, and 118
degrees off, abaft the beam) in 1 m and 2 m significant seas, in Pilot and in
Scenic at lever 0.64 (1 m) and 0.75 (2 m), produced no capsizes. Before them a heeled landing capsized the
boat about once every 5 minutes in a 1 m head sea: the low side's water
appeared with no slam and its added mass then hung off that side.

## Known issues

- The game's default "breezy" weather on the open sea is about a 2 m
  significant height (prevailing wind 9.6 m/s), a rough sea for a 21 ft boat.
  At 30 kn into it the boat leaves the water every few seconds.
- The mesh is closed at the sheer: an inverted hull floats on its whole volume
  (6.5 m^3) instead of swamping its cockpit. A boat thrown over in the air can
  therefore barrel-roll back upright: twice in 40 minutes of 2 m seas, each
  time buried heeled 40 degrees in a crest, righted hard by its buoyancy and
  carried on over in the air, through 360 degrees in about 1.3 s and never
  past 110 degrees for 4 s. Roll damping from a hull rolling fast through
  the water (chine eddies, radiation on the plane) is thin.
- The strips' Wagner growth is inviscid and uncushioned: a nearly flat panel
  (heeled to within a few degrees of its deadrise) slams hard. Air cushioning
  and hydroelasticity, which soften real flat impacts, are not modelled.
- The Day and Haag agreement holds below about 30 kn only (above).
- Dropped experiment: releasing a section's suction as it leaves the water in
  the same step (rather than Zarnick's dropped momentum term) tripped the
  spin-outs and made heeled landings worse; it is not in the model.

## Tests

| File | What it holds |
|---|---|
| `sim.boat-performance.test.ts` | the calibration record, the rpm table, hump, time to plane, top speed, trim, chop, crash stop, backing |
| `sim.boat-savitsky.test.ts` | the towed hull against Savitsky (1964) |
| `sim.boat-handling.test.ts` | heel and slip in hard turns, circles, the 35 kn full-wheel turn, the spin-outs, porpoising, ventilation, tabs |
| `sim.boat-waves.test.ts` | swell, slam, half an hour of random input, rest |
| `sim.boat-hydrostatics.test.ts` | the closed mesh, rest waterline, righting curve, natural periods, inverted |
| `sim.boat-budget.test.ts` | 171 water samples and one focus a step; the step cost |
| `sim.boat-grounding.test.ts`, `sim.boat-mooring.test.ts`, `sim.boat-harbour.test.ts`, `sim.boat-simulator.test.ts` | beaching, piles, pontoons, lines, the berth, the worker payload |
