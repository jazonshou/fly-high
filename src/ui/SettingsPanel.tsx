import type { GameSettings } from "@/src/settings";
import {
  MAX_AIRBORNE_START_AGL,
  MIN_AIRBORNE_START_AGL,
} from "@/src/workers/protocol";

interface SettingsPanelProps {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const patch = <Key extends keyof GameSettings>(key: Key, value: GameSettings[Key]) => {
    onChange({ ...settings, [key]: value });
  };
  const assistanceDescription =
    settings.flightMode === "unassisted"
      ? "Full pitch authority with no angle limits; releasing the stick retains the pitch you selected instead of targeting level flight."
      : settings.flightMode === "pilot"
        ? "Direct control surfaces with light rate damping and turn coordination."
        : "Bounded attitude commands that auto-level when the controls are released.";
  const startHeight =
    settings.units === "aviation"
      ? `${Math.round(settings.airborneStartAgl * 3.28084).toLocaleString()} FT AGL`
      : `${Math.round(settings.airborneStartAgl).toLocaleString()} M AGL`;

  return (
    <div className="settings-grid">
      <label className="setting-field setting-field--described">
        <span>Control assistance</span>
        <select value={settings.flightMode} onChange={(event) => patch("flightMode", event.target.value as GameSettings["flightMode"])}>
          <option value="unassisted">Direct controls (default)</option>
          <option value="pilot">Pilot damping</option>
          <option value="scenic">Scenic attitude assist</option>
        </select>
        <small className="setting-field__hint">{assistanceDescription}</small>
      </label>
      <label className="setting-field">
        <span>Graphics</span>
        <select value={settings.quality} onChange={(event) => patch("quality", event.target.value as GameSettings["quality"])}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <label className="setting-field setting-field--described">
        <span>Rendering</span>
        <select
          value={settings.renderingMode}
          onChange={(event) => patch(
            "renderingMode",
            event.target.value as GameSettings["renderingMode"],
          )}
        >
          <option value="balanced">Balanced</option>
          <option value="hybrid">Hybrid (recommended)</option>
          <option value="ray-traced">Screen-space ray marching (experimental)</option>
        </select>
        <small className="setting-field__hint">
          Higher-detail half-resolution screen-space ray marching. Browser WebGPU has no
          ray-query path in this app today, so this is not hardware ray tracing.
        </small>
      </label>
      <label className="setting-field">
        <span>Instruments</span>
        <select value={settings.hud} onChange={(event) => patch("hud", event.target.value as GameSettings["hud"])}>
          <option value="full">Full</option>
          <option value="minimal">Minimal</option>
          <option value="off">Hidden</option>
        </select>
      </label>
      <label className="setting-field">
        <span>Units</span>
        <select value={settings.units} onChange={(event) => patch("units", event.target.value as GameSettings["units"])}>
          <option value="aviation">Knots / feet</option>
          <option value="metric">Metric</option>
        </select>
      </label>
      <label className="setting-field">
        <span>Time of day</span>
        <select value={settings.timeOfDay} onChange={(event) => patch("timeOfDay", event.target.value as GameSettings["timeOfDay"])}>
          <option value="dawn">Dawn</option>
          <option value="day">Clear day</option>
          <option value="golden">Golden hour</option>
        </select>
      </label>
      <label className="setting-field">
        <span>Weather</span>
        <select value={settings.weather} onChange={(event) => patch("weather", event.target.value as GameSettings["weather"])}>
          <option value="clear">Clear / calm</option>
          <option value="breezy">Scattered / breezy</option>
          <option value="cloudy">Cloudy / gusty</option>
        </select>
      </label>
      <label className="setting-field setting-field--range">
        <span>Control sensitivity <b>{settings.sensitivity.toFixed(1)}</b></span>
        <input
          type="range"
          min="0.35"
          max="2"
          step="0.05"
          value={settings.sensitivity}
          onChange={(event) => patch("sensitivity", Number(event.target.value))}
        />
      </label>
      <label className="setting-field setting-field--range">
        <span>Airborne restart height <b>{startHeight}</b></span>
        <input
          type="range"
          min={MIN_AIRBORNE_START_AGL}
          max={MAX_AIRBORNE_START_AGL}
          step="5"
          value={settings.airborneStartAgl}
          onChange={(event) => patch("airborneStartAgl", Number(event.target.value))}
        />
        <small className="setting-field__hint">
          Used by Restart airborne and the next generated world.
        </small>
      </label>
      <label className="setting-field setting-field--range">
        <span>Master volume <b>{Math.round(settings.masterVolume * 100)}</b></span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.masterVolume}
          onChange={(event) => patch("masterVolume", Number(event.target.value))}
        />
      </label>
      <label className="setting-field setting-field--range">
        <span>Engine volume <b>{Math.round(settings.engineVolume * 100)}</b></span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.engineVolume}
          onChange={(event) => patch("engineVolume", Number(event.target.value))}
        />
      </label>
      <label className="setting-field setting-field--range">
        <span>Wind volume <b>{Math.round(settings.windVolume * 100)}</b></span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.windVolume}
          onChange={(event) => patch("windVolume", Number(event.target.value))}
        />
      </label>
      <label className="setting-field setting-field--range">
        <span>Gamepad dead zone <b>{settings.gamepadDeadZone.toFixed(2)}</b></span>
        <input
          type="range"
          min="0"
          max="0.35"
          step="0.01"
          value={settings.gamepadDeadZone}
          onChange={(event) => patch("gamepadDeadZone", Number(event.target.value))}
        />
      </label>
      <label className="setting-toggle">
        <input type="checkbox" checked={settings.invertPitch} onChange={(event) => patch("invertPitch", event.target.checked)} />
        <span>Invert mouse / gamepad pitch</span>
      </label>
      <label className="setting-toggle">
        <input type="checkbox" checked={settings.mouseFlight} onChange={(event) => patch("mouseFlight", event.target.checked)} />
        <span>Mouse yoke</span>
      </label>
      <label className="setting-toggle">
        <input type="checkbox" checked={settings.reducedMotion} onChange={(event) => patch("reducedMotion", event.target.checked)} />
        <span>Stabilized camera</span>
      </label>
      <label className="setting-toggle">
        <input type="checkbox" checked={settings.showDiagnostics} onChange={(event) => patch("showDiagnostics", event.target.checked)} />
        <span>Performance overlay</span>
      </label>
    </div>
  );
}
