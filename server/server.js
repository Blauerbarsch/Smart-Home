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
import { alerts, RULE_TYPES } from './alerts.js';
import { github, APP_COMMIT } from './github.js';
import * as unraid from './unraid.js';
import * as services from './services.js';
import * as maker from './maker.js';

const PORT = Number(process.env.PORT || 8080);
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const PASSWORD = process.env.APP_PASSWORD || '';
const VERSION = '0.2.0';

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
mesh.on('trace', (t) => broadcast('mesh-trace', t));
ha.on('notifications', (n) => broadcast('ha-notifications', n));
alerts.on('alert', (a) => broadcast('alert', a));
github.on('update', (u) => broadcast('app-update', u));
github.on('synced', async (r) => broadcast('projects', { projects: store.projects.list, ...r }));
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

async function rawBody(req, limit = 5e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Anfrage zu groß');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function body(req) {
  const raw = (await rawBody(req)).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
    commit: APP_COMMIT,
    update: github.update,
    auth: Boolean(PASSWORD),
    container: process.env.HOST_CONTAINERNAME || null,
    haNotifications: Object.values(ha.notifications),
    activeAlerts: alerts.active(),
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
  if (['mqttUrl', 'mqttUser', 'mqttPassword', 'meshTopic', 'meshKeys'].some((k) => k in patch)) mesh.restart();
  if (['githubUser', 'githubToken', 'githubAutoProjects'].some((k) => k in patch)) github.sync().catch(() => {});
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
  const proj = store.projects.get(p.id);
  if (proj?.repo) github.ignore(proj.repo); // gelöschte Repo-Projekte nicht wieder anlegen
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
route('GET', '/api/mesh/history/:id', (req, res, p, q) => json(res, 200, mesh.history(decodeURIComponent(p.id), Number(q.get('days')) || 7)));
route('GET', '/api/mesh/analysis', (req, res, p, q) => json(res, 200, mesh.analysis(Math.min(Number(q.get('hours')) || 24, 24 * 30))));
route('GET', '/api/mesh/links', (req, res, p, q) => json(res, 200, mesh.links(Number(q.get('days')) || 7)));
route('GET', '/api/mesh/traces', (req, res) => json(res, 200, mesh.traces()));
route('GET', '/api/mesh/messages', (req, res, p, q) => json(res, 200, mesh.messagesFor(q.get('node'), 300)));
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
  if (!store.settings().esphomeUrl) return json(res, 200, { configured: [], importable: [] });
  json(res, 200, await maker.espDevices());
});

// Alarme
route('GET', '/api/alerts', (req, res) => json(res, 200, { rules: alerts.rules, types: RULE_TYPES, history: alerts.history(), active: alerts.active() }));
route('PUT', '/api/alerts/rules', async (req, res) => {
  alerts.setRules((await body(req)).rules || []);
  json(res, 200, { rules: alerts.rules });
});
route('POST', '/api/alerts/test', async (req, res) => {
  const { channels } = await body(req);
  await alerts.notify({ level: 'info', title: 'Test vom Smart-Home-Dashboard', text: 'Wenn du das liest, funktionieren die Benachrichtigungen.', channels });
  json(res, 200, { ok: true });
});
route('POST', '/api/ha/notifications/:id/dismiss', async (req, res, p) => {
  await ha.dismissNotification(decodeURIComponent(p.id));
  json(res, 200, { ok: true });
});

// Unraid
route('GET', '/api/unraid', async (req, res, p, q) => json(res, 200, await unraid.overview(q.get('force') === '1')));
route('POST', '/api/unraid/:kind/:id/:action', async (req, res, p) => {
  const id = decodeURIComponent(p.id);
  const r = p.kind === 'vm' ? await unraid.vmAction(id, p.action) : await unraid.containerAction(id, p.action);
  json(res, 200, { ok: true, result: r });
});
route('GET', '/api/unraid/notifications', async (req, res) => json(res, 200, await unraid.notifications()));

// Dashboard-Update
route('GET', '/api/update', async (req, res, p, q) => json(res, 200, q.get('check') ? await github.checkUpdate() : github.update));
route('POST', '/api/update', async (req, res) => json(res, 200, await unraid.selfUpdate()));

// GitHub
route('GET', '/api/github/repos', (req, res) => json(res, 200, { repos: github.repos, synced: github.synced, error: github.error }));
route('POST', '/api/github/sync', async (req, res) => json(res, 200, { ...(await github.sync()), projects: store.projects.list }));
route('GET', '/api/github/repo/:owner/:name', async (req, res, p) => json(res, 200, await github.details(`${p.owner}/${p.name}`)));

// Dienste, JSON-Kacheln, Drucker
route('GET', '/api/services', (req, res) => json(res, 200, services.status()));
route('POST', '/api/services/check', async (req, res) => { await services.checkAll(); json(res, 200, services.status()); });
route('GET', '/api/tile-json/:id', async (req, res, p) => json(res, 200, await services.fetchTileJson(p.id)));
route('GET', '/api/printer/:id', async (req, res, p) => json(res, 200, await maker.printerStatus(p.id)));
route('GET', '/api/printer/:id/snapshot', async (req, res, p) => pipeFetch(res, await maker.printerSnapshot(p.id)));

// Uploads + Projekt-Tagebuch
route('POST', '/api/upload', async (req, res) => {
  const url = maker.saveUpload(await rawBody(req, 15e6), String(req.headers['content-type'] || '').split(';')[0]);
  json(res, 200, { url });
});
route('GET', '/api/uploads/:file', (req, res, p) => {
  const f = maker.uploadPath(p.file);
  if (!f) return json(res, 404, { error: 'nicht gefunden' });
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || ({ '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' })[path.extname(f)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' });
  fs.createReadStream(f).pipe(res);
});
route('GET', '/api/projects/:id/log', (req, res, p) => json(res, 200, maker.diary.list(p.id)));
route('POST', '/api/projects/:id/log', async (req, res, p) => json(res, 200, maker.diary.add(p.id, await body(req))));
route('DELETE', '/api/projects/:id/log/:logId', (req, res, p) => { maker.diary.remove(p.id, Number(p.logId)); json(res, 200, { ok: true }); });

// InvenTree
route('GET', '/api/inventree/search', async (req, res, p, q) => json(res, 200, await maker.inventreeSearch(q.get('q') || '')));
route('GET', '/api/inventree/parts', async (req, res, p, q) => json(res, 200, await maker.inventreeParts((q.get('ids') || '').split(',').filter(Boolean))));

// ESPHome
route('GET', '/api/esphome/config', async (req, res, p, q) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(await maker.espConfig(q.get('configuration')));
});
route('PUT', '/api/esphome/config', async (req, res, p, q) => {
  await maker.espSaveConfig(q.get('configuration'), (await rawBody(req)).toString('utf8'));
  json(res, 200, { ok: true });
});
route('POST', '/api/esphome/run', async (req, res) => {
  const { configuration, action } = await body(req);
  const emit = sse(res);
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const code = await maker.espRun(configuration, action, (line) => emit('line', { line }), ctrl.signal);
    emit('exit', { code });
  } catch (e) {
    emit('error', { message: e.message });
  }
  res.end();
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
  alerts.start();
  github.start();
  services.startChecks();
  // Unraid-Daten für Alarme (Container/VM gestoppt) regelmäßig holen
  setInterval(() => unraid.overview().then((o) => (alerts.extra.unraid = o)).catch(() => {}), 60000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    mesh.persist();
    process.exit(0);
  });
}
