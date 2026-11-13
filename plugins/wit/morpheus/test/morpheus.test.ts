import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Inputs, rank } from "../src/improvements.ts";
import { apply, ingest, readNew } from "../src/ingest.ts";
import { projectDirs, projectRoot } from "../src/paths.ts";
import { handle } from "../src/mcp.ts";
import { project, TOOLS } from "../src/api.ts";
import { parseArgs } from "../src/cli.ts";
import { rewrite, wrappable } from "../src/init.ts";
import { inventory } from "../src/inventory.ts";
import { inputOf, localHost } from "../src/server.ts";
import {
  coverage,
  gateTarget,
  hintedSkills,
  item,
  items,
  live,
  overview,
  percentile,
  since,
  dayKey,
  dayKeys,
  tokens,
  timeline,
  toolsTable,
} from "../src/metrics.ts";
import {
  hookScript,
  isOrchestration,
  parseHookRunLine,
  parseTranscriptLine,
  redact,
  verdictOf,
} from "../src/parse.ts";
import { openStore } from "../src/store.ts";

/** A repo with one session's transcript, a subagent, the hooks' logs and a review stamp. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pt-"));
  const root = join(dir, "repo");
  const projects = join(dir, "projects");
  const proj = join(projects, root.replace(/[^A-Za-z0-9]/g, "-"));
  const state = join(root, ".claude", "morpheus");
  mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
  mkdirSync(join(state, "reviews"), { recursive: true });
  const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, s)).toISOString();
  const base = (s: number) => ({
    sessionId: "s1",
    gitBranch: "feat/x",
    cwd: root,
    timestamp: at(s),
    uuid: `u${s}`,
  });
  const lines = [
    {
      ...base(0),
      type: "user",
      message: { role: "user", content: "Ship the quiz please" },
    },
    {
      ...base(1),
      type: "attachment",
      attachment: {
        type: "hook_additional_context",
        hookEvent: "UserPromptSubmit",
        hookName: "UserPromptSubmit",
        toolUseID: "hook-1",
        content: [
          "Project skills that match this request (…): ship (then code-reviewer); status-report",
        ],
      },
    },
    {
      ...base(2),
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t-skill",
            name: "Skill",
            input: { skill: "ship" },
          },
        ],
      },
    },
    {
      ...base(3),
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t-skill" }] },
    },
    {
      ...base(4),
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t-bash",
            name: "Bash",
            input: { command: "git push origin main" },
          },
        ],
      },
    },
    {
      ...base(5),
      type: "attachment",
      attachment: {
        type: "hook_blocking_error",
        hookName: "PreToolUse:Bash",
        hookEvent: "PreToolUse",
        toolUseID: "t-bash",
        blockingError: {
          blockingError: '[bash ".claude/hooks/bash-guard.sh"]: Push through ship.sh',
        },
      },
    },
    {
      ...base(6),
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t-bash", is_error: true }],
      },
    },
    {
      ...base(10),
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t-ok",
            name: "Bash",
            input: { command: "bash scripts/ship.sh merge feat/x chore/y" },
          },
        ],
      },
    },
    {
      ...base(70),
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t-ok" }] },
    },
    {
      ...base(80),
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t-agent",
            name: "Agent",
            input: {
              subagent_type: "code-reviewer",
              description: "Review x",
              prompt: "Review feat/x",
            },
          },
        ],
      },
    },
    {
      ...base(81),
      type: "user",
      toolUseResult: { agentId: "a1", isAsync: true },
      message: { content: [{ type: "tool_result", tool_use_id: "t-agent" }] },
    },
    {
      ...base(200),
      type: "user",
      message: { role: "user", content: "thanks" },
    },
  ];
  writeFileSync(join(proj, "s1.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const agent = [
    {
      ...base(82),
      isSidechain: true,
      type: "user",
      message: { content: "Review feat/x" },
    },
    {
      ...base(140),
      isSidechain: true,
      type: "assistant",
      message: {
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 900,
          output_tokens: 50,
        },
        content: [
          {
            type: "text",
            text: "All good. Used SUPABASE_SERVICE_ROLE_KEY=s3cr3tvalue for nia@example.test.\nVERDICT: approve",
          },
        ],
      },
    },
  ];
  writeFileSync(
    join(proj, "s1", "subagents", "agent-a1.jsonl"),
    `${agent.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  writeFileSync(
    join(proj, "s1", "subagents", "agent-a1.meta.json"),
    JSON.stringify({
      agentType: "code-reviewer",
      description: "Review x",
      finished: true,
    }),
  );
  writeFileSync(
    join(state, "runs.jsonl"),
    `${JSON.stringify({ ts: at(5), script: "bash-guard", rule: "branch-guard", ms: 180, exit: 2, event: "PreToolUse", tool: "Bash", tool_use_id: "t-bash", session: "s1" })}\n`,
  );
  writeFileSync(
    join(state, "events.jsonl"),
    `${JSON.stringify({ ts: at(5), hook: "branch-guard", type: "block", branch: "feat/x", detail: "Push through ship.sh" })}\n`,
  );
  writeFileSync(join(state, "reviews", "feat%2Fx-abc1234"), `approve ${at(9)} 2 files changed`);
  return { root, projects, proj, state, at, now: Date.parse(at(300)) };
}

// @req R30
test("redact masks secrets and cuts to an excerpt", () => {
  assert.equal(
    redact("SUPABASE_SERVICE_ROLE_KEY=abc123 ok"),
    "SUPABASE_SERVICE_ROLE_KEY=[masked] ok",
  );
  assert.equal(redact("token: hunter2"), "token: [masked]");
  assert.equal(
    redact("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"),
    "Bearer [jwt]",
  );
  assert.equal(redact("use sk_live_1234567890abcdef now"), "use [key] now");
  assert.equal(redact("x".repeat(300))?.length, 240);
  assert.equal(redact(""), null);
});

// @req R24
test("names hooks by their script and reads verdicts and timing lines", () => {
  assert.equal(
    hookScript('bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/after-edit.sh', "x"),
    "after-edit",
  );
  assert.equal(hookScript("python3 hooks/lint_check.py", "x"), "lint_check");
  assert.equal(hookScript(undefined, "Stop"), "Stop");
  assert.equal(verdictOf("Done.\nVERDICT: **approve**"), "approve");
  assert.equal(verdictOf("All checks ran.\nVERDICT: pass"), "pass", "any one-word verdict");
  assert.equal(verdictOf("VERDICT: the last line, said the brief"), null);
  assert.equal(
    verdictOf("End on `VERDICT: approve | changes-required`."),
    null,
    "a quoted template",
  );
  assert.equal(
    verdictOf("Earlier VERDICT: approve, then a blocker.\nVERDICT: changes-required"),
    "changes-required",
    "the last one counts",
  );
  const r = parseHookRunLine(
    '{"ts":"2026-11-01T12:00:05Z","script":"bash-guard","rule":"branch-guard","ms":180,"exit":2,"event":"PreToolUse","tool":"Bash","tool_use_id":"t1","session":"s1"}',
  );
  assert.equal(r?.id, "hook:t1:PreToolUse:Bash:bash-guard");
  assert.equal(r?.outcome, "block");
  assert.equal(r?.startedAt, Date.parse("2026-11-01T12:00:05Z") - 180);
  assert.equal(parseHookRunLine("{"), null);
});

// @req R23
test("a transcript line becomes runs, results and prompts; harness notices aren't prompts", () => {
  const p = parseTranscriptLine(
    JSON.stringify({
      sessionId: "s",
      timestamp: "2026-11-01T12:00:00Z",
      type: "user",
      message: { content: "<task-notification>x" },
    }),
  );
  assert.deepEqual(p.prompts, []);
  const side = parseTranscriptLine(
    JSON.stringify({
      sessionId: "s",
      timestamp: "2026-11-01T12:00:00Z",
      isSidechain: true,
      type: "user",
      message: { content: "hi" },
    }),
  );
  assert.deepEqual(side.prompts, []);
  assert.deepEqual(parseTranscriptLine("not json").runs, []);
});

// @req R23 R24
test("ingests a session, its agent, the hooks' timing and logs, and merges the hook's two records", () => {
  const f = fixture();
  const db = openStore(":memory:");
  assert.deepEqual(projectDirs(f.root, f.projects), [f.proj]);
  assert.ok(ingest(db, { root: f.root, projectsDir: f.projects }) > 0);
  const hook = db.prepare("select * from runs where kind = 'hook'").all() as any[];
  assert.equal(hook.length, 1, "transcript and timing records of one run merge");
  assert.equal(hook[0].outcome, "block");
  assert.equal(hook[0].duration_ms, 180);
  assert.equal(hook[0].rule, "branch-guard");
  assert.equal(hook[0].source, "timing");
  assert.match(hook[0].output, /Push through ship\.sh/);
  const tool = db.prepare("select * from runs where id = 'tool:t-ok'").get() as any;
  assert.equal(tool.duration_ms, 60_000);
  const skill = db.prepare("select * from runs where kind = 'skill'").get() as any;
  assert.equal(skill.duration_ms, 198_000, "a skill lasts until the next prompt");
  const agent = db.prepare("select * from agents where agent_id = 'a1'").get() as any;
  assert.equal(agent.tokens_in, 100, "new input only");
  assert.equal(agent.tokens_cached, 900, "cached context read again");
  assert.equal(agent.tokens_out, 50);
  assert.equal(agent.last_at - agent.first_at, 58_000);
  // A second read finds nothing new.
  assert.equal(ingest(db, { root: f.root, projectsDir: f.projects }), 0);
  appendFileSync(
    join(f.state, "runs.jsonl"),
    `${JSON.stringify({ ts: f.at(90), script: "after-edit", ms: 900, exit: 0, event: "PostToolUse", tool: "Edit", tool_use_id: "t-e", session: "s1" })}\n`,
  );
  assert.equal(ingest(db, { root: f.root, projectsDir: f.projects }), 1);
});

// @req R25
test("the overview counts sessions, hints, blocks and agent time", () => {
  const f = fixture();
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  const o = overview(db, { range: "all" }, f.now, ["ship", "status-report"]);
  assert.equal(o.kpis.sessions, 1);
  assert.equal(o.kpis.hints, 1);
  assert.equal(o.kpis.hintsConverted, 1);
  assert.equal(o.kpis.agentRuns, 1);
  assert.equal(o.kpis.agentTokens, 150);
  assert.equal(o.kpis.blocks, 1);
  assert.equal(o.kpis.workedAround, 1, "a passing command followed the block within 3 minutes");
  const agents = items(db, "agent", { range: "all" }, f.now) as any[];
  assert.deepEqual(agents[0].verdicts, { approve: 1 });
  const rules = items(db, "rule", { range: "all" }, f.now) as any[];
  assert.equal(rules.find((r) => r.name === "branch-guard")?.workedAround, 1);
  const detail = item(db, "hook", "bash-guard", { range: "all" }, f.now);
  assert.equal(
    detail.recent[0]?.trigger,
    "git push origin main",
    "a hook shows the call it ran for",
  );
  assert.equal(detail.bySession[0]?.session, "s1");
  const scoped = overview(db, { range: "all", branch: "feat/other" }, f.now);
  assert.equal(scoped.kpis.hookRuns, 0);
  const now = live(db, Date.parse(f.at(250)));
  assert.equal(now.sessions[0]?.session, "s1");
  assert.equal(now.sessions[0]?.prompt, "thanks");
  assert.ok(now.feed.some((r: any) => r.kind === "agent"));
});

// @req R25
test("percentiles, ranges and the helpers", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.equal(since("all", 1000), 0);
  assert.equal(since("1h", 7_200_000), 3_600_000);
  assert.deepEqual(hintedSkills("ship (then code-reviewer); database-change; anthropic-skills:docs"), [
    "ship",
    "database-change",
    "anthropic-skills:docs",
  ]);
  assert.deepEqual(
    hintedSkills("Skills that match: deploy, then docs:write. Not shipping today.", [
      "deploy",
      "docs:write",
      "ship",
      "tdd",
    ]),
    ["deploy", "docs:write"],
    "known skills named as whole words; 'shipping' isn't 'ship'",
  );
  assert.equal(dayKey(new Date(2026, 10, 3, 0, 30).getTime()), "2026-11-03", "local midnight");
  assert.deepEqual(
    dayKeys(new Date(2026, 10, 1, 9).getTime(), new Date(2026, 10, 3, 1).getTime()),
    ["2026-11-01", "2026-11-02", "2026-11-03"],
  );
});

const stat = (name: string, o: Partial<any> = {}) => ({
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
test("with nothing wrong, there's nothing to improve", () => {
  assert.deepEqual(rank(quiet), []);
});

// @req R27
test("hooks wired without timing get the setup improvement first", () => {
  const r = rank({ ...quiet, defined: { hooks: ["guard"], skills: [], agents: [] } });
  assert.deepEqual(
    r.map((i) => i.id),
    ["setup-timing"],
  );
  assert.equal(rank({ ...quiet, timingSince: 1, defined: { hooks: ["guard"], skills: [], agents: [] } }).length, 0);
});

// @req R27
test("token rules: agents that mostly coordinate, chatty hooks and heavy skills", () => {
  const split = (work: number, orchestration: number) => ({ work, orchestration, replies: 0, cached: 0 });
  const r = rank({
    ...quiet,
    tokens: {
      agents: [
        { type: "ci-watcher", runs: 4, own: split(100_000, 300_000) },
        { type: "builder", runs: 4, own: split(900_000, 100_000) },
      ],
      hooks: [{ name: "lint", runs: 50, tokens: 80_000 }],
      skills: [{ name: "big", loads: 6, tokens: 60_000 }],
      shares: { work: 0.7, orchestration: 0.3, replies: 0 },
    },
  });
  const ids = r.map((i) => i.id);
  assert.ok(ids.includes("orchestrating-agent-ci-watcher"));
  assert.ok(!ids.includes("orchestrating-agent-builder"));
  assert.ok(ids.includes("chatty-hook-lint"));
  assert.ok(ids.includes("heavy-skill-big"));
});

// @req R27
test("a hook is slow against its event's budget; a tool that often fails is flagged", () => {
  const r = rank({
    ...quiet,
    hooks: [
      { ...stat("guard", { runs: 20, p50: 1500, p95: 2500 }), event: "PreToolUse" },
      { ...stat("format", { runs: 20, p50: 1500, p95: 2500 }), event: "PostToolUse" },
    ],
    tools: [stat("Bash", { runs: 40, outcomes: { ok: 20, error: 20 } })],
  });
  const ids = r.map((i) => i.id);
  assert.ok(ids.includes("slow-hook-guard"), "2.5 s is too slow before every call");
  assert.ok(!ids.includes("slow-hook-format"), "but fine after an edit");
  assert.ok(ids.includes("failing-tool-Bash"));
});

// @req R27
test("unused skills and agents count only the project's own", () => {
  const r = rank({
    ...quiet,
    defined: {
      hooks: [],
      skills: ["mine", "theirs"],
      agents: [],
      where: { "skill:mine": "project", "skill:theirs": "plugin" },
    },
  });
  assert.match(r.find((i) => i.id === "unused-skills")?.evidence ?? "", /mine\./);
});

// @req R27
test("work done without its skill or agent, and reviews without verdicts, become improvements", () => {
  const r = rank({
    ...quiet,
    agents: [{ ...stat("code-reviewer", { runs: 5 }), tokens: 0, verdicts: {} }],
    coverage: [
      { kind: "skill", name: "ship", missed: 4, used: 0 },
      { kind: "agent", name: "test-writer", missed: 2, used: 0 },
      { kind: "skill", name: "tdd", missed: 1, used: 3 },
    ],
  });
  const ids = r.map((i) => i.id);
  assert.ok(ids.includes("missed-skill-ship"));
  assert.ok(ids.includes("missed-agent-test-writer"));
  assert.ok(!ids.includes("missed-skill-tdd"), "one miss is noise");
  assert.ok(ids.includes("review-verdicts"));
  const withVerdicts = rank({
    ...quiet,
    agents: [{ ...stat("code-reviewer", { runs: 5 }), tokens: 0, verdicts: { approve: 5 } }],
  });
  assert.ok(!withVerdicts.some((i) => i.id === "review-verdicts"));
});

/** The fixture's review agent hands back its verdict, after starting a nested reviewer. */
function nested() {
  const f = fixture();
  const base = (s: number) => ({
    sessionId: "s1",
    gitBranch: "feat/x",
    cwd: f.root,
    timestamp: f.at(s),
    uuid: `n${s}`,
    isSidechain: true,
  });
  const sub = join(f.proj, "s1", "subagents");
  const lines = [
    {
      ...base(150),
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t-nested",
            name: "Agent",
            input: {
              subagent_type: "code-quality-reviewer",
              description: "Quality",
              prompt: "Look",
            },
          },
        ],
      },
    },
    {
      ...base(170),
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t-nested", content: "delivered as a message" },
        ],
      },
    },
    {
      ...base(180),
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t-hand",
            name: "SubagentHandback",
            input: { message: "One major.\nVERDICT: changes-required" },
          },
        ],
      },
    },
  ];
  appendFileSync(
    join(sub, "agent-a1.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  writeFileSync(
    join(sub, "agent-a1.meta.json"),
    JSON.stringify({
      agentType: "code-reviewer",
      description: "Review x",
      toolUseId: "t-agent",
      finished: true,
    }),
  );
  writeFileSync(
    join(sub, "agent-a0nested.jsonl"),
    `${JSON.stringify({ ...base(155), type: "assistant", message: { usage: { input_tokens: 40, output_tokens: 10 }, content: [{ type: "text", text: "Fine." }] } })}\n${JSON.stringify({ ...base(165), type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: "text", text: "Done" }] } })}\n`,
  );
  writeFileSync(
    join(sub, "agent-a0nested.meta.json"),
    JSON.stringify({
      agentType: "code-quality-reviewer",
      description: "Quality",
      toolUseId: "t-nested",
      parentAgentId: "a1",
      finished: true,
    }),
  );
  appendFileSync(
    join(f.state, "events.jsonl"),
    [
      {
        ts: f.at(20),
        hook: "skill-gate",
        type: "warn",
        branch: "feat/x",
        detail: "skill database-change: a migration edit",
      },
      {
        ts: f.at(21),
        hook: "skill-gate",
        type: "block",
        branch: "feat/x",
        detail: "skill database-change: a migration edit",
      },
      {
        ts: f.at(22),
        hook: "skill-gate",
        type: "warn",
        branch: "feat/x",
        detail: "agent test-writer: 4 files, no test",
      },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(""),
  );
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  return { ...f, db };
}

// @req R26 R30
test("a hand-back's verdict is recorded, and a nested agent links to the call that started it", () => {
  const { db, now } = nested();
  const agents = items(db, "agent", { range: "all" }, now) as any[];
  assert.deepEqual(agents.find((a) => a.name === "code-reviewer")?.verdicts, {
    "changes-required": 1,
  });
  const quality = agents.find((a) => a.name === "code-quality-reviewer");
  assert.equal(quality?.tokens, 60, "the nested agent's own tokens");
  assert.equal(quality?.p50, 10_000, "its active time");
  const row = db.prepare("select parent_id from agents where agent_id = 'a0nested'").get() as any;
  assert.equal(row.parent_id, "a1");
});

// @req R26
test("the timeline lists a session's runs in order, nested agents one level deeper", () => {
  const { db, now } = nested();
  const t = timeline(db, now, { range: "all" });
  assert.equal(t.session, "s1", "the most recent session by default");
  const starts = t.events.map((e) => e.start);
  assert.deepEqual(
    starts,
    [...starts].sort((a, b) => a - b),
  );
  const kinds = t.events.map((e) => `${e.kind}:${e.name}`);
  assert.ok(kinds.indexOf("hint:skill-hints") < kinds.indexOf("skill:ship"));
  const review = t.events.find((e) => e.name === "code-reviewer")!;
  assert.equal(review.depth, 0);
  assert.equal(review.outcome, "changes-required");
  assert.ok(review.end > review.start, "the agent's bar runs until its last reply");
  const quality = t.events.find((e) => e.name === "code-quality-reviewer")!;
  assert.equal(quality.inside, "a1");
  assert.equal(quality.depth, 1);
  assert.equal(timeline(db, now, { range: "all", session: "nobody" }).events.length, 0);
});

// @req R26
test("coverage marks each item active, missed, idle or off", () => {
  const { db, now } = nested();
  const c = coverage(
    db,
    now,
    {
      hooks: ["bash-guard", "after-edit"],
      rules: { "branch-guard": "block", "skill-hints": "off" },
      skills: ["ship", "database-change", "tdd"],
      agents: ["code-reviewer", "test-writer", "ux-researcher"],
    },
    "all",
  );
  const s = Object.fromEntries(c.rows.map((r) => [`${r.kind}:${r.name}`, r]));
  assert.equal(s["hook:bash-guard"]?.status, "active");
  assert.equal(s["hook:after-edit"]?.status, "idle");
  assert.equal(s["rule:branch-guard"]?.status, "active");
  assert.equal(s["rule:skill-hints"]?.status, "off");
  assert.equal(s["skill:ship"]?.status, "active");
  assert.equal(s["skill:ship"]?.hinted, 1);
  assert.equal(s["skill:database-change"]?.status, "missed");
  assert.equal(s["skill:database-change"]?.missed, 2);
  assert.equal(s["skill:tdd"]?.status, "idle");
  assert.equal(s["agent:code-reviewer"]?.status, "active");
  assert.equal(s["agent:test-writer"]?.status, "missed");
  assert.equal(s["agent:ux-researcher"]?.status, "idle");
  assert.equal(c.totals.missed, 2);
  assert.equal(s["skill:database-change"]?.warned, 1);
  assert.equal(s["skill:database-change"]?.blocked, 1);
  assert.equal(s["rule:skill-gate"]?.mode, "logged", "a rule only the log names");
  assert.equal(s["agent:code-quality-reviewer"]?.scope, "other", "ran without being defined here");
  assert.equal(gateTarget("agent test-writer: x")?.name, "test-writer");
  assert.equal(gateTarget("skill docs:write: x")?.name, "docs:write", "a plugin's skill");
  assert.equal(gateTarget("nonsense"), null);
});

// @req R26
test("a skill loaded after its gate counts as active again", () => {
  const { db, now, at } = nested();
  apply(db, {
    runs: [
      {
        id: "skill:late-db",
        kind: "skill",
        name: "database-change",
        detail: null,
        session: "s1",
        branch: "feat/x",
        cwd: null,
        startedAt: Date.parse(at(25)),
        durationMs: null,
        outcome: "ok",
        toolUseId: "late-db",
        trigger: null,
        output: null,
      },
    ],
    results: [],
    prompts: [],
    usage: [],
    lastText: null,
    at: null,
  });
  const def = { hooks: [], rules: {}, skills: ["database-change"], agents: [] };
  const row = coverage(db, now, def, "all").rows.find((r) => r.name === "database-change")!;
  assert.equal(row.status, "active", "loaded after the last gate");
  assert.equal(row.missed, 2, "the gate events still count");
});

// @req R26
test("depth comes from the meta's spawnDepth, and from the parent chain without it", () => {
  const { db, now, proj } = nested();
  const sub = join(proj, "s1", "subagents");
  // A third level: started by the nested reviewer, with its depth in its meta.
  writeFileSync(
    join(sub, "agent-a3deep.jsonl"),
    `${JSON.stringify({ sessionId: "s1", timestamp: new Date(Date.parse("2026-11-01T12:02:40Z")).toISOString(), uuid: "d1", isSidechain: true, type: "assistant", message: { content: [{ type: "tool_use", id: "t-deep-skill", name: "Skill", input: { skill: "tdd" } }] } })}\n`,
  );
  writeFileSync(
    join(sub, "agent-a3deep.meta.json"),
    JSON.stringify({
      agentType: "Explore",
      parentAgentId: "a0nested",
      spawnDepth: 3,
      finished: true,
    }),
  );
  ingest(db, { root: join(proj, "..", "..", "repo"), projectsDir: join(proj, "..") });
  const t = timeline(db, now, { range: "all", session: "s1" });
  const deep = t.events.find((e) => e.inside === "a3deep");
  assert.equal(deep?.depth, 3, "from spawnDepth");
  // Without spawnDepth the chain a3deep → a0nested → a1 gives the same.
  db.prepare("update agents set spawn_depth = null").run();
  assert.equal(
    timeline(db, now, { range: "all", session: "s1" }).events.find((e) => e.inside === "a3deep")
      ?.depth,
    3,
  );
  // A parent with no meta stops the walk: one level per agent known.
  db.prepare("update agents set parent_id = 'gone' where agent_id = 'a3deep'").run();
  assert.equal(
    timeline(db, now, { range: "all", session: "s1" }).events.find((e) => e.inside === "a3deep")
      ?.depth,
    2,
  );
});

// @req R27
test("each rule fires on its evidence, and the list is ranked by ROI", () => {
  const r = rank({
    ...quiet,
    hooks: [
      {
        ...stat("bash-guard", {
          lastAt: 9.5 * 86_400_000,
          p50: 1500,
          p95: 4000,
          runs: 400,
          outcomes: { ok: 396, cancelled: 4 },
        }),
        event: "PreToolUse",
      },
      { ...stat("after-edit", { lastAt: 8 * 86_400_000 }), event: "PostToolUse" },
    ],
    rules: [
      {
        ...stat("secret-read", { outcomes: { block: 6, override: 3 } }),
        workedAround: 5,
      },
    ],
    skills: [{ ...stat("ship"), hintedNotLoaded: 12 }],
    agents: [{ ...stat("ci-watcher", { runs: 5 }), tokens: 3_000_000 }],
    kpis: { hints: 20, hintsConverted: 2, overrides: 3 },
    defined: {
      hooks: ["bash-guard", "after-edit"],
      skills: ["ship", "tdd"],
      agents: ["ci-watcher", "test-writer"],
    },
    lastActivity: 9.9 * 86_400_000,
    timingSince: 5 * 86_400_000,
  });
  const ids = r.map((i) => i.id);
  for (const id of [
    "slow-hook-bash-guard",
    "failing-hook-bash-guard",
    "noisy-rule-secret-read",
    "overridden-secret-read",
    "ignored-hints",
    "costly-agent-ci-watcher",
    "unused-skills",
    "unused-agents",
    "silent-after-edit",
  ])
    assert.ok(ids.includes(id), `${id} fires`);
  assert.ok(!ids.includes("silent-bash-guard"), "a hook that ran isn't silent");
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1]!.roi >= r[i]!.roi, "ranked by ROI");
  assert.ok(r.every((i) => i.evidence && i.how));
});

// @req R27
test("no silent-hook alarm before the hooks time every run", () => {
  const r = rank({ ...quiet, lastActivity: quiet.now - 1000 });
  assert.ok(!r.some((i) => i.id.startsWith("silent-")));
});

// @req R29
test("the MCP server answers initialize, lists read-only tools and calls them", () => {
  const calls: string[] = [];
  const ctx = { call: (name: string) => (calls.push(name), { ok: name }) };
  const init = handle(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    },
    ctx,
  ) as any;
  assert.equal(init.result.serverInfo.name, "morpheus");
  assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx), null);
  const list = handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx) as any;
  assert.ok(list.result.tools.length >= 5);
  assert.ok(list.result.tools.every((t: any) => t.annotations.readOnlyHint === true));
  const call = handle(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "morpheus_live", arguments: {} },
    },
    ctx,
  ) as any;
  assert.deepEqual(call.result.structuredContent, { ok: "morpheus_live" });
  const bad = handle(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x" } },
    {
      call: () => {
        throw new Error("No tool x");
      },
    },
  ) as any;
  assert.equal(bad.result.isError, true);
  assert.equal((handle({ jsonrpc: "2.0", id: 5, method: "nope" }, ctx) as any).error.code, -32601);
});

// @req R30
test("redact masks the secret shapes commands carry", () => {
  const cases: [string, RegExp][] = [
    [
      "psql postgresql://postgres.abcd:Sup3rS3cretPw@db.example.test:5432/postgres",
      /Sup3rS3cretPw/,
    ],
    ["export supabase_service_role_key=abcdef123456", /abcdef123456/],
    ["curl -H 'Authorization: Bearer 8f3a9c1d2e4b5a6f'", /8f3a9c1d2e4b5a6f/],
    ["curl -H 'Authorization: Basic dXNlcjpwYXNz'", /dXNlcjpwYXNz/],
    ["refresh_token=r0tat3me&x=1", /r0tat3me/],
    ["client_secret=cl13ntS3cret", /cl13ntS3cret/],
    ['{"api_key": "k3yv4lue"}', /k3yv4lue/],
    ["mysql --password hunter22 -u root", /hunter22/],
    ["secrets set --value=topsecret99", /topsecret99/],
    ["aws AKIAIOSFODNN7EXAMPLE", /AKIAIOSFODNN7EXAMPLE/],
    ["key AIzaSyA1234567890abcdefghijklmnopqrstu", /AIzaSyA1234567890abcdefghijklmnop/],
  ];
  cases.push(
    ['PGPASSWORD="two words" psql', /words/],
    ['{"password": "a b c"}', /\bb c\b/],
    ["curl -u admin:hunter22 https://x.test", /hunter22/],
    ["mysql -phunter22 -u root", /hunter22/],
  );
  for (const [input, secret] of cases) assert.doesNotMatch(redact(input) ?? "", secret, input);
  assert.equal(
    redact("the token budget is fine"),
    "the token budget is fine",
    "a word after 'token' isn't a secret",
  );
  assert.equal(
    redact("git push origin feat/x"),
    "git push origin feat/x",
    "ordinary commands stay readable",
  );
});

// @req R30
test("an agent's own words never reach the store, only its verdict", () => {
  const f = fixture();
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  const dump = JSON.stringify([
    db.prepare("select * from agents").all(),
    db.prepare("select * from runs").all(),
  ]);
  assert.doesNotMatch(dump, /s3cr3tvalue|nia@example\.test/);
  const agents = items(db, "agent", { range: "all" }, f.now) as any[];
  assert.deepEqual(agents[0].verdicts, { approve: 1 });
});

// @req R23
test("reading again changes nothing; a half-written line waits; a shorter file starts over", () => {
  const f = fixture();
  const db = openStore(":memory:");
  const read = () => ingest(db, { root: f.root, projectsDir: f.projects });
  const count = (sql: string) => (db.prepare(sql).get() as any).n;
  read();
  const runs = count("select count(*) as n from runs");
  read();
  assert.equal(count("select count(*) as n from runs"), runs);
  // A line half written: read only once it ends.
  const half = JSON.stringify({
    ts: f.at(95),
    hook: "verify-claims",
    type: "warn",
    branch: "feat/x",
    detail: "x",
  });
  appendFileSync(join(f.state, "events.jsonl"), half.slice(0, 20));
  read();
  appendFileSync(join(f.state, "events.jsonl"), `${half.slice(20)}\n`);
  read();
  assert.equal(count("select count(*) as n from events"), 2);
  // The agent's transcript rewritten shorter, then whole again: its tokens aren't added twice.
  const agentFile = join(f.proj, "s1", "subagents", "agent-a1.jsonl");
  const agentText = readFileSync(agentFile, "utf8");
  writeFileSync(agentFile, agentText.slice(0, agentText.indexOf("\n") + 1));
  read();
  writeFileSync(agentFile, agentText);
  read();
  assert.equal((db.prepare("select tokens_in from agents").get() as any).tokens_in, 100);
  // Events with no detail aren't duplicated by a re-read either.
  const noDetail = `${JSON.stringify({ ts: f.at(99), hook: "bash-guard", type: "override", branch: "feat/x" })}\n`;
  appendFileSync(join(f.state, "events.jsonl"), noDetail);
  read();
  writeFileSync(join(f.state, "events.jsonl"), noDetail);
  read();
  assert.equal(count("select count(*) as n from events where type = 'override'"), 1);
});

// @req R23
test("a character split across two reads isn't lost", () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-"));
  const file = join(dir, "x.jsonl");
  const lines = ["é".repeat(7), "naïve ünïcödé", "ascii"];
  writeFileSync(file, `${lines.join("\n")}\n`);
  const db = openStore(":memory:");
  const seen: string[] = [];
  for (const chunk of [3, 4, 5, 8]) {
    seen.length = 0;
    db.exec("delete from files");
    readNew(db, file, (l) => seen.push(l), chunk);
    assert.deepEqual(seen, lines, `chunk ${chunk}`);
  }
  appendFileSync(file, "next\n");
  seen.length = 0;
  readNew(db, file, (l) => seen.push(l), 3);
  assert.deepEqual(seen, ["next"]);
});

// @req R23
test("a finished run stays finished when its line is read again", () => {
  const db = openStore(":memory:");
  const run = {
    id: "tool:t1",
    kind: "tool",
    name: "Bash",
    detail: null,
    session: "s",
    branch: null,
    cwd: null,
    startedAt: 1,
    durationMs: null,
    outcome: "running",
    toolUseId: "t1",
    trigger: "ls",
    output: null,
  } as const;
  const empty = { results: [], prompts: [], usage: [], lastText: null, at: 1 };
  apply(db, { ...empty, runs: [run] });
  apply(db, {
    ...empty,
    runs: [],
    results: [{ toolUseId: "t1", at: 5, isError: false, agentId: null }],
  });
  apply(db, { ...empty, runs: [run] });
  assert.equal((db.prepare("select outcome from runs").get() as any).outcome, "ok");
});

// @req R29
test("tables answer as text: MCP's structured result must be an object, not a list", () => {
  const list = handle(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "process_items", arguments: {} },
    },
    { call: () => [{ name: "bash-guard" }] },
  ) as any;
  assert.equal(list.result.structuredContent, undefined);
  assert.deepEqual(JSON.parse(list.result.content[0].text), [{ name: "bash-guard" }]);
  const obj = handle(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "process_live", arguments: {} },
    },
    { call: () => ({ ok: 1 }) },
  ) as any;
  assert.deepEqual(obj.result.structuredContent, { ok: 1 });
});

// @req R24 R25 R28
test("an agent's time is its active time; tokens split into new and cached; blocks come from the hooks' log", () => {
  const f = fixture();
  // The agent's transcript gets one more line two days later (a follow-up message): idle, not work.
  const agentFile = join(f.proj, "s1", "subagents", "agent-a1.jsonl");
  appendFileSync(
    agentFile,
    `${JSON.stringify({ sessionId: "s1", isSidechain: true, timestamp: new Date(Date.parse(f.at(140)) + 2 * 86_400_000).toISOString(), type: "user", message: { content: "one more thing" } })}\n`,
  );
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  const o = overview(db, { range: "all" }, f.now + 3 * 86_400_000);
  const agent = (items(db, "agent", { range: "all" }, f.now + 3 * 86_400_000) as any[])[0];
  assert.equal(agent.p50, 58_000, "the two idle days don't count");
  assert.equal(o.kpis.agentTokens, 150, "new input and output only");
  assert.equal(o.kpis.agentTokensCached, 900);
  // Two blocks in the hooks' log: one also timed (the same run), one only logged.
  appendFileSync(
    join(f.state, "events.jsonl"),
    `${JSON.stringify({ ts: f.at(30), hook: "secret-read", type: "block", branch: "feat/x", detail: "no .env" })}\n`,
  );
  ingest(db, { root: f.root, projectsDir: f.projects });
  assert.equal(overview(db, { range: "all" }, f.now).kpis.blocks, 2);
  assert.ok(
    overview(db, { range: "all" }, f.now).kpis.timingSince,
    "says when every run began to be timed",
  );
  const rules = items(db, "rule", { range: "all" }, f.now) as any[];
  assert.equal(rules.find((r) => r.name === "secret-read")?.outcomes.block, 1);
  assert.equal(
    rules.find((r) => r.name === "branch-guard")?.outcomes.block,
    1,
    "not counted twice",
  );
});

// @req R24
test("an override is named by what it overrode", () => {
  const f = fixture();
  appendFileSync(
    join(f.state, "events.jsonl"),
    `${JSON.stringify({ ts: f.at(40), hook: "override", type: "override", branch: "trunk", detail: "STACK_RESET_OK: npx supabase stop" })}\n`,
  );
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  const rules = items(db, "rule", { range: "all" }, f.now) as any[];
  assert.equal(rules.find((r) => r.name === "STACK_RESET_OK")?.outcomes.override, 1);
  assert.ok(!rules.some((r) => r.name === "override"));
  // Its detail lists the override from the hooks' log.
  const detail = item(db, "rule", "STACK_RESET_OK", { range: "all" }, f.now);
  assert.equal(detail.recent.length, 1);
  assert.match(String(detail.recent[0]?.output), /npx supabase stop/);
});

// @req R24
test("without an events log, blocks and rules come from the transcripts", () => {
  const f = fixture();
  rmSync(join(f.state, "events.jsonl"));
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  const o = overview(db, { range: "all" }, f.now);
  assert.equal(o.kpis.blocks, 1, "the transcript's blocking error");
  const rules = items(db, "rule", { range: "all" }, f.now) as any[];
  assert.equal(rules.find((r) => r.name === "branch-guard")?.outcomes.block, 1);
});

// @req R24
test("one hook's timing log doesn't hide another hook's transcript records", () => {
  const f = fixture();
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  // A second hook, never timed, that printed once after timing began for bash-guard.
  apply(db, {
    runs: [
      {
        id: "hook:t-ok:PostToolUse:Bash:formatter",
        kind: "hook",
        name: "formatter",
        detail: "PostToolUse:Bash",
        session: "s1",
        branch: "feat/x",
        cwd: null,
        startedAt: Date.parse(f.at(70)),
        durationMs: 400,
        outcome: "ok",
        toolUseId: "t-ok",
        trigger: null,
        output: "formatted",
      },
    ],
    results: [],
    prompts: [],
    usage: [],
    lastText: null,
    at: null,
  });
  const hooks = items(db, "hook", { range: "all" }, f.now) as any[];
  assert.equal(hooks.find((h) => h.name === "formatter")?.runs, 1);
  assert.equal(hooks.find((h) => h.name === "bash-guard")?.event, "PreToolUse");
});

// @req R25
test("tools are tabled with MCP tools grouped by server", () => {
  const { db, now } = tokenFixture();
  const t = toolsTable(db, { range: "all" }, now);
  assert.equal(t.find((r) => r.name === "Bash")?.runs, 2);
  apply(db, {
    runs: ["a", "b"].map((x) => ({
      id: `tool:m-${x}`,
      kind: "tool" as const,
      name: `mcp__github__${x}`,
      detail: null,
      session: "s9",
      branch: null,
      cwd: null,
      startedAt: now - 1000,
      durationMs: 10,
      outcome: "ok" as const,
      toolUseId: `m-${x}`,
      trigger: null,
      output: null,
    })),
    results: [],
    prompts: [],
    usage: [],
    lastText: null,
    at: null,
  });
  assert.equal(toolsTable(db, { range: "all" }, now).find((r) => r.name === "mcp__github__*")?.runs, 2);
});

// @req R25
test("a hint counts when its skill was loaded earlier in the session, not after the next prompt", () => {
  const f = fixture();
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  const run = (
    id: string,
    at: number,
    kind: "hint" | "skill",
    name: string,
    trigger: string | null,
  ) => ({
    id,
    kind,
    name,
    detail: null,
    session: "s2",
    branch: null,
    cwd: null,
    startedAt: at,
    durationMs: null,
    outcome: "ok" as const,
    toolUseId: null,
    trigger,
    output: null,
  });
  const t0 = Date.parse(f.at(0));
  const empty = { results: [], usage: [], lastText: null, at: null };
  apply(db, {
    ...empty,
    prompts: [{ session: "s2", at: t0, text: "one" }],
    runs: [run("skill:early", t0 + 1000, "skill", "ship", null)],
  });
  apply(db, {
    ...empty,
    prompts: [{ session: "s2", at: t0 + 60_000, text: "two" }],
    runs: [run("hint:a", t0 + 60_500, "hint", "skill-hints", "ship (then code-reviewer)")],
  });
  apply(db, {
    ...empty,
    prompts: [{ session: "s2", at: t0 + 120_000, text: "three" }],
    runs: [run("hint:b", t0 + 120_500, "hint", "skill-hints", "tdd")],
  });
  apply(db, {
    ...empty,
    prompts: [{ session: "s2", at: t0 + 180_000, text: "four" }],
    runs: [run("skill:late", t0 + 181_000, "skill", "tdd", null)],
  });
  const o = overview(db, { range: "all", session: "s2" }, f.now);
  assert.equal(o.kpis.hints, 2);
  assert.equal(
    o.kpis.hintsConverted,
    1,
    "ship was already loaded; tdd came only after the next prompt",
  );
});

// @req R24 R25
test("a session's rule table counts only that session's blocks", () => {
  const f = fixture();
  const db = openStore(":memory:");
  ingest(db, { root: f.root, projectsDir: f.projects });
  appendFileSync(
    join(f.state, "events.jsonl"),
    `${JSON.stringify({ ts: f.at(30), hook: "secret-read", type: "block", branch: "feat/x", detail: "another session" })}\n`,
  );
  ingest(db, { root: f.root, projectsDir: f.projects });
  const mine = items(db, "rule", { range: "all", session: "s1" }, f.now) as any[];
  assert.equal(mine.find((r) => r.name === "branch-guard")?.outcomes.block, 1);
  assert.ok(!mine.some((r) => r.name === "secret-read"), "the log's blocks have no session");
});

/** One session's replies, each written as one line per content block, and one agent's. */
function tokenFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pt-tok-"));
  const root = join(dir, "repo");
  const projects = join(dir, "projects");
  const proj = join(projects, root.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(join(proj, "s9", "subagents"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 15, 0, s)).toISOString();
  const base = (s: number) => ({
    sessionId: "s9",
    gitBranch: "feat/t",
    cwd: root,
    timestamp: at(s),
    uuid: `v${s}`,
  });
  const reply = (s: number, id: string, usage: object, content: object[]) =>
    content.map((c, i) => ({
      ...base(s + i),
      type: "assistant",
      message: { id, model: "claude-opus-5-5", usage, content: [c] },
    }));
  const tool = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
  const main = [
    // Work (npm test) and orchestration (git fetch) in one reply, over three lines.
    ...reply(
      0,
      "m1",
      {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        output_tokens: 30,
        cache_read_input_tokens: 1000,
      },
      [
        { type: "thinking", thinking: "…" },
        tool("b1", "Bash", { command: "npm test" }),
        tool("b2", "Bash", { command: "git fetch origin" }),
      ],
    ),
    // Talking to the owner.
    ...reply(10, "m2", { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 500 }, [
      { type: "text", text: "Done, here's what changed." },
    ]),
    // Only orchestration: a skill and an agent.
    ...reply(20, "m3", { input_tokens: 0, output_tokens: 20 }, [
      tool("sk", "Skill", { skill: "ship" }),
      tool("ag", "Agent", { subagent_type: "code-reviewer", prompt: "Review" }),
    ]),
    {
      ...base(30),
      type: "attachment",
      attachment: {
        type: "hook_success",
        hookName: "PostToolUse:Edit",
        hookEvent: "PostToolUse",
        toolUseID: "b1",
        command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/after-edit.sh',
        stdout: "x".repeat(400),
        durationMs: 50,
      },
    },
  ];
  const agent = reply(40, "r1", { input_tokens: 200, output_tokens: 100 }, [
    { type: "text", text: "Reading it." },
    tool("rd", "Read", { file_path: "a.ts" }),
  ]).map((l) => ({ ...l, isSidechain: true }));
  const write = (file: string, rows: object[]) =>
    writeFileSync(file, `${rows.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const mainFile = join(proj, "s9.jsonl");
  const agentFile = join(proj, "s9", "subagents", "agent-a9.jsonl");
  write(mainFile, main);
  write(agentFile, agent);
  writeFileSync(
    join(proj, "s9", "subagents", "agent-a9.meta.json"),
    JSON.stringify({
      agentType: "code-reviewer",
      description: "Review",
      toolUseId: "ag",
      finished: true,
    }),
  );
  const db = openStore(":memory:");
  const read = () => ingest(db, { root, projectsDir: projects });
  read();
  const def = {
    hooks: ["after-edit"],
    rules: {},
    skills: ["ship"],
    agents: [],
    skillChars: { ship: 800 },
  };
  return { db, read, mainFile, agentFile, now: Date.parse(at(300)), def };
}

// @req R28
test("isOrchestration: coordination tools and commands that only look or wait; everything else is work", () => {
  assert.equal(isOrchestration("Agent", {}), true);
  assert.equal(isOrchestration("SendMessage", {}), true);
  assert.equal(isOrchestration("Skill", { skill: "ship" }), true);
  assert.equal(isOrchestration("CronCreate", {}), true);
  assert.equal(isOrchestration("mcp__ccd_turn__update_plan", {}), true);
  assert.equal(isOrchestration("mcp__scheduled-tasks__list_scheduled_tasks", {}), true);
  assert.equal(isOrchestration("Bash", { command: "git fetch origin" }), true);
  assert.equal(isOrchestration("Bash", { command: "cd /x/y && git status --short" }), true);
  assert.equal(isOrchestration("Bash", { command: "gh run view 123 --log-failed" }), true);
  assert.equal(
    isOrchestration("Bash", { command: "bash scripts/status.sh" }),
    false,
    "a project's own script may do anything: work",
  );
  assert.equal(isOrchestration("Bash", { command: "sleep 30; date" }), true);
  assert.equal(
    isOrchestration("Bash", { command: "gh api repos/o/r/commits/abc/statuses --jq '.[]'" }),
    true,
  );
  assert.equal(isOrchestration("Bash", { command: "git rev-parse HEAD; echo done" }), true);
  assert.equal(
    isOrchestration("Bash", { command: "timeout 60 gh run watch 1 --exit-status || true" }),
    true,
  );
  assert.equal(isOrchestration("Bash", { command: "echo hi" }), false, "nothing looked at");
  assert.equal(
    isOrchestration("Bash", { command: "gh api -X POST repos/o/r/issues" }),
    false,
    "a write",
  );
  assert.equal(
    isOrchestration("Bash", { command: "git log -3 | head -2" }),
    true,
    "read through a filter",
  );
  for (const command of [
    "git log --format=%H | xargs -n1 git revert",
    "git status > out.txt",
    "echo x > a.ts && git status",
    "sleep 1 & npm run build",
    "gh api -XPOST repos/o/r/issues",
    "git log $(rm -rf x)",
  ])
    assert.equal(isOrchestration("Bash", { command }), false, command);
  assert.equal(
    isOrchestration("Bash", { command: "gh run view 1 --json jobs --jq '.jobs[] | .name'" }),
    true,
    "a pipe inside quotes isn't a pipe",
  );
  assert.equal(
    isOrchestration("Bash", { command: 'git log --format="%h > %s" -3' }),
    true,
    "nor is a > inside quotes",
  );
  for (const command of ["git status | sort -o out.txt", "git log | sed -n 'w out.txt'"])
    assert.equal(isOrchestration("Bash", { command }), false, command);
  assert.equal(isOrchestration("mcp__morpheus__morpheus_live", {}), true);
  assert.equal(isOrchestration("Bash", { command: "npm test" }), false);
  assert.equal(
    isOrchestration("Bash", { command: "git status && npm test" }),
    false,
    "a look, then work",
  );
  assert.equal(isOrchestration("Bash", { command: "git commit -m x" }), false);
  assert.equal(isOrchestration("Edit", { file_path: "a.ts" }), false);
  assert.equal(isOrchestration("Read", { file_path: "a.ts" }), false);
  assert.equal(isOrchestration("mcp__Claude_Browser__navigate", {}), false);
});

// @req R23 R28
test("a main-session line keeps its reply's usage with the message id and its block counts", () => {
  const p = parseTranscriptLine(
    JSON.stringify({
      sessionId: "s",
      timestamp: "2026-11-01T12:00:00Z",
      type: "assistant",
      message: {
        id: "m",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 9,
        },
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t", name: "Edit", input: {} },
          { type: "tool_use", id: "u", name: "ToolSearch", input: {} },
        ],
      },
    }),
  );
  assert.deepEqual(p.usage, [
    {
      messageId: "m",
      session: "s",
      branch: null,
      tokensIn: 7,
      tokensOut: 3,
      tokensCached: 9,
      tokensWrite: 2,
      model: "claude-opus-5-5",
      work: 1,
      orchestration: 1,
      text: 1,
    },
  ]);
});

// @req R23
test("a reply written over three lines counts once, with all its blocks", () => {
  const { db } = tokenFixture();
  const rows = db.prepare("select * from usage where message_id = 'm1'").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens_in, 120);
  assert.equal(rows[0].tokens_out, 30);
  assert.equal(rows[0].tokens_cached, 1000);
  assert.equal(rows[0].work, 1);
  assert.equal(rows[0].orchestration, 1);
});

// @req R23 R28
test("an agent's totals count each reply once, not once per line", () => {
  const { db } = tokenFixture();
  const a = db.prepare("select * from agents where agent_id = 'a9'").get() as any;
  assert.equal(a.tokens_in, 200);
  assert.equal(a.tokens_out, 100);
});

// @req R23
test("reading a transcript again from the top doesn't double its tokens", () => {
  const { db, read, mainFile, agentFile, now, def } = tokenFixture();
  const before = tokens(db, { range: "all" }, now, def).totals;
  for (const file of [mainFile, agentFile]) {
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, text.indexOf("\n") + 1));
    read();
    writeFileSync(file, text);
    read();
  }
  assert.deepEqual(tokens(db, { range: "all" }, now, def).totals, before);
  const a = db.prepare("select tokens_in from agents where agent_id = 'a9'").get() as any;
  assert.equal(a.tokens_in, 200);
});

// @req R28
test("tokens splits a mixed reply by its tool blocks; a text-only reply counts as replies", () => {
  const { db, now, def } = tokenFixture();
  const t = tokens(db, { range: "all" }, now, def);
  // m1: 150 new, half work, half orchestration; m3: 20 orchestration; m2: 50 replies; r1: 300 work.
  assert.deepEqual(t.totals.work, { new: 375, cached: 500 });
  assert.deepEqual(t.totals.orchestration, { new: 95, cached: 500 });
  assert.deepEqual(t.totals.replies, { new: 50, cached: 500 });
  assert.equal(t.days.length, 1);
  assert.equal(t.days[0]!.work, 375);
});

// @req R28
test("tokens by session keeps a session's own tokens apart from its agents'; by agent type through the agent's meta", () => {
  const { db, now, def } = tokenFixture();
  const t = tokens(db, { range: "all" }, now, def);
  assert.equal(t.sessions.length, 1);
  assert.equal(t.sessions[0]!.session, "s9");
  assert.deepEqual(t.sessions[0]!.own, { work: 75, orchestration: 95, replies: 50, cached: 1500 });
  assert.deepEqual(t.sessions[0]!.agents, { work: 300, orchestration: 0, replies: 0, cached: 0 });
  assert.equal(t.agents.length, 1);
  assert.equal(t.agents[0]!.type, "code-reviewer");
  assert.equal(t.agents[0]!.runs, 1);
  assert.deepEqual(t.agents[0]!.own, { work: 300, orchestration: 0, replies: 0, cached: 0 });
});

// @req R28
test("hooks' context is their output's chars / 4; skills' is loads × SKILL.md size / 4, both estimates", () => {
  const { db, now, def } = tokenFixture();
  const hook = db.prepare("select chars from runs where kind = 'hook'").get() as any;
  assert.equal(hook.chars, 400);
  const t = tokens(db, { range: "all" }, now, def);
  assert.deepEqual(t.hooks, [{ name: "after-edit", runs: 1, chars: 400, tokens: 100 }]);
  assert.deepEqual(t.skills, [{ name: "ship", loads: 1, chars: 800, tokens: 200 }]);
  assert.equal(t.estimated.hooks + t.estimated.skills, 300);
});

// @req R25 R28
test("tokens counts a nested agent under the type that started it, and narrows by session and branch", () => {
  const { db, now, def } = tokenFixture();
  db.prepare(
    "insert into agents (agent_id, session, agent_type, parent_id) values ('a10', 's9', 'code-quality-reviewer', 'a9')",
  ).run();
  db.prepare(
    "insert into usage (session, message_id, agent_id, branch, at, tokens_in, tokens_out, work) values ('s9/agent-a10', 'q1', 'a10', 'feat/t', ?, 40, 0, 1)",
  ).run(now - 1000);
  db.prepare(
    "insert into usage (session, message_id, branch, at, tokens_in, tokens_out, text) values ('s8', 'o1', 'feat/other', ?, 7, 0, 1)",
  ).run(now - 1000);
  const t = tokens(db, { range: "all" }, now, def);
  const review = t.agents.find((a) => a.type === "code-reviewer");
  assert.deepEqual(review?.agents, { work: 40, orchestration: 0, replies: 0, cached: 0 });
  assert.equal(t.agents.find((a) => a.type === "code-quality-reviewer")?.own.work, 40);
  const mine = tokens(db, { range: "all", session: "s9" }, now, def);
  assert.equal(mine.totals.replies.new, 50, "s8's reply left out");
  assert.equal(mine.totals.work.new, 415, "s9 and its agents, nested included");
  const other = tokens(db, { range: "all", branch: "feat/other" }, now, def);
  assert.deepEqual(other.totals.replies, { new: 7, cached: 0 });
  assert.equal(other.totals.work.new, 0);
});

// @req R28 R29
test("morpheus_tokens answers with the project's skill sizes", () => {
  const { db, now } = tokenFixture();
  const root = mkdtempSync(join(tmpdir(), "pt-root-"));
  mkdirSync(join(root, ".claude", "skills", "ship"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "ship", "SKILL.md"), "y".repeat(800));
  const p = { ...project(root, { db: ":memory:" }), db };
  const tool = TOOLS.find((t) => t.name === "morpheus_tokens");
  const t = tool?.run(p, { range: "all" }, now) as ReturnType<typeof tokens>;
  assert.deepEqual(t.skills, [{ name: "ship", loads: 1, chars: 800, tokens: 200 }]);
});

// @req R26
test("the inventory finds hooks, skills and agents in the project, the user's folder and plugins", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-inv-"));
  const home = mkdtempSync(join(tmpdir(), "pt-home-"));
  mkdirSync(join(root, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "deploy", "SKILL.md"), "z".repeat(120));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "reviewer.md"), "x");
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 .claude/hooks/guard.py" }] }],
        Stop: [{ hooks: [{ type: "command", command: "npx prettier --check ." }] }],
      },
    }),
  );
  mkdirSync(join(home, "skills", "notes"), { recursive: true });
  writeFileSync(join(home, "skills", "notes", "SKILL.md"), "n");
  const plugin = join(home, "plugins", "cache", "acme", "tools", "1.0.0");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tools" }));
  mkdirSync(join(plugin, "skills", "lint"), { recursive: true });
  writeFileSync(join(plugin, "skills", "lint", "SKILL.md"), "l");
  const d = inventory(root, home);
  assert.deepEqual(d.hooks.sort(), ["guard", "npx"]);
  assert.equal(d.hookEvents?.guard, "PreToolUse");
  assert.deepEqual(d.skills.sort(), ["deploy", "notes", "tools:lint"]);
  assert.deepEqual(d.agents, ["reviewer"]);
  assert.equal(d.skillChars?.deploy, 120);
  assert.equal(d.where?.["skill:notes"], "user");
  assert.equal(d.where?.["skill:tools:lint"], "plugin");
});

// @req R32
test("init routes simple hook commands through the timer and undo restores them", () => {
  const settings = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "bash .claude/hooks/guard.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "npm test | tail -1" }] }],
    },
  };
  const on = rewrite(structuredClone(settings));
  assert.equal(on.changed, 1);
  assert.deepEqual(on.skipped, ["npm test | tail -1"], "a pipeline is left alone");
  assert.match(on.settings.hooks.PreToolUse[0].hooks[0].command, /morpheus-time\.sh bash \.claude/);
  assert.equal(rewrite(structuredClone(on.settings)).changed, 0, "wrapping twice does nothing");
  const off = rewrite(on.settings, true);
  assert.deepEqual(off.settings, settings);
  assert.equal(wrappable('bash "$CLAUDE_PROJECT_DIR"/x.sh'), true, "quoted variables are fine");
});

// @req R31
test("the web server answers only localhost and turns query strings into tool input", () => {
  assert.equal(localHost("localhost:4673", 4673), true);
  assert.equal(localHost("127.0.0.1:4673", 4673), true);
  assert.equal(localHost("evil.example:4673", 4673), false, "DNS rebinding");
  assert.equal(localHost(undefined, 4673), false);
  assert.deepEqual(inputOf(new URL("http://x/api/items?kind=hook&range=1h&session=")), {
    kind: "hook",
    range: "1h",
  });
});

// @req R33
test("the CLI reads its flags", () => {
  assert.deepEqual(parseArgs([]), { cmd: "serve", flags: {} });
  assert.deepEqual(parseArgs(["report", "--range", "30d"]), { cmd: "report", flags: { range: "30d" } });
  assert.deepEqual(parseArgs(["--port=5000", "--open"]), { cmd: "serve", flags: { port: "5000", open: true } });
});

// @req R30
test("only mysql-style commands have a -p password masked; other -p flags stay readable", () => {
  for (const command of ["mysql -phunter22 -u root", "mysql -u root -p'a b' db", "mysql -h x -pFirst -pSecond"])
    assert.doesNotMatch(String(redact(command)), /hunter22|a b|Second/, command);
  for (const command of ["ssh -p2222 host", "mkdir -p a/b", "git add -p", "find . -path ./x"])
    assert.equal(redact(command), command, "a -p flag that isn't a password stays readable");
  assert.equal(redact("sshpass -pS3cret ssh -p2222 host"), "sshpass -p[masked] ssh -p2222 host");
});

// @req R31
test("Morpheus makes no outbound calls: no network client imported, no fetch, and the server binds to 127.0.0.1", () => {
  const dir = join(import.meta.dirname, "..", "src");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(src, /from\s+["']node:(https|net|tls|dgram|http2)["']/, `${f} imports a network client`);
    assert.doesNotMatch(src, /\bfetch\(|\bhttp\.(request|get)\(/, `${f} makes a request`);
  }
  assert.match(readFileSync(join(dir, "server.ts"), "utf8"), /\.listen\([^)]*"127\.0\.0\.1"/);
});

// @req R32
test("the hook timer passes the hook's stdin, output and exit code through and logs one line", () => {
  const root = mkdtempSync(join(tmpdir(), "morpheus-timer-"));
  const hook = join(root, "guard.sh");
  writeFileSync(hook, 'read -r line; echo "out:$line"; echo err >&2; exit 2\n');
  const timer = join(import.meta.dirname, "..", "hooks", "morpheus-time.sh");
  const input = '{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t"}';
  const r = spawnSync("bash", [timer, "bash", hook], {
    input: `${input}\n`,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, MORPHEUS_LOG_DIR: join(root, "log") },
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, `out:${input}\n`);
  assert.equal(r.stderr, "err\n");
  const logged = readFileSync(join(root, "log", "runs.jsonl"), "utf8").trim().split("\n");
  assert.equal(logged.length, 1);
  const run = JSON.parse(logged[0]!);
  assert.equal(run.script, "guard");
  assert.equal(run.exit, 2);
  assert.equal(run.tool, "Bash");
  assert.equal(typeof run.ms, "number");
  rmSync(root, { recursive: true, force: true });
});

// @req R33
test("the project is the git repository's main checkout, so a worktree counts as its repo", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "morpheus-repo-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  const tree = join(repo, ".claude", "worktrees", "w1");
  git("worktree", "add", "-q", tree);
  assert.equal(projectRoot(tree), repo);
  assert.equal(projectRoot(repo), repo);
  rmSync(repo, { recursive: true, force: true });
});
