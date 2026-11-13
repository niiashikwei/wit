import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { answer, project, refresh, scopeOf, TOOLS } from "../src/api.ts";
import { type Inputs, rank } from "../src/improvements.ts";
import { apply, ingest, readNew } from "../src/ingest.ts";
import { init, rewrite, wrappable } from "../src/init.ts";
import { inventory } from "../src/inventory.ts";
import { handle } from "../src/mcp.ts";
import {
  hintedSkills,
  item,
  items,
  live,
  overrideName,
  overview,
  since,
  timeline,
  tokens,
} from "../src/metrics.ts";
import { describeInput, parseEventLine, parseHookRunLine, parseTranscriptLine, type Run } from "../src/parse.ts";
import { dataDir, dbPath, listProjects, logDirs, projectDirs, projectRoot, slug } from "../src/paths.ts";
import { openStore } from "../src/store.ts";

const ENV = ["MORPHEUS_HOME", "MORPHEUS_DB", "MORPHEUS_PROJECT", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "morpheus-core-")));
const home = join(tmp, "claude");

before(() => {
  process.env.MORPHEUS_HOME = join(tmp, "data");
  process.env.MORPHEUS_DB = ":memory:";
  process.env.CLAUDE_CONFIG_DIR = home;
  delete process.env.MORPHEUS_PROJECT;
});

after(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const iso = (t: number) => new Date(t).toISOString();
const dir = (name: string) => {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

/** A transcript line for session s, `ago` ms before NOW. */
const line = (extra: Record<string, unknown>, ago = 1000) =>
  JSON.stringify({ sessionId: "s", timestamp: iso(NOW - ago), uuid: "u1", ...extra });

const R = (o: Partial<Run> & { id: string }): Run => ({
  kind: "hook",
  name: "x",
  detail: null,
  session: "s1",
  branch: "main",
  cwd: null,
  startedAt: NOW - 60_000,
  durationMs: null,
  outcome: "ok",
  toolUseId: null,
  trigger: null,
  output: null,
  ...o,
});
const put = (db: DatabaseSync, ...runs: Run[]) =>
  apply(db, { runs, results: [], prompts: [], usage: [], lastText: null, at: null });

// ---------------------------------------------------------------- parse

// @req R23
test("transcript lines that can't hold a record are skipped: not objects, no time, no session, a stray agent line", () => {
  for (const l of ["null", "5", "{", line({ timestamp: "never" }), line({ timestamp: undefined }), line({ sessionId: "" })])
    assert.equal(parseTranscriptLine(l).at, null, l);
  const side = line({ isSidechain: true, type: "user", message: { content: "hi" } });
  assert.equal(parseTranscriptLine(side).at, null, "an agent's line in the session's file is the agent's");
  assert.equal(parseTranscriptLine(side, { agent: "a1" }).at, NOW - 1000);
  const compact = parseTranscriptLine(line({ type: "system", subtype: "compact_boundary" }));
  assert.deepEqual(compact.marks, [{ session: "s", at: NOW - 1000, type: "compact" }]);
});

// @req R23 R28
test("tool calls without names or inputs still become runs, and a reply without ids keys its tokens by time", () => {
  const p = parseTranscriptLine(
    line({
      uuid: undefined,
      type: "assistant",
      message: {
        usage: {},
        content: [
          { type: "tool_use", id: "t1", name: "Read" },
          { type: "tool_use", id: "t2", name: "Skill", input: {} },
          { type: "tool_use", id: "t3", name: "Agent", input: {} },
          { type: "tool_use", id: "t4", name: "Skill", input: { skill: "ship", args: "--fast" } },
        ],
      },
    }),
  );
  assert.deepEqual(
    p.runs.map((r) => [r.kind, r.name, r.trigger]),
    [
      ["tool", "Read", "Read"],
      ["skill", "skill", "Skill"],
      ["agent", "general-purpose", null],
      ["skill", "ship", "ship --fast"],
    ],
  );
  assert.equal(p.usage[0]!.messageId, String(NOW - 1000));
  assert.deepEqual([p.usage[0]!.tokensIn, p.usage[0]!.tokensOut, p.usage[0]!.tokensCached, p.usage[0]!.tokensWrite], [0, 0, 0, 0]);
  const byUuid = parseTranscriptLine(line({ type: "assistant", message: { usage: { input_tokens: 1 }, content: [] } }));
  assert.equal(byUuid.usage[0]!.messageId, "u1");
  assert.equal(describeInput("Glob"), "Glob");
});

// @req R23
test("a prompt is what the person typed: not a meta line or a harness tag; an interrupt is marked", () => {
  assert.deepEqual(parseTranscriptLine(line({ type: "user", isMeta: true, message: { content: "skill text" } })).prompts, []);
  assert.deepEqual(parseTranscriptLine(line({ type: "user", message: { content: "<command-name>/x</command-name>" } })).prompts, []);
  const stop = parseTranscriptLine(line({ type: "user", message: { content: "[Request interrupted by user]" } }));
  assert.equal(stop.prompts.length, 1);
  assert.deepEqual(stop.marks, [{ session: "s", at: NOW - 1000, type: "interrupt" }]);
});

// @req R24
test("hook log lines without a time, script, duration, hook or type are skipped; the rest fill in defaults", () => {
  const ts = iso(NOW);
  for (const l of ["{", "null", JSON.stringify({ ts: "x", hook: "h", type: "block" }), JSON.stringify({ ts, type: "block" }), JSON.stringify({ ts, hook: "h" })])
    assert.equal(parseEventLine(l), null, l);
  assert.deepEqual(parseEventLine(JSON.stringify({ ts, hook: "h", type: "warn", branch: "" })), {
    ts: NOW,
    hook: "h",
    type: "warn",
    branch: null,
    detail: null,
  });
  for (const l of ["{", "null", JSON.stringify({ ts, ms: 5 }), JSON.stringify({ ts, script: "g", ms: "5" })])
    assert.equal(parseHookRunLine(l), null, l);
  const bare = parseHookRunLine(JSON.stringify({ ts, script: "g", ms: 5 }))!;
  assert.equal(bare.id, `hook:-:hook:g:${NOW}`);
  assert.deepEqual([bare.detail, bare.session, bare.outcome, bare.rule, bare.toolUseId], ["hook", "", "ok", null, null]);
  const stop = parseHookRunLine(JSON.stringify({ ts, script: "g", ms: 5, event: "Stop", exit: 1, session: "s" }))!;
  assert.deepEqual([stop.id, stop.detail, stop.outcome], [`hook:s:Stop:g:${NOW}`, "Stop", "error"]);
});

// ---------------------------------------------------------------- ingest

// @req R23
test("a file cut short while it's being read stops the read where the file ends", () => {
  const db = openStore(":memory:");
  const f = join(dir("cut"), "t.jsonl");
  writeFileSync(f, "a\nb\nc\n");
  const seen: string[] = [];
  const n = readNew(db, f, (l) => {
    seen.push(l);
    writeFileSync(f, "");
  }, 2);
  assert.deepEqual(seen, ["a"]);
  assert.equal(n, 1);
});

// @req R23
test("an agent's plain lines still time it; an agent without its meta file is read without one", () => {
  const root = dir("agents-repo");
  const projects = dir("agents-projects");
  const proj = join(projects, slug(root));
  mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
  writeFileSync(join(proj, "s1.jsonl"), "");
  const at = (s: number) => iso(NOW - 600_000 + s * 1000);
  writeFileSync(
    join(proj, "s1", "subagents", "agent-a1.jsonl"),
    jsonl([
      { sessionId: "s1", timestamp: at(0), isSidechain: true, type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
      { noTime: true },
      { sessionId: "s1", timestamp: at(30), isSidechain: true, type: "assistant", message: { content: [{ type: "text", text: "VERDICT: pass" }] } },
    ]),
  );
  writeFileSync(join(proj, "s1", "subagents", "agent-a2.jsonl"), jsonl([{ sessionId: "s1", timestamp: at(5), type: "assistant", message: { content: [] } }]));
  writeFileSync(join(proj, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ description: "d" }));
  const db = openStore(":memory:");
  assert.equal(ingest(db, { root, projectsDir: projects, logDirs: [] }), 4);
  const a1 = db.prepare("select * from agents where agent_id = 'a1'").get() as Record<string, unknown>;
  assert.deepEqual([a1.active_ms, a1.verdict, a1.agent_type, a1.finished], [30_000, "pass", null, 0]);
  const a2 = db.prepare("select * from agents where agent_id = 'a2'").get() as Record<string, unknown>;
  assert.equal(a2.agent_type, null, "no meta: the agent is known by its transcript alone");
});

// @req R23
test("apply stores marks when a line has them and a reply's cache writes default to none", () => {
  const db = openStore(":memory:");
  apply(db, {
    runs: [],
    results: [],
    prompts: [],
    usage: [{ messageId: "m", session: "s", branch: null, tokensIn: 1, tokensOut: 2, tokensCached: 3, model: null, work: 0, orchestration: 0, text: 1 }],
    lastText: null,
    at: NOW,
    marks: [{ session: "s", at: NOW, type: "denied" }],
  });
  assert.deepEqual(db.prepare("select type from marks").all().map((r) => ({ ...r })), [{ type: "denied" }]);
  assert.equal((db.prepare("select tokens_write as w from usage").get() as { w: number }).w, 0);
});

// ---------------------------------------------------------------- paths and store

// @req R23 R30
test("paths: MORPHEUS_PROJECT wins, a missing transcripts folder has no dirs, and git keeps hook logs in its own folder", () => {
  process.env.MORPHEUS_PROJECT = "relative/proj";
  assert.equal(projectRoot("/anywhere"), join(process.cwd(), "relative", "proj"));
  delete process.env.MORPHEUS_PROJECT;
  assert.deepEqual(projectDirs("/x", join(tmp, "no-such")), []);
  const repo = dir("git-logs");
  execFileSync("git", ["init", "-q", repo]);
  assert.deepEqual(logDirs(repo), []);
  mkdirSync(join(repo, ".git", "morpheus"));
  assert.deepEqual(logDirs(repo), [join(repo, ".git", "morpheus")]);
});

// @req R30
test("the store lives in MORPHEUS_HOME, else the platform's app-data folder, one file per project", () => {
  assert.equal(dataDir(), join(tmp, "data"));
  delete process.env.MORPHEUS_HOME;
  try {
    assert.equal(dataDir("darwin"), join(homedir(), "Library", "Application Support", "morpheus"));
    process.env.XDG_DATA_HOME = "/xdg";
    assert.equal(dataDir("linux"), join("/xdg", "morpheus"));
    delete process.env.XDG_DATA_HOME;
    assert.equal(dataDir("linux"), join(homedir(), ".local", "share", "morpheus"));
    delete process.env.MORPHEUS_DB;
    assert.equal(dbPath("/a/b"), join(dataDir(), "-a-b.db"));
  } finally {
    process.env.MORPHEUS_HOME = join(tmp, "data");
    process.env.MORPHEUS_DB = ":memory:";
  }
});

// @req R26 R33
test("projects come from each transcript folder's cwd; folders without one, and plain files, are skipped", () => {
  assert.deepEqual(listProjects(join(tmp, "no-such")), []);
  const base = dir("list-base");
  writeFileSync(join(base, "stray.txt"), "x");
  mkdirSync(join(base, "no-cwd"));
  writeFileSync(join(base, "no-cwd", "a.jsonl"), '{"type":"user"}\n');
  mkdirSync(join(base, "empty"));
  mkdirSync(join(base, "repo"));
  writeFileSync(join(base, "repo", "a.jsonl"), `${JSON.stringify({ cwd: "/r" })}\n`);
  writeFileSync(join(base, "repo", "b.jsonl"), `${JSON.stringify({ cwd: "/r" })}\n`);
  mkdirSync(join(base, "tree"));
  writeFileSync(join(base, "tree", "c.jsonl"), `${JSON.stringify({ cwd: "/r/.claude/worktrees/w1/sub" })}\n`);
  const list = listProjects(base);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.root, "/r");
  assert.equal(list[0]!.sessions, 3, "a worktree's sessions count as its repo's");
});

// @req R30
test("a store file is private, kept across opens, and rebuilt when its tables are from another version", () => {
  const f = join(tmp, "store", "p.db");
  let db = openStore(f);
  db.exec("insert into meta (key, value) values ('k', 'v')");
  db.close();
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(join(tmp, "store")).mode & 0o777, 0o700);
  db = openStore(f);
  assert.equal(db.prepare("select count(*) as n from meta").get()!.n, 1, "kept");
  db.exec("pragma user_version = 1");
  db.close();
  db = openStore(f);
  assert.equal(db.prepare("select count(*) as n from meta").get()!.n, 0, "an older store is read again from scratch");
  db.close();
  // A store that isn't a file (an SQLite URI) has no files to protect.
  const cwd = process.cwd();
  process.chdir(dir("uri"));
  try {
    const mem = openStore("file:morpheus?mode=memory");
    assert.equal(mem.prepare("pragma user_version").get()!.user_version, 2);
    assert.equal(existsSync("file:morpheus?mode=memory"), false);
  } finally {
    process.chdir(cwd);
  }
});

// ---------------------------------------------------------------- inventory and init

// @req R26
test("installed plugins come from installed_plugins.json, once per name; rules from process.json", () => {
  const root = dir("inv-root");
  const h = dir("inv-home");
  const plugin = (path: string, name?: string) => {
    mkdirSync(join(path, ".claude-plugin"), { recursive: true });
    writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify(name ? { name } : {}));
    mkdirSync(join(path, "agents"), { recursive: true });
    writeFileSync(join(path, "agents", "helper.md"), "x");
    return path;
  };
  const a = plugin(join(h, "store", "acme"), "acme");
  const b = plugin(join(h, "store", "beta"));
  const a2 = plugin(join(h, "store", "acme-copy"), "acme");
  mkdirSync(join(h, "plugins"), { recursive: true });
  writeFileSync(
    join(h, "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "acme@m": [{ installPath: a }, { installPath: a2 }], "beta@m": { installPath: b }, "gone@m": [{ installPath: "/nope" }, null] } }),
  );
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "process.json"),
    JSON.stringify({ _note: "x", branchGuard: "block", stackReset: { mode: "warn" }, other: {} }),
  );
  const d = inventory(root, h);
  assert.deepEqual(d.agents.sort(), ["acme:helper", "beta:helper"]);
  assert.deepEqual(d.rules, { "branch-guard": "block", "stack-reset": "warn", other: "block" });
  // A list naming no installed plugin, or no list at all: what's under cache/.
  const h2 = dir("inv-home2");
  plugin(join(h2, "plugins", "cache", "m", "tools", "1.0"), "tools");
  writeFileSync(join(h2, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "x@m": [{ installPath: "/nope" }] } }));
  assert.deepEqual(inventory(root, h2).agents, ["tools:helper"]);
  writeFileSync(join(h2, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: 5 }));
  assert.deepEqual(inventory(root, h2).agents, ["tools:helper"]);
});

// @req R32
test("init leaves already-timed commands, substitutions and the timer itself alone, and says when there's nothing to do", () => {
  assert.equal(wrappable('bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/morpheus-time.sh x.sh'), false);
  assert.equal(wrappable("bash x.sh $(date)"), false);
  assert.equal(wrappable("bash hooks/morpheus-time.sh"), false);
  assert.equal(wrappable("bash 'a|b' x.sh"), true);
  assert.equal(rewrite({ hooks: { Stop: "x", Pre: [null, { hooks: "y" }, { hooks: [null, { command: 1 }] }] } }).changed, 0);
  assert.equal(rewrite({}).changed, 0);
  const root = dir("init-root");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "a | b" }] }] } }));
  const timer = join(import.meta.dirname, "..", "hooks", "morpheus-time.sh");
  assert.deepEqual(init(root, { undo: true, timer }), [
    "settings.local.json: nothing to restore",
    "Restart Claude Code sessions in this project: hooks load when a session starts.",
  ]);
  assert.deepEqual(init(root, { dryRun: true, timer }), [
    "Left as is (shell operators): a | b",
    "settings.local.json: nothing to wrap",
  ]);
  assert.equal(existsSync(join(root, ".claude", "settings.local.json.morpheus-bak")), false);
});

// @req R29
test("MCP: a ping, and requests with a null id get answers with a null id", () => {
  const call = () => ({});
  assert.deepEqual(handle({ jsonrpc: "2.0", id: 3, method: "ping" }, { call }), { jsonrpc: "2.0", id: 3, result: {} });
  assert.deepEqual(handle({ jsonrpc: "2.0", id: null, method: "ping" }, { call }), { jsonrpc: "2.0", id: null, result: {} });
  assert.deepEqual(handle({ jsonrpc: "2.0", id: null, method: "nope" }, { call }), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32601, message: "Unknown method nope" },
  });
});

// ---------------------------------------------------------------- metrics

/** A store with two sessions' hooks, rules, skills, agents, tools and replies. */
function store() {
  const db = openStore(":memory:");
  const m = (s: number) => NOW - s * 1000;
  put(
    db,
    R({ id: "h1", name: "guard", detail: "PreToolUse:Bash", durationMs: 100, startedAt: m(50), chars: 400 }),
    R({ id: "h2", name: "guard", detail: "PreToolUse:Bash", durationMs: 200, startedAt: m(40), chars: 800 }),
    R({ id: "h3", name: "guard", detail: "Stop", durationMs: 50, startedAt: m(30) }),
    R({ id: "h4", name: "fmt", detail: "PostToolUse", durationMs: 20, startedAt: m(20), chars: 40 }),
    R({ id: "h5", name: "guard", detail: "PreToolUse:Bash", outcome: "block", rule: "branch-guard", toolUseId: "tb", startedAt: m(45) }),
    R({ id: "k1", kind: "skill", name: "ship", session: "s1", startedAt: m(500), trigger: "ship" }),
    R({ id: "k2", kind: "skill", name: "ship", session: "s2", startedAt: m(400) }),
    R({ id: "k3", kind: "skill", name: "tdd", session: "s1", startedAt: m(450), trigger: "tdd" }),
    R({ id: "g1", kind: "agent", name: "reviewer", session: "s1", startedAt: m(100), outcome: "running" }),
    R({ id: "g2", kind: "agent", name: "reviewer", session: "s2", startedAt: m(200), outcome: "running" }),
    R({ id: "g3", kind: "agent", name: "reviewer", session: "s1", startedAt: m(300), outcome: "running" }),
    R({ id: "g4", kind: "agent", name: "helper", session: "s1", startedAt: m(350), durationMs: 1000 }),
    R({ id: "g5", kind: "agent", name: "helper", session: "s1", startedAt: m(360), trigger: "do it" }),
    R({ id: "t1", kind: "tool", name: "Bash", session: "s1", startedAt: m(10), outcome: "running", trigger: "make" }),
    R({ id: "t2", kind: "tool", name: "Read", session: "s2", startedAt: m(15) }),
    R({ id: "h6", name: "fmt", detail: "PostToolUse", session: "s3", startedAt: m(590) }),
  );
  for (const [run, agent] of [["g1", "a1"], ["g3", "a3"], ["g4", "a4"]]) db.prepare("update runs set agent_id = ? where id = ?").run(agent!, run!);
  const agent = db.prepare(
    "insert into agents (agent_id, session, agent_type, first_at, last_at, active_ms, finished, verdict, tokens_in, tokens_out) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  agent.run("a1", "s1", "reviewer", m(100), m(60), null, 0, null, 10, 5);
  agent.run("a3", "s1", "reviewer", m(300), null, 5000, 1, "approve", 1, 1);
  agent.run("a4", "s1", "helper", null, null, 0, 1, null, 0, 0);
  agent.run("a6", "s1", null, null, null, 0, 1, null, 0, 0);
  const ev = db.prepare("insert into events (ts, hook, type, branch, detail) values (?, ?, ?, ?, ?)");
  ev.run(m(30), "branch-guard", "block", "main", "push");
  ev.run(m(35), "branch-guard", "block", "main", "push again");
  ev.run(m(25), "branch-guard", "override", "dev", "SKIP_X: push");
  ev.run(m(20), "other", "warn", "main", "");
  const use = db.prepare("insert into usage (session, message_id, agent_id, branch, at, tokens_in, tokens_out, text) values (?, ?, ?, ?, ?, ?, ?, 1)");
  use.run("s1", "u1", null, "main", NOW - 3 * 86_400_000, 100, 10);
  use.run("s1/agent-a6", "u2", "a6", null, NOW - 1000, 50, 5);
  db.prepare("insert into prompts (session, at, text) values ('s2', ?, 'hello')").run(m(500));
  return db;
}

// @req R25
test("the helpers: today starts at local midnight; no hint text names no skill; an override without a name keeps its rule's", () => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  assert.equal(since("today", NOW), d.getTime());
  assert.equal(since("all", NOW), 0);
  assert.deepEqual(hintedSkills(null), []);
  assert.equal(overrideName(null, "rule"), "rule");
});

// @req R25
test("live: each active session with its prompt and what it's running, or none", () => {
  const l = live(store(), NOW);
  const by = Object.fromEntries(l.sessions.map((s) => [s.session, s]));
  assert.equal(by.s1!.prompt, null);
  assert.equal(by.s1!.current.name, "Bash");
  assert.equal(by.s2!.prompt, "hello");
  assert.equal(by.s2!.current.name, "reviewer");
  assert.equal(by.s3!.current, null, "a session running nothing");
  assert.equal(by.s1!.agents.length, 1, "the running reviewer");
});

// @req R25
test("agents: a running agent's time runs to now, one without a transcript has no time or tokens", () => {
  const db = store();
  const o = overview(db, { range: "7d" }, NOW);
  assert.equal(o.kpis.agentRuns, 5);
  assert.equal(o.kpis.agentTokens, 17);
  const reviewer = (items(db, "agent", { range: "7d" }, NOW) as any[]).find((r) => r.name === "reviewer")!;
  assert.deepEqual(reviewer.outcomes, { running: 1, ok: 2 });
  assert.equal(reviewer.tokens, 17);
  assert.deepEqual(reviewer.verdicts, { approve: 1 });
  const one = item(db, "agent", "reviewer", { range: "7d" }, NOW);
  assert.equal(one.summary.runs, 3);
  assert.equal(one.recent[0]!.ms, 100_000, "running: from its first line until now");
  assert.equal(one.recent[1]!.ms, null);
  assert.equal(one.recent[2]!.output, "VERDICT: approve");
  assert.deepEqual(one.bySession.map((s) => s.session), ["s1", "s2"]);
});

// @req R25
test("tables: a hook's budget event is the one it runs on most; a skill's runs by session", () => {
  const db = store();
  const guard = (items(db, "hook", { range: "7d" }, NOW) as any[]).find((r) => r.name === "guard")!;
  assert.equal(guard.event, "PreToolUse");
  const ship = item(db, "skill", "ship", { range: "7d" }, NOW);
  assert.deepEqual(ship.bySession.map((s) => s.session).sort(), ["s1", "s2"]);
});

// @req R24 R25
test("a rule's detail reads blocks and overrides from the hooks' log, narrowed to a branch", () => {
  const db = store();
  const all = item(db, "rule", "branch-guard", { range: "7d" }, NOW);
  assert.deepEqual(all.recent.map((r) => r.output), ["push", "push again"], "the timed block is in the log already");
  assert.deepEqual(item(db, "rule", "SKIP_X", { range: "7d" }, NOW).recent.map((r) => r.outcome), ["override"]);
  assert.deepEqual(item(db, "rule", "SKIP_X", { range: "7d", branch: "dev" }, NOW).recent.map((r) => r.outcome), ["override"]);
  assert.deepEqual(item(db, "rule", "SKIP_X", { range: "7d", branch: "main" }, NOW).recent, []);
});

// @req R26
test("the timeline ends each agent at its last line, its duration, now while it runs, or where it started", () => {
  const db = store();
  assert.deepEqual(timeline(openStore(":memory:"), NOW), { now: NOW, from: NOW - 3_600_000, session: null, sessions: [], events: [] });
  const t = timeline(db, NOW);
  assert.equal(t.session, "s1", "the most recently active session");
  const by = Object.fromEntries(t.events.map((e) => [e.id, e]));
  assert.equal(by.g1!.end, NOW - 60_000, "its last line");
  assert.equal(by.g4!.end, NOW - 350_000 + 1000, "its duration");
  assert.equal(by.g5!.end, NOW - 360_000, "no end known: where it started");
  assert.equal(by.g5!.what, "do it");
  assert.equal(by.k3!.what, "tdd");
  assert.equal(timeline(db, NOW, { session: "s2" }).events.find((e) => e.id === "g2")!.end, NOW, "running: now");
  assert.equal(by.h5!.name, "guard · branch-guard");
  assert.equal(timeline(db, NOW, { session: "s1", range: "all" }).events.find((e) => e.id === "k1")!.what, "ship");
  assert.equal(timeline(db, NOW, { session: "s2", range: "all" }).events.find((e) => e.id === "k2")!.what, null);
});

// @req R28
test("tokens: an agent without a type is unknown, a skill without a size adds nothing, quiet days show as zero", () => {
  const db = store();
  const t = tokens(db, { range: "7d" }, NOW, { hooks: [], rules: {}, skills: [], agents: [], skillChars: { ship: 400 } });
  assert.deepEqual(t.agents.map((a) => a.type), ["unknown"]);
  assert.deepEqual(t.hooks.map((h) => [h.name, h.tokens]), [["guard", 300], ["fmt", 10]]);
  assert.deepEqual(t.skills.map((s) => [s.name, s.tokens]), [["ship", 200], ["tdd", 0]]);
  assert.equal(t.days.length, 4);
  assert.deepEqual(t.days[1], { day: t.days[1]!.day, work: 0, orchestration: 0, replies: 0, cached: 0 });
});

// ---------------------------------------------------------------- improvements

const stat = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  runs: 10,
  p50: 100,
  p95: 200,
  totalMs: 1000,
  outcomes: { ok: 10 },
  lastAt: 0,
  ...o,
});
const quiet: Inputs = {
  weeks: 1,
  now: 10 * 86_400_000,
  hooks: [],
  rules: [],
  skills: [],
  agents: [],
  tools: [],
  kpis: { hints: 0, hintsConverted: 0, overrides: 0 },
  defined: { hooks: [], skills: [], agents: [] },
  lastActivity: null,
  timingSince: null,
};

// @req R27
test("improvements read long times in seconds, big token counts in millions, and agents without verdicts as silent", () => {
  const r = rank({
    ...quiet,
    hooks: [{ ...stat("slow", { runs: 5, p50: null, p95: 15_000 }), event: "Stop" }, { ...stat("slower", { runs: 5, p95: 90_000 }), event: "Stop" }],
    agents: [{ ...stat("big-reviewer", { runs: 3 }), tokens: 6_000_000 }],
    skills: [{ ...stat("a"), hintedNotLoaded: 1 }, { ...stat("b"), hintedNotLoaded: 4 }],
    kpis: { hints: 10, hintsConverted: 1, overrides: 0 },
  });
  const by = Object.fromEntries(r.map((i) => [i.id, i]));
  assert.equal(by["slow-hook-slower"]!.evidence, "p95 90 s against a 60 s budget for Stop over 5 runs (p50 100 ms).");
  assert.equal(by["slow-hook-slow"], undefined, "15 s is within Stop's budget");
  assert.match(by["costly-agent-big-reviewer"]!.evidence, /^2\.0M new tokens a run/);
  assert.equal(by["review-verdicts"]!.title, "Have big-reviewer end on a verdict line");
  assert.match(by["ignored-hints"]!.title, /b most of all$/);
  const s = rank({
    ...quiet,
    hooks: [stat("s", { runs: 5, p50: null, p95: 15_000 }), stat("unwired", { runs: 5, p95: 15_000 })],
    defined: { hooks: [], skills: [], agents: [], hookEvents: { s: "PreToolUse" } },
  });
  assert.equal(s.length, 1, "a hook's event comes from where it's wired; without one it has no budget");
  assert.equal(s[0]!.evidence, "p95 15 s against a 1.0 s budget for PreToolUse over 5 runs (p50 –).");
});

// ---------------------------------------------------------------- api

/** A project with one session's transcript, under this test's Claude home. */
function repo(name: string) {
  const root = dir(name);
  const p = join(home, "projects", slug(root));
  mkdirSync(p, { recursive: true });
  writeFileSync(
    join(p, "s.jsonl"),
    jsonl([
      {
        sessionId: "s",
        cwd: root,
        timestamp: iso(Date.now() - 5000),
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Skill", input: { skill: "ship" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "make" } },
          ],
        },
      },
    ]),
  );
  return { root, file: join(p, "s.jsonl") };
}

// @req R25
test("scopeOf keeps known ranges and short text, and drops the rest", () => {
  assert.deepEqual(scopeOf(), { range: "7d", session: null, branch: null });
  assert.deepEqual(scopeOf({ range: "nope", session: "", branch: "b".repeat(200) }), { range: "7d", session: null, branch: null });
  assert.deepEqual(scopeOf({ range: "30d", session: 5, branch: "main" }), { range: "30d", session: null, branch: "main" });
});

// @req R29 R33
test("project() opens the default project once, with its store in a file or in memory", () => {
  const def = dir("default-proj");
  process.env.MORPHEUS_PROJECT = def;
  try {
    const p = project();
    assert.equal(p.root, def);
    assert.equal(p.dbFile, null);
    assert.equal(project(def), p, "opened once");
  } finally {
    delete process.env.MORPHEUS_PROJECT;
  }
  const f = join(tmp, "dbs", "file.db");
  const q = project(dir("file-proj"), { db: f });
  assert.equal(q.dbFile, f);
  assert.ok(existsSync(f));
});

// @req R23 R26
test("refresh reads at most every couple of seconds and looks at the setup again after a minute", () => {
  const { root, file } = repo("refreshed");
  const p = project(root);
  assert.equal(refresh(p, 0), 1);
  appendFileSync(file, `${JSON.stringify({ sessionId: "s", timestamp: iso(Date.now()), type: "user", message: { content: "hi" } })}\n`);
  assert.equal(refresh(p), 0, "too soon");
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "fresh.md"), "x");
  p.defAt = 0;
  p.readAt = 0;
  assert.equal(refresh(p), 1);
  assert.deepEqual(p.def.agents, ["fresh"]);
});

// @req R25 R26 R28 R29
test("answer runs each original tool for the project asked for", () => {
  const { root } = repo("answered");
  const ask = (name: string, input: Record<string, unknown> = {}) => answer(name, { project: root, ...input }) as any;
  assert.throws(() => answer("morpheus_nope"), /No tool morpheus_nope/);
  assert.equal(ask("morpheus_live").sessions[0].session, "s");
  assert.equal(ask("morpheus_overview").project, root);
  assert.deepEqual(ask("morpheus_items", { kind: "tool" }).map((r: any) => r.name), ["Bash"]);
  assert.deepEqual(ask("morpheus_items", { kind: "nope" }), [], "an unknown kind is a hook");
  assert.equal(ask("morpheus_item", { kind: "skill", name: "ship" }).summary.runs, 1);
  assert.equal(ask("morpheus_item", { kind: "tool" }).kind, "hook");
  assert.equal(ask("morpheus_timeline").session, "s");
  assert.equal(ask("morpheus_coverage").totals.active, 1);
  assert.equal(ask("morpheus_tokens").range, "7d");
  assert.equal(ask("morpheus_inventory").root, root);
  assert.equal((answer("morpheus_inventory", { project: "" }, { root }) as any).root, root, "an empty project is the default");
  assert.equal(TOOLS.length > 9, true);
  // Projects: those with transcripts whose folder still exists.
  const gone = join(home, "projects", "-gone");
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, "s.jsonl"), `${JSON.stringify({ cwd: join(tmp, "deleted") })}\n`);
  const roots = (answer("morpheus_projects") as { root: string }[]).map((p) => p.root);
  assert.ok(roots.includes(root));
  assert.ok(!roots.includes(join(tmp, "deleted")));
  assert.equal(readFileSync(join(home, "projects", slug(root), "s.jsonl"), "utf8").length > 0, true);
});
