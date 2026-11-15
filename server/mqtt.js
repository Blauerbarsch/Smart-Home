// Minimaler MQTT-3.1.1-Client (ohne Abhängigkeiten): verbinden, abonnieren,
// empfangen (QoS 0/1), senden (QoS 0), Keepalive, automatischer Reconnect.
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

function encLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};

const packet = (type, body) => Buffer.concat([Buffer.from([type]), encLen(body.length), body]);

export class MqttClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.subs = [];
    this.retry = 0;
    this.pid = 1;
    this.opts = null;
  }

  start(url, { username, password, subscribe = [] } = {}) {
    this.stop();
    if (!url) return;
    this.opts = { url, username, password };
    this.subs = subscribe;
    this.open();
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.opts = null;
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    this.connected = false;
  }

  open() {
    const u = new URL(this.opts.url);
    const secure = u.protocol === 'mqtts:';
    const port = Number(u.port) || (secure ? 8883 : 1883);
    const sock = secure
      ? tls.connect({ host: u.hostname, port, rejectUnauthorized: false })
      : net.connect({ host: u.hostname, port });
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on(secure ? 'secureConnect' : 'connect', () => this.sendConnect());
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => this.emit('status', { connected: false, error: e.message }));
    sock.on('close', () => {
      clearInterval(this.pingTimer);
      const was = this.connected;
      this.connected = false;
      if (was) this.emit('status', { connected: false });
      if (this.opts) {
        const delay = Math.min(30000, 1000 * 2 ** this.retry++);
        this.reconnectTimer = setTimeout(() => this.opts && this.open(), delay);
      }
    });
  }

  sendConnect() {
    const { username, password } = this.opts;
    let flags = 0x02; // clean session
    if (username) flags |= 0x80;
    if (password) flags |= 0x40;
    const clientId = 'smarthome-' + Math.random().toString(16).slice(2, 10);
    const keepAlive = Buffer.alloc(2);
    keepAlive.writeUInt16BE(60);
    const body = Buffer.concat([
      str('MQTT'),
      Buffer.from([4, flags]),
      keepAlive,
      str(clientId),
      ...(username ? [str(username)] : []),
      ...(password ? [str(password)] : []),
    ]);
    this.sock.write(packet(0x10, body));
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      let mult = 1, len = 0, i = 1, b;
      do {
        if (i >= this.buf.length) return;
        b = this.buf[i++];
        len += (b & 127) * mult;
        mult *= 128;
      } while (b & 128);
      if (this.buf.length < i + len) return;
      const header = this.buf[0];
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      this.handle(header, body);
    }
  }

  handle(header, body) {
    const type = header >> 4;
    if (type === 2) {
      // CONNACK
      if (body[1] !== 0) {
        this.emit('status', { connected: false, error: `Broker lehnt ab (Code ${body[1]})` });
        return;
      }
      this.connected = true;
      this.retry = 0;
      this.emit('status', { connected: true });
      for (const t of this.subs) this.subscribe(t);
      this.pingTimer = setInterval(() => this.sock?.write(Buffer.from([0xc0, 0])), 30000);
    } else if (type === 3) {
      // PUBLISH
      const qos = (header >> 1) & 3;
      const tlen = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + tlen).toString('utf8');
      let off = 2 + tlen;
      if (qos > 0) {
        const pid = body.readUInt16BE(off);
        off += 2;
        const ack = Buffer.alloc(2);
        ack.writeUInt16BE(pid);
        this.sock.write(packet(0x40, ack));
      }
      this.emit('message', topic, body.subarray(off));
    }
  }

  subscribe(topic) {
    const pid = Buffer.alloc(2);
    pid.writeUInt16BE(this.pid++ & 0xffff || 1);
    this.sock.write(packet(0x82, Buffer.concat([pid, str(topic), Buffer.from([0])])));
  }

  publish(topic, payload) {
    if (!this.connected) throw new Error('MQTT nicht verbunden');
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    this.sock.write(packet(0x30, Buffer.concat([str(topic), data])));
  }
}
