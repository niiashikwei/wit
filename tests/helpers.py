"""Shared test harness: runs Wit's scripts exactly as Claude Code does (JSON on stdin,
fresh process), against an isolated WIT_HOME. Set WIT_COVERAGE=1 to run every
script under coverage.py (see CONTRIBUTING in README)."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TESTS)
PLUGIN = os.path.join(REPO, "plugins", "wit")
TOK = os.path.join(PLUGIN, "scripts", "tok.py")
TUNER = os.path.join(PLUGIN, "scripts", "tuner.py")
STATUSLINE = os.path.join(PLUGIN, "scripts", "statusline.py")
AUDIT = os.path.join(PLUGIN, "skills", "token-audit", "scripts", "audit.py")
REPORT = os.path.join(PLUGIN, "skills", "token-audit", "scripts", "report.py")


def req(*ids):
    """Tag a test with the requirement IDs (REQUIREMENTS.md) it verifies."""
    def deco(fn):
        fn._reqs = ids
        return fn
    return deco


def python_cmd(script, *args):
    if os.environ.get("WIT_COVERAGE"):
        return [sys.executable, "-m", "coverage", "run", "-p", f"--rcfile={os.path.join(REPO, '.coveragerc')}", script, *args]
    return [sys.executable, "-S", script, *args]


class WitTestCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="wit-home-")
        self.work = tempfile.mkdtemp(prefix="wit-work-")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("WIT_") or k == "WIT_COVERAGE"}
        self.env["WIT_HOME"] = self.home
        self.env["HOME"] = tempfile.mkdtemp(prefix="wit-userhome-")  # isolate ~/.claude.json
        self.big = self.make_file("secret_customer_file.py", 3000)
        self.small = self.make_file("small.py", 1)

    def make_file(self, name, lines, line="x = 1  # some padding text here\n"):
        p = os.path.join(self.work, name)
        with open(p, "w") as f:
            f.write(line * lines)
        return p

    # ---- running scripts
    def run_script(self, script, *args, stdin="", env=None, check=True):
        start = time.perf_counter()
        r = subprocess.run(python_cmd(script, *args), input=stdin, capture_output=True, text=True,
                           env={**self.env, **(env or {})})
        self.elapsed = time.perf_counter() - start
        if check:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def hook(self, event, payload, **env):
        r = self.run_script(TOK, event, stdin=json.dumps(payload), env=env)
        self.assertEqual(r.stderr, "")
        return json.loads(r.stdout) if r.stdout else None

    def read(self, path, sid="s1", **ti):
        return self.hook("pre_read", {"session_id": sid, "tool_input": {"file_path": path, **ti}})

    def post(self, tool, tool_input, response, sid="s1"):
        return self.hook("post_tool", {"session_id": sid, "tool_name": tool, "tool_input": tool_input,
                                       "tool_response": response})

    def tuner(self, *args):
        return self.run_script(TUNER, *args)

    # ---- data
    def events(self):
        try:
            with open(os.path.join(self.home, "metrics.jsonl")) as f:
                return [json.loads(l) for l in f]
        except FileNotFoundError:
            return []

    def raw_metrics(self):
        try:
            with open(os.path.join(self.home, "metrics.jsonl")) as f:
                return f.read()
        except FileNotFoundError:
            return ""

    def tuning(self):
        with open(os.path.join(self.home, "tuning.json")) as f:
            return json.load(f)

    def set_tuning(self, **values):
        with open(os.path.join(self.home, "tuning.json"), "w") as f:
            json.dump(values, f)

    def append_events(self, *events):
        with open(os.path.join(self.home, "metrics.jsonl"), "a") as f:
            for e in events:
                f.write(json.dumps({"ts": int(time.time()), **e}) + "\n")
