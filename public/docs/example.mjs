// A complete client of Open Paragliders Network: everything the integration guide describes, in one file. A simulated
// pilot sends through a queue, receives the pilots around, resumes after a cut, gets a tracking link, says how the
// flight ended and erases everything on leaving. Node 22 or later, nothing to install.
//
//   node example.mjs https://<server> <key> [lat] [lon] [seconds]
//
// It never sends "sos": that state is public. A real app keeps `device`, `secret` and the token on the device.

import { randomBytes } from 'node:crypto';

const [server, key = '', lat0 = '45.9', lon0 = '6.1', seconds = '60'] = process.argv.slice(2);
if (!server) { console.error('node example.mjs https://<server> <key> [lat] [lon] [seconds]'); process.exit(1); }

// ── 1. identity: drawn once, kept for ever ──────────────────────────────────────────────────────────────────────────
const device = 'example-' + randomBytes(4).toString('hex');
const secret = randomBytes(16).toString('hex');
const app = 'Example 1.0';
const pilot = { name: 'Example Pilot', wing: 'Example Wing', type: 'paraglider' };

const post = (path, body) => fetch(server + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
});

// ── 2. sending: a queue; a fix leaves it only once the server has answered ──────────────────────────────────────────
const FIX_EVERY = 3000, HTTP_EVERY = 15000, BATCH = 1000;
const queue = [];
let lat = Number(lat0), lon = Number(lon0), alt = 1500;
let ws = null, ready = false, inflight = null, nextId = 1, leaving = false;

setInterval(() => {
  lat += 0.0003; lon += 0.0002; alt += 2;
  queue.push([Math.floor(Date.now() / 1000), +lat.toFixed(6), +lon.toFixed(6), alt, 11, 35, 0.7]);
  sendBySocket();
}, FIX_EVERY);

/** one batch at a time: the next one leaves on its ack */
function sendBySocket() {
  if (!ready || inflight || !queue.length) return;
  inflight = { id: nextId++, n: Math.min(queue.length, BATCH) };
  ws.send(JSON.stringify({ op: 'pts', id: inflight.id, pts: queue.slice(0, inflight.n) }));
}

/** no socket: the same queue over HTTP */
async function sendByHttp() {
  if (ready || !queue.length) return;
  const n = Math.min(queue.length, BATCH);
  try {
    const r = await post('/api/v1/points', { device, secret, app, pilot, points: queue.slice(0, n) });
    if (r.ok) { queue.splice(0, n); console.log('sent by HTTP', await r.json()); return; }
    // what can never be accepted is dropped, or it would block the queue for ever
    if (r.status >= 400 && r.status < 500 && ![401, 403, 408, 425, 429].includes(r.status)) queue.splice(0, n);
    console.log('refused', r.status, await r.text());
  } catch (e) { console.log('no answer, the fixes stay in the queue:', e.message); }
}
setInterval(sendByHttp, HTTP_EVERY);

// ── 3. receiving: one WebSocket, resumed from the cursor ────────────────────────────────────────────────────────────
const PING_EVERY = 15000, PONG_WAIT = 10000, MAX_BACKOFF = 30000;
const pilots = new Map();
let me = null, seq = null, backoff = 1000, pingAt = 0, pongAt = 0;

function merge(u) {
  if (typeof u.seq === 'number') seq = u.seq;
  if (u.reset) pilots.clear();
  for (const x of u.pilots) {
    if (x.gone) { pilots.delete(x.id); continue; }
    if (x.id === me) continue;                                 // my own echo
    const cur = pilots.get(x.id) ?? { p: null, pts: new Map() };
    if (x.p) cur.p = x.p;
    for (const f of x.pts ?? []) cur.pts.set(f[0], f);         // by time: a pilot back in coverage sends older fixes
    pilots.set(x.id, cur);
  }
  console.log(`seq ${seq}: ${pilots.size} pilot(s) around: ` + [...pilots.values()].map(v => `${v.p?.first ?? '?'} ${v.p?.last ?? ''} (${v.pts.size} fixes)`).join(', '));
}

function connect() {
  ws = new WebSocket(server.replace(/^http/, 'ws') + '/api/v1/ws');
  ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', key, app, device, secret, pilot }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.op === 'welcome') {
      console.log('welcome: my pilot id is', m.pilot);
      me = m.pilot; ready = true; backoff = 1000;
      ws.send(JSON.stringify({ op: 'sub', center: [lat, lon], radius: 50, trail: 600, every: 3, ...(seq !== null ? { since: seq } : {}) }));
      sendBySocket();
    }
    if (m.op === 'ack' && m.id === inflight?.id) { queue.splice(0, inflight.n); inflight = null; console.log('ack', m.stored, 'stored'); sendBySocket(); }
    if (m.op === 'upd') merge(m);
    if (m.op === 'pong') pongAt = Date.now();
    if (m.op === 'err') { console.log('server says:', m.code, m.message ?? ''); inflight = null; }
  };
  ws.onclose = e => {
    ready = false; inflight = null;
    if (leaving) return;
    console.log(`socket closed (${e.code}), again in ${backoff / 1000} s`);
    setTimeout(connect, backoff);
    backoff = Math.min(MAX_BACKOFF, backoff * 2);
  };
  ws.onerror = () => { /* onclose follows */ };
}

// a mobile link often stays "open" while nothing passes: no pong, the socket is dead
setInterval(() => {
  if (!ready) return;
  if (pingAt && pongAt < pingAt && Date.now() - pingAt > PONG_WAIT) { ws.close(); return; }
  pingAt = Date.now();
  ws.send(JSON.stringify({ op: 'ping', t: pingAt }));
}, PING_EVERY);

connect();

// ── 4. the tracking link: real only once the server has answered ────────────────────────────────────────────────────
const token = randomBytes(16).toString('base64url');
const shared = await post('/api/v1/share', { device, secret, app, pilot, token });
console.log(shared.ok ? `tracking link: ${server}/p/${token}` : `no tracking link: ${shared.status}`);

// ── 5. leaving: how the flight ended, then everything erased ────────────────────────────────────────────────────────
setTimeout(async () => {
  leaving = true;
  ready = false;
  await sendByHttp();
  const ok = await post('/api/v1/status', { device, secret, state: 'ok', lat, lon, alt });
  console.log('landed OK:', ok.status);
  const gone = await post('/api/v1/forget', { device, secret });
  console.log('forgotten:', gone.status);
  process.exit(0);
}, Number(seconds) * 1000);
