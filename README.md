# token-optimizer

A Claude Code plugin that cuts token usage in any project without slowing delivery. It **measures privately, learns from every session, and tunes itself**.

## Install (once, works in every project)

```bash
claude plugin marketplace add ~/projects/token-optimizer
```

```bash
claude plugin install token-optimizer@token-optimizer-marketplace
```

For teams, push this repo to git and use `claude plugin marketplace add <org>/token-optimizer`. You can also list it in a project's `.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`) so everyone gets it automatically.

Optional statusline (model · context % · cache hit % · cost), in `~/.claude/settings.json`:
```json
"statusLine": { "type": "command", "command": "python3 ~/projects/token-optimizer/plugins/token-optimizer/scripts/statusline.py" }
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

Every change is logged with its reason in `~/.claude/token-optimizer/tuning.json` → `history`. Preview the next pass with `python3 plugins/token-optimizer/scripts/tuner.py --dry-run`.

## Tokens saved

The plugin shows its savings in three places:
- **Each new session:** a one-line message, e.g. `token-optimizer: saved ~12.4k tokens last session, ~210.0k over the last 30 days (14 sessions).`
- **Live in the statusline:** `… · saved ~4.2k · …` (needs the statusline setting above).
- **`/token-audit`:** totals broken down by source, plus how much work was offloaded to subagents.

What counts as a saving:
- A **nudged large read** that was followed by a ranged read: full file size minus what was actually read. Overridden nudges count 0.
- A **bash hint** that was heeded: the family's learned average output minus the actual output.

These are **conservative estimates** (~4 bytes/token, each counted once). In reality, avoided output would also have been re-sent on every later turn. Warn-only hints and subagent delegation aren't counted as savings: subagent work is reported separately, because it moves tokens to cheaper models rather than removing them.

## Privacy

- Metrics are **local only** (`~/.claude/token-optimizer/`) and nothing is sent over the network.
- What's recorded: counts, byte sizes, token totals, tool names, file extensions, and command families from a fixed allowlist (`pytest`, `npm test`… anything else is `other`).
- Paths, sessions and projects are stored as **salted hashes**. The salt is random per machine, so hashes can't be matched elsewhere.
- **Never recorded:** prompts, file contents, paths, full commands, tool outputs. This is checked by `tests/test_plugin.py::test_privacy_no_paths_or_commands_recorded`.

## Controls

| Setting | Effect |
|---|---|
| `TOKEN_GUARD=off\|warn\|nudge` (env) | Override the guard mode for a shell |
| `TOKEN_METRICS=off` (env) | Record nothing |
| `"pinned": true` in `tuning.json` | Freeze auto-tuning; the tuner only proposes |
| `rm -rf ~/.claude/token-optimizer` | Forget everything |

## Tests

```bash
python3 -m unittest tests/test_plugin.py
```
