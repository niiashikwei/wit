/**
 * Reads the project's git history into the store: every commit reachable from the main branch with
 * its files and line counts, which of them landed on main (its first-parent line), whether Claude
 * co-authored it, what it reverts, and the deploys the project's deploy rule (config.ts) makes of
 * them. Local only: it runs `git` (never a shell) and makes no network calls.
 */
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { globRe, type WitConfig } from "./config.ts";
import { stmt } from "./ingest.ts";
import { getMeta, setMeta } from "./store.ts";

export interface FileChange {
  path: string;
  added: number;
  deleted: number;
}
export interface Commit {
  sha: string;
  parents: string[];
  /** Committer time: when it reached the branch it is on. */
  at: number;
  /** Author time: when the change was written. */
  authoredAt: number;
  author: string;
  subject: string;
  body: string;
  files: FileChange[];
}

const RS = "\x1e";
const US = "\x1f";
export const LOG_FORMAT = `${RS}%H${US}%P${US}%ct${US}%at${US}%an${US}%s${US}%b${US}`;

/** `git … rev-parse`-style call in `root`; null when git fails (not a repo, unknown ref). */
export function git(root: string, args: string[], max = 256 * 1024 * 1024): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: max,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** A git command's output, or nothing when it fails. */
export const gitOut = (root: string, args: string[]) => git(root, args) ?? "";

/** A numstat path: "a => b" and "dir/{a => b}/c" renames become their new path. */
export function renamed(path: string): string {
  const brace = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/");
  const plain = path.match(/^(.*) => (.*)$/);
  return plain ? plain[2]! : path;
}

/** Parses `git log --numstat --format=LOG_FORMAT` output. */
export function parseLog(text: string): Commit[] {
  const out: Commit[] = [];
  for (const rec of text.split(RS)) {
    const f = rec.split(US);
    if (f.length < 8 || !/^[0-9a-f]{7,64}$/.test(f[0]!)) continue;
    const files: FileChange[] = [];
    for (const line of f[7]!.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) files.push({ path: renamed(m[3]!), added: m[1] === "-" ? 0 : +m[1]!, deleted: m[2] === "-" ? 0 : +m[2]! });
    }
    out.push({
      sha: f[0]!,
      parents: f[1]!.split(" ").filter(Boolean),
      at: +f[2]! * 1000,
      authoredAt: +f[3]! * 1000,
      author: f[4]!,
      subject: f[5]!,
      body: f[6]!.trim(),
      files,
    });
  }
  return out;
}

/** Whether Claude co-wrote a commit: a Co-Authored-By trailer naming Claude, or Claude Code's footer. */
export function isAI(body: string): boolean {
  return /^co-authored-by:.*\b(claude|anthropic)\b/im.test(body) || /generated with \[?claude code/i.test(body);
}

/** The commit a revert undoes ("This reverts commit <sha>."), or null. */
export function revertOf(subject: string, body: string): string | null {
  const m = body.match(/this reverts commit ([0-9a-f]{7,64})/i);
  if (m) return m[1]!;
  return /^revert\b/i.test(subject) ? "?" : null;
}

/** A commit that fixes something already shipped: a hotfix or a rollback. */
export const isHotfix = (subject: string) => /\b(hot-?fix|rollback|roll back|roll-back)\b/i.test(subject);

/** The main branch: the configured one, else the first of main, master, trunk that exists. */
export function mainBranch(root: string, cfg: Pick<WitConfig, "mainBranch">): string | null {
  for (const b of cfg.mainBranch ? [cfg.mainBranch] : ["main", "master", "trunk"])
    if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
  return null;
}

/**
 * When the work in a landed commit started: for a merge, the earliest author time among the
 * commits it brought in (walking its other parents until the main line); else its own author time.
 */
export function leadFrom(c: Commit, bySha: Map<string, Commit>, landed: Set<string>): number {
  if (c.parents.length < 2) return c.authoredAt;
  let first = c.authoredAt;
  const seen = new Set<string>();
  const stack = c.parents.slice(1);
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha) || landed.has(sha)) continue;
    seen.add(sha);
    const p = bySha.get(sha);
    if (!p) continue;
    first = Math.min(first, p.authoredAt);
    stack.push(...p.parents);
  }
  return first;
}

const MAX_COMMITS = "20000";

/**
 * Reads new commits on the main branch and refreshes git-made deploys. Returns how many commits
 * it read. Without git or a main branch it does nothing.
 */
export function ingestGit(db: DatabaseSync, root: string, cfg: WitConfig): number {
  const main = mainBranch(root, cfg);
  if (!main) return 0;
  // mainBranch checked the branch exists, so it has a head.
  const head = git(root, ["rev-parse", main])!.trim();
  const last = getMeta(db, "git:head");
  if (last === head) {
    if (getMeta(db, "git:deploy") !== cfg.deploy) {
      gitDeploys(db, root, cfg);
      setMeta(db, "git:deploy", cfg.deploy);
    }
    return 0;
  }
  // Read only what's new, unless history was rewritten (the old head is no longer an ancestor).
  const known = last && git(root, ["merge-base", "--is-ancestor", last, head]) !== null;
  const range = known ? `${last}..${head}` : head;
  const commits = parseLog(gitOut(root, ["log", "--numstat", `--max-count=${MAX_COMMITS}`, `--format=${LOG_FORMAT}`, range]));
  const landed = new Set(gitOut(root, ["rev-list", "--first-parent", `--max-count=${MAX_COMMITS}`, range]).split("\n").filter(Boolean));
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  db.exec("begin immediate");
  try {
    if (!known) {
      db.exec("delete from commits; delete from commit_files; delete from deploys where source = 'git'");
    }
    const put = stmt(db, `insert or replace into commits (sha, at, authored_at, author, subject, ai, is_merge, revert_of, landed, lead_from, added, deleted, files)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const putFile = stmt(db, "insert or replace into commit_files (sha, path, added, deleted) values (?, ?, ?, ?)");
    for (const c of commits) {
      const isLanded = landed.has(c.sha);
      put.run(
        c.sha, c.at, c.authoredAt, c.author, c.subject.slice(0, 200), isAI(c.body) ? 1 : 0,
        c.parents.length > 1 ? 1 : 0, revertOf(c.subject, c.body), isLanded ? 1 : 0,
        isLanded ? leadFrom(c, bySha, landed) : null,
        c.files.reduce((s, f) => s + f.added, 0), c.files.reduce((s, f) => s + f.deleted, 0), c.files.length,
      );
      for (const f of c.files) putFile.run(c.sha, f.path, f.added, f.deleted);
    }
    gitDeploys(db, root, cfg);
    setMeta(db, "git:head", head);
    setMeta(db, "git:deploy", cfg.deploy);
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
  return commits.length;
}

/** Remakes the deploys that come from git: each landed commit ("main") or matching tags ("tag:…"). */
export function gitDeploys(db: DatabaseSync, root: string, cfg: WitConfig): void {
  db.exec("delete from deploys where source = 'git'");
  const put = stmt(db, "insert or replace into deploys (id, at, source, sha, status, lead_ms) values (?, ?, 'git', ?, 'success', ?)");
  if (cfg.deploy === "main") {
    db.exec(`insert or replace into deploys (id, at, source, sha, status, lead_ms)
      select 'git:' || sha, at, 'git', sha, 'success', max(0, at - lead_from) from commits where landed = 1`);
    return;
  }
  if (!cfg.deploy.startsWith("tag:")) return;
  const re = globRe(cfg.deploy.slice(4));
  const tags = gitOut(root, ["for-each-ref", "refs/tags", `--format=%(refname:strip=2)${US}%(objectname)${US}%(*objectname)${US}%(creatordate:unix)`])
    .split("\n")
    .map((l) => l.split(US))
    .filter((f) => f.length === 4 && re.test(f[0]!))
    .map((f) => ({ name: f[0]!, sha: f[2] || f[1]!, at: +f[3]! * 1000 }))
    .sort((a, b) => a.at - b.at);
  let prev: string | null = null;
  for (const t of tags) {
    const shas = gitOut(root, ["rev-list", prev ? `${prev}..${t.sha}` : t.sha]).split("\n").filter(Boolean);
    const leads = shas
      .map((s) => (db.prepare("select authored_at from commits where sha = ?").get(s) as { authored_at: number } | undefined)?.authored_at)
      .filter((a): a is number => typeof a === "number")
      .map((a) => Math.max(0, t.at - a))
      .sort((a, b) => a - b);
    put.run(`tag:${t.name}`, t.at, t.sha, leads.length ? leads[Math.floor((leads.length - 1) / 2)]! : null);
    prev = t.sha;
  }
}
