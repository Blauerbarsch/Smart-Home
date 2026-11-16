// Feldbus ohne Abhängigkeiten: Modbus TCP (SPS wie S7-1200/1500 mit MB_SERVER, LOGO! 8,
// Netzteile, Zähler) und SCPI über TCP (Labornetzteile, Multimeter, Oszilloskope).
import net from 'node:net';

let tid = 1;

function modbusRequest({ host, port = 502, unit = 1, pdu, timeout = 4000 }) {
  return new Promise((resolve, reject) => {
    const id = tid++ & 0xffff;
    const head = Buffer.alloc(7);
    head.writeUInt16BE(id, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(pdu.length + 1, 4);
    head.writeUInt8(unit, 6);
    const sock = net.connect({ host, port: Number(port) });
    let buf = Buffer.alloc(0);
    const done = (err, val) => { clearTimeout(t); sock.destroy(); err ? reject(err) : resolve(val); };
    const t = setTimeout(() => done(new Error(`Modbus ${host}: Zeitüberschreitung`)), timeout);
    sock.on('connect', () => sock.write(Buffer.concat([head, pdu])));
    sock.on('error', (e) => done(new Error(`Modbus ${host}: ${e.code || e.message}`)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 7) return;
      const len = buf.readUInt16BE(4);
      if (buf.length < 6 + len) return;
      const resp = buf.subarray(7, 6 + len);
      if (resp[0] & 0x80) return done(new Error(`Modbus-Fehler ${resp[1]} (${EXC[resp[1]] || 'unbekannt'})`));
      done(null, resp);
    });
  });
}
const EXC = { 1: 'Funktion nicht unterstützt', 2: 'Adresse ungültig', 3: 'Wert ungültig', 4: 'Gerätefehler', 6: 'Gerät beschäftigt', 11: 'Gateway: Ziel antwortet nicht' };

/** Register lesen. fn 3 = Holding, 4 = Input. type: u16 i16 u32 i32 f32 (wordSwap für Little-Endian-Wortfolge). */
export async function modbusRead({ host, port, unit, fn = 3, address, dtype, type, scale = 1, wordSwap = false }) {
  // Datentyp heißt „dtype“ (bei Messquellen ist „type“ schon die Quellenart); „type“ nur bei SPS-Signalen
  type = dtype || (['u16', 'i16', 'u32', 'i32', 'f32'].includes(type) ? type : 'u16');
  const words = ['u32', 'i32', 'f32'].includes(type) ? 2 : 1;
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(Number(fn), 0);
  pdu.writeUInt16BE(Number(address), 1);
  pdu.writeUInt16BE(words, 3);
  if (Number(fn) === 1 || Number(fn) === 2) {
    pdu.writeUInt16BE(1, 3);
    const r = await modbusRequest({ host, port, unit, pdu });
    return r[2] & 1;
  }
  const r = await modbusRequest({ host, port, unit, pdu });
  let data = Buffer.from(r.subarray(2, 2 + words * 2));
  if (words === 2 && wordSwap) data = Buffer.concat([data.subarray(2, 4), data.subarray(0, 2)]);
  const v = { u16: () => data.readUInt16BE(0), i16: () => data.readInt16BE(0), u32: () => data.readUInt32BE(0), i32: () => data.readInt32BE(0), f32: () => data.readFloatBE(0) }[type]();
  return Math.round(v * Number(scale || 1) * 1e6) / 1e6;
}

/** Spule (fn 5) oder Register (fn 6) schreiben. */
export async function modbusWrite({ host, port, unit, kind = 'coil', address, value }) {
  const pdu = Buffer.alloc(5);
  if (kind === 'coil') {
    pdu.writeUInt8(5, 0);
    pdu.writeUInt16BE(Number(address), 1);
    pdu.writeUInt16BE(value ? 0xff00 : 0, 3);
  } else {
    pdu.writeUInt8(6, 0);
    pdu.writeUInt16BE(Number(address), 1);
    pdu.writeUInt16BE(Number(value) & 0xffff, 3);
  }
  await modbusRequest({ host, port, unit, pdu });
  return true;
}

/** SCPI-Abfrage, z. B. "MEAS:VOLT?" an Port 5025. Liefert Zahl (wenn möglich) oder Text. */
export function scpiQuery({ host, port = 5025, command, timeout = 4000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port) });
    let buf = '';
    const done = (err, val) => { clearTimeout(t); sock.destroy(); err ? reject(err) : resolve(val); };
    const t = setTimeout(() => done(new Error(`SCPI ${host}: Zeitüberschreitung`)), timeout);
    sock.on('connect', () => sock.write(String(command).trim() + '\n'));
    sock.on('error', (e) => done(new Error(`SCPI ${host}: ${e.code || e.message}`)));
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) {
        const line = buf.split('\n')[0].trim();
        const n = Number(line);
        done(null, Number.isFinite(n) && line !== '' ? n : line);
      }
    });
  });
}
