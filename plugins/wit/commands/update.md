---
description: Check for a newer Wit and install it, or turn automatic updates on or off (/wit:update auto, /wit:update auto off)
---
Update the Wit plugin. Arguments: `$ARGUMENTS`

- If the arguments are `auto` or `auto on`, run `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/update.py" auto on` and tell me Wit will now update itself in the background when a new version is out (I'll be told to restart). If they are `auto off`, run it with `off` instead and say so.
- Otherwise, run `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/update.py" check --force` and read its JSON.
  - If `newer` is false, tell me I'm on the latest Wit (`installed`), or give the `error` if there is one.
  - If `newer` is true, run `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/update.py" apply` (it runs `claude plugin update` for Wit). If `applied.ok` is true, tell me Wit is updated from `installed` to `latest` and that I need to restart Claude Code to load it. If not, show `applied.error` and the two commands to run myself: `claude plugin marketplace update <marketplace>` then `claude plugin update wit@<marketplace>`.

Keep the answer to two or three sentences.
