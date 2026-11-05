"""Performance budgets (R19, R20). Prints a latency table; skipped under coverage
(instrumentation distorts timings). Budgets can be relaxed for slow machines with
WIT_PERF_BUDGET_MS (hook p95, default 150)."""
import json
import os
import statistics
import sys
import time
import unittest

from helpers import TOK, TUNER, WitTestCase, req

RUNS = 25
HOOK_BUDGET = float(os.environ.get("WIT_PERF_BUDGET_MS", 150)) / 1000
RESULTS = {}


def p95(xs):
    return sorted(xs)[max(0, int(len(xs) * 0.95) - 1)]


@unittest.skipIf(os.environ.get("WIT_COVERAGE"), "timings meaningless under coverage")
class PerformanceTest(WitTestCase):
    @classmethod
    def tearDownClass(cls):
        if RESULTS:
            rows = [f"  {name:<34} p50 {r[0] * 1000:6.1f} ms   p95 {r[1] * 1000:6.1f} ms" for name, r in RESULTS.items()]
            sys.stderr.write("\nWit performance\n" + "\n".join(rows) + "\n")

    def measure(self, name, fn, runs=RUNS):
        fn()  # warm the OS file cache
        times = []
        for _ in range(runs):
            fn()
            times.append(self.elapsed)
        RESULTS[name] = (statistics.median(times), p95(times))
        return RESULTS[name][1]

    def payloads(self):
        tr = os.path.join(self.work, "t.jsonl")
        with open(tr, "w") as f:
            for i in range(200):
                f.write(json.dumps({"type": "assistant", "message": {"id": str(i), "usage": {"input_tokens": 5}}}) + "\n")
        return {
            "session_start": {"session_id": "s", "cwd": self.work},
            "pre_read (small file)": {"session_id": "s", "tool_input": {"file_path": self.small}},
            "pre_read (3k-line file, warn)": {"session_id": "s", "tool_input": {"file_path": self.big}},
            "pre_bash": {"session_id": "s", "tool_input": {"command": "pytest tests"}},
            "post_tool (100KB output)": {"session_id": "s", "tool_name": "Bash", "tool_input": {"command": "ls"},
                                         "tool_response": {"stdout": "x" * 100000}},
            "pre_compact": {"session_id": "s"},
            "session_end (spawns tuner)": {"session_id": "s", "transcript_path": tr, "cwd": self.work},
        }

    @req("R19")
    def test_hook_latency_p95_within_budget(self):
        self.set_tuning(bash={"noisy_families": {"pytest": 40000}}, tips=["a", "b", "c"])
        for name, payload in self.payloads().items():
            event = name.split()[0]
            stdin = json.dumps(payload)
            worst = self.measure(name, lambda: self.run_script(TOK, event, stdin=stdin))
            self.assertLessEqual(worst, HOOK_BUDGET, f"{name} p95 {worst * 1000:.0f} ms")

    @req("R19")
    def test_hooks_with_large_metrics_history(self):
        with open(os.path.join(self.home, "metrics.jsonl"), "w") as f:
            f.write((json.dumps({"e": "tool", "t": "Read", "b": 10, "s": "s", "ts": int(time.time())}) + "\n") * 20000)
        stdin = json.dumps({"session_id": "s", "cwd": self.work})
        worst = self.measure("session_start (20k-line history)", lambda: self.run_script(TOK, "session_start", stdin=stdin))
        self.assertLessEqual(worst, HOOK_BUDGET)

    @req("R20")
    def test_guard_on_huge_file(self):
        huge = self.make_file("huge.log", 1_500_000)  # ~50 MB
        stdin = json.dumps({"session_id": "s", "tool_input": {"file_path": huge}})
        worst = self.measure("pre_read (50 MB file)", lambda: self.run_script(TOK, "pre_read", stdin=stdin), runs=5)
        self.assertLessEqual(worst, 0.3)

    @req("R20")
    def test_tuner_on_full_metrics_file(self):
        now = int(time.time())
        kinds = [{"e": "tool", "t": "Bash", "f": "pytest", "b": 30000}, {"e": "read", "big": True},
                 {"e": "guard", "r": "read", "d": "deny"}, {"e": "saved", "k": "read", "tok": 100},
                 {"e": "session", "in": 1, "cr": 1, "cc": 1, "out": 1, "models": {"m": 1}}]
        with open(os.path.join(self.home, "metrics.jsonl"), "w") as f:
            for i in range(20000):
                f.write(json.dumps({**kinds[i % 5], "s": f"s{i % 300}", "ts": now}) + "\n")
        worst = self.measure("tuner (20k-line metrics)", lambda: self.run_script(TUNER), runs=3)
        self.assertLessEqual(worst, 2.0)


if __name__ == "__main__":
    unittest.main()
