/**
 * The four DORA metrics from the deploys git (or GitHub) gave: how often the project deploys, how
 * long a change takes to reach a deploy, how many deploys need fixing, and how long the fix takes.
 * Each comes with its DORA performance band and a weekly trend, and says where its data came from.
 */
                                                
                                             
import { isHotfix } from "./git.js";
import { percentile,             since } from "./metrics.js";

                                                              
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** DORA bands (State of DevOps): deploys per day, lead time, failure rate, time to restore. */
export const bandOf = {
  frequency: (perDay               )       =>
    perDay == null ? null : perDay >= 1 ? "elite" : perDay >= 1 / 7 ? "high" : perDay >= 1 / 30 ? "medium" : "low",
  leadTime: (ms               )       =>
    ms == null ? null : ms < DAY ? "elite" : ms < WEEK ? "high" : ms < 30 * DAY ? "medium" : "low",
  failureRate: (rate               )       =>
    rate == null ? null : rate <= 0.05 ? "elite" : rate <= 0.1 ? "high" : rate <= 0.15 ? "medium" : "low",
  restore: (ms               )       =>
    ms == null ? null : ms < HOUR ? "elite" : ms < DAY ? "high" : ms < WEEK ? "medium" : "low",
};

                     
             
             
                 
                     
                 
                         
 
                          
                                                     
                    
                           
 

/**
 * Which deploys failed and how long each took to restore. A deploy fails when its own status is a
 * failure, a revert lands for a commit it shipped, a hotfix or rollback lands next, or an incident
 * opens after it, each within the failure window.
 */
export function failures(db              , deploys             , windowMs        )                       {
  const out = new Map                 ();
  const sorted = [...deploys].sort((a, b) => a.at - b.at);
  const before = (t        ) => {
    let found                   = null;
    for (const d of sorted) if (d.at < t) found = d;
    return found;
  };
  for (const [i, d] of sorted.entries())
    if (d.status === "failure") {
      const next = sorted.slice(i + 1).find((n) => n.status === "success");
      out.set(d.id, { cause: "status", by: next?.id ?? null, restoreMs: next ? next.at - d.at : null });
    }
  const fixes = db
    .prepare("select sha, at, subject, revert_of from commits where landed = 1 and (revert_of is not null or subject is not null) order by at")
    .all()                                                                            ;
  for (const c of fixes) {
    let target                   = null;
    let cause                          = null;
    if (c.revert_of && c.revert_of !== "?") {
      const reverted = db.prepare("select at from commits where sha like ? || '%'").get(c.revert_of)                              ;
      if (reverted) {
        target = sorted.find((d) => d.at >= reverted.at && d.at < c.at) ?? null;
        cause = "revert";
      }
    } else if (c.revert_of === "?" || isHotfix(c.subject)) {
      target = before(c.at);
      cause = c.revert_of === "?" ? "revert" : "hotfix";
    }
    if (target && cause && c.at - target.at <= windowMs && !out.has(target.id))
      out.set(target.id, { cause, by: c.sha, restoreMs: c.at - target.at });
  }
  const incidents = db.prepare("select id, opened_at, resolved_at from incidents order by opened_at").all()                                                                   ;
  for (const inc of incidents) {
    const target = before(inc.opened_at);
    if (target && inc.opened_at - target.at <= windowMs && !out.has(target.id))
      out.set(target.id, { cause: "incident", by: inc.id, restoreMs: inc.resolved_at != null ? inc.resolved_at - inc.opened_at : null });
  }
  return out;
}

/** DORA ranges are about weeks, not hours: the hour and today read the last seven days. */
export const doraRange = (r       )        => (r === "1h" || r === "today" ? "7d" : r);

export function dora(db              , range       , now        , cfg           ) {
  const used = doraRange(range);
  const source = cfg.deploy.startsWith("gh") ? "gh" : "git";
  const all = db.prepare("select id, at, source, sha, status, lead_ms from deploys where source = ? order by at").all(source)                          ;
  const failed = failures(db, all, cfg.failureWindowHours * HOUR);
  const from = used === "all" ? (all[0]?.at ?? now) : since(used, now);
  const inRange = all.filter((d) => d.at >= from && d.at <= now);
  const days = Math.max(1, (now - from) / DAY);
  const leads = inRange.map((d) => d.lead_ms).filter((v)              => v != null);
  const fails = inRange.filter((d) => failed.has(d.id));
  const restores = fails.map((d) => failed.get(d.id) .restoreMs).filter((v)              => v != null);
  const perDay = inRange.length ? inRange.length / days : 0;
  const rate = inRange.length ? fails.length / inRange.length : null;
  const leadP50 = percentile(leads, 50);
  const restoreP50 = percentile(restores, 50);
  const weeks                                                                              = [];
  for (let w = Math.max(from, now - 26 * WEEK); w < now; w += WEEK) {
    const ds = inRange.filter((d) => d.at >= w && d.at < w + WEEK);
    weeks.push({
      week: w,
      deploys: ds.length,
      failed: ds.filter((d) => failed.has(d.id)).length,
      leadP50: percentile(ds.map((d) => d.lead_ms).filter((v)              => v != null), 50),
    });
  }
  const sha = (s               ) => (s ? s.slice(0, 10) : null);
  return {
    range: used,
    source,
    rule: cfg.deploy,
    deploys: inRange.length,
    frequency: { perDay, perWeek: perDay * 7, band: inRange.length ? bandOf.frequency(perDay) : null },
    leadTime: { p50: leadP50, p90: percentile(leads, 90), samples: leads.length, band: bandOf.leadTime(leadP50) },
    failureRate: { rate, failed: fails.length, band: bandOf.failureRate(rate) },
    restore: { p50: restoreP50, samples: restores.length, band: bandOf.restore(restoreP50) },
    weeks,
    leadHistogram: histogram(leads),
    recent: inRange
      .slice(-40)
      .reverse()
      .map((d) => {
        const f = failed.get(d.id);
        const c = d.sha ? (db.prepare("select subject, ai from commits where sha = ?").get(d.sha)                                               ) : undefined;
        return { id: d.id, at: d.at, sha: sha(d.sha), status: d.status, leadMs: d.lead_ms, subject: c?.subject ?? null, ai: !!c?.ai, failed: f ?? null };
      }),
    ci: ciSummary(db, from, now),
  };
}

const BUCKETS                     = [
  ["< 1 h", HOUR],
  ["< 1 day", DAY],
  ["< 1 week", WEEK],
  ["< 1 month", 30 * DAY],
  ["longer", Infinity],
];
/** Lead times in DORA-friendly buckets. */
export function histogram(values          ) {
  return BUCKETS.map(([label, max], i) => ({
    label,
    count: values.filter((v) => v < max && v >= (i ? BUCKETS[i - 1] [1] : 0)).length,
  }));
}

/** CI runs from GitHub (when read): pass rate, duration and the workflows that fail most. */
export function ciSummary(db              , from        , now        ) {
  const rows = db
    .prepare("select workflow, at, duration_ms, conclusion from ci_runs where at >= ? and at <= ? order by at")
    .all(from, now)                                                                                      ;
  const done = rows.filter((r) => ["success", "failure", "cancelled", "timed_out"].includes(r.conclusion));
  const by = new Map                                                                                 ();
  for (const r of done) {
    const w = by.get(r.workflow) ?? { workflow: r.workflow, runs: 0, failed: 0, durations: [] };
    w.runs++;
    if (r.conclusion !== "success") w.failed++;
    if (r.duration_ms != null) w.durations.push(r.duration_ms);
    by.set(r.workflow, w);
  }
  const passed = done.filter((r) => r.conclusion === "success").length;
  return {
    runs: done.length,
    passRate: done.length ? passed / done.length : null,
    p50: percentile(done.map((r) => r.duration_ms).filter((v)              => v != null), 50),
    workflows: [...by.values()]
      .map((w) => ({ workflow: w.workflow, runs: w.runs, failed: w.failed, p50: percentile(w.durations, 50) }))
      .sort((a, b) => b.failed - a.failed || b.runs - a.runs),
  };
}
