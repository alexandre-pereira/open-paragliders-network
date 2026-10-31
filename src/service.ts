// Le serveur sans le réseau : appareils, envoi des points, profils, entretien de l'historique.
//
// Un appareil s'annonce avec un identifiant qu'il choisit (device) et un secret qu'il tire au hasard et garde : le
// premier envoi réserve l'identifiant, les suivants doivent donner le même secret. Pas de compte ni de mot de passe à
// retenir pour le pilote ; personne d'autre ne peut écrire sous son nom.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { Apps } from './apps.ts';
import type { Config } from './config.ts';
import { parseFix, wire, type NewFix } from './fix.ts';
import { Live } from './live.ts';
import { EMPTY_PROFILE, mergeProfile, sameProfile, type PilotStatus, type Profile } from './profile.ts';
import { RateLimiter } from './rate.ts';
import type { PilotRow, Store } from './store.ts';

export const DEVICE_RE = /^[A-Za-z0-9_.:@-]{6,80}$/;
export const SECRET_MIN = 16;
/** jeton d'un lien de suivi : tiré au hasard par l'appareil, 128 bits au moins */
export const SHARE_RE = /^[A-Za-z0-9_-]{22,64}$/;
/** ce qu'un lien de suivi remonte (h), et un point par SHARED_STEP s dans cette trace */
const SHARED_H = 24, SHARED_STEP = 5;
/** la trace montrée avant une alerte (s) */
const SOS_TRAIL_S = 1800;
/** bannissement d'une adresse IP (s) : elle change, et un opérateur mobile la partage entre beaucoup de monde */
const IP_BAN_S = 86400;
/** le journal des actions du back-office (s) */
const JOURNAL_S = 30 * 86400;
/** alertes montrées au plus sur la page publique */
const MAX_SOS = 200;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) { super(message ?? code); this.status = status; this.code = code; }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** secret tiré au hasard par l'appareil : SHA-256 suffit ; mot de passe choisi (LiveTrack24) : scrypt */
export function hashSecret(secret: string, slow = false): string {
  if (!slow) return sha256(secret);
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(secret, salt, 32).toString('hex')}`;
}
export function checkSecret(secret: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  const got = kind === 'scrypt' ? scryptSync(secret, salt, 32).toString('hex') : sha256(secret);
  const want = kind === 'scrypt' ? hash : stored;
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export interface IngestResult {
  ok: true;
  /** identifiant public du pilote */
  pilot: string;
  /** points enregistrés */
  stored: number;
  /** points déjà reçus (renvoyés après une réponse perdue) */
  dup: number;
  /** points refusés (heure ou position impossible, trop vieux) */
  bad: number;
  /** heure du dernier point que le serveur a de ce pilote */
  last: number | null;
}

export interface Credentials { device?: unknown; secret?: unknown }

export class Service {
  readonly live: Live;
  /** heure (s), remplaçable dans les tests */
  clock: () => number = () => Date.now() / 1000;
  /** après un enregistrement : les abonnés en direct (ws.ts) peuvent partir plus tôt */
  onFixes: (() => void) | null = null;
  lastMaintenance = { at: 0, purged: 0, evicted: 0, forgotten: 0, ms: 0 };

  readonly cfg: Config;
  readonly store: Store;
  readonly apps: Apps;
  private newDevices: RateLimiter;
  /** adresses bannies → fin ; en mémoire seulement : aucune adresse sur le disque */
  private ipBans = new Map<string, { until: number; label: string; reason: string; at: number }>();
  /** dernière adresse de chaque pilote, pour pouvoir la bannir ; en mémoire seulement */
  private lastIp = new Map<number, string>();
  /** le pilote et son logiciel doivent être déconnectés (ws.ts) */
  onDropApp: ((name: string) => void) | null = null;
  onDropIp: ((ip: string) => void) | null = null;

  constructor(cfg: Config, store: Store) {
    this.cfg = cfg;
    this.store = store;
    this.apps = new Apps(cfg.appKeys, store);
    this.newDevices = new RateLimiter(cfg.rateNewDevice);
    this.live = new Live(cfg.liveWindowMin * 60, store.maxSeq());
    for (const p of store.allPilots()) this.live.setPilot(p.pid, profileOf(p), p.pv, p.blocked);
    this.live.load(store.recent(Math.floor(this.now()) - cfg.liveWindowMin * 60));
    for (const { pid, ...a } of store.allAlerts()) { const p = this.live.pilots.get(pid); if (p) this.live.setStatus(pid, a, p.pv); }
  }

  now() { return this.clock(); }
  /** le point le plus vieux accepté (s) */
  oldest() { return Math.floor(this.now()) - this.cfg.retentionH * 3600; }

  /** l'appareil, réservé à son premier envoi ; refus si le secret ne va pas ou si le pilote est bloqué */
  authDevice(c: Credentials, opts: { create?: boolean; slow?: boolean; profile?: Profile; ip?: string; blockedToo?: boolean } = {}): PilotRow {
    const device = typeof c.device === 'string' ? c.device.trim() : '', secret = typeof c.secret === 'string' ? c.secret : '';
    if (!DEVICE_RE.test(device)) throw new HttpError(400, 'bad-device', 'device : 6 à 80 caractères parmi A-Z a-z 0-9 _ . : @ -');
    if (secret.length < (opts.slow ? 1 : SECRET_MIN) || secret.length > 200) throw new HttpError(400, 'bad-secret', `secret : ${SECRET_MIN} à 200 caractères`);
    let p = this.store.pilotByDevice(device);
    if (!p) {
      if (opts.create === false) throw new HttpError(404, 'unknown-device');
      if (this.store.banned(device)) throw new HttpError(403, 'blocked');
      if (opts.ip && !this.newDevices.hit(opts.ip)) throw new HttpError(429, 'rate-limited', 'trop d’appareils nouveaux, réessayer dans une minute');
      p = this.store.createPilot(device, hashSecret(secret, opts.slow), opts.profile ?? EMPTY_PROFILE, Math.floor(this.now()));
      this.live.setPilot(p.pid, profileOf(p), p.pv, p.blocked);
      return p;
    }
    if (!checkSecret(secret, p.secret)) throw new HttpError(403, 'device-taken', 'cet identifiant d’appareil appartient à un autre secret');
    if (p.blocked && !opts.blockedToo) throw new HttpError(403, 'blocked');
    if (opts.ip) this.lastIp.set(p.pid, opts.ip);
    return p;
  }

  /** profil reçu (champs absents gardés) ; renvoie le profil à jour */
  updateProfile(p: PilotRow, raw: unknown, app?: unknown): Profile {
    const cur = profileOf(p), next = mergeProfile(cur, raw, app);
    if (!sameProfile(cur, next)) {
      p.pv = this.store.setProfile(p.pid, next);
      Object.assign(p, next);
      this.live.setPilot(p.pid, next, p.pv, p.blocked);
    }
    return next;
  }

  /** enregistre les points d'un pilote ; un point déjà reçu est ignoré : renvoyer un envoi est sans risque */
  ingestFor(p: PilotRow, raw: unknown): IngestResult {
    if (!Array.isArray(raw)) throw new HttpError(400, 'bad-points', 'points : tableau attendu');
    if (raw.length > this.cfg.maxBatch) throw new HttpError(413, 'too-many-points', `${this.cfg.maxBatch} points au plus par envoi`);
    const nowS = this.now(), oldest = this.oldest();
    const good: NewFix[] = [];
    const seen = new Set<number>();
    let bad = 0, dup = 0;
    for (const r of raw) {
      const f = parseFix(r, nowS, oldest);
      if (!f) { bad++; continue; }
      if (seen.has(f.ts)) { dup++; continue; }
      seen.add(f.ts); good.push(f);
    }
    good.sort((a, b) => a.ts - b.ts);
    const stored = good.length ? this.store.insertFixes(p.pid, good, Math.floor(nowS)) : [];
    dup += good.length - stored.length;
    this.live.add(p.pid, stored);
    if (Math.floor(nowS) - p.seen >= 60) { this.store.touch(p.pid, Math.floor(nowS)); p.seen = Math.floor(nowS); }
    if (stored.length) this.onFixes?.();
    return { ok: true, pilot: String(p.pid), stored: stored.length, dup, bad, last: (this.live.last(p.pid) ?? this.store.lastFix(p.pid))?.ts ?? null };
  }

  /** envoi complet : identifiants, profil facultatif, points */
  ingest(body: Record<string, unknown>, ip?: string): IngestResult {
    const p = this.authDevice(body, { profile: mergeProfile(EMPTY_PROFILE, body.pilot, body.app), ip });
    if (body.pilot !== undefined || body.app !== undefined) this.updateProfile(p, body.pilot, body.app);
    return this.ingestFor(p, body.points ?? []);
  }

  /**
   * le lien de suivi du pilote, à donner à ses proches : le jeton est tiré par l'appareil, qui le garde ; le serveur
   * n'en a que l'empreinte (une base volée ne donne aucun lien). Un nouveau jeton remplace l'ancien, qui cesse de
   * marcher tout de suite ; redonner le même ne change rien, et rétablit le lien d'un pilote oublié entre-temps.
   */
  share(body: Record<string, unknown>, ip?: string) {
    const token = typeof body.token === 'string' ? body.token : '';
    if (!SHARE_RE.test(token)) throw new HttpError(400, 'bad-token', 'token : 22 à 64 caractères parmi A-Z a-z 0-9 _ -');
    const p = this.authDevice(body, { profile: mergeProfile(EMPTY_PROFILE, body.pilot, body.app), ip });
    if (body.pilot !== undefined || body.app !== undefined) this.updateProfile(p, body.pilot, body.app);
    const hash = sha256(token), owner = this.store.sharePid(hash);
    if (owner !== undefined && owner !== p.pid) throw new HttpError(409, 'token-taken');
    this.store.setShare(p.pid, hash, Math.floor(this.now()));
    return { ok: true as const, pilot: String(p.pid) };
  }

  /**
   * l'état du pilote, qu'il déclare : posé OK, posé pas OK (sos), ou plus rien (none : il a redécollé, ou il annule).
   * Marqué sur sa trace à l'endroit donné, sinon à son dernier point. Renvoyer le même état est sans risque.
   */
  setStatus(body: Record<string, unknown>, ip?: string) {
    const state = body.state;
    if (state !== 'ok' && state !== 'sos' && state !== 'none') throw new HttpError(400, 'bad-state', 'state : ok, sos ou none');
    const p = this.authDevice(body, { profile: mergeProfile(EMPTY_PROFILE, body.pilot, body.app), ip });
    if (body.pilot !== undefined || body.app !== undefined) this.updateProfile(p, body.pilot, body.app);
    const cur = this.live.pilots.get(p.pid)?.profile.status ?? null;
    if (state === 'none') {
      if (cur) this.apply(p.pid, null);
      return { ok: true as const, pilot: String(p.pid) };
    }
    const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max ? v : null);
    const last = this.live.last(p.pid) ?? this.store.lastFix(p.pid);
    const lat = num(body.lat, 90), lon = num(body.lon, 180), spot = lat !== null && lon !== null, nowS = Math.floor(this.now());
    const t = typeof body.t === 'number' && body.t > nowS - this.cfg.retentionH * 3600 && body.t < nowS + 120 ? Math.floor(body.t) : nowS;
    const next: PilotStatus = { state, t, lat: spot ? lat : last?.lat ?? null, lon: spot ? lon : last?.lon ?? null, alt: spot ? num(body.alt, 12000) : last?.alt ?? null };
    if (!cur || cur.state !== next.state || cur.t !== next.t || cur.lat !== next.lat || cur.lon !== next.lon) this.apply(p.pid, next);
    return { ok: true as const, pilot: String(p.pid) };
  }

  private apply(pid: number, status: PilotStatus | null) {
    this.live.setStatus(pid, status, this.store.setAlert(pid, status));
    this.onFixes?.();
  }

  /** le back-office retire une alerte */
  clearStatus(pid: number) {
    if (!this.store.pilotById(pid)) throw new HttpError(404, 'unknown-pilot');
    this.apply(pid, null);
  }

  /** la page publique : seuls les pilotes qui ont dit « posé pas OK », avec leur trace récente ; rien d'autre */
  sosList() {
    const nowS = Math.floor(this.now()), pilots = [];
    for (const p of this.live.pilots.values()) {
      const s = p.profile.status;
      if (p.blocked || s?.state !== 'sos') continue;
      const { first, last, wing, type } = p.profile;
      pilots.push({ p: { first, last, wing, type }, t: s.t, lat: s.lat, lon: s.lon, alt: s.alt, pts: this.store.track(p.pid, s.t - SOS_TRAIL_S, nowS + 120, 5000, SHARED_STEP).map(wire) });
    }
    return { now: nowS, pilots: pilots.sort((a, b) => b.t - a.t).slice(0, MAX_SOS) };
  }

  /**
   * ce qu'un lien de suivi montre : le nom et la trace de ce seul pilote, des dernières SHARED_H heures au plus, sans
   * identifiant ni logiciel ; `since` : les points d'après cette heure. Sans jeton connu, la même réponse pour tous
   */
  shared(token: string, since: string | null) {
    const pid = SHARE_RE.test(token) ? this.store.sharePid(sha256(token)) : undefined;
    const p = pid === undefined ? undefined : this.live.pilots.get(pid);
    if (pid === undefined || !p || p.blocked) throw new HttpError(404, 'unknown-link');
    const nowS = Math.floor(this.now()), oldest = nowS - Math.min(SHARED_H, this.cfg.retentionH) * 3600;
    const after = since !== null && since !== '' && Number.isFinite(Number(since)) ? Number(since) + 1 : null;
    const { first, last, wing, type, status } = p.profile;
    return { p: { first, last, wing, type }, ...(status ? { status } : {}), now: nowS, pts: this.store.track(pid, Math.max(oldest, after ?? 0), nowS + 120, 100000, after === null ? SHARED_STEP : 0).map(wire) };
  }

  /** le pilote efface tout ce que le serveur a de lui */
  forget(c: Credentials) {
    // un pilote bloqué garde le droit d'effacer ce qu'on a de lui ; son appareil reste banni
    const p = this.authDevice(c, { create: false, blockedToo: true });
    this.remove(p.pid);
  }

  remove(pid: number) { this.store.deletePilot(pid); this.live.removePilot(pid); this.lastIp.delete(pid); }

  block(pid: number, blocked: boolean, reason = '') {
    const p = this.store.pilotById(pid);
    if (!p) throw new HttpError(404, 'unknown-pilot');
    this.store.setBlocked(pid, blocked);
    if (blocked) this.store.ban(p.device, [p.first, p.last].filter(Boolean).join(' ') || p.device, reason.slice(0, 200), Math.floor(this.now()));
    else this.store.unban(p.device);
    this.live.setPilot(pid, profileOf(p), p.pv, blocked);
  }

  /** lève le bannissement d'un appareil, même si son pilote a été effacé */
  unbanDevice(device: string) {
    const p = this.store.pilotByDevice(device);
    if (p) this.block(p.pid, false); else this.store.unban(device);
  }

  /** bannit pour 24 h l'adresse d'où un pilote s'est connecté en dernier */
  banIp(pid: number, reason = '') {
    const ip = this.lastIp.get(pid), p = this.store.pilotById(pid);
    if (!ip || !p) throw new HttpError(404, 'no-address', 'pas d’adresse connue pour ce pilote depuis le dernier démarrage');
    const nowS = Math.floor(this.now());
    this.ipBans.set(ip, { until: nowS + IP_BAN_S, label: [p.first, p.last].filter(Boolean).join(' ') || p.device, reason: reason.slice(0, 200), at: nowS });
    this.onDropIp?.(ip);
    return ip;
  }
  ipBanned(ip: string) {
    const b = this.ipBans.get(ip);
    if (!b) return false;
    if (b.until > this.now()) return true;
    this.ipBans.delete(ip);
    return false;
  }
  unbanIp(ip: string) { this.ipBans.delete(ip); }
  bans() {
    const ips = [...this.ipBans].filter(([, b]) => b.until > this.now()).map(([value, b]) => ({ kind: 'ip', value, ...b }));
    return [...ips, ...this.store.allBans().map(b => ({ kind: 'device', value: b.device, label: b.label, reason: b.reason, at: b.at }))];
  }

  /** place libre sur le disque de la base (octets), Infinity si inconnue */
  freeDisk(): number {
    try { const s = statfsSync(this.cfg.dataDir); return s.bavail * s.bsize; } catch { return Infinity; }
  }

  /**
   * entretien, chaque minute : points de plus de RETENTION_HOURS effacés ; base au-dessus de MAX_DB_MB ou disque
   * sous MIN_FREE_DISK_MB : les plus vieux points partent jusqu'à repasser sous 95 % de la limite ; pilotes oubliés
   */
  maintain() {
    const t0 = performance.now(), nowS = Math.floor(this.now());
    const purged = this.store.purgeBefore(this.oldest());
    const cap = this.cfg.maxDbMb * 1048576, minFree = this.cfg.minFreeMb * 1048576;
    let evicted = 0;
    const full = () => this.store.usedBytes() > cap || this.freeDisk() < minFree;
    if (full()) {
      const total = this.store.count().n;
      for (let i = 0; i < 100 && (this.store.usedBytes() > cap * 0.95 || this.freeDisk() < minFree) && total - evicted > 0; i++) {
        evicted += this.store.evictOldest(Math.max(2000, total * 0.02));
        // le disque manque : les pages libérées lui sont rendues (sinon elles servent aux points suivants)
        if (this.freeDisk() < minFree) { this.store.checkpoint(); this.store.shrink(); }
      }
      console.warn(`[entretien] place : ${evicted} plus vieux points réécrits (base ${(this.store.usedBytes() / 1048576).toFixed(0)} Mo, disque libre ${(this.freeDisk() / 1048576).toFixed(0)} Mo)`);
    }
    this.store.checkpoint();
    this.live.trim(nowS);
    const forgotten = this.store.forgetIdle(nowS - this.cfg.pilotTtlDays * 86400);
    for (const pid of forgotten) this.live.removePilot(pid);
    this.store.lt24Purge(nowS - 2 * 86400);
    this.store.purgeJournal(nowS - JOURNAL_S);
    this.apps.flush();
    // un état dure autant que l'historique : une alerte n'est jamais retirée plus tôt sans que quelqu'un le décide
    for (const pid of this.store.oldAlerts(this.oldest())) this.apply(pid, null);
    this.lastMaintenance = { at: nowS, purged, evicted, forgotten: forgotten.length, ms: Math.round(performance.now() - t0) };
    return this.lastMaintenance;
  }
}

export const profileOf = (p: PilotRow): Profile => ({ first: p.first, last: p.last, wing: p.wing, type: p.type, app: p.app, ...(p.ids ? { ids: p.ids } : {}) });
