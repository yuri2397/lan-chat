// Avatars : photo de profil si elle existe, sinon initiale sur une teinte propre à la personne.
import { esc } from '../lib/dom.js';
import { state, user, nameOf, isOnline, isDnd } from '../core/state.js';

const HUES = [8, 28, 46, 84, 142, 168, 192, 212, 232, 258, 284, 322];
export const hueOf = name => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
export const initial = name => esc([...(nameOf(name) || '?')][0].toUpperCase());

export function presenceHtml(name) {
  const cls = isDnd(name) ? 'dnd' : isOnline(name) ? 'on' : '';
  const label = isDnd(name) ? 'Ne pas déranger' : isOnline(name) ? 'En ligne' : state.online.has(name) ? 'Absent' : 'Hors ligne';
  return `<span class="pres ${cls}" role="img" aria-label="${label}"></span>`;
}
// opts : { size: 's24'…, presence: bool, cls, attrs }
export function avatarHtml(name, opts = {}) {
  const u = user(name);
  const img = u.avatar ? `<img src="/api/avatar/${encodeURIComponent(name)}/${u.avatar}" alt="" loading="lazy" decoding="async">` : initial(name);
  return `<span class="av${opts.size ? ' ' + opts.size : ''}${opts.cls ? ' ' + opts.cls : ''}" style="--h:${hueOf(name)}"${opts.attrs || ''} aria-hidden="${opts.presence ? 'false' : 'true'}">${img}${opts.presence ? presenceHtml(name) : ''}</span>`;
}
