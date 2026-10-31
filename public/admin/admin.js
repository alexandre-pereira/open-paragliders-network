// Back-office de Open Paragliders Network : toutes les traces d'une période sur une carte, filtres, suivi en direct par
// WebSocket (abonnement « admin » au monde entier, repris avec son curseur après une coupure).
// Les noms et les voiles viennent des pilotes : jamais insérés en HTML, toujours en texte.
'use strict';

const API = '/api/v1';
const $ = id => document.getElementById(id);
const TYPE_FR = { paraglider: 'Parapente', hangglider: 'Delta', sailplane: 'Planeur', paramotor: 'Paramoteur', other: 'Autre' };
const OLD_S = 300;

let token = '';
try { token = sessionStorage.getItem('wsl.token') || ''; } catch { /* stockage fermé */ }

const state = {
  /** id → { id, p, blocked, pts: [[t, lat, lon, alt, spd, crs, vz]…] triés par heure } */
  pilots: new Map(),
  /** id → { device, created, seen } (liste des pilotes) */
  meta: new Map(),
  seq: 0, from: 0, to: 0, period: 3600, custom: false,
  sel: null, follow: false, dirty: true,
  ws: null, wsTry: 0, wsTimer: null, pingAt: 0, pongAt: 0,
};

const nowS = () => Math.floor(Date.now() / 1000);
const nameOf = p => [p.p?.first, p.p?.last].filter(Boolean).join(' ') || `Pilote ${p.id}`;
const colorOf = id => `hsl(${Math.round((Number(id) * 137.508) % 360)} 78% 45%)`;
const ago = t => { const s = nowS() - t; return s < 60 ? `${Math.max(0, s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : `${Math.round(s / 86400)} j`; };
const hhmm = t => new Date(t * 1000).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mb = b => b == null ? '—' : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} Go` : `${Math.round(b / 1048576)} Mo`;
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) if (k != null) e.append(k); return e; };

// ── accès ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { showLogin('Mot de passe refusé.'); throw new Error('401'); }
  if (r.status === 429) { showLogin('Trop d’essais : attendre une minute.'); throw new Error('429'); }
  if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).message || ''}`);
  return r.json();
}

function showLogin(msg = '') {
  closeWs();
  $('login').hidden = false;
  $('loginErr').textContent = msg;
  $('token').focus();
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  token = $('token').value.trim();
  try { await api('/admin/stats'); } catch { return; }
  try { sessionStorage.setItem('wsl.token', token); } catch { /* stockage fermé */ }
  $('login').hidden = true;
  start();
});

// ── carte ────────────────────────────────────────────────────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: 'map', style: baseStyle(), center: [6.2, 45.9], zoom: 7, hash: true, maxPitch: MAX_PITCH,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
const view3d = new View3d(), air3d = new Air3d();
view3d.onChange = apply3d;
map.addControl(view3d, 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
const mapReady = new Promise(ok => map.on('load', ok));

const EMPTY = { type: 'FeatureCollection', features: [] };
mapReady.then(() => {
  map.addSource('tracks', { type: 'geojson', data: EMPTY });
  map.addSource('pos', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'tracks', type: 'line', source: 'tracks', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'sel'], 4, 2], 'line-opacity': ['case', ['get', 'old'], 0.45, 0.9] } });
  map.addLayer({ id: 'pos', type: 'circle', source: 'pos',
    paint: { 'circle-radius': ['case', ['get', 'sel'], 8, 6], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': ['case', ['get', 'old'], 0.5, 1] } });
  map.addLayer({ id: 'labels', type: 'symbol', source: 'pos',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': false },
    paint: { 'text-color': '#1d2330', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  for (const id of ['pos', 'tracks', 'labels']) {
    map.on('click', id, e => select(e.features[0].properties.id, false));
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.addLayer(air3d);
  // en 3D les pilotes sont en l'air (air3d.js) : au sol il ne reste que leur ombre
  map.on('click', e => { const id = air3d.on && air3d.pick(e.point, true); if (id) select(id, false); });
  map.on('mousemove', e => { if (air3d.on) map.getCanvas().style.cursor = air3d.pick(e.point, false) ? 'pointer' : ''; });
  apply3d(view3d.on);
  state.dirty = true;
});

/** les couches posées au sol selon la vue */
function apply3d(on) {
  air3d.setOn(!!on);
  if (!map.getLayer('pos')) return;
  map.setLayoutProperty('labels', 'visibility', on ? 'none' : 'visible');
  map.setPaintProperty('tracks', 'line-opacity', on ? ['case', ['get', 'old'], 0.12, 0.25] : ['case', ['get', 'old'], 0.45, 0.9]);
  map.setPaintProperty('pos', 'circle-opacity', on ? 0.35 : ['case', ['get', 'old'], 0.5, 1]);
  map.setPaintProperty('pos', 'circle-stroke-width', on ? 0 : 2);
}

/** altitude → couleur (bleu en bas, rouge en haut) */
const altColor = a => { const k = Math.max(0, Math.min(1, ((a ?? 0) - 500) / 3500)); return `hsl(${Math.round(230 - 230 * k)} 85% 45%)`; };

// ── filtres ──────────────────────────────────────────────────────────────────────────────────────────────────────

function filters() {
  const types = new Set([...document.querySelectorAll('#types input:checked')].map(i => i.value));
  const q = $('q').value.trim().toLowerCase();
  const active = Number($('active').value) || 0;
  const altMin = $('altMin').value === '' ? null : Number($('altMin').value);
  const blocked = $('showBlocked').checked;
  return p => {
    const last = p.pts[p.pts.length - 1];
    if (!last) return false;
    if (p.blocked && !blocked) return false;
    if (!types.has(p.p?.type || 'other')) return false;
    if (active && nowS() - last[0] > active) return false;
    if (altMin !== null && (last[3] ?? -Infinity) < altMin) return false;
    if (q) {
      const m = state.meta.get(p.id);
      const hay = [p.id, p.p?.first, p.p?.last, p.p?.wing, p.p?.app, m?.device].join(' ').toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  };
}

function visible() {
  const ok = filters();
  return [...state.pilots.values()].filter(ok).sort((a, b) => b.pts[b.pts.length - 1][0] - a.pts[a.pts.length - 1][0]);
}

// ── rendu (au plus une fois par seconde) ─────────────────────────────────────────────────────────────────────────

function render() {
  const list = visible();
  $('count').textContent = String(list.length);
  renderList(list);
  if (map.getSource('tracks')) {
    const showTracks = $('showTracks').checked, byAlt = $('colorAlt').checked, labels = $('showLabels').checked;
    const lines = [], points = [];
    for (const p of list) {
      const last = p.pts[p.pts.length - 1], sel = p.id === state.sel, old = nowS() - last[0] > OLD_S, color = colorOf(p.id);
      if (showTracks && p.pts.length > 1) {
        if (byAlt) {
          // une ligne par tranche de 250 m, pour colorer la trace selon l'altitude
          let seg = [[p.pts[0][2], p.pts[0][1]]], band = Math.floor((p.pts[0][3] ?? 0) / 250);
          for (let i = 1; i < p.pts.length; i++) {
            const f = p.pts[i], b = Math.floor((f[3] ?? 0) / 250);
            seg.push([f[2], f[1]]);
            if (b !== band || i === p.pts.length - 1) {
              lines.push({ type: 'Feature', properties: { id: p.id, color: altColor(band * 250 + 125), sel, old }, geometry: { type: 'LineString', coordinates: seg } });
              seg = [[f[2], f[1]]]; band = b;
            }
          }
        } else lines.push({ type: 'Feature', properties: { id: p.id, color, sel, old }, geometry: { type: 'LineString', coordinates: p.pts.map(f => [f[2], f[1]]) } });
      }
      points.push({ type: 'Feature', properties: { id: p.id, color, sel, old, label: labels ? `${nameOf(p)}${last[3] != null ? ` · ${last[3]} m` : ''}` : '' }, geometry: { type: 'Point', coordinates: [last[2], last[1]] } });
    }
    map.getSource('tracks').setData({ type: 'FeatureCollection', features: lines });
    map.getSource('pos').setData({ type: 'FeatureCollection', features: points });
    air3d.setData(list.map(p => {
      const last = p.pts[p.pts.length - 1];
      return { id: p.id, color: colorOf(p.id), sel: p.id === state.sel, old: nowS() - last[0] > OLD_S, pts: p.pts, label: labels ? `${nameOf(p)}${last[3] != null ? ` · ${last[3]} m` : ''}` : '' };
    }), showTracks, byAlt ? f => altColor(Math.floor((f[3] ?? 0) / 250) * 250 + 125) : null);
  }
  if (state.sel) renderDetail();
  if (state.follow && state.sel) {
    const p = state.pilots.get(state.sel), last = p?.pts[p.pts.length - 1];
    if (last) map.easeTo({ center: [last[2], last[1]], duration: 500 });
  }
}

function renderList(list) {
  const ul = $('pilots');
  ul.replaceChildren(...list.slice(0, 500).map(p => {
    const last = p.pts[p.pts.length - 1];
    const li = el('li', { className: [p.id === state.sel ? 'sel' : '', nowS() - last[0] > OLD_S ? 'old' : '', p.blocked ? 'blocked' : ''].join(' ') },
      el('span', { className: 'sw' }),
      el('span', { className: 'name', textContent: nameOf(p) }),
      el('span', { className: 'ago', textContent: ago(last[0]) }),
      el('span', { className: 'sub', textContent: [p.p?.wing, p.p?.app, last[3] != null ? `${last[3]} m` : ''].filter(Boolean).join(' · ') || TYPE_FR[p.p?.type] || '' }));
    li.firstChild.style.background = colorOf(p.id);
    li.addEventListener('click', () => select(p.id, true));
    return li;
  }));
}

function select(id, center) {
  state.sel = String(id);
  state.follow = false;
  const p = state.pilots.get(state.sel);
  if (center && p) fitTo([p]);
  state.dirty = true;
  render();
}

function fitTo(list) {
  const b = new maplibregl.LngLatBounds();
  let n = 0;
  for (const p of list) for (const f of p.pts) { b.extend([f[2], f[1]]); n++; }
  if (n) map.fitBounds(b, { padding: 60, maxZoom: 14, duration: 600 });
}

function renderDetail() {
  const p = state.pilots.get(state.sel), box = $('detail');
  if (!p) { box.hidden = true; state.sel = null; return; }
  const last = p.pts[p.pts.length - 1], first = p.pts[0], m = state.meta.get(p.id);
  const dl = el('dl');
  const row = (k, v) => { if (v !== undefined && v !== null && v !== '') dl.append(el('dt', { textContent: k }), el('dd', { textContent: String(v) })); };
  row('Voile', p.p?.wing); row('Type', TYPE_FR[p.p?.type]); row('Logiciel', p.p?.app); row('N°', p.id); row('Appareil', m?.device);
  row('Dernier point', `${hhmm(last[0])} (il y a ${ago(last[0])})`);
  row('Altitude', last[3] != null ? `${last[3]} m` : '—');
  row('Vitesse sol', last[4] != null ? `${Math.round(last[4] * 3.6)} km/h` : '—');
  row('Vario', last[6] != null ? `${last[6] > 0 ? '+' : ''}${last[6].toFixed(1)} m/s` : '—');
  row('Position', `${last[1].toFixed(5)}, ${last[2].toFixed(5)}`);
  row('Trace affichée', `${p.pts.length} points depuis ${hhmm(first[0])}`);
  if (p.full) row('Trace', 'complète (pleine résolution)');
  const btn = (label, fn, cls = '') => { const b = el('button', { type: 'button', textContent: label, className: cls }); b.addEventListener('click', fn); return b; };
  const actions = el('div', { className: 'actions' },
    btn('Centrer', () => fitTo([p])),
    btn(state.follow ? 'Ne plus suivre' : 'Suivre', () => { state.follow = !state.follow; render(); }),
    btn('Trace complète', () => loadFull(p.id)),
    btn('GPX', () => gpx(p)),
    btn(p.blocked ? 'Débloquer' : 'Bloquer', () => block(p.id, !p.blocked), 'danger'),
    btn('Effacer', () => removePilot(p.id), 'danger'));
  const close = btn('✕', () => { state.sel = null; state.follow = false; box.hidden = true; state.dirty = true; }, 'icon close');
  box.replaceChildren(close, el('h3', { textContent: nameOf(p) }), el('div', { className: 'muted', textContent: p.blocked ? 'Bloqué : invisible pour les autres, ses envois sont refusés' : '' }), dl, actions);
  box.hidden = false;
}

// ── données ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** fusionne des points dans une trace triée par heure (sans double) */
function merge(p, pts) {
  if (!pts?.length) return;
  const last = p.pts[p.pts.length - 1];
  if (!last || pts[0][0] > last[0]) { for (const f of pts) p.pts.push(f); return; }
  const by = new Map(p.pts.map(f => [f[0], f]));
  for (const f of pts) by.set(f[0], f);
  p.pts = [...by.values()].sort((a, b) => a[0] - b[0]);
}

function range() {
  const v = $('period').value;
  state.custom = v === 'custom';
  $('customRange').hidden = !state.custom;
  if (state.custom) {
    const f = $('from').value ? Date.parse($('from').value) / 1000 : nowS() - 3600;
    const t = $('to').value ? Date.parse($('to').value) / 1000 : nowS();
    return { from: Math.floor(f), to: Math.floor(t), live: !$('to').value && $('live').checked };
  }
  state.period = Number(v);
  return { from: nowS() - state.period, to: nowS(), live: $('live').checked };
}

let loading = 0;
async function load() {
  const my = ++loading;
  const r = range();
  const step = Math.max(1, Math.round((r.to - r.from) / 2000));
  const [data, list] = await Promise.all([
    api(`/admin/tracks?from=${r.from}&to=${r.to + 60}&step=${step}`),
    api(`/admin/pilots?from=${r.from}&to=${r.to + 60}`),
  ]);
  if (my !== loading) return;
  state.from = r.from; state.to = r.to; state.seq = data.seq;
  state.pilots.clear();
  for (const x of data.pilots) state.pilots.set(x.id, { id: x.id, p: x.p, blocked: !!x.blocked, pts: x.pts });
  state.meta = new Map(list.pilots.map(x => [x.id, x]));
  state.dirty = true;
  if (r.live) connectWs(); else closeWs();
}

async function loadFull(id) {
  const p = state.pilots.get(id);
  if (!p) return;
  const r = await api(`/admin/track/${id}?from=${state.from}&to=${state.custom ? state.to + 60 : nowS() + 60}`);
  p.pts = r.pts; p.full = true;
  state.dirty = true;
}

async function block(id, blocked) {
  await api(`/admin/pilots/${id}/block`, { method: 'POST', body: JSON.stringify({ blocked }) });
  const p = state.pilots.get(id);
  if (p) p.blocked = blocked;
  state.dirty = true;
}

async function removePilot(id) {
  const p = state.pilots.get(id);
  if (!confirm(`Effacer ${p ? nameOf(p) : id} et toute sa trace ? Son identifiant d'appareil sera libéré.`)) return;
  await api(`/admin/pilots/${id}/delete`, { method: 'POST', body: '{}' });
  state.pilots.delete(id);
  state.sel = null; $('detail').hidden = true; state.dirty = true;
}

function gpx(p) {
  const x = s => String(s).replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
  const pts = p.pts.map(f => `<trkpt lat="${f[1]}" lon="${f[2]}">${f[3] != null ? `<ele>${f[3]}</ele>` : ''}<time>${new Date(f[0] * 1000).toISOString()}</time></trkpt>`).join('\n');
  const s = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Open Paragliders Network" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${x(nameOf(p))}</name><desc>${x(p.p?.wing || '')}</desc><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
  const a = el('a', { href: URL.createObjectURL(new Blob([s], { type: 'application/gpx+xml' })), download: `${nameOf(p).replace(/[^\p{L}\p{N}_-]+/gu, '_')}_${new Date(p.pts[0][0] * 1000).toISOString().slice(0, 10)}.gpx` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function stats() {
  try {
    const s = await api('/admin/stats');
    const used = s.usedBytes / s.maxDbBytes;
    const cell = (v, k) => el('div', {}, el('b', { textContent: v }), k);
    const bar = el('div', { className: 'bar', title: `Base : ${mb(s.usedBytes)} sur ${mb(s.maxDbBytes)}` }, el('i'));
    bar.firstChild.style.width = `${Math.min(100, used * 100).toFixed(1)}%`;
    $('stats').replaceChildren(
      cell(String(s.memory.live), 'en ligne (1 h)'), cell(s.points.toLocaleString('fr-FR'), 'points'), cell(String(s.clients), 'connexions'),
      cell(mb(s.usedBytes), `base / ${mb(s.maxDbBytes)}`), cell(mb(s.freeDisk), 'disque libre'), cell(s.oldest ? ago(s.oldest) : '—', 'plus vieux point'),
      bar);
  } catch { /* au prochain tour */ }
}

// ── direct ───────────────────────────────────────────────────────────────────────────────────────────────────────

function setConn(on) { $('conn').className = `dot ${on === true ? 'on' : on === false ? 'off' : ''}`; $('conn').title = on ? 'En direct' : on === false ? 'Liaison coupée, reconnexion…' : 'Hors direct'; }

function closeWs() {
  clearTimeout(state.wsTimer);
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  setConn(null);
}

function connectWs() {
  closeWs();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${API}/ws`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', admin: token, app: 'back-office' }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.op === 'welcome') { state.wsTry = 0; setConn(true); ws.send(JSON.stringify({ op: 'sub', since: state.seq, trail: 3600, every: 2 })); }
    else if (m.op === 'pong') state.pongAt = Date.now();
    else if (m.op === 'upd') {
      // curseur trop vieux (serveur redémarré, longue coupure) : on recharge la période
      if (m.reset) { void load(); return; }
      state.seq = m.seq;
      for (const u of m.pilots) {
        if (u.gone) { state.pilots.delete(u.id); continue; }
        let p = state.pilots.get(u.id);
        if (!p) { p = { id: u.id, p: u.p, blocked: !!u.blocked, pts: [] }; state.pilots.set(u.id, p); }
        if (u.p) p.p = u.p;
        p.blocked = !!u.blocked;
        merge(p, u.pts);
      }
      state.dirty = true;
    } else if (m.op === 'err' && m.code === 'admin-required') showLogin('Mot de passe refusé.');
  };
  ws.onclose = () => {
    setConn(false);
    state.ws = null;
    const wait = Math.min(30000, 1000 * 2 ** state.wsTry++);
    state.wsTimer = setTimeout(connectWs, wait);
  };
}

// ── démarrage ────────────────────────────────────────────────────────────────────────────────────────────────────

let started = false;
async function start() {
  if (started) return;
  started = true;
  await mapReady;
  await Promise.all([load(), stats()]);
  fitTo(visible());
  setInterval(stats, 30000);
  setInterval(() => { if (state.dirty) { state.dirty = false; render(); } }, 1000);
  setInterval(() => {
    // fenêtre glissante en direct : les points sortis de la période partent
    if (!state.custom && state.ws) {
      const from = nowS() - state.period;
      for (const [id, p] of state.pilots) {
        if (p.pts.length && p.pts[0][0] < from) { const i = p.pts.findIndex(f => f[0] >= from); p.pts = i < 0 ? [] : p.pts.slice(i); }
        if (!p.pts.length) state.pilots.delete(id);
      }
      state.from = from;
    }
    // liaison muette (réseau tombé sans fermeture) : coupée, puis reprise avec le curseur
    if (state.ws?.readyState === 1) {
      if (state.pingAt && state.pongAt < state.pingAt && Date.now() - state.pingAt > 10000) state.ws.close();
      else { state.pingAt = Date.now(); state.ws.send(JSON.stringify({ op: 'ping', t: state.pingAt })); }
    }
    state.dirty = true;
  }, 15000);
}

for (const id of ['period', 'from', 'to', 'live']) $(id).addEventListener('change', () => { void load(); });
for (const id of ['q', 'active', 'altMin', 'showTracks', 'showLabels', 'showBlocked', 'colorAlt']) $(id).addEventListener('input', () => { state.dirty = true; render(); });
$('types').addEventListener('change', () => { state.dirty = true; render(); });
$('fit').addEventListener('click', () => fitTo(visible()));
$('toggleSide').addEventListener('click', () => {
  const h = $('side').classList.toggle('hidden');
  $('toggleSide').textContent = h ? '›' : '‹';
  setTimeout(() => map.resize(), 250);
});

if (token) api('/admin/stats').then(() => start(), () => { /* showLogin déjà fait */ });
else showLogin();
