import { afterEach, describe, expect, it } from "vitest";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_HEIGHT_CORE,
} from "../src/render/webgpu/world/pageGeometry";
import {
  sampleGroundContact,
  sampleGroundHeight,
  setGroundHeightMirror,
} from "../src/sim/terrainGrid";
import {
  TerrainAuthority,
  TERRAIN_READBACK_RING_CAPACITY,
} from "../src/workers/terrainAuthority";
import {
  createWorld,
  runwayToWorld,
  sampleTerrainCollision,
  type TerrainCollisionSample,
} from "../src/world";

const PAGE_SPACING = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;

afterEach(() => {
  setGroundHeightMirror(null);
});

function planePage(
  tileX: number,
  tileZ: number,
  slopeX: number,
  slopeZ: number,
  intercept: number,
): Float32Array {
  const heights = new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE);
  for (let row = 0; row < WORLD_PAGE_HEIGHT_CORE; row += 1) {
    const z = (tileZ * WORLD_PAGE_HEIGHT_CORE + row) * PAGE_SPACING;
    for (let column = 0; column < WORLD_PAGE_HEIGHT_CORE; column += 1) {
      const x = (tileX * WORLD_PAGE_HEIGHT_CORE + column) * PAGE_SPACING;
      heights[row * WORLD_PAGE_HEIGHT_CORE + column] = intercept + slopeX * x + slopeZ * z;
    }
  }
  return heights;
}

function collisionTarget(): TerrainCollisionSample {
  return { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86 };
}

describe("worker terrain authority (5-2)", () => {
  it("assertion 92: Catmull-Rom is C1 across an L0 page boundary", () => {
    const authority = new TerrainAuthority();
    // Exactly representable slopes make this a sensitive kink test rather
    // than a floating-point tolerance test.
    authority.publishPage(0, 0, 0, planePage(0, 0, 0.25, 0.125, 10));
    authority.publishPage(0, 1, 0, planePage(1, 0, 0.25, 0.125, 10));

    const boundary = WORLD_PAGE_BASE_EXTENT_METERS;
    const z = 200;
    const epsilon = 0.25;
    const left = authority.sampleHeight(boundary - epsilon, z)!;
    const center = authority.sampleHeight(boundary, z)!;
    const right = authority.sampleHeight(boundary + epsilon, z)!;
    const leftDerivative = (center - left) / epsilon;
    const rightDerivative = (right - center) / epsilon;

    expect(center).toBe(10 + 0.25 * boundary + 0.125 * z);
    expect(leftDerivative).toBeCloseTo(0.25, 10);
    expect(rightDerivative).toBeCloseTo(0.25, 10);
    expect(Math.abs(leftDerivative - rightDerivative)).toBeLessThan(1e-9);
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: 3,
      macroServed: 0,
      analyticServed: 0,
    });
  });

  it("uses page, macro, then analytic and never clamps an incomplete page edge", () => {
    const authority = new TerrainAuthority();
    authority.publishPage(0, 0, 0, planePage(0, 0, 0, 0, 100));
    authority.publishMacro({
      originX: -1_024,
      originZ: -1_024,
      texelSizeMeters: 512,
      width: 5,
      height: 5,
      heights: new Float32Array(25).fill(50),
    });

    expect(authority.sampleHeight(100, 100)).toBe(100);
    // Catmull needs samples from tile 1 here. With that page absent, macro is
    // the correct lower authority; clamping tile 0 would manufacture a seam.
    expect(authority.sampleHeight(WORLD_PAGE_BASE_EXTENT_METERS - 0.25, 100)).toBe(50);
    expect(authority.sampleHeight(10_000, 10_000)).toBeNull();
    authority.recordAnalyticSample();
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: 1,
      macroServed: 1,
      analyticServed: 1,
    });
  });

  it("bilinearly samples the macro grid and bounds the L0 ring", () => {
    const authority = new TerrainAuthority();
    authority.publishMacro({
      originX: -10,
      originZ: -10,
      texelSizeMeters: 10,
      width: 3,
      height: 3,
      heights: Float32Array.from([
        0, 2, 4,
        3, 5, 7,
        6, 8, 10,
      ]),
    });
    expect(authority.sampleHeight(-5, 5)).toBeCloseTo(5.5, 12);

    const page = new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE);
    for (let tileX = 0; tileX < TERRAIN_READBACK_RING_CAPACITY + 8; tileX += 1) {
      authority.publishPage(0, tileX, 0, page);
    }
    expect(authority.publishedPageCount).toBe(TERRAIN_READBACK_RING_CAPACITY);
    // The newest page remains addressable; the oldest has been evicted.
    expect(authority.sampleHeight(
      (TERRAIN_READBACK_RING_CAPACITY + 7) * WORLD_PAGE_BASE_EXTENT_METERS + 100,
      100,
    )).toBe(0);
  });

  it("blends the cell-centred macro authority continuously to analytic terrain at its rim", () => {
    const authority = new TerrainAuthority();
    authority.publishMacro({
      originX: 0,
      originZ: 0,
      texelSizeMeters: 10,
      width: 5,
      height: 5,
      heights: new Float32Array(25).fill(20),
      analyticBlendTexels: 1,
    });
    // Grid sample 0 is centred at x=0, so the outer edge is x=-5.
    expect(authority.sampleHeight(-5, 20, 100)).toBe(100);
    expect(authority.sampleHeight(0, 20, 100)).toBe(60);
    expect(authority.sampleHeight(5, 20, 100)).toBe(20);
    expect(authority.sampleHeight(20, 20, 100)).toBe(20);
    expect(authority.sampleHeight(-5.001, 20, 100)).toBeNull();
    expect(authority.countersSnapshot().macroServed).toBe(4);
  });

  it("uses the ladder for full contact height and normal", () => {
    const world = createWorld("terrain-authority-eroded-contact", { airport: false });
    const authority = new TerrainAuthority();
    const slopeX = 0.125;
    const slopeZ = -0.25;
    authority.publishPage(0, 0, 0, planePage(0, 0, slopeX, slopeZ, 120));
    setGroundHeightMirror(authority);

    const contact = sampleGroundContact(world, 100, 100, collisionTarget());
    const inverseLength = 1 / Math.hypot(slopeX, 1, slopeZ);
    expect(contact.height).toBeCloseTo(120 + slopeX * 100 + slopeZ * 100, 8);
    expect(contact.normal.x).toBeCloseTo(-slopeX * inverseLength, 8);
    expect(contact.normal.y).toBeCloseTo(inverseLength, 8);
    expect(contact.normal.z).toBeCloseTo(-slopeZ * inverseLength, 8);
    expect(contact.isRunway).toBe(false);
    expect(contact.friction).toBe(0.86);
    // Height plus the four central-difference taps.
    expect(authority.countersSnapshot().readbackServed).toBe(5);
  });

  it("preserves the crowned runway fast path and bypasses ladder counters", () => {
    const world = createWorld("terrain-authority-fixture");
    const airport = world.airport;
    expect(airport).not.toBeNull();
    if (!airport) return;
    const point = runwayToWorld(airport, 0, airport.runwayWidth * 0.32);
    const authority = new TerrainAuthority();
    authority.publishMacro({
      originX: point.x - 10,
      originZ: point.z - 10,
      texelSizeMeters: 10,
      width: 3,
      height: 3,
      heights: new Float32Array(9).fill(9_999),
    });
    setGroundHeightMirror(authority);

    const expected = sampleTerrainCollision(world, point.x, point.z, collisionTarget());
    const actual = sampleGroundContact(world, point.x, point.z, collisionTarget());
    expect(sampleGroundHeight(world, point.x, point.z)).toBe(expected.height);
    expect(actual).toEqual(expected);
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: 0,
      macroServed: 0,
      analyticServed: 0,
    });
  });

  it("counts terrainGrid's analytic last resort", () => {
    const world = createWorld("terrain-authority-analytic-fallback", { airport: false });
    const authority = new TerrainAuthority();
    setGroundHeightMirror(authority);
    const height = sampleGroundHeight(world, 18_000, -24_000);
    expect(Number.isFinite(height)).toBe(true);
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: 0,
      macroServed: 0,
      analyticServed: 1,
    });

    // Pre-load spawn queries are legitimate analytic answers. The eager
    // macro publication begins the observable, fully provisioned epoch.
    authority.publishMacro({
      originX: -256,
      originZ: -256,
      texelSizeMeters: 512,
      width: 2,
      height: 2,
      heights: new Float32Array(4),
    });
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: 0,
      macroServed: 0,
      analyticServed: 0,
    });
  });
});
