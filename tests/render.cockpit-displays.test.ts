import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { resolveAircraftAnimationPose } from "../src/render/webgpu/aircraft/animation";
import {
  AIRLINER_DISPLAY_AIRFRAME,
  AIRLINER_SCREENS,
  airlinerScreenPlacements,
} from "../src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import {
  BIZJET_DISPLAY_AIRFRAME,
  BIZJET_SCREENS,
  bizjetScreenPlacements,
} from "../src/render/webgpu/aircraft/cockpit/bizjetCockpit";
import { AircraftBuildContext } from "../src/render/webgpu/aircraft/builders";
import {
  AIRLINER_DISPLAYS,
  BIZJET_DISPLAYS,
  createDisplayAtlas,
  paintDisplays,
  DISPLAY_SLOT_HEIGHT,
  DISPLAY_SLOT_WIDTH,
  type DisplayLayout,
  displayAtlasHeight,
  displayAtlasWidth,
  displaySlots,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayAtlas";
import { drawDisplayAtlas } from "../src/render/webgpu/aircraft/cockpit/displays/displayPages";
import {
  displayStateFromVisual,
  type DisplayAirframe,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayStateFromVisual";
import { createRecordingContext } from "./support/recordingContext";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import type { AircraftKind } from "../src/sim";

/**
 * Both glass decks: which screen samples which slot, and that the whole live path runs without a GPU.
 *
 * THE HEADLESS PATH IS THE DEFAULT HERE, and deliberately so. Every Node test builds under
 * `NullEngine`, which has no 2D canvas, so `createDisplayAtlas` returns null and the screens keep
 * their flat material. That is asserted rather than assumed: a suite that silently drew nothing
 * would look exactly like a suite whose displays work.
 *
 * The drawing itself is covered without an engine at all, by running the painter against a RECORDING
 * context. That is the same shape the drawing module's own tests use, so the page code and this
 * integration meet on one interface.
 *
 * EVERY ROW BELOW IS RUN FOR BOTH AEROPLANES, because the machinery is shared and a deck-shaped
 * mistake in it (a slot table that fits six and not four) shows up only where the shapes differ. The
 * 747 has six screens three across; the Global has four, two across, and no EICAS page -- see
 * `BIZJET_DISPLAYS` for why its engine page would print a label this aeroplane's own HUD contradicts.
 * Both real decks happen to be TWO rows deep, so a mistake that only shows at another depth (an atlas
 * sized for two rows whatever the screen count) is held by synthetic layouts at the end of the file.
 */

interface Deck {
  readonly kind: AircraftKind;
  readonly label: string;
  readonly layout: DisplayLayout;
  /** The material the screens keep when there is no canvas. */
  readonly flatMaterial: string;
  readonly placements: () => readonly { readonly name: string; readonly centre: Vector3 }[];
  readonly screen: { readonly width: number; readonly height: number };
  readonly airframe: DisplayAirframe;
  /** What each screen's NAME says it must draw. */
  readonly pages: Readonly<Record<string, string>>;
}

const DECKS: readonly Deck[] = [
  {
    kind: "airliner",
    label: "747",
    layout: AIRLINER_DISPLAYS,
    flatMaterial: "airliner-instrument-face",
    placements: airlinerScreenPlacements,
    screen: { width: AIRLINER_SCREENS.width, height: AIRLINER_SCREENS.height },
    airframe: AIRLINER_DISPLAY_AIRFRAME,
    pages: {
      "port-pfd": "pfd",
      "starboard-pfd": "pfd",
      "port-nd": "nd",
      "starboard-nd": "nd",
      // the two centre screens are the EICAS pair, upper on the port side as the panel is laid out
      "port-eicas": "eicas-upper",
      "starboard-eicas": "eicas-lower",
    },
  },
  {
    kind: "bizjet",
    label: "Global",
    layout: BIZJET_DISPLAYS,
    flatMaterial: "bizjet-instrument-face",
    placements: bizjetScreenPlacements,
    screen: { width: BIZJET_SCREENS.width, height: BIZJET_SCREENS.height },
    airframe: BIZJET_DISPLAY_AIRFRAME,
    pages: {
      // each seat: a PFD on the outboard screen, the map inboard
      "port-outboard": "pfd",
      "port-inboard": "nd",
      "starboard-outboard": "pfd",
      "starboard-inboard": "nd",
    },
  },
];

/**
 * THE AIRFRAME CONSTANTS THE PAGES CANNOT READ OFF THE FLIGHT STATE, held to their PRODUCERS.
 *
 * `DisplayAirframe` carries two numbers a page needs and a `FlightVisualState` does not have: how
 * many engines to draw a gauge for, and what full flap means in degrees. Both are easy to write down
 * from memory and impossible to notice when wrong -- an EICAS drawing four gauges on a twin, or a
 * flap readout scaled by the wrong travel, is a plausible picture. So neither is compared with a
 * literal here: the engine count is counted off the BUILT nacelles, and the flap travel is taken
 * from the animation's own pose at full flap, which is the code that actually moves the panels.
 * (A mutation that gave the Global the 747's four engines passed everything until this existed.)
 */
describe.each(DECKS.map((deck) => [deck.label, deck] as const))("the %s's display airframe", (_label, deck) => {
  it("counts its engines off the built nacelles and takes full flap from the animation, not from a literal", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    try {
      const aircraft = createWebGpuAircraft(scene, deck.kind);
      // TWO INDEPENDENT COUNTS of the same thing, because one regexp that matched nothing would
      // read as an aeroplane with no engines and pass a `toBe(0)`: the fans the visual spins, one
      // per engine, and the inlets they sit behind.
      // over AUTHORED part names, live meshes and merged sources alike: the 747's inlets are folded
      // into a static mesh and only their `mergedFrom` names survive, while its fans still spin
      const authored = new Set<string>();
      for (const mesh of aircraft.meshes) {
        const sources = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom;
        if (sources) for (const source of sources) authored.add(source);
        else authored.add(mesh.name);
      }
      const count = (pattern: RegExp) => [...authored].filter((name) => pattern.test(name)).length;
      const fans = count(/fan-spool-fan$/);
      const inlets = count(/-engine-inlet$/);
      expect(fans, `${deck.label}: fans found to count`).toBeGreaterThan(0);
      expect(inlets, `${deck.label}: inlets found to count`).toBe(fans);
      expect(deck.airframe.engineCount, "gauges drawn against engines built").toBe(fans);

      // `flap` is trailing-edge-down radians at the state given; at flaps 1 it is the type's full travel
      const pose = resolveAircraftAnimationPose(deck.kind, { ...INITIAL_VISUAL_STATE, flaps: 1 });
      expect(deck.airframe.fullFlapDegrees).toBeCloseTo((pose.flap * 180) / Math.PI, 6);
      // and the adapter reports exactly that when the flaps are out
      const state = displayStateFromVisual({ ...INITIAL_VISUAL_STATE, flaps: 1 }, deck.airframe);
      expect(state.flapDeg).toBeCloseTo((pose.flap * 180) / Math.PI, 6);
      expect(state.n1Percent).toHaveLength(fans);
      aircraft.dispose();
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});

describe.each(DECKS.map((deck) => [deck.label, deck] as const))("the %s's displays", (_label, deck) => {
  let engine: NullEngine;
  let scene: Scene;
  let aircraft: AircraftVisual;
  const atlasWidth = displayAtlasWidth(deck.layout);
  const atlasHeight = displayAtlasHeight(deck.layout);

  const screensMesh = () => {
    const found = scene.getMeshByName(deck.layout.screensMesh);
    if (!found) throw new Error(`missing mesh ${deck.layout.screensMesh}`);
    return found;
  };

  beforeAll(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.activeCamera = new UniversalCamera("displays-camera", Vector3.Zero(), scene);
    aircraft = createWebGpuAircraft(scene, deck.kind);
    aircraft.root.computeWorldMatrix(true);
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  });
  afterAll(() => {
    aircraft.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("keeps the screens on their flat material where there is no 2D canvas, and says so", () => {
    expect(aircraft.displaysLive, "NullEngine has no 2D canvas, so nothing should be drawing").toBe(false);
    // the screens still share the instrument-face material the boxes were built with:
    // one mesh, one material, exactly as before the displays existed
    const screens = screensMesh();
    expect(screens.material).not.toBeNull();
    expect(screens.material!.name).toBe(deck.flatMaterial);
    // and updating in cockpit view must not throw when there is no atlas to draw into
    aircraft.setCockpitView(true);
    expect(() => aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 12, pitch: -3 }, 1 / 60)).not.toThrow();
    aircraft.setCockpitView(false);
  });

  it("gives each screen its own slot of the atlas, u AND v, the right way up, in the order the screens are built", () => {
    // Measured off the MERGED mesh, which is what samples the texture: for each screen, the four
    // vertices of its pilot-facing face (normal -X) must carry the u AND v ranges of its own slot.
    // This is the pairing a swapped slot table would break, and the frames would then show the PFD's
    // picture on the ND. V MATTERS AS MUCH AS U: slots in one column share a u range, so a screen
    // pointed at the wrong ROW -- or every slot collapsed onto the top row -- passes a u-only check.
    const screens = screensMesh();
    const positions = screens.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = screens.getVerticesData(VertexBuffer.NormalKind)!;
    const uvs = screens.getVerticesData(VertexBuffer.UVKind)!;
    const placements = deck.placements();
    expect(placements).toHaveLength(deck.layout.screens.length);
    // half a screen plus 5 mm: wide enough to take one screen's own face, narrow enough to exclude
    // its neighbour's (the pairs are 0.245 apart centre to centre on both decks)
    const reach = deck.screen.width / 2 + 0.005;
    const slots = displaySlots(deck.layout);
    for (const [index, placement] of placements.entries()) {
      // the face's vertices: normal -X, and at this screen's own z
      const face: { y: number; z: number; u: number; v: number }[] = [];
      for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
        if (normals[vertex * 3]! > -0.9) continue;
        if (Math.abs(positions[vertex * 3 + 2]! - placement.centre.z) > reach) continue;
        face.push({ y: positions[vertex * 3 + 1]!, z: positions[vertex * 3 + 2]!, u: uvs[vertex * 2]!, v: uvs[vertex * 2 + 1]! });
      }
      expect(face.length, `${placement.name}: pilot-facing vertices`).toBe(4);
      const slot = slots[index]!;
      expect(slot.screen, `slot ${index} belongs to ${placement.name}`).toBe(placement.name);
      const us = face.map((corner) => corner.u);
      const vs = face.map((corner) => corner.v);
      expect(Math.min(...us), `${placement.name}: u from`).toBeCloseTo(slot.x / atlasWidth, 6);
      expect(Math.max(...us), `${placement.name}: u to`).toBeCloseTo((slot.x + slot.w) / atlasWidth, 6);
      expect(Math.min(...vs), `${placement.name}: v from`).toBeCloseTo(slot.y / atlasHeight, 6);
      expect(Math.max(...vs), `${placement.name}: v to`).toBeCloseTo((slot.y + slot.h) / atlasHeight, 6);
      // THE RIGHT WAY UP: the face's TOP edge samples the slot's top row, i.e. the smaller v. A
      // texture's v and a canvas's y run opposite ways here, which the first live 747 frame showed
      // by drawing every page upside down; this holds the fix.
      const topY = Math.max(...face.map((corner) => corner.y));
      for (const corner of face.filter((c) => Math.abs(c.y - topY) < 1e-6)) {
        expect(corner.v, `${placement.name}: its top edge samples the slot's top`).toBeCloseTo(slot.y / atlasHeight, 6);
      }
      // THE SCREEN'S OWN SHAPE, from the built face rather than the builder's constant: the slot
      // must be drawn at the aspect the pilot actually sees, or every page is squashed
      const built = (Math.max(...face.map((c) => c.z)) - Math.min(...face.map((c) => c.z)))
        / (Math.max(...face.map((c) => c.y)) - Math.min(...face.map((c) => c.y)));
      expect(slot.w / slot.h, `${placement.name}: slot aspect against the built face`).toBeCloseTo(built, 3);
    }
  });

  it("costs no extra draw: still one screens mesh on one material", () => {
    const stem = `${deck.kind === "airliner" ? "airliner" : "bizjet"}-screen`;
    const screenMeshes = aircraft.meshes.filter((mesh) => mesh.name.startsWith(stem));
    expect(screenMeshes.map((mesh) => mesh.name).sort()).toEqual([`${stem}-bezels`, `${stem}s`].sort());
    // every screen in one mesh, every bezel in another, as before the atlas
    expect((screensMesh().metadata as { mergedFrom?: string[] }).mergedFrom).toHaveLength(deck.layout.screens.length);
  });

  it("runs the adapter and every page this deck shows over its own slots, without an engine", () => {
    // The live path, covered with no GPU and no canvas: the same recording context the pages' own
    // tests use, so the page code and this integration meet on one interface.
    const context = createRecordingContext();
    const slots = displaySlots(deck.layout);
    const state = displayStateFromVisual(
      { ...INITIAL_VISUAL_STATE, airspeed: 128.6, altitude: 3_048, heading: 237.5, bank: 18.5, engineRpm: 88 },
      deck.airframe,
    );
    drawDisplayAtlas(context, atlasWidth, atlasHeight, slots, state);

    // every slot was drawn into: each one clips to its own rectangle first
    const clipRects = context.calls
      .filter((call) => call.method === "rect")
      .map((call) => call.args.map(Number));
    for (const slot of slots) {
      expect(
        clipRects.some(([x, y, w, h]) => x === slot.x && y === slot.y && w === slot.w && h === slot.h),
        `${slot.screen} (${slot.page}) was not clipped to its own rectangle`,
      ).toBe(true);
    }
    // the deck's own page kinds appear, and its slots cover its atlas exactly
    expect(new Set(slots.map((slot) => slot.page))).toEqual(new Set(Object.values(deck.pages)));
    const covered = slots.reduce((sum, slot) => sum + slot.w * slot.h, 0);
    expect(covered).toBe(atlasWidth * atlasHeight);
    // a summed area cannot see two slots stacked on each other (every slot on row 0 still sums
    // right), so no two may overlap: with that, the areas adding up means they TILE the atlas
    for (const [i, a] of slots.entries()) {
      for (const b of slots.slice(i + 1)) {
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.screen} and ${b.screen} overlap in the atlas`).toBe(false);
      }
    }
    // and nothing was drawn outside the atlas
    for (const [x, y, w, h] of clipRects) {
      expect(x!).toBeGreaterThanOrEqual(0);
      expect(x! + w!).toBeLessThanOrEqual(atlasWidth);
      expect(y! + h!).toBeLessThanOrEqual(atlasHeight);
    }
  });

  it("draws each screen the page its NAME says, so a swapped slot table cannot pass", () => {
    // The screens are named for what they are, and that is the only ground truth for which page
    // belongs on which: a pilot's PFD screen must draw the PFD. Pairing screens to RECTANGLES is
    // not enough -- swapping two `page` values leaves every rectangle and every UV untouched, and a
    // mutation that put the PFD's picture on the ND passed the whole suite until this existed.
    const slots = displaySlots(deck.layout);
    expect(slots.map((slot) => slot.screen).sort()).toEqual(Object.keys(deck.pages).sort());
    for (const slot of slots) {
      expect(slot.page, `${slot.screen} draws the wrong page`).toBe(deck.pages[slot.screen]);
    }
    // and each screen's name matches the placement it was built from, so the table cannot drift
    // from the geometry either
    for (const [index, placement] of deck.placements().entries()) {
      expect(slots[index]!.screen).toBe(placement.name);
    }
  });

  it("gives every slot the screens' own shape, not a square, and the atlas the rows its screens need", () => {
    // Both decks' screens measure 0.22 x 0.15 m on the BUILT mesh. A square slot squashes every
    // page, whatever its resolution.
    const shape = deck.screen.width / deck.screen.height;
    expect(DISPLAY_SLOT_WIDTH / DISPLAY_SLOT_HEIGHT).toBeCloseTo(shape, 2);
    for (const slot of displaySlots(deck.layout)) expect(slot.w / slot.h).toBeCloseTo(shape, 2);
    // the atlas is exactly as big as the deck needs: a size fixed for one deck would waste or clip
    const rows = Math.ceil(deck.layout.screens.length / deck.layout.columns);
    expect(atlasWidth).toBe(DISPLAY_SLOT_WIDTH * deck.layout.columns);
    expect(atlasHeight).toBe(DISPLAY_SLOT_HEIGHT * rows);
    expect(deck.layout.screens.length).toBe(deck.layout.columns * rows);
  });
});

/**
 * THE LIVE PATH, END TO END, WITH NO GPU AND NO BROWSER.
 *
 * Everything above runs the headless branch, where `createDisplayAtlas` finds no `document` and the
 * screens keep their flat material. That leaves the half that actually ships -- create the canvas,
 * draw the pages into it, hand the pixels to the texture, do it fifteen times a second and not once a
 * frame, and draw at once on coming back into the cockpit -- covered only by looking at a frame.
 * Mutations proved the gap rather than argued it: sizing the Global's atlas from the 747's layout,
 * deleting the redraw from the cockpit's `update`, deleting the UPLOAD so every screen stays black,
 * and doubling the redraw rate each passed the whole suite at some point, and each fails here now.
 *
 * So this stands a MINIMAL `document` in front of one build. `createDisplayAtlas` is the only thing
 * in an aircraft build that touches `document` at all (grep says so), the stub hands back a canvas
 * whose 2D context is the recording context the pages' own tests use, and `RawTexture` and its
 * `update` work under `NullEngine` -- measured, not assumed. The atlas texture's `update` is wrapped
 * to count the uploads and their size, which is what a screen actually shows. The global is set and
 * restored inside each test, and vitest gives this file its own worker, so nothing else sees it.
 */
describe.each(DECKS.map((deck) => [deck.label, deck] as const))("the %s's displays, live", (_label, deck) => {
  interface StubCanvas {
    width: number;
    height: number;
    getContext(kind: string): unknown;
  }
  interface Live {
    aircraft: AircraftVisual;
    scene: Scene;
    canvas: StubCanvas;
    context: ReturnType<typeof createRecordingContext>;
    /** One entry per `RawTexture.update` on the atlas: the byte count handed to the GPU. */
    uploads: number[];
    /** One entry per `getImageData` the upload read the canvas with. */
    readbacks: number;
  }

  /** Build one aircraft with the stub in place, hand it to `body`, and put the world back. */
  function withLiveCanvas<T>(body: (live: Live) => T): T {
    const context = createRecordingContext();
    const live = { uploads: [] as number[], readbacks: 0 } as Live;
    const canvas: StubCanvas = {
      width: 0,
      height: 0,
      getContext(kind: string) {
        if (kind !== "2d") return null;
        // `uploadDisplayAtlas` asks the canvas for its pixels: count the reads, and hand back bytes of
        // the canvas's size so the upload's size can be checked against the atlas's
        return Object.assign(context, {
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            live.readbacks += 1;
            return { data: new Uint8ClampedArray(w * h * 4) };
          },
        });
      },
    };
    const globals = globalThis as { document?: unknown };
    const had = Object.prototype.hasOwnProperty.call(globals, "document");
    const previous = globals.document;
    globals.document = { createElement: (tag: string) => (tag === "canvas" ? canvas : null) };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.activeCamera = new UniversalCamera("live-displays-camera", Vector3.Zero(), scene);
    try {
      const aircraft = createWebGpuAircraft(scene, deck.kind);
      aircraft.root.computeWorldMatrix(true);
      // wrap the atlas texture's upload: every call is one picture handed to the screens
      const texture = scene.textures.find((candidate) => candidate.name === deck.layout.name) as
        | { update(data: ArrayBufferView): void }
        | undefined;
      if (!texture) throw new Error(`no atlas texture named ${deck.layout.name}`);
      const upload = texture.update.bind(texture);
      texture.update = (data: ArrayBufferView) => {
        live.uploads.push(data.byteLength);
        upload(data);
      };
      Object.assign(live, { aircraft, scene, canvas, context });
      return body(live);
    } finally {
      if (had) globals.document = previous;
      else delete globals.document;
      scene.dispose();
      engine.dispose();
    }
  }

  const bytes = displayAtlasWidth(deck.layout) * displayAtlasHeight(deck.layout) * 4;

  it("sizes the canvas and the texture from ITS OWN layout, and puts the atlas on the screens", () => {
    withLiveCanvas(({ aircraft, scene, canvas }) => {
      expect(aircraft.displaysLive, "the stub canvas should have given a live atlas").toBe(true);
      // the atlas is the deck's own shape: a size taken from another deck's layout lands here
      expect(canvas.width).toBe(displayAtlasWidth(deck.layout));
      expect(canvas.height).toBe(displayAtlasHeight(deck.layout));
      const texture = scene.textures.find((candidate) => candidate.name === deck.layout.name);
      expect(texture!.getSize()).toEqual({ width: displayAtlasWidth(deck.layout), height: displayAtlasHeight(deck.layout) });
      // and it is the screens' emissive image, on one mesh, with the flat material left behind
      const screens = scene.getMeshByName(deck.layout.screensMesh)!;
      expect(screens.material!.name).not.toBe(deck.flatMaterial);
      expect((screens.material as { emissiveTexture?: { name: string } }).emissiveTexture?.name).toBe(deck.layout.name);
    });
  });

  it("draws every page AND hands the whole atlas to the texture on the first cockpit frame, and nothing outside it", () => {
    withLiveCanvas((live) => {
      // NOT destructured: `readbacks` is a number, and a destructured copy would read 0 forever
      const { aircraft, context, uploads } = live;
      const slots = displaySlots(deck.layout);
      const clipped = () => {
        const rects = context.calls.filter((call) => call.method === "rect").map((call) => call.args.map(Number));
        return slots.filter((slot) => rects.some(([x, y, w, h]) => x === slot.x && y === slot.y && w === slot.w && h === slot.h)).length;
      };
      // nothing is drawn or uploaded before the cockpit is entered, however much state arrives
      aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 5 }, 1 / 60);
      expect(context.calls.length, "an exterior-view update drew on the displays").toBe(0);
      expect(uploads, "an exterior-view update uploaded").toEqual([]);

      aircraft.setCockpitView(true);
      aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 5, pitch: 2 }, 1 / 60);
      expect(clipped(), "every slot drawn on the first cockpit update").toBe(slots.length);
      // THE UPLOAD: a drawn canvas the texture never receives is a black screen with every draw
      // call present, so the picture is counted where the screens read it
      expect(uploads, "one upload of the whole atlas").toEqual([bytes]);
      expect(live.readbacks, "one readback per upload").toBe(1);
      aircraft.setCockpitView(false);
    });
  });

  it("redraws at 15 Hz exactly, not faster and not per frame, whatever the frame rate", () => {
    withLiveCanvas(({ aircraft, uploads }) => {
      aircraft.setCockpitView(true);
      // one second of frames at two very different rates. The redraw happens on the first frame and
      // then each time 1/15 s of frames has gone by, so a second holds 15 of them -- not 30 (a halved
      // threshold or DISPLAY_UPDATE_HZ at 30), not 60 (no counter at all)
      for (const fps of [600, 90]) {
        uploads.length = 0;
        aircraft.setCockpitView(false);
        aircraft.setCockpitView(true);
        for (let frame = 0; frame < fps; frame += 1) aircraft.update({ ...INITIAL_VISUAL_STATE, bank: frame % 30 }, 1 / fps);
        expect(uploads.length, `redraws in one second at ${fps} fps`).toBeGreaterThanOrEqual(15);
        expect(uploads.length, `redraws in one second at ${fps} fps`).toBeLessThanOrEqual(16);
        for (const size of uploads) expect(size).toBe(bytes);
      }
      aircraft.setCockpitView(false);
    });
  });

  /**
   * A `document` whose every canvas is recorded, for builds that make more than one: each build makes
   * its own atlas canvas, and what happens to each one on dispose is what is being checked.
   */
  function withManyCanvases<T>(body: (canvases: StubCanvas[], scene: Scene) => T): T {
    const canvases: StubCanvas[] = [];
    const globals = globalThis as { document?: unknown };
    const had = Object.prototype.hasOwnProperty.call(globals, "document");
    const previous = globals.document;
    globals.document = {
      createElement: (tag: string) => {
        if (tag !== "canvas") return null;
        const context = createRecordingContext();
        const canvas: StubCanvas = {
          width: 0,
          height: 0,
          getContext: (kind: string) => (kind === "2d"
            ? Object.assign(context, { getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) })
            : null),
        };
        canvases.push(canvas);
        return canvas;
      },
    };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    try {
      return body(canvases, scene);
    } finally {
      if (had) globals.document = previous;
      else delete globals.document;
      scene.dispose();
      engine.dispose();
    }
  }

  it("gives its atlas back when disposed: after two builds and two disposes the scene holds no atlas and no sized canvas", () => {
    // The atlas used to be created against the scene, so `visual.dispose()` left it behind: every
    // build-and-dispose of this deck in one scene kept one (3.17 MB on the 747, 2.11 MB on the Global).
    // The shipped app disposes the whole scene on an aircraft switch, which freed it there; a visual
    // disposed while its scene lives on did not. It is the build's now, on the list
    // `build.disposeMaterials()` frees.
    withManyCanvases((canvases, scene) => {
      const before = new Set(scene.textures);
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        const visual = createWebGpuAircraft(scene, deck.kind);
        // NON-VACUITY: this build made a LIVE atlas, so there is one to leak
        expect(scene.textures.some((t) => t.name === deck.layout.name), `cycle ${cycle}: a live atlas was made`).toBe(true);
        visual.dispose();
        // what is left is what was there before the first build, and nothing else of the aircraft's --
        // except Babylon's per-scene environment BRDF lookup, which the first PBR material creates and
        // the SCENE owns (`scene.environmentBRDFTexture`), shared by every PBR material it will ever draw
        const left = scene.textures.filter((t) => !before.has(t) && t !== scene.environmentBRDFTexture);
        expect(left.map((t) => t.name), `cycle ${cycle}: textures the aircraft left behind`).toEqual([]);
      }
      // and each build's canvas was sized to nothing when its texture went, releasing its backing store
      expect(canvases, "one atlas canvas per build").toHaveLength(2);
      for (const canvas of canvases) expect([canvas.width, canvas.height], "a disposed atlas's canvas").toEqual([0, 0]);
    });
  });

  it("makes a late redraw of a disposed atlas harmless: nothing drawn, nothing uploaded, nothing thrown", () => {
    // The visuals stop redrawing once they are disposed; this is the atlas's own guard for a call that
    // comes late anyway. `RawTexture.update` on a disposed texture throws.
    withManyCanvases((canvases, scene) => {
      const build = new AircraftBuildContext(scene);
      const atlas = createDisplayAtlas(build, deck.layout)!;
      expect(atlas, "the stub document gives a live atlas").not.toBeNull();
      const state = displayStateFromVisual({ ...INITIAL_VISUAL_STATE, bank: 10 }, deck.airframe);
      // a live one draws (the control for "nothing drawn" below)
      paintDisplays(atlas, state);
      const drawnLive = (atlas.context as ReturnType<typeof createRecordingContext>).calls.length;
      expect(drawnLive, "a live atlas draws").toBeGreaterThan(50);
      build.disposeMaterials();
      expect(atlas.texture.getInternalTexture(), "the build disposed the atlas's texture").toBeNull();
      expect([canvases[0]!.width, canvases[0]!.height], "and released its canvas").toEqual([0, 0]);
      expect(() => paintDisplays(atlas, state)).not.toThrow();
      expect((atlas.context as ReturnType<typeof createRecordingContext>).calls.length, "a disposed atlas draws nothing").toBe(drawnLive);
    });
  });

  it("draws at once on coming BACK into the cockpit, not after the rest of a stale 1/15 s", () => {
    withLiveCanvas(({ aircraft, uploads }) => {
      aircraft.setCockpitView(true);
      aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 30 }, 1 / 60);
      expect(uploads).toHaveLength(1);
      // leave straight after a redraw -- the case where the clock has the most left to run -- and fly on
      aircraft.setCockpitView(false);
      for (let frame = 0; frame < 120; frame += 1) aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 0 }, 1 / 60);
      expect(uploads, "nothing is uploaded while the cockpit is not in view").toHaveLength(1);
      // back in: the very first frame must carry the level wings the aeroplane has now, not the
      // 30 degree bank it had when the pilot left
      aircraft.setCockpitView(true);
      aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 0 }, 1 / 60);
      expect(uploads, "the first frame back redrew").toHaveLength(2);
      // and entering twice without leaving is not a second invalidate: a frame later is not due
      aircraft.setCockpitView(true);
      aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 0 }, 1 / 60);
      expect(uploads, "a repeated enter forced a redraw").toHaveLength(2);
      aircraft.setCockpitView(false);
    });
  });
});

/**
 * THE ATLAS AT DEPTHS NO REAL DECK HAS. Both shipped decks are two rows deep (six three across,
 * four two across), so a sizing rule that only works for two rows -- `DISPLAY_SLOT_HEIGHT * 2`, say --
 * passes every test that uses them. These layouts are made up for the purpose, and the rules they
 * hold are the ones any deck relies on: as many rows as the screens need and no more, every slot
 * inside the atlas, and no two slots on top of each other.
 */
describe("the atlas's shape, for layouts no aeroplane has yet", () => {
  const made = (count: number, columns: number): DisplayLayout => ({
    name: `made-${count}-${columns}`,
    screensMesh: "none",
    columns,
    screens: Array.from({ length: count }, (_, i) => ({ screen: `screen-${i}`, page: "pfd" as const })),
  });
  it.each([
    [1, 1, 1],
    [3, 3, 1],
    [5, 2, 3],
    [6, 2, 3],
    [7, 3, 3],
    [9, 3, 3],
  ])("puts %i screens %i across in %i rows, every slot inside and none overlapping", (count, columns, rows) => {
    const layout = made(count, columns);
    expect(displayAtlasWidth(layout)).toBe(DISPLAY_SLOT_WIDTH * columns);
    expect(displayAtlasHeight(layout)).toBe(DISPLAY_SLOT_HEIGHT * rows);
    const slots = displaySlots(layout);
    expect(slots).toHaveLength(count);
    for (const [i, a] of slots.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(displayAtlasWidth(layout));
      expect(a.y + a.h).toBeLessThanOrEqual(displayAtlasHeight(layout));
      for (const b of slots.slice(i + 1)) {
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${a.screen} / ${b.screen}`).toBe(false);
      }
    }
  });
});
