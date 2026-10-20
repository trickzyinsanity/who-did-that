// Confetti bursts for correct verdicts.
(() => {
  'use strict';

  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  const COLORS = ['#FFC23D', '#E8D2A2', '#59E3A7', '#ECE7DA', '#FF5B4F'];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let pieces = [];
  let running = false;
  let dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function burst(x = window.innerWidth / 2, y = window.innerHeight / 3, count = 120, power = 1) {
    if (reduceMotion.matches) return;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (3 + Math.random() * 9) * power;
      pieces.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 6 * power,
        w: 6 + Math.random() * 6,
        h: 8 + Math.random() * 10,
        rot: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        color: COLORS[i % COLORS.length],
        life: 0,
        ttl: 100 + Math.random() * 70,
      });
    }
    if (!running) {
      running = true;
      requestAnimationFrame(step);
    }
  }

  function step() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    pieces = pieces.filter((p) => p.life < p.ttl && p.y < h + 40);
    for (const p of pieces) {
      p.life += 1;
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.3;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, (p.ttl - p.life) / 30);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life * 0.15 + p.rot)));
      ctx.restore();
    }
    if (pieces.length) {
      requestAnimationFrame(step);
    } else {
      running = false;
      ctx.clearRect(0, 0, w, h);
    }
  }

  function fromElement(el, count, power) {
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, count, power);
  }

  window.FX = { burst, fromElement };
})();
