import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import {
  inventoriedGpuBufferBytes,
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
  resetGpuBufferInventoryForTests,
} from "../src/render/webgpu/core/GpuBufferInventory";

/**
 * Gate 0-c follow-up (Phase 6): `FlightRenderer.inventoryGpuMemoryMiB` walks
 * `scene.textures` and mesh geometry — it cannot see a `StorageBuffer`. Every
 * GPU allocation Phase 6 adds is one, so without registration the capture's
 * inventoried-memory wall reads byte-identical no matter how much scratch an
 * item allocates, and its `DYNAMIC_ALLOCATIONS` reconciliation records a
 * 0.0 MiB delta. The adversarial review found exactly that hole.
 *
 * This scan makes the hole impossible to reopen quietly: a file that
 * constructs a `StorageBuffer` must also account for it.
 */

/**
 * Sites that allocate but do not yet register, with the reason. This list
 * may only SHRINK. Adding a row means a new blind allocation, which is the
 * defect this test exists to prevent.
 */
const UNREGISTERED_ALLOCATION_SITES: ReadonlyArray<{
  readonly file: string;
  readonly reason: string;
}> = [];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("GPU buffer inventory policy", () => {
  it("makes every StorageBuffer allocation site account for its bytes", () => {
    const allowed = new Set(UNREGISTERED_ALLOCATION_SITES.map((site) => site.file));
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const source = readSource(file);
      if (!source.includes("new StorageBuffer(")) continue;
      const relative = file.replace(/\\/g, "/");
      if (allowed.has(relative)) continue;
      if (!source.includes("registerGpuBufferBytes")) offenders.push(relative);
    }
    expect(
      offenders,
      "these files allocate GPU storage buffers the renderer's memory "
      + "inventory cannot see — register the bytes (GpuBufferInventory) so the "
      + "capture-time wall and the DYNAMIC_ALLOCATIONS reconciliation are honest",
    ).toEqual([]);
  });

  it("keeps the unregistered-site list shrinking and justified", () => {
    for (const site of UNREGISTERED_ALLOCATION_SITES) {
      expect(readSource(site.file)).toContain("new StorageBuffer(");
      expect(site.reason.length).toBeGreaterThan(40);
    }
    // Every allocation site now registers. The list is empty and must stay
    // empty: a new row means a new blind allocation.
    // A tripwire on the debt itself: every row here is scheduled work, and
    // the count below fails the moment one is discharged, forcing its removal
    // rather than letting the list quietly persist.
    expect(UNREGISTERED_ALLOCATION_SITES).toHaveLength(0);
  });

  it("counts registrations and releases without going negative", () => {
    resetGpuBufferInventoryForTests();
    expect(inventoriedGpuBufferBytes()).toBe(0);
    registerGpuBufferBytes(1_024);
    registerGpuBufferBytes(2_048);
    expect(inventoriedGpuBufferBytes()).toBe(3_072);
    releaseGpuBufferBytes(1_024);
    expect(inventoriedGpuBufferBytes()).toBe(2_048);
    // A double release must not create phantom headroom.
    releaseGpuBufferBytes(1_000_000);
    expect(inventoriedGpuBufferBytes()).toBe(0);
    expect(() => registerGpuBufferBytes(Number.NaN)).toThrow(RangeError);
    expect(() => releaseGpuBufferBytes(-1)).toThrow(RangeError);
    resetGpuBufferInventoryForTests();
  });

  it("is wired into the renderer's inventory floor", () => {
    const renderer = readSource("src/render/FlightRenderer.ts");
    expect(renderer).toContain("inventoriedGpuBufferBytes()");
    const inventory = renderer.slice(
      renderer.indexOf("private inventoryGpuMemoryMiB()"),
      renderer.indexOf("getDiagnostics()"),
    );
    expect(inventory).toContain("inventoriedGpuBufferBytes()");
  });
});
