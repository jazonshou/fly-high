import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SkySystem } from "../src/render/SkySystem";

describe("sky lighting and cloud presentation", () => {
  it("enables supported, quality-scaled shadows for the default medium preset", () => {
    const sky = new SkySystem(17);
    sky.setQuality("medium");
    expect(sky.sunLight.castShadow).toBe(true);
    expect(sky.sunLight.shadow.mapSize.x).toBe(1_024);

    sky.setQuality("high");
    expect(sky.sunLight.castShadow).toBe(true);
    expect(sky.sunLight.shadow.mapSize.x).toBe(2_048);

    sky.setQuality("low");
    expect(sky.sunLight.castShadow).toBe(false);
    sky.dispose();
  });

  it("keeps clouds at a world altitude instead of attaching them to the camera", () => {
    const sky = new SkySystem(23);
    const clouds = sky.group.children.find(
      (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
    );
    expect(clouds).toBeDefined();
    const matrix = new THREE.Matrix4();
    const firstPosition = new THREE.Vector3();
    const secondPosition = new THREE.Vector3();

    sky.update(new THREE.Vector3(0, 700, 0), 0, 0, 0);
    clouds!.getMatrixAt(0, matrix);
    firstPosition.setFromMatrixPosition(matrix);
    sky.update(new THREE.Vector3(0, 5_700, 0), 0, 0, 0);
    clouds!.getMatrixAt(0, matrix);
    secondPosition.setFromMatrixPosition(matrix);

    expect(secondPosition.y).toBeCloseTo(firstPosition.y, 6);
    expect(firstPosition.y).toBeGreaterThanOrEqual(1_650);
    expect(firstPosition.y).toBeLessThanOrEqual(3_500);
    sky.dispose();
  });
});
