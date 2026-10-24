import type { ScreenPoint } from "@/src/render/types";

/** Inset from the canvas edge inside which an on-screen marker is drawn. */
export const AIRPORT_MARKER_EDGE_MARGIN = 64;

export interface AirportMarkerPlacement {
  /** "on" draws the diamond over the airport; "edge" pins an arrow to the screen edge. */
  readonly mode: "on" | "edge";
  readonly x: number;
  readonly y: number;
  /** Direction from screen centre toward the airport, radians, screen space (+x right, +y down). */
  readonly angle: number;
}

/**
 * Where the nearest-airport marker goes this frame. In view, it sits on the
 * runway; out of view (beside or behind the camera) it rides the screen edge,
 * pointing the way to turn.
 */
export function placeAirportMarker(point: ScreenPoint): AirportMarkerPlacement {
  const margin = AIRPORT_MARKER_EDGE_MARGIN;
  const centerX = point.width * 0.5;
  const centerY = point.height * 0.5;
  let dx = point.x - centerX;
  let dy = point.y - centerY;
  const inside = point.inFront
    && point.x >= margin && point.x <= point.width - margin
    && point.y >= margin && point.y <= point.height - margin;
  if (inside) return { mode: "on", x: point.x, y: point.y, angle: Math.atan2(dy, dx) };
  // Directly behind, the projection collapses toward the centre: point down,
  // which reads as "turn around".
  if (Math.hypot(dx, dy) < 1) {
    dx = 0;
    dy = 1;
  }
  const halfWidth = Math.max(1, centerX - margin);
  const halfHeight = Math.max(1, centerY - margin);
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy),
  );
  return {
    mode: "edge",
    x: centerX + dx * scale,
    y: centerY + dy * scale,
    angle: Math.atan2(dy, dx),
  };
}

/** Distance in the HUD's units: nautical miles for aviation units, kilometres otherwise. */
export function formatAirportDistance(meters: number, aviation: boolean): string {
  const value = aviation ? meters / 1_852 : meters / 1_000;
  const unit = aviation ? "NM" : "KM";
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value).toString()} ${unit}`;
}

/**
 * Writes a placement onto the marker element with transforms only, so the
 * per-frame update never forces a layout.
 */
export function applyAirportMarker(
  element: HTMLElement,
  placement: AirportMarkerPlacement | null,
  label: string,
): void {
  if (!placement) {
    if (!element.hidden) element.hidden = true;
    return;
  }
  if (element.hidden) element.hidden = false;
  if (element.dataset.mode !== placement.mode) element.dataset.mode = placement.mode;
  element.style.transform = `translate3d(${placement.x.toFixed(1)}px, ${placement.y.toFixed(1)}px, 0)`;
  element.style.setProperty("--airport-marker-angle", `${placement.angle.toFixed(3)}rad`);
  const labelElement = element.querySelector<HTMLElement>("[data-airport-marker-label]");
  if (labelElement && labelElement.textContent !== label) labelElement.textContent = label;
}
