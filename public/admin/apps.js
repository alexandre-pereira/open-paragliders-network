// Back-office : les logiciels connectés (clés), les bannissements, le journal des actions.
// Une clé n'est montrée qu'à sa création : le serveur n'en garde que l'empreinte.
'use strict';

const dateFr = t => (t ? new Date(t * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function adminBtn(label, fn, cls = '') {
  const b = el('button', { type: 'button', textContent: label, className: cls });
  b.addEventListener('click', async () => { try { await fn(); } catch (e) { showErr(e); } });
  return b;
}
const showErr = e => { $('adminErr').textContent = e.message.replace(/^\d+ /, ''); };

/** la clé, une seule fois */
function showKey(r) {
  const box = $('newKey');
  box.hidden = false;
  box.replaceChildren(
    el('b', { textContent: `Clé de ${r.name}` }),
    el('p', { className: 'muted', textContent: 'À copier maintenant : elle ne sera plus jamais affichée.' }),
    el('code', { textContent: r.key }),
    adminBtn('Copier', () => navigator.clipboard.writeText(r.key)));
}

async function drawApps() {
  $('adminErr').textContent = '';
  const { open, apps } = await api('/admin/apps');
  $('openWarn').hidden = !open;
  $('appList').replaceChildren(...apps.map(a => {
    const db = a.source === 'admin';
    const li = el('li', { className: a.revoked ? 'off' : '' },
      el('b', { textContent: a.name }),
      el('small', { textContent: db
        ? [a.revoked ? 'RÉVOQUÉE' : 'active', `vu ${dateFr(a.seen)}`, `${a.requests} requêtes`, `${a.points} points`, a.contact].filter(Boolean).join(' · ')
        : 'clé de APP_KEYS : se gère dans la configuration du serveur' }));
    if (db) li.append(el('div', { className: 'row' },
      adminBtn('Nouvelle clé', async () => {
        if (!confirm(`Remplacer la clé de ${a.name} ? L'ancienne cesse de marcher tout de suite : ses utilisateurs sont coupés jusqu'à la mise à jour du logiciel.`)) return;
        showKey(await api(`/admin/apps/${a.id}/rotate`, { method: 'POST', body: '{}' }));
        await drawApps();
      }),
      adminBtn(a.revoked ? 'Rétablir' : 'Révoquer', async () => {
        if (!a.revoked && !confirm(`Révoquer ${a.name} ? Ses utilisateurs sont déconnectés tout de suite.`)) return;
        await api(`/admin/apps/${a.id}/${a.revoked ? 'restore' : 'revoke'}`, { method: 'POST', body: '{}' });
        await drawApps();
      }, a.revoked ? '' : 'danger'),
      adminBtn('Supprimer', async () => {
        if (!confirm(`Supprimer ${a.name} ? Sa clé est perdue définitivement.`)) return;
        await api(`/admin/apps/${a.id}/delete`, { method: 'POST', body: '{}' });
        await drawApps();
      }, 'danger')));
    return li;
  }));
  const { bans } = await api('/admin/bans');
  $('banList').replaceChildren(...(bans.length ? bans.map(b => el('li', {},
    el('b', { textContent: b.label || b.value }),
    el('small', { textContent: [b.kind === 'ip' ? `adresse IP jusqu'à ${dateFr(b.until)}` : 'appareil', dateFr(b.at), b.reason].filter(Boolean).join(' · ') }),
    adminBtn('Lever', async () => { await api('/admin/bans/lift', { method: 'POST', body: JSON.stringify({ kind: b.kind, value: b.value }) }); await drawApps(); })))
    : [el('li', { className: 'muted', textContent: 'Aucun.' })]));
  const { audit } = await api('/admin/audit');
  $('auditList').replaceChildren(...(audit.length ? audit.map(a => el('li', {},
    el('small', { textContent: `${dateFr(a.t)} · ${a.action}${a.detail ? ` · ${a.detail}` : ''} · ${a.ip}` })))
    : [el('li', { className: 'muted', textContent: 'Aucune action.' })]));
}

$('openAdmin').addEventListener('click', () => { $('adminPanel').hidden = false; $('newKey').hidden = true; drawApps().catch(showErr); });
$('closeAdmin').addEventListener('click', () => { $('adminPanel').hidden = true; $('newKey').hidden = true; $('newKey').replaceChildren(); });
$('appForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    showKey(await api('/admin/apps', { method: 'POST', body: JSON.stringify({ name: $('appName').value, contact: $('appContact').value }) }));
    $('appForm').reset();
    await drawApps();
  } catch (err) { showErr(err); }
});
