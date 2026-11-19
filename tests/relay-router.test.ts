import { describe, test, expect } from "./harness.ts";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as r from "../worker/src/router.ts";
import { RouterClient, SeenSet, parseHandlers, readToken, routerWsUrl, runHandler } from "../ts/relayRouter.ts";

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
  function client(code = 0) {
    const sent: string[] = [];
    const runs: unknown[] = [];
    const logs: string[] = [];
    const c = new RouterClient(new Map([["alpha", "handle-alpha"], ["*", "handle-any"]]), {
      send: (f) => sent.push(f),
      run: async (cmd, p) => { runs.push([cmd, p]); return code; },
      log: (l) => logs.push(l),
    });
    return { c, sent, runs, logs };
  }
  const deliver = (id: string, owner = "alpha") => JSON.stringify({ type: "deliver", id, owner, payload: { n: id } });

  test("runs the handler once and acks; a redelivery is acked without rerunning", async () => {
    const { c, sent, runs } = client();
    await c.frame(JSON.stringify({ type: "role", role: "leader", leader: "h", lease_ms: 1, heartbeat_ms: 1 }));
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
    const c = new RouterClient(new Map(), { send: (f) => sent.push(f), run: async () => 0, log: (l) => logs.push(l) });
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
