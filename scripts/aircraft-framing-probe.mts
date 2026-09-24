/**
 * Where does the aeroplane actually sit in frame, and is its own mesh straight?
 *
 * Jason reports the Aster "tilted to the right a little and shifted to the left
 * of the screen a little", less so on the Vesper. Four causes can produce that
 * and code reading cannot tell them apart, so this measures each one directly:
 *
 *   MESH      build the real visual in a NullEngine, and test every vertex for
 *             a mirror partner across the z=0 plane. An unmirrored airframe is
 *             tilted/offset before any camera exists.
 *   CAMERA    run the SHIPPED chase rig (chaseCameraProfile + the updateCamera
 *             arithmetic + cameraPresentation's bank follow and orthogonalise)
 *             and project the aircraft origin to normalised device coordinates.
 *   TRIM      step the real FlightSimulator from the real spawn with zero pilot
 *             input and read bank/sideslip out of telemetry.
 *   VIEWPORT  ruled out separately: .flight-canvas is `position:absolute;
 *             inset:0` over a full-viewport shell (src/game/flight.css:21-28),
 *             so the canvas is not itself off-centre.
 *
 *   npx tsx scripts/aircraft-framing-probe.mts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { createAircraft } from "../src/render/webgpu/aircraft";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import {
  cameraBankFollow,
  orthogonalizeCameraUpToRef,
} from "../src/render/cameraPresentation";
import { aircraftDefinition, FlightSimulator, type AircraftKind } from "../src/sim";
import { createSimulationSpawn } from "../src/game/spawn";
import { createWorld, sampleWind, type WindSample } from "../src/world";

const DEG = 180 / Math.PI;
const f3 = (n: number) => (n >= 0 ? " " : "") + n.toFixed(3);

// ---------------------------------------------------------------- MESH -----

interface MeshReport {
  kind: AircraftKind;
  meshCount: number;
  vertexCount: number;
  unmirroredVertices: number;
  worstUnmirrored: { name: string; x: number; y: number; z: number } | null;
  centroidZ: number;
  bboxMinZ: number;
  bboxMaxZ: number;
  rolledNodes: string[];
}

/**
 * A left/right-symmetric airframe has, for every vertex (x,y,z), a partner at
 * (x,y,-z). Test that on the WORLD positions of every mesh in the visual, so a
 * rotated or offset parent node is caught along with a mis-mirrored part.
 */
function measureMesh(kind: AircraftKind): MeshReport {
  const engine = new NullEngine({
    renderWidth: 512, renderHeight: 512, textureSize: 512,
    deterministicLockstep: false, lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;   // asserted at createAircraft.ts:52
  const visual = createAircraft(scene, kind);
  visual.root.computeWorldMatrix(true);
  for (const mesh of visual.meshes) mesh.computeWorldMatrix(true);

  const points: { name: string; x: number; y: number; z: number }[] = [];
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumZ = 0;
  for (const mesh of visual.meshes) {
    const positions = mesh.getVerticesData("position");
    if (!positions) continue;
    const world = mesh.computeWorldMatrix(true);
    const v = new Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      v.set(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      const p = Vector3.TransformCoordinates(v, world);
      points.push({ name: mesh.name, x: p.x, y: p.y, z: p.z });
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
      sumZ += p.z;
    }
  }

  // Bucket by (x,y) so the mirror search is linear rather than quadratic.
  const TOL = 0.004;
  const q = (n: number) => Math.round(n / TOL);
  const buckets = new Map<string, { z: number }[]>();
  for (const p of points) {
    const key = `${q(p.x)}|${q(p.y)}`;
    const list = buckets.get(key);
    if (list) list.push({ z: p.z });
    else buckets.set(key, [{ z: p.z }]);
  }
  let unmirrored = 0;
  let worst: MeshReport["worstUnmirrored"] = null;
  let worstZ = 0;
  for (const p of points) {
    // Search the 3x3 neighbourhood of (x,y) buckets so a point sitting on a
    // quantisation boundary still finds its partner.
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx += 1) {
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        const list = buckets.get(`${q(p.x) + dx}|${q(p.y) + dy}`);
        if (!list) continue;
        for (const other of list) {
          if (Math.abs(other.z + p.z) <= TOL) { found = true; break; }
        }
      }
    }
    if (!found) {
      unmirrored += 1;
      if (Math.abs(p.z) > worstZ) { worstZ = Math.abs(p.z); worst = p; }
    }
  }

  // Any node carrying a roll (rotation about body +X) tilts everything under it.
  const rolled: string[] = [];
  const walk = (n: { name: string; rotation: Vector3; rotationQuaternion: Quaternion | null; getChildren: () => unknown[] }) => {
    const rx = n.rotationQuaternion
      ? Quaternion.Identity().copyFrom(n.rotationQuaternion).toEulerAngles().x
      : n.rotation.x;
    if (Math.abs(rx) > 1e-4) rolled.push(`${n.name} rotation.x=${rx.toFixed(4)} rad (${(rx * DEG).toFixed(2)} deg)`);
    for (const child of n.getChildren() as typeof n[]) walk(child);
  };
  walk(visual.root as never);

  const report: MeshReport = {
    kind,
    meshCount: visual.meshes.length,
    vertexCount: points.length,
    unmirroredVertices: unmirrored,
    worstUnmirrored: worst,
    centroidZ: sumZ / Math.max(1, points.length),
    bboxMinZ: minZ,
    bboxMaxZ: maxZ,
    rolledNodes: rolled,
  };
  visual.dispose();
  scene.dispose();
  engine.dispose();
  return report;
}

// -------------------------------------------------------------- CAMERA -----

/**
 * The shipped chase rig, transcribed from FlightRenderer.updateCamera's chase
 * branch (~2721-2800) with the ground clamp omitted (it only ever raises the
 * camera near terrain and this probe flies high). Returns the aircraft origin
 * and its two wingtips in normalised device coordinates: x=0 is the centre of
 * the screen, x=-1 the left edge, +1 the right edge.
 */
function frameAircraft(
  scene: Scene,
  kind: AircraftKind,
  bankRadians: number,
  airspeed: number,
  spanMetres: number,
  /** "shipped" = the rig as it stands; "consistent" = position the camera in
   *  the same partially-banked frame its own up vector already uses. */
  rig: "shipped" | "consistent" | "rollOnly" = "shipped",
  pitchRadians = 0,
): { ndcX: number; ndcY: number; rollOnScreenDeg: number; tipR: { x: number; y: number }; tipL: { x: number; y: number } } {
  const profile = chaseCameraProfile(kind, airspeed);
  // Body frame: +X nose, +Y up, +Z starboard (D-6). Bank rolls about +X.
  const body = Quaternion.RotationAxis(new Vector3(0, 0, 1), pitchRadians)
    .multiply(Quaternion.RotationAxis(new Vector3(1, 0, 0), bankRadians));
  const m = new Matrix();
  Matrix.FromQuaternionToRef(body, m);
  // FlightRenderer.updatePresentation: forward = body Right(), up = body Up().
  const forward = Vector3.TransformNormal(Vector3.Right(), m).normalize();
  const up = Vector3.TransformNormal(Vector3.Up(), m).normalize();
  // D-6: starboard is body +Z. (Note FlightRenderer.updatePresentation:2402
  // derives its own `bodyStarboard` from Vector3.Forward(true), which is
  // body -Z - the opposite side. Flagged separately; irrelevant here.)
  const starboard = Vector3.TransformNormal(new Vector3(0, 0, 1), m).normalize();

  const camUp = Vector3.Lerp(Vector3.UpReadOnly, up, cameraBankFollow("chase", false));
  camUp.normalize();
  // The rig's vertical reference. The shipped code raises the camera along the
  // AIRCRAFT's up while rolling the view only 18% of the way there, so the two
  // disagree by 82% of the bank and the airframe slides off centre.
  // "rollOnly": the same blend the camera's up already applies, but only to
  // the ROLL component. `up0` is the up this aircraft would have at the same
  // heading and pitch with the wings level, so at zero bank `lift === up` and
  // the rig is bit-identical to what ships today, pitch included.
  const horizontalRight = Vector3.Cross(forward, Vector3.UpReadOnly);
  const up0 = horizontalRight.lengthSquared() > 1e-9
    ? Vector3.Cross(horizontalRight.normalize(), forward).normalize()
    : up.clone();
  const rollOnlyLift = Vector3.Lerp(up0, up, cameraBankFollow("chase", false)).normalize();
  const lift = rig === "shipped" ? up : rig === "consistent" ? camUp : rollOnlyLift;

  const aircraft = Vector3.Zero();
  const camPos = aircraft.subtract(forward.scale(profile.distance)).add(lift.scale(profile.height));
  const target = aircraft.add(forward.scale(profile.aimAhead)).add(lift.scale(1.25));

  const view = target.subtract(camPos);
  orthogonalizeCameraUpToRef(camUp, view, up, camUp);

  const cam = new UniversalCamera("probe", camPos, scene);
  cam.upVector = camUp;
  cam.fov = (profile.fieldOfView * Math.PI) / 180;
  cam.minZ = 0.5;
  cam.maxZ = 20_000;
  cam.setTarget(target);
  scene.activeCamera = cam;
  const viewProj = cam.getViewMatrix(true).multiply(cam.getProjectionMatrix(true));

  const project = (p: Vector3) => {
    const t = Vector3.TransformCoordinates(p, viewProj);
    return { x: t.x, y: t.y };
  };
  const origin = project(aircraft);
  const half = spanMetres / 2;
  const tipR = project(starboard.scale(half));
  const tipL = project(starboard.scale(-half));
  // Screen roll: the angle the wing line makes with screen horizontal, in
  // PIXELS. NDC is anisotropic - x spans the width and y the height - so an
  // angle read straight off NDC is stretched by the aspect ratio (it reported
  // 1.45x the bank on a 16:9 frame, which is the 0.82 attenuation times 1.78).
  const aspect = scene.getEngine().getRenderWidth() / scene.getEngine().getRenderHeight();
  const rollOnScreen = Math.atan2(
    -(tipR.y - tipL.y) / aspect,
    tipR.x - tipL.x,
  ) * DEG;
  cam.dispose();
  return { ndcX: origin.x, ndcY: origin.y, rollOnScreenDeg: rollOnScreen, tipR, tipL };
}

// ---------------------------------------------------------------- TRIM -----

type Weather = "clear" | "breezy" | "cloudy" | "calm";

/**
 * Hands-off flight with the SAME wind the worker feeds the simulator
 * (simulation.worker.ts:223-233: sampleWind at the aircraft, scaled by
 * weather). "calm" is the control arm — zero wind, not a shipped setting.
 */
function measureTrim(kind: AircraftKind, weather: Weather, seconds: number) {
  const world = createWorld("open-skies");
  const spawn = createSimulationSpawn(world, "airborne", 600, kind);
  const sim = new FlightSimulator({ aircraft: aircraftDefinition(kind), spawn });
  const windTarget: WindSample = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
  const dt = 1 / 120;
  const steps = Math.round(seconds / dt);
  let maxAbsBank = 0;
  let sumBank = 0;
  let sumSideslip = 0;
  let sumWindSpeed = 0;
  // Settle first, then average: the opening seconds are the spawn transient.
  const settle = Math.round(steps * 0.5);
  let samples = 0;
  for (let i = 0; i < steps; i += 1) {
    const p = sim.state.position;
    const wind = sampleWind(world, p.x, p.y, p.z, sim.state.time, windTarget);
    const scale = weather === "calm" ? 0 : weather === "clear" ? 0.62 : weather === "cloudy" ? 1.28 : 1;
    const applied = { x: wind.x * scale, y: wind.y * scale, z: wind.z * scale };
    sim.setEnvironment({ wind: applied });
    sim.step(dt);
    const t = sim.telemetry();
    if (i >= settle) {
      maxAbsBank = Math.max(maxAbsBank, Math.abs(t.bank));
      sumBank += t.bank;
      sumSideslip += t.sideslip;
      sumWindSpeed += Math.hypot(applied.x, applied.z);
      samples += 1;
    }
  }
  const final = sim.telemetry();
  return {
    kind,
    weather,
    finalBankDeg: final.bank * DEG,
    meanBankDeg: (sumBank / samples) * DEG,
    maxAbsBankDeg: maxAbsBank * DEG,
    meanSideslipDeg: (sumSideslip / samples) * DEG,
    finalSideslipDeg: final.sideslip * DEG,
    meanWindSpeed: sumWindSpeed / samples,
    airspeed: final.airspeed,
  };
}

// ---------------------------------------------------------------- MAIN -----

const KINDS: AircraftKind[] = ["trainer", "jet", "bizjet", "airliner"];
const SPANS: Record<AircraftKind, number> = {
  trainer: 10.17, jet: 9.96, bizjet: 31.7, airliner: 68.4,
};

console.log("=".repeat(78));
console.log("1. MESH — is the built airframe its own mirror image about z=0?");
console.log("=".repeat(78));
for (const kind of KINDS) {
  const r = measureMesh(kind);
  console.log(`\n${kind}:`);
  console.log(`  meshes ${r.meshCount}, vertices ${r.vertexCount}`);
  console.log(`  unmirrored vertices: ${r.unmirroredVertices} (${((r.unmirroredVertices / r.vertexCount) * 100).toFixed(2)}%)`);
  if (r.worstUnmirrored) {
    const w = r.worstUnmirrored;
    console.log(`  worst offender: ${w.name} at (${f3(w.x)}, ${f3(w.y)}, ${f3(w.z)})`);
  }
  console.log(`  vertex centroid z: ${f3(r.centroidZ)}   bbox z: [${f3(r.bboxMinZ)}, ${f3(r.bboxMaxZ)}]  (a straight aeroplane centres on 0)`);
  console.log(`  nodes carrying a roll about +X: ${r.rolledNodes.length === 0 ? "none" : ""}`);
  for (const n of r.rolledNodes) console.log(`    ${n}`);
}

console.log("\n" + "=".repeat(78));
console.log("2. TRIM - bank and sideslip, hands-off, averaged over the last 30 s of 60");
console.log("   world 'open-skies'; default weather is 'breezy' (settings/index.ts:104)");
console.log("=".repeat(78));
const trims = {} as Record<AircraftKind, ReturnType<typeof measureTrim>>;
for (const kind of KINDS) {
  console.log(`\n${kind}:`);
  console.log("   weather   wind m/s   mean bank    final bank    peak |bank|   mean slip   final slip");
  for (const weather of ["calm", "clear", "breezy", "cloudy"] as const) {
    const t = measureTrim(kind, weather, 60);
    if (weather === "breezy") trims[kind] = t;
    console.log(
      `  ${weather.padEnd(8)}   ${t.meanWindSpeed.toFixed(2).padStart(6)}    ${f3(t.meanBankDeg).padStart(8)}     ${f3(t.finalBankDeg).padStart(8)}      ${t.maxAbsBankDeg.toFixed(3).padStart(7)}     ${f3(t.meanSideslipDeg).padStart(7)}     ${f3(t.finalSideslipDeg).padStart(7)}`,
    );
  }
}

console.log("\n" + "=".repeat(78));
console.log("3. CAMERA — where the aircraft lands in frame, vs bank angle");
console.log("   ndcX<0 = left of screen centre. apparentRoll>0 = right wing low on screen.");
console.log("=".repeat(78));
{
  const engine = new NullEngine({
    renderWidth: 1600, renderHeight: 900, textureSize: 512,
    deterministicLockstep: false, lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  for (const kind of KINDS) {
    const airspeed = trims[kind].airspeed;
    console.log(`\n${kind} (airspeed ${airspeed.toFixed(0)} m/s, span ${SPANS[kind]} m):`);
    console.log("   bank     ndcX     ndcY   |  stbd tip (x,y)    port tip (x,y)   | apparent roll   shift");
    for (const bankDeg of [0, 1, 2, 5, 10, 20, -1, -5, -20]) {
      const r = frameAircraft(scene, kind, bankDeg / DEG, airspeed, SPANS[kind]);
      const pct = (r.ndcX / 2) * 100;
      // Signed apparent roll: positive = starboard wingtip LOWER on screen.
      const aspect = 1600 / 900;
      const dx = r.tipR.x - r.tipL.x;
      const dy = (r.tipR.y - r.tipL.y) / aspect;
      const apparent = -Math.atan2(dy, Math.abs(dx)) * DEG * Math.sign(dx || 1);
      console.log(
        `  ${(bankDeg >= 0 ? " " : "") + bankDeg.toFixed(0).padStart(3)}deg  ${f3(r.ndcX)}  ${f3(r.ndcY)}  | ${f3(r.tipR.x)},${f3(r.tipR.y)}  ${f3(r.tipL.x)},${f3(r.tipL.y)} |  ${f3(apparent).padStart(7)}deg   ${(pct >= 0 ? " " : "") + pct.toFixed(2)}%`,
      );
    }
  }
  scene.dispose();
  engine.dispose();
}
console.log("");

console.log("\n" + "=".repeat(78));
console.log("4. CAMERA A/B - shipped rig vs two candidate fixes");
console.log("   'camUp'    lifts along the camera's own (bank-blended) up vector");
console.log("   'rollOnly' blends only the ROLL out of the lift, keeping pitch whole");
console.log("=".repeat(78));
{
  const engine = new NullEngine({
    renderWidth: 1600, renderHeight: 900, textureSize: 512,
    deterministicLockstep: false, lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  for (const kind of KINDS) {
    const airspeed = trims[kind].airspeed;
    console.log(`\n${kind}:`);
    for (const pitchDeg of [0, 6]) {
    console.log(`  pitch ${pitchDeg} deg`);
    console.log("   bank     shipped    camUp   rollOnly  |  shipped ndcY   rollOnly ndcY");
    for (const bankDeg of [0, 2, 5, 10, 20, 30, -10, -20]) {
      const a = frameAircraft(scene, kind, bankDeg / DEG, airspeed, SPANS[kind], "shipped", pitchDeg / DEG);
      const b = frameAircraft(scene, kind, bankDeg / DEG, airspeed, SPANS[kind], "consistent", pitchDeg / DEG);
      const c = frameAircraft(scene, kind, bankDeg / DEG, airspeed, SPANS[kind], "rollOnly", pitchDeg / DEG);
      const shift = (r: typeof a) => `${((r.ndcX / 2) * 100).toFixed(2)}%`;
      console.log(
        `  ${(bankDeg >= 0 ? " " : "") + bankDeg.toFixed(0).padStart(3)}deg  ${shift(a).padStart(8)} ${shift(b).padStart(8)} ${shift(c).padStart(9)}  |  ${a.ndcY.toFixed(4).padStart(8)}      ${c.ndcY.toFixed(4).padStart(8)}`,
      );
    }
    }
  }
  scene.dispose();
  engine.dispose();
}
console.log("");
