---
description: Open Wit's live SDLC dashboard (health, DORA, tests, tokens, AI effectiveness, quality, resources, hooks and agents) for this project
---
Start the Wit dashboard for this project and give me its address.

Run this as a background command (it keeps running), then tell me the address it prints:

```bash
node "${CLAUDE_PLUGIN_ROOT}/morpheus/dist/cli.js" serve --open
```

If port 4673 is taken, add `--port 4674`. Don't wait on the command: it serves until stopped. Needs Node 24 (or 23.6+).

In the Claude desktop app the same page also opens as an artifact beside the session, reading the `morpheus` MCP server this plugin installs.
