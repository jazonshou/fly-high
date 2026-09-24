# The breach pit carve: a 6 ms dispatch the compute budget cannot admit (2026-09-22)

## What it is

Eroding a terrain page runs a directed graph of GPU passes (`TerrainPageErosionGpu`). One of them, the breach
stage's pit carve (`breachPit`), is a single dispatch over the whole 384² scratch. On the instrument that reads
each pass's own time (`DeferredPassTiming`, docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md) it costs
**5.7-6.3 ms** (three clean-room runs, medians 6.05, 5.67 and 5.97 ms). It has been priced at **0.067 ms**, a figure
taken on Babylon's own read, which reports the previous occupant of a query slot.

The frame budget cannot hold it at either price. At tier 1, the shipping tier, the `erosionCompute` row is 0.4 ms and
the compute cap for the whole frame is 1.73 ms. What happens depends on the price, and
`tests/gpu/erosion-breach-frame.test.ts` measures it frame by frame:

- **At the shipped price it spikes.** The page is admitted through the live `ComputeBudget` beside a competing
  client at occlusion priority, two dispatches every frame, priced at their own measured 0.137 ms. Estimates stay
  frozen at the seeds, as in shipping. The page converges in 47 frames. In the pit's frame the budget booked 0.067 ms
  for erosion, which spent **6.78 ms** (the pit's own spend varies between runs: 3.43 ms in a later run of the same test,
  that one beside a CPU-heavy Node job, so the spike is 3.4-6.8 ms on this page). It booked 0.274 ms for the competitor, which spent **2.47 ms** (its short
  passes stretched beside the pit). That frame's compute came to **9.25 ms against the 1.73 ms cap**: 8.9 ms that
  nothing booked. It happens once per eroded page.
- **At its measured price it stalls.** Priced at 6.0 ms, the pit never fits the row or the cap. `ComputeBudget`'s floor
  of one guarantees one dispatch only to the highest-priority client with demand, and while the competitor has demand
  every frame, that client is the competitor. So erosion was admitted nothing for **881 of 900 frames** and the page
  never finished.

So **re-pricing alone is not a fix.** The true price turns a 9 ms spike into a stall whenever a higher-priority client
has continuous demand. The pit carve has to be split into dispatches that each fit the row, the way the seed and
geology stages already run as bands. Only then can its price be honest and admissible. That is what was done (below),
and the re-price landed with it.

Scope: only ERODED worlds. The game defaults to the analytic world (`DEFAULT_WORLD_EVOLUTION = "analytic"`), and
`FlightGame` builds an eroded one only when the URL asks for it; the erosion producer, and the pit carve with it, never
runs in the default game, and no current capture shot uses the eroded world. In an eroded world, every eroded page puts
one pit-carve dispatch, plus whatever it slows beside it, into one frame: a hitch source with no visual effect. What
reaches the default game is the analytic clients' seeds (terrain page generation, the splat and occlusion bakes, ground
cover), which were also measured on the old instrument and are the half of the re-price still to be measured clean.

## The clean-room slot that measured it

Tree `3b1d011` (priced code identical to `de91cef`), 22:38-22:44. Every run was preceded by 22-24 s with no GPU work a
detector could see (other tests, capture rigs, a browser on the game's dev server, Firefox's GPU helper), re-checked
every 2 s; the gap was passed to the test, which refuses to price without one. One load was present in every run:
Apple's `spotlightknowledged` at 92-100 % CPU.

- **The erosion stages agree** within 1-7 % across the three runs, and with every earlier batch, with or without the
  daemon: seed 0.40 ms per band, geology 0.011, breachDirect 0.11, breachPit 6.0, decode 0.021, streamPower 0.041,
  talus 0.39, fineBand 0.043. The pump keeps its own GPU busy.
- **The dispatch-sparse figures were inflated two to three times beside the daemon:** the page generator 3.34-3.70 ms
  per page (2.02-2.03 in an idle-gap run without it), the occlusion bake 0.40-0.52 (0.17). They are reported, not
  priced, until a morning with no daemon named. An earlier A/B had already shown that a steady load beside a short pass
  inflates it (occlusion ~0.27 beside a synthetic 2 ms/frame load) rather than representing a busy frame.
- **The coarse splat bake settles.** With identical dispatch dimensions (17 x 17 x 4) and levels (L5), its time climbs
  within each run over the fifteen samples, from 0.21-0.38 ms towards a plateau of 0.66-0.68 ms. One run had
  reached only 0.31 ms by its last sample. So something the bake reads is
  still changing in the seconds after its height pages are generated. The early samples bake unsettled inputs; they
  are not a cheaper unit of work. Its price has to be measured on the plateau, after a stated settling precondition, as
  the tape consumers' control waits for residency. The fine splat bake (L3) read 0.597-0.614 ms over all 45 samples (median 0.604). Both stay
  unpriced until the earlier fine-bake lows are explained.
- **Ground cover** measured on its own tape (per dispatch, not the meter's average) still disagreed across runs
  (0.08-0.15 ms). Its seed stays.

## The fix: one workgroup per pit, a chunk of pits per dispatch

> **Reverted 2026-09-23 (b677dc6 reverts b982543).** In its indirect form this carve handed MFD a wrong surface on
> most pages of some runs, with no error raised: see "The indirect carve on re-runs" below. What follows describes
> the design and the measurements as merged. The version that returns dispatches each chunk directly and is gated
> on re-runs.

**Why the pass was slow.** The serial carve gave each pit one thread searching its 33² window alone, so the pass lasted
as long as its slowest pit: one 8-row band holding a pit cost 89 % of the whole pass. It was latency-bound, not
throughput-bound.

**The parallel carve.** The direct pass now also lists every pit, appending it to a list with an atomic count. Each
listed pit gets one workgroup. Its 64 lanes stride the window, and a shared-memory tree reduction picks the target under
the serial search's own total order: lower score, then lower target index. The score and path expressions are the serial
pass's, character for character. The serial pass is kept (`breachPitSerialWgsl`) as the control. On the device the
parallel carve is bit-identical to it: 0 height and 0 receiver differences on pages of 372, 794 and 1070 pits
(`tests/gpu/breach-pit-parallel-identity.test.ts`). A CPU twin of the lanes and reduction is held against
`breachLocalPits` on the 16 survey pages, and on a surface built to tie across lanes.

**One pass was still too long on dense pages.** Timed cold, as the first pass on a fresh page, over three runs, the
single parallel pass took:

| Pits on the page | One pass, cold |
|---|---|
| 372 | 0.34-0.37 ms |
| 794 | 0.68-0.72 ms |
| 1070 | 0.88-0.89 ms |

The cost is linear, about 0.9 µs a pit, once the GPU is full, and it is past tier 1's 0.4 ms row on the dense pages.

**So the carve runs in chunks** of 128 listed pits: one dispatch and one admitted unit per chunk. (The first form
dispatched each chunk INDIRECTLY from its own arg set. It now dispatches at the CPU-known size, because the count is on
the CPU anyway. INDIRECT usage was refuted as the defect's cause below, and the direct form is what the evidence
covers.)

- A one-thread args pass writes each chunk's workgroup count into its own arg set and zeroes a claim cursor. Each
  workgroup claims its pit from that cursor, so no chunk needs to be told where it starts. Which workgroup carves which
  pit cannot change the result: the carve is a min-combine, and each pit writes only its own receiver.
- The pit count is read back before anything is carved, because only the device knows how many chunks there are. It
  is mapped at the end of its frame, never through a mid-frame flush (the defect below): the chunks start two or three
  frames after the args pass (the breach frame gate reads 3-4 frames awaiting the count).
- A page with more pits than the list holds (4096; the survey's worst was 712) fails at that read, before any carving,
  and is counted (`pitListOverflows`).
- A count that reads back as zeros is recognised, because the args pass always writes chunk 0's y as 1. It is re-read
  once; if it faults again the page fails. A faulted read is never taken for a page without pits.

**Chunk cost.** Cold full chunks on the three pages, three runs, one chunk per frame: median **0.202 ms** of 48
(0.185-0.224), the same on every page. The worst cold chunk sits under 0.25 ms, 40 % under the row, because the price is
spent under load.

**What chunking costs.** A partial chunk of 26-116 pits still takes 0.16-0.21 ms: that is the slowest pit's own latency,
and a page pays it once per chunk. So chunking roughly doubles the carve's total GPU time (the 1070-pit page: about
1.8 ms over 9 chunks, against 0.89 ms in one pass). That is the accepted cost of admitting the carve in units small
enough for any one frame to hold.

**Prices, 23:47-23:51, cold.**

- breachDirect: 0.099 ms (0.098 in all three runs).
- breachArgs: 0.013 ms.
- Carve chunk: 0.21 ms.
- The stages the fix left alone keep the 22:38 figures. This slot's cold figures agree with them within 10 %, except
  seed, whose cold first page reads 0.42-0.46 ms against 0.40. That would put it past the tier-1 row, which no stage
  may be, so it is recorded here, not priced.
- The erosion client's seed moves from 0.24 to 0.28 ms: the table's weighted dispatch is 46.4 ms over 166 dispatches.

## The standing gate

`tests/gpu/erosion-breach-frame.test.ts` now asserts what it used to record. It runs the 372-pit page and the 1070-pit
page through the live meter at tier 1, at the table's prices, beside the competitor (two dispatches a frame at
occlusion priority). It asserts:

- the page converges;
- the competitor is admitted every frame;
- no frame refuses erosion while it has demand;
- the breach runs exactly one direct pass, one args pass and one chunk per 128 pits;
- no breach frame spends more than 1.5 times what it was booked at, plus a 0.08 ms pass floor.

Over-booking is recorded, not asserted (open item 1 below).

The three runs on 2026-09-22, at 23:53, 23:54 and 23:54, before the check was made one-sided. A full Node suite from
another worktree ran under the first two. Figures are booked / spent in ms:

| Run | L3 direct | L3 args | L3 three chunks | L5 direct | L5 args | L5 chunks |
|---|---|---|---|---|---|---|
| 1 | 0.099 / 0.098 | 0.013 / 0.012 | 0.630 / 0.074 | not printed | not printed | not printed |
| 2 | 0.099 / 0.097 | 0.013 / 0.010 | 0.630 / 0.567 | 0.099 / 0.099 | 0.013 / 0.013 | six: 1.260 / 1.190; three: 0.630 / 0.548 |
| 3 | 0.099 / 0.161 | 0.013 / 0.075 | 0.630 / 0.585 | not printed | not printed | not printed |

- Every page converged in 47-48 frames, with no frame refusing erosion with demand and the competitor admitted every
  frame.
- The busiest frame, six chunks admitted through the surplus pass, used 1.46 ms of compute against the 1.73 ms cap.
- The old two-sided check failed runs 1 and 3: the args pass's 0.075 ms (its floor), and the 0.074 ms under-read.
- Every printed frame passes the one-sided check.
- The L5 page of runs 1 and 3 was not printed, because the test asserted page by page; it now logs both pages first.

## The indirect carve on re-runs: wrong surfaces, no error (2026-09-23)

**How it was found.** Open item 1 below (three chunks sharing a frame reading 0.074 ms against 0.63 booked) was
chased with a probe that runs the same page's whole DAG again and again. It pumps 4 dispatches a frame, as the cost
test does, and captures the breached surface the producer hands MFD. On L3 -3,5 a correct surface lowers 3805 cells.
Every run and gate before this one checked each page once:
- the identity gate;
- the determinism and CPU-oracle parity tests, which pump 64 or 3 dispatches a frame.

**Runs** (all timed; 22 s idle gaps):

| Run | Tree | Pages wrong |
|---|---|---|
| first same-address probe | merged (indirect) | 2 of 5 (cursor 0 after the page) |
| 8 pages | merged | 0 of 8 |
| 30 pages | merged | 28 of 30 |
| 30 pages | merged | 0 of 30 (the control, later the same night) |
| 30 pages | pre-merge 58f8b28 (serial carve) | 0 of 30 |
| 30 pages | merged, a fence before every DAG readback | 17 of 30 |
| interleaved window, 30 pages each | merged ×3 / pre-merge ×3 | 0, 27, 30 of 30 / 0, 0, 0 of 30 |

Whole runs flip, including their first page. They don't fail page by page. Interleaved in one window, the pre-merge
tree carved 90 of 90 pages while the merged tree failed 57 of 90. The defect is the indirect chunked carve's.

**What the wrong pages show** (instrumented runs: a per-pass dispatch log, a snapshot before the chunks with the
producer idle, the encoder each pass and copy was recorded into, and validation and internal error scopes around
each page):
- **Same commands, different results.** A clean run and a broken run recorded the same passes, copies and flushes
  in the same encoders, in the same order. Cold pipelines deferred the same passes in both.
- **Chunks that ran nothing** (a broken run's first page). A fenced read just before the chunks showed the direct
  and args passes' effects:
  - heightB was heightA's exact encoding;
  - the count head read [128, 1, 1, 372];
  - the cursor read 0.

  The three chunks were then dispatched from that buffer. They read 0.015, 0.000 and 0.000 ms, the cursor stayed at
  0, and the surface lowered 1006 cells.
- **Passes whose effects never showed** (the later pages).
  - The first count read, recorded in the same encoder right after the args pass, came back with chunk 0's y ≠ 1.
    The zero-read guard re-read it, and the next submit's copy returned the full count.
  - heightB was not heightA's encoding at any of 147,456 cells.
  - The cursor was never zeroed, so it grew by 372 each page.
  - The surface decoded as nearly every cell lowered, which is what the undecoded macro staging would give.
- **Nothing reported it.** Neither error scope caught anything, there were no uncaptured errors and no console
  messages.

**Excluded, by code and by these logs:**
- No pass is dropped. Every `false` from `dispatch()` is retried (`dispatchWhenReady`, or a poll for the indirect
  form) and awaited before anything that follows it in program order.
- The fences didn't cure it.
- Bind groups are per shader, and buffers are released only on dispose.
- The probe attaches to the right job.

**A hypothesis, since refuted.** The chunked carve's one new resource is the count buffer. Compute passes write it
as STORAGE, then it is read as INDIRECT (the chunks) and as COPY_SRC (the count read), so INDIRECT usage was the first
suspect. A version with no INDIRECT usage anywhere (each chunk dispatched directly at its CPU-known size) FAILED the
same way in an interleaved window (01:24-01:29):

| Tree | Pages correct per run, 30 pages each |
|---|---|
| direct-dispatch fix | 4, 11, 13 |
| indirect, the positive control | 0, 2 |
| pre-merge | 30, 30, 30 |

The fix's wrong pages are the same mode: the cursor grows by the listed count per page, heightB is never re-encoded,
and the count is sometimes stale. So the mechanism is elsewhere in what the chunked breach adds over the serial one:
the pit list and count in the direct pass, the args pass, the claim cursor, and above all the count readback in the
middle of the breach, a no-delay read with a mid-frame flush between the args pass and the chunks. The serial breach
reads nothing until after its carve. Every reproducing run was timed; whether an untimed run reproduces is not yet
known.

**A window that proved nothing (01:36-01:39).** On the chunked tree, 30 pages per run:

| Arm | Runs | Pages correct |
|---|---|---|
| timed, the positive control | 1 | 30 of 30 |
| untimed, first device on its page | 2 | 30 of 30 each |
| timed, with the count read moved to the end-of-frame path (no mid-frame flush) | 2 | 30 of 30 each |

Nothing was reported in any error scope, as an uncaptured error or on the console. The control did not fail, so the
untimed and end-of-frame arms prove nothing about the timing path or the flush.

Across the night, chunked runs are all-or-mostly wrong or all right, never a few pages. Nothing varied so far
separates the groups: the instrument (gate, probes), the carve's dispatch form (indirect or direct) and the CPU load
all appear on both sides. The pre-merge tree was 180 of 180 across four windows. The next step is flip rates per arm
from a large unattended interleaved sample, not more five-run windows that can land wholly on a clean streak.

The re-run gate's positive control, run as the first device in its own file, flagged exactly the page whose second
chunk was skipped: 2643 cells lowered, cursor 244 of 372. The reference page was clean, so the check is not vacuous.

**The flip rate, and what it depends on (unattended sample, 2026-09-23 12:00-12:54).** Eighty runs of 30 pages,
twenty per arm, the arm order rotated each round, each run after 22 s of GPU idle. Jason's Firefox was exempted from
the idle check and its GPU-helper CPU recorded instead; it was above 3 % in two runs, both clean. A run is broken if
any page is wrong:

| Arm | Broken runs | Pages wrong in a broken run |
|---|---|---|
| chunked, indirect, timed | 8 of 20 | 29-30 |
| chunked, direct dispatch, timed | 13 of 20 | 24-29 |
| chunked, direct dispatch, untimed | **0 of 20** | none |
| serial (pre-merge), timed | 0 of 20 | none |

The same carve is broken in 13 of 20 runs timed and 0 of 20 untimed (Fisher p ≈ 1e-5). The serial carve timed is
0 of 20. So the defect needs both GPU timing and the chunked breach. INDIRECT again makes no difference (8 against 13
of 20, p ≈ 0.2). There were no errors in any scope and no uncaptured errors in any of the runs.

The per-run facts differ between runs in one thing only: whether the device has `timestamp-query`, which is the arm
itself. Adapter, limits and browser are identical in all of them. The "whole runs flip" of the earlier windows reads as
streaks of a per-run rate of 40-65 %, not as a hidden per-run state.

**What the chunked breach adds on the timed path, as counts per page.** These are derived from the code, at the
cadence of four dispatches a frame the gate and probes pump at:

| | Serial carve (pre-merge) | Chunked carve |
|---|---|---|
| Timed passes in the breach | 2 (direct, carve) | 2 + one per 128 pits: 5 on L3 (372 pits), 9 on L4 (794) |
| Timed passes on the whole page | 109 | 112 on L3, 116 on L4 |
| No-delay reads, each a mid-frame flush | 5 | 6, and 7 when the count read faults |

A page's 109 serial-carve passes: 12 seed dispatches, 4 geology, 2 breach, 1 decode, 24 stream-power, 64 talus and 2
fine-band. Its 5 reads are the 4 scratch reads and the final surface.

So the whole page gains only 3 to 7 timed passes, a few per cent. The structural change is where the one extra flush
sits. The count read flushes BETWEEN the breach's own timed passes: after the direct and args passes, before the chunks.
In the serial breach every flush comes after the breach's passes.

**Whether shipping was affected stays a hypothesis, and after the fix it no longer matters for the carve.** No path
flushes the count read now. The game-path run below was never made (out of scope for the 2026-09-24 PR). The shipping
game runs with timing off, and 0 of 20 untimed runs broke, but those were probe runs. The run that would settle it is the game path itself:
- the eroded world (`?world=eroded`), untimed, flown along a scripted route that generates pages from L0 to L5
  (a few hundred per flight);
- a hook reading back each published page's height slot as a hash per address;
- about ten launches per tree, the chunked tree against the pre-merge tree.

The pre-merge serial carve and the chunked carve are bit-identical per page (the identity gate), so every address must
hash the same under both trees. Its positive control is the same flight with timing on, which has to show mismatches.

Every price, cost gate and capture runs with timing on, so the chunked carve stays out until the interaction is
found. The candidates are the chunked breach's additions meeting the timing path:
- per-pass `timestampWrites` on every compute pass;
- the deferred timing's per-frame resolve and readback submit;
- the breach's two no-delay readbacks, with their mid-frame flushes.

The next sample isolates each at twenty runs per arm, all on the direct tree:

| Arm | Change | If it comes out clean |
|---|---|---|
| B | none: timed, the control | (must break) |
| E | the count read moved to the end-of-frame path, so no mid-frame flush between the breach's passes | the flush is the mechanism |
| F | timing on, the deferred timing not installed, Babylon's own per-pass read instead | the deferred resolve is |
| G | timing on, the carve's own passes carrying no timestamp writes | the carve's timestamp writes are |

For arm G it is not enough to drop the carve's counter: Babylon's compute pass descriptor is shared, so the carve
would reuse the previous pass's slots. The probe also clears the descriptor before each carve dispatch.

**What the defect depends on (sample 2, 2026-09-23 20:32-21:15).** Four arms, twenty runs each, 30 pages a run, the
arm order rotated each round. All four ran on one tree: b2748f3 with the chunked carve re-applied on direct dispatch
(`jazonshou/breach-sample2`). The guard required 10 s of idle GPU before each run; the gap was shorter than sample
1's 22 s so that eighty runs fit the hour. The host could not be made fully quiet: Jason's Firefox and his dev server
stayed up. So each run records the host load before and after it, from the same reader the timing control uses
(`scripts/gpuHostLoad.ts`): the GPU's utilisation, Firefox's GPU helper and the load average. None of the 80 runs was
busy by that reader's thresholds. The one-minute load's median was 3.2-3.9 on 10 cores, and Firefox's helper rose above
3 % in a single run, a G run that broke. So the arms saw the same quiet host, interleaved.

| Arm | Change | Broken runs | Host load |
|---|---|---|---|
| B | none: timed, the control | 13/20 | GPU peak median 3 %, max 16 % |
| E | the pit-count read mapped at the end of the frame, no mid-frame flush | 0/20 | GPU peak median 2 %, max 7 % |
| F | timing on, `DeferredPassTiming` not installed (Babylon's own per-pass read) | 0/20 | GPU peak median 3 %, max 7 % |
| G | timing on, the carve's own passes carrying no timestamp writes | 12/20 | GPU peak median 3 %, max 12 % |

Decision rule, set before the counts: an arm is clean at 0 of 20 and broken at 6 or more.

Every broken run has sample 1's signature. The first page of the run is right, then the claim cursor is never
re-zeroed: it reads 372, 744, 1116 and so on across pages of the same address. The count read passes its guard
(chunk 0's y is 1, and the pit count equals the previous page's, because the address is the same), and the carve
then claims list slots past the list. Page 1 onward lowers 146 456 cells where the right answer is 3 805.

What it says:
- **G broken:** the carve's own timestamp writes are not the mechanism. With the carve's passes unstamped (and the
  shared pass descriptor cleared before each carve dispatch), the defect is unchanged.
- **E clean:** the mid-frame flush of the pit-count read is the mechanism. `StorageBuffer.read(..., noDelay: true)`
  calls `flushFramebuffer()` inside the frame. That submits the frame's upload and render encoders, creates new
  ones, and calls `_timestampQuery.startFrame()` on the new upload encoder, so the timing path sees a second frame
  start inside one frame. With `noDelay: false` the copy stays in the frame's encoder and is mapped at
  `onEndFrameObservable`, after the frame's own submit.
- **F clean:** the defect also needs `DeferredPassTiming`, the one per-frame resolve submitted at the end of the
  frame. With Babylon's own per-pass read, each timed pass submits its own resolve during the frame, and the defect
  does not appear.
- **Why the flush and the deferred resolve together lose the page's direct and args passes stays open.** The sample
  shows which elements are needed, not how they combine.

**Why F is not a fix.** Removing `DeferredPassTiming` brings back Babylon's per-pass read. That read resolves a pass's
slots before the pass runs, so every timed pass reports the previous occupant of its slot
(`docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md`). It also costs an out-of-band submit and a readback per
timed pass, which stretched the reference host's frame to 13.1 ms at 88 timed passes. Every price, cost gate and
capture relies on the deferred read.

**The fix is arm E's code.** The pit-count read is mapped at the end of the frame instead of through a mid-frame flush.
The cost is at most one more frame before a page learns its chunk count: the copy is submitted with the frame, and
the map resolves after that frame's submit. The read always resolves:
- the game pumps the producer from the render loop (compute-budget admission, `TerrainPageAtlas.pumpErosionDag`);
- every GPU test that drives the carve does so inside `withScene`, which runs `engine.runRenderLoop`.

The MFD readback keeps `noDelay: true`, unchanged: arm E left it in place and came out clean.

**The fixed tree (`jazonshou/breach-carve-endframe`, 2026-09-23 21:20-21:27)**, one vitest run at a time, host load
read before each run:
- **Identity:** L3, L4 and L5 are bit-identical to the serial pass: 372, 794 and 1070 pits claimed, 0 height and 0
  receiver differences.
- **The re-run gate:** 3 of 3 runs pass. On all 30 pages of each, the cursor ends at the listed count and the surface is
  identical to the address's first run.
- **The control:** it catches the planted skipped chunk (cursor 244 of 372, 1147 cells differ), and its reference run
  stays clean.
- **The cost test:** three pricing runs (22 s idle GPU before each; the CPU was loaded, 10.7-12.2 on 10 cores from
  macOS's media analysis, with the GPU idle) and one check. All pass: 4 of 4 pages under twice the pinned 46.43 ms,
  pages 36.7-47.2 ms.
  - Cold medians (page 1) against the table: seed 0.406 (0.40), geology 0.0106 (0.011), breachDirect 0.099 (0.099),
    breachArgs 0.015 (0.013), carve chunk 0.186 (0.21), decode 0.020, stream power 0.040, talus 0.382, fine band
    0.042.
  - The table stands. 0.21 is the full-chunk price; L3's 372 pits end in a 116-pit chunk.
  - The warm re-run pages now read 0.139-0.190 ms a chunk, where the broken tree's read about 0.05: open item 1's
    under-read is gone with the defect.
- **The breach frame gate:** 2 of 3 runs pass, and one fails on L3's one-thread args pass (booked 0.013 ms, read 0.164,
  against 1.5 x booked + 0.08 = 0.0995). See open item 5.

**A separate harness artefact, found on the way.** Babylon's `ComputePassDescriptor` is one module-level object shared
by every engine on a page. Its `timestampWrites` is rewritten only for shaders that carry a GPU timer. So an untimed
engine created after a timed one begins its compute passes with the disposed engine's query set. Its first page then
dies at the count guard ("read back as zeros twice"), which happened 4 of 4 times on such a second device. It is why
the re-run gate's positive control lives in a file of its own. It says nothing about production, which makes one
engine.

**Open item 1 was this defect.** The low readings (0.074 ms for three chunks; the cost test's ~0.05 per chunk on its
repeated pages) were pages whose chunks didn't do their work.

**Decision.** b982543 was reverted on House-Keeping (b677dc6), and the re-price and the standing gate went with it.
The chunked carve returns on `jazonshou/breach-carve-endframe`: direct dispatch, with the pit count read at the end of
its frame (arm E's exact code). Sample 2 is its evidence: twenty runs interleaved with a known-bad arm that broke 13
times in the same window.

The gate for any returning version is `tests/gpu/breach-carve-reruns.test.ts`. It runs thirty pages, and on every page:
- the page converges;
- the cursor ends at exactly the listed count;
- the surface MFD receives is bit-identical to the address's first carved run.

Its positive control, `breach-carve-reruns-control.test.ts`, must catch a page whose carve skipped a chunk. The
gate's evidence is several runs in one window, interleaved with the pre-merge tree, where the known-bad tree fails in
that same window.

## Open

1. **The chunk under-read.** RESOLVED as the defect above. Three chunks sharing a frame read 0.074 ms in total against 0.63 booked, and the cost
   test's later same-page runs read about 0.05 ms a chunk. That is a quarter of what a chunk costs alone. It is either
   the timestamps of back-to-back passes or a genuinely faster re-run of a page just carved. The parity tests rule out
   an uncarved page. The first instrument: timestamps per chunk, with the claim cursor's final value read back beside
   them as the device's own record that the carve ran.
2. **The chunked carve's trigger.** RESOLVED by sample 2: the pit-count read's mid-frame flush with the deferred per-pass
   timing installed. The count is now mapped at the end of its frame. What the item said before sample 2 follows. Narrowed by the sample: it needs GPU timing and the chunked breach together
   (13 of 20 runs broken timed, 0 of 20 untimed, 0 of 20 for the serial carve timed). The earlier plan follows. The next step is flip rates per arm from a large unattended interleaved sample (about 20 runs per arm)
   in a quiet window. Each run records:
   - the tree, timing on or off, and wall time;
   - a fresh or reused Chromium profile, and the GPU process's adapter, features and limits (the gate now logs
     these once per run);
   - the daemons running.
   The candidates not yet excluded are what persists across a browser launch but not across a tree or probe change
   (the Metal and Dawn shader caches, the Playwright profile), and what the GPU process decides once per launch
   (requested limits and features, Dawn toggles).
3. **Seed bands against the row.** The seed stage's cold first page reads 0.42-0.46 ms a band, past tier 1's 0.4 ms
   row. It stays priced at 0.40 with that noted. A finer band is its own item.
4. **Why the flush and the deferred resolve together lose a page's passes.** Sample 2 shows both are needed and that
   the carve's own timestamps are not. The flush submits the frame part-way through and starts the timestamp query's
   frame a second time; the deferred resolve covers the whole frame's slots once, at its end. How that loses a direct
   and an args pass (the cursor is never re-zeroed) is not shown.
5. **The breach frame gate on the fixed tree: the args pass's readings.** One run of three failed on L3's one-thread
   args pass, which read 0.164 ms against 0.013 booked. That frame's readings equal the previous frame's EXACTLY
   (erosion 0.164, competitor 0.338, frame 0.502 in both), which looks like a stale timing read rather than a real
   overspend. Babylon hands out timestamp slots by pass order within a frame and resets them at `endFrame`, so a
   resolve over unwritten slots returns the previous frame's values. The args pass also reads higher on the fixed tree
   than before the fix: 0.016-0.164 ms over six readings, against 0.010-0.075 over four. Next: a probe that logs every
   frame's per-pass readings and counts exact duplicate frames, on the fixed and the pre-fix trees.
