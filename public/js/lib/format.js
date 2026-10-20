// Formats de dates, durées, tailles — en français.
const LOCALE = 'fr-FR';
const DAY = 864e5;
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
export const fmtTime = ts => new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
export const fmtFull = ts => new Date(ts).toLocaleString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
export function fmtDay(ts) {
  const d = new Date(ts);
  if (sameDay(ts, Date.now())) return 'Aujourd’hui';
  if (sameDay(ts, Date.now() - DAY)) return 'Hier';
  const s = d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return s[0].toUpperCase() + s.slice(1);
}
// « aujourd'hui », « hier », « le lundi 3 mars » (après une préposition : « créé … », « depuis … »)
export function fmtOn(ts) {
  if (sameDay(ts, Date.now())) return 'aujourd’hui';
  if (sameDay(ts, Date.now() - DAY)) return 'hier';
  return 'le ' + fmtDay(ts).toLowerCase();
}
// « à 14:02 », « hier à 9:15 », « le 12/03 »
export const fmtWhen = ts => sameDay(ts, Date.now()) ? `à ${fmtTime(ts)}` : sameDay(ts, Date.now() - DAY) ? `hier à ${fmtTime(ts)}` : `le ${new Date(ts).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}`;
// Dans le futur : « aujourd'hui à 16:00 », « demain à 9:00 », « lundi 14 à 9:00 »
export function fmtFuture(ts) {
  if (sameDay(ts, Date.now())) return `aujourd’hui à ${fmtTime(ts)}`;
  if (sameDay(ts, Date.now() + DAY)) return `demain à ${fmtTime(ts)}`;
  return new Date(ts).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'short' }) + ` à ${fmtTime(ts)}`;
}
export const fmtAgo = ts => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400 && sameDay(ts, Date.now())) return fmtTime(ts);
  return fmtWhen(ts);
};
export const fmtDur = ms => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
export const fmtCallDur = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`; };
export const fmtSize = n => n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(1).replace('.', ',') + ' Ko' : (n / 1048576).toFixed(1).replace('.', ',') + ' Mo';
export const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// Échéances proposées pour les rappels, statuts et envois programmés
export function at(hour, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
export function nextMonday(hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
export const endOfDay = () => at(23, 0) + 59 * 60e3;
