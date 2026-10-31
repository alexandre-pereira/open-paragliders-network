// Le serveur sans le réseau : appareils, envoi des points, profils, entretien de l'historique.
//
// Un appareil s'annonce avec un identifiant qu'il choisit (device) et un secret qu'il tire au hasard et garde : le
// premier envoi réserve l'identifiant, les suivants doivent donner le même secret. Pas de compte ni de mot de passe à
// retenir pour le pilote ; personne d'autre ne peut écrire sous son nom.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { statfsSync } from 'node:fs';
import type { Config } from './config.ts';
import { parseFix, type NewFix } from './fix.ts';
import { Live } from './live.ts';
import { EMPTY_PROFILE, mergeProfile, sameProfile, type Profile } from './profile.ts';
import type { PilotRow, Store } from './store.ts';

export const DEVICE_RE = /^[A-Za-z0-9_.:@-]{6,80}$/;
export const SECRET_MIN = 16;

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

  constructor(cfg: Config, store: Store) {
    this.cfg = cfg;
    this.store = store;
    this.live = new Live(cfg.liveWindowMin * 60, store.maxSeq());
    for (const p of store.allPilots()) this.live.setPilot(p.pid, profileOf(p), p.pv, p.blocked);
    this.live.load(store.recent(Math.floor(this.now()) - cfg.liveWindowMin * 60));
  }

  now() { return this.clock(); }
  /** le point le plus vieux accepté (s) */
  oldest() { return Math.floor(this.now()) - this.cfg.retentionH * 3600; }

  /** l'appareil, réservé à son premier envoi ; refus si le secret ne va pas ou si le pilote est bloqué */
  authDevice(c: Credentials, opts: { create?: boolean; slow?: boolean; profile?: Profile } = {}): PilotRow {
    const device = typeof c.device === 'string' ? c.device.trim() : '', secret = typeof c.secret === 'string' ? c.secret : '';
    if (!DEVICE_RE.test(device)) throw new HttpError(400, 'bad-device', 'device : 6 à 80 caractères parmi A-Z a-z 0-9 _ . : @ -');
    if (secret.length < (opts.slow ? 1 : SECRET_MIN) || secret.length > 200) throw new HttpError(400, 'bad-secret', `secret : ${SECRET_MIN} à 200 caractères`);
    let p = this.store.pilotByDevice(device);
    if (!p) {
      if (opts.create === false) throw new HttpError(404, 'unknown-device');
      p = this.store.createPilot(device, hashSecret(secret, opts.slow), opts.profile ?? EMPTY_PROFILE, Math.floor(this.now()));
      this.live.setPilot(p.pid, profileOf(p), p.pv, p.blocked);
      return p;
    }
    if (!checkSecret(secret, p.secret)) throw new HttpError(403, 'device-taken', 'cet identifiant d’appareil appartient à un autre secret');
    if (p.blocked) throw new HttpError(403, 'blocked');
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
  ingest(body: Record<string, unknown>): IngestResult {
    const p = this.authDevice(body, { profile: mergeProfile(EMPTY_PROFILE, body.pilot, body.app) });
    if (body.pilot !== undefined || body.app !== undefined) this.updateProfile(p, body.pilot, body.app);
    return this.ingestFor(p, body.points ?? []);
  }

  /** le pilote efface tout ce que le serveur a de lui */
  forget(c: Credentials) {
    const p = this.authDevice(c, { create: false });
    this.remove(p.pid);
  }

  remove(pid: number) { this.store.deletePilot(pid); this.live.removePilot(pid); }

  block(pid: number, blocked: boolean) {
    const p = this.store.pilotById(pid);
    if (!p) throw new HttpError(404, 'unknown-pilot');
    this.store.setBlocked(pid, blocked);
    this.live.setPilot(pid, profileOf(p), p.pv, blocked);
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
    this.lastMaintenance = { at: nowS, purged, evicted, forgotten: forgotten.length, ms: Math.round(performance.now() - t0) };
    return this.lastMaintenance;
  }
}

export const profileOf = (p: PilotRow): Profile => ({ first: p.first, last: p.last, wing: p.wing, type: p.type, app: p.app });
