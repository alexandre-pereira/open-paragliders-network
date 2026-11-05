// La page d'un lien de suivi : la position et la trace d'un pilote, pour ses proches. Le jeton est dans l'adresse.
// Toute la trace que le serveur garde, découpée en vols (le dernier choisi, les autres en léger), avec la distance de
// chacun ; relief en 3D avec le pilote à son altitude. Toutes les 5 s les points nouveaux ; toutes les 5 min la trace
// entière, qui comble ce que le pilote a envoyé en retard après une coupure du réseau.

import { splitFlights } from '/lib/flights.js';
import { scoreFlight } from '/lib/xc.js';

const fr = /^fr/i.test(navigator.language);
const T = fr
  ? { title: 'Suivi en direct', alt: 'Altitude', spd: 'Vitesse', vz: 'Vario', km: 'Distance', maps: 'Ouvrir dans une carte', now: 'en direct', ago: 'dernière position il y a {t}', none: 'Aucune position gardée par le serveur', gone: 'Ce lien de suivi n’est plus valable', goneHint: 'Le pilote l’a remplacé : demande-lui le nouveau.', down: 'Réseau coupé, nouvel essai…', ok: 'Posé OK à {h}', sos: 'POSÉ PAS OK à {h} : besoin d’aide', flights: 'Vols', flight: 'vol de {d}', fai: 'FAI {k} s’il boucle', ground: 'au sol' }
  : { title: 'Live tracking', alt: 'Altitude', spd: 'Speed', vz: 'Vario', km: 'Distance', maps: 'Open in a map', now: 'live', ago: 'last position {t} ago', none: 'No position kept by the server', gone: 'This tracking link is no longer valid', goneHint: 'The pilot replaced it: ask them for the new one.', down: 'Network down, trying again…', ok: 'Landed OK at {h}', sos: 'LANDED, NEEDS HELP at {h}', flights: 'Flights', flight: '{d} flight', fai: 'FAI {k} if closed', ground: 'on the ground' };
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) if (k != null) e.append(k); return e; };
const api = '/api/v1/shared/' + encodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const FRESH_S = 60, FULL_EVERY = 300000;
const SEL = '#0047ff', OTHER = '#7b8db8';

$('lAlt').textContent = T.alt; $('lSpd').textContent = T.spd; $('lVz').textContent = T.vz; $('lKm').textContent = T.km; $('maps').textContent = T.maps;
$('lFlights').textContent = T.flights;

const map = new maplibregl.Map({ container: 'map', style: baseStyle(), center: [6.1, 45.9], zoom: 5, maxPitch: MAX_PITCH, pixelRatio: PIXEL_RATIO, attributionControl: { compact: true } });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
const view3d = new View3d(), air3d = new Air3d();
view3d.onChange = on => { air3d.setOn(!!on); draw(); };
map.addControl(view3d, 'top-right');
const dot = el('div', { className: 'pilot' });
const marker = new maplibregl.Marker({ element: dot });
// l'état du pilote, là où il l'a dit sur sa trace
const flagDot = el('div', { className: 'pilot' });
const flagMark = new maplibregl.Marker({ element: flagDot });
let pts = [], flights = [], sel = -1, followLast = true, placed = false, loaded = false, serverLag = 0, fullAt = 0, who = null;
const scores = new Map();

const span = s => (s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
const fig = (v, d, u) => (v === null || v === undefined ? '—' : `${v.toLocaleString(fr ? 'fr-FR' : 'en-GB', { maximumFractionDigits: d, minimumFractionDigits: d })} ${u}`);
const day = t => new Date(t * 1000).toLocaleDateString(fr ? 'fr-FR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const hm = t => new Date(t * 1000).toLocaleTimeString(fr ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

/** posé OK ou posé pas OK : le bandeau et le point sur la trace */
function drawFlag(s) {
  const on = !!s;
  $('flag').hidden = !on;
  if (!on) { flagMark.remove(); return; }
  $('flag').textContent = T[s.state].replace('{h}', hm(s.t));
  $('flag').className = s.state === 'sos' ? 'sos' : '';
  flagDot.style.background = s.state === 'sos' ? '#c8102e' : '#1a7f3c';
  if (s.lat !== null && s.lon !== null) flagMark.setLngLat([s.lon, s.lat]).addTo(map); else flagMark.remove();
}

/** la distance d'un vol, calculée une fois (le vol en cours, à chaque nouveau point) */
function scoreOf(f, i) {
  const key = `${f.t0}:${f.t1}`;
  let s = scores.get(key);
  if (!s) { s = scoreFlight(pts.slice(f.i0, f.i1 + 1), { samples: i === flights.length - 1 ? 200 : 120 }); scores.set(key, s); }
  return s;
}

function cut() {
  const all = splitFlights(pts), air = all.filter(s => s.air);
  flights = air;
  if (followLast || sel >= flights.length) sel = flights.length - 1;
}

function draw() {
  const last = pts[pts.length - 1];
  if (!last) { $('state').textContent = T.none; $('figures').hidden = true; $('maps').hidden = true; $('lFlights').hidden = true; $('flights').replaceChildren(); return; }
  const age = Date.now() / 1000 - serverLag - last[0];
  $('state').textContent = age < FRESH_S ? T.now : T.ago.replace('{t}', span(age));
  $('alt').textContent = fig(last[3], 0, 'm');
  $('spd').textContent = fig(last[4] === null ? null : last[4] * 3.6, 0, 'km/h');
  $('vz').textContent = fig(last[6], 1, 'm/s');
  const f = flights[sel], s = f && scoreOf(f, sel);
  $('km').textContent = s ? fig(s.free.d / 1000, 1, 'km') : '—';
  $('figures').hidden = false;
  $('maps').href = `https://www.google.com/maps/search/?api=1&query=${last[1]},${last[2]}`;
  $('maps').hidden = false;
  $('lFlights').hidden = !flights.length;
  $('flights').replaceChildren(...flights.map((x, i) => {
    const sc = scoreOf(x, i), kmTxt = sc ? fig(sc.free.d / 1000, 1, 'km') : '—';
    const li = el('li', { className: i === sel ? 'sel' : '' },
      el('span', {}, `${day(x.t0)} · ${hm(x.t0)}–${hm(x.t1)}`, el('small', { textContent: [T.flight.replace('{d}', span(x.t1 - x.t0)), sc?.open.fai?.P >= 10000 ? T.fai.replace('{k}', fig(sc.open.fai.P / 1000, 0, 'km')) : ''].filter(Boolean).join(' · ') })),
      el('b', { textContent: kmTxt }));
    li.addEventListener('click', () => { sel = i; followLast = i === flights.length - 1; draw(); fitFlight(); });
    return li;
  }).reverse());
  if (!loaded) return;
  const line = (x, color, w) => ({ type: 'Feature', properties: { color, w }, geometry: { type: 'LineString', coordinates: pts.slice(x.i0, x.i1 + 1).map(p => [p[2], p[1]]) } });
  const feats = flights.map((x, i) => (i === sel ? null : line(x, OTHER, 2))).filter(Boolean);
  if (f) feats.push(line(f, SEL, 3.5));
  // après le dernier vol (posé, il marche) : jusqu'à sa position
  const tailFrom = flights.length ? flights[flights.length - 1].i1 : 0;
  if (tailFrom < pts.length - 1) feats.push({ type: 'Feature', properties: { color: OTHER, w: 2 }, geometry: { type: 'LineString', coordinates: pts.slice(tailFrom).map(p => [p[2], p[1]]) } });
  map.getSource('track').setData({ type: 'FeatureCollection', features: feats });
  const on3d = air3d.on;
  map.setPaintProperty('track', 'line-opacity', on3d ? 0.3 : 1);
  map.setPaintProperty('track-case', 'line-opacity', on3d ? 0 : 0.7);
  // en 3D, le pilote est toujours là où il est : au sol sans vol gardé, ou un vol passé choisi, sa position du moment
  // en plus (avant, rien du tout en 3D tant qu'il n'avait pas volé)
  const items = [], current = f && sel === flights.length - 1;
  if (f) items.push({ id: 'p', color: 'hsl(224 100% 50%)', sel: true, old: !current || age > FRESH_S, label: current ? who ?? '' : '', pts: current ? pts.slice(f.i0) : pts.slice(f.i0, f.i1 + 1) });
  if (!current) items.push({ id: 'now', color: 'hsl(224 100% 50%)', sel: true, old: age > FRESH_S, label: who ?? '', pts: pts.slice(tailFrom) });
  air3d.setData(items, true, null);
  marker.setLngLat([last[2], last[1]]);
  if (on3d) marker.remove(); else marker.addTo(map);
  if (!placed) {
    placed = true;
    if (f) fitFlight(0); else map.jumpTo({ center: [last[2], last[1]], zoom: 12 });
  }
}

function fitFlight(duration = 600) {
  const f = flights[sel];
  if (!f) return;
  const b = new maplibregl.LngLatBounds();
  for (let i = f.i0; i <= f.i1; i++) b.extend([pts[i][2], pts[i][1]]);
  map.fitBounds(b, { padding: { top: 60, bottom: window.innerWidth < 900 ? Math.round(window.innerHeight * 0.45) : 60, left: window.innerWidth < 900 ? 40 : 420, right: 60 }, maxZoom: 14, duration });
}

async function tick() {
  const full = Date.now() - fullAt > FULL_EVERY || !pts.length;
  try {
    const r = await fetch(api + (full ? '' : '?since=' + pts[pts.length - 1][0]), { cache: 'no-store' });
    if (r.status === 404) {
      $('name').textContent = T.gone; $('wing').textContent = T.goneHint; $('state').textContent = '';
      // le pilote vient peut-être de couper cet accès : plus rien de lui ne reste à l'écran
      $('figures').hidden = true; $('maps').hidden = true; $('lFlights').hidden = true; $('flights').replaceChildren(); marker.remove();
      pts = []; flights = []; scores.clear(); who = null;
      drawFlag(null);
      document.title = T.title;
      if (loaded) { map.getSource('track').setData({ type: 'FeatureCollection', features: [] }); air3d.setData([], true, null); }
      map.jumpTo({ center: [6.1, 45.9], zoom: 5 });
      setTimeout(tick, 5000);
      return;
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    who = [d.p.first, d.p.last].filter(Boolean).join(' ');
    $('name').textContent = who || T.title;
    document.title = who ? `${who} – ${T.title}` : T.title;
    $('wing').textContent = [d.p.brand, d.p.wing].filter(Boolean).join(' ');
    drawFlag(d.status);
    serverLag = Date.now() / 1000 - d.now;
    const before = pts.length;
    pts = full ? d.pts : pts.concat(d.pts);
    if (full) { fullAt = Date.now(); scores.clear(); }
    if (full || pts.length !== before) {
      // le vol en cours a changé : sa distance se recalcule
      const lastF = flights[flights.length - 1];
      if (lastF) scores.delete(`${lastF.t0}:${lastF.t1}`);
      cut();
    }
    draw();
  } catch { $('state').textContent = T.down; }
  setTimeout(tick, 5000);
}

map.on('load', () => {
  map.addSource('track', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'track-case', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': ['+', ['get', 'w'], 3], 'line-opacity': 0.7 } });
  map.addLayer({ id: 'track', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'] } });
  map.addLayer(air3d);
  air3d.setOn(view3d.on);
  loaded = true;
  draw();
});
void tick();
