// Messages : historique, fils, envoi (chiffré), modification, suppression, réactions, épingles,
// « Plus tard » (enregistrés + rappels) et envois programmés.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const M = require('../model');
const rt = require('../realtime');
const { route, fail, validEnc } = require('../http');
const { PAGE_SIZE, UPLOAD_DIR } = require('../config');

const inList = m => !m.parent || m.broadcast; // visible dans le canal (racine, ou réponse « aussi envoyée dans le canal »)
const msgOr404 = (me, id) => {
  const m = M.byId.get(Number(id));
  if (!m || !M.canSee(me, m.channel)) fail(404, 'Message introuvable');
  return m;
};
// Valide le parent d'une réponse : il doit exister, être un message racine et appartenir au même canal.
const validParent = (parentId, channel) => {
  if (!parentId) return true;
  const p = M.byId.get(Number(parentId));
  return !!p && !p.parent && p.channel === channel;
};
// Écrire dans une conversation ; dans un canal public, écrire le fait rejoindre.
async function checkPost(me, channel) {
  if (!M.validConvo(channel) || !M.canSee(me, channel)) fail(400, 'Conversation inconnue');
  if (M.isDm(channel)) {
    const other = M.dmMembers(channel).find(n => n !== me) || me;
    if (!M.active(other)) fail(400, 'Ce compte a été désactivé');
    return;
  }
  const c = M.channel(channel);
  if (c.archived) fail(400, 'Ce canal est archivé : il est en lecture seule');
  if (!M.members.get(channel).has(me)) {
    M.members.get(channel).add(me);
    await M.db.write(M.db.S.addMember(channel, me));
    rt.broadcast('channel', M.channelView(c), channel);
  }
}

// Publie un nouveau message (et la mise à jour du résumé de fil de son parent).
async function publish(msg) {
  // Le dernier identifiant attribué est mémorisé : un message supprimé ne voit jamais son id réutilisé.
  await M.db.batch([M.db.S.insertMessage(msg), M.db.S.setConfig('lastId', msg.id)]);
  M.addToIndex(msg);
  // Écrire dans une conversation la marque comme lue pour son auteur
  M.setRead(msg.user, msg.parent ? 't:' + msg.parent : msg.channel, msg.id).catch(() => {});
  if (msg.parent && msg.broadcast) M.setRead(msg.user, msg.channel, msg.id).catch(() => {});
  const payload = msg.parent ? { ...msg, participants: M.participants(msg.parent) } : msg;
  rt.broadcast('message', payload, msg.channel);
  if (msg.parent && M.byId.has(msg.parent)) rt.broadcast('update', M.out(M.byId.get(msg.parent)), msg.channel);
}
function newMessage(me, b) {
  const msg = { id: M.nextId++, channel: b.channel, user: me, enc: { iv: b.enc.iv, ct: b.enc.ct }, ts: Date.now() };
  const mentions = M.cleanMentions(b.mentions);
  if (mentions.length) msg.mentions = mentions;
  if (b.parent) { msg.parent = Number(b.parent); if (b.broadcast) msg.broadcast = true; }
  return msg;
}

// ---------- Lecture ----------
// Historique d'un canal, paginé (?before=id) ou centré sur un message (?around=id, pour les liens et la recherche)
route('GET', '/api/messages', ({ me, url }) => {
  const channel = url.searchParams.get('channel') || '';
  if (!M.canSee(me, channel)) fail(403, 'Accès refusé');
  const list = M.messages.filter(m => m.channel === channel && inList(m));
  const around = Number(url.searchParams.get('around'));
  if (around) {
    let i = list.findIndex(m => m.id >= around);
    if (i < 0) i = list.length - 1;
    const start = Math.max(0, i - PAGE_SIZE / 2), end = Math.min(list.length, i + PAGE_SIZE / 2);
    return { messages: list.slice(start, end).map(M.out), hasMore: start > 0, hasNewer: end < list.length };
  }
  const before = Number(url.searchParams.get('before')) || Infinity;
  const older = list.filter(m => m.id < before);
  return { messages: older.slice(-PAGE_SIZE).map(M.out), hasMore: older.length > PAGE_SIZE, hasNewer: false };
});

// Tous les messages visibles (récents) : la recherche se fait dans le navigateur, après déchiffrement
route('GET', '/api/all', ({ me }) => ({ messages: M.messages.filter(m => M.canSee(me, m.channel)).slice(-5000).map(M.out) }));

route('GET', '/api/thread/:id', ({ me, params }) => {
  const parent = msgOr404(me, params.id);
  if (parent.parent) fail(404, 'Fil introuvable');
  return { parent: M.out(parent), replies: M.replies.get(parent.id) || [] };
});

// Fils auxquels on participe, du plus récent au plus ancien
route('GET', '/api/threads', ({ me }) => {
  const list = [];
  for (const [pid, r] of M.replies) {
    const parent = M.byId.get(pid);
    if (!parent || !M.canSee(me, parent.channel) || !M.participants(pid).includes(me)) continue;
    list.push({ parent: M.out(parent), latest: r.slice(-3) });
  }
  list.sort((a, b) => b.parent.thread.lastTs - a.parent.thread.lastTs);
  return { threads: list.slice(0, 40) };
});

route('GET', '/api/pins', ({ me, url }) => {
  const channel = url.searchParams.get('channel') || '';
  if (!M.canSee(me, channel)) fail(403, 'Accès refusé');
  return { messages: M.messages.filter(m => m.channel === channel && m.pinned).map(M.out).reverse() };
});
route('GET', '/api/files', ({ me, url }) => {
  const channel = url.searchParams.get('channel') || '';
  if (!M.canSee(me, channel)) fail(403, 'Accès refusé');
  return { messages: M.messages.filter(m => m.channel === channel && m.file).slice(-300).reverse() };
});

// ---------- Écriture ----------
// Nouveau message chiffré (ou réponse dans un fil avec `parent`, ou fichier avec `fileId`)
route('POST', '/api/messages', async ({ me, body, ctx }) => {
  const b = await body();
  b.channel = String(b.channel || '');
  if (!validEnc(b.enc)) fail(400, 'Message non chiffré refusé');
  await checkPost(me, b.channel);
  if (!validParent(b.parent, b.channel)) fail(400, 'Fil introuvable');
  let file = null;
  if (b.fileId) {
    const f = M.pendingFiles.get(b.fileId);
    if (!f || f.user !== me) fail(400, 'Fichier introuvable');
    file = { id: b.fileId, size: f.size };
  }
  const msg = newMessage(me, b);
  if (file) { M.pendingFiles.delete(b.fileId); msg.file = file; }
  await publish(msg);
  ctx.status = 201;
  return msg;
});

route('PATCH', '/api/messages/:id', async ({ me, params, body }) => {
  const msg = msgOr404(me, params.id);
  const b = await body();
  if (msg.user !== me) fail(403, 'Ce n\'est pas ton message');
  if (!validEnc(b.enc)) fail(400, 'Message non chiffré refusé');
  msg.enc = { iv: b.enc.iv, ct: b.enc.ct };
  delete msg.text; // un ancien message en clair devient chiffré une fois modifié
  if ('mentions' in b) { const list = M.cleanMentions(b.mentions); if (list.length) msg.mentions = list; else delete msg.mentions; }
  msg.edited = Date.now();
  await M.db.write(M.db.S.updateMessage(msg));
  rt.broadcast('update', M.out(msg), msg.channel);
  return M.out(msg);
});

// Supprimer son message (ou n'importe lequel pour un admin) ; supprimer un message racine supprime son fil
route('DELETE', '/api/messages/:id', async ({ me, params }) => {
  const msg = msgOr404(me, params.id);
  if (msg.user !== me && !M.isAdmin(me)) fail(403, 'Ce n\'est pas ton message');
  const doomed = [...(M.replies.get(msg.id) || []), msg];
  await M.db.batch(doomed.flatMap(m => [M.db.S.deleteMessage(m.id), M.db.S.deleteSavedFor(m.id)]));
  for (const m of doomed) {
    M.removeFromIndex(m);
    for (const s of Object.values(M.saved)) s.delete(m.id);
    if (m.file) fs.rm(path.join(UPLOAD_DIR, m.file.id), () => {});
    rt.broadcast('delete', { id: m.id, channel: m.channel, parent: m.parent || null }, m.channel);
  }
  if (msg.parent && M.byId.has(msg.parent)) rt.broadcast('update', M.out(M.byId.get(msg.parent)), msg.channel);
  return { ok: true };
});

route('POST', '/api/messages/:id/react', async ({ me, params, body }) => {
  const msg = msgOr404(me, params.id);
  const emoji = String((await body()).emoji || '').slice(0, 16);
  if (!emoji) fail(400, 'Réaction invalide');
  M.toggleReaction(msg, emoji, me);
  await M.db.write(M.db.S.updateMessage(msg));
  rt.broadcast('update', M.out(msg), msg.channel);
  return M.out(msg);
});

route('POST', '/api/messages/:id/pin', async ({ me, params, body }) => {
  const msg = msgOr404(me, params.id);
  const on = !!(await body()).on;
  if (on) msg.pinned = { by: me, ts: Date.now() }; else delete msg.pinned;
  await M.db.write(M.db.S.updateMessage(msg));
  rt.broadcast('update', M.out(msg), msg.channel);
  return M.out(msg);
});

// ---------- « Plus tard » : messages enregistrés, avec rappel facultatif ----------
const savedView = (id, s) => ({ id, ts: s.ts, remindAt: s.remindAt, done: s.done, message: M.out(M.byId.get(id)) });
route('POST', '/api/messages/:id/save', async ({ me, params, body }) => {
  const msg = msgOr404(me, params.id);
  const b = await body();
  const mine = M.savedOf(me);
  if (b.on === false) {
    mine.delete(msg.id);
    await M.db.write(M.db.S.deleteSaved(me, msg.id));
    rt.toUser(me, 'saved', { id: msg.id, removed: true });
    return { ok: true };
  }
  const s = { ts: mine.get(msg.id)?.ts || Date.now(), remindAt: Number(b.remindAt) || null, reminded: false, done: !!b.done };
  mine.set(msg.id, s);
  await M.db.write(M.db.S.saveSaved(me, msg.id, s));
  rt.toUser(me, 'saved', savedView(msg.id, s));
  return savedView(msg.id, s);
});
route('GET', '/api/saved', ({ me }) => ({
  items: [...M.savedOf(me)].filter(([id]) => M.byId.has(id) && M.canSee(me, M.byId.get(id).channel))
    .map(([id, s]) => savedView(id, s)).sort((a, b) => b.ts - a.ts),
}));

// ---------- Envois programmés ----------
// Le message est chiffré dès maintenant par le navigateur ; le serveur le garde et le publie à l'heure dite.
const scheduledView = s => ({ id: s.id, channel: s.channel, parent: s.parent, enc: s.enc, at: s.at, created: s.created });
const scheduledOr404 = (me, id) => {
  const s = M.scheduled.get(id);
  if (!s || s.user !== me) fail(404, 'Envoi programmé introuvable');
  return s;
};
const validAt = at => { if (!(at > Date.now() + 5000 && at < Date.now() + 366 * 864e5)) fail(400, 'Date d\'envoi invalide'); };
route('GET', '/api/scheduled', ({ me }) => ({
  items: [...M.scheduled.values()].filter(s => s.user === me).sort((a, b) => a.at - b.at).map(scheduledView),
}));
route('POST', '/api/scheduled', async ({ me, body, ctx }) => {
  const b = await body();
  const channel = String(b.channel || '');
  if (!validEnc(b.enc)) fail(400, 'Message non chiffré refusé');
  if (!M.validConvo(channel) || !M.canSee(me, channel)) fail(400, 'Conversation inconnue');
  if (!validParent(b.parent, channel)) fail(400, 'Fil introuvable');
  validAt(Number(b.at));
  const s = { id: crypto.randomUUID(), user: me, channel, parent: b.parent ? Number(b.parent) : null, enc: b.enc, mentions: M.cleanMentions(b.mentions), at: Number(b.at), created: Date.now() };
  M.scheduled.set(s.id, s);
  await M.db.write(M.db.S.saveScheduled(s));
  rt.toUser(me, 'scheduled', { count: [...M.scheduled.values()].filter(x => x.user === me).length });
  ctx.status = 201;
  return scheduledView(s);
});
route('PATCH', '/api/scheduled/:id', async ({ me, params, body }) => {
  const s = scheduledOr404(me, params.id);
  const b = await body();
  if ('enc' in b) { if (!validEnc(b.enc)) fail(400, 'Message non chiffré refusé'); s.enc = b.enc; }
  if ('mentions' in b) s.mentions = M.cleanMentions(b.mentions);
  if ('at' in b) { validAt(Number(b.at)); s.at = Number(b.at); }
  await M.db.write(M.db.S.saveScheduled(s));
  return scheduledView(s);
});
route('DELETE', '/api/scheduled/:id', async ({ me, params }) => {
  scheduledOr404(me, params.id);
  M.scheduled.delete(params.id);
  await M.db.write(M.db.S.deleteScheduled(params.id));
  rt.toUser(me, 'scheduled', { count: [...M.scheduled.values()].filter(x => x.user === me).length });
  return { ok: true };
});
route('POST', '/api/scheduled/:id/send', async ({ me, params }) => {
  const s = scheduledOr404(me, params.id);
  await sendScheduled(s);
  return { ok: true };
});
async function sendScheduled(s) {
  M.scheduled.delete(s.id);
  await M.db.write(M.db.S.deleteScheduled(s.id));
  rt.toUser(s.user, 'scheduled', { count: [...M.scheduled.values()].filter(x => x.user === s.user).length, sent: s.id });
  try {
    await checkPost(s.user, s.channel);
    if (!validParent(s.parent, s.channel)) return;
    await publish(newMessage(s.user, s));
  } catch (err) { console.warn(`Envoi programmé de ${s.user} abandonné : ${err.message}`); }
}

// Tâches de fond : envois programmés arrivés à échéance, rappels « Plus tard »
setInterval(() => {
  const now = Date.now();
  for (const s of [...M.scheduled.values()]) if (s.at <= now) sendScheduled(s);
  for (const [user, items] of Object.entries(M.saved)) {
    if (!rt.isOnline(user)) continue; // le rappel attend que la personne soit connectée
    for (const [id, s] of items) {
      if (!s.remindAt || s.reminded || s.done || s.remindAt > now || !M.byId.has(id) || !M.canSee(user, M.byId.get(id).channel)) continue;
      s.reminded = true;
      M.db.write(M.db.S.saveSaved(user, id, s)).catch(() => {});
      rt.toUser(user, 'reminder', savedView(id, s));
    }
  }
}, 5000).unref();

module.exports = { publish };
