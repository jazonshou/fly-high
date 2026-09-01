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
