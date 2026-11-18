// One renderer per dashboard tab: data from Morpheus's tools in, HTML out. No DOM access here, so
// every view can be tested with plain data. Interactive bits carry data-action attributes that
// the page wires up: drill, crumb, group, sort, category, tab.
import { hbars, histogram, legend, lineChart, pyramid, ring, sparkline, stackedBars, treemap } from "./charts.js";
import {
  BAND_LABEL, bandStatus, covStatus, esc, fmtAgo, fmtBytes, fmtClock, fmtDate, fmtDay, fmtMoney, fmtMs, fmtNum, fmtPct, fmtUnit, fmtUntil, pill,
} from "./format.js";

/** Task categories in a fixed colour order; the last two share the muted "other" colour. */
export const CATEGORY_ORDER = ["feature", "bugfix", "test", "refactor", "docs", "ops", "review", "explore", "status", "approve", "chore", "interrupt"];
export const categoryColor = (c) => {
  const i = CATEGORY_ORDER.indexOf(c);
  return i >= 0 && i < 8 ? `var(--s${i + 1})` : "var(--muted)";
};
export const SCOPE_ORDER = ["claude", "mcp", "hook", "tools", "wit"];
export const SCOPE_LABEL = { claude: "Claude Code", mcp: "MCP servers", hook: "Hooks", tools: "Commands it ran", wit: "Wit", machine: "Whole machine" };
const scopeColor = (s) => (s === "machine" ? "var(--muted)" : `var(--s${SCOPE_ORDER.indexOf(s) + 1})`);

const tile = (label, value, sub = "", status = null, extra = "") =>
  `<div class="kpi${status ? ` ${status}` : ""}"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}${extra}</div>`;
const section = (eyebrow, title, body, note = "") =>
  `<section><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2>${note ? `<p class="note">${note}</p>` : ""}${body}</section>`;
const empty = (text) => `<div class="notice"><p>${text}</p></div>`;

// ---------- Health ----------
export function renderHealth(d) {
  if (!d) return empty("Waiting for the first numbers…");
  const stages = d.stages
    .map(
      (s) => `<article class="stage s-${esc(s.status)}">
      <header><h3>${esc(s.label)}</h3>${pill(s.status)}</header>
      <p class="q">${esc(s.question)}</p>
      <ul>${s.metrics.map((m) => `<li><span>${esc(m.label)}</span><b>${esc(fmtUnit(m.value, m.unit))}</b><small>target ${esc(m.target)}</small></li>`).join("")}</ul>
      ${s.hint ? `<p class="hint">${esc(s.hint)}</p>` : ""}
    </article>`,
    )
    .join("");
  const dora = d.dora;
  const doraTile = (label, value, band, trend = []) =>
    `<button type="button" class="kpi kbtn ${bandStatus(band)}" data-action="tab" data-path="delivery"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(band ? `DORA ${BAND_LABEL[band]}` : "no data yet")}</small>${sparkline(trend)}</button>`;
  const p = d.pyramid;
  const improvements = (d.improvements ?? [])
    .map((i) => `<li><b>${esc(i.title)}</b><span class="meta"> · ROI ${esc(i.roi)}</span><br><span class="meta">${esc(i.how)}</span></li>`)
    .join("");
  return `<div class="hero">${ring(d.score, { label: "SDLC health" })}<div><div class="eyebrow">SDLC health · ${d.measured} of ${d.stages.length} stages measured</div><h2>${d.score == null ? "Not enough data yet" : d.score >= 80 ? "Healthy" : d.score >= 50 ? "Some stages need a look" : "Several stages need attention"}</h2><p class="note">Each stage is as healthy as its worst measured number. Stages with no data say how to turn them on.</p></div></div>
  <div class="kpis">
    ${doraTile("Deploys", dora.deploys ? fmtUnit(dora.frequency.perWeek, "perWeek") : "–", dora.frequency.band, (dora.weeks ?? []).map((w) => w.deploys))}
    ${doraTile("Lead time", fmtMs(dora.leadTime.p50), dora.leadTime.band, (dora.weeks ?? []).map((w) => w.leadP50))}
    ${doraTile("Change failure rate", fmtPct(dora.failureRate.rate), dora.failureRate.band)}
    ${doraTile("Time to restore", fmtMs(dora.restore.p50), dora.restore.band)}
  </div>
  <div class="stages">${stages}</div>
  <div class="kpis">
    ${tile("Tasks", fmtNum(d.tokens.tasks), `${fmtNum(d.tokens.perTask)} new tokens each`)}
    ${tile("Estimated cost", fmtMoney(d.tokens.cost), `${fmtMoney(d.tokens.costPerTask)} a task`)}
    ${tile("Cache hit rate", fmtPct(d.tokens.cacheHit), "of input read from cache", d.tokens.cacheHit == null ? null : d.tokens.cacheHit >= 0.7 ? "good" : "warn")}
    ${tile("AI co-authored commits", fmtPct(d.ai.share), `${fmtNum(d.ai.commits)} commits`)}
    ${tile("Tests", fmtNum(p.tests), p.coverage ? `${fmtPct(p.coverage.lines)} lines covered` : "no coverage report", p.failed ? "bad" : null)}
  </div>
  ${improvements ? section("Ranked by return on effort", "Next improvements to your Claude Code setup", `<ol class="imps">${improvements}</ol>`) : ""}`;
}

// ---------- Delivery ----------
// The pipeline Claude runs on this machine (tests, checks, builds in the background), and what a
// deploy costs in Claude usage.
function renderPipeline(d) {
  const pl = d.pipeline;
  if (!pl) return "";
  const perDeploy = d.cost?.perDeploy ?? null;
  const rows = pl.steps
    .map((s) => `<tr><td><code>${esc(s.step)}</code>${s.label ? `<br><small class="meta">${esc(s.label)}</small>` : ""}</td><td class="num">${s.runs}</td><td class="num">${s.failed ? pill(s.failed / s.runs >= 0.2 ? "bad" : "warn", String(s.failed)) : "0"}</td><td class="num">${s.stopped}</td><td class="num">${esc(fmtMs(s.p50))}</td><td class="num">${esc(s.lostMs ? fmtMs(s.lostMs) : "–")}</td></tr>`)
    .join("");
  const tiles = `<div class="kpis">
    ${tile("Background runs", fmtNum(pl.runs), `${fmtMs(pl.ms)} of commands Claude ran on its own`)}
    ${tile("Runs failing", fmtPct(pl.failRate), `${pl.failed} failed · ${pl.stopped} stopped by hand`, pl.failRate == null ? null : pl.failRate <= 0.05 ? "good" : pl.failRate <= 0.15 ? "warn" : "bad")}
    ${tile("Time in failed runs", pl.lostMs ? fmtMs(pl.lostMs) : "–", "runs that had to be done again", pl.lostMs ? "warn" : null)}
    ${tile("Claude cost per deploy", perDeploy == null ? "–" : fmtMoney(perDeploy), `${fmtMoney(d.cost?.total ?? 0)} over ${d.deploys} deploys`)}
  </div>`;
  return section(
    "Tests, checks and builds Claude ran in the background",
    "Local pipeline",
    `${tiles}${rows ? `<div class="ltbl"><table><thead><tr><th>Step</th><th class="num">Runs</th><th class="num">Failed</th><th class="num">Stopped</th><th class="num">Usual time</th><th class="num">Time in failed runs</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty("No background commands in this range. Steps appear when Claude runs tests, checks or builds with <code>run_in_background</code>.")}`,
    "Many projects' real pipeline runs here, before anything reaches CI. Steps are grouped by what the command does; the ones that fail most are listed first.",
  );
}

export function renderDelivery(d) {
  if (!d) return empty("Waiting for the first numbers…");
  const weeks = d.weeks.map((w) => ({ label: fmtDay(fmtDate(w.week)), values: { ok: w.deploys - w.failed, failed: w.failed } }));
  const ci = d.ci;
  const recent = d.recent
    .map(
      (r) => `<tr><td>${esc(fmtDate(r.at))}</td><td class="mono">${esc(r.sha ?? r.id)}</td><td>${esc(r.subject ?? "")}${r.ai ? ' <span class="tag t-ai">AI</span>' : ""}</td><td class="num">${esc(fmtMs(r.leadMs))}</td><td>${r.failed ? pill("bad", `${r.failed.cause}${r.failed.restoreMs != null ? ` · fixed in ${fmtMs(r.failed.restoreMs)}` : ""}`) : r.status === "pending" ? pill("unknown", "pending") : pill("good", "ok")}</td></tr>`,
    )
    .join("");
  const card = (label, value, band, sub) =>
    `<div class="kpi ${bandStatus(band)}"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(band ? `${BAND_LABEL[band]} · ${sub}` : sub)}</small></div>`;
  return `<div class="kpis">
    ${card("Deployment frequency", d.deploys ? fmtUnit(d.frequency.perWeek, "perWeek") : "–", d.frequency.band, `${d.deploys} deploys`)}
    ${card("Lead time for changes", fmtMs(d.leadTime.p50), d.leadTime.band, `p90 ${fmtMs(d.leadTime.p90)}`)}
    ${card("Change failure rate", fmtPct(d.failureRate.rate), d.failureRate.band, `${d.failureRate.failed} failed`)}
    ${card("Time to restore", fmtMs(d.restore.p50), d.restore.band, `${d.restore.samples} restores`)}
  </div>
  <p class="note">Deploys come from <b>${esc(d.source === "gh" ? "GitHub" : "git")}</b> (rule <code>${esc(d.rule)}</code>${d.ruleDetected ? `, picked from this project's tags and branches: set <code>"deploy"</code> in <code>.claude/wit.json</code> to choose` : ""}, over ${esc(d.range)}). A deploy fails when a revert of its change, a hotfix or rollback, a failed status or an incident follows it. Bands follow the DORA State of DevOps thresholds.</p>
  ${section("Per week", "Deploys", `${legend([{ label: "succeeded", color: "var(--s1)" }, { label: "failed", color: "var(--s8)" }])}<div class="chart">${stackedBars(weeks, ["ok", "failed"], { label: "Deploys per week", color: (k) => (k === "ok" ? "var(--s1)" : "var(--s8)"), keyLabel: (k) => (k === "ok" ? "succeeded" : "failed") })}</div>`)}
  <div class="grid2">
    ${section("Distribution", "Lead time for changes", `<div class="chart">${histogram(d.leadHistogram, { label: "Lead time distribution" })}</div>`)}
    ${section("GitHub Actions", "CI", ci.runs ? `<div class="kpis">${tile("Runs passing", fmtPct(ci.passRate), `${ci.runs} runs`, ci.passRate >= 0.9 ? "good" : ci.passRate >= 0.75 ? "warn" : "bad")}${tile("Median run", fmtMs(ci.p50))}</div>${hbars(ci.workflows.slice(0, 6).map((w) => ({ label: w.workflow, value: w.runs ? w.failed / w.runs : 0, sub: `${w.failed}/${w.runs} failed · p50 ${fmtMs(w.p50)}`, color: "var(--s8)" })), { fmt: fmtPct })}` : empty('No CI runs read. Add <code>"gh": true</code> to <code>.claude/wit.json</code> to read GitHub Actions with the <code>gh</code> CLI.'))}
  </div>
  ${renderPipeline(d)}
  ${section("Newest first", "Recent deploys", d.recent.length ? `<div class="ltbl"><table><thead><tr><th>When</th><th>Change</th><th>What</th><th class="num">Lead time</th><th>Result</th></tr></thead><tbody>${recent}</tbody></table></div>` : empty("No deploys in this range."))}`;
}

// ---------- Tests ----------
const LAYER_NAME = { unit: "Unit", integration: "Integration", e2e: "End-to-end" };
const nodeStatus = (n) => (n.failed ? "bad" : covStatus(n.coverage?.lines ?? null));
const covText = (n) => (n.coverage ? `${fmtPct(n.coverage.lines)} lines${n.coverage.branches != null ? ` · ${fmtPct(n.coverage.branches)} branches` : ""}` : "–");

export function renderTests(d, state = {}) {
  if (!d) return empty("Waiting for the first numbers…");
  const grouping = d.grouping;
  const n = d.node;
  const top = d.pyramid;
  const crumbs = [`<button type="button" class="crumb" data-action="crumb" data-path="">${grouping === "feature" ? "All features" : "Pyramid"}</button>`]
    .concat(d.path.map((seg, i) => `<button type="button" class="crumb" data-action="crumb" data-path="${esc(d.path.slice(0, i + 1).join("|"))}">${esc(i === 0 && grouping === "layer" ? (LAYER_NAME[seg] ?? seg) : seg)}</button>`))
    .join('<span aria-hidden="true">›</span>');
  const level = d.levels[d.path.length];
  const kids = n.children ?? [];
  const pathOf = (k) => [...d.path, k].join("|");
  let body;
  if (!d.path.length && grouping === "layer")
    body = `<div class="pyr-wrap"><div class="chart">${pyramid(kids.map((c) => ({ key: c.key, tests: c.tests, coverage: c.coverage?.lines ?? null, status: nodeStatus(c) })))}</div>
      <div class="pyr-side">${kids.map((c) => `<button type="button" class="kpi kbtn ${nodeStatus(c)}" data-action="drill" data-path="${esc(c.key)}"><span>${esc(LAYER_NAME[c.key] ?? c.key)}</span><b>${fmtNum(c.tests)}</b><small>${esc(`${covText(c)}${c.coverageScope ? ` (${c.coverageScope})` : ""}`)}</small><small>${esc(`${c.passed} passed · ${c.failed} failed · ${c.notRun} not run`)}</small></button>`).join("")}</div></div>`;
  else if (level === "test")
    body = `<div class="ltbl"><table><thead><tr><th>Test</th><th>Line</th><th>Result</th><th class="num">Time</th><th>Tags</th></tr></thead><tbody>${kids.map((c) => `<tr><td>${esc(c.label)}${c.leaf.flaky ? ' <span class="tag t-warn">flaky</span>' : ""}</td><td class="mono">${c.leaf.line || "–"}</td><td>${c.leaf.status ? pill(c.leaf.status === "passed" ? "good" : c.leaf.status === "failed" ? "bad" : "unknown", c.leaf.status) : pill("unknown", "not run")}</td><td class="num">${esc(fmtMs(c.leaf.durationMs))}</td><td>${c.leaf.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</td></tr>`).join("")}</tbody></table></div>`;
  else
    body = `${kids.length > 1 ? `<div class="chart">${treemap(kids.filter((c) => c.tests).slice(0, 60).map((c) => ({ key: pathOf(c.key), label: c.label, value: c.tests, status: nodeStatus(c), sub: `${c.tests} tests · ${c.coverage ? fmtPct(c.coverage.lines) : "no cov."}`, tip: `${c.label}: ${c.tests} tests, ${covText(c)}` })), { label: `Tests by ${level}` })}</div>` : ""}
    <div class="ltbl"><table><thead><tr><th>${esc(level)}</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Not run</th><th class="num">Flaky</th><th>Coverage</th><th class="num">Time</th></tr></thead><tbody>${kids.map((c) => `<tr data-action="drill" data-path="${esc(pathOf(c.key))}" tabindex="0"><td>${esc(c.label)}</td><td class="num">${c.tests}</td><td class="num">${c.passed}</td><td class="num">${c.failed}</td><td class="num">${c.notRun}</td><td class="num">${c.flaky}</td><td>${esc(covText(c))}</td><td class="num">${esc(fmtMs(c.durationMs))}</td></tr>`).join("")}</tbody></table></div>`;
  const hist = d.history;
  const cov = hist.coverage.map((c) => ({ at: c.at, v: c.lines ?? 0 }));
  const unit = top.children?.find((c) => c.key === "unit")?.tests ?? 0;
  const shape = top.tests ? (unit / top.tests >= 0.5 ? "pyramid" : "inverted") : null;
  return `<div class="bar"><div class="seg" role="group" aria-label="Group tests by"><button type="button" data-action="group" data-path="layer" aria-pressed="${grouping === "layer"}">By layer</button><button type="button" data-action="group" data-path="feature" aria-pressed="${grouping === "feature"}">By feature</button></div><nav class="crumbs" aria-label="Where you are">${crumbs}</nav></div>
  <div class="kpis">
    ${tile("Tests here", fmtNum(n.tests), `${n.passed} passed · ${n.failed} failed · ${n.skipped} skipped`, n.failed ? "bad" : null)}
    ${tile("Coverage", n.coverage ? fmtPct(n.coverage.lines) : "–", n.coverage ? `${fmtNum(n.coverage.linesHit)}/${fmtNum(n.coverage.linesTotal)} lines${n.coverageScope ? ` · ${n.coverageScope}` : ""}` : "no coverage report", covStatus(n.coverage?.lines ?? null))}
    ${tile("Branch coverage", n.coverage?.branches != null ? fmtPct(n.coverage.branches) : "–", n.coverage?.branchesTotal ? `${fmtNum(n.coverage.branchesHit)}/${fmtNum(n.coverage.branchesTotal)} branches` : "")}
    ${tile("Flaky", fmtNum(n.flaky), "passed and failed in recent runs", n.flaky ? "warn" : null)}
    ${tile("Time", fmtMs(n.durationMs), "latest results")}
    ${shape ? tile("Shape", shape === "pyramid" ? "Pyramid" : "Inverted", `${fmtPct(unit / top.tests)} unit tests`, shape === "pyramid" ? "good" : "warn") : ""}
  </div>
  ${body}
  <div class="grid2">
    ${section("Coverage over time", "Line coverage", `<div class="chart">${lineChart([{ label: "line coverage", points: cov }], { fmt: (v) => fmtPct(v), max: 1, xLabel: fmtDate, empty: "No coverage reports read yet." })}</div>`)}
    ${section("Each recorded run", "Tests and failures", `<div class="chart">${lineChart([{ label: "tests", points: hist.runs.map((r) => ({ at: r.at, v: r.tests })) }, { label: "failed", points: hist.runs.map((r) => ({ at: r.at, v: r.failed })), color: "var(--s8)" }], { xLabel: fmtDate, empty: "No JUnit results read yet." })}</div>`)}
  </div>
  <div class="grid2">
    ${section("Slowest", "Slowest tests", d.slowest.length ? hbars(d.slowest.map((t) => ({ label: t.name, value: t.durationMs, sub: fmtMs(t.durationMs) }))) : empty("Needs JUnit results with times."))}
    ${section("Unstable", "Failing and flaky", d.failing.length + d.flaky.length ? `<ul class="plain">${[...d.failing.map((t) => `<li>${pill("bad", "failing")} ${esc(t.name)} <span class="meta">${esc(t.file)}</span></li>`), ...d.flaky.map((t) => `<li>${pill("warn", "flaky")} ${esc(t.name)} <span class="meta">${esc(t.file)}</span></li>`)].join("")}</ul>` : empty("None in the latest results."))}
  </div>
  ${section("Sources", "Reports read", d.reports.length ? `<ul class="plain">${d.reports.map((r) => `<li><code>${esc(r.path)}</code> <span class="meta">${esc(r.framework)} · ${r.versions} versions · ${esc(fmtAgo(r.at))}${r.layer ? ` · ${esc(r.layer)} layer` : ""}</span></li>`).join("")}</ul>` : "", 'Tests are found in the source and joined with JUnit XML results; coverage comes from lcov, Cobertura, JaCoCo, coverage.py JSON, Istanbul JSON or Go profiles your test runs write. Layers come from folder and file conventions, or <code>"layers"</code> in <code>.claude/wit.json</code>.')}`;
}

// ---------- Tokens & cost ----------
/** Tasks listed before the Show more button. */
export const TASK_PAGE = 25;

export function renderTokens(d, state = {}) {
  if (!d) return empty("Waiting for the first numbers…");
  const t = d.totals;
  const cats = CATEGORY_ORDER.filter((c) => d.byCategory.some((b) => b.category === c));
  const days = d.days.map((x) => ({ label: fmtDay(x.day), values: Object.fromEntries(cats.map((c) => [c, x[c] ?? 0])) }));
  const sortBtn = (k, label) => `<button type="button" data-action="sort" data-path="${k}" aria-pressed="${(state.sort ?? "tokens") === k}">${label}</button>`;
  const shown = state.show ?? TASK_PAGE;
  const more = d.list.length - shown;
  const rows = d.list
    .slice(0, shown)
    .map(
      (x) => `<tr><td>${esc(new Date(x.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</td><td><span class="tag" style="border-left:3px solid ${categoryColor(x.category)}">${esc(x.category)}</span></td><td class="prompt"><details><summary>${esc(x.prompt)}</summary><div class="meta">${esc(`${x.toolCalls} tool calls (${x.toolErrors} failed) · ${x.agents} agents · skills: ${x.skills.join(", ") || "none"} · ${Object.entries(x.models).map(([m, v]) => `${m} ${fmtNum(v)}`).join(", ")}`)}</div>${x.files.length ? `<div class="meta">Edited: ${x.files.map((f) => `<code>${esc(f)}</code>`).join(" ")}</div>` : ""}</details>${x.corrected ? ' <span class="tag t-warn">corrected next</span>' : ""}</td><td class="num">${fmtNum(x.tokensNew)}</td><td class="num">${fmtNum(x.tokensCached)}</td><td class="num">${fmtMoney(x.cost)}</td><td class="num">${fmtMs(x.durationMs)}</td></tr>`,
    )
    .join("");
  return `<div class="kpis">
    ${tile("New tokens", fmtNum(t.tokensNew), `${fmtNum(t.tasks)} tasks`)}
    ${tile("Cached reads", fmtNum(t.tokensCached), `${fmtPct(t.cacheHit)} of input from cache`)}
    ${tile("Estimated cost", fmtMoney(t.cost), "list prices, an estimate")}
    ${tile("Per task", fmtNum(t.perTask), `${fmtMoney(t.costPerTask)} each`)}
    ${tile("Corrected tasks", fmtPct(t.tasks ? t.corrected / t.tasks : null), `${t.corrected} followed by a correction`, t.tasks ? (t.corrected / t.tasks <= 0.1 ? "good" : "warn") : null)}
  </div>
  ${section("New tokens per day, by task category", "Where the tokens go", cats.length ? `${legend(cats.map((c) => ({ label: c, color: categoryColor(c) })))}<div class="chart">${stackedBars(days, cats, { label: "New tokens per day by category", color: categoryColor })}</div>` : empty("No tasks in this range."))}
  <div class="grid2">
    ${section("Tokens and cost by task category", "By category", hbars(d.byCategory.map((c) => ({ label: c.category, value: c.tokensNew, sub: `${fmtNum(c.tokensNew)} · ${fmtMoney(c.cost)} · ${c.tasks} tasks · ${fmtNum(c.tokensNew / c.tasks)} each`, color: categoryColor(c.category), action: "category", path: c.category }))))}
    ${section("Every reply in range", "By model", hbars(d.byModel.map((m, i) => ({ label: m.model, value: m.tokensNew, sub: `${fmtNum(m.tokensNew)} · ${fmtMoney(m.cost)}`, color: `var(--s${(i % 8) + 1})` }))))}
  </div>
  ${(d.byBranch ?? []).length ? section("Every reply records its git branch: feature work costed whole, across prompts, sessions and agents", "By branch", `<div class="ltbl"><table><thead><tr><th>Branch</th><th class="num">Cost</th><th class="num">New tokens</th><th class="num">Cached reads</th><th class="num">Replies</th><th class="num">Sessions</th><th>Last active</th></tr></thead><tbody>${d.byBranch.map((b) => `<tr><td class="mono">${b.branch ? esc(b.branch) : '<span class="meta">no branch</span>'}</td><td class="num">${fmtMoney(b.cost)}</td><td class="num">${fmtNum(b.tokensNew)}</td><td class="num">${fmtNum(b.tokensCached)}</td><td class="num">${fmtNum(b.replies)}</td><td class="num">${b.sessions}</td><td>${esc(fmtDate(b.lastAt))}</td></tr>`).join("")}</tbody></table></div>`) : ""}
  ${section(`${d.count} tasks${state.category ? ` in ${state.category}` : ""} · a task is one prompt and everything it set off`, "Tasks", `<div class="bar"><div class="seg" role="group" aria-label="Sort tasks by">${sortBtn("tokens", "Tokens")}${sortBtn("cost", "Cost")}${sortBtn("duration", "Time")}${sortBtn("recent", "Newest")}</div>${state.category ? `<div class="scope"><button type="button" data-action="category" data-path="">${esc(state.category)}</button></div>` : ""}</div>${d.list.length ? `<div class="ltbl"><table><thead><tr><th>When</th><th>Category</th><th>Prompt</th><th class="num">New</th><th class="num">Cached</th><th class="num">Cost</th><th class="num">Time</th></tr></thead><tbody>${rows}</tbody></table></div>${more > 0 ? `<p><button type="button" class="btn" data-action="more-tasks">Show ${Math.min(more, TASK_PAGE)} more (${more} not shown)</button></p>` : ""}` : empty("No tasks.")}`)}`;
}

// ---------- AI effectiveness ----------
// How work flows between you, the main session and its agents.
function renderFlow(q) {
  const w = q.waiting;
  const o = q.orchestration;
  const rv = q.reviewers ?? [];
  if (!w || !o) return "";
  const tiles = `<div class="kpis">
    ${tile("Sessions waited on you", w.answered ? fmtMs(w.totalMs) : "–", `${w.blocking} questions, plans and go-aheads that stopped work`, w.slow >= 3 ? "warn" : null)}
    ${tile("Usual time to answer", fmtMs(w.p50), w.p90 == null ? "" : `slowest tenth over ${fmtMs(w.p90)}`, w.p90 == null ? null : w.p90 <= 15 * 60_000 ? "good" : "warn")}
    ${tile("Main session's share", fmtPct(o.mainShare), `${fmtMoney(o.main)} main · ${fmtMoney(o.agents)} agents`, o.mainShare == null || o.agents === 0 ? null : o.mainShare <= 0.6 ? "good" : "warn")}
    ${tile("Reviewers' catch rate", fmtPct(catchRate(rv)), `${rv.reduce((n, r) => n + r.changes, 0)} change requests in ${rv.reduce((n, r) => n + r.approved + r.changes, 0)} verdicts`)}
  </div>`;
  const sessions = o.sessions.length
    ? `<div class="ltbl"><table><thead><tr><th>Session</th><th class="num">Main</th><th class="num">Agents</th><th class="num">Main's share</th></tr></thead><tbody>${o.sessions.map((s) => `<tr><td>${esc(s.title ?? s.session.slice(0, 8))}</td><td class="num">${fmtMoney(s.main)}</td><td class="num">${fmtMoney(s.agents)}</td><td class="num">${fmtPct(s.mainShare)}</td></tr>`).join("")}</tbody></table></div>`
    : empty("No sessions started agents in this range.");
  const reviews = rv.length
    ? `<div class="ltbl"><table><thead><tr><th>Reviewer</th><th class="num">Runs</th><th class="num">Changes</th><th class="num">Catch rate</th><th class="num">Cost</th></tr></thead><tbody>${rv.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.runs}</td><td class="num">${r.changes}</td><td class="num">${r.catchRate == null ? pill("unknown", "no verdict") : fmtPct(r.catchRate)}</td><td class="num" title="${r.costPerCatch == null ? "" : `${fmtMoney(r.costPerCatch)} per change request`}">${fmtMoney(r.cost)}</td></tr>`).join("")}</tbody></table></div>`
    : empty("No review agents ran in this range.");
  return `${tiles}<div class="grid2">
    ${section("What the session you talk to costs next to its agents", "Main session and agents", sessions, "The main session plans, hands out work and reads results back; its context grows with every agent report. A high share means work agents could do on a cheaper model stays in the main thread.")}
    ${section("How often each reviewer finds something", "Reviewers", reviews, "Catch rate: change requests among verdicts; hover a cost for what each change request cost. A reviewer with no verdict line can't be counted; one that never asks for changes may not be worth its cost.")}
  </div>`;
}

const catchRate = (rv) => {
  const verdicts = rv.reduce((n, r) => n + r.approved + r.changes, 0);
  return verdicts ? rv.reduce((n, r) => n + r.changes, 0) / verdicts : null;
};

const bandLabel = (b) => (b.max == null ? `over ${fmtNum(b.min)}` : `${fmtNum(b.min)}–${fmtNum(b.max)}`);

/** Where the main session's money and time go in ways a change of habit can cut. */
export function renderLevers(l) {
  if (!l || !l.context.replies) return "";
  const c = l.context;
  const ci = l.ci;
  const hot = l.hooks.filter((h) => h.hot);
  const tiles = `<div class="kpis">
    ${tile("Context over 200k", fmtMoney(c.overCap), `${fmtPct(c.overCapShare)} of the main sessions' bill · ${fmtPct(c.heavyShare)} of replies`, c.overCapShare <= 0.15 ? "good" : c.overCapShare <= 0.35 ? "warn" : "bad")}
    ${tile("Watching CI and PRs", fmtMoney(ci.cost), `${fmtNum(ci.calls)} checks from the main session · ${fmtMoney(ci.perCall)} each`, ci.cost <= 5 ? "good" : ci.cost <= 50 ? "warn" : "bad")}
    ${tile("Hooks on every call", fmtMs(hot.reduce((s, h) => s + h.lostMs, 0)), hot.length ? `added by ${hot.map((h) => h.name).join(", ")}` : "no slow hook runs on every call", hot.length ? "warn" : "good")}
  </div>`;
  const bands = hbars(c.bands.filter((b) => b.replies).map((b) => ({ label: `${bandLabel(b)} tokens`, value: b.cost, sub: `${fmtMoney(b.cost)} · ${fmtNum(b.replies)} replies` })), { fmt: fmtMoney, colorIndex: 0 });
  const kinds = ci.kinds.length ? `<h3 class="sub">Checks on CI and PRs, by kind</h3>${hbars(ci.kinds.map((k) => ({ label: k.kind, value: k.cost, sub: `${fmtMoney(k.cost)} · ${fmtNum(k.calls)} checks` })), { fmt: fmtMoney, colorIndex: 2 })}` : "";
  const hooks = l.hooks.length ? `<h3 class="sub">Hooks that run most, by time added</h3><div class="ltbl"><table><thead><tr><th>Hook</th><th>Event</th><th class="num">Runs</th><th class="num">p50</th><th class="num">Added in all</th></tr></thead><tbody>${l.hooks.map((h) => `<tr><td>${esc(h.name)}${h.hot ? " · every call" : ""}</td><td>${esc(h.event ?? "–")}</td><td class="num">${fmtNum(h.runs)}</td><td class="num">${fmtMs(h.p50)}</td><td class="num">${fmtMs(h.lostMs)}</td></tr>`).join("")}</tbody></table></div>` : "";
  return section(
    "What would cut the bill and the waiting",
    "Cost levers",
    `${tiles}<h3 class="sub">Main-session cost by context carried per reply</h3>${bands}${kinds}${hooks}`,
    "Every reply re-reads the whole conversation from cache, so a reply at 800k tokens costs four times one at 200k. “Context over 200k” is the cache reads above that line: what starting fresh or compacting sooner would have saved. A check on CI from the main session is one more such reply; a background watcher reports once. Hook time is what each run took over 100 ms, about what a fast hook takes.",
  );
}

export function renderAI(q, tasks) {
  if (!q) return empty("Waiting for the first numbers…");
  const r = q.rework;
  const e = q.efficiency;
  const p = q.process;
  const weeks = q.weeks.map((w) => ({ label: fmtDay(fmtDate(w.week)), values: { ai: w.aiCommits, other: w.commits - w.aiCommits } }));
  const cats = (tasks?.byCategory ?? []).filter((c) => c.tasks);
  return `<div class="kpis">
    ${tile("AI co-authored commits", fmtPct(q.ai.share), `${q.ai.commits} of ${q.commits} commits · ${fmtPct(q.ai.lineShare)} of lines`)}
    ${tile("AI lines redone in 14 days", fmtPct(r.ai.rate, 1), r.human.rate != null ? `others: ${fmtPct(r.human.rate, 1)}` : `${fmtNum(r.ai.reworked)} of ${fmtNum(r.ai.added)} lines`, r.ai.rate == null ? null : r.ai.rate <= 0.1 ? "good" : r.ai.rate <= 0.2 ? "warn" : "bad")}
    ${tile("Tokens per AI commit", fmtNum(e.tokensPerCommit), `${fmtMoney(e.costPerCommit)} each`)}
    ${tile("Tokens per AI line", fmtNum(e.tokensPerLine), "new tokens ÷ lines added")}
    ${tile("Cache hit rate", fmtPct(e.cacheHit), "higher is cheaper", e.cacheHit == null ? null : e.cacheHit >= 0.7 ? "good" : "warn")}
  </div>
  <div class="kpis">
    ${tile("Context per reply", e.contextPerReply == null ? "–" : fmtNum(e.contextPerReply), "tokens re-read on every reply", e.contextPerReply == null ? null : e.contextPerReply <= 150_000 ? "good" : e.contextPerReply <= 300_000 ? "warn" : "bad")}
    ${tile("Re-reading context", fmtMoney(e.cacheReadCost), e.cacheReadShare == null ? "no cost yet" : `${fmtPct(e.cacheReadShare)} of the bill`, e.cacheReadShare == null ? null : e.cacheReadShare <= 0.5 ? "good" : "warn")}
    ${tile("Compactions", fmtNum(p.compactions), `in ${p.sessions} sessions · they shrink the context`)}
    ${e.reported ? tile("Cost Claude Code reports", fmtMoney(e.reported.cost), `${e.reported.sessions} session${e.reported.sessions === 1 ? "" : "s"}, whole life · Wit estimates ${fmtMoney(e.reported.estimate)}`) : ""}
    ${tile("API errors", fmtNum(p.apiErrors), "calls retried: the session stalled", p.apiErrors ? "warn" : null)}
    ${tile("Gone quiet", fmtNum(p.silentTurns), "turns Claude worked without a word", p.silentTurns ? "warn" : null)}
  </div>
  <div class="kpis">
    ${tile("Corrections", fmtPct(p.correctionRate), `${p.corrections ?? 0} prompts pushed back`, p.correctionRate == null ? null : p.correctionRate <= 0.1 ? "good" : "warn")}
    ${tile("Interrupts", fmtNum(p.interrupts), "you stopped Claude mid-task")}
    ${tile("Permission denials", fmtNum(p.denials), "tool calls you turned down")}
    ${tile("Hooks hold each prompt", p.hookWaitPerPrompt == null ? "–" : fmtMs(p.hookWaitPerPrompt), `${fmtMs(p.hookWaitMs)} waiting in all: before prompts, tool calls and turn ends`, p.hookWaitPerPrompt == null ? null : p.hookWaitPerPrompt <= 10_000 ? "good" : p.hookWaitPerPrompt <= 30_000 ? "warn" : "bad")}
    ${tile("Pull requests", fmtNum(p.prs), "opened or worked on in sessions")}
    ${tile("Tool calls failing", fmtPct(p.toolErrorRate, 1), `${fmtNum(p.toolCalls)} calls`, p.toolErrorRate == null ? null : p.toolErrorRate <= 0.05 ? "good" : "warn")}
  </div>
  ${renderFlow(q)}
  ${renderLevers(q.levers)}
  ${e.heavySessions.length ? section("Sessions carrying the most context", "Heavy sessions", `<div class="ltbl"><table><thead><tr><th>Session</th><th class="num">Replies</th><th class="num">Context per reply</th><th class="num">Re-reading cost</th><th class="num">All cost</th><th>Last active</th></tr></thead><tbody>${e.heavySessions.map((s) => `<tr><td class="mono">${esc(s.session.slice(0, 8))}</td><td class="num">${fmtNum(s.replies)}</td><td class="num">${fmtNum(s.contextPerReply)}</td><td class="num">${fmtMoney(s.cacheReadCost)}</td><td class="num">${fmtMoney(s.cost)}</td><td>${esc(fmtDate(s.lastAt))}</td></tr>`).join("")}</tbody></table></div>`, "Every reply re-reads the whole conversation, even from cache. Over 200k tokens a reply, handing separable work to a new session or compacting between features costs less and answers faster.") : ""}
  ${section("Commits per week", "How much Claude writes", `${legend([{ label: "Claude co-authored", color: "var(--s7)" }, { label: "other", color: "var(--s1)" }])}<div class="chart">${stackedBars(weeks, ["ai", "other"], { label: "Commits per week", color: (k) => (k === "ai" ? "var(--s7)" : "var(--s1)"), keyLabel: (k) => (k === "ai" ? "Claude co-authored" : "other") })}</div>`, "A commit counts as Claude's when it carries a <code>Co-Authored-By: Claude</code> trailer or Claude Code's footer. Redone lines: lines later commits removed from the same file within 14 days, at most the lines added (an estimate).")}
  ${section("Which kinds of work cost the most, and get corrected most", "By task category", cats.length ? `<div class="ltbl"><table><thead><tr><th>Category</th><th class="num">Tasks</th><th class="num">Tokens each</th><th class="num">Cost each</th><th class="num">Time each</th><th class="num">Corrected</th><th class="num">Tool errors</th></tr></thead><tbody>${cats.map((c) => `<tr><td><span class="tag" style="border-left:3px solid ${categoryColor(c.category)}">${esc(c.category)}</span></td><td class="num">${c.tasks}</td><td class="num">${fmtNum(c.tokensNew / c.tasks)}</td><td class="num">${fmtMoney(c.cost / c.tasks)}</td><td class="num">${fmtMs(c.durationMs / c.tasks)}</td><td class="num">${fmtPct(c.corrected / c.tasks)}</td><td class="num">${fmtPct(c.toolCalls ? c.toolErrors / c.toolCalls : null)}</td></tr>`).join("")}</tbody></table></div>` : empty("No tasks in this range."))}`;
}

// ---------- Status ----------
const ASK_LABEL = { question: "Question", plan: "Plan to approve", ask: "Go-ahead", api: "Sign-in" };
const KIND_LABEL = { command: "Command", agent: "Agent", monitor: "Monitor", ci: "CI", deploy: "Deploy" };
const STATE_PILL = { waiting: ["warn", "Waiting on you"], working: ["good", "Working"], idle: ["unknown", "Idle"] };
const who = (x) => esc(x.title ?? (x.session ? x.session.slice(0, 8) : "–"));

/** When a piece of work should finish, and how far along it is against the usual time. */
function finish(f, now) {
  if (f.eta == null) return { text: "no history yet", bar: "", status: null };
  const share = Math.min(1, (now - f.startedAt) / f.p90);
  const status = f.overdue ? "bad" : now > f.eta ? "warn" : "good";
  const text = f.overdue
    ? `overdue: usually done by ${fmtClock(f.startedAt + f.p90)}`
    : now > f.eta
      ? `running long: usually ${fmtMs(f.p50)}, done by ${fmtClock(f.startedAt + f.p90)} at the latest`
      : `about ${fmtClock(f.eta)} (${fmtUntil(f.eta, now)})`;
  const bar = `<span class="eta-bar" role="img" aria-label="${esc(`${Math.round(share * 100)}% of the usual time`)}"><i class="s-${status}" style="width:${(share * 100).toFixed(0)}%"></i></span>`;
  return { text, bar, status };
}

export function renderStatus(d, now = d?.now ?? Date.now()) {
  if (!d) return empty("Waiting for the first numbers…");
  const working = d.sessions.filter((s) => s.state === "working").length;
  const late = d.inFlight.filter((f) => f.overdue).length;
  return `<div class="kpis">
    ${tile("Waiting on you", fmtNum(d.waiting.length), d.waiting.length ? `oldest ${fmtAgo(Math.min(...d.waiting.map((w) => w.since)), now)}` : "nothing to answer", d.waiting.length ? "warn" : "good")}
    ${tile("Running now", fmtNum(d.inFlight.length), late ? `${late} running past the usual time` : "commands, agents, monitors and CI", late ? "bad" : null)}
    ${tile("Sessions working", fmtNum(working), `${d.sessions.length} active in the last day`)}
    ${tile("Finished lately", fmtNum(d.recent.length), `${d.recent.filter((r) => r.status !== "completed" && r.status !== "success").length} failed or stopped, last six hours`)}
  </div>
  ${section("Questions, plans and go-aheads with no answer yet", "Waiting on you", d.waiting.length
    ? `<ul class="asks">${d.waiting.map((w) => `<li>${pill(w.blocked ? "warn" : "unknown", ASK_LABEL[w.kind] ?? w.kind)} <b>${who(w)}</b> <span class="meta">${esc(fmtAgo(w.since, now))}${w.blocked ? " · the session is stopped until you answer" : ""}</span><p>${esc(w.text ?? "")}</p></li>`).join("")}</ul>`
    : empty("Nothing is waiting on you."))}
  ${section("Work running on its own, with when it should finish", "Running now", d.inFlight.length
    ? `<div class="ltbl"><table><thead><tr><th>What</th><th>Kind</th><th>Session</th><th>Started</th><th>Should finish</th></tr></thead><tbody>${d.inFlight.map((f) => {
        const e = finish(f, now);
        return `<tr><td>${esc(f.label ?? "–")}${f.detail ? `<div class="meta">${esc(f.detail)}</div>` : ""}</td><td><span class="tag">${esc(KIND_LABEL[f.kind] ?? f.kind)}</span></td><td>${f.session ? who(f) : '<span class="meta">GitHub</span>'}</td><td>${esc(fmtAgo(f.startedAt, now))}</td><td>${e.status ? pill(e.status, e.text) : `<span class="meta">${esc(e.text)}</span>`}${e.bar}${f.samples ? `<div class="meta">from ${f.samples} earlier runs</div>` : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`
    : empty("Nothing is running in the background."), `Finish times are the usual time for the same kind of work: the median of earlier runs, and the 90th percentile as the point it counts as overdue.${d.unreported ? ` ${d.unreported} older background ${d.unreported === 1 ? "job" : "jobs"} started in the last day never reported back (the app may have been quit) and ${d.unreported === 1 ? "is" : "are"} not listed.` : ""}`)}
  ${section("Active in the last day", "Sessions", d.sessions.length
    ? `<div class="ltbl"><table><thead><tr><th>Session</th><th>State</th><th>Branch</th><th>Your last prompt</th><th class="num">Running</th><th>Last active</th></tr></thead><tbody>${d.sessions.map((s) => {
        const [st, label] = STATE_PILL[s.state];
        return `<tr><td>${who(s)}${s.worktree ? `<div class="meta">worktree ${esc(s.worktree)}</div>` : ""}</td><td>${pill(st, label)}</td><td class="mono">${esc(s.branch ?? "–")}</td><td>${esc(s.prompt ?? "–")}${s.promptAt ? `<div class="meta">${esc(fmtAgo(s.promptAt, now))}</div>` : ""}</td><td class="num">${s.running}</td><td>${esc(fmtAgo(s.lastAt, now))}</td></tr>`;
      }).join("")}</tbody></table></div>`
    : empty("No session was active in the last day."))}
  <div class="grid2">
    ${section("Last six hours", "Finished lately", d.recent.length
      ? `<ul class="plain">${d.recent.map((r) => `<li>${pill(r.status === "completed" || r.status === "success" ? "good" : "bad", r.status)} <span class="tag">${esc(KIND_LABEL[r.kind] ?? r.kind)}</span> ${esc(r.label ?? "–")} <span class="meta">${r.durationMs != null ? `${esc(fmtMs(r.durationMs))} · ` : ""}${esc(fmtAgo(r.at, now))}</span></li>`).join("")}</ul>`
      : empty("Nothing finished in the last six hours."))}
    ${section("From monitors", "Latest updates", d.updates.length
      ? `<ul class="plain">${d.updates.map((u) => `<li><b>${esc(u.event)}</b> <span class="meta">${esc(u.label ?? "monitor")} · ${esc(fmtAgo(u.at, now))}</span></li>`).join("")}</ul>`
      : empty("No monitor events lately."))}
  </div>`;
}

// ---------- Quality ----------
export function renderQuality(q) {
  if (!q) return empty("Waiting for the first numbers…");
  const t = q.tests;
  const c = q.changedCoverage;
  return `<div class="kpis">
    ${tile("Changed code covered", fmtPct(c.lines), `${c.measured} of ${c.files} changed files measured`, covStatus(c.lines))}
    ${tile("Test lines per code line", t.all.ratio == null ? "–" : t.all.ratio.toFixed(2), `${fmtNum(t.all.test)} test · ${fmtNum(t.all.src)} code lines added`, t.all.ratio == null ? null : t.all.ratio >= 0.5 ? "good" : t.all.ratio >= 0.25 ? "warn" : "bad")}
    ${tile("…in AI commits", t.ai.ratio == null ? "–" : t.ai.ratio.toFixed(2), `${fmtNum(t.ai.test)} test · ${fmtNum(t.ai.src)} code`)}
    ${tile("Tool calls failing", fmtPct(q.process.toolErrorRate, 1), "edits, commands and reads that errored")}
  </div>
  <div class="grid2">
    ${section("Changed often, with the most churn", "Hotspots", q.hotspots.length ? `<div class="ltbl"><table><thead><tr><th>File</th><th class="num">Commits</th><th class="num">Churn</th><th class="num">Lines now</th><th class="num">By Claude</th></tr></thead><tbody>${q.hotspots.map((h) => `<tr><td class="mono">${esc(h.path)}</td><td class="num">${h.commits}</td><td class="num">${fmtNum(h.churn)}</td><td class="num">${fmtNum(h.lines)}</td><td class="num">${h.aiCommits}</td></tr>`).join("")}</tbody></table></div>` : empty("No commits in this range."))}
    ${section("Changed in this range, least covered first", "Coverage of changed code", c.lowest.length ? hbars(c.lowest.map((l) => ({ label: l.path, value: l.lines, sub: `${fmtPct(l.lines)} of ${fmtNum(l.linesTotal)} lines`, color: l.lines >= 0.8 ? "var(--ok)" : l.lines >= 0.6 ? "var(--part)" : "var(--miss)" })), { fmt: fmtPct }) : empty("Needs a coverage report that includes the files that changed."))}
  </div>`;
}

// ---------- Resources ----------
export function renderResources(d) {
  if (!d) return empty("Waiting for the first numbers…");
  const m = d.machine;
  const now = d.now;
  const scopes = SCOPE_ORDER.filter((s) => d.memory[s]?.some((p) => p.v > 0));
  const lines = (key, fmt) => {
    const series = [...scopes, "machine"].map((s) => ({ label: SCOPE_LABEL[s], points: d[key][s] ?? [], color: scopeColor(s) }));
    return `${legend(series.map((s) => ({ label: s.label, color: s.color })))}<div class="chart">${lineChart(series, { fmt, label: key })}</div>`;
  };
  const latest = d.disk.latest;
  const diskRows = Object.entries(latest).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const cmd = d.commands;
  const cmdTile = (label, k) => tile(label, fmtMs(k.p50), `${k.runs} runs · ${k.failed} failed · p95 ${fmtMs(k.p95)} · ${fmtMs(k.totalMs)} in all`, k.runs && k.failed / k.runs > 0.5 ? "warn" : null);
  return `<p class="note">Sampled ${esc(fmtAgo(d.sampledAt))}. CPU is percent of one core (so it can pass 100% on several); the machine line is load across all ${m.cores ?? "?"} cores.</p>
  <div class="kpis">
    ${SCOPE_ORDER.map((s) => tile(SCOPE_LABEL[s], now[s] ? fmtBytes(now[s].rss) : "–", now[s] ? `${now[s].cpu.toFixed(1)}% CPU · ${now[s].procs} processes · peak ${fmtBytes(d.peak[s])}` : "not running")).join("")}
    ${tile("Machine", m.now ? `${Math.round(m.now.cpu)}% load` : "–", m.now && m.memTotal ? `${fmtBytes(m.now.rss)} of ${fmtBytes(m.memTotal)} memory` : "")}
    ${tile("Free disk", fmtBytes(m.diskFree), m.diskTotal ? `of ${fmtBytes(m.diskTotal)}` : "", m.diskFree != null && m.diskTotal ? (m.diskFree / m.diskTotal < 0.1 ? "bad" : m.diskFree / m.diskTotal < 0.2 ? "warn" : null) : null)}
  </div>
  ${section("Resident memory", "Memory", lines("memory", fmtBytes))}
  ${section("Percent of one core", "CPU", lines("cpu", (v) => `${Math.round(v)}%`))}
  <div class="grid2">
    ${section(`Measured ${fmtAgo(d.disk.at)}`, "Disk footprint", (diskRows.length ? hbars(diskRows.map(([k, v], i) => ({ label: k, value: v, sub: fmtBytes(v), color: `var(--s${(i % 8) + 1})` })), { fmt: fmtBytes }) : empty("Not measured yet.")) + (d.disk.unmeasured?.length ? `<p class="meta">Too large to size quickly, tried again daily: ${d.disk.unmeasured.map(esc).join(", ")}</p>` : ""))}
    ${section("Commands Claude ran", "Test and build runs", `<div class="kpis">${cmdTile("Test runs (median)", cmd.test)}${cmdTile("Builds (median)", cmd.build)}</div>${cmd.recent.length ? `<ul class="plain">${cmd.recent.slice(0, 12).map((r) => `<li>${pill(r.outcome === "error" ? "bad" : "good", r.kind)} <code>${esc(r.command)}</code> <span class="meta">${esc(fmtMs(r.durationMs))}${r.peakRss ? ` · peak ${esc(fmtBytes(r.peakRss))}` : ""} · ${esc(fmtAgo(r.at))}</span></li>`).join("")}</ul>` : ""}`)}
  </div>`;
}

/** The dashboard's tabs, in order, with the tools each one reads. */
export const TABS = [
  { key: "status", label: "Status", tools: ["morpheus_status"] },
  { key: "health", label: "Health", tools: ["morpheus_health"] },
  { key: "delivery", label: "Delivery", tools: ["morpheus_dora"] },
  { key: "tests", label: "Tests", tools: ["morpheus_tests"] },
  { key: "tokens", label: "Tokens & cost", tools: ["morpheus_tasks"] },
  { key: "ai", label: "AI effectiveness", tools: ["morpheus_quality", "morpheus_tasks"] },
  { key: "quality", label: "Quality", tools: ["morpheus_quality"] },
  { key: "resources", label: "Resources", tools: ["morpheus_resources"] },
  { key: "process", label: "Hooks & agents", tools: [] },
];

/** The tab a URL hash names, else the first. */
export function tabFromHash(hash) {
  const k = String(hash ?? "").replace(/^#/, "").split("/")[0];
  return TABS.some((t) => t.key === k) ? k : k === "live" ? "process" : "status";
}
