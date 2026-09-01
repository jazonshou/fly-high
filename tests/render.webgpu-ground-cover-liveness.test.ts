import { describe, expect, it } from "vitest";

import {
  buildPresentationChunk,
  type DetailPresentationBuildCatalog,
  type DetailPresentationBuildInput,
} from "../src/render/webgpu/detail/presentationBuild";
import { GROUND_COVER_ARCHETYPES } from "../src/render/webgpu/detail/densityField";
import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import type {
  GeneratedDetailCell,
  GroundCoverArchetype,
} from "../src/render/webgpu/detail/types";

/**
 * **Which ground-cover path is LIVE — the question no other guard asks.**
 *
 * The winding guard enumerates every ground-cover archetype and the two-sided
 * coverage scan proves the at-risk material set is derived rather than listed.
 * Both are about whether a builder is *covered*. **Neither asks whether the
 * geometry it covers is ever DRAWN**, and that is exactly how the near-black
 * blades survived: `presentationBuild` retires the grass CARD archetype
 * globally the moment the blade field is live, so a guard testing
 * `buildGrassPatchPrototype` was testing geometry no capture draws — green,
 * and blind to the grass every capture does draw.
 *
 * **The rule this file enforces: a guard's subject must be reachable in the
 * shipping configuration.** It is the configuration-time sibling of the
 * admission-gated rule — there a correct producer is starved by a runtime
 * meter, here correct geometry is retired by a build-time switch. Same failure,
 * different arrival route, and the check differs: for admission you drive the
 * real pump under competition; for configuration you assert reachability.
 *
 * **This is a BEHAVIOURAL test, not a source scan.** It drives the real
 * builder and counts what it emits per archetype, so a change to the
 * retirement conditions moves these numbers rather than sliding past a regex.
 *
 * **The shipping configuration is blades-active.** `WorldDetailRuntime` sets
 * `groundCoverBladesActive` from `supportComputeShaders`, and the renderer
 * requires a WebGPU adapter — so on every machine that can run the game at
 * all, the blade field is live and the grass cards are retired. There is no
 * shipping configuration in which the grass card path draws.
 */

const CELL_SIZE = 64;
const GRID = 8;

/** Ground cover only: no trees, rocks, shrubs or clutter to confound the counts. */
function groundCoverOnlyCell(archetype: GroundCoverArchetype): GeneratedDetailCell {
  return {
    key: "0:0",
    cellX: 0,
    cellZ: 0,
    cellSizeMeters: CELL_SIZE,
    minX: 0,
    minZ: 0,
    maxX: CELL_SIZE,
    maxZ: CELL_SIZE,
    trees: [],
    rocks: [],
    shrubs: [],
    clutter: [],
    wildlife: [],
    groundCover: Array.from({ length: GRID * GRID }, () => ({
      coverage: 1,
      archetype,
      color: [0.31, 0.48, 0.22] as const,
      heightMeters: 0,
    })),
  } as unknown as GeneratedDetailCell;
}

function catalog(): DetailPresentationBuildCatalog {
  const prototypes: Record<string, { boundKernel: readonly number[] }> = {};
  for (const archetype of GROUND_COVER_ARCHETYPES) {
    prototypes[`ground-${archetype}`] = { boundKernel: [1, 1, 1, 1, 1, 1] };
  }
  return {
    prototypes,
    impostors: {},
    trees: {},
    shrubs: {},
    groundCoverGrid: GRID,
    useImpostors: false,
  } as unknown as DetailPresentationBuildCatalog;
}

/** Count emitted instances per prototype key, driving the real builder. */
function emittedFor(
  archetype: GroundCoverArchetype,
  options: { bladesActive: boolean; fieldRadiusMeters: number; observerX: number },
): number {
  const cell = groundCoverOnlyCell(archetype);
  const input: DetailPresentationBuildInput = {
    residents: [
      {
        cell,
        treeCanopyRank: new Float32Array(0),
        lod: { band: "near", fade: 1 } as never,
        distance: 0,
      },
    ],
    floatingOrigin: { x: 0, z: 0 } as never,
    densityLaw: RENDERED_DENSITY_LAWS[1]!,
    treeVariantCap: 3,
    treePrototypeMode: "species",
    grassRadiusMeters: 150,
    groundCoverBladesActive: options.bladesActive,
    groundCoverFieldRadiusMeters: options.fieldRadiusMeters,
    observerX: options.observerX,
    observerZ: 0,
  };
  let emitted = 0;
  const iterator = buildPresentationChunk(input, catalog(), {
    appendInstance: (key) => {
      if (key === `ground-${archetype}`) emitted += 1;
    },
  });
  while (!iterator.next().done) {
    // Drain: the builder yields work units.
  }
  return emitted;
}

describe("ground-cover card liveness — which path actually draws", () => {
  /**
   * The defect this file exists for. If this ever passes with a non-zero count,
   * the grass card path has come back and a guard testing it would again be
   * testing live code — which would be fine, and would mean this file's
   * premise needs revisiting rather than that something broke.
   */
  it("draws NO grass cards in the shipping configuration", () => {
    const emitted = emittedFor("grass", {
      bladesActive: true,
      fieldRadiusMeters: 0, // even with the field at zero radius, grass is global
      observerX: 0,
    });
    expect(
      emitted,
      "grass cards emitted while the blade field is live. `presentationBuild` "
        + "retires them globally, so this should be unreachable — if it is now "
        + "reachable, the winding/coverage guards' grass cases changed meaning.",
    ).toBe(0);
  });

  it("DOES draw grass cards when the blade field is absent, so the count is not vacuously zero", () => {
    // Without this, the assertion above would pass on a broken fixture that
    // emits nothing for any reason at all.
    const emitted = emittedFor("grass", {
      bladesActive: false,
      fieldRadiusMeters: 0,
      observerX: 0,
    });
    expect(
      emitted,
      "the fixture emits no grass cards even with the blade field off — the "
        + "zero above would then prove nothing.",
    ).toBeGreaterThan(0);
  });

  /**
   * The asymmetry that makes "ground cover" the wrong unit of reasoning: grass
   * retires globally, the others retire only INSIDE the field radius and still
   * own everything beyond it. So testing a fern card is meaningful and testing
   * a grass card is not, and nothing but this says so.
   */
  it.each(["fern", "heather", "reed"] as const)(
    "still draws %s cards beyond the field radius, so their builders are live",
    (archetype) => {
      const outside = emittedFor(archetype, {
        bladesActive: true,
        fieldRadiusMeters: 8, // the cell sits beyond this
        observerX: 0,
      });
      expect(
        outside,
        `${archetype} cards are unreachable beyond the field radius — if that is `
          + "now true, they have joined grass and their guard cases test dead code.",
      ).toBeGreaterThan(0);
    },
  );

  it.each(["fern", "heather", "reed"] as const)(
    "retires %s cards inside the field radius",
    (archetype) => {
      const inside = emittedFor(archetype, {
        bladesActive: true,
        fieldRadiusMeters: 10_000, // swallows the whole cell
        observerX: 0,
      });
      expect(inside).toBe(0);
    },
  );

  it("covers every archetype the density field can produce", () => {
    // If a sixth archetype is added, this file must decide whether its card
    // path is live rather than silently omitting it.
    expect(new Set(GROUND_COVER_ARCHETYPES)).toEqual(
      new Set(["grass", "fern", "heather", "reed", "clutter"]),
    );
  });
});
