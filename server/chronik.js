// Chronik: eine Zeitleiste für alles – Schalten im Haus, Personen, Mesh, Alarme,
// Server, Commits, Tagebuch, Timer. Durchsuchbar, auch für Kopf und Claude.
import { db, q } from './db.js';
import { ha } from './ha.js';
import { mesh } from './mesh.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS chronik (ts INTEGER, source TEXT, kind TEXT, title TEXT, detail TEXT, ref TEXT, icon TEXT);
  CREATE INDEX IF NOT EXISTS chr_ts ON chronik (ts);
`);

const listeners = new Set();
export const onEntry = (fn) => listeners.add(fn);

export function add({ source, kind = '', title, detail = '', ref = '', icon = '', ts = Date.now() }) {
  q('INSERT INTO chronik (ts, source, kind, title, detail, ref, icon) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ts, source, kind, title, String(detail || ''), ref, icon);
  const e = { ts, source, kind, title, detail, ref, icon };
  listeners.forEach((fn) => fn(e));
  return e;
}

export function search({ text = '', source = '', days = 30, limit = 300, before } = {}) {
  const since = Date.now() - Number(days || 30) * 86400e3;
  const until = Number(before) || Date.now() + 1;
  const like = `%${String(text).trim()}%`;
  return q(`SELECT ts, source, kind, title, detail, ref, icon FROM chronik
    WHERE ts >= ? AND ts < ? AND (? = '' OR source = ?) AND (? = '' OR title LIKE ? OR detail LIKE ?)
    ORDER BY ts DESC LIMIT ?`).all(since, until, source, source, text, like, like, Math.min(Number(limit) || 300, 2000));
}

export function stats(days = 30) {
  return q('SELECT source, COUNT(*) AS n FROM chronik WHERE ts >= ? GROUP BY source').all(Date.now() - days * 86400e3);
}

// ---------- Home Assistant: nur sinnvolle Änderungen ----------
const DOMAINS = new Set(['light', 'switch', 'lock', 'cover', 'person', 'climate', 'alarm_control_panel', 'input_boolean', 'fan', 'vacuum', 'media_player', 'automation']);
const BINARY = new Set(['door', 'window', 'garage_door', 'opening', 'smoke', 'moisture', 'gas', 'problem', 'safety', 'tamper']);
const DE = { on: 'an', off: 'aus', open: 'offen', closed: 'geschlossen', locked: 'verriegelt', unlocked: 'entriegelt', home: 'zuhause', not_home: 'unterwegs', playing: 'spielt', paused: 'pausiert', idle: 'bereit', heat: 'heizt', cleaning: 'putzt', docked: 'in der Station' };
const lastLog = new Map();

ha.on('change', ({ entity_id, state, old }) => {
  if (!state || !old || state.state === old.state) return;
  if (['unavailable', 'unknown'].includes(state.state) || ['unavailable', 'unknown'].includes(old.state)) return;
  const domain = entity_id.split('.')[0];
  const dc = state.attributes.device_class;
  if (!DOMAINS.has(domain) && !(domain === 'binary_sensor' && BINARY.has(dc))) return;
  if (domain === 'automation') return; // Automationen an/aus selten interessant
  // Flattern dämpfen: dieselbe Entität höchstens alle 20 s
  if (Date.now() - (lastLog.get(entity_id) || 0) < 20000) return;
  lastLog.set(entity_id, Date.now());
  const name = state.attributes.friendly_name || entity_id;
  const val = DE[state.state] || state.state;
  add({ source: 'haus', kind: domain, title: `${name}: ${val}`, ref: entity_id, icon: domain === 'person' ? 'account' : domain === 'binary_sensor' ? 'door' : domain === 'light' ? 'lightbulb' : 'toggle-switch' });
});

// ---------- Mesh ----------
const nodeName = (id) => { const n = mesh.nodes[id]; return n?.alias || n?.longName || n?.shortName || id; };
const offlineSince = new Map();
mesh.on('text', (m) => add({ source: 'mesh', kind: 'text', title: `${nodeName(m.from)}${m.to !== 'all' ? ' → ' + nodeName(m.to) : ''}: ${m.text}`, ref: m.from, icon: 'message-text-outline' }));
mesh.on('node', (n) => {
  const prev = offlineSince.get(n.id);
  if (prev && Date.now() - prev > 2 * 3600e3) add({ source: 'mesh', kind: 'online', title: `${nodeName(n.id)} meldet sich wieder`, detail: `nach ${Math.round((Date.now() - prev) / 3600e3)} h`, ref: n.id, icon: 'radio-tower' });
  offlineSince.set(n.id, Date.now());
});
// Zuletzt-gesehen beim Start vorbelegen
for (const n of Object.values(mesh.nodes)) if (n.lastSeen) offlineSince.set(n.id, n.lastSeen);

setInterval(() => {
  // Aufräumen nach einem Jahr
  q('DELETE FROM chronik WHERE ts < ?').run(Date.now() - 365 * 86400e3);
}, 12 * 3600e3).unref();
