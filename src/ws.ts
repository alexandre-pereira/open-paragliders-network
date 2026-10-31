// Le direct en WebSocket (/api/v1/ws) : le chemin le plus réactif. Une seule connexion pour envoyer ses points et
// recevoir ceux des autres, sans poignée de main HTTP/TLS à chaque fois. Messages JSON, un objet par message, champ
// `op`. Protocole complet : docs/PROTOCOL.md.
//
// Une liaison mobile qui « tient » sans plus rien passer est détectée des deux côtés : le serveur envoie un ping
// WebSocket toutes les 20 s et coupe sans réponse ; le client envoie {op:"ping"} et se reconnecte sans {op:"pong"}.
// Un client lent n'accumule rien : tant que son tampon d'envoi est plein, ses mises à jour attendent, et il reçoit
// tout d'un coup ensuite (le curseur n'avance qu'à l'envoi).

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseArea } from './fix.ts';
import { clientIp, newSub, PROTOCOL, VERSION, type Api } from './http.ts';
import type { SubState } from './live.ts';
import { HttpError, type Service } from './service.ts';
import type { PilotRow } from './store.ts';

const PING_MS = 20000;
/** sans hello en ce délai (quand une clé est demandée) : coupé */
const HELLO_MS = 10000;
/** tampon d'envoi au-delà duquel un abonné lent attend (octets) */
const SLOW_BYTES = 256 * 1024;
const TICK_MS = 200;

interface Conn {
  ws: WebSocket;
  ip: string;
  ok: boolean;
  admin: boolean;
  app: string;
  pilot: PilotRow | null;
  sub: (SubState & { every: number; nextAt: number }) | null;
  alive: boolean;
}

export class LiveSocket {
  readonly wss: WebSocketServer;
  readonly conns = new Set<Conn>();
  private perIp = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];

  readonly svc: Service;
  readonly api: Api;

  constructor(svc: Service, api: Api, server: Server) {
    this.svc = svc;
    this.api = api;
    this.wss = new WebSocketServer({
      noServer: true, maxPayload: 4 * 1048576, clientTracking: false,
      // compression : les traces se répètent beaucoup (≈ ×4 sur un abonnement)
      perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 5 }, serverMaxWindowBits: 13, concurrencyLimit: 4 },
    });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.heartbeat(), PING_MS));
    api.wsCount = () => this.conns.size;
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://x');
    const ip = clientIp(req, this.svc.cfg.trustProxy);
    if (url.pathname !== '/api/v1/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    if ((this.perIp.get(ip) ?? 0) >= this.svc.cfg.maxWsPerIp) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
    this.wss.handleUpgrade(req, socket, head, ws => this.open(ws, ip, url.searchParams));
  }

  private open(ws: WebSocket, ip: string, q: URLSearchParams) {
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    const app = this.api.appOf(q.get('key'));
    const c: Conn = { ws, ip, ok: app !== null, admin: false, app: app ?? '', pilot: null, sub: null, alive: true };
    this.conns.add(c);
    const helloTimer = setTimeout(() => { if (!c.ok) ws.close(4001, 'app-key-required'); }, HELLO_MS);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, binary) => {
      c.alive = true;
      if (binary) return this.err(c, 'bad-message', 'texte JSON attendu');
      let m: Record<string, unknown>;
      try { m = JSON.parse(data.toString()); } catch { return this.err(c, 'bad-json'); }
      if (!m || typeof m !== 'object') return this.err(c, 'bad-json');
      try { this.onMessage(c, m); } catch (e) {
        if (e instanceof HttpError) return this.err(c, e.code, e.message, m.id);
        console.error('[ws]', e);
        this.err(c, 'server-error', undefined, m.id);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(c);
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n > 0) this.perIp.set(ip, n); else this.perIp.delete(ip);
    });
    ws.on('error', () => { /* la fermeture suit */ });
  }

  private onMessage(c: Conn, m: Record<string, unknown>) {
    const svc = this.svc;
    const op = m.op;
    if (op === 'hello') {
      if (!c.ok) {
        const app = this.api.appOf(m.key);
        if (app === null) { this.err(c, 'app-key-required'); c.ws.close(4001, 'app-key-required'); return; }
        c.ok = true; c.app = app;
      }
      if (m.admin !== undefined) {
        if (this.api.adminLocked(c.ip) || !this.api.isAdmin(m.admin, c.ip)) { this.err(c, 'admin-required'); c.ws.close(4003, 'admin-required'); return; }
        c.admin = true;
      }
      if (m.device !== undefined) {
        c.pilot = svc.authDevice(m);
        if (m.pilot !== undefined || m.app !== undefined) svc.updateProfile(c.pilot, m.pilot, m.app);
      }
      return this.send(c, {
        op: 'welcome', v: PROTOCOL, server: `open-paragliders-network ${VERSION}`, now: Math.floor(svc.now()), seq: svc.live.seq,
        minEvery: svc.cfg.minEvery, windowS: svc.live.windowS, retentionH: svc.cfg.retentionH, maxBatch: svc.cfg.maxBatch,
        ...(c.pilot ? { pilot: String(c.pilot.pid) } : {}), ...(c.admin ? { admin: true } : {}),
      });
    }
    if (!c.ok) throw new HttpError(401, 'app-key-required', 'hello avec la clé du logiciel d’abord');
    switch (op) {
      case 'ping': return this.send(c, { op: 'pong', t: m.t, now: Math.floor(svc.now() * 1000) / 1000, seq: svc.live.seq });
      case 'pts': case 'pilot': {
        if (!c.pilot) throw new HttpError(401, 'device-required', 'hello avec device et secret d’abord');
        // l'état du pilote a pu changer (bloqué, effacé) depuis le hello
        const p = svc.store.pilotById(c.pilot.pid);
        if (!p || p.blocked) { c.pilot = null; throw new HttpError(403, 'blocked'); }
        c.pilot = p;
        if (m.pilot !== undefined || m.app !== undefined) svc.updateProfile(p, m.pilot, m.app);
        if (op === 'pilot') return this.send(c, { op: 'ack', id: m.id, ok: true, pilot: String(p.pid), p: { first: p.first, last: p.last, wing: p.wing, type: p.type, app: p.app } });
        return this.send(c, { op: 'ack', ...(m.id !== undefined ? { id: m.id } : {}), ...svc.ingestFor(p, m.pts ?? m.points) });
      }
      case 'sub': return this.subscribe(c, m);
      case 'unsub': c.sub = null; return this.send(c, { op: 'ack', id: m.id, ok: true });
      default: throw new HttpError(400, 'unknown-op', `op inconnu : ${String(op)}`);
    }
  }

  /** abonnement, ou changement de zone / de période sur la même connexion (le curseur et les pilotes suivis restent) */
  private subscribe(c: Conn, m: Record<string, unknown>) {
    const svc = this.svc;
    const area = parseArea(m.bbox, m.center, m.radius);
    if (area === 'invalid') throw new HttpError(400, 'bad-area', 'bbox [ouest, sud, est, nord] ou center [lat, lon] + radius (km)');
    const base = newSub(svc, area, m.trail, m.maxAge, c.admin);
    const every = Math.max(svc.cfg.minEvery, Math.min(300, Number(m.every) || svc.cfg.defaultEvery));
    const nowS = Math.floor(svc.now());
    const since = typeof m.since === 'number' ? m.since : null;
    let opts: { snapshot: boolean; infer?: boolean } = { snapshot: true }, reset = false;
    if (since !== null && svc.live.resumable(since)) { base.cursor = since; opts = { snapshot: true, infer: true }; }
    else if (c.sub && since === null) { base.cursor = c.sub.cursor; base.known = c.sub.known; }
    else if (since !== null) reset = true;
    c.sub = { ...base, every, nextAt: Date.now() + every * 1000 };
    const u = svc.live.collect(c.sub, nowS, opts);
    this.send(c, { op: 'upd', ...(m.id !== undefined ? { id: m.id } : {}), ...u, ...(reset ? { reset: true } : {}) });
  }

  private tick() {
    const nowMs = Date.now(), nowS = Math.floor(this.svc.now());
    for (const c of this.conns) {
      const s = c.sub;
      if (!s || nowMs < s.nextAt) continue;
      // un abonné qui n'arrive pas à suivre attend : il recevra tout d'un coup ensuite
      if (c.ws.bufferedAmount > SLOW_BYTES) { s.nextAt = nowMs + 1000; continue; }
      s.nextAt = Math.max(s.nextAt + s.every * 1000, nowMs + s.every * 500);
      const u = this.svc.live.collect(s, nowS);
      if (u.pilots.length) this.send(c, { op: 'upd', ...u });
    }
  }

  private heartbeat() {
    for (const c of this.conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* fermée */ }
    }
  }

  private send(c: Conn, msg: unknown) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }
  private err(c: Conn, code: string, message?: string, id?: unknown) {
    this.send(c, { op: 'err', code, ...(message ? { message } : {}), ...(id !== undefined ? { id } : {}) });
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    for (const c of this.conns) c.ws.close(1012, 'restart');
    this.wss.close();
  }
}
