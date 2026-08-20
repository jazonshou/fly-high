import type { AirportDefinition } from "@/src/world/types";
import { SurfaceMaterial } from "./surfaceMaterials";

/**
 * 3-9 — the runway surface (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: the runway is PAINTED into the terrain surface by
 * the analytic airport SDF, evaluated in the fragment shader. It is not a
 * mesh, not a splat weight and not a decal.
 *
 * That choice is what decouples the item from Phase 4 and lets it ship here:
 * splat weights would need `4-6`'s classifier and `4-2`'s page atlas, while an
 * SDF needs nothing but the airport definition the world already carries. It
 * is also what deletes the z-fighting: the 0.16 m runway box at y = 0.08, the
 * ~9 centreline stripes and ~18 threshold stripes floating at y = 0.175, and
 * the apron slab were 28 coplanar boxes fighting each other and the ground.
 * There is now nothing to fight — the markings are the ground.
 *
 * The SDF is a TRANSLITERATION of `roundedRectangleSignedDistance`
 * (`src/world/airport.ts`), not a second implementation, held to it by
 * assertion 65 — the same discipline `1C-4` used for the aerial-perspective
 * mirror, and the same defence against the drift that gave the ocean and the
 * hydrology two different sun discs.
 *
 * KNOWN INTERIM: the physics runway classifier and the painted pavement edge
 * do not agree to the metre. `isPointOnRunway` (`src/world/airport.ts`) tests
 * the clean rectangle, and that rectangle is what gives the tyres their 1.18
 * friction; the ragged edge below displaces the *painted* boundary by up to
 * `raggedAmplitudeMeters × 1.5` either way. So a wheel can be on visible
 * asphalt with grass friction, or on visible grass with asphalt friction, in a
 * band of about 2 m at the edge of a 34 m runway. Closing it would mean
 * evaluating this noise field in the collision hot path for a band no landing
 * should be in; the §1.3 contract binds the surface HEIGHT, which both
 * authorities do agree on. Recorded rather than fixed.
 *
 * DEVIATION: the apron slab is deleted and NOT replaced. The plan lists it
 * among the deletions and does not ask for a successor, and painting concrete
 * there would be wrong: the apron sat 115 m across from the centreline, 84 m
 * outside the graded platform, on natural terrain that slopes. The hangars
 * stay (`RENDERING_PLAN.md` §1.5 — they are the only scale reference on final
 * approach) and Phase 7 `7-10` replaces them properly, apron included.
 */

/** Runway marking geometry, in metres. ICAO-ish rather than art-directed. */
export const runwayMarkingProfile = Object.freeze({
  /** Centreline: 30 m painted, 20 m gap. */
  centrelineStripeMeters: 30,
  centrelineGapMeters: 20,
  centrelineWidthMeters: 0.9,
  /** Threshold bars: nine longitudinal bars inset from each end. */
  thresholdBarCount: 9,
  thresholdBarWidthMeters: 1.8,
  thresholdBarLengthMeters: 30,
  thresholdBarPitchMeters: 3.6,
  thresholdInsetMeters: 48,
  /** Touchdown zone: where the tyres actually land, and the rubber with them. */
  touchdownFromThresholdMeters: 300,
  touchdownHalfLengthMeters: 110,
  touchdownHalfWidthMeters: 9,
  /** Main-gear wheel paths, where the aggregate polishes through. */
  wheelPathOffsetMeters: 4,
  wheelPathHalfWidthMeters: 1.3,
  /** Amplitude and wavelength of the ragged, grass-invaded pavement edge. */
  raggedAmplitudeMeters: 1.35,
  raggedWavelengthMeters: 7.5,
});

export interface RunwaySurfaceBinding {
  /** (centerX, centerZ, sin(heading), cos(heading)). */
  readonly frame: readonly [number, number, number, number];
  /** (halfPavedLength, halfPavedWidth, touchdownAlong, raggedAmplitude). */
  readonly shape: readonly [number, number, number, number];
}

export function resolveRunwaySurfaceBinding(
  airport: Readonly<AirportDefinition>,
): RunwaySurfaceBinding {
  const halfLength = airport.runwayLength * 0.5;
  return {
    frame: [
      airport.centerX,
      airport.centerZ,
      Math.sin(airport.headingRadians),
      Math.cos(airport.headingRadians),
    ],
    shape: [
      halfLength,
      airport.runwayWidth * 0.5,
      Math.max(0, halfLength - runwayMarkingProfile.touchdownFromThresholdMeters),
      runwayMarkingProfile.raggedAmplitudeMeters,
    ],
  };
}

export const RUNWAY_SURFACE_UNIFORMS: readonly {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}[] = Object.freeze([
  { name: "terrainRunwayFrame", size: 4, type: "vec4" },
  { name: "terrainRunwayShape", size: 4, type: "vec4" },
]);

/**
 * The SDF half, isolated so assertion 65 can compile it into a bare compute
 * shader and compare it against the TypeScript, point for point.
 *
 * `0-4` portability: no `pow`, no branch on float equality, no reliance on
 * f64 — `max`, `min`, `abs` and one `length`, all of which f32 reproduces.
 */
export const RUNWAY_SDF_WGSL = /* wgsl */ `
// Transliteration of roundedRectangleSignedDistance (src/world/airport.ts).
fn terrainRunwayRoundedRect(
  along: f32,
  across: f32,
  halfLength: f32,
  halfWidth: f32,
) -> f32 {
  let qAlong = abs(along) - halfLength;
  let qAcross = abs(across) - halfWidth;
  let outside = length(vec2f(max(qAlong, 0.0), max(qAcross, 0.0)));
  return outside + min(max(qAlong, qAcross), 0.0);
}

// Transliteration of worldToRunway (src/world/airport.ts).
fn terrainRunwayLocal(worldXz: vec2f, center: vec2f, sinHeading: f32, cosHeading: f32) -> vec2f {
  let delta = worldXz - center;
  return vec2f(
    delta.x * sinHeading + delta.y * cosHeading,
    delta.x * cosHeading - delta.y * sinHeading,
  );
}
`;

/**
 * The painting half. Consumes `terrainSurfaceSample` and the helpers
 * `TerrainSurfacePlugin` defines, so it is emitted after them.
 *
 * Every mask is antialiased against the derivative footprint rather than
 * against a fixed width: paint is the highest-contrast, thinnest feature in
 * the frame and a fixed-width edge shimmers into a dotted line on approach —
 * the same failure the terrain's own micro-detail gate had, one scale down.
 */
export const RUNWAY_SURFACE_WGSL = /* wgsl */ `${RUNWAY_SDF_WGSL}
// Antialiased "inside" test: 1 well inside, 0 well outside, one footprint of
// transition either side.
//
// The width must be the footprint MEASURED ALONG THE EDGE'S OWN NORMAL, not
// the isotropic max of the world footprint. Terrain is seen at grazing angles
// almost all the time, so a runway viewed down its length has a footprint tens
// of metres long and centimetres wide; feeding the long axis to a 0.9 m
// centreline's mask dissolves it into a grey smear at exactly the range you
// are looking at it from. The caller projects the world derivatives onto the
// runway's along and across axes and passes the relevant one.
fn terrainRunwayMask(distance: f32, width: f32) -> f32 {
  let w = max(width, 0.02);
  return 1.0 - smoothstep(-w, w, distance);
}

fn terrainRunwaySurface(
  position: vec3f,
  geometricNormal: vec3f,
  worldDdx: vec3f,
  worldDdy: vec3f,
  detailWeight: f32,
  albedo: ptr<function, vec3f>,
  normal: ptr<function, vec3f>,
  roughness: ptr<function, f32>,
  cavity: ptr<function, f32>,
  f0: ptr<function, f32>,
  diffuseRoughness: ptr<function, f32>,
) {
  let frame = uniforms.terrainRunwayFrame;
  let shape = uniforms.terrainRunwayShape;
  let halfLength = shape.x;
  let halfWidth = shape.y;
  if (halfLength <= 0.0) {
    return;
  }
  let local = terrainRunwayLocal(position.xz, frame.xy, frame.z, frame.w);
  let along = local.x;
  let across = local.y;
  let footprint = max(length(worldDdx.xz), length(worldDdy.xz));
  // The along and across axes are unit gradients of the runway-local
  // coordinates, so projecting the world derivatives onto them gives the
  // per-axis footprint each mask actually needs.
  let alongAxis = vec2f(frame.z, frame.w);
  let acrossAxis = vec2f(frame.w, -frame.z);
  let alongWidth = max(abs(dot(worldDdx.xz, alongAxis)), abs(dot(worldDdy.xz, alongAxis)));
  let acrossWidth = max(abs(dot(worldDdx.xz, acrossAxis)), abs(dot(worldDdy.xz, acrossAxis)));

  // Cheap reject: everything past the pavement plus its ragged margin is
  // ordinary ground, which is most of the frame most of the time.
  let coarse = terrainRunwayRoundedRect(along, across, halfLength, halfWidth);
  if (coarse > ${(runwayMarkingProfile.raggedAmplitudeMeters * 2).toFixed(2)} + footprint * 2.0) {
    return;
  }

  // The ragged, grass-invaded edge: the SDF perturbed by a two-scale noise
  // field along the pavement boundary. A clean rectangle is the giveaway that
  // a runway was pasted on rather than laid.
  let raggedScale = ${(1 / runwayMarkingProfile.raggedWavelengthMeters).toFixed(6)};
  let ragged = (terrainSurfaceValue(vec2f(along, across) * raggedScale) - 0.5) * 2.0
    + (terrainSurfaceValue(vec2f(across, along) * raggedScale * 3.7) - 0.5);
  let pavementDistance = coarse + ragged * shape.w;
  // The pavement edge runs mostly along the runway, so its normal is across.
  let paved = terrainRunwayMask(pavementDistance, max(acrossWidth, footprint * 0.15));
  if (paved <= 0.002) {
    return;
  }

  // The GEOMETRIC normal, not the blended one already in *normal: passing the
  // perturbed normal back in would apply the ground's detail normal twice and
  // would give the projection a tangent frame that is not the surface's.
  let asphalt = terrainSurfaceSample(
    ${SurfaceMaterial.Asphalt}, position, geometricNormal, worldDdx, worldDdy, detailWeight);
  let concrete = terrainSurfaceSample(
    ${SurfaceMaterial.Concrete}, position, geometricNormal, worldDdx, worldDdy, detailWeight);

  // Wheel paths polish the bitumen off and expose the aggregate: lighter,
  // matter, and only where tyres actually run.
  let wheelOffset = ${runwayMarkingProfile.wheelPathOffsetMeters.toFixed(1)};
  let wheelHalf = ${runwayMarkingProfile.wheelPathHalfWidthMeters.toFixed(2)};
  let wheelDistance = abs(abs(across) - wheelOffset) - wheelHalf;
  let wheelPath = terrainRunwayMask(wheelDistance, max(acrossWidth, 0.4))
    * (1.0 - smoothstep(halfLength * 0.92, halfLength, abs(along)));
  var surfaceAlbedoValue = mix(asphalt.albedo, concrete.albedo * 0.62, wheelPath * 0.45);
  var surfaceRoughness = mix(asphalt.roughness, asphalt.roughness + 0.12, wheelPath);
  var surfaceCavity = asphalt.cavity;
  var surfaceNormal = asphalt.normal;

  // Rubber: two lobes at the touchdown zones, darkest on the centreline third
  // and fading along the rollout. This is the single most recognisable mark on
  // any runway photograph.
  let touchdownAlong = shape.z;
  let lobeAlong = abs(abs(along) - touchdownAlong)
    / ${runwayMarkingProfile.touchdownHalfLengthMeters.toFixed(1)};
  let lobeAcross = abs(across) / ${runwayMarkingProfile.touchdownHalfWidthMeters.toFixed(1)};
  let lobe = max(0.0, 1.0 - lobeAlong * lobeAlong - lobeAcross * lobeAcross * 0.55);
  let rubberNoise = terrainSurfaceValue(vec2f(along, across) * 0.35);
  let rubber = clamp(lobe * (0.55 + rubberNoise * 0.9), 0.0, 1.0);
  surfaceAlbedoValue = mix(surfaceAlbedoValue, vec3f(0.016, 0.015, 0.015), rubber * 0.8);
  surfaceRoughness = mix(surfaceRoughness, 0.42, rubber * 0.7);

  // Markings. Wear is a smooth field so a stripe fades along its length rather
  // than switching, and the paint's own roughness is glossier than asphalt.
  let wear = terrainSurfaceValue(vec2f(along * 0.06, across * 0.22));
  let paintWear = clamp(0.35 + wear * 0.8 - rubber * 0.75, 0.0, 1.0);

  let stripePeriod = ${(runwayMarkingProfile.centrelineStripeMeters
    + runwayMarkingProfile.centrelineGapMeters).toFixed(1)};
  let stripePhase = abs(along - floor(along / stripePeriod + 0.5) * stripePeriod);
  let centrelineDistance = max(
    stripePhase - ${(runwayMarkingProfile.centrelineStripeMeters * 0.5).toFixed(1)},
    abs(across) - ${(runwayMarkingProfile.centrelineWidthMeters * 0.5).toFixed(2)},
  );
  // The centreline stops short of both thresholds, as it does in reality.
  // A centreline stripe is bounded across by 0.45 m and along by 15 m, so the
  // across footprint is what can dissolve it.
  let centreline = terrainRunwayMask(centrelineDistance, max(acrossWidth, 0.05))
    * (1.0 - smoothstep(halfLength - 90.0, halfLength - 60.0, abs(along)));

  let barPitch = ${runwayMarkingProfile.thresholdBarPitchMeters.toFixed(1)};
  let barPhase = abs(across - floor(across / barPitch + 0.5) * barPitch);
  let thresholdCentre = halfLength - ${runwayMarkingProfile.thresholdInsetMeters.toFixed(1)};
  let thresholdDistance = max(
    max(
      barPhase - ${(runwayMarkingProfile.thresholdBarWidthMeters * 0.5).toFixed(2)},
      abs(abs(along) - thresholdCentre)
        - ${(runwayMarkingProfile.thresholdBarLengthMeters * 0.5).toFixed(1)},
    ),
    abs(across) - ${((runwayMarkingProfile.thresholdBarCount * runwayMarkingProfile.thresholdBarPitchMeters) * 0.5).toFixed(2)},
  );
  // Threshold bars are the other way round: 0.9 m across, 15 m along, and
  // packed 3.6 m apart across — the across axis again bounds the fine detail.
  let threshold = terrainRunwayMask(thresholdDistance, max(min(acrossWidth, alongWidth), 0.05));

  let paint = clamp(max(centreline, threshold) * paintWear, 0.0, 1.0);
  // Worn, weathered paint — never a clean white, and greyer where the rubber
  // has been laid over it.
  let paintColour = mix(vec3f(0.34, 0.335, 0.315), vec3f(0.62, 0.615, 0.585), paintWear);
  surfaceAlbedoValue = mix(surfaceAlbedoValue, paintColour, paint);
  surfaceRoughness = mix(surfaceRoughness, 0.46, paint * 0.85);
  surfaceCavity = mix(surfaceCavity, 1.0, paint * 0.5);

  *albedo = mix(*albedo, surfaceAlbedoValue, paved);
  *normal = normalize(mix(*normal, surfaceNormal, paved));
  *roughness = mix(*roughness, surfaceRoughness, paved);
  *cavity = mix(*cavity, surfaceCavity, paved);
  *f0 = mix(*f0, mix(asphalt.f0, concrete.f0, paint), paved);
  *diffuseRoughness = mix(*diffuseRoughness, asphalt.diffuseRoughness, paved);
}
`;
