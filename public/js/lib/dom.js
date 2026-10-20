// Petits outils DOM, partagés par tous les modules.
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Icône du sprite SVG d'index.html (aria-hidden : le bouton porte son propre libellé)
export const icon = (id, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

// Crée un élément depuis du HTML (un seul nœud racine)
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
// Délégation : on(root, 'click', '[data-act]', (e, el) => …)
export function on(root, type, selector, fn, opts) {
  root.addEventListener(type, e => {
    const el = e.target.closest?.(selector);
    if (el && root.contains(el)) fn(e, el);
  }, opts);
}
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';
export const desktop = () => matchMedia('(min-width: 861px)').matches;
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { // http:// sur IP : API du presse-papiers indisponible, on passe par un textarea
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}
// Hauteur automatique d'un textarea
export function autosize(ta, max = 0) {
  ta.style.height = 'auto';
  ta.style.height = (max ? Math.min(ta.scrollHeight, max) : ta.scrollHeight) + 'px';
}

// Met à jour `el` pour qu'il ressemble à `html` en ne remplaçant que ce qui change : les éléments inchangés
// restent en place (un clic en cours, le focus ou le survol ne sont pas perdus quand la liste se redessine).
export function morph(el, html) {
  const next = document.createElement(el.tagName);
  next.innerHTML = html;
  syncChildren(el, next);
}
function syncChildren(from, to) {
  const a = [...from.childNodes], b = [...to.childNodes];
  if (a.length !== b.length) { from.replaceChildren(...b); return; }
  a.forEach((n, i) => {
    const m = b[i];
    if (n.isEqualNode(m)) return;
    if (n.nodeType !== 1 || m.nodeType !== 1 || n.tagName !== m.tagName) { n.replaceWith(m); return; }
    for (const at of [...n.attributes]) if (!m.hasAttribute(at.name)) n.removeAttribute(at.name);
    for (const at of [...m.attributes]) if (n.getAttribute(at.name) !== at.value) n.setAttribute(at.name, at.value);
    syncChildren(n, m);
  });
}
