import { describe, expect, it } from "vitest";
import {
  BOAT_NAV_LIGHTS_ON_BELOW_SUN_DEGREES,
  BOAT_SIDELIGHT_ARC_DEGREES,
  boatNavLightsOn,
  boatSidelightAtAzimuth,
  boatWashLights,
  resolveBoatLights,
  type BoatNavLight,
} from "../src/render/webgpu/boat/boatLights";
import { NAV_LIGHT_OUT_OF_ARC_SCALE } from "../src/render/webgpu/lighting/AircraftLighting";

const NIGHT = Math.sin((-12 * Math.PI) / 180);
const NOON = Math.sin((60 * Math.PI) / 180);

describe("boat navigation lights (COLREGs Rules 21 and 23)", () => {
  it("gives each sidelight 112.5 degrees, sampled around the hull, and neither from astern", () => {
    const step = 0.01;
    const seen = new Map<BoatNavLight | null, number>();
    for (let a = -180; a < 180; a += step) {
      const light = boatSidelightAtAzimuth(a);
      seen.set(light, (seen.get(light) ?? 0) + 1);
    }
    const degrees = (light: BoatNavLight | null): number => (seen.get(light) ?? 0) * step;
    expect(degrees("port")).toBeCloseTo(BOAT_SIDELIGHT_ARC_DEGREES, 1);
    expect(degrees("starboard")).toBeCloseTo(BOAT_SIDELIGHT_ARC_DEGREES, 1);
    // 360 - 2 x 112.5: the 135 degree stern arc the white light alone covers.
    expect(degrees(null)).toBeCloseTo(135, 1);
  });

  it("puts red to port and green to starboard, dead ahead to starboard, and wraps bearings", () => {
    expect(boatSidelightAtAzimuth(0)).toBe("starboard");
    expect(boatSidelightAtAzimuth(-0.001)).toBe("port");
    expect(boatSidelightAtAzimuth(90)).toBe("starboard");
    expect(boatSidelightAtAzimuth(-90)).toBe("port");
    // 22.5 degrees abaft the beam is the edge.
    expect(boatSidelightAtAzimuth(112.4)).toBe("starboard");
    expect(boatSidelightAtAzimuth(112.5)).toBeNull();
    expect(boatSidelightAtAzimuth(-112.4)).toBe("port");
    expect(boatSidelightAtAzimuth(-112.5)).toBeNull();
    expect(boatSidelightAtAzimuth(180)).toBeNull();
    expect(boatSidelightAtAzimuth(-180)).toBeNull();
    expect(boatSidelightAtAzimuth(360 + 45)).toBe("starboard");
    expect(boatSidelightAtAzimuth(-360 - 45)).toBe("port");
    expect(boatSidelightAtAzimuth(Number.NaN)).toBeNull();
  });

  it("switches the lamps on from sunset, ramping over the last degrees, and lights a NaN sun", () => {
    expect(boatNavLightsOn(NOON)).toBe(0);
    expect(boatNavLightsOn(Math.sin(((BOAT_NAV_LIGHTS_ON_BELOW_SUN_DEGREES + 0.01) * Math.PI) / 180))).toBe(0);
    expect(boatNavLightsOn(0)).toBe(1);
    expect(boatNavLightsOn(NIGHT)).toBe(1);
    expect(boatNavLightsOn(Number.NaN)).toBe(1);
    let previous = 0;
    for (let degrees = BOAT_NAV_LIGHTS_ON_BELOW_SUN_DEGREES; degrees >= 0; degrees -= 0.1) {
      const on = boatNavLightsOn(Math.sin((degrees * Math.PI) / 180));
      expect(on).toBeGreaterThanOrEqual(previous);
      previous = on;
    }
  });

  it("resolves through the aircraft law's shape: sidelights by bearing, white all round, nothing else", () => {
    const fromStarboard = resolveBoatLights({ observerAzimuthDegrees: 60, sunElevationSine: NIGHT, horizontalLux: 0 });
    expect(fromStarboard.starboardNav).toBe(1);
    expect(fromStarboard.portNav).toBe(NAV_LIGHT_OUT_OF_ARC_SCALE);
    expect(fromStarboard.tailNav).toBe(1);
    expect(fromStarboard.beacon).toBe(0);
    expect(fromStarboard.strobe).toBe(0);
    expect(fromStarboard.landing).toBe(0);

    const fromAstern = resolveBoatLights({ observerAzimuthDegrees: 170, sunElevationSine: NIGHT, horizontalLux: 0 });
    expect(fromAstern.portNav).toBe(NAV_LIGHT_OUT_OF_ARC_SCALE);
    expect(fromAstern.starboardNav).toBe(NAV_LIGHT_OUT_OF_ARC_SCALE);
    expect(fromAstern.tailNav).toBe(1);

    const byDay = resolveBoatLights({ observerAzimuthDegrees: 60, sunElevationSine: NOON, horizontalLux: 80_000 });
    expect(byDay.portNav).toBe(0);
    expect(byDay.starboardNav).toBe(0);
    expect(byDay.tailNav).toBe(0);
  });

  it("spills each sidelight on its own deck in its own colour, within a few metres", () => {
    const washes = boatWashLights({ port: [3, 0.9, -0.1], starboard: [3, 0.9, 0.1], allRound: [-2, 2, 0] });
    expect(washes.map((wash) => wash.driver)).toEqual(["portNav", "starboardNav"]);
    const [port, starboard] = washes;
    expect(port!.offset).toEqual([3, 0.9, -0.1]);
    expect(port!.color[0]).toBeGreaterThan(port!.color[1]);
    expect(starboard!.color[1]).toBeGreaterThan(starboard!.color[0]);
    for (const wash of washes) expect(wash.rangeMeters).toBeLessThanOrEqual(3);
  });
});
