// Canaux : création (publique ou privée), sujet et description, rejoindre / quitter, membres, archivage,
// et distribution des clés de chiffrement de canal.
const M = require('../model');
const rt = require('../realtime');
const { route, fail, validEnc, str } = require('../http');
const { CHANNEL_RE } = require('../config');

const slug = s => String(s || '').toLowerCase().trim()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Annonce l'état d'un canal à ceux qui le voient, et sa disparition à ceux qui viennent de perdre l'accès
function announce(c, removed = []) {
  rt.broadcast('channel', M.channelView(c), c.name);
  for (const u of removed) rt.toUser(u, 'channel-gone', { name: c.name });
}
const channelOr404 = (me, name) => {
  const c = M.channel(name);
  if (!c || !M.canSee(me, name)) fail(404, 'Canal introuvable');
  return c;
};
const canManage = (me, c) => M.isAdmin(me) || c.createdBy === me;

route('POST', '/api/channels', async ({ me, body, ctx }) => {
  const b = await body();
  const name = slug(b.name);
  if (!CHANNEL_RE.test(name)) fail(400, 'Nom invalide : lettres minuscules, chiffres et tirets');
  if (M.channels.has(name)) fail(409, `#${name} existe déjà`);
  const c = {
    name, created: Date.now(), createdBy: me, private: !!b.private, archived: false,
    topic: str(b.topic, 250), description: str(b.description, 1000),
  };
  // Canal public : tout le monde le rejoint (petite équipe). Privé : le créateur et les personnes invitées.
  const invited = b.private
    ? [me, ...(Array.isArray(b.members) ? b.members : []).map(String).filter(M.active)]
    : Object.keys(M.users).filter(M.active);
  const members = new Set(invited);
  M.channels.set(name, c);
  M.members.set(name, members);
  await M.db.batch([M.db.S.saveChannel(c), ...[...members].map(u => M.db.S.addMember(name, u))]);
  announce(c);
  ctx.status = 201;
  return M.channelView(c);
});

route('PATCH', '/api/channels/:name', async ({ me, params, body }) => {
  const c = channelOr404(me, params.name);
  const b = await body();
  if (!M.isMember(me, c.name)) fail(403, 'Rejoins le canal pour le modifier');
  if ('topic' in b) c.topic = str(b.topic, 250);
  if ('description' in b) c.description = str(b.description, 1000);
  if ('archived' in b) {
    if (!canManage(me, c)) fail(403, 'Seuls la personne qui a créé le canal et les admins peuvent l\'archiver');
    if (c.name === 'general') fail(400, '#general ne peut pas être archivé');
    c.archived = !!b.archived;
  }
  await M.db.write(M.db.S.saveChannel(c));
  announce(c);
  return M.channelView(c);
});

route('POST', '/api/channels/:name/join', async ({ me, params }) => {
  const c = channelOr404(me, params.name);
  if (c.archived) fail(400, 'Ce canal est archivé');
  if (!M.members.get(c.name).has(me)) {
    M.members.get(c.name).add(me);
    await M.db.write(M.db.S.addMember(c.name, me));
    announce(c);
  }
  return M.channelView(c);
});

route('POST', '/api/channels/:name/leave', async ({ me, params }) => {
  const c = channelOr404(me, params.name);
  if (c.name === 'general') fail(400, 'Tout le monde reste dans #general');
  if (M.members.get(c.name).delete(me)) {
    await M.db.write(M.db.S.removeMember(c.name, me));
    announce(c, c.private ? [me] : []);
    if (!c.private) rt.toUser(me, 'channel', M.channelView(c));
  }
  return { ok: true };
});

// Membres d'un canal privé : tout membre peut inviter ; retirer est réservé au créateur et aux admins.
// (Pas de rotation de clé au départ de quelqu'un : il ne reçoit plus rien, mais garde la clé déjà reçue.)
route('POST', '/api/channels/:name/members', async ({ me, params, body }) => {
  const c = channelOr404(me, params.name);
  const b = await body();
  if (!M.isMember(me, c.name)) fail(403, 'Tu n\'es pas membre de ce canal');
  const set = M.members.get(c.name);
  const add = (b.add || []).map(String).filter(u => M.active(u) && !set.has(u));
  const remove = (b.remove || []).map(String).filter(u => set.has(u) && u !== me);
  if (remove.length && !canManage(me, c)) fail(403, 'Seuls la personne qui a créé le canal et les admins peuvent retirer quelqu\'un');
  add.forEach(u => set.add(u));
  remove.forEach(u => set.delete(u));
  await M.db.batch([...add.map(u => M.db.S.addMember(c.name, u)), ...remove.map(u => M.db.S.removeMember(c.name, u))]);
  announce(c, c.private ? remove : []);
  if (!c.private) remove.forEach(u => rt.toUser(u, 'channel', M.channelView(c)));
  return M.channelView(c);
});

// ---------- Clés de canal ----------
// Chaque personne autorisée reçoit la clé du canal chiffrée pour elle (ECDH avec la clé publique de l'expéditeur).
// Canal public : tous les comptes. Canal privé : ses membres seulement.
route('POST', '/api/keys', async ({ me, body }) => {
  const b = await body();
  const ch = String(b.channel || '');
  const c = channelOr404(me, ch);
  const existing = M.keyHolders(ch);
  // Seul un détenteur de la clé peut la partager ; le premier à créer la clé doit se l'inclure.
  if (existing.length && !existing.includes(me)) fail(409, 'La clé de ce canal existe déjà', { holders: existing });
  if (!existing.length && !(b.keys || {})[me]) fail(400, 'La clé doit inclure son créateur');
  const allowed = to => M.users[to] && (!c.private || M.members.get(ch).has(to));
  const added = Object.entries(b.keys || {})
    .filter(([to, wrapped]) => allowed(to) && !M.chanKeys[ch]?.[to] && validEnc(wrapped)) // jamais d'écrasement
    .map(([to, wrapped]) => [to, { from: me, fromPub: M.users[me].pub, wrapped }]);
  await M.db.batch(added.map(([to, e]) => M.db.S.saveKey(ch, to, e)));
  M.chanKeys[ch] = M.chanKeys[ch] || {};
  for (const [to, e] of added) M.chanKeys[ch][to] = e;
  rt.broadcast('keys', { channel: ch, holders: M.keyHolders(ch) }, ch);
  return { holders: M.keyHolders(ch) };
});
route('GET', '/api/keys', ({ me }) => {
  const mine = {}, holders = {};
  for (const c of M.visibleChannels(me)) {
    holders[c.name] = M.keyHolders(c.name);
    if (M.chanKeys[c.name]?.[me]) mine[c.name] = M.chanKeys[c.name][me];
  }
  return { mine, holders };
});
