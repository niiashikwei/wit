/**
 * What a project has set up for Claude Code, wherever it comes from: hook scripts wired in the
 * project's, its local and your user settings; skills and agents in the project's .claude/, your
 * ~/.claude/ and installed plugins. Coverage and the improvements compare it with what ran.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeHome } from "./paths.ts";

export type Scope = "project" | "user" | "plugin";
export interface Defined {
  hooks: string[];
  /** Hook rules with their modes, when the project names them (a `.claude/process.json`). */
  rules: Record<string, string>;
  skills: string[];
  agents: string[];
  /** Each skill's SKILL.md size in characters, for what a load adds to the context. */
  skillChars?: Record<string, number>;
  /** Where each hook, skill and agent is defined. */
  where?: Record<string, Scope>;
  /** The event each hook script is wired to (its first), for its time budget. */
  hookEvents?: Record<string, string>;
}

const json = (f: string): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
};

/** `bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/after-edit.sh` → `after-edit`; `npx prettier …` → `npx`. */
export function hookName(command: string): string {
  return (
    command.match(/([\w.-]+)\.(sh|ts|js|mjs|cjs|py|rb)\b/)?.[1] ??
    basename(command.trim().split(/\s+/)[0] ?? "hook")
  );
}

/** Hook scripts in one settings file's `hooks`, with the event each is wired to. */
function hooksIn(settings: Record<string, any>): [string, string][] {
  const out: [string, string][] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {}))
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of Array.isArray(g?.hooks) ? g.hooks : [])
        if (typeof h?.command === "string") out.push([hookName(h.command), event]);
  return out;
}

/** Skill folders (with SKILL.md) and agent files (.md) under a .claude-like folder. */
function skillsAndAgents(dir: string, prefix = "") {
  const skills: [string, string][] = [];
  const agents: string[] = [];
  const sd = join(dir, "skills");
  if (existsSync(sd))
    for (const d of readdirSync(sd))
      if (existsSync(join(sd, d, "SKILL.md"))) skills.push([`${prefix}${d}`, join(sd, d, "SKILL.md")]);
  const ad = join(dir, "agents");
  if (existsSync(ad))
    for (const f of readdirSync(ad)) if (f.endsWith(".md")) agents.push(`${prefix}${f.slice(0, -3)}`);
  return { skills, agents };
}

/** Installed plugins: folders under ~/.claude/plugins with a .claude-plugin/plugin.json, a few levels down. */
function pluginRoots(base: string, depth = 5): string[] {
  if (!existsSync(base) || depth < 0) return [];
  if (existsSync(join(base, ".claude-plugin", "plugin.json"))) return [base];
  const out: string[] = [];
  for (const d of readdirSync(base)) {
    const p = join(base, d);
    if (d.startsWith(".") || !statSync(p).isDirectory()) continue;
    out.push(...pluginRoots(p, depth - 1));
  }
  return out;
}

/**
 * Installed plugins only, not every plugin a marketplace offers: the install paths in
 * installed_plugins.json, else what's under cache/ and synced/ (marketplaces/ holds the catalogues).
 */
function installedPlugins(base: string): string[] {
  const listed = json(join(base, "installed_plugins.json")).plugins;
  if (listed && typeof listed === "object") {
    const paths = Object.values(listed)
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map((e: any) => e?.installPath)
      .filter((p): p is string => typeof p === "string" && existsSync(p));
    if (paths.length) return paths;
  }
  return [...pluginRoots(join(base, "cache")), ...pluginRoots(join(base, "synced"))];
}

export function inventory(root: string, home = claudeHome()): Defined {
  const where: Record<string, Scope> = {};
  const hookEvents: Record<string, string> = {};
  const skillChars: Record<string, number> = {};
  const skills = new Set<string>();
  const agents = new Set<string>();
  const add = (scope: Scope, found: ReturnType<typeof skillsAndAgents>) => {
    for (const [s, file] of found.skills) {
      skills.add(s);
      where[`skill:${s}`] ??= scope;
      // Bytes stand in for characters: skills are mostly plain text.
      skillChars[s] ??= statSync(file).size;
    }
    for (const a of found.agents) {
      agents.add(a);
      where[`agent:${a}`] ??= scope;
    }
  };
  const hooks = new Set<string>();
  const wire = (scope: Scope, pairs: [string, string][]) => {
    for (const [h, event] of pairs) {
      hooks.add(h);
      where[`hook:${h}`] ??= scope;
      hookEvents[h] ??= event;
    }
  };
  const project = join(root, ".claude");
  wire("project", hooksIn(json(join(project, "settings.json"))));
  wire("project", hooksIn(json(join(project, "settings.local.json"))));
  add("project", skillsAndAgents(project));
  wire("user", hooksIn(json(join(home, "settings.json"))));
  add("user", skillsAndAgents(home));
  // Uniquely named: the Skill tool names a plugin's skill "plugin:skill".
  const seenPlugins = new Set<string>();
  for (const p of installedPlugins(join(home, "plugins"))) {
    const name = String(json(join(p, ".claude-plugin", "plugin.json")).name ?? basename(p));
    if (seenPlugins.has(name)) continue;
    seenPlugins.add(name);
    add("plugin", skillsAndAgents(p, `${name}:`));
    wire("plugin", hooksIn(json(join(p, "hooks", "hooks.json"))));
  }
  const rules: Record<string, string> = {};
  for (const [k, v] of Object.entries(json(join(project, "process.json"))))
    if (!k.startsWith("_")) rules[k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)] =
      typeof v === "string" ? v : String((v as any)?.mode ?? "block");
  return {
    hooks: [...hooks],
    rules,
    skills: [...skills],
    agents: [...agents],
    skillChars,
    where,
    hookEvents,
  };
}
