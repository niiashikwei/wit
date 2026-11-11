"""Plugin packaging (R21)."""
import glob
import json
import os
import re
import unittest

from helpers import PLUGIN, REPO, req


def frontmatter(path):
    with open(path) as f:
        text = f.read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    assert m, f"{path} has no frontmatter"
    return dict(line.split(":", 1) for line in m.group(1).splitlines() if ":" in line)


class PackagingTest(unittest.TestCase):
    def load(self, *parts):
        with open(os.path.join(*parts)) as f:
            return json.load(f)

    @req("R21")
    def test_manifests_valid_and_consistent(self):
        market = self.load(REPO, ".claude-plugin", "marketplace.json")
        plugin = self.load(PLUGIN, ".claude-plugin", "plugin.json")
        entry = market["plugins"][0]
        self.assertEqual(entry["name"], plugin["name"])
        self.assertTrue(os.path.isdir(os.path.join(REPO, entry["source"])))
        self.assertRegex(plugin["version"], r"^\d+\.\d+\.\d+$")

    @req("R21")
    def test_every_hook_command_targets_existing_script_and_handler(self):
        hooks = self.load(PLUGIN, "hooks", "hooks.json")["hooks"]
        with open(os.path.join(PLUGIN, "scripts", "tok.py")) as f:
            tok_src = f.read()
        seen = 0
        for groups in hooks.values():
            for group in groups:
                for h in group["hooks"]:
                    m = re.search(r'\$\{CLAUDE_PLUGIN_ROOT\}/(\S+?)"? (\w+)$', h["command"])
                    self.assertIsNotNone(m, h["command"])
                    self.assertTrue(os.path.isfile(os.path.join(PLUGIN, m.group(1))), m.group(1))
                    self.assertIn(f"def {m.group(2)}(", tok_src)
                    self.assertLessEqual(h.get("timeout", 60), 10)
                    seen += 1
        self.assertEqual(seen, 6)

    @req("R21")
    def test_agents_have_frontmatter_and_cheaper_models(self):
        agents = glob.glob(os.path.join(PLUGIN, "agents", "*.md"))
        self.assertEqual(len(agents), 3)
        for p in agents:
            fm = frontmatter(p)
            self.assertTrue(fm.get("name") and fm.get("description"), p)
            self.assertIn(fm.get("model", "").strip(), {"haiku", "sonnet"}, p)
        self.assertEqual(frontmatter(os.path.join(PLUGIN, "agents", "scout.md"))["model"].strip(), "haiku")

    @req("R21")
    def test_skills_and_commands_have_frontmatter(self):
        for p in glob.glob(os.path.join(PLUGIN, "skills", "*", "SKILL.md")):
            fm = frontmatter(p)
            self.assertEqual(fm["name"].strip(), os.path.basename(os.path.dirname(p)))
            self.assertLessEqual(len(fm["description"]), 1024)
        for p in glob.glob(os.path.join(PLUGIN, "commands", "*.md")):
            self.assertIn("description", frontmatter(p))


class MorpheusPackagingTest(unittest.TestCase):
    @req("R34")
    def test_mcp_server_dashboard_and_commands_point_at_shipped_files(self):
        with open(os.path.join(PLUGIN, ".mcp.json")) as f:
            server = json.load(f)["mcpServers"]["morpheus"]
        self.assertEqual(server["command"], "node")
        self.assertEqual(server["args"][1], "mcp")
        script = server["args"][0].replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN)
        self.assertTrue(os.path.isfile(script), script)
        morpheus = os.path.join(PLUGIN, "morpheus")
        self.assertTrue(os.path.isfile(os.path.join(morpheus, "web", "dashboard.html")))
        self.assertTrue(os.path.isfile(os.path.join(morpheus, "hooks", "morpheus-time.sh")))
        built = {f[:-3] for f in os.listdir(os.path.join(morpheus, "dist"))}
        sources = {f[:-3] for f in os.listdir(os.path.join(morpheus, "src")) if f.endswith(".ts")}
        self.assertEqual(built, sources, "dist/ has one built file per source")
        for name in ("dashboard.md", "process-report.md"):
            with open(os.path.join(PLUGIN, "commands", name)) as f:
                self.assertIn("${CLAUDE_PLUGIN_ROOT}/morpheus/dist/cli.js", f.read())


if __name__ == "__main__":
    unittest.main()
