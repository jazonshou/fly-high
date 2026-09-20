import { SurfaceMaterial } from "./surfaceMaterials";

/**
 * `M-2` — rock relief (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: what a steep rock or scree face, and a snowfield,
 * look like in the band between one material tile (3.7–6.7 m) and the landform
 * the mesh can actually carry. `TerrainSurfacePlugin` composes it; nothing else
 * answers "what is on a mountainside".
 *
 * WHY THIS EXISTS. The report, with a frame: the peaks are "a smooth surface
 * with patterns on it ... wallpaper glued to smooth mountains", and, after the
 * shape was fixed, two things named by the owner: "weird black horizontal
 * lines on some side faces" and "the grey/smooth texture that makes it look
 * fake". Measured from the app at 0.4–2.4 km: the Rock tile is high-passed and
 * mean-fitted by design, so past a 1.5 m footprint a face is one grey; the mesh
 * at that range is 8–32 m per vertex and band-limited to its own texel, so it
 * carries no relief under ~60 m; and what was drawn in between was two octaves
 * of SMOOTH value noise plus a strata term keyed on ALTITUDE. Smooth noise on a
 * smooth mesh is airbrush, and a field that is constant along a contour is a
 * contour line: the black horizontal lines.
 *
 * WHAT THIS FILE DRAWS: A CRAG FIELD. Billowed gradient noise — `|n|`, whose
 * zero set is a network of sharp CREASES round blocky faces — in three
 * incommensurate octaves, stretched along world Y and evaluated on the two
 * vertical world planes, blended by the same normal weights the material's own
 * triplanar projection uses. The planes are fixed in the world, so the field is
 * exact in absolute coordinates and cannot slide with the view or with CDLOD;
 * and on any face steep enough to be rock the fall line lies close to the
 * vertical of its dominant plane, so the grain runs downslope without a
 * per-fragment frame. One field drives the normal, the ambient occlusion and
 * the tone: a crease is recessed, occluded and dark in the same place, and the
 * noise changes SIGN across every crease, so adjacent blocks differ in tone the
 * way adjacent rock faces do.
 *
 * TRIED AND DROPPED, with frames, so nobody rebuilds them:
 *  - FALL-LINE RIBS from a pivoted phasor blend (the construction in Johansen's
 *    2026 erosion filter), aligned to the mesh normal's contour direction. It
 *    works exactly as designed and reads as DRAPED FABRIC: one wavelength, one
 *    profile, every rib parallel. Regularity is the tell, not direction.
 *  - BEDDING on a tilted plane with ledge shading. However it was broken up, it
 *    drew dark lines across faces, and "black horizontal lines" is the defect
 *    the owner named. Strata are not drawn at all now.
 *
 * Every term is zero-mean or mean-one, world-anchored, footprint-faded per
 * octave, gated to steep rock or to snow, and behind the W-1 tier lane.
 */

function wgslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * Horizontal wavelength of each crag octave, metres. No ratio between any two
 * is within 0.15 of an integer, so no octave's lines register with another's.
 *
 * The first three are the COARSE set: a face is organised by them into a few
 * big gullies and buttresses with detail inside (a face carrying one feature
 * size reads as wrinkled cloth — shot, and it did). They are also what the
 * rock/turf boundary reads, so rock runs down the big creases and turf climbs
 * the proud edges. The mesh could carry the 251 m and 109 m forms, but M-1
 * damped the kernel's fracture relief on massifs to get their slopes down, so
 * their SHADING is drawn here and their silhouette is not.
 */
export const ROCK_CRAG_WAVELENGTHS_METERS: readonly number[] = [251, 109, 43, 17.3, 6.7];
/** How many leading octaves form the coarse set. */
export const ROCK_CRAG_COARSE_OCTAVES = 3;
/**
 * +1 is a BILLOW octave (`|n|`: sharp concave creases round rounded faces), -1 a
 * RIDGED one (`-|n|`: sharp convex edges between rounded hollows). Billow alone
 * was shot first and reads as melted wax up close — every sharp line concave,
 * every face a pillow. Rock breaks along both.
 */
export const ROCK_CRAG_OCTAVE_SIGNS: readonly number[] = [1, -1, 1, -1, 1];
/** Vertical wavelength over horizontal: the grain that makes creases run downslope. */
export const ROCK_CRAG_VERTICAL_STRETCH = 2.2;
/** Small per-octave rotations in the plane, degrees, so creases are not all vertical. */
export const ROCK_CRAG_ROTATIONS_DEGREES: readonly number[] = [5, -7, 11, -17, 23];
/** Relief depth over wavelength, per octave: the big forms are broad, not deep. */
export const ROCK_CRAG_DEPTH_RATIOS: readonly number[] = [0.045, 0.06, 0.075, 0.075, 0.075];
/**
 * Rounding of each octave's cusp, in noise standard deviations. Zero is a knife
 * crease whose normal flips inside one pixel and sparkles. The two coarse
 * octaves are seen from kilometres and stay rounded (0.18 is about a tenth of a
 * wavelength); the two fine ones are only ever seen close, where a rounded
 * crease reads as melted wax — shot at 250 m, and that is what it looked like —
 * and their own footprint fade retires them before they can alias.
 */
export const ROCK_CRAG_CUSPS: readonly number[] = [0.22, 0.18, 0.18, 0.1, 0.07];
/** Billow value at which a line has fully opened into a face. */
export const ROCK_CRAG_CREASE_WIDTH = 0.5;
/**
 * E[line] per octave: the share of a face that is crease or edge, which the
 * tone and occlusion subtract so both stay zero-mean. Measured on the
 * unit-variance gradient noise for each cusp above; pinned.
 */
export const ROCK_CRAG_CREASE_MEANS: readonly number[] =
  [0.1127, 0.1387, 0.1387, 0.1824, 0.1938];
/** Share each octave contributes to the tone and occlusion of a crease. */
export const ROCK_CRAG_CREASE_SHARES: readonly number[] = [0.28, 0.24, 0.22, 0.16, 0.1];
/**
 * The one dial a cost or look review needs. It scales the relief's weight and
 * the boundary push together; at ZERO nothing in this file is evaluated at all
 * (the fragment's candidate test folds to false), which is the rollback and is
 * also how the relief's like-for-like cost is measured: same tree, same site,
 * dial at 0 against dial at 1. Measured that way on cliff-60m, a frame filled
 * with rock from 60 m (2026-09-20, interleaved off/on/off/on): 108.7 -> 98.6
 * fps, 9.2 %, with cruise-horizon flat.
 */
export const ROCK_RELIEF_STRENGTH = 1;
/**
 * The rock/turf boundary.
 *
 * A page's pair share is a softmax of suitabilities, so its LOGIT is linear in
 * the suitability difference: a ramp tens of metres wide, where the share
 * itself is a ramp one texel wide with flat ends. The boundary signal is added
 * there. Shot first as an additive push on the share, limited to +-0.45: the
 * outline moved ~10 m against a 100-250 m signal and every patch stayed a decal
 * (a debug tint, 2026-09-19, showed the page and not the fallback draws them).
 *
 * The signal is the crag field's own signed block field, weighted toward the
 * octaves a tongue is the size of, plus one finer isotropic octave. Zero and
 * one are fixed points of a logit push, so ground the classifier calls pure
 * stays pure: tongues and embayments, never islands out of nothing.
 */
export const ROCK_BOUNDARY_SHARES: readonly number[] = [0.3, 0.5, 0.65];
/**
 * Finer isotropic octaves: ragged as well as lobed, with islets. The last two
 * are only ever resolved from under ~150 m, where an outline drawn by the 8.9 m
 * octave alone is a smooth camouflage blob (cliff-60m, 2026-09-20); each fades
 * by footprint and is not evaluated once it has.
 */
export const ROCK_BOUNDARY_FINE_WAVELENGTHS_METERS: readonly number[] = [23, 8.9, 3.4, 1.3];
export const ROCK_BOUNDARY_FINE_SHARES: readonly number[] = [0.55, 0.45, 0.37, 0.3];
export const ROCK_BOUNDARY_LOGIT_GAIN = 2.4;
export const ROCK_BOUNDARY_LOGIT_LIMIT = 5;
/**
 * Below the first the pair is left alone; by the second the push is whole. The
 * page stores 8-bit top-four weights, so its share reaches zero along a smooth
 * envelope a few quanta out; with the push whole by 0.02 every strong tongue
 * ran out to that envelope and drew it as a clean hem (shot from 200 m,
 * 2026-09-20). Opened this slowly the outline turns back well inside it.
 */
export const ROCK_BOUNDARY_PURE_LOW = 0.004;
export const ROCK_BOUNDARY_PURE_HIGH = 0.08;
/**
 * Same signal on the fallback's slope driver, in units of slope. The fallback
 * ramps rock in over 0.30-0.66 and is what draws rock from a few kilometres
 * out, where a clean outline is most visible.
 */
export const ROCK_BOUNDARY_SLOPE_GAIN = 0.07;
export const ROCK_BOUNDARY_SLOPE_LIMIT = 0.17;
/**
 * How shattered a face is, as a multiplier on relief, over the low and high
 * ends of a slow field the caller already has. A range where every face is
 * fractured to the same density reads as wrinkled cloth; real faces run from
 * clean slab to rubble.
 */
export const ROCK_CRAG_FRACTURE_LOW = 0.5;
export const ROCK_CRAG_FRACTURE_HIGH = 1.35;
/** Tone lift on a ridged octave's convex edge: weathered, lichen-free, lighter. */
export const ROCK_CRAG_EDGE_TONE = 0.16;

/**
 * Slope (`1 - n.y`) a fragment needs before the crag field is evaluated for it
 * at all (~37 degrees) unless its page pair already holds rock. Relief itself
 * engages over half to five quarters of this: it has to follow COVER down to a
 * patch's edge, or the rim of every patch is drawn flat and pale.
 */
export const ROCK_RELIEF_SLOPE_LOW = 0.2;
/** Share of the relief scree carries: debris chutes, not bedrock. */
export const ROCK_RELIEF_GRAVEL_SHARE = 0.5;
/** Below this blend weight the second plane is not evaluated at all. */
export const ROCK_CRAG_SECOND_PLANE_MINIMUM = 0.12;
/**
 * The FINE octaves' second plane ramps in over this band of its own weight and
 * the major plane takes what it does not, so nothing pops as a face turns and
 * the amplitude is whole at every azimuth; under the band it is a branch skip.
 * On the exact diagonal (0.5 / 0.5) both planes are whole, which is the one
 * place a two-plane scheme needs them.
 */
export const ROCK_CRAG_FINE_SECOND_PLANE_LOW = 0.18;
export const ROCK_CRAG_FINE_SECOND_PLANE_HIGH = 0.34;

/** Tone: how much darker a full crease is than the face, as a fraction of albedo. */
export const ROCK_CRAG_CREASE_TONE = 0.42;
/** Tone step between the blocks either side of a crease, per noise sigma. */
export const ROCK_CRAG_BLOCK_TONE = 0.085;
/** Ambient occlusion inside a full crease. */
export const ROCK_CRAG_OCCLUSION = 0.5;
/**
 * Roughness a face converges to once its microstructure is sub-pixel. The
 * Rock tile's band is 0.45–0.72; the normals that vanish with the tile have
 * to come back as roughness (Toksvig), or a distant face is glossier than a
 * near one, which is the sheen in the report's frame.
 */
export const ROCK_RANGE_ROUGHNESS = 0.86;

/**
 * Snow in the creases. A couloir holds snow hundreds of metres below the
 * snowline because it is shaded and collects what the faces shed: the band, in
 * metres relative to the seasonal snowline, over which creases fill.
 */
export const ROCK_COULOIR_BELOW_SNOWLINE_METERS = 380;
export const ROCK_COULOIR_ABOVE_SNOWLINE_METERS = 40;

/**
 * Snow relief: wind drift. A snowfield under this renderer was ONE albedo on a
 * smooth mesh — a white blob (the shape sheets of 2026-09-19 show it on every
 * summit above the snowline). Wind packs snow into dunes elongated ALONG the
 * wind and closely spaced across it, so the field is anisotropic in a fixed
 * world frame, which also means it is exact in absolute coordinates.
 */
export const SNOW_WIND_AZIMUTH_DEGREES = 250;
export const SNOW_DRIFT_COARSE_ALONG_METERS = 150;
export const SNOW_DRIFT_COARSE_ACROSS_METERS = 47;
export const SNOW_DRIFT_COARSE_HEIGHT_METERS = 0.9;
export const SNOW_DRIFT_FINE_ALONG_METERS = 34;
export const SNOW_DRIFT_FINE_ACROSS_METERS = 9.5;
export const SNOW_DRIFT_FINE_HEIGHT_METERS = 0.22;
/** Albedo swing of a drift crest against its hollow; zero mean. */
export const SNOW_DRIFT_TONE = 0.05;
/** Ambient occlusion in a hollow at one standard deviation. */
export const SNOW_DRIFT_OCCLUSION = 0.09;

/** The billow and its derivative factor: `sqrt(n² + c²)` and `n / sqrt(n² + c²)`. */
export function rockCragBillow(noise: number, cusp: number): { billow: number; slopeFactor: number } {
  const billow = Math.sqrt(noise * noise + cusp * cusp);
  return { billow, slopeFactor: noise / billow };
}

/** How much of a crease this billow value is, in [0, 1]. */
export function rockCragCrease(billow: number): number {
  const t = Math.min(1, Math.max(0, billow / ROCK_CRAG_CREASE_WIDTH));
  return 1 - t * t * (3 - 2 * t);
}

/** What `crease` rests at before its mean was removed: the billow octaves' share-weighted mean. */
export const ROCK_CRAG_OCCLUSION_REST = ROCK_CRAG_CREASE_MEANS.reduce(
  (sum, mean, index) => sum + (ROCK_CRAG_OCTAVE_SIGNS[index]! > 0 ? mean * ROCK_CRAG_CREASE_SHARES[index]! : 0),
  0,
);

/** Rock-likeness of one material id: bedrock 1, scree a share, all else 0. */
/** The mineral share of a pair after a push of `push` logits. CPU twin. */
export function rockBoundaryPushedShare(mineralShare: number, push: number): number {
  const gate = Math.min(1, Math.max(0,
    (Math.min(mineralShare, 1 - mineralShare) - ROCK_BOUNDARY_PURE_LOW)
      / (ROCK_BOUNDARY_PURE_HIGH - ROCK_BOUNDARY_PURE_LOW)));
  const open = gate * gate * (3 - 2 * gate);
  if (open <= 0) return mineralShare;
  const bounded = Math.min(0.996, Math.max(0.004, mineralShare));
  const limited = Math.min(ROCK_BOUNDARY_LOGIT_LIMIT, Math.max(-ROCK_BOUNDARY_LOGIT_LIMIT, push));
  const logit = Math.log(bounded / (1 - bounded)) + limited * open;
  return 1 / (1 + Math.exp(-logit));
}

export function rockReliefShareOf(materialId: number): number {
  if (materialId === SurfaceMaterial.Rock) return 1;
  if (materialId === SurfaceMaterial.Gravel) return ROCK_RELIEF_GRAVEL_SHARE;
  return 0;
}

const WIND_RADIANS = (SNOW_WIND_AZIMUTH_DEGREES * Math.PI) / 180;
const WIND_X = Math.cos(WIND_RADIANS);
const WIND_Z = Math.sin(WIND_RADIANS);

function cragOctaveWgsl(index: number): string {
  const wavelength = ROCK_CRAG_WAVELENGTHS_METERS[index]!;
  const sign = ROCK_CRAG_OCTAVE_SIGNS[index]!;
  const radians = (ROCK_CRAG_ROTATIONS_DEGREES[index]! * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const inverseU = 1 / wavelength;
  const inverseV = 1 / (wavelength * ROCK_CRAG_VERTICAL_STRETCH);
  const share = ROCK_CRAG_CREASE_SHARES[index]!;
  // A billow octave's zero set is a recessed crease; a ridged octave's is a
  // proud edge. Same field, same line, opposite relief and opposite tone.
  const cusp = ROCK_CRAG_CUSPS[index]!;
  const lineMean = ROCK_CRAG_CREASE_MEANS[index]!;
  const lineTerm = sign > 0
    ? `crag.crease += (line - ${wgslFloat(lineMean)}) * weight * ${wgslFloat(share)};`
    : `crag.edge += (line - ${wgslFloat(lineMean)}) * weight * ${wgslFloat(share)};`;
  return `
  {
    let weight = terrainGroundOctaveWeight(${wgslFloat(wavelength)}, footprintMeters);
    if (weight > 0.001) {
      let scaledU = u * ${wgslFloat(inverseU)};
      let scaledV = v * ${wgslFloat(inverseV)};
      let field = terrainGroundNoiseGrad(
        vec2f(scaledU * ${wgslFloat(c)} - scaledV * ${wgslFloat(s)},
              scaledU * ${wgslFloat(s)} + scaledV * ${wgslFloat(c)}) + vec2f(${wgslFloat(13.7 + index * 31.1)}, ${wgslFloat(5.3 + index * 17.9)}),
        salt + ${index}u);
      let billow = sqrt(field.x * field.x + ${wgslFloat(cusp * cusp)});
      let slopeFactor = field.x / billow;
      // Back through the rotation (its transpose) and the two scalings.
      let perU = (field.y * ${wgslFloat(c)} + field.z * ${wgslFloat(s)}) * ${wgslFloat(inverseU)};
      let perV = (-field.y * ${wgslFloat(s)} + field.z * ${wgslFloat(c)}) * ${wgslFloat(inverseV)};
      let depth = ${wgslFloat(sign * wavelength * ROCK_CRAG_DEPTH_RATIOS[index]!)} * weight;
      crag.slope += vec2f(perU, perV) * (slopeFactor * depth);
      let line = 1.0 - smoothstep(0.0, ${wgslFloat(ROCK_CRAG_CREASE_WIDTH)}, billow);
      ${lineTerm}
      crag.block += field.x * weight * ${wgslFloat(share)};
      ${index < ROCK_CRAG_COARSE_OCTAVES ? `crag.boundary += field.x * weight * ${wgslFloat(ROCK_BOUNDARY_SHARES[index]!)};` : ""}
      ${index === 0 ? "crag.couloir += line * weight * 0.65;" : index === 2 ? "crag.couloir += line * weight * 0.35;" : ""}
    }
  }`;
}

function boundaryFineOctaveWgsl(wavelength: number, index: number): string {
  return `
  {
    let fineWeight = terrainGroundOctaveWeight(${wgslFloat(wavelength)}, footprintMeters);
    if (fineWeight > 0.001) {
      signal += terrainGroundNoiseGrad(
        worldXz * ${wgslFloat(1 / wavelength)} + vec2f(${wgslFloat(41.3 + index * 23.7)}, ${wgslFloat(7.9 + index * 11.3)}),
        ${0x83 + index}u).x * fineWeight * ${wgslFloat(ROCK_BOUNDARY_FINE_SHARES[index]!)};
    }
  }`;
}

/**
 * Composed AFTER `TERRAIN_GROUND_PATCHWORK_WGSL`: it reuses that block's
 * integer-hashed gradient noise and its per-octave footprint fade rather than
 * restating them.
 */
export const TERRAIN_ROCK_RELIEF_WGSL = /* wgsl */ `
fn terrainRockShareOf(materialIndex: i32) -> f32 {
  if (materialIndex == ${SurfaceMaterial.Rock}) { return 1.0; }
  if (materialIndex == ${SurfaceMaterial.Gravel}) { return ${wgslFloat(ROCK_RELIEF_GRAVEL_SHARE)}; }
  return 0.0;
}

struct TerrainRockCrag {
  // d height / d(u, v), metres per metre, in the plane's own axes.
  slope: vec2f,
  // Crease share, zero mean: positive inside a crease.
  crease: f32,
  // Proud-edge share, zero mean: positive on a ridged octave's convex edge.
  edge: f32,
  // Signed block tone, in noise sigmas: flips across every crease.
  block: f32,
  // The coarse octave's crease, in [0, 1]: what a couloir's snow lies in.
  couloir: f32,
  // Signed, in noise sigmas, weighted toward tongue-sized octaves.
  boundary: f32,
}

// One vertical world plane: u is the horizontal axis in metres, v is world Y.
// The coarse octaves, which the rock/turf boundary also reads.
fn terrainRockCragPlaneCoarse(u: f32, v: f32, footprintMeters: f32, salt: u32) -> TerrainRockCrag {
  var crag: TerrainRockCrag;
  crag.slope = vec2f(0.0);
  crag.crease = 0.0;
  crag.edge = 0.0;
  crag.block = 0.0;
  crag.couloir = 0.0;
  crag.boundary = 0.0;
${[0, 1, 2].map(cragOctaveWgsl).join("\n")}
  return crag;
}

// The fine octaves: only ever resolved close, so only evaluated on rock.
fn terrainRockCragPlaneFine(u: f32, v: f32, footprintMeters: f32, salt: u32) -> TerrainRockCrag {
  var crag: TerrainRockCrag;
  crag.slope = vec2f(0.0);
  crag.crease = 0.0;
  crag.edge = 0.0;
  crag.block = 0.0;
  crag.couloir = 0.0;
  crag.boundary = 0.0;
${[3, 4].map(cragOctaveWgsl).join("\n")}
  return crag;
}

struct TerrainRockCoarse {
  // d height / d world position, metres per metre, not yet made tangential.
  slopeWorld: vec3f,
  crease: f32,
  edge: f32,
  block: f32,
  couloir: f32,
  boundary: f32,
  // The two vertical planes' blend weights, kept so the fine pass agrees.
  weights: vec2f,
}

fn terrainRockCoarseAt(
  position: vec3f,
  geometricNormal: vec3f,
  footprintMeters: f32,
) -> TerrainRockCoarse {
  var coarse: TerrainRockCoarse;
  // The two vertical planes, weighted as the material's own triplanar
  // projection weights them, without the horizontal plane: nothing this
  // draws exists on ground level enough to need it.
  let axis = abs(geometricNormal.xz);
  var weights = axis * axis * axis * axis;
  weights = weights / max(weights.x + weights.y, 1e-5);
  coarse.weights = weights;
  coarse.slopeWorld = vec3f(0.0);
  coarse.crease = 0.0;
  coarse.edge = 0.0;
  coarse.block = 0.0;
  coarse.couloir = 0.0;
  coarse.boundary = 0.0;
  // Plane X: the face looks along world X, so its horizontal axis is world Z.
  if (weights.x > ${wgslFloat(ROCK_CRAG_SECOND_PLANE_MINIMUM)}) {
    let crag = terrainRockCragPlaneCoarse(position.z, position.y, footprintMeters, 0x71u);
    coarse.slopeWorld += vec3f(0.0, crag.slope.y, crag.slope.x) * weights.x;
    coarse.crease += crag.crease * weights.x;
    coarse.edge += crag.edge * weights.x;
    coarse.block += crag.block * weights.x;
    coarse.couloir += crag.couloir * weights.x;
    coarse.boundary += crag.boundary * weights.x;
  }
  if (weights.y > ${wgslFloat(ROCK_CRAG_SECOND_PLANE_MINIMUM)}) {
    let crag = terrainRockCragPlaneCoarse(position.x, position.y, footprintMeters, 0x79u);
    coarse.slopeWorld += vec3f(crag.slope.x, crag.slope.y, 0.0) * weights.y;
    coarse.crease += crag.crease * weights.y;
    coarse.edge += crag.edge * weights.y;
    coarse.block += crag.block * weights.y;
    coarse.couloir += crag.couloir * weights.y;
    coarse.boundary += crag.boundary * weights.y;
  }
  return coarse;
}

// The boundary's fine octaves: isotropic, so an outline is ragged as well as
// lobed. Added to the coarse set's own signed block field (coarse.boundary),
// and only evaluated where something reads the sum. Zero mean.
fn terrainRockBoundaryFine(worldXz: vec2f, footprintMeters: f32) -> f32 {
  var signal = 0.0;
${ROCK_BOUNDARY_FINE_WAVELENGTHS_METERS.map(boundaryFineOctaveWgsl).join("\n")}
  return signal;
}

// A pair's mineral share after a push of that many logits. 0 and 1 are fixed.
fn terrainRockBoundaryPushed(mineralShare: f32, push: f32) -> f32 {
  let open = smoothstep(${wgslFloat(ROCK_BOUNDARY_PURE_LOW)}, ${wgslFloat(ROCK_BOUNDARY_PURE_HIGH)},
    min(mineralShare, 1.0 - mineralShare));
  if (open <= 0.0) { return mineralShare; }
  let bounded = clamp(mineralShare, 0.004, 0.996);
  let limited = clamp(push, ${wgslFloat(-ROCK_BOUNDARY_LOGIT_LIMIT)}, ${wgslFloat(ROCK_BOUNDARY_LOGIT_LIMIT)});
  return 1.0 / (1.0 + exp(-(log(bounded / (1.0 - bounded)) + limited * open)));
}

fn terrainSnowShareOf(materialIndex: i32) -> f32 {
  if (materialIndex == ${SurfaceMaterial.Snow}) { return 1.0; }
  return 0.0;
}

// Wind drift on a snowfield: (d height / dx, d height / dz, height in standard
// deviations). Two anisotropic octaves in the fixed wind frame.
fn terrainSnowDriftAt(worldXz: vec2f, footprintMeters: f32) -> vec3f {
  let wind = vec2f(${wgslFloat(WIND_X)}, ${wgslFloat(WIND_Z)});
  let crossWind = vec2f(-wind.y, wind.x);
  let along = dot(worldXz, wind);
  let across = dot(worldXz, crossWind);
  var slope = vec2f(0.0);
  var level = 0.0;
  let coarseWeight = terrainGroundOctaveWeight(
    ${wgslFloat(SNOW_DRIFT_COARSE_ACROSS_METERS)}, footprintMeters);
  if (coarseWeight > 0.001) {
    let drift = terrainGroundNoiseGrad(vec2f(
      along * ${wgslFloat(1 / SNOW_DRIFT_COARSE_ALONG_METERS)},
      across * ${wgslFloat(1 / SNOW_DRIFT_COARSE_ACROSS_METERS)}), 0x61u);
    slope += (wind * (drift.y * ${wgslFloat(1 / SNOW_DRIFT_COARSE_ALONG_METERS)})
      + crossWind * (drift.z * ${wgslFloat(1 / SNOW_DRIFT_COARSE_ACROSS_METERS)}))
      * (${wgslFloat(SNOW_DRIFT_COARSE_HEIGHT_METERS)} * coarseWeight);
    level += drift.x * coarseWeight * 0.7;
  }
  let fineWeight = terrainGroundOctaveWeight(
    ${wgslFloat(SNOW_DRIFT_FINE_ACROSS_METERS)}, footprintMeters);
  if (fineWeight > 0.001) {
    let drift = terrainGroundNoiseGrad(vec2f(
      along * ${wgslFloat(1 / SNOW_DRIFT_FINE_ALONG_METERS)},
      across * ${wgslFloat(1 / SNOW_DRIFT_FINE_ACROSS_METERS)}), 0x62u);
    slope += (wind * (drift.y * ${wgslFloat(1 / SNOW_DRIFT_FINE_ALONG_METERS)})
      + crossWind * (drift.z * ${wgslFloat(1 / SNOW_DRIFT_FINE_ACROSS_METERS)}))
      * (${wgslFloat(SNOW_DRIFT_FINE_HEIGHT_METERS)} * fineWeight);
    level += drift.x * fineWeight * 0.5;
  }
  return vec3f(slope, level);
}

struct TerrainRockRelief {
  // Added to the (normalized) shading normal.
  normalOffset: vec3f,
  // Multiplies albedo; mean one.
  tone: vec3f,
  // Multiplies the ambient cavity term.
  occlusion: f32,
  // Added to roughness.
  roughness: f32,
  // Coarse crease share in [0, 1]: where a couloir's snow lies.
  couloir: f32,
}

fn terrainRockReliefAt(
  position: vec3f,
  geometricNormal: vec3f,
  footprintMeters: f32,
  fractureField: f32,
  coarse: TerrainRockCoarse,
) -> TerrainRockRelief {
  var relief: TerrainRockRelief;
  let weights = coarse.weights;
  var slopeWorld = coarse.slopeWorld;
  var crease = coarse.crease;
  var edge = coarse.edge;
  var block = coarse.block;
  let couloir = coarse.couloir;
  let minorWeight = min(weights.x, weights.y);
  let minorFine = minorWeight * smoothstep(
    ${wgslFloat(ROCK_CRAG_FINE_SECOND_PLANE_LOW)}, ${wgslFloat(ROCK_CRAG_FINE_SECOND_PLANE_HIGH)}, minorWeight);
  let fineWeights = select(
    vec2f(1.0 - minorFine, minorFine), vec2f(minorFine, 1.0 - minorFine), weights.x < weights.y);
  if (fineWeights.x > 0.001) {
    let crag = terrainRockCragPlaneFine(position.z, position.y, footprintMeters, 0x71u);
    slopeWorld += vec3f(0.0, crag.slope.y, crag.slope.x) * fineWeights.x;
    crease += crag.crease * fineWeights.x;
    edge += crag.edge * fineWeights.x;
    block += crag.block * fineWeights.x;
  }
  if (fineWeights.y > 0.001) {
    let crag = terrainRockCragPlaneFine(position.x, position.y, footprintMeters, 0x79u);
    slopeWorld += vec3f(crag.slope.x, crag.slope.y, 0.0) * fineWeights.y;
    crease += crag.crease * fineWeights.y;
    edge += crag.edge * fineWeights.y;
    block += crag.block * fineWeights.y;
  }
  // The face is displaced along its normal by the (zero-mean) crag height, so
  // its normal leans against the height's gradient WITHIN the face.
  // Slab to rubble: one slow field scales every term, so a clean face is clean
  // in its light, its tone and its occlusion together.
  let fracture = mix(
    ${wgslFloat(ROCK_CRAG_FRACTURE_LOW)}, ${wgslFloat(ROCK_CRAG_FRACTURE_HIGH)},
    smoothstep(0.25, 0.75, fractureField + coarse.couloir * 0.35));
  crease *= fracture;
  edge *= fracture;
  block *= fracture;
  let tangential = slopeWorld - geometricNormal * dot(geometricNormal, slopeWorld);
  relief.normalOffset = -tangential * fracture;
  // A crease is damp, shaded and dirt-filled: darker and a touch warmer. The
  // block term steps the tone across it. Both are zero-mean.
  let shade = 1.0 - crease * ${wgslFloat(ROCK_CRAG_CREASE_TONE)}
    + edge * ${wgslFloat(ROCK_CRAG_EDGE_TONE)}
    + clamp(block, -2.0, 2.0) * ${wgslFloat(ROCK_CRAG_BLOCK_TONE)};
  relief.tone = vec3f(shade)
    * mix(vec3f(1.0), vec3f(1.04, 1.0, 0.94), clamp(crease * 2.0, 0.0, 1.0));
  relief.occlusion = 1.0 - clamp(crease + ${wgslFloat(ROCK_CRAG_OCCLUSION_REST)}, 0.0, 1.0)
    * ${wgslFloat(ROCK_CRAG_OCCLUSION)};
  relief.roughness = clamp(crease, 0.0, 1.0) * 0.1;
  relief.couloir = clamp(couloir, 0.0, 1.0);
  return relief;
}
`;
