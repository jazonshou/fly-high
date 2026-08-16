import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AirportDefinition } from "@/src/world";

/** Small authored-detail island around the deterministic starter airport. */
export class AirportSystem {
  readonly root: TransformNode;
  readonly shadowCasters: readonly Mesh[];
  private readonly materials: PBRMaterial[] = [];

  constructor(scene: Scene, private readonly definition: Readonly<AirportDefinition>) {
    this.root = new TransformNode("airport", scene);
    this.root.rotation.y = definition.headingRadians;

    const asphalt = this.material(scene, "runway-asphalt", new Color3(0.045, 0.052, 0.055), 0.9);
    const paint = this.material(scene, "runway-paint", new Color3(0.82, 0.82, 0.76), 0.62);
    const concrete = this.material(scene, "airport-concrete", new Color3(0.26, 0.27, 0.25), 0.84);
    const metal = this.material(scene, "hangar-metal", new Color3(0.20, 0.25, 0.27), 0.48, 0.42);

    const runway = CreateBox("runway", {
      width: definition.runwayWidth,
      height: 0.16,
      depth: definition.runwayLength,
    }, scene);
    runway.position.y = 0.08;
    runway.material = asphalt;
    runway.parent = this.root;
    runway.receiveShadows = true;

    const markings: Mesh[] = [];
    const stripeCount = Math.floor(definition.runwayLength / 180);
    for (let index = -stripeCount; index <= stripeCount; index += 1) {
      if (index === 0) continue;
      const stripe = CreateBox(`runway-centre-${index}`, {
        width: 0.9,
        height: 0.025,
        depth: 28,
      }, scene);
      stripe.position.set(0, 0.175, index * 90);
      stripe.material = paint;
      stripe.parent = this.root;
      markings.push(stripe);
    }
    for (const end of [-1, 1]) {
      for (let stripeIndex = -4; stripeIndex <= 4; stripeIndex += 1) {
        const threshold = CreateBox(`threshold-${end}-${stripeIndex}`, {
          width: 2.4,
          height: 0.026,
          depth: 32,
        }, scene);
        threshold.position.set(stripeIndex * 4.2, 0.176, end * (definition.runwayLength * 0.5 - 48));
        threshold.material = paint;
        threshold.parent = this.root;
        markings.push(threshold);
      }
    }

    const apron = CreateBox("airport-apron", {
      width: 150,
      height: 0.14,
      depth: 210,
    }, scene);
    apron.position.set(definition.runwayWidth * 0.5 + 98, 0.07, -definition.runwayLength * 0.12);
    apron.material = concrete;
    apron.parent = this.root;
    apron.receiveShadows = true;

    const hangars: Mesh[] = [];
    for (let index = 0; index < 3; index += 1) {
      const hangar = CreateBox(`airport-hangar-${index}`, {
        width: 46,
        height: 14 + index * 2,
        depth: 34,
      }, scene);
      hangar.position.set(definition.runwayWidth * 0.5 + 118, 7 + index, -definition.runwayLength * 0.12 + (index - 1) * 52);
      hangar.material = metal;
      hangar.parent = this.root;
      hangars.push(hangar);
    }
    this.shadowCasters = Object.freeze([runway, apron, ...hangars]);
  }

  setFloatingOrigin(x: number, z: number): void {
    this.root.position.set(
      this.definition.centerX - x,
      this.definition.elevation,
      this.definition.centerZ - z,
    );
  }

  dispose(): void {
    this.root.dispose(false, false);
    for (const material of this.materials) material.dispose(true, true);
  }

  private material(
    scene: Scene,
    name: string,
    color: Color3,
    roughness: number,
    metallic = 0,
  ): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = color;
    material.roughness = roughness;
    material.metallic = metallic;
    material.environmentIntensity = 0.62;
    this.materials.push(material);
    return material;
  }
}
