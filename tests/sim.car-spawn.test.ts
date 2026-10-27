import { describe, expect, it } from "vitest";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_HEIGHT_CORE } from "../src/render/webgpu/world/pageGeometry";
import { GROUND_WAIT_SECONDS, GroundVehicleSimulator } from "../src/sim/ground/groundVehicle";
import { CalmWaterSurface } from "../src/sim/water/calmWater";
import { TerrainAuthority } from "../src/workers/terrainAuthority";
import { STEP } from "./support/carRig";

/**
 * The car's start (land plan, "The spawn gate"): it waits until the terrain
 * pages under and around it are resident, so it never settles on a
 * fallback level. A recovery goes through the same gate.
 */

const PAGE = WORLD_PAGE_BASE_EXTENT_METERS;
const SPACING = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;

function flatPage(): Float32Array {
  return new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE);
}

describe("terrain authority coverage", () => {
  it("covers a square only when every page its bicubic stencil reads is published", () => {
    const authority = new TerrainAuthority();
    const x = PAGE * 0.5;
    const z = PAGE * 0.5;
    expect(authority.covers(x, z, 8)).toBe(false);
    authority.publishPage(0, 0, 0, flatPage());
    expect(authority.covers(x, z, 8)).toBe(true);
    // Reaching into the next page east needs that page.
    expect(authority.covers(PAGE - 4, z, 8)).toBe(false);
    // So does a point whose stencil reaches the next page's first two columns.
    expect(authority.covers(PAGE - 2 * SPACING, z, 0)).toBe(false);
    expect(authority.covers(PAGE - 3 * SPACING, z, 0)).toBe(true);
    // And the column before the first: the stencil reads one back.
    expect(authority.covers(0.5 * SPACING, z, 0)).toBe(false);
    authority.publishPage(0, 1, 0, flatPage());
    expect(authority.covers(PAGE - 4, z, 8)).toBe(true);
    // A coarser page is no answer.
    authority.publishPage(1, 0, 1, flatPage());
    expect(authority.covers(x, PAGE + 100, 8)).toBe(false);
  });
});

describe("car spawn gate", () => {
  /** The car at (100, 40, 100), over ground that is 3 m off until its pages land and level at 0 after. */
  function gated(isReady: () => boolean): { sim: GroundVehicleSimulator; radii: number[] } {
    const sim = new GroundVehicleSimulator({
      position: { x: 100, y: 40, z: 100 },
      heading: 0,
      moored: false,
      car: { gearbox: "automatic", manualClutch: false },
    });
    const radii: number[] = [];
    const bedHeight = (): number => (isReady() ? 0 : 3);
    sim.setEnvironment({
      water: new CalmWaterSurface(-100, bedHeight),
      wind: { x: 0, y: 0, z: 0 },
      bedHeight,
      groundReady: (_x, _z, radius) => {
        radii.push(radius);
        return isReady();
      },
      world: null,
      colliders: null,
      gravity: 9.80665,
    });
    return { sim, radii };
  }

  it("holds the car still and unsimulated until its pages land, then settles on them", () => {
    let ready = false;
    const { sim, radii } = gated(() => ready);
    const start = { ...sim.state.position };
    for (let i = 0; i < 2 / STEP; i += 1) sim.step(STEP);
    const waiting = sim.visualState();
    expect(waiting.settling).toBe(true);
    expect(sim.state.position).toEqual(start);
    expect(sim.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(sim.state.time).toBeCloseTo(2, 9);
    expect(sim.wheelLoad.every((load) => load === 0)).toBe(true);
    // The square asked for holds the car: its wheels are within 2.5 m of the origin.
    expect(Math.min(...radii)).toBeGreaterThan(3);

    ready = true;
    for (let i = 0; i < 3 / STEP; i += 1) sim.step(STEP);
    expect(sim.visualState().settling).toBe(false);
    // On the published ground (level at 0), not the fallback's 3 m: about its static ride height up.
    expect(sim.state.position.y).toBeGreaterThan(0.6);
    expect(sim.state.position.y).toBeLessThan(1);
    expect(Math.abs(sim.state.position.x - 100)).toBeLessThan(0.05);
    const load = sim.wheelLoad.reduce((sum, value) => sum + value, 0);
    expect(load).toBeGreaterThan(0.9 * 2_300 * 9.80665);
  });

  it("gives up waiting after GROUND_WAIT_SECONDS and settles on whatever answers", () => {
    const { sim } = gated(() => false);
    for (let i = 0; i < (GROUND_WAIT_SECONDS - 1) / STEP; i += 1) sim.step(STEP);
    expect(sim.visualState().settling).toBe(true);
    for (let i = 0; i < 4 / STEP; i += 1) sim.step(STEP);
    expect(sim.visualState().settling).toBe(false);
    // On the fallback's 3 m.
    expect(sim.state.position.y).toBeGreaterThan(3.6);
    expect(sim.state.position.y).toBeLessThan(4);
  });

  it("takes a recovery through the gate too: it waits for the pages at its spot", () => {
    let ready = true;
    const { sim } = gated(() => ready);
    for (let i = 0; i < 3 / STEP; i += 1) sim.step(STEP);
    expect(sim.safeSpotsHeld).toBe(1);
    ready = false;
    sim.recover();
    for (let i = 0; i < 1 / STEP; i += 1) sim.step(STEP);
    expect(sim.visualState().settling).toBe(true);
    expect(sim.wheelLoad.every((load) => load === 0)).toBe(true);
    ready = true;
    for (let i = 0; i < 2 / STEP; i += 1) sim.step(STEP);
    expect(sim.visualState().settling).toBe(false);
    expect(sim.state.position.y).toBeGreaterThan(0.6);
    expect(sim.state.position.y).toBeLessThan(1);
  });
});
