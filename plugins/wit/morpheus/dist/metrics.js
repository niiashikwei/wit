/**
 * What the dashboard shows, read from the store: what is running now, the headline numbers, each
 * hook, rule, skill and agent's runs and times, one item in detail, a session's timeline,
 * coverage of what's defined, and where the tokens went.
 */
                                                
                                              

                        

                                                          
                        
               
                          
                         
 
                               

const DAY = 86_400_000;

/** The start of a range, in ms. "today" is local midnight. */
export function since(range       , now        )         {
  if (range === "1h") return now - 3_600_000;
  if (range === "7d") return now - 7 * DAY;
  if (range === "30d") return now - 30 * DAY;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return 0;
}

/** The p-th percentile (0–100) of a list, nearest-rank. */
export function percentile(values          , p        )                {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ;
}

/** Runs, durations and outcomes for one list of runs. */
export function summarise(
  rows                                                                       ,
) {
  const times = rows.map((r) => r.duration_ms).filter((d)              => typeof d === "number");
  const outcomes                         = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return {
    runs: rows.length,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    // reduce, not Math.max(...list): a busy hook has more runs than the call stack has room for.
    max: times.length ? times.reduce((m, t) => Math.max(m, t), -Infinity) : null,
    totalMs: times.reduce((s, t) => s + t, 0),
    outcomes,
    lastAt: rows.length ? rows.reduce((m, r) => Math.max(m, r.started_at), -Infinity) : null,
  };
}

/** A day key in local time ("2026-11-03"), so a day starts at your midnight, not UTC's. */
export function dayKey(t        )         {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Every day key from `from` to `to`, so a chart shows the quiet days too. */
export function dayKeys(from        , to        )           {
  const out           = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= to; d.setDate(d.getDate() + 1)) out.push(dayKey(d.getTime()));
  return out;
}

const escapeRe = (s        ) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The skills a prompt hook's text names: each known skill that appears as a whole word ("load ship
 * then tdd" → ship, tdd). Without a list of skills, the names before each ";" (an older format).
 */
export function hintedSkills(text               , skills           )           {
  const t = text ?? "";
  if (skills?.length)
    return skills.filter((s) => new RegExp(`(^|[^\\w:-])${escapeRe(s)}($|[^\\w:-])`).test(t));
  return t
    .split(";")
    .map((p) => p.trim().match(/^([\w:-]+)/)?.[1])
    .filter((s)              => !!s);
}

/** What an override overrode: "SKIP_CHECKS: npm run deploy" → "SKIP_CHECKS". */
export function overrideName(detail               , fallback        )         {
  return detail?.match(/^([A-Z][A-Z0-9_]+)\b/)?.[1] ?? fallback;
}

/** SQL for the scope, on the runs table (alias r). Agent sessions count under their parent. */
function where(scope       , now        , extra = "")                                             {
  const parts = ["r.started_at >= ?"];
  const args                      = [since(scope.range, now)];
  if (scope.session) {
    parts.push("(r.session = ? or r.session like ?)");
    args.push(scope.session, `${scope.session}/agent-%`);
  }
  if (scope.branch) {
    parts.push("r.branch = ?");
    args.push(scope.branch);
  }
  if (extra) parts.push(extra);
  return { sql: parts.join(" and "), args };
}

/**
 * Hook runs: each hook's own timing once it has one (hooks/morpheus-time.sh), the transcript's
 * records before it and for hooks without it (those only keep the runs that printed something).
 * Per hook, so timing one hook doesn't hide another's transcript records.
 */
const HOOKS = `r.kind = 'hook' and (r.source = 'timing' or r.started_at < coalesce((select min(t.started_at) from runs t where t.kind = 'hook' and t.name = r.name and t.source = 'timing'), 9e15))`;

/** Agent runs with their times and tokens, from their own transcripts. */
function agentRows(db              , scope       , now        , name         )        {
  const w = where(scope, now, name ? "r.kind = 'agent' and r.name = ?" : "r.kind = 'agent'");
  return db
    .prepare(
      `select r.*, a.first_at, a.last_at, a.tokens_in, a.tokens_out, a.tokens_cached, a.model as agent_model,
              a.verdict, a.finished, case when a.first_at is null then r.duration_ms else a.active_ms end as span
         from runs r left join agents a on a.agent_id = r.agent_id
        where ${w.sql} order by r.started_at desc`,
    )
    .all(...w.args, ...(name ? [name] : []))         ;
}

const agentRun = (r     , now        )      => ({
  ...r,
  duration_ms: r.span ?? (r.first_at && !r.finished ? now - r.first_at : null),
  outcome:
    r.finished === 0 && r.last_at && now - r.last_at < 600_000
      ? "running"
      : r.outcome === "running"
        ? "ok"
        : r.outcome,
  verdict: r.verdict ?? null,
});

/**
 * Hint → load: a prompt hook's text that names a skill counts as a hint, and it was followed when
 * one of the skills it names loads in that session before the next prompt (or already had).
 */
function hintConversion(db              , scope       , now        , skills           ) {
  const w = where(scope, now, "r.kind = 'hint'");
  const hints = (db.prepare(`select * from runs r where ${w.sql}`).all(...w.args)         ).filter(
    (h) => hintedSkills(h.trigger, skills).length > 0,
  );
  let converted = 0;
  const missed                         = {};
  for (const h of hints) {
    const next = db
      .prepare("select min(at) as at from prompts where session = ? and at > ?")
      .get(h.session, h.started_at + 1000)       ;
    const until = next?.at ?? h.started_at + 30 * 60_000;
    const loaded = new Set(
      (
        db
          // Loaded before the next prompt, or earlier in the session (still in its context).
          .prepare("select name from runs where kind = 'skill' and session = ? and started_at <= ?")
          .all(h.session, until)         
      ).map((s) => s.name),
    );
    const wanted = hintedSkills(h.trigger, skills);
    if (wanted.some((s) => loaded.has(s))) converted++;
    else for (const s of wanted) missed[s] = (missed[s] ?? 0) + 1;
  }
  return { hints: hints.length, converted, missed };
}

/** Blocks followed within 3 minutes by a passing command in the same session: likely worked around. */
function workedAround(db              , scope       , now        ) {
  const w = where(scope, now, `${HOOKS} and r.outcome = 'block' and r.detail like 'PreToolUse%'`);
  const blocks = db
    .prepare(`select r.*, coalesce(r.rule, r.name) as by from runs r where ${w.sql}`)
    .all(...w.args)         ;
  const byRule                                                     = {};
  for (const b of blocks) {
    const after = db
      .prepare(
        "select count(*) as n from runs where kind = 'tool' and session = ? and started_at between ? and ? and outcome = 'ok' and tool_use_id != ?",
      )
      .get(b.session, b.started_at, b.started_at + 180_000, b.tool_use_id ?? "")       ;
    const k = String(b.by);
    byRule[k] ??= { blocks: 0, around: 0 };
    byRule[k].blocks++;
    if (after.n > 0) byRule[k].around++;
  }
  return byRule;
}

/** What's running now: sessions active in the last 10 minutes, and the newest runs. */
export function live(db              , now        , scope                 = {}) {
  const active = db
    .prepare(
      `select session, max(started_at) as last_at, max(branch) as branch, max(cwd) as cwd from runs
        where started_at > ? and session not like '%/agent-%' group by session order by last_at desc`,
    )
    .all(now - 600_000)         ;
  const sessions = active.map((s)      => {
    const current = db
      .prepare(
        `select kind, name, trigger, started_at from runs where session = ? and outcome = 'running' and kind in ('tool','agent')
          order by started_at desc limit 1`,
      )
      .get(s.session)                   ;
    const prompt = db
      .prepare("select text, at from prompts where session = ? order by at desc limit 1")
      .get(s.session)                   ;
    const agents = db
      .prepare(
        `select r.name, r.detail, a.first_at, a.last_at, a.active_ms from runs r join agents a on a.agent_id = r.agent_id
          where r.session = ? and a.finished = 0 and a.last_at > ?`,
      )
      .all(s.session, now - 600_000)         ;
    return {
      ...s,
      prompt: prompt?.text ?? null,
      current: current ?? null,
      agents,
    };
  });
  const w = where(
    { range: "all", ...scope },
    now,
    `(${HOOKS} or r.kind in ('skill','agent','hint'))`,
  );
  const feed = db
    .prepare(
      `select r.id, r.kind, r.name, r.detail, r.rule, r.session, r.branch, r.started_at, r.duration_ms, r.outcome,
              coalesce(r.trigger, t.trigger) as trigger, r.output
         from runs r left join runs t on t.tool_use_id = r.tool_use_id and t.kind = 'tool' and r.kind = 'hook'
        where ${w.sql} order by r.started_at desc limit 50`,
    )
    .all(...w.args)         ;
  return { now, sessions, feed };
}

/** Whether any hook writes the events log: without it, blocks come from the transcripts alone. */
const hasEvents = (db              ) => !!db.prepare("select 1 from events limit 1").get();

/** The headline numbers and the time spent per day. */
export function overview(db              , scope       , now        , skills           ) {
  const hw = where(scope, now, HOOKS);
  const hooks = summarise(
    db
      .prepare(`select duration_ms, outcome, started_at from runs r where ${hw.sql}`)
      .all(...hw.args)         ,
  );
  const agents = agentRows(db, scope, now).map((r) => agentRun(r, now));
  const sw = where(scope, now, "r.kind = 'skill'");
  const loads = db
    .prepare(`select count(*) as n from runs r where ${sw.sql}`)
    .get(...sw.args)       ;
  const ew = since(scope.range, now);
  const overrides = db
    .prepare("select count(*) as n from events where type = 'override' and ts >= ?")
    .get(ew)       ;
  const around = workedAround(db, scope, now);
  const hint = hintConversion(db, scope, now, skills);
  const days        = [];
  const first = Math.max(since(scope.range, now), now - 14 * DAY);
  for (let d = new Date(first); d.getTime() <= now; d.setDate(d.getDate() + 1)) {
    const start = new Date(d).setHours(0, 0, 0, 0);
    const end = start + DAY;
    const dw = where({ ...scope, range: "all" }, now, "r.started_at >= ? and r.started_at < ?");
    dw.args.push(start, end);
    const hookMs = (
      db
        .prepare(
          `select coalesce(sum(duration_ms),0) as ms from runs r where ${dw.sql} and ${HOOKS}`,
        )
        .get(...dw.args)       
    ).ms;
    const agentMs = agents
      .filter((a) => a.started_at >= start && a.started_at < end)
      .reduce((s, a) => s + (a.duration_ms ?? 0), 0);
    const skillLoads = (
      db
        .prepare(`select count(*) as n from runs r where ${dw.sql} and r.kind = 'skill'`)
        .get(...dw.args)       
    ).n;
    days.push({
      day: dayKey(start),
      hookMs,
      agentMs,
      skillLoads,
    });
  }
  // With an events log, every refusal is in it (by branch, not session); a session scope, or a
  // project without the log, counts the blocks its transcripts and timing recorded.
  const blocks =
    scope.session || !hasEvents(db)
    ? Object.values(around).reduce((s, v) => s + v.blocks, 0)
    : (
        db
          .prepare(
            `select count(*) as n from events where type = 'block' and ts >= ?${scope.branch ? " and branch = ?" : ""}`,
          )
          .get(since(scope.range, now), ...(scope.branch ? [scope.branch] : []))       
      ).n;
  return {
    kpis: {
      processMs: hooks.totalMs + agents.reduce((s, a) => s + (a.duration_ms ?? 0), 0),
      hookRuns: hooks.runs,
      hookP95: hooks.p95,
      blocks,
      workedAround: Object.values(around).reduce((s, v) => s + v.around, 0),
      hints: hint.hints,
      hintsConverted: hint.converted,
      skillLoads: loads.n,
      agentRuns: agents.length,
      agentTokens: agents.reduce((s, a) => s + (a.tokens_in ?? 0) + (a.tokens_out ?? 0), 0),
      agentTokensCached: agents.reduce((s, a) => s + (a.tokens_cached ?? 0), 0),
      // Before the hooks timed every run (runs.jsonl), the transcripts only kept the runs that printed.
      timingSince:
        (db.prepare("select min(started_at) as t from runs where source = 'timing'").get()       )
          .t ?? null,
      overrides: overrides.n,
      sessions: (
        db
          .prepare(
            `select count(distinct substr(r.session, 1, instr(r.session || '/', '/') - 1)) as n from runs r where ${where(scope, now).sql}`,
          )
          .get(...where(scope, now).args)       
      ).n,
    },
    days,
    detail: { around, missedHints: hint.missed },
  };
}

                                                           

/** One table: every hook script, hook rule, skill or agent type with its numbers. */
export function items(
  db              ,
  kind          ,
  scope       ,
  now        ,
  skills           ,
) {
  if (kind === "agent") {
    const by                        = {};
    for (const r of agentRows(db, scope, now)) (by[r.name] ??= []).push(agentRun(r, now));
    return Object.entries(by)
      .map(([name, rows]) => ({
        name,
        ...summarise(rows         ),
        tokens: rows.reduce((s, a) => s + (a.tokens_in ?? 0) + (a.tokens_out ?? 0), 0),
        tokensCached: rows.reduce((s, a) => s + (a.tokens_cached ?? 0), 0),
        verdicts: rows.reduce(
          (v                        , a) =>
            a.verdict ? { ...v, [a.verdict]: (v[a.verdict] ?? 0) + 1 } : v,
          {},
        ),
      }))
      .sort((a, b) => b.runs - a.runs);
  }
  if (kind === "skill") {
    const w = where(scope, now, "r.kind = 'skill'");
    const rows = db
      .prepare(`select name, duration_ms, outcome, started_at from runs r where ${w.sql}`)
      .all(...w.args)         ;
    const by                        = {};
    for (const r of rows) (by[r.name] ??= []).push(r);
    const missed = hintConversion(db, scope, now, skills).missed;
    const names = new Set([...Object.keys(by), ...Object.keys(missed)]);
    return [...names]
      .map((name) => ({
        name,
        ...summarise((by[name] ?? [])         ),
        hintedNotLoaded: missed[name] ?? 0,
      }))
      .sort((a, b) => b.runs - a.runs);
  }
  const col = kind === "rule" ? "coalesce(r.rule, r.name)" : "r.name";
  const fromLog = kind === "rule" && !scope.session && hasEvents(db);
  const w = where(
    scope,
    now,
    // With an events log, blocks and warnings come from it below, which has every one; here only
    // what the log doesn't record (a hook that failed or timed out).
    HOOKS +
      (kind !== "rule"
        ? ""
        : fromLog
          ? " and r.outcome in ('error','cancelled')"
          : " and r.outcome in ('block','warn','error','cancelled')"),
  );
  const rows = db
    .prepare(
      `select ${col} as k, duration_ms, outcome, started_at, detail from runs r where ${w.sql}`,
    )
    .all(...w.args)         ;
  const by                        = {};
  for (const r of rows) (by[r.k] ??= []).push(r);
  if (fromLog) {
    // Every block, warning and override is in the hooks' own log. An override is named by what it
    // overrode (its detail starts with the variable, e.g. "STACK_RESET_OK: …").
    const ev = db
      .prepare(
        `select hook, type, ts, detail from events where ts >= ? and type in ('block','warn','override','timeout','red')${scope.branch ? " and branch = ?" : ""}`,
      )
      .all(since(scope.range, now), ...(scope.branch ? [scope.branch] : []))         ;
    for (const e of ev)
      (by[e.type === "override" ? overrideName(e.detail, e.hook) : e.hook] ??= []).push({
        duration_ms: null,
        outcome: e.type,
        started_at: e.ts,
      });
  }
  const around = kind === "rule" ? workedAround(db, scope, now) : {};
  return Object.entries(by)
    .map(([name, list]) => {
      // The event a hook runs on most (PreToolUse, Stop…), for its time budget.
      const events                         = {};
      for (const r of list) {
        const e = String(r.detail ?? "").split(":")[0];
        if (e) events[e] = (events[e] ?? 0) + 1;
      }
      return {
        name,
        ...summarise(list         ),
        workedAround: around[name]?.around ?? 0,
        event: Object.entries(events).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      };
    })
    .sort((a, b) => b.runs - a.runs);
}

/** One item in detail: time histogram, runs per day, recent runs and what each was doing, by session. */
export function item(db              , kind          , name        , scope       , now        ) {
  let rows       ;
  if (kind === "agent") rows = agentRows(db, scope, now, name).map((r) => agentRun(r, now));
  else {
    const filter =
      kind === "skill"
        ? "r.kind = 'skill' and r.name = ?"
        : kind === "rule"
          ? `${HOOKS} and coalesce(r.rule, r.name) = ?`
          : `${HOOKS} and r.name = ?`;
    const w = where(scope, now, filter);
    rows = db
      .prepare(
        `select r.*, coalesce(r.trigger, t.trigger) as trigger from runs r
           left join runs t on t.tool_use_id = r.tool_use_id and t.kind = 'tool' and r.kind = 'hook'
          where ${w.sql} order by r.started_at desc`,
      )
      .all(...w.args, name)         ;
    if (kind === "rule" && !scope.session && hasEvents(db)) {
      // Blocks, warnings and overrides from the hooks' log (a timed block is there too).
      rows = rows.filter((r) => r.outcome !== "block");
      const ev = db
        .prepare(
          `select ts, hook, type, branch, detail from events where ts >= ? and type in ('block','warn','override','timeout','red')${scope.branch ? " and branch = ?" : ""}`,
        )
        .all(since(scope.range, now), ...(scope.branch ? [scope.branch] : []))         ;
      for (const e of ev)
        if ((e.type === "override" ? overrideName(e.detail, e.hook) : e.hook) === name)
          rows.push({
            started_at: e.ts,
            duration_ms: null,
            outcome: e.type,
            detail: null,
            trigger: null,
            output: e.detail,
            session: "",
            branch: e.branch,
          });
      rows.sort((a, b) => b.started_at - a.started_at);
    }
  }
  const times = rows.map((r) => r.duration_ms).filter((d)              => typeof d === "number");
  const edges = [100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000, Infinity];
  const histogram = edges.map((edge, i) => ({
    upTo: edge === Infinity ? null : edge,
    runs: times.filter((t) => t <= edge && (i === 0 || t > edges[i - 1] )).length,
  }));
  const perDay                                                 = {};
  for (const r of rows) {
    const d = dayKey(r.started_at);
    perDay[d] ??= { runs: 0, ms: [] };
    perDay[d].runs++;
    if (typeof r.duration_ms === "number") perDay[d].ms.push(r.duration_ms);
  }
  const bySession                      = {};
  for (const r of rows) {
    const k = String(r.session).split("/agent-")[0] ;
    bySession[k] ??= { session: k, branch: r.branch, runs: 0, ms: 0 };
    bySession[k].runs++;
    bySession[k].ms += r.duration_ms ?? 0;
  }
  return {
    name,
    kind,
    summary: summarise(rows         ),
    histogram,
    perDay: Object.entries(perDay)
      .sort()
      .map(([day, v]) => ({ day, runs: v.runs, p95: percentile(v.ms, 95) })),
    recent: rows.slice(0, 40).map((r) => ({
      at: r.started_at,
      ms: r.duration_ms,
      outcome: r.outcome,
      rule: r.rule ?? null,
      event: r.detail,
      trigger: r.trigger,
      output: r.output ?? (r.verdict ? `VERDICT: ${r.verdict}` : null),
      session: r.session,
      branch: r.branch,
      tokens: (r.tokens_in ?? 0) + (r.tokens_out ?? 0) || null,
      verdict: r.verdict ?? null,
    })),
    bySession: Object.values(bySession).sort((a, b) => b.runs - a.runs),
  };
}

/**
 * Every tool Claude called (Bash, Edit, an MCP tool…): how often, how long until its result, and
 * how often it failed or was refused. MCP tools are grouped by server.
 */
export function toolsTable(db              , scope       , now        ) {
  const w = where(scope, now, "r.kind = 'tool'");
  const rows = db
    .prepare(`select r.name, r.duration_ms, r.outcome, r.started_at from runs r where ${w.sql}`)
    .all(...w.args)         ;
  const by                        = {};
  for (const r of rows) {
    const k = String(r.name).startsWith("mcp__")
      ? `${String(r.name).split("__").slice(0, 2).join("__")}__*`
      : String(r.name);
    (by[k] ??= []).push(r);
  }
  return Object.entries(by)
    .map(([name, list]) => ({ name, ...summarise(list         ) }))
    .sort((a, b) => b.runs - a.runs);
}

/**
 * One session's hooks, hints, skills and agents in the order they fired, for the timeline: each
 * with its start and end, and the agent it ran inside (none for the session itself). With no
 * session, the one most recently active.
 */
export function timeline(
  db              ,
  now        ,
  opts                                             = {},
) {
  const from = since(opts.range ?? "1h", now);
  const sessions = db
    .prepare(
      `select session, min(started_at) as first_at, max(started_at) as last_at, max(branch) as branch, count(*) as runs
         from runs where started_at >= ? and session not like '%/agent-%' and kind in ('hook','skill','agent','hint')
        group by session order by last_at desc limit 20`,
    )
    .all(from)         ;
  const session = opts.session ?? sessions[0]?.session ?? null;
  if (!session) return { now, from, session: null, sessions, events: [] };
  const rows = db
    .prepare(
      `select r.id, r.kind, r.name, coalesce(r.rule, '') as rule, r.detail, r.session, r.started_at, r.duration_ms,
              r.outcome, r.agent_id, coalesce(r.trigger, t.trigger) as trigger, r.output,
              a.last_at as agent_last, a.verdict, a.finished
         from runs r
         left join runs t on t.tool_use_id = r.tool_use_id and t.kind = 'tool' and r.kind = 'hook'
         left join agents a on a.agent_id = r.agent_id and r.kind = 'agent'
        where r.started_at >= ? and (r.session = ? or r.session like ?)
          and r.kind in ('hook','skill','agent','hint')
          and (r.kind <> 'hook' or (${HOOKS}))
        order by r.started_at desc limit 600`,
    )
    .all(from, session, `${session}/agent-%`)
    // The newest 600, oldest first.
    .reverse()         ;
  // Which agent each run sits inside, and how deep that agent is (1 = started by the session): the
  // meta's spawnDepth, else a walk up the parents it names (an unknown parent ends the walk).
  const known = new Map             (
    (
      db
        .prepare(
          "select agent_id, parent_id, spawn_depth from agents where session = ? or agent_id in (select agent_id from runs where session = ? and kind = 'agent')",
        )
        .all(session, session)         
    ).map((a) => [a.agent_id, a]),
  );
  const depth = (id               )         => {
    if (!id) return 0;
    const own = known.get(id)?.spawn_depth;
    if (typeof own === "number" && own > 0) return own;
    let d = 0;
    for (let a                = id; a && d < 5; a = known.get(a)?.parent_id ?? null) d++;
    return d;
  };
  const events = rows.map((r) => {
    const inside = String(r.session).match(/\/agent-([\w-]+)$/)?.[1] ?? null;
    const end =
      r.kind === "agent"
        ? (r.agent_last ?? (r.duration_ms != null ? r.started_at + r.duration_ms : null))
        : r.duration_ms != null
          ? r.started_at + r.duration_ms
          : null;
    return {
      id: r.id,
      kind: r.kind,
      name: r.kind === "hook" && r.rule ? `${r.name} · ${r.rule}` : r.name,
      start: r.started_at,
      end: end ?? (r.kind === "agent" && r.outcome === "running" ? now : r.started_at),
      outcome: r.kind === "agent" && r.verdict ? r.verdict : r.outcome,
      inside,
      agentId: r.kind === "agent" ? r.agent_id : null,
      depth: depth(inside),
      what: r.detail ?? r.trigger ?? null,
      said: r.output ?? null,
    };
  });
  return { now, from, session, sessions, events };
}

/** "skill ship: …" / "agent test-writer: …": what a gate in a hook asked for (events log). */
export function gateTarget(
  detail               ,
)                                                   {
  const m = detail?.match(/^(skill|agent) ([\w:.-]+):/);
  return m ? { kind: m[1]                     , name: m[2]  } : null;
}

/**
 * Whether every hook, rule, skill and agent fires when it should: how often it ran, when it last
 * did, how often its work happened without it (a skill gate's warning or block), and a status:
 * active, missed (needed and not used), idle (nothing called for it) or off.
 */
export function coverage(db              , now        , def         , range        = "7d") {
  const from = since(range, now);
  const all = (sql        ) => db.prepare(sql).all(from)         ;
  const byName = (rows       ) =>
    new Map(rows.map((r) => [String(r.name), { n: Number(r.n), last: r.last                  }]));
  const hookRuns = byName(
    all(
      `select r.name, count(*) as n, max(r.started_at) as last from runs r where r.started_at >= ? and ${HOOKS} group by r.name`,
    ),
  );
  const ruleEvents = byName(
    all(
      "select hook as name, count(*) as n, max(ts) as last from events where ts >= ? and hook <> '' group by hook",
    ),
  );
  const loads = byName(
    all(
      "select name, count(*) as n, max(started_at) as last from runs where kind = 'skill' and started_at >= ? group by name",
    ),
  );
  const agentRuns = byName(
    all(
      "select name, count(*) as n, max(started_at) as last from runs where kind = 'agent' and started_at >= ? group by name",
    ),
  );
  // A warning is logged once per session, a block once per refused call: counted apart.
  const missed = new Map                                                       ();
  for (const e of all(
    "select detail, ts, type from events where ts >= ? and type in ('warn','block') and (detail like 'skill %' or detail like 'agent %')",
  )) {
    const t = gateTarget(e.detail);
    if (!t) continue;
    const k = `${t.kind}:${t.name}`;
    const m = missed.get(k) ?? { warn: 0, block: 0, last: 0 };
    m[e.type                    ]++;
    m.last = Math.max(m.last, e.ts);
    missed.set(k, m);
  }
  const hinted = new Map                ();
  for (const h of all("select trigger from runs where kind = 'hint' and started_at >= ?"))
    for (const s of hintedSkills(h.trigger, def.skills)) hinted.set(s, (hinted.get(s) ?? 0) + 1);

  // Missed while its last gate came after its last use; once it's loaded or run again, active.
  const status = (used        , lastUsed               , lastMissed               , off = false) =>
    off
      ? "off"
      : lastMissed && lastMissed > (lastUsed ?? 0)
        ? "missed"
        : used > 0
          ? "active"
          : "idle";
  const where = (kind        , name        ) => def.where?.[`${kind}:${name}`] ?? "other";
  const used = (kind                   , name        , runs              ) => {
    const n = runs.get(name)?.n ?? 0;
    const last = runs.get(name)?.last ?? null;
    const miss = missed.get(`${kind}:${name}`);
    const count = (miss?.warn ?? 0) + (miss?.block ?? 0);
    const hints = kind === "skill" ? (hinted.get(name) ?? 0) : 0;
    return {
      kind,
      name,
      scope: where(kind, name),
      mode: null,
      used: n,
      lastAt: last,
      // How often its work came up: it ran, a gate asked for it, or a prompt was hinted to it.
      needed: n + count + hints,
      missed: count,
      warned: miss?.warn ?? 0,
      blocked: miss?.block ?? 0,
      lastMissedAt: miss?.last ?? null,
      hinted: hints,
      status: status(n, last, miss?.last ?? null),
    };
  };
  const rows = [
    ...def.hooks.map((name) => {
      const n = hookRuns.get(name)?.n ?? 0;
      return {
        kind: "hook",
        name,
        scope: where("hook", name),
        mode: null,
        used: n,
        lastAt: hookRuns.get(name)?.last ?? null,
        needed: null,
        missed: 0,
        lastMissedAt: null,
        hinted: 0,
        warned: 0,
        blocked: 0,
        status: status(n, null, null),
      };
    }),
    // Rules the project names, and any other rule its hooks logged.
    ...Object.entries({
      ...Object.fromEntries([...ruleEvents.keys()].map((k) => [k, "logged"])),
      ...def.rules,
    }).map(([name, mode]) => {
      const n = ruleEvents.get(name)?.n ?? 0;
      return {
        kind: "rule",
        name,
        scope: "project",
        mode,
        used: n,
        lastAt: ruleEvents.get(name)?.last ?? null,
        needed: null,
        missed: 0,
        lastMissedAt: null,
        hinted: 0,
        warned: 0,
        blocked: 0,
        status: status(n, null, null, mode === "off"),
      };
    }),
    ...def.skills.map((name) => used("skill", name, loads)),
    ...def.agents.map((name) => used("agent", name, agentRuns)),
  ];
  // What ran without being defined where Morpheus looks: built-in agents, other plugins' skills.
  const defSkills = new Set(def.skills);
  const defAgents = new Set(def.agents);
  for (const name of loads.keys()) if (!defSkills.has(name)) rows.push(used("skill", name, loads));
  for (const name of agentRuns.keys())
    if (!defAgents.has(name)) rows.push(used("agent", name, agentRuns));
  const totals                         = { active: 0, missed: 0, idle: 0, off: 0 };
  for (const r of rows) totals[r.status] = (totals[r.status] ?? 0) + 1;
  return { now, from, range, totals, rows };
}

/** New tokens (and cached reads) for work, orchestration and replies. */
                                                                                      
const split = ()        => ({ work: 0, orchestration: 0, replies: 0, cached: 0 });

/**
 * Where the tokens went: each reply's new tokens (input, cache writes, output) split between
 * work and orchestration in proportion to its tool calls; a reply with no tool calls is a reply to
 * the owner or the parent. Cached reads are kept apart: the same context read again each turn. By
 * top-level session (its own tokens apart from its agents'), by agent type (its own apart from the
 * agents it started), per day, and what hooks and skill loads add to the context (estimates,
 * characters / 4).
 */
export function tokens(db              , scope       , now        , def         ) {
  const parts = ["u.at >= ?"];
  const args                      = [since(scope.range, now)];
  if (scope.session) {
    parts.push("(u.session = ? or u.session like ?)");
    args.push(scope.session, `${scope.session}/agent-%`);
  }
  if (scope.branch) {
    parts.push("u.branch = ?");
    args.push(scope.branch);
  }
  const rows = db
    .prepare(
      `select u.*, a.agent_type, a.parent_id from usage u left join agents a on a.agent_id = u.agent_id
        where ${parts.join(" and ")}`,
    )
    .all(...args)         ;
  const types = new Map(
    (db.prepare("select agent_id, agent_type from agents").all()         ).map((a) => [
      a.agent_id,
      a.agent_type ?? "unknown",
    ]),
  );
  // Whole tokens: shares are rounded once per reply, so the parts always add up to the reply.
  const shareOf = (r     ) => {
    const fresh = Number(r.tokens_in) + Number(r.tokens_out);
    const calls = Number(r.work) + Number(r.orchestration);
    const work = calls ? Math.round((fresh * Number(r.work)) / calls) : 0;
    const cachedWork = calls ? Math.round((Number(r.tokens_cached) * Number(r.work)) / calls) : 0;
    return {
      work,
      orchestration: calls ? fresh - work : 0,
      replies: calls ? 0 : fresh,
      cached: Number(r.tokens_cached),
      cachedWork,
      cachedOrchestration: calls ? Number(r.tokens_cached) - cachedWork : 0,
      cachedReplies: calls ? 0 : Number(r.tokens_cached),
    };
  };
  const add = (to       , s                            ) => {
    to.work += s.work;
    to.orchestration += s.orchestration;
    to.replies += s.replies;
    to.cached += s.cached;
  };
  const totals = {
    work: { new: 0, cached: 0 },
    orchestration: { new: 0, cached: 0 },
    replies: { new: 0, cached: 0 },
  };
  const sessions = new Map 
           
                                                                                           
   ();
  const agentTypes = new Map 
           
                                                                 
   ();
  const days = new Map               ();
  for (const r of rows) {
    const s = shareOf(r);
    totals.work.new += s.work;
    totals.work.cached += s.cachedWork;
    totals.orchestration.new += s.orchestration;
    totals.orchestration.cached += s.cachedOrchestration;
    totals.replies.new += s.replies;
    totals.replies.cached += s.cachedReplies;
    const top = String(r.session).split("/agent-")[0] ;
    const sess = sessions.get(top) ?? {
      session: top,
      branch: null,
      own: split(),
      agents: split(),
      messages: 0,
    };
    sess.branch ??= r.branch ?? null;
    sess.messages++;
    add(r.agent_id ? sess.agents : sess.own, s);
    sessions.set(top, sess);
    if (r.agent_id) {
      const type = r.agent_type ?? "unknown";
      const t = agentTypes.get(type) ?? { type, ids: new Set(), own: split(), agents: split() };
      t.ids.add(r.agent_id);
      add(t.own, s);
      agentTypes.set(type, t);
      // An agent started by another agent also counts under its parent's type.
      const parent = r.parent_id ? types.get(r.parent_id) : null;
      if (parent) {
        const p = agentTypes.get(parent) ?? {
          type: parent,
          ids: new Set(),
          own: split(),
          agents: split(),
        };
        add(p.agents, s);
        agentTypes.set(parent, p);
      }
    }
    const day = dayKey(r.at);
    const d = days.get(day) ?? split();
    add(d, s);
    days.set(day, d);
  }
  const fresh = (x       ) => x.work + x.orchestration + x.replies;
  const all = totals.work.new + totals.orchestration.new + totals.replies.new;
  const share = (n        ) => (all ? n / all : 0);

  const hw = where(scope, now, HOOKS);
  const hooks = (
    db
      .prepare(
        `select r.name, count(*) as runs, coalesce(sum(r.chars), 0) as chars from runs r where ${hw.sql} group by r.name`,
      )
      .all(...hw.args)         
  )
    .map((h) => ({
      name: String(h.name),
      runs: Number(h.runs),
      chars: Number(h.chars),
      tokens: Math.round(Number(h.chars) / 4),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const sw = where(scope, now, "r.kind = 'skill'");
  const skills = (
    db
      .prepare(`select r.name, count(*) as loads from runs r where ${sw.sql} group by r.name`)
      .all(...sw.args)         
  )
    .map((k) => {
      const chars = def.skillChars?.[k.name] ?? 0;
      return {
        name: String(k.name),
        loads: Number(k.loads),
        chars,
        tokens: Math.round((Number(k.loads) * chars) / 4),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
  return {
    now,
    range: scope.range,
    totals,
    shares: {
      work: share(totals.work.new),
      orchestration: share(totals.orchestration.new),
      replies: share(totals.replies.new),
    },
    sessions: [...sessions.values()]
      .sort((a, b) => fresh(b.own) + fresh(b.agents) - fresh(a.own) - fresh(a.agents))
      .slice(0, 20),
    agents: [...agentTypes.values()]
      .map((t) => ({ type: t.type, runs: t.ids.size, own: t.own, agents: t.agents }))
      .sort((a, b) => fresh(b.own) + fresh(b.agents) - fresh(a.own) - fresh(a.agents)),
    hooks,
    skills,
    // Characters / 4: what hook output and skill text add to the context, not a measured count.
    estimated: {
      hooks: hooks.reduce((s, h) => s + h.tokens, 0),
      skills: skills.reduce((s, k) => s + k.tokens, 0),
    },
    // Every day from the first reply (at most 60 days back), quiet days included.
    days: rows.length
      ? dayKeys(
          Math.max(
            rows.reduce((m, r) => Math.min(m, Number(r.at)), Infinity),
            now - 59 * DAY,
          ),
          now,
        ).map((day) => ({ day, ...(days.get(day) ?? split()) }))
      : [],
  };
}
