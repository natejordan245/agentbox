import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mapPool, resolveDefaultBranch, run } from "./git";
import type { DiffFile, Session, SessionDiff } from "./types";

/**
 * Caps. A runaway agent can produce a diff far larger than a browser should be
 * asked to hold, and this is serialised straight into a WebSocket message. The
 * counts are always exact — only the patch bodies are bounded — so the summary
 * a human skims stays true even when the text is clipped.
 */
const MAX_PATCH_BYTES = 96 * 1024;
const MAX_TOTAL_PATCH_BYTES = 3 * 1024 * 1024;
/** Beyond this, per-file `git diff` spawns cost more than the review is worth. */
const MAX_PATCH_FILES = 400;
/** Patches read at once: each is a process, and the agents need the cores. */
const PATCHES_AT_ONCE = 6;
/** A diff of more changed lines than this is not read in one piece. */
const MAX_WHOLE_LINES = 200_000;

/** Which branch a session's work is judged against: the default branch of the
 *  repository its directory belongs to. */
function baseFor(session: Session): Promise<string> {
  const root = session.repoRoot;
  if (!root) return Promise.resolve("main");
  // Cached: resolving can ask the remote, and `agentbox diff` may be asked often.
  let base = bases.get(root);
  if (!base) bases.set(root, (base = resolveDefaultBranch(root).catch(() => "main")));
  return base;
}
const bases = new Map<string, Promise<string>>();

/**
 * The diff a human reviews: this session's worktree against where it branched
 * from `base`. Omit `base` to use the session's repo default.
 *
 * Untracked files are included. An agent's most common single act is creating a
 * file, and `git diff` alone renders that as nothing at all — a review screen
 * that silently omits new files is worse than no review screen.
 */
export async function diffOf(session: Session, base?: string): Promise<SessionDiff> {
  base ??= await baseFor(session);
  const empty: SessionDiff = { base, files: [], additions: 0, deletions: 0, unavailable: true };
  const wt = session.worktree ?? session.cwd;
  if (!wt || !existsSync(wt)) return empty;
  if ((await run(["git", "rev-parse", "--is-inside-work-tree"], wt)).code !== 0) return empty;

  const against = await mergeBase(wt, base);
  const [tracked, untracked] = await Promise.all([trackedFiles(wt, against), untrackedFiles(wt)]);
  const patches = await trackedPatches(wt, against, tracked);
  // Spent as the patches come in, a few at a time: the cap is on what a
  // browser is sent, not a count to the byte.
  let budget = MAX_TOTAL_PATCH_BYTES;
  const files = await mapPool([...tracked, ...untracked], PATCHES_AT_ONCE, async (entry, index): Promise<DiffFile> => {
    // `patch: null` is the type's way of saying "binary" — there is no text
    // to show and a line count would be a lie.
    if (entry.binary) return { ...entry.file, patch: null };
    if (index >= MAX_PATCH_FILES || budget <= 0) {
      return { ...entry.file, patch: `… patch omitted: this diff exceeded ${MAX_PATCH_FILES} files or ${megabytes(MAX_TOTAL_PATCH_BYTES)} of patch text. The counts on this row are still exact.` };
    }
    const patch = clamp(entry.untracked ? await untrackedPatch(wt, entry.file.path) : (patches.get(entry.file.path) ?? (await trackedPatch(wt, against, entry.file.path))));
    budget -= patch.length;
    return { ...entry.file, patch };
  });

  return {
    base,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    unavailable: false,
  };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function clamp(patch: string): string {
  if (patch.length <= MAX_PATCH_BYTES) return patch;
  return (
    patch.slice(0, MAX_PATCH_BYTES) +
    `\n… truncated: this file's patch is ${Math.round(patch.length / 1024)} KB, showing the first ${Math.round(MAX_PATCH_BYTES / 1024)} KB …\n`
  );
}

/**
 * Where this branch left `base`. Diffing against the tip of `base` instead would
 * show every commit that landed on main since the agent started as if the agent
 * had reverted them.
 *
 * Falls back to the empty tree when there is no common ancestor — a worktree on
 * an unrelated history still has a real diff, it is just "everything".
 */
async function mergeBase(wt: string, base: string): Promise<string> {
  const candidates = [`origin/${base}`, base];
  for (const ref of candidates) {
    if ((await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], wt)).code !== 0) continue;
    const found = await run(["git", "merge-base", ref, "HEAD"], wt);
    if (found.code === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  // git's empty tree object: diffing against it yields the whole worktree.
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

interface Entry {
  file: Omit<DiffFile, "patch">;
  binary: boolean;
  untracked: boolean;
}

/** Walk a NUL-delimited git record stream. */
function records(out: string): string[] {
  const parts = out.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const STATUS_LETTER: Record<string, DiffFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

async function trackedFiles(wt: string, against: string): Promise<Entry[]> {
  const statuses = new Map<string, DiffFile["status"]>();
  const [nameStatus, numstat] = await Promise.all([
    run(["git", "diff", "--name-status", "-M", "-z", against], wt),
    run(["git", "diff", "--numstat", "-M", "-z", against], wt),
  ]);
  if (nameStatus.code === 0) {
    const parts = records(nameStatus.stdout);
    for (let i = 0; i < parts.length; ) {
      const code = parts[i++];
      const letter = code[0];
      if (letter === "R" || letter === "C") {
        i++; // old path; the new path is what the reviewer sees
        const to = parts[i++];
        if (to) statuses.set(to, STATUS_LETTER[letter] ?? "modified");
      } else {
        const path = parts[i++];
        if (path) statuses.set(path, STATUS_LETTER[letter] ?? "modified");
      }
    }
  }

  if (numstat.code !== 0) return [];
  const out: Entry[] = [];
  const parts = records(numstat.stdout);
  for (let i = 0; i < parts.length; ) {
    const chunk = parts[i++];
    const [add, del, inline] = chunk.split("\t");
    let path = inline;
    if (path === "" || path === undefined) {
      // Rename: the trailing field is empty and old/new follow as their own records.
      i++; // old path
      path = parts[i++];
    }
    if (!path) continue;
    const binary = add === "-" && del === "-";
    out.push({
      file: {
        path,
        status: statuses.get(path) ?? "modified",
        additions: binary ? 0 : Number(add) || 0,
        deletions: binary ? 0 : Number(del) || 0,
      },
      binary,
      untracked: false,
    });
  }
  return out;
}

async function untrackedFiles(wt: string): Promise<Entry[]> {
  const r = await run(["git", "ls-files", "--others", "--exclude-standard", "-z"], wt);
  if (r.code !== 0) return [];
  const out: Entry[] = [];
  for (const path of records(r.stdout)) {
    if (!path) continue;
    const probe = probeNew(join(wt, path));
    out.push({
      file: { path, status: "untracked", additions: probe.lines, deletions: 0 },
      binary: probe.binary,
      untracked: true,
    });
  }
  return out;
}

/**
 * Classify a file git has no index entry for. Same test git uses: a NUL byte in
 * the first 8 KB means binary.
 */
function probeNew(abs: string): { binary: boolean; lines: number } {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    // A dangling symlink or an unreadable path. Show the row, claim nothing
    // about its contents.
    return { binary: true, lines: 0 };
  }
  if (!stat.isFile()) return { binary: true, lines: 0 };
  if (stat.size === 0) return { binary: false, lines: 0 };
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return { binary: true, lines: 0 };
  }
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, lines: 0 };
  const text = buf.toString("utf8");
  const newlines = text.split("\n").length - 1;
  // A file with no trailing newline still has that last line in the patch.
  return { binary: false, lines: text.endsWith("\n") ? newlines : newlines + 1 };
}

/**
 * Every tracked file's patch from one `git diff`, by path: asked a file at a
 * time, git reads the checkout's index again for each, half a second in a
 * large repository. Empty for a diff too large to hold in one piece, and
 * without the files whose names git quotes: those are read one at a time
 * (`trackedPatch`).
 */
async function trackedPatches(wt: string, against: string, tracked: Entry[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const lines = tracked.reduce((n, e) => n + e.file.additions + e.file.deletions, 0);
  if (tracked.length > MAX_PATCH_FILES || lines > MAX_WHOLE_LINES) return out;
  const r = await run(["git", "-c", "core.quotePath=false", "diff", "-M", against], wt);
  if (r.code !== 0) return out;
  // No line of a patch's body starts a line with "diff --git": only a file's header does.
  for (const chunk of r.stdout.split(/^(?=diff --git )/m)) {
    const path = chunkPath(chunk);
    if (path !== null) out.set(path, chunk);
  }
  return out;
}

/** The file one file's part of a `git diff` is about: its new name, or the
 *  one it had when it was deleted. Null for a name git put in quotes. */
function chunkPath(chunk: string): string | null {
  // The header alone: an added line can read "++ b/…" and look like one of its lines.
  const body = chunk.indexOf("\n@@");
  const head = body < 0 ? chunk : chunk.slice(0, body);
  const named = /^(?:rename|copy) to (.+)$/m.exec(head) ?? /^\+\+\+ b\/(.+?)\t?$/m.exec(head) ?? /^--- a\/(.+?)\t?$/m.exec(head);
  if (named) return named[1]!;
  // A change of mode, or a binary file: named only on the first line, twice.
  return /^diff --git a\/(.+) b\/\1$/m.exec(head)?.[1] ?? null;
}

async function trackedPatch(wt: string, against: string, path: string): Promise<string> {
  const r = await run(["git", "diff", "-M", against, "--", path], wt);
  return r.code === 0 ? r.stdout : `… could not read this file's patch: ${r.stderr.trim()}\n`;
}

/**
 * A patch for a file git does not track yet. `--no-index` against /dev/null
 * renders it as an addition; it exits 1 when there is a difference, which is
 * the expected outcome, so only a code above 1 is a real failure.
 */
async function untrackedPatch(wt: string, path: string): Promise<string> {
  const r = await run(["git", "diff", "--no-index", "--", "/dev/null", path], wt);
  if (r.code > 1) return `… could not read this file's patch: ${r.stderr.trim()}\n`;
  return r.stdout;
}
