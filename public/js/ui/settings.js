// Menus de l'espace de travail et du profil, préférences (apparence, notifications, raccourcis), administration.
import { $, esc, icon, modKey, copyText } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { fmtOn } from '../lib/format.js';
import { sound, ping } from '../lib/sound.js';
import { state, bus, nameOf, statusOf, isAdmin, user } from '../core/state.js';
import { api, patch, post } from '../core/api.js';
import { menu, modal, toast, confirmBox, busy } from './layer.js';
import { avatarHtml } from './avatar.js';
import { openProfile, editStatus, setDnd, DND_CHOICES } from './profile.js';
import { createChannel } from './details.js';

// ---------- Apparence (appliquée tout de suite, gardée dans ce navigateur) ----------
export const SIDES = [['foret', 'Forêt', '#10302a'], ['nuit', 'Nuit', '#131b2e'], ['aubergine', 'Aubergine', '#34193a'], ['terre', 'Terre', '#3a2418'], ['graphite', 'Graphite', '#1b1d1f'], ['clair', 'Clair', '#f1f3f2']];
export function applyAppearance() {
  const root = document.documentElement;
  const theme = store.get('theme') || 'auto';
  if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
  root.dataset.side = store.get('side') || 'foret';
  const density = store.get('density');
  if (density === 'compact') root.dataset.density = 'compact'; else delete root.dataset.density;
  const side = getComputedStyle(root).getPropertyValue('--side-bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', side || '#10302a');
}
export const notifyLevel = () => store.get('notify') || 'mentions'; // all | mentions | none

// ---------- Menu de l'espace de travail ----------
export function workspaceMenu(anchor) {
  menu(anchor, [
    { html: `<div class="menu-head"><img src="/icon.svg" width="36" height="36" alt=""><div><b>${esc(state.workspace.name)}</b><small>${esc(location.host)}</small></div></div>` },
    { label: 'Inviter des collègues', icon: 'user-plus', run: invite },
    { label: 'Créer un canal', icon: 'plus', run: () => createChannel() },
    { label: 'Parcourir les canaux', icon: 'hash', run: () => { location.hash = '#/browse'; } },
    '-',
    { label: 'Préférences', icon: 'settings', run: () => preferences() },
    { label: 'Raccourcis clavier', icon: 'info', hint: `${modKey} /`, run: () => preferences('keys') },
    isAdmin() ? { label: 'Administration', icon: 'shield', run: () => admin() } : null,
  ]);
}
async function invite() {
  let code = '';
  if (isAdmin()) { try { code = (await api('/api/admin')).accessCode; } catch {} }
  const text = `Rejoins ${state.workspace.name}, notre chat d’équipe chiffré : ${location.origin}${code ? `\nCode d’accès pour créer ton compte : ${code}` : ''}`;
  const m = modal({
    title: 'Inviter des collègues',
    sub: 'Envoie-leur l’adresse du chat. Pour créer un compte, il faut aussi le code d’accès de l’espace de travail.',
    body: `<label class="field"><span>Adresse</span><div class="code-box"><code style="font-size:14px;letter-spacing:0">${esc(location.origin)}</code><button type="button" class="btn sm" data-copy="url">${icon('copy', 'sm')}Copier</button></div></label>
      ${code ? `<label class="field"><span>Code d’accès</span><div class="code-box"><code>${esc(code)}</code><button type="button" class="btn sm" data-copy="code">${icon('copy', 'sm')}Copier</button></div></label>`
      : '<p style="color:var(--muted);font-size:14px;margin:0">Le code d’accès est connu des administrateurs de l’espace de travail.</p>'}`,
    foot: `<button type="button" class="btn" data-close>Fermer</button><button type="button" class="btn primary" data-copy="all">${icon('copy', 'sm')}Copier l’invitation</button>`,
  });
  m.el.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    copyText(b.dataset.copy === 'url' ? location.origin : b.dataset.copy === 'code' ? code : text);
    toast(b.dataset.copy === 'all' ? 'Invitation copiée : colle-la dans un e-mail ou un message' : 'Copié');
  });
}

// ---------- Menu du profil ----------
export function meMenu(anchor) {
  const u = user(state.me), st = statusOf(state.me);
  const dnd = (u.dndUntil || 0) > Date.now();
  menu(anchor, [
    { html: `<div class="menu-head">${avatarHtml(state.me, { presence: true })}<div><b>${esc(nameOf(state.me))}</b><small>${u.away ? 'Absent' : 'Disponible'}${st ? ` · ${st.emoji || ''} ${esc(st.text || '')}` : ''}</small></div></div>` },
    { label: st ? 'Modifier le statut' : 'Définir un statut', icon: 'smile', run: editStatus },
    { label: u.away ? 'Apparaître disponible' : 'Apparaître absent', icon: 'clock', run: () => patch('/api/me', { away: !u.away }).catch(e => toast(e.message)) },
    { label: dnd ? 'Réactiver les notifications' : 'Mettre en pause les notifications', icon: dnd ? 'bell' : 'bell-off', sub: dnd ? null : () => DND_CHOICES.map(([l, f]) => ({ label: l, run: () => setDnd(f()) })), run: dnd ? () => setDnd(null) : null },
    '-',
    { label: 'Profil', icon: 'users', run: () => openProfile(state.me) },
    { label: 'Préférences', icon: 'settings', run: () => preferences() },
    '-',
    { label: 'Se déconnecter', icon: 'logout', run: async () => { if (await confirmBox({ title: 'Se déconnecter ?', text: `Tu devras saisir ton mot de passe pour revenir sur ce navigateur.`, ok: 'Se déconnecter' })) bus.emit('logout'); } },
  ], { side: 'top' });
}

// ---------- Préférences ----------
const SHORTCUTS = [
  [`${modKey} K`, 'Aller à un canal, une personne, une page'],
  [`${modKey} Maj K`, 'Nouveau message direct'],
  ['Alt ↑ / Alt ↓', 'Conversation précédente / suivante'],
  ['Alt Maj ↑ / ↓', 'Conversation non lue précédente / suivante'],
  ['Échap', 'Marquer la conversation comme lue, fermer un panneau'],
  ['↑ (zone de saisie vide)', 'Modifier ton dernier message'],
  [`${modKey} B · ${modKey} I · ${modKey} Maj X`, 'Gras, italique, barré'],
  [`${modKey} K (texte sélectionné)`, 'Ajouter un lien'],
  [`${modKey} /`, 'Afficher cette liste'],
  ['/', 'Commandes : /poll, /code, /away, /shrug…'],
];
export function preferences(section = 'look') {
  const m = modal({ title: 'Préférences', wide: true, body: `<div class="settings"><nav class="settings-nav" role="tablist">
      <button type="button" data-s="look">${icon('sun')}Apparence</button>
      <button type="button" data-s="notif">${icon('bell')}Notifications</button>
      <button type="button" data-s="keys">${icon('info')}Raccourcis</button>
    </nav><div class="settings-body"></div></div>` });
  m.el.querySelector('.modal-body').style.padding = '0';
  const body = $('.settings-body', m.el);
  const show = s => {
    m.el.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === s));
    if (s === 'look') {
      const theme = store.get('theme') || 'auto', side = store.get('side') || 'foret', density = store.get('density') || 'normal';
      body.innerHTML = `<h3>Thème</h3><div class="seg" data-pref="theme">${[['auto', 'Automatique'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) => `<button type="button" data-v="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <h3>Barre latérale</h3><div class="swatches" data-pref="side">${SIDES.map(([k, l, c]) => `<button type="button" class="swatch${side === k ? ' on' : ''}" data-v="${k}" style="--sw:${c}"><i></i>${l}</button>`).join('')}</div>
        <h3>Densité des messages</h3><div class="seg" data-pref="density">${[['normal', 'Confortable'], ['compact', 'Compacte']].map(([k, l]) => `<button type="button" data-v="${k}" class="${density === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    }
    if (s === 'notif') {
      const level = notifyLevel();
      const perm = 'Notification' in window ? Notification.permission : 'unsupported';
      body.innerHTML = `<h3>M’avertir pour</h3>
        <div style="display:grid;gap:8px" data-pref="notify">${[['all', 'Tous les nouveaux messages', 'Dans les canaux dont tu es membre (hors sourdine).'], ['mentions', 'Messages directs, mentions et fils', 'Recommandé : seulement ce qui te concerne.'], ['none', 'Rien', 'Tu consultes quand tu veux ; les pastilles restent.']]
          .map(([k, l, d]) => `<label class="check"><input type="radio" name="notify" value="${k}" ${level === k ? 'checked' : ''}><span><b>${l}</b><small>${d}</small></span></label>`).join('')}</div>
        <h3>Notifications du système</h3>
        <p style="margin:0 0 10px;color:var(--text-2)">${perm === 'granted' ? 'Activées : tu es averti même quand l’onglet est en arrière-plan.' : perm === 'denied' ? 'Bloquées par le navigateur : autorise-les depuis l’icône à gauche de l’adresse du site.' : perm === 'unsupported' ? 'Ce navigateur ne les prend pas en charge.' : 'Pas encore autorisées.'}</p>
        ${perm === 'default' ? '<button type="button" class="btn" data-ask>Autoriser les notifications</button>' : ''}
        <h3>Sons</h3><label class="check"><input type="checkbox" data-sound ${sound.on ? 'checked' : ''}><span><b>Jouer un son</b><small>À l’arrivée d’un message qui t’est adressé, et pendant les appels.</small></span></label>`;
    }
    if (s === 'keys') body.innerHTML = `<h3>Raccourcis clavier</h3><div class="row-list" style="padding:0">${SHORTCUTS.map(([k, d]) => `<div class="row" style="cursor:default"><span class="row-text"><b style="font-weight:500">${esc(d)}</b></span><span>${k.split(' · ').map(x => `<kbd>${esc(x)}</kbd>`).join(' ')}</span></div>`).join('')}</div>`;
  };
  m.el.querySelector('.settings-nav').onclick = e => { const b = e.target.closest('[data-s]'); if (b) show(b.dataset.s); };
  body.addEventListener('click', e => {
    const b = e.target.closest('[data-pref] [data-v]');
    if (b) {
      const key = b.closest('[data-pref]').dataset.pref;
      store.set(key, b.dataset.v);
      b.closest('[data-pref]').querySelectorAll('[data-v]').forEach(x => x.classList.toggle('on', x === b));
      applyAppearance();
    }
    if (e.target.closest('[data-ask]')) Notification.requestPermission().then(() => show('notif'));
  });
  body.addEventListener('change', e => {
    if (e.target.name === 'notify') store.set('notify', e.target.value);
    if (e.target.matches('[data-sound]')) { sound.on = e.target.checked; if (sound.on) ping(); }
  });
  show(section);
}

// ---------- Administration ----------
export async function admin(section = 'ws') {
  let info;
  try { info = await api('/api/admin'); } catch (e) { return toast(e.message); }
  const m = modal({ title: 'Administration', wide: true, body: `<div class="settings"><nav class="settings-nav">
      <button type="button" data-s="ws">${icon('settings')}Espace de travail</button>
      <button type="button" data-s="members">${icon('users')}Membres</button>
    </nav><div class="settings-body"></div></div>` });
  m.el.querySelector('.modal-body').style.padding = '0';
  const body = $('.settings-body', m.el);
  const show = s => {
    m.el.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === s));
    if (s === 'ws') {
      body.innerHTML = `<h3>Nom</h3><div style="display:flex;gap:8px"><input class="input" data-name maxlength="40" value="${esc(info.workspace.name)}" aria-label="Nom de l’espace de travail"><button type="button" class="btn primary" data-save>Enregistrer</button></div>
        <h3>Code d’accès</h3><p style="margin:0 0 10px;color:var(--text-2)">Demandé à la création d’un compte. Changer le code n’affecte pas les comptes existants.</p>
        <div class="code-box"><code>${esc(info.accessCode)}</code><button type="button" class="btn sm" data-copy>${icon('copy', 'sm')}Copier</button>
        ${info.codeFromEnv ? '' : `<button type="button" class="btn sm" data-regen>Générer un nouveau code</button>`}</div>
        ${info.codeFromEnv ? '<p style="font-size:13px;color:var(--muted)">Ce code est fixé par la variable LANCHAT_CODE du serveur.</p>' : ''}`;
    }
    if (s === 'members') {
      const list = [...state.users.values()].sort((a, b) => a.deactivated - b.deactivated || nameOf(a.name).localeCompare(nameOf(b.name), 'fr'));
      body.innerHTML = `<h3>${list.filter(u => !u.deactivated).length} membres actifs</h3><div class="row-list admin-users" style="padding:0">${list.map(u => `<div class="row" data-u="${esc(u.name)}">
          ${avatarHtml(u.name)}<span class="row-text"><b style="${u.deactivated ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(nameOf(u.name))}</b><small>@${esc(u.name)}${u.created ? ' · depuis ' + esc(fmtOn(u.created)) : ''}</small></span>
          ${u.role === 'owner' ? '<span class="role owner">Propriétaire</span>' : u.name === state.me ? '<span class="role">Admin</span>'
          : `<button type="button" class="btn sm" data-act="more">${u.deactivated ? 'Désactivé' : u.role === 'admin' ? 'Admin' : 'Membre'} ${icon('chev-down', 'xs')}</button>`}</div>`).join('')}</div>`;
    }
  };
  m.el.querySelector('.settings-nav').onclick = e => { const b = e.target.closest('[data-s]'); if (b) show(b.dataset.s); };
  body.addEventListener('click', async e => {
    if (e.target.closest('[data-save]')) busy(e.target.closest('[data-save]'), async () => { try { info = await patch('/api/admin', { name: $('[data-name]', body).value }); toast('Nom enregistré'); } catch (err) { toast(err.message); } });
    if (e.target.closest('[data-copy]')) { copyText(info.accessCode); toast('Code copié'); }
    if (e.target.closest('[data-regen]') && await confirmBox({ title: 'Générer un nouveau code ?', text: 'L’ancien code ne permettra plus de créer de compte.', ok: 'Générer' })) {
      try { info = await patch('/api/admin', { regenerateCode: true }); show('ws'); } catch (err) { toast(err.message); }
    }
    const b = e.target.closest('[data-act="more"]');
    if (b) {
      const name = b.closest('[data-u]').dataset.u, u = user(name);
      const set = async body2 => { try { await post(`/api/admin/users/${encodeURIComponent(name)}`, body2); setTimeout(() => show('members'), 100); } catch (err) { toast(err.message); } };
      menu(b, [
        !u.deactivated ? { label: u.role === 'admin' ? 'Retirer le rôle d’admin' : 'Nommer admin', icon: 'shield', run: () => set({ role: u.role === 'admin' ? 'member' : 'admin' }) } : null,
        u.deactivated ? { label: 'Réactiver le compte', icon: 'check', run: () => set({ deactivated: false }) }
          : { label: 'Désactiver le compte', icon: 'x', danger: true, run: async () => { if (await confirmBox({ title: `Désactiver ${nameOf(name)} ?`, text: 'La personne est déconnectée partout et ne peut plus se connecter. Ses messages restent visibles. Tu pourras réactiver le compte.', ok: 'Désactiver', danger: true })) set({ deactivated: true }); } },
      ], { align: 'end' });
    }
  });
  show(section);
}
