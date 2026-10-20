// Fil de discussion, dans le panneau de droite.
import { $, $$, h, desktop } from '../lib/dom.js';
import { plural } from '../lib/format.js';
import { state, bus, isDm, dmOther, label, nameOf } from '../core/state.js';
import { api, post } from '../core/api.js';
import { decryptAll } from '../core/keys.js';
import { renderMessage, renderList, appendToList } from './messages.js';
import { makeComposer, typingHtml } from './composer.js';
import { openPane, closePane, paneIs } from './pane.js';
import { toast } from './layer.js';
import { setupDrop } from './drop.js';

let composer = null, zones = null;

export async function openThread(id, flashId) {
  let data;
  try { data = await api(`/api/thread/${id}`); await decryptAll([data.parent, ...data.replies]); }
  catch (e) { return toast(e.message); }
  state.thread = { id, channel: data.parent.channel, parent: data.parent, replies: data.replies };
  zones = openPane({ kind: 'thread', key: id, title: 'Fil de discussion', sub: label(data.parent.channel), onClose: onClosed });
  composer = makeComposer(zones.foot, {
    target: () => ({ channel: state.thread.channel, parent: state.thread.id }),
    lastOwn: () => (state.thread?.replies || []).filter(m => m.user === state.me).at(-1),
    scope: '#pane',
    thread: true,
  });
  zones.foot.classList.add('composer-host');
  composer.setPlaceholder('Répondre…');
  composer.setBroadcastLabel(isDm(data.parent.channel) ? `Aussi à ${nameOf(dmOther(data.parent.channel))}` : `Aussi dans #${data.parent.channel}`);
  composer.load();
  setupDrop($('#pane'), () => composer, () => !!state.thread);
  $$('#msgs .msg.selected').forEach(el => el.classList.remove('selected'));
  $(`#msgs .msg[data-id="${id}"]`)?.classList.add('selected');
  render();
  markThreadRead();
  if (flashId) {
    const el = $(`#pane .msg[data-id="${flashId}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
  }
  if (desktop()) composer.focus();
}
function onClosed() {
  if (composer?.key) composer.load(); // range le brouillon
  state.thread = null; composer = null; zones = null;
  $$('#msgs .msg.selected').forEach(el => el.classList.remove('selected'));
}
export const closeThread = () => { if (paneIs('thread')) closePane(); };

function render({ stick = true } = {}) {
  const t = state.thread;
  if (!t || !zones) return;
  const box = zones.body;
  const top = box.scrollTop;
  box.innerHTML = '';
  box.appendChild(renderMessage(t.parent, null, { inThread: true, isParent: true }));
  box.appendChild(h(`<div class="th-count">${t.replies.length ? plural(t.replies.length, 'réponse', 'réponses') : 'Aucune réponse pour l’instant'}</div>`));
  renderList(box, t.replies, { inThread: true });
  box.scrollTop = stick ? box.scrollHeight : top;
}
export function markThreadRead() {
  const t = state.thread;
  if (!t || document.hidden) return;
  const last = t.replies.at(-1);
  state.threadUnread.delete(t.id);
  bus.emit('unread');
  if (last && last.id > (state.reads['t:' + t.id] || 0)) {
    state.reads['t:' + t.id] = last.id;
    post('/api/read', { key: 't:' + t.id, id: last.id }).catch(() => {});
  }
}

// ---------- Temps réel ----------
export function threadOnReply(m) {
  const t = state.thread;
  if (!t || t.id !== m.parent || t.replies.some(x => x.id === m.id)) return false;
  const box = zones.body;
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || m.user === state.me;
  const prev = t.replies.at(-1);
  t.replies.push(m);
  if (t.replies.length === 1) render(); else appendToList(box, m, prev, { inThread: true });
  const count = $('.th-count', box);
  if (count) count.textContent = plural(t.replies.length, 'réponse', 'réponses');
  if (stick) box.scrollTop = box.scrollHeight;
  if (!document.hidden) markThreadRead();
  return true;
}
export function threadOnUpdate(m) {
  const t = state.thread;
  if (!t) return;
  if (t.id === m.id) t.parent = m;
  const i = t.replies.findIndex(x => x.id === m.id);
  if (i >= 0) t.replies[i] = m;
}
export function threadOnDelete({ id, parent }) {
  const t = state.thread;
  if (!t) return;
  if (t.id === id) { closePane(); toast('Le fil a été supprimé'); }
  else if (t.id === parent) { t.replies = t.replies.filter(r => r.id !== id); render({ stick: false }); }
}
export const threadTyping = () => { if (composer && state.thread) composer.setTyping(typingHtml(`${state.thread.channel}|${state.thread.id}`)); };
