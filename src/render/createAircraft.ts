import * as THREE from "three";
import type { FlightVisualState } from "@/src/game/types";

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

export function createAircraft(): AircraftVisual {
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
  const tireMaterial = standardMaterial(0x07090a, { roughness: 1, metalness: 0 });
  const hubMaterial = standardMaterial(0x718086, { roughness: 0.38, metalness: 0.62 });
  const lampRed = standardMaterial(0xff493d, { emissive: 0xff2018, emissiveIntensity: 2 });
  const lampGreen = standardMaterial(0x5dffab, { emissive: 0x24ff83, emissiveIntensity: 2 });

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

  const wing = mesh(new THREE.BoxGeometry(2.05, 0.13, 10.8), bodyMaterial);
  wing.position.set(0.3, 0.28, 0);
  group.add(wing);

  const wingAccent = mesh(new THREE.BoxGeometry(0.52, 0.145, 10.82), accentMaterial);
  wingAccent.position.set(0.78, 0.28, 0);
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
  group.add(leftLight, rightLight);

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
