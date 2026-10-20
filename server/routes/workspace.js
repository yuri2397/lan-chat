// Espace de travail : flux temps réel, annuaire et profils, préférences, lus, administration.
const crypto = require('crypto');
const M = require('../model');
const rt = require('../realtime');
const huddles = require('./calls');
const { dropSessions } = require('./auth');
const { route, fail, str } = require('../http');
const { MAX_AVATAR } = require('../config');

// ---------- Flux temps réel ----------
// À la connexion, l'onglet reçoit d'un coup tout ce qu'il faut pour s'afficher (« hello »).
function hello(me) {
  const { unread, threads } = M.unreadFor(me);
  const dms = new Set(M.messages.filter(m => M.isDm(m.channel) && M.dmMembers(m.channel).includes(me)).map(m => m.channel));
  const mine = {}, holders = {};
  for (const c of M.visibleChannels(me)) {
    holders[c.name] = M.keyHolders(c.name);
    if (M.chanKeys[c.name]?.[me]) mine[c.name] = M.chanKeys[c.name][me];
  }
  return {
    me,
    workspace: M.workspace,
    users: Object.keys(M.users).map(M.userView),
    channels: M.visibleChannels(me).map(M.channelView),
    dms: [...dms],
    online: rt.onlineUsers(),
    rooms: huddles.roomsFor(me),
    prefs: M.prefs[me] || {},
    reads: M.reads[me] || {},
    unread, threads,
    keys: { mine, holders },
    saved: [...M.savedOf(me)].filter(([, s]) => !s.done).map(([id]) => id),
    scheduled: [...M.scheduled.values()].filter(s => s.user === me).length,
  };
}

route('GET', '/api/events', ({ req, res, url, me }) => {
  // X-Accel-Buffering : empêche un éventuel proxy de retenir le flux temps réel
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const client = { res, user: me, deviceId: String(url.searchParams.get('device') || '').slice(0, 64) };
  const wasOnline = rt.isOnline(me);
  rt.clients.add(client);
  rt.send(client, 'hello', hello(me));
  if (!wasOnline) rt.broadcast('presence', { online: rt.onlineUsers() });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    rt.clients.delete(client);
    huddles.dropDevice(me, client.deviceId);
    if (!rt.isOnline(me)) rt.broadcast('presence', { online: rt.onlineUsers() });
  });
  return false; // réponse gérée ici (flux ouvert)
});

// ---------- Annuaire et profil ----------
route('GET', '/api/users', () => ({ users: Object.keys(M.users).map(M.userView) }));

// Profil : nom complet, fonction, statut (emoji + texte + échéance), pause des notifications, absent
route('PATCH', '/api/me', async ({ me, body }) => {
  const b = await body();
  const p = M.users[me].profile = { ...M.users[me].profile };
  if ('displayName' in b) p.displayName = str(b.displayName, 60);
  if ('title' in b) p.title = str(b.title, 80);
  if ('status' in b) {
    p.status = b.status && (b.status.text || b.status.emoji)
      ? { emoji: str(b.status.emoji, 16), text: str(b.status.text, 100), until: Number(b.status.until) || null }
      : null;
  }
  if ('dndUntil' in b) p.dndUntil = Number(b.dndUntil) || null;
  if ('away' in b) p.away = !!b.away;
  await M.saveUser(me);
  rt.broadcast('user', M.userView(me));
  return M.userView(me);
});

// Photo de profil : réduite et convertie par le navigateur (data: URL d'image), servie ensuite comme une image.
route('PUT', '/api/me/avatar', async ({ me, body }) => {
  const { image } = await body();
  if (image === null) M.users[me].avatar = null;
  else {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    if (!m || m[2].length > MAX_AVATAR * 1.37) fail(400, 'Image invalide ou trop lourde');
    M.users[me].avatar = image;
  }
  // Clé aléatoire dans l'adresse de l'image : seuls les comptes connectés (qui lisent l'annuaire) la connaissent
  M.users[me].profile = { ...M.users[me].profile, avatarKey: crypto.randomBytes(9).toString('hex') };
  await M.saveUser(me);
  rt.broadcast('user', M.userView(me));
  return M.userView(me);
});
route('GET', '/api/avatar/:name/:key', ({ req, res, params }) => {
  const u = M.users[params.name];
  const m = u?.avatar && u.profile?.avatarKey === params.key && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(u.avatar);
  if (!m) fail(404, 'Pas de photo');
  const etag = `"${params.key}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return false; }
  const buf = Buffer.from(m[2], 'base64');
  res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': buf.length, ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(buf);
  return false;
}, { public: true });

// ---------- Préférences par conversation : favori, sourdine, masquée ----------
route('POST', '/api/prefs', async ({ me, body }) => {
  const b = await body();
  const ch = String(b.channel || '');
  if (!M.validConvo(ch) || !M.canSee(me, ch)) fail(400, 'Conversation inconnue');
  const patch = {};
  for (const k of ['starred', 'muted', 'hidden']) if (k in b) patch[k] = !!b[k];
  const pref = await M.setPref(me, ch, patch);
  rt.toUser(me, 'prefs', { channel: ch, pref });
  return pref;
});

// ---------- Lus (synchronisés entre appareils) ----------
// key : une conversation, ou "t:<id>" pour un fil. `force` permet de reculer (« Marquer comme non lu »).
route('POST', '/api/read', async ({ me, body }) => {
  const b = await body();
  const key = String(b.key || '');
  let id = Math.max(0, Number(b.id) || 0);
  const thread = /^t:(\d+)$/.exec(key);
  if (thread) { const p = M.byId.get(Number(thread[1])); if (!p || !M.canSee(me, p.channel)) fail(400, 'Fil inconnu'); }
  else if (!M.validConvo(key) || !M.canSee(me, key)) fail(400, 'Conversation inconnue');
  // « Tout marquer comme lu » sans connaître le dernier message
  if (b.latest) id = (thread ? M.replies.get(Number(thread[1])) || [] : M.messages.filter(m => m.channel === key)).at(-1)?.id || 0;
  if (id > M.readOf(me, key) || b.force) {
    await M.setRead(me, key, id);
    rt.toUser(me, 'read', { key, id, unread: M.unreadOne(me, key) });
  }
  return { key, id: M.readOf(me, key) };
});

// ---------- « est en train d'écrire » ----------
route('POST', '/api/typing', async ({ me, body }) => {
  const b = await body();
  const channel = String(b.channel || '');
  if (M.validConvo(channel) && M.canSee(me, channel)) {
    rt.broadcast('typing', { user: me, channel, parent: Number(b.parent) || null }, channel);
  }
  return { ok: true };
});

// ---------- Administration (propriétaire et admins) ----------
const needAdmin = me => { if (!M.isAdmin(me)) fail(403, 'Réservé aux administrateurs'); };
const newCode = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const part = () => Array.from(crypto.randomBytes(4), b => alphabet[b % alphabet.length]).join('');
  return `${part()}-${part()}`;
};

route('GET', '/api/admin', ({ me }) => {
  needAdmin(me);
  return { workspace: M.workspace, accessCode: M.accessCode, codeFromEnv: !!process.env.LANCHAT_CODE };
});
route('PATCH', '/api/admin', async ({ me, body }) => {
  needAdmin(me);
  const b = await body();
  if ('name' in b) {
    M.workspace.name = str(b.name, 40) || 'LAN Chat';
    await M.db.setConfig('workspaceName', M.workspace.name);
    rt.broadcast('workspace', M.workspace);
  }
  if (b.regenerateCode) {
    if (process.env.LANCHAT_CODE) fail(409, 'Le code est fixé par la variable LANCHAT_CODE du serveur');
    M.accessCode = newCode();
    await M.db.setConfig('accessCode', M.accessCode);
  }
  return { workspace: M.workspace, accessCode: M.accessCode, codeFromEnv: !!process.env.LANCHAT_CODE };
});
// Rôle (admin/membre) et désactivation d'un compte
route('POST', '/api/admin/users/:name', async ({ me, params, body }) => {
  needAdmin(me);
  const b = await body();
  const u = M.users[params.name];
  if (!u) fail(404, 'Compte introuvable');
  if (u.role === 'owner') fail(403, 'Le compte propriétaire ne peut pas être modifié');
  if (params.name === me) fail(400, 'Tu ne peux pas modifier ton propre compte ici');
  if ('role' in b) u.role = b.role === 'admin' ? 'admin' : 'member';
  if ('deactivated' in b) u.deactivated = !!b.deactivated;
  await M.saveUser(params.name);
  if (u.deactivated) { await dropSessions(params.name); rt.kick(params.name); }
  rt.broadcast('user', M.userView(params.name));
  return M.userView(params.name);
});

module.exports = { newCode };
