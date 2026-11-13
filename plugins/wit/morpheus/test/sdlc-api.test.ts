import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, refreshSdlc, TOOLS, tests, testsView } from "../src/api.ts";
import { handle } from "../src/mcp.ts";
import { DAY, Repo, tmp } from "./sdlc-helpers.ts";

const NOW = Date.now();
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

function fixture() {
  const r = new Repo();
  r.write("tests/test_cart.py", "def test_add(): pass\ndef test_remove(): pass\n");
  r.write("e2e/login.spec.ts", 'test("logs in", () => {})\n');
  r.write("src/cart.py", "x = 1\n");
  r.commit("Add cart\n\nCo-Authored-By: Claude <noreply@anthropic.com>", {}, NOW - 2 * DAY);
  r.write("junit.xml", '<testsuite><testcase name="test_add" time="0.5"/><testcase name="logs in" time="2"><failure/></testcase></testsuite>');
  r.write("coverage/lcov.info", "SF:src/cart.py\nLF:10\nLH:8\nend_of_record\n");
  mkdirSync(join(r.root, ".claude"), { recursive: true });
  writeFileSync(join(r.root, ".claude", "wit.json"), JSON.stringify({ gh: true }));
  const projectsDir = tmp();
  const p = project(r.root, { db: ":memory:", projectsDir });
  const calls: string[][] = [];
  p.gh = (args) => (calls.push(args), args[0] === "run" ? JSON.stringify([{ databaseId: 1, workflowName: "ci", createdAt: new Date(NOW - DAY).toISOString(), updatedAt: new Date(NOW - DAY + 60_000).toISOString(), status: "completed", conclusion: "success" }]) : "[]");
  return { r, p, calls };
}

// @req R35 R37 R38
test("the SDLC sources are read with the transcripts, at most every 15 seconds, with wit.json re-read each time", () => {
  const { p, calls } = fixture();
  const n = refreshSdlc(p, NOW);
  assert.ok(n >= 3, "a commit, two reports and a CI run");
  assert.equal(p.cfg.gh, true);
  assert.ok(calls.length > 0);
  assert.equal(refreshSdlc(p, NOW + 1000), 0);
  assert.equal(refreshSdlc(p, NOW + 20_000), 0, "nothing new");
});

// @req R39
test("tests in the source are found again at most once a minute", () => {
  const { r, p } = fixture();
  const first = tests(p, NOW);
  assert.equal(first.length, 3);
  r.write("tests/test_more.py", "def test_more(): pass\n");
  assert.equal(tests(p, NOW + 1000), first);
  assert.equal(tests(p, NOW + 61_000).length, 4);
});

// @req R39 R44
test("the tests tool gives the pyramid, a drilled node, history, slowest, failing and the reports read", () => {
  const { p } = fixture();
  refreshSdlc(p, NOW);
  const v = testsView(p, {}, NOW) as any;
  assert.equal(v.grouping, "layer");
  assert.deepEqual(v.path, []);
  assert.equal(v.pyramid.tests, 3);
  assert.equal(v.slowest[0].name, "logs in");
  assert.equal(v.failing[0].name, "logs in");
  assert.deepEqual(v.flaky, []);
  assert.equal(v.reports.length, 2);
  assert.equal(v.history.runs.length, 1);
  const drilled = testsView(p, { path: "unit|tests", grouping: "layer" }, NOW) as any;
  assert.deepEqual(drilled.path, ["unit", "tests"]);
  assert.equal(drilled.node.coverage.lines, 0.8);
  const feature = testsView(p, { grouping: "feature" }, NOW) as any;
  assert.equal(feature.grouping, "feature");
  // A test that passed in one run and failed in the next is listed as flaky.
  p.db.prepare("insert into test_reports (path, hash, at, kind) values ('older.xml', 'ffffffffffffffff', ?, 'tests')").run(NOW - DAY);
  p.db.prepare("insert into test_cases (report, id, name, status, at) values ('older.xml@ffffffffffff', 'x', 'test_add', 'failed', ?)").run(NOW - DAY);
  const flaky = testsView(p, {}, NOW) as any;
  assert.deepEqual(flaky.flaky.map((t: any) => t.name), ["test_add"]);
});

// @req R29 R36 R40 R41 R42 R43
test("the SDLC tools answer through the API and are listed read-only over MCP", () => {
  const { p } = fixture();
  refreshSdlc(p, NOW);
  const health = tool("morpheus_health").run(p, { range: "30d" }, NOW) as any;
  assert.equal(health.stages.length, 8);
  assert.equal(health.pyramid.tests, 3);
  assert.equal(health.dora.deploys, 1);
  assert.equal(health.ai.commits, 1);
  assert.ok(Array.isArray(health.improvements));
  const d = tool("morpheus_dora").run(p, { range: "30d" }, NOW) as any;
  assert.equal(d.ci.runs, 1);
  const t = tool("morpheus_tasks").run(p, { range: "7d", sort: "cost", category: "feature" }, NOW) as any;
  assert.equal(t.count, 0);
  assert.equal((tool("morpheus_tasks").run(p, { sort: "bogus", category: "" }, NOW) as any).count, 0);
  const res = tool("morpheus_resources").run(p, {}, NOW) as any;
  assert.ok(res.sampledAt);
  const again = tool("morpheus_resources").run(p, {}, NOW + 10) as any;
  assert.equal(again.sampledAt, res.sampledAt, "a fresh sample is reused");
  assert.equal((tool("morpheus_tests").run(p, { grouping: "feature" }, NOW) as any).grouping, "feature");
  const inv = tool("morpheus_inventory").run(p, {}, NOW) as any;
  assert.equal(inv.root, p.root);
  const q = tool("morpheus_quality").run(p, { range: "30d" }, NOW) as any;
  assert.equal(q.ai.commits, 1);
  const list = handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { call: () => null }) as any;
  const names = list.result.tools.map((x: any) => x.name);
  for (const n of ["morpheus_health", "morpheus_dora", "morpheus_tests", "morpheus_tasks", "morpheus_resources", "morpheus_quality"]) assert.ok(names.includes(n), n);
  assert.ok(list.result.tools.every((x: any) => x.annotations.readOnlyHint));
});
