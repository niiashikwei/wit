// Formatting for the dashboard: numbers, times, sizes, money and safe HTML. Pure functions.

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function fmtMs(v) {
  if (v == null || !Number.isFinite(v)) return "–";
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
  if (v < 3_600_000) return `${Math.round(v / 60_000)} min`;
  if (v < 86_400_000) return `${(v / 3_600_000).toFixed(v < 36_000_000 ? 1 : 0)} h`;
  return `${(v / 86_400_000).toFixed(v < 864_000_000 ? 1 : 0)} d`;
}

export function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(a < 10 ? 2 : 1);
}

export const fmtPct = (v, digits = 0) => (v == null || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(digits)}%`);

export function fmtBytes(v) {
  if (v == null || !Number.isFinite(v)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < units.length - 1) ((n /= 1024), i++);
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtMoney(v) {
  if (v == null || !Number.isFinite(v)) return "–";
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

export function fmtAgo(t, now = Date.now()) {
  if (t == null) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const fmtDate = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const fmtDay = (key) => {
  const [, m, d] = String(key).split("-");
  return m && d ? `${+m}/${+d}` : String(key);
};

/** A metric value by its unit, as the health scorecard reports it. */
export function fmtUnit(value, unit) {
  if (value == null) return "–";
  if (typeof value === "string") return value;
  if (unit === "pct") return fmtPct(value, value < 0.1 && value > 0 ? 1 : 0);
  if (unit === "ms") return fmtMs(value);
  if (unit === "perWeek") return value >= 7 ? `${(value / 7).toFixed(1)}/day` : `${value.toFixed(1)}/wk`;
  if (unit === "ratio") return value.toFixed(2);
  return fmtNum(value);
}

export const STATUS_LABEL = { good: "Good", warn: "Needs a look", bad: "Bad", unknown: "No data" };
export const STATUS_ICON = { good: "✓", warn: "!", bad: "✕", unknown: "–" };
export const BAND_LABEL = { elite: "Elite", high: "High", medium: "Medium", low: "Low" };
export const bandStatus = (b) => (b == null ? "unknown" : b === "elite" || b === "high" ? "good" : b === "medium" ? "warn" : "bad");
export const covStatus = (v) => (v == null ? "unknown" : v >= 0.8 ? "good" : v >= 0.6 ? "warn" : "bad");

/** A status pill: icon plus words, so state is never colour alone. */
export const pill = (status, text) => `<span class="pill p-${esc(status)}"><span aria-hidden="true">${STATUS_ICON[status] ?? "–"}</span> ${esc(text ?? STATUS_LABEL[status] ?? status)}</span>`;
