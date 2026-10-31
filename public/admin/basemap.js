// Le fond de carte « Terrain » de WS Nav pour le back-office : teinte d'altitude, végétation, routes blanches, ombrage à
// quatre lumières, courbes de niveau, sommets, et le relief en 3D avec son ciel. OpenMapTiles (OpenFreeMap) et les
// tuiles d'altitude Mapzen, sans clé. Le relief sert une seule fois ses tuiles à la teinte, à l'ombrage et aux courbes.
'use strict';

const OMT = 'https://tiles.openfreemap.org/planet';
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_CREDIT = 'Relief <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen Terrain Tiles</a> (AWS Open Data)';
/** relief exagéré comme dans l'appli */
const EXAGGERATION = 1.5;
/** inclinaison de la vue 3D, et la plus forte permise */
const PITCH_3D = 62, MAX_PITCH = 75;

const demSource = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: 12, worker: true, cacheSize: 120, timeoutMs: 15000 });
demSource.setupMaplibre(maplibregl);

const contourTiles = demSource.contourProtocolUrl({
  multiplier: 1, contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level', extent: 4096, buffer: 1, overzoom: 1,
  // [mineure, maîtresse] en mètres selon le zoom
  thresholds: { 10: [200, 1000], 11: [100, 500], 12: [100, 500], 13: [50, 250], 14: [20, 100] },
});

function baseStyle() {
  const z = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
  const cls = (...c) => ['match', ['get', 'class'], c, true, false];
  const major = cls('motorway', 'trunk'), mid = cls('primary', 'secondary'), minor = cls('tertiary', 'minor');
  const omt = (id, type, layer, rest) => ({ id, type, source: 'openmaptiles', 'source-layer': layer, ...rest });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  const name = ['coalesce', ['get', 'name:fr'], ['get', 'name']];
  const halo = 'rgba(255,255,255,0.9)', bold = ['Noto Sans Bold'], regular = ['Noto Sans Regular'];
  const contourColor = { minor: 'rgba(110,80,40,0.35)', major: 'rgba(110,80,40,0.65)' };
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      openmaptiles: { type: 'vector', url: OMT, attribution: 'OpenFreeMap © OpenMapTiles · données <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>' },
      dem: { type: 'raster-dem', tiles: [demSource.sharedDemProtocolUrl], encoding: 'terrarium', tileSize: 256, maxzoom: 12, attribution: DEM_CREDIT },
      'dem-3d': { type: 'raster-dem', tiles: [demSource.sharedDemProtocolUrl], encoding: 'terrarium', tileSize: 256, maxzoom: 12 },
      contours: { type: 'vector', tiles: [contourTiles], maxzoom: 15 },
    },
    // brume et ciel de la vue 3D : ils donnent la profondeur aux crêtes lointaines
    sky: {
      'sky-color': '#8EC2EE', 'horizon-color': '#E4EEF6', 'fog-color': '#DCE6EE', 'sky-horizon-blend': 0.55, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.8,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 13, 0],
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#E4E3CF' } },
      // vallées vertes, pentes beiges, roche grise, sommets blancs
      { id: 'hypso', type: 'color-relief', source: 'dem', paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#A9C788', 700, '#BED39A', 1300, '#D8D6AC', 1900, '#E0C9A4', 2400, '#CDBCA9', 2900, '#E8E5E1', 3300, '#FFFFFF'],
        'color-relief-opacity': 1,
      } },
      omt('grass', 'fill', 'landcover', { filter: cls('grass', 'farmland'), paint: { 'fill-color': '#C9D7A6', 'fill-opacity': 0.35 } }),
      omt('wood', 'fill', 'landcover', { filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': '#93B072', 'fill-opacity': 0.62 } }),
      omt('urban', 'fill', 'landuse', { filter: cls('residential', 'commercial', 'industrial'), paint: { 'fill-color': '#D6D2C8', 'fill-opacity': 0.6 } }),
      omt('glacier', 'fill', 'landcover', { filter: ['==', ['get', 'subclass'], 'glacier'], paint: { 'fill-color': '#FFFFFF', 'fill-opacity': 0.75 } }),
      // plusieurs lumières liées à l'écran : le relief ne paraît jamais inversé, quelle que soit l'orientation
      { id: 'relief', type: 'hillshade', source: 'dem', paint: {
        'hillshade-method': 'multidirectional',
        'hillshade-illumination-anchor': 'viewport',
        'hillshade-illumination-direction': [270, 315, 0, 225],
        'hillshade-illumination-altitude': [24, 34, 24, 40],
        'hillshade-highlight-color': ['rgba(255,255,255,0.55)', 'rgba(255,255,255,0.80)', 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0.25)'],
        'hillshade-shadow-color': ['rgba(38,32,24,0.68)', 'rgba(38,32,24,0.92)', 'rgba(38,32,24,0.68)', 'rgba(38,32,24,0.28)'],
        'hillshade-exaggeration': 1,
      } },
      omt('water', 'fill', 'water', { paint: { 'fill-color': '#A3C2DA' } }),
      omt('waterway', 'line', 'waterway', { paint: { 'line-color': '#7FA7C9', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 2] } }),
      omt('boundary', 'line', 'boundary', { filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': '#8A7E9C', 'line-width': 1.2, 'line-dasharray': [3, 2] } }),
      omt('buildings', 'fill', 'building', { minzoom: 13, paint: { 'fill-color': '#C2BAAE', 'fill-opacity': 0.8 } }),
      omt('paths', 'line', 'transportation', { minzoom: 13, filter: cls('track', 'path'), paint: { 'line-color': '#7A6A55', 'line-width': 0.8, 'line-dasharray': [2, 1.5] } }),
      omt('rail', 'line', 'transportation', { minzoom: 10, filter: cls('rail'), paint: { 'line-color': '#6E6E6E', 'line-width': 1, 'line-dasharray': [4, 2] } }),
      omt('roads-minor', 'line', 'transportation', { minzoom: 12, filter: minor, layout: round, paint: { 'line-color': '#FFFFFF', 'line-width': z(12, 0.8, 16, 4) } }),
      omt('roads-mid-case', 'line', 'transportation', { filter: mid, layout: round, paint: { 'line-color': '#6F6A62', 'line-width': z(7, 0.5, 10, 1.3, 14, 4.5, 16, 8) } }),
      omt('roads-major-case', 'line', 'transportation', { filter: major, layout: round, paint: { 'line-color': '#6F6A62', 'line-width': z(6, 0.8, 10, 2, 14, 6.5, 16, 11) } }),
      omt('roads-mid', 'line', 'transportation', { minzoom: 9.5, filter: mid, layout: round, paint: { 'line-color': '#FFFFFF', 'line-width': z(10, 0.4, 14, 3, 16, 6) } }),
      omt('roads-major', 'line', 'transportation', { minzoom: 9.5, filter: major, layout: round, paint: { 'line-color': '#F5E2B8', 'line-width': z(10, 0.8, 14, 4.5, 16, 8.5) } }),
      omt('lifts', 'line', 'transportation', { filter: cls('aerialway', 'cable_car', 'gondola'), paint: { 'line-color': '#D11F2E', 'line-width': 1.6, 'line-dasharray': [2, 1] } }),
      { id: 'contour-minor', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['==', ['get', 'level'], 0], paint: { 'line-color': contourColor.minor, 'line-width': 0.7 } },
      { id: 'contour-major', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0], paint: { 'line-color': contourColor.major, 'line-width': 1.3 } },
      { id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0],
        layout: { 'symbol-placement': 'line', 'text-size': 10, 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-font': regular },
        paint: { 'text-color': '#6E5028', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.2 } },
      // peu de villages : les sommets restent au-dessus
      omt('places', 'symbol', 'place', {
        filter: ['step', ['zoom'], ['==', ['get', 'class'], 'city'], 9, cls('city', 'town'), 12.5, cls('city', 'town', 'village')],
        layout: {
          'text-field': name, 'text-font': ['match', ['get', 'class'], 'village', ['literal', regular], ['literal', bold]],
          'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 12, 10.5], 'text-padding': 12, 'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: { 'text-color': '#2E2E2E', 'text-halo-color': halo, 'text-halo-width': 1.4 },
      }),
      omt('water-names', 'symbol', 'water_name', {
        layout: { 'text-field': name, 'text-font': ['literal', ['Noto Sans Italic']], 'text-size': 12 },
        paint: { 'text-color': '#3D6A8F', 'text-halo-color': halo, 'text-halo-width': 1.2 },
      }),
      omt('peaks', 'symbol', 'mountain_peak', {
        minzoom: 9, filter: ['has', 'ele'],
        layout: { 'text-field': ['concat', name, '\n', ['to-string', ['get', 'ele']], ' m'], 'text-font': bold, 'text-size': 11.5, 'symbol-sort-key': ['-', 0, ['to-number', ['get', 'ele'], 0]] },
        paint: { 'text-color': '#2A1E12', 'text-halo-color': halo, 'text-halo-width': 1.6 },
      }),
    ],
  };
}

/** le bouton 2D / 3D de la carte ; le choix reste dans ce navigateur */
class View3d {
  onAdd(map) {
    this.map = map;
    this.box = document.createElement('div');
    this.box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'view3d';
    this.btn.addEventListener('click', () => this.set(!this.on));
    this.box.append(this.btn);
    let saved = null;
    try { saved = localStorage.getItem('opn.view3d'); } catch { /* stockage fermé */ }
    const start = () => this.set(saved !== '0', true);
    if (map.loaded()) start(); else map.once('load', start);
    return this.box;
  }
  onRemove() { this.box.remove(); }
  set(on, first = false) {
    this.on = on;
    this.onChange?.(on);
    this.btn.textContent = on ? '2D' : '3D';
    this.btn.title = on ? 'Revenir à la carte à plat' : 'Relief en 3D';
    this.map.setTerrain(on ? { source: 'dem-3d', exaggeration: EXAGGERATION } : null);
    // au chargement, une vue déjà inclinée (adresse de la page) reste comme elle est
    if (!first || (on && !this.map.getPitch())) this.map.easeTo({ pitch: on ? PITCH_3D : 0, duration: first ? 0 : 700 });
    try { localStorage.setItem('opn.view3d', on ? '1' : '0'); } catch { /* stockage fermé */ }
  }
}
