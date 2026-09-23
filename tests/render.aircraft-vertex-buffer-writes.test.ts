import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { AIRCRAFT_KINDS } from "../src/sim";

/**
 * NO AIRFRAME WRITES INTO A VERTEX BUFFER THE GPU WILL NOT RECEIVE.
 *
 * Babylon's `updateVerticesData` on a buffer created non-updatable is a
 * SILENT NO-OP once the GPU buffer exists: `Buffer.update` calls `create`,
 * which uploads only when `_updatable`. Meanwhile `getVerticesData` hands back
 * the buffer's own array, so code that mutates that array and then "updates"
 * changes the CPU copy every picking test, ray cast and digest reads, while
 * the GPU draws what was uploaded at construction. The Global's cabin panes
 * shipped that way: bowed on the CPU, flat on the GPU, cut flat at a loft row
 * in every frame, and a seating table read "every vertex within 9 mm" off the
 * copy the GPU never saw. `LightPoints` met the same trap as a dark airfield.
 *
 * No read of a mesh in Node can see the GPU's copy, so this watches the WRITE:
 * every `VertexBuffer.update` during every airframe's build, failing on any
 * whose buffer is not updatable.
 */

const fixtures: { engine: NullEngine; scene: Scene }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { engine, scene } of fixtures.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});
function scene(): Scene {
  const engine = new NullEngine();
  const created = new Scene(engine);
  created.useRightHandedSystem = true;
  fixtures.push({ engine, scene: created });
  return created;
}

/** Every write to a vertex buffer that cannot reach the GPU, while `body` runs. */
function lostWrites(body: () => void): string[] {
  const lost: string[] = [];
  const update = VertexBuffer.prototype.update;
  const updateDirectly = VertexBuffer.prototype.updateDirectly;
  vi.spyOn(VertexBuffer.prototype, "update").mockImplementation(function (this: VertexBuffer, data) {
    if (!this.isUpdatable()) lost.push(`update(${this.getKind()})`);
    return update.call(this, data);
  });
  vi.spyOn(VertexBuffer.prototype, "updateDirectly").mockImplementation(function (this: VertexBuffer, data, offset, useBytes) {
    if (!this.isUpdatable()) lost.push(`updateDirectly(${this.getKind()})`);
    return updateDirectly.call(this, data, offset, useBytes);
  });
  body();
  vi.restoreAllMocks();
  return lost;
}

describe("vertex writes reach the GPU", () => {
  it("the instrument sees a lost write, and does not see a legal one", () => {
    // POSITIVE CONTROL: the Global's own mistake, reproduced on a box.
    const target = scene();
    const box = CreateBox("control", { size: 1 }, target);
    const lost = lostWrites(() => {
      const positions = box.getVerticesData(VertexBuffer.PositionKind)!;
      positions[0] = positions[0]! + 0.1;
      box.updateVerticesData(VertexBuffer.PositionKind, positions);
    });
    expect(lost).toEqual(["update(position)"]);
    // NEGATIVE CONTROL: the same write to a buffer made updatable is fine.
    const updatable = CreateBox("updatable", { size: 1, updatable: true }, target);
    expect(lostWrites(() => {
      updatable.updateVerticesData(VertexBuffer.PositionKind, updatable.getVerticesData(VertexBuffer.PositionKind)!);
    })).toEqual([]);
  });

  it.each(AIRCRAFT_KINDS.map((kind) => [kind] as const))("%s's build writes no vertex data the GPU would not receive", (kind) => {
    const target = scene();
    const lost = lostWrites(() => createWebGpuAircraft(target, kind).dispose());
    expect(lost, `${kind}: a vertex buffer was updated after upload without being updatable`).toEqual([]);
  });
});
