// Actions sur les messages : réagir, répondre en fil, enregistrer, rappeler, épingler, transférer, modifier,
// supprimer, marquer non lu, copier le lien… et le lecteur des messages vocaux. Délégation sur toute la page.
import { $, $$, esc, icon, h, on, copyText, autosize } from '../lib/dom.js';
import { at, nextMonday, fmtFuture, fmtDur } from '../lib/format.js';
import { extractMentions } from '../lib/markdown.js';
import { state, bus, isDm, dmOther, label, nameOf, isAdmin, people } from '../core/state.js';
import { post, patch, del } from '../core/api.js';
import { encryptFor, decryptMsg, fileUrl, fileMeta } from '../core/keys.js';
import { linkToMessage, openConvo } from '../core/router.js';
import { toast, menu, closeMenu, modal, confirmBox, busy } from './layer.js';
import { openPicker, addRecent } from './picker.js';
import { refreshMsg, POLL_KEYS } from './messages.js';
import { avatarHtml } from './avatar.js';
import { confetti } from './fx.js';
import { openThread } from './thread.js';
import { openProfile } from './profile.js';
import { Call } from '../rtc/call.js';
import { Huddle } from '../rtc/huddle.js';

export async function react(m, emoji) {
  try { await post(`/api/messages/${m.id}/react`, { emoji }); }
  catch (e) { toast(e.message); }
  if (emoji === '🎉' && !(m.reactions?.[emoji] || []).includes(state.me)) confetti();
}

export async function toggleSave(m, remindAt) {
  const saved = state.saved.has(m.id);
  try {
    if (saved && !remindAt) { await post(`/api/messages/${m.id}/save`, { on: false }); toast('Retiré de Plus tard'); }
    else {
      await post(`/api/messages/${m.id}/save`, { on: true, remindAt: remindAt || null });
      toast(remindAt ? `Rappel ${fmtFuture(remindAt)}` : 'Enregistré dans Plus tard', { action: 'Voir', onAction: () => { location.hash = '#/later'; } });
    }
  } catch (e) { toast(e.message); }
}
export const remindChoices = () => [
  { label: 'Dans 20 minutes', run: () => Date.now() + 20 * 60e3 },
  { label: 'Dans 1 heure', run: () => Date.now() + 3600e3 },
  { label: 'Dans 3 heures', run: () => Date.now() + 3 * 3600e3 },
  { label: 'Demain', hint: '9:00', run: () => at(9, 1) },
  { label: 'Lundi prochain', hint: '9:00', run: () => nextMonday(9) },
];
// Date et heure au choix
export function pickDateTime({ title, ok = 'Valider', initial = at(9, 1) }) {
  return new Promise(resolve => {
    const d = new Date(initial);
    const pad = n => String(n).padStart(2, '0');
    const m = modal({
      title,
      body: `<div class="when-grid"><label class="field"><span>Date</span><input type="date" value="${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}" required></label>
        <label class="field"><span>Heure</span><input type="time" value="${pad(d.getHours())}:${pad(d.getMinutes())}" required></label></div>`,
      foot: `<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>${esc(ok)}</button>`,
      onClose: () => resolve(null),
    });
    m.el.querySelector('[data-ok]').onclick = () => {
      const [date, time] = $$('input', m.el).map(i => i.value);
      const ts = new Date(`${date}T${time}`).getTime();
      if (!(ts > Date.now())) return toast('Choisis un moment dans le futur');
      resolve(ts); m.close();
    };
  });
}

async function togglePin(m) {
  try {
    await post(`/api/messages/${m.id}/pin`, { on: !m.pinned });
    toast(m.pinned ? 'Message désépinglé' : `Épinglé dans ${label(m.channel)}`);
  } catch (e) { toast(e.message); }
}
async function markUnread(m) {
  try {
    await post('/api/read', { key: m.channel, id: m.id - 1, force: true });
    toast('Marqué comme non lu à partir d’ici');
  } catch (e) { toast(e.message); }
}
export async function deleteMsg(m) {
  const root = !m.parent && m.thread;
  const ok = await confirmBox({
    title: 'Supprimer ce message ?',
    text: root ? `Les ${m.thread.count} réponses de son fil seront aussi supprimées. C’est définitif.` : 'C’est définitif.',
    ok: 'Supprimer', danger: true,
  });
  if (!ok) return;
  try { await del(`/api/messages/${m.id}`); } catch (e) { toast(e.message); }
}

// Transférer : le message est re-chiffré pour la conversation de destination, avec un commentaire facultatif
export function forward(m) {
  const targets = [
    ...[...state.channels.values()].filter(c => c.members.includes(state.me) && !c.archived).map(c => ({ ch: c.name, html: `<span class="s-ic">${icon(c.private ? 'lock' : 'hash', 'sm')}</span><span>${esc(c.name)}</span>`, key: c.name })),
    { ch: '@' + [state.me, state.me].join('|'), html: `${avatarHtml(state.me)}<span>${esc(nameOf(state.me))} (toi)</span>`, key: 'moi ' + state.me },
    ...people().map(u => ({ ch: '@' + [state.me, u.name].sort().join('|'), html: `${avatarHtml(u.name)}<span>${esc(nameOf(u.name))}</span>`, key: u.name + ' ' + nameOf(u.name) })),
  ];
  const md = modal({
    title: 'Transférer le message',
    body: `<label class="field"><span>Vers</span><input class="fw-q" placeholder="Rechercher un canal ou une personne…" autocomplete="off"></label>
      <div class="pick-list fw-list" role="listbox"></div>
      <label class="field" style="margin-top:14px"><span>Ajouter un message <small>(facultatif)</small></span><textarea class="fw-text" rows="2"></textarea></label>`,
    foot: `<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok disabled>Transférer</button>`,
  });
  const list = $('.fw-list', md.el), q = $('.fw-q', md.el), ok = $('[data-ok]', md.el);
  let picked = null;
  const render = () => {
    const s = q.value.trim().toLowerCase();
    list.innerHTML = targets.filter(t => t.key.toLowerCase().includes(s)).slice(0, 40)
      .map(t => `<label class="sw-item${picked === t.ch ? ' sel' : ''}"><input type="radio" name="fw" value="${esc(t.ch)}" ${picked === t.ch ? 'checked' : ''} hidden>${t.html}</label>`).join('')
      || '<div class="pane-empty">Aucun résultat</div>';
  };
  render();
  q.addEventListener('input', render);
  list.addEventListener('change', e => { picked = e.target.value; ok.disabled = false; render(); });
  ok.onclick = () => busy(ok, async () => {
    try {
      const shared = { user: m.user, ts: m.ts, text: m.text || '', id: m.id, ch: m.channel, where: label(m.channel), file: m.file?.name || '' };
      const text = $('.fw-text', md.el).value;
      const enc = await encryptFor(picked, { text, shared });
      await post('/api/messages', { channel: picked, enc, mentions: extractMentions(text, n => state.users.has(n)) });
      md.close();
      toast(`Transféré dans ${label(picked)}`, { action: 'Ouvrir', onAction: () => openConvo(picked) });
    } catch (e) { toast(e.message); }
  });
}

// ---------- Modifier en place ----------
const inFence = ta => ((ta.value.slice(0, ta.selectionStart).match(/```/g) || []).length % 2) === 1;
export function startEdit(el) {
  const m = el._msg;
  if (!m || m.user !== state.me || m.call || m.poll) return;
  el.classList.add('editing');
  const body = $('.body', el);
  body.classList.remove('jumbo');
  body.innerHTML = `<div class="edit-box"><textarea rows="1" aria-label="Modifier le message"></textarea>
    <div class="edit-foot"><button type="button" class="btn sm" data-edit="cancel">Annuler</button><button type="button" class="btn sm primary" data-edit="save">Enregistrer</button></div></div>`;
  const ta = $('textarea', body);
  ta.value = m.text || '';
  autosize(ta); ta.addEventListener('input', () => autosize(ta));
  ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
  const cancel = () => { el.classList.remove('editing'); refreshMsg(m); };
  const save = async () => {
    const text = ta.value;
    if (text === (m.text || '')) return cancel();
    if (!text.trim() && !m.file && !m.shared) { cancel(); return deleteMsg(m); }
    try {
      const payload = { text };
      if (m.file?.e2e) payload.file = fileMeta(m.file);
      if (m.shared) payload.shared = m.shared;
      const enc = await encryptFor(m.channel, payload);
      const updated = await decryptMsg(await patch(`/api/messages/${m.id}`, { enc, mentions: extractMentions(text, n => state.users.has(n)) }));
      el.classList.remove('editing');
      bus.emit('message-updated', updated);
    } catch (e) { toast(e.message); }
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !inFence(ta)) { e.preventDefault(); save(); }
  });
  $('[data-edit="cancel"]', body).onclick = cancel;
  $('[data-edit="save"]', body).onclick = save;
}

// ---------- Menu « … » ----------
function moreMenu(btn, m, el) {
  const mine = m.user === state.me;
  const inList = !m.parent || m.broadcast;
  el.classList.add('menu-open');
  menu(btn, [
    { html: `<div class="quick-react">${['👍', '❤️', '😂', '🎉', '🙏', '🔥'].map(e => `<button type="button" data-qr="${e}" aria-label="Réagir ${e}">${e}</button>`).join('')}</div>` },
    inList && !mine ? { label: 'Marquer comme non lu', icon: 'mark-unread', run: () => markUnread(m) } : null,
    { label: 'Me le rappeler', icon: 'alarm', sub: () => [
      ...remindChoices().map(ch => ({ label: ch.label, hint: ch.hint, run: () => toggleSave(m, ch.run()) })),
      '-', { label: 'Choisir une date…', icon: 'clock', run: async () => { const ts = await pickDateTime({ title: 'Me le rappeler', ok: 'Programmer le rappel' }); if (ts) toggleSave(m, ts); } },
    ] },
    '-',
    { label: m.pinned ? 'Désépingler' : `Épingler ${isDm(m.channel) ? 'dans la conversation' : 'dans le canal'}`, icon: 'pin', run: () => togglePin(m) },
    { label: 'Copier le lien', icon: 'link', run: () => { copyText(linkToMessage(m.channel, m.parent && !m.broadcast ? m.parent : m.id)); toast('Lien copié'); } },
    m.text ? { label: 'Copier le texte', icon: 'copy', run: () => { copyText(m.text); toast('Texte copié'); } } : null,
    !m.call ? { label: 'Transférer…', icon: 'forward', run: () => forward(m) } : null,
    ...(mine && !m.call && !m.poll ? ['-', { label: 'Modifier', icon: 'edit', run: () => startEdit(el) }] : []),
    ...(mine || isAdmin() ? [mine && !m.call && !m.poll ? null : '-', { label: mine ? 'Supprimer' : 'Supprimer (modération)', icon: 'trash', danger: true, run: () => deleteMsg(m) }] : []),
  ], { align: 'end', onClose: () => el.classList.remove('menu-open') });
}
document.addEventListener('click', e => {
  const q = e.target.closest('[data-qr]');
  if (!q) return;
  const el = document.querySelector('.msg.menu-open');
  closeMenu();
  if (el?._msg) { addRecent(q.dataset.qr); react(el._msg, q.dataset.qr); }
});

// ---------- Délégation ----------
on(document, 'click', '.msg [data-act], .msg [data-quick], .msg .react[data-emoji], .msg [data-user], .msg [data-vote], .msg [data-voice]', async (e, t) => {
  const el = t.closest('.msg'), m = el?._msg;
  if (!m) return;
  if (t.dataset.user) { e.preventDefault(); return openProfile(t.dataset.user, t); }
  if (t.dataset.voice) return voiceAction(t, m, e);
  if (t.dataset.vote !== undefined) return react(m, POLL_KEYS[t.dataset.vote]);
  if (t.dataset.quick) { addRecent(t.dataset.quick); return react(m, t.dataset.quick); }
  if (t.dataset.emoji) { t.classList.add('bump'); return react(m, t.dataset.emoji); }
  switch (t.dataset.act) {
    case 'react': return openPicker(t, emoji => react(m, emoji));
    case 'thread': return openThread(m.id);
    case 'open-parent': e.preventDefault(); return openThread(m.parent, m.id);
    case 'save': return toggleSave(m);
    case 'edit': return startEdit(el);
    case 'more': return moreMenu(t, m, el);
    case 'callback': return Call.start(dmOther(m.channel));
    case 'copy-code': {
      copyText(t.closest('.codeblock').querySelector('code').textContent);
      const s = t.querySelector('span'); s.textContent = 'Copié'; setTimeout(() => { s.textContent = 'Copier'; }, 1500);
      return;
    }
    case 'zoom': {
      if (!t.src) return;
      const lb = h(`<div class="lightbox" role="dialog" aria-label="Image"><img src="${t.src}" alt=""></div>`);
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
      return;
    }
    case 'download': {
      e.preventDefault();
      try {
        const a = document.createElement('a');
        a.href = await fileUrl(m); a.download = m.file.name || 'fichier';
        document.body.appendChild(a); a.click(); a.remove();
      } catch (err) { toast(err.message); }
    }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelector('.lightbox')?.remove();
  // Éléments « bouton » qui ne sont pas des <button> (mentions dans le texte) : Entrée et Espace les activent
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"]:not(button)')) { e.preventDefault(); e.target.click(); }
});
// Clic droit sur un message : son menu d'actions (sauf sur un lien ou une sélection de texte)
document.addEventListener('contextmenu', e => {
  const el = e.target.closest('.msg');
  if (!el?._msg || el._opts?.card || e.target.closest('a,img,video,textarea') || String(getSelection())) return;
  e.preventDefault();
  moreMenu({ x: e.clientX, y: e.clientY, getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }, el._msg, el);
});
// Appui long sur mobile : même menu
let pressTimer;
document.addEventListener('touchstart', e => {
  const el = e.target.closest('.msg');
  if (!el?._msg || e.target.closest('button,a,textarea')) return;
  pressTimer = setTimeout(() => { navigator.vibrate?.(10); moreMenu(el, el._msg, el); }, 480);
}, { passive: true });
for (const t of ['touchend', 'touchmove', 'touchcancel']) document.addEventListener(t, () => clearTimeout(pressTimer), { passive: true });
on(document, 'click', '[data-huddle-join]', (e, b) => Huddle.join(b.dataset.huddleJoin));

// ---------- Lecteur des messages vocaux ----------
const SPEEDS = [1, 1.5, 2];
const voiceTotal = audio => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(audio.closest('.voice').dataset.duration) / 1000) || 0;
async function voiceAction(t, m, e) {
  const box = t.closest('.voice'), audio = $('audio', box);
  if (!audio.src) { try { audio.src = await fileUrl(m); } catch (err) { return toast(err.message); } }
  if (t.dataset.voice === 'play') return audio.paused ? audio.play().catch(() => toast('Lecture impossible')) : audio.pause();
  if (t.dataset.voice === 'speed') {
    const next = SPEEDS[(SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length] || 1;
    audio.playbackRate = next;
    t.textContent = `${next}×`.replace('.', ',');
    return;
  }
  if (t.dataset.voice === 'seek') {
    const r = t.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const go = () => { audio.currentTime = ratio * voiceTotal(audio); if (audio.paused) audio.play().catch(() => {}); };
    if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
  }
}
// Les événements média ne remontent pas : on les capture au niveau du document.
const voiceOf = e => (e.target instanceof HTMLAudioElement ? e.target.closest('.voice') : null);
document.addEventListener('play', e => {
  const box = voiceOf(e); if (!box) return;
  $$('.voice audio').forEach(a => { if (a !== e.target && !a.paused) a.pause(); }); // un seul à la fois
  $('.voice-play', box).innerHTML = icon('pause');
  $('.voice-play', box).setAttribute('aria-label', 'Pause');
}, true);
for (const type of ['pause', 'ended']) {
  document.addEventListener(type, e => {
    const box = voiceOf(e); if (!box) return;
    $('.voice-play', box).innerHTML = icon('play');
    $('.voice-play', box).setAttribute('aria-label', 'Lire le message vocal');
    if (type === 'ended') { e.target.currentTime = 0; box.style.setProperty('--p', '0%'); $('.voice-time', box).textContent = fmtDur(Number(box.dataset.duration)); }
  }, true);
}
document.addEventListener('timeupdate', e => {
  const box = voiceOf(e); if (!box) return;
  const total = voiceTotal(e.target);
  box.style.setProperty('--p', `${total ? Math.min(100, e.target.currentTime / total * 100) : 0}%`);
  if (!e.target.paused) $('.voice-time', box).textContent = fmtDur(e.target.currentTime * 1000);
}, true);
// Les enregistrements WebM de Chrome n'annoncent pas leur durée : on force son calcul pour pouvoir se déplacer.
document.addEventListener('loadedmetadata', e => {
  const a = e.target;
  if (!voiceOf(e) || Number.isFinite(a.duration)) return;
  const back = () => { a.removeEventListener('timeupdate', back); a.currentTime = 0; };
  a.addEventListener('timeupdate', back);
  a.currentTime = 1e101;
}, true);

