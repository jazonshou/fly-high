import { Fragment, useState } from "react";
import { AIRCRAFT_CATALOGUE } from "@/src/aircraft/catalogue";
import type { CarSetup } from "@/src/game/types";
import { AIRCRAFT_KINDS, type AircraftKind } from "@/src/sim";
import { SURFACE_VEHICLE_CATALOGUE } from "@/src/vehicles/catalogue";
import { isSurfaceVehicleKind, vehicleClass, type VehicleKind } from "@/src/vehicles/kinds";

interface AircraftPickerProps {
  /**
   * The aircraft behind the menu. Closing the Beta group while a boat or the
   * car is chosen goes back to it, so a hidden vehicle is never the selection.
   */
  aircraft?: AircraftKind;
  value: VehicleKind;
  onChange: (vehicle: VehicleKind) => void;
  /** The car's gearbox and clutch, from settings; the choice shows on the car's card. */
  carSetup?: CarSetup;
  onCarSetupChange?: (setup: CarSetup) => void;
}

interface PickerOption {
  kind: VehicleKind;
  name: string;
  description: string;
  surface: boolean;
}

/**
 * The start screen's one choice: what to drive. The four aeroplanes are the
 * picker; the boat and the car sit behind a Beta button under them, closed by
 * default (Jason, 2026-11-05: "default should still be the 4 planes"). It
 * opens on its own when a beta vehicle is already chosen, so the selection is
 * always on screen. One radio group, so exactly one vehicle is ever selected.
 *
 * With the car chosen, its card opens a second, smaller choice under it: the
 * automatic or the manual, and with the manual whether the player works the
 * clutch (Q). Settings remember both; the next start takes them.
 */
export function AircraftPicker({ aircraft, value, onChange, carSetup, onCarSetupChange }: AircraftPickerProps) {
  const [betaOpen, setBetaOpen] = useState(() => isSurfaceVehicleKind(value));
  const betaShown = betaOpen || isSurfaceVehicleKind(value);
  const toggleBeta = () => {
    const fallback = vehicleAfterClosingBeta(value, betaShown, aircraft);
    setBetaOpen(!betaShown);
    if (fallback) onChange(fallback);
  };
  const aircraftOptions: PickerOption[] = AIRCRAFT_CATALOGUE.map((spec) => ({ kind: spec.kind, name: spec.name, description: spec.description, surface: false }));
  const betaOptions: PickerOption[] = SURFACE_VEHICLE_CATALOGUE.map((spec) => ({ kind: spec.kind, name: spec.name, description: spec.description, surface: true }));

  const renderOption = (option: PickerOption) => {
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
  };

  return (
    <fieldset className="aircraft-picker">
      <legend>Vehicle</legend>
      {aircraftOptions.map(renderOption)}
      {/*
        * A disclosure button, not a radio: opening it chooses nothing, so the
        * aeroplane stays selected until a beta vehicle is actually picked.
        * The tag reuses the terrain viewer's blue Beta mark.
        */}
      <button
        type="button"
        className={`aircraft-picker__beta${betaShown ? " is-open" : ""}`}
        aria-expanded={betaShown}
        onClick={toggleBeta}
        title={betaShown ? "Hide the beta vehicles" : "Show the beta vehicles: a boat and a car"}
      >
        <span className="aircraft-picker__beta-tag">Beta</span>
        <span className="aircraft-picker__beta-label">Boat &amp; car</span>
        <span className="aircraft-picker__beta-chevron" aria-hidden="true" />
      </button>
      {betaShown ? betaOptions.map(renderOption) : null}
    </fieldset>
  );
}

/**
 * The vehicle to switch to when the Beta button is pressed, or null to leave
 * the selection alone. Only closing the group with a beta vehicle chosen moves
 * it: back to the aircraft behind the menu, or the first aircraft without one.
 */
export function vehicleAfterClosingBeta(
  value: VehicleKind,
  betaShown: boolean,
  aircraft: AircraftKind | undefined,
): AircraftKind | null {
  if (!betaShown || !isSurfaceVehicleKind(value)) return null;
  return aircraft ?? AIRCRAFT_KINDS[0];
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
