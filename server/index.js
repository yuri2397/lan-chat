// LAN Chat — serveur. Une seule dépendance facultative (pg, pour PostgreSQL).
//
//   node server.js                     démarre le chat (PORT=3000 par défaut, HTTPS auto-signé)
//   LANCHAT_HTTP=1 node server.js      HTTP simple, derrière un proxy HTTPS (Dokploy/Traefik, voir Dockerfile)
//   DATABASE_URL=postgres://…          PostgreSQL (sinon SQLite dans DATA_DIR, sans rien installer)
//   node server.js reset-user <nom>    supprime un compte (mot de passe oublié) pour qu'il puisse être recréé
//   node server.js make-admin <nom>    donne le rôle d'administrateur à un compte
//
// Organisation :
//   config.js    réglages (variables d'environnement)
//   db.js        PostgreSQL / SQLite, schéma et migrations
//   model.js     état en mémoire (comptes, canaux, messages…) et règles d'accès
//   realtime.js  flux Server-Sent Events
//   http.js      routeur, JSON, fichiers statiques compressés
//   routes/      une route par fonctionnalité (auth, workspace, channels, messages, files, calls)
//
// Sécurité : textes et fichiers arrivent ici déjà chiffrés (AES-GCM, dans le navigateur). Le serveur stocke et
// relaie des données qu'il ne peut pas lire. Restent en clair : pseudos et profils, noms et sujets des canaux,
// horaires, réactions, personnes mentionnées. HTTPS obligatoire (WebCrypto n'existe qu'en contexte sécurisé).
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./config');
const M = require('./model');
const { openDb } = require('./db');
const { json, match, serveStatic, readJson, HttpError } = require('./http');
require('./routes/auth');
require('./routes/workspace');
require('./routes/channels');
require('./routes/messages');
require('./routes/calls');
const { cleanOrphans } = require('./routes/files');
const { sessionUser } = require('./routes/auth');
const { newCode } = require('./routes/workspace');

fs.mkdirSync(C.UPLOAD_DIR, { recursive: true });
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

// ---------- Requêtes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Sonde de santé (Docker / Dokploy) : vérifie aussi la base
  if (p === '/api/health') {
    try { await M.db.ping(); return json(res, 200, { ok: true }); }
    catch { return json(res, 503, { ok: false, error: 'Base de données injoignable' }); }
  }
  // L'application elle-même
  if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/') && !p.startsWith('/files/')) {
    if (serveStatic(req, res, p, url.searchParams)) return;
    return json(res, 404, { error: 'Introuvable' });
  }

  const found = match(req.method, p);
  if (!found) return json(res, 404, { error: 'Introuvable' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token') || '';
  const me = sessionUser(token);
  if (!found.r.opts.public && !me) return json(res, 401, { error: 'Session expirée, reconnecte-toi' });

  const ctx = { req, res, url, me, token, params: found.params, status: 200 };
  let parsed;
  ctx.body = () => (parsed = parsed || readJson(req));
  ctx.ctx = ctx;
  const result = await found.r.handler(ctx);
  if (result === false) return; // réponse déjà envoyée (flux, fichier)
  json(res, ctx.status, result ?? { ok: true });
}
function handler(req, res) {
  handle(req, res).catch(err => {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Erreur', ...(err.extra || {}) });
  });
}

// ---------- HTTPS (certificat auto-signé généré au premier lancement) ----------
function loadTls() {
  if (C.HTTP_ONLY) return null;
  const keyFile = path.join(C.TLS_DIR, 'key.pem'), certFile = path.join(C.TLS_DIR, 'cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(C.TLS_DIR, { recursive: true });
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
function createServer(tls) {
  if (!tls) { const s = http.createServer(handler); s.requestTimeout = 0; return s; }
  const secure = https.createServer(tls, handler);
  secure.requestTimeout = 0; // gros envois sur réseau lent
  // Quelqu'un qui tape http:// sur le même port est redirigé vers https://
  const redirect = http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host || 'localhost:' + C.PORT}${req.url}` });
    res.end();
  });
  return net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', buf => {
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? secure : redirect).emit('connection', socket); // 0x16 = début d'une poignée de main TLS
      process.nextTick(() => socket.resume());
    });
  });
}

// ---------- Commandes d'administration ----------
async function cli(db, cmd, name) {
  const loaded = await db.load();
  if (!name || !loaded.users[name]) { console.error(`Compte « ${name || ''} » introuvable.`); process.exit(1); }
  if (cmd === 'reset-user') {
    await db.write(db.S.deleteUser(name)); // ses sessions, clés reçues, préférences… partent avec (cascade)
    console.log(`Compte « ${name} » supprimé. Il peut être recréé ; ses anciens messages privés resteront illisibles pour lui.`);
  } else {
    await db.write(db.S.saveUser(name, { ...loaded.users[name], role: loaded.users[name].role === 'owner' ? 'owner' : 'admin' }));
    console.log(`« ${name} » est maintenant administrateur.`);
  }
  console.log('Redémarre le serveur pour que le changement soit pris en compte.');
  await db.close();
  process.exit(0);
}

// ---------- Démarrage ----------
async function boot() {
  const db = await openDb({ dataDir: C.DATA_DIR, url: C.DATABASE_URL });
  if (['reset-user', 'make-admin'].includes(process.argv[2])) return cli(db, process.argv[2], process.argv[3]);

  if (!(await db.getConfig('accessCode'))) await db.setConfig('accessCode', newCode());
  M.accessCode = C.ACCESS_CODE_ENV || await db.getConfig('accessCode');
  M.workspace.name = (await db.getConfig('workspaceName')) || 'LAN Chat';
  M.init(db, await db.load());
  M.nextId = Math.max(M.messages.reduce((max, m) => Math.max(max, m.id), 0), Number(await db.getConfig('lastId')) || 0) + 1;
  cleanOrphans();
  setInterval(cleanOrphans, 3600e3).unref();

  const tls = loadTls();
  createServer(tls).listen(C.PORT, '0.0.0.0', () => {
    const scheme = tls ? 'https' : 'http';
    console.log(`\n  💬 ${M.workspace.name} démarré\n`);
    console.log(`  Sur cette machine  : ${scheme}://localhost:${C.PORT}`);
    for (const ip of lanIps()) console.log(`  Pour les collègues : ${scheme}://${ip}:${C.PORT}`);
    console.log(`\n  🔑 Code d'accès pour créer un compte : ${M.accessCode}`);
    if (tls) {
      console.log('\n  Certificat auto-signé : au premier accès, le navigateur affiche un avertissement.');
      console.log('  Clique sur « Paramètres avancés » puis « Continuer vers le site ».');
    } else if (C.HTTP_ONLY) {
      console.log('\n  Mode HTTP : à placer derrière un proxy HTTPS (Dokploy/Traefik). Le chiffrement exige HTTPS côté navigateur.');
    } else {
      console.log('\n  ⚠️  HTTPS indisponible (openssl introuvable) : le chiffrement de bout en bout ne fonctionnera');
      console.log('     que sur http://localhost. Installe openssl, ou place cert.pem et key.pem dans data/tls/.');
    }
    console.log(`\n  Base de données : ${db.label}\n`);
  });
}

boot().catch(err => { console.error('\n  Démarrage impossible :', err.message, '\n'); process.exit(1); });
