"""Context shaping: session brief, read guard, bash hints (R1–R5)."""
import os
import unittest

from helpers import WitTestCase, req


class SessionStartTest(WitTestCase):
    def start(self):
        return self.hook("session_start", {"session_id": "s1", "cwd": self.work})["hookSpecificOutput"]

    @req("R1")
    def test_injects_short_brief(self):
        out = self.start()
        self.assertEqual(out["hookEventName"], "SessionStart")
        ctx = out["additionalContext"]
        self.assertIn("Token etiquette", ctx)
        self.assertLessEqual(len(ctx), 1200)

    @req("R1")
    def test_includes_at_most_three_learned_tips(self):
        self.set_tuning(tips=[f"tip {i}" for i in range(6)])
        ctx = self.start()["additionalContext"]
        self.assertIn("Learned: tip 2", ctx)
        self.assertNotIn("tip 3", ctx)

    @req("R1")
    def test_warns_on_oversized_claude_md(self):
        self.make_file("CLAUDE.md", 250, "rule\n")
        self.assertIn("CLAUDE.md is 250 lines", self.start()["additionalContext"])
        self.make_file("CLAUDE.md", 50, "rule\n")
        self.assertNotIn("CLAUDE.md is", self.start()["additionalContext"])


class ReadGuardTest(WitTestCase):
    @req("R2")
    def test_small_file_passes_silently(self):
        self.assertIsNone(self.read(self.small))

    @req("R2")
    def test_ranged_read_of_big_file_passes_silently(self):
        self.assertIsNone(self.read(self.big, offset=1, limit=50))
        self.assertIsNone(self.read(self.big, limit=50))

    @req("R2")
    def test_threshold_boundary(self):
        at = self.make_file("at.py", 800)
        over = self.make_file("over.py", 801)
        self.assertIsNone(self.read(at))
        self.assertIsNotNone(self.read(over))

    @req("R2")
    def test_binary_and_notebook_files_not_guarded(self):
        for ext in (".ipynb", ".pdf", ".png"):
            self.assertIsNone(self.read(self.make_file("big" + ext, 3000)))

    @req("R2", "R4")
    def test_warn_is_default_and_never_denies(self):
        out = self.read(self.big)["hookSpecificOutput"]
        self.assertNotIn("permissionDecision", out)
        self.assertIn("3000 lines", out["additionalContext"])

    @req("R2", "R17")
    def test_missing_file_and_no_path_pass(self):
        self.assertIsNone(self.read(os.path.join(self.work, "nope.py")))
        self.assertIsNone(self.hook("pre_read", {"session_id": "s1", "tool_input": {}}))


class NudgeTest(WitTestCase):
    def setUp(self):
        super().setUp()
        self.env["WIT_GUARD"] = "nudge"

    @req("R3")
    def test_denies_first_then_always_allows(self):
        first = self.read(self.big)["hookSpecificOutput"]
        self.assertEqual(first["permissionDecision"], "deny")
        self.assertIn("request the same Read again", first["permissionDecisionReason"])
        for _ in range(3):
            self.assertIsNone(self.read(self.big))

    @req("R3")
    def test_scoped_per_session_and_per_file(self):
        other = self.make_file("other.py", 3000)
        self.assertIsNotNone(self.read(self.big, sid="a"))
        self.assertIsNotNone(self.read(other, sid="a"))
        self.assertIsNotNone(self.read(self.big, sid="b"))

    @req("R3")
    def test_logs_deny_and_override_outcomes(self):
        self.read(self.big)
        self.read(self.big)
        outcomes = [e["d"] for e in self.events() if e["e"] == "guard"]
        self.assertEqual(outcomes, ["deny", "override"])


class GuardModeTest(WitTestCase):
    @req("R4")
    def test_env_off_disables(self):
        self.assertIsNone(self.hook("pre_read", {"session_id": "s1", "tool_input": {"file_path": self.big}}, WIT_GUARD="off"))

    @req("R4")
    def test_tuning_file_sets_mode_and_env_overrides_it(self):
        self.set_tuning(read_guard={"mode": "nudge"})
        self.assertEqual(self.read(self.big, sid="x")["hookSpecificOutput"]["permissionDecision"], "deny")
        out = self.hook("pre_read", {"session_id": "y", "tool_input": {"file_path": self.big}}, WIT_GUARD="warn")
        self.assertNotIn("permissionDecision", out["hookSpecificOutput"])

    @req("R4")
    def test_tuning_threshold_respected(self):
        self.set_tuning(read_guard={"max_lines": 5000})
        self.assertIsNone(self.read(self.big))


class BashHintTest(WitTestCase):
    def bash(self, cmd):
        return self.hook("pre_bash", {"session_id": "s1", "tool_input": {"command": cmd}})

    @req("R5")
    def test_hint_only_for_learned_noisy_family(self):
        self.set_tuning(bash={"noisy_families": {"pytest": 48000}})
        out = self.bash("pytest tests/")["hookSpecificOutput"]
        self.assertNotIn("permissionDecision", out)
        self.assertIn("~48KB", out["additionalContext"])
        self.assertIsNone(self.bash("ls -la"))

    @req("R5")
    def test_no_hint_when_output_already_limited(self):
        self.set_tuning(bash={"noisy_families": {"pytest": 48000}})
        for cmd in ("pytest -q tests", "pytest tests | tail -n 20", "pytest tests | head"):
            self.assertIsNone(self.bash(cmd), cmd)

    @req("R5")
    def test_family_detection(self):
        self.set_tuning(bash={"noisy_families": {"npm test": 30000}})
        self.assertIsNotNone(self.bash("CI=1 npm test"))
        self.assertIsNone(self.bash("npm install"))


if __name__ == "__main__":
    unittest.main()
