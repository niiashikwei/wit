# Wit

**Wit** is a Claude Code plugin with two parts, for any project in any language:

- **Token optimizer.** It cuts token usage without slowing delivery. It **measures privately, learns from every session, tunes itself**, and tells you how many tokens it saved.
- **SDLC dashboard (Morpheus).** A live, local, tabbed dashboard you open beside any Claude Code project: SDLC health, DORA metrics, the testing pyramid with coverage, tokens and cost per task, AI effectiveness, code quality, resource use, and how your hooks, skills and agents are running.

Requires Claude Code and Python 3 (standard library only) for the token optimizer, and Node 24 (or 23.6+) for the Morpheus dashboard and its MCP tools. Each part works without the other.

## Install (once, works in every project)

```bash
claude plugin marketplace add niiashikwei/wit
```

```bash
claude plugin install wit@wit
```

Restart Claude Code afterwards. For a team, you can add the marketplace and plugin to a project's `.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`) so everyone who opens the project is offered it.

Optional statusline (model · context % · cache hit % · tokens saved · cost): clone this repo, then add to `~/.claude/settings.json`:
```json
"statusLine": { "type": "command", "command": "python3 /path/to/wit/plugins/wit/scripts/statusline.py" }
```

## What's inside

| Piece | Strategy | Can it slow you down? |
|---|---|---|
| `SessionStart` hook | ~120-token etiquette brief + **learned tips** + CLAUDE.md size warning | No |
| `PreToolUse:Read` guard | Large full-file reads → warn (default) or **nudge** (deny once per file, the 2nd attempt is always allowed) | At most one retry per file |
| `PreToolUse:Bash` hint | Warns only for command families **observed** to produce large output | No (context only) |
| `PostToolUse` / `PreCompact` (async) | Privacy-safe metrics | No (runs in background) |
| `SessionEnd` → `tuner.py` (background) | Summarizes usage, re-tunes, regenerates tips | No |
| `scout` (Haiku), `implementer` (Sonnet) | Cheap subagents keep the main context lean | No |
| `token-steward` agent + `/token-audit` skill | Static audit + metrics → ranked fixes | On demand |
| `api-cost-review` skill | Caching / batch / routing / output review for Claude API code | On demand |
| `morpheus` MCP server | Read-only tools over this project's hooks, skills, agents and tokens | On demand |
| `/wit:dashboard`, `/wit:process-report` | The Morpheus dashboard in your browser; a text summary with top improvements | On demand |
| `process-review` skill | Answers "how is my Claude Code setup working?" from Morpheus's tools | On demand |

Hook overhead is about 30ms per call, measured.

## Self-optimization loop

At the end of each session the tuner looks at the last 14 days of metrics and:

- **Read guard:** in `warn` mode, if large full-file reads persist (≥2/session over ≥5 sessions), it promotes to `nudge`. In `nudge` mode, if more than 40% of nudges are overridden it raises `max_lines` ×1.25, and above 60% it falls back to `warn`. If under 10% are overridden it tightens ×0.9 (bounds 400–4000).
- **Bash:** learns which command families average more than 20KB of output and hints only for those.
- **Tips:** top token sink, heavy MCP tools, low cache-hit rate, Opus-heavy output, frequent compaction.

Every change is logged with its reason in `~/.claude/wit/tuning.json` → `history`. Preview the next pass with `python3 plugins/wit/scripts/tuner.py --dry-run`.

## Tokens saved

The plugin shows its savings in three places:
- **Each new session:** a one-line message, e.g. `Wit: saved ~12.4k tokens last session, ~210.0k over the last 30 days (14 sessions).`
- **Live in the statusline:** `… · saved ~4.2k · …` (needs the statusline setting above).
- **`/token-audit`:** totals broken down by source, plus how much work was offloaded to subagents.

What counts as a saving:
- A **nudged large read** that was followed by a ranged read: full file size minus what was actually read. Overridden nudges count 0.
- A **bash hint** that was heeded: the family's learned average output minus the actual output.

These are **conservative estimates** (~4 bytes/token, each counted once). In reality, avoided output would also have been re-sent on every later turn. Warn-only hints and subagent delegation aren't counted as savings: subagent work is reported separately, because it moves tokens to cheaper models rather than removing them.

## Morpheus: the process dashboard

Morpheus reads the files Claude Code already writes (session transcripts, subagent transcripts, your `.claude/` setup), so it needs **nothing installed in the project**. Everything stays on your machine.

- **Real time:** the page updates within a second of Claude writing something, through a live stream from the local server.
- **History:** 1 hour, today, 7 days, 30 days, or everything. It keeps what it has read even after Claude Code deletes old transcripts.
- **Drill down and scope down:** click any hook, rule, skill, agent or session to see its runs, time histogram, what each run was doing and which sessions it ran in. Narrow the whole page to one session, branch or project.
- **How well it's working, not just how much:** blocks that were worked around; skills that were hinted but not loaded; skills and agents defined but never used; review agents that never give a verdict; hooks over their time budget; and the **work vs orchestration** token split per session and agent type.

### Open it

With the plugin installed, run `/wit:dashboard`, or ask Claude "how are my hooks doing?". Without the plugin, from any project folder:

```bash
npx github:niiashikwei/wit
```

Then open http://localhost:4673. Morpheus reads the project's Claude Code history once (a few seconds per GB), then keeps up live. Pick another project from the menu at the top right.

### Time every hook run (optional, one command)

Claude Code's transcripts only record hooks that printed something, so quiet hook runs and their time are invisible. To record every run, in the project:

```bash
npx github:niiashikwei/wit init
```

`init` does three things:
- It copies `morpheus-time.sh` into `.claude/hooks/`. The timer is plain bash and perl, so it needs no Node, jq or project dependencies.
- It routes each simple hook command in `.claude/settings.json` and `settings.local.json` through the timer, and keeps a `.morpheus-bak` backup of each file.
- It leaves hooks that use pipes or `&&` as they are, and says so.

`--dry-run` shows what it would change; `--undo` puts the hook commands back. Restart your Claude Code sessions afterwards, because hooks load when a session starts.

### Commands

| Command | What it does |
|---|---|
| `morpheus` / `morpheus serve [--port 4673] [--open]` | The dashboard at http://localhost:4673 |
| `morpheus report [--range 7d]` | A text summary and the top improvements |
| `morpheus mcp` | The MCP server (stdio), for Claude and the Claude desktop app |
| `morpheus init [--dry-run \| --undo]` | Time every hook run |
| `morpheus ingest` | Read new transcripts now |
| `morpheus projects` | Every project Claude Code has history for |

`morpheus` is `npx github:niiashikwei/wit`, or `node plugins/wit/morpheus/dist/cli.js` in a clone. `--project <dir>` picks the project; the default is the git repository you're in (its main checkout, so worktrees count as one project), else the current folder.

### Tabs

| Tab | What it answers |
|---|---|
| **Health** | One scorecard for the whole cycle: plan, code, review, test, build & CI, deploy, operate and AI efficiency, each good / needs a look / bad / no data, with the numbers and targets behind it and how to turn on a stage with no data. |
| **Delivery** | The four DORA metrics (deploy frequency, lead time for changes, change failure rate, time to restore) with their State of DevOps bands, deploys per week, the lead-time distribution, CI pass rate per workflow, and recent deploys with what failed and how fast it was fixed. |
| **Tests** | The testing pyramid by layer (unit, integration, end-to-end), sized by share so an inverted suite shows. Click a layer for a treemap of its modules, then files, classes and single tests; use the trail to zoom out, or group by feature instead. Every level shows test count, pass/fail/not run, flaky tests, time and line and branch coverage, plus coverage and failures over time and the slowest tests. |
| **Tokens & cost** | New and cached tokens and estimated cost in total, per day by task category (feature, bugfix, test, refactor, docs, review, explore, ops), by model, and for every task: one prompt and everything it set off, with its tools, agents, skills, files and whether you had to correct it. |
| **AI effectiveness** | How much Claude co-writes, how much of that is redone within 14 days compared with everyone else's code, tokens and cost per commit and per line, cache hit rate, corrections, interrupts, permission denials, compactions and tool errors, by task category. |
| **Quality** | Coverage of the code that changed, test lines per code line (all commits and Claude's), churn hotspots and tool errors. |
| **Resources** | CPU and memory of Claude Code, its MCP servers, hooks and the commands it runs, and Wit itself; the machine's load, memory and free disk; the project's disk footprint (repo, `.git`, dependencies, build output, transcripts, Wit's store); and how long test and build runs take. |
| **Hooks & agents** | Morpheus's original view, below. |

Where the SDLC data comes from, all local unless you opt in:
- **git** (DORA, AI share, rework, hotspots): commits on the main branch, read with `git`. Claude's commits are those with a `Co-Authored-By: Claude` trailer or Claude Code's footer.
- **Test reports** (pyramid, coverage): tests are found in the source (Python, JS/TS, Go, Java/Kotlin, Ruby, Rust, C#) and joined with the reports your test runs already write: JUnit XML, lcov, Cobertura, JaCoCo, coverage.py JSON, Istanbul JSON or Go cover profiles, in their usual paths. Each new version is kept, so history builds up as you test.
- **Claude Code transcripts** (tasks, tokens, corrections, compactions) and **`ps`** (resources).
- **GitHub, only if you opt in**: CI runs, deployments and `incident` issues through your `gh` CLI, at most every ten minutes.

Optional settings in `.claude/wit.json` (every key optional):

```json
{
  "deploy": "main",
  "gh": false,
  "failureWindowHours": 72,
  "layers": { "integration": ["tests/integration/**"], "e2e": ["e2e/**"] },
  "features": { "checkout": ["src/checkout/**", "tests/checkout/**"] },
  "coverageReports": ["coverage/lcov.info", { "path": "coverage/int.xml", "layer": "integration" }],
  "testReports": ["build/junit/*.xml"]
}
```

`deploy` is `main` (each change landing on the main branch), `tag:v*` (matching tags), `gh-deployments` or `gh-workflow:<name>`. A deploy fails when a revert of what it shipped, a hotfix or rollback, a failed status or an incident follows within `failureWindowHours`.

### Hooks & agents tab

| Section | What it answers |
|---|---|
| **Next improvements** | What to change first: each with its evidence, the fix, minutes saved a week, risk and effort, and a link to the data. |
| **Running now** | Sessions active in the last 10 minutes, what each is running, and the newest hook, skill and agent runs. |
| **Timeline** | One session's hooks, prompt hints, skills and agents in the order they fired, with nested agents under the one that started them. |
| **Coverage** | Every hook, rule, skill and agent defined in the project, your user folder and installed plugins: active, missed, idle or off. |
| **Usage, speed and effect** | Active time in hooks and agents, hook runs and p95, blocks, hints followed, agent runs and tokens, per day. |
| **Work vs orchestration** | Where the tokens went: work, orchestration (agents, messages, skill loads, plans, waiting) and replies, by session, agent type and day, plus the context hooks and skills add (estimates). |
| **Tables** | Hooks, rules, skills, agents and tools, sortable, each with p50, p95, max, outcomes and a drill-down. |

### Use it from Claude

The plugin's `morpheus` MCP server exposes read-only tools: `morpheus_overview`, `morpheus_live`, `morpheus_items`, `morpheus_item`, `morpheus_timeline`, `morpheus_coverage`, `morpheus_tokens`, `morpheus_inventory`, `morpheus_projects`, and for the SDLC tabs `morpheus_health`, `morpheus_dora`, `morpheus_tests`, `morpheus_tasks`, `morpheus_resources` and `morpheus_quality`. To add it without the plugin:

```bash
claude mcp add morpheus -- npx -y github:niiashikwei/wit mcp
```

The same `web/dashboard.html` also runs as a claude.ai artifact in the Claude desktop app, beside your Claude Code session, where it talks to the `morpheus` MCP server (as `host:morpheus`) instead of the local web server. Every tab works there too.

### Optional: richer hook data

Hooks can append one JSON line per decision to `<git dir>/morpheus/events.jsonl`:

```json
{"ts":"2026-11-03T10:00:00Z","hook":"no-force-push","type":"block","branch":"main","detail":"git push --force"}
```

That turns on per-rule tables (blocks, warnings, overrides, worked-around rate). A gate that notices work done without its skill or agent can write `"detail": "skill deploy: …"` (or `agent reviewer: …`), and Coverage marks that skill or agent as missed. See [docs/morpheus-data.md](docs/morpheus-data.md).

## Privacy

**Token optimizer** (R6–R8):
- Metrics are **local only** (`~/.claude/wit/`) and nothing is sent over the network.
- What's recorded: counts, byte sizes, token totals, tool names, file extensions, and command families from a fixed allowlist (`pytest`, `npm test`… anything else is `other`).
- Paths, sessions and projects are stored as **salted hashes**. The salt is random per machine, so hashes can't be matched elsewhere.
- **Never recorded:** prompts, file contents, paths, full commands, tool outputs.

**Morpheus** (R30–R31) shows what happened in your sessions, so it keeps more, still only on your machine:
- It reads `~/.claude/projects/<your project>*` and your `.claude/` folders, and writes one SQLite file per project to `~/Library/Application Support/morpheus/` (macOS) or `~/.local/share/morpheus/`.
- Commands and hook output are cut to short excerpts, with anything that looks like a secret masked. Prompt text is kept only as a short excerpt, for the Running now panel. Agents' message bodies are never stored, only their verdicts.
- Resource sampling reads `ps` command lines only to tell Claude Code's processes apart; only the process group's totals are stored.
- The web server listens on 127.0.0.1 only and refuses requests not addressed to localhost. Nothing is sent anywhere, unless you set `"gh": true`, and then only through your own `gh` CLI (R37). Delete the `.db` file to forget a project; the next run rebuilds it from the transcripts still on disk.

## Controls

| Setting | Effect |
|---|---|
| `WIT_GUARD=off\|warn\|nudge` (env) | Override the guard mode for a shell |
| `WIT_METRICS=off` (env) | Record nothing |
| `"pinned": true` in `tuning.json` | Freeze auto-tuning; the tuner only proposes |
| `rm -rf ~/.claude/wit` | Forget the token optimizer's data |
| `MORPHEUS_HOME`, `MORPHEUS_PROJECT` (env) | Where Morpheus keeps its store; which project it watches |

## Testing

Requirements live in [REQUIREMENTS.md](REQUIREMENTS.md) (R1–R45). Every test is tagged with the requirements it verifies, and the build fails if any requirement is untested.

| Suite | Covers |
|---|---|
| `test_guards.py` | Session brief, read guard, nudge escape hatch, guard modes, bash hints (R1–R5) |
| `test_privacy.py` | No paths/contents/commands/prompts recorded, salted hashes, opt-out, no network imports (R6–R8) |
| `test_tuner.py` | Self-tuning rules and bounds, history, pinning, dry-run, transcript summary, learned tips, storage limits (R9–R12, R18, R22) |
| `test_savings.py` | Savings accounting and display, report, audit (R13–R16) |
| `test_robustness.py` | Malformed input, unwritable or corrupt data, unreadable files (R17) |
| `test_performance.py` | Hook latency p50/p95, huge files, full-history tuning (R19–R20) |
| `test_packaging.py` | Manifests, hook wiring, agent/skill frontmatter, Morpheus MCP wiring (R21, R34) |
| `plugins/wit/morpheus/test/` | Morpheus ingest, metrics, improvements, tokens, MCP, privacy, init, CLI, server (R23–R34), and the SDLC collectors, metrics and dashboard views (R35–R45), tagged `// @req` |
| `test_traceability.py` | Every requirement has a test; every Morpheus test is tagged |

The Python tests run the scripts exactly as Claude Code does (a fresh process with JSON on stdin) against an isolated data directory.

```bash
python3 -m unittest discover -s tests -v
```

```bash
python3 tests/traceability.py
```

```bash
npm install && npm run check
```

`npm run check` typechecks Morpheus, runs its tests (`node --test`, no network) with a **99% line, branch and function coverage gate** over the server, collectors, metrics and the dashboard's modules, and checks that the committed `plugins/wit/morpheus/dist/` and `web/dashboard.html` match their sources. The test run also writes `coverage/lcov.info` and `coverage/junit.xml`, so Wit's own Tests tab shows its pyramid. `dist/` and the page are committed so `npx` and the plugin run without a build; after changing `src/` or `web/src/`, run `npm run build`.

Coverage for the Python side, lines and branches (needs `pip install coverage`; CI fails under 99%):
```bash
WIT_COVERAGE=1 python3 -m unittest discover -s tests && python3 -m coverage combine && python3 -m coverage report
```

Measured on an Apple Silicon Mac: every hook p95 ≤ ~55 ms (p50 ~30 ms, mostly Python startup); about 100 ms when session start has a full 20k-event history; 35 ms to guard a 50 MB file; the tuner takes ~110 ms over a full 20k-line metrics file. CI runs the Python suite on Linux and macOS with Python 3.10–3.13, and Morpheus on Linux and macOS with Node 24.

## Docs

- [docs/morpheus-analysis.md](docs/morpheus-analysis.md): how Morpheus works, the audit of the version it grew from, and what was fixed
- [docs/morpheus-competitors.md](docs/morpheus-competitors.md): other tools in this space and where Morpheus fits
- [docs/morpheus-data.md](docs/morpheus-data.md): data sources, formats, what counts as orchestration, and the metrics' definitions

## Contributing

Issues and PRs welcome. Run both test suites before opening a PR. Keep the token optimizer's privacy contract intact (new metrics may record numbers, tool names and salted hashes only), and keep Morpheus local and read-only.

## License

[MIT](LICENSE)
