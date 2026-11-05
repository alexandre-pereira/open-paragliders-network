// La carte publique : les pilotes du jour avec leur distance et le triangle qu'ils feraient s'ils bouclaient, groupés
// quand ils sont trop serrés pour être lus. Un pilote choisi montre tout son dernier vol, ses triangles bouclés selon la
// règle de fermeture choisie, et où il bouclerait son triangle. Relief en 3D avec les pilotes à leur altitude.
// Les noms viennent des pilotes : toujours en texte (textContent, canvas), jamais en HTML.

import { LEAGUES, circle, closingZone, leagueScore, scoreFlight } from '/lib/xc.js';

const fr = /^fr/i.test(navigator.language);
const T = fr ? {
  title: 'En direct', tailOn: 'Montrer sa trace sur la carte', tailFull: '{n} traces au plus : décoche un autre pilote', search: 'Rechercher un pilote, une voile…', sort: 'Trier par', rule: 'Règles de distance',
  sorts: { km: 'Distance', fai: 'Triangle FAI', name: 'Nom', alt: 'Altitude', recent: 'Dernière position' },
  leagues: { xcontest: 'XContest', cfd: 'CFD (FFVL)' }, gaps: { xc20: 'écart < 20 %', xc5: 'écart < 5 %', cfd: 'écart ≤ 5 % ou 3 km' },
  count: '{n} pilotes aujourd’hui · {f} en vol', none: 'Personne n’a encore volé aujourd’hui.', noMatch: 'Aucun pilote ne correspond.',
  flying: 'En vol', landed: 'Posé il y a {t}', lost: 'Dernière position il y a {t}', ground: 'Au sol, pas encore décollé', car: 'en voiture',
  ok: 'POSÉ OK à {h}', sos: 'POSÉ PAS OK à {h} : besoin d’aide', sosShort: 'POSÉ PAS OK',
  alt: 'Altitude', vz: 'Vario', spd: 'Vitesse', dur: 'Vol', free: 'Distance libre', closedFai: 'Triangle FAI', closedFlat: 'Triangle plat', total: 'Points {r}',
  openFaiIf: 'FAI s’il boucle', openFlatIf: 'Plat s’il boucle', openFai: 'Triangle FAI', openFlat: 'Triangle plat', target: 'Triangle visé',
  close: 'Pour boucler le {P} :', togo: '×{k} ({g}) : encore {d}', closed: '×{k} ({g}) : bouclé', pts: 'pts', noTri: 'Pas encore de triangle.', loading: 'Trace en cours de chargement…',
  center: 'Centrer', follow: 'Suivre', unfollow: 'Ne plus suivre', pilot: 'Pilote {n}', fold: 'Replier la liste', unfold: 'Déplier la liste', back: 'Pilotes', backTip: 'Retour à la liste des pilotes',
  conn: 'En direct', down: 'Réseau coupé, nouvel essai…', about: 'À propos de cette carte', group: '{n} pilotes : zoomer',
} : {
  title: 'Live', tailOn: 'Show their track on the map', tailFull: '{n} tracks at most: untick another pilot', search: 'Search a pilot, a wing…', sort: 'Sort by', rule: 'Distance rules',
  sorts: { km: 'Distance', fai: 'FAI triangle', name: 'Name', alt: 'Altitude', recent: 'Last position' },
  leagues: { xcontest: 'XContest', cfd: 'CFD (FFVL)' }, gaps: { xc20: 'gap < 20 %', xc5: 'gap < 5 %', cfd: 'gap ≤ 5 % or 3 km' },
  count: '{n} pilots today · {f} flying', none: 'Nobody has flown today yet.', noMatch: 'No pilot matches.',
  flying: 'Flying', landed: 'Landed {t} ago', lost: 'Last position {t} ago', ground: 'On the ground, not taken off yet', car: 'driving',
  ok: 'LANDED OK at {h}', sos: 'LANDED, NEEDS HELP at {h}', sosShort: 'NEEDS HELP',
  alt: 'Altitude', vz: 'Vario', spd: 'Speed', dur: 'Flight', free: 'Free distance', closedFai: 'FAI triangle', closedFlat: 'Flat triangle', total: '{r} points',
  openFaiIf: 'FAI if closed', openFlatIf: 'Flat if closed', openFai: 'FAI triangle', openFlat: 'Flat triangle', target: 'Target triangle',
  close: 'To close the {P}:', togo: '×{k} ({g}): {d} to go', closed: '×{k} ({g}): closed', pts: 'pts', noTri: 'No triangle yet.', loading: 'Loading the track…',
  center: 'Center', follow: 'Follow', unfollow: 'Stop following', pilot: 'Pilot {n}', fold: 'Fold the list', unfold: 'Unfold the list', back: 'Pilots', backTip: 'Back to the pilot list',
  conn: 'Live', down: 'Network down, trying again…', about: 'About this map', group: '{n} pilots: zoom in',
};

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) if (k != null && k !== false) e.append(k); return e; };
const LIST_EVERY = 10000, SEL_EVERY = 5000;
/** sans point depuis FLYING_S (s) : plus « en vol » */
const FLYING_S = 120;
/** groupes : au-delà de CLUSTER_MIN pilotes, sous le zoom CLUSTER_MAX_Z, par cases de CELL px, à partir de 3 */
const CLUSTER_MIN = 25, CLUSTER_MAX_Z = 13, CELL = 64, CLUSTER_N = 3;
/** traces des autres pilotes cochées à la fois, au plus */
const TAILS_MAX = 10;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage fermé */ } },
};
const state = {
  pilots: new Map(), lag: 0, firstFit: !/^#\d/.test(location.hash), online: null,
  sel: null, follow: false, league: LEAGUES[store.get('opn.league')] ? store.get('opn.league') : 'xcontest', target: null,
  sort: T.sorts[store.get('opn.sort')] ? store.get('opn.sort') : 'km', groups: { singles: [], clusters: [] },
  // les traces des autres pilotes : cachées par défaut, seules leurs positions ; une case par pilote, TAILS_MAX au plus
  tails: new Set(readTails()),
};

function readTails() {
  try { const v = JSON.parse(store.get('opn.tailIds') ?? '[]'); return Array.isArray(v) ? v.map(String).slice(0, TAILS_MAX) : []; } catch { return []; }
}
const saveTails = () => store.set('opn.tailIds', JSON.stringify([...state.tails]));

const nowS = () => Date.now() / 1000 - state.lag;
const nameOf = p => [p.p?.first, p.p?.last].filter(Boolean).join(' ') || T.pilot.replace('{n}', p.id);
const wingOf = p => [p.p?.brand, p.p?.wing].filter(Boolean).join(' ');
const colorOf = id => `hsl(${Math.round((Number(id) * 137.508) % 360)} 78% 45%)`;
const num = (v, d = 1) => v.toLocaleString(fr ? 'fr-FR' : 'en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const km = m => `${num(m / 1000, m < 100000 ? 1 : 0)} km`;
const span = s => { s = Math.max(0, s); return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`; };
const hhmm = t => new Date(t * 1000).toLocaleTimeString(fr ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
const flying = p => nowS() - p.last[0] <= FLYING_S && !!p.flight && p.last[0] - p.flight.t1 <= FLYING_S;
/**
 * son icône : « foot » ou « car » quand son logiciel le dit au sol (`ground` du serveur), sinon en vol tant que son
 * dernier point est dans son vol, sans « posé » déclaré depuis, et pas lent sans nouvelles (posé sans le dire)
 */
const kindOf = p => {
  if (p.ground) return p.ground;
  if (!p.flight || p.last[0] - p.flight.t1 > FLYING_S) return 'foot';
  const st = p.p?.status;
  if (st && st.t >= p.flight.t0) return 'foot';
  return nowS() - p.last[0] > FLYING_S && (p.last[4] ?? 0) < 2.5 ? 'foot' : 'air';
};

// ── page ─────────────────────────────────────────────────────────────────────────────────────────────────────────

$('title').replaceChildren(el('small', { textContent: 'Open Paragliders Network' }), T.title);
document.title = `Open Paragliders Network – ${T.title}`;
$('q').placeholder = T.search;
$('lSort').textContent = T.sort; $('lRule').textContent = T.rule;
$('sort').replaceChildren(...Object.entries(T.sorts).map(([v, t]) => el('option', { value: v, textContent: t })));
$('rule').replaceChildren(...Object.keys(LEAGUES).map(v => el('option', { value: v, textContent: T.leagues[v] })));
$('sort').value = state.sort; $('rule').value = state.league;
$('aboutBtn').title = T.about; $('aboutBtn').setAttribute('aria-label', T.about);
const setFold = f => { $('side').classList.toggle('folded', f); $('fold').textContent = f ? '▴' : '▾'; $('fold').title = f ? T.unfold : T.fold; setTimeout(() => map.resize(), 50); };
$('fold').addEventListener('click', () => setFold(!$('side').classList.contains('folded')));
$('q').addEventListener('input', () => redraw());
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { const p = visible()[0]; if (p) select(p.id, true); } });
$('sort').addEventListener('change', () => { state.sort = $('sort').value; store.set('opn.sort', state.sort); renderList(); });
$('rule').addEventListener('change', () => { state.league = $('rule').value; store.set('opn.league', state.league); drawSel(); renderDetail(); });

function about(contact) {
  const P = t => el('p', { textContent: t }), H = t => el('h3', { textContent: t });
  const link = (href, t) => el('a', { href, textContent: t });
  const kids = fr ? [
    el('h2', { textContent: 'Open Paragliders Network' }),
    P('Les pilotes de vol libre qui partagent leur position avec le réseau, en direct : chacun avec son dernier vol de la journée, sa distance libre et le triangle qu’il ferait s’il revenait à son départ.'),
    H('Distance, triangles et points'),
    P('XContest compte un triangle quand le pilote revient à moins de 20 % du périmètre de son départ : périmètre moins l’écart, ×1,2 plat et ×1,4 FAI (chaque côté au moins 28 % du périmètre). Sous 5 %, le triangle est fermé : ×1,4 plat et ×1,6 FAI. La CFD de la FFVL demande 5 % d’écart, ou 3 km quel que soit le périmètre (bouclé à 3 km près, le périmètre entier compte) : ×1,2 plat et ×1,4 FAI. La distance libre (trois points de contournement) compte ×1 partout.'),
    P('Choisis le classement dans la liste : la fiche d’un pilote donne ses points, et les cercles sur la carte montrent où il doit revenir pour boucler son triangle (deux chez XContest : 20 % et 5 %). Ces calculs sont indicatifs : seul le classement officiel compte.'),
    H('Ce qui est montré'),
    P('Prénom, nom, voile, position et trace du dernier vol du jour, tels que le pilote les a donnés dans son logiciel. Un pilote peut ne pas apparaître ici sans quitter le réseau (dans WS Nav : Trafic & live › Open Paragliders Network › « Visible sur la carte web »). Le serveur garde les traces 72 h, puis les efface.'),
    H('Sécurité'),
    el('p', {}, 'Cette carte ne prévient pas les secours : en cas de danger, appelle le 112. Les pilotes qui ont signalé un besoin d’aide sont aussi sur ', link('/sos', 'la page des alertes'), '.'),
    H('Pour les développeurs'),
    el('p', {}, 'Le serveur est ouvert à tous les logiciels de vol : ', link('/docs/', 'documentation'), '.'),
  ] : [
    el('h2', { textContent: 'Open Paragliders Network' }),
    P('Free-flight pilots who share their position with the network, live: each with their last flight of the day, their free distance and the triangle they would make if they flew back to their start.'),
    H('Distance, triangles and points'),
    P('XContest scores a triangle when the pilot comes back within 20 % of the perimeter from their start: perimeter minus the gap, ×1.2 flat and ×1.4 FAI (each side at least 28 % of the perimeter). Under 5 % the triangle is closed: ×1.4 flat and ×1.6 FAI. The French CFD asks for a 5 % gap, or 3 km whatever the perimeter (closed within 3 km, the whole perimeter counts): ×1.2 flat and ×1.4 FAI. Free distance (three turnpoints) counts ×1 everywhere.'),
    P('Pick the contest in the list: a pilot’s card gives their points, and the circles on the map show where they have to come back to close their triangle (two for XContest: 20 % and 5 %). These figures are indicative: only the official ranking counts.'),
    H('What is shown'),
    P('First name, last name, wing, position and track of the last flight of the day, as the pilot typed them in their app. A pilot can stay off this map without leaving the network (in WS Nav: Traffic & live › Open Paragliders Network › « Visible on the web map »). The server keeps tracks 72 h, then deletes them.'),
    H('Safety'),
    el('p', {}, 'This map does not alert the rescue services: in an emergency, call 112. Pilots who asked for help are also on ', link('/sos', 'the alerts page'), '.'),
    H('Developers'),
    el('p', {}, 'The server is open to every flight app: ', link('/docs/', 'documentation'), '.'),
  ];
  if (contact) kids.push(P((fr ? 'Contact : ' : 'Contact: ') + contact));
  $('aboutText').replaceChildren(...kids);
}
about('');
fetch('/api/v1').then(r => r.json()).then(d => about(d.contact)).catch(() => { /* sans contact */ });
$('aboutBtn').addEventListener('click', () => { $('about').hidden = false; });
$('aboutClose').addEventListener('click', () => { $('about').hidden = true; });
$('about').addEventListener('click', e => { if (e.target === $('about')) $('about').hidden = true; });

// ── carte ────────────────────────────────────────────────────────────────────────────────────────────────────────

const map = new maplibregl.Map({ container: 'map', style: baseStyle(), center: [6.5, 45.9], zoom: 7, hash: true, maxPitch: MAX_PITCH, pixelRatio: PIXEL_RATIO, attributionControl: { compact: true } });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
const view3d = new View3d(), air3d = new Air3d();
view3d.onChange = on => apply3d(on);
map.addControl(view3d, 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
addPilotImages(map);
const mapReady = new Promise(ok => map.on('load', ok));
const EMPTY = { type: 'FeatureCollection', features: [] };

mapReady.then(() => {
  for (const id of ['zone', 'xc', 'tails', 'sel', 'pos']) map.addSource(id, { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#1a7f3c', 'fill-opacity': ['get', 'op'] } });
  map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': '#1a7f3c', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'tails', type: 'line', source: 'tails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'sel-case', type: 'line', source: 'sel', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 6, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'sel', type: 'line', source: 'sel', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3.5 } });
  map.addLayer({ id: 'xc', type: 'line', source: 'xc', layout: { 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-dasharray': [3, 2] } });
  // besoin d'aide : un anneau rouge autour de l'icône
  map.addLayer({ id: 'sos-ring', type: 'circle', source: 'pos', filter: ['all', ['!', ['get', 'cluster']], ['get', 'sos']],
    paint: { 'circle-radius': 17, 'circle-color': 'rgba(200, 16, 46, 0.12)', 'circle-stroke-color': '#c8102e', 'circle-stroke-width': 3 } });
  // l'icône (icons.js) : en vol l'aile tournée vers sa route, au sol debout, en voiture ; le pilote choisi dessus
  map.addLayer({ id: 'pos', type: 'symbol', source: 'pos', filter: ['!', ['get', 'cluster']],
    layout: { 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['case', ['get', 'sel'], 1, 0] },
    paint: { 'icon-opacity': ['case', ['get', 'down'], 0.55, 1] } });
  map.addLayer({ id: 'clusters', type: 'circle', source: 'pos', filter: ['get', 'cluster'],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 3, 15, 50, 26], 'circle-color': '#0b6bcb', 'circle-opacity': 0.85, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cluster-n', type: 'symbol', source: 'pos', filter: ['get', 'cluster'],
    layout: { 'text-field': ['to-string', ['get', 'count']], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#fff' } });
  map.addLayer({ id: 'labels', type: 'symbol', source: 'pos', filter: ['!', ['get', 'cluster']],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#1d2330', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  for (const id of ['pos', 'labels', 'tails', 'sel']) {
    map.on('click', id, e => select(e.features[0].properties.id, false));
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', 'clusters', e => openCluster(e.features[0].properties.key));
  map.on('mouseenter', 'clusters', () => { map.getCanvas().style.cursor = 'zoom-in'; });
  map.on('mouseleave', 'clusters', () => { map.getCanvas().style.cursor = ''; });
  map.addLayer(air3d);
  // en 3D les pilotes sont en l'air (air3d.js) : au sol il ne reste que leur ombre
  map.on('click', e => {
    if (!air3d.on || map.queryRenderedFeatures(e.point, { layers: ['clusters'] }).length) return;
    const id = air3d.pick(e.point, true);
    if (id) select(id, false);
  });
  map.on('mousemove', e => { if (air3d.on && !map.queryRenderedFeatures(e.point, { layers: ['clusters'] }).length) map.getCanvas().style.cursor = air3d.pick(e.point, false) ? 'pointer' : ''; });
  // les groupes dépendent du zoom : refaits quand la carte s'arrête
  map.on('moveend', () => drawPilots());
  apply3d(view3d.on);
});

/** les couches posées au sol selon la vue */
function apply3d(on) {
  air3d.setOn(!!on);
  if (!map.getLayer('pos')) return;
  map.setLayoutProperty('labels', 'visibility', on ? 'none' : 'visible');
  map.setPaintProperty('tails', 'line-opacity', on ? 0.2 : 0.85);
  map.setPaintProperty('sel', 'line-opacity', on ? 0.25 : 1);
  map.setPaintProperty('sel-case', 'line-opacity', on ? 0 : 0.8);
  // en 3D l'icône est en l'air (air3d.js) : au sol il ne reste que son ombre
  map.setPaintProperty('pos', 'icon-opacity', on ? 0.25 : ['case', ['get', 'down'], 0.55, 1]);
  map.setPaintProperty('sos-ring', 'circle-stroke-opacity', on ? 0.3 : 1);
  drawPilots();
}

// ── données ──────────────────────────────────────────────────────────────────────────────────────────────────────

function setConn(on) {
  if (state.online === on) return;
  state.online = on;
  $('conn').className = `dot ${on ? 'on' : 'off'}`;
  $('conn').title = on ? T.conn : T.down;
}

async function loadList() {
  try {
    const r = await fetch('/api/v1/map', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    state.lag = Date.now() / 1000 - d.now;
    state.pilots = new Map(d.pilots.map(p => [p.id, p]));
    setConn(true);
    await mapReady;
    if (state.firstFit && d.pilots.length) { state.firstFit = false; fitTo(d.pilots.map(p => [p.last[2], p.last[1]]), 11); }
    const want = new URLSearchParams(location.search).get('p');
    if (want && !state.sel && state.pilots.has(want)) select(want, true, false);
    redraw();
  } catch { setConn(false); }
  setTimeout(loadList, LIST_EVERY);
}

/** le pilote choisi : tout son dernier vol, puis la suite toutes les SEL_EVERY */
async function loadSel() {
  const s = state.sel;
  if (!s) return;
  try {
    const last = s.pts?.at(-1);
    const r = await fetch(`/api/v1/map/${s.id}${last ? `?since=${last[0]}` : ''}`, { cache: 'no-store' });
    if (s !== state.sel) return;
    if (r.status === 404) { unselect(); return; }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    // un nouveau vol a commencé : on repart de zéro
    if (s.pts && d.t0 !== s.t0) { s.pts = null; s.t0 = d.t0; return loadSel(); }
    s.t0 = d.t0; s.t1 = d.t1; s.p = d.p;
    if (!s.pts) s.pts = d.pts; else if (d.pts.length) s.pts = merge(s.pts, d.pts);
    if (d.pts.length || !s.score) rescore(s);
    if (state.follow) { const f = s.pts.at(-1); if (f) map.easeTo({ center: [f[2], f[1]], duration: 600 }); }
    drawSel(); drawPilots(); renderDetail();
  } catch { /* au prochain tour */ }
  clearTimeout(s.timer);
  s.timer = setTimeout(loadSel, SEL_EVERY);
}

function merge(a, b) {
  if (!b.length) return a;
  if (!a.length || b[0][0] > a[a.length - 1][0]) return a.concat(b);
  const by = new Map(a.map(f => [f[0], f]));
  for (const f of b) by.set(f[0], f);
  return [...by.values()].sort((x, y) => x[0] - y[0]);
}

/** le vol lui-même : sans ce qui suit l'atterrissage (le pilote qui marche ne fait pas de distance) */
function flightPts(s) {
  const pts = s.pts ?? [];
  if (!s.t1 || !pts.length || pts[pts.length - 1][0] - s.t1 <= FLYING_S) return pts;
  return pts.filter(f => f[0] <= s.t1);
}

function rescore(s) {
  s.score = scoreFlight(flightPts(s), { samples: 220 });
  if (!s.target) s.target = s.score?.open.fai ? 'fai' : 'flat';
}

// ── dessin ───────────────────────────────────────────────────────────────────────────────────────────────────────

function visible() {
  const q = $('q').value.trim().toLowerCase();
  const all = [...state.pilots.values()];
  return q ? all.filter(p => { const hay = `${nameOf(p)} ${wingOf(p)} ${p.id}`.toLowerCase(); return q.split(/\s+/).every(w => hay.includes(w)); }) : all;
}

function sorted(list) {
  const k = state.sort, val = {
    km: p => -(p.flight?.km ?? 0), fai: p => -(p.flight?.fai ?? 0), alt: p => -(p.last[3] ?? -1e9), recent: p => -p.last[0], name: () => 0,
  }[k];
  return list.sort((a, b) => (val(a) - val(b)) || nameOf(a).localeCompare(nameOf(b)));
}

// la fiche aussi quand plus personne n'est choisi : c'est renderDetail qui la cache
function redraw() { renderList(); drawPilots(); renderDetail(); }

/** les pilotes trop serrés pour être lus, groupés par cases de la carte au zoom entier (stables quand on la déplace) */
function clusterize(list) {
  const z = Math.floor(map.getZoom());
  if (list.length <= CLUSTER_MIN || z >= CLUSTER_MAX_Z) return { singles: list, clusters: [] };
  const size = 512 * 2 ** z, cells = new Map(), singles = [];
  for (const p of list) {
    // le pilote choisi et ceux qui ont besoin d'aide restent seuls
    if (p.id === state.sel?.id || p.p?.status?.state === 'sos') { singles.push(p); continue; }
    const x = ((p.last[2] + 180) / 360) * size, s = Math.sin((p.last[1] * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
    const key = `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
    const c = cells.get(key);
    if (c) c.push(p); else cells.set(key, [p]);
  }
  const clusters = [];
  for (const [key, ps] of cells) {
    if (ps.length < CLUSTER_N) { singles.push(...ps); continue; }
    const lon = ps.reduce((a, p) => a + p.last[2], 0) / ps.length, lat = ps.reduce((a, p) => a + p.last[1], 0) / ps.length;
    clusters.push({ key, lon, lat, members: ps });
  }
  return { singles, clusters };
}

function openCluster(key) {
  const c = state.groups.clusters.find(x => x.key === key);
  if (c) fitTo(c.members.map(p => [p.last[2], p.last[1]]), CLUSTER_MAX_Z + 1);
}

function fitTo(lonlats, maxZoom = 14) {
  if (!lonlats.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const ll of lonlats) b.extend(ll);
  map.fitBounds(b, { padding: 70, maxZoom, duration: 600 });
}

const labelOf = p => [p.p?.status?.state === 'sos' ? T.sosShort : '', nameOf(p), p.flight?.km >= 1 ? `${num(p.flight.km)} km` : ''].filter(Boolean).join(' · ');

function drawPilots() {
  if (!map.getSource('pos')) return;
  const list = visible(), g = clusterize(list);
  state.groups = g;
  const sel = state.sel?.id;
  const feats = g.singles.map(p => {
    const kind = kindOf(p);
    return {
      type: 'Feature', geometry: { type: 'Point', coordinates: [p.last[2], p.last[1]] },
      properties: { id: p.id, color: colorOf(p.id), sel: p.id === sel, sos: p.p?.status?.state === 'sos', down: !flying(p), label: labelOf(p), cluster: false,
        icon: pilotIconId(kind, p.p?.type, colorOf(p.id), p.id === sel), rot: iconRotation(kind, p.last[5]) },
    };
  });
  for (const c of g.clusters) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: { cluster: true, count: c.members.length, key: c.key } });
  map.getSource('pos').setData({ type: 'FeatureCollection', features: feats });
  const lines = g.singles.filter(p => state.tails.has(p.id) && p.tail?.length > 1 && p.id !== sel).map(p => ({ type: 'Feature', properties: { id: p.id, color: colorOf(p.id) }, geometry: { type: 'LineString', coordinates: p.tail.map(f => [f[2], f[1]]) } }));
  map.getSource('tails').setData({ type: 'FeatureCollection', features: lines });
  air3d.setData(g.singles.map(p => ({
    id: p.id, color: colorOf(p.id), sel: p.id === sel, old: !flying(p), label: labelOf(p),
    icon: pilotIcon(kindOf(p), p.p?.type, colorOf(p.id), p.id === sel), rot: iconRotation(kindOf(p), p.last[5]),
    pts: p.id === sel && state.sel.pts?.length ? state.sel.pts : state.tails.has(p.id) && p.tail?.length ? p.tail : [p.last],
  })), true, null);
}

function drawSel() {
  if (!map.getSource('sel')) return;
  const s = state.sel;
  if (!s?.pts?.length) { for (const id of ['sel', 'xc', 'zone']) map.getSource(id).setData(EMPTY); return; }
  const color = colorOf(s.id);
  map.getSource('sel').setData({ type: 'Feature', properties: { id: s.id, color }, geometry: { type: 'LineString', coordinates: s.pts.map(f => [f[2], f[1]]) } });
  const xc = [], zone = [];
  const tri = s.score?.open[s.target];
  const tiers = tri ? LEAGUES[state.league].tiers : [];
  const zs = tiers.map(t => closingZone(flightPts(s), tri, t.rule)).filter(Boolean);
  if (tri) {
    const ring = [...tri.pts, tri.pts[0]].map(([la, lo]) => [lo, la]);
    xc.push({ type: 'Feature', properties: { color: '#1d2330', w: 2.5 }, geometry: { type: 'LineString', coordinates: ring } });
  }
  zs.forEach((z, i) => zone.push({ type: 'Feature', properties: { op: zs.length > 1 && !i ? 0.06 : 0.16 }, geometry: { type: 'Polygon', coordinates: [circle(z.center, z.radius)] } }));
  const z = zs[0], here = s.pts.at(-1);
  if (z?.toGo > 0) xc.push({ type: 'Feature', properties: { color: '#1a7f3c', w: 1.5 }, geometry: { type: 'LineString', coordinates: [[here[2], here[1]], [z.center[1], z.center[0]]] } });
  map.getSource('xc').setData({ type: 'FeatureCollection', features: xc });
  map.getSource('zone').setData({ type: 'FeatureCollection', features: zone });
}

function renderList() {
  const all = state.pilots.size, list = sorted(visible());
  const air = [...state.pilots.values()].filter(flying).length;
  $('count').textContent = T.count.replace('{n}', all).replace('{f}', air);
  // une case cochée d'un pilote parti de la carte ne doit pas prendre une des TAILS_MAX places
  if (all) for (const id of state.tails) if (!state.pilots.has(id)) { state.tails.delete(id); saveTails(); }
  const full = state.tails.size >= TAILS_MAX;
  if (!list.length) { $('list').replaceChildren(el('li', { className: 'empty', textContent: all ? T.noMatch : T.none })); return; }
  $('list').replaceChildren(...list.slice(0, 600).map(p => {
    const sos = p.p?.status?.state === 'sos';
    const state1 = sos ? T.sosShort : flying(p) ? (p.last[3] != null ? `${p.last[3]} m` : T.flying) : span(nowS() - p.last[0]);
    const li = el('li', { className: [p.id === state.sel?.id ? 'sel' : '', flying(p) ? '' : 'down', sos ? 'sos' : ''].join(' ') },
      el('span', { className: 'sw' }),
      el('span', { className: 'name' }, tailBox(p.id, full), el('span', { textContent: nameOf(p) })),
      el('span', { className: 'km' }, p.flight ? `${num(p.flight.km)} km` : '—', p.flight?.fai ? el('small', { textContent: `FAI ${num(p.flight.fai, 0)}` }) : null),
      el('span', { className: 'sub', textContent: [wingOf(p), state1].filter(Boolean).join(' · ') }));
    li.firstChild.style.background = colorOf(p.id);
    li.addEventListener('click', () => select(p.id, true));
    return li;
  }));
}

/** la case « trace » à côté du nom : la trace de ce pilote sur la carte ; pleine, les cases vides se grisent */
function tailBox(id, full) {
  const on = state.tails.has(id);
  const box = el('input', { type: 'checkbox', checked: on, disabled: full && !on, title: full && !on ? T.tailFull.replace('{n}', TAILS_MAX) : T.tailOn });
  box.setAttribute('aria-label', T.tailOn);
  box.addEventListener('click', e => e.stopPropagation());
  box.addEventListener('change', () => {
    if (box.checked && state.tails.size >= TAILS_MAX) { box.checked = false; return; }
    if (box.checked) state.tails.add(id); else state.tails.delete(id);
    saveTails(); renderList(); drawPilots();
  });
  return box;
}

function renderDetail() {
  const s = state.sel, box = $('detail');
  if (!s) { showDetail(false); return; }
  const p = state.pilots.get(s.id) ?? { id: s.id, p: s.p, last: s.pts?.at(-1) };
  const last = s.pts?.at(-1) ?? p.last;
  if (!last) { showDetail(false); return; }
  const btn = (label, fn, cls = '') => { const b = el('button', { type: 'button', textContent: label, className: cls }); b.addEventListener('click', fn); return b; };
  const back = btn(`‹ ${T.back}`, unselect, 'back');
  back.title = T.backTip;
  const st = p.p?.status, kids = [btn('✕', unselect, 'icon close'), back, el('h2', { textContent: nameOf(p) }), el('div', { className: 'muted', textContent: wingOf(p) })];
  if (st) kids.push(el('div', { className: `state ${st.state}`, textContent: T[st.state].replace('{h}', hhmm(st.t)) }));
  else {
    // posé : vu sur sa trace, ou dit par son logiciel (au sol, à pied ou en voiture)
    const age = nowS() - last[0], kind = kindOf(p), up = s.t1 && (last[0] - s.t1 > FLYING_S || kind !== 'air');
    const txt = !p.flight && !s.t1 ? T.ground : up ? T.landed.replace('{t}', span(nowS() - s.t1)) : age <= FLYING_S ? T.flying : T.lost.replace('{t}', span(age));
    kids.push(el('div', { className: 'state', textContent: kind === 'car' ? `${txt} · ${T.car}` : txt }));
  }
  const fig = (v, k) => el('div', {}, el('b', { textContent: v }), el('span', { textContent: k }));
  const fp = flightPts(s), dur = fp.length > 1 ? fp[fp.length - 1][0] - fp[0][0] : 0;
  kids.push(el('div', { className: 'figs' },
    fig(last[3] != null ? `${last[3]} m` : '—', T.alt),
    fig(last[6] != null ? `${last[6] > 0 ? '+' : ''}${num(last[6])}` : '—', T.vz),
    fig(last[4] != null ? `${Math.round(last[4] * 3.6)}` : '—', `${T.spd} km/h`),
    fig(dur ? span(dur) : '—', T.dur)));
  const sc = s.score;
  if (!s.pts) kids.push(el('p', { className: 'muted', textContent: T.loading }));
  else if (sc) {
    const dl = el('dl');
    const row = (k, v) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    const L = leagueScore(sc, state.league);
    const counted = x => (x ? `${km(x.d)} · ${num(x.pts)} ${T.pts}${x.kind === 'free' ? '' : ` (×${num(x.coef)})`}` : '—');
    row(T.free, counted(L.free));
    row(T.closedFlat, counted(L.flat));
    row(T.closedFai, counted(L.fai));
    row(T.total.replace('{r}', T.leagues[state.league]), `${num(L.best.pts)} ${T.pts}`);
    dl.lastChild.classList.add('total'); dl.lastChild.previousSibling.classList.add('total');
    row(T.openFaiIf, sc.open.fai ? km(sc.open.fai.P) : '—');
    row(T.openFlatIf, sc.open.flat ? km(sc.open.flat.P) : '—');
    kids.push(dl);
    const tri = sc.open[s.target];
    if (sc.open.flat) {
      kids.push(el('label', { textContent: T.target }), el('div', { className: 'seg' },
        btn(T.openFai, () => { s.target = 'fai'; drawSel(); renderDetail(); }, s.target === 'fai' ? 'on' : ''),
        btn(T.openFlat, () => { s.target = 'flat'; drawSel(); renderDetail(); }, s.target === 'flat' ? 'on' : '')));
      const P = tri ? `${(s.target === 'fai' ? T.openFai : T.openFlat).toLowerCase().replace('fai', 'FAI')} ${fr ? 'de ' : ''}${km(tri.P)}` : '';
      const lines = tri ? LEAGUES[state.league].tiers.map(t => {
        const z = closingZone(fp, tri, t.rule), k = num(t[s.target]);
        return el('div', { textContent: (z.toGo > 0 ? T.togo.replace('{d}', km(z.toGo)) : T.closed).replace('{k}', k).replace('{g}', T.gaps[t.rule]) });
      }) : [];
      kids.push(el('div', { className: 'togo' }, tri ? el('b', { textContent: T.close.replace('{P}', P) }) : T.noTri, ...lines));
    } else kids.push(el('p', { className: 'muted', textContent: T.noTri }));
  }
  kids.push(el('div', { className: 'actions' },
    btn(T.center, () => fitTo((s.pts ?? [last]).map(f => [f[2], f[1]]))),
    btn(state.follow ? T.unfollow : T.follow, () => { state.follow = !state.follow; if (state.follow) map.easeTo({ center: [last[2], last[1]], duration: 600 }); renderDetail(); }, state.follow ? 'on' : '')));
  // le défilement de la fiche reste où il était à chaque rafraîchissement (toutes les 5 s)
  const top = box.scrollTop;
  box.replaceChildren(...kids);
  showDetail(true);
  box.scrollTop = top;
}

/** sur téléphone la fiche prend la place de la liste en bas de l'écran (CSS body.picked) : la carte change de taille */
function showDetail(on) {
  $('detail').hidden = !on;
  if (document.body.classList.contains('picked') === on) return;
  document.body.classList.toggle('picked', on);
  setTimeout(() => map.resize(), 50);
}

/** push : la fiche ouverte prend une entrée de l'historique, le retour du navigateur ou du téléphone la ferme */
function select(id, fit, push = true) {
  id = String(id);
  if (state.sel?.id === id) { if (fit) fitSel(); return; }
  const had = !!state.sel;
  if (state.sel) clearTimeout(state.sel.timer);
  state.sel = { id, pts: null, t0: null, t1: null, score: null, timer: 0, fit };
  state.follow = false;
  const u = new URL(location.href);
  u.searchParams.set('p', id);
  if (push && !had && !history.state?.opnSel) history.pushState({ opnSel: true }, '', u);
  else history.replaceState(history.state, '', u);
  const p = state.pilots.get(id);
  if (fit && p) map.easeTo({ center: [p.last[2], p.last[1]], duration: 600 });
  redraw();
  void loadSel().then(() => { if (state.sel?.id === id && state.sel.fit) { state.sel.fit = false; fitSel(); } });
}
function fitSel() { const s = state.sel; if (s?.pts?.length) fitTo(s.pts.map(f => [f[2], f[1]])); }

/** ✕ ou « ‹ Pilotes » : revient en arrière dans l'historique si la fiche y a pris une entrée (popstate la ferme) */
function unselect() {
  if (history.state?.opnSel) { history.back(); return; }
  closeSel();
  const u = new URL(location.href);
  u.searchParams.delete('p');
  history.replaceState(null, '', u);
}

function closeSel() {
  if (state.sel) clearTimeout(state.sel.timer);
  state.sel = null; state.follow = false;
  drawSel(); redraw();
}

window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('p');
  if (!id) { if (state.sel) closeSel(); } else if (state.pilots.has(id)) select(id, true, false);
});

setFold(false);
void loadList();
// l'âge des positions bouge même sans données nouvelles
setInterval(() => { renderList(); renderDetail(); }, 15000);
