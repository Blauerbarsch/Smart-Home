// Meshtastic über MQTT (JSON-Ausgabe des MQTT-Moduls).
// Sammelt Nodes, Positionen, Telemetrie und Textnachrichten und hält einen
// kleinen Verlauf pro Messwert.
import { EventEmitter } from 'node:events';
import { MqttClient } from './mqtt.js';
import { settings, readJson, writeJson } from './store.js';

const HISTORY_POINTS = 288; // z. B. 24 h bei 5-Minuten-Telemetrie
const MAX_MESSAGES = 300;
const METRICS = {
  battery_level: 'battery',
  voltage: 'voltage',
  channel_utilization: 'chUtil',
  air_util_tx: 'airUtil',
  uptime_seconds: 'uptime',
  temperature: 'temperature',
  relative_humidity: 'humidity',
  barometric_pressure: 'pressure',
  gas_resistance: 'gas',
  iaq: 'iaq',
  lux: 'lux',
  wind_speed: 'windSpeed',
  wind_direction: 'windDirection',
  weight: 'weight',
  current: 'current',
  pm25_standard: 'pm25',
};

const nodeId = (num) => '!' + (Number(num) >>> 0).toString(16).padStart(8, '0');

class Mesh extends EventEmitter {
  constructor() {
    super();
    const saved = readJson('mesh.json', { nodes: {}, messages: [] });
    this.nodes = saved.nodes || {};
    this.messages = saved.messages || [];
    this.seen = new Set();
    this.status = { connected: false, error: '' };
    this.lastTopic = '';
    this.mqtt = new MqttClient();
    this.mqtt.on('status', (s) => {
      this.status = { connected: s.connected, error: s.error || '' };
      this.emit('status', this.status);
    });
    this.mqtt.on('message', (topic, buf) => this.onMessage(topic, buf));
    this.dirty = false;
    setInterval(() => this.persist(), 60000).unref();
  }

  get configured() {
    return Boolean(settings().mqttUrl);
  }

  restart() {
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
    writeJson('mesh.json', { nodes: this.nodes, messages: this.messages });
  }

  node(num) {
    const nid = nodeId(num);
    return (this.nodes[nid] ||= { id: nid, num: Number(num) >>> 0, history: {}, firstSeen: Date.now() });
  }

  onMessage(topic, buf) {
    // Nur JSON-Topics auswerten; Protobuf (…/e/…) wird ignoriert.
    if (!topic.includes('/json/')) return;
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (msg.from === undefined) return;
    this.lastTopic = topic;

    const n = this.node(msg.from);
    const now = Date.now();
    n.lastSeen = now;
    if (msg.rssi) n.rssi = msg.rssi;
    if (msg.snr) n.snr = msg.snr;
    if (msg.hops_away !== undefined) n.hops = msg.hops_away;
    const gw = msg.sender;
    if (gw) n.via = gw;
    const p = msg.payload || {};
    const dupKey = `${msg.id}-${msg.type}`;
    const duplicate = msg.id && this.seen.has(dupKey);
    if (msg.id) {
      this.seen.add(dupKey);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    }

    switch (msg.type) {
      case 'nodeinfo':
        n.longName = p.longname || n.longName;
        n.shortName = p.shortname || n.shortName;
        n.hw = p.hardware ?? n.hw;
        n.role = p.role ?? n.role;
        break;
      case 'position':
        if (p.latitude_i) {
          n.lat = p.latitude_i / 1e7;
          n.lon = p.longitude_i / 1e7;
          n.alt = p.altitude;
          n.posTime = now;
          if (!duplicate) this.push(n, 'track', [n.lat, n.lon], 100);
        }
        break;
      case 'telemetry':
        for (const [k, key] of Object.entries(METRICS)) {
          if (typeof p[k] !== 'number') continue;
          n[key] = p[k];
          if (!duplicate && key !== 'uptime') this.push(n, key, p[k]);
        }
        break;
      case 'neighborinfo':
        n.neighbors = (p.neighbors || []).map((x) => ({ id: nodeId(x.node_id), snr: x.snr }));
        break;
      case 'text':
        if (!duplicate) {
          const m = {
            id: msg.id,
            time: (msg.timestamp ? msg.timestamp * 1000 : now),
            from: n.id,
            to: msg.to === 4294967295 ? 'all' : nodeId(msg.to),
            channel: msg.channel || 0,
            text: p.text ?? (typeof p === 'string' ? p : ''),
          };
          this.messages.push(m);
          if (this.messages.length > MAX_MESSAGES) this.messages.shift();
          this.emit('text', m);
        }
        break;
    }
    this.dirty = true;
    const { history, ...lite } = n;
    this.emit('node', lite);
  }

  push(n, key, value, max = HISTORY_POINTS) {
    const h = (n.history[key] ||= []);
    h.push([Date.now(), value]);
    if (h.length > max) h.splice(0, h.length - max);
  }

  list() {
    return Object.values(this.nodes).map(({ history, ...lite }) => lite);
  }

  history(nid) {
    return this.nodes[nid]?.history || {};
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
  }

  // msh/EU_868/2/json/LongFast/!abcd → msh/EU_868/2/json/mqtt/
  guessSendTopic() {
    const m = this.lastTopic.match(/^(.*\/json)\//);
    return m ? `${m[1]}/mqtt/` : '';
  }
}

export const mesh = new Mesh();
