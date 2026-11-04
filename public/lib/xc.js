// La distance d'un vol de cross, comme la comptent XContest et la CFD (FFVL) : distance libre par trois points de
// contournement, triangles plat et FAI (chaque côté ≥ 28 % du périmètre) bouclés selon une règle de fermeture, et le
// triangle « s'il boucle » : le plus grand que les points déjà atteints font, une fois le pilote revenu à son départ.
// Le même fichier sert au serveur (distances de la liste) et à la page (pilote choisi, règle choisie par le lecteur).
// Distances sur la sphère FAI (6371 km) ; la recherche se fait sur une trace allégée, puis chaque point est affiné sur
// la trace entière.

/** rayon de la sphère FAI (m) */
const R = 6371000;
const RAD = Math.PI / 180;

/**
 * Règles de fermeture : écart permis entre le départ et l'arrivée pour un périmètre P (m), et la distance comptée.
 *   xc20 : XContest, triangle compté jusqu'à 20 % d'écart, périmètre moins l'écart
 *   xc5  : XContest, triangle « fermé » (bonus) : moins de 5 % d'écart
 *   cfd  : CFD (FFVL) : 3 km d'écart toujours permis, sinon 5 % ; bouclé à 3 km près, le périmètre entier compte
 */
export const RULES = {
  xc20: { gap: P => 0.2 * P, scored: (P, g) => P - g },
  xc5: { gap: P => 0.05 * P, scored: (P, g) => P - g },
  cfd: { gap: P => Math.max(3000, 0.05 * P), scored: (P, g) => (g <= 3000 ? P : P - g) },
};

/**
 * Les classements et leurs points par km : chaque palier dit sous quelle règle de fermeture un triangle compte, et son
 * coefficient. XContest : triangle à 20 % (plat ×1,2, FAI ×1,4), fermé à 5 % (plat ×1,4, FAI ×1,6). CFD : 5 % ou
 * 3 km (plat ×1,2, FAI ×1,4). Distance libre ×1 partout.
 */
export const LEAGUES = {
  xcontest: { free: 1, tiers: [{ rule: 'xc20', flat: 1.2, fai: 1.4 }, { rule: 'xc5', flat: 1.4, fai: 1.6 }] },
  cfd: { free: 1, tiers: [{ rule: 'cfd', flat: 1.2, fai: 1.4 }] },
};

/**
 * Le vol compté par un classement : distance libre, meilleur triangle plat et FAI (avec le palier qui rapporte le plus)
 * et le meilleur des trois, en points. `sc` : le résultat de scoreFlight.
 */
export function leagueScore(sc, league) {
  const L = LEAGUES[league] ?? LEAGUES.xcontest;
  const free = { kind: 'free', d: sc.free.d, coef: L.free, pts: (sc.free.d / 1000) * L.free };
  const pick = kind => {
    let out = null;
    for (const t of L.tiers) {
      const tri = sc.closed[t.rule][kind];
      if (!tri) continue;
      const pts = (tri.d / 1000) * t[kind];
      if (!out || pts > out.pts) out = { kind, d: tri.d, coef: t[kind], rule: t.rule, pts, tri };
    }
    return out;
  };
  const flat = pick('flat'), fai = pick('fai');
  const best = [free, flat, fai].filter(Boolean).reduce((a, b) => (b.pts > a.pts ? b : a));
  return { free, flat, fai, best };
}

/** distance (m) entre deux points (degrés) */
export function dist(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** au plus `n` indices répartis sur `len` points, premier et dernier compris */
function sampleIdx(len, n) {
  if (len <= n) return Int32Array.from({ length: len }, (_, i) => i);
  return Int32Array.from({ length: n }, (_, i) => Math.round((i * (len - 1)) / (n - 1)));
}

const MIN_TRI = 1000;
const isFai = (ab, bc, ca, P) => Math.min(ab, bc, ca) >= 0.28 * P;

/**
 * pts : la trace, triée par heure, au format du réseau [t, lat, lon, …].
 * Renvoie null sans au moins deux points, sinon :
 *   free   { d, pts }                          distance libre (m) et ses points [lat, lon]
 *   open   { fai, flat }                       triangle s'il boucle : { P, pts: 3 sommets, a: indice du 1er sommet }
 *   closed { xc20, xc5, cfd } → { fai, flat }  meilleur triangle bouclé selon la règle : { d, P, gap, pts, s, e }
 */
export function scoreFlight(pts, opts = {}) {
  const N = pts.length;
  if (N < 2) return null;
  const la = new Float64Array(N), lo = new Float64Array(N);
  for (let i = 0; i < N; i++) { la[i] = pts[i][1]; lo[i] = pts[i][2]; }
  const g = (i, j) => dist(la[i], lo[i], la[j], lo[j]);
  const ll = i => [la[i], lo[i]];
  const idx = sampleIdx(N, opts.samples ?? 200), n = idx.length;
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) M[i * n + j] = M[j * n + i] = g(idx[i], idx[j]);
  // fenêtre d'affinage sur la trace entière : deux pas d'allègement de chaque côté
  const W = Math.ceil((2 * (N - 1)) / Math.max(1, n - 1));

  // ── distance libre : départ, trois points, arrivée = quatre jambes (programmation dynamique)
  let f = new Float64Array(n);
  const back = [];
  for (let k = 0; k < 4; k++) {
    const nf = new Float64Array(n).fill(-Infinity), b = new Int32Array(n);
    for (let j = 0; j < n; j++) for (let i = 0; i <= j; i++) {
      const v = f[i] + M[i * n + j];
      if (v > nf[j]) { nf[j] = v; b[j] = i; }
    }
    back.push(b); f = nf;
  }
  let end = 0;
  for (let j = 1; j < n; j++) if (f[j] > f[end]) end = j;
  const chain = [end];
  for (let k = 3; k >= 0; k--) chain.unshift(back[k][chain[0]]);
  const pathLen = q => { let d = 0; for (let k = 1; k < q.length; k++) d += g(q[k - 1], q[k]); return d; };
  const fq = refine(chain.map(i => idx[i]), W, N, pathLen);
  const free = { d: pathLen(fq), pts: fq.filter((v, i) => i === 0 || v !== fq[i - 1]).map(ll) };

  // ── écart de fermeture : G[a][c] = plus courte distance entre un point ≤ a et un point ≥ c (et lesquels)
  const G = new Float64Array(n * n).fill(Infinity), GI = new Int32Array(n * n), GJ = new Int32Array(n * n);
  for (let a = 0; a < n; a++) for (let c = n - 1; c >= a; c--) {
    const k = a * n + c;
    G[k] = M[k]; GI[k] = a; GJ[k] = c;
    if (a > 0 && G[k - n] < G[k]) { G[k] = G[k - n]; GI[k] = GI[k - n]; GJ[k] = GJ[k - n]; }
    if (c < n - 1 && G[k + 1] < G[k]) { G[k] = G[k + 1]; GI[k] = GI[k + 1]; GJ[k] = GJ[k + 1]; }
  }
  const names = Object.keys(RULES), rules = names.map(r => RULES[r]);
  const best = names.map(() => ({ fai: { v: -1, q: null }, flat: { v: -1, q: null } }));
  const open = { fai: { v: -1, q: null }, flat: { v: -1, q: null } };
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const ab = M[a * n + b];
    for (let c = b + 1; c < n; c++) {
      const bc = M[b * n + c], ca = M[c * n + a], P = ab + bc + ca;
      if (P < MIN_TRI) continue;
      const fai = isFai(ab, bc, ca, P);
      if (P > open.flat.v) { open.flat.v = P; open.flat.q = [a, b, c]; }
      if (fai && P > open.fai.v) { open.fai.v = P; open.fai.q = [a, b, c]; }
      const k = a * n + c, gap = G[k];
      for (let r = 0; r < rules.length; r++) {
        if (gap > rules[r].gap(P)) continue;
        const d = rules[r].scored(P, gap), x = best[r];
        if (d > x.flat.v) { x.flat.v = d; x.flat.q = [GI[k], a, b, c, GJ[k]]; }
        if (fai && d > x.fai.v) { x.fai.v = d; x.fai.q = [GI[k], a, b, c, GJ[k]]; }
      }
    }
  }

  const tri = (a, b, c) => { const ab = g(a, b), bc = g(b, c), ca = g(c, a), P = ab + bc + ca; return { P, fai: isFai(ab, bc, ca, P) }; };
  const openOf = (o, wantFai) => {
    if (!o.q) return null;
    const q = refine(o.q.map(i => idx[i]), W, N, ([a, b, c]) => { const t = tri(a, b, c); return t.P < MIN_TRI || (wantFai && !t.fai) ? -Infinity : t.P; });
    return { P: tri(q[0], q[1], q[2]).P, pts: q.map(ll), a: q[0] };
  };
  const closedOf = (o, rule, wantFai) => {
    if (!o.q) return null;
    const score = ([s, a, b, c, e]) => {
      const t = tri(a, b, c), gap = g(s, e);
      return t.P < MIN_TRI || gap > rule.gap(t.P) || (wantFai && !t.fai) ? -Infinity : rule.scored(t.P, gap);
    };
    const q = refine(o.q.map(i => idx[i]), W, N, score);
    const [s, a, b, c, e] = q, t = tri(a, b, c);
    return { d: score(q), P: t.P, gap: g(s, e), pts: [ll(a), ll(b), ll(c)], s: ll(s), e: ll(e) };
  };
  const closed = {};
  names.forEach((name, r) => {
    const fai = closedOf(best[r].fai, rules[r], true);
    let flat = closedOf(best[r].flat, rules[r], false);
    // un triangle FAI est aussi un triangle plat : affinés à part, il peut finir le plus long des deux
    if (fai && (!flat || fai.d > flat.d)) flat = fai;
    closed[name] = { fai, flat };
  });
  const oFai = openOf(open.fai, true);
  let oFlat = openOf(open.flat, false);
  if (oFai && (!oFlat || oFai.P > oFlat.P)) oFlat = oFai;
  return { free, open: { fai: oFai, flat: oFlat }, closed };
}

/**
 * Montée par coordonnées sur la trace entière : chaque point (dans l'ordre du temps) bouge de ±W points autour de
 * celui que la recherche allégée a choisi, tant que le score monte. Quelques passes suffisent.
 */
function refine(start, W, N, score) {
  const q = start.slice(), last = N - 1;
  let cur = score(q);
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (let k = 0; k < q.length; k++) {
      const lo = Math.max(k > 0 ? q[k - 1] : 0, q[k] - W), hi = Math.min(k < q.length - 1 ? q[k + 1] : last, q[k] + W);
      const keep = q[k];
      let bestX = keep;
      for (let x = lo; x <= hi; x++) {
        if (x === keep) continue;
        q[k] = x;
        const v = score(q);
        if (v > cur + 1e-6) { cur = v; bestX = x; }
      }
      q[k] = bestX;
      if (bestX !== keep) moved = true;
    }
    if (!moved) break;
  }
  return q;
}

/**
 * Où le triangle `tri` (un `open` de scoreFlight) sera bouclé selon la règle : le cercle autour du point de départ le
 * plus proche du pilote (un point de la trace avant le premier sommet), son rayon (l'écart permis pour ce périmètre),
 * et ce qu'il reste au pilote à faire pour y entrer (m, 0 : bouclé).
 */
export function closingZone(pts, tri, rule) {
  if (!tri || !pts.length) return null;
  const here = pts[pts.length - 1], r = RULES[rule] ?? RULES.xc20;
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= Math.min(tri.a, pts.length - 1); i++) {
    const d = dist(pts[i][1], pts[i][2], here[1], here[2]);
    if (d < bestD) { bestD = d; best = i; }
  }
  const radius = r.gap(tri.P);
  return { center: [pts[best][1], pts[best][2]], radius, toGo: Math.max(0, bestD - radius), away: bestD };
}

/** cercle (anneau GeoJSON [lon, lat]) de `radius` m autour de [lat, lon] */
export function circle([lat, lon], radius, steps = 72) {
  const out = [], d = radius / R, la1 = lat * RAD, lo1 = lon * RAD;
  for (let i = 0; i <= steps; i++) {
    const br = (i / steps) * 2 * Math.PI;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
    const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    out.push([lo2 / RAD, la2 / RAD]);
  }
  return out;
}
