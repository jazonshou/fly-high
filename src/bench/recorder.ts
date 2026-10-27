import type {
  CameraMode,
  FlightVisualState,
  QualityLevel,
  RenderDiagnostics,
  WeatherPreset,
} from "@/src/game/types";
import type { RendererBenchProbe } from "@/src/render/FlightRenderer";
import type {
  FlightRenderingSystem,
  ScreenPoint,
  TerrainAuthorityPublisher,
} from "@/src/render/types";
import type { PresentationCadence } from "@/src/render/webgpu/core/presentationCadence";
import type { RenderingMode } from "@/src/settings";
import type { EnvironmentClock } from "@/src/world/environmentClock";
import type { AirportDefinition } from "@/src/world/types";

/**
 * `?bench=1`: the renderer decorator. FlightGame hands the renderer it just
 * created to the bench, and keeps the decorator in its place; `renderLoop`
 * and everything else in FlightGame stay as they are. Each frame the
 * decorator swaps the simulation's state for the scripted flight, times
 * `render()`, reads the renderer's probe and passes all of it to the port.
 * It stores nothing per frame itself; the port's owner keeps the buffers.
 */

/** What the decorator calls, frame by frame. The step controller implements it. */
export interface BenchFramePort {
  /**
   * The state to draw in a frame whose `render()` begins at `now`
   * (`performance.now()` milliseconds): the settle pose or the scripted path,
   * or null to draw the game's own state.
   */
  stateFor(now: number): FlightVisualState | null;
  /**
   * A frame finished: the inner `render()` ran from `renderStart` to
   * `renderEnd`, and `probe` was read after it. The probe is one object,
   * rewritten every frame, so keep its values, not the object.
   */
  afterFrame(renderStart: number, renderEnd: number, probe: Readonly<RendererBenchProbe>): void;
  /** The inner `render()` threw. The decorator rethrows it to FlightGame next. */
  renderThrew(error: unknown): void;
  /** The decorator's own milliseconds this frame, outside the inner `render()`. */
  overhead(milliseconds: number): void;
  /** The decorator let go of this port: disposed, or replaced by a later attach. */
  detached?(): void;
  /**
   * True once the step is over and its page is about to leave: frames are
   * not drawn at all, so the main thread and the GPU are free for the next
   * page's load. On a slow machine one more frame can hold the navigation
   * for seconds.
   */
  holdFrames?(): boolean;
}

/** The game's renderer interface plus the probe, which `FlightRenderer` has. */
export interface BenchProbedRenderer extends FlightRenderingSystem {
  readBenchProbe(into: RendererBenchProbe): void;
}

/**
 * Calls that would change the measured work once the flight is under way.
 * Before the first frame they pass, so FlightGame's own setup (publisher,
 * camera, atmosphere) lands as it does for a player.
 */
type IgnoredCall =
  | "setQuality"
  | "setRenderingMode"
  | "setReducedMotion"
  | "setAtmosphere"
  | "setViewerMode"
  | "setCameraMode"
  | "startBudgetProbe";

export class BenchRenderer implements FlightRenderingSystem {
  private port: BenchFramePort | null;
  private readonly probe: RendererBenchProbe;
  private started = false;
  private framesRendered = 0;
  private ignoredTotal = 0;
  private readonly ignoredByName: Partial<Record<IgnoredCall, number>> = {};

  constructor(
    private readonly inner: BenchProbedRenderer,
    port: BenchFramePort,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.port = port;
    // `readBenchProbe` writes every field, so the probe has its final shape
    // before the first frame and is never reallocated.
    this.probe = {} as RendererBenchProbe;
    inner.readBenchProbe(this.probe);
  }

  get domElement(): HTMLCanvasElement {
    return this.inner.domElement;
  }

  /** Frames the inner renderer finished. */
  get frames(): number {
    return this.framesRendered;
  }

  get attached(): boolean {
    return this.port !== null;
  }

  /** Calls dropped since the first frame; any at all is a warning in the report. */
  get ignoredRendererCalls(): number {
    return this.ignoredTotal;
  }

  get ignoredCalls(): Readonly<Partial<Record<IgnoredCall, number>>> {
    return this.ignoredByName;
  }

  render(state: FlightVisualState, deltaSeconds: number): void {
    this.started = true;
    const port = this.port;
    if (port === null) {
      this.inner.render(state, deltaSeconds);
      return;
    }
    if (port.holdFrames?.()) return;
    const scriptStart = this.now();
    const scripted = port.stateFor(scriptStart);
    const renderStart = this.now();
    try {
      // `deltaSeconds` stays FlightGame's clamped rAF delta.
      this.inner.render(scripted ?? state, deltaSeconds);
    } catch (error) {
      try {
        port.renderThrew(error);
      } catch {
        // FlightGame's stop path must see the renderer's error, not the bench's.
      }
      throw error;
    }
    const renderEnd = this.now();
    this.framesRendered += 1;
    this.inner.readBenchProbe(this.probe);
    port.afterFrame(renderStart, renderEnd, this.probe);
    port.overhead(this.now() - renderEnd + (renderStart - scriptStart));
  }

  setCameraMode(mode: CameraMode): void {
    if (mode !== "chase" && this.ignoreOnceFlying("setCameraMode")) return;
    this.inner.setCameraMode(mode);
  }

  cutCamera(): void {
    this.inner.cutCamera();
  }

  setViewerMode(enabled: boolean): void {
    if (this.ignoreOnceFlying("setViewerMode")) return;
    this.inner.setViewerMode(enabled);
  }

  sampleGroundHeight(x: number, z: number): number {
    return this.inner.sampleGroundHeight(x, z);
  }

  setQuality(quality: QualityLevel): void {
    if (this.ignoreOnceFlying("setQuality")) return;
    this.inner.setQuality(quality);
  }

  setRenderingMode(mode: RenderingMode): void {
    if (this.ignoreOnceFlying("setRenderingMode")) return;
    this.inner.setRenderingMode(mode);
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.ignoreOnceFlying("setReducedMotion")) return;
    this.inner.setReducedMotion(reducedMotion);
  }

  setAirports(airports: readonly Readonly<AirportDefinition>[]): void {
    this.inner.setAirports(airports);
  }

  /** Always forwarded: the cadence is part of what a player's game does, so the bench measures it. */
  setPresentationCadence(cadence: PresentationCadence | null): void {
    this.inner.setPresentationCadence(cadence);
  }

  /** Forwarded for the same reason; the bench's flight never pauses. */
  setGovernorHold(held: boolean): void {
    this.inner.setGovernorHold(held);
  }

  projectWorldPointToRef(x: number, y: number, z: number, result: ScreenPoint): boolean {
    return this.inner.projectWorldPointToRef(x, y, z, result);
  }

  setTerrainAuthorityPublisher(publisher: TerrainAuthorityPublisher | null): void {
    this.inner.setTerrainAuthorityPublisher(publisher);
  }

  setAtmosphere(clock: EnvironmentClock, weather: WeatherPreset): void {
    if (this.ignoreOnceFlying("setAtmosphere")) return;
    this.inner.setAtmosphere(clock, weather);
  }

  getDiagnostics(): RenderDiagnostics {
    return this.inner.getDiagnostics();
  }

  /** The budget probe deliberately perturbs frames, so the bench never starts it. */
  startBudgetProbe(): boolean {
    this.countIgnored("startBudgetProbe");
    return false;
  }

  /** Stops feeding the port; frames from here on draw the game's own state. */
  detach(): void {
    const port = this.port;
    if (port === null) return;
    this.port = null;
    port.detached?.();
  }

  dispose(): void {
    this.detach();
    this.inner.dispose();
  }

  private ignoreOnceFlying(name: IgnoredCall): boolean {
    if (!this.started) return false;
    this.countIgnored(name);
    return true;
  }

  private countIgnored(name: IgnoredCall): void {
    this.ignoredTotal += 1;
    this.ignoredByName[name] = (this.ignoredByName[name] ?? 0) + 1;
  }
}

/**
 * Where one page's decorator lives. In development, React's StrictMode runs
 * FlightGame's renderer effect twice, so a page can create, dispose and
 * create a renderer again; each attach detaches the decorator before it, and
 * the bench follows the renderer that is actually drawing.
 */
export class BenchRendererSlot {
  private current: BenchRenderer | null = null;

  /** The decorator still feeding its port, or null. */
  get attached(): BenchRenderer | null {
    return this.current?.attached ? this.current : null;
  }

  /**
   * Decorates a renderer FlightGame has just created. FlightGame takes
   * ownership of the renderer only after this returns, so if building the
   * port or the decorator throws, the renderer is disposed here before the
   * error goes on.
   */
  attach(
    inner: BenchProbedRenderer,
    createPort: () => BenchFramePort,
    now?: () => number,
  ): BenchRenderer {
    this.current?.detach();
    this.current = null;
    try {
      this.current = new BenchRenderer(inner, createPort(), now);
      return this.current;
    } catch (error) {
      try {
        inner.dispose();
      } catch {
        // The attach error is the one to report.
      }
      throw error;
    }
  }
}
