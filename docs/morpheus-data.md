# Data and definitions

## Sources

| Source | Where | Required | Gives |
|---|---|---|---|
| Session transcripts | `~/.claude/projects/<project path with dashes>*/<session>.jsonl` (the project and its worktrees) | yes (Claude Code writes them) | tool calls and results, skill loads, agent starts, prompts, each reply's tokens and content blocks, hook runs that printed something |
| Subagent transcripts | `…/<session>/subagents/agent-<id>.jsonl` and `.meta.json` | yes | each agent's own calls, tokens, active time, last words (verdict), type, parent agent, depth |
| Setup | `.claude/settings.json`, `settings.local.json`, `skills/*/SKILL.md`, `agents/*.md` in the project and `~/.claude/`; installed plugins under `~/.claude/plugins/` | read if present | what's defined and where; hook events; skill sizes |
| Hook timing log | `<git dir>/morpheus/runs.jsonl` (outside git: `.claude/morpheus/runs.jsonl`) | optional (`morpheus init`) | every hook run's time and exit code |
| Hook events log | `<git dir>/morpheus/events.jsonl` | optional (your hooks write it) | per-rule blocks, warnings and overrides; gates that saw work done without a skill or agent |

`<git dir>` is the repository's common git folder, shared by all worktrees. The older layout `<git dir>/claude-process/` is read too.

### runs.jsonl (one line per hook run)

```json
{"ts":"2026-11-03T10:46:13.758Z","script":"guard","ms":14,"exit":2,"event":"PreToolUse","tool":"Bash","tool_use_id":"toolu_…","session":"…","rule":"optional rule name"}
```

Exit 0 is ok, 2 is a block, anything else is an error. A line with a `tool_use_id` merges with the transcript's record of the same run.

### events.jsonl (one line per rule decision)

```json
{"ts":"2026-11-03T10:00:00Z","hook":"<rule name>","type":"block|warn|override|timeout","branch":"main","detail":"what it saw"}
```

For an override, start `detail` with the variable's name (`SKIP_CHECKS: …`): the rule table names it. For a gate, use `skill <name>: …` or `agent <name>: …`, and Coverage counts a miss for that skill or agent.

## Definitions

- **Hook run:** one execution of one hook script for one event. Without the timing log, only runs that printed something are known. Each hook switches to the timing log from its first timed run.
- **Time budget** (by event):
  - PreToolUse and PermissionRequest: 1 s;
  - UserPromptSubmit: 2 s;
  - PostToolUse: 10 s;
  - SessionStart and PreCompact: 15 s;
  - SubagentStop: 30 s;
  - Stop: 60 s.

  A hook's p95 over its budget is shown in red, and becomes an improvement after 5 or more runs.
- **Worked around:** a PreToolUse block followed within 3 minutes, in the same session, by a tool call that passed.
- **Hint followed:** a UserPromptSubmit hook's added text names a known skill, and one of the skills it names was loaded in that session before the next prompt (or earlier in the session).
- **Agent time:** active time, which is the sum of gaps between its transcript lines, leaving out gaps over 15 minutes.
- **Verdict:** the last line of an agent's final message that reads `VERDICT: <one word>`.
- **Coverage status:**
  - **active** if it ran in range;
  - **missed** if a gate's warning or block for it came after its last use;
  - **idle** if nothing called for it;
  - **off** if switched off.

### Tokens

- **Each reply is counted once.** Claude Code writes one transcript line per content block and repeats the reply's full `usage` on each, so Morpheus keys a reply by its message id. Summing per line overcounts about 2–3×.
- **New tokens** are input, plus cache writes, plus output. **Cached reads** (the same context read again each turn) are kept apart.
- **Work, orchestration and replies:**
  - A reply with tool calls splits its tokens between work and orchestration in proportion to its tool calls of each kind.
  - A reply with no tool calls counts as **replies** (text to you or to a parent agent).
- **Orchestration tools:**
  - the coordination tools: Agent, Task*, SendMessage, ListAgents, ReadNotifications, ScheduleWakeup, ToolSearch, Skill, TodoWrite, AskUserQuestion, Enter/ExitPlanMode, Enter/ExitWorktree, SubagentHandback, Monitor, Cron*, PushNotification, SendUserFile;
  - any `mcp__ccd_*`, `mcp__scheduled-tasks__*` or Morpheus tool;
  - Bash commands that only look or wait: `git fetch|log|status|show|diff|rev-parse|ls-remote|worktree list|branch --show-current`, `gh run|pr list|view|watch|checks`, read-only `gh api`, `date`, `sleep`.

  The Bash commands may have `cd`, `echo` and `timeout N` around them, and may be piped through read-only filters (`head`, `tail`, `grep`, `jq`, `wc`, `sort` without `-o`, `uniq`, `cut`, `tr`, `column`, `sed -n` without `w`). A redirect, `$(…)`, backticks or a background `&` outside quotes makes the command **work**.
- **Context estimates:**
  - Hooks: the characters a hook printed ÷ 4. This is an upper bound, because not every event's output reaches the model.
  - Skills: loads × SKILL.md bytes ÷ 4.

## Improvements

Each rule turns a measured problem into a proposal with evidence:

```
ROI = (minutes saved a week + 30 × risk) / hours of work
```

Risk runs from 0 to 3: how much the problem lets slip through. The rules cover these areas:

| Area | Rules |
|---|---|
| Hooks | Slow against the event budget; timing out or failing; a hook wired but silent for a day while sessions ran. |
| Rules | Blocks mostly worked around; repeated overrides. |
| Skills | Hints mostly ignored; skills never loaded (project-defined only); heavy skills loaded often. |
| Agents | Costly agents (over 150k new tokens a run); agents whose own tokens are over 40% orchestration; review agents that never give a verdict; project agents never run. |
| Tools and hooks | Tools that fail 25% of the time or more; hooks that add over 50k tokens of output a week. |
| Setup | Hook timing switched off while hooks are wired. |

## SDLC sources and definitions

| Source | Where | Gives |
|---|---|---|
| git | the project's repository, read with `git log --numstat` from the main branch (main, master or trunk, or `mainBranch`) | commits, files and lines, landings on main, Claude co-authorship, reverts, tags |
| Test reports | JUnit XML, lcov, Cobertura, JaCoCo, coverage.py JSON, Istanbul JSON, Go profiles in their usual output paths, plus `coverageReports` / `testReports` | test results and times, line and branch coverage per file, kept per version (by content hash, newest 60) |
| Test source | test files by language convention | every test, its class or `describe`, and tags above it (`// @req R12`, `@req("R1")`, `@feature(x)`) |
| `ps`, the OS | sampled every 5 s while the Resources tab is open; `du` every 10 min | CPU and memory per process group, machine load, memory and free disk, disk footprint |
| GitHub (opt-in) | `gh run list`, `gh api …/deployments`, `gh issue list --label incident` | CI runs, deployments and their status, incidents |

- **Deploy:** per `deploy` in `.claude/wit.json`: each landed commit (`main`), matching tags (`tag:<glob>`), GitHub deployments, or successful runs of a GitHub workflow.
- **Lead time:** a deploy's time minus when its work started: for a merge, the earliest author time of the commits it brought in; for a squash or direct commit, its author time; for a tag, the median over the commits since the previous tag.
- **Failed deploy:** a revert of a commit it shipped, or a hotfix/rollback commit or an incident after it, within `failureWindowHours` (72 h); or its own failed status. **Time to restore** runs to the fix (or the incident's close, or the next good deploy).
- **Bands** (State of DevOps): frequency daily+/weekly+/monthly+; lead time < 1 day / < 1 week / < 1 month; failure rate ≤ 5% / 10% / 15%; restore < 1 h / < 1 day / < 1 week.
- **Layers:** `layers` globs first, then folders and names: `e2e/`, `cypress/`, `playwright/`, `*.e2e.*`, `*.cy.*` are end-to-end; `integration/`, `it/`, `*.int.*`, `*IT.java` are integration; the rest unit.
- **Coverage per node:** a layer's own report when one is tagged with it; for a module, file or class, the files its tests target by name (`test_cart.py` → `cart.py`, `cart.test.ts` → `cart.ts`), preferring a matching folder; for the whole suite, a layer or a feature, all the code measured. Each node says which it is.
- **Flaky:** both passed and failed in the last 30 days of results.
- **Task:** a prompt to the next prompt in the same session, with its agents. Category from the prompt's words, else from what it touched. **Corrected:** the next prompt pushes back ("no", "undo", "actually", an interrupt).
- **Cost:** Anthropic's list prices per million tokens by model (cache writes 1.25× input, cache reads at the model's read price); an estimate.
- **Rework:** for each commit's added lines in a code file, the lines later commits deleted from that file within 14 days, at most the lines added.
- **Hotspots:** code files ranked by commits × churn in range, with their size now.

