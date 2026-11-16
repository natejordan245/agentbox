/** dsmin's session transcript: one JSONL file per session, every line
 * `{type, at (ms), …}`. `session` says where and on what it runs (again at
 * each resume), `message` is every message in the order the model saw them
 * (an assistant's carries its `model`, `usage` and `finish_reason`), `retry`
 * is a call it waited out, and `turn_end` closes a turn with how it finished:
 * completed, max-tokens, max-steps, error or aborted. */
import type { TranscriptFacts, TranscriptRef } from "./types";
import { nextOutcome } from "./types";
import { cap, capJson, INPUT_CAP, OUTPUT_CAP, type Piece, type TranscriptFormat } from "./jsonl-reader";
import { messageTail } from "../turnstatus";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function emptyFacts(id: string): TranscriptFacts {
  return {
    agentSessionId: id, cwd: null, resumeCwd: null, title: null,
    firstPrompt: null, lastPrompt: null, lastPromptAt: null, lastMessage: null,
    model: null, gitBranch: null, startedAt: null, lastActivityAt: null,
    lastTurnAt: null, turnOpen: false, turnError: null, modelOutcome: null,
    contextUsed: null, contextLimit: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 },
    usage: null, rateLimitHits: [], isSubagent: false, parentId: null,
    skipsPermissions: true, headless: false,
  };
}

function args(raw: unknown): any {
  try { return JSON.parse(str(raw) || "{}"); } catch { return { arguments: str(raw) }; }
}

/** A refusal of the model or the key (a 4xx other than a limit), which no retry fixes. */
const REFUSED = /HTTP 4(0[0-4]|22)\b/;
const RATE_LIMITED = /HTTP 429|rate.?limit/i;
const TRANSIENT = /HTTP 5\d\d|HTTP 408|transport|timed? ?out|timeout|stream|no content|insufficient_system_resource/i;

function piecesFor(r: any, index: number): Piece[] {
  const at = num(r.at);
  const id = `dsmin:${index}`;
  if (r.type === "retry") {
    const wait = Math.round(num(r.delay_ms) / 1000);
    return [{ kind: "event", event: { id, at, kind: "meta", tone: "info", text: `Retrying in ${wait}s: ${cap(str(r.error), 300)}` } }];
  }
  if (r.type === "turn_end") {
    const finish = str(r.finish);
    if (finish === "error") return [{ kind: "event", event: { id, at, kind: "meta", tone: "error", text: str(r.error) || "The turn stopped on an error" } }];
    if (finish === "aborted") return [{ kind: "event", event: { id, at, kind: "meta", tone: "info", text: "Interrupted" } }];
    if (finish === "max-tokens") return [{ kind: "event", event: { id, at, kind: "meta", tone: "error", text: "The reply hit the output token limit" } }];
    if (finish === "max-steps") return [{ kind: "event", event: { id, at, kind: "meta", tone: "error", text: `Stopped after ${num(r.steps)} model calls (-max-steps)` } }];
    return [];
  }
  if (r.type !== "message") return [];
  const m = r.message ?? {};
  switch (m.role) {
    case "user":
      return str(m.content) ? [{ kind: "event", event: { id, at, kind: "user", text: m.content } }] : [];
    case "assistant": {
      const out: Piece[] = [];
      if (str(m.reasoning_content)) out.push({ kind: "event", event: { id: `${id}:r`, at, kind: "thinking", text: m.reasoning_content } });
      if (str(m.content)) out.push({ kind: "event", event: { id: `${id}:t`, at, kind: "assistant", text: m.content } });
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const input = args(c?.function?.arguments);
        const callId = str(c?.id);
        if (!callId) continue;
        out.push({ kind: "call", callId, event: {
          id: `${id}:${callId}`, at, kind: "tool", name: str(c?.function?.name) || "bash",
          summary: cap(str(input.command) || str(c?.function?.arguments), 300), input: capJson(input, INPUT_CAP), status: "running",
        } });
      }
      return out;
    }
    case "tool": {
      const text = str(m.content);
      const code = /\[Command finished with exit code (\d+)\]\s*$/.exec(text);
      const error = code ? code[1] !== "0" : /^Error: |\[Command (timed out|interrupted)|\[shell (exited|killed)/m.test(text);
      return [{ kind: "result", callId: str(m.tool_call_id), output: cap(text, OUTPUT_CAP), error, at }];
    }
  }
  return [];
}

export function dsminFormat(ref: TranscriptRef): TranscriptFormat {
  let facts = emptyFacts(ref.agentSessionId);
  return {
    reset() { facts = emptyFacts(ref.agentSessionId); },
    facts() { return facts; },
    state() { return facts; },
    restore(saved) {
      const s = saved as TranscriptFacts;
      if (s?.agentSessionId !== ref.agentSessionId || !s.tokens) throw new Error("invalid dsmin fold");
      facts = s;
    },
    add(r) {
      const at = num(r?.at);
      if (!at) return;
      facts.startedAt ??= at;
      facts.lastActivityAt = at;
      switch (r.type) {
        case "session":
          facts.cwd = facts.resumeCwd = str(r.cwd) || facts.cwd;
          facts.model = str(r.model) || facts.model;
          facts.headless = r.interactive !== true;
          return;
        case "turn_end": {
          facts.turnOpen = false;
          const finish = str(r.finish), detail = str(r.error);
          if (finish === "max-tokens") facts.turnError = { at, kind: "output-cap", detail: "the reply hit the output token limit" };
          else if (finish === "max-steps") facts.turnError = { at, kind: "fatal", detail: `stopped after ${num(r.steps)} model calls` };
          else if (finish === "error") {
            const model = facts.model ?? "";
            if (RATE_LIMITED.test(detail)) facts.rateLimitHits.push({ at, detail: `${model}: ${detail}`.slice(0, 200), provider: model.split("/")[0] || undefined });
            if (REFUSED.test(detail) && model) facts.modelOutcome = nextOutcome(facts.modelOutcome ?? null, model, at, { refused: detail.slice(0, 200) });
            facts.turnError = { at, kind: RATE_LIMITED.test(detail) || TRANSIENT.test(detail) ? "transient" : "fatal", detail };
          }
          return;
        }
        case "message":
          break;
        default:
          return;
      }
      const m = r.message ?? {};
      if (m.role === "user" && str(m.content)) {
        facts.firstPrompt ??= m.content;
        facts.lastPrompt = m.content;
        facts.lastPromptAt = at;
        facts.turnOpen = true;
        facts.turnError = null;
      } else if (m.role === "assistant") {
        if (str(m.content)) facts.lastMessage = messageTail(m.content);
        if (str(r.model)) facts.model = r.model;
        facts.lastTurnAt = at;
        if (facts.model) facts.modelOutcome = nextOutcome(facts.modelOutcome ?? null, facts.model, at, "answered");
        const u = r.usage;
        if (u) {
          const prompt = num(u.prompt_tokens);
          const cached = num(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens);
          facts.tokens.input += Math.max(0, prompt - cached);
          facts.tokens.cacheRead += cached;
          facts.tokens.output += num(u.completion_tokens);
          facts.contextUsed = prompt + num(u.completion_tokens);
        }
      }
    },
    links(r) {
      if (r?.type !== "message") return null;
      const m = r.message ?? {};
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        const calls = m.tool_calls.map((c: any) => str(c?.id)).filter(Boolean);
        return calls.length ? { calls } : null;
      }
      return m.role === "tool" && str(m.tool_call_id) ? { results: [m.tool_call_id] } : null;
    },
    pieces: (r, index) => piecesFor(r, index),
    locate(id) {
      const m = /^dsmin:(\d+)/.exec(id);
      return m ? { index: Number(m[1]) } : null;
    },
  };
}
