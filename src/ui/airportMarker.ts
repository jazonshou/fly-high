import type { ScreenPoint } from "@/src/render/types";

/** Inset from the top and bottom edges inside which the marker is drawn. */
export const AIRPORT_MARKER_EDGE_MARGIN = 64;

/**
 * Inset from the left and right edges: wide enough that an arrow riding the
 * side, label and all, stays inboard of the speed and altitude tapes (146 px
 * from the edge on desktop, 90 px at the narrow layout's 820 px breakpoint).
 */
export function airportMarkerSideMargin(width: number): number {
  return width > 820 ? 200 : 150;
}

export interface AirportMarkerPlacement {
  /** "on" draws the diamond over the airport; "edge" pins an arrow to the screen edge. */
  mode: "on" | "edge";
  x: number;
  y: number;
  /** Direction from screen centre toward the airport, radians, screen space (+x right, +y down). */
  angle: number;
}

export function createAirportMarkerPlacement(): AirportMarkerPlacement {
  return { mode: "on", x: 0, y: 0, angle: 0 };
}

/**
 * Where the nearest-airport marker goes this frame, written into `result`.
 * In view, it sits on the runway; out of view (beside or behind the camera)
 * it rides the screen edge, pointing the way to turn.
 */
export function placeAirportMarker(
  point: ScreenPoint,
  result: AirportMarkerPlacement = createAirportMarkerPlacement(),
): AirportMarkerPlacement {
  const marginX = airportMarkerSideMargin(point.width);
  const marginY = AIRPORT_MARKER_EDGE_MARGIN;
  const centerX = point.width * 0.5;
  const centerY = point.height * 0.5;
  let dx = point.x - centerX;
  let dy = point.y - centerY;
  const inside = point.inFront
    && point.x >= marginX && point.x <= point.width - marginX
    && point.y >= marginY && point.y <= point.height - marginY;
  if (inside) {
    result.mode = "on";
    result.x = point.x;
    result.y = point.y;
    result.angle = Math.atan2(dy, dx);
    return result;
  }
  // Directly behind, the projection collapses toward the centre: point down,
  // which reads as "turn around".
  if (Math.hypot(dx, dy) < 1) {
    dx = 0;
    dy = 1;
  }
  const halfWidth = Math.max(1, centerX - marginX);
  const halfHeight = Math.max(1, centerY - marginY);
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy),
  );
  result.mode = "edge";
  result.x = centerX + dx * scale;
  result.y = centerY + dy * scale;
  result.angle = Math.atan2(dy, dx);
  return result;
}

/** Distance in the HUD's units: nautical miles for aviation units, kilometres otherwise. */
export function formatAirportDistance(meters: number, aviation: boolean): string {
  const value = aviation ? meters / 1_852 : meters / 1_000;
  const unit = aviation ? "NM" : "KM";
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value).toString()} ${unit}`;
}

/** What the marker element last showed, so a frame that changes nothing writes nothing. */
export interface AirportMarkerView {
  readonly element: HTMLElement;
  readonly label: HTMLElement | null;
  mode: "on" | "edge" | "hidden";
  x: number;
  y: number;
  angle: number;
  text: string;
}

export function createAirportMarkerView(element: HTMLElement): AirportMarkerView {
  return {
    element,
    label: element.querySelector<HTMLElement>("[data-airport-marker-label]"),
    mode: element.hidden ? "hidden" : "on",
    x: Number.NaN,
    y: Number.NaN,
    angle: Number.NaN,
    text: "",
  };
}

/**
 * Writes a placement onto the marker element with transforms only, so the
 * per-frame update never forces a layout. Positions snap to half a pixel and
 * only a change is written: a still marker costs no style work at all.
 */
export function applyAirportMarker(
  view: AirportMarkerView,
  placement: AirportMarkerPlacement | null,
  text: string,
): void {
  const element = view.element;
  if (!placement) {
    if (view.mode !== "hidden") {
      element.hidden = true;
      view.mode = "hidden";
    }
    return;
  }
  if (view.mode === "hidden") element.hidden = false;
  if (view.mode !== placement.mode) {
    element.dataset.mode = placement.mode;
    view.mode = placement.mode;
  }
  const x = Math.round(placement.x * 2) / 2;
  const y = Math.round(placement.y * 2) / 2;
  if (x !== view.x || y !== view.y) {
    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    view.x = x;
    view.y = y;
  }
  const angle = Math.round(placement.angle * 500) / 500;
  if (angle !== view.angle) {
    element.style.setProperty("--airport-marker-angle", `${angle}rad`);
    view.angle = angle;
  }
  if (view.label && text !== view.text) {
    view.label.textContent = text;
    view.text = text;
  }
}
