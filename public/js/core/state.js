// État de l'application (une seule source de vérité) et petites fonctions pour le lire.
// Les modules s'abonnent aux changements via `bus` : bus.on('channels', render) / bus.emit('channels').
export const state = {
  me: '', token: '', priv: null, pub: '',
  workspace: { name: 'LAN Chat' },
  users: new Map(),       // pseudo -> { name, pub, role, displayName, title, status, dndUntil, away, avatar, deactivated }
  channels: new Map(),    // nom -> { name, topic, description, private, archived, createdBy, created, members: [] }
  dms: new Set(),         // conversations privées existantes ("@a|b")
  online: new Set(),
  prefs: {},              // conversation -> { starred, muted, hidden }
  reads: {},              // conversation | "t:<id>" -> dernier id lu
  unread: {},             // conversation -> { count, mentions }
  threadUnread: new Set(),
  saved: new Set(),       // ids des messages enregistrés (« Plus tard »)
  scheduledCount: 0,
  chKeys: new Map(),      // canal -> { raw, key } (clé AES du canal, en mémoire seulement)
  holders: {},            // canal -> comptes qui ont reçu la clé
  rooms: {},              // canal -> appel de groupe en cours
  route: { view: 'channel', ch: 'general', msg: null },
  cache: {},              // conversation -> { messages, hasMore, hasNewer }
  thread: null,           // { id, channel, parent, replies }
  typers: new Map(),      // "conversation|parent" -> Map(pseudo -> expiration)
};

// ---------- Bus d'événements ----------
const handlers = new Map();
export const bus = {
  on(name, fn) { (handlers.get(name) || handlers.set(name, new Set()).get(name)).add(fn); },
  emit(name, data) { handlers.get(name)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
};

// ---------- Conversations ----------
export const isDm = ch => ch.startsWith('@');
export const dmId = other => '@' + [state.me, other].sort().join('|');
export const dmOther = ch => ch.slice(1).split('|').find(n => n !== state.me) || state.me;
export const isSelf = ch => isDm(ch) && dmOther(ch) === state.me;
export const channel = ch => state.channels.get(ch) || null;
export const isMember = ch => isDm(ch) || !!channel(ch)?.members.includes(state.me);
export const prefOf = ch => state.prefs[ch] || { starred: false, muted: false, hidden: false };

// ---------- Personnes ----------
export const user = name => state.users.get(name) || { name, displayName: '', title: '', status: null, avatar: 0 };
export const nameOf = name => user(name).displayName || name;
export const isAdmin = (name = state.me) => ['owner', 'admin'].includes(user(name).role);
export const isOnline = name => state.online.has(name) && !user(name).away;
export const isDnd = name => (user(name).dndUntil || 0) > Date.now();
export const statusOf = name => {
  const s = user(name).status;
  return s && (!s.until || s.until > Date.now()) ? s : null;
};
// Libellé lisible d'une conversation
export const label = ch => isSelf(ch) ? `${nameOf(state.me)} (toi)` : isDm(ch) ? nameOf(dmOther(ch)) : '#' + ch;
export const people = () => [...state.users.values()]
  .filter(u => !u.deactivated && u.name !== state.me)
  .sort((a, b) => nameOf(a.name).localeCompare(nameOf(b.name), 'fr'));

// Message qui me concerne directement
export const mentionsMe = m => m.user !== state.me && (isDm(m.channel) || (m.mentions || []).includes(state.me) || (m.mentions || []).includes('here'));
