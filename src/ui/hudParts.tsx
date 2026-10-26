/**
 * HUD pieces the aircraft and boat panels share, in their own module so the
 * two panels can both use them without importing each other.
 */

export function formatHeading(heading: number): string {
  const normalized = ((heading % 360) + 360) % 360;
  return Math.round(normalized).toString().padStart(3, "0");
}

export function MetricTape({
  label,
  value,
  unit,
  side,
}: {
  label: string;
  value: string;
  unit: string;
  side: "left" | "right";
}) {
  return (
    <div className={`metric-tape metric-tape--${side}`} aria-label={`${label}: ${value} ${unit}`}>
      <span className="metric-tape__label">{label}</span>
      <span className="metric-tape__value">{value}</span>
      <span className="metric-tape__unit">{unit}</span>
      <span className="metric-tape__tick metric-tape__tick--one" />
      <span className="metric-tape__tick metric-tape__tick--two" />
      <span className="metric-tape__tick metric-tape__tick--three" />
    </div>
  );
}
