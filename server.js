#!/usr/bin/env node
// LAN Chat — petit chat façon Slack pour le réseau local. Zéro dépendance.
//
//   node server.js                    démarre le chat (PORT=3000 par défaut, HTTPS auto-signé)
//   LANCHAT_HTTP=1 node server.js     HTTP simple, derrière un proxy HTTPS (Dokploy/Traefik, voir Dockerfile)
//   DATABASE_URL=postgres://…         PostgreSQL (sinon SQLite dans DATA_DIR, sans rien installer)
//   node server.js reset-user <nom>   supprime un compte (mot de passe oublié) pour qu'il puisse être recréé
//
// Sécurité :
// - Comptes protégés par mot de passe. Le mot de passe ne quitte jamais le navigateur : le client en dérive
//   (PBKDF2) une clé d'authentification, seule envoyée au serveur, et une clé de chiffrement qui reste locale.
// - Chiffrement de bout en bout : textes et fichiers arrivent ici déjà chiffrés (AES-GCM). Le serveur stocke
//   et relaie des données qu'il ne peut pas lire. Restent en clair : pseudos, canaux, horaires, réactions.
// - HTTPS obligatoire (WebCrypto n'existe dans le navigateur qu'en contexte sécurisé).

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { openDb } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TLS_DIR = path.join(DATA_DIR, 'tls');
const MAX_UPLOAD = 500 * 1024 * 1024; // 500 Mo
const MAX_JSON = 2 * 1024 * 1024; // 2 Mo (un message chiffré est ~1,4× plus gros que le texte)
const PAGE_SIZE = 100;
const NAME_RE = /^[\w.\-À-ÿ]{2,32}$/;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

// ---------- Base de données (PostgreSQL si DATABASE_URL, sinon SQLite — voir db.js) ----------
// Chargée en mémoire au démarrage par boot(), tout en bas du fichier.
let db;
let users = {};    // nom -> { authSalt, authHash, kdfSalt, pub, encPriv, created }
let sessions = {}; // sha256(jeton) -> { user, created }
let chanKeys = {}; // canal -> { destinataire -> { from, fromPub, wrapped } }
let channels = [];
let ACCESS_CODE = '';

function hashAuthKey(authKey, salt) {
  return crypto.scryptSync(Buffer.from(String(authKey), 'base64'), Buffer.from(salt, 'base64'), 32).toString('base64');
}
async function newSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const s = { user, created: Date.now() };
  await db.saveSession(hash, s);
  sessions[hash] = s;
  return token;
}
const sessionUser = token => (token && sessions[sha256(token)]?.user) || null;

// Anti force brute : 5 échecs -> blocage progressif
const failures = new Map(); // nom -> { count, until }
function checkThrottle(name) {
  const f = failures.get(name);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function recordFailure(name) {
  const f = failures.get(name) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) f.until = Date.now() + Math.min(300, 15 * 2 ** (f.count - 5)) * 1000;
  failures.set(name, f);
}

// ---------- Messages ----------
// Message : { id, channel, user, enc: { iv, ct }, file?: { id, size }, ts, parent?, broadcast?, edited?, reactions? }
// (les anciens messages d'avant le chiffrement ont un champ `text` en clair)
// Tout est en mémoire pour la rapidité ; chaque changement est écrit aussitôt dans la base.
const messages = [];
const byId = new Map();
const replies = new Map(); // id du parent -> [réponses]

function addToIndex(m) {
  messages.push(m);
  byId.set(m.id, m);
  if (m.parent) {
    if (!replies.has(m.parent)) replies.set(m.parent, []);
    replies.get(m.parent).push(m);
  }
}
function removeFromIndex(m) {
  const i = messages.indexOf(m);
  if (i >= 0) messages.splice(i, 1);
  byId.delete(m.id);
  if (m.parent && replies.has(m.parent)) {
    const list = replies.get(m.parent).filter(r => r !== m);
    if (list.length) replies.set(m.parent, list); else replies.delete(m.parent);
  }
}
function toggleReaction(m, emoji, user) {
  m.reactions = m.reactions || {};
  const list = m.reactions[emoji] || [];
  m.reactions[emoji] = list.includes(user) ? list.filter(u => u !== user) : [...list, user];
  if (!m.reactions[emoji].length) delete m.reactions[emoji];
  if (!Object.keys(m.reactions).length) delete m.reactions;
}
let nextId = 1;

// Fichiers envoyés mais pas encore rattachés à un message : id -> { user, size, ts }
const pendingFiles = new Map();

// Ajoute le résumé du fil (nombre de réponses, participants, dernière réponse) à un message.
function out(m) {
  const r = replies.get(m.id);
  if (!r || !r.length) return m;
  const names = [...new Set(r.map(x => x.user))];
  return { ...m, thread: { count: r.length, users: names.slice(-5), lastTs: r[r.length - 1].ts } };
}
const participants = parentId => {
  const p = byId.get(parentId);
  return [...new Set([p && p.user, ...(replies.get(parentId) || []).map(r => r.user)].filter(Boolean))];
};

// clients SSE : Set<{ res, user }>
const clients = new Set();
const onlineUsers = () => [...new Set([...clients].map(c => c.user))].sort((a, b) => a.localeCompare(b));

// Un DM s'appelle "@alice|bob" (noms triés).
const isDm = ch => ch.startsWith('@');
const dmMembers = ch => ch.slice(1).split('|');
const canSee = (user, ch) => !isDm(ch) || dmMembers(ch).includes(user);
const validChannel = ch => channels.includes(ch) || (isDm(ch) && dmMembers(ch).length === 2 && dmMembers(ch).every(n => users[n]));
const keyHolders = ch => Object.keys(chanKeys[ch] || {});

function send(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data, channel) {
  for (const c of clients) if (!channel || canSee(c.user, channel)) send(c, event, data);
}
// Publie un nouveau message (et la mise à jour du résumé de fil de son parent).
async function publish(msg) {
  // Le dernier identifiant attribué est mémorisé : un message supprimé ne voit jamais son id réutilisé.
  await db.batch([db.S.insertMessage(msg), db.S.setConfig('lastId', msg.id)]);
  addToIndex(msg);
  const payload = msg.parent ? { ...msg, participants: participants(msg.parent) } : msg;
  broadcast('message', payload, msg.channel);
  if (msg.parent && byId.has(msg.parent)) broadcast('update', out(byId.get(msg.parent)), msg.channel);
}

// ---------- Helpers HTTP ----------
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_JSON) { reject(new Error('Message trop volumineux')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}
const isB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s);
const validEnc = e => e && isB64(e.iv, 32) && isB64(e.ct, MAX_JSON);
// Valide le parent d'une réponse : il doit exister, être un message racine et appartenir au même canal.
function validParent(parentId, channel) {
  if (!parentId) return true;
  const p = byId.get(Number(parentId));
  return !!p && !p.parent && p.channel === channel;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.zip': 'application/zip', '.ico': 'image/x-icon',
};
// Anciens fichiers en clair affichables dans le navigateur sans risque (le SVG/HTML est forcé en téléchargement).
const INLINE_OK = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.mp4', '.webm', '.mp3', '.txt']);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

// ---------- Routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token');
  const me = sessionUser(token);

  // Sonde de santé (Docker / Dokploy) : vérifie aussi la base
  if (p === '/api/health') {
    try { await db.ping(); return json(res, 200, { ok: true }); }
    catch { return json(res, 503, { ok: false, error: 'Base de données injoignable' }); }
  }

  // ----- Routes publiques : authentification -----
  if (p === '/api/prelogin' && req.method === 'GET') {
    const u = users[url.searchParams.get('name') || ''];
    return json(res, 200, { exists: !!u, kdfSalt: u ? u.kdfSalt : null });
  }

  if (p === '/api/register' && req.method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!NAME_RE.test(name)) return json(res, 400, { error: 'Pseudo invalide (2 à 32 lettres, chiffres, . - _)' });
    if (String(body.code || '').trim().toLowerCase() !== ACCESS_CODE.toLowerCase()) {
      recordFailure('register');
      return json(res, 403, { error: 'Code d\'accès incorrect — demande-le à la personne qui héberge le chat' });
    }
    if (users[name]) return json(res, 409, { error: 'Ce pseudo est déjà pris' });
    if (!isB64(body.authKey, 64) || !isB64(body.kdfSalt, 64) || !isB64(body.pub, 200) || !validEnc(body.encPriv)) {
      return json(res, 400, { error: 'Données de compte invalides' });
    }
    const authSalt = crypto.randomBytes(16).toString('base64');
    const account = { authSalt, authHash: hashAuthKey(body.authKey, authSalt), kdfSalt: body.kdfSalt, pub: body.pub, encPriv: body.encPriv, created: Date.now() };
    await db.saveUser(name, account);
    users[name] = account;
    broadcast('user', { name, pub: body.pub });
    return json(res, 201, { token: await newSession(name), name });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const wait = checkThrottle(name);
    if (wait) return json(res, 429, { error: `Trop de tentatives, réessaie dans ${wait} s` });
    const u = users[name];
    const ok = u && isB64(body.authKey, 64) &&
      crypto.timingSafeEqual(Buffer.from(hashAuthKey(body.authKey, u.authSalt)), Buffer.from(u.authHash));
    if (!ok) { recordFailure(name); return json(res, 401, { error: 'Pseudo ou mot de passe incorrect' }); }
    failures.delete(name);
    return json(res, 200, { token: await newSession(name), name, pub: u.pub, encPriv: u.encPriv });
  }

  // ----- Fichiers statiques (l'application elle-même) -----
  if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/files/')) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
    if (file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      return fs.createReadStream(file).pipe(res);
    }
    return json(res, 404, { error: 'Introuvable' });
  }

  // ----- Tout le reste exige une session -----
  if (!me || !users[me]) return json(res, 401, { error: 'Session expirée, reconnecte-toi' });

  if (p === '/api/logout' && req.method === 'POST') {
    await db.deleteSession(sha256(token));
    delete sessions[sha256(token)];
    return json(res, 200, { ok: true });
  }

  // Flux temps réel (Server-Sent Events)
  if (p === '/api/events' && req.method === 'GET') {
    // X-Accel-Buffering : empêche un éventuel proxy de retenir le flux temps réel
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const client = { res, user: me };
    const wasOnline = onlineUsers().includes(me);
    clients.add(client);
    send(client, 'hello', { channels, online: onlineUsers(), me });
    if (!wasOnline) broadcast('presence', { online: onlineUsers() });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
      if (!onlineUsers().includes(me)) broadcast('presence', { online: onlineUsers() });
    });
    return;
  }

  // Annuaire des clés publiques
  if (p === '/api/users' && req.method === 'GET') {
    return json(res, 200, { users: Object.entries(users).map(([name, u]) => ({ name, pub: u.pub })) });
  }

  // Clés de canal : chaque membre reçoit la clé du canal chiffrée pour lui (ECDH avec la clé publique de l'expéditeur)
  if (p === '/api/keys' && req.method === 'GET') {
    const mine = {}, holders = {};
    for (const ch of channels) {
      holders[ch] = keyHolders(ch);
      if (chanKeys[ch]?.[me]) mine[ch] = chanKeys[ch][me];
    }
    return json(res, 200, { mine, holders });
  }
  if (p === '/api/keys' && req.method === 'POST') {
    const body = await readJson(req);
    const ch = String(body.channel || '');
    if (!channels.includes(ch)) return json(res, 400, { error: 'Canal inconnu' });
    const existing = keyHolders(ch);
    // Seul un détenteur de la clé peut la partager ; le premier à créer la clé doit se l'inclure.
    if (existing.length && !existing.includes(me)) return json(res, 409, { error: 'La clé de ce canal existe déjà', holders: existing });
    if (!existing.length && !(body.keys || {})[me]) return json(res, 400, { error: 'La clé doit inclure son créateur' });
    const added = Object.entries(body.keys || {})
      .filter(([to, wrapped]) => users[to] && !chanKeys[ch]?.[to] && validEnc(wrapped)) // jamais d'écrasement
      .map(([to, wrapped]) => [to, { from: me, fromPub: users[me].pub, wrapped }]);
    await db.batch(added.map(([to, e]) => db.S.saveKey(ch, to, e)));
    chanKeys[ch] = chanKeys[ch] || {};
    for (const [to, e] of added) chanKeys[ch][to] = e;
    broadcast('keys', { channel: ch, holders: keyHolders(ch) });
    return json(res, 200, { holders: keyHolders(ch) });
  }

  // Historique d'un canal (messages racines + réponses « aussi envoyées dans le canal »), paginé avec ?before=id
  if (p === '/api/messages' && req.method === 'GET') {
    const channel = url.searchParams.get('channel') || '';
    if (!canSee(me, channel)) return json(res, 403, { error: 'Accès refusé' });
    const before = Number(url.searchParams.get('before')) || Infinity;
    const list = messages.filter(m => m.channel === channel && m.id < before && (!m.parent || m.broadcast));
    return json(res, 200, { messages: list.slice(-PAGE_SIZE).map(out), hasMore: list.length > PAGE_SIZE });
  }

  // Tous les messages visibles (récents) : la recherche se fait dans le navigateur, après déchiffrement
  if (p === '/api/all' && req.method === 'GET') {
    return json(res, 200, { messages: messages.filter(m => canSee(me, m.channel)).slice(-3000).map(out) });
  }

  // Fil de discussion : parent + réponses
  const th = p.match(/^\/api\/thread\/(\d+)$/);
  if (th && req.method === 'GET') {
    const parent = byId.get(Number(th[1]));
    if (!parent || !canSee(me, parent.channel)) return json(res, 404, { error: 'Fil introuvable' });
    return json(res, 200, { parent: out(parent), replies: replies.get(parent.id) || [] });
  }

  // Fils auxquels l'utilisateur participe, du plus récent au plus ancien
  if (p === '/api/threads' && req.method === 'GET') {
    const list = [];
    for (const [pid, r] of replies) {
      const parent = byId.get(pid);
      if (!parent || !canSee(me, parent.channel) || !participants(pid).includes(me)) continue;
      list.push({ parent: out(parent), latest: r.slice(-3) });
    }
    list.sort((a, b) => b.parent.thread.lastTs - a.parent.thread.lastTs);
    return json(res, 200, { threads: list.slice(0, 30) });
  }

  // Liste des DM de l'utilisateur
  if (p === '/api/dms' && req.method === 'GET') {
    const dms = [...new Set(messages.filter(m => isDm(m.channel) && canSee(me, m.channel)).map(m => m.channel))];
    return json(res, 200, { dms });
  }

  // Nouveau message chiffré (ou réponse dans un fil avec `parent`, ou fichier avec `fileId`)
  if (p === '/api/messages' && req.method === 'POST') {
    const body = await readJson(req);
    const channel = String(body.channel || '');
    if (!validEnc(body.enc)) return json(res, 400, { error: 'Message non chiffré refusé' });
    if (!validChannel(channel) || !canSee(me, channel)) return json(res, 400, { error: 'Canal inconnu' });
    if (!validParent(body.parent, channel)) return json(res, 400, { error: 'Fil introuvable' });
    const msg = { id: nextId++, channel, user: me, enc: { iv: body.enc.iv, ct: body.enc.ct }, ts: Date.now() };
    if (body.fileId) {
      const f = pendingFiles.get(body.fileId);
      if (!f || f.user !== me) return json(res, 400, { error: 'Fichier introuvable' });
      pendingFiles.delete(body.fileId);
      msg.file = { id: body.fileId, size: f.size };
    }
    if (body.parent) { msg.parent = Number(body.parent); if (body.broadcast) msg.broadcast = true; }
    await publish(msg);
    return json(res, 201, msg);
  }

  // Modification / suppression de son propre message, réactions
  const one = p.match(/^\/api\/messages\/(\d+)(\/react)?$/);
  if (one) {
    const msg = byId.get(Number(one[1]));
    if (!msg || !canSee(me, msg.channel)) return json(res, 404, { error: 'Message introuvable' });

    if (one[2] && req.method === 'POST') {
      const body = await readJson(req);
      const emoji = String(body.emoji || '').slice(0, 16);
      if (!emoji) return json(res, 400, { error: 'Réaction invalide' });
      toggleReaction(msg, emoji, me);
      await db.updateMessage(msg);
      broadcast('update', out(msg), msg.channel);
      return json(res, 200, out(msg));
    }

    if (!one[2] && req.method === 'PATCH') {
      const body = await readJson(req);
      if (msg.user !== me) return json(res, 403, { error: 'Ce n\'est pas ton message' });
      if (!validEnc(body.enc)) return json(res, 400, { error: 'Message non chiffré refusé' });
      msg.enc = { iv: body.enc.iv, ct: body.enc.ct };
      delete msg.text; // un ancien message en clair devient chiffré une fois modifié
      msg.edited = Date.now();
      await db.updateMessage(msg);
      broadcast('update', out(msg), msg.channel);
      return json(res, 200, out(msg));
    }

    if (!one[2] && req.method === 'DELETE') {
      if (msg.user !== me) return json(res, 403, { error: 'Ce n\'est pas ton message' });
      // Supprimer un message racine supprime aussi son fil
      const doomed = [...(replies.get(msg.id) || []), msg];
      await db.batch(doomed.map(m => db.S.deleteMessage(m.id)));
      for (const m of doomed) {
        removeFromIndex(m);
        if (m.file) fs.rm(path.join(UPLOAD_DIR, m.file.id), () => {});
        broadcast('delete', { id: m.id, channel: m.channel, parent: m.parent || null }, m.channel);
      }
      if (msg.parent && byId.has(msg.parent)) broadcast('update', out(byId.get(msg.parent)), msg.channel);
      return json(res, 200, { ok: true });
    }
  }

  // Indicateur « est en train d'écrire »
  if (p === '/api/typing' && req.method === 'POST') {
    const body = await readJson(req);
    const channel = String(body.channel || '');
    if (validChannel(channel) && canSee(me, channel)) {
      broadcast('typing', { user: me, channel, parent: Number(body.parent) || null }, channel);
    }
    res.writeHead(204); return res.end();
  }

  // Création de canal
  if (p === '/api/channels' && req.method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').toLowerCase().trim().replace(/[^a-z0-9\-_]/g, '-').replace(/-+/g, '-').slice(0, 40);
    if (!name || name === '-') return json(res, 400, { error: 'Nom invalide' });
    if (!channels.includes(name)) {
      await db.saveChannel(name);
      channels.push(name);
      broadcast('channels', { channels });
    }
    return json(res, 201, { name });
  }

  // Envoi d'un fichier chiffré (corps brut). Il est rattaché ensuite à un message via `fileId`.
  if (p === '/api/upload' && req.method === 'POST') {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) return json(res, 413, { error: 'Fichier trop gros (500 Mo max)' });
    const id = crypto.randomBytes(12).toString('hex');
    const dest = path.join(UPLOAD_DIR, id);
    const outStream = fs.createWriteStream(dest);
    let size = 0, aborted = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_UPLOAD && !aborted) {
        aborted = true;
        req.unpipe(outStream); outStream.destroy(); fs.rm(dest, () => {});
        json(res, 413, { error: 'Fichier trop gros (500 Mo max)' });
      }
    });
    req.pipe(outStream);
    outStream.on('finish', () => {
      if (aborted) return;
      pendingFiles.set(id, { user: me, size, ts: Date.now() });
      json(res, 201, { fileId: id, size });
    });
    outStream.on('error', () => { if (!aborted) json(res, 500, { error: 'Écriture impossible' }); });
    return;
  }

  // Téléchargement : /files/<id>[/<nom>] — contrôle d'accès selon le canal du message
  const f = p.match(/^\/files\/([a-f0-9]{24})(?:\/(.+))?$/);
  if (f && req.method === 'GET') {
    const file = path.join(UPLOAD_DIR, f[1]);
    const owner = messages.find(m => m.file && m.file.id === f[1]);
    if (!owner || !canSee(me, owner.channel) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Fichier introuvable'); }
    const name = owner.enc ? 'fichier-chiffre.bin' : decodeURIComponent(f[2] || owner.file.name || 'fichier');
    const ext = path.extname(name).toLowerCase();
    const inline = !owner.enc && INLINE_OK.has(ext) && url.searchParams.get('dl') !== '1';
    res.writeHead(200, {
      'Content-Type': inline ? (MIME[ext] || 'application/octet-stream') : 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    });
    return fs.createReadStream(file).pipe(res);
  }

  json(res, 404, { error: 'Introuvable' });
}

function handler(req, res) {
  handle(req, res).catch(err => {
    if (!res.headersSent) json(res, 400, { error: err.message || 'Erreur' });
  });
}

// ---------- HTTPS (certificat auto-signé généré au premier lancement) ----------
function loadTls() {
  if (process.env.LANCHAT_HTTP === '1') return null;
  const keyFile = path.join(TLS_DIR, 'key.pem'), certFile = path.join(TLS_DIR, 'cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(TLS_DIR, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps().map(ip => 'IP:' + ip)].join(',');
    const base = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '3650', '-subj', '/CN=LAN Chat'];
    try { execFileSync('openssl', [...base, '-addext', 'subjectAltName=' + san], { stdio: 'ignore' }); }
    catch {
      try { execFileSync('openssl', base, { stdio: 'ignore' }); }
      catch { return null; }
    }
    fs.chmodSync(keyFile, 0o600);
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

const tls = loadTls();
let server;
if (tls) {
  const secure = https.createServer(tls, handler);
  secure.requestTimeout = 0; // gros uploads sur réseau lent
  // Quelqu'un qui tape http:// sur le même port est redirigé vers https://
  const redirect = http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host || 'localhost:' + PORT}${req.url}` });
    res.end();
  });
  server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', buf => {
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? secure : redirect).emit('connection', socket); // 0x16 = début d'une poignée de main TLS
      process.nextTick(() => socket.resume());
    });
  });
} else {
  server = http.createServer(handler);
  server.requestTimeout = 0;
}

// ---------- Démarrage ----------
async function boot() {
  db = await openDb({ dataDir: DATA_DIR, url: process.env.DATABASE_URL });

  // Commande d'administration : node server.js reset-user <nom>
  if (process.argv[2] === 'reset-user') {
    const name = process.argv[3];
    const loaded = await db.load();
    if (!loaded.users[name]) { console.error(`Compte « ${name} » introuvable.`); process.exit(1); }
    await db.deleteUser(name); // ses sessions et les clés de canal qu'il avait reçues partent avec (cascade)
    console.log(`Compte « ${name} » supprimé. Il peut être recréé ; ses anciens messages privés resteront illisibles pour lui.`);
    console.log('Redémarre le serveur pour que la suppression soit prise en compte.');
    await db.close();
    process.exit(0);
  }

  if (!(await db.getConfig('accessCode'))) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const part = () => Array.from(crypto.randomBytes(4), b => alphabet[b % alphabet.length]).join('');
    await db.setConfig('accessCode', `${part()}-${part()}`);
  }
  ACCESS_CODE = process.env.LANCHAT_CODE || await db.getConfig('accessCode');

  const loaded = await db.load();
  ({ users, sessions, chanKeys, channels } = loaded);
  loaded.messages.forEach(addToIndex);
  nextId = Math.max(messages.reduce((max, m) => Math.max(max, m.id), 0), Number(await db.getConfig('lastId')) || 0) + 1;

  // Ménage : fichiers orphelins (envoi interrompu) de plus d'une heure
  const used = new Set(messages.filter(m => m.file).map(m => m.file.id));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    if (!used.has(f) && Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true });
  }

  server.listen(PORT, '0.0.0.0', onListening);
}

function onListening() {
  const scheme = tls ? 'https' : 'http';
  console.log('\n  💬 LAN Chat démarré\n');
  console.log(`  Sur cette machine  : ${scheme}://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`  Pour les collègues : ${scheme}://${ip}:${PORT}`);
  console.log(`\n  🔑 Code d'accès pour créer un compte : ${ACCESS_CODE}`);
  if (tls) {
    console.log('\n  Certificat auto-signé : au premier accès, le navigateur affiche un avertissement.');
    console.log('  Clique sur « Paramètres avancés » puis « Continuer vers le site ».');
  } else if (process.env.LANCHAT_HTTP === '1') {
    console.log('\n  Mode HTTP : à placer derrière un proxy HTTPS (Dokploy/Traefik). Le chiffrement exige HTTPS côté navigateur.');
  } else {
    console.log('\n  ⚠️  HTTPS indisponible (openssl introuvable) : le chiffrement de bout en bout ne fonctionnera');
    console.log('     que sur http://localhost. Installe openssl, ou place cert.pem et key.pem dans data/tls/.');
  }
  console.log(`\n  Base de données : ${db.label}\n`);
}

boot().catch(err => { console.error('\n  Démarrage impossible :', err.message, '\n'); process.exit(1); });
