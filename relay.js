#!/usr/bin/env node
// Relay server: a tiny WebSocket hub both terminal agents connect to.
// It broadcasts every message to all *other* connected clients and keeps a
// short backlog so a client can replay messages it missed while offline.
//
// Usage: node relay.js [port]
//   PORT env or argv[2] sets the port (default 9000).

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2] || process.env.PORT || '9000', 10);
const BACKLOG_MAX = 500;

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
const backlog = []; // { seq, from, text, ts }
let seq = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

wss.on('connection', (ws, req) => {
  ws.meta = { name: 'unknown', addr: req.socket.remoteAddress };
  log('client connected', ws.meta.addr);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON
    }

    // Control frames -------------------------------------------------------
    if (msg.type === 'hello') {
      ws.meta.name = msg.from || 'unknown';
      log('hello from', ws.meta.name, msg.fresh ? '(fresh: skip backlog)' : '');
      // fresh = join at the live head; don't replay any backlog history.
      if (msg.fresh) return;
      // Replay backlog the client hasn't seen yet (since = last seq it has).
      const since = Number.isFinite(msg.since) ? msg.since : -1;
      for (const item of backlog) {
        if (item.seq > since) ws.send(JSON.stringify({ type: 'msg', ...item }));
      }
      return;
    }

    // Chat messages --------------------------------------------------------
    if (msg.type === 'msg') {
      const item = {
        seq: ++seq,
        from: msg.from || ws.meta.name || 'unknown',
        text: String(msg.text ?? ''),
        done: !!msg.done, // conversation-end sentinel, carried through to clients
        ts: new Date().toISOString(),
      };
      backlog.push(item);
      if (backlog.length > BACKLOG_MAX) backlog.shift();
      log(`msg #${item.seq} from ${item.from}: ${item.text.slice(0, 80)}`);

      const payload = JSON.stringify({ type: 'msg', ...item });
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === client.OPEN) {
          client.send(payload);
        }
      }
    }
  });

  ws.on('close', () => log('client disconnected', ws.meta.name));
  ws.on('error', (e) => log('client error', ws.meta.name, e.message));
});

wss.on('listening', () => log(`relay listening on ws://127.0.0.1:${PORT}`));
wss.on('error', (e) => {
  log('server error', e.message);
  process.exit(1);
});

process.on('SIGINT', () => { log('shutting down'); wss.close(() => process.exit(0)); });
process.on('SIGTERM', () => { log('shutting down'); wss.close(() => process.exit(0)); });
