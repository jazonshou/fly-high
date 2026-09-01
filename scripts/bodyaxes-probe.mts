/**
 * Which side is body +Z: port or starboard?
 *
 * Settled with BABYLON's own right-handed camera rather than a hand-derived
 * cross-product convention, because "right = forward x up" versus
 * "right = up x forward" is itself a convention and assuming one would beg the
 * question. A camera looking along the body's forward axis with the body's up
 * axis as its up has a screen-right direction, and "starboard" means exactly
 * "the pilot's right" -- so screen-right IS starboard, by definition and not by
 * convention.
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

const engine = new NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64,
  deterministicLockstep: false, lockstepMaxSteps: 4 });
const scene = new Scene(engine);
scene.useRightHandedSystem = true;   // FlightRenderer.ts:667, asserted at createAircraft.ts:52

// FlightRenderer.ts:1856-1857: body +X -> world forward, body +Y -> world up.
const FORWARD = new Vector3(1, 0, 0);
const UP = new Vector3(0, 1, 0);

const cam = new UniversalCamera("probe", Vector3.Zero(), scene);
cam.upVector = UP;
cam.setTarget(FORWARD);
scene.activeCamera = cam;
cam.getViewMatrix(true);

const screenRight = cam.getDirection(new Vector3(1, 0, 0)).normalize();
const screenUp = cam.getDirection(new Vector3(0, 1, 0)).normalize();
const screenFwd = cam.getDirection(new Vector3(0, 0, 1)).normalize();

const f = (v: Vector3) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
console.log(`camera looks along body forward ${f(FORWARD)}, up ${f(UP)}`);
console.log(`  screen-right  -> ${f(screenRight)}`);
console.log(`  screen-up     -> ${f(screenUp)}`);
console.log(`  screen-fwd(+z)-> ${f(screenFwd)}`);
const starboardIsPlusZ = screenRight.z > 0.5;
console.log(`\nSTARBOARD (pilot's right) = ${starboardIsPlusZ ? "+Z" : "-Z"}`);
console.log(`PORT                      = ${starboardIsPlusZ ? "-Z" : "+Z"}`);
console.log(`\ncreateAircraft.ts declares  bodyAxes.port = "+z"`);
console.log(`red  port-navigation-light      at z = +5.43`);
console.log(`green starboard-navigation-light at z = -5.43`);
console.log(starboardIsPlusZ
  ? "\n=> METADATA IS WRONG. The RED light sits on the STARBOARD side.\n   input/index.ts's observation is correct and its roll inversion is a workaround."
  : "\n=> METADATA IS RIGHT. input/index.ts's claim is wrong.");
engine.dispose();
