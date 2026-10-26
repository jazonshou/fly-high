/**
 * The ocean spectrum in WGSL: the transliteration of `spectrum.ts`, line for
 * line, composed into the GPU initialisation shader
 * (`OCEAN_SPECTRUM_INITIALIZATION_WGSL`). `spectrum.ts` is the authority; a
 * change to one side is a change to both, and `tests/world.sea-twin.test.ts`
 * and `tests/gpu/ocean-twin-parity.test.ts` hold them together.
 *
 * Requires, in the including module: `OCEAN_PI`, and
 * `params: OceanSpectrumInitParams` (`patch_length_m`, `gravity_m_s2`,
 * `wind_speed_m_s`, `fetch_length_m`, `wind_direction`, `spectrum_scale`,
 * `directional_spread`, `water_depth_m`, `surface_tension_over_density`,
 * `minimum_wavelength_m`, `maximum_wavelength_m`).
 */

export const OCEAN_SPECTRUM_WGSL = /* wgsl */ `
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

// oceanWavePhaseIndex in spectrum.ts: the wave's own index, never the FFT's,
// so every tier draws the same wave with the same phase. Inside the 128-point
// grid it is the 128-point texel index the shipped hash always used.
fn oceanWavePhaseIndex(frequency: vec2<i32>) -> u32 {
  let reach = max(
    max(frequency.x, 1 - frequency.x),
    max(frequency.y, 1 - frequency.y),
  );
  var size = 128;
  var base = 0u;
  for (var level = 0; level < 3 && reach > size / 2; level += 1) {
    base += u32(size * size);
    size *= 2;
  }
  let wrapped = (frequency + vec2<i32>(size)) % vec2<i32>(size);
  return base + u32(wrapped.x) + u32(wrapped.y) * u32(size);
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

fn finiteDepthFactor(k_length: f32) -> f32 {
  // tanh(x) has rounded to 1.0 in f32 by x=10. Saturating its dimensionless
  // input there is physically lossless, and avoids undefined large-argument
  // transcendental behaviour observed through ANGLE/Metal: short-wave
  // cascades returned zero, while a few boundary texels became non-finite.
  return tanh(min(k_length * params.water_depth_m, 10.0));
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
  let tanh_depth = finiteDepthFactor(k_length);
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
`;
