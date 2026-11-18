#!/usr/bin/env bun
/**
 * Claude Code hosted headless: `claude -p` over stream-json, in the tmux pane
 * where the full-screen TUI would run. The TUI's render loop costs the
 * process three to four times the CPU of the headless CLI on the same turn
 * (and twice when idle), all of it spent drawing a screen nobody watches.
 *
 * Run as `bun claude-host.ts <claude argv as the TUI takes it>`, with the first
 * prompt on stdin when it is not a terminal (as Claude reads it), and the
 * control socket's path in `AGENTBOX_CLAUDE_HOST`.
 *
 * The pane shows what the fleet reads off a Claude screen and nothing more:
 * messages as `●` lines, an input box (a `❯` line between rules) that takes
 * bracketed paste, C-j for a newline and Enter to send, Escape to interrupt,
 * and in the box's place the menu of a question or a plan waiting on you,
 * with the footers `claudeBlockedOn` knows. Everything a screen cannot carry
 * goes over the socket, one JSON line each way:
 *
 *   {"op":"answer","answers":[{labels,other?}…]}  answer the open question
 *   {"op":"tui"}  hand the pane to the real TUI (`claude --resume`) as soon
 *                 as no turn runs: for a terminal attached, a rewind, a /btw
 *
 * The host lives as long as the CLI it runs: it exits with the CLI's code,
 * and a SIGTERM or SIGHUP to it is passed on.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { ReadStream } from "node:tty";

const HEADLESS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"];
const RULE = "─".repeat(40);
const LOG_KEEP = 400;

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error("usage: claude-host.ts claude [args…]");
  process.exit(2);
}
const sockPath = process.env.AGENTBOX_CLAUDE_HOST ?? null;
const out = process.stdout;
// A pane closed under it is no reason to die before the CLI it runs.
out.on("error", () => {});

// Claude reads a first prompt from stdin when stdin is not a terminal; the
// keyboard is then the controlling terminal.
let firstPrompt: string | null = null;
let ttyFd = 0;
if (!process.stdin.isTTY) {
  firstPrompt = readFileSync(0, "utf8").trim() || null;
  ttyFd = openSync("/dev/tty", "r+");
}

// ------------------------------------------------------------- state

interface Menu {
  requestId: string;
  kind: "question" | "plan";
  input: any;
  title: string;
  lines: string[];
  options: string[];
  at: number;
}

let child: ChildProcess | null = null;
let sessionId: string | null = sessionFromArgv(argv);
/** A turn runs: from a message sent, or a turn's init, to its result. A
 *  message sent mid-turn can join the running turn, so there is no counting
 *  results against messages. */
let busy = false;
let menu: Menu | null = null;
let wantTui = false;
let swapping = false;
let draft = "";
const log: string[] = [];

function sessionFromArgv(a: string[]): string | null {
  if (a.includes("--fork-session")) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--session-id" || a[i] === "--resume" || a[i] === "-r") return a[i + 1] ?? null;
    const m = /^--(?:session-id|resume)=(.+)$/.exec(a[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/** The TUI's argv for carrying on this conversation. */
function resumeArgv(a: string[], id: string): string[] {
  const outv: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x === "--fork-session") continue;
    if (x === "--session-id" || x === "--resume" || x === "-r") {
      i++;
      continue;
    }
    if (/^--(?:session-id|resume)=/.test(x)) continue;
    outv.push(x);
  }
  return [...outv, "--resume", id];
}

// ------------------------------------------------------------- screen

function say(line: string): void {
  log.push(...line.replace(/\r/g, "").split("\n"));
  if (log.length > LOG_KEEP) log.splice(0, log.length - LOG_KEEP);
}

function wrap(line: string, cols: number): string[] {
  if (line.length <= cols) return [line];
  const rows: string[] = [];
  for (let at = 0; at < line.length; at += cols) rows.push(line.slice(at, at + cols));
  return rows;
}

function foot(): string[] {
  if (menu) {
    const rows = [RULE, ...menu.lines, ""];
    menu.options.forEach((o, i) => rows.push(`${i === menu!.at ? "❯" : " "} ${i + 1}. ${o}`));
    rows.push("", menu.kind === "question" ? "Enter to select · ↑/↓ to navigate · Esc to cancel" : "Enter to select · Esc to cancel");
    return rows;
  }
  const lines = draft.split("\n");
  const shown = lines.length > 1 ? `${lines[0]} (+${lines.length - 1} lines)` : lines[0]!;
  const state = busy ? " · esc to interrupt" : "";
  return [RULE, `❯ ${shown}`, RULE, `  ⏵⏵ bypass permissions on (headless, agentbox)${state}`];
}

let paintQueued = false;
function paint(): void {
  if (swapping || paintQueued) return;
  paintQueued = true;
  queueMicrotask(() => {
    paintQueued = false;
    if (swapping) return;
    const cols = Math.max(20, out.columns || 120);
    const rows = Math.max(8, out.rows || 40);
    const bottom = foot().flatMap((l) => wrap(l, cols));
    const room = Math.max(0, rows - bottom.length);
    const body = log.flatMap((l) => wrap(l, cols)).slice(-room);
    while (body.length < room) body.unshift("");
    out.write(`\x1b[?2026h\x1b[H\x1b[2J${[...body, ...bottom].join("\r\n")}\x1b[?2026l`);
  });
}

// ------------------------------------------------------------- the CLI

function send(msg: unknown): void {
  child?.stdin?.write(`${JSON.stringify(msg)}\n`);
}

function userMessage(text: string): void {
  say(`› ${text}`);
  say("");
  busy = true;
  send({ type: "user", message: { role: "user", content: text } });
  paint();
}

function interrupt(): void {
  if (!busy) return;
  send({ type: "control_request", request_id: `int-${Date.now()}`, request: { subtype: "interrupt" } });
}

function respond(requestId: string, response: unknown): void {
  send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

const oneLine = (s: unknown, n = 160): string => {
  const t = (typeof s === "string" ? s : JSON.stringify(s ?? "")).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function toolLine(c: any): string {
  const i = c.input ?? {};
  const arg = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? i.prompt ?? "";
  return `● ${c.name}(${oneLine(arg, 120)})`;
}

function onMessage(m: any): void {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        busy = true;
        if (typeof m.session_id === "string") sessionId = m.session_id;
      }
      else if (m.subtype === "compact_boundary") say("✻ Conversation compacted");
      break;
    case "assistant":
      for (const c of m.message?.content ?? []) {
        if (c.type === "text" && c.text?.trim()) {
          say(`● ${c.text.trim()}`);
          say("");
        } else if (c.type === "tool_use") say(toolLine(c));
      }
      break;
    case "user":
      for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (c.type !== "tool_result") continue;
        const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join(" ") : c.content;
        say(`  ⎿  ${oneLine(text)}`);
      }
      break;
    case "result":
      busy = false;
      if (m.is_error) {
        const why = typeof m.result === "string" && m.result ? m.result : (m.errors ?? []).join("; ") || m.subtype;
        if (m.subtype !== "error_during_execution") say(`● ${why}`);
        else say("  ⎿  Interrupted");
        say("");
      }
      maybeSwap();
      break;
    case "control_request":
      onRequest(m);
      break;
  }
  paint();
}

/** Tools ask before they run only for what needs you: the rest is allowed,
 *  as the TUI allows it in bypass mode. */
function onRequest(m: any): void {
  const r = m.request ?? {};
  if (r.subtype !== "can_use_tool") return;
  const input = r.input ?? {};
  if (r.tool_name === "AskUserQuestion") {
    const qs: any[] = input.questions ?? [];
    const simple = qs.length === 1 && !qs[0].multiSelect;
    menu = {
      requestId: m.request_id,
      kind: "question",
      input,
      title: qs.map((q) => q.header).join(" · "),
      lines: simple
        ? [`☐ ${qs[0].header ?? ""}`, "", qs[0].question]
        : [...qs.flatMap((q) => [`☐ ${q.header ?? ""}`, q.question, ...q.options.map((o: any) => `    - ${o.label}`)]), "", "Answer these on the agentbox board."],
      options: simple ? qs[0].options.map((o: any) => o.label) : [],
      at: 0,
    };
  } else if (r.tool_name === "ExitPlanMode") {
    const plan = String(input.plan ?? "");
    menu = {
      requestId: m.request_id,
      kind: "plan",
      input,
      title: "Ready to code?",
      lines: ["Ready to code?", "", "Here is Claude's plan:", ...plan.split("\n").slice(0, 30), "", "Would you like to proceed?"],
      options: ["Yes", "No, keep planning"],
      at: 0,
    };
  } else {
    respond(m.request_id, { behavior: "allow", updatedInput: input });
  }
}

function choose(n: number): void {
  const mnu = menu;
  if (!mnu || n < 0 || n >= mnu.options.length) return;
  menu = null;
  if (mnu.kind === "question") {
    const q = mnu.input.questions[0];
    respond(mnu.requestId, { behavior: "allow", updatedInput: { ...mnu.input, answers: { [q.question]: mnu.options[n] } } });
  } else if (n === 0) respond(mnu.requestId, { behavior: "allow", updatedInput: mnu.input });
  else respond(mnu.requestId, { behavior: "deny", message: "The user wants to keep planning." });
  paint();
}

function cancelMenu(): void {
  const mnu = menu;
  if (!mnu) return;
  menu = null;
  respond(mnu.requestId, { behavior: "deny", message: mnu.kind === "question" ? "The user declined to answer." : "The user wants to keep planning." });
  paint();
}

function answer(answers: { labels?: string[]; other?: string }[]): string | null {
  const mnu = menu;
  if (!mnu || mnu.kind !== "question") return "no question is waiting for an answer";
  const qs: any[] = mnu.input.questions ?? [];
  if (answers.length !== qs.length) return `${qs.length} answers needed, got ${answers.length}`;
  const map: Record<string, string> = {};
  qs.forEach((q, i) => {
    map[q.question] = [...(answers[i]!.labels ?? []), ...(answers[i]!.other ? [answers[i]!.other!] : [])].join(", ");
  });
  menu = null;
  respond(mnu.requestId, { behavior: "allow", updatedInput: { ...mnu.input, answers: map } });
  paint();
  return null;
}

function start(): void {
  child = spawn(argv[0]!, [...argv.slice(1), ...HEADLESS], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        say(line);
        paint();
      }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    say(d.trimEnd());
    paint();
  });
  child.on("exit", (code, signal) => {
    if (swapping) return;
    finish(code ?? (signal ? 128 : 1));
  });
  if (firstPrompt) userMessage(firstPrompt);
}

// ------------------------------------------------------------- keyboard

const kb = new ReadStream(ttyFd);
kb.setRawMode(true);
kb.setEncoding("utf8");
out.write("\x1b[?2004h");

let pasting = false;
function onKeys(data: string): void {
  let s = data;
  while (s.length) {
    if (pasting) {
      const end = s.indexOf("\x1b[201~");
      draft += (end < 0 ? s : s.slice(0, end)).replace(/\r\n?/g, "\n");
      if (end < 0) break;
      pasting = false;
      s = s.slice(end + 6);
      continue;
    }
    if (s.startsWith("\x1b[200~")) {
      pasting = true;
      s = s.slice(6);
      continue;
    }
    if (s === "\x1b") {
      if (menu) cancelMenu();
      else interrupt();
      break;
    }
    const seq = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z]|.)/.exec(s);
    if (seq) {
      if (menu && (seq[0] === "\x1b[A" || seq[0] === "\x1bOA")) menu.at = Math.max(0, menu.at - 1);
      if (menu && (seq[0] === "\x1b[B" || seq[0] === "\x1bOB")) menu.at = Math.min(menu.options.length - 1, menu.at + 1);
      s = s.slice(seq[0].length);
      continue;
    }
    const ch = s[0]!;
    s = s.slice(1);
    if (menu) {
      if (ch === "\r") choose(menu.at);
      else if (/[1-9]/.test(ch)) choose(Number(ch) - 1);
      continue;
    }
    if (ch === "\r") {
      const text = draft.trim();
      draft = "";
      if (text) userMessage(text);
    } else if (ch === "\n") draft += "\n";
    else if (ch === "\x7f" || ch === "\b") draft = draft.slice(0, -1);
    else if (ch === "\x03") {
      if (draft) draft = "";
      else interrupt();
    } else if (ch === "\x15") draft = "";
    else if (ch >= " " || ch === "\t") draft += ch;
  }
  paint();
}
kb.on("data", onKeys);
out.on("resize", paint);

// ------------------------------------------------------------- socket

let server: Server | null = null;
function listen(): void {
  if (!sockPath) return;
  rmSync(sockPath, { force: true });
  server = createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req: any;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        c.end(`${JSON.stringify({ error: "not JSON" })}\n`);
        return;
      }
      if (req.op === "answer") {
        const error = answer(Array.isArray(req.answers) ? req.answers : []);
        c.end(`${JSON.stringify(error ? { error } : { ok: true })}\n`);
      } else if (req.op === "tui") {
        wantTui = true;
        c.end(`${JSON.stringify({ ok: true, now: !busy && !menu })}\n`);
        maybeSwap();
      } else c.end(`${JSON.stringify({ error: `no such op: ${req.op}` })}\n`);
    });
    c.on("error", () => {});
  });
  server.listen(sockPath);
}

// ------------------------------------------------------------- the TUI

/** Hand the pane to the TUI once no turn runs: close the CLI's input (it
 *  exits when it has nothing left to do), then run `claude --resume` on the
 *  terminal and exit with its code. */
function maybeSwap(): void {
  if (!wantTui || swapping || busy || menu || !sessionId) return;
  swapping = true;
  closeServer();
  kb.removeAllListeners("data");
  kb.setRawMode(false);
  kb.destroy();
  out.write("\x1b[?2004l\x1b[H\x1b[2J");
  const id = sessionId;
  const run = () => {
    const tty = openSync("/dev/tty", "r+");
    const tui = spawn(argv[0]!, resumeArgv(argv.slice(1), id), { stdio: [tty, "inherit", "inherit"] });
    tui.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
    current = tui;
  };
  if (!child || child.exitCode !== null) return run();
  child.once("exit", run);
  child.stdin?.end();
  setTimeout(() => child?.exitCode === null && child.kill("SIGTERM"), 10_000).unref();
}

let current: ChildProcess | null = null;

function closeServer(): void {
  server?.close();
  server = null;
  if (sockPath) rmSync(sockPath, { force: true });
}

function finish(code: number): void {
  closeServer();
  try {
    kb.setRawMode(false);
    out.write("\x1b[?2004l");
  } catch {
    // The terminal went with the pane.
  }
  if (ttyFd) closeSync(ttyFd);
  process.exit(code);
}

// However it ends, a socket left behind would name a host that is gone.
process.on("exit", () => {
  if (sockPath && server) rmSync(sockPath, { force: true });
});

for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
  process.on(sig, () => {
    closeServer();
    const p = current ?? child;
    if (p && p.exitCode === null) {
      p.once("exit", () => finish(143));
      p.kill(sig === "SIGINT" ? "SIGTERM" : sig);
      setTimeout(() => finish(143), 15_000).unref();
    } else finish(143);
  });
}

listen();
start();
paint();
