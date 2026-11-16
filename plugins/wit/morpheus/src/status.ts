/**
 * Where things stand, without asking Claude: the sessions at work, what each is waiting on you
 * for, the work running on its own (background commands and agents, monitors, CI) with when it
 * should finish, and what finished lately. Finish times come from how long the same kind of work
 * took before: the median, and the 90th percentile as the point it counts as overdue.
 */
import type { DatabaseSync } from "node:sqlite";
import { percentile } from "./metrics.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Sessions active within this long are shown. */
export const SESSION_WINDOW = 24 * HOUR;
/** Finished work within this long is listed as recent. */
export const RECENT_WINDOW = 6 * HOUR;
/** A monitor stops after this long unless it says otherwise (the Monitor tool's default). */
const MONITOR_MS = 30 * MIN;
/** An agent that wrote nothing for this long is not counted as running. */
const AGENT_QUIET_MS = 10 * MIN;
/** A session that did something this recently is working. */
const WORKING_MS = 2 * MIN;
/** Background work older than this, and three times its usual time, never reported back. */
export const LOST_MS = 3 * HOUR;
/** Past runs of the same kind needed before a finish time is given. */
const MIN_SAMPLES = 2;

/**
 * A command as a person would name it: without the environment set up before it, its output
 * redirections or the tail of its output.
 */
export function tidy(label: string | null): string | null {
  if (!label) return label;
  const t = label
    .replace(/^(\s*((export\s+)?[A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|[^\s;&]*)|cd\s+("[^"]*"|\S+))\s*(;|&&)?\s*)+/, "")
    .replace(/\s*\d?>>?\s*(&\d|\S+)/g, "")
    .replace(/\s*\|\s*tail\b[^|;]*/g, "")
    .trim();
  return t || label;
}

/** The kind of work a label names: its first words without ids, hashes, numbers or paths. */
export function family(label: string | null): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{7,40}\b/g, "")
    .replace(/\/\S*\/(\S+)/g, "$1")
    .replace(/[^a-z\s.:-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 4)
    .join(" ");
}

/** When work started at `at` should finish, from how long the same kind took before. */
export function eta(at: number, history: number[], now: number) {
  if (history.length < MIN_SAMPLES) return { p50: null, p90: null, eta: null, overdue: false, samples: history.length };
  const p50 = percentile(history, 50)!;
  const p90 = percentile(history, 90)!;
  return { p50, p90, eta: at + p50, overdue: now > at + p90, samples: history.length };
}

const top = (s: string) => s.replace(/\/agent-.*$/, "");

export function status(db: DatabaseSync, now: number) {
  const titles = new Map((db.prepare("select session, title from session_titles").all() as { session: string; title: string }[]).map((r) => [r.session, r.title]));
  const lastPrompt = new Map(
    (db.prepare("select session, max(at) as at from prompts group by session").all() as { session: string; at: number }[]).map((r) => [r.session, r.at]),
  );

  // Sessions at work in the last day, by their own activity (agents count with their session).
  const active = db
    .prepare(
      `select session, max(at) as last_at from (
         select session, started_at as at from runs where started_at > ?
         union all select session, at from usage where at > ?
       ) group by session`,
    )
    .all(now - SESSION_WINDOW, now - SESSION_WINDOW) as { session: string; last_at: number }[];
  const lastAt = new Map<string, number>();
  for (const r of active) lastAt.set(top(r.session), Math.max(lastAt.get(top(r.session)) ?? 0, r.last_at));

  // What each session waits on you for: its newest question, plan or go-ahead with no prompt since.
  const waiting: { session: string; title: string | null; kind: string; text: string | null; blocked: boolean; since: number }[] = [];
  const asks = db
    .prepare("select tool_use_id, session, at, kind, text, blocked, answered_at from asks where at > ? order by at desc")
    .all(now - SESSION_WINDOW) as { session: string; at: number; kind: string; text: string | null; blocked: number; answered_at: number | null }[];
  const asked = new Set<string>();
  for (const a of asks) {
    if (asked.has(a.session)) continue;
    asked.add(a.session);
    const answered = (a.answered_at != null && a.kind !== "ask") || (lastPrompt.get(a.session) ?? 0) > a.at;
    if (!answered) waiting.push({ session: a.session, title: titles.get(a.session) ?? null, kind: a.kind, text: a.text, blocked: !!a.blocked, since: a.at });
  }
  // A session whose API calls are failing (often an expired sign-in) waits on you too.
  for (const [session, at] of lastAt) {
    const err = db.prepare("select max(at) as at from marks where session = ? and type = 'api_error'").get(session) as { at: number | null };
    const reply = db.prepare("select max(at) as at from usage where session = ?").get(session) as { at: number | null };
    if (err.at && err.at >= at - MIN && err.at > (reply.at ?? 0) && !waiting.some((w) => w.session === session))
      waiting.push({ session, title: titles.get(session) ?? null, kind: "api", text: "API calls are failing: the sign-in may have expired", blocked: true, since: err.at });
  }
  waiting.sort((a, b) => Number(b.blocked) - Number(a.blocked) || a.since - b.since);

  // Background work: running, with a finish time from the same kind of work before.
  const done = db
    .prepare("select kind, label, started_at, ended_at from bg where ended_at is not null and status = 'completed'")
    .all() as { kind: string; label: string | null; started_at: number; ended_at: number }[];
  const took = new Map<string, number[]>();
  for (const d of done) {
    const k = `${d.kind}:${family(tidy(d.label))}`;
    (took.get(k) ?? took.set(k, []).get(k)!).push(d.ended_at - d.started_at);
  }
  const inFlight: {
    kind: string; session: string; title: string | null; label: string | null; startedAt: number;
    p50: number | null; p90: number | null; eta: number | null; overdue: boolean; samples: number; detail: string | null;
  }[] = [];
  const running = db
    .prepare("select tool_use_id, session, kind, label, task_id, started_at from bg where ended_at is null and started_at > ?")
    .all(now - SESSION_WINDOW) as { tool_use_id: string; session: string; kind: string; label: string | null; task_id: string | null; started_at: number }[];
  let unreported = 0;
  for (const r of running) {
    const k = `${r.kind}:${family(tidy(r.label))}`;
    const e = eta(r.started_at, took.get(k) ?? [], now);
    // Work whose notice never came (the app was quit, the task was lost): counted, not listed.
    if (now - r.started_at > Math.max(LOST_MS, 3 * (e.p90 ?? 0))) {
      unreported++;
      continue;
    }
    let detail: string | null = null;
    if (r.kind === "monitor") {
      if (now - r.started_at > MONITOR_MS) continue;
      const ev = r.task_id
        ? (db.prepare("select event, at from notices where task_id = ? and event is not null order by at desc limit 1").get(r.task_id) as { event: string; at: number } | undefined)
        : undefined;
      detail = ev ? ev.event : null;
    }
    inFlight.push({ kind: r.kind, session: top(r.session), title: titles.get(top(r.session)) ?? null, label: tidy(r.label), startedAt: r.started_at, ...e, detail });
  }
  // Agents started in the foreground still writing their transcript.
  const agentsTook = new Map<string, number[]>();
  for (const a of db.prepare("select agent_type, first_at, last_at from agents where finished = 1 and first_at is not null").all() as { agent_type: string | null; first_at: number; last_at: number }[])
    (agentsTook.get(a.agent_type ?? "") ?? agentsTook.set(a.agent_type ?? "", []).get(a.agent_type ?? "")!).push(a.last_at - a.first_at);
  const agents = db
    .prepare(
      `select a.agent_id, a.session, a.agent_type, a.description, a.first_at from agents a
        where a.finished = 0 and a.last_at > ? and not exists (select 1 from runs r join bg b on b.tool_use_id = r.tool_use_id where r.agent_id = a.agent_id)`,
    )
    .all(now - AGENT_QUIET_MS) as { session: string | null; agent_type: string | null; description: string | null; first_at: number }[];
  for (const a of agents) {
    const session = top(a.session ?? "");
    inFlight.push({ kind: "agent", session, title: titles.get(session) ?? null, label: a.description ?? a.agent_type, startedAt: a.first_at, ...eta(a.first_at, agentsTook.get(a.agent_type ?? "") ?? [], now), detail: a.agent_type });
  }
  // CI runs still going (GitHub, when it is on).
  const ciTook = new Map<string, number[]>();
  for (const c of db.prepare("select workflow, duration_ms from ci_runs where duration_ms is not null and conclusion is not null").all() as { workflow: string; duration_ms: number }[])
    (ciTook.get(c.workflow) ?? ciTook.set(c.workflow, []).get(c.workflow)!).push(c.duration_ms);
  for (const c of db.prepare("select workflow, at, branch from ci_runs where conclusion is null and at > ?").all(now - SESSION_WINDOW) as { workflow: string; at: number; branch: string | null }[])
    inFlight.push({ kind: "ci", session: "", title: null, label: c.workflow, startedAt: c.at, ...eta(c.at, ciTook.get(c.workflow) ?? [], now), detail: c.branch });
  inFlight.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.eta ?? Infinity) - (b.eta ?? Infinity) || a.startedAt - b.startedAt);

  const sessions = [...lastAt]
    .map(([session, at]) => {
      const where = db
        .prepare("select branch, cwd from runs where session = ? and (branch is not null or cwd is not null) order by started_at desc limit 1")
        .get(session) as { branch: string | null; cwd: string | null } | undefined;
      const prompt = db.prepare("select text, at from prompts where session = ? order by at desc limit 1").get(session) as { text: string; at: number } | undefined;
      const worktree = where?.cwd?.match(/\/\.claude\/worktrees\/([^/]+)/)?.[1] ?? null;
      const state = waiting.some((w) => w.session === session) ? "waiting" : inFlight.some((f) => f.session === session) || now - at < WORKING_MS ? "working" : "idle";
      return { session, title: titles.get(session) ?? null, branch: where?.branch ?? null, worktree, lastAt: at, prompt: prompt?.text ?? null, promptAt: prompt?.at ?? null, state, running: inFlight.filter((f) => f.session === session).length };
    })
    .sort((a, b) => ["waiting", "working", "idle"].indexOf(a.state) - ["waiting", "working", "idle"].indexOf(b.state) || b.lastAt - a.lastAt);

  // Finished lately: background work and deploys.
  const recent = [
    ...(db
      .prepare("select kind, label, session, started_at, ended_at, status, summary from bg where ended_at > ? and kind <> 'monitor' order by ended_at desc limit 20")
      .all(now - RECENT_WINDOW) as { kind: string; label: string | null; session: string; started_at: number; ended_at: number; status: string; summary: string | null }[]).map((r) => ({
      kind: r.kind, label: tidy(r.label) ?? r.summary, session: top(r.session), title: titles.get(top(r.session)) ?? null, at: r.ended_at, durationMs: r.ended_at - r.started_at, status: r.status,
    })),
    ...(db.prepare("select id, at, status from deploys where at > ? order by at desc limit 5").all(now - RECENT_WINDOW) as { id: string; at: number; status: string }[]).map((d) => ({
      kind: "deploy", label: d.id.replace(/^(git|tag|gh):/, ""), session: "", title: null, at: d.at, durationMs: null, status: d.status,
    })),
  ].sort((a, b) => b.at - a.at);

  // The newest updates from monitors (a step finishing, a failure line).
  const updates = (db.prepare("select n.session, n.at, n.event, b.label from notices n left join bg b on b.task_id = n.task_id where n.event is not null and n.at > ? order by n.at desc limit 10").all(now - RECENT_WINDOW) as {
    session: string; at: number; event: string; label: string | null;
  }[]).map((u) => ({ ...u, session: top(u.session) }));

  return { now, waiting, inFlight, unreported, sessions, recent, updates };
}
