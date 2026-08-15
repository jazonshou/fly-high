import type {
  CameraMode,
  FlightVisualState,
  QualityLevel,
  RenderDiagnostics,
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";
import type { FlightRendererOptions } from "./FlightRenderer";
import { isInsideAirportSceneryClearance } from "./TerrainRenderer";
import type { FlightRenderingSystem } from "./types";

function sceneryHash01(x: number, z: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(z, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

interface TerrainRidgeProfile {
  distance: number;
  heights: Float32Array;
}

interface CachedScenerySample {
  height: number;
  isRunway: boolean;
}

interface CanvasRidgeRefreshInput {
  hasProfiles: boolean;
  anchorX: number;
  anchorZ: number;
  cachedHeading: number;
  lastRefreshTime: number;
  positionX: number;
  positionZ: number;
  heading: number;
  simulationTime: number;
}

export function shouldRefreshCanvasRidgeProfiles(input: CanvasRidgeRefreshInput): boolean {
  if (!input.hasProfiles) return true;
  const movedSquared =
    (input.positionX - input.anchorX) ** 2 + (input.positionZ - input.anchorZ) ** 2;
  const headingDelta = Number.isFinite(input.cachedHeading)
    ? Math.abs(
        Math.atan2(
          Math.sin(input.heading - input.cachedHeading),
          Math.cos(input.heading - input.cachedHeading),
        ),
      )
    : Number.POSITIVE_INFINITY;
  const meaningfulChange = movedSquared >= 350 ** 2 || headingDelta >= Math.PI / 30;
  const cadenceReady =
    input.simulationTime < input.lastRefreshTime ||
    input.simulationTime - input.lastRefreshTime >= 0.35;
  return meaningfulChange && cadenceReady;
}

/**
 * A dependency-free compatibility view for browsers where WebGL 2 is blocked
 * (remote desktops, virtualized previews, locked-down enterprise machines).
 * The flight model and all controls remain identical; only presentation changes.
 */
export class CanvasFlightRenderer implements FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: FlightRendererOptions;
  private readonly replacedCanvas: HTMLCanvasElement | null;
  private readonly resizeObserver: ResizeObserver;
  private cameraMode: CameraMode = "chase";
  private quality: QualityLevel;
  private reducedMotion: boolean;
  private timeOfDay: TimeOfDayPreset = "day";
  private weather: WeatherPreset = "breezy";
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private frameTime = 16.7;
  private ridgeProfiles: TerrainRidgeProfile[] = [];
  private ridgeAnchorX = Number.NaN;
  private ridgeAnchorZ = Number.NaN;
  private ridgeHeading = Number.NaN;
  private ridgeRefreshTime = Number.NEGATIVE_INFINITY;
  private readonly scenerySampleCache = new Map<string, CachedScenerySample>();
  private diagnostics: RenderDiagnostics = {
    fps: 60,
    frameTime: 16.7,
    drawCalls: 1,
    triangles: 0,
    geometries: 0,
    textures: 0,
    terrainTiles: 0,
  };

  constructor(options: FlightRendererOptions) {
    let canvas = options.canvas;
    let context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.insertAdjacentElement("afterend", replacement);
      canvas.style.display = "none";
      this.replacedCanvas = options.canvas;
      canvas = replacement;
      context = canvas.getContext("2d", { alpha: false });
    } else {
      this.replacedCanvas = null;
    }
    if (!context) throw new Error("This browser cannot create a canvas renderer.");
    this.domElement = canvas;
    this.context = context;
    this.options = { ...options, canvas };
    this.quality = options.quality;
    this.reducedMotion = options.reducedMotion;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
  }

  setQuality(quality: QualityLevel): void {
    this.quality = quality;
    this.ridgeProfiles = [];
    this.scenerySampleCache.clear();
    this.resize();
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  setAtmosphere(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): void {
    this.timeOfDay = timeOfDay;
    this.weather = weather;
  }

  render(state: FlightVisualState, deltaSeconds: number): void {
    const context = this.context;
    const width = this.width;
    const height = this.height;
    const bank = (-state.bank * Math.PI) / 180;
    const pitchOffset = state.pitch * Math.min(4.4, height / 170);
    const buffet = !this.reducedMotion && state.stalled && !state.onGround
      ? Math.sin(state.simulationTime * 39) * 3
      : 0;

    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    this.drawSky(context, width, height, state.simulationTime);
    this.ensureRidgeProfiles(state);

    context.save();
    context.translate(width * 0.5 + buffet, height * 0.49 + pitchOffset - buffet * 0.45);
    context.rotate(bank);
    this.drawWorld(context, width, height, state);
    context.restore();

    this.drawClouds(context, width, height, state);
    if (this.cameraMode === "cockpit") this.drawCockpit(context, width, height, state);
    else this.drawAircraft(context, width, height, state, this.cameraMode === "cinematic");
    this.drawCompatibilityBadge(context, width, height);
    this.updateDiagnostics(deltaSeconds);
  }

  getDiagnostics(): RenderDiagnostics {
    return this.diagnostics;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    if (this.replacedCanvas) {
      this.domElement.remove();
      this.replacedCanvas.style.display = "";
    }
  }

  private resize(): void {
    const canvas = this.options.canvas;
    this.width = Math.max(1, canvas.clientWidth || window.innerWidth);
    this.height = Math.max(1, canvas.clientHeight || window.innerHeight);
    const qualityLimit = this.quality === "high" ? 1.5 : this.quality === "medium" ? 1.15 : 0.9;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, qualityLimit);
    canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
    canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
  }

  private drawSky(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    time: number,
  ): void {
    const colors = this.timeOfDay === "dawn"
      ? ["#182f49", "#a17773", "#dca47e"]
      : this.timeOfDay === "golden"
        ? ["#31566a", "#c49a75", "#e2b776"]
        : ["#2c566a", "#91adb4", "#d9c6a0"];
    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, colors[0] ?? "#2c566a");
    sky.addColorStop(0.48, colors[1] ?? "#91adb4");
    sky.addColorStop(1, colors[2] ?? "#d9c6a0");
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    const sunX = width * 0.79;
    const sunY =
      height * (this.timeOfDay === "day" ? 0.2 : 0.34) + Math.sin(time * 0.01) * 2;
    const glow = context.createRadialGradient(sunX, sunY, 1, sunX, sunY, Math.min(width, height) * 0.13);
    glow.addColorStop(0, "rgba(255, 245, 204, .9)");
    glow.addColorStop(0.15, "rgba(255, 226, 157, .36)");
    glow.addColorStop(1, "rgba(255, 215, 146, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height * 0.55);
  }

  private drawWorld(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: FlightVisualState,
  ): void {
    context.fillStyle = this.weather === "cloudy" ? "#526962" : "#527767";
    context.fillRect(-width, 0, width * 2, height * 1.5);
    const farthest = this.ridgeProfiles[0];
    const far = this.ridgeProfiles[1];
    const middle = this.ridgeProfiles[2];
    const near = this.ridgeProfiles[3];
    if (farthest) this.drawTerrainRidge(context, width, state, farthest, "#7e8a7a", 0.42);
    if (far) this.drawTerrainRidge(context, width, state, far, "#687966", 0.58);
    if (middle) this.drawTerrainRidge(context, width, state, middle, "#4d684f", 0.76);
    if (near) this.drawTerrainRidge(context, width, state, near, "#34553f", 0.96);

    const ground = context.createLinearGradient(0, 0, 0, height * 0.7);
    ground.addColorStop(0, "rgba(64, 91, 71, .16)");
    ground.addColorStop(0.5, "rgba(38, 70, 51, .56)");
    ground.addColorStop(1, "rgba(15, 36, 30, .96)");
    context.fillStyle = ground;
    context.fillRect(-width, 0, width * 2, height * 1.5);

    this.drawGroundBands(context, width, height, state);

    this.drawRunway(context, width, height, state);

    this.drawSceneryObjects(context, width, state);

    context.strokeStyle = "rgba(230, 218, 174, .11)";
    context.lineWidth = 1;
    for (let index = -5; index <= 5; index += 1) {
      context.beginPath();
      context.moveTo(index * width * 0.16, height);
      context.lineTo(index * width * 0.025, 4);
      context.stroke();
    }
  }

  private drawRunway(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: FlightVisualState,
  ): void {
    const runway = this.options.runway;
    if (!runway || state.position.y - runway.elevation > 1_150) return;
    const heading = (state.heading * Math.PI) / 180;
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);
    const dx = runway.centerX - state.position.x;
    const dz = runway.centerZ - state.position.z;
    const forwardDistance = dx * forwardX + dz * forwardZ;
    if (forwardDistance < -runway.runwayLength || forwardDistance > 7_000) return;
    const lateralDistance = dx * rightX + dz * rightZ;
    const projectionDistance = Math.max(260, forwardDistance + runway.runwayLength * 0.45);
    const centre = Math.max(-width, Math.min(width, (lateralDistance / projectionDistance) * width * 0.72));
    const distanceScale = Math.max(0.18, Math.min(1, 1_100 / projectionDistance));
    const nearHalfWidth = width * 0.13 * distanceScale;
    const farHalfWidth = Math.max(2.5, nearHalfWidth * 0.055);
    const farY = Math.max(1, Math.min(height * 0.48, forwardDistance / 5_500 * height * 0.28));
    const nearY = height * (0.5 + distanceScale * 0.72);

    context.fillStyle = "#303b3b";
    context.beginPath();
    context.moveTo(centre - farHalfWidth, farY);
    context.lineTo(centre + farHalfWidth, farY);
    context.lineTo(centre + nearHalfWidth, nearY);
    context.lineTo(centre - nearHalfWidth, nearY);
    context.closePath();
    context.fill();

    context.strokeStyle = "rgba(238, 232, 205, .9)";
    context.lineWidth = Math.max(1, distanceScale * 2.2);
    context.setLineDash([Math.max(5, 22 * distanceScale), Math.max(7, 28 * distanceScale)]);
    context.beginPath();
    context.moveTo(centre, farY);
    context.lineTo(centre, nearY);
    context.stroke();
    context.setLineDash([]);
  }

  private drawTerrainRidge(
    context: CanvasRenderingContext2D,
    width: number,
    state: FlightVisualState,
    profile: TerrainRidgeProfile,
    color: string,
    verticalExaggeration: number,
  ): void {
    const { distance, heights } = profile;
    const points = heights.length - 1;
    const focalLength = width * 0.72;
    context.beginPath();
    context.moveTo(-width, this.height);
    for (let index = 0; index <= points; index += 1) {
      const screen = index / points;
      const terrainHeight = heights[index] ?? 0;
      const relative = Math.max(-1_800, Math.min(2_000, terrainHeight - state.position.y));
      const y = -(relative / distance) * focalLength * verticalExaggeration;
      context.lineTo((screen - 0.5) * width * 1.45, y);
    }
    context.lineTo(width, this.height);
    context.closePath();
    context.fillStyle = color;
    context.fill();
  }

  private ensureRidgeProfiles(state: FlightVisualState): void {
    const heading = (state.heading * Math.PI) / 180;
    if (
      !shouldRefreshCanvasRidgeProfiles({
        hasProfiles: this.ridgeProfiles.length > 0,
        anchorX: this.ridgeAnchorX,
        anchorZ: this.ridgeAnchorZ,
        cachedHeading: this.ridgeHeading,
        lastRefreshTime: this.ridgeRefreshTime,
        positionX: state.position.x,
        positionZ: state.position.z,
        heading,
        simulationTime: state.simulationTime,
      })
    ) {
      return;
    }

    const points = this.quality === "low" ? 20 : this.quality === "high" ? 46 : 32;
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);
    this.ridgeProfiles = [18_000, 10_500, 5_600, 2_800].map((distance) => {
      const heights = new Float32Array(points + 1);
      for (let index = 0; index <= points; index += 1) {
        const screen = index / points;
        const lateral = (screen * 2 - 1) * distance * 0.72;
        const worldX = state.position.x + forwardX * distance + rightX * lateral;
        const worldZ = state.position.z + forwardZ * distance + rightZ * lateral;
        heights[index] = this.options.terrainSample(worldX, worldZ).height;
      }
      return { distance, heights };
    });
    this.ridgeAnchorX = state.position.x;
    this.ridgeAnchorZ = state.position.z;
    this.ridgeHeading = heading;
    this.ridgeRefreshTime = state.simulationTime;
  }

  private drawGroundBands(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: FlightVisualState,
  ): void {
    const phase = Math.floor((state.position.x + state.position.z) / 600);
    const rows = this.quality === "low" ? 5 : 8;
    for (let row = 0; row < rows; row += 1) {
      const start = row / rows;
      const end = (row + 1) / rows;
      const nearY = Math.pow(end, 1.7) * height * 0.9;
      const farY = Math.pow(start, 1.7) * height * 0.9;
      const variation = sceneryHash01(phase + row, row, this.options.seed);
      context.fillStyle =
        row % 2 === 0
          ? `rgba(80, ${Math.round(103 + variation * 18)}, 66, .10)`
          : `rgba(29, ${Math.round(66 + variation * 16)}, 43, .12)`;
      context.beginPath();
      context.moveTo(-width, farY);
      context.lineTo(width, farY);
      context.lineTo(width, nearY);
      context.lineTo(-width, nearY);
      context.closePath();
      context.fill();
    }
  }

  private drawSceneryObjects(
    context: CanvasRenderingContext2D,
    width: number,
    state: FlightVisualState,
  ): void {
    const cellSize = this.quality === "low" ? 620 : 480;
    const radius = this.quality === "high" ? 6_200 : 5_100;
    const minCellX = Math.floor((state.position.x - radius) / cellSize);
    const maxCellX = Math.ceil((state.position.x + radius) / cellSize);
    const minCellZ = Math.floor((state.position.z - radius) / cellSize);
    const maxCellZ = Math.ceil((state.position.z + radius) / cellSize);
    const heading = (state.heading * Math.PI) / 180;
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);
    const focalLength = width * 0.72;
    const visible: Array<{
      forward: number;
      screenX: number;
      groundY: number;
      size: number;
      tone: number;
      rock: boolean;
    }> = [];

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const density = sceneryHash01(cellX, cellZ, this.options.seed ^ 0x7a31);
        if (density > 0.66) continue;
        const worldX =
          (cellX + 0.12 + sceneryHash01(cellX, cellZ, this.options.seed ^ 0x319d) * 0.76) *
          cellSize;
        const worldZ =
          (cellZ + 0.12 + sceneryHash01(cellZ, cellX, this.options.seed ^ 0x81f3) * 0.76) *
          cellSize;
        const dx = worldX - state.position.x;
        const dz = worldZ - state.position.z;
        const forward = dx * forwardX + dz * forwardZ;
        if (forward < 260 || forward > radius) continue;
        const lateral = dx * rightX + dz * rightZ;
        if (Math.abs(lateral) > forward * 0.92) continue;
        if (this.isInsideCanvasRunwayClearance(worldX, worldZ)) continue;
        const sample = this.getCachedScenerySample(cellSize, cellX, cellZ, worldX, worldZ);
        if (sample.height < 5 || sample.height > 1_250 || sample.isRunway) continue;
        const screenX = (lateral / forward) * focalLength;
        const groundY = -((sample.height - state.position.y) / forward) * focalLength;
        const tone = sceneryHash01(cellX, cellZ, this.options.seed ^ 0x9901);
        const rock = sceneryHash01(cellZ, cellX, this.options.seed ^ 0x4f11) > 0.94;
        const worldHeight = rock ? 9 + tone * 8 : 20 + tone * 24;
        const size = Math.max(1.5, Math.min(34, (worldHeight / forward) * focalLength));
        visible.push({ forward, screenX, groundY, size, tone, rock });
      }
    }
    visible.sort((first, second) => second.forward - first.forward);
    for (const object of visible) {
      const haze = Math.min(0.72, object.forward / radius);
      if (object.rock) {
        context.fillStyle = `rgba(91, 91, 82, ${0.82 - haze * 0.45})`;
        context.beginPath();
        context.ellipse(
          object.screenX,
          object.groundY - object.size * 0.22,
          object.size * 0.58,
          object.size * 0.38,
          object.tone * 0.7,
          0,
          Math.PI * 2,
        );
        context.fill();
        continue;
      }
      context.fillStyle = `rgba(${Math.round(34 + haze * 62)}, ${Math.round(70 + haze * 48)}, ${Math.round(43 + haze * 49)}, ${0.94 - haze * 0.42})`;
      context.beginPath();
      context.moveTo(object.screenX, object.groundY - object.size);
      context.lineTo(object.screenX - object.size * 0.42, object.groundY);
      context.lineTo(object.screenX + object.size * 0.42, object.groundY);
      context.closePath();
      context.fill();
      if (object.size > 7) {
        context.fillStyle = `rgba(55, 46, 31, ${0.74 - haze * 0.35})`;
        context.fillRect(
          object.screenX - Math.max(0.7, object.size * 0.035),
          object.groundY - object.size * 0.28,
          Math.max(1.2, object.size * 0.07),
          object.size * 0.3,
        );
      }
    }
  }

  private getCachedScenerySample(
    cellSize: number,
    cellX: number,
    cellZ: number,
    worldX: number,
    worldZ: number,
  ): CachedScenerySample {
    const key = `${cellSize}:${cellX}:${cellZ}`;
    const cached = this.scenerySampleCache.get(key);
    if (cached) return cached;
    if (this.scenerySampleCache.size >= 1_600) this.scenerySampleCache.clear();
    const sample = this.options.terrainSample(worldX, worldZ);
    const compact = { height: sample.height, isRunway: sample.isRunway === true };
    this.scenerySampleCache.set(key, compact);
    return compact;
  }

  private isInsideCanvasRunwayClearance(x: number, z: number): boolean {
    return isInsideAirportSceneryClearance(this.options.runway, x, z);
  }

  private drawClouds(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: FlightVisualState,
  ): void {
    context.save();
    context.globalAlpha =
      this.weather === "cloudy" ? 0.58 : this.weather === "clear" ? 0.24 : 0.38;
    context.fillStyle = "#e7ede7";
    const baseCount = this.quality === "low" ? 4 : 7;
    const count =
      this.weather === "clear"
        ? Math.max(2, baseCount - 3)
        : this.weather === "cloudy"
          ? baseCount + 3
          : baseCount;
    for (let index = 0; index < count; index += 1) {
      const drift = (state.simulationTime * (2.5 + index * 0.18)) % (width + 320);
      const x = ((index * 263 + drift) % (width + 320)) - 160;
      const y = height * (0.13 + ((index * 37) % 21) / 100);
      const size = 46 + (index % 3) * 18;
      context.beginPath();
      context.ellipse(x, y, size * 1.45, size * 0.35, 0, 0, Math.PI * 2);
      context.ellipse(x - size * 0.52, y + 3, size * 0.72, size * 0.28, 0, 0, Math.PI * 2);
      context.ellipse(x + size * 0.48, y + 5, size * 0.8, size * 0.3, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  private drawAircraft(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: FlightVisualState,
    cinematic: boolean,
  ): void {
    const scale = Math.min(width, height) / (cinematic ? 42 : 31);
    const centerX = width * (cinematic ? 0.43 : 0.5);
    const centerY = height * (cinematic ? 0.57 : 0.67);
    context.save();
    context.translate(centerX, centerY);
    context.rotate((state.bank * Math.PI) / 900);
    context.shadowColor = "rgba(0, 0, 0, .45)";
    context.shadowBlur = scale * 0.45;
    context.fillStyle = "#e5e1d3";
    context.beginPath();
    context.moveTo(0, -scale * 1.8);
    context.lineTo(scale * 0.46, scale * 1.25);
    context.lineTo(scale * 0.26, scale * 1.85);
    context.lineTo(-scale * 0.26, scale * 1.85);
    context.lineTo(-scale * 0.46, scale * 1.25);
    context.closePath();
    context.fill();
    context.fillStyle = "#d7d1c1";
    context.fillRect(-scale * 4.6, scale * 0.18, scale * 9.2, scale * 0.5);
    context.fillRect(-scale * 1.85, scale * 1.35, scale * 3.7, scale * 0.32);
    context.fillStyle = "#b64631";
    context.fillRect(-scale * 4.6, scale * 0.18, scale * 1.25, scale * 0.5);
    context.fillRect(scale * 3.35, scale * 0.18, scale * 1.25, scale * 0.5);
    context.fillRect(-scale * 0.3, -scale * 1.65, scale * 0.6, scale * 0.72);
    context.fillStyle = "#1a333b";
    context.fillRect(-scale * 0.32, -scale * 0.68, scale * 0.64, scale * 0.68);
    context.restore();
  }

  private drawCockpit(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: FlightVisualState,
  ): void {
    context.fillStyle = "rgba(10, 18, 20, .94)";
    context.beginPath();
    context.moveTo(0, height);
    context.lineTo(0, height * 0.78);
    context.quadraticCurveTo(width * 0.5, height * 0.65, width, height * 0.78);
    context.lineTo(width, height);
    context.closePath();
    context.fill();
    context.strokeStyle = "rgba(20, 31, 33, .92)";
    context.lineWidth = Math.max(7, width * 0.012);
    context.beginPath();
    context.moveTo(width * 0.17, height);
    context.lineTo(width * 0.29, 0);
    context.moveTo(width * 0.83, height);
    context.lineTo(width * 0.71, 0);
    context.stroke();
    context.fillStyle = "#cfd4c2";
    context.font = `600 ${Math.max(10, width * 0.011)}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.fillText(`${Math.round(state.engineRpm)} RPM`, width * 0.5, height * 0.87);
  }

  private drawCompatibilityBadge(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    context.save();
    context.fillStyle = "rgba(5, 18, 23, .58)";
    context.fillRect(width - 154, height - 29, 144, 19);
    context.fillStyle = "rgba(220, 231, 218, .72)";
    context.font = "9px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("COMPATIBILITY RENDERER", width - 82, height - 16);
    context.restore();
  }

  private updateDiagnostics(deltaSeconds: number): void {
    const milliseconds = Math.max(1, Math.min(100, deltaSeconds * 1_000));
    this.frameTime += (milliseconds - this.frameTime) * 0.08;
    this.diagnostics = {
      ...this.diagnostics,
      fps: 1_000 / this.frameTime,
      frameTime: this.frameTime,
    };
  }
}
