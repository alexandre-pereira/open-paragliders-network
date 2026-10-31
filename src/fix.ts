// Un point de trace (fix), sa validation et son format sur le réseau.
//
// Sur le réseau, un point est un tableau compact : [t, lat, lon, alt, spd, crs, vz]
//   t    heure du fix, secondes Unix (UTC) — l'heure GNSS de préférence, pas l'heure d'envoi
//   lat  latitude WGS84 (°), lon longitude (°)
//   alt  altitude GPS au-dessus du niveau de la mer (m) ou null
//   spd  vitesse sol (m/s) ou null, crs route vraie (°) ou null, vz vitesse verticale (m/s) ou null
// Un objet est accepté aussi : { t|ts|time, lat, lon|lng, alt, spd|speed, crs|course|track, vz|vspeed|vario }.

export interface Fix {
  /** numéro d'ordre d'arrivée sur le serveur, unique et croissant (curseur des abonnés) */
  seq: number;
  pid: number;
  ts: number;
  lat: number;
  lon: number;
  alt: number | null;
  spd: number | null;
  crs: number | null;
  vz: number | null;
  /** heure de réception par le serveur (s) */
  rx: number;
}

export type WireFix = [number, number, number, number | null, number | null, number | null, number | null];

/** un point tel qu'il arrive, validé, avant d'avoir son numéro */
export type NewFix = Omit<Fix, 'seq' | 'pid' | 'rx'>;

/** tolérance sur une horloge de téléphone en avance (s) */
export const FUTURE_S = 120;

const n = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const x = Number(v); return Number.isFinite(x) ? x : null; }
  return null;
};
const inRange = (v: number | null, lo: number, hi: number) => (v !== null && v >= lo && v <= hi ? v : null);
const round = (v: number, d: number) => { const k = 10 ** d; return Math.round(v * k) / k; };

/**
 * point validé, null s'il est inutilisable : pas d'heure, heure hors de l'historique ou dans le futur, position
 * impossible (0,0 compris : un GPS sans fix). Une grandeur fausse (vitesse de 900 m/s…) devient null, le point reste.
 * Heure en millisecondes acceptée (convertie).
 */
export function parseFix(raw: unknown, nowS: number, oldestS: number): NewFix | null {
  let ts: number | null, lat: number | null, lon: number | null, alt: unknown, spd: unknown, crs: unknown, vz: unknown;
  if (Array.isArray(raw)) {
    [ts, lat, lon] = [n(raw[0]), n(raw[1]), n(raw[2])];
    [alt, spd, crs, vz] = [raw[3], raw[4], raw[5], raw[6]];
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    ts = n(o.t ?? o.ts ?? o.time);
    lat = n(o.lat);
    lon = n(o.lon ?? o.lng);
    alt = o.alt; spd = o.spd ?? o.speed; crs = o.crs ?? o.course ?? o.track; vz = o.vz ?? o.vspeed ?? o.vario;
  } else return null;
  if (ts === null || lat === null || lon === null) return null;
  if (ts > 1e11) ts /= 1000; // millisecondes
  ts = Math.round(ts);
  if (ts > nowS + FUTURE_S || ts < oldestS) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)) return null;
  const a = inRange(n(alt), -500, 15000), s = inRange(n(spd), 0, 200), v = inRange(n(vz), -60, 60);
  let c = n(crs);
  if (c !== null) c = ((c % 360) + 360) % 360;
  return {
    ts, lat: round(lat, 6), lon: round(lon, 6),
    alt: a === null ? null : round(a, 1), spd: s === null ? null : round(s, 2), crs: c === null ? null : round(c, 1), vz: v === null ? null : round(v, 2),
  };
}

/** format réseau : 5 décimales (1 m), altitude au mètre, vitesses au décimètre */
export const wire = (f: Fix | NewFix): WireFix => [
  f.ts, round(f.lat, 5), round(f.lon, 5), f.alt === null ? null : Math.round(f.alt),
  f.spd === null ? null : round(f.spd, 1), f.crs === null ? null : Math.round(f.crs) % 360, f.vz === null ? null : round(f.vz, 1),
];

/** [ouest, sud, est, nord] ; ouest > est : la boîte passe l'antiméridien */
export type BBox = [number, number, number, number];

export const inBox = (b: BBox | null, lat: number, lon: number) =>
  !b || (lat >= b[1] && lat <= b[3] && (b[0] <= b[2] ? lon >= b[0] && lon <= b[2] : lon >= b[0] || lon <= b[2]));

/** boîte autour d'un point (rayon en km) */
export function boxAround(lat: number, lon: number, km: number): BBox {
  const dLat = km / 111.32, cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180)), dLon = Math.min(180, km / (111.32 * cos));
  const w = lon - dLon, e = lon + dLon;
  return [w < -180 ? w + 360 : w, Math.max(-90, lat - dLat), e > 180 ? e - 360 : e, Math.min(90, lat + dLat)];
}

/** boîte lue dans une requête : bbox=[o,s,e,n] (tableau ou « o,s,e,n »), ou center [lat, lon] + radius (km) ; null = le monde */
export function parseArea(bbox: unknown, center?: unknown, radiusKm?: unknown): BBox | null | 'invalid' {
  if (bbox !== undefined && bbox !== null && bbox !== '') {
    const v = (typeof bbox === 'string' ? bbox.split(',') : Array.isArray(bbox) ? bbox : []).map(n);
    if (v.length !== 4 || v.some(x => x === null)) return 'invalid';
    const [w, s, e, no] = v as number[];
    if (Math.abs(s) > 90 || Math.abs(no) > 90 || s > no || Math.abs(w) > 180 || Math.abs(e) > 180) return 'invalid';
    return [w, s, e, no];
  }
  if (center !== undefined && center !== null && center !== '') {
    const c = (typeof center === 'string' ? center.split(',') : Array.isArray(center) ? center : []).map(n);
    const r = n(radiusKm) ?? 100;
    if (c.length !== 2 || c[0] === null || c[1] === null || Math.abs(c[0]) > 90 || Math.abs(c[1]) > 180 || !(r > 0)) return 'invalid';
    return boxAround(c[0], c[1], Math.min(r, 2000));
  }
  return null;
}
