# Relay router

The relay router gets Slack events (DMs, thread replies) to the process that
**owns** a thread, even when one of the machines relaying them is slow or down.
It is part of the relay Worker in [`worker/`](../worker/README.md): a second
Durable Object, `Router`, next to the doorbell `Relay`.

```
Slack ──POST /slack/events──▶ Worker ──▶ Router (Durable Object, SQLite)
                                           │ routes: (channel, thread_ts) → owner
                                           │ log:    id → {owner, payload} until acked
              ┌──── GET /router/ws ────────┤ lease: one leader, the rest standby
 host A: slack relay daemon (leader)  ◀────┘ deliver {id, owner, payload}
 host B: slack relay daemon (standby)        ack {id}
```

## Model

- **Owners** are names (`[A-Za-z0-9._-]{1,64}`) registered first with
  `POST /router/owners`. A route to an owner that is not registered is refused
  with **422**.
- **Routes** map `(channel, thread_ts)` to an owner, with a `topic` and a
  `permalink` for display. `thread_ts` may be empty: the route then covers the
  whole channel, which is how a DM (`D…`) reaches its owner. A message looks up
  its thread's route first, then its channel's. Messages that match no route are
  **not stored**.
- **Message log.** Each routed message gets the id `channel:ts` (a message and
  its `app_mention` twin share it). It is stored until acked; the same id again
  (a Slack retry) is a duplicate and is dropped. On ack the payload is deleted;
  the id is kept for an hour so late retries still de-dup.
- **Leader election.** The first daemon to connect gets a lease (10 s), renewed
  by its heartbeat (every 3 s). Every other daemon is a hot standby. When the
  leader's socket closes, or its lease lapses (it is then closed with code
  4011 and reconnects as a standby), the oldest standby is promoted, and every
  daemon is told its role (`{"type":"role"}`) at once — within ~1 s of a close,
  within lease + 1 s of a hang.
- **Delivery, at least once.** Only the leader receives
  `{"type":"deliver","id","owner","payload"}`. The daemon runs the owner's
  handler with the payload (`{event_id, event}`) as JSON on stdin and sends
  `{"type":"ack","id"}` when it exits 0. Unacked messages are redelivered after
  60 s, and all of them go to a newly promoted leader. Each daemon keeps the
  last 2000 handled ids, so a redelivery whose ack was lost is acked again
  without running the handler twice.
- **Fencing (lease epoch).** A leader that is *paused* rather than dead — a
  SIGSTOP, a long GC stall, a CPU-starved or swapping host, a laptop lid — can
  wake up after the hub has promoted a standby and handed it the same message,
  and still find the old delivery in its socket buffer, ahead of the 4011
  close. To stop it handling that message a second time:
  - the hub counts promotions (`epoch`) and stamps it on every `role`,
    `deliver` and `lease` frame;
  - the hub answers each heartbeat from the leader with
    `{"type":"lease","epoch","lease_ms"}`, so the daemon has its own clock: the
    local time of the last confirmed renewal;
  - the daemon refuses a delivery (does not run it, does not ack it) when it is
    not the leader, when the delivery's epoch is older than the newest it has
    seen, or when more than `lease_ms − heartbeat_ms` has passed since its last
    confirmed renewal. That window ends before the hub's lease does (the hub
    counts from the heartbeat's arrival, the daemon from the later
    confirmation), so a paused leader stops before its successor starts.
  The new leader gets every unacked message, so a refused delivery is not lost.
- **What fencing does not cover.** A leader that crashes, or is paused
  *while its handler runs*, after the handler acted but before the ack
  reaches the hub, will see the message redelivered to the next leader.
  Delivery is at least once: handlers must be idempotent on `event_id` /
  `event.ts`.

Unlike the doorbell relay (ids and timestamps only), the router stores the
Slack event of a routed message until it is acked, because the owner may not
be able to read the channel itself.

## Deploy

The `ROUTER` binding and its `v2` migration are already in
`worker/wrangler.jsonc`. From `worker/`:

```sh
npx --yes wrangler@4.105.0 deploy
wrangler secret put ROUTER_TOKEN    # optional: a separate long random token; default RELAY_TOKEN
wrangler secret put ROUTES_PUBLIC   # optional: "1" lets GET /routes be read without a token
```

The Slack app's Event Subscriptions must include `message.im` (DMs) and the
`message.*` events for the channels whose threads you route. A Worker without
the `ROUTER` binding (for example one scaffolded by `slack relay init` before
this feature) simply has the router off.

## Endpoints

All take `Authorization: Bearer <token>` (the WebSocket may carry it as the
subprotocol `bearer.<base64url(token)>`).

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/router/owners` | `{"owners":["alpha","beta"]}` → the full owner list |
| POST | `/router/routes` | `{"channel","thread_ts"?,"owner","topic"?,"permalink"?}`; 422 if the owner is unknown |
| GET | `/routes` | `{"routes":[{channel, thread_ts, owner, topic, permalink, updated}]}` — read-only, for a status page |
| GET | `/router/status` | leader host, connected daemons and roles, pending count |
| GET | `/router/ws?host=<name>` | the daemon socket |

## Run daemons

On each host (any number; one leads):

```sh
export SLACK_ROUTER_URL=https://<your-worker>.workers.dev
# token: from the environment (e.g. a systemd EnvironmentFile) or a file only you can read
export SLACK_ROUTER_TOKEN_FILE=~/.config/slack-hub/router-token   # chmod 600; a group/other-readable file is refused
slack relay daemon --handler alpha='my-agent --inbox alpha' --handler '*=logger -t router'
```

The token is never taken from argv and never printed; neither it nor
`SLACK_ROUTER_TOKEN_FILE` is passed on to handlers. The daemon reconnects at
once-ish (1 s) after a session ends; failed handshakes back off by doubling,
capped at 5 s if it was connected in the last 5 minutes (a hub restart) and
30 s otherwise. When a handshake fails it checks the token against
`/router/status` and logs `token rejected by the hub (401)` if that is the
cause. The WebSocket offers the subprotocol `slack-hub-router.v1` (the
doorbell relay's `/ws` and the router's `/router/ws` each accept only their
own).

## Not done yet

- **Rust parity**: `slack relay daemon` exists in the TS CLI only.
- **WebRTC**: daemons could exchange deliveries peer to peer (data channels,
  the hub only signalling) to survive a hub outage. Out of scope; WebSocket to
  the hub is the only transport.
- Removing routes, and expiring old ones, are not implemented.
