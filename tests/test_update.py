"""Updates: telling the person a newer Wit is out, and installing it (R70–R72)."""
import json
import os
import stat
import sys
import tempfile
import time
import unittest

from helpers import PLUGIN, TOK, UPDATE, WitTestCase, req

with open(os.path.join(PLUGIN, ".claude-plugin", "plugin.json")) as f:
    INSTALLED = json.load(f)["version"]
NEXT = ".".join(INSTALLED.split(".")[:-1] + [str(int(INSTALLED.split(".")[-1]) + 1)])

FAKE_CLAUDE = """#!{python}
import json, os, sys
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
fail = os.environ.get("FAKE_FAIL", "")
if fail and fail in " ".join(sys.argv[1:]):
    sys.stderr.write("boom: " + fail)
    sys.exit(1)
if sys.argv[1:4] == ["plugin", "marketplace", "update"] and os.environ.get("FAKE_LATEST"):
    with open(os.environ["FAKE_FILE"], "w") as f:
        json.dump({{"name": "wit", "version": os.environ["FAKE_LATEST"]}}, f)
"""


class UpdateTestCase(WitTestCase):
    def setUp(self):
        super().setUp()
        del self.env["WIT_UPDATE_CHECK"]
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        self.market = tempfile.mkdtemp(prefix="wit-market-")
        other = tempfile.mkdtemp(prefix="other-market-")
        os.makedirs(os.path.join(self.market, ".claude-plugin"))
        os.makedirs(os.path.join(self.market, "plugins", "wit", ".claude-plugin"))
        os.makedirs(os.path.join(cfg, "plugins"))
        with open(os.path.join(self.market, ".claude-plugin", "marketplace.json"), "w") as f:
            json.dump({"name": "wit", "plugins": [{"name": "wit", "source": "./plugins/wit"}]}, f)
        self.remote = os.path.join(self.market, "plugins", "wit", ".claude-plugin", "plugin.json")
        self.set_remote(INSTALLED)
        with open(os.path.join(cfg, "plugins", "known_marketplaces.json"), "w") as f:
            json.dump({"official": {"source": {"source": "github", "repo": "x/y"}, "installLocation": other},
                       "wit": {"source": {"source": "github", "repo": "o/wit"}, "installLocation": self.market}}, f)
        self.log = os.path.join(self.work, "claude.log")
        fake = os.path.join(self.work, "claude")
        with open(fake, "w") as f:
            f.write(FAKE_CLAUDE.format(python=sys.executable))
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        self.env.update({"WIT_CLAUDE_BIN": fake, "FAKE_LOG": self.log, "FAKE_FILE": self.remote})

    def set_remote(self, version):
        with open(self.remote, "w") as f:
            json.dump({"name": "wit", "version": version}, f)

    def update(self, *args, **env):
        return json.loads(self.run_script(UPDATE, *args, env=env).stdout)

    def calls(self):
        try:
            with open(self.log) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def state(self):
        with open(os.path.join(self.home, "update.json")) as f:
            return json.load(f)

    def write_state(self, **s):
        with open(os.path.join(self.home, "update.json"), "w") as f:
            json.dump(s, f)

    def start(self, **env):
        out = self.hook("session_start", {"session_id": "s1", "cwd": self.work}, **env)
        return out.get("systemMessage") or "", out["hookSpecificOutput"]["additionalContext"]

    def wait_for(self, cond, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.1)
        return False


class CheckTest(UpdateTestCase):
    @req("R70")
    def test_check_refreshes_the_marketplace_through_claude_code_then_reads_its_version(self):
        s = self.update("check", FAKE_LATEST=NEXT)
        self.assertEqual((s["installed"], s["latest"], s["newer"], s["marketplace"]), (INSTALLED, NEXT, True, "wit"))
        self.assertNotIn("error", s)
        self.assertEqual(self.calls(), ["plugin marketplace update wit"])
        # Once a day: a second check reads what it remembered; --force asks again.
        self.update("check")
        self.assertEqual(len(self.calls()), 1)
        self.update("check", "--force")
        self.assertEqual(len(self.calls()), 2)

    @req("R70")
    def test_check_without_the_claude_command_reads_the_local_copy(self):
        self.set_remote(NEXT)
        del self.env["WIT_CLAUDE_BIN"]
        s = self.update("check", PATH=tempfile.mkdtemp())
        self.assertEqual((s["latest"], s["newer"]), (NEXT, True))
        self.assertNotIn("error", s)

    @req("R70")
    def test_failures_are_recorded_and_never_raise(self):
        s = self.update("check", FAKE_FAIL="marketplace")
        self.assertIn("plugin marketplace update failed: boom", s["error"])
        self.assertEqual(s["latest"], INSTALLED, "the local copy is still read")
        s = self.update("check", "--force", WIT_CLAUDE_BIN=os.path.join(self.work, "missing"))
        self.assertIn("FileNotFoundError", s["error"])
        with open(self.remote, "w") as f:
            json.dump({"name": "wit"}, f)
        s = self.update("check", "--force")
        self.assertEqual(s["error"], "the marketplace has no version for Wit")
        os.remove(os.path.join(self.env["CLAUDE_CONFIG_DIR"], "plugins", "known_marketplaces.json"))
        s = self.update("check", "--force")
        self.assertEqual(s["error"], "Wit's marketplace wasn't found")

    @req("R70")
    def test_versions_compare_by_number_and_odd_ones_are_never_newer(self):
        for latest, newer in [(NEXT, True), (INSTALLED, False), ("0.0.1", False), ("v99.0.0", True), ("abc", False)]:
            self.set_remote(latest)
            self.assertEqual(self.update("check", "--force")["newer"], newer, latest)

    @req("R70")
    def test_status_and_off_switches(self):
        s = self.update("status")
        self.assertEqual((s["installed"], s["newer"], s["settings"]), (INSTALLED, False, {"check": True, "auto": False}))
        self.assertEqual(self.update(WIT_UPDATE_CHECK="off")["settings"], {"check": False, "auto": False})
        self.set_tuning(update={"check": False, "auto": True})
        self.assertEqual(self.update("status")["settings"], {"check": False, "auto": False}, "no check, no automatic update")


class NoticeTest(UpdateTestCase):
    @req("R71")
    def test_session_start_tells_the_person_and_claude_about_a_newer_wit(self):
        self.write_state(checked_at=time.time(), latest=NEXT)
        msg, ctx = self.start()
        self.assertIn(f"Wit {NEXT} is out (you have {INSTALLED})", msg)
        self.assertIn("/wit:update", msg)
        self.assertIn(f"A newer Wit ({NEXT}", ctx)
        self.assertEqual(self.calls(), [], "a fresh check isn't repeated")

    @req("R71")
    def test_nothing_is_said_when_up_to_date_or_switched_off(self):
        self.write_state(checked_at=time.time(), latest=INSTALLED)
        msg, ctx = self.start()
        self.assertNotIn("Wit", msg)
        self.assertNotIn("newer Wit", ctx)
        self.write_state(checked_at=time.time(), latest=NEXT)
        msg, _ = self.start(WIT_UPDATE_CHECK="off")
        self.assertNotIn("Wit", msg)

    @req("R71")
    def test_a_stale_check_runs_in_the_background_without_holding_up_the_session(self):
        self.env["FAKE_LATEST"] = NEXT
        self.write_state(checked_at=0)
        self.start()
        self.assertTrue(self.wait_for(lambda: self.state().get("latest") == NEXT))
        msg, _ = self.start()
        self.assertIn(f"Wit {NEXT} is out", msg)

    @req("R71")
    def test_the_notice_joins_the_savings_message(self):
        self.write_state(checked_at=time.time(), latest=NEXT)
        self.set_tuning(savings={"last_30d": 50000, "last_session": 1000, "sessions": 3})
        msg, _ = self.start()
        self.assertEqual(len(msg.splitlines()), 2)


class ApplyTest(UpdateTestCase):
    @req("R72")
    def test_apply_updates_through_claude_code_and_asks_for_a_restart(self):
        s = self.update("apply", FAKE_LATEST=NEXT)
        self.assertEqual(self.calls(), ["plugin marketplace update wit", "plugin update wit@wit"])
        self.assertEqual((s["applied"]["ok"], s["applied"]["version"], s["applied"]["error"]), (True, NEXT, None))
        msg, ctx = self.start()
        self.assertIn(f"Wit {NEXT} is installed: restart Claude Code", msg)
        self.assertNotIn("newer Wit", ctx)

    @req("R72")
    def test_a_failed_update_is_reported_with_how_to_retry(self):
        s = self.update("apply", FAKE_LATEST=NEXT, FAKE_FAIL="plugin update")
        self.assertFalse(s["applied"]["ok"])
        self.assertIn("plugin update wit@wit failed: boom", s["applied"]["error"])
        msg, ctx = self.start()
        self.assertIn(f"Wit couldn't update itself to {NEXT}", msg)
        self.assertIn("/wit:update", ctx)

    @req("R72")
    def test_apply_does_nothing_when_up_to_date_or_without_claude(self):
        s = self.update("apply")
        self.assertEqual((s["applied"]["ok"], s["applied"]["skipped"]), (True, "already up to date"))
        self.assertEqual(self.calls(), ["plugin marketplace update wit"])
        self.set_remote(NEXT)
        del self.env["WIT_CLAUDE_BIN"]
        s = self.update("apply", PATH=tempfile.mkdtemp())
        self.assertEqual(s["applied"]["error"], "the claude command isn't on PATH")

    @req("R72")
    def test_automatic_updates_run_in_the_background_at_session_start(self):
        self.assertEqual(self.update("auto", "on"), {"check": True, "auto": True})
        self.assertTrue(self.tuning()["update"]["auto"])
        self.env["FAKE_LATEST"] = NEXT
        self.write_state(checked_at=time.time(), latest=NEXT)
        msg, ctx = self.start()
        self.assertIn(f"Wit is updating from {INSTALLED} to {NEXT} in the background", msg)
        self.assertNotIn("newer Wit", ctx)
        self.assertTrue(self.wait_for(lambda: "plugin update wit@wit" in self.calls()))
        self.assertTrue(self.wait_for(lambda: (self.state().get("applied") or {}).get("ok")))
        self.assertEqual(self.update("auto", "off"), {"check": True, "auto": False})
        self.assertEqual(self.update(WIT_AUTO_UPDATE="on")["settings"]["auto"], True)
        self.update("auto", "on")
        self.assertEqual(self.update(WIT_AUTO_UPDATE="off")["settings"]["auto"], False)


if __name__ == "__main__":
    unittest.main()
