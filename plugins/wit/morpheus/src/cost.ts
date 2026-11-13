/**
 * Estimated cost of model usage, from Anthropic's first-party list prices per million tokens.
 * An estimate: subscriptions, partner clouds and discounts change what is actually paid.
 */

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const p = (input: number, output: number, cacheRead = input * 0.1): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

/** Model id prefix → price; the first match wins, so more specific prefixes come first. */
export const PRICES: [string, Price][] = [
  ["claude-fable-5-2", p(8, 40, 0.2)],
  ["claude-mythos-5-2", p(8, 40, 0.2)],
  ["claude-fable-5", p(10, 50)],
  ["claude-mythos-5", p(10, 50)],
  ["claude-opus-5-5", p(4, 20, 0.2)],
  ["claude-opus-5", p(5, 25)],
  ["claude-opus-4-8", p(5, 25)],
  ["claude-opus-4-7", p(5, 25)],
  ["claude-opus-4-6", p(5, 25)],
  ["claude-opus-4-5", p(5, 25)],
  ["claude-opus-4", p(15, 75)],
  ["claude-3-opus", p(15, 75)],
  ["claude-sonnet-5-5", p(2, 10, 0.1)],
  ["claude-sonnet-5", p(2, 10)],
  ["claude-sonnet-4", p(3, 15)],
  ["claude-3-7-sonnet", p(3, 15)],
  ["claude-3-5-sonnet", p(3, 15)],
  ["claude-haiku-5-5", p(0.1, 0.5, 0.01)],
  ["claude-haiku-4-5", p(1, 5)],
  ["claude-3-5-haiku", p(0.8, 4)],
  ["claude-3-haiku", p(0.25, 1.25)],
];

/** A family's price when the exact model is unknown: opus, sonnet, haiku, fable. */
const FAMILY: [RegExp, Price][] = [
  [/fable|mythos/, p(8, 40, 0.2)],
  [/opus/, p(5, 25)],
  [/sonnet/, p(3, 15)],
  [/haiku/, p(1, 5)],
];

export function priceOf(model: string | null | undefined): Price | null {
  const m = String(model ?? "").toLowerCase().replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, "");
  if (!m || m === "<synthetic>") return null;
  for (const [prefix, price] of PRICES) if (m.startsWith(prefix)) return price;
  for (const [re, price] of FAMILY) if (re.test(m)) return price;
  return null;
}

/**
 * Dollars for one reply's tokens. `tokensIn` includes cache writes (`tokensWrite`), which are
 * priced at the write rate; cached reads at the read rate.
 */
export function costOf(model: string | null | undefined, t: { tokensIn: number; tokensOut: number; tokensCached: number; tokensWrite?: number }): number {
  const price = priceOf(model);
  if (!price) return 0;
  const write = Math.min(t.tokensWrite ?? 0, t.tokensIn);
  return ((t.tokensIn - write) * price.input + write * price.cacheWrite + t.tokensOut * price.output + t.tokensCached * price.cacheRead) / 1e6;
}
