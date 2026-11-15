/** An account's tokens a minute against a service's per-minute caps (Morph),
 *  over the last hour or week: `MinuteUsage`, the Accounts card's
 *  per-minute chart.
 *
 *  The service says only what is left of the current minute, so the history
 *  is worked out from the per-session token totals Fleet samples
 *  (`token_samples`): each rise between two samples of a session is spread
 *  over the minutes it covers. A working session is sampled about once a
 *  minute (`TOKEN_SAMPLE_MS` in fleet.ts), so a longer gap is one it sat
 *  idle through, and what it then spent came at its end: a rise is spread
 *  over at most `SPREAD_MS` before its sample. The totals do not say which
 *  model spent them, so every model's tokens are set against the one
 *  model's caps the account's reading named.
 */

import { rateLimitHitsSince, sessionsOnAccounts, tokenSampleAt, tokenSamplesAfter, type TokenSampleRow } from "./db";
import type { MinutePart, MinuteUsage } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const SPREAD_MS = 2 * MIN;

const PARTS: Record<MinutePart, (s: TokenSampleRow) => number> = {
  input: (s) => s.input,
  output: (s) => s.output,
  all: (s) => s.input + s.output + s.cacheRead + s.cacheWrite,
};

export function minuteUsage(input: {
  accountId: string;
  /** The account's own id and its twins': where its sessions are kept. */
  accountIds: string[];
  span: "hour" | "week";
  model: string | null;
  caps: Record<MinutePart, number | null>;
  now?: number;
}): MinuteUsage {
  // Whole minutes, the one under way left out: it is not over.
  const to = Math.floor((input.now ?? Date.now()) / MIN) * MIN;
  const step = input.span === "hour" ? MIN : HOUR;
  const n = input.span === "hour" ? 60 : 7 * 24 * 60;
  const from = to - n * MIN;
  const parts = Object.keys(PARTS) as MinutePart[];
  const tokens = Object.fromEntries(parts.map((p) => [p, new Float64Array(n)])) as Record<MinutePart, Float64Array>;

  const spread = (into: Float64Array, amount: number, a: number, b: number) => {
    if (amount <= 0 || b <= a) return;
    for (let t = Math.max(a, from); t < Math.min(b, to); ) {
      const i = Math.floor((t - from) / MIN);
      const end = Math.min(b, from + (i + 1) * MIN);
      into[i]! += (amount * (end - t)) / (b - a);
      t = end;
    }
  };
  for (const s of sessionsOnAccounts(input.accountIds, from - SPREAD_MS)) {
    let prev = tokenSampleAt(s.id, from - SPREAD_MS);
    for (const cur of tokenSamplesAfter(s.id, from - SPREAD_MS)) {
      if (prev) {
        const a = Math.max(prev.at, cur.at - SPREAD_MS);
        for (const p of parts) spread(tokens[p], PARTS[p](cur) - PARTS[p](prev), a, cur.at);
      }
      prev = cur;
    }
  }

  const per = step / MIN;
  const series = {} as MinuteUsage["series"];
  for (const p of parts) {
    const avg: number[] = [];
    const peak: number[] = [];
    for (let b = 0; b < n / per; b++) {
      const xs = tokens[p].subarray(b * per, (b + 1) * per);
      avg.push(Math.round(xs.reduce((x, y) => x + y, 0) / per));
      peak.push(Math.round(Math.max(...xs)));
    }
    const cap = input.caps[p];
    series[p] = { avg, peak, cap, over: cap === null ? 0 : tokens[p].filter((v) => v > cap).length };
  }
  return {
    accountId: input.accountId,
    from,
    to,
    step,
    minutes: n,
    model: input.model,
    series,
    hits: rateLimitHitsSince(from)
      .filter((h) => h.at < to && h.accountId !== null && input.accountIds.includes(h.accountId))
      .map((h) => h.at),
  };
}
