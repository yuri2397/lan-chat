// LAN Chat — client. Vanilla JS, aucune dépendance.
const $ = (s, root = document) => root.querySelector(s);
const icon = (id, style = '') => `<svg class="ic"${style ? ` style="${style}"` : ''}><use href="#i-${id}"/></svg>`;
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const state = {
  me: '', token: '', priv: null, pub: '',  // session (voir begin())
  users: new Map(),         // annuaire : nom -> clé publique
  chKeys: new Map(),        // canal -> { raw, key } (clé AES du canal, en mémoire seulement)
  holders: {},              // canal -> membres qui ont reçu la clé
  channels: [], dms: new Set(), online: [], known: new Set(),
  current: store.get('lanchat:channel') || 'general',
  view: 'channel',          // 'channel' | 'threads' | 'search'
  cache: {},                // canal -> { messages, hasMore }
  unread: {},               // canal -> nombre
  threadUnread: new Set(),  // ids des fils avec réponses non lues
  thread: null,             // { id, channel, parent, replies }
  readMark: Infinity,       // dernier id lu au moment d'ouvrir le canal (pour la ligne « Nouveaux »)
  pending: 0,
  typers: new Map(),        // "canal|parent" -> Map(user -> expiration)
  sound: store.get('lanchat:sound') !== 'off',
};
let es;

// ---------- Utilitaires ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PALETTE = ['#e5484d', '#e2633b', '#d4a10b', '#30a46c', '#12a594', '#0090ff', '#5b5bd6', '#8e4ec6', '#d6409f', '#6e56cf', '#2a9d8f', '#c2410c'];
const colorOf = name => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const initial = name => esc([...(name || '?')][0].toUpperCase());
const fmtTime = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtDay = ts => {
  const d = new Date(ts), today = new Date();
  if (sameDay(ts, Date.now())) return "Aujourd'hui";
  if (sameDay(ts, Date.now() - 864e5)) return 'Hier';
  const s = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  return s[0].toUpperCase() + s.slice(1);
};
const fmtWhen = ts => sameDay(ts, Date.now()) ? `à ${fmtTime(ts)}` : sameDay(ts, Date.now() - 864e5) ? `hier à ${fmtTime(ts)}` : `le ${new Date(ts).toLocaleDateString('fr-FR')}`;
const fmtSize = n => n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(1) + ' Ko' : (n / 1048576).toFixed(1) + ' Mo';
const dmId = other => '@' + [state.me, other].sort().join('|');
const dmOther = ch => ch.slice(1).split('|').find(n => n !== state.me) || state.me;
const isDm = ch => ch.startsWith('@');
const label = ch => isDm(ch) ? dmOther(ch) : '#' + ch;
const isMentioned = m => m.user !== state.me && new RegExp(`(^|\\s)@(${reEsc(state.me)}|tous|here|channel)(?![\\w.\\-À-ÿ])`, 'i').test(m.text || '');
const qs = obj => new URLSearchParams(obj).toString();
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function toast(text, onClick) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast' + (onClick ? ' clickable' : ''); t.textContent = text;
  if (onClick) t.onclick = () => { t.remove(); onClick(); };
  document.body.appendChild(t); setTimeout(() => t.remove(), onClick ? 5000 : 2200);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) logout('Session expirée, reconnecte-toi.');
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { // http:// sur IP : clipboard API indisponible, on passe par un textarea
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
  if (btn) {
    const old = btn.innerHTML;
    btn.innerHTML = icon('check') + 'Copié';
    setTimeout(() => { btn.innerHTML = old; }, 1500);
  } else toast('Copié dans le presse-papiers');
}
const knownUsers = () => {
  for (const u of state.online) state.known.add(u);
  for (const ch of state.dms) state.known.add(dmOther(ch));
  return [...state.known].filter(u => u && u !== state.me).sort((a, b) => a.localeCompare(b));
};

// ---------- Chiffrement de bout en bout (voir crypto.js) ----------
async function loadUsers() {
  const { users } = await api('/api/users');
  state.users = new Map(users.map(u => [u.name, u.pub]));
  users.forEach(u => state.known.add(u.name));
}
// Récupère les clés de canal qui nous ont été partagées et les déchiffre ; renvoie les canaux nouvellement obtenus.
async function loadKeys() {
  const { mine, holders } = await api('/api/keys');
  state.holders = holders;
  const added = [];
  for (const [ch, entry] of Object.entries(mine)) {
    if (state.chKeys.has(ch)) continue;
    try { state.chKeys.set(ch, await E2E.unwrapChannelKey(state.priv, entry.wrapped, entry.fromPub, ch)); added.push(ch); }
    catch { console.warn('Clé illisible pour #' + ch); }
  }
  return added;
}
async function keyFor(ch) {
  if (isDm(ch)) {
    const pub = state.users.get(dmOther(ch));
    return pub ? E2E.dmKey(state.priv, pub, ch) : null;
  }
  return state.chKeys.get(ch)?.key || null;
}
// Le premier membre qui ouvre un canal sans clé la crée et la chiffre pour tous les comptes existants.
async function ensureChannelKey(ch) {
  if (isDm(ch) || state.chKeys.has(ch) || (state.holders[ch] || []).length) return;
  const ck = await E2E.newChannelKey();
  const keys = {};
  for (const [u, pub] of state.users) keys[u] = await E2E.wrapChannelKey(state.priv, ck.raw, pub, ch);
  try {
    const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ channel: ch, keys }) });
    state.chKeys.set(ch, ck);
    state.holders[ch] = r.holders;
  } catch { await loadKeys(); } // quelqu'un l'a créée en même temps : on récupère la sienne
}
// Partage automatiquement les clés qu'on détient avec les comptes qui ne les ont pas encore (nouveaux arrivants).
let shareTimer;
function scheduleShare() { clearTimeout(shareTimer); shareTimer = setTimeout(shareMissing, 300 + Math.random() * 1200); }
async function shareMissing() {
  for (const [ch, ck] of state.chKeys) {
    const have = new Set(state.holders[ch] || []);
    const missing = [...state.users].filter(([u]) => !have.has(u));
    if (!missing.length) continue;
    const keys = {};
    for (const [u, pub] of missing) keys[u] = await E2E.wrapChannelKey(state.priv, ck.raw, pub, ch);
    try { state.holders[ch] = (await api('/api/keys', { method: 'POST', body: JSON.stringify({ channel: ch, keys }) })).holders; } catch {}
  }
}
function onKeyArrived(ch) {
  delete state.cache[ch];
  updateKeyWait();
  if (state.view === 'channel' && state.current === ch) openChannel(ch);
  if (state.thread && state.thread.channel === ch) openThread(state.thread.id);
  if (state.view === 'threads') renderThreadsView();
  toast(`🔑 Clé de chiffrement de #${ch} reçue`);
}
// Déchiffre un message reçu du serveur (en place). Les anciens messages d'avant le chiffrement sont marqués `legacy`.
async function decryptMsg(m) {
  if (!m.enc) { m.legacy = true; return m; }
  try {
    const key = await keyFor(m.channel);
    if (!key) throw new Error('clé manquante');
    const p = await E2E.decryptPayload(key, m.enc, m.channel);
    m.text = p.text || '';
    if (m.file && p.file) m.file = { ...m.file, ...p.file, e2e: true };
    m.locked = false;
  } catch { m.text = ''; m.locked = true; }
  return m;
}
const decryptAll = list => Promise.all(list.map(decryptMsg));
const fileMeta = f => ({ name: f.name, type: f.type, size: f.size, iv: f.iv });
function updateKeyWait() {
  const ch = state.current, el = $('#keyWait');
  let msg = '';
  if (state.view === 'channel') {
    if (isDm(ch)) { if (!state.users.has(dmOther(ch))) msg = `${dmOther(ch)} n'a pas encore de compte : impossible de lui écrire en chiffré.`; }
    else if (!state.chKeys.has(ch)) msg = `En attente de la clé de chiffrement de #${ch}. Elle te sera transmise automatiquement dès qu'un membre du canal sera connecté.`;
  }
  el.hidden = !msg;
  el.innerHTML = msg ? `${icon('key')}<span>${esc(msg)}</span>` : '';
}
// Fichiers chiffrés : téléchargés, déchiffrés dans le navigateur, puis affichés via une URL blob:
const fileUrls = new Map();
function fileUrl(m) {
  const f = m.file;
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
async function downloadFile(m) {
  toast(`Déchiffrement de ${m.file.name}…`);
  try {
    const a = document.createElement('a');
    a.href = await fileUrl(m); a.download = m.file.name;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { toast(e.message); }
}
// Les aperçus d'images/vidéos chiffrées se chargent dès qu'ils apparaissent à l'écran
new MutationObserver(() => {
  document.querySelectorAll('[data-encfile]:not([data-loading])').forEach(async el => {
    el.dataset.loading = '1';
    const m = el.closest('.msg')?._msg;
    if (m?.file) try { el.src = await fileUrl(m); } catch {}
  });
}).observe(document.body, { childList: true, subtree: true });

// ---------- Thème & son ----------
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Thème : automatique', light: 'Thème : clair', dark: 'Thème : sombre' };
const THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };
let theme = store.get('lanchat:theme') || 'auto';
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $('#themeBtn').innerHTML = icon(THEME_ICON[t]);
  $('#themeBtn').title = THEME_LABEL[t];
}
applyTheme(theme);
$('#themeBtn').onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  store.set('lanchat:theme', theme); applyTheme(theme); toast(THEME_LABEL[theme]);
};
function applySound() {
  $('#soundBtn').innerHTML = icon(state.sound ? 'bell' : 'bell-off');
  $('#soundBtn').title = state.sound ? 'Sons activés' : 'Sons coupés';
}
applySound();
$('#soundBtn').onclick = () => {
  state.sound = !state.sound; store.set('lanchat:sound', state.sound ? 'on' : 'off'); applySound();
  toast(state.sound ? 'Sons activés 🔔' : 'Sons coupés 🔕');
  if (state.sound) ping();
};
let audioCtx;
function ping() {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.09]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
      o.connect(g).connect(audioCtx.destination); o.start(t + d); o.stop(t + d + 0.3);
    });
  } catch {}
}

// ---------- Confettis 🎉 ----------
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = $('#confetti'), ctx = cv.getContext('2d');
  cv.hidden = false; cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#5b5bd6', '#e5484d', '#f0b429', '#30a46c', '#0090ff', '#d6409f', '#ffffff'];
  const parts = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight * .65,
    vx: (Math.random() - .5) * 16, vy: -Math.random() * 18 - 8,
    r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.vy += .45; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); ctx.restore();
    }
    if (now - start < 3200) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, cv.width, cv.height); cv.hidden = true; }
  })(start);
}

// ---------- Coloration syntaxique minimaliste ----------
const KEYWORDS = new Set(('abstract and as async await break case catch class const continue def default del do elif else enum export extends false final finally fn for foreach from func function go if impl implements import in instanceof interface is let match module namespace new nil none not null or package private protected public pub return self static struct super switch this throw throws true try type typeof use var void while with yield echo require include select insert update delete where join on group by order limit values into create table drop alter set').split(' '));
function highlight(code) {
  const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, com, str, num, fn, word] = m;
    if (com) out += `<span class="t-com">${esc(tok)}</span>`;
    else if (str) out += `<span class="t-str">${esc(tok)}</span>`;
    else if (num) out += `<span class="t-num">${tok}</span>`;
    else if (fn) out += KEYWORDS.has(fn.toLowerCase()) ? `<span class="t-kw">${esc(fn)}</span>` : `<span class="t-fn">${esc(fn)}</span>`;
    else out += KEYWORDS.has(word.toLowerCase()) ? `<span class="t-kw">${esc(word)}</span>` : esc(word);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

// ---------- Rendu du texte ----------
// ```code```, `inline`, **gras**, _italique_, ~barré~, > citation, liens, @mentions
const codeStore = [];
function renderText(text) {
  const parts = text.split(/```/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1 && i < parts.length - 1) {
      const nl = part.indexOf('\n');
      let lang = nl > 0 ? part.slice(0, nl).trim() : '';
      let code = part;
      if (/^[\w+#.-]{1,20}$/.test(lang)) code = part.slice(nl + 1); else lang = '';
      code = code.replace(/^\n/, '').replace(/\n$/, '');
      const idx = codeStore.push(code) - 1;
      html += `<div class="codeblock"><div class="bar"><span class="lang">${esc(lang || 'code')}</span><button class="copy-btn" data-copy="${idx}">${icon('copy')}Copier</button></div><pre><code>${highlight(code)}</code></pre></div>`;
    } else {
      const raw = i % 2 === 1 ? '```' + part : part; // fence non fermée : texte brut
      html += renderPlain(raw.replace(/^\n+|\n+$/g, ''));
    }
  });
  return html;
}
function renderPlain(t) {
  if (!t) return '';
  const groups = [];
  for (const line of t.split('\n')) {
    const quote = /^>\s?/.test(line);
    const last = groups[groups.length - 1];
    const content = quote ? line.replace(/^>\s?/, '') : line;
    if (last && last.quote === quote) last.lines.push(content); else groups.push({ quote, lines: [content] });
  }
  return groups.map(g => g.quote ? `<blockquote>${renderInline(g.lines.join('\n'))}</blockquote>` : `<p>${renderInline(g.lines.join('\n'))}</p>`).join('');
}
function renderInline(t) {
  return t.split(/(`[^`\n]+`)/).map((seg, i) => {
    if (i % 2 === 1) return `<code class="inline">${esc(seg.slice(1, -1))}</code>`;
    return esc(seg)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<i>$2</i>')
      .replace(/(^|\s)~([^~\n]+)~(?=\s|$|[.,!?])/g, '$1<s>$2</s>')
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|\s)@([\w.\-À-ÿ]+)/g, (m, s, n) => `${s}<span class="mention-tag">@${n}</span>`);
  }).join('');
}
const isEmojiOnly = t => {
  const s = (t || '').trim();
  return s.length > 0 && s.length <= 24 && !/[0-9#*]/.test(s) &&
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}|‍|️|\s)+$/u.test(s);
};
const FILE_KINDS = [
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'], '#8e4ec6'],
  [['pdf'], '#e5484d'],
  [['zip', 'rar', '7z', 'gz', 'tar'], '#d4a10b'],
  [['xls', 'xlsx', 'csv', 'ods'], '#30a46c'],
  [['doc', 'docx', 'odt', 'txt', 'md'], '#0090ff'],
  [['mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov'], '#d6409f'],
  [['js', 'ts', 'php', 'py', 'java', 'dart', 'json', 'sql', 'html', 'css', 'vue', 'sh', 'go', 'rs'], '#5b5bd6'],
];
function renderFile(f) {
  const name = f.name || 'fichier';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const color = (FILE_KINDS.find(([exts]) => exts.includes(ext)) || [0, '#6e6e80'])[1];
  const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext), isVideo = ['mp4', 'webm'].includes(ext);
  const card = attrs => `<a class="file" ${attrs}>
    <span class="tile" style="background:${color}">${esc(ext.slice(0, 4) || 'file')}</span>
    <span class="finfo"><span class="fname">${esc(name)}</span><small>${fmtSize(f.size)}${f.e2e ? ' · 🔒 chiffré' : ''}</small></span>
    <span class="dl">${icon('download')}</span></a>`;
  if (f.e2e) {
    const preview = isImg ? `<div class="preview"><img data-encfile="${f.id}" alt="${esc(name)}" data-zoom></div>` :
      isVideo ? `<div class="preview"><video data-encfile="${f.id}" controls preload="metadata"></video></div>` : '';
    return preview + card('href="#" data-download');
  }
  // Ancien fichier envoyé avant le chiffrement (en clair sur le serveur)
  const url = `/files/${f.id}/${encodeURIComponent(name)}?${qs({ token: state.token })}`;
  const preview = isImg ? `<div class="preview"><img src="${url}" alt="${esc(name)}" loading="lazy" data-zoom></div>` :
    isVideo ? `<div class="preview"><video src="${url}" controls preload="metadata"></video></div>` : '';
  return preview + card(`href="${url}&dl=1" download="${esc(name)}"`);
}
function avatarHtml(name, online) {
  return `<span class="av" style="background:${colorOf(name)}" title="${esc(name)}">${initial(name)}${online === undefined ? '' : `<span class="pres ${online ? 'on' : ''}"></span>`}</span>`;
}
function reactionsHtml(m) {
  if (!m.reactions) return '';
  const pills = Object.entries(m.reactions).map(([e, users]) => {
    const who = users.length > 3 ? `${users.slice(0, 3).join(', ')} et ${users.length - 3} autre(s)` : users.join(', ');
    return `<button class="react${users.includes(state.me) ? ' mine' : ''}" data-emoji="${esc(e)}" title="${esc(who)} ${users.length > 1 ? 'ont' : 'a'} réagi avec ${esc(e)}">${esc(e)}<span>${users.length}</span></button>`;
  }).join('');
  return `<div class="reactions">${pills}<button class="react add" data-act="react-pick" title="Ajouter une réaction">${icon('smile-plus')}</button></div>`;
}
function threadSumHtml(m) {
  const t = m.thread;
  if (!t) return '';
  return `<div class="thread-sum" data-act="thread"><span class="avs">${t.users.map(u => avatarHtml(u)).join('')}</span>
    <b>${plural(t.count, 'réponse', 'réponses')}</b><span class="last">Dernière réponse ${fmtWhen(t.lastTs)}</span><span class="view">Voir le fil ›</span></div>`;
}

// Texte du message, avec « (modifié) » collé à la fin du dernier paragraphe
function bodyHtml(m) {
  if (m.locked) return `<p class="locked">${icon('lock')} Message chiffré — la clé n'est pas encore disponible sur ce poste</p>`;
  const html = m.text ? renderText(m.text) : '';
  if (!m.edited) return html;
  const tag = `<span class="edited" title="${new Date(m.edited).toLocaleString('fr-FR')}">(modifié)</span>`;
  return html.endsWith('</p>') ? html.slice(0, -4) + tag + '</p>' : html + tag;
}

// opts : { inThread, isParent, animate }
function renderMessage(m, prev, opts = {}) {
  const cont = prev && prev.user === m.user && m.ts - prev.ts < 5 * 60e3 && sameDay(prev.ts, m.ts) && !m.broadcast && !opts.isParent;
  const mine = m.user === state.me;
  const el = document.createElement('div');
  el.className = 'msg' + (cont ? ' cont' : '') + (isMentioned(m) ? ' mention' : '') + (opts.animate ? ' new' : '') +
    (!opts.inThread && state.thread && state.thread.id === m.id ? ' selected' : '');
  el.dataset.id = m.id;
  const canThread = !opts.inThread && !m.parent;
  el.innerHTML = `
    ${cont ? `<div class="gutter">${fmtTime(m.ts)}</div>` : `<div class="avatar" style="background:${colorOf(m.user)}">${initial(m.user)}</div>`}
    <div class="content">
      ${cont ? '' : `<div class="meta"><b>${esc(m.user)}</b>${mine ? '<span class="you">toi</span>' : ''}${m.legacy ? '<span class="legacy" title="Envoyé avant l\'activation du chiffrement">non chiffré</span>' : ''}<time title="${new Date(m.ts).toLocaleString('fr-FR')}">${fmtTime(m.ts)}</time></div>`}
      ${m.broadcast && !opts.inThread ? `<div class="bc-label">a répondu dans <a data-act="open-parent">un fil</a></div>` : ''}
      <div class="body${isEmojiOnly(m.text) && !m.file ? ' jumbo' : ''}">${bodyHtml(m)}${m.file ? renderFile(m.file) : ''}</div>
      ${reactionsHtml(m)}
      ${!opts.inThread ? threadSumHtml(m) : ''}
    </div>
    <div class="actions">
      <button data-quick="✅" title="Réagir ✅">✅</button><button data-quick="👀" title="Réagir 👀">👀</button><button data-quick="🙌" title="Réagir 🙌">🙌</button>
      <button data-act="react-pick" title="Ajouter une réaction">${icon('smile-plus')}</button>
      ${canThread ? `<button data-act="thread" title="Répondre dans un fil">${icon('thread')}</button>` : ''}
      <span class="sep"></span>
      ${m.text ? `<button data-act="copy" title="Copier le texte">${icon('copy')}</button>` : ''}
      ${mine ? `<button data-act="edit" title="Modifier">${icon('edit')}</button><button class="del" data-act="delete" title="Supprimer">${icon('trash')}</button>` : ''}
    </div>`;
  el._msg = m; el._prev = prev; el._opts = opts;
  return el;
}
function dayEl(ts, extra = '') {
  const d = document.createElement('div'); d.className = 'day' + extra;
  d.innerHTML = `<span>${esc(fmtDay(ts))}</span>`;
  return d;
}
// Remplace un message à l'écran (partout où il est affiché) après une modification ou une réaction.
function refreshMsg(m) {
  document.querySelectorAll(`.msg[data-id="${m.id}"]`).forEach(el => {
    if (el.classList.contains('editing')) return;
    const n = renderMessage(m, el._prev, { ...el._opts, animate: false });
    el.replaceWith(n);
  });
}

// ---------- Barre latérale & en-tête ----------
function people() {
  const set = new Set([...state.online, ...state.users.keys()].filter(u => u !== state.me));
  for (const ch of state.dms) set.add(dmOther(ch));
  return [...set].sort((a, b) => a.localeCompare(b));
}
function renderSidebar() {
  const ti = $('#threadsItem');
  ti.innerHTML = '';
  const n = state.threadUnread.size;
  const th = document.createElement('div');
  th.className = 'item' + (state.view === 'threads' ? ' active' : '') + (n ? ' unread' : '');
  th.innerHTML = `${icon('thread')}<span class="name">Fils de discussion</span>${n ? `<span class="badge">${n}</span>` : ''}`;
  th.onclick = openThreadsView;
  ti.appendChild(th);

  const chList = $('#channelList');
  chList.innerHTML = '';
  for (const ch of state.channels) chList.appendChild(sideItem(ch, `<span class="hash">#</span><span class="name">${esc(ch)}</span>`));
  const dmList = $('#dmList');
  dmList.innerHTML = '';
  for (const u of people()) dmList.appendChild(sideItem(dmId(u), `${avatarHtml(u, state.online.includes(u))}<span class="name">${esc(u)}</span>`));
  if (!dmList.children.length) dmList.innerHTML = '<div class="item hint">Personne d\'autre en ligne. Partage le lien avec 🔗 en haut !</div>';
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0) + n;
  document.title = (total ? `(${total}) ` : '') + 'LAN Chat';
  renderTopbar();
}
function sideItem(ch, inner) {
  const el = document.createElement('div');
  const n = state.unread[ch] || 0;
  el.className = 'item' + (ch === state.current && state.view === 'channel' ? ' active' : '') + (n ? ' unread' : '');
  el.innerHTML = inner + (n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '');
  el.onclick = () => openChannel(ch);
  return el;
}
function setTopbar(iconHtml, title, sub, avatarOf) {
  const tIcon = $('#tIcon');
  tIcon.className = 't-icon' + (avatarOf ? ' av' : '');
  tIcon.style.background = avatarOf ? colorOf(avatarOf) : '';
  tIcon.innerHTML = iconHtml;
  $('#title').textContent = title;
  $('#subtitle').textContent = sub;
}
function renderTopbar() {
  if (state.view !== 'channel') return;
  const ch = state.current;
  if (isDm(ch)) {
    const u = dmOther(ch), on = state.online.includes(u);
    setTopbar(`${initial(u)}<span class="pres ${on ? 'on' : ''}"></span>`, u, `${on ? 'En ligne' : 'Hors ligne'} · 🔒 Chiffré de bout en bout`, u);
  } else {
    setTopbar('#', ch, `${plural(state.online.length, 'personne en ligne', 'personnes en ligne')} · 🔒 Chiffré de bout en bout`);
  }
}
function introEl() {
  const ch = state.current, el = document.createElement('div');
  el.className = 'intro';
  if (isDm(ch)) {
    const u = dmOther(ch);
    el.innerHTML = `<div class="big av" style="background:${colorOf(u)}">${initial(u)}</div>
      <h3>${esc(u)}</h3><p>Début de ta conversation privée avec <b>${esc(u)}</b>, chiffrée de bout en bout : seuls vous deux pouvez la lire.</p>
      <p class="safety">${icon('lock')}<span>Code de sécurité : <code>…</code><br>Comparez-le de vive voix : s'il est identique chez vous deux, personne ne s'est glissé entre vous.</span></p>`;
    const pub = state.users.get(u);
    if (pub) E2E.safetyNumber(state.pub, pub).then(n => { el.querySelector('.safety code').textContent = n; });
    else el.querySelector('.safety span').textContent = `${u} n'a pas encore de compte.`;
  } else {
    el.innerHTML = `<div class="big">#</div><h3>Bienvenue dans #${esc(ch)}</h3>
      <p>C'est le tout début du canal <b>#${esc(ch)}</b>. Les messages sont chiffrés de bout en bout : même le serveur ne peut pas les lire. Mentionne <b>@tous</b> pour notifier tout le monde, et survole un message pour y répondre dans un fil.</p>`;
  }
  return el;
}

// ---------- Liste des messages du canal ----------
function renderMessages({ keepScroll = false } = {}) {
  const box = $('#msgs');
  const data = state.cache[state.current];
  const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
  box.innerHTML = '';
  codeStore.length = 0;
  hidePill();
  if (!data) return;
  if (data.hasMore) {
    const more = document.createElement('div'); more.className = 'more';
    more.innerHTML = '<button>Charger les messages précédents</button>';
    more.querySelector('button').onclick = loadOlder;
    box.appendChild(more);
  } else box.appendChild(introEl());
  let prev = null, unreadShown = false, unreadEl = null;
  for (const m of data.messages) {
    state.known.add(m.user);
    if (!prev || !sameDay(prev.ts, m.ts)) box.appendChild(dayEl(m.ts));
    if (!unreadShown && m.id > state.readMark && m.user !== state.me) {
      unreadShown = true;
      unreadEl = document.createElement('div'); unreadEl.className = 'unread-line'; unreadEl.textContent = 'Nouveaux';
      box.appendChild(unreadEl);
      prev = null; // le premier message non lu affiche toujours son en-tête
    }
    box.appendChild(renderMessage(m, prev));
    prev = m;
  }
  if (keepScroll) box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  else if (unreadEl && unreadEl.offsetTop > box.clientHeight) box.scrollTop = unreadEl.offsetTop - 80;
  else box.scrollTop = box.scrollHeight;
}
const nearBottom = box => box.scrollHeight - box.scrollTop - box.clientHeight < 140;
function appendMessage(m) {
  const box = $('#msgs');
  const data = state.cache[state.current];
  const atBottom = nearBottom(box);
  const prev = data.messages[data.messages.length - 2];
  if (!prev || !sameDay(prev.ts, m.ts)) box.appendChild(dayEl(m.ts));
  box.appendChild(renderMessage(m, prev, { animate: true }));
  const stick = atBottom || m.user === state.me;
  if (stick) box.scrollTop = box.scrollHeight;
  else { state.pending++; showPill(); }
  box.lastElementChild.querySelectorAll('img').forEach(img => img.addEventListener('load', () => { if (stick) box.scrollTop = box.scrollHeight; }, { once: true }));
}
function showPill() {
  const p = $('#newPill');
  p.querySelector('span').textContent = plural(state.pending, 'nouveau message', 'nouveaux messages');
  p.hidden = false;
}
function hidePill() { state.pending = 0; $('#newPill').hidden = true; }
$('#newPill').onclick = () => { const b = $('#msgs'); b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); hidePill(); };
$('#msgs').addEventListener('scroll', () => { if (state.pending && nearBottom($('#msgs'))) hidePill(); });
function markRead(ch, id) {
  const cur = Number(store.get('lanchat:read:' + ch)) || 0;
  if (id > cur) store.set('lanchat:read:' + ch, String(id));
}

// ---------- Navigation ----------
function setView(view) {
  state.view = view;
  $('#mainComposer').hidden = view !== 'channel';
  if (view !== 'channel') $('#keyWait').hidden = true;
  $('#app').classList.remove('open');
}
async function openChannel(ch) {
  setView('channel');
  $('#search').value = '';
  state.current = ch;
  store.set('lanchat:channel', ch);
  state.unread[ch] = 0;
  if (isDm(ch)) state.dms.add(ch);
  const stored = store.get('lanchat:read:' + ch);
  state.readMark = stored === null ? Infinity : Number(stored);
  mainComposer.setPlaceholder(`Message ${isDm(ch) ? 'à ' + dmOther(ch) : '#' + ch}`);
  renderSidebar();
  renderTyping();
  if (!isDm(ch)) await ensureChannelKey(ch).catch(() => {});
  updateKeyWait();
  if (!state.cache[ch]) {
    $('#msgs').innerHTML = '';
    try {
      const data = await api(`/api/messages?${qs({ channel: ch })}`);
      await decryptAll(data.messages);
      state.cache[ch] = data;
    } catch (e) { return toast(e.message); }
  }
  if (state.current !== ch || state.view !== 'channel') return;
  renderMessages();
  const last = state.cache[ch].messages.at(-1);
  if (last) markRead(ch, last.id);
  if (matchMedia('(min-width: 761px)').matches) mainComposer.focus();
}
async function loadOlder() {
  const data = state.cache[state.current];
  const first = data.messages[0];
  const older = await api(`/api/messages?${qs({ channel: state.current, before: first ? first.id : '' })}`);
  await decryptAll(older.messages);
  data.messages = [...older.messages, ...data.messages];
  data.hasMore = older.hasMore;
  renderMessages({ keepScroll: true });
}

// Recherche
let searchTimer, searchCache = null;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { if (state.view === 'search') openChannel(state.current); return; }
  searchTimer = setTimeout(async () => {
    // Le serveur ne peut pas chercher dans des messages chiffrés : on déchiffre l'historique récent ici
    if (!searchCache || Date.now() - searchCache.ts > 30000) {
      const { messages: all } = await api('/api/all');
      searchCache = { ts: Date.now(), messages: await decryptAll(all) };
    }
    const ql = q.toLowerCase();
    const messages = searchCache.messages.filter(m => (m.text || '').toLowerCase().includes(ql) || (m.file?.name || '').toLowerCase().includes(ql)).reverse().slice(0, 50);
    setView('search');
    renderSidebar();
    setTopbar(icon('search'), `« ${q} »`, plural(messages.length, 'résultat', 'résultats'));
    const box = $('#msgs'); box.innerHTML = ''; codeStore.length = 0; hidePill();
    if (!messages.length) box.innerHTML = `<div class="empty-search">${icon('search')}Aucun message ne correspond à ta recherche.</div>`;
    for (const m of messages) {
      const d = document.createElement('div'); d.className = 'day link';
      d.innerHTML = `<span>${esc(label(m.channel))}${m.parent ? ' · dans un fil' : ''} · ${esc(fmtDay(m.ts))}</span>`;
      d.querySelector('span').onclick = () => m.parent ? (openChannel(m.channel), openThread(m.parent, m.id)) : jumpTo(m.channel, m.id);
      box.appendChild(d); box.appendChild(renderMessage(m, null, { inThread: !!m.parent }));
    }
  }, 250);
});
async function jumpTo(ch, id) {
  await openChannel(ch);
  const el = $(`#msgs .msg[data-id="${id}"]`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
}

// ---------- Vue « Fils de discussion » ----------
async function openThreadsView() {
  setView('threads');
  renderSidebar();
  setTopbar(icon('thread'), 'Fils de discussion', 'Les fils auxquels tu participes');
  await renderThreadsView();
}
async function renderThreadsView() {
  const { threads } = await api('/api/threads');
  await decryptAll(threads.flatMap(t => [t.parent, ...t.latest]));
  if (state.view !== 'threads') return;
  const box = $('#msgs'); box.innerHTML = ''; codeStore.length = 0; hidePill();
  if (!threads.length) {
    box.innerHTML = `<div class="empty-search">${icon('thread')}Aucun fil pour l'instant.<br>Survole un message et clique sur ${'«'} Répondre dans un fil ${'»'} pour en démarrer un.</div>`;
    return;
  }
  for (const { parent, latest } of threads) {
    const card = document.createElement('div'); card.className = 'th-card';
    const unread = state.threadUnread.has(parent.id);
    card.innerHTML = `<div class="th-card-head"><span class="chip">${esc(label(parent.channel))}</span><span style="color:var(--muted)">${unread ? '<b style="color:var(--new)">Nouvelles réponses · </b>' : ''}${plural(parent.thread.count, 'réponse', 'réponses')}</span></div>`;
    card.appendChild(renderMessage(parent, null, { inThread: true, isParent: true }));
    const hiddenCount = parent.thread.count - latest.length;
    if (hiddenCount > 0) {
      const more = document.createElement('div'); more.className = 'th-more';
      more.innerHTML = `<a>Voir ${plural(hiddenCount, 'réponse de plus', 'réponses de plus')}</a>`;
      more.querySelector('a').onclick = () => openThread(parent.id);
      card.appendChild(more);
    }
    let prev = null;
    for (const r of latest) { card.appendChild(renderMessage(r, prev, { inThread: true })); prev = r; }
    const foot = document.createElement('div'); foot.className = 'th-foot';
    foot.innerHTML = `<button class="btn-sm">Répondre…</button>`;
    foot.querySelector('button').onclick = () => openThread(parent.id);
    card.appendChild(foot);
    box.appendChild(card);
  }
}

// ---------- Panneau de fil ----------
async function openThread(id, flashId) {
  let data;
  try { data = await api(`/api/thread/${id}`); await decryptAll([data.parent, ...data.replies]); }
  catch (e) { return toast(e.message); }
  state.thread = { id, channel: data.parent.channel, parent: data.parent, replies: data.replies };
  state.threadUnread.delete(id);
  $('#app').classList.add('thread-open');
  $('#app').classList.remove('open');
  document.querySelectorAll('#msgs .msg.selected').forEach(el => el.classList.remove('selected'));
  document.querySelector(`#msgs .msg[data-id="${id}"]`)?.classList.add('selected');
  threadComposer.setPlaceholder('Répondre…');
  threadComposer.setBroadcastLabel(isDm(data.parent.channel) ? `Aussi à ${dmOther(data.parent.channel)}` : `Aussi dans #${data.parent.channel}`);
  renderThread();
  renderSidebar();
  renderTyping();
  if (flashId) {
    const el = $(`#threadMsgs .msg[data-id="${flashId}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
  }
  threadComposer.focus();
}
function closeThread() {
  state.thread = null;
  $('#app').classList.remove('thread-open');
  document.querySelectorAll('#msgs .msg.selected').forEach(el => el.classList.remove('selected'));
}
$('#thClose').onclick = closeThread;
function renderThread({ stick = true } = {}) {
  const t = state.thread;
  if (!t) return;
  const box = $('#threadMsgs');
  const prevTop = box.scrollTop;
  $('#thSub').textContent = label(t.channel);
  box.innerHTML = '';
  box.appendChild(renderMessage(t.parent, null, { inThread: true, isParent: true }));
  const count = document.createElement('div'); count.className = 'th-count';
  count.textContent = t.replies.length ? plural(t.replies.length, 'réponse', 'réponses') : 'Aucune réponse pour l\'instant';
  box.appendChild(count);
  let prev = null;
  for (const r of t.replies) { box.appendChild(renderMessage(r, prev, { inThread: true })); prev = r; }
  box.scrollTop = stick ? box.scrollHeight : prevTop;
}

// ---------- Sélecteur rapide (Cmd/Ctrl+K) ----------
let swItems = [], swSel = 0;
function openSwitcher() {
  $('#switcher').hidden = false; $('#swInput').value = ''; swSel = 0; renderSwitcher(); $('#swInput').focus();
}
function closeSwitcher() { $('#switcher').hidden = true; }
function renderSwitcher() {
  const q = $('#swInput').value.trim().toLowerCase();
  const all = [
    { ch: '__threads', name: 'fils de discussion', html: `${icon('thread', 'width:22px')}<span>Fils de discussion</span>` },
    ...state.channels.map(c => ({ ch: c, name: c, html: `<span class="hash">#</span><span>${esc(c)}</span>` })),
    ...people().map(u => ({ ch: dmId(u), name: u, html: `${avatarHtml(u, state.online.includes(u))}<span>${esc(u)}</span>` })),
  ];
  swItems = all.filter(i => i.name.toLowerCase().includes(q));
  swSel = Math.min(swSel, Math.max(0, swItems.length - 1));
  $('#swList').innerHTML = swItems.length ? '' : '<div class="sw-item" style="cursor:default;opacity:.6">Aucun résultat</div>';
  swItems.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'sw-item' + (i === swSel ? ' sel' : '');
    const n = state.unread[it.ch];
    el.innerHTML = it.html + (n ? `<small>${n} non lu${n > 1 ? 's' : ''}</small>` : '');
    el.onmouseenter = () => { swSel = i; [...$('#swList').children].forEach((c, j) => c.classList.toggle('sel', j === i)); };
    el.onclick = () => goSwitch(it);
    $('#swList').appendChild(el);
  });
}
function goSwitch(it) { closeSwitcher(); if (it.ch === '__threads') openThreadsView(); else openChannel(it.ch); }
$('#swInput').addEventListener('input', () => { swSel = 0; renderSwitcher(); });
$('#swInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); swSel = Math.min(swSel + 1, swItems.length - 1); renderSwitcher(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); swSel = Math.max(swSel - 1, 0); renderSwitcher(); }
  if (e.key === 'Enter' && swItems[swSel]) goSwitch(swItems[swSel]);
});
$('#switcher').addEventListener('mousedown', e => { if (e.target.id === 'switcher') closeSwitcher(); });
$('#openSwitcher').onclick = openSwitcher;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$('#kbdHint').textContent = isMac ? '⌘K' : 'Ctrl K';
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && state.me) { e.preventDefault(); $('#switcher').hidden ? openSwitcher() : closeSwitcher(); }
  if (e.key === 'Escape') {
    if (!$('#picker').hidden) return closePicker();
    if (!$('#switcher').hidden) return closeSwitcher();
    if (!$('#channelModal').hidden) { $('#channelModal').hidden = true; return; }
    if (document.querySelector('.lightbox')) return document.querySelector('.lightbox').remove();
  }
});

// ---------- Sélecteur d'emoji ----------
let pickerCb = null;
const recents = () => { try { return JSON.parse(store.get('lanchat:recent-emoji') || '[]'); } catch { return []; } };
function addRecent(ch) { store.set('lanchat:recent-emoji', JSON.stringify([ch, ...recents().filter(x => x !== ch)].slice(0, 16))); }
function openPicker(anchor, cb) {
  pickerCb = cb;
  const pk = $('#picker');
  pk.hidden = false;
  $('.pk-search input', pk).value = '';
  renderPicker('');
  const r = anchor.getBoundingClientRect();
  const w = pk.offsetWidth, h = pk.offsetHeight;
  let left = Math.min(r.right - w, innerWidth - w - 10); left = Math.max(10, left);
  let top = r.top - h - 8; if (top < 10) top = Math.min(r.bottom + 8, innerHeight - h - 10);
  pk.style.left = left + 'px'; pk.style.top = top + 'px';
  anchor.closest('.msg')?.classList.add('menu-open');
  pk._anchorMsg = anchor.closest('.msg');
  if (matchMedia('(min-width: 761px)').matches) $('.pk-search input', pk).focus();
}
function closePicker() {
  $('#picker').hidden = true; pickerCb = null;
  $('#picker')._anchorMsg?.classList.remove('menu-open');
}
function renderPicker(q) {
  const body = $('#picker .pk-body');
  q = q.trim().toLowerCase();
  const btn = e => `<button data-e="${e.ch}" data-kw="${esc(e.kw[0] || '')}">${e.ch}</button>`;
  if (q) {
    const found = EMOJIS.filter(e => e.kw.some(k => k.includes(q)));
    body.innerHTML = found.length ? `<div class="pk-grid">${found.map(btn).join('')}</div>` : '<div class="pk-cat">Aucun emoji trouvé</div>';
    return;
  }
  const rec = recents().map(ch => EMOJIS.find(e => e.ch === ch) || { ch, kw: [] });
  let html = rec.length ? `<div class="pk-cat">Récents</div><div class="pk-grid">${rec.map(btn).join('')}</div>` : '';
  for (const [cat] of EMOJI_CATS) html += `<div class="pk-cat">${esc(cat)}</div><div class="pk-grid">${EMOJIS.filter(e => e.cat === cat).map(btn).join('')}</div>`;
  body.innerHTML = html;
}
$('#picker .pk-search input').addEventListener('input', e => renderPicker(e.target.value));
$('#picker .pk-search input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const first = $('#picker .pk-grid button'); if (first) first.click(); }
});
$('#picker .pk-body').addEventListener('click', e => {
  const b = e.target.closest('button[data-e]');
  if (!b) return;
  addRecent(b.dataset.e);
  const cb = pickerCb; closePicker(); cb && cb(b.dataset.e);
});
$('#picker .pk-body').addEventListener('mouseover', e => {
  const b = e.target.closest('button[data-e]');
  if (b) { $('#picker .pk-foot b').textContent = b.dataset.e; $('#picker .pk-foot span').textContent = b.dataset.kw ? `:${b.dataset.kw}:` : ''; }
});
document.addEventListener('mousedown', e => {
  if (!$('#picker').hidden && !e.target.closest('#picker') && !e.target.closest('[data-act="react-pick"],[data-tool="emoji"]')) closePicker();
});

// ---------- Réactions, édition, suppression ----------
async function react(m, emoji) {
  try { await api(`/api/messages/${m.id}/react`, { method: 'POST', body: JSON.stringify({ emoji }) }); }
  catch (e) { toast(e.message); }
  if (emoji === '🎉') confetti();
}
function inFence(ta) { return ((ta.value.slice(0, ta.selectionStart).match(/```/g) || []).length % 2) === 1; }
function startEdit(el) {
  const m = el._msg;
  if (!m || m.user !== state.me) return;
  el.classList.add('editing');
  const body = el.querySelector('.body');
  body.classList.remove('jumbo');
  body.innerHTML = `<div class="edit-box"><textarea rows="1"></textarea><div class="edit-hint">Échap pour <a data-edit="cancel">annuler</a> · Entrée pour <a data-edit="save">enregistrer</a></div></div>${m.file ? renderFile(m.file) : ''}`;
  const ta = body.querySelector('textarea');
  ta.value = m.text || '';
  const size = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  size(); ta.addEventListener('input', size);
  ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
  const cancel = () => { el.classList.remove('editing'); refreshMsg(m); };
  const save = async () => {
    const text = ta.value;
    if (text === (m.text || '')) return cancel();
    if (!text.trim() && !m.file) return deleteMsg(m);
    try {
      // La mise à jour temps réel peut arriver avant la réponse : on rafraîchit nous-mêmes en sortant du mode édition
      const key = await keyFor(m.channel);
      if (!key) return toast('Clé de chiffrement indisponible');
      const enc = await E2E.encryptPayload(key, m.file?.e2e ? { text, file: fileMeta(m.file) } : { text }, m.channel);
      const updated = await decryptMsg(await api(`/api/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ enc }) }));
      el.classList.remove('editing');
      refreshMsg(updated);
    }
    catch (e) { toast(e.message); }
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !inFence(ta)) { e.preventDefault(); save(); }
  });
  body.querySelector('[data-edit="cancel"]').onclick = cancel;
  body.querySelector('[data-edit="save"]').onclick = save;
}
async function deleteMsg(m) {
  const isRoot = !m.parent && m.thread;
  if (!confirm(isRoot ? `Supprimer ce message et les ${m.thread.count} réponse(s) de son fil ?` : 'Supprimer ce message ?')) return;
  try { await api(`/api/messages/${m.id}`, { method: 'DELETE' }); }
  catch (err) { toast(err.message); }
}

// Actions sur les messages (délégation sur toute la page)
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-copy],[data-zoom],[data-act],[data-quick],[data-download],.react[data-emoji]');
  if (!t || !t.closest('.msg')) return;
  if (t.dataset.copy !== undefined) return copy(codeStore[t.dataset.copy], t);
  if (t.dataset.zoom !== undefined) {
    const lb = document.createElement('div'); lb.className = 'lightbox';
    lb.innerHTML = `<img src="${t.src}">`; lb.onclick = () => lb.remove(); document.body.appendChild(lb); return;
  }
  const el = t.closest('.msg'), m = el._msg;
  if (t.dataset.download !== undefined) { e.preventDefault(); return downloadFile(m); }
  if (t.dataset.quick) return react(m, t.dataset.quick);
  if (t.dataset.emoji) { t.classList.add('bump'); return react(m, t.dataset.emoji); }
  switch (t.dataset.act) {
    case 'react-pick': return openPicker(t, emoji => react(m, emoji));
    case 'thread': return openThread(m.id);
    case 'open-parent': return openThread(m.parent, m.id);
    case 'copy': return copy(m.text);
    case 'edit': return startEdit(el);
    case 'delete': return deleteMsg(m);
  }
});

// ---------- Indicateur « est en train d'écrire » ----------
function renderTyping() {
  const now = Date.now();
  for (const [key, users] of state.typers) {
    for (const [u, exp] of users) if (exp < now) users.delete(u);
    if (!users.size) state.typers.delete(key);
  }
  const text = key => {
    const users = [...(state.typers.get(key)?.keys() || [])];
    if (!users.length) return '';
    const who = users.length === 1 ? `<b>${esc(users[0])}</b> est en train d'écrire` :
      users.length === 2 ? `<b>${esc(users[0])}</b> et <b>${esc(users[1])}</b> écrivent` : 'Plusieurs personnes écrivent';
    return `<span class="dots"><i></i><i></i><i></i></span><span>${who}…</span>`;
  };
  const set = (c, html) => { if (c.typingHtml !== html) { c.typingHtml = html; c.typing.innerHTML = html; } };
  set(mainComposer, state.view === 'channel' ? text(`${state.current}|0`) : '');
  set(threadComposer, state.thread ? text(`${state.thread.channel}|${state.thread.id}`) : '');
}
setInterval(renderTyping, 1000);

// ---------- Composer (réutilisé pour le canal et le fil) ----------
const COMMANDS = [
  { name: 'shrug', desc: 'Ajoute ¯\\_(ツ)_/¯', run: a => `${a} ¯\\_(ツ)_/¯`.trim() },
  { name: 'flip', desc: 'Renverse la table', run: a => `${a} (╯°□°)╯︵ ┻━┻`.trim() },
  { name: 'unflip', desc: 'Remet la table en place', run: a => `${a} ┬─┬ノ( º _ ºノ)`.trim() },
  { name: 'lenny', desc: '( ͡° ͜ʖ ͡°)', run: a => `${a} ( ͡° ͜ʖ ͡°)`.trim() },
  { name: 'party', desc: 'Envoie des confettis à tout le monde 🎉', run: a => `🎉 ${a || 'Fête !'} 🎉` },
  { name: 'code', desc: 'Envoie le texte comme bloc de code', run: a => '```\n' + a + '\n```' },
];
function makeComposer(wrap, { target, lastOwn, scope, thread }) {
  wrap.appendChild($('#composerTpl').content.cloneNode(true));
  const root = $('.composer', wrap);
  const ta = $('textarea', root), sendBtn = $('.send', root), fileInput = $('input[type=file]', root);
  const ac = $('.ac', root), ups = $('.uploads', root), bc = $('.bc', root);
  if (thread) { bc.hidden = false; $('.hint', wrap).remove(); }
  const c = { typing: $('.typing', wrap), lastTypingPing: 0, acItems: [], acSel: 0, acRange: null };

  const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; sendBtn.disabled = !ta.value.trim(); };
  c.focus = () => ta.focus();
  c.setPlaceholder = p => { ta.placeholder = p; };
  c.setBroadcastLabel = l => { $('span', bc).textContent = l; };
  const insert = (text, before = '', after = '') => {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const sel = v.slice(s, e) || text;
    ta.value = v.slice(0, s) + before + sel + after + v.slice(e);
    ta.focus();
    ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length;
    if (!before && !after) ta.selectionStart = ta.selectionEnd;
    autosize();
  };

  // Autocomplétion : @mention, :emoji:, /commande
  function acQuery() {
    const before = ta.value.slice(0, ta.selectionStart);
    let m = before.match(/^\/(\w*)$/);
    if (m) return { kind: '/', q: m[1], start: 0 };
    m = before.match(/(^|\s)([@:])([\w\-.À-ÿ+]*)$/);
    if (!m || (m[2] === ':' && m[3].length < 2)) return null;
    return { kind: m[2], q: m[3], start: before.length - m[3].length - 1 };
  }
  function updateAc() {
    const query = acQuery();
    if (!query) return hideAc();
    const q = query.q.toLowerCase();
    let items = [], title = '';
    if (query.kind === '@') {
      title = 'Personnes';
      items = [...knownUsers(), 'tous'].filter(u => u.toLowerCase().startsWith(q)).slice(0, 8).map(u => ({
        html: u === 'tous' ? `${icon('bubble')}<span><b>@tous</b></span><small>Notifie tout le monde</small>` : `${avatarHtml(u, state.online.includes(u))}<span>${esc(u)}</span>${state.online.includes(u) ? '<small>en ligne</small>' : ''}`,
        value: '@' + u + ' ',
      }));
    } else if (query.kind === ':') {
      title = 'Emoji';
      items = EMOJIS.map(e => ({ e, k: e.kw.find(k => k.startsWith(q)) })).filter(x => x.k).slice(0, 8)
        .map(({ e, k }) => ({ html: `<span class="ac-emoji">${e.ch}</span><span>:${esc(k)}:</span>`, value: e.ch + ' ', emoji: e.ch }));
    } else {
      title = 'Commandes';
      items = COMMANDS.filter(cmd => cmd.name.startsWith(q)).map(cmd => ({ html: `<span><b>/${cmd.name}</b></span><small>${esc(cmd.desc)}</small>`, value: '/' + cmd.name + ' ' }));
    }
    if (!items.length) return hideAc();
    c.acItems = items; c.acSel = Math.min(c.acSel, items.length - 1); c.acRange = query;
    ac.innerHTML = `<div class="ac-title">${title}</div>` + items.map((it, i) => `<div class="ac-item${i === c.acSel ? ' sel' : ''}" data-i="${i}">${it.html}</div>`).join('');
    ac.hidden = false;
  }
  function hideAc() { ac.hidden = true; c.acItems = []; c.acSel = 0; }
  function pickAc(i) {
    const it = c.acItems[i], r = c.acRange;
    if (!it) return;
    if (it.emoji) addRecent(it.emoji);
    const v = ta.value, end = ta.selectionStart;
    ta.value = v.slice(0, r.start) + it.value + v.slice(end);
    ta.selectionStart = ta.selectionEnd = r.start + it.value.length;
    hideAc(); autosize(); ta.focus();
  }
  ac.addEventListener('mousedown', e => { const item = e.target.closest('.ac-item'); if (item) { e.preventDefault(); pickAc(Number(item.dataset.i)); } });

  ta.addEventListener('input', () => {
    autosize(); updateAc();
    const now = Date.now();
    if (ta.value.trim() && now - c.lastTypingPing > 2500) {
      c.lastTypingPing = now;
      const { channel, parent } = target();
      api('/api/typing', { method: 'POST', body: JSON.stringify({ channel, parent }) }).catch(() => {});
    }
  });
  ta.addEventListener('click', updateAc);
  ta.addEventListener('blur', () => setTimeout(hideAc, 150));
  ta.addEventListener('keydown', e => {
    if (!ac.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); c.acSel = (c.acSel + 1) % c.acItems.length; return updateAc(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); c.acSel = (c.acSel - 1 + c.acItems.length) % c.acItems.length; return updateAc(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickAc(c.acSel); }
      if (e.key === 'Escape') { e.preventDefault(); return hideAc(); }
    }
    if (e.key === 'ArrowUp' && !ta.value) {
      const m = lastOwn();
      const el = m && document.querySelector(`${scope} .msg[data-id="${m.id}"]`);
      if (el) { e.preventDefault(); startEdit(el); }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || inFence(ta)) return;
    e.preventDefault();
    send();
  });

  async function send() {
    let text = ta.value;
    if (!text.trim()) return;
    const cmd = text.match(/^\/(\w+)(?:\s([\s\S]*))?$/);
    if (cmd) {
      const found = COMMANDS.find(x => x.name === cmd[1]);
      if (!found) return toast(`Commande inconnue : /${cmd[1]}`);
      text = found.run((cmd[2] || '').trim());
    }
    const { channel, parent } = target();
    const broadcast = thread && $('input', bc).checked;
    if (!isDm(channel)) await ensureChannelKey(channel).catch(() => {});
    const key = await keyFor(channel);
    if (!key) return toast(isDm(channel) ? 'Cette personne n\'a pas de compte : impossible de lui écrire.' : 'La clé de chiffrement du canal n\'est pas encore arrivée.');
    const original = ta.value;
    ta.value = ''; autosize(); hideAc();
    try {
      const enc = await E2E.encryptPayload(key, { text }, channel);
      await api('/api/messages', { method: 'POST', body: JSON.stringify({ channel, enc, parent, broadcast }) });
      if (broadcast) $('input', bc).checked = false;
    } catch (e) { ta.value = original; autosize(); toast(e.message); }
  }
  sendBtn.onclick = send;

  root.querySelectorAll('[data-wrap]').forEach(b => b.onclick = () => insert('', b.dataset.wrap, b.dataset.wrap));
  $('[data-tool="codeblock"]', root).onclick = () => insert('', '```\n', '\n```');
  $('[data-tool="emoji"]', root).onclick = e => {
    if (!$('#picker').hidden) return closePicker();
    openPicker(e.currentTarget, emoji => insert(emoji));
  };
  $('[data-tool="attach"]', root).onclick = () => fileInput.click();
  fileInput.onchange = () => { [...fileInput.files].forEach(c.upload); fileInput.value = ''; };
  ta.addEventListener('paste', e => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); files.forEach(f => c.upload(f.name === 'image.png' ? new File([f], `capture-${Date.now()}.png`, { type: f.type }) : f)); }
  });

  // Envoi d'un fichier : chiffré dans le navigateur, envoyé, puis annoncé par un message chiffré qui porte
  // son nom, son type et son IV.
  c.upload = async file => {
    const { channel, parent } = target();
    if (!isDm(channel)) await ensureChannelKey(channel).catch(() => {});
    const key = await keyFor(channel);
    if (!key) return toast('Clé de chiffrement indisponible pour cette conversation.');
    const row = document.createElement('div');
    row.className = 'up';
    row.innerHTML = `${icon('lock')}<span class="uname">${esc(file.name)}</span><small>Chiffrement…</small><span class="bar"><i></i></span>`;
    ups.appendChild(row);
    let encrypted;
    try { encrypted = await E2E.encryptFile(key, await file.arrayBuffer(), channel); }
    catch { row.remove(); return toast('Impossible de chiffrer ce fichier (trop gros pour le navigateur ?)'); }
    row.querySelector('small').textContent = fmtSize(file.size);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) row.querySelector('.bar i').style.width = (e.loaded / e.total * 100) + '%'; };
    xhr.onload = async () => {
      try {
        if (xhr.status >= 300) { let msg = 'Échec de l\'envoi'; try { msg = JSON.parse(xhr.responseText).error; } catch {} throw new Error(msg); }
        const { fileId } = JSON.parse(xhr.responseText);
        const enc = await E2E.encryptPayload(key, { text: '', file: { name: file.name, type: file.type, size: file.size, iv: encrypted.iv } }, channel);
        await api('/api/messages', { method: 'POST', body: JSON.stringify({ channel, parent, enc, fileId }) });
      } catch (e) { toast(e.message); }
      row.remove();
    };
    xhr.onerror = () => { row.remove(); toast('Échec de l\'envoi de ' + file.name); };
    xhr.send(encrypted.data);
  };
  return c;
}
const mainComposer = makeComposer($('#mainComposer'), {
  target: () => ({ channel: state.current, parent: null }),
  lastOwn: () => (state.cache[state.current]?.messages || []).filter(m => m.user === state.me).at(-1),
  scope: '#msgs',
});
const threadComposer = makeComposer($('#threadComposer'), {
  target: () => ({ channel: state.thread.channel, parent: state.thread.id }),
  lastOwn: () => (state.thread?.replies || []).filter(m => m.user === state.me).at(-1),
  scope: '#threadMsgs',
  thread: true,
});

// Glisser-déposer sur le canal ou sur le fil
function setupDrop(area, composer, enabled) {
  let depth = 0;
  const overlay = $('.drop', area);
  area.addEventListener('dragenter', e => { if (enabled() && e.dataTransfer.types.includes('Files')) { depth++; overlay.classList.add('on'); } });
  area.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.classList.remove('on'); } });
  area.addEventListener('dragover', e => e.preventDefault());
  area.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; overlay.classList.remove('on');
    if (enabled()) [...e.dataTransfer.files].forEach(composer.upload);
  });
}
setupDrop($('#main'), mainComposer, () => state.view === 'channel');
setupDrop($('#thread'), threadComposer, () => !!state.thread);

// ---------- Temps réel ----------
function replaceIn(list, m) {
  const i = list ? list.findIndex(x => x.id === m.id) : -1;
  if (i >= 0) list[i] = m;
}
function connect() {
  es?.close();
  es = new EventSource(`/api/events?${qs({ token: state.token })}`);
  es.onopen = () => $('#offline').hidden = true;
  es.onerror = () => {
    $('#offline').hidden = false;
    // Flux fermé définitivement (ex. session expirée) : on vérifie la session puis on retente
    if (es.readyState === EventSource.CLOSED) setTimeout(() => api('/api/users').then(connect).catch(() => setTimeout(connect, 3000)), 2000);
  };
  // Les événements sont traités dans l'ordre, l'un après l'autre (le déchiffrement est asynchrone)
  let queue = Promise.resolve();
  const on = (name, fn) => es.addEventListener(name, e => { queue = queue.then(() => fn(JSON.parse(e.data))).catch(err => console.error(err)); });
  on('hello', async d => {
    state.channels = d.channels; state.online = d.online;
    await loadUsers();
    await loadKeys();
    scheduleShare();
    searchCache = null;
    const { dms } = await api('/api/dms');
    dms.forEach(ch => state.dms.add(ch));
    // Après une reconnexion on recharge tout pour récupérer ce qu'on a raté
    state.cache = {};
    if (!state.channels.includes(state.current) && !isDm(state.current)) state.current = 'general';
    if (state.view === 'threads') openThreadsView(); else openChannel(state.current);
    if (state.thread) openThread(state.thread.id);
  });
  on('presence', d => { state.online = d.online; renderSidebar(); });
  on('channels', d => { state.channels = d.channels; renderSidebar(); });
  on('user', u => { state.users.set(u.name, u.pub); state.known.add(u.name); renderSidebar(); scheduleShare(); });
  on('keys', async ({ channel, holders }) => {
    state.holders[channel] = holders;
    if (holders.includes(state.me) && !state.chKeys.has(channel)) (await loadKeys()).forEach(onKeyArrived);
    if (state.chKeys.has(channel)) scheduleShare();
  });
  on('typing', ({ user, channel, parent }) => {
    if (user === state.me) return;
    const key = `${channel}|${parent || 0}`;
    if (!state.typers.has(key)) state.typers.set(key, new Map());
    state.typers.get(key).set(user, Date.now() + 4000);
    renderTyping();
  });
  on('message', async m => {
    await decryptMsg(m);
    searchCache = null;
    const mine = m.user === state.me;
    state.known.add(m.user);
    state.typers.get(`${m.channel}|${m.parent || 0}`)?.delete(m.user);
    renderTyping();
    if (isDm(m.channel)) state.dms.add(m.channel);
    if ((m.text || '').includes('🎉')) confetti();

    if (m.parent) {
      const t = state.thread;
      const viewing = t && t.id === m.parent;
      if (viewing && !t.replies.some(x => x.id === m.id)) {
        const box = $('#threadMsgs');
        const stick = nearBottom(box) || mine;
        t.replies.push(m);
        renderThread({ stick });
      }
      if (!mine && (m.participants || []).includes(state.me) && !(viewing && !document.hidden)) {
        state.threadUnread.add(m.parent);
        notify(m, true);
      }
      if (state.view === 'threads') renderThreadsView();
      if (!m.broadcast) return renderSidebar();
    }

    const data = state.cache[m.channel];
    if (data && !data.messages.some(x => x.id === m.id)) data.messages.push(m);
    const visible = state.view === 'channel' && m.channel === state.current;
    if (visible && data) { appendMessage(m); if (!document.hidden) markRead(m.channel, m.id); }
    if (!mine && (!visible || document.hidden)) {
      if (!visible) state.unread[m.channel] = (state.unread[m.channel] || 0) + 1;
      if (!m.parent) notify(m, false);
    }
    renderSidebar();
  });
  on('update', async m => {
    await decryptMsg(m);
    searchCache = null;
    replaceIn(state.cache[m.channel]?.messages, m);
    if (state.thread) {
      if (state.thread.id === m.id) state.thread.parent = m;
      replaceIn(state.thread.replies, m);
    }
    refreshMsg(m);
  });
  on('delete', ({ id, channel, parent }) => {
    searchCache = null;
    const data = state.cache[channel];
    if (data) data.messages = data.messages.filter(m => m.id !== id);
    if (state.thread) {
      if (state.thread.id === id) { closeThread(); toast('Le fil a été supprimé'); }
      else if (state.thread.id === parent) { state.thread.replies = state.thread.replies.filter(r => r.id !== id); renderThread({ stick: false }); }
    }
    if (channel === state.current && state.view === 'channel') renderMessages({ keepScroll: true });
    if (state.view === 'threads') renderThreadsView();
  });
}
function notify(m, inThread) {
  if (!(inThread || isDm(m.channel) || isMentioned(m) || document.hidden)) return;
  ping();
  const where = inThread ? `a répondu dans un fil · ${label(m.channel)}` : label(m.channel);
  const body = m.text ? m.text.slice(0, 140) : m.file ? '📎 ' + (m.file.name || 'fichier') : '🔒 Message chiffré';
  const open = () => { if (inThread) { openChannel(m.channel); openThread(m.parent, m.id); } else openChannel(m.channel); };
  if (!document.hidden && (inThread || isDm(m.channel) || isMentioned(m))) toast(`${m.user} ${inThread ? 'a répondu dans un fil' : '· ' + label(m.channel)} : ${body.slice(0, 60)}`, open);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(`${m.user} · ${where}`, { body, tag: 'lanchat-' + (m.parent || m.channel) });
    n.onclick = () => { window.focus(); open(); n.close(); };
  }
}

// ---------- Canaux, pseudo, mobile ----------
$('#addChannel').onclick = () => { $('#channelModal').hidden = false; $('#channelName').focus(); };
$('#channelCancel').onclick = () => $('#channelModal').hidden = true;
$('#channelModal').addEventListener('mousedown', e => { if (e.target.id === 'channelModal') $('#channelModal').hidden = true; });
$('#channelForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const { name } = await api('/api/channels', { method: 'POST', body: JSON.stringify({ name: $('#channelName').value }) });
    $('#channelModal').hidden = true; $('#channelName').value = '';
    if (!state.channels.includes(name)) state.channels.push(name);
    openChannel(name);
  } catch (err) { toast(err.message); }
};
$('#menu').onclick = () => $('#app').classList.toggle('open');
$('#backdrop').onclick = () => $('#app').classList.remove('open');
$('#wsHost').innerHTML = `${icon('bubble', 'width:12px;height:12px')}${esc(location.host)}`;
$('#invite').onclick = () => copy(location.origin);
function updatePreview() {
  const v = $('#loginName').value.trim();
  $('#avPreview').textContent = v ? [...v][0].toUpperCase() : '?';
  $('#avPreview').style.background = v ? colorOf(v) : '';
}
$('#loginName').addEventListener('input', updatePreview);

// ---------- Connexion / création de compte ----------
let authMode = 'login';
const authError = t => { $('#authError').textContent = t; $('#authError').hidden = !t; };
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('#authTabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  document.querySelectorAll('.reg-only').forEach(el => { el.hidden = mode !== 'register'; });
  $('#loginPass2').required = $('#loginCode').required = mode === 'register';
  $('#loginPass').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#authBtn').textContent = mode === 'register' ? 'Créer mon compte' : 'Se connecter';
  authError('');
}
document.querySelectorAll('#authTabs button').forEach(b => { b.onclick = () => setAuthMode(b.dataset.mode); });
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Erreur ' + r.status);
  return d;
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('#loginName').value.trim(), pw = $('#loginPass').value;
  if (!/^[\w.\-À-ÿ]{2,32}$/.test(name)) return authError('Pseudo : 2 à 32 caractères (lettres, chiffres, . - _), sans espace.');
  if (authMode === 'register') {
    if (pw.length < 8) return authError('Le mot de passe doit faire au moins 8 caractères.');
    if (pw !== $('#loginPass2').value) return authError('Les deux mots de passe ne correspondent pas.');
  }
  const btn = $('#authBtn'), label = btn.textContent;
  btn.disabled = true;
  btn.textContent = authMode === 'register' ? 'Génération de tes clés…' : 'Vérification…';
  authError('');
  try {
    const pre = await fetch('/api/prelogin?' + qs({ name })).then(r => r.json());
    let session;
    if (authMode === 'register') {
      if (pre.exists) throw new Error('Ce pseudo est déjà pris.');
      const kdfSalt = E2E.randomB64(16);
      const { authKey, encKey } = await E2E.deriveFromPassword(pw, kdfSalt);
      const id = await E2E.createIdentity(encKey);
      const r = await postJson('/api/register', { name, code: $('#loginCode').value, kdfSalt, authKey, pub: id.pub, encPriv: id.encPriv });
      session = { name, token: r.token, priv: id.priv, pub: id.pub };
    } else {
      if (!pre.exists) throw new Error('Pseudo ou mot de passe incorrect');
      const { authKey, encKey } = await E2E.deriveFromPassword(pw, pre.kdfSalt);
      const r = await postJson('/api/login', { name, authKey });
      session = { name, token: r.token, priv: await E2E.openIdentity(encKey, r.encPriv), pub: r.pub };
    }
    try { await E2E.saveSession(session); } catch {} // navigation privée : il faudra se reconnecter au rechargement
    store.set('lanchat:account', name);
    $('#loginPass').value = ''; $('#loginPass2').value = '';
    $('#loginModal').hidden = true;
    begin(session);
  } catch (err) { authError(err.message || 'Échec de la connexion'); }
  finally { btn.disabled = false; btn.textContent = label; }
};
function begin(s) {
  Object.assign(state, { me: s.name, token: s.token, priv: s.priv, pub: s.pub });
  $('#meName').textContent = state.me;
  const av = $('#meAvatar');
  av.style.background = colorOf(state.me);
  av.innerHTML = `${initial(state.me)}<span class="pres on"></span>`;
  state.dms = new Set();
  closeThread();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  connect();
}
let loggingOut = false;
async function logout(reason) {
  if (loggingOut) return;
  loggingOut = true;
  es?.close();
  try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token } }); } catch {}
  await E2E.clearSession();
  try { if (reason) sessionStorage.setItem('lanchat:flash', reason); } catch {}
  location.reload();
}
$('#logoutBtn').onclick = () => { if (confirm('Se déconnecter de LAN Chat sur ce navigateur ?')) logout(); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.view === 'channel') {
    state.unread[state.current] = 0;
    const last = state.cache[state.current]?.messages.at(-1);
    if (last) markRead(state.current, last.id);
  }
  if (state.thread) state.threadUnread.delete(state.thread.id);
  renderSidebar();
});

(async () => {
  // WebCrypto n'existe qu'en HTTPS (ou sur localhost) : sans lui, pas de chiffrement possible
  if (!E2E.available()) {
    $('#httpsLink').href = 'https://' + location.host + location.pathname;
    $('#insecure').hidden = false;
    return;
  }
  const s = await E2E.loadSession();
  if (s && s.token && s.priv) return begin(s);
  const account = store.get('lanchat:account'), oldPseudo = store.get('lanchat:user');
  $('#loginName').value = account || oldPseudo || '';
  updatePreview();
  setAuthMode(account || !oldPseudo ? 'login' : 'register'); // ancien utilisateur sans compte : on lui propose d'en créer un
  let flash = null;
  try { flash = sessionStorage.getItem('lanchat:flash'); sessionStorage.removeItem('lanchat:flash'); } catch {}
  if (flash) authError(flash);
  $('#loginModal').hidden = false;
  ($('#loginName').value ? $('#loginPass') : $('#loginName')).focus();
})();
