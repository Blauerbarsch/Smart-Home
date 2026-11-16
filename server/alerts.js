// Regel-Engine für Alarme + Benachrichtigungen (HA-Notify, ntfy, Kopf, Browser).
import { EventEmitter } from 'node:events';
import { settings, readJson, writeJson, id } from './store.js';
import { q } from './db.js';
import { ha } from './ha.js';
import { mesh } from './mesh.js';
import dns from 'node:dns/promises';

const OPS = { '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '=': (a, b) => String(a) === String(b), '!=': (a, b) => String(a) !== String(b) };

export const RULE_TYPES = {
  mesh_offline: 'Mesh-Node offline',
  mesh_metric: 'Mesh-Messwert',
  entity: 'Home-Assistant-Wert',
  service_down: 'Dienst nicht erreichbar',
  container_stopped: 'Container/VM gestoppt',
};

const DEFAULT_RULES = [
  { id: 'r-mesh-offline', name: 'Mesh-Node länger offline', type: 'mesh_offline', node: '*', minutes: 120, enabled: true, cooldown: 360, channels: ['browser', 'ha', 'ntfy'] },
  { id: 'r-mesh-battery', name: 'Mesh-Akku niedrig', type: 'mesh_metric', node: '*', metric: 'battery', op: '<', value: 20, enabled: true, cooldown: 720, channels: ['browser', 'ha', 'ntfy'] },
];

const fmtMetric = { battery: ['Akku', '%'], temperature: ['Temperatur', '°C'], humidity: ['Feuchte', '%'], voltage: ['Spannung', 'V'], chUtil: ['Kanalauslastung', '%'], pressure: ['Luftdruck', 'hPa'] };

class Alerts extends EventEmitter {
  constructor() {
    super();
    const saved = readJson('alerts.json', { rules: DEFAULT_RULES, state: {} });
    this.rules = saved.rules;
    this.state = saved.state || {}; // key → {firing, since, notified}
    this.extra = {}; // Daten von außen (Dienst-Checks, Unraid)
  }

  save() {
    writeJson('alerts.json', { rules: this.rules, state: this.state });
  }

  start() {
    setInterval(() => this.evaluate().catch((e) => console.error('Alarme:', e.message)), 30000).unref();
  }

  setRules(rules) {
    this.rules = rules.map((r) => ({ id: r.id || id(), enabled: true, cooldown: 360, channels: ['browser'], ...r }));
    this.save();
  }

  /** Liefert die Einzelfälle einer Regel: [{key, firing, title, text}] */
  check(rule) {
    const now = Date.now();
    const nodes = Object.values(mesh.nodes).filter((n) => rule.node === '*' || !rule.node || n.id === rule.node);
    const name = (n) => n.alias || n.longName || n.shortName || n.id;
    switch (rule.type) {
      case 'mesh_offline':
        return nodes.filter((n) => n.lastSeen).map((n) => ({
          key: `${rule.id}:${n.id}`,
          firing: now - n.lastSeen > (rule.minutes || 120) * 60e3,
          title: `Mesh: ${name(n)} offline`,
          text: `${name(n)} meldet sich seit über ${Math.round((now - n.lastSeen) / 60e3)} Minuten nicht.`,
        }));
      case 'mesh_metric': {
        const [label, unit] = fmtMetric[rule.metric] || [rule.metric, ''];
        return nodes.filter((n) => typeof n[rule.metric] === 'number' && !(rule.metric === 'battery' && n.battery > 100)).map((n) => ({
          key: `${rule.id}:${n.id}`,
          firing: OPS[rule.op]?.(n[rule.metric], Number(rule.value)),
          title: `Mesh: ${name(n)} – ${label} ${n[rule.metric]}${unit}`,
          text: `${label} bei ${name(n)} liegt bei ${n[rule.metric]}${unit} (Grenze ${rule.op} ${rule.value}${unit}).`,
        }));
      }
      case 'entity': {
        const st = ha.states.get(rule.entity);
        if (!st) return [];
        const v = Number.isFinite(Number(st.state)) && st.state !== '' ? Number(st.state) : st.state;
        const cmp = Number.isFinite(Number(rule.value)) && typeof v === 'number' ? Number(rule.value) : rule.value;
        const ok = OPS[rule.op]?.(v, cmp);
        const forMs = (rule.minutes || 0) * 60e3;
        const firing = ok && now - Date.parse(st.last_changed) >= forMs;
        const fname = st.attributes.friendly_name || rule.entity;
        return [{ key: rule.id, firing, title: `${fname}: ${st.state}${st.attributes.unit_of_measurement || ''}`, text: `${fname} ist ${st.state}${st.attributes.unit_of_measurement || ''} (Regel: ${rule.op} ${rule.value}).` }];
      }
      case 'service_down': {
        const c = this.extra.services?.[rule.url];
        if (!c) return [];
        return [{ key: rule.id, firing: !c.ok && c.failCount >= 2, title: `Dienst nicht erreichbar: ${rule.label || rule.url}`, text: `${rule.label || rule.url} antwortet nicht (${c.error || 'Fehler'}).` }];
      }
      case 'container_stopped': {
        const o = this.extra.unraid;
        if (!o) return [];
        const item = [...(o.containers || []), ...(o.vms || [])].find((x) => x.name === rule.target);
        if (!item) return [];
        const running = ['RUNNING'].includes(String(item.state).toUpperCase());
        return [{ key: rule.id, firing: !running, title: `${rule.target} läuft nicht`, text: `${rule.target} ist im Zustand ${item.state}.` }];
      }
    }
    return [];
  }

  async evaluate() {
    const now = Date.now();
    for (const rule of this.rules.filter((r) => r.enabled)) {
      for (const c of this.check(rule)) {
        const st = (this.state[c.key] ||= { firing: false });
        if (c.firing && !st.firing) {
          st.firing = true;
          st.since = now;
        }
        if (c.firing && (!st.notified || now - st.notified > (rule.cooldown || 360) * 60e3)) {
          st.notified = now;
          await this.notify({ rule, level: 'warning', title: c.title, text: c.text });
        }
        if (!c.firing && st.firing) {
          st.firing = false;
          if (st.notified && rule.notifyResolved !== false) await this.notify({ rule, level: 'ok', title: 'Wieder in Ordnung: ' + c.title.replace(/^.*?: /, ''), text: c.text.split('.')[0] + ' – behoben.' });
          st.notified = 0;
        }
      }
    }
    this.save();
  }

  async notify({ rule, level = 'info', title, text, channels }) {
    const s = settings();
    const ch = channels || rule?.channels || ['browser'];
    q('INSERT INTO alerts (ts, rule, level, title, text) VALUES (?, ?, ?, ?, ?)').run(Date.now(), rule?.id || 'manual', level, title, text);
    const alert = { ts: Date.now(), rule: rule?.id, level, title, text };
    if (ch.includes('browser')) this.emit('alert', alert);
    const tasks = [];
    if (ch.includes('ha') && s.notifyHaService && ha.status === 'connected') {
      const [domain, service] = s.notifyHaService.includes('.') ? s.notifyHaService.split('.') : ['notify', s.notifyHaService];
      tasks.push(ha.callService(domain, service, { title, message: text }));
    }
    if (ch.includes('ntfy') && s.ntfyUrl) {
      // JSON-Veröffentlichung: Umlaute im Titel sind so kein Problem
      const u = new URL(s.ntfyUrl);
      const topic = u.pathname.split('/').filter(Boolean).pop();
      u.pathname = u.pathname.replace(/\/[^/]+\/?$/, '/') || '/';
      tasks.push(fetch(u.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(s.ntfyToken ? { Authorization: `Bearer ${s.ntfyToken}` } : {}) },
        body: JSON.stringify({ topic, title, message: text, tags: [level === 'ok' ? 'white_check_mark' : 'warning'], priority: level === 'ok' ? 3 : 4 }),
      }).then((r) => { if (!r.ok) throw new Error('ntfy ' + r.status); }));
    }
    // Mesh: immer, oder nur wenn das Internet weg ist (Notfallkanal)
    if (ch.includes('mesh') || (s.meshAlerts === 'always' && ch.length) || (s.meshAlerts === 'offline' && !(await internetUp()))) {
      if (mesh.status.connected && s.meshGatewayId) {
        tasks.push(Promise.resolve().then(() => mesh.send(`${level === 'ok' ? '✓' : '⚠'} ${title}: ${text}`.slice(0, 200), s.meshAlertTarget || 'all')));
      }
    }
    if ((ch.includes('kopf') || s.notifyKopf) && s.kopfOutputUrl) {
      tasks.push(fetch(s.kopfOutputUrl.replace(/\/$/, '') + '/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${title}. ${text}` }) }));
    }
    const res = await Promise.allSettled(tasks);
    res.filter((r) => r.status === 'rejected').forEach((r) => console.error('Benachrichtigung fehlgeschlagen:', r.reason?.message));
    return alert;
  }

  history(limit = 100) {
    return q('SELECT ts, rule, level, title, text FROM alerts ORDER BY ts DESC LIMIT ?').all(limit);
  }

  active() {
    return Object.entries(this.state).filter(([, s]) => s.firing).map(([key, s]) => ({ key, since: s.since }));
  }
}

let net = { ok: true, t: 0 };
async function internetUp() {
  if (Date.now() - net.t < 60000) return net.ok;
  try {
    await Promise.race([dns.resolve('github.com'), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))]);
    net = { ok: true, t: Date.now() };
  } catch {
    net = { ok: false, t: Date.now() };
  }
  return net.ok;
}

export const alerts = new Alerts();
