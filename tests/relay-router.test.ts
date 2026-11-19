import { describe, test, expect } from "./harness.ts";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as r from "../worker/src/router.ts";
import { RouterClient, SeenSet, daemonProtocols, nextBackoff, parseHandlers, readToken, routerWsUrl, runHandler, tokenRejected } from "../ts/relayRouter.ts";

class FakeWire implements r.Wire {
  out: [string, r.Frame][] = [];
  closed: [string, number][] = [];
  send(id: string, f: r.Frame): void { this.out.push([id, f]); }
  close(id: string, code: number): void { this.closed.push([id, code]); }
  to(id: string): r.Frame[] { return this.out.filter(([i]) => i === id).map(([, f]) => f); }
  roles(id: string): string[] { return this.to(id).flatMap((f) => (f.type === "role" ? [f.role] : [])); }
  delivered(id: string): string[] { return this.to(id).flatMap((f) => (f.type === "deliver" ? [f.id] : [])); }
  clear(): void { this.out = []; }
}

function setup(opts: { leaseMs?: number; redeliverMs?: number } = {}) {
  const store = new r.MemoryStore();
  const wire = new FakeWire();
  const core = new r.RouterCore(store, wire, opts);
  expect(core.registerOwners(["alpha", "beta"]).ok).toBe(true);
  expect(core.setRoute({ channel: "C00000001", thread_ts: "1700000000.000100", owner: "alpha", topic: "deploy", permalink: "https://acme.slack.com/archives/C00000001/p1700000000000100" }, 0).ok).toBe(true);
  expect(core.setRoute({ channel: "D00000001", owner: "beta" }, 0).ok).toBe(true);
  return { store, wire, core };
}

const ev = (ts: string, thread_ts?: string, channel = "C00000001") => ({
  id: `${channel}:${ts}`, channel, ts, ...(thread_ts ? { thread_ts } : {}), payload: { event: { channel, ts, text: "hi" } },
});

describe("router: owners and routes", () => {
  test("a route to an unknown owner is refused with 422", () => {
    const { core } = setup();
    const res = core.setRoute({ channel: "C00000001", thread_ts: "1700000000.000200", owner: "gamma" }, 0);
    expect(res).toEqual({ ok: false, status: 422, error: "unknown owner: gamma (register it first)" });
  });
  test("bad input is a 400", () => {
    const { core } = setup();
    expect(core.registerOwners([]).ok).toBe(false);
    expect(core.registerOwners(["has space"]).ok).toBe(false);
    expect(core.setRoute({ channel: "nope", owner: "alpha" }, 0)).toMatchObject({ ok: false, status: 400 });
    expect(core.setRoute({ channel: "C00000001", thread_ts: "x", owner: "alpha" }, 0)).toMatchObject({ ok: false, status: 400 });
    expect(core.setRoute({ channel: "C00000001", owner: 5 }, 0)).toMatchObject({ ok: false, status: 400 });
    expect(core.setRoute(null, 0)).toMatchObject({ ok: false, status: 400 });
  });
  test("thread route first, then channel route; unrouted events are not stored", () => {
    const { core, store } = setup();
    expect(core.ownerOf("C00000001", "1700000000.000100", "1700000001.000000")).toBe("alpha");
    expect(core.ownerOf("D00000001", undefined, "1700000001.000000")).toBe("beta");
    expect(core.ingest(ev("1700000002.000000"), 1)).toBe("unrouted");
    expect(store.pending()).toEqual([]);
  });
  test("non-https permalinks are dropped", () => {
    const { core } = setup();
    const res = core.setRoute({ channel: "C00000002", owner: "alpha", permalink: "javascript:alert(1)" }, 0);
    expect(res.ok && res.value?.permalink).toBe("");
  });
});

describe("router: lease and failover", () => {
  test("first client leads, others stand by; only the leader gets deliveries", () => {
    const { core, wire } = setup();
    core.connect("a", "host-a", 0);
    core.connect("b", "host-b", 1);
    expect(wire.roles("a")).toEqual(["leader"]);
    expect(wire.roles("b")).toEqual(["standby"]);
    expect(core.ingest(ev("1700000001.000000", "1700000000.000100"), 2)).toBe("queued");
    expect(wire.delivered("a")).toEqual(["C00000001:1700000001.000000"]);
    expect(wire.delivered("b")).toEqual([]);
  });
  test("leader socket closes: standby promoted and given every unacked message", () => {
    const { core, wire } = setup();
    core.connect("a", "host-a", 0);
    core.connect("b", "host-b", 1);
    core.ingest(ev("1700000001.000000", "1700000000.000100"), 2);
    wire.clear();
    core.disconnect("a", 3);
    expect(core.leaderId()).toBe("b");
    expect(wire.roles("b")).toEqual(["leader"]);
    expect(wire.delivered("b")).toEqual(["C00000001:1700000001.000000"]);
  });
  test("lease lapses without heartbeat: leader closed, next promoted", () => {
    const { core, wire } = setup({ leaseMs: 10_000 });
    core.connect("a", "host-a", 0);
    core.connect("b", "host-b", 0);
    core.message("b", '{"type":"beat"}', 9_000);
    core.tick(9_000);
    expect(core.leaderId()).toBe("a");
    core.message("b", '{"type":"beat"}', 11_000);
    core.tick(11_000);
    expect(wire.closed).toEqual([["a", r.CLOSE_LEASE_LOST]]);
    expect(core.leaderId()).toBe("b");
    expect(core.status()).toMatchObject({ leader: "host-b", clients: [{ host: "host-b", role: "leader" }] });
  });
  test("no clients: messages wait, then go to the first one", () => {
    const { core, wire } = setup();
    core.ingest(ev("1700000001.000000", undefined, "D00000001"), 0);
    core.disconnect("ghost", 0);
    core.connect("a", "host-a", 5);
    expect(wire.delivered("a")).toEqual(["D00000001:1700000001.000000"]);
    expect(wire.to("a")[0]).toMatchObject({ type: "role", role: "leader", leader: "host-a" });
  });
  test("standby disconnecting changes nothing for the leader", () => {
    const { core, wire } = setup();
    core.connect("a", "host-a", 0);
    core.connect("b", "host-b", 1);
    wire.clear();
    core.disconnect("b", 2);
    expect(core.leaderId()).toBe("a");
    expect(wire.out).toEqual([]);
  });
});

describe("router: delivery and de-dup", () => {
  test("a duplicate id is dropped, before and after ack", () => {
    const { core, wire, store } = setup();
    core.connect("a", "host-a", 0);
    const m = ev("1700000001.000000", "1700000000.000100");
    expect(core.ingest(m, 1)).toBe("queued");
    expect(core.ingest(m, 2)).toBe("duplicate");
    core.message("a", JSON.stringify({ type: "ack", id: m.id }), 3);
    expect(store.pending()).toEqual([]);
    expect(core.ingest(m, 4)).toBe("duplicate");
    expect(wire.delivered("a")).toEqual([m.id]);
  });
  test("unacked messages are redelivered after the timeout, acked ones are not", () => {
    const { core, wire } = setup({ redeliverMs: 1000, leaseMs: 100_000 });
    core.connect("a", "host-a", 0);
    core.ingest(ev("1700000001.000000", "1700000000.000100"), 0);
    core.ingest(ev("1700000002.000000", "1700000000.000100"), 0);
    expect(core.ack("a", "C00000001:1700000002.000000", 10)).toBe(true);
    expect(core.ack("nobody", "C00000001:1700000001.000000", 10)).toBe(false);
    core.tick(500);
    expect(wire.delivered("a").length).toBe(2);
    core.tick(1000);
    expect(wire.delivered("a")).toEqual(["C00000001:1700000001.000000", "C00000001:1700000002.000000", "C00000001:1700000001.000000"]);
  });
  test("acked ids are pruned after KEEP_ACKED_MS", () => {
    const { core, store } = setup({ leaseMs: 10 * r.KEEP_ACKED_MS });
    core.connect("a", "host-a", 0);
    const m = ev("1700000001.000000", "1700000000.000100");
    core.ingest(m, 0);
    core.ack("a", m.id, 1);
    core.tick(2 + r.KEEP_ACKED_MS);
    expect(store.msgs.size).toBe(0);
  });
  test("garbage frames are ignored", () => {
    const { core } = setup();
    core.connect("a", "host-a", 0);
    core.message("a", "not json", 1);
    core.message("a", '{"type":"ack"}', 1);
    expect(core.leaderId()).toBe("a");
  });
});

describe("router: daemon handshake auth", () => {
  const T = "tok-1";
  test("the daemon's real subprotocol header is accepted on /router/ws", () => {
    const header = daemonProtocols(T).join(", ");
    expect(r.routerAuthorized("/router/ws", null, header, T)).toBe(true);
  });
  test("refused: wrong token, router protocol elsewhere, relay protocol on /router/ws, no token configured", () => {
    expect(r.routerAuthorized("/router/ws", null, daemonProtocols("tok-2").join(", "), T)).toBe(false);
    expect(r.routerAuthorized("/router/owners", null, daemonProtocols(T).join(", "), T)).toBe(false);
    expect(r.routerAuthorized("/router/ws", null, `slack-hub-relay.v1, ${daemonProtocols(T)[1]}`, T)).toBe(false);
    expect(r.routerAuthorized("/router/ws", null, daemonProtocols(T).join(", "), undefined)).toBe(false);
  });
  test("the relay's /ws auth does not accept the router protocol", async () => {
    const hub = await import("../worker/src/hub.ts");
    expect(hub.protocolAuthorized(daemonProtocols(T).join(", "), T)).toBe(false);
  });
  test("a Bearer header works on every router endpoint", () => {
    expect(r.routerAuthorized("/router/owners", `Bearer ${T}`, null, T)).toBe(true);
    expect(r.routerAuthorized("/router/owners", "Bearer nope", null, T)).toBe(false);
  });
});

describe("routedEvent", () => {
  test("keys a message on channel:ts and keeps the event", () => {
    const p = { type: "event_callback", team_id: "T00000001", event_id: "Ev00000001", event: { type: "message", channel: "C00000001", ts: "1700000001.000000", thread_ts: "1700000000.000100" } };
    expect(r.routedEvent(p)).toEqual({ id: "C00000001:1700000001.000000", channel: "C00000001", ts: "1700000001.000000", thread_ts: "1700000000.000100", payload: { event_id: "Ev00000001", event: p.event } });
    expect(r.routedEvent(p, "T00000002")).toBeNull();
    expect(r.routedEvent({ type: "event_callback", event: { type: "reaction_added" } })).toBeNull();
    expect(r.routedEvent({ type: "event_callback", event: { type: "message", channel: "C00000001", ts: "1", hidden: true } })).toBeNull();
    expect(r.routedEvent(null)).toBeNull();
  });
});

describe("relay daemon client", () => {
  const role = (r: "leader" | "standby", epoch = 1) => JSON.stringify({ type: "role", role: r, leader: "h", epoch, lease_ms: 10_000, heartbeat_ms: 3_000 });
  function client(code = 0, lead = true) {
    const sent: string[] = [];
    const runs: unknown[] = [];
    const logs: string[] = [];
    const clock = { t: 0 };
    const c = new RouterClient(new Map([["alpha", "handle-alpha"], ["*", "handle-any"]]), {
      send: (f) => sent.push(f),
      run: async (cmd, p) => { runs.push([cmd, p]); return code; },
      log: (l) => logs.push(l),
      now: () => clock.t,
    });
    if (lead) void c.frame(role("leader"));
    logs.length = 0;
    return { c, sent, runs, logs, clock };
  }
  const deliver = (id: string, owner = "alpha", epoch = 1) => JSON.stringify({ type: "deliver", id, owner, payload: { n: id }, epoch });

  test("fencing: a delivery after a local lease expiry is refused, not run, not acked", async () => {
    const { c, sent, runs, logs, clock } = client();
    clock.t = 6_000;
    await c.frame(deliver("m1")); // within lease_ms - heartbeat_ms
    clock.t = 6_500;
    await c.frame(JSON.stringify({ type: "lease", epoch: 1, lease_ms: 10_000 }));
    clock.t = 13_000; // 6.5 s since the last confirmation
    await c.frame(deliver("m2"));
    clock.t = 14_000; // paused past 7 s: the buffered delivery is fenced
    await c.frame(deliver("m3"));
    expect(runs.map((r) => (r as [string, { n: string }])[1].n)).toEqual(["m1", "m2"]);
    expect(sent.map((s) => JSON.parse(s).id)).toEqual(["m1", "m2"]);
    expect(logs).toEqual(["m3: refused (lease expired locally)"]);
  });
  test("fencing: an older epoch, or a standby, is refused", async () => {
    const { c, runs, logs } = client();
    await c.frame(role("leader", 3));
    await c.frame(deliver("m1", "alpha", 2));
    await c.frame(JSON.stringify({ type: "lease", epoch: 2, lease_ms: 10_000 })); // stale lease: ignored
    expect(c.epoch).toBe(3);
    await c.frame(role("standby", 4));
    await c.frame(deliver("m2", "alpha", 4));
    expect(runs).toEqual([]);
    expect(logs.filter((l) => l.includes("refused"))).toEqual(["m1: refused (stale epoch 2 < 3)", "m2: refused (not the leader)"]);
  });
  test("SIGSTOP scenario end to end: old leader wakes to a buffered delivery and does not handle it", async () => {
    const { core, wire } = setup({ leaseMs: 10_000 });
    core.connect("a", "host-a", 0);
    core.connect("b", "host-b", 0);
    const A = client(0, false);
    const B = client(0, false);
    for (const f of wire.to("a")) await A.c.frame(JSON.stringify(f));
    for (const f of wire.to("b")) await B.c.frame(JSON.stringify(f));
    wire.clear();
    // A stops at t=0. A message arrives; its deliver frame sits in A's socket buffer.
    core.ingest(ev("1700000001.000000", "1700000000.000100"), 1_000);
    const buffered = wire.to("a").map((f) => JSON.stringify(f));
    core.message("b", '{"type":"beat"}', 11_000);
    core.tick(11_000); // lease lapsed: B promoted and handed the message
    expect(core.leaderId()).toBe("b");
    B.clock.t = 11_000;
    for (const f of wire.to("b")) await B.c.frame(JSON.stringify(f));
    expect(B.runs.length).toBe(1);
    // A resumes and reads its buffer before the 4011 close.
    A.clock.t = 12_000;
    for (const f of buffered) await A.c.frame(f);
    expect(A.runs).toEqual([]);
    expect(A.sent).toEqual([]);
  });
  test("the hub confirms a leader's heartbeat, not a standby's; epoch bumps on promotion", () => {
    const { core, wire } = setup();
    core.connect("a", "host-a", 0);
    core.connect("b", "host-b", 0);
    expect(core.leaderEpoch()).toBe(1);
    wire.clear();
    core.message("a", '{"type":"beat"}', 1);
    core.message("b", '{"type":"beat"}', 1);
    expect(wire.out).toEqual([["a", { type: "lease", epoch: 1, lease_ms: r.LEASE_MS }]]);
    core.disconnect("a", 2);
    expect(core.leaderEpoch()).toBe(2);
    expect(wire.to("b").at(-1)).toMatchObject({ type: "role", role: "leader", epoch: 2 });
  });
  test("runHandler hides the token and the token file from the handler", async () => {
    const env = { ...process.env, SLACK_ROUTER_TOKEN: "t", SLACK_ROUTER_TOKEN_FILE: "/x" };
    expect(await runHandler('test -z "${SLACK_ROUTER_TOKEN}${SLACK_ROUTER_TOKEN_FILE}"', {}, env)).toBe(0);
  });
  test("backoff: 1 s after a session, capped at 5 s if recently connected, 30 s otherwise", () => {
    expect(nextBackoff(16_000, true, 0)).toBe(1000);
    expect(nextBackoff(4_000, false, 60_000)).toBe(5_000);
    expect(nextBackoff(16_000, false, Infinity)).toBe(30_000);
    expect(nextBackoff(1_000, false, Infinity)).toBe(2_000);
  });
  test("tokenRejected: true on 401 only", async () => {
    const f = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await tokenRejected("https://hub.example.com", "t", f(401))).toBe(true);
    expect(await tokenRejected("https://hub.example.com", "t", f(200))).toBe(false);
    expect(await tokenRejected("https://hub.example.com", "t", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBe(false);
  });

  test("runs the handler once and acks; a redelivery is acked without rerunning", async () => {
    const { c, sent, runs } = client();
    expect(c.role).toBe("leader");
    await c.frame(deliver("m1"));
    await c.frame(deliver("m1"));
    await c.frame(deliver("m2", "other"));
    expect(runs).toEqual([["handle-alpha", { n: "m1" }], ["handle-any", { n: "m2" }]]);
    expect(sent.map((s) => JSON.parse(s).id)).toEqual(["m1", "m1", "m2"]);
  });
  test("a concurrent duplicate is not run twice", async () => {
    const { c, runs } = client();
    await Promise.all([c.frame(deliver("m1")), c.frame(deliver("m1"))]);
    expect(runs.length).toBe(1);
  });
  test("non-zero exit leaves it unacked", async () => {
    const { c, sent, logs } = client(3);
    await c.frame(deliver("m1"));
    expect(sent).toEqual([]);
    expect(logs[0]).toContain("exited 3");
    expect(c.seen.has("m1")).toBe(false);
  });
  test("no handler for an owner: logged, unacked", async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const c = new RouterClient(new Map(), { send: (f) => sent.push(f), run: async () => 0, log: (l) => logs.push(l), now: () => 0 });
    await c.frame(role("leader"));
    logs.length = 0;
    await c.frame(deliver("m1"));
    await c.frame("junk");
    await c.frame(JSON.stringify({ type: "role", role: "standby", leader: null }));
    expect(sent).toEqual([]);
    expect(logs).toEqual(["m1: no handler for owner alpha; left unacked", "standby (leader: none)"]);
  });
  test("SeenSet is bounded", () => {
    const s = new SeenSet(2);
    s.add("a"); s.add("b"); s.add("c");
    expect([s.has("a"), s.has("b"), s.has("c"), s.size]).toEqual([false, true, true, 2]);
  });
  test("parseHandlers and routerWsUrl", () => {
    expect(parseHandlers(["a=cat", "*=x=y"])).toEqual({ handlers: new Map([["a", "cat"], ["*", "x=y"]]) });
    expect("error" in parseHandlers(["=cat"])).toBe(true);
    expect(routerWsUrl("https://hub.example.com", "h1")).toBe("wss://hub.example.com/router/ws?host=h1");
    expect(routerWsUrl("http://localhost:8787", "h1")).toBe("ws://localhost:8787/router/ws?host=h1");
  });
  test("readToken: env, 0600 file, refuses a group-readable file, never echoes the token", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-token-"));
    const f = join(dir, "t");
    writeFileSync(f, "s3cret\n");
    chmodSync(f, 0o600);
    expect(readToken({ SLACK_ROUTER_TOKEN: "x" })).toEqual({ token: "x" });
    expect(readToken({ SLACK_ROUTER_TOKEN_FILE: f })).toEqual({ token: "s3cret" });
    expect("error" in readToken({})).toBe(true);
    expect("error" in readToken({ SLACK_ROUTER_TOKEN_FILE: join(dir, "missing") })).toBe(true);
    if (process.platform !== "win32") {
      chmodSync(f, 0o644);
      const res = readToken({ SLACK_ROUTER_TOKEN_FILE: f });
      expect("error" in res && !res.error.includes("s3cret")).toBe(true);
    }
  });
  test("runHandler pipes the payload to stdin and returns the exit code", async () => {
    expect(await runHandler('test "$(cat)" = \'{"a":1}\'', { a: 1 })).toBe(0);
    expect(await runHandler("exit 4", {})).toBe(4);
  });
});
