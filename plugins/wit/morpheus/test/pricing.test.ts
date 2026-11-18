import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, priceOf } from "../src/cost.ts";
import { apply } from "../src/ingest.ts";
import { contextBands } from "../src/levers.ts";
import { reportedCost } from "../src/quality.ts";
import { parseTranscriptLine } from "../src/parse.ts";
import { commandKind, resources } from "../src/resources.ts";
import { openStore } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 17, 18, 0);

// @req R68
test("writes to the 1-hour cache are priced at twice the input rate, the 5-minute ones at 1.25 times", () => {
  assert.deepEqual(priceOf("claude-opus-5-5"), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
  const base = { tokensIn: 1_000_000, tokensOut: 0, tokensCached: 0, tokensWrite: 1_000_000 };
  assert.equal(costOf("claude-opus-5-5", base), 5);
  assert.equal(costOf("claude-opus-5-5", { ...base, tokensWrite1h: 1_000_000 }), 8);
  assert.equal(costOf("claude-opus-5-5", { ...base, tokensWrite1h: 250_000 }), 0.75 * 5 + 0.25 * 8);
  assert.equal(costOf("claude-opus-5-5", { ...base, tokensWrite: 100, tokensWrite1h: 999 }), (999_900 * 4 + 100 * 8) / 1e6, "1-hour writes can't exceed writes");
});

// @req R68
test("the 1-hour share of each reply's cache writes is read from the transcript and costed", () => {
  const line = (id: string, cc: unknown) =>
    JSON.stringify({ type: "assistant", sessionId: "s", timestamp: new Date(NOW - 60_000).toISOString(), message: { id, model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: cc }, content: [] } });
  const long = parseTranscriptLine(line("m1", { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 }));
  assert.equal(long.usage[0]!.tokensWrite1h, 1_000_000);
  assert.equal(parseTranscriptLine(line("m2", undefined)).usage[0]!.tokensWrite1h, 0, "no split: priced as 5-minute writes");
  assert.equal(parseTranscriptLine(line("m3", { ephemeral_1h_input_tokens: 5_000_000 })).usage[0]!.tokensWrite1h, 1_000_000, "never more than the writes");
  const db = openStore(":memory:");
  apply(db, long);
  apply(db, parseTranscriptLine(line("m2", undefined)));
  assert.equal(Number((db.prepare("select sum(tokens_write_1h) as n from usage").get() as { n: number }).n), 1_000_000);
  assert.equal(contextBands(db, NOW - 3600_000, NOW).cost, 8 + 5);
});

// @req R69
test("a command counts as a test or build run only when one of its commands runs one", () => {
  assert.equal(commandKind("sed -i '' 's#await expect(page).toBe(1)#x#' a.spec.ts"), null);
  assert.equal(commandKind("grep -n jest.mock src/a.test.tsx | head -3"), null);
  assert.equal(commandKind("cat > apps/web/package.json <<'EOF'\n{\"scripts\":{\"build\":\"next build\",\"test\":\"vitest\"}}\nEOF"), null);
  assert.equal(commandKind("echo 'npm test' >> notes.md"), null);
  assert.equal(commandKind("cat packages/x.test.ts; cd packages/config && npx vitest run 2>&1 | grep -v ok"), "test");
  assert.equal(commandKind('bash -c "npm test"'), "test");
  assert.equal(commandKind("python3 -m pytest -q"), "test");
  assert.equal(commandKind("cd app && npx tsc --noEmit"), "build");
  assert.equal(commandKind("(cd app && make)"), "build");
  assert.equal(commandKind("ls"), null);
  assert.equal(commandKind(null), null);
  assert.equal(commandKind(""), null);
});

// @req R69
test("Resources counts only real test and build runs", () => {
  const db = openStore(":memory:");
  const run = db.prepare("insert into runs (id, kind, name, session, started_at, duration_ms, outcome, trigger) values (?, 'tool', 'Bash', 's', ?, 1000, 'ok', ?)");
  run.run("a", NOW - 60_000, "npx jest src/a.test.ts");
  run.run("b", NOW - 50_000, "grep -n jest.mock src/a.test.ts");
  run.run("c", NOW - 40_000, "sed -i '' 's#vitest#jest#' package.json");
  run.run("d", NOW - 30_000, "npx tsc --noEmit");
  const r = resources(db, "7d", NOW);
  assert.deepEqual([r.commands.test.runs, r.commands.build.runs], [1, 1]);
});

// @req R63
test("Claude Code's own session cost is set beside the main thread's estimate, without the agents", () => {
  const db = openStore(":memory:");
  db.prepare("insert into session_costs (session, cost) values ('s', 3)").run();
  const use = db.prepare("insert into usage (session, message_id, agent_id, at, model, tokens_in, tokens_out, tokens_cached) values (?, ?, ?, ?, 'claude-opus-5-5', 1000000, 0, 0)");
  use.run("s", "m1", null, NOW - 60_000);
  use.run("s", "m2", "a1", NOW - 60_000); // an agent's reply in the session's transcript
  use.run("s/agent-a2", "m3", null, NOW - 60_000); // an agent's own transcript
  assert.deepEqual(reportedCost(db, NOW - 3600_000, NOW), { sessions: 1, cost: 3, estimate: 4 });
});
