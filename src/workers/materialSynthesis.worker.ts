/// <reference lib="webworker" />

import { synthesizeSurfaceMaterial } from "@/src/render/webgpu/terrain/MaterialArraySynthesis";
import type { SurfaceMaterialId } from "@/src/render/webgpu/terrain/surfaceMaterials";
import type {
  MaterialSynthesisCommand,
  MaterialSynthesisEvent,
} from "./materialSynthesisProtocol";

/**
 * Off-main-thread terrain material synthesis (`4.5-C2b`).
 *
 * The ten 512² layers are ~110 ms each of pure CPU pixel maths. Paced one per
 * frame from the render loop they are ten dropped frames at every spawn; the
 * recipes have no Babylon dependency (that is what `MaterialArrayUpload.ts`
 * exists to keep true), so they run here instead and the main thread only
 * uploads.
 *
 * Layers are posted one at a time with their buffers TRANSFERRED, so the main
 * thread can start consuming before the batch finishes and neither side pays
 * for a 2 MiB copy per layer.
 *
 * This is a thread move, not a pipeline change: the recorded C2 deferral of
 * GPU synthesis stays deferred.
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<MaterialSynthesisCommand>) => {
  const command = event.data;
  if (command.type !== "synthesize") return;
  for (let index = 0; index < command.materialIds.length; index += 1) {
    const id = command.materialIds[index]!;
    try {
      const layer = synthesizeSurfaceMaterial(id as SurfaceMaterialId, command.seed, command.edge);
      const message: MaterialSynthesisEvent = {
        type: "layer",
        requestId: command.requestId,
        index,
        albedoHeight: layer.albedoHeight,
        normalMaterial: layer.normalMaterial,
      };
      workerScope.postMessage(message, [
        layer.albedoHeight.buffer as ArrayBuffer,
        layer.normalMaterial.buffer as ArrayBuffer,
      ]);
    } catch (error) {
      workerScope.postMessage({
        type: "error",
        requestId: command.requestId,
        message: error instanceof Error ? error.message : String(error),
      } satisfies MaterialSynthesisEvent);
      return;
    }
  }
});
