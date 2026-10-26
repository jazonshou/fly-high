import { AIRCRAFT_CATALOGUE } from "@/src/aircraft/catalogue";
import { SURFACE_VEHICLE_CATALOGUE } from "@/src/vehicles/catalogue";
import type { VehicleKind } from "@/src/vehicles/kinds";

interface AircraftPickerProps {
  value: VehicleKind;
  onChange: (vehicle: VehicleKind) => void;
}

/**
 * The start screen's one choice: what to drive. The aeroplanes come first, as
 * they always have; the boats follow as their own group. One radio group, so
 * exactly one vehicle is ever selected.
 */
export function AircraftPicker({ value, onChange }: AircraftPickerProps) {
  const options = [
    ...AIRCRAFT_CATALOGUE.map((spec) => ({ kind: spec.kind, name: spec.name, description: spec.description, surface: false })),
    ...SURFACE_VEHICLE_CATALOGUE.map((spec) => ({ kind: spec.kind, name: spec.name, description: spec.description, surface: true })),
  ];
  return (
    <fieldset className="aircraft-picker">
      <legend>Vehicle</legend>
      {options.map((option) => {
        const classes = [
          value === option.kind ? "is-selected" : "",
          option.surface ? "aircraft-picker__surface" : "",
        ].filter(Boolean).join(" ");
        return (
          <label
            className={classes || undefined}
            key={option.kind}
            title={option.description}
          >
            <input
              type="radio"
              name="vehicle"
              value={option.kind}
              checked={value === option.kind}
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
      })}
    </fieldset>
  );
}
