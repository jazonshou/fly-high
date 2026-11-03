import { useState } from "react";
import type { CarTyrePressure, CarVisualState } from "@/src/game/types";

/** The presets' pressures, bar, as the sim sets them (`CarTyrePressure`). */
export const CAR_TYRE_PRESETS: readonly { pressure: CarTyrePressure; label: string; bar: number; note: string }[] =
  Object.freeze([
    Object.freeze({ pressure: "road", label: "Road", bar: 2.4, note: "Firm: grip and steering on the road" }),
    Object.freeze({ pressure: "sand", label: "Sand", bar: 1.2, note: "Aired down: a longer footprint floats on sand" }),
  ]);

/** Above this road speed the tyres hold their pressure: the sim inflates and deflates only at a stop. */
const STOPPED_METERS_PER_SECOND = 0.5;

/**
 * The pause menu's vehicle panel, for a car session: the tyre pressure
 * preset, road or sand. The choice goes straight to the input
 * (`InputManager.setCarTyrePressure`) and the sim takes it at a stop, over
 * a short inflation time, so the panel shows what the tyres hold now beside
 * what was asked for.
 */
export function CarTyrePanel({
  car,
  onChange,
}: {
  car: CarVisualState;
  onChange: (pressure: CarTyrePressure) => void;
}) {
  // The sim is paused, so the payload will not echo a new choice until the
  // drive resumes; the panel remembers it meanwhile.
  const [chosen, setChosen] = useState<CarTyrePressure>(car.tyrePressure);
  const target = CAR_TYRE_PRESETS.find((preset) => preset.pressure === chosen) ?? CAR_TYRE_PRESETS[0]!;
  const moving = Math.abs(car.speed) > STOPPED_METERS_PER_SECOND;
  const settled = Math.abs(car.tyrePressureBar - target.bar) < 0.05;
  const status = settled
    ? `Holding ${car.tyrePressureBar.toFixed(1)} bar`
    : moving
      ? `Now ${car.tyrePressureBar.toFixed(1)} bar · stop to ${car.tyrePressureBar < target.bar ? "inflate" : "air down"}`
      : `Now ${car.tyrePressureBar.toFixed(1)} bar · ${car.tyrePressureBar < target.bar ? "inflating" : "airing down"} on resume`;
  return (
    <fieldset className="pause-vehicle">
      <legend>Tyre pressure</legend>
      <div className="pause-vehicle__choices">
        {CAR_TYRE_PRESETS.map((preset) => (
          <label key={preset.pressure} className={chosen === preset.pressure ? "is-selected" : undefined} title={preset.note}>
            <input
              type="radio"
              name="car-tyre-pressure"
              value={preset.pressure}
              checked={chosen === preset.pressure}
              onChange={() => {
                setChosen(preset.pressure);
                onChange(preset.pressure);
              }}
            />
            <span>{preset.label}</span>
            <small>{preset.bar.toFixed(1)} BAR</small>
          </label>
        ))}
      </div>
      <p className="pause-vehicle__status" aria-live="polite">{status}</p>
    </fieldset>
  );
}
