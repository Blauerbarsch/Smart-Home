// Gemeinsamer Zustand, API-Hilfen, kleine UI-Bausteine.

export const S = {
  settings: {},
  envLocked: [],
  tabs: [],
  sites: [],
  projects: [],
  states: new Map(),
  areas: [],
  entityAreas: {},
  ha: { status: 'unconfigured' },
  mesh: { status: {}, nodes: new Map(), messages: [], configured: false },
  editing: false,
  current: null,
};

// ---------- Ereignisbus ----------
const listeners = {};
export const on = (ev, fn) => ((listeners[ev] ||= new Set()).add(fn), () => listeners[ev].delete(fn));
export const emit = (ev, data) => listeners[ev]?.forEach((fn) => fn(data));

// ---------- API ----------
export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    emit('unauthorized');
    throw new Error('Anmeldung nötig');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

/** POST mit Server-Sent-Events-Antwort (KI-Stream). */
export async function apiStream(path, body, onEvent, signal) {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await res.text());
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (ev && data) onEvent(ev, JSON.parse(data));
    }
  }
}

let saveTimer;
export function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('/layout', { method: 'PUT', body: { tabs: S.tabs, sites: S.sites } }).catch((e) => toast(e.message, true)), 300);
}

// ---------- DOM ----------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icon = (name, cls = '') => h('i', { class: `mdi mdi-${String(name || 'help-circle-outline').replace(/^mdi:/, '')} ${cls}` });
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const uid = () => Math.random().toString(36).slice(2, 10);

export function toast(text, bad = false) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text);
  document.getElementById('toast-root').append(el);
  setTimeout(() => el.remove(), 3500);
}

export function modal(title, content, { actions, wide, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('h2', {}, title, h('span', { class: 'spacer' }), h('button', { class: 'btn icon', onclick: close, title: 'Schließen' }, icon('close'))),
    content,
    actions ? h('div', { class: 'modal-actions' }, actions(close)) : null,
  );
  const back = h('div', { class: 'modal-back', onmousedown: (e) => e.target === back && close() }, box);
  root.append(back);
  return close;
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  const render = (v) => {
    wrap.replaceChildren(...options.map(([val, label]) =>
      h('button', { type: 'button', class: val === v ? 'on' : '', onclick: () => { render(val); onChange(val); } }, label)));
  };
  render(value);
  return wrap;
}

// ---------- Formatierung ----------
export function ago(ts) {
  if (!ts) return '–';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86400)} d`;
}

export function hexToRgb(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export function setAccent(hex) {
  const rgb = hexToRgb(hex) || '0, 216, 255';
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-rgb', rgb);
}

/** Kleines SVG-Liniendiagramm aus [[t, v], …]. */
export function sparkline(points, { color = 'var(--accent)', height = 44, fill = true } = {}) {
  const pts = points.map(([t, v]) => [t, Number(v)]).filter(([, v]) => Number.isFinite(v));
  const svg = `<svg class="spark" viewBox="0 0 100 ${height}" preserveAspectRatio="none">`;
  if (pts.length < 2) return h('div', { html: svg + '</svg>' }).firstChild;
  const t0 = pts[0][0], t1 = pts.at(-1)[0] || t0 + 1;
  const vals = pts.map((p) => p[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const xy = pts.map(([t, v]) => [((t - t0) / (t1 - t0 || 1)) * 100, height - 3 - ((v - lo) / (hi - lo)) * (height - 6)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
  const area = fill ? `<path d="${d}L100,${height}L0,${height}Z" fill="${color}" opacity="0.12"/>` : '';
  return h('div', { html: `${svg}${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>` }).firstChild;
}

// ---------- Home Assistant ----------
export const ent = (id) => S.states.get(id);
export const domainOf = (id) => String(id).split('.')[0];
export const friendly = (st, fallback) => st?.attributes?.friendly_name || fallback || st?.entity_id || '';

export function callService(domain, service, data = {}) {
  return api('/ha/service', { body: { domain, service, data } }).catch((e) => toast(e.message, true));
}

const DOMAIN_ICONS = {
  light: 'lightbulb', switch: 'toggle-switch-outline', input_boolean: 'toggle-switch-outline', fan: 'fan',
  sensor: 'eye', binary_sensor: 'checkbox-blank-circle-outline', climate: 'thermostat', cover: 'window-shutter',
  media_player: 'speaker', lock: 'lock', scene: 'palette', script: 'script-text-outline', automation: 'robot',
  camera: 'cctv', person: 'account', device_tracker: 'map-marker', weather: 'weather-partly-cloudy',
  vacuum: 'robot-vacuum', button: 'gesture-tap-button', input_number: 'ray-vertex', number: 'ray-vertex',
  select: 'format-list-bulleted', input_select: 'format-list-bulleted', update: 'package-up', zone: 'map-marker-radius',
  sun: 'white-balance-sunny', alarm_control_panel: 'shield-home', water_heater: 'water-boiler', humidifier: 'air-humidifier',
};
const DEVICE_CLASS_ICONS = {
  temperature: 'thermometer', humidity: 'water-percent', battery: 'battery', power: 'flash', energy: 'lightning-bolt',
  illuminance: 'brightness-5', pressure: 'gauge', co2: 'molecule-co2', motion: 'motion-sensor', door: 'door',
  window: 'window-closed-variant', voltage: 'sine-wave', current: 'current-ac', signal_strength: 'wifi', moisture: 'water',
  occupancy: 'home-account', pm25: 'blur', gas: 'gas-cylinder', connectivity: 'lan-connect', smoke: 'smoke-detector',
};
export function entityIcon(st, override) {
  if (override) return override;
  if (st?.attributes?.icon) return st.attributes.icon;
  const dc = st?.attributes?.device_class;
  if (dc && DEVICE_CLASS_ICONS[dc]) return DEVICE_CLASS_ICONS[dc];
  return DOMAIN_ICONS[domainOf(st?.entity_id)] || 'circle-outline';
}

const STATE_DE = { on: 'An', off: 'Aus', open: 'Offen', closed: 'Geschlossen', unavailable: 'Nicht verfügbar', unknown: 'Unbekannt',
  home: 'Zuhause', not_home: 'Unterwegs', playing: 'Spielt', paused: 'Pausiert', idle: 'Bereit', locked: 'Verriegelt', unlocked: 'Offen',
  heat: 'Heizen', cool: 'Kühlen', auto: 'Auto', opening: 'Öffnet', closing: 'Schließt', standby: 'Standby' };
export function stateText(st) {
  if (!st) return '–';
  const n = Number(st.state);
  if (st.state !== '' && Number.isFinite(n) && domainOf(st.entity_id) !== 'binary_sensor') {
    const unit = st.attributes.unit_of_measurement || '';
    return `${Math.round(n * 100) / 100}${unit ? ' ' + unit : ''}`;
  }
  return STATE_DE[st.state] || st.state;
}
export const isOn = (st) => st && ['on', 'open', 'playing', 'home', 'unlocked', 'heat', 'cool', 'auto', 'heat_cool', 'cleaning'].includes(st.state);
