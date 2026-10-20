// Sélecteur rapide (⌘K / Ctrl+K) : aller à un canal, une personne, une vue. Sert aussi pour « Nouveau message ».
import { $, esc, icon, modKey } from '../lib/dom.js';
import { state, bus, dmId, nameOf, people, prefOf, isOnline } from '../core/state.js';
import { go, openConvo } from '../core/router.js';
import { modal } from './layer.js';
import { avatarHtml } from './avatar.js';

let current = null;
export function openSwitcher({ title = 'Aller à…', peopleOnly = false } = {}) {
  if (current) { current.close(); return; }
  const m = modal({
    cls: 'switcher', label: title,
    body: `<div class="sw-input">${icon('search')}<input placeholder="${esc(peopleOnly ? 'À qui veux-tu écrire ?' : 'Canal, personne ou page…')}" autocomplete="off" spellcheck="false" aria-label="${esc(title)}" role="combobox" aria-expanded="true"></div>
      <div class="sw-list" role="listbox"></div>
      <div class="sw-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> choisir</span><span><kbd>Entrée</kbd> ouvrir</span><span><kbd>Échap</kbd> fermer</span></div>`,
    onClose: () => { current = null; },
  });
  current = m;
  m.el.querySelector('.modal-body').style.padding = '0';
  const input = $('input', m.el), list = $('.sw-list', m.el);
  let sel = 0, items = [];
  const unread = ch => state.unread[ch]?.count || 0;
  const all = () => {
    const out = [];
    if (!peopleOnly) {
      out.push(
        { key: 'fils de discussion threads', html: `<span class="s-ic">${icon('thread')}</span><span>Fils de discussion</span>`, run: () => go({ view: 'threads' }) },
        { key: 'activite mentions activity', html: `<span class="s-ic">${icon('activity')}</span><span>Activité</span>`, run: () => go({ view: 'activity' }) },
        { key: 'plus tard enregistres later saved', html: `<span class="s-ic">${icon('bookmark')}</span><span>Plus tard</span>`, run: () => go({ view: 'later' }) },
        { key: 'brouillons envois programmes drafts', html: `<span class="s-ic">${icon('draft')}</span><span>Brouillons et envois</span>`, run: () => go({ view: 'drafts' }) },
        { key: 'parcourir canaux browse', html: `<span class="s-ic">${icon('hash')}</span><span>Parcourir les canaux</span>`, run: () => go({ view: 'browse' }) },
      );
      for (const c of state.channels.values()) {
        if (c.archived && !c.members.includes(state.me)) continue;
        out.push({ key: c.name + ' ' + (c.topic || ''), ch: c.name, html: `<span class="s-ic">${icon(c.private ? 'lock' : 'hash')}</span><span>${esc(c.name)}${c.topic ? ` <small>${esc(c.topic)}</small>` : ''}</span>${unread(c.name) ? `<small>${unread(c.name)} non lu${unread(c.name) > 1 ? 's' : ''}</small>` : c.members.includes(state.me) ? '' : '<small>pas membre</small>'}`, rank: prefOf(c.name).starred ? 2 : c.members.includes(state.me) ? 1 : 0 });
      }
    }
    out.push({ key: `${state.me} ${nameOf(state.me)} toi moi notes perso`, ch: dmId(state.me), html: `${avatarHtml(state.me)}<span>${esc(nameOf(state.me))} <small>toi · notes perso</small></span>` });
    for (const u of people()) {
      const ch = dmId(u.name);
      out.push({ key: `${u.name} ${nameOf(u.name)} ${u.title || ''}`, ch, html: `${avatarHtml(u.name, { presence: true })}<span>${esc(nameOf(u.name))}${u.title ? ` <small>${esc(u.title)}</small>` : ''}</span>${unread(ch) ? `<small>${unread(ch)} non lu${unread(ch) > 1 ? 's' : ''}</small>` : isOnline(u.name) ? '<small>en ligne</small>' : ''}`, rank: unread(ch) ? 2 : 1 });
    }
    return out;
  };
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const render = () => {
    const q = norm(input.value.trim());
    items = all().filter(i => !q || norm(i.key).split(/\s+/).some(w => w.startsWith(q)) || norm(i.key).includes(q))
      .sort((a, b) => (q ? 0 : (b.rank || 0) - (a.rank || 0)));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? items.slice(0, 60).map((it, i) => `<div class="sw-item${i === sel ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">${it.html}</div>`).join('')
      : '<div class="pane-empty">Aucun résultat</div>';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = it => { m.close(); if (it.run) it.run(); else openConvo(it.ch); $('#app').classList.add('in-convo'); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel]); }
  });
  list.addEventListener('click', e => { const it = e.target.closest('[data-i]'); if (it) pick(items[it.dataset.i]); });
  list.addEventListener('mousemove', e => { const it = e.target.closest('[data-i]'); if (it && Number(it.dataset.i) !== sel) { sel = Number(it.dataset.i); list.querySelectorAll('.sw-item').forEach((x, i) => x.classList.toggle('sel', i === sel)); } });
  render();
  input.focus();
}
bus.on('new-message', () => openSwitcher({ title: 'Nouveau message', peopleOnly: true }));
export const jumpHint = modKey === '⌘' ? '⌘K' : 'Ctrl K';
