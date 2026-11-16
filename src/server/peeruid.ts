/** Which Unix user opened a connection from this machine.
 *
 *  Loopback is the owner (`csrf.ts`), which is only true on a machine where
 *  the owner is the only user who runs anything. On a shared box (a CI box
 *  whose runners are other users, running pull requests' code) any process
 *  can connect to 127.0.0.1, so a connection from this machine is the owner's
 *  only when the socket is the owner's. On Linux the kernel says whose the
 *  client's end of it is; elsewhere nothing does and the old rule stands.
 *
 *  It is asked on every request, on the server's one thread, and nothing
 *  about a connection may be remembered between requests: a port is free for
 *  another user to bind the moment its connection closes. So the kernel is
 *  asked about that one socket (`sock_diag`), which costs the same whatever
 *  else the machine has open. `/proc/net/tcp` answers too, as a table of
 *  every socket there is: with a few thousand of them (test databases) reading
 *  it took 85 ms a request. It stays as the answer when the kernel cannot be
 *  asked, or knows no socket by the addresses guessed. */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";

type Peer = { address: string; port: number };

const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const SOCK_DGRAM = 2;
const SOCK_CLOEXEC = 0o2000000;
const NETLINK_SOCK_DIAG = 4;
const SOCK_DIAG_BY_FAMILY = 20;
const NLM_F_REQUEST = 1;
const NLMSG_ERROR = 2;
const IPPROTO_TCP = 6;
/** `struct nlmsghdr`, `struct inet_diag_req_v2` and `struct inet_diag_msg` (linux/inet_diag.h). */
const HEADER = 16;
const REQUEST = 56;
const ANSWER = 72;
const UID_AT = 64;

function openLibc() {
  if (process.platform !== "linux") return null;
  try {
    return dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
      recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    }).symbols;
  } catch {
    return null;
  }
}
const libc = openLibc();

/** An address as the kernel keys a socket by it, or null for one this does not read. */
function addressBytes(address: string): { family: number; bytes: Uint8Array } | null {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) return { family: AF_INET, bytes: Uint8Array.from(v4.slice(1, 5), Number) };
  if (address === "::1") return { family: AF_INET6, bytes: Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? 1 : 0)) };
  return null;
}

/** The uid of the socket `client` connected from, asked of the kernel for
 *  that socket alone; null when it knows none, undefined when it cannot be
 *  asked. A connection from this machine reaches the address it comes from. */
function socketUid(client: Peer, serverPort: number): number | null | undefined {
  const at = addressBytes(client.address);
  if (!libc || !at) return undefined;
  const fd = libc.socket(AF_NETLINK, SOCK_DGRAM | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
  if (fd < 0) return undefined;
  try {
    const ask = new Uint8Array(HEADER + REQUEST);
    const a = new DataView(ask.buffer);
    a.setUint32(0, ask.length, true);
    a.setUint16(4, SOCK_DIAG_BY_FAMILY, true);
    a.setUint16(6, NLM_F_REQUEST, true);
    ask[HEADER] = at.family;
    ask[HEADER + 1] = IPPROTO_TCP;
    a.setUint32(HEADER + 4, 0xffffffff, true); // in any state
    a.setUint16(HEADER + 8, client.port, false);
    a.setUint16(HEADER + 10, serverPort, false);
    ask.set(at.bytes, HEADER + 12);
    ask.set(at.bytes, HEADER + 28);
    a.setUint32(HEADER + 48, 0xffffffff, true); // whichever socket has these addresses now
    a.setUint32(HEADER + 52, 0xffffffff, true);
    if (Number(libc.send(fd, ptr(ask), BigInt(ask.length), 0)) !== ask.length) return undefined;
    const got = new Uint8Array(512);
    const n = Number(libc.recv(fd, ptr(got), BigInt(got.length), 0));
    if (n < HEADER + 4) return undefined;
    const g = new DataView(got.buffer);
    const type = g.getUint16(4, true);
    // An error of "no such socket" is an answer; any other is not.
    if (type === NLMSG_ERROR) return g.getInt32(HEADER, true) === -2 ? null : undefined;
    return type === SOCK_DIAG_BY_FAMILY && n >= HEADER + ANSWER ? g.getUint32(HEADER + UID_AT, true) : undefined;
  } finally {
    libc.close(fd);
  }
}

const TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

/** The same from the table of every socket, by the two ports alone;
 *  undefined where /proc has no such table, null when no row matches. */
function tableUid(clientPort: number, serverPort: number): number | null | undefined {
  let any = false;
  const want = `:${clientPort.toString(16).toUpperCase().padStart(4, "0")}`;
  const peer = `:${serverPort.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const t of TABLES) {
    let text: string;
    try {
      text = readFileSync(t, "utf8");
    } catch {
      continue;
    }
    any = true;
    // Only lines naming the port are split: the table runs to thousands of rows.
    for (let i = text.indexOf(`${want} `); i >= 0; i = text.indexOf(`${want} `, i + 1)) {
      const start = text.lastIndexOf("\n", i) + 1;
      const end = text.indexOf("\n", i);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
      const c = text.slice(start, end < 0 ? undefined : end).trim().split(/\s+/);
      if (c.length > 7 && c[1]!.endsWith(want) && c[2]!.endsWith(peer)) return Number(c[7]);
    }
  }
  return any ? null : undefined;
}

const me = process.getuid?.() ?? null;

/** Why a connection from this machine is refused (another Unix user's), or null. */
export function otherUserRefusal(client: Peer | null | undefined, serverPort: number): string | null {
  if (me === null || !client?.port) return null;
  const uid = socketUid(client, serverPort) ?? tableUid(client.port, serverPort);
  if (uid === undefined || uid === me) return null;
  return uid === null ? "cannot tell which user opened this connection" : "only agentbox's own Unix user may connect from this machine";
}
