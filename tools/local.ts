// Essai sur ce PC avec un téléphone, sur le même réseau ou non : le serveur, écoutant seulement sur ce PC, et un tunnel
// Cloudflare gratuit et sans compte (cloudflared) qui lui donne une adresse HTTPS publique, WebSocket compris.
//   npm run local
// La clé et le mot de passe du back-office sont tirés une fois et gardés dans data/local.json ; l'adresse du tunnel
// change à chaque lancement. Le serveur reste protégé par la clé, puisqu'il est joignable de tout internet.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { start } from '../src/server.ts';

const dataDir = process.env.DATA_DIR || './data';
const file = join(dataDir, 'local.json'), out = join(dataDir, 'local.txt');
mkdirSync(dataDir, { recursive: true });

const secrets: { key: string; admin: string } = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { key: randomBytes(9).toString('base64url'), admin: randomBytes(12).toString('base64url') };
writeFileSync(file, JSON.stringify(secrets, null, 2));

const run = await start(loadConfig({ ...process.env, HOST: '127.0.0.1', DATA_DIR: dataDir, APP_KEYS: `wsnav:${secrets.key}`, ADMIN_TOKEN: secrets.admin, TRUST_PROXY: '1' }));

// winget ajoute cloudflared au PATH des nouveaux terminaux seulement
const winget = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages', 'Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe', 'cloudflared.exe');
const exe = process.env.CLOUDFLARED || (existsSync(winget) ? winget : 'cloudflared');
const tunnel = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${run.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });

const stop = (code: number) => { tunnel.kill(); void run.close().then(() => process.exit(code)); };
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop(0));
tunnel.once('error', e => { console.error(`cloudflared introuvable (${e.message}) : winget install Cloudflare.cloudflared`); stop(1); });
tunnel.once('exit', c => { console.error(`tunnel arrêté (code ${c})`); stop(1); });

let shown = false;
const read = (chunk: Buffer) => {
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk))?.[0];
  if (!url || shown) return;
  shown = true;
  const text = [
    `Dans WS Nav, Menu › Trafic & live › Open Paragliders Network › Adresse du serveur :`,
    `  ${url}/?key=${secrets.key}`,
    ``,
    `Back-office : http://localhost:${run.port}/admin/ (ou ${url}/admin/)`,
    `Mot de passe : ${secrets.admin}`,
    ``,
    `Pilotes simulés autour d'un point :`,
    `  npm run sim -- http://localhost:${run.port} 12 ${secrets.key} 45.85 6.1`,
    ``,
  ].join('\n');
  writeFileSync(out, text);
  console.log('\n' + text);
};
tunnel.stdout.on('data', read);
tunnel.stderr.on('data', read);
