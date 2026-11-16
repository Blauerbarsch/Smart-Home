// Werkstatt-Anbindungen: Projekt-Tagebuch + Fotos, InvenTree, ESPHome, Moonraker (3D-Drucker).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { settings, DATA_DIR, layout } from './store.js';
import { q } from './db.js';

// ---------- Uploads ----------
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' };
const FILE_EXT = ['stl', '3mf', 'gcode', 'step', 'stp', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'bin', 'yaml'];

export function saveUpload(buf, type, filename = '') {
  let ext = EXT[type];
  const fe = String(filename).split('.').pop().toLowerCase();
  if (FILE_EXT.includes(fe)) ext = fe === 'jpeg' ? 'jpg' : fe;
  if (!ext) throw new Error('Dateityp nicht erlaubt (Bilder, PDF, STL, 3MF, G-Code, STEP)');
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/api/uploads/' + name;
}

export function uploadPath(name) {
  const p = path.join(UPLOAD_DIR, path.basename(name));
  return fs.existsSync(p) ? p : null;
}

// ---------- Projekt-Tagebuch ----------
export const diary = {
  list: (project) => q('SELECT id, ts, text, image FROM project_log WHERE project = ? ORDER BY ts DESC LIMIT 200').all(project),
  add: (project, { text = '', image = null }) => {
    const r = q('INSERT INTO project_log (project, ts, text, image) VALUES (?, ?, ?, ?)').run(project, Date.now(), text, image);
    return { id: Number(r.lastInsertRowid), ts: Date.now(), text, image };
  },
  remove: (project, logId) => {
    const row = q('SELECT image FROM project_log WHERE id = ? AND project = ?').get(logId, project);
    if (row?.image) {
      const p = uploadPath(row.image.split('/').pop());
      if (p) fs.unlinkSync(p);
    }
    q('DELETE FROM project_log WHERE id = ? AND project = ?').run(logId, project);
  },
};

// ---------- InvenTree ----------
async function inventree(pathname) {
  const s = settings();
  if (!s.inventreeUrl) throw new Error('InvenTree nicht eingerichtet (Einstellungen)');
  const res = await fetch(s.inventreeUrl.replace(/\/$/, '') + pathname, {
    headers: { accept: 'application/json', ...(s.inventreeToken ? { authorization: `Token ${s.inventreeToken}` } : {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`InvenTree ${res.status}`);
  return res.json();
}

const mapPart = (p) => {
  const base = settings().inventreeUrl.replace(/\/$/, '');
  return {
    pk: p.pk, name: p.full_name || p.name, description: p.description, ipn: p.IPN, stock: p.in_stock ?? p.total_in_stock ?? 0,
    units: p.units, image: p.thumbnail ? base + p.thumbnail : null, url: `${base}/platform/part/${p.pk}/`,
  };
};

export async function inventreeSearch(term) {
  const data = await inventree(`/api/part/?search=${encodeURIComponent(term)}&limit=15`);
  return (data.results || data).map(mapPart);
}

export async function inventreeParts(pks) {
  const out = {};
  await Promise.all(pks.slice(0, 60).map(async (pk) => {
    try { out[pk] = mapPart(await inventree(`/api/part/${Number(pk)}/`)); } catch {}
  }));
  return out;
}

// ---------- ESPHome-Dashboard ----------
function espBase() {
  const s = settings();
  if (!s.esphomeUrl) throw new Error('ESPHome-Adresse fehlt (Einstellungen)');
  return s.esphomeUrl.replace(/\/$/, '');
}

export async function espDevices() {
  const base = espBase();
  const [devices, ping] = await Promise.all([
    fetch(base + '/devices', { signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
    fetch(base + '/ping', { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({})),
  ]);
  return {
    configured: (devices.configured || []).map((d) => ({
      name: d.name, friendly: d.friendly_name || d.name, configuration: d.configuration, address: d.address, platform: d.target_platform,
      deployed: d.deployed_version, current: d.current_version, outdated: Boolean(d.deployed_version && d.current_version && d.deployed_version !== d.current_version),
      online: ping[d.configuration] ?? null, comment: d.comment,
    })),
    importable: devices.importable || [],
  };
}

export async function espConfig(configuration) {
  const r = await fetch(`${espBase()}/edit?configuration=${encodeURIComponent(configuration)}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('ESPHome: ' + r.status);
  return r.text();
}

export async function espSaveConfig(configuration, yaml) {
  const r = await fetch(`${espBase()}/edit?configuration=${encodeURIComponent(configuration)}`, { method: 'POST', body: yaml, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('ESPHome: ' + r.status);
}

/** validate / compile / upload (OTA) / logs über die WebSocket-Schnittstelle des Dashboards. */
export function espRun(configuration, action, onLine, signal) {
  const ACTIONS = { validate: '/validate', compile: '/compile', upload: '/upload', logs: '/logs' };
  if (!ACTIONS[action]) throw new Error('Unbekannte Aktion');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(espBase().replace(/^http/, 'ws') + ACTIONS[action]);
    const stop = () => { try { ws.close(); } catch {} };
    signal?.addEventListener('abort', stop);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'spawn', configuration, port: 'OTA' }));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.event === 'line') onLine(String(m.data).replace(/\u001b\[[0-9;]*m/g, ''));
      if (m.event === 'exit') { stop(); resolve(m.code); }
    };
    ws.onerror = () => reject(new Error('ESPHome nicht erreichbar'));
    ws.onclose = () => resolve(null);
  });
}

// ---------- Moonraker / Klipper ----------
export async function printerStatus(tileId) {
  let tile;
  for (const tab of layout().tabs) tile ||= (tab.tiles || []).find((t) => t.id === tileId && t.type === 'printer');
  if (!tile?.url) throw new Error('Drucker-Kachel ohne Adresse');
  const base = tile.url.replace(/\/$/, '');
  const r = await fetch(`${base}/printer/objects/query?print_stats&display_status&extruder&heater_bed&virtual_sdcard`, {
    signal: AbortSignal.timeout(6000), headers: tile.apiKey ? { 'X-Api-Key': tile.apiKey } : {},
  });
  if (!r.ok) throw new Error('Moonraker ' + r.status);
  const s = (await r.json()).result.status;
  const ps = s.print_stats || {};
  const progress = s.display_status?.progress ?? s.virtual_sdcard?.progress ?? 0;
  const elapsed = ps.print_duration || 0;
  return {
    state: ps.state, file: ps.filename, progress, elapsed,
    remaining: progress > 0.01 ? Math.round(elapsed / progress - elapsed) : null,
    extruder: { temp: s.extruder?.temperature, target: s.extruder?.target },
    bed: { temp: s.heater_bed?.temperature, target: s.heater_bed?.target },
    message: s.display_status?.message,
  };
}

export async function printerSnapshot(tileId) {
  let tile;
  for (const tab of layout().tabs) tile ||= (tab.tiles || []).find((t) => t.id === tileId && t.type === 'printer');
  const cam = tile?.camera || (tile?.url && tile.url.replace(/:\d+\/?$/, '').replace(/\/$/, '') + '/webcam/?action=snapshot');
  if (!cam) throw new Error('Keine Kamera');
  return fetch(cam, { signal: AbortSignal.timeout(6000) });
}


// ---------- ESPHome: fertige Firmware für das Flashen per USB ----------
export async function espFirmware(configuration) {
  const base = espBase();
  const cfg = encodeURIComponent(configuration);
  let file = null;
  try {
    const list = await fetch(`${base}/downloads?configuration=${cfg}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    file = (list.find((x) => /factory/i.test(x.file || x.title || '')) || list[0])?.file;
  } catch {}
  const urls = file
    ? [`${base}/download.bin?configuration=${cfg}&file=${encodeURIComponent(file)}`]
    : [`${base}/download.bin?configuration=${cfg}&file=firmware.factory.bin`, `${base}/download.bin?configuration=${cfg}&type=firmware-factory.bin`, `${base}/download.bin?configuration=${cfg}`];
  for (const u of urls) {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (r.ok) return { buf: Buffer.from(await r.arrayBuffer()), name: file || 'firmware.factory.bin' };
  }
  throw new Error('Keine fertige Firmware – erst in ESPHome „Kompilieren“');
}

// ---------- 3D-Drucker: G-Code an Moonraker senden und drucken ----------
export async function printFile(tileId, uploadUrl, start = true) {
  let tile;
  for (const tab of layout().tabs) tile ||= (tab.tiles || []).find((t) => t.id === tileId && t.type === 'printer');
  if (!tile?.url) throw new Error('Drucker nicht gefunden');
  const name = String(uploadUrl).split('/').pop();
  const f = uploadPath(name);
  if (!f || !/\.gcode$/i.test(f)) throw new Error('Nur G-Code-Dateien können gedruckt werden (vorher slicen)');
  const boundary = '----smarthome' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const mid = start ? Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="print"\r\n\r\ntrue`) : Buffer.alloc(0);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const r = await fetch(tile.url.replace(/\/$/, '') + '/server/files/upload', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...(tile.apiKey ? { 'X-Api-Key': tile.apiKey } : {}) },
    body: Buffer.concat([head, fs.readFileSync(f), mid, tail]),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error('Moonraker: ' + r.status);
  return { ok: true, printer: tile.title || 'Drucker', file: name, started: start };
}

export function printers() {
  return layout().tabs.flatMap((t) => (t.tiles || []).filter((x) => x.type === 'printer').map((x) => ({ id: x.id, title: x.title || '3D-Drucker' })));
}
