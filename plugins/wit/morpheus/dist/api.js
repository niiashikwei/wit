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
import { loadConfig,                } from "./config.js";
import { ingestGit } from "./git.js";
import { ingestGh,             } from "./gh.js";
import { dora } from "./dora.js";
import { ingestReports } from "./testreports.js";
import { allTests, discover,                                latestCoverage, pyramidNode, testHistory } from "./pyramid.js";
import {                tasksReport } from "./tasks.js";
import { diskSample, resources, sample } from "./resources.js";
import { quality } from "./quality.js";
import { health } from "./health.js";

const RANGES          = ["1h", "today", "7d", "30d", "all"];
const SORTS             = ["tokens", "cost", "duration", "recent"];
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
    const file = opts.db ?? dbPath(r);
    p = {
      root: r,
      db: openStore(file),
      def: inventory(r),
      defAt: Date.now(),
      readAt: 0,
      projectsDir: opts.projectsDir,
      cfg: loadConfig(r),
      sdlcAt: 0,
      found: null,
      foundAt: 0,
      dbFile: file === ":memory:" ? null : file,
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

/**
 * Reads the SDLC sources: git history, test and coverage reports, and GitHub when opted in. At
 * most every 15 seconds (GitHub every 10 minutes); returns how many records it read.
 */
export function refreshSdlc(p         , now = Date.now(), minMs = 15_000)         {
  if (now - p.sdlcAt < minMs) return 0;
  p.sdlcAt = now;
  p.cfg = loadConfig(p.root);
  return ingestGit(p.db, p.root, p.cfg) + ingestReports(p.db, p.root, p.cfg) + ingestGh(p.db, p.root, p.cfg, now, p.gh);
}

/** The tests in the project's source, found again at most once a minute. */
export function tests(p         , now = Date.now())              {
  if (!p.found || now - p.foundAt > 60_000) {
    p.found = discover(p.root);
    p.foundAt = now;
  }
  return p.found;
}

/** The testing pyramid at a path, with history, the slowest and flaky tests. */
export function testsView(p         , input                         , now        ) {
  const grouping           = input.grouping === "feature" ? "feature" : "layer";
  const path = typeof input.path === "string" && input.path ? input.path.split("|").slice(0, 6) : [];
  const all = allTests(p.db, p.root, p.cfg, tests(p, now));
  const cov = latestCoverage(p.db);
  const view = pyramidNode(all, cov, grouping, path);
  const top = pyramidNode(all, cov, "layer", []).node;
  const reports = p.db.prepare("select path, kind, framework, layer, max(at) as at, count(*) as versions from test_reports group by path order by at desc").all();
  return {
    ...view,
    pyramid: top,
    history: testHistory(p.db),
    slowest: all.filter((t) => t.durationMs != null).sort((a, b) => b.durationMs  - a.durationMs ).slice(0, 10).map((t) => ({ id: t.id, name: t.name, file: t.file, layer: t.layer, durationMs: t.durationMs })),
    flaky: all.filter((t) => t.flaky).slice(0, 20).map((t) => ({ id: t.id, name: t.name, file: t.file, layer: t.layer })),
    failing: all.filter((t) => t.status === "failed").slice(0, 20).map((t) => ({ id: t.id, name: t.name, file: t.file, layer: t.layer })),
    reports,
  };
}

/** Everything the health scorecard needs, computed once. */
export function healthView(p         , input                         , now        ) {
  const s = scopeOf(input);
  const d = dora(p.db, s.range, now, p.cfg);
  const t = tasksReport(p.db, { range: s.range }, now, { limit: 0 });
  const q = quality(p.db, p.root, s.range, now, t.totals);
  const tv = pyramidNode(allTests(p.db, p.root, p.cfg, tests(p, now)), latestCoverage(p.db), "layer", []).node;
  return {
    ...health(p.db, s.range, now, { dora: d, tasks: t, quality: q, tests: { node: tv }, ghOn: p.cfg.gh }),
    dora: { frequency: d.frequency, leadTime: d.leadTime, failureRate: d.failureRate, restore: d.restore, deploys: d.deploys, weeks: d.weeks, source: d.source },
    tokens: t.totals,
    pyramid: tv,
    ai: q.ai,
    improvements: improvements(p, now).slice(0, 5),
  };
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
    name: "morpheus_health",
    description:
      "One SDLC scorecard: plan, code, review, test, build, deploy, operate and AI efficiency, each good, warn, bad or unknown with the numbers and thresholds behind it, plus headline DORA, token and test numbers.",
    inputSchema: { type: "object", properties: { range: scopeProps.range, project: scopeProps.project } },
    run: (p, input, now) => healthView(p, input, now),
  },
  {
    name: "morpheus_dora",
    description:
      "The four DORA metrics (deploy frequency, lead time for changes, change failure rate, time to restore) with their performance bands, weekly trend, recent deploys and CI pass rate. From git, or GitHub when opted in.",
    inputSchema: { type: "object", properties: { range: scopeProps.range, project: scopeProps.project } },
    run: (p, input, now) => dora(p.db, scopeOf(input).range, now, p.cfg),
  },
  {
    name: "morpheus_tests",
    description:
      "The testing pyramid: tests by layer (unit, integration, e2e) → module → file → class → test, or by feature, with counts, results, time and coverage at each level; plus history, slowest, flaky and failing tests.",
    inputSchema: {
      type: "object",
      properties: {
        grouping: { type: "string", enum: ["layer", "feature"], description: "Group by layer (default) or feature." },
        path: { type: "string", description: "The node to open, its keys joined by |, e.g. unit|src/api. Empty for the whole pyramid." },
        project: scopeProps.project,
      },
    },
    run: (p, input, now) => testsView(p, input, now),
  },
  {
    name: "morpheus_tasks",
    description:
      "Tokens and estimated cost per task (one prompt and everything it set off), by task category, by model and per day, with the task list sorted by tokens, cost, duration or recency.",
    inputSchema: {
      type: "object",
      properties: {
        ...scopeProps,
        sort: { type: "string", enum: SORTS, description: "Order of the task list; default tokens." },
        category: { type: "string", description: "Only tasks in this category." },
      },
    },
    run: (p, input, now) =>
      tasksReport(p.db, scopeOf(input), now, {
        sort: SORTS.includes(input.sort            ) ? (input.sort            ) : "tokens",
        category: typeof input.category === "string" && input.category ? input.category : null,
      }),
  },
  {
    name: "morpheus_resources",
    description:
      "CPU and memory of Claude Code, its MCP servers, hooks and commands, and Wit itself; the machine's load, memory and free disk; the project's disk footprint; and the time test and build commands take.",
    inputSchema: { type: "object", properties: { range: scopeProps.range, project: scopeProps.project } },
    run: (p, input, now) => {
      const last = (p.db.prepare("select max(at) as t from resource_samples").get()                        ).t ?? 0;
      if (now - last >= p.cfg.sampleSeconds * 1000) sample(p.db, p.root, now);
      diskSample(p.db, p.root, now, p.dbFile);
      return resources(p.db, scopeOf(input).range, now);
    },
  },
  {
    name: "morpheus_quality",
    description:
      "Whether AI help pays off and code stays healthy: AI co-authored share, AI lines redone within 14 days, tokens and cost per commit and line, cache hits, corrections, denials, compactions, tool errors, test-to-code ratio, churn hotspots and coverage of changed code.",
    inputSchema: { type: "object", properties: { range: scopeProps.range, project: scopeProps.project } },
    run: (p, input, now) => {
      const s = scopeOf(input);
      return quality(p.db, p.root, s.range, now, tasksReport(p.db, { range: s.range }, now, { limit: 0 }).totals);
    },
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
  refreshSdlc(p);
  return tool.run(p, input, opts.now ?? Date.now());
}
