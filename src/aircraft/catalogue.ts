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

/**
 * The cinematic view's orbit, which has to clear the aeroplane it circles.
 *
 * A fixed 24 m radius was fine for a 7 m trainer and an 11 m sport jet. It is
 * INSIDE a Global 8000's 31.7 m wingspan, so the camera flew through the wing
 * and framed a fuselage panel instead of an aeroplane.
 */
export interface CinematicOrbitSpec {
  readonly radiusMeters: number;
  readonly heightMeters: number;
  /** How far the height drifts above and below, for a little life. */
  readonly heightDriftMeters: number;
}

/**
 * Where the pilot's eye sits, in metres from the centre of gravity, in the
 * body frame (+X nose, +Y up, +Z starboard).
 *
 * `right` is positive to STARBOARD. The pilot flies from the LEFT seat in the
 * 150, the Global and the 747, so it is negative there; the F-16 has one seat
 * on the centreline. It used to be absent, which put the eye on the centreline
 * of every airframe — between the two seats of the three that have two.
 *
 * The cockpit camera aims parallel to the body axis from wherever the eye is,
 * so this moves the viewpoint without turning the view: the HUD's centre mark
 * still means "where the nose points".
 */
export interface CockpitEyeSpec {
  readonly forward: number;
  readonly up: number;
  readonly right: number;
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
  /**
   * Flap setting an aeroplane sits on the runway with, ready to go.
   *
   * Not a cosmetic default: it is the configuration each one's measured
   * take-off roll was flown at, so a pilot who pushes the throttle up without
   * touching anything gets the distance the definition promises.
   */
  readonly runwayFlaps: number;
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
  readonly cinematic: CinematicOrbitSpec;
  readonly cockpitEye: CockpitEyeSpec;
  /**
   * The deck's top below the eye, in degrees, measured on the built kit: where
   * the glareshield, panel, screens and bezels begin, seen from `cockpitEye` looking
   * down the body axis — the angle whose tangent is the deck's highest ROW's drop
   * below the centre row, per unit of the lens's focal length. Straight ahead that
   * is the deck edge's depression; off-centre it describes the row, which is what a
   * window cares about.
   *
   * The 2D HUD keeps out from under it in cockpit view (`flight-hud--cockpit` in
   * src/game/flight.css). The cockpit lens is horizontal-fixed, so on any window
   * the deck's top sits `(width / 2) * tan(this) / tan(lens / 2)` pixels below the
   * centre row — which is how the rule holds for any window shape.
   *
   * Asserted by ray against the built kit in tests/ui.hud-cockpit-deck-line.test.ts,
   * so a kit that moves its deck moves this with it.
   */
  readonly cockpitDeckLineDegrees: number;
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
   * from the F-16C's coefficients and inertia, so switching it on for an
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
  cinematic: Object.freeze({ radiusMeters: 24, heightMeters: 8.5, heightDriftMeters: 2 }),
  // Measured against the built cabin, not guessed. The 150's cabin passes
  // UNDER its wing, so everything is low: seat pan at y -0.17, cabin roof at
  // 0.18, instrument panel top at 0.01 and 2.02 m forward. The old fictional
  // airframe's 1.12 m would put the pilot's head through the roof; 0.02 put it
  // level with the panel top, which filled the lower half of the windscreen
  // with instrument. 0.12 clears the panel by 11 cm over a 0.64 m reach —
  // about 11 degrees of down-angle — and still leaves 6 cm of headroom.
  //
  // `right` -0.26 is the port seat's centre (`port-seat`, z -0.26): the pilot
  // sits on the left, and the eye used to be on the centreline between the two
  // seats.
  cockpitEye: Object.freeze({ forward: 1.38, up: 0.12, right: -0.26 }),
  // The glareshield's crown, right of centre.
  cockpitDeckLineDegrees: 8.31,
  spawn: Object.freeze({
    airborneAirspeed: 56,
    // Chosen so the aeroplane sits in APPROXIMATELY LEVEL FLIGHT hands-off,
    // which is what a player gets after every crash recovery and airborne
    // restart. Measured, not trimmed: 20 s hands-off for the excursion, then
    // 180 s for the phugoid, because the two horizons disagree and only the
    // short one is flattering.
    // 0.62 climbs 59 m in 20 s and never dips; 0.50 looks calmer early and
    // then sinks 122 m, past this test's bar. The 150 shows more pitch (8.2
    // deg) than the jets simply because 2.4 degrees of spawn attitude is a
    // bigger deal at 56 m/s.
    airborneThrottle: 0.62,
    runwayTrim: 0.04,
    airborneGear: 1,
    // A 150 takes off clean; its flaps are for the approach and for a short
    // field, not for an ordinary departure.
    runwayFlaps: 0,
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
  name: "F-16C Fighting Falcon",
  description: "Fighter",
  chase: Object.freeze({
    // The speed response is the point: the rig pulls back AND pushes the aim
    // point forward, so the aircraft slides forward in frame and the world
    // streams past it.
    //
    // Re-derived for the F-16, which broke the old profile in both directions.
    // It was sized for an ~11 m aeroplane with a ~260 m/s ceiling, giving a
    // 115 m/s working band above the 145 m/s knee, and the slopes were set so
    // the caps landed exactly at the top of that envelope. The F-16 is 15.06 m
    // and reaches 410 m/s in reheat, so the old caps were reached at 260 and
    // the camera then stopped opening for the fastest 150 m/s of the aeroplane's
    // range — it would have framed Mach 1.2 exactly as it framed Mach 0.76.
    //
    // Bases scale with length (x 15.06/11), and the slopes are recut so the
    // caps land at the real 410 m/s ceiling instead: a 265 m/s band above the
    // distance knee (11/265 = 0.0415) and 270 m/s above the field-of-view knee
    // (6/270 = 0.022).
    distance: Object.freeze({ base: 19.5, knee: 145, slope: 0.0415, cap: 11 }),
    height: 6.2,
    fieldOfView: Object.freeze({ base: 62, knee: 140, slope: 0.022, cap: 6 }),
    aimAhead: Object.freeze({ base: 22, knee: 145, slope: 0.072, cap: 19 }),
  }),
  // 32 m, not the 24 this inherited from an 11 m aeroplane. Measured against
  // the built F-16 (14.90 m long, 10.07 m across the launcher rails): 24 m put
  // the widest dimension across 37% of frame width, where the trainer sits at
  // 26% and the Global at 31%. 32 m gives 28%, a 19-degree look-down that is
  // in family with both, and a radius 6.4x the half-span so the wing is never
  // near the camera at the bottom of the height drift.
  cinematic: Object.freeze({ radiusMeters: 32, heightMeters: 11, heightDriftMeters: 2.5 }),
  // Measured against the built cockpit, and the values this replaces were not
  // survivable: up 1.12 sat 0.11 m ABOVE the canopy crown at that station —
  // the pilot's head through the glass — and forward 1.15 put the eye 1.07 m
  // behind the seat's front edge, under the aft canopy. The comment here used
  // to describe a "tandem canopy"; an F-16 has a single-seat one-piece bubble.
  //
  // From the geometry: the seat back reclined 15 degrees, canopy crown y 1.240
  // at x 2.22, which leaves 0.30 m of headroom: a helmet and no more, as an
  // F-16 canopy is. The cockpit is built AROUND this eye
  // (`cockpit/jetCockpit.ts`): the coaming's near edge reads -16.0 straight
  // ahead and its far edge -10.2, and the HUD frame stands at az +-6.5 / +4.5.
  // The pilot does NOT see the nose: from here the air-data probe's tip reads
  // -10.41 and the radome's crown -11.23, so the coaming covers both. On the
  // type the over-the-nose line is nearer -15, so this eye and the nose loft
  // disagree by a few degrees; that is a nose-loft or eye question, recorded,
  // not settled here.
  // `right` 0: a single-seat aeroplane, and the seat is on the centreline.
  cockpitEye: Object.freeze({ forward: 2.22, up: 0.94, right: 0 }),
  // The coaming's far edge straight ahead (render.cockpit-jet.test.ts holds it at -10.2).
  cockpitDeckLineDegrees: 10.19,
  spawn: Object.freeze({
    // 210 m/s, about 408 kt: an unremarkable low-level cruise for this
    // aeroplane, and comfortably above the speed where the spawn phugoid bites.
    airborneAirspeed: 210,
    // Chosen so the aeroplane sits in APPROXIMATELY LEVEL FLIGHT hands-off,
    // which is what a player gets after every crash recovery and airborne
    // restart. Measured, not trimmed: 20 s hands-off for the excursion, then
    // 180 s for the phugoid, because the two horizons disagree and only the
    // short one is flattering.
    // 0.20, not the 0.65 this started at. 0.65 is most of a 76 kN engine under
    // 11 tonnes, and hands-off it pitched to 20 degrees and climbed at 83 m/s
    // — the aeroplane running away from the player. I first tried to trim that
    // out, which was the wrong lever and a dangerous one: -0.05 trim looks
    // calmer for a few seconds and then dives 4,172 m, and -0.10 puts the nose
    // at 90 degrees. The right lever was the throttle all along. At 0.20 the
    // pitch never leaves the 2.4-degree spawn attitude, the aeroplane gains
    // 74 m in 20 s and the deepest point of the phugoid is 31 m down.
    //
    // 0.16 and 0.18 look better still over 20 s and are traps: they dip 516 m
    // and 180 m respectively once the phugoid comes round.
    airborneThrottle: 0.20,
    runwayTrim: 0.015,
    airborneGear: 0,
    runwayFlaps: 0.5,
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
  // 65 m, not 24: the small aeroplanes orbit at about 1.8 times their chase
  // distance, and 24 m would put this camera a long way inside a 31.7 m
  // wingspan. Height scales with it so the orbit still looks down on the
  // aeroplane rather than along it.
  cinematic: Object.freeze({ radiusMeters: 65, heightMeters: 21, heightDriftMeters: 5 }),
  // Solved by `scripts/global-eye-solve.mts` against the BUILT windscreen. The
  // first eye here (11.6, 1.05) stood ABOVE the pane: the glass is a 0.16 m slab
  // raked 34 degrees whose top edge is at y 0.98, so from y 1.05 the whole
  // windscreen read -4 to -27 degrees, under the horizon. The constraints, with
  // the pane seen straight ahead of the pilot: the eye inside the glass's own
  // vertical span (y 0.72 to 0.85); the glass's top edge +14 to +18 degrees and
  // its bottom edge -14 or lower; the nearest glass at least 0.55 m away; and at
  // least 0.15 m of skin above the head. The feasible region is a thin sliver
  // (forward 11.85 to 11.95 at y 0.78; nothing above y 0.81): further aft the top
  // edge drops under +14, further forward the pane's top-back corner comes inside
  // 0.55 m. This is the middle of it: top edge +15.1, bottom -21.3, glass 0.605 m
  // away, 0.31 m of skin above.
  //
  // `right` -0.52 is the PORT seat's centre. That mesh is named
  // `bizjet-first-officer-seat` and the starboard one `bizjet-captain-seat`,
  // which is the wrong way round for an aeroplane whose captain sits on the
  // left; the eye follows the geometry, not the name. Both seat pairs stand
  // 0.05 m aft of the eye in x (seat centre 11.85).
  cockpitEye: Object.freeze({ forward: 11.9, up: 0.78, right: -0.52 }),
  // The glareshield's top edge.
  cockpitDeckLineDegrees: 10.00,
  spawn: Object.freeze({
    // 200 m/s. 210 was above the speed at which this aeroplane flies level in
    // dense air near the ground, so it converted the excess into climb no
    // matter what the throttle did.
    airborneAirspeed: 200,
    // Chosen so the aeroplane sits in APPROXIMATELY LEVEL FLIGHT hands-off,
    // which is what a player gets after every crash recovery and airborne
    // restart. Measured, not trimmed: 20 s hands-off for the excursion, then
    // 180 s for the phugoid, because the two horizons disagree and only the
    // short one is flattering.
    // 0.28 at 200 m/s: pitch stays at the 2.4-degree spawn attitude, 64 m
    // gained in 20 s, 11 m the deepest the phugoid goes. The old 210/0.62
    // climbed 248 m.
    //
    // This number previously carried a long explanation about the Global's
    // first phugoid swing being downward and 423 m deep, with less throttle
    // making it worse. Those measurements were real; the cause was not
    // aerodynamic. `createFlightState` clamped every spawn airspeed to 180 m/s
    // against a bare constant, so this aeroplane had been starting 30 m/s
    // slower than its catalogue said and buying the difference back by diving.
    airborneThrottle: 0.28,
    runwayTrim: 0.02,
    airborneGear: 0,
    // Half flap, which is what its 942 m take-off roll was measured at.
    runwayFlaps: 0.5,
  }),
  engineReadout: Object.freeze({ label: "N2", unit: "%", maximum: 100, roundTo: 1 }),
  engineSound: Object.freeze({
    // A high-bypass fan is a lower, softer, rounder noise than the sport
    // jet's: lower fundamental, narrower climb, and a low-pass well below the
    // fighter's so the harmonics stay felt rather than heard.
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
  // well-damped mode that wants no help, against the F-16's ~0.11 which does.
  // A high aspect ratio and a very large yaw inertia are why. If the mass or
  // the fin ever change materially, redo this rather than flipping it.
  dutchRollDamper: false,
});


const AIRLINER: AircraftSpec = Object.freeze({
  kind: "airliner",
  name: "Boeing 747-8",
  description: "Airliner",
  chase: Object.freeze({
    // Scaled off the Global's, which was itself scaled off the small
    // aeroplanes': a 68.4 m span needs roughly twice the Global's standoff
    // before the wings stop running off the sides of the frame.
    distance: Object.freeze({ base: 112, knee: 110, slope: 0.1, cap: 26 }),
    height: 34,
    fieldOfView: Object.freeze({ base: 58, knee: 110, slope: 0.028, cap: 4 }),
    aimAhead: Object.freeze({ base: 40, knee: 110, slope: 0.09, cap: 20 }),
  }),
  // Measured against the built airframe: a 37.44 m bounding sphere about
  // (-2.00, 4.50, 0). At the cinematic 58-degree vertical field of view,
  // 155/50 fills 41.5% of frame height where the Global's shipped 65/21 fills
  // 41.6%, and the look-down angle matches at 17.9 degrees on both. The
  // provisional 140/46 was not wrong, just 10% tighter.
  cinematic: Object.freeze({ radiusMeters: 155, heightMeters: 50, heightDriftMeters: 10 }),
  // The eye was chosen on a grid of candidate eyes against the BUILT flight-deck glazing, after
  // the nose was re-lofted and the panes cast by angle (docs/findings/COCKPIT_VIEW_2026_09_20.md,
  // the K0 table), in the PORT seat (the mesh named `airliner-first-officer-seat`; see the
  // Global's note on the swapped seat names). The targets: 0.50 to 0.55 m off the centreline,
  // where the type's seat spacing puts the captain; straight ahead in the middle third of the
  // port No.1 pane's azimuth span; the centre post at +10 to +16; No.1's opening at least 28
  // degrees; the glass at least 1.4 m ahead. From here No.1 reads -8.8..+11.6 at the horizon,
  // the post +13.1..+14.8, the opening 30.4, the glass 1.90 m. The height is the old eye's: the
  // pilot's eye height is what stays when the seat moves inboard, and the crown is higher there,
  // so the headroom grew (0.522 to 0.615) rather than the eye.
  //
  // It exists only because the flight deck is built AROUND it (`cockpit/airlinerCockpit.ts`):
  // the seats stand under it, 0.50 m either side; the panel's face is 0.85 m ahead; the
  // glareshield's lip reads -18.04 straight ahead. The eye before this one, (29.9, 2.93, -0.72),
  // was solved against the flat window boxes the re-loft replaced, and from it the pilot looked
  // through the outboard edge of their own No.1 with the No.1 / No.2 pillar 1.8 to 3.7 degrees
  // left of straight ahead.
  cockpitEye: Object.freeze({ forward: 29.85, up: 2.93, right: -0.5 }),
  // The glareshield's lip: a line along z at the panel's face, so it is ONE row across the whole
  // frame, the deck's highest, by tests/support/cockpitFootprints.ts's instrument and straight
  // ahead by ray (tests/render.cockpit-airliner.test.ts and tests/ui.hud-cockpit-deck-line.test.ts
  // hold both). The sill above it, up to the window, is frame, not deck.
  cockpitDeckLineDegrees: 18.57,
  spawn: Object.freeze({
    // 205 m/s. Faster looked reasonable on paper and is above the speed this
    // aeroplane flies level at down low, where the air is dense: at 230 it
    // climbed away whatever the throttle did.
    airborneAirspeed: 205,
    // Chosen so the aeroplane sits in APPROXIMATELY LEVEL FLIGHT hands-off,
    // which is what a player gets after every crash recovery and airborne
    // restart. Measured, not trimmed: 20 s hands-off for the excursion, then
    // 180 s for the phugoid, because the two horizons disagree and only the
    // short one is flattering.
    // 0.28 at 205 m/s: 2.4 degrees, 68 m gained in 20 s, 48 m the deepest the
    // phugoid reaches. The old 230/0.75 climbed 394 m.
    airborneThrottle: 0.28,
    runwayTrim: 0.02,
    airborneGear: 0,
    // Half flap, the setting its measured 855 m take-off was flown at.
    runwayFlaps: 0.5,
  }),
  engineReadout: Object.freeze({ label: "N1", unit: "%", maximum: 100, roundTo: 1 }),
  engineSound: Object.freeze({
    // Four very large high-bypass fans: lower and broader than the Global's
    // two, with the harmonics rolled off further still.
    baseHz: 38,
    spanHz: 92,
    gainBase: 0.06,
    gainSpan: 0.1,
    filterHz: 680,
    filterQ: 0.75,
    waveforms: Object.freeze(["triangle", "sine"]) as readonly [OscillatorType, OscillatorType],
  }),
  retractableGear: true,
  speedBrake: true,
  // Not worked through for this airframe yet, and defaulting to off rather
  // than inheriting: the damper's gain is sized against the F-16's
  // coefficients, so switching it on here would be a guess. A 747's dutch roll
  // is real and lightly damped, so this is worth revisiting with the same
  // two-degree-of-freedom calculation the Global got.
  dutchRollDamper: false,
});

export const AIRCRAFT_SPECS: Readonly<Record<AircraftKind, AircraftSpec>> = Object.freeze({
  trainer: TRAINER,
  jet: JET,
  bizjet: BIZJET,
  airliner: AIRLINER,
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
