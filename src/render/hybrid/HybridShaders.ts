export const HYBRID_FULLSCREEN_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const ANALYTIC_WATER_RAY_EPSILON = 1e-5;
export const ANALYTIC_WATER_MAX_DISTANCE_FACTOR = 1.5;

/** Scalar reference for the GLSL ray/flat-water intersection validity policy. */
export function analyticWaterRayDistance(
  cameraHeight: number,
  waterLevel: number,
  worldRayY: number,
  cameraFar: number,
): number | null {
  if (
    !Number.isFinite(cameraHeight) ||
    !Number.isFinite(waterLevel) ||
    !Number.isFinite(worldRayY) ||
    !Number.isFinite(cameraFar) ||
    cameraFar <= 0 ||
    Math.abs(worldRayY) < ANALYTIC_WATER_RAY_EPSILON
  ) {
    return null;
  }
  const distance = (waterLevel - cameraHeight) / worldRayY;
  return distance > 0 && distance <= cameraFar * ANALYTIC_WATER_MAX_DISTANCE_FACTOR
    ? distance
    : null;
}

/**
 * Shared verbatim by effect, temporal, and composite passes. Keeping one body
 * prevents high-altitude water from being reconstructed at three positions.
 */
export const HYBRID_ANALYTIC_WATER_POSITION_GLSL = /* glsl */ `
  vec3 analyticWaterViewPosition(vec2 uv, float fallbackDepth) {
    vec3 fallbackPosition = reconstructViewPosition(uv, fallbackDepth);
    // A flat ocean has an exact geometric solution. Reconstructing it from a
    // 0.08--32 km perspective depth buffer quantized distant scan rows into
    // horizontal bands, which the world-space ripple lookup then amplified.
    vec3 viewRay = normalize(reconstructViewPosition(uv, 0.5));
    vec3 worldRay = normalize(mat3(cameraWorldMatrix) * viewRay);
    float denominator = worldRay.y;
    if (abs(denominator) < ${ANALYTIC_WATER_RAY_EPSILON.toFixed(5)}) {
      return fallbackPosition;
    }
    float rayDistance = (waterLevel - cameraWorldMatrix[3].y) / denominator;
    if (rayDistance <= 0.0 ||
        rayDistance > cameraFar * ${ANALYTIC_WATER_MAX_DISTANCE_FACTOR.toFixed(1)}) {
      return fallbackPosition;
    }
    return viewRay * rayDistance;
  }
`;

// The same bounded, mipmapped surface spectrum is used by the forward material,
// half-resolution reflection march, and full-resolution composite. Keeping one
// world-anchored field across all three stages prevents reflection swim and
// avoids the parallel bands produced by a handful of coherent sine waves.
const HYBRID_WATER_SPECTRUM_GLSL = /* glsl */ `
  vec2 hybridWaterDomainWarp(vec2 point, float time) {
    return vec2(
      sin(dot(point, vec2(-0.423, 0.906)) * 0.0017 + time * 0.055),
      sin(dot(point, vec2(0.719, 0.695)) * 0.0023 - time * 0.041)
    );
  }

  vec4 hybridWaterSurfaceField(vec2 point, float time, float pixelFootprint) {
    vec2 warp = hybridWaterDomainWarp(point, time);
    vec2 broadPoint = point + vec2(
      warp.x * 31.0 + warp.y * 11.0,
      warp.y * 37.0 - warp.x * 9.0
    );
    vec2 middlePoint = vec2(
      point.x * 0.819152 - point.y * 0.573576,
      point.x * 0.573576 + point.y * 0.819152
    );
    vec2 finePoint = vec2(
      point.x * 0.438371 + point.y * 0.898794,
      -point.x * 0.898794 + point.y * 0.438371
    );
    vec4 broadSample = texture2D(
      waterSurfaceDetailMap,
      broadPoint * 0.000244140625 + vec2(time * 0.000041, -time * 0.000027)
    );
    vec4 middleSample = texture2D(
      waterSurfaceDetailMap,
      middlePoint * 0.0009765625 + vec2(-time * 0.00023, time * 0.00017)
    );
    vec4 fineSample = texture2D(
      waterSurfaceDetailMap,
      finePoint * 0.00390625 + vec2(time * 0.0011, time * 0.00073)
    );
    vec2 broadNormal = broadSample.rg * 2.0 - 1.0;
    // Alpha is the opaque texture tag and is constant one. Sampling BA gave
    // every wave a permanent +Y slope; use two independent noise channels.
    vec2 middleNormal = middleSample.br * 2.0 - 1.0;
    vec2 fineNormal = fineSample.gr * 2.0 - 1.0;
    float broadFade = 1.0 - smoothstep(90.0, 480.0, pixelFootprint);
    float middleFade = 1.0 - smoothstep(12.0, 100.0, pixelFootprint);
    float fineFade = 1.0 - smoothstep(1.5, 20.0, pixelFootprint);
    vec2 slope =
      broadNormal * 0.082 * broadFade +
      middleNormal * 0.047 * middleFade +
      fineNormal * 0.021 * fineFade;
    float surfaceTone = clamp(
      0.5 + dot(broadNormal, vec2(0.28, -0.2)) +
        dot(middleNormal, vec2(-0.09, 0.11)),
      0.0,
      1.0
    );
    float microEnergy = clamp(
      length(middleNormal) * 0.52 + length(fineNormal) * 0.28,
      0.0,
      1.0
    );
    return vec4(slope, surfaceTone, microEnergy);
  }

  vec2 hybridWaterSlope(vec2 point, float time, float pixelFootprint) {
    return hybridWaterSurfaceField(point, time, pixelFootprint).xy;
  }
`;

/**
 * One half-resolution pass shares depth reconstruction between SSAO and the
 * water-only screen-space reflection march. RGB stores a reflection candidate
 * (beauty on a miss); alpha stores AO visibility. Water deliberately does not
 * receive solid-surface AO.
 */
export const HYBRID_EFFECT_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D beautyMap;
  uniform sampler2D depthMap;
  uniform vec2 beautyTexel;
  uniform mat4 projectionMatrixValue;
  uniform mat4 inverseProjectionMatrix;
  uniform mat4 cameraWorldMatrix;
  uniform mat4 viewMatrixValue;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float waterLevel;
  uniform float waterTime;
  uniform vec2 waterWorldOrigin;
  uniform sampler2D waterSurfaceDetailMap;
  uniform float waterDetailStrength;
  uniform int aoTapCount;
  uniform float aoRadius;
  uniform float aoStrength;
  uniform int ssrStepCount;
  uniform float ssrMaxDistance;
  uniform float ssrThickness;

  // Keep the final representable depth interval for the actual clear plane.
  // The previous 1e-6 cutoff classified kilometres of fogged far terrain and
  // water as background with a near/far ratio of 0.08 / 32000, so tiny camera
  // changes toggled the horizon between two post-process paths.
  const float HYBRID_SKY_DEPTH = 0.9999999;

  ${HYBRID_WATER_SPECTRUM_GLSL}

  float sceneDepth(vec2 uv) {
    return texture2D(depthMap, clamp(uv, vec2(0.0), vec2(1.0))).x;
  }

  vec3 reconstructViewPosition(vec2 uv, float depth) {
    vec4 clipPosition = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPosition = inverseProjectionMatrix * clipPosition;
    return viewPosition.xyz / max(abs(viewPosition.w), 1e-7);
  }

  ${HYBRID_ANALYTIC_WATER_POSITION_GLSL}

  vec3 viewPositionAt(vec2 uv) {
    return reconstructViewPosition(uv, sceneDepth(uv));
  }

  vec3 estimateViewNormal(vec2 uv, vec3 centerPosition) {
    vec3 leftPosition = viewPositionAt(uv - vec2(beautyTexel.x, 0.0));
    vec3 rightPosition = viewPositionAt(uv + vec2(beautyTexel.x, 0.0));
    vec3 downPosition = viewPositionAt(uv - vec2(0.0, beautyTexel.y));
    vec3 upPosition = viewPositionAt(uv + vec2(0.0, beautyTexel.y));
    vec3 horizontal = abs(leftPosition.z - centerPosition.z) <
      abs(rightPosition.z - centerPosition.z)
        ? centerPosition - leftPosition
        : rightPosition - centerPosition;
    vec3 vertical = abs(downPosition.z - centerPosition.z) <
      abs(upPosition.z - centerPosition.z)
        ? centerPosition - downPosition
        : upPosition - centerPosition;
    vec3 result = normalize(cross(horizontal, vertical));
    if (dot(result, -centerPosition) < 0.0) result = -result;
    return result;
  }

  float interleavedGradientNoise(vec2 pixel) {
    return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
  }

  float ambientVisibility(vec2 uv, vec3 centerPosition, vec3 normal) {
    if (aoTapCount <= 0) return 1.0;
    float centerDistance = max(-centerPosition.z, cameraNear);
    float distanceFade = 1.0 - smoothstep(
      min(1400.0, cameraFar * 0.08),
      min(3200.0, cameraFar * 0.18),
      centerDistance
    );
    vec2 projectedRadius = vec2(
      projectionMatrixValue[0][0],
      projectionMatrixValue[1][1]
    ) * (aoRadius / centerDistance) * 0.5;
    float rotation = interleavedGradientNoise(gl_FragCoord.xy) * 6.28318530718;
    float occlusion = 0.0;
    float accepted = 0.0;
    for (int index = 0; index < 16; index++) {
      if (index < aoTapCount) {
        float amount = (float(index) + 0.75) / max(float(aoTapCount), 1.0);
        float angle = rotation + float(index) * 2.39996322973;
        vec2 direction = vec2(cos(angle), sin(angle));
        vec2 sampleUv = uv + direction * projectedRadius * sqrt(amount);
        if (all(greaterThan(sampleUv, vec2(0.001))) &&
            all(lessThan(sampleUv, vec2(0.999)))) {
          float sampleRawDepth = sceneDepth(sampleUv);
          if (sampleRawDepth < HYBRID_SKY_DEPTH) {
            vec3 samplePosition = reconstructViewPosition(sampleUv, sampleRawDepth);
            vec3 delta = samplePosition - centerPosition;
            float sampleDistance = length(delta);
            float horizon = max(
              dot(normal, delta / max(sampleDistance, 1e-5)) - 0.08,
              0.0
            );
            float rangeWeight = 1.0 - smoothstep(
              aoRadius * 0.18,
              aoRadius * 1.35,
              sampleDistance
            );
            occlusion += horizon * rangeWeight;
            accepted += 1.0;
          }
        }
      }
    }
    float normalizedOcclusion = accepted > 0.0 ? occlusion / accepted : 0.0;
    return clamp(
      1.0 - normalizedOcclusion * aoStrength * distanceFade * 2.25,
      0.28,
      1.0
    );
  }

  vec3 worldPositionFromView(vec3 viewPosition) {
    vec3 worldPosition = (cameraWorldMatrix * vec4(viewPosition, 1.0)).xyz;
    worldPosition.xz += waterWorldOrigin;
    return worldPosition;
  }

  float waterMaterialMask(vec2 uv) {
    // Water writes zero to beauty alpha; all other opaque materials and the
    // background write one. This exact material tag replaces the old inferred
    // height/normal test that classified flat lowland as reflective water.
    float materialTag = texture2D(
      beautyMap,
      clamp(uv, vec2(0.0), vec2(1.0))
    ).a;
    return 1.0 - smoothstep(0.02, 0.45, materialTag);
  }

  vec3 proceduralWaterViewNormal(vec3 viewPosition) {
    vec3 worldPosition = worldPositionFromView(viewPosition);
    float footprint = max(
      length(dFdx(worldPosition.xz)),
      length(dFdy(worldPosition.xz))
    );
    vec2 slope = hybridWaterSlope(worldPosition.xz, waterTime, footprint) *
      waterDetailStrength;
    vec3 normal = normalize(mat3(viewMatrixValue) * vec3(-slope.x, 1.0, -slope.y));
    if (dot(normal, -viewPosition) < 0.0) normal = -normal;
    return normal;
  }

  vec3 screenSpaceReflection(
    vec2 uv,
    vec3 centerPosition,
    vec3 normal,
    vec3 fallbackColor,
    float surfaceMask
  ) {
    if (ssrStepCount <= 0 || surfaceMask < 0.001) return fallbackColor;
    vec3 incident = normalize(centerPosition);
    vec3 rayDirection = normalize(reflect(incident, normal));
    float horizonTraceConfidence = smoothstep(0.015, 0.11, -rayDirection.z);
    if (horizonTraceConfidence <= 0.0) return fallbackColor;
    vec3 startPosition = centerPosition + normal * max(0.08, ssrThickness * 0.08);
    vec3 hitColor = fallbackColor;
    float hitConfidence = 0.0;
    float foundHit = 0.0;
    float previousRayDistance = 0.0;
    // A crossing is valid only after the march has actually observed a sample
    // in front of scene depth. The former synthetic "free" start let the very
    // first coarse step hit any silhouette behind it, drawing step contours.
    float previousSeparation = 0.0;
    float previousValid = 0.0;
    float temporalRayPhase = fract(floor(waterTime * 60.0) * 0.61803398875);
    float rayJitter = fract(
      interleavedGradientNoise(gl_FragCoord.xy) + temporalRayPhase
    ) * 0.42;
    for (int index = 0; index < 32; index++) {
      if (index < ssrStepCount && foundHit < 0.5) {
        float amount = (float(index) + 0.68 + rayJitter) /
          max(float(ssrStepCount), 1.0);
        amount = clamp(amount, 0.0, 1.0);
        float rayDistance = ssrMaxDistance * mix(amount, amount * amount, 0.58);
        vec3 rayPosition = startPosition + rayDirection * rayDistance;
        vec4 projected = projectionMatrixValue * vec4(rayPosition, 1.0);
        if (projected.w > 0.0) {
          vec2 rayUv = projected.xy / projected.w * 0.5 + 0.5;
          if (all(greaterThan(rayUv, vec2(0.002))) &&
              all(lessThan(rayUv, vec2(0.998)))) {
            float rawHitDepth = sceneDepth(rayUv);
            if (rawHitDepth < HYBRID_SKY_DEPTH) {
              vec3 hitPosition = reconstructViewPosition(rayUv, rawHitDepth);
              float hitDepth = -hitPosition.z;
              float rayDepth = -rayPosition.z;
              float separation = rayDepth - hitDepth;
              float adaptiveThickness = ssrThickness * (1.0 + rayDepth * 0.0008);
              float crossedSurface = previousValid *
                step(previousSeparation, -0.00001) *
                step(0.0, separation);
              if (crossedSurface > 0.5 &&
                  separation < adaptiveThickness * 4.5 &&
                  waterMaterialMask(rayUv) < 0.5) {
                // Two fixed refinement taps are enough to hide the coarse step
                // intervals while preserving the strict browser budget. A
                // confirmed hit also spends four taps on the edge-aware hit
                // normal, so incremental SSR work is bounded by
                // ssrStepCount + 6 depth samples per water pixel.
                float lowerDistance = previousRayDistance;
                float upperDistance = rayDistance;
                vec2 refinedUv = rayUv;
                float refinedSeparation = separation;
                vec3 refinedHitPosition = hitPosition;
                for (int refinement = 0; refinement < 2; refinement++) {
                  float refinedDistance = (lowerDistance + upperDistance) * 0.5;
                  vec3 refinedRayPosition =
                    startPosition + rayDirection * refinedDistance;
                  vec4 refinedProjected = projectionMatrixValue *
                    vec4(refinedRayPosition, 1.0);
                  vec2 candidateUv = refinedProjected.xy /
                    max(refinedProjected.w, 0.00001) * 0.5 + 0.5;
                  float candidateDepth = sceneDepth(candidateUv);
                  if (refinedProjected.w > 0.0 &&
                      all(greaterThan(candidateUv, vec2(0.001))) &&
                      all(lessThan(candidateUv, vec2(0.999))) &&
                      candidateDepth < HYBRID_SKY_DEPTH) {
                    vec3 candidatePosition = reconstructViewPosition(
                      candidateUv,
                      candidateDepth
                    );
                    float candidateSeparation =
                      -refinedRayPosition.z + candidatePosition.z;
                    if (candidateSeparation >= 0.0) {
                      upperDistance = refinedDistance;
                      refinedUv = candidateUv;
                      refinedSeparation = candidateSeparation;
                      refinedHitPosition = candidatePosition;
                    } else {
                      lowerDistance = refinedDistance;
                    }
                  } else {
                    lowerDistance = refinedDistance;
                  }
                }
                float edge = min(
                  min(refinedUv.x, refinedUv.y),
                  min(1.0 - refinedUv.x, 1.0 - refinedUv.y)
                );
                float edgeFade = smoothstep(0.0, 0.085, edge);
                float distanceFade = 1.0 - smoothstep(0.55, 1.0, amount);
                float thicknessConfidence = 1.0 - smoothstep(
                  adaptiveThickness * 0.25,
                  adaptiveThickness * 1.25,
                  max(refinedSeparation, 0.0)
                );
                float directionConfidence = smoothstep(
                  0.02,
                  0.24,
                  -rayDirection.z
                );
                vec3 hitNormal = estimateViewNormal(refinedUv, refinedHitPosition);
                float hitFacingConfidence = smoothstep(
                  0.035,
                  0.34,
                  dot(hitNormal, -rayDirection)
                );
                float stepInterval = max(rayDistance - previousRayDistance, 0.0);
                float intervalConfidence = 1.0 - smoothstep(
                  adaptiveThickness * 2.0,
                  adaptiveThickness * 8.0,
                  stepInterval
                );
                float solidHitConfidence = 1.0 - waterMaterialMask(refinedUv);
                hitConfidence = edgeFade * distanceFade *
                  thicknessConfidence * directionConfidence *
                  hitFacingConfidence * intervalConfidence *
                  horizonTraceConfidence * solidHitConfidence * surfaceMask;
                hitColor = texture2D(beautyMap, refinedUv).rgb;
                foundHit = 1.0;
              }
              previousRayDistance = rayDistance;
              previousSeparation = separation;
              previousValid = 1.0;
            } else {
              previousValid = 0.0;
            }
          } else {
            foundHit = 1.0;
          }
        } else {
          foundHit = 1.0;
        }
      }
    }
    return mix(fallbackColor, hitColor, hitConfidence);
  }

  void main() {
    vec4 beautySample = texture2D(beautyMap, vUv);
    vec3 beauty = beautySample.rgb;
    float rawDepth = sceneDepth(vUv);
    float waterMask = 1.0 - smoothstep(0.02, 0.45, beautySample.a);
    if (rawDepth >= HYBRID_SKY_DEPTH && waterMask < 0.001) {
      gl_FragColor = vec4(beauty, 1.0);
      return;
    }
    vec3 viewPosition = waterMask > 0.001
      ? analyticWaterViewPosition(vUv, rawDepth)
      : reconstructViewPosition(vUv, rawDepth);
    float visibility = 1.0;
    vec3 reflectionNormal;
    if (waterMask > 0.001) {
      reflectionNormal = proceduralWaterViewNormal(viewPosition);
    } else {
      vec3 geometricViewNormal = estimateViewNormal(vUv, viewPosition);
      visibility = ambientVisibility(vUv, viewPosition, geometricViewNormal);
      reflectionNormal = geometricViewNormal;
    }
    vec3 reflected = screenSpaceReflection(
      vUv,
      viewPosition,
      reflectionNormal,
      beauty,
      waterMask
    );
    gl_FragColor = vec4(reflected, visibility);
  }
`;

export const HYBRID_TEMPORAL_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D currentEffectsMap;
  uniform sampler2D historyMap;
  uniform sampler2D beautyMap;
  uniform sampler2D depthMap;
  uniform sampler2D previousSurfaceMap;
  uniform vec2 effectsTexel;
  uniform mat4 inverseProjectionMatrix;
  uniform mat4 cameraWorldMatrix;
  uniform mat4 previousViewProjectionMatrix;
  uniform float cameraFar;
  uniform float waterLevel;
  uniform float historyWeight;
  uniform float waterHistoryWeight;
  uniform float historyValid;

  const float HYBRID_SKY_DEPTH = 0.9999999;

  float unpackDepth24(vec3 packedDepth) {
    return dot(packedDepth, vec3(1.0, 1.0 / 255.0, 1.0 / 65025.0));
  }

  vec3 reconstructViewPosition(vec2 uv, float depth) {
    vec4 clipPosition = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPosition = inverseProjectionMatrix * clipPosition;
    return viewPosition.xyz / max(abs(viewPosition.w), 1e-7);
  }

  vec3 reconstructWorldPosition(vec3 viewPosition) {
    return (cameraWorldMatrix * vec4(viewPosition, 1.0)).xyz;
  }

  ${HYBRID_ANALYTIC_WATER_POSITION_GLSL}

  void main() {
    vec4 current = texture2D(currentEffectsMap, vUv);
    if (historyValid < 0.5) {
      gl_FragColor = current;
      return;
    }
    float depth = texture2D(depthMap, vUv).x;
    float currentWaterTag = 1.0 - smoothstep(
      0.02,
      0.45,
      texture2D(beautyMap, vUv).a
    );
    if (depth >= HYBRID_SKY_DEPTH && currentWaterTag < 0.001) {
      gl_FragColor = current;
      return;
    }
    vec3 viewPosition = currentWaterTag > 0.001
      ? analyticWaterViewPosition(vUv, depth)
      : reconstructViewPosition(vUv, depth);
    vec3 worldPosition = reconstructWorldPosition(viewPosition);
    vec4 previousClip = previousViewProjectionMatrix * vec4(worldPosition, 1.0);
    if (previousClip.w <= 0.0) {
      gl_FragColor = current;
      return;
    }
    vec2 previousUv = previousClip.xy / previousClip.w * 0.5 + 0.5;
    if (any(lessThan(previousUv, vec2(0.001))) ||
        any(greaterThan(previousUv, vec2(0.999)))) {
      gl_FragColor = current;
      return;
    }

    // Reprojection alone cannot establish that the old pixel described the
    // same surface. Compare a compact previous-frame depth/material snapshot
    // before touching history. This rejects disocclusions that previously
    // stretched AO and reflected radiance into long screen-space streaks.
    vec4 previousSurface = texture2D(previousSurfaceMap, previousUv);
    float previousDepth = unpackDepth24(previousSurface.rgb);
    float expectedPreviousDepth = previousClip.z / previousClip.w * 0.5 + 0.5;
    float currentDepthGradient = max(
      abs(depth - texture2D(depthMap, vUv + vec2(effectsTexel.x, 0.0)).x),
      abs(depth - texture2D(depthMap, vUv + vec2(0.0, effectsTexel.y)).x)
    );
    float depthTolerance = max(
      3.0 / 16777215.0,
      min(currentDepthGradient * 1.75, 0.0015)
    );
    if (abs(previousDepth - expectedPreviousDepth) > depthTolerance ||
        abs(previousSurface.a - currentWaterTag) > 0.25) {
      gl_FragColor = current;
      return;
    }

    vec4 neighborhoodMinimum = current;
    vec4 neighborhoodMaximum = current;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 offset = vec2(float(x), float(y)) * effectsTexel;
        vec4 sampleValue = texture2D(currentEffectsMap, vUv + offset);
        neighborhoodMinimum = min(neighborhoodMinimum, sampleValue);
        neighborhoodMaximum = max(neighborhoodMaximum, sampleValue);
      }
    }
    vec4 history = texture2D(historyMap, previousUv);
    history = clamp(history, neighborhoodMinimum, neighborhoodMaximum);
    float waterMask = 1.0 - smoothstep(
      0.02,
      0.45,
      texture2D(beautyMap, vUv).a
    );
    // Animated reflection RGB receives much less history than static terrain
    // AO. The neighborhood clamp remains active for both paths.
    float resolvedHistoryWeight = mix(
      historyWeight,
      min(historyWeight, waterHistoryWeight),
      waterMask
    );
    gl_FragColor = mix(current, history, clamp(resolvedHistoryWeight, 0.0, 0.96));
  }
`;

/**
 * Previous-frame surface identity for temporal rejection. RGB stores raw depth
 * at 24-bit precision and alpha stores the exact water-material tag. Nearest
 * filtering is required because interpolating packed depth corrupts it.
 */
export const HYBRID_SURFACE_HISTORY_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D depthMap;
  uniform sampler2D beautyMap;

  vec3 packDepth24(float depth) {
    vec3 packed = fract(
      min(depth, 1.0 - 1.0 / 16777216.0) * vec3(1.0, 255.0, 65025.0)
    );
    packed -= packed.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
    return packed;
  }

  void main() {
    float depth = texture2D(depthMap, vUv).x;
    float waterTag = 1.0 - smoothstep(
      0.02,
      0.45,
      texture2D(beautyMap, vUv).a
    );
    gl_FragColor = vec4(packDepth24(depth), waterTag);
  }
`;

export const HYBRID_COMPOSITE_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D beautyMap;
  uniform sampler2D depthMap;
  uniform sampler2D effectsMap;
  uniform vec2 beautyTexel;
  uniform vec2 effectsTexel;
  uniform mat4 inverseProjectionMatrix;
  uniform mat4 cameraWorldMatrix;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float waterLevel;
  uniform float waterTime;
  uniform vec2 waterWorldOrigin;
  uniform sampler2D waterSurfaceDetailMap;
  uniform float waterDetailStrength;
  uniform float shorelineStrength;
  uniform sampler2D waterBathymetryMap;
  uniform vec4 waterBathymetryBounds;
  uniform float waterBathymetryMaxDepth;
  uniform float waterBathymetryTexel;
  uniform float waterBathymetryValid;
  uniform float ssrStrength;

  const float HYBRID_SKY_DEPTH = 0.9999999;

  ${HYBRID_WATER_SPECTRUM_GLSL}

  float depthAt(vec2 uv) {
    return texture2D(depthMap, clamp(uv, vec2(0.0), vec2(1.0))).x;
  }

  vec3 reconstructViewPosition(vec2 uv, float depth) {
    vec4 clipPosition = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPosition = inverseProjectionMatrix * clipPosition;
    return viewPosition.xyz / max(abs(viewPosition.w), 1e-7);
  }

  vec3 worldPositionFromView(vec3 viewPosition) {
    vec3 worldPosition = (cameraWorldMatrix * vec4(viewPosition, 1.0)).xyz;
    worldPosition.xz += waterWorldOrigin;
    return worldPosition;
  }

  ${HYBRID_ANALYTIC_WATER_POSITION_GLSL}

  float waterMaterialMaskAt(vec2 uv) {
    float materialTag = texture2D(
      beautyMap,
      clamp(uv, vec2(0.0), vec2(1.0))
    ).a;
    return 1.0 - smoothstep(0.02, 0.45, materialTag);
  }

  float viewDistanceAt(vec2 uv) {
    float depth = depthAt(uv);
    float waterMask = waterMaterialMaskAt(uv);
    if (depth >= HYBRID_SKY_DEPTH && waterMask < 0.001) return 1e9;
    vec3 viewPosition = waterMask > 0.001
      ? analyticWaterViewPosition(uv, depth)
      : reconstructViewPosition(uv, depth);
    return -viewPosition.z;
  }

  vec4 bilateralEffects(vec2 uv, float centerDistance) {
    vec4 total = texture2D(effectsMap, uv);
    float totalWeight = 1.0;
    vec2 offsets[4];
    offsets[0] = vec2(effectsTexel.x, 0.0);
    offsets[1] = vec2(-effectsTexel.x, 0.0);
    offsets[2] = vec2(0.0, effectsTexel.y);
    offsets[3] = vec2(0.0, -effectsTexel.y);
    for (int index = 0; index < 4; index++) {
      vec2 sampleUv = clamp(uv + offsets[index], vec2(0.0), vec2(1.0));
      float sampleDistance = viewDistanceAt(sampleUv);
      float threshold = max(0.35, centerDistance * 0.0015);
      float weight = exp(-abs(sampleDistance - centerDistance) / threshold);
      total += texture2D(effectsMap, sampleUv) * weight;
      totalWeight += weight;
    }
    return total / totalWeight;
  }

  float shorelineProximity(vec2 uv, float centerDistance) {
    // The opaque forward ocean has no seafloor depth. Four conservative nearby
    // classifications provide a stable screen-space proxy only at real water /
    // terrain boundaries; open water remains untouched.
    float radiusPixels = clamp(2.5 + centerDistance * 0.0018, 2.5, 9.0);
    vec2 horizontal = vec2(beautyTexel.x * radiusPixels, 0.0);
    vec2 vertical = vec2(0.0, beautyTexel.y * radiusPixels);
    float surroundingWater = (
      waterMaterialMaskAt(uv + horizontal) +
      waterMaterialMaskAt(uv - horizontal) +
      waterMaterialMaskAt(uv + vertical) +
      waterMaterialMaskAt(uv - vertical)
    ) * 0.25;
    return smoothstep(0.03, 0.72, 1.0 - surroundingWater);
  }

  vec2 sampleWaterBathymetry(vec2 worldPosition) {
    vec2 extent = max(
      waterBathymetryBounds.zw - waterBathymetryBounds.xy,
      vec2(1.0)
    );
    vec2 uv = (worldPosition - waterBathymetryBounds.xy) / extent;
    float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    float coverage = waterBathymetryValid * smoothstep(
      0.0,
      waterBathymetryTexel * 2.0,
      edge
    );
    float encodedDepth = texture2D(
      waterBathymetryMap,
      clamp(
        uv,
        vec2(waterBathymetryTexel * 0.5),
        vec2(1.0 - waterBathymetryTexel * 0.5)
      )
    ).r;
    return vec2(encodedDepth * waterBathymetryMaxDepth, coverage);
  }

  void main() {
    float rawDepth = depthAt(vUv);
    vec4 beautySample = texture2D(beautyMap, vUv);
    vec3 beauty = beautySample.rgb;
    float waterMask = 1.0 - smoothstep(0.02, 0.45, beautySample.a);
    if (rawDepth >= HYBRID_SKY_DEPTH && waterMask < 0.001) {
      gl_FragColor = vec4(max(beauty, vec3(0.0)), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    vec3 viewPosition = waterMask > 0.001
      ? analyticWaterViewPosition(vUv, rawDepth)
      : reconstructViewPosition(vUv, rawDepth);
    float centerDistance = max(-viewPosition.z, cameraNear);

    if (waterMask > 0.001 && waterDetailStrength > 0.0) {
      vec3 worldPosition = worldPositionFromView(viewPosition);
      float pixelFootprint = max(
        length(dFdx(worldPosition.xz)),
        length(dFdy(worldPosition.xz))
      );
      vec4 waterSurface = hybridWaterSurfaceField(
        worldPosition.xz,
        waterTime,
        pixelFootprint
      );
      vec2 waterSlope = waterSurface.xy * waterDetailStrength;
      float waterSurfaceTone = waterSurface.z;
      float waterRippleEnergy = waterSurface.w * waterDetailStrength;
      vec3 waterNormalWorld = normalize(vec3(-waterSlope.x, 1.0, -waterSlope.y));
      vec3 cameraWorldPosition = cameraWorldMatrix[3].xyz;
      cameraWorldPosition.xz += waterWorldOrigin;
      vec3 viewToCamera = normalize(cameraWorldPosition - worldPosition);
      float cosTheta = clamp(dot(viewToCamera, waterNormalWorld), 0.0, 1.0);
      float waterFresnel = 0.0204 + 0.9796 * pow(1.0 - cosTheta, 5.0);

      float screenShore = shorelineProximity(vUv, centerDistance);
      vec2 bathymetry = sampleWaterBathymetry(worldPosition.xz);
      float trueShallowWater = 1.0 - smoothstep(1.5, 34.0, bathymetry.x);
      float shoreSignal = max(
        screenShore * (1.0 - bathymetry.y * 0.82),
        trueShallowWater * bathymetry.y
      );
      float shore = shoreSignal * shorelineStrength;
      float nearDetailFade = 1.0 - smoothstep(2600.0, 9000.0, centerDistance);
      vec2 distortionUv = waterSlope * beautyTexel *
        (58.0 * nearDetailFade) * (1.0 - shore * 0.82);
      vec2 candidateUv = clamp(vUv + distortionUv, vec2(0.001), vec2(0.999));
      float candidateWater = waterMaterialMaskAt(candidateUv);
      vec2 waterUv = mix(vUv, candidateUv, candidateWater * waterMask);
      float sampledDistance = viewDistanceAt(waterUv);
      vec4 effects = bilateralEffects(waterUv, sampledDistance);
      // SSAO is explicitly disabled again after bilateral reconstruction so
      // neighboring land cannot leak dark AO into a shoreline water pixel.
      float visibility = mix(effects.a, 1.0, waterMask);
      float ssrFresnelWeight = mix(0.08, 0.72, sqrt(waterFresnel));
      float ssrAmount = waterMask * ssrStrength * ssrFresnelWeight *
        nearDetailFade * (1.0 - shore * 0.38) *
        (1.0 - waterRippleEnergy * 0.28);
      vec3 reflected = mix(
        texture2D(beautyMap, waterUv).rgb,
        effects.rgb,
        ssrAmount
      );

      // Actual terrain depth drives absorption wherever the camera-following
      // bathymetry field is valid. The screen edge proxy is retained only as a
      // smoothly faded fallback beyond the bounded field.
      float fallbackDepth = mix(28.0, 1.8, screenShore);
      float apparentDepth = mix(fallbackDepth, bathymetry.x, bathymetry.y);
      vec3 transmittance = exp(
        -vec3(0.16, 0.075, 0.045) * max(apparentDepth, 0.0)
      );
      vec3 shallowScatter = mix(
        vec3(0.065, 0.102, 0.064),
        vec3(0.16, 0.175, 0.105),
        waterSurfaceTone
      );
      vec3 deepScatter = vec3(0.0045, 0.034, 0.052);
      vec3 waterBody = mix(deepScatter, shallowScatter, transmittance);
      vec2 warp = hybridWaterDomainWarp(worldPosition.xz, waterTime);
      float broadVariation = (waterSurfaceTone - 0.5) * 1.36 +
        warp.x * 0.09 + warp.y * 0.07;
      waterBody *= 0.94 + broadVariation * 0.08;
      float farVariation = smoothstep(1300.0, 7600.0, centerDistance);
      waterBody = mix(waterBody, vec3(0.018, 0.056, 0.073), farVariation * 0.12);
      float bodyAmount = (1.0 - waterFresnel) *
        mix(0.17, 0.42, shore) * waterDetailStrength * waterMask;
      vec3 color = mix(reflected * visibility, waterBody, bodyAmount);

      // Use the same crossed, domain-warped spectrum for the shallow sparkle.
      // The old standalone sine stamped long diagonal "ray" lines across the
      // shore and remained visible even when SSR had no valid hit.
      float shoreVariation = clamp(
        0.5 + broadVariation * 0.28 + waterRippleEnergy * 0.16,
        0.0,
        1.0
      );
      float shoreGlint = shore * shoreVariation *
        0.035 * nearDetailFade * waterMask;
      color = mix(color, shallowScatter * 1.08, shoreGlint);
      gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    } else {
      vec4 effects = bilateralEffects(vUv, centerDistance);
      vec3 color = beauty * effects.a;
      gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    }
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
