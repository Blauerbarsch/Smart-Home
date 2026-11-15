// Geräteprofile (Handy / Tablet / PC / Wand) und Wandtablet-Modus mit Bildschirmschoner.
import { S, h, icon, ent, stateText, friendly, entityIcon } from './core.js';

const LS = (k, v) => {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(k));
    localStorage.setItem(k, JSON.stringify(v));
  } catch { return null; }
};

export const PROFILES = { phone: 'Handy', tablet: 'Tablet', pc: 'PC', wall: 'Wandtablet' };

export function autoProfile() {
  return innerWidth < 700 ? 'phone' : innerWidth < 1200 ? 'tablet' : 'pc';
}

export function currentProfile() {
  return LS('sh-profile') || autoProfile();
}
export function setProfile(p) {
  LS('sh-profile', p || null);
  S.profile = currentProfile();
}

export const tabVisible = (t) => !t.hidden && (!t.profiles?.length || t.profiles.includes(S.profile));

// ---------- Wandtablet-Modus ----------
export const kioskDefaults = { enabled: false, idleMin: 5, nightFrom: 22, nightTo: 6, nightDim: 0.35, hideNav: false, entities: [], weather: '' };
export const kioskConfig = () => ({ ...kioskDefaults, ...(LS('sh-kiosk') || {}) });
export const saveKiosk = (c) => { LS('sh-kiosk', c); applyKiosk(); };

let idleTimer, saver, wakeLock, nightTimer;

export function applyKiosk() {
  const c = kioskConfig();
  document.body.classList.toggle('kiosk', c.enabled);
  document.body.classList.toggle('kiosk-hide-nav', c.enabled && c.hideNav);
  clearTimeout(idleTimer);
  clearInterval(nightTimer);
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => removeEventListener(ev, poke, true));
  if (!c.enabled) {
    document.querySelector('.night-dim')?.remove();
    wakeLock?.release?.();
    return;
  }
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => addEventListener(ev, poke, true));
  poke();
  const night = () => {
    const hr = new Date().getHours();
    const isNight = c.nightFrom > c.nightTo ? hr >= c.nightFrom || hr < c.nightTo : hr >= c.nightFrom && hr < c.nightTo;
    let dim = document.querySelector('.night-dim');
    if (!dim) document.body.append((dim = h('div', { class: 'night-dim' })));
    dim.style.opacity = isNight ? 1 - c.nightDim : 0;
  };
  night();
  nightTimer = setInterval(night, 60000);
  // Bildschirm wach halten (Chrome/Android)
  navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
}

function poke(e) {
  if (saver) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    saver.remove();
    saver = null;
  }
  clearTimeout(idleTimer);
  const c = kioskConfig();
  if (c.enabled && c.idleMin > 0) idleTimer = setTimeout(showSaver, c.idleMin * 60e3);
}

export function showSaver() {
  if (saver) return;
  const c = kioskConfig();
  const clock = h('div', { class: 'saver-clock' });
  const date = h('div', { class: 'saver-date' });
  const vals = h('div', { class: 'saver-vals' });
  const draw = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    const w = c.weather && ent(c.weather);
    vals.replaceChildren(
      w ? h('div', { class: 'saver-val' }, icon('weather-partly-cloudy'), `${w.attributes.temperature ?? ''}${w.attributes.temperature_unit || '°'} · ${w.state}`) : null,
      ...(c.entities || []).map((id) => { const st = ent(id); return h('div', { class: 'saver-val' }, icon(entityIcon(st)), h('span', {}, friendly(st, id)), h('b', {}, stateText(st))); }),
    );
  };
  draw();
  saver = h('div', { class: 'saver' }, h('div', { class: 'saver-inner' }, clock, date, vals));
  const iv = setInterval(() => (saver ? draw() : clearInterval(iv)), 15000);
  // langsam wandern, damit nichts einbrennt
  let t = 0;
  const drift = setInterval(() => {
    if (!saver) return clearInterval(drift);
    t++;
    saver.firstChild.style.transform = `translate(${Math.sin(t / 7) * 6}vw, ${Math.cos(t / 9) * 6}vh)`;
  }, 20000);
  document.body.append(saver);
}

export function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
