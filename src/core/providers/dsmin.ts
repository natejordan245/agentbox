/** dsmin (~/Documents/dsmin): a native port of DeepSeek Harness's Minimal mode,
 * the scaffold behind DeepSeek's own benchmark numbers — one bash tool and a
 * one-line system prompt — at about 17 MB a session. It has no login of its
 * own: a session runs on an omp account on Morph, given the account's key in
 * `MORPH_API_KEY` as omp is (`accountProvider`). Its sessions are JSONL files
 * in one store for every account, `$DSMIN_HOME/sessions/<id>.jsonl`, and a
 * running dsmin holds its session's file open for its whole life, which is
 * what ties a process to its session. A resume reads the session's own
 * workspace, model and effort from its transcript; the shell starts fresh. */
import { readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { Account, ServiceId } from "../types";
import { userHome } from "../paths";
import { readApiKey, service, serviceOf } from "../accounts/services";
import { cliVersion } from "./cli-version";
import { JsonlTranscriptReader } from "./jsonl-reader";
import { dsminFormat } from "./dsmin-transcript";
import { agentDir } from "./omp";
import { ompContextLimit } from "./omp-models";
import { cwdOf, environOf, findProcesses, openFilesOf, runsCli, startedAtOf } from "./procs";
import type { Command, LiveProcess, ProviderAdapter, ResumeOptions, SpawnOptions, TranscriptRef } from "./types";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DEFAULT_MODEL = "morph/morph-dsv41flash-1017";
const EFFORTS = ["off", "low", "high", "max"] as const;

/** dsmin's home, as dsmin itself works it out; every session is told it, so the two agree. */
const dsminHome = (): string => process.env.DSMIN_HOME || join(process.env.XDG_DATA_HOME || join(userHome(), ".local", "share"), "dsmin");
const store = (): string => join(dsminHome(), "sessions");

/** The account's key in its service's variable. What could quietly change a
 *  session from the server's shell (another model, effort or system prompt)
 *  is removed. */
function accountCommand(account: Pick<Account, "provider" | "home">): Pick<Command, "env" | "unset" | "secret"> {
  const env: Record<string, string> = { DSMIN_HOME: dsminHome() };
  const unset = ["DSH_MODEL", "DSH_REASONING_EFFORT", "DSH_SYSTEM_PROMPT"];
  const svc = serviceOf(account);
  const key = svc?.login === "api-key" && svc.keyEnv ? readApiKey(account.home)?.key : null;
  if (!key || !svc?.keyEnv) return { env, unset };
  env[svc.keyEnv] = key;
  return { env, unset, secret: [svc.keyEnv] };
}

/** The account a running dsmin was started on: the one whose key it holds. */
function accountOfEnv(env: Map<string, string> | null, accounts: readonly Account[]): Account | undefined {
  if (!env) return undefined;
  return accounts.find((a) => {
    const held = readApiKey(a.home);
    const keyEnv = service(held?.service)?.keyEnv;
    return !!held && !!keyEnv && env.get(keyEnv) === held.key;
  });
}

function refOf(account: Account, id: string): TranscriptRef | null {
  const path = join(store(), `${id}.jsonl`);
  try {
    const st = statSync(path);
    return st.isFile() ? { provider: "dsmin", accountId: account.id, agentSessionId: id, path, mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

/** The flags a launch and a resume share. A model or effort left out is the
 *  session's own on a resume, dsmin's default on a launch. */
function flags(opts: { cwd: string; model?: string; effort?: string; promptFile?: string; briefingFile?: string }): string[] {
  const a = ["-C", opts.cwd];
  if (opts.model) a.push("-model", opts.model);
  if (opts.effort && (EFFORTS as readonly string[]).includes(opts.effort)) a.push("-effort", opts.effort);
  if (opts.briefingFile) a.push("-append-system-file", opts.briefingFile);
  if (opts.promptFile) a.push("-prompt-file", opts.promptFile);
  return a;
}

export const dsminAdapter: ProviderAdapter = {
  id: "dsmin",
  label: "dsmin",
  efforts: EFFORTS,
  promptDelivery: "file",

  detect: () => cliVersion(["dsmin", "-version"]),
  defaultHome: dsminHome,
  accountCommand,
  authEnv: () => ({ env: {} }),

  async listTranscripts(account, sinceMs) {
    let names: string[];
    try {
      names = readdirSync(store());
    } catch {
      return [];
    }
    const out: TranscriptRef[] = [];
    for (const name of names) {
      const id = name.endsWith(".jsonl") ? name.slice(0, -6) : "";
      if (!UUID.test(id)) continue;
      const ref = refOf(account, id);
      if (ref && ref.mtimeMs >= sinceMs) out.push(ref);
    }
    return out;
  },

  async findTranscript(account, id) {
    return UUID.test(id) ? refOf(account, id) : null;
  },

  reader: (ref) => new JsonlTranscriptReader(ref, dsminFormat(ref)),

  /** Interactive ones only: a one-shot `dsmin "task"` is someone's script
   *  (a benchmark fan-out), and keeps no session unless told where. */
  async liveProcesses(accounts) {
    const root = store() + sep;
    const out: LiveProcess[] = [];
    for (const proc of findProcesses((argv) => runsCli(argv, "dsmin") && argv.includes("-i"))) {
      const cwd = cwdOf(proc.pid), startedAt = startedAtOf(proc.pid);
      if (!cwd || startedAt === null) continue;
      const file = openFilesOf(proc.pid).find((p) => p.startsWith(root) && p.endsWith(".jsonl"));
      const id = file ? basename(file, ".jsonl") : null;
      out.push({ pid: proc.pid, accountId: accountOfEnv(environOf(proc.pid), accounts)?.id ?? null, agentSessionId: id && UUID.test(id) ? id : null, cwd, startedAt });
    }
    return out;
  },

  // One store for every account; the account is only whose key a request carries.
  sharedStore: true,
  moveSession: ({ transcriptPath }) => transcriptPath,

  modelContextLimit: (model) => ompContextLimit(agentDir(), model),
  defaultModel: () => DEFAULT_MODEL,
  defaultModelOn: (svc: ServiceId) => (svc === "morph" ? DEFAULT_MODEL : null),

  spawnCommand(opts: SpawnOptions) {
    const id = crypto.randomUUID();
    return { argv: ["dsmin", "-i", "-session-id", id, ...flags(opts)], ...accountCommand(opts.account), agentSessionId: id };
  },

  resumeCommand(opts: ResumeOptions): Command {
    return { argv: ["dsmin", "-i", "-resume", opts.agentSessionId, ...flags(opts)], ...accountCommand(opts.account) };
  },

  headless: (argv) => !argv.includes("-i"),
};
