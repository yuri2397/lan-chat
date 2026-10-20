// Temps réel : flux Server-Sent Events. Chaque événement met à jour l'état puis prévient l'interface (bus).
// Les événements sont traités dans l'ordre, l'un après l'autre (le déchiffrement est asynchrone).
import { $ } from '../lib/dom.js';
import { state, bus, isDm, isMember, mentionsMe } from './state.js';
import { api } from './api.js';
import { applyKeys, reloadKeys, scheduleShare, decryptMsg } from './keys.js';
import { DEVICE_ID } from './device.js';

let es = null;
const handlers = {};
export const onEvent = (name, fn) => { handlers[name] = fn; };

export function connect() {
  es?.close();
  es = new EventSource(`/api/events?${new URLSearchParams({ token: state.token, device: DEVICE_ID })}`);
  es.onopen = () => { $('#offline').hidden = true; };
  es.onerror = () => {
    $('#offline').hidden = false;
    // Flux fermé définitivement (ex. session expirée) : on vérifie la session puis on retente
    if (es.readyState === EventSource.CLOSED) setTimeout(() => api('/api/users').then(connect).catch(() => setTimeout(connect, 4000)), 2000);
  };
  let queue = Promise.resolve();
  for (const name of ['hello', 'presence', 'user', 'channel', 'channel-gone', 'keys', 'typing', 'message', 'update', 'delete',
    'read', 'prefs', 'saved', 'scheduled', 'reminder', 'workspace', 'call', 'huddle', 'huddle-signal', 'kicked']) {
    es.addEventListener(name, e => {
      queue = queue.then(() => (core[name] || handlers[name])?.(JSON.parse(e.data))).catch(err => console.error(name, err));
    });
  }
}
export const disconnect = () => { es?.close(); es = null; };

// Mises à jour de l'état ; l'interface réagit via le bus.
const core = {
  async hello(d) {
    state.workspace = d.workspace;
    state.users = new Map(d.users.map(u => [u.name, u]));
    state.channels = new Map(d.channels.map(c => [c.name, c]));
    state.online = new Set(d.online);
    state.prefs = d.prefs; state.reads = d.reads; state.unread = d.unread;
    state.threadUnread = new Set(d.threads);
    state.saved = new Set(d.saved);
    state.scheduledCount = d.scheduled;
    d.dms.forEach(ch => state.dms.add(ch));
    state.cache = {}; // après une reconnexion on recharge tout, pour récupérer ce qu'on a raté
    handlers.rooms?.(d.rooms);
    (await applyKeys(d.keys));
    scheduleShare();
    bus.emit('hello');
  },
  presence(d) { state.online = new Set(d.online); bus.emit('presence'); },
  user(u) {
    const fresh = !state.users.has(u.name);
    state.users.set(u.name, u);
    bus.emit('users', u.name);
    if (fresh) scheduleShare();
  },
  async channel(c) {
    const before = state.channels.get(c.name);
    state.channels.set(c.name, c);
    bus.emit('channels');
    bus.emit('channel-changed', c.name);
    // Nouveau membre d'un canal privé, ou nouveau canal : il faudra sa clé ; on partage la nôtre avec les nouveaux venus
    if (!before || before.members.length !== c.members.length) scheduleShare();
    if (c.members.includes(state.me) && !state.chKeys.has(c.name)) (await reloadKeys()).forEach(ch => bus.emit('key', ch));
  },
  'channel-gone'({ name }) {
    state.channels.delete(name);
    delete state.cache[name];
    delete state.unread[name];
    bus.emit('channels');
    bus.emit('channel-gone', name);
  },
  async keys({ channel, holders }) {
    state.holders[channel] = holders;
    if (holders.includes(state.me) && !state.chKeys.has(channel)) (await reloadKeys()).forEach(ch => bus.emit('key', ch));
    if (state.chKeys.has(channel)) scheduleShare();
  },
  typing({ user, channel, parent }) {
    if (user === state.me) return;
    const key = `${channel}|${parent || 0}`;
    if (!state.typers.has(key)) state.typers.set(key, new Map());
    state.typers.get(key).set(user, Date.now() + 4500);
    bus.emit('typing');
  },
  async message(m) {
    await decryptMsg(m);
    state.typers.get(`${m.channel}|${m.parent || 0}`)?.delete(m.user);
    if (isDm(m.channel)) {
      state.dms.add(m.channel);
      if (state.prefs[m.channel]?.hidden) state.prefs[m.channel].hidden = false; // une conversation fermée se rouvre
    }
    // Compteurs : l'interface remet à zéro ce qui est affiché et lu (voir main.js)
    const mine = m.user === state.me;
    if (!mine && (!m.parent || m.broadcast) && isMember(m.channel)) {
      const u = state.unread[m.channel] || (state.unread[m.channel] = { count: 0, mentions: 0 });
      u.count++;
      if (mentionsMe(m)) u.mentions++;
    }
    if (!mine && m.parent && (m.participants || []).includes(state.me)) state.threadUnread.add(m.parent);
    bus.emit('message', m);
  },
  async update(m) { await decryptMsg(m); bus.emit('update', m); },
  delete(d) { bus.emit('delete', d); },
  read({ key, id, unread }) {
    state.reads[key] = id;
    const u = unread || { count: 0, mentions: 0 };
    if (key.startsWith('t:')) { if (u.count) state.threadUnread.add(Number(key.slice(2))); else state.threadUnread.delete(Number(key.slice(2))); }
    else state.unread[key] = u;
    bus.emit('read', key);
  },
  prefs({ channel, pref }) { state.prefs[channel] = pref; bus.emit('prefs'); },
  saved(s) {
    if (s.removed || s.done) state.saved.delete(s.id); else state.saved.add(s.id);
    bus.emit('saved', s);
  },
  scheduled(d) { state.scheduledCount = d.count; bus.emit('scheduled', d); },
  async reminder(s) { await decryptMsg(s.message); bus.emit('reminder', s); },
  workspace(w) { state.workspace = w; bus.emit('workspace'); },
  kicked() { bus.emit('kicked'); },
};
