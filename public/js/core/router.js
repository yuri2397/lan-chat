// Navigation par l'adresse (#/c/general, #/c/general/123, #/threads…) : liens partageables,
// boutons Précédent / Suivant du navigateur, rechargement au même endroit.
import { state, bus } from './state.js';
import { store } from '../lib/store.js';

export const VIEWS = ['threads', 'activity', 'later', 'drafts', 'browse', 'search', 'people'];

export function parse(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'c' && parts[1]) return { view: 'channel', ch: decodeURIComponent(parts[1]), msg: Number(parts[2]) || null };
  if (VIEWS.includes(parts[0])) return { view: parts[0], q: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : '' };
  return null;
}
export const hrefOf = r => r.view === 'channel'
  ? `#/c/${encodeURIComponent(r.ch)}${r.msg ? '/' + r.msg : ''}`
  : `#/${r.view}${r.q ? '/' + encodeURIComponent(r.q) : ''}`;
export const linkToMessage = (ch, id) => location.origin + location.pathname + hrefOf({ view: 'channel', ch, msg: id });

// replace : remplace l'entrée de l'historique (recherche en cours de frappe, redirections).
// La navigation est synchrone (History API) : la vue change dans le même instant que le clic.
export function go(r, { replace = false } = {}) {
  const href = hrefOf(r);
  if (location.hash !== href) history[replace ? 'replaceState' : 'pushState'](null, '', href);
  apply(r);
}
export const openConvo = (ch, msg = null) => go({ view: 'channel', ch, msg });

let applied = '';
function apply(r) {
  applied = hrefOf(r);
  state.route = r;
  if (r.view === 'channel') store.set('channel', r.ch);
  bus.emit('route', r);
}
// Précédent / Suivant, liens collés dans la barre d'adresse
const onHistory = () => { const r = parse(); if (r && hrefOf(r) !== applied) apply(r); };
addEventListener('popstate', onHistory);
addEventListener('hashchange', onHistory);
// Liens internes (#/…) : interceptés pour une navigation immédiate (Ctrl/⌘-clic garde le nouvel onglet)
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[href^="#/"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const r = parse(a.getAttribute('href'));
  if (!r) return;
  e.preventDefault();
  go(r);
});
export function startRouter() {
  const r = parse() || { view: 'channel', ch: store.get('channel') || 'general', msg: null };
  go(r, { replace: true });
}
