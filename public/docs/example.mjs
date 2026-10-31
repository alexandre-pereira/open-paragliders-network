// A complete client of Open Paragliders Network: sends a simulated pilot through a queue, receives the pilots around,
// creates a tracking link. Node 22 or later, nothing to install.
//   node example.mjs https://<server> <key> [lat] [lon]
// Keep `device`, `secret` and the token on the device in a real app; here they last as long as the run.

import { randomBytes } from 'node:crypto';

const [server, key, lat0 = '45.9', lon0 = '6.1'] = process.argv.slice(2);
if (!server) { console.error('node example.mjs https://<server> <key> [lat] [lon]'); process.exit(1); }

const device = 'example-' + randomBytes(4).toString('hex');
const secret = randomBytes(16).toString('hex');
const app = 'Example 1.0';
const pilot = { name: 'Example Pilot', wing: 'Example Wing', type: 'paraglider' };
const post = (path, body) => fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Key': key }, body: JSON.stringify(body) });

// sending: a fix every 3 s in the queue; a fix leaves the queue only once the server has answered
const queue = [];
let lat = Number(lat0), lon = Number(lon0), alt = 1500;
setInterval(() => {
  lat += 0.0003; lon += 0.0002; alt += 2;
  queue.push([Math.floor(Date.now() / 1000), +lat.toFixed(6), +lon.toFixed(6), alt, 11, 35, 0.7]);
}, 3000);
setInterval(async () => {
  if (!queue.length) return;
  const n = Math.min(queue.length, 1000);
  try {
    const r = await post('/api/v1/points', { device, secret, app, pilot, points: queue.slice(0, n) });
    if (r.ok) { queue.splice(0, n); console.log('sent', await r.json()); }
    else console.log('refused', r.status, await r.text());
  } catch (e) { console.log('no answer, kept for the next try:', e.message); }
}, 6000);

// the tracking link: real only once the server has answered
await post('/api/v1/points', { device, secret, app, pilot, points: [] });
const token = randomBytes(16).toString('base64url');
const r = await post('/api/v1/share', { device, secret, token });
console.log(r.ok ? `tracking link: ${server}/p/${token}` : `no tracking link: ${r.status}`);

// receiving: one WebSocket, resumed from the cursor after a cut
let seq = null;
const pilots = new Map();
function connect() {
  const ws = new WebSocket(server.replace(/^http/, 'ws') + '/api/v1/ws');
  ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', key, app, device, secret }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.op === 'welcome') ws.send(JSON.stringify({ op: 'sub', center: [lat, lon], radius: 50, trail: 600, every: 3, ...(seq !== null ? { since: seq } : {}) }));
    if (m.op === 'err') console.log('server says:', m.code, m.message ?? '');
    if (m.op !== 'upd') return;
    seq = m.seq;
    if (m.reset) pilots.clear();
    for (const x of m.pilots) {
      if (x.gone) { pilots.delete(x.id); continue; }
      const cur = pilots.get(x.id) ?? { p: null, pts: new Map() };
      if (x.p) cur.p = x.p;
      // merged by time: a pilot back in coverage sends older fixes
      for (const f of x.pts ?? []) cur.pts.set(f[0], f);
      pilots.set(x.id, cur);
    }
    console.log(`seq ${seq}: ${pilots.size} pilot(s) around:`, [...pilots.values()].map(v => `${v.p?.first ?? ''} ${v.p?.last ?? ''} (${v.pts.size})`.trim()).join(', '));
  };
  ws.onclose = () => { console.log('socket closed, reconnecting'); setTimeout(connect, 2000); };
}
connect();
