#!/bin/bash
# Measure ONE feature's per-shot draw-call cost, so its owner can declare a real
# `DRAW_CALL_RAISES` entry instead of sharing a bundled one.
#
# WHY THIS SHAPE. The raise mechanism is per-FEATURE and carries a `commit`
# field, and `DRAW_CALL_RAISES`' own docblock warns that creep does not look
# like creep -- one entry covering four features is indistinguishable in form
# from four features' worth of drift. So attribution has to be per commit, and
# the cheapest honest way to attribute a commit is to capture at that commit and
# at its parent and difference them.
#
# IT TOUCHES NO SOURCE. Suppression flags would mean editing the very files
# their owners are working in, and mesh-name grouping does not separate features
# cleanly (AirfieldFurniture builds no meshes of its own; its geometry lands in
# meshes named for the hangars). Two worktrees and a subtraction avoid both.
#
# USAGE
#   scripts/decompose-draw-calls.sh <commit> [shot,shot,...]
#
#   <commit>  the feature's commit. Its PARENT is the baseline.
#   [shots]   optional VITE_PERF_SHOTS filter. Omit for the full set, which is
#             what a raise needs -- a raise names shots, and this growth is NOT
#             uniform, so a subset cannot stand in for the list.
#
# COST: two full captures plus two discarded warm-ups, ~20 minutes on a quiet
# host. Announce before running; the host is shared.
#
# THE WARM-UP IS NOT OPTIONAL. A first run after a tree change has produced
# 136-vs-157 draw calls, a 465,406-pixel phantom, and a 69.64% frame difference
# against an identical code state. Three sessions have been bitten. Each arm
# here runs twice and keeps the second.
set -u
# TWO EXPLICIT REFS, not <commit> and an implied parent. The first cut took one
# commit and derived `^` itself; the invocation published to four owners was the
# two-ref form, and the mismatch was SILENT -- `<sha>^ <sha> shots` would have
# diffed the GRANDPARENT against the parent and passed a SHA as the shot filter,
# matching no shots and producing an empty report that looked like a clean run.
# Caught by validating the tool before anyone used it.
BASE_REF="${1:?usage: decompose-draw-calls.sh <base> <head> [shots]   e.g. abc123^ abc123}"
HEAD_REF="${2:?usage: decompose-draw-calls.sh <base> <head> [shots]   e.g. abc123^ abc123}"
SHOTS="${3:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# REFUSE THE SHAPES THAT FAIL SILENTLY. The published invocation and the script
# disagreed once already, and the failure mode was not an error -- it was an
# EMPTY REPORT that reads as a clean zero, which is the expected answer for most
# commits here. A wrong answer that matches the expectation is the worst kind.
if ! git -C "$REPO" rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  echo "ERROR: base ref '$BASE_REF' is not a commit." >&2
  echo "       usage: decompose-draw-calls.sh <base> <head> [shots]   e.g. abc123^ abc123" >&2
  exit 2
fi
if ! git -C "$REPO" rev-parse --verify --quiet "${HEAD_REF}^{commit}" >/dev/null; then
  echo "ERROR: head ref '$HEAD_REF' is not a commit." >&2
  echo "       If you passed a shot list here you are using the OLD two-argument form." >&2
  echo "       usage: decompose-draw-calls.sh <base> <head> [shots]   e.g. abc123^ abc123" >&2
  exit 2
fi
# A shot filter that looks like a SHA is the old form's signature, and it would
# select ZERO shots rather than erroring.
if [ -n "$SHOTS" ] && git -C "$REPO" rev-parse --verify --quiet "${SHOTS}^{commit}" >/dev/null; then
  echo "ERROR: shot filter '$SHOTS' resolves to a commit -- that is the OLD argument form." >&2
  echo "       usage: decompose-draw-calls.sh <base> <head> [shots]" >&2
  exit 2
fi

BASE="$(git -C "$REPO" rev-parse --short "$BASE_REF")"
HEAD_SHA="$(git -C "$REPO" rev-parse --short "$HEAD_REF")"
WORK="${TMPDIR:-/tmp}/decompose-$HEAD_SHA"
rm -rf "$WORK"; mkdir -p "$WORK"

capture() { # <sha> <outdir>
  local sha="$1" out="$2" wt="$WORK/wt-$1"
  git -C "$REPO" worktree add -f "$wt" "$sha" >/dev/null 2>&1
  ln -s "$REPO/node_modules" "$wt/node_modules"
  mkdir -p "$out"
  for pass in warmup keep; do
    ( cd "$wt" && VITE_PERF_SHOTS="$SHOTS" \
        npx vitest run --config vitest.perf.config.ts >/dev/null 2>&1 )
    [ "$pass" = keep ] && cp "$wt/tests/perf/artifacts/report.json" "$out/report.json"
  done
  # PROVENANCE, read from the worktree that actually ran. `captureEnvironment`
  # records adapter, tier, quality and render scale -- and NO COMMIT. So a
  # report is well-formed and internally consistent whether or not the checkout
  # moved, and an arm that failed to rebuild produces a perfectly valid report
  # OF THE WRONG TREE. That has cost this team four captures once already.
  # Stamped per arm and asserted below; a claim about a commit needs evidence
  # from the commit.
  git -C "$wt" rev-parse HEAD > "$out/HEAD.sha"
  git -C "$wt" status --porcelain | wc -l | tr -d " " > "$out/dirty.count"
  git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1
}

echo "baseline  $BASE"; capture "$BASE" "$WORK/base"
echo "feature   $HEAD_SHA"; capture "$HEAD_SHA" "$WORK/feat"

# The two arms must be the two commits asked for, and must differ. Without this
# the whole run is a difference between two trees nobody verified.
BASE_RAN="$(cat "$WORK/base/HEAD.sha")"; FEAT_RAN="$(cat "$WORK/feat/HEAD.sha")"
BASE_WANT="$(git -C "$REPO" rev-parse "$BASE_REF")"; FEAT_WANT="$(git -C "$REPO" rev-parse "$HEAD_REF")"
if [ "$BASE_RAN" != "$BASE_WANT" ] || [ "$FEAT_RAN" != "$FEAT_WANT" ]; then
  echo "ERROR: an arm ran the wrong tree." >&2
  echo "       baseline wanted $BASE_WANT ran $BASE_RAN" >&2
  echo "       feature  wanted $FEAT_WANT ran $FEAT_RAN" >&2
  exit 4
fi
if [ "$BASE_RAN" = "$FEAT_RAN" ]; then
  echo "ERROR: both arms ran the SAME commit ($BASE_RAN); the difference is meaningless." >&2
  exit 4
fi
if [ "$(cat "$WORK/base/dirty.count")" != "0" ] || [ "$(cat "$WORK/feat/dirty.count")" != "0" ]; then
  echo "WARNING: an arm's worktree was dirty; the capture is not purely of that commit." >&2
fi
echo "provenance OK  base $(echo "$BASE_RAN" | cut -c1-7)  feat $(echo "$FEAT_RAN" | cut -c1-7)"

python3 - "$WORK/base/report.json" "$WORK/feat/report.json" "$HEAD_SHA" "$SHOTS" <<'PY'
import json, sys
base = {s["name"]: s["drawCalls"] for s in json.load(open(sys.argv[1]))["shots"]}
feat = {s["name"]: s["drawCalls"] for s in json.load(open(sys.argv[2]))["shots"]}

# NON-VACUITY, STRUCTURAL. An empty report does not produce SMALL numbers, it
# produces NO SHOTS -- and without this the loop below prints "no shot moved,
# this commit costs no draws", which is the expected answer for most commits
# here. A run that measured nothing would have been indistinguishable from a
# correct zero. Structural, not physical: no threshold, no noise floor.
requested = [s for s in (sys.argv[4].split(",") if len(sys.argv) > 4 and sys.argv[4] else []) if s]
for label, got in (("baseline", base), ("feature", feat)):
    if not got:
        print(f"ERROR: the {label} report contains NO SHOTS. The run measured nothing; "
              "this is not a zero result.", file=sys.stderr)
        raise SystemExit(3)
    missing = [s for s in requested if s not in got]
    if missing:
        print(f"ERROR: the {label} report is missing requested shot(s): {', '.join(missing)}. "
              "A partial report cannot be differenced.", file=sys.stderr)
        raise SystemExit(3)

shared = sorted(set(base) & set(feat))
if not shared:
    print("ERROR: the two reports share no shots, so nothing can be differenced.", file=sys.stderr)
    raise SystemExit(3)
deltas = {n: feat[n] - base[n] for n in shared}
moved = {n: d for n, d in deltas.items() if d != 0}
print(f"\n=== {sys.argv[3]} : per-shot draw-call delta ===")
for n in sorted(moved, key=lambda k: -moved[k]):
    print(f"  {n:32} {moved[n]:+4d}")
if not moved:
    print("  (no shot moved — this commit costs no draws)"); raise SystemExit
values = set(moved.values())
print(f"\nshots moved: {len(moved)} of {len(shared)}")
if len(values) == 1 and len(moved) == len(shared):
    print(f'DECLARE: kind "uniform", delta {values.pop()}, naming every shot with a previous ceiling.')
else:
    print(f"DECLARE: kind \"per-shot\" — deltas are {sorted(values)} and "
          f"{len(shared) - len(moved)} shot(s) did not move.")
    print("`whyNonUniform` is REQUIRED and is the whole justification: say what varies.")
PY
echo "artifacts under $WORK"
