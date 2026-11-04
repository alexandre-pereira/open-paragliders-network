// Le fond de carte « Naturel » de WS Nav pour les cartes du serveur (back-office, carte publique, lien de suivi) :
// couleurs vues d'avion (forêts sombres, alpages, éboulis, neige, lacs profonds), ombrage « Lisible » à quatre lumières, courbes de niveau, sommets, et le relief en
// 3D avec son ciel. OpenMapTiles (OpenFreeMap) et les tuiles d'altitude Mapzen, sans clé. Le relief sert une seule fois
// ses tuiles à la teinte, à l'ombrage et aux courbes.
'use strict';

const OMT = 'https://tiles.openfreemap.org/planet';
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_CREDIT = 'Relief <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen Terrain Tiles</a> (AWS Open Data)';
/** relief à sa vraie hauteur (demande du 04/11 : plus d’exagération) ; les pilotes en 3D suivent la même échelle */
const EXAGGERATION = 1;
/** inclinaison de la vue 3D, et la plus forte permise */
const PITCH_3D = 62, MAX_PITCH = 75;

const demSource = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: 12, worker: true, cacheSize: 120, timeoutMs: 15000 });
demSource.setupMaplibre(maplibregl);

const contourTiles = demSource.contourProtocolUrl({
  multiplier: 1, contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level', extent: 4096, buffer: 1, overzoom: 1,
  // [mineure, maîtresse] en mètres selon le zoom
  thresholds: { 10: [200, 1000], 11: [100, 500], 12: [100, 500], 13: [50, 250], 14: [20, 100] },
});

// l'ombrage « Lisible » du fond « Naturel » de WS Nav : quatre lumières basses fixes, liées à l'écran. Pas d'ombre du
// vrai soleil : rasante le soir et nulle la nuit, elle assombrit toute la carte
const RELIEF = {
  altitude: [18, 28, 18, 34],
  highlight: ['rgba(255,243,215,0.62)', 'rgba(255,243,215,0.88)', 'rgba(255,243,215,0.62)', 'rgba(255,243,215,0.30)'],
  shadow: ['rgba(14,22,36,0.80)', 'rgba(14,22,36,1)', 'rgba(14,22,36,0.80)', 'rgba(14,22,36,0.34)'],
};
function baseStyle() {
  const z = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
  const cls = (...c) => ['match', ['get', 'class'], c, true, false];
  const major = cls('motorway', 'trunk'), mid = cls('primary', 'secondary'), minor = cls('tertiary', 'minor');
  const omt = (id, type, layer, rest) => ({ id, type, source: 'openmaptiles', 'source-layer': layer, ...rest });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  const name = ['coalesce', ['get', 'name:fr'], ['get', 'name']];
  const halo = 'rgba(255,255,255,0.9)', bold = ['Noto Sans Bold'], regular = ['Noto Sans Regular'];
  const contourColor = { minor: 'rgba(60,50,35,0.22)', major: 'rgba(60,50,35,0.45)' };
  const wood = cls('wood'), soft = z(9, 2, 12, 5, 14, 8, 16, 12);
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
      { id: 'bg', type: 'background', paint: { 'background-color': '#93A566' } },
      // prés et champs en bas, alpages olive, pierre grise nue au-dessus de 2300 m, puis la neige
      { id: 'hypso', type: 'color-relief', source: 'dem', paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#A2AD70', 500, '#93A566', 1000, '#86995B', 1500, '#8C9A5F', 1900, '#9D9B6D',
          2150, '#A29C88', 2400, '#A3A19C', 2900, '#B9B8B6', 3200, '#D8D9DA', 3500, '#F1F3F5'],
        'color-relief-opacity': 1,
      } },
      omt('farmland', 'fill', 'landcover', { filter: cls('farmland'), paint: { 'fill-color': '#B9B678', 'fill-opacity': 0.5 } }),
      omt('grass', 'fill', 'landcover', { filter: cls('grass'), paint: { 'fill-color': '#8DA35C', 'fill-opacity': 0.4 } }),
      omt('wetland', 'fill', 'landcover', { filter: cls('wetland'), paint: { 'fill-color': '#6F8B60', 'fill-opacity': 0.45 } }),
      omt('sand', 'fill', 'landcover', { filter: cls('sand'), paint: { 'fill-color': '#D8CCA6', 'fill-opacity': 0.65 } }),
      omt('rock', 'fill', 'landcover', { filter: cls('rock'), paint: { 'fill-color': '#AEADA9', 'fill-opacity': 0.9 } }),
      // forêt sombre au bord adouci : une ligne floue de même couleur sur le contour, comme une lisière vue d'avion
      omt('wood', 'fill', 'landcover', { filter: wood, paint: { 'fill-color': '#46653A', 'fill-opacity': 0.66 } }),
      omt('wood-soft', 'line', 'landcover', { filter: wood, layout: { 'line-join': 'round' }, paint: { 'line-color': '#46653A', 'line-opacity': 0.4, 'line-width': soft, 'line-blur': soft } }),
      // villages en beige clair, l'industrie, les voies ferrées et les carrières en gris à part
      omt('urban', 'fill', 'landuse', { filter: cls('residential', 'commercial', 'retail'), paint: { 'fill-color': '#E0C9A0', 'fill-opacity': 0.88 } }),
      omt('industry', 'fill', 'landuse', { filter: cls('industrial', 'railway', 'garages', 'quarry'), paint: { 'fill-color': '#C6C1B4', 'fill-opacity': 0.92 } }),
      omt('glacier', 'fill', 'landcover', { filter: ['==', ['get', 'subclass'], 'glacier'], paint: { 'fill-color': '#EEF2F6', 'fill-opacity': 0.92 } }),
      // plusieurs lumières liées à l'écran : le relief ne paraît jamais inversé, quelle que soit l'orientation
      { id: 'relief', type: 'hillshade', source: 'dem', paint: {
        'hillshade-method': 'multidirectional',
        'hillshade-illumination-anchor': 'viewport',
        'hillshade-illumination-direction': [270, 315, 0, 225],
        'hillshade-illumination-altitude': RELIEF.altitude,
        'hillshade-highlight-color': RELIEF.highlight,
        'hillshade-shadow-color': RELIEF.shadow,
        'hillshade-exaggeration': 1,
      } },
      omt('water', 'fill', 'water', { paint: { 'fill-color': '#41708C' } }),
      omt('water-edge', 'line', 'water', { paint: { 'line-color': 'rgba(40,70,90,0.6)', 'line-width': 0.7 } }),
      omt('waterway', 'line', 'waterway', { paint: { 'line-color': '#57829E', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 2] } }),
      omt('boundary', 'line', 'boundary', { filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': '#8A7E9C', 'line-width': 1.2, 'line-dasharray': [3, 2] } }),
      omt('buildings', 'fill', 'building', { minzoom: 13, paint: { 'fill-color': '#8C7566', 'fill-opacity': 0.95, 'fill-outline-color': '#5A483C' } }),
      omt('paths', 'line', 'transportation', { minzoom: 13, filter: cls('track', 'path'), paint: { 'line-color': '#6F6350', 'line-width': 0.8, 'line-dasharray': [2, 1.5] } }),
      omt('rail', 'line', 'transportation', { minzoom: 10, filter: cls('rail'), paint: { 'line-color': '#5F5B55', 'line-width': 1, 'line-dasharray': [4, 2] } }),
      omt('roads-minor', 'line', 'transportation', { minzoom: 12, filter: minor, layout: round, paint: { 'line-color': '#D6D1C6', 'line-width': z(12, 0.8, 16, 4) } }),
      omt('roads-mid-case', 'line', 'transportation', { filter: mid, layout: round, paint: { 'line-color': '#7D786E', 'line-opacity': 0.55, 'line-width': z(7, 0.5, 10, 1.3, 14, 4.5, 16, 8) } }),
      omt('roads-major-case', 'line', 'transportation', { filter: major, layout: round, paint: { 'line-color': '#7D786E', 'line-opacity': 0.55, 'line-width': z(6, 0.8, 10, 2, 14, 6.5, 16, 11) } }),
      omt('roads-mid', 'line', 'transportation', { minzoom: 9.5, filter: mid, layout: round, paint: { 'line-color': '#E2DDD2', 'line-width': z(10, 0.4, 14, 3, 16, 6) } }),
      omt('roads-major', 'line', 'transportation', { minzoom: 9.5, filter: major, layout: round, paint: { 'line-color': '#ECE6D8', 'line-width': z(10, 0.8, 14, 4.5, 16, 8.5) } }),
      omt('lifts', 'line', 'transportation', { filter: cls('aerialway', 'cable_car', 'gondola'), paint: { 'line-color': '#D11F2E', 'line-width': 1.6, 'line-dasharray': [2, 1] } }),
      { id: 'contour-minor', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['==', ['get', 'level'], 0], paint: { 'line-color': contourColor.minor, 'line-width': 0.6 } },
      { id: 'contour-major', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0], paint: { 'line-color': contourColor.major, 'line-width': 1.1 } },
      { id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0],
        layout: { 'symbol-placement': 'line', 'text-size': 10, 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-font': regular },
        paint: { 'text-color': '#3F3526', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.2 } },
      // peu de villages : les sommets restent au-dessus
      omt('places', 'symbol', 'place', {
        filter: ['step', ['zoom'], ['==', ['get', 'class'], 'city'], 9, cls('city', 'town'), 12.5, cls('city', 'town', 'village')],
        layout: {
          'text-field': name, 'text-font': ['match', ['get', 'class'], 'village', ['literal', regular], ['literal', bold]],
          'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 12, 10.5], 'text-padding': 12, 'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: { 'text-color': '#262626', 'text-halo-color': halo, 'text-halo-width': 1.4 },
      }),
      omt('water-names', 'symbol', 'water_name', {
        layout: { 'text-field': name, 'text-font': ['literal', ['Noto Sans Italic']], 'text-size': 12 },
        paint: { 'text-color': '#2E5670', 'text-halo-color': halo, 'text-halo-width': 1.2 },
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
