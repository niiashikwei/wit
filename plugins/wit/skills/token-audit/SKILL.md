---
name: token-audit
description: Audit a project's Claude Code setup and local usage metrics for token waste, and show what the self-tuner has learned. Use when the user asks to reduce tokens/cost, audit context, check token usage, or run /token-audit.
---
# Token audit

Run the bundled scripts (they live in this skill's `scripts/` folder; tuner is in the plugin's `scripts/`). They are deterministic, so don't re-derive their findings by reading files yourself.

1. `python3 <skill-dir>/scripts/audit.py <project-root>`: static findings as JSON (CLAUDE.md size, MCP servers, skills/agents config, large unignored files).
2. `python3 <skill-dir>/scripts/report.py`: privacy-safe usage metrics from `~/.claude/wit/` (token mix, cache hit rate, biggest tool outputs, guard outcomes, tuning history).
3. Optional: `python3 <plugin-root>/scripts/tuner.py --dry-run` previews what the next self-tuning pass would change.

Then hand both outputs to the `token-steward` subagent and present its top fixes to the user. Apply a fix only if the user says so.

Settings the user may want (in `~/.claude/wit/tuning.json`): `pinned: true` freezes auto-tuning; `read_guard.mode` is `off|warn|nudge`. Per-shell overrides: `WIT_GUARD=off`, `WIT_METRICS=off`.
