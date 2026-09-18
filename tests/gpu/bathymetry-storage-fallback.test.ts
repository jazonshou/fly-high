import { describe, expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import {
  BATHYMETRY_CLIPMAP_EDGE,
  BATHYMETRY_FAR_CLAMP_METERS,
  BATHYMETRY_FAR_TEXEL_METERS,
  BATHYMETRY_NEAR_CLAMP_METERS,
  BATHYMETRY_NEAR_TEXEL_METERS,
  BATHYMETRY_R16F_STORAGE_FEATURE,
  BATHYMETRY_UPDATE_WGSL,
  BathymetryClipmap,
  bathymetryUpdateWgsl,
  selectBathymetryStorageFormat,
} from "../../src/render/webgpu/water/BathymetryClipmap";
import { createWorld } from "../../src/world";
import { sampleNaturalTerrainHeight } from "../../src/world/terrain";
import { readBathymetryLevel, withBathymetryScene } from "./bathymetryClipmapHarness";

/**
 * The Firefox path, proven on the reference adapter.
 *
 * Firefox 155 (wgpu) does not expose `texture-formats-tier1`, and without it
 * STORAGE_BINDING on r16float is invalid, so `FlightRenderer.create` used to
 * refuse to start there ("This GPU does not expose texture-formats-tier1").
 * A device created here with NO optional features is validated by Dawn
 * against the features the DEVICE enabled, not the ones the adapter has —
 * which is exactly a core-only implementation's shape. So this file can pin
 * both halves without a Firefox in the loop:
 *
 *   1. the DIAGNOSIS — on that device the designed r16float storage texture
 *      cannot be created and the designed kernel cannot build a pipeline,
 *      while the rgba16float twin (the same source, one token different) can;
 *   2. the FIX — `BathymetryClipmap` at the fallback format fills both
 *      levels with the CPU kernel's bed delta through the real host path
 *      (recenter → strip dispatch → textureStore → readback), within the
 *      same half-float quantum the reference parity test uses.
 */

const CORE_ONLY_FEATURES: readonly string[] = [];

async function poppedValidationError(
  device: GPUDevice,
  act: () => void,
): Promise<string | null> {
  device.pushErrorScope("validation");
  act();
  const error = await device.popErrorScope();
  return error ? error.message : null;
}

describe("bathymetry storage on a core-only device (Firefox: no texture-formats-tier1)", () => {
  it("cannot host the designed r16float storage target, and can host the rgba16float fallback", async () => {
    await withBathymetryScene(async (engine) => {
      const device = engine._device;
      // Non-vacuity: the adapter DOES have the feature (this is the reference
      // machine); the device deliberately does not.
      expect(device.features.has(BATHYMETRY_R16F_STORAGE_FEATURE)).toBe(false);
      expect(selectBathymetryStorageFormat(device.features)).toBe("rgba16float");

      const storageUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
      const r16Texture = await poppedValidationError(device, () => {
        device.createTexture({ size: [4, 4], format: "r16float", usage: storageUsage }).destroy();
      });
      expect(r16Texture, "r16float STORAGE_BINDING must be refused without tier1").not.toBeNull();
      const rgba16Texture = await poppedValidationError(device, () => {
        device.createTexture({ size: [4, 4], format: "rgba16float", usage: storageUsage }).destroy();
      });
      expect(rgba16Texture).toBeNull();

      const buildPipeline = (code: string) => (): void => {
        const shaderModule = device.createShaderModule({ code });
        device.createComputePipeline({
          layout: "auto",
          compute: { module: shaderModule, entryPoint: "updateBathymetry" },
        });
      };
      const designed = await poppedValidationError(device, buildPipeline(BATHYMETRY_UPDATE_WGSL));
      expect(designed, "the r16float kernel must not build on a core-only device").not.toBeNull();
      const fallback = await poppedValidationError(
        device,
        buildPipeline(bathymetryUpdateWgsl("rgba16float")),
      );
      expect(fallback, "the rgba16float kernel must build on a core-only device").toBeNull();
    }, CORE_ONLY_FEATURES);
  }, 60_000);

  it("fills both levels with the CPU kernel's bed delta through rgba16float storage", async () => {
    const world = createWorld("bathymetry-storage-fallback", {
      airport: false,
      worldEvolution: "analytic",
    });
    const seaLevel = world.seaLevel;
    // Kilometres out and not a texel multiple, as the reference parity test.
    const centerX = 18_730;
    const centerZ = -9_310;
    const half = BATHYMETRY_CLIPMAP_EDGE / 2;
    const probeOffsets: readonly (readonly [number, number])[] = [
      [0, 0], [-half + 1, -half + 1], [half - 1, half - 1], [-half + 1, half - 1],
      [half - 1, -half + 1], [37, -211], [-455, 129],
    ];
    const check = (
      read: (worldTexelX: number, worldTexelZ: number) => number,
      texelMeters: number,
      clampMeters: number,
      observerX: number,
      observerZ: number,
      label: string,
    ): void => {
      const centerTexelX = Math.floor(observerX / texelMeters);
      const centerTexelZ = Math.floor(observerZ / texelMeters);
      for (const [dx, dz] of probeOffsets) {
        const texelX = centerTexelX + dx;
        const texelZ = centerTexelZ + dz;
        const height = sampleNaturalTerrainHeight(
          world.seedHash,
          texelX * texelMeters,
          texelZ * texelMeters,
          texelMeters,
        );
        const expected = Math.max(-clampMeters, Math.min(clampMeters, height - seaLevel));
        // Half-float either way: 11 significant bits, quantum grows with magnitude.
        const quantum = Math.max(0.05, Math.abs(expected) * 2 ** -10);
        expect(
          Math.abs(read(texelX, texelZ) - expected),
          `${label}: texel (${texelX}, ${texelZ}) expected bed delta ${expected.toFixed(3)}`,
        ).toBeLessThanOrEqual(quantum * 2);
      }
    };

    await withBathymetryScene(async (engine, scene) => {
      expect(engine._device.features.has(BATHYMETRY_R16F_STORAGE_FEATURE)).toBe(false);
      const clipmap = new BathymetryClipmap(scene, world, null, {
        storageFormat: selectBathymetryStorageFormat(engine._device.features),
      });
      try {
        expect(clipmap.storageFormat).toBe("rgba16float");
        expect(clipmap.textureBytes).toBe(16 * 1_024 * 1_024);
        const near = clipmap.binding.nearTexture!;
        const internal = near.getInternalTexture()!;
        expect(internal.format).toBe(Constants.TEXTUREFORMAT_RGBA);
        expect(internal.type).toBe(Constants.TEXTURETYPE_HALF_FLOAT);
        const gpuTexture = (internal._hardwareTexture as { underlyingResource?: GPUTexture } | null)
          ?.underlyingResource;
        expect(gpuTexture?.format).toBe("rgba16float");
        expect((gpuTexture!.usage & GPUTextureUsage.STORAGE_BINDING) !== 0).toBe(true);

        await clipmap.initialize(centerX, centerZ);
        expect(clipmap.isResident).toBe(true);
        const nearLevel = await readBathymetryLevel(near);
        expect(nearLevel.channelStride).toBe(4);
        check(
          nearLevel.read,
          BATHYMETRY_NEAR_TEXEL_METERS,
          BATHYMETRY_NEAR_CLAMP_METERS,
          centerX,
          centerZ,
          "near level, initial fill",
        );
        check(
          (await readBathymetryLevel(clipmap.binding.farTexture!)).read,
          BATHYMETRY_FAR_TEXEL_METERS,
          BATHYMETRY_FAR_CLAMP_METERS,
          centerX,
          centerZ,
          "far level, initial fill",
        );
        // A strip update after a texel crossing rides the same fallback target.
        const movedX = centerX + 9 * BATHYMETRY_NEAR_TEXEL_METERS + 5;
        const movedZ = centerZ - 4 * BATHYMETRY_NEAR_TEXEL_METERS - 2;
        expect(await clipmap.recenter(movedX, movedZ)).toBe(true);
        check(
          (await readBathymetryLevel(near)).read,
          BATHYMETRY_NEAR_TEXEL_METERS,
          BATHYMETRY_NEAR_CLAMP_METERS,
          movedX,
          movedZ,
          "near level, after a strip update",
        );
      } finally {
        clipmap.dispose();
      }
    }, CORE_ONLY_FEATURES);
  }, 180_000);
});
