// Une trace découpée en vols : plusieurs vols le même jour (posé, remonté, redécollé) ne font pas un seul trait.
// Une coupure se fait sur un arrêt au sol (lent assez longtemps à la même altitude), ou sur un trou dans la trace : long
// d'au moins GAP_LANDED quand le pilote était lent d'un côté (posé, puis plus rien jusqu'au vol suivant), ou d'au moins
// GAP_ANY quoi qu'il en soit (un vol n'en revient pas : un logiciel qui reprend sa file après une coupure du réseau
// comble ce trou). Un morceau sans assez de mouvement (attente au décollage, marche) n'est pas un vol.
// Le même fichier sert au serveur (carte du jour) et à la page d'un lien de suivi.

import { dist } from './xc.js';

/** sous cette vitesse sol (m/s), le pilote est peut-être posé */
const SLOW = 2.5;
/** au-dessus (m/s), il bouge vraiment */
const MOVING = 4;
/** lent pendant au moins ça (s), sans changer d'altitude de plus de ALT_BAND (m) ou de 0,2 m/s en moyenne : posé */
const GROUND_S = 300, ALT_BAND = 40;
/** trous dans la trace (s) : voir plus haut */
const GAP_LANDED = 600, GAP_ANY = 2700;
/** un vol a bougé au moins ce temps (s) */
const AIR_S = 60;

/** vitesse sol de chaque point (m/s) : celle qu'il donne, sinon celle d'au moins 10 s de trace avant lui */
function speeds(pts) {
  const out = new Float64Array(pts.length);
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i][4];
    if (typeof s === 'number') { out[i] = s; continue; }
    while (j < i - 1 && pts[i][0] - pts[j + 1][0] >= 10) j++;
    const dt = pts[i][0] - pts[j][0];
    out[i] = dt > 0 ? dist(pts[j][1], pts[j][2], pts[i][1], pts[i][2]) / dt : (i ? out[i - 1] : 0);
  }
  return out;
}

/**
 * pts : la trace triée par heure, au format du réseau [t, lat, lon, alt, spd, …].
 * Renvoie les morceaux qui se suivent : { i0, i1 (indices compris), t0, t1, air } ; air : un vol, sinon au sol.
 */
export function splitFlights(pts) {
  const n = pts.length;
  if (!n) return [];
  const v = speeds(pts);
  // morceaux séparés par les trous
  const chunks = [];
  let c0 = 0;
  for (let i = 1; i < n; i++) {
    const gap = pts[i][0] - pts[i - 1][0];
    if (gap >= GAP_ANY || (gap >= GAP_LANDED && (v[i - 1] < SLOW || v[i] < SLOW))) { chunks.push([c0, i - 1]); c0 = i; }
  }
  chunks.push([c0, n - 1]);

  const out = [];
  const push = (i0, i1, ground) => {
    if (i1 < i0) return;
    let moving = 0;
    if (!ground) for (let i = i0 + 1; i <= i1; i++) if (v[i] >= MOVING) moving += Math.min(30, pts[i][0] - pts[i - 1][0]);
    out.push({ i0, i1, t0: pts[i0][0], t1: pts[i1][0], air: !ground && moving >= AIR_S });
  };
  for (const [a, b] of chunks) {
    // les arrêts au sol du morceau : une suite de points lents assez longue, à la même altitude
    let start = a, i = a;
    while (i <= b) {
      if (v[i] >= SLOW) { i++; continue; }
      let j = i, lo = Infinity, hi = -Infinity;
      while (j <= b && v[j] < SLOW) {
        const alt = pts[j][3];
        if (typeof alt === 'number') { lo = Math.min(lo, alt); hi = Math.max(hi, alt); }
        j++;
      }
      const r0 = i, r1 = j - 1, dur = pts[r1][0] - pts[r0][0];
      // lent et presque à plat ; à pied, on descend ou on monte lentement (moins de 0,2 m/s en moyenne)
      if (dur >= GROUND_S && !(hi - lo > Math.max(ALT_BAND, 0.2 * dur))) {
        // le vol finit au premier point lent (l'atterrissage) ; le suivant part du dernier (le décollage)
        push(start, r0, false);
        push(r0 + 1, r1 - 1, true);
        start = r1;
      }
      i = j;
    }
    push(start, b, false);
  }
  // deux morceaux au sol de suite n'en font qu'un
  return out.reduce((acc, s) => {
    const prev = acc[acc.length - 1];
    if (prev && !prev.air && !s.air && s.i0 === prev.i1 + 1 && s.t0 - prev.t1 < GAP_LANDED) { prev.i1 = s.i1; prev.t1 = s.t1; } else acc.push(s);
    return acc;
  }, []);
}

/** début du jour solaire (minuit au soleil, d'après la longitude) qui contient `t` (s) */
export function dayStart(t, lon) {
  const off = Math.round((lon ?? 0) * 240);
  return Math.floor((t + off) / 86400) * 86400 - off;
}
