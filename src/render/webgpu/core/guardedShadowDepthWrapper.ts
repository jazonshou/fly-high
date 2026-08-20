import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";

/**
 * `4.5-0`: every ShadowDepthWrapper in the renderer is built here, guarded.
 *
 * `subMesh.resetDrawCache()` on a mesh that has already rendered destroys the
 * forward draw wrapper — but not the ShadowDepthWrapper's per-submesh
 * registration, which was recorded by `onEffectCreatedObservable` when the
 * forward effect first compiled. On the next shadow render of that submesh the
 * wrapper's `_makeEffect` copies the forward wrapper's `defines` into its
 * cached depth params; after a reset that read is `undefined`, the cache is
 * poisoned with `defines = null` permanently (the heal fires only on effect
 * IDENTITY change), and `PBRBaseMaterial.bindForSubMesh` silently early-returns
 * on null defines. The shadow draw then executes against a completely unbound
 * material context and `device.createBindGroup` throws
 * "Required member is undefined" — the fatal "Unable to continue flight" stop.
 * The race is real in flight: `WorldDetailRuntime.bindInstanceBuffers` resets
 * a growing batch's cache in the same frame graph that renders the CSM pass
 * first, so a load crashes whenever a batch's first cascade appearance lands
 * on a growth-rebind frame — most loads, while detail cells are streaming in.
 *
 * The guard: while a submesh is registered but has no cached depth params yet,
 * refuse to build them from a destroyed forward wrapper — report not-ready
 * instead. `isReadyForSubMesh` returns false and the generator takes its
 * standard not-ready skip. Submeshes with already-built depth params are
 * untouched, so `getEffect` can never observe a ready-then-null flip.
 *
 * How long the skip lasts depends on whether the mesh reaches the main pass.
 * A camera-visible mesh heals on its next main-pass render, which recreates
 * the forward wrapper with real defines: one frame without that caster. A
 * mesh that does NOT reach the main pass — a frustum-culled foliage batch, or
 * a terrain caster at `layerMask 0` — has no heal path, so it stops casting
 * until something re-renders it forward. That is the honest bound, and it is
 * still strictly better than the alternative: the un-guarded version of the
 * same state is a fatal renderer stop, not a missing shadow.
 */
interface ShadowDepthWrapperInternals {
  _subMeshToEffect: Map<SubMesh, readonly [unknown, number]>;
  _subMeshToDepthWrapper: {
    get(subMesh: SubMesh, shadowGenerator: unknown): unknown;
  };
  _makeEffect(
    subMesh: SubMesh,
    defines: string[],
    shadowGenerator: unknown,
    passIdForDrawWrapper: number,
  ): unknown;
}

type DrawWrapperSource = {
  _getDrawWrapper(renderPassId?: number): { defines: unknown } | undefined;
};

export function createGuardedShadowDepthWrapper(
  material: PBRMaterial,
  scene: Scene,
  // remappedVariables is passed through verbatim. NOTE: an EMPTY array is not
  // "no remapping" to Babylon — it emits `#include<...>()` whose zero-arg
  // substitution garbles the include; omit the field entirely instead.
  // onOrphanSkip is a test seam: the regression test uses it to prove the
  // guard actually fired, not merely that nothing crashed.
  options?: { remappedVariables?: string[]; onOrphanSkip?: () => void },
): ShadowDepthWrapper {
  // An EMPTY array is not "no remapping": Babylon emits `#include<...>()`,
  // whose zero-argument substitution garbles the include. Length, not
  // truthiness — `[]` is truthy.
  const wrapperOptions = options?.remappedVariables?.length
    ? { remappedVariables: options.remappedVariables }
    : undefined;
  const wrapper = new ShadowDepthWrapper(material, scene, wrapperOptions);
  const internals = wrapper as unknown as ShadowDepthWrapperInternals;
  // The probe throws at construction on a Babylon bump, the same contract as
  // resolveOceanMipGenerator/assertStartupInvariants: fail loudly at startup,
  // never silently as a mid-flight renderer stop. Arity is checked too — a
  // reordered or inserted parameter would leave the names intact while making
  // the guard read the wrong argument, which degrades to a pure pass-through
  // and quietly restores the crash with every test still green.
  if (
    !(internals._subMeshToEffect instanceof Map)
    || typeof internals._subMeshToDepthWrapper?.get !== "function"
    || typeof internals._makeEffect !== "function"
    || internals._makeEffect.length !== 4
  ) {
    throw new Error(
      "ShadowDepthWrapper internals moved; re-verify the orphaned-defines guard (4.5-0)",
    );
  }
  const makeEffect = internals._makeEffect;
  internals._makeEffect = function guardedMakeEffect(
    subMesh,
    defines,
    shadowGenerator,
    passIdForDrawWrapper,
  ) {
    const registration = internals._subMeshToEffect.get(subMesh);
    const originalPassId = registration?.[1];
    // The pass id must be a real number. `_getDrawWrapper(undefined)` falls
    // back to the engine's CURRENT pass — which here is the shadow RTT, where
    // a caster submesh never has a draw wrapper — so an unrecognised
    // registration shape would make this guard report not-ready forever and
    // silently stop every wrapper-based shadow. Treat it as "not ours" and
    // defer to Babylon instead.
    if (
      registration
      && typeof originalPassId === "number"
      && !internals._subMeshToDepthWrapper.get(subMesh, shadowGenerator)
    ) {
      const original = (subMesh as unknown as DrawWrapperSource)._getDrawWrapper(
        originalPassId,
      );
      if (!original?.defines) {
        options?.onOrphanSkip?.();
        return null;
      }
    }
    return makeEffect.call(wrapper, subMesh, defines, shadowGenerator, passIdForDrawWrapper);
  };
  return wrapper;
}
