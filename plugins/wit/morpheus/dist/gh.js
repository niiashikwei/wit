/**
 * GitHub data through the `gh` CLI, only when the project opts in (`"gh": true` in
 * `.claude/wit.json`): CI workflow runs, deployments and incident issues. This is Wit's only
 * network access, and it goes through `gh`, with the user's own login and nothing else. Read at
 * most every ten minutes; a missing or signed-out `gh` is skipped silently.
 */
import { execFileSync } from "node:child_process";
                                                
                                             
import { stmt } from "./ingest.js";
import { getMeta, setMeta } from "./store.js";

                                                                    

export const ghRunner         = (args, cwd) => {
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  } catch {
    return null;
  }
};

export const GH_EVERY_MS = 10 * 60_000;

const parse = (text               )        => {
  try {
    const v = JSON.parse(text ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const time = (v         ) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : null;
};

/** Reads GitHub when opted in and due. Returns how many records it stored (0 when skipped). */
export function ingestGh(db              , root        , cfg           , now        , run         = ghRunner)         {
  if (!cfg.gh) return 0;
  const lastAt = Number(getMeta(db, "gh:at") ?? 0);
  if (now - lastAt < GH_EVERY_MS) return 0;
  setMeta(db, "gh:at", String(now));
  const gh = (args          ) => run(args, root);
  let n = 0;
  const runs = parse(gh(["run", "list", "--limit", "300", "--json", "databaseId,workflowName,createdAt,updatedAt,conclusion,headSha,headBranch,event,status"]));
  const putRun = stmt(db, "insert or replace into ci_runs (id, workflow, at, duration_ms, conclusion, sha, branch, event) values (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of runs) {
    const at = time(r.createdAt);
    if (at == null || r.databaseId == null) continue;
    const end = time(r.updatedAt);
    putRun.run(String(r.databaseId), String(r.workflowName ?? ""), at, end != null && r.status === "completed" ? Math.max(0, end - at) : null,
      r.status === "completed" ? String(r.conclusion ?? "") : String(r.status ?? "running"), r.headSha ?? null, r.headBranch ?? null, r.event ?? null);
    n++;
  }
  const putDeploy = stmt(db, "insert or replace into deploys (id, at, source, sha, status, lead_ms) values (?, ?, 'gh', ?, ?, ?)");
  if (cfg.deploy === "gh-deployments") {
    db.exec("delete from deploys where source = 'gh'");
    for (const d of parse(gh(["api", "repos/{owner}/{repo}/deployments?per_page=100"])).slice(0, 100)) {
      const at = time(d.created_at);
      if (at == null || d.id == null) continue;
      const st = parse(gh(["api", `repos/{owner}/{repo}/deployments/${d.id}/statuses?per_page=1`]))[0];
      putDeploy.run(`gh:${d.id}`, at, d.sha ?? null, normaliseStatus(st?.state), leadFor(db, d.sha, at));
      n++;
    }
  } else if (cfg.deploy.startsWith("gh-workflow:")) {
    db.exec("delete from deploys where source = 'gh'");
    const name = cfg.deploy.slice("gh-workflow:".length);
    for (const r of runs) {
      const at = time(r.updatedAt) ?? time(r.createdAt);
      if (r.workflowName !== name || r.status !== "completed" || at == null) continue;
      putDeploy.run(`gh:run:${r.databaseId}`, at, r.headSha ?? null, normaliseStatus(r.conclusion), leadFor(db, r.headSha, at));
      n++;
    }
  }
  const putIncident = stmt(db, "insert or replace into incidents (id, opened_at, resolved_at, source) values (?, ?, ?, 'gh')");
  for (const i of parse(gh(["issue", "list", "--label", cfg.incidentLabel, "--state", "all", "--limit", "200", "--json", "number,createdAt,closedAt"]))) {
    const opened = time(i.createdAt);
    if (opened == null || i.number == null) continue;
    putIncident.run(`gh:${i.number}`, opened, time(i.closedAt));
    n++;
  }
  return n;
}

/** GitHub's many words for how a deploy went, as success, failure or pending. */
export function normaliseStatus(s         )         {
  const v = String(s ?? "").toLowerCase();
  if (["success", "inactive", "completed"].includes(v)) return "success";
  if (["failure", "error", "failed", "cancelled", "timed_out", "startup_failure"].includes(v)) return "failure";
  return "pending";
}

/** A deploy's lead time from the commit it shipped, when git knows that commit. */
function leadFor(db              , sha         , at        )                {
  if (typeof sha !== "string") return null;
  const c = db.prepare("select coalesce(lead_from, authored_at) as t from commits where sha = ?").get(sha)                             ;
  return c ? Math.max(0, at - c.t) : null;
}
