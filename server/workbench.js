// Werkbank: aktives Projekt, Notizen/Fotos per Zuruf, Bauteil erkennen, Timer,
// Messreihen (HA/Modbus/SCPI/Mesh), Werkstatt-Wächter, Reichweitentests, Abdeckung,
// Filament-Lager, KiCad-Stückliste, Kopfs Körper (Posen, Abläufe).
import { settings, projects, readJson, writeJson, id } from './store.js';
import { db, q } from './db.js';
import { ha } from './ha.js';
import { mesh, distance } from './mesh.js';
import { alerts } from './alerts.js';
import { saveUpload, diary } from './maker.js';
import { ask, parseJson, imageBlock } from './llm.js';
import { modbusRead, scpiQuery } from './fieldbus.js';
import * as chronik from './chronik.js';
import { github } from './github.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS measurements (session TEXT, ts INTEGER, key TEXT, value REAL);
  CREATE INDEX IF NOT EXISTS ms_idx ON measurements (session, ts);
`);

const DEFAULT = {
  activeProject: null,
  timers: [],
  sessions: [],
  guard: { enabled: false, iron: '', power: '', idleWatts: 15, idleMinutes: 10, maxMinutes: 120, fan: '', fanAfterMinutes: 2, person: '', offOnLeave: true },
  rangeTests: [],
  filament: [],
  poses: {
    Neutral: { neck_yaw: 0, neck_pitch: 0, eye_yaw: 0, eye_pitch: 0, eyelid_left: 100, eyelid_right: 100 },
    Neugierig: { neck_yaw: 15, neck_pitch: -10, eye_yaw: 10, eye_pitch: -5, eyelid_left: 100, eyelid_right: 100 },
    Müde: { neck_yaw: 0, neck_pitch: 15, eye_yaw: 0, eye_pitch: 10, eyelid_left: 35, eyelid_right: 35 },
  },
  sequences: {
    Nicken: [{ t: 0, pose: 'Neutral' }, { t: 400, set: { neck_pitch: 15 } }, { t: 800, set: { neck_pitch: -5 } }, { t: 1200, set: { neck_pitch: 12 } }, { t: 1600, pose: 'Neutral' }],
    Kopfschütteln: [{ t: 0, pose: 'Neutral' }, { t: 350, set: { neck_yaw: -25 } }, { t: 700, set: { neck_yaw: 25 } }, { t: 1050, set: { neck_yaw: -20 } }, { t: 1400, pose: 'Neutral' }],
    Zwinkern: [{ t: 0, set: { eyelid_left: 100 } }, { t: 150, set: { eyelid_left: 0 } }, { t: 400, set: { eyelid_left: 100 } }],
    Umschauen: [{ t: 0, pose: 'Neutral' }, { t: 800, set: { neck_yaw: -40, eye_yaw: -15 } }, { t: 2000, set: { neck_yaw: 40, eye_yaw: 15 } }, { t: 3200, pose: 'Neutral' }],
  },
  nodeMeta: {},
};

const state = { ...structuredClone(DEFAULT), ...readJson('workbench.json', {}) };
state.guard = { ...DEFAULT.guard, ...state.guard };
const save = () => writeJson('workbench.json', state);
export const wb = state;

// ---------- Aktives Projekt ----------
export function setActive(pid) {
  state.activeProject = pid || null;
  save();
}
export function activeProject() {
  return projects.get(state.activeProject) || null;
}
/** Projekt per Name finden (für Sprachbefehle), sonst das aktive. */
export function resolveProject(name) {
  if (name) {
    const n = String(name).toLowerCase();
    const p = projects.list.find((x) => x.name.toLowerCase() === n) || projects.list.find((x) => x.name.toLowerCase().includes(n) || n.includes(x.name.toLowerCase()));
    if (p) return p;
  }
  return activeProject();
}

// ---------- Kopf-Kamera ----------
export async function kopfSnapshot(debug = false) {
  const url = settings().kopfVisionUrl;
  if (!url) throw new Error('Kopf-Kamera nicht eingerichtet (Einstellungen → KI)');
  const r = await fetch(url.replace(/\/$/, '') + (debug ? '/debug.jpg' : '/snapshot.jpg'), { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('Kopf-Kamera liefert kein Bild');
  return Buffer.from(await r.arrayBuffer());
}

// ---------- Tagebuch per Zuruf ----------
export async function diaryAdd({ text = '', photo = false, project }) {
  const p = resolveProject(project);
  if (!p) throw new Error('Kein Projekt gewählt – in der Werkstatt ein Projekt öffnen oder den Namen nennen');
  let image = null;
  if (photo) image = saveUpload(await kopfSnapshot(), 'image/jpeg');
  const e = diary.add(p.id, { text, image });
  chronik.add({ source: 'werkstatt', kind: 'tagebuch', title: `${p.name}: ${text || 'Foto'}`, ref: p.id, icon: photo ? 'camera' : 'notebook-outline' });
  return { project: p.name, entry: e };
}

// ---------- Bauteil erkennen (Claude mit Bild) ----------
export async function identifyPart({ image, mediaType = 'image/jpeg', fromKopf = false }) {
  const buf = fromKopf ? await kopfSnapshot() : image;
  if (!buf) throw new Error('Kein Bild');
  const text = await ask({
    needsVision: true,
    maxTokens: 900,
    system: 'Du erkennst Elektronik-Bauteile, Module und Werkzeuge auf Fotos aus einer Bastelwerkstatt. Lies Beschriftungen genau. Antworte nur mit JSON.',
    content: [
      imageBlock(buf, mediaType),
      { type: 'text', text: 'Was ist das? JSON: {"name": "kurzer Name, z. B. BME280-Modul", "category": "Sensor|Mikrocontroller|IC|Passiv|Modul|Stecker|Werkzeug|Sonstiges", "marking": "gelesene Beschriftung", "description": "1–2 Sätze auf Deutsch", "specs": {"Spannung": "…"}, "datasheet": "Suchbegriff für das Datenblatt", "confidence": 0.0-1.0}' },
    ],
  });
  const part = parseJson(text);
  if (fromKopf) part.image = saveUpload(buf, 'image/jpeg');
  return part;
}

// ---------- Timer ----------
const timerHandles = new Map();
function armTimer(t) {
  const ms = Math.max(0, t.due - Date.now());
  timerHandles.set(t.id, setTimeout(() => fireTimer(t.id), Math.min(ms, 2 ** 31 - 1)));
}
async function fireTimer(tid) {
  const t = state.timers.find((x) => x.id === tid);
  if (!t) return;
  if (Date.now() < t.due - 1000) return armTimer(t); // sehr lange Timer
  state.timers = state.timers.filter((x) => x.id !== tid);
  save();
  chronik.add({ source: 'werkstatt', kind: 'timer', title: `Timer: ${t.text}`, icon: 'timer-outline' });
  await alerts.notify({ rule: { id: 'timer' }, level: 'info', title: 'Timer', text: t.text, channels: ['browser', 'ha', 'ntfy', 'kopf'] });
}
export function addTimer({ minutes, text }) {
  const t = { id: id(), due: Date.now() + Number(minutes) * 60e3, text: String(text || 'Zeit ist um'), created: Date.now() };
  state.timers.push(t);
  save();
  armTimer(t);
  return t;
}
export function cancelTimer(tid) {
  clearTimeout(timerHandles.get(tid));
  state.timers = state.timers.filter((x) => x.id !== tid);
  save();
}
state.timers.forEach(armTimer);

// ---------- Messreihen ----------
const sampling = new Map();
async function readSource(src) {
  switch (src.type) {
    case 'ha': {
      const st = ha.states.get(src.entity);
      const v = Number(st?.state);
      return Number.isFinite(v) ? v : null;
    }
    case 'modbus': return modbusRead({ ...src, unit: src.modbusUnit ?? src.unit });
    case 'scpi': return scpiQuery(src);
    case 'mesh': {
      const v = mesh.nodes[src.node]?.[src.metric];
      return typeof v === 'number' ? v : null;
    }
  }
  return null;
}
const srcKey = (s, i) => s.label || `${s.type}${i}`;
function startSampling(sess) {
  const ins = q('INSERT INTO measurements (session, ts, key, value) VALUES (?, ?, ?, ?)');
  const tick = async () => {
    const now = Date.now();
    await Promise.all(sess.sources.map(async (s, i) => {
      try {
        const v = await readSource(s);
        if (typeof v === 'number' && Number.isFinite(v)) ins.run(sess.id, now, srcKey(s, i), v);
      } catch (e) { sess.lastError = e.message; }
    }));
  };
  tick();
  sampling.set(sess.id, setInterval(tick, Math.max(1, Number(sess.interval) || 5) * 1000));
}
export function startSession({ project, name, sources, interval = 5, battery_mAh }) {
  if (!sources?.length) throw new Error('Mindestens eine Messquelle angeben');
  const sess = { id: id(), project: project || state.activeProject, name: name || 'Messung', sources, interval, battery_mAh, start: Date.now(), end: null };
  state.sessions.push(sess);
  save();
  startSampling(sess);
  chronik.add({ source: 'werkstatt', kind: 'messung', title: `Messung gestartet: ${sess.name}`, ref: sess.project, icon: 'sine-wave' });
  return sess;
}
export function stopSession(sid) {
  const s = state.sessions.find((x) => x.id === sid);
  if (!s) return null;
  clearInterval(sampling.get(sid));
  sampling.delete(sid);
  s.end = Date.now();
  save();
  return s;
}
export function deleteSession(sid) {
  stopSession(sid);
  state.sessions = state.sessions.filter((x) => x.id !== sid);
  q('DELETE FROM measurements WHERE session = ?').run(sid);
  save();
}
export function sessionData(sid) {
  const s = state.sessions.find((x) => x.id === sid);
  if (!s) throw new Error('Messung nicht gefunden');
  const rows = q('SELECT ts, key, value FROM measurements WHERE session = ? ORDER BY ts').all(sid);
  const series = {};
  for (const r of rows) (series[r.key] ||= []).push([r.ts, r.value]);
  // Auswertung je Reihe: min/max/Mittel; Strom (A/mA) → Ladung in mAh und Laufzeit-Schätzung
  const stats = {};
  for (const [k, pts] of Object.entries(series)) {
    const vals = pts.map((p) => p[1]);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    let integral = 0; // Wert·Stunden
    for (let i = 1; i < pts.length; i++) integral += ((pts[i][1] + pts[i - 1][1]) / 2) * ((pts[i][0] - pts[i - 1][0]) / 3600e3);
    stats[k] = { min: Math.min(...vals), max: Math.max(...vals), avg, last: vals.at(-1), integral, hours: (pts.at(-1)[0] - pts[0][0]) / 3600e3, n: vals.length };
  }
  return { session: s, series, stats, running: sampling.has(sid) };
}
// Laufende Messungen nach Neustart fortsetzen
state.sessions.filter((s) => !s.end).forEach(startSampling);

// ---------- Werkstatt-Wächter (Lötstation, Absaugung, Verlassen) ----------
const g = { ironOnSince: null, idleSince: null, fanOffAt: null, warnedLeave: false };
async function guardTick() {
  const c = state.guard;
  if (!c.enabled || !c.iron || ha.status !== 'connected') return;
  const iron = ha.states.get(c.iron);
  const on = iron?.state === 'on';
  const now = Date.now();
  const off = async (why) => {
    await ha.callService('homeassistant', 'turn_off', { entity_id: c.iron });
    chronik.add({ source: 'werkstatt', kind: 'wächter', title: `Lötstation ausgeschaltet: ${why}`, icon: 'soldering-iron' });
    await alerts.notify({ level: 'warning', title: 'Lötstation ausgeschaltet', text: why, channels: ['browser', 'ha', 'kopf'] });
  };
  if (on) {
    g.ironOnSince ||= now;
    g.fanOffAt = null;
    if (c.fan && ha.states.get(c.fan)?.state !== 'on') await ha.callService('homeassistant', 'turn_on', { entity_id: c.fan });
    // Leerlauf über Leistungsmessung
    if (c.power) {
      const w = Number(ha.states.get(c.power)?.state);
      if (Number.isFinite(w) && w < Number(c.idleWatts)) {
        g.idleSince ||= now;
        if (now - g.idleSince > Number(c.idleMinutes) * 60e3) { g.idleSince = null; return off(`${c.idleMinutes} min ohne Benutzung`); }
      } else g.idleSince = null;
    }
    if (c.maxMinutes && now - g.ironOnSince > Number(c.maxMinutes) * 60e3) { g.ironOnSince = null; return off(`länger als ${c.maxMinutes} min an`); }
    // Haus verlassen
    if (c.person) {
      const away = ha.states.get(c.person)?.state === 'not_home';
      if (away && !g.warnedLeave) {
        g.warnedLeave = true;
        if (c.offOnLeave) return off('Du hast das Haus verlassen');
        await alerts.notify({ level: 'warning', title: 'Lötstation ist noch an', text: 'Du bist unterwegs, die Lötstation läuft noch.', channels: ['ha', 'ntfy'] });
      }
      if (!away) g.warnedLeave = false;
    }
  } else {
    g.ironOnSince = null;
    g.idleSince = null;
    if (c.fan && ha.states.get(c.fan)?.state === 'on') {
      g.fanOffAt ||= now + Number(c.fanAfterMinutes || 2) * 60e3;
      if (now >= g.fanOffAt) { g.fanOffAt = null; await ha.callService('homeassistant', 'turn_off', { entity_id: c.fan }); }
    }
  }
}
setInterval(() => guardTick().catch((e) => console.error('Wächter:', e.message)), 20000).unref();
export function setGuard(cfg) {
  state.guard = { ...state.guard, ...cfg };
  save();
  return state.guard;
}

// ---------- Reichweitentests & Abdeckung ----------
export function startRangeTest({ node, name }) {
  const t = { id: id(), node, name: name || `Test ${new Date().toLocaleDateString('de-DE')}`, start: Date.now(), end: null };
  state.rangeTests.push(t);
  save();
  return t;
}
export function stopRangeTest(tid) {
  const t = state.rangeTests.find((x) => x.id === tid);
  if (t) { t.end = Date.now(); save(); }
  return t;
}
export function deleteRangeTest(tid) {
  state.rangeTests = state.rangeTests.filter((x) => x.id !== tid);
  save();
}
/** Punkte eines Tests: Position des mobilen Nodes + bestes Signal eines Pakets ±90 s. */
export function rangeTestData(tid) {
  const t = state.rangeTests.find((x) => x.id === tid);
  if (!t) throw new Error('Test nicht gefunden');
  const end = t.end || Date.now();
  const pos = q('SELECT ts, lat, lon FROM mesh_positions WHERE node = ? AND ts BETWEEN ? AND ? ORDER BY ts').all(t.node, t.start, end);
  const pk = q('SELECT ts, rssi, snr, gateway, hops FROM mesh_packets WHERE node = ? AND ts BETWEEN ? AND ? ORDER BY ts').all(t.node, t.start - 90e3, end + 90e3);
  const points = pos.map((p) => {
    const near = pk.filter((x) => Math.abs(x.ts - p.ts) <= 90e3 && x.snr != null);
    const best = near.sort((a, b) => b.snr - a.snr)[0];
    return { ts: p.ts, lat: p.lat, lon: p.lon, snr: best?.snr ?? null, rssi: best?.rssi ?? null, gateway: best?.gateway ?? null, hops: best?.hops ?? null };
  });
  const gw = points.find((p) => p.gateway)?.gateway;
  const gwNode = gw && mesh.nodes[gw];
  const maxDist = gwNode?.lat ? Math.max(0, ...points.filter((p) => p.snr != null).map((p) => distance(gwNode.lat, gwNode.lon, p.lat, p.lon))) : null;
  return { test: t, points, packets: pk.length, maxDist };
}
/** Abdeckung: direkte Empfänge (0 Hops) mit Position des Senders, auf ein Raster verdichtet. */
export function coverage(days = 30) {
  const since = Date.now() - days * 86400e3;
  const pk = q('SELECT ts, node, snr, rssi FROM mesh_packets WHERE ts >= ? AND hops = 0 AND snr IS NOT NULL AND via_mqtt = 0').all(since);
  const byNode = {};
  for (const p of pk) (byNode[p.node] ||= []).push(p);
  const grid = new Map();
  for (const [node, list] of Object.entries(byNode)) {
    const pos = q('SELECT ts, lat, lon FROM mesh_positions WHERE node = ? AND ts >= ? ORDER BY ts').all(node, since - 86400e3);
    if (!pos.length) continue;
    let j = 0;
    for (const p of list) {
      while (j + 1 < pos.length && pos[j + 1].ts <= p.ts) j++;
      const at = pos[j];
      if (!at || Math.abs(at.ts - p.ts) > 6 * 3600e3) continue;
      const key = `${(Math.round(at.lat / 0.002) * 0.002).toFixed(3)},${(Math.round(at.lon / 0.003) * 0.003).toFixed(3)}`;
      const c = grid.get(key) || { lat: +key.split(',')[0], lon: +key.split(',')[1], n: 0, snr: -99, sum: 0 };
      c.n++; c.sum += p.snr; c.snr = Math.max(c.snr, p.snr);
      grid.set(key, c);
    }
  }
  return [...grid.values()].map((c) => ({ lat: c.lat, lon: c.lon, n: c.n, best: c.snr, avg: Math.round((c.sum / c.n) * 10) / 10 }));
}

// ---------- Node-Bau: Akku, Panel → Energiebilanz ----------
export function setNodeMeta(nid, meta) {
  state.nodeMeta[nid] = { ...state.nodeMeta[nid], ...meta };
  save();
  return state.nodeMeta[nid];
}
/** Verlauf von Akku/Spannung auswerten: Entladung nachts, Netto-Ladung am Tag, Reserve ohne Sonne. */
export function energy(nid, days = 7) {
  const since = Date.now() - days * 86400e3;
  const bat = q("SELECT ts, value FROM mesh_metrics WHERE node = ? AND metric = 'battery' AND ts >= ? AND value <= 100 ORDER BY ts").all(nid, since);
  const meta = state.nodeMeta[nid] || {};
  if (bat.length < 6) return { enough: false, meta, points: bat.length };
  const tz = process.env.TZ || 'Europe/Berlin';
  const hourOf = (ts) => Number(new Date(ts).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }));
  const slope = (filter) => {
    let dv = 0, dt = 0;
    for (let i = 1; i < bat.length; i++) {
      const a = bat[i - 1], b = bat[i];
      const gap = b.ts - a.ts;
      if (gap > 3 * 3600e3 || !filter(hourOf(a.ts))) continue;
      dv += b.value - a.value;
      dt += gap / 3600e3;
    }
    return dt > 1 ? dv / dt : null; // %/h
  };
  const night = slope((h) => h >= 22 || h < 6);
  const day = slope((h) => h >= 9 && h < 17);
  const all = slope(() => true);
  const now = bat.at(-1).value;
  const drain = night != null && night < 0 ? -night : null;
  const reserveHours = drain ? now / drain : null;
  const dailyNet = all != null ? all * 24 : null;
  const mAhPerDay = drain && meta.battery_mAh ? (drain / 100) * meta.battery_mAh * 24 : null;
  let verdict;
  if (dailyNet == null) verdict = 'Noch zu wenig Daten.';
  else if (dailyNet > 0.5) verdict = 'Energiebilanz positiv – Panel und Akku reichen.';
  else if (dailyNet > -1) verdict = 'Knapp ausgeglichen – bei längerem Schlechtwetter wird es eng.';
  else verdict = `Akku verliert ~${Math.abs(dailyNet).toFixed(1)} %/Tag – größeres Panel oder sparsamere Einstellungen (z. B. längere Sendeintervalle).`;
  return {
    enough: true, meta, now, nightRate: night, dayRate: day, dailyNet, reserveHours, reserveDays: reserveHours ? reserveHours / 24 : null, mAhPerDay,
    avgCurrent_mA: mAhPerDay ? mAhPerDay / 24 : null, verdict, points: bat.length,
  };
}

// ---------- Filament ----------
export function saveFilament(list) {
  state.filament = list.map((f) => ({ id: f.id || id(), ...f }));
  save();
  return state.filament;
}

// ---------- KiCad-Stückliste aus dem Repo ----------
function sexpr(src) {
  let i = 0;
  const parse = () => {
    const out = [];
    while (i < src.length) {
      const c = src[i];
      if (c === '(') { i++; out.push(parse()); }
      else if (c === ')') { i++; return out; }
      else if (c === '"') {
        let s = '';
        i++;
        while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; s += src[i++]; }
        i++;
        out.push(s);
      } else if (/\s/.test(c)) i++;
      else { let s = ''; while (i < src.length && !/[\s()]/.test(src[i])) s += src[i++]; out.push(s); }
    }
    return out;
  };
  return parse();
}
export async function kicadBom(repo) {
  const tree = await github.api(`/repos/${repo}/git/trees/HEAD?recursive=1`);
  const files = (tree?.tree || []).filter((f) => f.path.endsWith('.kicad_sch')).map((f) => f.path);
  if (!files.length) throw new Error('Keine KiCad-Schaltpläne (.kicad_sch) im Repo gefunden');
  const groups = new Map();
  for (const f of files.slice(0, 20)) {
    const raw = await github.api(`/repos/${repo}/contents/${encodeURIComponent(f).replace(/%2F/g, '/')}`, { raw: true });
    const walk = (node) => {
      if (!Array.isArray(node)) return;
      if (node[0] === 'symbol' && node.some((c) => Array.isArray(c) && c[0] === 'lib_id')) {
        const prop = (k) => node.find((c) => Array.isArray(c) && c[0] === 'property' && c[1] === k)?.[2] || '';
        const flag = (k) => node.find((c) => Array.isArray(c) && c[0] === k)?.[1];
        const ref = prop('Reference');
        if (!ref || ref.startsWith('#') || flag('dnp') === 'yes' || flag('in_bom') === 'no') return;
        const lib = node.find((c) => Array.isArray(c) && c[0] === 'lib_id')[1];
        const value = prop('Value'), footprint = prop('Footprint').split(':').pop();
        const key = `${value}|${footprint}|${lib}`;
        const gr = groups.get(key) || { value, footprint, lib, refs: [], datasheet: prop('Datasheet') };
        if (!gr.refs.includes(ref)) gr.refs.push(ref);
        groups.set(key, gr);
        return;
      }
      node.forEach(walk);
    };
    walk(sexpr(String(raw || '')));
  }
  const rows = [...groups.values()].map((x) => ({ ...x, qty: x.refs.length, refs: x.refs.sort((a, b) => a.localeCompare(b, 'de', { numeric: true })) }));
  return { files, parts: rows.sort((a, b) => a.refs[0].localeCompare(b.refs[0], 'de', { numeric: true })) };
}

// ---------- Kopfs Körper ----------
function bodyUrl() {
  const u = settings().kopfBodyUrl;
  if (!u) throw new Error('Kopf-Körper (head-body) nicht eingerichtet (Einstellungen → KI)');
  return u.replace(/\/$/, '');
}
export async function body(path, payload) {
  const r = await fetch(bodyUrl() + path, payload ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) } : { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'head-body ' + r.status);
  return j;
}
/** Pose setzen: alle Teile auf einmal (nutzt /pose, fällt auf einzelne /move zurück). */
export async function setPose(parts) {
  try { return await body('/pose', { parts }); } catch (e) {
    if (!/404|not found/i.test(e.message)) throw e;
    for (const [part, value] of Object.entries(parts)) await body('/move', { part, value });
    return { status: 'reached' };
  }
}
/** Ablauf abspielen: Schlüsselbilder mit Zeit; Werte werden linear interpoliert (20 Bilder/s). */
export async function playSequence(nameOrFrames) {
  const frames = typeof nameOrFrames === 'string' ? state.sequences[nameOrFrames] : nameOrFrames;
  if (!frames?.length) throw new Error('Ablauf nicht gefunden');
  const cur = (await body('/state')).state || {};
  const keys = frames.map((f) => ({ t: f.t, vals: { ...(f.pose ? state.poses[f.pose] : {}), ...(f.set || {}) } }));
  // Lücken auffüllen: jedes Schlüsselbild kennt alle Werte des vorherigen
  let prev = { ...cur };
  for (const k of keys) { k.vals = { ...prev, ...k.vals }; prev = k.vals; }
  const total = keys.at(-1).t;
  const t0 = Date.now();
  for (let t = 0; t <= total; t = Date.now() - t0) {
    const i = keys.findIndex((k) => k.t >= t);
    const b = keys[Math.max(0, i)], a = keys[Math.max(0, i - 1)];
    const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
    const vals = Object.fromEntries(Object.keys(b.vals).map((p) => [p, Math.round((a.vals[p] + (b.vals[p] - a.vals[p]) * f) * 10) / 10]));
    await setPose(vals);
    await new Promise((r) => setTimeout(r, 50));
  }
  await setPose(keys.at(-1).vals);
  return { played: typeof nameOrFrames === 'string' ? nameOrFrames : 'Ablauf', ms: total };
}
export function savePoses({ poses, sequences }) {
  if (poses) state.poses = poses;
  if (sequences) state.sequences = sequences;
  save();
  return { poses: state.poses, sequences: state.sequences };
}
