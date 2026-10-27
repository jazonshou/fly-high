import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NearestAirportInfo } from "../src/game/AirportNetworkController";
import { INITIAL_VISUAL_STATE, type CarVisualState, type FlightVisualState } from "../src/game/types";
import { AircraftPicker } from "../src/ui/AircraftPicker";
import {
  CAR_TACHOMETER_REDLINE_RPM,
  carGearLabel,
  CarHud,
  compassPoint,
  carTiltLevel,
  carWading,
  formatWadingDepth,
} from "../src/ui/CarHud";
import { CarTyrePanel } from "../src/ui/CarTyrePanel";
import { Hud } from "../src/ui/Hud";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";

/**
 * The car's panels: the HUD (speed, tachometer, gear, range, lamps,
 * inclinometer, wading bar, alerts, nearest airport), the picker's gearbox
 * choice on the car's card and the pause menu's tyre panel.
 */

const carPayload = (overrides: Partial<CarVisualState> = {}): CarVisualState => ({
  kind: "car",
  speed: 0,
  gearbox: "automatic",
  selector: "P",
  gear: 0,
  range: "2H",
  locks: "off",
  downhillAssist: false,
  downhillAssistActive: false,
  tractionControlActive: false,
  absActive: false,
  clutch: 1,
  engineRunning: true,
  stalled: false,
  flooded: false,
  rolled: false,
  boost: 0,
  headlights: "off",
  brakeLights: false,
  reversing: false,
  tyrePressure: "road",
  tyrePressureBar: 2.4,
  wadingDepth: 0,
  settling: false,
  wheelSteer: [0, 0, 0, 0],
  wheelSpin: [0, 0, 0, 0],
  wheelSpinRate: [0, 0, 0, 0],
  wheelLoad: [5_500, 5_500, 5_000, 5_000],
  wheelSlip: [0, 0, 0, 0],
  wheelSinkage: [0, 0, 0, 0],
  wheelSurface: [8, 8, 8, 8],
  wheelWetness: [0, 0, 0, 0],
  axleHeave: [0, 0],
  axleRoll: [0, 0],
  steeringWheel: 0,
  bumpStop: 0,
  scrape: 0,
  splash: 0,
  ...overrides,
});

const NEAREST: NearestAirportInfo = {
  ident: "KQRT",
  isHome: true,
  runways: "05/23",
  distanceMeters: 2_400,
  bearingDegrees: 47,
  markerX: 0,
  markerY: 0,
  markerZ: 0,
};

function renderCar(
  car: CarVisualState,
  options: {
    state?: Partial<FlightVisualState>;
    units?: "metric" | "aviation";
    mode?: "full" | "minimal";
    cameraMode?: "chase" | "cockpit";
    nearest?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(createElement(CarHud, {
    state: { ...INITIAL_VISUAL_STATE, engineRpm: 750, altitude: 120, heading: 90, pitch: 0, bank: 0, ...options.state, vehicle: car },
    car,
    mode: options.mode ?? "full",
    flightMode: "pilot",
    units: options.units ?? "metric",
    cameraMode: options.cameraMode ?? "chase",
    cameraLabel: "CHASE",
    seedLabel: "51A7E",
    nearestAirport: NEAREST,
    nearestAirportShown: options.nearest ?? false,
    onToggleNearestAirport: () => undefined,
  }));
}

describe("the car's HUD", () => {
  it("shows road speed in km/h, or mph with aviation units, and elevation in metres or feet", () => {
    const car = carPayload({ speed: -10 });
    const metric = renderCar(car);
    expect(metric).toContain('aria-label="SPD: 36 KM/H"');
    expect(metric).toContain('aria-label="ELEV: 120 M"');
    const imperial = renderCar(car, { units: "aviation" });
    expect(imperial).toContain('aria-label="SPD: 22 MPH"');
    expect(imperial).toContain('aria-label="ELEV: 394 FT"');
  });

  it("labels the gear as the automatic's selector or the manual's gear", () => {
    expect(carGearLabel(carPayload({ selector: "P" }))).toBe("P");
    expect(carGearLabel(carPayload({ selector: "D", gear: 4 }))).toBe("D");
    expect(carGearLabel(carPayload({ selector: "M", gear: 3 }))).toBe("M3");
    expect(carGearLabel(carPayload({ selector: "R", gear: -1 }))).toBe("R");
    expect(carGearLabel(carPayload({ gearbox: "manual", selector: null, gear: -1 }))).toBe("R");
    expect(carGearLabel(carPayload({ gearbox: "manual", selector: null, gear: 0 }))).toBe("N");
    expect(carGearLabel(carPayload({ gearbox: "manual", selector: null, gear: 5 }))).toBe("5");
    const manual = renderCar(carPayload({ gearbox: "manual", selector: null, gear: 2 }));
    expect(manual).toContain('aria-label="Gear 2"');
    expect(manual).toContain("MANUAL");
  });

  it("draws the tachometer against the engine's own fuel cut", () => {
    expect(CAR_TACHOMETER_REDLINE_RPM).toBe(LANDCRUISER_76.engine.limiterRpm);
    const html = renderCar(carPayload(), { state: { engineRpm: 2_250 } });
    expect(html).toContain('aria-label="Engine 2250 rpm"');
    expect(html).toContain("transform:scaleX(0.5)");
    expect(html).toContain(`left:${(LANDCRUISER_76.engine.limiterRpm / 4_500) * 100}%`);
  });

  it("lights the diff-lock, downhill-assist, traction, ABS and main-beam lamps from the payload", () => {
    const dark = renderCar(carPayload());
    expect(dark).toContain("Lamps: none lit");
    expect(dark).not.toContain("is-lit");

    const rear = renderCar(carPayload({ locks: "rear", range: "4L" }));
    expect(rear).toContain("DIFF REAR");
    expect(rear).toContain('aria-label="Range 4L"');
    expect(rear.match(/car-lamp[^"]*is-lit/g)).toHaveLength(1);

    const working = renderCar(carPayload({
      locks: "both",
      downhillAssist: true,
      downhillAssistActive: true,
      tractionControlActive: true,
      absActive: true,
      headlights: "main",
    }));
    expect(working).toContain("DIFF F + R");
    expect(working.match(/car-lamp[^"]*is-lit/g)).toHaveLength(6);
    // Working right now flashes; merely armed or locked does not.
    expect(working.match(/car-lamp[^"]*is-active/g)).toHaveLength(3);
    expect(working).toContain("downhill assist holding");
  });

  it("tilts the inclinometer's car by the pitch and the roll, amber from 30 degrees and red from 36", () => {
    expect(carTiltLevel(12, -8)).toBe("normal");
    expect(carTiltLevel(-31, 0)).toBe("warning");
    expect(carTiltLevel(5, 37)).toBe("danger");
    const html = renderCar(carPayload(), { state: { pitch: 14, bank: -32 } });
    expect(html).toContain("car-inclinometer--warning");
    expect(html).toContain('transform="rotate(-14)"');
    expect(html).toContain('transform="rotate(-32)"');
    expect(html).toContain('aria-label="Pitch 14 degrees nose up"');
    expect(html).toContain('aria-label="Roll 32 degrees left side down"');
    // The minimal HUD keeps the compass and the alerts.
    const minimal = renderCar(carPayload(), { mode: "minimal" });
    expect(minimal).toContain('aria-label="Heading 090"');
    expect(minimal).not.toContain("PITCH");
  });

  it("turns the compass card under the lubber line by the heading", () => {
    const html = renderCar(carPayload(), { state: { heading: 271.6 } });
    expect(html).toContain('aria-label="Heading 272"');
    expect(html).toContain('transform="rotate(-272)"');
    expect(html).toContain("<em>W</em>");
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(22)).toBe("N");
    expect(compassPoint(23)).toBe("NE");
    expect(compassPoint(-90)).toBe("W");
    expect(compassPoint(359)).toBe("N");
  });

  it("shows the wading bar only in water, filling to the 700 mm intake, amber at 70% and red at 90%", () => {
    expect(carWading(0).fraction).toBe(0);
    expect(carWading(0.35)).toEqual({ fraction: 0.5, level: "normal" });
    expect(carWading(0.5).level).toBe("warning");
    expect(carWading(0.65).level).toBe("danger");
    expect(carWading(2).fraction).toBe(1);
    expect(formatWadingDepth(0.42, false)).toBe("42 CM");
    expect(formatWadingDepth(0.42, true)).toBe("17 IN");

    expect(renderCar(carPayload({ wadingDepth: 0.02 }))).not.toContain("car-wading");
    const ford = renderCar(carPayload({ wadingDepth: 0.4 }));
    expect(ford).toContain("car-wading--normal");
    expect(ford).not.toContain("DEEP WATER");
    const deep = renderCar(carPayload({ wadingDepth: 0.66 }));
    expect(deep).toContain("car-wading--danger");
    expect(deep).toContain("DEEP WATER");
  });

  it("raises FLOODED, ROLLED and STALLED, the worst alone", () => {
    expect(renderCar(carPayload({ stalled: true }))).toContain("STALLED");
    const flooded = renderCar(carPayload({ flooded: true, stalled: true, wadingDepth: 0.9 }));
    expect(flooded).toContain("FLOODED · PRESS R");
    expect(flooded).not.toContain("STALLED");
    expect(flooded).not.toContain("DEEP WATER");
    const rolled = renderCar(carPayload({ rolled: true, flooded: true }));
    expect(rolled).toContain("ROLLED · PRESS R");
    expect(rolled).not.toContain("FLOODED");
    const crashed = renderCar(carPayload({ rolled: true }), { state: { crashed: true } });
    expect(crashed).toContain("CAR DAMAGED · PRESS R");
    expect(crashed).not.toContain("ROLLED");
  });

  it("says WAITING FOR TERRAIN, quietly and alone, while the car waits at its start", () => {
    const settling = renderCar(carPayload({ settling: true, stalled: true, wadingDepth: 0.66 }));
    expect(settling).toContain("WAITING FOR TERRAIN");
    expect(settling).toContain("flight-alert--quiet");
    expect(settling).toContain('role="status"');
    // Not an alarm: none of the car's alerts beside it.
    expect(settling).not.toContain("STALLED");
    expect(settling).not.toContain("DEEP WATER");
    expect(settling).not.toContain("flight-alert--warning");
    // Gone the moment the car is driven.
    expect(renderCar(carPayload())).not.toContain("WAITING FOR TERRAIN");
    // A damaged car still says so.
    const crashed = renderCar(carPayload({ settling: true }), { state: { crashed: true } });
    expect(crashed).toContain("CAR DAMAGED · PRESS R");
    expect(crashed).not.toContain("WAITING FOR TERRAIN");
  });

  it("keeps the nearest-airport readout, as the aircraft HUD draws it", () => {
    const off = renderCar(carPayload());
    expect(off).toContain("NEAREST AIRPORT");
    expect(off).not.toContain("hud-nearest__readout");
    const on = renderCar(carPayload(), { nearest: true });
    expect(on).toContain("hud-nearest__readout");
    expect(on).toContain("KQRT");
    expect(on).toContain("BRG 047°");
    expect(on).toContain("N nearest airport");
  });

  it("moves the strip off the dash in the cockpit, and only there", () => {
    expect(renderCar(carPayload(), { cameraMode: "cockpit" })).toContain("flight-hud--car-cockpit");
    expect(renderCar(carPayload())).not.toContain("flight-hud--car-cockpit");
  });

  it("is what the HUD draws for a car session, with the nearest airport passed through", () => {
    const car = carPayload({ selector: "D", gear: 3 });
    const html = renderToStaticMarkup(createElement(Hud, {
      state: { ...INITIAL_VISUAL_STATE, vehicle: car },
      aircraft: "trainer",
      mode: "full",
      flightMode: "pilot",
      units: "metric",
      diagnostics: null,
      showDiagnostics: false,
      cameraMode: "cockpit",
      cameraLabel: "COCKPIT",
      seedLabel: "51A7E",
      mouseFlight: false,
      nearestAirport: NEAREST,
      nearestAirportShown: true,
      onToggleNearestAirport: () => undefined,
    }));
    expect(html).toContain("flight-hud--car");
    expect(html).toContain("flight-hud--car-cockpit");
    expect(html).toContain("KQRT");
    expect(html).toContain('aria-label="Gear D"');
  });
});

describe("the picker's gearbox choice", () => {
  const render = (vehicle: "landcruiser" | "speedboat" | "trainer", gearbox: "automatic" | "manual", manualClutch = false) =>
    renderToStaticMarkup(createElement(AircraftPicker, {
      value: vehicle,
      onChange: () => undefined,
      carSetup: { gearbox, manualClutch },
      onCarSetupChange: () => undefined,
    }));

  it("opens on the car's card only while the car is chosen", () => {
    expect(render("trainer", "automatic")).not.toContain("aircraft-picker__car-setup");
    expect(render("speedboat", "automatic")).not.toContain("aircraft-picker__car-setup");
    const car = render("landcruiser", "automatic");
    expect(car).toContain("aircraft-picker__car-setup");
    expect(car).toMatch(/checked="" value="automatic"/);
    // The clutch is the manual's: the automatic has none.
    expect(car).not.toContain("Clutch pedal");
  });

  it("offers the clutch pedal with the manual, as settings hold it", () => {
    const manual = render("landcruiser", "manual");
    expect(manual).toMatch(/checked="" value="manual"/);
    expect(manual).toContain("Clutch pedal");
    expect(manual).not.toMatch(/type="checkbox" checked=""/);
    expect(render("landcruiser", "manual", true)).toMatch(/type="checkbox" checked=""/);
  });

  it("leaves the picker exactly as it was without a car setup", () => {
    const plain = renderToStaticMarkup(createElement(AircraftPicker, { value: "landcruiser", onChange: () => undefined }));
    expect(plain).not.toContain("aircraft-picker__car-setup");
  });
});

describe("the pause menu's tyre panel", () => {
  const render = (car: CarVisualState) => renderToStaticMarkup(createElement(CarTyrePanel, { car, onChange: () => undefined }));

  it("offers road and sand, with the asked-for preset chosen", () => {
    const html = render(carPayload({ tyrePressure: "sand", tyrePressureBar: 1.2 }));
    expect(html).toContain("2.4 BAR");
    expect(html).toContain("1.2 BAR");
    expect(html).toMatch(/checked="" value="sand"/);
    expect(html).toContain("Holding 1.2 bar");
  });

  it("says the tyres change only at a stop", () => {
    expect(render(carPayload({ tyrePressure: "sand", tyrePressureBar: 2.4, speed: 8 }))).toContain("stop to air down");
    expect(render(carPayload({ tyrePressure: "road", tyrePressureBar: 1.6 }))).toContain("inflating on resume");
  });
});
