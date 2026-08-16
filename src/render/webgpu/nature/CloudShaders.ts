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
  let weather = sampleCloudWeather(world_position);
  let coverage = cloudSaturate(weather.r + params.wind_time.w - 0.5);
  if (coverage <= 0.001) {
    return 0.0;
  }
  let cloud_type = cloudSaturate(mix(params.weather_origin_size.w, weather.g, 0.72));
  let profile = cloudVerticalProfile(height_fraction, cloud_type);
  let absolute_position = world_position + params.world_coordinate_origin.xyz;
  let base_position = vec3<f32>(
    absolute_position.x + params.wind_time.x,
    absolute_position.y,
    absolute_position.z + params.wind_time.y,
  );
  let base_uv = fract(base_position / max(params.noise_scales.x, 1.0));
  let base_noise = textureSampleLevel(base_noise_texture, linear_sampler, base_uv, 0.0);
  let worley = 1.0 - dot(base_noise.gba, vec3<f32>(0.625, 0.25, 0.125));
  let connected_shape = mix(base_noise.r, worley, 0.36);
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
  inverse_view_projection: mat4x4<f32>,
  previous_view_projection: mat4x4<f32>,
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
@group(0) @binding(2) var scene_depth: texture_depth_2d;
@group(0) @binding(3) var weather_texture: texture_2d<f32>;
@group(0) @binding(4) var base_noise_texture: texture_3d<f32>;
@group(0) @binding(5) var detail_noise_texture: texture_3d<f32>;
@group(0) @binding(6) var blue_noise_texture: texture_2d<f32>;
@group(0) @binding(7) var sky_view_lut: texture_2d<f32>;
@group(0) @binding(8) var atmosphere_transmittance_lut: texture_2d<f32>;

${CLOUD_RAYMARCH_DENSITY_WGSL}

fn reconstructWorldPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = params.inverse_view_projection * clip;
  return world.xyz / max(abs(world.w), 1e-6);
}

fn sampleAtmosphereTransmittance(world_position: vec3<f32>) -> vec3<f32> {
  let relative = world_position - params.planet_center_radius.xyz;
  let up = normalize(relative);
  let height_fraction = cloudSaturate(
    (length(relative) - params.planet_center_radius.w)
      / max(params.cloud_radii.y - params.planet_center_radius.w, 1.0),
  );
  let sun_zenith = dot(up, normalize(params.sun_direction_angular_radius.xyz));
  let uv = vec2<f32>(sun_zenith * 0.5 + 0.5, height_fraction);
  return textureSampleLevel(atmosphere_transmittance_lut, linear_sampler, uv, 0.0).rgb;
}

fn sampleSkyAmbient(world_position: vec3<f32>, ray_direction: vec3<f32>) -> vec3<f32> {
  let up = normalize(world_position - params.planet_center_radius.xyz);
  let sky_uv = vec2<f32>(dot(ray_direction, up) * 0.5 + 0.5,
    dot(up, normalize(params.sun_direction_angular_radius.xyz)) * 0.5 + 0.5);
  return textureSampleLevel(sky_view_lut, linear_sampler, sky_uv, 0.0).rgb;
}

fn cloudSunOpticalDepth(world_position: vec3<f32>) -> f32 {
  let sun_direction = normalize(params.sun_direction_angular_radius.xyz);
  let outer_hit = cloudRaySphere(
    world_position,
    sun_direction,
    params.planet_center_radius.xyz,
    params.cloud_radii.y,
  );
  let exit_distance = max(outer_hit.y, 0.0);
  let light_step_count = min(u32(params.march.w), CLOUD_MAX_LIGHT_STEPS);
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
) -> vec3<f32> {
  let sun_direction = normalize(params.sun_direction_angular_radius.xyz);
  let cosine = dot(ray_direction, sun_direction);
  let forward_phase = cloudHenyeyGreenstein(cosine, params.phase_precipitation.x);
  let backward_phase = cloudHenyeyGreenstein(cosine, params.phase_precipitation.y);
  let phase = mix(forward_phase, backward_phase, params.phase_precipitation.z);
  let sun_optical_depth = cloudSunOpticalDepth(world_position);
  let sun_transmittance = exp(-sun_optical_depth * params.optical.x);
  let atmosphere_transmittance = sampleAtmosphereTransmittance(world_position);
  let powder = 1.0 - exp(
    -local_density * view_step_length * params.optical.x * 2.0,
  );
  let powder_phase = phase + powder * params.optical.y * (1.0 / (4.0 * CLOUD_PI));
  let sun_radiance = params.sun_color_illuminance.rgb
    * params.sun_color_illuminance.w
    * atmosphere_transmittance
    * sun_transmittance
    * powder_phase;
  let ambient = sampleSkyAmbient(world_position, ray_direction) * params.optical.w;

  var multiple_scattering = vec3<f32>(0.0);
  var order_weight = params.optical.z;
  var order_transmittance = sqrt(max(sun_transmittance, 0.0));
  for (var order = 0u; order < 3u; order += 1u) {
    multiple_scattering += params.sun_color_illuminance.rgb
      * params.sun_color_illuminance.w
      * order_weight * order_transmittance * (1.0 / (4.0 * CLOUD_PI));
    order_weight *= params.optical.z;
    order_transmittance = sqrt(order_transmittance);
  }
  return sun_radiance + ambient + multiple_scattering;
}

struct CloudRaymarchOutput {
  /** Premultiplied scene-linear radiance in rgb and transmittance in a. */
  @location(0) radiance_transmittance: vec4<f32>,
  /** Representative distance, previous-UV motion, and history confidence. */
  @location(1) distance_motion_confidence: vec4<f32>,
};

@fragment
fn raymarchVolumetricClouds(@builtin(position) pixel_position: vec4<f32>) -> CloudRaymarchOutput {
  let uv = pixel_position.xy * params.output_size_inverse_size.zw;
  let scene_size = textureDimensions(scene_depth, 0);
  let scene_coordinate = clamp(
    vec2<i32>(uv * vec2<f32>(scene_size)),
    vec2<i32>(0),
    vec2<i32>(scene_size) - vec2<i32>(1),
  );
  let depth = textureLoad(scene_depth, scene_coordinate, 0);
  let camera_position = params.camera_position.xyz;
  let far_position = reconstructWorldPosition(uv, 1.0);
  let ray_direction = normalize(far_position - camera_position);
  var scene_distance = params.cloud_radii.z;
  if (depth < 0.999999) {
    scene_distance = min(
      scene_distance,
      length(reconstructWorldPosition(uv, depth) - camera_position),
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
  var output: CloudRaymarchOutput;
  if (trace_end <= trace_start) {
    output.radiance_transmittance = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    output.distance_motion_confidence = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return output;
  }

  let blue_size = textureDimensions(blue_noise_texture, 0);
  let blue_coordinate = vec2<i32>(
    (vec2<u32>(pixel_position.xy) + vec2<u32>(u32(params.full_size_frame_delta.z) * 37u, 0u))
      % blue_size,
  );
  let jitter = textureLoad(blue_noise_texture, blue_coordinate, 0).r;
  trace_start += jitter * params.march.x;
  var distance = trace_start;
  var transmittance = 1.0;
  var radiance = vec3<f32>(0.0);
  var weighted_distance = 0.0;
  var accumulated_opacity = 0.0;
  let maximum_steps = min(u32(params.march.z), CLOUD_MAX_VIEW_STEPS);

  for (var step_index = 0u; step_index < CLOUD_MAX_VIEW_STEPS; step_index += 1u) {
    if (step_index >= maximum_steps || distance >= trace_end || transmittance < 0.008) {
      break;
    }
    let world_position = camera_position + ray_direction * distance;
    let density = sampleCloudDensity(world_position, true);
    let density_weight = cloudSaturate(density * 3.0);
    let step_length = min(
      mix(params.march.y, params.march.x, density_weight),
      trace_end - distance,
    );
    if (density > 1e-4) {
      let sample_transmittance = exp(-density * params.optical.x * step_length);
      let opacity = 1.0 - sample_transmittance;
      let lighting = cloudLighting(world_position, ray_direction, density, step_length);
      radiance += transmittance * opacity * lighting;
      let weighted_opacity = transmittance * opacity;
      weighted_distance += distance * weighted_opacity;
      accumulated_opacity += weighted_opacity;
      transmittance *= sample_transmittance;
    }
    distance += max(step_length, params.march.x);
  }

  let representative_distance = select(
    0.0,
    weighted_distance / max(accumulated_opacity, 1e-5),
    accumulated_opacity > 1e-5,
  );
  var motion = vec2<f32>(0.0);
  if (representative_distance > 0.0) {
    let representative_position = camera_position + ray_direction * representative_distance;
    let previous_clip = params.previous_view_projection * vec4<f32>(representative_position, 1.0);
    let previous_ndc = previous_clip.xy / max(abs(previous_clip.w), 1e-6);
    let previous_uv = vec2<f32>(previous_ndc.x * 0.5 + 0.5, 0.5 - previous_ndc.y * 0.5);
    motion = previous_uv - uv;
  }
  output.radiance_transmittance = vec4<f32>(radiance, transmittance);
  output.distance_motion_confidence = vec4<f32>(
    representative_distance,
    motion,
    cloudSaturate(accumulated_opacity * 8.0 + 0.1),
  );
  return output;
}
`;

export const CLOUD_TEMPORAL_RESOLVE_WGSL = /* wgsl */ `
struct CloudTemporalParams {
  output_size: vec2<u32>,
  camera_cut: u32,
  _padding0: u32,
  history_weight: f32,
  distance_sigma_m: f32,
  luminance_clamp: f32,
  minimum_confidence: f32,
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
  let previous_uv = current_uv + auxiliary.yz;
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
  history.rgb *= (current_luminance * luminance_ratio) / history_luminance;

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
@group(0) @binding(4) var cloud_shadow: texture_storage_2d<r32float, write>;

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
    Object.freeze({ name: "raymarchVolumetricClouds", stage: "fragment" }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "linear_sampler", kind: "sampler", samplerType: "filtering" }),
    Object.freeze({ group: 0, binding: 2, name: "scene_depth", kind: "sampled-texture", viewDimension: "2d", sampleType: "depth" }),
    Object.freeze({ group: 0, binding: 3, name: "weather_texture", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 4, name: "base_noise_texture", kind: "sampled-texture", viewDimension: "3d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 5, name: "detail_noise_texture", kind: "sampled-texture", viewDimension: "3d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 6, name: "blue_noise_texture", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 7, name: "sky_view_lut", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 8, name: "atmosphere_transmittance_lut", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
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
    Object.freeze({ group: 0, binding: 4, name: "cloud_shadow", kind: "storage-texture", viewDimension: "2d", storageFormat: "r32float" }),
  ]),
});

export const CLOUD_SHADER_MODULES: readonly NatureShaderModule[] = Object.freeze([
  CLOUD_RAYMARCH_SHADER,
  CLOUD_TEMPORAL_RESOLVE_SHADER,
  CLOUD_SHADOW_SHADER,
]);
