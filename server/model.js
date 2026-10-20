// État du serveur, gardé en mémoire pour la rapidité ; chaque changement est écrit aussitôt dans la base (db.js).
//
// Conversations :
//   - canal          "general", "projet-x"…  (public : tout le monde peut le lire et le rejoindre ; privé : membres seulement)
//   - message direct "@alice|bob"            (noms triés ; "@alice|alice" = notes personnelles)
// Message : { id, channel, user, enc: { iv, ct }, ts, parent?, broadcast?, edited?, reactions?, mentions?, pinned?, file?: { id, size } }
// (les anciens messages d'avant le chiffrement ont un champ `text` en clair)
const M = {
  db: null,
  users: {},        // nom -> { authSalt, authHash, kdfSalt, pub, encPriv, created, role, deactivated, profile, avatar }
  sessions: {},     // sha256(jeton) -> { user, created }
  chanKeys: {},     // canal -> { destinataire -> { from, fromPub, wrapped } }
  channels: new Map(), // nom -> { name, created, topic, description, private, archived, createdBy }
  members: new Map(),  // canal -> Set(noms)
  prefs: {},        // nom -> { conversation -> { starred, muted, hidden } }
  reads: {},        // nom -> { conversation | "t:<id du fil>" -> dernier id lu }
  saved: {},        // nom -> Map(id du message -> { ts, remindAt, reminded, done })
  scheduled: new Map(), // id -> { id, user, channel, parent, enc, mentions, at, created }
  messages: [],
  byId: new Map(),
  replies: new Map(), // id du parent -> [réponses]
  nextId: 1,
  pendingFiles: new Map(), // fichiers envoyés mais pas encore rattachés à un message : id -> { user, size, ts }
  accessCode: '',
  workspace: { name: 'LAN Chat' },
};

M.init = (db, loaded) => {
  M.db = db;
  M.users = loaded.users;
  M.sessions = loaded.sessions;
  M.chanKeys = loaded.chanKeys;
  M.channels = new Map(loaded.channels.map(c => [c.name, c]));
  M.members = new Map(loaded.channels.map(c => [c.name, loaded.members[c.name] || new Set()]));
  M.prefs = loaded.prefs;
  M.reads = loaded.reads;
  M.saved = loaded.saved;
  M.scheduled = new Map(loaded.scheduled.map(s => [s.id, s]));
  loaded.messages.forEach(M.addToIndex);
};

// ---------- Comptes ----------
M.active = name => !!M.users[name] && !M.users[name].deactivated;
M.isAdmin = name => ['owner', 'admin'].includes(M.users[name]?.role);
// Ce que tout le monde peut savoir d'un compte (l'annuaire)
M.userView = name => {
  const u = M.users[name];
  const p = u.profile || {};
  const status = p.status && (!p.status.until || p.status.until > Date.now()) ? p.status : null;
  return {
    name, pub: u.pub, role: u.role, deactivated: !!u.deactivated, created: u.created,
    displayName: p.displayName || '', title: p.title || '', status,
    dndUntil: p.dndUntil && p.dndUntil > Date.now() ? p.dndUntil : null,
    away: !!p.away, avatar: u.avatar ? p.avatarKey || '' : '',
  };
};
M.saveUser = name => M.db.write(M.db.S.saveUser(name, M.users[name]));

// ---------- Conversations ----------
M.isDm = ch => ch.startsWith('@');
M.dmMembers = ch => ch.slice(1).split('|');
M.dmId = (a, b) => '@' + [a, b].sort().join('|');
M.channel = ch => M.channels.get(ch) || null;
M.isMember = (user, ch) => M.isDm(ch) ? M.dmMembers(ch).includes(user) : !!M.members.get(ch)?.has(user);
// Lire une conversation
M.canSee = (user, ch) => {
  if (M.isDm(ch)) return M.dmMembers(ch).includes(user);
  const c = M.channels.get(ch);
  return !!c && (!c.private || M.members.get(ch).has(user));
};
M.validDm = ch => {
  const names = M.dmMembers(ch);
  return M.isDm(ch) && names.length === 2 && names.every(n => M.users[n]) && M.dmId(names[0], names[1]) === ch;
};
M.validConvo = ch => M.channels.has(ch) || M.validDm(ch);
M.keyHolders = ch => Object.keys(M.chanKeys[ch] || {});
M.channelView = c => ({ ...c, members: [...(M.members.get(c.name) || [])] });
// Canaux visibles : publics + privés dont on est membre
M.visibleChannels = user => [...M.channels.values()].filter(c => M.canSee(user, c.name));

// ---------- Messages ----------
M.addToIndex = m => {
  M.messages.push(m);
  M.byId.set(m.id, m);
  if (m.parent) {
    if (!M.replies.has(m.parent)) M.replies.set(m.parent, []);
    M.replies.get(m.parent).push(m);
  }
};
M.removeFromIndex = m => {
  const i = M.messages.lastIndexOf(m);
  if (i >= 0) M.messages.splice(i, 1);
  M.byId.delete(m.id);
  if (m.parent && M.replies.has(m.parent)) {
    const list = M.replies.get(m.parent).filter(r => r !== m);
    if (list.length) M.replies.set(m.parent, list); else M.replies.delete(m.parent);
  }
};
M.toggleReaction = (m, emoji, user) => {
  m.reactions = m.reactions || {};
  const list = m.reactions[emoji] || [];
  m.reactions[emoji] = list.includes(user) ? list.filter(u => u !== user) : [...list, user];
  if (!m.reactions[emoji].length) delete m.reactions[emoji];
  if (!Object.keys(m.reactions).length) delete m.reactions;
};
// Ajoute le résumé du fil (nombre de réponses, participants, dernière réponse) à un message.
M.out = m => {
  const r = M.replies.get(m.id);
  if (!r || !r.length) return m;
  const names = [...new Set(r.map(x => x.user))];
  return { ...m, thread: { count: r.length, users: names.slice(-5), lastTs: r[r.length - 1].ts, lastId: r[r.length - 1].id } };
};
M.participants = parentId => {
  const p = M.byId.get(parentId);
  return [...new Set([p && p.user, ...(M.replies.get(parentId) || []).map(r => r.user)].filter(Boolean))];
};
// Mentions : liste de pseudos, plus "here" pour @tous / @here / @channel
M.cleanMentions = list => Array.isArray(list)
  ? [...new Set(list.map(String).filter(n => n === 'here' || M.users[n]))].slice(0, 50)
  : [];
M.mentions = (m, user) => M.isDm(m.channel) || (m.mentions || []).includes(user) || (m.mentions || []).includes('here');

// ---------- Préférences, lus, « Plus tard » ----------
M.prefOf = (user, ch) => M.prefs[user]?.[ch] || { starred: false, muted: false, hidden: false };
M.setPref = (user, ch, patch) => {
  const p = { ...M.prefOf(user, ch), ...patch };
  (M.prefs[user] = M.prefs[user] || {})[ch] = p;
  return M.db.write(M.db.S.savePref(user, ch, p)).then(() => p);
};
M.readOf = (user, key) => M.reads[user]?.[key] || 0;
M.setRead = (user, key, id) => {
  (M.reads[user] = M.reads[user] || {})[key] = id;
  return M.db.write(M.db.S.saveRead(user, key, id));
};
M.savedOf = user => M.saved[user] || (M.saved[user] = new Map());

// Non-lus de toutes les conversations d'un compte (un passage sur l'historique : suffisant pour une petite équipe)
M.unreadFor = user => {
  const reads = M.reads[user] || {};
  const unread = {};
  const visible = new Map();
  const sees = ch => { if (!visible.has(ch)) visible.set(ch, M.isMember(user, ch)); return visible.get(ch); };
  for (const m of M.messages) {
    if ((m.parent && !m.broadcast) || m.user === user || !sees(m.channel) || m.id <= (reads[m.channel] || 0)) continue;
    const u = unread[m.channel] || (unread[m.channel] = { count: 0, mentions: 0 });
    u.count++;
    if (M.mentions(m, user)) u.mentions++;
  }
  const threads = [];
  for (const [pid, list] of M.replies) {
    const parent = M.byId.get(pid);
    if (!parent || !M.canSee(user, parent.channel)) continue;
    const last = list[list.length - 1];
    if (last.user === user || last.id <= (reads['t:' + pid] || 0)) continue;
    if (M.participants(pid).includes(user)) threads.push(pid);
  }
  return { unread, threads };
};

// Non-lus d'une seule conversation (ou d'un fil, clé "t:<id>"), après un changement de « lu »
M.unreadOne = (user, key) => {
  const last = M.readOf(user, key);
  const thread = /^t:(\d+)$/.exec(key);
  const list = thread ? M.replies.get(Number(thread[1])) || [] : M.messages.filter(m => m.channel === key && (!m.parent || m.broadcast));
  const u = { count: 0, mentions: 0 };
  for (const m of list) if (m.id > last && m.user !== user) { u.count++; if (M.mentions(m, user)) u.mentions++; }
  return u;
};

module.exports = M;
