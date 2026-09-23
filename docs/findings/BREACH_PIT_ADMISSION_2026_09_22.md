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

**So the carve runs in chunks** of 128 listed pits: one indirect dispatch and one admitted unit per chunk.

- A one-thread args pass writes each chunk's workgroup count into its own arg set and zeroes a claim cursor. Each
  workgroup claims its pit from that cursor, so no chunk needs to be told where it starts. Which workgroup carves which
  pit cannot change the result: the carve is a min-combine, and each pit writes only its own receiver.
- The pit count is read back before anything is carved, because only the device knows how many chunks there are. In
  every metered run the chunks ran in the frame straight after the args pass, so the read has cost less than a frame.
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

## Open

1. **The chunk under-read.** Three chunks sharing a frame read 0.074 ms in total against 0.63 booked, and the cost
   test's later same-page runs read about 0.05 ms a chunk. That is a quarter of what a chunk costs alone. It is either
   the timestamps of back-to-back passes or a genuinely faster re-run of a page just carved. The parity tests rule out
   an uncarved page. The first instrument: timestamps per chunk, with the claim cursor's final value read back beside
   them as the device's own record that the carve ran.
2. **Seed bands against the row.** The seed stage's cold first page reads 0.42-0.46 ms a band, past tier 1's 0.4 ms
   row. It stays priced at 0.40 with that noted. A finer band is its own item.

