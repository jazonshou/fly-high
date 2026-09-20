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
        >
          <input
            type="radio"
            name="aircraft"
            value={option.kind}
            checked={value === option.kind}
            onChange={() => onChange(option.kind)}
          />
          <span>{option.name}</span>
          <small>{option.description}</small>
        </label>
      ))}
    </fieldset>
  );
}
