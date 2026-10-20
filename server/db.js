// Base de données — deux moteurs derrière la même interface (asynchrone) :
//
//   - PostgreSQL si DATABASE_URL est définie (production / Dokploy). Pilote npm « pg ».
//   - SQLite sinon (mode bureau `node server.js`, rien à installer) : module natif node:sqlite,
//     un fichier <DATA_DIR>/lanchat.db.
//
// Le serveur garde tout en mémoire (voir model.js) et écrit chaque changement ici. Les écritures
// s'exécutent l'une après l'autre, dans l'ordre d'appel : la base reflète toujours le dernier état connu.
//
// Évolutions du schéma : tableau MIGRATIONS ci-dessous, appliqué dans l'ordre et noté dans
// config.schemaVersion. On n'y modifie jamais une migration déjà livrée : on en ajoute une nouvelle.
const fs = require('fs');
const path = require('path');

const J = v => (v === undefined || v === null ? null : JSON.stringify(v));
const P = v => (v === null || v === undefined ? undefined : typeof v === 'string' ? JSON.parse(v) : v);
const B = v => (v ? 1 : 0);

// Requêtes communes aux deux moteurs (écrites avec des « ? », convertis en $1, $2… pour Postgres).
const Q = {
  getConfig: 'SELECT value FROM config WHERE key = ?',
  setConfig: 'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  saveUser: `INSERT INTO users (name, auth_salt, auth_hash, kdf_salt, pub, enc_priv, created, role, deactivated, profile, avatar)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET auth_salt = excluded.auth_salt, auth_hash = excluded.auth_hash,
    kdf_salt = excluded.kdf_salt, pub = excluded.pub, enc_priv = excluded.enc_priv, role = excluded.role,
    deactivated = excluded.deactivated, profile = excluded.profile, avatar = excluded.avatar`,
  deleteUser: 'DELETE FROM users WHERE name = ?',
  saveSession: 'INSERT INTO sessions (token_hash, username, created) VALUES (?, ?, ?) ON CONFLICT (token_hash) DO NOTHING',
  deleteSession: 'DELETE FROM sessions WHERE token_hash = ?',
  deleteUserSessions: 'DELETE FROM sessions WHERE username = ?',
  saveChannel: `INSERT INTO channels (name, created, topic, description, private, archived, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET topic = excluded.topic, description = excluded.description,
    private = excluded.private, archived = excluded.archived`,
  addMember: 'INSERT INTO channel_members (channel, username, joined) VALUES (?, ?, ?) ON CONFLICT (channel, username) DO NOTHING',
  removeMember: 'DELETE FROM channel_members WHERE channel = ? AND username = ?',
  saveKey: `INSERT INTO channel_keys (channel, recipient, sender, sender_pub, wrapped) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (channel, recipient) DO NOTHING`,
  insertMessage: `INSERT INTO messages (id, channel, username, ts, parent, broadcast, enc, text, file, edited, reactions, mentions, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateMessage: 'UPDATE messages SET enc = ?, text = ?, edited = ?, reactions = ?, mentions = ?, pinned = ? WHERE id = ?',
  deleteMessage: 'DELETE FROM messages WHERE id = ?',
  savePref: `INSERT INTO convo_prefs (username, channel, starred, muted, hidden) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (username, channel) DO UPDATE SET starred = excluded.starred, muted = excluded.muted, hidden = excluded.hidden`,
  saveRead: `INSERT INTO reads (username, key, last_id) VALUES (?, ?, ?)
    ON CONFLICT (username, key) DO UPDATE SET last_id = excluded.last_id`,
  saveSaved: `INSERT INTO saved (username, message_id, ts, remind_at, reminded, done) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (username, message_id) DO UPDATE SET remind_at = excluded.remind_at, reminded = excluded.reminded, done = excluded.done`,
  deleteSaved: 'DELETE FROM saved WHERE username = ? AND message_id = ?',
  deleteSavedFor: 'DELETE FROM saved WHERE message_id = ?',
  saveScheduled: `INSERT INTO scheduled (id, username, channel, parent, enc, mentions, at, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET enc = excluded.enc, mentions = excluded.mentions, at = excluded.at`,
  deleteScheduled: 'DELETE FROM scheduled WHERE id = ?',
};

// Fabrique les instructions { sql, params } ; le moteur les exécute seules ou dans une transaction.
const S = {
  setConfig: (key, value) => ({ sql: Q.setConfig, params: [key, String(value)] }),
  saveUser: (name, u) => ({
    sql: Q.saveUser,
    params: [name, u.authSalt, u.authHash, u.kdfSalt, u.pub, J(u.encPriv), u.created, u.role || 'member', B(u.deactivated), J(u.profile || {}), u.avatar || null],
  }),
  deleteUser: name => ({ sql: Q.deleteUser, params: [name] }), // sessions et clés reçues supprimées en cascade
  saveSession: (hash, s) => ({ sql: Q.saveSession, params: [hash, s.user, s.created] }),
  deleteSession: hash => ({ sql: Q.deleteSession, params: [hash] }),
  deleteUserSessions: name => ({ sql: Q.deleteUserSessions, params: [name] }),
  saveChannel: c => ({ sql: Q.saveChannel, params: [c.name, c.created || Date.now(), c.topic || '', c.description || '', B(c.private), B(c.archived), c.createdBy || null] }),
  addMember: (channel, user) => ({ sql: Q.addMember, params: [channel, user, Date.now()] }),
  removeMember: (channel, user) => ({ sql: Q.removeMember, params: [channel, user] }),
  saveKey: (channel, recipient, e) => ({ sql: Q.saveKey, params: [channel, recipient, e.from, e.fromPub, J(e.wrapped)] }),
  insertMessage: m => ({
    sql: Q.insertMessage,
    params: [m.id, m.channel, m.user, m.ts, m.parent ?? null, B(m.broadcast), J(m.enc), m.text ?? null, J(m.file), m.edited ?? null,
      J(m.reactions), J(m.mentions), J(m.pinned)],
  }),
  updateMessage: m => ({ sql: Q.updateMessage, params: [J(m.enc), m.text ?? null, m.edited ?? null, J(m.reactions), J(m.mentions), J(m.pinned), m.id] }),
  deleteMessage: id => ({ sql: Q.deleteMessage, params: [id] }),
  savePref: (user, channel, p) => ({ sql: Q.savePref, params: [user, channel, B(p.starred), B(p.muted), B(p.hidden)] }),
  saveRead: (user, key, id) => ({ sql: Q.saveRead, params: [user, key, id] }),
  saveSaved: (user, id, s) => ({ sql: Q.saveSaved, params: [user, id, s.ts, s.remindAt ?? null, B(s.reminded), B(s.done)] }),
  deleteSaved: (user, id) => ({ sql: Q.deleteSaved, params: [user, id] }),
  deleteSavedFor: id => ({ sql: Q.deleteSavedFor, params: [id] }),
  saveScheduled: s => ({ sql: Q.saveScheduled, params: [s.id, s.user, s.channel, s.parent ?? null, J(s.enc), J(s.mentions), s.at, s.created] }),
  deleteScheduled: id => ({ sql: Q.deleteScheduled, params: [id] }),
};

// ---------- Schéma ----------
// Version 1 : le schéma d'origine (créé tel quel si absent). Les versions suivantes sont des migrations.
const BASE_SCHEMA = `
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

// Chaque migration : liste d'instructions SQL (dialecte Postgres, adapté pour SQLite par sqliteSql).
// `after` (facultatif) complète les données une fois les tables créées.
const MIGRATIONS = [
  {
    version: 2, // espace de travail façon Slack : rôles, profils, canaux privés, membres, préférences, lus, « Plus tard », envois programmés
    sql: [
      "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
      'ALTER TABLE users ADD COLUMN deactivated SMALLINT NOT NULL DEFAULT 0',
      "ALTER TABLE users ADD COLUMN profile JSONB",
      'ALTER TABLE users ADD COLUMN avatar TEXT',
      "ALTER TABLE channels ADD COLUMN topic TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE channels ADD COLUMN description TEXT NOT NULL DEFAULT ''",
      'ALTER TABLE channels ADD COLUMN private SMALLINT NOT NULL DEFAULT 0',
      'ALTER TABLE channels ADD COLUMN archived SMALLINT NOT NULL DEFAULT 0',
      'ALTER TABLE channels ADD COLUMN created_by TEXT',
      'ALTER TABLE messages ADD COLUMN mentions JSONB',
      'ALTER TABLE messages ADD COLUMN pinned JSONB',
      `CREATE TABLE IF NOT EXISTS channel_members (
        channel TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
        username TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
        joined BIGINT NOT NULL, PRIMARY KEY (channel, username))`,
      `CREATE TABLE IF NOT EXISTS convo_prefs (
        username TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE, channel TEXT NOT NULL,
        starred SMALLINT NOT NULL DEFAULT 0, muted SMALLINT NOT NULL DEFAULT 0, hidden SMALLINT NOT NULL DEFAULT 0,
        PRIMARY KEY (username, channel))`,
      `CREATE TABLE IF NOT EXISTS reads (
        username TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE, key TEXT NOT NULL, last_id BIGINT NOT NULL,
        PRIMARY KEY (username, key))`,
      `CREATE TABLE IF NOT EXISTS saved (
        username TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE, message_id BIGINT NOT NULL, ts BIGINT NOT NULL,
        remind_at BIGINT, reminded SMALLINT NOT NULL DEFAULT 0, done SMALLINT NOT NULL DEFAULT 0,
        PRIMARY KEY (username, message_id))`,
      `CREATE TABLE IF NOT EXISTS scheduled (
        id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE, channel TEXT NOT NULL,
        parent BIGINT, enc JSONB NOT NULL, mentions JSONB, at BIGINT NOT NULL, created BIGINT NOT NULL)`,
    ],
    // Jusqu'ici tout le monde voyait tous les canaux : chacun en devient membre. Le premier compte devient propriétaire.
    after: async engine => {
      await engine.run({ sql: 'INSERT INTO channel_members (channel, username, joined) SELECT c.name, u.name, ? FROM channels c CROSS JOIN users u WHERE true ON CONFLICT (channel, username) DO NOTHING', params: [Date.now()] });
      // Les « lus » étaient rangés dans chaque navigateur : on part de « tout est lu » plutôt que de tout afficher en non-lu.
      await engine.run({ sql: 'INSERT INTO reads (username, key, last_id) SELECT u.name, m.channel, MAX(m.id) FROM users u CROSS JOIN messages m WHERE true GROUP BY u.name, m.channel ON CONFLICT (username, key) DO NOTHING' });
      await engine.run({ sql: "INSERT INTO reads (username, key, last_id) SELECT u.name, 't:' || m.parent, MAX(m.id) FROM users u CROSS JOIN messages m WHERE m.parent IS NOT NULL GROUP BY u.name, m.parent ON CONFLICT (username, key) DO NOTHING" });
      const first = (await engine.query('SELECT name FROM users ORDER BY created LIMIT 1'))[0];
      if (first) await engine.run({ sql: "UPDATE users SET role = 'owner' WHERE name = ?", params: [first.name] });
    },
  },
];

const sqliteSql = sql => sql
  .replace(/--[^\n]*/g, '')
  .replace(/JSONB?/g, 'TEXT')
  .replace(/BIGSERIAL/g, 'INTEGER')
  .replace(/BIGINT/g, 'INTEGER')
  .replace(/SMALLINT/g, 'INTEGER');

// ---------- Moteur PostgreSQL ----------
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
  await pool.query(BASE_SCHEMA);

  return {
    label: 'PostgreSQL ' + url.replace(/\/\/[^@]*@/, '//***@'),
    channelOrder: 'seq',
    adapt: sql => sql,
    query: async (sql, params = []) => (await pool.query(toPg(sql), params)).rows,
    run: async st => { await pool.query(toPg(st.sql), st.params || []); },
    batch: async list => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const st of list) await c.query(toPg(st.sql), st.params || []);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

// ---------- Moteur SQLite (repli local) ----------
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
  db.exec(sqliteSql(BASE_SCHEMA));
  try { fs.chmodSync(file, 0o600); } catch {}
  const cache = new Map();
  const prep = sql => { if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); };
  return {
    label: 'SQLite ' + file,
    channelOrder: 'rowid',
    adapt: sqliteSql,
    query: async (sql, params = []) => prep(sql).all(...params),
    run: async st => { prep(st.sql).run(...(st.params || [])); },
    batch: async list => {
      db.exec('BEGIN');
      try { for (const st of list) prep(st.sql).run(...(st.params || [])); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: async () => db.close(),
  };
}

async function migrate(engine) {
  const current = Number((await engine.query(Q.getConfig, ['schemaVersion']))[0]?.value) || 1;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await engine.batch([...m.sql.map(sql => ({ sql: engine.adapt(sql) })), S.setConfig('schemaVersion', m.version)]);
    if (m.after) await m.after(engine);
    console.log(`  🗃  Base de données mise à jour (schéma v${m.version})`);
  }
}

// ---------- Interface commune ----------
async function openDb({ dataDir, url }) {
  const engine = url ? await openPostgres(url) : await openSqlite(dataDir);

  // File d'attente : les écritures s'exécutent l'une après l'autre, dans l'ordre d'appel.
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  const api = {
    label: engine.label,
    S,
    close: () => engine.close(),
    ping: () => engine.query('SELECT 1'),
    write: st => serial(() => engine.run(st)),
    batch: list => (list.length ? serial(() => engine.batch(list)) : Promise.resolve()),
    getConfig: async key => (await engine.query(Q.getConfig, [key]))[0]?.value,
    setConfig: (key, value) => api.write(S.setConfig(key, value)),

    // Charge tout en mémoire au démarrage, dans les formats utilisés par model.js.
    async load() {
      const q = sql => engine.query(sql);
      const users = {}, sessions = {}, chanKeys = {}, channels = [], members = {}, prefs = {}, reads = {}, saved = {}, scheduled = [];
      for (const r of await q('SELECT * FROM users')) {
        users[r.name] = {
          authSalt: r.auth_salt, authHash: r.auth_hash, kdfSalt: r.kdf_salt, pub: r.pub, encPriv: P(r.enc_priv), created: r.created,
          role: r.role || 'member', deactivated: !!r.deactivated, profile: P(r.profile) || {}, avatar: r.avatar || null,
        };
      }
      for (const r of await q('SELECT * FROM sessions')) sessions[r.token_hash] = { user: r.username, created: r.created };
      for (const r of await q('SELECT * FROM channel_keys')) {
        (chanKeys[r.channel] = chanKeys[r.channel] || {})[r.recipient] = { from: r.sender, fromPub: r.sender_pub, wrapped: P(r.wrapped) };
      }
      for (const r of await q(`SELECT * FROM channels ORDER BY ${engine.channelOrder}`)) {
        channels.push({ name: r.name, created: r.created, topic: r.topic || '', description: r.description || '', private: !!r.private, archived: !!r.archived, createdBy: r.created_by || null });
      }
      for (const r of await q('SELECT * FROM channel_members')) (members[r.channel] = members[r.channel] || new Set()).add(r.username);
      for (const r of await q('SELECT * FROM convo_prefs')) {
        (prefs[r.username] = prefs[r.username] || {})[r.channel] = { starred: !!r.starred, muted: !!r.muted, hidden: !!r.hidden };
      }
      for (const r of await q('SELECT * FROM reads')) (reads[r.username] = reads[r.username] || {})[r.key] = r.last_id;
      for (const r of await q('SELECT * FROM saved')) {
        (saved[r.username] = saved[r.username] || new Map()).set(r.message_id, { ts: r.ts, remindAt: r.remind_at ?? null, reminded: !!r.reminded, done: !!r.done });
      }
      for (const r of await q('SELECT * FROM scheduled ORDER BY at')) {
        scheduled.push({ id: r.id, user: r.username, channel: r.channel, parent: r.parent ?? null, enc: P(r.enc), mentions: P(r.mentions) || [], at: r.at, created: r.created });
      }
      const messages = (await q('SELECT * FROM messages ORDER BY id')).map(r => {
        const m = { id: r.id, channel: r.channel, user: r.username };
        if (r.enc !== null) m.enc = P(r.enc);
        if (r.text !== null) m.text = r.text;
        if (r.file !== null) m.file = P(r.file);
        m.ts = r.ts;
        if (r.parent !== null) m.parent = r.parent;
        if (r.broadcast) m.broadcast = true;
        if (r.edited !== null) m.edited = r.edited;
        if (r.reactions !== null) m.reactions = P(r.reactions);
        if (r.mentions !== null && r.mentions !== undefined) m.mentions = P(r.mentions);
        if (r.pinned !== null && r.pinned !== undefined) m.pinned = P(r.pinned);
        return m;
      });
      return { users, sessions, chanKeys, channels, members, prefs, reads, saved, scheduled, messages };
    },
  };

  await migrateLegacyFiles(dataDir, engine);
  await migrate(engine);
  if (!(await engine.query('SELECT 1 FROM channels LIMIT 1')).length) {
    await api.batch(['general', 'code', 'liens'].map(name => S.saveChannel({ name, topic: name === 'general' ? 'Les annonces et la vie de l\'équipe' : '' })));
  }
  return api;
}

// Import unique des fichiers de la toute première version (users.json, sessions.json, keys.json, channels.json,
// config.json, messages.jsonl), puis déplacement dans legacy-backup/. Écrit dans le schéma v1.
async function migrateLegacyFiles(dataDir, engine) {
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
  const v1 = {
    user: (name, u) => ({ sql: 'INSERT INTO users (name, auth_salt, auth_hash, kdf_salt, pub, enc_priv, created) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING', params: [name, u.authSalt, u.authHash, u.kdfSalt, u.pub, J(u.encPriv), u.created] }),
    channel: name => ({ sql: 'INSERT INTO channels (name, created) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', params: [name, Date.now()] }),
    message: m => ({
      sql: 'INSERT INTO messages (id, channel, username, ts, parent, broadcast, enc, text, file, edited, reactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [m.id, m.channel, m.user, m.ts, m.parent ?? null, B(m.broadcast), J(m.enc), m.text ?? null, J(m.file), m.edited ?? null, J(m.reactions)],
    }),
  };
  const users = read('users.json', {});
  const list = [];
  for (const [name, u] of Object.entries(users)) list.push(v1.user(name, u));
  for (const [hash, s] of Object.entries(read('sessions.json', {}))) if (users[s.user]) list.push(S.saveSession(hash, s));
  for (const name of read('channels.json', ['general', 'code', 'liens'])) list.push(v1.channel(name));
  for (const [ch, entries] of Object.entries(read('keys.json', {}))) {
    for (const [to, e] of Object.entries(entries)) if (users[to]) list.push(S.saveKey(ch, to, e));
  }
  const cfg = read('config.json', {});
  if (cfg.accessCode && !(await engine.query(Q.getConfig, ['accessCode'])).length) list.push(S.setConfig('accessCode', cfg.accessCode));
  for (const m of [...byId.values()].sort((a, b) => a.id - b.id)) list.push(v1.message(m));
  await engine.batch(list);

  const backup = path.join(dataDir, 'legacy-backup');
  fs.mkdirSync(backup, { recursive: true });
  for (const n of present) fs.renameSync(path.join(dataDir, n), path.join(backup, n));
  console.log(`  📦 Anciennes données importées dans la base (${byId.size} messages, ${Object.keys(users).length} comptes). Originaux : ${backup}`);
}

module.exports = { openDb };
