// L'API HTTP : envoi des points, lecture du direct (pour qui ne garde pas de WebSocket ouvert), traces, back-office,
// LiveTrack24 et les fichiers de la carte du back-office. Réponses JSON compressées (gzip) dès 1 Ko quand le client
// le veut : sur une liaison mobile faible chaque octet compte.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { parseArea, wire, type BBox } from './fix.ts';
import { handleLt24 } from './lt24.ts';
import type { SubState, Update } from './live.ts';
import { HttpError, profileOf, type Service } from './service.ts';
import { thin } from './store.ts';

export const VERSION = '0.1.0';
export const PROTOCOL = 1;
const PUBLIC = resolve(import.meta.dirname, '..', 'public');
const MAX_BODY = 4 * 1048576;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.mjs': 'text/plain; charset=utf-8',
};

/** comptage par IP sur une fenêtre fixe d'une minute */
export class RateLimiter {
  private win = 0;
  private n = new Map<string, number>();
  readonly perMin: number;
  constructor(perMin: number) { this.perMin = perMin; }
  hit(ip: string, cost = 1, nowMs = Date.now()): boolean {
    const w = Math.floor(nowMs / 60000);
    if (w !== this.win) { this.win = w; this.n.clear(); }
    const v = (this.n.get(ip) ?? 0) + cost;
    this.n.set(ip, v);
    return v <= this.perMin;
  }
}

export const clientIp = (req: IncomingMessage, trustProxy: boolean) =>
  (trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Api {
  private rate: RateLimiter;
  /** essais de mot de passe du back-office ratés, par IP */
  private adminFails: RateLimiter = new RateLimiter(10);
  /** abonnés WebSocket (pour les statistiques) */
  wsCount: () => number = () => 0;

  readonly svc: Service;
  constructor(svc: Service) { this.svc = svc; this.rate = new RateLimiter(svc.cfg.rateHttp); }

  /** nom du logiciel si la clé est bonne ; '' quand le serveur est ouvert (aucune clé réglée) ; null : refusée */
  appOf(key: unknown): string | null {
    const keys = this.svc.cfg.appKeys;
    if (!keys.length) return '';
    if (typeof key !== 'string' || !key) return null;
    return keys.find(k => eq(k.key, key))?.name ?? null;
  }
  isAdmin(token: unknown, ip: string): boolean {
    const t = this.svc.cfg.adminToken;
    if (!t || typeof token !== 'string' || !token) return false;
    if (eq(t, token)) return true;
    this.adminFails.hit(ip);
    return false;
  }
  adminLocked(ip: string) { return !this.adminFails.hit(ip, 0); }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req, this.svc.cfg.trustProxy);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') return this.send(req, res, 204, '');
      if (path === '/healthz') return this.json(req, res, 200, { ok: true });
      if (!this.rate.hit(ip)) throw new HttpError(429, 'rate-limited', 'trop de requêtes, réessayer dans une minute');
      if (path.startsWith('/api/')) return await this.api(req, res, path, url.searchParams, ip);
      if (this.svc.cfg.lt24 && /^(\/lt24)?\/(client|track)\.php$/.test(path)) {
        return this.send(req, res, 200, handleLt24(this.svc, path, url.searchParams), { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (path === '/') return this.send(req, res, 302, '', { Location: '/docs/' });
      if (path === '/docs' && !url.pathname.endsWith('/')) return this.send(req, res, 302, '', { Location: '/docs/' });
      if (path === '/admin' && !url.pathname.endsWith('/')) return this.send(req, res, 302, '', { Location: '/admin/' });
      // la page d'un lien de suivi ; le jeton, lu dans l'adresse par la page, ne part jamais ailleurs (no-referrer)
      if (/^\/p\/[^/]+$/.test(path)) return this.static(req, res, '/track/index.html');
      return this.static(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return this.json(req, res, e.status, { ok: false, error: e.code, message: e.message });
      console.error('[http]', req.method, path, e);
      return this.json(req, res, 500, { ok: false, error: 'server-error' });
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, ip: string) {
    const svc = this.svc;
    const m = req.method ?? 'GET';
    // le back-office
    if (path.startsWith('/api/v1/admin/')) {
      if (this.adminLocked(ip)) throw new HttpError(429, 'too-many-failures', 'trop d’essais, réessayer dans une minute');
      const auth = req.headers.authorization ?? '';
      if (!this.isAdmin(auth.startsWith('Bearer ') ? auth.slice(7) : '', ip)) throw new HttpError(401, 'admin-required');
      return this.json(req, res, 200, await this.admin(req, m, path.slice('/api/v1/admin/'.length), q));
    }
    if (path === '/api/v1' && m === 'GET') return this.json(req, res, 200, this.info());
    // un lien de suivi : le jeton suffit, ses lecteurs (les proches du pilote) n'ont pas de clé de logiciel
    const sm = /^\/api\/v1\/shared\/([^/]+)$/.exec(path);
    if (m === 'GET' && sm) return this.json(req, res, 200, svc.shared(sm[1], q.get('since')));
    // X-WSNav-Key : l'en-tête des autres serveurs WeSoar (src/core/services.ts de WS Nav, keyedRequest)
    const app = this.appOf(req.headers['x-app-key'] ?? req.headers['x-wsnav-key'] ?? q.get('key'));
    if (app === null) throw new HttpError(401, 'app-key-required', 'clé de logiciel absente ou inconnue (en-tête X-App-Key)');

    if (m === 'POST' && path === '/api/v1/points') {
      const body = await readJson(req);
      return this.json(req, res, 200, svc.ingest(body));
    }
    if (m === 'POST' && path === '/api/v1/pilot') {
      const body = await readJson(req);
      const p = svc.authDevice(body, { create: true });
      return this.json(req, res, 200, { ok: true, pilot: String(p.pid), p: svc.updateProfile(p, body.pilot, body.app) });
    }
    if (m === 'POST' && path === '/api/v1/share') {
      return this.json(req, res, 200, svc.share(await readJson(req)));
    }
    if (m === 'POST' && path === '/api/v1/forget') {
      svc.forget(await readJson(req));
      return this.json(req, res, 200, { ok: true });
    }
    if (m === 'GET' && (path === '/api/v1/live' || path === '/api/v1/live.geojson')) {
      const u = this.liveQuery(q);
      return this.json(req, res, 200, path.endsWith('.geojson') ? toGeoJson(svc, u) : u);
    }
    const pm = /^\/api\/v1\/pilots\/(\d+)(\/track)?$/.exec(path);
    if (m === 'GET' && pm) {
      const pid = Number(pm[1]), p = svc.live.pilots.get(pid);
      if (!p || p.blocked) throw new HttpError(404, 'unknown-pilot');
      const last = svc.live.last(pid) ?? svc.store.lastFix(pid);
      if (!pm[2]) return this.json(req, res, 200, { id: pm[1], p: p.profile, last: last ? wire(last) : null });
      const { from, to, step } = window(q, svc.now(), svc.cfg.retentionH);
      return this.json(req, res, 200, { id: pm[1], p: p.profile, pts: svc.store.track(pid, from, to, 100000, step).map(wire) });
    }
    throw new HttpError(404, 'not-found');
  }

  info() {
    const c = this.svc.cfg;
    return {
      name: 'open-paragliders-network', version: VERSION, protocol: PROTOCOL, contact: c.contact, now: Math.floor(this.svc.now()),
      retentionH: c.retentionH, liveWindowS: c.liveWindowMin * 60, minEvery: c.minEvery, defaultEvery: c.defaultEvery,
      defaultTrailS: c.defaultTrailS, maxBatch: c.maxBatch, appKeyRequired: c.appKeys.length > 0, lt24: c.lt24,
    };
  }

  /** GET /api/v1/live : sans `since`, une image ; avec, ce qui est arrivé depuis */
  liveQuery(q: URLSearchParams, admin = false): Update {
    const svc = this.svc;
    const area = parseArea(q.get('bbox') ?? undefined, q.get('center') ?? undefined, q.get('radius') ?? undefined);
    if (area === 'invalid') throw new HttpError(400, 'bad-area', 'bbox=ouest,sud,est,nord ou center=lat,lon&radius=km');
    const sub = newSub(svc, area, q.get('trail'), q.get('maxAge'), admin);
    const since = q.get('since');
    const nowS = Math.floor(svc.now());
    if (since !== null && since !== '' && svc.live.resumable(Number(since))) {
      sub.cursor = Number(since);
      return svc.live.collect(sub, nowS, { snapshot: true, infer: true });
    }
    const u = svc.live.collect(sub, nowS, { snapshot: true });
    return since !== null && since !== '' ? { ...u, reset: true } : u;
  }

  private async admin(req: IncomingMessage, m: string, path: string, q: URLSearchParams) {
    const svc = this.svc;
    if (m === 'GET' && path === 'stats') {
      const c = svc.store.count();
      return {
        ...this.info(), points: c.n, oldest: c.t0, dbBytes: svc.store.fileBytes(), usedBytes: svc.store.usedBytes(),
        maxDbBytes: svc.cfg.maxDbMb * 1048576, freeDisk: Number.isFinite(svc.freeDisk()) ? svc.freeDisk() : null,
        memory: svc.live.stats(), clients: this.wsCount(), maintenance: svc.lastMaintenance, uptime: Math.round(process.uptime()),
      };
    }
    if (m === 'GET' && path === 'tracks') {
      // toutes les traces d'une période, allégées pour la carte ; seq : pour suivre la suite en direct (since)
      const { from, to, step } = window(q, svc.now(), svc.cfg.retentionH);
      const seq = svc.live.seq;
      const tracks = svc.store.tracks(from, to, step || Math.max(1, Math.round((to - from) / 2000)));
      const pilots = [];
      for (const [pid, fixes] of tracks) {
        const p = svc.live.pilots.get(pid);
        if (p) pilots.push({ id: String(pid), p: p.profile, ...(p.blocked ? { blocked: true } : {}), pts: fixes.map(wire) });
      }
      return { seq, now: Math.floor(svc.now()), from, to, pilots };
    }
    if (m === 'GET' && path === 'pilots') {
      const { from, to } = window(q, svc.now(), svc.cfg.retentionH);
      const stats = new Map(svc.store.stats(from, to).map(s => [s.pid, s]));
      return {
        pilots: svc.store.allPilots().map(p => {
          const s = stats.get(p.pid), last = svc.live.last(p.pid) ?? (s ? svc.store.lastFix(p.pid) : undefined);
          return { id: String(p.pid), device: p.device, p: profileOf(p), blocked: p.blocked, created: p.created, seen: p.seen, n: s?.n ?? 0, t0: s?.t0 ?? null, t1: s?.t1 ?? null, last: last ? wire(last) : null };
        }),
      };
    }
    const tm = /^track\/(\d+)$/.exec(path);
    if (m === 'GET' && tm) {
      const { from, to, step } = window(q, svc.now(), svc.cfg.retentionH);
      const p = svc.live.pilots.get(Number(tm[1]));
      if (!p) throw new HttpError(404, 'unknown-pilot');
      return { id: tm[1], p: p.profile, pts: thin(svc.store.track(p.pid, from, to, 500000), step).map(wire) };
    }
    const pm = /^pilots\/(\d+)\/(block|delete|profile)$/.exec(path);
    if (m === 'POST' && pm) {
      const pid = Number(pm[1]), body = await readJson(req);
      if (pm[2] === 'block') svc.block(pid, body.blocked !== false);
      else if (pm[2] === 'delete') svc.remove(pid);
      else {
        const p = svc.store.pilotById(pid);
        if (!p) throw new HttpError(404, 'unknown-pilot');
        svc.updateProfile(p, body.pilot);
      }
      return { ok: true };
    }
    throw new HttpError(404, 'not-found');
  }

  private static(req: IncomingMessage, res: ServerResponse, pathname: string) {
    let rel: string;
    try { rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ''); } catch { throw new HttpError(400, 'bad-path'); }
    let file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) throw new HttpError(404, 'not-found');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'not-found');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow',
    });
    createReadStream(file).pipe(res);
  }

  json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
    return this.send(req, res, status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' });
  }

  send(req: IncomingMessage, res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
    const h: Record<string, string> = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, X-App-Key, X-WSNav-Key, Authorization', 'Access-Control-Max-Age': '86400',
      ...headers,
    };
    let data: Buffer = Buffer.from(body);
    if (data.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      data = gzipSync(data, { level: 5 });
      h['Content-Encoding'] = 'gzip';
      h.Vary = 'Accept-Encoding';
    }
    h['Content-Length'] = String(data.length);
    res.writeHead(status, h);
    res.end(data);
  }
}

/** un abonnement sans état (requête HTTP) */
export function newSub(svc: Service, bbox: BBox | null, trail: unknown, maxAge: unknown, admin: boolean): SubState {
  const w = svc.live.windowS;
  const n = (v: unknown, d: number) => { const x = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(x) ? Math.min(w, Math.max(0, x)) : d; };
  return { bbox, trailS: n(trail, Math.min(w, svc.cfg.defaultTrailS)), maxAgeS: n(maxAge, w), cursor: svc.live.seq, known: new Map(), admin };
}

/** période demandée : from / to (s) dans l'historique, step : un point par step s */
function window(q: URLSearchParams, nowS: number, retentionH: number) {
  const n = (k: string) => { const v = q.get(k); return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null; };
  const to = Math.min(Math.floor(nowS) + 120, n('to') ?? Math.floor(nowS) + 120);
  const from = Math.max(Math.floor(nowS) - retentionH * 3600, n('from') ?? 0);
  return { from, to, step: Math.max(0, Math.min(3600, n('step') ?? 0)) };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body-too-large');
    chunks.push(c as Buffer);
  }
  let buf = Buffer.concat(chunks);
  if (/gzip/i.test(String(req.headers['content-encoding'] ?? ''))) {
    try { buf = gunzipSync(buf, { maxOutputLength: MAX_BODY * 4 }); } catch { throw new HttpError(400, 'bad-gzip'); }
  }
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw new HttpError(400, 'bad-json', 'objet JSON attendu'); }
}

/** le direct en GeoJSON : la trace (LineString) et la dernière position (Point) de chaque pilote */
export function toGeoJson(svc: Service, u: Update) {
  const features: unknown[] = [];
  for (const x of u.pilots) {
    const p = svc.live.pilots.get(Number(x.id));
    if (!p || !x.pts?.length) continue;
    const pts = x.trail ? x.pts : svc.live.trail(p, u.now, svc.live.windowS).map(wire);
    const last = pts[pts.length - 1];
    const props = { id: x.id, ...p.profile, name: [p.profile.first, p.profile.last].filter(Boolean).join(' ') };
    if (pts.length > 1) features.push({ type: 'Feature', properties: { ...props, kind: 'track' }, geometry: { type: 'LineString', coordinates: pts.map(f => [f[2], f[1], f[3] ?? 0]) } });
    features.push({
      type: 'Feature', properties: { ...props, kind: 'position', t: last[0], alt: last[3], spd: last[4], crs: last[5], vz: last[6] },
      geometry: { type: 'Point', coordinates: [last[2], last[1], last[3] ?? 0] },
    });
  }
  return { type: 'FeatureCollection', seq: u.seq, now: u.now, features };
}
