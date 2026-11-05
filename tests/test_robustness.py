"""Hooks never break a session (R17)."""
import os
import unittest

from helpers import TOK, WitTestCase, req

EVENTS = ("session_start", "pre_read", "pre_bash", "post_tool", "pre_compact", "session_end")


class RobustnessTest(WitTestCase):
    def assert_silent_success(self, stdin, env=None, event=None):
        for ev in [event] if event else EVENTS:
            r = self.run_script(TOK, ev, stdin=stdin, env=env, check=False)
            self.assertEqual(r.returncode, 0, f"{ev}: {r.stderr}")
            self.assertEqual(r.stderr, "", ev)

    @req("R17")
    def test_malformed_and_empty_input(self):
        for stdin in ("", "not json", "[]", "null", '{"tool_input": "string"}', '{"tool_input": null}'):
            self.assert_silent_success(stdin)

    @req("R17")
    def test_unknown_event(self):
        self.assert_silent_success("{}", event="bogus_event")

    @req("R17")
    def test_unwritable_data_dir(self):
        blocker = os.path.join(self.work, "afile")
        with open(blocker, "w") as f:
            f.write("x")
        env = {"WIT_HOME": os.path.join(blocker, "wit"), "WIT_GUARD": "nudge"}
        stdin = '{"session_id": "s", "cwd": "%s", "tool_name": "Read", "tool_input": {"file_path": "%s"}}' % (self.work, self.big)
        self.assert_silent_success(stdin, env=env)

    @req("R17")
    def test_corrupt_tuning_and_state(self):
        with open(os.path.join(self.home, "tuning.json"), "w") as f:
            f.write("{corrupt")
        os.makedirs(os.path.join(self.home, "state"))
        self.env["WIT_GUARD"] = "nudge"
        self.read(self.big)  # creates state for this session...
        for name in os.listdir(os.path.join(self.home, "state")):
            with open(os.path.join(self.home, "state", name), "w") as f:
                f.write("[]")  # ...then corrupt it to the old list format
        self.assert_silent_success('{"session_id": "s1", "tool_input": {"file_path": "%s"}}' % self.big, event="pre_read")
        self.tuner()

    @req("R17")
    def test_unreadable_file(self):
        p = self.make_file("locked.py", 3000)
        os.chmod(p, 0)
        try:
            self.assert_silent_success('{"session_id": "s", "tool_input": {"file_path": "%s"}}' % p, event="pre_read")
        finally:
            os.chmod(p, 0o600)


if __name__ == "__main__":
    unittest.main()
