// Sélecteur d'emoji, avec recherche en français et emoji récents.
import { $, h, esc } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { EMOJIS, EMOJI_CATS } from '../lib/emoji-data.js';
import { place } from './layer.js';

export const recents = () => store.json('recent-emoji', []);
export const recentEmoji = (n, fallback) => [...new Set([...recents(), ...fallback])].slice(0, n);
export function addRecent(ch) { store.setJson('recent-emoji', [ch, ...recents().filter(x => x !== ch)].slice(0, 24)); }

let el = null, cb = null, anchorMsg = null;
export function closePicker() {
  if (!el) return;
  el.remove(); el = null; cb = null;
  anchorMsg?.classList.remove('menu-open'); anchorMsg = null;
}
export const pickerOpen = () => !!el;

export function openPicker(anchor, onPick) {
  if (el) { const same = el._anchor === anchor; closePicker(); if (same) return; }
  cb = onPick;
  el = h(`<div class="picker" role="dialog" aria-label="Choisir un emoji">
    <div class="pk-search"><input type="search" placeholder="Rechercher : merci, feu, bug…" aria-label="Rechercher un emoji" autocomplete="off" spellcheck="false"></div>
    <div class="pk-body"></div><div class="pk-foot"><b></b><span>Survole un emoji</span></div></div>`);
  el._anchor = anchor;
  $('#layer').appendChild(el);
  const input = $('input', el), body = $('.pk-body', el);
  const render = q => {
    q = q.trim().toLowerCase();
    const btn = e => `<button type="button" data-e="${e.ch}" data-kw="${esc(e.kw[0] || '')}" aria-label="${esc(e.kw[0] || e.ch)}">${e.ch}</button>`;
    if (q) {
      const found = EMOJIS.filter(e => e.kw.some(k => k.includes(q)));
      body.innerHTML = found.length ? `<div class="pk-grid">${found.map(btn).join('')}</div>` : '<div class="pk-cat">Aucun emoji pour cette recherche</div>';
      return;
    }
    const rec = recents().map(ch => EMOJIS.find(e => e.ch === ch) || { ch, kw: [] });
    let html = rec.length ? `<div class="pk-cat">Récents</div><div class="pk-grid">${rec.map(btn).join('')}</div>` : '';
    for (const [cat] of EMOJI_CATS) html += `<div class="pk-cat">${esc(cat)}</div><div class="pk-grid">${EMOJIS.filter(e => e.cat === cat).map(btn).join('')}</div>`;
    body.innerHTML = html;
  };
  render('');
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('.pk-grid button', el)?.click(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
  });
  body.addEventListener('click', e => {
    const b = e.target.closest('button[data-e]');
    if (!b) return;
    addRecent(b.dataset.e);
    const fn = cb; closePicker(); fn?.(b.dataset.e);
  });
  body.addEventListener('mouseover', e => {
    const b = e.target.closest('button[data-e]');
    if (b) { $('.pk-foot b', el).textContent = b.dataset.e; $('.pk-foot span', el).textContent = b.dataset.kw ? `:${b.dataset.kw}:` : ''; }
  });
  place(el, anchor, { align: 'end', side: 'top' });
  anchorMsg = anchor.closest?.('.msg');
  anchorMsg?.classList.add('menu-open');
  if (matchMedia('(pointer: fine)').matches) input.focus();
}
document.addEventListener('mousedown', e => { if (el && !el.contains(e.target) && !el._anchor?.contains?.(e.target)) closePicker(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && el) { e.stopPropagation(); closePicker(); } }, true);
