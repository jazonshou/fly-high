# Flight model

fly high models four real aeroplanes (a Cessna 150, an F-16C, a Bombardier Global 8000 and a Boeing 747-8) as deterministic six-degree-of-freedom rigid bodies. Each is one `AircraftDefinition` in `src/sim/aircraft.ts`, built from the type's published dimensions, wing, engines and inertias, and flown against its real speeds, ceilings and field lengths where the game's single runway allows. Where a figure is deliberately not the real one (the Global and 747 are flown light, the Cessna climbs faster than the book), the definition says so and why.

## Coordinate and sign conventions

World space is right-handed and Y-up: `+X` east, `+Y` up, and `+Z` north. Heading zero is north and increases clockwise when viewed from above.

Aircraft body space must also be right-handed. It is therefore:

- `+X`: nose/forward
- `+Y`: up
- `+Z`: port/left wing

Pilot-facing input remains conventional: positive pitch is nose-up, positive roll is right-wing-down, and positive yaw turns right. A right roll is consequently a negative body-X rotation, while right yaw is a positive body-Y rotation.

This distinction matters. Treating body `+Z` as the right wing creates a left-handed basis and was the root cause of the original reversed roll and yaw behavior.

## Aerodynamics

At every 120 Hz substep, ground velocity minus wind is transformed into body space. Angle of attack and sideslip are then derived as:

```text
alpha = atan2(-V_body.y, V_body.x)
beta  = atan2(-V_body.z, V_body.x)
qbar  = 0.5 * rho * |V_air|²
```

Positive beta is motion toward the starboard wing. The atmosphere is the International Standard Atmosphere to 32 km (`src/sim/atmosphere.ts`): a 6.5 K/km troposphere to 11 km, isothermal to 20 km, then warming at 1 K/km. Temperature, pressure and the speed of sound are derived from the air DENSITY the simulator carries rather than from altitude, so an `EnvironmentInput.airDensity` override moves the engines and the Mach number along with the wing.

Lift is linear through the normal operating range, reaches its critical angle at approximately +15°/-13°, and then decays smoothly. Drag combines profile, induced, flap, and post-stall terms. Lift remains perpendicular to the local velocity/span plane, drag opposes air-relative velocity, and side force opposes sideslip and rudder deflection.

Body moments use nondimensional stability derivatives:

```text
roll  = qbar*S*b * (-Cl_da*aileron + Cl_beta*beta + Cl_p*p*b/(2V))
pitch = qbar*S*c * (Cm_0 + Cm_alpha*alpha + Cm_de*elevator + Cm_q*q*c/(2V))
yaw   = qbar*S*b * (Cn_dr*rudder + Cn_beta*beta + Cn_r*r*b/(2V))
```

Control authority falls progressively after the critical angle instead of disappearing abruptly. Propeller thrust is bounded by both static thrust and available shaft power, and engine power falls with air density.

Jet thrust follows Mattingly's installed-thrust lapse correlations (*Aircraft Engine Design*, section 2.3.2), which read the total temperature and pressure the engine actually sees, so thrust falls with Mach as well as with altitude:

```text
theta0 = T/T_SL * (1 + 0.2 M²)      delta0 = p/p_SL * (1 + 0.2 M²)^3.5
high-bypass fan:     alpha = delta0 * (1 - 0.49 sqrt(M) - 3 (theta0 - TR) / (1.5 + M))
low-bypass, dry:     alpha = delta0 * (1 - 3.8 (theta0 - TR) / theta0)
low-bypass, reheat:  alpha = delta0 * (1 - 3.5 (theta0 - TR) / theta0)
```

The `(theta0 - TR)` terms apply only above the throttle ratio TR. The Global's and the 747's fans make about 80% of static thrust at take-off speed and 70% at Mach 0.6; the F-16's reheat makes about 1.37 times its static figure at Mach 0.9 on the deck, which is what Stevens and Lewis's F-16 engine tables give.

Above each definition's `transonicOnsetMach` a wave-drag hump rises over 0.17 Mach and decays past Mach 1, and above Mach 1 the lift-dependent wave drag `CL² sqrt(M² - 1) / 4` takes over from subsonic induced drag. The F-16's coefficients are fitted to its real top speeds: Mach 1.2 on the deck and Mach 2 at altitude in reheat.

Airborne spawns begin at the trim-consistent angle of attack rather than with velocity exactly through the nose. This removes the artificial sink transient that previously occurred during the first several seconds of a flight. Their wheel-clearance AGL is user-configurable and is converted to the exact centre-of-gravity height from the rotated landing-gear geometry; there is no hidden fixed elevation or altitude-hold loop.

## Rigid-body integration

Forces are rotated into world space and gravity is added. Linear velocity and position use semi-implicit Euler integration. Angular acceleration uses Euler's rigid-body equation with diagonal principal inertia, including the `omega × I*omega` gyroscopic term. Orientation integrates `q_dot = 0.5*q*omega_body` and is normalized every step.

Public `step` calls are subdivided into the same 1/120 s quantum, so a 60 Hz caller and a 120 Hz caller produce the same result. Long elapsed times are capped, and every state boundary sanitizes non-finite input.

## Landing gear and ground handling

Each wheel has its own spring, damper, contact velocity, rolling resistance, braking friction, and lateral tyre force. The wheel brakes are friction brakes on the main gear (the nose wheel is unbraked): their force is the brake setting times 0.68 times the wheel's load, fading only in the last 0.3 m/s, so a braked aeroplane stops decisively instead of creeping, and held brakes hold it while the thrust is less than they can hold. Each braked tyre shares its grip between braking and cornering inside a friction circle. Cornering force is the slip angle times the wheel's load times a cornering stiffness of 6 per radian.

The nose wheel steers with the rudder pedals and, on the ground, with the roll axis as a tiller (`A`/`D`): the two add, clamped to full travel. Its angle, up to the type's own (22° on the trainer, 12° on the 747), fades with speed so that the turn it asks for never exceeds 0.35 g or half the lateral acceleration that would tip the aeroplane over its gear: about 5° at 10 m/s on the trainer and 1.4° at 60 m/s on the 747. Off the ground the roll axis is the ailerons alone.

A runway spawn is solved from the actual tricycle geometry, aircraft weight, wheelbase, and spring rates. The resulting pose preloads all three wheels and gives the trainer a roughly -2.7° fuselage attitude on level pavement. An `onGround` spawn always snaps Y to that solved pose; a contradictory elevated `position.y` cannot leave the aircraft hovering while flagged as grounded.

The penetration constraint only activates beyond available suspension travel. Projecting every contact back to the exact terrain plane would erase spring preload and create a perpetual gravity/rebound cycle. A parked static-friction state resists wind drift without suppressing vertical suspension forces.

AGL telemetry is the clearance between the lowest landing-gear contact point and local terrain. It reads exactly zero with loaded gear, while MSL altitude continues to report the aircraft reference-point elevation.

## Control modes

- **Direct / Unassisted (default):** requested controls pass through unchanged apart from actuator travel rate and physical aerodynamic damping. There is no auto-level, target altitude, or artificial pitch/bank envelope; full surface authority can drive the aircraft through steep dives, inversions, and aerobatic attitudes.
- **Pilot damping:** inputs remain direct surface commands with light body-rate damping and modest turn coordination.
- **Scenic assist (opt-in):** pilot roll and pitch inputs command bounded attitudes. Releasing roll levels the wings, turn coordination is automatic, and high angle of attack adds progressive nose-down recovery.

The title screen deliberately uses Scenic as a disposable attract-flight controller so the aircraft is already moving through the world. **Take the controls** disables attract mode and selects the user's chosen mode in one Worker command without resetting position, velocity, attitude, simulation time, or camera state. Only the attract flight may auto-reset after a crash or low-terrain approach; ordinary pilot flight is never taken over or reset automatically.

No airborne assistance runs while the gear is loaded. On the runway, rudder and the roll axis steer the nose wheel and elevator directly commands rotation.

The simulation worker advances at 120 Hz with a bounded accumulator and emits visual snapshots at 60 Hz. Its assistance routine reuses a control object, and the core dynamics reuse scratch vectors to avoid simulation-loop garbage.

## Deliberate limitations

The model does not yet include fuel burn, propeller torque/P-factor, compressibility effects on lift slope or pitching moment (only on drag and thrust), icing, independent wheel brakes, or a detailed propeller map. Terrain contact is a penalty/contact model rather than a general-purpose collision solver. Constants should be tuned through the measured scenarios in `tests/sim.rebuild.test.ts` and `tests/sim.envelope.test.ts`, not by weakening their assertions.
