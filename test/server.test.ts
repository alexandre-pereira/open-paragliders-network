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

test('posé pas OK : marqué sur la trace, public sur /sos, reçu sans nouveau point, annulé par le pilote', async () => {
  const me = { device: 'alerte-pilote-1', secret: SECRET, pilot: { first: 'Paul', last: 'Rey', wing: 'Rush 6' } };
  const t = now() - 20, token = 'd'.repeat(24);
  await post('/api/v1/points', { ...me, points: [[t, 45.5, 6.5, 1500, 0, 0, 0]] });
  await post('/api/v1/share', { ...me, token });
  assert.equal((await post('/api/v1/status', { ...me, state: 'autre' })).status, 400);
  assert.equal((await post('/api/v1/status', { ...me, state: 'sos' }, { 'X-App-Key': 'mauvaise' })).status, 401);
  const sub = await client({});
  sub.send({ op: 'sub', id: 9, center: [45.5, 6.5], radius: 20, every: 0.5 });
  await sub.next(m => m.op === 'upd' && m.id === 9);

  // personne à l'écoute d'autre chose : pas de point, et l'alerte arrive quand même
  assert.equal((await post('/api/v1/status', { ...me, state: 'sos', t: t + 5, lat: 45.51, lon: 6.51, alt: 1450 })).status, 200);
  const u = await sub.next(m => m.op === 'upd' && m.pilots.some((p: any) => p.p?.status?.state === 'sos'));
  assert.deepEqual(u.pilots.find((p: any) => p.p?.status).p.status, { state: 'sos', t: t + 5, lat: 45.51, lon: 6.51, alt: 1450 });

  // public, sans clé : le pilote, sa position, pas son appareil ni son logiciel
  const list = await (await fetch(base + '/api/v1/sos')).json();
  const mine = list.pilots.find((p: any) => p.p.first === 'Paul');
  assert.equal(mine.lat, 45.51);
  assert.ok(!JSON.stringify(list).includes('alerte-pilote'));
  assert.equal((await fetch(base + '/sos')).status, 200);
  assert.equal((await (await fetch(`${base}/api/v1/shared/${token}`)).json()).status.state, 'sos');

  // posé OK : plus sur la page publique, toujours sur la trace
  await post('/api/v1/status', { ...me, state: 'ok', t: t + 9 });
  assert.equal((await (await fetch(base + '/api/v1/sos')).json()).pilots.some((p: any) => p.p.first === 'Paul'), false);
  const ok = (await (await fetch(`${base}/api/v1/shared/${token}`)).json()).status;
  assert.equal(ok.state, 'ok');
  assert.equal(ok.lat, 45.5, 'sans position : son dernier point');

  // il redécolle : plus rien, et un profil modifié ne ramène pas l'état
  await post('/api/v1/status', { ...me, state: 'none' });
  assert.equal((await (await fetch(`${base}/api/v1/shared/${token}`)).json()).status, undefined);
  sub.ws.close();

  // le back-office retire une alerte, et un pilote bloqué n'apparaît pas
  await post('/api/v1/status', { ...me, state: 'sos' });
  const h = { Authorization: `Bearer ${ADMIN}` };
  const id = (await (await get('/api/v1/admin/pilots', h)).json()).pilots.find((p: any) => p.p.first === 'Paul').id;
  assert.equal((await post(`/api/v1/admin/pilots/${id}/clear`, {}, h)).status, 200);
  assert.equal((await (await fetch(base + '/api/v1/sos')).json()).pilots.some((p: any) => p.p.first === 'Paul'), false);
});

test('identifiants sur les autres réseaux : visibles des logiciels, pas du lien de suivi', async () => {
  const me = { device: 'ids-pilote-1', secret: SECRET, pilot: { first: 'Inès', ids: { FLARM: 'DD1234', puretrack: 'abc', 'x y': 'non', vide: '' } } };
  const token = 'e'.repeat(24);
  await post('/api/v1/points', { ...me, points: [[now() - 5, 44, 5, 1000, 0, 0, 0]] });
  await post('/api/v1/share', { ...me, token });
  const id = (await (await post('/api/v1/pilot', me)).json()).pilot;
  assert.deepEqual((await (await get(`/api/v1/pilots/${id}`)).json()).p.ids, { flarm: 'DD1234', puretrack: 'abc' });
  assert.equal((await (await fetch(`${base}/api/v1/shared/${token}`)).json()).p.ids, undefined);
  // un champ absent garde sa valeur, une liste vide efface
  await post('/api/v1/pilot', { ...me, pilot: { wing: 'Zeno' } });
  assert.deepEqual((await (await get(`/api/v1/pilots/${id}`)).json()).p.ids, { flarm: 'DD1234', puretrack: 'abc' });
  await post('/api/v1/pilot', { ...me, pilot: { ids: {} } });
  assert.equal((await (await get(`/api/v1/pilots/${id}`)).json()).p.ids, undefined);
});

test('logiciels au back-office : clé montrée une fois, renouvelée, révoquée, connexions coupées', async () => {
  const h = { Authorization: `Bearer ${ADMIN}` };
  assert.equal((await get('/api/v1/admin/apps', {})).status, 401);
  const made = await (await post('/api/v1/admin/apps', { name: 'XCTrack', contact: 'dev@xc.test' }, h)).json();
  assert.match(made.key, /^opn_/);
  assert.equal((await post('/api/v1/admin/apps', { name: 'XCTrack' }, h)).status, 400, 'nom déjà pris');
  assert.equal((await get('/api/v1/live', { 'X-App-Key': made.key })).status, 200);

  // jamais la clé ni son empreinte dans la liste ; les requêtes comptées
  const list = await (await get('/api/v1/admin/apps', h)).json();
  const row = list.apps.find((a: any) => a.name === 'XCTrack');
  assert.ok(row.requests >= 1 && row.seen > 0);
  assert.ok(!JSON.stringify(list).includes(made.key) && !('hash' in row));
  assert.ok(list.apps.some((a: any) => a.name === 'wsnav' && a.source === 'env'));

  // une connexion ouverte tombe à la révocation
  const c = await client({ key: made.key });
  assert.equal(c.welcome.op, 'welcome');
  const closed = new Promise<number>(ok => c.ws.once('close', code => ok(code)));
  assert.equal((await post(`/api/v1/admin/apps/${made.id}/revoke`, {}, h)).status, 200);
  assert.equal(await closed, 4001);
  assert.equal((await get('/api/v1/live', { 'X-App-Key': made.key })).status, 401);
  await post(`/api/v1/admin/apps/${made.id}/restore`, {}, h);
  assert.equal((await get('/api/v1/live', { 'X-App-Key': made.key })).status, 200);

  // nouvelle clé : l'ancienne meurt tout de suite
  const next = await (await post(`/api/v1/admin/apps/${made.id}/rotate`, {}, h)).json();
  assert.equal((await get('/api/v1/live', { 'X-App-Key': made.key })).status, 401);
  assert.equal((await get('/api/v1/live', { 'X-App-Key': next.key })).status, 200);
  const audit = (await (await get('/api/v1/admin/audit', h)).json()).audit.map((a: any) => a.action);
  assert.ok(audit.includes('logiciel révoqué') && audit.includes('clé renouvelée'));
  assert.equal((await post(`/api/v1/admin/apps/${made.id}/delete`, {}, h)).status, 200);
});

test('appareil banni : plus d’envoi, même effacé, mais il peut effacer ses données', async () => {
  const h = { Authorization: `Bearer ${ADMIN}` };
  const me = { device: 'banni-pilote-1', secret: SECRET, pilot: { first: 'Banni' } };
  const r = await (await post('/api/v1/points', { ...me, points: [[now() - 5, 44, 5, 1000, 0, 0, 0]] })).json();
  await post(`/api/v1/admin/pilots/${r.pilot}/block`, { blocked: true, reason: 'test' }, h);
  assert.equal((await post('/api/v1/points', { ...me, points: [[now() - 2, 44, 5, 1000, 0, 0, 0]] })).status, 403);
  assert.equal((await post('/api/v1/forget', me)).status, 200, 'le droit d’effacer reste');
  assert.equal((await post('/api/v1/points', { ...me, points: [[now() - 1, 44, 5, 1000, 0, 0, 0]] })).status, 403, 'effacé, il reste banni');
  const bans = (await (await get('/api/v1/admin/bans', h)).json()).bans;
  assert.ok(bans.some((b: any) => b.value === me.device && b.reason === 'test'));
  await post('/api/v1/admin/bans/lift', { kind: 'device', value: me.device }, h);
  assert.equal((await post('/api/v1/points', { ...me, points: [[now() - 1, 44, 5, 1000, 0, 0, 0]] })).status, 200);
});

test('sécurité des réponses : CSP, pas de CORS au back-office, pas de sortie de public/, adresse du proxy', async () => {
  const h = { Authorization: `Bearer ${ADMIN}` };
  assert.match(String((await fetch(base + '/admin/')).headers.get('content-security-policy')), /frame-ancestors 'none'/);
  assert.equal((await get('/api/v1/admin/stats', h)).headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(base + '/api/v1/admin/stats', { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), null);
  assert.equal((await get('/api/v1/live')).headers.get('access-control-allow-origin'), '*');
  assert.notEqual((await fetch(base + '/..%2f..%2fpackage.json')).status, 200);
  const { clientIp } = await import('../src/http.ts');
  const req = (xff: string) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.1' } }) as any;
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2'), true), '2.2.2.2', 'la première est choisie par le client');
  assert.equal(clientIp(req('1.1.1.1'), false), '10.0.0.1', 'sans proxy de confiance, l’en-tête ne compte pas');
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
  // comme le back-office : le mot de passe, sans clé de logiciel
  const admin = await client({ key: undefined, admin: ADMIN });
  assert.equal(admin.welcome.op, 'welcome');
  admin.send({ op: 'sub', id: 3 });
  const u = await admin.next(m => m.op === 'upd' && m.id === 3);
  assert.equal(u.pilots.find((p: any) => p.id === zoe.id)?.blocked, true);
  admin.ws.close();
  assert.equal((await fetch(base + '/admin/')).status, 200);
});
