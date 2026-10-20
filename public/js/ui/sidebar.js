// Barre latérale : raccourcis (fils, activité, plus tard, brouillons), favoris, canaux, messages directs.
import { $, esc, icon, on, copyText, morph } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { state, bus, isDm, isSelf, dmId, nameOf, statusOf, prefOf, people, label } from '../core/state.js';
import { post } from '../core/api.js';
import { hrefOf, linkToMessage } from '../core/router.js';
import { menu, toast } from './layer.js';
import { avatarHtml } from './avatar.js';
import { drafts } from './composer.js';

const collapsed = new Set(store.json('collapsed', []));
const unreadOf = ch => state.unread[ch] || { count: 0, mentions: 0 };
// Pastille : nombre de messages pour une conversation privée, de mentions pour un canal
const badgeOf = ch => isDm(ch) ? unreadOf(ch).count : unreadOf(ch).mentions;
const active = r => (state.route.view === 'channel' ? state.route.ch === r.ch && r.view === 'channel' : state.route.view === r.view);

function item(r, inner, { ch, unread = false, badge = 0, cls = '' } = {}) {
  const pref = ch ? prefOf(ch) : {};
  return `<a class="s-item${active(r) ? ' active' : ''}${unread ? ' unread' : ''}${pref.muted ? ' muted' : ''}${cls ? ' ' + cls : ''}" href="${hrefOf(r)}"${ch ? ` data-ch="${esc(ch)}"` : ''}${active(r) ? ' aria-current="page"' : ''}>
    ${inner}${badge ? `<span class="badge" aria-label="${badge} non lu${badge > 1 ? 's' : ''}">${badge > 99 ? '99+' : badge}</span>` : ''}</a>`;
}
function channelItem(c) {
  const u = unreadOf(c.name);
  const live = state.rooms[c.name];
  return item({ view: 'channel', ch: c.name },
    `<span class="s-ic">${icon(c.private ? 'lock' : 'hash')}</span><span class="s-name">${esc(c.name)}</span>${live ? `<span class="s-live" title="Appel en cours">${icon('headphones')}</span>` : ''}`,
    { ch: c.name, unread: u.count > 0 && !prefOf(c.name).muted, badge: u.mentions, cls: c.archived ? 'archived' : '' });
}
function dmItem(name) {
  const ch = dmId(name), u = unreadOf(ch), st = statusOf(name);
  const self = name === state.me;
  return item({ view: 'channel', ch },
    `<span class="s-ic">${avatarHtml(name, { presence: !self })}</span><span class="s-name">${esc(nameOf(name))}${self ? ' <small>toi</small>' : ''}</span>${st?.emoji ? `<span class="s-emoji" title="${esc(st.text || '')}">${st.emoji}</span>` : ''}`,
    { ch, unread: u.count > 0, badge: u.count });
}
function section(id, title, body, add) {
  return `<div class="s-sec${collapsed.has(id) ? ' collapsed' : ''}" data-sec="${id}">
    <div class="s-sec-head"><button type="button" class="s-sec-toggle" aria-expanded="${!collapsed.has(id)}">${icon('chev-down')}<span>${title}</span></button>
    ${add ? `<button type="button" class="s-sec-add" data-add="${id}" aria-label="${esc(add)}" title="${esc(add)}">${icon('plus')}</button>` : ''}</div>${body}</div>`;
}

export function renderSidebar() {
  if (!state.me) return;
  const mentions = Object.entries(state.unread).filter(([ch]) => !isDm(ch)).reduce((n, [, u]) => n + u.mentions, 0);
  const draftCount = Object.keys(drafts.all()).length + state.scheduledCount;
  const nav = [
    item({ view: 'threads' }, `<span class="s-ic">${icon('thread')}</span><span class="s-name">Fils de discussion</span>`, { unread: state.threadUnread.size > 0, badge: state.threadUnread.size }),
    item({ view: 'activity' }, `<span class="s-ic">${icon('activity')}</span><span class="s-name">Activité</span>`, { unread: mentions > 0, badge: mentions }),
    item({ view: 'later' }, `<span class="s-ic">${icon('bookmark')}</span><span class="s-name">Plus tard</span>${state.saved.size ? `<span class="s-name" style="flex:none"><small>${state.saved.size}</small></span>` : ''}`),
    item({ view: 'drafts' }, `<span class="s-ic">${icon('draft')}</span><span class="s-name">Brouillons et envois</span>${draftCount ? `<span class="s-name" style="flex:none"><small>${draftCount}</small></span>` : ''}`),
  ].join('');

  const mine = [...state.channels.values()].filter(c => c.members.includes(state.me) && (!c.archived || unreadOf(c.name).count || state.route.ch === c.name));
  const humans = people().filter(u => !prefOf(dmId(u.name)).hidden || unreadOf(dmId(u.name)).count);
  const starred = [
    ...mine.filter(c => prefOf(c.name).starred).map(channelItem),
    ...[state.me, ...humans.map(u => u.name)].filter(n => prefOf(dmId(n)).starred).map(dmItem),
  ];
  const channels = mine.filter(c => !prefOf(c.name).starred).sort((a, b) => a.name.localeCompare(b.name)).map(channelItem);
  const dms = [state.me, ...humans.map(u => u.name)].filter(n => !prefOf(dmId(n)).starred).map(dmItem);

  morph($('#sideNav'), `<div class="s-nav-group">${nav}</div>
    ${starred.length ? section('starred', 'Favoris', starred.join('')) : ''}
    ${section('channels', 'Canaux', channels.join('') + item({ view: 'browse' }, `<span class="s-ic">${icon('plus')}</span><span class="s-name s-more">Parcourir les canaux</span>`), 'Créer un canal')}
    ${section('dms', 'Messages directs', dms.join('') + (humans.length ? '' : `<p class="s-hint">Personne d’autre pour l’instant. Invite tes collègues depuis le menu ${esc(state.workspace.name)}.</p>`), 'Nouveau message')}`);

  renderMe();
  const total = Object.entries(state.unread).reduce((n, [ch, u]) => n + (isDm(ch) ? u.count : u.mentions), 0) + state.threadUnread.size;
  document.title = `${total ? `(${total}) ` : ''}${state.route.view === 'channel' ? label(state.route.ch) + ' · ' : ''}${state.workspace.name}`;
}
export function renderMe() {
  const st = statusOf(state.me);
  const u = state.users.get(state.me);
  const dnd = (u?.dndUntil || 0) > Date.now();
  $('#meBtn').innerHTML = `${avatarHtml(state.me, { presence: true })}<span class="me-text"><b>${esc(nameOf(state.me))}</b>
    <span>${st ? `${st.emoji || ''} ${esc(st.text || '')}` : dnd ? 'Notifications en pause' : u?.away ? 'Absent' : 'En ligne'}</span></span>`;
  $('#meBtn').setAttribute('aria-label', `Ton profil et tes préférences : ${nameOf(state.me)}`);
  $('#wsName').textContent = state.workspace.name;
}

// ---------- Interactions ----------
on($('#sideNav'), 'click', '.s-sec-toggle', (e, b) => {
  const id = b.closest('.s-sec').dataset.sec;
  collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
  store.setJson('collapsed', [...collapsed]);
  b.closest('.s-sec').classList.toggle('collapsed');
  b.setAttribute('aria-expanded', !collapsed.has(id));
});
on($('#sideNav'), 'click', '.s-sec-add', (e, b) => {
  e.stopPropagation();
  if (b.dataset.add === 'channels') menu(b, [
    { label: 'Créer un canal', icon: 'plus', run: () => bus.emit('create-channel') },
    { label: 'Parcourir les canaux', icon: 'hash', run: () => { location.hash = '#/browse'; } },
  ]);
  else bus.emit('new-message');
});
on($('#sideNav'), 'click', '.s-item', () => $('#app').classList.add('in-convo'));
on($('#sideNav'), 'contextmenu', '.s-item[data-ch]', (e, a) => { e.preventDefault(); convoMenu({ x: e.clientX, y: e.clientY }, a.dataset.ch); });

export async function setPref(ch, patch) {
  state.prefs[ch] = { ...prefOf(ch), ...patch };
  renderSidebar();
  try { await post('/api/prefs', { channel: ch, ...patch }); } catch (e) { toast(e.message); }
}
export async function markConvoRead(ch) {
  state.unread[ch] = { count: 0, mentions: 0 };
  bus.emit('unread');
  await post('/api/read', { key: ch, latest: true }).catch(() => {});
}

// Menu d'une conversation : favori, sourdine, marquer lu, quitter / fermer
export function convoMenu(anchor, ch) {
  const pref = prefOf(ch);
  const c = state.channels.get(ch);
  menu(anchor, [
    { label: pref.starred ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: pref.starred ? 'star-on' : 'star', run: () => setPref(ch, { starred: !pref.starred }) },
    { label: pref.muted ? 'Réactiver les notifications' : 'Mettre en sourdine', icon: pref.muted ? 'bell' : 'bell-off', run: () => setPref(ch, { muted: !pref.muted }) },
    unreadOf(ch).count ? { label: 'Marquer comme lu', icon: 'check', hint: 'Échap', run: () => markConvoRead(ch) } : null,
    { label: 'Copier le lien', icon: 'link', run: () => { copyText(linkToMessage(ch)); toast('Lien copié'); } },
    '-',
    isDm(ch) && !isSelf(ch) ? { label: 'Fermer la conversation', icon: 'eye-off', run: () => setPref(ch, { hidden: true }) } : null,
    c && ch !== 'general' ? { label: `Quitter #${ch}`, icon: 'door', danger: true, run: () => bus.emit('leave-channel', ch) } : null,
  ]);
}
