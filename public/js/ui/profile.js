// Profils : fiche d'une personne (panneau), modifier son profil et sa photo, statut, pause des notifications.
import { $, esc, icon } from '../lib/dom.js';
import { fmtDay, fmtFuture, at, endOfDay } from '../lib/format.js';
import { E2E } from '../lib/e2e.js';
import { state, user, nameOf, statusOf, isOnline, isDnd, dmId } from '../core/state.js';
import { api, patch } from '../core/api.js';
import { openConvo } from '../core/router.js';
import { openPane } from './pane.js';
import { modal, toast, busy } from './layer.js';
import { avatarHtml } from './avatar.js';
import { openPicker } from './picker.js';
import { Call } from '../rtc/call.js';

const ROLE = { owner: 'Propriétaire', admin: 'Admin', member: '' };

export function openProfile(name) {
  const u = user(name);
  if (!state.users.has(name)) return toast(`${name} n’a pas de compte`);
  const z = openPane({ kind: 'profile', key: name, title: 'Profil' });
  const st = statusOf(name);
  const me = name === state.me;
  const presence = isDnd(name) ? `Ne pas déranger jusqu’à ${fmtFuture(u.dndUntil).replace(/^aujourd’hui à /, '')}` : isOnline(name) ? 'En ligne' : state.online.has(name) ? 'Absent' : 'Hors ligne';
  z.body.innerHTML = `<div class="profile">
      ${avatarHtml(name, { presence: true })}
      <h2>${esc(nameOf(name))}</h2>
      ${u.title ? `<div class="p-title">${esc(u.title)}</div>` : ''}
      ${st ? `<div class="p-status"><span>${st.emoji || '💬'}</span><span>${esc(st.text || '')}</span>${st.until ? `<small style="color:var(--muted)">· jusqu’à ${esc(fmtFuture(st.until))}</small>` : ''}</div>` : ''}
      <div class="p-meta">${presence}${u.deactivated ? ' · compte désactivé' : ''}</div>
      <div class="p-actions">
        ${me ? `<button type="button" class="btn" data-p="edit">${icon('edit', 'sm')}Modifier le profil</button><button type="button" class="btn" data-p="status">${icon('smile', 'sm')}Statut</button>`
        : `<button type="button" class="btn primary" data-p="dm">${icon('thread', 'sm')}Message</button>${u.deactivated ? '' : `<button type="button" class="btn" data-p="call">${icon('phone', 'sm')}Appel audio</button>`}`}
      </div>
    </div>
    <div class="sect"><h3>Pseudo</h3><p>@${esc(name)}${ROLE[u.role] ? ` · <span class="role${u.role === 'owner' ? ' owner' : ''}">${ROLE[u.role]}</span>` : ''}</p></div>
    <div class="sect"><h3>Membre depuis</h3><p>${u.created ? esc(fmtDay(u.created)) : '—'}</p></div>
    ${me ? '' : `<div class="sect"><h3>Code de sécurité</h3><p class="muted" data-safety>Calcul…</p><p class="muted" style="margin-top:6px;font-size:13px">Comparez-le de vive voix : s’il est identique chez vous deux, personne ne s’est glissé dans votre conversation chiffrée.</p></div>`}`;
  z.body.addEventListener('click', e => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    if (b.dataset.p === 'dm') openConvo(dmId(name));
    if (b.dataset.p === 'call') Call.start(name);
    if (b.dataset.p === 'edit') editProfile();
    if (b.dataset.p === 'status') editStatus();
  });
  if (!me && u.pub) E2E.safetyNumber(state.pub, u.pub).then(n => { const el = $('[data-safety]', z.body); if (el) { el.innerHTML = `<code style="font:650 15px var(--mono);letter-spacing:.06em;color:var(--text)">${n}</code>`; } });
}

// ---------- Mon profil ----------
// Photo : recadrée en carré et réduite à 256 px dans le navigateur avant l'envoi
async function resizeImage(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height), size = Math.min(256, side);
  const cv = Object.assign(document.createElement('canvas'), { width: size, height: size });
  cv.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  const webp = cv.toDataURL('image/webp', 0.86);
  return webp.startsWith('data:image/webp') ? webp : cv.toDataURL('image/jpeg', 0.86);
}
export function editProfile() {
  const u = user(state.me);
  const m = modal({
    title: 'Modifier ton profil',
    body: `<div class="avatar-edit"><span data-av>${avatarHtml(state.me)}</span><div style="display:grid;gap:6px;justify-items:start">
        <button type="button" class="btn sm" data-photo>${icon('image', 'sm')}Changer la photo</button>
        ${u.avatar ? '<button type="button" class="link-btn" data-nophoto style="font-size:13px">Retirer la photo</button>' : ''}
        <input type="file" accept="image/*" hidden></div></div>
      <label class="field"><span>Nom complet</span><input name="displayName" maxlength="60" value="${esc(u.displayName)}" placeholder="Awa Ndiaye" autocomplete="name"><small>C’est ce que verront tes collègues. Ton pseudo @${esc(state.me)} reste le même.</small></label>
      <label class="field"><span>Fonction</span><input name="title" maxlength="80" value="${esc(u.title)}" placeholder="Développeuse front, Comptabilité…"></label>`,
    foot: '<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Enregistrer</button>',
  });
  const input = $('input[type=file]', m.el);
  $('[data-photo]', m.el).onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      await api('/api/me/avatar', { method: 'PUT', body: { image: await resizeImage(f) } });
      $('[data-av]', m.el).innerHTML = avatarHtml(state.me);
      toast('Photo mise à jour');
    } catch (e) { toast(e.message || 'Image illisible'); }
  };
  $('[data-nophoto]', m.el)?.addEventListener('click', async () => {
    await api('/api/me/avatar', { method: 'PUT', body: { image: null } }).catch(e => toast(e.message));
    $('[data-av]', m.el).innerHTML = avatarHtml(state.me);
  });
  const ok = $('[data-ok]', m.el);
  ok.onclick = () => busy(ok, async () => {
    try {
      await patch('/api/me', { displayName: $('[name=displayName]', m.el).value, title: $('[name=title]', m.el).value });
      m.close(); toast('Profil enregistré');
    } catch (e) { toast(e.message); }
  });
}

// ---------- Statut ----------
const PRESETS = [
  { emoji: '📅', text: 'En réunion', until: () => Date.now() + 3600e3, hint: '1 heure' },
  { emoji: '🚗', text: 'En déplacement', until: () => Date.now() + 2 * 3600e3, hint: '2 heures' },
  { emoji: '🍽️', text: 'En pause déjeuner', until: () => Date.now() + 3600e3, hint: '1 heure' },
  { emoji: '🤒', text: 'Malade', until: endOfDay, hint: 'aujourd’hui' },
  { emoji: '🏠', text: 'En télétravail', until: endOfDay, hint: 'aujourd’hui' },
  { emoji: '🌴', text: 'En congé', until: () => null, hint: '' },
];
const CLEAR = [
  ['Ne pas effacer', () => null], ['30 minutes', () => Date.now() + 30 * 60e3], ['1 heure', () => Date.now() + 3600e3],
  ['4 heures', () => Date.now() + 4 * 3600e3], ['Aujourd’hui', endOfDay], ['Cette semaine', () => at(23, (7 - new Date().getDay()) % 7)],
];
export function editStatus() {
  const cur = statusOf(state.me);
  let emoji = cur?.emoji || '💬';
  const m = modal({
    title: 'Ton statut',
    body: `<div class="status-input"><button type="button" class="emoji-btn" data-emoji aria-label="Choisir un emoji">${emoji}</button>
        <input class="input" name="text" maxlength="100" value="${esc(cur?.text || '')}" placeholder="Quoi de neuf ?" autocomplete="off"></div>
      <label class="field" style="margin-top:12px"><span>Effacer après</span><select name="clear">${CLEAR.map(([l], i) => `<option value="${i}">${l}</option>`).join('')}</select></label>
      ${cur ? '' : `<div class="mi-label" style="padding-left:0">Suggestions</div><div class="status-presets">${PRESETS.map((p, i) => `<button type="button" data-preset="${i}"><span>${p.emoji}</span><span>${esc(p.text)}</span>${p.hint ? `<small>· ${p.hint}</small>` : ''}</button>`).join('')}</div>`}`,
    foot: `${cur ? '<button type="button" class="btn ghost" data-clear>Effacer le statut</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Enregistrer</button>`,
  });
  const save = async status => {
    try { await patch('/api/me', { status }); m.close(); toast(status ? 'Statut mis à jour' : 'Statut effacé'); }
    catch (e) { toast(e.message); }
  };
  $('[data-emoji]', m.el).onclick = e => openPicker(e.currentTarget, x => { emoji = x; e.currentTarget.textContent = x; });
  m.el.querySelectorAll('[data-preset]').forEach(b => { b.onclick = () => { const p = PRESETS[b.dataset.preset]; save({ emoji: p.emoji, text: p.text, until: p.until() }); }; });
  $('[data-clear]', m.el)?.addEventListener('click', () => save(null));
  $('[data-ok]', m.el).onclick = () => {
    const text = $('[name=text]', m.el).value.trim();
    save(text || emoji !== '💬' ? { emoji, text, until: CLEAR[$('[name=clear]', m.el).value][1]() } : null);
  };
}

// Pause des notifications
export const DND_CHOICES = [
  ['30 minutes', () => Date.now() + 30 * 60e3], ['1 heure', () => Date.now() + 3600e3], ['2 heures', () => Date.now() + 2 * 3600e3],
  ['Jusqu’à demain', () => at(9, 1)], ['Jusqu’à lundi', () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d.getTime(); }],
];
export async function setDnd(until) {
  try {
    await patch('/api/me', { dndUntil: until });
    toast(until ? `Notifications en pause ${fmtFuture(until).replace(/^aujourd’hui /, '')}` : 'Notifications réactivées');
  } catch (e) { toast(e.message); }
}
