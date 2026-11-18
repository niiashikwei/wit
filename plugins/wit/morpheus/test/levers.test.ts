import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf } from "../src/cost.ts";
import { type Inputs, rank } from "../src/improvements.ts";
import { ciWatching, contextBands, FAST_HOOK_MS, hotHooks, levers, watchKind } from "../src/levers.ts";
import { openStore } from "../src/store.ts";
import { renderLevers } from "../web/src/views.js";

const NOW = Date.UTC(2026, 10, 17, 15, 0);
const MIN = 60_000;
const OPUS = "claude-opus-4-7";
const has = (html: string, ...parts: string[]) => {
  for (const p of parts) assert.ok(html.includes(p), `expected ${JSON.stringify(p)} in output`);
};
const quiet: Inputs = { weeks: 1, now: NOW, hooks: [], rules: [], skills: [], agents: [], tools: [], kpis: { hints: 0, hintsConverted: 0, overrides: 0 }, defined: { hooks: [], skills: [], agents: [] }, lastActivity: null, timingSince: null };

function store() {
  const db = openStore(":memory:");
  let n = 0;
  const use = db.prepare("insert into usage (session, message_id, agent_id, at, model, tokens_in, tokens_out, tokens_cached, tokens_write) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const reply = (session: string, at: number, context: number, opts: { agent?: string; model?: string } = {}) =>
    use.run(session, `m${n++}`, opts.agent ?? null, at, opts.model ?? OPUS, 1000, 500, context - 1000, 0);
  const run = db.prepare("insert into runs (id, kind, name, detail, session, started_at, duration_ms, outcome, trigger, agent_id) values (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)");
  const tool = (session: string, at: number, name: string, command: string | null = null, agent: string | null = null) =>
    run.run(`t${n++}`, "tool", name, null, session, at, 10, command, agent);
  const hook = (name: string, detail: string | null, ms: number, at = NOW - 10 * MIN) => run.run(`h${n++}`, "hook", name, detail, "s", at, ms, null, null);
  return { db, reply, tool, hook };
}

// @req R65
test("the main session's replies are banded by the context they carried, with the cache reads above 200k priced", () => {
  const { db, reply } = store();
  reply("s", NOW - 50 * MIN, 50_000);
  reply("s", NOW - 40 * MIN, 150_000);
  reply("s", NOW - 30 * MIN, 300_000);
  reply("s", NOW - 20 * MIN, 500_000);
  reply("s", NOW - 10 * MIN, 900_000);
  reply("s", NOW - 5 * MIN, 900_000, { agent: "a1" }); // an agent's reply: not the main session
  reply("s/agent-x", NOW - 5 * MIN, 900_000); // from an agent's own transcript
  reply("s", NOW - 3 * MIN, 300_000, { model: "<synthetic>" }); // no price
  const c = contextBands(db, NOW - 3600_000, NOW);
  assert.equal(c.replies, 6);
  assert.deepEqual(c.bands.map((b) => b.replies), [1, 1, 2, 1, 1]);
  assert.deepEqual(c.bands.map((b) => b.max), [100_000, 200_000, 400_000, 800_000, null]);
  assert.equal(c.heavyReplies, 4);
  assert.equal(c.heavyShare, 4 / 6);
  // Cache reads above 200k on Opus 4.7 ($0.50 a million): 100k + 300k + 700k.
  assert.ok(Math.abs(c.overCap - (1_100_000 * 0.5) / 1e6) < 1e-9);
  const cost = [50_000, 150_000, 300_000, 500_000, 900_000].reduce((s, x) => s + costOf(OPUS, { tokensIn: 1000, tokensOut: 500, tokensCached: x - 1000 }), 0);
  assert.ok(Math.abs(c.cost - cost) < 1e-9);
  assert.equal(c.overCapShare, c.overCap / c.cost);
  const none = contextBands(openStore(":memory:"), 0, NOW);
  assert.deepEqual([none.replies, none.heavyShare, none.overCapShare, none.overCap], [0, null, null, 0]);
});

// @req R66
test("calls that watch CI and PRs are told apart from work", () => {
  assert.equal(watchKind("Bash", "sleep 60 && gh run view 1"), "poll loop");
  assert.equal(watchKind("Bash", "until gh pr checks 4; do sleep 30; done"), "poll loop");
  assert.equal(watchKind("Bash", "gh pr checks 12 --watch"), "gh");
  assert.equal(watchKind("Bash", "cd app && gh run watch 99"), "gh");
  assert.equal(watchKind("Bash", "gh api repos/o/r/commits/abc/check-runs | jq ."), "gh");
  assert.equal(watchKind("Bash", "gh pr create --fill"), null);
  assert.equal(watchKind("Bash", "npm test"), null);
  assert.equal(watchKind("Bash", null), null);
  assert.equal(watchKind("mcp__ccd_pr__get_status", null), "PR tools");
  assert.equal(watchKind("Monitor", null), "Monitor");
  assert.equal(watchKind("ScheduleWakeup", null), "ScheduleWakeup");
  assert.equal(watchKind("mcp__github__get_workflow_run", null), "get_workflow_run");
  assert.equal(watchKind("Edit", null), null);
});

// @req R66
test("each check on CI from the main session costs the reply that read its result", () => {
  const { db, reply, tool } = store();
  tool("s", NOW - 30 * MIN, "Bash", "gh pr checks 3");
  reply("s", NOW - 29 * MIN, 400_000);
  tool("s", NOW - 20 * MIN, "Bash", "sleep 120; gh run view 7");
  reply("s", NOW - 18 * MIN, 600_000);
  tool("s", NOW - 10 * MIN, "mcp__ccd_pr__set_monitor");
  reply("s", NOW - 9 * MIN, 600_000);
  tool("s", NOW - 8 * MIN, "Edit"); // work
  tool("s", NOW - 7 * MIN, "Bash", "gh pr checks 3", "agent-1"); // an agent's check: not the main session
  tool("t", NOW - 2 * MIN, "Monitor"); // no reply after it yet
  const w = ciWatching(db, NOW - 3600_000, NOW);
  assert.deepEqual([w.calls, w.mainCalls], [4, 5]);
  assert.equal(w.share, 4 / 5);
  const each = (ctx: number) => costOf(OPUS, { tokensIn: 1000, tokensOut: 500, tokensCached: ctx - 1000 });
  assert.ok(Math.abs(w.cost - (each(400_000) + 2 * each(600_000))) < 1e-9);
  assert.equal(w.perCall, w.cost / 3);
  assert.equal(w.contextPerCall, (400_000 + 600_000 + 600_000) / 3);
  assert.deepEqual(w.kinds.map((k) => [k.kind, k.calls]), [["poll loop", 1], ["PR tools", 1], ["gh", 1], ["Monitor", 1]]);
  assert.equal(w.kinds.at(-1)!.cost, 0);
  const none = ciWatching(openStore(":memory:"), 0, NOW);
  assert.deepEqual([none.calls, none.share, none.perCall, none.contextPerCall], [0, null, null, null]);
});

// @req R67
test("hooks that run on every call are ranked by the time they add above a fast hook", () => {
  const { db, hook } = store();
  for (let i = 0; i < 120; i++) hook("guard", "PreToolUse:Bash", 600);
  for (let i = 0; i < 120; i++) hook("quick", "PreToolUse:Bash", 50);
  for (let i = 0; i < 120; i++) hook("checks", "Stop", 3000); // slow but once a turn: listed, not hot
  for (let i = 0; i < 120; i++) hook("odd", null, 400); // no event known
  for (let i = 0; i < 20; i++) hook("rare", "PreToolUse:Edit", 5000); // too few runs
  hook("old", "PreToolUse:Bash", 9000, NOW - 30 * 86_400_000);
  const h = hotHooks(db, NOW - 3600_000, NOW);
  assert.deepEqual(h.map((x) => x.name), ["checks", "guard", "odd", "quick"]);
  const guard = h.find((x) => x.name === "guard")!;
  assert.deepEqual([guard.event, guard.runs, guard.p50, guard.totalMs, guard.lostMs, guard.hot], ["PreToolUse", 120, 600, 72_000, 120 * (600 - FAST_HOOK_MS), true]);
  assert.deepEqual(h.map((x) => x.hot), [false, true, false, false]);
  assert.equal(h.find((x) => x.name === "quick")!.lostMs, 0);
  assert.equal(h.find((x) => x.name === "odd")!.event, null);
  const all = levers(db, NOW - 3600_000, NOW);
  assert.deepEqual(Object.keys(all), ["context", "ci", "hooks"]);
});

const lev = (o: Partial<NonNullable<Inputs["levers"]>> = {}): NonNullable<Inputs["levers"]> => ({
  context: { replies: 1000, heavyReplies: 800, overCap: 500, overCapShare: 0.4 },
  ci: { calls: 300, cost: 36, perCall: 0.12, contextPerCall: 500_000, kinds: [{ kind: "gh", calls: 200, cost: 24 }, { kind: "Monitor", calls: 100, cost: 12 }] },
  hooks: [{ name: "guard", event: "PreToolUse", runs: 20_000, p50: 600, lostMs: 10 * 3_600_000, hot: true }, { name: "checks", event: "Stop", runs: 2000, p50: 2000, lostMs: 3_600_000, hot: false }],
  ...o,
});

// @req R65 R66 R67
test("the cost levers raise improvements with what each costs", () => {
  const hookStat = { name: "guard", event: "PreToolUse", runs: 20_000, p50: 600, p95: 3000, totalMs: 1, outcomes: {}, lastAt: null };
  const imps = rank({ ...quiet, hooks: [hookStat], levers: lev(), sessions: [{ session: "abcdef123", replies: 1000, contextPerReply: 500_000, cacheReadCost: 250 }] });
  const ids = imps.map((i) => i.id);
  assert.ok(ids.includes("hot-hook-guard"));
  assert.ok(!ids.includes("slow-hook-guard"), "the hot-hook item replaces the slow-hook one");
  assert.ok(!ids.includes("hot-hook-checks"));
  const hot = imps.find((i) => i.id === "hot-hook-guard")!;
  has(hot.evidence, "600 ms", "20000 calls", "10.0 h");
  assert.equal(hot.minutesPerWeek, 600);
  const ci = imps.find((i) => i.id === "watch-ci")!;
  has(ci.evidence, "300 main-session calls", "gh 200, Monitor 100", "500k tokens", "$36 in all", "$0.12 a check");
  assert.equal(ci.minutesPerWeek, 25);
  has(imps.find((i) => i.id === "heavy-context")!.evidence, "Context above 200k cost $500 (40% of the main sessions' bill).");
  // Without a share, the dollars alone; with nothing above the line, no sentence.
  const noShare = rank({ ...quiet, levers: lev({ context: { replies: 1, heavyReplies: 1, overCap: 9, overCapShare: null } }), sessions: [{ session: "s", replies: 60, contextPerReply: 300_000, cacheReadCost: 1 }] });
  assert.ok(noShare.find((i) => i.id === "heavy-context")!.evidence.endsWith("Context above 200k cost $9."));
  const zero = rank({ ...quiet, levers: lev({ context: { replies: 1, heavyReplies: 0, overCap: 0, overCapShare: 0 } }), sessions: [{ session: "s", replies: 60, contextPerReply: 300_000, cacheReadCost: 1 }] });
  assert.ok(!zero.find((i) => i.id === "heavy-context")!.evidence.includes("Context above"));
  // Too little watching to bother with, or no context known.
  const small = rank({ ...quiet, levers: lev({ ci: { calls: 10, cost: 50, perCall: 5, contextPerCall: 1, kinds: [] } }) });
  assert.ok(!small.some((i) => i.id === "watch-ci"));
  const cheap = rank({ ...quiet, levers: lev({ ci: { calls: 100, cost: 2, perCall: 0.02, contextPerCall: 1, kinds: [] } }) });
  assert.ok(!cheap.some((i) => i.id === "watch-ci"));
  const unknown = rank({ ...quiet, levers: lev({ ci: { calls: 100, cost: 20, perCall: null, contextPerCall: null, kinds: [] } }) });
  const u = unknown.find((i) => i.id === "watch-ci")!;
  has(u.evidence, "($0.00 a check)", "0k tokens");
  assert.equal(u.minutesPerWeek, 0);
});

// @req R65 R66 R67
test("the AI tab shows the cost levers: context bands, CI checks by kind and hooks by time added", () => {
  const { db, reply, tool, hook } = store();
  reply("s", NOW - 30 * MIN, 150_000);
  reply("s", NOW - 20 * MIN, 900_000);
  tool("s", NOW - 25 * MIN, "Bash", "gh pr checks 3");
  for (let i = 0; i < 120; i++) hook("guard", "PreToolUse:Bash", 600);
  const l = levers(db, NOW - 3600_000, NOW);
  const html = renderLevers(l);
  has(html, "Cost levers", "Context over 200k", "Watching CI and PRs", "Hooks on every call", "added by guard", "over 800k tokens", "100k–200k tokens", "Checks on CI and PRs, by kind", "gh", "guard · every call", "PreToolUse");
  assert.ok(!html.includes("200k–400k"), "empty bands are left out");
  assert.equal(renderLevers(null), "");
  assert.equal(renderLevers(levers(openStore(":memory:"), 0, NOW)), "");
  // Statuses at each threshold, and the parts that go away with nothing to show.
  const at = (overCapShare: number, ci: number) =>
    renderLevers({ context: { replies: 1, cost: 1, bands: [], heavyReplies: 0, heavyShare: 0, overCap: 0, overCapShare }, ci: { calls: 0, mainCalls: 0, share: null, cost: ci, perCall: null, contextPerCall: null, kinds: [] }, hooks: [] });
  const cheap = at(0.1, 1);
  has(cheap, "no slow hook runs on every call");
  assert.ok(!cheap.includes("by kind") && !cheap.includes("Hooks that run most"));
  assert.equal((cheap.match(/kpi good/g) ?? []).length, 3);
  assert.equal((at(0.2, 20).match(/kpi warn/g) ?? []).length, 2);
  assert.equal((at(0.5, 90).match(/kpi bad/g) ?? []).length, 2);
});
