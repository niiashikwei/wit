/**
 * One scorecard for the whole delivery cycle: each stage (plan, code, review, test, build, deploy,
 * operate, AI efficiency) is good, needs a look, or bad, with the numbers and thresholds that
 * decided it. A stage with no data says how to turn it on, rather than guessing.
 */
                                                
                                      
import { since,            } from "./metrics.js";

                                                         
                                                                         
                         
                
                                
             
                 
                 
 
                        
              
                
                   
                 
                    
                      
 

/** Good when at or past `good`, a warning to `ok`, bad beyond; `up` says which way is better. */
export function grade(v                           , good        , ok        , up         )         {
  if (v == null || !Number.isFinite(v)) return "unknown";
  if (up) return v >= good ? "good" : v >= ok ? "warn" : "bad";
  return v <= good ? "good" : v <= ok ? "warn" : "bad";
}
export const bandStatus = (b      )         => (b == null ? "unknown" : b === "elite" || b === "high" ? "good" : b === "medium" ? "warn" : "bad");
const ORDER           = ["bad", "warn", "good"];
/** A stage is as healthy as its worst known metric. */
export function worst(ms          )         {
  const known = ms.map((m) => m.status).filter((s) => s !== "unknown");
  return known.length ? known.reduce((w, s) => (ORDER.indexOf(s) < ORDER.indexOf(w) ? s : w)) : "unknown";
}

                               
                                                                                                                                                                                                                                                                    
                                                                                   
                                                                                                                                                                                   
                                                                                                                        
                
 

export function health(db              , range       , now        , x              ) {
  const m = (label        , value                        , unit      , target        , status        )         => ({ label, value, unit, target, status });
  const from = since(range === "1h" || range === "today" ? "7d" : range, now);
  const landed = db.prepare("select count(*) as n, coalesce(sum(is_merge), 0) as merges from commits where landed = 1 and at >= ?").get(from)                                 ;
  const mergeShare = landed.n ? Number(landed.merges) / Number(landed.n) : null;
  const correction = x.tasks.totals.tasks ? x.tasks.totals.corrected / x.tasks.totals.tasks : null;
  const t = x.tests.node;
  // Only tests with a result count: tests found in the source but never run say nothing yet.
  const ran = t.passed + t.failed;
  const failShare = ran ? t.failed / ran : null;
  const stages          = [
    {
      key: "plan", label: "Plan", question: "Does Claude understand what you ask the first time?",
      metrics: [m("Prompts corrected or interrupted", correction, "pct", "≤ 10%", grade(correction, 0.1, 0.25, false))],
      hint: correction == null ? "No prompts recorded in this range yet." : null, status: "unknown",
    },
    {
      key: "code", label: "Code", question: "Does AI-written code stick?",
      metrics: [m("AI lines redone within 14 days", x.quality.rework.ai.rate, "pct", "≤ 10%", grade(x.quality.rework.ai.rate, 0.1, 0.2, false))],
      hint: x.quality.rework.ai.rate == null ? "No Claude co-authored commits yet: Claude Code adds a Co-Authored-By trailer when it commits." : null, status: "unknown",
    },
    {
      key: "review", label: "Review", question: "Do changes land through review?",
      metrics: [m("Changes landed by merge or PR", mergeShare, "pct", "≥ 80%", grade(mergeShare, 0.8, 0.4, true))],
      hint: mergeShare == null ? "No changes landed on the main branch in this range." : null, status: "unknown",
    },
    {
      key: "test", label: "Test", question: "Is the code tested, and do the tests pass?",
      metrics: [
        m("Line coverage", t.coverage?.lines ?? null, "pct", "≥ 80%", grade(t.coverage?.lines, 0.8, 0.6, true)),
        m("Changed code covered", x.quality.changedCoverage.lines, "pct", "≥ 80%", grade(x.quality.changedCoverage.lines, 0.8, 0.6, true)),
        m("Failing tests", failShare, "pct", "0%", grade(failShare, 0, 0.05, false)),
        m("Flaky tests", ran ? t.flaky : null, "count", "0", ran ? grade(t.flaky, 0, 3, false) : "unknown"),
      ],
      hint: t.coverage == null ? "No coverage report found: run your tests with coverage (lcov, Cobertura, coverage.py JSON, JaCoCo, Go profile) or list it in .claude/wit.json." : null, status: "unknown",
    },
    {
      key: "build", label: "Build & CI", question: "Does CI stay green?",
      metrics: [m("CI runs passing", x.dora.ci.passRate, "pct", "≥ 90%", grade(x.dora.ci.passRate, 0.9, 0.75, true))],
      hint: x.ghOn ? (x.dora.ci.runs ? null : "No CI runs found on GitHub for this range.") : 'Turn on GitHub data with "gh": true in .claude/wit.json (uses the gh CLI).', status: "unknown",
    },
    {
      key: "deploy", label: "Deploy", question: "How often and how fast do changes ship?",
      metrics: [
        m("Deploys a week", x.dora.frequency.perWeek, "perWeek", "daily or more", bandStatus(x.dora.frequency.band)),
        m("Lead time for changes", x.dora.leadTime.p50, "ms", "< 1 day", bandStatus(x.dora.leadTime.band)),
      ],
      hint: x.dora.deploys ? null : "No deploys in this range. Set what counts as a deploy with \"deploy\" in .claude/wit.json.", status: "unknown",
    },
    {
      key: "operate", label: "Operate", question: "How often do deploys break, and how fast are they fixed?",
      metrics: [
        m("Change failure rate", x.dora.failureRate.rate, "pct", "≤ 5%", bandStatus(x.dora.failureRate.band)),
        m("Time to restore", x.dora.restore.p50, "ms", "< 1 hour", bandStatus(x.dora.restore.band)),
      ],
      hint: x.dora.deploys ? null : "Needs deploys first.", status: "unknown",
    },
    {
      key: "ai", label: "AI efficiency", question: "Are tokens well spent?",
      metrics: [
        m("Cache hit rate", x.tasks.totals.cacheHit, "pct", "≥ 70%", grade(x.tasks.totals.cacheHit, 0.7, 0.5, true)),
        m("Tool calls failing", x.quality.process.toolErrorRate, "pct", "≤ 5%", grade(x.quality.process.toolErrorRate, 0.05, 0.1, false)),
        m("Compactions a session", x.quality.process.compactionsPerSession, "ratio", "≤ 0.5", grade(x.quality.process.compactionsPerSession, 0.5, 1, false)),
      ],
      hint: null, status: "unknown",
    },
  ];
  for (const s of stages) s.status = worst(s.metrics);
  const known = stages.filter((s) => s.status !== "unknown");
  const score = known.length ? Math.round((100 * known.reduce((sum, s) => sum + (s.status === "good" ? 1 : s.status === "warn" ? 0.5 : 0), 0)) / known.length) : null;
  return { score, stages, measured: known.length };
}
