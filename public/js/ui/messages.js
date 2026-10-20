// Rendu des messages : en-tête (auteur, heure, statut), corps (texte, fichier, vocal, sondage, message transféré,
// trace d'appel), réactions, résumé de fil, barre d'actions au survol. Les listes sont groupées par jour.
import { esc, icon, h, $$ } from '../lib/dom.js';
import { renderText, isEmojiOnly } from '../lib/markdown.js';
import { fmtTime, fmtFull, fmtDay, fmtWhen, fmtSize, fmtDur, fmtCallDur, sameDay, plural } from '../lib/format.js';
import { state, isDm, isSelf, dmOther, nameOf, statusOf, label, mentionsMe, channel } from '../core/state.js';
import { fileUrl } from '../core/keys.js';
import { avatarHtml } from './avatar.js';
import { recentEmoji } from './picker.js';

export const POLL_KEYS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ---------- Morceaux ----------
const FILE_COLORS = [
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'], '#7e4fc2'],
  [['pdf'], '#c8382a'],
  [['zip', 'rar', '7z', 'gz', 'tar'], '#a8740a'],
  [['xls', 'xlsx', 'csv', 'ods'], '#1d8a52'],
  [['doc', 'docx', 'odt', 'txt', 'md', 'rtf'], '#2563c9'],
  [['ppt', 'pptx', 'key', 'odp'], '#d0601b'],
  [['mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'mov'], '#b83b85'],
  [['js', 'ts', 'php', 'py', 'java', 'dart', 'json', 'sql', 'html', 'css', 'vue', 'sh', 'go', 'rs', 'c', 'cpp'], '#3d4f9e'],
];
export const extOf = name => (name || '').includes('.') ? name.split('.').pop().toLowerCase() : '';
export function fileHtml(f) {
  const name = f.name || 'fichier';
  const ext = extOf(name);
  const color = (FILE_COLORS.find(([exts]) => exts.includes(ext)) || [0, '#66706b'])[1];
  if (f.voice) return voiceHtml(f);
  const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext), isVideo = ['mp4', 'webm', 'mov'].includes(ext);
  const preview = isImg ? `<div class="preview"><img data-encfile alt="${esc(name)}" data-act="zoom"></div>`
    : isVideo ? `<div class="preview"><video data-encfile controls preload="metadata"></video></div>` : '';
  return `${preview}<a class="file" href="#" data-act="download" style="--fc:${color}">
    <span class="tile">${esc(ext.slice(0, 4) || 'fic')}</span>
    <span class="finfo"><span class="fname">${esc(name)}</span><small>${fmtSize(f.size || 0)}${f.e2e ? ' · chiffré' : ''}</small></span>
    <span class="dl">${icon('download')}</span></a>`;
}
function voiceHtml(f) {
  const peaks = f.voice.peaks?.length ? f.voice.peaks : Array(40).fill(30);
  const bars = peaks.map(p => `<i style="height:${Math.max(12, Math.min(100, p))}%"></i>`).join('');
  return `<div class="voice" data-duration="${Number(f.voice.duration) || 0}">
    <button type="button" class="voice-play" data-voice="play" aria-label="Lire le message vocal">${icon('play')}</button>
    <div class="voice-wave" data-voice="seek"><div class="vw">${bars}</div><div class="vw vw-fill">${bars}</div></div>
    <span class="voice-time">${fmtDur(f.voice.duration)}</span>
    <button type="button" class="voice-speed" data-voice="speed" aria-label="Vitesse de lecture">1×</button>
    <a class="voice-dl" href="#" data-act="download" aria-label="Télécharger">${icon('download')}</a>
    <audio data-encfile preload="none"></audio>
  </div>`;
}
function callHtml(m) {
  const c = m.call, mine = m.user === state.me;
  if (c.kind === 'group') {
    const room = c.status === 'started' && state.rooms[m.channel];
    const live = room && !room.members.some(x => x.user === state.me);
    const text = c.status === 'started' ? `${mine ? 'Tu as démarré' : 'A démarré'} un appel de groupe` : `Appel de groupe terminé · ${fmtCallDur(c.duration || 0)}`;
    return `<div class="call-log">${icon('headphones')}<span>${esc(text)}</span>${live ? `<button type="button" class="btn sm primary" data-huddle-join="${esc(m.channel)}">Rejoindre</button>` : ''}</div>`;
  }
  const text = {
    ended: `Appel audio · ${fmtCallDur(c.duration || 0)}`,
    missed: mine ? 'Appel sans réponse' : 'Appel manqué',
    declined: 'Appel refusé',
    busy: mine ? 'Ton correspondant était déjà en ligne' : 'Appel manqué (tu étais déjà en ligne)',
    failed: 'Appel interrompu : connexion impossible',
  }[c.status] || 'Appel audio';
  const bad = c.status !== 'ended';
  return `<div class="call-log${bad ? ' missed' : ''}">${icon(bad ? 'phone-off' : 'phone')}<span>${esc(text)}</span>
    ${isDm(m.channel) && !isSelf(m.channel) ? `<button type="button" class="btn sm" data-act="callback">Rappeler</button>` : ''}</div>`;
}
function pollHtml(m) {
  const votes = m.reactions || {};
  const opts = m.poll.options || [];
  const total = new Set(opts.flatMap((_, i) => votes[POLL_KEYS[i]] || [])).size;
  const max = Math.max(1, ...opts.map((_, i) => (votes[POLL_KEYS[i]] || []).length));
  return `<div class="poll"><h4>${esc(m.poll.question)}</h4>${opts.map((o, i) => {
    const who = votes[POLL_KEYS[i]] || [];
    return `<button type="button" class="poll-opt${who.includes(state.me) ? ' mine' : ''}" data-vote="${i}" style="--w:${(who.length / max) * 100}%" title="${esc(who.map(nameOf).join(', ') || 'Aucun vote')}">
      <span class="po-label">${esc(o)}</span><span class="po-count">${who.length}</span></button>`;
  }).join('')}<div class="poll-foot">${total ? plural(total, 'personne a voté', 'personnes ont voté') : 'Personne n’a encore voté'} · Clique pour voter ou retirer ton vote</div></div>`;
}
function sharedHtml(s) {
  const reachable = s.ch && (isDm(s.ch) ? s.ch.slice(1).split('|').includes(state.me) : channel(s.ch));
  return `<div class="shared"><div class="shared-head">${avatarHtml(s.user)}<b>${esc(nameOf(s.user))}</b></div>
    <div class="body">${renderText(s.text || '')}${s.file ? `<div class="shared-foot">${icon('clip', 'xs')} ${esc(s.file)}</div>` : ''}</div>
    <div class="shared-foot">${reachable ? `<a href="#/c/${encodeURIComponent(s.ch)}/${s.id}">${esc(s.where || '')}</a>` : esc(s.where || '')} · ${esc(fmtDay(s.ts))} à ${fmtTime(s.ts)}</div></div>`;
}
function bodyHtml(m) {
  if (m.call) return callHtml(m);
  if (m.locked) return `<p class="locked">${icon('lock', 'sm')} Message chiffré : la clé n’est pas encore arrivée sur ce poste.</p>`;
  let html = m.text ? renderText(m.text) : '';
  if (m.edited) {
    const tag = `<span class="edited" title="Modifié ${esc(fmtFull(m.edited))}">(modifié)</span>`;
    html = html.endsWith('</p>') ? html.slice(0, -4) + tag + '</p>' : html + tag;
  }
  if (m.poll) html += pollHtml(m);
  if (m.shared) html += sharedHtml(m.shared);
  if (m.file) html += fileHtml(m.file);
  return html;
}
function reactionsHtml(m) {
  const list = Object.entries(m.reactions || {}).filter(([e]) => !(m.poll && POLL_KEYS.includes(e)));
  if (!list.length) return '';
  return `<div class="reactions">${list.map(([e, users]) => {
    const names = users.map(u => u === state.me ? 'toi' : nameOf(u));
    const who = names.length > 4 ? `${names.slice(0, 4).join(', ')} et ${names.length - 4} autre(s)` : names.join(', ');
    return `<button type="button" class="react${users.includes(state.me) ? ' mine' : ''}" data-emoji="${esc(e)}" title="${esc(who)} : ${esc(e)}" aria-label="${esc(e)}, ${users.length}, ${esc(who)}">${esc(e)}<span>${users.length}</span></button>`;
  }).join('')}<button type="button" class="react add" data-act="react" aria-label="Ajouter une réaction">${icon('smile-plus', 'sm')}</button></div>`;
}
function threadSumHtml(m) {
  const t = m.thread;
  if (!t) return '';
  const unread = state.threadUnread.has(m.id);
  return `<button type="button" class="thread-sum${unread ? ' unread' : ''}" data-act="thread"><span class="avs">${t.users.map(u => avatarHtml(u)).join('')}</span>
    <b>${plural(t.count, 'réponse', 'réponses')}</b><span class="last">Dernière réponse ${fmtWhen(t.lastTs)}</span><span class="go">${icon('chev-right', 'sm')}</span></button>`;
}
function actionsHtml(m, opts) {
  const mine = m.user === state.me;
  const quick = recentEmoji(2, ['✅', '👀']);
  const saved = state.saved.has(m.id);
  return `<div class="actions" role="toolbar" aria-label="Actions sur le message">
    ${quick.map(e => `<button type="button" data-quick="${e}" title="Réagir ${e}" aria-label="Réagir ${e}">${e}</button>`).join('')}
    <button type="button" data-act="react" title="Ajouter une réaction" aria-label="Ajouter une réaction">${icon('smile-plus')}</button>
    ${!opts.inThread && !m.parent ? `<button type="button" data-act="thread" title="Répondre dans un fil" aria-label="Répondre dans un fil">${icon('thread')}</button>` : ''}
    <button type="button" data-act="save" class="${saved ? 'on' : ''}" title="${saved ? 'Retirer de Plus tard' : 'Enregistrer pour plus tard'}" aria-label="${saved ? 'Retirer de Plus tard' : 'Enregistrer pour plus tard'}">${icon(saved ? 'bookmark-on' : 'bookmark')}</button>
    ${mine && !m.call && !m.poll ? `<button type="button" data-act="edit" title="Modifier" aria-label="Modifier">${icon('edit')}</button>` : ''}
    <button type="button" data-act="more" title="Plus d’actions" aria-label="Plus d’actions" aria-haspopup="menu">${icon('more')}</button>
  </div>`;
}

// ---------- Un message ----------
// opts : { inThread, isParent, animate, card }
export function renderMessage(m, prev, opts = {}) {
  const cont = !opts.card && prev && prev.user === m.user && m.ts - prev.ts < 5 * 60e3 && sameDay(prev.ts, m.ts)
    && !m.broadcast && !opts.isParent && !prev.call && !m.call && !m.pinned && !prev.shared;
  const st = statusOf(m.user);
  const el = document.createElement('div');
  el.className = 'msg' + (cont ? ' cont' : '') + (mentionsMe(m) && !isDm(m.channel) ? ' mentioned' : '') + (m.pinned ? ' pinned' : '')
    + (opts.animate ? ' new' : '') + (!opts.inThread && state.thread?.id === m.id ? ' selected' : '');
  el.dataset.id = m.id;
  el.setAttribute('role', 'article');
  const jumbo = isEmojiOnly(m.text) && !m.file && !m.poll && !m.shared;
  el.innerHTML = `
    ${cont ? `<div class="gutter" title="${esc(fmtFull(m.ts))}">${fmtTime(m.ts)}</div>` : avatarHtml(m.user, { attrs: ` data-user="${esc(m.user)}"` })}
    <div class="content">
      ${cont ? '' : `<div class="meta"><button type="button" class="who" data-user="${esc(m.user)}">${esc(nameOf(m.user))}</button>${st?.emoji ? `<span class="st" title="${esc(st.text || '')}">${st.emoji}</span>` : ''}${m.legacy ? '<span class="tag warn" title="Envoyé avant l’activation du chiffrement">non chiffré</span>' : ''}<time datetime="${new Date(m.ts).toISOString()}" title="${esc(fmtFull(m.ts))}">${fmtTime(m.ts)}</time></div>`}
      ${m.pinned ? `<div class="pin-note">${icon('pin')}Épinglé par ${m.pinned.by === state.me ? 'toi' : esc(nameOf(m.pinned.by))}</div>` : ''}
      ${m.broadcast && !opts.inThread ? `<div class="bc-label">a répondu dans <a href="#" data-act="open-parent">un fil</a></div>` : ''}
      <div class="body${jumbo ? ' jumbo' : ''}">${bodyHtml(m)}</div>
      ${reactionsHtml(m)}
      ${!opts.inThread && !opts.card ? threadSumHtml(m) : ''}
    </div>
    ${opts.card ? '' : actionsHtml(m, opts)}`;
  el._msg = m; el._prev = prev; el._opts = opts;
  return el;
}

// Remplace un message à l'écran (partout où il est affiché) après une modification ou une réaction.
export function refreshMsg(m) {
  $$(`.msg[data-id="${m.id}"]`).forEach(el => {
    if (el.classList.contains('editing')) return;
    const n = renderMessage(m, el._prev, { ...el._opts, animate: false });
    if (el.classList.contains('menu-open')) n.classList.add('menu-open');
    el.replaceWith(n);
  });
}

// ---------- Listes groupées par jour ----------
const dayGroup = ts => h(`<section class="dgroup" data-day="${new Date(ts).toDateString()}"><div class="day"><span>${esc(fmtDay(ts))}</span></div></section>`);
// opts : { readMark, inThread }
export function renderList(box, messages, opts = {}) {
  const frag = document.createDocumentFragment();
  let group = null, prev = null, unreadEl = null;
  for (const m of messages) {
    if (!group || !sameDay(prev.ts, m.ts)) { group = dayGroup(m.ts); frag.appendChild(group); prev = null; }
    if (!unreadEl && opts.readMark != null && m.id > opts.readMark && m.user !== state.me) {
      unreadEl = h('<div class="new-line" role="separator"><span>Nouveaux</span></div>');
      group.appendChild(unreadEl);
      prev = null; // le premier message non lu affiche toujours son en-tête
    }
    group.appendChild(renderMessage(m, prev, { inThread: opts.inThread }));
    prev = m;
  }
  box.appendChild(frag);
  return unreadEl;
}
export function appendToList(box, m, prev, opts = {}) {
  let group = [...box.querySelectorAll(':scope > .dgroup')].at(-1);
  if (!group || !prev || !sameDay(prev.ts, m.ts)) { group = dayGroup(m.ts); box.insertBefore(group, box.querySelector(':scope > .msgs-end')); prev = null; }
  const el = renderMessage(m, prev, { ...opts, animate: true });
  group.appendChild(el);
  return el;
}

// ---------- Fichiers chiffrés : chargés quand ils approchent de l'écran ----------
const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    const m = e.target.closest('.msg')?._msg;
    if (m?.file) fileUrl(m).then(url => { e.target.src = url; }).catch(() => {});
  }
}, { rootMargin: '400px 0px' });
new MutationObserver(() => {
  document.querySelectorAll('img[data-encfile]:not([data-seen]),video[data-encfile]:not([data-seen])').forEach(el => { el.dataset.seen = '1'; io.observe(el); });
}).observe(document.body, { childList: true, subtree: true });

// Où se trouve un message (pour les en-têtes de listes : activité, recherche…)
export const whereOf = m => `${label(m.channel)}${m.parent ? ' · dans un fil' : ''}`;
export { dmOther };
