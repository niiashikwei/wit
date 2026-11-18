#!/usr/bin/env python3
"""Wit updates: is a newer version out, and install it.

Wit itself makes no network calls (R8). At most once a day, in the background, the check asks
Claude Code to refresh the marketplace Wit was installed from (`claude plugin marketplace update
<marketplace>`), then reads the plugin's version from that local copy. Updating runs Claude Code's
own `claude plugin update wit@<marketplace>`.

Usage: update.py <check [--force] | apply | auto on|off | status>
Off switches: `"update": {"check": false}` in tuning.json, or WIT_UPDATE_CHECK=off.
Automatic updates: `update.py auto on` (or WIT_AUTO_UPDATE=on).
"""
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
DATA = os.path.expanduser(os.environ.get("WIT_HOME", "~/.claude/wit"))
STATE = os.path.join(DATA, "update.json")
TUNING = os.path.join(DATA, "tuning.json")
DAY = 86400
NAME = "wit"


def _read(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def settings():
    """Whether to check and whether to update on its own: tuning.json, then the environment."""
    u = _read(TUNING, {}).get("update") or {}
    check = u.get("check", True) is not False
    auto = u.get("auto", False) is True
    env_check = os.environ.get("WIT_UPDATE_CHECK", "").lower()
    env_auto = os.environ.get("WIT_AUTO_UPDATE", "").lower()
    if env_check in ("off", "0", "false", "no"):
        check = False
    if env_auto in ("on", "1", "true", "yes"):
        auto = True
    elif env_auto in ("off", "0", "false", "no"):
        auto = False
    return {"check": check, "auto": check and auto}


def version_tuple(v):
    try:
        return tuple(int(x) for x in str(v).strip().lstrip("v").split("."))
    except ValueError:
        return None


def newer(latest, installed):
    a, b = version_tuple(latest), version_tuple(installed)
    return bool(a and b and a > b)


def installed_version():
    return _read(os.path.join(PLUGIN, ".claude-plugin", "plugin.json"), {}).get("version")


def claude_bin():
    return os.environ.get("WIT_CLAUDE_BIN") or shutil.which("claude")


def run_claude(claude, args):
    """Runs one Claude Code command; None when it worked, else what went wrong."""
    try:
        r = subprocess.run([claude, *args], capture_output=True, text=True, timeout=180)
    except Exception as e:
        return f"{' '.join(args[:3])}: {type(e).__name__}"
    if r.returncode != 0:
        return f"{' '.join(args[:3])} failed: {(r.stderr or r.stdout).strip()[:200]}"
    return None


def marketplace():
    """The marketplace this plugin came from: its name and its local copy of Wit's plugin.json."""
    cfg = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"))
    known = _read(os.path.join(cfg, "plugins", "known_marketplaces.json"), {})
    for name, m in known.items():
        loc = m.get("installLocation") or ""
        listing = _read(os.path.join(loc, ".claude-plugin", "marketplace.json"), {})
        entry = next((p for p in listing.get("plugins", []) if p.get("name") == NAME), None)
        if not entry or not isinstance(entry.get("source"), str):
            continue
        return {"name": name, "file": os.path.normpath(os.path.join(loc, entry["source"], ".claude-plugin", "plugin.json"))}
    return None


def check(force=False, now=None):
    """Reads the newest version (at most once a day unless forced) and remembers it."""
    now = now or time.time()
    state = _read(STATE, {})
    installed = installed_version()
    if not force and now - state.get("checked_at", 0) < DAY:
        state["installed"] = installed
        return state
    m = marketplace()
    state.update({"checked_at": now, "installed": installed, "marketplace": (m or {}).get("name", NAME)})
    state.pop("error", None)
    if not m:
        state["error"] = "Wit's marketplace wasn't found"
    else:
        claude = claude_bin()
        # Without the claude command the local copy may be stale, but it's still worth reading.
        err = run_claude(claude, ["plugin", "marketplace", "update", m["name"]]) if claude else None
        latest = _read(m["file"], {}).get("version")
        if latest:
            state["latest"] = latest
        if err or not latest:
            state["error"] = err or "the marketplace has no version for Wit"
    _write(STATE, state)
    return state


def apply(now=None):
    """Updates through Claude Code's own plugin commands and records how it went."""
    state = check(force=True, now=now)
    claude = claude_bin()
    target = state.get("latest")
    result = {"at": now or time.time(), "version": target, "ok": False}
    if not claude:
        result["error"] = "the claude command isn't on PATH"
    elif not newer(target, state.get("installed")):
        result.update(ok=True, error=None, skipped="already up to date")
    else:
        err = run_claude(claude, ["plugin", "update", f"{NAME}@{state.get('marketplace', NAME)}"])
        result.update(ok=not err, error=err)
    state["applied"] = result
    _write(STATE, state)
    return state


def set_auto(on):
    t = _read(TUNING, {})
    t.setdefault("update", {})["auto"] = bool(on)
    _write(TUNING, t)
    return settings()


def spawn(*args):
    """Runs this script detached, so a session never waits on the network or an update."""
    subprocess.Popen([sys.executable, "-S", os.path.abspath(__file__), *args], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=os.environ.copy())


def notice(now=None):
    """What session start tells the person and Claude, kicking off a check or an update when due.
    Returns (message for the person, line for Claude), either None."""
    s = settings()
    if not s["check"]:
        return None, None
    now = now or time.time()
    state = _read(STATE, {})
    if now - state.get("checked_at", 0) >= DAY:
        spawn("check")
    installed, latest = installed_version(), state.get("latest")
    applied = state.get("applied") or {}
    if not newer(latest, installed):
        return None, None
    if applied.get("version") == latest and applied.get("ok"):
        return f"Wit {latest} is installed: restart Claude Code to load it (running {installed}).", None
    if applied.get("version") == latest and applied.get("error"):
        return (f"Wit couldn't update itself to {latest} ({applied['error']}). Run /wit:update to try again.",
                f"- Wit {latest} is available but the automatic update failed; offer the user /wit:update.")
    if s["auto"]:
        spawn("apply")
        return f"Wit is updating from {installed} to {latest} in the background; restart Claude Code once it's done.", None
    return (f"Wit {latest} is out (you have {installed}). Run /wit:update to install it, or `/wit:update auto` to stay up to date.",
            f"- A newer Wit ({latest}, installed {installed}) is available. Tell the user once, briefly, and offer to run /wit:update.")


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "status"
    if cmd == "check":
        state = check(force="--force" in argv)
    elif cmd == "apply":
        state = apply()
    elif cmd == "auto":
        print(json.dumps(set_auto(len(argv) > 2 and argv[2] == "on")))
        return 0
    else:
        state = _read(STATE, {})
        state["installed"] = installed_version()
    state["newer"] = newer(state.get("latest"), state.get("installed"))
    state["settings"] = settings()
    print(json.dumps(state))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
