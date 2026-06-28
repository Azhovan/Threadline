# Threadline

Threadline lets two terminal agents talk to each other over a local WebSocket.
One agent sends a message; the other **wakes up**, reads it, replies, and goes
back to sleep — no polling, no persistent listener.

```
 Terminal A                  relay (one process)              Terminal B
 ┌──────────┐          ┌────────────────────────┐          ┌──────────┐
 │ Agent A  │  send.js │  ws://127.0.0.1:9000    │  send.js │ Agent B  │
 │          ├─────────►│  broadcasts + backlog   │◄─────────┤          │
 │          │  wait.js │                         │  wait.js │          │
 │  inbox ◄─┤◄─────────┤                         ├─────────►├─► inbox  │
 └──────────┘          └────────────────────────┘          └──────────┘
```

## How it works

Two ideas carry the whole design.

**Wake on message.** An agent runs in *turns*, not as a long-lived listener, so
the actual waiting is delegated to `wait.js` — a short-lived background process:

1. It connects, replays anything newer than the last message this agent saw,
   then **blocks until a fresh message arrives**.
2. On arrival it appends to `inbox.<name>.md`, advances the cursor in
   `.seq.<name>`, and **exits**.
3. That exit re-invokes the agent → it reads its inbox, replies with `send.js`,
   and relaunches `wait.js`. Loop.

The agent only spends a turn when there's something to read.

**A standing relay, agents anywhere.** The relay is a background service you
start once. After that, *any* local process — in any terminal, any directory,
even outside this repo — can join the channel by pointing at the same relay URL.
Agents share nothing else: each one writes its inbox to its **own** working
directory (or to `COMM_DIR` if set), so an agent in `~/work/foo` reads from
`~/work/foo/inbox.<name>.md`.

## Requirements

Node.js (current LTS) and npm. The only runtime dependency is
[`ws`](https://www.npmjs.com/package/ws), installed in the next step.

## Quickstart

The `Makefile` wraps everything. From the repo directory:

```bash
make install     # one-time: install the `ws` dependency
make start       # start the standing relay in the background
make status      # confirm it's running
```

Then, in **each agent's terminal** (anywhere on the machine):

```bash
export RELAY_URL=ws://127.0.0.1:9000     # all agents must use the same URL

make send   FROM=A TEXT="hello B"        # send a message
make listen FROM=A                       # block until a message arrives, then exit
make done   FROM=A TEXT="bye"            # send a final message and end the convo
```

When you're finished with the channel:

```bash
make stop        # stop the standing relay
```

To see it work without wiring up two real agents, run `make demo` — it starts
its own relay and plays two mock agents through a full exchange.

## The agent loop

With the relay running, each agent terminal repeats the same cycle:

1. Run `node wait.js --from <me>` in the **background**.
2. When it exits → read the new entries in `inbox.<me>.md`.
3. If the exit code was **3** (`DONE`) → stop. Otherwise decide on a reply and
   `node send.js --from <me> --text "..."`.
4. Go to 1.

The exit code in step 2 is the whole control signal — see the next section.

## Ending a conversation

Two agents left to free-run will ping-pong forever, and each reply costs a turn.
To stop cleanly, send the final message with `--done`:

```bash
node send.js --from A --text "we're aligned, wrapping up" --done
```

The peer's `wait.js` tags the message `[DONE]` in the inbox and **exits with
code 3** instead of 0. That non-zero code means *read the final message, but do
not relaunch the listener*. `--done` is an explicit flag, not the literal word
"done", so the word can appear in normal chat without ending anything.

The full set of waiter exit codes:

| exit code | meaning                   | what the agent should do                |
|-----------|---------------------------|-----------------------------------------|
| `0`       | new message(s) arrived    | read inbox, reply, relaunch `wait.js`   |
| `0`       | idle timeout, no messages | relaunch `wait.js` (or stop — your call)|
| `3`       | peer sent `--done`        | read final message, **stop**            |
| `1`       | error (relay down, etc.)  | check the relay, then restart           |

## Running without `make`

`make` is just a convenience wrapper. From any directory, call the scripts by
absolute path and point `RELAY_URL` at the standing relay — each agent's inbox
lands in its own folder:

```bash
export RELAY_URL=ws://127.0.0.1:9000
APP=/path/to/Threadline                  # this repo's location

cd ~/anywhere
node "$APP/send.js" --from A --text "hello B"
node "$APP/wait.js" --from A --idle 900 --fresh
cat inbox.A.md
```

Useful flags:

- `--idle N` — `wait.js` gives up after N seconds of silence (default 900) and
  exits cleanly, so you can decide whether to keep waiting.
- `--fresh` — join at the live head: skip the backlog and only wake on messages
  sent from now on. Use it when an agent joins an already-running channel.
- `COMM_DIR=/some/path` — force the inbox/cursor location regardless of cwd.

New messages append to `inbox.<name>.md`; the read cursor lives in
`.seq.<name>`. Delete both to reset an agent's view.

> **Port note:** the scripts default to `8787`, but the Makefile (and this
> guide) use `9000`. Always export the same `RELAY_URL` in every terminal so all
> agents agree on the relay.

## Make targets

| target | what it does |
|--------|--------------|
| `make install` | install the `ws` dependency (one-time) |
| `make start` / `make relay` | start the relay in the background (idempotent; resets stale session state) |
| `make status` | show whether the relay is running |
| `make logs` | tail the relay log |
| `make stop` / `make restart` | stop / restart the background relay |
| `make send FROM=A TEXT="…"` | send a message as `A` |
| `make listen FROM=A [IDLE=900]` | block until a message arrives, then exit (prints the exit code) |
| `make done FROM=A TEXT="…"` | send a final message with the `--done` flag |
| `make demo` | run two mock agents end-to-end (starts its own relay) |
| `make clean` / `make distclean` | remove generated files / also remove `node_modules` |

Override config inline, e.g. `make start PORT=9100`.

## Files

| file              | role                                                        |
|-------------------|-------------------------------------------------------------|
| `relay.js`        | WebSocket hub: broadcast + 500-message backlog              |
| `send.js`         | send one message, then exit                                 |
| `wait.js`         | block until a message arrives, append to inbox, exit (wake) |
| `inbox.<name>.md` | received messages for that agent (generated)                |
| `.seq.<name>`     | last-seen message seq for that agent (generated)            |

## Caveats

- **Near-real-time**, not instant — there's wake + turn latency per message.
- **Each reply costs a turn.** Always set a stop condition (the `--done`
  sentinel, a max-message count, or a human in the loop).
- **Localhost only** as written — `relay.js` binds `127.0.0.1`. For two machines,
  bind `0.0.0.0` and point `RELAY_URL` at the host, or use an SSH tunnel.
- Messages are plain JSON over an unauthenticated local socket — fine for
  localhost, not for exposing to a network.
