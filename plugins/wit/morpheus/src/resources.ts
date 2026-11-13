/**
 * Resource use: the CPU and memory of Claude Code and everything it started (MCP servers, hooks,
 * test and build commands), the machine's load, memory and free disk, the project's disk footprint,
 * and what test and build runs cost in time. Sampled while the dashboard is open, or whenever the
 * Resources view asks. Commands are read only to tell processes apart; only their names are kept.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stmt } from "./ingest.ts";
import { percentile, type Range, since } from "./metrics.ts";
import { redact } from "./parse.ts";
import { gitCommonDir, projectDirs } from "./paths.ts";
import { getMeta, setMeta } from "./store.ts";

export interface Proc {
  pid: number;
  ppid: number;
  cpu: number;
  rss: number;
  args: string;
}
export type ProcScope = "claude" | "mcp" | "hook" | "tools" | "wit";
export const SCOPES: ProcScope[] = ["claude", "mcp", "hook", "tools", "wit"];

/** `ps -A -o pid=,ppid=,pcpu=,rss=,args=` output (rss in KiB). */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (m) out.push({ pid: +m[1]!, ppid: +m[2]!, cpu: +m[3]!, rss: +m[4]! * 1024, args: m[5]! });
  }
  return out;
}

/** Claude Code itself: the `claude` CLI or its npm package. */
export const isClaude = (args: string) =>
  /(^|\/)claude(\s|$)/.test(args) || /@anthropic-ai\/claude-code\b|\/claude-code\/cli\.js\b/.test(args);

/** Sorts processes into Claude Code, its MCP servers, its hooks, its other commands, and Wit. */
export function classify(procs: Proc[], selfPid: number): Map<ProcScope, { cpu: number; rss: number; procs: number }> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const scopeOf = (p: Proc): ProcScope | null => {
    // Wit and anything it started.
    for (let q: Proc | undefined = p, n = 0; q && n < 64; q = byPid.get(q.ppid), n++) if (q.pid === selfPid) return "wit";
    if (isClaude(p.args)) return "claude";
    for (let q = byPid.get(p.ppid), n = 0; q && n < 64; q = byPid.get(q.ppid), n++)
      if (isClaude(q.args)) {
        if (/\bmcp\b|mcp-server|modelcontextprotocol|\bserve-mcp\b/i.test(p.args)) return "mcp";
        if (/\/hooks?\/|[-_]hook\.(sh|py|js|ts)\b|morpheus-time\.sh/.test(p.args)) return "hook";
        return "tools";
      }
    return null;
  };
  const out = new Map<ProcScope, { cpu: number; rss: number; procs: number }>(SCOPES.map((s) => [s, { cpu: 0, rss: 0, procs: 0 }]));
  for (const p of procs) {
    const s = scopeOf(p);
    if (!s) continue;
    const t = out.get(s)!;
    t.cpu += p.cpu;
    t.rss += p.rss;
    t.procs++;
  }
  return out;
}

export type PsRunner = () => string | null;
export const psRunner: PsRunner = () => {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  } catch {
    return null;
  }
};

/** The machine now: load as a share of its cores, memory in use, and the project disk's free space. */
export function machine(root: string) {
  const cores = Math.max(1, cpus().length);
  let disk = { total: 0, free: 0 };
  try {
    const s = statfsSync(root);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    /* unsupported filesystem */
  }
  return { cores, load: loadavg()[0]!, cpu: Math.min(100, (loadavg()[0]! / cores) * 100), memTotal: totalmem(), memUsed: totalmem() - freemem(), disk };
}

/** Takes one sample of every scope and the machine. Returns false when `ps` isn't available. */
export function sample(db: DatabaseSync, root: string, now: number, ps: PsRunner = psRunner): boolean {
  const text = ps();
  const m = machine(root);
  const put = stmt(db, "insert or replace into resource_samples (at, scope, cpu, rss, procs) values (?, ?, ?, ?, ?)");
  put.run(now, "machine", m.cpu, m.memUsed, m.cores);
  put.run(now, "disk-free", 0, m.disk.free, 0);
  setMeta(db, "machine", JSON.stringify({ cores: m.cores, memTotal: m.memTotal, diskTotal: m.disk.total }));
  if (text == null) return false;
  for (const [scope, t] of classify(parsePs(text), process.pid)) put.run(now, scope, Math.round(t.cpu * 10) / 10, t.rss, t.procs);
  compact(db, now);
  return true;
}

const HOUR = 3_600_000;
/** Keeps a week of full detail, then one averaged sample an hour, for 90 days. */
export function compact(db: DatabaseSync, now: number): void {
  const last = Number(getMeta(db, "resources:compacted") ?? 0);
  if (now - last < HOUR) return;
  setMeta(db, "resources:compacted", String(now));
  const cut = now - 7 * 24 * HOUR;
  db.prepare(`insert or replace into resource_samples (at, scope, cpu, rss, procs)
    select (at / ${HOUR}) * ${HOUR} as h, scope, avg(cpu), cast(avg(rss) as integer), cast(avg(procs) as integer)
      from resource_samples where at < ? and at % ${HOUR} != 0 group by h, scope`).run(cut);
  db.prepare(`delete from resource_samples where at < ? and at % ${HOUR} != 0`).run(cut);
  db.prepare("delete from resource_samples where at < ?").run(now - 90 * 24 * HOUR);
  db.prepare("delete from disk_samples where at < ?").run(now - 90 * 24 * HOUR);
}

export type DuRunner = (paths: string[]) => Map<string, number>;
export const duRunner: DuRunner = (paths) => {
  const out = new Map<string, number>();
  for (const p of paths) {
    try {
      const kb = Number(execFileSync("du", ["-sk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).split(/\s/)[0]);
      if (Number.isFinite(kb)) out.set(p, kb * 1024);
    } catch {
      /* unreadable or too slow: left out */
    }
  }
  return out;
};

/** The folders whose size is worth watching, by label. */
export function footprintPaths(root: string, dbFile: string | null): Record<string, string[]> {
  const exists = (ps: string[]) => ps.filter((p) => existsSync(p));
  const common = gitCommonDir(root);
  return {
    project: [root],
    git: exists(common ? [common] : [join(root, ".git")]),
    dependencies: exists(["node_modules", ".venv", "venv", "vendor", "Pods", ".gradle"].map((d) => join(root, d))),
    "build output": exists(["dist", "build", "target", "out", ".next", "coverage"].map((d) => join(root, d))),
    transcripts: projectDirs(root),
    "wit store": exists(dbFile ? [dbFile, `${dbFile}-wal`] : []),
  };
}

/** Measures the disk footprint, at most every ten minutes. Returns whether it measured. */
export function diskSample(db: DatabaseSync, root: string, now: number, dbFile: string | null, du: DuRunner = duRunner): boolean {
  if (now - Number(getMeta(db, "disk:at") ?? 0) < 10 * 60_000) return false;
  setMeta(db, "disk:at", String(now));
  const groups = footprintPaths(root, dbFile);
  const sizes = du([...new Set(Object.values(groups).flat())]);
  const put = stmt(db, "insert or replace into disk_samples (at, key, bytes) values (?, ?, ?)");
  for (const [key, paths] of Object.entries(groups)) put.run(now, key, paths.reduce((sum, p) => sum + (sizes.get(p) ?? 0), 0));
  return true;
}

export const TEST_CMD = /\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|pytest|python3? -m (pytest|unittest)|go test|cargo (test|nextest)|mvn (test|verify)|gradlew? test|jest|vitest|node --test|rspec|phpunit|dotnet test|mix test|make test|tox|playwright test|cypress run)\b/;
export const BUILD_CMD = /\b(npm run build|pnpm (run )?build|yarn build|bun run build|tsc\b|cargo build|go build|mvn (package|install|compile)|gradlew? (build|assemble)|make(?! test)\b|vite build|webpack|next build|dotnet build|docker build|swift build|xcodebuild)\b/;

/** Points for a chart: at most `max`, averaging the samples that share a bucket. */
export function bucket<T extends { at: number }>(rows: T[], from: number, to: number, max: number, val: (r: T) => number) {
  const size = Math.max(1, Math.ceil((to - from) / max));
  const by = new Map<number, number[]>();
  for (const r of rows) {
    const b = from + Math.floor((r.at - from) / size) * size;
    (by.get(b) ?? by.set(b, []).get(b)!).push(val(r));
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([at, vs]) => ({ at, v: vs.reduce((s, x) => s + x, 0) / vs.length }));
}

export function resources(db: DatabaseSync, range: Range, now: number) {
  const from = since(range === "all" ? "30d" : range, now);
  const rows = db.prepare("select at, scope, cpu, rss, procs from resource_samples where at >= ? order by at").all(from) as { at: number; scope: string; cpu: number; rss: number; procs: number }[];
  const meta = JSON.parse(getMeta(db, "machine") ?? "{}") as { cores?: number; memTotal?: number; diskTotal?: number };
  const latestAt = rows.at(-1)?.at ?? null;
  const now_ = (scope: string) => rows.filter((r) => r.at === latestAt && r.scope === scope)[0] ?? null;
  const series = (scope: string, val: (r: (typeof rows)[number]) => number) => bucket(rows.filter((r) => r.scope === scope), from, now, 240, val);
  const disk = db.prepare("select at, key, bytes from disk_samples where at >= ? order by at").all(from) as { at: number; key: string; bytes: number }[];
  const diskAt = disk.at(-1)?.at ?? null;
  const runs = db
    .prepare("select started_at as at, trigger, duration_ms, outcome from runs where kind = 'tool' and name = 'Bash' and started_at >= ? order by started_at")
    .all(from) as { at: number; trigger: string | null; duration_ms: number | null; outcome: string }[];
  const tools = rows.filter((r) => r.scope === "tools");
  const peakDuring = (at: number, ms: number | null) => {
    const inside = tools.filter((r) => r.at >= at && r.at <= at + (ms ?? 0) + 5000).map((r) => r.rss);
    return inside.length ? inside.reduce((m, v) => Math.max(m, v), 0) : null;
  };
  const cmdRuns = runs
    .map((r) => ({ ...r, kind: r.trigger && TEST_CMD.test(r.trigger) ? "test" : r.trigger && BUILD_CMD.test(r.trigger) ? "build" : null }))
    .filter((r) => r.kind)
    .map((r) => ({ at: r.at, kind: r.kind as "test" | "build", command: redact(r.trigger, 120), durationMs: r.duration_ms, outcome: r.outcome, peakRss: peakDuring(r.at, r.duration_ms) }));
  const kindSummary = (kind: "test" | "build") => {
    const ks = cmdRuns.filter((r) => r.kind === kind);
    const ds = ks.map((r) => r.durationMs).filter((v): v is number => v != null);
    return { runs: ks.length, failed: ks.filter((r) => r.outcome === "error").length, p50: percentile(ds, 50), p95: percentile(ds, 95), totalMs: ds.reduce((s, d) => s + d, 0) };
  };
  return {
    sampledAt: latestAt,
    machine: { ...meta, now: now_("machine"), diskFree: now_("disk-free")?.rss ?? null },
    now: Object.fromEntries(SCOPES.map((s) => [s, now_(s)])),
    cpu: Object.fromEntries([...SCOPES, "machine"].map((s) => [s, series(s, (r) => r.cpu)])),
    memory: Object.fromEntries([...SCOPES, "machine"].map((s) => [s, series(s, (r) => r.rss)])),
    peak: Object.fromEntries(SCOPES.map((s) => [s, rows.reduce((m, r) => (r.scope === s ? Math.max(m, r.rss) : m), 0)])),
    disk: {
      at: diskAt,
      latest: Object.fromEntries(disk.filter((d) => d.at === diskAt).map((d) => [d.key, d.bytes])),
      series: Object.fromEntries([...new Set(disk.map((d) => d.key))].map((k) => [k, disk.filter((d) => d.key === k).map((d) => ({ at: d.at, v: d.bytes }))])),
      freeSeries: series("disk-free", (r) => r.rss),
    },
    commands: { test: kindSummary("test"), build: kindSummary("build"), recent: cmdRuns.slice(-60).reverse() },
  };
}
