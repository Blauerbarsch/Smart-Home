// Langzeit-Speicher (SQLite, in Node ≥ 22.13 eingebaut).
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './store.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'history.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS mesh_metrics (node TEXT, metric TEXT, ts INTEGER, value REAL);
  CREATE INDEX IF NOT EXISTS mm_idx ON mesh_metrics (node, metric, ts);
  CREATE TABLE IF NOT EXISTS mesh_positions (node TEXT, ts INTEGER, lat REAL, lon REAL, alt REAL);
  CREATE INDEX IF NOT EXISTS mp_idx ON mesh_positions (node, ts);
  CREATE TABLE IF NOT EXISTS mesh_packets (ts INTEGER, node TEXT, port TEXT, gateway TEXT, hops INTEGER,
    rssi REAL, snr REAL, via_mqtt INTEGER, channel TEXT, size INTEGER);
  CREATE INDEX IF NOT EXISTS mpk_ts ON mesh_packets (ts);
  CREATE TABLE IF NOT EXISTS mesh_messages (id INTEGER, ts INTEGER, from_node TEXT, to_node TEXT, channel TEXT, text TEXT, gateway TEXT);
  CREATE INDEX IF NOT EXISTS mmsg_ts ON mesh_messages (ts);
  CREATE TABLE IF NOT EXISTS mesh_links (a TEXT, b TEXT, snr REAL, ts INTEGER, source TEXT, PRIMARY KEY (a, b, source));
  CREATE TABLE IF NOT EXISTS mesh_traces (ts INTEGER, from_node TEXT, to_node TEXT, route TEXT, snr TEXT, route_back TEXT, snr_back TEXT);
  CREATE TABLE IF NOT EXISTS alerts (ts INTEGER, rule TEXT, level TEXT, title TEXT, text TEXT, resolved INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS al_ts ON alerts (ts);
  CREATE TABLE IF NOT EXISTS service_checks (service TEXT, ts INTEGER, ok INTEGER, ms INTEGER);
  CREATE INDEX IF NOT EXISTS sc_idx ON service_checks (service, ts);
  CREATE TABLE IF NOT EXISTS project_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, ts INTEGER, text TEXT, image TEXT);
  CREATE INDEX IF NOT EXISTS pl_idx ON project_log (project, ts);
`);

const stmtCache = new Map();
export const q = (sql) => {
  if (!stmtCache.has(sql)) stmtCache.set(sql, db.prepare(sql));
  return stmtCache.get(sql);
};

/** Zeitreihe ausdünnen: höchstens `points` Werte (Mittelwert pro Zeitfenster). */
export function series(node, metric, sinceMs, points = 300) {
  const rows = q('SELECT ts, value FROM mesh_metrics WHERE node = ? AND metric = ? AND ts >= ? ORDER BY ts').all(node, metric, sinceMs);
  if (rows.length <= points) return rows.map((r) => [r.ts, r.value]);
  const bucket = Math.ceil(rows.length / points);
  const out = [];
  for (let i = 0; i < rows.length; i += bucket) {
    const slice = rows.slice(i, i + bucket);
    out.push([slice.at(-1).ts, slice.reduce((s, r) => s + r.value, 0) / slice.length]);
  }
  return out;
}

// Aufräumen: Pakete 30 Tage, Dienst-Checks 14 Tage, Alarme 180 Tage, Messwerte 2 Jahre.
function prune() {
  const d = 86400e3, now = Date.now();
  q('DELETE FROM mesh_packets WHERE ts < ?').run(now - 30 * d);
  q('DELETE FROM service_checks WHERE ts < ?').run(now - 14 * d);
  q('DELETE FROM alerts WHERE ts < ?').run(now - 180 * d);
  q('DELETE FROM mesh_metrics WHERE ts < ?').run(now - 730 * d);
  q('DELETE FROM mesh_positions WHERE ts < ?').run(now - 365 * d);
}
prune();
setInterval(prune, 6 * 3600e3).unref();
