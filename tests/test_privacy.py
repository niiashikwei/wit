"""Privacy contract (R6–R8)."""
import ast
import glob
import json
import os
import stat
import unittest

from helpers import PLUGIN, WitTestCase, req

SECRETS = ("secret_customer_file", "acme", "abc123", "deploy", "hunter2", "PROMPT-TEXT", "file body")


class PrivacyTest(WitTestCase):
    def exercise_everything(self):
        self.env["WIT_GUARD"] = "nudge"
        self.hook("session_start", {"session_id": "sess-PROMPT-TEXT", "cwd": self.work, "prompt": "PROMPT-TEXT"})
        self.read(self.big)
        self.read(self.big, offset=1, limit=10)
        self.post("Read", {"file_path": self.big, "offset": 1, "limit": 10}, "file body hunter2")
        self.post("Bash", {"command": "./deploy_acme_prod.sh --token abc123"}, {"stdout": "acme hunter2"})
        self.post("mcp__docs__search", {"q": "hunter2"}, {"result": "acme"})
        self.post("Agent", {"subagent_type": "wit:scout", "prompt": "PROMPT-TEXT"}, "acme")
        self.hook("pre_compact", {"session_id": "s1", "trigger": "auto"})

    @req("R6")
    def test_no_sensitive_strings_anywhere_in_data_dir(self):
        self.exercise_everything()
        for path in glob.glob(os.path.join(self.home, "**", "*"), recursive=True):
            if os.path.isfile(path):
                with open(path) as f:
                    data = f.read()
                for s in SECRETS + (self.work,):
                    self.assertNotIn(s, data, f"{s!r} leaked into {path}")

    @req("R6")
    def test_metric_fields_are_whitelisted(self):
        self.exercise_everything()
        allowed = {"e", "ts", "s", "p", "src", "ph", "x", "partial", "lines", "big", "r", "d", "f",
                   "t", "b", "a", "k", "tok", "trigger"}
        for ev in self.events():
            self.assertLessEqual(set(ev), allowed, ev)

    @req("R6")
    def test_tool_names_recorded_but_not_their_inputs(self):
        self.post("mcp__docs__search", {"q": "hunter2"}, {"result": "acme"})
        ev = self.events()[0]
        self.assertEqual((ev["t"], ev["b"]), ("mcp__docs__search", len('{"result": "acme"}')))
        self.assertNotIn("hunter2", self.raw_metrics())

    @req("R6")
    def test_unknown_commands_recorded_as_other(self):
        self.post("Bash", {"command": "./deploy_acme_prod.sh"}, "x")
        self.post("Bash", {"command": "git status"}, "x")
        fams = [e["f"] for e in self.events() if e.get("t") == "Bash"]
        self.assertEqual(fams, ["other", "git status"])

    @req("R6")
    def test_hashes_are_salted_per_machine(self):
        self.read(self.big)
        ph1 = self.events()[0]["ph"]
        other_home = self.home + "-other"
        self.run_script(__import__("helpers").TOK, "pre_read",
                        stdin=json.dumps({"session_id": "s1", "tool_input": {"file_path": self.big}}),
                        env={"WIT_HOME": other_home})
        with open(os.path.join(other_home, "metrics.jsonl")) as f:
            ph2 = json.loads(f.readline())["ph"]
        self.assertNotEqual(ph1, ph2)
        self.assertEqual(len(ph1), 12)

    @req("R6")
    def test_salt_file_is_private(self):
        self.read(self.big)
        mode = stat.S_IMODE(os.stat(os.path.join(self.home, ".salt")).st_mode)
        self.assertEqual(mode, 0o600)

    @req("R7")
    def test_metrics_off_records_nothing(self):
        self.env["WIT_METRICS"] = "off"
        self.exercise_everything()
        self.assertEqual(self.raw_metrics(), "")


class NoNetworkTest(unittest.TestCase):
    NETWORK = {"socket", "urllib", "http", "requests", "httpx", "ftplib", "smtplib", "ssl", "asyncio"}

    @req("R8")
    def test_no_network_imports_in_shipped_scripts(self):
        scripts = glob.glob(os.path.join(PLUGIN, "**", "*.py"), recursive=True)
        self.assertGreaterEqual(len(scripts), 5)
        for path in scripts:
            with open(path) as f:
                tree = ast.parse(f.read())
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names = [node.module]
                for n in names:
                    self.assertNotIn(n.split(".")[0], self.NETWORK, f"{path} imports {n}")


if __name__ == "__main__":
    unittest.main()
