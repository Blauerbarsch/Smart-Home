// Meshtastic-Protobuf ohne Abhängigkeiten: Minimal-Decoder für die Nachrichten,
// die über MQTT kommen (ServiceEnvelope → MeshPacket → Data → Payload),
// plus AES-CTR-Entschlüsselung mit Kanal-Schlüsseln.
import crypto from 'node:crypto';

// ---------- Protobuf-Grundlagen ----------
function readVarint(buf, pos) {
  // result: Wert als Zahl (exakt bis 2^53); lo: die unteren 32 Bit exakt (für negative int32)
  let result = 0, lo = 0, shift = 0, b;
  do {
    if (pos >= buf.length) throw new Error('varint überläuft');
    b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (shift < 35) lo = (lo + (b & 0x7f) * 2 ** shift) % 2 ** 32;
    shift += 7;
  } while (b & 0x80 && shift < 70);
  return [result, pos, lo];
}

/** Liefert [{field, wire, value}] – value ist Zahl (varint), Buffer (len) oder Buffer(4/8) (fixed). */
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8), wire = key & 7;
    let value, lo;
    if (wire === 0) [value, pos, lo] = readVarint(buf, pos);
    else if (wire === 1) { value = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 5) { value = buf.subarray(pos, pos + 4); pos += 4; }
    else throw new Error('Wire-Typ ' + wire + ' nicht unterstützt');
    if (pos > buf.length) throw new Error('Nachricht abgeschnitten');
    out.push({ field, wire, value, lo });
  }
  return out;
}

const conv = {
  uint: (v) => v,
  int32: (v, lo) => lo | 0, // negative int32 kommen als 10-Byte-varint; die unteren 32 Bit genügen
  bool: (v) => Boolean(v),
  fixed32: (v) => v.readUInt32LE(0),
  sfixed32: (v) => v.readInt32LE(0),
  float: (v) => Math.round(v.readFloatLE(0) * 1e4) / 1e4,
  double: (v) => v.readDoubleLE(0),
  string: (v) => v.toString('utf8'),
  bytes: (v) => v,
};

/**
 * Dekodiert nach Schema { feldNr: [name, typ, 'repeated'?] }.
 * typ ist ein Schlüssel aus `conv`, ein Schema-Objekt (Unternachricht)
 * oder 'packed_fixed32' / 'packed_int32' für gepackte Listen.
 */
export function decode(buf, schema) {
  const obj = {};
  for (const { field, wire, value, lo } of fields(buf)) {
    const def = schema[field];
    if (!def) continue;
    const [name, type, rep] = def;
    let v;
    if (typeof type === 'object') v = decode(value, type);
    else if (type === 'packed_fixed32') {
      v = [];
      if (wire === 2) for (let i = 0; i + 4 <= value.length; i += 4) v.push(value.readUInt32LE(i));
      else v.push(value.readUInt32LE(0));
      obj[name] = (obj[name] || []).concat(v);
      continue;
    } else if (type === 'packed_int32') {
      v = [];
      if (wire === 2) {
        let p = 0, n, l;
        while (p < value.length) { [n, p, l] = readVarint(value, p); v.push(l | 0); }
      } else v.push(lo | 0);
      obj[name] = (obj[name] || []).concat(v);
      continue;
    } else v = conv[type](value, lo);
    if (rep) (obj[name] ||= []).push(v);
    else obj[name] = v;
  }
  return obj;
}

// ---------- Meshtastic-Schemas (Feldnummern aus meshtastic/protobufs) ----------
const Data = { 1: ['portnum', 'uint'], 2: ['payload', 'bytes'], 3: ['want_response', 'bool'], 4: ['dest', 'fixed32'], 5: ['source', 'fixed32'], 6: ['request_id', 'fixed32'], 7: ['reply_id', 'fixed32'], 8: ['emoji', 'fixed32'] };
const MeshPacket = {
  1: ['from', 'fixed32'], 2: ['to', 'fixed32'], 3: ['channel', 'uint'], 4: ['decoded', Data], 5: ['encrypted', 'bytes'],
  6: ['id', 'fixed32'], 7: ['rx_time', 'fixed32'], 8: ['rx_snr', 'float'], 9: ['hop_limit', 'uint'], 10: ['want_ack', 'bool'],
  11: ['priority', 'uint'], 12: ['rx_rssi', 'int32'], 14: ['via_mqtt', 'bool'], 15: ['hop_start', 'uint'], 17: ['pki_encrypted', 'bool'],
  18: ['next_hop', 'uint'], 19: ['relay_node', 'uint'],
};
const ServiceEnvelope = { 1: ['packet', MeshPacket], 2: ['channel_id', 'string'], 3: ['gateway_id', 'string'] };
const Position = { 1: ['latitude_i', 'sfixed32'], 2: ['longitude_i', 'sfixed32'], 3: ['altitude', 'int32'], 4: ['time', 'fixed32'], 19: ['sats_in_view', 'uint'], 23: ['precision_bits', 'uint'] };
const User = { 1: ['id', 'string'], 2: ['long_name', 'string'], 3: ['short_name', 'string'], 5: ['hw_model', 'uint'], 6: ['is_licensed', 'bool'], 7: ['role', 'uint'] };
const DeviceMetrics = { 1: ['battery_level', 'uint'], 2: ['voltage', 'float'], 3: ['channel_utilization', 'float'], 4: ['air_util_tx', 'float'], 5: ['uptime_seconds', 'uint'] };
const EnvironmentMetrics = {
  1: ['temperature', 'float'], 2: ['relative_humidity', 'float'], 3: ['barometric_pressure', 'float'], 4: ['gas_resistance', 'float'],
  5: ['voltage', 'float'], 6: ['current', 'float'], 7: ['iaq', 'uint'], 8: ['distance', 'float'], 9: ['lux', 'float'],
  13: ['wind_direction', 'uint'], 14: ['wind_speed', 'float'], 15: ['weight', 'float'], 16: ['wind_gust', 'float'],
  18: ['radiation', 'float'], 19: ['rainfall_1h', 'float'], 20: ['rainfall_24h', 'float'], 21: ['soil_moisture', 'uint'], 22: ['soil_temperature', 'float'],
};
const AirQualityMetrics = { 1: ['pm10_standard', 'uint'], 2: ['pm25_standard', 'uint'], 3: ['pm100_standard', 'uint'], 13: ['co2', 'uint'] };
const PowerMetrics = { 1: ['ch1_voltage', 'float'], 2: ['ch1_current', 'float'], 3: ['ch2_voltage', 'float'], 4: ['ch2_current', 'float'], 5: ['ch3_voltage', 'float'], 6: ['ch3_current', 'float'] };
const Telemetry = { 1: ['time', 'fixed32'], 2: ['device_metrics', DeviceMetrics], 3: ['environment_metrics', EnvironmentMetrics], 4: ['air_quality_metrics', AirQualityMetrics], 5: ['power_metrics', PowerMetrics] };
const Neighbor = { 1: ['node_id', 'uint'], 2: ['snr', 'float'] };
const NeighborInfo = { 1: ['node_id', 'uint'], 2: ['last_sent_by_id', 'uint'], 3: ['node_broadcast_interval_secs', 'uint'], 4: ['neighbors', Neighbor, 'repeated'] };
const RouteDiscovery = { 1: ['route', 'packed_fixed32'], 2: ['snr_towards', 'packed_int32'], 3: ['route_back', 'packed_fixed32'], 4: ['snr_back', 'packed_int32'] };
const MapReport = {
  1: ['long_name', 'string'], 2: ['short_name', 'string'], 3: ['role', 'uint'], 4: ['hw_model', 'uint'], 5: ['firmware_version', 'string'],
  6: ['region', 'uint'], 7: ['modem_preset', 'uint'], 8: ['has_default_channel', 'bool'], 9: ['latitude_i', 'sfixed32'], 10: ['longitude_i', 'sfixed32'],
  11: ['altitude', 'int32'], 12: ['position_precision', 'uint'], 13: ['num_online_local_nodes', 'uint'],
};
const Waypoint = { 1: ['id', 'uint'], 2: ['latitude_i', 'sfixed32'], 3: ['longitude_i', 'sfixed32'], 4: ['expire', 'uint'], 6: ['name', 'string'], 7: ['description', 'string'] };

export const PORTS = {
  1: 'text', 3: 'position', 4: 'nodeinfo', 5: 'routing', 6: 'admin', 8: 'waypoint', 10: 'detection', 32: 'reply', 34: 'paxcounter',
  65: 'storeforward', 66: 'rangetest', 67: 'telemetry', 70: 'traceroute', 71: 'neighborinfo', 72: 'atak', 73: 'mapreport',
};

// Aus meshtastic/protobufs (mesh.proto, enum HardwareModel) übernommen
export const HW_MODELS = {
  0: 'Unbekannt',
  1: 'T-LoRa V2',
  2: 'T-LoRa V1',
  3: 'T-LoRa V2 1 1P6',
  5: 'Heltec V2 0',
  6: 'T-Beam V0P7',
  8: 'T-LoRa V1 1P3',
  9: 'RAK4631',
  10: 'Heltec V2 1',
  11: 'Heltec V1',
  13: 'RAK11200',
  14: 'Nano G1',
  15: 'T-LoRa V2 1 1P8',
  16: 'T-LoRa T3 S3',
  17: 'Nano G1 Explorer',
  18: 'Nano G2 Ultra',
  19: 'LoRa Type',
  20: 'Wiphone',
  22: 'RAK2560',
  23: 'Heltec Hru 3601',
  24: 'Heltec Wireless Bridge',
  25: 'Station G1',
  26: 'RAK11310',
  27: 'Makerfabs Tracker',
  28: 'Makerfabs Reserved',
  30: 'RP2040 LoRa',
  31: 'Station G2',
  32: 'LoRa Relay V1',
  34: 'Ppr',
  35: 'Genieblocks',
  36: 'nRF52 Unknown',
  37: 'Portduino',
  38: 'Android Sim',
  39: 'DIY V1',
  40: 'nRF52840 Pca10059',
  41: 'Dr Dev',
  42: 'M5Stack',
  43: 'Heltec V3',
  44: 'Heltec WSL V3',
  45: 'Betafpv 2400 Tx',
  46: 'Betafpv 900 Nano Tx',
  47: 'RPi Pico',
  49: 'Heltec Wireless Paper',
  50: 'T-Deck',
  51: 'T-Watch S3',
  52: 'Picomputer S3',
  53: 'Heltec HT62',
  54: 'Ebyte ESP32 S3',
  55: 'ESP32 S3 Pico',
  56: 'Chatter 2',
  57: 'Heltec Wireless Paper V1 0',
  58: 'Heltec Wireless Tracker V1 0',
  59: 'unPhone',
  60: 'Td LoRac',
  61: 'Cdebyte Eora S3',
  62: 'Twc Mesh V4',
  63: 'nRF52 Promicro DIY',
  64: 'Radiomaster 900 Bandit Nano',
  65: 'Heltec Capsule Sensor V3',
  66: 'Heltec Vision Master T190',
  67: 'Heltec Vision Master E213',
  68: 'Heltec Vision Master E290',
  69: 'Heltec Mesh Node T114',
  70: 'Sensecap Indicator',
  72: 'RAK3172',
  73: 'Wio E5',
  74: 'Radiomaster 900 Bandit',
  75: 'Me25Ls01 4Y10Td',
  76: 'RP2040 Feather Rfm95',
  77: 'M5Stack Corebasic',
  78: 'M5Stack Core2',
  79: 'RPi Pico2',
  80: 'M5Stack Cores3',
  81: 'Seeed XIAO S3',
  82: 'Ms24Sf1',
  83: 'T-LoRa C6',
  84: 'WisMesh Tap',
  85: 'Routastic',
  86: 'Mesh Tab',
  87: 'Meshlink',
  88: 'XIAO nRF52 Kit',
  90: 'Thinknode M2',
  91: 'T Eth Elite',
  92: 'Heltec Sensor Hub',
  93: 'Muzi Base',
  94: 'Heltec Mesh Pocket',
  95: 'Seeed Solar Node',
  96: 'Nomadstar Meteor Pro',
  97: 'Crowpanel',
  98: 'Link 32',
  101: 'Muzi R1 Neo',
  104: 'M5Stack Reserved',
  106: 'RAK3312',
  107: 'Thinknode M5',
  108: 'Heltec Mesh Solar',
  109: 'T-Echo Lite',
  110: 'Heltec V4',
  111: 'M5Stack C6L',
  112: 'M5Stack Cardputer Adv',
  114: 'T-Watch Ultra',
  115: 'Thinknode M3',
  116: 'WisMesh Tap V2',
  117: 'RAK3401',
  118: 'RAK6421',
  119: 'Thinknode M4',
  120: 'Thinknode M6',
  121: 'Meshstick 1262',
  123: 'T5 S3 Epaper Pro',
  125: 'Mini Epaper S3',
  126: 'Tdisplay S3 Pro',
  127: 'Heltec Mesh Node T096',
  129: 'Thinknode M7',
  130: 'Thinknode M8',
  131: 'Thinknode M9',
  132: 'Heltec V4 R8',
  133: 'Heltec Mesh Node T1',
  134: 'Station G3',
  135: 'T Impulse Plus',
  136: 'T-Echo Card',
  137: 'Seeed Wio Tracker L2',
  138: 'Crowpanel P4',
  139: 'Heltec Mesh Tower V2',
  140: 'Meshnology W10',
  141: 'Heltec Rc32',
  142: 'Heltec Rc52',
  143: 'Heltec Rcc6',
  144: 'Seeed Wio Tracker L1 Pro 1W',
  145: 'Meshnology W12',
  146: 'Meshpager X2',
  147: 'T Connect Pro',
  148: 'Axiometa Genesis Mini',
  149: 'Makerfabs Nomad Terminal',
  150: 'Thinknode Mx',
  151: 'Nodara',
  152: 'Heltec Mesh Pocket V2',
  255: 'Privat/DIY',
};

// ---------- Entschlüsselung ----------
const DEFAULT_PSK = Buffer.from('1PG7OiApB1nwvP+rz05pAQ==', 'base64');

/** Kanal-PSK (Base64) → AES-Schlüssel. 1 Byte = Index auf den Standard-Schlüssel. */
export function expandKey(b64) {
  const raw = Buffer.from(String(b64 || 'AQ=='), 'base64');
  if (raw.length === 0) return null; // unverschlüsselt
  if (raw.length === 1) {
    if (raw[0] === 0) return null;
    const k = Buffer.from(DEFAULT_PSK);
    k[15] = (k[15] + raw[0] - 1) & 0xff;
    return k;
  }
  if (raw.length === 16 || raw.length === 32) return raw;
  return null;
}

function decrypt(enc, key, packetId, from) {
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(packetId >>> 0, 0);
  nonce.writeUInt32LE(from >>> 0, 8);
  const d = crypto.createDecipheriv(key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr', key, nonce);
  return Buffer.concat([d.update(enc), d.final()]);
}

/**
 * ServiceEnvelope-Bytes → normalisiertes Paket im selben Aufbau wie die JSON-Ausgabe
 * ({from, to, id, type, payload, rssi, snr, hops_away, sender, channel_id, via_mqtt}).
 * keys: Map Kanalname → Schlüssel (Buffer); null bei nicht entschlüsselbar.
 */
export function decodeEnvelope(buf, keys) {
  const env = decode(buf, ServiceEnvelope);
  const p = env.packet;
  if (!p || p.from === undefined) return null;
  let data = p.decoded;
  let decrypted = false;
  if (!data && p.encrypted?.length && !p.pki_encrypted) {
    const candidates = [keys.get(env.channel_id), ...keys.values()].filter(Boolean);
    for (const key of new Set(candidates)) {
      try {
        const plain = decrypt(p.encrypted, key, p.id, p.from);
        const d = decode(plain, Data);
        if (d.portnum && PORTS[d.portnum] !== undefined) { data = d; decrypted = true; break; }
      } catch {}
    }
  }
  const base = {
    from: p.from, to: p.to, id: p.id, channel_id: env.channel_id, sender: env.gateway_id,
    rssi: p.rx_rssi || undefined, snr: p.rx_snr || undefined, via_mqtt: Boolean(p.via_mqtt),
    hops_away: p.hop_start !== undefined && p.hop_limit !== undefined && p.hop_start >= p.hop_limit ? p.hop_start - p.hop_limit : undefined,
    timestamp: p.rx_time, encrypted: !data, decrypted, relay_node: p.relay_node,
  };
  if (!data) return { ...base, type: 'encrypted', payload: {} };
  const port = PORTS[data.portnum] || 'port' + data.portnum;
  const raw = data.payload || Buffer.alloc(0);
  let payload = {};
  try {
    switch (port) {
      case 'text': payload = { text: raw.toString('utf8') }; break;
      case 'position': payload = decode(raw, Position); break;
      case 'nodeinfo': {
        const u = decode(raw, User);
        payload = { id: u.id, longname: u.long_name, shortname: u.short_name, hardware: u.hw_model, role: u.role };
        break;
      }
      case 'telemetry': {
        const t = decode(raw, Telemetry);
        payload = { ...t.device_metrics, ...t.environment_metrics, ...t.air_quality_metrics, ...t.power_metrics };
        break;
      }
      case 'neighborinfo': payload = decode(raw, NeighborInfo); break;
      case 'traceroute': payload = decode(raw, RouteDiscovery); break;
      case 'mapreport': {
        const m = decode(raw, MapReport);
        payload = { longname: m.long_name, shortname: m.short_name, hardware: m.hw_model, role: m.role, firmware_version: m.firmware_version,
          latitude_i: m.latitude_i, longitude_i: m.longitude_i, altitude: m.altitude, num_online_local_nodes: m.num_online_local_nodes };
        break;
      }
      case 'waypoint': payload = decode(raw, Waypoint); break;
      default: payload = { size: raw.length };
    }
  } catch (e) {
    payload = { error: e.message };
  }
  return { ...base, type: port, payload, request_id: data.request_id, dest: data.dest };
}
