/**
 * WHAT THE PILOT SEES from each airframe's cockpit camera, with no GPU.
 *
 * A NullEngine scene, `createAircraft(scene, kind)`, `setCockpitView(true)`,
 * and rays from the eye `FlightRenderer.updateCamera` puts the camera at
 * (`root + forward * cockpitEye.forward + up * cockpitEye.up`, looking along
 * body +X) through the frustum that camera really has. Every ray is classified
 * by the first OPAQUE surface the cockpit camera would draw.
 *
 * WHICH FRUSTUM. The flight camera is `FOVMODE_HORIZONTAL_FIXED` and the
 * cockpit branch sets 56 degrees, so 56 is the HORIZONTAL field of view: at
 * 16:9 the frame spans azimuth +-28 and only about +-16.6 degrees of elevation
 * at the centre line. It is NOT a 56 degree vertical field of view (which would
 * be +-43.5 horizontally). Map A below is the wide diagnostic grid — azimuth
 * +-43.5, elevation +-28 — so the parts that fall just outside the real frame
 * are still visible in it; map B is the real frame, cell for cell. `HFOV`,
 * `ASPECT` and `FOV_MODE=vertical` reproduce other assumptions.
 *
 * WHAT THE RENDERER DOES THAT A NAIVE PICK DOES NOT, and this honours:
 *  - the camera's LAYER MASK (exterior skin is on bit 27, which the cockpit
 *    camera clears — `setCockpitView`), plus `isVisible`, `isEnabled` and
 *    `visibility`;
 *  - BACK-FACE CULLING per material (Babylon's pick ignores it, so this passes
 *    a triangle predicate whose winding sign is CALIBRATED against a closed box
 *    from the aircraft itself and reported);
 *  - TRANSLUCENT glass, which is looked through rather than hit;
 *  - the NEAR PLANE (0.08 m along the view axis), which clips whatever is
 *    closer — a clipped hit is reported, not silently dropped.
 *
 * CONTROLS, printed with every kind so a clean reading cannot be silence:
 *  - `cull control`: the cull predicate hits a closed box from OUTSIDE and does
 *    not hit it from INSIDE. If not, the whole run is void.
 *  - `eye control`: the same map with the eye moved 1 m up; the map must change.
 *  - `exposure`: how many cells hit something, and how many distinct meshes.
 *    Zero is VOID, not clean.
 *
 *   npx tsx scripts/cockpit-view-probe.mts
 *   KINDS=trainer,jet POSE=runway npx tsx scripts/cockpit-view-probe.mts
 *   SKIN=1 npx tsx scripts/cockpit-view-probe.mts     # leave the exterior skin visible
 *   EYE_DY=0.3 EYE_DZ=-0.26 npx tsx scripts/cockpit-view-probe.mts   # try an eye point
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { AIRCRAFT_EXTERIOR_LAYER_MASK } from "@/src/render/webgpu/aircraft/types";
import { createAircraft } from "@/src/render/webgpu/aircraft/createAircraft";
import { INITIAL_VISUAL_STATE } from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";

const DEG = 180 / Math.PI;
const ALL_KINDS: AircraftKind[] = ["trainer", "jet", "bizjet", "airliner"];

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name}=${raw} is not a number`);
  return value;
}

const KINDS = (process.env.KINDS ?? ALL_KINDS.join(",")).split(",").map((k) => {
  if (!(ALL_KINDS as string[]).includes(k)) throw new Error(`unknown kind "${k}"`);
  return k as AircraftKind;
});
/** The game's cockpit field of view, in degrees, and which axis it is on. */
const FOV_DEGREES = numberFromEnv("HFOV", 56);
const FOV_MODE = process.env.FOV_MODE === "vertical" ? "vertical" : "horizontal";
const ASPECT = numberFromEnv("ASPECT", 16 / 9);
const NEAR_PLANE = 0.08;
const EYE_SHIFT = new Vector3(
  numberFromEnv("EYE_DX", 0),
  numberFromEnv("EYE_DY", 0),
  numberFromEnv("EYE_DZ", 0),
);
const SKIN = process.env.SKIN === "1";
const CULL = process.env.CULL !== "0";
const POSE = process.env.POSE === "runway" ? "runway" : "air";
/** The eye control moves the eye this far straight up. */
const CONTROL_LIFT = 1;

const tanHalfHorizontal = FOV_MODE === "horizontal"
  ? Math.tan((FOV_DEGREES * Math.PI) / 360)
  : Math.tan((FOV_DEGREES * Math.PI) / 360) * ASPECT;
const tanHalfVertical = tanHalfHorizontal / ASPECT;
const HALF_AZIMUTH = Math.atan(tanHalfHorizontal) * DEG;
const HALF_ELEVATION = Math.atan(tanHalfVertical) * DEG;

const FORWARD = new Vector3(1, 0, 0);
const UP = new Vector3(0, 1, 0);
/** forward x up = starboard (+Z), the codebase's convention. */
const RIGHT = Vector3.Cross(FORWARD, UP);

/** Which meshes stand in for the things the defect table asks about. */
interface KindNotes {
  /** The pilot's seat: LEFT (port, -Z) in the 150, Global and 747; centreline in the F-16. */
  readonly seat: RegExp;
  readonly seatNote: string;
  /** The window sill, and which edge of that mesh's bounding box is the sill line. */
  readonly sill: RegExp;
  readonly sillEdge: "top" | "bottom";
  readonly panel: RegExp;
  readonly glare: RegExp | null;
}
const NOTES: Record<AircraftKind, KindNotes> = {
  trainer: {
    seat: /^port-seat$/, seatNote: "port seat, z -0.26",
    sill: /^trainer-canopy$/, sillEdge: "bottom",
    panel: /^trainer-instrument-panel$/, glare: null,
  },
  jet: {
    seat: /^jet-seat-pan$/, seatNote: "single seat on the centreline",
    sill: /^jet-canopy-sill$/, sillEdge: "top",
    panel: /^jet-instrument-panel$/, glare: /^jet-glare-shield$/,
  },
  bizjet: {
    // The mesh NAMED "first-officer" sits at -Z (port) and the one named
    // "captain" at +Z (starboard); a captain flies from the left seat, so the
    // port one is the pilot's regardless of what it is called.
    seat: /^bizjet-first-officer-seat$/, seatNote: "port seat (named first-officer), z -0.52",
    sill: /flight-deck-window$/, sillEdge: "bottom",
    panel: /^bizjet-instrument-panel$/, glare: null,
  },
  airliner: {
    seat: /^airliner-first-officer-seat$/, seatNote: "port seat (named first-officer), z -0.72",
    sill: /flight-deck-window-one$/, sillEdge: "bottom",
    panel: /^airliner-instrument-panel$/, glare: null,
  },
};

const STRUCTURE = /frame|post|bow|sill|pillar|window|windscreen|canopy|glare|cowl|spinner|prop|radome|nose|fuselage|roof|deck|seat|headrest|panel|tub|gauge/i;

interface Hit {
  readonly mesh: AbstractMesh;
  readonly distance: number;
  readonly depth: number;
}

interface Cell {
  /** First opaque mesh the cockpit camera would draw, or null for sky. */
  readonly name: string | null;
  readonly distance: number;
  /** Translucent meshes looked through before that hit. */
  readonly glass: readonly string[];
  readonly azimuth: number;
  readonly elevation: number;
}

interface Tally {
  readonly clipped: Map<string, number>;
  readonly coincident: Map<string, number>;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}
function azel(point: Vector3, eye: Vector3): { az: number; el: number; depth: number } {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  return { az: Math.atan2(dz, dx) * DEG, el: Math.atan2(dy, Math.hypot(dx, dz)) * DEG, depth: dx };
}
function worldVertices(mesh: AbstractMesh): Vector3[] {
  const data = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!data) return [];
  const world = mesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  }
  return out;
}
function materialOf(mesh: AbstractMesh): PBRMaterial | null {
  return (mesh.material as PBRMaterial | null) ?? null;
}

function run(kind: AircraftKind): void {
  const spec = aircraftSpec(kind);
  const notes = NOTES[kind];
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new UniversalCamera("probe-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const visual = createAircraft(scene, kind);

  const state = POSE === "runway"
    ? {
      ...INITIAL_VISUAL_STATE, onGround: true, altitudeAgl: 0, gear: 1,
      flaps: spec.spawn.runwayFlaps, throttle: 0, simulationTime: 0.5,
      velocity: { x: 0, y: 0, z: 0 }, airspeed: 0,
    }
    : {
      ...INITIAL_VISUAL_STATE, onGround: false, gear: spec.spawn.airborneGear,
      flaps: 0, simulationTime: 0.5,
    };
  visual.update(state as never, 1 / 60);
  visual.setCockpitView(true);
  visual.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);

  const cameraMask = SKIN ? camera.layerMask | AIRCRAFT_EXTERIOR_LAYER_MASK : camera.layerMask;
  const sees = (mesh: AbstractMesh): boolean => mesh.isEnabled() && mesh.isVisible
    && mesh.visibility > 0 && (mesh.layerMask & cameraMask) !== 0 && mesh.getTotalVertices() > 0;
  const translucent = (mesh: AbstractMesh): boolean => {
    const material = materialOf(mesh);
    return material !== null && material.needAlphaBlendingForMesh(mesh);
  };
  const culls = (mesh: AbstractMesh): boolean => CULL && (materialOf(mesh)?.backFaceCulling ?? false);
  const visibleMeshes = new Set(scene.meshes.filter(sees));
  const cullers = new Set([...visibleMeshes].filter(culls));

  // ---- CULL CONTROL: pick the winding sign, then prove it both ways. -------
  const controlMesh = scene.meshes.find((m) => notes.panel.test(m.name));
  if (!controlMesh) throw new Error(`no ${notes.panel} to calibrate culling against`);
  const controlBox = controlMesh.getBoundingInfo().boundingBox.centerWorld;
  const outsideOrigin = controlBox.add(new Vector3(-2, 0, 0));
  const triangleTest = (sign: number) => (p0: Vector3, p1: Vector3, p2: Vector3, ray: Ray): boolean => {
    const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
    const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    return sign * (nx * ray.direction.x + ny * ray.direction.y + nz * ray.direction.z) < 0;
  };
  const only = (mesh: AbstractMesh) => (m: AbstractMesh): boolean => m === mesh;
  const hitsControl = (origin: Vector3, sign: number): boolean => {
    const result = scene.multiPickWithRay(
      new Ray(origin, FORWARD.clone(), 50), only(controlMesh), triangleTest(sign),
    );
    return (result?.length ?? 0) > 0;
  };
  let sign = 0;
  for (const candidate of [1, -1]) {
    if (hitsControl(outsideOrigin, candidate) && !hitsControl(controlBox, candidate)) sign = candidate;
  }
  if (CULL && sign === 0) {
    throw new Error(`${kind}: cull control FAILED — no winding sign hits the ${controlMesh.name} from outside and misses it from inside; every reading would be void`);
  }
  console.log(
    `cull control: closed box ${controlMesh.name}, outside hit=${hitsControl(outsideOrigin, sign || 1)},`
    + ` inside hit=${hitsControl(controlBox, sign || 1)}, winding sign ${sign || "(culling off)"}`,
  );
  const cullPredicate = triangleTest(sign || 1);

  // ---- The eye, exactly as FlightRenderer places it. ------------------------
  const eyeAt = (extra: Vector3): Vector3 => new Vector3(
    spec.cockpitEye.forward + EYE_SHIFT.x + extra.x,
    spec.cockpitEye.up + EYE_SHIFT.y + extra.y,
    EYE_SHIFT.z + extra.z,
  );

  const tally: Tally = { clipped: new Map(), coincident: new Map() };
  function cast(eye: Vector3, direction: Vector3, record: boolean): Cell {
    const ray = new Ray(eye, direction, 600);
    const first = scene.multiPickWithRay(ray, (m) => cullers.has(m), cullPredicate) ?? [];
    const second = scene.multiPickWithRay(ray, (m) => visibleMeshes.has(m) && !cullers.has(m)) ?? [];
    const hits: Hit[] = [...first, ...second]
      .filter((h) => h.hit && h.pickedMesh)
      .map((h) => ({ mesh: h.pickedMesh as AbstractMesh, distance: h.distance, depth: h.distance * direction.x }))
      .sort((a, b) => a.distance - b.distance);
    const glass: string[] = [];
    let chosen: Hit | null = null;
    for (const hit of hits) {
      if (hit.depth < NEAR_PLANE) {
        if (record) tally.clipped.set(hit.mesh.name, (tally.clipped.get(hit.mesh.name) ?? 0) + 1);
        continue;
      }
      if (translucent(hit.mesh)) {
        glass.push(hit.mesh.name);
        continue;
      }
      if (!chosen) {
        chosen = hit;
        continue;
      }
      // A second OPAQUE surface a millimetre behind the first is what
      // z-fighting looks like.
      if (record && hit.mesh !== chosen.mesh && hit.distance - chosen.distance < 0.001) {
        const key = [chosen.mesh.name, hit.mesh.name].sort().join(" <> ");
        tally.coincident.set(key, (tally.coincident.get(key) ?? 0) + 1);
      }
      break;
    }
    const a = azel(eye.add(direction), eye);
    return {
      name: chosen ? chosen.mesh.name : null,
      distance: chosen ? chosen.distance : Infinity,
      glass,
      azimuth: a.az,
      elevation: a.el,
    };
  }

  const eye = eyeAt(Vector3.Zero());
  const eyeMoved = eyeAt(new Vector3(0, CONTROL_LIFT, 0));

  function gridWide(origin: Vector3, record: boolean): Cell[][] {
    const rows: Cell[][] = [];
    for (let j = 0; j < 25; j += 1) {
      const el = (28 - (56 * j) / 24) / DEG;
      const row: Cell[] = [];
      for (let i = 0; i < 45; i += 1) {
        const az = (-43.5 + (87 * i) / 44) / DEG;
        const dir = new Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        row.push(cast(origin, dir, record));
      }
      rows.push(row);
    }
    return rows;
  }
  const FRAME_COLUMNS = 100;
  const FRAME_ROWS = Math.round(FRAME_COLUMNS / ASPECT / 2);
  function gridFrame(origin: Vector3, record: boolean): Cell[][] {
    const rows: Cell[][] = [];
    for (let j = 0; j < FRAME_ROWS; j += 1) {
      const v = (1 - ((j + 0.5) / FRAME_ROWS) * 2) * tanHalfVertical;
      const row: Cell[] = [];
      for (let i = 0; i < FRAME_COLUMNS; i += 1) {
        const u = (((i + 0.5) / FRAME_COLUMNS) * 2 - 1) * tanHalfHorizontal;
        const dir = FORWARD.add(RIGHT.scale(u)).add(UP.scale(v)).normalize();
        row.push(cast(origin, dir, record));
      }
      rows.push(row);
    }
    return rows;
  }

  const wide = gridWide(eye, true);
  const frame = gridFrame(eye, true);
  const frameMoved = gridFrame(eyeMoved, false);

  // ---- Glyphs: most frequent mesh first, one legend for both maps. ---------
  const counts = new Map<string, { wide: number; frame: number }>();
  const bump = (cells: Cell[][], key: "wide" | "frame") => {
    for (const cell of cells.flat()) {
      if (cell.name === null) continue;
      const entry = counts.get(cell.name) ?? { wide: 0, frame: 0 };
      entry[key] += 1;
      counts.set(cell.name, entry);
    }
  };
  bump(wide, "wide");
  bump(frame, "frame");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const ordered = [...counts.entries()].sort((a, b) => (b[1].wide + b[1].frame) - (a[1].wide + a[1].frame));
  const glyph = new Map<string, string>(ordered.map(([name], i) => [name, alphabet[i] ?? "#"]));
  const draw = (cells: Cell[][]): string => cells.map((row) => row.map((cell) => {
    if (cell.name !== null) return glyph.get(cell.name) ?? "#";
    return cell.glass.length > 0 ? "~" : ".";
  }).join("")).join("\n");

  console.log(`\n=== ${kind.toUpperCase()}  (${spec.name})  pose=${POSE}  skin=${SKIN ? "LEFT VISIBLE" : "hidden by layer mask"}  cull=${CULL ? "on" : "off"} ===`);
  console.log(
    `eye ${fixed(eye.x, 3)}, ${fixed(eye.y, 3)}, ${fixed(eye.z, 3)}  (catalogue forward ${spec.cockpitEye.forward}, up ${spec.cockpitEye.up};`
    + ` shift ${fixed(EYE_SHIFT.x)}, ${fixed(EYE_SHIFT.y)}, ${fixed(EYE_SHIFT.z)})`,
  );
  console.log(
    `camera ${FOV_DEGREES} deg ${FOV_MODE}, aspect ${fixed(ASPECT, 3)} -> frame is azimuth +-${fixed(HALF_AZIMUTH, 1)},`
    + ` elevation +-${fixed(HALF_ELEVATION, 1)} at the centre line; near plane ${NEAR_PLANE} m;`
    + ` camera layer mask ${(cameraMask >>> 0).toString(16)}, exterior bit ${SKIN ? "INCLUDED" : "cleared"}`,
  );

  // Exposure: a map that hit nothing is void, not clean.
  const wideHit = wide.flat().filter((c) => c.name !== null).length;
  const frameHit = frame.flat().filter((c) => c.name !== null).length;
  console.log(
    `exposure: ${scene.meshes.length} meshes in scene, ${visibleMeshes.size} visible to the cockpit camera,`
    + ` ${cameraMaskHiddenCount()} hidden by layer mask;`
    + ` wide map ${wideHit}/${wide.flat().length} cells hit, frame ${frameHit}/${frame.flat().length}, ${counts.size} distinct meshes`,
  );
  if (frameHit + wideHit === 0) console.log("  *** VOID: no ray hit anything; nothing below means anything ***");
  function cameraMaskHiddenCount(): number {
    return scene.meshes.filter((m) => m.isEnabled() && m.isVisible && (m.layerMask & cameraMask) === 0).length;
  }

  console.log(`\nMAP A — the wide diagnostic grid, 45 x 25, azimuth -43.5..+43.5 (port to starboard), elevation +28..-28`);
  console.log(`         real frame is columns ${fixed(22 - (HALF_AZIMUTH / 87) * 44, 0)}..${fixed(22 + (HALF_AZIMUTH / 87) * 44, 0)}, rows ${fixed(12 - (HALF_ELEVATION / 56) * 24, 0)}..${fixed(12 + (HALF_ELEVATION / 56) * 24, 0)} (0-based)`);
  console.log(draw(wide));
  console.log(`\nMAP B — the real frame, ${FRAME_COLUMNS} x ${FRAME_ROWS}, azimuth +-${fixed(HALF_AZIMUTH, 1)}, elevation +-${fixed(HALF_ELEVATION, 1)} (character cells are ~2x taller than wide)`);
  console.log(draw(frame));
  console.log(`\nlegend (cells in map A / map B):   '.' sky or nothing   '~' looked through glass, sky beyond`);
  for (const [name, count] of ordered) {
    console.log(`  ${glyph.get(name)}  ${pad(name, 44)} ${String(count.wide).padStart(5)} / ${String(count.frame).padStart(5)}`);
  }

  // ---- EYE CONTROL ----------------------------------------------------------
  let changed = 0;
  for (let j = 0; j < frame.length; j += 1) {
    for (let i = 0; i < frame[j]!.length; i += 1) {
      if (frame[j]![i]!.name !== frameMoved[j]![i]!.name) changed += 1;
    }
  }
  console.log(
    `\neye control: eye moved ${CONTROL_LIFT} m up -> ${changed} of ${frame.flat().length} frame cells changed`
    + ` (${fixed((100 * changed) / frame.flat().length, 1)}%)${changed === 0 ? "  *** VOID: the map did not respond to the eye ***" : ""}`,
  );

  // ---- (b) per-mesh table ---------------------------------------------------
  const parts = new Set<AbstractMesh>(visual.cockpitParts);
  const interesting = new Set<AbstractMesh>();
  for (const mesh of scene.meshes) {
    if (counts.has(mesh.name) || parts.has(mesh)) interesting.add(mesh);
    else if (STRUCTURE.test(mesh.name)) interesting.add(mesh);
  }
  const cellExtent = new Map<string, { minAz: number; maxAz: number; minEl: number; maxEl: number }>();
  for (const cell of frame.flat()) {
    if (cell.name === null) continue;
    const e = cellExtent.get(cell.name) ?? { minAz: Infinity, maxAz: -Infinity, minEl: Infinity, maxEl: -Infinity };
    e.minAz = Math.min(e.minAz, cell.azimuth); e.maxAz = Math.max(e.maxAz, cell.azimuth);
    e.minEl = Math.min(e.minEl, cell.elevation); e.maxEl = Math.max(e.maxEl, cell.elevation);
    cellExtent.set(cell.name, e);
  }
  console.log(`\n(b) MESHES — hit by a ray, in cockpitParts, or structural by name`);
  console.log(
    `  ${pad("mesh", 58)}${pad("cockpit", 9)}${pad("why not", 31)}${pad("nearest", 9)}${pad("bbox az min..max", 19)}${pad("bbox el min..max", 19)}on-screen az / el (map B)`,
  );
  const rows = [...interesting].sort((a, b) => a.name.localeCompare(b.name)).map((mesh) => {
    const visible = visibleMeshes.has(mesh);
    let why = "";
    if (!visible) {
      if (!mesh.isEnabled()) why = "disabled";
      else if (!mesh.isVisible) why = "isVisible=false";
      else if ((mesh.layerMask & cameraMask) === 0) why = "LAYER MASK (in cockpitParts)";
      else why = "no vertices";
    }
    const vertices = worldVertices(mesh);
    let nearest = Infinity;
    for (const v of vertices) nearest = Math.min(nearest, Vector3.Distance(v, eye));
    const corners = mesh.getBoundingInfo().boundingBox.vectorsWorld.map((c) => azel(c, eye)).filter((c) => c.depth > 0);
    const inside = (() => {
      const box = mesh.getBoundingInfo().boundingBox;
      return eye.x >= box.minimumWorld.x && eye.x <= box.maximumWorld.x
        && eye.y >= box.minimumWorld.y && eye.y <= box.maximumWorld.y
        && eye.z >= box.minimumWorld.z && eye.z <= box.maximumWorld.z;
    })();
    const azRange = corners.length
      ? `${fixed(Math.min(...corners.map((c) => c.az)), 1)}..${fixed(Math.max(...corners.map((c) => c.az)), 1)}`
      : "behind the eye";
    const elRange = corners.length
      ? `${fixed(Math.min(...corners.map((c) => c.el)), 1)}..${fixed(Math.max(...corners.map((c) => c.el)), 1)}`
      : "";
    const extent = cellExtent.get(mesh.name);
    const onScreen = extent
      ? `${fixed(extent.minAz, 1)}..${fixed(extent.maxAz, 1)} / ${fixed(extent.minEl, 1)}..${fixed(extent.maxEl, 1)}`
      : "not drawn";
    return `  ${pad(mesh.name + (parts.has(mesh) ? " [cockpitParts]" : "") + (inside ? " [EYE INSIDE BOX]" : ""), 58)}`
      + `${pad(visible ? "yes" : "NO", 9)}${pad(why, 31)}${pad(fixed(nearest), 9)}${pad(azRange, 19)}${pad(elRange, 19)}${onScreen}`;
  });
  for (const row of rows) console.log(row);

  // ---- (c) the eye against the seat and the sill ---------------------------
  const seatMesh = scene.meshes.find((m) => notes.seat.test(m.name));
  const sillMesh = scene.meshes.find((m) => notes.sill.test(m.name));
  console.log(`\n(c) EYE POSITION`);
  if (seatMesh) {
    const box = seatMesh.getBoundingInfo().boundingBox;
    const seatTop = box.maximumWorld.y;
    console.log(
      `  seat ${seatMesh.name} (${notes.seatNote}): bbox top y ${fixed(seatTop, 3)}, centre (x ${fixed(box.centerWorld.x, 3)}, z ${fixed(box.centerWorld.z, 3)})`,
    );
    console.log(
      `  eye above seat top: ${fixed(eye.y - seatTop, 3)} m;  eye lateral offset from seat centre: ${fixed(eye.z - box.centerWorld.z, 3)} m`
      + ` (${eye.z - box.centerWorld.z === 0 ? "on the seat centre" : `eye is ${Math.abs(eye.z - box.centerWorld.z) < 0.02 ? "on" : eye.z > box.centerWorld.z ? "STARBOARD of" : "PORT of"} the seat centre`});`
      + ` eye fore-aft vs seat centre: ${fixed(eye.x - box.centerWorld.x, 3)} m`,
    );
  } else console.log(`  seat ${notes.seat}: NOT FOUND`);
  if (sillMesh) {
    const box = sillMesh.getBoundingInfo().boundingBox;
    const sillY = notes.sillEdge === "top" ? box.maximumWorld.y : box.minimumWorld.y;
    console.log(`  sill from ${sillMesh.name} (${notes.sillEdge} of its box): y ${fixed(sillY, 3)};  eye above sill: ${fixed(eye.y - sillY, 3)} m`);
  } else console.log(`  sill ${notes.sill}: NOT FOUND`);
  let nearestHit = Infinity;
  let nearestName = "";
  for (const cell of frame.flat()) {
    if (cell.name !== null && cell.distance < nearestHit) { nearestHit = cell.distance; nearestName = cell.name; }
  }
  console.log(`  nearest surface the frame actually draws: ${fixed(nearestHit, 3)} m (${nearestName || "none"}); near plane ${NEAR_PLANE} m`);

  // ---- Q1 / Q2: panel and dial angles --------------------------------------
  const panelMesh = scene.meshes.find((m) => notes.panel.test(m.name));
  const glareMesh = notes.glare ? scene.meshes.find((m) => notes.glare!.test(m.name)) : undefined;
  const topEdge = (mesh: AbstractMesh) => {
    const vertices = worldVertices(mesh).filter((v) => v.x > eye.x + NEAR_PLANE);
    if (vertices.length === 0) return null;
    const top = Math.max(...vertices.map((v) => v.y));
    const edge = vertices.filter((v) => v.y > top - 0.012);
    const centre = edge.reduce((acc, v) => acc.add(v), Vector3.Zero()).scale(1 / edge.length);
    return { ...azel(centre, eye), y: top };
  };
  console.log(`\nQ1/Q2 PANEL AND DIALS (angles from the eye; frame is el +-${fixed(HALF_ELEVATION, 1)} at az 0)`);
  // The APPARENT top edge is what decides the picture: scan straight ahead
  // from above the horizon downwards and report where the first opaque hit is
  // this mesh. A vertex estimate is wrong for a tilted box (it finds the back
  // edge, which need not be the silhouette), so both are printed. The ray
  // scan is what the frame's own pixels agree with; y is the row in a frame
  // `FRAME_HEIGHT` px tall.
  const apparentTop = (mesh: AbstractMesh): number | null => {
    for (let el = 8; el >= -30; el -= 0.05) {
      const radians = el / DEG;
      const cell = cast(eye, new Vector3(Math.cos(radians), Math.sin(radians), 0), false);
      if (cell.name === mesh.name) return el;
    }
    return null;
  };
  const FRAME_HEIGHT = 900;
  for (const mesh of [glareMesh, panelMesh]) {
    if (!mesh) continue;
    const t = topEdge(mesh);
    const apparent = apparentTop(mesh);
    const row = apparent === null ? NaN : FRAME_HEIGHT / 2 - (Math.tan(apparent / DEG) / tanHalfVertical) * (FRAME_HEIGHT / 2);
    console.log(
      `  top edge of ${mesh.name}: highest vertex y ${fixed(t?.y ?? NaN, 3)} (elevation ${fixed(t?.el ?? NaN, 1)} deg);`
      + ` APPARENT at azimuth 0 by ray scan: ${apparent === null ? "not seen" : `${fixed(apparent, 2)} deg -> row ${fixed(row, 0)} of a ${FRAME_HEIGHT}-px frame`}`,
    );
  }
  const onFrame = (a: { az: number; el: number; depth: number }): boolean =>
    a.depth > NEAR_PLANE && Math.abs(Math.tan(a.az / DEG) * 1) <= tanHalfHorizontal
    && Math.abs(Math.tan(a.el / DEG) / Math.cos(a.az / DEG)) <= tanHalfVertical;
  const gauges = scene.meshes.filter((m) => /-gauge$/.test(m.name));
  const gaugeAngles = gauges.map((mesh) => {
    const c = mesh.getBoundingInfo().boundingBox.centerWorld;
    return { name: mesh.name, ...azel(c, eye) };
  });
  for (const g of gaugeAngles) {
    console.log(
      `  dial ${pad(g.name, 34)} az ${fixed(g.az, 1).padStart(6)}  el ${fixed(g.el, 1).padStart(6)}   on the real frame: ${onFrame(g) ? "yes" : "NO"};  inside the wide +-28 grid: ${Math.abs(g.el) <= 28 && Math.abs(g.az) <= 43.5 ? "yes" : "NO"}`,
    );
  }
  if (gaugeAngles.length) {
    const mean = (f: (g: typeof gaugeAngles[number]) => number) => gaugeAngles.reduce((s, g) => s + f(g), 0) / gaugeAngles.length;
    console.log(`  dial cluster centre: az ${fixed(mean((g) => g.az), 1)}, el ${fixed(mean((g) => g.el), 1)}; lowest ${fixed(Math.min(...gaugeAngles.map((g) => g.el)), 1)}, highest ${fixed(Math.max(...gaugeAngles.map((g) => g.el)), 1)}`);
  } else console.log("  no *-gauge meshes found");

  // ---- Q5: side walls at the frame edges -----------------------------------
  const edgeNames = (columns: number[]): string => {
    const seen = new Map<string, number>();
    for (const row of frame) for (const i of columns) {
      const cell = row[i]!;
      const name = cell.name ?? (cell.glass.length ? "(glass, sky beyond)" : "(sky)");
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} x${c}`).join(", ");
  };
  console.log(`\nQ5 SIDE EDGES (5 outermost columns of the real frame)`);
  console.log(`  port edge:      ${edgeNames([0, 1, 2, 3, 4])}`);
  console.log(`  starboard edge: ${edgeNames([FRAME_COLUMNS - 5, FRAME_COLUMNS - 4, FRAME_COLUMNS - 3, FRAME_COLUMNS - 2, FRAME_COLUMNS - 1])}`);

  // ---- Q7: near-plane clipping and coincident surfaces ---------------------
  console.log(`\nQ7 NEAR PLANE AND COINCIDENT SURFACES (both maps' rays)`);
  console.log(`  clipped by the near plane (opaque or glass hit with depth < ${NEAR_PLANE} m): ${tally.clipped.size === 0 ? "none" : [...tally.clipped.entries()].map(([n, c]) => `${n} x${c}`).join(", ")}`);
  console.log(`  opaque surfaces within 1 mm of each other (z-fight candidates): ${tally.coincident.size === 0 ? "none" : [...tally.coincident.entries()].map(([n, c]) => `${n} x${c}`).join(", ")}`);

  // ---- Q8: materials of the hidden parts ------------------------------------
  console.log(`\nQ8 MATERIALS OF cockpitParts (the meshes the layer mask hides)`);
  for (const mesh of parts) {
    const material = materialOf(mesh);
    console.log(
      `  ${pad(mesh.name, 32)} material ${pad(material?.name ?? "none", 28)} backFaceCulling=${material?.backFaceCulling}`
      + `  sideOrientation=${material?.sideOrientation ?? "default"}  alpha=${material?.alpha}  translucent=${translucent(mesh)}`
      + `  vertices=${mesh.getTotalVertices()}`,
    );
  }

  // ---- GLASS the frame is looked through -----------------------------------
  // The probe treats every translucent mesh as see-through, which is only as
  // true as the material. A refracting or heavily tinted pane can draw as a
  // flat slab (the Global's windscreen does in the shipped frame), and nothing
  // here can tell, so the facts that decide it are printed for a reader to
  // compare against the frame.
  const glassCells = new Map<string, number>();
  for (const cell of frame.flat()) for (const name of cell.glass) glassCells.set(name, (glassCells.get(name) ?? 0) + 1);
  console.log(`\nGLASS looked through in the real frame (probe treats it as transparent; compare with the PNG)`);
  if (glassCells.size === 0) console.log("  none");
  for (const [name, cells] of [...glassCells.entries()].sort((a, b) => b[1] - a[1])) {
    const mesh = scene.meshes.find((m) => m.name === name);
    const material = mesh ? materialOf(mesh) : null;
    console.log(
      `  ${pad(name, 46)} ${String(cells).padStart(5)} cells  material ${pad(material?.name ?? "none", 24)}`
      + ` alpha=${material?.alpha}  refraction=${material?.subSurface?.isRefractionEnabled ?? "n/a"}`
      + `  depthPrePass=${material?.needDepthPrePass}  backFaceCulling=${material?.backFaceCulling}`,
    );
  }

  scene.dispose();
  engine.dispose();
}

console.log(`cockpit-view-probe  kinds=${KINDS.join(",")}  pose=${POSE}  fov=${FOV_DEGREES} ${FOV_MODE}  aspect=${fixed(ASPECT, 3)}`);
for (const kind of KINDS) run(kind);
