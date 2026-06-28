# Threadline

**Let your AI agents talk to each other.** Threadline is a tiny bridge that lets
two agents — running in separate terminals — collaborate in real time: hand off
work, ask each other questions, review one another's output, and coordinate to a
shared goal.

## Why

A single agent works alone in its own context. Threadline lets you run several
and have them *cooperate*:

- **Divide and conquer** — one agent writes code while another reviews it, or a
  planner delegates subtasks to workers and collects the results.
- **Specialize** — give each agent a focused role (researcher, coder, critic) and
  let them confer instead of cramming everything into one prompt.
- **Coordinate anywhere** — agents can run in any terminal, any directory, even
  different projects on the machine. They share nothing but a relay URL.
- **No wasted turns** — an agent sleeps until a message actually arrives, so it
  spends a turn (and tokens) only when there's something to act on.
- **Zero infrastructure** — no broker, no cloud, no accounts. One local process
  and two small scripts.

## Requirements

Node.js (current LTS) and npm. The only runtime dependency is
[`ws`](https://www.npmjs.com/package/ws), installed in the next step.

## How to use it

Start the relay once, from the repo directory:

```bash
make install     # one-time per clone
make start       # runs the relay in the background
make status
```

Then, in **each agent's terminal** (anywhere on the machine):

```bash
export RELAY_URL=ws://127.0.0.1:9000     # every agent must use the same URL

make send   FROM=A TEXT="hello B"
make listen FROM=A                       # blocks until a message arrives, then exits
make done   FROM=A TEXT="bye"            # sends a final message, ends the conversation
```

Stop the relay when you're done: `make stop`.

To watch it run without wiring up two real agents, use `make demo` — it starts
its own relay and plays two mock agents through a full exchange.

### The agent loop

With the relay running, each agent terminal repeats the same cycle:

1. Run `node wait.js --from <me>` in the **background**.
2. When it exits → read the new entries in `inbox.<me>.md`.
3. If the exit code was **3**, the peer ended the conversation — stop. Otherwise
   reply with `node send.js --from <me> --text "..."` and go back to step 1.

`wait.js` exits **0** on a normal message (or idle timeout), **3** when the peer
sent `--done`, and **1** on error. The non-zero `3` is the signal to stop the
loop instead of relaunching the listener — that's how a conversation ends cleanly
instead of ping-ponging forever.

## More commands

The `Makefile` wraps a few more targets (`logs`, `restart`, `fresh-listen`,
`clean`, …). For the full list with descriptions:

```bash
make help
```

Each script also documents its own flags (`--idle`, `--fresh`, `COMM_DIR`, …) in a
header comment at the top of the file — see `send.js` and `wait.js`.

> **Port note:** the scripts default to `8787`, but the Makefile (and this guide)
> use `9000`. Always export the same `RELAY_URL` in every terminal so all agents
> agree on the relay.

## How it works

```
 Terminal A                  relay (one process)              Terminal B
 ┌──────────┐          ┌────────────────────────┐          ┌──────────┐
 │ Agent A  │  send.js │  ws://127.0.0.1:9000    │  send.js │ Agent B  │
 │          ├─────────►│  broadcasts + backlog   │◄─────────┤          │
 │          │  wait.js │                         │  wait.js │          │
 │  inbox ◄─┤◄─────────┤                         ├─────────►├─► inbox  │
 └──────────┘          └────────────────────────┘          └──────────┘
```

A small relay process sits in the middle and broadcasts each message to the other
agents. The "wake up" is the trick: an agent runs in *turns*, not as a long-lived
listener, so `wait.js` does the blocking. It connects, waits for a fresh message,
appends it to `inbox.<name>.md`, and **exits** — and that exit is what re-invokes
the agent for its next turn.

The relay is a standing service you start once. After that, any local process can
join by pointing at the same relay URL, and each agent writes its inbox to its own
working directory — so they share nothing but the URL.

## Caveats

- **Near-real-time**, not instant — there's wake + turn latency per message.
- **Each reply costs a turn.** Always set a stop condition (the `--done`
  sentinel, a max-message count, or a human in the loop).
- **Localhost only** as written — `relay.js` binds `127.0.0.1`. For two machines,
  bind `0.0.0.0` and point `RELAY_URL` at the host, or use an SSH tunnel.
- Messages are plain JSON over an unauthenticated local socket — fine for
  localhost, not for exposing to a network.
