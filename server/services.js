// Erreichbarkeit von Diensten (App-Kacheln mit Statusprüfung, Regeln) + JSON-Kacheln.
import { layout } from './store.js';
import { q } from './db.js';
import { alerts } from './alerts.js';

const state = {}; // url → {ok, ms, ts, status, error, failCount}

function targets() {
  const urls = new Map();
  for (const tab of layout().tabs) {
    for (const t of tab.tiles || []) {
      if (t.type === 'app' && t.check && /^https?:\/\//.test(t.url || '')) urls.set(t.checkUrl || t.url, t.title);
      if (t.type === 'service' && t.url) urls.set(t.url, t.title);
    }
  }
  for (const r of alerts.rules) if (r.type === 'service_down' && r.url) urls.set(r.url, r.label);
  return urls;
}

async function checkOne(url) {
  const t0 = Date.now();
  const prev = state[url] || { failCount: 0 };
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
    res.body?.cancel?.();
    const ok = res.status < 500;
    state[url] = { ok, ms: Date.now() - t0, ts: Date.now(), status: res.status, failCount: ok ? 0 : prev.failCount + 1 };
  } catch (e) {
    state[url] = { ok: false, ms: null, ts: Date.now(), error: e.cause?.code || e.name || e.message, failCount: prev.failCount + 1 };
  }
  q('INSERT INTO service_checks (service, ts, ok, ms) VALUES (?, ?, ?, ?)').run(url, Date.now(), state[url].ok ? 1 : 0, state[url].ms);
}

export async function checkAll() {
  await Promise.all([...targets().keys()].map(checkOne));
  alerts.extra.services = state;
}

export function status() {
  const since = Date.now() - 86400e3;
  const out = {};
  for (const url of targets().keys()) {
    const r = q('SELECT AVG(ok) AS up, COUNT(*) AS n FROM service_checks WHERE service = ? AND ts >= ?').get(url, since);
    out[url] = { ...(state[url] || {}), uptime24h: r.n ? Math.round(r.up * 1000) / 10 : null };
  }
  return out;
}

export function startChecks() {
  setTimeout(checkAll, 4000);
  setInterval(checkAll, 60000).unref();
}

/** JSON für eine JSON-Kachel holen (URL und Header stehen serverseitig in der Kachel). */
export async function fetchTileJson(tileId) {
  let tile;
  for (const tab of layout().tabs) tile ||= (tab.tiles || []).find((t) => t.id === tileId && t.type === 'json');
  if (!tile?.url) throw new Error('Kachel nicht gefunden');
  const headers = { accept: 'application/json' };
  for (const line of String(tile.headers || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const res = await fetch(tile.url, { signal: AbortSignal.timeout(8000), headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
