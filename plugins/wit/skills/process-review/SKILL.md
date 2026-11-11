---
name: process-review
description: Use when the user asks how their Claude Code setup is working (hooks, skills, agents, subagents, tokens, orchestration overhead), which hooks are slow or noisy, which skills or agents go unused, or what to improve in their Claude Code process.
---

# Reviewing the Claude Code process with Morpheus

Morpheus's MCP tools (server `morpheus`) answer from the project's own Claude Code transcripts and hook logs. They are read-only and local.

1. Start with `morpheus_overview` (range `7d` unless the user names one). It returns the headline numbers and `improvements`, ranked by ROI with evidence.
2. For token questions, `morpheus_tokens`: work vs orchestration vs replies, by session and agent type, and the context hooks and skills add (estimates).
3. To check whether things fire when they should, `morpheus_coverage`. To dig into one item, `morpheus_item` with its kind and name.
4. For one session's sequence of hooks, skills and agents, `morpheus_timeline`.

Answer with the two or three findings that matter most, each with its number and the change you'd make. Quote numbers as Morpheus gives them; say "estimate" for hook and skill context. If hook timing is off (an improvement says so), suggest running `node "${CLAUDE_PLUGIN_ROOT}/morpheus/dist/cli.js" init` in the project (or `npx github:niiashikwei/wit init`).
