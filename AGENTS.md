# agent-comm — AI Operating Doc

PURPOSE: A localhost WebSocket relay plus wake-on-message bridge that lets two terminal AI agents exchange chat messages, where each agent's `wait.js` exit is the signal that re-invokes that agent for its next turn.

> **FOR AI AGENTS:** Your contract is **[THE AGENT LOOP](#the-agent-loop)**. Do not improvise. Run the numbered algorithm there every turn, branch strictly on `wait.js` exit code per the [EXIT-CODE DECISION TABLE](#exit-code-decision-table), and STOP when you see exit code `3`. Everything above that section is reference; everything you *do* is in that section.

All paths in this doc are absolute. The project directory is:
```
/Users/azhovan/GolandProjects/agent-rails
```

> **ENVIRONMENT NOTE — READ FIRST (port 8787 is occupied here).** In this environment the default relay port `8787` is ALREADY held by another process (`127.0.0.1:8787 LISTEN`). A bare `node relay.js` will exit `1` (EADDRINUSE) immediately. **This doc therefore uses port `9000` as the working port throughout.** Start the relay with `node relay.js 9000` and point BOTH clients at it with `export RELAY_URL=ws://127.0.0.1:9000`. If you want to confirm/choose a port yourself, see [STEP 0: PICK A FREE PORT](#step-0-pick-a-free-port). Wherever you see `9000` / `ws://127.0.0.1:9000` below, it is the deliberate replacement for the `8787` default.

---

## TL;DR QUICKSTART

Exact copy-paste blocks. Replace `A`/`B` with your two agent names. By convention this doc uses `A` and `B` for the two peers.

### STEP 0: PICK A FREE PORT

The default `8787` is taken in this environment, so detect a free port and export `RELAY_URL` before anything else. This doc uses `9000`; first confirm `9000` is free (or pick another):

```bash
lsof -nP -iTCP:9000 -sTCP:LISTEN
```
- If that prints a `LISTEN` row, port `9000` is in use — check whether it is already an agent-comm relay (its terminal will show `relay listening on ws://127.0.0.1:9000`). If it is your relay, reuse it. Otherwise choose another free port and substitute it everywhere below.
- If it prints nothing (exit non-zero), `9000` is free — use it.

Set the URL for this terminal (both agents must use the SAME port):
```bash
export RELAY_URL=ws://127.0.0.1:9000
```

**1. Start the relay (one process, shared by both agents). Run once, leave running.** Because `8787` is occupied, start it on `9000`. Run it as its OWN separate long-lived process (own terminal / background), not inside the agent loop:
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node relay.js 9000
```
On a successful bind the relay prints (ISO-timestamped):
```
<ISO timestamp> relay listening on ws://127.0.0.1:9000
```
If you do NOT see that line, the bind failed — see [TROUBLESHOOTING](#troubleshooting) (exit `1` / EADDRINUSE). Before starting, you can confirm whether a relay is already up: `lsof -nP -iTCP:9000 -sTCP:LISTEN` (a `LISTEN` row + the `relay listening` line means one is already running — do not start a second; a second `node relay.js 9000` crashes with exit `1`).

**2. Set identity + relay URL (per terminal/agent).** `--from` overrides `AGENT_NAME`; `RELAY_URL` has no flag override, so it MUST be exported here:
```bash
export AGENT_NAME=A
export RELAY_URL=ws://127.0.0.1:9000
```

**3. Send a message.**
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node send.js --from A --text "hello there"
```

**4. Listen for the next message and capture its exit code (its exit is your wake signal).** This blocks the shell until a message arrives, then exits; capture the code into `C`:
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node wait.js --from A --idle 900; C=$?; echo "exit=$C"
```

**5. End the conversation cleanly (sentinel — peer's `wait.js` will exit 3 and stop).**
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node send.js --from A --text "wrapping up, bye" --done
```

---

## ARCHITECTURE

```
                       relay.js  (WebSocket hub)
                       host 127.0.0.1  port 9000 (8787 default is OCCUPIED here)
                  +------------------------------------------+
                  |  in-memory backlog (FIFO, max 500)       |
                  |  each item: { seq, from, text, done, ts }|
                  |  seq counter (++seq, starts at 0)        |
                  |  broadcast = send to all OTHER clients   |
                  +------------------------------------------+
                        ^   |  msg(broadcast + backlog replay)
              msg / hello|   v
        +-----------------+   +-----------------+
        |   Agent A        |   |   Agent B        |
        |                  |   |                  |
        | send.js  --from A|   | send.js  --from B|
        | wait.js  --from A|   | wait.js  --from B|
        +--------+---------+   +--------+---------+
                 |                      |
                 v                      v
        inbox.A.md  .seq.A      inbox.B.md  .seq.B
        (per-agent inbox +      (per-agent inbox +
         dedup/replay cursor)    dedup/replay cursor)
```

- The relay never echoes a message back to its sender **on the live broadcast path** (the broadcast loop skips `client === ws`).
- **WARNING — the no-echo guarantee does NOT cover hello-replay.** When `wait.js` connects it sends `hello{since:lastSeq}`, and the relay replays every backlog item with `seq > since` to that same client — including the client's OWN earlier messages. `send.js` does NOT advance the sender's `.seq.<from>` cursor, so after you send a message, the FIRST `wait.js` you run with the same `--from` will have a cursor that is behind that message's `seq`, receive its own message via replay, append it to its own `inbox.<from>.md`, advance `.seq.<from>`, and WAKE (exit `0`) on it. Expect and ignore these self-entries (an entry whose `from` equals your own `--from`), or apply the code-level fix in [NOTES](#notes-source-accurate-behaviors). This matters in [THE AGENT LOOP](#the-agent-loop), which does send-then-wait.
- Each agent has its own inbox file and its own seq cursor file, both written by that agent's `wait.js` in the project directory.

---

## COMPONENTS

| File (absolute) | Role | How to invoke |
|---|---|---|
| `/Users/azhovan/GolandProjects/agent-rails/relay.js` | WebSocket hub. Broadcasts `msg` frames to all other clients, keeps a 500-item backlog, replays backlog on `hello`. Binds `127.0.0.1` only. | `node relay.js [port]` |
| `/Users/azhovan/GolandProjects/agent-rails/send.js` | Sends exactly one `msg` frame to the relay, then exits. | `node send.js --from A --text "..."` |
| `/Users/azhovan/GolandProjects/agent-rails/wait.js` | Wake-on-message waiter. Connects, replays missed messages, blocks until a fresh message, appends to inbox, advances cursor, prints, exits. Capture its exit code. | `node wait.js --from A [--idle 900]` |
| `/Users/azhovan/GolandProjects/agent-rails/package.json` | Manifest. `agent-comm` v1.0.0, private, MIT. Sole dep: `ws ^8.18.0`. | n/a |
| `/Users/azhovan/GolandProjects/agent-rails/inbox.<name>.md` | GENERATED. Per-agent conversation log (append-only). | read after wake |
| `/Users/azhovan/GolandProjects/agent-rails/.seq.<name>` | GENERATED. Per-agent highest-processed `seq` (dedup/replay state). | managed by `wait.js` |

Runtime requirement: Node.js with the `ws` package installed (already present in `/Users/azhovan/GolandProjects/agent-rails/node_modules`).

---

## ENV VARS

| Name | Default | Used by | Meaning |
|---|---|---|---|
| `PORT` | `8787` | `relay.js` | Listen port. Precedence: `argv[2]` > `PORT` env > `8787`. (Default `8787` is occupied here — use `9000`.) |
| `RELAY_URL` | `ws://127.0.0.1:8787` | `send.js`, `wait.js` | Relay WebSocket URL the client connects to. No flag overrides it — export it. Set to `ws://127.0.0.1:9000` here to match the relay. |
| `AGENT_NAME` | `unknown` | `send.js`, `wait.js` | Identity fallback when `--from` is absent. Precedence: `--from` > `AGENT_NAME` > `unknown`. |

---

## CLI REFERENCE

### relay.js

Invocation: `node relay.js [port]`

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `port` (positional `argv[2]`) | no | `PORT` env, else `8787` | Listen port. Overrides `PORT` env and the `8787` default when present. **Use `9000` here — `8787` is occupied.** |

Env: `PORT` (only if no positional port given).

Inputs: incoming WebSocket connections from clients.

Outputs: broadcasts `msg` frames; logs every event with an ISO timestamp to stdout. The lines you will see in the relay terminal:
- `relay listening on ws://127.0.0.1:<port>` — emitted on the `listening` event when the bind succeeds. **This is the signal the relay is up and on which port.** Its absence means the bind failed (see exit `1` / EADDRINUSE).
- `client connected <addr>` — a client opened a connection.
- `hello from <name>` — a `wait.js` sent its `hello` (and triggered backlog replay).
- `msg #<seq> from <from>: <text first 0..80 chars>` — a `msg` frame was received and broadcast.
- `client disconnected <name>` — a client closed.
- `client error <name> <msg>` — a per-client socket error.

Side effects: binds `127.0.0.1:<port>`; holds an in-memory backlog (lost on restart); `seq` resets to 0 on restart.

| Exit code | Meaning |
|---|---|
| `0` | Clean shutdown on SIGINT/SIGTERM (handled identically): logs `shutting down`, `wss.close()`, then `process.exit(0)`. |
| `1` | Server error (`wss` `error` event), e.g. port already in use / bind failure. Logs `server error <msg>`, then `process.exit(1)`. |

Copy-paste (use `9000`; `8787` is occupied here):
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node relay.js 9000
```
```bash
cd /Users/azhovan/GolandProjects/agent-rails && PORT=9000 node relay.js
```

---

### send.js

Invocation: `node send.js --from A --text "..."` (text may instead come from stdin)

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--from` | no | `AGENT_NAME` env, else `unknown` | This agent's name; the `from` field of the `msg` frame. |
| `--text` | no | `null` → read stdin | Message body. If omitted, text is read fully from stdin and trimmed. `--text` takes precedence over stdin. **A value-less `--text` (e.g. `--text` as the LAST token) is NOT an error — the empty following value reverts to the default `null`, so it falls through to stdin** (and then to exit `2` if stdin is empty/TTY). |
| `--done` | no | absent (`false`) | Presence-detected (`process.argv.includes('--done')`). Sets `done:true` — the conversation-end sentinel. |

Env: `RELAY_URL`, `AGENT_NAME`.

Inputs: `--text` value, or stdin (only when stdin is NOT a TTY; stdin content is trimmed).

Outputs: on success logs `sent (<from>)[ [DONE]]: <text>` to stdout.

Side effects: one `msg` frame delivered to the relay; no files written. In particular, `send.js` does NOT write or advance `.seq.<from>` — see the self-wake warning in [ARCHITECTURE](#architecture).

Timing: on `open` sends the frame, waits 150ms to flush, then closes; success is reported in the `close` handler. Connect timeout is 5000ms.

| Exit code | Meaning |
|---|---|
| `0` | Sent and socket closed cleanly. |
| `1` | Send failure: 5000ms connect timeout (`timeout connecting to relay`) or WebSocket `error`. `fail()` logs `send failed: <msg>`. |
| `2` | Usage error: no `--text` and nothing on stdin. Logs `error: no --text and nothing on stdin`. |

Copy-paste:
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node send.js --from A --text "hello there"
```
```bash
cd /Users/azhovan/GolandProjects/agent-rails && echo "hello there" | node send.js --from A
```
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node send.js --from A --text "bye" --done
```

---

### wait.js

Invocation: `node wait.js --from A [--idle 900]`. It BLOCKS the shell until it exits; **its exit is your wake signal, so capture the exit code.** It does not need `&` to "wait" — it already blocks until a message arrives (or idle). The literal foreground-with-capture form is:
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node wait.js --from A --idle 900; C=$?; echo "exit=$C"
```
See [THE AGENT LOOP, step 2](#the-agent-loop) for the foreground-vs-background decision and the exact commands.

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--from` | no | `AGENT_NAME` env, else `unknown` | This agent's name. Used as the relay identity (`hello.from`) AND to name `inbox.<from>.md` and `.seq.<from>`. |
| `--idle` | no | `900` (seconds) | Seconds to block waiting for a message before giving up. Parsed as `parseInt(...) * 1000` ms. On expiry, exits `0` with an idle-timeout marker. **An empty value reverts to the `900` default (see flag-parsing note below). `--idle 0` yields `idleMs = 0` and exits immediately with the idle marker — avoid it.** |

Flag parsing (applies to `--from`, `--text`, `--idle`): a flag's value is taken only if the immediately-following argv token is truthy (`i !== -1 && process.argv[i + 1] ? ... : def`). An empty or missing following token reverts to the default.

Env: `RELAY_URL`, `AGENT_NAME`.

Inputs: connects to relay, sends `hello` with `since=lastSeq` (read from `.seq.<from>`, defaults to `-1`).

Outputs: two mutually-exclusive stdout discriminators (since both code-`0` cases share the same exit code, you MUST read stdout to tell them apart):
- Normal wake: `[wait] N new message(s); inbox -> inbox.<from>.md`, followed by one line per new message in the form `  #<seq> <from>[ [DONE]]: <text first 0..120 chars>`.
- Idle timeout: `[wait] idle timeout after Ns, no new messages`.
- On DONE it additionally prints `[wait] DONE — conversation ended by peer; do not relaunch.`

Side effects: APPENDS each accepted message to `inbox.<from>.md`; rewrites `.seq.<from>` with the highest accepted `seq`.

Behavior: drops any `msg` with `seq <= lastSeq` (dedup). Batches a burst using a 400ms settle window (reset on each new message) so multiple messages cause a single wake. **The settle window starts on the FIRST accepted message, whether it arrived via live broadcast OR via hello-replay of the backlog** — so a stale or self message replayed on connect can by itself trigger a wake before any turn-fresh message arrives (see [DONE SENTINEL](#done-sentinel) and [ARCHITECTURE](#architecture)).

| Exit code | Meaning |
|---|---|
| `0` | Either (a) idle timeout — no message within the idle window (`[wait] idle timeout after Ns, no new messages`); or (b) normal wake — one or more fresh messages, NONE with `done` (`[wait] N new message(s); inbox -> ...`). Distinguish by stdout, not by code. Implemented as `process.exit(ended ? 3 : 0)`. |
| `3` | DONE sentinel — at least one received message had `done:true` (`ended = received.some(m => m.done)`). Peer ended the conversation. Logs `[wait] DONE — conversation ended by peer; do not relaunch.` STOP; do not relaunch the listener. **Caveat: a stale `done:true` item still in the relay backlog will be replayed on connect and will trigger exit `3` even with no turn-fresh message — see [DONE SENTINEL](#done-sentinel).** |
| `1` | WebSocket `error` event: clears the idle timer, logs `[wait] error: <msg>`, `process.exit(1)`. |

Copy-paste:
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node wait.js --from A --idle 900; C=$?; echo "exit=$C"
```
```bash
cd /Users/azhovan/GolandProjects/agent-rails && AGENT_NAME=A node wait.js --idle 600; C=$?; echo "exit=$C"
```

---

## WIRE PROTOCOL

All frames are JSON text over WebSocket. Non-JSON frames are silently ignored. Any frame whose `type` is neither `hello` nor `msg` is silently dropped by the relay. Clients (`wait.js`) ignore any inbound frame where `type !== 'msg'`.

### Control frames

| type | Direction | Fields | Notes |
|---|---|---|---|
| `hello` | client → server (sent by `wait.js` on open) | `type:'hello'`, `from:string`, `since:number` | Relay sets `ws.meta.name = from`, logs `hello from <name>`, then replays every backlog item with `item.seq > since` to that client only (each as a `msg` frame). `since` is used only if `Number.isFinite(since)`, else `-1`. **Replay is NOT filtered by `from` — it includes the client's OWN earlier messages and any stale items still in the backlog.** `send.js` NEVER sends `hello`. |
| `msg` | client → server (chat send) AND server → client (broadcast + backlog replay) | `type:'msg'`, `from:string`, `text:string`, `done:boolean`, `seq:number`, `ts:string(ISO)` | Inbound from `send.js` carries `type/from/text/done`. Relay stamps `seq` (`++seq`) and `ts` (`new Date().toISOString()`), assigns `from = msg.from || ws.meta.name || 'unknown'`, `text = String(msg.text ?? '')`, `done = !!msg.done`, pushes the full item (including `done`) to the backlog (trim to 500 via `shift`), then broadcasts `JSON.stringify({type:'msg', ...item})` to every OTHER open client (`client !== ws && readyState === OPEN`). |

### msg fields

| Field | Type | Description |
|---|---|---|
| `type` | string literal `'msg'` | Frame discriminator. Clients ignore frames where `type !== 'msg'`. |
| `seq` | number | Monotonic per-relay-process counter assigned by server (`++seq`, starts at 0 so first message is `1`). Dedup/replay cursor: clients ignore `seq <= lastSeq`; `hello.since` requests replay of `seq > since`. |
| `from` | string | Sender name. Server uses `msg.from || ws.meta.name || 'unknown'`. |
| `text` | string | Body. Server coerces `String(msg.text ?? '')`, so null/undefined → empty string. |
| `done` | boolean | Conversation-end sentinel. Server stores `!!msg.done`, **stores it in the backlog item, and carries it through to clients on both broadcast AND backlog replay.** `wait.js` exits `3` when any received message has `done:true`. |
| `ts` | string (ISO 8601) | Server-assigned `new Date().toISOString()`, set when relay processes the message. |

Example `hello` frame (client → server):
```json
{ "type": "hello", "from": "A", "since": 4 }
```

Example `msg` frame (as a client sends it; `send.js` payload):
```json
{ "type": "msg", "from": "A", "text": "hello there", "done": false }
```

Example `msg` frame (as the relay broadcasts/replays it, after stamping `seq` and `ts`):
```json
{ "type": "msg", "seq": 5, "from": "A", "text": "hello there", "done": false, "ts": "2026-06-28T12:00:00.000Z" }
```

---

## GENERATED FILES

Both files live in the `wait.js` directory (`__dirname`):
```
/Users/azhovan/GolandProjects/agent-rails
```

### inbox.<from>.md  (e.g. `/Users/azhovan/GolandProjects/agent-rails/inbox.A.md`)

Per-agent inbox. `wait.js` APPENDS one entry per accepted message (`fs.appendFileSync`). This is the running conversation log; use it for full-history context, not as the per-turn delta (it accumulates across all turns, and may include your own self-replayed entries — see [ARCHITECTURE](#architecture)). For the authoritative list of messages received THIS wake, read `wait.js`'s own stdout summary (see [step 4](#the-agent-loop)).

Exact entry format (one per message; `<tag>` is ` — DONE` when `done:true`, else empty):
```
\n---\n**[#<seq>] from <from><tag>** _(<ts>)_\n\n<text>\n
```

Rendered example of a single entry:
```

---
**[#5] from A** _(2026-06-28T12:00:00.000Z)_

hello there
```

Rendered example of a DONE entry:
```

---
**[#9] from A — DONE** _(2026-06-28T12:05:00.000Z)_

wrapping up, bye
```

### .seq.<from>  (e.g. `/Users/azhovan/GolandProjects/agent-rails/.seq.A`)

Per-agent dedup/replay cursor: the highest `seq` this agent has processed. Persisted across `wait.js` restarts so replay and dedup keep working.

- Format: plain text, a single integer (`fs.writeFileSync(seqPath, String(n))`).
- Read on startup with `parseInt(..., 10) || -1` (missing/unparseable → `-1`).
- Dedup: `wait.js` drops any inbound `msg` with `seq <= lastSeq`. The relay independently replays only backlog items with `seq > hello.since`. A brand-new client (cursor `-1`) gets the full backlog — including any stale messages and any stale `done:true` sentinel.
- Only `wait.js` writes this file; `send.js` never does. Keep it current before relaunching `wait.js` (see [DONE SENTINEL](#done-sentinel)).

---

## THE AGENT LOOP

This is the deterministic per-turn algorithm. Follow it exactly. `A` = you; `B` = peer. Pick your name once and keep it constant.

Preconditions (verify once at conversation start):

1. **A relay is running on a known free port.** Because `8787` is occupied here, use `9000`. Check before starting (do NOT start a second relay — a second `node relay.js` on the same port crashes with exit `1`, EADDRINUSE):
   ```bash
   lsof -nP -iTCP:9000 -sTCP:LISTEN
   ```
   - Prints a `LISTEN` row → a process holds `9000`. If its terminal shows `relay listening on ws://127.0.0.1:9000`, it is your relay — reuse it. Otherwise pick another free port and use it everywhere.
   - Prints nothing → `9000` is free; start the relay as its OWN long-lived background/separate process (not inside this loop):
     ```bash
     cd /Users/azhovan/GolandProjects/agent-rails && node relay.js 9000 &
     ```
     Confirm it printed `relay listening on ws://127.0.0.1:9000`. (Starting it in a dedicated terminal instead of `&` is equally fine; the point is it must outlive the loop.)
2. **Export the matching relay URL in this terminal** (no flag overrides `RELAY_URL`):
   ```bash
   export RELAY_URL=ws://127.0.0.1:9000
   ```
3. You have chosen your agent name (here `A`) and will keep it constant.

Per turn:

1. **(Optional, your move) Send a reply.** If this turn requires you to say something, run:
   ```bash
   cd /Users/azhovan/GolandProjects/agent-rails && node send.js --from A --text "<your message>"
   ```
   To END the conversation, add `--done`:
   ```bash
   cd /Users/azhovan/GolandProjects/agent-rails && node send.js --from A --text "<final message>" --done
   ```
   - If `send.js` exits `2`: you supplied no text — fix the command and retry.
   - If `send.js` exits `1`: the relay is unreachable — see [TROUBLESHOOTING](#troubleshooting), then retry.
   - If you sent `--done`: STOP. Do not launch `wait.js`. The conversation is over from your side.

2. **Launch the listener and capture its exit code.** `wait.js` BLOCKS the shell until it exits, and its exit is your wake signal. Two execution models — pick by whether you must do other work while waiting:
   - **Blocking-shell model (default — use this unless you have other concurrent work).** Run it in the FOREGROUND and capture `$?` directly into `C`:
     ```bash
     cd /Users/azhovan/GolandProjects/agent-rails && node wait.js --from A --idle 900; C=$?; echo "exit=$C"
     ```
   - **True-background model (only if you must keep the shell free meanwhile).** Background it, remember its PID, then `wait` for it to harvest the exit code:
     ```bash
     cd /Users/azhovan/GolandProjects/agent-rails && node wait.js --from A --idle 900 & WAITPID=$!
     # ... do other work ...
     wait $WAITPID; C=$?; echo "exit=$C"
     ```
   In both models, `C` holds the exit code you branch on in step 5.

3. **Wait for `wait.js` to EXIT.** Do not poll the inbox; the process exit is the signal. After it exits, `C` holds its exit code (captured in step 2).

4. **Read what arrived this turn from `wait.js`'s stdout summary** — that is the authoritative per-turn delta (it lists exactly the messages received this wake, as `#<seq> <from>[ [DONE]]: <text>`). Use the inbox file only for full conversation history, since `cat` prints the ENTIRE growing log (including any self-replayed entries), not just this turn's lines:
   ```bash
   cat /Users/azhovan/GolandProjects/agent-rails/inbox.A.md
   ```
   To read only this turn's entries from the file, match the `#<seq>` numbers that the wake summary reported.

5. **Branch on `C`** using the [EXIT-CODE DECISION TABLE](#exit-code-decision-table):
   - `C == 3` → DONE. The peer ended the conversation. **STOP. Do not relaunch `wait.js`.** (But first sanity-check: if no turn-fresh message appears in the wake summary and the only `[DONE]` line is an old `seq`, this may be a STALE backlog DONE replayed on connect — see [DONE SENTINEL](#done-sentinel).)
   - `C == 0` and the wake summary shows new messages → a normal wake. Compose your reply and go to step 1.
   - `C == 0` and stdout was `[wait] idle timeout ...` (no new messages) → no one spoke within `--idle`. Decide: keep waiting (go to step 2) or stop if your stop condition is met.
   - `C == 1` → relay/transport error. See [TROUBLESHOOTING](#troubleshooting). After recovery, go to step 2.

6. **Relaunch** (go to step 2) only when `C != 3` and your stop condition is not met. Before relaunching, ensure `.seq.<from>` is current (it is, since `wait.js` rewrites it on each accepted message) so stale items are not re-woken on.

Stop conditions (you MUST have at least one): peer sent `--done` (you got exit `3`); your task is complete (send your own `--done`, then stop); or a turn budget/idle-timeout policy you set yourself.

### EXIT-CODE DECISION TABLE

This table is per script. The loop branches primarily on `wait.js`.

| Script | Code | Meaning | Required action |
|---|---|---|---|
| `wait.js` | `3` | DONE — a received message had `done:true`. | **STOP. Do not relaunch the listener.** First confirm the `[DONE]` line is turn-fresh, not a stale backlog DONE (see note below). |
| `wait.js` | `0` (with new messages) | Normal wake — fresh message(s), none `done`. Stdout: `[wait] N new message(s); inbox -> inbox.<from>.md`. | Use the stdout summary as the delta, reply (step 1), relaunch listener. |
| `wait.js` | `0` (idle marker) | Idle timeout — nothing arrived within `--idle`. Stdout: `[wait] idle timeout after Ns, no new messages`. | Decide per your stop condition: relaunch listener to keep waiting, or stop. |
| `wait.js` | `1` | WebSocket error (`[wait] error: <msg>`). | Fix relay/connectivity ([TROUBLESHOOTING](#troubleshooting)), then relaunch listener. |
| `send.js` | `0` | Sent cleanly. | Proceed (launch listener, or stop if you sent `--done`). |
| `send.js` | `1` | Send failed (connect timeout or WS error). | Fix relay/connectivity, retry the send. |
| `send.js` | `2` | No text supplied. | Add `--text` (with a non-empty value) or pipe non-empty stdin, retry. |
| `relay.js` | `0` | Clean shutdown (SIGINT/SIGTERM). | Relay intentionally stopped; restart it (on `9000`) if the conversation continues. |
| `relay.js` | `1` | Server error (e.g. port in use). | Free/choose another port ([TROUBLESHOOTING](#troubleshooting)), restart relay. |

Note: both `wait.js` exit `0` cases share the same code and are distinguished ONLY by stdout — a normal wake prints `[wait] N new message(s); inbox -> inbox.<from>.md`; an idle timeout prints `[wait] idle timeout after Ns, no new messages`. Always inspect stdout when `C == 0`.

---

## DONE SENTINEL

How to end a conversation cleanly:
```bash
cd /Users/azhovan/GolandProjects/agent-rails && node send.js --from A --text "<final message>" --done
```

Mechanism:
- `--done` is a flag, NOT the literal word "done" in your text. It is presence-detected (`process.argv.includes('--done')`) and sets `done:true` on the `msg` frame. Putting the word "done" in `--text` does nothing; you must pass the `--done` flag.
- The relay stores `done` in the backlog item and carries it through to all other clients — on the live broadcast AND on hello-replay.
- The peer's `wait.js` computes `ended = received.some(m => m.done)` and exits `3`, logging `do not relaunch`. That distinct non-zero code is what tells the peer's agent loop to STOP instead of relaunching the listener.
- After you send `--done`, YOU should also stop: do not launch your own `wait.js`.

**Exit `3` is NOT guaranteed to mean "a fresh DONE arrived this turn." It races against the backlog:**
- `wait.js` wakes on ANY unseen item (`seq > lastSeq`), including stale items replayed on connect. The 400ms settle window starts on the FIRST such item, so it can fire and exit `0` on an OLD backlog message BEFORE a concurrently-sent newer `--done` (a higher `seq`) is even delivered — in that case the waiter never sees `done` and does NOT exit `3` that turn.
- Conversely, because backlog items retain `done:true`, a brand-new agent name (cursor `-1`) connecting to a relay whose backlog still contains a prior `--done` message will be replayed that stale DONE and exit `3` immediately, even though no turn-fresh message arrived.
- Therefore: keep `.seq.<from>` current before relaunching (so already-seen items are dropped by dedup), and when you get exit `3`, check the wake summary — if the only `[DONE]` line is an old `seq` with no turn-fresh message, treat it as a stale backlog DONE rather than a new end-of-conversation signal.
- Code-level fixes that remove these races: have hello-replay not by itself satisfy the wake (e.g. don't start the settle timer on replay-only batches), and/or skip replaying items whose `from === hello.from`.

---

## TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| `send.js`/`wait.js` exit `1`, `timeout connecting to relay` or WS error | Relay not running, or `RELAY_URL` points to the wrong port. | Start the relay on `9000`: `cd /Users/azhovan/GolandProjects/agent-rails && node relay.js 9000` (confirm it prints `relay listening on ws://127.0.0.1:9000`). Ensure `export RELAY_URL=ws://127.0.0.1:9000` matches. |
| `relay.js` exits `1` immediately, `server error` (EADDRINUSE) | Port already in use. **`8787` is OCCUPIED in this environment** (a Python process holds `127.0.0.1:8787 LISTEN`), so a bare `node relay.js` will always fail here. | Start the relay on a free port and point both clients at it. This doc uses `9000`: relay `node relay.js 9000`; clients `export RELAY_URL=ws://127.0.0.1:9000`. Detect free ports with `lsof -nP -iTCP:<port> -sTCP:LISTEN`. |
| Relay terminal never prints `relay listening on ws://127.0.0.1:<port>` | The bind failed (port in use) — the server never reached the `listening` event. | Treat as EADDRINUSE: choose a free port and restart (see row above). |
| Clients connect but never receive each other's messages | Both peers using the SAME `--from` (relay never echoes to the sender on broadcast), or different `RELAY_URL`/ports. | Use distinct names (`A` and `B`). Ensure both `export RELAY_URL=ws://127.0.0.1:9000` (same port). |
| `wait.js` wakes (exit `0`) on your OWN message / your own line appears in your inbox | hello-replay is NOT filtered by sender, and `send.js` does not advance `.seq.<from>`, so your first `wait.js` after sending self-wakes on the replayed backlog copy. | Expected with the current code. Ignore self-entries (`from` == your `--from`); they don't change the protocol. Code fix: skip replaying `from === hello.from`. |
| `wait.js` exits `3` but no fresh message arrived this turn | A stale `done:true` item is still in the relay backlog and was replayed on connect (`.seq` cursor behind it). | Keep `.seq.<from>` current before relaunching; check the wake summary's `#<seq>` for the `[DONE]` line. Restart the relay to clear the backlog if you must reset. |
| `send.js` exits `2` | No `--text` and stdin was empty/TTY (a value-less `--text` also falls through to stdin). | Pass `--text "..."` with a non-empty value, or pipe non-empty stdin. `send.js` skips stdin when it's a TTY. |
| `wait.js` returns `0` instantly with idle marker | `--idle` elapsed with no message (default 900s), OR you passed `--idle 0` / an empty `--idle` value (0 ⇒ instant; empty ⇒ reverts to 900). | Relaunch to keep waiting, or set `--idle <positive seconds>`. Don't use `--idle 0`. |
| Messages duplicated or replayed on restart | Expected: replay uses `.seq.<from>`. Deleting it resets the cursor to `-1` (full backlog replayed, including stale DONE). | Leave `.seq.<from>` in place. Do not delete it mid-conversation. |
| After relay restart, old history gone / `seq` restarted | Backlog is in-memory only and `seq` resets to `0` on restart. | Keep one relay process alive for the whole conversation. Inbox files persist regardless. |
| Multiple messages produced one wake | Expected: 400ms settle window batches a burst into a single wake. | None — this is intended. |

---

## CONSTRAINTS

- **Localhost-only.** The relay binds `127.0.0.1` explicitly (`new WebSocketServer({ host: '127.0.0.1', port: PORT })`); default `RELAY_URL` is `ws://127.0.0.1:8787` (use `ws://127.0.0.1:9000` here). No external interface is exposed. Both agents must run on the same host.
- **Default port `8787` is occupied here — use `9000`.** Start the relay with `node relay.js 9000` and export `RELAY_URL=ws://127.0.0.1:9000` for both clients. A bare `node relay.js` exits `1`.
- **No-echo is broadcast-only.** The relay never echoes on the live broadcast path, but hello-replay DOES return your own (and stale) backlog messages. Expect self-wakes on your first `wait.js` after sending.
- **Exit `3` can be stale.** DONE detection races the backlog; a stale `done:true` item can trigger exit `3` on connect. Keep `.seq` current and verify the wake summary.
- **Near-real-time, not instant.** `send.js` waits 150ms to flush before closing; `wait.js` batches with a 400ms settle window. Expect sub-second, not zero, latency.
- **Each reply costs a turn.** `wait.js` exits on each wake and must be relaunched; every reply you send is a separate `send.js` invocation. Budget your turns.
- **Set a stop condition.** The loop does not terminate on its own except via exit code `3`. Always have one of: peer `--done` (you receive exit `3`), you send `--done`, or a self-imposed turn/idle budget. Without a stop condition the loop runs indefinitely (bounded only by `--idle`).
- **Single relay process per conversation.** Backlog (in-memory, `const backlog = []`, capped `BACKLOG_MAX = 500`, FIFO via `shift`) and `seq` reset on relay restart. Keep one relay alive.
- **One name per agent, kept constant.** `--from` selects identity, inbox file, and seq cursor. Changing it mid-conversation orphans your state files and breaks dedup.

---

## NOTES (source-accurate behaviors)

- **Backlog item shape includes `done`.** The relay's inline source comment (`// { seq, from, text, ts }`) omits `done`, but the code actually stores `done` in each backlog item (`done: !!msg.done`) and replays it. So a replayed backlog message preserves `done:true` and WILL trigger exit `3` on the peer's `wait.js` (this is what makes a stale backlog DONE wake a fresh waiter — see [DONE SENTINEL](#done-sentinel)).
- **seq.** Pre-incremented (`++seq`) starting from `0`, so the first broadcast message has `seq = 1`. `readSeq()` / missing cursor defaults to `-1`, so a brand-new client receives the full backlog.
- **Dedup is enforced two ways:** the relay replays only backlog items with `seq > hello.since`, and `wait.js` drops any `msg` with `seq <= lastSeq`. `lastSeq` is persisted in `.seq.<from>` across restarts.
- **Self-wake / code fix.** `send.js` does not advance the sender's `.seq`, and hello-replay is not filtered by `from`, so an agent's first `wait.js` after sending self-wakes on its own backlog copy. Recommended code fix: have the relay skip replaying items whose `from === hello.from`, or have `wait.js` ignore entries whose `from` equals its own `--from`.
- **Relay handles SIGINT and SIGTERM identically:** logs `shutting down`, `wss.close(callback)`, then `process.exit(0)`.
- **Relay ignores non-JSON frames** (try/catch around `JSON.parse` returns silently) and silently drops any frame whose `type` is neither `hello` nor `msg`.
- **Sole runtime dependency** is `ws ^8.18.0` (package.json: name `agent-comm`, version `1.0.0`, private, MIT). All three scripts are Node CLIs with a `#!/usr/bin/env node` shebang.