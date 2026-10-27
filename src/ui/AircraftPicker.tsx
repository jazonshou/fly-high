import { Fragment } from "react";
import { AIRCRAFT_CATALOGUE } from "@/src/aircraft/catalogue";
import type { CarSetup } from "@/src/game/types";
import { SURFACE_VEHICLE_CATALOGUE } from "@/src/vehicles/catalogue";
import { vehicleClass, type VehicleKind } from "@/src/vehicles/kinds";

interface AircraftPickerProps {
  value: VehicleKind;
  onChange: (vehicle: VehicleKind) => void;
  /** The car's gearbox and clutch, from settings; the choice shows on the car's card. */
  carSetup?: CarSetup;
  onCarSetupChange?: (setup: CarSetup) => void;
}

/**
 * The start screen's one choice: what to drive. The aeroplanes come first, as
 * they always have; the boats follow as their own group. One radio group, so
 * exactly one vehicle is ever selected.
 *
 * With the car chosen, its card opens a second, smaller choice under it: the
 * automatic or the manual, and with the manual whether the player works the
 * clutch (Q). Settings remember both; the next start takes them.
 */
export function AircraftPicker({ value, onChange, carSetup, onCarSetupChange }: AircraftPickerProps) {
  const options = [
    ...AIRCRAFT_CATALOGUE.map((spec) => ({ kind: spec.kind, name: spec.name, description: spec.description, surface: false })),
    ...SURFACE_VEHICLE_CATALOGUE.map((spec) => ({ kind: spec.kind, name: spec.name, description: spec.description, surface: true })),
  ];
  return (
    <fieldset className="aircraft-picker">
      <legend>Vehicle</legend>
      {options.map((option) => {
        const selected = value === option.kind;
        const classes = [
          selected ? "is-selected" : "",
          option.surface ? "aircraft-picker__surface" : "",
        ].filter(Boolean).join(" ");
        const label = (
          <label
            className={classes || undefined}
            key={option.kind}
            title={option.description}
          >
            <input
              type="radio"
              name="vehicle"
              value={option.kind}
              checked={selected}
              onChange={() => onChange(option.kind)}
            />
            {/*
              * Name only. The role ("Trainer", "Fighter", "Speedboat") stays
              * in the catalogue — settings validation and the accessible name
              * both read it — but Jason asked for it off the face of the
              * picker, and the names alone are unambiguous.
              */}
            <span>{option.name}</span>
          </label>
        );
        if (!selected || vehicleClass(option.kind) !== "car" || !carSetup || !onCarSetupChange) return label;
        return (
          <Fragment key={option.kind}>
            {label}
            <CarSetupChoice setup={carSetup} onChange={onCarSetupChange} />
          </Fragment>
        );
      })}
    </fieldset>
  );
}

function CarSetupChoice({ setup, onChange }: { setup: CarSetup; onChange: (setup: CarSetup) => void }) {
  return (
    <fieldset className="aircraft-picker__car-setup">
      <legend>Gearbox</legend>
      <div className="aircraft-picker__segments">
        {(["automatic", "manual"] as const).map((gearbox) => (
          <label key={gearbox} className={setup.gearbox === gearbox ? "is-selected" : undefined}>
            <input
              type="radio"
              name="car-gearbox"
              value={gearbox}
              checked={setup.gearbox === gearbox}
              onChange={() => onChange({ ...setup, gearbox })}
            />
            <span>{gearbox === "automatic" ? "Automatic" : "Manual"}</span>
          </label>
        ))}
      </div>
      {setup.gearbox === "manual" ? (
        <label
          className={`aircraft-picker__clutch${setup.manualClutch ? " is-selected" : ""}`}
          title="Work the clutch pedal with Q (X on a gamepad). Off, the clutch works itself."
        >
          <input
            type="checkbox"
            checked={setup.manualClutch}
            onChange={(event) => onChange({ ...setup, manualClutch: event.currentTarget.checked })}
          />
          <span>Clutch pedal</span>
          <kbd>Q</kbd>
        </label>
      ) : null}
    </fieldset>
  );
}
