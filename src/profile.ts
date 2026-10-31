// Ce qu'un pilote montre aux autres : prénom, nom, voile, type d'aéronef, logiciel, ses identifiants sur les autres
// réseaux (une même personne ne fait qu'un chez ceux qui reçoivent plusieurs réseaux), et son état après le vol.

export const TYPES = ['paraglider', 'hangglider', 'sailplane', 'paramotor', 'other'] as const;
export type AircraftType = (typeof TYPES)[number];

export interface Profile {
  first: string;
  last: string;
  /** voile (aile, planeur) utilisée, texte libre : « Ozone Zeno 2 » */
  wing: string;
  type: AircraftType;
  /** logiciel qui envoie : « WS Nav 1.4 », « XCSoar 7.43 » */
  app: string;
  /** identifiants du pilote sur les autres réseaux : { flarm: 'DD1234', puretrack: '…' } */
  ids?: Record<string, string>;
  /** son état déclaré, absent en vol : gardé par le serveur à part du profil */
  status?: PilotStatus;
}

/** ok : posé OK ; sos : posé pas OK, besoin d'aide */
export type PilotState = 'ok' | 'sos';
export interface PilotStatus { state: PilotState; t: number; lat: number | null; lon: number | null; alt: number | null }

const MAX_IDS = 10;
/** { réseau: identifiant } nettoyé ; un identifiant vide retire le réseau */
export function cleanIds(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim().toLowerCase(), id = clean(v, 60);
    if (/^[a-z0-9_-]{2,20}$/.test(key) && id && Object.keys(out).length < MAX_IDS) out[key] = id;
  }
  return out;
}
const idsText = (p: Profile) => JSON.stringify(p.ids ?? {});

export const EMPTY_PROFILE: Profile = { first: '', last: '', wing: '', type: 'paraglider', app: '' };

/** texte nettoyé : sans caractères de contrôle, espaces resserrés, longueur bornée */
export const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** les champs reçus remplacent ceux du profil ; un champ absent garde sa valeur, une chaîne vide l'efface */
export function mergeProfile(base: Profile, raw: unknown, app?: unknown): Profile {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (keys: string[], max: number, cur: string) => {
    for (const k of keys) if (typeof o[k] === 'string') return clean(o[k], max);
    return cur;
  };
  const t = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  const out: Profile = {
    first: pick(['first', 'firstName', 'firstname', 'prenom'], 40, base.first),
    last: pick(['last', 'lastName', 'lastname', 'nom'], 60, base.last),
    wing: pick(['wing', 'glider', 'voile'], 60, base.wing),
    type: (TYPES as readonly string[]).includes(t) ? (t as AircraftType) : base.type,
    app: typeof app === 'string' && app.trim() ? clean(app, 40) : base.app,
  };
  const ids = o.ids !== undefined ? cleanIds(o.ids) : base.ids;
  if (ids && Object.keys(ids).length) out.ids = ids;
  // un nom complet seul (« Alex Pereira ») : le premier mot fait le prénom
  if (typeof o.name === 'string' && typeof o.first !== 'string' && typeof o.firstName !== 'string' && typeof o.last !== 'string' && typeof o.lastName !== 'string') {
    const name = clean(o.name, 100), sp = name.indexOf(' ');
    out.first = sp > 0 ? name.slice(0, sp) : name;
    out.last = sp > 0 ? name.slice(sp + 1) : '';
  }
  return out;
}

export const sameProfile = (a: Profile, b: Profile) => a.first === b.first && a.last === b.last && a.wing === b.wing && a.type === b.type && a.app === b.app && idsText(a) === idsText(b);

/** vehicle type LiveTrack24 → le nôtre */
export function lt24Type(v: unknown): AircraftType {
  switch (Number(v)) {
    case 1: return 'paraglider';
    case 2: case 4: return 'hangglider';
    case 8: return 'sailplane';
    case 16: return 'paramotor';
    default: return 'other';
  }
}
