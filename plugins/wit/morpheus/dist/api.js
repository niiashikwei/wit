/**
 * Morpheus's questions, shared by the MCP server and the web server: each brings the project's
 * store up to date (at most every couple of seconds), then answers. Read-only.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
                                                
import { rank } from "./improvements.js";
import { ingest } from "./ingest.js";
import {               inventory } from "./inventory.js";
import {
  coverage,
  item,
                
  items,
  live,
  overview,
             
             
  since,
  timeline,
  tokens,
  toolsTable,
} from "./metrics.js";
import { dbPath, listProjects, projectRoot } from "./paths.js";
import { openStore } from "./store.js";

const RANGES          = ["1h", "today", "7d", "30d", "all"];
const KINDS = ["hook", "rule", "skill", "agent", "tool"]         ;
                                   

export function scopeOf(input                          = {})        {
  const range = RANGES.includes(input.range         ) ? (input.range         ) : "7d";
  const text = (v         ) => (typeof v === "string" && v.length > 0 && v.length < 200 ? v : null);
  return { range, session: text(input.session), branch: text(input.branch) };
}

/** One watched project: its store, what it defines, and when it was last read. */
                          
               
                   
               
                
                 
                                                     
                       
 

const open = new Map                 ();

/** The project at `root` (opened once and kept), or the default one. */
export function project(root                , opts                                        = {}) {
  const r = resolve(root ?? projectRoot());
  let p = open.get(r);
  if (!p) {
    p = {
      root: r,
      db: openStore(opts.db ?? dbPath(r)),
      def: inventory(r),
      defAt: Date.now(),
      readAt: 0,
      projectsDir: opts.projectsDir,
    };
    open.set(r, p);
  }
  return p;
}

/** Reads what's new, unless that was done in the last `minMs`. Returns the lines read. */
export function refresh(p         , minMs = 2000)         {
  const now = Date.now();
  if (now - p.defAt > 60_000) {
    p.def = inventory(p.root);
    p.defAt = now;
  }
  if (now - p.readAt < minMs) return 0;
  p.readAt = now;
  return ingest(p.db, { root: p.root, projectsDir: p.projectsDir });
}

/** The ranked improvements, always over the last 7 days so the list stays steady while you filter. */
export function improvements(p         , now        ) {
  const scope        = { range: "7d" };
  const { db, def } = p;
  const o = overview(db, scope, now, def.skills);
  const first =
    (db.prepare("select min(started_at) as t from runs").get()                        ).t ?? now;
  const last = (
    db
      .prepare("select max(started_at) as t from runs where session not like '%/agent-%'")
      .get()                        
  ).t;
  return rank({
    weeks: Math.min(1, (now - Math.max(first, since("7d", now))) / (7 * 86_400_000)),
    now,
    hooks: items(db, "hook", scope, now)         ,
    rules: items(db, "rule", scope, now)         ,
    skills: items(db, "skill", scope, now, def.skills)         ,
    agents: items(db, "agent", scope, now)         ,
    tools: toolsTable(db, scope, now)         ,
    kpis: o.kpis,
    defined: def,
    coverage: coverage(db, now, def).rows,
    tokens: tokens(db, scope, now, def)         ,
    lastActivity: last,
    timingSince: o.kpis.timingSince,
  });
}

                       
               
                      
                                       
                                                                            
 

const scopeProps = {
  range: { type: "string", enum: RANGES, description: "Time range; default 7d." },
  session: { type: "string", description: "Only this Claude Code session id." },
  branch: { type: "string", description: "Only this git branch." },
  project: {
    type: "string",
    description: "The project's folder; default the one Morpheus was started in.",
  },
};

const kindOf = (v         )       => (KINDS.includes(v        ) ? (v        ) : "hook");

export const TOOLS         = [
  {
    name: "morpheus_projects",
    description: "Every project Claude Code has transcripts for, newest first.",
    inputSchema: { type: "object", properties: {} },
    run: () => listProjects().filter((x) => existsSync(x.root)),
  },
  {
    name: "morpheus_live",
    description:
      "Sessions active in the last 10 minutes with what each is running, and the newest 50 hook, skill and agent runs.",
    inputSchema: {
      type: "object",
      properties: {
        session: scopeProps.session,
        branch: scopeProps.branch,
        project: scopeProps.project,
      },
    },
    run: (p, input, now) => live(p.db, now, scopeOf(input)),
  },
  {
    name: "morpheus_overview",
    description:
      "Headline numbers for a range and scope (hook runs and time, blocks, hints followed, skill loads, agent runs and tokens), time per day, and the next improvements ranked by ROI.",
    inputSchema: { type: "object", properties: scopeProps },
    run: (p, input, now) => ({
      ...overview(p.db, scopeOf(input), now, p.def.skills),
      project: p.root,
      improvements: improvements(p, now),
    }),
  },
  {
    name: "morpheus_items",
    description:
      "One table: every hook script, hook rule, skill, agent type or tool, with runs, p50/p95/max time and outcomes.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: KINDS }, ...scopeProps },
      required: ["kind"],
    },
    run: (p, input, now) => {
      const kind = kindOf(input.kind);
      return kind === "tool"
        ? toolsTable(p.db, scopeOf(input), now)
        : items(p.db, kind            , scopeOf(input), now, p.def.skills);
    },
  },
  {
    name: "morpheus_item",
    description:
      "One hook, rule, skill or agent in detail: time histogram, runs per day, recent runs with what each was doing, and by session.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KINDS.filter((k) => k !== "tool") },
        name: { type: "string" },
        ...scopeProps,
      },
      required: ["kind", "name"],
    },
    run: (p, input, now) => {
      const kind = kindOf(input.kind);
      return item(
        p.db,
        (kind === "tool" ? "hook" : kind)            ,
        String(input.name ?? ""),
        scopeOf(input),
        now,
      );
    },
  },
  {
    name: "morpheus_timeline",
    description:
      "One session's hooks, hints, skills and agents in the order they fired, nested agents under the one that started them. Without a session, the most recently active one.",
    inputSchema: {
      type: "object",
      properties: {
        session: scopeProps.session,
        range: scopeProps.range,
        project: scopeProps.project,
      },
    },
    run: (p, input, now) => {
      const s = scopeOf({ range: "1h", ...input });
      return timeline(p.db, now, { session: s.session, range: s.range });
    },
  },
  {
    name: "morpheus_coverage",
    description:
      "Every hook, rule, skill and agent defined for the project (and any that ran without being defined there): how often it ran, how often its work came up without it, and active, missed, idle or off.",
    inputSchema: {
      type: "object",
      properties: { range: scopeProps.range, project: scopeProps.project },
    },
    run: (p, input, now) => coverage(p.db, now, p.def, scopeOf(input).range),
  },
  {
    name: "morpheus_tokens",
    description:
      "Where the tokens went: new tokens and cached reads for work, orchestration and replies; by session (its own apart from its agents'), by agent type, per day; and the context hooks and skill loads add (estimates).",
    inputSchema: { type: "object", properties: scopeProps },
    run: (p, input, now) => tokens(p.db, scopeOf(input), now, p.def),
  },
  {
    name: "morpheus_inventory",
    description:
      "What the project has set up: hook scripts and their events, rules, skills with their sizes, agents, and where each is defined (project, user, plugin).",
    inputSchema: { type: "object", properties: { project: scopeProps.project } },
    run: (p) => ({ root: p.root, ...p.def }),
  },
];

/** Brings the project's store up to date, then answers one question. */
export function answer(
  name        ,
  input                          = {},
  opts                                  = {},
) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const root = typeof input.project === "string" && input.project ? input.project : opts.root;
  if (name === "morpheus_projects") return tool.run(null         , input, Date.now());
  const p = project(root);
  refresh(p);
  return tool.run(p, input, opts.now ?? Date.now());
}
