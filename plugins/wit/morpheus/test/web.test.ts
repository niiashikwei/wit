import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bundle, inlinePage, MODULES } from "../scripts/inline.ts";
import { hbars, histogram, legend, lineChart, niceMax, pyramid, ring, seriesVar, sparkline, squarify, stackedBars, treemap } from "../web/src/charts.js";
import {
  bandStatus, covStatus, esc, fmtAgo, fmtBytes, fmtDate, fmtDay, fmtMoney, fmtMs, fmtNum, fmtPct, fmtUnit, pill,
} from "../web/src/format.js";
import {
  categoryColor, renderAI, renderDelivery, renderHealth, renderQuality, renderResources, renderTests, renderTokens, tabFromHash, TABS,
} from "../web/src/views.js";

const WEB = join(import.meta.dirname, "..", "web");
const has = (html: string, ...parts: string[]) => {
  for (const p of parts) assert.ok(html.includes(p), `expected ${JSON.stringify(p)} in output`);
};

// @req R44
test("numbers, times, sizes, money and dates are formatted for people; HTML is escaped", () => {
  assert.equal(esc(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(esc(null), "");
  assert.deepEqual([null, NaN, 5, 1500, 15_000, 120_000, 2 * 3_600_000, 20 * 3_600_000, 2 * 86_400_000, 20 * 86_400_000].map(fmtMs), ["–", "–", "5 ms", "1.5 s", "15 s", "2 min", "2.0 h", "20 h", "2.0 d", "20 d"]);
  assert.deepEqual([null, 2e9, 3.4e6, 45_000, 1500, 12, 3.14159, 42.5, -2e6].map(fmtNum), ["–", "2.0B", "3.4M", "45k", "1.5k", "12", "3.14", "42.5", "-2.0M"]);
  assert.deepEqual([fmtPct(null), fmtPct(0.123), fmtPct(0.1234, 1)], ["–", "12%", "12.3%"]);
  assert.deepEqual([null, 500, 2048, 5 * 1024 ** 2, 300 * 1024 ** 3, 5 * 1024 ** 5].map(fmtBytes), ["–", "500 B", "2.0 KB", "5.0 MB", "300 GB", "5120 TB"]);
  assert.deepEqual([null, 0, 0.001, 3.456, 1234.5].map(fmtMoney), ["–", "$0", "<$0.01", "$3.46", "$1,235"]);
  const now = 10 * 86_400_000;
  assert.deepEqual([null, now - 5000, now - 300_000, now - 7_200_000, now - 3 * 86_400_000, now + 5000].map((t) => fmtAgo(t, now)), ["never", "5 s ago", "5 min ago", "2 h ago", "3 d ago", "0 s ago"]);
  assert.ok(fmtAgo(Date.now()).endsWith("ago"));
  assert.equal(fmtDate(new Date(2026, 0, 5).getTime()), "2026-01-05");
  assert.deepEqual([fmtDay("2026-11-03"), fmtDay("odd")], ["11/3", "odd"]);
  assert.deepEqual([fmtUnit(null, "pct"), fmtUnit("x", "pct"), fmtUnit(0.05, "pct"), fmtUnit(0.5, "pct"), fmtUnit(0, "pct"), fmtUnit(60_000, "ms"), fmtUnit(14, "perWeek"), fmtUnit(3, "perWeek"), fmtUnit(0.333, "ratio"), fmtUnit(5, "count")], ["–", "x", "5.0%", "50%", "0%", "1 min", "2.0/day", "3.0/wk", "0.33", "5"]);
  assert.deepEqual(["elite", "high", "medium", "low", null].map(bandStatus), ["good", "good", "warn", "bad", "unknown"]);
  assert.deepEqual([0.9, 0.7, 0.1, null].map(covStatus), ["good", "warn", "bad", "unknown"]);
  has(pill("good"), "p-good", "✓", "Good");
  has(pill("weird", "x"), "p-weird", "–", "x");
  has(pill("weird"), "weird");
});

// @req R44
test("charts are SVG strings with themed colours, axes, tooltips and empty states", () => {
  assert.equal(seriesVar(0), "var(--s1)");
  assert.equal(seriesVar(20), "var(--s8)", "never cycles past eight");
  assert.deepEqual([0, -1, 7, 15, 23, 40, 99, 101].map(niceMax), [1, 1, 10, 20, 25, 50, 100, 200]);
  has(legend([{ label: "a" }, { label: "b", color: "red" }]), "var(--s1)", "red", ">a<");
  const bars = stackedBars([{ label: "d1", values: { a: 2, b: 0 } }, { label: "d2", values: { a: 1, b: 3 } }, { label: "d3", values: {} }], ["a", "b"], { keyLabel: (k: string) => k.toUpperCase(), label: "L" });
  has(bars, "<svg", 'aria-label="L"', 'data-tip="d2 · B: 3"', ">d1<");
  has(stackedBars([], ["a"]), "<svg", 'aria-label="Bar chart"');
  has(stackedBars(Array.from({ length: 30 }, (_, i) => ({ label: `x${i}`, values: { a: i } })), ["a"], { fmt: (v: number) => `${v}!`, color: () => "red", width: 300, height: 100 }), "red", "!");
  has(lineChart([], { empty: "Nothing" }), "Nothing");
  has(lineChart([]), "No samples yet.");
  const one = lineChart([{ label: "x", points: [{ at: 5, v: 2 }] }]);
  has(one, 'r="4"', "x ·");
  const many = lineChart([{ label: "a", points: Array.from({ length: 130 }, (_, i) => ({ at: i * 1000, v: i })) }, { label: "b", color: "blue", points: [{ at: 0, v: 500 }, { at: 1000, v: 1 }] }], { fmt: (v: number) => `${v}u`, max: 100, xLabel: (t: number) => `t${t}`, label: "M", from: 0, to: 129_000, width: 400, height: 100 });
  has(many, "polyline", "blue", "t0", "t129000", 'aria-label="M"');
  assert.equal(sparkline([1]), "");
  has(sparkline([1, null, 3, 2], { color: "green", width: 50, height: 10 }), "green", "polyline");
  has(sparkline([5, 5]), "var(--s1)");
  has(sparkline([0, 0]), "polyline");
  const h = histogram([{ label: "< 1 h", count: 3 }, { label: "longer", count: 0 }], { color: "pink", label: "H", width: 200, height: 100 });
  has(h, "pink", 'aria-label="H"', ">3<", "&lt; 1 h");
  has(histogram([]), "Histogram");
});

// @req R39 R44
test("the pyramid draws layers sized by their share and coloured by coverage, each one clickable", () => {
  const svg = pyramid([{ key: "unit", tests: 80, coverage: 0.9, status: "good" }, { key: "integration", tests: 15, coverage: null, status: "unknown" }, { key: "custom", tests: 5 }], { width: 500 });
  has(svg, 'data-path="unit"', "b-good", "Unit", "80 tests · 84% · 90% covered", "no coverage data", 'data-path="e2e"', "End-to-end", "0 tests · 0%");
  has(pyramid([]), "0 tests");
  has(pyramid([{ key: "e2e", label: "E", tests: 0 }]), 'data-path="e2e"');
});

// @req R39 R44
test("a squarified treemap tiles the area by value; small cells drop their labels", () => {
  const cells = squarify([{ value: 6 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 2 }, { value: 1 }, { value: 0 }], 0, 0, 600, 400);
  assert.equal(cells.length, 7);
  const area = cells.reduce((s, c) => s + c.w * c.h, 0);
  assert.ok(Math.abs(area - 600 * 400) < 1);
  assert.deepEqual(squarify([], 0, 0, 10, 10), []);
  assert.deepEqual(squarify([{ value: 1 }], 0, 0, 0, 10), []);
  assert.equal(squarify([{ value: 1 }, { value: 1 }], 0, 0, 10, 100).length, 2, "a tall area stacks rows");
  const svg = treemap([{ key: "a", label: "a/very/long/module/name/that/needs/cutting", value: 10, status: "good", sub: "10 tests" }, { key: "b", label: "b", value: 1 }], { width: 300, height: 200, label: "T" });
  has(svg, 'aria-label="T"', "b-good", "…", "10 tests", 'data-tip="b: 1"', "b-unknown");
  has(treemap([]), "Treemap");
  has(treemap([{ key: "k", label: "short", value: 5 }], { width: 300, height: 200 }), ">short<", ">5<");
});

// @req R43 R44
test("the score ring and horizontal bars show state in words and numbers, not colour alone", () => {
  has(ring(92, { label: "Health" }), "r-good", ">92<", "Health 92 of 100");
  has(ring(60), "r-warn");
  has(ring(10), "r-bad");
  has(ring(150), ">100<");
  has(ring(null), "r-unknown", ">–<", "not measured");
  const hb = hbars([{ label: "x", value: 2, sub: "two", action: "category", path: "x" }, { label: "y", value: 1, color: "red" }], { colorIndex: 2 });
  has(hb, 'data-action="category"', "two", "red", "var(--s3)", ">1<");
  has(hbars([{ label: "z", value: 0.5 }], { fmt: fmtPct }), "50%");
  has(hbars([{ label: "plain", value: 3 }]), "var(--s1)");
  has(hbars([{ label: "self", value: 3, action: "category" }]), 'data-path="self"');
});

// @req R44
test("tabs come from the URL hash, with the old #live link opening the hooks and agents tab", () => {
  assert.deepEqual(TABS.map((t) => t.key), ["health", "delivery", "tests", "tokens", "ai", "quality", "resources", "process"]);
  assert.equal(tabFromHash("#tests"), "tests");
  assert.equal(tabFromHash("#tests/unit"), "tests");
  assert.equal(tabFromHash("#live"), "process");
  assert.equal(tabFromHash(""), "health");
  assert.equal(tabFromHash(undefined), "health");
  assert.equal(tabFromHash("#nope"), "health");
  assert.equal(categoryColor("feature"), "var(--s1)");
  assert.equal(categoryColor("chore"), "var(--muted)");
  assert.equal(categoryColor("unheard-of"), "var(--muted)");
});

const band = (b: string | null) => b;
const doraData = (over: Record<string, unknown> = {}) => ({
  range: "30d", source: "git", rule: "main", deploys: 3,
  frequency: { perDay: 0.1, perWeek: 0.7, band: band("high") },
  leadTime: { p50: 3_600_000, p90: 7_200_000, samples: 3, band: band("elite") },
  failureRate: { rate: 1 / 3, failed: 1, band: band("low") },
  restore: { p50: 1_800_000, samples: 1, band: band("elite") },
  weeks: [{ week: 0, deploys: 1, failed: 0, leadP50: 10 }, { week: 7 * 86_400_000, deploys: 2, failed: 1, leadP50: 20 }],
  leadHistogram: [{ label: "< 1 h", count: 1 }],
  recent: [
    { id: "git:a", at: 1, sha: "abcdef1234", status: "success", leadMs: 10, subject: "Add <x>", ai: true, failed: null },
    { id: "git:b", at: 2, sha: null, status: "success", leadMs: null, subject: null, ai: false, failed: { cause: "revert", by: "c", restoreMs: 5000 } },
    { id: "git:c", at: 3, sha: "c", status: "pending", leadMs: null, subject: "x", ai: false, failed: null },
    { id: "git:d", at: 4, sha: "d", status: "success", leadMs: null, subject: "y", ai: false, failed: { cause: "incident", by: "i", restoreMs: null } },
  ],
  ci: { runs: 10, passRate: 0.95, p50: 60_000, workflows: [{ workflow: "tests", runs: 8, failed: 1, p50: 50_000 }, { workflow: "none", runs: 0, failed: 0, p50: null }] },
  ...over,
});

// @req R36 R44
test("the delivery tab shows the four DORA metrics, weekly deploys, lead times, CI and recent deploys", () => {
  const html = renderDelivery(doraData());
  has(html, "Deployment frequency", "0.7/wk", "High · 3 deploys", "Lead time for changes", "Change failure rate", "33%", "Time to restore", "rule <code>main</code>", "Deploys per week", "Lead time distribution", "Runs passing", "95%", "tests", "Recent deploys", "abcdef1234", "Add &lt;x&gt;", "t-ai", "revert · fixed in 5.0 s", "pending", "incident");
  const warnCi = renderDelivery(doraData({ ci: { runs: 4, passRate: 0.8, p50: null, workflows: [] } }));
  has(warnCi, "kpi warn");
  const badCi = renderDelivery(doraData({ ci: { runs: 4, passRate: 0.5, p50: null, workflows: [] } }));
  has(badCi, "kpi bad");
  const empty = renderDelivery(doraData({ deploys: 0, source: "gh", recent: [], ci: { runs: 0, passRate: null, p50: null, workflows: [] }, frequency: { perDay: 0, perWeek: 0, band: null } }));
  has(empty, "GitHub", "No deploys in this range.", '"gh": true', "–");
  has(renderDelivery(null), "Waiting");
});

const node = (key: string, tests: number, over: Record<string, unknown> = {}) => ({
  key, label: key, level: "layer", tests, passed: tests, failed: 0, skipped: 0, notRun: 0, flaky: 0, durationMs: 10,
  coverage: { lines: 0.9, branches: 0.5, linesTotal: 10, linesHit: 9, branchesTotal: 2, branchesHit: 1 }, coverageScope: "tested code", ...over,
});
const testsData = (over: Record<string, unknown> = {}) => {
  const kids = [node("unit", 8), node("integration", 2, { failed: 1, coverage: null, coverageScope: null }), node("e2e", 0, { coverage: { lines: 0.5, branches: null, linesTotal: 2, linesHit: 1, branchesTotal: 0, branchesHit: 0 } })];
  const top = { ...node("", 10), label: "All tests", level: "pyramid", children: kids };
  return {
    grouping: "layer", path: [], levels: ["layer", "module", "file", "suite", "test"], node: top, pyramid: top,
    history: { runs: [{ at: 1, tests: 10, failed: 1 }, { at: 2, tests: 11, failed: 0 }], coverage: [{ at: 1, lines: 0.8 }, { at: 2, lines: null }] },
    slowest: [{ name: "slow", durationMs: 900 }], flaky: [{ name: "wobbly", file: "a.py" }], failing: [{ name: "broken", file: "b.py" }],
    reports: [{ path: "junit.xml", framework: "junit", versions: 2, at: Date.now(), layer: null }, { path: "int.info", framework: "lcov", versions: 1, at: Date.now(), layer: "integration" }],
    ...over,
  };
};

// @req R39 R44
test("the tests tab draws the pyramid, then treemaps and tables as you zoom in, down to single tests", () => {
  const top = renderTests(testsData());
  has(top, "By layer", 'aria-pressed="true"', "Pyramid", "Testing pyramid by layer", "8 passed", "Shape", "Pyramid", "80% unit tests", "Line coverage", "Tests and failures", "slow", "broken", "wobbly", "junit.xml", "integration layer", "50% branches");
  const inverted = testsData({ pyramid: { ...testsData().pyramid, children: [node("unit", 1), node("e2e", 9)] } });
  has(renderTests(inverted), "Inverted");
  const modules = { ...node("unit", 8), level: "layer", children: [node("src/api", 6, { level: "module" }), node("src/empty", 0, { level: "module" }), node("lib", 2, { level: "module", coverage: null })] };
  const mod = renderTests(testsData({ path: ["unit"], node: modules }));
  has(mod, "Unit</button>", "Tests by module", 'data-path="unit|src/api"', "src/api", "no cov.");
  const leafNode = { ...node("t", 2), children: [
    { ...node("test_a", 1), leaf: { file: "a.py", line: 3, suite: null, status: "passed", durationMs: 4, flaky: true, tags: ["R1"] } },
    { ...node("test_b", 1), leaf: { file: "a.py", line: 0, suite: null, status: "failed", durationMs: null, flaky: false, tags: [] } },
    { ...node("test_c", 1), leaf: { file: "a.py", line: 9, suite: null, status: "skipped", durationMs: null, flaky: false, tags: [] } },
    { ...node("test_d", 1), leaf: { file: "a.py", line: 10, suite: null, status: null, durationMs: null, flaky: false, tags: [] } },
  ] };
  const leaf = renderTests(testsData({ path: ["unit", "tests", "tests/a.py", "(no class)"], node: leafNode }));
  has(leaf, "test_a", "flaky", ">R1<", "p-bad", "skipped", "not run");
  const feature = renderTests(testsData({ grouping: "feature", levels: ["feature", "file", "suite", "test"], node: { ...node("", 3), children: [node("Login", 3)] } }));
  has(feature, "All features", 'data-path="Login"');
  has(renderTests(testsData({ grouping: "feature", levels: ["feature", "file", "suite", "test"], path: ["Login"], node: { ...node("Login", 3), children: [node("a.py", 3)] } })), ">Login</button>");
  // A layer name the page doesn't know is shown as it is; a node with nothing under it shows no rows.
  const odd = renderTests(testsData({ path: ["smoke"], node: { ...node("smoke", 2, { failed: 1, flaky: 2, coverageScope: null }), children: undefined } }));
  has(odd, ">smoke</button>", "kpi bad", "kpi warn");
  const custom = renderTests(testsData({ node: { ...testsData().node, children: [node("custom", 1, { coverageScope: null })] } }));
  has(custom, "<span>custom</span>");
  const single = renderTests(testsData({ path: ["unit", "m"], node: { ...node("m", 1), children: [node("only.py", 1)] } }));
  assert.ok(!single.includes("Tests by"), "one child: no treemap");
  const empty = renderTests(testsData({ node: { ...node("", 0), coverage: null, failed: 0, children: [node("unit", 0), node("integration", 0), node("e2e", 0)] }, pyramid: { ...node("", 0), children: [] }, slowest: [], flaky: [], failing: [], reports: [], history: { runs: [], coverage: [] } }));
  has(empty, "no coverage report", "Needs JUnit results", "None in the latest results.", "No coverage reports read yet.");
  has(renderTests(null), "Waiting");
});

const tasksData = (over: Record<string, unknown> = {}) => ({
  totals: { tasks: 2, tokensNew: 3000, tokensCached: 9000, cost: 1.5, perTask: 1500, costPerTask: 0.75, cacheHit: 0.75, corrected: 1 },
  byCategory: [{ category: "bugfix", tasks: 1, tokensNew: 2000, cost: 1, durationMs: 1000, corrected: 1, toolErrors: 1, toolCalls: 4 }, { category: "chore", tasks: 1, tokensNew: 1000, cost: 0.5, durationMs: 500, corrected: 0, toolErrors: 0, toolCalls: 0 }],
  byModel: [{ model: "claude-opus-5-5", tokensNew: 3000, cost: 1.5 }],
  days: [{ day: "2026-11-01", bugfix: 2000 }, { day: "2026-11-02", chore: 1000 }],
  list: [
    { at: 1, category: "bugfix", prompt: "fix <it>", toolCalls: 4, toolErrors: 1, agents: 1, skills: ["tdd"], models: { "claude-opus-5-5": 2000 }, files: ["a.ts"], corrected: true, tokensNew: 2000, tokensCached: 6000, cost: 1, durationMs: 1000 },
    { at: 2, category: "chore", prompt: "ok", toolCalls: 0, toolErrors: 0, agents: 0, skills: [], models: {}, files: [], corrected: false, tokensNew: 1000, tokensCached: 3000, cost: 0.5, durationMs: 500 },
  ],
  count: 2,
  ...over,
});

// @req R40 R44
test("the tokens tab shows totals, tokens per day by category, by category and model, and each task", () => {
  const html = renderTokens(tasksData(), { sort: "cost", category: "bugfix" });
  has(html, "New tokens", "3.0k", "Cached reads", "$1.50", "New tokens per day by category", "bugfix", "claude-opus-5-5", 'data-path="cost" aria-pressed="true"', "in bugfix", 'data-action="category" data-path=""', "fix &lt;it&gt;", "skills: tdd", "<code>a.ts</code>", "corrected next", "skills: none");
  has(renderTokens(tasksData()), 'data-path="tokens" aria-pressed="true"');
  const none = renderTokens(tasksData({ totals: { tasks: 0, tokensNew: 0, tokensCached: 0, cost: 0, perTask: null, costPerTask: null, cacheHit: null, corrected: 0 }, byCategory: [], byModel: [], days: [], list: [], count: 0 }));
  has(none, "No tasks in this range.", "No tasks.");
  const warn = renderTokens(tasksData({ totals: { ...tasksData().totals, tasks: 2, corrected: 1 } }));
  has(warn, "kpi warn");
  const good = renderTokens(tasksData({ totals: { ...tasksData().totals, tasks: 20, corrected: 1 } }));
  has(good, "kpi good");
  has(renderTokens(null), "Waiting");
});

const qualityData = (over: Record<string, unknown> = {}) => ({
  range: "30d", commits: 10,
  ai: { commits: 6, share: 0.6, linesAdded: 500, lineShare: 0.7 },
  rework: { ai: { added: 500, reworked: 25, rate: 0.05 }, human: { added: 100, reworked: 10, rate: 0.1 } },
  efficiency: { tokensNew: 1e6, cost: 20, tokensPerCommit: 160_000, costPerCommit: 3.3, tokensPerLine: 2000, cacheHit: 0.9 },
  process: { sessions: 4, compactions: 1, compactionsPerSession: 0.25, denials: 2, interrupts: 1, corrections: 1, correctionRate: 0.05, toolCalls: 100, toolErrorRate: 0.02 },
  tests: { all: { test: 100, src: 150, ratio: 0.67 }, ai: { test: 60, src: 100, ratio: 0.6 } },
  hotspots: [{ path: "src/a.ts", commits: 5, churn: 300, lines: 400, aiCommits: 3 }],
  changedCoverage: { files: 5, measured: 3, lines: 0.75, lowest: [{ path: "a.ts", lines: 0.5, linesTotal: 10 }, { path: "b.ts", lines: 0.7, linesTotal: 10 }, { path: "c.ts", lines: 0.9, linesTotal: 10 }] },
  weeks: [{ week: 0, commits: 3, aiCommits: 2, tokens: 10 }],
  ...over,
});

// @req R42 R44
test("the AI effectiveness tab shows how much Claude writes, what sticks, what it costs and how often you step in", () => {
  const html = renderAI(qualityData(), tasksData());
  has(html, "AI co-authored commits", "60%", "5.0%", "others: 10.0%", "Tokens per AI commit", "160k", "Cache hit rate", "Corrections", "Interrupts", "Permission denials", "0.25", "Commits per week", "Co-Authored-By", "By task category", "bugfix", "kpi good");
  const bad = renderAI(qualityData({
    rework: { ai: { added: 10, reworked: 5, rate: 0.5 }, human: { added: 0, reworked: 0, rate: null } },
    efficiency: { tokensNew: 0, cost: 0, tokensPerCommit: null, costPerCommit: null, tokensPerLine: null, cacheHit: 0.3 },
    process: { sessions: 1, compactions: 3, compactionsPerSession: 3, denials: 0, interrupts: 0, corrections: null, correctionRate: 0.5, toolCalls: 10, toolErrorRate: 0.2 },
  }), { byCategory: [] });
  has(bad, "kpi bad", "kpi warn", "5 of 10 lines", "No tasks in this range.");
  const mid = renderAI(qualityData({ rework: { ai: { added: 10, reworked: 1.5, rate: 0.15 }, human: { added: 0, reworked: 0, rate: null } } }), null);
  has(mid, "kpi warn");
  const none = renderAI(qualityData({
    rework: { ai: { added: 0, reworked: 0, rate: null }, human: { added: 0, reworked: 0, rate: null } },
    efficiency: { tokensNew: 0, cost: 0, tokensPerCommit: null, costPerCommit: null, tokensPerLine: null, cacheHit: null },
    process: { sessions: 0, compactions: 0, compactionsPerSession: null, denials: 0, interrupts: 0, corrections: null, correctionRate: null, toolCalls: 0, toolErrorRate: null },
  }), undefined);
  has(none, "–");
  has(renderAI(null), "Waiting");
});

// @req R42 R44
test("the quality tab shows coverage of changed code, test-to-code ratio, tool errors and hotspots", () => {
  const html = renderQuality(qualityData());
  has(html, "Changed code covered", "75%", "3 of 5 changed files", "Test lines per code line", "0.67", "0.60", "Hotspots", "src/a.ts", "a.ts", "var(--miss)", "var(--part)", "var(--ok)");
  has(renderQuality(qualityData({ tests: { all: { test: 10, src: 30, ratio: 0.33 }, ai: { test: 0, src: 0, ratio: null } } })), "kpi warn");
  has(renderQuality(qualityData({ tests: { all: { test: 1, src: 30, ratio: 0.03 }, ai: { test: 0, src: 0, ratio: null } } })), "kpi bad");
  const empty = renderQuality(qualityData({ tests: { all: { test: 0, src: 0, ratio: null }, ai: { test: 0, src: 0, ratio: null } }, hotspots: [], changedCoverage: { files: 0, measured: 0, lines: null, lowest: [] } }));
  has(empty, "No commits in this range.", "Needs a coverage report");
  has(renderQuality(null), "Waiting");
});

const resData = (over: Record<string, unknown> = {}) => ({
  sampledAt: Date.now() - 2000,
  machine: { cores: 8, memTotal: 16 * 1024 ** 3, diskTotal: 1000, now: { cpu: 42.4, rss: 8 * 1024 ** 3 }, diskFree: 50 },
  now: { claude: { cpu: 5, rss: 300 * 1024 ** 2, procs: 3 }, mcp: null, hook: null, tools: { cpu: 80, rss: 2 * 1024 ** 3, procs: 4 }, wit: { cpu: 1, rss: 90 * 1024 ** 2, procs: 1 } },
  peak: { claude: 400 * 1024 ** 2, mcp: 0, hook: 0, tools: 3 * 1024 ** 3, wit: 100 * 1024 ** 2 },
  cpu: { claude: [{ at: 1, v: 5 }], tools: [{ at: 1, v: 80 }], machine: [{ at: 1, v: 42 }] },
  memory: { claude: [{ at: 1, v: 1 }], mcp: [{ at: 1, v: 0 }], tools: [{ at: 1, v: 2 }], machine: [{ at: 1, v: 3 }] },
  disk: { at: Date.now(), latest: { project: 900, dependencies: 500, git: 0 }, series: {}, freeSeries: [] },
  commands: {
    test: { runs: 4, failed: 3, p50: 2000, p95: 9000, totalMs: 20000 },
    build: { runs: 0, failed: 0, p50: null, p95: null, totalMs: 0 },
    recent: [{ kind: "test", command: "npm test", durationMs: 2000, outcome: "error", peakRss: 1024, at: Date.now() }, { kind: "build", command: "tsc", durationMs: 100, outcome: "ok", peakRss: null, at: Date.now() }],
  },
  ...over,
});

// @req R41 R44
test("the resources tab shows each process group, the machine, memory and CPU over time, disk and command runs", () => {
  const html = renderResources(resData());
  has(html, "Claude Code", "300 MB", "Commands it ran", "not running", "Machine", "42% load", "Free disk", "kpi bad", "Memory", "CPU", "Whole machine", "Disk footprint", "project", "Test runs (median)", "kpi warn", "npm test", "peak 1.0 KB");
  has(renderResources(resData({ machine: { cores: 8, memTotal: 1, diskTotal: 1000, now: null, diskFree: 150 } })), "kpi warn");
  const roomy = renderResources(resData({ machine: { cores: 8, memTotal: 1, diskTotal: 1000, now: null, diskFree: 900 }, memory: { hook: [{ at: 1, v: 5 }] }, cpu: {} }));
  has(roomy, "Hooks", "of 1000 B");
  const bare = renderResources(resData({ machine: { now: null, diskFree: null }, disk: { at: null, latest: {}, series: {}, freeSeries: [] }, commands: { test: { runs: 0, failed: 0, p50: null, p95: null, totalMs: 0 }, build: { runs: 0, failed: 0, p50: null, p95: null, totalMs: 0 }, recent: [] } }));
  has(bare, "Not measured yet.", "?");
  has(renderResources(null), "Waiting");
});

const healthData = (over: Record<string, unknown> = {}) => ({
  score: 85, measured: 7,
  stages: [
    { key: "plan", label: "Plan", question: "Q?", status: "good", metrics: [{ label: "Corrected", value: 0.05, unit: "pct", target: "≤ 10%", status: "good" }], hint: null },
    { key: "build", label: "Build", question: "Q2?", status: "unknown", metrics: [{ label: "CI", value: null, unit: "pct", target: "≥ 90%", status: "unknown" }], hint: "Turn on <gh>" },
  ],
  dora: { deploys: 4, frequency: { perWeek: 14, band: "elite" }, leadTime: { p50: 1000, band: "elite" }, failureRate: { rate: 0, band: "elite" }, restore: { p50: null, band: null }, weeks: [{ deploys: 1, leadP50: 5 }, { deploys: 3, leadP50: 2 }] },
  tokens: { tasks: 3, perTask: 1000, cost: 2, costPerTask: 0.66, cacheHit: 0.8 },
  ai: { share: 0.5, commits: 2 },
  pyramid: { tests: 10, failed: 0, coverage: { lines: 0.9 } },
  improvements: [{ title: "Time your hooks", roi: 12, how: "run init" }],
  ...over,
});

// @req R43 R44
test("the health tab shows the score, DORA tiles with trends, each stage with its targets, and next improvements", () => {
  const html = renderHealth(healthData());
  has(html, "SDLC health", "Healthy", "7 of 2 stages", "2.0/day", "DORA Elite", "spark", "no data yet", "Plan", "target ≤ 10%", "Turn on &lt;gh&gt;", "Next improvements", "Time your hooks", "90% lines covered", "kpi good");
  has(renderHealth(healthData({ score: 60 })), "Some stages need a look");
  has(renderHealth(healthData({ score: 20 })), "Several stages need attention");
  const none = renderHealth(healthData({ score: null, improvements: [], dora: { deploys: 0, frequency: { perWeek: 0, band: null }, leadTime: { p50: null, band: null }, failureRate: { rate: null, band: null }, restore: { p50: null, band: null } }, tokens: { tasks: 0, perTask: null, cost: 0, costPerTask: null, cacheHit: 0.5 }, pyramid: { tests: 3, failed: 1, coverage: null } }));
  has(none, "Not enough data yet", "no coverage report", "kpi bad", "kpi warn");
  assert.ok(!none.includes("Next improvements"));
  has(renderHealth(healthData({ tokens: { tasks: 0, perTask: null, cost: 0, costPerTask: null, cacheHit: null }, improvements: undefined })), "SDLC health");
  has(renderHealth(null), "Waiting");
});

// @req R44
test("the page is built from its modules into one file, with each module's exports on W", () => {
  const files: Record<string, string> = { "a.js": 'import { y } from "./b.js";\nexport function f() { return y; }\nexport const g = 1;\nexport async function h() {}\nexport class K {}', "b.js": "export let y = 2;\nconst hidden = 3;" };
  const js = bundle((f) => files[f]!, ["a.js", "b.js"]);
  assert.ok(!js.includes("import "));
  assert.ok(js.includes("return { f, g, h, K, y };"));
  const W = new Function(`${js}; return W;`)();
  assert.equal(W.f(), 2);
  assert.equal(W.hidden, undefined);
  const page = inlinePage("<p>x</p><!-- @inline lib -->", () => 'export const s = "</script>";');
  assert.ok(page.includes("<\\/script>"));
  assert.throws(() => inlinePage("<p>no marker</p>", () => ""), /marker/);
  assert.deepEqual(MODULES, ["format.js", "charts.js", "views.js"]);
  // The committed page is what the build makes from web/src.
  const built = inlinePage(readFileSync(join(WEB, "src", "shell.html"), "utf8"), (f) => readFileSync(join(WEB, "src", f), "utf8"));
  assert.equal(readFileSync(join(WEB, "dashboard.html"), "utf8"), built, "run npm run build");
  for (const t of TABS) assert.ok(built.includes(`data-tab="${t.key}"`), t.key);
});

// @req R45
test("the test script fails below 99% line, branch and function coverage", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "package.json"), "utf8"));
  for (const k of ["lines", "branches", "functions"]) assert.ok(pkg.scripts.test.includes(`--test-coverage-${k}=99`), k);
  assert.ok(pkg.scripts.test.includes("web/src/**"));
});
