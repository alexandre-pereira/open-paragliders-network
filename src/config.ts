// Réglages du serveur, tous par variables d'environnement (voir README.md, « Configuration »).

export interface AppKey { name: string; key: string }

export interface Config {
  port: number;
  host: string;
  /** dossier de la base SQLite (live.db) */
  dataDir: string;
  /** historique gardé (h) : un point plus vieux est effacé */
  retentionH: number;
  /** place maximale de la base (Mo) : au-delà, les plus vieux points sont réécrits */
  maxDbMb: number;
  /** place libre minimale sur le disque (Mo) : en dessous, idem, et la base rend de la place au disque */
  minFreeMb: number;
  /** fenêtre des points gardés en mémoire (min) : traces envoyées en direct, reprise après une coupure */
  liveWindowMin: number;
  /** période d'envoi la plus courte permise aux abonnés (s) */
  minEvery: number;
  /** période d'envoi par défaut (s) */
  defaultEvery: number;
  /** trace envoyée par défaut avec un pilote vu pour la première fois (s) */
  defaultTrailS: number;
  /** clés des logiciels fixées par l'environnement ; les autres se gèrent au back-office (apps.ts). Aucune = serveur ouvert (développement) */
  appKeys: AppKey[];
  /** mot de passe du back-office ; vide = back-office fermé */
  adminToken: string;
  /** où demander une clé de logiciel : public, dans GET /api/v1 */
  contact: string;
  /** compatibilité LiveTrack24 (XCSoar, LK8000…) */
  lt24: boolean;
  /** derrière un proxy (Caddy, nginx) : l'IP du client est prise dans X-Forwarded-For */
  trustProxy: boolean;
  /** un pilote sans aucun point depuis ce délai est oublié (profil et identifiant d'appareil) (jours) */
  pilotTtlDays: number;
  /** requêtes HTTP par IP et par minute */
  rateHttp: number;
  /** connexions WebSocket simultanées par IP */
  maxWsPerIp: number;
  /** points par envoi */
  maxBatch: number;
  /** appareils nouveaux par IP et par minute */
  rateNewDevice: number;
  /** messages WebSocket par connexion et par minute */
  maxWsPerMin: number;
}

const num = (env: NodeJS.ProcessEnv, k: string, d: number, min = -Infinity, max = Infinity) => {
  const v = env[k];
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} : nombre attendu, reçu « ${v} »`);
  return Math.min(max, Math.max(min, n));
};
const bool = (env: NodeJS.ProcessEnv, k: string, d: boolean) => {
  const v = env[k]?.trim().toLowerCase();
  return v === undefined || v === '' ? d : ['1', 'true', 'yes', 'oui', 'on'].includes(v);
};

/** APP_KEYS="wsnav:clé1,xcsoar:clé2" (ou une clé seule, nommée « app ») */
export function parseKeys(s: string | undefined): AppKey[] {
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean).map((x, i) => {
    const at = x.indexOf(':');
    return at > 0 ? { name: x.slice(0, at), key: x.slice(at + 1) } : { name: i ? `app${i + 1}` : 'app', key: x };
  }).filter(k => k.key.length >= 8);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env, 'PORT', 8080, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || './data',
    retentionH: num(env, 'RETENTION_HOURS', 72, 1, 24 * 30),
    maxDbMb: num(env, 'MAX_DB_MB', 2048, 16),
    minFreeMb: num(env, 'MIN_FREE_DISK_MB', 500, 0),
    liveWindowMin: num(env, 'LIVE_WINDOW_MIN', 60, 5, 24 * 60),
    minEvery: num(env, 'MIN_PUSH_EVERY', 1, 0.5, 60),
    defaultEvery: num(env, 'PUSH_EVERY', 3, 0.5, 300),
    defaultTrailS: num(env, 'DEFAULT_TRAIL_S', 600, 0, 24 * 3600),
    appKeys: parseKeys(env.APP_KEYS),
    adminToken: env.ADMIN_TOKEN || '',
    contact: env.CONTACT || '',
    lt24: bool(env, 'LT24', true),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    pilotTtlDays: num(env, 'PILOT_TTL_DAYS', 90, 1),
    rateHttp: num(env, 'RATE_HTTP_PER_MIN', 600, 10),
    maxWsPerIp: num(env, 'MAX_WS_PER_IP', 20, 1),
    maxBatch: num(env, 'MAX_BATCH', 5000, 10, 50000),
    rateNewDevice: num(env, 'RATE_NEW_DEVICE_PER_MIN', 20, 1),
    maxWsPerMin: num(env, 'MAX_WS_PER_MIN', 600, 10),
  };
}
