# Pinning the ocean's cascade cadence at each perf shot's time pin

**Status: built on `jazonshou/ocean-cascade-pin` from `8d31fd2`; awaiting harness-owner review.**

## The defect

A water shot's waves depended on how many frames every *earlier* shot of the
capture had streamed.

The ocean evolves each wave cascade only on the frames its cadence allows —
every 1, 1, 2 and 4 frames on tier 1 (`shouldUpdateOceanCascade`) — and counts
frames on a counter that one renderer carries across all 39 shots. The harness
already pins simulation *time* per shot, after streaming, so time was never the
problem. But the streaming loop before each shot is paced by wall-clock time, so
the *frame count* at a shot's capture varied between runs of identical code, and
its residue decided whether the every-4th-frame cascade (128-512 m waves) was
last evolved at the capture instant or a frame before it.

Measured over six full captures (2026-09-22): two phase classes per static
water shot, about 0.12-0.19/255 mean apart over roughly 28 % of the near sea,
flipping between runs with no code change and wholesale under `VITE_PERF_SHOTS`.
It tripped that day's water review, and the alpine-turf A/B attributed it to
glints "seeing the land through the reflection probe" — a probe that renders
only the sky.

## The fix

The frame counter became `OceanCascadeClock`, a small class beside
`shouldUpdateOceanCascade` in `nature/OceanConfig.ts`, which the ocean's compute
ticks. The harness calls `renderer.pinOceanCascadePhaseForCapture()` where it
already sets `simulationTime`, and that reaches `OceanCascadeClock.pinForCapture()`
through the ocean. Production never calls it: mid-flight it would dispatch the
slow cascades out of turn. A source-scan test holds that line.

**Foam is deliberately left alone.** It integrates — each derivation reads the
previous foam and decays it with a 2.8 s half-life — so about a fifth of its
pre-pin state survives the 6.6 s to capture. That is a named floor, not a
defect: on near water between captures whose *own* streaming counts differ, it
grows with that difference (0.004/255 mean at 30 frames, 0.009 at 90, 0.012 at
150). The harness comment that claimed the settle "rebuilds all temporal state
(… foam decay)" now says so.

## Tests

Each has its unpinned twin as the positive control, because a determinism test
that passes on the broken code is a test of nothing.

- **`tests/render.ocean-cascade-pin.test.ts`** (Node) drives the shipped clock
  through the harness's own frame sequence. Unpinned, it splits the six measured
  histories into exactly the two classes their pixels fell into, and a 2-frame
  history difference moves the every-4th cascade and no other. Pinned, every
  history on every cadence any tier runs gives one schedule. Source scans hold
  the pin to the renderer → ocean → clock chain under `src/`, to the perf harness
  alone outside it, and to its place after the time pin and before the settle.
- **`tests/gpu/ocean-cascade-pin.test.ts`** (GPU) builds the shipped ocean, runs
  two pre-pin histories two frames apart, and reads every cascade back texel by
  texel. Unpinned, only the every-4th cascade's displacement differs. Pinned,
  displacement, slope, jacobian and slope moments are bit-identical on all four
  cascades, and foam is bounded at its measured floor (8.98e-3, 5.38e-3, 2.40e-3
  and 0 per cascade, identical over repeated runs; the 128-512 m cascade carries
  no foam because swells that long do not break).

Verified to bite: with the pin stubbed out, the pinned GPU test fails on
exactly cascade 3's displacement; with foam's decay disabled, the carried foam
grows 5.8x — what a 2.8 s half-life over 6.6 s predicts — and the bound fails.

Three things went wrong on the way, recorded because each would have produced
a misleading green:

1. A "the pin keeps each cascade's cadence" test passed with the pin stubbed
   out. The pin precedes the window, so it would pass for any pin, including
   none. It was removed.
2. The GPU test first hung on its first readback. Compute submissions and
   readbacks resolve at frame boundaries; it needed the house pattern of an
   empty render loop (as `ocean-slope-mips` does), not `beginFrame`/`endFrame`
   bracketing, which left the readback's copy unsubmitted.
3. Batching thirty ocean updates per engine frame kept the wave field
   bit-identical but made **foam** differ between two runs of the same test
   (cascade 2 read 2.82e-2 then 5.74e-3). One ocean frame per engine frame, as
   the harness renders them, made it stable and showed the true floor is about
   seven times smaller than the batched runs suggested.

## Evidence: filtered re-captures, pinned and unpinned

Captured 2026-09-22 on this M2 Pro with `VITE_PERF_UNPINNED_HOST=1`, unpinned
tree `8d31fd2` against pinned tree `83641a9`. Every arm wrote a fresh
`report.json` inside its own run window (the stale-report trap was guarded).

### Same list, repeated — the fair test

Shot list `water-25ft,water-3m,water-400ft-glitter`, captured three times on
each tree. The list fixes everything that crosses between shots, so only the
wall-clock streaming varies — and it did: `water-25ft` streamed 1170, 1020 and
1110 frames unpinned, 1260, 1110 and 1110 pinned. The cockpit water shots always
streamed exactly 360 frames of their own, so they carry no foam floor. The sky
moved 0.0000-0.0013/255 in every pair (birds on the wildlife clock), confirming
the global state really was identical.

| pair | histories | water-3m sea | water-400ft-glitter sea |
| --- | --- | ---: | ---: |
| unpinned, cross-class | differ by 2 mod 4 | **0.393 mean, 51 % moved** | **0.118, 13 %** |
| unpinned, same-class | differ by 0 mod 4 | 0.0000 | 0.0000 |
| **pinned, cross-class histories** | differ by 2 mod 4 | **0.0000** | **0.0000** |
| pinned, same-class | differ by 0 mod 4 | 0.0000 | 0.0000 |

Pinned captures whose histories land in opposite classes are bit-identical on
the sea; the unpinned pair with the same kind of history difference moves half
of it. `water-25ft`, whose own count differed (1260 vs 1110), differs by 0.0116 —
the foam floor at 150 frames — against 0.0069 at 60 frames unpinned.

### Different lists — not what the pin is for, and worth knowing

The first round compared two *different* lists: the three water shots alone,
against the same three after `approach-500ft,high-10000ft-down,night`. There the
pinned captures differed about as much as the unpinned ones (`water-3m` 0.44 vs
0.50 mean), because the **sky moved too** — about 1.5/255, uniformly across the
frame. That is state carried between shots (the preceding scenes, `night` among
them), not the ocean, and no ocean pin could remove it. It is the known result
that a shot arrives with a different history under a different list:
[PERFORMANCE.md](../PERFORMANCE.md) requires FULL captures for ceilings for
that reason, and [WATER_COLOUR_2026_09_17.md](WATER_COLOUR_2026_09_17.md)
measured a filtered water shot 0.5-0.8/255 away from its full-run frame.

**So the pin makes any run of a given list — including every full run —
reproducible on the sea. It does not make a filtered run comparable to a full
one.** Water baselines must still come from full runs, as they always have; the
point of landing this before the end-of-wave re-baseline is that those full-run
baselines will now be one cascade class, run after run.

## Not addressed, and why

- **Other frame counters.** The frame graph can gate passes on
  `frameIndex % cadence` and `runsEvery(interval)`, and the cloud runtime policy
  keeps its own frame index. Nothing currently uses the frame-graph cadence, and
  the six full captures showed skies and terrain bit-identical across runs, so
  neither is flipping anything visible today. Same shape of defect, latent.
- **Foam.** Left as the named floor above. Removing it would need a foam reset
  or a longer settle, both larger than the defect they would fix.
