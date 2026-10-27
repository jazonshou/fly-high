import type { TerrainDrawnAtlasData, TerrainDrawnNodeRecords } from "@/src/render/webgpu/terrain/TerrainDrawnHeight";
import {
  createTerrainNodeBuffers,
  resolveTerrainResidentCornerMorphs,
  selectTerrainNodes,
  writeTerrainNodeBuffers,
  type TerrainNode,
  type TerrainNodeSelectionInput,
} from "@/src/render/webgpu/terrain/TerrainQuadtree";
import { TERRAIN_HEIGHT_SLOT_EDGE, terrainAtlasGridEdge } from "@/src/render/webgpu/terrain/TerrainSpineContract";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_GUTTER } from "@/src/render/webgpu/world/pageGeometry";
import { parentWorldPageAddress, type WorldPageAddress } from "@/src/render/webgpu/world/pageKey";

/**
 * One terrain frame for the drawn-height tests (Node and GPU): a real CDLOD
 * selection round a camera, the height atlas filled from an analytic ground,
 * and the node buffers written as `TerrainClipmapSystem` writes them, with
 * two fine pages withheld so their nodes draw from the parent.
 */

/** Rolling ground with metre-scale bumps a coarse node cannot draw. */
export function drawnFrameGround(x: number, z: number): number {
  return 40 * Math.sin(x / 170) * Math.cos(z / 230)
    + 6 * Math.sin((x + 0.7 * z) / 23)
    + 1.5 * Math.sin(x / 4.3) * Math.cos(z / 5.1);
}

export const DRAWN_FRAME_CAMERA = Object.freeze({ x: 37.5, y: 140, z: -53.25 });

export const DRAWN_FRAME_SELECTION: TerrainNodeSelectionInput = Object.freeze({
  cameraX: DRAWN_FRAME_CAMERA.x,
  cameraY: DRAWN_FRAME_CAMERA.y,
  cameraZ: DRAWN_FRAME_CAMERA.z,
  // 1080p at a 60-degree vertical field of view.
  pixelsPerMeterAtUnitDistance: 1_080 / (2 * Math.tan((60 * Math.PI) / 360)),
  pixelThreshold: 3,
  nodeBudget: 240,
  finestResidentLevel: 0,
  coarsestLevel: 9,
  farPlaneMeters: 45_000,
  deviationFor: (address: WorldPageAddress) => 0.135 * 2 ** address.level,
});

export interface DrawnFrame {
  readonly nodes: readonly TerrainNode[];
  readonly records: TerrainDrawnNodeRecords;
  readonly atlas: TerrainDrawnAtlasData;
}

function addressKey(address: WorldPageAddress): string {
  return `${address.level}:${address.x}:${address.z}`;
}

export function buildDrawnFrame(selection: TerrainNodeSelectionInput = DRAWN_FRAME_SELECTION): DrawnFrame {
  const nodes = selectTerrainNodes(selection);
  const pages = new Map<string, WorldPageAddress>();
  for (const node of nodes) {
    pages.set(addressKey(node.address), node.address);
    const parent = parentWorldPageAddress(node.address);
    if (parent) pages.set(addressKey(parent), parent);
  }
  const withheld = new Set<string>();
  for (const node of nodes) {
    if (withheld.size >= 2) break;
    if (node.level === 2 && node.distanceMeters > 300) withheld.add(addressKey(node.address));
  }
  const resident = [...pages.entries()].filter(([key]) => !withheld.has(key));
  const slotOf = new Map(resident.map(([key], index) => [key, index]));
  const gridEdge = terrainAtlasGridEdge(Math.max(1, resident.length));
  const slotEdge = TERRAIN_HEIGHT_SLOT_EDGE;
  const atlasEdge = gridEdge * slotEdge;
  const heights = new Float32Array(atlasEdge * atlasEdge);
  resident.forEach(([, address], slot) => {
    const extent = WORLD_PAGE_BASE_EXTENT_METERS * 2 ** address.level;
    const texel = extent / 256;
    const originU = (slot % gridEdge) * slotEdge;
    const originV = Math.floor(slot / gridEdge) * slotEdge;
    for (let j = 0; j < slotEdge; j += 1) {
      const z = address.z * extent + (j - WORLD_PAGE_GUTTER) * texel;
      for (let i = 0; i < slotEdge; i += 1) {
        const x = address.x * extent + (i - WORLD_PAGE_GUTTER) * texel;
        heights[(originV + j) * atlasEdge + originU + i] = drawnFrameGround(x, z);
      }
    }
  });
  const slotFor = (address: WorldPageAddress): number => slotOf.get(addressKey(address)) ?? -1;
  const buffers = createTerrainNodeBuffers(nodes.length);
  const corners = resolveTerrainResidentCornerMorphs(nodes, slotFor);
  const cornerOf = new Map(nodes.map((node, index) => [node, corners[index]!]));
  writeTerrainNodeBuffers({
    nodes,
    originX: 0,
    originZ: 0,
    slotFor,
    channelSlotFor: () => -1,
    provisionalAxisFor: () => 0,
    cornerMorphsFor: (node) => cornerOf.get(node)!,
  }, buffers);
  return {
    nodes,
    records: { nodes, laneA: buffers.laneA, laneB: buffers.laneB, count: buffers.count },
    atlas: { heights, shape: { atlasEdge, slotEdge, gutter: WORLD_PAGE_GUTTER, gridEdge } },
  };
}

/** Deterministic probes on a ring round the camera. */
export function drawnFrameRing(inner: number, outer: number, count: number, seed: number): [number, number][] {
  const points: [number, number][] = [];
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  for (let index = 0; index < count; index += 1) {
    const angle = next() * Math.PI * 2;
    const radius = inner + (outer - inner) * next();
    points.push([DRAWN_FRAME_CAMERA.x + Math.cos(angle) * radius, DRAWN_FRAME_CAMERA.z + Math.sin(angle) * radius]);
  }
  return points;
}

/** Probes a few centimetres inside each node's edges and corners, where the morph is the synchronised one. */
export function drawnFrameEdgeProbes(frame: DrawnFrame, within: number, count: number): [number, number][] {
  const points: [number, number][] = [];
  const insets = [0.03, 0.4, 1.7];
  for (const node of frame.nodes.slice(0, frame.records.count)) {
    const centreX = node.originX + node.spanMeters / 2;
    const centreZ = node.originZ + node.spanMeters / 2;
    if (Math.hypot(centreX - DRAWN_FRAME_CAMERA.x, centreZ - DRAWN_FRAME_CAMERA.z) > within) continue;
    for (const inset of insets) {
      const span = node.spanMeters;
      const along = (0.37 + inset * 0.11) * span;
      points.push(
        [node.originX + inset, node.originZ + along],
        [node.originX + span - inset, node.originZ + along],
        [node.originX + along, node.originZ + inset],
        [node.originX + along, node.originZ + span - inset],
        [node.originX + inset, node.originZ + inset],
      );
    }
    if (points.length >= count) break;
  }
  return points.slice(0, count);
}
