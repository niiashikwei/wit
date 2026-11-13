// SVG charts as strings: stacked bars, lines, sparklines, a histogram, the testing pyramid, a
// treemap and a score ring. Colours come from CSS variables (--s1…--s8 series, status tokens), so
// light and dark both work. Every mark carries data-tip for the page's hover tooltip.
import { esc, fmtNum } from "./format.js";

/** Series colour by slot, in a fixed order (never cycled past eight: fold the rest into "other"). */
export const seriesVar = (i) => `var(--s${Math.min(8, i + 1)})`;

/** Rounded "nice" maximum for an axis. */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5].find((m) => m * p >= v) ?? 10) * p;
}

/** A legend: colour swatch plus name for each series. */
export const legend = (items) =>
  `<div class="legend2">${items.map((it, i) => `<span><i style="background:${it.color ?? seriesVar(i)}"></i>${esc(it.label)}</span>`).join("")}</div>`;

/**
 * Bars per column, stacked by key. cols: [{label, values: {key: n}}]; keys in fixed order. Each
 * segment is separated by a 2px surface gap and has a tooltip.
 */
export function stackedBars(cols, keys, opts = {}) {
  const W = opts.width ?? 720;
  const H = opts.height ?? 200;
  const pad = { l: 44, r: 8, t: 10, b: 24 };
  const fmt = opts.fmt ?? fmtNum;
  const color = opts.color ?? ((k) => seriesVar(keys.indexOf(k)));
  const totals = cols.map((c) => keys.reduce((s, k) => s + (c.values[k] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bw = cols.length ? iw / cols.length : iw;
  const barW = Math.max(2, Math.min(28, bw * 0.7));
  const y = (v) => pad.t + ih - (v / max) * ih;
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label ?? "Bar chart")}">`;
  for (const f of [0, 0.5, 1]) out += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${pad.l - 6}" y="${y(max * f) + 4}" text-anchor="end">${esc(fmt(max * f))}</text>`;
  const every = Math.max(1, Math.ceil(cols.length / 10));
  cols.forEach((c, i) => {
    const x = pad.l + i * bw + (bw - barW) / 2;
    let acc = 0;
    for (const k of keys) {
      const v = c.values[k] ?? 0;
      if (!v) continue;
      const y1 = y(acc + v);
      const h = Math.max(1, y(acc) - y1);
      out += `<rect class="seg" x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color(k)}" data-tip="${esc(`${c.label} · ${opts.keyLabel ? opts.keyLabel(k) : k}: ${fmt(v)}`)}"/>`;
      acc += v;
    }
    if (i % every === 0) out += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(c.label)}</text>`;
  });
  return `${out}</svg>`;
}

/** One or more lines over time. series: [{label, points: [{at, v}]}], one y-axis. */
export function lineChart(series, opts = {}) {
  const W = opts.width ?? 720;
  const H = opts.height ?? 180;
  const pad = { l: 52, r: 10, t: 10, b: 22 };
  const fmt = opts.fmt ?? fmtNum;
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return `<p class="meta">${esc(opts.empty ?? "No samples yet.")}</p>`;
  const from = opts.from ?? Math.min(...pts.map((p) => p.at));
  const to = opts.to ?? Math.max(...pts.map((p) => p.at));
  const max = opts.max ?? niceMax(Math.max(...pts.map((p) => p.v)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (t) => pad.l + (to > from ? ((t - from) / (to - from)) * iw : iw / 2);
  const y = (v) => pad.t + ih - (Math.min(v, max) / max) * ih;
  const xl = opts.xLabel ?? ((t) => new Date(t).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label ?? "Line chart")}">`;
  for (const f of [0, 0.5, 1]) out += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${pad.l - 6}" y="${y(max * f) + 4}" text-anchor="end">${esc(fmt(max * f))}</text>`;
  out += `<text x="${pad.l}" y="${H - 5}">${esc(xl(from))}</text><text x="${W - pad.r}" y="${H - 5}" text-anchor="end">${esc(xl(to))}</text>`;
  series.forEach((s, i) => {
    const c = s.color ?? seriesVar(i);
    const sorted = [...s.points].sort((a, b) => a.at - b.at);
    if (sorted.length > 1) out += `<polyline fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" points="${sorted.map((p) => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>`;
    const step = Math.max(1, Math.floor(sorted.length / 60));
    sorted.forEach((p, j) => {
      if (j % step && j !== sorted.length - 1) return;
      out += `<circle cx="${x(p.at).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${sorted.length === 1 ? 4 : 2.5}" fill="${c}" stroke="var(--surface)" stroke-width="1.5"/><circle class="hit" cx="${x(p.at).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="9" data-tip="${esc(`${s.label} · ${xl(p.at)}: ${fmt(p.v)}`)}"/>`;
    });
  });
  return `${out}</svg>`;
}

/** A tiny trend line for a tile. */
export function sparkline(values, opts = {}) {
  const W = opts.width ?? 120;
  const H = opts.height ?? 28;
  const vs = values.filter((v) => v != null && Number.isFinite(v));
  if (vs.length < 2) return "";
  const max = Math.max(...vs);
  const min = Math.min(0, ...vs);
  const span = max - min || 1;
  const pts = vs.map((v, i) => `${((i / (vs.length - 1)) * (W - 4) + 2).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline fill="none" stroke="${opts.color ?? "var(--s1)"}" stroke-width="2" stroke-linejoin="round" points="${pts.join(" ")}"/></svg>`;
}

/** Vertical bars with a label under each: a histogram of buckets [{label, count}]. */
export function histogram(buckets, opts = {}) {
  const W = opts.width ?? 420;
  const H = opts.height ?? 150;
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.count)));
  const bw = (W - 20) / Math.max(1, buckets.length);
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label ?? "Histogram")}">`;
  buckets.forEach((b, i) => {
    const h = ((H - 40) * b.count) / max;
    const x = 10 + i * bw + bw * 0.15;
    out += `<rect class="seg" x="${x.toFixed(1)}" y="${(H - 24 - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(b.count ? 2 : 0, h).toFixed(1)}" rx="3" fill="${opts.color ?? "var(--s1)"}" data-tip="${esc(`${b.label}: ${b.count}`)}"/>`;
    out += `<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(b.label)}</text>`;
    if (b.count) out += `<text class="val" x="${(x + bw * 0.35).toFixed(1)}" y="${(H - 28 - h).toFixed(1)}" text-anchor="middle">${b.count}</text>`;
  });
  return `${out}</svg>`;
}

/**
 * The testing pyramid: one band per layer, end-to-end on top and unit at the base. Each band's
 * width is its share of the tests, so a healthy suite looks like a pyramid and an inverted one
 * like an ice-cream cone. Bands are coloured by coverage status and labelled in words.
 */
export function pyramid(layers, opts = {}) {
  const W = opts.width ?? 560;
  const bandH = 64;
  const gap = 6;
  const order = ["e2e", "integration", "unit"];
  const rows = order.map((k) => layers.find((l) => l.key === k) ?? { key: k, label: k, tests: 0 });
  const total = rows.reduce((s, r) => s + r.tests, 0);
  const H = rows.length * (bandH + gap) + 4;
  const names = { e2e: "End-to-end", integration: "Integration", unit: "Unit" };
  let out = `<svg class="pyr" viewBox="0 0 ${W} ${H}" role="img" aria-label="Testing pyramid by layer">`;
  rows.forEach((r, i) => {
    const share = total ? r.tests / total : 0;
    // Wide enough for its label (about 34 monospace characters), then wider by its share of tests.
    const minW = Math.min(W - 8, 270);
    const w = minW + share * (W - 8 - minW);
    const x = (W - w) / 2;
    const y = 2 + i * (bandH + gap);
    const status = r.status ?? "unknown";
    const cov = r.coverage == null ? "no coverage data" : `${Math.round(r.coverage * 100)}% covered`;
    out += `<g class="band b-${esc(status)}" tabindex="0" role="button" data-action="drill" data-path="${esc(r.key)}" data-tip="${esc(`${names[r.key]}: ${r.tests} tests (${Math.round(share * 100)}%), ${cov}`)}">`;
    out += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${bandH}" rx="6"/>`;
    out += `<text class="bl" x="${W / 2}" y="${y + 26}" text-anchor="middle">${esc(names[r.key])}</text>`;
    out += `<text class="bs" x="${W / 2}" y="${y + 46}" text-anchor="middle">${esc(`${fmtNum(r.tests)} tests · ${Math.round(share * 100)}% · ${cov}`)}</text></g>`;
  });
  return `${out}</svg>`;
}

/** Squarified treemap layout: rectangles for items [{value}] filling w×h. */
export function squarify(items, x, y, w, h) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const out = [];
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  const rest = items.filter((i) => i.value > 0).map((i) => ({ item: i, area: i.value * scale })).sort((a, b) => b.area - a.area);
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  while (rest.length) {
    const side = Math.min(rw, rh);
    const row = [rest.shift()];
    const worst = (r) => {
      const s = r.reduce((a, b) => a + b.area, 0);
      const mx = Math.max(...r.map((q) => q.area));
      const mn = Math.min(...r.map((q) => q.area));
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    };
    while (rest.length && worst([...row, rest[0]]) <= worst(row)) row.push(rest.shift());
    const s = row.reduce((a, b) => a + b.area, 0);
    if (rw >= rh) {
      const cw = s / rh;
      let cy = ry;
      for (const q of row) out.push({ item: q.item, x: rx, y: cy, w: cw, h: q.area / cw }), (cy += q.area / cw);
      rx += cw;
      rw -= cw;
    } else {
      const ch = s / rw;
      let cx = rx;
      for (const q of row) out.push({ item: q.item, x: cx, y: ry, w: q.area / ch, h: ch }), (cx += q.area / ch);
      ry += ch;
      rh -= ch;
    }
  }
  return out;
}

/** A treemap of items [{key, label, value, status, tip}]; each cell drills into its key. */
export function treemap(items, opts = {}) {
  const W = opts.width ?? 720;
  const H = opts.height ?? 300;
  const cells = squarify(items, 0, 0, W, H);
  let out = `<svg class="tree" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label ?? "Treemap")}">`;
  for (const c of cells) {
    const it = c.item;
    out += `<g class="cell b-${esc(it.status ?? "unknown")}" tabindex="0" role="button" data-action="drill" data-path="${esc(it.key)}" data-tip="${esc(it.tip ?? `${it.label}: ${it.value}`)}">`;
    out += `<rect x="${(c.x + 1).toFixed(1)}" y="${(c.y + 1).toFixed(1)}" width="${Math.max(0, c.w - 2).toFixed(1)}" height="${Math.max(0, c.h - 2).toFixed(1)}" rx="4"/>`;
    if (c.w > 70 && c.h > 34) {
      const max = Math.floor(c.w / 7.2);
      const label = it.label.length > max ? `…${it.label.slice(-(max - 1))}` : it.label;
      out += `<text class="bl" x="${(c.x + 8).toFixed(1)}" y="${(c.y + 19).toFixed(1)}">${esc(label)}</text><text class="bs" x="${(c.x + 8).toFixed(1)}" y="${(c.y + 34).toFixed(1)}">${esc(it.sub ?? String(it.value))}</text>`;
    }
    out += "</g>";
  }
  return `${out}</svg>`;
}

/** A score from 0 to 100 as a ring, with the number in the middle. */
export function ring(score, opts = {}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const v = score == null ? 0 : Math.max(0, Math.min(100, score));
  const status = score == null ? "unknown" : v >= 80 ? "good" : v >= 50 ? "warn" : "bad";
  return `<svg class="ring r-${status}" viewBox="0 0 100 100" role="img" aria-label="${esc(opts.label ?? "Score")} ${score == null ? "not measured" : `${Math.round(v)} of 100`}"><circle cx="50" cy="50" r="${r}" class="track"/><circle cx="50" cy="50" r="${r}" class="arc" stroke-dasharray="${((v / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/><text x="50" y="57" text-anchor="middle">${score == null ? "–" : Math.round(v)}</text></svg>`;
}

/** Horizontal bars as HTML rows: [{label, value, sub, color, action, path}]. */
export function hbars(rows, opts = {}) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  const fmt = opts.fmt ?? fmtNum;
  return `<ul class="hbars">${rows
    .map(
      (r, i) =>
        `<li${r.action ? ` data-action="${esc(r.action)}" data-path="${esc(r.path ?? r.label)}" tabindex="0" role="button"` : ""}><div class="hb-top"><span class="hb-l">${esc(r.label)}</span><span class="stamp">${esc(r.sub ?? fmt(r.value))}</span></div><div class="hb"><i style="width:${((100 * r.value) / max).toFixed(1)}%;background:${r.color ?? seriesVar(opts.colorIndex ?? i)}"></i></div></li>`,
    )
    .join("")}</ul>`;
}
