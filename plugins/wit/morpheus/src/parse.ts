/**
 * Turns Claude Code transcript lines and the optional hook logs into records: hook runs with their
 * durations, tool calls, skill loads, agent runs, prompt hints and each reply's tokens. Pure: no
 * files, no clock, so the tests can feed it lines.
 */

export type Kind = "hook" | "tool" | "skill" | "agent" | "hint";
export type Outcome = "ok" | "block" | "warn" | "error" | "cancelled" | "running";

/** One run of a hook, tool, skill or agent, or one skill hint. */
export interface Run {
  id: string;
  kind: Kind;
  /** The hook script (bash-guard), tool (Bash), skill (ship) or agent type (code-reviewer). */
  name: string;
  /** The hook event (PreToolUse:Bash) or the agent's description. */
  detail: string | null;
  session: string;
  branch: string | null;
  cwd: string | null;
  startedAt: number;
  durationMs: number | null;
  outcome: Outcome;
  /** The tool call a hook ran for, or the call that started an agent. */
  toolUseId: string | null;
  /** What it was working on: the command, the file, the skill's arguments, the hinted skills. */
  trigger: string | null;
  /** What it said: the hook's output, the agent's verdict. */
  output: string | null;
  /** The hook rule that decided (branch-guard), from the hooks' own timing. */
  rule?: string | null;
  /** Hook runs: "timing" when the hook timed itself (every run), else what the transcript kept. */
  source?: "transcript" | "timing";
  /** Hook runs and hints: the characters they added to the conversation. */
  chars?: number | null;
}

/**
 * One transcript line's share of a model reply. Claude Code writes a line per content block and
 * repeats the reply's whole usage on each, so the store counts the tokens once per `messageId` and
 * adds up the block counts.
 */
export interface Usage {
  messageId: string;
  session: string;
  branch: string | null;
  /** New input: uncached input and cache writes. */
  tokensIn: number;
  tokensOut: number;
  /** The cached context read again. */
  tokensCached: number;
  /** Of tokensIn, the part written to the cache (priced higher than plain input). */
  tokensWrite?: number;
  model: string | null;
  /** This line's tool calls that do the task, that coordinate, and its text blocks. */
  work: number;
  orchestration: number;
  text: number;
}

/** A tool call's result arrived: the call is over. */
export interface Result {
  toolUseId: string;
  at: number;
  isError: boolean;
  /** Set when the call started an agent. */
  agentId: string | null;
}

export interface Parsed {
  runs: Run[];
  results: Result[];
  /** A person's prompt: it ends the turn before it. */
  prompts: { session: string; at: number; text: string }[];
  /** A model reply's tokens and this line's blocks. */
  usage: Usage[];
  /** A subagent's last words, for its verdict. */
  lastText: string | null;
  /** When the line was written: an agent runs from its first line to its last. */
  at: number | null;
  /** Session events worth counting: a context compaction, a permission denial, an interrupt. */
  marks?: { session: string; at: number; type: "compact" | "denied" | "interrupt" }[];
}

const EXCERPT = 240;

/** Masks anything that looks like a secret, then cuts to an excerpt. Nothing longer is stored. */
export function redact(text: unknown, max = EXCERPT): string | null {
  if (text == null || text === "") return null;
  // Masked before the cut, so half a secret never survives at the edge.
  const masked = String(text)
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, "[jwt]")
    .replace(/\b(sk|pk|rk|sb|ghp|gho|github_pat|xox[abp])[_-][\w-]{12,}/gi, "[key]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[key]")
    .replace(/\bAIza[\w-]{30,}/g, "[key]")
    // Credentials in a URL: scheme://user:password@host.
    .replace(/:\/\/[^:/\s@]+:[^@\s]+@/g, "://[user]:[masked]@")
    // Authorization headers; after "token" only a long value, so "the token budget" stays.
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{6,}/gi, "$1 [masked]")
    .replace(/\b(token)\s+[\w.~+/=-]{20,}/gi, "$1 [masked]")
    // name="a quoted value", whole, spaces and all; then name=value, name: value, "name": value.
    .replace(
      /([\w-]*(?:key|token|secret|password|passwd|pwd|pass|auth|credential)s?)(["']?\s*[:=]\s*)(["'])(?:(?!\3).)*\3/gi,
      "$1$2$3[masked]$3",
    )
    .replace(
      /([\w-]*(?:key|token|secret|password|passwd|pwd|pass|auth|credential)s?)(["']?\s*[:=]\s*["']?)(?!\[masked\])[^\s"',}&]+/gi,
      "$1$2[masked]",
    )
    // Flags: --password x, --token=x, --value=x; curl -u user:password; mysql -ppassword.
    .replace(/--(password|passwd|token|secret|key|value)([= ])\S+/gi, "--$1$2[masked]")
    .replace(/(^|\s)-u\s+[^\s:]+:\S+/g, "$1-u [user]:[masked]")
    // Only mysql-style commands take a password glued to -p; find -path, ssh -p2222 and perl -pe stay readable.
    // Every one after the command, quoted values whole; the prefix is capped so a long log stays fast.
    .replace(
      /(?<=\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb(?:-dump|-admin)?)\b[^|;&\n]{0,200}?\s)-p(?:'[^']*'|"[^"]*"|\S+)/gi,
      "-p[masked]",
    )
    // sshpass takes it straight after the command; a later -p is ssh's port.
    .replace(/(\bsshpass\s+)-p(?:'[^']*'|"[^"]*"|\S+)/gi, "$1-p[masked]")
    .replace(/\s+/g, " ")
    .trim();
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/** `bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/after-edit.sh` → `after-edit`. */
export function hookScript(command: string | undefined, fallback: string): string {
  return command?.match(/([\w.-]+)\.(sh|ts|js|mjs|cjs|py|rb)\b/)?.[1] ?? fallback;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text : "")).join(" ")
      : "";

/** What a tool call was doing, in one line. */
export function describeInput(name: string, input: Record<string, unknown> = {}): string {
  const what =
    input.command ??
    input.file_path ??
    input.skill ??
    input.pattern ??
    input.url ??
    input.query ??
    "";
  const args = name === "Skill" && input.args ? ` ${String(input.args)}` : "";
  return `${String(what)}${args}`.trim() || name;
}

/** Tools that coordinate rather than do the task: agents, messages, plans, skills, waiting. */
const ORCHESTRATION = new Set([
  "Agent",
  "SendMessage",
  "ListAgents",
  "ReadNotifications",
  "ScheduleWakeup",
  "ToolSearch",
  "Skill",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "SubagentHandback",
  "Monitor",
  "PushNotification",
  "SendUserFile",
]);
/**
 * Tool families that coordinate: task lists and background tasks, schedules, the desktop app's
 * session tools, scheduled tasks, and Morpheus's own MCP tools.
 */
const ORCHESTRATION_PREFIX =
  /^(Task|Cron|mcp__ccd_|mcp__scheduled-tasks__|mcp__morpheus__|mcp__plugin_morpheus_)/;
/** A shell step that only looks or waits: a fetch, a status, CI, the clock. */
const LOOK =
  /^(git\s+(fetch|log|status|show|diff|rev-parse|ls-remote|worktree\s+list|branch\s+--show-current)|gh\s+(run|pr)\s+(list|view|watch|checks)|gh\s+api(?!.*\s(-X|--method|-f|-F|--field|--raw-field|--input))|date|sleep)(\s|$)/;
/** Steps that neither look nor work: moving into a folder, printing a note. */
const NEUTRAL = /^(cd\s+("[^"]*"|'[^']*'|\S+)|echo(\s.*)?|printf\s.*|true|:)$/;
/** What a look may be piped through: filters that only read (no `sort -o`, no `sed … w`). */
const FILTER =
  /^(head|tail|grep|egrep|jq|wc|uniq|cut|tr|column|sort(?!.*\s-o)|sed\s+-n(?!.*\bw\s))(\s|$)/;

/**
 * Splits a command on an operator pattern, but not inside quotes: `--jq '.a | .b'` stays one
 * piece. Quoted text comes back with its quotes, so later checks still see it.
 */
export function splitOutsideQuotes(command: string, op: RegExp): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const m = command.slice(i).match(op);
    if (m && m.index === 0) {
      out.push(cur);
      cur = "";
      i += m[0].length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Quoted text blanked out, so a `>` or `$(` inside quotes isn't read as a redirect or substitution. */
const unquoted = (s: string) => s.replace(/'[^']*'|"[^"]*"/g, "''");

/** One step of a command: a look or a note, piped only through filters, writing nowhere. */
function looksOnly(step: string): "look" | "neutral" | null {
  // Errors folded into the output, or thrown away, write nothing.
  const s = step.replace(/\s\d?>\s*&\d|\s\d?>\s*\/dev\/null/g, "");
  // A redirect, a command substitution or a background job may do anything.
  if (/[>`&]|\$\(/.test(unquoted(s))) return null;
  const [head, ...pipes] = splitOutsideQuotes(s, /^\|/);
  if (!pipes.every((x) => FILTER.test(x))) return null;
  return LOOK.test(head!) ? "look" : NEUTRAL.test(head!) ? "neutral" : null;
}

/**
 * Whether a tool call coordinates (agents, messages, plans, skill loads, waiting on CI) rather than
 * does the task. A Bash command counts when it looks or waits at least once and every other step
 * only moves into a folder or prints a note, with no redirect, substitution or background job.
 */
export function isOrchestration(name: string, input: Record<string, unknown> = {}): boolean {
  if (ORCHESTRATION.has(name) || ORCHESTRATION_PREFIX.test(name)) return true;
  if (name !== "Bash" || typeof input.command !== "string") return false;
  const steps = splitOutsideQuotes(input.command, /^(&&|\|\||;|\n)/)
    .map((s) => s.replace(/^timeout\s+\d+[smh]?\s+/, ""))
    .map(looksOnly);
  return steps.includes("look") && steps.every((s) => s !== null);
}

const empty = (): Parsed => ({
  runs: [],
  results: [],
  prompts: [],
  usage: [],
  lastText: null,
  at: null,
  marks: [],
});

/** A tool result that says the person turned the call down. */
const DENIED = /doesn't want to proceed|tool use was rejected|permission to use .* (was )?denied/i;

/**
 * Reads one transcript line. A subagent's file passes `agent`, so its calls and hooks count under
 * that agent, not the session that started it.
 */
export function parseTranscriptLine(line: string, opts: { agent?: string } = {}): Parsed {
  const out = empty();
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    return out;
  }
  if (!row || typeof row !== "object" || (row.isSidechain && !opts.agent)) return out;
  const at = Date.parse(row.timestamp ?? "");
  if (!Number.isFinite(at) || !row.sessionId) return out;
  out.at = at;
  const session = opts.agent ? `${row.sessionId}/agent-${opts.agent}` : String(row.sessionId);
  if (row.type === "system" && row.subtype === "compact_boundary") {
    out.marks!.push({ session, at, type: "compact" });
    return out;
  }
  const base = {
    session,
    branch: row.gitBranch || null,
    cwd: row.cwd || null,
    startedAt: at,
  };

  const a = row.type === "attachment" ? row.attachment : null;
  if (a && typeof a.type === "string" && a.type.startsWith("hook_")) {
    const event = String(a.hookName ?? a.hookEvent ?? "hook");
    // What a prompt hook added to the turn: often which skills apply. Metrics read the skill
    // names it mentions and check whether one was loaded before the next prompt.
    if (a.hookEvent === "UserPromptSubmit" && a.type === "hook_additional_context") {
      const said = textOf(a.content).trim();
      if (said)
        out.runs.push({
          ...base,
          id: `hint:${a.toolUseID ?? row.uuid}`,
          kind: "hint",
          name: "prompt-context",
          detail: event,
          durationMs: null,
          outcome: "ok",
          toolUseId: null,
          trigger: redact(said, 400),
          output: null,
          chars: said.length,
        });
      return out;
    }
    // Another record of the same run: hook_success carries its time and output.
    if (a.type === "hook_additional_context") return out;
    const said = a.blockingError?.blockingError ?? (a.stderr || a.stdout || null);
    // What it added to the conversation: the refusal, or everything it printed.
    const chars =
      typeof a.blockingError?.blockingError === "string"
        ? a.blockingError.blockingError.length
        : String(a.stdout ?? "").length + String(a.stderr ?? "").length;
    const command: string | undefined = a.command ?? said?.match(/^\[([^\]]+)\]/)?.[1];
    const name = hookScript(command, event);
    const outcome: Outcome =
      a.type === "hook_blocking_error"
        ? "block"
        : a.type === "hook_cancelled" || a.timedOut
          ? "cancelled"
          : a.type === "hook_non_blocking_error" || (a.exitCode ?? 0) !== 0
            ? "error"
            : "ok";
    out.runs.push({
      ...base,
      id: `hook:${a.toolUseID ?? row.uuid}:${event}:${name}`,
      kind: "hook",
      name,
      detail: event,
      durationMs: typeof a.durationMs === "number" ? a.durationMs : null,
      outcome,
      toolUseId: a.toolUseID ?? null,
      trigger: null,
      output: redact(typeof said === "string" ? said.replace(/^\[[^\]]+\]:\s*/, "") : null),
      chars,
    });
    return out;
  }

  const content = row.message?.content;
  if (row.type === "assistant" && Array.isArray(content)) {
    const blocks = { work: 0, orchestration: 0, text: 0 };
    for (const c of content) {
      if (c?.type === "text" && c.text) {
        out.lastText = c.text;
        blocks.text++;
      }
      if (c?.type !== "tool_use") continue;
      const input = c.input ?? {};
      blocks[isOrchestration(c.name, input) ? "orchestration" : "work"]++;
      // A background agent's report goes back through this tool, not a closing text block.
      if (c.name === "SubagentHandback" && typeof input.message === "string")
        out.lastText = input.message;
      const kind: Kind =
        c.name === "Skill" ? "skill" : c.name === "Agent" || c.name === "Task" ? "agent" : "tool";
      out.runs.push({
        ...base,
        id: `${kind}:${c.id}`,
        kind,
        name:
          kind === "skill"
            ? String(input.skill ?? "skill")
            : kind === "agent"
              ? String(input.subagent_type ?? "general-purpose")
              : String(c.name),
        detail: kind === "agent" ? redact(input.description, 120) : null,
        durationMs: null,
        outcome: "running",
        toolUseId: c.id,
        trigger: redact(kind === "agent" ? input.prompt : describeInput(c.name, input)),
        output: null,
      });
    }
    const u = row.message?.usage;
    if (u)
      out.usage.push({
        messageId: String(row.message?.id ?? row.uuid ?? at),
        session,
        branch: base.branch,
        // New input (cache writes included) apart from the cached context read again each turn.
        tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        tokensOut: u.output_tokens ?? 0,
        tokensCached: u.cache_read_input_tokens ?? 0,
        tokensWrite: u.cache_creation_input_tokens ?? 0,
        model: row.message?.model ?? null,
        ...blocks,
      });
    return out;
  }

  if (row.type === "user") {
    const results = Array.isArray(content) ? content.filter((c) => c?.type === "tool_result") : [];
    for (const c of results) {
      if (c.is_error && DENIED.test(textOf(c.content))) out.marks!.push({ session, at, type: "denied" });
      out.results.push({
        toolUseId: c.tool_use_id,
        at,
        isError: !!c.is_error,
        agentId: row.toolUseResult?.agentId ?? null,
      });
    }
    // The desktop app puts its own <system-reminder> notes before what the person typed.
    const text = textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    // A person's prompt: no tool result, no harness notice, not a skill's own text.
    if (!opts.agent && !results.length && !row.isMeta && text && !/^<[\w-]+/.test(text)) {
      out.prompts.push({ session, at, text: redact(text, 160)! });
      if (/^\[Request interrupted/.test(text)) out.marks!.push({ session, at, type: "interrupt" });
    }
  }
  return out;
}

/**
 * One line of a hook events log (`<git dir>/morpheus/events.jsonl`): a hook saying what one of
 * its rules decided, `{"ts", "hook": rule, "type": "block"|"warn"|"override"|…, "branch", "detail"}`.
 * Optional: hooks that write it get per-rule numbers; a skill gate writes
 * `"detail": "skill <name>: …"` or `"agent <name>: …"` when work came up without it.
 */
export interface HookEvent {
  ts: number;
  hook: string;
  type: string;
  branch: string | null;
  detail: string | null;
}

export function parseEventLine(line: string): HookEvent | null {
  try {
    const e = JSON.parse(line);
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || !e.hook || !e.type) return null;
    return {
      ts,
      hook: String(e.hook),
      type: String(e.type),
      branch: e.branch || null,
      detail: redact(e.detail),
    };
  } catch {
    return null;
  }
}

/**
 * The verdict an agent ends on ("VERDICT: approve", "VERDICT: pass"), when it gives one: a single
 * word alone on its line, so a quoted template ("VERDICT: approve | changes-required") isn't one.
 * The last one counts.
 */
export function verdictOf(text: string | null): string | null {
  const all = [...(text ?? "").matchAll(/VERDICT:\s*\**\s*([a-z][\w-]*)\s*\**\s*$/gim)];
  return all.at(-1)?.[1]?.toLowerCase() ?? null;
}

/**
 * One line of a hook timing log (`<git dir>/morpheus/runs.jsonl`, written by
 * hooks/morpheus-time.sh): `{"ts", "script", "ms", "exit", "event", "tool", "tool_use_id",
 * "session", "rule"?}`. Transcripts only keep hooks that printed something; this log has every
 * run. Its id matches the transcript's record of the same run, so the two merge.
 */
export function parseHookRunLine(line: string): Run | null {
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  const at = Date.parse(r?.ts ?? "");
  if (!Number.isFinite(at) || !r.script || typeof r.ms !== "number") return null;
  const event = r.event ? (r.tool ? `${r.event}:${r.tool}` : String(r.event)) : "hook";
  const exit = Number(r.exit ?? 0);
  return {
    id: r.tool_use_id
      ? `hook:${r.tool_use_id}:${event}:${r.script}`
      : `hook:${r.session ?? "-"}:${event}:${r.script}:${at}`,
    kind: "hook",
    name: String(r.script),
    detail: event,
    session: String(r.session ?? ""),
    branch: null,
    cwd: null,
    startedAt: at - r.ms,
    durationMs: r.ms,
    outcome: exit === 0 ? "ok" : exit === 2 ? "block" : "error",
    toolUseId: r.tool_use_id ?? null,
    trigger: null,
    output: null,
    rule: r.rule || null,
    source: "timing",
  };
}
