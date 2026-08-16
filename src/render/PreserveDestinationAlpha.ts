import * as THREE from "three";

/**
 * Keep a render target's existing alpha channel while retaining Three's normal
 * source-over RGB blend. The hybrid frame graph stores the water material tag
 * in beauty alpha, so later transparent scene draws must not blend their visual
 * opacity into that channel.
 */
export function preserveDestinationAlpha(material: THREE.Material): void {
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = material.premultipliedAlpha
    ? THREE.OneFactor
    : THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
}
