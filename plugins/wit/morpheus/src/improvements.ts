/**
 * The next improvements to a project's Claude Code setup, ranked by return on the effort. Each rule
 * reads the measured numbers and proposes a change with its evidence:
 *   ROI = (minutes saved a week + 30 × risk) / hours of work
 * where risk (0–3) is how much a problem lets slip through. Rules know nothing about any one
 * project: they look at hooks, rules, skills, agents, tools and tokens as Claude Code defines them.
 */

/** How many the dashboard shows. */
export const SHOWN = 10;

export interface Improvement {
  id: string;
  title: string;
  evidence: string;
  how: string;
  area: "hook" | "skill" | "agent" | "tool" | "tokens" | "setup";
  minutesPerWeek: number;
  risk: number;
  effortHours: number;
  roi: number;
  /** The table row it's about, for the drill-down. */
  link: { kind: "hook" | "rule" | "skill" | "agent"; name: string } | null;
}

interface Stat {
  name: string;
  runs: number;
  p50: number | null;
  p95: number | null;
  totalMs: number;
  outcomes: Record<string, number>;
  lastAt: number | null;
}
type Split = { work: number; orchestration: number; replies: number; cached: number };

export interface Inputs {
  /** How many weeks the numbers cover, so counts become weekly rates. */
  weeks: number;
  now: number;
  hooks: (Stat & { event?: string | null })[];
  rules: (Stat & { workedAround: number })[];
  skills: (Stat & { hintedNotLoaded: number })[];
  agents: (Stat & { tokens: number; verdicts?: Record<string, number> })[];
  tools: Stat[];
  kpis: { hints: number; hintsConverted: number; overrides: number };
  /** What the project defines, and where (project, user, plugin). */
  defined: {
    hooks: string[];
    skills: string[];
    agents: string[];
    where?: Record<string, string>;
    skillChars?: Record<string, number>;
    hookEvents?: Record<string, string>;
  };
  /** Skills and agents whose work came up without them (metrics.ts, coverage). */
  coverage?: { kind: string; name: string; missed: number; used: number; status?: string }[];
  /** Where the tokens went (metrics.ts, tokens). */
  tokens?: {
    agents: { type: string; runs: number; own: Split }[];
    hooks: { name: string; runs: number; tokens: number }[];
    skills: { name: string; loads: number; tokens: number }[];
    shares: { work: number; orchestration: number; replies: number };
  };
  /** When the last session was active, to tell a silent hook from a quiet day. */
  lastActivity: number | null;
  /** When any hook began timing every run; before it, quiet hooks may just not have printed. */
  timingSince: number | null;
}

/** Time budget for a hook by the event it runs on: it holds up every call it guards. */
export const HOOK_BUDGET_MS: Record<string, number> = {
  PreToolUse: 1000,
  PermissionRequest: 1000,
  UserPromptSubmit: 2000,
  PostToolUse: 10_000,
  SubagentStop: 30_000,
  Stop: 60_000,
  SessionStart: 15_000,
  PreCompact: 15_000,
};

const make = (i: Omit<Improvement, "roi">): Improvement => ({
  ...i,
  minutesPerWeek: Math.round(i.minutesPerWeek),
  roi: Math.round(((i.minutesPerWeek + 30 * i.risk) / Math.max(0.25, i.effortHours)) * 10) / 10,
});

const secs = (ms: number | null) =>
  ms == null ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const fresh = (s: Split) => s.work + s.orchestration + s.replies;

/** Every improvement the numbers point to, best first. */
export function rank(x: Inputs): Improvement[] {
  const out: Improvement[] = [];
  const perWeek = (n: number) => n / Math.max(1 / 7, x.weeks);
  const inProject = (kind: string, name: string) =>
    (x.defined.where?.[`${kind}:${name}`] ?? "project") === "project";

  for (const h of x.hooks) {
    const event = h.event ?? x.defined.hookEvents?.[h.name] ?? null;
    const budget = event ? HOOK_BUDGET_MS[event] : undefined;
    if (budget && h.p95 != null && h.p95 > budget && h.runs >= 5)
      out.push(
        make({
          id: `slow-hook-${h.name}`,
          title: `Make ${h.name} faster`,
          evidence: `p95 ${secs(h.p95)} against a ${secs(budget)} budget for ${event} over ${h.runs} runs (p50 ${secs(h.p50)}).`,
          how: "Profile its slowest branch (subprocesses like jq, git and node add up); exit early when the tool call can't be affected; narrow its matcher.",
          area: "hook",
          minutesPerWeek: (perWeek(h.runs) * Math.max(0, (h.p50 ?? 0) - budget / 2)) / 60_000,
          risk: 0,
          effortHours: 2,
          link: { kind: "hook", name: h.name },
        }),
      );
    const failed = (h.outcomes.cancelled ?? 0) + (h.outcomes.error ?? 0);
    if (failed >= 2)
      out.push(
        make({
          id: `failing-hook-${h.name}`,
          title: `Stop ${h.name} timing out or erroring`,
          evidence: `${failed} of ${h.runs} runs timed out or failed: those calls went unchecked.`,
          how: "Read the failed runs in the drill-down; raise the hook's timeout or move the slow part out of it.",
          area: "hook",
          minutesPerWeek: perWeek(failed) * 2,
          risk: 2,
          effortHours: 1,
          link: { kind: "hook", name: h.name },
        }),
      );
  }

  for (const r of x.rules) {
    const blocks = r.outcomes.block ?? 0;
    if (blocks >= 3 && r.workedAround / blocks >= 0.5)
      out.push(
        make({
          id: `noisy-rule-${r.name}`,
          title: `Tune ${r.name}: most of its blocks get worked around`,
          evidence: `${r.workedAround} of ${blocks} blocks were followed within 3 minutes by a passing command.`,
          how: "Read the blocked commands in the drill-down; narrow the pattern, or tell Claude the allowed way in the block message.",
          area: "hook",
          minutesPerWeek: perWeek(blocks) * 3,
          risk: 1,
          effortHours: 1.5,
          link: { kind: "rule", name: r.name },
        }),
      );
    const overrides = r.outcomes.override ?? 0;
    if (overrides >= 2)
      out.push(
        make({
          id: `overridden-${r.name}`,
          title: `Look into the ${overrides} overrides of ${r.name}`,
          evidence: `${overrides} overrides in range.`,
          how: "If the overrides were right, write the case into the rule; if not, make the override harder to reach.",
          area: "hook",
          minutesPerWeek: perWeek(overrides) * 2,
          risk: 2,
          effortHours: 1,
          link: { kind: "rule", name: r.name },
        }),
      );
  }

  if (x.kpis.hints >= 5 && x.kpis.hintsConverted / x.kpis.hints < 0.3) {
    const top = [...x.skills].sort((a, b) => b.hintedNotLoaded - a.hintedNotLoaded)[0];
    out.push(
      make({
        id: "ignored-hints",
        title: `Skill hints are mostly ignored${top?.hintedNotLoaded ? `, ${top.name} most of all` : ""}`,
        evidence: `${x.kpis.hintsConverted} of ${x.kpis.hints} prompt hints naming a skill led to it being loaded before the next prompt.`,
        how: "Name one skill per hint, not a list; sharpen the skill's description so Claude picks it; or have the hook add the skill's checklist itself.",
        area: "skill",
        minutesPerWeek: perWeek(x.kpis.hints - x.kpis.hintsConverted) * 2,
        risk: 2,
        effortHours: 2,
        link: top ? { kind: "skill", name: top.name } : null,
      }),
    );
  }

  for (const a of x.agents) {
    const perRun = a.runs ? a.tokens / a.runs : 0;
    if (a.runs >= 3 && perRun > 150_000)
      out.push(
        make({
          id: `costly-agent-${a.name}`,
          title: `Cut ${a.name}'s token use`,
          evidence: `${k(perRun)} new tokens a run over ${a.runs} runs (p50 ${secs(a.p50)}).`,
          how: "Brief it with the files or diff that matter and the shape of the answer; trim its tools; don't use it to wait on long commands.",
          area: "agent",
          minutesPerWeek: perWeek(a.runs) * 3,
          risk: 0,
          effortHours: 1,
          link: { kind: "agent", name: a.name },
        }),
      );
  }

  // Review agents that never give a verdict can't be counted: one item for all of them.
  const silent = x.agents.filter(
    (a) => /review/i.test(a.name) && a.runs >= 3 && !Object.keys(a.verdicts ?? {}).length,
  );
  if (silent.length)
    out.push(
      make({
        id: "review-verdicts",
        title:
          silent.length === 1
            ? `Have ${silent[0]!.name} end on a verdict line`
            : `Have ${silent.length} review agents end on a verdict line`,
        evidence: `No "VERDICT: …" line in ${silent.map((a) => `${a.name} (${a.runs} runs)`).join(", ")}, so approvals and change requests can't be counted.`,
        how: "End each one's instructions with: finish with one line, VERDICT: approve or VERDICT: changes-required.",
        area: "agent",
        minutesPerWeek: 0,
        risk: 1,
        effortHours: 0.25 * silent.length,
        link: { kind: "agent", name: silent[0]!.name },
      }),
    );

  // Agents whose own tokens mostly coordinate (waiting, messaging, loading) rather than work.
  for (const a of x.tokens?.agents ?? []) {
    const total = fresh(a.own);
    if (a.runs >= 3 && total > 200_000 && a.own.orchestration / total > 0.4)
      out.push(
        make({
          id: `orchestrating-agent-${a.type}`,
          title: `${a.type} spends most of its tokens coordinating`,
          evidence: `${Math.round((100 * a.own.orchestration) / total)}% of its ${k(total)} new tokens went to orchestration (polling, messages, task lists) over ${a.runs} runs.`,
          how: "Replace polling loops with one blocking wait (a background command notifies when done); give it fewer, larger steps.",
          area: "tokens",
          minutesPerWeek: perWeek(a.runs) * 2,
          risk: 0,
          effortHours: 1,
          link: { kind: "agent", name: a.type },
        }),
      );
  }

  // Hooks that pour text into every turn.
  for (const h of x.tokens?.hooks ?? [])
    if (h.runs >= 10 && perWeek(h.tokens) > 50_000)
      out.push(
        make({
          id: `chatty-hook-${h.name}`,
          title: `Make ${h.name} say less`,
          evidence: `About ${k(perWeek(h.tokens))} tokens a week of output added to the conversation over ${h.runs} runs (estimate).`,
          how: "Print only when something needs Claude's attention; keep routine success silent (exit 0, no output).",
          area: "tokens",
          minutesPerWeek: 2,
          risk: 0,
          effortHours: 0.5,
          link: { kind: "hook", name: h.name },
        }),
      );

  // Big skills loaded often.
  for (const s of x.tokens?.skills ?? [])
    if (s.loads >= 5 && s.tokens / s.loads > 6000)
      out.push(
        make({
          id: `heavy-skill-${s.name}`,
          title: `Trim ${s.name}: about ${k(s.tokens / s.loads)} tokens a load`,
          evidence: `${s.loads} loads, about ${k(s.tokens)} tokens of context in range (estimate).`,
          how: "Move reference material into files the skill points to, so it's read only when needed; keep the steps.",
          area: "tokens",
          minutesPerWeek: 2,
          risk: 0,
          effortHours: 1,
          link: { kind: "skill", name: s.name },
        }),
      );

  for (const t of x.tools) {
    const failed = (t.outcomes.error ?? 0) + (t.outcomes.block ?? 0);
    if (t.runs >= 20 && failed / t.runs >= 0.25)
      out.push(
        make({
          id: `failing-tool-${t.name}`,
          title: `${t.name} fails ${Math.round((100 * failed) / t.runs)}% of the time`,
          evidence: `${failed} of ${t.runs} calls came back as an error or were refused.`,
          how: "Look at the failing calls; a missing permission, a hook block or a wrong default path usually explains most of them.",
          area: "tool",
          minutesPerWeek: perWeek(failed) * 0.5,
          risk: 1,
          effortHours: 1,
          link: null,
        }),
      );
  }

  const usedSkills = new Set(x.skills.filter((s) => s.runs > 0).map((s) => s.name));
  const unusedSkills = x.defined.skills.filter(
    (s) => inProject("skill", s) && !usedSkills.has(s),
  );
  if (x.weeks >= 1 && unusedSkills.length)
    out.push(
      make({
        id: "unused-skills",
        title: `${unusedSkills.length} project skills were never loaded`,
        evidence: `Never loaded in range: ${unusedSkills.slice(0, 6).join(", ")}${unusedSkills.length > 6 ? "…" : ""}. Every skill's description costs context on every turn.`,
        how: "Sharpen each description to say when to use it, merge it into a skill that is used, or delete it.",
        area: "skill",
        minutesPerWeek: 5,
        risk: 1,
        effortHours: 1.5,
        link: { kind: "skill", name: unusedSkills[0]! },
      }),
    );
  const usedAgents = new Set(x.agents.map((a) => a.name));
  const unusedAgents = x.defined.agents.filter(
    (a) => inProject("agent", a) && !usedAgents.has(a),
  );
  if (x.weeks >= 1 && unusedAgents.length)
    out.push(
      make({
        id: "unused-agents",
        title: `${unusedAgents.length} project agents never ran`,
        evidence: `Never run in range: ${unusedAgents.slice(0, 6).join(", ")}.`,
        how: "Have the skill or instruction that should dispatch each one name it as a step, or retire it.",
        area: "agent",
        minutesPerWeek: 0,
        risk: 1,
        effortHours: 1,
        link: { kind: "agent", name: unusedAgents[0]! },
      }),
    );

  // A wired hook that stopped running while sessions were active: likely broken or not loaded.
  if (x.timingSince && x.lastActivity && x.now - x.lastActivity < 86_400_000)
    for (const h of x.defined.hooks) {
      const stat = x.hooks.find((s) => s.name === h);
      if (!stat || !stat.lastAt) continue;
      if (x.lastActivity - stat.lastAt > 86_400_000)
        out.push(
          make({
            id: `silent-${h}`,
            title: `${h} hasn't run in a day while sessions were active`,
            evidence: `Last run ${new Date(stat.lastAt).toISOString().slice(0, 16).replace("T", " ")} UTC; sessions active since.`,
            how: "Check the settings file it's wired in, its matcher, and that sessions started after the last settings change (hooks load at session start).",
            area: "hook",
            minutesPerWeek: 0,
            risk: 3,
            effortHours: 0.5,
            link: { kind: "hook", name: h },
          }),
        );
    }

  // Work that happened without the skill or agent made for it (a gate's warnings and blocks).
  for (const c of x.coverage ?? [])
    if (c.missed >= 2 && (c.status ?? "missed") === "missed")
      out.push(
        make({
          id: `missed-${c.kind}-${c.name}`,
          title:
            c.kind === "skill"
              ? `Load ${c.name} when its work starts`
              : `Dispatch ${c.name} when its work comes up`,
          evidence: `Its work came up ${c.missed} times without it, against ${c.used} ${c.kind === "skill" ? "loads" : "runs"}.`,
          how:
            c.kind === "skill"
              ? "Read the gate's warnings in the drill-down; if they're right, sharpen the skill's description or block until it's loaded; if not, narrow the gate."
              : "Name the agent as a step in the skill or instructions that lead to it.",
          area: c.kind === "skill" ? "skill" : "agent",
          minutesPerWeek: perWeek(c.missed) * 2,
          risk: 2,
          effortHours: 0.5,
          link: { kind: c.kind as "skill" | "agent", name: c.name },
        }),
      );

  // Without hook timing, hooks that print nothing are invisible.
  if (!x.timingSince && x.defined.hooks.length)
    out.push(
      make({
        id: "setup-timing",
        title: "Time every hook run",
        evidence: `${x.defined.hooks.length} hooks are wired, but transcripts only keep runs that printed something, so quiet runs and their time are missing.`,
        how: "Run `npx github:niiashikwei/wit init` in the project (or `morpheus init`): it routes each hook through hooks/morpheus-time.sh, which logs every run's time and exit code.",
        area: "setup",
        minutesPerWeek: 0,
        risk: 1,
        effortHours: 0.25,
        link: null,
      }),
    );

  return out.sort((a, b) => b.roi - a.roi);
}
