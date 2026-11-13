import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import {
  allTests, discover, findTests, latestCoverage, layerOf, moduleOf, pyramidNode, requirementSections, subjectOf, testFiles, testHistory, TEST_FILE,
} from "../src/pyramid.ts";
import {
  attrs, findFiles, ingestReports, parseCobertura, parseCoverageJson, parseGoCover, parseJaCoCo, parseJUnit, parseLcov, rel, sniff, unxml,
} from "../src/testreports.ts";
import { openStore } from "../src/store.ts";
import { tmp } from "./sdlc-helpers.ts";

const cfg = (over = {}) => ({ ...DEFAULTS, ...over });
function write(root: string, path: string, text: string, mtime?: number) {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  if (mtime) utimesSync(full, mtime / 1000, mtime / 1000);
}

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="api" file="tests/test_api.py">
    <testcase classname="tests.test_api.TestApi" name="test_get" time="0.012"/>
    <testcase classname="tests.test_api.TestApi" name="test_post" time="1.5"><failure message="boom">trace</failure></testcase>
    <testcase name="test_skip" time="x"><skipped/></testcase>
    <testcase classname="dup" name="same" file="a.ts"/>
    <testcase classname="dup" name="same" file="a.ts"/>
    <testcase classname="err" name="errs &amp; &lt;more&gt; &#65;&#x42;"><error/></testcase>
  </testsuite>
  <testcase name="orphan"/>
</testsuites>`;

// @req R38
test("JUnit XML becomes test cases with results, times, classes, files and unique ids", () => {
  const t = parseJUnit(JUNIT);
  assert.equal(t.length, 7);
  assert.deepEqual(t[0], { id: "tests/test_api.py::test_get", name: "test_get", suite: "tests.test_api.TestApi", file: "tests/test_api.py", durationMs: 12, status: "passed" });
  assert.equal(t[1]!.status, "failed");
  assert.equal(t[1]!.durationMs, 1500);
  assert.equal(t[2]!.status, "skipped");
  assert.equal(t[2]!.durationMs, null);
  assert.equal(t[2]!.suite, "api");
  assert.equal(t[4]!.id, "a.ts::same#2");
  assert.equal(t[5]!.status, "failed");
  assert.equal(t[5]!.name, "errs & <more> AB");
  assert.deepEqual([t[6]!.suite, t[6]!.file, t[6]!.id], ["api", "tests/test_api.py", "tests/test_api.py::orphan"]);
  assert.equal(parseJUnit('<testcase/>')[0]!.name, "(unnamed)");
  assert.equal(parseJUnit('<testcase name="x"/>')[0]!.id, "::x");
  assert.deepEqual(attrs(`<a b='1' c="2" d = "x&quot;">`), { b: "1", c: "2", d: 'x"' });
  assert.equal(unxml("&bogus; &apos;"), "&bogus; '");
});

// @req R38
test("lcov gives lines and branches per file, from totals or counted from DA and BRDA lines", () => {
  const f = parseLcov(["TN:", "DA:1,1", "SF:src/a.ts", "LF:10", "LH:7", "BRF:4", "BRH:3", "end_of_record", "SF:src/b.ts", "DA:1,2", "DA:2,0", "DA:3", "BRDA:1,0,0,1", "BRDA:1,0,1,-", "BRDA:1,0,2,0", "BRDA:1,0,3", "end_of_record"].join("\n"));
  assert.deepEqual(f, [
    { file: "src/a.ts", linesTotal: 10, linesHit: 7, branchesTotal: 4, branchesHit: 3 },
    { file: "src/b.ts", linesTotal: 3, linesHit: 1, branchesTotal: 4, branchesHit: 1 },
  ]);
});

// @req R38
test("Cobertura merges a file's classes; JaCoCo reads LINE and BRANCH counters per source file", () => {
  const cob = parseCobertura(`<coverage><packages><package><classes>
    <class filename="src/a.py"><lines><line number="1" hits="1"/><line number="2" hits="0" branch="true" condition-coverage="50% (1/2)"/></lines></class>
    <class filename="src/a.py"><lines><line number="2" hits="3"/><line number="3" hits="0"></line></lines></class>
    <class name="nofile"><lines><line number="1" hits="1"/></lines></class>
    <class filename="src/b.py"><lines><line hits="2"/><line number="9"/></lines></class>
  </classes></package></packages></coverage>`);
  assert.deepEqual(cob, [
    { file: "src/a.py", linesTotal: 3, linesHit: 2, branchesTotal: 2, branchesHit: 1 },
    { file: "src/b.py", linesTotal: 2, linesHit: 1, branchesTotal: 0, branchesHit: 0 },
  ]);
  const jac = parseJaCoCo(`<report name="x"><package name="com/acme"><sourcefile name="A.java"><counter type="INSTRUCTION" missed="1" covered="2"/><counter type="LINE" missed="2" covered="8"/><counter type="BRANCH" missed="1" covered="3"/></sourcefile></package><package><sourcefile><counter type="LINE"/></sourcefile></package></report>`);
  assert.deepEqual(jac, [
    { file: "com/acme/A.java", linesTotal: 10, linesHit: 8, branchesTotal: 4, branchesHit: 3 },
    { file: "", linesTotal: 0, linesHit: 0, branchesTotal: 0, branchesHit: 0 },
  ]);
});

// @req R38
test("coverage.py JSON, Istanbul summary and final JSON, and Go profiles are read", () => {
  const py = parseCoverageJson(JSON.stringify({ meta: { version: "7" }, files: { "a.py": { summary: { num_statements: 10, covered_lines: 9, num_branches: 4, covered_branches: 2 } }, "b.py": {} } }));
  assert.deepEqual(py, [{ file: "a.py", linesTotal: 10, linesHit: 9, branchesTotal: 4, branchesHit: 2 }, { file: "b.py", linesTotal: 0, linesHit: 0, branchesTotal: 0, branchesHit: 0 }]);
  const sum = parseCoverageJson(JSON.stringify({ total: { lines: { total: 1 } }, "/r/a.ts": { lines: { total: 5, covered: 4 }, branches: { total: 2, covered: 1 } }, "b.ts": { lines: { total: 3 } }, junk: 4 }));
  assert.deepEqual(sum, [{ file: "/r/a.ts", linesTotal: 5, linesHit: 4, branchesTotal: 2, branchesHit: 1 }, { file: "b.ts", linesTotal: 3, linesHit: 0, branchesTotal: 0, branchesHit: 0 }]);
  const fin = parseCoverageJson(JSON.stringify({
    "/r/c.ts": { path: "/r/c.ts", s: { 0: 1, 1: 0, 2: 3 }, statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } }, 2: { start: { line: 2 } }, 3: {}, 4: { start: { line: 7 } } }, b: { 0: [1, 0] } },
    "d.ts": { s: {}, statementMap: {} },
    "e.ts": { other: 1 },
  }));
  assert.deepEqual(fin, [{ file: "/r/c.ts", linesTotal: 3, linesHit: 2, branchesTotal: 2, branchesHit: 1 }, { file: "d.ts", linesTotal: 0, linesHit: 0, branchesTotal: 0, branchesHit: 0 }]);
  assert.deepEqual(parseCoverageJson("nope"), []);
  assert.deepEqual(parseCoverageJson("null"), []);
  const go = parseGoCover("mode: set\nexample.com/m/pkg/a.go:1.1,2.2 3 1\nexample.com/m/pkg/a.go:3.1,4.2 2 0\nother/b.go:1.1,1.5 1 4\nbad line", "example.com/m");
  assert.deepEqual(go, [{ file: "pkg/a.go", linesTotal: 5, linesHit: 3, branchesTotal: 0, branchesHit: 0 }, { file: "other/b.go", linesTotal: 1, linesHit: 1, branchesTotal: 0, branchesHit: 0 }]);
  assert.equal(parseGoCover("x/a.go:1.1,1.2 1 1")[0]!.file, "x/a.go");
});

// @req R38
test("a report's kind is sniffed from its name and first bytes", () => {
  assert.equal(sniff("cover.out", "mode: atomic\n"), "go");
  assert.equal(sniff("coverage/lcov.info", "TN:\nSF:a"), "lcov");
  assert.equal(sniff("junit.xml", "<testsuites>"), "junit");
  assert.equal(sniff("jacoco.xml", '<!DOCTYPE report><report name="x"><sessioninfo/>'), "jacoco");
  assert.equal(sniff("coverage.xml", '<coverage line-rate="1">'), "cobertura");
  assert.equal(sniff("coverage.json", ' {"a":1}'), "json");
  assert.equal(sniff("notes.txt", "hello"), null);
  assert.equal(rel("/r", "/r/src/a.ts"), "src/a.ts");
  assert.equal(rel("/r", "./src/a.ts"), "src/a.ts");
});

// @req R38
test("report files are found in the usual places, skipping dependency folders", () => {
  const root = tmp();
  write(root, "coverage/lcov.info", "SF:a\nend_of_record\n");
  write(root, "test-results/unit/junit.xml", "<testsuites/>");
  write(root, "node_modules/x/test-results/junit.xml", "<testsuites/>");
  write(root, "deep/a/b/c/d/e/f/g/h/junit.xml", "<testsuites/>");
  write(root, "any/junit.xml", "<testsuites/>");
  const found = findFiles(root, ["coverage/lcov.info", "test-results/**/*.xml", "**/junit.xml", "missing/*.xml"]);
  assert.ok(found.includes("coverage/lcov.info"));
  assert.ok(found.includes("test-results/unit/junit.xml"));
  assert.ok(found.includes("any/junit.xml"));
  assert.ok(!found.some((f) => f.includes("node_modules")));
  assert.ok(!found.some((f) => f.startsWith("deep/")), "depth is bounded");
  assert.equal(findFiles(root, ["**/*.xml"], 1).length, 1);
  // A broken link and a file where a folder was expected are passed over.
  symlinkSync(join(root, "nowhere"), join(root, "test-results", "broken.xml"));
  write(root, "cov", "a file, not a folder");
  assert.ok(findFiles(root, ["test-results/**/*.xml", "cov/*.xml"]).includes("test-results/unit/junit.xml"));
});

// @req R38
test("each new report version is stored once with its cases or coverage; history is bounded", () => {
  const root = tmp();
  const db = openStore(":memory:");
  write(root, "junit.xml", JUNIT, Date.UTC(2026, 9, 1));
  write(root, "coverage/lcov.info", "SF:" + join(root, "src/a.ts") + "\nLF:4\nLH:3\nend_of_record\n", Date.UTC(2026, 9, 1));
  write(root, "reports/int.xml", '<coverage><class filename="src/a.ts"><line number="1" hits="1"/></class></coverage>');
  write(root, "reports/notes.xml", "<html/>");
  write(root, "go.mod", "module example.com/m\n");
  write(root, "cover.out", "mode: set\nexample.com/m/src/g.go:1.1,2.2 2 1\n");
  write(root, "coverage.json", JSON.stringify({ meta: {}, files: { "src/p.py": { summary: { num_statements: 2, covered_lines: 1 } } } }));
  write(root, "target/site/jacoco/jacoco.xml", '<report name="j"><package name="x"><sourcefile name="J.java"><counter type="LINE" missed="0" covered="1"/></sourcefile></package></report>');
  const n = ingestReports(db, root, cfg({ coverageReports: [{ path: "reports/int.xml", layer: "integration" }] }));
  assert.equal(n, 6);
  assert.equal(ingestReports(db, root, cfg()), 0, "unchanged reports are skipped");
  const files = db.prepare("select file, layer from coverage_files order by file").all() as any[];
  assert.deepEqual(files.map((f) => f.file), ["src/a.ts", "src/a.ts", "src/g.go", "src/p.py", "x/J.java"]);
  assert.equal(files.find((f) => f.layer === "integration").file, "src/a.ts");
  assert.equal((db.prepare("select count(*) as n from test_cases").get() as any).n, 7);
  // New versions build history; beyond 60 the oldest go.
  for (let i = 0; i < 62; i++) {
    write(root, "junit.xml", `<testsuite><testcase name="t${i}"/></testsuite>`, Date.UTC(2026, 9, 2) + i * 1000);
    ingestReports(db, root, cfg());
  }
  assert.equal((db.prepare("select count(*) as n from test_reports where path = 'junit.xml'").get() as any).n, 60);
  assert.equal((db.prepare("select count(*) as n from test_cases").get() as any).n, 60);
  // Unreadable or oversized files are skipped; a store failure rolls back and is reported.
  mkdirSync(join(root, "lcov.info"));
  assert.equal(ingestReports(db, root, cfg({ coverageReports: [{ path: "gone.info" }] })), 0);
  // Go profiles without a go.mod, or with one that names no module, keep their import paths.
  const bare = tmp();
  write(bare, "cover.out", "mode: set\nexample.com/m/a.go:1.1,2.2 1 1\n");
  ingestReports(db, bare, cfg());
  write(bare, "go.mod", "go 1.22\n");
  write(bare, "cover.out", "mode: set\nexample.com/m/b.go:1.1,2.2 1 1\n");
  ingestReports(db, bare, cfg());
  assert.equal((db.prepare("select count(*) as n from coverage_files where file like 'example.com/m/%'").get() as any).n, 2);
  write(root, "coverage/lcov.info", "SF:b\nend_of_record\n");
  db.exec("drop table coverage_files");
  assert.throws(() => ingestReports(db, root, cfg()));
});

// @req R39
test("tests are found in Python, JS/TS, Go, Java, Ruby, Rust and C# files with their classes and tags", () => {
  const py = findTests("tests/test_x.py", 'class TestX:\n    @req("R1", "R2")\n    def test_a(self):\n        pass\n    async def test_b(self): pass\ndef helper(): pass');
  assert.deepEqual(py.map((t) => [t.suite, t.name, t.line, t.tags]), [["TestX", "test_a", 3, ["R1", "R2"]], ["TestX", "test_b", 5, []]]);
  const js = findTests("src/a.test.ts", 'describe("Api", () => {\n  // @req R23\n  it("gets", () => {});\n  test.skip(`skips`, () => {});\n});\n// @feature(login)\ntest("t", () => {})');
  assert.deepEqual(js.map((t) => [t.suite, t.name, t.tags]), [["Api", "gets", ["R23"]], ["Api", "skips", []], ["Api", "t", ["login"]]]);
  assert.deepEqual(findTests("a_test.go", "func TestA(t *testing.T) {}\nfunc helper() {}").map((t) => t.name), ["TestA"]);
  assert.deepEqual(findTests("ATest.java", "class ATest {\n  @Test\n  void adds() {}\n  @Test\n\n\n\n\n\n  int x;\n}").map((t) => [t.suite, t.name]), [["ATest", "adds"]]);
  assert.deepEqual(findTests("a_spec.rb", "describe Cart do\n  it 'adds' do\n  end\nend").map((t) => [t.suite, t.name]), [["Cart", "adds"]]);
  assert.deepEqual(findTests("lib_test.rs", "#[test]\nfn works() {}\n#[tokio::test]\nasync fn later() {}").map((t) => t.name), ["works", "later"]);
  assert.deepEqual(findTests("ATests.cs", "public class ATests {\n  [Fact]\n  public void Adds() {}\n}").map((t) => t.name), ["Adds"]);
  assert.deepEqual(findTests("README.md", "test('x')"), []);
  assert.ok(TEST_FILE.test("pkg/a_test.go") && TEST_FILE.test("x.spec.tsx") && !TEST_FILE.test("src/app.ts"));
});

// @req R39
test("test files are found across the project, skipping dependencies, build output and hidden folders", () => {
  const root = tmp();
  write(root, "tests/test_a.py", "def test_a(): pass\n");
  write(root, "tests/testutils.py", "def test_like(): pass\n");
  write(root, "src/b.test.ts", 'test("b", () => {})\n');
  write(root, "node_modules/x/c.test.js", 'test("c", () => {})\n');
  write(root, "dist/d.test.js", 'test("d", () => {})\n');
  write(root, ".hidden/e.test.js", 'test("e", () => {})\n');
  write(root, ".github/f.test.js", 'test("f", () => {})\n');
  write(root, "big/huge.test.js", "x".repeat(2 * 1024 * 1024 + 10));
  const files = testFiles(root);
  assert.deepEqual(files.sort(), [".github/f.test.js", "big/huge.test.js", "src/b.test.ts", "tests/test_a.py", "tests/testutils.py"]);
  assert.equal(testFiles(root, 1).length, 1);
  assert.deepEqual(discover(root).map((t) => t.name).sort(), ["b", "f", "test_a", "test_like"]);
  assert.deepEqual(testFiles(join(root, "nope")), []);
  // A broken link is passed over; an unreadable test file is left out of discovery.
  symlinkSync(join(root, "gone"), join(root, "src", "gone.test.ts"));
  write(root, "src/locked.test.ts", 'test("locked", () => {})\n');
  chmodSync(join(root, "src/locked.test.ts"), 0);
  assert.ok(!testFiles(root).includes("src/gone.test.ts"));
  assert.ok(!discover(root).some((t) => t.name === "locked"));
});

// @req R39
test("layers come from configured globs, then folder and file conventions; subjects and modules from names", () => {
  const c = { layers: { e2e: ["qa/**"], smoke: ["smoke/**"] } };
  assert.equal(layerOf("qa/login.test.ts", c), "e2e");
  assert.equal(layerOf("smoke/x.test.ts", c), "integration");
  assert.equal(layerOf("cypress/a.cy.ts", { layers: {} }), "e2e");
  assert.equal(layerOf("src/a.e2e.ts", { layers: {} }), "e2e");
  assert.equal(layerOf("pkg/x_e2e_test.go", { layers: {} }), "e2e");
  assert.equal(layerOf("tests/integration/test_db.py", { layers: {} }), "integration");
  assert.equal(layerOf("src/OrderIT.java", { layers: {} }), "integration");
  assert.equal(layerOf("src/a.int.ts", { layers: {} }), "integration");
  assert.equal(layerOf("tests/test_a.py", { layers: {} }), "unit");
  assert.equal(subjectOf("tests/test_cart.py"), "cart.py");
  assert.equal(subjectOf("pkg/cart_test.go"), "cart.go");
  assert.equal(subjectOf("src/cart.test.ts"), "cart.ts");
  assert.equal(subjectOf("CartTest.java"), "Cart.java");
  assert.equal(subjectOf("cart_spec.rb"), "cart.rb");
  assert.equal(moduleOf("a.test.ts"), "(root)");
  assert.equal(moduleOf("src/api/a.test.ts"), "src/api");
});

// @req R39
test("requirement IDs map to the section they're listed under in a requirements file", () => {
  const root = tmp();
  assert.equal(requirementSections(root).size, 0);
  write(root, "docs/requirements.md", "# Spec\n| R9 | before any section |\n## Login\n| ID | x |\n| R1 | sign in |\n### Billing\n| R2 | pay |\n");
  assert.deepEqual([...requirementSections(root)], [["R1", "Login"], ["R2", "Billing"]]);
});

function pyramidFixture() {
  const root = tmp();
  const db = openStore(":memory:");
  write(root, "REQUIREMENTS.md", "## Checkout\n| R1 | pay |\n");
  const found = [
    ...findTests("tests/test_cart.py", '@req("R1")\ndef test_add(): pass\ndef test_remove(): pass\n'),
    ...findTests("src/api/user.test.ts", 'describe("User", () => {\n  it("saves", () => {});\n});\n'),
    ...findTests("e2e/login.spec.ts", 'test("logs in", () => {})\n'),
    ...findTests("tests/integration/test_db.py", "def test_conn(): pass\n"),
    ...findTests("src/api/cart.test.ts", 'test("carts", () => {})\n'),
    ...findTests("tests/test_misc.py", "# @feature(search)\ndef test_find(): pass\n"),
  ];
  const T = Date.UTC(2026, 9, 1);
  const rep = (path: string, hash: string, at: number, kind: string, layer: string | null = null) =>
    db.prepare("insert into test_reports (path, hash, at, kind, framework, layer) values (?, ?, ?, ?, 'x', ?)").run(path, hash, at, kind, layer);
  rep("junit.xml", "aaaaaaaaaaaaaaaa", T, "tests");
  rep("junit.xml", "bbbbbbbbbbbbbbbb", T + 1000, "tests");
  const tc = db.prepare("insert into test_cases (report, id, name, suite, file, duration_ms, status, at) values (?, ?, ?, ?, ?, ?, ?, ?)");
  tc.run("junit.xml@aaaaaaaaaaaa", "1", "test_add", null, null, 5, "failed", T);
  tc.run("junit.xml@bbbbbbbbbbbb", "1", "test_add", null, null, 7, "passed", T + 1000);
  tc.run("junit.xml@bbbbbbbbbbbb", "2", "saves", "User", null, 30, "passed", T + 1000);
  tc.run("junit.xml@bbbbbbbbbbbb", "3", "logs in", null, null, 900, "failed", T + 1000);
  tc.run("junit.xml@bbbbbbbbbbbb", "4", "test_skipped_one", null, null, null, "skipped", T + 1000);
  tc.run("junit.xml@bbbbbbbbbbbb", "5", "generated", "com.acme.Gen", null, 1, "passed", T + 1000);
  tc.run("junit.xml@bbbbbbbbbbbb", "6", "floating", null, "lib/float_test.go", 1, "passed", T + 1000);
  tc.run("junit.xml@bbbbbbbbbbbb", "7", "nowhere", null, null, null, "passed", T + 1000);
  rep("lcov.info", "cccccccccccccccc", T, "coverage");
  rep("lcov.info", "dddddddddddddddd", T + 1000, "coverage");
  rep("int.xml", "eeeeeeeeeeeeeeee", T + 1000, "coverage", "integration");
  rep("coverage.json", "gggggggggggggggg", T + 1000, "coverage");
  const cf = db.prepare("insert into coverage_files (report, file, lines_total, lines_hit, branches_total, branches_hit, at, layer) values (?, ?, ?, ?, ?, ?, ?, ?)");
  cf.run("lcov.info@cccccccccccc", "src/cart.py", 10, 1, 0, 0, T, null);
  cf.run("lcov.info@dddddddddddd", "src/cart.py", 10, 9, 4, 3, T + 1000, null);
  cf.run("lcov.info@dddddddddddd", "lib/cart.py", 2, 2, 0, 0, T + 1000, null);
  cf.run("lcov.info@dddddddddddd", "src/api/user.ts", 20, 10, 0, 0, T + 1000, null);
  cf.run("coverage.json@gggggggggggg", "src/api/user.ts", 5, 5, 0, 0, T + 1000, null);
  cf.run("lcov.info@dddddddddddd", "src/other.ts", 50, 25, 0, 0, T + 1000, null);
  cf.run("lcov.info@dddddddddddd", "a/cart.ts", 3, 0, 0, 0, T + 1000, null);
  cf.run("lcov.info@dddddddddddd", "src/api/cart.ts", 4, 4, 0, 0, T + 1000, null);
  cf.run("int.xml@eeeeeeeeeeee", "src/db.py", 8, 6, 2, 1, T + 1000, "integration");
  return { root, db, found };
}

// @req R39
test("all tests: source tests joined with latest results, flaky across runs, plus results with no source", () => {
  const { root, db, found } = pyramidFixture();
  const tests = allTests(db, root, cfg({ features: { accounts: ["src/api/**"] } }), found);
  const by = (n: string) => tests.find((t) => t.name === n)!;
  assert.equal(by("test_add").status, "passed");
  assert.equal(by("test_add").flaky, true);
  assert.deepEqual(by("test_add").features, ["Checkout"]);
  assert.deepEqual(by("saves").features, ["accounts"]);
  assert.deepEqual(by("test_remove").features, ["tests"]);
  assert.equal(by("test_remove").status, null);
  assert.equal(by("logs in").layer, "e2e");
  assert.equal(by("test_conn").layer, "integration");
  assert.equal(by("generated").file, "com/acme/Gen");
  assert.equal(by("floating").file, "lib/float_test.go");
  assert.equal(by("nowhere").file, "(unknown)");
  assert.equal(by("test_skipped_one").status, "skipped");
  assert.deepEqual(by("test_find").features, ["search"]);
});

// @req R39
test("the pyramid zooms from layers to modules, files, classes and tests, each with coverage and its source", () => {
  const { root, db, found } = pyramidFixture();
  const tests = allTests(db, root, cfg(), found);
  const cov = latestCoverage(db);
  assert.equal(cov.files.get("src/api/user.ts")!.lt, 20, "the fuller of two rows for one file");
  assert.equal(cov.files.get("src/cart.py")!.lh, 9, "the newest report version");
  const top = pyramidNode(tests, cov, "layer", []);
  assert.deepEqual(top.node.children!.map((c) => [c.key, c.tests]), [["unit", 9], ["integration", 1], ["e2e", 1]]);
  assert.equal(top.node.level, "pyramid");
  const integ = top.node.children!.find((c) => c.key === "integration")!;
  assert.equal(integ.coverageScope, "layer report");
  assert.equal(integ.coverage!.lines, 6 / 8);
  const unit = pyramidNode(tests, cov, "layer", ["unit"]);
  assert.equal(unit.node.level, "layer");
  const mod = pyramidNode(tests, cov, "layer", ["unit", "tests"]);
  assert.equal(mod.node.coverageScope, "tested code");
  assert.equal(mod.node.coverage!.linesTotal, 2, "a tie between lib/cart.py and src/cart.py is settled by name, the same way every time");
  const api = pyramidNode(tests, cov, "layer", ["unit", "src/api"]);
  assert.equal(api.node.coverage!.linesTotal, 24, "src/api/cart.test.ts targets src/api/cart.ts, not the shorter a/cart.ts");
  const file = pyramidNode(tests, cov, "layer", ["unit", "tests", "tests/test_cart.py"]);
  assert.equal(file.node.children![0]!.key, "(no class)");
  const leaf = pyramidNode(tests, cov, "layer", ["unit", "tests", "tests/test_cart.py", "(no class)"]);
  assert.deepEqual(leaf.node.children!.map((c) => [c.label, c.leaf!.line, c.leaf!.status]), [["test_add", 2, "passed"], ["test_remove", 3, null]]);
  assert.equal(leaf.node.children![0]!.coverage, null);
  const e2e = pyramidNode(tests, cov, "layer", ["e2e"]);
  assert.equal(e2e.node.coverageScope, "all code");
  const e2eModule = e2e.node.children![0]!;
  assert.deepEqual([e2eModule.coverage, e2eModule.coverageScope], [null, null], "e2e/login.spec.ts targets no source file by name");
  const feat = pyramidNode(tests, cov, "feature", []);
  assert.ok(feat.node.children!.some((c) => c.key === "Checkout"));
  // Without coverage, nodes say so.
  const none = pyramidNode(tests, { files: new Map(), byLayer: new Map() }, "layer", ["unit"]);
  assert.equal(none.node.coverage, null);
  assert.equal(none.node.coverageScope, null);
  // Coverage with no measurable lines says nothing, but says which coverage it would be.
  const zero = pyramidNode(tests, { files: new Map([["x.ts", { lt: 0, lh: 0, bt: 0, bh: 0 }]]), byLayer: new Map() }, "layer", ["e2e"]);
  assert.deepEqual([zero.node.coverage, zero.node.coverageScope], [null, "all code"]);
  // An empty suite still shows all three layers.
  assert.equal(pyramidNode([], cov, "layer", []).node.children!.length, 3);
});

// @req R39
test("test history sums every report's newest version into one point per run of the suite", () => {
  const db = openStore(":memory:");
  const T = Date.UTC(2026, 9, 1);
  const MIN = 60_000;
  const rep = (path: string, hash: string, at: number, kind: string) =>
    db.prepare("insert into test_reports (path, hash, at, kind) values (?, ?, ?, ?)").run(path, hash, at, kind);
  const tc = db.prepare("insert into test_cases (report, id, name, status, duration_ms, at) values (?, ?, ?, ?, ?, ?)");
  const cf = db.prepare("insert into coverage_files (report, file, lines_total, lines_hit, branches_total, branches_hit, at) values (?, ?, ?, ?, ?, ?, ?)");
  // Run 1: web and api reports a minute apart. Run 2, a day later: only api changed.
  rep("web.xml", "aaaaaaaaaaaaaaaa", T, "tests");
  tc.run("web.xml@aaaaaaaaaaaa", "1", "w1", "passed", 10, T);
  tc.run("web.xml@aaaaaaaaaaaa", "2", "w2", "failed", 10, T);
  rep("api.xml", "bbbbbbbbbbbbbbbb", T + MIN, "tests");
  tc.run("api.xml@bbbbbbbbbbbb", "1", "a1", "passed", null, T + MIN);
  tc.run("api.xml@bbbbbbbbbbbb", "2", "a2", "skipped", null, T + MIN);
  rep("api.xml", "cccccccccccccccc", T + 86_400_000, "tests");
  tc.run("api.xml@cccccccccccc", "1", "a1", "passed", 5, T + 86_400_000);
  rep("empty.xml", "dddddddddddddddd", T + 2 * 86_400_000, "tests");
  rep("web.info", "eeeeeeeeeeeeeeee", T, "coverage");
  cf.run("web.info@eeeeeeeeeeee", "w.ts", 10, 5, 4, 1, T);
  rep("api.json", "ffffffffffffffff", T + 2 * MIN, "coverage");
  cf.run("api.json@ffffffffffff", "a.py", 30, 30, 0, 0, T + 2 * MIN);
  rep("zero.info", "gggggggggggggggg", T + 86_400_000, "coverage");
  cf.run("zero.info@gggggggggggg", "z.ts", 0, 0, 0, 0, T + 86_400_000);
  const h = testHistory(db);
  assert.deepEqual(h.runs.map((r) => [r.tests, r.failed, r.skipped, r.ms, r.reports]), [[4, 1, 1, 20, 2], [3, 1, 0, 25, 2], [3, 1, 0, 25, 3]]);
  assert.equal(h.runs[0]!.at, T + MIN, "a run is dated by its last report");
  assert.deepEqual(h.coverage.map((c) => [c.lines, c.branches, c.reports]), [[35 / 40, 0.25, 2], [35 / 40, 0.25, 3]]);
  // Coverage with nothing measurable says nothing.
  const lone = openStore(":memory:");
  lone.prepare("insert into test_reports (path, hash, at, kind) values ('z.info', 'ffffffffffffffff', 1, 'coverage')").run();
  lone.prepare("insert into coverage_files (report, file, lines_total, lines_hit, at) values ('z.info@ffffffffffff', 'a', 0, 0, 1)").run();
  assert.deepEqual([testHistory(lone).coverage[0]!.lines, testHistory(lone).coverage[0]!.branches], [null, null]);
});
