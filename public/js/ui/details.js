// Détails d'un canal (panneau) : à propos, membres, épinglés, fichiers. Création d'un canal, sujet, départ, archivage.
import { $, esc, icon } from '../lib/dom.js';
import { fmtOn, fmtWhen, fmtSize } from '../lib/format.js';
import { state, bus, channel, isMember, nameOf, isAdmin, user, people, prefOf, isDm, dmOther } from '../core/state.js';
import { api, post, patch } from '../core/api.js';
import { decryptAll } from '../core/keys.js';
import { go, openConvo } from '../core/router.js';
import { openPane, paneIs, closePane } from './pane.js';
import { modal, toast, confirmBox, busy } from './layer.js';
import { avatarHtml } from './avatar.js';
import { renderMessage, extOf } from './messages.js';
import { openProfile } from './profile.js';
import { setPref } from './sidebar.js';

const canManage = c => isAdmin() || c.createdBy === state.me;
let tab = 'about';

export function openDetails(ch, which = 'about', edit = false) {
  if (isDm(ch)) return openProfile(dmOther(ch));
  const c = channel(ch);
  if (!c) return;
  tab = which;
  const z = openPane({ kind: 'details', key: ch, title: `${c.private ? '' : '#'}${c.name}`, sub: c.private ? 'Canal privé' : 'Canal public' });
  const tabs = [['about', 'À propos'], ['members', 'Membres', c.members.filter(n => !user(n).deactivated).length], ['pins', 'Épinglés'], ['files', 'Fichiers']];
  z.body.innerHTML = `<div class="tabs" role="tablist">${tabs.map(([k, l, n]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l}${n ? `<small>${n}</small>` : ''}</button>`).join('')}</div><div data-tabbody></div>`;
  z.body.querySelector('.tabs').onclick = e => {
    const b = e.target.closest('[data-tab]');
    if (b) { tab = b.dataset.tab; z.body.querySelectorAll('[data-tab]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); }); renderTab(c, $('[data-tabbody]', z.body)); }
  };
  renderTab(c, $('[data-tabbody]', z.body));
  if (edit && which === 'about') editAbout(ch);
  if (edit && which === 'members') addMembers(ch);
}
// Le canal a changé (temps réel) : on rafraîchit le panneau s'il est ouvert dessus
bus.on('channel-changed', name => { if (paneIs('details', name)) openDetails(name, tab); });

async function renderTab(c, el) {
  const member = isMember(c.name);
  if (tab === 'about') {
    const pref = prefOf(c.name);
    el.innerHTML = `
      <div class="sect"><h3>Sujet ${member && !c.archived ? '<button type="button" class="link-btn" data-a="topic">Modifier</button>' : ''}</h3><p class="${c.topic ? '' : 'muted'}">${c.topic ? esc(c.topic) : 'Aucun sujet'}</p></div>
      <div class="sect"><h3>Description ${member && !c.archived ? '<button type="button" class="link-btn" data-a="about">Modifier</button>' : ''}</h3><p class="${c.description ? '' : 'muted'}">${c.description ? esc(c.description) : 'Aucune description'}</p></div>
      <div class="sect"><h3>Créé</h3><p>${c.created ? esc(fmtOn(c.created)[0].toUpperCase() + fmtOn(c.created).slice(1)) : ''}${c.createdBy ? `, par ${esc(nameOf(c.createdBy))}` : ''}</p></div>
      ${member ? `<div class="sect"><h3>Notifications</h3>
        <label class="check"><input type="checkbox" data-a="mute" ${pref.muted ? 'checked' : ''}><span><b>Mettre en sourdine</b><small>Le canal reste dans ta liste, sans pastille ni notification, sauf si on te mentionne.</small></span></label>
        <label class="check" style="margin-top:8px"><input type="checkbox" data-a="star" ${pref.starred ? 'checked' : ''}><span><b>Favori</b><small>Affiché en haut de ta barre latérale.</small></span></label></div>` : ''}
      <div class="sect" style="display:flex;gap:8px;flex-wrap:wrap">
        ${member ? '' : `<button type="button" class="btn primary" data-a="join">Rejoindre le canal</button>`}
        ${member && c.name !== 'general' ? `<button type="button" class="btn" data-a="leave">${icon('door', 'sm')}Quitter le canal</button>` : ''}
        ${canManage(c) && c.name !== 'general' ? `<button type="button" class="btn ${c.archived ? '' : 'ghost'}" data-a="archive">${icon('archive', 'sm')}${c.archived ? 'Désarchiver' : 'Archiver le canal'}</button>` : ''}
      </div>`;
    el.onclick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'topic') editTopic(c.name);
      if (a === 'about') editAbout(c.name);
      if (a === 'join') post(`/api/channels/${encodeURIComponent(c.name)}/join`).then(() => toast(`Tu as rejoint #${c.name}`)).catch(err => toast(err.message));
      if (a === 'leave') leaveChannel(c.name);
      if (a === 'archive') archive(c);
    };
    el.onchange = e => {
      if (e.target.dataset.a === 'mute') setPref(c.name, { muted: e.target.checked });
      if (e.target.dataset.a === 'star') setPref(c.name, { starred: e.target.checked });
    };
  }
  if (tab === 'members') {
    const list = c.members.filter(n => state.users.has(n) && !user(n).deactivated).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'fr'));
    el.innerHTML = `<div class="row-list">
      ${member && !c.archived && (c.private || isAdmin()) ? `<button type="button" class="row" data-m="add"><span class="row-ic">${icon('user-plus')}</span><span class="row-text"><b>Ajouter des personnes</b></span></button>` : ''}
      ${list.map(n => `<div class="row" data-user="${esc(n)}" style="cursor:pointer">${avatarHtml(n, { presence: true })}<span class="row-text"><b>${esc(nameOf(n))}${n === state.me ? ' (toi)' : ''}</b><small>${esc(user(n).title || '@' + n)}</small></span>
        ${n === c.createdBy ? '<span class="row-end">créateur</span>' : ''}
        ${canManage(c) && c.private && n !== state.me ? `<button type="button" class="icon-btn" data-remove="${esc(n)}" aria-label="Retirer ${esc(nameOf(n))} du canal" title="Retirer du canal">${icon('x')}</button>` : ''}</div>`).join('')}
    </div>`;
    el.onclick = async e => {
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        e.stopPropagation();
        const n = rm.dataset.remove;
        if (await confirmBox({ title: `Retirer ${nameOf(n)} de #${c.name} ?`, text: 'Cette personne ne verra plus ce canal ni ses nouveaux messages.', ok: 'Retirer', danger: true })) {
          post(`/api/channels/${encodeURIComponent(c.name)}/members`, { remove: [n] }).catch(err => toast(err.message));
        }
        return;
      }
      if (e.target.closest('[data-m="add"]')) return addMembers(c.name);
      const row = e.target.closest('[data-user]');
      if (row) openProfile(row.dataset.user);
    };
  }
  if (tab === 'pins' || tab === 'files') {
    el.innerHTML = '<div class="pane-empty">Chargement…</div>';
    try {
      const { messages } = await api(`/api/${tab}?channel=${encodeURIComponent(c.name)}`);
      await decryptAll(messages);
      if (!el.isConnected) return;
      if (!messages.length) {
        el.innerHTML = `<div class="pane-empty">${tab === 'pins' ? 'Aucun message épinglé. Épingle les messages importants depuis le menu « … » d’un message : ils seront ici pour tout le canal.' : 'Aucun fichier partagé dans ce canal.'}</div>`;
        return;
      }
      el.innerHTML = '';
      if (tab === 'pins') {
        for (const m of messages) {
          const item = document.createElement('div');
          item.className = 'item';
          item.appendChild(renderMessage(m, null, { card: true, inThread: true }));
          item.onclick = e => { if (!e.target.closest('button,a')) openConvo(c.name, m.id); };
          el.appendChild(item);
        }
      } else {
        el.innerHTML = `<div class="row-list">${messages.map(m => `<div class="row" data-id="${m.id}" style="cursor:pointer">
          <span class="row-ic">${icon(m.file?.voice ? 'mic' : ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extOf(m.file?.name)) ? 'image' : 'file')}</span>
          <span class="row-text"><b>${esc(m.file?.name || 'Fichier chiffré')}</b><small>${esc(nameOf(m.user))} · ${esc(fmtWhen(m.ts))} · ${fmtSize(m.file?.size || 0)}</small></span></div>`).join('')}</div>`;
        el.onclick = e => { const r = e.target.closest('[data-id]'); if (r) { const m = messages.find(x => x.id === Number(r.dataset.id)); openConvo(c.name, m.parent && !m.broadcast ? m.parent : m.id); } };
      }
    } catch (e) { el.innerHTML = `<div class="pane-empty">${esc(e.message)}</div>`; }
  }
}

// ---------- Modifications ----------
export function editTopic(ch) {
  const c = channel(ch);
  const m = modal({
    title: 'Sujet du canal', sub: `Affiché en haut de #${esc(ch)}, pour dire de quoi on parle en ce moment.`,
    body: `<label class="field"><span class="sr">Sujet</span><input name="topic" maxlength="250" value="${esc(c.topic)}" placeholder="Livraison de la v2 vendredi"></label>`,
    foot: '<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Enregistrer</button>',
  });
  const ok = $('[data-ok]', m.el);
  const save = () => busy(ok, async () => { try { await patch(`/api/channels/${encodeURIComponent(ch)}`, { topic: $('[name=topic]', m.el).value }); m.close(); } catch (e) { toast(e.message); } });
  ok.onclick = save;
  $('[name=topic]', m.el).addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
}
function editAbout(ch) {
  const c = channel(ch);
  const m = modal({
    title: 'Description du canal', sub: 'À quoi sert ce canal ? Elle s’affiche au début de son historique.',
    body: `<label class="field"><span class="sr">Description</span><textarea name="description" maxlength="1000" rows="4" placeholder="Les échanges de l’équipe technique : déploiements, incidents, revues de code.">${esc(c.description)}</textarea></label>`,
    foot: '<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Enregistrer</button>',
  });
  const ok = $('[data-ok]', m.el);
  ok.onclick = () => busy(ok, async () => { try { await patch(`/api/channels/${encodeURIComponent(ch)}`, { description: $('[name=description]', m.el).value }); m.close(); } catch (e) { toast(e.message); } });
}
function addMembers(ch) {
  const c = channel(ch);
  const candidates = people().filter(u => !c.members.includes(u.name));
  if (!candidates.length) return toast('Tout le monde est déjà dans ce canal');
  const m = modal({
    title: `Ajouter des personnes à #${ch}`,
    body: `<div class="pick-list">${candidates.map(u => `<label><input type="checkbox" value="${esc(u.name)}">${avatarHtml(u.name)}<span>${esc(nameOf(u.name))}</span></label>`).join('')}</div>`,
    foot: '<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Ajouter</button>',
  });
  const ok = $('[data-ok]', m.el);
  ok.onclick = () => busy(ok, async () => {
    const add = [...m.el.querySelectorAll('input:checked')].map(i => i.value);
    if (!add.length) return m.close();
    try { await post(`/api/channels/${encodeURIComponent(ch)}/members`, { add }); m.close(); toast(add.length > 1 ? `${add.length} personnes ajoutées` : `${nameOf(add[0])} a rejoint le canal`); }
    catch (e) { toast(e.message); }
  });
}
export async function leaveChannel(ch) {
  const c = channel(ch);
  if (c.private && !await confirmBox({ title: `Quitter #${ch} ?`, text: 'C’est un canal privé : il faudra qu’un membre t’y ajoute à nouveau pour revenir.', ok: 'Quitter', danger: true })) return;
  try {
    await post(`/api/channels/${encodeURIComponent(ch)}/leave`);
    if (paneIs('details', ch)) closePane();
    if (state.route.view === 'channel' && state.route.ch === ch) go({ view: 'channel', ch: 'general' });
    toast(`Tu as quitté #${ch}`);
  } catch (e) { toast(e.message); }
}
bus.on('leave-channel', leaveChannel);
async function archive(c) {
  if (!c.archived && !await confirmBox({ title: `Archiver #${c.name} ?`, text: 'Plus personne ne pourra y écrire. L’historique reste consultable, et le canal peut être désarchivé.', ok: 'Archiver', danger: true })) return;
  try { await patch(`/api/channels/${encodeURIComponent(c.name)}`, { archived: !c.archived }); toast(c.archived ? 'Canal désarchivé' : 'Canal archivé'); }
  catch (e) { toast(e.message); }
}

// ---------- Créer un canal ----------
export function createChannel(initial = '') {
  const m = modal({
    title: 'Créer un canal', sub: 'Un canal regroupe les échanges autour d’un sujet, d’un projet ou d’une équipe.',
    body: `<label class="field"><span>Nom</span><div class="input-prefix"><b>#</b><input name="name" maxlength="40" value="${esc(initial)}" placeholder="projet-site-web" autocomplete="off" spellcheck="false" autofocus></div><small>Minuscules, chiffres et tirets. Les espaces deviennent des tirets.</small></label>
      <label class="field"><span>Description <small>(facultatif)</small></span><input name="description" maxlength="1000" placeholder="De quoi parle-t-on ici ?"></label>
      <label class="check"><input type="checkbox" name="private"><span><b>Canal privé</b><small>Seules les personnes invitées peuvent le voir et le lire. Sinon, tout le monde peut le rejoindre.</small></span></label>
      <div data-invite hidden style="margin-top:14px"><div class="field" style="margin-bottom:6px"><span>Inviter</span></div>
        <div class="pick-list">${people().map(u => `<label><input type="checkbox" value="${esc(u.name)}">${avatarHtml(u.name)}<span>${esc(nameOf(u.name))}</span></label>`).join('') || '<p style="margin:6px;color:var(--muted)">Personne d’autre pour l’instant.</p>'}</div></div>
      <p class="form-error" hidden></p>`,
    foot: '<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Créer</button>',
  });
  const name = $('[name=name]', m.el), err = $('.form-error', m.el);
  name.addEventListener('input', () => {
    const pos = name.selectionStart;
    name.value = name.value.toLowerCase().replace(/\s/g, '-');
    name.selectionStart = name.selectionEnd = pos;
  });
  $('[name=private]', m.el).onchange = e => { $('[data-invite]', m.el).hidden = !e.target.checked; };
  const ok = $('[data-ok]', m.el);
  const submit = () => busy(ok, async () => {
    try {
      const c = await post('/api/channels', {
        name: name.value, description: $('[name=description]', m.el).value, private: $('[name=private]', m.el).checked,
        members: [...m.el.querySelectorAll('[data-invite] input:checked')].map(i => i.value),
      });
      state.channels.set(c.name, c);
      m.close();
      openConvo(c.name);
    } catch (e) { err.textContent = e.message; err.hidden = false; name.focus(); }
  });
  ok.onclick = submit;
  name.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}
bus.on('create-channel', createChannel);

