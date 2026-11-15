// Meshtastic über MQTT: versteht die Protobuf-Pakete (…/2/e/…, auch verschlüsselt)
// und die JSON-Ausgabe (…/2/json/…). Nodes, Telemetrie, Positionen, Nachrichten,
// Nachbarschaften und Traceroutes landen in SQLite.
import { EventEmitter } from 'node:events';
import { MqttClient } from './mqtt.js';
import { settings, readJson, writeJson } from './store.js';
import { db, q, series } from './db.js';
import { decodeEnvelope, expandKey, HW_MODELS } from './meshproto.js';

const METRICS = {
  battery_level: 'battery', voltage: 'voltage', channel_utilization: 'chUtil', air_util_tx: 'airUtil', uptime_seconds: 'uptime',
  temperature: 'temperature', relative_humidity: 'humidity', barometric_pressure: 'pressure', gas_resistance: 'gas', iaq: 'iaq',
  lux: 'lux', wind_speed: 'windSpeed', wind_direction: 'windDirection', wind_gust: 'windGust', weight: 'weight', current: 'current',
  pm25_standard: 'pm25', pm10_standard: 'pm10', co2: 'co2', rainfall_1h: 'rain1h', soil_moisture: 'soilMoisture', soil_temperature: 'soilTemp',
  ch1_voltage: 'ch1Voltage', ch1_current: 'ch1Current',
};
const ROLES = ['Client', 'Client Mute', 'Router', 'Router Client', 'Repeater', 'Tracker', 'Sensor', 'TAK', 'Client Hidden', 'Lost & Found', 'TAK Tracker', 'Router Late', 'Client Base'];
const BROADCAST = 0xffffffff;
const MAX_MESSAGES = 300;

export const nodeId = (num) => '!' + (Number(num) >>> 0).toString(16).padStart(8, '0');

class Mesh extends EventEmitter {
  constructor() {
    super();
    const saved = readJson('mesh.json', { nodes: {}, messages: [] });
    this.nodes = saved.nodes || {};
    this.migrate(saved);
    this.messages = q('SELECT id, ts AS time, from_node AS "from", to_node AS "to", channel, text FROM mesh_messages ORDER BY ts DESC LIMIT ?')
      .all(MAX_MESSAGES).reverse();
    this.seen = new Map();
    this.status = { connected: false, error: '' };
    this.lastTopic = '';
    this.stats = { packets: 0, decoded: 0, encrypted: 0, json: 0 };
    this.mqtt = new MqttClient();
    this.mqtt.on('status', (s) => {
      this.status = { connected: s.connected, error: s.error || '' };
      this.emit('status', this.status);
    });
    this.mqtt.on('message', (topic, buf) => this.onMessage(topic, buf));
    this.dirty = false;
    this.keys = new Map();
    setInterval(() => this.persist(), 60000).unref();
  }

  /** Alte Verläufe aus mesh.json (Version 0.1) einmalig in SQLite übernehmen. */
  migrate(saved) {
    let moved = 0;
    const ins = q('INSERT INTO mesh_metrics (node, metric, ts, value) VALUES (?, ?, ?, ?)');
    const pos = q('INSERT INTO mesh_positions (node, ts, lat, lon, alt) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const n of Object.values(this.nodes)) {
      for (const [metric, points] of Object.entries(n.history || {})) {
        for (const [ts, v] of points) {
          if (metric === 'track') pos.run(n.id, ts, v[0], v[1], null);
          else ins.run(n.id, metric, ts, v);
          moved++;
        }
      }
      delete n.history;
    }
    const msg = q('INSERT INTO mesh_messages (id, ts, from_node, to_node, channel, text) VALUES (?, ?, ?, ?, ?, ?)');
    for (const m of saved.messages || []) msg.run(m.id || 0, m.time, m.from, m.to, String(m.channel ?? 0), m.text);
    db.exec('COMMIT');
    if (moved || saved.messages?.length) {
      writeJson('mesh.json', { nodes: this.nodes });
      console.log(`Mesh: ${moved} Verlaufswerte und ${saved.messages?.length || 0} Nachrichten nach SQLite übernommen`);
    }
  }

  get configured() {
    return Boolean(settings().mqttUrl);
  }

  loadKeys() {
    // „LongFast=AQ==; Privat=abc…“ → Map Kanalname → Schlüssel. Standard-Schlüssel ist immer dabei.
    this.keys = new Map([['LongFast', expandKey('AQ==')]]);
    for (const part of String(settings().meshKeys || '').split(/[;\n,]/)) {
      const i = part.indexOf('=');
      if (i < 1) continue;
      const name = part.slice(0, i).trim(), key = part.slice(i + 1).trim();
      const k = expandKey(key);
      if (k) this.keys.set(name, k);
    }
  }

  restart() {
    this.loadKeys();
    const s = settings();
    if (!s.mqttUrl) {
      this.mqtt.stop();
      this.status = { connected: false, error: '' };
      this.emit('status', this.status);
      return;
    }
    const topics = String(s.meshTopic || 'msh/#').split(',').map((t) => t.trim()).filter(Boolean);
    this.mqtt.start(s.mqttUrl, { username: s.mqttUser, password: s.mqttPassword, subscribe: topics });
  }

  persist() {
    if (!this.dirty) return;
    this.dirty = false;
    writeJson('mesh.json', { nodes: this.nodes });
  }

  node(num) {
    const nid = nodeId(num);
    return (this.nodes[nid] ||= { id: nid, num: Number(num) >>> 0, firstSeen: Date.now() });
  }

  onMessage(topic, buf) {
    let msg;
    if (topic.includes('/json/')) {
      try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
      this.stats.json++;
    } else if (topic.includes('/e/') || topic.includes('/map/')) {
      try { msg = decodeEnvelope(buf, this.keys); } catch { return; }
      if (!msg) return;
      if (msg.type === 'encrypted') this.stats.encrypted++;
      else this.stats.decoded++;
    } else return;
    if (msg.from === undefined) return;
    this.stats.packets++;
    this.lastTopic = topic;
    this.handle(msg, topic);
  }

  handle(msg, topic) {
    const now = Date.now();
    const n = this.node(msg.from);
    const p = msg.payload || {};

    // Doppelte Pakete (mehrere Gateways) erkennen; das erste zählt, weitere ergänzen nur die Gateway-Liste.
    const key = msg.id ? `${msg.from}-${msg.id}` : null;
    const dup = key && this.seen.has(key);
    if (key) {
      const gws = this.seen.get(key) || new Set();
      if (msg.sender) gws.add(msg.sender);
      this.seen.set(key, gws);
      if (this.seen.size > 6000) this.seen = new Map([...this.seen].slice(-3000));
    }

    n.lastSeen = now;
    if (!dup) {
      if (msg.rssi) n.rssi = msg.rssi;
      if (msg.snr) n.snr = msg.snr;
      if (msg.hops_away !== undefined) n.hops = msg.hops_away;
      if (msg.sender) n.via = msg.sender;
      n.source = msg.via_mqtt ? 'mqtt' : 'rf';
      n.channel = msg.channel_id || n.channel;
      n.lastPort = msg.type;
      q('INSERT INTO mesh_packets (ts, node, port, gateway, hops, rssi, snr, via_mqtt, channel, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now, n.id, msg.type, msg.sender || null, msg.hops_away ?? null, msg.rssi ?? null, msg.snr ?? null, msg.via_mqtt ? 1 : 0, msg.channel_id || String(msg.channel ?? ''), 0);
    }
    // Direkte Funkverbindung Gateway ↔ Sender (0 Hops, nicht über MQTT)
    if (msg.sender && msg.hops_away === 0 && !msg.via_mqtt && msg.sender !== n.id && msg.snr !== undefined) {
      this.link(n.id, msg.sender, msg.snr, 'heard');
    }
    if (dup) { this.dirty = true; return this.emitNode(n); }

    switch (msg.type) {
      case 'nodeinfo':
      case 'mapreport':
        n.longName = p.longname || n.longName;
        n.shortName = p.shortname || n.shortName;
        if (p.hardware !== undefined) { n.hw = p.hardware; n.hwName = HW_MODELS[p.hardware] || `Modell ${p.hardware}`; }
        if (p.role !== undefined) n.role = ROLES[p.role] || p.role;
        if (p.firmware_version) n.firmware = p.firmware_version;
        if (msg.type === 'mapreport' && p.latitude_i) this.position(n, p, now);
        break;
      case 'position':
        if (p.latitude_i) this.position(n, p, now);
        break;
      case 'telemetry': {
        const ins = q('INSERT INTO mesh_metrics (node, metric, ts, value) VALUES (?, ?, ?, ?)');
        for (const [k, keyName] of Object.entries(METRICS)) {
          if (typeof p[k] !== 'number') continue;
          n[keyName] = p[k];
          if (keyName !== 'uptime') ins.run(n.id, keyName, now, p[k]);
        }
        break;
      }
      case 'neighborinfo':
        n.neighbors = (p.neighbors || []).map((x) => ({ id: nodeId(x.node_id), snr: x.snr }));
        for (const x of n.neighbors) this.link(n.id, x.id, x.snr, 'neighbor');
        break;
      case 'traceroute': {
        // Antwort auf einen Traceroute: route = Hops hin, route_back = Hops zurück
        const route = (p.route || []).map(nodeId);
        const back = (p.route_back || []).map(nodeId);
        const from = msg.dest !== undefined ? nodeId(msg.dest) : nodeId(msg.to);
        const trace = { ts: now, from, to: n.id, route, snr: (p.snr_towards || []).map((s) => s / 4), routeBack: back, snrBack: (p.snr_back || []).map((s) => s / 4) };
        q('INSERT INTO mesh_traces (ts, from_node, to_node, route, snr, route_back, snr_back) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(now, trace.from, trace.to, JSON.stringify(route), JSON.stringify(trace.snr), JSON.stringify(back), JSON.stringify(trace.snrBack));
        const hops = [trace.from, ...route, trace.to];
        hops.slice(1).forEach((h, i) => this.link(hops[i], h, trace.snr[i] ?? null, 'trace'));
        this.emit('trace', trace);
        break;
      }
      case 'text': {
        const m = {
          id: msg.id, time: msg.timestamp ? msg.timestamp * 1000 : now, from: n.id,
          to: msg.to === BROADCAST || msg.to === undefined ? 'all' : nodeId(msg.to),
          channel: msg.channel_id || String(msg.channel ?? 0), text: p.text ?? (typeof p === 'string' ? p : ''),
        };
        q('INSERT INTO mesh_messages (id, ts, from_node, to_node, channel, text, gateway) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(m.id || 0, m.time, m.from, m.to, m.channel, m.text, msg.sender || null);
        this.messages.push(m);
        if (this.messages.length > MAX_MESSAGES) this.messages.shift();
        this.emit('text', m);
        break;
      }
    }
    this.dirty = true;
    this.emitNode(n);
  }

  emitNode(n) {
    this.emit('node', n);
  }

  position(n, p, now) {
    n.lat = p.latitude_i / 1e7;
    n.lon = p.longitude_i / 1e7;
    if (p.altitude !== undefined) n.alt = p.altitude;
    if (p.precision_bits) n.precision = p.precision_bits;
    n.posTime = now;
    q('INSERT INTO mesh_positions (node, ts, lat, lon, alt) VALUES (?, ?, ?, ?, ?)').run(n.id, now, n.lat, n.lon, n.alt ?? null);
  }

  link(a, b, snr, source) {
    const [x, y] = a < b ? [a, b] : [b, a];
    q('INSERT OR REPLACE INTO mesh_links (a, b, snr, ts, source) VALUES (?, ?, ?, ?, ?)').run(x, y, snr, Date.now(), source);
  }

  list() {
    return Object.values(this.nodes);
  }

  history(nid, days = 7) {
    const since = Date.now() - days * 86400e3;
    const metrics = q('SELECT DISTINCT metric FROM mesh_metrics WHERE node = ? AND ts >= ?').all(nid, since).map((r) => r.metric);
    const out = Object.fromEntries(metrics.map((m) => [m, series(nid, m, since)]));
    out.track = q('SELECT ts, lat, lon FROM mesh_positions WHERE node = ? AND ts >= ? ORDER BY ts').all(nid, since).map((r) => [r.ts, [r.lat, r.lon]]);
    return out;
  }

  links(days = 7) {
    return q('SELECT a, b, snr, ts, source FROM mesh_links WHERE ts >= ?').all(Date.now() - days * 86400e3);
  }

  traces(limit = 30) {
    return q('SELECT * FROM mesh_traces ORDER BY ts DESC LIMIT ?').all(limit).map((t) => ({
      ts: t.ts, from: t.from_node, to: t.to_node, route: JSON.parse(t.route), snr: JSON.parse(t.snr), routeBack: JSON.parse(t.route_back), snrBack: JSON.parse(t.snr_back),
    }));
  }

  messagesFor(node, limit = 200) {
    if (!node) return this.messages.slice(-limit);
    return q('SELECT id, ts AS time, from_node AS "from", to_node AS "to", channel, text FROM mesh_messages WHERE from_node = ? OR to_node = ? ORDER BY ts DESC LIMIT ?')
      .all(node, node, limit).reverse();
  }

  /** Netz-Statistik für die Analyse-Ansicht. */
  analysis(hours = 24) {
    const since = Date.now() - hours * 3600e3;
    const bucket = hours <= 24 ? 3600e3 : 6 * 3600e3;
    const perTime = q('SELECT (ts / ?) * ? AS t, COUNT(*) AS n FROM mesh_packets WHERE ts >= ? GROUP BY t ORDER BY t').all(bucket, bucket, since).map((r) => [r.t, r.n]);
    const byPort = Object.fromEntries(q('SELECT port, COUNT(*) AS n FROM mesh_packets WHERE ts >= ? GROUP BY port ORDER BY n DESC').all(since).map((r) => [r.port, r.n]));
    const byNode = q('SELECT node, COUNT(*) AS n FROM mesh_packets WHERE ts >= ? GROUP BY node ORDER BY n DESC LIMIT 15').all(since);
    const gateways = q('SELECT gateway, COUNT(*) AS n FROM mesh_packets WHERE ts >= ? AND gateway IS NOT NULL GROUP BY gateway ORDER BY n DESC').all(since);
    const hops = Object.fromEntries(q('SELECT hops, COUNT(*) AS n FROM mesh_packets WHERE ts >= ? AND hops IS NOT NULL GROUP BY hops ORDER BY hops').all(since).map((r) => [r.hops, r.n]));
    const source = Object.fromEntries(q('SELECT via_mqtt, COUNT(*) AS n FROM mesh_packets WHERE ts >= ? GROUP BY via_mqtt').all(since).map((r) => [r.via_mqtt ? 'mqtt' : 'rf', r.n]));
    const chUtil = q("SELECT node, AVG(value) AS avg, MAX(value) AS max FROM mesh_metrics WHERE metric = 'chUtil' AND ts >= ? GROUP BY node ORDER BY avg DESC").all(since);
    const links = this.links(Math.max(1, hours / 24)).map((l) => {
      const A = this.nodes[l.a], B = this.nodes[l.b];
      const dist = A?.lat && B?.lat ? distance(A.lat, A.lon, B.lat, B.lon) : null;
      return { ...l, dist };
    }).filter((l) => l.dist).sort((a, b) => b.dist - a.dist).slice(0, 10);
    const total = Object.values(byPort).reduce((s, n) => s + n, 0);
    const active = Object.values(this.nodes).filter((n) => n.lastSeen >= since).length;
    return { hours, total, active, nodes: Object.keys(this.nodes).length, perTime, byPort, byNode, gateways, hops, source, chUtil, longestLinks: links, counters: this.stats };
  }

  rename(nid, alias) {
    if (!this.nodes[nid]) return;
    this.nodes[nid].alias = alias;
    this.dirty = true;
  }

  forget(nid) {
    delete this.nodes[nid];
    this.dirty = true;
  }

  send(text, to) {
    const s = settings();
    if (!s.meshGatewayId) throw new Error('Gateway-Node in den Einstellungen eintragen');
    const gw = s.meshGatewayId.replace(/^!/, '');
    const topic = s.meshSendTopic || this.guessSendTopic();
    if (!topic) throw new Error('Sende-Topic unbekannt – in den Einstellungen eintragen');
    const payload = {
      from: parseInt(gw, 16),
      type: 'sendtext',
      channel: Number(s.meshChannel) || 0,
      payload: text,
      ...(to && to !== 'all' ? { to: parseInt(to.replace(/^!/, ''), 16) } : {}),
    };
    this.mqtt.publish(topic, JSON.stringify(payload));
    // Eigene Nachricht direkt in den Verlauf
    const m = { id: 0, time: Date.now(), from: '!' + gw.padStart(8, '0'), to: to || 'all', channel: String(payload.channel), text, own: true };
    q('INSERT INTO mesh_messages (id, ts, from_node, to_node, channel, text, gateway) VALUES (?, ?, ?, ?, ?, ?, ?)').run(0, m.time, m.from, m.to, m.channel, text, 'dashboard');
    this.messages.push(m);
    this.emit('text', m);
  }

  // msh/EU_868/2/e/LongFast/!abcd → msh/EU_868/2/json/mqtt/
  guessSendTopic() {
    const m = this.lastTopic.match(/^(.*?\/2)\/(e|json|map)\//);
    return m ? `${m[1]}/json/mqtt/` : '';
  }
}

export function distance(lat1, lon1, lat2, lon2) {
  const R = 6371e3, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const mesh = new Mesh();
