import { clamp, smoothstep, valueNoise2D } from "./noise";
import { mixSeed } from "./seed";
import type { WindSample, WorldDefinition } from "./types";

const MAX_WIND_SPEED = 32;

function createWindTarget(): WindSample {
  return { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
}

/**
 * Deterministic, continuous wind field. `timeSeconds` is simulation time rather
 * than wall time, which keeps replays reproducible and pause-safe.
 */
export function sampleWind(
  world: WorldDefinition,
  x: number,
  y: number,
  z: number,
  timeSeconds: number,
  target: WindSample = createWindTarget(),
): WindSample {
  if (![x, y, z, timeSeconds].every(Number.isFinite)) {
    throw new RangeError("Wind coordinates and time must be finite");
  }

  const flowX = Math.sin(world.prevailingWindRadians);
  const flowZ = Math.cos(world.prevailingWindRadians);
  const crossX = flowZ;
  const crossZ = -flowX;

  const advectedX = x / 720 + flowX * timeSeconds * 0.025;
  const advectedZ = z / 720 + flowZ * timeSeconds * 0.025;
  const gust = valueNoise2D(mixSeed(world.seedHash, 320), advectedX, advectedZ);
  const directionNoise = valueNoise2D(
    mixSeed(world.seedHash, 321),
    x / 1_700 + timeSeconds * 0.009,
    z / 1_700 - timeSeconds * 0.006,
  );
  const verticalNoise = valueNoise2D(
    mixSeed(world.seedHash, 322),
    y / 380 + timeSeconds * 0.018,
    (x + z) / 980 - timeSeconds * 0.012,
  );

  const approximateAgl = Math.max(0, y - (world.airport?.elevation ?? world.seaLevel));
  const boundaryLayer = 0.34 + 0.66 * smoothstep(0, 480, approximateAgl);
  const gustStrength = 0.15 + smoothstep(30, 900, approximateAgl) * 0.1;
  const forwardSpeed = world.prevailingWindSpeed * boundaryLayer * (1 + gust * gustStrength);
  const crossSpeed = directionNoise * Math.min(3.2, world.prevailingWindSpeed * 0.28);
  const verticalSpeed = verticalNoise * (0.25 + smoothstep(60, 1_400, approximateAgl) * 1.25);

  target.x = flowX * forwardSpeed + crossX * crossSpeed;
  target.y = verticalSpeed;
  target.z = flowZ * forwardSpeed + crossZ * crossSpeed;
  const unboundedSpeed = Math.hypot(target.x, target.y, target.z);
  if (unboundedSpeed > MAX_WIND_SPEED) {
    const scale = MAX_WIND_SPEED / unboundedSpeed;
    target.x *= scale;
    target.y *= scale;
    target.z *= scale;
  }
  target.speed = Math.hypot(target.x, target.y, target.z);
  target.gust = clamp(gust, -1, 1);
  target.turbulence = clamp(Math.abs(directionNoise) * 0.55 + Math.abs(verticalNoise) * 0.45, 0, 1);
  return target;
}

export { MAX_WIND_SPEED };
