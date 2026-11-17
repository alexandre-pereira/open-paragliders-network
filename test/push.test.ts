// Notifications d'un lien de suivi : chiffrement Web Push (déchiffré ici comme le ferait le navigateur), signature
// VAPID, abonnement par le lien, décollage, posé, posé OK, SOS, alerte levée, lien remplacé, abonnement fini.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { parseSub } from '../src/push.ts';
import { Service } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { encrypt, newVapidKeys, Vapid } from '../src/webpush.ts';

const T0 = 1_790_000_000;
const SECRET = 'secret-de-test-0123456789';
const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();

/** un navigateur : sa paire de clés, son secret, et le déchiffrement de RFC 8291 */
function browser(host = 'fcm.googleapis.com') {
  const e = createECDH('prime256v1');
  const pub = e.generateKeys(), auth = randomBytes(16);
  const sub = { endpoint: `https://${host}/fcm/send/${randomBytes(8).toString('hex')}`, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } };
  const decrypt = (msg: Buffer) => {
    const salt = msg.subarray(0, 16), idlen = msg[20], as = msg.subarray(21, 21 + idlen), ct = msg.subarray(21 + idlen);
    const ikm = hmac(hmac(auth, e.computeSecret(as)), Buffer.concat([Buffer.from('WebPush: info\0'), pub, as, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.equal(plain.at(-1), 2, 'dernier enregistrement');
    return plain.subarray(0, -1).toString();
  };
  return { sub, decrypt };
}

test('Web Push : le navigateur abonné déchiffre le message', () => {
  const b = browser();
  const msg = encrypt(Buffer.from('{"kind":"sos","name":"Zoé"}'), b.sub.keys.p256dh, b.sub.keys.auth);
  assert.equal(msg.readUInt32BE(16), 4096);
  assert.equal(b.decrypt(msg), '{"kind":"sos","name":"Zoé"}');
});

test('Web Push : l’exemple de la RFC 8291 (annexe A), à l’octet près', () => {
  const b = (s: string) => Buffer.from(s, 'base64url');
  const out = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { salt: b('DGv6ra1nlYgDCS1FRnbzlw'), privateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID : jeton ES256 signé par la clé du serveur, pour l’origine du service', () => {
  const keys = newVapidKeys(), v = new Vapid(keys, 'mailto:ops@example.org');
  const h = v.header('https://fcm.googleapis.com/fcm/send/abc', T0);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
  assert.ok(m);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: T0 + 12 * 3600, sub: 'mailto:ops@example.org' });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  assert.equal(v.header('https://fcm.googleapis.com/x', T0 + 60), h, 'même jeton tant qu’il vaut');
});

test('abonnement : seulement les services de notification des navigateurs', () => {
  const k = browser().sub.keys;
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com']) assert.ok(parseSub({ endpoint: `https://${host}/x`, keys: k }), host);
  for (const ep of ['https://evil.example/x', 'http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x', 'https://u:p@fcm.googleapis.com/x']) assert.equal(parseSub({ endpoint: ep, keys: k }), null, ep);
  assert.equal(parseSub({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'abc', auth: k.auth } }), null, 'clé fausse');
});

function make() {
  const svc = new Service(loadConfig({ DATA_DIR: '/tmp' }), new Store(':memory:'));
  let now = T0;
  svc.clock = () => now;
  const got: { endpoint: string; d: Record<string, unknown>; urgency: string }[] = [];
  let status = 201;
  svc.push.deliver = async (sub, payload, opts) => { got.push({ endpoint: sub.endpoint, d: payload as Record<string, unknown>, urgency: opts.urgency }); return status; };
  const settle = () => Promise.all([...svc.push.pending]);
  return { svc, got, settle, tick: (s: number) => { now += s; }, at: () => now, fail: (s: number) => { status = s; } };
}

test('lien de suivi : décollage, posé, posé OK, SOS, alerte levée ; lien remplacé, abonnement fini', async () => {
  const { svc, got, settle, tick, at, fail } = make();
  const dev = { device: 'pilote-push1', secret: SECRET, pilot: { first: 'Zoé', last: 'Martin' } };
  const token = 'A'.repeat(30), b = browser();
  svc.share({ ...dev, token });
  assert.throws(() => svc.pushLink('B'.repeat(30), { on: true, sub: b.sub }), /unknown-link/);
  assert.throws(() => svc.pushLink(token, { on: true, sub: { ...b.sub, endpoint: 'https://evil.example/x' } }), /bad-subscription/);
  assert.equal(svc.pushLink(token, { endpoint: b.sub.endpoint }).on, false);
  assert.equal(svc.pushLink(token, { on: true, sub: b.sub }).on, true);
  assert.equal(svc.pushLink(token, { endpoint: b.sub.endpoint }).on, true);

  // au déco (points au sol), puis en vol : un décollage, un seul
  const pt = (dt: number, gnd: boolean) => { const t = at() + dt; return gnd ? { t, lat: 45.9, lon: 6.1, alt: 1500, spd: 0, gnd: 1 } : [t, 45.9, 6.1 + dt * 0.0001, 1500, 10, 90, 0.5]; };
  svc.ingest({ ...dev, points: [pt(-20, true), pt(-10, true)] });
  tick(5);
  svc.ingest({ ...dev, points: [pt(-3, true), pt(-1, false), pt(0, false)] });
  tick(5);
  svc.ingest({ ...dev, points: [pt(0, false)] });
  await settle();
  assert.deepEqual(got.map(g => g.d.kind), ['takeoff']);
  assert.equal(got[0].d.name, 'Zoé Martin');
  assert.equal(got[0].d.t, at() - 6);
  assert.equal(got[0].d.k, (await import('node:crypto')).createHash('sha256').update(token).digest('hex').slice(0, 16));
  assert.equal(got[0].endpoint, b.sub.endpoint);

  // posé, puis « posé OK »
  tick(1800);
  svc.ingest({ ...dev, points: [pt(-1, false), pt(0, true)] });
  svc.setStatus({ ...dev, state: 'ok' });
  await settle();
  assert.deepEqual(got.map(g => g.d.kind), ['takeoff', 'landed', 'ok']);

  // SOS : urgent, avec l'endroit ; ses points (publics en SOS) ne font pas un décollage ; puis levée
  svc.setStatus({ ...dev, state: 'sos', lat: 45.95, lon: 6.2 });
  tick(400);
  svc.ingest({ ...dev, points: [pt(-1, true), pt(0, true)] });
  svc.setStatus({ ...dev, state: 'none' });
  await settle();
  assert.deepEqual(got.slice(3).map(g => [g.d.kind, g.urgency]), [['sos', 'high'], ['sosOff', 'high']]);
  assert.equal(got[3].d.lat, 45.95);

  // un nouveau lien coupe les abonnés de l'ancien
  svc.share({ ...dev, token: 'C'.repeat(30) });
  svc.setStatus({ ...dev, state: 'sos' });
  await settle();
  assert.equal(got.length, 5);
  assert.throws(() => svc.pushLink(token, { endpoint: b.sub.endpoint }), /unknown-link/);

  // réabonné au nouveau lien ; le service dit l'abonnement fini : retiré
  assert.equal(svc.pushLink('C'.repeat(30), { on: true, sub: b.sub }).on, true);
  fail(410);
  svc.setStatus({ ...dev, state: 'none' });
  await settle();
  assert.equal(svc.pushLink('C'.repeat(30), { endpoint: b.sub.endpoint }).on, false);
  assert.equal(svc.push.stats.gone, 1);

  // désabonné : plus rien ; le pilote effacé : ses abonnés aussi
  fail(201);
  svc.pushLink('C'.repeat(30), { on: true, sub: b.sub });
  assert.equal(svc.pushLink('C'.repeat(30), { on: false, endpoint: b.sub.endpoint }).on, false);
  svc.setStatus({ ...dev, state: 'sos' });
  await settle();
  assert.equal(got.length, 6, 'seulement l’envoi refusé (410)');
});

test('sans marque au sol : décollage et posé lus dans la trace découpée en vols', async () => {
  const { svc, got, settle, tick, at } = make();
  const dev = { device: 'pilote-push2', secret: SECRET, pilot: { first: 'Léa' } };
  svc.share({ ...dev, token: 'D'.repeat(30) });
  svc.pushLink('D'.repeat(30), { on: true, sub: browser().sub });
  // 5 min immobile au déco, puis 3 min en l'air, puis 6 min posé ; un envoi toutes les 30 s
  let lon = 6.1;
  const send = (n: number, spd: number, alt: (i: number) => number) => {
    for (let k = 0; k < n; k++) {
      const pts = [];
      for (let i = 0; i < 30; i += 3) { lon += spd * 3 / 78000; pts.push([at() - 30 + i, 45.9, lon, alt(i), spd, 90, 0]); }
      svc.ingest({ ...dev, points: pts });
      tick(30);
    }
  };
  send(10, 0, () => 1500);
  send(6, 10, i => 1500 - i);
  await settle();
  assert.deepEqual(got.map(g => g.d.kind), ['takeoff'], 'en vol après une minute de mouvement');
  send(12, 0, () => 600);
  await settle();
  assert.deepEqual(got.map(g => g.d.kind), ['takeoff', 'landed']);
  assert.equal(got[0].d.name, 'Léa');
});
