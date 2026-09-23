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
  for erosion, which spent **6.78 ms**. It booked 0.274 ms for the competitor, which spent **2.47 ms** (its short
  passes stretched beside the pit). That frame's compute came to **9.25 ms against the 1.73 ms cap**: 8.9 ms that
  nothing booked. It happens once per eroded page.
- **At its measured price it stalls.** Priced at 6.0 ms, the pit never fits the row or the cap. `ComputeBudget`'s floor
  of one guarantees one dispatch only to the highest-priority client with demand, and while the competitor has demand
  every frame, that client is the competitor. So erosion was admitted nothing for **881 of 900 frames** and the page
  never finished.

So **re-pricing alone is not a fix.** The true price turns a 9 ms spike into a stall whenever a higher-priority client
has continuous demand. The pit carve has to be split into dispatches that each fit the row, the way the seed and
geology stages already run as bands. Only then can its price be honest and admissible. The re-price of the erosion
stages is held until that lands, and the breach-frame test becomes its standing gate: booked close to spent, and the
page converging, at the measured prices. Until then the test records the behaviour above rather than asserting it.

Shipping impact: every eroded page puts one ~6 ms dispatch, plus whatever it slows beside it, into one frame. It is a
hitch source with no visual effect.

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
