/**
 * One scorecard for the whole delivery cycle: each stage (plan, code, review, test, build, deploy,
 * operate, AI efficiency) is good, needs a look, or bad, with the numbers and thresholds that
 * decided it. A stage with no data says how to turn it on, rather than guessing.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Band } from "./dora.ts";
import { since, type Range } from "./metrics.ts";
import { verdictKind } from "./flow.ts";

export type Status = "good" | "warn" | "bad" | "unknown";
export type Unit = "pct" | "ms" | "perWeek" | "count" | "band" | "ratio";
export interface Metric {
  label: string;
  value: number | string | null;
  unit: Unit;
  target: string;
  status: Status;
}
export interface Stage {
  key: string;
  label: string;
  question: string;
  status: Status;
  metrics: Metric[];
  hint: string | null;
}

/** Good when at or past `good`, a warning to `ok`, bad beyond; `up` says which way is better. */
export function grade(v: number | null | undefined, good: number, ok: number, up: boolean): Status {
  if (v == null || !Number.isFinite(v)) return "unknown";
  if (up) return v >= good ? "good" : v >= ok ? "warn" : "bad";
  return v <= good ? "good" : v <= ok ? "warn" : "bad";
}
export const bandStatus = (b: Band): Status => (b == null ? "unknown" : b === "elite" || b === "high" ? "good" : b === "medium" ? "warn" : "bad");
const ORDER: Status[] = ["bad", "warn", "good"];
/** A stage is as healthy as its worst known metric. */
export function worst(ms: Metric[]): Status {
  const known = ms.map((m) => m.status).filter((s) => s !== "unknown");
  return known.length ? known.reduce((w, s) => (ORDER.indexOf(s) < ORDER.indexOf(w) ? s : w)) : "unknown";
}

/** The best known metric: a stage any one of whose routes is enough (a PR or an agent review). */
export function best(ms: Metric[]): Status {
  const known = ms.map((m) => m.status).filter((s) => s !== "unknown");
  return known.length ? known.reduce((b, s) => (ORDER.indexOf(s) > ORDER.indexOf(b) ? s : b)) : "unknown";
}

/** A squash-merged pull request: GitHub ends its subject with the PR number. */
const PR_SUBJECT = /\(#\d+\)\s*$/;
/** Commits reaching main within this long of each other landed together (a rebased or cherry-picked batch). */
export const BATCH_GAP_MS = 10 * 60_000;

/**
 * How changes reached the main branch: by a merge or a squash-merged pull request, or in batches
 * (commits landing within ten minutes of each other) set against the review agents' approvals.
 */
export function landings(db: DatabaseSync, from: number) {
  const rows = db.prepare("select at, is_merge, subject from commits where landed = 1 and at >= ? order by at").all(from) as { at: number; is_merge: number; subject: string | null }[];
  let viaPr = 0;
  let batches = 0;
  let prev: number | null = null;
  for (const r of rows) {
    const pr = r.is_merge === 1 || PR_SUBJECT.test(r.subject ?? "");
    if (pr) viaPr++;
    if (pr || prev == null || r.at - prev > BATCH_GAP_MS) batches++;
    prev = r.at;
  }
  const verdicts = db.prepare("select verdict from agents where agent_type like '%review%' and coalesce(first_at, last_at) >= ?").all(from) as { verdict: string | null }[];
  const approvals = verdicts.filter((v) => verdictKind(v.verdict) === "approve").length;
  return {
    commits: rows.length,
    viaPr,
    batches,
    approvals,
    prShare: rows.length ? viaPr / rows.length : null,
    reviewedShare: rows.length && approvals ? Math.min(1, approvals / batches) : null,
  };
}

export interface HealthInputs {
  dora: { frequency: { perWeek: number; band: Band }; leadTime: { p50: number | null; band: Band }; failureRate: { rate: number | null; band: Band }; restore: { p50: number | null; band: Band }; deploys: number; ci: { passRate: number | null; runs: number } };
  tasks: { totals: { tasks: number; corrected: number; cacheHit: number | null } };
  quality: { rework: { ai: { rate: number | null } }; process: { toolErrorRate: number | null }; efficiency: { contextPerReply: number | null }; changedCoverage: { lines: number | null } };
  tests: { node: { tests: number; passed: number; failed: number; flaky: number; coverage: { lines: number } | null } };
  ghOn: boolean;
}

export function health(db: DatabaseSync, range: Range, now: number, x: HealthInputs) {
  const m = (label: string, value: number | string | null, unit: Unit, target: string, status: Status): Metric => ({ label, value, unit, target, status });
  const from = since(range === "1h" || range === "today" ? "7d" : range, now);
  const land = landings(db, from);
  const correction = x.tasks.totals.tasks ? x.tasks.totals.corrected / x.tasks.totals.tasks : null;
  const t = x.tests.node;
  // Only tests with a result count: tests found in the source but never run say nothing yet.
  const ran = t.passed + t.failed;
  const failShare = ran ? t.failed / ran : null;
  const stages: Stage[] = [
    {
      key: "plan", label: "Plan", question: "Does Claude understand what you ask the first time?",
      metrics: [m("Prompts corrected or interrupted", correction, "pct", "≤ 10%", grade(correction, 0.1, 0.25, false))],
      hint: correction == null ? "No prompts recorded in this range yet." : null, status: "unknown",
    },
    {
      key: "code", label: "Code", question: "Does AI-written code stick?",
      metrics: [m("AI lines redone within 14 days", x.quality.rework.ai.rate, "pct", "≤ 10%", grade(x.quality.rework.ai.rate, 0.1, 0.2, false))],
      hint: x.quality.rework.ai.rate == null ? "No Claude co-authored commits yet: Claude Code adds a Co-Authored-By trailer when it commits." : null, status: "unknown",
    },
    {
      key: "review", label: "Review", question: "Do changes land through review?",
      metrics: [
        m("Changes landed by merge or PR", land.prShare, "pct", "≥ 80%", grade(land.prShare, 0.8, 0.4, true)),
        ...(land.reviewedShare == null ? [] : [m("Landings approved by a review agent", land.reviewedShare, "pct", "≥ 80%", grade(land.reviewedShare, 0.8, 0.4, true))]),
      ],
      hint: land.prShare == null ? "No changes landed on the main branch in this range." : null, status: "unknown",
    },
    {
      key: "test", label: "Test", question: "Is the code tested, and do the tests pass?",
      metrics: [
        m("Line coverage", t.coverage?.lines ?? null, "pct", "≥ 80%", grade(t.coverage?.lines, 0.8, 0.6, true)),
        m("Changed code covered", x.quality.changedCoverage.lines, "pct", "≥ 80%", grade(x.quality.changedCoverage.lines, 0.8, 0.6, true)),
        m("Failing tests", failShare, "pct", "0%", grade(failShare, 0, 0.05, false)),
        m("Flaky tests", ran ? t.flaky : null, "count", "0", ran ? grade(t.flaky, 0, 3, false) : "unknown"),
      ],
      hint: t.coverage == null ? "No coverage report found: run your tests with coverage (lcov, Cobertura, coverage.py JSON, JaCoCo, Go profile) or list it in .claude/wit.json." : null, status: "unknown",
    },
    {
      key: "build", label: "Build & CI", question: "Does CI stay green?",
      metrics: [m("CI runs passing", x.dora.ci.passRate, "pct", "≥ 90%", grade(x.dora.ci.passRate, 0.9, 0.75, true))],
      hint: x.ghOn ? (x.dora.ci.runs ? null : "No CI runs found on GitHub for this range.") : 'Turn on GitHub data with "gh": true in .claude/wit.json (uses the gh CLI).', status: "unknown",
    },
    {
      key: "deploy", label: "Deploy", question: "How often and how fast do changes ship?",
      metrics: [
        m("Deploys a week", x.dora.frequency.perWeek, "perWeek", "daily or more", bandStatus(x.dora.frequency.band)),
        m("Lead time for changes", x.dora.leadTime.p50, "ms", "< 1 day", bandStatus(x.dora.leadTime.band)),
      ],
      hint: x.dora.deploys ? null : "No deploys in this range. Set what counts as a deploy with \"deploy\" in .claude/wit.json.", status: "unknown",
    },
    {
      key: "operate", label: "Operate", question: "How often do deploys break, and how fast are they fixed?",
      metrics: [
        m("Change failure rate", x.dora.failureRate.rate, "pct", "≤ 5%", bandStatus(x.dora.failureRate.band)),
        m("Time to restore", x.dora.restore.p50, "ms", "< 1 hour", bandStatus(x.dora.restore.band)),
      ],
      hint: x.dora.deploys ? null : "Needs deploys first.", status: "unknown",
    },
    {
      key: "ai", label: "AI efficiency", question: "Are tokens well spent?",
      metrics: [
        m("Cache hit rate", x.tasks.totals.cacheHit, "pct", "≥ 70%", grade(x.tasks.totals.cacheHit, 0.7, 0.5, true)),
        m("Tool calls failing", x.quality.process.toolErrorRate, "pct", "≤ 5%", grade(x.quality.process.toolErrorRate, 0.05, 0.1, false)),
        // Each reply re-reads the conversation: a long session pays for its history on every turn,
        // however well the cache serves it. Compacting or starting fresh is what brings this down.
        m("Context carried per reply", x.quality.efficiency.contextPerReply, "count", "≤ 150k tokens", grade(x.quality.efficiency.contextPerReply, 150_000, 300_000, false)),
      ],
      hint: null, status: "unknown",
    },
  ];
  // Review passes by either route: a pull request or an agent's review before landing.
  for (const s of stages) s.status = s.key === "review" ? best(s.metrics) : worst(s.metrics);
  const known = stages.filter((s) => s.status !== "unknown");
  const score = known.length ? Math.round((100 * known.reduce((sum, s) => sum + (s.status === "good" ? 1 : s.status === "warn" ? 0.5 : 0), 0)) / known.length) : null;
  return { score, stages, measured: known.length };
}
