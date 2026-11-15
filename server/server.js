// Smart-Home-Dashboard – Server ohne externe Abhängigkeiten (Node ≥ 22).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { ha } from './ha.js';
import { mesh } from './mesh.js';
import { chat, kopfStatus, kopfSpeak } from './ai.js';

const PORT = Number(process.env.PORT || 8080);
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const PASSWORD = process.env.APP_PASSWORD || '';
const VERSION = '0.1.0';

// ---------- Anmeldung (optional über APP_PASSWORD) ----------
const sessions = new Set(store.readJson('sessions.json', []));
const cookie = (req, name) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
const authed = (req) => !PASSWORD || sessions.has(cookie(req, 'sh_session'));

// ---------- Live-Ereignisse (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
ha.on('state', (d) => broadcast('state', d));
ha.on('status', (d) => broadcast('ha', d));
ha.on('snapshot', () => broadcast('snapshot', { states: [...ha.states.values()], areas: ha.areas, entityAreas: ha.entityAreas }));
mesh.on('node', (n) => broadcast('mesh-node', n));
mesh.on('text', (m) => broadcast('mesh-text', m));
mesh.on('status', (s) => broadcast('mesh', s));
setInterval(() => broadcast('ping', Date.now()), 25000).unref();

// ---------- Hilfen ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5e6) throw new Error('Anfrage zu groß');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function pipeFetch(res, upstream) {
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  if (upstream.body) for await (const c of upstream.body) res.write(c);
  res.end();
}

function serveStatic(req, res, pathname) {
  let file = path.join(WEB, decodeURIComponent(pathname));
  if (!file.startsWith(WEB)) return json(res, 403, { error: 'verboten' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
}

function bootstrap() {
  return {
    version: VERSION,
    auth: Boolean(PASSWORD),
    settings: store.publicSettings(),
    envLocked: store.envLocked(),
    ...store.layout(),
    projects: store.projects.list,
    ha: { status: ha.status, error: ha.error },
    states: [...ha.states.values()],
    areas: ha.areas,
    entityAreas: ha.entityAreas,
    mesh: { status: mesh.status, configured: mesh.configured, nodes: mesh.list(), messages: mesh.messages.slice(-100) },
  };
}

// ---------- Routen ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/auth', (req, res) => json(res, 200, { required: Boolean(PASSWORD), ok: authed(req) }));
route('POST', '/api/login', async (req, res) => {
  const { password } = await body(req);
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(PASSWORD);
  if (!PASSWORD || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    store.writeJson('sessions.json', [...sessions]);
    res.setHeader('set-cookie', `sh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return json(res, 200, { ok: true });
  }
  await new Promise((r) => setTimeout(r, 800));
  json(res, 401, { error: 'Falsches Passwort' });
});
route('POST', '/api/logout', (req, res) => {
  sessions.delete(cookie(req, 'sh_session'));
  store.writeJson('sessions.json', [...sessions]);
  res.setHeader('set-cookie', 'sh_session=; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
});

route('GET', '/api/bootstrap', (req, res) => json(res, 200, bootstrap()));

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`event: hello\ndata: ${JSON.stringify({ ha: ha.status, mesh: mesh.status })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

route('PUT', '/api/layout', async (req, res) => {
  store.saveLayout(await body(req));
  json(res, 200, { ok: true });
});

route('PUT', '/api/settings', async (req, res) => {
  const patch = await body(req);
  store.saveSettings(patch);
  if ('haUrl' in patch || 'haToken' in patch) ha.restart();
  if (['mqttUrl', 'mqttUser', 'mqttPassword', 'meshTopic'].some((k) => k in patch)) mesh.restart();
  json(res, 200, { settings: store.publicSettings() });
});

route('GET', '/api/export', (req, res) => {
  res.setHeader('content-disposition', 'attachment; filename="smart-home-backup.json"');
  json(res, 200, store.exportConfig());
});
route('POST', '/api/import', async (req, res) => {
  store.importConfig(await body(req));
  json(res, 200, bootstrap());
});

// Home Assistant
route('POST', '/api/ha/service', async (req, res) => {
  const { domain, service, data, target } = await body(req);
  await ha.callService(domain, service, data, target);
  json(res, 200, { ok: true });
});
route('GET', '/api/ha/camera/:entity', async (req, res, p) => {
  await pipeFetch(res, await ha.rest(`/api/camera_proxy/${encodeURIComponent(p.entity)}`));
});
route('GET', '/api/ha/history/:entity', async (req, res, p, q) => {
  const hours = Math.min(Number(q.get('hours')) || 24, 24 * 14);
  const start = new Date(Date.now() - hours * 3600e3).toISOString();
  const r = await ha.rest(
    `/api/history/period/${start}?filter_entity_id=${encodeURIComponent(p.entity)}&minimal_response&no_attributes`,
  );
  const data = await r.json();
  json(res, 200, (data[0] || []).map((s) => [Date.parse(s.last_changed), s.state]));
});

// Projekte
route('GET', '/api/projects', (req, res) => json(res, 200, store.projects.list));
route('POST', '/api/projects', async (req, res) => json(res, 200, store.projects.create(await body(req))));
route('PUT', '/api/projects/:id', async (req, res, p) => {
  const updated = store.projects.update(p.id, await body(req));
  updated ? json(res, 200, updated) : json(res, 404, { error: 'nicht gefunden' });
});
route('DELETE', '/api/projects/:id', (req, res, p) => {
  store.projects.remove(p.id);
  json(res, 200, { ok: true });
});

// KI
route('POST', '/api/ai/chat', async (req, res) => {
  const payload = await body(req);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    await chat(payload, emit, ctrl.signal);
    emit('done', {});
  } catch (e) {
    if (!ctrl.signal.aborted) emit('error', { message: e.message });
  }
  res.end();
});

// Kopf
route('GET', '/api/kopf/status', async (req, res) => json(res, 200, await kopfStatus()));
route('POST', '/api/kopf/speak', async (req, res) => {
  await kopfSpeak((await body(req)).text);
  json(res, 200, { ok: true });
});
route('GET', '/api/kopf/snapshot', async (req, res) => {
  const url = store.settings().kopfVisionUrl;
  if (!url) return json(res, 404, { error: 'Kamera nicht eingerichtet' });
  await pipeFetch(res, await fetch(url.replace(/\/$/, '') + '/snapshot.jpg', { signal: AbortSignal.timeout(5000) }));
});

// Meshtastic
route('GET', '/api/mesh/nodes', (req, res) => json(res, 200, mesh.list()));
route('GET', '/api/mesh/history/:id', (req, res, p) => json(res, 200, mesh.history(decodeURIComponent(p.id))));
route('PUT', '/api/mesh/node/:id', async (req, res, p) => {
  mesh.rename(decodeURIComponent(p.id), (await body(req)).alias);
  json(res, 200, { ok: true });
});
route('DELETE', '/api/mesh/node/:id', (req, res, p) => {
  mesh.forget(decodeURIComponent(p.id));
  json(res, 200, { ok: true });
});
route('POST', '/api/mesh/send', async (req, res) => {
  const { text, to } = await body(req);
  mesh.send(String(text || '').slice(0, 200), to);
  json(res, 200, { ok: true });
});

// ESPHome-Dashboard (Geräteliste)
route('GET', '/api/esphome/devices', async (req, res) => {
  const url = store.settings().esphomeUrl;
  if (!url) return json(res, 200, { configured: [], importable: [] });
  const r = await fetch(url.replace(/\/$/, '') + '/devices', { signal: AbortSignal.timeout(5000) });
  json(res, r.status, await r.json());
});

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (pathname === '/healthz') return json(res, 200, { ok: true, version: VERSION });
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (!authed(req) && !['/api/auth', '/api/login'].includes(pathname)) return json(res, 401, { error: 'Anmeldung nötig' });
    for (const r of routes) {
      const m = r.method === req.method && pathname.match(r.re);
      if (m) return await r.handler(req, res, m.groups || {}, url.searchParams);
    }
    json(res, 404, { error: 'Unbekannter Endpunkt' });
  } catch (e) {
    console.error(req.method, pathname, e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Smart-Home-Dashboard ${VERSION} läuft auf http://0.0.0.0:${PORT} (Daten: ${store.DATA_DIR})`);
  ha.connect();
  mesh.restart();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    mesh.persist();
    process.exit(0);
  });
}
