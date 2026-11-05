---
name: api-cost-review
description: Review application code that calls the Claude API / Anthropic SDK for token and cost optimizations (prompt caching, batching, model routing, output limits). Use when the user asks to cut API cost or review LLM call sites.
---
# Claude API cost review

1. Find call sites: `rg -n "messages\.create|messages\.stream|batches\.create|cache_control|max_tokens|model=" --glob '!**/node_modules/**'`.
2. For each call site, check (cite `path:line`):
   - **Caching**: is a stable prefix (tools → system → reference docs → few-shot) marked with `cache_control`? Are volatile values (timestamps, IDs, user names) placed *after* it? Any per-request change in the system prompt breaks the cache.
   - **Batch**: is this offline/non-interactive work (evals, backfills, classification, nightly jobs)? Then the Message Batches API is ~50% cheaper.
   - **Model routing**: is a large model doing classification/extraction/routing that a smaller one could do? Suggest a cheap-first, escalate-on-low-confidence pattern.
   - **Output**: is `max_tokens` sized to need? Is structured output / a JSON schema used instead of prose? Is extended thinking budget tuned per task?
   - **Context**: are whole documents or full histories resent where retrieval, summaries, or context editing would do? Are tool results trimmed?
   - **Measurement**: is `response.usage` (incl. `cache_read_input_tokens`) logged?
3. Report a table: location, issue, fix, rough saving. Check current pricing/caching rules with the `claude-api` skill if it is available rather than quoting numbers from memory.
