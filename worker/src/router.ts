// The relay router's state machine, as pure logic: no Cloudflare types, so the
// CLI's test suite drives it under bun with fake sockets and an in-memory store
// (tests/relay-router.test.ts). routerDo.ts adapts a Durable Object to it.
//
// What it does:
//   - routing table: (channel, thread ts) -> owner, with topic + permalink.
//     A route may also name a whole channel (thread ts ""), which is how a DM
//     reaches its owner. Owners are registered first; a route to an unknown
//     owner is refused.
//   - message log: every routed Slack event gets an id (Slack's event_id, else
//     channel:ts). It is stored until a client acks it; the same id arriving
//     again (a Slack retry) is a duplicate and is dropped.
//   - leader election: of the connected relay daemons, one holds a lease
//     (LEASE_MS, renewed by its heartbeat); the rest are hot standby. The
//     leader's socket closing, or its lease lapsing, promotes the oldest
//     standby, and every daemon is told its new role at once.
//   - delivery, at least once: only the leader receives {id, owner, payload}.
//     A message not acked within REDELIVER_MS is sent again; on a leader change
//     every unacked message goes to the new leader.

import { protocolAuthorized } from "./hub.ts";
import { safeEqual } from "./slack.ts";

export const PROTOCOL = "slack-hub-router.v1";
export const LEASE_MS = 10_000;
export const HEARTBEAT_MS = 3_000;
export const REDELIVER_MS = 60_000;
/** Acked ids are remembered this long so a late Slack retry is still a duplicate. */
export const KEEP_ACKED_MS = 3_600_000;
/** Close code for a leader whose lease lapsed: it reconnects as a standby. */
export const CLOSE_LEASE_LOST = 4011;
export const MAX_OWNERS = 256;
export const MAX_ROUTES = 10_000;

const OWNER = /^[A-Za-z0-9._-]{1,64}$/;
const CHANNEL = /^[CDG][A-Z0-9]{2,}$/;
const TS = /^\d{1,12}\.\d{1,8}$/;

export type Route = { channel: string; thread_ts: string; owner: string; topic: string; permalink: string; updated: number };
export type Message = { id: string; owner: string; payload: unknown; at: number };

export interface RouterStore {
  hasOwner(name: string): boolean;
  addOwners(names: string[]): void;
  owners(): string[];
  route(channel: string, thread_ts: string): Route | null;
  setRoute(r: Route): void;
  routes(): Route[];
  /** Insert unless the id is known (pending or acked); false = duplicate. */
  addMessage(m: Message): boolean;
  /** Mark acked; false if the id is unknown or already acked. */
  ackMessage(id: string, now: number): boolean;
  pending(): Message[];
  /** Forget acked ids older than `before`. */
  prune(before: number): void;
}

/** One connected relay daemon. `since` orders the standby queue. */
export type Conn = { id: string; host: string; since: number; lastBeat: number };

export type Frame =
  | { type: "role"; role: "leader" | "standby"; leader: string | null; epoch: number; lease_ms: number; heartbeat_ms: number }
  /** The hub's answer to the leader's heartbeat: its lease runs lease_ms from now. */
  | { type: "lease"; epoch: number; lease_ms: number }
  | { type: "deliver"; id: string; owner: string; payload: unknown; epoch: number };

export interface Wire {
  send(connId: string, f: Frame): void;
  close(connId: string, code: number, reason: string): void;
}

export type Result<T = undefined> = { ok: true; value?: T } | { ok: false; status: number; error: string };

export class RouterCore {
  private conns = new Map<string, Conn>();
  private leader: string | null = null;
  /** Bumped on every promotion; stamped on role, lease and deliver frames, so a
   *  daemon can tell a delivery meant for a leadership that has since ended. */
  private epoch = 0;
  /** id -> when it was last sent to the leader. */
  private inflight = new Map<string, number>();

  constructor(
    private readonly store: RouterStore,
    private readonly wire: Wire,
    private readonly opts: { leaseMs?: number; redeliverMs?: number } = {},
  ) {}

  private get leaseMs(): number { return this.opts.leaseMs ?? LEASE_MS; }
  private get redeliverMs(): number { return this.opts.redeliverMs ?? REDELIVER_MS; }

  leaderId(): string | null { return this.leader; }
  leaderEpoch(): number { return this.epoch; }
  connections(): Conn[] { return [...this.conns.values()].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1)); }

  // ---- owners and routes ----

  registerOwners(names: unknown): Result<string[]> {
    if (!Array.isArray(names) || !names.length) return { ok: false, status: 400, error: "owners must be a non-empty array" };
    const bad = names.filter((n) => typeof n !== "string" || !OWNER.test(n));
    if (bad.length) return { ok: false, status: 400, error: `bad owner name: ${String(bad[0])}` };
    const all = new Set([...this.store.owners(), ...(names as string[])]);
    if (all.size > MAX_OWNERS) return { ok: false, status: 413, error: `at most ${MAX_OWNERS} owners` };
    this.store.addOwners(names as string[]);
    return { ok: true, value: this.store.owners() };
  }

  setRoute(body: unknown, now: number): Result<Route> {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const { channel, owner } = b;
    const thread_ts = b.thread_ts ?? "";
    if (typeof channel !== "string" || !CHANNEL.test(channel)) return { ok: false, status: 400, error: "bad channel" };
    if (typeof thread_ts !== "string" || (thread_ts !== "" && !TS.test(thread_ts))) return { ok: false, status: 400, error: "bad thread_ts" };
    if (typeof owner !== "string" || !OWNER.test(owner)) return { ok: false, status: 400, error: "bad owner" };
    if (!this.store.hasOwner(owner)) return { ok: false, status: 422, error: `unknown owner: ${owner} (register it first)` };
    const topic = typeof b.topic === "string" ? b.topic.slice(0, 200) : "";
    const permalink = typeof b.permalink === "string" && /^https:\/\//.test(b.permalink) ? b.permalink.slice(0, 500) : "";
    if (!this.store.route(channel, thread_ts) && this.store.routes().length >= MAX_ROUTES) {
      return { ok: false, status: 413, error: `at most ${MAX_ROUTES} routes` };
    }
    const r: Route = { channel, thread_ts, owner, topic, permalink, updated: now };
    this.store.setRoute(r);
    return { ok: true, value: r };
  }

  /** The owner of a message: its thread's route, else its channel's. */
  ownerOf(channel: string, thread_ts: string | undefined, ts: string): string | null {
    return (this.store.route(channel, thread_ts ?? ts) ?? this.store.route(channel, ""))?.owner ?? null;
  }

  // ---- connections and the lease ----

  connect(id: string, host: string, now: number): void {
    this.conns.set(id, { id, host, since: now, lastBeat: now });
    if (this.leader === null) this.elect(now);
    else this.tell(id);
  }

  heartbeat(id: string, now: number): void {
    const c = this.conns.get(id);
    if (!c) return;
    c.lastBeat = now;
    // Confirm the renewal: the daemon's clock for "is my lease still valid".
    if (id === this.leader) this.wire.send(id, { type: "lease", epoch: this.epoch, lease_ms: this.leaseMs });
  }

  disconnect(id: string, now: number): void {
    if (!this.conns.delete(id)) return;
    if (this.leader === id) {
      this.leader = null;
      this.elect(now);
    }
  }

  /** Lease and redelivery clock; the Durable Object calls it from an alarm. */
  tick(now: number): void {
    // A standby that stopped beating is gone too (its socket may not have closed yet).
    for (const c of [...this.conns.values()]) {
      if (now - c.lastBeat <= this.leaseMs) continue;
      this.conns.delete(c.id);
      this.wire.close(c.id, CLOSE_LEASE_LOST, "lease lapsed");
      if (this.leader === c.id) this.leader = null;
    }
    if (this.leader === null) this.elect(now);
    else this.redeliver(now, false);
    this.store.prune(now - KEEP_ACKED_MS);
  }

  private elect(now: number): void {
    this.leader = this.connections()[0]?.id ?? null;
    if (this.leader !== null) this.epoch++;
    this.inflight.clear();
    for (const c of this.conns.values()) this.tell(c.id);
    if (this.leader !== null) this.redeliver(now, true);
  }

  private tell(id: string): void {
    const leader = this.leader === null ? null : this.conns.get(this.leader)?.host ?? null;
    this.wire.send(id, { type: "role", role: id === this.leader ? "leader" : "standby", leader, epoch: this.epoch, lease_ms: this.leaseMs, heartbeat_ms: HEARTBEAT_MS });
  }

  // ---- messages ----

  /** Store a routed event and hand it to the leader. */
  ingest(m: { id: string; channel: string; ts: string; thread_ts?: string; payload: unknown }, now: number): "queued" | "duplicate" | "unrouted" {
    const owner = this.ownerOf(m.channel, m.thread_ts, m.ts);
    if (owner === null) return "unrouted";
    const msg: Message = { id: m.id, owner, payload: m.payload, at: now };
    if (!this.store.addMessage(msg)) return "duplicate";
    if (this.leader !== null) this.push(msg, now);
    return "queued";
  }

  ack(connId: string, id: string, now: number): boolean {
    // Acks from any daemon count: a demoted leader finishing its handler is still a delivery.
    const c = this.conns.get(connId);
    if (!c) return false;
    c.lastBeat = now;
    this.inflight.delete(id);
    return this.store.ackMessage(id, now);
  }

  private redeliver(now: number, all: boolean): void {
    for (const m of this.store.pending()) {
      const sent = this.inflight.get(m.id);
      if (all || sent === undefined || now - sent >= this.redeliverMs) this.push(m, now);
    }
  }

  private push(m: Message, now: number): void {
    if (this.leader === null) return;
    this.inflight.set(m.id, now);
    this.wire.send(this.leader, { type: "deliver", id: m.id, owner: m.owner, payload: m.payload, epoch: this.epoch });
  }

  /** A client frame (JSON text). Unknown frames are ignored. */
  message(connId: string, data: string, now: number): void {
    let f: { type?: unknown; id?: unknown };
    try { f = JSON.parse(data) as typeof f; } catch { return; }
    if (f.type === "beat") this.heartbeat(connId, now);
    else if (f.type === "ack" && typeof f.id === "string") this.ack(connId, f.id, now);
  }

  status(): { leader: string | null; clients: { host: string; role: string; since: number }[]; pending: number } {
    return {
      leader: this.leader === null ? null : this.conns.get(this.leader)?.host ?? null,
      clients: this.connections().map((c) => ({ host: c.host, role: c.id === this.leader ? "leader" : "standby", since: c.since })),
      pending: this.store.pending().length,
    };
  }
}

/** May this request use the router's token-protected endpoints? An
 *  `Authorization: Bearer` header anywhere; on /router/ws also the router
 *  subprotocol plus `bearer.<base64url(token)>` (only the router's protocol:
 *  the doorbell relay's /ws does not accept it, nor this one theirs). */
export function routerAuthorized(path: string, authorization: string | null, subprotocols: string | null, token: string | undefined): boolean {
  if (!token) return false;
  if (safeEqual(authorization ?? "", `Bearer ${token}`)) return true;
  return path === "/router/ws" && protocolAuthorized(subprotocols, token, [PROTOCOL]);
}

/** The message id and route key of a Slack Events API payload, or null if it is
 *  not a message the router delivers (message / app_mention in a channel, DM or
 *  thread). The payload delivered is the inner `event` plus `event_id`. */
export function routedEvent(payload: unknown, teamId?: string): { id: string; channel: string; ts: string; thread_ts?: string; payload: unknown } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { type?: unknown; team_id?: unknown; event_id?: unknown; event?: Record<string, unknown> };
  if (p.type !== "event_callback" || !p.event || typeof p.event !== "object") return null;
  if (teamId && p.team_id !== teamId) return null;
  const e = p.event;
  if (e.type !== "message" && e.type !== "app_mention") return null;
  if (e.hidden === true) return null;
  const { channel, ts, thread_ts } = e;
  if (typeof channel !== "string" || !CHANNEL.test(channel) || typeof ts !== "string" || !TS.test(ts)) return null;
  // A message and its app_mention twin carry different event_ids: key on the
  // message itself so the owner hears it once.
  const id = `${channel}:${ts}`;
  return {
    id, channel, ts,
    ...(typeof thread_ts === "string" && TS.test(thread_ts) ? { thread_ts } : {}),
    payload: { ...(typeof p.event_id === "string" ? { event_id: p.event_id } : {}), event: e },
  };
}

/** An in-memory store, for tests and for reference. */
export class MemoryStore implements RouterStore {
  ownerSet = new Set<string>();
  routeMap = new Map<string, Route>();
  msgs = new Map<string, Message & { acked: number | null }>();
  hasOwner(n: string): boolean { return this.ownerSet.has(n); }
  addOwners(ns: string[]): void { for (const n of ns) this.ownerSet.add(n); }
  owners(): string[] { return [...this.ownerSet].sort(); }
  route(c: string, t: string): Route | null { return this.routeMap.get(`${c}:${t}`) ?? null; }
  setRoute(r: Route): void { this.routeMap.set(`${r.channel}:${r.thread_ts}`, r); }
  routes(): Route[] { return [...this.routeMap.values()]; }
  addMessage(m: Message): boolean {
    if (this.msgs.has(m.id)) return false;
    this.msgs.set(m.id, { ...m, acked: null });
    return true;
  }
  ackMessage(id: string, now: number): boolean {
    const m = this.msgs.get(id);
    if (!m || m.acked !== null) return false;
    m.acked = now;
    return true;
  }
  pending(): Message[] {
    return [...this.msgs.values()].filter((m) => m.acked === null).map(({ acked: _, ...m }) => m);
  }
  prune(before: number): void {
    for (const [id, m] of this.msgs) if (m.acked !== null && m.acked < before) this.msgs.delete(id);
  }
}
