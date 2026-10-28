import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { DetailGenerationClient } from "../src/render/webgpu/detail/DetailGenerationClient";
import { detailCellKey } from "../src/render/webgpu/detail/generation";
import { selectNearSolids } from "../src/render/webgpu/detail/nearSolidsSelection";
import { detailTreeCanopyRankOrder, type DetailPresentationBuildCatalog } from "../src/render/webgpu/detail/presentationBuild";
import type { GeneratedDetailCell } from "../src/render/webgpu/detail/types";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import { NEAR_SOLID_STRIDE, type NearSolidsPost } from "../src/sim/person/nearSolids";
import { createWorld, TerrainBiome } from "../src/world";
import { DetailWorkerRuntime } from "../src/workers/detail.worker";
import {
  detailWorkerEventTransferables,
  isDetailWorkerEvent,
  type DetailWorkerCommand,
  type DetailWorkerEvent,
} from "../src/workers/detailProtocol";
import { realDetailCatalog } from "./support/nearSolidsFixture";

/**
 * The near-solids feed (W1 brief): the detail worker lists the trunks, rocks,
 * logs and stumps round the walker from the cells it retains; the client
 * carries the request and the answer; the runtime asks again every 16 m and
 * whenever a cell under the list changes, and hands each list on.
 */

const catalog = realDetailCatalog();
const medium = resolveWebGpuQualityProfile("medium", "balanced");
const SELECTION = {
  radius: 48,
  nearStemsPerHectare: medium.renderedDensityLaw.nearStemsPerHectare,
  treeVariantCap: medium.treeVariantCap,
  treePrototypeMode: medium.treePrototypeMode,
};

class FakeDetailWorker {
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly commands: DetailWorkerCommand[] = [];

  postMessage(message: DetailWorkerCommand): void {
    this.commands.push(message);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}

  emit(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data } as unknown as Event);
  }
}

describe("near-solids feed", () => {
  it("lists the near solids of the cells the detail worker retains, as the selection does", () => {
    // A wooded cell of this world (1,482 stems).
    const world = createWorld("walker-forest", { airport: false });
    const posted: Array<{ event: DetailWorkerEvent; transfers: Transferable[] }> = [];
    const worker = new DetailWorkerRuntime((event, transfers) => posted.push({ event, transfers }), (callback) => callback());
    worker.handleCommand({
      type: "initialize",
      worldSeed: world.seed,
      world,
      cellSizeMeters: 256,
      seaLevelMeters: world.seaLevel,
      presentationCatalog: catalog,
    });
    const generate = (requestId: number, retain: boolean): DetailWorkerEvent => {
      worker.handleCommand({
        type: "generate",
        requestId,
        generation: 1,
        key: detailCellKey(0, 1),
        cellX: 0,
        cellZ: 1,
        densityMultiplier: 1,
        dayOfYear: 171,
        ...(retain ? { retain: true } : {}),
      });
      return posted.at(-1)!.event;
    };
    const retained = generate(1, true);
    const full = generate(2, false);
    if (retained.type !== "retainedCell" || full.type !== "cell") throw new Error("expected a retained and a full cell");
    const cell: GeneratedDetailCell = full.cell;
    expect(cell.trees.length).toBeGreaterThan(1_000);

    const center = { centerX: 128, centerZ: 384 };
    worker.handleCommand({ type: "nearSolids", requestId: 7, input: { ...SELECTION, ...center, tokens: [retained.cell.token] } });
    const answer = posted.at(-1)!;
    expect(isDetailWorkerEvent(answer.event)).toBe(true);
    if (answer.event.type !== "nearSolids") throw new Error(`expected near solids, got ${answer.event.type}`);
    expect(answer.event.requestId).toBe(7);
    const expected = selectNearSolids(
      { ...SELECTION, ...center, residents: [{ cell, treeCanopyRank: detailTreeCanopyRankOrder(cell.trees) }] },
      catalog,
    );
    expect(expected.length / NEAR_SOLID_STRIDE).toBeGreaterThan(20);
    expect([...answer.event.records]).toEqual([...expected]);
    // The list's buffer is transferred, not copied.
    expect(answer.transfers).toEqual([answer.event.records.buffer]);
    expect(detailWorkerEventTransferables(answer.event)).toEqual([answer.event.records.buffer]);

    // A released cell is skipped, not an error.
    worker.handleCommand({ type: "releaseCell", token: retained.cell.token });
    worker.handleCommand({ type: "nearSolids", requestId: 8, input: { ...SELECTION, ...center, tokens: [retained.cell.token] } });
    const empty = posted.at(-1)!.event;
    expect(empty.type === "nearSolids" && empty.records.length).toBe(0);
  });

  it("answers an error without a catalog, and the client rejects a malformed list", () => {
    const posted: DetailWorkerEvent[] = [];
    const worker = new DetailWorkerRuntime((event) => posted.push(event), (callback) => callback());
    worker.handleCommand({ type: "nearSolids", requestId: 3, input: { ...SELECTION, centerX: 0, centerZ: 0, tokens: [] } });
    expect(posted.at(-1)).toMatchObject({ type: "nearSolidsError", requestId: 3 });
    expect(isDetailWorkerEvent({ type: "nearSolids", requestId: 1, records: new Float32Array(NEAR_SOLID_STRIDE + 1) })).toBe(false);
    expect(isDetailWorkerEvent({ type: "nearSolids", requestId: 1, records: [1, 2, 3, 4, 5, 6, 7, 8] })).toBe(false);
  });

  it("carries a request and its answer through the client, and errors it when the worker goes", () => {
    const worker = new FakeDetailWorker();
    let unavailable = 0;
    const client = new DetailGenerationClient({
      worldSeed: "near-solids-client",
      cellSizeMeters: 256,
      seaLevelMeters: 0,
      presentationCatalog: {} as DetailPresentationBuildCatalog,
      workerFactory: () => worker as unknown as Worker,
    }, () => {
      unavailable += 1;
    });
    const generation = { key: "0:0", generation: 1, priority: 0, cellX: 0, cellZ: 0, densityMultiplier: 1, dayOfYear: 0 };
    const cellRequest = client.requestRetained(generation, () => undefined);
    worker.emit({
      type: "retainedCell",
      requestId: cellRequest,
      generation: 1,
      key: "0:0",
      cell: {
        token: 5, key: "0:0", cellX: 0, cellZ: 0, cellSizeMeters: 256, minX: 0, minZ: 0, maxX: 256, maxZ: 256,
        counts: { trees: 0, shrubs: 0, rocks: 0, clutter: 0, groundCover: 0 },
      },
    });

    // A token the client does not own is refused before anything is posted.
    let refused: Error | null = null;
    expect(client.requestNearSolids({ ...SELECTION, centerX: 0, centerZ: 0, tokens: [6] }, () => undefined, (error) => {
      refused = error;
    })).toBe(-1);
    expect(refused).not.toBeNull();

    const answers: Float32Array[] = [];
    const id = client.requestNearSolids({ ...SELECTION, centerX: 10, centerZ: 20, tokens: [5] }, (records) => answers.push(records));
    expect(id).toBeGreaterThan(0);
    expect(worker.commands.at(-1)).toEqual({ type: "nearSolids", requestId: id, input: { ...SELECTION, centerX: 10, centerZ: 20, tokens: [5] } });
    const records = new Float32Array(NEAR_SOLID_STRIDE * 2).fill(1);
    worker.emit({ type: "nearSolids", requestId: id, records });
    expect(answers).toEqual([records]);
    // A late or repeated answer is ignored.
    worker.emit({ type: "nearSolids", requestId: id, records });
    expect(answers).toHaveLength(1);
    expect(unavailable).toBe(0);

    const errors: Error[] = [];
    client.requestNearSolids({ ...SELECTION, centerX: 10, centerZ: 20, tokens: [5] }, () => undefined, (error) => errors.push(error));
    worker.emit({ type: "nearSolids", requestId: 99, records: new Float32Array(3) });
    expect(unavailable).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("asks again every 16 m the walker moves, not before, and stops when the focus is cleared", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "near-solids-runtime",
      terrainSample: (x, z) => ({
        height: 96 + Math.sin(x * 0.002) * 5 + Math.cos(z * 0.0023) * 4,
        slope: 0.05,
        moisture: 0.68,
        biome: TerrainBiome.FOREST,
      }),
      cellSizeMeters: 128,
      presentationRebuildBudget: { maximumWorkUnits: 1_000_000, maximumMilliseconds: 1_000_000 },
    });
    const profile = { ...medium, vegetationDistance: 300, vegetationDensity: 1, grassRadiusMeters: 1 };
    const origin = { x: 0, y: 0, z: 0 };
    const posts: NearSolidsPost[] = [];
    runtime.setNearSolidsListener((post) => posts.push(post));
    const internals = runtime as unknown as { readonly cells: Map<string, unknown>; readonly desiredKeys: Set<string> };
    try {
      const walkTo = (x: number, z: number, updates = 1): void => {
        runtime.setNearSolidsFocus(x, z);
        for (let pass = 0; pass < updates; pass += 1) runtime.update({ x, y: 100, z }, origin, profile);
      };
      // Settle the cells round the walker first: each new cell under the list asks again.
      for (let pass = 0; pass < 256; pass += 1) {
        runtime.update({ x: 64, y: 100, z: 64 }, origin, profile);
        if (internals.desiredKeys.size > 0 && internals.cells.size === internals.desiredKeys.size) break;
      }
      walkTo(64, 64);
      expect(posts).toHaveLength(1);
      const first = posts[0]!;
      expect(first).toMatchObject({ version: 1, centerX: 64, centerZ: 64, radius: 48 });
      expect(first.records.length / NEAR_SOLID_STRIDE).toBeGreaterThan(10);
      // Every solid within the disc, as offsets from its centre.
      for (let at = 0; at < first.records.length; at += NEAR_SOLID_STRIDE) {
        expect(Math.hypot(first.records[at + 1]!, first.records[at + 3]!)).toBeLessThan(48 + 2);
      }
      walkTo(64, 64, 3);
      walkTo(74, 70, 3);
      expect(posts).toHaveLength(1);
      walkTo(78, 72);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toMatchObject({ version: 2, centerX: 78, centerZ: 72 });
      // Low lists 32 m.
      runtime.update({ x: 78, y: 100, z: 72 }, origin, { ...resolveWebGpuQualityProfile("low", "balanced"), vegetationDistance: 300, vegetationDensity: 1, grassRadiusMeters: 1 });
      expect(posts.at(-1)).toMatchObject({ version: 3, radius: 32 });
      runtime.clearNearSolidsFocus();
      for (let pass = 0; pass < 3; pass += 1) runtime.update({ x: 200, y: 100, z: 200 }, origin, profile);
      expect(posts).toHaveLength(3);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
