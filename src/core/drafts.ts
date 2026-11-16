/** The server's copy of every unsent draft, so a message begun on one device
 *  is finished on another.
 *
 *  A page sends its copy as it is typed, and that it is gone once it is sent
 *  or emptied (`draft` on the socket, both ways). Each carries a version, and
 *  the server keeps whichever is later: a page that was offline, or two
 *  typing into one box, end on the same text without either asking first.
 */

import { getDb } from "./db";
import type { Draft } from "./types";

interface Row {
  key: string;
  text: string;
  images: string;
  revision: string;
  at: number;
}

const draftOf = (r: Row): Draft => ({ text: r.text, images: JSON.parse(r.images) as Draft["images"], at: r.at, revision: r.revision });

export function listDrafts(): Record<string, Draft> {
  const rows = getDb().query("SELECT key, text, images, revision, at FROM drafts").all() as Row[];
  return Object.fromEntries(rows.map((r) => [r.key, draftOf(r)]));
}

/** When each key's draft went, so a copy from before that is not taken for a
 *  new one. Only this process's: after a restart an old copy comes back as
 *  the draft, which loses nothing. */
const gone = new Map<string, number>();

/**
 * Keep `draft` for `key` (null: it is gone) if `at` is later than the last
 * taken for it. Returns what the key holds after, and whether that changed.
 */
export function takeDraft(key: string, draft: Draft | null, at: number): { took: boolean; draft: Draft | null; at: number } {
  const db = getDb();
  const row = db.query("SELECT key, text, images, revision, at FROM drafts WHERE key = ?").get(key) as Row | null;
  const last = row?.at ?? gone.get(key) ?? 0;
  if (at <= last) return { took: false, draft: row ? draftOf(row) : null, at: last };
  if (draft) {
    db.run("INSERT OR REPLACE INTO drafts (key, text, images, revision, at) VALUES (?,?,?,?,?)", [key, draft.text, JSON.stringify(draft.images), draft.revision, at]);
    gone.delete(key);
  } else {
    db.run("DELETE FROM drafts WHERE key = ?", [key]);
    gone.set(key, at);
  }
  return { took: true, draft: draft ? { ...draft, at } : null, at };
}
