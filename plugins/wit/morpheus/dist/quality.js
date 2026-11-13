/**
 * Is AI help paying off, and is the code staying healthy? From git and the transcripts: how much of
 * the code Claude co-wrote, how much of that had to be redone soon after, tokens and cost per
 * commit and per line, cache use, corrections, denials and compactions, tool errors, how much test
 * code comes with each change, churn hotspots and coverage of the code that changed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
                                                
import { costOf } from "./cost.js";
import {             since } from "./metrics.js";
import { latestCoverage } from "./pyramid.js";

const DAY = 86_400_000;
export const REWORK_WINDOW = 14 * DAY;
export const isTestPath = (p        ) => /(^|\/)(tests?|__tests__|spec|e2e|cypress)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$|(Test|IT|Spec)\.\w+$/.test(p);
const isCode = (p        ) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|scala|rb|php|cs|swift|c|cc|cpp|h|hpp|m|vue|svelte|ex|exs|dart|sh)$/.test(p);

                                                                                                       

/**
 * Lines redone within two weeks: for each commit's added lines in a file, the lines later commits
 * deleted from that file within the window (at most what it added). An estimate at file level.
 */
export function rework(rows           , from        ) {
  const byPath = new Map                   ();
  for (const r of rows) (byPath.get(r.path) ?? byPath.set(r.path, []).get(r.path) ).push(r);
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
function linesIn(root        , path        )         {
  try {
    const text = readFileSync(join(root, path), "utf8");
    return text ? text.split("\n").length : 0;
  } catch {
    return 0;
  }
}

export function quality(db              , root        , range       , now        , tasks                                       ) {
  const from = since(range === "1h" || range === "today" ? "7d" : range, now);
  const commits = db.prepare("select sha, at, ai, added, deleted, files, landed, is_merge from commits where at >= ? and at <= ?").all(from, now)                                                                                                                              ;
  const real = commits.filter((c) => !c.is_merge);
  const ai = real.filter((c) => c.ai);
  const files = db
    .prepare("select f.sha, f.path, f.added, f.deleted, c.at, c.ai from commit_files f join commits c on c.sha = f.sha where c.at >= ? and c.is_merge = 0")
    .all(from)                        ;
  const usage = db.prepare("select model, tokens_in, tokens_out, tokens_cached, tokens_write from usage where at >= ? and at <= ?").all(from, now)                                                                                                                  ;
  const tokensNew = usage.reduce((s, u) => s + u.tokens_in + u.tokens_out, 0);
  const tokensIn = usage.reduce((s, u) => s + u.tokens_in, 0);
  const cached = usage.reduce((s, u) => s + u.tokens_cached, 0);
  const cost = usage.reduce((s, u) => s + costOf(u.model, { tokensIn: u.tokens_in, tokensOut: u.tokens_out, tokensCached: u.tokens_cached, tokensWrite: u.tokens_write }), 0);
  const aiAdded = ai.reduce((s, c) => s + c.added, 0);
  const marks = db.prepare("select type, count(*) as n from marks where at >= ? group by type").all(from)                                 ;
  const mark = (t        ) => Number(marks.find((m) => m.type === t)?.n ?? 0);
  const sessions = Number((db.prepare("select count(distinct session) as n from prompts where at >= ?").get(from)                 ).n);
  const toolRuns = db.prepare("select outcome, count(*) as n from runs where kind = 'tool' and started_at >= ? group by outcome").all(from)                                    ;
  const toolTotal = toolRuns.reduce((s, r) => s + Number(r.n), 0);
  const toolErrors = Number(toolRuns.find((r) => r.outcome === "error")?.n ?? 0);
  const testLines = (rows           ) => {
    const code = rows.filter((r) => isCode(r.path));
    const test = code.filter((r) => isTestPath(r.path)).reduce((s, r) => s + r.added, 0);
    const src = code.filter((r) => !isTestPath(r.path)).reduce((s, r) => s + r.added, 0);
    return { test, src, ratio: src ? test / src : null };
  };
  // Hotspots: files changed most often with the most churn, with their size now.
  const churn = new Map                                                                             ();
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
  const covered = changed.filter((p) => cov.has(p)).map((p) => ({ path: p, ...cov.get(p)  }));
  const sum = covered.reduce((s, c) => ({ lt: s.lt + c.lt, lh: s.lh + c.lh }), { lt: 0, lh: 0 });
  const weeks                                                                         = [];
  for (let w = Math.max(from, now - 26 * 7 * DAY); w < now; w += 7 * DAY) {
    const cs = real.filter((c) => c.at >= w && c.at < w + 7 * DAY);
    const tokens = Number((db.prepare("select coalesce(sum(tokens_in + tokens_out), 0) as t from usage where at >= ? and at < ?").get(w, w + 7 * DAY)                 ).t);
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
    },
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
