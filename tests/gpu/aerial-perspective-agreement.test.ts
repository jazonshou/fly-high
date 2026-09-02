import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  AERIAL_PERSPECTIVE_FUNCTIONS_WGSL,
  evaluateAerialPerspective,
  resolveAerialPerspectiveBinding,
  type AerialPerspectiveBinding,
} from "../../src/render/webgpu/atmosphere/AerialPerspective";
import {
  MIE_SCALE_HEIGHT_METERS,
  RAYLEIGH_SCALE_HEIGHT_METERS,
} from "../../src/render/webgpu/atmosphere/AtmosphereLuts";
import { resolveEnvironmentState } from "../../src/render/webgpu/nature/EnvironmentDirector";

/**
 * 1C-4, assertion 31: the WGSL include and its TS mirror agree within 1% on a
 * REAL adapter. The kernel wraps the exact shipped include (uniform
 * declarations replaced by an explicit struct, the same substitution the PBR
 * plugin performs), so sky maths baked on the CPU (IBL, exposure) and haze
 * evaluated on the GPU can never drift apart silently.
 */

const KERNEL_WGSL = /* wgsl */ `
struct AerialUniforms {
  aerialCameraAltitude: f32,
  aerialSunDirection: vec3f,
  aerialRayleigh: vec3f,
  aerialMieScatter: vec3f,
  aerialMieExtinction: vec3f,
  aerialOzone: vec3f,
  aerialSunRadiance: vec3f,
  aerialAmbient: vec3f,
  aerialSunTransmittance: vec3f,
  aerialTwilightArch: vec3f,
  aerialNightZenithFade: f32,
  aerialParams: vec4f,
};

@group(0) @binding(0) var<storage, read> uniforms: AerialUniforms;
@group(0) @binding(1) var<storage, read> probes: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f>;

${AERIAL_PERSPECTIVE_FUNCTIONS_WGSL}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let aerial = aerialPerspective(probe.x, probe.y, probe.z);
  results[id.x * 2u] = vec4f(aerial.transmittance, 0.0);
  results[id.x * 2u + 1u] = vec4f(aerial.inScatter, 0.0);
}
`;

/**
 * Struct layout above: the f32 after the vec3 packs into float 39 (a vec3's
 * tail slot), then aerialParams aligns to 16 bytes at float 40 — 44 floats.
 */
function packUniforms(binding: AerialPerspectiveBinding): Float32Array {
  const data = new Float32Array(44);
  data[0] = binding.cameraAltitudeMeters;
  data.set(binding.sunDirection, 4);
  data.set(binding.coefficients.rayleighScattering, 8);
  data.set(binding.coefficients.mieScattering, 12);
  data.set(binding.coefficients.mieExtinction, 16);
  data.set(binding.coefficients.ozoneAbsorption, 20);
  data.set(binding.sunRadiance, 24);
  data.set(binding.ambient, 28);
  data.set(binding.sunTransmittance, 32);
  data.set(binding.twilightArch, 36);
  data[39] = binding.nightZenithFade;
  data[40] = RAYLEIGH_SCALE_HEIGHT_METERS;
  data[41] = MIE_SCALE_HEIGHT_METERS;
  data[42] = binding.coefficients.mieAnisotropy;
  data[43] = binding.strength;
  return data;
}

interface Probe {
  readonly fragmentAltitude: number;
  readonly distance: number;
  readonly viewDotSun: number;
}

function buildProbeGrid(): Probe[] {
  const probes: Probe[] = [];
  for (const fragmentAltitude of [0, 45, 1_500, 4_200, 11_000]) {
    for (const distance of [12, 900, 6_000, 21_000, 45_000]) {
      for (const viewDotSun of [-0.9, -0.2, 0.35, 0.97]) {
        probes.push({ fragmentAltitude, distance, viewDotSun });
      }
    }
  }
  return probes;
}

describe("TS/WGSL aerial-perspective agreement (assertion 31)", () => {
  it("agrees within 1% across altitudes, distances and sun angles", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    try {
      await engine.initAsync();

      const probes = buildProbeGrid();
      const probeData = new Float32Array(probes.length * 4);
      probes.forEach((probe, index) => {
        probeData[index * 4] = probe.fragmentAltitude;
        probeData[index * 4 + 1] = probe.distance;
        probeData[index * 4 + 2] = probe.viewDotSun;
      });

      // Two camera altitudes: on the deck and in cruise. Each is one
      // uniform payload and one dispatch over the whole probe grid.
      for (const [cameraAltitude, weather] of [
        [12, "clear"],
        [8_500, "cloudy"],
      ] as const) {
        const state = resolveEnvironmentState({
          clock: { dayOfYear: 171, solarTimeHours: 15 },
          latitudeDegrees: 45,
          weather,
        });
        const binding = resolveAerialPerspectiveBinding(
          state,
          cameraAltitude,
          [1, 0.9, 0.75],
          [0.55, 0.72, 0.93],
          0.87,
        );

        // Sized from the packed data itself, so the struct, the packer and
        // the allocation cannot drift apart — the 40*4 literal this replaces
        // survived one field addition and cost a buffer-overrun hunt.
        const packedUniforms = packUniforms(binding);
        const uniformBuffer = new StorageBuffer(engine, packedUniforms.byteLength);
        uniformBuffer.update(packedUniforms);
        const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
        probeBuffer.update(probeData);
        const resultBuffer = new StorageBuffer(engine, probes.length * 2 * 4 * 4);

        const shader = new ComputeShader(
          `aerial-agreement-${weather}`,
          engine,
          { computeSource: KERNEL_WGSL },
          {
            bindingsMapping: {
              uniforms: { group: 0, binding: 0 },
              probes: { group: 0, binding: 1 },
              results: { group: 0, binding: 2 },
            },
          },
        );
        shader.setStorageBuffer("uniforms", uniformBuffer);
        shader.setStorageBuffer("probes", probeBuffer);
        shader.setStorageBuffer("results", resultBuffer);

        engine.runRenderLoop(() => {});
        await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
        const view = await resultBuffer.read();
        engine.stopRenderLoop();
        const gpu = new Float32Array(view.buffer, view.byteOffset, probes.length * 8);

        probes.forEach((probe, index) => {
          const expected = evaluateAerialPerspective(
            binding.coefficients,
            binding.cameraAltitudeMeters,
            probe.fragmentAltitude,
            probe.distance,
            probe.viewDotSun,
            binding.sunRadiance,
            binding.ambient,
            binding.sunTransmittance,
          );
          const context = `${weather} camera ${cameraAltitude} probe ${index}`;
          for (let channel = 0; channel < 3; channel += 1) {
            const gpuTransmittance = gpu[index * 8 + channel]!;
            const gpuInScatter = gpu[index * 8 + 4 + channel]!;
            // Transmittance lives in [0, 1]: 1% absolute IS 1% of full scale.
            expect(
              Math.abs(gpuTransmittance - expected.transmittance[channel]!),
              `transmittance ${context} channel ${channel}`,
            ).toBeLessThan(0.01);
            // In-scatter is HDR: relative with a small absolute floor.
            const tolerance = Math.max(0.01 * Math.abs(expected.inScatter[channel]!), 0.0015);
            expect(
              Math.abs(gpuInScatter - expected.inScatter[channel]!),
              `inScatter ${context} channel ${channel}`,
            ).toBeLessThan(tolerance);
          }
        });

        uniformBuffer.dispose();
        probeBuffer.dispose();
        resultBuffer.dispose();
      }
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 90_000);
});
