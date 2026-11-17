// Les notifications d'un lien de suivi : un proche du pilote, sur la page /p/<jeton>, demande à être prévenu quand il
// décolle, se pose, dit « posé OK » ou « posé pas OK » (SOS), et quand l'alerte est levée. Son navigateur s'abonne
// (Web Push) ; le serveur garde l'abonnement avec l'empreinte du lien : un nouveau lien coupe tous les abonnés.
//
// Décollage et posé : un logiciel qui marque ses points au sol (8e valeur 1) le dit au point près ; sinon la trace
// découpée en vols (public/lib/flights.js) : un vol se voit après une minute de mouvement, un posé après 5 min d'arrêt.
// Le message ne porte que le nom du pilote, l'heure et (SOS) l'endroit ; jamais le jeton, que le serveur n'a pas : la
// page le donne à son navigateur (clé `k`, début de l'empreinte du lien).

import { splitFlights } from '../public/lib/flights.js';
import { wireGnd, type Fix } from './fix.ts';
import type { PilotStatus } from './profile.ts';
import type { PushSub, Store } from './store.ts';
import { Vapid, newVapidKeys, validKeys, type VapidKeys } from './webpush.ts';

export type PushKind = 'takeoff' | 'landed' | 'ok' | 'sos' | 'sosOff';

/** les services de notification des navigateurs : le serveur n'envoie nulle part ailleurs (sinon, n'importe qui avec un
 *  lien lui ferait appeler l'adresse de son choix) */
export const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|web\.push\.apple\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)$/;
/** abonnés d'un pilote, pilotes suivis par un navigateur */
const MAX_PER_PILOT = 200, MAX_PER_BROWSER = 50;
/** sans gnd, la trace relue au plus tous les CHECK_S (s), sur WINDOW_S (s), un point par STEP_S (s) */
const CHECK_S = 20, WINDOW_S = 3600, STEP_S = 5;
/** un décollage ou un posé arrivé plus tard que ça (renvoi après une longue coupure) ne prévient plus personne (s) */
const STALE_S = 1800;
/** deux décollages (ou deux posés) d'un même pilote prévenus à au moins ça d'écart (s) : un logiciel qui hésite */
const MIN_GAP_S = 300;

interface Watch {
  /** en vol ; null : pas encore su (premier point vu depuis l'abonnement ou le démarrage) */
  air: boolean | null;
  /** son logiciel marque les points au sol */
  gnd: boolean;
  checkAt: number;
  sent: Partial<Record<PushKind, number>>;
}

export interface PushEvent { kind: PushKind; t: number; lat?: number | null; lon?: number | null }

export class Push {
  readonly vapid: Vapid;
  /** hôtes permis (les tests y mettent 127.0.0.1) */
  allow: RegExp = PUSH_HOSTS;
  /** l'envoi, remplaçable dans les tests */
  deliver: (sub: PushSub, payload: unknown, opts: { ttl: number; urgency: 'normal' | 'high' }, nowS: number) => Promise<number>;
  /** envois en cours (les tests les attendent) */
  pending = new Set<Promise<void>>();
  stats = { sent: 0, failed: 0, gone: 0 };

  private store: Store;
  private pids: Set<number>;
  private watch = new Map<number, Watch>();
  /** nom affiché et pilote bloqué, d'après la mémoire du direct */
  private who: (pid: number) => { name: string; blocked: boolean } | null;

  constructor(store: Store, who: (pid: number) => { name: string; blocked: boolean } | null, env: { publicKey?: string; privateKey?: string; subject?: string } = {}) {
    this.store = store;
    this.who = who;
    // les clés : de l'environnement, sinon tirées une fois et gardées dans la base (changer de clé coupe tous les abonnés)
    let keys: VapidKeys | null = env.publicKey && env.privateKey ? { publicKey: env.publicKey, privateKey: env.privateKey } : null;
    if (!keys) {
      const saved = store.meta('vapid');
      keys = saved ? JSON.parse(saved) as VapidKeys : newVapidKeys();
      if (!saved) store.setMeta('vapid', JSON.stringify(keys));
    }
    this.vapid = new Vapid(keys, env.subject ?? '');
    this.deliver = (sub, payload, opts, nowS) => this.vapid.send(sub, payload, opts, nowS);
    this.pids = new Set(store.pushPids());
  }

  /** la clé publique que le navigateur donne en s'abonnant */
  get publicKey() { return this.vapid.keys.publicKey; }

  /** sans VAPID_SUBJECT : l'adresse du serveur, vue à la première demande d'abonnement */
  origin(o: string) { if (!this.vapid.subject && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) this.vapid.subject = o; }

  /** abonnement reçu de la page : vérifié, gardé ; une erreur à donner au navigateur, sinon null */
  subscribe(pid: number, hash: string, raw: unknown, nowS: number): string | null {
    const s = parseSub(raw, this.allow);
    if (!s) return 'bad-subscription';
    if (!this.store.pushHas(pid, s.endpoint)) {
      const n = this.store.pushCount(pid, s.endpoint);
      if (n.byPilot >= MAX_PER_PILOT || n.byEndpoint >= MAX_PER_BROWSER) return 'too-many-subscriptions';
    }
    this.store.pushAdd(pid, hash, s, Math.floor(nowS));
    this.pids.add(pid);
    return null;
  }
  unsubscribe(pid: number, endpoint: unknown) { if (typeof endpoint === 'string') this.store.pushDel(pid, endpoint); }
  subscribed(pid: number, endpoint: unknown) { return typeof endpoint === 'string' && this.store.pushHas(pid, endpoint); }
  forget(pid: number) { this.pids.delete(pid); this.watch.delete(pid); }

  /**
   * points enregistrés d'un pilote (au sol compris) : décollage, posé. `sos` : en alerte, ses points n'ont plus de
   * marque au sol (ils sont publics) ; rien n'est déduit d'eux
   */
  onFixes(pid: number, fixes: Fix[], nowS: number, sos: boolean) {
    if (!this.pids.has(pid) || !fixes.length || sos) return;
    let w = this.watch.get(pid);
    if (!w) this.watch.set(pid, w = { air: null, gnd: false, checkAt: 0, sent: {} });
    if (fixes.some(f => f.gnd)) w.gnd = true;
    if (w.gnd) {
      for (const f of [...fixes].sort((a, b) => a.ts - b.ts)) {
        const air = !f.gnd;
        if (w.air !== null && air !== w.air) this.event(pid, w, { kind: air ? 'takeoff' : 'landed', t: f.ts, lat: f.lat, lon: f.lon }, nowS);
        w.air = air;
      }
      return;
    }
    if (nowS - w.checkAt < CHECK_S) return;
    w.checkAt = nowS;
    const pts = this.store.trackThin(pid, Math.floor(nowS) - WINDOW_S, Math.floor(nowS) + 120, STEP_S, true).map(wireGnd);
    const segs = splitFlights(pts) as { i0: number; i1: number; t0: number; t1: number; air: boolean }[];
    const last = segs.at(-1);
    if (!last) return;
    if (w.air !== null && last.air !== w.air) {
      // décollé : le début du vol ; posé : la fin du vol d'avant
      const prev = segs.at(-2), f = last.air ? pts[last.i0] : prev?.air ? pts[prev.i1] : pts[last.i0];
      this.event(pid, w, { kind: last.air ? 'takeoff' : 'landed', t: f[0], lat: f[1], lon: f[2] }, nowS);
    }
    w.air = last.air;
  }

  /** l'état déclaré change : posé OK, SOS, alerte levée */
  onStatus(pid: number, prev: PilotStatus | null, next: PilotStatus | null, nowS: number) {
    if (!this.pids.has(pid)) return;
    const was = prev?.state ?? null, is = next?.state ?? null;
    if (was === is) return;
    if (is === 'sos') this.notify(pid, { kind: 'sos', t: next!.t, lat: next!.lat, lon: next!.lon }, nowS);
    else if (is === 'ok') this.notify(pid, { kind: 'ok', t: next!.t, lat: next!.lat, lon: next!.lon }, nowS);
    else if (was === 'sos') this.notify(pid, { kind: 'sosOff', t: Math.floor(nowS) }, nowS);
  }

  private event(pid: number, w: Watch, e: PushEvent, nowS: number) {
    if (nowS - e.t > STALE_S || nowS - (w.sent[e.kind] ?? -Infinity) < MIN_GAP_S) return;
    w.sent[e.kind] = nowS;
    this.notify(pid, e, nowS);
  }

  /** à tous les abonnés du lien en cours ; un abonnement fini (404, 410) est retiré */
  notify(pid: number, e: PushEvent, nowS: number) {
    const who = this.who(pid);
    if (!who || who.blocked) return;
    const subs = this.store.pushOf(pid);
    if (!subs.length) { this.pids.delete(pid); return; }
    const sos = e.kind === 'sos';
    const opts = { ttl: sos ? 86400 : 3600, urgency: sos || e.kind === 'sosOff' ? 'high' as const : 'normal' as const };
    for (const s of subs) {
      const payload = { k: s.hash.slice(0, 16), name: who.name, ...e };
      const job = this.deliver(s, payload, opts, nowS).then(status => {
        if (status === 404 || status === 410) { this.store.pushDel(pid, s.endpoint); this.stats.gone++; }
        else if (status >= 200 && status < 300) this.stats.sent++;
        else { this.stats.failed++; console.warn(`[notifications] ${new URL(s.endpoint).host} : ${status}`); }
      }, err => { this.stats.failed++; console.warn(`[notifications] ${new URL(s.endpoint).host} : ${(err as Error).message}`); })
        .finally(() => this.pending.delete(job));
      this.pending.add(job);
    }
  }
}

/** { endpoint, keys: { p256dh, auth } } (PushSubscription.toJSON) ; null : pas valable */
export function parseSub(raw: unknown, allow: RegExp = PUSH_HOSTS): PushSub | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = r.endpoint, p256dh = r.keys?.p256dh, auth = r.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  let u: URL;
  try { u = new URL(endpoint); } catch { return null; }
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && allow !== PUSH_HOSTS)) || u.username || u.password || !allow.test(u.hostname)) return null;
  if (!validKeys(p256dh, auth)) return null;
  return { endpoint, p256dh, auth };
}
