import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ingest } from "../src/ingest.ts";
import { parseTranscriptLine } from "../src/parse.ts";
import { slug } from "../src/paths.ts";
import { eta, family, status, tidy } from "../src/status.ts";
import { openStore } from "../src/store.ts";
import { fmtClock, fmtUntil } from "../web/src/format.js";
import { renderStatus } from "../web/src/views.js";
import { tmp } from "./sdlc-helpers.ts";

const NOW = Date.UTC(2026, 10, 16, 15, 0);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const has = (html: string, ...parts: string[]) => {
  for (const p of parts) assert.ok(html.includes(p), `expected ${JSON.stringify(p)} in output`);
};

const at = (ms: number, extra: Record<string, unknown>) => ({ sessionId: "s1", timestamp: iso(ms), uuid: `u${ms}`, cwd: "/r/.claude/worktrees/trunk", gitBranch: "trunk", ...extra });
const call = (ms: number, id: string, name: string, input: Record<string, unknown>) =>
  at(ms, { type: "assistant", message: { id: `m${id}`, content: [{ type: "tool_use", id, name, input }] } });
const result = (ms: number, id: string, text: string) => at(ms, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const notice = (ms: number, body: string) => at(ms, { type: "attachment", attachment: { type: "queued_command", prompt: `<task-notification>\n${body}\n</task-notification>` } });

// @req R54
test("session titles, background work, its notices and the questions Claude asks are read from transcripts", () => {
  const title = parseTranscriptLine(JSON.stringify({ type: "custom-title", customTitle: "  Ship the batch  ", sessionId: "s1" }));
  assert.deepEqual(title.titles, [{ session: "s1", title: "Ship the batch" }], "a title has no timestamp and is still read");
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "agent-name", agentName: "Ship", sessionId: "s1" })).titles, [{ session: "s1", title: "Ship" }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "custom-title", customTitle: " ", sessionId: "s1" })).titles, []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "custom-title", customTitle: "x", sessionId: "s1" }), { agent: "a" }).titles, [], "an agent's file names no session");

  const bash = parseTranscriptLine(JSON.stringify(call(NOW, "t1", "Bash", { command: "bash scripts/ship.sh merge a b", description: "Merge the batch", run_in_background: true })));
  assert.deepEqual(bash.bg, [{ toolUseId: "t1", session: "s1", at: NOW, kind: "command", label: "Merge the batch", command: "bash scripts/ship.sh merge a b" }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify(call(NOW, "t2", "Bash", { command: "ls" }))).bg, [], "a command in the foreground");
  assert.equal(parseTranscriptLine(JSON.stringify(call(NOW, "t3", "Agent", { prompt: "watch CI", subagent_type: "ci-watcher", run_in_background: true }))).bg![0]!.kind, "agent");
  assert.equal(parseTranscriptLine(JSON.stringify(call(NOW, "t4", "Monitor", { command: "tail -F x", description: "suite steps" }))).bg![0]!.label, "suite steps");
  assert.equal(parseTranscriptLine(JSON.stringify(call(NOW, "t5", "Bash", { command: "npm test", run_in_background: true }))).bg![0]!.label, "npm test");

  assert.deepEqual(parseTranscriptLine(JSON.stringify(result(NOW, "t1", "Command running in background with ID: bx9. Output is being written to: /x"))).bgIds, [{ toolUseId: "t1", taskId: "bx9" }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify(result(NOW, "t4", "Monitor started (task bov1, expires in 30m)"))).bgIds, [{ toolUseId: "t4", taskId: "bov1" }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify(result(NOW, "t9", "done"))).bgIds, []);
  const mixed = at(NOW, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t7", is_error: true, content: ["Command running in background with ID: z1", { type: "text", text: "and more" }, { type: "image" }] }] } });
  const m = parseTranscriptLine(JSON.stringify(mixed));
  assert.deepEqual([m.bgIds, m.marks], [[{ toolUseId: "t7", taskId: "z1" }], []], "a result made of parts; an error that is not a denial");

  const done = parseTranscriptLine(JSON.stringify(notice(NOW, "<task-id>bx9</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Merge\" completed</summary>")));
  assert.deepEqual(done.notices, [{ session: "s1", at: NOW, taskId: "bx9", toolUseId: "t1", status: "completed", summary: 'Background command "Merge" completed', event: null }]);
  assert.equal(parseTranscriptLine(JSON.stringify(notice(NOW, "<summary>Background command &quot;a &amp;&amp; b &lt;x&gt; it&#39;s&quot; done</summary>"))).notices![0]!.summary, `Background command "a && b <x> it's" done`);
  const ev = parseTranscriptLine(JSON.stringify(notice(NOW, "<task-id>bov1</task-id>\n<summary>Monitor event</summary>\n<event>✔ 845s</event>")));
  assert.deepEqual([ev.notices![0]!.toolUseId, ev.notices![0]!.status, ev.notices![0]!.event], [null, null, "✔ 845s"]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify(at(NOW, { type: "attachment", attachment: { type: "queued_command", prompt: "hello" } }))).notices, [], "a queued prompt is not a notice");
  const idle = parseTranscriptLine(JSON.stringify(at(NOW, { type: "user", message: { content: "<system-reminder>x</system-reminder><task-notification>\n<task-id>bcu4</task-id>\n<tool-use-id>t8</tool-use-id>\n<status>completed</status>\n</task-notification>" } })));
  assert.deepEqual([idle.notices!.map((n) => [n.taskId, n.toolUseId, n.status]), idle.prompts], [[["bcu4", "t8", "completed"]], []], "a notice that came while Claude was idle, as its own message, is not a prompt");
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ ...at(NOW, { type: "user", message: { content: "<task-notification><status>completed</status></task-notification>" } }), isSidechain: true }), { agent: "a1" }).notices, [], "an agent's own notices stay with the agent");

  assert.deepEqual(parseTranscriptLine(JSON.stringify(call(NOW, "s1", "TaskStop", { task_id: "bx9" }))).notices!.map((n) => [n.taskId, n.status]), [["bx9", "stopped"]]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify(call(NOW, "s2", "TaskStop", { shell_id: "old1" }))).notices!.map((n) => n.taskId), ["old1"], "the old name for the id");
  assert.deepEqual(parseTranscriptLine(JSON.stringify(call(NOW, "s3", "TaskStop", {}))).notices, [], "no id, nothing stopped");
  const q = parseTranscriptLine(JSON.stringify(call(NOW, "q1", "AskUserQuestion", { questions: [{ question: "Which way?" }] })));
  assert.deepEqual(q.asks, [{ session: "s1", at: NOW, toolUseId: "q1", kind: "question", text: "Which way?", blocked: true }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify(call(NOW, "p1", "ExitPlanMode", { plan: "x" }))).asks![0]!.kind, "plan");
  const wrap = (input: Record<string, unknown>) => parseTranscriptLine(JSON.stringify(call(NOW, "w1", "mcp__ccd_turn__wrap_up", { recap: "r", ...input }))).asks!;
  assert.deepEqual(wrap({ ask: "Pause AgentDVR?", blocked: true }).map((a) => [a.kind, a.text, a.blocked]), [["ask", "Pause AgentDVR?", true]]);
  assert.equal(wrap({ ask: "Push?" })[0]!.blocked, false, "a go-ahead that can wait");
  assert.deepEqual(wrap({}), [], "a recap with nothing to ask");
});

// @req R54
test("through ingest: titles kept, background work ended by its notice, questions answered by their result", () => {
  const root = tmp();
  const projects = tmp();
  const dir = join(projects, slug(root));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), jsonl([
    { type: "custom-title", customTitle: "Ship it", sessionId: "s1" },
    call(NOW - 30 * MIN, "t1", "Bash", { command: "bash ship.sh", run_in_background: true }),
    result(NOW - 30 * MIN, "t1", "Command running in background with ID: bx9."),
    call(NOW - 20 * MIN, "t4", "Monitor", { command: "tail", description: "steps" }),
    result(NOW - 20 * MIN, "t4", "Monitor started (task bov1, expires in 30m)"),
    notice(NOW - 15 * MIN, "<task-id>bov1</task-id>\n<event>✔ 845s</event>"),
    notice(NOW - 10 * MIN, "<task-id>bx9</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<summary>done</summary>"),
    notice(NOW - 9 * MIN, "<task-id>bov1</task-id>\n<status>killed</status>"),
    call(NOW - 5 * MIN, "q1", "AskUserQuestion", { questions: [{ question: "Which?" }] }),
    result(NOW - 4 * MIN, "q1", "Option A"),
    call(NOW - 3 * MIN, "w1", "mcp__ccd_turn__wrap_up", { recap: "r", ask: "Push?" }),
    result(NOW - 3 * MIN, "w1", "Shown"),
  ]));
  const db = openStore(":memory:");
  ingest(db, { root, projectsDir: projects, logDirs: [] });
  assert.equal((db.prepare("select title from session_titles").get() as { title: string }).title, "Ship it");
  const bg = db.prepare("select tool_use_id, task_id, status, ended_at from bg order by started_at").all() as { tool_use_id: string; task_id: string; status: string; ended_at: number }[];
  assert.deepEqual(bg.map((b) => [b.tool_use_id, b.task_id, b.status, b.ended_at]), [["t1", "bx9", "completed", NOW - 10 * MIN], ["t4", "bov1", "killed", NOW - 9 * MIN]], "the monitor ends by its task id, not by its event");
  const asks = db.prepare("select tool_use_id, answered_at from asks order by at").all() as { tool_use_id: string; answered_at: number | null }[];
  assert.deepEqual(asks.map((a) => [a.tool_use_id, a.answered_at]), [["q1", NOW - 4 * MIN], ["w1", null]], "a go-ahead's result is not its answer");
  assert.equal((db.prepare("select count(*) as n from notices").get() as { n: number }).n, 3);
});

// @req R55
test("work kinds and finish times: the same kind of work, its median and 90th percentile, overdue past it", () => {
  assert.equal(family("bash scripts/ship.sh merge fix/a-b 5ead1958b333"), "bash scripts ship.sh merge");
  assert.equal(family("node /usr/local/lib/tool.js run"), "node tool.js run", "a long path is its last part");
  assert.equal(family("Watch CI for 5ead1958"), "watch ci for");
  assert.equal(family(null), "");
  assert.equal(tidy('export PATH=/x/bin:$PATH; bash scripts/ship.sh branch > /tmp/out.log 2>&1'), "bash scripts/ship.sh branch");
  assert.equal(tidy('PATH="$HOME/bin:$PATH" CI=1 npx jest --silent | tail -40'), "npx jest --silent");
  assert.equal(tidy("Watch CI run until it finishes"), "Watch CI run until it finishes", "a description stays as it is");
  assert.equal(tidy('export PATH="$HOME/.nvm/bin:$PATH" && bash scripts/ship.sh branch'), "bash scripts/ship.sh branch");
  assert.equal(tidy("cd /Users/me/DFH/.claude/worktrees/trunk && export PATH=/x:$PATH && npm test"), "npm test");
  assert.equal(tidy("FOO=1"), "FOO=1", "nothing left: the label as it came");
  assert.equal(tidy(null), null);
  assert.deepEqual(eta(NOW, [MIN], NOW), { p50: null, p90: null, eta: null, overdue: false, samples: 1 });
  const e = eta(NOW - 10 * MIN, [10 * MIN, 12 * MIN, 14 * MIN, 30 * MIN], NOW);
  assert.equal(e.samples, 4);
  assert.ok(e.p50! >= 12 * MIN && e.p50! <= 14 * MIN);
  assert.equal(e.eta, NOW - 10 * MIN + e.p50!);
  assert.equal(e.overdue, false);
  assert.equal(eta(NOW - 60 * MIN, [10 * MIN, 12 * MIN], NOW).overdue, true);
});

/** A store with one of everything the status reads. */
function fixture() {
  const db = openStore(":memory:");
  const run = db.prepare("insert into runs (id, kind, name, session, branch, cwd, started_at, outcome, tool_use_id, agent_id) values (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)");
  const bg = db.prepare("insert into bg (tool_use_id, session, kind, label, task_id, started_at, ended_at, status, summary) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.prepare("insert into session_titles (session, title) values ('s1', 'Ship the batch')").run();
  // s1: working, in a worktree, with a question waiting.
  run.run("r1", "tool", "Bash", "s1", "trunk", "/r/.claude/worktrees/trunk/apps", NOW - MIN, null, null);
  db.prepare("insert into prompts (session, at, text) values ('s1', ?, 'merge the batch'), ('s2', ?, 'yes'), ('s3', ?, 'go')").run(NOW - 60 * MIN, NOW - 2 * MIN, NOW - 100 * MIN);
  db.prepare("insert into asks (tool_use_id, session, at, kind, text, blocked) values ('q1', 's1', ?, 'question', 'Which way?', 1)").run(NOW - 5 * MIN);
  db.prepare("insert into asks (tool_use_id, session, at, kind, text, blocked) values ('q0', 's1', ?, 'plan', 'old', 1)").run(NOW - 50 * MIN);
  // s2: its go-ahead was answered by a later prompt; idle.
  run.run("r2", "tool", "Read", "s2", null, null, NOW - 30 * MIN, null, null);
  db.prepare("insert into asks (tool_use_id, session, at, kind, text, blocked) values ('w1', 's2', ?, 'ask', 'Push?', 0)").run(NOW - 10 * MIN);
  // s3: API calls failing since its last reply; s4: failed once, then replied.
  db.prepare("insert into usage (session, message_id, at) values ('s3', 'm1', ?), ('s4', 'm2', ?)").run(NOW - 20 * MIN, NOW - 5 * MIN);
  db.prepare("insert into marks (session, at, type) values ('s3', ?, 'api_error'), ('s4', ?, 'api_error')").run(NOW - 10 * MIN, NOW - 6 * MIN);
  run.run("r3", "tool", "Bash", "s3", null, null, NOW - 10 * MIN, null, null);
  // Old session, outside the day.
  run.run("r4", "tool", "Bash", "old", null, null, NOW - 30 * 3_600_000, null, null);
  // History of the ship command, and three running now: on time, no history, overdue.
  for (const [i, m] of [10, 12, 14].entries()) bg.run(`h${i}`, "s1", "command", "bash scripts/ship.sh merge x", null, NOW - 9 * 3_600_000, NOW - 9 * 3_600_000 + m * MIN, "completed", null);
  bg.run("h9", "s1", "command", "bash scripts/ship.sh merge x", null, NOW - 9 * 3_600_000, NOW - 8 * 3_600_000, "failed", null);
  bg.run("b1", "s1", "command", "bash scripts/ship.sh merge y", "bx1", NOW - 5 * MIN, null, null, null);
  bg.run("b2", "s1/agent-a1", "command", "first ever job", null, NOW - 2 * MIN, null, null, null);
  bg.run("b3", "s1", "command", "bash scripts/ship.sh merge z", null, NOW - 40 * MIN, null, null, null);
  bg.run("b4", "s1", "command", "Wait for the smoke", null, NOW - 4 * 3_600_000, null, null, null);
  // A monitor with an event, and one past its half hour.
  bg.run("m1", "s1", "monitor", "suite steps", "bov1", NOW - 10 * MIN, null, null, null);
  bg.run("m2", "s1", "monitor", "old watch", null, NOW - 40 * MIN, null, null, null);
  bg.run("m3", "s1", "monitor", "quiet watch", null, NOW - 5 * MIN, null, null, null);
  db.prepare("insert into notices (session, at, task_id, event) values ('s1', ?, 'bov1', '✔ 845s'), ('s1', ?, 'bov1', '✖ e2e')").run(NOW - 8 * MIN, NOW - 4 * MIN);
  // Finished lately: a completed job, a failed agent, a deploy.
  bg.run("d1", "s2", "command", "npm test", null, NOW - 60 * MIN, NOW - 50 * MIN, "completed", "Background command done");
  bg.run("d2", "s2", "agent", "review", null, NOW - 40 * MIN, NOW - 30 * MIN, "failed", null);
  bg.run("d3", "s2", "command", null, null, NOW - 200 * MIN, NOW - 100 * MIN, "completed", "Background command finished");
  db.prepare("insert into deploys (id, at, source, sha, status) values ('tag:v1.0.6', ?, 'git', 'a', 'success')").run(NOW - 90 * MIN);
  // Agents: one running in the foreground (with history), one started in the background (counted once), one quiet.
  const agent = db.prepare("insert into agents (agent_id, session, agent_type, description, first_at, last_at, finished) values (?, ?, ?, ?, ?, ?, ?)");
  agent.run("a1", "s1", "dfh-review", "Review the batch", NOW - 3 * MIN, NOW - MIN, 0);
  agent.run("a0", "s1", "dfh-review", "earlier", NOW - 5 * 3_600_000, NOW - 5 * 3_600_000 + 4 * MIN, 1);
  agent.run("a9", "s1", "dfh-review", "earlier", NOW - 6 * 3_600_000, NOW - 6 * 3_600_000 + 6 * MIN, 1);
  agent.run("a2", "s1", "ci-watcher", "Watch CI", NOW - 3 * MIN, NOW - MIN, 0);
  agent.run("a3", null, null, null, NOW - 3 * MIN, NOW - MIN, 0);
  agent.run("a4", "s1", "x", "gone quiet", NOW - 60 * MIN, NOW - 30 * MIN, 0);
  bg.run("ab", "s1", "agent", "Watch CI", null, NOW - 3 * MIN, null, null, null);
  run.run("r5", "agent", "ci-watcher", "s1", null, null, NOW - 3 * MIN, "ab", "a2");
  // Edge cases: an answered question, an untitled session waiting, an old error, an error in a session already waiting.
  db.prepare("insert into asks (tool_use_id, session, at, kind, text, blocked, answered_at) values ('q2', 's2', ?, 'question', 'Old?', 1, ?)").run(NOW - 20 * MIN, NOW - 19 * MIN);
  db.prepare("insert into asks (tool_use_id, session, at, kind, text, blocked) values ('p5', 's5', ?, 'plan', 'A plan to approve', 1)").run(NOW - 7 * MIN);
  run.run("r6", "tool", "Read", "s6", null, null, NOW - 10 * MIN, null, null);
  db.prepare("insert into marks (session, at, type) values ('s6', ?, 'api_error'), ('s1', ?, 'api_error')").run(NOW - 30 * MIN, NOW - MIN);
  bg.run("b5", "s2", "command", "npm run build", null, NOW - MIN, null, null, null);
  agent.run("a5", "s2", null, "untyped", NOW - 7 * 3_600_000, NOW - 7 * 3_600_000 + MIN, 1);
  agent.run("a6", "s2", "Explore", null, NOW - 2 * MIN, NOW - MIN, 0);
  // CI: one running with history, one finished.
  const ci = db.prepare("insert into ci_runs (id, workflow, at, duration_ms, conclusion, branch) values (?, ?, ?, ?, ?, ?)");
  ci.run("c1", "ci", NOW - 4 * 3_600_000, 8 * MIN, "success", "main");
  ci.run("c2", "ci", NOW - 3 * 3_600_000, 10 * MIN, "failure", "main");
  ci.run("c3", "ci", NOW - 3 * MIN, null, null, "main");
  ci.run("c4", "e2e", NOW - 2 * MIN, null, null, null);
  return db;
}

// @req R55
test("the status lists what waits on you, what runs with when it should finish, the sessions and what finished", () => {
  const s = status(fixture(), NOW);
  assert.deepEqual(s.waiting.filter((w) => w.session !== "s5").map((w) => [w.session, w.kind, w.text, w.blocked, w.title]), [
    ["s3", "api", "API calls are failing: the sign-in may have expired", true, null],
    ["s1", "question", "Which way?", true, "Ship the batch"],
  ], "oldest first; the newest ask per session; an answered go-ahead and a recovered session are not listed");
  const by = Object.fromEntries(s.inFlight.map((f) => [f.label, f]));
  assert.equal(by["bash scripts/ship.sh merge z"]!.overdue, true);
  assert.ok(!by["Wait for the smoke"], "four hours with no notice: never reported back");
  assert.equal(s.unreported, 1);
  assert.equal(s.inFlight[0]!.label, "bash scripts/ship.sh merge z", "overdue work first");
  assert.equal(by["bash scripts/ship.sh merge y"]!.samples, 3, "failed runs don't set the usual time");
  assert.equal(by["bash scripts/ship.sh merge y"]!.eta, NOW - 5 * MIN + 12 * MIN);
  assert.deepEqual([by["first ever job"]!.eta, by["first ever job"]!.session], [null, "s1"], "no history, no finish time; an agent's job counts with its session");
  assert.equal(by["suite steps"]!.detail, "✖ e2e", "a monitor shows its newest event");
  assert.equal(by["quiet watch"]!.detail, null);
  assert.ok(!by["old watch"], "a monitor past its half hour has stopped");
  assert.equal(by["Review the batch"]!.samples, 2);
  assert.equal(by["Review the batch"]!.detail, "dfh-review");
  assert.equal(s.inFlight.filter((f) => f.label === "Watch CI").length, 1, "a background agent is counted once");
  assert.ok(!by["gone quiet"]);
  assert.equal(by["npm run build"]!.title, null);
  assert.deepEqual([by.Explore!.title, by.Explore!.session], [null, "s2"], "an agent with no description is named by its type");
  assert.equal(by.e2e!.eta, null, "a workflow with no finished runs");
  assert.ok(s.waiting.some((w) => w.session === "s5" && w.kind === "plan" && w.title === null));
  assert.ok(!s.waiting.some((w) => w.session === "s6"), "an error from before the session's last work");
  assert.ok(!s.waiting.some((w) => w.session === "s2"), "an answered question");
  assert.equal(s.waiting.filter((w) => w.session === "s1").length, 1, "a waiting session is listed once");
  assert.equal(by.ci!.kind, "ci");
  assert.equal(by.ci!.detail, "main");
  assert.equal(by.ci!.samples, 2);
  assert.ok(s.inFlight.some((f) => f.kind === "agent" && f.label === null && f.session === ""), "an agent with no session or type");
  const sessions = Object.fromEntries(s.sessions.map((x) => [x.session, x]));
  assert.deepEqual([sessions.s1!.state, sessions.s1!.worktree, sessions.s1!.branch, sessions.s1!.prompt, sessions.s1!.title], ["waiting", "trunk", "trunk", "merge the batch", "Ship the batch"]);
  assert.equal(sessions.s2!.state, "working", "its build runs in the background");
  assert.equal(sessions.s4!.state, "idle");
  assert.equal(sessions.s4!.prompt, null);
  assert.ok(!sessions.old);
  assert.ok(!sessions["s1/agent-a1"], "an agent's activity counts with its session");
  assert.equal(s.sessions[0]!.state, "waiting");
  assert.deepEqual(s.recent.map((r) => [r.kind, r.label, r.status]), [["agent", "review", "failed"], ["command", "npm test", "completed"], ["deploy", "v1.0.6", "success"], ["command", "Background command finished", "completed"]], "newest first, by what the work was called, else its notice");
  assert.equal(s.recent[1]!.durationMs, 10 * MIN);
  assert.deepEqual(s.updates.map((u) => [u.event, u.label]), [["✖ e2e", "suite steps"], ["✔ 845s", "suite steps"]]);
  // A session that is busy right now, with nothing running in the background.
  const db = openStore(":memory:");
  db.prepare("insert into runs (id, kind, name, session, started_at, outcome) values ('x', 'tool', 'Read', 's9', ?, 'ok')").run(NOW - 30_000);
  assert.equal(status(db, NOW).sessions[0]!.state, "working");
  assert.deepEqual(status(openStore(":memory:"), NOW), { now: NOW, waiting: [], inFlight: [], unreported: 0, sessions: [], recent: [], updates: [] });
});

// @req R55
test("the Status tab shows what waits on you, what runs and when it should finish, the sessions and what finished", () => {
  const d = status(fixture(), NOW);
  const html = renderStatus(d);
  has(html, "Waiting on you", "Question", "Ship the batch", "Which way?", "the session is stopped until you answer", "Sign-in", "the sign-in may have expired",
    "Running now", "overdue: usually done by", "no history yet", "from 3 earlier runs", "✖ e2e", "Monitor", "Agent", "CI", "GitHub",
    "Sessions", "Waiting on you</span>", "worktree trunk", "merge the batch", "Idle",
    "Finished lately", "npm test", "failed", "Deploy", "v1.0.6", "Latest updates", "✔ 845s", "kpi warn", "kpi bad", "aria-label=",
    "1 older background job started in the last day never reported back", "is not listed");
  has(renderStatus({ ...d, unreported: 2 }), "2 older background jobs", "are not listed");
  // On time, and running long but not yet overdue.
  const f = (startedAt: number, p50: number, p90: number) => ({ kind: "command", session: "s1", title: null, label: "job", startedAt, p50, p90, eta: startedAt + p50, overdue: NOW > startedAt + p90, samples: 3, detail: null });
  const onTime = renderStatus({ ...d, inFlight: [f(NOW - 2 * MIN, 10 * MIN, 20 * MIN)] }, NOW);
  has(onTime, `about ${fmtClock(NOW + 8 * MIN)} (in 8 min)`, "p-good", "s1");
  has(renderStatus({ ...d, inFlight: [f(NOW - 12 * MIN, 10 * MIN, 20 * MIN)] }, NOW), "running long: usually 10 min", "p-warn");
  // Nothing at all.
  const none = renderStatus({ now: NOW, waiting: [], inFlight: [], unreported: 0, sessions: [], recent: [], updates: [] });
  assert.ok(!none.includes("never reported back"));
  has(none, "Nothing is waiting on you.", "Nothing is running in the background.", "No session was active in the last day.", "Nothing finished in the last six hours.", "No monitor events lately.", "nothing to answer", "kpi good");
  // A go-ahead that can wait, a session with no prompt, an unnamed update.
  const quiet = renderStatus({ ...d, waiting: [{ session: "abcdefghij", title: null, kind: "ask", text: null, blocked: false, since: NOW - MIN }], updates: [{ session: "s1", at: NOW, event: "x", label: null }], sessions: [{ ...d.sessions[0]!, worktree: null, branch: null, prompt: null, promptAt: null, title: null, session: "" }] }, NOW);
  has(quiet, "Go-ahead", "abcdefgh", "monitor ·", "p-unknown");
  // Kinds the page has no word for are shown as they come.
  has(renderStatus({ ...d, waiting: [{ ...d.waiting[0]!, kind: "poll" }], inFlight: [{ ...d.inFlight[0]!, kind: "job" }], recent: [{ ...d.recent[0]!, kind: "note" }, { ...d.recent[0]!, label: null, durationMs: null }] }, NOW), "poll", "job", "note", "– <span class=\"meta\">");
  has(renderStatus(null), "Waiting");
  assert.ok(renderStatus({ ...d, now: undefined } as never).includes("Running now"), "without a time from the tool, the page's clock");
});

// @req R55
test("times of day and time until a moment read naturally", () => {
  assert.equal(fmtClock(new Date(2026, 10, 16, 9, 5).getTime()), "09:05");
  assert.equal(fmtUntil(NOW + 30_000, NOW), "in 30 s");
  assert.equal(fmtUntil(NOW + 12 * MIN, NOW), "in 12 min");
  assert.equal(fmtUntil(NOW + 90 * MIN, NOW), "in 1.5 h");
  assert.equal(fmtUntil(NOW - 5 * MIN, NOW), "5 min ago");
});
