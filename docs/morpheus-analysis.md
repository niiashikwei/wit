# Analysis and audit

Morpheus started as the process view of one project, a monorepo whose Claude Code setup has about ten hook scripts, twenty skills and a dozen agents. That version answered real questions:
- Which hooks are slow?
- Which rules get worked around?
- Did the review run before the merge?
- Where do the tokens go?

But it only worked for that project, and only inside the Claude desktop app. This document records what it was, what an audit found, and what Morpheus changed.

## What there was

- **A collector** read the project's Claude Code transcripts, subagent transcripts and metadata into SQLite. It also read the project's own hook logs (`runs.jsonl`, `events.jsonl`), its review stamps and its test-suite step timings.
- **An MCP server** had eight read-only tools: live, overview, items, item, timeline, coverage, tokens and steps.
- **A claude.ai artifact page** (the "Live tab") called that server through the Claude desktop app. It polled every 30 seconds.
- **Improvement rules** ranked fixes by ROI. A backlog of project-specific to-dos topped the list up to ten.

It was well tested: 37 unit tests, and a token total checked against a manual `jq` count of a real transcript.

## Audit findings

Severity: **major** means wrong numbers, or it can't run elsewhere; **minor** means misleading or awkward. All are fixed in Morpheus unless marked.

| # | Finding | Severity | Fix in Morpheus |
|---|---|---|---|
| 1 | **Tied to one project.** It had the repo path, the store location, a `ship.sh merge` parser, review stamps, suite steps, hard-coded hook names and time budgets, and a backlog of that project's to-dos. | major | Removed. Hooks, skills and agents come from the project's, user's and installed plugins' `.claude/` (`inventory.ts`). Budgets go by hook *event*. The improvement rules are generic, and the backlog is gone. |
| 2 | **Only ran inside the Claude desktop app.** It needed a hand-written MCP entry and an app restart for every new tool. | major | `morpheus serve` serves the same page at localhost, with a JSON API. The page detects where it runs: the local server (fetch and a live stream) or the app (MCP). It also ships as a Claude Code plugin. |
| 3 | **"Live" was a 30-second poll.** Every poll ran a full ingest on the request path. | major | Server-Sent Events push a change notice within about 1 s of Claude writing (`fs.watch` on the transcript folders, debounced), with a 15 s poll as a fallback. Ingest is throttled to once every 2 s per project. |
| 4 | **Timing one hook hid the others.** Once *any* hook timed itself, transcript records of *every* hook after that moment were dropped, so a hook without timing vanished. | major | Per-hook: a hook's transcript records count until *that hook's* first timed run. Tested. |
| 5 | **Without the project's events log, blocks and rules read zero.** Blocks were counted only from the log. | major | Without an events log, blocks, warnings and rule tables come from the transcripts. Tested. |
| 6 | **Day buckets in UTC:** a local midnight was turned into a date with `toISOString()`, so days were off by one east of UTC. Quiet days were also missing from the token chart. | minor | `dayKey()` uses local dates, and charts fill every day. Tested. |
| 7 | **`Math.max(...list)` on whole run lists** throws "Maximum call stack size exceeded" once a hook has tens of thousands of runs. | major (crash at scale) | `reduce` everywhere a list can be large. |
| 8 | **Orchestration classifier:** `sort -o file` and `sed -n 'w file'` counted as read-only; a `\|` or `>` inside quotes (`--jq '.a \| .b'`) split or disqualified a command. | minor | Quote-aware splitting, and the write forms are excluded. Tested. |
| 9 | **Hint detection** parsed one project's hint format ("skills that match: a; b"). | minor | A prompt hook's text counts as a hint when it names a known skill as a whole word, in any wording. |
| 10 | **Inventory read only the project's `.claude/`**, so user-level and plugin skills looked "undefined". Scanning all plugin folders instead counted marketplace catalogues as installed. | minor | Project, user and *installed* plugins, each labelled. Anything that ran without a definition shows as "built-in or elsewhere". |
| 11 | **One "verdict missing" item per review agent** crowded the improvements list (five near-identical items). | minor | One grouped item. |
| 12 | **Statements prepared per row** during backfill (hundreds of thousands of times). | minor (speed) | Cached per database. A 1.2 GB backfill reads 307k lines in about 12 s. |
| 13 | **A running agent showed wall time since it first started** ("14 h so far" for an agent resumed yesterday). | minor | Shows active time. |
| 14 | **No setup path for full hook timing** outside that project's own hook library. | major (for other projects) | `morpheus init` installs a language-agnostic timer (bash and perl, no jq or Node) and routes hook commands through it, with backup and `--undo`. |
| 15 | **Web security:** the new local server could be read by any web page through DNS rebinding. | major (new surface) | It binds to 127.0.0.1, refuses any `Host` that isn't localhost, accepts GET only, sends no CORS headers, and sends `nosniff` and `no-referrer`. Tested. |
| 16 | **The hook context estimate counts all output**, though Claude Code passes only some events' output to the model. | minor | Labelled an upper-bound estimate (not fixed: the exact rule depends on the event and the output format). |

## Gaps that remain

The roadmap in [COMPETITORS.md](morpheus-competitors.md) covers these:
- dollar cost;
- other agents (Codex, Cursor, Gemini CLI);
- OpenTelemetry export;
- skill activation evals.

Also open:
- The skill context estimate assumes the whole SKILL.md loads (bytes ÷ 4).
- MCP tool names show the server's id as Claude Code wrote it, which for claude.ai connectors is an opaque UUID.

## Architecture

```
~/.claude/projects/<project>*/*.jsonl ─┐   (transcripts, subagents, meta)
<git dir>/morpheus/runs.jsonl ─────────┤   (optional: every hook run, from morpheus-time.sh)
<git dir>/morpheus/events.jsonl ───────┤   (optional: rule decisions from your hooks)
.claude/, ~/.claude/, plugins ─────────┘   (what's defined)
              │
          ingest.ts ── parse.ts (pure)                 one SQLite file per project
              │
          metrics.ts ── improvements.ts                 read-only questions
              │
           api.ts (TOOLS) ──┬── mcp.ts    (stdio MCP: Claude, the desktop app, artifacts)
                            └── server.ts (127.0.0.1: page, /api/<tool>, /api/stream SSE)
                                   │
                            web/dashboard.html (one file, no build, light and dark, phone width)
```

Everything is Node 24 built-ins: `node:sqlite`, `node:http`, `fs.watch`, and type stripping. `dist/` is the same code with types stripped, committed so `npx github:…` runs without a build step.
