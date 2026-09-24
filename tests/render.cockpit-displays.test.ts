import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
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
import { JET_DISPLAY_AIRFRAME, JET_MFD, jetMfdPlacements } from "../src/render/webgpu/aircraft/cockpit/jetCockpit";
import {
  AIRLINER_DISPLAYS,
  BIZJET_DISPLAYS,
  JET_DISPLAYS,
  createDisplayAtlas,
  paintDisplays,
  DISPLAY_SLOT_HEIGHT,
  DISPLAY_SLOT_WIDTH,
  type DisplayLayout,
  displayAtlasHeight,
  displayAtlasWidth,
  displaySlots,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayAtlas";
import { drawDisplayAtlas, drawNd } from "../src/render/webgpu/aircraft/cockpit/displays/displayPages";
import {
  displayStateFromVisual,
  type DisplayAirframe,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayStateFromVisual";
import { createRecordingContext, transformedPoints, type RecordedCall } from "./support/recordingContext";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import type { AircraftKind } from "../src/sim";

/**
 * The three glass decks: which screen samples which slot, and that the whole live path runs without a GPU.
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
 * EVERY ROW BELOW IS RUN FOR ALL THREE AEROPLANES, because the machinery is shared and a deck-shaped
 * mistake in it (a slot table that fits six and not four) shows up only where the shapes differ. The
 * 747 has six screens three across; the Global has four, two across, and no EICAS page -- see
 * `BIZJET_DISPLAYS` for why its engine page would print a label this aeroplane's own HUD contradicts;
 * the F-16 has two SQUARE screens, one row of two, in slots of its own size. Two real decks are two
 * rows deep and one is one, so a mistake that only shows at another depth is held by synthetic
 * layouts at the end of the file.
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
  /** The merged bezels mesh beside the screens mesh, and a pattern every screen or bezel part, merged or not, matches. */
  readonly bezelsMesh: string;
  /** The deck's other meshes round its screens (the bezel rims and wells, P1b): not screens, and not the atlas's. */
  readonly surroundMeshes?: readonly string[];
  readonly screenParts: RegExp;
  /**
   * Two independent counts of the engines, over authored part names: one part per engine each. The
   * turbofans have a spinning fan and an inlet; the F-16's one engine has a turbine hub behind one
   * ventral inlet.
   */
  readonly engineParts: { readonly first: RegExp; readonly second: RegExp };
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
    bezelsMesh: "airliner-screen-bezels",
    surroundMeshes: ["airliner-screen-bezel-rims", "airliner-screen-wells"],
    screenParts: /^airliner-screen/,
    engineParts: { first: /fan-spool-fan$/, second: /-engine-inlet$/ },
    pages: {
      "port-pfd": "pfd",
      "starboard-pfd": "pfd",
      "port-nd": "nd",
      "starboard-nd": "nd",
      // the two centre screens are the EICAS pair: the slot table's names are from when they stood side by side
      // about the old seats, and the digest pins them; "port-eicas" is the UPPER one on the centreline, and
      // "starboard-eicas" the LOWER one under it (`airlinerScreenPlacements`)
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
    bezelsMesh: "bizjet-screen-bezels",
    surroundMeshes: ["bizjet-screen-bezel-rims", "bizjet-screen-wells"],
    screenParts: /^bizjet-screen/,
    engineParts: { first: /fan-spool-fan$/, second: /-engine-inlet$/ },
    pages: {
      // each seat: a PFD on the outboard screen, the map inboard
      "port-outboard": "pfd",
      "port-inboard": "nd",
      "starboard-outboard": "pfd",
      "starboard-inboard": "nd",
    },
  },
  {
    kind: "jet",
    label: "F-16",
    layout: JET_DISPLAYS,
    flatMaterial: "jet-instrument-face",
    placements: jetMfdPlacements,
    screen: { width: JET_MFD.width, height: JET_MFD.height },
    airframe: JET_DISPLAY_AIRFRAME,
    bezelsMesh: "jet-mfd-frames",
    surroundMeshes: ["jet-mfd-rims"],
    screenParts: /^jet-(screens|mfd-)/,
    engineParts: { first: /^jet-turbine-hub$/, second: /^jet-ventral-inlet$/ },
    pages: {
      // the type's pair: the PFD on the left MFD, the map on the right
      port: "pfd",
      starboard: "nd",
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
 * literal here: the engine count is counted off the BUILT engine parts (the turbofans' fans and inlets,
 * the F-16's one turbine hub and ventral inlet), and the flap travel is taken
 * from the animation's own pose at full flap, which is the code that actually moves the panels.
 * (A mutation that gave the Global the 747's four engines passed everything until this existed.)
 */
describe.each(DECKS.map((deck) => [deck.label, deck] as const))("the %s's display airframe", (_label, deck) => {
  it("counts its engines off the built engine parts and takes full flap from the animation, not from a literal", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    try {
      const aircraft = createWebGpuAircraft(scene, deck.kind);
      // TWO INDEPENDENT COUNTS of the same thing, because one regexp that matched nothing would
      // read as an aeroplane with no engines and pass a `toBe(0)`: one part per engine each (the
      // turbofans' spinning fans and their inlets; the F-16's turbine hub and its ventral inlet).
      // over AUTHORED part names, live meshes and merged sources alike: the 747's inlets are folded
      // into a static mesh and only their `mergedFrom` names survive, while its fans still spin
      const authored = new Set<string>();
      for (const mesh of aircraft.meshes) {
        const sources = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom;
        if (sources) for (const source of sources) authored.add(source);
        else authored.add(mesh.name);
      }
      const count = (pattern: RegExp) => [...authored].filter((name) => pattern.test(name)).length;
      const fans = count(deck.engineParts.first);
      const inlets = count(deck.engineParts.second);
      expect(fans, `${deck.label}: engines found to count`).toBeGreaterThan(0);
      expect(inlets, `${deck.label}: the second count agrees`).toBe(fans);
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


/**
 * Every piece of text a drawn atlas puts on its PFD and ND pages, with the box it must stay inside: the readout box it
 * is written in (a stroked rect just before it), else the innermost rectangular clip it is drawn under (a tape, the
 * heading strip's window, or the page's own slot). Text under a round clip (the attitude disc's rung numbers) is left
 * out: the disc clips those by design. Extents are a monospace 0.6 em a character wide and one em tall about the
 * baseline in force. Absolute atlas pixels, from a replay of the transform stack (translate, rotate, scale).
 */
function textInContainers(calls: readonly RecordedCall[], pages: readonly { x: number; y: number; w: number; h: number }[]) {
  // WHICH PAGE drew a call is the slot bracket it is in (drawDisplayAtlas: save, rect(slot), clip, ..., restore at the
  // atlas's top level), not where its anchor lands: text anchored off every page would otherwise count for none.
  let depth = 0;
  let awaitingPage = false;
  let page: { x: number; y: number; w: number; h: number } | null = null;
  interface Rect { x: number; y: number; w: number; h: number }
  type Clip = Rect | "round";
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let clips: Clip[] = [];
  const stack: { m: typeof m; clips: Clip[] }[] = [];
  let font = 10;
  let align = "start";
  let baseline = "alphabetic";
  let lastStroke: { at: number; rect: Rect } | null = null;
  const out: { text: string; box: Rect; page: Rect; left: number; top: number; width: number; height: number; kind: "readout" | "clip" }[] = [];
  const containers: { box: Rect; page: Rect }[] = [];
  const absRect = (x: number, y: number, w: number, h: number): Rect | null =>
    Math.abs(m.b) < 1e-12 && Math.abs(m.c) < 1e-12 ? { x: m.e + m.a * x, y: m.f + m.d * y, w: m.a * w, h: m.d * h } : null;
  calls.forEach((call, i) => {
    const n = (k: number) => call.args[k] as number;
    switch (call.method) {
      case "save": if (depth === 0) awaitingPage = true; depth += 1; stack.push({ m: { ...m }, clips: [...clips] }); break;
      case "restore": { depth -= 1; if (depth === 0) page = null; const top = stack.pop(); if (top) { m = top.m; clips = top.clips; } break; }
      case "translate": m = { ...m, e: m.e + m.a * n(0) + m.c * n(1), f: m.f + m.b * n(0) + m.d * n(1) }; break;
      case "rotate": { const cos = Math.cos(n(0)); const sin = Math.sin(n(0)); m = { ...m, a: m.a * cos + m.c * sin, b: m.b * cos + m.d * sin, c: -m.a * sin + m.c * cos, d: -m.b * sin + m.d * cos }; break; }
      case "scale": m = { ...m, a: m.a * n(0), b: m.b * n(0), c: m.c * n(1), d: m.d * n(1) }; break;
      case "rect":
        if (calls[i + 1]?.method === "clip") {
          const r = absRect(n(0), n(1), n(2), n(3));
          clips.push(r ?? "round");
          if (awaitingPage && r) {
            // the bracket's own slot: one of the PFD / ND pages, or a page this check leaves out (EICAS)
            page = pages.find((p) => p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h) ?? null;
            awaitingPage = false;
          } else if (page && r) containers.push({ box: r, page });
        }
        break;
      case "arc": if (calls[i + 1]?.method === "clip") clips.push("round"); break;
      case "strokeRect": { const r = absRect(n(0), n(1), n(2), n(3)); if (r) { lastStroke = { at: i, rect: r }; if (page) containers.push({ box: r, page }); } break; }
      case "set:font": font = Number(/([0-9.]+)px/.exec(String(call.args[0]))?.[1] ?? 10); break;
      case "set:textAlign": align = String(call.args[0]); break;
      case "set:textBaseline": baseline = String(call.args[0]); break;
      case "fillText": {
        const text = String(call.args[0]);
        const x = m.e + m.a * n(1) + m.c * n(2);
        const y = m.f + m.b * n(1) + m.d * n(2);
        if (!page) break;
        if (clips.includes("round")) break;
        const width = 0.6 * font * text.length;
        const left = align === "center" ? x - width / 2 : align === "right" || align === "end" ? x - width : x;
        const top = baseline === "middle" ? y - font / 2 : baseline === "top" || baseline === "hanging" ? y : baseline === "bottom" ? y - font : y - 0.8 * font;
        const readout = lastStroke !== null && i - lastStroke.at <= 8
          && x >= lastStroke.rect.x && x <= lastStroke.rect.x + lastStroke.rect.w && y >= lastStroke.rect.y && y <= lastStroke.rect.y + lastStroke.rect.h;
        const box = readout ? lastStroke!.rect : (clips.at(-1) as Rect);
        out.push({ text, box, page, left, top, width, height: font, kind: readout ? "readout" : "clip" });
        break;
      }
      default: break;
    }
  });
  return { texts: out, containers };
}

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
    // half a screen plus 5 mm, across and up: wide enough to take one screen's own face, narrow enough to
    // exclude its neighbour's (the pairs are 0.245 apart centre to centre on both decks, and the 747's two
    // EICAS stand one over the other on the centreline, 0.175 apart)
    const reach = deck.screen.width / 2 + 0.005;
    const reachUp = deck.screen.height / 2 + 0.005;
    const slots = displaySlots(deck.layout);
    for (const [index, placement] of placements.entries()) {
      // the face's vertices: normal -X, and at this screen's own z and height
      const face: { x: number; y: number; z: number; u: number; v: number }[] = [];
      for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
        if (normals[vertex * 3]! > -0.9) continue;
        if (Math.abs(positions[vertex * 3 + 2]! - placement.centre.z) > reach) continue;
        if (Math.abs(positions[vertex * 3 + 1]! - placement.centre.y) > reachUp) continue;
        face.push({ x: positions[vertex * 3]!, y: positions[vertex * 3 + 1]!, z: positions[vertex * 3 + 2]!, u: uvs[vertex * 2]!, v: uvs[vertex * 2 + 1]! });
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
      // AND THE RIGHT WAY ROUND: the face's LEFT edge as the pilot sees it (smaller z; his right is +Z) samples
      // the slot's left column, the smaller u. Checking the u range alone passed a page drawn mirror-image.
      const leftZ = Math.min(...face.map((corner) => corner.z));
      const leftEdge = face.filter((c) => Math.abs(c.z - leftZ) < 1e-6);
      expect(leftEdge.length, `${placement.name}: the face's left edge`).toBe(2);
      for (const corner of leftEdge) {
        expect(corner.u, `${placement.name}: its left edge samples the slot's left`).toBeCloseTo(slot.x / atlasWidth, 6);
      }
      // THE SCREEN'S OWN SHAPE, from the built face rather than the builder's constant: the slot
      // must be drawn at the aspect the pilot actually sees, or every page is squashed. The height is
      // measured ALONG the face, from the bottom pair of corners to the top pair: the F-16's face leans
      // back 15 degrees, and its y extent alone is the height times cos 15
      const byHeight = [...face].sort((a, b) => a.y - b.y);
      const bottomMid = { x: (byHeight[0]!.x + byHeight[1]!.x) / 2, y: (byHeight[0]!.y + byHeight[1]!.y) / 2 };
      const topMid = { x: (byHeight[2]!.x + byHeight[3]!.x) / 2, y: (byHeight[2]!.y + byHeight[3]!.y) / 2 };
      const built = (Math.max(...face.map((c) => c.z)) - Math.min(...face.map((c) => c.z)))
        / Math.hypot(topMid.x - bottomMid.x, topMid.y - bottomMid.y);
      expect(slot.w / slot.h, `${placement.name}: slot aspect against the built face`).toBeCloseTo(built, 3);
    }
  });

  it("costs no extra draw: still one screens mesh on one material", () => {
    const screenMeshes = aircraft.meshes.filter((mesh) => deck.screenParts.test(mesh.name));
    expect(screenMeshes.map((mesh) => mesh.name).sort()).toEqual([deck.bezelsMesh, ...(deck.surroundMeshes ?? []), deck.layout.screensMesh].sort());
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

  it("keeps every piece of the PFD's and the ND's text inside its readout box or its page on both axes, and across its scrolling tape or strip", () => {
    // A demanding state: five-digit altitudes on the tape and in the readout, three-digit speeds, a descent on the
    // VSI, a heading that puts labels at both ends of the ND's arc. On the F-16's square page the text was sized from
    // h and the boxes from w: the altitude labels were clipped by 14 px and the readout's digits ran 17 px out of
    // their box. The text is sized from `pageRoundScale` now; on 440 x 300 that is h, so these decks are unchanged.
    // A SCROLLING window (a tape, taller than wide; the heading strip, wider than tall) clips its labels where they
    // scroll off its ends, by design: there only the other axis is held.
    const context = createRecordingContext();
    const state = displayStateFromVisual(
      { ...INITIAL_VISUAL_STATE, airspeed: 257, altitude: 4_580, heading: 90, bank: 0, pitch: 2, verticalSpeed: -15, engineRpm: 90 },
      deck.airframe,
    );
    const slots = displaySlots(deck.layout);
    drawDisplayAtlas(context, atlasWidth, atlasHeight, slots, state);
    const pages = slots.filter((slot) => slot.page === "pfd" || slot.page === "nd");
    const { texts, containers } = textInContainers(context.calls, pages);
    // every box and window a page draws text into is itself inside that page
    expect(containers.length, "boxes and windows found").toBeGreaterThan(4);
    for (const { box, page } of containers) {
      expect(box.x, "a box or window's left, inside its page").toBeGreaterThanOrEqual(page.x - 1e-6);
      expect(box.x + box.w, "its right").toBeLessThanOrEqual(page.x + page.w + 1e-6);
      expect(box.y, "its top").toBeGreaterThanOrEqual(page.y - 1e-6);
      expect(box.y + box.h, "its bottom").toBeLessThanOrEqual(page.y + page.h + 1e-6);
    }
    expect(texts.length, "text found on the PFD and ND pages").toBeGreaterThan(20 * pages.length / 2);
    expect(texts.some((t) => t.kind === "readout" && /^1[0-9]{4}$/.test(t.text)), "a five-digit altitude readout among them").toBe(true);
    const isPage = (box: { x: number; y: number; w: number; h: number }) =>
      pages.some((p) => p.x === box.x && p.y === box.y && p.w === box.w && p.h === box.h);
    let scrolling = 0;
    for (const t of texts) {
      const window = t.kind === "clip" && !isPage(t.box);
      const scrollsVertically = window && t.box.h > t.box.w;
      const scrollsAcross = window && t.box.w >= t.box.h;
      if (window) scrolling += 1;
      const where = `"${t.text}" in its ${t.kind === "readout" ? "readout box" : window ? "scrolling window" : "page"} (${t.box.x.toFixed(1)}, ${t.box.y.toFixed(1)}, ${t.box.w.toFixed(1)} x ${t.box.h.toFixed(1)})`;
      if (!scrollsAcross) {
        expect(t.left, `${where}: left`).toBeGreaterThanOrEqual(t.box.x - 1e-6);
        expect(t.left + t.width, `${where}: right`).toBeLessThanOrEqual(t.box.x + t.box.w + 1e-6);
      }
      if (!scrollsVertically) {
        expect(t.top, `${where}: top`).toBeGreaterThanOrEqual(t.box.y - 1e-6);
        expect(t.top + t.height, `${where}: bottom`).toBeLessThanOrEqual(t.box.y + t.box.h + 1e-6);
      }
    }
    expect(scrolling, "tape and strip labels found").toBeGreaterThan(5);
  });

  it("never lets a heading label on the ND's rose touch the heading box, at any heading, and leaves labels out only where they would", () => {
    // On the F-16's square page the rose's top ran under the heading box (own ship at 234.5), and a label drawn there
    // showed as a fragment at a quarter of all headings; such a label was left out. Since its drawing is centred on
    // the page (step 5c, own ship at 317.9) the labels' ring clears the box by 74 px, and every deck draws every label.
    // A 1 degree sweep of all 360, on the page as the ND slot draws it.
    const nd = displaySlots(deck.layout).find((slot) => slot.page === "nd")!;
    let fired = 0;
    for (let heading = 0; heading < 360; heading += 1) {
      const context = createRecordingContext();
      drawNd(context, nd.w, nd.h, displayStateFromVisual({ ...INITIAL_VISUAL_STATE, heading }, deck.airframe));
      const calls = context.calls;
      const n = (call: RecordedCall, k: number) => call.args[k] as number;
      // the heading box: the one stroked rect in the page's top fifth
      const boxes = calls.filter((call) => call.method === "strokeRect" && n(call, 1) < 0.2 * nd.h);
      expect(boxes.length, `heading ${heading}: the heading box`).toBe(1);
      const [bx, by, bw, bh] = boxes[0]!.args as [number, number, number, number];
      // the rose: the largest arc, about own ship; its labels, the centred digits beyond it
      const points = transformedPoints(calls);
      const arcs = calls.flatMap((call, i) => (call.method === "arc" ? [{ r: n(call, 2), at: points.find((p) => p.index === i)! }] : []));
      const rose = arcs.reduce((a, b) => (b.r > a.r ? b : a));
      let font = 10;
      let align = "start";
      const labels: { text: string; delta: number }[] = [];
      for (const [i, call] of calls.entries()) {
        if (call.method === "set:font") font = Number(/([0-9.]+)px/.exec(String(call.args[0]))?.[1] ?? 10);
        if (call.method === "set:textAlign") align = String(call.args[0]);
        if (call.method !== "fillText" || align !== "center" || !/^[0-9]+$/.test(String(call.args[0]))) continue;
        const p = points.find((q) => q.index === i)!;
        if (Math.hypot(p.x - rose.at.x, p.y - rose.at.y) <= rose.r) continue;
        const text = String(call.args[0]);
        const half = (0.6 * font * text.length) / 2;
        const touches = p.x + half > bx && p.x - half < bx + bw && p.y + font / 2 > by && p.y - font / 2 < by + bh;
        expect(touches, `heading ${heading}: label "${text}" at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) touches the heading box`).toBe(false);
        const bearing = (Math.atan2(p.x - rose.at.x, rose.at.y - p.y) * 180) / Math.PI;
        labels.push({ text, delta: bearing });
      }
      // which labels the arc should carry: every multiple of 30 within 60 degrees either side of the heading
      const expected = [...Array(12).keys()].map((k) => k * 30).filter((tick) => Math.abs(((tick - heading + 540) % 360) - 180) <= 60);
      const missing = expected.length - labels.length;
      expect(missing, `heading ${heading}: every label drawn`).toBe(0);
      // and the ring they stand on clears the box: its top label's text at least 60 px under it on the square (74)
      const topLabel = Math.min(...labels.map((l) => Math.abs(l.delta)));
      if (deck.kind === "jet" && topLabel < 1) fired += 1;
      const clearance = rose.at.y - rose.r - 0.055 * nd.h - font / 2 - (by + bh);
      expect(clearance, `heading ${heading}: the labels' ring under the heading box`).toBeGreaterThan(deck.kind === "jet" ? 60 : 0);
    }
    // NON-VACUITY: on the square, the headings with a label within a degree of the arc's top, right under the box (one
    // a label, 12), are among those swept, and it is drawn there
    if (deck.kind === "jet") expect(fired, "headings with a label at the arc's top on the square").toBe(12);
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

  it("gives every slot the screens' own shape (square only where the screens are) and the atlas the rows its screens need", () => {
    // The 747's and the Global's screens measure 0.22 x 0.15 m on the BUILT mesh and draw into the
    // shared 440 x 300; the F-16's are square and draw into 400 x 400 of its own. A slot of the wrong
    // shape squashes every page, whatever its resolution.
    const shape = deck.screen.width / deck.screen.height;
    const slotWidth = deck.layout.slotWidth ?? DISPLAY_SLOT_WIDTH;
    const slotHeight = deck.layout.slotHeight ?? DISPLAY_SLOT_HEIGHT;
    expect(slotWidth / slotHeight).toBeCloseTo(shape, 2);
    for (const slot of displaySlots(deck.layout)) {
      expect(slot.w / slot.h).toBeCloseTo(shape, 2);
      expect([slot.w, slot.h], "every slot the deck's own size").toEqual([slotWidth, slotHeight]);
    }
    // the turbofans keep the shared size: only a deck whose screens are another shape has its own
    if (deck.kind !== "jet") expect([deck.layout.slotWidth, deck.layout.slotHeight]).toEqual([undefined, undefined]);
    else expect([slotWidth, slotHeight]).toEqual([400, 400]);
    // the atlas is exactly as big as the deck needs: a size fixed for one deck would waste or clip
    const rows = Math.ceil(deck.layout.screens.length / deck.layout.columns);
    expect(atlasWidth).toBe(slotWidth * deck.layout.columns);
    expect(atlasHeight).toBe(slotHeight * rows);
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
      // MIPMAPPED where the deck's screens minify it (the F-16's, 2.1 texels a pixel: bilinear shimmered under a
      // quarter-pixel camera shift), trilinear there; plain bilinear on the turbofans' screens, as before
      const mipmapped = deck.kind === "jet";
      expect(texture!.getInternalTexture()!.generateMipMaps, "mipmaps").toBe(mipmapped);
      expect(texture!.samplingMode, "sampling").toBe(mipmapped ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE);
      // and it is the screens' emissive image, on one mesh, with the flat material left behind
      const screens = scene.getMeshByName(deck.layout.screensMesh)!;
      expect(screens.material!.name).not.toBe(deck.flatMaterial);
      expect((screens.material as { emissiveTexture?: unknown }).emissiveTexture, "the atlas itself, not a texture of its name").toBe(texture);
      // and on NOTHING ELSE: a bezel (or any mesh) wearing it smears the whole atlas over its faces. By the texture
      // OBJECT, on every mesh in the scene.
      const wearers = scene.meshes.filter((mesh) => {
        const material = mesh.material as { emissiveTexture?: unknown; albedoTexture?: unknown } | null;
        return material?.emissiveTexture === texture || material?.albedoTexture === texture;
      });
      expect(wearers.map((mesh) => mesh.name), "the meshes that sample the atlas").toEqual([deck.layout.screensMesh]);
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

/**
 * THE OTHER DECKS' ATLASES DO NOT MOVE when a deck with a different slot shape arrives.
 *
 * Every call each atlas's painter makes -- method, arguments, paints, in order -- digested at one fixed
 * flight state, on House-Keeping ac4eafe BEFORE `DisplayLayout` learned a per-deck slot size. A layout
 * change that fed the wrong slot size to a deck, or moved one slot, changes the digest. The digest sees
 * the drawing instructions, not pixels; there is no canvas here, and a canvas draws the same pixels
 * from the same instructions.
 */
describe("the 747's and the Global's atlases, pinned before the slot size became per-deck", () => {
  const PINNED: Readonly<Record<string, string>> = { "747": "0e7fe4d8:2090", Global: "d7144cad:1263" };
  const digest = (layout: DisplayLayout, airframe: DisplayAirframe): string => {
    const context = createRecordingContext();
    const state = displayStateFromVisual(
      { ...INITIAL_VISUAL_STATE, airspeed: 128.6, altitude: 3_048, heading: 237.5, bank: 18.5, pitch: 4.2, verticalSpeed: 6.1, engineRpm: 88, flaps: 0.5 },
      airframe,
    );
    drawDisplayAtlas(context, displayAtlasWidth(layout), displayAtlasHeight(layout), displaySlots(layout), state);
    const text = JSON.stringify([displayAtlasWidth(layout), displayAtlasHeight(layout), displaySlots(layout), context.calls]);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, "0")}:${context.calls.length}`;
  };
  it.each(DECKS.filter((deck) => deck.kind !== "jet").map((deck) => [deck.label, deck] as const))("draws the %s's atlas call for call as it did", (label, deck) => {
    expect(digest(deck.layout, deck.airframe), `${label}: the atlas's drawing instructions`).toBe(PINNED[label]);
  });
  // THE F-16's, pinned at step 5c (its ND's drawing centred on the square page, own ship at 317.9): the same digest,
  // so a later change to its pages is a deliberate re-pin
  it("draws the F-16's atlas call for call as step 5c pinned it", () => {
    const jet = DECKS.find((deck) => deck.kind === "jet")!;
    expect(digest(jet.layout, jet.airframe), "F-16: the atlas's drawing instructions").toBe("59822999:633");
  });
});
