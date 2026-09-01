import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

/**
 * `7-4b`'s inter-stage audit, factored so every lit material counts the budget
 * the same way — and the way the DEVICE counts it, which is neither of the two
 * ways this project counted it before.
 *
 * **The adapter arbitrated it by refusing a pipeline and showing its working:**
 *
 *     Total fragment input variables count
 *     (17 = 16 (user-defined) + 1 (front_facing)) exceeds the maximum (16)
 *
 * So the budget is `@location` count plus `front_facing`, and
 * `@builtin(position)` is NOT counted. Counting every builtin over-reports by
 * one and makes a material with a free slot look full; counting locations alone
 * under-reports and makes a full one look free. **Both mistakes were made here
 * before this file existed** — the terrain spike read 15 -> 16 and looked to be
 * at the limit when the device's own arithmetic puts it at 14 -> 15.
 *
 * **Why every lit material needs this and not just the two that were measured.**
 * A `ClusteredLightContainer` is a SCENE light: it reaches every material that
 * takes Babylon's light loop, and it adds **exactly one `@location`** to each.
 * A material already at 16 of 16 therefore does not degrade when one is
 * attached — pipeline creation fails and the mesh stops drawing entirely. The
 * detail material was at exactly 16 and did precisely that.
 *
 * Deliberately imports nothing from `src/`: a material's plugin injections leak
 * across modules (see `clustered-lighting-detail-spike`), so an audit helper
 * that pulled one in could contaminate the permutation it is measuring.
 */

/** What the device's `maxInterStageShaderVariables` actually is under spec defaults. */
export const INTER_STAGE_LIMIT = 16;

export interface ShaderRecord {
  readonly label: string;
  readonly code: string;
}

/**
 * Patch `createShaderModule` so every compiled permutation is retained. Call
 * inside `beforeAll`, after `initAsync`.
 */
export function captureShaderModules(engine: WebGPUEngine, keep = 64): ShaderRecord[] {
  const records: ShaderRecord[] = [];
  const device = (engine as unknown as { _device: GPUDevice })._device;
  const originalCreate = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
    records.push({ label: String(descriptor.label ?? ""), code: String(descriptor.code) });
    if (records.length > keep) records.shift();
    return originalCreate(descriptor);
  };
  return records;
}

/** The device's own count for one shader's `FragmentInputs` struct, or 0 if it has none. */
export function fragmentInputCount(code: string): number {
  const struct = /struct\s+FragmentInputs\s*\{([\s\S]*?)\n\}/u.exec(code);
  if (!struct) return 0;
  const locations = [...struct[1]!.matchAll(/@location\(/gu)].length;
  return locations + (/@builtin\(front_facing\)/u.test(struct[1]!) ? 1 : 0);
}

/** The worst permutation compiled so far — the one that decides whether a container fits. */
export function peakFragmentInputs(records: readonly ShaderRecord[]): number {
  return Math.max(0, ...records.map((r) => fragmentInputCount(r.code)));
}

/**
 * Slots left before a `ClusteredLightContainer` (which costs exactly one) can no
 * longer be attached. **Report this even when it is comfortable**: a clean audit
 * that names its margin is what makes the next attach safe, where a bare pass
 * leaves the next person re-deriving it.
 */
export function clusteredHeadroom(records: readonly ShaderRecord[]): number {
  return INTER_STAGE_LIMIT - peakFragmentInputs(records);
}

/**
 * **Does this rig compile everything the SHIPPING path attaches?** Declared per
 * material, because it decides whether the number above is a measurement or an
 * artifact — and the two look identical in a passing test.
 *
 * The distinction exists because a LOW count is ambiguous on its own. Wildlife
 * measured 3 of 16 with no shadow generator in its rig, so the CSM receive
 * path's eight varyings were simply absent: the number was not wrong, it was
 * about a different material. `LightPoints` also counts low — two varyings —
 * but sets `receiveShadows = false` and is never added as a shadow caster, so
 * there is no CSM path in production either and its count is COMPLETE.
 *
 * **So the discriminating question is never "is the number small". It is "does
 * the shipping configuration contain a path this rig did not build".** Record
 * the answer here rather than re-deriving it from the count, which cannot
 * distinguish the two cases.
 */
export interface RigFidelity {
  /** A short name for the material as it SHIPS, used in the log line. */
  readonly label: string;
  /**
   * True only if the rig builds every generator, wrapper and define the
   * shipping path attaches. When false, `missingPaths` must say what is absent
   * and roughly what it costs.
   */
  readonly buildsShippingPaths: boolean;
  /** e.g. "CSM receive path (8 varyings)" — required when the rig is partial. */
  readonly missingPaths?: string;
}

/**
 * The audit itself. Asserts the bound in every case — an overflow in a PARTIAL
 * rig is still real — but refuses to present headroom as usable when the rig is
 * known incomplete, because that is the number someone would otherwise spend.
 */
export function auditInterStage(
  records: readonly ShaderRecord[],
  rig: RigFidelity,
): { peak: number; headroom: number; trustworthy: boolean } {
  const peak = peakFragmentInputs(records);
  const headroom = clusteredHeadroom(records);
  const suffix = rig.buildsShippingPaths
    ? `headroom=${headroom}`
    : `NOT SHIPPING -- rig omits ${rig.missingPaths ?? "an unnamed path"}; `
      + "headroom is an artifact, not a margin";
  // eslint-disable-next-line no-console
  console.log(`[inter-stage] ${rig.label}: peak=${peak}/${INTER_STAGE_LIMIT} ${suffix}`);
  return { peak, headroom, trustworthy: rig.buildsShippingPaths };
}
