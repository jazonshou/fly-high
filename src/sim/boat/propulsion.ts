import type { BoatGear } from "@/src/game/types";
import type { BoatCalibration, BoatDefinition } from "./definition";

/**
 * The outboard's powertrain: engine, gearcase and propeller, all from the
 * physics rather than a speed table.
 *
 *   T = K_T(J) rho n^2 D^4,   Q = K_Q(J) rho n^2 D^5,   J = V_a / (n D),
 *   V_a = U (1 - w),
 *   I omega' = Q_engine(rpm, throttle) - Q / (ratio eta) ,
 *
 * so the rpm the engine settles at, the speed that rpm gives and the slip
 * between them all come out of the engine curve meeting the propeller curve
 * meeting the hull's drag. The propeller is the high-pitch 3-blade fit in
 * `BOAT_CALIBRATION` (open-water efficiency peaks at 0.69 near J = 0.95).
 *
 * Ventilation: once the blades draw air (immersion against the LOCAL
 * surface, which behind a dry transom is the transom's own hollow), K_T and K_Q
 * fall to a quarter and the engine flares toward the limiter, as an outboard
 * trimmed out too far or leaving a wave does. Air re-attaches slower than it
 * arrives, so a blown-out propeller stays blown out until the load comes off.
 *
 * The binnacle is a single lever: the first `shiftTravel` either side of the
 * neutral detent engages the gear at idle and the rest opens the throttle.
 * The gear changes only below `shiftMaxRpm`: pulling through neutral at speed
 * closes the throttle and waits for the engine to come down, as a real shift
 * cable does.
 */
export class OutboardPowertrain {
  /** Crank speed, rad/s. */
  crankSpeed: number;
  gear: BoatGear = "neutral";
  /** Throttle butterfly, 0..1, after its actuator. */
  throttle = 0;
  /** 0 attached .. 1 fully ventilated. */
  ventilation = 0;
  /** Propeller shaft speed, rev/s, signed (negative astern). */
  propellerRps = 0;
  /** Propeller thrust along the shaft (signed) and its torque magnitude, N and N m. */
  thrust = 0;
  propellerTorque = 0;
  advanceRatio = 0;
  /** Brake torque the engine made this step, N m (negative when it is being driven). */
  engineTorque = 0;
  /** Share of the open-water thrust back cavitation took this step. */
  cavitation = 0;
  private shiftTimer = 0;
  private limiterCut = false;

  /** Projected blade area, m^2: the expanded area times 1.067 - 0.229 P/D (the B-series fit). */
  private readonly projectedArea: number;

  constructor(
    private readonly definition: BoatDefinition,
    private readonly calibration: BoatCalibration,
  ) {
    this.crankSpeed = rpmToRadians(definition.engine.idleRpm);
    const propeller = definition.propeller;
    const disc = (Math.PI / 4) * propeller.diameter * propeller.diameter;
    this.projectedArea = disc * propeller.expandedAreaRatio * (1.067 - (0.229 * propeller.pitch) / propeller.diameter);
  }

  get rpm(): number {
    return (this.crankSpeed * 60) / (2 * Math.PI);
  }

  reset(rpm = this.definition.engine.idleRpm, gear: BoatGear = "neutral"): void {
    this.crankSpeed = rpmToRadians(rpm);
    this.gear = gear;
    this.throttle = 0;
    this.ventilation = 0;
    this.propellerRps = 0;
    this.thrust = 0;
    this.propellerTorque = 0;
    this.advanceRatio = 0;
    this.engineTorque = 0;
    this.cavitation = 0;
    this.shiftTimer = 0;
    this.limiterCut = false;
  }

  /** The gear a lever position asks for. */
  static leverGear(lever: number): BoatGear {
    if (lever > 0.05) return "forward";
    if (lever < -0.05) return "reverse";
    return "neutral";
  }

  /** The throttle a lever position asks for, 0..1, past the shift detent. */
  leverThrottle(lever: number): number {
    const engine = this.definition.engine;
    const travel = engine.shiftTravel;
    const open = Math.min(1, Math.max(0, (Math.abs(lever) - travel) / (1 - travel)));
    return lever < 0 ? open * engine.reverseThrottleMax : open;
  }

  /**
   * Advance by `dt`. `lever` is the binnacle (-1..1, after any assist),
   * `inflow` the water speed along the propeller axis INTO the disc (m/s,
   * positive moving ahead), `immersion` the share of the disc under the local
   * surface. Fills `thrust` and `propellerTorque`.
   */
  update(
    dt: number,
    lever: number,
    inflow: number,
    immersion: number,
    rho: number,
    enabled = true,
    hubDepth = 0.5,
    gravity = 9.80665,
  ): void {
    const engine = this.definition.engine;
    const propeller = this.definition.propeller;
    const demandedGear = enabled ? OutboardPowertrain.leverGear(lever) : "neutral";
    let demandedThrottle = enabled ? this.leverThrottle(lever) : 0;
    if (demandedGear !== this.gear) {
      demandedThrottle = 0;
      if (this.rpm <= engine.shiftMaxRpm && this.throttle < 0.03) {
        this.shiftTimer += dt;
        if (this.shiftTimer >= 0.2) {
          this.gear = demandedGear;
          this.shiftTimer = 0;
        }
      } else {
        this.shiftTimer = 0;
      }
    } else {
      this.shiftTimer = 0;
    }
    const rate = demandedThrottle > this.throttle ? 2.5 : 4;
    this.throttle += Math.max(-rate * dt, Math.min(rate * dt, demandedThrottle - this.throttle));

    // Ventilation follows the immersion, quickly in and slowly out.
    const target = 1 - smoothstep(this.calibration.ventilationFull, this.calibration.ventilationOnset, immersion);
    const ventRate = target > this.ventilation ? 6 : 1.5;
    this.ventilation += (target - this.ventilation) * Math.min(1, ventRate * dt);
    const load = 1 - (1 - this.calibration.ventilatedLoad) * this.ventilation;

    const rpm = this.rpm;
    const inGear = this.gear !== "neutral";
    const sign = this.gear === "reverse" ? -1 : 1;
    const n = inGear ? (sign * this.crankSpeed) / (2 * Math.PI * propeller.gearRatio) : 0;
    this.propellerRps = n;
    let thrust = 0;
    let torque = 0;
    if (inGear && immersion > 0) {
      const absN = Math.max(Math.abs(n), 0.5);
      const d = propeller.diameter;
      const va = inflow * (1 - this.calibration.wakeFraction);
      // Advance ratio in the propeller's own sense: positive when the water
      // comes into the disc the way the blades push it.
      const j = clampJ((sign * va) / (absN * d));
      this.advanceRatio = j;
      const reverse = sign < 0 ? this.calibration.reverseEfficiency : 1;
      let kt = thrustCoefficient(this.calibration, j) * reverse * load;
      let kq = torqueCoefficient(this.calibration, j) * reverse * load;
      const n2 = n * n;
      const wet = Math.min(1, immersion / 0.5);
      // Back cavitation (Barnaby): past a mean thrust per projected blade area
      // set by the static head at the shaft, the sheet on the blade backs
      // takes most of the extra thrust and less of the torque, so the engine
      // flares in a hard hole shot instead of the boat leaping.
      const openThrust = Math.abs(kt) * rho * n2 * d * d * d * d * wet;
      const head = ATMOSPHERE + rho * gravity * Math.max(0, hubDepth) - VAPOUR_PRESSURE;
      const limit = this.calibration.cavitationLoading * this.projectedArea * head;
      this.cavitation = 0;
      if (openThrust > limit) {
        const kept = (limit + (openThrust - limit) * this.calibration.cavitationThrustSlope) / openThrust;
        this.cavitation = 1 - kept;
        kt *= kept;
        kq *= 1 - this.calibration.cavitationTorqueShare * (1 - kept);
      }
      thrust = sign * kt * rho * n2 * d * d * d * d * wet;
      torque = kq * rho * n2 * d * d * d * d * d * wet;
    } else {
      this.advanceRatio = 0;
      this.cavitation = 0;
    }
    this.thrust = thrust;
    this.propellerTorque = torque;

    // Engine.
    const loss = 6 + 0.004 * rpm;
    if (rpm > engine.limiterRpm) this.limiterCut = true;
    else if (rpm < engine.limiterRpm - 100) this.limiterCut = false;
    const throttle = this.limiterCut ? 0 : this.throttle;
    let engineTorque = throttle * (fullThrottleTorque(engine.fullThrottleTorque, rpm) + loss) - loss;
    if (!enabled) {
      // Crashed: the kill cord is out and the engine winds down.
      engineTorque = -4 * loss;
    } else if (rpm < engine.idleRpm + 200) {
      // The idle air valve holds idle against the propeller's drag at any
      // throttle: a part-open throttle lugged down by the load is a floor, not
      // a stall.
      engineTorque = Math.max(engineTorque, Math.min(80 - loss, 0.6 * (engine.idleRpm - rpm)));
    }
    this.engineTorque = engineTorque;
    const reflected = inGear ? torque / (propeller.gearRatio * propeller.gearEfficiency) : 0;
    const inertia = engine.crankInertia + (inGear ? propeller.inertia / (propeller.gearRatio * propeller.gearRatio) : 0);
    this.crankSpeed += ((engineTorque - reflected) / inertia) * dt;
    if (this.crankSpeed < 0) this.crankSpeed = 0;
  }
}

const ATMOSPHERE = 101_325;
/** Sea water at 15 C. */
const VAPOUR_PRESSURE = 1_700;

function rpmToRadians(rpm: number): number {
  return (rpm * 2 * Math.PI) / 60;
}

function clampJ(j: number): number {
  return Math.min(2, Math.max(-1.5, j));
}

/** K_T(J): the quadratic fit, extended along its J = 0 slope astern of zero. */
export function thrustCoefficient(calibration: BoatCalibration, j: number): number {
  const [a, b, c] = calibration.kt;
  if (j < 0) return a + b * j;
  return a + b * j + c * j * j;
}

/** K_Q(J), likewise (the fit is of 10 K_Q). */
export function torqueCoefficient(calibration: BoatCalibration, j: number): number {
  const [a, b, c] = calibration.kq10;
  if (j < 0) return 0.1 * (a + b * j);
  return 0.1 * (a + b * j + c * j * j);
}

export function fullThrottleTorque(table: readonly (readonly [number, number])[], rpm: number): number {
  if (rpm <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i += 1) {
    const [r1, q1] = table[i]!;
    if (rpm <= r1) {
      const [r0, q0] = table[i - 1]!;
      return q0 + ((q1 - q0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return table[table.length - 1]![1];
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Share of a disc of radius 1 below a line `h` radii above its centre (h in -1..1, positive = submerged depth). */
export function discImmersion(hubDepth: number, radius: number): number {
  const h = Math.max(-1, Math.min(1, hubDepth / radius));
  // Segment area below the surface, over pi.
  return (Math.acos(-h) + h * Math.sqrt(1 - h * h)) / Math.PI;
}
