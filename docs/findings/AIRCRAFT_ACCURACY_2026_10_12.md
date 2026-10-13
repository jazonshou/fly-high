# Aircraft accuracy audit, 2026-10-12

Goal: make the four aeroplanes as close to the real types as the game allows.
This note records what was measured, what changed, and what is still wrong,
so the next pass starts from numbers rather than impressions.

Speeds and ceilings below come from a point-mass envelope over the shipped
force model (thrust from `calculateEngineThrust`, drag from
`calculateDragCoefficient` plus the wave-drag term, steady level flight,
service ceiling at 100 ft/min). Take-off and landing figures come from
`scripts/aircraft-performance.mts`, which flies the full simulator.

## What changed

1. **The atmosphere is the ISA to 32 km** (`src/sim/atmosphere.ts`). The
   exponential it replaces read 5% thin at 3 km, 9% thin at 9 km and 8% thick
   at 15 km, and it stopped thinning at 20 km, so no jet had a ceiling. Speed
   of sound was 6% low at 15 km, which moved every Mach number the drag and
   the engines read.
2. **Jet thrust lapses with Mach and altitude** (Mattingly's installed-thrust
   correlations, `jetThrustLapse` in `src/sim/aircraft.ts`). The old
   `rho^0.72` kept 40% of static thrust at airliner cruise, twice the real
   figure, and gave the F-16 no ram recovery.
3. **The F-16's drag hump and throttle ratio were refitted** against its real
   top speeds, and above Mach 1 lift-dependent wave drag replaces subsonic
   induced drag.
4. **Moments of inertia for the Global and the 747** now come from published
   radii of gyration (747: NASA CR-2144). The old figures were 46-62% of the
   real ones in pitch and yaw.
5. **Airborne spawn throttles** were re-swept for the new engines, and two
   tests that flew the jets gear-down at 200+ m/s now fly them as the game
   does, gear up.
6. **Landing gear folds instead of squashing** (F-16, Global, 747). Each leg
   swings rigidly about its trunnion in the type's own direction. Gear-down
   geometry is unchanged vertex for vertex.
7. **The 747's flaps are Fowler flaps.** The wing is one 4-digit section over
   the true chord, cut blunt at the 70% hinge line, and every surface behind
   it continues that section; fixed trailing-edge pieces fill the notches
   between the flaps and ailerons. The inboard flaps are double-slotted and
   the outboard single-slotted, as on the -8. At full flap they run 1.1 m and
   0.7 m aft on their tracks and turn 30 degrees (the inboard aft element 12
   more), and the flap-track canoes' tails ride down with them. Each flap is
   the aft 30% of the chord, as the real 78.7 m^2 of flap is, and its rounded
   nose slides out from under a fixed shroud. (The first version carried that
   tuck ahead of the hinge line instead, which made the flaps 39-53% of the
   chord and hung the inboard trailing edge 3.4 m below the wing at full flap.)
   With the gear down the inboard flap's lowest point stays 1.54 m off the
   ground at full flap. Cost: three meshes and three shadow casters (206 to
   215 predicted draws, against the unchanged ceiling of 225); the shrouds
   fold into the fixed wings.
8. **The 747's main gear stands at the real stations.** The wing gear hangs at
   62% of the chord, behind the rear spar and ahead of the inboard flap, and
   the body gear 3.1 m behind it (the -400's 3.07 m). The wing gear used to
   stand 1.5 to 2.4 m aft of the hinge line, so the flaps passed through the
   legs. The flat door plate under each wing-gear leg, which stuck out level
   with the wing whenever the gear was down, is now a door on the strut that
   folds away with the leg, and the body-gear doors shut flush with the belly
   fairing. The simulator's contact points did not move.

## Before and after, against the real aeroplanes

| | Real | Before | After |
|---|---|---|---|
| F-16 top speed, sea level, reheat | about M 1.2 | M 1.71 | **M 1.19** |
| F-16 top speed, 11 km, reheat | about M 2.0 | M 2.47 | **M 1.97** |
| F-16 top speed, dry | cannot supercruise | (not checked) | M 1.01 SL, M 1.05 at 11 km |
| Global 8000 top speed | Mmo 0.94, cruise M 0.925 | M 0.98 at FL350 | **M 0.93** |
| Global 8000 ceiling (at 40 t) | 51,000 ft certified | none | **46,750 ft** |
| 747-8 top speed | Mmo 0.90, cruise M 0.855 | M 0.97 at FL350 | **M 0.92** |
| 747-8 ceiling (at 250 t) | 43,100 ft certified | none | **45,600 ft** |
| 747-8 full thrust at FL350, M 0.855 | about 20% of static | 40% (470 kN) | **21% (246 kN)** |
| Global best climb, sea level (40 t) | not published at this weight | 13,400 ft/min | **7,300 ft/min** |
| 747-8 best climb, sea level (250 t) | not published at this weight | 15,500 ft/min | **8,400 ft/min** |
| 747-8 pitch / yaw inertia | 45 / 72 M kg m^2 (scaled) | 25 / 33 | **45 / 72** |
| Global take-off roll, gentle rotation | roughly 600 m at 40 t (scaled from MTOW field length, unverified) | 942 m | 1,185 m |
| 747-8 take-off roll | | 775 m | 955 m |
| Cessna 150 ceiling | 12,650 ft | 25,800 ft | 28,400 ft |

The take-off rolls got longer because the fans now lose about a fifth of
their thrust by rotation speed, as real ones do. Both still fit the 1,320 m
runway: the Global with 135 m to spare on the script's gentle 0.55-stick
rotation, and lifting off in about 940 m with a firm one.

## Still wrong, not fixed here

- **Cessna climb and ceiling.** Propeller thrust is a flat cap until the power
  limit bites, so the 150 climbs at about 1,100 ft/min (book: 670) and has a
  28,000 ft ceiling (book: 12,650). The ISA made the ceiling 2,600 ft worse,
  because the old atmosphere was too thin up there. The 1,650 N static thrust
  was a deliberate choice for climb across the mountains, so the propeller
  model is the place to fix it, not the atmosphere. See the named follow-up in
  `AIRCRAFT_FRAMING_2026_09_19.md`.
- **F-16 ceiling about 71,000 ft** against a real 50,000 ft. Nothing in the
  model limits the engine or the wing at very low dynamic pressure.
- **Lift-off is late.** With a gentle 0.55-stick rotation the Global's nose
  stays down until about 74 m/s and it lifts off at 1.37 times the stall
  speed; a real one rotates at VR and lifts off near 1.15. The Global also
  has no slats, so its take-off lift is lower than the real wing's. No ground
  effect is modelled.
- **No compressibility effect on lift slope or pitching moment**, only on drag
  and thrust.

## Visual audit (built meshes at c1b5491; items 2 and 3 fixed since)

Measured on the built meshes, ranked by how visible each is in the chase and
cinematic cameras. [M] measured, [K] real-aircraft figure to verify before
acting.

1. **Cessna wing about 1.3 m too far aft.** Spinner to wing leading edge is
   3.38 m (46% of length) against about 1.9 m [K]; the pilot's eye sits 0.76 m
   ahead of the leading edge instead of under the wing; tail arm 2.81 m
   against about 4.2 m [K]. Code: `trainerShell.ts`, `trainerVisual.ts`, and
   the matching gear and contact points in `src/sim/aircraft.ts`.
2. **Fixed (item 6 above).** Gear retraction squashed the gear instead of
   folding it (F-16, Global, 747). `animation.ts` scales the gear node to y 0.08: at half travel the
   747's wing-gear tyre is 0.67 m tall instead of 1.24 m.
3. **Fixed (item 7 above).** The 747's flaps only rotated: at full flap the
   inboard trailing edge moved 0.345 m forward, where the real Fowlers travel
   metres aft.
4. **Fins are flat 8-vertex slabs** on the 747 (30% thick at the tip), the
   F-16 and the Cessna. The Global's is already an aerofoil.
5. **The 747 is 4.3 m short** (72.0 m against 76.25 m), almost all of it
   forward of the wing: the -8's stretch.

Smaller: control-surface travel is 50-70% of real and symmetric, and the
F-16's flaperon sum is unclamped; no leading-edge devices on any type; the
747's 37.5 degrees of sweep is applied at the leading edge rather than the
quarter chord, and its wing-gear track is 12.6 m against 11.0; the F-16 is 5%
wide over its rails; the Cessna's wing is untapered with no dihedral; the
Global has one nose wheel instead of two.
