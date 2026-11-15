// Animierter HUD-Hintergrund: Raster, vernetzte Partikel, Radar-Sweep, Scanlinie.
import { hexToRgb } from './core.js';

export function startBackground(canvas, colorFn) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, hgt = 0, dpr = 1, raf = 0, running = true;
  const parts = [];

  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    hgt = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.round(Math.min(70, (w * hgt) / 22000));
    while (parts.length < want) parts.push({ x: Math.random() * w, y: Math.random() * hgt, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, r: Math.random() * 1.6 + 0.4 });
    parts.length = want;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const frame = (t) => {
    if (!running) return;
    const rgb = hexToRgb(colorFn()) || '0, 216, 255';
    ctx.clearRect(0, 0, w, hgt);

    // Raster mit Fluchtpunkt-Gefühl
    ctx.strokeStyle = `rgba(${rgb}, 0.05)`;
    ctx.lineWidth = 1;
    const g = 48, off = (t / 80) % g;
    ctx.beginPath();
    for (let x = -g + off; x < w + g; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, hgt); }
    for (let y = -g + off; y < hgt + g; y += g) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();

    // Radar-Sweep in der Mitte
    const cx = w * 0.5, cy = hgt * 0.45, R = Math.max(w, hgt) * 0.55;
    const ang = (t / 3000) % (Math.PI * 2);
    if (ctx.createConicGradient) {
      const cg = ctx.createConicGradient(ang, cx, cy);
      cg.addColorStop(0, `rgba(${rgb}, 0.10)`);
      cg.addColorStop(0.08, `rgba(${rgb}, 0)`);
      cg.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = `rgba(${rgb}, 0.06)`;
    for (let i = 1; i <= 4; i++) { ctx.beginPath(); ctx.arc(cx, cy, (R / 4) * i, 0, Math.PI * 2); ctx.stroke(); }

    // Partikel + Verbindungen
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > hgt) p.vy *= -1;
    }
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], b = parts[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 130) {
          ctx.strokeStyle = `rgba(${rgb}, ${0.18 * (1 - d / 130)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    ctx.fillStyle = `rgba(${rgb}, 0.7)`;
    for (const p of parts) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }

    // Scanlinie
    const sy = ((t / 14) % (hgt + 200)) - 100;
    const lg = ctx.createLinearGradient(0, sy - 60, 0, sy);
    lg.addColorStop(0, `rgba(${rgb}, 0)`);
    lg.addColorStop(1, `rgba(${rgb}, 0.07)`);
    ctx.fillStyle = lg;
    ctx.fillRect(0, sy - 60, w, 60);

    if (!reduce) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const vis = () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (running && !reduce) raf = requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', vis);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('visibilitychange', vis);
  };
}
