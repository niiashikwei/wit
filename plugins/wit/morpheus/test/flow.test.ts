import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf } from "../src/cost.ts";
import { dora } from "../src/dora.ts";
import { localPipeline, orchestration, reviewers, spend, stepOf, verdictKind, waitedOnYou } from "../src/flow.ts";
import { type Inputs, rank, SLOW_ANSWER_MS } from "../src/improvements.ts";
import { parseTranscriptLine } from "../src/parse.ts";
import { quality } from "../src/quality.ts";
import { openStore } from "../src/store.ts";
import { DEFAULTS } from "../src/config.ts";
import { renderAI, renderDelivery } from "../web/src/views.js";
import { tmp } from "./sdlc-helpers.ts";

const NOW = Date.UTC(2026, 10, 16, 15, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const has = (html: string, ...parts: string[]) => {
  for (const p of parts) assert.ok(html.includes(p), `expected ${JSON.stringify(p)} in output`);
};
const quiet: Inputs = { weeks: 1, now: NOW, hooks: [], rules: [], skills: [], agents: [], tools: [], kpis: { hints: 0, hintsConverted: 0, overrides: 0 }, defined: { hooks: [], skills: [], agents: [] }, lastActivity: null, timingSince: null };

// @req R56
test("the time sessions sat stopped waiting on the person is measured from each blocking ask to its answer", () => {
  const db = openStore(":memory:");
  const ask = db.prepare("insert into asks (tool_use_id, session, at, kind, text, blocked, answered_at) values (?, ?, ?, ?, 'x', ?, ?)");
  ask.run("q1", "s", NOW - 10 * HOUR, "question", 1, NOW - 10 * HOUR + 2 * MIN); // answered by its result: 2 min
  ask.run("p1", "s", NOW - 8 * HOUR, "plan", 1, NOW - 8 * HOUR + 40 * MIN); // 40 min
  ask.run("a1", "s", NOW - 6 * HOUR, "ask", 1, NOW - 6 * HOUR + MIN); // a go-ahead waits for the next prompt, not its result
  ask.run("a2", "s", NOW - 4 * HOUR, "ask", 0, null); // did not stop the session
  ask.run("a3", "s", NOW - HOUR, "ask", 1, null); // no prompt since: not answered yet
  ask.run("old", "s", NOW - 30 * 86_400_000, "question", 1, NOW - 30 * 86_400_000 + MIN);
  db.prepare("insert into prompts (session, at, text) values ('s', ?, 'go'), ('s', ?, 'later')").run(NOW - 6 * HOUR + 20 * MIN, NOW - 3 * HOUR);
  const w = waitedOnYou(db, NOW - 7 * 86_400_000, NOW);
  assert.deepEqual([w.asks, w.blocking, w.answered, w.slow], [5, 4, 3, 2]);
  assert.equal(w.totalMs, 62 * MIN);
  assert.equal(w.longest, 40 * MIN);
  assert.equal(w.p50, 20 * MIN);
  assert.ok(w.p90! > 20 * MIN && w.p90! <= 40 * MIN);
  const none = waitedOnYou(openStore(":memory:"), 0, NOW);
  assert.deepEqual([none.totalMs, none.p50, none.p90, none.longest], [0, null, null, null]);

  // Slow answers raise one improvement; a few slow ones, or a quick slowest tenth, do not.
  const item = rank({ ...quiet, waiting: { blocking: 9, answered: 8, totalMs: 5 * HOUR, p90: 30 * MIN, slow: 3 } });
  assert.equal(item.length, 1);
  assert.equal(item[0]!.id, "slow-answers");
  has(item[0]!.evidence, "3 of 8", "15 minutes", "5.0 h");
  assert.ok(item[0]!.minutesPerWeek > 0);
  assert.deepEqual(rank({ ...quiet, waiting: { blocking: 9, answered: 8, totalMs: 5 * HOUR, p90: 30 * MIN, slow: 2 } }), []);
  assert.deepEqual(rank({ ...quiet, waiting: { blocking: 9, answered: 8, totalMs: 5 * HOUR, p90: SLOW_ANSWER_MS, slow: 3 } }), []);
  assert.deepEqual(rank({ ...quiet, waiting: { blocking: 9, answered: 8, totalMs: 5 * HOUR, p90: null, slow: 3 } }), []);
});

// @req R57
test("the steps a command runs are named by its script or tool and subcommand, and waiting commands are not steps", () => {
  assert.equal(stepOf("bash scripts/ship.sh branch --device"), "ship.sh branch");
  assert.equal(stepOf("cd /repo && export PATH=/x:$PATH && npm run test:e2e -- --ci 2>&1 | tail -40"), "npm run test:e2e");
  assert.equal(stepOf("timeout 600 ./scripts/ci.sh full"), "ci.sh full");
  assert.equal(stepOf("nohup env pnpm --filter app test"), "pnpm");
  assert.equal(stepOf("npx jest src/a.test.ts"), "npx jest");
  assert.equal(stepOf("git push origin main"), "git push");
  assert.equal(stepOf("until ! pgrep -f ship.sh; do sleep 30; done"), null);
  assert.equal(stepOf("sleep 60 && tail -5 /tmp/log"), null);
  assert.equal(stepOf("cd app && git checkout -q x && rm -rf out && bash scripts/ship.sh merge a b > log"), "ship.sh merge", "set-up before the step is skipped");
  assert.equal(stepOf("set -e; (bash scripts/mutation.sh core src/a.ts)"), "mutation.sh core");
  assert.equal(stepOf("caffeinate -i bash -lc ./run.sh"), "run.sh");
  assert.equal(stepOf("git pull && emulator -avd x"), "git pull", "no script or build tool: the first command that is not set-up");
  assert.equal(stepOf("cd x && echo hi && date"), null, "only set-up");
  assert.equal(stepOf("bash"), null);
  assert.equal(stepOf(""), null);
  assert.equal(stepOf(null), null);

  // The command is kept next to its description.
  const call = { type: "assistant", sessionId: "s1", timestamp: new Date(NOW).toISOString(), uuid: "u", message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bash scripts/ship.sh merge", description: "Merge the batch", run_in_background: true } }] } };
  assert.equal(parseTranscriptLine(JSON.stringify(call)).bg![0]!.command, "bash scripts/ship.sh merge");
  const mon = { ...call, message: { id: "m", content: [{ type: "tool_use", id: "t2", name: "Monitor", input: { command: "tail -F x" } }] } };
  assert.equal(parseTranscriptLine(JSON.stringify(mon)).bg![0]!.command, null, "only background shell commands keep their command");
});

// @req R57
test("the local pipeline counts background runs by step, with failures, runs stopped by hand and the time failed runs took", () => {
  const db = openStore(":memory:");
  const put = db.prepare("insert into bg (tool_use_id, session, kind, label, command, started_at, ended_at, status) values (?, 's', ?, ?, ?, ?, ?, ?)");
  let n = 0;
  const run = (kind: string, label: string | null, command: string | null, mins: number, status: string | null, ago = 5 * HOUR) =>
    put.run(`t${n++}`, kind, label, command, NOW - ago, NOW - ago + mins * MIN, status);
  run("command", "Run the suite", "bash scripts/ship.sh full", 30, "completed");
  run("command", "Run the suite again", "bash scripts/ship.sh full --fast", 10, "failed");
  run("command", "Rerun after the fix", "bash scripts/ship.sh full", 20, "failed");
  run("command", "Run it once more", "bash scripts/ship.sh full", 40, "completed");
  run("command", "Serve the app", "npm run dev", 120, "stopped");
  run("command", "Wait for the suite", "until [ -f done ]; do sleep 5; done", 60, "failed");
  run("command", "Lint the code", null, 2, "completed"); // no command (an older store): grouped by its description
  run("command", null, null, 1, "completed"); // neither a command nor a description: nothing to group by
  run("agent", "review", null, 10, "completed");
  put.run(`t${n++}`, "command", "still going", "npm test", NOW - HOUR, null, null);
  run("command", "Last month", "npm test", 1, "failed", 40 * 86_400_000);
  const p = localPipeline(db, NOW - 7 * 86_400_000, NOW);
  assert.deepEqual([p.runs, p.failed, p.stopped], [6, 2, 1], "agents, waits, unfinished and older runs are left out");
  assert.equal(p.failRate, 2 / 5, "runs stopped by hand are neither passes nor failures");
  assert.equal(p.lostMs, 30 * MIN, "only failed runs count as lost time");
  assert.equal(p.ms, 222 * MIN);
  const ship = p.steps[0]!;
  assert.deepEqual([ship.step, ship.runs, ship.failed, ship.stopped, ship.lostMs, ship.p50, ship.label], ["ship.sh full", 4, 2, 0, 30 * MIN, 30 * MIN, "Run it once more"]);
  assert.deepEqual(p.steps.map((s) => s.step), ["ship.sh full", "npm run dev", "lint the code"]);
  assert.equal(p.steps[1]!.p50, null, "no completed run, no usual time");
  const none = localPipeline(openStore(":memory:"), 0, NOW);
  assert.deepEqual([none.runs, none.failRate, none.steps], [0, null, []]);

  // A step that keeps failing raises an improvement; at most three of them.
  const step = (s: string, runs: number, failed: number) => ({ step: s, label: s === "b" ? null : `Run ${s}`, runs, failed, lostMs: failed * 10 * MIN });
  const items = rank({ ...quiet, pipeline: { steps: [step("a", 10, 4), step("b", 6, 3), step("c", 20, 3), step("d", 4, 2), step("e", 9, 3), step("f", 9, 3)] } });
  assert.deepEqual(items.map((i) => i.id).sort(), ["pipeline:a", "pipeline:b", "pipeline:e"], "three or more failures, in at least a fifth of runs; three at most");
  const b = items.find((i) => i.id === "pipeline:b")!;
  has(b.title, '"b"');
  has(b.evidence, "3 of 6", "30 minutes");
  has(items.find((i) => i.id === "pipeline:a")!.title, "Run a");
});

// @req R58
test("each session's main thread is costed next to the agents it started", () => {
  const db = openStore(":memory:");
  const put = db.prepare("insert into usage (session, message_id, agent_id, at, model, tokens_in, tokens_out, tokens_cached, tokens_write) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let n = 0;
  const use = (session: string, agent: string | null, tokensOut: number, at = NOW - HOUR) => put.run(session, `m${n++}`, agent, at, "claude-opus-4-1", 1000, tokensOut, 0, 0);
  use("lead", null, 30_000);
  use("lead/agent-a1", null, 10_000); // an agent's own file
  use("lead", "a2", 10_000); // an agent's reply recorded with its id
  use("solo", null, 50_000);
  use("lead", null, 999_999, NOW - 30 * 86_400_000);
  db.prepare("insert into session_titles (session, title) values ('lead', 'Ship it')").run();
  const c = (out: number) => costOf("claude-opus-4-1", { tokensIn: 1000, tokensOut: out, tokensCached: 0, tokensWrite: 0 });
  const o = orchestration(db, NOW - 7 * 86_400_000, NOW);
  assert.ok(Math.abs(o.main - c(30_000) - c(50_000)) < 1e-9);
  assert.ok(Math.abs(o.agents - 2 * c(10_000)) < 1e-9);
  assert.ok(Math.abs(o.mainShare! - o.main / (o.main + o.agents)) < 1e-9);
  assert.equal(o.sessions.length, 1, "only sessions that started agents are listed");
  assert.deepEqual([o.sessions[0]!.session, o.sessions[0]!.title], ["lead", "Ship it"]);
  assert.ok(Math.abs(o.sessions[0]!.mainShare - c(30_000) / (c(30_000) + 2 * c(10_000))) < 1e-9);
  use("other", "z", 1);
  assert.equal(orchestration(db, NOW - 7 * 86_400_000, NOW).sessions[1]!.title, null);
  const none = orchestration(openStore(":memory:"), 0, NOW);
  assert.deepEqual([none.main, none.agents, none.mainShare, none.sessions], [0, 0, null, []]);
});

// @req R59
test("each review agent's catch rate is its change requests among its verdicts, next to what its runs cost", () => {
  assert.deepEqual(["changes-required", "request-changes", "block", "approve", "approved", "lgtm", "pass", "shrug", null, ""].map(verdictKind), ["changes", "changes", "changes", "approve", "approve", "approve", "approve", null, null, null]);
  const db = openStore(":memory:");
  const put = db.prepare("insert into agents (agent_id, session, agent_type, first_at, last_at, model, verdict, tokens_in, tokens_out, tokens_cached) values (?, 's', ?, ?, ?, 'claude-sonnet-4-5', ?, 1000, 2000, 0)");
  let n = 0;
  const agent = (type: string, verdict: string | null, at = NOW - HOUR) => put.run(`a${n++}`, type, at, at + MIN, verdict);
  for (let i = 0; i < 3; i++) agent("code-review", "approve");
  agent("code-review", "changes-required");
  agent("code-review", null);
  agent("security-reviewer", null);
  agent("security-reviewer", null);
  agent("feature-developer", "approve"); // not a reviewer
  agent("code-review", "changes-required", NOW - 30 * 86_400_000); // out of range
  const r = reviewers(db, NOW - 7 * 86_400_000, NOW);
  const each = costOf("claude-sonnet-4-5", { tokensIn: 1000, tokensOut: 2000, tokensCached: 0 });
  assert.deepEqual(r.map((x) => [x.name, x.runs, x.approved, x.changes, x.noVerdict]), [["code-review", 5, 3, 1, 1], ["security-reviewer", 2, 0, 0, 2]]);
  assert.equal(r[0]!.catchRate, 0.25);
  assert.ok(Math.abs(r[0]!.cost - 5 * each) < 1e-9 && Math.abs(r[0]!.costPerCatch! - 5 * each) < 1e-9);
  assert.deepEqual([r[1]!.catchRate, r[1]!.costPerCatch], [null, null]);

  // A reviewer that approved everything (ten or more verdicts) raises an improvement.
  const rv = (name: string, approved: number, changes: number) => ({ name, runs: approved + changes, approved, changes, cost: 12.4 });
  const items = rank({ ...quiet, reviewers: [rv("lenient", 12, 0), rv("useful", 30, 5), rv("new", 9, 0)] });
  assert.deepEqual(items.map((i) => i.id), ["reviewer:lenient"]);
  has(items[0]!.title, "all 12");
  has(items[0]!.evidence, "$12");
  assert.deepEqual(items[0]!.link, { kind: "agent", name: "lenient" });
});

// @req R60
test("Delivery gives what Claude cost per deploy, and the local pipeline, over the DORA range", () => {
  const db = openStore(":memory:");
  db.prepare("insert into usage (session, message_id, at, model, tokens_in, tokens_out, tokens_cached, tokens_write) values ('s', 'm1', ?, 'claude-opus-4-1', 10000, 20000, 0, 0), ('s', 'm2', ?, 'claude-opus-4-1', 1, 1, 0, 0)").run(NOW - DAYS(2), NOW - DAYS(60));
  const spent = costOf("claude-opus-4-1", { tokensIn: 10000, tokensOut: 20000, tokensCached: 0, tokensWrite: 0 });
  assert.ok(Math.abs(spend(db, NOW - DAYS(7), NOW) - spent) < 1e-9);
  const cfg = { ...DEFAULTS, deploy: "merge-to-main" };
  assert.deepEqual(dora(db, "7d", NOW, cfg).cost, { total: spend(db, NOW - DAYS(7), NOW), perDeploy: null }, "no deploys: no cost per deploy");
  db.prepare("insert into deploys (id, at, source, sha, status) values ('git:a', ?, 'git', 'a', 'success'), ('git:b', ?, 'git', 'b', 'success')").run(NOW - DAYS(3), NOW - DAYS(1));
  const d = dora(db, "7d", NOW, cfg);
  assert.ok(Math.abs(d.cost.perDeploy! - spent / 2) < 1e-9);
  assert.equal(d.pipeline.runs, 0);
});

const DAYS = (n: number) => n * 86_400_000;

// @req R56 R58 R59
test("the AI tab shows time waited on you, the main session's share and the reviewers' catch rates", () => {
  const db = openStore(":memory:");
  const q = quality(db, tmp(), "7d", NOW);
  assert.deepEqual([q.waiting.blocking, q.orchestration.mainShare, q.reviewers], [0, null, []], "quality carries the flow numbers");
  const base = renderAI(q, null);
  has(base, "Sessions waited on you", "Main session and agents", "No sessions started agents", "No review agents ran");
  const full = renderAI(
    {
      ...q,
      waiting: { asks: 30, blocking: 20, answered: 19, totalMs: 4 * HOUR, p50: 52_000, p90: 27 * MIN, longest: HOUR, slow: 4 },
      orchestration: { main: 538, agents: 243, mainShare: 0.69, sessions: [{ session: "abcdef123456", title: null, main: 500, agents: 200, mainShare: 0.71 }, { session: "x", title: "DFH main", main: 38, agents: 43, mainShare: 0.47 }] },
      reviewers: [
        { name: "dfh-review", runs: 100, approved: 80, changes: 20, noVerdict: 0, cost: 50, catchRate: 0.2, costPerCatch: 2.5 },
        { name: "silent-reviewer", runs: 9, approved: 0, changes: 0, noVerdict: 9, cost: 3, catchRate: null, costPerCatch: null },
      ],
    },
    null,
  );
  has(full, "4.0 h", "20 questions", "52 s", "slowest tenth over 27 min", "69%", "$538 main", "$243 agents", "abcdef12", "DFH main", "dfh-review", "20%", "no verdict", "$2.50 per change request", "20 change requests in 100 verdicts");
  assert.ok(full.includes('class="kpi warn"'), "slow answers and a heavy main session are flagged");
  const calm = renderAI({ ...q, waiting: { ...q.waiting, p90: 5 * MIN }, orchestration: { main: 1, agents: 9, mainShare: 0.1, sessions: [] } }, null);
  assert.ok(calm.includes('class="kpi good"'));
  assert.equal(renderAI({ ...q, waiting: undefined }, null).includes("Sessions waited on you"), false, "older numbers without the flow section still render");
});

// @req R57 R60
test("the Delivery tab shows the local pipeline by step and Claude's cost per deploy", () => {
  const db = openStore(":memory:");
  const cfg = { ...DEFAULTS, deploy: "merge-to-main" };
  const d = dora(db, "30d", NOW, cfg);
  has(renderDelivery(d), "Local pipeline", "No background commands in this range", "Claude cost per deploy");
  const pipeline = {
    runs: 40, failed: 6, stopped: 2, failRate: 6 / 38, ms: 20 * HOUR, lostMs: 3 * HOUR,
    steps: [
      { step: "ship.sh full", label: "Run the suite", runs: 10, failed: 4, stopped: 0, ms: 5 * HOUR, lostMs: 2 * HOUR, p50: 30 * MIN },
      { step: "npm run dev", label: null, runs: 10, failed: 1, stopped: 2, ms: HOUR, lostMs: 0, p50: null },
      { step: "npm test", label: "Tests", runs: 5, failed: 0, stopped: 0, ms: HOUR, lostMs: 0, p50: MIN },
    ],
  };
  const html = renderDelivery({ ...d, deploys: 7, pipeline, cost: { total: 781, perDeploy: 111.6 } });
  has(html, "Run the suite", "npm run dev", "Tests", "$112", "$781 over 7 deploys", "30 min", "2.0 h", "16%", "6 failed · 2 stopped by hand");
  assert.ok(html.includes("p-bad") && html.includes("p-warn"), "a step failing a fifth of its runs or more stands out");
  const good = renderDelivery({ ...d, pipeline: { ...pipeline, failRate: 0.01, lostMs: 0 } });
  assert.ok(good.includes('class="kpi good"'));
  const mid = renderDelivery({ ...d, pipeline: { ...pipeline, failRate: 0.1 } });
  assert.ok(mid.includes('class="kpi warn"'));
  assert.equal(renderDelivery({ ...d, pipeline: undefined }).includes("Local pipeline"), false, "older numbers without the pipeline still render");
  has(renderDelivery({ ...d, pipeline, cost: undefined }), "$0 over");
});

// @req R57
test("background commands keep their command in the store", () => {
  const db = openStore(":memory:");
  const p = parseTranscriptLine(JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: new Date(NOW).toISOString(), uuid: "u", message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", run_in_background: true } }] } }));
  assert.equal(p.bg![0]!.command, "npm test");
  db.prepare("insert into bg (tool_use_id, session, kind, label, command, started_at) values ('t', 's', 'command', 'l', 'npm test', 1)").run();
  assert.equal((db.prepare("select command from bg").get() as { command: string }).command, "npm test");
});
