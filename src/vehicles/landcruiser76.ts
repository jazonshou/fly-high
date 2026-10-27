/**
 * The LandCruiser 76 GXL wagon's physical numbers: the one record the car's
 * physics (src/sim/ground/) and the drawn car (src/render/webgpu/ground/)
 * both read, so the wheels that carry the car are the wheels on screen.
 *
 * The car is the 2024 76 wagon: the five-door 70 Series on its ladder frame,
 * a rigid front axle on coils and a Panhard rod, a rigid rear axle on leaf
 * springs, part-time 4WD through a two-speed transfer case, lockable front
 * and rear differentials, the 2.8 litre 1GD-FTV four-cylinder turbo-diesel,
 * and either the six-speed automatic or the five-speed manual Toyota added in
 * 2025 (land plan, decision 1). Every number says where it came from:
 *
 * - PUBLISHED: Toyota's figures as reported by CarExpert and 4X4 Australia
 *   (the plan's sources): power, torque, ratios, dimensions, weights, angles,
 *   turning circle, tyres, layout.
 * - DERIVED: worked from published numbers (the low range from both crawl
 *   ratios, the loaded radius, the Ackermann locks).
 * - ESTIMATE: not published; chosen from the class and marked, for the spec
 *   audit in the land PR's last phase. The tests pin what each must produce
 *   (a tilt table at about 40 degrees, 1.3/1.5 Hz ride, the 33/23 degree
 *   angles out of the hull's geometry).
 *
 * BODY FRAME: the origin is the centre of gravity at kerb weight, +X forward,
 * +Y up, +Z right (the driver's side: the 76 is right-hand drive). At kerb
 * ride on flat ground the CG is `mass.cgHeight` above the ground, so the
 * ground is at y = -0.80. Axle and wheel positions are given at that ride
 * height, where `CarVisualState.axleHeave` is zero.
 */

const DEG = Math.PI / 180;

/** A probe sphere of the body's collision hull: body-frame centre and radius, metres. */
export interface HullProbe {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

/**
 * One convex part of the body's collision hull, sampled by probe spheres on
 * the faces that can meet the ground or a wall. `axle` parts ride on that
 * axle (heave and roll): their probes are relative to the axle's centre, the
 * wheel centres' midpoint.
 */
export interface HullPart {
  readonly name: string;
  readonly axle?: "front" | "rear";
  /**
   * The upper body (cab sides, roof, bonnet and tail): a contact here with
   * the ground means the car is on its side or roof.
   */
  readonly upperBody: boolean;
  readonly probes: readonly HullProbe[];
}

/**
 * TMeasy's three points of one direction's force characteristic at one
 * wheel load (Rill, Road Vehicle Dynamics, 2011, ch. 3): initial slope, the
 * peak and its slip, the sliding level and the slip it is reached at.
 */
export interface TmeasyCurve {
  /** dF0, newtons per unit slip. */
  readonly initialSlope: number;
  readonly peakSlip: number;
  readonly peakForce: number;
  readonly slidingSlip: number;
  readonly slidingForce: number;
}

export interface TmeasyDirection {
  /** At the nominal load and at twice it (TMeasy interpolates between, and through zero). */
  readonly nominal: TmeasyCurve;
  readonly double: TmeasyCurve;
}

export interface AxleSuspension {
  /** Lateral spacing of the springs (coils front, leaves rear), metres. */
  readonly springTrack: number;
  /** Spring rate per side, N/m, at the wheel: 1.3 Hz front, 1.5 Hz rear with the tyre in series. */
  readonly springRate: number;
  /** Damper rates per side at the wheel, N s/m, below the knee velocity; digressive above it. */
  readonly bumpDamping: number;
  readonly reboundDamping: number;
  readonly damperKneeVelocity: number;
  /** Damper rate above the knee as a share of the rate below it. */
  readonly damperDigressiveShare: number;
  /** Anti-roll bar, N m per radian of axle roll against the frame. */
  readonly antiRollBar: number;
  /** Wheel travel from kerb ride: into bump, and down to the shock's full extension. */
  readonly bumpTravel: number;
  readonly droopTravel: number;
  /** Free gap before the rubber bump stop takes over, metres of bump. */
  readonly bumpStopGap: number;
  /** Roll centre above the ground at kerb ride (Panhard rod front, leaf seats rear), metres. */
  readonly rollCentreHeight: number;
  /**
   * The link geometry's anti-dive (front) and anti-squat/lift (rear): the
   * tangent of the line from the contact patch to the links' instant centre,
   * so a tyre's longitudinal force F lifts the frame by F times this.
   */
  readonly antiPitch: number;
  /** Mass and roll inertia of the axle with its wheels, brakes and differential. */
  readonly unsprungMass: number;
  readonly rollInertia: number;
}

/** Engine full-load torque against crank rpm, boost built (strictly increasing rpm). */
export type TorqueCurve = readonly (readonly [rpm: number, torque: number])[];

export const LANDCRUISER_76 = Object.freeze({
  name: "LandCruiser 76 GXL",

  mass: Object.freeze({
    /** Published kerb (tare 2,198 kg; GVM 3,510 kg). */
    kerb: 2_300,
    gvm: 3_510,
    /** ESTIMATE: share of kerb weight on the front axle. */
    frontAxleShare: 0.52,
    /** ESTIMATE: tuned so the tilt table tips at about 40 degrees. */
    cgHeight: 0.8,
    /**
     * ESTIMATE: sprung inertia about the sprung CG, kg m^2 (x roll, y yaw,
     * z pitch): radii of gyration 0.60, 1.35 and 1.31 m for a 4.9 m wagon.
     */
    sprungInertia: Object.freeze({ xx: 700, yy: 3_500, zz: 3_300 }),
  }),

  body: Object.freeze({
    /** Published. */
    length: 4.91,
    width: 1.87,
    height: 1.94,
    groundClearance: 0.29,
    approachAngle: 33 * DEG,
    departureAngle: 23 * DEG,
    /** ESTIMATE: front bumper face ahead of the front axle; the rest of the length is behind. */
    frontOverhang: 0.88,
  }),

  geometry: Object.freeze({
    /** Published wheelbase and tracks. */
    wheelbase: 2.73,
    frontTrack: 1.555,
    rearTrack: 1.46,
    /** DERIVED from the 52% front share: the CG is 48% of the wheelbase behind the front axle. */
    frontAxleX: 0.48 * 2.73,
    rearAxleX: 0.48 * 2.73 - 2.73,
    /** Wheel centres at kerb ride: the loaded radius above the ground. */
    wheelCentreY: 0.37 - 0.8,
  }),

  tyre: Object.freeze({
    /** Published size: 265/70R16 (777 mm), on 16 in steel wheels. */
    size: "265/70R16",
    freeRadius: 0.3885,
    /** DERIVED: static loaded radius at the road pressure. */
    loadedRadius: 0.37,
    width: 0.265,
    /** Tread width that carries load, metres (the Bekker plate width b). */
    treadWidth: 0.235,
    /** Placard pressures, bar: the pause menu's road and sand presets. */
    roadPressureBar: 2.4,
    sandPressureBar: 1.2,
    /** ESTIMATE: radial stiffness at road pressure, N/m, and its zero-pressure offset (k grows with p + p0). */
    radialStiffness: 280_000,
    radialStiffnessPressureOffsetBar: 0.45,
    radialDamping: 600,
    /** ESTIMATE: the carcass's own share of ground pressure, bar (Wong's p_c). */
    carcassPressureBar: 0.25,
    /** ESTIMATE: compressor time per bar while stopped (deflating is quicker). */
    inflateSecondsPerBar: 40,
    deflateSecondsPerBar: 25,
    /** ESTIMATE: tyre, steel wheel, hub and rotor, kg m^2. */
    spinInertia: 2.6,
    /**
     * ESTIMATE: TMeasy for an LT all-terrain on asphalt, scaled from Rill's
     * passenger tyre (Road Vehicle Dynamics, table 3.4) to a 5.5 kN nominal
     * load: peak friction about 1.0 longitudinally and 0.98 laterally,
     * dropping with load, with the relaxation lengths dF0/c near 0.5 m.
     */
    nominalLoad: 5_500,
    longitudinal: Object.freeze({
      nominal: Object.freeze({ initialSlope: 160_000, peakSlip: 0.12, peakForce: 5_600, slidingSlip: 0.6, slidingForce: 5_000 }),
      double: Object.freeze({ initialSlope: 260_000, peakSlip: 0.11, peakForce: 10_600, slidingSlip: 0.8, slidingForce: 9_400 }),
    }) satisfies TmeasyDirection,
    lateral: Object.freeze({
      nominal: Object.freeze({ initialSlope: 75_000, peakSlip: 0.22, peakForce: 5_400, slidingSlip: 0.9, slidingForce: 5_000 }),
      double: Object.freeze({ initialSlope: 110_000, peakSlip: 0.24, peakForce: 10_000, slidingSlip: 1.0, slidingForce: 9_200 }),
    }) satisfies TmeasyDirection,
    /** ESTIMATE: carcass stiffness and damping in the contact plane (TMeasy's first-order dynamics), N/m and N s/m. */
    longitudinalStiffness: 300_000,
    longitudinalDamping: 1_000,
    lateralStiffness: 150_000,
    lateralDamping: 700,
    /** Rolling resistance on a sealed surface, of the load. */
    rollingResistance: 0.012,
  }),

  suspension: Object.freeze({
    /**
     * ESTIMATE (front coils, Panhard rod): 1.3 Hz ride on a 503 kg sprung
     * corner with the 280 kN/m tyre in series, 0.3 of critical damping, 0.12 m
     * bump and 0.14 m droop.
     */
    front: Object.freeze({
      springTrack: 1.0,
      springRate: 38_200,
      bumpDamping: 1_700,
      reboundDamping: 3_800,
      damperKneeVelocity: 0.35,
      damperDigressiveShare: 0.45,
      antiRollBar: 16_000,
      bumpTravel: 0.12,
      droopTravel: 0.14,
      bumpStopGap: 0.075,
      rollCentreHeight: 0.5,
      antiPitch: 0.12,
      unsprungMass: 190,
      rollInertia: 64,
    }) satisfies AxleSuspension,
    /** ESTIMATE (rear leaves): 1.5 Hz ride on a 462 kg sprung corner. */
    rear: Object.freeze({
      springTrack: 1.05,
      springRate: 48_000,
      bumpDamping: 1_800,
      reboundDamping: 4_000,
      damperKneeVelocity: 0.35,
      damperDigressiveShare: 0.45,
      antiRollBar: 10_000,
      bumpTravel: 0.12,
      droopTravel: 0.14,
      bumpStopGap: 0.075,
      rollCentreHeight: 0.6,
      antiPitch: 0.09,
      unsprungMass: 180,
      rollInertia: 55,
    }) satisfies AxleSuspension,
  }),

  steering: Object.freeze({
    /** DERIVED from the published 12.6 m kerb-to-kerb circle with true Ackermann. */
    innerLock: 34 * DEG,
    outerLock: 26 * DEG,
    /** Kingpin spacing for the Ackermann law: cot(outer) - cot(inner) = this / wheelbase. */
    kingpinTrack: 1.55,
    turningCircle: 12.6,
    /** ESTIMATE: steering wheel turns lock to lock. */
    turnsLockToLock: 3.6,
    /**
     * Speed-limited lock: the kinematic lateral acceleration a full key can
     * ask for, m/s^2, so a held key cannot roll the car at 100 km/h (the
     * static rollover threshold is about 0.84 g).
     */
    maxKinematicLateralAcceleration: 0.55 * 9.80665,
    /** Road-wheel slew, radians a second, at a standstill and its fall with speed (halves at this m/s). */
    slewRate: 1.6,
    slewHalfSpeed: 15,
  }),

  engine: Object.freeze({
    /** Published: 1GD-FTV 2.8 L four-cylinder turbo-diesel, 150 kW at 3,000-3,400 rpm. */
    name: "1GD-FTV",
    cylinders: 4,
    ratedPowerKw: 150,
    idleRpm: 750,
    /** ESTIMATE: the fuel cut begins here and is complete by `limiterRpm + 150`. */
    limiterRpm: 3_950,
    /** Below this the engine cannot keep turning: it stalls. */
    stallRpm: 380,
    /**
     * Full-load torque with the turbo spooled. Published plateaus: 500 N m
     * from 1,600 to 2,800 rpm with the automatic, 450 N m from 2,400 to
     * 3,000 with the manual, and 150 kW (421 N m) at 3,400. The shoulders
     * below the plateau and past 3,400 are ESTIMATES.
     */
    automaticTorque: Object.freeze([
      [0, 0], [600, 180], [750, 235], [1_000, 330], [1_200, 405], [1_400, 465], [1_600, 500],
      [2_800, 500], [3_000, 477.5], [3_400, 421.3], [3_600, 385], [3_800, 330], [4_000, 260], [4_300, 0],
    ] as const) satisfies TorqueCurve,
    manualTorque: Object.freeze([
      [0, 0], [600, 175], [750, 225], [1_000, 300], [1_200, 340], [1_400, 370], [1_600, 395], [2_000, 430],
      [2_400, 450], [3_000, 450], [3_400, 421.3], [3_600, 385], [3_800, 330], [4_000, 260], [4_300, 0],
    ] as const) satisfies TorqueCurve,
    /** ESTIMATE: crank, flywheel (or flexplate and converter pump), kg m^2. */
    inertia: 0.3,
    /** ESTIMATE: motoring friction, N m, as a + b rpm (about 55 N m of engine braking at 3,000 rpm). */
    frictionTorque: 18,
    frictionTorquePerRpm: 0.012,
    /** Turbo: the share of full-load torque available with no boost built, and the spool time constants. */
    naturallyAspiratedShare: 0.5,
    spoolSecondsAt1200: 0.9,
    spoolSecondsAt3000: 0.25,
    /** Boost builds only above this rpm, fully by `boostFullRpm`. */
    boostOnsetRpm: 1_000,
    boostFullRpm: 1_900,
    /** Starter: seconds to crank a stalled engine back to idle. */
    crankSeconds: 0.8,
  }),

  automatic: Object.freeze({
    /** AC60 family, PROVISIONAL (matches the published 38.51 crawl ratio); confirm in the spec audit. */
    ratios: Object.freeze([3.6, 2.09, 1.488, 1.0, 0.687, 0.58] as const),
    reverse: 3.732,
    /** Published. */
    finalDrive: 4.3,
    /**
     * ESTIMATE: torque converter. Pump torque (w / K)^2 with K from a
     * 2,300 rpm stall at 500 N m, torque ratio 2.0 at stall falling to 1 at
     * the 0.85 coupling point, capacity falling to nothing at a speed ratio
     * of 1.
     */
    converterK: 10.77,
    converterStallRatio: 2.0,
    converterCouplingPoint: 0.85,
    /** Lockup clutch: from this gear, above this turbine rpm, at this capacity (N m), engaging over this time. */
    lockupFromGear: 3,
    lockupRpm: 1_350,
    lockupReleaseRpm: 1_100,
    lockupCapacity: 900,
    lockupSeconds: 0.3,
    /** Turbine and input shaft inertia, kg m^2. */
    inputInertia: 0.06,
    /** Clutch-to-clutch shift time and the share of turbine torque passed during it. */
    shiftSeconds: 0.35,
    shiftTorqueShare: 0.4,
    /** Shift schedule on turbine rpm: up above `upBase + upThrottle * throttle`, down below `downBase + downThrottle * throttle`. */
    upshiftRpm: 1_550,
    upshiftRpmPerThrottle: 1_600,
    downshiftRpm: 1_050,
    downshiftRpmPerThrottle: 650,
    /** Kickdown above this throttle while the lower gear stays under this turbine rpm. */
    kickdownThrottle: 0.92,
    kickdownMaxRpm: 3_100,
    /** The parking pawl's hold at the rear propeller shaft, N m. */
    parkTorque: 20_000,
  }),

  manual: Object.freeze({
    /** Published (2025 5-speed): ratios and final drive; reverse PROVISIONAL. */
    ratios: Object.freeze([4.773, 2.597, 1.57, 1.0, 0.775] as const),
    reverse: 4.3,
    finalDrive: 4.1,
    /** ESTIMATE: dry clutch capacity fully engaged, N m (1.45 x 450). */
    clutchCapacity: 650,
    /** Clutch disc and input shaft, kg m^2. */
    inputInertia: 0.02,
    /** The auto-clutch: release, gear change and take-up times, s. */
    autoClutchReleaseSeconds: 0.12,
    autoClutchEngageSeconds: 0.3,
    /** The auto-clutch's launch target, rpm, idle to full throttle. */
    launchRpm: 1_050,
    launchRpmPerThrottle: 700,
  }),

  transfer: Object.freeze({
    high: 1.0,
    /** DERIVED: 38.51 / (3.600 x 4.3) and 48.69 / (4.773 x 4.1) both give 2.488. */
    low: 2.488,
    /** Range changes into or out of 4L only below this speed, m/s. */
    lowRangeMaxSpeed: 0.6,
    /** 2H to 4H on the move only below this speed, m/s. */
    highRangeShiftMaxSpeed: 27.8,
  }),

  driveline: Object.freeze({
    /** ESTIMATE: torsional stiffness and damping between the front and rear propeller shafts (windup), N m/rad and N m s/rad. */
    windupStiffness: 9_000,
    windupDamping: 25,
    /** Propeller shafts, transfer output and differential carriers at the propeller shaft, kg m^2. */
    rearPropInertia: 0.03,
    frontPropInertia: 0.025,
    /** ESTIMATE: losses at each propeller shaft: viscous N m s/rad and Coulomb N m (about 12% at full power). */
    propViscousLoss: 0.06,
    propCoulombLoss: 3,
  }),

  brakes: Object.freeze({
    /** ESTIMATE: torque per wheel at a full pedal, N m: front discs, rear drums. */
    frontTorque: 4_200,
    rearTorque: 1_700,
    /** ESTIMATE: the transmission drum on the rear propeller shaft (the 70 Series' handbrake), N m. */
    handbrakeTorque: 1_100,
  }),

  aero: Object.freeze({
    /** ESTIMATE: drag area C_D A (1.94 m tall, flat-fronted wagon), side and lift areas, m^2. */
    dragArea: 1.7,
    sideArea: 7.4,
    liftArea: 0.4,
    /** Centre of pressure in the body frame. */
    pressureX: 0.15,
    pressureY: 0.2,
  }),

  water: Object.freeze({
    /** ESTIMATE: the 300 Series' 700 mm rating; the intake sits this high above the ground at the engine bay. */
    wadingDepth: 0.7,
    intakeX: 1.55,
    /** ESTIMATE: sealed volume of the body that the cabin floods over `floodSeconds`, m^3, and the hull bottom above the ground. */
    cabinVolume: 5.2,
    floodSeconds: 60,
    bodyBottomHeight: 0.55,
    /** Volume of each tyre and wheel, m^3 (a 777 x 265 mm cylinder). */
    wheelVolume: Math.PI * 0.3885 * 0.3885 * 0.265,
    /** Frame, axles, engine and gearbox, m^3, spread below the body. */
    chassisVolume: 0.35,
    /** Submerged frontal and side drag coefficients. */
    frontDragCoefficient: 1.05,
    sideDragCoefficient: 1.2,
  }),

  fuelLitres: 130,

  /**
   * The body's collision hull. Ground is y = -0.80 at kerb ride. The front
   * bumper's lower front probes (0.85 m ahead of the front axle) touch the
   * 33 degree plane tangent to the front tyre, and the tow bar's rear probe
   * (1.24 m behind the rear axle) the 23 degree plane tangent to the rear
   * tyre: a probe of radius r at distance d from the axle sits at
   * R - (R - d sin a - r) / cos a above the ground. Every other probe stands
   * above both planes. The differential housings are the lowest point, 0.29 m
   * up.
   */
  hull: Object.freeze([
    {
      name: "frontBumper",
      upperBody: false,
      probes: [
        { x: 2.16, y: -0.284, z: -0.84, radius: 0.03 },
        { x: 2.16, y: -0.284, z: 0, radius: 0.03 },
        { x: 2.16, y: -0.284, z: 0.84, radius: 0.03 },
        { x: 1.98, y: -0.284, z: -0.84, radius: 0.03 },
        { x: 1.98, y: -0.284, z: 0.84, radius: 0.03 },
        { x: 2.16, y: 0.0, z: -0.84, radius: 0.03 },
        { x: 2.16, y: 0.0, z: 0.84, radius: 0.03 },
      ],
    },
    {
      name: "rearBumper",
      upperBody: false,
      probes: [
        { x: -2.62, y: -0.21, z: -0.84, radius: 0.03 },
        { x: -2.62, y: -0.21, z: 0.84, radius: 0.03 },
        { x: -2.62, y: 0.0, z: -0.84, radius: 0.03 },
        { x: -2.62, y: 0.0, z: 0.84, radius: 0.03 },
      ],
    },
    {
      name: "towBar",
      upperBody: false,
      probes: [
        { x: -2.66, y: -0.262, z: 0, radius: 0.04 },
        { x: -2.5, y: -0.262, z: 0, radius: 0.04 },
      ],
    },
    {
      name: "sills",
      upperBody: false,
      probes: [
        { x: 0.8, y: -0.25, z: -0.86, radius: 0.05 },
        { x: -0.05, y: -0.25, z: -0.86, radius: 0.05 },
        { x: -0.9, y: -0.25, z: -0.86, radius: 0.05 },
        { x: 0.8, y: -0.25, z: 0.86, radius: 0.05 },
        { x: -0.05, y: -0.25, z: 0.86, radius: 0.05 },
        { x: -0.9, y: -0.25, z: 0.86, radius: 0.05 },
      ],
    },
    {
      name: "chassisRails",
      upperBody: false,
      probes: [
        { x: 1.95, y: -0.28, z: -0.43, radius: 0.06 },
        { x: -2.45, y: -0.28, z: -0.43, radius: 0.06 },
        { x: 1.95, y: -0.28, z: 0.43, radius: 0.06 },
        { x: -2.45, y: -0.28, z: 0.43, radius: 0.06 },
      ],
    },
    {
      name: "fuelTank",
      upperBody: false,
      probes: [
        { x: -2.22, y: -0.31, z: -0.3, radius: 0.04 },
        { x: -2.22, y: -0.31, z: 0.3, radius: 0.04 },
        { x: -1.8, y: -0.31, z: -0.3, radius: 0.04 },
        { x: -1.8, y: -0.31, z: 0.3, radius: 0.04 },
      ],
    },
    {
      name: "transferCase",
      upperBody: false,
      probes: [
        { x: 0.25, y: -0.34, z: 0, radius: 0.06 },
        { x: -0.3, y: -0.34, z: 0, radius: 0.06 },
      ],
    },
    {
      name: "frontAxle",
      axle: "front",
      upperBody: false,
      probes: [
        // The differential housing (0.30 m up), then the axle tubes.
        { x: 0, y: 0.05, z: 0, radius: 0.12 },
        { x: 0, y: 0, z: -0.45, radius: 0.05 },
        { x: 0, y: 0, z: 0.45, radius: 0.05 },
      ],
    },
    {
      name: "rearAxle",
      axle: "rear",
      upperBody: false,
      probes: [
        // The differential housing, the lowest point: 0.29 m up.
        { x: 0, y: 0.04, z: 0, radius: 0.12 },
        { x: 0, y: 0, z: -0.42, radius: 0.05 },
        { x: 0, y: 0, z: 0.42, radius: 0.05 },
      ],
    },
    {
      name: "upperBody",
      upperBody: true,
      probes: [
        // Roof corners, bonnet front, tail and the waist line of each side.
        { x: 0.75, y: 1.1, z: -0.82, radius: 0.04 },
        { x: 0.75, y: 1.1, z: 0.82, radius: 0.04 },
        { x: -2.6, y: 1.1, z: -0.82, radius: 0.04 },
        { x: -2.6, y: 1.1, z: 0.82, radius: 0.04 },
        { x: 2.1, y: 0.33, z: -0.85, radius: 0.04 },
        { x: 2.1, y: 0.33, z: 0.85, radius: 0.04 },
        { x: -2.66, y: 0.9, z: -0.84, radius: 0.04 },
        { x: -2.66, y: 0.9, z: 0.84, radius: 0.04 },
        { x: 1.35, y: 0.35, z: -0.92, radius: 0.04 },
        { x: 1.35, y: 0.35, z: 0.92, radius: 0.04 },
        { x: -0.8, y: 0.45, z: -0.92, radius: 0.04 },
        { x: -0.8, y: 0.45, z: 0.92, radius: 0.04 },
        { x: -2.1, y: 0.45, z: -0.92, radius: 0.04 },
        { x: -2.1, y: 0.45, z: 0.92, radius: 0.04 },
      ],
    },
  ] as const satisfies readonly HullPart[]),
});

export type LandCruiser76 = typeof LANDCRUISER_76;

/**
 * The drawn car's numbers in one place (what L2's visual reads): body-frame
 * axle positions, tracks, radii, the CG height at kerb ride, the travel each
 * way from `axleHeave` = 0, and the steering wheel's turns lock to lock.
 */
export const LC76_GEOMETRY = Object.freeze({
  wheelbase: LANDCRUISER_76.geometry.wheelbase,
  frontAxleX: LANDCRUISER_76.geometry.frontAxleX,
  rearAxleX: LANDCRUISER_76.geometry.rearAxleX,
  frontTrack: LANDCRUISER_76.geometry.frontTrack,
  rearTrack: LANDCRUISER_76.geometry.rearTrack,
  wheelCentreY: LANDCRUISER_76.geometry.wheelCentreY,
  loadedTyreRadius: LANDCRUISER_76.tyre.loadedRadius,
  freeTyreRadius: LANDCRUISER_76.tyre.freeRadius,
  tyreWidth: LANDCRUISER_76.tyre.width,
  cgHeight: LANDCRUISER_76.mass.cgHeight,
  bumpTravel: LANDCRUISER_76.suspension.front.bumpTravel,
  droopTravel: LANDCRUISER_76.suspension.front.droopTravel,
  innerLock: LANDCRUISER_76.steering.innerLock,
  outerLock: LANDCRUISER_76.steering.outerLock,
  steeringTurnsLockToLock: LANDCRUISER_76.steering.turnsLockToLock,
});
