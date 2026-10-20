// Zone de saisie (réutilisée pour le canal et le fil) : mise en forme, autocomplétion (@ # : /), commandes,
// brouillons par conversation, envoi programmé, fichiers chiffrés, messages vocaux.
import { $, esc, icon, h, autosize, modKey } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { fmtDur, fmtFuture, fmtSize, at, nextMonday } from '../lib/format.js';
import { extractMentions } from '../lib/markdown.js';
import { EMOJIS } from '../lib/emoji-data.js';
import { E2E } from '../lib/e2e.js';
import { state, bus, isDm, nameOf, people, channel, isOnline } from '../core/state.js';
import { api, post, upload } from '../core/api.js';
import { keyFor, ensureChannelKey, encryptFor, waitForKey } from '../core/keys.js';
import { toast, menu, modal } from './layer.js';
import { openPicker, closePicker, pickerOpen, addRecent } from './picker.js';
import { avatarHtml } from './avatar.js';
import { pickDateTime, startEdit } from './actions.js';
import { confetti } from './fx.js';

// ---------- Brouillons (gardés dans ce navigateur) ----------
// "conversation|parent" -> { text, ts }
export const drafts = {
  all: () => store.json('drafts', {}),
  get: key => drafts.all()[key]?.text || '',
  set(key, text) {
    const all = drafts.all();
    if (text.trim()) all[key] = { text, ts: Date.now() }; else delete all[key];
    store.setJson('drafts', all);
    clearTimeout(drafts.timer); // différé : ne pas redessiner la barre latérale au milieu d'un clic
    drafts.timer = setTimeout(() => bus.emit('drafts'), 350);
  },
};
const draftKey = t => `${t.channel}|${t.parent || 0}`;

// ---------- Commandes ----------
const COMMANDS = [
  { name: 'poll', args: '"Question" "Choix 1" "Choix 2"', desc: 'Créer un sondage' },
  { name: 'code', args: 'texte', desc: 'Envoyer comme bloc de code', run: a => '```\n' + a + '\n```' },
  { name: 'shrug', args: '', desc: 'Ajoute ¯\\_(ツ)_/¯', run: a => `${a} ¯\\_(ツ)_/¯`.trim() },
  { name: 'flip', args: '', desc: 'Renverse la table', run: a => `${a} (╯°□°)╯︵ ┻━┻`.trim() },
  { name: 'unflip', args: '', desc: 'Remet la table en place', run: a => `${a} ┬─┬ノ( º _ ºノ)`.trim() },
  { name: 'party', args: 'texte', desc: 'Confettis pour tout le monde', run: a => `🎉 ${a || 'C’est la fête !'} 🎉` },
  { name: 'away', args: '', desc: 'Basculer absent / disponible', local: async () => { const away = !state.users.get(state.me)?.away; await api('/api/me', { method: 'PATCH', body: { away } }); toast(away ? 'Tu apparais absent' : 'Tu apparais disponible'); } },
];
const parseArgs = s => [...s.matchAll(/"([^"]+)"|“([^”]+)”|«\s*([^»]+?)\s*»|(\S+)/g)].map(m => (m[1] || m[2] || m[3] || m[4]).trim()).filter(Boolean);

// Réduit les niveaux sonores relevés pendant l'enregistrement à n barres (0-100) pour la forme d'onde.
function downsample(levels, n) {
  if (!levels.length) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * levels.length / n), b = Math.max(Math.floor((i + 1) * levels.length / n), a + 1);
    const slice = levels.slice(a, b);
    out.push(slice.reduce((x, y) => x + y, 0) / slice.length);
  }
  const max = Math.max(...out) || 1;
  return out.map(v => Math.round(v / max * 100));
}
const inFence = ta => ((ta.value.slice(0, ta.selectionStart).match(/```/g) || []).length % 2) === 1;

const TEMPLATE = `
  <div class="composer">
    <div class="ac" hidden role="listbox"></div>
    <div class="c-uploads"></div>
    <div class="rec" hidden>
      <button type="button" class="icon-btn" data-rec="cancel" aria-label="Annuler l’enregistrement">${icon('trash')}</button>
      <span class="rec-dot"></span><span class="rec-time">0:00</span><div class="rec-bars"></div>
      <button type="button" class="btn sm primary" data-rec="send">${icon('send', 'sm')}Envoyer</button>
    </div>
    <textarea rows="1" aria-label="Message"></textarea>
    <div class="c-tools">
      <button type="button" class="icon-btn" data-tool="attach" title="Joindre un fichier" aria-label="Joindre un fichier">${icon('plus')}</button>
      <span class="sep"></span>
      <span class="c-fmt" style="display:contents">
        <button type="button" class="icon-btn" data-wrap="*" title="Gras (${modKey}+B)" aria-label="Gras">${icon('bold')}</button>
        <button type="button" class="icon-btn" data-wrap="_" title="Italique (${modKey}+I)" aria-label="Italique">${icon('italic')}</button>
        <button type="button" class="icon-btn" data-wrap="~" title="Barré" aria-label="Barré">${icon('strike')}</button>
        <button type="button" class="icon-btn" data-tool="link" title="Lien (${modKey}+K dans une sélection)" aria-label="Lien">${icon('link')}</button>
        <button type="button" class="icon-btn" data-tool="list" title="Liste" aria-label="Liste">${icon('list')}</button>
        <button type="button" class="icon-btn" data-wrap="\`" title="Code" aria-label="Code">${icon('code')}</button>
        <button type="button" class="icon-btn" data-tool="codeblock" title="Bloc de code" aria-label="Bloc de code">${icon('codeblock')}</button>
        <span class="sep"></span>
      </span>
      <button type="button" class="icon-btn" data-tool="emoji" title="Emoji" aria-label="Emoji">${icon('smile')}</button>
      <button type="button" class="icon-btn" data-tool="mention" title="Mentionner quelqu’un" aria-label="Mentionner">${icon('at')}</button>
      <button type="button" class="icon-btn" data-tool="voice" title="Message vocal" aria-label="Enregistrer un message vocal">${icon('mic')}</button>
      <span class="spacer"></span>
      <label class="c-bc" hidden><input type="checkbox"><span></span></label>
      <div class="c-send">
        <button type="button" class="c-go" aria-label="Envoyer">${icon('send')}</button>
        <button type="button" class="c-later" aria-label="Programmer l’envoi" title="Programmer l’envoi" aria-haspopup="menu">${icon('chev-down', 'xs')}</button>
      </div>
    </div>
    <input type="file" multiple hidden>
  </div>
  <div class="c-under"><span class="c-typing" aria-live="polite"></span>
    <span class="c-hint"><kbd>Entrée</kbd> envoyer · <kbd>Maj</kbd> <kbd>Entrée</kbd> à la ligne</span></div>`;

// opts : { target: () => ({ channel, parent }), lastOwn: () => message, scope: '#msgs', thread: bool }
export function makeComposer(host, opts) {
  host.innerHTML = TEMPLATE;
  const root = $('.composer', host);
  const ta = $('textarea', root), sendBox = $('.c-send', root), fileInput = $('input[type=file]', root);
  const ac = $('.ac', root), ups = $('.c-uploads', root), bc = $('.c-bc', root), typingEl = $('.c-typing', host);
  if (opts.thread) { bc.hidden = false; $('.c-hint', host).remove(); }
  const c = { host, root, typingHtml: '', lastTypingPing: 0, ac: { items: [], sel: 0, range: null }, key: null };

  const refresh = () => { autosize(ta); sendBox.classList.toggle('ready', !!ta.value.trim()); };
  let draftTimer;
  const saveDraft = () => { clearTimeout(draftTimer); if (c.key) drafts.set(c.key, ta.value); };
  // Change de conversation : on range le brouillon de la précédente et on ressort celui de la nouvelle
  c.load = () => {
    if (c.key) drafts.set(c.key, ta.value);
    c.key = draftKey(opts.target());
    ta.value = drafts.get(c.key);
    refresh(); hideAc();
  };
  c.focus = () => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; };
  c.setPlaceholder = p => { ta.placeholder = p; ta.setAttribute('aria-label', p); };
  c.setBroadcastLabel = l => { $('span', bc).textContent = l; };
  c.setTyping = html => { if (c.typingHtml !== html) { c.typingHtml = html; typingEl.innerHTML = html; } };
  c.insert = (text, before = '', after = '') => {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const sel = v.slice(s, e) || text;
    ta.value = v.slice(0, s) + before + sel + after + v.slice(e);
    ta.focus();
    ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length;
    if (!before && !after) ta.selectionStart = ta.selectionEnd;
    refresh(); saveDraft();
  };

  // ---------- Autocomplétion : @mention, #canal, :emoji, /commande ----------
  function acQuery() {
    const before = ta.value.slice(0, ta.selectionStart);
    let m = before.match(/^\/(\w*)$/);
    if (m) return { kind: '/', q: m[1], start: 0 };
    m = before.match(/(^|[\s(])([@#:])([\w\-.À-ÿ+]*)$/);
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
      const ch = opts.target().channel;
      const c0 = channel(ch);
      const inConvo = u => isDm(ch) ? ch.includes(u) : c0?.members.includes(u);
      items = people().filter(u => u.name.toLowerCase().startsWith(q) || nameOf(u.name).toLowerCase().split(/\s+/).some(w => w.startsWith(q)))
        .sort((a, b) => inConvo(b.name) - inConvo(a.name)).slice(0, 7)
        .map(u => ({ html: `${avatarHtml(u.name, { presence: true })}<span><b>${esc(nameOf(u.name))}</b>${u.displayName ? ` <span style="color:var(--muted)">${esc(u.name)}</span>` : ''}</span>${!inConvo(u.name) && !isDm(ch) ? '<small>pas dans le canal</small>' : isOnline(u.name) ? '<small>en ligne</small>' : ''}`, value: '@' + u.name + ' ' }));
      if (!isDm(ch) && 'tous'.startsWith(q)) items.push({ html: `<span class="s-ic">${icon('users', 'sm')}</span><span><b>@tous</b></span><small>notifie tout le canal</small>`, value: '@tous ' });
    } else if (query.kind === '#') {
      title = 'Canaux';
      items = [...state.channels.values()].filter(x => !x.archived && x.name.startsWith(q)).slice(0, 7)
        .map(x => ({ html: `<span class="s-ic">${icon(x.private ? 'lock' : 'hash', 'sm')}</span><span><b>${esc(x.name)}</b></span>${x.topic ? `<small>${esc(x.topic.slice(0, 40))}</small>` : ''}`, value: '#' + x.name + ' ' }));
    } else if (query.kind === ':') {
      title = 'Emoji';
      items = EMOJIS.map(e => ({ e, k: e.kw.find(k => k.startsWith(q)) })).filter(x => x.k).slice(0, 8)
        .map(({ e, k }) => ({ html: `<span class="ac-emoji">${e.ch}</span><span>:${esc(k)}:</span>`, value: e.ch + ' ', emoji: e.ch }));
    } else {
      title = 'Commandes';
      items = COMMANDS.filter(cmd => cmd.name.startsWith(q)).map(cmd => ({ html: `<span><b>/${cmd.name}</b> <span style="color:var(--muted)">${esc(cmd.args)}</span></span><small>${esc(cmd.desc)}</small>`, value: '/' + cmd.name + ' ' }));
    }
    if (!items.length) return hideAc();
    c.ac = { items, sel: Math.min(c.ac.sel, items.length - 1), range: query };
    ac.innerHTML = `<div class="ac-title">${title}</div>` + items.map((it, i) => `<div class="ac-item${i === c.ac.sel ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${i === c.ac.sel}">${it.html}</div>`).join('');
    ac.hidden = false;
  }
  function hideAc() { ac.hidden = true; c.ac = { items: [], sel: 0, range: null }; }
  function pickAc(i) {
    const it = c.ac.items[i], r = c.ac.range;
    if (!it) return;
    if (it.emoji) addRecent(it.emoji);
    const v = ta.value, end = ta.selectionStart;
    ta.value = v.slice(0, r.start) + it.value + v.slice(end);
    ta.selectionStart = ta.selectionEnd = r.start + it.value.length;
    hideAc(); refresh(); saveDraft(); ta.focus();
  }
  ac.addEventListener('mousedown', e => { const item = e.target.closest('.ac-item'); if (item) { e.preventDefault(); pickAc(Number(item.dataset.i)); } });

  ta.addEventListener('input', () => {
    refresh(); updateAc();
    clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400);
    const now = Date.now();
    if (ta.value.trim() && now - c.lastTypingPing > 2500) {
      c.lastTypingPing = now;
      const { channel: ch, parent } = opts.target();
      post('/api/typing', { channel: ch, parent }).catch(() => {});
    }
  });
  ta.addEventListener('click', updateAc);
  ta.addEventListener('blur', () => { saveDraft(); setTimeout(hideAc, 150); });
  ta.addEventListener('keydown', e => {
    if (!ac.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); c.ac.sel = (c.ac.sel + 1) % c.ac.items.length; return updateAc(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); c.ac.sel = (c.ac.sel - 1 + c.ac.items.length) % c.ac.items.length; return updateAc(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickAc(c.ac.sel); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return hideAc(); }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); return c.insert('', '*', '*'); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); return c.insert('', '_', '_'); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); return c.insert('', '~', '~'); }
    if (mod && e.key.toLowerCase() === 'k' && ta.selectionStart !== ta.selectionEnd) { e.preventDefault(); e.stopPropagation(); return insertLink(); }
    if (e.key === 'ArrowUp' && !ta.value) {
      const m = opts.lastOwn();
      const el = m && document.querySelector(`${opts.scope} .msg[data-id="${m.id}"]`);
      if (el) { e.preventDefault(); startEdit(el); }
      return;
    }
    if (e.key === 'Escape' && !ta.value) return;
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || inFence(ta)) return;
    // Entrée dans une liste : nouvelle puce
    const line = ta.value.slice(0, ta.selectionStart).split('\n').pop();
    // Entrée sur une puce vide : on sort de la liste
    if (/^\s*([-*•]|\d+[.)])\s*$/.test(line) && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s - line.length) + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s - line.length;
      return refresh();
    }
    const bullet = line.match(/^(\s*)([-*•]|\d+[.)])\s+\S/);
    if (bullet && !mod) {
      e.preventDefault();
      const n = /\d/.test(bullet[2]) ? `${parseInt(bullet[2], 10) + 1}${bullet[2].slice(-1)}` : bullet[2];
      return c.insert(`\n${bullet[1]}${n} `);
    }
    e.preventDefault();
    send();
  });
  function insertLink() {
    const { selectionStart: s, selectionEnd: e2, value: v } = ta;
    const m = modal({
      title: 'Ajouter un lien',
      body: `<label class="field"><span>Texte</span><input class="l-text" value="${esc(v.slice(s, e2))}" placeholder="Le compte rendu de lundi"></label>
        <label class="field"><span>Adresse</span><input class="l-url" type="url" placeholder="https://…" inputmode="url" spellcheck="false"></label>`,
      foot: '<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Ajouter</button>',
      onClose: () => ta.focus(),
    });
    const ok = () => {
      const url = $('.l-url', m.el).value.trim(), text = $('.l-text', m.el).value.trim();
      if (!/^https?:\/\/\S+$/.test(url)) return toast('L’adresse doit commencer par https://');
      ta.value = v.slice(0, s) + (text ? `[${text}](${url})` : url) + v.slice(e2);
      m.close(); refresh(); saveDraft();
    };
    $('[data-ok]', m.el).onclick = ok;
    m.el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    if (v.slice(s, e2)) requestAnimationFrame(() => $('.l-url', m.el).focus());
  }

  // ---------- Envoi ----------
  // Transforme le texte saisi en contenu à chiffrer (commandes, sondage) ; null = rien à envoyer
  async function prepare(text) {
    const payload = {};
    const cmd = text.match(/^\/(\w+)(?:\s([\s\S]*))?$/);
    if (cmd) {
      const found = COMMANDS.find(x => x.name === cmd[1]);
      if (!found) { toast(`Commande inconnue : /${cmd[1]}`); return null; }
      const arg = (cmd[2] || '').trim();
      if (found.local) { await found.local(arg).catch(err => toast(err.message)); return false; }
      if (found.name === 'poll') {
        const [question, ...options] = parseArgs(arg);
        if (!question || options.length < 2) { toast('Exemple : /poll "On déjeune où ?" "Thiéboudienne" "Pizza"'); return null; }
        if (options.length > 10) { toast('10 choix au maximum'); return null; }
        payload.poll = { question, options };
        text = '';
      } else text = found.run(arg);
    }
    payload.text = text;
    return payload;
  }
  async function send(at = null) {
    const original = ta.value;
    if (!original.trim()) return;
    const { channel: ch, parent } = opts.target();
    const broadcast = opts.thread && $('input', bc).checked;
    // La zone se vide tout de suite (pas de double envoi) ; le texte revient si l'envoi échoue
    ta.value = ''; refresh(); hideAc(); drafts.set(c.key, '');
    const restore = () => { if (!ta.value) { ta.value = original; refresh(); saveDraft(); } };
    const payload = await prepare(original);
    if (payload === false) return;
    if (!payload) return restore();
    try {
      if (!isDm(ch)) await ensureChannelKey(ch).catch(() => {});
      const enc = await encryptFor(ch, payload);
      const mentions = extractMentions(payload.text, n => state.users.has(n));
      if (at) {
        await post('/api/scheduled', { channel: ch, parent, enc, mentions, at });
        toast(`Envoi programmé ${fmtFuture(at)}`, { action: 'Voir', onAction: () => { location.hash = '#/drafts'; } });
      } else {
        await post('/api/messages', { channel: ch, enc, parent, broadcast, mentions });
        if ((payload.text || '').includes('🎉')) confetti();
      }
      if (broadcast) $('input', bc).checked = false;
    } catch (e) { restore(); toast(e.message); }
  }
  $('.c-go', root).onclick = () => send();
  $('.c-later', root).onclick = e => {
    if (!ta.value.trim()) return toast('Écris d’abord ton message, puis choisis quand l’envoyer');
    menu(e.currentTarget, [
      { section: 'Programmer l’envoi' },
      { label: 'Demain', hint: '9:00', icon: 'clock', run: () => send(at(9, 1)) },
      { label: 'Lundi prochain', hint: '9:00', icon: 'clock', run: () => send(nextMonday(9)) },
      { label: 'Dans 1 heure', icon: 'clock', run: () => send(Date.now() + 3600e3) },
      '-',
      { label: 'Date et heure au choix…', icon: 'alarm', run: async () => { const ts = await pickDateTime({ title: 'Programmer l’envoi', ok: 'Programmer' }); if (ts) send(ts); } },
    ], { align: 'end' });
  };

  root.querySelectorAll('[data-wrap]').forEach(b => { b.onclick = () => c.insert('', b.dataset.wrap, b.dataset.wrap); });
  $('[data-tool="codeblock"]', root).onclick = () => c.insert('', '```\n', '\n```');
  $('[data-tool="link"]', root).onclick = insertLink;
  $('[data-tool="list"]', root).onclick = () => {
    const s = ta.selectionStart, start = ta.value.lastIndexOf('\n', s - 1) + 1;
    ta.value = ta.value.slice(0, start) + '- ' + ta.value.slice(start);
    ta.selectionStart = ta.selectionEnd = s + 2; ta.focus(); refresh();
  };
  $('[data-tool="mention"]', root).onclick = () => { c.insert(ta.value && !/\s$/.test(ta.value.slice(0, ta.selectionStart)) ? ' @' : '@'); updateAc(); };
  $('[data-tool="emoji"]', root).onclick = e => {
    if (pickerOpen()) return closePicker();
    openPicker(e.currentTarget, emoji => c.insert(emoji));
  };
  $('[data-tool="attach"]', root).onclick = () => fileInput.click();
  fileInput.onchange = () => { [...fileInput.files].forEach(f => c.upload(f)); fileInput.value = ''; };
  ta.addEventListener('paste', e => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); files.forEach(f => c.upload(f.name === 'image.png' ? new File([f], `capture-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`, { type: f.type }) : f)); }
  });

  // ---------- Fichiers : chiffrés dans le navigateur, envoyés, puis annoncés par un message chiffré ----------
  c.upload = async (file, extra = {}, fixedTarget = null) => {
    const { channel: ch, parent } = fixedTarget || opts.target();
    if (!isDm(ch)) await ensureChannelKey(ch).catch(() => {});
    await waitForKey(ch);
    const key = await keyFor(ch);
    if (!key) return toast('Clé de chiffrement indisponible pour cette conversation.');
    const row = h(`<div class="up">${icon('lock', 'sm')}<span class="uname">${esc(file.name)}</span><small>Chiffrement…</small><span class="bar"><i></i></span></div>`);
    ups.appendChild(row);
    try {
      const encrypted = await E2E.encryptFile(key, await file.arrayBuffer(), ch).catch(() => { throw new Error('Impossible de chiffrer ce fichier (trop gros pour le navigateur ?)'); });
      $('small', row).textContent = fmtSize(file.size);
      const { fileId } = await upload(encrypted.data, p => { $('.bar i', row).style.width = (p * 100) + '%'; });
      const enc = await encryptFor(ch, { text: '', file: { name: file.name, type: file.type, size: file.size, iv: encrypted.iv, ...extra } });
      await post('/api/messages', { channel: ch, parent, enc, fileId });
    } catch (e) { toast(e.message); }
    row.remove();
  };

  // ---------- Message vocal : 🎤 -> enregistrement (5 min max) -> Envoyer ou Annuler ----------
  const rec = $('.rec', root);
  let recording = null;
  $('[data-tool="voice"]', root).onclick = startRecording;
  $('[data-rec="cancel"]', rec).onclick = () => stopRecording(false);
  $('[data-rec="send"]', rec).onclick = () => stopRecording(true);
  document.addEventListener('keydown', e => { if (recording && e.key === 'Escape') { e.preventDefault(); stopRecording(false); } });
  async function startRecording() {
    if (recording) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('L’enregistrement audio n’est pas disponible dans ce navigateur.');
    const fixed = opts.target();
    if (!isDm(fixed.channel)) await ensureChannelKey(fixed.channel).catch(() => {});
    if (!(await keyFor(fixed.channel))) return toast('Clé de chiffrement indisponible pour cette conversation.');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { return toast('Accès au micro refusé : autorise-le via l’icône à gauche de l’adresse du site.'); }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = actx.createAnalyser();
    analyser.fftSize = 512;
    actx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const chunks = []; // le dernier morceau arrive APRÈS stop(), quand `recording` est déjà remis à null
    recording = { mr, stream, actx, chunks, levels: [], t0: Date.now(), target: fixed };
    mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    mr.start(250);
    root.classList.add('recording');
    rec.hidden = false;
    const bars = $('.rec-bars', rec);
    bars.innerHTML = '';
    $('.rec-time', rec).textContent = '0:00';
    recording.timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) { const x = (v - 128) / 128; sum += x * x; }
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      recording.levels.push(level);
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(8, level * 100)}%`;
      bars.appendChild(bar);
      while (bars.children.length > 90) bars.firstChild.remove();
      const elapsed = Date.now() - recording.t0;
      $('.rec-time', rec).textContent = fmtDur(elapsed);
      if (elapsed >= 5 * 60e3) stopRecording(true);
    }, 100);
  }
  function stopRecording(doSend) {
    const r = recording;
    if (!r) return;
    recording = null;
    clearInterval(r.timer);
    root.classList.remove('recording');
    rec.hidden = true;
    const duration = Date.now() - r.t0;
    r.mr.onstop = () => {
      r.stream.getTracks().forEach(t => t.stop());
      r.actx.close().catch(() => {});
      if (!doSend) return;
      if (duration < 700) return toast('Message vocal trop court');
      const type = (r.mr.mimeType || 'audio/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      c.upload(new File(r.chunks, `vocal-${stamp}.${ext}`, { type }), { voice: { duration, peaks: downsample(r.levels, 48) } }, r.target);
    };
    r.mr.stop();
  }
  return c;
}

// « est en train d'écrire » sous la zone de saisie
export function typingHtml(key) {
  const now = Date.now();
  const users = [...(state.typers.get(key) || new Map())].filter(([, exp]) => exp > now).map(([u]) => u);
  if (!users.length) return '';
  const who = users.length === 1 ? `<b>${esc(nameOf(users[0]))}</b> écrit` :
    users.length === 2 ? `<b>${esc(nameOf(users[0]))}</b> et <b>${esc(nameOf(users[1]))}</b> écrivent` : 'Plusieurs personnes écrivent';
  return `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${who}…</span>`;
}
