// Compatibilité LiveTrack24 (protocole « leolive ») : XCSoar, LK8000 et les autres logiciels qui savent envoyer à un
// serveur LiveTrack24 dont l'adresse se règle. Requêtes GET, réponses en texte.
//
//   /client.php?op=login&user=U&pass=P                         → identifiant numérique du pilote, « 0 » si refusé
//   /track.php?leolive=2&sid=S&pid=1&client=C&v=V&user=U&pass=P&phone=…&gps=…&trk1=…&vtype=T&vname=G   début → « OK »
//   /track.php?leolive=4&sid=S&pid=N&lat=…&lon=…&alt=…&sog=…&cog=…&tm=…                               point → « OK »
//   /track.php?leolive=3&sid=S&pid=N&prid=0                                                             fin   → « OK »
//
// Le compte : user + pass, réservé au premier usage (comme un appareil, mot de passe gardé en scrypt). Sans user, la
// session (sid) fait un pilote anonyme. sog en km/h, alt en m, tm en secondes Unix.

import { mergeProfile, EMPTY_PROFILE, lt24Type, clean } from './profile.ts';
import { HttpError, type Service } from './service.ts';
import type { PilotRow } from './store.ts';

const deviceOf = (user: string) => 'lt24:' + user.toLowerCase().replace(/[^a-z0-9_.@-]/g, '_');
const SID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function account(svc: Service, user: string, pass: string, profile = EMPTY_PROFILE): PilotRow | null {
  try { return svc.authDevice({ device: deviceOf(user), secret: pass }, { slow: true, profile }); } catch (e) {
    if (e instanceof HttpError) return null;
    throw e;
  }
}

/** réponse texte d'une requête LiveTrack24 */
export function handleLt24(svc: Service, path: string, q: URLSearchParams): string {
  const get = (k: string) => q.get(k) ?? '';
  if (path.endsWith('/client.php')) {
    if (get('op') !== 'login') return '0';
    const user = clean(get('user'), 60), pass = get('pass');
    if (user.length < 2 || !pass) return '0';
    const p = account(svc, user, pass, mergeProfile(EMPTY_PROFILE, { first: user }));
    return p ? String(p.pid) : '0';
  }
  const sid = get('sid');
  if (!SID_RE.test(sid)) return 'NOK';
  const leolive = get('leolive');
  const nowS = Math.floor(svc.now());
  if (leolive === '2') {
    const user = clean(get('user'), 60), pass = get('pass');
    const info = { wing: clean(get('vname'), 60), type: lt24Type(get('vtype')) };
    const app = [clean(get('client'), 30), clean(get('v'), 10)].filter(Boolean).join(' ');
    let p: PilotRow | null;
    if (user.length >= 2 && user.toLowerCase() !== 'guest') {
      p = account(svc, user, pass, mergeProfile(EMPTY_PROFILE, { first: user, ...info }, app));
      if (!p) return 'NOK';
      // le nom choisi sur le serveur (back-office, autre logiciel) reste ; voile et type suivent le logiciel
      svc.updateProfile(p, { ...info, ...(p.first || p.last ? {} : { first: user }) }, app);
    } else {
      p = anonymous(svc, sid);
      svc.updateProfile(p, info, app);
    }
    svc.store.lt24Put(sid, p.pid, nowS);
    return 'OK';
  }
  if (leolive === '4') {
    const pid = svc.store.lt24Get(sid);
    const p = pid !== undefined ? svc.store.pilotById(pid) : anonymous(svc, sid);
    if (!p || p.blocked) return 'NOK';
    if (pid === undefined) svc.store.lt24Put(sid, p.pid, nowS);
    const sog = Number(get('sog'));
    svc.ingestFor(p, [{
      t: get('tm') || nowS, lat: get('lat'), lon: get('lon'), alt: get('alt'),
      spd: Number.isFinite(sog) && get('sog') !== '' ? sog / 3.6 : null, crs: get('cog'),
    }]);
    return 'OK';
  }
  if (leolive === '3') return 'OK';
  return 'NOK';
}

/** pilote sans compte : un par session */
function anonymous(svc: Service, sid: string): PilotRow {
  const device = 'lt24sid:' + sid;
  return svc.store.pilotByDevice(device) ?? svc.authDevice({ device, secret: 'lt24-anonymous-session' });
}
