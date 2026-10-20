// Appels audio (WebRTC) : serveurs ICE, signalisation des appels en tête-à-tête, salles d'appel de groupe.
// Le son et l'écran passent directement d'un navigateur à l'autre ; le serveur ne fait que la mise en relation,
// et les descriptions de session qu'il relaie sont chiffrées avec la clé de la conversation.
const crypto = require('crypto');
const M = require('../model');
const rt = require('../realtime');
const { route, fail, validEnc } = require('../http');
const { STUN, TURN_URLS, TURN_SECRET, HUDDLE_MAX } = require('../config');

// Serveurs ICE : STUN public par défaut ; TURN optionnel (coturn avec « static-auth-secret »)
route('GET', '/api/ice', ({ me }) => {
  const iceServers = [];
  if (STUN) iceServers.push({ urls: STUN.split(',').map(s => s.trim()).filter(Boolean) });
  if (TURN_URLS.length && TURN_SECRET) {
    // Identifiants éphémères (12 h), format attendu par coturn --use-auth-secret
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${me}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: TURN_URLS, username, credential });
  }
  return { iceServers };
});

// Signalisation : relaie un message d'appel (sonnerie, offre/réponse chiffrées, raccrocher…) à tous les onglets
// du destinataire. Réponse et refus sont aussi copiés aux autres onglets de l'appelé, pour qu'ils arrêtent de sonner.
const KINDS = ['offer', 'answer', 'decline', 'cancel', 'hangup', 'busy', 'screen'];
route('POST', '/api/call', async ({ me, body }) => {
  const b = await body();
  const to = String(b.to || ''), kind = String(b.kind || ''), callId = String(b.callId || '');
  if (!M.active(to) || to === me || !KINDS.includes(kind) || !/^[\w-]{8,64}$/.test(callId)) fail(400, 'Signal d\'appel invalide');
  if (b.enc && !validEnc(b.enc)) fail(400, 'Signal d\'appel invalide');
  const signal = { from: me, to, kind, callId, deviceId: String(b.deviceId || '').slice(0, 64), enc: b.enc || null, on: !!b.on };
  for (const c of rt.clients) {
    if (c.user === to || (c.user === me && (kind === 'answer' || kind === 'decline'))) rt.send(c, 'call', signal);
  }
  return { delivered: rt.isOnline(to) };
});

// ---------- Appels de groupe (« huddles ») ----------
// Une salle par canal, en mémoire. Chaque participant est identifié par son pseudo et l'identifiant de son
// onglet (deviceId) ; un onglet qui se déconnecte quitte la salle.
const rooms = new Map(); // canal -> { id, startedBy, startedAt, members: Map(user -> { deviceId, joinedAt, sharing }) }
function roomOut(ch) {
  const r = rooms.get(ch);
  if (!r) return null;
  return { id: r.id, channel: ch, startedBy: r.startedBy, startedAt: r.startedAt,
    members: [...r.members].map(([user, m]) => ({ user, deviceId: m.deviceId, joinedAt: m.joinedAt, sharing: !!m.sharing })) };
}
const announce = ch => rt.broadcast('huddle', { channel: ch, room: roomOut(ch) }, ch);
function leaveRoom(ch, user, deviceId) {
  const r = rooms.get(ch);
  if (!r || r.members.get(user)?.deviceId !== deviceId) return false;
  r.members.delete(user);
  if (!r.members.size) rooms.delete(ch);
  announce(ch);
  return true;
}
const roomsFor = user => [...rooms.keys()].filter(ch => M.canSee(user, ch)).map(roomOut);
const dropDevice = (user, deviceId) => { for (const ch of [...rooms.keys()]) leaveRoom(ch, user, deviceId); };

route('POST', '/api/huddle/:action', async ({ me, params, body }) => {
  const action = params.action;
  if (!['join', 'leave', 'signal', 'screen'].includes(action)) fail(404, 'Introuvable');
  const b = await body();
  const ch = String(b.channel || '');
  const deviceId = String(b.deviceId || '').slice(0, 64);
  if (!M.channels.has(ch) || !M.canSee(me, ch) || !deviceId) fail(400, 'Appel de groupe invalide');
  if (!rt.hasDevice(me, deviceId)) fail(400, 'Onglet non connecté au flux temps réel');

  if (action === 'join') {
    let r = rooms.get(ch);
    if (!r) rooms.set(ch, r = { id: crypto.randomUUID(), startedBy: me, startedAt: Date.now(), members: new Map() });
    if (!r.members.has(me) && r.members.size >= HUDDLE_MAX) fail(409, `Appel complet (${HUDDLE_MAX} personnes maximum)`);
    r.members.set(me, { deviceId, joinedAt: Date.now() }); // rejoindre depuis un autre onglet remplace l'ancien
    announce(ch);
    return { room: roomOut(ch) };
  }
  if (action === 'leave') {
    leaveRoom(ch, me, deviceId);
    return { room: roomOut(ch) };
  }
  if (action === 'screen') {
    const m = rooms.get(ch)?.members.get(me);
    if (!m || m.deviceId !== deviceId) fail(409, 'Tu n\'es pas dans cet appel');
    m.sharing = !!b.on;
    announce(ch);
    return { room: roomOut(ch) };
  }
  // Signal (offre/réponse SDP chiffrée) vers un participant précis
  const r = rooms.get(ch);
  const to = String(b.to || ''), toDevice = String(b.toDevice || ''), kind = String(b.kind || '');
  if (!r || r.members.get(me)?.deviceId !== deviceId || r.members.get(to)?.deviceId !== toDevice) fail(409, 'Participant absent de l\'appel');
  if (!['offer', 'answer'].includes(kind) || !validEnc(b.enc)) fail(400, 'Signal invalide');
  for (const c of rt.clients) {
    if (c.user === to && c.deviceId === toDevice) rt.send(c, 'huddle-signal', { channel: ch, roomId: r.id, from: me, fromDevice: deviceId, kind, enc: b.enc });
  }
  return { ok: true };
});

module.exports = { roomsFor, dropDevice };
