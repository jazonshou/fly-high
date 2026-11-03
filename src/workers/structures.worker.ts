/// <reference lib="webworker" />

import { structureSetArrays } from "@/src/render/structures/structureMeshArrays";
import { structureTexturePlans, structureTextureTransfer } from "@/src/render/structures/structureTextures";
import { structureMeshTransfer, type StructuresWorkerCommand, type StructuresWorkerEvent } from "./structuresProtocol";

/**
 * The structures worker: one set's arrays per message, made from its records
 * by the building kit and posted back with every buffer transferred, or the
 * kit's material arrays (synthesised, mipped and packed). Messages are
 * answered in the order asked; the main thread keeps one build a set in
 * flight, and asks a worker of its own for the material arrays so their
 * second or so never holds a build up.
 *
 * The kit caches each record's models by the record object, and every
 * message brings fresh copies, so nothing is held between builds.
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<StructuresWorkerCommand>) => {
  const command = event.data;
  const started = performance.now();
  let answer: StructuresWorkerEvent;
  try {
    if (command.type === "textures") {
      const plans = structureTexturePlans(command.edge);
      answer = { type: "textures", id: command.id, plans, milliseconds: performance.now() - started };
      workerScope.postMessage(answer, structureTextureTransfer(plans));
      return;
    }
    if (command.type !== "build") return;
    const build = structureSetArrays(command.set, command.records, command.originX, command.originZ);
    answer = { type: "built", id: command.id, opaque: build.opaque, glass: build.glass, chimneys: build.chimneys, milliseconds: performance.now() - started };
    workerScope.postMessage(answer, [...structureMeshTransfer(build.glass, structureMeshTransfer(build.opaque)), build.chimneys.buffer]);
  } catch (error) {
    answer = { type: "error", id: command.id, message: error instanceof Error ? error.message : String(error) };
    workerScope.postMessage(answer);
  }
});
