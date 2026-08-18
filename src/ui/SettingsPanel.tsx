import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { TIME_OF_DAY_PRESET_CLOCKS, type GameSettings } from "@/src/settings";
import {
  MAX_AIRBORNE_START_AGL,
  MIN_AIRBORNE_START_AGL,
} from "@/src/workers/protocol";

interface SettingsPanelProps {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
}

interface SettingsDialogProps extends SettingsPanelProps {
  onClose: () => void;
}

interface SelectOption<Value extends string> {
  value: Value;
  label: string;
}

interface ThemedSelectProps<Value extends string> {
  labelId: string;
  value: Value;
  options: readonly SelectOption<Value>[];
  onChange: (value: Value) => void;
}

const FLIGHT_MODE_OPTIONS = [
  { value: "unassisted", label: "Direct controls (default)" },
  { value: "pilot", label: "Pilot damping" },
  { value: "scenic", label: "Scenic attitude assist" },
] as const;

const QUALITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

const RENDERING_MODE_OPTIONS = [
  { value: "performance", label: "WebGPU Performance" },
  { value: "balanced", label: "WebGPU Balanced (recommended)" },
  { value: "ultra", label: "WebGPU Ultra" },
] as const;

const HUD_OPTIONS = [
  { value: "full", label: "Full" },
  { value: "minimal", label: "Minimal" },
  { value: "off", label: "Hidden" },
] as const;

const UNIT_OPTIONS = [
  { value: "aviation", label: "Knots / feet" },
  { value: "metric", label: "Metric" },
] as const;

const TIME_OF_DAY_OPTIONS = [
  { value: "dawn", label: "Dawn" },
  { value: "day", label: "Clear day" },
  { value: "golden", label: "Golden hour" },
] as const;

const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatSolarTime(solarTimeHours: number): string {
  const hours = Math.floor(solarTimeHours);
  const minutes = Math.round((solarTimeHours - hours) * 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function formatDayOfYear(dayOfYear: number): string {
  const day = Math.floor(dayOfYear);
  let month = MONTH_STARTS.length - 1;
  while (month > 0 && MONTH_STARTS[month]! > day) month -= 1;
  return `${MONTH_LABELS[month]} ${day - MONTH_STARTS[month]! + 1}`;
}

const WEATHER_OPTIONS = [
  { value: "clear", label: "Clear / calm" },
  { value: "breezy", label: "Scattered / breezy" },
  { value: "cloudy", label: "Cloudy / gusty" },
] as const;

const FOCUSABLE_SETTINGS_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * A compact listbox-style selector that stays visually consistent across
 * browsers. Focus remains on the trigger while aria-activedescendant exposes
 * keyboard navigation to assistive technology.
 */
function ThemedSelect<Value extends string>({
  labelId,
  value,
  options,
  onChange,
}: ThemedSelectProps<Value>) {
  const generatedId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeaheadRef = useRef("");
  const typeaheadResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, options.findIndex((option) => option.value === value)),
  );
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const listboxId = `${generatedId}-listbox`;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedLabel = options[selectedIndex]?.label ?? value;

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnViewportResize = () => setOpen(false);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("resize", closeOnViewportResize);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("resize", closeOnViewportResize);
    };
  }, [open]);

  useEffect(() => () => {
    if (typeaheadResetRef.current !== null) clearTimeout(typeaheadResetRef.current);
  }, []);

  const openMenu = (nextActiveIndex = selectedIndex) => {
    const triggerBounds = triggerRef.current?.getBoundingClientRect();
    const estimatedMenuHeight = Math.min(240, options.length * 40 + 12);
    if (triggerBounds) {
      const roomBelow = window.innerHeight - triggerBounds.bottom;
      setPlacement(roomBelow < estimatedMenuHeight && triggerBounds.top > roomBelow ? "above" : "below");
    }
    setActiveIndex(nextActiveIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onChange(option.value);
    setActiveIndex(index);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) =>
          (current + direction + options.length) % options.length,
        );
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const edgeIndex = event.key === "Home" ? 0 : options.length - 1;
      if (!open) openMenu(edgeIndex);
      else setActiveIndex(edgeIndex);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;

    typeaheadRef.current += event.key.toLocaleLowerCase();
    if (typeaheadResetRef.current !== null) clearTimeout(typeaheadResetRef.current);
    typeaheadResetRef.current = setTimeout(() => {
      typeaheadRef.current = "";
    }, 650);
    const matchIndex = options.findIndex((option) =>
      option.label.toLocaleLowerCase().startsWith(typeaheadRef.current),
    );
    if (matchIndex >= 0) {
      event.preventDefault();
      if (open) setActiveIndex(matchIndex);
      else choose(matchIndex);
    }
  };

  const handleBlur = (event: ReactFocusEvent<HTMLButtonElement>) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !rootRef.current?.contains(nextTarget)) {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="setting-select">
      <button
        ref={triggerRef}
        type="button"
        className="setting-select__trigger"
        role="combobox"
        aria-labelledby={labelId}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        onBlur={handleBlur}
        onClick={() => {
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="setting-select__value">{selectedLabel}</span>
        <span className="setting-select__chevron" aria-hidden="true">⌄</span>
      </button>
      <ul
        id={listboxId}
        className={`setting-select__menu setting-select__menu--${placement}`}
        role="listbox"
        aria-labelledby={labelId}
        hidden={!open}
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            id={`${listboxId}-option-${index}`}
            className={`setting-select__option${index === activeIndex ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
            role="option"
            data-value={option.value}
            aria-selected={option.value === value}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            <span className="setting-select__check" aria-hidden="true">✓</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Modal wrapper shared by the start and pause surfaces. It owns focus while
 * mounted and restores it to the invoking Settings button on close.
 */
export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Do not let flight shortcuts leak through the modal to InputManager's
    // window listener. Native select/range keyboard behaviour is unaffected.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SETTINGS_SELECTOR) ?? [],
    ).filter((element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section className="settings-screen" onKeyDown={handleKeyDown}>
      <div
        id="settings-dialog"
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby="settings-description"
        tabIndex={-1}
      >
        <header className="settings-panel__header">
          <div>
            <p>FLIGHT CONFIGURATION</p>
            <h2 id="settings-title">Settings</h2>
            <span id="settings-description">
              Changes apply immediately and stay with this aircraft and world.
            </span>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close settings">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <SettingsPanel settings={settings} onChange={onChange} />
      </div>
    </section>
  );
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
      <div className="setting-field setting-field--described">
        <span id="settings-flight-mode-label">Control assistance</span>
        <ThemedSelect
          labelId="settings-flight-mode-label"
          value={settings.flightMode}
          options={FLIGHT_MODE_OPTIONS}
          onChange={(value) => patch("flightMode", value)}
        />
        <small className="setting-field__hint">{assistanceDescription}</small>
      </div>
      <div className="setting-field">
        <span id="settings-quality-label">Graphics</span>
        <ThemedSelect
          labelId="settings-quality-label"
          value={settings.quality}
          options={QUALITY_OPTIONS}
          onChange={(value) => patch("quality", value)}
        />
      </div>
      <div className="setting-field setting-field--described">
        <span id="settings-rendering-mode-label">Rendering</span>
        <ThemedSelect
          labelId="settings-rendering-mode-label"
          value={settings.renderingMode}
          options={RENDERING_MODE_OPTIONS}
          onChange={(value) => patch("renderingMode", value)}
        />
        <small className="setting-field__hint">
          Controls compute simulation resolution, volumetric sampling, water shading, shadows,
          and streamed world-detail density.
        </small>
      </div>
      <div className="setting-field">
        <span id="settings-hud-label">Instruments</span>
        <ThemedSelect
          labelId="settings-hud-label"
          value={settings.hud}
          options={HUD_OPTIONS}
          onChange={(value) => patch("hud", value)}
        />
      </div>
      <div className="setting-field">
        <span id="settings-units-label">Units</span>
        <ThemedSelect
          labelId="settings-units-label"
          value={settings.units}
          options={UNIT_OPTIONS}
          onChange={(value) => patch("units", value)}
        />
      </div>
      <div className="setting-field setting-field--presets">
        <span id="settings-time-label">Time of day</span>
        <div className="setting-presets" role="group" aria-labelledby="settings-time-label">
          {TIME_OF_DAY_OPTIONS.map((option) => {
            const preset = TIME_OF_DAY_PRESET_CLOCKS[option.value];
            const active = settings.dayOfYear === preset.dayOfYear
              && settings.solarTimeHours === preset.solarTimeHours;
            return (
              <button
                key={option.value}
                type="button"
                className={`setting-presets__button${active ? " setting-presets__button--active" : ""}`}
                aria-pressed={active}
                onClick={() => onChange({
                  ...settings,
                  timeOfDay: option.value,
                  dayOfYear: preset.dayOfYear,
                  solarTimeHours: preset.solarTimeHours,
                })}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <label className="setting-field setting-field--range">
        <span>Solar time <b>{formatSolarTime(settings.solarTimeHours)}</b></span>
        <input
          type="range"
          min="0"
          max="23.75"
          step="0.25"
          value={settings.solarTimeHours}
          onChange={(event) => patch("solarTimeHours", Number(event.target.value))}
        />
      </label>
      <label className="setting-field setting-field--range">
        <span>Day of year <b>{formatDayOfYear(settings.dayOfYear)}</b></span>
        <input
          type="range"
          min="0"
          max="364"
          step="1"
          value={Math.floor(settings.dayOfYear)}
          onChange={(event) => patch("dayOfYear", Number(event.target.value))}
        />
      </label>
      <div className="setting-field">
        <span id="settings-weather-label">Weather</span>
        <ThemedSelect
          labelId="settings-weather-label"
          value={settings.weather}
          options={WEATHER_OPTIONS}
          onChange={(value) => patch("weather", value)}
        />
      </div>
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
          Minimum clearance for airborne starts and safe recovery above a crash location.
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
