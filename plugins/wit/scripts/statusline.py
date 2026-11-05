#!/usr/bin/env python3
"""Statusline: model · context used · cache hit · tokens saved · session cost. Reads only usage numbers."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tok  # noqa: E402


def main():
    try:
        inp = json.load(sys.stdin)
    except Exception:
        inp = {}
    model = (inp.get("model") or {}).get("display_name", "?")
    window = (inp.get("context_window") or {}).get("context_window_size") or 200000
    last = None
    try:
        with open(inp.get("transcript_path", "")) as f:
            for line in f:
                if '"usage"' in line:
                    rec = json.loads(line)
                    if rec.get("type") == "assistant":
                        last = rec["message"]["usage"]
    except Exception:
        pass
    parts = [model]
    if last:
        cr = last.get("cache_read_input_tokens", 0) or 0
        ctx = (last.get("input_tokens", 0) or 0) + cr + (last.get("cache_creation_input_tokens", 0) or 0)
        parts.append(f"ctx {ctx * 100 // window}%")
        if ctx:
            parts.append(f"cache {cr * 100 // ctx}%")
    try:
        saved = tok.load_state(tok.h(inp.get("session_id", "")))["saved"]
        if saved:
            parts.append(f"saved ~{tok.fmt_tokens(saved)}")
    except Exception:
        pass
    cost = (inp.get("cost") or {}).get("total_cost_usd")
    if cost is not None:
        parts.append(f"${cost:.2f}")
    print(" · ".join(parts))


if __name__ == "__main__":
    main()
