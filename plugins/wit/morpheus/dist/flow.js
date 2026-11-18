/**
 * How the work flows between the person, the main session and what runs on its own: the time
 * sessions sat waiting on the person, the local pipeline Claude runs in the background (tests,
 * checks, builds), what the coordinating main session costs next to its agents, and how often
 * each reviewer agent finds something.
 */
                                                
import { costOf } from "./cost.js";
import { percentile } from "./metrics.js";
import { SLOW_ANSWER_MS } from "./improvements.js";
import { family, tidy } from "./status.js";


/**
 * Time sessions were stopped until the person answered: each blocking ask until its answer (a
 * question or plan) or the person's next prompt (a go-ahead).
 */
export function waitedOnYou(db              , from        , now        ) {
  const asks = db
    .prepare("select session, at, kind, blocked, answered_at from asks where at >= ? and at <= ? order by at")
    .all(from, now)                                                                                                ;
  const next = db.prepare("select min(at) as at from prompts where session = ? and at > ?");
  const waits           = [];
  for (const a of asks) {
    if (!a.blocked) continue;
    const end = a.kind !== "ask" && a.answered_at != null ? a.answered_at : (next.get(a.session, a.at)                         ).at;
    if (end != null) waits.push(end - a.at);
  }
  const p90 = percentile(waits, 90);
  return {
    asks: asks.length,
    blocking: asks.filter((a) => a.blocked).length,
    answered: waits.length,
    totalMs: waits.reduce((s, w) => s + w, 0),
    p50: percentile(waits, 50),
    p90,
    longest: waits.length ? Math.max(...waits) : null,
    slow: waits.filter((w) => w > SLOW_ANSWER_MS).length,
  };
}

/** A command that only waits for something else (a poll loop, a sleep) is not a pipeline step. */
const WAITING = /^(until|while|sleep|for|tail|cat|ls|pgrep|ps|wait)$/;
const WRAPPERS = new Set(["bash", "sh", "zsh", "time", "nohup", "env", "exec", "command", "caffeinate"]);
/** Set-up and look-around commands that come before or after the real step. */
const CHORES = /^(cd|rm|mkdir|cp|mv|set|export|unset|echo|printf|date|true|false|source|\.|test|\[|touch|chmod|ln|trap|read|head|grep|wc|sort|jq|git (branch|status|log|fetch|checkout|switch|stash|rev-parse|diff|show|config|worktree))$/;
/** Tools that run tests, checks and builds: a segment with one of these is the step. */
const BUILD = /\.(sh|py|ts|js|mjs|rb)$|^(npm|pnpm|yarn|npx|bun|deno|make|gradle|gradlew|mvn|cargo|go|pytest|jest|vitest|playwright|maestro|xcodebuild|fastlane|docker|bundle|rake|tsc|eslint|uv|poetry|tox|nox)$/;

/** One command of a shell line as words, without wrappers (`bash`, `timeout 600`, `env`). */
function words(segment        )           {
  const w = segment.replace(/^[({\s]+/, "").split(/\s+/).filter(Boolean);
  while (w.length && (WRAPPERS.has(w[0] ) || w[0] === "timeout")) {
    if (w.shift() === "timeout") w.shift();
    while (w[0]?.startsWith("-")) w.shift(); // the wrapper's own flags: caffeinate -i, bash -lc
  }
  return w;
}

/** The tool and its subcommand: `ship.sh merge`, `git push`, and `npm run test:e2e` for scripts run by name. */
function name(w          )         {
  const out = [w[0] .replace(/^.*\//, "")];
  const max = w[1] === "run" ? 3 : 2;
  for (const x of w.slice(1)) {
    if (out.length >= max || !/^[a-z][\w:.-]*$/i.test(x)) break;
    out.push(x);
  }
  return out.join(" ");
}

/**
 * The step a command runs, as the script or tool and its subcommand: `cd app && git checkout x &&
 * bash scripts/ship.sh branch --device` is "ship.sh branch", `npm run test:e2e -- --ci` is
 * "npm run test:e2e". The first segment running a script or build tool wins, else the first that
 * is not set-up. Null for commands that only wait or look.
 */
export function stepOf(command               )                {
  const segments = (tidy(command) ?? "").split(/\s*(?:&&|\|\||;|\||\n)\s*/).map(words).filter((w) => w.length);
  if (!segments.length || WAITING.test(segments[0] [0] )) return null;
  const real = segments.filter((w) => !CHORES.test(w[0] ) && !CHORES.test(`${w[0]} ${w[1]}`) && !WAITING.test(w[0] ));
  const pick = real.find((w) => BUILD.test(w[0] )) ?? real[0];
  return pick ? name(pick) : null;
}

/**
 * The pipeline Claude runs on this machine: background commands (tests, checks, builds, deploy
 * scripts) by the step they run, with how often each failed or was stopped, and the time failed runs
 * took (a run stopped by hand is often a server or a watcher, so its time is not counted as lost).
 */
export function localPipeline(db              , from        , now        ) {
  const rows = db
    .prepare("select label, command, started_at, ended_at, status from bg where kind = 'command' and ended_at is not null and started_at >= ? and started_at <= ? order by started_at")
    .all(from, now)                                                                                                                   ;
  const steps0 = rows.map((r) => ({ ...r, step: r.command ? stepOf(r.command) : family(tidy(r.label)) || null })).filter((r) => r.step);
  const by = new Map                                                                                                                                                ();
  for (const r of steps0) {
    const k = r.step ;
    const s = by.get(k) ?? { step: k, label: null                 , runs: 0, failed: 0, stopped: 0, ms: 0, lostMs: 0, durations: [] };
    const ms = r.ended_at - r.started_at;
    s.label = tidy(r.label);
    s.runs++;
    s.ms += ms;
    if (r.status === "failed") {
      s.failed++;
      s.lostMs += ms;
    } else if (r.status === "stopped") s.stopped++;
    else s.durations.push(ms);
    by.set(k, s);
  }
  const steps = [...by.values()].map(({ durations, ...s }) => ({ ...s, p50: percentile(durations, 50) }));
  const failed = steps0.filter((r) => r.status === "failed").length;
  const stopped = steps0.filter((r) => r.status === "stopped").length;
  const finished = steps0.length - stopped;
  return {
    runs: steps0.length,
    failed,
    stopped,
    failRate: finished ? failed / finished : null,
    ms: steps.reduce((s, x) => s + x.ms, 0),
    lostMs: steps.reduce((s, x) => s + x.lostMs, 0),
    steps: steps.sort((a, b) => b.failed - a.failed || b.lostMs - a.lostMs || b.runs - a.runs).slice(0, 12),
  };
}

const top = (s        ) => s.replace(/\/agent-.*$/, "");

/**
 * What each session's main thread (the one you talk to, which plans and hands out work) costs
 * next to the agents it started.
 */
export function orchestration(db              , from        , now        ) {
  const rows = db
    .prepare(
      `select session, agent_id is not null or session like '%/agent-%' as agent, model,
              sum(tokens_in) as tin, sum(tokens_out) as tout, sum(tokens_cached) as cached, sum(tokens_write) as tw, sum(tokens_write_1h) as tw1h
         from usage where at >= ? and at <= ? group by session, agent, model`,
    )
    .all(from, now)                                                                                                                                   ;
  const by = new Map                                                           ();
  for (const r of rows) {
    const k = top(r.session);
    const s = by.get(k) ?? { session: k, main: 0, agents: 0 };
    const c = costOf(r.model, { tokensIn: r.tin, tokensOut: r.tout, tokensCached: r.cached, tokensWrite: r.tw, tokensWrite1h: r.tw1h });
    if (r.agent) s.agents += c;
    else s.main += c;
    by.set(k, s);
  }
  const titles = new Map((db.prepare("select session, title from session_titles").all()                                        ).map((r) => [r.session, r.title]));
  const sessions = [...by.values()]
    .filter((s) => s.agents > 0)
    .map((s) => ({ ...s, title: titles.get(s.session) ?? null, mainShare: s.main / (s.main + s.agents) }))
    .sort((a, b) => b.main + b.agents - (a.main + a.agents));
  const main = [...by.values()].reduce((s, x) => s + x.main, 0);
  const agents = [...by.values()].reduce((s, x) => s + x.agents, 0);
  return { main, agents, mainShare: main + agents ? main / (main + agents) : null, sessions: sessions.slice(0, 10) };
}

/** A verdict that asks for something to change, or one that lets the work through. */
export function verdictKind(v               )                               {
  if (!v) return null;
  if (/chang|reject|block|fail|revis|request|fix|no-?go/i.test(v)) return "changes";
  if (/approv|pass|lgtm|ok|ship|accept|go/i.test(v)) return "approve";
  return null;
}

/**
 * Review agents: how often each asks for changes (its catch rate), against what its runs cost.
 * A reviewer that never gives a verdict is listed with no rate.
 */
export function reviewers(db              , from        , now        ) {
  const rows = db
    .prepare("select agent_type, model, verdict, tokens_in, tokens_out, tokens_cached from agents where agent_type like '%review%' and coalesce(last_at, first_at) >= ? and coalesce(first_at, last_at) <= ?")
    .all(from, now)                                                                                                                                        ;
  const by = new Map                                                                                                            ();
  for (const r of rows) {
    const a = by.get(r.agent_type) ?? { name: r.agent_type, runs: 0, approved: 0, changes: 0, noVerdict: 0, cost: 0 };
    a.runs++;
    a.cost += costOf(r.model, { tokensIn: r.tokens_in, tokensOut: r.tokens_out, tokensCached: r.tokens_cached });
    const k = verdictKind(r.verdict);
    if (k === "changes") a.changes++;
    else if (k === "approve") a.approved++;
    else a.noVerdict++;
    by.set(r.agent_type, a);
  }
  return [...by.values()]
    .map((a) => ({
      ...a,
      catchRate: a.approved + a.changes ? a.changes / (a.approved + a.changes) : null,
      costPerCatch: a.changes ? a.cost / a.changes : null,
    }))
    .sort((a, b) => b.runs - a.runs);
}

/** Everything the session cost in a range, for cost per deploy. */
export function spend(db              , from        , now        ) {
  const rows = db
    .prepare("select model, sum(tokens_in) as tin, sum(tokens_out) as tout, sum(tokens_cached) as cached, sum(tokens_write) as tw, sum(tokens_write_1h) as tw1h from usage where at >= ? and at <= ? group by model")
    .all(from, now)                                                                                                   ;
  return rows.reduce((s, r) => s + costOf(r.model, { tokensIn: r.tin, tokensOut: r.tout, tokensCached: r.cached, tokensWrite: r.tw, tokensWrite1h: r.tw1h }), 0);
}
