// Unraid 7.2+: offizielle GraphQL-API (Einstellungen → Management Access → API Keys).
// Container, VMs, Array, CPU/RAM/Temperaturen, Benachrichtigungen, Updates.
import { settings } from './store.js';

let cache = { t: 0, data: null };

async function gql(query, variables = {}) {
  const s = settings();
  if (!s.unraidUrl || !s.unraidApiKey) throw new Error('Unraid-API nicht eingerichtet (Einstellungen)');
  const res = await fetch(s.unraidUrl.replace(/\/$/, '') + '/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': s.unraidApiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Unraid-API: ${res.status} ${text.slice(0, 120)}`); }
  if (json.errors?.length) throw new Error('Unraid-API: ' + json.errors.map((e) => e.message).join('; '));
  return json.data;
}

const PARTS = {
  docker: `docker { containers { id names image state status autoStart iconUrl webUiUrl isUpdateAvailable labels ports { privatePort publicPort type } } }`,
  vms: `vms { domains { id name state } }`,
  array: `array { state capacity { kilobytes { free used total } }
    parityCheckStatus { status progress running errors }
    disks { name device size temp status isSpinning fsSize fsUsed fsFree type }
    parities { name device size temp status isSpinning type }
    caches { name device size temp status isSpinning fsSize fsUsed fsFree type } }`,
  metrics: `metrics { cpu { percentTotal } memory { total used percentTotal } }`,
  info: `info { os { hostname uptime release } cpu { brand cores threads } }`,
  notifications: `notifications { overview { unread { info warning alert total } } }`,
};

// Ältere Unraid-API-Versionen kennen manche Felder noch nicht (z. B. iconUrl, isUpdateAvailable).
// Statt den ganzen Teil scheitern zu lassen, werden unbekannte Felder entfernt und gemerkt.
const adapted = {};
async function queryPart(key) {
  let query = adapted[key] || PARTS[key];
  for (let i = 0; i < 6; i++) {
    try {
      const r = await gql(`query { ${query} }`);
      adapted[key] = query;
      return r;
    } catch (e) {
      const bad = [...e.message.matchAll(/Cannot query field "(\w+)" on type "\w+"/g)].map((m) => m[1]);
      if (!bad.length) throw e;
      for (const f of bad) query = query.replace(new RegExp(`\\b${f}\\b(\\s*\\{[^{}]*\\})?`), '');
    }
  }
  throw new Error('Unraid-API: Abfrage passt nicht zur Version');
}

/** Web-Oberfläche und Symbol aus den Unraid-Labels (net.unraid.docker.*) ableiten. */
function fromLabels(c) {
  const l = c.labels || {};
  const host = (() => { try { return new URL(settings().unraidUrl).hostname; } catch { return ''; } })();
  let webUi = c.webUiUrl || l['net.unraid.docker.webui'] || '';
  if (webUi) {
    webUi = webUi.replace(/\[IP\]/gi, host).replace(/\[PORT:(\d+)\]/gi, (_, p) => {
      const m = (c.ports || []).find((x) => String(x.privatePort) === p && x.publicPort);
      return m ? m.publicPort : p;
    });
    if (/\[|\]/.test(webUi)) webUi = '';
  }
  return { icon: c.iconUrl || l['net.unraid.docker.icon'] || '', webUi };
}

/** Gesamtübersicht, 10 s gecached. Jeder Teil wird einzeln abgefragt, damit z. B. ein abgeschalteter VM-Dienst den Rest nicht blockiert. */
export async function overview(force = false) {
  if (!force && cache.data && Date.now() - cache.t < 10000) return cache.data;
  const keys = Object.keys(PARTS);
  const results = await Promise.allSettled(keys.map((k) => queryPart(k)));
  const data = {};
  const errors = {};
  results.forEach((r, i) => (r.status === 'fulfilled' ? Object.assign(data, r.value) : (errors[keys[i]] = r.reason.message)));
  if (Object.keys(errors).length === keys.length) throw new Error(Object.values(errors)[0]);
  const out = {
    hostname: data.info?.os?.hostname,
    uptime: data.info?.os?.uptime,
    release: data.info?.os?.release,
    cpuModel: data.info?.cpu?.brand,
    cpu: data.metrics?.cpu?.percentTotal,
    // „used“ zählt bei Unraid den Datei-Cache mit – der Prozentwert entspricht der Anzeige in Unraid
    mem: data.metrics?.memory ? (() => { const m = data.metrics.memory; const total = Number(m.total); const pct = Number(m.percentTotal); return { used: Number.isFinite(pct) ? (total * pct) / 100 : Number(m.used), total, pct }; })() : null,
    array: data.array && {
      state: data.array.state,
      capacity: data.array.capacity?.kilobytes,
      parity: data.array.parityCheckStatus,
      disks: [...(data.array.parities || []), ...(data.array.disks || []), ...(data.array.caches || [])].map((d) => ({
        // Unraid liefert Kilobyte
        name: d.name, type: d.type, temp: d.temp, status: d.status, spinning: d.isSpinning, size: Number(d.size || 0) * 1024,
        used: Number(d.fsUsed || 0) * 1024, total: Number(d.fsSize || 0) * 1024,
      })),
    },
    containers: (data.docker?.containers || []).map((c) => ({
      id: c.id, name: (c.names?.[0] || '').replace(/^\//, ''), image: c.image, state: c.state, status: c.status,
      autoStart: c.autoStart, ...fromLabels(c), update: Boolean(c.isUpdateAvailable),
      ports: (c.ports || []).filter((p) => p.publicPort).map((p) => p.publicPort),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    vms: (data.vms?.domains || []).map((v) => ({ id: v.id, name: v.name, state: v.state })).sort((a, b) => a.name.localeCompare(b.name)),
    notifications: data.notifications?.overview?.unread,
    errors,
    time: Date.now(),
  };
  cache = { t: Date.now(), data: out };
  return out;
}

const DOCKER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause', 'updateContainer'];
const VM_ACTIONS = ['start', 'stop', 'pause', 'resume', 'forceStop', 'reboot', 'reset'];

export async function containerAction(id, action) {
  if (!DOCKER_ACTIONS.includes(action)) throw new Error('Unbekannte Aktion');
  const fields = action === 'updateContainer' ? '{ id state }' : '{ id state status }';
  const r = await gql(`mutation($id: PrefixedID!) { docker { ${action}(id: $id) ${fields} } }`, { id }).catch((e) => {
    if (/Cannot query field "updateContainer"/.test(e.message)) throw new Error('Diese Unraid-Version kann Container noch nicht per API aktualisieren – bitte in Unraid unter Docker auf „Update“ klicken (oder Unraid aktualisieren).');
    throw e;
  });
  cache.t = 0;
  return r.docker[action];
}

export async function vmAction(id, action) {
  if (!VM_ACTIONS.includes(action)) throw new Error('Unbekannte Aktion');
  const r = await gql(`mutation($id: PrefixedID!) { vm { ${action}(id: $id) } }`, { id });
  cache.t = 0;
  return r.vm[action];
}

export async function notifications(limit = 20) {
  const r = await gql(`query { notifications { list(filter: { type: UNREAD, offset: 0, limit: ${Number(limit) || 20} }) {
    id title subject description importance timestamp } } }`);
  return r.notifications.list;
}

/** Eigenen Container aktualisieren (Unraid setzt HOST_CONTAINERNAME). */
export async function selfUpdate() {
  const name = process.env.HOST_CONTAINERNAME || 'smart-home';
  const o = await overview(true);
  const me = o.containers.find((c) => c.name === name);
  if (!me) throw new Error(`Container „${name}“ in Unraid nicht gefunden`);
  // Antwort kommt evtl. nicht mehr an, weil der Container dabei neu startet.
  containerAction(me.id, 'updateContainer').catch(() => {});
  return { ok: true, container: name };
}
