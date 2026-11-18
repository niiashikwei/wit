/**
 * Cost levers: where the main session's money and time go in ways a change of habit can cut.
 *   - Context size: every reply re-reads the whole conversation, so a long session pays for its
 *     history again on each round trip. Replies are banded by the context they carried, and the
 *     cache reads above HEAVY_CONTEXT are what starting fresh sooner would have saved.
 *   - Watching CI: each poll of a PR or a pipeline from the main session is one more reply that
 *     re-reads that context. A cheap watcher that reports back once costs a fraction.
 *   - Hooks on every call: a hook that runs before each tool call adds its time to all of them.
 */
                                                
import { costOf, priceOf } from "./cost.js";
import { percentile } from "./metrics.js";
import { HEAVY_CONTEXT } from "./improvements.js";

/** Context bands, in tokens carried per reply. */
export const BANDS = [0, 100_000, 200_000, 400_000, 800_000];
/** A hook this fast is about as fast as a hook gets (a process start and a quick check). */
export const FAST_HOOK_MS = 100;
/** A hook that runs at least this often is on the hot path. */
export const HOT_RUNS = 100;
/** Events whose hooks run on every tool call or prompt, holding each one up. */
export const PER_CALL = new Set(["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit"]);

const MAIN = "agent_id is null and session not like '%/agent-%'";

                                                                                                                            

function mainReplies(db              , from        , now        )          {
  return db
    .prepare(
      `select session, at, model, tokens_in as tin, tokens_out as tout, tokens_cached as cached, tokens_write as tw
         from usage where ${MAIN} and at >= ? and at <= ? order by session, at`,
    )
    .all(from, now)                      ;
}

const replyCost = (r       ) => costOf(r.model, { tokensIn: r.tin, tokensOut: r.tout, tokensCached: r.cached, tokensWrite: r.tw });
const contextOf = (r       ) => r.tin + r.cached;

/**
 * The main session's replies by the context they carried, with what each band cost, and the cache
 * reads spent on context above HEAVY_CONTEXT (what keeping sessions under it would have saved).
 */
export function contextBands(db              , from        , now        ) {
  const rows = mainReplies(db, from, now);
  const bands = BANDS.map((min, i) => ({ min, max: BANDS[i + 1] ?? null, replies: 0, cost: 0 }));
  let cost = 0;
  let overCap = 0;
  for (const r of rows) {
    const ctx = contextOf(r);
    const c = replyCost(r);
    cost += c;
    const b = bands.findLast((x) => ctx >= x.min) ;
    b.replies++;
    b.cost += c;
    const over = Math.min(r.cached, Math.max(0, ctx - HEAVY_CONTEXT));
    overCap += (over * (priceOf(r.model)?.cacheRead ?? 0)) / 1e6;
  }
  const heavy = bands.filter((b) => b.min >= HEAVY_CONTEXT);
  return {
    replies: rows.length,
    cost,
    bands,
    heavyReplies: heavy.reduce((s, b) => s + b.replies, 0),
    heavyShare: rows.length ? heavy.reduce((s, b) => s + b.replies, 0) / rows.length : null,
    overCap,
    overCapShare: cost ? overCap / cost : null,
  };
}

/** Commands that look at CI or a PR, or wait in a loop for something to change. */
const WATCH_CMD =
  /\bgh\s+(run|pr|workflow)\s+(watch|view|checks|list|status)\b|\bgh\s+api\b[^|;&]*(check-runs|check-suites|actions\/runs|statuses|\/pulls)|^\s*(sleep|until|while)\b/;
/** Tools that exist to watch: monitors, wake-ups, PR status and auto-merge. */
const WATCH_TOOL = /^(Monitor|ScheduleWakeup|TaskOutput)$|__ccd_pr__|__github__.*(status|check|workflow_run)/i;

/** What kind of watching a tool call is, or null when it does work. */
export function watchKind(tool        , command               )                {
  if (tool === "Bash") {
    const c = command ?? "";
    if (/^\s*(sleep|until|while)\b/.test(c)) return "poll loop";
    if (WATCH_CMD.test(c)) return "gh";
    return null;
  }
  if (/__ccd_pr__/.test(tool)) return "PR tools";
  return WATCH_TOOL.test(tool) ? tool.replace(/^mcp__[^_]+__/, "") : null;
}

/**
 * Main-session calls that watched CI and PRs, each costed as the reply that read its result (the
 * whole context again).
 */
export function ciWatching(db              , from        , now        ) {
  const calls = db
    .prepare(`select session, name, trigger, started_at as at from runs where kind = 'tool' and ${MAIN} and started_at >= ? and started_at <= ? order by session, started_at`)
    .all(from, now)                                                                           ;
  const watching = calls.map((c) => ({ ...c, kind: watchKind(c.name, c.trigger) })).filter((c) => c.kind);
  const replies = new Map                 ();
  for (const r of mainReplies(db, from, now + 3_600_000)) {
    const list = replies.get(r.session) ?? [];
    list.push(r);
    replies.set(r.session, list);
  }
  const by = new Map                                                       ();
  let cost = 0;
  let context = 0;
  let priced = 0;
  for (const c of watching) {
    const list = replies.get(c.session) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] .at < c.at) lo = mid + 1;
      else hi = mid;
    }
    const next = list[lo];
    const k = by.get(c.kind ) ?? { kind: c.kind , calls: 0, cost: 0 };
    k.calls++;
    if (next) {
      const v = replyCost(next);
      k.cost += v;
      cost += v;
      context += contextOf(next);
      priced++;
    }
    by.set(c.kind , k);
  }
  return {
    calls: watching.length,
    mainCalls: calls.length,
    share: calls.length ? watching.length / calls.length : null,
    cost,
    perCall: priced ? cost / priced : null,
    contextPerCall: priced ? context / priced : null,
    kinds: [...by.values()].sort((a, b) => b.cost - a.cost),
  };
}

/**
 * Hooks that run often, by the time they add in all. `lostMs` is the time above what a fast hook
 * takes; `hot` marks the ones on every tool call or prompt that are worth making faster.
 */
export function hotHooks(db              , from        , now        ) {
  const rows = db
    .prepare("select name, detail, duration_ms as ms from runs where kind = 'hook' and duration_ms is not null and started_at >= ? and started_at <= ?")
    .all(from, now)                                                         ;
  const by = new Map                                                              ();
  for (const r of rows) {
    const h = by.get(r.name) ?? { name: r.name, event: r.detail?.split(":")[0] || null, ms: [] };
    h.ms.push(r.ms);
    by.set(r.name, h);
  }
  return [...by.values()]
    .filter((h) => h.ms.length >= HOT_RUNS)
    .map((h) => {
      const p50 = percentile(h.ms, 50) ?? 0;
      const totalMs = h.ms.reduce((s, x) => s + x, 0);
      const lostMs = h.ms.reduce((s, x) => s + Math.max(0, x - FAST_HOOK_MS), 0);
      return { name: h.name, event: h.event, runs: h.ms.length, p50, totalMs, lostMs, hot: PER_CALL.has(h.event ?? "") && p50 >= 2.5 * FAST_HOOK_MS };
    })
    .sort((a, b) => b.lostMs - a.lostMs)
    .slice(0, 8);
}

/** All three levers for a range. */
export function levers(db              , from        , now        ) {
  return { context: contextBands(db, from, now), ci: ciWatching(db, from, now), hooks: hotHooks(db, from, now) };
}
