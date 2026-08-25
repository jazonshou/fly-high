import type { AircraftKind } from "@/src/sim";

const AIRCRAFT_OPTIONS = [
  { value: "trainer", name: "Aster T-20", description: "Trainer" },
  { value: "jet", name: "F-22 Raptor", description: "Air dominance fighter" },
] as const satisfies readonly {
  value: AircraftKind;
  name: string;
  description: string;
}[];

interface AircraftPickerProps {
  value: AircraftKind;
  onChange: (aircraft: AircraftKind) => void;
}

export function AircraftPicker({ value, onChange }: AircraftPickerProps) {
  return (
    <fieldset className="aircraft-picker">
      <legend>Aircraft</legend>
      {AIRCRAFT_OPTIONS.map((option) => (
        <label
          className={value === option.value ? "is-selected" : undefined}
          key={option.value}
        >
          <input
            type="radio"
            name="aircraft"
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.name}</span>
          <small>{option.description}</small>
        </label>
      ))}
    </fieldset>
  );
}
