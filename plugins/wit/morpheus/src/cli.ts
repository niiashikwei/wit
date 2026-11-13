#!/usr/bin/env node
/**
 * morpheus: a live dashboard of how a project's Claude Code hooks, skills, agents and tokens are
 * running. Works for any project in any language: it reads Claude Code's own files.
 *
 *   morpheus [serve] [--port 4673] [--project <dir>] [--open]   the dashboard at http://localhost:4673
 *   morpheus mcp [--project <dir>]                               the MCP server (stdio)
 *   morpheus report [--range 7d] [--project <dir>]               a text summary
 *   morpheus init [--dry-run | --undo] [--project <dir>]         time every hook run
 *   morpheus ingest [--project <dir>]                            read new transcripts now
 *   morpheus projects                                            projects with transcripts
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { answer, project, refresh } from "./api.ts";
import { init } from "./init.ts";
import { serveMcp, VERSION } from "./mcp.ts";
import { listProjects, projectRoot } from "./paths.ts";
import { serveWeb } from "./server.ts";

const HELP = `morpheus ${VERSION}: a live dashboard of your Claude Code hooks, skills, agents and tokens

Usage:
  morpheus [serve] [--port 4673] [--project <dir>] [--open]
  morpheus mcp [--project <dir>]
  morpheus report [--range 1h|today|7d|30d|all] [--project <dir>]
  morpheus init [--dry-run | --undo] [--project <dir>]
  morpheus ingest [--project <dir>]
  morpheus projects

The project defaults to the git repository you're in (its main checkout), else this folder.`;

export function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--") && ["port", "project", "range"].includes(k))
      flags[k] = argv[++i]!;
    else flags[k] = true;
  }
  return { cmd: rest[0] ?? "serve", flags };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : String(n);

/** A plain-text summary: the headline numbers, where the tokens went, the top improvements. */
export function report(root: string, range = "7d"): string {
  const o = answer("morpheus_overview", { range }, { root }) as any;
  const t = answer("morpheus_tokens", { range }, { root }) as any;
  const k = o.kpis;
  const lines = [
    `Morpheus: ${root} (${range})`,
    "",
    `Sessions ${k.sessions} · hook runs ${num(k.hookRuns)} (p95 ${k.hookP95 ?? "–"} ms) · blocks ${k.blocks} · skill loads ${k.skillLoads} · agent runs ${k.agentRuns}`,
    `Hints followed ${k.hints ? pct(k.hintsConverted / k.hints) : "–"} (${k.hintsConverted}/${k.hints})`,
    `Tokens: work ${pct(t.shares.work)} · orchestration ${pct(t.shares.orchestration)} · replies ${pct(t.shares.replies)} of ${num(t.totals.work.new + t.totals.orchestration.new + t.totals.replies.new)} new`,
    "",
    "Next improvements:",
    ...o.improvements
      .slice(0, 10)
      .map((i: any, n: number) => `${n + 1}. ${i.title} (ROI ${i.roi})\n   ${i.evidence}\n   → ${i.how}`),
  ];
  if (!o.improvements.length) lines.push("   None: nothing in the numbers needs attention.");
  return lines.join("\n");
}

/* node:coverage disable */
// Starts the OS browser: tests pass their own `open` rather than launch one.
function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}
/* node:coverage enable */

/** Where the CLI writes and what it starts; tests pass their own. */
export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Progress notes, on stderr so stdout stays clean. */
  status: (text: string) => void;
  open: (url: string) => void;
  exit: (code: number) => void;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const defaultIo = (): Io => ({
  log: console.log.bind(console),
  error: console.error.bind(console),
  status: process.stderr.write.bind(process.stderr),
  open: openBrowser,
  exit: (code) => {
    process.exitCode = code;
  },
  input: process.stdin,
  output: process.stdout,
});

/** Runs one command. `serve` resolves to the web server, once it's listening. */
export async function main(argv = process.argv.slice(2), io: Partial<Io> = {}) {
  const { log, error, status, open, exit, input, output } = { ...defaultIo(), ...io };
  const { cmd, flags } = parseArgs(argv);
  if (flags.version) return log(VERSION);
  if (flags.help || cmd === "help") return log(HELP);
  const root = projectRoot(
    typeof flags.project === "string" ? flags.project : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd()),
  );
  switch (cmd) {
    case "serve": {
      const port = Number(flags.port ?? process.env.MORPHEUS_PORT ?? 4673);
      const p = project(root);
      const t = Date.now();
      status(`Reading ${root}'s transcripts…\n`);
      const n = refresh(p, 0);
      status(`Read ${n} lines in ${Date.now() - t} ms\n`);
      const server = await serveWeb({ root, port });
      const url = `http://localhost:${port}/`;
      log(`Morpheus is live at ${url} (Ctrl+C to stop)`);
      if (flags.open) open(url);
      return server;
    }
    case "mcp":
      return serveMcp(root, input, output);
    case "report":
      return log(report(root, typeof flags.range === "string" ? flags.range : "7d"));
    case "ingest": {
      const t = Date.now();
      const n = refresh(project(root), 0);
      return log(`Read ${n} new lines in ${Date.now() - t} ms`);
    }
    case "projects":
      for (const p of listProjects())
        log(`${new Date(p.lastAt).toISOString().slice(0, 10)}  ${String(p.sessions).padStart(5)} sessions  ${p.root}`);
      return;
    case "init":
      for (const line of init(root, {
        undo: !!flags.undo,
        dryRun: !!flags["dry-run"],
        timer: join(import.meta.dirname, "..", "hooks", "morpheus-time.sh"),
      }))
        log(line);
      return;
    default:
      error(`Unknown command ${cmd}\n\n${HELP}`);
      exit(2);
  }
}

// Runs only when started as a program, never when a test imports it.
/* node:coverage ignore next */
if (import.meta.main) main();
