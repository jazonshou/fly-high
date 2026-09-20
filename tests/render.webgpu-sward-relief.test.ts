import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  GROUND_BARE_FINE_METERS,
  GROUND_VIGOUR_FINE_METERS,
} from "@/src/render/webgpu/terrain/GroundPatchwork";
import {
  SWARD_RELIEF_DRY_GAIN,
  SWARD_RELIEF_EDGE,
  SWARD_RELIEF_HEIGHTS_METERS,
  SWARD_RELIEF_LUSH_GAIN,
  SWARD_RELIEF_OCTAVES,
  SWARD_RELIEF_STRENGTH,
  SWARD_RELIEF_TONES,
  SWARD_RELIEF_WAVELENGTHS_METERS,
  TERRAIN_SWARD_RELIEF_WGSL,
  swardReliefBlotch,
  swardReliefTone,
} from "@/src/render/webgpu/terrain/SwardRelief";
import { TerrainSurfacePlugin } from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * `D-3` — sward relief. What a frame cannot show: a tone that is not zero-mean
 * relights every meadow through the scene-mean bounce and re-tunes W-1 by the
 * back door; an octave with no footprint skip is paid for from cruise altitude;
 * and the band only answers the owner's complaint if it actually sits in the
 * gap no other term had a wavelength in.
 */
function fragmentSource(): string {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("sward-relief-test", scene);
  const plugin = new TerrainSurfacePlugin(material);
  const source = Object.values(
    plugin.getCustomCode("fragment", ShaderLanguage.WGSL) ?? {}).join("\n");
  material.dispose(true, true);
  scene.dispose();
  engine.dispose();
  return source;
}

describe("D-3 the sward relief field", () => {
  it("is zero-mean, with a mottle a frame can see and a meadow can carry", () => {
    const count = 160_000;
    let sum = 0;
    let squares = 0;
    for (let index = 0; index < count; index += 1) {
      const x = ((index * 0.754_877_666_2) % 1) * 3_000 - 1_500;
      const z = ((index * 0.569_840_290_9) % 1) * 3_000 - 1_500;
      const tone = swardReliefTone(x, z);
      sum += tone;
      squares += tone * tone;
    }
    const mean = sum / count;
    const sigma = Math.sqrt(squares / count - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.003);
    // Under ~5 % it is invisible beside W-1's patchwork; over ~12 % a meadow
    // reads as camouflage.
    expect(sigma).toBeGreaterThan(0.05);
    expect(sigma).toBeLessThan(0.12);
    console.log(`D-3 tone: mean ${mean.toExponential(2)}, sigma ${(sigma * 100).toFixed(1)} %`);
  });

  it("pushes each octave through an edge that is odd and bounded", () => {
    for (const noise of [0.05, 0.4, 1, 2.5]) {
      expect(swardReliefBlotch(-noise)).toBeCloseTo(-swardReliefBlotch(noise), 12);
      expect(Math.abs(swardReliefBlotch(noise))).toBeLessThan(1);
    }
    expect(swardReliefBlotch(1e-6) / 1e-6).toBeCloseTo(SWARD_RELIEF_EDGE, 5);
    // A gradient under ~1.3, a stencil over ~3: blotches with outlines between.
    expect(SWARD_RELIEF_EDGE).toBeGreaterThan(1.3);
    expect(SWARD_RELIEF_EDGE).toBeLessThan(3);
  });

  it("fills the gap between the material tile and the patchwork, and only that", () => {
    const wavelengths = SWARD_RELIEF_WAVELENGTHS_METERS;
    // The tile's content is under ~0.1 m and W-1's finest terms are these two.
    expect(Math.min(...wavelengths)).toBeGreaterThan(0.2);
    expect(Math.max(...wavelengths)).toBeLessThan(Math.min(GROUND_BARE_FINE_METERS, GROUND_VIGOUR_FINE_METERS));
    // No hole an octave wide left inside the band.
    for (let index = 1; index < wavelengths.length; index += 1) {
      const ratio = wavelengths[index - 1]! / wavelengths[index]!;
      expect(ratio).toBeLessThan(3);
      expect(Math.abs(ratio - Math.round(ratio)), `${wavelengths[index - 1]} / ${wavelengths[index]}`)
        .toBeGreaterThan(0.15);
    }
    // Relief per wavelength is what turns ground into a surface of objects.
    wavelengths.forEach((wavelength, index) => {
      expect(SWARD_RELIEF_HEIGHTS_METERS[index]! / wavelength).toBeLessThan(0.035);
    });
    expect(SWARD_RELIEF_TONES).toHaveLength(wavelengths.length);
  });

  it("keeps its review dials single constants, and steers by dryness within bounds", () => {
    expect(SWARD_RELIEF_OCTAVES).toBe(SWARD_RELIEF_WAVELENGTHS_METERS.length);
    expect(SWARD_RELIEF_STRENGTH).toBe(1);
    expect(SWARD_RELIEF_LUSH_GAIN).toBeLessThan(1);
    expect(SWARD_RELIEF_DRY_GAIN).toBeGreaterThan(1);
    expect(SWARD_RELIEF_DRY_GAIN / SWARD_RELIEF_LUSH_GAIN).toBeLessThan(2);
  });
});

describe("D-3 the WGSL it emits", () => {
  it("skips every octave by footprint, and the whole band once the coarsest has gone", () => {
    const source = TERRAIN_SWARD_RELIEF_WGSL;
    expect([...source.matchAll(/if \(weight > 0\.001\) \{/gu)]).toHaveLength(SWARD_RELIEF_OCTAVES);
    expect(source).toMatch(/terrainGroundOctaveWeight\(4\.3, footprintMeters\) <= 0\.001\) \{\s*return relief;/u);
  });

  it("keeps every house trap shut", () => {
    const source = TERRAIN_SWARD_RELIEF_WGSL;
    expect(source).not.toContain("`");
    expect(source).not.toMatch(/fract\(sin\(/u);
    expect(source).not.toMatch(/fwidth\(|dpdx\(|dpdy\(/u);
    expect(source).not.toMatch(/textureSample/u);
    for (const word of ["sample", "patch", "coherent", "smooth", "target", "filter"]) {
      expect(source).not.toMatch(new RegExp(`\\b(let|var|fn)\\s+${word}\\b`, "u"));
    }
    for (const match of source.matchAll(/\bfn\s+(\w+)/gu)) {
      expect(match[1]).toMatch(/^terrainSward/u);
    }
  });

  it("is applied on vegetated ground only, inside the patchwork's tier lane", () => {
    const source = fragmentSource();
    expect(source).toContain("terrainSwardReliefAt(terrainAbsolutePosition.xz, terrainFootprint3D)");
    // terrainGroundVegetation carries the airfield exclusion and is zero on
    // rock, snow, sand and pavement; opened soil keeps a reduced share.
    expect(source).toMatch(
      /let terrainSwardWeight = terrainGroundVegetation\s+\* \(1\.0 - terrainGroundBare \* 0\.55\)/u);
    const gate = source.indexOf("if (terrainGroundVegetation > 0.05 && terrainGroundPatchworkOn > 0.5) {");
    const call = source.indexOf("terrainSwardReliefAt(terrainAbsolutePosition.xz");
    expect(gate).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(gate);
    // A splice that drops or doubles a brace compiles nowhere and fails no Node
    // test but this one (it cost a capture cycle on 2026-09-20).
    const opens = [...source.matchAll(/\{/gu)].length;
    const closes = [...source.matchAll(/\}/gu)].length;
    expect(opens).toBe(closes);
  });
});
