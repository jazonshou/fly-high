/// <reference lib="webworker" />

import { structureSetArrays } from "@/src/render/structures/structureMeshArrays";
import { structureMeshTransfer, type StructuresWorkerCommand, type StructuresWorkerEvent } from "./structuresProtocol";

/**
 * The structures worker: one set's arrays per message, made from its records
 * by the building kit and posted back with every buffer transferred. Builds
 * run in the order asked; the main thread keeps one a set in flight.
 *
 * The kit caches each record's models by the record object, and every
 * message brings fresh copies, so nothing is held between builds.
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const arrays = structureSetArrays;

workerScope.addEventListener("message", (event: MessageEvent<StructuresWorkerCommand>) => {
  const command = event.data;
  if (command.type !== "build") return;
  const started = performance.now();
  let answer: StructuresWorkerEvent;
  try {
    const build = arrays(command.set, command.records, command.originX, command.originZ);
    answer = { type: "built", id: command.id, opaque: build.opaque, glass: build.glass, milliseconds: performance.now() - started };
    workerScope.postMessage(answer, structureMeshTransfer(build.glass, structureMeshTransfer(build.opaque)));
  } catch (error) {
    answer = { type: "error", id: command.id, message: error instanceof Error ? error.message : String(error) };
    workerScope.postMessage(answer);
  }
});
