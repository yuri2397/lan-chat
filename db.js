// Base de données de LAN Chat — deux moteurs derrière la même interface (asynchrone) :
//
//   - PostgreSQL si DATABASE_URL est définie (production / Dokploy). Pilote npm « pg ».
//   - SQLite sinon (mode bureau `node server.js`, rien à installer) : module natif node:sqlite,
//     un fichier <DATA_DIR>/lanchat.db.
//
// Le serveur garde ses index en mémoire (messages, fils, sessions…) et écrit chaque changement ici.
// Les écritures sont exécutées l'une après l'autre, dans l'ordre d'appel, pour que la base reflète
// toujours le dernier état connu en mémoire.
// Au premier démarrage, les fichiers JSON/JSONL de l'ancienne version sont importés puis rangés dans
// <DATA_DIR>/legacy-backup/.
const fs = require('fs');
const path = require('path');

const J = v => (v === undefined || v === null ? null : JSON.stringify(v));
const P = v => (v === null || v === undefined ? undefined : typeof v === 'string' ? JSON.parse(v) : v);

// Requêtes communes aux deux moteurs (écrites avec des « ? », convertis en $1, $2… pour Postgres).
const Q = {
  getConfig: 'SELECT value FROM config WHERE key = ?',
  setConfig: 'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  saveUser: `INSERT INTO users (name, auth_salt, auth_hash, kdf_salt, pub, enc_priv, created) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET auth_salt = excluded.auth_salt, auth_hash = excluded.auth_hash,
    kdf_salt = excluded.kdf_salt, pub = excluded.pub, enc_priv = excluded.enc_priv`,
  deleteUser: 'DELETE FROM users WHERE name = ?',
  saveSession: 'INSERT INTO sessions (token_hash, username, created) VALUES (?, ?, ?) ON CONFLICT (token_hash) DO NOTHING',
  deleteSession: 'DELETE FROM sessions WHERE token_hash = ?',
  saveChannel: 'INSERT INTO channels (name, created) VALUES (?, ?) ON CONFLICT (name) DO NOTHING',
  saveKey: `INSERT INTO channel_keys (channel, recipient, sender, sender_pub, wrapped) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (channel, recipient) DO NOTHING`,
  insertMessage: `INSERT INTO messages (id, channel, username, ts, parent, broadcast, enc, text, file, edited, reactions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateMessage: 'UPDATE messages SET enc = ?, text = ?, edited = ?, reactions = ? WHERE id = ?',
  deleteMessage: 'DELETE FROM messages WHERE id = ?',
};

// Fabrique les instructions { sql, params } ; le moteur les exécute seules ou dans une transaction.
const S = {
  setConfig: (key, value) => ({ sql: Q.setConfig, params: [key, String(value)] }),
  saveUser: (name, u) => ({ sql: Q.saveUser, params: [name, u.authSalt, u.authHash, u.kdfSalt, u.pub, J(u.encPriv), u.created] }),
  deleteUser: name => ({ sql: Q.deleteUser, params: [name] }), // sessions et clés reçues supprimées en cascade
  saveSession: (hash, s) => ({ sql: Q.saveSession, params: [hash, s.user, s.created] }),
  deleteSession: hash => ({ sql: Q.deleteSession, params: [hash] }),
  saveChannel: name => ({ sql: Q.saveChannel, params: [name, Date.now()] }),
  saveKey: (channel, recipient, e) => ({ sql: Q.saveKey, params: [channel, recipient, e.from, e.fromPub, J(e.wrapped)] }),
  insertMessage: m => ({
    sql: Q.insertMessage,
    params: [m.id, m.channel, m.user, m.ts, m.parent ?? null, m.broadcast ? 1 : 0, J(m.enc), m.text ?? null, J(m.file), m.edited ?? null, J(m.reactions)],
  }),
  updateMessage: m => ({ sql: Q.updateMessage, params: [J(m.enc), m.text ?? null, m.edited ?? null, J(m.reactions), m.id] }),
  deleteMessage: id => ({ sql: Q.deleteMessage, params: [id] }),
};

// ---------- Moteur PostgreSQL ----------
const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY, auth_salt TEXT NOT NULL, auth_hash TEXT NOT NULL, kdf_salt TEXT NOT NULL,
    pub TEXT NOT NULL, enc_priv JSONB NOT NULL, created BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE, created BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY, created BIGINT NOT NULL, seq BIGSERIAL);
  CREATE TABLE IF NOT EXISTS channel_keys (
    channel TEXT NOT NULL, recipient TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    sender TEXT NOT NULL, sender_pub TEXT NOT NULL, wrapped JSONB NOT NULL,
    PRIMARY KEY (channel, recipient)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id BIGINT PRIMARY KEY, channel TEXT NOT NULL, username TEXT NOT NULL, ts BIGINT NOT NULL,
    parent BIGINT, broadcast SMALLINT NOT NULL DEFAULT 0,
    enc JSONB, text TEXT, file JSONB, edited BIGINT,
    reactions JSON -- JSON (et non JSONB) : garde l'ordre d'ajout des réactions
  );
  CREATE INDEX IF NOT EXISTS messages_channel ON messages (channel, id);
  CREATE INDEX IF NOT EXISTS messages_parent ON messages (parent);
`;

async function openPostgres(url) {
  let pg;
  try { pg = require('pg'); }
  catch {
    console.error('\n  DATABASE_URL est définie mais le pilote PostgreSQL manque : lance « npm install » (ou utilise l\'image Docker).\n');
    process.exit(1);
  }
  pg.types.setTypeParser(20, v => Number(v)); // BIGINT -> nombre (horodatages en ms, ids)
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', err => console.error('PostgreSQL :', err.message));
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };

  // Attend la base au démarrage (le conteneur Postgres peut démarrer après l'application)
  for (let attempt = 1; ; attempt++) {
    try { await pool.query('SELECT 1'); break; }
    catch (err) {
      if (attempt >= 30) throw new Error('PostgreSQL injoignable : ' + err.message);
      console.log(`  ⏳ En attente de PostgreSQL (${err.message})…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  await pool.query(PG_SCHEMA);

  return {
    label: 'PostgreSQL ' + url.replace(/\/\/[^@]*@/, '//***@'),
    channelOrder: 'seq',
    query: async (sql, params = []) => (await pool.query(toPg(sql), params)).rows,
    run: async st => { await pool.query(toPg(st.sql), st.params); },
    batch: async list => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const st of list) await c.query(toPg(st.sql), st.params);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

// ---------- Moteur SQLite (repli local) ----------
const SQLITE_SCHEMA = PG_SCHEMA
  .replace(/--[^\n]*/g, '')
  .replace(/JSONB?/g, 'TEXT')
  .replace(/BIGSERIAL/g, 'INTEGER')
  .replace(/BIGINT/g, 'INTEGER')
  .replace(/SMALLINT/g, 'INTEGER');

async function openSqlite(dataDir) {
  // node:sqlite affiche un avertissement « expérimental » à chaque démarrage : on masque celui-là seulement.
  const emitWarning = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w?.message || w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...a));
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch {
    console.error(`\n  Sans DATABASE_URL, LAN Chat utilise SQLite, qui exige Node.js 22.13 ou plus récent (actuel : ${process.version}).\n`);
    process.exit(1);
  }
  const file = path.join(dataDir, 'lanchat.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SQLITE_SCHEMA);
  try { fs.chmodSync(file, 0o600); } catch {}
  const cache = new Map();
  const prep = sql => { if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); };
  return {
    label: 'SQLite ' + file,
    channelOrder: 'rowid',
    query: async (sql, params = []) => prep(sql).all(...params),
    run: async st => { prep(st.sql).run(...st.params); },
    batch: async list => {
      db.exec('BEGIN');
      try { for (const st of list) prep(st.sql).run(...st.params); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: async () => db.close(),
  };
}

// ---------- Interface commune ----------
async function openDb({ dataDir, url }) {
  const engine = url ? await openPostgres(url) : await openSqlite(dataDir);

  // File d'attente : les écritures s'exécutent l'une après l'autre, dans l'ordre d'appel.
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const write = st => serial(() => engine.run(st));

  const api = {
    label: engine.label,
    close: () => engine.close(),
    ping: () => engine.query('SELECT 1'),
    batch: list => serial(() => engine.batch(list)),
    S,
    getConfig: async key => (await engine.query(Q.getConfig, [key]))[0]?.value,
    setConfig: (key, value) => write(S.setConfig(key, value)),
    saveUser: (name, u) => write(S.saveUser(name, u)),
    deleteUser: name => write(S.deleteUser(name)),
    saveSession: (hash, s) => write(S.saveSession(hash, s)),
    deleteSession: hash => write(S.deleteSession(hash)),
    saveChannel: name => write(S.saveChannel(name)),
    insertMessage: m => write(S.insertMessage(m)),
    updateMessage: m => write(S.updateMessage(m)),
    deleteMessage: id => write(S.deleteMessage(id)),

    // Charge tout en mémoire au démarrage, dans les formats utilisés par le serveur.
    async load() {
      const users = {}, sessions = {}, chanKeys = {};
      for (const r of await engine.query('SELECT * FROM users')) {
        users[r.name] = { authSalt: r.auth_salt, authHash: r.auth_hash, kdfSalt: r.kdf_salt, pub: r.pub, encPriv: P(r.enc_priv), created: r.created };
      }
      for (const r of await engine.query('SELECT * FROM sessions')) sessions[r.token_hash] = { user: r.username, created: r.created };
      for (const r of await engine.query('SELECT * FROM channel_keys')) {
        (chanKeys[r.channel] = chanKeys[r.channel] || {})[r.recipient] = { from: r.sender, fromPub: r.sender_pub, wrapped: P(r.wrapped) };
      }
      const channels = (await engine.query(`SELECT name FROM channels ORDER BY ${engine.channelOrder}`)).map(r => r.name);
      const messages = (await engine.query('SELECT * FROM messages ORDER BY id')).map(r => {
        const m = { id: r.id, channel: r.channel, user: r.username };
        if (r.enc !== null) m.enc = P(r.enc);
        if (r.text !== null) m.text = r.text;
        if (r.file !== null) m.file = P(r.file);
        m.ts = r.ts;
        if (r.parent !== null) m.parent = r.parent;
        if (r.broadcast) m.broadcast = true;
        if (r.edited !== null) m.edited = r.edited;
        if (r.reactions !== null) m.reactions = P(r.reactions);
        return m;
      });
      return { users, sessions, chanKeys, channels, messages };
    },
  };

  await migrateLegacyFiles(dataDir, api);
  if (!(await engine.query('SELECT 1 FROM channels LIMIT 1')).length) {
    await api.batch(['general', 'code', 'liens'].map(S.saveChannel));
  }
  return api;
}

// Import unique des fichiers de l'ancienne version (users.json, sessions.json, keys.json, channels.json,
// config.json, messages.jsonl), puis déplacement dans legacy-backup/.
async function migrateLegacyFiles(dataDir, api) {
  const names = ['users.json', 'sessions.json', 'keys.json', 'channels.json', 'config.json', 'messages.jsonl'];
  const present = names.filter(n => fs.existsSync(path.join(dataDir, n)));
  if (!present.length) return;
  const read = (n, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, n), 'utf8')); } catch { return fallback; } };

  // Rejoue le journal des messages (messages + opérations edit/react/delete)
  const byId = new Map();
  if (fs.existsSync(path.join(dataDir, 'messages.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dataDir, 'messages.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o.op) { byId.set(o.id, o); continue; }
      const m = byId.get(o.id);
      if (!m) continue;
      if (o.op === 'delete') byId.delete(o.id);
      else if (o.op === 'edit') { if (o.enc) { m.enc = o.enc; delete m.text; } else m.text = o.text; m.edited = o.ts; }
      else if (o.op === 'react') {
        m.reactions = m.reactions || {};
        const list = m.reactions[o.emoji] || [];
        m.reactions[o.emoji] = list.includes(o.user) ? list.filter(u => u !== o.user) : [...list, o.user];
        if (!m.reactions[o.emoji].length) delete m.reactions[o.emoji];
        if (!Object.keys(m.reactions).length) delete m.reactions;
      }
    }
  }
  const users = read('users.json', {});
  const list = [];
  for (const [name, u] of Object.entries(users)) list.push(S.saveUser(name, u));
  for (const [hash, s] of Object.entries(read('sessions.json', {}))) if (users[s.user]) list.push(S.saveSession(hash, s));
  for (const name of read('channels.json', ['general', 'code', 'liens'])) list.push(S.saveChannel(name));
  for (const [ch, entries] of Object.entries(read('keys.json', {}))) {
    for (const [to, e] of Object.entries(entries)) if (users[to]) list.push(S.saveKey(ch, to, e));
  }
  const cfg = read('config.json', {});
  if (cfg.accessCode && !(await api.getConfig('accessCode'))) list.push(S.setConfig('accessCode', cfg.accessCode));
  for (const m of [...byId.values()].sort((a, b) => a.id - b.id)) list.push(S.insertMessage(m));
  await api.batch(list);

  const backup = path.join(dataDir, 'legacy-backup');
  fs.mkdirSync(backup, { recursive: true });
  for (const n of present) fs.renameSync(path.join(dataDir, n), path.join(backup, n));
  console.log(`  📦 Anciennes données importées dans la base (${byId.size} messages, ${Object.keys(users).length} comptes). Originaux : ${backup}`);
}

module.exports = { openDb };
