// `slack relay daemon`: a relay router client (worker/src/router.ts is the hub).
//
// Several daemons, on different hosts, connect to the same hub. The hub picks
// one leader; the others wait as hot standby and are promoted within seconds
// when the leader's socket closes or its lease lapses. Only the leader gets
// deliveries: {id, owner, payload}. For each, it runs the owner's handler
// command (stdin = the payload as JSON) and acks the id when the command exits
// 0; anything not acked is redelivered by the hub, to this leader after a
// timeout or to the next one. Delivery is therefore at least once; a bounded
// set of ids already handled keeps a redelivery from reaching a handler twice
// from the same daemon.
//
// The bearer token comes from $SLACK_ROUTER_TOKEN or a file
// ($SLACK_ROUTER_TOKEN_FILE) that only its owner can read — never from argv,
// and it is never printed. It rides in the Sec-WebSocket-Protocol header like
// the doorbell relay's (Node's WebSocket cannot set other headers).

import { readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";

export const PROTOCOL = "slack-hub-router.v1";
const BEARER_PREFIX = "bearer.";

export type Deliver = { type: "deliver"; id: string; owner: string; payload: unknown };
export type Role = { type: "role"; role: "leader" | "standby"; leader: string | null; lease_ms: number; heartbeat_ms: number };

/** Token from the environment or a 0600 file. Errors name the source, never the value. */
export function readToken(env: Record<string, string | undefined>): { token: string } | { error: string } {
  if (env.SLACK_ROUTER_TOKEN) return { token: env.SLACK_ROUTER_TOKEN };
  const file = env.SLACK_ROUTER_TOKEN_FILE;
  if (!file) return { error: "no token: set SLACK_ROUTER_TOKEN or SLACK_ROUTER_TOKEN_FILE" };
  let mode: number;
  try { mode = statSync(file).mode; } catch { return { error: `token file not readable: ${file}` }; }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) return { error: `token file ${file} is readable by others: chmod 600 it` };
  const token = readFileSync(file, "utf8").trim();
  return token ? { token } : { error: `token file is empty: ${file}` };
}

/** `owner=command` pairs; `*=command` is the fallback for any other owner. */
export function parseHandlers(specs: string[]): { handlers: Map<string, string> } | { error: string } {
  const handlers = new Map<string, string>();
  for (const s of specs) {
    const i = s.indexOf("=");
    if (i <= 0 || i === s.length - 1) return { error: `bad --handler ${JSON.stringify(s)}: want owner=command` };
    handlers.set(s.slice(0, i), s.slice(i + 1));
  }
  return { handlers };
}

/** Bounded insertion-ordered set of handled ids. */
export class SeenSet {
  private ids = new Set<string>();
  constructor(private readonly max = 2000) {}
  has(id: string): boolean { return this.ids.has(id); }
  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string);
  }
  get size(): number { return this.ids.size; }
}

/** Runs `command` with `sh -c`, the payload on stdin; resolves to the exit code. */
export function runHandler(command: string, payload: unknown, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve) => {
    // The token is not passed on to handlers.
    const { SLACK_ROUTER_TOKEN: _t, SLACK_ROUTER_TOKEN_FILE: _f, ...rest } = env;
    const p = spawn("sh", ["-c", command], { stdio: ["pipe", "inherit", "inherit"], env: rest });
    p.on("error", () => resolve(127));
    p.on("close", (code) => resolve(code ?? 1));
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}

/** The daemon's decisions, without a socket: what to do with each frame. */
export class RouterClient {
  role: "leader" | "standby" | "connecting" = "connecting";
  readonly seen: SeenSet;
  private running = new Set<string>();
  /** Newest leader epoch seen from the hub. */
  epoch = 0;
  /** Local time the hub last confirmed our lease (role or lease frame). */
  private leaseAt = -Infinity;
  private leaseMs = 10_000;
  private heartbeatMs = 3_000;

  constructor(
    private readonly handlers: Map<string, string>,
    private readonly io: {
      send(frame: string): void;
      run(command: string, payload: unknown): Promise<number>;
      log(line: string): void;
      /** Local monotonic-ish clock (ms); injectable for tests. */
      now?: () => number;
    },
    seenMax = 2000,
  ) {
    this.seen = new SeenSet(seenMax);
  }

  /** Handle one hub frame. Resolves when any handler it started has finished. */
  async frame(data: string): Promise<void> {
    let f: { type?: string; role?: string; leader?: string | null; id?: unknown; owner?: unknown; payload?: unknown;
      epoch?: unknown; lease_ms?: unknown; heartbeat_ms?: unknown };
    try { f = JSON.parse(data) as typeof f; } catch { return; }
    const now = (this.io.now ?? Date.now)();
    const epoch = typeof f.epoch === "number" ? f.epoch : 0;
    if (f.type === "role" && (f.role === "leader" || f.role === "standby")) {
      if (f.role !== this.role) this.io.log(f.role === "leader" ? `leader (epoch ${epoch}): receiving deliveries` : `standby (leader: ${f.leader ?? "none"})`);
      this.role = f.role;
      this.epoch = Math.max(this.epoch, epoch);
      if (typeof f.lease_ms === "number") this.leaseMs = f.lease_ms;
      if (typeof f.heartbeat_ms === "number") this.heartbeatMs = f.heartbeat_ms;
      this.leaseAt = f.role === "leader" ? now : -Infinity;
      return;
    }
    if (f.type === "lease") {
      if (this.role === "leader" && epoch >= this.epoch) { this.epoch = epoch; this.leaseAt = now; }
      return;
    }
    if (f.type !== "deliver" || typeof f.id !== "string" || typeof f.owner !== "string") return;
    const id = f.id;
    // Fencing. A daemon that was paused (SIGSTOP, a GC stall, a starved CPU)
    // may wake up to deliveries buffered while it still led — after the hub
    // has already promoted someone else. Refuse them, without running or
    // acking: the hub has handed them to the new leader. Our lease is counted
    // from when the hub confirmed it, and expires one heartbeat early, so it
    // ends here before it ends at the hub.
    const reason = this.role !== "leader" ? "not the leader"
      : epoch < this.epoch ? `stale epoch ${epoch} < ${this.epoch}`
      : now - this.leaseAt > this.leaseMs - this.heartbeatMs ? "lease expired locally"
      : null;
    if (reason !== null) {
      this.io.log(`${id}: refused (${reason})`);
      return;
    }
    // Handled already (a redelivery whose ack was lost): ack again, do not rerun.
    if (this.seen.has(id)) return this.ack(id);
    if (this.running.has(id)) return; // still running; its own ack will follow
    const cmd = this.handlers.get(f.owner) ?? this.handlers.get("*");
    if (cmd === undefined) {
      this.io.log(`${id}: no handler for owner ${f.owner}; left unacked`);
      return;
    }
    this.running.add(id);
    try {
      const code = await this.io.run(cmd, f.payload);
      if (code === 0) {
        this.seen.add(id);
        this.ack(id);
      } else {
        this.io.log(`${id}: handler for ${f.owner} exited ${code}; the hub will redeliver`);
      }
    } finally {
      this.running.delete(id);
    }
  }

  private ack(id: string): void { this.io.send(JSON.stringify({ type: "ack", id })); }
}

/** The Sec-WebSocket-Protocol values a daemon offers: the router protocol and the bearer. */
export function daemonProtocols(token: string): string[] {
  return [PROTOCOL, BEARER_PREFIX + Buffer.from(token).toString("base64url")];
}

/** Next reconnect delay. A daemon that was connected in the last RECENT_MS is
 *  most likely seeing a hub restart or standby churn: retry within 5 s. */
export const RECENT_MS = 300_000;
export function nextBackoff(prev: number, opened: boolean, sinceConnectedMs: number): number {
  if (opened) return 1000;
  return Math.min(prev * 2, sinceConnectedMs <= RECENT_MS ? 5_000 : 30_000);
}

/** After a failed handshake: was it the token? (WebSocket close events do not
 *  carry the HTTP status, so ask an endpoint with the same token.) */
export async function tokenRejected(base: string, token: string, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await f(new URL("/router/status", base), { headers: { authorization: `Bearer ${token}` } });
    return res.status === 401;
  } catch {
    return false;
  }
}

export function routerWsUrl(base: string, host: string): string {
  const u = new URL("/router/ws", base);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.searchParams.set("host", host);
  return u.toString();
}

/** Connect, heartbeat, reconnect with backoff, forever (until `signal` aborts). */
export async function runDaemon(opts: {
  url: string; token: string; handlers: Map<string, string>; host?: string;
  signal?: AbortSignal; log?: (line: string) => void;
}): Promise<void> {
  const log = opts.log ?? ((l: string) => console.error(`slack relay daemon: ${l}`));
  const host = opts.host ?? hostname();
  const proto = daemonProtocols(opts.token);
  let backoff = 1000;
  let lastConnected = -Infinity;
  // One client across reconnects: the seen set must outlive a socket.
  let ws: WebSocket | null = null;
  const client = new RouterClient(opts.handlers, {
    send: (f) => { try { ws?.send(f); } catch { /* reconnecting; the hub redelivers */ } },
    run: (c, p) => runHandler(c, p),
    log,
  });
  while (!opts.signal?.aborted) {
    const opened = await new Promise<boolean>((resolve) => {
      const sock = new WebSocket(routerWsUrl(opts.url, host), proto);
      ws = sock;
      let beat: ReturnType<typeof setInterval> | undefined;
      let up = false;
      const stop = (): void => { try { sock.close(1000, "bye"); } catch { /* closed */ } };
      opts.signal?.addEventListener("abort", stop, { once: true });
      sock.onopen = () => {
        up = true;
        lastConnected = Date.now();
        log(`connected as ${host}`);
        beat = setInterval(() => { try { sock.send('{"type":"beat"}'); } catch { /* closing */ } }, 3000);
      };
      sock.onmessage = (ev) => { if (typeof ev.data === "string") void client.frame(ev.data); };
      sock.onclose = (ev) => {
        if (beat) clearInterval(beat);
        opts.signal?.removeEventListener("abort", stop);
        client.role = "connecting";
        log(up ? `disconnected (${ev.code}); reconnecting` : `could not connect (${ev.code}); retrying`);
        resolve(up);
      };
      sock.onerror = () => {};
    });
    if (opts.signal?.aborted) break;
    if (!opened && await tokenRejected(opts.url, opts.token)) log("token rejected by the hub (401): check SLACK_ROUTER_TOKEN / SLACK_ROUTER_TOKEN_FILE against the hub's ROUTER_TOKEN");
    backoff = nextBackoff(backoff, opened, Date.now() - lastConnected);
    await new Promise((r) => setTimeout(r, backoff));
  }
}
