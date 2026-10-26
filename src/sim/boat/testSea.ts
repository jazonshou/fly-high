import type {
  HullWaterSampler,
  WaterSurfaceSample,
  WaveFieldFocus,
} from "../water/types";

/**
 * A few long, linear (Airy) deep-water waves: the sea the boat physics is
 * developed and tested on until the spectral twin lands, and the fixture the
 * wave tests keep using, because its heights, slopes and orbital velocities
 * are exact.
 *
 *   eta = sum a_i cos(k_i . x - w_i t + phi_i),   w_i^2 = g k_i,
 *   u   = sum a_i w_i (cos, cos, sin) ...         at the surface.
 *
 * Deep water everywhere the bed is below `seaLevel`; dry ground elsewhere.
 */
export interface TestWave {
  /** Wave height crest to trough, m. */
  readonly height: number;
  /** Wavelength, m. */
  readonly length: number;
  /** Direction the wave TRAVELS toward, radians, atan2(dir.x, dir.z) like a heading. */
  readonly direction: number;
  readonly phase?: number;
}

const GRAVITY = 9.80665;

export class TestSea implements HullWaterSampler {
  private time = 0;
  private readonly amplitude: Float64Array;
  private readonly kx: Float64Array;
  private readonly kz: Float64Array;
  private readonly omega: Float64Array;
  private readonly phase: Float64Array;

  constructor(
    waves: readonly TestWave[],
    private readonly seaLevel = 0,
    private readonly bedHeight: (x: number, z: number) => number = () => -1_000,
  ) {
    const n = waves.length;
    this.amplitude = new Float64Array(n);
    this.kx = new Float64Array(n);
    this.kz = new Float64Array(n);
    this.omega = new Float64Array(n);
    this.phase = new Float64Array(n);
    waves.forEach((wave, i) => {
      const k = (2 * Math.PI) / wave.length;
      this.amplitude[i] = wave.height / 2;
      this.kx[i] = k * Math.sin(wave.direction);
      this.kz[i] = k * Math.cos(wave.direction);
      this.omega[i] = Math.sqrt(GRAVITY * k);
      this.phase[i] = wave.phase ?? 0;
    });
  }

  setTime(time: number): void {
    this.time = time;
  }

  setFocus(focus: Readonly<WaveFieldFocus>): void {
    void focus;
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    let eta = 0;
    let slopeX = 0;
    let slopeZ = 0;
    let ux = 0;
    let uy = 0;
    let uz = 0;
    for (let i = 0; i < this.amplitude.length; i += 1) {
      const a = this.amplitude[i]!;
      const kx = this.kx[i]!;
      const kz = this.kz[i]!;
      const w = this.omega[i]!;
      const theta = kx * x + kz * z - w * this.time + this.phase[i]!;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      eta += a * c;
      slopeX -= a * kx * s;
      slopeZ -= a * kz * s;
      const k = Math.hypot(kx, kz);
      // Surface orbital velocity of a progressive deep-water wave.
      const horizontal = a * w * c;
      ux += (horizontal * kx) / k;
      uz += (horizontal * kz) / k;
      uy += a * w * s;
    }
    const bed = this.bedHeight(x, z);
    const depth = this.seaLevel - bed;
    const inv = 1 / Math.hypot(slopeX, 1, slopeZ);
    out.normal.x = -slopeX * inv;
    out.normal.y = inv;
    out.normal.z = -slopeZ * inv;
    out.stillHeight = this.seaLevel;
    if (Number.isFinite(depth) && depth > 0) {
      out.kind = "sea";
      out.height = this.seaLevel + eta;
      out.depth = depth;
      out.velocity.x = ux;
      out.velocity.y = uy;
      out.velocity.z = uz;
    } else {
      out.kind = "none";
      out.height = Number.isFinite(bed) ? bed : this.seaLevel;
      out.depth = 0;
      out.velocity.x = 0;
      out.velocity.y = 0;
      out.velocity.z = 0;
    }
    return out;
  }
}
