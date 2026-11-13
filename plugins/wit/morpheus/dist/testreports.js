/**
 * Test results and coverage from the reports a project's own test runs leave behind, in whatever
 * language: JUnit XML (most runners), lcov, Cobertura and JaCoCo XML, coverage.py JSON, Istanbul
 * JSON and Go cover profiles. Each version of a report is kept once (by content hash), so history
 * builds up as the tests run. Parsers are pure: text in, records out.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
                                                
import { globRe,                } from "./config.js";
import { stmt } from "./ingest.js";

                           
             
               
                       
                      
                            
                                          
 
                               
               
                     
                   
                        
                      
 

const ENTITIES                         = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const unxml = (s        ) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e        ) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTITIES[e] ?? m),
  );

/** An XML start tag's attributes. */
export function attrs(tag        )                         {
  const out                         = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1] ] = unxml(m[3] ?? m[4] );
  return out;
}

/** JUnit XML (JUnit, pytest, Jest/Vitest junit reporters, node --test, Go, Maven, Gradle). */
export function parseJUnit(xml        )             {
  const out             = [];
  const seen = new Map                ();
  // The file a suite names, for runners that put it on the suite rather than the case.
  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)].map((m) => ({ at: m.index , a: attrs(m[1] ) }));
  const suiteAt = (i        ) => {
    let s                                = null;
    for (const x of suites) if (x.at < i) s = x.a;
    return s;
  };
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1] );
    const body = m[3] ?? "";
    const s = suiteAt(m.index );
    const suite = a.classname || s?.name || null;
    const name = a.name || "(unnamed)";
    const file = a.file || s?.file || null;
    const base = `${file ?? suite ?? ""}::${name}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const time = parseFloat(a.time ?? "");
    out.push({
      id: n > 1 ? `${base}#${n}` : base,
      name,
      suite,
      file,
      durationMs: Number.isFinite(time) ? Math.round(time * 1000 * 100) / 100 : null,
      status: /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed",
    });
  }
  return out;
}

const blank = (file        )               => ({ file, linesTotal: 0, linesHit: 0, branchesTotal: 0, branchesHit: 0 });

/** lcov (`SF:` … `end_of_record`): Jest, Vitest, c8, node --test, gcov, Rust, Dart… */
export function parseLcov(text        )                 {
  const out                 = [];
  let cur                      = null;
  let da = { total: 0, hit: 0 };
  let br = { total: 0, hit: 0 };
  let explicit = { lf: false, brf: false };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = blank(line.slice(3));
      da = { total: 0, hit: 0 };
      br = { total: 0, hit: 0 };
      explicit = { lf: false, brf: false };
    } else if (!cur) continue;
    else if (line.startsWith("DA:")) {
      da.total++;
      if (+(line.slice(3).split(",")[1] ?? 0) > 0) da.hit++;
    } else if (line.startsWith("BRDA:")) {
      br.total++;
      const taken = line.slice(5).split(",")[3];
      if (taken && taken !== "-" && +taken > 0) br.hit++;
    } else if (line.startsWith("LF:")) ((cur.linesTotal = +line.slice(3)), (explicit.lf = true));
    else if (line.startsWith("LH:")) cur.linesHit = +line.slice(3);
    else if (line.startsWith("BRF:")) ((cur.branchesTotal = +line.slice(4)), (explicit.brf = true));
    else if (line.startsWith("BRH:")) cur.branchesHit = +line.slice(4);
    else if (line === "end_of_record") {
      if (!explicit.lf) ((cur.linesTotal = da.total), (cur.linesHit = da.hit));
      if (!explicit.brf) ((cur.branchesTotal = br.total), (cur.branchesHit = br.hit));
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

/** Cobertura XML (coverage.py xml, Istanbul cobertura, gcovr, .NET coverlet). */
export function parseCobertura(xml        )                 {
  const by = new Map                                                                 ();
  for (const m of xml.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const file = attrs(m[1] ).filename;
    if (!file) continue;
    const f = by.get(file) ?? { lines: new Map(), bt: 0, bh: 0 };
    for (const l of m[2] .matchAll(/<line\b([^>]*?)\/?>/g)) {
      const a = attrs(l[1] );
      const n = +(a.number ?? 0);
      f.lines.set(n, (f.lines.get(n) ?? false) || +(a.hits ?? 0) > 0);
      const cc = a["condition-coverage"]?.match(/\((\d+)\/(\d+)\)/);
      if (cc) ((f.bh += +cc[1] ), (f.bt += +cc[2] ));
    }
    by.set(file, f);
  }
  return [...by].map(([file, f]) => ({
    file,
    linesTotal: f.lines.size,
    linesHit: [...f.lines.values()].filter(Boolean).length,
    branchesTotal: f.bt,
    branchesHit: f.bh,
  }));
}

/** JaCoCo XML (Java, Kotlin): each source file's LINE and BRANCH counters. */
export function parseJaCoCo(xml        )                 {
  const out                 = [];
  for (const p of xml.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const pkg = attrs(p[1] ).name ?? "";
    for (const s of p[2] .matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      const f = blank(`${pkg ? `${pkg}/` : ""}${attrs(s[1] ).name ?? ""}`);
      for (const c of s[2] .matchAll(/<counter\b([^>]*?)\/>/g)) {
        const a = attrs(c[1] );
        const missed = +(a.missed ?? 0);
        const covered = +(a.covered ?? 0);
        if (a.type === "LINE") ((f.linesTotal = missed + covered), (f.linesHit = covered));
        if (a.type === "BRANCH") ((f.branchesTotal = missed + covered), (f.branchesHit = covered));
      }
      out.push(f);
    }
  }
  return out;
}

/** coverage.py JSON (`coverage json`), Istanbul `coverage-final.json` or `coverage-summary.json`. */
export function parseCoverageJson(text        )                 {
  let j     ;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  if (!j || typeof j !== "object") return [];
  if (j.files && typeof j.files === "object" && j.meta)
    return Object.entries     (j.files).map(([file, f]) => ({
      file,
      linesTotal: f.summary?.num_statements ?? 0,
      linesHit: f.summary?.covered_lines ?? 0,
      branchesTotal: f.summary?.num_branches ?? 0,
      branchesHit: f.summary?.covered_branches ?? 0,
    }));
  const out                 = [];
  for (const [file, f] of Object.entries     (j)) {
    if (file === "total" || !f || typeof f !== "object") continue;
    if (f.lines && typeof f.lines.total === "number")
      out.push({ file, linesTotal: f.lines.total, linesHit: f.lines.covered ?? 0, branchesTotal: f.branches?.total ?? 0, branchesHit: f.branches?.covered ?? 0 });
    else if (f.s && f.statementMap) {
      const lines = new Map                 ();
      for (const [id, loc] of Object.entries     (f.statementMap)) {
        const n = loc?.start?.line;
        if (typeof n === "number") lines.set(n, (lines.get(n) ?? false) || (f.s[id] ?? 0) > 0);
      }
      const branches = Object.values     (f.b ?? {}).flat()            ;
      out.push({
        file: f.path ?? file,
        linesTotal: lines.size,
        linesHit: [...lines.values()].filter(Boolean).length,
        branchesTotal: branches.length,
        branchesHit: branches.filter((c) => c > 0).length,
      });
    }
  }
  return out;
}

/** A Go cover profile (`go test -coverprofile`): statements per file, by import path. */
export function parseGoCover(text        , module                = null)                 {
  const by = new Map                      ();
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/);
    if (!m) continue;
    let file = m[1] ;
    if (module && file.startsWith(`${module}/`)) file = file.slice(module.length + 1);
    const f = by.get(file) ?? blank(file);
    f.linesTotal += +m[2] ;
    if (+m[3]  > 0) f.linesHit += +m[2] ;
    by.set(file, f);
  }
  return [...by.values()];
}

                                                                                   

/** What a report is, from its name and first bytes. */
export function sniff(path        , head        )                    {
  if (/^\s*mode: (set|count|atomic)/.test(head)) return "go";
  if (/^(TN:|SF:)/m.test(head) && /\.(info|lcov)$/.test(path)) return "lcov";
  if (/<testsuites?\b|<testcase\b/.test(head)) return "junit";
  if (/<!DOCTYPE report|<report\b[^>]*name=/.test(head) && /<(package|sessioninfo)\b/.test(head)) return "jacoco";
  if (/<coverage\b/.test(head)) return "cobertura";
  if (/^\s*\{/.test(head) && path.endsWith(".json")) return "json";
  return null;
}

/** Where the usual runners write their reports, relative to the project. */
export const REPORT_GLOBS = [
  "coverage/lcov.info", "lcov.info", "coverage/*.info",
  "coverage/coverage-final.json", "coverage/coverage-summary.json", "coverage.json", "coverage/coverage.json",
  "coverage.xml", "coverage/cobertura-coverage.xml", "cobertura.xml", "coverage/coverage.xml",
  "target/site/jacoco/jacoco.xml", "build/reports/jacoco/test/jacocoTestReport.xml",
  "cover.out", "coverage.out", "c.out",
  "junit.xml", "test-results.xml", "report.xml", "test-results/**/*.xml", "test-reports/**/*.xml",
  "reports/**/*.xml", "coverage/junit.xml", "target/surefire-reports/*.xml", "target/failsafe-reports/*.xml",
  "build/test-results/**/*.xml", ".wit/**/*.{xml,info,json,out}",
];

/** Lists files under `root` matching globs, without descending into dependency or VCS folders. */
export function findFiles(root        , globs          , max = 2000)           {
  const res = globs.map(globRe);
  const out           = [];
  const fixed = globs.filter((g) => !/[*?{]/.test(g));
  for (const g of fixed) if (existsSync(join(root, g))) out.push(g);
  const dirs = new Set(globs.filter((g) => /[*?{]/.test(g)).map((g) => g.split(/[*?{]/)[0] .replace(/\/[^/]*$/, "")));
  const walk = (rel        , depth        ) => {
    if (out.length >= max || depth > 6) return;
    let names          ;
    try {
      names = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const p = rel ? `${rel}/${n}` : n;
      let st;
      try {
        st = statSync(join(root, p));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (res.some((r) => r.test(p)) && !out.includes(p)) out.push(p);
    }
  };
  for (const d of dirs) if (d && existsSync(join(root, d))) walk(d, 0);
  if (dirs.has("")) walk("", 0);
  return out.slice(0, max);
}
export const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "vendor", ".tox", ".mypy_cache", ".pytest_cache", "worktrees"]);

/** A report path as the project sees it: relative to the root, forward slashes. */
export const rel = (root        , p        ) => (isAbsolute(p) ? relative(root, p) : p).split("\\").join("/").replace(/^\.\//, "");

const KEEP = 60;

/**
 * Reads new versions of the project's test and coverage reports into the store. Returns how many
 * new report versions it read.
 */
export function ingestReports(db              , root        , cfg           )         {
  const layerOf = new Map(cfg.coverageReports.filter((c) => c.layer).map((c) => [rel(root, c.path), c.layer ]));
  const paths = new Set([...findFiles(root, [...REPORT_GLOBS, ...cfg.testReports]), ...cfg.coverageReports.map((c) => rel(root, c.path))]);
  const module = goModule(root);
  let n = 0;
  for (const p of paths) {
    const full = join(root, p);
    let text        ;
    let st;
    try {
      st = statSync(full);
      if (!st.isFile() || st.size > 64 * 1024 * 1024) continue;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const hash = createHash("sha1").update(text).digest("hex");
    if (stmt(db, "select 1 from test_reports where path = ? and hash = ?").get(p, hash)) continue;
    const kind = sniff(p, text.slice(0, 4096));
    if (!kind) continue;
    const at = Math.round(st.mtimeMs);
    const id = `${p}@${hash.slice(0, 12)}`;
    const layer = layerOf.get(p) ?? null;
    db.exec("begin immediate");
    try {
      stmt(db, "insert into test_reports (path, hash, at, kind, framework, layer) values (?, ?, ?, ?, ?, ?)").run(p, hash, at, kind === "junit" ? "tests" : "coverage", kind, layer);
      if (kind === "junit") {
        const put = stmt(db, "insert or replace into test_cases (report, id, name, suite, file, duration_ms, status, at) values (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const t of parseJUnit(text)) put.run(id, t.id, t.name, t.suite, t.file ? rel(root, t.file) : null, t.durationMs, t.status, at);
      } else {
        const files =
          kind === "lcov" ? parseLcov(text) : kind === "cobertura" ? parseCobertura(text) : kind === "jacoco" ? parseJaCoCo(text) : kind === "go" ? parseGoCover(text, module) : parseCoverageJson(text);
        const put = stmt(db, "insert or replace into coverage_files (report, file, lines_total, lines_hit, branches_total, branches_hit, at, layer) values (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const f of files) put.run(id, rel(root, f.file), f.linesTotal, f.linesHit, f.branchesTotal, f.branchesHit, at, layer);
      }
      // History, but not forever: the newest versions of each report.
      const old = db.prepare("select hash from test_reports where path = ? order by at desc limit -1 offset ?").all(p, KEEP)                      ;
      for (const o of old) {
        const oid = `${p}@${o.hash.slice(0, 12)}`;
        stmt(db, "delete from test_cases where report = ?").run(oid);
        stmt(db, "delete from coverage_files where report = ?").run(oid);
        stmt(db, "delete from test_reports where path = ? and hash = ?").run(p, o.hash);
      }
      db.exec("commit");
      n++;
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
  return n;
}

function goModule(root        )                {
  try {
    return readFileSync(join(root, "go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}
