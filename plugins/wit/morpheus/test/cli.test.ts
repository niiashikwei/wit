import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { type Io, main, report } from "../src/cli.ts";
import { VERSION } from "../src/mcp.ts";
import { slug } from "../src/paths.ts";

const ENV = ["MORPHEUS_HOME", "MORPHEUS_DB", "MORPHEUS_PROJECT", "CLAUDE_CONFIG_DIR", "MORPHEUS_PORT", "CLAUDE_PROJECT_DIR"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "morpheus-cli-")));
const home = join(tmp, "claude");

before(() => {
  process.env.MORPHEUS_HOME = join(tmp, "data");
  process.env.MORPHEUS_DB = ":memory:";
  process.env.CLAUDE_CONFIG_DIR = home;
  for (const k of ["MORPHEUS_PROJECT", "MORPHEUS_PORT", "CLAUDE_PROJECT_DIR"]) delete process.env[k];
});

after(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

/** Captures what a command prints. */
function io(extra: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const codes: number[] = [];
  return {
    out,
    err,
    opened,
    codes,
    io: {
      log: (l: string) => void out.push(l),
      error: (l: string) => void err.push(l),
      status: (t: string) => void err.push(t),
      open: (u: string) => void opened.push(u),
      exit: (c: number) => void codes.push(c),
      ...extra,
    } satisfies Partial<Io>,
  };
}

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

/** A project with transcripts: a prompt hint, a timed hook, a skill load and a reply of `tokens`. */
function repo(name: string, tokens: number, hooks = true) {
  const root = join(tmp, name);
  mkdirSync(join(root, ".claude"), { recursive: true });
  if (hooks)
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash .claude/hooks/guard.sh" }] }] } }),
    );
  const dir = join(home, "projects", slug(root));
  mkdirSync(dir, { recursive: true });
  const base = (s: number) => ({ sessionId: `${name}-s`, cwd: root, gitBranch: "main", timestamp: ago(600 - s), uuid: `${name}${s}` });
  const lines = [
    { ...base(0), type: "user", message: { role: "user", content: "ship it" } },
    {
      ...base(1),
      type: "attachment",
      attachment: { type: "hook_additional_context", hookEvent: "UserPromptSubmit", toolUseID: "h1", content: ["ship; tdd"] },
    },
    {
      ...base(2),
      type: "assistant",
      message: {
        id: "m1",
        usage: { input_tokens: tokens, output_tokens: 10 },
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }],
      },
    },
    {
      ...base(3),
      type: "attachment",
      attachment: { type: "hook_success", hookName: "PreToolUse:Bash", toolUseID: "t1", command: "bash guard.sh", durationMs: 40, stdout: "ok" },
    },
  ];
  writeFileSync(join(dir, "s.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return root;
}

// @req R33
test("the CLI prints its version and help, and refuses an unknown command with exit code 2", async () => {
  const c = io();
  await main(["--version"], c.io);
  await main(["help"], c.io);
  await main(["--help"], c.io);
  assert.equal(c.out[0], VERSION);
  assert.match(c.out[1]!, /^morpheus .*\n\nUsage:/);
  assert.equal(c.out[2], c.out[1]);
  await main(["bogus", "--project", tmp], c.io);
  assert.deepEqual(c.codes, [2]);
  assert.match(c.err[0]!, /^Unknown command bogus\n\nmorpheus/);
  // By default the exit code is the process's.
  const before = process.exitCode;
  await main(["bogus", "--project", tmp], { error: () => {} });
  assert.equal(process.exitCode, 2);
  process.exitCode = before;
});

// @req R33
test("morpheus report sums up the numbers and the next improvements, or says none are needed", async () => {
  const busy = repo("busy", 2_000_000);
  const c = io();
  await main(["report", "--project", busy, "--range", "all"], c.io);
  const text = c.out.join("\n");
  assert.match(text, new RegExp(`^Morpheus: ${busy} \\(all\\)`));
  assert.match(text, /hook runs 1 \(p95 40 ms\)/);
  assert.match(text, /Hints followed 0% \(0\/1\)/);
  assert.match(text, /of 2\.0M new/);
  assert.match(text, /1\. Time every hook run \(ROI \d/);
  // The range defaults to 7 days, also when --range has no value.
  const mid = repo("mid", 50_000, false);
  const d = io();
  await main(["report", "--project", mid, "--range"], d.io);
  assert.match(d.out[0]!, /\(7d\)/);
  assert.match(d.out[0]!, /of 50k new/);
  assert.match(d.out[0]!, /None: nothing in the numbers needs attention/);
  const quiet = join(tmp, "quiet");
  mkdirSync(quiet);
  const q = report(quiet);
  assert.match(q, /\(7d\)/);
  assert.match(q, /p95 – ms/);
  assert.match(q, /Hints followed – \(0\/0\)/);
  assert.match(q, /of 0 new/);
});

// @req R33
test("morpheus ingest reads new transcripts; projects lists them, newest first", async () => {
  const root = repo("ingested", 100);
  const c = io();
  await main(["ingest", "--project", root], c.io);
  assert.match(c.out[0]!, /^Read 4 new lines in \d+ ms$/);
  await main(["ingest", "--project", root], c.io);
  assert.match(c.out[1]!, /^Read 0 new lines/, "a second read finds nothing new");
  // The project defaults to CLAUDE_PROJECT_DIR, else the folder it runs in.
  process.env.CLAUDE_PROJECT_DIR = root;
  await main(["ingest"], c.io);
  assert.match(c.out[2]!, /^Read 0 new lines/);
  delete process.env.CLAUDE_PROJECT_DIR;
  const p = io();
  await main(["projects"], p.io);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(p.out.some((l) => l === `${today}      1 sessions  ${root}`), p.out.join("\n"));
});

// @req R32 R33
test("morpheus init times the project's hooks; --dry-run only says so and --undo restores them", async () => {
  const root = join(tmp, "timed");
  mkdirSync(join(root, ".claude"), { recursive: true });
  const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "bash .claude/hooks/x.sh" }] }] } };
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings));
  const dry = io();
  await main(["init", "--dry-run", "--project", root], dry.io);
  assert.deepEqual(dry.out, ["settings.json: timing 1 hook command(s)"]);
  assert.equal(existsSync(join(root, ".claude", "hooks")), false, "a dry run writes nothing");
  const on = io();
  await main(["init", "--project", root], on.io);
  assert.match(on.out[0]!, /^Copied the hook timer to .*morpheus-time\.sh$/);
  assert.match(readFileSync(join(root, ".claude", "settings.json"), "utf8"), /morpheus-time\.sh bash/);
  const off = io();
  await main(["init", "--undo", "--project", root], off.io);
  assert.deepEqual(off.out, [
    "settings.json: restored 1 hook command(s)",
    "Restart Claude Code sessions in this project: hooks load when a session starts.",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")), settings);
});

// @req R29 R33
test("morpheus mcp answers JSON-RPC lines on the streams it's given", async () => {
  const root = repo("mcp", 10);
  const input = new PassThrough();
  const output = new PassThrough();
  const c = io({ input, output });
  const rl = (await main(["mcp", "--project", root], c.io)) as { close(): void };
  const replies: any[] = [];
  let buf = "";
  output.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  input.write("\n");
  input.write("not json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "morpheus_inventory" } })}\n`);
  for (let i = 0; i < 100 && replies.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  rl.close();
  assert.equal(replies.length, 2, "blank lines and notifications get no answer");
  assert.deepEqual(replies[0], { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  assert.equal(replies[1].id, 1);
  assert.equal(replies[1].result.structuredContent.root, root);
});

// @req R31 R33
test("morpheus serve reads the transcripts, listens, and opens the browser with --open", async () => {
  const root = repo("served", 10);
  const c = io();
  const s = (await main(["serve", "--project", root, "--port", "0", "--open"], c.io)) as Server;
  assert.match(c.err.join(""), /Reading .*'s transcripts…\nRead 4 lines in \d+ ms\n/);
  assert.deepEqual(c.out, ["Morpheus is live at http://localhost:0/ (Ctrl+C to stop)"]);
  assert.deepEqual(c.opened, ["http://localhost:0/"]);
  s.close();
  // The port comes from MORPHEUS_PORT too; without --open no browser starts.
  process.env.MORPHEUS_PORT = "0";
  const d = io();
  const t = (await main(["--project", root], d.io)) as Server;
  delete process.env.MORPHEUS_PORT;
  assert.deepEqual(d.opened, []);
  t.close();
  // And defaults to 4673, which may be taken by a running Morpheus.
  const e = io();
  try {
    const u = (await main(["serve", "--project", root], e.io)) as Server;
    assert.equal((u.address() as { port: number }).port, 4673);
    u.close();
  } catch (err) {
    assert.equal((err as NodeJS.ErrnoException).code, "EADDRINUSE");
  }
});
