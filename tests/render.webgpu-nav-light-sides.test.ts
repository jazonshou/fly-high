import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";

/**
 * `D-6`: red to port, green to starboard -- asserted against the SCENE BASIS.
 *
 * **This test deliberately does not read `bodyAxes`.** That declaration says
 * `port: "+z"` and it is the thing that was wrong; a test that consulted it
 * would agree with the bug and pass while the lights were reversed. It is left
 * uncorrected on purpose -- migrating it is a contract change that belongs with
 * physics, telemetry and cameras together (see `src/input/index.ts:38-49`), and
 * the roll inversion there compensates for that contract rather than for these
 * lamps.
 *
 * So starboard is DERIVED, by the one construction that cannot beg the
 * question. `FlightRenderer` maps body +X to forward and +Y to up
 * (`FlightRenderer.ts:1856-1857`) in a right-handed scene. Point a camera along
 * forward with that up, and ask Babylon which way is screen-right. **For a
 * forward-looking camera, screen-right IS the pilot's right, by definition** --
 * where "right = forward x up" versus "up x forward" is a convention, and
 * assuming either would be assuming the answer.
 *
 * Why this is worth a test rather than a fix alone: the reversal shipped, and
 * it is invisible by day. Red on the right wing and green on the left is the
 * exact inversion an observer uses to infer an aircraft's heading, so it is
 * wrong in the one condition the whole feature exists for.
 */

function rightHandedScene(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine({
    renderWidth: 64, renderHeight: 64, textureSize: 64,
    deterministicLockstep: false, lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  return { engine, scene };
}

/** The world direction of the pilot's right, read from Babylon's own camera. */
function starboardDirection(scene: Scene): Vector3 {
  const forward = new Vector3(1, 0, 0);   // FlightRenderer.ts:1856 — Vector3.Right()
  const up = new Vector3(0, 1, 0);        // FlightRenderer.ts:1857 — Vector3.Up()
  const camera = new UniversalCamera("basis-probe", Vector3.Zero(), scene);
  camera.upVector = up;
  camera.setTarget(forward);
  scene.activeCamera = camera;
  camera.getViewMatrix(true);
  return camera.getDirection(new Vector3(1, 0, 0)).normalize();
}

describe("navigation light sides (D-6)", () => {
  it("derives starboard from the scene basis, not from the declared metadata", () => {
    const { engine, scene } = rightHandedScene();
    try {
      const starboard = starboardDirection(scene);
      // The basis is axis-aligned, so exactly one component carries it.
      expect(Math.abs(starboard.y)).toBeLessThan(1e-3);
      expect(Math.abs(starboard.x)).toBeLessThan(1e-2);
      expect(Math.abs(starboard.z)).toBeGreaterThan(0.99);
      // Recorded so a Babylon change that flipped the convention fails HERE,
      // loudly, rather than silently reversing the assertions below.
      expect(Math.sign(starboard.z)).toBe(1);
    } finally {
      engine.dispose();
    }
  });

  for (const variant of ["trainer", "jet"] as const) {
    it(`puts red to port and green to starboard on the ${variant}`, () => {
      const { engine, scene } = rightHandedScene();
      try {
        const starboardZ = Math.sign(starboardDirection(scene).z);
        createWebGpuAircraft(scene, variant);

        const port = scene.getMeshByName("port-navigation-light");
        const starboard = scene.getMeshByName("starboard-navigation-light");
        expect(port, `${variant} has no port-navigation-light`).toBeTruthy();
        expect(starboard, `${variant} has no starboard-navigation-light`).toBeTruthy();

        // Side is the SIGN along the derived starboard axis, not a pinned
        // coordinate: the lamps may move along the wing without this test
        // caring, and a mirrored airframe would still be checked correctly.
        expect(
          Math.sign(starboard!.position.z),
          `${variant}: the GREEN starboard lamp must sit on the starboard side`,
        ).toBe(starboardZ);
        expect(
          Math.sign(port!.position.z),
          `${variant}: the RED port lamp must sit on the port side`,
        ).toBe(-starboardZ);

        // Assert the COLOUR, not just the mesh name. Names are the thing a
        // future edit could keep while swapping the materials -- and "red to
        // port" is a claim about light, not about identifiers. Read the
        // emissive off the material the mesh actually carries.
        const emissive = (m: typeof port) => {
          const mat = m!.material as { emissiveColor?: { r: number; g: number; b: number } } | null;
          const e = mat?.emissiveColor;
          expect(e, `${variant}: lamp ${m!.name} has no emissive colour`).toBeTruthy();
          return e!;
        };
        const portEmissive = emissive(port);
        const starboardEmissive = emissive(starboard);
        expect(
          portEmissive.r > portEmissive.g && portEmissive.r > portEmissive.b,
          `${variant}: the port lamp must be RED (got r=${portEmissive.r.toFixed(3)} `
          + `g=${portEmissive.g.toFixed(3)} b=${portEmissive.b.toFixed(3)})`,
        ).toBe(true);
        expect(
          starboardEmissive.g > starboardEmissive.r && starboardEmissive.g > starboardEmissive.b,
          `${variant}: the starboard lamp must be GREEN (got r=${starboardEmissive.r.toFixed(3)} `
          + `g=${starboardEmissive.g.toFixed(3)} b=${starboardEmissive.b.toFixed(3)})`,
        ).toBe(true);

        // They must actually be on opposite sides — two lamps that agreed in
        // sign would satisfy neither aviation nor a reader, and a single
        // sign assertion cannot see that on its own.
        expect(Math.sign(port!.position.z)).not.toBe(Math.sign(starboard!.position.z));
      } finally {
        engine.dispose();
      }
    });
  }
});
