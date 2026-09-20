# Aircraft calibration envelope

The trainer is a Cessna 150, so calibration targets the type's published figures — stall, cruise, climb and ceiling — rather than merely believable light-aircraft relationships. Where this simulator's parameter set cannot express a real quantity, the number is chosen to land the OBSERVABLE performance on the type's figures, which is what a pilot can check out of the window. Every scenario runs headlessly at the same 120 Hz fixed step used in the browser.

| Scenario | Automated acceptance band |
| --- | --- |
| Runway placement | An arbitrary input Y is ignored for `onGround`; the solved centre of gravity rests 1.1–1.2 m up (the 150's mains are at y −1.22), solved fuselage pitch is -3.2° to -2.2°, all three wheels remain loaded, AGL is 0, and ground speed remains below 0.02 m/s after 5 s |
| Browser-mode takeoff | Full power, half flap, and rotation above 27 m/s lift off in 11–17 s and 170–360 m; at 20 s the trainer is 6–35 m AGL, 32–45 m/s, and pitched 5–12°. The AGL band opens downward for the 150, whose thrust-to-weight is 0.23 against the previous airframe's 0.28 |
| Scenic right turn | A 70% roll command for 4 s produces 26–34° right bank, changes heading from 90° to 106–119°, holds sideslip below 4°, and retains more than 45 m/s |
| Scenic recenter | Releasing the preceding roll command returns bank to within 3° of level in 4 s |
| Scenic climb | A 70% pitch command for 3 s produces 9–13° pitch, 5–10 m/s climb, more than 43 m/s airspeed, and no stall |
| Trimmed cruise | A 60 s hands-off run at 50 m/s stays within -30/+35 m of initial altitude, 44–55 m/s, 1° bank, and 0.08 rad/s total body rate |
| Rudder and taxi steering | Positive rudder increases airborne heading and body yaw rate; at 20% power, half rudder taxis at 1–4 m/s and turns 5–20° in 8 s |
| Stall and recovery | A sustained pull from 34 m/s crosses the +15° critical angle within 5.5 s and raises drag above 0.08; unloading and adding power recovers below 8° absolute alpha and between 40–75 m/s |
| Wheel braking | From 24 m/s on dry pavement, full braking reaches less than 2 m/s within 8 s while remaining upright and grounded |
| Power-off glide | From 1,200 m MSL at 50 m/s, a 20 s glide descends less than 650 m and remains between 28–75 m/s |
| Crosswind parking | A parked aircraft holds heading within 2° and ground speed below 0.5 m/s for 8–10 s under fixed and procedural gust fields |
| Determinism/endurance | Identical 30 s control streams match to 12 decimal places; a 100 s adversarial stream stays finite with a normalized quaternion |

The control tests deliberately assert direction as well as magnitude. This catches internally self-consistent sign bugs—for example a HUD that says “right bank” while the world-space aircraft actually turns left—that weaker rate-only tests miss.

Run the complete simulation suite with:

```bash
npm run test:sim
```

## The type's own figures

Measured by flying the shipped simulator (`scripts/aircraft-performance.mts`),
against the Cessna 150's published numbers:

| Quantity | Measured | The type |
| --- | --- | --- |
| Stall, clean | 24.1 m/s (47 kt) | 48 kt |
| Stall, full flap | 20.7 m/s (40 kt) | 42 kt |
| Maximum level | 58.7 m/s (114 kt) | 109 kt |
| Take-off ground roll | 235 m | ~225 m |
| Best rate of climb | 5.34 m/s (1,051 ft/min) | 670 ft/min |
| Service ceiling | 8,074 m (26,490 ft) | 12,650 ft |

The last two are deliberate and are the same decision. `maxStaticThrust` is
1,650 N where 1,200 N would reproduce the book climb almost exactly; Jason
chose the faster aeroplane so that crossing this world's 1,750–1,900 m
mountains is not a chore. Nothing else moves with it: stall and maximum level
speed are measurably identical across the whole thrust sweep, because the
stall is flown at idle and the propeller is power-limited at the top end.
`tests/sim.trainer-performance.test.ts` pins both.

The ceiling is high for a different reason, and it is a model limitation
rather than a choice: `calculateEngineThrust` holds propeller thrust at a flat
cap until the power limit bites, where a real fixed-pitch propeller decays
continuously with speed. That also puts best climb at 44 m/s where the real
aeroplane's is near 30. Recorded in
`docs/findings/AIRCRAFT_FRAMING_2026_09_19.md` as a named follow-up.

Run only the measured handling rebuild scenarios with:

```bash
npx vitest run --config vitest.config.ts tests/sim.rebuild.test.ts
```
