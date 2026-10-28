import { CH, LIMB_OFFSET, SIDE_BASE } from "./channels";
import {
  armChannel,
  armSwingScale,
  createHarmonicBasis,
  dimensionlessSpeed,
  gaitSeries,
  harmonicBasis,
  runChannel,
  runFamilyShare,
  runFootOff,
  walkChannel,
  walkChannelMean,
  walkFootOff,
  walkGroupBlend,
  type GroupBlend,
} from "./gait";
import type { RunChannel, WalkChannel } from "./gaitData";

/**
 * The gait as channels: the published curves at the walker's speed and phase,
 * turned into the figure's anatomical angles (`channels.ts`).
 *
 * PHASE. The left leg's, 0 at its heel strike; the right leg runs half a
 * stride behind. Each leg reads its own phase, so the dataset's one-leg
 * curves drive both.
 *
 * THE PELVIS'S TILT. The dataset's hip flexion is measured from a pelvis that
 * stands tilted forward by its marker frame's offset (the tilt's stride mean,
 * about 12 degrees walking); the figure's pelvis stands level, so that mean
 * comes off the hip flexion (the thigh's angle in the room is what has to
 * match) and only the tilt's swing about its mean is kept. Running's mean
 * tilt, `RUN_PELVIC_TILT`, is an ESTIMATE from Novacheck's (1998) figures.
 */
export const RUN_PELVIC_TILT = 15;

const TRUNK_SWING_SCALE = 1;

export class GaitChannels {
  private readonly basis = [createHarmonicBasis(), createHarmonicBasis()] as const;
  private readonly blend: GroupBlend = { lower: 0, share: 0 };

  /** The stance share of a stride at this speed and walk-run blend. */
  footOff(speed: number, runBlend: number): number {
    walkGroupBlend(dimensionlessSpeed(speed), this.blend);
    const walk = walkFootOff(this.blend);
    if (runBlend <= 0) return walk;
    return walk + (runFootOff(runFamilyShare(speed)) - walk) * runBlend;
  }

  /**
   * Writes the gait's channels into `out` (every channel the gait owns; the
   * rest untouched): at the left leg's `phase`, `speed` m/s, `runBlend` 0
   * walking .. 1 running, and `amplitude` 0 standing .. 1 the full stride.
   */
  write(out: Float64Array, phase: number, speed: number, runBlend: number, amplitude: number): void {
    const blend = walkGroupBlend(dimensionlessSpeed(speed), this.blend);
    const runShare = runFamilyShare(speed);
    const left = harmonicBasis(fraction(phase), this.basis[0]);
    const right = harmonicBasis(fraction(phase + 0.5), this.basis[1]);
    const rb = runBlend;
    const walk = (channel: WalkChannel, basis: Float64Array): number => walkChannel(channel, blend, basis);
    const run = (channel: RunChannel, basis: Float64Array): number => runChannel(channel, runShare, basis);
    const mix = (channel: RunChannel & WalkChannel, basis: Float64Array): number =>
      rb <= 0 ? walk(channel, basis) : rb >= 1 ? run(channel, basis) : walk(channel, basis) + (run(channel, basis) - walk(channel, basis)) * rb;
    const runMean = (channel: RunChannel): number => {
      const packed = gaitSeries().run[channel];
      const jog = packed[0]!;
      return jog + (packed[packed.length / 2]! - jog) * runShare;
    };
    const mean = (channel: RunChannel & WalkChannel): number =>
      walkChannelMean(channel, blend) + ((rb > 0 ? runMean(channel) : 0) - walkChannelMean(channel, blend)) * rb;
    const tiltMean = walkChannelMean("pelvisTilt", blend) + (RUN_PELVIC_TILT - walkChannelMean("pelvisTilt", blend)) * rb;

    // Pelvis and trunk: each leg's curve read at its own phase, the right's mirrored, averaged.
    const pelvisTilt = 0.5 * (mix("pelvisTilt", left) + mix("pelvisTilt", right)) - mean("pelvisTilt");
    const pelvisBend = 0.5 * (mix("pelvisObliquity", left) - mix("pelvisObliquity", right));
    const pelvisTurn = 0.5 * (mix("pelvisRotation", left) - mix("pelvisRotation", right));
    const trunkTilt = 0.5 * (mix("trunkTilt", left) + mix("trunkTilt", right)) - mean("trunkTilt");
    const trunkBend = 0.5 * (mix("trunkObliquity", left) - mix("trunkObliquity", right));
    const trunkTurn = 0.5 * (mix("trunkRotation", left) - mix("trunkRotation", right));
    const a = amplitude;
    out[CH.pelvisTilt] = pelvisTilt * a;
    out[CH.pelvisBend] = pelvisBend * a;
    out[CH.pelvisTurn] = pelvisTurn * a;
    // The spine carries the trunk's motion relative to the pelvis.
    out[CH.spineFlex] = (trunkTilt - pelvisTilt) * a * TRUNK_SWING_SCALE;
    out[CH.spineBend] = (trunkBend - pelvisBend) * a * TRUNK_SWING_SCALE;
    out[CH.spineTurn] = (trunkTurn - pelvisTurn) * a * TRUNK_SWING_SCALE;
    // The head keeps facing the way of travel.
    out[CH.neckTurn] = -0.6 * trunkTurn * a;
    out[CH.headTurn] = -0.4 * trunkTurn * a;
    out[CH.neckBend] = -0.5 * trunkBend * a;
    out[CH.headBend] = -0.5 * trunkBend * a;

    const swing = armSwingScale(dimensionlessSpeed(speed));
    for (let side = 0; side < 2; side += 1) {
      const basis = side === 0 ? left : right;
      const base = SIDE_BASE[side as 0 | 1];
      const o = LIMB_OFFSET;
      const hipFlex = mix("hipFlexion", basis) - tiltMean;
      const hipAdd = mix("hipAdduction", basis);
      const hipRot = rb >= 1 ? 0 : walk("hipRotation", basis) * (1 - rb);
      const knee = mix("kneeFlexion", basis);
      const ankle = mix("ankleDorsiflexion", basis);
      const progression = mix("footProgression", basis);
      // The foot's angle to the way of travel is the pelvis's turn on this side, the hip's rotation and the shank's.
      const pelvisOnSide = side === 0 ? pelvisTurn : -pelvisTurn;
      const shank = Math.min(10, Math.max(-20, progression - hipRot - pelvisOnSide));
      out[base + o.hipFlex] = hipFlex * a;
      out[base + o.hipAbd] = -hipAdd * a;
      out[base + o.hipRot] = hipRot * a;
      out[base + o.knee] = 2 + (knee - 2) * a;
      out[base + o.kneeRot] = -6 + (shank + 6) * a;
      out[base + o.ankle] = ankle * a;
      out[base + o.ankleInv] = 0;
      out[base + o.toe] = 0;
      // Arms: the walking swing scaled with speed, or the run's.
      const shoulderWalk = armChannel("shoulderFlexion", false, swing, basis);
      const elbowWalk = armChannel("elbowFlexion", false, swing, basis);
      const shoulder = rb <= 0 ? shoulderWalk : shoulderWalk + (armChannel("shoulderFlexion", true, 1, basis) - shoulderWalk) * rb;
      const elbow = rb <= 0 ? elbowWalk : elbowWalk + (armChannel("elbowFlexion", true, 1, basis) - elbowWalk) * rb;
      out[base + o.shFlex] = shoulder * a;
      out[base + o.shAbd] = -3 + 3 * rb;
      out[base + o.shRot] = 8 * rb;
      out[base + o.elbow] = 12 + (elbow - 12) * Math.max(a, rb);
      out[base + o.foreTwist] = 10 * rb;
      out[base + o.wristFlex] = 5;
      out[base + o.fingers] = 25 + 25 * rb;
      out[base + o.thumb] = 15 + 15 * rb;
    }
  }
}

function fraction(value: number): number {
  return value - Math.floor(value);
}
