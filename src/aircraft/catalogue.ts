import { AIRCRAFT_KINDS, type AircraftKind } from "@/src/sim";

/**
 * One record per airframe, for everything OUTSIDE the flight model.
 *
 * The flight model itself stays in `src/sim/aircraft.ts`, where it belongs and
 * where it is tested; this is the presentation and handling half — what the
 * aeroplane is called, how the chase camera frames it, where the pilot's eye
 * sits, what it spawns with, what its engine instrument reads and what it
 * sounds like.
 *
 * It exists because those facts were spread across a dozen binary ternaries —
 * `aircraft === "jet" ? a : b` in the renderer, the HUD, the audio graph, the
 * spawn helpers and the settings validator. Two aeroplanes made that survivable.
 * A third would have turned each one into a three-way conditional that the next
 * aeroplane turns into a four-way, with no compiler anywhere insisting the new
 * airframe had been considered. As a `Record<AircraftKind, ...>` keyed off
 * `AIRCRAFT_KINDS`, adding an airframe is a data change and the build refuses
 * to proceed until every field of it has an answer.
 */

/**
 * A quantity that opens up with speed: `base` until `knee`, then `slope` per
 * m/s, never more than `cap` above base.
 *
 * Every chase-camera term the two shipped airframes used had exactly this
 * shape, written out longhand and differently each time. `slope: 0` disables
 * the response and leaves the quantity at `base`.
 */
export interface SpeedRamp {
  readonly base: number;
  readonly knee: number;
  readonly slope: number;
  readonly cap: number;
}

export function rampAtSpeed(ramp: SpeedRamp, airspeed: number): number {
  const speed = Number.isFinite(airspeed) ? airspeed : 0;
  return ramp.base + Math.max(0, Math.min(ramp.cap, (speed - ramp.knee) * ramp.slope));
}

/** How the chase rig frames this airframe. */
export interface ChaseFramingSpec {
  /** Metres the camera trails the aircraft, before the response trail. */
  readonly distance: SpeedRamp;
  /** Metres the camera sits above the aircraft, along the rig's vertical. */
  readonly height: number;
  /** Vertical field of view in degrees. */
  readonly fieldOfView: SpeedRamp;
  /** Metres ahead of the aircraft the camera aims. */
  readonly aimAhead: SpeedRamp;
}

/** Where the pilot's eye sits, in metres from the centre of gravity. */
export interface CockpitEyeSpec {
  readonly forward: number;
  readonly up: number;
}

/** What the aeroplane is holding when a flight begins. */
export interface SpawnSpec {
  /** Airspeed for an airborne start, in m/s. */
  readonly airborneAirspeed: number;
  /** Throttle that holds that speed level. */
  readonly airborneThrottle: number;
  /** Elevator trim set on the runway. */
  readonly runwayTrim: number;
  /** Gear extension for an airborne start; fixed gear is always 1. */
  readonly airborneGear: number;
}

/** The engine instrument on the HUD, which is not an RPM gauge on a turbine. */
export interface EngineReadoutSpec {
  readonly label: string;
  readonly unit: string;
  /** The reading at full power, used to normalize the engine's sound. */
  readonly maximum: number;
  /** Rounding applied before display: a tachometer does not show single revs. */
  readonly roundTo: number;
}

/** The synthesized engine note. */
export interface EngineSoundSpec {
  /** Fundamental in Hz at idle, and how far it climbs at full power. */
  readonly baseHz: number;
  readonly spanHz: number;
  /** Engine gain at idle, and how far it climbs at full power. */
  readonly gainBase: number;
  readonly gainSpan: number;
  /** Low-pass shaping the harmonics. */
  readonly filterHz: number;
  readonly filterQ: number;
  /** Waveform of the first and second harmonic. */
  readonly waveforms: readonly [OscillatorType, OscillatorType];
}

export interface AircraftSpec {
  readonly kind: AircraftKind;
  /** The name a pilot sees. */
  readonly name: string;
  /** One or two words under the name in the picker. */
  readonly description: string;
  readonly chase: ChaseFramingSpec;
  readonly cockpitEye: CockpitEyeSpec;
  readonly spawn: SpawnSpec;
  readonly engineReadout: EngineReadoutSpec;
  readonly engineSound: EngineSoundSpec;
  /** Whether the pilot can raise the undercarriage. Drives the HUD gear block. */
  readonly retractableGear: boolean;
  /** Whether the brake control also deploys an airbrake in flight. */
  readonly speedBrake: boolean;
  /**
   * Whether this airframe runs the yaw damper in Direct mode.
   *
   * Not "is it a jet": it is whether the aeroplane's own dutch roll is badly
   * enough damped to need help. `JetStabilityAugmentation`'s gain is derived
   * from the J-45's coefficients and inertia, so switching it on for an
   * airframe it was not sized against would be a guess, not a feature.
   */
  readonly dutchRollDamper: boolean;
}

const TRAINER: AircraftSpec = Object.freeze({
  kind: "trainer",
  name: "Cessna 150",
  description: "Trainer",
  chase: Object.freeze({
    distance: Object.freeze({ base: 13.5, knee: 45, slope: 0.012, cap: 2.2 }),
    height: 5.1,
    fieldOfView: Object.freeze({ base: 62, knee: 38, slope: 0.035, cap: 3 }),
    // A light aeroplane's speed range is too narrow to be worth an aim
    // response; slope 0 pins it.
    aimAhead: Object.freeze({ base: 16, knee: 0, slope: 0, cap: 0 }),
  }),
  // The 150's cabin passes UNDER its wing, so the seats are barely above the
  // centre of gravity — nothing like the 1.12 m the old fictional airframe
  // used, which would now put the pilot's head through the roof and above the
  // wing.
  cockpitEye: Object.freeze({ forward: 1.45, up: 0.02 }),
  spawn: Object.freeze({
    airborneAirspeed: 56,
    airborneThrottle: 0.68,
    runwayTrim: 0.04,
    airborneGear: 1,
  }),
  // The O-200's red line is 2,750 rpm.
  engineReadout: Object.freeze({ label: "RPM", unit: "PROP", maximum: 2_750, roundTo: 10 }),
  engineSound: Object.freeze({
    baseHz: 34,
    spanHz: 58,
    gainBase: 0.035,
    gainSpan: 0.1,
    filterHz: 720,
    filterQ: 1.1,
    waveforms: Object.freeze(["sawtooth", "triangle"]) as readonly [OscillatorType, OscillatorType],
  }),
  retractableGear: false,
  speedBrake: false,
  dutchRollDamper: false,
});

const JET: AircraftSpec = Object.freeze({
  kind: "jet",
  name: "Vesper J-45",
  description: "Fast jet",
  chase: Object.freeze({
    // The speed response is the point: the rig pulls back AND pushes the aim
    // point forward, so the aircraft slides forward in frame and the world
    // streams past it. Sized for the ~11 m J-45 — the response opens above
    // 145 m/s and its ~260 m/s ceiling gives a 115 m/s working band, so the
    // slopes reach their caps right at the top of the envelope
    // (0.07*115 = 8.05 >= 8; 0.12*115 = 13.8 ~ 14; 0.05*120 = 6.0 = 6 measured
    // from the 140 m/s field-of-view knee).
    distance: Object.freeze({ base: 14.3, knee: 145, slope: 0.07, cap: 8 }),
    height: 5,
    fieldOfView: Object.freeze({ base: 62, knee: 140, slope: 0.05, cap: 6 }),
    aimAhead: Object.freeze({ base: 16, knee: 145, slope: 0.12, cap: 14 }),
  }),
  // The J-45's tandem canopy and the trainer's cabin happen to seat the pilot
  // at the same offsets from the centre of gravity.
  cockpitEye: Object.freeze({ forward: 1.15, up: 1.12 }),
  spawn: Object.freeze({
    airborneAirspeed: 155,
    // Dry thrust is much less speed-limited than propeller thrust. This
    // setting balances jet drag near the 155 m/s airborne spawn instead of
    // turning a neutral handoff into a zoom climb.
    airborneThrottle: 0.17,
    runwayTrim: 0.015,
    airborneGear: 0,
  }),
  // Turbine telemetry is percent N2, not crankshaft revolutions.
  engineReadout: Object.freeze({ label: "N2", unit: "%", maximum: 100, roundTo: 1 }),
  engineSound: Object.freeze({
    baseHz: 88,
    spanHz: 205,
    gainBase: 0.045,
    gainSpan: 0.082,
    filterHz: 1_450,
    filterQ: 0.72,
    waveforms: Object.freeze(["triangle", "sine"]) as readonly [OscillatorType, OscillatorType],
  }),
  retractableGear: true,
  speedBrake: true,
  dutchRollDamper: true,
});

const BIZJET: AircraftSpec = Object.freeze({
  kind: "bizjet",
  name: "Bombardier Global 8000",
  description: "Business jet",
  chase: Object.freeze({
    // Three times the aeroplane needs three times the rig. The framing
    // distance is set from the airframe's LENGTH rather than copied: the
    // trainer sits at 1.7x its own length and the sport jet at 1.3x, and a
    // 33.9 m aeroplane at either of those would be a speck or a wall. 38 m is
    // about 1.1x, which fills the frame the way the other two do.
    distance: Object.freeze({ base: 38, knee: 200, slope: 0.07, cap: 8 }),
    // Proportionally lower than the small aeroplanes' rigs: looking down on a
    // 34 m aircraft from 0.65x its length would be a plan view.
    height: 10.5,
    fieldOfView: Object.freeze({ base: 62, knee: 200, slope: 0.05, cap: 5 }),
    aimAhead: Object.freeze({ base: 30, knee: 200, slope: 0.1, cap: 12 }),
  }),
  // A flight deck a long way forward of the centre of gravity and well above
  // it, which is most of what makes a large aeroplane feel large to taxi.
  cockpitEye: Object.freeze({ forward: 12, up: 1.5 }),
  spawn: Object.freeze({
    // M 0.62 at low level: clean, comfortable, and well inside the flap and
    // gear speeds so a pilot who reaches for either is not punished.
    airborneAirspeed: 210,
    // 0.58, and set by where the aeroplane ENDS UP rather than by trimming
    // level. Every airborne spawn in this game starts 2.4 degrees nose-up and
    // off-trim, which excites a phugoid; the sport jet's first swing is upward
    // and nobody minds, but a 40-tonne aeroplane's first swing was DOWNWARD
    // and deep. Measured over 180 s from a 183 m spawn: 0.25 throttle sinks
    // 702 m and hits the ground, 0.35 sinks 423 m, 0.50 sinks 174 m and is
    // still marginal. 0.58 bottoms out 100 m below the spawn — clear of the
    // ground with room — and then climbs away like the J-45 does. Less
    // throttle makes the dip WORSE, not better, which is the opposite of what
    // trimming for level flight would suggest and the reason this is a
    // measured number rather than a derived one.
    airborneThrottle: 0.58,
    runwayTrim: 0.02,
    airborneGear: 0,
  }),
  engineReadout: Object.freeze({ label: "N2", unit: "%", maximum: 100, roundTo: 1 }),
  engineSound: Object.freeze({
    // A high-bypass fan is a lower, softer, rounder noise than the sport
    // jet's: lower fundamental, narrower climb, and a low-pass well below the
    // J-45's so the harmonics stay felt rather than heard.
    baseHz: 52,
    spanHz: 120,
    gainBase: 0.05,
    gainSpan: 0.09,
    filterHz: 900,
    filterQ: 0.8,
    waveforms: Object.freeze(["triangle", "sine"]) as readonly [OscillatorType, OscillatorType],
  }),
  retractableGear: true,
  speedBrake: true,
  // Worked through for this airframe rather than inherited: at 210 m/s at
  // 3,000 m its two-degree-of-freedom dutch roll comes out at omega_n about
  // 2.95 rad/s with 2*zeta*omega_n about 2.45, so zeta is roughly 0.42 — a
  // well-damped mode that wants no help, against the J-45's 0.163 which does.
  // A high aspect ratio and a very large yaw inertia are why. If the mass or
  // the fin ever change materially, redo this rather than flipping it.
  dutchRollDamper: false,
});

export const AIRCRAFT_SPECS: Readonly<Record<AircraftKind, AircraftSpec>> = Object.freeze({
  trainer: TRAINER,
  jet: JET,
  bizjet: BIZJET,
});

/** Every airframe, in the order the picker offers them. */
export const AIRCRAFT_CATALOGUE: readonly AircraftSpec[] = Object.freeze(
  AIRCRAFT_KINDS.map((kind) => AIRCRAFT_SPECS[kind]),
);

/**
 * Falls back to the trainer rather than throwing: this is read on the render
 * path, and a settings value that escaped validation should cost a wrong
 * aeroplane, not a blank screen.
 */
export function aircraftSpec(kind: AircraftKind): AircraftSpec {
  return AIRCRAFT_SPECS[kind] ?? TRAINER;
}
