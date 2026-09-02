# Instruments that answered instead of failing — 2026-09-01

**What this is.** One evening on **fly high**, a browser flight simulator built
on a Babylon.js WebGPU renderer — six Claude sessions working in one repository.
The recurring defect was not in the renderer. It was in the things we measure the
renderer with, and it had one shape:

> **A check ran, produced a confident tidy answer, and the answer was about a
> different question than the one asked. No error was raised.**

**The three unrelated areas, named because "unrelated" is what makes this a
pattern rather than one bad subsystem:** the **cascaded shadow renderer**
(`AtmosphereSystem`, Babylon's CSM), **GPU memory accounting**
(`FlightRenderer`'s inventory and `PerformanceBudget`'s estimate), and the
**test and capture harness** (`tests/`, `perf-capture.test.ts`). They share no
code, no owner, and no data. The same defect shape appeared in all three on the
same evening.

Every instance below was found while looking for something else, and every one
was a number somebody was about to build on.

**Scope, because the count changed while this was written.** The file was started
to consolidate five instances that were scattered across five commit messages and
would otherwise have stayed there. It now carries **seven instrument failures
(§1)**, **two claims that were never true at any commit (§3)**, **a category that
is no instrument at all (§3b)**, and **one measurement that had to be repaired
(§5b)**. It is not a complete audit — nobody swept for these — it is what one
evening's work surfaced while doing something else.

**Provenance note.** Every SHA, count and code claim here was re-derived from the
tree while writing, not transcribed from the conversations they came from. Where
a number came from a measurement someone else ran, it is attributed. Where I
could not verify something, it says so.

---

## 1. The family, with its instances

A guard is supposed to fail when the thing it protects breaks. Each of these
**passed** instead, and passed in a way indistinguishable from health.

### 1.1 Six architectural guards passing on an empty scan

`tests/architecture.boundaries.test.ts` derived `sourceFiles` from a directory
walk and asserted **inside the loop**. Nothing asserted the walk found anything.
Measured by emptying it: **2 failed, 6 passed** — including the ban on raw
`new ShadowDepthWrapper`, the owned-symbol rule, page-identity containment, and
the tier-branching confinement.

A renamed `src/`, a changed root, or a narrowed extension filter each return
`[]`, and **an empty collection is indistinguishable from a clean codebase in
every assertion that consumes it.** Found and fixed by SWE II 1; anchored at
`619bd98`. This is the highest silence-per-defect ratio found: the file that
protects the whole tree, blind for as long as it has existed.

### 1.2 A guard whose population is the property it checks

`delivery-floors.test.ts` built `SHOTS_WITH_DRAW_CEILINGS` by filtering to shots
that *have* a draw-call ceiling, then iterated it. **A shot that loses its
ceiling does not fail anything — it leaves the population**, the remaining cases
pass, and the block reports green over a smaller set than yesterday. Coupled to
probe status at `a30fce5`.

### 1.3 A doc guard covering 9 of 26 rows

`docs-truth` pinned nine rows of `docs/PERFORMANCE.md`'s resolved-tier table
against the profile. The table has **26**. Nothing said which 17 were outside it.

Not hypothetical: landing the cascade cut, the guard failed on exactly two rows,
those two were fixed, and the other 24 were never checked. **A green read as
"the doc matches the profile" when it meant "the nine rows somebody listed
match."** Now 19 checked and 7 declared unverifiable with a reason each; every
row must be covered by **exactly one** list (`cc84eed`).

### 1.4 Gates that never executed

`perf-capture.test.ts` ran every gate in one loop that threw on first failure.
The **most host-sensitive** gate — frame delivery — ran before the deterministic
memory and residency ones. On a loaded host a wall-clock miss on shot 1 aborted
the loop, and **shots 2..N never had their gates evaluated at all.**

Two corrections to how this was first reported, both mine: the shots *are*
captured and the report *is* written before any gate, so the skipped thing is
gate evaluation, not measurement; and ordering was not the fix, because there
are **seven** `gateDelivery` call sites rather than one block. Fixed by making
the delivery gate collect rather than throw, so it cannot mask anything wherever
it sits (`dbc0b59`).

### 1.5 Guards that matched prose

Five guards matched their target symbol inside **comments**, because they did not
strip them — so a codebase that only *discussed* a construct read as one that
used it. Found by SWE II 2. The two guards written tonight that scan source both
strip comments first, and both carry an instrument leg proving a commented
mention is not counted.

### 1.6 The instruments that failed while investigating the instruments

Recorded because they are the same shape one level up, and because several were
mine:

| instrument | what it answered | what was asked |
|---|---|---|
| `git show $c:path` in zsh | the commit message | the file at that commit |
| `grep -c` on `cascadedShadowGenerator.js` | 0 | the implementation is in `.pure.js` |
| `diff` of two empty outputs | "IDENTICAL" | do these two commits differ |
| `cmd \| head -N; echo $?` | `head`'s status, always 0 | did the command succeed |
| `git diff <ref> -- <paths>` | untracked files as deletions | what changed |
| a `sed` window around a match | the previous record's fields | this record's fields |
| `ps \| grep -c chromium` | 20, for hours | **is a capture RUNNING** |

**The host gate is the seventh and it is the only one that cost TIME rather than
a wrong answer.** A session deferred its work for over two hours on a check that
counted chromium *processes* rather than busy ones. The twenty it kept seeing
were `chrome_crashpad_handler` at **0.0% CPU** — leftovers that persist after a
capture ends. Captures were genuinely running for the first stretch; after they
finished the gate went on reporting "capture live" **and never erred, never
varied, and was confidently wrong for hours.** *Measure CPU, not presence.* The
PM used the same presence-counting form early in the evening before switching to
a CPU threshold, so it produced the same wrong answer in two sessions
independently.

**Two things about it that the other six do not have, both from the session it
cost, correcting this document's first framing of them.**

**The emphasis belongs on the independence, not on the self-report.** Two
sessions, no contact, the same wrong mechanism. **That is not two people being
careless; it is `ps | grep -c` being the obvious thing to write and the wrong
thing to write.** Anyone writing that gate fresh tomorrow gets the same answer.

**And a gate that falsely says BUSY can never be contradicted.** Nothing
downstream disagrees with it, because nothing downstream runs. **Every other
instrument on this list produced a number somebody argued with; this one produced
silence, and nobody argues with silence.** That asymmetry is why it survived
hours when a wrong *number* would have been caught in minutes — and it
generalises past this instance: **a false negative in a gate is structurally
harder to detect than a false positive in a measurement.**

**In zsh, `$c:scripts/foo.ts` expands to `$c`** — `:s` is a history-substitution
modifier that eats the path. The resulting `git show <sha>` **succeeds**, prints
a commit message containing none of the searched text, and the grep honestly
reports zero. A valid command, plausible output, wrong question.

---

### 1.7 A gate reading the wrong activity — the crashpad case's sibling, not a repeat

The gate above measured **presence instead of activity**: chromium processes
counted whether or not they were doing anything. This one reads a real signal
correctly and **the signal does not mean what the gate needs it to mean.**

The host gate this session ran all evening was two checks. The chromium half was
CPU-thresholded (`awk '$3>10'`) and never counted idle leftovers — right by
construction rather than by luck. The vitest half was
`ps aux | grep -i vitest | grep -v grep | wc -l`: **pure presence counting, the
defective form exactly.** No evidence it ever produced a wrong answer, because
vitest exits rather than lingering the way a crashpad handler does — **structure
wrong, outcome fine**, and one persistent process away from the same two hours.

**But the interesting failure is the other one, and it did produce a wrong
answer.** Watched across three checks in five minutes:

    check 1   vitest present 4    vitest >10% cpu 0    chromium >10% 0
    check 2   vitest present 0    vitest >10% cpu 0    chromium >10% 0
    check 3   vitest present 9    vitest >10% cpu 9    chromium >10% 0
              node at 107%, 94%, 93%, 90% — a Node suite run, not a capture

**`vitest` busy with `chromium` idle is somebody running the Node suite. That
contends for CPU and not at all for the GPU.** The gate conflated it with "a
capture is running", which is the thing that actually blocks a capture slot.

**Two signals, two questions, read as one.** For a draw-call or pixel
measurement — deterministic, load-independent — chromium CPU is the signal and a
Node suite is irrelevant. For wall-clock and watchdog margin, total CPU matters.
A concrete cost: **"4 vitest, load 11.48" was reported to the PM as a busy host
and held a slot. It was a Node suite; by the GPU criterion the host was free.**

**The corrected form reports both**, because there are two questions: *chromium
free, so a capture can run; nine node processes at 90–107% and load 13.2, so a
timing-sensitive run would still be contended.*

**Why this is a distinct entry rather than a second instance.** The crashpad gate
was wrong about *whether* something was happening. This one was right about that
and wrong about *what* — and no amount of thresholding fixes it, because the
threshold was already there. **A gate can be correct in mechanism, correct in
reading, and still answer a question nobody asked.**

---

### 1.7 A gate reading the wrong activity — the crashpad case's sibling, not a repeat

The gate above measured **presence instead of activity**: chromium processes
counted whether or not they were doing anything. This one reads a real signal
correctly and **the signal does not mean what the gate needs it to mean.**

The host gate this session ran all evening was two checks. The chromium half was
CPU-thresholded (`awk '$3>10'`) and never counted idle leftovers — right by
construction rather than by luck. The vitest half was
`ps aux | grep -i vitest | grep -v grep | wc -l`: **pure presence counting, the
defective form exactly.** No evidence it ever produced a wrong answer, because
vitest exits rather than lingering the way a crashpad handler does — **structure
wrong, outcome fine**, and one persistent process away from the same two hours.

**But the interesting failure is the other one, and it did produce a wrong
answer.** Watched across three checks in five minutes:

    check 1   vitest present 4    vitest >10% cpu 0    chromium >10% 0
    check 2   vitest present 0    vitest >10% cpu 0    chromium >10% 0
    check 3   vitest present 9    vitest >10% cpu 9    chromium >10% 0
              node at 107%, 94%, 93%, 90% — a Node suite run, not a capture

**`vitest` busy with `chromium` idle is somebody running the Node suite. That
contends for CPU and not at all for the GPU.** The gate conflated it with "a
capture is running", which is the thing that actually blocks a capture slot.

**Two signals, two questions, read as one.** For a draw-call or pixel
measurement — deterministic, load-independent — chromium CPU is the signal and a
Node suite is irrelevant. For wall-clock and watchdog margin, total CPU matters.
A concrete cost: **"4 vitest, load 11.48" was reported to the PM as a busy host
and held a slot. It was a Node suite; by the GPU criterion the host was free.**

**The corrected form reports both**, because there are two questions: *chromium
free, so a capture can run; nine node processes at 90–107% and load 13.2, so a
timing-sensitive run would still be contended.*

**Why this is a distinct entry rather than a second instance.** The crashpad gate
was wrong about *whether* something was happening. This one was right about that
and wrong about *what* — and no amount of thresholding fixes it, because the
threshold was already there. **A gate can be correct in mechanism, correct in
reading, and still answer a question nobody asked.**

---

## 2. The discriminator

The transferable result. Not

> *does my mechanism explain the number*

but

> **does the KNOWN defect explain it exactly.**

The worked example. `channelAtlasMiB` read **107.18** estimated against
**165.96** measured — the estimate low by 58.8 on its largest term, in the
direction the fudge factor could not absorb. I had a plausible mechanism: eight
channel families in separate textures, alignment padding producing real bytes
that serve nothing. Seventeen bytes per texel of waste. **It explained the
discrepancy approximately and it was wrong.**

What killed it was computing what the *already-known* `texelBytes` bug would
have returned for each shipped format, and checking whether it hit the measured
figure exactly:

| family | format | true | pre-fix |
|---|---|---|---|
| splatId | rgba8unorm | 4 | 4 |
| splatWeight | rgba8unorm | 8 | 8 |
| occlusion | rgba8unorm | 4 | 4 |
| horizon | rgba8unorm | 8 | 8 |
| flowAccum | r16float | 2 | **8** |
| lakeDepth | r16float | 2 | **8** |
| soilDepth | r8unorm | 1 | **4** |
| shoreDistance | r16sint | 2 | **4** |
| **total B/texel** | | **31** | **48** |

At tier 1's 1904² texels: **107.18 MiB** true — the estimate's own figure, to the
hundredth — and **165.95 MiB** pre-fix, against the measured 165.96. The four
mis-keyed families are exactly the four single-channel ones SWE II 2 had
enumerated.

**The measurement was taken before the fix. The estimate was never low.** A
mechanism that fits approximately is competing with a bug that fits precisely,
and the bug wins.

**The precondition was worth more than the investigation.** "Establish which side
of the fix that measurement was taken on" (the PM's) was thirty seconds and it
replaced a host slot and a wrong finding.

---

## 3. Two claims that were never true at any commit

Everything else here was true once and rotted. These are a different category.

**The fudge factor's provenance.** `ESTIMATE_FUDGE_FACTOR = 1.15`'s docblock
claimed it was cross-checked against the renderer's texture/buffer inventory.
Verified independently:

    f67b147  introduces the constant WITH that sentence
             inventoryGpuMemoryMiB: 0 occurrences at that commit
             "inventor" appears in exactly ONE file in src/ — the docblock citing it
    ba63ef0  introduces the inventory walk

The cross-check could not have happened. **Not a calibration that went stale —
one that never occurred.** Struck in place; the constant deliberately kept,
because four owners budget through it and swapping a known-wrong multiplier for
no basis is worse.

**Its re-pin trigger.** "Re-pin when |estimate − actual| exceeds 15%." Measured:

    pre-fix   (tier 1, my bridge arms)     25.4%   already in breach
    post-fix  (tier 1, PM's 36-shot run)   48.0%   three times the threshold

**The rule was breached under the broken inventory and under the corrected one.**
The fix did not break it; it has apparently never been satisfied. A trigger
stated in prose has nothing to compare against and nobody to tell. Now a
mechanism at `0c8802e`, reading the threshold from an exported constant rather
than a transcribed copy — **and it has never been executed**, because
`tests/perf/` needs a device. It will fail its first capture. That is the point.

---

## 3b. The failure that is not an instrument failing: no instrument at all

**Every entry above is a check that RAN and answered the wrong question. There is
a second category, and it accounts for more of the evening's wrong claims than
the seven instruments did: a claim about an artifact, made without reading the
artifact.**

**It has a reader who could refute it — the artifact — and the reader is
skipped.** That is §8's argument turned inward: not an unattributed claim with no
possible reader, but an attributable one whose reader was one command away.

Instances, both authors:

- **The Phase 7 Lead asserted twice that *Still open* named no owner for any
  item**, in messages arguing that claims need a reader who can refute them. The
  owners had landed in `cebfca0`, an ancestor of the commit they verified at, in
  the file they had open. Reported from recollection of having written the
  section, one `sed` away from the text.
- **The PM claimed `runwayPlatformHalfWidth` did not exist**, from a grep scoped
  to `src/world/`; it is in `src/render/webgpu/terrain/RunwayEarthworks.ts`. Was
  about to "correct" a correct citation.
- **The PM generalised "vertex buffers were never counted against textures"** —
  true of the plan's discussion — **to the instrument**, which walks
  `scene.meshes` and sums them. Sent an engineer hunting a missing category that
  was never missing.
- **The PM counted prose as code seven times in one evening**, most consequentially
  reporting a duplicate `parametric-hangars` entry that was a cross-reference in
  another entry's note.

**Why it is worth its own section rather than a line in the honest-cost list: it
is cheaper to fix than any of the seven and it is the one nobody instrumented.**
A defective gate needs a redesign. This needs opening the file. **The document is
about instruments answering the wrong question; this is the failure of not asking
one.**

**Not written as contrition.** The useful form is the rule: **before asserting
what an artifact contains, read the artifact — especially when you wrote it, and
most of all when the claim is that something is absent.**

---

## 4. What this cost, and what it bought

**Honest ratio: a large fraction of the evening went to instruments rather than
features.** Roughly half my own turns. That is not a good ratio in itself.

What it bought:

- **A "live ceiling breach" that never existed.** `reference-viewport` at 495.9
  against a 495 pin, chased as a real overage. Headroom was **+163 MiB**. The
  reading was a phantom of the same `texelBytes` bug.
- **A ceiling that no longer binds.** `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB`
  was derived from the inflated inventory twice — `489.0 + 6.0` and then
  `492.3 + 2.7`, both landing on 495 — so post-fix it carries **~238 MiB of
  slack** and will absorb a genuine regression without a word.
- **A bimodal draw-call result that was nearly attributed to the wrong cause.**
  The bridge measurement came back +6 on 27 shots and −6 on 7, and the seven are
  exactly the seven a different owner found from a different commit pair.
- **A retraction that had to be re-applied twice** because it lived as an
  uncommitted change in a checkout eight sessions share.

**The through-line: every one of those was a number somebody was about to build
on.** The cost is real; so is the counterfactual.

---

## 5. The pairing pattern

Two observations that are method rather than anecdote.

**The author tests the failure they imagined; the reviewer tests the one they
feared.** I verified the exactly-one guard catches a *forgotten* registration —
the failure I designed against. SWE II 1 verified it catches a *double*
registration — the failure they were about to create. Neither of us was being
thorough where the other was; **we were each thorough about our own position in
the change.** It predicts where a solo change is weakest: the direction the
author is not standing in.

**Hand people the hypothesis they are attached to.** The Principle Engineer did
this four times and it improved the result four times, three of them against the
reading they preferred. Their own correction — that a "+128 MiB" figure was true
of the arms they measured and not of what shipped — arrived unprompted and
before it could travel.

**A corollary neither of us expected: agreement between two measurements is
worth nothing if they share a premise.** SWE III and I independently identified
the same "water" region in `night-moonlit` from different frames using sound
statistics — and were both wrong, because every statistic we each computed tested
the consequences of a shared assumption rather than the assumption. Only a
positive control separated them: **would this window show the effect if the
effect were enormous?** The one genuinely independent agreement of the night —
two methods with no common input meeting at 208.44 and 52.11 — is worth more
than any of the others.

---

## 5b. One measurement that had to be repaired, and why it counts as a lesson

**The ceilings re-measure was run, produced +81..+108 draw calls across every
baselined shot, and was then USELESS** — the movement was cumulative since the
first pin and therefore unattributable, so no owner could declare a raise against
it. A fourth arm with only the cascade decoupling removed split it:

    CASCADE FIX       +57 .. +69   mean +65.1
    EVERYTHING ELSE   +24 .. +39   mean +35.6

**The fourth arm is a REPAIR, not a design**, and its author asked that it be
recorded that way. **The lesson is "ask what the number will be used for before
measuring it", not "always run a fourth arm."** Three runs answered a question
nobody needed answered; the requirement — that a raise declaration needs an
attributable delta — was discoverable before any capture and was not sought.

**Two things fell out of the repair that the original measurement could not have
given.** The cascade fix is nearly **twice every other feature since the pin,
combined** — *"a casting mesh goes 2.00 → 3.00 draws"* sounded negligible, and
with ~65 casting meshes in frame it is **+35% of the frame's draw calls**
(194 → 261 at `reference-viewport`). A per-item delta multiplied by an unstated
population is a small instance of this document's own subject, and the PM was
using that framing too.

And "everything else" is cleanly bimodal: **+24 on exactly the seven shots with
no airfield in frame, +39 on all others.** One global group and one airfield
group, which makes owner declarations checkable rather than assertable.

---

## 6. Still open

**Each item names an owner, because §8 applies to this section first: an item
with no owner is a claim with no reader who can refute it. The names are the
PM's assignment, not the owners' claim, and any of them may hand an item back.**

- **The inventory ceiling** — *SWE II 1 (`tests/render.gpu-memory-inventory-format.test.ts`).*
  **The frame for the number:** `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB` is
  495; a 36-shot capture at tier 1 (`quality medium`, `renderScale 0.86`) after
  the format fix `4543b7e` read a maximum of **256.7 MiB** inventoried
  (`reference-viewport`), minimum 248.3. That is ~238 MiB of slack — deliberately not re-derived: the
  corrected instrument has already been wrong once (a 2× under-count on
  `TEXTURETYPE_SHORT`, caught only by enumerating every single-channel site), so
  the re-derivation should follow the enumeration rather than precede it. And it
  must not be re-derived while the fudge factor stands, or a 15% arbitrary
  component is carried into the new ceiling invisibly.
- **The trigger guard has never run** — *Principle Engineer (`0c8802e`, `tests/perf/perf-capture.test.ts`).* It needs one capture and will fail it.
- **The `:913` ocean subsurface term** — *SWE III (`SpectralOceanSystem.ts:913`).* Live on night water and measured at
  ≤1 display byte at the shipped vantage — a genuine null on a shot containing
  the substrate, with a 1000× positive control proving the instrument could see
  it. Not fixed, not closed; a near-field night-over-water vantage would settle
  it and is now earned rather than merely wanted.
- **Night tier inversion** — *unowned, and deliberately so: nobody has a measurement in hand and assigning it would manufacture false coverage.* Tier 3 slower than tier 2 at night while leaving
  82–85% of pixels identical. Thirteen profile fields differ, not the four the
  writeup originally listed; **the 21% is unattributed and no claim is made.**
- **The archive is not in the tree** — *Phase 7 Lead (`.gitignore:45`), who found it.* `tests/perf/artifacts/` is gitignored, so
  every archived report cited in a finding exists on one machine. Numbers quoted
  from them are not retrievable by anyone else.

---

## 7. One correction to this document's own commissioning

The brief quoted a sentence back to me as mine. **It is the Principle
Engineer's**, and in full it reads:

> the failures we found were uniformly silent: a threshold that cannot fire, a
> coordinate that cannot be right, an azimuth 90° out, a right number in the
> wrong frame, and a git ref that reads as a commit object. **Five instruments,
> five confident tidy answers, no errors raised.**

Of those five instruments only the git ref is mine; the azimuth and the
wrong-frame error belong to other sessions. **It is the best summary of the
evening anyone produced and it is not my sentence.**

Recorded here rather than quietly corrected because the mechanism is the
document's own: a sentence was taken from one session, handed to another as
theirs, and used to commission a document — **the same detachment from
provenance, with a person as the payload instead of a number.** It is also the
second instance of that in one hour; `flight-simulator-d6` made the identical
correction about the body-axis work.

**A smaller instance, in the same brief.** The commit count I was given was 169
and `git log --since` returned 146. **Both are correct and they answer different
questions** — 169 is the working session measured from the Phase 6 plan commit,
146 is the calendar day. Neither is wrong; neither was the number the sentence
needed. This document quotes no commit count, because at the time of writing I
could establish only that the two figures disagreed and not which question
either answered.

---

## 8. Why those misattributions were catchable at all

**`flight-simulator-d6`'s observation, and it generalises §7 into the document's
own thesis rather than sitting beside it.**

Two misattributions happened within an hour, and **both were caught by the person
misattributed *to*.** That is not luck. **The subject of a credit claim is the
only reader guaranteed to know it is wrong** — everyone else is reading a
plausible sentence about work they did not do. Attaching a name to a claim
installs the one reader who can refute it.

**The converse is what puts this in this document instead of a style guide.** An
unattributed claim has no such reader. *"The body-axis work was done"* is
checkable by nobody in particular; *"the body-axis work was yours"* is checkable
by exactly one person, who will notice. **The unattributed version is a statement
with no failure mode** — the same shape as the guard that matched nothing, the
scan that returned empty, and the trigger with no mechanism. Not wrong. Incapable
of being found wrong.

**Three sharpenings, all theirs:**

**The mechanism is asymmetric, and only one direction is reliable.**
Misattributing *to* someone is caught, because they read it and know.
Misattributing *away* from someone — dropping a credit, or absorbing a finding
into a summary — often is not, because the true author may never see the
document. **The defence is weakest exactly where the injustice is worst.** A
writeup should therefore be checked hardest where a name was *omitted*, not where
one was given. Both of tonight's catches were the easy direction.

**Naming creates the route, not only the detector.** An attributed claim tells a
doubting reader **who to ask**. An unattributed one leaves them the claim and
nothing else — which is how a wrong figure travelled four sessions before anyone
could locate its origin to question it.

**Provenance marking is the same mechanism applied to facts rather than credit.**
"Carried from X" versus "verified here" is not bookkeeping: it names the person
who can refute the line, and marks which lines have no such person yet. **If the
argument holds for credit it holds for measurements, and the two conventions are
one convention.** This document's own preamble is an instance.

**Session names are not durable identifiers, and this document will outlive
every session in it.** Also theirs, and caught on this document: §8 first read
"the Principle Engineer's +128 MiB" while the file was written by a session
signing as *Principle Engineer (Phase 7 Lead)*. Those are two sessions —
`[b12695]` and `[87a15f]` — but **a reader with no roster cannot resolve that**,
and the roster is the shortest-lived thing in the story. Names were reassigned
mid-flight, two collided, and one session was unreachable under the name three
others were still using.

**So the two uses want different anchors.** Where the point is *who to ask*, a
name is right and perishable. Where the point is *where this came from*, a commit
is right and permanent. Both belong, marked as different things:

| claim | who to ask (perishable) | where it came from (durable) |
|---|---|---|
| the cascade arms and their +128 MiB | `Principle Engineer [b12695]` | `034aedd`, and the figure at `AtmosphereSystem.ts:311` |
| the inventory format fix | SWE II 2 | `4543b7e` |
| "cannot affect a single frame" | this session `[87a15f]` | `d0c7ecc` |

**POSTSCRIPT — the claim above was tested on this document within the hour. It
held, and it held harder than the section had allowed for.**

**First, the error, because it is the section's own subject and I made it.** Every
session name in this file went unreachable at once, and I concluded the crew had
been replaced — reporting to the user that the team no longer existed. **It was a
batch RENAME.** The sessions persisted, their work persisted, and ownership
persisted; only the labels moved. **I inferred identity from a name, which is
precisely what this section argues cannot be done.** The PM independently made
the same misreading in the same window and briefed a colleague who had written
four of this project's documents as a stranger. **Two sessions, no contact, the
same wrong inference from the same signal** — the shape §1.6's host gate has.

**Second, and worse for this section: the `[ref]` is not durable either.** The
table above uses session refs — `[b12695]`, `[87a15f]` — in the perishable column
as though they disambiguated a name. **They do not survive a rename.** This
session's ref went `[87a15f]` to `[e17500]` across it, and that is not an
inference: **I hold this entire evening's context and know I am the same
session.** A name changing is ambiguous evidence; a ref changing under an
identity I can verify from the inside is proof.

**So the perishable column is more perishable than it was drawn.** Names, refs,
and any roster built from either expire together and without notice. **What
survived the reset is exactly and only what §8's durable column already held:
every commit sha resolves, every file path resolves.** Four of the five owner
names in §6 resolve to nobody, and would have been the whole record had the
anchors not been placed beside them.

**Read the §6 owners as "who to ask, if that name still points at them", and the
anchors as the handle.** An unreachable name is not an abandoned item; each is
described well enough beside its anchor to be picked up cold.

**Recorded, not tidied: four untracked probe scripts sit at the repository root**
— `.band-probe.mjs`, `.frame-view.mjs`, `.lampdiff.mjs`, `.lamphist.mjs`, about
1 KB each, referenced by nothing tracked, almost certainly throwaway instruments
from the lamp and night-frame work. **Deliberately not deleted**, for the reason
`flight-simulator-d6` gave about this document's own near-miss: *nothing in the
outcome would distinguish "I moved it somewhere safe" from "I destroyed the only
copy" until someone went looking.* Their existence is the record; the decision
belongs to whoever can still identify them.

**And their caveat, stated rather than left to inference: none of this makes
attribution sufficient.** A correctly-attributed wrong number is still a wrong
number, and tonight produced several — the **+128 MiB** above, true of the arms
measured through `noColorAttachment: false` and not of what `034aedd` shipped;
the **165.96**, real and pre-fix; my own **"cannot affect a single frame"**, true
of the shot names and false of the frames. **All three correctly attributed. All
three wrong. Attribution installs a checker. It does not do the checking.**
