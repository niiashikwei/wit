---
description: Open the Morpheus live dashboard of this project's hooks, skills, agents and tokens in your browser
---
Start the Morpheus dashboard for this project and give me its address.

Run this as a background command (it keeps running), then tell me the address it prints:

```bash
node "${CLAUDE_PLUGIN_ROOT}/morpheus/dist/cli.js" serve --open
```

If port 4673 is taken, add `--port 4674`. Don't wait on the command: it serves until stopped. Needs Node 24 (or 23.6+).
