// La page d'un lien de suivi : la position et la trace d'un pilote, pour ses proches. Le jeton est dans l'adresse.
// Toutes les 5 s les points nouveaux ; chaque minute la trace entière, qui comble ce que le pilote a envoyé en retard
// après une coupure du réseau.

const fr = /^fr/i.test(navigator.language);
const T = fr
  ? { title: 'Suivi en direct', alt: 'Altitude', spd: 'Vitesse', vz: 'Vario', maps: 'Ouvrir dans une carte', now: 'en direct', ago: 'dernière position il y a {t}', none: 'Aucune position dans les dernières 24 h', gone: 'Ce lien de suivi n’est plus valable', goneHint: 'Le pilote l’a remplacé : demande-lui le nouveau.', down: 'Réseau coupé, nouvel essai…' }
  : { title: 'Live tracking', alt: 'Altitude', spd: 'Speed', vz: 'Vario', maps: 'Open in a map', now: 'live', ago: 'last position {t} ago', none: 'No position in the last 24 h', gone: 'This tracking link is no longer valid', goneHint: 'The pilot replaced it: ask them for the new one.', down: 'Network down, trying again…' };
const $ = id => document.getElementById(id);
const api = '/api/v1/shared/' + encodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const FRESH_S = 60;

$('lAlt').textContent = T.alt; $('lSpd').textContent = T.spd; $('lVz').textContent = T.vz; $('maps').textContent = T.maps;

const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty', center: [6.1, 45.9], zoom: 5, attributionControl: { compact: true } });
const dot = document.createElement('div');
dot.className = 'pilot';
const marker = new maplibregl.Marker({ element: dot });
let pts = [], placed = false, loaded = false, serverLag = 0, fullAt = 0;

const span = s => (s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h');
const fig = (v, d, u) => (v === null || v === undefined ? '—' : `${v.toFixed(d)} ${u}`);

function draw() {
  const last = pts[pts.length - 1];
  if (!last) { $('state').textContent = T.none; $('figures').hidden = true; $('maps').hidden = true; return; }
  const age = Date.now() / 1000 - serverLag - last[0];
  $('state').textContent = age < FRESH_S ? T.now : T.ago.replace('{t}', span(age));
  $('alt').textContent = fig(last[3], 0, 'm');
  $('spd').textContent = fig(last[4] === null ? null : last[4] * 3.6, 0, 'km/h');
  $('vz').textContent = fig(last[6], 1, 'm/s');
  $('figures').hidden = false;
  $('maps').href = `https://www.google.com/maps/search/?api=1&query=${last[1]},${last[2]}`;
  $('maps').hidden = false;
  if (!loaded) return;
  map.getSource('track').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map(f => [f[2], f[1]]) } });
  marker.setLngLat([last[2], last[1]]);
  if (!placed) {
    placed = true;
    marker.addTo(map);
    map.jumpTo({ center: [last[2], last[1]], zoom: 12 });
  }
}

async function tick() {
  const full = Date.now() - fullAt > 60000 || !pts.length;
  try {
    const r = await fetch(api + (full ? '' : '?since=' + pts[pts.length - 1][0]), { cache: 'no-store' });
    if (r.status === 404) {
      $('name').textContent = T.gone; $('wing').textContent = T.goneHint; $('state').textContent = '';
      $('figures').hidden = true; $('maps').hidden = true; marker.remove();
      return;
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    const who = [d.p.first, d.p.last].filter(Boolean).join(' ');
    $('name').textContent = who || T.title;
    document.title = who ? `${who} – ${T.title}` : T.title;
    $('wing').textContent = d.p.wing;
    serverLag = Date.now() / 1000 - d.now;
    pts = full ? d.pts : pts.concat(d.pts);
    if (full) fullAt = Date.now();
    draw();
  } catch { $('state').textContent = T.down; }
  setTimeout(tick, 5000);
}

map.on('load', () => {
  map.addSource('track', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } } });
  map.addLayer({ id: 'track', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0047ff', 'line-width': 3 } });
  loaded = true;
  draw();
});
void tick();
