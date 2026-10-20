// Comptes : création (protégée par le code d'accès), connexion, déconnexion.
// Le mot de passe ne quitte jamais le navigateur : il en dérive une clé d'authentification (seule reçue ici,
// re-hachée avec scrypt) et une clé qui chiffre la clé privée d'identité.
const crypto = require('crypto');
const M = require('../model');
const rt = require('../realtime');
const { route, fail, isB64, validEnc, str } = require('../http');
const { NAME_RE } = require('../config');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hashAuthKey = (authKey, salt) =>
  crypto.scryptSync(Buffer.from(String(authKey), 'base64'), Buffer.from(salt, 'base64'), 32).toString('base64');

async function newSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const s = { user, created: Date.now() };
  await M.db.write(M.db.S.saveSession(sha256(token), s));
  M.sessions[sha256(token)] = s;
  return token;
}
const sessionUser = token => {
  const user = token && M.sessions[sha256(token)]?.user;
  return user && M.active(user) ? user : null;
};
async function dropSessions(user) {
  for (const [h, s] of Object.entries(M.sessions)) if (s.user === user) delete M.sessions[h];
  await M.db.write(M.db.S.deleteUserSessions(user));
}

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

route('GET', '/api/prelogin', ({ url }) => {
  const u = M.users[url.searchParams.get('name') || ''];
  return { exists: !!u, kdfSalt: u ? u.kdfSalt : null, workspace: M.workspace.name };
}, { public: true });

route('POST', '/api/register', async ({ body, ctx }) => {
  const b = await body();
  const name = str(b.name, 64);
  if (!NAME_RE.test(name)) fail(400, 'Pseudo invalide (2 à 32 lettres, chiffres, . - _)');
  const wait = checkThrottle('register');
  if (wait) fail(429, `Trop de tentatives, réessaie dans ${wait} s`);
  if (str(b.code, 64).toLowerCase() !== M.accessCode.toLowerCase()) {
    recordFailure('register');
    fail(403, 'Code d\'accès incorrect. Demande-le à la personne qui administre le chat.');
  }
  if (M.users[name]) fail(409, 'Ce pseudo est déjà pris');
  if (!isB64(b.authKey, 64) || !isB64(b.kdfSalt, 64) || !isB64(b.pub, 200) || !validEnc(b.encPriv)) fail(400, 'Données de compte invalides');
  const authSalt = crypto.randomBytes(16).toString('base64');
  const first = !Object.keys(M.users).length;
  M.users[name] = {
    authSalt, authHash: hashAuthKey(b.authKey, authSalt), kdfSalt: b.kdfSalt, pub: b.pub, encPriv: b.encPriv,
    created: Date.now(), role: first ? 'owner' : 'member', deactivated: false,
    profile: { displayName: str(b.displayName, 60) }, avatar: null,
  };
  // Le nouveau venu rejoint les canaux publics et part de « tout est lu »
  const ops = [M.db.S.saveUser(name, M.users[name])];
  for (const c of M.channels.values()) {
    if (c.private || c.archived) continue;
    M.members.get(c.name).add(name);
    ops.push(M.db.S.addMember(c.name, name));
    const last = M.messages.findLast(m => m.channel === c.name);
    if (last) { (M.reads[name] = M.reads[name] || {})[c.name] = last.id; ops.push(M.db.S.saveRead(name, c.name, last.id)); }
  }
  await M.db.batch(ops);
  rt.broadcast('user', M.userView(name));
  for (const c of M.channels.values()) if (M.members.get(c.name).has(name)) rt.broadcast('channel', M.channelView(c), c.name);
  ctx.status = 201;
  return { token: await newSession(name), name };
}, { public: true });

route('POST', '/api/login', async ({ body }) => {
  const b = await body();
  const name = str(b.name, 64);
  const wait = checkThrottle(name);
  if (wait) fail(429, `Trop de tentatives, réessaie dans ${wait} s`);
  const u = M.users[name];
  const ok = u && isB64(b.authKey, 64) &&
    crypto.timingSafeEqual(Buffer.from(hashAuthKey(b.authKey, u.authSalt)), Buffer.from(u.authHash));
  if (!ok) { recordFailure(name); fail(401, 'Pseudo ou mot de passe incorrect'); }
  if (u.deactivated) fail(403, 'Ce compte a été désactivé. Contacte une personne qui administre le chat.');
  failures.delete(name);
  return { token: await newSession(name), name, pub: u.pub, encPriv: u.encPriv };
}, { public: true });

route('POST', '/api/logout', async ({ token }) => {
  await M.db.write(M.db.S.deleteSession(sha256(token)));
  delete M.sessions[sha256(token)];
  return { ok: true };
});

module.exports = { sessionUser, dropSessions };
