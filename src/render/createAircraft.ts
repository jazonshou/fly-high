import * as THREE from "three";
import type { FlightVisualState } from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";
import { preserveDestinationAlpha } from "./PreserveDestinationAlpha";

export interface AircraftVisual {
  readonly group: THREE.Group;
  readonly propeller: THREE.Group;
  readonly cockpitParts: THREE.Object3D[];
  update(state: FlightVisualState, deltaSeconds: number): void;
  setCockpitView(enabled: boolean): void;
  dispose(): void;
}

function standardMaterial(
  color: THREE.ColorRepresentation,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.48,
    metalness: 0.08,
    ...options,
  });
}

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  castShadow = true,
): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  result.castShadow = castShadow;
  result.receiveShadow = true;
  return result;
}

function strutBetween(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(to, from);
  const strut = mesh(
    new THREE.CylinderGeometry(radius, radius * 1.08, direction.length(), 8),
    material,
  );
  strut.position.copy(from).add(to).multiplyScalar(0.5);
  strut.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  return strut;
}

interface PlanformPoint {
  x: number;
  z: number;
}

/** Builds a low-poly aerodynamic surface with an actual tapered planform. */
function planformGeometry(
  outline: readonly PlanformPoint[],
  thickness: number,
): THREE.BufferGeometry {
  const halfThickness = thickness * 0.5;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const y of [halfThickness, -halfThickness]) {
    for (const point of outline) positions.push(point.x, y, point.z);
  }
  const count = outline.length;
  for (let index = 1; index < count - 1; index += 1) {
    indices.push(0, index + 1, index);
    indices.push(count, count + index, count + index + 1);
  }
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(index, next, count + next, index, count + next, count + index);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeFin(material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -3.25, 0.2, -0.04,
        -3.25, 1.75, -0.04,
        -1.75, 0.3, -0.04,
        -3.25, 0.2, 0.04,
        -1.75, 0.3, 0.04,
        -3.25, 1.75, 0.04,
      ],
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 3, 4, 5, 0, 3, 5, 0, 5, 1, 1, 5, 4, 1, 4, 2]);
  geometry.computeVertexNormals();
  return mesh(geometry, material);
}

function createTrainerAircraft(): AircraftVisual {
  const group = new THREE.Group();
  group.name = "aerolith-trainer";

  const bodyMaterial = standardMaterial(0xe8eee7);
  const accentMaterial = standardMaterial(0xcfe95d, { roughness: 0.38 });
  const darkMaterial = standardMaterial(0x142b32, { roughness: 0.25, metalness: 0.15 });
  const glassMaterial = standardMaterial(0x163845, {
    roughness: 0.08,
    metalness: 0.2,
    transparent: true,
    opacity: 0.82,
  });
  preserveDestinationAlpha(glassMaterial);
  const tireMaterial = standardMaterial(0x07090a, { roughness: 1, metalness: 0 });
  const hubMaterial = standardMaterial(0x718086, { roughness: 0.38, metalness: 0.62 });
  const panelMaterial = standardMaterial(0xaab8ba, { roughness: 0.34, metalness: 0.32 });
  const interiorMaterial = standardMaterial(0x1b2528, { roughness: 0.82, metalness: 0 });
  const lampRed = standardMaterial(0xff493d, { emissive: 0xff2018, emissiveIntensity: 2 });
  const lampGreen = standardMaterial(0x5dffab, { emissive: 0x24ff83, emissiveIntensity: 2 });
  const landingLamp = standardMaterial(0xfff1c2, {
    emissive: 0xffd991,
    emissiveIntensity: 3.2,
    roughness: 0.16,
  });

  const fuselage = mesh(new THREE.CylinderGeometry(0.54, 0.4, 6.2, 14), bodyMaterial);
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.x = -0.1;
  group.add(fuselage);

  const nose = mesh(new THREE.CylinderGeometry(0.16, 0.54, 1.25, 14), accentMaterial);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 3.55;
  group.add(nose);

  const spinner = mesh(new THREE.ConeGeometry(0.2, 0.48, 12), darkMaterial);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.x = 4.35;
  group.add(spinner);

  const trainerWingOutline = [
    { x: 1.28, z: 0.5 },
    { x: 0.72, z: 5.4 },
    { x: -0.52, z: 5.4 },
    { x: -0.78, z: 0.5 },
    { x: -0.78, z: -0.5 },
    { x: -0.52, z: -5.4 },
    { x: 0.72, z: -5.4 },
    { x: 1.28, z: -0.5 },
  ] as const;
  const wing = mesh(planformGeometry(trainerWingOutline, 0.15), bodyMaterial);
  wing.name = "tapered-main-wing";
  wing.position.set(0, 0.28, 0);
  group.add(wing);

  const wingAccent = mesh(
    planformGeometry([
      { x: 1.3, z: 0.51 },
      { x: 0.73, z: 5.41 },
      { x: 0.48, z: 5.41 },
      { x: 1.03, z: 0.51 },
      { x: 1.03, z: -0.51 },
      { x: 0.48, z: -5.41 },
      { x: 0.73, z: -5.41 },
      { x: 1.3, z: -0.51 },
    ], 0.162),
    accentMaterial,
  );
  wingAccent.name = "leading-edge-accent";
  wingAccent.position.set(0, 0.28, 0);
  group.add(wingAccent);

  const ailerons: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? "starboard-aileron" : "port-aileron";
    pivot.position.set(-0.49, 0.28, side * 3.8);
    const surface = mesh(new THREE.BoxGeometry(0.38, 0.075, 2.55), accentMaterial);
    surface.position.x = -0.19;
    pivot.add(surface);
    group.add(pivot);
    ailerons.push(pivot);
  }

  const tailplane = mesh(new THREE.BoxGeometry(1.22, 0.1, 3.9), bodyMaterial);
  tailplane.position.set(-2.86, 0.42, 0);
  group.add(tailplane);
  group.add(makeFin(accentMaterial));

  const elevator = new THREE.Group();
  elevator.name = "elevator";
  elevator.position.set(-3.27, 0.42, 0);
  const elevatorSurface = mesh(new THREE.BoxGeometry(0.42, 0.075, 3.72), accentMaterial);
  elevatorSurface.position.x = -0.21;
  elevator.add(elevatorSurface);
  group.add(elevator);

  const rudder = new THREE.Group();
  rudder.name = "rudder";
  rudder.position.set(-3.13, 1.02, 0);
  const rudderSurface = mesh(new THREE.BoxGeometry(0.42, 1.05, 0.075), accentMaterial);
  rudderSurface.position.set(-0.2, 0.12, 0);
  rudder.add(rudderSurface);
  group.add(rudder);

  const canopy = mesh(new THREE.SphereGeometry(0.58, 12, 7), glassMaterial);
  canopy.scale.set(1.65, 0.82, 0.88);
  canopy.position.set(0.58, 0.58, 0);
  group.add(canopy);

  const windscreenFrame = strutBetween(
    new THREE.Vector3(0.92, 0.35, 0),
    new THREE.Vector3(0.82, 1.02, 0),
    0.026,
    darkMaterial,
  );
  windscreenFrame.name = "windscreen-center-frame";
  group.add(windscreenFrame);
  for (const side of [-1, 1]) {
    const seat = mesh(new THREE.BoxGeometry(0.42, 0.62, 0.36), interiorMaterial);
    seat.name = side < 0 ? "starboard-seat" : "port-seat";
    seat.position.set(0.12, 0.37, side * 0.27);
    seat.rotation.z = -0.08;
    const headrest = mesh(new THREE.BoxGeometry(0.2, 0.26, 0.3), interiorMaterial);
    headrest.position.set(-0.2, 0.72, side * 0.27);
    group.add(seat, headrest);
  }

  const cowlingBand = mesh(new THREE.CylinderGeometry(0.545, 0.545, 0.075, 14), panelMaterial);
  cowlingBand.name = "engine-cowling-band";
  cowlingBand.rotation.z = Math.PI / 2;
  cowlingBand.position.x = 2.98;
  group.add(cowlingBand);
  for (const side of [-1, 1]) {
    const exhaust = mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.54, 8), darkMaterial);
    exhaust.name = side < 0 ? "starboard-exhaust" : "port-exhaust";
    exhaust.rotation.z = Math.PI / 2;
    exhaust.position.set(2.45, -0.38, side * 0.34);
    group.add(exhaust);

    const wingTip = mesh(new THREE.SphereGeometry(0.115, 8, 5), accentMaterial);
    wingTip.name = side < 0 ? "starboard-wingtip-fairing" : "port-wingtip-fairing";
    wingTip.scale.set(2.4, 0.55, 0.7);
    wingTip.position.set(0.08, 0.28, side * 5.43);
    group.add(wingTip);
  }
  const pitot = mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.72, 6), panelMaterial);
  pitot.name = "pitot-tube";
  pitot.rotation.z = -Math.PI / 2;
  pitot.position.set(1.2, 0.18, 5.1);
  group.add(pitot);

  const registration = mesh(new THREE.BoxGeometry(0.035, 0.24, 1.62), accentMaterial);
  registration.name = "fuselage-registration-stripe";
  registration.position.set(-1.72, 0.04, 0);
  group.add(registration);

  // A darker belly breaks up the bright lower silhouette and makes the height
  // of the wheels and struts legible against pale runway concrete.
  const belly = mesh(new THREE.BoxGeometry(2.9, 0.045, 0.58), darkMaterial);
  belly.position.set(0.28, -0.51, 0);
  group.add(belly);

  const cockpitParts: THREE.Object3D[] = [fuselage, canopy];

  const propeller = new THREE.Group();
  propeller.position.x = 4.25;
  const propHub = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.28, 10), darkMaterial);
  propHub.rotation.z = Math.PI / 2;
  propeller.add(propHub);
  const bladeGeometry = new THREE.BoxGeometry(0.06, 2.6, 0.14);
  const bladeA = mesh(bladeGeometry, darkMaterial);
  const bladeB = mesh(bladeGeometry, darkMaterial);
  bladeB.rotation.x = Math.PI / 2;
  propeller.add(bladeA, bladeB);
  group.add(propeller);

  const mainWheelPivots: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const wheelCenter = new THREE.Vector3(-0.3, -1.07, side * 1.52);
    group.add(
      strutBetween(
        new THREE.Vector3(-0.18, 0.03, side * 0.94),
        new THREE.Vector3(-0.3, -0.93, side * 1.52),
        0.052,
        darkMaterial,
      ),
      strutBetween(
        new THREE.Vector3(0.24, -0.02, side * 1.12),
        new THREE.Vector3(-0.3, -0.91, side * 1.52),
        0.034,
        hubMaterial,
      ),
    );

    const wheelPivot = new THREE.Group();
    wheelPivot.name = side < 0 ? "starboard-main-wheel" : "port-main-wheel";
    wheelPivot.position.copy(wheelCenter);
    const tire = mesh(new THREE.TorusGeometry(0.205, 0.065, 8, 20), tireMaterial);
    const hub = mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.19, 14), hubMaterial);
    hub.rotation.x = Math.PI / 2;
    const hubCapPort = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.202, 12), darkMaterial);
    hubCapPort.rotation.x = Math.PI / 2;
    wheelPivot.add(tire, hub, hubCapPort);
    group.add(wheelPivot);
    mainWheelPivots.push(wheelPivot);
  }
  group.add(
    strutBetween(
      new THREE.Vector3(2.55, -0.17, 0),
      new THREE.Vector3(2.55, -0.82, 0),
      0.046,
      darkMaterial,
    ),
  );
  const noseSteer = new THREE.Group();
  noseSteer.name = "nose-wheel-steering";
  noseSteer.position.set(2.55, -0.95, 0);
  const noseWheel = new THREE.Group();
  noseWheel.name = "nose-wheel";
  const noseTire = mesh(new THREE.TorusGeometry(0.155, 0.055, 8, 18), tireMaterial);
  const noseHub = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.15, 12), hubMaterial);
  noseHub.rotation.x = Math.PI / 2;
  noseWheel.add(noseTire, noseHub);
  noseSteer.add(noseWheel);
  group.add(noseSteer);

  // Body +Z is port/left in the corrected right-handed aircraft frame.
  const leftLight = mesh(new THREE.SphereGeometry(0.09, 8, 5), lampRed, false);
  leftLight.position.set(0.2, 0.3, 5.43);
  const rightLight = mesh(new THREE.SphereGeometry(0.09, 8, 5), lampGreen, false);
  rightLight.position.set(0.2, 0.3, -5.43);
  const leftLandingLight = mesh(new THREE.CircleGeometry(0.12, 10), landingLamp, false);
  leftLandingLight.name = "landing-light";
  leftLandingLight.rotation.y = Math.PI / 2;
  leftLandingLight.position.set(1.18, 0.22, 1.7);
  group.add(leftLight, rightLight, leftLandingLight);

  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      resources.add(child.geometry);
      if (Array.isArray(child.material)) child.material.forEach((item) => resources.add(item));
      else resources.add(child.material);
    }
  });

  return {
    group,
    propeller,
    cockpitParts,
    update(state, deltaSeconds) {
      const normalizedRpm = THREE.MathUtils.clamp(state.engineRpm / 2600, 0, 1.2);
      propeller.rotation.x += deltaSeconds * (18 + normalizedRpm * 105);
      propeller.visible = normalizedRpm < 0.12 || Math.sin(propeller.rotation.x * 0.27) > -0.82;
      // The array order is starboard (-Z), port (+Z). Positive pilot roll
      // raises the starboard aileron and lowers the port aileron.
      ailerons[0]!.rotation.z = -state.aileron * 0.25;
      ailerons[1]!.rotation.z = state.aileron * 0.25;
      elevator.rotation.z = -state.elevator * 0.3;
      rudder.rotation.y = -state.rudder * 0.32;
      noseSteer.rotation.y = state.onGround ? -state.rudder * 0.24 : 0;
      if (state.onGround || state.altitudeAgl < 0.35) {
        const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
        const mainRotation = (groundSpeed * deltaSeconds) / 0.27;
        for (const wheel of mainWheelPivots) wheel.rotation.z -= mainRotation;
        noseWheel.rotation.z -= (groundSpeed * deltaSeconds) / 0.21;
      }
    },
    setCockpitView(enabled) {
      for (const part of cockpitParts) part.visible = !enabled;
      wing.visible = true;
      wingAccent.visible = true;
    },
    dispose() {
      for (const resource of resources) resource.dispose();
    },
  };
}

function createJetAircraft(): AircraftVisual {
  const group = new THREE.Group();
  group.name = "vesper-fast-jet";

  const bodyMaterial = standardMaterial(0xc9d2d2, { roughness: 0.34, metalness: 0.28 });
  const undersideMaterial = standardMaterial(0x66777b, { roughness: 0.46, metalness: 0.2 });
  const accentMaterial = standardMaterial(0xe55b3f, { roughness: 0.38, metalness: 0.08 });
  const darkMaterial = standardMaterial(0x17242a, { roughness: 0.3, metalness: 0.48 });
  const glassMaterial = standardMaterial(0x163947, {
    roughness: 0.07,
    metalness: 0.22,
    transparent: true,
    opacity: 0.78,
  });
  preserveDestinationAlpha(glassMaterial);
  const tireMaterial = standardMaterial(0x060809, { roughness: 1, metalness: 0 });
  const hubMaterial = standardMaterial(0x89979a, { roughness: 0.3, metalness: 0.72 });
  const hotMetalMaterial = standardMaterial(0x4f5555, {
    roughness: 0.22,
    metalness: 0.88,
    emissive: 0x36150b,
    emissiveIntensity: 0.55,
  });
  const lampRed = standardMaterial(0xff493d, { emissive: 0xff2018, emissiveIntensity: 2.4 });
  const lampGreen = standardMaterial(0x5dffab, { emissive: 0x24ff83, emissiveIntensity: 2.4 });

  const fuselage = mesh(new THREE.CylinderGeometry(0.64, 0.5, 8.15, 18), bodyMaterial);
  fuselage.name = "jet-fuselage";
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.x = 0.05;
  group.add(fuselage);

  const nose = mesh(new THREE.ConeGeometry(0.63, 1.75, 18), bodyMaterial);
  nose.name = "radar-nose";
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 4.98;
  group.add(nose);

  const tailCone = mesh(new THREE.CylinderGeometry(0.32, 0.5, 1.15, 16), undersideMaterial);
  tailCone.name = "engine-tail-cone";
  tailCone.rotation.z = Math.PI / 2;
  tailCone.position.x = -4.55;
  group.add(tailCone);

  const wingOutline = [
    { x: 1.65, z: 0.48 },
    { x: -0.2, z: 4.8 },
    { x: -1.28, z: 4.8 },
    { x: -0.72, z: 0.48 },
    { x: -0.72, z: -0.48 },
    { x: -1.28, z: -4.8 },
    { x: -0.2, z: -4.8 },
    { x: 1.65, z: -0.48 },
  ] as const;
  const wing = mesh(planformGeometry(wingOutline, 0.18), bodyMaterial);
  wing.name = "swept-main-wing";
  wing.position.y = 0.05;
  group.add(wing);

  const wingChevron = mesh(
    planformGeometry([
      { x: 1.67, z: 0.5 },
      { x: -0.19, z: 4.82 },
      { x: -0.43, z: 4.82 },
      { x: 1.35, z: 0.5 },
      { x: 1.35, z: -0.5 },
      { x: -0.43, z: -4.82 },
      { x: -0.19, z: -4.82 },
      { x: 1.67, z: -0.5 },
    ], 0.192),
    accentMaterial,
  );
  wingChevron.name = "wing-leading-edge-chevron";
  wingChevron.position.y = 0.05;
  group.add(wingChevron);

  const ailerons: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? "starboard-aileron" : "port-aileron";
    pivot.position.set(-0.88, 0.05, side * 3.65);
    const surface = mesh(new THREE.BoxGeometry(0.5, 0.09, 1.65), accentMaterial);
    surface.position.x = -0.22;
    pivot.add(surface);
    group.add(pivot);
    ailerons.push(pivot);
  }

  const tailplane = mesh(
    planformGeometry([
      { x: 0.72, z: 0.35 },
      { x: -0.08, z: 2.15 },
      { x: -0.72, z: 2.15 },
      { x: -0.55, z: 0.35 },
      { x: -0.55, z: -0.35 },
      { x: -0.72, z: -2.15 },
      { x: -0.08, z: -2.15 },
      { x: 0.72, z: -0.35 },
    ], 0.12),
    bodyMaterial,
  );
  tailplane.name = "swept-tailplane";
  tailplane.position.set(-3.52, 0.43, 0);
  group.add(tailplane);

  const elevator = new THREE.Group();
  elevator.name = "elevator";
  elevator.position.set(-4.05, 0.43, 0);
  const elevatorSurface = mesh(new THREE.BoxGeometry(0.42, 0.08, 3.7), accentMaterial);
  elevatorSurface.position.x = -0.18;
  elevator.add(elevatorSurface);
  group.add(elevator);

  const fin = makeFin(bodyMaterial);
  fin.name = "swept-vertical-stabilizer";
  fin.scale.set(1.28, 1.25, 1.7);
  fin.position.set(-0.58, 0.02, 0);
  group.add(fin);
  const rudder = new THREE.Group();
  rudder.name = "rudder";
  rudder.position.set(-4.28, 1.25, 0);
  const rudderSurface = mesh(new THREE.BoxGeometry(0.48, 1.3, 0.085), accentMaterial);
  rudderSurface.position.set(-0.2, 0.08, 0);
  rudder.add(rudderSurface);
  group.add(rudder);

  const canopy = mesh(new THREE.SphereGeometry(0.62, 16, 8), glassMaterial);
  canopy.name = "tandem-canopy";
  canopy.scale.set(2.05, 0.83, 0.79);
  canopy.position.set(1.15, 0.68, 0);
  group.add(canopy);
  const canopyFrame = strutBetween(
    new THREE.Vector3(1.2, 0.32, 0),
    new THREE.Vector3(1.08, 1.16, 0),
    0.028,
    darkMaterial,
  );
  canopyFrame.name = "canopy-center-frame";
  group.add(canopyFrame);

  const belly = mesh(new THREE.BoxGeometry(4.7, 0.06, 0.72), undersideMaterial);
  belly.name = "jet-belly-panel";
  belly.position.set(-0.25, -0.58, 0);
  group.add(belly);

  for (const side of [-1, 1]) {
    const intake = mesh(new THREE.CylinderGeometry(0.24, 0.31, 1.1, 12), darkMaterial);
    intake.name = side < 0 ? "starboard-engine-intake" : "port-engine-intake";
    intake.rotation.z = Math.PI / 2;
    intake.scale.y = 0.78;
    intake.position.set(0.28, -0.18, side * 0.6);
    group.add(intake);
  }

  const propeller = new THREE.Group();
  propeller.name = "jet-compressor";
  propeller.position.x = -5.08;
  const nozzle = mesh(new THREE.CylinderGeometry(0.31, 0.36, 0.48, 18), hotMetalMaterial);
  nozzle.rotation.z = Math.PI / 2;
  propeller.add(nozzle);
  const turbine = mesh(new THREE.CircleGeometry(0.24, 12), darkMaterial);
  turbine.rotation.y = -Math.PI / 2;
  turbine.position.x = -0.25;
  propeller.add(turbine);
  group.add(propeller);

  const landingGear = new THREE.Group();
  landingGear.name = "retractable-landing-gear";
  group.add(landingGear);
  const mainWheelPivots: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    landingGear.add(
      strutBetween(
        new THREE.Vector3(-0.55, -0.18, side * 0.72),
        new THREE.Vector3(-0.72, -1.08, side * 1.72),
        0.058,
        hubMaterial,
      ),
    );
    const wheelPivot = new THREE.Group();
    wheelPivot.name = side < 0 ? "starboard-main-wheel" : "port-main-wheel";
    wheelPivot.position.set(-0.72, -1.16, side * 1.72);
    const tire = mesh(new THREE.TorusGeometry(0.24, 0.06, 8, 20), tireMaterial);
    const hub = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.18, 14), hubMaterial);
    hub.rotation.x = Math.PI / 2;
    wheelPivot.add(tire, hub);
    landingGear.add(wheelPivot);
    mainWheelPivots.push(wheelPivot);
  }
  landingGear.add(
    strutBetween(
      new THREE.Vector3(3.72, -0.3, 0),
      new THREE.Vector3(3.72, -1.02, 0),
      0.052,
      hubMaterial,
    ),
  );
  const noseSteer = new THREE.Group();
  noseSteer.name = "nose-wheel-steering";
  noseSteer.position.set(3.72, -1.08, 0);
  const noseWheel = new THREE.Group();
  noseWheel.name = "nose-wheel";
  const noseTire = mesh(new THREE.TorusGeometry(0.19, 0.05, 8, 18), tireMaterial);
  const noseHub = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.14, 12), hubMaterial);
  noseHub.rotation.x = Math.PI / 2;
  noseWheel.add(noseTire, noseHub);
  noseSteer.add(noseWheel);
  landingGear.add(noseSteer);

  const gearDoors = new THREE.Group();
  gearDoors.name = "landing-gear-doors";
  for (const side of [-1, 1]) {
    const door = mesh(new THREE.BoxGeometry(1.28, 0.035, 0.34), undersideMaterial);
    door.name = side < 0 ? "starboard-main-gear-door" : "port-main-gear-door";
    door.position.set(-0.62, -0.6, side * 0.54);
    gearDoors.add(door);
  }
  const noseDoor = mesh(new THREE.BoxGeometry(1.22, 0.03, 0.3), undersideMaterial);
  noseDoor.name = "nose-gear-door";
  noseDoor.position.set(3.26, -0.61, 0);
  gearDoors.add(noseDoor);
  group.add(gearDoors);

  const speedBrakes: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? "starboard-speed-brake" : "port-speed-brake";
    pivot.position.set(-0.42, 0.16, side * 1.28);
    const panel = mesh(new THREE.BoxGeometry(1.18, 0.045, 0.72), undersideMaterial);
    panel.position.x = -0.42;
    pivot.add(panel);
    group.add(pivot);
    speedBrakes.push(pivot);
  }

  const leftLight = mesh(new THREE.SphereGeometry(0.085, 8, 5), lampRed, false);
  leftLight.position.set(-0.2, 0.07, 4.82);
  const rightLight = mesh(new THREE.SphereGeometry(0.085, 8, 5), lampGreen, false);
  rightLight.position.set(-0.2, 0.07, -4.82);
  group.add(leftLight, rightLight);

  const cockpitParts: THREE.Object3D[] = [fuselage, nose, canopy, canopyFrame];
  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    resources.add(child.geometry);
    if (Array.isArray(child.material)) child.material.forEach((item) => resources.add(item));
    else resources.add(child.material);
  });

  return {
    group,
    propeller,
    cockpitParts,
    update(state, deltaSeconds) {
      propeller.rotation.x += deltaSeconds * (10 + state.engineRpm * 0.8);
      ailerons[0]!.rotation.z = -state.aileron * 0.22;
      ailerons[1]!.rotation.z = state.aileron * 0.22;
      elevator.rotation.z = -state.elevator * 0.26;
      rudder.rotation.y = -state.rudder * 0.28;
      noseSteer.rotation.y = state.onGround ? -state.rudder * 0.2 : 0;
      const gearTravel = THREE.MathUtils.clamp(state.gear, 0, 1);
      const easedGear = gearTravel * gearTravel * (3 - 2 * gearTravel);
      landingGear.visible = gearTravel > 0.012;
      landingGear.scale.set(
        0.9 + easedGear * 0.1,
        0.08 + easedGear * 0.92,
        0.36 + easedGear * 0.64,
      );
      landingGear.position.y = -0.24 * (1 - easedGear);
      const doorTravel = Math.sin(Math.PI * gearTravel);
      gearDoors.children.forEach((door, index) => {
        door.rotation.x = (index === 1 ? -1 : 1) * doorTravel * 1.05;
      });
      for (const speedBrake of speedBrakes) {
        speedBrake.rotation.z = -state.brake * 0.68;
      }
      if (state.onGround && state.gear >= 0.98) {
        const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
        for (const wheel of mainWheelPivots) {
          wheel.rotation.z -= (groundSpeed * deltaSeconds) / 0.3;
        }
        noseWheel.rotation.z -= (groundSpeed * deltaSeconds) / 0.24;
      }
    },
    setCockpitView(enabled) {
      for (const part of cockpitParts) part.visible = !enabled;
      wing.visible = true;
      wingChevron.visible = true;
    },
    dispose() {
      for (const resource of resources) resource.dispose();
    },
  };
}

export function createAircraft(kind: AircraftKind = "trainer"): AircraftVisual {
  return kind === "jet" ? createJetAircraft() : createTrainerAircraft();
}
