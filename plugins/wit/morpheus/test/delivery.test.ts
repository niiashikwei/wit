import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, globRe, loadConfig, matches, normalise } from "../src/config.ts";
import { bandOf, ciSummary, dora, doraRange, failures, histogram } from "../src/dora.ts";
import { ghRunner, ingestGh, normaliseStatus } from "../src/gh.ts";
import { git, gitDeploys, gitOut, ingestGit, isAI, isHotfix, leadFrom, mainBranch, parseLog, renamed, revertOf, type Commit } from "../src/git.ts";
import { getMeta, openStore, setMeta } from "../src/store.ts";
import { DAY, HOUR, lines, Repo, tmp } from "./sdlc-helpers.ts";

const T0 = Date.UTC(2026, 9, 1, 12);
const cfg = (over: Partial<typeof DEFAULTS> = {}) => ({ ...DEFAULTS, ...over });

// @req R35
test("wit.json settings are validated: good values kept, bad shapes fall back to defaults", () => {
  assert.deepEqual(normalise(null), DEFAULTS);
  assert.deepEqual(normalise([1]), DEFAULTS);
  const c = normalise({
    deploy: "tag:v*", mainBranch: "trunk", gh: true, incidentLabel: "sev1", failureWindowHours: 24,
    layers: { e2e: ["e2e/**"] }, features: { auth: ["src/auth/**"] },
    coverageReports: ["lcov.info", { path: "int.xml", layer: "integration" }, { path: "x.json" }, 5, { nope: 1 }],
    testReports: ["junit.xml", 3], sampleSeconds: 2, unknown: "ignored",
  });
  assert.equal(c.deploy, "tag:v*");
  assert.equal(c.mainBranch, "trunk");
  assert.equal(c.gh, true);
  assert.equal(c.incidentLabel, "sev1");
  assert.equal(c.failureWindowHours, 24);
  assert.deepEqual(c.layers, { e2e: ["e2e/**"] });
  assert.deepEqual(c.features, { auth: ["src/auth/**"] });
  assert.deepEqual(c.coverageReports, [{ path: "lcov.info" }, { path: "int.xml", layer: "integration" }, { path: "x.json" }]);
  assert.deepEqual(c.testReports, ["junit.xml"]);
  assert.equal(c.sampleSeconds, 2);
  const bad = normalise({ deploy: "sometimes", mainBranch: "", gh: "yes", incidentLabel: "", failureWindowHours: -1, layers: { a: [1] }, features: ["x"], coverageReports: "x", testReports: {}, sampleSeconds: 0 });
  assert.deepEqual(bad, DEFAULTS);
  for (const d of ["main", "gh-deployments", "gh-workflow:deploy"]) assert.equal(normalise({ deploy: d }).deploy, d);
});

// @req R35
test("wit.json is read from the project's .claude folder; a broken file means defaults", () => {
  const root = tmp();
  assert.deepEqual(loadConfig(root), DEFAULTS);
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "wit.json"), '{"gh": true}');
  assert.equal(loadConfig(root).gh, true);
  writeFileSync(join(root, ".claude", "wit.json"), "{not json");
  assert.deepEqual(loadConfig(root), DEFAULTS);
});

// @req R35
test("globs match paths: ** folders, * one segment, ? a character, {a,b} either, bare names anywhere", () => {
  assert.ok(globRe("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globRe("src/**/*.ts").test("src/c.ts"));
  assert.ok(!globRe("src/*.ts").test("src/a/c.ts"));
  assert.ok(globRe("a?c.py").test("x/abc.py"));
  assert.ok(globRe("*.{js,ts}").test("deep/x.ts"));
  assert.ok(globRe("x{y").test("x{y"));
  assert.ok(globRe("**").test("anything/at/all"));
  assert.ok(globRe("a.b+c").test("a.b+c") && !globRe("a.b+c").test("aXb+c"));
  assert.ok(matches("e2e/login.spec.ts", ["unit/**", "e2e/**"]));
  assert.ok(!matches("src/x.ts", []));
});

// @req R35
test("git log output becomes commits with files, renames, binaries, AI co-authorship and reverts", () => {
  const RS = "\x1e";
  const US = "\x1f";
  const text = [
    "",
    `abc1234${US}p1 p2${US}1700000100${US}1700000000${US}Dev${US}Revert "x"${US}This reverts commit deadbeef1.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>${US}\n\n3\t1\tsrc/a.ts\n-\t-\timg.png\n2\t0\tsrc/{old => new}/b.ts\n1\t1\tc.ts => d.ts\nnoise`,
    `nothex${US}${US}1${US}1${US}x${US}s${US}b${US}`,
    "too short",
  ].join(RS);
  const [c, ...rest] = parseLog(text);
  assert.equal(rest.length, 0);
  assert.equal(c!.sha, "abc1234");
  assert.deepEqual(c!.parents, ["p1", "p2"]);
  assert.equal(c!.at, 1700000100000);
  assert.equal(c!.authoredAt, 1700000000000);
  assert.deepEqual(c!.files, [
    { path: "src/a.ts", added: 3, deleted: 1 },
    { path: "img.png", added: 0, deleted: 0 },
    { path: "src/new/b.ts", added: 2, deleted: 0 },
    { path: "d.ts", added: 1, deleted: 1 },
  ]);
  assert.ok(isAI(c!.body));
  assert.ok(isAI("🤖 Generated with [Claude Code](https://claude.com/claude-code)"));
  assert.ok(!isAI("Co-Authored-By: Pat <pat@example.com>"));
  assert.equal(revertOf(c!.subject, c!.body), "deadbeef1");
  assert.equal(revertOf('Revert "thing"', ""), "?");
  assert.equal(revertOf("Add thing", ""), null);
  assert.ok(isHotfix("hotfix: login") && isHotfix("Roll back the cache") && !isHotfix("Add hot sauce"));
  assert.equal(renamed("plain.ts"), "plain.ts");
  assert.equal(renamed("{a => b}/c.ts"), "b/c.ts");
  assert.equal(renamed("x/{a => }/c.ts"), "x/c.ts");
});

// @req R35
test("a merge's lead time starts at the earliest commit it brought in, stopping at the main line", () => {
  const mk = (sha: string, parents: string[], authoredAt: number): Commit => ({ sha, parents, at: authoredAt, authoredAt, author: "", subject: "", body: "", files: [] });
  const base = mk("base", [], 100);
  const f1 = mk("f1", ["base"], 50);
  const f2 = mk("f2", ["f1", "f1"], 70);
  const merge = mk("m", ["base", "f2", "gone"], 200);
  const by = new Map([base, f1, f2, merge].map((c) => [c.sha, c]));
  assert.equal(leadFrom(merge, by, new Set(["base", "m"])), 50);
  assert.equal(leadFrom(f1, by, new Set()), 50);
});

// @req R35
test("git outside a repository answers null, and the main branch is found or configured", () => {
  assert.equal(git(tmp(), ["rev-parse", "HEAD"]), null);
  assert.equal(gitOut(tmp(), ["rev-parse", "HEAD"]), "");
  const r = new Repo("master");
  r.commit("init", { "a.txt": "a" }, T0);
  assert.equal(mainBranch(r.root, { mainBranch: null }), "master");
  assert.equal(mainBranch(r.root, { mainBranch: "develop" }), null);
  assert.equal(mainBranch(tmp(), { mainBranch: null }), null);
  const db = openStore(":memory:");
  assert.equal(ingestGit(db, tmp(), cfg()), 0);
});

// @req R35 R36
test("git history is read incrementally into commits and main-branch deploys, and re-read after a rewrite", () => {
  const r = new Repo();
  const db = openStore(":memory:");
  const a = r.commit("Add a", { "src/a.ts": lines(10) }, T0);
  r.commit("Add b\n\nCo-Authored-By: Claude <noreply@anthropic.com>", { "src/b.ts": lines(5), "tests/test_b.py": lines(3) }, T0 + HOUR, T0);
  assert.equal(ingestGit(db, r.root, cfg()), 2);
  assert.equal(ingestGit(db, r.root, cfg()), 0, "nothing new");
  const rows = db.prepare("select sha, ai, landed, added, files, lead_from from commits order by at").all() as any[];
  assert.deepEqual(rows.map((x) => [x.ai, x.landed, x.added, x.files]), [[0, 1, 10, 1], [1, 1, 8, 2]]);
  assert.equal(rows[1].lead_from, T0);
  const deploys = db.prepare("select id, lead_ms from deploys order by at").all() as any[];
  assert.deepEqual(deploys.map((d) => d.lead_ms), [0, HOUR]);
  // A feature branch merged with --no-ff: the merge is the deploy, its lead time the branch's start.
  r.git("checkout", "-q", "-b", "feat");
  r.commit("feat 1", { "src/f.ts": lines(4) }, T0 + 2 * HOUR);
  r.commit("feat 2", { "src/f.ts": lines(6) }, T0 + 3 * HOUR);
  r.git("checkout", "-q", "main");
  const m = r.merge("feat", "Merge feat", T0 + 5 * HOUR);
  assert.equal(ingestGit(db, r.root, cfg()), 3);
  const merged = db.prepare("select is_merge, landed, lead_from from commits where sha = ?").get(m) as any;
  assert.deepEqual([merged.is_merge, merged.landed, merged.lead_from], [1, 1, T0 + 2 * HOUR]);
  assert.equal((db.prepare("select count(*) as n from commits where landed = 0").get() as any).n, 2);
  // Rewrite history: everything is read again.
  r.git("reset", "-q", "--hard", a);
  r.commit("Other", { "o.ts": "o\n" }, T0 + 6 * HOUR);
  assert.equal(ingestGit(db, r.root, cfg()), 2);
  assert.equal((db.prepare("select count(*) as n from commits").get() as any).n, 2);
});

// @req R36
test("tag deploys: matching tags are deploys, each with the median lead time of what it shipped", () => {
  const r = new Repo();
  const db = openStore(":memory:");
  r.commit("one", { "a.txt": "1" }, T0);
  r.tag("v1.0.0", T0 + HOUR);
  r.commit("two", { "a.txt": "2" }, T0 + DAY);
  r.commit("three", { "a.txt": "3" }, T0 + 2 * DAY);
  r.tag("v1.1.0", T0 + 3 * DAY, true);
  r.tag("nightly", T0 + 3 * DAY);
  ingestGit(db, r.root, cfg({ deploy: "tag:v*" }));
  const d = db.prepare("select id, lead_ms from deploys order by at").all() as any[];
  assert.deepEqual(d.map((x) => x.id), ["tag:v1.0.0", "tag:v1.1.0"]);
  assert.ok(d[1].lead_ms >= DAY && d[1].lead_ms <= 2 * DAY);
  // Changing the rule remakes the deploys without new commits.
  ingestGit(db, r.root, cfg());
  assert.equal((db.prepare("select count(*) as n from deploys").get() as any).n, 3);
  ingestGit(db, r.root, cfg());
  // A GitHub rule leaves no git deploys; an unknown tag commit leaves the lead time empty.
  gitDeploys(db, r.root, cfg({ deploy: "gh-deployments" }));
  assert.equal((db.prepare("select count(*) as n from deploys").get() as any).n, 0);
  db.exec("delete from commits");
  gitDeploys(db, r.root, cfg({ deploy: "tag:v1.0.0" }));
  assert.equal((db.prepare("select lead_ms from deploys").get() as any).lead_ms, null);
});

// @req R35
test("a failure while storing commits rolls back and is reported", () => {
  const r = new Repo();
  r.commit("one", { "a.txt": "1" }, T0);
  const db = openStore(":memory:");
  db.exec("drop table commit_files");
  assert.throws(() => ingestGit(db, r.root, cfg()));
  assert.equal(getMeta(db, "git:head"), null);
});

// @req R36
test("DORA bands follow the State of DevOps thresholds", () => {
  assert.deepEqual([2, 0.5, 0.1, 0.01, null].map(bandOf.frequency), ["elite", "high", "medium", "low", null]);
  assert.deepEqual([HOUR, 2 * DAY, 10 * DAY, 40 * DAY, null].map(bandOf.leadTime), ["elite", "high", "medium", "low", null]);
  assert.deepEqual([0.05, 0.1, 0.15, 0.5, null].map(bandOf.failureRate), ["elite", "high", "medium", "low", null]);
  assert.deepEqual([HOUR / 2, 2 * HOUR, 2 * DAY, 9 * DAY, null].map(bandOf.restore), ["elite", "high", "medium", "low", null]);
  assert.equal(doraRange("1h"), "7d");
  assert.equal(doraRange("today"), "7d");
  assert.equal(doraRange("30d"), "30d");
  assert.deepEqual(histogram([HOUR / 2, 2 * HOUR, 2 * DAY, 9 * DAY, 99 * DAY]).map((b) => b.count), [1, 1, 1, 1, 1]);
});

function seed(db: ReturnType<typeof openStore>) {
  const c = db.prepare("insert into commits (sha, at, authored_at, subject, ai, landed, revert_of) values (?, ?, ?, ?, ?, 1, ?)");
  const d = db.prepare("insert into deploys (id, at, source, sha, status, lead_ms) values (?, ?, ?, ?, ?, ?)");
  // d1 ok; d2 reverted by r1; d3 followed by a hotfix; d4 failed by status, restored by d5; d6 hit by an incident.
  c.run("a1", T0, T0, "feature", 1, null);
  d.run("git:a1", T0, "git", "a1", "success", HOUR);
  c.run("a2", T0 + DAY, T0 + DAY, "risky", 0, null);
  d.run("git:a2", T0 + DAY, "git", "a2", "success", 2 * HOUR);
  c.run("r1", T0 + DAY + 2 * HOUR, T0 + DAY + 2 * HOUR, 'Revert "risky"', 1, "a2");
  d.run("git:r1", T0 + DAY + 2 * HOUR, "git", "r1", "success", 0);
  c.run("a3", T0 + 2 * DAY, T0 + 2 * DAY, "thing", 0, null);
  d.run("git:a3", T0 + 2 * DAY, "git", "a3", "success", null);
  c.run("h1", T0 + 2 * DAY + 30 * 60_000, T0 + 2 * DAY, "hotfix: thing", 0, null);
  d.run("git:h1", T0 + 2 * DAY + 30 * 60_000, "git", "h1", "success", 10);
  d.run("git:a4", T0 + 3 * DAY, "git", null, "failure", null);
  d.run("git:a5", T0 + 3 * DAY + 3 * HOUR, "git", "zzz", "success", null);
  d.run("git:a6", T0 + 5 * DAY, "git", "a1", "success", null);
  db.prepare("insert into incidents (id, opened_at, resolved_at, source) values (?, ?, ?, 'gh')").run("i1", T0 + 5 * DAY + HOUR, T0 + 5 * DAY + 5 * HOUR);
  // Ignored: an unresolvable revert, a revert with no target, a stale incident, one before any deploy.
  c.run("r2", T0 + 6 * DAY, T0 + 6 * DAY, "Revert nothing", 0, "ffffff");
  db.prepare("insert into incidents (id, opened_at, resolved_at, source) values (?, ?, ?, 'gh')").run("i2", T0 + 20 * DAY, null);
  db.prepare("insert into incidents (id, opened_at, resolved_at, source) values (?, ?, ?, 'gh')").run("i0", T0 - DAY, null);
}

// @req R36
test("deploy failures: reverts, hotfixes, failed statuses and incidents, each with its time to restore", () => {
  const db = openStore(":memory:");
  seed(db);
  const all = db.prepare("select * from deploys").all() as any[];
  const f = failures(db, all, 72 * HOUR);
  assert.deepEqual(f.get("git:a2"), { cause: "revert", by: "r1", restoreMs: 2 * HOUR });
  assert.deepEqual(f.get("git:a3"), { cause: "hotfix", by: "h1", restoreMs: 30 * 60_000 });
  assert.deepEqual(f.get("git:a4"), { cause: "status", by: "git:a5", restoreMs: 3 * HOUR });
  assert.deepEqual(f.get("git:a6"), { cause: "incident", by: "i1", restoreMs: 4 * HOUR });
  assert.equal(f.size, 4);
  // A bare "Revert" with no sha marks the deploy before it.
  db.prepare("insert into commits (sha, at, authored_at, subject, landed, revert_of) values ('r3', ?, ?, 'Revert', 1, '?')").run(T0 + 5 * DAY + 10, T0);
  assert.equal(failures(db, all, 72 * HOUR).get("git:a6")!.cause, "revert");
  // A failed deploy never followed by a good one has no restore time yet.
  assert.deepEqual(failures(db, [{ id: "x", at: 1, source: "git", sha: null, status: "failure", lead_ms: null }], HOUR).get("x"), { cause: "status", by: null, restoreMs: null });
  // An open incident after a deploy fails it with no restore time yet.
  db.prepare("insert into incidents (id, opened_at, resolved_at, source) values ('i3', ?, null, 'gh')").run(T0 + 6 * DAY + HOUR);
  db.prepare("insert into deploys (id, at, source, sha, status) values ('git:a7', ?, 'git', null, 'success')").run(T0 + 6 * DAY);
  const all2 = db.prepare("select * from deploys").all() as any[];
  assert.deepEqual(failures(db, all2, 72 * HOUR).get("git:a7"), { cause: "incident", by: "i3", restoreMs: null });
  // Outside the window, nothing counts.
  assert.equal(failures(db, all, 1).size, 1);
});

// @req R36
test("DORA metrics over a range: frequency, lead time, failure rate, restore time, weeks and recent deploys", () => {
  const db = openStore(":memory:");
  seed(db);
  const now = T0 + 7 * DAY;
  const d = dora(db, "30d", now, cfg());
  assert.equal(d.source, "git");
  assert.equal(d.deploys, 8);
  assert.equal(d.failureRate.failed, 4);
  assert.equal(d.failureRate.rate, 0.5);
  assert.equal(d.failureRate.band, "low");
  assert.equal(d.leadTime.samples, 4);
  assert.equal(d.restore.samples, 4);
  assert.ok(d.frequency.perDay > 0.2);
  assert.ok(d.weeks.length >= 4);
  assert.equal(d.recent[0]!.id, "git:a6");
  assert.equal(d.recent.find((r) => r.id === "git:a4")!.sha, null);
  assert.equal(d.recent.find((r) => r.id === "git:a5")!.subject, null);
  assert.equal(d.recent.find((r) => r.id === "git:a1")!.ai, true);
  const all = dora(db, "all", now, cfg());
  assert.equal(all.deploys, 8);
  const hour = dora(db, "1h", now, cfg());
  assert.equal(hour.range, "7d");
  const gh = dora(db, "all", now, cfg({ deploy: "gh-deployments" }));
  assert.equal(gh.source, "gh");
  assert.equal(gh.deploys, 0);
  assert.equal(gh.frequency.band, null);
  assert.equal(gh.failureRate.rate, null);
});

// @req R36 R37
test("CI summary: pass rate, median time and the workflows that fail most", () => {
  const db = openStore(":memory:");
  const put = db.prepare("insert into ci_runs (id, workflow, at, duration_ms, conclusion) values (?, ?, ?, ?, ?)");
  put.run("1", "tests", T0, 60_000, "success");
  put.run("2", "tests", T0 + 1, 120_000, "failure");
  put.run("3", "lint", T0 + 2, null, "success");
  put.run("4", "lint", T0 + 3, 1000, "in_progress");
  put.run("5", "docs", T0 + 4, 1000, "success");
  put.run("6", "docs", T0 + 5, 1000, "success");
  const s = ciSummary(db, 0, T0 + DAY);
  assert.equal(s.runs, 5);
  assert.equal(s.passRate, 4 / 5);
  assert.equal(s.p50, 1000);
  assert.deepEqual(s.workflows.map((w) => [w.workflow, w.runs, w.failed]), [["tests", 2, 1], ["docs", 2, 0], ["lint", 1, 0]]);
  assert.equal(ciSummary(db, T0 + DAY, T0 + 2 * DAY).passRate, null);
});

function fakeGh(responses: Record<string, unknown>, calls: string[][] = []) {
  return (args: string[], cwd: string) => {
    calls.push([cwd, ...args]);
    const key = Object.keys(responses).find((k) => args.join(" ").startsWith(k));
    const v = key ? responses[key] : undefined;
    return v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);
  };
}

// @req R37
test("GitHub is read only when opted in, at most every ten minutes, through gh in the project folder", () => {
  const db = openStore(":memory:");
  const calls: string[][] = [];
  const run = fakeGh({}, calls);
  assert.equal(ingestGh(db, "/p", cfg(), T0, run), 0);
  assert.equal(calls.length, 0, "no gh process when off");
  ingestGh(db, "/p", cfg({ gh: true }), T0, run);
  assert.ok(calls.length > 0 && calls.every((c) => c[0] === "/p"));
  const n = calls.length;
  assert.equal(ingestGh(db, "/p", cfg({ gh: true }), T0 + 60_000, run), 0);
  assert.equal(calls.length, n, "not due yet");
  assert.equal(getMeta(db, "gh:at"), String(T0));
});

// @req R37
test("GitHub CI runs, deployments with their status, workflow deploys and incident issues are stored", () => {
  const db = openStore(":memory:");
  db.prepare("insert into commits (sha, at, authored_at, landed) values ('s1', ?, ?, 1)").run(T0 - HOUR, T0 - 2 * HOUR);
  const runs = [
    { databaseId: 1, workflowName: "deploy", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:05:00Z", status: "completed", conclusion: "success", headSha: "s1", headBranch: "main", event: "push" },
    { databaseId: 2, workflowName: "deploy", createdAt: "2026-10-02T12:00:00Z", updatedAt: "2026-10-02T12:01:00Z", status: "completed", conclusion: "failure", headSha: "nope" },
    { databaseId: 3, workflowName: "tests", createdAt: "2026-10-02T13:00:00Z", status: "in_progress" },
    { databaseId: 4, workflowName: "deploy", createdAt: "2026-10-03T12:00:00Z", status: "queued" },
    { databaseId: null, createdAt: "2026-10-02T13:00:00Z" },
    { databaseId: 5, createdAt: "never" },
    { databaseId: 6, createdAt: "2026-10-03T13:00:00Z", updatedAt: "2026-10-03T13:00:00Z", status: "completed" },
    { databaseId: 7, workflowName: "deploy", createdAt: "2026-10-03T14:00:00Z", status: "completed", conclusion: "success" },
    { databaseId: 8, workflowName: "deploy", createdAt: "2026-10-03T15:00:00Z" },
  ];
  const run = fakeGh({
    "run list": runs,
    "api repos/{owner}/{repo}/deployments?": [
      { id: 10, sha: "s1", created_at: "2026-10-01T13:00:00Z" },
      { id: 11, sha: 42, created_at: "2026-10-02T13:00:00Z" },
      { id: null, created_at: "2026-10-02T13:00:00Z" },
      { id: 12, created_at: "2026-10-03T13:00:00Z" },
    ],
    "api repos/{owner}/{repo}/deployments/10/statuses": [{ state: "success" }],
    "api repos/{owner}/{repo}/deployments/11/statuses": [{ state: "error" }],
    "issue list": [{ number: 7, createdAt: "2026-10-02T14:00:00Z", closedAt: "2026-10-02T15:00:00Z" }, { number: 8, createdAt: "2026-10-04T14:00:00Z", closedAt: null }, { number: null, createdAt: "x" }],
  });
  const n = ingestGh(db, "/p", cfg({ gh: true, deploy: "gh-deployments" }), T0, run);
  assert.ok(n >= 8);
  const ci = db.prepare("select id, duration_ms, conclusion from ci_runs order by id").all() as any[];
  assert.deepEqual(ci.map((r) => [r.id, r.duration_ms, r.conclusion]), [["1", 300_000, "success"], ["2", 60_000, "failure"], ["3", null, "in_progress"], ["4", null, "queued"], ["6", 0, ""], ["7", null, "success"], ["8", null, "running"]]);
  assert.equal((db.prepare("select workflow from ci_runs where id = '6'").get() as any).workflow, "");
  const dep = db.prepare("select id, status, lead_ms from deploys order by at").all() as any[];
  assert.deepEqual(dep.map((d) => [d.id, d.status]), [["gh:10", "success"], ["gh:11", "failure"], ["gh:12", "pending"]]);
  assert.equal(dep[0].lead_ms, Date.parse("2026-10-01T13:00:00Z") - (T0 - 2 * HOUR));
  assert.equal(dep[1].lead_ms, null);
  const inc = db.prepare("select id, resolved_at from incidents order by id").all() as any[];
  assert.deepEqual(inc.map((i) => i.id), ["gh:7", "gh:8"]);
  // A workflow as the deploy: its completed runs on that workflow.
  const db2 = openStore(":memory:");
  ingestGh(db2, "/p", cfg({ gh: true, deploy: "gh-workflow:deploy" }), T0, run);
  assert.deepEqual((db2.prepare("select id, status from deploys order by at").all() as any[]).map((d) => [d.id, d.status]), [["gh:run:1", "success"], ["gh:run:2", "failure"], ["gh:run:7", "success"]]);
  // Garbage or nothing from gh is skipped quietly.
  const db3 = openStore(":memory:");
  assert.equal(ingestGh(db3, "/p", cfg({ gh: true }), T0, fakeGh({ "run list": "not json", "issue list": '{"a":1}' })), 0);
});

// @req R37
test("GitHub statuses map to success, failure or pending, and a missing gh answers null", () => {
  assert.deepEqual(["success", "inactive", "failure", "error", "timed_out", "in_progress", undefined].map(normaliseStatus), ["success", "success", "failure", "failure", "failure", "pending", "pending"]);
  const old = process.env.PATH;
  process.env.PATH = tmp();
  try {
    assert.equal(ghRunner(["--version"], tmp()), null);
  } finally {
    process.env.PATH = old;
  }
});

// @req R35
test("store notes are kept by key and replaced on write", () => {
  const db = openStore(":memory:");
  assert.equal(getMeta(db, "k"), null);
  setMeta(db, "k", "1");
  setMeta(db, "k", "2");
  assert.equal(getMeta(db, "k"), "2");
});
