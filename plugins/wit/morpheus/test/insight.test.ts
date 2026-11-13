import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import { costOf, priceOf } from "../src/cost.ts";
import { ingestGit } from "../src/git.ts";
import { bandStatus, grade, health, worst, type HealthInputs } from "../src/health.ts";
import { isTestPath, quality, rework } from "../src/quality.ts";
import {
  bucket, BUILD_CMD, classify, compact, diskSample, duRunner, footprintPaths, isClaude, machine, parsePs, psRunner, resources, sample, TEST_CMD,
} from "../src/resources.ts";
import { getMeta, openStore } from "../src/store.ts";
import { buildTasks, categorise, isCorrection, tasksReport } from "../src/tasks.ts";
import { DAY, HOUR, Repo, tmp } from "./sdlc-helpers.ts";

const NOW = Date.UTC(2026, 10, 12, 12);

// @req R40
test("cost uses each model's list price, with cache writes and reads priced apart", () => {
  assert.deepEqual(priceOf("claude-opus-5-5"), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.equal(priceOf("claude-sonnet-4-6-20260101")!.input, 3);
  assert.equal(priceOf("us.anthropic.claude-haiku-4-5")!.input, 1);
  assert.equal(priceOf("claude-opus-next")!.input, 5, "unknown Opus: the family's price");
  assert.equal(priceOf("my-sonnet-proxy")!.input, 3);
  assert.equal(priceOf("some-haiku")!.output, 5);
  assert.equal(priceOf("fable-preview")!.input, 8);
  assert.equal(priceOf("gpt-x"), null);
  assert.equal(priceOf("<synthetic>"), null);
  assert.equal(priceOf(null), null);
  assert.equal(costOf("claude-opus-5-5", { tokensIn: 1_000_000, tokensOut: 1_000_000, tokensCached: 1_000_000, tokensWrite: 500_000 }), 2 + 2.5 + 20 + 0.2);
  assert.equal(costOf("claude-opus-5-5", { tokensIn: 10, tokensOut: 0, tokensCached: 0, tokensWrite: 99 }), 50 / 1e6, "writes can't exceed input");
  assert.equal(costOf("claude-opus-5-5", { tokensIn: 1e6, tokensOut: 0, tokensCached: 0 }), 4);
  assert.equal(costOf("gpt-x", { tokensIn: 1e6, tokensOut: 0, tokensCached: 0 }), 0);
});

// @req R40
test("tasks are categorised by their prompt first, then by what they touched", () => {
  const none = { edits: [], reads: 0, bash: [] };
  const cases: [string, string][] = [
    ["[Request interrupted by user]", "interrupt"], ["please review this PR", "review"], ["fix the login crash", "bugfix"],
    ["add tests for cart", "test"], ["update the README", "docs"], ["refactor the store", "refactor"], ["deploy to staging", "ops"],
    ["implement dark mode", "feature"], ["how does caching work?", "explore"],
  ];
  for (const [p, c] of cases) assert.equal(categorise(p, none), c, p);
  assert.equal(categorise("ok go", { edits: ["tests/test_a.py", "src/a.test.ts"], reads: 0, bash: [] }), "test");
  assert.equal(categorise("ok go", { edits: ["docs/a.md"], reads: 0, bash: [] }), "docs");
  assert.equal(categorise("ok go", { edits: [".github/workflows/ci.yml"], reads: 0, bash: [] }), "ops");
  assert.equal(categorise("ok go", { edits: ["src/a.ts"], reads: 0, bash: [] }), "feature");
  assert.equal(categorise("ok go", { edits: [], reads: 0, bash: ["git push origin x"] }), "ops");
  assert.equal(categorise("ok go", { edits: [], reads: 3, bash: ["ls"] }), "explore");
  assert.equal(categorise("ok go", none), "chore");
  assert.ok(isCorrection("No, use the other file") && isCorrection("[Request interrupted by user]") && isCorrection("actually revert that"));
  assert.ok(!isCorrection("now add the tests"));
});

function taskDb() {
  const db = openStore(":memory:");
  const p = db.prepare("insert into prompts (session, at, text) values (?, ?, ?)");
  p.run("s1", NOW - 3 * HOUR, "fix the flaky login test");
  p.run("s1", NOW - 2 * HOUR, "no, the other one");
  p.run("s2", NOW - HOUR, "add a cart feature");
  p.run("old", NOW - 40 * DAY, "ancient");
  const u = db.prepare("insert into usage (session, message_id, at, model, tokens_in, tokens_out, tokens_cached, tokens_write, work, orchestration, text, branch) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  u.run("s1", "m1", NOW - 3 * HOUR + 1000, "claude-opus-5-5", 1000, 200, 5000, 100, 2, 1, 0, "main");
  u.run("s1/agent-a1", "m2", NOW - 3 * HOUR + 2000, "claude-haiku-4-5", 300, 50, 1000, 0, 1, 0, 0, "main");
  u.run("s1", "m3", NOW - 2 * HOUR + 1000, null, 100, 10, 0, 0, 0, 0, 1, "main");
  u.run("s2", "m4", NOW - HOUR + 1000, "claude-opus-5-5", 500, 100, 2000, 0, 1, 0, 0, "feat");
  u.run("s3", "m5", NOW - HOUR, "claude-opus-5-5", 50, 5, 0, 0, 0, 0, 1, "main");
  u.run("s2", "m0", NOW - HOUR - 1000, "claude-opus-5-5", 1, 1, 0, 0, 0, 0, 1, "feat");
  const r = db.prepare("insert into runs (id, kind, name, session, started_at, duration_ms, outcome, trigger) values (?, ?, ?, ?, ?, ?, ?, ?)");
  r.run("t1", "tool", "Edit", "s1", NOW - 3 * HOUR + 1500, 100, "ok", "tests/test_login.py");
  r.run("t2", "tool", "Bash", "s1", NOW - 3 * HOUR + 1600, 60_000, "error", "npm test");
  r.run("t3", "tool", "Read", "s1/agent-a1", NOW - 3 * HOUR + 2500, 10, "ok", "src/login.ts");
  r.run("t4", "agent", "Explore", "s1", NOW - 3 * HOUR + 1700, null, "ok", "look");
  r.run("t5", "skill", "tdd", "s1", NOW - 3 * HOUR + 1800, null, "ok", null);
  r.run("t6", "skill", "tdd", "s1", NOW - 3 * HOUR + 1900, null, "ok", null);
  r.run("t7", "tool", "Edit", "s2", NOW - HOUR + 2000, 5, "ok", null);
  r.run("t8", "tool", "Bash", "s2", NOW - HOUR + 2100, 5, "ok", null);
  r.run("t9", "tool", "Write", "nosession", NOW - HOUR, 5, "ok", "x.ts");
  return db;
}

// @req R40
test("a task runs from a prompt to the next, with its agents' tokens, its cost, tools, files and correction", () => {
  const db = taskDb();
  const tasks = buildTasks(db, { range: "7d" }, NOW);
  assert.equal(tasks.length, 3);
  const [a, b, c] = tasks;
  assert.equal(a!.category, "bugfix");
  assert.equal(a!.corrected, true);
  assert.equal(a!.tokensNew, 1550);
  assert.equal(a!.tokensCached, 6000);
  assert.equal(a!.toolCalls, 3);
  assert.equal(a!.toolErrors, 1);
  assert.equal(a!.agents, 1);
  assert.deepEqual(a!.skills, ["tdd"]);
  assert.deepEqual(a!.files, ["tests/test_login.py"]);
  assert.deepEqual(Object.keys(a!.models).sort(), ["claude-haiku-4-5", "claude-opus-5-5"]);
  assert.ok(a!.cost > 0);
  assert.equal(a!.durationMs, 61_600);
  assert.equal(a!.work + a!.orchestration, 1550);
  assert.equal(b!.category, "chore");
  assert.equal(b!.models.unknown, 110);
  assert.equal(c!.category, "feature");
  assert.equal(c!.corrected, false);
  assert.equal(buildTasks(db, { range: "7d", session: "s2" }, NOW).length, 1);
  assert.equal(buildTasks(db, { range: "7d", branch: "feat" }, NOW).find((t) => t.session === "s2")!.tokensNew, 600);
  assert.deepEqual(buildTasks(openStore(":memory:"), { range: "7d" }, NOW), []);
});

// @req R40
test("the task report totals tokens and cost by category, model and day, and sorts or filters the list", () => {
  const db = taskDb();
  const r = tasksReport(db, { range: "7d" }, NOW);
  assert.equal(r.totals.tasks, 3);
  assert.equal(r.totals.corrected, 1);
  assert.ok(r.totals.cacheHit! > 0.5);
  assert.deepEqual(r.byCategory.map((c) => c.category), ["bugfix", "feature", "chore"]);
  assert.equal(r.byModel[0]!.model, "claude-opus-5-5");
  assert.ok(r.byModel.some((m) => m.model === "unknown"));
  assert.equal(r.days.length, 8);
  assert.equal(r.list[0]!.category, "bugfix");
  assert.equal(tasksReport(db, { range: "7d" }, NOW, { sort: "recent" }).list[0]!.category, "feature");
  assert.equal(tasksReport(db, { range: "7d" }, NOW, { sort: "cost" }).list[0]!.category, "bugfix");
  assert.equal(tasksReport(db, { range: "7d" }, NOW, { sort: "duration" }).list[0]!.category, "bugfix");
  const only = tasksReport(db, { range: "7d" }, NOW, { category: "feature", limit: 5 });
  assert.equal(only.count, 1);
  const all = tasksReport(db, { range: "all" }, NOW);
  assert.equal(all.totals.tasks, 4);
  assert.ok(all.days.length > 30);
  const empty = tasksReport(openStore(":memory:"), { range: "all" }, NOW);
  assert.deepEqual([empty.totals.perTask, empty.totals.costPerTask, empty.totals.cacheHit], [null, null, null]);
  assert.equal(empty.days.length, 1);
});

// @req R41
test("ps output is parsed and processes are sorted into Claude Code, MCP servers, hooks, commands and Wit", () => {
  const ps = parsePs([
    "  1     0  0.0   100 /sbin/launchd",
    " 10     1  5.0  1000 /Users/me/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude --output-format stream-json",
    " 11    10  1.0   200 node /x/morpheus/dist/cli.js mcp",
    " 12    10  0.5   300 bash .claude/hooks/guard.sh",
    " 13    10 50.0  4000 node --test",
    " 14    13 20.0  2000 node worker.js",
    " 20     1  2.0   500 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    " 30     1  1.0   100 grep claude",
    " 40    13  3.0   100 node wit-self",
    " 41    40  1.0    50 child-of-self",
    "garbage",
  ].join("\n"));
  assert.equal(ps.length, 10);
  assert.equal(ps[1]!.rss, 1000 * 1024);
  const c = classify(ps, 40);
  assert.deepEqual(c.get("claude"), { cpu: 7, rss: 1500 * 1024, procs: 2 });
  assert.deepEqual(c.get("mcp")!.procs, 1);
  assert.deepEqual(c.get("hook")!.procs, 1);
  assert.deepEqual(c.get("tools"), { cpu: 70, rss: 6000 * 1024, procs: 2 });
  assert.deepEqual(c.get("wit"), { cpu: 4, rss: 150 * 1024, procs: 2 });
  assert.ok(isClaude("claude") && isClaude("/opt/bin/claude --resume") && !isClaude("grep claude") && !isClaude("claudette"));
});

// @req R41
test("a sample stores every scope and the machine; without ps only the machine is sampled", () => {
  const db = openStore(":memory:");
  const root = tmp();
  const m = machine(root);
  assert.ok(m.cores >= 1 && m.memTotal > 0 && m.disk.total > 0);
  assert.equal(machine(join(root, "missing")).disk.total, 0);
  assert.equal(sample(db, root, NOW, () => ` ${process.pid} 1 1.5 100 node self\n 99 1 0 1 /usr/bin/claude\n`), true);
  const scopes = (db.prepare("select scope from resource_samples where at = ? order by scope").all(NOW) as any[]).map((r) => r.scope);
  assert.deepEqual(scopes, ["claude", "disk-free", "hook", "machine", "mcp", "tools", "wit"]);
  assert.equal(sample(db, root, NOW + 1000, () => null), false);
  assert.equal((db.prepare("select count(*) as n from resource_samples where at = ?").get(NOW + 1000) as any).n, 2);
  assert.ok(JSON.parse(getMeta(db, "machine")!).cores >= 1);
  assert.equal(typeof psRunner(), "string");
  const old = process.env.PATH;
  process.env.PATH = tmp();
  try {
    assert.equal(psRunner(), null);
  } finally {
    process.env.PATH = old;
  }
});

// @req R41
test("samples older than a week are averaged to one an hour, and dropped after 90 days", () => {
  const db = openStore(":memory:");
  const put = db.prepare("insert into resource_samples (at, scope, cpu, rss, procs) values (?, ?, ?, ?, ?)");
  const old = Math.floor((NOW - 10 * DAY) / HOUR) * HOUR;
  put.run(old + 1000, "claude", 10, 100, 1);
  put.run(old + 2000, "claude", 30, 300, 3);
  put.run(NOW - 100 * DAY, "claude", 1, 1, 1);
  put.run(NOW - 1000, "claude", 5, 5, 1);
  db.prepare("insert into disk_samples (at, key, bytes) values (?, 'project', 1)").run(NOW - 100 * DAY);
  compact(db, NOW);
  const rows = db.prepare("select at, cpu, rss, procs from resource_samples order by at").all() as any[];
  assert.deepEqual(rows.map((r) => [r.at, r.cpu, r.rss, r.procs]), [[old, 20, 200, 2], [NOW - 1000, 5, 5, 1]]);
  assert.equal((db.prepare("select count(*) as n from disk_samples").get() as any).n, 0);
  put.run(old + 5000, "claude", 1, 1, 1);
  compact(db, NOW + 1000);
  assert.equal((db.prepare("select count(*) as n from resource_samples").get() as any).n, 3, "at most once an hour");
});

// @req R41
test("the disk footprint is measured at most every ten minutes, by folder group", () => {
  const r = new Repo();
  r.commit("init", { "a.txt": "a" }, NOW);
  mkdirSync(join(r.root, "node_modules"));
  writeFileSync(join(r.root, "node_modules", "x.js"), "x".repeat(5000));
  const dbFile = join(tmp(), "s.db");
  writeFileSync(dbFile, "12345");
  writeFileSync(`${dbFile}-wal`, "678");
  const groups = footprintPaths(r.root, dbFile);
  assert.deepEqual(groups.dependencies, [join(r.root, "node_modules")]);
  assert.equal(groups["wit store"]!.length, 2);
  assert.deepEqual(footprintPaths(tmp(), null)["wit store"], []);
  assert.deepEqual(footprintPaths(tmp(), null).git, []);
  const db = openStore(":memory:");
  assert.equal(diskSample(db, r.root, NOW, dbFile), true);
  assert.equal(diskSample(db, r.root, NOW + 1000, dbFile), false);
  const by = Object.fromEntries((db.prepare("select key, bytes from disk_samples").all() as any[]).map((x) => [x.key, x.bytes]));
  assert.ok(by.dependencies >= 4096);
  assert.ok(by.project >= by.dependencies);
  assert.equal(by.transcripts, 0);
  assert.ok(by["wit store"] >= 8);
  // A stand-in du that can't size anything: plain files still count by their size.
  const db2 = openStore(":memory:");
  diskSample(db2, r.root, NOW, join(tmp(), "gone.db"), () => new Map());
  assert.equal(duRunner([join(tmp(), "missing")]).size, 0);
});

// @req R41
test("resources: latest per scope, chart series, peaks, disk footprint and timed test and build commands", () => {
  const db = openStore(":memory:");
  const put = db.prepare("insert into resource_samples (at, scope, cpu, rss, procs) values (?, ?, ?, ?, ?)");
  for (const [at, rss] of [[NOW - 60_000, 100], [NOW - 30_000, 900], [NOW, 300]] as const) {
    put.run(at, "tools", 10, rss, 1);
    put.run(at, "claude", 5, 50, 1);
    put.run(at, "machine", 40, 1000, 8);
    put.run(at, "disk-free", 0, 5000, 0);
  }
  db.prepare("insert into disk_samples (at, key, bytes) values (?, ?, ?)").run(NOW, "project", 10);
  db.prepare("insert into meta (key, value) values ('machine', ?)").run(JSON.stringify({ cores: 8, memTotal: 2000, diskTotal: 9000 }));
  const r = db.prepare("insert into runs (id, kind, name, session, started_at, duration_ms, outcome, trigger) values (?, 'tool', 'Bash', 's', ?, ?, ?, ?)");
  r.run("a", NOW - 40_000, 20_000, "ok", "cd x && npm test");
  r.run("b", NOW - 10_000, 1000, "error", "pytest -q");
  r.run("c", NOW - 9000, null, "ok", "npm run build");
  r.run("d", NOW - 8000, 5, "ok", "ls");
  r.run("e", NOW - 7000, 5, "ok", null);
  r.run("f", NOW - 600_000, 5, "ok", "go test ./...");
  const res = resources(db, "1h", NOW);
  assert.equal(res.sampledAt, NOW);
  assert.equal(res.now.tools!.rss, 300);
  assert.equal(res.now.mcp, null);
  assert.equal(res.peak.tools, 900);
  assert.equal(res.machine.diskFree, 5000);
  assert.equal(res.machine.cores, 8);
  assert.ok(res.memory.tools!.length >= 1);
  assert.equal(res.disk.latest.project, 10);
  assert.equal(res.commands.test.runs, 3);
  assert.equal(res.commands.test.failed, 1);
  assert.equal(res.commands.build.runs, 1);
  assert.equal(res.commands.build.p50, null);
  assert.equal(res.commands.recent.find((x) => x.command === "cd x && npm test")!.peakRss, 900);
  assert.equal(res.commands.recent.find((x) => x.command === "go test ./...")!.peakRss, null);
  const all = resources(openStore(":memory:"), "all", NOW);
  assert.deepEqual([all.sampledAt, all.disk.at, all.machine.diskFree], [null, null, null]);
  assert.deepEqual(bucket([{ at: 0 }, { at: 1 }, { at: 10 }], 0, 10, 2, (x) => x.at), [{ at: 0, v: 0.5 }, { at: 10, v: 10 }]);
  assert.ok(TEST_CMD.test("python -m pytest") && BUILD_CMD.test("cargo build") && !BUILD_CMD.test("make test"));
});

// @req R42
test("rework counts AI and other lines removed again within 14 days, at most the lines added", () => {
  const r = rework([
    { sha: "a", path: "src/x.ts", added: 10, deleted: 0, at: 0, ai: 1 },
    { sha: "b", path: "src/x.ts", added: 2, deleted: 4, at: DAY, ai: 0 },
    { sha: "c", path: "src/x.ts", added: 0, deleted: 50, at: 20 * DAY, ai: 0 },
    { sha: "d", path: "src/y.ts", added: 5, deleted: 0, at: 0, ai: 0 },
    { sha: "d", path: "src/y.ts", added: 0, deleted: 9, at: 0, ai: 0 },
    { sha: "e", path: "README.md", added: 5, deleted: 0, at: 0, ai: 1 },
    { sha: "f", path: "src/z.ts", added: 3, deleted: 0, at: -DAY, ai: 1 },
  ], 0);
  assert.deepEqual(r.ai, { added: 10, reworked: 4, rate: 0.4 });
  assert.deepEqual(r.human, { added: 7, reworked: 0, rate: 0 }, "deletions outside the window or in the same commit do not count");
  assert.deepEqual(rework([], 0).ai.rate, null);
  assert.ok(isTestPath("tests/test_a.py") && isTestPath("src/a.test.ts") && isTestPath("pkg/a_test.go") && isTestPath("FooTest.java") && !isTestPath("src/a.ts"));
});

// @req R42
test("quality: AI share, rework, efficiency, process signals, test ratio, hotspots and changed-code coverage", () => {
  const r = new Repo();
  const ai = "\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
  r.commit(`Add cart${ai}`, { "src/cart.ts": "a\nb\nc\nd\n", "tests/cart.test.ts": "t\nt\n" }, NOW - 5 * DAY);
  r.commit("Tweak cart", { "src/cart.ts": "a\nB\nc\n", "src/blank.ts": "x\n" }, NOW - 4 * DAY);
  r.commit("Blank", { "src/blank.ts": "" }, NOW - 4 * DAY + 1000);
  r.commit(`Add docs${ai}`, { "README.md": "hi\n" }, NOW - 3 * DAY);
  r.git("checkout", "-q", "-b", "f");
  r.commit("branch work", { "src/gone.ts": "x\n" }, NOW - 2 * DAY);
  r.git("checkout", "-q", "main");
  r.merge("f", "Merge f", NOW - DAY);
  r.git("rm", "-q", "src/gone.ts");
  r.commit("remove", {}, NOW - DAY + 1000);
  const db = openStore(":memory:");
  ingestGit(db, r.root, { ...DEFAULTS });
  db.prepare("insert into usage (session, message_id, at, model, tokens_in, tokens_out, tokens_cached, tokens_write) values ('s', 'm', ?, 'claude-opus-5-5', 1000, 1000, 8000, 0)").run(NOW - DAY);
  db.prepare("insert into prompts (session, at, text) values ('s', ?, 'go')").run(NOW - DAY);
  for (const t of ["compact", "denied", "interrupt"]) db.prepare("insert into marks (session, at, type) values ('s', ?, ?)").run(NOW - DAY, t);
  db.prepare("insert into runs (id, kind, name, session, started_at, outcome) values ('x', 'tool', 'Edit', 's', ?, 'error'), ('y', 'tool', 'Read', 's', ?, 'ok')").run(NOW - DAY, NOW - DAY);
  db.prepare("insert into test_reports (path, hash, at, kind) values ('lcov.info', 'aaaaaaaaaaaaaaaa', ?, 'coverage')").run(NOW);
  db.prepare("insert into coverage_files (report, file, lines_total, lines_hit, at) values ('lcov.info@aaaaaaaaaaaa', 'src/cart.ts', 4, 3, ?), ('lcov.info@aaaaaaaaaaaa', 'src/empty.ts', 0, 0, ?), ('lcov.info@aaaaaaaaaaaa', 'src/blank.ts', 2, 2, ?)").run(NOW, NOW, NOW);
  const q = quality(db, r.root, "30d", NOW, { tasks: 4, corrected: 1 });
  assert.equal(q.commits, 6);
  assert.equal(q.ai.commits, 2);
  assert.equal(q.ai.share, 2 / 6);
  assert.ok(q.rework.ai.rate! > 0);
  assert.equal(q.efficiency.tokensPerCommit, 1000);
  assert.equal(q.efficiency.cacheHit, 8000 / 9000);
  assert.deepEqual([q.process.compactions, q.process.denials, q.process.interrupts, q.process.sessions], [1, 1, 1, 1]);
  assert.equal(q.process.correctionRate, 0.25);
  assert.equal(q.process.toolErrorRate, 0.5);
  assert.equal(q.tests.ai.test, 2);
  assert.equal(q.hotspots[0]!.path, "src/cart.ts");
  assert.equal(q.hotspots[0]!.lines, 4);
  assert.equal(q.hotspots.find((h) => h.path === "src/gone.ts")!.lines, 0);
  assert.equal(q.hotspots.find((h) => h.path === "src/blank.ts")!.lines, 0);
  assert.equal(q.changedCoverage.measured, 2);
  assert.equal(q.changedCoverage.lines, 5 / 6);
  assert.deepEqual(q.changedCoverage.lowest.map((l) => l.path), ["src/cart.ts", "src/blank.ts"]);
  assert.equal(q.range, "30d");
  const empty = quality(openStore(":memory:"), tmp(), "today", NOW);
  assert.equal(empty.range, "7d");
  assert.deepEqual([empty.ai.share, empty.ai.lineShare, empty.efficiency.tokensPerCommit, empty.efficiency.tokensPerLine, empty.efficiency.cacheHit, empty.process.correctionRate, empty.process.toolErrorRate, empty.tests.all.ratio, empty.changedCoverage.lines], [null, null, null, null, null, null, null, null, null]);
  assert.equal(empty.process.corrections, null);
});

// @req R43
test("grades, bands and the worst metric decide each stage", () => {
  assert.deepEqual([grade(0.9, 0.8, 0.6, true), grade(0.7, 0.8, 0.6, true), grade(0.1, 0.8, 0.6, true), grade(null, 1, 1, true), grade(NaN, 1, 1, true)], ["good", "warn", "bad", "unknown", "unknown"]);
  assert.deepEqual([grade(0.05, 0.1, 0.2, false), grade(0.15, 0.1, 0.2, false), grade(0.5, 0.1, 0.2, false)], ["good", "warn", "bad"]);
  assert.deepEqual(["elite", "high", "medium", "low", null].map((b) => bandStatus(b as never)), ["good", "good", "warn", "bad", "unknown"]);
  const m = (status: string) => ({ label: "", value: 1, unit: "pct" as const, target: "", status: status as never });
  assert.equal(worst([m("good"), m("bad"), m("warn")]), "bad");
  assert.equal(worst([m("unknown"), m("good")]), "good");
  assert.equal(worst([m("unknown")]), "unknown");
});

const inputs = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  dora: { frequency: { perWeek: 10, band: "elite" }, leadTime: { p50: HOUR, band: "elite" }, failureRate: { rate: 0.2, band: "low" }, restore: { p50: HOUR, band: "high" }, deploys: 10, ci: { passRate: 0.95, runs: 20 } },
  tasks: { totals: { tasks: 10, corrected: 1, cacheHit: 0.8 } },
  quality: { rework: { ai: { rate: 0.05 } }, process: { toolErrorRate: 0.02, compactionsPerSession: 0.2 }, changedCoverage: { lines: 0.7 } },
  tests: { node: { tests: 10, passed: 9, failed: 1, flaky: 0, coverage: { lines: 0.85 } } },
  ghOn: true,
  ...over,
});

// @req R43
test("the health scorecard grades every stage, scores the measured ones and explains missing data", () => {
  const db = openStore(":memory:");
  db.prepare("insert into commits (sha, at, authored_at, landed, is_merge) values ('a', ?, ?, 1, 1), ('b', ?, ?, 1, 0)").run(NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY);
  const h = health(db, "30d", NOW, inputs());
  const by = Object.fromEntries(h.stages.map((s) => [s.key, s]));
  assert.equal(by.plan!.status, "good");
  assert.equal(by.review!.status, "warn");
  assert.equal(by.test!.status, "bad", "a failing test makes the stage bad");
  assert.equal(by.operate!.status, "bad");
  assert.equal(by.build!.hint, null);
  assert.equal(h.measured, 8);
  assert.ok(h.score! > 0 && h.score! < 100);
  const none = health(openStore(":memory:"), "today", NOW, inputs({
    dora: { frequency: { perWeek: 0, band: null }, leadTime: { p50: null, band: null }, failureRate: { rate: null, band: null }, restore: { p50: null, band: null }, deploys: 0, ci: { passRate: null, runs: 0 } },
    tasks: { totals: { tasks: 0, corrected: 0, cacheHit: null } },
    quality: { rework: { ai: { rate: null } }, process: { toolErrorRate: null, compactionsPerSession: null }, changedCoverage: { lines: null } },
    tests: { node: { tests: 5, passed: 0, failed: 0, flaky: 0, coverage: null } },
    ghOn: false,
  }));
  assert.equal(none.score, null);
  assert.equal(none.measured, 0);
  assert.ok(none.stages.every((s) => s.status === "unknown"));
  assert.ok(none.stages.find((s) => s.key === "build")!.hint!.includes('"gh": true'));
  assert.ok(none.stages.find((s) => s.key === "test")!.hint!.includes("coverage"));
  const noRuns = health(openStore(":memory:"), "7d", NOW, inputs({ dora: { ...inputs().dora, ci: { passRate: null, runs: 0 } } }));
  assert.ok(noRuns.stages.find((s) => s.key === "build")!.hint!.includes("No CI runs"));
});
