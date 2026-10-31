// Pilotes simulés autour d'Annecy, pour essayer le serveur et la carte du back-office.
//   node tools/simulate.ts [adresse] [pilotes] [clé]
//   node tools/simulate.ts http://localhost:8080 12
// Chaque pilote fait ce qu'un vrai client doit faire (docs/PROTOCOL.md, « Envoyer ») : un point toutes les 3 s dans
// une file, un envoi toutes les 6 s de toute la file, la file gardée tant que le serveur n'a pas répondu ; des
// coupures de réseau au hasard (20 à 90 s) montrent la trace rattrapée d'un coup.

const base = process.argv[2] ?? 'http://localhost:8080';
const n = Number(process.argv[3] ?? 8);
const key = process.argv[4] ?? process.env.APP_KEY ?? '';
const WINGS = ['Ozone Zeno 2', 'Advance Omega XALPS 3', 'Gin Leopard', 'Niviuk Artik R', 'Supair Savage', 'Wills Wing T3', 'Skywalk X-Alps 5', 'Ozone Enzo 3'];
const FIRST = ['Alex', 'Zoé', 'Lucas', 'Emma', 'Hugo', 'Léa', 'Paul', 'Chloé', 'Tom', 'Inès'];
const LAST = ['Martin', 'Bernard', 'Dubois', 'Durand', 'Moreau', 'Laurent', 'Simon', 'Michel', 'Garcia', 'Roux'];

interface Sim { device: string; secret: string; pilot: object; lat: number; lon: number; alt: number; hdg: number; queue: unknown[]; cutUntil: number; sending: boolean }
const sims: Sim[] = Array.from({ length: n }, (_, i) => ({
  device: `sim-${i.toString().padStart(3, '0')}-${Math.random().toString(36).slice(2, 8)}`,
  secret: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
  pilot: { first: FIRST[i % FIRST.length], last: LAST[(i * 3) % LAST.length], wing: WINGS[i % WINGS.length], type: i % 7 === 6 ? 'hangglider' : 'paraglider' },
  lat: 45.85 + Math.random() * 0.2, lon: 6.1 + Math.random() * 0.3, alt: 1200 + Math.random() * 1200, hdg: Math.random() * 360,
  queue: [], cutUntil: 0, sending: false,
}));

setInterval(() => {
  const t = Math.floor(Date.now() / 1000);
  for (const s of sims) {
    s.hdg += (Math.random() - 0.4) * 25;
    const spd = 9 + Math.random() * 3, vz = Math.sin(t / 60 + s.lat * 100) * 2;
    s.lat += (spd * 3 * Math.cos((s.hdg * Math.PI) / 180)) / 111320;
    s.lon += (spd * 3 * Math.sin((s.hdg * Math.PI) / 180)) / (111320 * Math.cos((s.lat * Math.PI) / 180));
    s.alt = Math.max(500, s.alt + vz * 3);
    s.queue.push([t, +s.lat.toFixed(6), +s.lon.toFixed(6), Math.round(s.alt), +spd.toFixed(1), Math.round(((s.hdg % 360) + 360) % 360), +vz.toFixed(1)]);
    if (Math.random() < 0.004) { s.cutUntil = Date.now() + 20000 + Math.random() * 70000; console.log(`${s.device} : coupure réseau`); }
  }
}, 3000);

setInterval(async () => {
  for (const s of sims) {
    if (s.sending || !s.queue.length || Date.now() < s.cutUntil) continue;
    s.sending = true;
    const batch = s.queue.slice(0, 1000);
    try {
      const r = await fetch(`${base}/api/v1/points`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-App-Key': key } : {}) },
        body: JSON.stringify({ device: s.device, secret: s.secret, app: 'simulateur', pilot: s.pilot, points: batch }), signal: AbortSignal.timeout(10000),
      });
      // réponse reçue : les points sont au serveur (ou refusés pour toujours) ; sans réponse ils restent pour le prochain envoi
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) s.queue.splice(0, batch.length);
      if (!r.ok) console.log(s.device, r.status, await r.text());
    } catch (e) { console.log(s.device, 'pas de réponse', (e as Error).message); } finally { s.sending = false; }
  }
}, 6000);
console.log(`${n} pilotes simulés vers ${base}`);
