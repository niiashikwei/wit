"""Edge cases and degraded inputs across the hooks, tuner, statusline and audit scripts.

Each test pins down one boundary the main behavior suites don't reach (a malformed
line, a value already at its bound, an unreadable path), so the whole Python side
stays at ≥ 99% line+branch coverage without testing internals directly."""
import json
import os
import subprocess
import unittest

from helpers import AUDIT, REPORT, STATUSLINE, TUNER, WitTestCase, python_cmd, req


class GuardEdgeTest(WitTestCase):
    @req("R2", "R20")
    def test_line_count_stops_at_20mb_cap(self):
        p = os.path.join(self.work, "huge.log")
        self.addCleanup(os.remove, p)
        with open(p, "wb") as f:
            f.write(b"\n" * (21 * 1024 * 1024))  # one byte per line, past the 20 MB cap
        self.env["WIT_GUARD"] = "nudge"
        out = self.read(p)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")


class StatuslineEdgeTest(WitTestCase):
    def statusline(self, payload, **env):
        return self.run_script(STATUSLINE, stdin=json.dumps(payload), env=env).stdout.strip()

    def transcript(self, *rows):
        p = os.path.join(self.work, "t.jsonl")
        with open(p, "w") as f:
            for r in rows:
                f.write((r if isinstance(r, str) else json.dumps(r)) + "\n")
        return p

    @req("R14")
    def test_uses_last_assistant_usage_only(self):
        tr = self.transcript(
            {"type": "user", "message": {"content": "hi"}},
            {"type": "assistant", "message": {"usage": {"input_tokens": 100000}}},
            {"type": "system", "usage": {"input_tokens": 1}},  # mentions usage, not an assistant reply
        )
        self.assertEqual(self.statusline({"model": {"display_name": "M"}, "transcript_path": tr}), "M · ctx 50% · cache 0%")

    @req("R14")
    def test_zero_context_skips_cache_rate(self):
        tr = self.transcript({"type": "assistant", "message": {"usage": {"input_tokens": 0, "output_tokens": 3}}})
        self.assertEqual(self.statusline({"model": {"display_name": "M"}, "transcript_path": tr}), "M · ctx 0%")

    @req("R14", "R17")
    def test_unwritable_data_dir_drops_savings_only(self):
        blocker = os.path.join(self.work, "afile")
        with open(blocker, "w") as f:
            f.write("x")
        line = self.statusline({"session_id": "s", "model": {"display_name": "M"}, "cost": {"total_cost_usd": 0}},
                               WIT_HOME=os.path.join(blocker, "wit"))
        self.assertEqual(line, "M · $0.00")


class TunerEdgeTest(WitTestCase):
    def nudges(self, denies, overrides, max_lines=800):
        self.set_tuning(read_guard={"mode": "nudge", "max_lines": max_lines})
        self.append_events(*[{"e": "guard", "s": "s", "r": "read", "d": "deny"}] * denies,
                           *[{"e": "guard", "s": "s", "r": "read", "d": "override"}] * overrides)

    @req("R9")
    def test_moderate_override_rate_changes_nothing(self):
        self.nudges(10, 2)  # 20%: between the tighten (10%) and loosen (40%) bands
        self.tuner()
        t = self.tuning()
        self.assertEqual(t["read_guard"], {"mode": "nudge", "max_lines": 800})
        self.assertEqual(t["history"], [])

    @req("R9")
    def test_tighten_at_lower_bound_logs_nothing(self):
        self.nudges(20, 0, max_lines=400)
        self.tuner()
        t = self.tuning()
        self.assertEqual(t["read_guard"]["max_lines"], 400)
        self.assertEqual(t["history"], [])

    @req("R12")
    def test_transcript_without_assistant_usage_logs_no_session(self):
        tr = os.path.join(self.work, "t.jsonl")
        with open(tr, "w") as f:
            f.write(json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n")
        self.tuner("--transcript", tr, "--session", "s")
        self.assertEqual([e for e in self.events() if e.get("e") == "session"], [])

    @req("R12", "R17")
    def test_unreadable_transcript_still_retunes(self):
        binary = os.path.join(self.work, "bin.jsonl")
        with open(binary, "wb") as f:
            f.write(b"\xff\xfe\x00garbage\n")
        for tr in (self.work, binary):  # a directory, then invalid UTF-8
            self.tuner("--transcript", tr, "--session", "s")
            self.assertIn("last_tuned", self.tuning())

    @req("R14", "R17")
    def test_corrupt_metrics_lines_are_skipped(self):
        self.append_events({"e": "saved", "s": "a", "k": "read", "tok": 100},
                           {"e": "saved", "s": "a", "k": "bash", "tok": 50},
                           {"e": "saved", "s": "b", "k": "read", "tok": 7})
        with open(os.path.join(self.home, "metrics.jsonl"), "a") as f:
            f.write("{not json\n")
        self.tuner()
        self.assertEqual(self.tuning()["savings"], {"last_session": 7, "last_30d": 157, "sessions": 2})

    @req("R22")
    def test_no_dominant_tool_tip_when_output_is_spread(self):
        self.append_events(*[{"e": "tool", "s": "s", "t": t, "b": 1000} for t in ("Read", "Bash", "Grep")])
        self.tuner()
        self.assertEqual(self.tuning()["tips"], [])

    @req("R11")
    def test_prints_applied_changes_when_run_interactively(self):
        import pty  # POSIX only, like the plugin's hooks
        self.nudges(10, 10)  # forces a mode change
        master, slave = pty.openpty()
        p = subprocess.Popen(python_cmd(TUNER), stdout=slave, stderr=subprocess.DEVNULL, env=self.env)
        os.close(slave)  # read while the child runs: macOS drops unread pty output at exit
        chunks = []
        while True:
            try:
                chunk = os.read(master, 4096)
            except OSError:  # Linux raises EIO once the child side is closed
                break
            if not chunk:
                break
            chunks.append(chunk)
        os.close(master)
        self.assertEqual(p.wait(), 0)
        out = json.loads(b"".join(chunks).decode())
        self.assertEqual(out["applied"][0]["change"], "read_guard.mode: nudge -> warn")


class AuditEdgeTest(WitTestCase):
    def audit(self):
        return json.loads(self.run_script(AUDIT, self.work).stdout)["findings"]

    @req("R15")
    def test_non_markdown_files_in_claude_dir_ignored(self):
        os.remove(self.big)
        os.makedirs(os.path.join(self.work, ".claude", "agents"))
        with open(os.path.join(self.work, ".claude", "agents", "notes.txt"), "w") as f:
            f.write("no model here\n")
        self.assertEqual(self.audit(), [])

    @req("R15", "R17")
    def test_broken_symlink_skipped(self):
        os.remove(self.big)
        os.symlink(os.path.join(self.work, "missing"), os.path.join(self.work, "dangling.min.js"))
        self.assertEqual(self.audit(), [])

    @req("R15", "R17")
    def test_failing_check_reported_as_info(self):
        os.remove(self.big)
        with open(os.path.join(self.env["HOME"], ".claude.json"), "w") as f:
            json.dump({"projects": []}, f)  # wrong shape: projects must be an object
        findings = self.audit()
        self.assertEqual([(f["severity"], f["area"]) for f in findings], [("info", "audit_mcp")])
        self.assertIn("check failed", findings[0]["message"])


class ReportEdgeTest(WitTestCase):
    @req("R16", "R17")
    def test_corrupt_metrics_lines_are_skipped(self):
        self.append_events({"e": "session", "s": "a", "in": 1, "turns": 1})
        with open(os.path.join(self.home, "metrics.jsonl"), "a") as f:
            f.write("{not json\n")
        self.assertEqual(json.loads(self.run_script(REPORT).stdout)["sessions"], 1)


if __name__ == "__main__":
    unittest.main()
