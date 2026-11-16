/** A wait in words: what the CLI prints of one and what the server tells a
 *  session. On its own, with nothing of the fleet behind it: the CLI loads it
 *  on every call. */

import type { WaitSpec } from "./types";

export const short = (sha: string): string => sha.slice(0, 10);

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.round(m / 1440)}d`;
}

/** `PR #8883: Build, Typecheck on 0ab9de7654`: what a wait is for, in a line. */
export function describe(spec: WaitSpec): string {
  switch (spec.kind) {
    case "pr": {
      if (spec.feedback) return `PR #${spec.number}: new review feedback or failed checks on ${short(spec.head!)}`;
      if (spec.merged) return `PR #${spec.number} merging${spec.head ? ` from ${short(spec.head)}` : ""}`;
      const what = oneLine([...(spec.all ? ["every check"] : []), ...spec.checks].join(", "), 120);
      return `PR #${spec.number}: ${what}${spec.head ? ` on ${short(spec.head)}` : ""}`;
    }
    case "run":
      return `run ${spec.run} of ${spec.repo}`;
    case "job":
      return `job ${oneLine(spec.command, 60)}`;
    case "session":
      return `session ${spec.ids.join(", ")}`;
    case "until":
      return `until ${oneLine(spec.cmd, 60)}`;
    case "time":
      return "a time";
  }
}
