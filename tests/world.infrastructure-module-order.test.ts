import { describe, expect, it, vi } from "vitest";

/**
 * The stage's two modules import each other (`infrastructure.ts` reads the
 * profile table; `infrastructureProfiles.ts` reads the capsule distance), so
 * neither may read the other at module load. The roads worker's graph meets
 * the profiles first (`roadInfrastructure.ts`); before this was pinned the
 * worker died loading, in a browser only, and no road ever streamed.
 */
describe("the infrastructure modules", () => {
  for (const entry of ["profiles", "road layout", "roads worker", "stage"] as const) {
    it(`load whichever comes first: the ${entry}`, async () => {
      vi.resetModules();
      if (entry === "roads worker") {
        const listeners: string[] = [];
        vi.stubGlobal("self", { addEventListener: (type: string) => listeners.push(type), postMessage: () => undefined });
        try {
          await import("@/src/workers/roads.worker");
        } finally {
          vi.unstubAllGlobals();
        }
        expect(listeners).toEqual(["message"]);
      } else if (entry === "profiles") {
        const profiles = await import("@/src/world/infrastructureProfiles");
        expect(profiles.INFRASTRUCTURE_PROFILES.length).toBeGreaterThan(0);
      } else if (entry === "road layout") {
        const layout = await import("@/src/world/roads/roadInfrastructure");
        expect(typeof layout.roadRegionInfrastructure).toBe("function");
      } else {
        const stage = await import("@/src/world/infrastructure");
        expect(typeof stage.infrastructureIndex).toBe("function");
      }
      const { createWorld } = await import("@/src/world/world");
      const { changeInfrastructureRegions, clearInfrastructureRegions } = await import("@/src/world/infrastructure");
      const { INFRASTRUCTURE_PROFILE } = await import("@/src/world/infrastructureProfiles");
      const world = createWorld();
      try {
        // A region in and out composes, so the stage's free-slot segment is built.
        const segment = {
          profile: INFRASTRUCTURE_PROFILE.carriageway, mode: "set" as const, priority: 1,
          ax: 0, az: 0, bx: 20, bz: 0, halfWidth: 2, reach: 4, params: [30, 30, 0, 0, 0, 0, 0], key: 1,
        };
        expect(changeInfrastructureRegions(world, [{ key: "a", segments: [segment] }])).not.toBeNull();
        expect(changeInfrastructureRegions(world, [], ["a"])).not.toBeNull();
      } finally {
        clearInfrastructureRegions();
      }
    });
  }
});
