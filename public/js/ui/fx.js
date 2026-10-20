// Confettis 🎉 (une réaction ou un message « 🎉 » les déclenche chez tout le monde)
import { $, reducedMotion } from '../lib/dom.js';

export function confetti() {
  if (reducedMotion()) return;
  const cv = $('#confetti'), ctx = cv.getContext('2d');
  cv.hidden = false; cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#10704f', '#3dbd8f', '#d33d2a', '#e5a600', '#2456b8', '#b83b85', '#f4f6f5'];
  const parts = Array.from({ length: 150 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 240, y: innerHeight * .7,
    vx: (Math.random() - .5) * 15, vy: -Math.random() * 17 - 8,
    r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.vy += .45; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); ctx.restore();
    }
    if (now - start < 3000) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, cv.width, cv.height); cv.hidden = true; }
  })(start);
}
