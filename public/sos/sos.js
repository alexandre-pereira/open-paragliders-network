// La page publique des alertes : les pilotes qui ont dit « posé pas OK », et rien d'autre. Toutes les 15 s.
// Les noms viennent des pilotes : toujours en texte, jamais en HTML.

const fr = /^fr/i.test(navigator.language);
const T = fr
  ? { title: 'Pilotes en difficulté', warn: 'Cette page ne prévient pas les secours : en cas de danger, appelle le 112.', none: 'Aucun pilote en difficulté en ce moment.', since: 'posé pas OK il y a {t}', alt: 'altitude {a} m', maps: 'Ouvrir dans une carte', pilot: 'Pilote', down: 'Réseau coupé, nouvel essai…' }
  : { title: 'Pilots in trouble', warn: 'This page does not alert the rescue services: in an emergency, call 112.', none: 'No pilot in trouble right now.', since: 'landed, needs help, {t} ago', alt: 'altitude {a} m', maps: 'Open in a map', pilot: 'Pilot', down: 'Network down, trying again…' };
const $ = id => document.getElementById(id);
$('title').textContent = T.title; $('warn').textContent = T.warn; document.title = T.title;

const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty', center: [6.1, 45.9], zoom: 5, attributionControl: { compact: true } });
let markers = [], loaded = false, framed = false;
const span = s => (s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h');
const has = p => p.lat !== null && p.lon !== null;

function draw(d) {
  const list = d.pilots;
  $('empty').hidden = list.length > 0;
  $('empty').textContent = T.none;
  $('list').replaceChildren(...list.map(p => {
    const li = document.createElement('li'), name = document.createElement('b'), sub = document.createElement('small');
    name.textContent = [p.p.first, p.p.last].filter(Boolean).join(' ') || T.pilot;
    sub.textContent = [p.p.wing, T.since.replace('{t}', span(d.now - p.t)), p.alt !== null ? T.alt.replace('{a}', Math.round(p.alt)) : ''].filter(Boolean).join(' · ');
    li.append(name, sub);
    if (has(p)) {
      const a = document.createElement('a');
      a.textContent = T.maps; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.href = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
      li.append(a);
      li.addEventListener('click', e => { if (e.target !== a) map.flyTo({ center: [p.lon, p.lat], zoom: 13 }); });
    }
    return li;
  }));
  if (!loaded) return;
  for (const m of markers) m.remove();
  markers = list.filter(has).map(p => {
    const dot = document.createElement('div');
    dot.className = 'sos-dot';
    return new maplibregl.Marker({ element: dot }).setLngLat([p.lon, p.lat]).addTo(map);
  });
  map.getSource('tracks').setData({ type: 'FeatureCollection', features: list.filter(p => p.pts.length > 1).map(p => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: p.pts.map(f => [f[2], f[1]]) } })) });
  const spots = list.filter(has);
  if (spots.length && !framed) {
    framed = true;
    const b = new maplibregl.LngLatBounds();
    for (const p of spots) b.extend([p.lon, p.lat]);
    map.fitBounds(b, { padding: 80, maxZoom: 12, duration: 0 });
  }
}

let last = { now: 0, pilots: [] };
async function tick() {
  try {
    const r = await fetch('/api/v1/sos', { cache: 'no-store' });
    last = await r.json();
    draw(last);
  } catch { $('empty').hidden = false; $('empty').textContent = T.down; }
  setTimeout(tick, 15000);
}
map.on('load', () => {
  map.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'tracks', type: 'line', source: 'tracks', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#c8102e', 'line-width': 3 } });
  loaded = true;
  draw(last);
});
void tick();
