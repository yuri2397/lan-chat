// Tests de l'API : un vrai serveur (SQLite, dossier temporaire) piloté par des requêtes HTTP.
// Lancer : npm test (Node 22.13+). Le chiffrement se fait dans le navigateur ; ici, des chiffrés factices suffisent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-test-'));
let server;
const b64 = n => crypto.randomBytes(n).toString('base64');
const enc = () => ({ iv: b64(12), ct: b64(48) });

async function call(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
const accounts = {};
async function register(name, code = 'test') {
  const r = await call('POST', '/api/register', { body: { name, code, authKey: b64(32), kdfSalt: b64(16), pub: b64(65), encPriv: enc() } });
  if (r.status === 201) accounts[name] = r.data.token;
  return r;
}
// Premier événement du flux temps réel (« hello ») : état complet vu par un compte
async function hello(token) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?token=${encodeURIComponent(token)}&device=test`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = '';
  while (!buf.includes('event: hello')) buf += new TextDecoder().decode((await reader.read()).value);
  while (!/event: hello\ndata: .*\n\n/.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  return JSON.parse(buf.match(/event: hello\ndata: (.*)\n\n/)[1]);
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), LANCHAT_HTTP: '1', LANCHAT_CODE: 'test', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('le serveur ne démarre pas')), 15000);
    server.stdout.on('data', d => { if (String(d).includes('démarré')) { clearTimeout(t); setTimeout(resolve, 150); } });
    server.on('exit', code => reject(new Error('serveur arrêté : ' + code)));
  });
});
after(() => { server?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('application servie compressée, avec empreintes et cache', async () => {
  const r = await fetch(BASE + '/', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'br');
  const html = await r.text();
  assert.match(html, /<script type="importmap">/);
  const css = html.match(/href="(\/css\/app\.css\?v=[^"]+)"/)[1];
  const c = await fetch(BASE + css);
  assert.match(c.headers.get('cache-control'), /immutable/);
  const again = await fetch(BASE + '/', { headers: { 'If-None-Match': r.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('comptes : code d’accès, propriétaire, doublons, connexion', async () => {
  assert.equal((await register('awa', 'faux')).status, 403);
  assert.equal((await register('awa')).status, 201);
  assert.equal((await register('awa')).status, 409);
  assert.equal((await register('moussa')).status, 201);
  assert.equal((await register('fatou')).status, 201);
  const { data } = await call('GET', '/api/users', { token: accounts.moussa });
  assert.equal(data.users.find(u => u.name === 'awa').role, 'owner');
  assert.equal(data.users.find(u => u.name === 'moussa').role, 'member');
  assert.equal((await call('POST', '/api/login', { body: { name: 'awa', authKey: b64(32) } })).status, 401);
  assert.equal((await call('GET', '/api/users')).status, 401);
});

test('messages, non-lus et mentions synchronisés', async () => {
  const sent = await call('POST', '/api/messages', { token: accounts.awa, body: { channel: 'general', enc: enc(), mentions: ['moussa', 'inconnu'] } });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.data.mentions, ['moussa']);
  assert.equal((await call('POST', '/api/messages', { token: accounts.awa, body: { channel: 'general', text: 'en clair' } })).status, 400);
  const h = await hello(accounts.moussa);
  assert.deepEqual(h.unread.general, { count: 1, mentions: 1 });
  await call('POST', '/api/read', { token: accounts.moussa, body: { key: 'general', id: sent.data.id } });
  assert.equal((await hello(accounts.moussa)).unread.general, undefined);
  const list = await call('GET', '/api/messages?channel=general', { token: accounts.fatou });
  assert.equal(list.data.messages.length, 1);
});

test('fils, réactions, épingles, plus tard', async () => {
  const root = (await call('POST', '/api/messages', { token: accounts.awa, body: { channel: 'general', enc: enc() } })).data;
  const reply = await call('POST', '/api/messages', { token: accounts.moussa, body: { channel: 'general', enc: enc(), parent: root.id } });
  assert.equal(reply.status, 201);
  assert.ok((await hello(accounts.awa)).threads.includes(root.id));
  const t = await call('GET', `/api/thread/${root.id}`, { token: accounts.fatou });
  assert.equal(t.data.replies.length, 1);
  const r = await call('POST', `/api/messages/${root.id}/react`, { token: accounts.fatou, body: { emoji: '🎉' } });
  assert.deepEqual(r.data.reactions, { '🎉': ['fatou'] });
  await call('POST', `/api/messages/${root.id}/pin`, { token: accounts.moussa, body: { on: true } });
  assert.equal((await call('GET', '/api/pins?channel=general', { token: accounts.fatou })).data.messages[0].id, root.id);
  await call('POST', `/api/messages/${root.id}/save`, { token: accounts.fatou, body: { on: true, remindAt: Date.now() + 3600e3 } });
  const saved = await call('GET', '/api/saved', { token: accounts.fatou });
  assert.equal(saved.data.items[0].id, root.id);
  assert.equal((await call('GET', '/api/saved', { token: accounts.awa })).data.items.length, 0);
  assert.equal((await call('DELETE', `/api/messages/${root.id}`, { token: accounts.fatou })).status, 403);
  assert.equal((await call('DELETE', `/api/messages/${root.id}`, { token: accounts.awa })).status, 200);
  assert.equal((await call('GET', `/api/thread/${root.id}`, { token: accounts.awa })).status, 404);
});

test('canal privé : invisible et illisible pour les non-membres', async () => {
  const c = await call('POST', '/api/channels', { token: accounts.awa, body: { name: 'Projet Secret', private: true, members: ['moussa'] } });
  assert.equal(c.status, 201);
  assert.equal(c.data.name, 'projet-secret');
  assert.deepEqual(c.data.members.sort(), ['awa', 'moussa']);
  await call('POST', '/api/messages', { token: accounts.moussa, body: { channel: 'projet-secret', enc: enc() } });
  assert.equal((await call('GET', '/api/messages?channel=projet-secret', { token: accounts.fatou })).status, 403);
  assert.equal((await call('POST', '/api/messages', { token: accounts.fatou, body: { channel: 'projet-secret', enc: enc() } })).status, 400);
  assert.ok(!(await hello(accounts.fatou)).channels.some(x => x.name === 'projet-secret'));
  // La clé du canal ne peut être confiée qu'à ses membres
  const keys = await call('POST', '/api/keys', { token: accounts.awa, body: { channel: 'projet-secret', keys: { awa: enc(), fatou: enc() } } });
  assert.deepEqual(keys.data.holders, ['awa']);
  // Retirer un membre : réservé au créateur et aux admins
  assert.equal((await call('POST', '/api/channels/projet-secret/members', { token: accounts.moussa, body: { remove: ['awa'] } })).status, 403);
  await call('POST', '/api/channels/projet-secret/members', { token: accounts.awa, body: { add: ['fatou'] } });
  assert.equal((await call('GET', '/api/messages?channel=projet-secret', { token: accounts.fatou })).status, 200);
});

test('canal public : rejoindre, quitter, archiver', async () => {
  await call('POST', '/api/channels', { token: accounts.moussa, body: { name: 'cafe' } });
  assert.equal((await call('POST', '/api/channels/cafe/leave', { token: accounts.fatou })).status, 200);
  let h = await hello(accounts.fatou);
  assert.ok(!h.channels.find(x => x.name === 'cafe').members.includes('fatou'));
  // Écrire dans un canal public le fait rejoindre
  await call('POST', '/api/messages', { token: accounts.fatou, body: { channel: 'cafe', enc: enc() } });
  h = await hello(accounts.fatou);
  assert.ok(h.channels.find(x => x.name === 'cafe').members.includes('fatou'));
  assert.equal((await call('PATCH', '/api/channels/cafe', { token: accounts.fatou, body: { archived: true } })).status, 403);
  assert.equal((await call('PATCH', '/api/channels/cafe', { token: accounts.moussa, body: { archived: true, topic: 'Fermé' } })).status, 200);
  assert.equal((await call('POST', '/api/messages', { token: accounts.fatou, body: { channel: 'cafe', enc: enc() } })).status, 400);
  assert.equal((await call('POST', '/api/channels/general/leave', { token: accounts.fatou })).status, 400);
});

test('messages directs et envois programmés', async () => {
  const dm = '@awa|fatou';
  assert.equal((await call('POST', '/api/messages', { token: accounts.moussa, body: { channel: dm, enc: enc() } })).status, 400);
  assert.equal((await call('GET', `/api/messages?channel=${encodeURIComponent(dm)}`, { token: accounts.moussa })).status, 403);
  assert.equal((await call('POST', '/api/scheduled', { token: accounts.awa, body: { channel: dm, enc: enc(), at: Date.now() - 1000 } })).status, 400);
  const s = await call('POST', '/api/scheduled', { token: accounts.awa, body: { channel: dm, enc: enc(), at: Date.now() + 3600e3 } });
  assert.equal(s.status, 201);
  assert.equal((await call('GET', '/api/scheduled', { token: accounts.fatou })).data.items.length, 0);
  assert.equal((await call('POST', `/api/scheduled/${s.data.id}/send`, { token: accounts.awa })).status, 200);
  const list = await call('GET', `/api/messages?channel=${encodeURIComponent(dm)}`, { token: accounts.fatou });
  assert.equal(list.data.messages.length, 1);
  assert.equal((await hello(accounts.fatou)).unread[dm].mentions, 1); // un message direct compte comme une mention
});

test('profils et administration', async () => {
  const me = await call('PATCH', '/api/me', { token: accounts.moussa, body: { displayName: 'Moussa Diop', title: 'Dev', status: { emoji: '📅', text: 'En réunion', until: Date.now() + 3600e3 } } });
  assert.equal(me.data.displayName, 'Moussa Diop');
  assert.equal(me.data.status.text, 'En réunion');
  assert.equal((await call('GET', '/api/admin', { token: accounts.moussa })).status, 403);
  const adm = await call('GET', '/api/admin', { token: accounts.awa });
  assert.equal(adm.data.accessCode, 'test');
  assert.equal((await call('POST', '/api/admin/users/moussa', { token: accounts.awa, body: { role: 'admin' } })).data.role, 'admin');
  assert.equal((await call('POST', '/api/admin/users/awa', { token: accounts.moussa, body: { deactivated: true } })).status, 403);
  assert.equal((await call('POST', '/api/admin/users/fatou', { token: accounts.moussa, body: { deactivated: true } })).status, 200);
  assert.equal((await call('GET', '/api/users', { token: accounts.fatou })).status, 401);
  assert.equal((await call('POST', '/api/messages', { token: accounts.awa, body: { channel: '@awa|fatou', enc: enc() } })).status, 400);
});
