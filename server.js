#!/usr/bin/env node
// LAN Chat — petit chat façon Slack pour le réseau local. Zéro dépendance.
// Lancer : node server.js   (PORT=3000 par défaut)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const MAX_UPLOAD = 500 * 1024 * 1024; // 500 Mo
const MAX_JSON = 1024 * 1024; // 1 Mo
const PAGE_SIZE = 100;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- État en mémoire ----------
let channels = ['general', 'code', 'liens'];
if (fs.existsSync(CHANNELS_FILE)) {
  try { channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')); } catch {}
}
const saveChannels = () => fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels));

const messages = []; // { id, channel, user, text, file?, ts, edited? , deleted? }
if (fs.existsSync(MESSAGES_FILE)) {
  for (const line of fs.readFileSync(MESSAGES_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.op === 'delete') {
        const i = messages.findIndex(x => x.id === m.id);
        if (i >= 0) messages.splice(i, 1);
      } else messages.push(m);
    } catch {}
  }
}
let nextId = messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;
const appendLog = obj => fs.appendFileSync(MESSAGES_FILE, JSON.stringify(obj) + '\n');

// clients SSE : Set<{ res, user }>
const clients = new Set();
const onlineUsers = () => [...new Set([...clients].map(c => c.user))].sort((a, b) => a.localeCompare(b));

// Un DM s'appelle "@alice|bob" (noms triés). Pas d'authentification : réseau de confiance.
const isDm = ch => ch.startsWith('@');
const dmMembers = ch => ch.slice(1).split('|');
const canSee = (user, ch) => !isDm(ch) || dmMembers(ch).includes(user);
const validChannel = ch => channels.includes(ch) || (isDm(ch) && dmMembers(ch).length === 2);

function send(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data, channel) {
  for (const c of clients) if (!channel || canSee(c.user, channel)) send(c, event, data);
}

// ---------- Helpers HTTP ----------
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
const cleanName = s => String(s || '').trim().slice(0, 32);
const safeFileName = s => String(s || 'fichier').replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '_').slice(0, 150) || 'fichier';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.zip': 'application/zip', '.ico': 'image/x-icon',
};
// Types affichables dans le navigateur sans risque (le SVG/HTML est forcé en téléchargement).
const INLINE_OK = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.mp4', '.webm', '.mp3', '.txt']);

// ---------- Routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Flux temps réel (Server-Sent Events)
  if (p === '/api/events' && req.method === 'GET') {
    const user = cleanName(url.searchParams.get('user'));
    if (!user) return json(res, 400, { error: 'Pseudo requis' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const client = { res, user };
    const wasOnline = onlineUsers().includes(user);
    clients.add(client);
    send(client, 'hello', { channels, online: onlineUsers() });
    if (!wasOnline) broadcast('presence', { online: onlineUsers() });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
      if (!onlineUsers().includes(user)) broadcast('presence', { online: onlineUsers() });
    });
    return;
  }

  // Historique d'un canal (paginé avec ?before=id)
  if (p === '/api/messages' && req.method === 'GET') {
    const channel = url.searchParams.get('channel') || '';
    const user = cleanName(url.searchParams.get('user'));
    if (!canSee(user, channel)) return json(res, 403, { error: 'Accès refusé' });
    const before = Number(url.searchParams.get('before')) || Infinity;
    const list = messages.filter(m => m.channel === channel && m.id < before);
    return json(res, 200, { messages: list.slice(-PAGE_SIZE), hasMore: list.length > PAGE_SIZE });
  }

  // Liste des DM de l'utilisateur
  if (p === '/api/dms' && req.method === 'GET') {
    const user = cleanName(url.searchParams.get('user'));
    const dms = [...new Set(messages.filter(m => isDm(m.channel) && canSee(user, m.channel)).map(m => m.channel))];
    return json(res, 200, { dms });
  }

  // Recherche plein texte
  if (p === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const user = cleanName(url.searchParams.get('user'));
    if (!q) return json(res, 200, { messages: [] });
    const found = messages.filter(m => canSee(user, m.channel) &&
      ((m.text || '').toLowerCase().includes(q) || (m.file && m.file.name.toLowerCase().includes(q))));
    return json(res, 200, { messages: found.slice(-50).reverse() });
  }

  // Nouveau message texte
  if (p === '/api/messages' && req.method === 'POST') {
    const body = await readJson(req);
    const user = cleanName(body.user);
    const text = String(body.text || '').slice(0, 100000);
    const channel = String(body.channel || '');
    if (!user || !text.trim()) return json(res, 400, { error: 'Pseudo et texte requis' });
    if (!validChannel(channel) || !canSee(user, channel)) return json(res, 400, { error: 'Canal inconnu' });
    const msg = { id: nextId++, channel, user, text, ts: Date.now() };
    messages.push(msg);
    appendLog(msg);
    broadcast('message', msg, channel);
    return json(res, 201, msg);
  }

  // Suppression de son propre message
  const del = p.match(/^\/api\/messages\/(\d+)$/);
  if (del && req.method === 'DELETE') {
    const user = cleanName(url.searchParams.get('user'));
    const i = messages.findIndex(m => m.id === Number(del[1]));
    if (i < 0) return json(res, 404, { error: 'Introuvable' });
    const msg = messages[i];
    if (msg.user !== user) return json(res, 403, { error: 'Ce n\'est pas ton message' });
    messages.splice(i, 1);
    appendLog({ op: 'delete', id: msg.id });
    if (msg.file) fs.rm(path.join(UPLOAD_DIR, msg.file.id), () => {});
    broadcast('delete', { id: msg.id, channel: msg.channel }, msg.channel);
    return json(res, 200, { ok: true });
  }

  // Création de canal
  if (p === '/api/channels' && req.method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').toLowerCase().trim().replace(/[^a-z0-9\-_]/g, '-').replace(/-+/g, '-').slice(0, 40);
    if (!name || name === '-') return json(res, 400, { error: 'Nom invalide' });
    if (!channels.includes(name)) {
      channels.push(name);
      saveChannels();
      broadcast('channels', { channels });
    }
    return json(res, 201, { name });
  }

  // Upload de fichier (corps brut, métadonnées en query string)
  if (p === '/api/upload' && req.method === 'POST') {
    const user = cleanName(url.searchParams.get('user'));
    const channel = url.searchParams.get('channel') || '';
    const name = safeFileName(url.searchParams.get('name'));
    const text = String(url.searchParams.get('text') || '').slice(0, 2000);
    if (!user || !validChannel(channel) || !canSee(user, channel)) return json(res, 400, { error: 'Requête invalide' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) return json(res, 413, { error: 'Fichier trop gros (500 Mo max)' });

    const id = crypto.randomBytes(12).toString('hex');
    const dest = path.join(UPLOAD_DIR, id);
    const out = fs.createWriteStream(dest);
    let size = 0, aborted = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_UPLOAD && !aborted) {
        aborted = true;
        req.unpipe(out); out.destroy(); fs.rm(dest, () => {});
        json(res, 413, { error: 'Fichier trop gros (500 Mo max)' });
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      const file = { id, name, size, type: req.headers['content-type'] || 'application/octet-stream' };
      const msg = { id: nextId++, channel, user, text, file, ts: Date.now() };
      messages.push(msg);
      appendLog(msg);
      broadcast('message', msg, channel);
      json(res, 201, msg);
    });
    out.on('error', () => { if (!aborted) json(res, 500, { error: 'Écriture impossible' }); });
    return;
  }

  // Téléchargement : /files/<id>/<nom>
  const f = p.match(/^\/files\/([a-f0-9]{24})\/(.+)$/);
  if (f && req.method === 'GET') {
    const file = path.join(UPLOAD_DIR, f[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Fichier introuvable'); }
    const name = decodeURIComponent(f[2]);
    const ext = path.extname(name).toLowerCase();
    const inline = INLINE_OK.has(ext) && url.searchParams.get('dl') !== '1';
    res.writeHead(200, {
      'Content-Type': inline ? (MIME[ext] || 'application/octet-stream') : 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    return fs.createReadStream(file).pipe(res);
  }

  // Fichiers statiques
  if (req.method === 'GET') {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
    if (file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
  }

  json(res, 404, { error: 'Introuvable' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) json(res, 400, { error: err.message || 'Erreur' });
  });
});
server.requestTimeout = 0; // gros uploads sur réseau lent

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  💬 LAN Chat démarré\n');
  console.log(`  Sur cette machine : http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Pour les collègues : http://${ip}:${PORT}`);
  console.log(`\n  Données : ${DATA_DIR}\n`);
});
