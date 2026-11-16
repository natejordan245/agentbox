/** Validation for the client → server half of the WebSocket protocol.
 *
 * The old server's message handler was `message(_ws) {}` — it threw away
 * everything a client sent, which is why per-session watching could not
 * exist. Anything arriving here is untrusted text, so it is validated rather
 * than cast.
 */

import type { ClientMessage } from "../core/types";

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

export function parseClientMessage(raw: unknown): ParseResult {
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Uint8Array
        ? new TextDecoder().decode(raw)
        : null;
  if (text === null) return { ok: false, error: "expected a text frame" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "message is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "message must be a JSON object" };
  }

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "ping":
      return { ok: true, message: { type: "ping" } };

    case "watch": {
      const sessionId = msg.sessionId;
      if (typeof sessionId !== "string" && sessionId !== null) {
        return { ok: false, error: "watch.sessionId must be a session id or null" };
      }
      if (sessionId === "") {
        return { ok: false, error: "watch.sessionId must not be empty — use null to stop watching" };
      }
      const cursor = msg.cursor;
      if (cursor !== undefined && typeof cursor !== "string") return { ok: false, error: "watch.cursor must be a string" };
      return { ok: true, message: cursor && sessionId ? { type: "watch", sessionId, cursor } : { type: "watch", sessionId } };
    }

    case "draft": {
      const { key, at } = msg;
      if (typeof key !== "string" || key === "") return { ok: false, error: "draft.key must be a string" };
      if (typeof at !== "number" || !Number.isFinite(at)) return { ok: false, error: "draft.at must be a number" };
      if (msg.draft === null) return { ok: true, message: { type: "draft", key, draft: null, at } };
      const d = (msg.draft ?? {}) as Record<string, unknown>;
      const images = Array.isArray(d.images) ? (d.images as Record<string, unknown>[]) : null;
      if (
        typeof d.text !== "string" ||
        typeof d.revision !== "string" ||
        !images?.every((i) => typeof i?.n === "number" && typeof i.name === "string" && typeof i.path === "string")
      ) {
        return { ok: false, error: "draft.draft must be {text, images, revision} or null" };
      }
      return {
        ok: true,
        message: {
          type: "draft",
          key,
          at,
          draft: { text: d.text, images: images.map((i) => ({ n: i.n as number, name: i.name as string, path: i.path as string })), at, revision: d.revision },
        },
      };
    }

    default:
      return {
        ok: false,
        error: `unknown message type ${JSON.stringify(msg.type)} — expected "watch", "draft" or "ping"`,
      };
  }
}
