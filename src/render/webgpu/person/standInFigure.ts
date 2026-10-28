import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateCylinderVertexData } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure";
import { CreateSphereVertexData } from "@babylonjs/core/Meshes/Builders/sphereBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { PERSON } from "@/src/vehicles/person";
import { AircraftBuildContext } from "../aircraft/builders";
import type { PersonAnimationInput, PersonAnimationOutput, PersonVisual } from "./types";

/**
 * A STAND-IN figure, so the walking session, its camera and the car's
 * boarding can be built and seen before the real one (the figure and motion
 * build, W2) lands in this directory and replaces it: a body column and a
 * head at the spec's stature, one draw, with a nose so its facing reads. It
 * leans into its speed and does not animate a gait.
 */
export function createStandInPersonVisual(scene: Scene): PersonVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("person-root", scene);
  root.rotationQuaternion = Quaternion.Identity();
  const lean = new TransformNode("person-lean", scene);
  lean.parent = root;
  lean.rotationQuaternion = Quaternion.Identity();

  const stature = PERSON.stature;
  const headRadius = 0.115;
  const bodyHeight = stature - 2 * headRadius;
  const merged = place(CreateCylinderVertexData({ height: bodyHeight, diameterTop: 0.36, diameterBottom: 0.3, tessellation: 12 }), 0, bodyHeight / 2, 0);
  merged.merge([
    place(CreateSphereVertexData({ diameter: headRadius * 2, segments: 8 }), 0, stature - headRadius, 0),
    place(CreateSphereVertexData({ diameter: 0.06, segments: 4 }), headRadius, stature - headRadius, 0),
  ], true);
  const body = new Mesh("person-stand-in", scene);
  merged.applyToMesh(body, false);
  body.material = build.material("person-stand-in", 0x5d6f7e, { roughness: 0.8, metallic: 0 });
  body.parent = lean;
  body.isPickable = false;
  body.receiveShadows = true;
  body.metadata = { personVisual: true, castsShadow: true };
  const meshes = [body];
  const output: PersonAnimationOutput = { footStrikes: 0, strikeStrength: 0, strikeFoot: "left" };
  let visible = true;
  let firstPerson = false;

  return {
    root,
    meshes,
    update(input: PersonAnimationInput): PersonAnimationOutput {
      const person = input.person;
      const swimming = person.mode === "swim" || person.mode === "dive";
      const seated = person.mode === "seated";
      // Lean forward with speed, or lie prone in the water.
      const pitch = swimming ? -(Math.PI / 2 + person.swimPitch) : seated ? 0 : -Math.min(0.25, person.speed * 0.04);
      Quaternion.RotationAxisToRef(AXIS_Z, pitch, lean.rotationQuaternion!);
      lean.position.y = swimming ? stature * 0.62 : seated ? -0.45 : 0;
      output.footStrikes = 0;
      return output;
    },
    setFirstPersonView(enabled: boolean): void {
      firstPerson = enabled;
      body.isVisible = visible && !firstPerson;
    },
    setFade(amount: number): void {
      body.visibility = 1 - Math.min(1, Math.max(0, amount));
    },
    setVisible(enabled: boolean): void {
      visible = enabled;
      body.isVisible = visible && !firstPerson;
    },
    dispose(): void {
      body.dispose(false, false);
      lean.dispose(false, false);
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}

const AXIS_Z = new Vector3(0, 0, 1);

function place(data: VertexData, x: number, y: number, z: number): VertexData {
  data.transform(Matrix.Translation(x, y, z));
  return data;
}
