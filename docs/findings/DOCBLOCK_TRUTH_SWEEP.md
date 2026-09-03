# Docblock truth sweep — `src/render/webgpu/`

*Counts taken against `jazonshou/Phase-6-Implementation` at `1a4c1ac`. Naming
the ref matters: resolving "the tip" by commit date returns whichever side
branch committed last, which is how this sweep was first run against a branch
that happened to be docs-only.*

**Report, not edits.** Every claim below is classified SUPPORTED / WITHDRAWN /
UNVERIFIABLE against the tree and the commit that wrote it.

## Why this exists

One session produced **five stale plan premises and two stale retractions**. The
retractions were the expensive ones:

- `AirfieldLighting.ts`'s header asserted *"THE DEPTH TEST REJECTS THEM, and
  that is measured"*. It was withdrawn by `5621131` — the pixel movement behind
  it was the tree line, and the whole defect was one calibration constant. **The
  withdrawal never reached the file, and four commits touched it afterwards.** A
  session designed obstruction-light mounting offsets to defeat a depth test
  that did not exist.
- `7-8`'s own spec said *"the lamps and the cockpit interior already exist as
  emissive geometry"*. **Four of six did not exist**, including the tail light a
  three-way angular partition was pinned against.

**A retraction that has gone stale in place is worse than none: it reads as
current and carries the authority of having been measured.**

## Method

`scripts/docblock-truth-sweep.mts`. Not a list of suspects — a **ranking**,
because checking 194 claims by hand is not the job and finding the rotted ones
is.

**The risk signal is churn since the claim was written.** A claim made in the
same commit as the code it describes is probably still true. A claim that has
survived twenty commits to its own file has had twenty chances to stop being
true and nothing re-checks it. The script blames each comment-borne claim, finds
its commit, and counts commits to that file since.

## Corpus

| | |
|---|---|
| comment-borne claims (`measured` / `MEASURED` / `verified` / `VERIFIED`) | **194** |
| files carrying at least one | **54** of 138 |
| claims whose blame commit is **not in the file's history** | **0** |
| claims whose evidence was a **capture** rather than something readable | **27** |

**RETRACTED: I first reported 50 unverifiable claims — "a quarter of the
corpus". That number was my own tool measuring my checkout, and it was wrong
twice over.**

`git log -- <file>` walks from HEAD, and this worktree's HEAD sits on an old
commit because files arrive via `git checkout <ref> -- paths` without HEAD
moving — so every claim written since read as unreachable. And `git blame`
against the working tree reports staged lines with an all-zero sha, which the
script counted the same way. **Reading both from the branch ref instead gives
0.** Every claim's commit is present and readable.

**The sweep whose thesis is that instruments measure the wrong thing was
measuring the wrong thing.** The tell was in the output and I nearly missed it:
all thirteen "undefended" claims were dated the same day. A category that
correlates perfectly with *today* is a property of the observer.

**The real prioritisation is evidence class, not reachability.** 27 claims rest
on a capture. A claim you can check by reading two constants gets incidentally
re-verified whenever someone works nearby; **a capture-established claim has no
such traffic and rots undisturbed** — which is how the depth-test phantom
survived four commits. And `normalW` proves nothing here can defend them:
1,654 green tests on a tree that rendered nothing, because NullEngine compiles
no shaders.

## Findings

### WITHDRAWN — an arithmetically impossible measurement

**`detail/WorldDetailRuntime.ts:495`**

> *"measured mean crown radius 3.40 m, median 3.15 m, **p90 1.78 m**"*

**A 90th percentile cannot be below the median.** No distribution has
`p90 < p50`. The three numbers cannot all describe one sample, so this is not a
question of whether the measurement has aged — it was never self-consistent.

**The likely correct label is `p10`, not `p90`**, and the generator supports it:
`treeDimensions` draws `individualAge` through `Math.pow(random(), 2.15)`, which
concentrates mass at low ages, so the stand is sapling-heavy exactly as the
paragraph argues. A p10 of 1.78 m fits that; a p90 of 1.78 m contradicts both
the median and the mean above it.

**Why it matters rather than being a typo:** the paragraph's argument is *"mostly
saplings, as a real stand is"*, and this figure is the evidence offered for it.
The conclusion is almost certainly right and the stated evidence cannot be.
**Flagged rather than corrected — I could not measure it without exporting a
module-private function, and this pass is report-only.**

### SUPPORTED — checked, and worth recording as checked

**`detail/WorldDetailRuntime.ts:3155` and `:3500`** — *"past the 16-input limit
(measured 17: nine CSM lanes + tint + A/B/C + a wasted fade lane)"*. Matches
`tests/gpu/interStageBudget.ts` exactly: the device's own refusal reads
`17 = 16 (user-defined) + 1 (front_facing)) exceeds the maximum (16)`, and
`INTER_STAGE_LIMIT = 16`. **17 exceeds, 16 does not.**

**`core/PerformanceBudget.ts:336`** — *"7 species × 2 season buckets × 2 arrays
of 256² rgba8 with full mip chains — measured from the CPU bake"*,
`impostorAtlasMiB: 9.33`. Confirmed two independent ways: the arithmetic
(28 × 256² × 4 B × 4/3 = 9.33 MiB), and a direct measurement of the packed
atlas taken earlier in this session — albedo and normalDepth at 4,893,336 B
each, `layerCount = 14`, which is 7 × 2.

### UNVERIFIABLE — and this is the largest category

**`detail/WorldDetailRuntime.ts:1778`** — *"the capture measured it as a
saturated hitch train"*. The claim is about a capture of a code path that no
longer exists; there is no artifact to re-read. Not wrong — **uncheckable**,
which is a different thing and should be recorded as such rather than trusted or
deleted.

**And the 27 capture-established claims are the same category at scale** — not
because their commits are missing, but because re-reading the commit tells you
what was *claimed*, and only a capture tells you whether it is still *true*.")

### CLEAN — the known-stale phrase is now handled

Both remaining instances of *"and that is measured"* are correct:
`AirfieldLighting.ts:35` is struck through with `~~`, preserving that it was
once believed; `ObstructionLighting.ts:25` quotes it as history and names the
commit that withdrew it. **Striking through rather than deleting is the right
pattern** — deleting would hide that the question was ever asked, which is the
failure that produced the phantom in the first place.

## Recommendation

**The problem is not that claims are wrong; it is that nothing re-reads them.**
Two mechanisms would close most of it:

1. **A claim that cites a checkable artifact should cite it by path**, the way
   the two SUPPORTED findings above could be checked in minutes and the
   UNVERIFIABLE one could not. The difference between them is not rigour at the
   time of writing — it is whether the evidence is CHEAP TO RE-READ. That is
   the corrected version of what I first attributed to evidence "surviving".
2. **Strike through, never delete.** Already demonstrated in
   `AirfieldLighting.ts`. A withdrawn claim left visible costs three lines and
   prevents a session rebuilding against it.

**Ranking, not exhaustive checking, is the sustainable form of this.** The
script is committed so the next pass starts from the same ordering and can walk
further down it.
