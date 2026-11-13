/**
 * The project's testing pyramid: every test, found in the source (so it shows before any test
 * run) and joined with the latest JUnit results, sorted into unit, integration and end-to-end
 * layers, and grouped by layer → module → file → class → test, or by feature. Each group carries
 * its test count, results, time and the coverage of the code its tests target.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { matches, type WitConfig } from "./config.ts";
import { SKIP } from "./testreports.ts";

export const LAYERS = ["unit", "integration", "e2e"] as const;
export type Layer = (typeof LAYERS)[number];

export interface FoundTest {
  file: string;
  suite: string | null;
  name: string;
  line: number;
  tags: string[];
}

/** Test files by language convention. */
export const TEST_FILE =
  /(^|\/)(test_[^/]+\.py|[^/]+_test\.(py|go)|[^/]+\.(test|spec|e2e|cy|pw|int|integration)\.[cm]?[jt]sx?|[^/]+(Test|Tests|IT|Spec)\.(java|kt|scala|cs|swift)|[^/]+_spec\.rb|[^/]+_test\.(rb|exs|dart|rs))$/;
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright|integration)\//;

interface Lang {
  test: RegExp;
  suite?: RegExp;
}
/** How each language writes a test and a group of tests. Group 1 is the name. */
const LANGS: Record<string, Lang> = {
  py: { test: /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, suite: /^class\s+(\w+)/ },
  js: { test: /^\s*(?:it|test)(?:\.(?:only|concurrent|skip|todo|each\([^)]*\)))?\s*\(\s*(["'`])(.*?)\1/, suite: /^\s*describe(?:\.\w+)?\s*\(\s*(["'`])(.*?)\1/ },
  go: { test: /^func\s+(Test\w+)\s*\(/ },
  java: { test: /@(?:Test|ParameterizedTest|RepeatedTest)\b/, suite: /\bclass\s+(\w+)/ },
  rb: { test: /^\s*(?:it|scenario|specify)\s+(["'])(.*?)\1/, suite: /^\s*(?:describe|context)\s+["']?([^"'\s]+)/ },
  rs: { test: /#\[(?:tokio::)?test\]/ },
  cs: { test: /\[(?:Test|Fact|Theory|TestMethod)\]/, suite: /\bclass\s+(\w+)/ },
};
const LANG_OF: Record<string, string> = {
  ".py": "py", ".js": "js", ".jsx": "js", ".ts": "js", ".tsx": "js", ".mjs": "js", ".cjs": "js", ".mts": "js", ".cts": "js",
  ".go": "go", ".java": "java", ".kt": "java", ".scala": "java", ".rb": "rb", ".rs": "rs", ".cs": "cs",
};

/** The tests one file defines, with the requirement IDs or tags written just above each. */
export function findTests(file: string, text: string): FoundTest[] {
  const lang = LANGS[LANG_OF[extname(file)] ?? ""];
  if (!lang) return [];
  const out: FoundTest[] = [];
  const lines = text.split("\n");
  let suite: string | null = null;
  let pending = false;
  for (const [i, line] of lines.entries()) {
    const s = lang.suite?.exec(line);
    if (s) suite = s[2] ?? s[1]!;
    const m = lang.test.exec(line);
    if (!m) continue;
    let name = m[2] ?? m[1];
    if (!name) {
      // Attribute-style tests (Java @Test, Rust #[test], C# [Fact]): the next function's name.
      pending = true;
      for (let j = i + 1; j < Math.min(lines.length, i + 6) && pending; j++) {
        const fn = lines[j]!.match(/\b(?:fn|void|def|public|private|async\s+Task|Task)\s+(?:\w+\s+)*?(\w+)\s*\(/);
        if (fn) ((name = fn[1]!), (pending = false));
      }
      if (!name) continue;
    }
    out.push({ file, suite, name, line: i + 1, tags: tagsAbove(lines, i) });
  }
  return out;
}

/** Requirement IDs (R12) or @tags in the lines just above a test: `// @req R23`, `@req("R1")`. */
function tagsAbove(lines: string[], i: number): string[] {
  const tags = new Set<string>();
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
    const l = lines[j]!;
    if (!/@req|@tag|@feature|@pytest\.mark/.test(l)) break;
    for (const m of l.matchAll(/\bR\d{1,4}\b/g)) tags.add(m[0]);
    for (const m of l.matchAll(/@(?:feature|tag)\(?\s*["']?([\w-]+)/g)) tags.add(m[1]!);
  }
  return [...tags];
}

/** Every test file under the project, skipping dependencies, build output and worktrees. */
export function testFiles(root: string, max = 5000): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (out.length >= max || depth > 12) return;
    let names: string[];
    try {
      names = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (SKIP.has(n) || n === "dist" || n === "build" || n === "target" || n === "coverage" || (n.startsWith(".") && n !== ".github")) continue;
      const p = rel ? `${rel}/${n}` : n;
      let st;
      try {
        st = statSync(join(root, p));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (TEST_FILE.test(p) || (TEST_DIR.test(p) && /^test/i.test(n) && LANG_OF[extname(n)])) out.push(p);
    }
  };
  walk("", 0);
  return out;
}

/** Which layer a test belongs to: the project's globs first, then folder and file conventions. */
export function layerOf(file: string, cfg: Pick<WitConfig, "layers">): Layer {
  for (const l of LAYERS) if (cfg.layers[l] && matches(file, cfg.layers[l]!)) return l;
  for (const [l, globs] of Object.entries(cfg.layers)) if (!LAYERS.includes(l as Layer) && matches(file, globs)) return "integration";
  if (/(^|\/)(e2e|end-to-end|cypress|playwright|acceptance|ui-tests?|features|journeys)\//i.test(file) || /\.(e2e|cy|pw)\.[cm]?[jt]sx?$/.test(file) || /_e2e_test\./.test(file))
    return "e2e";
  if (/(^|\/)(integration|integration-tests?|it|functional|api-tests?|contract)\//i.test(file) || /\.(int|integration)\.[^.]+$|IT\.(java|kt)$|_integration_test\./.test(file))
    return "integration";
  return "unit";
}

/** The source file a test file is about, by name: test_foo.py → foo.py, foo.test.ts → foo.ts. */
export function subjectOf(file: string): string {
  const b = basename(file)
    .replace(/^test_/, "")
    .replace(/_(test|spec)(\.\w+)$/, "$2")
    .replace(/\.(test|spec|e2e|cy|pw|int|integration)(\.[cm]?[jt]sx?)$/, "$2")
    .replace(/(Test|Tests|IT|Spec)(\.\w+)$/, "$2");
  return b;
}

/** Feature sections from a requirements file: `## Heading` above `| R12 | … |` rows. */
export function requirementSections(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of ["REQUIREMENTS.md", "docs/REQUIREMENTS.md", "docs/requirements.md", "requirements.md"]) {
    let text: string;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    let section = "";
    for (const line of text.split("\n")) {
      const h = line.match(/^#{2,3}\s+(.+)$/);
      if (h) section = h[1]!.trim();
      const r = line.match(/^\|\s*(R\d+)\s*\|/);
      if (r && section) out.set(r[1]!, section);
    }
    break;
  }
  return out;
}

export interface Test extends FoundTest {
  id: string;
  layer: Layer;
  module: string;
  features: string[];
  status: "passed" | "failed" | "skipped" | null;
  durationMs: number | null;
  flaky: boolean;
}

interface Cov {
  lt: number;
  lh: number;
  bt: number;
  bh: number;
}
const covOf = (c: Cov | null) =>
  c && c.lt ? { lines: c.lh / c.lt, branches: c.bt ? c.bh / c.bt : null, linesTotal: c.lt, linesHit: c.lh, branchesTotal: c.bt, branchesHit: c.bh } : null;
const add = (a: Cov, b: Cov) => ((a.lt += b.lt), (a.lh += b.lh), (a.bt += b.bt), (a.bh += b.bh), a);

/** The latest coverage per file: from each report path's newest version; layer-tagged apart. */
export function latestCoverage(db: DatabaseSync) {
  const rows = db
    .prepare(
      `select c.file, c.lines_total as lt, c.lines_hit as lh, c.branches_total as bt, c.branches_hit as bh, c.layer
         from coverage_files c join test_reports r on c.report = r.path || '@' || substr(r.hash, 1, 12)
        where r.at = (select max(r2.at) from test_reports r2 where r2.path = r.path)`,
    )
    .all() as unknown as (Cov & { file: string; layer: string | null })[];
  const all = new Map<string, Cov>();
  const byLayer = new Map<string, Cov>();
  for (const r of rows) {
    if (r.layer) {
      add(byLayer.get(r.layer) ?? byLayer.set(r.layer, { lt: 0, lh: 0, bt: 0, bh: 0 }).get(r.layer)!, r);
      continue;
    }
    const f = all.get(r.file);
    // Two reports for one file (say lcov and json from the same run): keep the fuller one.
    if (!f || r.lt > f.lt) all.set(r.file, { lt: r.lt, lh: r.lh, bt: r.bt, bh: r.bh });
  }
  return { files: all, byLayer };
}

/** All tests, joined with their latest results and with flakiness over recent runs. */
export function allTests(db: DatabaseSync, root: string, cfg: WitConfig, found: FoundTest[]): Test[] {
  const sections = requirementSections(root);
  const results = db
    .prepare(
      `select t.id, t.name, t.suite, t.file, t.status, t.duration_ms, t.at from test_cases t
        where t.at >= (select coalesce(max(at), 0) - 30 * 86400000 from test_cases) order by t.at`,
    )
    .all() as { id: string; name: string; suite: string | null; file: string | null; status: string; duration_ms: number | null; at: number }[];
  const latest = new Map<string, (typeof results)[number]>();
  const statuses = new Map<string, Set<string>>();
  const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const r of results) {
    const k = keyOf(r.name);
    latest.set(k, r);
    if (r.status !== "skipped") (statuses.get(k) ?? statuses.set(k, new Set()).get(k)!).add(r.status);
  }
  const used = new Set<string>();
  const featuresOf = (file: string, tags: string[]) => {
    const f = Object.entries(cfg.features).filter(([, g]) => matches(file, g)).map(([n]) => n);
    if (f.length) return f;
    const fromTags = [...new Set(tags.map((t) => sections.get(t) ?? t))];
    return fromTags.length ? fromTags : [moduleOf(file)];
  };
  const tests: Test[] = found.map((t) => {
    const k = keyOf(t.name);
    const r = latest.get(k);
    if (r) used.add(k);
    return {
      ...t,
      id: `${t.file}::${t.suite ? `${t.suite}::` : ""}${t.name}`,
      layer: layerOf(t.file, cfg),
      module: moduleOf(t.file),
      features: featuresOf(t.file, t.tags),
      status: (r?.status as Test["status"]) ?? null,
      durationMs: r?.duration_ms ?? null,
      flaky: (statuses.get(k)?.size ?? 0) > 1,
    };
  });
  // Results with no test found in the source (a language without a pattern, a generated test).
  for (const [k, r] of latest) {
    if (used.has(k)) continue;
    const file = r.file ?? (r.suite ? r.suite.replace(/\./g, "/") : "(unknown)");
    tests.push({
      file, suite: r.suite, name: r.name, line: 0, tags: [], id: r.id,
      layer: layerOf(file, cfg), module: moduleOf(file), features: featuresOf(file, []),
      status: r.status as Test["status"], durationMs: r.duration_ms, flaky: (statuses.get(k)?.size ?? 0) > 1,
    });
  }
  return tests;
}

/** A test's module: its folder, or the project's top when it sits at the root. */
export const moduleOf = (file: string) => (dirname(file) === "." ? "(root)" : dirname(file));

export interface Node {
  key: string;
  label: string;
  level: string;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  notRun: number;
  flaky: number;
  durationMs: number;
  coverage: ReturnType<typeof covOf>;
  coverageScope: "layer report" | "tested code" | "all code" | null;
  children?: Node[];
  leaf?: { file: string; line: number; suite: string | null; status: Test["status"]; durationMs: number | null; flaky: boolean; tags: string[] };
}

/** Levels small enough that tests map to the code they target by name. */
const TARGETED = new Set(["module", "file", "suite"]);
const LEVELS = { layer: ["layer", "module", "file", "suite", "test"], feature: ["feature", "file", "suite", "test"] } as const;
export type Grouping = keyof typeof LEVELS;

/**
 * One node of the pyramid with its children one level down: the whole pyramid at `path` [], a
 * layer at ["unit"], a module at ["unit", "src/api"], and so on to single tests.
 */
export function pyramidNode(tests: Test[], cov: ReturnType<typeof latestCoverage>, grouping: Grouping, path: string[]) {
  const levels = LEVELS[grouping];
  const keyAt = (t: Test, level: string): string[] =>
    level === "layer" ? [t.layer] : level === "module" ? [t.module] : level === "file" ? [t.file] : level === "suite" ? [t.suite ?? "(no class)"] : level === "feature" ? t.features : [t.id];
  let scope = tests;
  for (const [i, seg] of path.entries()) scope = scope.filter((t) => keyAt(t, levels[i]!).includes(seg));
  // The code a set of tests targets, by name; files with no match leave the set to "all code".
  const subjects = new Map<string, string[]>();
  for (const f of cov.files.keys()) (subjects.get(basename(f)) ?? subjects.set(basename(f), []).get(basename(f))!).push(f);
  // Coverage for a group: its layer's own report when there is one; for a module, file or class,
  // the code its tests target by name; for the whole suite, a layer or a feature, all the code.
  const coverage = (ts: Test[], layer: string | null, level: string): Pick<Node, "coverage" | "coverageScope"> => {
    if (!ts.length || level === "test") return { coverage: null, coverageScope: null };
    if (layer && cov.byLayer.has(layer)) return { coverage: covOf(cov.byLayer.get(layer)!), coverageScope: "layer report" };
    const files = new Set<string>();
    for (const file of TARGETED.has(level) ? new Set(ts.map((t) => t.file)) : []) {
      const cands = subjects.get(subjectOf(file)) ?? [];
      // Prefer a candidate in a matching folder (tests/api/test_x.py → src/api/x.py).
      const parts = dirname(file).split("/");
      const best = [...cands].sort((a, b) => score(b, parts) - score(a, parts) || a.length - b.length || a.localeCompare(b))[0];
      if (best) files.add(best);
    }
    if (files.size) return { coverage: covOf([...files].reduce((s, f) => add(s, cov.files.get(f)!), { lt: 0, lh: 0, bt: 0, bh: 0 })), coverageScope: "tested code" };
    // A module, file or class whose tests match no source file by name: no honest number to show.
    if (TARGETED.has(level) || !cov.files.size) return { coverage: null, coverageScope: null };
    return { coverage: covOf([...cov.files.values()].reduce((s, c) => add(s, c), { lt: 0, lh: 0, bt: 0, bh: 0 })), coverageScope: "all code" };
  };
  const summarise = (key: string, label: string, level: string, ts: Test[], layer: string | null): Node => ({
    key,
    label,
    level,
    tests: ts.length,
    passed: ts.filter((t) => t.status === "passed").length,
    failed: ts.filter((t) => t.status === "failed").length,
    skipped: ts.filter((t) => t.status === "skipped").length,
    notRun: ts.filter((t) => t.status == null).length,
    flaky: ts.filter((t) => t.flaky).length,
    durationMs: Math.round(ts.reduce((s, t) => s + (t.durationMs ?? 0), 0)),
    ...coverage(ts, layer, level),
  });
  const depth = path.length;
  const layer = grouping === "layer" ? (path[0] ?? null) : null;
  const self = summarise(path.at(-1) ?? "", path.at(-1) ?? "All tests", depth ? levels[depth - 1]! : "pyramid", scope, layer);
  const childLevel = levels[depth];
  if (childLevel) {
    const groups = new Map<string, Test[]>();
    for (const t of scope) for (const k of keyAt(t, childLevel)) (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
    if (childLevel === "layer") for (const l of LAYERS) if (!groups.has(l)) groups.set(l, []);
    self.children = [...groups]
      .map(([k, ts]) => {
        const n = summarise(k, childLevel === "test" ? ts[0]!.name : k, childLevel, ts, childLevel === "layer" ? k : layer);
        if (childLevel === "test") {
          const t = ts[0]!;
          n.leaf = { file: t.file, line: t.line, suite: t.suite, status: t.status, durationMs: t.durationMs, flaky: t.flaky, tags: t.tags };
        }
        return n;
      })
      .sort((a, b) =>
        childLevel === "layer" ? LAYERS.indexOf(a.key as Layer) - LAYERS.indexOf(b.key as Layer) : childLevel === "test" ? (a.leaf!.line - b.leaf!.line) : b.tests - a.tests || a.key.localeCompare(b.key),
      );
  }
  return { grouping, path, levels, node: self };
}

const score = (candidate: string, parts: string[]) => parts.filter((p) => !/^(tests?|spec|__tests__|\.)$/.test(p) && candidate.includes(`${p}/`)).length;

/** Test counts and pass rates per report run, and overall coverage per coverage report version. */
export function testHistory(db: DatabaseSync) {
  const runs = db
    .prepare(
      `select r.at, r.path, count(t.id) as tests, sum(t.status = 'failed') as failed, sum(t.status = 'skipped') as skipped, sum(coalesce(t.duration_ms, 0)) as ms
         from test_reports r left join test_cases t on t.report = r.path || '@' || substr(r.hash, 1, 12)
        where r.kind = 'tests' group by r.path, r.hash order by r.at`,
    )
    .all() as { at: number; path: string; tests: number; failed: number; skipped: number; ms: number }[];
  const coverage = db
    .prepare(
      `select r.at, r.path, r.layer, sum(c.lines_total) as lt, sum(c.lines_hit) as lh, sum(c.branches_total) as bt, sum(c.branches_hit) as bh
         from test_reports r join coverage_files c on c.report = r.path || '@' || substr(r.hash, 1, 12)
        where r.kind = 'coverage' group by r.path, r.hash order by r.at`,
    )
    .all() as { at: number; path: string; layer: string | null; lt: number; lh: number; bt: number; bh: number }[];
  // One project-wide point per test run: each report path's newest version so far, summed, with
  // reports written within a few minutes of each other (one run of the suite) read as one point.
  const runPoints = timeline(runs, (latest) => {
    const all = [...latest.values()];
    return { tests: sum(all, (r) => r.tests), failed: sum(all, (r) => Number(r.failed ?? 0)), skipped: sum(all, (r) => Number(r.skipped ?? 0)), ms: sum(all, (r) => r.ms), reports: all.length };
  });
  const covPoints = timeline(coverage, (latest) => {
    const all = [...latest.values()];
    const [lt, lh, bt, bh] = [sum(all, (c) => c.lt), sum(all, (c) => c.lh), sum(all, (c) => c.bt), sum(all, (c) => c.bh)];
    return { lines: lt ? lh / lt : null, branches: bt ? bh / bt : null, reports: all.length };
  });
  return { runs: runPoints, coverage: covPoints };
}

const RUN_GAP_MS = 10 * 60_000;
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + (f(x) || 0), 0);

/** Folds report versions (sorted by time) into points, one per cluster of reports written together. */
function timeline<R extends { at: number; path: string }, P>(rows: R[], point: (latest: Map<string, R>) => P): (P & { at: number })[] {
  const latest = new Map<string, R>();
  const out: (P & { at: number })[] = [];
  rows.forEach((r, i) => {
    latest.set(r.path, r);
    const next = rows[i + 1];
    if (!next || next.at - r.at > RUN_GAP_MS) out.push({ at: r.at, ...point(latest) });
  });
  return out;
}

/** Finds every test in the project's source. */
export function discover(root: string): FoundTest[] {
  const out: FoundTest[] = [];
  for (const f of testFiles(root)) {
    try {
      const st = statSync(join(root, f));
      if (st.size > 2 * 1024 * 1024) continue;
      out.push(...findTests(f, readFileSync(join(root, f), "utf8")));
    } catch {
      /* vanished */
    }
  }
  return out;
}
