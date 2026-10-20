// Panneau de droite, partagé : fil de discussion, détails d'un canal, profil d'une personne.
import { $, esc, icon } from '../lib/dom.js';
import { bus } from '../core/state.js';

let current = null; // { kind, key, onClose }
export const paneIs = (kind, key) => current?.kind === kind && (key === undefined || current.key === key);
export const paneKind = () => current?.kind || null;

// Ouvre le panneau et renvoie ses zones : { head, body, foot }
export function openPane({ kind, key, title, sub = '', onClose, back }) {
  if (current && !(current.kind === kind && current.key === key)) current.onClose?.();
  current = { kind, key, onClose };
  const pane = $('#pane');
  pane.innerHTML = `<header class="pane-head">
      ${back ? `<button type="button" class="icon-btn" data-pane-back aria-label="Retour">${icon('back')}</button>` : ''}
      <div class="ttl"><h2>${esc(title)}</h2>${sub ? `<small>${sub}</small>` : ''}</div>
      <button type="button" class="icon-btn" data-pane-close aria-label="Fermer le panneau" title="Fermer (Échap)">${icon('x')}</button></header>
    <div class="pane-body"></div><div class="pane-foot"></div>`;
  $('[data-pane-close]', pane).onclick = closePane;
  if (back) $('[data-pane-back]', pane).onclick = back;
  $('#app').classList.add('pane-open');
  bus.emit('pane');
  return { head: $('.pane-head', pane), body: $('.pane-body', pane), foot: $('.pane-foot', pane), setSub: s => { const el = $('.pane-head small', pane); if (el) el.innerHTML = s; } };
}
export function closePane() {
  if (!current) return;
  const c = current;
  current = null;
  c.onClose?.();
  $('#app').classList.remove('pane-open');
  $('#pane').innerHTML = '';
  bus.emit('pane');
}
