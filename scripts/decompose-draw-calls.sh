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
#   scripts/decompose-draw-calls.sh <base> <head> [shot,shot,...]
#
#   <base>    the baseline ref. For a single commit, pass `<sha>^`.
#   <head>    the feature ref.
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
set -uo pipefail
# `set -u` ALONE WAS NOT ENOUGH AND THE GAP COST 98 MINUTES OF HOST TIME.
# Without `-o pipefail` and explicit checks, a failed `cp`, a dead capture and a
# crashed Python step all left `$?` at 0 -- so the script exited SUCCESS having
# produced nothing. For three of the four owners the expected answer is a clean
# zero, and an empty report is exactly what a clean zero looks like.
#
# `-e` is deliberately NOT set: it exempts commands in conditions and in
# function bodies called from conditions, which is its own silent-failure
# surface. Every step below checks and exits explicitly instead.
#
# Exit codes: 2 bad arguments, 3 no usable data, 4 provenance, 5 timeout.
DEADLINE_SECONDS="${DECOMPOSE_DEADLINE_SECONDS:-2400}"
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
# NODE_MODULES COMES FROM THE MAIN CHECKOUT, NOT FROM WHICHEVER COPY INVOKED US.
# `REPO` is derived from this script's own path, so running the copy inside a
# worktree made `$REPO/node_modules` that worktree's -- which is itself a symlink
# or absent. The resulting capture could not resolve `vitest`, produced no
# report, and (with stderr suppressed) surfaced three steps later as a `cp`
# failure. An empty report reads as "no draws moved", which is the expected
# answer for most commits here.
GIT_COMMON="$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null || echo "")"
case "$GIT_COMMON" in
  /*) MAIN_CHECKOUT="$(dirname "$GIT_COMMON")" ;;
  *)  MAIN_CHECKOUT="$(cd "$REPO/${GIT_COMMON:-.git}/.." && pwd)" ;;
esac
NODE_MODULES="$MAIN_CHECKOUT/node_modules"
if [ ! -d "$NODE_MODULES" ]; then
  echo "ERROR: no node_modules at $NODE_MODULES (main checkout resolved from $REPO)." >&2
  exit 2
fi

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

# Run one capture under a deadline, keeping its output. `timeout` does not exist
# on this host -- it is `gtimeout` or nothing -- so the watchdog is bash-native.
# The 98-minute runaway was silent because there was no bound AND no log.
run_bounded() { # <workdir> <logfile>
  local wt="$1" log="$2" pid waited=0
  ( cd "$wt" && VITE_PERF_SHOTS="$SHOTS" \
      npx vitest run --config vitest.perf.config.ts ) > "$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$DEADLINE_SECONDS" ]; then
      echo "ERROR: capture exceeded ${DEADLINE_SECONDS}s; killing. Log: $log" >&2
      kill -TERM "$pid" 2>/dev/null || true
      sleep 5
      kill -KILL "$pid" 2>/dev/null || true
      return 5
    fi
    sleep 5
    waited=$((waited + 5))
  done
  # The capture EXITS NON-ZERO whenever a gate fails, which is routine and not
  # our concern -- `report.json` is written before any gate runs. So the exit
  # code is recorded and the ARTIFACT is what decides, checked by the caller.
  wait "$pid" || true
  return 0
}

capture() { # <sha> <outdir>
  local sha="$1" out="$2" wt="$WORK/wt-$1" rc
  mkdir -p "$out"
  if ! git -C "$REPO" worktree add -f "$wt" "$sha" >"$out/worktree.log" 2>&1; then
    echo "ERROR: could not create a worktree at $sha. See $out/worktree.log" >&2
    return 3
  fi
  ln -s "$NODE_MODULES" "$wt/node_modules"
  # RESOLUTION IS ASSERTED, NOT ASSUMED. A partial or symlinked-to-symlink
  # node_modules stops module resolution dead, and the capture then fails in a
  # way whose only visible trace is a missing report. Checking here costs
  # milliseconds and converts a 98-minute silent runaway into an immediate,
  # named error.
  if ! ( cd "$wt" && node -e "require.resolve('vitest/package.json'); require.resolve('@babylonjs/core/scene')" ) 2>"$out/resolve.log"; then
    echo "ERROR: $sha's worktree cannot resolve vitest or @babylonjs/core." >&2
    echo "       node_modules symlinked from: $NODE_MODULES" >&2
    cat "$out/resolve.log" >&2 || true
    git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1 || true
    return 3
  fi
  for pass in warmup keep; do
    run_bounded "$wt" "$out/capture-$pass.log"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1 || true
      return "$rc"
    fi
    if [ "$pass" = keep ]; then
      if [ ! -f "$wt/tests/perf/artifacts/report.json" ]; then
        # `perf-capture.test.ts` writes the report after every shot is captured
        # and BEFORE any gate -- "a capture's frames are diagnostic input, not a
        # reward for passing". So a missing report means the run never finished
        # capturing, NOT that it failed a threshold.
        echo "ERROR: $sha produced no report.json -- the capture did not finish." >&2
        echo "       This is not a zero result. Reason is in $out/capture-keep.log" >&2
        tail -20 "$out/capture-keep.log" >&2 || true
        git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1 || true
        return 3
      fi
      if ! cp "$wt/tests/perf/artifacts/report.json" "$out/report.json"; then
        echo "ERROR: could not copy $sha's report out of its worktree." >&2
        git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1 || true
        return 3
      fi
    fi
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

echo "baseline  $BASE"
if ! capture "$BASE" "$WORK/base"; then
  echo "ERROR: the BASELINE arm did not produce usable data. Nothing is comparable." >&2
  exit 3
fi
echo "feature   $HEAD_SHA"
if ! capture "$HEAD_SHA" "$WORK/feat"; then
  echo "ERROR: the FEATURE arm did not produce usable data. Nothing is comparable." >&2
  exit 3
fi

# DATA BEFORE PROVENANCE, and that order is the fix rather than a preference.
# The stamps below are written by `git rev-parse` AFTER the capture, whether or
# not the capture produced anything -- so on their own they certify "the right
# tree was CHECKED OUT", never "the right tree was MEASURED". An arm once
# printed `provenance OK` holding a HEAD.sha, a dirty.count and no report at
# all. **A provenance stamp beside no data is a stronger false comfort than no
# stamp**, because it answers the question a reader was about to ask.
for arm in base feat; do
  if [ ! -s "$WORK/$arm/report.json" ]; then
    echo "ERROR: the $arm arm has no report to be the provenance OF." >&2
    exit 3
  fi
  if ! python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get('shots') else 1)" \
       "$WORK/$arm/report.json"; then
    echo "ERROR: the $arm arm's report contains NO SHOTS. The run measured nothing." >&2
    exit 3
  fi
done

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
echo "data + provenance OK  base $(echo "$BASE_RAN" | cut -c1-7)  feat $(echo "$FEAT_RAN" | cut -c1-7)"

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
