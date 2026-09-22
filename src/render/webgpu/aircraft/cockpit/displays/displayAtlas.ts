import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { AircraftBuildContext } from "../../builders";
import type { DisplayState } from "./displayState";

/**
 * The six flight-deck displays as ONE texture, and the plumbing that gets it onto the screens.
 *
 * ONE atlas, one material, one mesh: the six screen boxes are already merged into
 * `airliner-screens`, and a texture each would be six materials and six draws. Each box's face
 * toward the pilot is given the UVs of its own slot BEFORE the merge, so the merged mesh samples six
 * different pictures out of one image with no extra draw.
 *
 * IT IS AN EMISSIVE TEXTURE, not an albedo one. A display emits; it is not a lit surface with a
 * picture painted on it. Albedo black and emissive white means what the canvas draws is what the
 * pilot sees, at night as well as in daylight, without the interior's lighting washing it out.
 *
 * THE HEADLESS TRAP, which is why `displaysLive` exists. Every Node test builds the aircraft under
 * `NullEngine`, where there is no 2D canvas: `DynamicTexture` either refuses to construct or hands
 * back an object whose `getContext()` is missing or throws. So creation is attempted, and if a
 * usable 2D context does not come back the screens keep the flat instrument-face material they have
 * always had and `displaysLive` reads false. The tests can then assert the headless path explicitly
 * rather than passing by accident, and nothing in the suite depends on a GPU.
 */

/** The slots, left to right across the atlas, in the order the screens are built (`SCREEN_Z`). */
export const DISPLAY_SLOT_ORDER = [
  "port-pfd",
  "port-nd",
  "port-eicas",
  "starboard-eicas",
  "starboard-nd",
  "starboard-pfd",
] as const;
export type DisplaySlotName = (typeof DISPLAY_SLOT_ORDER)[number];

/** One slot is a square; six of them side by side make the atlas. */
export const DISPLAY_SLOT_PIXELS = 256;
export const DISPLAY_ATLAS_WIDTH = DISPLAY_SLOT_PIXELS * DISPLAY_SLOT_ORDER.length;
export const DISPLAY_ATLAS_HEIGHT = DISPLAY_SLOT_PIXELS;
/** Redraw rate while the cockpit is in view. A display is not an animation; 15 a second is plenty. */
export const DISPLAY_UPDATE_HZ = 15;

/** Where a slot sits in the atlas, in pixels. */
export interface DisplaySlot {
  readonly name: DisplaySlotName;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function displaySlots(): readonly DisplaySlot[] {
  return DISPLAY_SLOT_ORDER.map((name, index) => ({
    name,
    x: index * DISPLAY_SLOT_PIXELS,
    y: 0,
    width: DISPLAY_SLOT_PIXELS,
    height: DISPLAY_SLOT_PIXELS,
  }));
}

/**
 * Point one screen box's PILOT-FACING face at its slot.
 *
 * The face is found by geometry, not by Babylon's face order: the box's local X is its thickness and
 * the pilot is at smaller x, so the face he sees is the one whose NORMAL is -X. Position alone is
 * not enough and the first attempt at this got it wrong -- twelve vertices sit at the minimum x, not
 * four, because each of the four side faces contributes the two corner vertices it shares with that
 * edge. The normal is what separates the face from its neighbours' edges. The other twenty vertices
 * keep the UVs they had; the bezels cover the sides and the back is inside the board, so nothing
 * else samples the atlas.
 *
 * ORIENTATION: the pilot's right is +Z, so u runs with +Z. V IS INVERTED against world up, and that
 * is measured, not reasoned: the stub painter draws its speed bar along the canvas's BOTTOM edge, and
 * in the first live frame that bar came out along the TOP of every screen. A texture's v and a
 * canvas's y run opposite ways here, so world-up (+Y) has to map to the SMALLER v. This is exactly
 * what the stub's asymmetric marks were for -- six flat colours would have shown a correct-looking
 * picture upside down, and the real pages' text would have been the first thing to notice.
 */
export function remapScreenFaceToSlot(mesh: Mesh, slot: DisplaySlot, atlasWidth = DISPLAY_ATLAS_WIDTH, atlasHeight = DISPLAY_ATLAS_HEIGHT): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions || !uvs || !normals) throw new Error(`${mesh.name}: no positions, normals or UVs to remap`);
  let minimumX = Number.POSITIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) minimumX = Math.min(minimumX, positions[i]!);
  const u0 = slot.x / atlasWidth;
  const u1 = (slot.x + slot.width) / atlasWidth;
  const v0 = slot.y / atlasHeight;
  const v1 = (slot.y + slot.height) / atlasHeight;
  let zLow = Number.POSITIVE_INFINITY;
  let zHigh = Number.NEGATIVE_INFINITY;
  let yLow = Number.POSITIVE_INFINITY;
  let yHigh = Number.NEGATIVE_INFINITY;
  const faceVertices: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    if (Math.abs(positions[vertex * 3]! - minimumX) > 1e-6) continue;
    if (normals[vertex * 3]! > -0.9) continue; // an edge vertex of a SIDE face, not the face itself
    faceVertices.push(vertex);
    zLow = Math.min(zLow, positions[vertex * 3 + 2]!);
    zHigh = Math.max(zHigh, positions[vertex * 3 + 2]!);
    yLow = Math.min(yLow, positions[vertex * 3 + 1]!);
    yHigh = Math.max(yHigh, positions[vertex * 3 + 1]!);
  }
  if (faceVertices.length !== 4) {
    throw new Error(`${mesh.name}: expected 4 vertices on the pilot-facing face, found ${faceVertices.length}`);
  }
  for (const vertex of faceVertices) {
    const acrossZ = (positions[vertex * 3 + 2]! - zLow) / (zHigh - zLow);
    const upY = (positions[vertex * 3 + 1]! - yLow) / (yHigh - yLow);
    uvs[vertex * 2] = u0 + acrossZ * (u1 - u0);
    uvs[vertex * 2 + 1] = v1 - upY * (v1 - v0);
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
}

/** A 2D drawing surface, as much of one as the pages need. Kept structural so a test can record calls. */
export interface DisplayContext2D {
  fillStyle: string;
  fillRect(x: number, y: number, width: number, height: number): void;
}

/** What a live atlas is: the texture, the canvas behind it, and the slots to draw into. */
export interface DisplayAtlas {
  readonly texture: RawTexture;
  readonly context: DisplayContext2D;
  /** Read back to upload; kept so `uploadDisplayAtlas` does not have to find it again. */
  readonly canvas: HTMLCanvasElement;
  readonly slots: readonly DisplaySlot[];
  readonly width: number;
  readonly height: number;
}

/**
 * Try to make the atlas. Returns null wherever there is no 2D canvas -- every Node test -- and the
 * caller then leaves the screens on their flat material.
 */
export function createDisplayAtlas(scene: Scene, name: string): DisplayAtlas | null {
  // NOT `DynamicTexture`, and that is measured rather than preferred. Its constructor calls
  // `engine.createDynamicTexture`, which exists on no engine in this tree-shakeable build until an
  // extension module is imported for its side effect -- and on THIS renderer's WebGPU engine the
  // extension that would add it lives under `Engines/WebGPU/Extensions`, separate from the
  // `ThinEngine` one. Importing either broke the app's startup outright (the menu never appeared;
  // isolated by disabling the two imports and watching it come back), so the whole approach is out.
  //
  // What this does instead is the convention the rest of the renderer already uses and that works
  // here every run (`materialSynthesis.ts`, the aircraft paint): author the bytes on the CPU and
  // upload them through `RawTexture`, keeping the Babylon boundary small. The 2D canvas is ours, the
  // pages draw into it, and `uploadDisplayAtlas` hands the pixels over.
  //
  // No `document` means no canvas, which is the headless case -- every Node test -- and returns null.
  try {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = DISPLAY_ATLAS_WIDTH;
    canvas.height = DISPLAY_ATLAS_HEIGHT;
    const context = canvas.getContext("2d") as unknown as DisplayContext2D | null;
    if (!context || typeof context.fillRect !== "function") return null;
    const texture = RawTexture.CreateRGBATexture(
      new Uint8Array(DISPLAY_ATLAS_WIDTH * DISPLAY_ATLAS_HEIGHT * 4),
      DISPLAY_ATLAS_WIDTH,
      DISPLAY_ATLAS_HEIGHT,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    texture.name = name;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return { texture, context, canvas, slots: displaySlots(), width: DISPLAY_ATLAS_WIDTH, height: DISPLAY_ATLAS_HEIGHT };
  } catch (error) {
    // KEPT, not swallowed. A silent catch here is what made the first live failure so slow to find:
    // the screens simply stayed flat, which looks exactly like the headless path working as intended.
    // Whatever went wrong is readable afterwards instead of needing the code re-instrumented.
    lastDisplayAtlasError = String((error as Error)?.stack ?? error);
    return null;
  }
}

/** Why the last `createDisplayAtlas` returned null, if it was an error rather than a missing canvas. */
export let lastDisplayAtlasError: string | null = null;

/** Hand the canvas's pixels to the GPU. Called after the pages have drawn, at `DISPLAY_UPDATE_HZ`. */
export function uploadDisplayAtlas(atlas: DisplayAtlas): void {
  const context = atlas.canvas.getContext("2d");
  if (!context) return;
  const pixels = context.getImageData(0, 0, atlas.width, atlas.height);
  atlas.texture.update(new Uint8Array(pixels.data.buffer));
}

/** The screens' material when the displays are live: black albedo, white emissive, the atlas as the emissive image. */
export function displayMaterial(build: AircraftBuildContext, name: string, atlas: DisplayAtlas): PBRMaterial {
  const material = build.material(name, 0x000000, { roughness: 1, metallic: 0 });
  material.emissiveColor = new Color3(1, 1, 1);
  material.emissiveTexture = atlas.texture;
  material.environmentIntensity = 0;
  return material;
}

/**
 * THE STUB PAINTER, until the drawing module lands. Three things, each earning its place in a frame:
 * a flat colour a slot proves WHICH screen samples which slot; a small bright square in the slot's
 * top-left corner proves the face is not mirrored or upside down, which six flat colours could not;
 * and a bar across the bottom whose length tracks airspeed proves the ADAPTER is feeding live values
 * rather than the picture being a static image. All three go when the real pages arrive.
 */
const STUB_COLOURS: Readonly<Record<DisplaySlotName, string>> = Object.freeze({
  "port-pfd": "#12406b",
  "port-nd": "#0d5c3a",
  "port-eicas": "#6b4a12",
  "starboard-eicas": "#6b2f12",
  "starboard-nd": "#3a0d5c",
  "starboard-pfd": "#12566b",
});

export function paintStubAtlas(atlas: DisplayAtlas, state: DisplayState): void {
  // 0 at a standstill, full width by 400 kt: a 747 cruises well inside that, so the bar moves
  const speedFraction = Math.min(1, Math.max(0, state.airspeedKt / 400));
  for (const slot of atlas.slots) {
    atlas.context.fillStyle = STUB_COLOURS[slot.name];
    atlas.context.fillRect(slot.x, slot.y, slot.width, slot.height);
    atlas.context.fillStyle = "#f2f6ff";
    atlas.context.fillRect(slot.x + 12, slot.y + 12, 40, 18);
    atlas.context.fillRect(slot.x + 12, slot.y + slot.height - 30, (slot.width - 24) * speedFraction, 12);
  }
}

/** Only the merged screens mesh may carry the atlas: a stray user would be a second draw state. */
export function isScreensMesh(mesh: AbstractMesh): boolean {
  return mesh.name === "airliner-screens";
}
