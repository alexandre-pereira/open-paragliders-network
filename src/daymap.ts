// La carte publique du jour : pour chaque pilote, son dernier vol de la journée (jour solaire là où il est), sa
// distance libre et le triangle qu'il ferait s'il bouclait. Les distances se recalculent en tâche de fond, au plus une
// fois par RESCORE_S par pilote et dans un budget de temps par tour : un serveur chargé garde la main pour le direct.

import { CAR_PARK_S, dayStart, groundKind, splitFlights, type Segment } from '../public/lib/flights.js';
import { scoreFlight } from '../public/lib/xc.js';
import { wire, type Fix } from './fix.ts';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

/** un pilote dont la distance a changé est recalculé au plus tous les RESCORE_S (s) */
const RESCORE_S = 30;
/** trace lue pour découper la journée : un point par STEP_S (s), depuis BEFORE_S avant le minuit solaire */
const STEP_S = 5, BEFORE_S = 4 * 3600;
/** un pilote au sol, sans vol aujourd'hui, reste sur la carte tant que son dernier point a moins de FRESH_S (s) */
const FRESH_S = 1800;
/** traîne des pilotes en vol sur la carte : TAIL_S (s), un point par TAIL_STEP (s) */
const TAIL_S = 300, TAIL_STEP = 15;
/** un triangle « s'il boucle » plus petit n'est pas montré (km) : celui d'un aller simple ne dit rien */
const MIN_TRI_KM = 10;
/** échantillons de la recherche des distances (la page du pilote choisi en prend plus) */
const SAMPLES = 120;

export interface Flight {
  /** début et fin du vol (s), points du vol */
  t0: number;
  t1: number;
  n: number;
  /** distance libre (km), plus grands triangles FAI et plat s'il boucle (km) */
  km: number;
  fai: number | null;
  flat: number | null;
}

interface Entry {
  pid: number;
  last: Fix;
  dirty: boolean;
  scoredAt: number;
  /** le dernier vol de la journée, null : aucun */
  flight: Flight | null;
  /** jour solaire du calcul */
  day: number;
  /** dernier point privé au sol (s), 0 : aucun ; ses points au sol des CAR_PARK_S dernières secondes, pour l'état
   *  seulement (à pied ou en voiture) : la carte ne montre jamais où il est au sol */
  groundAt: number;
  gnd: ReturnType<typeof wire>[];
}

export class DayMap {
  private entries = new Map<number, Entry>();
  readonly store: Store;
  readonly live: Live;

  constructor(store: Store, live: Live, nowS: number) {
    this.store = store;
    this.live = live;
    // les pilotes qui ont des points depuis plus d'un jour solaire, où qu'ils soient
    for (const s of store.stats(nowS - 30 * 3600, nowS + 120)) {
      const last = store.lastFix(s.pid);
      if (!last) continue;
      const e: Entry = { pid: s.pid, last, dirty: true, scoredAt: 0, flight: null, day: 0, groundAt: 0, gnd: [] };
      this.entries.set(s.pid, e);
      // au sol depuis son dernier point public : l'état revient après un redémarrage
      const any = store.lastFix(s.pid, true);
      if (any?.gnd && any.ts > last.ts) this.ground(s.pid, store.track(s.pid, any.ts - CAR_PARK_S, any.ts, 1000, 0, true).filter(f => f.gnd));
    }
  }

  /** points enregistrés : la distance sera recalculée */
  note(pid: number, fixes: Fix[]) {
    if (!fixes.length) return;
    let e = this.entries.get(pid);
    const last = fixes.reduce((a, b) => (b.ts > a.ts ? b : a));
    if (!e) this.entries.set(pid, e = { pid, last, dirty: true, scoredAt: 0, flight: null, day: 0, groundAt: 0, gnd: [] });
    if (last.ts >= e.last.ts) e.last = last;
    e.dirty = true;
  }

  /** au sol depuis son dernier point public, selon son logiciel : « foot » ou « car », sans dire où ; null : non */
  groundOf(pid: number): 'foot' | 'car' | null {
    const e = this.entries.get(pid);
    return e && e.groundAt > e.last.ts ? groundKind(e.gnd) : null;
  }

  /** tous ceux qui sont au sol ainsi (back-office) */
  grounded(): Record<string, 'foot' | 'car'> {
    const out: Record<string, 'foot' | 'car'> = {};
    for (const pid of this.entries.keys()) { const g = this.groundOf(pid); if (g) out[String(pid)] = g; }
    return out;
  }

  /** points privés au sol : gardés le temps de dire s'il roule (CAR_PARK_S), pour l'état seulement */
  ground(pid: number, fixes: Fix[]) {
    const e = this.entries.get(pid);
    if (!e || !fixes.length) return;
    const t = Math.max(e.groundAt, ...fixes.map(f => f.ts));
    e.groundAt = t;
    e.gnd = [...e.gnd, ...fixes.map(wire)].filter(f => t - f[0] <= CAR_PARK_S).sort((a, b) => a[0] - b[0]);
  }

  forget(pid: number) { this.entries.delete(pid); }

  /** recalcule les pilotes en attente, les plus vieux calculs d'abord, dans `budgetMs` */
  refresh(nowS: number, budgetMs = 100) {
    const t0 = performance.now();
    const todo = [...this.entries.values()].filter(e => (e.dirty && nowS - e.scoredAt >= RESCORE_S) || (e.flight && e.day !== dayStart(nowS, e.last.lon)));
    todo.sort((a, b) => a.scoredAt - b.scoredAt);
    for (const e of todo) {
      if (performance.now() - t0 > budgetMs) break;
      this.score(e, nowS);
    }
    // plus vieux qu'un jour : hors de la carte
    for (const [pid, e] of this.entries) if (nowS - e.last.ts > 30 * 3600) this.entries.delete(pid);
  }

  private score(e: Entry, nowS: number) {
    e.dirty = false;
    e.scoredAt = nowS;
    const day = dayStart(nowS, e.last.lon);
    e.day = day;
    if (e.last.ts < day) { e.flight = null; return; }
    const pts = this.store.trackThin(e.pid, day - BEFORE_S, nowS + 120, STEP_S).map(wire);
    const seg = lastFlight(splitFlights(pts), day);
    if (!seg) { e.flight = null; return; }
    const s = scoreFlight(pts.slice(seg.i0, seg.i1 + 1), { samples: SAMPLES });
    const km = (m: number | undefined) => (m === undefined ? null : Math.round(m / 100) / 10);
    const tri = (m: number | undefined) => { const k = km(m); return k !== null && k >= MIN_TRI_KM ? k : null; };
    e.flight = { t0: seg.t0, t1: seg.t1, n: seg.i1 - seg.i0 + 1, km: km(s?.free.d) ?? 0, fai: tri(s?.open.fai?.P), flat: tri(s?.open.flat?.P) };
  }

  /** le dernier vol du pilote aujourd'hui, null : rien à montrer (pas de vol, ni au sol depuis peu) */
  flightOf(pid: number, nowS: number): { flight: Flight | null; last: Fix } | null {
    const e = this.entries.get(pid);
    if (!e || e.last.ts < dayStart(nowS, e.last.lon)) return null;
    if (e.flight && e.day === dayStart(nowS, e.last.lon)) return { flight: e.flight, last: e.last };
    return nowS - e.last.ts <= FRESH_S ? { flight: null, last: e.last } : null;
  }

  /** ce que la carte montre de chacun ; `visible` : profil public, pilote non bloqué */
  list(nowS: number, visible: (pid: number) => boolean) {
    const out = [];
    for (const e of this.entries.values()) {
      const f = visible(e.pid) ? this.flightOf(e.pid, nowS) : null;
      if (!f) continue;
      const p = this.live.pilots.get(e.pid)!;
      const tail = nowS - e.last.ts <= TAIL_S ? thinTail(this.live.trail(p, nowS, TAIL_S), TAIL_STEP).map(wire) : [];
      const ground = this.groundOf(e.pid);
      out.push({ id: String(e.pid), last: wire(f.last), ...(f.flight ? { flight: f.flight } : {}), ...(tail.length > 1 ? { tail } : {}), ...(ground ? { ground } : {}) });
    }
    return out;
  }

  size() { return this.entries.size; }
}

/** le dernier vol qui finit après le minuit solaire `day` */
export function lastFlight(segs: Segment[], day: number): Segment | null {
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].air && segs[i].t1 >= day) return segs[i];
  return null;
}

function thinTail(fixes: Fix[], step: number): Fix[] {
  const out: Fix[] = [];
  let last = -Infinity;
  for (let i = 0; i < fixes.length; i++) if (fixes[i].ts - last >= step || i === fixes.length - 1) { out.push(fixes[i]); last = fixes[i].ts; }
  return out;
}
