/**
 * Rank measurement claims in docblocks by how likely they are to be STALE.
 *
 * **Why ranking rather than listing.** `src/render/webgpu/` carries ~213 claims
 * of the form "measured", "MEASURED" or "verified" across 138 files. Checking
 * every one against its commit is not the job; finding the ones that have
 * rotted is. Tonight produced five stale plan premises and two stale
 * RETRACTIONS, and the retractions were the expensive ones: `AirfieldLighting`
 * asserted a depth-test rejection that had been withdrawn, and four commits
 * touched the file afterwards without the withdrawal reaching it. A session
 * built mounting offsets to defeat a test that did not exist.
 *
 * **So the risk signal is churn since the claim was written.** A claim made at
 * the same commit as the code it describes is probably still true. A claim that
 * has survived twenty commits to its own file has had twenty chances to stop
 * being true, and nothing re-checks it.
 *
 * Emits a ranked table; the classification into SUPPORTED / WITHDRAWN /
 * UNVERIFIABLE is done by reading, not by this script. It only says where to
 * look first.
 *
 *   npx tsx scripts/docblock-truth-sweep.mts [limit]
 */
import { execFileSync } from "node:child_process";

const ROOT = "src/render/webgpu";
const PATTERNS = ["measured", "MEASURED", "verified", "VERIFIED"];
const LIMIT = Number(process.argv[2] ?? 25);

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

interface Claim {
  file: string;
  line: number;
  text: string;
  claimCommit: string;
  claimDate: string;
  commitsSince: number;
}

// Every claim line, with its blame commit.
const hits = git(["grep", "-n", "-E", PATTERNS.join("|"), "--", `${ROOT}/**/*.ts`])
  .split("\n")
  .filter(Boolean);

const byFile = new Map<string, Array<{ line: number; text: string }>>();
for (const hit of hits) {
  const m = /^([^:]+):(\d+):(.*)$/.exec(hit);
  if (!m) continue;
  const [, file, line, text] = m;
  // Docblock/comment lines only: a claim in code is not a claim about the world.
  if (!/^\s*(\*|\/\/)/.test(text!)) continue;
  const list = byFile.get(file!) ?? [];
  list.push({ line: Number(line), text: text!.trim() });
  byFile.set(file!, list);
}

const claims: Claim[] = [];
for (const [file, lines] of byFile) {
  // How many commits have touched this file at all?
  const fileCommits = git(["log", "--format=%H", "--", file]).split("\n").filter(Boolean);
  const blame = git(["blame", "--line-porcelain", "--", file]);
  // Map line number -> commit sha, from porcelain blame.
  const shaByLine = new Map<number, { sha: string; date: string }>();
  let currentSha = "";
  let currentDate = "";
  let pendingLine = 0;
  for (const raw of blame.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(raw);
    if (header) { currentSha = header[1]!; pendingLine = Number(header[2]); continue; }
    const t = /^author-time (\d+)/.exec(raw);
    if (t) currentDate = new Date(Number(t[1]) * 1000).toISOString().slice(0, 10);
    if (raw.startsWith("\t") && pendingLine) {
      shaByLine.set(pendingLine, { sha: currentSha, date: currentDate });
      pendingLine = 0;
    }
  }
  for (const { line, text } of lines) {
    const info = shaByLine.get(line);
    if (!info) continue;
    const idx = fileCommits.indexOf(info.sha);
    // Commits to this file AFTER the one that wrote the claim.
    const since = idx === -1 ? -1 : idx;
    claims.push({
      file, line, text: text.slice(0, 96),
      claimCommit: info.sha.slice(0, 7), claimDate: info.date, commitsSince: since,
    });
  }
}

claims.sort((a, b) => b.commitsSince - a.commitsSince);
console.log(`${claims.length} comment-borne claims in ${byFile.size} files\n`);
console.log("commits-since  date        file:line  claim");
for (const c of claims.slice(0, LIMIT)) {
  console.log(
    `${String(c.commitsSince).padStart(9)}      ${c.claimDate}  `
    + `${c.file.replace(`${ROOT}/`, "")}:${c.line}\n               ${c.text}`,
  );
}
const unverifiable = claims.filter((c) => c.commitsSince === -1).length;
console.log(`\n${unverifiable} claims whose blame commit is not in the file's history (rebased or squashed)`);
