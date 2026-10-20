// LAN Chat — point d'entrée du navigateur. Vanilla JS en modules natifs, aucune dépendance, aucune compilation.
//
//   lib/    outils sans état : DOM, formats, Markdown, chiffrement (e2e.js), sons, emoji
//   core/   état et bus, appels au serveur, clés de chiffrement, temps réel, navigation par l'adresse
//   ui/     composants : barre latérale, messages, zone de saisie, panneau, menus et fenêtres, profils…
//   views/  la conversation affichée, et les vues transverses (fils, activité, plus tard, recherche…)
//   rtc/    appels audio, appels de groupe, partage d'écran (WebRTC)
import { $, isMac, desktop } from './lib/dom.js';
import { E2E } from './lib/e2e.js';
import { setResolver } from './lib/markdown.js';
import { state, bus } from './core/state.js';
import { setExpiredHandler } from './core/api.js';
import { connect, disconnect, onEvent } from './core/realtime.js';
import { startRouter, go, openConvo } from './core/router.js';
import { toast, topModal, menuOpen } from './ui/layer.js';
import { renderSidebar, renderMe, markConvoRead } from './ui/sidebar.js';
import { refreshMsg } from './ui/messages.js';
import { threadOnReply, threadOnUpdate, threadOnDelete, threadTyping, markThreadRead, openThread } from './ui/thread.js';
import { closePane, paneKind } from './ui/pane.js';
import { openSwitcher, jumpHint } from './ui/switcher.js';
import { applyAppearance, workspaceMenu, meMenu, preferences } from './ui/settings.js';
import { notify, notifyReminder } from './ui/notify.js';
import { showAuth, showInsecure } from './ui/auth.js';
import { confetti } from './ui/fx.js';
import { pickerOpen } from './ui/picker.js';
import { openChannel, renderTop, renderBanners, renderTyping, channelOnMessage, channelOnUpdate, channelOnDelete, channelChanged, markRead } from './views/channel.js';
import { openView } from './views/lists.js';
import './ui/actions.js';
import { Call } from './rtc/call.js';
import { Huddle } from './rtc/huddle.js';

applyAppearance();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
$('#jumpKbd').textContent = jumpHint;
setResolver({
  user: n => (state.users.has(n) ? state.users.get(n).displayName || n : null),
  channel: n => state.channels.has(n),
  get me() { return state.me; },
});

// ---------- Navigation ----------
function showRoute(r) {
  const app = $('#app');
  if (r.view === 'channel') {
    // Le panneau reste ouvert s'il concerne la conversation affichée (fil, détails) ou une personne
    const k = paneKind();
    if ((k === 'thread' && state.thread?.channel !== r.ch) || k === 'details') closePane();
    $('#mainComposer').hidden = false;
    openChannel(r.ch, r.msg);
  } else {
    $('#mainComposer').hidden = true;
    if (paneKind() === 'details') closePane();
    openView(r);
  }
  if (r.view !== 'channel' || r.msg) app.classList.add('in-convo');
  renderSidebar();
}
bus.on('route', showRoute);

// ---------- Temps réel -> interface ----------
let started = false;
bus.on('hello', () => {
  renderSidebar();
  if (!started) { started = true; startRouter(); }
  else showRoute(state.route); // reconnexion : on réaffiche ce qui était à l'écran
  if (state.thread) openThread(state.thread.id);
});
const visibleConvo = ch => state.route.view === 'channel' && state.route.ch === ch;
bus.on('message', m => {
  bus.emit('messages-changed');
  if ((m.text || '').includes('🎉') && m.user !== state.me) confetti();
  const shownInThread = m.parent ? threadOnReply(m) : false;
  const shownInList = !m.parent || m.broadcast ? channelOnMessage(m) : false;
  if (shownInList) markRead();
  notify(m, { visible: (visibleConvo(m.channel) && (!m.parent || m.broadcast)) || shownInThread });
  if (['threads', 'activity'].includes(state.route.view) && !document.hidden) openView(state.route);
  renderSidebar();
});
bus.on('update', m => {
  bus.emit('messages-changed');
  channelOnUpdate(m);
  threadOnUpdate(m);
  refreshMsg(m);
});
bus.on('message-updated', m => refreshMsg(m));
bus.on('delete', d => { bus.emit('messages-changed'); channelOnDelete(d); threadOnDelete(d); });
for (const ev of ['unread', 'read', 'prefs', 'presence', 'users', 'channels', 'saved', 'scheduled', 'drafts', 'rooms', 'workspace', 'pane']) bus.on(ev, renderSidebar);
bus.on('presence', () => { renderTop(); });
bus.on('users', name => { renderTop(); if (name === state.me) renderMe(); });
bus.on('rooms', () => {
  renderTop(); renderBanners();
  document.querySelectorAll('.msg').forEach(el => { if (el._msg?.call?.kind === 'group' && el._msg.call.status === 'started') refreshMsg(el._msg); });
});
bus.on('channel-changed', channelChanged);
bus.on('channel-gone', name => {
  if (visibleConvo(name)) { toast(`Tu n’as plus accès à #${name}`); go({ view: 'channel', ch: 'general' }, { replace: true }); }
  if (state.thread?.channel === name) closePane();
});
bus.on('key', ch => {
  delete state.cache[ch];
  if (visibleConvo(ch)) openChannel(ch);
  if (state.thread?.channel === ch) openThread(state.thread.id);
  toast(`Clé de chiffrement de #${ch} reçue`);
});
bus.on('typing', () => { renderTyping(); threadTyping(); });
setInterval(() => { renderTyping(); threadTyping(); }, 1500);
bus.on('saved', () => { if (state.route.view === 'later') openView(state.route); document.querySelectorAll('.msg').forEach(el => el._msg && !el._opts?.card && refreshMsg(el._msg)); });
bus.on('scheduled', d => { if (d.sent) toast('Ton message programmé vient d’être envoyé'); if (state.route.view === 'drafts') openView(state.route); });
bus.on('reminder', notifyReminder);
bus.on('kicked', () => logout('Ton compte a été désactivé.'));
bus.on('logout', () => logout());
onEvent('call', d => Call.onSignal(d));
onEvent('huddle', d => Huddle.onRoom(d));
onEvent('huddle-signal', d => Huddle.onSignal(d));
onEvent('rooms', list => Huddle.setRooms(list));

// ---------- Barre latérale : en-tête et pied ----------
$('#wsBtn').onclick = e => workspaceMenu(e.currentTarget);
$('#meBtn').onclick = e => meMenu(e.currentTarget);
$('#jumpBtn').onclick = () => openSwitcher();
$('#newMsgBtn').onclick = () => bus.emit('new-message');

// ---------- Raccourcis clavier ----------
function cycle(dir, unreadOnly) {
  const items = [...document.querySelectorAll('#sideNav .s-item[data-ch]')].filter(a => !unreadOnly || a.classList.contains('unread') || a.classList.contains('active'));
  const i = items.findIndex(a => a.classList.contains('active'));
  const next = items[(i + dir + items.length) % items.length];
  if (next && next !== items[i]) openConvo(next.dataset.ch);
}
document.addEventListener('keydown', e => {
  if (!state.me) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const typing = e.target.closest('input, textarea, [contenteditable]');
  if (mod && e.key.toLowerCase() === 'k' && !(typing && e.target.selectionStart !== e.target.selectionEnd)) {
    e.preventDefault();
    return e.shiftKey ? bus.emit('new-message') : openSwitcher();
  }
  if (mod && e.key === '/') { e.preventDefault(); return preferences('keys'); }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); return cycle(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey); }
  if (e.key === 'Escape' && !topModal() && !menuOpen() && !pickerOpen() && !document.querySelector('.lightbox')) {
    if (paneKind()) return closePane();
    if (state.route.view === 'channel' && !typing?.value) { markConvoRead(state.route.ch); document.querySelector('.unread-bar')?.remove(); }
  }
  // Taper n'importe où envoie le texte dans la zone de saisie
  if (!typing && !mod && !e.altKey && e.key.length === 1 && state.route.view === 'channel' && !topModal() && !menuOpen() && desktop()) {
    const ta = document.querySelector('#mainComposer textarea');
    if (ta && !ta.closest('[hidden]')) ta.focus();
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { markRead(); markThreadRead(); } });

// ---------- Session ----------
async function begin(s) {
  Object.assign(state, { me: s.name, token: s.token, priv: s.priv, pub: s.pub });
  $('#app').hidden = false;
  if ('Notification' in window && Notification.permission === 'default') setTimeout(() => Notification.requestPermission().catch(() => {}), 2500);
  connect();
}
let leaving = false;
async function logout(reason) {
  if (leaving) return;
  leaving = true;
  disconnect();
  try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token } }); } catch {}
  await E2E.clearSession();
  try { if (reason) sessionStorage.setItem('lanchat:flash', reason); } catch {}
  location.reload();
}
setExpiredHandler(logout);

(async () => {
  if (!E2E.available()) return showInsecure();
  const s = await E2E.loadSession();
  if (s?.token && s?.priv) return begin(s);
  let flash = '';
  try { flash = sessionStorage.getItem('lanchat:flash') || ''; sessionStorage.removeItem('lanchat:flash'); } catch {}
  begin(await showAuth({ flash }));
})();

