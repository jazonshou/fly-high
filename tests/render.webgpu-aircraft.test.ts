import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import {
  createWebGpuAircraft,
  resolveAircraftAnimationPose,
  safeAircraftAnimationDelta,
} from "../src/render/webgpu/aircraft";

function rightHandedFixture(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine({
    renderWidth: 64,
    renderHeight: 64,
    textureSize: 64,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  return { engine, scene };
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
      "tapered-main-wing",
      "windscreen-center-frame",
      "engine-cowling-band",
      "pitot-tube",
      "landing-light",
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

    aircraft.setCockpitView(true);
    expect(aircraft.cockpitParts.every((part) => !part.isVisible)).toBe(true);
    expect(mesh(fixture.scene, "tapered-main-wing").isVisible).toBe(true);
    aircraft.setCockpitView(false);
    expect(aircraft.cockpitParts.every((part) => part.isVisible)).toBe(true);

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
      "swept-main-wing",
      "radar-nose",
      "tandem-canopy",
      "starboard-engine-intake",
      "port-engine-intake",
      "swept-vertical-stabilizer",
      "landing-gear-doors",
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
});
