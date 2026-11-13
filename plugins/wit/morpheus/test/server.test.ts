import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pagePath, serveWeb } from "../src/server.ts";
import { slug } from "../src/paths.ts";

const ENV = ["MORPHEUS_HOME", "MORPHEUS_DB", "MORPHEUS_PROJECT", "CLAUDE_CONFIG_DIR", "MORPHEUS_PORT"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "morpheus-server-")));
const home = join(tmp, "claude");
const projects = join(home, "projects");

before(() => {
  process.env.MORPHEUS_HOME = join(tmp, "data");
  process.env.MORPHEUS_DB = ":memory:";
  process.env.CLAUDE_CONFIG_DIR = home;
  delete process.env.MORPHEUS_PROJECT;
  delete process.env.MORPHEUS_PORT;
});

after(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

const line = (session: string, s: number, extra: Record<string, unknown>) =>
  `${JSON.stringify({
    sessionId: session,
    cwd: "/x",
    gitBranch: "main",
    timestamp: new Date(Date.now() - 60_000 + s * 1000).toISOString(),
    uuid: `${session}-${s}`,
    ...extra,
  })}\n`;

/** A project with one session that ran a skill. */
function repo(name: string) {
  const root = join(tmp, name);
  mkdirSync(join(root, ".claude", "morpheus"), { recursive: true });
  const dir = join(projects, slug(root));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s1.jsonl");
  writeFileSync(
    file,
    line("s1", 0, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "ship" } }] },
    }),
  );
  return { root, dir, file };
}

const portOf = (s: Server) => (s.address() as { port: number }).port;

/** A request with a Host header of our choosing (fetch sets its own). */
function get(port: number, path: string, host: string) {
  return new Promise<{ status: number; body: string }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode!, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Opens the live stream and reads it until `until` matches what has arrived. */
async function stream(port: number, query = "") {
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream${query}`, { signal: ctl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const until = async (re: RegExp, ms = 5000) => {
    const end = Date.now() + ms;
    while (!re.test(text)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}: ${text}`);
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    return text;
  };
  const close = () => {
    ctl.abort();
    return reader.cancel().catch(() => {});
  };
  return { until, close, text: () => text };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stop(s: Server) {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
}

// @req R31
test("the web server refuses requests not addressed to localhost and anything but GET", async () => {
  const { root } = repo("guard");
  const s = await serveWeb({ root, port: 0 });
  const port = portOf(s);
  const evil = await get(port, "/api/overview", `evil.example:${port}`);
  assert.equal(evil.status, 403);
  assert.deepEqual(JSON.parse(evil.body), { error: "localhost only" });
  assert.equal((await get(port, "/", `[::1]:${port}`)).status, 200, "IPv6 loopback is local");
  const post = await fetch(`http://127.0.0.1:${port}/api/overview`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.deepEqual(await post.json(), { error: "GET only" });
  assert.equal(post.headers.get("x-content-type-options"), "nosniff");
  assert.equal(post.headers.get("cache-control"), "no-store");
  await stop(s);
});

// @req R31 R34
test("the web server serves the page, the tools under /api, and 404s the rest", async () => {
  const { root } = repo("pages");
  const s = await serveWeb({ root, port: 0 });
  const base = `http://localhost:${portOf(s)}`;
  for (const path of ["/", "/index.html"]) {
    const page = await fetch(base + path);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /^text\/html/);
    assert.match(await page.text(), /<html/i);
  }
  const short = await fetch(`${base}/api/inventory`);
  assert.equal(short.status, 200);
  assert.equal((await short.json()).root, root);
  const long = await fetch(`${base}/api/morpheus_items?kind=skill&range=all`);
  assert.deepEqual(
    (await long.json()).map((r: { name: string }) => r.name),
    ["ship"],
  );
  const none = await fetch(`${base}/api/nope`);
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), { error: "no such tool" });
  const other = await fetch(`${base}/elsewhere`);
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: "not found" });
  await stop(s);
});

// @req R31
test("the page is found next to src/ or dist/, and a missing page is an error", () => {
  assert.match(pagePath(), /web[/\\]dashboard\.html$/);
  const deep = join(tmp, "pkg", "dist", "sub");
  mkdirSync(join(tmp, "pkg", "web"), { recursive: true });
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(tmp, "pkg", "web", "dashboard.html"), "<html></html>");
  assert.equal(pagePath(deep), join(tmp, "pkg", "web", "dashboard.html"));
  assert.throws(() => pagePath(join(tmp, "nowhere", "a")), /dashboard\.html is missing/);
});

let n = 10;
/** Grows a transcript now and every `ms` until stopped: fs.watch can miss the first change after it starts. */
function grow(file: string, ms: number) {
  const add = () =>
    appendFileSync(
      file,
      line("s1", n++, {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `t${n}`, name: "Skill", input: { skill: "tdd" } }] },
      }),
    );
  add();
  const t = setInterval(add, ms);
  return () => clearInterval(t);
}

// @req R23 R31
test("the live stream says hello, then pushes a changed event when a transcript grows", async () => {
  const a = repo("live-a");
  const b = repo("live-b");
  // No poll in reach: a changed event can only come from the watcher (after its default 750 ms debounce).
  const s = await serveWeb({ root: a.root, port: 0, pollMs: 60_000, beatMs: 60 });
  const port = portOf(s);
  const one = await stream(port);
  assert.match(await one.until(/event: hello/), new RegExp(`"root":"${a.root}"`));
  // A second page on the same project shares its watchers; a page on another project gets its own.
  const two = await stream(port, `?project=${encodeURIComponent(a.root)}`);
  await two.until(/event: hello/);
  const three = await stream(port, `?project=${encodeURIComponent(b.root)}`);
  assert.match(await three.until(/event: hello/), new RegExp(`"root":"${b.root}"`));
  const stopA = grow(a.file, 1000);
  const got = await one.until(/event: changed\ndata: \{"lines":[1-9]/);
  stopA();
  assert.match(got, /: keep-alive/, "the stream is kept open between events");
  assert.doesNotMatch(three.text(), /event: changed/, "only the project that changed is told");
  await one.close();
  await wait(50);
  await two.close();
  await three.close();
  await wait(50);
  await stop(s);
  // A shorter debounce, as asked for.
  const quick = await serveWeb({ root: b.root, port: 0, debounceMs: 10, pollMs: 60_000 });
  const four = await stream(portOf(quick));
  await four.until(/event: hello/);
  const stopB = grow(b.file, 200);
  await four.until(/event: changed\ndata: \{"lines":[1-9]/);
  stopB();
  await four.close();
  await stop(quick);
});

// @req R23 R31
test("a project that can't be read answers 500, and its stream stays quiet instead of failing", async () => {
  const c = repo("broken");
  // A transcript folder that vanished: watching it fails, and so does reading it.
  symlinkSync(join(tmp, "gone"), join(projects, `${slug(c.root)}-gone`));
  const s = await serveWeb({ root: c.root, port: 0, pollMs: 50 });
  const port = portOf(s);
  const r = await fetch(`http://127.0.0.1:${port}/api/overview`);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /ENOENT/);
  const live = await stream(port);
  await live.until(/event: hello/);
  await wait(200); // a few polls, each failing to read
  assert.doesNotMatch(live.text(), /event: changed/);
  // Closing with a page still open stops its watchers too.
  const closed = new Promise((r) => s.close(r));
  s.closeAllConnections();
  await closed;
  await live.close();
});

// @req R31
test("a request that arrives as the server closes is still checked against its port", async () => {
  const { root } = repo("closing");
  const s = await serveWeb({ root, port: 0 });
  const port = portOf(s);
  // The listening socket goes before the request is answered: its port is the one asked for (0).
  s.prependListener("request", () => s.close());
  const r = await get(port, "/", `localhost:${port}`);
  assert.equal(r.status, 403);
  s.closeAllConnections();
});
