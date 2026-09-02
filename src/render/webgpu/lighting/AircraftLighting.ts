import type { AircraftKind } from "@/src/sim";
import { AIRFIELD_LAMP_FULL_EFFECT_LUX } from "./AirfieldLighting";

/**
 * `7-8`: navigation, anti-collision beacon, strobe and landing lights.
 *
 * Sited under `lighting/` rather than `aircraft/` deliberately (`owners.ts`):
 * the aircraft subsystem owns form and mount points, while the emission law is
 * one model shared with the airfield — otherwise the two drift apart in colour
 * and falloff.
 *
 * **This file is the LAW, and it is pure.** Angles, periods and gating are
 * plain functions of their inputs so every pin `7-8` asks for can be asserted
 * in Node: split angles verified by sampling visibility around the airframe,
 * beacon and strobe provably out of phase, landing light off in the default
 * shots. The system that turns them into draws comes after, and consumes these.
 *
 * **The body-axis contract is settled and must not be re-derived here.**
 * `D-6` established starboard = body +Z, corrected both airframes' lamp sides
 * and removed the local roll compensation in `src/input/index.ts`. Everything
 * below takes an azimuth already expressed in that frame.
 */

/** Nose-relative azimuth, degrees, positive toward STARBOARD (body +Z). */
export type RelativeAzimuthDegrees = number;

export type AircraftNavLight = "port" | "starboard" | "tail";

/**
 * The regulated arcs. Port and starboard each cover 110° from dead ahead; the
 * tail covers the remaining 140°. **110 + 110 + 140 = 360 exactly**, which is
 * the property that makes the set a partition rather than three independent
 * cones — every bearing sees exactly one nav light, which is what lets an
 * observer infer heading at all.
 */
export const NAV_LIGHT_ARC_DEGREES = Object.freeze({
  port: 110,
  starboard: 110,
  tail: 140,
});

/** Flashes per minute, and the periods that follow. */
export const BEACON_FLASHES_PER_MINUTE = 45;
export const STROBE_FLASHES_PER_MINUTE = 60;
export const BEACON_PERIOD_SECONDS = 60 / BEACON_FLASHES_PER_MINUTE;
export const STROBE_PERIOD_SECONDS = 60 / STROBE_FLASHES_PER_MINUTE;

/**
 * Fraction of each period the lamp is lit. A beacon is a slow rotating-mirror
 * pulse and reads as a longer flash; a strobe is a capacitor discharge and is
 * much shorter. These are what make the two distinguishable to the eye even
 * when their periods are close.
 */
export const BEACON_DUTY = 0.22;
export const STROBE_DUTY = 0.06;

/**
 * **The strobe is offset by half its period, and this is load-bearing.**
 *
 * Both rates divide the capture interval exactly — shots are spaced 120 s
 * apart, `120 / BEACON_PERIOD_SECONDS = 90` and `120 / STROBE_PERIOD_SECONDS =
 * 120`, both whole. So at every canonical sample time both lamps sit at phase
 * 0. Without an offset they would be simultaneously lit in every shot the set
 * contains, and a capture could never distinguish them or catch one being
 * wired to the other's timer.
 *
 * A half-period offset makes the strobe DARK at phase 0 while the beacon is
 * lit, so the canonical frame carries one of each state. It does not fix the
 * deeper problem — no shot ever samples the beacon's off phase — which is what
 * `night-beacon-offset` at `7-0-a` exists for. It does mean the two are
 * provably not the same signal.
 */
export const STROBE_PHASE_OFFSET = 0.5;

/**
 * Which nav light an observer at this bearing sees.
 *
 * Returns exactly one light for every input, including the boundaries, so the
 * arcs partition the circle with no bearing dark and none double-lit. The
 * boundary rule is half-open: a bearing exactly on the port/tail edge belongs
 * to the tail, so the two never both claim it.
 */
export function navLightAtAzimuth(azimuth: RelativeAzimuthDegrees): AircraftNavLight {
  if (!Number.isFinite(azimuth)) return "tail";
  // Normalise to [-180, 180), positive toward starboard.
  let a = ((azimuth + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  const halfStarboard = NAV_LIGHT_ARC_DEGREES.starboard;
  const halfPort = NAV_LIGHT_ARC_DEGREES.port;
  if (a >= 0 && a < halfStarboard) return "starboard";
  if (a < 0 && a > -halfPort) return "port";
  return "tail";
}

/** Is a given nav light visible from this bearing? */
export function navLightVisibleFrom(
  light: AircraftNavLight,
  azimuth: RelativeAzimuthDegrees,
): boolean {
  return navLightAtAzimuth(azimuth) === light;
}

/**
 * Phase of a flashing lamp in `[0, 1)`, anchored on `simulationTime`.
 *
 * Anchored rather than accumulated, per the propeller precedent
 * (`createAircraft.ts`): a lamp driven by summed deltas drifts with frame rate
 * and is not reproducible in a capture, where the driver pins simulation time.
 */
export function flashPhase(
  simulationTimeSeconds: number,
  periodSeconds: number,
  offset = 0,
): number {
  if (!Number.isFinite(simulationTimeSeconds) || !(periodSeconds > 0)) return 0;
  const raw = simulationTimeSeconds / periodSeconds + offset;
  return ((raw % 1) + 1) % 1;
}

/** Is the red anti-collision beacon lit at this simulation time? */
export function beaconLit(simulationTimeSeconds: number): boolean {
  return flashPhase(simulationTimeSeconds, BEACON_PERIOD_SECONDS) < BEACON_DUTY;
}

/** Are the white strobes lit at this simulation time? */
export function strobeLit(simulationTimeSeconds: number): boolean {
  return flashPhase(simulationTimeSeconds, STROBE_PERIOD_SECONDS, STROBE_PHASE_OFFSET)
    < STROBE_DUTY;
}

export interface LandingLightInput {
  /** Height above ground, metres. */
  readonly altitudeAglMeters: number;
  /** Gear extension, 0 retracted to 1 down. */
  readonly gear: number;
  /** The pilot's switch. Off by default. */
  readonly switchOn: boolean;
}

/**
 * Above this height the landing light is off regardless of the switch.
 *
 * Real practice is roughly "below 10,000 ft", but the number here is chosen
 * against the CAPTURE SET rather than the regulation: the shots that fly with
 * `gear: 1` at altitude are `slant-10km`, `high-10000ft-down` and
 * `cruise-horizon`, and this must leave all of them dark.
 */
export const LANDING_LIGHT_MAX_AGL_METERS = 900;

/**
 * Is the landing light on?
 *
 * **Deliberately NOT gated on `gear` alone.** Every capture shot flies with
 * `gear: 1, onGround: false`, so a gear-driven light switches on in all of
 * them — including `slant-10km`, `high-10000ft-down` and `cruise-horizon`,
 * which have nothing to do with night — and churns baselines for a reason
 * unrelated to what those shots test. Three conditions, all required.
 */
export function landingLightOn(input: LandingLightInput): boolean {
  if (!input.switchOn) return false;
  if (!(input.gear > 0.5)) return false;
  if (!Number.isFinite(input.altitudeAglMeters)) return false;
  return input.altitudeAglMeters <= LANDING_LIGHT_MAX_AGL_METERS;
}

/** Per-lamp emissive scale in [0, 1], applied by the aircraft to its materials. */
export interface AircraftLightState {
  readonly portNav: number;
  readonly starboardNav: number;
  readonly tailNav: number;
  readonly beacon: number;
  readonly strobe: number;
  readonly landing: number;
  /** Multiplier on the authored instrument-marking emissive. 1 by day. */
  readonly cockpitGlow: number;
}

export interface AircraftLightInput {
  /** Pinned by the capture driver; never accumulated from frame deltas. */
  readonly simulationTimeSeconds: number;
  /**
   * Bearing of the OBSERVER from the aircraft's nose, degrees, positive toward
   * starboard. The camera in a single-view renderer.
   */
  readonly observerAzimuthDegrees: number;
  readonly altitudeAglMeters: number;
  readonly gear: number;
  readonly landingSwitchOn: boolean;
  /** `state.sun.direction[1]`, for the cockpit glow. */
  readonly sunElevationSine: number;
  /** Horizontal illuminance, for the cockpit glow. */
  readonly horizontalLux: number;
}

/**
 * Dimming applied to a nav light an observer is outside the arc of.
 *
 * **Not zero, and the reason matters.** A real nav light is masked by a
 * physical shade, and from outside its arc you still see the lit housing and
 * its spill on the wing — not a lamp that has vanished. Snapping to 0 makes
 * lights pop in and out as the aircraft yaws, which reads far more wrongly
 * than a dim lamp does. This is the renderer's stand-in for shade geometry we
 * do not model.
 */
export const NAV_LIGHT_OUT_OF_ARC_SCALE = 0.12;

/**
 * Resolve every aircraft lamp for one frame.
 *
 * Pure, so the whole lighting law is Node-testable and the capture's pinned
 * `simulationTime` reproduces exactly. The caller multiplies these into its
 * emissive materials; nothing here touches Babylon.
 */
export function resolveAircraftLights(input: AircraftLightInput): AircraftLightState {
  const visible = navLightAtAzimuth(input.observerAzimuthDegrees);
  const nav = (light: AircraftNavLight): number =>
    visible === light ? 1 : NAV_LIGHT_OUT_OF_ARC_SCALE;
  return {
    portNav: nav("port"),
    starboardNav: nav("starboard"),
    tailNav: nav("tail"),
    beacon: beaconLit(input.simulationTimeSeconds) ? 1 : 0,
    strobe: strobeLit(input.simulationTimeSeconds) ? 1 : 0,
    landing: landingLightOn({
      altitudeAglMeters: input.altitudeAglMeters,
      gear: input.gear,
      switchOn: input.landingSwitchOn,
    }) ? 1 : 0,
    cockpitGlow: cockpitInstrumentGlow(input.sunElevationSine, input.horizontalLux),
  };
}

/**
 * Bearing of an observer from the aircraft's nose, in the settled body frame.
 *
 * `D-6`: forward is body +X and starboard is body +Z, so the bearing is
 * `atan2(starboard, forward)` — positive toward starboard, which is what
 * `navLightAtAzimuth` expects. Taking body-relative components as arguments
 * keeps this free of any world-space convention.
 */
export function observerAzimuthDegrees(forwardComponent: number, starboardComponent: number): number {
  if (!Number.isFinite(forwardComponent) || !Number.isFinite(starboardComponent)) return 0;
  return (Math.atan2(starboardComponent, forwardComponent) * 180) / Math.PI;
}

/**
 * Cockpit instrument glow, as a MULTIPLIER on each airframe's authored value.
 *
 * **A multiplier rather than an absolute intensity, and exactly 1 by day.**
 * The trainer's markings emit at 0.42 and the jet's at 0.7 — different values,
 * authored per airframe against the daylight shots that already exist. An
 * absolute law would have to pick one and would move both. Returning exactly
 * the literal 1 in daylight leaves `authored * 1 === authored` bit-for-bit, so
 * **eleven cockpit-mode capture shots cannot churn**, which is the same
 * construction-not-measurement guarantee the airfield attenuation uses at
 * night.
 *
 * The direction is the mirror of `airfieldLampDaylightAttenuation`: that one
 * suppresses lamps as the sun rises, this one raises panel lighting as the sun
 * sets. Sharing the shape means one place to reason about, and the horizon gate
 * is syntactic in both.
 */
export const COCKPIT_GLOW_NIGHT_MULTIPLE = 3.2;

export function cockpitInstrumentGlow(
  sunElevationSine: number,
  horizontalLux: number,
): number {
  // Daylight: the authored value, untouched. `!(x > 0)` so a NaN sun takes the
  // NIGHT branch rather than producing a NaN intensity — the panel going dark
  // is a worse failure than it being bright, because a pilot reads it.
  if (sunElevationSine > 0) {
    if (!Number.isFinite(horizontalLux)) return 1;
    // Fades UP through twilight rather than snapping at the horizon: the sun
    // crossing zero is not the moment a panel becomes unreadable.
    const t = Math.min(1, Math.max(0, horizontalLux / AIRFIELD_LAMP_FULL_EFFECT_LUX));
    return 1 + (COCKPIT_GLOW_NIGHT_MULTIPLE - 1) * (1 - t);
  }
  return COCKPIT_GLOW_NIGHT_MULTIPLE;
}

/**
 * `7-8`: the landing and taxi CAST POOLS, as clustered point lights.
 *
 * **These are not the lamps.** The lamp is the emissive lens on the airframe,
 * driven by `resolveAircraftLights`; this is the pool of light it throws on the
 * ground. The two are separate objects with separate rules, and the split is
 * the point:
 *
 * **Lamps are exempt from daylight attenuation; pools are not.** Anti-collision
 * lights are required lit in daylight, so the beacon, strobes and nav lamps
 * emit unattenuated. But a pool of light on the ground at solar noon is
 * invisible in life and would be wrong in the frame. **The lamp being visible
 * and the ground being lit by it are two claims, and only the first survives
 * daylight** — so the pools take `airfieldLampDaylightAttenuation`, the same
 * law as the hangar floods rather than an aircraft variant of it.
 *
 * **Point lights, because that is what the container holds.** A landing light
 * is really a spot, and `ClusteredLightingSystem` builds `PointLight`s. The
 * offsets below put the source ahead of and below the aircraft so the pool
 * lands where a beam would, which is the honest approximation available.
 */
export interface AircraftCastPool {
  readonly name: string;
  /** Body-frame offset: +X forward, +Y up, +Z starboard (`D-6`). */
  readonly offset: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly rangeMeters: number;
}

export const AIRCRAFT_CAST_POOLS: readonly AircraftCastPool[] = Object.freeze([
  Object.freeze({
    name: "aircraft-landing-pool",
    // Well ahead and below: a landing light illuminates the touchdown zone, not
    // the airframe. 40 m forward at 3 m below puts the pool where the aircraft
    // is going rather than where it is.
    offset: [40, -3, 0] as const,
    color: [1, 0.94, 0.82] as const,
    intensity: 12,
    rangeMeters: 90,
  }),
  Object.freeze({
    name: "aircraft-taxi-pool",
    // Close and wide: a taxi light lights the ground immediately ahead.
    offset: [14, -2, 0] as const,
    color: [1, 0.95, 0.86] as const,
    intensity: 5,
    rangeMeters: 34,
  }),
]);

/**
 * Which lamp scalar in `AircraftLightState` modulates a wash light. The wash is
 * the lamp's own spill, so it flashes when the lamp flashes and dies when it
 * dies — a beacon wash that stayed lit through the beacon's dark phase would be
 * a light with no source.
 */
export type AircraftWashDriver =
  | "portNav"
  | "starboardNav"
  | "tailNav"
  | "beacon"
  | "strobe";

/**
 * `7-15`: the aircraft's own lamps spilling onto its own airframe.
 *
 * **Why this exists as a separate table from `AIRCRAFT_CAST_POOLS`.** The cast
 * pools are correct as what they are — a landing light illuminates the
 * touchdown zone, not the airframe — and they are sited 40 m and 14 m AHEAD
 * for that reason. **MEASURED: switching them on lifts the airframe by
 * +1.6% at `night-moonlit`, which reads as nothing**, because what reaches the
 * aircraft is spill off the back of a beam aimed elsewhere. Keeping the wash
 * separate is what lets "the pools light the ground" and "the lamps light the
 * aircraft" remain two claims that can be measured and broken independently.
 *
 * **Sited AT the lamps, not at the aircraft's centre.** A point light inside
 * the fuselage would light the airframe from a place no lamp occupies and read
 * as an aircraft glowing from within. Each entry below sits on the emissive
 * lamp it belongs to, at the coordinates `createAircraft` gives that lamp, so
 * the wingtips are lit from their own wingtip.
 *
 * **Ranges are small on purpose, and that is the scene protection.** The widest
 * is 9 m against a wingspan of 11.3 m, so the wash reaches across the airframe
 * and stops. At the night shots' 152 m AGL the visible ground is 500 m+ away
 * down the view ray, three orders outside any of these ranges — **the wash
 * cannot spill onto the scene by construction, not by tuning.**
 *
 * **Intensities are derived, not guessed.** The landing pool at intensity 12
 * and ~40 m from the airframe measured +1.6%; irradiance goes as 1/d², so the
 * same intensity at ~3 m would deliver (40/3)^2 = 178x that, which is far too
 * much. These are scaled down from that measurement rather than tuned upward
 * from zero until something looked right.
 */
export interface AircraftWashLight {
  readonly name: string;
  /** Body-frame offset: +X forward, +Y up, +Z starboard (`D-6`). */
  readonly offset: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly rangeMeters: number;
  readonly driver: AircraftWashDriver;
}

/**
 * Per-airframe, because the lamps are. The trainer and the jet place every lamp
 * differently — port nav at `(0.2, 0.3, -5.43)` on the trainer and
 * `(-0.2, 0.07, -4.82)` on the jet — and a wash sited from the wrong table
 * would glow half a metre off its own lamp. **Both airframes ship:
 * `settings/index.ts:142` accepts `["trainer", "jet"]`**, so a trainer-only
 * table would be silently wrong for every jet pilot.
 *
 * Coordinates are transcribed from `createAircraft`'s lamp placements and must
 * follow them; `tests/lighting.aircraft-wash.test.ts` asserts each wash sits on
 * a lamp rather than near one, so the two cannot drift apart unnoticed.
 */
const TRAINER_WASH: readonly AircraftWashLight[] = Object.freeze([
  Object.freeze({
    name: "aircraft-beacon-wash",
    offset: [-0.75, 1.02, 0] as const,
    color: [1, 0.11, 0.063] as const,
    intensity: 4.8,
    rangeMeters: 12,
    driver: "beacon" as const,
  }),
  Object.freeze({
    name: "aircraft-nav-wash-port",
    offset: [0.2, 0.3, -5.43] as const,
    color: [1, 0.125, 0.094] as const,
    intensity: 4.4,
    rangeMeters: 9,
    driver: "portNav" as const,
  }),
  Object.freeze({
    name: "aircraft-nav-wash-starboard",
    offset: [0.2, 0.3, 5.43] as const,
    color: [0.141, 1, 0.514] as const,
    intensity: 4.4,
    rangeMeters: 9,
    driver: "starboardNav" as const,
  }),
  Object.freeze({
    name: "aircraft-strobe-wash-port",
    offset: [0.05, 0.32, -5.62] as const,
    color: [0.949, 0.973, 1] as const,
    intensity: 7.2,
    rangeMeters: 10,
    driver: "strobe" as const,
  }),
  Object.freeze({
    name: "aircraft-strobe-wash-starboard",
    offset: [0.05, 0.32, 5.62] as const,
    color: [0.949, 0.973, 1] as const,
    intensity: 7.2,
    rangeMeters: 10,
    driver: "strobe" as const,
  }),
  Object.freeze({
    // `7-15b`: the tail lamp had no wash, and the empennage is the largest
    // stretch of airframe with no lamp near it — every other pool sits forward
    // of the wing trailing edge. MEASURED before adding it: the strongest local
    // lift anywhere on the moonlit airframe was +106%, so the pools were never
    // weak; they were too few, and the mean over the whole airframe band (+3.7%)
    // hid that by averaging lit pools against unlit tail.
    name: "aircraft-tail-wash",
    offset: [-3.18, 1.02, 0] as const,
    color: [1, 0.949, 0.847] as const,
    intensity: 3.4,
    rangeMeters: 9,
    driver: "tailNav" as const,
  }),
]);

const JET_WASH: readonly AircraftWashLight[] = Object.freeze([
  Object.freeze({
    name: "aircraft-beacon-wash",
    offset: [-1.6, 0.92, 0] as const,
    color: [1, 0.11, 0.063] as const,
    intensity: 4.8,
    rangeMeters: 12,
    driver: "beacon" as const,
  }),
  Object.freeze({
    name: "aircraft-nav-wash-port",
    offset: [-0.2, 0.07, -4.82] as const,
    color: [1, 0.125, 0.094] as const,
    intensity: 4.4,
    rangeMeters: 9,
    driver: "portNav" as const,
  }),
  Object.freeze({
    name: "aircraft-nav-wash-starboard",
    offset: [-0.2, 0.07, 4.82] as const,
    color: [0.141, 1, 0.514] as const,
    intensity: 4.4,
    rangeMeters: 9,
    driver: "starboardNav" as const,
  }),
  Object.freeze({
    name: "aircraft-strobe-wash-port",
    offset: [-0.34, 0.09, -4.98] as const,
    color: [0.949, 0.973, 1] as const,
    intensity: 7.2,
    rangeMeters: 10,
    driver: "strobe" as const,
  }),
  Object.freeze({
    name: "aircraft-strobe-wash-starboard",
    offset: [-0.34, 0.09, 4.98] as const,
    color: [0.949, 0.973, 1] as const,
    intensity: 7.2,
    rangeMeters: 10,
    driver: "strobe" as const,
  }),
  Object.freeze({
    // Jet tail lamp, 5.42 m aft against the trainer's 3.18 m.
    name: "aircraft-tail-wash",
    offset: [-5.42, 1.18, 0] as const,
    color: [1, 0.949, 0.847] as const,
    intensity: 3.4,
    rangeMeters: 9,
    driver: "tailNav" as const,
  }),
]);

/** The wash set for an airframe. Both kinds ship; neither may be approximated. */
export function aircraftWashLights(kind: AircraftKind): readonly AircraftWashLight[] {
  return kind === "jet" ? JET_WASH : TRAINER_WASH;
}

/**
 * World position of a cast pool, from the aircraft's world position and its
 * body axes.
 *
 * Takes the body basis as vectors rather than deriving it, so this stays free
 * of any world-space convention and cannot disagree with `FlightRenderer`'s
 * own matrix — the mistake `D-6` cost two items to settle.
 */
export function castPoolWorldPosition(
  aircraftWorld: readonly [number, number, number],
  forward: readonly [number, number, number],
  up: readonly [number, number, number],
  starboard: readonly [number, number, number],
  offset: readonly [number, number, number],
): [number, number, number] {
  return [
    aircraftWorld[0] + forward[0] * offset[0] + up[0] * offset[1] + starboard[0] * offset[2],
    aircraftWorld[1] + forward[1] * offset[0] + up[1] * offset[1] + starboard[1] * offset[2],
    aircraftWorld[2] + forward[2] * offset[0] + up[2] * offset[1] + starboard[2] * offset[2],
  ];
}
