import {
  assertAscending,
  assertFiniteNumber,
  assertPositive,
  assertRange,
  assertVec3,
  freezeTuple3,
  normalizeVec3,
  type Vec3,
} from "./validation";

export interface SunState {
  /** Unit vector from the world toward the sun. */
  readonly direction: Vec3;
  /** Direct normal illuminance before atmospheric attenuation. */
  readonly illuminanceLux: number;
  readonly angularRadiusRadians: number;
  /** Linear RGB tint, normally close to equal-energy white. */
  readonly color: Vec3;
}

export interface AtmosphereState {
  readonly planetCenterMeters: Vec3;
  readonly planetRadiusMeters: number;
  readonly atmosphereRadiusMeters: number;
  readonly rayleighScatteringPerMeter: Vec3;
  readonly mieScatteringPerMeter: Vec3;
  readonly mieExtinctionPerMeter: Vec3;
  readonly absorptionExtinctionPerMeter: Vec3;
  readonly miePhaseG: number;
  readonly groundAlbedo: Vec3;
}

export interface WindLayerState {
  readonly altitudeMeters: number;
  readonly velocityMetersPerSecond: readonly [number, number];
  readonly turbulence: number;
}

export interface WeatherState {
  readonly relativeHumidity: number;
  readonly cloudCoverage: number;
  /** 0 is flat stratus, 0.5 is cumulus, and 1 is deep convection. */
  readonly cloudType: number;
  readonly convection: number;
  readonly precipitation: number;
  readonly surfaceWetness: number;
  readonly snowCoverage: number;
}

/**
 * The single authoritative lighting/weather snapshot consumed by all natural
 * render systems. Positions are CPU world-space doubles expressed in metres.
 */
export interface EnvironmentState {
  readonly timeSeconds: number;
  readonly frameDeltaSeconds: number;
  /** CPU world point represented by GPU-local (0, 0, 0). */
  readonly floatingOriginMeters: Vec3;
  readonly sun: SunState;
  readonly atmosphere: AtmosphereState;
  readonly windLayers: readonly WindLayerState[];
  readonly weather: WeatherState;
}

export type EnvironmentStateInput = Partial<Omit<EnvironmentState, "sun" | "atmosphere" | "weather">> & {
  readonly sun?: Partial<SunState>;
  readonly atmosphere?: Partial<AtmosphereState>;
  readonly weather?: Partial<WeatherState>;
};

const EARTH_RADIUS_METERS = 6_360_000;

export const DEFAULT_ENVIRONMENT_STATE: EnvironmentState = Object.freeze({
  timeSeconds: 0,
  frameDeltaSeconds: 1 / 60,
  floatingOriginMeters: Object.freeze([0, 0, 0]) as Vec3,
  sun: Object.freeze({
    direction: freezeTuple3(normalizeVec3([0.35, 0.72, 0.6])),
    illuminanceLux: 120_000,
    angularRadiusRadians: 0.004675,
    color: Object.freeze([1, 0.985, 0.96]) as Vec3,
  }),
  atmosphere: Object.freeze({
    planetCenterMeters: Object.freeze([0, -EARTH_RADIUS_METERS, 0]) as Vec3,
    planetRadiusMeters: EARTH_RADIUS_METERS,
    atmosphereRadiusMeters: EARTH_RADIUS_METERS + 100_000,
    rayleighScatteringPerMeter: Object.freeze([
      5.802e-6,
      13.558e-6,
      33.1e-6,
    ]) as Vec3,
    mieScatteringPerMeter: Object.freeze([3.996e-6, 3.996e-6, 3.996e-6]) as Vec3,
    mieExtinctionPerMeter: Object.freeze([4.4e-6, 4.4e-6, 4.4e-6]) as Vec3,
    absorptionExtinctionPerMeter: Object.freeze([
      0.65e-6,
      1.881e-6,
      0.085e-6,
    ]) as Vec3,
    miePhaseG: 0.8,
    groundAlbedo: Object.freeze([0.18, 0.18, 0.18]) as Vec3,
  }),
  windLayers: Object.freeze([
    Object.freeze({
      altitudeMeters: 0,
      velocityMetersPerSecond: Object.freeze([5, 1]) as readonly [number, number],
      turbulence: 0.18,
    }),
    Object.freeze({
      altitudeMeters: 2_000,
      velocityMetersPerSecond: Object.freeze([9, 3]) as readonly [number, number],
      turbulence: 0.32,
    }),
    Object.freeze({
      altitudeMeters: 8_000,
      velocityMetersPerSecond: Object.freeze([22, 7]) as readonly [number, number],
      turbulence: 0.2,
    }),
  ]),
  weather: Object.freeze({
    relativeHumidity: 0.62,
    cloudCoverage: 0.42,
    cloudType: 0.52,
    convection: 0.28,
    precipitation: 0,
    surfaceWetness: 0,
    snowCoverage: 0,
  }),
});

function copyWindLayers(layers: readonly WindLayerState[]): readonly WindLayerState[] {
  return Object.freeze(layers.map((layer) => Object.freeze({
    altitudeMeters: layer.altitudeMeters,
    velocityMetersPerSecond: Object.freeze([
      layer.velocityMetersPerSecond[0],
      layer.velocityMetersPerSecond[1],
    ]) as readonly [number, number],
    turbulence: layer.turbulence,
  })));
}

/** Resolve defaults, normalize directions, copy tuples, validate, and freeze. */
export function createEnvironmentState(input: EnvironmentStateInput = {}): EnvironmentState {
  const defaultState = DEFAULT_ENVIRONMENT_STATE;
  const sunInput = input.sun ?? {};
  const atmosphereInput = input.atmosphere ?? {};
  const weatherInput = input.weather ?? {};
  const windLayers = copyWindLayers(input.windLayers ?? defaultState.windLayers);

  const state: EnvironmentState = {
    timeSeconds: input.timeSeconds ?? defaultState.timeSeconds,
    frameDeltaSeconds: input.frameDeltaSeconds ?? defaultState.frameDeltaSeconds,
    floatingOriginMeters: freezeTuple3(input.floatingOriginMeters ?? defaultState.floatingOriginMeters),
    sun: Object.freeze({
      direction: freezeTuple3(normalizeVec3(sunInput.direction ?? defaultState.sun.direction)),
      illuminanceLux: sunInput.illuminanceLux ?? defaultState.sun.illuminanceLux,
      angularRadiusRadians: sunInput.angularRadiusRadians ?? defaultState.sun.angularRadiusRadians,
      color: freezeTuple3(sunInput.color ?? defaultState.sun.color),
    }),
    atmosphere: Object.freeze({
      planetCenterMeters: freezeTuple3(
        atmosphereInput.planetCenterMeters ?? defaultState.atmosphere.planetCenterMeters,
      ),
      planetRadiusMeters:
        atmosphereInput.planetRadiusMeters ?? defaultState.atmosphere.planetRadiusMeters,
      atmosphereRadiusMeters:
        atmosphereInput.atmosphereRadiusMeters ?? defaultState.atmosphere.atmosphereRadiusMeters,
      rayleighScatteringPerMeter: freezeTuple3(
        atmosphereInput.rayleighScatteringPerMeter
          ?? defaultState.atmosphere.rayleighScatteringPerMeter,
      ),
      mieScatteringPerMeter: freezeTuple3(
        atmosphereInput.mieScatteringPerMeter ?? defaultState.atmosphere.mieScatteringPerMeter,
      ),
      mieExtinctionPerMeter: freezeTuple3(
        atmosphereInput.mieExtinctionPerMeter ?? defaultState.atmosphere.mieExtinctionPerMeter,
      ),
      absorptionExtinctionPerMeter: freezeTuple3(
        atmosphereInput.absorptionExtinctionPerMeter
          ?? defaultState.atmosphere.absorptionExtinctionPerMeter,
      ),
      miePhaseG: atmosphereInput.miePhaseG ?? defaultState.atmosphere.miePhaseG,
      groundAlbedo: freezeTuple3(
        atmosphereInput.groundAlbedo ?? defaultState.atmosphere.groundAlbedo,
      ),
    }),
    windLayers,
    weather: Object.freeze({
      relativeHumidity: weatherInput.relativeHumidity ?? defaultState.weather.relativeHumidity,
      cloudCoverage: weatherInput.cloudCoverage ?? defaultState.weather.cloudCoverage,
      cloudType: weatherInput.cloudType ?? defaultState.weather.cloudType,
      convection: weatherInput.convection ?? defaultState.weather.convection,
      precipitation: weatherInput.precipitation ?? defaultState.weather.precipitation,
      surfaceWetness: weatherInput.surfaceWetness ?? defaultState.weather.surfaceWetness,
      snowCoverage: weatherInput.snowCoverage ?? defaultState.weather.snowCoverage,
    }),
  };

  assertEnvironmentState(state);
  return Object.freeze(state);
}

export function assertEnvironmentState(state: EnvironmentState): void {
  assertFiniteNumber(state.timeSeconds, "environment.timeSeconds");
  assertRange(state.frameDeltaSeconds, 0, 1, "environment.frameDeltaSeconds");
  assertVec3(state.floatingOriginMeters, "environment.floatingOriginMeters");

  assertVec3(state.sun.direction, "environment.sun.direction");
  const sunLength = Math.hypot(...state.sun.direction);
  if (Math.abs(sunLength - 1) > 1e-4) {
    throw new RangeError("environment.sun.direction must be normalized");
  }
  assertRange(state.sun.illuminanceLux, 0, 200_000, "environment.sun.illuminanceLux");
  assertRange(
    state.sun.angularRadiusRadians,
    1e-5,
    0.05,
    "environment.sun.angularRadiusRadians",
  );
  assertVec3(state.sun.color, "environment.sun.color");
  state.sun.color.forEach((component, index) => {
    assertRange(component, 0, 16, `environment.sun.color[${index}]`);
  });

  const atmosphere = state.atmosphere;
  assertVec3(atmosphere.planetCenterMeters, "environment.atmosphere.planetCenterMeters");
  assertPositive(atmosphere.planetRadiusMeters, "environment.atmosphere.planetRadiusMeters");
  assertPositive(atmosphere.atmosphereRadiusMeters, "environment.atmosphere.atmosphereRadiusMeters");
  if (atmosphere.atmosphereRadiusMeters <= atmosphere.planetRadiusMeters) {
    throw new RangeError("environment.atmosphereRadiusMeters must exceed planetRadiusMeters");
  }
  for (const [name, value] of [
    ["rayleighScatteringPerMeter", atmosphere.rayleighScatteringPerMeter],
    ["mieScatteringPerMeter", atmosphere.mieScatteringPerMeter],
    ["mieExtinctionPerMeter", atmosphere.mieExtinctionPerMeter],
    ["absorptionExtinctionPerMeter", atmosphere.absorptionExtinctionPerMeter],
    ["groundAlbedo", atmosphere.groundAlbedo],
  ] as const) {
    assertVec3(value, `environment.atmosphere.${name}`);
    value.forEach((component, index) => {
      assertRange(component, 0, 1, `environment.atmosphere.${name}[${index}]`);
    });
  }
  assertRange(atmosphere.miePhaseG, -0.99, 0.99, "environment.atmosphere.miePhaseG");

  if (state.windLayers.length === 0 || state.windLayers.length > 4) {
    throw new RangeError("environment.windLayers must contain between one and four layers");
  }
  assertAscending(state.windLayers.map((layer) => layer.altitudeMeters), "environment.windLayers altitudes");
  state.windLayers.forEach((layer, index) => {
    assertFiniteNumber(layer.altitudeMeters, `environment.windLayers[${index}].altitudeMeters`);
    assertFiniteNumber(
      layer.velocityMetersPerSecond[0],
      `environment.windLayers[${index}].velocityMetersPerSecond[0]`,
    );
    assertFiniteNumber(
      layer.velocityMetersPerSecond[1],
      `environment.windLayers[${index}].velocityMetersPerSecond[1]`,
    );
    assertRange(layer.turbulence, 0, 1, `environment.windLayers[${index}].turbulence`);
  });

  for (const [name, value] of Object.entries(state.weather)) {
    assertRange(value, 0, 1, `environment.weather.${name}`);
  }
}

/** Linearly interpolate the shared wind profile at an altitude above mean sea level. */
export function sampleEnvironmentWind(
  state: EnvironmentState,
  altitudeMeters: number,
): { velocityMetersPerSecond: readonly [number, number]; turbulence: number } {
  assertFiniteNumber(altitudeMeters, "altitudeMeters");
  const layers = state.windLayers;
  const first = layers[0];
  const last = layers[layers.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError("environment.windLayers cannot be empty");
  }
  if (altitudeMeters <= first.altitudeMeters) {
    return {
      velocityMetersPerSecond: first.velocityMetersPerSecond,
      turbulence: first.turbulence,
    };
  }
  if (altitudeMeters >= last.altitudeMeters) {
    return {
      velocityMetersPerSecond: last.velocityMetersPerSecond,
      turbulence: last.turbulence,
    };
  }
  for (let index = 1; index < layers.length; index += 1) {
    const upper = layers[index];
    const lower = layers[index - 1];
    if (upper !== undefined && lower !== undefined && altitudeMeters <= upper.altitudeMeters) {
      const blend = (altitudeMeters - lower.altitudeMeters)
        / (upper.altitudeMeters - lower.altitudeMeters);
      return {
        velocityMetersPerSecond: [
          lower.velocityMetersPerSecond[0]
            + (upper.velocityMetersPerSecond[0] - lower.velocityMetersPerSecond[0]) * blend,
          lower.velocityMetersPerSecond[1]
            + (upper.velocityMetersPerSecond[1] - lower.velocityMetersPerSecond[1]) * blend,
        ],
        turbulence: lower.turbulence + (upper.turbulence - lower.turbulence) * blend,
      };
    }
  }
  return { velocityMetersPerSecond: last.velocityMetersPerSecond, turbulence: last.turbulence };
}

/**
 * Stable 256-byte uniform block. Every logical row is a vec4, avoiding host/WGSL
 * alignment ambiguity. Planet centre is converted to camera-relative GPU space.
 */
export function packEnvironmentUniforms(state: EnvironmentState): Float32Array {
  assertEnvironmentState(state);
  const values = new Float32Array(64);
  const setRow = (row: number, x: number, y: number, z: number, w: number): void => {
    values.set([x, y, z, w], row * 4);
  };
  setRow(0, state.timeSeconds, state.frameDeltaSeconds, state.weather.relativeHumidity, state.weather.surfaceWetness);
  setRow(1, state.floatingOriginMeters[0], state.floatingOriginMeters[1], state.floatingOriginMeters[2], 0);
  setRow(2, state.sun.direction[0], state.sun.direction[1], state.sun.direction[2], state.sun.angularRadiusRadians);
  setRow(3, state.sun.color[0], state.sun.color[1], state.sun.color[2], state.sun.illuminanceLux);
  setRow(
    4,
    state.atmosphere.planetCenterMeters[0] - state.floatingOriginMeters[0],
    state.atmosphere.planetCenterMeters[1] - state.floatingOriginMeters[1],
    state.atmosphere.planetCenterMeters[2] - state.floatingOriginMeters[2],
    state.atmosphere.planetRadiusMeters,
  );
  setRow(
    5,
    state.atmosphere.rayleighScatteringPerMeter[0],
    state.atmosphere.rayleighScatteringPerMeter[1],
    state.atmosphere.rayleighScatteringPerMeter[2],
    state.atmosphere.atmosphereRadiusMeters,
  );
  setRow(
    6,
    state.atmosphere.mieScatteringPerMeter[0],
    state.atmosphere.mieScatteringPerMeter[1],
    state.atmosphere.mieScatteringPerMeter[2],
    state.atmosphere.miePhaseG,
  );
  setRow(
    7,
    state.atmosphere.mieExtinctionPerMeter[0],
    state.atmosphere.mieExtinctionPerMeter[1],
    state.atmosphere.mieExtinctionPerMeter[2],
    0,
  );
  setRow(
    8,
    state.atmosphere.absorptionExtinctionPerMeter[0],
    state.atmosphere.absorptionExtinctionPerMeter[1],
    state.atmosphere.absorptionExtinctionPerMeter[2],
    0,
  );
  setRow(
    9,
    state.weather.cloudCoverage,
    state.weather.cloudType,
    state.weather.convection,
    state.weather.precipitation,
  );
  setRow(
    10,
    state.atmosphere.groundAlbedo[0],
    state.atmosphere.groundAlbedo[1],
    state.atmosphere.groundAlbedo[2],
    state.weather.snowCoverage,
  );
  state.windLayers.forEach((layer, index) => {
    setRow(
      11 + index,
      layer.velocityMetersPerSecond[0],
      layer.velocityMetersPerSecond[1],
      layer.altitudeMeters,
      layer.turbulence,
    );
  });
  setRow(15, state.windLayers.length, 0, 0, 0);
  return values;
}
