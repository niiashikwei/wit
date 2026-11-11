/**
 * Where things live: the project being watched, Claude Code's transcript folders for it, the
 * optional hook logs, and Morpheus's own store. Nothing here is specific to one project.
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Claude Code's home: ~/.claude, or CLAUDE_CONFIG_DIR when set. */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/** Claude Code's transcripts, one folder per project path. */
export const projectsBase = () => join(claudeHome(), "projects");

/** Claude Code names a project's transcript folder after its path, with every other character a dash. */
export const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

/** git's shared folder for a checkout (the same for all its worktrees), or null outside git. */
export function gitCommonDir(from: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: from,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The project to watch: MORPHEUS_PROJECT, else the main checkout of the git repo `from` is in (so a
 * worktree counts as its repo), else `from` itself.
 */
export function projectRoot(from = process.cwd()): string {
  if (process.env.MORPHEUS_PROJECT) return resolve(process.env.MORPHEUS_PROJECT);
  const common = gitCommonDir(from);
  if (common && common.endsWith(".git")) return dirname(common);
  return resolve(from);
}

/** The transcript folders for a project and each of its worktrees (their paths start with it). */
export function projectDirs(root: string, base = projectsBase()): string[] {
  const prefix = slug(root);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => d === prefix || d.startsWith(`${prefix}-`))
    .map((d) => join(base, d));
}

/**
 * Folders that may hold hook logs (runs.jsonl, events.jsonl): `<git dir>/morpheus` (written by
 * hooks/morpheus-time.sh) and `<git dir>/claude-process` (an earlier layout), both shared by
 * every worktree. Outside git, `<project>/.claude/morpheus`.
 */
export function logDirs(root: string): string[] {
  const common = gitCommonDir(root);
  const dirs = common
    ? [join(common, "morpheus"), join(common, "claude-process")]
    : [join(root, ".claude", "morpheus")];
  return dirs.filter((d) => existsSync(d));
}

/** Morpheus's own data: MORPHEUS_HOME, else the platform's app-data folder. */
export function dataDir(): string {
  if (process.env.MORPHEUS_HOME) return process.env.MORPHEUS_HOME;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "morpheus");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "morpheus");
}

/** One store per project, so projects never mix and each can be deleted on its own. */
export const dbPath = (root: string) => process.env.MORPHEUS_DB ?? join(dataDir(), `${slug(root)}.db`);

/** The first `cwd` written in a transcript folder's newest file: the real path its slug came from. */
function cwdOf(dir: string): { cwd: string; at: number } | null {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f, t } of files.slice(0, 3)) {
    const fd = openSync(join(dir, f), "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const m = buf.toString("utf8", 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return { cwd: JSON.parse(`"${m[1]}"`), at: t };
    } finally {
      closeSync(fd);
    }
  }
  return null;
}

/**
 * Every project Claude Code has transcripts for, newest first: its path, how many session files it
 * has and when it was last used. Worktrees under `.claude/worktrees/` count as their project.
 */
export function listProjects(base = projectsBase()) {
  if (!existsSync(base)) return [];
  const by = new Map<string, { root: string; sessions: number; lastAt: number }>();
  for (const d of readdirSync(base)) {
    const dir = join(base, d);
    if (!statSync(dir).isDirectory()) continue;
    const seen = cwdOf(dir);
    if (!seen) continue;
    const root = seen.cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, "");
    const sessions = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    const p = by.get(root) ?? { root, sessions: 0, lastAt: 0 };
    p.sessions += sessions;
    p.lastAt = Math.max(p.lastAt, seen.at);
    by.set(root, p);
  }
  return [...by.values()].sort((a, b) => b.lastAt - a.lastAt);
}
