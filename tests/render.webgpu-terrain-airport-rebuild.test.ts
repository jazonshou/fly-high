import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  terrainAirportReaches,
  terrainPageInAirportReach,
} from "@/src/render/webgpu/terrain/AirportReach";
import {
  AIRPORT_INVALIDATION_SLOTS_PER_FRAME,
  TerrainClipmapSystem,
  type TerrainComputeFactory,
} from "@/src/render/webgpu/terrain/TerrainClipmapSystem";
import type { TerrainAtlasSlot } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "@/src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import { oraclePageReached, pageKeyOf, twoAirportWorld } from "./support/twoAirportWorld";

/**
 * `TerrainClipmapSystem.setAirports`: an airport spawning (or retiring)
 * invalidates exactly the resident pages its footprint meets, at every level,
 * and they are rebuilt IN PLACE through the existing pumps and meter — never
 * inside `setAirports`, never by eviction. End to end on fake producers.
 */

// ---------------------------------------------------------------------------
// The clipmap: invalidation picks exactly the pages a new footprint meets, and
// the rebuild runs in place through the existing pumps.
// ---------------------------------------------------------------------------

interface RecordedDispatch {
  readonly frame: number;
  readonly key: string;
  readonly inPlace: boolean;
}

function airportComputeFactory(clock: { frame: number }) {
  const heights: RecordedDispatch[] = [];
  const channels: RecordedDispatch[] = [];
  const generatorAirports: number[] = [];
  const splatAirports: number[] = [];
  const state = { builds: 0 };
  const factory: TerrainComputeFactory = ({ heightAtlas, existingPyramid }) => {
    state.builds += 1;
    return {
      pageGenerator: {
        generate: async (slots: readonly TerrainAtlasSlot[]) => {
          for (const slot of slots) {
            heights.push({
              frame: clock.frame,
              key: pageKeyOf(slot.address),
              inPlace: slot.lifecycle.state === "resident",
            });
            // The real producer marks every slot it dispatched.
            slot.generationSubmitted = true;
          }
          await Promise.resolve();
          for (const slot of slots) {
            if (!slot.token) continue;
            heightAtlas.residency.complete(slot.key, slot.token, {
              minHeightMeters: 0,
              maxHeightMeters: 100,
              maxDeviationFromParent: 4,
            });
          }
        },
        setAirports: (airports) => {
          generatorAirports.push(airports.length);
        },
        consumeMeasuredDispatchCostMs: () => null,
        dispose: () => undefined,
      },
      occlusionBake: {
        bake: async (slots: readonly TerrainAtlasSlot[]) => {
          for (const slot of slots) {
            channels.push({ frame: clock.frame, key: pageKeyOf(slot.address), inPlace: slot.token === null });
          }
          return slots;
        },
        consumeMeasuredDispatchCostMs: () => null,
        dispose: () => undefined,
      },
      splatBake: {
        bake: async (slots: readonly TerrainAtlasSlot[]) => slots,
        setAirports: (airports) => {
          splatAirports.push(airports.length);
        },
        consumeMeasuredDispatchCostMs: () => null,
        dispose: () => undefined,
      },
      pyramid: existingPyramid ?? {
        recenter: async () => undefined,
        isResident: true,
        dispose: () => undefined,
      },
    };
  };
  return {
    factory,
    heights,
    channels,
    generatorAirports,
    splatAirports,
    get builds() {
      return state.builds;
    },
  };
}

async function pumpFrames(
  system: TerrainClipmapSystem,
  clock: { frame: number },
  count: number,
  observer: { x: number; y: number; z: number; velocityX: number; velocityZ: number },
): Promise<void> {
  for (let step = 0; step < count; step += 1) {
    clock.frame += 1;
    system.update(observer, clock.frame);
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
  }
}

function recordedHeightPages(system: TerrainClipmapSystem): TerrainAtlasSlot[] {
  return system.atlases.height.residency.entries.filter(
    (slot) => slot.lifecycle.state === "resident"
      || (slot.lifecycle.state === "generating" && slot.generationSubmitted),
  );
}

function levelHistogram(keys: Iterable<string>): Record<number, number> {
  const histogram: Record<number, number> = {};
  for (const key of keys) {
    const level = Number(key.split(":")[0]);
    histogram[level] = (histogram[level] ?? 0) + 1;
  }
  return histogram;
}

/** Pump until setAirports' backlog is empty; returns the frames its scan ran in. */
async function drain(
  system: TerrainClipmapSystem,
  clock: { frame: number },
  observer: { x: number; y: number; z: number; velocityX: number; velocityZ: number },
): Promise<number> {
  let scanFrames = 0;
  for (let step = 0; step < 200; step += 1) {
    if (system.airportRebuildBacklog.changesBeingScanned > 0) scanFrames += 1;
    await pumpFrames(system, clock, 1, observer);
    const backlog = system.airportRebuildBacklog;
    if (
      backlog.changesBeingScanned + backlog.heightPagesOwed
        + backlog.heightPagesInFlight + backlog.channelPagesOwed === 0
    ) {
      return scanFrames;
    }
  }
  throw new Error("the airport rebuild never drained");
}

describe("TerrainClipmapSystem.setAirports", () => {
  it("invalidates exactly the pages the spawned footprint meets, then rebuilds them in place", async () => {
    const { world, home, spawned, origin } = twoAirportWorld();
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const clock = { frame: 0 };
    const recording = airportComputeFactory(clock);
    const system = new TerrainClipmapSystem(
      scene, world, resolveWebGpuQualityProfile("medium", "balanced"), { computeFactory: recording.factory },
    );
    // Where the aircraft is when the network spawns this airport: at the
    // search origin, 5-9 km short of it.
    const observer = { x: origin.x, y: 400, z: origin.z, velocityX: 60, velocityZ: 0 };
    try {
      await pumpFrames(system, clock, 80, observer);
      const buildsBefore = recording.builds;
      expect(recording.generatorAirports.at(-1)).toBe(1);
      const residentHeightKeys = new Set(
        system.atlases.height.residency.entries
          .filter((slot) => slot.lifecycle.state === "resident")
          .map((slot) => pageKeyOf(slot.address)),
      );
      expect(residentHeightKeys.size).toBeGreaterThan(20);
      const heightCandidates = recordedHeightPages(system);
      const channelCandidates = system.atlases.channel.residency.entries.filter(
        (slot) => slot.lifecycle.state === "resident" || slot.lifecycle.state === "generating",
      );
      const channelResidentKeys = new Set(
        channelCandidates.filter((slot) => slot.lifecycle.state === "resident").map((slot) => pageKeyOf(slot.address)),
      );

      // ---- the spawn ----------------------------------------------------
      const dispatchesBefore = recording.heights.length;
      const scanSlots = system.atlases.height.residency.entries.length
        + system.atlases.channel.residency.entries.length;
      const started = performance.now();
      system.setAirports([home, spawned]);
      const spawnCallMs = performance.now() - started;
      // Uniform writes and a queued change: no producer rebuilt, nothing
      // scanned, marked or dispatched inside the call.
      expect(recording.builds).toBe(buildsBefore);
      expect(recording.generatorAirports.at(-1)).toBe(2);
      expect(recording.splatAirports.at(-1)).toBe(2);
      expect(recording.heights.length).toBe(dispatchesBefore);
      expect(system.airportRebuildBacklog).toEqual({
        changesBeingScanned: 1, heightPagesOwed: 0, heightPagesInFlight: 0, channelPagesOwed: 0,
      });
      // The 2 ms main-thread bound, with room for a loaded CI machine.
      expect(spawnCallMs).toBeLessThan(10);

      // ---- the rebuild ---------------------------------------------------
      const spawnFrame = clock.frame;
      const scanFrames = await drain(system, clock, observer);
      // The scan is spread: never more than its per-frame share of slots.
      expect(scanFrames).toBeGreaterThanOrEqual(Math.ceil(scanSlots / AIRPORT_INVALIDATION_SLOTS_PER_FRAME));

      // What was marked is what was rebuilt in place: every marked height page
      // regenerates exactly once (a page whose first generation was in flight
      // at the change becomes resident first, then regenerates).
      const regenerated = recording.heights.filter((dispatch) => dispatch.frame > spawnFrame && dispatch.inPlace);
      const regeneratedKeys = regenerated.map((dispatch) => dispatch.key);
      expect(new Set(regeneratedKeys).size).toBe(regeneratedKeys.length);
      const markedHeight = new Set(regeneratedKeys);

      // EXACTLY the pages the footprint meets, by the independent oracle.
      let ambiguous = 0;
      const check = (slots: readonly TerrainAtlasSlot[], marked: (key: string) => boolean): void => {
        for (const slot of slots) {
          const key = pageKeyOf(slot.address);
          const expected = oraclePageReached(slot.address, spawned);
          if (expected === null) {
            ambiguous += 1;
            continue;
          }
          expect(marked(key), `page ${key}`).toBe(expected);
          // The production rule agrees with the oracle where it is decided.
          expect(terrainPageInAirportReach(slot.address, terrainAirportReaches(spawned))).toBe(expected);
        }
      };
      check(heightCandidates, (key) => markedHeight.has(key));
      expect(ambiguous).toBeLessThanOrEqual(2);
      const candidateKeys = new Set(heightCandidates.map((slot) => pageKeyOf(slot.address)));
      for (const key of markedHeight) expect(candidateKeys.has(key)).toBe(true);
      expect(markedHeight.size).toBeGreaterThan(0);
      // The home field's ground, and every page between, is untouched.
      expect(markedHeight.size).toBeLessThan(residentHeightKeys.size / 2);
      const homePage = createWorldPageAddress(
        0, Math.floor(home.centerX / WORLD_PAGE_BASE_EXTENT_METERS), Math.floor(home.centerZ / WORLD_PAGE_BASE_EXTENT_METERS),
      );
      expect(markedHeight.has(pageKeyOf(homePage))).toBe(false);

      // Never evicted: every page that was rebuilt is still resident.
      const residentAfter = new Set(
        system.atlases.height.residency.entries
          .filter((slot) => slot.lifecycle.state === "resident")
          .map((slot) => pageKeyOf(slot.address)),
      );
      for (const key of markedHeight) expect(residentAfter.has(key), `height ${key} evicted`).toBe(true);
      const frames = new Set(regenerated.map((dispatch) => dispatch.frame));
      expect(Math.min(...frames)).toBeGreaterThan(spawnFrame);

      // Channel pages re-bake in place — every resident one the footprint
      // meets, none it does not — each AFTER its height page's regeneration.
      const rebaked = recording.channels.filter((dispatch) => dispatch.frame > spawnFrame && dispatch.inPlace);
      const rebakedKeys = new Set(rebaked.map((dispatch) => dispatch.key));
      check(
        channelCandidates.filter((slot) => channelResidentKeys.has(pageKeyOf(slot.address))),
        (key) => rebakedKeys.has(key),
      );
      for (const dispatch of rebaked) {
        const height = regenerated.find((candidate) => candidate.key === dispatch.key);
        if (height) expect(dispatch.frame).toBeGreaterThan(height.frame);
      }
      console.log(
        `setAirports spawn 15 km out (aircraft ${Math.round(Math.hypot(spawned.centerX - origin.x, spawned.centerZ - origin.z))} m `
        + `from the new field): setAirports took ${spawnCallMs.toFixed(3)} ms; scan of ${scanSlots} slots over `
        + `${scanFrames} frames; ${markedHeight.size} of ${residentHeightKeys.size} resident height pages rebuilt `
        + `${JSON.stringify(levelHistogram(markedHeight))} over ${frames.size} frames; `
        + `${rebakedKeys.size} channel pages re-baked ${JSON.stringify(levelHistogram(rebakedKeys))}`,
      );

      // ---- the same list again, by value: nothing to do -----------------
      // A caller may hand the list over every frame: unchanged, it touches
      // no uniform and no producer, and queues nothing.
      const producerCalls = recording.generatorAirports.length;
      system.setAirports([home, spawned].map((airport) => Object.freeze({ ...airport })));
      system.setAirports([home, spawned]);
      expect(recording.generatorAirports.length).toBe(producerCalls);
      expect(system.airportRebuildBacklog).toEqual({
        changesBeingScanned: 0, heightPagesOwed: 0, heightPagesInFlight: 0, channelPagesOwed: 0,
      });

      // ---- retiring it rebuilds the same ground again --------------------
      const retireFrame = clock.frame;
      const retireStarted = performance.now();
      system.setAirports([home]);
      const retireCallMs = performance.now() - retireStarted;
      expect(recording.generatorAirports.at(-1)).toBe(1);
      await drain(system, clock, observer);
      const retired = new Set(recording.heights
        .filter((dispatch) => dispatch.frame > retireFrame && dispatch.inPlace)
        .map((dispatch) => dispatch.key));
      expect(retired).toEqual(markedHeight);
      console.log(`setAirports retire took ${retireCallMs.toFixed(3)} ms`);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
