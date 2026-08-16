import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { keyboardRollDirection } from "../src/input";
import {
  AtmosphereChangeTracker,
  WebGLContextLifecycle,
  adaptiveResolutionScale,
  atmosphereFogNear,
  chaseCameraProfile,
  createContactShadow,
  disposeReusableWebGLRenderer,
  qualityPixelRatio,
  setOrthogonalCameraUp,
} from "../src/render/FlightRenderer";
import { createAircraft } from "../src/render/createAircraft";
import { quaternionFromFlightAngles } from "../src/sim";

function expectDestinationAlphaPreserved(
  material: THREE.Material,
  expectedRgbSource: THREE.BlendingSrcFactor,
): void {
  expect(material.blending).toBe(THREE.CustomBlending);
  expect(material.blendEquation).toBe(THREE.AddEquation);
  expect(material.blendSrc).toBe(expectedRgbSource);
  expect(material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
  expect(material.blendEquationAlpha).toBe(THREE.AddEquation);
  expect(material.blendSrcAlpha).toBe(THREE.ZeroFactor);
  expect(material.blendDstAlpha).toBe(THREE.OneFactor);
}

describe("aircraft control-surface presentation", () => {
  it("changes adaptive resolution by one bounded step with wide hysteresis", () => {
    expect(qualityPixelRatio("low")).toBe(0.85);
    expect(qualityPixelRatio("medium")).toBe(1.2);
    expect(qualityPixelRatio("high")).toBe(1.75);
    expect(adaptiveResolutionScale(1, 24)).toBeCloseTo(0.92, 8);
    expect(adaptiveResolutionScale(0.92, 18)).toBe(0.92);
    expect(adaptiveResolutionScale(0.92, 13.9)).toBeCloseTo(0.96, 8);
    expect(adaptiveResolutionScale(0.7, 30)).toBe(0.68);
    expect(adaptiveResolutionScale(0.68, 30)).toBe(0.68);
    expect(adaptiveResolutionScale(Number.NaN, Number.NaN)).toBe(1);
  });

  it("preserves terrain detail before atmospheric fog begins", () => {
    expect(atmosphereFogNear("cloudy")).toBe(2_200);
    expect(atmosphereFogNear("breezy")).toBe(3_800);
    expect(atmosphereFogNear("clear")).toBe(4_500);
  });

  it("invalidates temporal atmosphere state only when the preset changes", () => {
    const tracker = new AtmosphereChangeTracker();
    expect(tracker.update("day", "clear")).toBe(true);
    expect(tracker.update("day", "clear")).toBe(false);
    expect(tracker.update("day", "cloudy")).toBe(true);
    expect(tracker.update("golden", "cloudy")).toBe(true);
    expect(tracker.update("golden", "cloudy")).toBe(false);
  });

  it("pauses across WebGL loss until rebuild succeeds and removes both listeners", () => {
    const target = new EventTarget();
    let losses = 0;
    let restoreAttempts = 0;
    let restoreSucceeds = false;
    const lifecycle = new WebGLContextLifecycle(
      target,
      () => {
        losses += 1;
      },
      () => {
        restoreAttempts += 1;
        return restoreSucceeds;
      },
    );
    const loss = new Event("webglcontextlost", { cancelable: true });
    target.dispatchEvent(loss);
    expect(loss.defaultPrevented).toBe(true);
    expect(losses).toBe(1);
    expect(lifecycle.renderingPaused).toBe(true);

    target.dispatchEvent(new Event("webglcontextrestored"));
    expect(restoreAttempts).toBe(1);
    expect(lifecycle.renderingPaused).toBe(true);
    restoreSucceeds = true;
    target.dispatchEvent(new Event("webglcontextrestored"));
    expect(restoreAttempts).toBe(2);
    expect(lifecycle.renderingPaused).toBe(false);

    lifecycle.dispose();
    target.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    target.dispatchEvent(new Event("webglcontextrestored"));
    expect(losses).toBe(1);
    expect(restoreAttempts).toBe(2);
  });

  it("releases renderer resources without destroying the canvas context used by a new seed", () => {
    let disposeCalls = 0;
    let forcedLosses = 0;
    const renderer = {
      dispose: () => {
        disposeCalls += 1;
      },
      forceContextLoss: () => {
        forcedLosses += 1;
      },
    };

    disposeReusableWebGLRenderer(renderer);
    expect(disposeCalls).toBe(1);
    expect(forcedLosses).toBe(0);
  });

  it("keeps camera up finite and orthogonal for vertical views", () => {
    const preferredUp = new THREE.Vector3(0, 1, 0);
    const bodyUp = new THREE.Vector3(1, 0, 0);
    for (const view of [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(1e-12, -1, -1e-12),
    ]) {
      const result = setOrthogonalCameraUp(
        new THREE.Vector3(),
        preferredUp,
        view,
        bodyUp,
      );
      expect(result.length()).toBeCloseTo(1, 10);
      expect(Math.abs(result.dot(view.clone().normalize()))).toBeLessThan(1e-10);
      expect([result.x, result.y, result.z].every(Number.isFinite)).toBe(true);
    }
  });

  it("keeps transparent aircraft glass and the contact shadow out of beauty alpha", () => {
    for (const kind of ["trainer", "jet"] as const) {
      const aircraft = createAircraft(kind);
      const transparentMaterials = new Set<THREE.Material>();
      aircraft.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const material of materials) {
          if (material.transparent) transparentMaterials.add(material);
        }
      });
      expect(transparentMaterials.size).toBeGreaterThan(0);
      for (const material of transparentMaterials) {
        expect(material.premultipliedAlpha).toBe(false);
        expectDestinationAlphaPreserved(material, THREE.SrcAlphaFactor);
      }
      aircraft.dispose();
    }

    const contactShadow = createContactShadow();
    expectDestinationAlphaPreserved(contactShadow.material, THREE.SrcAlphaFactor);
    contactShadow.geometry.dispose();
    contactShadow.material.dispose();
  });

  it("keeps both aircraft legible in the chase camera across their speed ranges", () => {
    const trainer = chaseCameraProfile("trainer", 56);
    const jetCruise = chaseCameraProfile("jet", 155);
    const jetFast = chaseCameraProfile("jet", 320);
    expect(trainer.distance).toBeGreaterThan(13);
    expect(jetCruise.distance).toBeLessThan(15);
    expect(jetFast.distance).toBeLessThanOrEqual(16.5);
    expect(jetFast.fieldOfView).toBeLessThanOrEqual(65);
  });

  it("keeps the WebGL chase origin on the HUD and projects A left / D right", () => {
    const projectedWingHeights = (code: "KeyA" | "KeyD") => {
      const orientation = quaternionFromFlightAngles(
        Math.PI / 2,
        0,
        keyboardRollDirection(code) * 0.35,
      );
      const aircraft = new THREE.Quaternion(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      );
      const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000);
      camera.position.set(-13.5, 5.1, 0).applyQuaternion(aircraft);
      const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(aircraft);
      const preferredUp = new THREE.Vector3(0, 1, 0).lerp(bodyUp, 0.18).normalize();
      const view = camera.position.clone().multiplyScalar(-1);
      setOrthogonalCameraUp(camera.up, preferredUp, view, bodyUp);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      const origin = new THREE.Vector3().project(camera);
      const wings = [-5.45, 5.45]
        .map((z) => new THREE.Vector3(0.2, 0.2, z).applyQuaternion(aircraft).project(camera))
        .sort((first, second) => first.x - second.x);
      return { origin, screenLeft: wings[0]!, screenRight: wings[1]! };
    };

    const leftBank = projectedWingHeights("KeyA");
    const rightBank = projectedWingHeights("KeyD");
    expect(leftBank.origin.x).toBeCloseTo(0, 10);
    expect(leftBank.origin.y).toBeCloseTo(0, 10);
    expect(leftBank.screenLeft.y).toBeLessThan(leftBank.screenRight.y);
    expect(rightBank.screenLeft.y).toBeGreaterThan(rightBank.screenRight.y);
  });

  it("moves each surface with pilot-friendly actuator signs", () => {
    const aircraft = createAircraft();
    aircraft.update({
      ...INITIAL_VISUAL_STATE,
      aileron: 0.8,
      elevator: 0.6,
      rudder: 0.5,
    }, 1 / 60);

    const starboard = aircraft.group.getObjectByName("starboard-aileron");
    const port = aircraft.group.getObjectByName("port-aileron");
    const elevator = aircraft.group.getObjectByName("elevator");
    const rudder = aircraft.group.getObjectByName("rudder");
    expect(starboard?.rotation.z).toBeLessThan(0);
    expect(port?.rotation.z).toBeGreaterThan(0);
    expect(elevator?.rotation.z).toBeLessThan(0);
    expect(rudder?.rotation.y).toBeLessThan(0);
    aircraft.dispose();
  });

  it("keeps the visible tyre bottoms aligned to the physics contact points", () => {
    const aircraft = createAircraft();
    const starboard = aircraft.group.getObjectByName("starboard-main-wheel");
    const port = aircraft.group.getObjectByName("port-main-wheel");
    const nose = aircraft.group.getObjectByName("nose-wheel-steering");
    expect(starboard?.position.y).toBeCloseTo(-1.07, 6);
    expect(port?.position.y).toBeCloseTo(-1.07, 6);
    expect((starboard?.position.y ?? 0) - 0.27).toBeCloseTo(-1.34, 6);
    expect((port?.position.y ?? 0) - 0.27).toBeCloseTo(-1.34, 6);
    expect((nose?.position.y ?? 0) - 0.21).toBeCloseTo(-1.16, 6);
    aircraft.dispose();
  });

  it("gives the trainer a tapered airframe and recognizable exterior detail", () => {
    const aircraft = createAircraft("trainer");
    expect(aircraft.group.name).toBe("aerolith-trainer");
    for (const detail of [
      "tapered-main-wing",
      "windscreen-center-frame",
      "engine-cowling-band",
      "pitot-tube",
      "landing-light",
      "starboard-exhaust",
      "port-exhaust",
    ]) {
      expect(aircraft.group.getObjectByName(detail), detail).toBeDefined();
    }
    const bounds = new THREE.Box3().setFromObject(aircraft.group);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(10.7);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(7.5);
    let meshCount = 0;
    aircraft.group.traverse((child) => {
      if (child instanceof THREE.Mesh) meshCount += 1;
    });
    expect(meshCount).toBeLessThanOrEqual(46);
    aircraft.dispose();
  });

  it("builds a distinct swept-wing jet with animated flight surfaces", () => {
    const aircraft = createAircraft("jet");
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
      expect(aircraft.group.getObjectByName(detail), detail).toBeDefined();
    }

    aircraft.update({
      ...INITIAL_VISUAL_STATE,
      engineRpm: 92,
      aileron: 0.7,
      elevator: -0.5,
      rudder: 0.4,
      gear: 0,
      brake: 0,
    }, 1 / 30);
    expect(aircraft.propeller.rotation.x).toBeGreaterThan(0);
    expect(aircraft.group.getObjectByName("starboard-aileron")?.rotation.z).toBeLessThan(0);
    expect(aircraft.group.getObjectByName("port-aileron")?.rotation.z).toBeGreaterThan(0);
    expect(aircraft.group.getObjectByName("elevator")?.rotation.z).toBeGreaterThan(0);
    expect(aircraft.group.getObjectByName("rudder")?.rotation.y).toBeLessThan(0);
    expect(aircraft.group.getObjectByName("retractable-landing-gear")?.visible).toBe(false);
    aircraft.update({ ...INITIAL_VISUAL_STATE, onGround: false, gear: 0.5, brake: 1 }, 1 / 30);
    const transitioningGear = aircraft.group.getObjectByName("retractable-landing-gear");
    expect(transitioningGear?.visible).toBe(true);
    expect(transitioningGear?.scale.y).toBeGreaterThan(0.08);
    expect(transitioningGear?.scale.y).toBeLessThan(1);
    expect(aircraft.group.getObjectByName("starboard-speed-brake")?.rotation.z).toBeLessThan(-0.6);
    aircraft.update({ ...INITIAL_VISUAL_STATE, onGround: true, altitudeAgl: 0, gear: 1 }, 1 / 30);
    expect(aircraft.group.getObjectByName("retractable-landing-gear")?.visible).toBe(true);
    expect(aircraft.group.getObjectByName("retractable-landing-gear")?.scale.y).toBe(1);
    let meshCount = 0;
    aircraft.group.traverse((child) => {
      if (child instanceof THREE.Mesh) meshCount += 1;
    });
    expect(meshCount).toBeLessThanOrEqual(38);
    aircraft.dispose();
  });
});
