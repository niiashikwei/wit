/**
 * Tasks: what each prompt you gave Claude cost and did. A task runs from one of your prompts to the
 * next in the same session, and includes the agents it started. Each gets a category (feature,
 * bugfix, test, refactor, docs, review, explore, ops, chore) from its prompt and what it touched,
 * its tokens split new / cached, its estimated cost, its time and its tool calls.
 */
                                                
import { costOf } from "./cost.js";
import { dayKey, dayKeys,             since } from "./metrics.js";

export const CATEGORIES = ["feature", "bugfix", "test", "refactor", "docs", "review", "explore", "ops", "chore", "interrupt"]         ;
                                                   

const RULES                       = [
  ["interrupt", /^\[request interrupted/i],
  ["review", /\b(review|audit|critique|look over|sanity.check)\b/i],
  ["bugfix", /\b(fix(es|ed|ing)?|bugs?|broken|errors?|fail(s|ing|ed|ure)?|crash(es|ing)?|regression|doesn'?t work|not working|wrong)\b/i],
  ["test", /\b(tests?|testing|coverage|specs?|e2e|tdd)\b/i],
  ["docs", /\b(docs?|readme|documentation|changelog|docstrings?|comments?)\b/i],
  ["refactor", /\b(refactor\w*|clean ?up|rename|simplif\w*|restructur\w*|reorganiz\w*|tidy|dedupe)\b/i],
  ["ops", /\b(deploy\w*|ci|pipelines?|release|docker\w*|k8s|kubernetes|workflows?|publish|merge|commit|push|rebase|pr|pull request|version bump)\b/i],
  ["feature", /\b(add|implement|build|create|support|feature|introduce|make|new|enable|allow)\b/i],
  ["explore", /\b(explain|what|why|how|where|which|investigate|understand|research|find|look into|show me|tell me)\b|\?\s*$/i],
];

/** A task's category from its prompt, else from what it touched. */
export function categorise(prompt        , touched                                                    )           {
  for (const [c, re] of RULES) if (re.test(prompt)) return c;
  const { edits } = touched;
  if (edits.length) {
    if (edits.every((f) => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.|(^|\/)test_/.test(f))) return "test";
    if (edits.every((f) => /\.(md|mdx|rst|txt|adoc)$/i.test(f))) return "docs";
    if (edits.every((f) => /(^|\/)(\.github|\.gitlab-ci|Dockerfile|docker-compose|\.circleci)/.test(f))) return "ops";
    return "feature";
  }
  if (touched.bash.some((c) => /^(git (commit|push|merge|rebase)|gh pr|npm publish|docker)/.test(c))) return "ops";
  if (touched.reads) return "explore";
  return "chore";
}

/** A prompt that pushes back on what came before: a correction of the last task. */
export const isCorrection = (prompt        ) =>
  /^\s*(no\b|nope|stop\b|wait\b|undo|revert|that'?s (not|wrong)|wrong\b|don'?t\b|actually\b|not what|instead\b|you (broke|missed|forgot))/i.test(prompt) ||
  /^\[request interrupted/i.test(prompt);

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "LS"]);

                       
             
                  
             
                
                 
                     
                     
                    
                   
                    
                       
               
               
                        
                    
                     
                 
                   
                  
                                 
                     
 

                                                                 
                                                                                                                                                                                                 
                                                                                                                                                         

/** The latest index in a sorted list of times at or before `t`. */
function at(times          , t        )         {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]  <= t) ((found = mid), (lo = mid + 1));
    else hi = mid - 1;
  }
  return found;
}

/** Every task that started in the scope, oldest first. */
export function buildTasks(db              , scope       , now        )         {
  const from = since(scope.range, now);
  const sessionSql = scope.session ? "and (session = ? or session like ?)" : "";
  const sessionArgs = scope.session ? [scope.session, `${scope.session}/agent-%`] : [];
  const prompts = db
    .prepare(`select session, at, text from prompts where at >= ? ${sessionSql} order by session, at`)
    .all(from, ...sessionArgs)                          ;
  if (!prompts.length) return [];
  const usage = db
    .prepare(`select session, at, model, tokens_in, tokens_out, tokens_cached, tokens_write, work, orchestration from usage where at >= ? ${sessionSql} ${scope.branch ? "and branch = ?" : ""}`)
    .all(from, ...sessionArgs, ...(scope.branch ? [scope.branch] : []))                         ;
  const runs = db
    .prepare(`select session, started_at, kind, name, trigger, outcome, duration_ms from runs where started_at >= ? and kind in ('tool', 'skill', 'agent') ${sessionSql}`)
    .all(from, ...sessionArgs)                       ;
  const bySession = new Map                     ();
  for (const p of prompts) (bySession.get(p.session) ?? bySession.set(p.session, []).get(p.session) ).push(p);
  const tasks = new Map              ();
  const times = new Map                  ();
  for (const [s, ps] of bySession) {
    times.set(s, ps.map((p) => p.at));
    ps.forEach((p, i) => {
      const id = `${s}:${p.at}`;
      tasks.set(id, {
        id, session: s, at: p.at, endAt: p.at, prompt: p.text, category: "chore",
        corrected: !!ps[i + 1] && isCorrection(ps[i + 1] .text),
        tokensNew: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, cost: 0, work: 0, orchestration: 0,
        toolCalls: 0, toolErrors: 0, agents: 0, skills: [], files: [], models: {}, durationMs: 0,
      });
    });
  }
  const taskFor = (session        , t        ) => {
    const top = session.split("/agent-")[0] ;
    const ts = times.get(top);
    if (!ts) return null;
    const i = at(ts, t);
    return i < 0 ? null : tasks.get(`${top}:${ts[i]}`) ;
  };
  for (const u of usage) {
    const task = taskFor(u.session, u.at);
    if (!task) continue;
    const fresh = u.tokens_in + u.tokens_out;
    task.tokensIn += u.tokens_in;
    task.tokensOut += u.tokens_out;
    task.tokensCached += u.tokens_cached;
    task.tokensNew += fresh;
    task.cost += costOf(u.model, { tokensIn: u.tokens_in, tokensOut: u.tokens_out, tokensCached: u.tokens_cached, tokensWrite: u.tokens_write });
    const calls = u.work + u.orchestration;
    if (calls) {
      const w = Math.round((fresh * u.work) / calls);
      task.work += w;
      task.orchestration += fresh - w;
    }
    const model = u.model ?? "unknown";
    task.models[model] = (task.models[model] ?? 0) + fresh;
    task.endAt = Math.max(task.endAt, u.at);
  }
  const touched = new Map                                                               ();
  for (const r of runs) {
    const task = taskFor(r.session, r.started_at);
    if (!task) continue;
    const t = touched.get(task.id) ?? touched.set(task.id, { edits: new Set(), reads: 0, bash: [] }).get(task.id) ;
    task.endAt = Math.max(task.endAt, r.started_at + (r.duration_ms ?? 0));
    if (r.kind === "agent") task.agents++;
    else if (r.kind === "skill") task.skills.includes(r.name) || task.skills.push(r.name);
    else {
      task.toolCalls++;
      if (r.outcome === "error") task.toolErrors++;
      if (EDIT_TOOLS.has(r.name) && r.trigger) t.edits.add(r.trigger);
      if (READ_TOOLS.has(r.name)) t.reads++;
      if (r.name === "Bash" && r.trigger) t.bash.push(r.trigger);
    }
  }
  const out = [...tasks.values()].sort((a, b) => a.at - b.at);
  for (const task of out) {
    const t = touched.get(task.id) ?? { edits: new Set        (), reads: 0, bash: [] };
    task.files = [...t.edits].slice(0, 50);
    task.category = categorise(task.prompt, { edits: [...t.edits], reads: t.reads, bash: t.bash });
    task.durationMs = Math.max(0, task.endAt - task.at);
    task.cost = Math.round(task.cost * 1e6) / 1e6;
  }
  return out;
}

                                                                 

/** Tokens and cost by category, model and day, plus the task list (sorted) or one task. */
export function tasksReport(db              , scope       , now        , opts                                                                = {}) {
  const all = buildTasks(db, scope, now);
  const cats = new Map                                                                                                                                                                                  ();
  const models = new Map                                                            ();
  const days = new Map                                ();
  for (const t of all) {
    const c = cats.get(t.category) ?? { category: t.category, tasks: 0, tokensNew: 0, tokensCached: 0, cost: 0, durationMs: 0, corrected: 0, toolErrors: 0, toolCalls: 0 };
    c.tasks++;
    c.tokensNew += t.tokensNew;
    c.tokensCached += t.tokensCached;
    c.cost += t.cost;
    c.durationMs += t.durationMs;
    c.corrected += t.corrected ? 1 : 0;
    c.toolErrors += t.toolErrors;
    c.toolCalls += t.toolCalls;
    cats.set(t.category, c);
    const d = days.get(dayKey(t.at)) ?? days.set(dayKey(t.at), {}).get(dayKey(t.at)) ;
    d[t.category] = (d[t.category] ?? 0) + t.tokensNew;
  }
  // Models from every reply in range, so replies outside any task (resumed sessions) still count.
  const from = since(scope.range, now);
  for (const u of db.prepare("select model, tokens_in, tokens_out, tokens_cached, tokens_write from usage where at >= ?").all(from)                         ) {
    const m = models.get(u.model ?? "unknown") ?? { model: u.model ?? "unknown", tokensNew: 0, cost: 0 };
    m.tokensNew += u.tokens_in + u.tokens_out;
    m.cost += costOf(u.model, { tokensIn: u.tokens_in, tokensOut: u.tokens_out, tokensCached: u.tokens_cached, tokensWrite: u.tokens_write });
    models.set(m.model, m);
  }
  const sort = opts.sort ?? "tokens";
  const key                                        = { tokens: (t) => t.tokensNew, cost: (t) => t.cost, duration: (t) => t.durationMs, recent: (t) => t.at };
  const list = all.filter((t) => !opts.category || t.category === opts.category).sort((a, b) => key[sort](b) - key[sort](a));
  const totalNew = all.reduce((s, t) => s + t.tokensNew, 0);
  const totalCached = all.reduce((s, t) => s + t.tokensCached, 0);
  const totalIn = all.reduce((s, t) => s + t.tokensIn, 0);
  const first = all[0]?.at ?? now;
  return {
    totals: {
      tasks: all.length,
      tokensNew: totalNew,
      tokensCached: totalCached,
      cost: all.reduce((s, t) => s + t.cost, 0),
      perTask: all.length ? totalNew / all.length : null,
      costPerTask: all.length ? all.reduce((s, t) => s + t.cost, 0) / all.length : null,
      cacheHit: totalCached + totalIn ? totalCached / (totalCached + totalIn) : null,
      corrected: all.filter((t) => t.corrected).length,
    },
    byCategory: [...cats.values()].sort((a, b) => b.tokensNew - a.tokensNew),
    byModel: [...models.values()].sort((a, b) => b.tokensNew - a.tokensNew),
    days: dayKeys(scope.range === "all" ? first : from, now).map((d) => ({ day: d, ...(days.get(d) ?? {}) })),
    list: list.slice(0, opts.limit ?? 200),
    count: list.length,
  };
}
