// Les notifications d'un lien de suivi, page fermée : décollage, posé, posé OK, POSÉ PAS OK, alerte levée.
// Le message dit le pilote (k : début de l'empreinte de son lien), son nom, l'heure, et l'endroit d'une alerte ; la page
// a gardé l'adresse de son lien sous /k/<k> (le serveur ne l'a pas). Une seule notification par pilote : la suivante
// remplace la précédente.

const LINKS = 'opn-links';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* message illisible : notification générique */ }
  e.waitUntil(show(d));
});

async function linkOf(k) {
  try {
    const r = await (await caches.open(LINKS)).match('/k/' + k);
    return r ? await r.text() : null;
  } catch { return null; }
}

async function show(d) {
  const fr = /^fr/i.test(self.navigator.language || '');
  const hm = t => new Date((t || Date.now() / 1000) * 1000).toLocaleTimeString(fr ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const name = d.name || (fr ? 'Le pilote' : 'The pilot');
  const at = typeof d.lat === 'number' && typeof d.lon === 'number' ? ` · ${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` : '';
  const T = fr
    ? { takeoff: [`${name} a décollé`, `à ${hm(d.t)}`], landed: [`${name} a atterri`, `à ${hm(d.t)}`], ok: [`${name} : posé OK`, `à ${hm(d.t)}`], sos: [`🆘 ${name} : POSÉ PAS OK`, `Besoin d’aide depuis ${hm(d.t)}${at}. Ouvre le suivi pour voir où.`], sosOff: [`${name} : alerte levée`, `à ${hm(d.t)}`], other: [name, 'Suivi en direct'] }
    : { takeoff: [`${name} took off`, `at ${hm(d.t)}`], landed: [`${name} landed`, `at ${hm(d.t)}`], ok: [`${name}: landed OK`, `at ${hm(d.t)}`], sos: [`🆘 ${name}: LANDED, NEEDS HELP`, `Needs help since ${hm(d.t)}${at}. Open the tracking page to see where.`], sosOff: [`${name}: alert cancelled`, `at ${hm(d.t)}`], other: [name, 'Live tracking'] };
  const [title, body] = T[d.kind] || T.other;  const sos = d.kind === 'sos';
  return self.registration.showNotification(title, {
    body, tag: 'opn-' + (d.k || 'x'), renotify: true, requireInteraction: sos,
    vibrate: sos ? [600, 200, 600, 200, 600, 200, 600] : [200, 100, 200],
    data: { url: (d.k && await linkOf(d.k)) || null },
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = url && wins.find(w => new URL(w.url).pathname === url);
    if (open) return open.focus();
    return self.clients.openWindow(url || '/');
  })());
});
