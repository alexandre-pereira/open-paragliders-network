import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { parseFix, inBox, boxAround, parseArea } from '../src/fix.ts';
import { mergeProfile, EMPTY_PROFILE } from '../src/profile.ts';
import { Service, HttpError } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { newSub } from '../src/http.ts';

const T0 = 1_790_000_000;
const SECRET = 'secret-de-test-0123456789';

function make(env: Record<string, string> = {}) {
  const cfg = loadConfig({ DATA_DIR: '/tmp', ...env });
  const svc = new Service(cfg, new Store(':memory:'));
  let now = T0;
  svc.clock = () => now;
  return { svc, cfg, tick: (s: number) => { now += s; }, at: () => now };
}
/** un vol en ligne droite vers l'est depuis Annecy, un point toutes les 3 s */
const flight = (t0: number, n: number, lat = 45.9, lon = 6.1, every = 3) =>
  Array.from({ length: n }, (_, i) => [t0 + i * every, lat, lon + i * 0.0005, 1500 + i, 10, 90, 0.5]);

test('parseFix : formats, bornes, valeurs fausses', () => {
  assert.deepEqual(parseFix([T0, 45.123456789, 6.5, 1234.56, 11.234, 365, -2.5], T0, T0 - 3600), { ts: T0, lat: 45.123457, lon: 6.5, alt: 1234.6, spd: 11.23, crs: 5, vz: -2.5 });
  assert.equal(parseFix({ ts: T0 * 1000, lat: 45, lng: 6 }, T0, T0 - 3600)?.ts, T0, 'millisecondes');
  assert.equal(parseFix([T0 + 3600, 45, 6], T0, T0 - 3600), null, 'futur');
  assert.equal(parseFix([T0 - 7200, 45, 6], T0, T0 - 3600), null, 'trop vieux');
  assert.equal(parseFix([T0, 0, 0], T0, T0 - 3600), null, 'GPS sans fix');
  assert.equal(parseFix([T0, 95, 6], T0, T0 - 3600), null);
  assert.equal(parseFix([T0, 45, 6, 99999, 900, null, 300], T0, T0 - 3600)?.alt, null);
  assert.equal(parseFix('x', T0, 0), null);
});

test('zones : boîte, antiméridien, rayon', () => {
  assert.ok(inBox([170, -10, -170, 10], 0, 179));
  assert.ok(inBox([170, -10, -170, 10], 0, -175));
  assert.ok(!inBox([170, -10, -170, 10], 0, 0));
  const b = boxAround(45.9, 6.1, 50);
  assert.ok(inBox(b, 46.2, 6.5) && !inBox(b, 46.5, 6.1));
  assert.equal(parseArea('1,2,3'), 'invalid');
  assert.deepEqual(parseArea('5,45,7,46'), [5, 45, 7, 46]);
  assert.equal(parseArea(undefined), null);
});

test('profil : prénom, nom, voile, nom complet', () => {
  const p = mergeProfile(EMPTY_PROFILE, { firstName: ' Alex ', lastName: 'Pereira', wing: 'Ozone\u0000 Zeno 2', type: 'hangglider' }, 'WS Nav 1.4');
  assert.deepEqual(p, { first: 'Alex', last: 'Pereira', wing: 'Ozone Zeno 2', type: 'hangglider', app: 'WS Nav 1.4' });
  assert.deepEqual(mergeProfile(p, { wing: 'Advance Omega' }).first, 'Alex', 'champ absent : gardé');
  assert.equal(mergeProfile(p, { name: 'Jean Dupont Durand' }).last, 'Dupont Durand');
  assert.equal(mergeProfile(p, { type: 'avion' }).type, 'hangglider');
});

test('appareil : réservé par son secret, refus d’un autre secret', () => {
  const { svc } = make();
  const r = svc.ingest({ device: 'wsnav-abc123', secret: SECRET, pilot: { first: 'Alex', last: 'P', wing: 'Zeno 2' }, app: 'WS Nav', points: flight(T0 - 30, 5) });
  assert.equal(r.stored, 5);
  assert.throws(() => svc.ingest({ device: 'wsnav-abc123', secret: 'un-autre-secret-123456', points: [] }), (e: HttpError) => e.status === 403);
  assert.throws(() => svc.ingest({ device: 'x', secret: SECRET }), (e: HttpError) => e.code === 'bad-device');
  assert.throws(() => svc.ingest({ device: 'wsnav-zzz999', secret: 'court' }), (e: HttpError) => e.code === 'bad-secret');
  assert.equal(svc.live.pilots.get(Number(r.pilot))?.profile.wing, 'Zeno 2');
});

test('renvoi après une réponse perdue : rien en double', () => {
  const { svc } = make();
  const pts = flight(T0 - 60, 10);
  const a = svc.ingest({ device: 'wsnav-dup001', secret: SECRET, points: pts });
  const b = svc.ingest({ device: 'wsnav-dup001', secret: SECRET, points: [...pts, ...flight(T0 - 30, 5).slice(0, 0), [T0, 45.9, 6.2]] });
  assert.equal(a.stored, 10);
  assert.equal(b.stored, 1);
  assert.equal(b.dup, 10);
  assert.equal(b.last, T0);
  assert.equal(svc.store.count().n, 11);
});

test('direct : image, suite, trace d’un pilote nouveau, reprise après coupure', () => {
  const { svc, tick, at } = make();
  const A = svc.ingest({ device: 'pilote-aaaa', secret: SECRET, pilot: { first: 'A' }, points: flight(T0 - 900, 300) });
  const sub = newSub(svc, parseArea('5,45,7,47') as never, 600, null, false);
  const snap = svc.live.collect(sub, at(), { snapshot: true });
  assert.equal(snap.pilots.length, 1);
  assert.equal(snap.pilots[0].trail, true);
  assert.equal(snap.pilots[0].p?.first, 'A');
  // trace des 10 dernières minutes : 200 points (de T0-600 à T0-3)
  assert.equal(snap.pilots[0].pts?.length, 200);

  tick(3);
  svc.ingest({ device: 'pilote-aaaa', secret: SECRET, points: [[at(), 45.9, 6.3, 1600, 10, 90, 1]] });
  const B = svc.ingest({ device: 'pilote-bbbb', secret: SECRET, pilot: { first: 'B' }, points: flight(at() - 120, 41, 46, 6.5) });
  const d = svc.live.collect(sub, at());
  const a = d.pilots.find(x => x.id === A.pilot)!, b = d.pilots.find(x => x.id === B.pilot)!;
  assert.equal(a.pts?.length, 1, 'seulement le point nouveau');
  assert.equal(a.p, undefined, 'profil déjà envoyé');
  assert.equal(b.trail, true, 'pilote nouveau : sa trace');
  assert.equal(b.pts?.length, 41);

  // coupure : l'abonné garde son curseur ; pendant ce temps A envoie 10 points et C arrive
  const cursor = d.seq;
  for (let i = 0; i < 10; i++) { tick(3); svc.ingest({ device: 'pilote-aaaa', secret: SECRET, points: [[at(), 45.9, 6.31 + i * 0.001, 1600]] }); }
  const C = svc.ingest({ device: 'pilote-cccc', secret: SECRET, points: flight(at() - 30, 11, 45.5, 6) });
  const r = newSub(svc, parseArea('5,45,7,47') as never, 600, null, false);
  r.cursor = cursor;
  const back = svc.live.collect(r, at(), { snapshot: true, infer: true });
  assert.equal(back.reset, undefined);
  assert.equal(back.pilots.find(x => x.id === A.pilot)?.pts?.length, 10, 'A : les 10 points manqués, pas sa trace');
  assert.equal(back.pilots.find(x => x.id === A.pilot)?.trail, undefined);
  assert.equal(back.pilots.find(x => x.id === C.pilot)?.trail, true, 'C : sa trace');
  assert.equal(back.pilots.find(x => x.id === B.pilot), undefined, 'B : rien de neuf');
});

test('point en retard (pilote revenu dans le réseau) : envoyé aux abonnés, trace triée par heure', () => {
  const { svc, at } = make();
  svc.ingest({ device: 'pilote-late', secret: SECRET, points: [[at() - 300, 45.9, 6.1], [at(), 45.9, 6.2]] });
  const sub = newSub(svc, null, 600, null, false);
  svc.live.collect(sub, at(), { snapshot: true });
  const r = svc.ingest({ device: 'pilote-late', secret: SECRET, points: flight(at() - 297, 98) });
  assert.equal(r.stored, 98);
  const u = svc.live.collect(sub, at());
  assert.equal(u.pilots[0].pts?.length, 98);
  const tr = svc.live.pilots.get(Number(r.pilot))!.track;
  assert.ok(tr.every((f, i) => !i || f.ts > tr[i - 1].ts));
  assert.equal(tr.length, 100);
});

test('zone : un pilote qui en sort n’est plus suivi, il revient avec sa trace', () => {
  const { svc, tick, at } = make();
  svc.ingest({ device: 'pilote-zone', secret: SECRET, points: [[at(), 45.9, 6.1]] });
  const sub = newSub(svc, [6, 45, 7, 46], 600, null, false);
  assert.equal(svc.live.collect(sub, at(), { snapshot: true }).pilots.length, 1);
  tick(3); svc.ingest({ device: 'pilote-zone', secret: SECRET, points: [[at(), 45.9, 5.9]] });
  assert.equal(svc.live.collect(sub, at()).pilots[0].pts?.length, 1, 'le point de sortie est envoyé');
  tick(3); svc.ingest({ device: 'pilote-zone', secret: SECRET, points: [[at(), 45.9, 5.8]] });
  assert.equal(svc.live.collect(sub, at()).pilots.length, 0);
  tick(3); svc.ingest({ device: 'pilote-zone', secret: SECRET, points: [[at(), 45.9, 6.05]] });
  const back = svc.live.collect(sub, at()).pilots[0];
  assert.equal(back.trail, true);
  assert.equal(back.pts?.length, 4);
});

test('curseur trop vieux : image complète', () => {
  const { svc, tick, at } = make({ LIVE_WINDOW_MIN: '5' });
  svc.ingest({ device: 'pilote-old1', secret: SECRET, points: [[at(), 45.9, 6.1]] });
  const cursor = svc.live.seq;
  tick(400);
  svc.ingest({ device: 'pilote-old1', secret: SECRET, points: [[at(), 45.9, 6.2]] });
  svc.live.trim(at());
  assert.equal(svc.live.resumable(cursor - 1), false);
  assert.equal(svc.live.resumable(svc.live.seq), true);
});

test('bloqué : disparaît du direct, ses envois sont refusés', () => {
  const { svc, at } = make();
  const r = svc.ingest({ device: 'pilote-spam', secret: SECRET, points: [[at(), 45.9, 6.1]] });
  const sub = newSub(svc, null, 600, null, false);
  svc.live.collect(sub, at(), { snapshot: true });
  svc.block(Number(r.pilot), true);
  const u = svc.live.collect(sub, at());
  assert.deepEqual(u.pilots, [{ id: r.pilot, gone: true }]);
  assert.throws(() => svc.ingest({ device: 'pilote-spam', secret: SECRET, points: [] }), (e: HttpError) => e.code === 'blocked');
  const admin = newSub(svc, null, 600, null, true);
  assert.equal(svc.live.collect(admin, at(), { snapshot: true }).pilots[0].blocked, true);
});

test('oubli : le pilote efface tout', () => {
  const { svc, at } = make();
  svc.ingest({ device: 'pilote-rgpd', secret: SECRET, points: flight(at() - 30, 10) });
  svc.forget({ device: 'pilote-rgpd', secret: SECRET });
  assert.equal(svc.store.count().n, 0);
  assert.equal(svc.store.pilotByDevice('pilote-rgpd'), undefined);
  assert.equal(svc.live.pilots.size, 0);
});

test('historique : 72 h, puis effacé', () => {
  const { svc, tick, at } = make();
  svc.ingest({ device: 'pilote-72hh', secret: SECRET, points: flight(at() - 600, 100) });
  tick(71 * 3600);
  svc.maintain();
  assert.equal(svc.store.count().n, 100);
  tick(3600);
  svc.maintain();
  assert.equal(svc.store.count().n, 0);
  assert.equal(svc.live.pilots.size, 1, 'le profil reste (identifiant réservé)');
  tick(91 * 86400);
  svc.maintain();
  assert.equal(svc.live.pilots.size, 0, 'pilote oublié après 90 jours sans point');
});

test('place : au-delà de MAX_DB_MB les plus vieux points sont réécrits', () => {
  const { svc, at } = make({ MAX_DB_MB: '16' });
  // ≈ 16 Mo de points : 4 pilotes × 72 h à 1 point / 3 s ne tiendraient pas
  let t = at() - 70 * 3600;
  for (let k = 0; k < 60; k++) {
    for (let p = 0; p < 4; p++) svc.ingest({ device: `pilote-cap-${p}`, secret: SECRET, points: flight(t, 2000, 45 + p * 0.1, 6, 1) });
    t += 2000;
    if (svc.store.usedBytes() > 18 * 1048576) break;
  }
  const before = svc.store.count();
  assert.ok(svc.store.usedBytes() > 16 * 1048576, 'la base dépasse la limite');
  const m = svc.maintain();
  const after = svc.store.count();
  assert.ok(m.evicted > 0);
  assert.ok(svc.store.usedBytes() <= 16 * 1048576 * 0.96);
  assert.ok(after.t0! > before.t0!, 'les plus vieux sont partis');
  // la place libérée est réutilisée : le fichier ne grossit pas avec les points suivants
  const size = svc.store.fileBytes();
  for (let p = 0; p < 4; p++) svc.ingest({ device: `pilote-cap-${p}`, secret: SECRET, points: flight(t, 1000, 45 + p * 0.1, 6, 1) });
  assert.ok(svc.store.fileBytes() <= size * 1.02);
});
