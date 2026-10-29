/**
 * What one light keyboard tap does to each aeroplane, across its speed range.
 *
 *   npx --yes tsx scripts/pitch-tap-probe.mts [pitch|roll] [kinds...]
 *
 *   GEARED=0             fly without the catalogue's `pitchGearing` (the old stick)
 *   KNEE=140 FLOOR=0.35  try a gearing on every kind, for tuning
 *
 * Flies two copies of the same roughly level flight at 1,000 m: one
 * hands-off, one given the lightest keyboard tap InputManager can make (the
 * minimum tap hold, slewed at the default sensitivity), geared and then held
 * by Direct mode's pitch retention exactly as the worker does it. Reports the
 * DIFFERENCE, so the off-trim drift both copies share cancels out. The pitch
 * table in src/sim/pitchGearing.ts came from here.
 */
import {
  aircraftDefinition,
  AIRCRAFT_KINDS,
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FIXED_TIME_STEP,
  FlightSimulator,
  type AircraftKind,
  type FlightControls,
} from "../src/sim/index.ts";
import { pitchGearingFactor, type PitchGearing } from "../src/sim/pitchGearing.ts";
import {
  KEYBOARD_PITCH_ENGAGE_RATE,
  KEYBOARD_PITCH_RELEASE_RATE,
  KEYBOARD_PITCH_TAP_SECONDS,
  slewAxis,
} from "../src/input/index.ts";
import { aircraftSpec } from "../src/aircraft/catalogue.ts";

const DEG = 180 / Math.PI;
const args = process.argv.slice(2);
const axis = args[0] === "roll" ? "roll" : "pitch";
const kinds = (args.slice(axis === args[0] ? 1 : 0) as AircraftKind[]).filter((k) => AIRCRAFT_KINDS.includes(k));
const geared = process.env.GEARED !== "0";
/** KNEE=<m/s> [FLOOR=<share>] tries a gearing on every kind, for tuning. */
const override: PitchGearing | null = process.env.KNEE
  ? { kneeAirspeed: Number(process.env.KNEE), floor: Number(process.env.FLOOR ?? 0.35) }
  : null;
function gearingFor(kind: AircraftKind): PitchGearing | null {
  if (!geared) return null;
  return override ?? aircraftSpec(kind).pitchGearing;
}

const SPEEDS: Record<AircraftKind, number[]> = {
  trainer: [35, 45, 55, 65],
  jet: [80, 120, 160, 200, 250, 300, 350],
  bizjet: [80, 120, 160, 190],
  airliner: [90, 130, 160, 190],
};

function throttleFor(kind: AircraftKind): number {
  return aircraftSpec(kind).spawn.airborneThrottle;
}

function run(kind: AircraftKind, speed: number, tap: number): {
  pitch: number[]; bank: number[]; rate: number[]; n: number[]; eas: number;
} {
  const aircraft = aircraftDefinition(kind);
  const throttle = throttleFor(kind);
  const controls: FlightControls = { ...DEFAULT_CONTROLS, throttle, gear: aircraft.retractableGear ? 0 : 1 };
  const sim = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: 1_000, z: 0 },
      heading: 0,
      pitch: 0,
      airspeed: speed,
      controls,
    },
    controls,
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  const retention = new DirectPitchRetention();
  // Let the spawn transient settle a little before the tap.
  const settle = Math.round(1 / FIXED_TIME_STEP);
  let stick = 0;
  let tapRemaining = 0;
  const out = { pitch: [] as number[], bank: [] as number[], rate: [] as number[], n: [] as number[], eas: 0 };
  for (let step = 0; step < settle + Math.round(3 / FIXED_TIME_STEP); step += 1) {
    if (step === settle && tap !== 0) tapRemaining = KEYBOARD_PITCH_TAP_SECONDS;
    const held = tapRemaining > 0 ? tap : 0;
    tapRemaining = Math.max(0, tapRemaining - FIXED_TIME_STEP);
    const telemetry = sim.telemetry();
    if (step === settle) out.eas = telemetry.indicatedAirspeed;
    stick = axis === "pitch"
      ? slewAxis(stick, held, KEYBOARD_PITCH_ENGAGE_RATE, KEYBOARD_PITCH_RELEASE_RATE, FIXED_TIME_STEP)
      // InputManager's roll slew; its tap holds as long as pitch's.
      : slewAxis(stick, held, 2.15, 3.4, FIXED_TIME_STEP);
    const requested: FlightControls = { ...controls, [axis]: stick };
    // As the worker does it: Direct passes the GEARED stick to the elevator,
    // and pitch retention still reads the pilot's own hand.
    const geared: FlightControls = axis === "pitch"
      ? { ...requested, pitch: stick * pitchGearingFactor(gearingFor(kind), telemetry.indicatedAirspeed) }
      : requested;
    const commanded = retention.apply(geared, requested, sim.state, telemetry);
    sim.step(FIXED_TIME_STEP, commanded);
    if (step >= settle) {
      const t = sim.telemetry();
      out.pitch.push(t.pitch);
      out.bank.push(t.bank);
      out.rate.push(axis === "pitch" ? sim.state.angularVelocity.z : sim.state.angularVelocity.x);
      out.n.push(t.loadFactor);
    }
  }
  return out;
}

const list = kinds.length > 0 ? kinds : [...AIRCRAFT_KINDS];
console.log(`${axis} tap (geared=${geared}${override ? ` knee ${override.kneeAirspeed} floor ${override.floor}` : ""})`);
for (const kind of list) {
  for (const speed of SPEEDS[kind]) {
    const base = run(kind, speed, 0);
    const tapped = run(kind, speed, 1);
    let peakRate = 0;
    let peakN = 0;
    for (let i = 0; i < base.rate.length; i += 1) {
      const dr = tapped.rate[i]! - base.rate[i]!;
      if (Math.abs(dr) > Math.abs(peakRate)) peakRate = dr;
      const dn = tapped.n[i]! - base.n[i]!;
      if (Math.abs(dn) > Math.abs(peakN)) peakN = dn;
    }
    const at = (s: number) => Math.round(s / FIXED_TIME_STEP) - 1;
    const series = axis === "pitch" ? "pitch" : "bank";
    const d1 = (tapped[series][at(1)]! - base[series][at(1)]!) * DEG;
    const d2 = (tapped[series][at(2)]! - base[series][at(2)]!) * DEG;
    console.log(
      `${kind.padEnd(8)} ${String(speed).padStart(3)} m/s (EAS ${base.eas.toFixed(0).padStart(3)})  ` +
      `peak d-rate ${(peakRate * DEG).toFixed(1).padStart(6)} deg/s  ` +
      `peak dn ${peakN.toFixed(2).padStart(6)} g  ` +
      `d-${series} @1s ${d1.toFixed(1).padStart(6)}  @2s ${d2.toFixed(1).padStart(6)} deg`,
    );
  }
}
