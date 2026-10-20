// Outils HTTP : réponses JSON, lecture du corps, petit routeur, fichiers statiques compressés et mis en cache.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { MAX_JSON, PUBLIC_DIR } = require('./config');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self), display-capture=(self)',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

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
      if (size > MAX_JSON) { reject(new HttpError(413, 'Message trop volumineux')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'JSON invalide')); }
    });
    req.on('error', reject);
  });
}
const isB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s);
const validEnc = e => !!e && isB64(e.iv, 32) && isB64(e.ct, MAX_JSON);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ---------- Routeur ----------
// route('GET', '/api/thread/:id', handler, { public: true })
// handler(ctx) reçoit { req, res, url, me, token, params, body() } et renvoie un objet (envoyé en JSON) ou rien.
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}
function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (m) return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// ---------- Fichiers statiques ----------
// Gardés en mémoire, compressés une fois (brotli + gzip), servis avec un ETag : un rechargement ne transfère que
// des « 304 Not Modified ». Les polices ne changent jamais : cache d'un an.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const staticCache = new Map();
function loadStatic(file) {
  const stat = fs.statSync(file);
  const hit = staticCache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const ext = path.extname(file);
  const compressible = /\.(html|js|css|svg|json|webmanifest|txt)$/.test(ext);
  const entry = {
    mtime: stat.mtimeMs, raw, type: MIME[ext] || 'application/octet-stream',
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"',
    br: compressible ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }) : null,
    gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null,
    immutable: ext === '.woff2',
  };
  staticCache.set(file, entry);
  return entry;
}
// index.html reçoit une « import map » qui ajoute à chaque module son empreinte (?v=…) : les modules et la feuille
// de style sont alors cachés pour toujours, et un rechargement ne redemande que index.html.
const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const versioned = file => '/' + path.relative(PUBLIC_DIR, file).split(path.sep).join('/') + '?v=' + loadStatic(file).etag.slice(1, 9);
function indexHtml() {
  const file = path.join(PUBLIC_DIR, 'index.html');
  const modules = walk(path.join(PUBLIC_DIR, 'js')).filter(f => f.endsWith('.js'));
  const map = Object.fromEntries(modules.map(f => ['/' + path.relative(PUBLIC_DIR, f).split(path.sep).join('/'), versioned(f)]));
  const assets = [
    `<link rel="stylesheet" href="${versioned(path.join(PUBLIC_DIR, 'css', 'app.css'))}">`,
    `<script type="importmap">${JSON.stringify({ imports: map })}</script>`,
    ...modules.map(f => `<link rel="modulepreload" href="${versioned(f)}">`),
    `<script type="module" src="${map['/js/main.js']}"></script>`,
  ].join('\n');
  const html = fs.readFileSync(file, 'utf8').replace('<!--ASSETS-->', assets);
  if (indexEntry?.html !== html) {
    const raw = Buffer.from(html);
    indexEntry = { html, raw, type: MIME['.html'], etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"',
      br: zlib.brotliCompressSync(raw), gz: zlib.gzipSync(raw), immutable: false };
  }
  return indexEntry;
}
let indexEntry = null;
function serveStatic(req, res, pathname, query) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const e = rel === 'index.html' ? indexHtml() : loadStatic(file);
  const headers = {
    'Content-Type': e.type, ETag: e.etag, Vary: 'Accept-Encoding',
    'Cache-Control': e.immutable || query?.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS,
  };
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); res.end(); return true; }
  const accept = String(req.headers['accept-encoding'] || '');
  let body = e.raw;
  if (e.br && /\bbr\b/.test(accept)) { body = e.br; headers['Content-Encoding'] = 'br'; }
  else if (e.gz && /\bgzip\b/.test(accept)) { body = e.gz; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

module.exports = { SECURITY_HEADERS, HttpError, fail, json, readJson, isB64, validEnc, str, route, match, serveStatic };
