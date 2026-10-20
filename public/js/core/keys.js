// Chiffrement de bout en bout côté application : clés des conversations, déchiffrement des messages et fichiers.
// (Les primitives cryptographiques sont dans lib/e2e.js.)
//
// - Message direct : clé dérivée de ECDH entre les deux personnes.
// - Canal : clé AES aléatoire, créée par le premier membre qui l'ouvre, puis transmise automatiquement, chiffrée
//   pour chacun, à tous ceux qui ont le droit de lire le canal (tous les comptes s'il est public, ses membres s'il est privé).
import { E2E } from '../lib/e2e.js';
import { api, post } from './api.js';
import { state, bus, isDm, dmOther, channel } from './state.js';

// Comptes qui doivent détenir la clé d'un canal
const audience = ch => {
  const c = channel(ch);
  if (!c) return [];
  return [...state.users.values()].filter(u => !u.deactivated && (!c.private || c.members.includes(u.name)));
};

export async function applyKeys({ mine, holders }) {
  state.holders = holders;
  const added = [];
  for (const [ch, entry] of Object.entries(mine)) {
    if (state.chKeys.has(ch)) continue;
    try { state.chKeys.set(ch, await E2E.unwrapChannelKey(state.priv, entry.wrapped, entry.fromPub, ch)); added.push(ch); }
    catch { console.warn('Clé illisible pour #' + ch); }
  }
  return added;
}
export const reloadKeys = async () => applyKeys(await api('/api/keys'));

export async function keyFor(ch) {
  if (isDm(ch)) {
    const pub = state.users.get(dmOther(ch))?.pub;
    return pub ? E2E.dmKey(state.priv, pub, ch) : null;
  }
  return state.chKeys.get(ch)?.key || null;
}
export const hasKey = ch => isDm(ch) ? state.users.has(dmOther(ch)) : state.chKeys.has(ch);

// Le premier membre qui ouvre un canal sans clé la crée et la chiffre pour tous ceux qui doivent la recevoir.
export async function ensureChannelKey(ch) {
  if (isDm(ch) || state.chKeys.has(ch) || (state.holders[ch] || []).length || !channel(ch)) return;
  const ck = await E2E.newChannelKey();
  const keys = {};
  const targets = audience(ch);
  if (!targets.some(u => u.name === state.me)) targets.push(state.users.get(state.me));
  for (const u of targets) keys[u.name] = await E2E.wrapChannelKey(state.priv, ck.raw, u.pub, ch);
  try {
    const r = await post('/api/keys', { channel: ch, keys });
    state.chKeys.set(ch, ck);
    state.holders[ch] = r.holders;
  } catch { (await reloadKeys()).forEach(c => bus.emit('key', c)); } // quelqu'un l'a créée en même temps : on récupère la sienne
}

// Partage les clés qu'on détient avec ceux qui ne les ont pas encore (nouveaux comptes, nouveaux membres).
// Délai aléatoire : quand plusieurs détenteurs sont connectés, un seul fait le travail.
let shareTimer;
export function scheduleShare() { clearTimeout(shareTimer); shareTimer = setTimeout(shareMissing, 300 + Math.random() * 1500); }
async function shareMissing() {
  for (const [ch, ck] of state.chKeys) {
    const have = new Set(state.holders[ch] || []);
    const missing = audience(ch).filter(u => !have.has(u.name));
    if (!missing.length) continue;
    const keys = {};
    for (const u of missing) keys[u.name] = await E2E.wrapChannelKey(state.priv, ck.raw, u.pub, ch);
    try { state.holders[ch] = (await post('/api/keys', { channel: ch, keys })).holders; } catch {}
  }
}

// Déchiffre un message reçu du serveur (en place). Les anciens messages d'avant le chiffrement sont marqués `legacy`.
export async function decryptMsg(m) {
  if (!m) return m;
  if (!m.enc) { m.legacy = true; return m; }
  try {
    const key = await keyFor(m.channel);
    if (!key) throw new Error('clé manquante');
    const p = await E2E.decryptPayload(key, m.enc, m.channel);
    m.text = p.text || '';
    if (m.file && p.file) m.file = { ...m.file, ...p.file, e2e: true };
    for (const k of ['call', 'shared', 'poll']) if (p[k]) m[k] = p[k];
    m.locked = false;
  } catch { m.text = ''; m.locked = true; }
  return m;
}
export const decryptAll = list => Promise.all(list.map(decryptMsg));
// Clé d'un canal pas encore reçue (compte tout neuf, nouveau membre) : elle arrive en général en quelques
// secondes, partagée par un membre connecté. On l'attend un peu plutôt que d'échouer tout de suite.
export async function waitForKey(ch, ms = 8000) {
  if (isDm(ch) || state.chKeys.has(ch)) return;
  const end = Date.now() + ms;
  while (!state.chKeys.has(ch) && Date.now() < end) {
    await new Promise(r => setTimeout(r, 700));
    if (!state.chKeys.has(ch)) await reloadKeys().catch(() => {});
  }
}
export async function encryptFor(ch, payload) {
  await waitForKey(ch);
  const key = await keyFor(ch);
  if (!key) throw new Error(isDm(ch) ? 'Cette personne n’a pas de compte : impossible de lui écrire.' : 'La clé de chiffrement du canal n’est pas encore arrivée.');
  return E2E.encryptPayload(key, payload, ch);
}

// Fichiers chiffrés : téléchargés, déchiffrés dans le navigateur, puis affichés via une URL blob:
const fileUrls = new Map();
export function fileUrl(m) {
  const f = m.file;
  if (!f.e2e) return Promise.resolve(`/files/${f.id}/${encodeURIComponent(f.name || 'fichier')}?token=${encodeURIComponent(state.token)}`);
  if (!fileUrls.has(f.id)) {
    const p = (async () => {
      const res = await fetch(`/files/${f.id}`, { headers: { Authorization: 'Bearer ' + state.token } });
      if (!res.ok) throw new Error('Fichier introuvable');
      const key = await keyFor(m.channel);
      if (!key) throw new Error('Clé de chiffrement indisponible');
      const plain = await E2E.decryptFile(key, f.iv, await res.arrayBuffer(), m.channel);
      return URL.createObjectURL(new Blob([plain], { type: f.type || 'application/octet-stream' }));
    })();
    p.catch(() => fileUrls.delete(f.id));
    fileUrls.set(f.id, p);
  }
  return fileUrls.get(f.id);
}
export const fileMeta = f => ({ name: f.name, type: f.type, size: f.size, iv: f.iv, ...(f.voice ? { voice: f.voice } : {}) });
