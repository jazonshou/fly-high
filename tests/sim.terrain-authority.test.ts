import { describe, expect, it } from "vitest";
import {
  createCrashRecoverySpawn,
  createSimulationSpawn,
} from "../src/game/spawn";
import { NullTerrainCollisionMirror } from "../src/render/webgpu/terrain/TerrainCollisionMirror";
import {
  FIXED_TIME_STEP,
  FlightSimulator,
  getFlightTelemetry,
} from "../src/sim";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import {
  createWorld,
  generateTerrainTile,
  getAirportInfluence,
  isPointOnRunway,
  runwayToWorld,
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
        expect(sampleGroundHeight(world, point.x, point.z)).toBe(airport.elevation);
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
      expect(contact.isRunway).toBe(true);
      expect(contact.height).toBe(airport.elevation);
      expect(contact.friction).toBeCloseTo(1.18, 12);
      expect(contact.normal).toEqual({ x: 0, y: 1, z: 0 });
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

  it("keeps render-path heights equal to physics-path heights at L0 spacing", () => {
    // The render path builds tiles through generateTerrainTile; the physics
    // path samples src/sim/terrainGrid.ts. Compare them vertex-for-vertex on
    // four tiles (4,356 samples). Today they agree exactly because both reach
    // the same kernel; at 5-2 this becomes the parity bound on the readback
    // grid — and it is written against the real tile pipeline, not a private
    // shortcut, so it fails loudly rather than vacuously if either side stops
    // being the authority.
    const world = createWorld("terrain-authority-fixture");
    for (const [tileX, tileZ] of [
      [0, 0],
      [-1, 0],
      [3, -2],
      [-4, 5],
    ] as const) {
      const tile = generateTerrainTile(world, {
        tileX,
        tileZ,
        size: 512,
        resolution: 33,
        includeNormals: false,
        includeColors: false,
        includeClimate: false,
      });
      for (let row = 0; row < tile.resolution; row += 1) {
        for (let column = 0; column < tile.resolution; column += 1) {
          const x = tile.originX + column * tile.spacing;
          const z = tile.originZ + row * tile.spacing;
          const renderHeight = tile.heights[row * tile.resolution + column];
          // Tiles store f32; the physics path is f64. Equality holds exactly
          // at the render path's declared storage precision — anything looser
          // than fround would hide real divergence.
          expect(renderHeight).toBe(Math.fround(sampleGroundHeight(world, x, z)));
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
