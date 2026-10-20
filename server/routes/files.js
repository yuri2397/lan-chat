// Fichiers : chiffrés dans le navigateur, envoyés tels quels (corps brut), puis rattachés à un message via `fileId`.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const M = require('../model');
const { route, json, fail, SECURITY_HEADERS } = require('../http');
const { MAX_UPLOAD, UPLOAD_DIR } = require('../config');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
};
// Anciens fichiers en clair affichables dans le navigateur sans risque (le SVG/HTML est forcé en téléchargement).
const INLINE_OK = new Set(Object.keys(MIME));

route('POST', '/api/upload', ({ req, res, me }) => {
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) fail(413, 'Fichier trop gros (500 Mo max)');
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
    M.pendingFiles.set(id, { user: me, size, ts: Date.now() });
    json(res, 201, { fileId: id, size });
  });
  out.on('error', () => { if (!aborted) json(res, 500, { error: 'Écriture impossible' }); });
  return false;
});

// Téléchargement : /files/<id>[/<nom>] — contrôle d'accès selon la conversation du message
route('GET', '/files/:id', serve);
route('GET', '/files/:id/:name', serve);
function serve({ res, url, me, params }) {
  if (!/^[a-f0-9]{24}$/.test(params.id)) fail(404, 'Fichier introuvable');
  const file = path.join(UPLOAD_DIR, params.id);
  const owner = M.messages.find(m => m.file && m.file.id === params.id);
  if (!owner || !M.canSee(me, owner.channel) || !fs.existsSync(file)) fail(404, 'Fichier introuvable');
  const name = owner.enc ? 'fichier-chiffre.bin' : params.name || owner.file.name || 'fichier';
  const ext = path.extname(name).toLowerCase();
  const inline = !owner.enc && INLINE_OK.has(ext) && url.searchParams.get('dl') !== '1';
  res.writeHead(200, {
    'Content-Type': inline ? MIME[ext] : 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(file).pipe(res);
  return false;
}

// Ménage : fichiers envoyés mais jamais rattachés à un message (envoi interrompu), après une heure
function cleanOrphans() {
  const used = new Set(M.messages.filter(m => m.file).map(m => m.file.id));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    if (!used.has(f) && !M.pendingFiles.has(f) && Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true });
  }
  for (const [id, f] of M.pendingFiles) if (Date.now() - f.ts > 3600e3) M.pendingFiles.delete(id);
}

module.exports = { cleanOrphans };
