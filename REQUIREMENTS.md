# Wit requirements

Wit is one plugin with two parts: the **token optimizer** (Python hooks and scripts, R1–R22) and **Morpheus**, the live process dashboard (Node, R23–R34).

Every requirement has an ID. Python tests declare which IDs they verify with `@req("R…")`; Morpheus's tests (`plugins/wit/morpheus/test/*.test.ts`) carry a `// @req R…` line above each `test(`. `tests/test_traceability.py` fails the build if any requirement has no test, a test cites an unknown ID, or a Morpheus test has no tag, and `tests/test_traceability.py` fails the build if any requirement has no test or a test cites an unknown ID. Print the full matrix with `python3 tests/traceability.py`.

## Context shaping

| ID | Requirement |
|---|---|
| R1 | At session start, Wit injects a short token-etiquette brief (≤ 1,200 chars), up to 3 learned tips, and a warning when the project's CLAUDE.md exceeds the configured line limit. |
| R2 | Reads of small files, and ranged reads (`offset`/`limit`) of any file, pass silently. A full read of a file above the line threshold triggers the guard. Binary/notebook/image files are never guarded. |
| R3 | In `nudge` mode the guard denies the first full read of a large file per session and **always allows** a repeat attempt, so it can never block work. |
| R4 | Guard mode is `off`, `warn` (default) or `nudge`, set in `tuning.json` and overridable per shell with `WIT_GUARD`. `off` disables the guard. |
| R5 | Bash hints fire only for command families learned to be noisy, and not when the command already limits output (`-q`, `\| tail`, `\| head`). Hints never deny. |

## Privacy

| ID | Requirement |
|---|---|
| R6 | The token optimizer's metrics never contain file paths, file contents, prompts, full commands or tool output. Paths/sessions/projects are stored as salted hashes. The salt is random per machine and stored with `0600` permissions. Command families come from a fixed allowlist; everything else is recorded as `other`. Tool names (built-in and MCP, e.g. `mcp__server__tool`) are recorded so tips can name heavy tools, but never their inputs. |
| R7 | `WIT_METRICS=off` records nothing. |
| R8 | The token optimizer makes no network calls: no networking modules are imported by any shipped Python script. |

R6–R8 cover the token optimizer. Morpheus reads Claude Code's transcripts and keeps short, masked excerpts for its drill-downs; its privacy rules are R30–R31.

## Self-tuning

| ID | Requirement |
|---|---|
| R9 | The tuner adapts the read guard from outcomes: it promotes `warn`→`nudge` when large full reads persist (≥ 2/session over ≥ 5 sessions), loosens the threshold ×1.25 when > 40% of nudges are overridden, falls back to `warn` above 60%, and tightens ×0.9 below 10%, within bounds 400–4000 lines and only with ≥ 8 nudges of evidence. |
| R10 | The tuner learns noisy Bash families (≥ 3 samples, average > `noisy_bytes`) and forgets families that become quiet. |
| R11 | Every tuning change is logged in `history` with a reason (capped at 50 entries). `pinned: true` freezes settings (savings still update). `--dry-run` writes nothing. |
| R22 | The tuner regenerates up to 4 learned tips from metrics: a tool producing > 40% of output bytes, an MCP tool averaging > 10 KB/call (≥ 3 calls), a cache hit rate < 50% (≥ 3 sessions), > 85% of output on Opus, and > 0.5 compactions per session. |
| R12 | The tuner summarizes each finished session's token usage from its transcript, counting numbers only and de-duplicating repeated message IDs. |

## Savings reporting

| ID | Requirement |
|---|---|
| R13 | Savings are counted only for heeded interventions: an accepted nudge (full size minus the ranged read actually done) and a heeded Bash hint (learned average minus actual output). Overridden nudges, and negative differences, count zero. |
| R14 | Savings are shown to the user at session start (last session + 30-day total), live in the statusline, and in the `/token-audit` report. |

## Audit and reporting

| ID | Requirement |
|---|---|
| R15 | `audit.py` reports an oversized CLAUDE.md (including `@imports`), > 5 MCP servers, agents without `model:`, over-long skill descriptions, and large/generated files not denied in settings, as JSON ranked by severity. |
| R16 | `report.py` summarizes sessions, cache hit rate, tool output sizes, guard outcomes, savings and tuning history, and handles having no data. |

## Reliability and performance

| ID | Requirement |
|---|---|
| R17 | Hooks never break a session: on malformed input, missing files, or an unwritable data directory they exit 0 with no output. |
| R18 | Storage is bounded: metrics are trimmed to the most recent 20,000 lines, and per-session state older than 2 days is deleted. |
| R19 | Hook latency: p95 per invocation ≤ 150 ms (typically ~30 ms; shared CI runners use a 250 ms budget via `WIT_PERF_BUDGET_MS`); `session_end` returns in ≤ 150 ms by handing tuning to a background process. |
| R20 | The guard stays fast on huge files (line counting capped at 20 MB, ≤ 300 ms on a 50 MB file), and the tuner processes a full 20,000-line metrics file in ≤ 2 s. |

## Packaging

| ID | Requirement |
|---|---|
| R21 | Plugin and marketplace manifests are valid JSON with matching names; every hook command points at a script that exists; agents and skills have valid frontmatter (`name`, `description`), and every agent pins a cheaper `model`. |

## Process dashboard (Morpheus)

| ID | Requirement |
|---|---|
| R23 | Morpheus reads only files Claude Code already writes (session and subagent transcripts, the `.claude/` setup, optional hook logs), so it works for any project in any language with nothing installed in the project. Ingest is incremental and idempotent: reading again changes nothing, a half-written line waits, a shorter file starts over, a character split across reads isn't lost, a finished run stays finished, and each reply's tokens count once however many lines it spans. |
| R24 | Hooks are named by their script. Their runs, time, verdicts, blocks and overrides come from the hook timing log (`runs.jsonl`) and decision log (`events.jsonl`) when present, else from the transcripts; one hook's timing log doesn't hide another hook's transcript records, and a session's rule table counts only that session's blocks. |
| R25 | The overview and tables give sessions, hints followed (a hint counts when its skill was loaded earlier in the session), blocks, agent active time and tokens, and p50/p95/max per hook, rule, skill, agent and tool (MCP tools grouped by server), over 1 hour, today, 7 days, 30 days or everything, narrowed to a session, branch or project. |
| R26 | The timeline lists one session's hooks, hints, skills and agents in order, nested agents one level deeper under the call that started them. Coverage lists every hook, rule, skill and agent defined in the project, the user's folder and installed plugins, and marks each active, missed, idle or off; a skill loaded after its gate counts as active again. |
| R27 | Improvements are ranked by return on effort, each with its evidence, the fix, minutes saved a week, risk and effort. Rules: hooks wired without timing (set up first, and no silent-hook alarm before timing exists), hooks slow against their event's budget, tools that often fail, the project's own unused skills and agents, work done without its skill or agent, review agents without verdicts, agents that mostly coordinate, chatty hooks and heavy skills. With nothing wrong, the list is empty. |
| R28 | Tokens split into work, orchestration (coordination tools, commands that only look or wait) and replies, by session (its own apart from its agents'), by agent type (nested agents under the type that started them) and per day. Hook context is estimated as output chars ÷ 4 and skill context as loads × SKILL.md size ÷ 4, both labelled estimates. |
| R29 | The MCP server (stdio) answers `initialize`, lists only read-only tools (`morpheus_overview`, `_live`, `_items`, `_item`, `_timeline`, `_coverage`, `_tokens`, `_inventory`, `_projects`, `_health`, `_dora`, `_tests`, `_tasks`, `_resources`, `_quality`) and returns structured results as objects. |
| R30 | Morpheus keeps commands and hook output only as short excerpts with secret-shaped strings masked (mysql-style `-p` passwords too, while other `-p` flags stay readable), prompts only as short excerpts, and never stores an agent's message bodies, only its verdict. Its store is local: one SQLite file per project. |
| R31 | Morpheus makes no outbound network calls of its own; the only network access is through the `gh` CLI, and only when the project opts in (R37). Its web server binds to 127.0.0.1 and refuses requests not addressed to localhost (DNS rebinding). |
| R32 | `morpheus init` routes each simple hook command in `.claude/settings.json` and `settings.local.json` through the hook timer, leaves commands with shell operators alone, never wraps twice, and `--undo` restores them. The timer passes the hook's stdin, stdout, stderr and exit code through untouched and logs one JSON line per run. |
| R33 | The CLI (`serve`, `report`, `mcp`, `init`, `ingest`, `projects`) reads its flags (`--port`, `--range`, `--project`, `--open`, `--port=…`); the project defaults to the git repository's main checkout, so worktrees count as one project. |
| R34 | The plugin wires the `morpheus` MCP server to `morpheus/dist/cli.js`, which is committed and built from `morpheus/src` (CI fails if `dist/` differs); the dashboard page and hook timer ship with it; `/wit:dashboard` and `/wit:process-report` call the same CLI. |

## SDLC dashboard

| ID | Requirement |
|---|---|
| R35 | Wit reads the project's git history with `git` (never a shell): commits reachable from the main branch with their files and line counts, which landed on main, whether Claude co-authored them (Co-Authored-By trailer or Claude Code footer) and what they revert. Reading is incremental, and starts over when history is rewritten. Optional `.claude/wit.json` settings are validated: unknown keys and values of the wrong shape fall back to defaults. |
| R36 | DORA metrics (deployment frequency, lead time for changes, change failure rate, time to restore) come with their State of DevOps bands and a weekly trend. A deploy is each change landing on main, matching tags, GitHub deployments or a GitHub workflow, as configured; it fails when a revert of what it shipped, a hotfix or rollback, a failed status or an incident follows within the failure window. |
| R37 | GitHub data (CI runs, deployments, incident issues) is read through the `gh` CLI only when `.claude/wit.json` sets `"gh": true`, at most every ten minutes; with it off no `gh` process runs, and a missing or signed-out `gh` is skipped silently. |
| R38 | Test results and coverage are read from the reports test runs leave (JUnit XML, lcov, Cobertura, JaCoCo, coverage.py JSON, Istanbul JSON, Go cover profiles) in the usual output paths or configured ones. Each version of a report is kept once, by content hash, with a bounded history. |
| R39 | The testing pyramid lists every test found in the source (Python, JS/TS, Go, Java/Kotlin, Ruby, Rust, C#) joined with its latest result, classified into unit, integration and end-to-end by configured globs then conventions, and grouped by layer → module → file → class → test or by feature (configured globs, requirement tags, else module). Every level gives test count, results, flaky tests, time and the coverage of the code its tests target, saying which coverage it is. |
| R40 | A task is one prompt and everything until the next prompt in its session, its agents included. Each task gets a category (feature, bugfix, test, refactor, docs, review, explore, ops, chore, status, approve, interrupt), new and cached tokens, an estimated cost from list prices (cache writes and reads priced apart), time, tool calls and errors, and whether the next prompt corrected it; totals come by category, model and day. |
| R41 | Resource use is sampled from `ps` and the OS: CPU and memory of Claude Code, its MCP servers, hooks and other commands, and Wit itself, plus the machine's load, memory and free disk. Command lines are read only to tell processes apart and never stored. The project's disk footprint is measured at most every ten minutes. Samples older than a week are averaged to one an hour and dropped after 90 days. Test and build commands Claude ran are timed. |
| R42 | Quality and AI effectiveness: AI co-authored share of commits and lines, AI lines redone within 14 days against everyone else's, tokens and cost per AI commit and line, cache hit rate, corrections, interrupts, permission denials, compactions, tool error rate, test-to-code ratio, churn hotspots and coverage of changed code. |
| R43 | The health scorecard grades each SDLC stage (plan, code, review, test, build and CI, deploy, operate, AI efficiency) good, needs a look, bad or no data, as its worst measured metric, shows each metric's target, and says how to turn on a stage with no data; never-run tests count as no data. |
| R44 | The dashboard is one page with tabs (Status, Health, Delivery, Tests, Tokens & cost, AI effectiveness, Quality, Resources, Hooks & agents) that works from the local server and as a claude.ai artifact through the MCP server. Its views are pure functions from tool data to HTML, built from `web/src` into the single `web/dashboard.html`; each tab reads only its own tools; state is never shown by colour alone. |
| R45 | CI fails when unit-test coverage drops below 99% of lines, branches and functions for the Node code (server, collectors, metrics and the dashboard's modules). |

## Long-running and orchestrating sessions

Learned from a 13-day session that ran agents across 30 worktrees: what Wit must get right when one session does the work of many.

| ID | Requirement |
|---|---|
| R46 | A session that moved between worktrees has a copy of its transcript in each worktree's folder. Wit reads only the largest copy of each session's and each agent's transcript, so every line counts once and is read once; agent meta files are read after every transcript. |
| R47 | Wit reads from transcripts: Stop and SubagentStop hooks from their summary lines (each command's time, and whether it failed or stopped the turn), failed API calls the session retried, turns where Claude worked too long without a word, and the pull requests a session opened or worked on (one row each, with when it was first and last seen). |
| R48 | Every reply re-reads the whole conversation, so Wit measures the context carried per reply, by session and in total, and what re-reading it costs (and its share of the bill). The AI stage of the health scorecard is graded on context per reply (≤ 150k tokens good, ≤ 300k needs a look) rather than on compactions, which shrink it. Sessions over 200k tokens a reply with 50 or more replies are listed, heaviest cache-read bill first, and raise one improvement to start fresh sessions sooner. The AI tab shows these with API errors, quiet turns and pull requests. |
| R49 | The main branch is the remote's default branch (`origin/HEAD`), else main, master or trunk, read from whichever of the local and remote copies is ahead. The deploy rule defaults to `auto`: release tags (v1.2, 1.2.3, release-4) when the project has two or more, else each change landing on main; a rule set in `.claude/wit.json` is kept, and the Delivery tab says when the rule was picked automatically. |
| R50 | Reports are also found in a monorepo's packages (the folders `package.json` `workspaces` names, else apps, packages, libs, services, modules and crates) and in the project's worktrees under `.claude/worktrees` (the 20 most recently changed), the newest copy of each report path winning. Paths in a report are mapped to the project: absolute paths made relative (a worktree's path counts as the project's), and paths relative to the report's package joined to it. Jest and Vitest JSON results are read too. |
| R51 | Task categories include status (asking where things stand) and approve (a go-ahead or an answer); a go-ahead whose task edited files is categorised by those edits. |
| R52 | Cost is summed by git branch across sessions and the agents they started (each reply records its branch), most expensive first, with replies, new and cached tokens and sessions; replies with no branch are shown as such. |
| R53 | The time hooks hold the work up (UserPromptSubmit, PreToolUse, PermissionRequest, Stop and SubagentStop hooks) is totalled and given per prompt, graded against 10 and 30 seconds. |
| R54 | Wit reads from transcripts the name each session was given, work started to run on its own (background commands and agents, monitors) with its task id, the notices that say it finished, failed, was stopped or reported an event, and what Claude asked the person (a question, a plan to approve, a go-ahead and whether the session stops until it is answered); a question or plan is answered by its result, a go-ahead by the person's next prompt. |
| R55 | A Status tab, first in the dashboard, and a `morpheus_status` tool say where things stand without asking Claude: what waits on the person (the newest unanswered ask per session, and sessions whose API calls are failing), oldest first; work running on its own with when it should finish (the median of earlier completed runs of the same kind of work, overdue past their 90th percentile, nothing given with fewer than two), monitors with their newest event (stopped after 30 minutes), foreground agents still writing, and CI still running; the sessions active in the last day with their state (waiting, working, idle), branch, worktree and last prompt; and what finished in the last six hours. The tab reads it again every ten seconds while open. |
| R56 | Wit measures how long sessions sat stopped waiting on the person: each blocking ask (a question or plan until its answer, a go-ahead until the person's next prompt), with the total, the median and 90th-percentile wait, the longest, and how many waited over 15 minutes. When three or more waited that long and the 90th percentile is past it, an improvement suggests notifications and batching questions. The AI tab shows the time waited and the usual time to answer. |
| R57 | Wit keeps each background shell command next to its description and names the step it runs by its script or tool and subcommand (`bash scripts/ship.sh full --fast` is "ship.sh full"); commands that only wait or look (poll loops, sleeps, tail) are not steps. The Delivery tab's local pipeline gives, over the DORA range, background runs, the share that failed (runs stopped by hand count as neither), the time failed runs took, and each step's runs, failures, stops, usual time and time lost, most failures first. A step failing three or more times and in at least a fifth of its runs raises an improvement (three at most). |
| R58 | Wit costs each session's main thread next to the agents it started (an agent's reply is one recorded with an agent id or from its own transcript), with the main thread's share overall and per session, for the sessions that started agents. The AI tab shows the share and a table of sessions. |
| R59 | Wit gives each review agent (an agent type with "review" in its name) its runs, approvals, change requests, runs with no verdict, catch rate (change requests among verdicts), cost and cost per change request. A reviewer that approved all of ten or more verdicts raises an improvement. The AI tab lists the reviewers with the overall catch rate. |
| R60 | The Delivery tab gives what Claude cost per deploy over the DORA range: all usage in the range divided by its deploys, none when there were no deploys. |
| R61 | The Review stage counts a change as landed through review by either route: a merge commit or a squash-merged pull request (a subject ending in its number, like "(#12)"), or a review agent's approval. Landed commits within ten minutes of each other are one landing (a rebased or cherry-picked batch), and the agent metric is approvals over landings, capped at all of them; it shows only when a review agent approved something. The stage takes the better of the two. |
| R62 | Generated files (lockfiles, generated database types, snapshots, minified bundles, protobuf and other generated code, `generated/`, `dist/` and `build/` folders, and anything marked `linguist-generated` in `.gitattributes`) are left out of rework, churn hotspots, the test-to-code ratio and coverage of changed code. |
| R63 | Wit keeps Claude Code's own running cost total for each session (its highest), and the AI tab shows it for the sessions active in the range, over their whole life, beside Wit's estimate from token counts for the same sessions and their agents. A compaction's summary is not counted as a prompt. A folder the disk footprint could not size in time is shown as unsized, not as zero, and tried again a day later. |
| R64 | A prompt hook in a Stop summary (prose a model checks, as `/goal` sets) is named "prompt hook" rather than after the event, so it never reads as a second copy of the event's script hooks. |
| R65 | Wit bands the main session's replies (not agents') by the context each carried (under 100k, 100–200k, 200–400k, 400–800k, over 800k tokens) with each band's replies and cost, and prices the cache reads spent on context above 200k as what starting fresh or compacting sooner would have saved, with its share of the main sessions' cost. The heavy-context improvement quotes that figure. |
| R66 | Wit counts the main session's calls that only watch CI or a pull request (`gh run/pr/workflow` watch, view, checks, list or status; `gh api` on check runs, workflow runs, statuses or pulls; poll loops starting with sleep, until or while; Monitor, ScheduleWakeup, TaskOutput and PR tools), each costed as the main-session reply that followed it (the context read again), by kind. Twenty or more such calls costing $5 or more raise an improvement to hand the watching to a background command or a cheap agent. |
| R67 | Wit ranks hooks that ran 100 times or more by the time their runs took above 100 ms (what a fast hook takes), with event, runs and median; a hook on every tool call or prompt (PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit) with a median of 250 ms or more raises an improvement valued at that whole added time, in place of the slow-hook one. The AI tab shows all three levers. |

