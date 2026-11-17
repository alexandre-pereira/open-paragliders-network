// La barre des notifications d'un lien de suivi : être prévenu quand le pilote décolle, se pose, et surtout s'il dit
// « posé pas OK ». Tant qu'elles ne sont pas en marche (jamais demandées, refusées, coupées), la barre reste en haut de
// la fiche, bien visible, pour pouvoir les activer plus tard ; en marche, une ligne discrète avec « Couper ».
// Le navigateur s'abonne (Web Push, /sw.js) ; le serveur garde l'abonnement avec ce lien seulement.

const fr = /^fr/i.test(navigator.language);
const T = fr
  ? {
    ask: 'Être prévenu quand {n} décolle, atterrit, et surtout en cas de SOS', on: 'Notifications activées : décollage, atterrissage, SOS', enable: 'Activer les notifications', off: 'Couper',
    denied: 'Notifications bloquées : tu ne seras pas prévenu si {n} demande de l’aide.', deniedHow: 'Autorise-les pour ce site dans les réglages du navigateur (le cadenas ou ⓘ à gauche de l’adresse › Notifications › Autoriser), puis :', retry: 'Réessayer',
    ios: 'Pour être prévenu si {n} demande de l’aide : Partager › « Sur l’écran d’accueil », puis ouvre le suivi depuis l’écran d’accueil et active les notifications.',
    fail: 'Échec, réessaie dans un instant.', pilot: 'le pilote',
    how: 'Message chiffré, transmis par le service de notification de ton navigateur sans qu’il puisse le lire. Pas un service de secours : en cas de doute, appelle le 112.', privacy: 'Confidentialité',
  }
  : {
    ask: 'Get notified when {n} takes off, lands, and above all of any SOS', on: 'Notifications on: take-off, landing, SOS', enable: 'Turn on notifications', off: 'Turn off',
    denied: 'Notifications blocked: you will not be told if {n} asks for help.', deniedHow: 'Allow them for this site in the browser settings (the padlock or ⓘ left of the address › Notifications › Allow), then:', retry: 'Try again',
    ios: 'To be told if {n} asks for help: Share › “Add to Home Screen”, then open the tracking page from the Home Screen and turn notifications on.',
    fail: 'Failed, try again in a moment.', pilot: 'the pilot',
    how: 'Encrypted message, passed on by your browser’s push service, which cannot read it. Not a rescue service: if in doubt, call 112.', privacy: 'Privacy',
  };

const bar = document.getElementById('notif');
const token = location.pathname.split('/').filter(Boolean).pop() ?? '';
const api = '/api/v1/shared/' + encodeURIComponent(token) + '/push';
const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
/** checked : l'état réel est connu (sans ça, la barre « Activer » clignoterait le temps de le lire) */
let name = '', gone = false, on = false, busy = false, failed = false, checked = false, privacy = '';

const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) if (k != null) e.append(k); return e; };
const b64 = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const same = (a, b) => !!a && !!b && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === new Uint8Array(b)[i]);

async function post(body) {
  const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || String(r.status));
  return d;
}

/** l'abonnement du navigateur, à la clé du serveur (une autre clé : réabonné) */
async function subscription(create) {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/p/' });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub && !create) return null;
  const { key } = await (await fetch('/api/v1/push', { cache: 'no-store' })).json();
  const k = b64(key);
  if (sub && !same(sub.options?.applicationServerKey, k)) { await sub.unsubscribe(); sub = null; }
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k });
  return sub;
}

/** l'adresse de ce lien, pour que la notification l'ouvre : sous /k/<16 premiers caractères de son empreinte> */
async function remember() {
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    const k = [...h.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
    await (await caches.open('opn-links')).put('/k/' + k, new Response(location.pathname));
  } catch { /* la notification ouvrira la carte publique */ }
}

async function enable() {
  busy = true; failed = false; render();
  try {
    if (await Notification.requestPermission() === 'granted') {
      const sub = await subscription(true);
      await remember();
      on = (await post({ on: true, sub: sub.toJSON() })).on;
    }
  } catch { failed = true; }
  busy = false; render();
}

async function disable() {
  busy = true; render();
  try {
    const sub = await subscription(false);
    // l'abonnement du navigateur reste : il sert peut-être à d'autres pilotes suivis
    on = sub ? (await post({ on: false, endpoint: sub.endpoint })).on : false;
  } catch { failed = true; }
  busy = false; render();
}

/** au chargement et au retour sur la page (réglages changés entre-temps) : l'état réel, abonnement rafraîchi */
async function check() {
  if (!supported || gone || Notification.permission !== 'granted') { on = false; checked = true; render(); return; }
  try {
    const sub = await subscription(false);
    if (!sub) on = false;
    else {
      const d = await post({ endpoint: sub.endpoint });
      // abonné ici avant : renvoyé tel quel (clés changées, ou retiré par le serveur après un échec)
      on = d.on ? (await post({ on: true, sub: sub.toJSON() })).on : false;
      if (on) await remember();
    }
  } catch { /* hors ligne : l'état d'avant */ }
  checked = true;
  render();
}

function render() {
  const n = name || T.pilot;
  bar.className = '';
  if (gone || (!supported && !ios) || (supported && !checked)) { bar.hidden = true; return; }
  bar.hidden = false;
  if (!supported || (ios && !standalone)) {
    bar.className = 'warn';
    bar.replaceChildren(el('span', { className: 'bell', textContent: '🔔' }), el('span', { textContent: T.ios.replace('{n}', n) }));
    return;
  }
  // la politique de l'exploitant (PRIVACY_URL du serveur) : ce qu'on accepte en les activant
  const policy = () => (privacy ? el('a', { href: privacy, target: '_blank', rel: 'noopener', textContent: T.privacy }) : null);
  if (on) {
    bar.className = 'on';
    const off = el('button', { type: 'button', className: 'link', textContent: T.off, disabled: busy });
    off.addEventListener('click', () => void disable());
    const p = policy();
    bar.replaceChildren(el('span', { className: 'bell', textContent: '🔔' }), el('span', {}, T.on, ...(p ? [' · ', p] : [])), off);
    return;
  }
  const denied = Notification.permission === 'denied';
  bar.className = denied ? 'warn denied' : 'warn';
  const btn = el('button', { type: 'button', textContent: denied ? T.retry : T.enable, disabled: busy });
  btn.addEventListener('click', () => void (denied ? check() : enable()));
  const text = el('span', {}, el('b', { textContent: (denied ? T.denied : T.ask).replace('{n}', n) }));
  if (denied) text.append(el('small', { textContent: T.deniedHow }));
  else { const p = policy(); text.append(el('small', {}, T.how, ...(p ? [' ', p] : []))); }
  if (failed) text.append(el('small', { textContent: T.fail }));
  bar.replaceChildren(el('span', { className: 'bell', textContent: denied ? '🔕' : '🔔' }), text, btn);
}

document.addEventListener('pilot', e => {
  const was = gone;
  name = e.detail.name || '';
  gone = !!e.detail.gone;
  if (was && !gone) void check(); else render();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
try { navigator.permissions?.query({ name: 'notifications' }).then(p => { p.onchange = () => void check(); }, () => {}); } catch { /* ancien navigateur */ }
void check();
fetch('/api/v1/push', { cache: 'no-store' }).then(r => r.json()).then(d => { privacy = typeof d.privacy === 'string' && /^https:\/\//.test(d.privacy) ? d.privacy : ''; render(); }, () => {});
// un navigateur qui ne répond pas (service worker refusé) : la barre vient quand même
setTimeout(() => { if (!checked) { checked = true; render(); } }, 4000);
