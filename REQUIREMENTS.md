# Wit requirements

Every requirement has an ID. Tests declare which IDs they verify with `@req("R…")`, and `tests/test_traceability.py` fails the build if any requirement has no test or a test cites an unknown ID. Print the full matrix with `python3 tests/traceability.py`.

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
| R6 | Metrics never contain file paths, file contents, prompts, full commands or tool output. Paths/sessions/projects are stored as salted hashes. The salt is random per machine and stored with `0600` permissions. Command families come from a fixed allowlist; everything else is recorded as `other`. Tool names (built-in and MCP, e.g. `mcp__server__tool`) are recorded so tips can name heavy tools, but never their inputs. |
| R7 | `WIT_METRICS=off` records nothing. |
| R8 | Wit makes no network calls: no networking modules are imported by any shipped script. |

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
