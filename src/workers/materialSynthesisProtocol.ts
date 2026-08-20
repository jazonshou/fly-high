import type { WorldSeed } from "@/src/world/types";

/**
 * `4.5-C2b` — the material-synthesis worker protocol.
 *
 * `synthesizeSurfaceMaterial` is ~110 ms of pure CPU pixel maths per layer at
 * the 512² Balanced edge, and there are ten of them. Paced one per frame from
 * the render loop (`TerrainClipmapSystem.stepMaterialArrayBuild`) that is ten
 * dropped frames at every spawn — visible as a stutter train in the first
 * second of flight and as `maxFrameMs` in the capture's warmup. The function
 * has no Babylon dependency, so it can simply run somewhere else.
 *
 * Layers stream back ONE AT A TIME with their two `Uint8Array`s transferred
 * rather than copied. The frame loop still drives consumption, so the pacing
 * constraint the in-file comment records survives: the upload happens from
 * `update()`, once, when the tenth layer has landed.
 */

export interface MaterialSynthesisRequest {
  readonly type: "synthesize";
  readonly requestId: number;
  readonly seed: WorldSeed;
  readonly edge: number;
  /** `SurfaceMaterial` ids, in the order the arrays layer them. */
  readonly materialIds: readonly number[];
}

export type MaterialSynthesisCommand = MaterialSynthesisRequest;

export interface MaterialSynthesisLayerEvent {
  readonly type: "layer";
  readonly requestId: number;
  /** Index into the request's `materialIds`, so ordering cannot be lost. */
  readonly index: number;
  readonly albedoHeight: Uint8Array;
  readonly normalMaterial: Uint8Array;
}

export interface MaterialSynthesisErrorEvent {
  readonly type: "error";
  readonly requestId: number;
  readonly message: string;
}

export type MaterialSynthesisEvent = MaterialSynthesisLayerEvent | MaterialSynthesisErrorEvent;

export function isMaterialSynthesisEvent(value: unknown): value is MaterialSynthesisEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as { type?: unknown };
  return event.type === "layer" || event.type === "error";
}
