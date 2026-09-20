import type { AircraftKind } from "@/src/sim";
import { AIRCRAFT_CATALOGUE } from "@/src/aircraft/catalogue";

interface AircraftPickerProps {
  value: AircraftKind;
  onChange: (aircraft: AircraftKind) => void;
}

export function AircraftPicker({ value, onChange }: AircraftPickerProps) {
  return (
    <fieldset className="aircraft-picker">
      <legend>Aircraft</legend>
      {AIRCRAFT_CATALOGUE.map((option) => (
        <label
          className={value === option.kind ? "is-selected" : undefined}
          key={option.kind}
          title={option.description}
        >
          <input
            type="radio"
            name="aircraft"
            value={option.kind}
            checked={value === option.kind}
            onChange={() => onChange(option.kind)}
          />
          {/*
            * Name only. The role ("Trainer", "Fighter") stays in the catalogue
            * — settings validation and the accessible name both read it — but
            * Jason asked for it off the face of the picker, and with four
            * aeroplanes the names alone are unambiguous.
            */}
          <span>{option.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
