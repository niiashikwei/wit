#!/usr/bin/env python3
"""token-optimizer hook runtime.

Privacy contract: everything stays on this machine under TOKEN_OPT_HOME. We record
only counts, byte sizes, tool names, file extensions, coarse command families from an
allowlist, and salted hashes of paths/sessions/projects. Never prompts, file contents,
file paths, full commands, or tool outputs. TOKEN_METRICS=off disables recording.

Usage: tok.py <session_start|pre_read|pre_bash|post_tool|pre_compact|session_end>
Hooks must never break the session: every failure path exits 0 silently.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

DATA = os.path.expanduser(os.environ.get("TOKEN_OPT_HOME", "~/.claude/token-optimizer"))
METRICS = os.path.join(DATA, "metrics.jsonl")
TUNING = os.path.join(DATA, "tuning.json")
STATE = os.path.join(DATA, "state")

DEFAULTS = {
    "version": 1,
    "pinned": False,  # true = tuner reports but never changes settings
    "read_guard": {"mode": "warn", "max_lines": 800},  # mode: off | warn | nudge
    "bash": {"noisy_bytes": 20000, "noisy_families": {}},
    "claude_md_max_lines": 200,
    "tips": [],
    "history": [],
}

# Command families we may record. Anything else is logged as "other" so custom
# script names (which can be identifying) never reach the metrics file.
FAMILIES = {
    "npm", "npx", "pnpm", "yarn", "bun", "node", "tsc", "jest", "vitest", "eslint",
    "python", "python3", "pytest", "pip", "uv", "poetry", "ruff", "mypy",
    "go", "cargo", "make", "mvn", "gradle", "dotnet", "swift", "xcodebuild",
    "git", "gh", "docker", "kubectl", "terraform", "helm",
    "ls", "cat", "find", "grep", "rg", "tree", "du", "head", "tail", "sed", "awk", "curl",
    "bundle", "rspec", "rails", "php", "composer",
}
SUBCOMMANDS = {"test", "install", "build", "run", "log", "diff", "status", "show",
               "lint", "check", "ls", "logs", "describe", "get", "plan", "apply", "ci"}


def _read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def load_tuning():
    t = _read_json(TUNING, {})
    merged = json.loads(json.dumps(DEFAULTS))
    for k, v in t.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k].update(v)
        else:
            merged[k] = v
    return merged


def save_tuning(t):
    os.makedirs(DATA, exist_ok=True)
    tmp = TUNING + ".tmp"
    with open(tmp, "w") as f:
        json.dump(t, f, indent=2)
    os.replace(tmp, TUNING)


def _salt():
    path = os.path.join(DATA, ".salt")
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        os.makedirs(DATA, exist_ok=True)
        s = os.urandom(16).hex()
        with open(path, "w") as f:
            f.write(s)
        os.chmod(path, 0o600)
        return s


def h(value):
    """Salted, truncated hash: stable on this machine, meaningless elsewhere."""
    return hashlib.sha256((_salt() + str(value)).encode()).hexdigest()[:12]


def log(event):
    if os.environ.get("TOKEN_METRICS", "on").lower() == "off":
        return
    os.makedirs(DATA, exist_ok=True)
    event["ts"] = int(time.time())
    with open(METRICS, "a") as f:
        f.write(json.dumps(event, separators=(",", ":")) + "\n")


def emit(event_name, system_message=None, **fields):
    out = {"hookSpecificOutput": {"hookEventName": event_name, **fields}}
    if system_message:
        out["systemMessage"] = system_message  # shown to the user, not the model
    sys.stdout.write(json.dumps(out))


# Per-session state: pending nudges/hints awaiting an outcome, plus the running
# savings total the statusline displays.
def load_state(sid):
    s = _read_json(os.path.join(STATE, sid + ".json"), {})
    s.setdefault("denied", {})     # path hash -> estimated tokens of the full read
    s.setdefault("bash_warn", {})  # family -> learned average output bytes
    s.setdefault("saved", 0)
    return s


def save_state(sid, s):
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, sid + ".json"), "w") as f:
        json.dump(s, f)


def record_saving(sid, s, kind, tokens):
    """Savings are estimates (~4 bytes/token) counted once, so they're a lower
    bound: avoided output would otherwise be re-sent on every later turn."""
    if tokens <= 0:
        return
    s["saved"] += tokens
    log({"e": "saved", "s": sid, "k": kind, "tok": tokens})


def fmt_tokens(n):
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def guard_mode(t):
    return os.environ.get("TOKEN_GUARD", t["read_guard"]["mode"]).lower()


def count_lines(path, cap=20 * 1024 * 1024):
    n = 0
    with open(path, "rb") as f:
        read = 0
        while read < cap:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            read += len(chunk)
            n += chunk.count(b"\n")
    return n


def command_family(cmd):
    words = [w for w in re.split(r"\s+", cmd.strip()) if w and not re.match(r"^[A-Z_][A-Z0-9_]*=", w)]
    if not words:
        return "other"
    first = os.path.basename(words[0])
    if first not in FAMILIES:
        return "other"
    if len(words) > 1 and words[1] in SUBCOMMANDS:
        return f"{first} {words[1]}"
    return first


# ---------------------------------------------------------------- handlers

def session_start(inp, t):
    proj = h(inp.get("cwd", os.getcwd()))
    log({"e": "start", "s": h(inp.get("session_id", "")), "p": proj, "src": inp.get("source", "")})
    lines = [
        "Token etiquette (token-optimizer plugin):",
        "- Grep/Glob before Read; read large files with offset/limit.",
        "- Delegate broad codebase searches to the `scout` subagent; delegate routine edits to `implementer`.",
        "- Keep tool output small: quiet/failures-only test flags, pipe long logs through tail.",
        "- Be concise in replies; don't restate file contents you just read.",
    ]
    md = os.path.join(inp.get("cwd", os.getcwd()), "CLAUDE.md")
    try:
        n = count_lines(md)
        if n > t["claude_md_max_lines"]:
            lines.append(f"- CLAUDE.md is {n} lines (loaded every session). Suggest running /token-audit to trim it.")
    except Exception:
        pass
    for tip in t.get("tips", [])[:3]:
        lines.append(f"- Learned: {tip}")
    sv = t.get("savings") or {}
    msg = None
    if sv.get("last_30d"):
        msg = (f"token-optimizer: saved ~{fmt_tokens(sv.get('last_session', 0))} tokens last session, "
               f"~{fmt_tokens(sv['last_30d'])} over the last 30 days ({sv.get('sessions', 0)} sessions).")
    emit("SessionStart", system_message=msg, additionalContext="\n".join(lines))


def pre_read(inp, t):
    ti = inp.get("tool_input", {}) or {}
    fp = ti.get("file_path")
    if not fp:
        return
    sid = h(inp.get("session_id", ""))
    ph = h(fp)
    ext = os.path.splitext(fp)[1][:10].lower()
    if ti.get("limit") or ti.get("offset"):
        log({"e": "read", "s": sid, "ph": ph, "x": ext, "partial": True})
        return
    try:
        size = os.path.getsize(fp)
    except OSError:
        return
    max_lines = int(t["read_guard"]["max_lines"])
    # Fast path: small files can't exceed the threshold (~25 bytes/line floor).
    lines = count_lines(fp) if size > max_lines * 25 else 0
    big = lines > max_lines
    log({"e": "read", "s": sid, "ph": ph, "x": ext, "partial": False, "lines": lines, "big": big})
    mode = guard_mode(t)
    if not big or mode == "off" or ext in (".ipynb", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"):
        return
    msg = (f"This file has {lines} lines (guard threshold {max_lines}). Prefer Grep to locate the "
           f"relevant section, then Read with offset/limit.")
    if mode == "nudge":
        s = load_state(sid)
        if ph in s["denied"] or ph in s.get("overridden", []):
            # Escape hatch: a second full read of the same file is always allowed.
            s["denied"].pop(ph, None)
            s.setdefault("overridden", []).append(ph)
            save_state(sid, s)
            log({"e": "guard", "s": sid, "ph": ph, "r": "read", "d": "override", "lines": lines})
            return
        s["denied"][ph] = size // 4
        save_state(sid, s)
        log({"e": "guard", "s": sid, "ph": ph, "r": "read", "d": "deny", "lines": lines})
        emit("PreToolUse", permissionDecision="deny",
             permissionDecisionReason=msg + " If you truly need the whole file, request the same Read again and it will be allowed.")
        return
    log({"e": "guard", "s": sid, "ph": ph, "r": "read", "d": "warn", "lines": lines})
    emit("PreToolUse", additionalContext=msg + " Next time, read only what you need.")


def pre_bash(inp, t):
    cmd = (inp.get("tool_input", {}) or {}).get("command", "")
    fam = command_family(cmd)
    noisy = t["bash"]["noisy_families"]
    if fam in noisy and "| tail" not in cmd and "| head" not in cmd and " -q" not in cmd:
        sid = h(inp.get("session_id", ""))
        s = load_state(sid)
        s["bash_warn"][fam] = noisy[fam]
        save_state(sid, s)
        log({"e": "guard", "s": sid, "r": "bash", "f": fam, "d": "warn"})
        emit("PreToolUse", additionalContext=(
            f"`{fam}` output has averaged ~{noisy[fam] // 1000}KB here. Prefer quiet or failures-only flags, "
            "or pipe through `| tail -n 60`, unless you need the full output."))


def post_tool(inp, t):
    name = inp.get("tool_name", "")
    resp = inp.get("tool_response")
    try:
        size = len(json.dumps(resp)) if not isinstance(resp, str) else len(resp)
    except Exception:
        size = 0
    sid = h(inp.get("session_id", ""))
    ev = {"e": "tool", "s": sid, "t": name, "b": size}
    ti = inp.get("tool_input", {}) or {}
    s = None
    if name == "Bash":
        ev["f"] = command_family(ti.get("command", ""))
        s = load_state(sid)
        avg = s["bash_warn"].pop(ev["f"], None)
        if avg is not None:  # first run of a hinted family: compare to its usual size
            record_saving(sid, s, "bash", (avg - size) // 4)
    elif name == "Read" and ti.get("file_path"):
        ev["ph"] = h(ti["file_path"])
        s = load_state(sid)
        full = s["denied"].pop(ev["ph"], None)
        if full is not None and (ti.get("limit") or ti.get("offset")):
            record_saving(sid, s, "read", full - size // 4)
    elif name in ("Agent", "Task") and str(ti.get("subagent_type", "")).endswith(("scout", "implementer")):
        # Not a token saving, but work kept out of the main (pricier) context.
        log({"e": "offload", "s": sid, "a": ti["subagent_type"].split(":")[-1], "b": size})
    if s is not None:
        save_state(sid, s)
    log(ev)


def pre_compact(inp, t):
    log({"e": "compact", "s": h(inp.get("session_id", "")), "trigger": inp.get("trigger", "")})


def session_end(inp, t):
    # Hand off to the tuner in the background so session exit never waits on it.
    tuner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tuner.py")
    args = [sys.executable, "-S", tuner, "--session", inp.get("session_id", ""),
            "--transcript", inp.get("transcript_path", ""), "--cwd", inp.get("cwd", "")]
    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


HANDLERS = {f.__name__: f for f in (session_start, pre_read, pre_bash, post_tool, pre_compact, session_end)}


def main():
    try:
        inp = json.load(sys.stdin)
    except Exception:
        inp = {}
    try:
        HANDLERS[sys.argv[1]](inp, load_tuning())
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
