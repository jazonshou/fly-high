import * as THREE from "three";
import type {
  QualityLevel,
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";
import { preserveDestinationAlpha } from "./PreserveDestinationAlpha";

const MAX_CLOUDS = 64;
const CLOUD_WRAP_DISTANCE = 28_000;

type CloudFamilyKind = "cumulus" | "stratus" | "towering";

interface CloudSeed {
  readonly stableOrder: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
  readonly density: number;
  readonly colorR: number;
  readonly colorG: number;
  readonly colorB: number;
  renderX: number;
  renderZ: number;
  distanceSquared: number;
}

interface CloudFamily {
  readonly kind: CloudFamilyKind;
  readonly mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly seeds: CloudSeed[];
  readonly renderSeeds: CloudSeed[];
  readonly densityAttribute: THREE.InstancedBufferAttribute;
}

interface CloudImpostorLobe {
  readonly x: number;
  readonly y: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly strength: number;
}

interface CloudImpostorProfile {
  readonly width: number;
  readonly height: number;
  readonly lobes: readonly CloudImpostorLobe[];
}

/**
 * The complete cloud silhouette lives in one texture-backed impostor. Keeping
 * the lobes in the density field (rather than intersecting geometry) makes the
 * carrier impossible to read at grazing flight angles.
 */
const CLOUD_IMPOSTOR_PROFILES: Record<CloudFamilyKind, CloudImpostorProfile> = {
  cumulus: {
    width: 3.45,
    height: 2.1,
    lobes: [
      { x: -0.7, y: -0.22, radiusX: 0.25, radiusY: 0.28, strength: 0.52 },
      { x: -0.48, y: -0.05, radiusX: 0.34, radiusY: 0.42, strength: 0.82 },
      { x: -0.19, y: 0.24, radiusX: 0.36, radiusY: 0.5, strength: 0.96 },
      { x: 0.11, y: 0.38, radiusX: 0.3, radiusY: 0.43, strength: 0.9 },
      { x: 0.38, y: 0.13, radiusX: 0.38, radiusY: 0.45, strength: 0.92 },
      { x: 0.68, y: -0.16, radiusX: 0.25, radiusY: 0.28, strength: 0.5 },
      { x: -0.39, y: -0.37, radiusX: 0.38, radiusY: 0.22, strength: 0.62 },
      { x: 0.04, y: -0.34, radiusX: 0.46, radiusY: 0.25, strength: 0.78 },
      { x: 0.43, y: -0.31, radiusX: 0.31, radiusY: 0.2, strength: 0.54 },
      { x: -0.03, y: 0.71, radiusX: 0.17, radiusY: 0.2, strength: 0.42 },
    ],
  },
  stratus: {
    width: 4.15,
    height: 1.5,
    lobes: [
      { x: -0.76, y: -0.08, radiusX: 0.2, radiusY: 0.19, strength: 0.34 },
      { x: -0.59, y: 0.08, radiusX: 0.28, radiusY: 0.26, strength: 0.5 },
      { x: -0.36, y: -0.01, radiusX: 0.34, radiusY: 0.27, strength: 0.57 },
      { x: -0.09, y: 0.15, radiusX: 0.36, radiusY: 0.31, strength: 0.64 },
      { x: 0.19, y: 0.02, radiusX: 0.39, radiusY: 0.28, strength: 0.61 },
      { x: 0.46, y: 0.12, radiusX: 0.3, radiusY: 0.25, strength: 0.49 },
      { x: 0.72, y: -0.04, radiusX: 0.2, radiusY: 0.18, strength: 0.31 },
      { x: -0.49, y: -0.26, radiusX: 0.31, radiusY: 0.14, strength: 0.32 },
      { x: -0.02, y: -0.22, radiusX: 0.43, radiusY: 0.15, strength: 0.4 },
      { x: 0.48, y: -0.19, radiusX: 0.29, radiusY: 0.13, strength: 0.29 },
      { x: 0.03, y: 0.39, radiusX: 0.24, radiusY: 0.13, strength: 0.27 },
    ],
  },
  towering: {
    // A browser impostor cannot communicate the side volume of a very narrow
    // vertical cloud. The old portrait carrier therefore read as a suspended
    // grey rock. Keep the family vertically developed, but give it the broad
    // base and spreading anvil of a distant cumulonimbus silhouette.
    width: 3.7,
    height: 2.7,
    lobes: [
      { x: -0.7, y: -0.57, radiusX: 0.28, radiusY: 0.2, strength: 0.42 },
      { x: -0.35, y: -0.55, radiusX: 0.4, radiusY: 0.25, strength: 0.67 },
      { x: 0.08, y: -0.5, radiusX: 0.48, radiusY: 0.3, strength: 0.79 },
      { x: 0.53, y: -0.5, radiusX: 0.34, radiusY: 0.23, strength: 0.52 },
      { x: -0.3, y: -0.18, radiusX: 0.38, radiusY: 0.38, strength: 0.78 },
      { x: 0.12, y: -0.1, radiusX: 0.43, radiusY: 0.45, strength: 0.94 },
      { x: 0.38, y: 0.25, radiusX: 0.34, radiusY: 0.4, strength: 0.85 },
      { x: 0.02, y: 0.32, radiusX: 0.42, radiusY: 0.46, strength: 0.96 },
      { x: -0.45, y: 0.53, radiusX: 0.38, radiusY: 0.27, strength: 0.69 },
      { x: -0.03, y: 0.68, radiusX: 0.5, radiusY: 0.24, strength: 0.83 },
      { x: 0.5, y: 0.61, radiusX: 0.43, radiusY: 0.22, strength: 0.66 },
      { x: 0.78, y: 0.52, radiusX: 0.24, radiusY: 0.17, strength: 0.36 },
    ],
  },
};

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2d(x: number, y: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const wrap = (value: number) => ((value % period) + period) % period;
  const a = hash2d(wrap(x0), wrap(y0), seed);
  const b = hash2d(wrap(x0 + 1), wrap(y0), seed);
  const c = hash2d(wrap(x0), wrap(y0 + 1), seed);
  const d = hash2d(wrap(x0 + 1), wrap(y0 + 1), seed);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, sx),
    THREE.MathUtils.lerp(c, d, sx),
    sy,
  );
}

/** Generated family-specific albedo keeps cloud texture deterministic and asset-free. */
function createCloudTexture(seed: number, family: CloudFamilyKind): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const profile = CLOUD_IMPOSTOR_PROFILES[family];
  const frequencies =
    family === "stratus" ? [2, 5, 11, 23] : family === "towering" ? [4, 9, 19, 37] : [3, 7, 15, 31];
  const base = family === "stratus" ? 199 : family === "towering" ? 211 : 218;
  const contrast = family === "stratus" ? 34 : family === "towering" ? 58 : 46;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      let amplitude = 0.55;
      let noise = 0;
      let normalization = 0;
      for (let octave = 0; octave < 4; octave += 1) {
        const frequency = frequencies[octave] ?? 1;
        noise += periodicValueNoise(
          u * frequency,
          v * frequency,
          frequency,
          seed + octave * 1013,
        ) * amplitude;
        normalization += amplitude;
        amplitude *= 0.5;
      }
      const normalizedNoise = noise / normalization;
      const detail = normalizedNoise - 0.5;
      const erosionFrequency = family === "stratus" ? 13 : family === "towering" ? 23 : 19;
      const erosion = periodicValueNoise(
        u * erosionFrequency,
        v * erosionFrequency,
        erosionFrequency,
        seed ^ 0x5f21,
      );
      const filament = periodicValueNoise(
        u * (family === "stratus" ? 29 : 23),
        v * (family === "stratus" ? 9 : 23),
        family === "stratus" ? 29 : 23,
        seed ^ 0x78d1,
      );
      const normalizedX = (u - 0.5) * 2;
      const normalizedY = (v - 0.5) * 2;
      const broadWarp = periodicValueNoise(u * 3, v * 3, 3, seed ^ 0x31af) - 0.5;
      let silhouette = 0;
      for (let lobeIndex = 0; lobeIndex < profile.lobes.length; lobeIndex += 1) {
        const lobe = profile.lobes[lobeIndex]!;
        const lobeWarp = broadWarp * (0.04 + (lobeIndex % 3) * 0.012);
        const distance = Math.hypot(
          (normalizedX - lobe.x - lobeWarp) / lobe.radiusX,
          (normalizedY - lobe.y + lobeWarp * 0.72) / lobe.radiusY,
        );
        const lobeDensity = (
          1 - THREE.MathUtils.smoothstep(distance + (erosion - 0.5) * 0.13, 0.5, 1.08)
        ) * lobe.strength;
        // Probabilistic union keeps overlaps rounded without making a row of
        // isolated circles or producing the seams of intersecting meshes.
        silhouette = 1 - (1 - silhouette) * (1 - THREE.MathUtils.clamp(lobeDensity, 0, 1));
      }
      const borderDistance = Math.min(u, v, 1 - u, 1 - v);
      const transparentBorder = THREE.MathUtils.smoothstep(borderDistance, 0, 0.16);
      const edgeErosion =
        detail * (family === "stratus" ? 0.29 : 0.34) +
        (erosion - 0.5) * (family === "towering" ? 0.25 : 0.21);
      const erodedSilhouette = THREE.MathUtils.smoothstep(
        silhouette + edgeErosion,
        family === "stratus" ? 0.07 : 0.08,
        family === "towering" ? 0.8 : 0.76,
      );
      const densityBase = family === "stratus" ? 0.38 : family === "towering" ? 0.58 : 0.5;
      const interiorDensity = THREE.MathUtils.clamp(
        densityBase + detail * 0.88 + (erosion - 0.5) * 0.42 + silhouette * 0.24,
        0,
        1,
      );
      // Thin directional erosion makes stratus feather into streaks, while
      // the other families retain broken translucent pockets. This variation
      // is inside the density field, so it never exposes a rectangular card.
      const filamentCoverage = family === "stratus"
        ? THREE.MathUtils.lerp(0.34, 1, THREE.MathUtils.smoothstep(filament, 0.22, 0.82))
        : THREE.MathUtils.lerp(0.58, 1, THREE.MathUtils.smoothstep(filament, 0.18, 0.78));
      const density = THREE.MathUtils.clamp(
        interiorDensity *
          Math.pow(Math.max(erodedSilhouette, 0), family === "stratus" ? 1.34 : 1.18) *
          filamentCoverage *
          transparentBorder,
        0,
        1,
      );
      const verticalTone = THREE.MathUtils.smoothstep(v, 0.08, 0.84) - 0.5;
      const value = Math.round(
        THREE.MathUtils.clamp(base + detail * contrast + verticalTone * 13, 0, 255),
      );
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = Math.min(255, value + (family === "cumulus" ? 2 : 0));
      data[offset + 2] = Math.min(255, value + (family === "stratus" ? 7 : 4));
      // Exact zero borders remain transparent through mip reduction, while the
      // whole multi-lobed silhouette—not carrier geometry—defines the outline.
      data[offset + 3] = Math.round(density * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.premultiplyAlpha = false;
  texture.name = `procedural-cloud-${family}`;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A single camera-facing quad is the only geometry per cloud. The shader turns
 * it toward the active camera (including reflection cameras), so there is no
 * grazing angle at which a sheet edge or card intersection can become visible.
 */
function createCloudGeometry(family: CloudFamilyKind): THREE.BufferGeometry {
  const profile = CLOUD_IMPOSTOR_PROFILES[family];
  const geometry = new THREE.PlaneGeometry(profile.width, profile.height, 1, 1);
  geometry.name = `camera-facing-cloud-impostor-${family}`;
  geometry.userData.cloudCarrier = "camera-facing-soft-impostor";
  geometry.userData.cloudLobeCount = profile.lobes.length;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Add cool self-shading, soft silhouettes, and per-cloud density without another draw pass. */
function configureCloudSurface(
  material: THREE.MeshStandardMaterial,
  family: CloudFamilyKind,
): void {
  const profile = CLOUD_IMPOSTOR_PROFILES[family];
  const halfCarrierWidth = (profile.width * 0.5).toFixed(3);
  const halfCarrierHeight = (profile.height * 0.5).toFixed(3);
  const undersideTint =
    family === "stratus"
      ? "vec3(0.56, 0.65, 0.70)"
      : family === "towering"
        ? "vec3(0.50, 0.60, 0.66)"
        : "vec3(0.61, 0.69, 0.73)";
  const edgeTint = family === "stratus" ? "vec3(0.80, 0.87, 0.90)" : "vec3(0.84, 0.90, 0.92)";
  const undersideStrength = family === "stratus" ? "0.22" : family === "towering" ? "0.27" : "0.2";
  const nearOpacity = family === "stratus" ? "0.3" : family === "towering" ? "0.4" : "0.34";
  const verticalRange = family === "stratus"
    ? ["-0.75", "0.75", "-0.08"]
    : family === "towering"
      ? ["-1.35", "1.35", "-0.18"]
      : ["-1.05", "1.05", "-0.16"];

  material.onBeforeCompile = (shader) => {
    // CSM and quality changes can compose callbacks around this material. The
    // explicit marker makes this hook idempotent and guarantees the custom
    // instanced attribute is declared exactly once in any compiled program.
    if (!shader.vertexShader.includes("CLOUD_VOLUME_VERTEX")) {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>
        #define CLOUD_VOLUME_VERTEX
        attribute float cloudDensity;
        varying vec3 vCloudLocalPosition;
        varying float vCloudDensity;
        varying float vCloudProximityFade;`,
      ).replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vCloudLocalPosition = position;
        vCloudDensity = cloudDensity;
        vCloudProximityFade = 1.0;`,
      ).replace(
        "#include <project_vertex>",
        `#ifdef USE_INSTANCING
          // Spherical billboarding makes the sole carrier face the active
          // camera at every flight angle. World-up stabilisation keeps clouds
          // tied to the horizon during aircraft roll without exposing an edge.
          vec3 cloudInstanceCenter = vec3(instanceMatrix[3]);
          vec4 cloudCenterView = modelViewMatrix * vec4(cloudInstanceCenter, 1.0);
          vec3 cloudViewDirection = normalize(-cloudCenterView.xyz);
          vec3 cloudWorldUpView = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          // A hard fallback at the overhead singularity used to rotate the
          // complete card in one frame (the conspicuous vertical wedge/blink).
          // Blend continuously from horizon-stabilised right to camera right
          // only where world-up has no well-defined projection. Camera right
          // is guaranteed to be useful in that small overhead cone.
          vec3 cloudHorizonRight = cross(cloudWorldUpView, cloudViewDirection);
          float cloudHorizonStability = length(cloudHorizonRight);
          vec3 cloudStableRight = cloudHorizonRight / max(cloudHorizonStability, 0.0001);
          vec3 cloudCameraRightProjected =
            vec3(1.0, 0.0, 0.0) - cloudViewDirection * cloudViewDirection.x;
          vec3 cloudCameraRight = normalize(
            cloudCameraRightProjected + vec3(0.0, 0.0001, 0.0)
          );
          cloudStableRight *= mix(
            -1.0,
            1.0,
            step(0.0, dot(cloudStableRight, cloudCameraRight))
          );
          float cloudHorizonBlend = smoothstep(0.04, 0.28, cloudHorizonStability);
          vec3 cloudRightView = normalize(mix(
            cloudCameraRight,
            cloudStableRight,
            cloudHorizonBlend
          ));
          vec3 cloudUpView = normalize(cross(cloudViewDirection, cloudRightView));

          float cloudScaleX = length(instanceMatrix[0].xyz);
          float cloudScaleY = length(instanceMatrix[1].xyz);
          float cloudHalfWidth = ${halfCarrierWidth} * cloudScaleX;
          float cloudHalfHeight = ${halfCarrierHeight} * cloudScaleY;
          float cloudCarrierRadius = length(vec2(cloudHalfWidth, cloudHalfHeight));
          float cloudCenterDistance = length(cloudCenterView.xyz);

          float cloudShapePhase = fract(vCloudDensity * 37.173);
          float cloudRoll = (cloudShapePhase - 0.5) * 0.16;
          float cloudCosRoll = cos(cloudRoll);
          float cloudSinRoll = sin(cloudRoll);
          vec3 cloudRolledRight =
            cloudRightView * cloudCosRoll + cloudUpView * cloudSinRoll;
          vec3 cloudRolledUp =
            cloudUpView * cloudCosRoll - cloudRightView * cloudSinRoll;

          // A large tangent billboard can cross the camera near plane while
          // its centre remains off-axis. Clipping that triangle creates the
          // enormous wedges and converging "ray" lines seen in chase view.
          // Dissolve before entering the implied cloud volume, then reject the
          // complete carrier whenever any corner could touch the near plane.
          float cloudVolumeFade = smoothstep(
            cloudCarrierRadius * 0.72 + 80.0,
            cloudCarrierRadius * 1.48 + 260.0,
            cloudCenterDistance
          );
          // Bound the actual view-Z span of the rolled quad. Subtracting the
          // full diagonal radius was needlessly conservative for off-axis
          // clouds and made complete instances wink out long before the near
          // plane. This is the exact maximum corner excursion in view Z.
          float cloudViewDepthExtent =
            abs(cloudRolledRight.z) * cloudHalfWidth +
            abs(cloudRolledUp.z) * cloudHalfHeight;
          float cloudNearPlaneClearance = -cloudCenterView.z - cloudViewDepthExtent;
          float cloudNearPlaneFade = smoothstep(
            max(24.0, cloudCarrierRadius * 0.035),
            max(180.0, cloudCarrierRadius * 0.24),
            cloudNearPlaneClearance
          );
          vCloudProximityFade = cloudVolumeFade * cloudNearPlaneFade;
          vec2 cloudLocalOffset = mat2(
            cloudCosRoll, -cloudSinRoll,
            cloudSinRoll, cloudCosRoll
          ) * position.xy;

          vec4 mvPosition = cloudCenterView;
          mvPosition.xyz += cloudRightView * cloudLocalOffset.x * cloudScaleX;
          mvPosition.xyz += cloudUpView * cloudLocalOffset.y * cloudScaleY;
          bool cloudClipGuard =
            cloudCenterView.z >= -1.0 ||
            cloudNearPlaneClearance <= 2.0 ||
            vCloudProximityFade <= 0.001;
          gl_Position = cloudClipGuard
            ? vec4(2.0, 2.0, 2.0, 1.0)
            : projectionMatrix * mvPosition;
          #ifndef FLAT_SHADED
            // Lighting a translucent volume as a camera-facing sheet made its
            // brightness change when the aircraft turned. An upward volume
            // normal keeps sun response fixed in world space; the fragment
            // field supplies the top/underside relief.
            vNormal = cloudWorldUpView;
          #endif
        #else
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
          gl_Position = projectionMatrix * mvPosition;
        #endif`,
      );
    }
    if (!shader.fragmentShader.includes("CLOUD_VOLUME_FRAGMENT")) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
        #define CLOUD_VOLUME_FRAGMENT
        varying vec3 vCloudLocalPosition;
        varying float vCloudDensity;
        varying float vCloudProximityFade;`,
      ).replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        #ifdef USE_MAP
          // map_fragment already fetched this texel. Reusing it avoids doubling
          // cloud texture bandwidth merely to shade the same density sample.
          vec4 cloudSurfaceDetail = sampledDiffuseColor;
        #else
          vec4 cloudSurfaceDetail = vec4(0.72, 0.72, 0.72, 1.0);
        #endif
        // Cull only mathematically empty carrier texels. Unlike alphaTest,
        // this never quantises visible wisps, while avoiding the PBR lighting
        // cost across the quad's broad transparent border.
        if (cloudSurfaceDetail.a <= 0.0005 || vCloudProximityFade <= 0.0005) discard;
        // Screen-stable object-space mottling survives mip reduction at
        // kilometre distances. The alpha texture alone defines the silhouette;
        // no geometric edge or intersection participates in the outline.
        float cloudVolumeField =
          sin(dot(vCloudLocalPosition.xy, vec2(0.64, 1.12)) + vCloudDensity * 11.0) * 0.54 +
          sin(dot(vCloudLocalPosition.xy, vec2(-1.48, 0.77)) - vCloudDensity * 7.0) * 0.31 +
          sin(dot(vCloudLocalPosition.xy, vec2(2.71, -1.31)) + vCloudDensity * 3.0) * 0.15;
        float cloudVolumeVariation = smoothstep(-0.72, 0.76, cloudVolumeField);
        float cloudWispyVariation = smoothstep(
          0.1,
          0.9,
          sin(
            dot(vCloudLocalPosition.xy, vec2(1.08, -0.46)) +
            vCloudDensity * 17.0
          ) * 0.5 + 0.5
        );
        float cloudTopLight = smoothstep(${verticalRange[0]}, ${verticalRange[1]}, vCloudLocalPosition.y);
        float cloudUnderside = 1.0 - smoothstep(
          ${verticalRange[0]},
          ${verticalRange[2]},
          vCloudLocalPosition.y
        );
        float cloudSilhouetteEdge = 1.0 - smoothstep(0.08, 0.64, cloudSurfaceDetail.a);
        float cloudMottle =
          (cloudSurfaceDetail.r - 0.72) * 0.46 +
          (cloudSurfaceDetail.a - 0.46) * 0.34 +
          (cloudVolumeVariation - 0.5) * 0.68;
        float cloudInteriorErosion = 1.0 - smoothstep(0.16, 0.72, cloudSurfaceDetail.a);
        float cloudCameraDistance = length(vViewPosition);
        float cloudNearTranslucency = mix(
          ${nearOpacity},
          1.0,
          smoothstep(850.0, 3100.0, cloudCameraDistance)
        ) * vCloudProximityFade;
        float cloudOpacityVariation = mix(
          cloudVolumeVariation,
          cloudWispyVariation,
          ${family === "stratus" ? "0.62" : "0.42"}
        );
        float cloudAlphaFeather = max(fwidth(cloudSurfaceDetail.a) * 1.45, 0.012);
        float cloudSoftCoverage = smoothstep(
          0.012 - cloudAlphaFeather,
          0.44 + cloudAlphaFeather,
          cloudSurfaceDetail.a
        );
        float cloudDensityResponse = smoothstep(0.04, 0.82, vCloudDensity);
        diffuseColor.a *= vCloudDensity *
          mix(0.3, 0.94, cloudOpacityVariation) *
          mix(0.36, 1.0, cloudDensityResponse) *
          cloudSoftCoverage *
          cloudNearTranslucency;
        vec3 cloudCoolWhiteMottle = mix(
          vec3(0.82, 0.91, 0.98),
          vec3(1.075, 1.085, 1.06),
          smoothstep(0.08, 0.92, cloudVolumeVariation)
        );
        diffuseColor.rgb *= mix(0.78, 1.08, cloudTopLight) *
          (0.98 + cloudMottle * 0.28 - cloudInteriorErosion * 0.08) *
          cloudCoolWhiteMottle;
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          ${undersideTint} * (0.82 + cloudSurfaceDetail.r * 0.22),
          cloudUnderside * ${undersideStrength}
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          ${edgeTint},
          cloudSilhouetteEdge * (0.08 + cloudInteriorErosion * 0.1)
        );`,
      ).replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        // A small cool/white multiple-scattering contribution is independent
        // of the warm direct sun, so broad internal relief remains visible
        // after texture mipmaps have collapsed at long range.
        totalEmissiveRadiance += mix(
          vec3(0.012, 0.022, 0.032),
          vec3(0.045, 0.049, 0.048),
          cloudVolumeVariation
        ) * mix(0.42, 1.0, cloudSurfaceDetail.a);`,
      );
    }
  };
  material.customProgramCacheKey = () => `cloud-camera-impostor-${family}-v8`;
}

function wrapAround(value: number, center: number, span: number): number {
  const halfSpan = span * 0.5;
  return center + ((((value - center + halfSpan) % span) + span) % span) - halfSpan;
}

export class SkySystem {
  readonly group = new THREE.Group();
  readonly sunLight: THREE.DirectionalLight;
  readonly hemisphereLight: THREE.HemisphereLight;

  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly sun: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly cloudFamilies: CloudFamily[] = [];
  private readonly cloudTextures: THREE.DataTexture[] = [];
  private readonly sunPosition = new THREE.Vector3(4_300, 5_900, -7_800);
  private readonly cloudMatrix = new THREE.Matrix4();
  private readonly cloudPosition = new THREE.Vector3();
  private readonly cloudScale = new THREE.Vector3();
  private readonly cloudQuaternion = new THREE.Quaternion();
  private readonly cloudEuler = new THREE.Euler();
  private readonly cloudColor = new THREE.Color();
  private cloudDrift = 0;
  private timeOfDay: TimeOfDayPreset = "day";
  private weather: WeatherPreset = "breezy";
  private quality: QualityLevel = "medium";

  constructor(seed = 1) {
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x3588bb) },
        upperHazeColor: { value: new THREE.Color(0x91bed1) },
        horizonColor: { value: new THREE.Color(0xd2ddd3) },
        hazeBandColor: { value: new THREE.Color(0xb9ccca) },
        bottomColor: { value: new THREE.Color(0x69776a) },
        sunDirection: { value: new THREE.Vector3(0.4, 0.55, -0.72).normalize() },
        sunGlow: { value: new THREE.Color(0xffdda0) },
        hazeAmount: { value: 0.3 },
        atmosphericVariance: { value: 0.52 },
      },
      vertexShader: `
        varying vec3 vWorldDirection;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldDirection = normalize(worldPosition.xyz - cameraPosition);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vWorldDirection;
        uniform vec3 topColor;
        uniform vec3 upperHazeColor;
        uniform vec3 horizonColor;
        uniform vec3 hazeBandColor;
        uniform vec3 bottomColor;
        uniform vec3 sunDirection;
        uniform vec3 sunGlow;
        uniform float hazeAmount;
        uniform float atmosphericVariance;

        float atmosphericNoise(vec3 direction) {
          float broad = sin(dot(direction, vec3(4.7, 2.3, -3.6)) * 1.35);
          float middle = sin(dot(direction, vec3(-12.1, 7.4, 9.7)) + broad * 0.72);
          float fine = sin(dot(direction, vec3(23.7, -11.6, 17.3)) + middle * 0.38);
          return broad * 0.5 + middle * 0.34 + fine * 0.16;
        }

        void main() {
          // Varyings are linearly interpolated across the dome triangles. Their
          // length therefore drops below one between vertices unless restored
          // here, which used to facet the narrow sun disc and haze bands.
          vec3 skyDirection = normalize(vWorldDirection);
          float elevation = clamp(skyDirection.y, -1.0, 1.0);
          float skyAmount = smoothstep(-0.075, 0.68, elevation);
          float zenithAmount = pow(max(elevation, 0.0), 0.42);
          vec3 skyColor = mix(bottomColor, horizonColor, skyAmount);
          skyColor = mix(skyColor, upperHazeColor, smoothstep(0.01, 0.26, elevation));
          skyColor = mix(skyColor, topColor, zenithAmount);

          // World-direction signals remain fixed as the camera translates.
          // Their frequencies are deliberately broad enough to avoid temporal
          // aliasing while breaking up a mathematically perfect blue ramp.
          float atmosphereField = atmosphericNoise(skyDirection);
          float varianceMask = smoothstep(-0.04, 0.48, elevation) * (1.0 - zenithAmount * 0.28);
          vec3 warmVariance = vec3(0.018, 0.012, -0.006);
          vec3 coolVariance = vec3(-0.008, 0.012, 0.024);
          skyColor += mix(warmVariance, coolVariance, atmosphereField * 0.5 + 0.5) *
            atmosphereField * atmosphericVariance * varianceMask;

          float towardSun = max(dot(skyDirection, sunDirection), 0.0);
          float disc = smoothstep(0.99982, 0.99994, towardSun);
          float innerHalo = pow(towardSun, 96.0);
          float outerHalo = pow(towardSun, 9.0);
          float horizonHaze = exp(-abs(elevation) * 10.0) * hazeAmount;
          float lowAerosolDistance = (elevation - 0.018) * 17.0;
          float upperAerosolDistance = (elevation - 0.16) * 8.2;
          float lowAerosolBand = exp(-lowAerosolDistance * lowAerosolDistance);
          float upperAerosolBand = exp(-upperAerosolDistance * upperAerosolDistance);
          float directionalHaze = 0.72 + 0.28 * sin(
            skyDirection.x * 8.3 - skyDirection.z * 6.1 + atmosphereField * 0.45
          );
          float hazeBands = (
            lowAerosolBand * 0.72 + upperAerosolBand * 0.28
          ) * directionalHaze * hazeAmount;
          skyColor = mix(skyColor, horizonColor, horizonHaze * 0.34);
          skyColor = mix(skyColor, hazeBandColor, hazeBands * 0.24);
          skyColor += sunGlow * lowAerosolBand * pow(towardSun, 4.0) * hazeAmount * 0.055;
          skyColor += sunGlow * (disc * 1.25 + innerHalo * 0.34 + outerHalo * 0.075);

          // Sub-perceptual dithering prevents visible gradient bands after tone mapping.
          float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          skyColor += (dither - 0.5) / 255.0;
          gl_FragColor = vec4(skyColor, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(25_000, 40, 22), skyMaterial);
    this.sky.name = "procedural-atmosphere-dome";
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.group.add(this.sky);

    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(105, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff2c4, fog: false, toneMapped: false }),
    );
    this.group.add(this.sun);

    this.sunLight = new THREE.DirectionalLight(0xffe9c2, 2.4);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.camera.near = 100;
    this.sunLight.shadow.camera.far = 9_000;
    this.sunLight.shadow.camera.left = -105;
    this.sunLight.shadow.camera.right = 105;
    this.sunLight.shadow.camera.top = 105;
    this.sunLight.shadow.camera.bottom = -105;
    this.sunLight.shadow.bias = -0.00016;
    this.sunLight.shadow.normalBias = 0.18;
    this.sunLight.shadow.radius = 1.5;
    this.group.add(this.sunLight);

    this.hemisphereLight = new THREE.HemisphereLight(0xbfe4ff, 0x555a45, 1.4);
    this.group.add(this.hemisphereLight);

    const random = mulberry32(seed ^ 0x9e3779b9);
    const familyDefinitions: ReadonlyArray<readonly [CloudFamilyKind, number]> = [
      ["cumulus", 26],
      ["stratus", 20],
      ["towering", 18],
    ];
    for (const [kind, capacity] of familyDefinitions) {
      const familySeed =
        kind === "cumulus" ? 0x76bb41d3 : kind === "stratus" ? 0x42c6a17b : 0x19e5d37f;
      const texture = createCloudTexture(seed ^ familySeed, kind);
      const material = new THREE.MeshStandardMaterial({
        color: kind === "stratus" ? 0xf0f6fa : kind === "towering" ? 0xf5f8fa : 0xffffff,
        map: texture,
        roughness: kind === "towering" ? 0.94 : 1,
        metalness: 0,
        // Clouds scatter a large amount of skylight even on their shaded
        // underside. A small cool emissive fill approximates that multiple
        // scattering and prevents overhead lobes becoming soot-black.
        emissive: kind === "stratus" ? 0x91aab4 : kind === "towering" ? 0x8ca4af : 0x96acb5,
        emissiveIntensity: kind === "stratus" ? 0.46 : kind === "towering" ? 0.42 : 0.44,
        opacity: kind === "stratus" ? 0.2 : kind === "towering" ? 0.4 : 0.28,
        transparent: true,
        depthWrite: false,
        premultipliedAlpha: true,
        // Smooth translucent alpha must survive minification. Alpha test plus
        // alpha-to-coverage caused distant mip levels to toggle whole islands
        // of coverage as the camera moved by a fraction of a pixel.
        alphaTest: 0,
        alphaToCoverage: false,
        side: THREE.FrontSide,
        flatShading: false,
        fog: true,
        dithering: true,
      });
      preserveDestinationAlpha(material);
      configureCloudSurface(material, kind);
      material.forceSinglePass = true;
      material.name = `cloud-material-${kind}`;
      const cloudGeometry = createCloudGeometry(kind);
      const cloudDensities = new Float32Array(capacity);
      const densityAttribute = new THREE.InstancedBufferAttribute(cloudDensities, 1);
      densityAttribute.setUsage(THREE.DynamicDrawUsage);
      cloudGeometry.setAttribute("cloudDensity", densityAttribute);
      const mesh = new THREE.InstancedMesh(cloudGeometry, material, capacity);
      mesh.name = `cloud-family-${kind}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = kind === "stratus" ? -3 : kind === "cumulus" ? -2 : -1;
      const family: CloudFamily = {
        kind,
        mesh,
        seeds: [],
        renderSeeds: [],
        densityAttribute,
      };
      const seedColor = new THREE.Color();
      for (let index = 0; index < capacity; index += 1) {
        const angle = random() * Math.PI * 2;
        const radius = 1_400 + Math.sqrt(random()) * 9_600;
        const baseScale =
          kind === "stratus"
            ? 105 + random() * 100
            : kind === "towering"
              ? 105 + random() * 105
              : 110 + random() * 100;
        const scaleX = kind === "stratus"
          ? baseScale * (1.1 + random() * 0.45)
          : kind === "towering"
            ? baseScale * (0.92 + random() * 0.38)
            : baseScale * (1 + random() * 0.5);
        const scaleY = kind === "stratus"
          ? baseScale * (0.62 + random() * 0.3)
          : kind === "towering"
            ? baseScale * (0.9 + random() * 0.42)
            : baseScale * (0.68 + random() * 0.37);
        const scaleZ = kind === "stratus"
          ? baseScale * (0.72 + random() * 0.4)
          : baseScale * (0.74 + random() * 0.46);
        const altitude = kind === "stratus"
          ? 1_200 + random() * 1_200
          : kind === "towering"
            ? 1_600 + random() * 1_600
            : 2_300 + random() * 1_900;
        const baseBrightness = kind === "stratus" ? 0.93 : kind === "towering" ? 0.94 : 0.96;
        const brightness = baseBrightness + random() * (1 - baseBrightness);
        const colorR = brightness;
        const colorG = Math.min(1, brightness + (kind === "cumulus" ? 0.008 : 0));
        const colorB = Math.min(1, brightness + (kind === "stratus" ? 0.025 : 0.015));
        const minimumDensity = kind === "stratus" ? 0.08 : kind === "towering" ? 0.24 : 0.16;
        const maximumDensity = kind === "stratus" ? 0.46 : kind === "towering" ? 0.78 : 0.62;
        const density = minimumDensity + random() * (maximumDensity - minimumDensity);
        family.seeds.push({
          stableOrder: index,
          x: Math.cos(angle) * radius,
          y: altitude,
          z: Math.sin(angle) * radius,
          yaw: random() * Math.PI * 2,
          pitch: (random() - 0.5) * (kind === "stratus" ? 0.07 : 0.16),
          roll: (random() - 0.5) * (kind === "towering" ? 0.1 : 0.2),
          scaleX,
          scaleY,
          scaleZ,
          density,
          colorR,
          colorG,
          colorB,
          renderX: 0,
          renderZ: 0,
          distanceSquared: 0,
        });
        seedColor.setRGB(colorR, colorG, colorB);
        mesh.setColorAt(index, seedColor);
        cloudDensities[index] = density;
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.cloudTextures.push(texture);
      this.cloudFamilies.push(family);
      this.group.add(mesh);
    }
    this.updateCloudCount();
    this.configureShadowQuality();
  }

  update(
    cameraPosition: THREE.Vector3,
    deltaSeconds: number,
    originX = 0,
    originZ = 0,
  ): void {
    this.sky.position.copy(cameraPosition);
    this.sun.position.copy(cameraPosition).add(this.sunPosition);
    this.sunLight.position.copy(cameraPosition).addScaledVector(this.sunPosition, 0.72);

    const driftSpeed = this.weather === "clear" ? 4 : this.weather === "cloudy" ? 12 : 7;
    this.cloudDrift += deltaSeconds * driftSpeed;
    const absoluteCameraX = cameraPosition.x + originX;
    const absoluteCameraZ = cameraPosition.z + originZ;
    for (const family of this.cloudFamilies) {
      family.renderSeeds.length = family.mesh.count;
      for (let index = 0; index < family.mesh.count; index += 1) {
        const seed = family.seeds[index]!;
        const familyDrift = family.kind === "stratus" ? 0.78 : family.kind === "towering" ? 0.92 : 1;
        const absoluteX = wrapAround(
          seed.x + this.cloudDrift * familyDrift,
          absoluteCameraX,
          CLOUD_WRAP_DISTANCE,
        );
        const absoluteZ = wrapAround(
          seed.z + this.cloudDrift * (family.kind === "stratus" ? 0.12 : 0.18),
          absoluteCameraZ,
          CLOUD_WRAP_DISTANCE,
        );
        seed.renderX = absoluteX - originX;
        seed.renderZ = absoluteZ - originZ;
        const dx = seed.renderX - cameraPosition.x;
        const dy = seed.y - cameraPosition.y;
        const dz = seed.renderZ - cameraPosition.z;
        seed.distanceSquared = dx * dx + dy * dy + dz * dz;
        family.renderSeeds[index] = seed;
      }

      // Transparent InstancedMesh entries are not sorted by Three.js. Keeping
      // each family back-to-front avoids opaque-looking overlap bands while
      // retaining exactly one draw call per cloud family.
      family.renderSeeds.sort((left, right) => {
        const distanceDelta = right.distanceSquared - left.distanceSquared;
        const distanceScale = Math.max(right.distanceSquared, left.distanceSquared, 1);
        // A deterministic tie-break prevents transparent instances whose
        // distances differ only by float noise from exchanging order every
        // frame. Meaningfully separated clouds remain back-to-front.
        return Math.abs(distanceDelta) <= distanceScale * 1e-7
          ? left.stableOrder - right.stableOrder
          : distanceDelta;
      });
      for (let index = 0; index < family.renderSeeds.length; index += 1) {
        const seed = family.renderSeeds[index]!;
        this.cloudPosition.set(seed.renderX, seed.y, seed.renderZ);
        this.cloudScale.set(seed.scaleX, seed.scaleY, seed.scaleZ);
        this.cloudEuler.set(seed.pitch, seed.yaw, seed.roll);
        this.cloudQuaternion.setFromEuler(this.cloudEuler);
        this.cloudMatrix.compose(this.cloudPosition, this.cloudQuaternion, this.cloudScale);
        family.mesh.setMatrixAt(index, this.cloudMatrix);
        family.densityAttribute.setX(index, seed.density);
        this.cloudColor.setRGB(seed.colorR, seed.colorG, seed.colorB);
        family.mesh.setColorAt(index, this.cloudColor);
      }
      family.mesh.instanceMatrix.needsUpdate = true;
      family.densityAttribute.needsUpdate = true;
      if (family.mesh.instanceColor) family.mesh.instanceColor.needsUpdate = true;
    }

    const timeValue = this.timeOfDay === "dawn" ? 0.23 : this.timeOfDay === "golden" ? 0.42 : 0.58;
    const daylight = THREE.MathUtils.smoothstep(timeValue, 0.12, 0.5);
    this.sunLight.intensity = 0.68 + daylight * 1.62;
    this.hemisphereLight.intensity = 0.62 + daylight * 0.78;
  }

  setQuality(quality: QualityLevel): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.configureShadowQuality();
    this.updateCloudCount();
  }

  setAtmosphere(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): void {
    this.timeOfDay = timeOfDay;
    this.weather = weather;
    const material = this.sky.material;
    const topColor = material.uniforms.topColor?.value as THREE.Color | undefined;
    const upperHazeColor = material.uniforms.upperHazeColor?.value as THREE.Color | undefined;
    const horizonColor = material.uniforms.horizonColor?.value as THREE.Color | undefined;
    const hazeBandColor = material.uniforms.hazeBandColor?.value as THREE.Color | undefined;
    const bottomColor = material.uniforms.bottomColor?.value as THREE.Color | undefined;
    const sunGlow = material.uniforms.sunGlow?.value as THREE.Color | undefined;
    const hazeAmount = material.uniforms.hazeAmount;
    const atmosphericVariance = material.uniforms.atmosphericVariance;
    if (timeOfDay === "dawn") {
      topColor?.set(0x234f79);
      upperHazeColor?.set(0x9b94a9);
      horizonColor?.set(0xd09a83);
      hazeBandColor?.set(0xb88f91);
      bottomColor?.set(0x645c58);
      sunGlow?.set(0xffb27d);
      this.sunPosition.set(6_700, 2_100, -6_100);
      this.sunLight.color.set(0xffb783);
      this.hemisphereLight.color.set(0x9ec3e1);
      this.hemisphereLight.groundColor.set(0x4d493e);
    } else if (timeOfDay === "golden") {
      topColor?.set(0x397ba2);
      upperHazeColor?.set(0x9eb6bd);
      horizonColor?.set(0xd9b386);
      hazeBandColor?.set(0xc5a98e);
      bottomColor?.set(0x716653);
      sunGlow?.set(0xffcf88);
      this.sunPosition.set(6_200, 3_100, -7_200);
      this.sunLight.color.set(0xffc982);
      this.hemisphereLight.color.set(0xb9d5e5);
      this.hemisphereLight.groundColor.set(0x5b5744);
    } else {
      topColor?.set(0x3588bb);
      upperHazeColor?.set(0x91bed1);
      horizonColor?.set(0xd2ddd3);
      hazeBandColor?.set(0xb9ccca);
      bottomColor?.set(0x69776a);
      sunGlow?.set(0xffdda0);
      this.sunPosition.set(4_300, 5_900, -7_800);
      this.sunLight.color.set(0xffe9c2);
      this.hemisphereLight.color.set(0xbfe4ff);
      this.hemisphereLight.groundColor.set(0x555a45);
    }
    const sunDirection = material.uniforms.sunDirection?.value as THREE.Vector3 | undefined;
    sunDirection?.copy(this.sunPosition).normalize();
    if (hazeAmount) hazeAmount.value = weather === "cloudy" ? 0.68 : weather === "clear" ? 0.18 : 0.34;
    if (atmosphericVariance) {
      atmosphericVariance.value = weather === "cloudy" ? 0.34 : weather === "clear" ? 0.66 : 0.52;
    }

    for (const family of this.cloudFamilies) {
      const cloudyColor =
        family.kind === "stratus" ? 0xcbd8df : family.kind === "towering" ? 0xd5dfe4 : 0xe0e7e9;
      const fairColor =
        family.kind === "stratus" ? 0xf0f6fa : family.kind === "towering" ? 0xf5f8fa : 0xffffff;
      family.mesh.material.color.set(weather === "cloudy" ? cloudyColor : fairColor);
      family.mesh.material.roughness = weather === "cloudy" ? 0.96 : 1;
      const fairOpacity =
        family.kind === "stratus" ? 0.12 : family.kind === "towering" ? 0.3 : 0.19;
      const cloudyOpacity =
        family.kind === "stratus" ? 0.27 : family.kind === "towering" ? 0.5 : 0.36;
      family.mesh.material.opacity = weather === "cloudy"
        ? cloudyOpacity
        : weather === "clear"
          ? fairOpacity
          : THREE.MathUtils.lerp(fairOpacity, cloudyOpacity, 0.46);
      family.mesh.material.emissiveIntensity = weather === "cloudy"
        ? family.kind === "stratus" ? 0.58 : family.kind === "towering" ? 0.54 : 0.56
        : family.kind === "stratus" ? 0.44 : family.kind === "towering" ? 0.4 : 0.42;
    }
    this.updateCloudCount();
  }

  private configureShadowQuality(): void {
    const enabled = this.quality !== "low";
    this.sunLight.castShadow = enabled;
    const mapSize = this.quality === "high" ? 2_048 : 1_024;
    if (this.sunLight.shadow.mapSize.x !== mapSize) {
      this.sunLight.shadow.mapSize.set(mapSize, mapSize);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
    const extent = this.quality === "high" ? 130 : 105;
    this.sunLight.shadow.camera.left = -extent;
    this.sunLight.shadow.camera.right = extent;
    this.sunLight.shadow.camera.top = extent;
    this.sunLight.shadow.camera.bottom = -extent;
    this.sunLight.shadow.camera.updateProjectionMatrix();
  }

  private updateCloudCount(): void {
    const qualityCount = this.quality === "high" ? 64 : this.quality === "medium" ? 46 : 30;
    const weatherAmount = this.weather === "clear" ? 0.48 : this.weather === "cloudy" ? 1 : 0.76;
    const total = Math.max(16, Math.floor(qualityCount * weatherAmount));
    let remaining = total;
    for (let index = 0; index < this.cloudFamilies.length; index += 1) {
      const family = this.cloudFamilies[index]!;
      const lastFamily = index === this.cloudFamilies.length - 1;
      const proportional = Math.round((total * family.seeds.length) / MAX_CLOUDS);
      family.mesh.count = Math.min(family.seeds.length, lastFamily ? remaining : proportional);
      remaining -= family.mesh.count;
    }
  }

  dispose(): void {
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.sun.geometry.dispose();
    this.sun.material.dispose();
    for (const family of this.cloudFamilies) {
      family.mesh.geometry.dispose();
      family.mesh.material.dispose();
    }
    for (const texture of this.cloudTextures) texture.dispose();
    this.sunLight.shadow.map?.dispose();
  }
}
