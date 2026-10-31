// Le client d'exemple de la doc tourne pour de vrai contre le serveur : ce que le guide montre marche.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { start } from '../src/server.ts';

const KEY = 'cle-de-test-exemple';
const SCRIPT = fileURLToPath(new URL('../public/docs/example.mjs', import.meta.url));

test('public/docs/example.mjs : envoie, reçoit, ignore son écho, lien de suivi, état, oubli', async () => {
  const run = await start(loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: '/tmp/open-paragliders-network-test', APP_KEYS: `wsnav:${KEY}`, MIN_PUSH_EVERY: '0.5' }), ':memory:');
  const base = `http://127.0.0.1:${run.port}`;
  try {
    // un autre pilote autour
    await fetch(base + '/api/v1/points', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Key': KEY },
      body: JSON.stringify({ device: 'autre-pilote-1', secret: 'secret-de-test-0123456789', pilot: { first: 'Zoé', last: 'Martin' }, points: [[Math.floor(Date.now() / 1000) - 5, 45.9, 6.1, 1500, 10, 90, 1]] }),
    });
    const out = await new Promise<string>((ok, ko) => {
      execFile(process.execPath, [SCRIPT, base, KEY, '45.9', '6.1', '7'], { timeout: 20000 }, (e, stdout, stderr) => (e ? ko(new Error(stderr || e.message)) : ok(stdout)));
    });
    assert.match(out, /welcome: my pilot id is \d+/);
    assert.match(out, /tracking link: http:\/\/127\.0\.0\.1:\d+\/p\//);
    assert.match(out, /ack 1 stored/, 'les points partent par le WebSocket');
    assert.match(out, /1 pilot\(s\) around: Zoé Martin/, 'reçoit l’autre pilote, pas son propre écho');
    assert.match(out, /landed OK: 200/);
    assert.match(out, /forgotten: 200/);
    assert.ok(!/server says/.test(out), out);
  } finally { await run.close(); }
});
