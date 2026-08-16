"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlightAudio } from "@/src/audio";
import { InputManager, type InputAction } from "@/src/input";
import { CanvasFlightRenderer } from "@/src/render/CanvasFlightRenderer";
import { FlightRenderer } from "@/src/render/FlightRenderer";
import { supportsFlightWebGL, type FlightRenderingSystem } from "@/src/render/types";
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
import { createWorld, sampleTerrain } from "@/src/world";
import { SimulationClient } from "./SimulationClient";
import { airborneThrottleForAircraft, runwayTrimForAircraft } from "./spawn";
import {
  INITIAL_VISUAL_STATE,
  type CameraMode,
  type FlightVisualState,
  type RenderDiagnostics,
} from "./types";
import type { SpawnKind } from "@/src/workers/protocol";
import "./flight.css";

type GamePhase = "menu" | "flying" | "paused";

const GRAPHICS_CONTEXT_LOST_MESSAGE =
  "The graphics device reset. Waiting for the browser to rebuild the 3D scene safely.";

const CAMERA_MODES: CameraMode[] = ["chase", "cockpit", "cinematic"];
const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "CHASE CAM",
  cockpit: "COCKPIT",
  cinematic: "ORBIT CAM",
};

const CONTROL_MODE_LABELS: Record<GameSettings["flightMode"], string> = {
  unassisted: "Direct controls",
  pilot: "Pilot damping",
  scenic: "Scenic assist",
};

function cycleHud(settings: GameSettings): GameSettings {
  const next = settings.hud === "full" ? "minimal" : settings.hud === "minimal" ? "off" : "full";
  return { ...settings, hud: next };
}

export function FlightGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FlightRenderingSystem | null>(null);
  const simulationRef = useRef<SimulationClient | null>(null);
  const inputRef = useRef<InputManager | null>(null);
  const audioRef = useRef<FlightAudio | null>(null);
  const latestStateRef = useRef<FlightVisualState>(INITIAL_VISUAL_STATE);
  const phaseRef = useRef<GamePhase>("menu");
  const settingsRef = useRef<GameSettings>(DEFAULT_SETTINGS);
  const cameraModeRef = useRef<CameraMode>("chase");
  const spawnRef = useRef<SpawnKind>("airborne");
  const lastUiUpdateRef = useRef(0);
  const lastAudioUpdateRef = useRef(0);
  const readyRef = useRef(false);
  const [phase, setPhase] = useState<GamePhase>("menu");
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
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

  const applySettings = useCallback((next: GameSettings) => {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    rendererRef.current?.setQuality(next.quality);
    rendererRef.current?.setRenderingMode(next.renderingMode);
    rendererRef.current?.setReducedMotion(next.reducedMotion);
    rendererRef.current?.setAtmosphere(next.timeOfDay, next.weather);
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
  }, []);

  const changeCamera = useCallback(() => {
    const currentIndex = CAMERA_MODES.indexOf(cameraModeRef.current);
    const next = CAMERA_MODES[(currentIndex + 1) % CAMERA_MODES.length] ?? "chase";
    cameraModeRef.current = next;
    setCameraMode(next);
    rendererRef.current?.setCameraMode(next);
  }, []);

  /** Hands the already-running menu flight to the pilot without a reset. */
  const takeControl = useCallback(async () => {
    setError(null);
    await audioRef.current?.unlock();
    inputRef.current?.resetForSpawn(
      "airborne",
      airborneThrottleForAircraft(settingsRef.current.aircraft),
      runwayTrimForAircraft(settingsRef.current.aircraft),
    );
    inputRef.current?.setThrottle(latestStateRef.current.throttle);
    spawnRef.current = "airborne";
    simulationRef.current?.handoff(settingsRef.current.flightMode);
    simulationRef.current?.setPaused(false);
    updatePhase("flying");
  }, [updatePhase]);

  /** Starts a deliberate new flight at the chosen spawn. */
  const startNewFlight = useCallback(
    async (spawn: SpawnKind) => {
      setError(null);
      await audioRef.current?.unlock();
      spawnRef.current = spawn;
      inputRef.current?.resetForSpawn(
        spawn,
        airborneThrottleForAircraft(settingsRef.current.aircraft),
        runwayTrimForAircraft(settingsRef.current.aircraft),
      );
      simulationRef.current?.setMode(settingsRef.current.flightMode);
      simulationRef.current?.setAttractMode(false);
      simulationRef.current?.reset(spawn, settingsRef.current.airborneStartAgl);
      simulationRef.current?.setPaused(false);
      updatePhase("flying");
    },
    [updatePhase],
  );

  const pauseFlight = useCallback(() => {
    simulationRef.current?.setPaused(true);
    audioRef.current?.suspend();
    updatePhase("paused");
    if (document.pointerLockElement) document.exitPointerLock();
  }, [updatePhase]);

  const resumeFlight = useCallback(async () => {
    await audioRef.current?.unlock();
    simulationRef.current?.setPaused(false);
    updatePhase("flying");
  }, [updatePhase]);

  /** Restarts the current session with the same spawn contract it began with. */
  const restartFlight = useCallback(async () => {
    await startNewFlight(spawnRef.current);
  }, [startNewFlight]);

  /** Returns to the live start view without silently replacing the current world. */
  const endFlight = useCallback(() => {
    audioRef.current?.suspend();
    inputRef.current?.resetForSpawn(
      "airborne",
      airborneThrottleForAircraft(settingsRef.current.aircraft),
      runwayTrimForAircraft(settingsRef.current.aircraft),
    );
    spawnRef.current = "airborne";
    simulationRef.current?.setMode(settingsRef.current.flightMode);
    simulationRef.current?.returnToAttract(settingsRef.current.airborneStartAgl);
    simulationRef.current?.setPaused(false);
    updatePhase("menu");
  }, [updatePhase]);

  const handleActions = useCallback(
    (actions: InputAction[]) => {
      for (const action of actions) {
        if (action === "camera" && phaseRef.current === "flying") changeCamera();
        if (action === "reset" && phaseRef.current !== "menu") {
          const spawn = spawnRef.current;
          inputRef.current?.resetForSpawn(
            spawn,
            airborneThrottleForAircraft(settingsRef.current.aircraft),
            runwayTrimForAircraft(settingsRef.current.aircraft),
          );
          simulationRef.current?.setMode(settingsRef.current.flightMode);
          simulationRef.current?.reset(spawn, settingsRef.current.airborneStartAgl);
          simulationRef.current?.setPaused(false);
          updatePhase("flying");
        }
        if (action === "pause") {
          if (phaseRef.current === "flying") pauseFlight();
          else if (phaseRef.current === "paused") void resumeFlight();
        }
        if (action === "hud") applySettings(cycleHud(settingsRef.current));
      }
    },
    [applySettings, changeCamera, pauseFlight, resumeFlight, updatePhase],
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
    if (!bootstrapped) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let animationFrame = 0;
    let disposed = false;
    let lastFrame = performance.now();
    readyRef.current = false;
    queueMicrotask(() => {
      if (!disposed) {
        setReady(false);
        setError(null);
      }
    });

    try {
      const activeSettings = settingsRef.current;
      const rendererOptions = {
        canvas,
        aircraft: activeSettings.aircraft,
        terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
        seed,
        quality: activeSettings.quality,
        renderingMode: activeSettings.renderingMode,
        reducedMotion: activeSettings.reducedMotion,
        onContextLost: () => {
          if (disposed) return;
          simulationRef.current?.setPaused(true);
          setError(GRAPHICS_CONTEXT_LOST_MESSAGE);
        },
        onContextRestored: () => {
          if (disposed) return;
          setError((current) => current === GRAPHICS_CONTEXT_LOST_MESSAGE ? null : current);
          simulationRef.current?.setPaused(phaseRef.current === "paused");
        },
        ...(world.airport ? { runway: world.airport } : {}),
      };
      let renderer: FlightRenderingSystem;
      if (supportsFlightWebGL()) {
        try {
          renderer = new FlightRenderer(rendererOptions);
          renderer.domElement.dataset.rendererMode = "webgl2";
        } catch (rendererError) {
          canvas.dataset.webglFailure =
            rendererError instanceof Error ? rendererError.message : "Unknown WebGL startup failure";
          renderer = new CanvasFlightRenderer(
            rendererOptions,
            "WebGL 2 renderer startup failed; Canvas 2D compatibility renderer active.",
          );
          renderer.domElement.dataset.rendererMode = "canvas2d";
        }
      } else {
        renderer = new CanvasFlightRenderer(rendererOptions);
        renderer.domElement.dataset.rendererMode = "canvas2d";
      }
      const input = new InputManager(renderer.domElement, {
        sensitivity: activeSettings.sensitivity,
        deadZone: activeSettings.gamepadDeadZone,
        invertPitch: activeSettings.invertPitch,
        mouseFlight: activeSettings.mouseFlight,
      });
      const audio = new FlightAudio({
        aircraft: activeSettings.aircraft,
        master: activeSettings.masterVolume,
        engine: activeSettings.engineVolume,
        wind: activeSettings.windVolume,
      });
      const simulation = new SimulationClient(
        seed,
        activeSettings.flightMode,
        "airborne",
        activeSettings.weather,
        activeSettings.airborneStartAgl,
        true,
        activeSettings.aircraft,
      );
      renderer.setCameraMode(cameraModeRef.current);
      renderer.setAtmosphere(activeSettings.timeOfDay, activeSettings.weather);
      rendererRef.current = renderer;
      inputRef.current = input;
      audioRef.current = audio;
      simulationRef.current = simulation;

      simulation.onError((message) => setError(message));
      simulation.onState((state) => {
        latestStateRef.current = state;
        if (!readyRef.current) {
          readyRef.current = true;
          setReady(true);
          // The start screen is a live attract flight. Its worker-only Scenic
          // controller is removed at handoff; the selected pilot mode is not.
          if (phaseRef.current === "menu") simulation.setPaused(false);
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

      const renderLoop = (now: number) => {
        if (disposed) return;
        const deltaSeconds = Math.min(0.1, Math.max(1 / 240, (now - lastFrame) / 1_000));
        lastFrame = now;
        if (phaseRef.current === "flying") {
          simulation.setControls(input.getControls(deltaSeconds));
        }
        handleActions(input.consumeActions());
        try {
          renderer.render(simulation.getRenderState(now) ?? latestStateRef.current, deltaSeconds);
        } catch (renderError) {
          console.error("Flight renderer stopped after an unrecoverable frame error", renderError);
          const reason = renderError instanceof Error ? renderError.message : "Unknown rendering error";
          canvas.dataset.renderFailure = reason;
          simulation.setPaused(true);
          setError(`The renderer stopped safely: ${reason}. Reload the simulator to rebuild the scene.`);
          return;
        }
        if (Math.floor(now / 500) !== Math.floor((now - deltaSeconds * 1_000) / 500)) {
          setDiagnostics(renderer.getDiagnostics());
        }
        animationFrame = requestAnimationFrame(renderLoop);
      };
      animationFrame = requestAnimationFrame(renderLoop);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "This browser could not start the 3D renderer.";
      queueMicrotask(() => {
        if (!disposed) setError(message);
      });
    }

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
      disposed = true;
      cancelAnimationFrame(animationFrame);
      document.removeEventListener("visibilitychange", handleVisibility);
      rendererRef.current?.dispose();
      simulationRef.current?.dispose();
      inputRef.current?.dispose();
      audioRef.current?.dispose();
      rendererRef.current = null;
      simulationRef.current = null;
      inputRef.current = null;
      audioRef.current = null;
    };
  }, [bootstrapped, handleActions, pauseFlight, seed, settings.aircraft, world]);

  const chooseNewWorld = useCallback(() => {
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
  }, [updatePhase]);

  return (
    <main className="flight-shell">
      <canvas
        ref={canvasRef}
        className="flight-canvas"
        aria-label="Aerolith flight simulator 3D view"
        tabIndex={0}
      />
      <div className="flight-vignette" aria-hidden="true" />

      {phase !== "menu" ? (
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
        />
      ) : null}

      {!ready ? (
        <div className="loading-card" role="status">
          <span className="loading-card__radar" />
          <p>Preparing airspace</p>
        </div>
      ) : null}

      {phase === "menu" && ready ? (
        <section className="start-screen" aria-label="Aerolith start">
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
          </div>
        </section>
      ) : null}

      {phase === "paused" ? (
        <section className="pause-screen" aria-labelledby="pause-title" role="dialog" aria-modal="true">
          <div className="pause-panel">
            <p className="pause-panel__eyebrow">FLIGHT SUSPENDED</p>
            <h2 id="pause-title">Paused above {seedToString(seed)}</h2>
            <div className="pause-panel__actions">
              <button className="primary-action primary-action--compact" onClick={() => void resumeFlight()}>
                <span>Resume flight</span>
                <small>Esc</small>
              </button>
              <button onClick={() => void restartFlight()}>Restart flight</button>
              <button onClick={endFlight}>End flight</button>
            </div>
          </div>
        </section>
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
