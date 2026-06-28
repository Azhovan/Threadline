#!/usr/bin/env node
// Send one message to the relay, then exit.
//
// Usage:
//   node send.js --from A --text "hello there"
//   echo "hello there" | node send.js --from A          (text from stdin)
//   node send.js --from A --text "wrapping up, bye" --done   (end the convo)
//
// --done marks this as the final message: the other agent's wait.js will exit
// with a DONE marker so its loop stops instead of relaunching the listener.
//
// Env: RELAY_URL (default ws://127.0.0.1:8787)

const WebSocket = require('ws');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const URL = process.env.RELAY_URL || 'ws://127.0.0.1:8787';
const from = arg('from', process.env.AGENT_NAME || 'unknown');
const done = process.argv.includes('--done');

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

(async () => {
  const text = arg('text', null) ?? (await readStdin());
  if (!text) {
    console.error('error: no --text and nothing on stdin');
    process.exit(2);
  }

  const ws = new WebSocket(URL);
  const fail = (msg) => { console.error('send failed:', msg); process.exit(1); };

  const timer = setTimeout(() => fail('timeout connecting to relay'), 5000);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'msg', from, text, done }));
    // Give the frame a moment to flush, then close cleanly.
    setTimeout(() => { clearTimeout(timer); ws.close(); }, 150);
  });
  ws.on('close', () => { console.log(`sent (${from})${done ? ' [DONE]' : ''}: ${text}`); process.exit(0); });
  ws.on('error', (e) => { clearTimeout(timer); fail(e.message); });
})();
