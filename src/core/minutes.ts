/** An account's tokens a minute against a service's per-minute caps (Morph's
 *  Ultra plan), over the last hour or week: `MinuteUsage`, the Accounts
 *  card's per-minute chart.
 *
 *  The service says only what is left of the current minute, so the history
 *  is worked out from the per-session token totals Fleet samples
 *  (`token_samples`): each rise between two samples of a session is spread
 *  over the minutes it covers. A working session is sampled about once a
 *  minute (`TOKEN_SAMPLE_MS` in fleet.ts), so a longer gap is one it sat
 *  idle through, and what it then spent came at its end: a rise is spread
 *  over at most `SPREAD_MS` before its sample. Uncached input and output are
 *  what the caps count; the totals do not say which model spent them, so
 *  every model's tokens are set against the one model's caps the account's
 *  reading named.
 */

import { rateLimitHitsSince, sessionsOnAccounts, tokenSampleAt, tokenSamplesAfter } from "./db";
import type { AccountUsage, MinuteUsage } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const SPREAD_MS = 2 * MIN;

export function minuteUsage(input: {
  accountId: string;
  /** The account's own id and its twins': where its sessions are kept. */
  accountIds: string[];
  span: "hour" | "week";
  perMinute: AccountUsage["perMinute"];
  now?: number;
}): MinuteUsage {
  // Whole minutes, the one under way left out: it is not over.
  const to = Math.floor((input.now ?? Date.now()) / MIN) * MIN;
  const step = input.span === "hour" ? MIN : HOUR;
  const n = input.span === "hour" ? 60 : 7 * 24 * 60;
  const from = to - n * MIN;
  const tokens = { input: new Float64Array(n), output: new Float64Array(n) };

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
        spread(tokens.input, cur.input - prev.input, a, cur.at);
        spread(tokens.output, cur.output - prev.output, a, cur.at);
      }
      prev = cur;
    }
  }

  const per = step / MIN;
  const buckets: MinuteUsage["buckets"] = [];
  for (let b = 0; b < n / per; b++) {
    const ins = tokens.input.subarray(b * per, (b + 1) * per);
    const outs = tokens.output.subarray(b * per, (b + 1) * per);
    const sum = (xs: Float64Array) => xs.reduce((x, y) => x + y, 0);
    buckets.push({
      input: Math.round(sum(ins) / per),
      output: Math.round(sum(outs) / per),
      inputPeak: Math.round(Math.max(...ins)),
      outputPeak: Math.round(Math.max(...outs)),
    });
  }

  const cap = (part: "input" | "output") => input.perMinute?.limits.find((l) => l.part === part)?.limit ?? null;
  const ci = cap("input");
  const co = cap("output");
  const limits = input.perMinute && ci !== null && co !== null ? { model: input.perMinute.model, input: ci, output: co } : null;
  const overOf = (xs: Float64Array, c: number | undefined) => (c === undefined ? 0 : xs.filter((v) => v > c).length);
  return {
    accountId: input.accountId,
    from,
    to,
    step,
    buckets,
    limits,
    over: { input: overOf(tokens.input, limits?.input), output: overOf(tokens.output, limits?.output) },
    minutes: n,
    hits: rateLimitHitsSince(from)
      .filter((h) => h.at < to && h.accountId !== null && input.accountIds.includes(h.accountId))
      .map((h) => h.at),
  };
}
