import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GroundCoverRenderer } from "../src/render/GroundCoverRenderer";

describe("bounded procedural ground cover", () => {
  it("builds deterministic grass and herb silhouettes within a fixed instance budget", () => {
    const renderer = new GroundCoverRenderer(
      81_291,
      "medium",
      () => ({ height: 125, slope: 0.03 }),
      () => false,
    );
    renderer.update(0, 0, 0, 0);

    const grass = renderer.group.getObjectByName("instanced-grass-patches") as
      | THREE.InstancedMesh
      | undefined;
    const herbs = renderer.group.getObjectByName("instanced-low-herbs") as
      | THREE.InstancedMesh
      | undefined;
    expect(renderer.group.name).toBe("procedural-ground-cover");
    expect(grass?.count).toBeGreaterThan(3_000);
    expect(grass?.count).toBeLessThanOrEqual(4_200);
    expect(herbs?.count).toBeGreaterThan(400);
    expect(herbs?.count).toBeLessThanOrEqual(700);
    expect(grass?.geometry.getAttribute("color").count).toBe(51);
    expect(grass?.geometry.boundingSphere?.radius).toBeGreaterThan(2);
    expect(grass?.castShadow).toBe(false);
    expect(grass?.receiveShadow).toBe(true);

    const firstTransform = Array.from(grass!.instanceMatrix.array.slice(0, 16));
    renderer.invalidate();
    renderer.update(0, 0, 0, 0);
    expect(Array.from(grass!.instanceMatrix.array.slice(0, 16))).toEqual(firstTransform);
    renderer.dispose();
  });

  it("omits steep, submerged, and explicitly cleared surfaces", () => {
    const cleared = new GroundCoverRenderer(
      782,
      "high",
      () => ({ height: 80, slope: 0.02 }),
      () => true,
    );
    cleared.update(0, 0, 0, 0);
    expect((cleared.group.getObjectByName("instanced-grass-patches") as THREE.InstancedMesh).count)
      .toBe(0);
    cleared.dispose();

    const steep = new GroundCoverRenderer(
      782,
      "medium",
      () => ({ height: 80, slope: 0.5 }),
      () => false,
    );
    steep.update(0, 0, 0, 0);
    expect((steep.group.getObjectByName("instanced-grass-patches") as THREE.InstancedMesh).count)
      .toBe(0);
    steep.dispose();
  });
});
