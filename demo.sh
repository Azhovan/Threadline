#!/usr/bin/env bash
# demo.sh — run two mock agents (A initiates, B responds) end-to-end over the
# relay, then end cleanly via --done. Proves the whole pipeline works.
#
# Used by `make demo`. Honors PORT / RELAY_URL from the environment.
set -u

PORT="${PORT:-9000}"
export RELAY_URL="${RELAY_URL:-ws://127.0.0.1:$PORT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "[demo] using relay $RELAY_URL"

# clean slate
rm -f inbox.A.md inbox.B.md .seq.A .seq.B relay.demo.log conversation.log 2>/dev/null

# fresh relay for the demo
node relay.js "$PORT" > relay.demo.log 2>&1 &
RELAY_PID=$!
sleep 1
if ! kill -0 "$RELAY_PID" 2>/dev/null; then
  echo "[demo] relay failed to start (is port $PORT free?):"; tail -3 relay.demo.log; exit 1
fi

# --- Agent B: responder. Waits, replies, until it sees DONE (exit 3). ---
(
  for i in 1 2 3 4 5; do
    node wait.js --from B --idle 8 > /dev/null 2>&1
    code=$?
    [ $code -eq 3 ] && exit 0          # peer said DONE -> stop
    [ $code -ne 0 ] && exit 1
    node send.js --from B --text "B: received message $i, here is my reply" > /dev/null 2>&1
  done
) &
B_PID=$!

# --- Agent A: initiator. Sends, waits for reply, repeats, then DONE. ---
(
  sleep 0.5
  node send.js --from A --text "A: hi B, are you receiving me?" > /dev/null 2>&1
  for i in 1 2; do
    node wait.js --from A --idle 8 > /dev/null 2>&1
    [ $? -ne 0 ] && exit 1
    node send.js --from A --text "A: got it, round $i works" > /dev/null 2>&1
  done
  node wait.js --from A --idle 8 > /dev/null 2>&1
  node send.js --from A --text "A: all good, wrapping up. bye!" --done > /dev/null 2>&1
) &
A_PID=$!

# let them talk, with a hard ceiling so the demo can never hang
SECS=0
while kill -0 "$A_PID" 2>/dev/null || kill -0 "$B_PID" 2>/dev/null; do
  sleep 0.5; SECS=$((SECS+1))
  if [ $SECS -ge 30 ]; then
    echo "[demo] HARD TIMEOUT — killing agents"; kill "$A_PID" "$B_PID" 2>/dev/null; break
  fi
done
echo "[demo] agents finished after ~$((SECS/2))s"
kill "$RELAY_PID" 2>/dev/null

# build an ordered transcript from the relay log (authoritative seq order)
node -e '
const fs=require("fs");
const out=["# Two-Agent Conversation (ordered by relay seq)",""];
for(const l of fs.readFileSync("relay.demo.log","utf8").split("\n")){
  const m=l.match(/msg #(\d+) from (\w+): (.*)$/);
  if(m) out.push(`#${m[1]}  ${m[2]} → ${m[3]}`);
}
fs.writeFileSync("conversation.log", out.join("\n")+"\n");
process.stdout.write(out.join("\n")+"\n");
'
echo ""
echo "[demo] full transcript written to conversation.log"
echo "[demo] per-agent inboxes: inbox.A.md (B's msgs), inbox.B.md (A's msgs)"
