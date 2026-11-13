/** Helpers for the SDLC tests: throwaway git repositories with commits at chosen times. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export function tmp(prefix = "wit-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export class Repo {
  root: string;
  constructor(branch = "main") {
    this.root = tmp("wit-repo-");
    this.git("init", "-q", "-b", branch);
    this.git("config", "user.email", "dev@example.com");
    this.git("config", "user.name", "Dev");
    this.git("config", "commit.gpgsign", "false");
    this.git("config", "tag.gpgsign", "false");
  }
  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8", env: { ...process.env, ...this.env } });
  }
  env: Record<string, string> = {};
  write(path: string, text: string) {
    const full = join(this.root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  /** Commits the given files at `at` (committer) and `authored` (author) times. */
  commit(message: string, files: Record<string, string>, at: number, authored = at): string {
    for (const [p, t] of Object.entries(files)) this.write(p, t);
    this.git("add", "-A");
    this.env = { GIT_AUTHOR_DATE: `@${Math.round(authored / 1000)} +0000`, GIT_COMMITTER_DATE: `@${Math.round(at / 1000)} +0000` };
    this.git("commit", "-q", "--allow-empty", "-m", message);
    this.env = {};
    return this.git("rev-parse", "HEAD").trim();
  }
  merge(branch: string, message: string, at: number): string {
    this.env = { GIT_AUTHOR_DATE: `@${Math.round(at / 1000)} +0000`, GIT_COMMITTER_DATE: `@${Math.round(at / 1000)} +0000` };
    this.git("merge", "-q", "--no-ff", "-m", message, branch);
    this.env = {};
    return this.git("rev-parse", "HEAD").trim();
  }
  tag(name: string, at: number, annotated = false) {
    this.env = { GIT_COMMITTER_DATE: `@${Math.round(at / 1000)} +0000` };
    if (annotated) this.git("tag", "-a", name, "-m", name);
    else this.git("tag", name);
    this.env = {};
  }
}

export const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";
