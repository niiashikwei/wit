"""Self-tuning loop (R9–R12, R18)."""
import json
import os
import time
import unittest

from helpers import WitTestCase, req


class ReadGuardTuningTest(WitTestCase):
    def nudges(self, n, override_every=0, max_lines=800):
        self.set_tuning(read_guard={"mode": "nudge", "max_lines": max_lines})
        self.env["WIT_GUARD"] = "nudge"
        events = []
        for i in range(n):
            events.append({"e": "guard", "s": f"s{i}", "r": "read", "d": "deny"})
            if override_every and i % override_every == 0:
                events.append({"e": "guard", "s": f"s{i}", "r": "read", "d": "override"})
        self.append_events(*events)

    @req("R9")
    def test_promotes_warn_to_nudge_on_persistent_big_reads(self):
        for i in range(5):
            self.append_events({"e": "session", "s": f"s{i}"}, *[{"e": "read", "s": f"s{i}", "big": True}] * 2)
        t = (self.tuner(), self.tuning())[1]
        self.assertEqual(t["read_guard"]["mode"], "nudge")

    @req("R9")
    def test_no_promotion_without_enough_sessions(self):
        for i in range(4):
            self.append_events({"e": "session", "s": f"s{i}"}, *[{"e": "read", "s": f"s{i}", "big": True}] * 5)
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"]["mode"], "warn")

    @req("R9")
    def test_loosens_when_overridden_40_to_60_percent(self):
        self.nudges(10, override_every=2)  # 50%
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"]["max_lines"], 1000)

    @req("R9")
    def test_falls_back_to_warn_above_60_percent(self):
        self.nudges(10, override_every=1)  # 100%
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"]["mode"], "warn")

    @req("R9")
    def test_tightens_when_rarely_overridden(self):
        self.nudges(20)
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"]["max_lines"], 720)

    @req("R9")
    def test_bounds_respected(self):
        self.nudges(20, max_lines=420)
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"]["max_lines"], 400)
        os.remove(os.path.join(self.home, "metrics.jsonl"))
        self.nudges(10, override_every=2, max_lines=3900)
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"]["max_lines"], 4000)

    @req("R9")
    def test_needs_minimum_evidence(self):
        self.nudges(7, override_every=1)
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"], {"mode": "nudge", "max_lines": 800})

    @req("R9")
    def test_ignores_events_older_than_window(self):
        self.set_tuning(read_guard={"mode": "nudge", "max_lines": 800})
        old = int(time.time()) - 30 * 86400
        with open(os.path.join(self.home, "metrics.jsonl"), "w") as f:
            for i in range(10):
                f.write(json.dumps({"e": "guard", "r": "read", "d": "deny", "s": "x", "ts": old}) + "\n")
                f.write(json.dumps({"e": "guard", "r": "read", "d": "override", "s": "x", "ts": old}) + "\n")
        self.tuner()
        self.assertEqual(self.tuning()["read_guard"]["mode"], "nudge")


class BashTuningTest(WitTestCase):
    @req("R10")
    def test_learns_and_forgets_noisy_families(self):
        for _ in range(3):
            self.post("Bash", {"command": "pytest"}, {"stdout": "." * 50000})
            self.post("Bash", {"command": "ls"}, {"stdout": "a"})
        self.tuner()
        noisy = self.tuning()["bash"]["noisy_families"]
        self.assertIn("pytest", noisy)
        self.assertNotIn("ls", noisy)
        for _ in range(30):  # pytest becomes quiet on average
            self.post("Bash", {"command": "pytest"}, "ok")
        self.tuner()
        self.assertNotIn("pytest", self.tuning()["bash"]["noisy_families"])

    @req("R10")
    def test_needs_three_samples(self):
        for _ in range(2):
            self.post("Bash", {"command": "pytest"}, {"stdout": "." * 50000})
        self.tuner()
        self.assertEqual(self.tuning()["bash"]["noisy_families"], {})


class HistoryAndControlsTest(WitTestCase):
    def overrides(self):
        self.set_tuning(read_guard={"mode": "nudge", "max_lines": 800})
        self.append_events(*[{"e": "guard", "s": "s", "r": "read", "d": d} for d in ["deny", "override"] * 10])

    @req("R11")
    def test_changes_logged_with_reason(self):
        self.overrides()
        self.tuner()
        h = self.tuning()["history"][-1]
        self.assertEqual(h["change"], "read_guard.mode: nudge -> warn")
        self.assertIn("overridden", h["reason"])

    @req("R11")
    def test_history_capped_at_50(self):
        self.overrides()
        self.set_tuning(read_guard={"mode": "nudge", "max_lines": 800},
                        history=[{"change": str(i)} for i in range(60)])
        self.tuner()
        self.assertEqual(len(self.tuning()["history"]), 50)

    @req("R11")
    def test_pinned_freezes_settings_but_updates_savings(self):
        self.overrides()
        t = self.tuning()
        t["pinned"] = True
        self.set_tuning(**t)
        self.append_events({"e": "saved", "s": "s", "k": "read", "tok": 500})
        out = json.loads(self.tuner().stdout)
        self.assertTrue(out["proposed"])
        after = self.tuning()
        self.assertEqual(after["read_guard"]["mode"], "nudge")
        self.assertEqual(after["savings"]["last_30d"], 500)

    @req("R11")
    def test_dry_run_writes_nothing(self):
        self.overrides()
        before = self.tuning()
        out = json.loads(self.tuner("--dry-run").stdout)
        self.assertTrue(out["proposed"])
        self.assertEqual(self.tuning(), before)


class TranscriptTest(WitTestCase):
    def transcript(self, rows):
        p = os.path.join(self.work, "t.jsonl")
        with open(p, "w") as f:
            for r in rows:
                f.write((r if isinstance(r, str) else json.dumps(r)) + "\n")
        return p

    @staticmethod
    def msg(mid, model="claude-opus-5-5", **usage):
        return {"type": "assistant", "message": {"id": mid, "model": model, "content": "SECRET reply",
                                                 "usage": usage}}

    @req("R12")
    def test_summarizes_and_dedupes(self):
        p = self.transcript([
            self.msg("a", input_tokens=10, output_tokens=5, cache_read_input_tokens=100),
            self.msg("a", input_tokens=10, output_tokens=5, cache_read_input_tokens=100),
            self.msg("b", model="claude-sonnet-5-5", input_tokens=1, output_tokens=7, cache_creation_input_tokens=50),
            {"type": "user", "message": {"content": "SECRET prompt"}},
            "not json",
        ])
        self.tuner("--session", "x", "--transcript", p, "--cwd", self.work)
        s = [e for e in self.events() if e["e"] == "session"][0]
        self.assertEqual((s["turns"], s["in"], s["out"], s["cr"], s["cc"]), (2, 11, 12, 100, 50))
        self.assertEqual(s["models"], {"claude-opus-5-5": 5, "claude-sonnet-5-5": 7})
        self.assertNotIn("SECRET", self.raw_metrics())

    @req("R12", "R17")
    def test_missing_transcript_is_harmless(self):
        self.tuner("--session", "x", "--transcript", "/nonexistent.jsonl")
        self.assertEqual([e for e in self.events() if e["e"] == "session"], [])

    @req("R12")
    def test_session_end_hook_runs_tuner_in_background(self):
        p = self.transcript([self.msg("a", input_tokens=1, output_tokens=1)])
        self.hook("session_end", {"session_id": "x", "transcript_path": p, "cwd": self.work})
        deadline = time.time() + 5
        while time.time() < deadline and not os.path.exists(os.path.join(self.home, "tuning.json")):
            time.sleep(0.05)
        self.assertTrue(os.path.exists(os.path.join(self.home, "tuning.json")))


class LearnedTipsTest(WitTestCase):
    def tips(self):
        self.tuner()
        return " | ".join(self.tuning()["tips"])

    @req("R22")
    def test_no_tips_without_signal(self):
        self.assertEqual(self.tips(), "")

    @req("R22")
    def test_dominant_tool_and_heavy_mcp_tool(self):
        for _ in range(3):
            self.append_events({"e": "tool", "s": "a", "t": "mcp__docs__search", "b": 30000},
                               {"e": "tool", "s": "a", "t": "Read", "b": 1000})
        tips = self.tips()
        self.assertIn("`mcp__docs__search` produces 97%", tips)
        self.assertIn("averages 30KB per call", tips)

    @req("R22")
    def test_low_cache_opus_heavy_and_frequent_compaction(self):
        for i in range(3):
            self.append_events({"e": "session", "s": f"s{i}", "in": 900, "cr": 100, "cc": 0, "out": 10,
                                "models": {"claude-opus-5-5": 100}},
                               {"e": "compact", "s": f"s{i}"})
        tips = self.tips()
        self.assertIn("Cache hit rate is 10%", tips)
        self.assertIn("Opus", tips)
        self.assertIn("compaction", tips)
        self.assertLessEqual(len(self.tuning()["tips"]), 4)

    @req("R22")
    def test_healthy_sessions_produce_no_tips(self):
        for i in range(3):
            self.append_events({"e": "session", "s": f"s{i}", "in": 10, "cr": 900, "cc": 90, "out": 10,
                                "models": {"claude-sonnet-5-5": 100}})
        self.assertEqual(self.tips(), "")


class StorageBoundsTest(WitTestCase):
    @req("R18")
    def test_metrics_trimmed(self):
        with open(os.path.join(self.home, "metrics.jsonl"), "w") as f:
            line = json.dumps({"e": "tool", "t": "Read", "b": 1, "s": "s", "ts": int(time.time())}) + "\n"
            f.write(line * 25000)
        self.tuner()
        with open(os.path.join(self.home, "metrics.jsonl")) as f:
            self.assertLessEqual(sum(1 for _ in f), 20000)

    @req("R18")
    def test_old_state_files_removed(self):
        state = os.path.join(self.home, "state")
        os.makedirs(state)
        old, new = os.path.join(state, "old.json"), os.path.join(state, "new.json")
        for p in (old, new):
            with open(p, "w") as f:
                f.write("{}")
        os.utime(old, (time.time() - 3 * 86400,) * 2)
        self.tuner()
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(new))


if __name__ == "__main__":
    unittest.main()
