// MapLibre 6.14, le moteur de carte de l'appli WS Nav, servi par le serveur lui-même (public/vendor) : avec la version 5,
// la carte en 3D clignotait juste après un déplacement sur Chrome pour PC (vu le 04/11/2026, jamais sur la 2D).
// MapLibre 6 n'existe qu'en module ES : ce module le pose en global (window.maplibregl) puis charge, dans l'ordre, les
// scripts nommés par data-load de sa balise (#boot) ; un nom qui finit par « ! » se charge en module.
import * as maplibregl from '/vendor/maplibre-gl-6.14.0/maplibre-gl.js';

// même origine : MapLibre ouvre son worker en module directement
maplibregl.setWorkerUrl('/vendor/maplibre-gl-6.14.0/maplibre-gl-worker.js');
window.maplibregl = maplibregl;

const load = src => new Promise((ok, ko) => {
  const s = document.createElement('script');
  if (src.endsWith('!')) { s.type = 'module'; src = src.slice(0, -1); }
  s.src = src;
  s.async = false;
  s.onload = ok;
  s.onerror = () => ko(new Error(`script ${src}`));
  document.body.append(s);
});
for (const src of document.getElementById('boot').dataset.load.split(/\s+/).filter(Boolean)) await load(src);
