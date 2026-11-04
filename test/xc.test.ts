import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingZone, dist, scoreFlight } from '../public/lib/xc.js';
import { dayStart, splitFlights } from '../public/lib/flights.js';

type P = [number, number, number, number | null, number | null, number | null, number | null];
const KM_LAT = 1 / 111.195;
/** une trace qui vole droit d'un point à l'autre ([lat, lon]), à 10 m/s, un point par `step` s */
function fly(corners: [number, number][], t0 = 1_800_000_000, step = 5, alt = 1500): P[] {
  const out: P[] = [];
  let t = t0;
  for (let k = 1; k < corners.length; k++) {
    const [a, b] = [corners[k - 1], corners[k]], d = dist(a[0], a[1], b[0], b[1]), n = Math.max(1, Math.round(d / 10 / step));
    for (let i = k === 1 ? 0 : 1; i <= n; i++) { out.push([t, a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, alt, 10, 0, 0]); t += step; }
  }
  return out;
}
/** un point à `e` km à l'est et `n` km au nord du départ */
const at = (e: number, n: number): [number, number] => [45.9 + n * KM_LAT, 6.1 + (e * KM_LAT) / Math.cos((45.9 * Math.PI) / 180)];

test('distance libre : un aller simple', () => {
  const s = scoreFlight(fly([at(0, 0), at(30, 0)]))!;
  assert.ok(Math.abs(s.free.d - 30000) < 100, String(s.free.d));
});

test('triangle FAI équilatéral : selon la règle, bouclé ou non', () => {
  // côtés de 10 km, le pilote revient à `gap` km de son départ
  const tri = (gap: number) => scoreFlight(fly([at(0, 0), at(10, 0), at(5, 8.66), at(gap, 0)]))!;
  const near = tri(1);   // 1 km d'écart sur 30 km : 3,3 %
  assert.ok(near.closed.xc5.fai && near.closed.xc20.fai && near.closed.cfd.fai);
  assert.ok(Math.abs(near.closed.cfd.fai!.d - near.closed.cfd.fai!.P) < 1, 'CFD : bouclé à moins de 3 km, le périmètre entier');
  assert.ok(near.closed.xc20.fai!.d < near.closed.xc20.fai!.P - 900, 'XContest : périmètre moins l’écart');

  // 9 % : XContest 20 % prend tout le triangle ; à 5 %, seul un plus petit (un sommet ramené sur la dernière branche)
  // boucle ; la CFD prend 3 km quel que soit le périmètre
  const mid = tri(2.7), full = 29900;
  assert.ok(mid.closed.xc20.fai!.P > full && mid.closed.xc5.fai!.P < full - 1000 && mid.closed.cfd.fai!.P > full);
  assert.ok(Math.abs(mid.closed.cfd.fai!.d - mid.closed.cfd.fai!.P) < 1);

  const far = tri(4.5);  // 15 % : seulement XContest 20 % garde le grand triangle
  assert.ok(far.closed.xc20.fai!.P > full && far.closed.xc5.fai!.P < full - 1000 && far.closed.cfd.fai!.P < full - 1000);
  assert.ok(far.open.fai && Math.abs(far.open.fai.P - 30000) < 300, `s'il boucle : ${far.open.fai?.P}`);
});

test('triangle pas FAI : le plat est le grand, le FAI n’en est qu’un morceau', () => {
  const s = scoreFlight(fly([at(0, 0), at(20, 0), at(10, 3), at(0.5, 0)]))!;
  assert.ok(Math.abs(s.open.flat!.P - 40880) < 300, String(s.open.flat!.P));
  assert.ok(!s.open.fai || s.open.fai.P < 20000);
  assert.ok(s.closed.xc20.flat && (!s.closed.xc20.fai || s.closed.xc20.fai.d < s.closed.xc20.flat.d - 15000));
});

test('zone de fermeture : autour du départ, ce qu’il reste à faire', () => {
  // en route vers le départ, encore à 6 km
  const pts = fly([at(0, 0), at(10, 0), at(5, 8.66), at(3, 5.2)]);
  const s = scoreFlight(pts)!, z = closingZone(pts, s.open.fai, 'xc5')!;
  assert.ok(z.radius > 1000 && z.radius < 1600, String(z.radius));
  assert.ok(Math.abs(z.away - 6000) < 400 && Math.abs(z.toGo - (z.away - z.radius)) < 1, JSON.stringify(z));
  assert.ok(closingZone(pts, s.open.fai, 'xc20')!.toGo < z.toGo, 'plus de marge à 20 %');
});

test('vols : séparés par un arrêt au sol ou par un trou, attente au décollage à part', () => {
  const t0 = 1_800_000_000;
  const a = fly([at(0, 0), at(10, 0), at(10, 5)], t0);
  const land = a[a.length - 1];
  // 20 min posé au même endroit, puis un second vol
  const ground: P[] = Array.from({ length: 240 }, (_, i) => [land[0] + 5 * (i + 1), land[1], land[2], 520, 0.3, null, 0]);
  const b = fly([at(10, 5), at(0, 5)], ground[ground.length - 1][0] + 5);
  const s = splitFlights([...a, ...ground, ...b]);
  assert.deepEqual(s.map(x => x.air), [true, false, true]);
  assert.equal(s[0].t1, land[0] + 5);
  // le même vol avec un trou de 15 min sans arrêt (réseau perdu) n'est pas coupé ; posé puis plus rien, si
  const hole = [...a, ...fly([at(10, 5), at(0, 5)], land[0] + 900)];
  assert.equal(splitFlights(hole).length, 1);
  const quiet: P[] = [...a.slice(0, -1), [land[0], land[1], land[2], 520, 0.5, null, 0], ...fly([at(10, 5), at(0, 5)], land[0] + 900)];
  assert.equal(splitFlights(quiet).filter(x => x.air).length, 2);
  // un point lent seul (virage contre le vent) ne coupe rien
  const slow = fly([at(0, 0), at(5, 0)], t0).map((p, i) => (i === 20 ? [p[0], p[1], p[2], p[3], 1, p[5], p[6]] as P : p));
  assert.equal(splitFlights(slow).length, 1);
  // jour solaire : minuit à 6° est = 23 h 36 UTC la veille
  assert.equal(dayStart(Date.UTC(2026, 10, 4, 12) / 1000, 6), Date.UTC(2026, 10, 3, 23, 36) / 1000);
});

test('points : XContest ×1,6 seulement fermé à 5 %, la CFD ×1,4 à 5 % ou 3 km', async () => {
  const { leagueScore } = await import('../public/lib/xc.js');
  const tri = (gap: number) => scoreFlight(fly([at(0, 0), at(10, 0), at(5, 8.66), at(gap, 0)]))!;
  const close = tri(1), mid = tri(2.7);
  const xc = leagueScore(close, 'xcontest'), cfd = leagueScore(close, 'cfd');
  assert.equal(xc.best.kind, 'fai'); assert.equal(xc.best.coef, 1.6);
  assert.ok(Math.abs(xc.best.pts - ((close.closed.xc5.fai!.d) / 1000) * 1.6) < 0.01);
  assert.equal(cfd.best.coef, 1.4);
  assert.ok(Math.abs(cfd.best.pts - (close.closed.cfd.fai!.P / 1000) * 1.4) < 0.01, 'à moins de 3 km : le périmètre entier');
  // 9 % : XContest garde le grand triangle à ×1,4 s'il rapporte plus que le petit fermé à ×1,6
  const m = leagueScore(mid, 'xcontest');
  assert.equal(m.fai!.pts, Math.max((mid.closed.xc20.fai!.d / 1000) * 1.4, (mid.closed.xc5.fai!.d / 1000) * 1.6));
});
