import { describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { createAircraft } from "../src/render/createAircraft";

describe("aircraft control-surface presentation", () => {
  it("moves each surface with pilot-friendly actuator signs", () => {
    const aircraft = createAircraft();
    aircraft.update({
      ...INITIAL_VISUAL_STATE,
      aileron: 0.8,
      elevator: 0.6,
      rudder: 0.5,
    }, 1 / 60);

    const starboard = aircraft.group.getObjectByName("starboard-aileron");
    const port = aircraft.group.getObjectByName("port-aileron");
    const elevator = aircraft.group.getObjectByName("elevator");
    const rudder = aircraft.group.getObjectByName("rudder");
    expect(starboard?.rotation.z).toBeLessThan(0);
    expect(port?.rotation.z).toBeGreaterThan(0);
    expect(elevator?.rotation.z).toBeLessThan(0);
    expect(rudder?.rotation.y).toBeLessThan(0);
    aircraft.dispose();
  });

  it("keeps the visible tyre bottoms aligned to the physics contact points", () => {
    const aircraft = createAircraft();
    const starboard = aircraft.group.getObjectByName("starboard-main-wheel");
    const port = aircraft.group.getObjectByName("port-main-wheel");
    const nose = aircraft.group.getObjectByName("nose-wheel-steering");
    expect(starboard?.position.y).toBeCloseTo(-1.07, 6);
    expect(port?.position.y).toBeCloseTo(-1.07, 6);
    expect((starboard?.position.y ?? 0) - 0.27).toBeCloseTo(-1.34, 6);
    expect((port?.position.y ?? 0) - 0.27).toBeCloseTo(-1.34, 6);
    expect((nose?.position.y ?? 0) - 0.21).toBeCloseTo(-1.16, 6);
    aircraft.dispose();
  });
});
