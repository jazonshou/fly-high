"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { FlightAudio } from "@/src/audio";
import { InputManager, type InputAction } from "@/src/input";
import { FlightRenderer } from "@/src/render/FlightRenderer";
import { type FlightRenderingSystem, type ScreenPoint } from "@/src/render/types";
import {
  createRandomSeed,
  DEFAULT_SETTINGS,
  loadSettings,
  readLandformsFromUrl,
  readSeedFromUrl,
  readTerrainFarSwardFromUrl,
  readWorldEvolutionFromUrl,
  saveSettings,
  seedToString,
  urlWithSeed,
  type GameSettings,
} from "@/src/settings";
import { AircraftPicker } from "@/src/ui/AircraftPicker";
import { CarTyrePanel } from "@/src/ui/CarTyrePanel";
import { Hud } from "@/src/ui/Hud";
import { modalTabTarget } from "@/src/ui/modalFocus";
import { SettingsDialog } from "@/src/ui/SettingsPanel";
import { createWorld, sampleTerrain, sampleTerrainHeight, type LandformsOption } from "@/src/world";
import {
  applyAirportMarker,
  createAirportMarkerPlacement,
  createAirportMarkerView,
  formatAirportDistance,
  placeAirportMarker,
  type AirportMarkerView,
} from "@/src/ui/airportMarker";
import {
  AirportNetworkController,
  describeNearestAirport,
  type NearestAirportInfo,
} from "./AirportNetworkController";
import { DisposableScope } from "./DisposableScope";
import { DiagnosticsPoller, nearestAirportReadoutKey } from "./diagnosticsCadence";
import { FreeFlyController } from "./freeFly";
import { SimulationClient } from "./SimulationClient";
import { startFlightControlPump, type FlightControlPump } from "./controlPump";
import {
  airborneGearForAircraft,
  airborneThrottleForAircraft,
  runwayFlapsForAircraft,
  runwayTrimForAircraft,
} from "./spawn";
import {
  INITIAL_VISUAL_STATE,
  type AutolandVisualState,
  type CameraMode,
  type FlightVisualState,
  type RenderDiagnostics,
} from "./types";
import { handoffTrimSeed, heldElevator } from "@/src/sim";
import { isSurfaceSpawn, surfaceSpawnKind, type SpawnKind } from "@/src/workers/protocol";
import { isAircraftKind, isSurfaceVehicleKind, type SurfaceVehicleKind } from "@/src/vehicles/kinds";
import {
  beginTransition,
  createTransitionGate,
  invalidateTransitions,
  isCurrentTransition,
} from "./transitionGate";
import "./flight.css";

type GamePhase = "menu" | "flying" | "paused" | "viewer";

interface ViewerStats {
  x: number;
  y: number;
  z: number;
  agl: number;
  airspeed: number;
  cruise: number;
}

const GRAPHICS_DEVICE_LOST_MESSAGE =
  "The WebGPU device was lost. Reload to recreate the adapter, device, and all GPU resources.";

// `C` steps through these in order. The top and front views come after the
// three that were there first, so those keep their places in the cycle.
const CAMERA_MODES: CameraMode[] = ["chase", "cockpit", "cinematic", "top", "front"];
const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "CHASE CAM",
  cockpit: "COCKPIT",
  cinematic: "ORBIT CAM",
  top: "TOP CAM",
  front: "FRONT CAM",
  freefly: "FREE CAM",
};

const CONTROL_MODE_LABELS: Record<GameSettings["flightMode"], string> = {
  unassisted: "Direct controls",
  pilot: "Pilot damping",
  scenic: "Scenic assist",
};

const PAUSE_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "select:not([disabled])",
  "input:not([disabled])",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** The surface vehicle the player chose, or null when they chose an aircraft. */
function chosenSurfaceVehicle(settings: GameSettings): SurfaceVehicleKind | null {
  return isSurfaceVehicleKind(settings.vehicle) ? settings.vehicle : null;
}

function cycleHud(settings: GameSettings): GameSettings {
  const next = settings.hud === "full" ? "minimal" : settings.hud === "minimal" ? "off" : "full";
  return { ...settings, hud: next };
}

export function FlightGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausePanelRef = useRef<HTMLDivElement>(null);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const rendererRef = useRef<FlightRenderingSystem | null>(null);
  const simulationRef = useRef<SimulationClient | null>(null);
  const inputRef = useRef<InputManager | null>(null);
  const audioRef = useRef<FlightAudio | null>(null);
  const latestStateRef = useRef<FlightVisualState>(INITIAL_VISUAL_STATE);
  const phaseRef = useRef<GamePhase>("menu");
  const settingsRef = useRef<GameSettings>(DEFAULT_SETTINGS);
  const settingsOpenRef = useRef(false);
  const transitionGateRef = useRef(createTransitionGate());
  const cameraModeRef = useRef<CameraMode>("chase");
  const spawnRef = useRef<SpawnKind>("airborne");
  /**
   * The same value as `spawnRef`, as state, because the pause menu RENDERS it
   * — it names the restart after the spawn the flight began at. A ref read
   * during render does not re-render when it changes, so the two are kept in
   * step deliberately rather than one being derived from the other: the ref is
   * what callbacks and the input pump read on the hot path, the state is what
   * the markup reads.
   */
  const [spawnKind, setSpawnKind] = useState<SpawnKind>("airborne");
  /** The live airport list, grown by spawns during the flight. */
  const airportNetworkRef = useRef<AirportNetworkController | null>(null);
  /** Nearest-airport marker: a ref for the frame loop, state for the HUD markup. */
  const nearestAirportShownRef = useRef(false);
  const [nearestAirportShown, setNearestAirportShown] = useState(false);
  const nearestAirportRef = useRef<NearestAirportInfo | null>(null);
  const [nearestAirport, setNearestAirport] = useState<NearestAirportInfo | null>(null);
  const airportMarkerRef = useRef<HTMLDivElement>(null);
  /** The marker's "STQK · 4.2 NM" label, rebuilt with the readout, not per frame. */
  const airportMarkerTextRef = useRef("");
  /**
   * The autoland as of the latest snapshot, and that snapshot's sim time: on
   * the snapshot where it is gone the pilot's input takes over its levers,
   * unless the clock went backwards, which is a new aeroplane (a reset), not a
   * hand-back.
   */
  const lastAutolandRef = useRef<{ state: AutolandVisualState; time: number } | null>(null);
  const lastUiUpdateRef = useRef(0);
  const lastAudioUpdateRef = useRef(0);
  const readyRef = useRef(false);
  const freeFlyRef = useRef<FreeFlyController | null>(null);
  const [viewerStats, setViewerStats] = useState<ViewerStats | null>(null);
  const [phase, setPhase] = useState<GamePhase>("menu");
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seed, setSeed] = useState(0x51a7e);
  const [visualState, setVisualState] = useState<FlightVisualState>(INITIAL_VISUAL_STATE);
  const [diagnostics, setDiagnostics] = useState<RenderDiagnostics | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("chase");
  const [bootstrapped, setBootstrapped] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worldEvolution, setWorldEvolution] = useState<"eroded" | undefined>(undefined);
  const [landforms, setLandforms] = useState<LandformsOption | undefined>(undefined);
  const world = useMemo(
    () => createWorld(seed, {
      ...(worldEvolution ? { worldEvolution } : {}),
      ...(landforms ? { landforms } : {}),
    }),
    [seed, worldEvolution, landforms],
  );

  const updatePhase = useCallback((nextPhase: GamePhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }, []);

  const invalidatePendingTransitions = useCallback(() => {
    invalidateTransitions(transitionGateRef.current);
  }, []);

  const unlockAudio = useCallback(async (): Promise<void> => {
    try {
      await audioRef.current?.unlock();
    } catch {
      // Audio is optional. A blocked/failed AudioContext must not block flight.
    }
  }, []);

  const applySettings = useCallback((next: GameSettings) => {
    if (
      next.aircraft !== settingsRef.current.aircraft
      || next.vehicle !== settingsRef.current.vehicle
    ) invalidatePendingTransitions();
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    rendererRef.current?.setQuality(next.quality);
    rendererRef.current?.setRenderingMode(next.renderingMode);
    rendererRef.current?.setReducedMotion(next.reducedMotion);
    rendererRef.current?.setAtmosphere(
      { dayOfYear: next.dayOfYear, solarTimeHours: next.solarTimeHours },
      next.weather,
    );
    inputRef.current?.updateOptions({
      sensitivity: next.sensitivity,
      deadZone: next.gamepadDeadZone,
      invertPitch: next.invertPitch,
      mouseFlight: next.mouseFlight,
    });
    audioRef.current?.setLevels({
      master: next.masterVolume,
      engine: next.engineVolume,
      wind: next.windVolume,
    });
    simulationRef.current?.setMode(next.flightMode);
    simulationRef.current?.setWeather(next.weather);
    simulationRef.current?.setCarSetup({ gearbox: next.carGearbox, manualClutch: next.carManualClutch });
  }, [invalidatePendingTransitions]);

  const toggleNearestAirport = useCallback(() => {
    const next = !nearestAirportShownRef.current;
    nearestAirportShownRef.current = next;
    setNearestAirportShown(next);
  }, []);

  const toggleAutoland = useCallback(() => {
    if (phaseRef.current !== "flying") return;
    simulationRef.current?.setAutoland(!latestStateRef.current.autoland);
  }, []);

  const changeCamera = useCallback(() => {
    const currentIndex = CAMERA_MODES.indexOf(cameraModeRef.current);
    const next = CAMERA_MODES[(currentIndex + 1) % CAMERA_MODES.length] ?? "chase";
    cameraModeRef.current = next;
    setCameraMode(next);
    rendererRef.current?.setCameraMode(next);
  }, []);

  const openSettings = useCallback(() => {
    invalidatePendingTransitions();
    settingsOpenRef.current = true;
    setSettingsOpen(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }, [invalidatePendingTransitions]);

  const closeSettings = useCallback(() => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
  }, []);

  /** Hands the already-running menu flight to the pilot without a reset. */
  const takeControl = useCallback(async () => {
    const transition = beginTransition(transitionGateRef.current);
    await unlockAudio();
    if (
      !isCurrentTransition(transitionGateRef.current, transition) ||
      phaseRef.current !== "menu" ||
      settingsOpenRef.current
    ) return;
    setError(null);
    inputRef.current?.resetForSpawn(
      "airborne",
      airborneThrottleForAircraft(settingsRef.current.aircraft),
      runwayTrimForAircraft(settingsRef.current.aircraft),
      airborneGearForAircraft(settingsRef.current.aircraft),
    );
    inputRef.current?.setThrottle(latestStateRef.current.throttle);
    // Hand the player an aeroplane that is already trimmed, rather than one
    // whose surfaces snap to neutral the moment they take it.
    //
    // Scenic is excluded and must stay excluded: its own height hold adopts
    // the menu flight's learned trim (`ScenicAltitudeHold.adopt`), so seeding
    // trim as well would be two mechanisms carrying the same elevator and the
    // aeroplane would get twice what it needs.
    //
    // This runs BEFORE `handoff` and through `setTrim`, because the input
    // controller owns trim and re-sends it: seeding anywhere else is undone by
    // its next message. The same number goes to the worker so the trim
    // actuator is not slewing toward a value the controller is about to
    // replace. See `handoffTrimSeed` for the units and the sign.
    const handoffTrim = settingsRef.current.flightMode === "scenic"
      ? 0
      : handoffTrimSeed(
        heldElevator(latestStateRef.current.elevator, latestStateRef.current.trim),
      );
    inputRef.current?.setTrim(handoffTrim);
    spawnRef.current = "airborne";
    setSpawnKind("airborne");
    simulationRef.current?.handoff(settingsRef.current.flightMode, handoffTrim);
    simulationRef.current?.setPaused(false);
    updatePhase("flying");
  }, [unlockAudio, updatePhase]);

  /**
   * Beta terrain viewer: freeze the attract flight, hide the aircraft, and
   * hand the renderer's state seam to the free-fly rig. Everything is
   * additive — leaving the viewer resumes the menu attract exactly.
   */
  const enterViewer = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer || phaseRef.current !== "menu" || settingsOpenRef.current) return;
    invalidatePendingTransitions();
    audioRef.current?.suspend();
    simulationRef.current?.setPaused(true);
    freeFlyRef.current?.dispose();
    freeFlyRef.current = new FreeFlyController({
      canvas: renderer.domElement,
      groundHeight: (x, z) => renderer.sampleGroundHeight(x, z),
      seaLevel: world.seaLevel,
      initialState: latestStateRef.current,
    });
    renderer.setViewerMode(true);
    updatePhase("viewer");
  }, [invalidatePendingTransitions, updatePhase, world]);

  const exitViewer = useCallback(() => {
    if (phaseRef.current !== "viewer") return;
    freeFlyRef.current?.dispose();
    freeFlyRef.current = null;
    setViewerStats(null);
    rendererRef.current?.setViewerMode(false);
    simulationRef.current?.setPaused(false);
    updatePhase("menu");
  }, [updatePhase]);

  useEffect(() => {
    if (phase !== "viewer") return;
    const handleViewerKeyDown = (event: KeyboardEvent) => {
      // The first Escape while pointer-locked is consumed by the browser to
      // release the lock; this handler sees the second one.
      if (event.key === "Escape") exitViewer();
    };
    window.addEventListener("keydown", handleViewerKeyDown);
    return () => window.removeEventListener("keydown", handleViewerKeyDown);
  }, [phase, exitViewer]);

  /** Starts a deliberate new flight at the chosen spawn. */
  /**
   * Starts a deliberate new flight at the chosen spawn.
   *
   * `fromMenu` exists because this used to refuse to run while the start
   * screen was up: the menu's own Start is `takeControl`, a hand-off into the
   * attract flight already in the air, and this path was only ever reached
   * from a restart. A runway start needs the menu to reach it, and it needs
   * the full reset — attract mode torn down, the simulation re-spawned — which
   * the hand-off deliberately does not do.
   */
  const startNewFlight = useCallback(
    async (spawn: SpawnKind, fromMenu = false) => {
      const transition = beginTransition(transitionGateRef.current);
      await unlockAudio();
      if (
        !isCurrentTransition(transitionGateRef.current, transition) ||
        (!fromMenu && phaseRef.current === "menu") ||
        settingsOpenRef.current
      ) return;
      setError(null);
      spawnRef.current = spawn;
      setSpawnKind(spawn);
      inputRef.current?.resetForSpawn(
        spawn,
        airborneThrottleForAircraft(settingsRef.current.aircraft),
        runwayTrimForAircraft(settingsRef.current.aircraft),
        airborneGearForAircraft(settingsRef.current.aircraft),
        runwayFlapsForAircraft(settingsRef.current.aircraft),
      );
      simulationRef.current?.setMode(settingsRef.current.flightMode);
      simulationRef.current?.setAttractMode(false);
      simulationRef.current?.reset(spawn, settingsRef.current.airborneStartAgl);
      // The aeroplane teleports. Without a cut the rig carries a temporal
      // history — and an observed ground speed — that belong somewhere else.
      rendererRef.current?.cutCamera();
      simulationRef.current?.setPaused(false);
      updatePhase("flying");
    },
    [unlockAudio, updatePhase],
  );

  /** The start screen's second door: on the threshold, stopped, ready to go. */
  const startOnRunway = useCallback(
    () => startNewFlight("runway", true),
    [startNewFlight],
  );

  /**
   * A surface vehicle's only start: a boat moored at its berth, the car
   * parked on the apron. There is no attract boat or car to hand off to, so
   * this is the full reset a runway start is.
   */
  const startSurfaceVehicle = useCallback(
    () => {
      const vehicle = chosenSurfaceVehicle(settingsRef.current);
      return vehicle ? startNewFlight(surfaceSpawnKind(vehicle), true) : undefined;
    },
    [startNewFlight],
  );

  const pauseFlight = useCallback(() => {
    invalidatePendingTransitions();
    simulationRef.current?.setPaused(true);
    audioRef.current?.suspend();
    updatePhase("paused");
    if (document.pointerLockElement) document.exitPointerLock();
  }, [invalidatePendingTransitions, updatePhase]);

  const resumeFlight = useCallback(async () => {
    const transition = beginTransition(transitionGateRef.current);
    await unlockAudio();
    if (
      !isCurrentTransition(transitionGateRef.current, transition) ||
      phaseRef.current !== "paused" ||
      settingsOpenRef.current
    ) return;
    simulationRef.current?.setPaused(false);
    updatePhase("flying");
  }, [unlockAudio, updatePhase]);

  const handlePauseKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (settingsOpenRef.current) return;
      // Pause owns the keyboard while modal, including Escape and native Space
      // activation on its buttons. No flight action reaches InputManager.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        void resumeFlight();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        pausePanelRef.current?.querySelectorAll<HTMLElement>(PAUSE_FOCUSABLE_SELECTOR) ?? [],
      ).filter((element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        pausePanelRef.current?.focus();
        return;
      }
      const target = modalTabTarget(
        focusable,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
        event.shiftKey,
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    },
    [resumeFlight],
  );

  /**
   * A crash recovers above its authoritative Worker world position. Every
   * ordinary restart retains the exact runway/airborne contract that began
   * the session, including after an earlier crash recovery.
   */
  const restartFlight = useCallback(async () => {
    if (!latestStateRef.current.crashed) {
      await startNewFlight(spawnRef.current);
      return;
    }

    const transition = beginTransition(transitionGateRef.current);
    await unlockAudio();
    if (
      !isCurrentTransition(transitionGateRef.current, transition) ||
      phaseRef.current === "menu" ||
      settingsOpenRef.current
    ) return;
    setError(null);
    // A CRASH ALWAYS RECOVERS AIRBORNE, however the flight began. Being put
    // back on the threshold after hitting a mountain forty kilometres away is
    // worse than a re-entry, and the recovery path is built to find safe air
    // above the wreck rather than to find the airfield.
    //
    // A boat is the exception that proves it: it recovers upright and afloat
    // in open water near the wreck, still a boat, so its controls stay the
    // boat's and a later restart still means the berth. A rolled car comes
    // back on its wheels where it lies, still the car.
    const recovery = isSurfaceSpawn(spawnRef.current) ? spawnRef.current : "airborne";
    inputRef.current?.resetForSpawn(
      recovery,
      airborneThrottleForAircraft(settingsRef.current.aircraft),
      runwayTrimForAircraft(settingsRef.current.aircraft),
      airborneGearForAircraft(settingsRef.current.aircraft),
      runwayFlapsForAircraft(settingsRef.current.aircraft),
    );
    simulationRef.current?.setMode(settingsRef.current.flightMode);
    simulationRef.current?.setAttractMode(false);
    simulationRef.current?.restartAfterCrash(settingsRef.current.airborneStartAgl);
    rendererRef.current?.cutCamera();
    simulationRef.current?.setPaused(false);
    updatePhase("flying");
  }, [startNewFlight, unlockAudio, updatePhase]);

  /** Returns to the live start view without silently replacing the current world. */
  const endFlight = useCallback(() => {
    invalidatePendingTransitions();
    audioRef.current?.suspend();
    inputRef.current?.resetForSpawn(
      "airborne",
      airborneThrottleForAircraft(settingsRef.current.aircraft),
      runwayTrimForAircraft(settingsRef.current.aircraft),
      airborneGearForAircraft(settingsRef.current.aircraft),
    );
    // A crash recovery IS an airborne start, so the restart the pause menu
    // offers afterwards has to say so.
    spawnRef.current = "airborne";
    setSpawnKind("airborne");
    simulationRef.current?.setMode(settingsRef.current.flightMode);
    simulationRef.current?.returnToAttract(settingsRef.current.airborneStartAgl);
    simulationRef.current?.setPaused(false);
    updatePhase("menu");
  }, [invalidatePendingTransitions, updatePhase]);

  const handleActions = useCallback(
    (actions: InputAction[]) => {
      for (const action of actions) {
        if (settingsOpenRef.current) continue;
        if (action === "camera" && phaseRef.current === "flying") changeCamera();
        if (action === "reset" && phaseRef.current !== "menu") {
          void restartFlight();
        }
        if (action === "pause") {
          if (phaseRef.current === "flying") pauseFlight();
          else if (phaseRef.current === "paused") void resumeFlight();
        }
        if (action === "hud") applySettings(cycleHud(settingsRef.current));
        if (action === "nearestAirport" && phaseRef.current === "flying") toggleNearestAirport();
        if (action === "autoland") toggleAutoland();
      }
    },
    [
      applySettings,
      changeCamera,
      pauseFlight,
      restartFlight,
      resumeFlight,
      toggleAutoland,
      toggleNearestAirport,
    ],
  );

  useEffect(() => {
    const loaded = loadSettings();
    settingsRef.current = loaded;
    const urlSeed = readSeedFromUrl();
    const urlWorldEvolution = readWorldEvolutionFromUrl();
    const urlLandforms = readLandformsFromUrl();
    queueMicrotask(() => {
      setSettings(loaded);
      setSeed(urlSeed);
      setWorldEvolution(urlWorldEvolution);
      setLandforms(urlLandforms);
      setBootstrapped(true);
    });
    try {
      window.history.replaceState({}, "", urlWithSeed(urlSeed));
    } catch {
      // A restricted embed can prevent URL replacement.
    }
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (phase !== "paused") return;
    const previouslyFocused = document.activeElement;
    resumeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [phase]);

  useEffect(() => {
    if (!bootstrapped) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let animationFrame = 0;
    let controlPump: FlightControlPump | null = null;
    let disposed = false;
    let rendererTerminal = false;
    let lastFrame = performance.now();
    let lastNearestAirportUpdate = Number.NEGATIVE_INFINITY;
    // B3: what the HUD's readout last showed; null until this run publishes.
    let nearestAirportReadout: string | null = null;
    // Per-frame marker scratch: the overlay update allocates nothing.
    const airportMarkerPoint: ScreenPoint = { x: 0, y: 0, inFront: false, width: 0, height: 0 };
    const airportMarkerPlacement = createAirportMarkerPlacement();
    let airportMarkerView: AirportMarkerView | null = null;
    const startupAbortController = new AbortController();
    const startupResources = new DisposableScope();
    readyRef.current = false;
    queueMicrotask(() => {
      if (!disposed) {
        setReady(false);
        setError(null);
      }
    });

    const stopRendererSafely = (reason: string, userMessage: string): void => {
      if (disposed || rendererTerminal) return;
      rendererTerminal = true;
      cancelAnimationFrame(animationFrame);
      controlPump?.dispose();
      controlPump = null;
      invalidatePendingTransitions();
      simulationRef.current?.setPaused(true);
      audioRef.current?.suspend();
      canvas.dataset.renderFailure = reason;
      setError(userMessage);
    };

    const initialize = async (): Promise<void> => {
      try {
      const activeSettings = settingsRef.current;
      const urlFarSward = readTerrainFarSwardFromUrl();
      const airportNetwork = startupResources.own(new AirportNetworkController(world));
      const surfaceVehicle = chosenSurfaceVehicle(activeSettings);
      const rendererOptions = {
        canvas,
        aircraft: activeSettings.aircraft,
        ...(surfaceVehicle ? { vehicle: surfaceVehicle } : {}),
        // The LIVE world: spawned airports grade the ground the camera clamps to.
        terrainSample: (x: number, z: number) => sampleTerrain(airportNetwork.world, x, z),
        // Its height alone, for the renderer's height-only consumers.
        terrainHeight: (x: number, z: number) => sampleTerrainHeight(airportNetwork.world, x, z),
        world,
        seed,
        weather: activeSettings.weather,
        quality: activeSettings.quality,
        renderingMode: activeSettings.renderingMode,
        reducedMotion: activeSettings.reducedMotion,
        signal: startupAbortController.signal,
        onDeviceLost: (reason: string) => {
          stopRendererSafely(reason, GRAPHICS_DEVICE_LOST_MESSAGE);
        },
        onGpuUncapturedError: (reason: string) => {
          console.error(
            "Flight renderer stopped after an uncaptured WebGPU error",
            reason,
          );
          stopRendererSafely(
            reason,
            `The renderer stopped safely after a WebGPU error: ${reason}. `
              + "Reload the simulator to rebuild the scene.",
          );
        },
        ...(world.airport ? { runway: world.airport } : {}),
        ...(urlFarSward ? { terrainFarSwardRead: urlFarSward } : {}),
      };
      const renderer: FlightRenderingSystem = await FlightRenderer.create(rendererOptions);
      if (disposed) {
        renderer.dispose();
        return;
      }
      startupResources.own(renderer);
      const input = startupResources.own(new InputManager(renderer.domElement, {
        sensitivity: activeSettings.sensitivity,
        deadZone: activeSettings.gamepadDeadZone,
        invertPitch: activeSettings.invertPitch,
        mouseFlight: activeSettings.mouseFlight,
      }));
      const audio = startupResources.own(new FlightAudio({
        aircraft: activeSettings.aircraft,
        ...(surfaceVehicle ? { vehicle: surfaceVehicle } : {}),
        master: activeSettings.masterVolume,
        engine: activeSettings.engineVolume,
        wind: activeSettings.windVolume,
      }));
      // Renderer/Worker replacement must preserve who owns the flight. Menu
      // rebuilds are Scenic airborne demonstrations; paused/flying rebuilds
      // retain the session's original spawn contract and pilot authority.
      const initialPhase = phaseRef.current;
      const initialAttractMode = initialPhase === "menu";
      const initialSpawn = initialAttractMode ? "airborne" : spawnRef.current;
      input.resetForSpawn(
        initialSpawn,
        airborneThrottleForAircraft(activeSettings.aircraft),
        runwayTrimForAircraft(activeSettings.aircraft),
        airborneGearForAircraft(activeSettings.aircraft),
      );
      const simulation = startupResources.own(new SimulationClient(
        world,
        activeSettings.flightMode,
        initialSpawn,
        activeSettings.weather,
        activeSettings.airborneStartAgl,
        initialAttractMode,
        activeSettings.aircraft,
        surfaceVehicle,
        { gearbox: activeSettings.carGearbox, manualClutch: activeSettings.carManualClutch },
      ));
      renderer.setTerrainAuthorityPublisher(simulation);
      renderer.setCameraMode(cameraModeRef.current);
      renderer.setAtmosphere(
        {
          dayOfYear: activeSettings.dayOfYear,
          solarTimeHours: activeSettings.solarTimeHours,
        },
        activeSettings.weather,
      );

      airportNetwork.onChange((next) => {
        simulation.setAirports(next.airports);
        renderer.setAirports(next.airports);
      });

      simulation.onError((message) => setError(message));
      simulation.onState((state) => {
        latestStateRef.current = state;
        if (state.vehicle?.kind === "car") input.setCarSpeed(state.vehicle.speed);
        const lastAutoland = lastAutolandRef.current;
        if (lastAutoland && !state.autoland && state.simulationTime >= lastAutoland.time) {
          input.adoptConfiguration(lastAutoland.state.throttle, lastAutoland.state.flaps, lastAutoland.state.gear);
        }
        lastAutolandRef.current = state.autoland
          ? { state: state.autoland, time: state.simulationTime }
          : null;
        if (!readyRef.current) {
          readyRef.current = true;
          setReady(true);
          // The start screen is a live attract flight. Its worker-only Scenic
          // controller is removed at handoff; the selected pilot mode is not.
          if (phaseRef.current !== "paused") simulation.setPaused(false);
        }
        const now = performance.now();
        // Airports spawn ahead of an aircraft's track; a boat's trip is local.
        if (phaseRef.current === "flying" && !state.vehicle) airportNetwork.observe(state, now);
        if (now - lastUiUpdateRef.current > 75) {
          lastUiUpdateRef.current = now;
          setVisualState(state);
        }
        // A handful of airports at most, and the readout moves in 0.1 NM
        // steps: four times a second is plenty.
        if (now - lastNearestAirportUpdate > 250) {
          lastNearestAirportUpdate = now;
          const nearest = describeNearestAirport(
            airportNetwork.world,
            state.position.x,
            state.position.z,
          );
          nearestAirportRef.current = nearest;
          const aviation = settingsRef.current.units === "aviation";
          airportMarkerTextRef.current = nearest
            ? `${nearest.ident} · ${formatAirportDistance(nearest.distanceMeters, aviation)}`
            : "";
          // B3: re-render only when the HUD readout would change.
          const readout = nearestAirportReadoutKey(nearest, aviation);
          if (readout !== nearestAirportReadout) {
            nearestAirportReadout = readout;
            setNearestAirport(nearest);
          }
        }
        audio.observe(state);
        if (now - lastAudioUpdateRef.current > 35) {
          lastAudioUpdateRef.current = now;
          audio.update(state);
        }
      });

      controlPump = startFlightControlPump({
        input,
        simulation,
        phase: () => phaseRef.current,
        handleActions,
        isForeground: () => !disposed && !rendererTerminal && !document.hidden,
        // After InputManager (constructed above) so its key listeners run first.
        keyEvents: window,
      });

      // B3: polled only while the diagnostics setting is on or the viewer HUD is up.
      const diagnosticsPoller = new DiagnosticsPoller(
        () => renderer.getDiagnostics(),
        setDiagnostics,
      );
      const renderLoop = (now: number) => {
        if (disposed || rendererTerminal) return;
        const deltaSeconds = Math.min(0.1, Math.max(1 / 240, (now - lastFrame) / 1_000));
        lastFrame = now;
        const freeFly = phaseRef.current === "viewer" ? freeFlyRef.current : null;
        const frameState = freeFly
          ? freeFly.update(now)
          : simulation.getRenderState(now) ?? latestStateRef.current;
        if (freeFly && now - lastUiUpdateRef.current > 150) {
          lastUiUpdateRef.current = now;
          setViewerStats({
            x: frameState.position.x,
            y: frameState.position.y,
            z: frameState.position.z,
            agl: frameState.altitudeAgl,
            airspeed: frameState.airspeed,
            cruise: freeFly.speedMetersPerSecond,
          });
        }
        try {
          renderer.render(frameState, deltaSeconds);
        } catch (renderError) {
          console.error("Flight renderer stopped after an unrecoverable frame error", renderError);
          const reason = renderError instanceof Error ? renderError.message : "Unknown rendering error";
          stopRendererSafely(
            reason,
            `The renderer stopped safely: ${reason}. Reload the simulator to rebuild the scene.`,
          );
          return;
        }
        const marker = airportMarkerRef.current;
        if (marker) {
          if (airportMarkerView?.element !== marker) airportMarkerView = createAirportMarkerView(marker);
          const nearest = nearestAirportRef.current;
          const markerVisible = nearest !== null
            && nearestAirportShownRef.current
            && (phaseRef.current === "flying" || phaseRef.current === "paused")
            && renderer.projectWorldPointToRef(
              nearest.markerX,
              nearest.markerY,
              nearest.markerZ,
              airportMarkerPoint,
            );
          applyAirportMarker(
            airportMarkerView,
            markerVisible ? placeAirportMarker(airportMarkerPoint, airportMarkerPlacement) : null,
            airportMarkerTextRef.current,
          );
        }
        diagnosticsPoller.tick(now, settingsRef.current.showDiagnostics, phaseRef.current);
        if (rendererTerminal) return;
        animationFrame = requestAnimationFrame(renderLoop);
      };
      animationFrame = requestAnimationFrame(renderLoop);

      // All construction, callback wiring, and frame-loop setup succeeded.
      // Transfer ownership to the effect refs in one non-throwing block;
      // partial startup remains owned and is unwound by the catch below.
      rendererRef.current = renderer;
      inputRef.current = input;
      audioRef.current = audio;
      simulationRef.current = simulation;
      airportNetworkRef.current = airportNetwork;
      startupResources.release(airportNetwork);
      startupResources.release(renderer);
      startupResources.release(input);
      startupResources.release(audio);
      startupResources.release(simulation);
      } catch (caught) {
        controlPump?.dispose();
        controlPump = null;
        startupResources.dispose();
        const message = caught instanceof Error
          ? caught.message
          : "This browser could not create a hardware WebGPU device.";
        queueMicrotask(() => {
          if (!disposed && !rendererTerminal) setError(message);
        });
      }
    };
    void initialize();

    const handleVisibility = () => {
      if (document.hidden) {
        if (phaseRef.current === "flying") pauseFlight();
        else if (phaseRef.current === "menu") simulationRef.current?.setPaused(true);
      } else if (phaseRef.current === "menu") {
        simulationRef.current?.setPaused(false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      invalidatePendingTransitions();
      disposed = true;
      startupAbortController.abort();
      cancelAnimationFrame(animationFrame);
      controlPump?.dispose();
      controlPump = null;
      freeFlyRef.current?.dispose();
      freeFlyRef.current = null;
      document.removeEventListener("visibilitychange", handleVisibility);
      startupResources.dispose();
      const cleanupResources = new DisposableScope();
      if (rendererRef.current) cleanupResources.own(rendererRef.current);
      if (inputRef.current) cleanupResources.own(inputRef.current);
      if (audioRef.current) cleanupResources.own(audioRef.current);
      if (simulationRef.current) cleanupResources.own(simulationRef.current);
      if (airportNetworkRef.current) cleanupResources.own(airportNetworkRef.current);
      airportNetworkRef.current = null;
      nearestAirportRef.current = null;
      rendererRef.current = null;
      simulationRef.current = null;
      inputRef.current = null;
      audioRef.current = null;
      cleanupResources.dispose();
    };
  }, [
    bootstrapped,
    handleActions,
    invalidatePendingTransitions,
    pauseFlight,
    seed,
    settings.aircraft,
    settings.vehicle,
    world,
  ]);

  const chooseNewWorld = useCallback(() => {
    invalidatePendingTransitions();
    audioRef.current?.suspend();
    const nextSeed = createRandomSeed();
    spawnRef.current = "airborne";
    setSpawnKind("airborne");
    setSeed(nextSeed);
    latestStateRef.current = INITIAL_VISUAL_STATE;
    setVisualState(INITIAL_VISUAL_STATE);
    updatePhase("menu");
    try {
      window.history.replaceState({}, "", urlWithSeed(nextSeed));
    } catch {
      // URL sharing is optional in restricted embeds.
    }
  }, [invalidatePendingTransitions, updatePhase]);

  return (
    <main className="flight-shell">
      <canvas
        ref={canvasRef}
        className="flight-canvas"
        aria-label="fly high flight simulator 3D view"
        tabIndex={settingsOpen || phase === "paused" ? -1 : 0}
        inert={settingsOpen || phase === "paused"}
        aria-hidden={settingsOpen || phase === "paused" || undefined}
      />
      <div className="flight-vignette" aria-hidden="true" />

      {/* Before the HUD, so the instruments draw over the marker where they meet. */}
      <div ref={airportMarkerRef} className="airport-marker" hidden aria-hidden="true">
        <span className="airport-marker__diamond" />
        <span className="airport-marker__arrow" />
        <span className="airport-marker__label" data-airport-marker-label />
      </div>

      {phase === "flying" || phase === "paused" ? (
        <Hud
          state={visualState}
          aircraft={settings.aircraft}
          mode={settings.hud}
          flightMode={settings.flightMode}
          units={settings.units}
          diagnostics={diagnostics}
          showDiagnostics={settings.showDiagnostics}
          cameraMode={cameraMode}
          cameraLabel={CAMERA_LABELS[cameraMode]}
          seedLabel={seedToString(seed)}
          mouseFlight={settings.mouseFlight}
          onRunBudgetProbe={() => rendererRef.current?.startBudgetProbe()}
          nearestAirport={nearestAirport}
          nearestAirportShown={nearestAirportShown}
          onToggleNearestAirport={toggleNearestAirport}
          onToggleAutoland={toggleAutoland}
        />
      ) : null}

      {!ready ? (
        <div className="loading-card" role="status">
          <span className="loading-card__radar" />
          <p>Preparing airspace</p>
        </div>
      ) : null}

      {phase === "menu" && ready ? (
        <section
          className={`start-screen${settingsOpen ? " is-settings-covered" : ""}`}
          aria-label="fly high start"
          aria-hidden={settingsOpen || undefined}
        >
          <div className="start-screen__minimal">
            <AircraftPicker
              value={settings.vehicle}
              onChange={(vehicle) => applySettings(
                // An aircraft is also the menu's attract flight; a boat leaves
                // the last aircraft flying behind the menu.
                isAircraftKind(vehicle)
                  ? { ...settingsRef.current, aircraft: vehicle, vehicle }
                  : { ...settingsRef.current, vehicle },
              )}
              carSetup={{ gearbox: settings.carGearbox, manualClutch: settings.carManualClutch }}
              onCarSetupChange={(setup) => applySettings({
                ...settingsRef.current,
                carGearbox: setup.gearbox,
                carManualClutch: setup.manualClutch,
              })}
            />
            {/*
              * One wrapping row of two GROUPS, never four loose buttons. The two
              * starts are a pair and the seed and settings are a pair, so when the
              * window gets too narrow the second pair drops to its own row TOGETHER
              * — settings can never be orphaned on a row by itself, which is the
              * awkward in-between state Jason photographed. See flight.css.
              */}
            <div className="start-screen__actions">
              <div className="start-screen__starts">
                {/*
                  * Names only, at Jason's request. The secondary lines are gone
                  * from the face but not from the aeroplane: the flight-mode hint
                  * moves to the accessible name and the tooltip, because it is
                  * the one piece here a player might have been relying on and it
                  * is not shown anywhere else on this screen.
                  */}
                {chosenSurfaceVehicle(settings) ? (
                  <button
                    className="primary-action start-screen__start"
                    type="button"
                    onClick={() => void startSurfaceVehicle()}
                    aria-label={surfaceSpawnKind(chosenSurfaceVehicle(settings)!) === "airfield"
                      ? `Start on the apron, parked and ready to drive. ${CONTROL_MODE_LABELS[settings.flightMode]}`
                      : `Start at the dock, moored and ready to cast off. ${CONTROL_MODE_LABELS[settings.flightMode]}`}
                    title={surfaceSpawnKind(chosenSurfaceVehicle(settings)!) === "airfield" ? "On the apron" : "At the dock"}
                  >
                    <span>Start</span>
                  </button>
                ) : (
                  <>
                    <button
                      className="primary-action start-screen__start"
                      type="button"
                      onClick={() => void takeControl()}
                      aria-label={`Start flying. ${CONTROL_MODE_LABELS[settings.flightMode]}`}
                      title={CONTROL_MODE_LABELS[settings.flightMode]}
                    >
                      <span>Start</span>
                    </button>
                    <button
                      className="primary-action start-screen__runway"
                      type="button"
                      onClick={() => void startOnRunway()}
                      aria-label="Start on the runway, stopped and ready for take-off"
                      title="On the threshold"
                    >
                      <span>Runway start</span>
                    </button>
                  </>
                )}
              </div>
              <div className="start-screen__utility">
                <button className="seed-action" onClick={chooseNewWorld} aria-label={`Generate a new world. Current seed ${seedToString(seed)}`}>
                  <small>Seed</small>
                  <strong>{seedToString(seed)}</strong>
                  <span aria-hidden="true">↻</span>
                </button>
                <button
                  className="settings-action settings-action--icon"
                  type="button"
                  onClick={openSettings}
                  aria-haspopup="dialog"
                  aria-controls="settings-dialog"
                  aria-label="Settings"
                  title="Settings"
                >
                  {/*
                    * A stroked SVG gear rather than U+2699. The font only offers
                    * that glyph as a solid, heavy shape, and at the size this
                    * button needs it shouted; a thin stroke on a 24-box reads at
                    * the same optical size without the weight. The accessible
                    * name and tooltip carry the meaning, so it is aria-hidden.
                    *
                    * The outline is a real cog — eight teeth alternating between a
                    * 7.15 root radius and a 10.15 tip. The first attempt drew a
                    * circle with eight radial spokes through it, which renders as
                    * a SUN, not a gear. Teeth sit ON the rim; spokes stick out of
                    * it, and that is the whole difference.
                    */}
                  <svg
                    className="settings-action__gear"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M 18.95 10.33 L 22.03 10.41 L 22.03 13.59 L 18.95 13.67 L 18.10 15.74 L 20.21 17.97 L 17.97 20.21 L 15.74 18.10 L 13.67 18.95 L 13.59 22.03 L 10.41 22.03 L 10.33 18.95 L 8.26 18.10 L 6.03 20.21 L 3.79 17.97 L 5.90 15.74 L 5.05 13.67 L 1.97 13.59 L 1.97 10.41 L 5.05 10.33 L 5.90 8.26 L 3.79 6.03 L 6.03 3.79 L 8.26 5.90 L 10.33 5.05 L 10.41 1.97 L 13.59 1.97 L 13.67 5.05 L 15.74 5.90 L 17.97 3.79 L 20.21 6.03 L 18.10 8.26 Z" />
                    <circle cx="12" cy="12" r="3.6" />
                  </svg>
                </button>
              </div>
            </div>
            <button
              className="seed-action viewer-action"
              type="button"
              onClick={enterViewer}
              aria-label="Enter the beta terrain viewer: a free-flying camera with no aircraft"
            >
              <small>Beta</small>
              <strong>Terrain Viewer</strong>
              <span aria-hidden="true">⛰</span>
            </button>
          </div>
        </section>
      ) : null}

      {phase === "viewer" ? (
        <section className="viewer-hud" aria-label="Terrain viewer overlay">
          <div className="viewer-hud__stats" role="status">
            <span className="viewer-hud__tag">TERRAIN VIEWER · BETA</span>
            {viewerStats ? (
              <>
                <span>
                  {Math.round(viewerStats.x)} , {Math.round(viewerStats.z)} ·{" "}
                  {Math.round(viewerStats.y)} m MSL · {Math.round(viewerStats.agl)} m AGL
                </span>
                <span>
                  {viewerStats.airspeed.toFixed(0)} m/s · cruise {viewerStats.cruise.toFixed(0)} m/s
                </span>
              </>
            ) : null}
            {diagnostics ? (
              <span>
                {Math.round(diagnostics.fps)} fps · {diagnostics.drawCalls} draws ·{" "}
                {(diagnostics.triangles / 1_000_000).toFixed(2)} Mtri
              </span>
            ) : null}
          </div>
          <div className="viewer-hud__help">
            Click to look · WASD move · Space/C up/down · Shift sprint · Scroll speed · Esc exit
          </div>
        </section>
      ) : null}

      {phase === "paused" ? (
        <section
          className={`pause-screen${settingsOpen ? " is-settings-covered" : ""}`}
          aria-labelledby="pause-title"
          role="dialog"
          aria-modal={settingsOpen ? undefined : "true"}
          aria-hidden={settingsOpen || undefined}
          onKeyDown={handlePauseKeyDown}
        >
          <div className="pause-panel" ref={pausePanelRef} tabIndex={-1}>
            <p className="pause-panel__eyebrow">FLIGHT SUSPENDED</p>
            <h2 id="pause-title">Paused above {seedToString(seed)}</h2>
            <div className="pause-panel__actions">
              <button
                ref={resumeButtonRef}
                className="primary-action primary-action--compact"
                onClick={() => void resumeFlight()}
              >
                <span>Resume flight</span>
                <small>Esc</small>
              </button>
              <button
                onClick={() => void restartFlight()}
                aria-label={spawnKind === "dock"
                  ? visualState.crashed
                    ? "Restart afloat near where the boat was damaged"
                    : "Restart at the dock, where this trip began"
                  : spawnKind === "airfield"
                    ? visualState.crashed
                      ? "Restart on the wheels where the car came to rest"
                      : "Restart on the apron, where this drive began"
                  : visualState.crashed
                    ? "Restart airborne above the crash location"
                    : spawnKind === "runway"
                      ? "Restart on the runway, where this flight began"
                      : "Restart airborne, where this flight began"}
              >
                Restart flight
              </button>
              <button onClick={endFlight}>End flight</button>
            </div>
            {visualState.vehicle?.kind === "car" ? (
              <CarTyrePanel
                car={visualState.vehicle}
                onChange={(pressure) => inputRef.current?.setCarTyrePressure(pressure)}
              />
            ) : null}
            <button
              className="pause-panel__settings"
              type="button"
              onClick={openSettings}
              aria-haspopup="dialog"
              aria-controls="settings-dialog"
            >
              Settings
            </button>
          </div>
        </section>
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onChange={applySettings}
          onClose={closeSettings}
        />
      ) : null}

      {error ? (
        <div className="error-banner" role="alert">
          <strong>Unable to continue flight</strong>
          <span>{error}</span>
          <button onClick={() => window.location.reload()}>Reload simulator</button>
        </div>
      ) : null}
    </main>
  );
}
