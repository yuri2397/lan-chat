// Sons générés (aucun fichier audio) : notification, sonnerie d'appel, entrée/sortie d'appel de groupe.
import { store } from './store.js';

let ctx;
const audio = () => {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume().catch(() => {});
  return ctx;
};
export const sound = {
  get on() { return store.get('sound') !== 'off'; },
  set on(v) { store.set('sound', v ? 'on' : 'off'); },
};

function tone(freqs, dur, vol, delay = 0) {
  try {
    const c = audio(), t = c.currentTime + delay;
    for (const f of freqs) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + 0.05);
    }
  } catch {}
}
// Deux notes douces, montantes
export function ping() {
  if (!sound.on) return;
  tone([880], 0.25, 0.16);
  tone([1318.5], 0.28, 0.14, 0.09);
}
export function blip(up) {
  if (!sound.on) return;
  try {
    const c = audio(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.frequency.setValueAtTime(up ? 520 : 780, t);
    o.frequency.exponentialRampToValueAtTime(up ? 780 : 520, t + 0.15);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + 0.25);
  } catch {}
}
// Sonneries d'appel en boucle
export const Tones = (() => {
  let timer;
  function loop(fn, every) { stop(); fn(); timer = setInterval(fn, every); }
  function stop() { clearInterval(timer); timer = null; }
  return {
    ring: () => loop(() => { tone([880, 1320], 0.18, 0.2); tone([880, 1320], 0.18, 0.2, 0.26); }, 2000),
    ringback: () => loop(() => tone([440, 480], 1, 0.05), 4000),
    stop,
  };
})();
