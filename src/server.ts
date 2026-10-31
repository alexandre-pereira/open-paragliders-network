// Démarrage : base, mémoire du direct, HTTP + WebSocket, entretien chaque minute, arrêt propre.

import { chmodSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { Api } from './http.ts';
import { Service } from './service.ts';
import { Store } from './store.ts';
import { LiveSocket } from './ws.ts';

export interface Running { svc: Service; api: Api; socket: LiveSocket; port: number; close: () => Promise<void> }

export async function start(cfg: Config = loadConfig(), file?: string): Promise<Running> {
  mkdirSync(cfg.dataDir, { recursive: true });
  // positions, noms, journal : à personne d'autre sur la machine (sans effet sous Windows)
  try { chmodSync(cfg.dataDir, 0o700); } catch { /* dossier monté */ }
  const store = new Store(file ?? join(cfg.dataDir, 'live.db'));
  const svc = new Service(cfg, store);
  svc.maintain();
  const api = new Api(svc);
  const server = createServer({ keepAliveTimeout: 65000, requestTimeout: 30000, headersTimeout: 15000 }, (req, res) => { void api.handle(req, res); });
  const socket = new LiveSocket(svc, api, server);
  const maint = setInterval(() => {
    try { svc.maintain(); } catch (e) { console.error('[entretien]', e); }
  }, 60000);
  await new Promise<void>((ok, ko) => { server.once('error', ko); server.listen(cfg.port, cfg.host, ok); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(maint);
    socket.close();
    await new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections(); });
    store.checkpoint();
    store.close();
  };
  return { svc, api, socket, port, close };
}

if (import.meta.main) {
  const cfg = loadConfig();
  const run = await start(cfg);
  const s = run.svc.live.stats();
  console.log(`open-paragliders-network sur http://${cfg.host}:${run.port} — ${s.pilots} pilotes, ${s.points} points en mémoire, historique ${cfg.retentionH} h, base ≤ ${cfg.maxDbMb} Mo`);
  if (run.svc.apps.open) console.warn('Aucune clé de logiciel : serveur ouvert à tous (développement). Crée une clé au back-office pour le fermer.');
  if (!cfg.adminToken) console.warn('ADMIN_TOKEN vide : back-office fermé');
  else if (cfg.adminToken.length < 16) console.warn('ADMIN_TOKEN court : 16 caractères au moins (openssl rand -base64 32)');
  for (const k of cfg.appKeys) if (k.key.length < 16) console.warn(`clé ${k.name} courte : 16 caractères au moins (openssl rand -hex 24)`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void run.close().then(() => process.exit(0)); });
}
