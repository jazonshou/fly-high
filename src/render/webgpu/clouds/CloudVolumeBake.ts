import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RawTexture3D } from "@babylonjs/core/Materials/Textures/rawTexture3D";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Scene } from "@babylonjs/core/scene";

/**
 * 2-1 — the cloud noise and weather bake (owner: clouds).
 *
 * INVARIANT THIS FILE OWNS: the cloud density textures are baked ONCE at
 * startup on the GPU, and every noise primitive wraps on the volume's own
 * cell grid — cell indices are wrapped modulo the octave frequency, so the
 * volumes tile bit-exactly (`u` and `u + 1` sample identical lattices).
 * A volume that does not tile produces a visible seam every repeat of world
 * space, which is worse than the analytic field it replaced.
 *
 * This replaces `2-0`'s CPU stand-in fills; the density function in
 * `nature/CloudShaders.ts` reads the channels identically (R = connected
 * perlin-worley shape, GBA = three inverted-worley octaves for the base;
 * RGB = three erosion octaves for the detail volume).
 *
 * Deviation (decision log): the plan's separate curl volume is not baked —
 * no shader consumes curl today, and baking an unread texture is the
 * dead-code habit this programme corrects. It arrives with its consumer.
 */

export const CLOUD_BASE_VOLUME_SIZE = 128;
export const CLOUD_DETAIL_VOLUME_SIZE = 32;
export const CLOUD_WEATHER_MAP_SIZE = 512;

/**
 * Period-wrapped noise primitives shared by the bake kernels and the GPU
 * tileability test (assertion 37). Every lattice index passes through
 * `wrapCell` before hashing, which is the entire tiling guarantee.
 */
export const CLOUD_NOISE_WGSL = /* wgsl */ `
fn cloudBakeHash3(cell: vec3<i32>, seed: u32) -> u32 {
  var h = u32(cell.x) * 374761393u + u32(cell.y) * 668265263u
    + u32(cell.z) * 2147483647u + seed * 974711u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}

fn cloudBakeUnitFloat(h: u32) -> f32 {
  return f32(h & 0x00ffffffu) / 16777216.0;
}

fn wrapCell(cell: vec3<i32>, period: i32) -> vec3<i32> {
  return vec3<i32>(
    ((cell.x % period) + period) % period,
    ((cell.y % period) + period) % period,
    ((cell.z % period) + period) % period,
  );
}

/** Gradient vector on the wrapped lattice. */
fn periodicGradient(cell: vec3<i32>, period: i32, seed: u32) -> vec3<f32> {
  let wrapped = wrapCell(cell, period);
  let h = cloudBakeHash3(wrapped, seed);
  let gx = cloudBakeUnitFloat(h) * 2.0 - 1.0;
  let gy = cloudBakeUnitFloat(h * 1664525u + 1013904223u) * 2.0 - 1.0;
  let gz = cloudBakeUnitFloat(h * 22695477u + 1u) * 2.0 - 1.0;
  return normalize(vec3<f32>(gx, gy, gz) + vec3<f32>(1e-5, 0.0, 0.0));
}

/** Periodic Perlin noise; p is in CELL space with the given integer period. */
fn periodicPerlin(p: vec3<f32>, period: i32, seed: u32) -> f32 {
  let cell = vec3<i32>(floor(p));
  let fraction = p - floor(p);
  let fade = fraction * fraction * fraction
    * (fraction * (fraction * 6.0 - 15.0) + 10.0);
  var value = 0.0;
  for (var dz = 0; dz <= 1; dz += 1) {
    for (var dy = 0; dy <= 1; dy += 1) {
      for (var dx = 0; dx <= 1; dx += 1) {
        let corner = cell + vec3<i32>(dx, dy, dz);
        let gradient = periodicGradient(corner, period, seed);
        let offset = fraction - vec3<f32>(f32(dx), f32(dy), f32(dz));
        let weight = select(1.0 - fade.x, fade.x, dx == 1)
          * select(1.0 - fade.y, fade.y, dy == 1)
          * select(1.0 - fade.z, fade.z, dz == 1);
        value += weight * dot(gradient, offset);
      }
    }
  }
  // Perlin dot-products span ~±0.7; normalize to 0..1.
  return clamp(value * 0.72 + 0.5, 0.0, 1.0);
}

/** Periodic inverted Worley: 1 at feature points, 0 far from them. */
fn periodicWorley(p: vec3<f32>, period: i32, seed: u32) -> f32 {
  let cell = vec3<i32>(floor(p));
  let fraction = p - floor(p);
  var minimumDistance = 1e9;
  for (var dz = -1; dz <= 1; dz += 1) {
    for (var dy = -1; dy <= 1; dy += 1) {
      for (var dx = -1; dx <= 1; dx += 1) {
        let neighbor = cell + vec3<i32>(dx, dy, dz);
        let h = cloudBakeHash3(wrapCell(neighbor, period), seed);
        let feature = vec3<f32>(
          cloudBakeUnitFloat(h),
          cloudBakeUnitFloat(h * 747796405u + 2891336453u),
          cloudBakeUnitFloat(h * 277803737u + 120898675u),
        );
        let delta = vec3<f32>(f32(dx), f32(dy), f32(dz)) + feature - fraction;
        minimumDistance = min(minimumDistance, dot(delta, delta));
      }
    }
  }
  return clamp(1.0 - sqrt(minimumDistance), 0.0, 1.0);
}

/** Three-octave periodic perlin FBM (period doubles per octave). */
fn periodicPerlinFbm(uvw: vec3<f32>, baseFrequency: i32, seed: u32) -> f32 {
  var amplitude = 0.5333;
  var total = 0.0;
  var frequency = baseFrequency;
  for (var octave = 0u; octave < 3u; octave += 1u) {
    total += amplitude * periodicPerlin(uvw * f32(frequency), frequency, seed + octave * 101u);
    amplitude *= 0.5;
    frequency *= 2;
  }
  return clamp(total, 0.0, 1.0);
}
`;

const BASE_BAKE_WGSL = /* wgsl */ `
${CLOUD_NOISE_WGSL}

@group(0) @binding(0) var base_volume: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn bakeBaseVolume(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(base_volume);
  if (id.x >= size.x || id.y >= size.y || id.z >= size.z) {
    return;
  }
  let uvw = (vec3<f32>(id) + 0.5) / vec3<f32>(size);
  // R: perlin-worley "connected shape" — low-frequency perlin dilated by a
  // worley web so shapes read as connected cauliflower masses, not fog.
  let perlin = periodicPerlinFbm(uvw, 4, 31u);
  let webWorley = periodicWorley(uvw * 6.0, 6, 47u);
  let shape = clamp(
    (perlin - (1.0 - webWorley) * 0.28) / max(1.0 - 0.28, 1e-4),
    0.0,
    1.0,
  );
  // GBA: three inverted-worley octaves; the density function folds them as
  // worley = 1 - dot(gba, (0.625, 0.25, 0.125)).
  let worley0 = periodicWorley(uvw * 8.0, 8, 53u);
  let worley1 = periodicWorley(uvw * 16.0, 16, 59u);
  let worley2 = periodicWorley(uvw * 32.0, 32, 61u);
  textureStore(
    base_volume,
    vec3<i32>(id),
    vec4<f32>(shape, worley0, worley1, worley2),
  );
}
`;

const DETAIL_BAKE_WGSL = /* wgsl */ `
${CLOUD_NOISE_WGSL}

@group(0) @binding(0) var detail_volume: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn bakeDetailVolume(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(detail_volume);
  if (id.x >= size.x || id.y >= size.y || id.z >= size.z) {
    return;
  }
  let uvw = (vec3<f32>(id) + 0.5) / vec3<f32>(size);
  // RGB: erosion octaves, folded by dot(detail.rgb, (0.625, 0.25, 0.125)).
  let erosion0 = periodicWorley(uvw * 4.0, 4, 71u);
  let erosion1 = periodicWorley(uvw * 8.0, 8, 73u);
  let erosion2 = periodicWorley(uvw * 16.0, 16, 79u);
  textureStore(
    detail_volume,
    vec3<i32>(id),
    vec4<f32>(erosion0, erosion1, erosion2, 1.0),
  );
}
`;

const WEATHER_BAKE_WGSL = /* wgsl */ `
${CLOUD_NOISE_WGSL}

// 2-3: the weather field is a function of ABSOLUTE world position through
// UNWRAPPED cell hashes — it never repeats. The map is a camera-following
// window onto it (origin re-snapped and re-baked as the aircraft flies), so
// a 200 km leg keeps discovering new weather instead of tiling old weather.
fn worldValueNoise(p: vec2<f32>, seed: u32) -> f32 {
  let cell = vec2<i32>(floor(p));
  let fraction = p - floor(p);
  let fade = fraction * fraction * (3.0 - 2.0 * fraction);
  var value = 0.0;
  for (var dy = 0; dy <= 1; dy += 1) {
    for (var dx = 0; dx <= 1; dx += 1) {
      let corner = cell + vec2<i32>(dx, dy);
      let h = cloudBakeHash3(vec3<i32>(corner.x, corner.y, 733), seed);
      let weight = select(1.0 - fade.x, fade.x, dx == 1)
        * select(1.0 - fade.y, fade.y, dy == 1);
      value += weight * cloudBakeUnitFloat(h);
    }
  }
  return value;
}

fn worldFbm(p: vec2<f32>, seed: u32) -> f32 {
  return 0.5333 * worldValueNoise(p, seed)
    + 0.2667 * worldValueNoise(p * 2.0 + vec2<f32>(17.3, 9.1), seed + 101u)
    + 0.1333 * worldValueNoise(p * 4.0 + vec2<f32>(41.7, 23.9), seed + 202u);
}

struct WeatherParams {
  /** x coverage, y cloud type, z convection, w seed. */
  weather: vec4<f32>,
  /** xy world origin of the map (metres), z world size (metres), w unused. */
  origin_size: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: WeatherParams;
@group(0) @binding(1) var weather_map: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn bakeWeatherMap(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(weather_map);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(size);
  let world = params.origin_size.xy + uv * params.origin_size.z;
  let seed = u32(params.weather.w);
  // ~26 km broad cells, ~7 km break-up cells of the endless world field.
  let broad = worldFbm(world / 26000.0, seed + 11u);
  let breakup = worldFbm(world / 7000.0, seed + 13u);
  // Coverage: the broad field biased so its mean tracks the environment's
  // coverage scalar; worley break-up keeps edges ragged rather than foggy.
  let coverage = clamp(
    broad * 0.72 + breakup * 0.28 + (params.weather.x - 0.5) * 0.9,
    0.0,
    1.0,
  );
  // Cloud type drifts around the environment's type scalar; convection
  // pushes local maxima toward deeper forms.
  let type_variation = worldFbm(world / 41000.0, seed + 17u);
  let cloud_type = clamp(
    params.weather.y + (type_variation - 0.5) * 0.6
      + params.weather.z * coverage * 0.35,
    0.0,
    1.0,
  );
  // Precipitation only where coverage is deep and convection is real. No
  // renderer consumes it yet (recorded decision) — the channel exists so the
  // weather contract is complete for the phase that adds one.
  let precipitation = clamp(
    (coverage - 0.72) * 4.0 * params.weather.z,
    0.0,
    1.0,
  );
  textureStore(
    weather_map,
    vec2<i32>(id.xy),
    vec4<f32>(coverage, cloud_type, precipitation, 1.0),
  );
}
`;

function storage3d(scene: Scene, name: string, size: number): RawTexture3D {
  const texture = new RawTexture3D(
    null,
    size,
    size,
    size,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    Constants.TEXTURE_CREATIONFLAG_STORAGE,
  );
  texture.name = name;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.wrapR = Texture.WRAP_ADDRESSMODE;
  return texture;
}

/**
 * Owns the baked cloud volumes and the weather map. `bakeWhenReady()` is
 * polled by the cloud system (startup barrier and per-frame): volumes bake
 * exactly once; the weather map re-bakes whenever the environment scalars
 * change.
 */
export class CloudVolumeBake {
  /** The window size the map covers; the system passes the config value. */
  weatherWorldSizeMeters = 96_000;
  readonly baseVolume: RawTexture3D;
  readonly detailVolume: RawTexture3D;
  readonly weatherMap: RawTexture;
  private readonly baseCompute: ComputeShader;
  private readonly detailCompute: ComputeShader;
  private readonly weatherCompute: ComputeShader;
  private readonly weatherParams: UniformBuffer;
  private volumesBaked = false;
  private weatherBaked = false;
  private weatherCoverage = Number.NaN;
  private weatherType = Number.NaN;
  private weatherConvection = Number.NaN;
  private weatherOriginX = 0;
  private weatherOriginZ = 0;
  private weatherOriginInitialized = false;
  private disposed = false;

  constructor(private readonly scene: Scene) {
    this.baseVolume = storage3d(scene, "cloud-base-volume", CLOUD_BASE_VOLUME_SIZE);
    this.detailVolume = storage3d(scene, "cloud-detail-volume", CLOUD_DETAIL_VOLUME_SIZE);
    this.weatherMap = RawTexture.CreateRGBAStorageTexture(
      null,
      CLOUD_WEATHER_MAP_SIZE,
      CLOUD_WEATHER_MAP_SIZE,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    this.weatherMap.name = "cloud-weather-map";
    this.weatherMap.wrapU = Texture.WRAP_ADDRESSMODE;
    this.weatherMap.wrapV = Texture.WRAP_ADDRESSMODE;

    const engine = scene.getEngine();
    this.baseCompute = new ComputeShader(
      "cloud-base-bake",
      engine,
      { computeSource: BASE_BAKE_WGSL },
      {
        entryPoint: "bakeBaseVolume",
        bindingsMapping: { base_volume: { group: 0, binding: 0 } },
      },
    );
    this.detailCompute = new ComputeShader(
      "cloud-detail-bake",
      engine,
      { computeSource: DETAIL_BAKE_WGSL },
      {
        entryPoint: "bakeDetailVolume",
        bindingsMapping: { detail_volume: { group: 0, binding: 0 } },
      },
    );
    this.weatherCompute = new ComputeShader(
      "cloud-weather-bake",
      engine,
      { computeSource: WEATHER_BAKE_WGSL },
      {
        entryPoint: "bakeWeatherMap",
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          weather_map: { group: 0, binding: 1 },
        },
      },
    );
    for (const [shader, label] of [
      [this.baseCompute, "cloud-base-bake"],
      [this.detailCompute, "cloud-detail-bake"],
      [this.weatherCompute, "cloud-weather-bake"],
    ] as const) {
      shader.onError = (_effect, errors) => {
        throw new Error(`${label} failed to compile: ${errors}`);
      };
    }
    this.weatherParams = new UniformBuffer(engine, undefined, true, "cloud-weather-params");
    this.weatherParams.addUniform("weather", 4);
    this.weatherParams.addUniform("origin_size", 4);
    this.weatherParams.create();
    this.baseCompute.setStorageTexture("base_volume", this.baseVolume);
    this.detailCompute.setStorageTexture("detail_volume", this.detailVolume);
    this.weatherCompute.setUniformBuffer("params", this.weatherParams);
    this.weatherCompute.setStorageTexture("weather_map", this.weatherMap);
  }

  /**
   * 2-3: keep the weather window centred on the flight (including wind
   * advection). Re-snaps on a worldSize/8 grid so re-bakes are hysteretic —
   * roughly one 512² dispatch per dozen kilometres flown.
   */
  followCamera(
    centerXMeters: number,
    centerZMeters: number,
    worldSizeMeters: number,
  ): void {
    const snap = worldSizeMeters / 8;
    const originX = Math.round((centerXMeters - worldSizeMeters / 2) / snap) * snap;
    const originZ = Math.round((centerZMeters - worldSizeMeters / 2) / snap) * snap;
    if (
      this.weatherOriginInitialized
      && originX === this.weatherOriginX
      && originZ === this.weatherOriginZ
    ) {
      return;
    }
    this.weatherOriginX = originX;
    this.weatherOriginZ = originZ;
    this.weatherOriginInitialized = true;
    this.weatherBaked = false;
  }

  get weatherOrigin(): readonly [number, number] {
    return [this.weatherOriginX, this.weatherOriginZ];
  }

  /** New environment scalars: the weather map re-bakes on the next poll. */
  setWeather(coverage: number, cloudType: number, convection: number): void {
    if (
      coverage === this.weatherCoverage
      && cloudType === this.weatherType
      && convection === this.weatherConvection
    ) {
      return;
    }
    this.weatherCoverage = coverage;
    this.weatherType = cloudType;
    this.weatherConvection = convection;
    this.weatherBaked = false;
  }

  /** True once every bake this frame needs has been dispatched. */
  get ready(): boolean {
    return this.volumesBaked && this.weatherBaked;
  }

  /** Startup diagnostics for the cloud barrier's timeout message. */
  get diagnostics(): string {
    return `volumesBaked=${this.volumesBaked} weatherBaked=${this.weatherBaked} `
      + `baseReady=${this.baseCompute.isReady()} detailReady=${this.detailCompute.isReady()} `
      + `weatherReady=${this.weatherCompute.isReady()} `
      + `originInit=${this.weatherOriginInitialized} coverage=${this.weatherCoverage}`;
  }

  /** Dispatches whatever is pending and possible. Cheap when settled. */
  bakeWhenReady(): boolean {
    if (this.disposed) return false;
    if (!this.volumesBaked
      && this.baseCompute.isReady()
      && this.detailCompute.isReady()
    ) {
      const baseGroups = CLOUD_BASE_VOLUME_SIZE / 4;
      this.baseCompute.dispatch(baseGroups, baseGroups, baseGroups);
      const detailGroups = CLOUD_DETAIL_VOLUME_SIZE / 4;
      this.detailCompute.dispatch(detailGroups, detailGroups, detailGroups);
      this.volumesBaked = true;
    }
    if (!this.weatherBaked
      && Number.isFinite(this.weatherCoverage)
      && this.weatherOriginInitialized
      && this.weatherCompute.isReady()
    ) {
      this.weatherParams.updateFloat4(
        "weather",
        this.weatherCoverage,
        this.weatherType,
        this.weatherConvection,
        211,
      );
      this.weatherParams.updateFloat4(
        "origin_size",
        this.weatherOriginX,
        this.weatherOriginZ,
        this.weatherWorldSizeMeters,
        0,
      );
      this.weatherParams.update();
      const groups = CLOUD_WEATHER_MAP_SIZE / 8;
      this.weatherCompute.dispatch(groups, groups, 1);
      this.weatherBaked = true;
    }
    return this.ready;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.weatherParams.dispose();
    this.baseVolume.dispose();
    this.detailVolume.dispose();
    this.weatherMap.dispose();
  }
}
