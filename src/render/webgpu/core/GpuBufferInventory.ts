/**
 * Gate 0-c follow-up (Phase 6): the inventoried-memory wall was BLIND to
 * storage buffers.
 *
 * `FlightRenderer.inventoryGpuMemoryMiB` walks `scene.textures` and mesh
 * geometry, which is everything the renderer allocated before Phase 6. Every
 * new GPU allocation this phase adds — macro-erosion scratch, page-erosion
 * DAG scratch, the bathymetry page table, compute-scatter lanes — is a
 * `StorageBuffer`, which appears in neither list. The capture-time assert
 * therefore returned a byte-identical reading no matter how much buffer
 * memory an item added, and a `DYNAMIC_ALLOCATIONS` row reconciled against it
 * would read a 0.0 MiB delta. That is the exact "policed all along" illusion
 * §8 criterion 4 must not arrive under.
 *
 * This is a process-wide counter, not a per-engine one: it exists to make a
 * capture's single renderer honest, and captures build one renderer at a
 * time. Registrations must be paired with a release on disposal; a site that
 * leaks here is a site that leaks on the device.
 */

let registeredBytes = 0;

/** Record a device allocation the texture/geometry inventory cannot see. */
export function registerGpuBufferBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("Registered GPU buffer bytes must be finite and non-negative");
  }
  registeredBytes += bytes;
}

/** Release a previously registered allocation. Never goes negative. */
export function releaseGpuBufferBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("Released GPU buffer bytes must be finite and non-negative");
  }
  registeredBytes = Math.max(0, registeredBytes - bytes);
}

/** Total registered buffer bytes, for the renderer's inventory floor. */
export function inventoriedGpuBufferBytes(): number {
  return registeredBytes;
}

/** Test-only reset so one suite's fixtures cannot inflate another's reading. */
export function resetGpuBufferInventoryForTests(): void {
  registeredBytes = 0;
}
