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
import { type FlightRenderingSystem } from "@/src/render/types";
import {
  createRandomSeed,
  DEFAULT_SETTINGS,
  loadSettings,
  readSeedFromUrl,
  saveSettings,
  seedToString,
  urlWithSeed,
  type GameSettings,
} from "@/src/settings";
import { AircraftPicker } from "@/src/ui/AircraftPicker";
import { Hud } from "@/src/ui/Hud";
import { modalTabTarget } from "@/src/ui/modalFocus";
import { SettingsDialog } from "@/src/ui/SettingsPanel";
import { createWorld, sampleTerrain } from "@/src/world";
import { DisposableScope } from "./DisposableScope";
import { FreeFlyController } from "./freeFly";
import { SimulationClient } from "./SimulationClient";
import { startFlightControlPump, type FlightControlPump } from "./controlPump";
import {
  airborneGearForAircraft,
  airborneThrottleForAircraft,
  runwayTrimForAircraft,
} from "./spawn";
import {
  INITIAL_VISUAL_STATE,
  type CameraMode,
  type FlightVisualState,
  type RenderDiagnostics,
} from "./types";
import type { SpawnKind } from "@/src/workers/protocol";
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

const CAMERA_MODES: CameraMode[] = ["chase", "cockpit", "cinematic"];
const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "CHASE CAM",
  cockpit: "COCKPIT",
  cinematic: "ORBIT CAM",
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
  const world = useMemo(() => createWorld(seed), [seed]);

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
    if (next.aircraft !== settingsRef.current.aircraft) invalidatePendingTransitions();
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
  }, [invalidatePendingTransitions]);

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
    spawnRef.current = "airborne";
    simulationRef.current?.handoff(settingsRef.current.flightMode);
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
      initialState: latestStateRef.current,
    });
    renderer.setViewerMode(true);
    updatePhase("viewer");
  }, [invalidatePendingTransitions, updatePhase]);

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
  const startNewFlight = useCallback(
    async (spawn: SpawnKind) => {
      const transition = beginTransition(transitionGateRef.current);
      await unlockAudio();
      if (
        !isCurrentTransition(transitionGateRef.current, transition) ||
        phaseRef.current === "menu" ||
        settingsOpenRef.current
      ) return;
      setError(null);
      spawnRef.current = spawn;
      inputRef.current?.resetForSpawn(
        spawn,
        airborneThrottleForAircraft(settingsRef.current.aircraft),
        runwayTrimForAircraft(settingsRef.current.aircraft),
        airborneGearForAircraft(settingsRef.current.aircraft),
      );
      simulationRef.current?.setMode(settingsRef.current.flightMode);
      simulationRef.current?.setAttractMode(false);
      simulationRef.current?.reset(spawn, settingsRef.current.airborneStartAgl);
      simulationRef.current?.setPaused(false);
      updatePhase("flying");
    },
    [unlockAudio, updatePhase],
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
    inputRef.current?.resetForSpawn(
      "airborne",
      airborneThrottleForAircraft(settingsRef.current.aircraft),
      runwayTrimForAircraft(settingsRef.current.aircraft),
      airborneGearForAircraft(settingsRef.current.aircraft),
    );
    simulationRef.current?.setMode(settingsRef.current.flightMode);
    simulationRef.current?.setAttractMode(false);
    simulationRef.current?.restartAfterCrash(settingsRef.current.airborneStartAgl);
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
    spawnRef.current = "airborne";
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
      }
    },
    [applySettings, changeCamera, pauseFlight, restartFlight, resumeFlight],
  );

  useEffect(() => {
    const loaded = loadSettings();
    settingsRef.current = loaded;
    const urlSeed = readSeedFromUrl();
    queueMicrotask(() => {
      setSettings(loaded);
      setSeed(urlSeed);
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
      const rendererOptions = {
        canvas,
        aircraft: activeSettings.aircraft,
        terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
        world,
        seed,
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

      simulation.onError((message) => setError(message));
      simulation.onState((state) => {
        latestStateRef.current = state;
        if (!readyRef.current) {
          readyRef.current = true;
          setReady(true);
          // The start screen is a live attract flight. Its worker-only Scenic
          // controller is removed at handoff; the selected pilot mode is not.
          if (phaseRef.current !== "paused") simulation.setPaused(false);
        }
        const now = performance.now();
        if (now - lastUiUpdateRef.current > 75) {
          lastUiUpdateRef.current = now;
          setVisualState(state);
        }
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
      });

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
        if (Math.floor(now / 500) !== Math.floor((now - deltaSeconds * 1_000) / 500)) {
          setDiagnostics(renderer.getDiagnostics());
        }
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
    world,
  ]);

  const chooseNewWorld = useCallback(() => {
    invalidatePendingTransitions();
    audioRef.current?.suspend();
    const nextSeed = createRandomSeed();
    spawnRef.current = "airborne";
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
              value={settings.aircraft}
              onChange={(aircraft) => applySettings({ ...settingsRef.current, aircraft })}
            />
            <button className="primary-action start-screen__start" onClick={() => void takeControl()}>
              <span>Start</span>
              <small>{CONTROL_MODE_LABELS[settings.flightMode]}</small>
            </button>
            <button className="seed-action" onClick={chooseNewWorld} aria-label={`Generate a new world. Current seed ${seedToString(seed)}`}>
              <small>Seed</small>
              <strong>{seedToString(seed)}</strong>
              <span aria-hidden="true">↻</span>
            </button>
            <button
              className="settings-action"
              type="button"
              onClick={openSettings}
              aria-haspopup="dialog"
              aria-controls="settings-dialog"
            >
              <small>Settings</small>
              <span aria-hidden="true">⚙</span>
            </button>
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
                aria-label={visualState.crashed
                  ? "Restart airborne above the crash location"
                  : "Restart flight from the original start"}
              >
                Restart flight
              </button>
              <button onClick={endFlight}>End flight</button>
            </div>
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
