/**
 * Reads what changed since last time into the store: the project's Claude Code transcripts (its
 * worktrees' too), their subagents' transcripts and metadata, and the optional hook logs. Each
 * file's read position is kept, so a refresh reads only new lines.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
                                                               
import {
              
  redact,
  verdictOf,
  parseEventLine,
  parseHookRunLine,
  parseTranscriptLine,
} from "./parse.js";
import { logDirs, projectDirs } from "./paths.js";

const prepared = new WeakMap                                          ();
/** A prepared statement, made once per database: a backfill runs them hundreds of thousands of times. */
export function stmt(db              , sql        )                {
  let m = prepared.get(db);
  if (!m) prepared.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

const CHUNK = 8 * 1024 * 1024;
/** A gap longer than this between an agent's lines is idle, not work. */
const IDLE_MS = 15 * 60_000;
// Only lines that can hold a record are parsed: a transcript is mostly model text.
const WORTH = /"hook_|"tool_use"|"tool_result"|"type":"user"|"usage"|"compact_boundary"/;

/**
 * Calls `onLine` for each complete line after the stored position, then stores the new one. Reads
 * bytes and splits on the newline byte, so a character split between two reads stays whole. A file
 * that got shorter or was replaced starts over from the top, after `onReset`.
 */
export function readNew(
  db              ,
  path        ,
  onLine                        ,
  chunk = CHUNK,
  onReset             ,
)         {
  const st = statSync(path);
  const row = stmt(db, "select offset, ino from files where path = ?").get(path)   
                                                      ;
  let offset = row?.offset ?? 0;
  if (row && (row.offset > st.size || (row.ino != null && row.ino !== st.ino))) {
    offset = 0;
    onReset?.();
  }
  let read = 0;
  if (offset < st.size) {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(chunk);
      let pending = Buffer.alloc(0);
      let pos = offset;
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, Math.min(chunk, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const data = pending.length
          ? Buffer.concat([pending, buf.subarray(0, n)])
          : buf.subarray(0, n);
        let start = 0;
        for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
          const line = data.toString("utf8", start, nl);
          offset += nl - start + 1;
          if (line) onLine(line);
          read++;
          start = nl + 1;
        }
        // The rest is a line still being written (or longer than a chunk): keep it for the next read.
        pending = Buffer.from(data.subarray(start));
      }
    } finally {
      closeSync(fd);
    }
  }
  stmt(db, 
    "insert into files (path, offset, size, ino) values (?, ?, ?, ?) on conflict (path) do update set offset = excluded.offset, size = excluded.size, ino = excluded.ino",
  ).run(path, offset, st.size, st.ino);
  return read;
}

/**
 * Writes one parsed line into the store. `file` is the transcript it came from, so its replies can
 * be dropped when the file is read again from the top.
 */
export function apply(db              , p        , agentId         , file         )       {
  const upsert = stmt(db, `
    insert into runs (id, kind, name, detail, session, branch, cwd, started_at, duration_ms, outcome, tool_use_id, trigger, output, rule, source, chars)
    values (:id, :kind, :name, :detail, :session, :branch, :cwd, :startedAt, :durationMs, :outcome, :toolUseId, :trigger, :output, :rule, :source, :chars)
    on conflict (id) do update set
      duration_ms = coalesce(excluded.duration_ms, runs.duration_ms),
      chars = coalesce(excluded.chars, runs.chars),
      output = coalesce(excluded.output, runs.output),
      rule = coalesce(excluded.rule, runs.rule),
      session = case when runs.session = '' then excluded.session else runs.session end,
      branch = coalesce(runs.branch, excluded.branch),
      cwd = coalesce(runs.cwd, excluded.cwd),
      source = case when excluded.source = 'timing' or runs.source = 'timing' then 'timing' else 'transcript' end,
      started_at = case when excluded.source = 'timing' then excluded.started_at else runs.started_at end,
      outcome = case
        when excluded.outcome = 'running' and runs.outcome != 'running' then runs.outcome
        when excluded.outcome = 'block' or runs.outcome = 'block' then 'block'
        when excluded.outcome = 'cancelled' or runs.outcome = 'cancelled' then 'cancelled'
        when excluded.outcome = 'error' or runs.outcome = 'error' then 'error'
        else excluded.outcome end`);
  for (const r of p.runs)
    upsert.run({ rule: null, source: "transcript", chars: null, ...r }         );
  // A reply's first line records its tokens; its later lines (one per content block, each repeating
  // the whole usage) only add their block counts.
  let tin = 0;
  let tout = 0;
  let tcached = 0;
  for (const u of p.usage) {
    const seen = db
      .prepare("select 1 from usage where session = ? and message_id = ?")
      .get(u.session, u.messageId);
    if (seen) {
      stmt(db, 
        "update usage set work = work + ?, orchestration = orchestration + ?, text = text + ? where session = ? and message_id = ?",
      ).run(u.work, u.orchestration, u.text, u.session, u.messageId);
      continue;
    }
    stmt(db, 
      `insert into usage (session, message_id, agent_id, file, branch, at, model, tokens_in, tokens_out, tokens_cached, tokens_write, work, orchestration, text)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.session,
      u.messageId,
      agentId ?? null,
      file ?? null,
      u.branch,
      p.at ?? 0,
      u.model,
      u.tokensIn,
      u.tokensOut,
      u.tokensCached,
      u.tokensWrite ?? 0,
      u.work,
      u.orchestration,
      u.text,
    );
    tin += u.tokensIn;
    tout += u.tokensOut;
    tcached += u.tokensCached;
  }
  for (const r of p.results) {
    // Tools end with their result. Skills last until the next prompt, agents until their own
    // transcript ends, so their result only links the agent.
    stmt(db, 
      `update runs set duration_ms = ? - started_at, outcome = ? where tool_use_id = ? and kind = 'tool' and outcome = 'running'`,
    ).run(r.at, r.isError ? "error" : "ok", r.toolUseId);
    stmt(db, 
      `update runs set outcome = 'ok' where tool_use_id = ? and kind = 'skill' and outcome = 'running'`,
    ).run(r.toolUseId);
    if (r.agentId)
      stmt(db, `update runs set agent_id = ? where tool_use_id = ? and kind = 'agent'`).run(
        r.agentId,
        r.toolUseId,
      );
  }
  for (const m of p.marks ?? [])
    stmt(db, "insert or ignore into marks (session, at, type) values (?, ?, ?)").run(m.session, m.at, m.type);
  for (const q of p.prompts) {
    stmt(db, "insert or ignore into prompts (session, at, text) values (?, ?, ?)").run(
      q.session,
      q.at,
      q.text,
    );
    stmt(db, 
      `update runs set duration_ms = ? - started_at where kind = 'skill' and session = ? and duration_ms is null and started_at < ?`,
    ).run(q.at, q.session, q.at);
  }
  if (agentId && p.at != null) {
    // Active time: the gaps between an agent's lines, except gaps over IDLE_MS (a follow-up message
    // days later, a wait for the owner). Set expressions read the row as it was before the update.
    stmt(db, 
      `
      insert into agents (agent_id, first_at, last_at, tokens_in, tokens_out, tokens_cached, active_ms, model, verdict)
      values (?, ?, ?, ?, ?, ?, 0, ?, ?)
      on conflict (agent_id) do update set
        active_ms = agents.active_ms + case
          when agents.last_at is not null and excluded.last_at > agents.last_at
            and excluded.last_at - agents.last_at <= ${IDLE_MS}
          then excluded.last_at - agents.last_at else 0 end,
        tokens_cached = agents.tokens_cached + excluded.tokens_cached,
        first_at = min(coalesce(agents.first_at, excluded.first_at), coalesce(excluded.first_at, agents.first_at)),
        last_at = max(coalesce(agents.last_at, 0), coalesce(excluded.last_at, 0)),
        tokens_in = agents.tokens_in + excluded.tokens_in,
        tokens_out = agents.tokens_out + excluded.tokens_out,
        model = coalesce(excluded.model, agents.model),
        verdict = coalesce(excluded.verdict, agents.verdict)`,
    ).run(
      agentId,
      p.at,
      p.at,
      tin,
      tout,
      tcached,
      p.usage.at(-1)?.model ?? null,
      verdictOf(p.lastText),
    );
  }
}

function ingestTranscript(db              , path        , agentId         )         {
  return readNew(
    db,
    path,
    (line) => {
      if (!WORTH.test(line) && !(agentId && line.includes('"timestamp"'))) return;
      apply(db, parseTranscriptLine(line, { agent: agentId }), agentId, path);
    },
    CHUNK,
    () => {
      stmt(db, "delete from usage where file = ?").run(path);
      if (agentId)
        stmt(db, 
          "update agents set tokens_in = 0, tokens_out = 0, tokens_cached = 0, active_ms = 0, first_at = null, last_at = null where agent_id = ?",
        ).run(agentId);
    },
  );
}

function ingestAgentMeta(
  db              ,
  metaPath        ,
  agentId        ,
  session        ,
)       {
  try {
    const m = JSON.parse(readFileSync(metaPath, "utf8"));
    stmt(db, 
      `
      insert into agents (agent_id, session, agent_type, description, finished, parent_id, spawn_depth) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (agent_id) do update set session = excluded.session, agent_type = excluded.agent_type,
        description = excluded.description, finished = excluded.finished, parent_id = excluded.parent_id,
        spawn_depth = excluded.spawn_depth`,
    ).run(
      agentId,
      session,
      m.agentType ?? null,
      redact(m.description, 120),
      m.finished ? 1 : 0,
      m.parentAgentId ?? null,
      Number.isInteger(m.spawnDepth) ? m.spawnDepth : null,
    );
    // The call that started it: the only link for an agent started by another agent, whose result
    // names it in text alone.
    if (typeof m.toolUseId === "string")
      stmt(db, 
        "update runs set agent_id = ? where tool_use_id = ? and kind = 'agent' and agent_id is null",
      ).run(agentId, m.toolUseId);
  } catch {
    /* no meta yet */
  }
}

                                
               
                                                                 
                       
                                                                     
                     
 

/** Reads everything new. Returns how many lines it read. */
export function ingest(db              , opts               )         {
  const root = resolve(opts.root);
  let lines = 0;
  // One writer at a time: the server and a manual ingest can run together.
  db.exec("begin immediate");
  try {
    for (const dir of projectDirs(root, opts.projectsDir)) {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) lines += ingestTranscript(db, join(dir, f));
        const sub = join(dir, f, "subagents");
        if (!existsSync(sub)) continue;
        const ids = readdirSync(sub)
          .map((s) => s.match(/^agent-([\w-]+)\.jsonl$/)?.[1])
          .filter((id)               => !!id);
        for (const id of ids) lines += ingestTranscript(db, join(sub, `agent-${id}.jsonl`), id);
        // After the transcripts: an agent's meta links it to the call in its parent's transcript.
        for (const id of ids) ingestAgentMeta(db, join(sub, `agent-${id}.meta.json`), id, f);
      }
    }
    // The optional hook logs (paths.ts, logDirs), shared by every worktree.
    for (const state of opts.logDirs ?? logDirs(root)) {
      const events = join(state, "events.jsonl");
      if (existsSync(events))
        lines += readNew(db, events, (line) => {
          const e = parseEventLine(line);
          if (e)
            stmt(
              db,
              "insert or ignore into events (ts, hook, type, branch, detail) values (?, ?, ?, ?, ?)",
            ).run(e.ts, e.hook, e.type, e.branch, e.detail ?? "");
        });
      const timed = join(state, "runs.jsonl");
      if (existsSync(timed))
        lines += readNew(db, timed, (line) => {
          const r = parseHookRunLine(line);
          if (r)
            apply(db, { runs: [r], results: [], prompts: [], usage: [], lastText: null, at: null });
        });
    }
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
  return lines;
}
