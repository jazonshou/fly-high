import type { NatureShaderModule } from "./ShaderModule";

const OCEAN_WORKGROUP_8_X_8 = [8, 8, 1] as const;

const OCEAN_COMPLEX_WGSL = /* wgsl */ `
const OCEAN_PI: f32 = 3.14159265358979323846;

fn oceanComplexMultiply(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn oceanRotateComplexPair(value: vec4<f32>, twiddle: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(
    oceanComplexMultiply(value.xy, twiddle),
    oceanComplexMultiply(value.zw, twiddle),
  );
}
`;

export const OCEAN_SPECTRUM_INITIALIZATION_WGSL = /* wgsl */ `
${OCEAN_COMPLEX_WGSL}

struct OceanSpectrumInitParams {
  resolution: u32,
  seed: u32,
  cascade_index: u32,
  _padding0: u32,
  patch_length_m: f32,
  gravity_m_s2: f32,
  wind_speed_m_s: f32,
  fetch_length_m: f32,
  wind_direction: vec2<f32>,
  spectrum_scale: f32,
  directional_spread: f32,
  water_depth_m: f32,
  surface_tension_over_density: f32,
  minimum_wavelength_m: f32,
  maximum_wavelength_m: f32,
};

@group(0) @binding(0) var<uniform> params: OceanSpectrumInitParams;
@group(0) @binding(1) var initial_spectrum: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var wave_data: texture_storage_2d<rgba32float, write>;

fn hash32(value: u32) -> u32 {
  var state = value;
  state = state ^ (state >> 16u);
  state = state * 0x7feb352du;
  state = state ^ (state >> 15u);
  state = state * 0x846ca68bu;
  return state ^ (state >> 16u);
}

fn random01(value: u32) -> f32 {
  return f32(hash32(value) & 0x00ffffffu) / 16777216.0;
}

fn gaussianComplex(seed: u32) -> vec2<f32> {
  let u1 = max(random01(seed), 1e-7);
  let u2 = random01(seed ^ 0x9e3779b9u);
  let radius = sqrt(-2.0 * log(u1));
  let angle = 2.0 * OCEAN_PI * u2;
  return radius * vec2<f32>(cos(angle), sin(angle));
}

fn signedFrequencyIndex(index: u32, resolution: u32) -> i32 {
  let signed_index = i32(index);
  if (index > resolution / 2u) {
    return signed_index - i32(resolution);
  }
  return signed_index;
}

fn bandWindow(wavelength: f32) -> f32 {
  let low_width = max(params.minimum_wavelength_m * 0.18, 0.001);
  let high_width = max(params.maximum_wavelength_m * 0.18, 0.001);
  let low = smoothstep(
    params.minimum_wavelength_m - low_width,
    params.minimum_wavelength_m + low_width,
    wavelength,
  );
  let high = 1.0 - smoothstep(
    params.maximum_wavelength_m - high_width,
    params.maximum_wavelength_m + high_width,
    wavelength,
  );
  return low * high;
}

fn directionalJonswapSpectrum(k: vec2<f32>, k_length: f32, omega: f32) -> f32 {
  let gravity = params.gravity_m_s2;
  let wind = max(params.wind_speed_m_s, 0.05);
  let fetch = max(params.fetch_length_m, 1.0);
  let omega_peak = 22.0 * pow((gravity * gravity) / (wind * fetch), 1.0 / 3.0);
  let alpha = 0.076 * pow((wind * wind) / (fetch * gravity), 0.22);
  let sigma = select(0.09, 0.07, omega <= omega_peak);
  let peak_distance = (omega - omega_peak) / max(sigma * omega_peak, 1e-5);
  let peak_shape = exp(-0.5 * peak_distance * peak_distance);
  let peak_enhancement = pow(3.3, peak_shape);
  let frequency_spectrum = alpha * gravity * gravity
    * exp(-1.25 * pow(omega_peak / max(omega, 1e-4), 4.0))
    * peak_enhancement / max(pow(omega, 5.0), 1e-8);

  let capillary = params.surface_tension_over_density;
  let tanh_depth = tanh(k_length * params.water_depth_m);
  let dispersion_numerator = gravity * k_length + capillary * k_length * k_length * k_length;
  let dispersion_derivative = max(
    (gravity + 3.0 * capillary * k_length * k_length) * tanh_depth,
    1e-6,
  ) / max(2.0 * omega, 1e-5);
  let direction = k / max(k_length, 1e-6);
  let aligned = dot(direction, normalize(params.wind_direction));
  let forward_lobe = pow(max(aligned, 0.0), params.directional_spread);
  let opposing_lobe = 0.04 * pow(max(-aligned, 0.0), params.directional_spread * 0.5);
  let wavelength = 2.0 * OCEAN_PI / max(k_length, 1e-6);
  let radial_jacobian = dispersion_derivative / max(k_length, 1e-6);
  return max(
    frequency_spectrum * radial_jacobian * (forward_lobe + opposing_lobe)
      * bandWindow(wavelength) * params.spectrum_scale,
    0.0,
  );
}

@compute @workgroup_size(8, 8, 1)
fn initializeOceanSpectrum(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= params.resolution || invocation.y >= params.resolution) {
    return;
  }
  let k = (2.0 * OCEAN_PI / params.patch_length_m) * vec2<f32>(
    f32(signedFrequencyIndex(invocation.x, params.resolution)),
    f32(signedFrequencyIndex(invocation.y, params.resolution)),
  );
  let k_length = length(k);
  let coordinate = vec2<i32>(invocation.xy);
  if (k_length < 1e-6) {
    textureStore(initial_spectrum, coordinate, vec4<f32>(0.0));
    textureStore(wave_data, coordinate, vec4<f32>(0.0));
    return;
  }

  let gravity_term = params.gravity_m_s2 * k_length;
  let capillary_term = params.surface_tension_over_density * k_length * k_length * k_length;
  let omega = sqrt(
    max((gravity_term + capillary_term) * tanh(k_length * params.water_depth_m), 0.0),
  );
  let spectrum = directionalJonswapSpectrum(k, k_length, omega);
  let linear_index = invocation.x + invocation.y * params.resolution;
  let random_seed = params.seed
    ^ hash32(linear_index + 0x9e3779b9u * (params.cascade_index + 1u));
  let h0 = gaussianComplex(random_seed) * sqrt(0.5 * spectrum);
  textureStore(initial_spectrum, coordinate, vec4<f32>(h0, spectrum, omega));
  textureStore(wave_data, coordinate, vec4<f32>(k, k_length, omega));
}
`;

export const OCEAN_SPECTRUM_EVOLUTION_WGSL = /* wgsl */ `
${OCEAN_COMPLEX_WGSL}

struct OceanEvolutionParams {
  resolution: u32,
  cascade_index: u32,
  _padding0: vec2<u32>,
  time_seconds: f32,
  gravity_m_s2: f32,
  water_depth_m: f32,
  choppiness: f32,
};

@group(0) @binding(0) var<uniform> params: OceanEvolutionParams;
@group(0) @binding(1) var initial_spectrum: texture_2d<f32>;
@group(0) @binding(2) var wave_data: texture_2d<f32>;
@group(0) @binding(3) var height_displacement_x: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var displacement_z_aux: texture_storage_2d<rgba16float, write>;

fn conjugate(value: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(value.x, -value.y);
}

@compute @workgroup_size(8, 8, 1)
fn evolveOceanSpectrum(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= params.resolution || invocation.y >= params.resolution) {
    return;
  }
  let coordinate = vec2<i32>(invocation.xy);
  let mirrored = vec2<i32>(
    i32((params.resolution - invocation.x) % params.resolution),
    i32((params.resolution - invocation.y) % params.resolution),
  );
  let initial = textureLoad(initial_spectrum, coordinate, 0).xy;
  let initial_mirrored = conjugate(textureLoad(initial_spectrum, mirrored, 0).xy);
  let wave = textureLoad(wave_data, coordinate, 0);
  let phase = wave.w * params.time_seconds;
  let positive_phase = vec2<f32>(cos(phase), sin(phase));
  let negative_phase = vec2<f32>(positive_phase.x, -positive_phase.y);
  let height = oceanComplexMultiply(initial, positive_phase)
    + oceanComplexMultiply(initial_mirrored, negative_phase);

  var displacement_x = vec2<f32>(0.0);
  var displacement_z = vec2<f32>(0.0);
  if (wave.z > 1e-6) {
    let horizontal = wave.xy / wave.z;
    displacement_x = oceanComplexMultiply(
      height,
      vec2<f32>(0.0, -horizontal.x * params.choppiness),
    );
    displacement_z = oceanComplexMultiply(
      height,
      vec2<f32>(0.0, -horizontal.y * params.choppiness),
    );
  }
  textureStore(height_displacement_x, coordinate, vec4<f32>(height, displacement_x));
  textureStore(displacement_z_aux, coordinate, vec4<f32>(displacement_z, 0.0, 0.0));
}
`;

/**
 * Radix-2 Stockham autosort inverse FFT. It transforms two rgba textures in one
 * dispatch: height + displacement-x and displacement-z + an auxiliary complex
 * channel. Dispatch N/2 by N for horizontal passes, and N by N/2 for vertical.
 */
export const OCEAN_STOCKHAM_IFFT_WGSL = /* wgsl */ `
${OCEAN_COMPLEX_WGSL}

struct OceanFftParams {
  resolution: u32,
  stage: u32,
  axis: u32,
  normalize_result: u32,
};

@group(0) @binding(0) var<uniform> params: OceanFftParams;
@group(0) @binding(1) var source_a: texture_2d<f32>;
@group(0) @binding(2) var source_b: texture_2d<f32>;
@group(0) @binding(3) var destination_a: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var destination_b: texture_storage_2d<rgba16float, write>;

fn textureCoordinate(axis: u32, transform_index: u32, line_index: u32) -> vec2<i32> {
  if (axis == 0u) {
    return vec2<i32>(i32(transform_index), i32(line_index));
  }
  return vec2<i32>(i32(line_index), i32(transform_index));
}

@compute @workgroup_size(8, 8, 1)
fn stockhamInverseFft(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let butterfly_index = select(invocation.y, invocation.x, params.axis == 0u);
  let line_index = select(invocation.x, invocation.y, params.axis == 0u);
  let half_resolution = params.resolution / 2u;
  if (butterfly_index >= half_resolution || line_index >= params.resolution) {
    return;
  }

  let radix_span = 1u << params.stage;
  let local_index = butterfly_index & (radix_span - 1u);
  let block_index = butterfly_index >> params.stage;
  let destination_0 = block_index * (radix_span * 2u) + local_index;
  let destination_1 = destination_0 + radix_span;
  let source_0 = butterfly_index;
  let source_1 = butterfly_index + half_resolution;
  let angle = 2.0 * OCEAN_PI * f32(local_index) / f32(radix_span * 2u);
  let twiddle = vec2<f32>(cos(angle), sin(angle));

  let coordinate_0 = textureCoordinate(params.axis, source_0, line_index);
  let coordinate_1 = textureCoordinate(params.axis, source_1, line_index);
  let a0 = textureLoad(source_a, coordinate_0, 0);
  let a1 = oceanRotateComplexPair(textureLoad(source_a, coordinate_1, 0), twiddle);
  let b0 = textureLoad(source_b, coordinate_0, 0);
  let b1 = oceanRotateComplexPair(textureLoad(source_b, coordinate_1, 0), twiddle);
  // Per-axis normalisation (1B-13): 1/N at the last stage of each axis so
  // fp16 ping-pong intermediates keep the signal band well above the
  // smallest normal. The product across both axes is the same 1/N².
  let normalization = select(
    1.0,
    1.0 / f32(params.resolution),
    params.normalize_result != 0u,
  );

  textureStore(
    destination_a,
    textureCoordinate(params.axis, destination_0, line_index),
    (a0 + a1) * normalization,
  );
  textureStore(
    destination_a,
    textureCoordinate(params.axis, destination_1, line_index),
    (a0 - a1) * normalization,
  );
  textureStore(
    destination_b,
    textureCoordinate(params.axis, destination_0, line_index),
    (b0 + b1) * normalization,
  );
  textureStore(
    destination_b,
    textureCoordinate(params.axis, destination_1, line_index),
    (b0 - b1) * normalization,
  );
}
`;

export const OCEAN_SPATIAL_DERIVATION_WGSL = /* wgsl */ `
struct OceanDeriveParams {
  resolution: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
  texel_length_m: f32,
  foam_threshold: f32,
  foam_gain: f32,
  foam_history_decay: f32,
};

@group(0) @binding(0) var<uniform> params: OceanDeriveParams;
@group(0) @binding(1) var spatial_height_displacement_x: texture_2d<f32>;
@group(0) @binding(2) var spatial_displacement_z_aux: texture_2d<f32>;
@group(0) @binding(3) var previous_slope_foam: texture_2d<f32>;
@group(0) @binding(4) var displacement_jacobian: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var slope_foam: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var slope_moment: texture_storage_2d<rgba16float, write>;

fn wrapped(value: i32, size: i32) -> i32 {
  return (value + size) % size;
}

fn spatialDisplacement(coordinate: vec2<i32>) -> vec3<f32> {
  let size = i32(params.resolution);
  let wrapped_coordinate = vec2<i32>(wrapped(coordinate.x, size), wrapped(coordinate.y, size));
  let height_x = textureLoad(spatial_height_displacement_x, wrapped_coordinate, 0);
  let displacement_z = textureLoad(spatial_displacement_z_aux, wrapped_coordinate, 0);
  return vec3<f32>(height_x.z, height_x.x, displacement_z.x);
}

// 2-8: the cascade output stores SLOPE, not a normal. A box-filtered mip of
// a slope field is the correct filtered slope (slopes of an additive height
// field average linearly); a box-filtered normal is not a normal. Layout:
// RG = (dy/dx, dy/dz) of the displaced surface, B = foam, A = Jacobian.
// slope_moment carries RG = (slope_x^2, slope_z^2) so the mip chain's
// E[s^2] - E[s]^2 recovers the sub-footprint slope variance for Toksvig.
@compute @workgroup_size(8, 8, 1)
fn deriveOceanSurface(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= params.resolution || invocation.y >= params.resolution) {
    return;
  }
  let coordinate = vec2<i32>(invocation.xy);
  let centre = spatialDisplacement(coordinate);
  let left = spatialDisplacement(coordinate + vec2<i32>(-1, 0));
  let right = spatialDisplacement(coordinate + vec2<i32>(1, 0));
  let down = spatialDisplacement(coordinate + vec2<i32>(0, -1));
  let up = spatialDisplacement(coordinate + vec2<i32>(0, 1));
  let inverse_width = 0.5 / max(params.texel_length_m, 1e-5);
  let derivative_x = (right - left) * inverse_width;
  let derivative_z = (up - down) * inverse_width;

  let tangent_x = vec3<f32>(1.0 + derivative_x.x, derivative_x.y, derivative_x.z);
  let tangent_z = vec3<f32>(derivative_z.x, derivative_z.y, 1.0 + derivative_z.z);
  let normal = cross(tangent_z, tangent_x);
  // slope = n.xz / n.y of the displaced surface. n.y equals the horizontal
  // Jacobian, which pinches toward zero exactly where waves break; the
  // denominator clamp plus the ±8 component clamp (tan ~83°, steeper than
  // any renderable wave) bound the stored slope there — foam covers those
  // crests, one breaking texel cannot poison a whole mip footprint, and the
  // squared moments stay ≤ 64 where fp16 spacing is still 1/16.
  let slope = clamp(normal.xz / max(normal.y, 0.05), vec2<f32>(-8.0), vec2<f32>(8.0));
  let jacobian = (1.0 + derivative_x.x) * (1.0 + derivative_z.z)
    - derivative_z.x * derivative_x.z;
  let breaking = clamp((params.foam_threshold - jacobian) * params.foam_gain, 0.0, 1.0);
  let previous_foam = textureLoad(previous_slope_foam, coordinate, 0).b;
  let foam = max(breaking, previous_foam * params.foam_history_decay);

  textureStore(displacement_jacobian, coordinate, vec4<f32>(centre, jacobian));
  textureStore(slope_foam, coordinate, vec4<f32>(slope.x, slope.y, foam, jacobian));
  textureStore(slope_moment, coordinate, vec4<f32>(slope.x * slope.x, slope.y * slope.y, 0.0, 0.0));
}
`;

export const OCEAN_SPECTRUM_INITIALIZATION_SHADER: NatureShaderModule = Object.freeze({
  label: "nature/ocean-spectrum-initialization",
  code: OCEAN_SPECTRUM_INITIALIZATION_WGSL,
  entryPoints: Object.freeze([
    Object.freeze({ name: "initializeOceanSpectrum", stage: "compute", workgroupSize: OCEAN_WORKGROUP_8_X_8 }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "initial_spectrum", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba32float" }),
    Object.freeze({ group: 0, binding: 2, name: "wave_data", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba32float" }),
  ]),
});

export const OCEAN_SPECTRUM_EVOLUTION_SHADER: NatureShaderModule = Object.freeze({
  label: "nature/ocean-spectrum-evolution",
  code: OCEAN_SPECTRUM_EVOLUTION_WGSL,
  entryPoints: Object.freeze([
    Object.freeze({ name: "evolveOceanSpectrum", stage: "compute", workgroupSize: OCEAN_WORKGROUP_8_X_8 }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "initial_spectrum", kind: "sampled-texture", viewDimension: "2d", sampleType: "unfilterable-float" }),
    Object.freeze({ group: 0, binding: 2, name: "wave_data", kind: "sampled-texture", viewDimension: "2d", sampleType: "unfilterable-float" }),
    // 1B-13: the FFT ping-pong is rgba16float (this metadata was stale at
    // rgba32float until 2-8 touched the module — the WGSL is authoritative).
    Object.freeze({ group: 0, binding: 3, name: "height_displacement_x", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
    Object.freeze({ group: 0, binding: 4, name: "displacement_z_aux", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
  ]),
});

export const OCEAN_STOCKHAM_IFFT_SHADER: NatureShaderModule = Object.freeze({
  label: "nature/ocean-stockham-ifft",
  code: OCEAN_STOCKHAM_IFFT_WGSL,
  entryPoints: Object.freeze([
    Object.freeze({ name: "stockhamInverseFft", stage: "compute", workgroupSize: OCEAN_WORKGROUP_8_X_8 }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "source_a", kind: "sampled-texture", viewDimension: "2d", sampleType: "unfilterable-float" }),
    Object.freeze({ group: 0, binding: 2, name: "source_b", kind: "sampled-texture", viewDimension: "2d", sampleType: "unfilterable-float" }),
    Object.freeze({ group: 0, binding: 3, name: "destination_a", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
    Object.freeze({ group: 0, binding: 4, name: "destination_b", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
  ]),
});

export const OCEAN_SPATIAL_DERIVATION_SHADER: NatureShaderModule = Object.freeze({
  label: "nature/ocean-spatial-derivation",
  code: OCEAN_SPATIAL_DERIVATION_WGSL,
  entryPoints: Object.freeze([
    Object.freeze({ name: "deriveOceanSurface", stage: "compute", workgroupSize: OCEAN_WORKGROUP_8_X_8 }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ group: 0, binding: 0, name: "params", kind: "uniform-buffer" }),
    Object.freeze({ group: 0, binding: 1, name: "spatial_height_displacement_x", kind: "sampled-texture", viewDimension: "2d", sampleType: "unfilterable-float" }),
    Object.freeze({ group: 0, binding: 2, name: "spatial_displacement_z_aux", kind: "sampled-texture", viewDimension: "2d", sampleType: "unfilterable-float" }),
    Object.freeze({ group: 0, binding: 3, name: "previous_slope_foam", kind: "sampled-texture", viewDimension: "2d", sampleType: "float" }),
    Object.freeze({ group: 0, binding: 4, name: "displacement_jacobian", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
    Object.freeze({ group: 0, binding: 5, name: "slope_foam", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
    Object.freeze({ group: 0, binding: 6, name: "slope_moment", kind: "storage-texture", viewDimension: "2d", storageFormat: "rgba16float" }),
  ]),
});

export const OCEAN_SHADER_MODULES: readonly NatureShaderModule[] = Object.freeze([
  OCEAN_SPECTRUM_INITIALIZATION_SHADER,
  OCEAN_SPECTRUM_EVOLUTION_SHADER,
  OCEAN_STOCKHAM_IFFT_SHADER,
  OCEAN_SPATIAL_DERIVATION_SHADER,
]);
