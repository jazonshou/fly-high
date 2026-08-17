# Flight model

fly high models a fictional four-seat piston trainer as a deterministic six-degree-of-freedom rigid body. The goal is a coherent, light-trainer-like response—not certification fidelity to a named aircraft.

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

Positive beta is motion toward the starboard wing. The atmosphere uses an exponential density approximation based on mean-sea-level altitude.

Lift is linear through the normal operating range, reaches its critical angle at approximately +15°/-13°, and then decays smoothly. Drag combines profile, induced, flap, and post-stall terms. Lift remains perpendicular to the local velocity/span plane, drag opposes air-relative velocity, and side force opposes sideslip and rudder deflection.

Body moments use nondimensional stability derivatives:

```text
roll  = qbar*S*b * (-Cl_da*aileron + Cl_beta*beta + Cl_p*p*b/(2V))
pitch = qbar*S*c * (Cm_0 + Cm_alpha*alpha + Cm_de*elevator + Cm_q*q*c/(2V))
yaw   = qbar*S*b * (Cn_dr*rudder + Cn_beta*beta + Cn_r*r*b/(2V))
```

Control authority falls progressively after the critical angle instead of disappearing abruptly. Propeller thrust is bounded by both static thrust and available shaft power, and engine power falls with air density.

Airborne spawns begin at the trim-consistent angle of attack rather than with velocity exactly through the nose. This removes the artificial sink transient that previously occurred during the first several seconds of a flight. Their wheel-clearance AGL is user-configurable and is converted to the exact centre-of-gravity height from the rotated landing-gear geometry; there is no hidden fixed elevation or altitude-hold loop.

## Rigid-body integration

Forces are rotated into world space and gravity is added. Linear velocity and position use semi-implicit Euler integration. Angular acceleration uses Euler's rigid-body equation with diagonal principal inertia, including the `omega × I*omega` gyroscopic term. Orientation integrates `q_dot = 0.5*q*omega_body` and is normalized every step.

Public `step` calls are subdivided into the same 1/120 s quantum, so a 60 Hz caller and a 120 Hz caller produce the same result. Long elapsed times are capped, and every state boundary sanitizes non-finite input.

## Landing gear and ground handling

Each wheel has its own spring, damper, contact velocity, rolling resistance, braking friction, and lateral tyre force. The nose wheel steers up to 22° with rudder input at taxi speeds.

A runway spawn is solved from the actual tricycle geometry, aircraft weight, wheelbase, and spring rates. The resulting pose preloads all three wheels and gives the trainer a roughly -2.7° fuselage attitude on level pavement. An `onGround` spawn always snaps Y to that solved pose; a contradictory elevated `position.y` cannot leave the aircraft hovering while flagged as grounded.

The penetration constraint only activates beyond available suspension travel. Projecting every contact back to the exact terrain plane would erase spring preload and create a perpetual gravity/rebound cycle. A parked static-friction state resists wind drift without suppressing vertical suspension forces.

AGL telemetry is the clearance between the lowest landing-gear contact point and local terrain. It reads exactly zero with loaded gear, while MSL altitude continues to report the aircraft reference-point elevation.

## Control modes

- **Direct / Unassisted (default):** requested controls pass through unchanged apart from actuator travel rate and physical aerodynamic damping. There is no auto-level, target altitude, or artificial pitch/bank envelope; full surface authority can drive the aircraft through steep dives, inversions, and aerobatic attitudes.
- **Pilot damping:** inputs remain direct surface commands with light body-rate damping and modest turn coordination.
- **Scenic assist (opt-in):** pilot roll and pitch inputs command bounded attitudes. Releasing roll levels the wings, turn coordination is automatic, and high angle of attack adds progressive nose-down recovery.

The title screen deliberately uses Scenic as a disposable attract-flight controller so the aircraft is already moving through the world. **Take the controls** disables attract mode and selects the user's chosen mode in one Worker command without resetting position, velocity, attitude, simulation time, or camera state. Only the attract flight may auto-reset after a crash or low-terrain approach; ordinary pilot flight is never taken over or reset automatically.

No airborne assistance runs while the gear is loaded. On the runway, rudder steers the nose wheel and elevator directly commands rotation.

The simulation worker advances at 120 Hz with a bounded accumulator and emits visual snapshots at 60 Hz. Its assistance routine reuses a control object, and the core dynamics reuse scratch vectors to avoid simulation-loop garbage.

## Deliberate limitations

The model does not yet include fuel burn, propeller torque/P-factor, compressibility, icing, retractable gear, independent wheel brakes, or a detailed propeller map. Terrain contact is a penalty/contact model rather than a general-purpose collision solver. Constants should be tuned through the measured scenarios in `tests/sim.rebuild.test.ts` and `tests/sim.envelope.test.ts`, not by weakening their assertions.
