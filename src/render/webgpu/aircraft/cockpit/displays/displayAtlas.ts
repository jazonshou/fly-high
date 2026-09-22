import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AircraftBuildContext } from "../../builders";
import type { DisplayContext2D, DisplayState } from "./displayState";
import { drawDisplayAtlas, type DisplayPage, type DisplaySlot } from "./displayPages";

/**
 * A flight deck's displays as ONE texture, and the plumbing that gets it onto the screens.
 *
 * ONE atlas, one material, one mesh: an aeroplane's screen boxes are already merged into a single
 * mesh, and a texture each would be a material and a draw each. Each box's face toward the pilot is
 * given the UVs of its own slot BEFORE the merge, so the merged mesh samples several different
 * pictures out of one image with no extra draw.
 *
 * WHAT IS PER-AEROPLANE is the LAYOUT (`DisplayLayout`): which screens there are, in the order the
 * cockpit builds them, what page each one shows, and how many across the atlas is. Everything else
 * -- the slot shape, the canvas, the texture, the upload, the material -- is shared, because it
 * measured the same on both decks (see `DISPLAY_SLOT_WIDTH`).
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

/** One aeroplane's deck: its screens in BUILD order, the page each shows, and the atlas's shape. */
export interface DisplayLayout {
  /** The atlas texture's name, and the stem of the material's. */
  readonly name: string;
  /** The merged mesh that samples this atlas, so a stray user can be told from the real one. */
  readonly screensMesh: string;
  /** Screens in the order the cockpit builds them: slot i belongs to screen i. */
  readonly screens: readonly { readonly screen: string; readonly page: DisplayPage }[];
  /** Slots across the atlas; the rows follow from the count. */
  readonly columns: number;
}

/**
 * The 747's six, in the order `airlinerCockpit.ts` builds them (`SCREEN_Z`). Both pilots get a PFD
 * and an ND; the two centre screens are the EICAS pair.
 */
export const AIRLINER_DISPLAYS: DisplayLayout = Object.freeze({
  name: "airliner-displays",
  screensMesh: "airliner-screens",
  columns: 3,
  screens: Object.freeze([
    { screen: "port-pfd", page: "pfd" },
    { screen: "port-nd", page: "nd" },
    { screen: "port-eicas", page: "eicas-upper" },
    { screen: "starboard-eicas", page: "eicas-lower" },
    { screen: "starboard-nd", page: "nd" },
    { screen: "starboard-pfd", page: "pfd" },
  ] as const satisfies readonly { screen: string; page: DisplayPage }[]),
});

/**
 * The Global's four, in `bizjetScreenPlacements()` order: each seat's OUTBOARD screen then its
 * inboard one, port pair first. Each pilot gets a PFD outboard and a map inboard.
 *
 * NO EICAS PAGE HERE, and the reason is a label rather than a preference. The built panel is two
 * mirrored pairs with no engine screen in it, and the EICAS page draws the literal text "N1" beside
 * its dials while this aeroplane's engine readout in this game is N2 (`catalogue.ts`: the Global's
 * `engineReadout` is labelled N2, the 747's N1). Putting that page on this panel would print a label
 * the game's own HUD contradicts for the same aeroplane. Engine indications here want the page's
 * label taken from the airframe first, which is a change to the PAGE, not to this table.
 *
 * Only the PORT pair is ever seen: measured from the built mesh at the solved eye, the port screens
 * sit at azimuth -10.8 and +10.8 and the starboard pair at +54.9 and +61.0, outside the 75 degree
 * frame. The starboard pair is drawn because the aeroplane has it, not because anyone looks at it.
 */
export const BIZJET_DISPLAYS: DisplayLayout = Object.freeze({
  name: "bizjet-displays",
  screensMesh: "bizjet-screens",
  columns: 2,
  screens: Object.freeze([
    { screen: "port-outboard", page: "pfd" },
    { screen: "port-inboard", page: "nd" },
    { screen: "starboard-outboard", page: "pfd" },
    { screen: "starboard-inboard", page: "nd" },
  ] as const satisfies readonly { screen: string; page: DisplayPage }[]),
});

/**
 * A slot is the shape of the SCREEN IT IS DRAWN ON, not a square. Both decks' screens MEASURE
 * 0.22 x 0.15 m on the built mesh -- 1.4667:1, the 747's and the Global's alike -- and the pages are
 * authored and tested at 440 x 300, the same ratio. A square slot (the first version of this was six
 * 256 x 256 in a row) squashes every page and cramps its text; the aspect is what matters, so no
 * square atlas would have been right at any resolution. `tests/render.cockpit-displays.test.ts`
 * measures every screen's pilot-facing face off both aeroplanes' BUILT merged mesh and holds the slot
 * to the shape it finds, so a deck whose screens are a different shape fails there instead of drawing
 * squashed.
 *
 * 440 x 300 is also a measured choice rather than a starting point now. At 660 x 450 one full atlas
 * update costs 4.2 ms against 3.3 ms on this machine, and at the viewport it was measured on the
 * pilot's PFD occupies 252 x 177 device pixels, so 440 x 300 is already oversampled about 1.7x. The
 * numbers and the crossover (a canvas about 2,170 px wide) are in the findings doc.
 */
export const DISPLAY_SLOT_WIDTH = 440;
export const DISPLAY_SLOT_HEIGHT = 300;
/** The atlas is as wide as its columns and as tall as the rows its screens need. */
export function displayAtlasWidth(layout: DisplayLayout): number {
  return DISPLAY_SLOT_WIDTH * layout.columns;
}
export function displayAtlasHeight(layout: DisplayLayout): number {
  return DISPLAY_SLOT_HEIGHT * Math.ceil(layout.screens.length / layout.columns);
}
/** Redraw rate while the cockpit is in view. A display is not an animation; 15 a second is plenty. */
export const DISPLAY_UPDATE_HZ = 15;

/**
 * WHEN TO REDRAW, shared by every deck: a counter fed the frame's own delta that says "now" at most
 * `hz` times a second, and "now" on the first frame after `invalidate()`.
 *
 * THE INVALIDATE IS THE POINT OF THIS BEING A THING. The counter only runs while the cockpit is in
 * view (the visuals call `update` only then), so on leaving it stops wherever it was -- often just
 * after a redraw. Coming back, a bare counter would wait out the rest of its 1/15 s before drawing,
 * and for those frames the screens would show the attitude, heading and altitude from when the pilot
 * LAST LEFT, minutes old, behind an instant camera cut. The visuals call `invalidate()` on the way
 * in, so the first frame back is a fresh picture. The first-ever entry did not need it (the counter
 * starts due); every later one did, and a review of this code found it, not a frame.
 */
export interface DisplayRedrawClock {
  /** Feed one frame's delta; true when the displays are due to be redrawn this frame. */
  tick(secondsSinceLastUpdate: number): boolean;
  /** The next `tick` is due, whatever it is fed: call on entering cockpit view. */
  invalidate(): void;
}

export function displayRedrawClock(hz: number = DISPLAY_UPDATE_HZ): DisplayRedrawClock {
  let since = Number.POSITIVE_INFINITY;
  return {
    tick(secondsSinceLastUpdate) {
      since += Number.isFinite(secondsSinceLastUpdate) ? Math.max(0, secondsSinceLastUpdate) : 0;
      if (since < 1 / hz) return false;
      since = 0;
      return true;
    },
    invalidate() {
      since = Number.POSITIVE_INFINITY;
    },
  };
}

/** Each screen's slot, in the build order, carrying the screen's name alongside the page it draws. */
export function displaySlots(layout: DisplayLayout): readonly (DisplaySlot & { readonly screen: string })[] {
  return layout.screens.map(({ screen, page }, index) => ({
    screen,
    page,
    x: (index % layout.columns) * DISPLAY_SLOT_WIDTH,
    y: Math.floor(index / layout.columns) * DISPLAY_SLOT_HEIGHT,
    w: DISPLAY_SLOT_WIDTH,
    h: DISPLAY_SLOT_HEIGHT,
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
export function remapScreenFaceToSlot(mesh: Mesh, slot: DisplaySlot, atlasWidth: number, atlasHeight: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions || !uvs || !normals) throw new Error(`${mesh.name}: no positions, normals or UVs to remap`);
  let minimumX = Number.POSITIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) minimumX = Math.min(minimumX, positions[i]!);
  const u0 = slot.x / atlasWidth;
  const u1 = (slot.x + slot.w) / atlasWidth;
  const v0 = slot.y / atlasHeight;
  const v1 = (slot.y + slot.h) / atlasHeight;
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

/** What a live atlas is: the texture, the canvas behind it, and the slots to draw into. */
export interface DisplayAtlas {
  readonly texture: RawTexture;
  readonly context: DisplayContext2D;
  /** Read back to upload; kept so `uploadDisplayAtlas` does not have to find it again. */
  readonly canvas: HTMLCanvasElement;
  readonly slots: readonly (DisplaySlot & { readonly screen: string })[];
  readonly width: number;
  readonly height: number;
}

/**
 * Try to make the atlas. Returns null wherever there is no 2D canvas -- every Node test -- and the
 * caller then leaves the screens on their flat material.
 *
 * THE ATLAS IS OWNED BY THE BUILD THAT MADE IT, and that is why this takes the build context rather
 * than a scene. Its texture goes on `build.textures`, the list the paint synthesis's textures are on,
 * which `build.disposeMaterials()` frees when the visual is disposed. It used to be created against
 * the scene alone, so `visual.dispose()` left it behind: five build-and-dispose cycles of the 747 in
 * one scene held five atlases, 15.84 MB (the Global's, 10.56 MB), measured. The canvas goes with it:
 * when the texture is disposed the canvas is sized to zero, which releases its backing store at once
 * rather than whenever the last reference to the cockpit happens to be collected.
 *
 * WHAT THAT WAS, AND WAS NOT, in the shipped app: an aircraft switch there rebuilds the whole renderer
 * and disposes its scene, and `scene.dispose()` frees every texture in it, this one included
 * (measured). So the app never piled atlases up across switches. The defect was the visual not
 * owning what it made, which bites any path that disposes a visual and keeps its scene -- the tests,
 * and any later in-scene aircraft swap.
 */
export function createDisplayAtlas(build: AircraftBuildContext, layout: DisplayLayout): DisplayAtlas | null {
  const scene = build.scene;
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
  const width = displayAtlasWidth(layout);
  const height = displayAtlasHeight(layout);
  try {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d") as unknown as DisplayContext2D | null;
    if (!context || typeof context.fillRect !== "function") return null;
    const texture = RawTexture.CreateRGBATexture(
      new Uint8Array(width * height * 4),
      width,
      height,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    texture.name = layout.name;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    build.textures.push(texture);
    texture.onDisposeObservable.addOnce(() => {
      canvas.width = 0;
      canvas.height = 0;
    });
    return { texture, context, canvas, slots: displaySlots(layout), width, height };
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

/** Draw every page of the atlas's layout and hand the pixels to the GPU. */
export function paintDisplays(atlas: DisplayAtlas, state: DisplayState): void {
  // A disposed atlas has no texture to upload into (`RawTexture.update` on one throws); the visuals
  // stop calling this once they are disposed, and this makes a late call harmless rather than fatal.
  if (atlas.texture.getInternalTexture() === null) return;
  drawDisplayAtlas(atlas.context, atlas.width, atlas.height, atlas.slots, state);
  uploadDisplayAtlas(atlas);
}

/** Only the layout's own merged screens mesh may carry its atlas: a stray user would be a second draw state. */
export function isScreensMesh(mesh: AbstractMesh, layout: DisplayLayout): boolean {
  return mesh.name === layout.screensMesh;
}
