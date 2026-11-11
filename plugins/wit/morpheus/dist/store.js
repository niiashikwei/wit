/**
 * Morpheus's store: SQLite through Node's built-in node:sqlite, one file per project outside the
 * project (paths.ts, dbPath; ":memory:" in tests). It can always be rebuilt from the transcripts:
 * delete it and the next read backfills. It keeps what it has read even after Claude Code deletes
 * old transcripts (cleanupPeriodDays), so history outlives them.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
create table if not exists runs (
  id text primary key, kind text not null, name text not null, detail text,
  session text not null, branch text, cwd text, started_at integer not null,
  duration_ms integer, outcome text not null, tool_use_id text, trigger text, output text,
  agent_id text, rule text, source text not null default 'transcript', chars integer
);
create index if not exists runs_kind_name on runs (kind, name, started_at);
create index if not exists runs_started on runs (started_at);
create index if not exists runs_tool_use on runs (tool_use_id);
create index if not exists runs_session on runs (session, started_at);
create table if not exists agents (
  agent_id text primary key, session text, agent_type text, description text,
  first_at integer, last_at integer, tokens_in integer default 0, tokens_out integer default 0,
  tokens_cached integer default 0, active_ms integer default 0,
  model text, verdict text, finished integer default 0, parent_id text, spawn_depth integer
);
create table if not exists usage (
  session text not null, message_id text not null, agent_id text, file text, branch text,
  at integer not null, model text, tokens_in integer not null default 0,
  tokens_out integer not null default 0, tokens_cached integer not null default 0,
  work integer not null default 0, orchestration integer not null default 0,
  text integer not null default 0, primary key (session, message_id)
);
create index if not exists usage_at on usage (at);
create index if not exists usage_file on usage (file);
create table if not exists prompts (
  session text not null, at integer not null, text text, primary key (session, at)
);
create table if not exists events (
  ts integer not null, hook text not null, type text not null, branch text, detail text not null default '',
  primary key (ts, hook, type, detail)
);
create index if not exists events_ts on events (ts);
create table if not exists files (path text primary key, offset integer not null, size integer, ino integer);
`;

/** Raise when the tables change: an older store is dropped and read again from the transcripts. */
const VERSION = 1;
const TABLES = ["runs", "agents", "usage", "prompts", "events", "files"];

export function openStore(path        )               {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to a new folder.
    chmodSync(dirname(path), 0o700);
  }
  const db = new DatabaseSync(path);
  // The server and a manual ingest may write at once: wait for the other rather than fail.
  db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal; pragma synchronous = normal;");
  const { user_version } = db.prepare("pragma user_version").get()     
                         
   ;
  if (user_version !== VERSION) {
    for (const t of TABLES) db.exec(`drop table if exists ${t}`);
    db.exec(`pragma user_version = ${VERSION}`);
  }
  db.exec(SCHEMA);
  // Only you read it: it holds excerpts of commands and hook output.
  if (path !== ":memory:")
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  return db;
}
