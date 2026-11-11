/**
 * `morpheus init`: turns on full hook timing in a project, whatever its language. It copies
 * hooks/morpheus-time.sh into the project's .claude/hooks/ and routes each hook command in
 * .claude/settings.json (and settings.local.json) through it. A backup of each settings file is
 * kept, and `--undo` puts the commands back. Nothing outside .claude/ changes.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WRAP = 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/morpheus-time.sh ';

/** Whether a hook command can be wrapped: one simple command, no shell operators of its own. */
export function wrappable(command: string): boolean {
  const bare = command.replace(/'[^']*'|"[^"]*"/g, "''");
  return !command.startsWith(WRAP) && !/[|;&<>()`]|\$\(/.test(bare) && !/morpheus-time\.sh/.test(command);
}

/** A settings object with every wrappable hook command routed through the timer (or back, with undo). */
export function rewrite(settings: Record<string, any>, undo = false) {
  let changed = 0;
  const skipped: string[] = [];
  for (const groups of Object.values(settings.hooks ?? {}))
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (typeof h?.command !== "string") continue;
        if (undo) {
          if (h.command.startsWith(WRAP)) {
            h.command = h.command.slice(WRAP.length);
            changed++;
          }
        } else if (wrappable(h.command)) {
          h.command = WRAP + h.command;
          changed++;
        } else if (!h.command.startsWith(WRAP)) skipped.push(h.command);
      }
  return { settings, changed, skipped };
}

export function init(root: string, opts: { undo?: boolean; dryRun?: boolean; timer: string }) {
  const lines: string[] = [];
  const claude = join(root, ".claude");
  if (!opts.undo && !opts.dryRun) {
    mkdirSync(join(claude, "hooks"), { recursive: true });
    const dest = join(claude, "hooks", "morpheus-time.sh");
    copyFileSync(opts.timer, dest);
    chmodSync(dest, 0o755);
    lines.push(`Copied the hook timer to ${dest}`);
  }
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = join(claude, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const { settings, changed, skipped } = rewrite(JSON.parse(text), opts.undo);
    for (const s of skipped) lines.push(`Left as is (shell operators): ${s}`);
    if (!changed) {
      lines.push(`${name}: nothing to ${opts.undo ? "restore" : "wrap"}`);
      continue;
    }
    lines.push(`${name}: ${opts.undo ? "restored" : "timing"} ${changed} hook command(s)`);
    if (opts.dryRun) continue;
    writeFileSync(`${file}.morpheus-bak`, text);
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  if (!opts.dryRun)
    lines.push(
      "Restart Claude Code sessions in this project: hooks load when a session starts.",
    );
  return lines;
}
