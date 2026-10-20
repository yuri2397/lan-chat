// Calques : toasts, menus contextuels, fenêtres modales, confirmation.
import { $, $$, h, esc, icon } from '../lib/dom.js';

// ---------- Toasts ----------
// toast('Copié') · toast('Message supprimé', { action: 'Annuler', onAction }) · toast(texte, { onClick })
export function toast(text, opts = {}) {
  const host = $('#toasts');
  while (host.children.length >= 3) host.firstElementChild.remove();
  const t = h(`<div class="toast${opts.onClick ? ' clickable' : ''}" role="status"><span>${esc(text)}</span>${opts.action ? `<button type="button">${esc(opts.action)}</button>` : ''}</div>`);
  if (opts.key) { t.dataset.key = opts.key; host.querySelector(`.toast[data-key="${CSS.escape(opts.key)}"]`)?.remove(); }
  const close = () => t.remove();
  if (opts.onClick) t.onclick = e => { if (!e.target.closest('button')) { close(); opts.onClick(); } };
  t.querySelector('button')?.addEventListener('click', () => { close(); opts.onAction?.(); });
  host.appendChild(t);
  setTimeout(close, opts.duration || (opts.action || opts.onClick ? 6000 : 2600));
  return close;
}

// Retire les toasts devenus inutiles (ex. la conversation qu'ils annonçaient vient d'être ouverte)
export const dropToasts = key => $$(`#toasts .toast[data-key="${CSS.escape(key)}"]`).forEach(t => t.remove());

// ---------- Menus ----------
// items : [{ label, icon?, emoji?, hint?, danger?, run, sub? }, '-', { section: 'Titre' }, { html }]
let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu.onClose?.();
  openMenu.anchor?.setAttribute?.('aria-expanded', 'false');
  const back = openMenu.returnFocus;
  openMenu = null;
  back?.focus?.({ preventScroll: true });
}
export function menu(anchor, items, opts = {}) {
  const same = openMenu && openMenu.anchor === anchor;
  closeMenu();
  if (same && !opts.reopen) return;
  const el = h(`<div class="menu" role="menu"></div>`);
  if (opts.head) el.insertAdjacentHTML('beforeend', opts.head);
  const runs = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.insertAdjacentHTML('beforeend', '<div class="mi-sep" role="separator"></div>'); continue; }
    if (it.section) { el.insertAdjacentHTML('beforeend', `<div class="mi-label">${esc(it.section)}</div>`); continue; }
    if (it.html) { el.appendChild(typeof it.html === 'string' ? h(it.html) : it.html); continue; }
    const b = h(`<button type="button" class="mi${it.danger ? ' danger' : ''}" role="menuitem">
      ${it.emoji ? `<span class="em">${it.emoji}</span>` : it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}${it.sub ? icon('chev-right', 'sm') : ''}</button>`);
    b.dataset.i = runs.push(it) - 1;
    el.appendChild(b);
  }
  el.addEventListener('click', e => {
    const b = e.target.closest('.mi');
    if (!b) return;
    const it = runs[b.dataset.i];
    if (it.sub) return menu(anchor, it.sub(), { ...opts, reopen: true });
    closeMenu();
    it.run?.();
  });
  el.addEventListener('keydown', e => {
    const list = [...el.querySelectorAll('.mi')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    if (e.key === 'Tab') closeMenu();
  });
  $('#layer').appendChild(el);
  place(el, anchor, opts);
  openMenu = { el, anchor, onClose: opts.onClose, returnFocus: document.activeElement };
  anchor?.setAttribute?.('aria-expanded', 'true');
  if (opts.keyboard !== false && matchMedia('(pointer: fine)').matches) el.querySelector('.mi')?.focus({ preventScroll: true });
  return el;
}
// Positionne un calque près de son ancre (élément, ou point {x, y}) sans sortir de l'écran
export function place(el, anchor, { align = 'start', side = 'bottom' } = {}) {
  const r = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = el.offsetWidth, hgt = el.offsetHeight, m = 8;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(m, Math.min(left, innerWidth - w - m));
  let top = side === 'top' ? r.top - hgt - 6 : r.bottom + 6;
  if (top + hgt > innerHeight - m) top = r.top - hgt - 6;
  if (top < m) top = Math.max(m, Math.min(r.bottom + 6, innerHeight - hgt - m));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.setProperty('--origin', `${align === 'end' ? 'right' : 'left'} ${top < r.top ? 'bottom' : 'top'}`);
}
document.addEventListener('mousedown', e => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor?.contains?.(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) { e.stopPropagation(); closeMenu(); } }, true);
addEventListener('resize', closeMenu);
export const menuOpen = () => !!openMenu;

// ---------- Fenêtres modales ----------
// modal({ title, sub, body (HTML ou élément), foot, wide, onClose }) -> { el, close }
const stack = [];
export function modal({ title, sub = '', body = '', foot = '', wide = false, cls = '', onClose, label }) {
  const wrap = h(`<div class="modal-wrap"><div class="modal${wide ? ' wide' : ''}${cls ? ' ' + cls : ''}" role="dialog" aria-modal="true" aria-label="${esc(label || title || '')}">
    ${title ? `<div class="modal-head"><div style="flex:1;min-width:0"><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div><button type="button" class="icon-btn" data-close aria-label="Fermer">${icon('x')}</button></div>` : ''}
    <div class="modal-body"></div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div></div>`);
  const m = wrap.firstElementChild;
  const bodyEl = m.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
  const returnFocus = document.activeElement;
  const api = {
    el: m, wrap,
    close() {
      if (!wrap.isConnected) return;
      wrap.remove();
      stack.splice(stack.indexOf(api), 1);
      onClose?.();
      returnFocus?.focus?.({ preventScroll: true });
    },
  };
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) api.close(); });
  m.addEventListener('click', e => { if (e.target.closest('[data-close]')) api.close(); });
  // Piège à focus : Tab reste dans la fenêtre
  m.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const f = [...m.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea,select,a[href],[tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  });
  $('#layer').appendChild(wrap);
  stack.push(api);
  requestAnimationFrame(() => (m.querySelector('[autofocus]') || m.querySelector('input,textarea,select') || m.querySelector('.modal-foot .primary') || m).focus?.());
  return api;
}
export const topModal = () => stack.at(-1) || null;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && stack.length && !openMenu && !document.querySelector('.picker')) { e.preventDefault(); stack.at(-1).close(); }
});

// Confirmation (remplace window.confirm)
export function confirmBox({ title, text = '', ok = 'Confirmer', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const m = modal({
      title, body: text ? `<p style="margin:0;color:var(--text-2)">${text}</p>` : '',
      foot: `<button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.el.querySelector('[data-ok]').onclick = () => { done = true; m.close(); resolve(true); };
    m.el.querySelector('[data-ok]').focus();
  });
}

// Bouton en cours d'envoi : garde son libellé, ajoute un indicateur
export async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const spin = h('<span class="spin" aria-hidden="true"></span>');
  const t = setTimeout(() => btn.prepend(spin), 180);
  try { return await fn(); }
  finally { clearTimeout(t); spin.remove(); btn.disabled = false; }
}
