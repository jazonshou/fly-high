import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AircraftKind } from "@/src/sim";
import type { resolveAircraftAnimationPose } from "./animation";
import { AircraftBuildContext } from "./builders";
import { AIRCRAFT_EXTERIOR_LAYER_MASK, aircraftCameraLayerMask } from "./types";

/**
 * The parts every airframe in the game has, and the scaffolding that drives
 * them.
 *
 * Split out of `createAircraft.ts` when a third aeroplane arrived: one file
 * holding every builder meant two people reshaping two aeroplanes could not
 * work at once, and the shared contract was hard to see among 1,200 lines of
 * geometry. The per-airframe modules own their own shapes; this owns what they
 * must all agree on.
 */
export interface CommonRig {
  readonly root: TransformNode;
  readonly propeller: TransformNode;
  readonly cockpitParts: readonly AbstractMesh[];
  /**
   * Meshes that exist ONLY for the cockpit camera: `isVisible` is false until
   * cockpit view is entered, true for exactly as long as it lasts, and false
   * again on exit (`setCockpitVisibility`). Optional: an airframe whose
   * cockpit is built into its ordinary parts has none.
   *
   * Visibility alone is enough, with no layer bit, because nothing draws an
   * aircraft mesh except the flight camera (one `scene.render`) and the
   * cascaded shadow generator, whose casters are the explicit list
   * `FlightRenderer` builds from meshes that do not say `castsShadow: false`
   * — which `configureCockpitOnlyParts` makes every one of these say. The sky
   * probe renders only the sky dome, the cloud depth target only the terrain,
   * and the planar water capture is retired.
   */
  readonly cockpitOnlyParts?: readonly AbstractMesh[];
  readonly wingSurfaces: readonly AbstractMesh[];
  /** Starboard first. Empty on an airframe whose ailerons ARE its flaps. */
  readonly ailerons: readonly TransformNode[];
  /**
   * Surfaces that are flap and aileron at once, starboard first.
   *
   * The F-16 has one of these a side and no separate ailerons, which is the
   * aeroplane: a flaperon droops with the flap selection and differentiates
   * with the stick, both at the same time. Modelling it as two panels left a
   * standing 196 mm hole between them that daylight came through at rest.
   *
   * They are a list of their OWN rather than a node appearing in both `flaps`
   * and `ailerons`, because with one node in two lists the second write simply
   * overwrites the first and the surface silently does only half its job.
   */
  readonly flaperons: readonly TransformNode[];
  /**
   * Elevator halves, each on its OWN hinge node.
   *
   * One node for both halves cannot be right on a swept tailplane: the two
   * hinge lines are mirror images, and a single axis matches at most one of
   * them. Measured with one node, the Global's elevator turned 17.2 degrees
   * off its own hinge line and the 747's 11.5. Airframes with an unswept or
   * all-moving tail supply a single-element array.
   */
  readonly elevators: readonly TransformNode[];
  readonly rudder: TransformNode;
  readonly noseSteer: TransformNode;
  /** Every flap panel, hinged so a positive rotation.z drops its trailing edge. */
  readonly flaps: readonly TransformNode[];
  readonly mainWheels: readonly TransformNode[];
  readonly noseWheel: TransformNode;
}


export function node(name: string, parent: TransformNode, scene: Scene): TransformNode {
  const result = new TransformNode(name, scene);
  result.parent = parent;
  return result;
}

/**
 * Point a control surface's hinge node along the line it actually hinges about.
 *
 * `applyCommonPose` deflects a surface by writing `rotation.z`, and Babylon
 * composes a node's Euler angles ROLL FIRST, then pitch, then yaw. So
 * `rotation.z` turns the surface in the node's OWN frame, before the node's
 * orientation is applied — which means orienting the node is enough to make
 * `rotation.z` a rotation about any axis we like, with no per-frame work and
 * no change to the shared contract.
 *
 * It is worth being exact about why this is needed, because the defect is
 * invisible in a file that looks correct. A hinge node is sited at its panel's
 * INBOARD end, and on a swept wing the panel's outboard end is then metres AFT
 * of the node's z axis. Rotating about that axis instead of the hinge line
 * swings the outboard end down by `reach * sin(deflection)` more than the
 * root. Measured on the Global before this existed: at full flap the inner
 * flap dropped 0.634 m at the root and 1.471 m at the break, and its outboard
 * end moved 64 mm FORWARD while its root moved 163 mm aft. A rigid panel
 * wrung out along its span, and from the chase camera the trailing edge tore
 * open far enough to see terrain through the wing.
 *
 * Since `Rz` leaves `+z` fixed, the orientation that puts local `+z` on a unit
 * direction is a closed-form Euler PAIR, and it subsumes any pitch the node
 * already carries: `pitch = -asin(dy)`, `yaw = atan2(dx, dz)`. The 747's flap
 * hinges arrive already rolled to the local dihedral and come out unchanged,
 * because a hinge line lying in the wing plane has exactly that `dy`.
 *
 * REST POSE IS PRESERVED by an inserted frame, not by moving geometry. The
 * node's existing children are reparented to a child node carrying
 * `R(old) R(new)^-1`, so at zero deflection the two cancel and every vertex is
 * exactly where the airframe's own file put it. Baking the inverse into vertex
 * positions would work too, but it would have to run AFTER each airframe's
 * section conform and before anything else read the mesh, which is a sequencing
 * rule that cannot be enforced from here.
 *
 * The axis is normalised to point OUTBOARD (+z) on both wings. A hinge line
 * runs in two directions and the port wing's is the mirror of the starboard's;
 * taking it as given would deflect one wing's surfaces the wrong way, which is
 * the bug `render.webgpu-control-surface-sides` exists to catch.
 *
 * `direction` is the hinge line in the node's OWN frame — the frame its panel
 * was specified in — and is carried through any rotation the node already
 * holds. That is not a convenience: the 747's inboard aileron straddles the
 * wing kink, where `chordPlaneAt` bends, so a direction assembled from wing
 * stations was 2 degrees out where the panel's own geometry is exact.
 *
 * Call it AFTER the panel's geometry is parented to the hinge. Returns the
 * inserted frame, for anything built later that belongs in the same place.
 */
export function hingeAlong(
  hinge: TransformNode,
  direction: Vector3,
  scene: Scene,
): TransformNode {
  const existingRotation = Matrix.RotationYawPitchRoll(
    hinge.rotation.y,
    hinge.rotation.x,
    hinge.rotation.z,
  );
  const along = Vector3.TransformNormal(direction, existingRotation).normalize();
  if (along.z < 0) along.scaleInPlace(-1);
  const pitch = -Math.asin(Math.min(1, Math.max(-1, along.y)));
  const yaw = Math.atan2(along.x, along.z);

  // A quaternion on the hinge would make Babylon ignore `rotation` entirely,
  // and the deflection would silently stop. This owns the node's orientation,
  // so it owns clearing that too.
  hinge.rotationQuaternion = null;
  const existing = existingRotation;
  const oriented = Matrix.RotationYawPitchRoll(yaw, pitch, 0);

  const children = hinge.getChildren();
  const frame = new TransformNode(`${hinge.name}-frame`, scene);
  for (const child of children) child.parent = frame;
  frame.parent = hinge;
  frame.rotationQuaternion = Quaternion.FromRotationMatrix(
    existing.multiply(Matrix.Transpose(oriented)),
  );

  hinge.rotation.set(pitch, yaw, hinge.rotation.z);
  return frame;
}

/**
 * The same repair for a hinge the pose drives in YAW — which is every rudder.
 *
 * It needs a different mechanism, and the reason is the mirror of why
 * `hingeAlong` works. `rotation.y` is the OUTERMOST of Babylon's Euler
 * rotations, applied last and therefore in the PARENT's frame, so no
 * orientation placed on the rudder's own node can change the axis it turns
 * about. A rudder on a raked fin hinge would keep swinging about true
 * vertical whatever was written to its own pitch and roll.
 *
 * So the rake goes on an inserted PARENT and is cancelled on an inserted
 * child: `mount` (rake) -> the rudder node (yaw, written by
 * `applyCommonPose`) -> `frame` (rake inverted) -> the geometry the airframe
 * built. At zero deflection the two cancel exactly, and a yaw of `d` becomes
 * a rotation of `d` about the raked line.
 *
 * The rudder node keeps its own name and its place in `CommonRig`, because
 * `render.webgpu-control-surface-sides` and the pose both find it that way.
 * Only its position moves — on to the mount, so the rake turns about the
 * hinge point rather than about the airframe origin.
 *
 * Not every fin needs this. The Cessna's and the F-16's rudders are plain
 * vertical boxes on a vertical axis, which is already consistent; it is the
 * Global's swept fin and the 747's, whose trailing edge leans 4.8 m aft over
 * 9.9 m of height, that were turning a raked panel about a vertical line.
 */
export function yawHingeAlong(
  rudder: TransformNode,
  direction: Vector3,
  scene: Scene,
  preserveRestPose = true,
): TransformNode {
  const along = direction.clone().normalize();
  if (along.y < 0) along.scaleInPlace(-1);
  const rake = Quaternion.FromUnitVectorsToRef(
    Vector3.Up(),
    along,
    new Quaternion(),
  );

  // `preserveRestPose` is false where the panel is authored UPRIGHT and wants
  // the mount to supply its lean. Both box rudders were authored the other
  // way — tilted on to the hinge line to fake a swept panel, because the hinge
  // was vertical and a box cannot be swept. That tilt is applied about the
  // box's OWN centre, which swings its leading edge 1.85 m off the hinge point
  // on the 747, and with a raked axis the trailing edge then sits 0.64 m from
  // the line it turns about and swings the WRONG WAY. Authoring the panel
  // upright and raking the mount puts the leading edge back on the hinge.
  if (preserveRestPose) {
    const children = rudder.getChildren();
    const frame = new TransformNode(`${rudder.name}-frame`, scene);
    for (const child of children) child.parent = frame;
    frame.parent = rudder;
    frame.rotationQuaternion = rake.conjugate();
  }

  const mount = new TransformNode(`${rudder.name}-mount`, scene);
  mount.parent = rudder.parent;
  mount.position.copyFrom(rudder.position);
  mount.rotationQuaternion = rake;
  rudder.parent = mount;
  rudder.position.setAll(0);
  rudder.rotationQuaternion = null;
  return mount;
}

export function assertRightHandedScene(scene: Scene): void {
  if (!scene.useRightHandedSystem) {
    throw new Error(
      "WebGPU aircraft require scene.useRightHandedSystem = true before construction.",
    );
  }
}

export function configureRoot(root: TransformNode, kind: AircraftKind): void {
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = {
    aircraftVisual: true,
    aircraftKind: kind,
    handedness: "right",
    bodyAxes: { forward: "+x", up: "+y", starboard: "+z" },
  };
}

export function addInstrumentPanel(
  build: AircraftBuildContext,
  prefix: string,
  root: TransformNode,
  x: number,
  y: number,
  depth: number,
  panelMaterial: PBRMaterial,
  faceMaterial: PBRMaterial,
  markingMaterial: PBRMaterial,
): readonly AbstractMesh[] {
  const meshes: AbstractMesh[] = [];
  const panel = build.box(
    `${prefix}-instrument-panel`,
    0.1,
    0.54,
    depth,
    panelMaterial,
    root,
  );
  panel.position.set(x, y, 0);
  panel.rotation.z = -0.12;
  panel.metadata = { ...panel.metadata, cockpitInterior: true };
  meshes.push(panel);

  const gauges = [
    { name: "airspeed", y: 0.09, z: 0.22 },
    { name: "attitude", y: 0.09, z: -0.02 },
    { name: "altimeter", y: 0.09, z: -0.26 },
    { name: "engine", y: -0.13, z: 0.12 },
    { name: "vertical-speed", y: -0.13, z: -0.14 },
  ] as const;
  for (const [index, gauge] of gauges.entries()) {
    const face = build.cylinder(
      `${prefix}-${gauge.name}-gauge`,
      0.016,
      index === 1 ? 0.2 : 0.17,
      index === 1 ? 0.2 : 0.17,
      24,
      faceMaterial,
      root,
    );
    face.rotation.z = Math.PI / 2;
    face.position.set(x - 0.061, y + gauge.y, gauge.z * depth);
    face.metadata = { ...face.metadata, cockpitInterior: true, castsShadow: false };
    const needle = build.box(
      `${prefix}-${gauge.name}-needle`,
      0.013,
      0.012,
      index === 1 ? 0.072 : 0.06,
      markingMaterial,
      root,
    );
    needle.position.set(x - 0.073, y + gauge.y, gauge.z * depth + 0.018);
    needle.rotation.x = (index - 2) * 0.38;
    needle.metadata = { ...needle.metadata, cockpitInterior: true, castsShadow: false };
    meshes.push(face, needle);
  }
  return meshes;
}


export function applyCommonPose(
  rig: CommonRig,
  pose: ReturnType<typeof resolveAircraftAnimationPose>,
  deltaSeconds: number,
): void {
  if (rig.ailerons[0]) rig.ailerons[0].rotation.z = pose.starboardAileron;
  if (rig.ailerons[1]) rig.ailerons[1].rotation.z = pose.portAileron;
  // Summed, not written twice: a flaperon's deflection IS the flap setting
  // plus the roll command, and the surface's own travel already bounds each
  // term through `SURFACE_TRAVEL`.
  if (rig.flaperons[0]) rig.flaperons[0].rotation.z = pose.flap + pose.starboardAileron;
  if (rig.flaperons[1]) rig.flaperons[1].rotation.z = pose.flap + pose.portAileron;
  for (const elevator of rig.elevators) elevator.rotation.z = pose.elevator;
  rig.rudder.rotation.y = pose.rudder;
  rig.noseSteer.rotation.y = pose.noseSteering;
  for (const flap of rig.flaps) flap.rotation.z = pose.flap;
  for (const wheel of rig.mainWheels) {
    wheel.rotation.z += pose.mainWheelRadiansPerSecond * deltaSeconds;
  }
  rig.noseWheel.rotation.z += pose.noseWheelRadiansPerSecond * deltaSeconds;
}

export function configureCockpitLayers(parts: readonly AbstractMesh[]): void {
  for (const part of parts) {
    part.layerMask = AIRCRAFT_EXTERIOR_LAYER_MASK;
    // Shadow generators use visibility/enabled state, not the active camera's
    // layer mask. Exterior skin therefore remains a caster in cockpit view.
    part.isVisible = true;
  }
}

/**
 * Make `parts` cockpit-only: invisible until `setCockpitVisibility` turns them
 * on, and never a shadow caster. Both invariants are enforced HERE rather than
 * left to each builder, because either one forgotten is a defect nothing else
 * would notice — a part visible from outside is a floating panel in every chase
 * frame, and a part registered as a caster throws a shadow of the cockpit.
 * `castsShadow` is set through a spread so a part's other metadata survives.
 */
export function configureCockpitOnlyParts(parts: readonly AbstractMesh[]): void {
  for (const part of parts) {
    part.isVisible = false;
    part.metadata = { ...part.metadata, castsShadow: false };
  }
}

export function setCockpitVisibility(rig: CommonRig, scene: Scene, enabled: boolean): void {
  for (const part of rig.cockpitParts) {
    part.layerMask = AIRCRAFT_EXTERIOR_LAYER_MASK;
    part.isVisible = true;
  }
  // Visible for exactly as long as cockpit view lasts.
  for (const part of rig.cockpitOnlyParts ?? []) part.isVisible = enabled;
  const camera = scene.activeCamera;
  if (camera) camera.layerMask = aircraftCameraLayerMask(camera.layerMask, enabled);
  // Wing roots are intentional cockpit reference geometry and stay visible;
  // they use Babylon's ordinary multi-bit world mask rather than the isolated
  // exterior-skin bit.
  for (const wing of rig.wingSurfaces) wing.isVisible = true;
}

/**
 * Creates a procedural aircraft directly in the provided Babylon scene.
 * The scene must already be configured as right-handed.
 */
/**
 * `7-8`: apply a per-lamp emissive scale, remembering each material's authored
 * intensity as its full-brightness value.
 *
 * Scales `emissiveIntensity` rather than toggling `isVisible` or `setEnabled`:
 * a lamp that vanishes also stops occluding and stops contributing to bloom,
 * so a strobe wired that way pops the whole silhouette rather than flashing.
 * The propeller rig makes the same point about phase-dependent visibility and
 * it applies identically here.
 */
/**
 * `7-8`: the cockpit instrument glow, which legitimately EXCEEDS 1.
 *
 * Separate from `createLampApplier` because that one clamps to [0, 1] — right
 * for a lamp, which is either lit or not, and wrong here: the panel's authored
 * value is its DAYLIGHT brightness and night raises it above that. Sharing one
 * applier would have silently clamped the night case back to daylight, which
 * is the kind of thing that looks like the law being wrong.
 */
export function createGlowApplier(): (material: PBRMaterial, multiple: number) => void {
  const base = new WeakMap<PBRMaterial, number>();
  return (material, multiple) => {
    let authored = base.get(material);
    if (authored === undefined) {
      authored = material.emissiveIntensity;
      base.set(material, authored);
    }
    const safe = Number.isFinite(multiple) ? Math.max(0, multiple) : 1;
    material.emissiveIntensity = authored * safe;
  };
}

export function createLampApplier(): (material: PBRMaterial, scale: number) => void {
  const base = new WeakMap<PBRMaterial, number>();
  return (material, scale) => {
    let full = base.get(material);
    if (full === undefined) {
      full = material.emissiveIntensity;
      base.set(material, full);
    }
    material.emissiveIntensity = full * Math.min(1, Math.max(0, scale));
  };
}

