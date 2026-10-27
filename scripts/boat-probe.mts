/**
 * The Runabout 21's sea trials and handling, headless, as tables:
 * `npx tsx scripts/boat-probe.mts [section...]`, sections from
 *
 * - rpm: steady speed, running trim and slip at each trial rpm (the plan's
 *   two published trials, their rpm scaled by `TRIAL_RPM_SCALE`), against
 *   the trials' +-10% band.
 * - accel: full throttle from rest (Scenic): time to 16 kn, to half the
 *   weight on planing lift and to 30 mph, the hump's trim, and the top speed.
 * - chop: the throttle chopped at 40 mph: seconds to 7 kn.
 * - savitsky: the bare hull towed through its CG against Savitsky (1964).
 * - turns: hard and full-wheel turns: heel, sideslip, speed, radius, and how
 *   far the heel still swings at the end.
 * - porpoise: running trim and its swing trimmed out and in, against Day and
 *   Haag's limit.
 * - slam: two minutes into a 1 m head sea on the sea twin: the mean of the
 *   highest tenth of impacts against Savitsky and Brown (1976).
 *
 * With no sections it prints them all (the slam takes about ten seconds).
 * `tests/sim.boat-*.test.ts` hold the same numbers to the plan's targets;
 * docs/BOAT_MODEL.md explains them.
 */
import {
  BOAT_TRIAL_TABLE,
  BOAT_WATERLINE_LENGTH,
  BoatSimulator,
  HULL_TRANSOM_CHINE_BEAM,
  KNOT,
  RUNABOUT_21,
  TRIAL_RPM_SCALE,
  fullThrottleAcceleration,
  porpoisingTrimLimit,
  savitskyBrownImpact,
  savitskyPlaning,
  steadySpeeds,
  throttleChop,
  towEquilibrium,
  trialBand,
} from "../src/sim/boat";
import type { StabilityAssistMode } from "../src/sim/assists";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";
import { CalmWaterSurface, createWaterSurfaceSample } from "../src/sim/water";
import { createSeaTwin } from "../src/sim/water/seaTwin";
import { HULL_TRANSOM, RUNABOUT_21_CG } from "../src/vehicles/boat/hullLines";

const STEP = 1 / 120;
const DEG = Math.PI / 180;
const G = 9.80665;
const WEIGHT = RUNABOUT_21.mass * G;
const SECTIONS = ["rpm", "accel", "chop", "savitsky", "turns", "porpoise", "slam"] as const;
const asked = process.argv.slice(2);
for (const name of asked) {
  if (!(SECTIONS as readonly string[]).includes(name)) throw new Error(`Unknown section ${name}: ${SECTIONS.join(", ")}`);
}
const run = (section: (typeof SECTIONS)[number]) => asked.length === 0 || asked.includes(section);

const f = (value: number, digits = 1, width = 6) => value.toFixed(digits).padStart(width);

function table(title: string, header: string, rows: string[]): void {
  console.log(`\n${title}\n${header}\n${rows.join("\n")}`);
}

if (run("rpm")) {
  const rows = BOAT_TRIAL_TABLE.map((row) => ({ row, rpm: row.trialRpm * TRIAL_RPM_SCALE }));
  const points = steadySpeeds(rows.map((r) => r.rpm));
  table(
    "Steady speed at the trials' rpm (calm, Scenic)",
    " trial rpm  rpm held     kn   band kn       trim  slip   lift",
    points.map((point, i) => {
      const band = trialBand(rows[i]!.row);
      const inside = point.knots >= band.low && point.knots <= band.high ? " " : "*";
      return `${f(rows[i]!.row.trialRpm, 0, 10)}${f(point.rpm, 0, 10)}${f(point.knots, 1, 7)}${inside} ${f(band.low, 1, 5)}-${f(band.high, 1, 4)}${f(point.trimDegrees, 2, 9)}${f(point.slip * 100, 0, 5)}%${f(point.dynamicLiftShare, 2, 7)}`;
    }),
  );
}

if (run("accel")) {
  const trial = fullThrottleAcceleration();
  table("Full throttle from rest (Scenic)", "  to 16 kn  half lift  0-30 mph  hump trim   top kn    rpm   trim", [
    `${f(trial.toPlane, 2, 9)} s${f(trial.toHalfLift, 2, 9)} s${f(trial.toThirtyMph, 2, 8)} s${f(trial.humpTrimDegrees, 1, 9)} deg${f(trial.topKnots, 1, 7)}${f(trial.top.rpm, 0, 7)}${f(trial.topTrimDegrees, 2, 7)}`,
  ]);
}

if (run("chop")) {
  const chop = throttleChop();
  table("Throttle chopped at 40 mph (Scenic)", "  to 7 kn   kn after 2 s", [`${f(chop.seconds, 2, 8)} s${f(chop.knotsAfterTwoSeconds, 1, 10)}`]);
}

if (run("savitsky")) {
  const boat = new BoatSimulator();
  const hull = { beam: HULL_TRANSOM_CHINE_BEAM, deadriseDegrees: HULL_TRANSOM.deadriseDegrees, lcg: RUNABOUT_21_CG.x, vcg: RUNABOUT_21_CG.y, weight: WEIGHT };
  table(
    "Bare hull towed through its CG, against Savitsky (1964)",
    "    kn   C_V   trim  Savitsky   drag N  Savitsky   ratio   lift",
    [16, 19, 20, 24, 28, 32, 36].map((knots) => {
      const oracle = savitskyPlaning(hull, knots * KNOT);
      const tow = towEquilibrium(knots, { boat });
      return `${f(knots, 0)}${f(oracle.speedCoefficient, 2)}${f(tow.trimDegrees, 2, 7)}${f(oracle.trimDegrees, 2, 10)}${f(tow.drag, 0, 9)}${f(oracle.drag, 0, 10)}${f(tow.drag / oracle.drag, 2, 8)}${f(tow.dynamicLiftShare, 2, 7)}`;
    }),
  );
}

function underWay(assist: StabilityAssistMode, lever: number, knots: number) {
  const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, speed: knots * KNOT, gear: "forward", rpm: 4_400 });
  boat.setEnvironment({ water: new CalmWaterSurface(0, () => -30), wind: { x: 0, y: 0, z: 0 }, bedHeight: () => -30, gravity: G });
  const controls = { assist, boat: { ...NEUTRAL_BOAT_CONTROLS, lever } };
  boat.setControls(controls);
  for (let i = 0; i < 1_200; i += 1) boat.step(STEP);
  return { boat, controls, telemetry: boat.telemetry() };
}

if (run("turns")) {
  const cases: [StabilityAssistMode, number, number, number][] = [
    ["scenic", 1, 0.75, 28],
    ["scenic", 1, 0.83, 35],
    ["pilot", 0.5, 0.75, 28],
    ["pilot", 0.25, 0.75, 28],
    ["pilot", 1, 0.83, 35],
    ["pilot", 1, 1, 38],
    ["unassisted", 1, 1, 38],
  ];
  table(
    "Turns in calm water (steer +1 is full wheel to starboard; 6 s to settle, 8 s measured)",
    " assist      wheel lever  from kn   heel  slip max  slowest kn  radius m  heel swing",
    cases.map(([assist, steer, lever, knots]) => {
      const { boat, controls, telemetry } = underWay(assist, lever, knots);
      controls.boat.steer = steer;
      boat.setControls(controls);
      let heel = 0;
      let slip = 0;
      let slowest = Infinity;
      let ground = 0;
      let yaw = 0;
      let low = Infinity;
      let high = -Infinity;
      let n = 0;
      for (let i = 0; i < 120 * 14; i += 1) {
        boat.step(STEP);
        boat.telemetry(telemetry);
        if (i < 120 * 6) continue;
        heel += telemetry.roll;
        slip = Math.max(slip, Math.abs(telemetry.sideslip));
        slowest = Math.min(slowest, telemetry.speedThroughWater / KNOT);
        const v = boat.state.velocity;
        ground += Math.hypot(v.x, v.z);
        yaw += Math.abs(boat.state.angularVelocity.y);
        if (i >= 120 * 10) {
          low = Math.min(low, telemetry.roll);
          high = Math.max(high, telemetry.roll);
        }
        n += 1;
      }
      const capsized = telemetry.capsized ? "  capsized" : "";
      return ` ${assist.padEnd(11)}${f(steer, 2, 6)}${f(lever, 2, 6)}${f(knots, 0, 9)}${f(heel / n / DEG, 1, 7)}${f(slip / DEG, 1, 10)}${f(slowest, 1, 12)}${f(ground / yaw, 1, 10)}${f((high - low) / DEG, 2, 11)}${capsized}`;
    }),
  );
}

if (run("porpoise")) {
  table(
    "Trimmed out and in from 25 kn (Direct): running trim and its swing, against Day and Haag",
    " lever  engine trim     kn   trim  swing  Day-Haag limit",
    ([
      [0.58, 1],
      [0.6, -1],
      [0.75, 1],
      [0.75, -1],
    ] as const).map(([lever, trim]) => {
      const { boat, controls, telemetry } = underWay("unassisted", lever, 25);
      controls.boat.trim = trim;
      boat.setControls(controls);
      for (let i = 0; i < 120 * 12; i += 1) boat.step(STEP);
      controls.boat.trim = 0;
      boat.setControls(controls);
      for (let i = 0; i < 120 * 8; i += 1) boat.step(STEP);
      let low = Infinity;
      let high = -Infinity;
      let sum = 0;
      let speed = 0;
      let n = 0;
      for (let i = 0; i < 120 * 10; i += 1) {
        boat.step(STEP);
        boat.telemetry(telemetry);
        low = Math.min(low, telemetry.runningTrim);
        high = Math.max(high, telemetry.runningTrim);
        sum += telemetry.runningTrim;
        speed += telemetry.speedThroughWater;
        n += 1;
      }
      speed /= n;
      const limit = porpoisingTrimLimit(Math.sqrt(WEIGHT / (1025 * speed * speed * HULL_TRANSOM_CHINE_BEAM ** 2)), HULL_TRANSOM.deadriseDegrees);
      return `${f(lever, 2)}${f(boat.trimAngle / DEG, 1, 13)}${f(speed / KNOT, 1, 7)}${f(sum / n / DEG, 2, 7)}${f((high - low) / DEG, 2, 7)}${f(limit, 2, 16)}`;
    }),
  );
}

if (run("slam")) {
  const world = { sourceSeedHash: 0x4f434541, prevailingWindRadians: 4.2243797, prevailingWindSpeed: 6.8, seaLevel: 0 };
  const twin = createSeaTwin(world, "breezy");
  const sample = createWaterSurfaceSample();
  let sum = 0;
  let squares = 0;
  let n = 0;
  for (let t = 0; t < 1_200; t += 0.25) {
    twin.setTime(t);
    twin.sample(0, 0, sample);
    sum += sample.height;
    squares += sample.height * sample.height;
    n += 1;
  }
  const height = 4 * Math.sqrt(squares / n - (sum / n) ** 2);
  const lever = 0.64;
  // Into the wind (its bearing is where it blows toward): the waves come from dead ahead.
  const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: world.prevailingWindRadians + Math.PI, moored: false, speed: 20 * KNOT, gear: "forward", rpm: 4_000 });
  boat.setEnvironment({ water: twin, wind: { x: 0, y: 0, z: 0 }, bedHeight: () => -100, gravity: G });
  boat.setControls({ assist: "pilot", boat: { ...NEUTRAL_BOAT_CONTROLS, lever } });
  const telemetry = boat.telemetry();
  for (let i = 0; i < 120 * 10; i += 1) boat.step(STEP);
  const window: number[] = [];
  const accelerations: number[] = [];
  let speed = 0;
  let airborne = 0;
  for (let i = 0; i < 120 * 120; i += 1) {
    boat.step(STEP);
    boat.telemetry(telemetry);
    window.push(telemetry.loadFactor - 1);
    if (window.length > 6) window.shift();
    accelerations.push(window.reduce((a, b) => a + b, 0) / window.length);
    speed += telemetry.speedThroughWater;
    if (telemetry.displacedVolume <= 0) airborne += 1;
  }
  speed /= 120 * 120;
  const peaks: number[] = [];
  for (let i = 0; i < accelerations.length; ) {
    if (accelerations[i]! <= 0.3) {
      i += 1;
      continue;
    }
    let peak = accelerations[i]!;
    const end = Math.min(accelerations.length, i + 24);
    for (; i < end; i += 1) peak = Math.max(peak, accelerations[i]!);
    peaks.push(peak);
  }
  peaks.sort((a, b) => b - a);
  const tenth = peaks.slice(0, Math.max(1, Math.round(peaks.length / 10)));
  const impact = tenth.reduce((a, b) => a + b, 0) / tenth.length;
  // The fit's trim: calm water at the speed run in the sea, the hull towed through its CG (Fridsma's setup).
  const calmTrim = towEquilibrium(speed / KNOT).trimDegrees;
  const predicted = savitskyBrownImpact(
    { beam: HULL_TRANSOM_CHINE_BEAM, deadriseDegrees: HULL_TRANSOM.deadriseDegrees, length: BOAT_WATERLINE_LENGTH, weight: WEIGHT },
    height,
    calmTrim,
    speed,
  );
  table("Two minutes into a head sea on the sea twin (Pilot, lever 0.64)", "  Hs m     kn  calm trim  impacts  n1/10 g  Savitsky-Brown g  ratio  airborne s  crashed", [
    `${f(height, 2)}${f(speed / KNOT, 1, 7)}${f(calmTrim, 2, 11)}${f(peaks.length, 0, 9)}${f(impact, 2, 9)}${f(predicted, 2, 18)}${f(impact / predicted, 2, 7)}${f(airborne * STEP, 1, 12)}  ${boat.state.crashed}`,
  ]);
}
