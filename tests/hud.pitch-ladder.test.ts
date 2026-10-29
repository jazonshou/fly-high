import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Scene } from "@babylonjs/core/scene";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { INITIAL_VISUAL_STATE, type CameraMode } from "../src/game/types";
import {
  cameraBankFollow,
  cameraRigLiftToRef,
  CHASE_AIM_HEIGHT_METERS,
  chaseRigHeightForBank,
  chaseRigOffsetsToRef,
  COCKPIT_AIM_DISTANCE_METERS,
  cockpitHorizontalFieldOfViewForAspect,
  cockpitRigPositionsToRef,
} from "../src/render/cameraPresentation";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import { createHudCamera, type HudCamera } from "../src/render/types";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";
import { Hud } from "../src/ui/Hud";
import {
  applyPitchLadder,
  createPitchLadderFrame,
  createPitchLadderView,
  PITCH_LADDER_PITCHES,
  PITCH_LADDER_SIDE_MARGIN,
  PITCH_LADDER_TOP_MARGIN,
  PITCH_LADDER_WINDOW,
  pitchLadderToRef,
  type PitchLadderFrame,
} from "../src/ui/pitchLadder";
import { flyAt } from "./support/visualStateFromSimulator";

/**
 * The HUD's pitch ladder against the camera that drew the frame (src/ui/pitchLadder.ts).
 *
 * Jason, 2026-10-28: "I've noticed that it's sometimes off at least for the f16.
 * Could you take a look and make sure the pitch ladder is always correct?" It was:
 * the old ladder was a fixed drawing at 2.25 px a degree, centred on the screen
 * and turned by the full bank. These hold the replacement to what the camera
 * SEES, with Babylon's own camera and `Vector3.Project` as the referee: the zero
 * line on the horizon, the symbol on the nose, each rung at its own pitch, for
 * every airframe, in the chase and cockpit views, banked, pitched, inverted and
 * vertical, on every window shape the cockpit layout is tested on.
 */

const DEG = Math.PI / 180;
const SHAPES = [[1280, 720], [1920, 1080], [1600, 1200], [3440, 1440]] as const;

const engines = new Map<string, { engine: NullEngine; scene: Scene; camera: UniversalCamera }>();
function rigFor(width: number, height: number) {
  const key = `${width}x${height}`;
  let rig = engines.get(key);
  if (!rig) {
    const engine = new NullEngine({
      renderWidth: width,
      renderHeight: height,
      textureSize: 256,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new UniversalCamera("hud-ladder-camera", Vector3.Zero(), scene);
    camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
    camera.minZ = 0.1;
    camera.maxZ = 100_000;
    rig = { engine, scene, camera };
    engines.set(key, rig);
  }
  return rig;
}
afterAll(() => {
  for (const { engine, scene } of engines.values()) {
    scene.dispose();
    engine.dispose();
  }
});

interface View {
  readonly hud: HudCamera;
  readonly frame: PitchLadderFrame;
  readonly forward: Vector3;
  readonly up: Vector3;
  readonly pitch: number;
  readonly bank: number;
  /** Where a world DIRECTION is drawn, px from the screen's centre, by Babylon's own projection; null behind. */
  project(direction: Vector3): { x: number; y: number } | null;
}

/**
 * The aircraft at an attitude, seen through the renderer's chase or cockpit rig as
 * `FlightRenderer.updateCamera` settles it (the smoothing converged, no trail:
 * neither moves the view direction), and the ladder drawn through that camera.
 */
function look(
  kind: AircraftKind,
  mode: "chase" | "cockpit",
  attitude: { heading?: number; pitch: number; bank: number; airspeed?: number },
  width = 1920,
  height = 1080,
): View {
  const { state } = flyAt(attitude.heading ?? 37, attitude.pitch, attitude.bank, { altitude: 2_000 });
  const q = new Quaternion(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w).normalize();
  const body = new Matrix();
  Matrix.FromQuaternionToRef(q, body);
  // `FlightRenderer.updatePresentation`: body +X (nose) and +Y (roof) into the world.
  const forward = Vector3.TransformNormal(Vector3.Right(), body).normalize();
  const up = Vector3.TransformNormal(Vector3.Up(), body).normalize();
  const { camera } = rigFor(width, height);
  const aircraft = new Vector3(0, 0, 0);
  const target = new Vector3();
  if (mode === "cockpit") {
    const eye = aircraftSpec(kind).cockpitEye;
    cockpitRigPositionsToRef(aircraft, forward, up, eye, eye.right, COCKPIT_AIM_DISTANCE_METERS, camera.position, target);
    camera.upVector.copyFrom(up);
    camera.fov = cockpitHorizontalFieldOfViewForAspect(null, width / height) * DEG;
  } else {
    const profile = chaseCameraProfile(kind, attitude.airspeed ?? aircraftSpec(kind).spawn.airborneAirspeed);
    const follow = cameraBankFollow("chase", false);
    const lift = { x: 0, y: 0, z: 0 };
    cameraRigLiftToRef(forward, up, follow, lift);
    const offset = { x: 0, y: 0, z: 0 };
    const aim = { x: 0, y: 0, z: 0 };
    chaseRigOffsetsToRef(
      forward, lift, profile.distance, chaseRigHeightForBank(profile.height, forward, up),
      profile.aimAhead, CHASE_AIM_HEIGHT_METERS, 0, offset, aim,
    );
    camera.position.set(offset.x, offset.y, offset.z);
    target.set(aim.x, aim.y, aim.z);
    camera.upVector.copyFrom(Vector3.Lerp(Vector3.Up(), up, follow).normalize());
    camera.fov = profile.fieldOfView * DEG;
  }
  camera.setTarget(target);
  const view = camera.getViewMatrix(true);
  const projection = camera.getProjectionMatrix(true);
  const viewProjection = view.multiply(projection);
  const hud = createHudCamera();
  hud.transform = Float32Array.from(viewProjection.m);
  hud.width = width;
  hud.height = height;
  Object.assign(hud.forward, { x: forward.x, y: forward.y, z: forward.z });
  Object.assign(hud.up, { x: up.x, y: up.y, z: up.z });
  const frame = pitchLadderToRef(hud, createPitchLadderFrame());
  const viewport = new Viewport(0, 0, width, height);
  const eye = camera.position.clone();
  const lookDirection = target.subtract(eye).normalize();
  return {
    hud, frame, forward, up, pitch: state.pitch, bank: state.bank,
    project(direction) {
      if (Vector3.Dot(direction, lookDirection) <= 1e-6) return null;
      const point = Vector3.Project(eye.add(direction.normalizeToNew().scale(1_000)), Matrix.IdentityReadOnly, viewProjection, viewport);
      return { x: point.x - width / 2, y: point.y - height / 2 };
    },
  };
}

/** The rung for `pitch`, in SCREEN px from the centre. */
function rungOf(view: View, pitch: number) {
  const rung = view.frame.rungs[PITCH_LADDER_PITCHES.indexOf(pitch)]!;
  return { ...rung, x: rung.x + view.frame.windowX, y: rung.y + view.frame.windowY };
}

/** Distance of a screen point from the line through `rung` along its angle. */
function offLine(rung: { x: number; y: number; angle: number }, point: { x: number; y: number }): number {
  return Math.abs((point.x - rung.x) * Math.sin(rung.angle) - (point.y - rung.y) * Math.cos(rung.angle));
}

/** A direction `elevation` degrees above the horizon, `azimuth` degrees right of the nose's. */
function skyDirection(view: View, elevation: number, azimuth: number): Vector3 {
  const north = new Vector3(view.forward.x, 0, view.forward.z).normalize();
  const right = Vector3.Cross(Vector3.Up(), north).normalize();
  const along = north.scale(Math.cos(azimuth * DEG)).add(right.scale(Math.sin(azimuth * DEG)));
  return along.scale(Math.cos(elevation * DEG)).add(Vector3.Up().scale(Math.sin(elevation * DEG)));
}

const MODES = ["chase", "cockpit"] as const;
const ATTITUDES = [
  { pitch: 0, bank: 0 },
  { pitch: 7, bank: 0 },
  { pitch: -12, bank: 25 },
  { pitch: 18, bank: -50 },
  { pitch: 3, bank: 75 },
  { pitch: -4, bank: -120 },
] as const;

describe("the pitch ladder, through the camera that drew the frame", () => {
  it("puts the aircraft symbol where the nose points: dead centre in the cockpit", () => {
    for (const kind of AIRCRAFT_KINDS) {
      for (const mode of MODES) {
        for (const attitude of ATTITUDES) {
          const view = look(kind, mode, attitude);
          const nose = view.project(view.forward)!;
          expect(view.frame.visible).toBe(true);
          expect(view.frame.noseX, `${kind} ${mode}`).toBeCloseTo(nose.x, 2);
          expect(view.frame.noseY, `${kind} ${mode}`).toBeCloseTo(nose.y, 2);
          if (mode === "cockpit") {
            expect(Math.hypot(view.frame.noseX, view.frame.noseY)).toBeLessThan(1e-3);
            // The camera is the body: the symbol stays level on the screen.
            expect(Math.abs(Math.sin(view.frame.wingAngle))).toBeLessThan(1e-4);
          }
        }
      }
    }
  });

  it("lays the zero line on the horizon the camera sees, at any bank", () => {
    for (const kind of AIRCRAFT_KINDS) {
      for (const mode of MODES) {
        for (const attitude of ATTITUDES) {
          const view = look(kind, mode, attitude);
          const horizon = rungOf(view, 0);
          // Shown exactly when it crosses the window.
          const window = { x: view.frame.windowX, y: view.frame.windowY };
          const halfDiagonal = Math.hypot(PITCH_LADDER_WINDOW.width, PITCH_LADDER_WINDOW.height) / 2;
          expect(horizon.visible, `${kind} ${mode} ${JSON.stringify(attitude)}`).toBe(offLine(horizon, window) <= halfDiagonal);
          let checked = 0;
          for (const azimuth of [-40, -20, -8, 0, 8, 20, 40]) {
            const seen = view.project(skyDirection(view, 0, azimuth));
            if (!seen) continue;
            expect(offLine(horizon, seen), `${kind} ${mode} ${JSON.stringify(attitude)} az ${azimuth}`).toBeLessThan(0.05);
            checked += 1;
          }
          expect(checked).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  it("puts every rung at its own pitch, so the nose sits ON the rung for the pitch it is at", () => {
    for (const kind of AIRCRAFT_KINDS) {
      for (const mode of MODES) {
        for (const pitch of [-60, -25, -10, -5, 5, 10, 15, 30, 45, 70, 85]) {
          for (const bank of [0, 35, -70, 180]) {
            const view = look(kind, mode, { pitch, bank });
            const label = `${kind} ${mode} pitch ${pitch} bank ${bank}`;
            expect(view.pitch, label).toBeCloseTo(pitch, 3);
            const rung = rungOf(view, pitch);
            expect(rung.visible, label).toBe(true);
            expect(rung.x, label).toBeCloseTo(view.frame.noseX, 1);
            expect(rung.y, label).toBeCloseTo(view.frame.noseY, 1);
            // ...and every other rung in sight is where that pitch is.
            for (const other of PITCH_LADDER_PITCHES) {
              const drawn = rungOf(view, other);
              if (!drawn.visible || Math.abs(other) === 90) continue;
              const seen = view.project(skyDirection(view, other, 0))!;
              expect(Math.hypot(drawn.x - seen.x, drawn.y - seen.y), `${label} rung ${other}`).toBeLessThan(0.02);
            }
          }
        }
      }
    }
  });

  it("spaces the rungs by the lens: 5 degrees is ~109 px in a 1080p cockpit, not the old 11", () => {
    const view = look("jet", "cockpit", { pitch: 0, bank: 0 });
    const focal = 960 / Math.tan((cockpitHorizontalFieldOfViewForAspect(null, 1920 / 1080) / 2) * DEG);
    expect(rungOf(view, 5).y).toBeCloseTo(-focal * Math.tan(5 * DEG), 1);
    expect(rungOf(view, -5).y).toBeCloseTo(focal * Math.tan(5 * DEG), 1);
    expect(rungOf(view, 10).y).toBeCloseTo(-focal * Math.tan(10 * DEG), 1);
    expect(-rungOf(view, 5).y).toBeGreaterThan(105);
  });

  it("in the cockpit draws every rung parallel to the horizon, turned by minus the bank", () => {
    // The PFD's convention (tests/render.cockpit-display-pages.test.ts): in a right
    // bank the horizon's right end rises.
    for (const bank of [-60, -20, 0, 20, 60]) {
      for (const pitch of [-15, 0, 12]) {
        const view = look("jet", "cockpit", { pitch, bank });
        for (const rung of view.frame.rungs) {
          if (!rung.visible) continue;
          expect(Math.sin(rung.angle - -bank * DEG), `bank ${bank} pitch ${pitch} rung ${rung.pitch}`).toBeCloseTo(0, 3);
          expect(Math.cos(rung.angle - -bank * DEG)).toBeGreaterThan(0);
        }
      }
    }
  });

  it("in the chase view finds the horizon well above the screen's centre, where the old ladder never looked", () => {
    // The chase cameras look down on the aeroplane: in level flight the real
    // horizon is 157 px above the centre on a 1080p screen for the F-16 at its
    // airborne start (125 at 300 m/s), 205 for the trainer, 217 for the Global and
    // 316 for the 747, which is where the old zero line should have been and was not.
    for (const kind of AIRCRAFT_KINDS) {
      const view = look(kind, "chase", { pitch: 0, bank: 0 });
      expect(rungOf(view, 0).y, kind).toBeLessThan(-120);
      expect(view.frame.noseY, kind).toBeCloseTo(rungOf(view, 0).y, 1);
    }
  });

  it("in a chase-view bank tilts the rungs with the camera and the symbol with the wings", () => {
    // The chase camera rolls with 18% of the bank, so the world's horizon in the
    // picture does too; the aeroplane's wings take the rest.
    for (const bank of [-60, -30, 30, 60]) {
      const view = look("jet", "chase", { pitch: 2, bank });
      const horizon = rungOf(view, 0);
      const tilt = Math.atan2(Math.sin(horizon.angle), Math.cos(horizon.angle)) / DEG;
      expect(Math.sign(tilt)).toBe(-Math.sign(bank));
      expect(Math.abs(tilt)).toBeLessThan(0.25 * Math.abs(bank));
      const wings = Math.atan2(Math.sin(view.frame.wingAngle - horizon.angle), Math.cos(view.frame.wingAngle - horizon.angle)) / DEG;
      // Relative to the horizon the symbol shows the bank itself (60.0 at 60).
      expect(Math.abs(wings - bank)).toBeLessThan(0.5);
    }
  });

  it("holds through the vertical and upside down", () => {
    for (const mode of MODES) {
      for (const pitch of [88, 89.9, 90, -89.9, -90]) {
        for (const bank of [0, 180]) {
          const view = look("jet", mode, { pitch, bank });
          const label = `${mode} pitch ${pitch} bank ${bank}`;
          expect(view.frame.visible, label).toBe(true);
          const zenith = rungOf(view, pitch > 0 ? 90 : -90);
          expect(zenith.visible, label).toBe(true);
          const seen = view.project(new Vector3(0, Math.sign(pitch), 0))!;
          expect(Math.hypot(zenith.x - seen.x, zenith.y - seen.y), label).toBeLessThan(0.05);
          for (const rung of view.frame.rungs) {
            if (!rung.visible) continue;
            expect(Number.isFinite(rung.x) && Number.isFinite(rung.y) && Number.isFinite(rung.angle), label).toBe(true);
          }
        }
      }
    }
    // Inverted and level: the ladder is upside down in the cockpit, as the world is.
    const inverted = look("jet", "cockpit", { pitch: 0, bank: 180 });
    expect(Math.cos(rungOf(inverted, 0).angle)).toBeLessThan(-0.999);
    expect(rungOf(inverted, 10).y).toBeGreaterThan(100);
  });

  it("is right on every window shape and lens, and keeps its window on the screen", () => {
    for (const [width, height] of SHAPES) {
      for (const kind of AIRCRAFT_KINDS) {
        for (const mode of MODES) {
          const view = look(kind, mode, { pitch: 10, bank: 20 }, width, height);
          const label = `${width}x${height} ${kind} ${mode}`;
          const nose = view.project(view.forward)!;
          expect(view.frame.noseX, label).toBeCloseTo(nose.x, 2);
          expect(view.frame.noseY, label).toBeCloseTo(nose.y, 2);
          expect(rungOf(view, 10).x, label).toBeCloseTo(view.frame.noseX, 1);
          expect(rungOf(view, 10).y, label).toBeCloseTo(view.frame.noseY, 1);
          for (const azimuth of [-10, 10]) {
            const seen = view.project(skyDirection(view, 0, azimuth));
            if (seen && rungOf(view, 0).visible) expect(offLine(rungOf(view, 0), seen), label).toBeLessThan(0.05);
          }
          // The window stays clear of the tapes and the top line...
          const halfWidth = PITCH_LADDER_WINDOW.width / 2;
          const halfHeight = PITCH_LADDER_WINDOW.height / 2;
          expect(Math.abs(view.frame.windowX) + halfWidth, label).toBeLessThanOrEqual(width / 2 - PITCH_LADDER_SIDE_MARGIN + 1e-9);
          expect(Math.abs(view.frame.windowY) + halfHeight, label).toBeLessThanOrEqual(height / 2 - PITCH_LADDER_TOP_MARGIN + 1e-9);
          // ...and the symbol stays in it.
          expect(Math.abs(view.frame.noseY - view.frame.windowY), label).toBeLessThan(halfHeight - 10);
          if (mode === "cockpit") expect(Math.hypot(view.frame.windowX, view.frame.windowY), label).toBeLessThan(1e-3);
        }
      }
    }
  });

  it("draws nothing when the nose is not ahead of the camera", () => {
    const view = look("jet", "chase", { pitch: 0, bank: 0 });
    const backwards = createHudCamera();
    Object.assign(backwards, { transform: view.hud.transform, width: 1920, height: 1080 });
    Object.assign(backwards.forward, { x: -view.forward.x, y: -view.forward.y, z: -view.forward.z });
    Object.assign(backwards.up, view.up);
    const frame = pitchLadderToRef(backwards, createPitchLadderFrame());
    expect(frame.visible).toBe(false);
    expect(frame.rungs.some((rung) => rung.visible)).toBe(false);
    expect(pitchLadderToRef({ ...view.hud, width: 0 }, createPitchLadderFrame()).visible).toBe(false);
  });
});

describe("the ladder's markup and its per-frame writer", () => {
  function renderHud(cameraMode: CameraMode): string {
    return renderToStaticMarkup(createElement(Hud, {
      state: INITIAL_VISUAL_STATE, aircraft: "jet", mode: "full", flightMode: "unassisted", units: "aviation",
      diagnostics: null, showDiagnostics: false, cameraMode, cameraLabel: "CAM", seedLabel: "AUD1T0", mouseFlight: false,
    }));
  }

  it("draws a line for every pitch in the views that look along the nose, and none in the others", () => {
    for (const mode of ["chase", "cockpit", "freefly"] as const) {
      const markup = renderHud(mode);
      expect(markup, mode).toContain('class="pitch-ladder" hidden=""');
      for (const pitch of PITCH_LADDER_PITCHES) expect(markup).toContain(`data-pitch="${pitch}"`);
      // Numbered every 10 degrees, on both ends.
      expect(markup.match(/<text /g)).toHaveLength(2 * 16);
      expect(markup).toContain(">-10</text>");
      expect(markup).toContain(">80</text>");
      expect(markup).toContain("attitude__aircraft");
    }
    for (const mode of ["cinematic", "top", "front"] as const) {
      const markup = renderHud(mode);
      expect(markup, mode).not.toContain("pitch-ladder");
      expect(markup, mode).not.toContain("attitude__aircraft");
      expect(markup, mode).toContain("attitude__heading");
    }
  });

  it("writes only what changed, and hides the ladder when there is nothing to draw", () => {
    const writes: string[] = [];
    const element = (name: string) => ({
      style: { set transform(value: string) { writes.push(`${name} ${value}`); } },
      setAttribute: (attribute: string, value: string) => writes.push(`${name} ${attribute}=${value}`),
    });
    const lines = new Map(PITCH_LADDER_PITCHES.map((pitch) => [String(pitch), element(`line ${pitch}`)]));
    const root = {
      hidden: true,
      querySelector: (selector: string) => {
        if (selector === "[data-pitch-ladder-window]") return element("window");
        if (selector === "[data-pitch-ladder-aircraft]") return element("aircraft");
        return lines.get(/data-pitch="(-?\d+)"/.exec(selector)![1]!) ?? null;
      },
    } as unknown as HTMLElement;
    const ladderView = createPitchLadderView(root);
    const view = look("jet", "cockpit", { pitch: 3, bank: 10 });
    applyPitchLadder(ladderView, view.frame);
    expect(root.hidden).toBe(false);
    const shown = view.frame.rungs.filter((rung) => rung.visible).map((rung) => rung.pitch);
    expect(shown).toEqual(expect.arrayContaining([0, 5]));
    expect(writes.filter((write) => write.endsWith("display=inline"))).toHaveLength(shown.length);
    expect(writes.some((write) => write.startsWith("window translate3d("))).toBe(true);
    expect(writes.some((write) => write.startsWith("aircraft translate(-50%, -50%) translate3d("))).toBe(true);
    // The same frame again, and a wobble well under the quarter pixel it snaps to: nothing.
    writes.length = 0;
    applyPitchLadder(ladderView, view.frame);
    view.frame.rungs[PITCH_LADDER_PITCHES.indexOf(0)]!.x += 0.01;
    applyPitchLadder(ladderView, view.frame);
    expect(writes).toEqual([]);
    applyPitchLadder(ladderView, null);
    expect(root.hidden).toBe(true);
  });

  it("is placed after each frame is drawn, through that frame's camera and body axes", () => {
    const game = readFileSync(new URL("../src/game/FlightGame.tsx", import.meta.url), "utf8");
    const loop = game.slice(game.indexOf("const renderLoop = (now: number) => {"));
    const drawn = loop.indexOf("renderer.render(frameState, deltaSeconds);");
    const placed = loop.indexOf("renderer.readHudCameraToRef(hudCamera) ? pitchLadderToRef(hudCamera, pitchLadderFrame) : null");
    expect(drawn).toBeGreaterThan(-1);
    expect(placed).toBeGreaterThan(drawn);
    expect(placed).toBeLessThan(loop.indexOf("animationFrame = requestAnimationFrame(renderLoop);"));
    const renderer = readFileSync(new URL("../src/render/FlightRenderer.ts", import.meta.url), "utf8");
    const read = renderer.slice(renderer.indexOf("readHudCameraToRef(result: HudCamera): boolean {"));
    const body = read.slice(0, read.indexOf("\n  }\n"));
    expect(body).toContain("result.transform = this.camera.getTransformationMatrix().m;");
    expect(body).toContain("result.forward.x = this.forward.x;");
    expect(body).toContain("result.up.z = this.up.z;");
    expect(body).toContain("canvas.clientWidth");
  });
});
