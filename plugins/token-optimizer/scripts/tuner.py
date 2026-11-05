#!/usr/bin/env python3
"""Self-tuning loop. Runs in the background at SessionEnd (or manually).

1. Summarizes the finished session's token usage from its transcript (numbers only).
2. Re-tunes guard thresholds/modes from observed outcomes:
   - read guard: too many overrides -> loosen (or fall back to warn); rarely
     overridden -> tighten; frequent large full reads in warn mode -> promote to nudge.
   - bash: learns which command families produce large outputs.
3. Regenerates the "learned tips" injected at SessionStart.
Every change is appended to tuning.json["history"] with its reason.
"""
import argparse
import json
import os
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tok  # noqa: E402

WINDOW_DAYS = 14
MAX_METRIC_LINES = 20000


def summarize_transcript(path, session_id, cwd):
    if not path or not os.path.exists(path):
        return
    seen, tot, models = set(), defaultdict(int), defaultdict(int)
    with open(path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            msg = rec.get("message") or {}
            usage = msg.get("usage")
            if rec.get("type") != "assistant" or not usage:
                continue
            mid = msg.get("id") or rec.get("uuid")
            if mid in seen:
                continue
            seen.add(mid)
            tot["in"] += usage.get("input_tokens", 0) or 0
            tot["out"] += usage.get("output_tokens", 0) or 0
            tot["cr"] += usage.get("cache_read_input_tokens", 0) or 0
            tot["cc"] += usage.get("cache_creation_input_tokens", 0) or 0
            models[msg.get("model", "?")] += usage.get("output_tokens", 0) or 0
    if not seen:
        return
    tok.log({"e": "session", "s": tok.h(session_id), "p": tok.h(cwd), "turns": len(seen),
             **tot, "models": dict(models)})


def load_events():
    try:
        with open(tok.METRICS) as f:
            lines = f.readlines()
    except OSError:
        return []
    if len(lines) > MAX_METRIC_LINES:
        lines = lines[-MAX_METRIC_LINES:]
        with open(tok.METRICS, "w") as f:
            f.writelines(lines)
    cutoff = time.time() - WINDOW_DAYS * 86400
    out = []
    for line in lines:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("ts", 0) >= cutoff:
            out.append(ev)
    return out


def retune(t, events):
    changes = []
    rg = t["read_guard"]

    def change(path, old, new, reason):
        changes.append({"ts": int(time.time()), "change": f"{path}: {old} -> {new}", "reason": reason})

    # --- read guard
    guards = [e for e in events if e.get("e") == "guard" and e.get("r") == "read"]
    denies = sum(1 for e in guards if e.get("d") == "deny")
    overrides = sum(1 for e in guards if e.get("d") == "override")
    if rg["mode"] == "nudge" and denies >= 8:
        rate = overrides / denies
        if rate > 0.6:
            change("read_guard.mode", "nudge", "warn", f"{rate:.0%} of nudges were overridden")
            rg["mode"] = "warn"
        elif rate > 0.4:
            new = min(4000, int(rg["max_lines"] * 1.25))
            change("read_guard.max_lines", rg["max_lines"], new, f"override rate {rate:.0%} > 40%")
            rg["max_lines"] = new
        elif rate < 0.1:
            new = max(400, int(rg["max_lines"] * 0.9))
            if new != rg["max_lines"]:
                change("read_guard.max_lines", rg["max_lines"], new, f"override rate {rate:.0%} < 10%")
                rg["max_lines"] = new
    elif rg["mode"] == "warn":
        sessions = {e["s"] for e in events if e.get("e") == "session"}
        big_full = sum(1 for e in events if e.get("e") == "read" and e.get("big"))
        if len(sessions) >= 5 and big_full / len(sessions) >= 2:
            change("read_guard.mode", "warn", "nudge",
                   f"{big_full / len(sessions):.1f} large full-file reads per session despite warnings")
            rg["mode"] = "nudge"

    # --- bash noisy families
    by_fam = defaultdict(list)
    for e in events:
        if e.get("e") == "tool" and e.get("t") == "Bash" and e.get("f", "other") != "other":
            by_fam[e["f"]].append(e.get("b", 0))
    noisy = {}
    for fam, sizes in by_fam.items():
        if len(sizes) >= 3:
            avg = sum(sizes) // len(sizes)
            if avg > t["bash"]["noisy_bytes"]:
                noisy[fam] = avg
    if set(noisy) != set(t["bash"]["noisy_families"]):
        change("bash.noisy_families", sorted(t["bash"]["noisy_families"]), sorted(noisy), "observed output sizes")
    t["bash"]["noisy_families"] = noisy

    # --- learned tips
    t["tips"] = build_tips(events)
    return changes


def build_tips(events):
    tips = []
    tool_bytes = defaultdict(int)
    tool_calls = defaultdict(int)
    for e in events:
        if e.get("e") == "tool":
            tool_bytes[e.get("t", "?")] += e.get("b", 0)
            tool_calls[e.get("t", "?")] += 1
    total = sum(tool_bytes.values())
    if total:
        top, b = max(tool_bytes.items(), key=lambda kv: kv[1])
        if b / total > 0.4:
            tips.append(f"`{top}` produces {b / total:.0%} of tool-output bytes; narrow its inputs/outputs first.")
    for name, b in tool_bytes.items():
        if name.startswith("mcp__") and tool_calls[name] >= 3 and b / tool_calls[name] > 10000:
            tips.append(f"`{name}` averages {b // tool_calls[name] // 1000}KB per call; request fewer fields or paginate.")
            break
    sessions = [e for e in events if e.get("e") == "session"]
    if len(sessions) >= 3:
        cr = sum(e.get("cr", 0) for e in sessions)
        prompt = cr + sum(e.get("in", 0) + e.get("cc", 0) for e in sessions)
        if prompt and cr / prompt < 0.5:
            tips.append(f"Cache hit rate is {cr / prompt:.0%}; avoid editing CLAUDE.md/MCP config mid-session and prefer one long focused session over many restarts.")
        out_by_model = defaultdict(int)
        for e in sessions:
            for m, n in (e.get("models") or {}).items():
                out_by_model[m] += n
        out_total = sum(out_by_model.values())
        opus = sum(n for m, n in out_by_model.items() if "opus" in m)
        if out_total and opus / out_total > 0.85:
            tips.append("Nearly all output is on Opus; hand routine edits to the `implementer` subagent (Sonnet) and searches to `scout` (Haiku).")
    compacts = sum(1 for e in events if e.get("e") == "compact")
    if sessions and compacts / len(sessions) > 0.5:
        tips.append("Sessions often hit compaction; /clear between unrelated tasks and push exploration into subagents.")
    return tips[:4]


def cleanup_state():
    cutoff = time.time() - 2 * 86400
    try:
        for name in os.listdir(tok.STATE):
            p = os.path.join(tok.STATE, name)
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="")
    ap.add_argument("--transcript", default="")
    ap.add_argument("--cwd", default="")
    ap.add_argument("--dry-run", action="store_true", help="print proposed changes, don't save")
    a = ap.parse_args()
    try:
        summarize_transcript(a.transcript, a.session, a.cwd)
    except Exception:
        pass
    t = tok.load_tuning()
    changes = retune(t, load_events())
    if a.dry_run or t.get("pinned"):
        print(json.dumps({"proposed": changes, "tips": t["tips"]}, indent=2))
        return
    t["history"] = (t.get("history", []) + changes)[-50:]
    t["last_tuned"] = int(time.time())
    tok.save_tuning(t)
    cleanup_state()
    if sys.stdout.isatty():
        print(json.dumps({"applied": changes, "tips": t["tips"]}, indent=2))


if __name__ == "__main__":
    main()
