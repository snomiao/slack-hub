// The relay router's Durable Object: SQLite for owners, routes and the message
// log; hibernatable WebSockets for the relay daemons; an alarm for the lease
// and redelivery clock. All decisions are in router.ts (RouterCore).
//
// Unlike the doorbell relay, this object stores message payloads (the Slack
// event of a routed message), because the owner may not be able to read the
// channel itself. Only messages that match a route are stored, and an acked
// message's payload is deleted at once; its id is kept KEEP_ACKED_MS for de-dup.

import { DurableObject } from "cloudflare:workers";
import * as r from "./router.ts";

type Att = { id: string; host: string; since: number };
const TICK_MS = 1_000;

export class Router extends DurableObject {
  private core: r.RouterCore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS owners (name TEXT PRIMARY KEY)");
    sql.exec(`CREATE TABLE IF NOT EXISTS routes (channel TEXT NOT NULL, thread_ts TEXT NOT NULL, owner TEXT NOT NULL,
      topic TEXT NOT NULL, permalink TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (channel, thread_ts))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT,
      at INTEGER NOT NULL, acked INTEGER)`);
    const store: r.RouterStore = {
      hasOwner: (n) => sql.exec("SELECT 1 FROM owners WHERE name = ?", n).toArray().length > 0,
      addOwners: (ns) => { for (const n of ns) sql.exec("INSERT OR IGNORE INTO owners (name) VALUES (?)", n); },
      owners: () => sql.exec<{ name: string }>("SELECT name FROM owners ORDER BY name").toArray().map((o) => o.name),
      route: (c, t) => sql.exec<r.Route>("SELECT * FROM routes WHERE channel = ? AND thread_ts = ?", c, t).toArray()[0] ?? null,
      setRoute: (x) => {
        sql.exec("INSERT OR REPLACE INTO routes (channel, thread_ts, owner, topic, permalink, updated) VALUES (?, ?, ?, ?, ?, ?)",
          x.channel, x.thread_ts, x.owner, x.topic, x.permalink, x.updated);
      },
      routes: () => sql.exec<r.Route>("SELECT * FROM routes ORDER BY updated DESC").toArray(),
      addMessage: (m) => sql.exec("INSERT OR IGNORE INTO messages (id, owner, payload, at) VALUES (?, ?, ?, ?) RETURNING id",
        m.id, m.owner, JSON.stringify(m.payload), m.at).toArray().length > 0,
      ackMessage: (id, now) => sql.exec("UPDATE messages SET acked = ?, payload = NULL WHERE id = ? AND acked IS NULL RETURNING id",
        now, id).toArray().length > 0,
      pending: () => sql.exec<{ id: string; owner: string; payload: string; at: number }>(
        "SELECT id, owner, payload, at FROM messages WHERE acked IS NULL ORDER BY at").toArray()
        .map((m) => ({ ...m, payload: JSON.parse(m.payload) as unknown })),
      prune: (before) => { sql.exec("DELETE FROM messages WHERE acked IS NOT NULL AND acked < ?", before); },
    };
    const wire: r.Wire = {
      send: (id, f) => { for (const ws of ctx.getWebSockets(id)) try { ws.send(JSON.stringify(f)); } catch { /* closing */ } },
      close: (id, code, reason) => { for (const ws of ctx.getWebSockets(id)) try { ws.close(code, reason); } catch { /* closed */ } },
    };
    this.core = new r.RouterCore(store, wire);
    // Woken from hibernation or restarted: the sockets survived, the memory did
    // not. Re-admit them oldest first; the oldest becomes leader again.
    const now = Date.now();
    const atts = ctx.getWebSockets().map((ws) => ws.deserializeAttachment() as Att | null).filter((a): a is Att => !!a);
    for (const a of atts.sort((x, y) => x.since - y.since)) this.core.connect(a.id, a.host, now);
  }

  async ingest(m: NonNullable<ReturnType<typeof r.routedEvent>>): Promise<string> {
    const res = this.core.ingest(m, Date.now());
    await this.arm();
    return res;
  }

  async owners(body: unknown): Promise<Response> { return reply(this.core.registerOwners(body)); }
  async putRoute(body: unknown): Promise<Response> { return reply(this.core.setRoute(body, Date.now())); }
  async routes(): Promise<r.Route[]> { return this.ctx.storage.sql.exec<r.Route>("SELECT * FROM routes ORDER BY updated DESC").toArray(); }
  async status(): Promise<ReturnType<r.RouterCore["status"]>> { return this.core.status(); }

  override async fetch(req: Request): Promise<Response> {
    const host = (new URL(req.url).searchParams.get("host") ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "anonymous";
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    const att: Att = { id: crypto.randomUUID(), host, since: Date.now() };
    this.ctx.acceptWebSocket(server, [att.id]);
    server.serializeAttachment(att);
    this.core.connect(att.id, host, att.since);
    await this.arm();
    const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
    return new Response(null, { status: 101, webSocket: client, headers: offered.includes(r.PROTOCOL) ? { "sec-websocket-protocol": r.PROTOCOL } : {} });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Att | null;
    if (a && typeof data === "string") this.core.message(a.id, data, Date.now());
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.gone(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* already closed */ }
  }

  override async webSocketError(ws: WebSocket): Promise<void> { this.gone(ws); }

  override async alarm(): Promise<void> {
    this.core.tick(Date.now());
    await this.arm();
  }

  private gone(ws: WebSocket): void {
    const a = ws.deserializeAttachment() as Att | null;
    if (a) this.core.disconnect(a.id, Date.now());
  }

  /** Keep the clock running while any daemon is connected or anything is unacked. */
  private async arm(): Promise<void> {
    if (!this.core.connections().length && !this.core.status().pending) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }
}

function reply<T>(res: r.Result<T>): Response {
  return res.ok ? Response.json({ ok: true, result: res.value }) : Response.json({ ok: false, error: res.error }, { status: res.status });
}
