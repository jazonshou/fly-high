import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
} from "../src/sim";
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  evolveMacroTerrain,
  toTerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainMacroEvolution";
import { terrainMacroGridFromEvolution } from "../src/render/webgpu/terrain/TerrainMacroEvolutionClient";
import {
  extractTerrainErodedCollisionCore,
  generateTerrainErodedPage,
} from "../src/render/webgpu/terrain/TerrainPageErosion";
import { buildTerrainMacroLakeField } from "../src/render/webgpu/terrain/TerrainPageHydrology";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "../src/render/webgpu/world/pageGeometry";
import {
  sampleGroundContact,
  sampleGroundHeight,
  setGroundHeightMirror,
} from "../src/sim/terrainGrid";
import { sampleTerrainMacroEvolutionInputs } from "../src/workers/terrainMacroEvolutionRuntime";
import { TerrainAuthority } from "../src/workers/terrainAuthority";
import {
  createWorld,
  type TerrainCollisionSample,
  type WorldDefinition,
} from "../src/world";

/**
 * Assertion 93 — "`analyticServed = 0` below 500 m AGL inside the domain, over
 * the sim flight profile" (Phase 5 §12.1's `sim.flight + harness` home,
 * written at Phase 6 Gate W, W-3).
 *
 * Risk R-5D recorded the hole this closes: `tests/sim.flight.test.ts` runs
 * against the ANALYTIC authority — no pages are ever published there — so a
 * green flight suite said nothing about whether the eroded ladder answers
 * every low-altitude query. Publishing a fixture plane page would not close it
 * either: the fallback counter only means something when the pages under the
 * aircraft are the ones the production erosion path actually produces.
 *
 * So this file pays for the real thing once: the canonical 1,024² macro export
 * from `evolveMacroTerrain`, and a corridor of real `generateTerrainErodedPage`
 * L0 pages published into a real `TerrainAuthority` through the same
 * `publishPage` entry point the simulation worker calls. The flight then rides
 * the same `FlightSimulator` + `src/sim/terrainGrid` wiring as
 * `src/workers/simulation.worker.ts`, in two legs, because the two legs sample
 * differently: a low cruise takes the height-only rejection path (one sample
 * per step), and a ground segment takes the full contact path (height plus the
 * four central-difference normal taps).
 *
 * What it deliberately does NOT prove:
 *   - Nothing about the GPU. The atlas-bytes half of the same invariant is
 *     assertion 91 (`tests/gpu/terrain-collision-readback.test.ts`); here the
 *     pages come from the CPU reference producer directly.
 *   - Nothing about height ACCURACY. A wrong-but-resident page serves happily.
 *     Parity is assertions 76/77's job; this one is about WHO answered.
 *   - Nothing outside the published corridor. Coverage is the harness's
 *     responsibility, and `macroServed === 0` below is what pins it: the
 *     moment the profile wanders off the published pages, the macro authority
 *     answers and this test says so instead of silently weakening.
 */

/** Corridor of real L0 pages: 4 columns downrange by 2 rows across. */
const CORRIDOR_TILES_X = [-1, 0, 1, 2] as const;
const CORRIDOR_TILES_Z = [-1, 0] as const;
const CRUISE_SECONDS = 16;
const GROUND_SECONDS = 4;
/** §1.3's regime: the authority must serve everything under this AGL. */
const AUTHORITY_AGL_CEILING_METERS = 500;

interface CorridorFixture {
  readonly world: WorldDefinition;
  readonly macro: TerrainMacroEvolutionExport;
  readonly pages: readonly { readonly x: number; readonly z: number; readonly heights: Float32Array }[];
}

let fixture: CorridorFixture;

function collisionTarget(): TerrainCollisionSample {
  return { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86 };
}

/** The simulation worker's own environment wiring, minus the worker scope. */
function corridorEnvironment(world: WorldDefinition) {
  const target = collisionTarget();
  return {
    terrain: (x: number, z: number) => sampleGroundContact(world, x, z, target),
    terrainHeight: (x: number, z: number) => sampleGroundHeight(world, x, z),
    wind: { x: 0, y: 0, z: 0 },
  };
}

function publishCorridor(authority: TerrainAuthority): void {
  for (const page of fixture.pages) {
    // A copy per authority: `publishPage` takes ownership, exactly as the
    // transferred buffer does on the worker's receiving end.
    authority.publishPage(0, page.x, page.z, page.heights.slice());
  }
}

/** `tests/sim.flight.test.ts`'s stepping helper, with the profile's damping. */
function flyFor(
  simulator: FlightSimulator,
  seconds: number,
  onStep: (agl: number) => void,
): void {
  const count = Math.round(seconds / FIXED_TIME_STEP);
  for (let index = 0; index < count; index += 1) {
    const state = simulator.state;
    const telemetry = simulator.telemetry();
    onStep(telemetry.altitudeAgl);
    simulator.step(FIXED_TIME_STEP, {
      ...DEFAULT_CONTROLS,
      // The same rate/attitude damping `sim.flight`'s procedural-runway
      // profile flies with. It keeps the leg straight and level over real
      // eroded relief without becoming an autopilot with its own opinions.
      pitch: -state.angularVelocity.z * 0.3,
      roll: -state.angularVelocity.x * 0.34 - telemetry.bank * 0.16,
    });
  }
}

beforeAll(() => {
  const world = createWorld("w3-authority-profile", {
    // No airport: the crowned runway is an analytic Class-K fast path that
    // bypasses the ladder and its counters entirely, so an airport under the
    // corridor would hide exactly the samples this assertion is about.
    airport: false,
    worldEvolution: "eroded",
  });
  const domain = EVOLUTION_DOMAIN_TEXELS;
  const inputs = sampleTerrainMacroEvolutionInputs({
    width: domain,
    height: domain,
    minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
    minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seedHash: world.seedHash,
  });
  const macro = toTerrainMacroEvolutionExport(
    evolveMacroTerrain({
      width: domain,
      height: domain,
      heights: inputs.heights,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      seaLevel: world.seaLevel,
      erodibility: inputs.erodibility,
      reposeDegrees: inputs.reposeDegrees,
    }),
    world.seaLevel,
    { worldSeed: world.seed, deviceFingerprint: "w3-node-reference" },
  );
  const lakes = buildTerrainMacroLakeField(macro);
  const pages = CORRIDOR_TILES_X.flatMap((x) => CORRIDOR_TILES_Z.map((z) => ({
    x,
    z,
    heights: extractTerrainErodedCollisionCore(
      generateTerrainErodedPage(world, macro, { level: 0, x, z }, lakes),
    ),
  })));
  fixture = { world, macro, pages };
}, 300_000);

afterEach(() => {
  setGroundHeightMirror(null);
});

describe("flight profile over the published terrain authority (5-2)", () => {
  it("assertion 93: the counter epoch starts at publishMacro", () => {
    const authority = new TerrainAuthority();
    setGroundHeightMirror(authority);

    // Spawn placement legitimately queries terrain before the asynchronous
    // macro transfer lands. Those answers ARE analytic, and counting them
    // would make assertion 93 unsatisfiable for reasons that are not bugs.
    for (let index = 0; index < 8; index += 1) {
      expect(Number.isFinite(sampleGroundHeight(fixture.world, index * 37, -index * 53))).toBe(true);
    }
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: 0,
      macroServed: 0,
      analyticServed: 8,
    });

    authority.publishMacro(terrainMacroGridFromEvolution(fixture.macro));
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: 0,
      macroServed: 0,
      analyticServed: 0,
    });
  });

  it("assertion 93: analyticServed is 0 below 500 m AGL over the flight profile", () => {
    const world = fixture.world;
    const authority = new TerrainAuthority();
    authority.publishMacro(terrainMacroGridFromEvolution(fixture.macro));
    publishCorridor(authority);
    expect(authority.publishedPageCount).toBe(fixture.pages.length);
    setGroundHeightMirror(authority);

    // Leg 1 — low cruise downrange, the height-only rejection path.
    const spawnHeight = sampleGroundHeight(world, -200, 0);
    expect(spawnHeight).toBeGreaterThan(world.seaLevel);
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: -200, y: spawnHeight + 220, z: 0 },
        heading: Math.PI / 2,
        pitch: 0,
        airspeed: 52,
      },
      controls: DEFAULT_CONTROLS,
      environment: corridorEnvironment(world),
    });
    // Spawn placement queries terrain too, and it is already inside the epoch:
    // check it before zeroing, so the reset below only splits the legs' sample
    // accounting rather than hiding an analytic answer.
    expect(authority.countersSnapshot().analyticServed).toBe(0);
    authority.resetCounters();

    let maximumAgl = 0;
    let minimumAgl = Number.POSITIVE_INFINITY;
    flyFor(simulator, CRUISE_SECONDS, (agl) => {
      maximumAgl = Math.max(maximumAgl, agl);
      minimumAgl = Math.min(minimumAgl, agl);
    });
    const cruise = authority.countersSnapshot();

    // Leg 2 — on the surface, the full contact path: height plus the four
    // central-difference taps that produce the collision normal.
    const groundX = 700;
    const groundHeight = sampleGroundHeight(world, groundX, 0);
    simulator.reset({
      onGround: true,
      terrainHeight: groundHeight,
      position: { x: groundX, y: 0, z: 0 },
      heading: Math.PI / 2,
      controls: { ...DEFAULT_CONTROLS, throttle: 0, brake: 1 },
    });
    const beforeGround = authority.countersSnapshot();
    flyFor(simulator, GROUND_SECONDS, (agl) => {
      maximumAgl = Math.max(maximumAgl, agl);
      minimumAgl = Math.min(minimumAgl, agl);
    });
    const total = authority.countersSnapshot();

    console.log(
      `assertion 93: AGL [${minimumAgl.toFixed(1)}, ${maximumAgl.toFixed(1)}] m; `
      + `cruise ${cruise.readbackServed} samples, ground `
      + `${total.readbackServed - beforeGround.readbackServed} samples; `
      + `counters ${JSON.stringify(total)}`,
    );

    // The profile is the one the assertion is about: entirely below 500 m AGL,
    // and airborne rather than parked for most of it.
    expect(maximumAgl).toBeLessThan(AUTHORITY_AGL_CEILING_METERS);
    expect(minimumAgl).toBeLessThan(20);

    // The assertion itself.
    expect(total.analyticServed).toBe(0);
    // Real pages answered, not the 512 m macro fallback. A corridor gap or a
    // ring eviction would show up here as a non-zero macro count.
    expect(total.macroServed).toBe(0);
    expect(cruise.readbackServed).toBeGreaterThan(CRUISE_SECONDS / FIXED_TIME_STEP);
    // The contact path costs five ladder samples per step; anything close to
    // one per step would mean the ground leg never left height-only rejection.
    const groundSamples = total.readbackServed - beforeGround.readbackServed;
    expect(groundSamples).toBeGreaterThan((GROUND_SECONDS / FIXED_TIME_STEP) * 5);

    // Still on the published corridor: page coverage, not luck, is why the
    // macro never answered.
    const halfCorridorZ = WORLD_PAGE_BASE_EXTENT_METERS;
    expect(simulator.state.position.x).toBeGreaterThan(
      CORRIDOR_TILES_X[0]! * WORLD_PAGE_BASE_EXTENT_METERS,
    );
    expect(simulator.state.position.x).toBeLessThan(
      (CORRIDOR_TILES_X.at(-1)! + 1) * WORLD_PAGE_BASE_EXTENT_METERS,
    );
    expect(Math.abs(simulator.state.position.z)).toBeLessThan(halfCorridorZ);
  }, 120_000);
});
