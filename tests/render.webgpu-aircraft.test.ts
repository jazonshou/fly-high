import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import {
  AIRCRAFT_EXTERIOR_LAYER_MASK,
  createWebGpuAircraft,
  resolvePropellerPresentation,
  resolveAircraftAnimationPose,
  safeAircraftAnimationDelta,
  synthesizeAircraftSurface,
} from "../src/render/webgpu/aircraft";

function rightHandedFixture(): {
  engine: NullEngine;
  scene: Scene;
  camera: UniversalCamera;
} {
  const engine = new NullEngine({
    renderWidth: 64,
    renderHeight: 64,
    textureSize: 64,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new UniversalCamera("aircraft-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  return { engine, scene, camera };
}

function transform(scene: Scene, name: string): TransformNode {
  const result = scene.getTransformNodeByName(name);
  if (!result) throw new Error(`Missing transform node ${name}`);
  return result;
}

function mesh(scene: Scene, name: string): AbstractMesh {
  const result = scene.getMeshByName(name);
  if (!result) throw new Error(`Missing mesh ${name}`);
  return result;
}

function pbr(scene: Scene, name: string): PBRMaterial {
  const material = scene.getMaterialByName(name);
  if (!(material instanceof PBRMaterial)) throw new Error(`Missing PBR material ${name}`);
  return material;
}

function expectShadowCastersVisible(meshes: readonly AbstractMesh[]): void {
  expect(
    meshes
      .filter((part) => part.metadata?.castsShadow !== false)
      .every((part) => part.isVisible),
  ).toBe(true);
}

function expectVisibleToCamera(mesh: AbstractMesh, camera: UniversalCamera): void {
  expect(mesh.isVisible).toBe(true);
  expect(mesh.isEnabled()).toBe(true);
  expect(mesh.layerMask & camera.layerMask).not.toBe(0);
}

describe("Babylon WebGPU aircraft visual", () => {
  it("requires and records the simulator's right-handed +X-forward body frame", () => {
    const engine = new NullEngine();
    const leftHandedScene = new Scene(engine);
    expect(() => createWebGpuAircraft(leftHandedScene, "trainer")).toThrow(
      "scene.useRightHandedSystem = true",
    );
    leftHandedScene.dispose();
    engine.dispose();

    const fixture = rightHandedFixture();
    const aircraft = createWebGpuAircraft(fixture.scene, "trainer");
    expect(aircraft.handedness).toBe("right");
    expect(aircraft.group).toBe(aircraft.root);
    expect(aircraft.group.name).toBe("aerolith-trainer");
    expect(aircraft.group.metadata).toMatchObject({
      handedness: "right",
      bodyAxes: { forward: "+x", up: "+y", port: "+z" },
    });
    expect(mesh(fixture.scene, "port-navigation-light").position.z).toBeGreaterThan(0);
    expect(mesh(fixture.scene, "starboard-navigation-light").position.z).toBeLessThan(0);
    aircraft.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  });

  it("builds recognizable trainer detail and animates pilot-facing controls", () => {
    const fixture = rightHandedFixture();
    const aircraft = createWebGpuAircraft(fixture.scene, "trainer");
    for (const detail of [
      "trainer-fuselage",
      "port-main-wing-forward",
      "starboard-main-wing-forward",
      "port-wing-flap",
      "starboard-wing-flap",
      "port-aileron-surface",
      "starboard-aileron-surface",
      "windscreen-center-frame",
      "trainer-instrument-panel",
      "trainer-airspeed-gauge",
      "trainer-attitude-gauge",
      "engine-cowling-band",
      "pitot-tube",
      "landing-light",
      "starboard-main-strut",
      "port-main-brace",
      "trainer-nose-strut",
      "starboard-exhaust",
      "port-exhaust",
    ]) {
      expect(fixture.scene.getNodeByName(detail), detail).not.toBeNull();
    }

    aircraft.update(
      {
        ...INITIAL_VISUAL_STATE,
        aileron: 0.8,
        elevator: 0.6,
        rudder: 0.5,
        onGround: true,
        altitudeAgl: 0,
        velocity: { x: 25, y: 0, z: 0 },
        // The propeller phase is anchored to simulation time (deterministic
        // captures); a nonzero instant is what makes it spin.
        simulationTime: 0.5,
      },
      1 / 60,
    );
    expect(transform(fixture.scene, "starboard-aileron").rotation.z).toBeLessThan(0);
    expect(transform(fixture.scene, "port-aileron").rotation.z).toBeGreaterThan(0);
    expect(transform(fixture.scene, "elevator").rotation.z).toBeLessThan(0);
    expect(transform(fixture.scene, "rudder").rotation.y).toBeLessThan(0);
    expect(transform(fixture.scene, "nose-wheel-steering").rotation.y).toBeLessThan(0);
    expect(transform(fixture.scene, "starboard-main-wheel").rotation.z).toBeLessThan(0);
    expect(aircraft.propeller.rotation.x).toBeGreaterThan(0);

    const exteriorMaskBeforeCockpit = fixture.camera.layerMask;
    const canopy = mesh(fixture.scene, "trainer-canopy");
    expect(aircraft.cockpitParts).not.toContain(canopy);
    expectVisibleToCamera(canopy, fixture.camera);
    expectShadowCastersVisible(aircraft.meshes);
    expect(aircraft.cockpitParts.every((part) => part.isVisible)).toBe(true);
    expect(
      aircraft.cockpitParts.every((part) => part.layerMask === AIRCRAFT_EXTERIOR_LAYER_MASK),
    ).toBe(true);
    aircraft.setCockpitView(true);
    expectVisibleToCamera(canopy, fixture.camera);
    expect(
      aircraft.cockpitParts.every(
        (part) => part.isVisible && (part.layerMask & fixture.camera.layerMask) === 0,
      ),
    ).toBe(true);
    expect(mesh(fixture.scene, "port-main-wing-forward").isVisible).toBe(true);
    expect(
      mesh(fixture.scene, "port-main-wing-forward").layerMask & fixture.camera.layerMask,
    ).not.toBe(0);
    expectShadowCastersVisible(aircraft.meshes);
    aircraft.setCockpitView(false);
    expectVisibleToCamera(canopy, fixture.camera);
    expectShadowCastersVisible(aircraft.meshes);
    expect(aircraft.cockpitParts.every((part) => part.isVisible)).toBe(true);
    expect(fixture.camera.layerMask).toBe(exteriorMaskBeforeCockpit);

    aircraft.dispose();
    aircraft.dispose();
    expect(aircraft.root.isDisposed()).toBe(true);
    fixture.scene.dispose();
    fixture.engine.dispose();
  });

  it("builds the distinct jet and applies smooth gear and speed-brake travel", () => {
    const fixture = rightHandedFixture();
    const aircraft = createWebGpuAircraft(fixture.scene, "jet");
    expect(aircraft.group.name).toBe("vesper-fast-jet");
    expect(aircraft.propeller.name).toBe("jet-compressor");
    for (const detail of [
      "jet-fuselage",
      "port-swept-main-wing",
      "starboard-swept-main-wing",
      "port-swept-tailplane",
      "starboard-swept-tailplane",
      "radar-nose",
      "tandem-canopy",
      "jet-front-seat",
      "jet-instrument-panel",
      "jet-attitude-gauge",
      "starboard-engine-intake",
      "port-engine-intake",
      "swept-vertical-stabilizer",
      "landing-gear-doors",
      "starboard-main-strut",
      "jet-nose-strut",
      "starboard-speed-brake",
      "port-speed-brake",
    ]) {
      expect(fixture.scene.getNodeByName(detail), detail).not.toBeNull();
    }

    aircraft.update(
      {
        ...INITIAL_VISUAL_STATE,
        engineRpm: 92,
        aileron: 0.7,
        elevator: -0.5,
        rudder: 0.4,
        gear: 0,
        brake: 0,
        onGround: false,
      },
      1 / 30,
    );
    const gear = transform(fixture.scene, "retractable-landing-gear");
    expect(gear.isEnabled()).toBe(false);
    expect(transform(fixture.scene, "starboard-aileron").rotation.z).toBeLessThan(0);
    expect(transform(fixture.scene, "port-aileron").rotation.z).toBeGreaterThan(0);
    expect(transform(fixture.scene, "elevator").rotation.z).toBeGreaterThan(0);
    expect(transform(fixture.scene, "rudder").rotation.y).toBeLessThan(0);

    aircraft.update(
      { ...INITIAL_VISUAL_STATE, gear: 0.5, brake: 1, onGround: false },
      1 / 30,
    );
    expect(gear.isEnabled()).toBe(true);
    expect(gear.scaling.y).toBeGreaterThan(0.08);
    expect(gear.scaling.y).toBeLessThan(1);
    expect(mesh(fixture.scene, "starboard-main-gear-door").rotation.x).toBeGreaterThan(1);
    expect(transform(fixture.scene, "starboard-speed-brake").rotation.z).toBeLessThan(-0.6);

    aircraft.update(
      { ...INITIAL_VISUAL_STATE, gear: 1, onGround: true, altitudeAgl: 0 },
      1 / 30,
    );
    expect(gear.scaling.y).toBe(1);
    expect(gear.position.y).toBeCloseTo(0, 10);
    const canopy = mesh(fixture.scene, "tandem-canopy");
    expect(aircraft.cockpitParts).not.toContain(canopy);
    expectVisibleToCamera(canopy, fixture.camera);
    expectShadowCastersVisible(aircraft.meshes);
    aircraft.setCockpitView(true);
    expectVisibleToCamera(canopy, fixture.camera);
    expectShadowCastersVisible(aircraft.meshes);
    expect(
      aircraft.cockpitParts.every(
        (part) => (part.layerMask & fixture.camera.layerMask) === 0,
      ),
    ).toBe(true);
    expect(
      mesh(fixture.scene, "jet-instrument-panel").layerMask & fixture.camera.layerMask,
    ).not.toBe(0);
    aircraft.setCockpitView(false);
    expectVisibleToCamera(canopy, fixture.camera);
    expectShadowCastersVisible(aircraft.meshes);
    aircraft.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  });

  it("keeps actuator resolution pure, finite, bounded, and frame-gap safe", () => {
    const trainer = resolveAircraftAnimationPose("trainer", {
      ...INITIAL_VISUAL_STATE,
      aileron: 4,
      elevator: -3,
      rudder: 2,
      velocity: { x: 60, y: 0, z: 0 },
      onGround: true,
      altitudeAgl: 0,
    });
    expect(trainer.starboardAileron).toBe(-0.25);
    expect(trainer.portAileron).toBe(0.25);
    expect(trainer.elevator).toBe(0.3);
    expect(trainer.rudder).toBe(-0.32);
    expect(trainer.mainWheelRadiansPerSecond).toBeCloseTo(-60 / 0.27, 8);

    const jet = resolveAircraftAnimationPose("jet", {
      ...INITIAL_VISUAL_STATE,
      gear: 0.5,
      brake: 1,
    });
    expect(jet.gearScale.x).toBeCloseTo(0.95, 10);
    expect(jet.gearScale.y).toBeCloseTo(0.54, 10);
    expect(jet.gearScale.z).toBeCloseTo(0.68, 10);
    expect(jet.gearDoorTravel).toBeCloseTo(1.05, 8);
    expect(jet.speedBrake).toBe(-0.68);
    expect(safeAircraftAnimationDelta(Number.NaN)).toBe(0);
    expect(safeAircraftAnimationDelta(-1)).toBe(0);
    expect(safeAircraftAnimationDelta(3)).toBe(0.1);
  });

  it("builds lofted bodies and finite, UV-mapped airfoil volumes", () => {
    const fixture = rightHandedFixture();
    const trainer = createWebGpuAircraft(fixture.scene, "trainer");
    const fuselage = mesh(fixture.scene, "trainer-fuselage");
    expect(fuselage.metadata).toMatchObject({
      aircraftGeometry: "lofted-fuselage",
      loftSectionCount: 7,
      capped: true,
    });
    const fuselagePositions = fuselage.getVerticesData(VertexBuffer.PositionKind)!;
    const fuselageNormals = fuselage.getVerticesData(VertexBuffer.NormalKind)!;
    let topVertex = 0;
    for (let index = 1; index < fuselagePositions.length / 3; index += 1) {
      if (fuselagePositions[index * 3 + 1]! > fuselagePositions[topVertex * 3 + 1]!) {
        topVertex = index;
      }
    }
    expect(fuselageNormals[topVertex * 3 + 1]).toBeGreaterThan(0);
    const wing = mesh(fixture.scene, "port-main-wing-forward");
    expect(wing.metadata).toMatchObject({
      aircraftGeometry: "airfoil-wing",
      airfoilThicknessRatio: 0.12,
    });
    const positions = wing.getVerticesData(VertexBuffer.PositionKind);
    const normals = wing.getVerticesData(VertexBuffer.NormalKind);
    const uvs = wing.getVerticesData(VertexBuffer.UVKind);
    expect(positions).not.toBeNull();
    expect(normals).toHaveLength(positions!.length);
    expect(uvs).toHaveLength((positions!.length / 3) * 2);
    expect(positions!.every(Number.isFinite)).toBe(true);
    expect(normals!.every(Number.isFinite)).toBe(true);
    const yCoordinates = positions!.filter((_, index) => index % 3 === 1);
    expect(Math.max(...yCoordinates)).toBeGreaterThan(0.05);
    expect(Math.min(...yCoordinates)).toBeLessThan(-0.05);
    let upperWingVertex = 0;
    let lowerWingVertex = 0;
    for (let index = 1; index < positions!.length / 3; index += 1) {
      if (positions![index * 3 + 1]! > positions![upperWingVertex * 3 + 1]!) {
        upperWingVertex = index;
      }
      if (positions![index * 3 + 1]! < positions![lowerWingVertex * 3 + 1]!) {
        lowerWingVertex = index;
      }
    }
    expect(normals![upperWingVertex * 3 + 1]).toBeGreaterThan(0);
    expect(normals![lowerWingVertex * 3 + 1]).toBeLessThan(0);
    // The fixed wing ends at x=-0.27 at the root; the aileron hinge starts
    // aft at x=-0.29, leaving a visible control-surface gap.
    expect(transform(fixture.scene, "port-aileron").position.x).toBeLessThan(-0.27);
    trainer.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  });

  it("synthesizes deterministic panel/rivet/wear/livery paint and binds per-part BRDF maps", () => {
    const recipe = {
      seed: 12345,
      baseColor: 0xd8e0df,
      liveryColor: 0xd7593d,
      roughness: 0.38,
      metallic: 0.17,
      sootStrength: 0.9,
      wearStrength: 0.8,
    } as const;
    const first = synthesizeAircraftSurface(recipe, 32);
    const second = synthesizeAircraftSurface(recipe, 32);
    expect(first.albedoMips.map((level) => [...level])).toEqual(
      second.albedoMips.map((level) => [...level]),
    );
    expect(first.albedoMips).toHaveLength(6);
    expect(first.normalMips).toHaveLength(6);
    expect(first.metallicRoughnessMips).toHaveLength(6);
    for (const coverage of Object.values(first.featureCoverage)) {
      expect(coverage).toBeGreaterThan(0);
      expect(coverage).toBeLessThan(0.5);
    }

    const fixture = rightHandedFixture();
    const aircraft = createWebGpuAircraft(fixture.scene, "trainer");
    const body = pbr(fixture.scene, "trainer-body");
    const accent = pbr(fixture.scene, "trainer-accent");
    expect(body.albedoTexture?.name).toBe("trainer-body-albedo");
    expect(body.bumpTexture?.name).toBe("trainer-body-normal");
    expect(body.metallicTexture?.name).toBe("trainer-body-metallic-roughness");
    expect(body.metadata).toMatchObject({
      aircraftPaint: true,
      aircraftPaintFeatures: expect.arrayContaining([
        "panel-lines",
        "rivets",
        "seams",
        "filler",
        "exhaust-soot",
        "leading-edge-wear",
        "livery-decal",
      ]),
    });
    expect(body.metadata.aircraftPaintRecipe).not.toEqual(accent.metadata.aircraftPaintRecipe);
    aircraft.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  });

  it("uses clearcoat transmission for glass and a non-strobing propeller crossfade", () => {
    expect(resolvePropellerPresentation(0)).toEqual({ bladeOpacity: 1, discOpacity: 0 });
    expect(resolvePropellerPresentation(15)).toEqual({ bladeOpacity: 1, discOpacity: 0 });
    const transition = resolvePropellerPresentation(25);
    expect(transition.bladeOpacity).toBeCloseTo(0.5, 8);
    expect(transition.discOpacity).toBeCloseTo(0.5, 8);
    expect(resolvePropellerPresentation(80)).toEqual({ bladeOpacity: 0, discOpacity: 1 });

    const fixture = rightHandedFixture();
    const aircraft = createWebGpuAircraft(fixture.scene, "trainer");
    const glass = pbr(fixture.scene, "trainer-glass");
    expect(glass.clearCoat.isEnabled).toBe(true);
    expect(glass.clearCoat.intensity).toBe(1);
    expect(glass.clearCoat.roughness).toBeLessThan(0.05);
    expect(glass.subSurface.isRefractionEnabled).toBe(true);
    expect(glass.subSurface.linkRefractionWithTransparency).toBe(true);
    expect(glass.subSurface.indexOfRefraction).toBeCloseTo(1.52, 8);

    const enabled = aircraft.propeller.isEnabled();
    for (const simulationTime of [0, 0.1, 0.2, 0.3]) {
      aircraft.update(
        { ...INITIAL_VISUAL_STATE, engineRpm: 2_250, simulationTime },
        1 / 60,
      );
      expect(aircraft.propeller.isEnabled()).toBe(enabled);
    }
    expect(pbr(fixture.scene, "trainer-propeller-blades").alpha).toBe(0);
    expect(pbr(fixture.scene, "trainer-propeller-disc").alpha).toBe(1);
    aircraft.update(
      { ...INITIAL_VISUAL_STATE, engineRpm: 0, simulationTime: 0.4 },
      1 / 60,
    );
    expect(pbr(fixture.scene, "trainer-propeller-blades").alpha).toBe(1);
    expect(pbr(fixture.scene, "trainer-propeller-disc").alpha).toBe(0);
    expect(mesh(fixture.scene, "trainer-propeller-disc").metadata).toMatchObject({
      aircraftGeometry: "radial-propeller-blur",
      castsShadow: false,
    });
    aircraft.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  });
});
