import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, describe, expect, it } from "vitest";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { BEZEL_RIM, bezelRimEmissive } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import { COCKPIT_GLOW_NIGHT_MULTIPLE, cockpitInstrumentGlow } from "../src/render/webgpu/lighting/AircraftLighting";

/**
 * THE SCREENS' BEZEL RIMS, the Global's and the 747's: one material, and its own glow law.
 *
 * The rim is the 4 mm 45 degree chamfer round each bezel's frame (`framedScreenFacets`). Jason asked for it DIMMER by
 * day, the night glow untouched. Under `applyGlow` the night was the day value times the night multiple, so the day
 * read could not move without the night; the rim now has a day value and a night value of its own
 * (`bezelRimEmissive`), and both airframes read them from `BEZEL_RIM`, so the two cannot drift apart.
 */

const fixtures: { engine: NullEngine; scene: Scene; visual: AircraftVisual }[] = [];
function build(kind: "bizjet" | "airliner") {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const visual = createWebGpuAircraft(scene, kind);
  fixtures.push({ engine, scene, visual });
  return { scene, visual };
}
afterAll(() => {
  for (const { engine, scene, visual } of fixtures) {
    visual.dispose();
    scene.dispose();
    engine.dispose();
  }
});
const KINDS = ["bizjet", "airliner"] as const;
const lights = (cockpitGlow: number) => ({ portNav: 1, starboardNav: 1, tailNav: 1, beacon: 0, strobe: 0, landing: 0, cockpitGlow });
const rimOf = (scene: Scene, kind: string) => {
  const mesh = scene.getMeshByName(`${kind}-screen-bezel-rims`);
  expect(mesh, `${kind}'s rims`).not.toBeNull();
  return mesh!.material as PBRMaterial;
};
const channels = (c: Color3) => [c.r, c.g, c.b];

describe("the screens' bezel rims", () => {
  it("are one material on both airframes: the shared rim's albedo, finish and emissive, and nothing but the rims wears it", () => {
    const rims = KINDS.map((kind) => {
      const { scene } = build(kind);
      const rim = rimOf(scene, kind);
      expect(rim.name).toBe(`${kind}-instrument-marking`);
      // the rims, and no other mesh of the airframe
      const wearers = scene.meshes.filter((mesh) => mesh.material === rim).map((mesh) => mesh.name);
      expect(wearers, `${kind}: the meshes on the rim's material`).toEqual([`${kind}-screen-bezel-rims`]);
      return rim;
    });
    const want = BEZEL_RIM;
    for (const rim of rims) {
      expect(channels(rim.albedoColor)).toEqual(channels(Color3.FromHexString(`#${want.albedo.toString(16).padStart(6, "0")}`)));
      expect(channels(rim.emissiveColor)).toEqual(channels(Color3.FromHexString(`#${want.emissive.toString(16).padStart(6, "0")}`)));
      expect([rim.roughness, rim.metallic, rim.emissiveIntensity]).toEqual([want.roughness, want.metallic, want.dayEmissiveIntensity]);
    }
    // and the two alike, property by property
    const [global, jumbo] = rims as [PBRMaterial, PBRMaterial];
    expect(channels(jumbo.albedoColor)).toEqual(channels(global.albedoColor));
    expect(channels(jumbo.emissiveColor)).toEqual(channels(global.emissiveColor));
    expect([jumbo.roughness, jumbo.metallic, jumbo.emissiveIntensity]).toEqual([global.roughness, global.metallic, global.emissiveIntensity]);
  });

  it("glow by their own law: the day value by day, the night glow as it was at night (0.56), linear in the glow between", () => {
    // the night value is the rim's under `applyGlow` before it was dimmed: 0.175 times the night multiple, written out
    expect(COCKPIT_GLOW_NIGHT_MULTIPLE).toBe(3.2);
    expect(BEZEL_RIM.nightEmissiveIntensity).toBeCloseTo(0.56, 12);
    expect(bezelRimEmissive(1)).toBeCloseTo(BEZEL_RIM.dayEmissiveIntensity, 12);
    expect(bezelRimEmissive(COCKPIT_GLOW_NIGHT_MULTIPLE)).toBeCloseTo(0.56, 12);
    // through the glow law itself: a noon sun, and night
    expect(bezelRimEmissive(cockpitInstrumentGlow(0.8, 100_000))).toBeCloseTo(BEZEL_RIM.dayEmissiveIntensity, 12);
    expect(bezelRimEmissive(cockpitInstrumentGlow(-0.2, 0))).toBeCloseTo(0.56, 12);
    // linear, so continuous through twilight, and rising with the glow
    const mid = (1 + COCKPIT_GLOW_NIGHT_MULTIPLE) / 2;
    expect(bezelRimEmissive(mid)).toBeCloseTo((BEZEL_RIM.dayEmissiveIntensity + 0.56) / 2, 12);
    let last = -Infinity;
    for (let g = 1; g <= COCKPIT_GLOW_NIGHT_MULTIPLE + 1e-9; g += 0.1) {
      expect(bezelRimEmissive(g)).toBeGreaterThanOrEqual(last);
      last = bezelRimEmissive(g);
    }
    // a glow that is not a number reads as day, as `applyGlow`'s does
    expect(bezelRimEmissive(Number.NaN)).toBeCloseTo(BEZEL_RIM.dayEmissiveIntensity, 12);
  });

  it("are dim by day: no brighter than the setting the live sweep measured at 1.72 and 1.90 times the frame", () => {
    // MEASURED LIVE (the slot of 2026-09-23, seed g7500k2, 1600 x 900, one paused level frame per airframe, the rim
    // changed live and every pixel ray-confirmed as rim or frame; rim / frame luma, the Global then the 747):
    //   0.175 / 0.5 / 0x2b3237 (as it was):  116 / 41 = 2.80   104 / 36 = 2.86
    //   0 / 0.5 / 0x2b3237 (no emissive):     94 / 41 = 2.31    85 / 36 = 2.40   -- the emissive alone cannot do it
    //   0 / 0.82 / 0x2b3237:                   75 / 40 = 1.88    75 / 35 = 2.14   -- nor with the frame's finish
    //   0.05 / 0.82 / x0.6 (this):             68 / 40 = 1.72    67 / 35 = 1.90
    // The day read rises with each of the three, so each is held at the measured setting or darker: a rim the sweep
    // did not measure at 2.0 or under is not shipped. (The live frame is the measurement; this holds the material to it.)
    const r = BEZEL_RIM;
    expect(r.dayEmissiveIntensity, "the day emissive").toBeLessThanOrEqual(0.05);
    expect(r.roughness, "the finish: the frames' 0.82 or rougher (0.5 sheened the sky)").toBeGreaterThanOrEqual(0.82);
    const linear = (hex: number) => [16, 8, 0].map((shift) => (((hex >>> shift) & 0xff) / 255) ** 2.2);
    const luminance = (hex: number) => { const [cr, cg, cb] = linear(hex) as [number, number, number]; return 0.2126 * cr + 0.7152 * cg + 0.0722 * cb; };
    expect(luminance(r.albedo), "the albedo: 0x2b3237 at 0.6 or darker").toBeLessThanOrEqual(luminance(0x1a1e21) + 1e-12);
    // CONTROL: the rim as it was fails every one of the three
    expect(0.175).toBeGreaterThan(0.05);
    expect(0.5).toBeLessThan(0.82);
    expect(luminance(0x2b3237)).toBeGreaterThan(luminance(0x1a1e21));
  });

  it("are driven by it on both airframes: each visual's light state sets the rim's emissive, day, dusk and night", () => {
    for (const kind of KINDS) {
      const { scene, visual } = build(kind);
      const rim = rimOf(scene, kind);
      for (const g of [COCKPIT_GLOW_NIGHT_MULTIPLE, 2.1, 1, COCKPIT_GLOW_NIGHT_MULTIPLE, 1]) {
        visual.setLightState(lights(g));
        expect(rim.emissiveIntensity, `${kind} at glow ${g}`).toBeCloseTo(bezelRimEmissive(g), 12);
      }
    }
  });
});
