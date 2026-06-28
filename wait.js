#!/usr/bin/env node
// Wake-on-message waiter.
//
// Connects to the relay, replays messages newer than the last seq we recorded,
// then BLOCKS until at least one fresh message arrives. On arrival it appends
// the message(s) to inbox.md, advances the seq cursor, prints them, and EXITS.
//
// Run this as a background task. Its exit is the "wake" signal: the agent is
// re-invoked, reads inbox.md, decides on a reply, then relaunches wait.js.
//
// Usage: node wait.js --from A [--idle 600]
//   --from   this agent's name (used as the relay identity + state file)
//   --idle   seconds to wait for a message before giving up (default 900)
//
// Env: RELAY_URL (default ws://127.0.0.1:8787)

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const URL = process.env.RELAY_URL || 'ws://127.0.0.1:8787';
const from = arg('from', process.env.AGENT_NAME || 'unknown');
const idleMs = parseInt(arg('idle', '900'), 10) * 1000;
const fresh = process.argv.includes('--fresh'); // join at live head, skip backlog

// Inbox + cursor are written to COMM_DIR if set, else the current working
// directory — so an agent running anywhere gets its inbox in its own folder.
const dir = process.env.COMM_DIR || process.cwd();
const inboxPath = path.join(dir, `inbox.${from}.md`);
const seqPath = path.join(dir, `.seq.${from}`);

function readSeq() {
  try { return parseInt(fs.readFileSync(seqPath, 'utf8').trim(), 10) || -1; }
  catch { return -1; }
}
function writeSeq(n) { fs.writeFileSync(seqPath, String(n)); }

function appendInbox(item) {
  const tag = item.done ? ' — DONE' : '';
  const line = `\n---\n**[#${item.seq}] from ${item.from}${tag}** _(${item.ts})_\n\n${item.text}\n`;
  fs.appendFileSync(inboxPath, line);
}

let lastSeq = readSeq();
const received = [];
let settleTimer = null;

const ws = new WebSocket(URL);
const idleTimer = setTimeout(() => {
  // No message within the idle window — exit quietly so the agent can decide
  // whether to keep waiting. Exit code 0 with a marker on stdout.
  console.log(`[wait] idle timeout after ${idleMs / 1000}s, no new messages`);
  try { ws.close(); } catch {}
  process.exit(0);
}, idleMs);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', from, since: lastSeq, fresh }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type !== 'msg') return;
  if (msg.seq <= lastSeq) return; // already seen
  if (msg.from === from) { // ignore our own messages replayed from backlog
    if (msg.seq > lastSeq) { lastSeq = msg.seq; writeSeq(lastSeq); }
    return;
  }

  received.push(msg);
  appendInbox(msg);
  if (msg.seq > lastSeq) lastSeq = msg.seq;
  writeSeq(lastSeq);

  // Settle window: if several messages arrive together, collect them all
  // before waking (avoids one wake per line). 400ms of quiet => done.
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    clearTimeout(idleTimer);
    const ended = received.some((m) => m.done);
    console.log(`[wait] ${received.length} new message(s); inbox -> ${path.basename(inboxPath)}`);
    for (const m of received) {
      console.log(`  #${m.seq} ${m.from}${m.done ? ' [DONE]' : ''}: ${m.text.replace(/\n/g, ' ').slice(0, 120)}`);
    }
    if (ended) {
      // The other agent signaled end-of-conversation. Emit a distinct marker so
      // the agent loop STOPS here instead of relaunching the listener.
      console.log('[wait] DONE — conversation ended by peer; do not relaunch.');
    }
    try { ws.close(); } catch {}
    process.exit(ended ? 3 : 0);
  }, 400);
});

ws.on('error', (e) => {
  clearTimeout(idleTimer);
  console.error('[wait] error:', e.message);
  process.exit(1);
});
