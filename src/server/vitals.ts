/**
 * How the server says where its time went.
 *
 * It is one thread: whatever runs on it for a second is a second in which no
 * page, terminal or CLI is answered, and from outside that looks like every
 * part of agentbox being slow at once. So every log line carries the time, a
 * request or timer that held the thread is named (`held`), a stall nothing
 * named is counted (`watchLoop`), and `agentbox profile` samples the running
 * server and says which functions the time went to (`cpuProfile`).
 */

import { profile } from "bun:jsc";
import { relative } from "node:path";
import { packageRoot } from "../core/paths";

const pad = (n: number): string => String(n).padStart(2, "0");

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let stamped = false;

/** Every line the server logs starts with when, in this machine's time. */
export function stampLogs(): void {
  if (stamped) return;
  stamped = true;
  for (const level of ["log", "error", "warn"] as const) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]) => write(stamp(), ...args);
  }
}

/** A synchronous stretch this long is felt: a keystroke echoes late, a page waits. */
const HELD_MS = 250;

/**
 * Run `fn`, and say so when it held the thread: `what` is the request or the
 * timer. Only the stretch before `fn` first awaits is timed, which is all of a
 * handler that computes its answer and none of one that waits on something.
 */
export function held<T>(what: string, fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - started;
    if (ms >= HELD_MS) console.log(`agentbox: held ms=${Math.round(ms)} ${what}`);
  }
}

const BEAT_MS = 100;
const STALL_MS = 500;

/**
 * Count the stalls: a timer due every `BEAT_MS` that comes round `STALL_MS`
 * late was kept waiting by something on the thread. At most a line a minute,
 * with how many there were since the last one and the worst; a `held` line
 * beside it names the cause, and with none, `agentbox profile` finds it.
 */
export function watchLoop(): void {
  let due = performance.now() + BEAT_MS;
  let said = 0;
  let tally = { count: 0, worst: 0, total: 0 };
  setInterval(() => {
    const now = performance.now();
    const late = now - due;
    due = now + BEAT_MS;
    if (late < STALL_MS) return;
    tally.count++;
    tally.total += late;
    tally.worst = Math.max(tally.worst, late);
    if (now - said < 60_000) return;
    console.log(`agentbox: loop_stalled worst_ms=${Math.round(tally.worst)} stalls=${tally.count} total_ms=${Math.round(tally.total)}`);
    said = now;
    tally = { count: 0, worst: 0, total: 0 };
  }, BEAT_MS).unref?.();
}

export interface ProfileRow {
  samples: number;
  fn: string;
  /** Where: `file:line`, the line most sampled in it; for native code, its caller's. */
  at: string;
}

export interface CpuProfile {
  seconds: number;
  /** Samples that caught the thread at work. Fewer than a millisecond each on
   *  a busy machine, where the sampler itself waits for a core: read the rows
   *  as shares of this, not as time. */
  samples: number;
  /** By the function on top of the stack: where the thread was. */
  self: ProfileRow[];
  /** By every function on the stack: what the time was spent for. */
  total: ProfileRow[];
}

interface Frame {
  name: string;
  location: string;
  sourceURL?: string;
  line: number;
}

const SAMPLE_US = 1000;
const ROWS = 40;
const NO_LINE = 0xffffffff;
let profiling = false;

/** Sample the thread for `seconds` while the server goes on with its work. */
export async function cpuProfile(seconds: number): Promise<CpuProfile | null> {
  if (profiling) return null;
  profiling = true;
  try {
    const sampled = (await profile(() => Bun.sleep(seconds * 1000), SAMPLE_US)) as unknown as { stackTraces: { traces: { frames: Frame[] }[] } };
    const self = new Tally();
    const total = new Tally();
    let busy = 0;
    for (const { frames } of sampled.stackTraces.traces) {
      // The sleep above, with nothing else on the stack: the thread was idle.
      const top = frames.findIndex((f) => f.sourceURL);
      if (top < 0 || frames.every((f) => !f.sourceURL || f.sourceURL === import.meta.path)) continue;
      busy++;
      const js = frames[top]!;
      // Native code (a query, JSON, a regex) is named with the function that called it.
      if (top > 0) self.add(`${frames[0]!.name} ← ${js.name || "(anonymous)"}`, `native:${frames[0]!.name}:${keyOf(js)}`, js);
      else self.add(js.name, keyOf(js), js);
      const seen = new Set<string>();
      for (const f of frames) {
        if (!f.sourceURL || seen.has(keyOf(f))) continue;
        seen.add(keyOf(f));
        total.add(f.name, keyOf(f), f);
      }
    }
    return { seconds, samples: busy, self: self.rows(), total: total.rows() };
  } finally {
    profiling = false;
  }
}

/** A function is its code block, whichever line of it a sample caught. */
const keyOf = (f: Frame): string => `${f.sourceURL}${f.location.split(":")[0]}`;

class Tally {
  private by = new Map<string, { fn: string; file: string; samples: number; lines: Map<number, number> }>();

  add(fn: string, key: string, at: Frame): void {
    let row = this.by.get(key);
    if (!row) this.by.set(key, (row = { fn, file: at.sourceURL ?? "", samples: 0, lines: new Map() }));
    row.samples++;
    // Optimized code does not always know its line.
    if (at.line < NO_LINE) row.lines.set(at.line, (row.lines.get(at.line) ?? 0) + 1);
  }

  rows(): ProfileRow[] {
    return [...this.by.values()]
      .sort((a, b) => b.samples - a.samples)
      .slice(0, ROWS)
      .map((r) => {
        const line = [...r.lines].sort((a, b) => b[1] - a[1])[0]?.[0];
        const file = r.file.startsWith(packageRoot) ? relative(packageRoot, r.file) : r.file;
        return { samples: r.samples, fn: r.fn || "(anonymous)", at: line === undefined ? file : `${file}:${line}` };
      });
  }
}
