/**
 * Camera-relative ray-basis cloud reprojection (1B-12).
 *
 * INVARIANT THIS FILE OWNS: temporal cloud history is reprojected from the
 * previous frame's RAY BASIS and the delta of ABSOLUTE camera positions —
 * never from a cached local-space view-projection matrix. The stale-matrix
 * class of bug (1A-4's counter-rotating clouds) is removed by construction:
 * there is no matrix to go stale, and a floating-origin rebase — which jumps
 * `camera.position` by up to 2,048 m while absolute positions are unchanged —
 * is exactly a no-op on every quantity here.
 *
 * Class P: pure functions over numbers, no Babylon import, Node-tested with
 * a round trip across a synthetic origin shift.
 */

export type Vec3Tuple = readonly [number, number, number];

export interface CameraRayBasis {
  /** Unit forward/right/up of the camera, any consistent world frame. */
  readonly forward: Vec3Tuple;
  readonly right: Vec3Tuple;
  readonly up: Vec3Tuple;
  /** tan(half-fov) per axis: x horizontal, y vertical. */
  readonly viewScaleX: number;
  readonly viewScaleY: number;
}

export interface CameraRayState extends CameraRayBasis {
  /** ABSOLUTE camera position in CPU world metres — never the rebased local. */
  readonly cameraWorld: Vec3Tuple;
}

/**
 * tan(half-fov) per axis from Babylon's fov + fovMode + aspect. Under
 * FOVMODE_HORIZONTAL_FIXED (1B-11) `fov` is the horizontal angle and the
 * vertical shrinks by the aspect; the previous vertical-fixed formula
 * silently misregisters every cloud ray against the main camera.
 */
export function viewScaleFromFov(
  fovRadians: number,
  aspectRatio: number,
  horizontalFixed: boolean,
): { x: number; y: number } {
  const tanHalf = Math.tan(fovRadians * 0.5);
  return horizontalFixed
    ? { x: tanHalf, y: tanHalf / aspectRatio }
    : { x: tanHalf * aspectRatio, y: tanHalf };
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The unnormalized view ray for a uv in [0,1]² under a ray basis. */
export function rayFromUv(basis: CameraRayBasis, u: number, v: number): Vec3Tuple {
  const ndcX = u * 2 - 1;
  const ndcY = v * 2 - 1;
  const x = basis.forward[0]
    + basis.right[0] * ndcX * basis.viewScaleX
    + basis.up[0] * ndcY * basis.viewScaleY;
  const y = basis.forward[1]
    + basis.right[1] * ndcX * basis.viewScaleX
    + basis.up[1] * ndcY * basis.viewScaleY;
  const z = basis.forward[2]
    + basis.right[2] * ndcX * basis.viewScaleX
    + basis.up[2] * ndcY * basis.viewScaleY;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * Project a point given RELATIVE TO THE PREVIOUS CAMERA onto the previous
 * basis. Null when the point sits at or behind the previous near plane.
 */
export function reprojectToPreviousUv(
  previous: CameraRayBasis,
  point: Vec3Tuple,
): { u: number; v: number } | null {
  const forwardDepth = dot(point, previous.forward);
  if (forwardDepth <= 1e-6) return null;
  const ndcX = dot(point, previous.right) / (forwardDepth * previous.viewScaleX);
  const ndcY = dot(point, previous.up) / (forwardDepth * previous.viewScaleY);
  return { u: ndcX * 0.5 + 0.5, v: ndcY * 0.5 + 0.5 };
}

export interface CloudReprojectionUniforms {
  readonly previousForward: Vec3Tuple;
  readonly previousRight: Vec3Tuple;
  readonly previousUp: Vec3Tuple;
  readonly previousViewScaleX: number;
  readonly previousViewScaleY: number;
  /** cameraWorldNow − cameraWorldPrevious, in absolute world metres. */
  readonly cameraDelta: Vec3Tuple;
}

/**
 * Everything the temporal pass needs to find last frame's sample for a
 * current ray: reconstruct the world offset of the sample point relative to
 * the previous camera as `ray·distance + cameraDelta`, then project it onto
 * the previous basis. Both frames' camera positions are ABSOLUTE, so a
 * floating-origin rebase between them cancels exactly.
 */
export function resolveCloudReprojection(
  current: CameraRayState,
  previous: CameraRayState,
): CloudReprojectionUniforms {
  return {
    previousForward: previous.forward,
    previousRight: previous.right,
    previousUp: previous.up,
    previousViewScaleX: previous.viewScaleX,
    previousViewScaleY: previous.viewScaleY,
    cameraDelta: [
      current.cameraWorld[0] - previous.cameraWorld[0],
      current.cameraWorld[1] - previous.cameraWorld[1],
      current.cameraWorld[2] - previous.cameraWorld[2],
    ],
  };
}

/**
 * The TS mirror of the temporal shader's reprojection block, for the
 * round-trip test: current uv → ray → sample point at `distance` → previous
 * uv under the reprojection uniforms.
 */
export function reprojectUv(
  current: CameraRayBasis,
  uniforms: CloudReprojectionUniforms,
  u: number,
  v: number,
  distanceMeters: number,
): { u: number; v: number } | null {
  const ray = rayFromUv(current, u, v);
  const point: Vec3Tuple = [
    ray[0] * distanceMeters + uniforms.cameraDelta[0],
    ray[1] * distanceMeters + uniforms.cameraDelta[1],
    ray[2] * distanceMeters + uniforms.cameraDelta[2],
  ];
  return reprojectToPreviousUv(
    {
      forward: uniforms.previousForward,
      right: uniforms.previousRight,
      up: uniforms.previousUp,
      viewScaleX: uniforms.previousViewScaleX,
      viewScaleY: uniforms.previousViewScaleY,
    },
    point,
  );
}
