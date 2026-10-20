// Notifications : son, toast dans l'onglet, notification du système quand l'onglet est en arrière-plan.
// Règles : jamais pour ses propres messages ni pour la conversation qu'on regarde ; rien pendant une pause
// (« ne pas déranger ») ; un canal en sourdine ne notifie que les mentions ; le niveau choisi dans les préférences.
import { plainPreview } from '../lib/markdown.js';
import { ping } from '../lib/sound.js';
import { state, isDm, label, nameOf, prefOf, mentionsMe, isDnd } from '../core/state.js';
import { openConvo } from '../core/router.js';
import { toast } from './layer.js';
import { openThread } from './thread.js';
import { notifyLevel } from './settings.js';

const preview = m => m.text ? plainPreview(m.text, 140)
  : m.poll ? `Sondage : ${m.poll.question}` : m.shared ? 'a transféré un message'
  : m.call ? (m.call.kind === 'group' ? 'Appel de groupe' : m.call.status === 'ended' ? 'Appel audio terminé' : 'Appel manqué')
  : m.file ? (m.file.voice ? 'Message vocal' : `Fichier : ${m.file.name || ''}`) : 'Message chiffré';

export function notify(m, { visible }) {
  if (m.user === state.me || isDnd(state.me)) return;
  const inThread = !!m.parent && (m.participants || []).includes(state.me);
  const direct = isDm(m.channel) || mentionsMe(m) || inThread;
  const level = notifyLevel();
  if (level === 'none' || (level === 'mentions' && !direct) || (!direct && prefOf(m.channel).muted)) return;
  if (m.parent && !inThread && !m.broadcast) return;
  if (visible && !document.hidden) return;
  const open = () => { openConvo(m.channel); if (m.parent) openThread(m.parent, m.id); };
  const where = inThread ? `Fil · ${label(m.channel)}` : label(m.channel);
  ping();
  if (!document.hidden) {
    toast(`${nameOf(m.user)}${isDm(m.channel) ? '' : ' · ' + where} : ${preview(m).slice(0, 70)}`, { onClick: open, key: m.channel });
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(isDm(m.channel) ? nameOf(m.user) : `${nameOf(m.user)} · ${where}`, { body: preview(m), tag: 'lanchat-' + (m.parent || m.channel), icon: '/icon.svg' });
    n.onclick = () => { window.focus(); open(); n.close(); };
  }
}
export function notifyReminder(s) {
  const m = s.message;
  const open = () => openConvo(m.channel, m.parent && !m.broadcast ? m.parent : m.id);
  ping();
  toast(`Rappel : ${nameOf(m.user)} · ${preview(m).slice(0, 60)}`, { action: 'Voir', onAction: open, duration: 12000 });
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('Rappel', { body: `${nameOf(m.user)} : ${preview(m)}`, tag: 'lanchat-reminder-' + s.id, icon: '/icon.svg' });
    n.onclick = () => { window.focus(); open(); n.close(); };
  }
}
