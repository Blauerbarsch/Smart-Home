// Home-Assistant-Brücke: hält eine WebSocket-Verbindung zu HA,
// cached alle Zustände und verteilt Änderungen an die Browser (SSE).
import { EventEmitter } from 'node:events';
import { settings } from './store.js';

class HomeAssistant extends EventEmitter {
  constructor() {
    super();
    this.states = new Map();
    this.areas = [];
    this.entityAreas = {};
    this.devices = [];
    this.notifications = {};
    this.notifSub = null;
    this.status = 'disconnected';
    this.error = '';
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.retry = 0;
    this.timer = null;
  }

  get configured() {
    const s = settings();
    return Boolean(s.haUrl && s.haToken);
  }

  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    this.emit('status', { status, error });
  }

  restart() {
    clearTimeout(this.timer);
    this.retry = 0;
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connect();
  }

  connect() {
    if (!this.configured) {
      this.setStatus('unconfigured');
      return;
    }
    const { haUrl, haToken } = settings();
    const url = haUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/api/websocket';
    this.setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.setStatus('error', e.message);
      return this.scheduleReconnect();
    }
    this.ws = ws;

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: haToken }));
      } else if (msg.type === 'auth_invalid') {
        this.setStatus('error', 'Token ungültig');
        ws.onclose = null;
        ws.close();
      } else if (msg.type === 'auth_ok') {
        this.retry = 0;
        await this.bootstrap();
      } else if (msg.type === 'event' && msg.id === this.notifSub) {
        // persistent_notification/subscribe: current | added | updated | removed
        const ev = msg.event;
        if (ev.type === 'current') this.notifications = {};
        for (const [nid, n] of Object.entries(ev.notifications || {})) {
          if (ev.type === 'removed') delete this.notifications[nid];
          else this.notifications[nid] = n;
        }
        this.emit('notifications', Object.values(this.notifications));
      } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
        const { entity_id, new_state } = msg.event.data;
        if (new_state) this.states.set(entity_id, new_state);
        else this.states.delete(entity_id);
        this.emit('state', { entity_id, state: new_state });
      } else if (msg.type === 'result' && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.success ? resolve(msg.result) : reject(new Error(msg.error?.message || 'HA-Fehler'));
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('Verbindung getrennt'));
      this.pending.clear();
      this.setStatus('disconnected', this.error);
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Home Assistant nicht verbunden'));
      const msgId = this.msgId++;
      this.pending.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, ...payload }));
      setTimeout(() => {
        if (this.pending.has(msgId)) {
          this.pending.delete(msgId);
          reject(new Error('Zeitüberschreitung'));
        }
      }, 15000);
    });
  }

  async bootstrap() {
    try {
      const states = await this.send({ type: 'get_states' });
      this.states = new Map(states.map((s) => [s.entity_id, s]));
      await this.send({ type: 'subscribe_events', event_type: 'state_changed' });
      this.notifSub = this.msgId;
      this.send({ type: 'persistent_notification/subscribe' }).catch(() => (this.notifSub = null));
      try {
        this.areas = await this.send({ type: 'config/area_registry/list' });
        const ents = await this.send({ type: 'config/entity_registry/list' });
        this.devices = await this.send({ type: 'config/device_registry/list' });
        const devArea = Object.fromEntries(this.devices.map((d) => [d.id, d.area_id]));
        this.entityAreas = {};
        for (const e of ents) {
          const area = e.area_id || devArea[e.device_id];
          if (area) this.entityAreas[e.entity_id] = area;
        }
      } catch {
        // Registries sind nur mit Admin-Token lesbar – nicht schlimm.
      }
      this.setStatus('connected');
      this.emit('snapshot');
    } catch (e) {
      this.setStatus('error', e.message);
    }
  }

  dismissNotification(nid) {
    return this.callService('persistent_notification', 'dismiss', { notification_id: nid });
  }

  callService(domain, service, data = {}, target) {
    return this.send({
      type: 'call_service',
      domain,
      service,
      service_data: data,
      ...(target ? { target } : {}),
    });
  }

  /** Kompakte Liste für KI-Kontext / Entity-Picker. */
  summary(filter = '') {
    const f = filter.toLowerCase();
    const areaName = Object.fromEntries(this.areas.map((a) => [a.area_id, a.name]));
    return [...this.states.values()]
      .filter((s) => !f || s.entity_id.includes(f) || (s.attributes.friendly_name || '').toLowerCase().includes(f))
      .map((s) => ({
        entity_id: s.entity_id,
        name: s.attributes.friendly_name || s.entity_id,
        state: s.state,
        unit: s.attributes.unit_of_measurement,
        area: areaName[this.entityAreas[s.entity_id]],
      }));
  }

  /** Durchreichen an die HA-REST-API (z. B. Kamerabilder, Verlauf). */
  async rest(pathname, init = {}) {
    const { haUrl, haToken } = settings();
    if (!haUrl) throw new Error('Home Assistant nicht eingerichtet');
    return fetch(haUrl.replace(/\/$/, '') + pathname, {
      ...init,
      headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  }
}

export const ha = new HomeAssistant();
