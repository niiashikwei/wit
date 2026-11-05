"""End-to-end tests: run hook scripts as Claude Code would (JSON on stdin)."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "plugins", "token-optimizer")
TOK = os.path.join(ROOT, "scripts", "tok.py")
TUNER = os.path.join(ROOT, "scripts", "tuner.py")
AUDIT = os.path.join(ROOT, "skills", "token-audit", "scripts", "audit.py")
REPORT = os.path.join(ROOT, "skills", "token-audit", "scripts", "report.py")


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.work = tempfile.mkdtemp()
        self.env = {**os.environ, "TOKEN_OPT_HOME": self.home}
        self.env.pop("TOKEN_GUARD", None)
        self.big = os.path.join(self.work, "secret_customer_file.py")
        with open(self.big, "w") as f:
            f.write("x = 1  # some padding text here\n" * 3000)
        self.small = os.path.join(self.work, "small.py")
        with open(self.small, "w") as f:
            f.write("print(1)\n")

    def hook(self, event, payload, **env):
        start = time.time()
        r = subprocess.run([sys.executable, "-S", TOK, event], input=json.dumps(payload),
                           capture_output=True, text=True, env={**self.env, **env})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.elapsed = time.time() - start
        return json.loads(r.stdout) if r.stdout else None

    def metrics(self):
        with open(os.path.join(self.home, "metrics.jsonl")) as f:
            return f.read()

    def read(self, path, sid="s1", **ti):
        return self.hook("pre_read", {"session_id": sid, "tool_input": {"file_path": path, **ti}})

    def test_session_start_injects_brief(self):
        out = self.hook("session_start", {"session_id": "s1", "cwd": self.work})
        self.assertIn("Token etiquette", out["hookSpecificOutput"]["additionalContext"])

    def test_small_and_partial_reads_pass_silently(self):
        self.assertIsNone(self.read(self.small))
        self.assertIsNone(self.read(self.big, offset=1, limit=50))

    def test_big_read_warns_by_default(self):
        out = self.read(self.big)["hookSpecificOutput"]
        self.assertNotIn("permissionDecision", out)
        self.assertIn("3000 lines", out["additionalContext"])

    def test_nudge_denies_once_then_allows(self):
        self.env["TOKEN_GUARD"] = "nudge"
        first = self.read(self.big)
        self.assertEqual(first["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIsNone(self.read(self.big))  # escape hatch: never blocks twice
        self.assertIn('"d":"override"', self.metrics())

    def test_off_disables_guard(self):
        self.assertIsNone(self.hook("pre_read", {"session_id": "s1", "tool_input": {"file_path": self.big}}, TOKEN_GUARD="off"))

    def test_privacy_no_paths_or_commands_recorded(self):
        self.read(self.big)
        self.hook("post_tool", {"session_id": "s1", "tool_name": "Bash",
                                "tool_input": {"command": "./deploy_acme_prod.sh --token abc123"},
                                "tool_response": {"stdout": "acme secrets"}})
        self.hook("session_start", {"session_id": "s1", "cwd": self.work})
        m = self.metrics()
        for leak in ("secret_customer_file", self.work, "acme", "abc123", "deploy"):
            self.assertNotIn(leak, m)
        self.assertIn('"f":"other"', m)

    def test_metrics_off(self):
        self.hook("post_tool", {"session_id": "s1", "tool_name": "Read", "tool_response": "x"}, TOKEN_METRICS="off")
        self.assertFalse(os.path.exists(os.path.join(self.home, "metrics.jsonl")))

    def test_hook_latency(self):
        self.read(self.big)
        self.assertLess(self.elapsed, 0.5)  # generous for CI; typically ~30-60ms

    def run_tuner(self, *extra):
        r = subprocess.run([sys.executable, "-S", TUNER, *extra], capture_output=True, text=True, env=self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(self.home, "tuning.json")) as f:
            return json.load(f)

    def test_tuner_promotes_warn_to_nudge(self):
        for i in range(6):
            sid = f"s{i}"
            self.read(self.big, sid=sid)
            self.read(self.big, sid=sid)
            with open(os.path.join(self.home, "metrics.jsonl"), "a") as f:
                f.write(json.dumps({"e": "session", "s": sid, "in": 10, "cr": 900, "cc": 90, "out": 50,
                                    "ts": int(time.time())}) + "\n")
        t = self.run_tuner()
        self.assertEqual(t["read_guard"]["mode"], "nudge")
        self.assertIn("warn -> nudge", t["history"][-1]["change"])

    def test_tuner_loosens_when_overridden(self):
        self.env["TOKEN_GUARD"] = "nudge"
        with open(os.path.join(self.home, "tuning.json"), "w") as f:
            json.dump({"read_guard": {"mode": "nudge", "max_lines": 800}}, f)
        for i in range(10):
            self.read(self.big, sid=f"s{i}")
            if i % 2:
                self.read(self.big, sid=f"s{i}")  # 50% override rate
        t = self.run_tuner()
        self.assertEqual(t["read_guard"]["max_lines"], 1000)

    def test_tuner_learns_noisy_bash_and_warns(self):
        for _ in range(3):
            self.hook("post_tool", {"session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "pytest tests"},
                                    "tool_response": {"stdout": "." * 50000}})
        t = self.run_tuner()
        self.assertIn("pytest", t["bash"]["noisy_families"])
        out = self.hook("pre_bash", {"session_id": "s1", "tool_input": {"command": "pytest tests"}})
        self.assertIn("pytest", out["hookSpecificOutput"]["additionalContext"])
        self.assertIsNone(self.hook("pre_bash", {"session_id": "s1", "tool_input": {"command": "pytest -q tests"}}))

    def test_tuner_summarizes_transcript(self):
        tr = os.path.join(self.work, "t.jsonl")
        with open(tr, "w") as f:
            for mid in ("a", "a", "b"):  # duplicate id must be counted once
                f.write(json.dumps({"type": "assistant", "message": {"id": mid, "model": "claude-opus-5-5",
                        "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100}}}) + "\n")
        self.run_tuner("--session", "x", "--transcript", tr, "--cwd", self.work)
        sess = [json.loads(l) for l in self.metrics().splitlines() if '"e":"session"' in l][0]
        self.assertEqual((sess["turns"], sess["cr"], sess["out"]), (2, 200, 10))

    def test_audit_and_report_run(self):
        with open(os.path.join(self.work, "CLAUDE.md"), "w") as f:
            f.write("rule\n" * 4000)
        r = subprocess.run([sys.executable, AUDIT, self.work], capture_output=True, text=True)
        self.assertIn('"area": "memory"', r.stdout)
        self.hook("post_tool", {"session_id": "s1", "tool_name": "Read", "tool_response": "x"})
        r = subprocess.run([sys.executable, REPORT], capture_output=True, text=True, env=self.env)
        self.assertIn("top_tool_outputs_kb", r.stdout)


if __name__ == "__main__":
    unittest.main()
