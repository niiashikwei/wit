#!/usr/bin/env python3
"""Summarize the local, privacy-safe Wit metrics (numbers only)."""
import json
import os
from collections import defaultdict

DATA = os.path.expanduser(os.environ.get("WIT_HOME", "~/.claude/wit"))


def main():
    events = []
    try:
        with open(os.path.join(DATA, "metrics.jsonl")) as f:
            for line in f:
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        print("No metrics yet. They accumulate as you use Claude Code with the plugin enabled.")
        return
    try:
        with open(os.path.join(DATA, "tuning.json")) as f:
            tuning = json.load(f)
    except (OSError, ValueError):
        tuning = {}

    sessions = [e for e in events if e.get("e") == "session"]
    tot = defaultdict(int)
    for s in sessions:
        for k in ("in", "out", "cr", "cc", "turns"):
            tot[k] += s.get(k, 0)
    prompt = tot["in"] + tot["cr"] + tot["cc"]
    tool_bytes, tool_calls = defaultdict(int), defaultdict(int)
    for e in events:
        if e.get("e") == "tool":
            tool_bytes[e.get("t")] += e.get("b", 0)
            tool_calls[e.get("t")] += 1
    guards = defaultdict(int)
    for e in events:
        if e.get("e") == "guard":
            guards[f'{e.get("r")}:{e.get("d")}'] += 1

    saved = defaultdict(int)
    for e in events:
        if e.get("e") == "saved":
            saved[e.get("k")] += e.get("tok", 0)
    offloaded = [e for e in events if e.get("e") == "offload"]

    report = {
        "sessions": len(sessions),
        "tokens_saved_estimate": {"total": sum(saved.values()), "by_kind": dict(saved),
                                  "note": "lower bound; ~4 bytes/token; counted once though avoided output would be re-sent each later turn"},
        "subagent_offloads": {"calls": len(offloaded), "result_kb_returned": sum(e.get("b", 0) for e in offloaded) // 1000},
        "tokens": dict(tot),
        "cache_hit_rate": round(tot["cr"] / prompt, 3) if prompt else None,
        "top_tool_outputs_kb": {k: v // 1000 for k, v in sorted(tool_bytes.items(), key=lambda kv: -kv[1])[:8]},
        "avg_kb_per_call": {k: tool_bytes[k] // max(1, tool_calls[k]) // 1000 for k in list(tool_bytes)[:8]},
        "guard_outcomes": dict(guards),
        "compactions": sum(1 for e in events if e.get("e") == "compact"),
        "current_tuning": {k: tuning.get(k) for k in ("read_guard", "bash", "pinned", "tips")},
        "recent_tuning_changes": tuning.get("history", [])[-10:],
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
