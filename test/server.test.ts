import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.ts';
import { start, type Running } from '../src/server.ts';

const KEY = 'cle-de-test-wsnav';
const ADMIN = 'admin-de-test-0123456789';
const SECRET = 'secret-de-test-0123456789';
let run: Running, base: string;

before(async () => {
  run = await start(loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: '/tmp/open-paragliders-network-test', APP_KEYS: `wsnav:${KEY}`, ADMIN_TOKEN: ADMIN, MIN_PUSH_EVERY: '0.5' }), ':memory:');
  base = `http://127.0.0.1:${run.port}`;
});
after(() => run.close());

const now = () => Math.floor(Date.now() / 1000);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Key': KEY, ...headers }, body: JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = { 'X-App-Key': KEY }) => fetch(base + path, { headers });

/** un client WebSocket qui range les messages reçus */
async function client(hello: Record<string, unknown>) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/ws');
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; ok: (m: any) => void }[] = [];
  ws.on('message', d => {
    const m = JSON.parse(String(d));
    const w = waiters.findIndex(x => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].ok(m); else inbox.push(m);
  });
  await new Promise(ok => ws.once('open', ok));
  const next = (pred: (m: any) => boolean, ms = 4000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise<any>((ok, ko) => { waiters.push({ pred, ok }); setTimeout(() => ko(new Error('pas de message')), ms); });
  };
  ws.send(JSON.stringify({ op: 'hello', key: KEY, ...hello }));
  const welcome = await next(m => m.op === 'welcome' || m.op === 'err');
  return { ws, next, welcome, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

test('lien de suivi : un par pilote, l’ancien meurt, ni clé ni autre pilote', async () => {
  const me = { device: 'lien-de-suivi-1', secret: SECRET, pilot: { first: 'Inès', last: 'Roux', wing: 'Enzo 3' }, app: 'WS Nav 1.4' };
  const A = 'a'.repeat(24), B = 'b'.repeat(24), t = now() - 30;
  assert.equal((await post('/api/v1/share', { ...me, token: 'court' })).status, 400);
  assert.equal((await post('/api/v1/share', { ...me, token: A }, { 'X-App-Key': 'mauvaise' })).status, 401);
  assert.equal((await post('/api/v1/share', { ...me, token: A })).status, 200);
  await post('/api/v1/points', { ...me, points: [[t, 45.9, 6.1, 1500, 10, 90, 1], [t + 10, 45.91, 6.1, 1510, 10, 90, 1]] });
  await post('/api/v1/points', { device: 'lien-de-suivi-2', secret: SECRET, points: [[t, 46, 7, 2000, 10, 90, 1]] });

  // aucune clé : le jeton suffit, et il ne montre que son pilote, sans identifiant ni logiciel
  const r = await fetch(`${base}/api/v1/shared/${A}`), d = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(d.p, { first: 'Inès', last: 'Roux', wing: 'Enzo 3', type: 'paraglider' });
  assert.equal(d.pts.length, 2);
  assert.ok(!/lien-de-suivi|WS Nav|pilot"/.test(JSON.stringify(d)));
  assert.equal((await (await fetch(`${base}/api/v1/shared/${A}?since=${t}`)).json()).pts.length, 1, 'seulement la suite');

  // redonner le même : rien ne change ; un autre pilote ne le prend pas
  assert.equal((await post('/api/v1/share', { ...me, token: A })).status, 200);
  assert.equal((await post('/api/v1/share', { device: 'lien-de-suivi-2', secret: SECRET, token: A })).status, 409);

  // régénéré : l'ancien cesse de marcher tout de suite, comme un jeton inconnu
  assert.equal((await post('/api/v1/share', { ...me, token: B })).status, 200);
  const old = await fetch(`${base}/api/v1/shared/${A}`);
  assert.equal(old.status, 404);
  assert.deepEqual(await old.json(), await (await fetch(`${base}/api/v1/shared/${'c'.repeat(24)}`)).json());
  assert.equal((await fetch(`${base}/api/v1/shared/${B}`)).status, 200);

  // la base n'a que l'empreinte, le jeton n'y est pas
  assert.ok(!JSON.stringify(run.svc.store.db.prepare('SELECT * FROM shares').all()).includes(B));
  const page = await fetch(`${base}/p/${B}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(String(page.headers.get('x-robots-tag')), /noindex/);
  assert.match(await page.text(), /track\.js/);

  // « oublie-moi » tue le lien ; le même jeton redonné plus tard le rétablit (profil oublié au bout de 90 jours)
  await post('/api/v1/forget', me);
  assert.equal((await fetch(`${base}/api/v1/shared/${B}`)).status, 404);
  assert.equal((await post('/api/v1/share', { ...me, token: B })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/shared/${B}`)).status, 200);
});

test('clé de logiciel exigée', async () => {
  assert.equal((await get('/api/v1/live', {})).status, 401);
  assert.equal((await get('/api/v1')).status, 200, 'la description reste ouverte');
  assert.equal((await get('/api/v1/live', { 'X-WSNav-Key': KEY })).status, 200, 'en-tête des serveurs WeSoar');
  const info = await (await get('/api/v1')).json();
  assert.equal(info.protocol, 1);
});

test('HTTP : envoi, doublons, direct, suite avec since, GeoJSON, trace', async () => {
  const t = now();
  const pts = Array.from({ length: 20 }, (_, i) => [t - 60 + i * 3, 45.9, 6.1 + i * 0.001, 1500, 10, 90, 1]);
  const r = await (await post('/api/v1/points', { device: 'wsnav-http01', secret: SECRET, app: 'WS Nav 1.4', pilot: { first: 'Alex', last: 'Pereira', wing: 'Zeno 2' }, points: pts })).json();
  assert.equal(r.stored, 20);
  const again = await (await post('/api/v1/points', { device: 'wsnav-http01', secret: SECRET, points: pts })).json();
  assert.equal(again.dup, 20);

  const snap = await (await get('/api/v1/live?center=45.9,6.1&radius=50&trail=600')).json();
  const me = snap.pilots.find((p: any) => p.id === r.pilot);
  assert.equal(me.pts.length, 20);
  assert.equal(me.p.wing, 'Zeno 2');

  // la suite : seulement le point nouveau
  await post('/api/v1/points', { device: 'wsnav-http01', secret: SECRET, points: [[t, 45.9, 6.2, 1600]] });
  const d = await (await get(`/api/v1/live?center=45.9,6.1&radius=50&since=${snap.seq}`)).json();
  assert.deepEqual(d.pilots.find((p: any) => p.id === r.pilot).pts.map((x: number[]) => x[0]), [t]);
  assert.equal((await (await get('/api/v1/live?since=1')).json()).reset, undefined);

  const gj = await (await get('/api/v1/live.geojson?bbox=5,45,7,47')).json();
  assert.equal(gj.type, 'FeatureCollection');
  assert.ok(gj.features.some((f: any) => f.geometry.type === 'LineString' && f.properties.name === 'Alex Pereira'));

  const tr = await (await get(`/api/v1/pilots/${r.pilot}/track`)).json();
  assert.equal(tr.pts.length, 21);
});

test('HTTP : corps compressé en gzip (gros arriéré après une coupure)', async () => {
  const t = now();
  const pts = Array.from({ length: 2400 }, (_, i) => [t - 7200 + i * 3, 46, 7 + i * 1e-4, 2000]);
  const res = await fetch(base + '/api/v1/points', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-App-Key': KEY },
    body: gzipSync(JSON.stringify({ device: 'wsnav-gzip01', secret: SECRET, points: pts })),
  });
  assert.equal((await res.json()).stored, 2400);
});

test('WebSocket : envoi par la connexion, réception en direct d’un autre pilote', async () => {
  const watcher = await client({ app: 'test' });
  assert.equal(watcher.welcome.op, 'welcome');
  watcher.send({ op: 'sub', id: 1, center: [44.5, 5.5], radius: 30, trail: 600, every: 0.5 });
  const first = await watcher.next(m => m.op === 'upd' && m.id === 1);
  assert.deepEqual(first.pilots, []);

  const pilot = await client({ device: 'wsnav-ws0001', secret: SECRET, app: 'WS Nav', pilot: { first: 'Zoé', last: 'Martin', wing: 'Enzo 3' } });
  assert.ok(pilot.welcome.pilot);
  const t = now();
  pilot.send({ op: 'pts', id: 7, pts: [[t - 6, 44.5, 5.5, 1000], [t - 3, 44.5, 5.501, 1001]] });
  const ack = await pilot.next(m => m.op === 'ack' && m.id === 7);
  assert.equal(ack.stored, 2);

  const u = await watcher.next(m => m.op === 'upd' && m.pilots.length);
  assert.equal(u.pilots[0].trail, true);
  assert.equal(u.pilots[0].p.first, 'Zoé');
  assert.equal(u.pilots[0].pts.length, 2);

  pilot.send({ op: 'pts', id: 8, pts: [[t, 44.5, 5.502, 1002]] });
  const u2 = await watcher.next(m => m.op === 'upd' && m.pilots.length);
  assert.equal(u2.pilots[0].pts.length, 1);
  assert.equal(u2.pilots[0].p, undefined);

  // coupure du spectateur : il revient avec son curseur, reçoit les 2 points manqués
  watcher.ws.close();
  pilot.send({ op: 'pts', id: 9, pts: [[t + 1, 44.5, 5.503, 1003], [t + 2, 44.5, 5.504, 1004]] });
  await pilot.next(m => m.op === 'ack' && m.id === 9);
  const back = await client({});
  back.send({ op: 'sub', id: 2, center: [44.5, 5.5], radius: 30, since: u2.seq });
  const r = await back.next(m => m.op === 'upd' && m.id === 2);
  assert.equal(r.reset, undefined);
  assert.deepEqual(r.pilots[0].pts.map((x: number[]) => x[0]), [t + 1, t + 2]);

  back.send({ op: 'ping', t: 42 });
  assert.equal((await back.next(m => m.op === 'pong')).t, 42);
  pilot.ws.close(); back.ws.close();
});

test('WebSocket : mauvaise clé, opération inconnue', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/ws');
  await new Promise(ok => ws.once('open', ok));
  ws.send(JSON.stringify({ op: 'hello', key: 'mauvaise' }));
  const code = await new Promise(ok => ws.once('close', c => ok(c)));
  assert.equal(code, 4001);
  const c = await client({});
  c.send({ op: 'danse' });
  assert.equal((await c.next(m => m.op === 'err')).code, 'unknown-op');
  c.ws.close();
});

test('LiveTrack24 (XCSoar, LK8000)', async () => {
  const lt = (q: string) => fetch(`${base}/track.php?${q}`).then(r => r.text());
  const id = await fetch(`${base}/client.php?op=login&user=jdupont&pass=motdepasse`).then(r => r.text());
  assert.match(id, /^[1-9]\d*$/);
  assert.equal(await fetch(`${base}/client.php?op=login&user=jdupont&pass=autre`).then(r => r.text()), '0');
  assert.equal(await lt('leolive=2&sid=2147483999&pid=1&client=XCSoar&v=7.43&user=jdupont&pass=motdepasse&phone=x&gps=x&trk1=5&vtype=1&vname=Ozone%20Rush%206'), 'OK');
  const t = now();
  assert.equal(await lt(`leolive=4&sid=2147483999&pid=2&lat=45.1&lon=5.9&alt=2100&sog=36&cog=180&tm=${t}`), 'OK');
  assert.equal(await lt('leolive=3&sid=2147483999&pid=3&prid=0'), 'OK');
  const snap = await (await get('/api/v1/live?bbox=5.5,44.9,6.3,45.3')).json();
  const p = snap.pilots.find((x: any) => x.id === id);
  assert.equal(p.p.wing, 'Ozone Rush 6');
  assert.equal(p.p.app, 'XCSoar 7.43');
  assert.deepEqual(p.pts[0], [t, 45.1, 5.9, 2100, 10, 180, null]);
});

test('back-office : mot de passe, traces, blocage', async () => {
  assert.equal((await get('/api/v1/admin/stats', {})).status, 401);
  const h = { Authorization: `Bearer ${ADMIN}` };
  const stats = await (await get('/api/v1/admin/stats', h)).json();
  assert.ok(stats.points > 0);
  const tr = await (await get(`/api/v1/admin/tracks?from=${now() - 3 * 3600}`, h)).json();
  assert.ok(tr.pilots.length >= 3);
  const list = await (await get('/api/v1/admin/pilots', h)).json();
  const zoe = list.pilots.find((p: any) => p.p.first === 'Zoé');
  assert.equal((await post(`/api/v1/admin/pilots/${zoe.id}/block`, { blocked: true }, h)).status, 200);
  const snap = await (await get('/api/v1/live')).json();
  assert.equal(snap.pilots.find((p: any) => p.id === zoe.id), undefined);
  const admin = await client({ admin: ADMIN });
  admin.send({ op: 'sub', id: 3 });
  const u = await admin.next(m => m.op === 'upd' && m.id === 3);
  assert.equal(u.pilots.find((p: any) => p.id === zoe.id)?.blocked, true);
  admin.ws.close();
  assert.equal((await fetch(base + '/admin/')).status, 200);
});
