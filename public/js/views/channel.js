// Vue d'une conversation (canal ou message direct) : en-tête, bandeaux, historique, zone de saisie.
import { $, esc, icon, h, desktop } from '../lib/dom.js';
import { fmtOn, fmtTime, plural } from '../lib/format.js';
import { E2E } from '../lib/e2e.js';
import { state, bus, isDm, isSelf, dmOther, dmId, channel, isMember, nameOf, statusOf, label, user, isOnline, isDnd } from '../core/state.js';
import { api, post } from '../core/api.js';
import { decryptAll, ensureChannelKey, hasKey } from '../core/keys.js';
import { go } from '../core/router.js';
import { renderList, appendToList, refreshMsg } from '../ui/messages.js';
import { makeComposer, typingHtml } from '../ui/composer.js';
import { avatarHtml } from '../ui/avatar.js';
import { openProfile } from '../ui/profile.js';
import { openDetails, editTopic } from '../ui/details.js';
import { paneIs, closePane } from '../ui/pane.js';
import { toast, dropToasts } from '../ui/layer.js';
import { setupDrop } from '../ui/drop.js';
import { Call } from '../rtc/call.js';
import { Huddle } from '../rtc/huddle.js';

const box = $('#msgs');
let readMark = null;      // dernier id lu à l'ouverture (pour la ligne « Nouveaux »)
let pending = 0;          // messages arrivés pendant qu'on lisait plus haut
let loading = null;
const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 160;

export const mainComposer = makeComposer($('#mainComposer'), {
  target: () => ({ channel: state.route.ch, parent: null }),
  lastOwn: () => (state.cache[state.route.ch]?.messages || []).filter(m => m.user === state.me).at(-1),
  scope: '#msgs',
});
setupDrop($('#main'), () => (state.route.view === 'channel' && canWrite(state.route.ch) ? mainComposer : null), () => state.route.view === 'channel', 'Déposer pour envoyer');
const canWrite = ch => isDm(ch) ? !user(dmOther(ch)).deactivated : (channel(ch) && !channel(ch).archived);

// ---------- En-tête ----------
export function renderTop() {
  if (state.route.view !== 'channel') return;
  const ch = state.route.ch, c = channel(ch);
  const back = `<button type="button" class="icon-btn top-back" data-top="back" aria-label="Retour">${icon('back')}</button>`;
  let title, topic = '', tools = '';
  if (isDm(ch)) {
    const other = dmOther(ch), st = statusOf(other), u = user(other);
    title = `<button type="button" class="top-name" data-top="profile">${avatarHtml(other, { presence: !isSelf(ch) })}<span>${esc(nameOf(other))}${isSelf(ch) ? ' (toi)' : ''}</span>${st?.emoji ? `<span class="top-status" title="${esc(st.text || '')}">${st.emoji}</span>` : ''}</button>`;
    const bits = isSelf(ch) ? ['Ton espace personnel, chiffré avec ta clé']
      : [isDnd(other) ? 'Ne pas déranger' : isOnline(other) ? 'En ligne' : state.online.has(other) ? 'Absent' : 'Hors ligne', st?.text, u.title].filter(Boolean);
    topic = `<span class="top-topic">${esc(bits.join(' · '))}</span>`;
    if (!isSelf(ch) && !u.deactivated) tools = `<button type="button" class="icon-btn call-top" data-top="call" title="Appel audio" aria-label="Appel audio">${icon('phone')}</button>`;
  } else if (c) {
    title = `<button type="button" class="top-name" data-top="details">${icon(c.private ? 'lock' : 'hash')}<span>${esc(c.name)}</span>${icon('chev-down', 'sm')}</button>`;
    topic = c.topic ? `<button type="button" class="top-topic" data-top="topic" title="${esc(c.topic)}">${esc(c.topic)}</button>`
      : isMember(ch) && !c.archived ? `<button type="button" class="top-topic" data-top="topic">Ajouter un sujet</button>` : '';
    const members = c.members.filter(n => !user(n).deactivated);
    const pins = (state.cache[ch]?.messages || []).filter(m => m.pinned).length;
    const live = state.rooms[ch];
    tools = `<button type="button" class="facepile" data-top="members" aria-label="${plural(members.length, 'membre', 'membres')}"><span class="avs">${members.slice(0, 3).map(n => avatarHtml(n)).join('')}</span><span class="num">${members.length}</span></button>
      ${pins ? `<button type="button" class="icon-btn" data-top="pins" title="${plural(pins, 'message épinglé', 'messages épinglés')}" aria-label="Messages épinglés">${icon('pin')}</button>` : ''}
      ${c.archived ? '' : `<button type="button" class="icon-btn call-top${live ? ' live' : ''}" data-top="huddle" title="${live ? 'Rejoindre l’appel du canal' : 'Démarrer un appel de groupe'}" aria-label="${live ? 'Rejoindre l’appel du canal' : 'Démarrer un appel de groupe'}">${icon('headphones')}</button>`}`;
  } else title = `<span class="top-name"><span>${esc(label(ch))}</span></span>`;
  $('#top').innerHTML = `${back}<div class="top-title">${title}${topic}</div><span class="top-spacer"></span>
    <div class="top-tools">${tools}</div>${searchBox()}`;
}
export const searchBox = (q = '') => `<label class="searchbox">${icon('search', 'sm')}<input type="search" data-search value="${esc(q)}" placeholder="Rechercher" aria-label="Rechercher dans les messages" enterkeyhint="search"></label>`;

$('#top').addEventListener('click', e => {
  const b = e.target.closest('[data-top]');
  if (!b) return;
  const ch = state.route.ch;
  switch (b.dataset.top) {
    case 'back': $('#app').classList.remove('in-convo'); break;
    case 'profile': openProfile(dmOther(ch)); break;
    case 'details': paneIs('details', ch) ? closePane() : openDetails(ch, 'about'); break;
    case 'members': openDetails(ch, 'members'); break;
    case 'pins': openDetails(ch, 'pins'); break;
    case 'topic': editTopic(ch); break;
    case 'call': Call.start(dmOther(ch)); break;
    case 'huddle': Huddle.join(ch); break;
  }
});
// Recherche depuis l'en-tête (toutes les vues)
let searchTimer;
$('#top').addEventListener('input', e => {
  if (!e.target.matches('[data-search]')) return;
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => { if (q) go({ view: 'search', q }, { replace: state.route.view === 'search' }); }, 280);
});
$('#top').addEventListener('keydown', e => {
  if (!e.target.matches('[data-search]')) return;
  if (e.key === 'Enter' && e.target.value.trim()) { clearTimeout(searchTimer); go({ view: 'search', q: e.target.value.trim() }, { replace: state.route.view === 'search' }); }
  if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); }
});

// ---------- Bandeaux ----------
export function renderBanners() {
  const el = $('#banners');
  if (state.route.view !== 'channel') { el.innerHTML = ''; return; }
  const ch = state.route.ch, c = channel(ch), room = !isDm(ch) && state.rooms[ch];
  let html = '';
  if (room) {
    const inIt = Huddle.isIn(ch);
    html += `<div class="banner live"><span class="live-dot"></span><span><b>Appel en cours</b> · ${room.members.length}/8</span>
      <span class="hb-avs">${room.members.map(m => avatarHtml(m.user, { attrs: ` title="${esc(nameOf(m.user))}"` })).join('')}</span><span class="spacer"></span>
      ${inIt ? '<span style="font-size:13px;color:var(--muted)">Tu es dans l’appel</span>' : `<button type="button" class="btn sm primary" data-huddle-join="${esc(ch)}">Rejoindre</button>`}</div>`;
  }
  if (isDm(ch) ? !state.users.has(dmOther(ch)) : c && !hasKey(ch) && (c.private ? isMember(ch) : true)) {
    html += `<div class="banner">${icon('key')}<span>${isDm(ch) ? `${esc(dmOther(ch))} n’a pas encore de compte.` : `En attente de la clé de chiffrement de #${esc(ch)}. Elle arrivera automatiquement dès qu’un membre du canal sera connecté.`}</span></div>`;
  }
  el.innerHTML = html;
}

// ---------- Introduction (début de la conversation) ----------
function introEl(ch) {
  const c = channel(ch);
  if (isSelf(ch)) return h(`<div class="intro">${avatarHtml(state.me, { size: 's72' })}<h2>Ton espace perso</h2>
    <p>Garde ici tes notes, liens, bouts de code et fichiers. Tout est chiffré avec ta propre clé : <b>personne d’autre ne peut le lire</b>, et tu le retrouves sur tous tes appareils.</p></div>`);
  if (isDm(ch)) {
    const other = dmOther(ch);
    const el = h(`<div class="intro">${avatarHtml(other, { size: 's72' })}<h2>${esc(nameOf(other))}</h2>
      <p>Le début de ta conversation privée avec <b>${esc(nameOf(other))}</b>. Elle est chiffrée de bout en bout : vous seuls pouvez la lire.</p>
      <div class="intro-actions"><button type="button" class="btn sm" data-intro="profile">${icon('info', 'sm')}Voir le profil</button></div>
      <div class="safety">${icon('shield')}<span>Code de sécurité : <code>…</code><br>Comparez-le de vive voix : s’il est identique chez vous deux, personne ne s’est glissé entre vous.</span></div></div>`);
    const pub = state.users.get(other)?.pub;
    if (pub) E2E.safetyNumber(state.pub, pub).then(n => { $('.safety code', el).textContent = n; });
    else $('.safety', el).remove();
    $('[data-intro="profile"]', el).onclick = () => openProfile(other);
    return el;
  }
  const by = c?.createdBy ? `créé par ${esc(nameOf(c.createdBy))} ` : '';
  const el = h(`<div class="intro"><div class="intro-mark">${icon(c?.private ? 'lock' : 'hash')}</div><h2>${c?.private ? '' : '#'}${esc(ch)}</h2>
    <p>${c?.description ? esc(c.description) : `C’est le tout début du canal ${c?.private ? 'privé' : ''} <b>#${esc(ch)}</b>${by ? `, ${by}` : ''}${c?.created ? ` ${esc(fmtOn(c.created))}` : ''}.`}</p>
    <p style="color:var(--muted);font-size:14px">Les messages sont chiffrés de bout en bout. Mentionne <b>@tous</b> pour prévenir tout le canal ; survole un message pour y répondre dans un fil.</p>
    <div class="intro-actions">${isMember(ch) && !c?.archived ? `<button type="button" class="btn sm" data-intro="about">${icon('edit', 'sm')}${c?.description ? 'Modifier la description' : 'Ajouter une description'}</button>` : ''}
      ${c?.private && isMember(ch) ? `<button type="button" class="btn sm" data-intro="invite">${icon('user-plus', 'sm')}Ajouter des personnes</button>` : ''}</div></div>`);
  el.querySelector('[data-intro="about"]')?.addEventListener('click', () => openDetails(ch, 'about', true));
  el.querySelector('[data-intro="invite"]')?.addEventListener('click', () => openDetails(ch, 'members', true));
  return el;
}

// ---------- Ouverture ----------
export async function openChannel(ch, msgId = null) {
  const c = channel(ch);
  if (!isDm(ch) && !c) { toast('Ce canal n’existe pas ou tu n’y as pas accès'); return go({ view: 'channel', ch: 'general' }, { replace: true }); }
  if (isDm(ch) && ![state.me, dmOther(ch)].every(n => state.users.has(n))) { toast('Conversation introuvable'); return go({ view: 'channel', ch: dmId(state.me) }, { replace: true }); }
  if (isDm(ch)) state.dms.add(ch);
  dropToasts(ch);
  mainComposer.load();
  mainComposer.setPlaceholder(isSelf(ch) ? 'Note pour toi-même…' : `Écrire ${isDm(ch) ? 'à ' + nameOf(dmOther(ch)) : 'dans #' + ch}`);
  renderTop(); renderBanners(); renderFoot(); renderTyping();
  const first = !state.cache[ch] || (msgId && !state.cache[ch].messages.some(m => m.id === msgId));
  readMark = state.reads[ch] ?? null;
  if (!isDm(ch) && isMember(ch)) ensureChannelKey(ch).then(renderBanners).catch(() => {});
  if (first) {
    box.innerHTML = '';
    const token = loading = {};
    try {
      const data = await api(`/api/messages?channel=${encodeURIComponent(ch)}${msgId ? `&around=${msgId}` : ''}`);
      await decryptAll(data.messages);
      if (loading !== token) return;
      state.cache[ch] = data;
    } catch (e) { return toast(e.message); }
  }
  if (state.route.view !== 'channel' || state.route.ch !== ch) return;
  renderMessages({ msgId });
  renderTop();
  markRead();
  if (desktop() && !msgId && canWrite(ch) && isMember(ch)) mainComposer.focus();
}
function renderMessages({ keepScroll = false, msgId = null } = {}) {
  const ch = state.route.ch, data = state.cache[ch];
  const prevH = box.scrollHeight, prevTop = box.scrollTop;
  box.innerHTML = '';
  pending = 0; $('#newPill').hidden = true; $('.unread-bar')?.remove();
  if (!data) return;
  if (data.hasMore) box.appendChild(h(`<div class="more-btn"><button type="button" class="btn sm" data-more>Charger les messages précédents</button></div>`));
  else box.appendChild(introEl(ch));
  const line = renderList(box, data.messages, { readMark });
  if (data.hasNewer) box.appendChild(h(`<div class="more-btn"><button type="button" class="btn sm" data-latest>Aller aux messages récents</button></div>`));
  if (msgId) {
    const el = $(`.msg[data-id="${msgId}"]`, box);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
  } else if (keepScroll) box.scrollTop = box.scrollHeight - prevH + prevTop;
  else if (line && line.offsetTop > box.clientHeight - 80) {
    box.scrollTop = line.offsetTop - 120;
    const n = data.messages.filter(m => m.id > readMark && m.user !== state.me).length;
    const first = data.messages.find(m => m.id > readMark && m.user !== state.me);
    $('#main').appendChild(h(`<div class="unread-bar" role="status"><span>${plural(n, 'nouveau message', 'nouveaux messages')} depuis ${fmtTime(first.ts)}</span>
      <button type="button" data-ub="jump">Voir</button><button type="button" data-ub="read">Marquer comme lu</button></div>`));
  } else box.scrollTop = box.scrollHeight;
}
box.addEventListener('click', async e => {
  if (e.target.closest('[data-more]')) {
    const ch = state.route.ch, data = state.cache[ch];
    const older = await api(`/api/messages?channel=${encodeURIComponent(ch)}&before=${data.messages[0]?.id || ''}`);
    await decryptAll(older.messages);
    data.messages = [...older.messages, ...data.messages];
    data.hasMore = older.hasMore;
    renderMessages({ keepScroll: true });
  }
  if (e.target.closest('[data-latest]')) { delete state.cache[state.route.ch]; openChannel(state.route.ch); }
});
$('#main').addEventListener('click', e => {
  const b = e.target.closest('[data-ub]');
  if (!b) return;
  if (b.dataset.ub === 'jump') $('.new-line', box)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  b.closest('.unread-bar').remove();
  markRead(true);
});

// ---------- Bas de page : saisie, ou bouton « Rejoindre », ou lecture seule ----------
function renderFoot() {
  const ch = state.route.ch, c = channel(ch), host = $('#mainComposer');
  $('.join-bar, .readonly-bar', host)?.remove();
  const composer = $('.composer', host), under = $('.c-under', host);
  let bar = '';
  if (c?.archived) bar = `<div class="readonly-bar">${icon('archive')}<span>Ce canal est archivé : tu peux lire son historique, mais plus y écrire.</span></div>`;
  else if (isDm(ch) && user(dmOther(ch)).deactivated) bar = `<div class="readonly-bar">${icon('lock')}<span>Ce compte a été désactivé.</span></div>`;
  else if (c && !isMember(ch)) bar = `<div class="join-bar"><span>Tu consultes <b>#${esc(ch)}</b>${c.topic ? ` · ${esc(c.topic)}` : ''}</span><button type="button" class="btn primary" data-join>Rejoindre le canal</button></div>`;
  composer.hidden = under.hidden = !!bar;
  if (bar) host.insertAdjacentHTML('afterbegin', bar);
  $('[data-join]', host)?.addEventListener('click', async () => {
    try { await post(`/api/channels/${encodeURIComponent(ch)}/join`); toast(`Tu as rejoint #${ch}`); } catch (e) { toast(e.message); }
  });
}

// ---------- Lus ----------
let readTimer;
export function markRead(force = false) {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    if (state.route.view !== 'channel' || document.hidden) return;
    const ch = state.route.ch, data = state.cache[ch];
    if (!data || data.hasNewer || (!force && !nearBottom())) return;
    const last = data.messages.at(-1);
    state.unread[ch] = { count: 0, mentions: 0 };
    bus.emit('unread');
    if (last && last.id > (state.reads[ch] || 0)) {
      state.reads[ch] = last.id;
      post('/api/read', { key: ch, id: last.id }).catch(() => {});
    }
  }, force ? 0 : 500);
}
box.addEventListener('scroll', () => {
  if (state.route.view !== 'channel') return;
  if (nearBottom()) { if (pending) { pending = 0; $('#newPill').hidden = true; } markRead(); }
}, { passive: true });
$('#newPill').onclick = () => { box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); pending = 0; $('#newPill').hidden = true; };

// ---------- Temps réel ----------
export function channelOnMessage(m) {
  const data = state.cache[m.channel];
  if (data && !data.hasNewer && !data.messages.some(x => x.id === m.id)) {
    const prev = data.messages.at(-1);
    data.messages.push(m);
    if (state.route.view === 'channel' && state.route.ch === m.channel) {
      const stick = nearBottom() || m.user === state.me;
      appendToList(box, m, prev);
      if (stick) {
        box.scrollTop = box.scrollHeight;
        box.lastElementChild?.querySelectorAll('img').forEach(img => img.addEventListener('load', () => { if (nearBottom()) box.scrollTop = box.scrollHeight; }, { once: true }));
      } else if (m.user !== state.me) {
        pending++;
        $('#newPill').innerHTML = `${icon('down', 'sm')}${plural(pending, 'nouveau message', 'nouveaux messages')}`;
        $('#newPill').hidden = false;
      }
      if (m.pinned) renderTop();
      return !document.hidden && (stick || m.user === state.me);
    }
  }
  return false;
}
export function channelOnUpdate(m) {
  const data = state.cache[m.channel];
  const i = data ? data.messages.findIndex(x => x.id === m.id) : -1;
  const pinChanged = i >= 0 && !!data.messages[i].pinned !== !!m.pinned;
  if (i >= 0) data.messages[i] = m;
  refreshMsg(m);
  if (pinChanged && state.route.ch === m.channel) renderTop();
}
export function channelOnDelete({ id, channel: ch }) {
  const data = state.cache[ch];
  if (data) data.messages = data.messages.filter(m => m.id !== id);
  if (state.route.view === 'channel' && state.route.ch === ch) {
    // On reconstruit la liste : le message suivant reprend son en-tête si besoin
    if ($(`#msgs .msg[data-id="${id}"]`)) renderMessages({ keepScroll: true });
  }
}
export function renderTyping() {
  mainComposer.setTyping(state.route.view === 'channel' ? typingHtml(`${state.route.ch}|0`) : '');
}
// Rafraîchissement quand un canal change (sujet, membres, archivage)
export function channelChanged(name) {
  if (state.route.view === 'channel' && state.route.ch === name) { renderTop(); renderBanners(); renderFoot(); }
}
