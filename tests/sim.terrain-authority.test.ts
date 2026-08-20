import { describe, expect, it } from "vitest";
import {
  terrainPageFilterWidthMeters,
  terrainTexelSizeMeters,
} from "../src/render/webgpu/terrain/TerrainSpineContract";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_HEIGHT_CORE } from "../src/render/webgpu/world/pageGeometry";
import {
  createCrashRecoverySpawn,
  createSimulationSpawn,
} from "../src/game/spawn";
import {
  runwayEarthworksHeightLocal,
  runwayPlatformHeight,
} from "../src/render/webgpu/terrain/RunwayEarthworks";
import { NullTerrainCollisionMirror } from "../src/render/webgpu/terrain/TerrainCollisionMirror";
import {
  FIXED_TIME_STEP,
  FlightSimulator,
  getFlightTelemetry,
} from "../src/sim";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import {
  createWorld,
  getAirportInfluence,
  isPointOnRunway,
  runwayToWorld,
  sampleNaturalTerrainHeight,
  sampleFilteredTerrainHeight,
  sampleTerrainHeight,
  worldToRunway,
  type TerrainCollisionSample,
} from "../src/world";

/**
 * §1.3 physics/render consistency contract (0-5). The invariant: the surface
 * the aircraft touches and the surface on screen are produced by the same
 * authority. Every test here passes trivially today because both paths share
 * the analytic kernel — that is the point. They must keep passing at every
 * gate from here to Phase 5, and at 5-2 they become the regression guard on
 * the readback authority.
 */

const RECOVERY_TERRAIN_RADII = [180, 420, 720] as const;

function collisionTarget(): TerrainCollisionSample {
  return { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86 };
}

describe("terrain authority contract (0-5)", () => {
  it("keeps airport influence exactly 1.0 throughout the apron", () => {
    const world = createWorld("terrain-authority-fixture");
    const airport = world.airport;
    expect(airport).not.toBeNull();
    if (!airport) return;

    // The full graded platform: paved runway plus end safety areas and
    // shoulders. Influence must be exactly 1 — not merely close — because
    // sampleTerrainCollisionHeight's runway short-circuit tests `>= 1`, and
    // spawn and tyre friction depend on that short-circuit. 3-8's earthworks
    // and 5-6's erosion mask are not allowed to break this.
    const halfAlong = airport.runwayLength * 0.5 + airport.endSafetyArea;
    const halfAcross = airport.runwayWidth * 0.5 + airport.shoulderWidth;
    for (let alongStep = -10; alongStep <= 10; alongStep += 1) {
      for (let acrossStep = -5; acrossStep <= 5; acrossStep += 1) {
        const along = (alongStep / 10) * halfAlong * 0.999;
        const across = (acrossStep / 5) * halfAcross * 0.999;
        const point = runwayToWorld(airport, along, across);
        expect(getAirportInfluence(airport, point.x, point.z)).toBe(1);
        // 3-8: the apron is a CROWNED platform now, not a plane. What must
        // still hold exactly is that the natural terrain contributes nothing
        // inside it — the collision fast path evaluates the profile and
        // nothing else.
        expect(sampleGroundHeight(world, point.x, point.z)).toBeCloseTo(
          runwayPlatformHeight(airport, across),
          9,
        );
      }
    }

    // isPointOnRunway agrees on the paved rectangle, and the contact sample
    // carries the runway's surface semantics.
    const target = collisionTarget();
    for (const [alongFactor, acrossFactor] of [
      [0, 0],
      [0.98, 0.9],
      [-0.98, -0.9],
      [0.5, -0.85],
    ] as const) {
      const point = runwayToWorld(
        airport,
        alongFactor * airport.runwayLength * 0.5,
        acrossFactor * airport.runwayWidth * 0.5,
      );
      expect(isPointOnRunway(airport, point.x, point.z)).toBe(true);
      const contact = sampleGroundContact(world, point.x, point.z, target);
      const local = worldToRunway(airport, point.x, point.z);
      expect(contact.isRunway).toBe(true);
      expect(contact.height).toBeCloseTo(runwayPlatformHeight(airport, local.across), 9);
      expect(contact.friction).toBeCloseTo(1.18, 12);
      // The camber tilts the contact normal by ~1.3 deg at the graded edge and
      // by nothing on the centreline. A flat normal on a cambered surface is
      // the same lie one derivative up.
      expect(Math.hypot(contact.normal.x, contact.normal.y, contact.normal.z)).toBeCloseTo(1, 9);
      expect(contact.normal.y).toBeGreaterThan(0.999);
      if (Math.abs(acrossFactor) < 1e-9) {
        expect(contact.normal).toEqual({ x: 0, y: 1, z: 0 });
      } else {
        expect(Math.hypot(contact.normal.x, contact.normal.z)).toBeGreaterThan(1e-4);
      }
    }
  });

  it("assertion 63: collision height inside the apron equals the earthworks profile", () => {
    // The failure this exists for: 3-8 adds a 0.35 m camber to the RENDERED
    // surface, and sampleTerrainCollision's runway branch returns before any
    // height sampling. Left alone, the aircraft would touch down on a plane up
    // to 0.35 m away from the surface on screen — worst at the edges, where a
    // crosswind landing puts you. Phase 0's four invariants would not have
    // caught it: they assert getAirportInfluence == 1.0 across the apron,
    // which stays true. The influence is fine; the height behind it is what
    // changes.
    const world = createWorld("terrain-authority-fixture");
    const airport = world.airport;
    expect(airport).not.toBeNull();
    if (!airport) return;

    const halfAlong = airport.runwayLength * 0.5 + airport.endSafetyArea;
    const halfAcross = airport.runwayWidth * 0.5 + airport.shoulderWidth;
    let worstMillimetres = 0;
    let sawCamber = false;
    for (let alongStep = -12; alongStep <= 12; alongStep += 1) {
      for (let acrossStep = -8; acrossStep <= 8; acrossStep += 1) {
        const along = (alongStep / 12) * halfAlong * 0.999;
        const across = (acrossStep / 8) * halfAcross * 0.999;
        const point = runwayToWorld(airport, along, across);
        const natural = sampleNaturalTerrainHeight(world.seedHash, point.x, point.z, 0);
        const local = worldToRunway(airport, point.x, point.z);
        // The RENDERED profile, evaluated through the same function the tile
        // generator reaches through sampleFilteredTerrainHeight.
        const rendered = runwayEarthworksHeightLocal(
          airport,
          natural,
          local.along,
          local.across,
          point.x,
          point.z,
          world.seedHash,
        );
        const collision = sampleGroundHeight(world, point.x, point.z);
        worstMillimetres = Math.max(worstMillimetres, Math.abs(rendered - collision) * 1_000);
        if (Math.abs(rendered - airport.elevation) > 0.05) sawCamber = true;
      }
    }
    expect(worstMillimetres, "collision and the rendered earthworks disagree").toBeLessThan(1);
    // Non-vacuity: if the camber were zero this test would pass on a plane.
    expect(sawCamber, "the apron is flat — the camber is not being applied").toBe(true);
  });

  it("assertion 64: the 0.5 m earthworks contour is not a closed convex curve", () => {
    // The exit criterion, stated as the plan states it. A convex contour means
    // the profile is still a disc — the circular plateau the audit names, which
    // is what a single lerp against a rounded-rectangle influence field always
    // produces. Convexity is disproved constructively: two points inside the
    // region whose midpoint is outside it.
    const world = createWorld("terrain-authority-fixture");
    const airport = world.airport;
    expect(airport).not.toBeNull();
    if (!airport) return;

    const reach = airport.runwayLength * 0.5 + airport.endSafetyArea
      + airport.terrainBlendDistance * 1.6;
    const step = 24;
    const displacement = (x: number, z: number): number => Math.abs(
      sampleTerrainHeight(world, x, z) - sampleNaturalTerrainHeight(world.seedHash, x, z, 0),
    );
    const inside = (x: number, z: number): boolean => displacement(x, z) >= 0.5;

    const points: { x: number; z: number }[] = [];
    for (let along = -reach; along <= reach; along += step) {
      for (let across = -reach; across <= reach; across += step) {
        const point = runwayToWorld(airport, along, across);
        if (inside(point.x, point.z)) points.push({ x: point.x, z: point.z });
      }
    }
    expect(points.length, "nothing is displaced by 0.5 m — the probe is vacuous")
      .toBeGreaterThan(200);

    let witnesses = 0;
    for (let first = 0; first < points.length && witnesses < 3; first += 7) {
      for (let second = first + 1; second < points.length && witnesses < 3; second += 11) {
        const a = points[first]!;
        const b = points[second]!;
        if (Math.hypot(a.x - b.x, a.z - b.z) < step * 2) continue;
        if (!inside((a.x + b.x) / 2, (a.z + b.z) / 2)) witnesses += 1;
      }
    }
    expect(
      witnesses,
      "every chord of the 0.5 m contour stayed inside it — the earthworks is still a disc",
    ).toBeGreaterThanOrEqual(1);
  });

  it("adds no cliff the natural terrain does not already have", () => {
    // 3-8 shapes the ground the aircraft lands on, so a discontinuity in the
    // profile is a discontinuity in the collision surface. One nearly shipped:
    // cut and fill differ by more than their batter grade — the bench term is
    // +bench for one and −bench for the other — so branching on
    // `natural < platform` put a 2 x bench step on the closed contour where
    // the two meet. A RING of 1.09 m cliffs around the airport, measured over
    // 0.25 m of ground on three seeds, in both the render and the physics
    // path. The blend that replaced the branch is what this pins.
    //
    // Stated relatively, because the absolute number is a property of the
    // terrain: the earthworks may not be materially steeper than the natural
    // surface it is grafted onto.
    for (const seed of ["terrain-authority-fixture", "open-skies"]) {
      const world = createWorld(seed);
      const airport = world.airport;
      expect(airport).not.toBeNull();
      if (!airport) continue;
      const step = 0.25;
      let worstEarthworks = 0;
      let worstNatural = 0;
      let worstWhere = "";
      for (let ray = 0; ray < 24; ray += 1) {
        const angle = (ray / 24) * Math.PI * 2;
        const alongEdge = airport.runwayLength * 0.5 + airport.endSafetyArea;
        const acrossEdge = airport.runwayWidth * 0.5 + airport.shoulderWidth;
        for (let out = 0; out < airport.terrainBlendDistance * 1.2; out += step) {
          const along = Math.cos(angle) * (alongEdge + out);
          const across = Math.sin(angle) * (acrossEdge + out);
          const here = runwayToWorld(airport, along, across);
          const next = runwayToWorld(
            airport,
            along + Math.cos(angle) * step,
            across + Math.sin(angle) * step,
          );
          const graded = Math.abs(
            sampleGroundHeight(world, next.x, next.z) - sampleGroundHeight(world, here.x, here.z),
          );
          const natural = Math.abs(
            sampleNaturalTerrainHeight(world.seedHash, next.x, next.z, 0)
            - sampleNaturalTerrainHeight(world.seedHash, here.x, here.z, 0),
          );
          if (graded > worstEarthworks) {
            worstEarthworks = graded;
            worstWhere = `${out.toFixed(1)} m outside the platform`;
          }
          worstNatural = Math.max(worstNatural, natural);
        }
      }
      // Non-vacuity: the sweep must actually cross real relief.
      expect(worstNatural, `${seed}: the sweep found flat ground`).toBeGreaterThan(0.02);
      expect(
        worstEarthworks,
        `${seed}: the earthworks steps ${worstEarthworks.toFixed(3)} m over ${step} m `
        + `(${worstWhere}) against the natural surface's ${worstNatural.toFixed(3)} m`,
      ).toBeLessThan(Math.max(worstNatural * 1.6, 0.2));
    }
  });

  it("never lets ground clearance go negative over a real-terrain flight profile", () => {
    const world = createWorld("terrain-authority-fixture");
    const target = collisionTarget();
    const environment = {
      terrain: (x: number, z: number) => sampleGroundContact(world, x, z, target),
      terrainHeight: (x: number, z: number) => sampleGroundHeight(world, x, z),
    };
    const spawn = createSimulationSpawn(world, "airborne", 250);
    const simulator = new FlightSimulator({ spawn, environment });

    // Straight flight, then a gentle descent-and-climb, always over the real
    // kernel. Clearance is computed from raw state against the authority —
    // telemetry clamps AGL to zero and zeroes it after a crash, so asserting
    // on telemetry alone could pass vacuously while the aircraft tunnels.
    let minimumRawAgl = Number.POSITIVE_INFINITY;
    const script = [
      { seconds: 8, controls: {} },
      { seconds: 8, controls: { pitch: -0.08 } },
      { seconds: 10, controls: { pitch: 0.12, throttle: 0.85 } },
    ];
    for (const phase of script) {
      simulator.setControls(phase.controls);
      const steps = Math.round(phase.seconds / FIXED_TIME_STEP);
      for (let step = 0; step < steps; step += 1) {
        simulator.step(FIXED_TIME_STEP);
        const telemetry = getFlightTelemetry(
          simulator.state,
          simulator.environment,
          simulator.aircraft,
        );
        expect(Number.isFinite(telemetry.altitudeAgl)).toBe(true);
        const rawAgl = simulator.state.position.y
          - sampleGroundHeight(world, simulator.state.position.x, simulator.state.position.z);
        minimumRawAgl = Math.min(minimumRawAgl, rawAgl);
      }
    }
    expect(simulator.state.crashed).toBe(false);
    expect(minimumRawAgl).toBeGreaterThan(0);
  });

  // Assertion 77 — the Node-side half of the §1.3 invariant, rewritten at
  // `4-9`.
  //
  // Its old form compared `generateTerrainTile` against `sampleGroundHeight`.
  // `4-4` deleted that function's last production consumer and `4-9` deleted
  // the function, so the old test would have compared the physics kernel
  // against a TypeScript function nothing renders — and KEPT PASSING. The
  // render path is now a WGSL kernel over page atlases, so this half asserts
  // the property that makes the GPU half meaningful: at L0 the render page's
  // band-limit width is exactly zero, so the render kernel and the physics
  // kernel are the same function, evaluated at the same points.
  //
  // Its GPU sibling is `tests/gpu/terrain-physics-parity.test.ts`, which reads
  // the real atlas back. Duplicated rather than moved: `npm run verify` does
  // not run the GPU project, so a move would delete the invariant from CI.
  it("assertion 77: the render kernel at L0 IS the physics kernel", () => {
    const world = createWorld("terrain-authority-fixture");
    // 4-0's rule, as a property rather than a comment: L0 pages bake at width
    // zero, which is what makes them bit-identical to physics by construction
    // rather than by floating-point luck.
    expect(terrainPageFilterWidthMeters(0)).toBe(0);
    expect(terrainPageFilterWidthMeters(1)).toBeGreaterThan(0);

    for (const [pageX, pageZ] of [[0, 0], [-1, 0], [3, -2], [-4, 5]] as const) {
      const originX = pageX * WORLD_PAGE_BASE_EXTENT_METERS;
      const originZ = pageZ * WORLD_PAGE_BASE_EXTENT_METERS;
      const spacing = terrainTexelSizeMeters(0);
      // Every 8th L0 texel of the page core: 1,024 comparisons per page is
      // dense enough to catch a systematic offset and fast enough to stay in
      // the Node suite, where this invariant has to live.
      for (let row = 0; row < WORLD_PAGE_HEIGHT_CORE; row += 8) {
        for (let column = 0; column < WORLD_PAGE_HEIGHT_CORE; column += 8) {
          const x = originX + column * spacing;
          const z = originZ + row * spacing;
          const render = sampleFilteredTerrainHeight(
            world,
            x,
            z,
            terrainPageFilterWidthMeters(0),
          );
          expect(render).toBe(sampleGroundHeight(world, x, z));
        }
      }
    }
  });

  it("serves the crash-recovery ring entirely from the active authority", () => {
    // §1.3's named hole: recovery samples a ring of radii around an arbitrary
    // crash point, routinely outside the 5×5 L0 page ring that 5-2 will keep
    // resident. Without full coverage, recovery can place the aircraft below
    // visible terrain. Assert the recovery altitude clears the authority's
    // height at the crash point and at every ring sample.
    const world = createWorld("terrain-authority-fixture");
    const crashPoints = [
      [4_812.5, -9_310.25],
      [-27_450, 13_082],
      [61_004, 58_991.5],
    ] as const;
    for (const [crashX, crashZ] of crashPoints) {
      const spawn = createCrashRecoverySpawn(world, crashX, crashZ, 1.25, 250);
      expect(spawn.position?.x).toBe(crashX);
      expect(spawn.position?.z).toBe(crashZ);
      let ringMaximum = Math.max(world.seaLevel, sampleGroundHeight(world, crashX, crashZ));
      for (const radius of RECOVERY_TERRAIN_RADII) {
        for (let direction = 0; direction < 8; direction += 1) {
          const angle = (direction * Math.PI) / 4;
          ringMaximum = Math.max(
            ringMaximum,
            sampleGroundHeight(
              world,
              crashX + Math.cos(angle) * radius,
              crashZ + Math.sin(angle) * radius,
            ),
          );
        }
      }
      const y = spawn.position?.y ?? Number.NEGATIVE_INFINITY;
      // Recovery must clear the worst ring terrain, by a plausible margin for
      // the requested 250 m AGL plus gear geometry.
      expect(y).toBeGreaterThan(ringMaximum);
      expect(y - ringMaximum).toBeGreaterThan(200);
      expect(y - ringMaximum).toBeLessThan(400);
    }

    // The render side has nothing to mirror yet, so nothing may ever be
    // reported as served-by-fallback.
    expect(new NullTerrainCollisionMirror().fallbackSampleCount).toBe(0);
  });
});
