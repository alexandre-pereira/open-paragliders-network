// Stockage sur disque : une base SQLite (node:sqlite, sans dépendance native), en mode WAL.
//
// La table des points est un anneau : les points de plus de RETENTION_HOURS sont effacés, et quand la base dépasse
// MAX_DB_MB (ou que le disque passe sous MIN_FREE_DISK_MB) les plus vieux points partent d'abord. Les pages libérées
// sont réutilisées par les points suivants : le fichier ne grossit plus, les plus vieux points sont réécrits.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Fix, NewFix } from './fix.ts';
import { EMPTY_PROFILE, type AircraftType, type PilotState, type PilotStatus, type Profile } from './profile.ts';

export interface PilotRow extends Profile {
  pid: number;
  device: string;
  /** SHA-256 (hex) du secret de l'appareil */
  secret: string;
  /** version du profil, augmentée à chaque changement (les abonnés ne le reçoivent qu'une fois) */
  pv: number;
  blocked: boolean;
  created: number;
  seen: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pilots (
  pid INTEGER PRIMARY KEY,
  device TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  first TEXT NOT NULL DEFAULT '',
  last TEXT NOT NULL DEFAULT '',
  wing TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'paraglider',
  app TEXT NOT NULL DEFAULT '',
  ids TEXT NOT NULL DEFAULT '{}',
  pv INTEGER NOT NULL DEFAULT 1,
  blocked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS points (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  pid INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  alt REAL,
  spd REAL,
  crs REAL,
  vz REAL,
  rx INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS points_pid_ts ON points (pid, ts);
CREATE INDEX IF NOT EXISTS points_ts ON points (ts);
CREATE TABLE IF NOT EXISTS lt24 (
  sid TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  pid INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  t INTEGER NOT NULL,
  lat REAL,
  lon REAL,
  alt REAL
);
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  contact TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  rotated INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bans (
  device TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  ip TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS shares (
  pid INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL
);
`;

/** un logiciel géré au back-office */
export interface AppRow { id: number; name: string; contact: string; note: string; hash: string; revoked: boolean; created: number; rotated: number; seen: number; requests: number; points: number }
export interface BanRow { device: string; label: string; reason: string; at: number }
export interface AuditRow { t: number; ip: string; action: string; detail: string }

type Row = Record<string, unknown>;
const toPilot = (r: Row): PilotRow => ({
  pid: r.pid as number, device: r.device as string, secret: r.secret as string,
  first: r.first as string, last: r.last as string, wing: r.wing as string, type: r.type as AircraftType, app: r.app as string,
  ...(r.ids && r.ids !== '{}' ? { ids: JSON.parse(r.ids as string) as Record<string, string> } : {}),
  pv: r.pv as number, blocked: !!r.blocked, created: r.created as number, seen: r.seen as number,
});
const toFix = (r: Row): Fix => ({
  seq: r.seq as number, pid: r.pid as number, ts: r.ts as number, lat: r.lat as number, lon: r.lon as number,
  alt: r.alt as number | null, spd: r.spd as number | null, crs: r.crs as number | null, vz: r.vz as number | null, rx: r.rx as number,
});

/** garde un point tous les `step` secondes au plus, toujours le dernier */
export function thin(fixes: Fix[], step: number): Fix[] {
  if (step <= 1 || fixes.length < 3) return fixes;
  const out: Fix[] = [];
  let last = -Infinity;
  for (let i = 0; i < fixes.length; i++) {
    if (fixes[i].ts - last >= step || i === fixes.length - 1) { out.push(fixes[i]); last = fixes[i].ts; }
  }
  return out;
}

export class Store {
  readonly db: DatabaseSync;
  private st: Record<string, StatementSync> = {};

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    // auto_vacuum ne compte que sur une base neuve : les pages libres peuvent ensuite être rendues au disque
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA cache_size = -16000');
    this.db.exec(SCHEMA);
    // base d'avant les identifiants
    if (!(this.db.prepare('PRAGMA table_info(pilots)').all() as Row[]).some(c => c.name === 'ids')) this.db.exec("ALTER TABLE pilots ADD COLUMN ids TEXT NOT NULL DEFAULT '{}'");
    const p = (k: string, sql: string) => { this.st[k] = this.db.prepare(sql); };
    p('byDevice', 'SELECT * FROM pilots WHERE device = ?');
    p('byId', 'SELECT * FROM pilots WHERE pid = ?');
    p('newPilot', `INSERT INTO pilots (device, secret, first, last, wing, type, app, ids, pv, blocked, created, seen)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?) RETURNING *`);
    p('profile', 'UPDATE pilots SET first = ?, last = ?, wing = ?, type = ?, app = ?, ids = ?, pv = pv + 1 WHERE pid = ? RETURNING pv');
    p('seen', 'UPDATE pilots SET seen = ? WHERE pid = ?');
    p('blocked', 'UPDATE pilots SET blocked = ? WHERE pid = ?');
    p('delPoints', 'DELETE FROM points WHERE pid = ?');
    p('delPilot', 'DELETE FROM pilots WHERE pid = ?');
    p('delLt24', 'DELETE FROM lt24 WHERE pid = ?');
    p('insert', `INSERT OR IGNORE INTO points (pid, ts, lat, lon, alt, spd, crs, vz, rx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`);
    p('recent', 'SELECT * FROM points WHERE ts >= ? ORDER BY seq');
    p('track', 'SELECT * FROM points WHERE pid = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?');
    p('range', 'SELECT * FROM points WHERE ts >= ? AND ts <= ? ORDER BY pid, ts');
    p('stats', `SELECT pid, count(*) AS n, min(ts) AS t0, max(ts) AS t1 FROM points WHERE ts >= ? AND ts <= ? GROUP BY pid`);
    p('lastFix', 'SELECT * FROM points WHERE pid = ? ORDER BY ts DESC LIMIT 1');
    p('maxSeq', "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'points'), 0) AS s");
    p('count', 'SELECT count(*) AS n, min(ts) AS t0 FROM points');
    p('purge', 'DELETE FROM points WHERE seq IN (SELECT seq FROM points WHERE ts < ? LIMIT 20000)');
    p('evict', 'DELETE FROM points WHERE seq IN (SELECT seq FROM points ORDER BY ts LIMIT ?)');
    p('idle', `SELECT pid FROM pilots WHERE seen < ? AND NOT EXISTS (SELECT 1 FROM points WHERE points.pid = pilots.pid)`);
    p('lt24Get', 'SELECT pid FROM lt24 WHERE sid = ?');
    p('lt24Put', 'INSERT INTO lt24 (sid, pid, at) VALUES (?, ?, ?) ON CONFLICT (sid) DO UPDATE SET pid = excluded.pid, at = excluded.at');
    p('lt24Purge', 'DELETE FROM lt24 WHERE at < ?');
    p('sharePid', 'SELECT pid FROM shares WHERE hash = ?');
    p('sharePut', 'INSERT INTO shares (pid, hash, at) VALUES (?, ?, ?) ON CONFLICT (pid) DO UPDATE SET hash = excluded.hash, at = excluded.at');
    p('delShare', 'DELETE FROM shares WHERE pid = ?');
    p('banned', 'SELECT 1 FROM bans WHERE device = ?');
    p('audit', 'INSERT INTO audit (t, ip, action, detail) VALUES (?, ?, ?, ?)');
    p('appCount', 'UPDATE apps SET requests = requests + ?, points = points + ?, seen = max(seen, ?) WHERE name = ?');
    p('bump', 'UPDATE pilots SET pv = pv + 1 WHERE pid = ? RETURNING pv');
    p('alertPut', `INSERT INTO alerts (pid, state, t, lat, lon, alt) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (pid) DO UPDATE SET state = excluded.state, t = excluded.t, lat = excluded.lat, lon = excluded.lon, alt = excluded.alt`);
    p('alertDel', 'DELETE FROM alerts WHERE pid = ?');
    p('alertOld', 'SELECT pid FROM alerts WHERE t < ?');
  }

  close() { try { this.db.close(); } catch { /* déjà fermée */ } }

  // ── pilotes ────────────────────────────────────────────────────────────────────────────────────────────────────

  pilotByDevice(device: string): PilotRow | undefined { const r = this.st.byDevice.get(device) as Row | undefined; return r && toPilot(r); }
  pilotById(pid: number): PilotRow | undefined { const r = this.st.byId.get(pid) as Row | undefined; return r && toPilot(r); }
  allPilots(): PilotRow[] { return (this.db.prepare('SELECT * FROM pilots').all() as Row[]).map(toPilot); }

  createPilot(device: string, secret: string, p: Profile = EMPTY_PROFILE, now: number): PilotRow {
    return toPilot(this.st.newPilot.get(device, secret, p.first, p.last, p.wing, p.type, p.app, JSON.stringify(p.ids ?? {}), now, now) as Row);
  }
  /** nouvelle version du profil */
  setProfile(pid: number, p: Profile): number {
    return (this.st.profile.get(p.first, p.last, p.wing, p.type, p.app, JSON.stringify(p.ids ?? {}), pid) as Row).pv as number;
  }
  touch(pid: number, now: number) { this.st.seen.run(now, pid); }
  setBlocked(pid: number, b: boolean) { this.st.blocked.run(b ? 1 : 0, pid); }
  /** le pilote et toute sa trace */
  deletePilot(pid: number) {
    this.tx(() => { this.st.delPoints.run(pid); this.st.delLt24.run(pid); this.st.delShare.run(pid); this.st.alertDel.run(pid); this.st.delPilot.run(pid); });
  }
  // ── logiciels ──────────────────────────────────────────────────────────────────────────────────────────────────

  allApps(): AppRow[] { return (this.db.prepare('SELECT * FROM apps ORDER BY name').all() as Row[]).map(r => ({ ...r, revoked: !!r.revoked }) as unknown as AppRow); }
  addApp(name: string, contact: string, note: string, hash: string, now: number): number {
    return Number(this.db.prepare('INSERT INTO apps (name, contact, note, hash, created) VALUES (?, ?, ?, ?, ?)').run(name, contact, note, hash, now).lastInsertRowid);
  }
  setAppKey(id: number, hash: string, now: number) { this.db.prepare('UPDATE apps SET hash = ?, rotated = ?, revoked = 0 WHERE id = ?').run(hash, now, id); }
  setAppRevoked(id: number, revoked: boolean) { this.db.prepare('UPDATE apps SET revoked = ? WHERE id = ?').run(revoked ? 1 : 0, id); }
  setAppInfo(id: number, contact: string, note: string) { this.db.prepare('UPDATE apps SET contact = ?, note = ? WHERE id = ?').run(contact, note, id); }
  deleteApp(id: number) { this.db.prepare('DELETE FROM apps WHERE id = ?').run(id); }
  appCount(name: string, requests: number, points: number, seen: number) { this.st.appCount.run(requests, points, seen, name); }

  // ── bannissements, journal ─────────────────────────────────────────────────────────────────────────────────────

  /** un appareil banni le reste même si son pilote est effacé : il ne pourra pas se réinscrire sous le même nom */
  banned(device: string) { return !!this.st.banned.get(device); }
  ban(device: string, label: string, reason: string, now: number) {
    this.db.prepare('INSERT INTO bans (device, label, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT (device) DO UPDATE SET label = excluded.label, reason = excluded.reason').run(device, label, reason, now);
  }
  unban(device: string) { this.db.prepare('DELETE FROM bans WHERE device = ?').run(device); }
  allBans(): BanRow[] { return this.db.prepare('SELECT * FROM bans ORDER BY at DESC').all() as unknown as BanRow[]; }
  log(t: number, ip: string, action: string, detail = '') { this.st.audit.run(t, ip, action, detail); }
  journal(limit = 200): AuditRow[] { return this.db.prepare('SELECT t, ip, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit) as unknown as AuditRow[]; }
  purgeJournal(cutoff: number) { this.db.prepare('DELETE FROM audit WHERE t < ?').run(cutoff); }

  /** état déclaré du pilote ; null : retiré. Nouvelle version du profil : les abonnés le reçoivent */
  setAlert(pid: number, a: PilotStatus | null): number {
    if (a) this.st.alertPut.run(pid, a.state, a.t, a.lat, a.lon, a.alt); else this.st.alertDel.run(pid);
    return (this.st.bump.get(pid) as Row).pv as number;
  }
  allAlerts(): (PilotStatus & { pid: number })[] {
    return (this.db.prepare('SELECT * FROM alerts').all() as Row[]).map(r => ({
      pid: r.pid as number, state: r.state as PilotState, t: r.t as number, lat: r.lat as number | null, lon: r.lon as number | null, alt: r.alt as number | null,
    }));
  }
  /** les pilotes dont l'état date d'avant `cutoff` */
  oldAlerts(cutoff: number): number[] { return (this.st.alertOld.all(cutoff) as Row[]).map(r => r.pid as number); }
  /** le pilote d'un lien de suivi (empreinte du jeton) */
  sharePid(hash: string): number | undefined { return (this.st.sharePid.get(hash) as Row | undefined)?.pid as number | undefined; }
  /** le lien de suivi du pilote : un seul, le précédent cesse de marcher */
  setShare(pid: number, hash: string, now: number) { this.st.sharePut.run(pid, hash, now); }

  // ── points ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** les points nouveaux, avec leur numéro ; un point déjà reçu (même pilote, même seconde) est ignoré */
  insertFixes(pid: number, fixes: NewFix[], rx: number): Fix[] {
    const out: Fix[] = [];
    this.tx(() => {
      for (const f of fixes) {
        const r = this.st.insert.get(pid, f.ts, f.lat, f.lon, f.alt, f.spd, f.crs, f.vz, rx) as Row | undefined;
        if (r) out.push({ ...f, seq: r.seq as number, pid, rx });
      }
    });
    return out;
  }

  /** les points depuis `sinceTs`, dans l'ordre d'arrivée (rechargement de la mémoire au démarrage) */
  recent(sinceTs: number): Fix[] { return (this.st.recent.all(sinceTs) as Row[]).map(toFix); }

  track(pid: number, from: number, to: number, limit = 100000, step = 0): Fix[] {
    return thin((this.st.track.all(pid, from, to, limit) as Row[]).map(toFix), step);
  }

  /** toutes les traces d'une période, allégées (un point par `step` s), `maxPoints` au plus en tout */
  tracks(from: number, to: number, step: number, maxPoints = 1_000_000): Map<number, Fix[]> {
    const out = new Map<number, Fix[]>();
    let total = 0, cur: Fix[] = [], curPid = -1, last = -Infinity;
    for (const r of this.st.range.iterate(from, to) as Iterable<Row>) {
      const f = toFix(r);
      if (f.pid !== curPid) { curPid = f.pid; cur = []; out.set(curPid, cur); last = -Infinity; }
      if (f.ts - last >= step) { cur.push(f); last = f.ts; total++; }
      else cur[cur.length - 1] = f; // le dernier point d'une trace est toujours le plus récent
      if (total >= maxPoints) break;
    }
    return out;
  }

  stats(from: number, to: number): { pid: number; n: number; t0: number; t1: number }[] {
    return this.st.stats.all(from, to) as { pid: number; n: number; t0: number; t1: number }[];
  }
  lastFix(pid: number): Fix | undefined { const r = this.st.lastFix.get(pid) as Row | undefined; return r && toFix(r); }
  maxSeq(): number { return (this.st.maxSeq.get() as Row).s as number; }
  count(): { n: number; t0: number | null } { return this.st.count.get() as { n: number; t0: number | null }; }

  // ── entretien ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** efface les points d'avant `cutoff` ; nombre effacé */
  purgeBefore(cutoff: number): number {
    let total = 0, n: number;
    do { n = Number(this.st.purge.run(cutoff).changes); total += n; } while (n > 0);
    return total;
  }
  /** efface les `n` plus vieux points */
  evictOldest(n: number): number { return Number(this.st.evict.run(Math.max(1, Math.floor(n))).changes); }

  private pragma(name: string): number { return Object.values(this.db.prepare(`PRAGMA ${name}`).get() as Row)[0] as number; }
  /** octets occupés par les données (pages libres non comptées) */
  usedBytes(): number { return (this.pragma('page_count') - this.pragma('freelist_count')) * this.pragma('page_size'); }
  /** taille du fichier */
  fileBytes(): number { return this.pragma('page_count') * this.pragma('page_size'); }
  /** rend au disque les pages libres (manque de place sur le disque) */
  shrink() { this.db.exec('PRAGMA incremental_vacuum'); }
  /** vide le journal WAL dans la base (il ne grossit pas sans fin) */
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* lecteur en cours : au prochain tour */ } }

  /** pilotes sans point et pas vus depuis `cutoff` : oubliés */
  forgetIdle(cutoff: number): number[] {
    const pids = (this.st.idle.all(cutoff) as Row[]).map(r => r.pid as number);
    for (const pid of pids) this.deletePilot(pid);
    return pids;
  }

  // ── LiveTrack24 : session → pilote ─────────────────────────────────────────────────────────────────────────────

  lt24Get(sid: string): number | undefined { return (this.st.lt24Get.get(sid) as Row | undefined)?.pid as number | undefined; }
  lt24Put(sid: string, pid: number, now: number) { this.st.lt24Put.run(sid, pid, now); }
  lt24Purge(cutoff: number) { this.st.lt24Purge.run(cutoff); }

  private tx(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* déjà annulée */ } throw e; }
  }
}
