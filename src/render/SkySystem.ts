import * as THREE from "three";
import type {
  QualityLevel,
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";

const MAX_CLOUDS = 64;
const CLOUD_WRAP_DISTANCE = 28_000;

interface CloudSeed {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2d(x: number, y: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2d(x0, y0, seed);
  const b = hash2d(x0 + 1, y0, seed);
  const c = hash2d(x0, y0 + 1, seed);
  const d = hash2d(x0 + 1, y0 + 1, seed);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, sx),
    THREE.MathUtils.lerp(c, d, sx),
    sy,
  );
}

/** A tiny generated albedo map avoids shipping a bitmap and breaks up flat cloud shading. */
function createCloudTexture(seed: number): THREE.DataTexture {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let amplitude = 0.55;
      let frequency = 3;
      let noise = 0;
      let normalization = 0;
      for (let octave = 0; octave < 4; octave += 1) {
        noise += valueNoise(u * frequency, v * frequency, seed + octave * 1013) * amplitude;
        normalization += amplitude;
        amplitude *= 0.5;
        frequency *= 2.07;
      }
      const detail = noise / normalization;
      const underside = THREE.MathUtils.smoothstep(v, 0.06, 0.72);
      const value = Math.round(THREE.MathUtils.clamp(188 + detail * 58 + underside * 8, 0, 255));
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = Math.min(255, value + 4);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Minimal attribute merge for the cloud pieces; avoids pulling in a second Three addon bundle. */
function mergeCloudPieces(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flattened = pieces.map((piece) => {
    const result = piece.index ? piece.toNonIndexed() : piece.clone();
    piece.dispose();
    return result;
  });
  const vertexCount = flattened.reduce(
    (count, piece) => count + piece.getAttribute("position").count,
    0,
  );
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  let vertexOffset = 0;
  for (const piece of flattened) {
    const position = piece.getAttribute("position");
    const normal = piece.getAttribute("normal");
    const uv = piece.getAttribute("uv");
    for (let index = 0; index < position.count; index += 1) {
      const target = vertexOffset + index;
      positions[target * 3] = position.getX(index);
      positions[target * 3 + 1] = position.getY(index);
      positions[target * 3 + 2] = position.getZ(index);
      normals[target * 3] = normal.getX(index);
      normals[target * 3 + 1] = normal.getY(index);
      normals[target * 3 + 2] = normal.getZ(index);
      uvs[target * 2] = uv.getX(index);
      uvs[target * 2 + 1] = uv.getY(index);
    }
    vertexOffset += position.count;
    piece.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  return merged;
}

/**
 * One instanced cloud is a merged, irregular volume instead of a lone stretched
 * sphere. Seven low-poly lobes still render in one draw call for the whole sky.
 */
function createCloudGeometry(): THREE.BufferGeometry {
  const lobes = [
    { x: -1.38, y: -0.12, z: 0.05, sx: 1.2, sy: 0.62, sz: 0.86 },
    { x: -0.62, y: 0.18, z: -0.16, sx: 1.12, sy: 0.88, sz: 1.02 },
    { x: 0.18, y: 0.3, z: 0.08, sx: 1.3, sy: 1.02, sz: 1.08 },
    { x: 1.16, y: 0.02, z: -0.04, sx: 1.34, sy: 0.72, sz: 0.95 },
    { x: -0.22, y: -0.08, z: 0.78, sx: 1.18, sy: 0.61, sz: 0.83 },
    { x: 0.48, y: 0.04, z: -0.73, sx: 1.02, sy: 0.72, sz: 0.8 },
    { x: 0.05, y: 0.78, z: -0.02, sx: 0.77, sy: 0.7, sz: 0.72 },
  ];
  const pieces = lobes.map((lobe, index) => {
    const geometry = new THREE.IcosahedronGeometry(1, index === 2 ? 2 : 1);
    geometry.scale(lobe.sx, lobe.sy, lobe.sz);
    geometry.translate(lobe.x, lobe.y, lobe.z);
    return geometry;
  });
  const merged = mergeCloudPieces(pieces);
  merged.computeBoundingSphere();
  return merged;
}

function wrapAround(value: number, center: number, span: number): number {
  const halfSpan = span * 0.5;
  return center + ((((value - center + halfSpan) % span) + span) % span) - halfSpan;
}

export class SkySystem {
  readonly group = new THREE.Group();
  readonly sunLight: THREE.DirectionalLight;
  readonly hemisphereLight: THREE.HemisphereLight;

  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly sun: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly clouds: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly cloudTexture: THREE.DataTexture;
  private readonly sunPosition = new THREE.Vector3(4_300, 5_900, -7_800);
  private readonly cloudSeeds: CloudSeed[] = [];
  private readonly cloudMatrix = new THREE.Matrix4();
  private readonly cloudPosition = new THREE.Vector3();
  private readonly cloudScale = new THREE.Vector3();
  private readonly cloudQuaternion = new THREE.Quaternion();
  private readonly cloudEuler = new THREE.Euler();
  private cloudDrift = 0;
  private timeOfDay: TimeOfDayPreset = "day";
  private weather: WeatherPreset = "breezy";
  private quality: QualityLevel = "medium";

  constructor(seed = 1) {
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x3588bb) },
        upperHazeColor: { value: new THREE.Color(0x91bed1) },
        horizonColor: { value: new THREE.Color(0xd2ddd3) },
        bottomColor: { value: new THREE.Color(0x69776a) },
        sunDirection: { value: new THREE.Vector3(0.4, 0.55, -0.72).normalize() },
        sunGlow: { value: new THREE.Color(0xffdda0) },
        hazeAmount: { value: 0.3 },
      },
      vertexShader: `
        varying vec3 vWorldDirection;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldDirection = normalize(worldPosition.xyz - cameraPosition);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vWorldDirection;
        uniform vec3 topColor;
        uniform vec3 upperHazeColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        uniform vec3 sunDirection;
        uniform vec3 sunGlow;
        uniform float hazeAmount;

        void main() {
          float elevation = clamp(vWorldDirection.y, -1.0, 1.0);
          float skyAmount = smoothstep(-0.075, 0.68, elevation);
          float zenithAmount = pow(max(elevation, 0.0), 0.42);
          vec3 skyColor = mix(bottomColor, horizonColor, skyAmount);
          skyColor = mix(skyColor, upperHazeColor, smoothstep(0.01, 0.26, elevation));
          skyColor = mix(skyColor, topColor, zenithAmount);

          float towardSun = max(dot(vWorldDirection, sunDirection), 0.0);
          float disc = smoothstep(0.99982, 0.99994, towardSun);
          float innerHalo = pow(towardSun, 96.0);
          float outerHalo = pow(towardSun, 9.0);
          float horizonHaze = exp(-abs(elevation) * 10.0) * hazeAmount;
          skyColor = mix(skyColor, horizonColor, horizonHaze * 0.34);
          skyColor += sunGlow * (disc * 1.25 + innerHalo * 0.34 + outerHalo * 0.075);

          // Sub-perceptual dithering prevents visible gradient bands after tone mapping.
          float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          skyColor += (dither - 0.5) / 255.0;
          gl_FragColor = vec4(skyColor, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(25_000, 40, 22), skyMaterial);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.group.add(this.sky);

    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(105, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff2c4, fog: false, toneMapped: false }),
    );
    this.group.add(this.sun);

    this.sunLight = new THREE.DirectionalLight(0xffe9c2, 2.4);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.camera.near = 100;
    this.sunLight.shadow.camera.far = 9_000;
    this.sunLight.shadow.camera.left = -105;
    this.sunLight.shadow.camera.right = 105;
    this.sunLight.shadow.camera.top = 105;
    this.sunLight.shadow.camera.bottom = -105;
    this.sunLight.shadow.bias = -0.00016;
    this.sunLight.shadow.normalBias = 0.18;
    this.sunLight.shadow.radius = 1.5;
    this.group.add(this.sunLight);

    this.hemisphereLight = new THREE.HemisphereLight(0xbfe4ff, 0x555a45, 1.4);
    this.group.add(this.hemisphereLight);

    this.cloudTexture = createCloudTexture(seed ^ 0x76bb41d3);
    const cloudMaterial = new THREE.MeshStandardMaterial({
      color: 0xf3f3eb,
      map: this.cloudTexture,
      roughness: 1,
      metalness: 0,
      flatShading: false,
      fog: true,
    });
    this.clouds = new THREE.InstancedMesh(createCloudGeometry(), cloudMaterial, MAX_CLOUDS);
    this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.clouds.frustumCulled = false;
    this.clouds.castShadow = false;
    this.clouds.receiveShadow = false;
    this.clouds.renderOrder = -1;
    this.group.add(this.clouds);

    const random = mulberry32(seed ^ 0x9e3779b9);
    const cloudColor = new THREE.Color();
    for (let index = 0; index < MAX_CLOUDS; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 1_900 + Math.sqrt(random()) * 11_500;
      const baseScale = 105 + random() * 115;
      this.cloudSeeds.push({
        x: Math.cos(angle) * radius,
        y: 1_650 + random() * 1_850,
        z: Math.sin(angle) * radius,
        yaw: random() * Math.PI * 2,
        scaleX: baseScale * (1.05 + random() * 0.85),
        scaleY: baseScale * (0.52 + random() * 0.34),
        scaleZ: baseScale * (0.78 + random() * 0.62),
      });
      const brightness = 0.9 + random() * 0.1;
      cloudColor.setRGB(brightness, brightness, Math.min(1, brightness + 0.018));
      this.clouds.setColorAt(index, cloudColor);
    }
    if (this.clouds.instanceColor) this.clouds.instanceColor.needsUpdate = true;
    this.updateCloudCount();
    this.configureShadowQuality();
  }

  update(
    cameraPosition: THREE.Vector3,
    deltaSeconds: number,
    originX = 0,
    originZ = 0,
  ): void {
    this.sky.position.copy(cameraPosition);
    this.sun.position.copy(cameraPosition).add(this.sunPosition);
    this.sunLight.position.copy(cameraPosition).addScaledVector(this.sunPosition, 0.72);

    const driftSpeed = this.weather === "clear" ? 4 : this.weather === "cloudy" ? 12 : 7;
    this.cloudDrift += deltaSeconds * driftSpeed;
    const absoluteCameraX = cameraPosition.x + originX;
    const absoluteCameraZ = cameraPosition.z + originZ;
    for (let index = 0; index < this.cloudSeeds.length; index += 1) {
      const seed = this.cloudSeeds[index]!;
      const absoluteX = wrapAround(
        seed.x + this.cloudDrift,
        absoluteCameraX,
        CLOUD_WRAP_DISTANCE,
      );
      const absoluteZ = wrapAround(
        seed.z + this.cloudDrift * 0.18,
        absoluteCameraZ,
        CLOUD_WRAP_DISTANCE,
      );
      this.cloudPosition.set(absoluteX - originX, seed.y, absoluteZ - originZ);
      this.cloudScale.set(seed.scaleX, seed.scaleY, seed.scaleZ);
      this.cloudEuler.set(0, seed.yaw, 0);
      this.cloudQuaternion.setFromEuler(this.cloudEuler);
      this.cloudMatrix.compose(this.cloudPosition, this.cloudQuaternion, this.cloudScale);
      this.clouds.setMatrixAt(index, this.cloudMatrix);
    }
    this.clouds.instanceMatrix.needsUpdate = true;

    const timeValue = this.timeOfDay === "dawn" ? 0.23 : this.timeOfDay === "golden" ? 0.42 : 0.58;
    const daylight = THREE.MathUtils.smoothstep(timeValue, 0.12, 0.5);
    this.sunLight.intensity = 0.68 + daylight * 1.62;
    this.hemisphereLight.intensity = 0.62 + daylight * 0.78;
  }

  setQuality(quality: QualityLevel): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.configureShadowQuality();
    this.updateCloudCount();
  }

  setAtmosphere(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): void {
    this.timeOfDay = timeOfDay;
    this.weather = weather;
    const material = this.sky.material;
    const topColor = material.uniforms.topColor?.value as THREE.Color | undefined;
    const upperHazeColor = material.uniforms.upperHazeColor?.value as THREE.Color | undefined;
    const horizonColor = material.uniforms.horizonColor?.value as THREE.Color | undefined;
    const bottomColor = material.uniforms.bottomColor?.value as THREE.Color | undefined;
    const sunGlow = material.uniforms.sunGlow?.value as THREE.Color | undefined;
    const hazeAmount = material.uniforms.hazeAmount;
    if (timeOfDay === "dawn") {
      topColor?.set(0x234f79);
      upperHazeColor?.set(0x9b94a9);
      horizonColor?.set(0xd09a83);
      bottomColor?.set(0x645c58);
      sunGlow?.set(0xffb27d);
      this.sunPosition.set(6_700, 2_100, -6_100);
      this.sunLight.color.set(0xffb783);
      this.hemisphereLight.color.set(0x9ec3e1);
      this.hemisphereLight.groundColor.set(0x4d493e);
    } else if (timeOfDay === "golden") {
      topColor?.set(0x397ba2);
      upperHazeColor?.set(0x9eb6bd);
      horizonColor?.set(0xd9b386);
      bottomColor?.set(0x716653);
      sunGlow?.set(0xffcf88);
      this.sunPosition.set(6_200, 3_100, -7_200);
      this.sunLight.color.set(0xffc982);
      this.hemisphereLight.color.set(0xb9d5e5);
      this.hemisphereLight.groundColor.set(0x5b5744);
    } else {
      topColor?.set(0x3588bb);
      upperHazeColor?.set(0x91bed1);
      horizonColor?.set(0xd2ddd3);
      bottomColor?.set(0x69776a);
      sunGlow?.set(0xffdda0);
      this.sunPosition.set(4_300, 5_900, -7_800);
      this.sunLight.color.set(0xffe9c2);
      this.hemisphereLight.color.set(0xbfe4ff);
      this.hemisphereLight.groundColor.set(0x555a45);
    }
    const sunDirection = material.uniforms.sunDirection?.value as THREE.Vector3 | undefined;
    sunDirection?.copy(this.sunPosition).normalize();
    if (hazeAmount) hazeAmount.value = weather === "cloudy" ? 0.68 : weather === "clear" ? 0.18 : 0.34;

    const cloudMaterial = this.clouds.material;
    cloudMaterial.color.set(weather === "cloudy" ? 0xc9d0d0 : 0xf3f3eb);
    cloudMaterial.roughness = weather === "cloudy" ? 0.96 : 1;
    this.updateCloudCount();
  }

  private configureShadowQuality(): void {
    const enabled = this.quality !== "low";
    this.sunLight.castShadow = enabled;
    const mapSize = this.quality === "high" ? 2_048 : 1_024;
    if (this.sunLight.shadow.mapSize.x !== mapSize) {
      this.sunLight.shadow.mapSize.set(mapSize, mapSize);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
    const extent = this.quality === "high" ? 130 : 105;
    this.sunLight.shadow.camera.left = -extent;
    this.sunLight.shadow.camera.right = extent;
    this.sunLight.shadow.camera.top = extent;
    this.sunLight.shadow.camera.bottom = -extent;
    this.sunLight.shadow.camera.updateProjectionMatrix();
  }

  private updateCloudCount(): void {
    const qualityCount = this.quality === "high" ? 64 : this.quality === "medium" ? 46 : 30;
    const weatherAmount = this.weather === "clear" ? 0.48 : this.weather === "cloudy" ? 1 : 0.76;
    this.clouds.count = Math.max(16, Math.floor(qualityCount * weatherAmount));
  }

  dispose(): void {
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.sun.geometry.dispose();
    this.sun.material.dispose();
    this.clouds.geometry.dispose();
    this.clouds.material.dispose();
    this.cloudTexture.dispose();
    this.sunLight.shadow.map?.dispose();
  }
}
