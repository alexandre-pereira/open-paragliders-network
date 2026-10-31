// Les logiciels autorisés à se connecter. Chacun a sa clé : on peut en ajouter, la renouveler ou la révoquer depuis le
// back-office sans redémarrer ni toucher aux autres. Seule l'empreinte de la clé est gardée : elle n'est montrée qu'à sa
// création. Les clés de APP_KEYS (environnement) marchent aussi, sans se gérer d'ici.

import { createHash, randomBytes } from 'node:crypto';
import type { AppKey } from './config.ts';
import type { AppRow, Store } from './store.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newKey = () => 'opn_' + randomBytes(24).toString('base64url');
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export class Apps {
  /** empreinte → nom : ce qui est accepté en ce moment */
  private keys = new Map<string, string>();
  /** compteurs depuis le dernier enregistrement (entretien chaque minute) */
  private hits = new Map<string, { requests: number; points: number; seen: number }>();
  private readonly env: AppKey[];
  private readonly store: Store;

  constructor(env: AppKey[], store: Store) {
    this.env = env;
    this.store = store;
    this.reload();
  }

  private reload() {
    this.keys.clear();
    for (const k of this.env) this.keys.set(sha256(k.key), k.name);
    for (const a of this.store.allApps()) if (!a.revoked) this.keys.set(a.hash, a.name);
  }

  /** aucune clé nulle part : serveur ouvert (développement) */
  get open() { return this.keys.size === 0 && !this.store.allApps().length; }

  /** nom du logiciel si la clé est bonne */
  check(key: unknown): string | null {
    return typeof key === 'string' && key ? this.keys.get(sha256(key)) ?? null : null;
  }

  count(name: string, nowS: number, points = 0) {
    if (!name) return;
    const h = this.hits.get(name) ?? { requests: 0, points: 0, seen: 0 };
    h.requests++; h.points += points; h.seen = nowS;
    this.hits.set(name, h);
  }
  flush() {
    for (const [name, h] of this.hits) this.store.appCount(name, h.requests, h.points, h.seen);
    this.hits.clear();
  }

  list() {
    this.flush();
    const db = this.store.allApps().map(({ hash: _h, ...a }) => ({ ...a, source: 'admin' as const }));
    return { open: this.open, apps: [...this.env.map(k => ({ name: k.name, source: 'env' as const })), ...db] };
  }

  add(raw: Record<string, unknown>, nowS: number) {
    const name = clean(raw.name, 40);
    if (!/^[\p{L}\p{N} ._-]{2,40}$/u.test(name)) throw new AppError('bad-name', 'nom : 2 à 40 lettres, chiffres, espaces, . _ -');
    if (this.env.some(k => k.name === name) || this.store.allApps().some(a => a.name === name)) throw new AppError('name-taken', 'ce nom existe déjà');
    const key = newKey(), id = this.store.addApp(name, clean(raw.contact, 120), clean(raw.note, 200), sha256(key), nowS);
    this.reload();
    return { id, name, key };
  }

  private row(id: number): AppRow {
    const a = this.store.allApps().find(x => x.id === id);
    if (!a) throw new AppError('unknown-app', 'logiciel inconnu');
    return a;
  }
  /** une nouvelle clé : l'ancienne cesse de marcher tout de suite */
  rotate(id: number, nowS: number) {
    const a = this.row(id), key = newKey();
    this.store.setAppKey(id, sha256(key), nowS);
    this.reload();
    return { id, name: a.name, key };
  }
  setRevoked(id: number, revoked: boolean) {
    const a = this.row(id);
    this.store.setAppRevoked(id, revoked);
    this.reload();
    return a.name;
  }
  update(id: number, raw: Record<string, unknown>) {
    this.row(id);
    this.store.setAppInfo(id, clean(raw.contact, 120), clean(raw.note, 200));
  }
  remove(id: number) {
    const a = this.row(id);
    this.store.deleteApp(id);
    this.reload();
    return a.name;
  }
}

export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
