import type { NatureShaderModule } from "./ShaderModule";

const CLOUD_WORKGROUP_8_X_8 = [8, 8, 1] as const;

const CLOUD_SHARED_WGSL = /* wgsl */ `
const CLOUD_PI: f32 = 3.14159265358979323846;
const CLOUD_MAX_VIEW_STEPS: u32 = 192u;
const CLOUD_MAX_LIGHT_STEPS: u32 = 16u;

fn cloudSaturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn cloudRemap(value: f32, old_min: f32, old_max: f32, new_min: f32, new_max: f32) -> f32 {
  let fraction = (value - old_min) / max(old_max - old_min, 1e-5);
  return mix(new_min, new_max, fraction);
}

fn cloudHenyeyGreenstein(cos_angle: f32, asymmetry: f32) -> f32 {
  let g2 = asymmetry * asymmetry;
  let denominator = max(1.0 + g2 - 2.0 * asymmetry * cos_angle, 1e-4);
  return (1.0 - g2) / (4.0 * CLOUD_PI * pow(denominator, 1.5));
}

fn cloudRaySphere(
  ray_origin: vec3<f32>,
  ray_direction: vec3<f32>,
  sphere_center: vec3<f32>,
  sphere_radius: f32,
) -> vec2<f32> {
  let offset = ray_origin - sphere_center;
  let b = dot(offset, ray_direction);
  let c = dot(offset, offset) - sphere_radius * sphere_radius;
  let discriminant = b * b - c;
  if (discriminant < 0.0) {
    return vec2<f32>(1e30, -1e30);
  }
  let root = sqrt(discriminant);
  return vec2<f32>(-b - root, -b + root);
}
`;

const CLOUD_RAYMARCH_DENSITY_WGSL = /* wgsl */ `
fn cloudHeightFraction(world_position: vec3<f32>) -> f32 {
  let radius = length(world_position - params.planet_center_radius.xyz);
  return cloudSaturate(
    (radius - params.cloud_radii.x) / max(params.cloud_radii.y - params.cloud_radii.x, 1.0),
  );
}

fn cloudVerticalProfile(height_fraction: f32, cloud_type: f32) -> f32 {
  let stratus = smoothstep(0.02, 0.12, height_fraction)
    * (1.0 - smoothstep(0.58, 0.82, height_fraction));
  let cumulus = smoothstep(0.01, 0.15, height_fraction)
    * (1.0 - smoothstep(0.70, 0.98, height_fraction));
  let storm = smoothstep(0.0, 0.08, height_fraction)
    * (1.0 - smoothstep(0.88, 1.0, height_fraction));
  return mix(mix(stratus, cumulus, smoothstep(0.05, 0.62, cloud_type)), storm,
    smoothstep(0.62, 1.0, cloud_type));
}

fn sampleCloudWeather(world_position: vec3<f32>) -> vec4<f32> {
  let absolute_position = world_position + params.world_coordinate_origin.xyz;
  let weather_uv = fract(
    (absolute_position.xz + params.wind_time.xy - params.weather_origin_size.xy)
      / max(params.weather_origin_size.z, 1.0),
  );
  return textureSampleLevel(weather_texture, linear_sampler, weather_uv, 0.0);
}

fn sampleCloudDensity(world_position: vec3<f32>, include_detail: bool) -> f32 {
  let height_fraction = cloudHeightFraction(world_position);
  if (height_fraction <= 0.0 || height_fraction >= 1.0) {
    return 0.0;
  }
  // 2-2: wind shear — the sample position leans downwind with height, so
  // cumulus lean instead of standing as vertical pillars. One of the
  // strongest cheap cues that the sky is a fluid.
  let wind_length = length(params.wind_time.xy);
  var sheared_position = world_position;
  if (wind_length > 1e-3) {
    let shear = (params.wind_time.xy / wind_length) * (height_fraction * 560.0);
    sheared_position = world_position + vec3<f32>(shear.x, 0.0, shear.y);
  }
  let weather = sampleCloudWeather(sheared_position);
  let coverage = cloudSaturate(weather.r + params.wind_time.w - 0.5);
  if (coverage <= 0.001) {
    return 0.0;
  }
  let cloud_type = cloudSaturate(mix(params.weather_origin_size.w, weather.g, 0.72));
  let profile = cloudVerticalProfile(height_fraction, cloud_type);
  let absolute_position = sheared_position + params.world_coordinate_origin.xyz;
  let base_position = vec3<f32>(
    absolute_position.x + params.wind_time.x,
    absolute_position.y,
    absolute_position.z + params.wind_time.y,
  );
  let base_uv = fract(base_position / max(params.noise_scales.x, 1.0));
  let base_noise = textureSampleLevel(base_noise_texture, linear_sampler, base_uv, 0.0);
  let worley = 1.0 - dot(base_noise.gba, vec3<f32>(0.625, 0.25, 0.125));
  // 2-3: dual-scale sampling — a second fetch at an incommensurate 3.7×
  // scale modulates the shape, so the base volume's repeat period and the
  // modulation period never align over a 200 km leg.
  let broad_uv = fract(base_position / max(params.noise_scales.x * 3.7, 1.0));
  let broad_noise = textureSampleLevel(base_noise_texture, linear_sampler, broad_uv, 0.0).r;
  let connected_shape = mix(base_noise.r, worley, 0.36) * (0.78 + 0.44 * broad_noise);
  let coverage_threshold = 1.0 - coverage;
  var density = cloudSaturate(cloudRemap(
    connected_shape * profile,
    coverage_threshold,
    1.0,
    0.0,
    1.0,
  ));

  if (include_detail && density > 0.001) {
    let detail_position = vec3<f32>(
      base_position.x + params.wind_time.z * 1.7,
      base_position.y,
      base_position.z - params.wind_time.z * 1.1,
    );
    let detail_uv = fract(detail_position / max(params.noise_scales.y, 1.0));
    let detail = textureSampleLevel(detail_noise_texture, linear_sampler, detail_uv, 0.0);
    let erosion_noise = dot(detail.rgb, vec3<f32>(0.625, 0.25, 0.125));
    let edge_weight = 1.0 - smoothstep(0.35, 0.8, density);
    density = cloudSaturate(density - erosion_noise * params.noise_scales.w * edge_weight);
  }
  let precipitation_thickening = 1.0 + weather.b * params.phase_precipitation.w * 0.35;
  return density * params.cloud_radii.w * precipitation_thickening;
}
`;

export const CLOUD_RAYMARCH_WGSL = /* wgsl */ `
${CLOUD_SHARED_WGSL}

struct CloudRaymarchParams {
  /** xyz unit camera forward; w = view scale x (tan half-fov). */
  camera_forward: vec4<f32>,
  /** xyz unit camera right; w = view scale y. */
  camera_right: vec4<f32>,
  /** xyz unit camera up; w = march stride growth per metre of ray distance (2-5). */
  camera_up: vec4<f32>,
  camera_position: vec4<f32>,
  planet_center_radius: vec4<f32>,
  sun_direction_angular_radius: vec4<f32>,
  sun_color_illuminance: vec4<f32>,
  output_size_inverse_size: vec4<f32>,
  full_size_frame_delta: vec4<f32>,
  cloud_radii: vec4<f32>,
  noise_scales: vec4<f32>,
  wind_time: vec4<f32>,
  march: vec4<f32>,
  optical: vec4<f32>,
  phase_precipitation: vec4<f32>,
  weather_origin_size: vec4<f32>,
  world_coordinate_origin: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: CloudRaymarchParams;
@group(0) @binding(1) var linear_sampler: sampler;
// Camera-space Z in metres (2-0a DepthRenderer, storeCameraSpaceZ); 0 = sky.
@group(0) @binding(2) var scene_depth: texture_2d<f32>;
@group(0) @binding(3) var weather_texture: texture_2d<f32>;
@group(0) @binding(4) var base_noise_texture: texture_3d<f32>;
@group(0) @binding(5) var detail_noise_texture: texture_3d<f32>;
@group(0) @binding(6) var blue_noise_texture: texture_2d<f32>;
@group(0) @binding(7) var sky_view_lut: texture_2d<f32>;
@group(0) @binding(8) var atmosphere_transmittance_lut: texture_2d<f32>;
@group(0) @binding(9) var raymarch_cloud: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var raymarch_aux: texture_storage_2d<rgba16float, write>;
// 2-5: density-sample counter — the adaptive march's whole justification is
// a measured number, not an impression (assertion 39).
@group(0) @binding(11) var<storage, read_write> density_counter: array<atomic<u32>>;

${CLOUD_RAYMARCH_DENSITY_WGSL}

// Must match transmittanceLutUv() in atmosphere/AtmosphereLuts.ts — the
// tested CPU parameterisation the 2-0a upload was baked with.
const CLOUD_ATMOSPHERE_SHELL_HEIGHT: f32 = 100000.0;

fn sampleAtmosphereTransmittance(world_position: vec3<f32>) -> vec3<f32> {
  let relative = world_position - params.planet_center_radius.xyz;
  let up = normalize(relative);
  let altitude = max(length(relative) - params.planet_center_radius.w, 0.0);
  let sun_zenith = dot(up, normalize(params.sun_direction_angular_radius.xyz));
  let uv = vec2<f32>(
    clamp((sun_zenith + 0.2) / 1.2, 0.0, 1.0),
    sqrt(clamp(altitude / CLOUD_ATMOSPHERE_SHELL_HEIGHT, 0.0, 1.0)),
  );
  return textureSampleLevel(atmosphere_transmittance_lut, linear_sampler, uv, 0.0).rgb;
}

// Must match the 2-0a sky-ambient LUT bake: u = view elevation, v = azimuth
// relative to the sun (wrapping), so the ambient brightens toward the sun.
fn sampleSkyAmbient(world_position: vec3<f32>, ray_direction: vec3<f32>) -> vec3<f32> {
  let up = normalize(world_position - params.planet_center_radius.xyz);
  let elevation = dot(ray_direction, up);
  let sun = normalize(params.sun_direction_angular_radius.xyz);
  var sun_horizontal = sun.xz;
  if (dot(sun_horizontal, sun_horizontal) < 1e-8) {
    sun_horizontal = vec2<f32>(1.0, 0.0);
  }
  sun_horizontal = normalize(sun_horizontal);
  var ray_horizontal = ray_direction.xz;
  if (dot(ray_horizontal, ray_horizontal) < 1e-8) {
    ray_horizontal = sun_horizontal;
  }
  ray_horizontal = normalize(ray_horizontal);
  let cos_azimuth = dot(ray_horizontal, sun_horizontal);
  let sin_azimuth = ray_horizontal.x * sun_horizontal.y - ray_horizontal.y * sun_horizontal.x;
  let azimuth_fraction = atan2(sin_azimuth, cos_azimuth) / (2.0 * CLOUD_PI) + 0.5;
  let sky_uv = vec2<f32>(elevation * 0.5 + 0.5, azimuth_fraction);
  return textureSampleLevel(sky_view_lut, linear_sampler, sky_uv, 0.0).rgb;
}

fn cloudSunOpticalDepth(world_position: vec3<f32>, requested_steps: u32) -> f32 {
  let sun_direction = normalize(params.sun_direction_angular_radius.xyz);
  let outer_hit = cloudRaySphere(
    world_position,
    sun_direction,
    params.planet_center_radius.xyz,
    params.cloud_radii.y,
  );
  let exit_distance = max(outer_hit.y, 0.0);
  let light_step_count = min(requested_steps, CLOUD_MAX_LIGHT_STEPS);
  if (light_step_count == 0u || exit_distance <= 0.0) {
    return 0.0;
  }
  let step_length = exit_distance / f32(light_step_count);
  var optical_depth = 0.0;
  for (var index = 0u; index < CLOUD_MAX_LIGHT_STEPS; index += 1u) {
    if (index >= light_step_count) {
      break;
    }
    let distance = (f32(index) + 0.5) * step_length;
    optical_depth += sampleCloudDensity(world_position + sun_direction * distance, false)
      * step_length;
  }
  return optical_depth;
}

fn cloudLighting(
  world_position: vec3<f32>,
  ray_direction: vec3<f32>,
  local_density: f32,
  view_step_length: f32,
  light_step_count: u32,
) -> vec3<f32> {
  let ambient = sampleSkyAmbient(world_position, ray_direction) * params.optical.w;
  // 2-5: with the sun below the horizon its radiance terms are all zero, but
  // the light march that feeds them still costs lightSteps density fetches
  // per view sample. Skip the whole sun path when there is no sun energy —
  // measured 20 ms GPU p95 on the night capture shot without this.
  let sun_energy = params.sun_color_illuminance.w
    * max(
      params.sun_color_illuminance.r,
      max(params.sun_color_illuminance.g, params.sun_color_illuminance.b),
    );
  if (sun_energy < 1e-3) {
    return ambient;
  }
  let sun_direction = normalize(params.sun_direction_angular_radius.xyz);
  let cosine = dot(ray_direction, sun_direction);
  let forward_phase = cloudHenyeyGreenstein(cosine, params.phase_precipitation.x);
  let backward_phase = cloudHenyeyGreenstein(cosine, params.phase_precipitation.y);
  let phase = mix(forward_phase, backward_phase, params.phase_precipitation.z);
  let sun_optical_depth = cloudSunOpticalDepth(world_position, light_step_count);
  let sun_transmittance = exp(-sun_optical_depth * params.optical.x);
  let atmosphere_transmittance = sampleAtmosphereTransmittance(world_position);
  // 2-4: powder is a BACKSCATTER approximation — it must fall off as the
  // view aligns with the sun (cosine → 1 is the forward/silver-lining lobe,
  // where the dark-edge effect does not exist).
  let powder = 1.0 - exp(
    -local_density * view_step_length * params.optical.x * 2.0,
  );
  let powder_backscatter = cloudSaturate(0.5 - 0.5 * cosine);
  let powder_phase = phase
    + powder * powder_backscatter * params.optical.y * (1.0 / (4.0 * CLOUD_PI));
  let sun_radiance = params.sun_color_illuminance.rgb
    * params.sun_color_illuminance.w
    * atmosphere_transmittance
    * sun_transmittance
    * powder_phase;

  // 2-4: the multiple-scattering octaves decay energy, EXTINCTION and phase
  // per order (a^n, b^n, c^n — Jarosz/Schneider). Decaying only energy
  // brightens the cloud uniformly instead of filling shadowed interiors,
  // which reads as milk. a = multipleScatteringFactor (config), b = c = 0.5
  // (literature constants, pinned by comment not config — the knobs stay
  // densityMultiplier and extinctionPerMeter).
  var multiple_scattering = vec3<f32>(0.0);
  var order_energy = params.optical.z;
  var order_extinction = 0.5;
  var order_phase_scale = 0.5;
  for (var order = 0u; order < 3u; order += 1u) {
    let octave_transmittance = exp(-sun_optical_depth * params.optical.x * order_extinction);
    let octave_phase = mix(
      cloudHenyeyGreenstein(cosine, params.phase_precipitation.x * order_phase_scale),
      cloudHenyeyGreenstein(cosine, params.phase_precipitation.y * order_phase_scale),
      params.phase_precipitation.z,
    );
    multiple_scattering += params.sun_color_illuminance.rgb
      * params.sun_color_illuminance.w
      * atmosphere_transmittance
      * order_energy * octave_transmittance * octave_phase;
    order_energy *= params.optical.z;
    order_extinction *= 0.5;
    order_phase_scale *= 0.5;
  }
  return sun_radiance + ambient + multiple_scattering;
}

// 2-0 adoption deviation: the raymarch runs as a COMPUTE pass writing two
// storage textures instead of an MRT fragment pass — Babylon's compute path
// (the ocean's proven pattern) binds storage textures directly, and no MRT
// plumbing needs to exist. Scene depth arrives as camera-space Z metres.
@compute @workgroup_size(8, 8, 1)
fn raymarchVolumetricClouds(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let output_size = vec2<u32>(params.output_size_inverse_size.xy);
  if (invocation.x >= output_size.x || invocation.y >= output_size.y) {
    return;
  }
  let pixel = vec2<i32>(invocation.xy);
  let uv = (vec2<f32>(invocation.xy) + 0.5) * params.output_size_inverse_size.zw;
  let scene_size = textureDimensions(scene_depth, 0);
  let scene_coordinate = clamp(
    vec2<i32>(uv * vec2<f32>(scene_size)),
    vec2<i32>(0),
    vec2<i32>(scene_size) - vec2<i32>(1),
  );
  let view_z = textureLoad(scene_depth, scene_coordinate, 0).r;
  let camera_position = params.camera_position.xyz;
  // The shipped 1B-12 ray convention: camera basis + view scale, the same
  // formula the temporal reprojection and composite rebuild, so all three
  // passes agree on rays by construction (no view-projection matrix).
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let ray_direction = normalize(
    params.camera_forward.xyz
      + params.camera_right.xyz * (ndc.x * params.camera_forward.w)
      + params.camera_up.xyz * (ndc.y * params.camera_right.w),
  );
  var scene_distance = params.cloud_radii.z;
  if (view_z > 0.0) {
    scene_distance = min(
      scene_distance,
      view_z / max(dot(ray_direction, params.camera_forward.xyz), 0.05),
    );
  }

  let outer_hit = cloudRaySphere(
    camera_position,
    ray_direction,
    params.planet_center_radius.xyz,
    params.cloud_radii.y,
  );
  var trace_start = max(outer_hit.x, 0.0);
  let trace_end = min(outer_hit.y, scene_distance);
  // 2-5: a camera under the slab base otherwise marches provably-empty air
  // from the lens to the base — every sky ray in a below-layer view paid
  // skip strides through clear sky (measured on slant-10km/ground-2m).
  // Density below the inner sphere is zero by construction, so starting at
  // the base intersection is exact. For rays that dip below the horizon the
  // inner exit lies beyond the trace cap, which correctly writes empty sky
  // instead of marching far-side cloud through the planet.
  let camera_height = length(camera_position - params.planet_center_radius.xyz);
  if (camera_height < params.cloud_radii.x) {
    let inner_hit = cloudRaySphere(
      camera_position,
      ray_direction,
      params.planet_center_radius.xyz,
      params.cloud_radii.x,
    );
    trace_start = max(trace_start, inner_hit.y);
  }
  if (trace_end <= trace_start) {
    textureStore(raymarch_cloud, pixel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    textureStore(raymarch_aux, pixel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let blue_size = textureDimensions(blue_noise_texture, 0);
  let blue_coordinate = vec2<i32>(
    (invocation.xy + vec2<u32>(u32(params.full_size_frame_delta.z) * 37u, 0u))
      % blue_size,
  );
  let jitter = textureLoad(blue_noise_texture, blue_coordinate, 0).r;
  // The jitter must cover one local stride, and strides grow with distance —
  // an unscaled jitter at a far slab entry no longer breaks up banding.
  trace_start += jitter * params.march.x * (1.0 + trace_start * params.camera_up.w);
  var distance = trace_start;
  var transmittance = 1.0;
  var radiance = vec3<f32>(0.0);
  var weighted_distance = 0.0;
  var accumulated_opacity = 0.0;
  var density_samples = 0u;
  var was_skipping = false;
  let maximum_steps = min(u32(params.march.z), CLOUD_MAX_VIEW_STEPS);
  // 2-5: strides grow linearly with ray distance (×2 at the configured
  // doubling distance). A level ray can spend tens of kilometres inside the
  // 5.7 km slab; at near-field stride that exhausts the whole step budget on
  // far, low-frequency content — measured 32 ms GPU p95 on slant-10km.
  let stride_growth = params.camera_up.w;

  for (var step_index = 0u; step_index < CLOUD_MAX_VIEW_STEPS; step_index += 1u) {
    if (step_index >= maximum_steps || distance >= trace_end || transmittance < 0.008) {
      break;
    }
    let stride_scale = 1.0 + distance * stride_growth;
    let fine_step = params.march.x * stride_scale;
    // 2-5: the long stride used through empty space. Twice the coarse step —
    // wide enough to pay, narrow enough that the back-up step recovers edges.
    let skip_stride = params.march.y * 2.0 * stride_scale;
    let world_position = camera_position + ray_direction * distance;
    let density = sampleCloudDensity(world_position, true);
    density_samples += 1u;
    if (density <= 1e-4) {
      // 2-5: empty space — advance by the long stride and keep striding
      // until density reappears.
      distance += skip_stride;
      was_skipping = true;
      continue;
    }
    if (was_skipping) {
      // Density reappeared after a long stride: step back one stride and
      // resume the fine march so the cloud edge is not overshot.
      distance = max(distance - skip_stride + fine_step, trace_start);
      was_skipping = false;
      continue;
    }
    let density_weight = cloudSaturate(density * 3.0);
    let step_length = min(
      mix(params.march.y, params.march.x, density_weight) * stride_scale,
      trace_end - distance,
    );
    // Distant samples keep their transmittance exact but light with fewer
    // sun-march steps — the octave detail they resolve is subpixel out there.
    let light_step_count = max(
      2u,
      u32(ceil(params.march.w / (1.0 + distance * stride_growth * 0.5))),
    );
    let sample_transmittance = exp(-density * params.optical.x * step_length);
    let opacity = 1.0 - sample_transmittance;
    let lighting = cloudLighting(
      world_position,
      ray_direction,
      density,
      step_length,
      light_step_count,
    );
    radiance += transmittance * opacity * lighting;
    let weighted_opacity = transmittance * opacity;
    weighted_distance += distance * weighted_opacity;
    accumulated_opacity += weighted_opacity;
    transmittance *= sample_transmittance;
    distance += max(step_length, fine_step);
  }
  atomicAdd(&density_counter[0], density_samples);

  let representative_distance = select(
    0.0,
    weighted_distance / max(accumulated_opacity, 1e-5),
    accumulated_opacity > 1e-5,
  );
  // 1A-4/1B-12: motion vectors from a cached previous-frame camera matrix
  // are the stale-matrix bug class CloudReprojection.ts exists to forbid. The
  // temporal resolve reprojects from the previous RAY BASIS and the absolute
  // camera delta instead; the aux motion slot stays zero.
  textureStore(raymarch_cloud, pixel, vec4<f32>(radiance, transmittance));
  textureStore(raymarch_aux, pixel, vec4<f32>(
    representative_distance,
    0.0,
    0.0,
    cloudSaturate(accumulated_opacity * 8.0 + 0.1),
  ));
}
`;

export const CLOUD_TEMPORAL_RESOLVE_WGSL = /* wgsl */ `
// Reprojection follows CloudReprojection.ts's 1B-12 invariant: previous RAY
// BASIS plus the delta of ABSOLUTE camera positions — never a cached
// view-projection matrix, so a floating-origin rebase is a no-op by
// construction (the 1A-4 counter-rotating-cloud bug class).
struct CloudTemporalParams {
  output_size: vec2<u32>,
  camera_cut: u32,
  _padding0: u32,
  history_weight: f32,
  distance_sigma_m: f32,
  luminance_clamp: f32,
  minimum_confidence: f32,
  /** xyz current forward; w = maximum trace distance (metres). */
  current_forward: vec4<f32>,
  /** xyz current right; w = current view scale x. */
  current_right: vec4<f32>,
  /** xyz current up; w = current view scale y. */
  current_up: vec4<f32>,
  /** xyz previous forward; w = previous view scale x. */
  previous_forward: vec4<f32>,
  /** xyz previous right; w = previous view scale y. */
  previous_right: vec4<f32>,
  /** xyz previous up; w unused. */
  previous_up: vec4<f32>,
  /** xyz camera position delta (current − previous, absolute metres). */
  camera_delta: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: CloudTemporalParams;
@group(0) @binding(1) var current_cloud: texture_2d<f32>;
@group(0) @binding(2) var current_aux: texture_2d<f32>;
@group(0) @binding(3) var history_cloud: texture_2d<f32>;
@group(0) @binding(4) var history_aux: texture_2d<f32>;
@group(0) @binding(5) var resolved_cloud: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var resolved_aux: texture_storage_2d<rgba16float, write>;

fn cloudLuminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn temporalViewRay(uv: vec2<f32>) -> vec3<f32> {
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(
    params.current_forward.xyz
      + params.current_right.xyz * (ndc.x * params.current_right.w)
      + params.current_up.xyz * (ndc.y * params.current_up.w),
  );
}

// Previous-frame uv of a point at the given distance along the current ray,
// or (-1,-1) when it lands behind the previous camera.
fn reprojectPreviousUv(uv: vec2<f32>, distance: f32) -> vec2<f32> {
  let point = temporalViewRay(uv) * distance + params.camera_delta.xyz;
  let forward_depth = dot(point, params.previous_forward.xyz);
  if (forward_depth <= 1e-6) {
    return vec2<f32>(-1.0, -1.0);
  }
  let ndc_x = dot(point, params.previous_right.xyz)
    / (forward_depth * max(params.previous_forward.w, 1e-6));
  let ndc_y = dot(point, params.previous_up.xyz)
    / (forward_depth * max(params.previous_right.w, 1e-6));
  return vec2<f32>(ndc_x * 0.5 + 0.5, 0.5 - ndc_y * 0.5);
}

@compute @workgroup_size(8, 8, 1)
fn resolveCloudTemporal(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= params.output_size.x || invocation.y >= params.output_size.y) {
    return;
  }
  let coordinate = vec2<i32>(invocation.xy);
  let current = textureLoad(current_cloud, coordinate, 0);
  let auxiliary = textureLoad(current_aux, coordinate, 0);
  var neighborhood_min = current;
  var neighborhood_max = current;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let neighbor_coordinate = clamp(
        coordinate + vec2<i32>(x, y),
        vec2<i32>(0),
        vec2<i32>(params.output_size) - vec2<i32>(1),
      );
      let neighbor = textureLoad(current_cloud, neighbor_coordinate, 0);
      neighborhood_min = min(neighborhood_min, neighbor);
      neighborhood_max = max(neighborhood_max, neighbor);
    }
  }

  let current_uv = (vec2<f32>(invocation.xy) + 0.5) / vec2<f32>(params.output_size);
  // Reproject at the representative distance; empty pixels reproject at the
  // maximum trace distance so clear sky still tracks camera rotation.
  let reprojection_distance = select(
    params.current_forward.w,
    auxiliary.x,
    auxiliary.x > 0.0,
  );
  let previous_uv = reprojectPreviousUv(current_uv, reprojection_distance);
  let history_in_bounds = all(previous_uv >= vec2<f32>(0.0))
    && all(previous_uv <= vec2<f32>(1.0));
  var history = current;
  var history_distance = auxiliary.x;
  if (history_in_bounds && params.camera_cut == 0u) {
    let history_coordinate = clamp(
      vec2<i32>(previous_uv * vec2<f32>(params.output_size)),
      vec2<i32>(0),
      vec2<i32>(params.output_size) - vec2<i32>(1),
    );
    history = textureLoad(history_cloud, history_coordinate, 0);
    history_distance = textureLoad(history_aux, history_coordinate, 0).x;
  }

  history = clamp(history, neighborhood_min, neighborhood_max);
  let current_luminance = max(cloudLuminance(current.rgb), 1e-5);
  let history_luminance = max(cloudLuminance(history.rgb), 1e-5);
  let luminance_ratio = clamp(
    history_luminance / current_luminance,
    1.0 / params.luminance_clamp,
    params.luminance_clamp,
  );
  // Whole-vector assignment, not a compound assignment to .rgb. A
  // multi-component swizzle is not a reference in WGSL, so it cannot be the
  // target of a compound assignment: spec-strict validators reject it
  // ("no matching overload for operator *= (swizzle<...>, f32)") and the
  // renderer then fails to boot with a bare "PREPARING AIRSPACE". The Tint
  // build behind the test suites' Playwright Chromium accepts it, which is
  // exactly why this shipped — and why assertion 51b scans the sources
  // statically instead of trusting one adapter.
  let history_scale = (current_luminance * luminance_ratio) / history_luminance;
  history = vec4<f32>(history.rgb * history_scale, history.a);

  let both_clear = auxiliary.x <= 0.0 && history_distance <= 0.0;
  let distance_confidence = select(
    exp(-abs(auxiliary.x - history_distance) / max(params.distance_sigma_m, 1.0)),
    1.0,
    both_clear,
  );
  var weight = params.history_weight * distance_confidence
    * smoothstep(params.minimum_confidence, 1.0, auxiliary.w);
  if (!history_in_bounds || params.camera_cut != 0u) {
    weight = 0.0;
  }
  let resolved = mix(current, history, clamp(weight, 0.0, params.history_weight));
  textureStore(resolved_cloud, coordinate, resolved);
  textureStore(resolved_aux, coordinate, auxiliary);
}
`;

export const CLOUD_SHADOW_WGSL = /* wgsl */ `
${CLOUD_SHARED_WGSL}

struct CloudShadowParams {
  planet_center_radius: vec4<f32>,
  shadow_center: vec4<f32>,
  east_axis_span: vec4<f32>,
  north_axis_span: vec4<f32>,
  sun_direction_steps: vec4<f32>,
  cloud_radii_density: vec4<f32>,
  noise_scales: vec4<f32>,
  wind_time_coverage: vec4<f32>,
  weather_origin_size_type: vec4<f32>,
  optical_frame: vec4<f32>,
  world_coordinate_origin: vec4<f32>,
  output_size: vec2<u32>,
  _padding0: vec2<u32>,
};

@group(0) @binding(0) var<uniform> params: CloudShadowParams;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var weather_texture: texture_2d<f32>;
@group(0) @binding(3) var base_noise_texture: texture_3d<f32>;
// rgba16float, not r32float: the receiver materials sample this map with a
// FILTERING sampler, and r32float is not filterable in core WebGPU.
@group(0) @binding(4) var cloud_shadow: texture_storage_2d<rgba16float, write>;

fn shadowHeightFraction(world_position: vec3<f32>) -> f32 {
  let radius = length(world_position - params.planet_center_radius.xyz);
  return cloudSaturate(
    (radius - params.cloud_radii_density.x)
      / max(params.cloud_radii_density.y - params.cloud_radii_density.x, 1.0),
  );
}

fn shadowVerticalProfile(height_fraction: f32, cloud_type: f32) -> f32 {
  let bottom = mix(0.04, 0.01, cloud_type);
  let top = mix(0.72, 0.98, cloud_type);
  return smoothstep(bottom, min(bottom + 0.15, 0.3), height_fraction)
    * (1.0 - smoothstep(max(top - 0.25, 0.5), top, height_fraction));
}

fn sampleShadowDensity(world_position: vec3<f32>) -> f32 {
  let height_fraction = shadowHeightFraction(world_position);
  if (height_fraction <= 0.0 || height_fraction >= 1.0) {
    return 0.0;
  }
  let absolute_position = world_position + params.world_coordinate_origin.xyz;
  let weather_uv = fract(
    (absolute_position.xz + params.wind_time_coverage.xy - params.weather_origin_size_type.xy)
      / max(params.weather_origin_size_type.z, 1.0),
  );
  let weather = textureSampleLevel(weather_texture, linear_sampler, weather_uv, 0.0);
  let coverage = cloudSaturate(weather.r + params.wind_time_coverage.w - 0.5);
  let cloud_type = cloudSaturate(mix(params.weather_origin_size_type.w, weather.g, 0.72));
  let base_uv = fract(vec3<f32>(
    absolute_position.x + params.wind_time_coverage.x,
    absolute_position.y,
    absolute_position.z + params.wind_time_coverage.y,
  ) / max(params.noise_scales.x, 1.0));
  let noise = textureSampleLevel(base_noise_texture, linear_sampler, base_uv, 0.0);
  let shape = mix(noise.r, 1.0 - dot(noise.gba, vec3<f32>(0.625, 0.25, 0.125)), 0.36);
  return cloudSaturate(cloudRemap(
    shape * shadowVerticalProfile(height_fraction, cloud_type),
    1.0 - coverage,
    1.0,
    0.0,
    1.0,
  )) * params.cloud_radii_density.z;
}

@compute @workgroup_size(8, 8, 1)
fn renderCloudShadow(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= params.output_size.x || invocation.y >= params.output_size.y) {
    return;
  }
  let uv = (vec2<f32>(invocation.xy) + 0.5) / vec2<f32>(params.output_size) - 0.5;
  let tangent_point = params.shadow_center.xyz
    + params.east_axis_span.xyz * (uv.x * params.east_axis_span.w)
    + params.north_axis_span.xyz * (uv.y * params.north_axis_span.w);
  let radial = normalize(tangent_point - params.planet_center_radius.xyz);
  let surface_position = params.planet_center_radius.xyz + radial * params.planet_center_radius.w;
  let sun_direction = normalize(params.sun_direction_steps.xyz);
  let outer_hit = cloudRaySphere(
    surface_position,
    sun_direction,
    params.planet_center_radius.xyz,
    params.cloud_radii_density.y,
  );
  let trace_end = max(outer_hit.y, 0.0);
  let step_count = min(u32(params.sun_direction_steps.w), 64u);
  let step_length = trace_end / max(f32(step_count), 1.0);
  var optical_depth = 0.0;
  let jitter = f32((invocation.x * 13u + invocation.y * 71u
    + u32(params.optical_frame.y) * 17u) & 255u) / 256.0;
  for (var index = 0u; index < 64u; index += 1u) {
    if (index >= step_count) {
      break;
    }
    let distance = (f32(index) + jitter) * step_length;
    optical_depth += sampleShadowDensity(surface_position + sun_direction * distance)
      * step_length;
  }
  let transmittance = exp(-optical_depth * params.optical_frame.x);
  textureStore(cloud_shadow, vec2<i32>(invocation.xy), vec4<f32>(transmittance));
}
`;

export const CLOUD_RAYMARCH_SHADER: NatureShaderModule = Object.freeze({
  label: "nature/cloud-raymarch",
  code: CLOUD_RAYMARCH_WGSL,
  entryPoints: Object.freeze([
    // 2-0 adoption: compute, not an MRT fragment pass (recorded deviation).
    Object.freeze({ name: "raymarchVolumetricClouds", stage: "compute", workgroupSize: CLOUD_WORKGROUP_8_X_8 }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "linear_sampler", kind: "sampler", samplerType: "filtering" }),
    Object.freeze({ group: 0, binding: 2, name: "scene_depth", kind: "sampled-texture", viewDimension: "2d", sampleType: "unfilterable-float" }),
    Object.freeze({ group: 0, binding: 3, name: "weather_texture", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 4, name: "base_noise_texture", kind: "sampled-texture", viewDimension: "3d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 5, name: "detail_noise_texture", kind: "sampled-texture", viewDimension: "3d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 6, name: "blue_noise_texture", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 7, name: "sky_view_lut", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 8, name: "atmosphere_transmittance_lut", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 9, name: "raymarch_cloud", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
    Object.freeze({ group: 0, binding: 10, name: "raymarch_aux", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
    Object.freeze({ group: 0, binding: 11, name: "density_counter", kind: "storage-buffer" }),
  ]),
});

export const CLOUD_TEMPORAL_RESOLVE_SHADER: NatureShaderModule = Object.freeze({
  label: "nature/cloud-temporal-resolve",
  code: CLOUD_TEMPORAL_RESOLVE_WGSL,
  entryPoints: Object.freeze([
    Object.freeze({ name: "resolveCloudTemporal", stage: "compute", workgroupSize: CLOUD_WORKGROUP_8_X_8 }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "current_cloud", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 2, name: "current_aux", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 3, name: "history_cloud", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 4, name: "history_aux", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 5, name: "resolved_cloud", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
    Object.freeze({ group: 0, binding: 6, name: "resolved_aux", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
  ]),
});

export const CLOUD_SHADOW_SHADER: NatureShaderModule = Object.freeze({
  label: "nature/cloud-shadow",
  code: CLOUD_SHADOW_WGSL,
  entryPoints: Object.freeze([
    Object.freeze({ name: "renderCloudShadow", stage: "compute", workgroupSize: CLOUD_WORKGROUP_8_X_8 }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "linear_sampler", kind: "sampler", samplerType: "filtering" }),
    Object.freeze({ group: 0, binding: 2, name: "weather_texture", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 3, name: "base_noise_texture", kind: "sampled-texture", viewDimension: "3d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 4, name: "cloud_shadow", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
  ]),
});

export const CLOUD_SHADER_MODULES: readonly NatureShaderModule[] = Object.freeze([
  CLOUD_RAYMARCH_SHADER,
  CLOUD_TEMPORAL_RESOLVE_SHADER,
  CLOUD_SHADOW_SHADER,
]);
