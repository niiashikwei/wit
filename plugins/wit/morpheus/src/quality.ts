/**
 * Is AI help paying off, and is the code staying healthy? From git and the transcripts: how much of
 * the code Claude co-wrote, how much of that had to be redone soon after, tokens and cost per
 * commit and per line, cache use, corrections, denials and compactions, tool errors, how much test
 * code comes with each change, churn hotspots and coverage of the code that changed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { costOf, priceOf } from "./cost.ts";
import { type Range, since } from "./metrics.ts";
import { HEAVY_CONTEXT } from "./improvements.ts";
import { latestCoverage } from "./pyramid.ts";
import { orchestration, reviewers, waitedOnYou } from "./flow.ts";

const DAY = 86_400_000;
export const REWORK_WINDOW = 14 * DAY;
export const isTestPath = (p: string) => /(^|\/)(tests?|__tests__|spec|e2e|cypress)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$|(Test|IT|Spec)\.\w+$/.test(p);
const isCode = (p: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|scala|rb|php|cs|swift|c|cc|cpp|h|hpp|m|vue|svelte|ex|exs|dart|sh)$/.test(p);


/**
 * Context carried per reply, by session: every reply re-reads the whole conversation, so a long
 * session pays for its history again on each turn even when the cache serves it. Agents count
 * with the session that started them. Heaviest cache-read bill first.
 */
export function contextBySession(db: DatabaseSync, from: number, now: number) {
  const rows = db
    .prepare(
      `select case when instr(session, '/agent-') > 0 then substr(session, 1, instr(session, '/agent-') - 1) else session end as s,
        model, count(*) as replies, sum(tokens_in) as tin, sum(tokens_cached) as cached, sum(tokens_out) as tout,
        sum(tokens_write) as tw, max(at) as last_at
         from usage where at >= ? and at <= ? and coalesce(model, '') <> '<synthetic>' group by s, model`,
    )
    .all(from, now) as { s: string; model: string | null; replies: number; tin: number; cached: number; tout: number; tw: number; last_at: number }[];
  const by = new Map<string, { session: string; replies: number; context: number; cacheReadCost: number; cost: number; lastAt: number }>();
  for (const r of rows) {
    const x = by.get(r.s) ?? { session: r.s, replies: 0, context: 0, cacheReadCost: 0, cost: 0, lastAt: 0 };
    x.replies += r.replies;
    x.context += r.tin + r.cached;
    x.cacheReadCost += (r.cached * (priceOf(r.model)?.cacheRead ?? 0)) / 1e6;
    x.cost += costOf(r.model, { tokensIn: r.tin, tokensOut: r.tout, tokensCached: r.cached, tokensWrite: r.tw });
    x.lastAt = Math.max(x.lastAt, r.last_at);
    by.set(r.s, x);
  }
  return [...by.values()]
    .map(({ context, ...x }) => ({ ...x, contextPerReply: context / x.replies }))
    .sort((a, b) => b.cacheReadCost - a.cacheReadCost);
}

interface FileRow { sha: string; path: string; added: number; deleted: number; at: number; ai: number }

/**
 * Lines redone within two weeks: for each commit's added lines in a file, the lines later commits
 * deleted from that file within the window (at most what it added). An estimate at file level.
 */
export function rework(rows: FileRow[], from: number) {
  const byPath = new Map<string, FileRow[]>();
  for (const r of rows) (byPath.get(r.path) ?? byPath.set(r.path, []).get(r.path)!).push(r);
  const out = { ai: { added: 0, reworked: 0 }, human: { added: 0, reworked: 0 } };
  for (const list of byPath.values()) {
    list.sort((a, b) => a.at - b.at);
    for (const [i, r] of list.entries()) {
      if (r.at < from || !r.added || !isCode(r.path)) continue;
      let later = 0;
      for (const n of list.slice(i + 1)) if (n.at - r.at <= REWORK_WINDOW && n.sha !== r.sha) later += n.deleted;
      const t = r.ai ? out.ai : out.human;
      t.added += r.added;
      t.reworked += Math.min(r.added, later);
    }
  }
  return {
    ai: { ...out.ai, rate: out.ai.added ? out.ai.reworked / out.ai.added : null },
    human: { ...out.human, rate: out.human.added ? out.human.reworked / out.human.added : null },
  };
}

/** Lines in a file now (0 when it's gone or unreadable). */
function linesIn(root: string, path: string): number {
  try {
    const text = readFileSync(join(root, path), "utf8");
    return text ? text.split("\n").length : 0;
  } catch {
    return 0;
  }
}

/** Files a tool writes, not a person or Claude: lockfiles, generated types, snapshots, bundles. */
export const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|Podfile\.lock|pubspec\.lock|mix\.lock|flake\.lock|database\.types\.ts|supabase\.types\.ts)$|(^|\/)(__snapshots__|__generated__|generated|dist|build)\/|\.(min\.(js|css)|map|snap|pb\.go|g\.dart|freezed\.dart)$|_pb2(_grpc)?\.pyi?$|\.(generated|gen)\.\w+$/;

/** A `.gitattributes` glob as a pattern: one without a slash (but a trailing one) matches at any depth. */
export function globRegex(glob: string): RegExp {
  const g = glob.replace(/^\//, "");
  const body = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  // A slash anywhere but the end ties the glob to the repository root.
  const anchored = glob.replace(/\/$/, "").includes("/");
  return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${g.endsWith("/") ? "" : "(/|$)"}`);
}

/** Whether a path is generated: a known generated file, or marked `linguist-generated` in `.gitattributes`. */
export function generatedTest(root: string): (path: string) => boolean {
  let marked: RegExp[] = [];
  try {
    marked = readFileSync(join(root, ".gitattributes"), "utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter(([glob, ...attrs]) => glob && !glob.startsWith("#") && attrs.some((a) => a === "linguist-generated" || a === "linguist-generated=true"))
      .map(([glob]) => globRegex(glob!));
  } catch {
    /* no .gitattributes */
  }
  return (path) => GENERATED.test(path) || marked.some((r) => r.test(path));
}

/**
 * What Claude Code itself says the sessions active in the range cost, over their whole life, next
 * to Wit's estimate from token counts for the same sessions and their agents. Null when no session
 * recorded its cost.
 */
export function reportedCost(db: DatabaseSync, from: number, now: number) {
  const rows = db
    .prepare("select session, cost from session_costs where session in (select distinct session from usage where at >= ? and at <= ?)")
    .all(from, now) as { session: string; cost: number }[];
  if (!rows.length) return null;
  const used = db.prepare(
    `select model, sum(tokens_in) as tin, sum(tokens_out) as tout, sum(tokens_cached) as cached, sum(tokens_write) as tw
       from usage where session = ? or session like ? || '/agent-%' group by model`,
  );
  let estimate = 0;
  for (const r of rows)
    for (const u of used.all(r.session, r.session) as { model: string | null; tin: number; tout: number; cached: number; tw: number }[])
      estimate += costOf(u.model, { tokensIn: u.tin, tokensOut: u.tout, tokensCached: u.cached, tokensWrite: u.tw });
  return { sessions: rows.length, cost: rows.reduce((s, r) => s + r.cost, 0), estimate };
}

export function quality(db: DatabaseSync, root: string, range: Range, now: number, tasks?: { tasks: number; corrected: number }) {
  const from = since(range === "1h" || range === "today" ? "7d" : range, now);
  const commits = db.prepare("select sha, at, ai, added, deleted, files, landed, is_merge from commits where at >= ? and at <= ?").all(from, now) as { sha: string; at: number; ai: number; added: number; deleted: number; files: number; landed: number; is_merge: number }[];
  const real = commits.filter((c) => !c.is_merge);
  const ai = real.filter((c) => c.ai);
  const allFiles = db
    .prepare("select f.sha, f.path, f.added, f.deleted, c.at, c.ai from commit_files f join commits c on c.sha = f.sha where c.at >= ? and c.is_merge = 0")
    .all(from) as unknown as FileRow[];
  // Generated files churn with every regeneration: they say nothing about whether code sticks.
  const generated = generatedTest(root);
  const files = allFiles.filter((f) => !generated(f.path));
  const reported = reportedCost(db, from, now);
  const usage = db.prepare("select model, tokens_in, tokens_out, tokens_cached, tokens_write from usage where at >= ? and at <= ?").all(from, now) as { model: string | null; tokens_in: number; tokens_out: number; tokens_cached: number; tokens_write: number }[];
  const tokensNew = usage.reduce((s, u) => s + u.tokens_in + u.tokens_out, 0);
  const tokensIn = usage.reduce((s, u) => s + u.tokens_in, 0);
  const cached = usage.reduce((s, u) => s + u.tokens_cached, 0);
  const cost = usage.reduce((s, u) => s + costOf(u.model, { tokensIn: u.tokens_in, tokensOut: u.tokens_out, tokensCached: u.tokens_cached, tokensWrite: u.tokens_write }), 0);
  const aiAdded = ai.reduce((s, c) => s + c.added, 0);
  const sessionsCtx = contextBySession(db, from, now);
  const replies = sessionsCtx.reduce((s, x) => s + x.replies, 0);
  const cacheReadCost = sessionsCtx.reduce((s, x) => s + x.cacheReadCost, 0);
  // Time hooks hold the work up: those that run before a prompt, a tool call or a turn's end wait
  // in line; PostToolUse and SessionStart hooks are left out (they rarely gate the next step).
  const wait = db
    .prepare(
      `select coalesce(sum(duration_ms), 0) as ms, count(duration_ms) as runs from runs where kind = 'hook' and started_at >= ? and started_at <= ?
         and (detail like 'PreToolUse%' or detail like 'UserPromptSubmit%' or detail like 'PermissionRequest%' or detail in ('Stop', 'SubagentStop'))`,
    )
    .get(from, now) as { ms: number; runs: number };
  const prompts = Number((db.prepare("select count(*) as n from prompts where at >= ? and at <= ?").get(from, now) as { n: number }).n);
  const prs = Number((db.prepare("select count(*) as n from prs where last_at >= ?").get(from) as { n: number }).n);
  const marks = db.prepare("select type, count(*) as n from marks where at >= ? group by type").all(from) as { type: string; n: number }[];
  const mark = (t: string) => Number(marks.find((m) => m.type === t)?.n ?? 0);
  const sessions = Number((db.prepare("select count(distinct session) as n from prompts where at >= ?").get(from) as { n: number }).n);
  const toolRuns = db.prepare("select outcome, count(*) as n from runs where kind = 'tool' and started_at >= ? group by outcome").all(from) as { outcome: string; n: number }[];
  const toolTotal = toolRuns.reduce((s, r) => s + Number(r.n), 0);
  const toolErrors = Number(toolRuns.find((r) => r.outcome === "error")?.n ?? 0);
  const testLines = (rows: FileRow[]) => {
    const code = rows.filter((r) => isCode(r.path));
    const test = code.filter((r) => isTestPath(r.path)).reduce((s, r) => s + r.added, 0);
    const src = code.filter((r) => !isTestPath(r.path)).reduce((s, r) => s + r.added, 0);
    return { test, src, ratio: src ? test / src : null };
  };
  // Hotspots: files changed most often with the most churn, with their size now.
  const churn = new Map<string, { path: string; commits: number; churn: number; aiCommits: number }>();
  for (const r of files) {
    if (!isCode(r.path)) continue;
    const h = churn.get(r.path) ?? { path: r.path, commits: 0, churn: 0, aiCommits: 0 };
    h.commits++;
    h.churn += r.added + r.deleted;
    h.aiCommits += r.ai;
    churn.set(r.path, h);
  }
  const hotspots = [...churn.values()]
    .sort((a, b) => b.commits * b.churn - a.commits * a.churn)
    .slice(0, 15)
    .map((h) => ({ ...h, lines: linesIn(root, h.path) }));
  // Coverage of the code that changed in range (not tests), from the latest coverage reports.
  const cov = latestCoverage(db).files;
  const changed = [...new Set(files.filter((f) => isCode(f.path) && !isTestPath(f.path)).map((f) => f.path))];
  const covered = changed.filter((p) => cov.has(p)).map((p) => ({ path: p, ...cov.get(p)! }));
  const sum = covered.reduce((s, c) => ({ lt: s.lt + c.lt, lh: s.lh + c.lh }), { lt: 0, lh: 0 });
  const weeks: { week: number; commits: number; aiCommits: number; tokens: number }[] = [];
  for (let w = Math.max(from, now - 26 * 7 * DAY); w < now; w += 7 * DAY) {
    const cs = real.filter((c) => c.at >= w && c.at < w + 7 * DAY);
    const tokens = Number((db.prepare("select coalesce(sum(tokens_in + tokens_out), 0) as t from usage where at >= ? and at < ?").get(w, w + 7 * DAY) as { t: number }).t);
    weeks.push({ week: w, commits: cs.length, aiCommits: cs.filter((c) => c.ai).length, tokens });
  }
  return {
    range: range === "1h" || range === "today" ? "7d" : range,
    commits: real.length,
    ai: {
      commits: ai.length,
      share: real.length ? ai.length / real.length : null,
      linesAdded: aiAdded,
      lineShare: real.reduce((s, c) => s + c.added, 0) ? aiAdded / real.reduce((s, c) => s + c.added, 0) : null,
    },
    rework: rework(files, from),
    efficiency: {
      tokensNew,
      cost,
      tokensPerCommit: ai.length ? tokensNew / ai.length : null,
      costPerCommit: ai.length ? cost / ai.length : null,
      tokensPerLine: aiAdded ? tokensNew / aiAdded : null,
      cacheHit: cached + tokensIn ? cached / (cached + tokensIn) : null,
      // What carrying the conversation costs: context re-read on each reply, and its share of the bill.
      contextPerReply: replies ? sessionsCtx.reduce((s, x) => s + x.contextPerReply * x.replies, 0) / replies : null,
      cacheReadCost,
      reported,
      cacheReadShare: cost ? cacheReadCost / cost : null,
      heavySessions: sessionsCtx.filter((x) => x.contextPerReply > HEAVY_CONTEXT).slice(0, 8),
    },
    process: {
      sessions,
      compactions: mark("compact"),
      compactionsPerSession: sessions ? mark("compact") / sessions : null,
      denials: mark("denied"),
      interrupts: mark("interrupt"),
      corrections: tasks?.corrected ?? null,
      correctionRate: tasks?.tasks ? tasks.corrected / tasks.tasks : null,
      toolCalls: toolTotal,
      toolErrorRate: toolTotal ? toolErrors / toolTotal : null,
      hookWaitMs: Number(wait.ms),
      hookWaitPerPrompt: prompts && wait.runs ? Number(wait.ms) / prompts : null,
      apiErrors: mark("api_error"),
      silentTurns: mark("silent"),
      prs,
    },
    waiting: waitedOnYou(db, from, now),
    orchestration: orchestration(db, from, now),
    reviewers: reviewers(db, from, now),
    tests: { all: testLines(files), ai: testLines(files.filter((f) => f.ai)) },
    hotspots,
    changedCoverage: {
      files: changed.length,
      measured: covered.length,
      lines: sum.lt ? sum.lh / sum.lt : null,
      lowest: covered.filter((c) => c.lt).map((c) => ({ path: c.path, lines: c.lh / c.lt, linesTotal: c.lt })).sort((a, b) => a.lines - b.lines).slice(0, 10),
    },
    weeks,
  };
}
