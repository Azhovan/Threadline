# agent-comm — two terminal agents talking over a WebSocket

A tiny relay + wake-on-message bridge so an agent in one terminal can talk to an
agent in another, on the same machine.

```
 Terminal A                  relay (one process)              Terminal B
 ┌──────────┐          ┌────────────────────────┐          ┌──────────┐
 │ Agent A  │  send.js │  ws://127.0.0.1:8799    │  send.js │ Agent B  │
 │          ├─────────►│  broadcasts + backlog   │◄─────────┤          │
 │          │  wait.js │                         │  wait.js │          │
 │  inbox ◄─┤◄─────────┤                         ├─────────►├─► inbox  │
 └──────────┘          └────────────────────────┘          └──────────┘
```

## How "wake on message" works

An agent here runs in **turns**, not as a persistent listener. So the real
listening is done by `wait.js`, a short-lived background process:

1. It connects, replays anything newer than the last message this agent saw,
   then **blocks until a fresh message arrives**.
2. On arrival it appends to `inbox.<name>.md`, advances `.seq.<name>`, and **exits**.
3. That exit re-invokes the agent → the agent reads its inbox, replies with
   `send.js`, and relaunches `wait.js`. Loop.

No polling, no busy-waiting. The agent only spends a turn when there's a message.

## The model: a standing service, agents anywhere

The relay is a **standing background service**. You start it once; it keeps
running and listens on `ws://127.0.0.1:9000`. After that, **any local process —
in any terminal, any working directory, even outside this project — can join the
channel** and talk to the others. The agents don't share anything except the
relay URL.

Two things make "agents anywhere" work:

- Each agent's inbox is written to its **own working directory** (or to
  `COMM_DIR` if you set it), not to the project folder. So an agent running in
  `~/work/foo` reads its messages from `~/work/foo/inbox.<name>.md`.
- A newly-arriving agent can join with `--fresh` to start at the live head and
  skip any backlog history (see below).

## Quickstart with `make` (recommended)

The `Makefile` wraps everything. From the project directory:

```bash
make install                       # one-time: install the `ws` dependency
make start                         # start the standing relay in the background
make status                        # check it's running
```

Then, in **each agent's terminal** (anywhere on the machine):

```bash
export RELAY_URL=ws://127.0.0.1:9000     # point at the standing relay

make send   FROM=A TEXT="hello B"        # send a message
make listen FROM=A                       # block until a message arrives, then exit
make done   FROM=A TEXT="bye"            # send a final message and end the convo
```

When finished with the channel:

```bash
make stop                          # stop the standing relay
```

### Make targets

| target | what it does |
|--------|--------------|
| `make install` | install the `ws` dependency (one-time) |
| `make start` / `make relay` | start the relay in the **background** (idempotent; resets stale session state) |
| `make status` | show whether the relay is running |
| `make logs` | tail the relay log |
| `make stop` | stop the background relay |
| `make restart` | restart it |
| `make send FROM=A TEXT="…"` | send a message as `A` |
| `make listen FROM=A [IDLE=900]` | block until a message arrives, then exit (prints the exit code) |
| `make done FROM=A TEXT="…"` | send a final message with the `--done` flag |
| `make demo` | run two mock agents end-to-end (self-contained proof; starts its own relay) |
| `make clean` | remove generated inboxes/cursors/logs |
| `make distclean` | `clean` + remove `node_modules` |

Override config inline, e.g. `make start PORT=9100`.

## Running agents from anywhere (without `make`)

`make` is just a convenience. From any directory, call the scripts by absolute
path and point `RELAY_URL` at the standing relay. Each agent's inbox lands in
its **own** directory:

```bash
export RELAY_URL=ws://127.0.0.1:9000
APP=/Users/azhovan/GolandProjects/agent-rails

cd ~/anywhere
node "$APP/send.js" --from A --text "hello B"
node "$APP/wait.js" --from A --idle 900 --fresh   # then: cat inbox.A.md
```

- `--idle N` — give up after N seconds of silence (default 900). Exits cleanly
  so you can decide whether to keep waiting.
- `--fresh` — join at the live head: skip any backlog and only wake on messages
  sent from now on. Use this when an agent joins an already-running channel and
  shouldn't replay old history.
- New messages are appended to `inbox.<name>.md` (in the current dir, or
  `COMM_DIR`); the read cursor lives in `.seq.<name>`. Delete both to reset an
  agent's view.
- Set `COMM_DIR=/some/path` to force the inbox/cursor location regardless of cwd.

> **Port note:** the built-in default is `8787`, but that port was already taken
> on this machine, so this setup uses **`9000`** throughout. All agents must use
> the same `RELAY_URL`.

## Ending the conversation — the `DONE` sentinel

Two agents left to free-run will ping-pong forever (each reply costs a turn).
To stop cleanly, send a final message with `--done`:

```bash
node send.js --from A --text "we're aligned, wrapping up" --done
```

The peer's `wait.js` tags it `[DONE]` in the inbox and **exits with code 3**
(instead of 0). That non-zero code is the "stop the loop" signal: when the
waiter exits 3, read the final message but do **not** relaunch the listener.

`--done` is an explicit flag, not the literal word "done" — so the word can
appear in normal chat without ending anything.

| waiter exit code | meaning                        | what the agent should do |
|------------------|--------------------------------|--------------------------|
| `0`              | new message(s) arrived         | read inbox, reply, relaunch `wait.js` |
| `0` (idle log)   | idle timeout, no messages      | relaunch `wait.js` (or stop, your call) |
| `3`              | peer sent `--done`             | read final message, **stop** — do not relaunch |
| `1`              | error (relay down, etc.)       | check relay, restart |

## The agent loop, in practice

For each agent terminal, the cycle is:

1. `node wait.js --from <me>` in the **background**.
2. When it exits → read `inbox.<me>.md` (only new entries are below your last seq).
3. If exit code was **3** (`DONE`) → stop. Otherwise decide + `node send.js --from <me> --text "..."`.
4. Go to 1.

## Example conversation

A real run of two agents (A initiates, B responds) talking over the relay and
ending cleanly via `--done`. This is the verbatim `conversation.log` produced by
the demo, ordered by the relay's `seq`:

```
# Two-Agent Conversation (ordered by relay seq)

#1  A → A: hello B, are you receiving me?
#2  B → B: got message 1, replying back
#3  A → A: thanks, round 1 confirmed
#4  B → B: got message 2, replying back
#5  A → A: thanks, round 2 confirmed
#6  B → B: got message 3, replying back
#7  A → A: all good, wrapping up. bye!
```

Message `#7` carried `--done`, so B's `wait.js` exited with code 3 and the loop
stopped on its own — no manual interrupt. Each side received only the *other*
agent's messages: `inbox.A.md` held B's lines, `inbox.B.md` held A's (with `#7`
tagged `— DONE`).

## Caveats

- **Near-real-time**, not instant — there's wake + turn latency per message.
- **Each reply costs a turn/tokens.** Two agents left to free-run can loop
  forever — set a stop condition (a "DONE" sentinel, a max-message count, or a
  human in the loop).
- **Localhost only** as written (`relay.js` binds `127.0.0.1`). For two machines,
  bind `0.0.0.0` + point `RELAY_URL` at the host (or use an SSH tunnel).
- Messages are plain JSON over an unauthenticated local socket — fine for
  localhost, not for exposing to a network.

## Files

| file              | role                                                        |
|-------------------|-------------------------------------------------------------|
| `relay.js`        | WebSocket hub: broadcast + 500-message backlog              |
| `send.js`         | send one message, then exit                                 |
| `wait.js`         | block until a message arrives, append to inbox, exit (wake) |
| `inbox.<name>.md` | received messages for that agent (generated)                |
| `.seq.<name>`     | last-seen message seq for that agent (generated)            |
