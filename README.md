# Wit

**Wit** is a Claude Code plugin that cuts token usage in any project without slowing delivery. It **measures privately, learns from every session, tunes itself**, and tells you how many tokens it saved.

Requires Claude Code and Python 3 (standard library only).

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

## Privacy

- Metrics are **local only** (`~/.claude/wit/`) and nothing is sent over the network.
- What's recorded: counts, byte sizes, token totals, tool names, file extensions, and command families from a fixed allowlist (`pytest`, `npm test`… anything else is `other`).
- Paths, sessions and projects are stored as **salted hashes**. The salt is random per machine, so hashes can't be matched elsewhere.
- **Never recorded:** prompts, file contents, paths, full commands, tool outputs. This is checked by `tests/test_plugin.py::test_privacy_no_paths_or_commands_recorded`.

## Controls

| Setting | Effect |
|---|---|
| `WIT_GUARD=off\|warn\|nudge` (env) | Override the guard mode for a shell |
| `WIT_METRICS=off` (env) | Record nothing |
| `"pinned": true` in `tuning.json` | Freeze auto-tuning; the tuner only proposes |
| `rm -rf ~/.claude/wit` | Forget everything |

## Tests

```bash
python3 -m unittest tests/test_plugin.py
```

## Testing

Requirements live in [REQUIREMENTS.md](REQUIREMENTS.md) (R1–R22). Every test is tagged with the requirements it verifies, and the build fails if any requirement is untested.

| Suite | Covers |
|---|---|
| `test_guards.py` | Session brief, read guard, nudge escape hatch, guard modes, bash hints (R1–R5) |
| `test_privacy.py` | No paths/contents/commands/prompts recorded, salted hashes, opt-out, no network imports (R6–R8) |
| `test_tuner.py` | Self-tuning rules and bounds, history, pinning, dry-run, transcript summary, learned tips, storage limits (R9–R12, R18, R22) |
| `test_savings.py` | Savings accounting and display, report, audit (R13–R16) |
| `test_robustness.py` | Malformed input, unwritable or corrupt data, unreadable files (R17) |
| `test_performance.py` | Hook latency p50/p95, huge files, full-history tuning (R19–R20) |
| `test_packaging.py` | Manifests, hook wiring, agent/skill frontmatter (R21) |
| `test_traceability.py` | Every requirement has a test |

Tests run the scripts exactly as Claude Code does (a fresh process with JSON on stdin) against an isolated data directory.

```bash
python3 -m unittest discover -s tests -v
```

```bash
python3 tests/traceability.py
```

Coverage (needs `pip install coverage`; CI fails under 90%):
```bash
WIT_COVERAGE=1 python3 -m unittest discover -s tests && python3 -m coverage combine && python3 -m coverage report
```

Measured on an Apple Silicon Mac: every hook p95 ≤ ~55 ms (p50 ~30 ms, mostly Python startup); about 100 ms when session start has a full 20k-event history; 35 ms to guard a 50 MB file; the tuner takes ~110 ms over a full 20k-line metrics file. CI runs on Linux and macOS with Python 3.10–3.13.

## Contributing

Issues and PRs welcome. Run the tests before opening a PR, and keep the privacy contract intact: new metrics may record numbers, tool names and salted hashes only.

## License

[MIT](LICENSE)
