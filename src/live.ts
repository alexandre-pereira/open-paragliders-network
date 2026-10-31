// La mémoire du direct : la trace récente de chaque pilote (LIVE_WINDOW_MIN) et le journal des points dans leur ordre
// d'arrivée. Chaque abonné garde un curseur (le numéro du dernier point reçu) : ce qu'il lui faut ensuite, c'est le
// journal après son curseur. Après une coupure réseau, il redonne son curseur (`since`) et reçoit tout ce qui est
// arrivé entre-temps, rien de plus ; un curseur trop vieux (sorti de la fenêtre, serveur redémarré) donne une image
// complète (`reset`). Un pilote vu pour la première fois arrive avec sa trace (`trail`).

import { inBox, wire, type BBox, type Fix, type WireFix } from './fix.ts';
import type { PilotStatus, Profile } from './profile.ts';

export interface LivePilot {
  pid: number;
  profile: Profile;
  pv: number;
  blocked: boolean;
  /** points de la fenêtre, triés par heure */
  track: Fix[];
}

/** ce qu'un abonné a déjà : son curseur et les pilotes qu'il suit (pid → version du profil reçue) */
export interface SubState {
  bbox: BBox | null;
  /** trace envoyée avec un pilote nouveau (s) */
  trailS: number;
  /** un pilote dont le dernier point est plus vieux n'est pas envoyé (s) */
  maxAgeS: number;
  cursor: number;
  known: Map<number, number>;
  /** back-office : les pilotes bloqués aussi */
  admin: boolean;
}

export interface PilotUpdate {
  id: string;
  /** points nouveaux, triés par heure ; ils peuvent être plus vieux que ceux déjà reçus (envoi en retard après une
   *  coupure du pilote) : à fusionner par heure */
  pts?: WireFix[];
  /** pts est la trace récente du pilote, pas la suite : elle remplace ce que l'abonné avait */
  trail?: true;
  p?: Profile;
  /** pilote retiré (bloqué, effacé) : à enlever de la carte */
  gone?: true;
  blocked?: true;
}

export interface Update {
  /** le curseur à redonner (since) à la reconnexion */
  seq: number;
  now: number;
  /** image complète : l'abonné repart de zéro */
  reset?: true;
  pilots: PilotUpdate[];
}

/** premier index de `a[lo..]` dont la clé est ≥ v */
function lowerBound<T>(a: T[], lo: number, v: number, key: (x: T) => number): number {
  let hi = a.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (key(a[m]) < v) lo = m + 1; else hi = m; }
  return lo;
}
const bySeq = (f: Fix) => f.seq, byTs = (f: Fix) => f.ts;

export class Live {
  readonly pilots = new Map<number, LivePilot>();
  /** points dans l'ordre d'arrivée ; journal[head..] est valable */
  private journal: Fix[] = [];
  private head = 0;
  /** tout point de numéro > floor encore dans la fenêtre est dans le journal : un curseur ≥ floor peut reprendre */
  floor: number;
  /** numéro du dernier point */
  seq: number;
  /** pilotes retirés : numéro au moment du retrait */
  private tombs: { at: number; pid: number }[] = [];
  /** états changés (posé OK, SOS) : numéro au moment du changement */
  private notes: { at: number; pid: number }[] = [];

  readonly windowS: number;
  readonly maxJournal: number;

  constructor(windowS: number, startSeq = 0, maxJournal = 3_000_000) {
    this.windowS = windowS;
    this.maxJournal = maxJournal;
    this.floor = startSeq;
    this.seq = startSeq;
  }

  setPilot(pid: number, profile: Profile, pv: number, blocked: boolean): LivePilot {
    let p = this.pilots.get(pid);
    if (!p) { p = { pid, profile, pv, blocked, track: [] }; this.pilots.set(pid, p); }
    else {
      // l'état n'est pas dans le profil enregistré : il reste quand le profil change
      p.profile = p.profile.status ? { ...profile, status: p.profile.status } : profile; p.pv = pv;
      if (blocked && !p.blocked) this.tombs.push({ at: this.seq, pid });
      p.blocked = blocked;
    }
    return p;
  }

  /** l'état du pilote a changé ; un pilote posé n'envoie plus de points : il part quand même aux abonnés (collect) */
  setStatus(pid: number, status: PilotStatus | null, pv: number) {
    const p = this.pilots.get(pid);
    if (!p) return;
    const { status: _old, ...profile } = p.profile;
    p.profile = status ? { ...profile, status } : profile;
    p.pv = pv;
    this.notes.push({ at: this.seq, pid });
    if (this.notes.length > 2000) this.notes.splice(0, 1000);
  }

  removePilot(pid: number) {
    if (this.pilots.delete(pid)) this.tombs.push({ at: this.seq, pid });
  }

  /** points enregistrés (dans l'ordre de leur numéro) */
  add(pid: number, fixes: Fix[]) {
    const p = this.pilots.get(pid);
    if (!p || !fixes.length) return;
    for (const f of fixes) {
      this.journal.push(f);
      if (f.seq > this.seq) this.seq = f.seq;
      const t: Fix[] = p.track;
      if (!t.length || f.ts > t[t.length - 1].ts) t.push(f);
      else {
        const i = lowerBound(t, 0, f.ts, byTs);
        if (t[i]?.ts !== f.ts) t.splice(i, 0, f);
      }
    }
    if (this.journal.length - this.head > this.maxJournal) this.dropJournal(this.journal.length - this.head - this.maxJournal);
  }

  /** points rechargés au démarrage : dans les traces, pas dans le journal (les curseurs d'avant ne reprennent pas) */
  load(fixes: Fix[]) {
    for (const f of fixes) {
      const p = this.pilots.get(f.pid);
      if (p) p.track.push(f);
    }
    for (const p of this.pilots.values()) p.track.sort((a, b) => a.ts - b.ts);
  }

  private dropJournal(n: number) {
    this.head += n;
    this.floor = Math.max(this.floor, this.journal[this.head - 1].seq);
    if (this.head > 50_000 && this.head > this.journal.length / 2) { this.journal = this.journal.slice(this.head); this.head = 0; }
  }

  /** oublie ce qui est sorti de la fenêtre */
  trim(nowS: number) {
    const cut = nowS - this.windowS;
    let n = 0;
    while (this.head + n < this.journal.length && this.journal[this.head + n].rx < cut) n++;
    if (n) this.dropJournal(n);
    for (const p of this.pilots.values()) {
      if (p.track.length && p.track[0].ts < cut) p.track.splice(0, lowerBound(p.track, 0, cut, byTs));
    }
    // un abonné qui reprend après un retrait plus vieux que la fenêtre repart de zéro (floor) : inutile de le garder
    this.tombs = this.tombs.filter(x => x.at > this.floor);
  }

  last(pid: number): Fix | undefined { const t = this.pilots.get(pid)?.track; return t?.[t.length - 1]; }

  /** la trace des `trailS` dernières secondes, au moins le dernier point */
  trail(p: LivePilot, nowS: number, trailS: number): Fix[] {
    const t = p.track;
    if (!t.length) return [];
    const i = lowerBound(t, 0, nowS - trailS, byTs);
    return i < t.length ? t.slice(i) : [t[t.length - 1]];
  }

  /** le curseur peut reprendre (sinon : image complète) */
  resumable(since: number) { return since >= this.floor && since <= this.seq; }

  /** l'abonné avait déjà ce pilote au moment du curseur : son dernier point d'alors était dans la boîte */
  private hadAt(p: LivePilot, since: number, sub: SubState, nowS: number): boolean {
    for (let i = p.track.length - 1; i >= 0; i--) {
      const f = p.track[i];
      if (f.seq <= since) return nowS - f.ts <= sub.maxAgeS && inBox(sub.bbox, f.lat, f.lon);
    }
    return false;
  }

  /**
   * ce que l'abonné doit recevoir maintenant ; avance son curseur.
   *   snapshot : aussi les pilotes de la boîte qu'il ne suit pas encore (abonnement, changement de zone)
   *   infer    : reprise sans état (HTTP, reconnexion) : les pilotes qu'il avait au curseur sont déduits
   */
  collect(sub: SubState, nowS: number, opts: { snapshot?: boolean; infer?: boolean } = {}): Update {
    const out = new Map<number, PilotUpdate>();
    const since = sub.cursor;
    const visible = (p: LivePilot) => sub.admin || !p.blocked;
    const fresh = (f: Fix | undefined) => !!f && nowS - f.ts <= sub.maxAgeS;
    const trailOf = (p: LivePilot) => { out.set(p.pid, { id: String(p.pid), pts: this.trail(p, nowS, sub.trailS).map(wire), trail: true }); sub.known.set(p.pid, -1); };

    // 1. ce qui est arrivé depuis le curseur, pilote par pilote
    const groups = new Map<number, Fix[]>();
    for (let i = lowerBound(this.journal, this.head, since + 1, bySeq); i < this.journal.length; i++) {
      const f = this.journal[i];
      const g = groups.get(f.pid);
      if (g) g.push(f); else groups.set(f.pid, [f]);
    }
    for (const [pid, fixes] of groups) {
      const p = this.pilots.get(pid);
      if (!p || !visible(p)) continue;
      const last = p.track[p.track.length - 1];
      if (!last) continue;
      const inside = inBox(sub.bbox, last.lat, last.lon);
      if (!sub.known.has(pid) && opts.infer && this.hadAt(p, since, sub, nowS)) sub.known.set(pid, -1);
      if (sub.known.has(pid)) {
        out.set(pid, { id: String(pid), pts: fixes.sort((a, b) => a.ts - b.ts).map(wire) });
        // sorti de la zone : plus suivi (sa trace reviendra s'il y rentre)
        if (!inside) sub.known.delete(pid);
      } else if (inside && fresh(last)) trailOf(p);
    }

    // 2. les pilotes de la zone qu'il ne suit pas encore
    if (opts.snapshot) {
      for (const p of this.pilots.values()) {
        if (sub.known.has(p.pid) || out.has(p.pid) || !visible(p)) continue;
        const last = p.track[p.track.length - 1];
        if (!fresh(last) || !inBox(sub.bbox, last.lat, last.lon)) continue;
        if (opts.infer && this.hadAt(p, since, sub, nowS)) { sub.known.set(p.pid, -1); continue; }
        trailOf(p);
      }
    }

    // 2 bis. un état changé sans point nouveau : aux abonnés qui suivent le pilote, et à ceux de la zone
    for (const n of this.notes) {
      const p = this.pilots.get(n.pid);
      if (n.at < since || !p || !visible(p) || out.has(n.pid) || sub.known.get(n.pid) === p.pv) continue;
      const last = p.track[p.track.length - 1], at = last ?? p.profile.status;
      if (sub.known.has(n.pid)) out.set(n.pid, { id: String(n.pid) });
      else if (at && at.lat !== null && at.lon !== null && inBox(sub.bbox, at.lat, at.lon)) {
        if (last) trailOf(p);
        else { out.set(n.pid, { id: String(n.pid) }); sub.known.set(n.pid, -1); }
      }
    }

    // 3. pilotes retirés
    for (const tb of this.tombs) {
      if (tb.at >= since && sub.known.has(tb.pid)) {
        const p = this.pilots.get(tb.pid);
        if (p && visible(p)) continue;
        sub.known.delete(tb.pid);
        out.set(tb.pid, { id: String(tb.pid), gone: true });
      }
    }

    // profil : à la première fois et à chaque changement
    for (const [pid, u] of out) {
      const p = this.pilots.get(pid);
      if (!p || u.gone) continue;
      if (sub.known.has(pid) && sub.known.get(pid) !== p.pv) { u.p = p.profile; sub.known.set(pid, p.pv); }
      if (sub.admin && p.blocked) u.blocked = true;
    }
    // des pilotes suivis disparus depuis longtemps
    if (sub.known.size > 2 * this.pilots.size + 100) for (const pid of sub.known.keys()) if (!this.pilots.has(pid)) sub.known.delete(pid);

    sub.cursor = this.seq;
    return { seq: this.seq, now: nowS, pilots: [...out.values()] };
  }

  stats() {
    let live = 0, points = 0;
    for (const p of this.pilots.values()) { if (p.track.length) live++; points += p.track.length; }
    return { pilots: this.pilots.size, live, points, journal: this.journal.length - this.head, seq: this.seq };
  }
}
