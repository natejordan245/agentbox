/**
 * Gzip for a device across the tailnet. The board is a megabyte and a half of
 * JSON and a phone asks for it each time the app comes forward; gzipped it is
 * a sixth of that. Compressed off the server's thread, and never for this
 * machine's own page: there is no link to save there, only CPU to spend.
 */
import { promisify } from "node:util";
import { gzip as zlibGzip } from "node:zlib";

const gzip = promisify(zlibGzip);

/** Below this a frame or a body goes as it is: nothing to save. */
export const SQUEEZE_MIN_CHARS = 2_000;
/** Most of the saving for a third of the CPU of the default. */
const LEVEL = 4;

export async function squeeze(text: string | Uint8Array): Promise<Buffer<ArrayBuffer>> {
  // (zlib makes its own buffer: never a shared one.)
  return (await gzip(text, { level: LEVEL })) as Buffer<ArrayBuffer>;
}

/** A JSON answer, gzipped for a client that takes it. */
export async function squeezed(req: Request, res: Response): Promise<Response> {
  if (!res.body || res.headers.has("content-encoding") || !res.headers.get("content-type")?.startsWith("application/json")) return res;
  if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return res;
  const raw = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (raw.length < SQUEEZE_MIN_CHARS) return new Response(raw, { status: res.status, headers });
  headers.set("content-encoding", "gzip");
  headers.set("vary", "accept-encoding");
  return new Response(await squeeze(raw), { status: res.status, headers });
}
