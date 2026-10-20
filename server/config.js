// Réglages, lus une fois au démarrage dans les variables d'environnement.
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  TLS_DIR: path.join(DATA_DIR, 'tls'),
  HTTP_ONLY: process.env.LANCHAT_HTTP === '1',
  DATABASE_URL: process.env.DATABASE_URL,
  ACCESS_CODE_ENV: process.env.LANCHAT_CODE || '',
  STUN: process.env.LANCHAT_STUN ?? 'stun:stun.l.google.com:19302',
  TURN_URLS: (process.env.LANCHAT_TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
  TURN_SECRET: process.env.LANCHAT_TURN_SECRET || '',

  MAX_UPLOAD: 500 * 1024 * 1024, // 500 Mo
  MAX_JSON: 2 * 1024 * 1024,     // 2 Mo (un message chiffré est ~1,4× plus gros que le texte)
  MAX_AVATAR: 200 * 1024,        // photo de profil, déjà réduite par le navigateur
  PAGE_SIZE: 100,
  HUDDLE_MAX: 8,
  NAME_RE: /^[\w.\-À-ÿ]{2,32}$/,
  CHANNEL_RE: /^[a-z0-9][a-z0-9\-_]{0,39}$/,
};
