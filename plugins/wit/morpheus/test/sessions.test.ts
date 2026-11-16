import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HEAVY_CONTEXT, type Inputs, rank } from "../src/improvements.ts";
import { ingest, transcripts } from "../src/ingest.ts";
import { parseTranscriptLine } from "../src/parse.ts";
import { slug } from "../src/paths.ts";
import { contextBySession, quality } from "../src/quality.ts";
import { tasksReport } from "../src/tasks.ts";
import { openStore } from "../src/store.ts";
import { tmp } from "./sdlc-helpers.ts";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const prompt = (s: string, at: number, text: string) => ({ sessionId: s, timestamp: iso(at), type: "user", message: { content: text } });
const reply = (s: string, at: number, id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: s, timestamp: iso(at), type: "assistant", ...extra,
  message: { id, model: "claude-opus-5-5", content: [], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 } },
});

// @req R46
test("a session copied into several worktree folders is read once, from its largest copy", () => {
  const root = tmp();
  const projects = tmp();
  const main = join(projects, slug(root));
  const wt = join(projects, `${slug(root)}--claude-worktrees-trunk`);
  for (const d of [main, wt]) mkdirSync(join(d, "s1", "subagents"), { recursive: true });
  const early = [prompt("s1", NOW - 5000, "first"), reply("s1", NOW - 4000, "m1")];
  const later = [...early, prompt("s1", NOW - 3000, "second"), reply("s1", NOW - 2000, "m2")];
  // The older copy stopped growing when the session moved to the worktree.
  writeFileSync(join(main, "s1.jsonl"), jsonl(early));
  writeFileSync(join(wt, "s1.jsonl"), jsonl(later));
  // Agent transcripts are copied too; here the main folder's copy is the larger one.
  const agentRows = [{ ...reply("s1", NOW - 3500, "a1"), isSidechain: true }];
  writeFileSync(join(main, "s1", "subagents", "agent-x.jsonl"), jsonl([...agentRows, { ...reply("s1", NOW - 3400, "a2"), isSidechain: true }]));
  writeFileSync(join(wt, "s1", "subagents", "agent-x.jsonl"), jsonl(agentRows));
  writeFileSync(join(main, "s2.jsonl"), jsonl([prompt("s2", NOW - 1000, "other")]));

  const files = transcripts([main, wt]);
  assert.deepEqual(files.map((f) => [f.path, f.session, f.agent ?? null]), [
    [join(wt, "s1.jsonl"), "s1", null],
    [join(main, "s2.jsonl"), "s2", null],
    [join(main, "s1", "subagents", "agent-x.jsonl"), "s1", "x"],
  ]);
  assert.equal(files[2]!.meta, join(main, "s1", "subagents", "agent-x.meta.json"));

  const db = openStore(":memory:");
  const lines = ingest(db, { root, projectsDir: projects, logDirs: [] });
  assert.equal(lines, 4 + 1 + 2, "each line of the copies read once");
  assert.equal((db.prepare("select count(*) as n from prompts").get() as { n: number }).n, 3);
  assert.equal((db.prepare("select count(*) as n from usage").get() as { n: number }).n, 4);
});

// @req R47
test("Stop hook summaries, API errors, PR links and silent-turn reminders are read from transcripts", () => {
  const base = { sessionId: "s1", timestamp: iso(NOW - 1000), uuid: "u1", cwd: "/r", gitBranch: "trunk" };
  const stop = parseTranscriptLine(JSON.stringify({
    ...base, type: "system", subtype: "stop_hook_summary", toolUseID: "t1",
    hookInfos: [{ command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/stop-checks.sh', durationMs: 470 }, { command: "callback" }, { command: "./lint.sh" }, null],
    hookErrors: [], preventedContinuation: false, stopReason: "",
  }));
  assert.deepEqual(stop.runs.map((r) => [r.id, r.name, r.detail, r.durationMs, r.outcome, r.branch]), [
    ["hook:t1:Stop:stop-checks:0", "stop-checks", "Stop", 470, "ok", "trunk"],
    ["hook:t1:Stop:lint:2", "lint", "Stop", null, "ok", "trunk"],
  ]);
  const failed = parseTranscriptLine(JSON.stringify({ ...base, type: "system", subtype: "stop_hook_summary", hookEvent: "SubagentStop", hookInfos: [{ command: "./a.sh", durationMs: 9 }], hookErrors: ["exit 2: tests failing"] }));
  assert.deepEqual([failed.runs[0]!.id, failed.runs[0]!.detail, failed.runs[0]!.outcome, failed.runs[0]!.output], ["hook:u1:SubagentStop:a:0", "SubagentStop", "error", "exit 2: tests failing"]);
  const blocked = parseTranscriptLine(JSON.stringify({ ...base, type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "./a.sh" }], preventedContinuation: true, stopReason: "finish the tests" }));
  assert.deepEqual([blocked.runs[0]!.outcome, blocked.runs[0]!.output], ["block", "finish the tests"]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ ...base, type: "system", subtype: "stop_hook_summary" })).runs, [], "no hooks listed");
  const bare = parseTranscriptLine(JSON.stringify({ sessionId: "s1", timestamp: iso(NOW), uuid: "u2", type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "./a.sh" }] }));
  assert.deepEqual([bare.runs[0]!.branch, bare.runs[0]!.cwd], [null, null], "a summary line without a branch or folder");

  assert.deepEqual(parseTranscriptLine(JSON.stringify({ ...base, type: "system", subtype: "api_error", error: { status: 401 } })).marks, [{ session: "s1", at: NOW - 1000, type: "api_error" }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ ...base, type: "attachment", attachment: { type: "silent_turn_reminder", text: "say something" } })).marks, [{ session: "s1", at: NOW - 1000, type: "silent" }]);
  const pr = { sessionId: "s1", timestamp: iso(NOW - 1000), type: "pr-link", prNumber: 357, prUrl: "https://github.com/o/r/pull/357", prRepository: "o/r" };
  assert.deepEqual(parseTranscriptLine(JSON.stringify(pr)).prs, [{ session: "s1", at: NOW - 1000, repo: "o/r", number: 357, url: "https://github.com/o/r/pull/357" }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ ...pr, prUrl: 5 })).prs![0]!.url, null);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ ...pr, prNumber: "x" })).prs, [], "a link without a number is skipped");

  // Through ingest: one row per pull request, spanning when it was first and last seen.
  const root = tmp();
  const projects = tmp();
  const dir = join(projects, slug(root));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), jsonl([
    { ...pr, timestamp: iso(NOW - 5000) }, { ...pr, timestamp: iso(NOW - 1000) }, { ...pr, timestamp: iso(NOW - 9000) },
    { ...base, type: "system", subtype: "api_error" },
    { ...base, type: "system", subtype: "stop_hook_summary", toolUseID: "t9", hookInfos: [{ command: "./stop.sh", durationMs: 30 }] },
  ]));
  const db = openStore(":memory:");
  ingest(db, { root, projectsDir: projects, logDirs: [] });
  assert.deepEqual({ ...(db.prepare("select repo, number, first_at, last_at from prs").get() as object) }, { repo: "o/r", number: 357, first_at: NOW - 9000, last_at: NOW - 1000 });
  assert.equal((db.prepare("select count(*) as n from marks where type = 'api_error'").get() as { n: number }).n, 1);
  assert.equal((db.prepare("select duration_ms from runs where name = 'stop'").get() as { duration_ms: number }).duration_ms, 30);
});

// @req R48
test("context carried per reply is measured by session, with agents counted under their session and its cache-read cost", () => {
  const db = openStore(":memory:");
  const put = db.prepare("insert into usage (session, message_id, at, model, tokens_in, tokens_out, tokens_cached, tokens_write) values (?, ?, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 60; i++) put.run("heavy", `h${i}`, NOW - 1000 - i, "claude-opus-5-5", 1000, 100, 299_000, 500);
  put.run("heavy/agent-x", "a1", NOW - 900, "claude-haiku-5-5", 1000, 100, 9_000, 0);
  put.run("heavy", "syn", NOW - 800, "<synthetic>", 0, 0, 0, 0);
  put.run("light", "l1", NOW - 700, "claude-opus-5-5", 1000, 100, 20_000, 0);
  put.run("light", "l2", NOW - 600, null, 1000, 100, 20_000, 0);
  put.run("old", "o1", NOW - 40 * 86_400_000, "claude-opus-5-5", 1, 1, 900_000, 0);
  const rows = contextBySession(db, NOW - 86_400_000, NOW);
  assert.deepEqual(rows.map((r) => [r.session, r.replies, Math.round(r.contextPerReply)]), [["heavy", 61, Math.round((60 * 300_000 + 10_000) / 61)], ["light", 2, 21_000]]);
  assert.ok(Math.abs(rows[0]!.cacheReadCost - (60 * 299_000 * 0.2 + 9_000 * 0.01) / 1e6) < 1e-9);
  assert.equal(rows[0]!.lastAt, NOW - 900);
  assert.equal(rows[1]!.cacheReadCost, (20_000 * 0.2) / 1e6, "a reply with no model costs nothing");

  // quality() reports the totals, the heavy sessions, and the session events.
  db.prepare("insert into marks (session, at, type) values ('heavy', ?, 'api_error'), ('heavy', ?, 'silent'), ('heavy', ?, 'compact')").run(NOW - 5, NOW - 6, NOW - 7);
  db.prepare("insert into prs (repo, number, session, first_at, last_at) values ('o/r', 1, 'heavy', ?, ?), ('o/r', 2, 'heavy', ?, ?)").run(NOW - 9, NOW - 9, NOW - 50 * 86_400_000, NOW - 50 * 86_400_000);
  const q = quality(db, tmp(), "7d", NOW);
  assert.equal(q.efficiency.heavySessions.map((s) => s.session).join(), "heavy");
  assert.ok(q.efficiency.contextPerReply! > 280_000);
  assert.ok(Math.abs(q.efficiency.cacheReadCost - rows[0]!.cacheReadCost - rows[1]!.cacheReadCost) < 1e-9);
  assert.ok(q.efficiency.cacheReadShare! > 0.5 && q.efficiency.cacheReadShare! < 1);
  assert.deepEqual([q.process.apiErrors, q.process.silentTurns, q.process.compactions, q.process.prs], [1, 1, 1, 1]);
  const empty = quality(openStore(":memory:"), tmp(), "7d", NOW);
  assert.deepEqual([empty.efficiency.contextPerReply, empty.efficiency.cacheReadShare, empty.efficiency.heavySessions], [null, null, []]);
});

// @req R48
test("sessions over 200k tokens of context a reply raise one improvement, led by the heaviest", () => {
  const quiet: Inputs = { weeks: 1, now: NOW, hooks: [], rules: [], skills: [], agents: [], tools: [], kpis: { hints: 0, hintsConverted: 0, overrides: 0 }, defined: { hooks: [], skills: [], agents: [] }, lastActivity: null, timingSince: null };
  const s = (session: string, replies: number, contextPerReply: number, cacheReadCost: number) => ({ session, replies, contextPerReply, cacheReadCost });
  assert.deepEqual(rank({ ...quiet, sessions: [s("a", 49, 900_000, 9), s("b", 500, HEAVY_CONTEXT, 9)] }), [], "too few replies, or not over the line");
  const one = rank({ ...quiet, sessions: [s("043ede56-0573", 7380, 422_680, 624)] });
  assert.equal(one.length, 1);
  assert.deepEqual([one[0]!.id, one[0]!.title, one[0]!.area], ["heavy-context", "Start fresh sessions sooner", "tokens"]);
  assert.equal(one[0]!.evidence, "Session 043ede56 re-reads 423k tokens on each of 7380 replies: $624 of cache reads.");
  assert.equal(one[0]!.minutesPerWeek, Math.round((7380 * (222_680 / 100_000)) / 60));
  const two = rank({ ...quiet, sessions: [s("x", 100, 400_000, 50), s("y", 100, 300_000, 20)] });
  assert.equal(two[0]!.title, "Start fresh sessions sooner (2 sessions over 200k a reply)");
});

// @req R52
test("cost is summed by git branch across sessions and their agents, most expensive first", () => {
  const db = openStore(":memory:");
  const put = db.prepare("insert into usage (session, message_id, at, branch, model, tokens_in, tokens_out, tokens_cached, tokens_write) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  put.run("s1", "m1", NOW - 5000, "feat/a", "claude-opus-5-5", 1000, 500, 100_000, 0);
  put.run("s1/agent-x", "m2", NOW - 4000, "feat/a", "claude-haiku-5-5", 1000, 500, 10_000, 0);
  put.run("s2", "m3", NOW - 3000, "feat/a", "claude-sonnet-5-5", 10, 10, 10, 0);
  put.run("s2", "m4", NOW - 2000, "trunk", "claude-opus-5-5", 10, 10, 10, 0);
  put.run("s3", "m5", NOW - 1000, null, "claude-opus-5-5", 1, 1, 1, 0);
  put.run("s3", "m6", NOW - 40 * 86_400_000, "old", "claude-opus-5-5", 1e6, 1e6, 0, 0);
  const r = tasksReport(db, { range: "7d" }, NOW);
  assert.deepEqual(r.byBranch.map((b) => [b.branch, b.replies, b.tokensNew, b.tokensCached, b.sessions, b.lastAt]), [
    ["feat/a", 3, 3020, 110_010, 2, NOW - 3000], // s1 on Opus, its agent on Haiku, s2 on Sonnet: two sessions
    ["trunk", 1, 20, 10, 1, NOW - 2000],
    [null, 1, 2, 1, 1, NOW - 1000],
  ]);
  assert.ok(r.byBranch[0]!.cost > r.byBranch[1]!.cost);
});

// @req R53
test("hook time that holds the work up is totalled per prompt: before prompts, tool calls and turn ends", () => {
  const db = openStore(":memory:");
  const hook = db.prepare("insert into runs (id, kind, name, detail, session, started_at, duration_ms, outcome) values (?, 'hook', ?, ?, 's', ?, ?, 'ok')");
  hook.run("h1", "skill-hints", "UserPromptSubmit", NOW - 900, 5000);
  hook.run("h2", "bash-guard", "PreToolUse:Bash", NOW - 800, 2500);
  hook.run("h3", "stop-checks", "Stop", NOW - 700, 500);
  hook.run("h4", "after-edit", "PostToolUse:Edit", NOW - 600, 9000);
  hook.run("h5", "session-start", "SessionStart:resume", NOW - 500, 9000);
  hook.run("h6", "untimed", "PreToolUse:Read", NOW - 400, null);
  hook.run("h7", "old", "PreToolUse:Bash", NOW - 40 * 86_400_000, 99_000);
  db.prepare("insert into prompts (session, at, text) values ('s', ?, 'a'), ('s', ?, 'b')").run(NOW - 1000, NOW - 300);
  const p = quality(db, tmp(), "7d", NOW).process;
  assert.deepEqual([p.hookWaitMs, p.hookWaitPerPrompt], [8000, 4000]);
  assert.equal(quality(openStore(":memory:"), tmp(), "7d", NOW).process.hookWaitPerPrompt, null);
});
