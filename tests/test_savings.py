"""Savings accounting and display, audit and report (R13–R16)."""
import json
import os
import unittest

from helpers import AUDIT, REPORT, STATUSLINE, WitTestCase, req


class SavingsAccountingTest(WitTestCase):
    def setUp(self):
        super().setUp()
        self.env["WIT_GUARD"] = "nudge"

    def saved(self):
        return [e for e in self.events() if e["e"] == "saved"]

    @req("R13")
    def test_accepted_nudge_counts_full_minus_ranged(self):
        self.read(self.big)
        self.post("Read", {"file_path": self.big, "offset": 10, "limit": 40}, "y" * 2000)
        full = os.path.getsize(self.big) // 4
        self.assertEqual([(s["k"], s["tok"]) for s in self.saved()], [("read", full - 500)])

    @req("R13")
    def test_counted_once_per_nudge(self):
        self.read(self.big)
        for _ in range(3):
            self.post("Read", {"file_path": self.big, "offset": 1, "limit": 10}, "y")
        self.assertEqual(len(self.saved()), 1)

    @req("R13")
    def test_overridden_nudge_counts_zero(self):
        self.read(self.big)
        self.read(self.big)
        self.post("Read", {"file_path": self.big}, "y" * 90000)
        self.assertEqual(self.saved(), [])

    @req("R13")
    def test_ranged_read_without_prior_nudge_counts_zero(self):
        self.post("Read", {"file_path": self.big, "offset": 1, "limit": 10}, "y")
        self.assertEqual(self.saved(), [])

    @req("R13")
    def test_heeded_bash_hint_counts_difference(self):
        self.set_tuning(bash={"noisy_families": {"pytest": 40000}})
        self.hook("pre_bash", {"session_id": "s1", "tool_input": {"command": "pytest"}})
        self.post("Bash", {"command": "pytest -q"}, "." * 4000)
        self.assertEqual([(s["k"], s["tok"]) for s in self.saved()], [("bash", (40000 - 4000) // 4)])

    @req("R13")
    def test_bigger_than_usual_output_counts_zero(self):
        self.set_tuning(bash={"noisy_families": {"pytest": 40000}})
        self.hook("pre_bash", {"session_id": "s1", "tool_input": {"command": "pytest"}})
        self.post("Bash", {"command": "pytest"}, "." * 90000)
        self.assertEqual(self.saved(), [])

    @req("R13")
    def test_subagent_offload_logged_separately_not_as_savings(self):
        self.post("Agent", {"subagent_type": "wit:scout", "prompt": "p"}, "x" * 100)
        self.post("Agent", {"subagent_type": "general-purpose", "prompt": "p"}, "x")
        offloads = [e for e in self.events() if e["e"] == "offload"]
        self.assertEqual([o["a"] for o in offloads], ["scout"])
        self.assertEqual(self.saved(), [])


class SavingsDisplayTest(WitTestCase):
    def setUp(self):
        super().setUp()
        self.env["WIT_GUARD"] = "nudge"
        self.read(self.big)
        self.post("Read", {"file_path": self.big, "offset": 1, "limit": 10}, "y")

    def statusline(self, payload):
        return self.run_script(STATUSLINE, stdin=json.dumps(payload)).stdout.strip()

    @req("R14")
    def test_session_start_shows_last_session_and_30_day_total(self):
        self.append_events({"e": "saved", "s": "older", "k": "read", "tok": 100000})
        self.append_events({"e": "saved", "s": "latest", "k": "read", "tok": 2500})
        self.tuner()
        out = self.hook("session_start", {"session_id": "new", "cwd": self.work})
        self.assertRegex(out["systemMessage"], r"saved ~2\.5k tokens last session, ~\d+\.\dk over the last 30 days")

    @req("R14")
    def test_no_message_before_any_savings(self):
        os.remove(os.path.join(self.home, "metrics.jsonl"))
        self.tuner()
        out = self.hook("session_start", {"session_id": "new", "cwd": self.work})
        self.assertNotIn("systemMessage", out)

    @req("R14")
    def test_statusline_shows_live_savings_context_and_cost(self):
        tr = os.path.join(self.work, "t.jsonl")
        with open(tr, "w") as f:
            f.write(json.dumps({"type": "assistant", "message": {"usage": {
                "input_tokens": 1000, "cache_read_input_tokens": 99000, "output_tokens": 5}}}) + "\n")
        line = self.statusline({"session_id": "s1", "model": {"display_name": "Opus"}, "transcript_path": tr,
                                "cost": {"total_cost_usd": 1.234}})
        self.assertRegex(line, r"^Opus · ctx 50% · cache 99% · saved ~\d+\.\dk · \$1\.23$")

    @req("R14", "R17")
    def test_statusline_degrades_gracefully(self):
        self.assertEqual(self.statusline({}), "?")
        self.assertEqual(self.run_script(STATUSLINE, stdin="garbage").stdout.strip(), "?")

    @req("R14", "R16")
    def test_report_includes_savings(self):
        rep = json.loads(self.run_script(REPORT).stdout)
        self.assertGreater(rep["tokens_saved_estimate"]["total"], 0)
        self.assertIn("read", rep["tokens_saved_estimate"]["by_kind"])


class ReportTest(WitTestCase):
    @req("R16")
    def test_report_with_no_data(self):
        self.assertIn("No metrics yet", self.run_script(REPORT).stdout)

    @req("R16")
    def test_report_fields(self):
        self.append_events({"e": "session", "s": "a", "in": 100, "cr": 300, "cc": 100, "out": 10, "turns": 2},
                           {"e": "tool", "s": "a", "t": "Read", "b": 5000},
                           {"e": "guard", "s": "a", "r": "read", "d": "deny"},
                           {"e": "compact", "s": "a"})
        self.set_tuning(history=[{"change": "x", "reason": "y"}])
        rep = json.loads(self.run_script(REPORT).stdout)
        self.assertEqual(rep["sessions"], 1)
        self.assertEqual(rep["cache_hit_rate"], 0.6)
        self.assertEqual(rep["top_tool_outputs_kb"], {"Read": 5})
        self.assertEqual(rep["guard_outcomes"], {"read:deny": 1})
        self.assertEqual(rep["compactions"], 1)
        self.assertEqual(rep["recent_tuning_changes"], [{"change": "x", "reason": "y"}])


class AuditTest(WitTestCase):
    def audit(self):
        return json.loads(self.run_script(AUDIT, self.work).stdout)["findings"]

    def areas(self):
        return {f["area"] for f in self.audit()}

    @req("R15")
    def test_clean_project_has_no_findings(self):
        os.remove(self.big)
        self.assertEqual(self.audit(), [])

    @req("R15")
    def test_oversized_claude_md_including_imports(self):
        self.make_file("CLAUDE.md", 10, "@docs.md\n")
        self.make_file("docs.md", 3000, "lots of reference text here\n")
        f = [x for x in self.audit() if x["area"] == "memory"][0]
        self.assertIn("via @imports", f["message"])
        self.assertEqual(f["severity"], "high")

    @req("R15")
    def test_many_mcp_servers(self):
        with open(os.path.join(self.work, ".mcp.json"), "w") as f:
            json.dump({"mcpServers": {f"s{i}": {} for i in range(7)}}, f)
        self.assertIn("mcp", self.areas())

    @req("R15")
    def test_agent_without_model_and_long_skill_description(self):
        os.makedirs(os.path.join(self.work, ".claude", "agents"))
        os.makedirs(os.path.join(self.work, ".claude", "skills", "s"))
        with open(os.path.join(self.work, ".claude", "agents", "a.md"), "w") as f:
            f.write("---\nname: a\ndescription: d\n---\nbody\n")
        with open(os.path.join(self.work, ".claude", "skills", "s", "SKILL.md"), "w") as f:
            f.write("---\nname: s\ndescription: " + "x" * 500 + "\n---\n")
        msgs = " ".join(f["message"] for f in self.audit())
        self.assertIn("no `model:` set", msgs)
        self.assertIn("description is 500 chars", msgs)

    @req("R15")
    def test_generated_files_unless_denied(self):
        self.make_file("package-lock.json", 10)
        self.assertIn("files", self.areas())
        os.makedirs(os.path.join(self.work, ".claude"))
        with open(os.path.join(self.work, ".claude", "settings.json"), "w") as f:
            json.dump({"permissions": {"deny": ["Read(./package-lock.json)", "Read(./secret_customer_file.py)"]}}, f)
        self.assertNotIn("files", self.areas())

    @req("R15")
    def test_mcp_servers_from_user_config_for_this_project(self):
        with open(os.path.join(self.env["HOME"], ".claude.json"), "w") as f:
            json.dump({"mcpServers": {"g1": {}, "g2": {}, "g3": {}},
                       "projects": {os.path.realpath(self.work): {"mcpServers": {"p1": {}, "p2": {}, "p3": {}}},
                                    os.path.abspath(self.work): {"mcpServers": {"p1": {}, "p2": {}, "p3": {}}}}}, f)
        msg = [f for f in self.audit() if f["area"] == "mcp"][0]["message"]
        self.assertIn("6 MCP servers", msg)

    @req("R15")
    def test_inline_code_blocks_and_long_skill_file(self):
        self.make_file("CLAUDE.md", 6, "```\ncode\n```\n")
        os.makedirs(os.path.join(self.work, ".claude", "skills", "big"))
        with open(os.path.join(self.work, ".claude", "skills", "big", "SKILL.md"), "w") as f:
            f.write("---\nname: big\ndescription: d\n---\n" + "line\n" * 600)
        msgs = " ".join(f["message"] for f in self.audit())
        self.assertIn("6 code blocks", msgs)
        self.assertIn("SKILL.md: 604 lines", msgs)

    @req("R15", "R17")
    def test_malformed_configs_do_not_crash(self):
        with open(os.path.join(self.work, ".mcp.json"), "w") as f:
            f.write("{bad")
        with open(os.path.join(self.env["HOME"], ".claude.json"), "w") as f:
            f.write("{bad")
        self.assertIsInstance(self.audit(), list)

    @req("R15")
    def test_findings_ranked_by_severity(self):
        self.make_file("CLAUDE.md", 3000, "lots of reference text here\n")
        self.make_file("package-lock.json", 10)
        sev = [f["severity"] for f in self.audit()]
        order = {"high": 0, "medium": 1, "low": 2, "info": 3}
        self.assertEqual(sev, sorted(sev, key=order.get))


if __name__ == "__main__":
    unittest.main()
