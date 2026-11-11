# Competitors and prior art (November 2026)

Research done for Morpheus's first release, from public READMEs, docs and comparison articles. Feature lists come from each project's own description and weren't all verified by running them.

## The landscape

Tools that watch Claude Code fall into four groups.

### 1. Usage and cost trackers (transcripts → tokens and dollars)

| Tool | What it does |
|---|---|
| **ccusage** (ryoppippi) | The most established. An npm CLI (`npx ccusage@latest daily`) that reads local transcripts and reports tokens and cost per day, month and session. No setup. |
| **Claude-Code-Usage-Monitor** (`claude-monitor`) | A live terminal view of tokens left in the current plan window, with burn-rate predictions for Pro and Max plans. |
| **Sniffly** | A local web dashboard of Claude Code logs (`sniffly init`): usage stats, error analysis, message history. |
| **claude-usage-analytics**, **claude-usage-analyzer** (Rust), **claude-code-visibility** (Streamlit) | Local dashboards over `~/.claude/projects/**/*.jsonl`: tokens, models, tools and projects over time. |

**Gap:** they answer *how much*, not *how well*. None of them knows what a hook, skill or agent is meant to do, whether it fired when it should, or what to change.

### 2. Real-time session and agent monitors (hooks → live UI)

| Tool | What it does |
|---|---|
| **agents-observe** (simple10, MIT) | A Claude Code plugin whose hooks feed a local SQLite store and a React UI at localhost: what each agent is doing, tool calls, subagent trees. Also supports Codex. |
| **claude-code-hooks-multi-agent-observability** (disler) | Hook events sent to a server and a live web UI: several concurrent agents, session tracking, event filtering, Agent Teams. |
| **Claude-Code-Agent-Monitor** (two projects with this name) | Express, React and WebSocket dashboards with sessions, tool use and agent hierarchy. One also covers Cursor and Codex, token use and cost, and has a Kanban board and native app. |
| **cc-observatory** | Hooks feed FastAPI and SQLite, OpenTelemetry metrics, and Grafana dashboards. |

**Gap:**
- They watch *activity*: which tool ran, now. They don't measure the project's process, such as hook latency against a budget, worked-around blocks, coverage of defined skills and agents, or hint follow-through.
- Most need their hooks installed before they see anything, so there's no backfill of past sessions.
- Several need a separate server stack: Docker, Grafana or Express.

### 3. Skill-specific tools

| Tool | What it does |
|---|---|
| **`/skill-doctor`** (built into Claude Code) | Each skill's context cost and how often it's used. |
| **skill-stats**, **skill-observability**, **skillvitals**, **install-skill-tracker** | Skill activations from hooks or transcripts, dormant skills, per-skill timing, activation tests. |
| **OpenTelemetry `claude_code.skill_activated`** | A built-in event (see group 4). |

**Gap:** skills only. Hooks, agents and tokens are out of their scope.

### 4. Official and enterprise analytics

| Tool | What it does |
|---|---|
| **Claude Code analytics dashboards** (Team and Enterprise: claude.ai; API: the Console) | Organisation-level adoption: daily active users, sessions, lines accepted, spend. Not for individual Pro or Max plans. |
| **Claude Code OpenTelemetry** (beta) | Metrics and events (tokens, cost, tool decisions, skill activations) exported over OTLP to Prometheus and Grafana, SigNoz, Better Stack, OpenObserve and others. Community stacks package the collector, Prometheus, Loki and Grafana. |
| **General LLM observability** (Langfuse, Arize Phoenix, AgentOps, LangSmith, Laminar, Latitude) | Tracing and evaluation platforms for LLM apps. A few can ingest Claude Code traces, but they're built for applications you write, not for your coding agent's process. |

**Gap:**
- They're org- or app-level and need infrastructure: a collector, a backend, accounts.
- Nothing in them understands project hooks, rules, or skill and agent coverage.

## Where Morpheus fits

Morpheus is a **process** dashboard: how well the machinery you added to Claude Code (hooks, rules, skills, agents) is working, and what to change.

| | Usage trackers | Live monitors | Skill tools | OTel / enterprise | **Morpheus** |
|---|---|---|---|---|---|
| Zero setup, backfills history | ✔ | ✘ (hooks first) | some | ✘ | **✔** |
| Live updates | some | ✔ | ✘ | ✔ (with a stack) | **✔** (SSE, ~1 s) |
| Hooks: latency against budget, failures, blocks, workarounds | ✘ | partial | ✘ | partial | **✔** |
| Skills: loads, hints followed, unused, context cost | ✘ | ✘ | ✔ | partial | **✔** |
| Agents: runs, active time, tokens, nesting, verdicts | partial | ✔ | ✘ | partial | **✔** |
| Coverage of what's defined (project, user, plugins) | ✘ | ✘ | partial | ✘ | **✔** |
| Work vs orchestration token split, each reply counted once | ✘ | ✘ | ✘ | ✘ | **✔** |
| Ranked improvements with evidence | ✘ | ✘ | partial | ✘ | **✔** |
| Usable from Claude (MCP) and as a plugin | ✘ | some | some | ✘ | **✔** |
| Runtime dependencies | npm | Node/Python stacks | varies | collector + backend | **none (Node 24 built-ins)** |

## What Morpheus doesn't do yet (roadmap)

- **Dollar cost.** ccusage and others price tokens by model. Morpheus shows tokens (new against cached) but not dollars yet. A model price table would be easy to add, but prices change.
- **Other agents.** Several monitors also read Codex, Cursor or Gemini CLI sessions. Morpheus reads Claude Code only.
- **OpenTelemetry export.** Teams that already run Grafana would want Morpheus's process metrics there too.
- **Evaluations.** Skill tools can test whether a skill activates on the prompts it should. Morpheus only observes real use.

## Sources

- [simple10/agents-observe](https://github.com/simple10/agents-observe) · [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) · [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) · [7P3ng/Claude-Code-Agent-Monitor](https://github.com/7P3ng/Claude-Code-Agent-Monitor) · [cc-observatory](https://pypi.org/project/cc-observatory/)
- [AlSovg/claude-usage-analytics](https://github.com/AlSovg/claude-usage-analytics) · [claude-usage-analyzer](https://github.com/SingggggYee/claude-usage-analyzer) · [sniffly](https://pypi.org/project/sniffly/) · [claude-code-visibility](https://pypi.org/project/claude-code-visibility/) · [Five Claude Code usage dashboards (Torii)](https://www.toriihq.com/articles/five-claude-code-usage-dashboards-and-monitoring-tools) · [Shipyard: tracking Claude Code usage](https://shipyard.build/blog/claude-code-track-usage/)
- [Claude Code monitoring (OpenTelemetry)](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage) · [Claude Code analytics](https://code.claude.com/docs/en/analytics) · [claude-otel](https://github.com/li0nel/claude-otel) · [claude-code-otel](https://github.com/aaraujodata/claude-code-otel) · [SigNoz Claude Code monitoring](https://signoz.io/docs/claude-code-monitoring)
- [Skill invocation tracking (anthropics/claude-code#35319)](https://github.com/anthropics/claude-code/issues/35319) · [skill-stats](https://github.com/aneym/skill-stats) · [skill-observability](https://github.com/EllAchE/skill-observability) · [skillvitals](https://pypi.org/project/skillvitals/) · [Measure plugin cost and usage](https://code.claude.com/docs/en/plugins/measure) · [Scott Spence: skill activation](https://scottspence.com/posts/measuring-claude-code-skill-activation-with-sandboxed-evals)
- [AI agent observability tools compared (Latitude)](https://latitude.so/blog/best-ai-agent-observability-tools-2026-comparison) · [Laminar](https://laminar.sh/article/top-6-agent-observability-platforms) · [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
