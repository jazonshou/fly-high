# Re-pinning the banked shots' temporal floors

2026-09-21. `page-thrash-turn` failed its consecutive-frame SSIM floor in the
promotion capture at bd5d947 (0.6299 against 0.67). This is what it was, and
why the floor moved rather than the code.

## One 0.67 floor at 0, 45 and 60 degrees was never measuring the same quantity

Three shots shared one `minConsecutiveSsim` floor. They sit naturally at:

    cdlod-transition      0 deg bank    0.9755
    motion-banked-turn   45 deg bank    0.7826
    page-thrash-turn     60 deg bank    0.6299

On a banked chase shot the consecutive-frame metric counts CAMERA work as much
as flicker: the steeper the bank, the more scene sweeps across the frame per
fixed simulation-time step. A single floor across those three angles gave the
level shot 46% of headroom and the 60-degree shot none.

New floors, per shot, from what each measures:

    page-thrash-turn     0.67 -> 0.60   measured 0.6300, margin 0.0300
    motion-banked-turn   0.67 -> 0.75   measured 0.7826, margin 0.0324  TIGHTENS
    cdlod-transition     0.67 stays     measured 0.9755, the level control

`maxMeanLuminanceDelta` stays 0.01 on all three. **That is the flicker detector
that matters and it never moved**: 0.0005 throughout, 20x inside its gate.
Genuine flicker still fails it.

The 45-degree shot TIGHTENS, and that is the point. Re-pinning only the shot
that failed would be choosing the direction of the evidence; it had been
carrying a floor far looser than its own behaviour and now has a real gate.

## The bisect

One shot per tree, filtered:

    41fc505  09-17  water-environment-colour   0.6718   passing by 0.0018
    216d5e4  09-17  terrain-ground-texture     0.6674   CROSSED, by 0.0044
    1510b74  09-19  water-sun-glitter          0.6673   flat
    3f1af43  09-19  chase-rig re-centring      0.6374   -0.0300 in one commit
    74da0a7  09-19  aileron/rudder sides       0.6374   no change
    9c6d059  09-19  chase trail keyed to motion 0.6374  no change
    bd5d947  09-21  today                      0.6300

Two events, and only the first is a crossing. Terrain's ground texture moved it
0.0044 on a shot already 0.0018 from its floor. The MOVEMENT was the chase
rig's 0.0300, seven times the crossing.

Identified by its signature rather than asserted: the effect scales with bank.

    cdlod-transition      0 deg    0.9780 -> 0.9784   +0.0004
    motion-banked-turn   45 deg    0.7943 -> 0.7828   -0.0115
    page-thrash-turn     60 deg    0.6674 -> 0.6374   -0.0300

Zero at wings level, and the rig change is bit-identical for a wings-level rig
by a test pinned to ten decimals. Nothing else in that merge does that.

## Why the rig was kept

`3f1af43` fixes a real defect: the view rolled 18% of the bank while the rig's
position and aim were raised along the aircraft's up at FULL strength, so the
two disagreed by 82% of the bank and the airframe slid sideways out of frame at
0.155% of frame width per degree.

**What changed is the rig's POSITION and AIM, which now build on the
bank-blended vertical. `cameraBankFollow` is byte-identical across the commit
at 0.18 and was already live when the baseline was captured (0ed07bc, one call
site), so THE SHOT'S CONTENTS CHANGED, NOT ITS ROLL.** Reading the candidate's
horizon tilt as new bank-following is the natural mistake and it is wrong: the
tilt is in the baseline too. What the fix changes is what the frame
CONTAINS, so a frame-to-frame metric must move. Reverting it would reinstate a
visible defect to satisfy a floor that was within 0.0018 of failing before any
of this work started.

There is no switch for it. The commit RESTRUCTURED the rig —
`chaseRigOffsetsToRef` and `cameraRigLiftToRef` are new and the old offset
computation is gone. Neutralising both camera knobs at that commit recovers
0.0040 of the 0.0301, about 13%: setting the lift blend to zero makes the new
rig use world up, it does not restore the old rig.

## What it was NOT

- **Not the far-sward dial.** Flipping `TERRAIN_FAR_SWARD_READ` 1 -> 0 moves it
  0.0002 against a 0.0400 shortfall. Jason's dial is exonerated.
- **Not the host.** Across fifteen runs fps ranged **38.8 to 95.3** while this
  read 0.6373-0.6374 — one ten-thousandth against 2.5x the frame rate. The
  capture steps SIMULATION time on a fixed schedule, so frame N and N+1 differ
  by a fixed amount of simulated motion however fast the host renders them.
- **Not today's merge.** It had been below the floor since 09-19.

## The instrument, and the trap next door

Filtered single-shot runs are valid FOR THIS METRIC: full-vs-filtered differs
by 1e-4. **They are not valid for hitch count**, measured on the same two runs
of the same tree:

                            full(39)   filtered(3)
      minConsecutiveSsim      0.6299       0.6300
      hitchCount                   0           29

Hitching is a property of the streaming history a shot arrives with, which the
shot list decides. Consecutive-frame SSIM is a property of a fixed sim-time
step, which it does not.

## The miss, which was mine

I wrote the chase-rig change and I named these exact two shots as the only ones
it touches — "only `motion-banked-turn` (45 deg) and `page-thrash-turn` (60 deg)
re-centre, by design". I then checked that claim against the IMAGE baseline and
never against the temporal one. Both shots have their image gate deliberately
disabled, so the churn I correctly predicted was invisible by construction while
the effect that actually gated went unmeasured for two days.

The rule it cost: **when you predict a change will move a shot, check the gate
that shot actually carries, not the gate you happen to be looking at.** A shot
with `comparesToBaseline: false` is not an unguarded shot; it is a shot guarded
somewhere else.

Two smaller ones from the same session. A roof-clearance test that cast rays
from a point INSIDE the body could not fail, because every ray from an interior
point exits the surface in every direction. And a measurement of a historical
commit read zero call sites for a symbol that was present — its control, a
string that had to be there, also read zero, which is what caught it: a shell
quoting fault meant the grep was reading an empty string rather than the file.
