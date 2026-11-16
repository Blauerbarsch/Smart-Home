// Mesh als Notfallkanal: Befehle von freigegebenen Nodes ausführen und per Direktnachricht antworten.
// Beispiele (Text an das Gateway oder in den Kanal):  !status   !an werkstatt   !aus heizung   !wert hütte temperatur   !hilfe
import dns from 'node:dns/promises';
import { settings } from './store.js';
import { mesh } from './mesh.js';
import { ha } from './ha.js';
import { alerts } from './alerts.js';
import * as chronik from './chronik.js';

let online = { ok: true, t: 0 };
/** Internet erreichbar? (60 s gecached) */
export async function internetOk() {
  if (Date.now() - online.t < 60000) return online.ok;
  try {
    await Promise.race([dns.resolve('github.com'), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))]);
    online = { ok: true, t: Date.now() };
  } catch {
    online = { ok: false, t: Date.now() };
  }
  return online.ok;
}

const allowed = (nid) => String(settings().meshCommandNodes || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).includes(nid.toLowerCase());

function findEntity(words, domains) {
  const w = words.toLowerCase();
  const cands = [...ha.states.values()].filter((s) => domains.some((d) => s.entity_id.startsWith(d + '.')));
  return cands.find((s) => (s.attributes.friendly_name || '').toLowerCase() === w) ||
    cands.find((s) => (s.attributes.friendly_name || '').toLowerCase().includes(w) || s.entity_id.includes(w.replace(/\s+/g, '_')));
}

async function handle(cmd, args) {
  switch (cmd) {
    case 'hilfe':
    case 'help':
      return '!status · !an <name> · !aus <name> · !wert <name> · !alarme';
    case 'status': {
      const act = alerts.active().length;
      const nodes = Object.values(mesh.nodes).filter((n) => Date.now() - (n.lastSeen || 0) < 2 * 3600e3).length;
      const net = (await internetOk()) ? 'Internet ok' : 'Internet AUS';
      return `HA ${ha.status === 'connected' ? 'ok' : 'getrennt'} · ${net} · ${nodes} Nodes aktiv · ${act} Alarme`;
    }
    case 'alarme': {
      const list = alerts.history(5).filter((a) => a.level !== 'ok');
      return list.length ? list.map((a) => a.title).join(' | ').slice(0, 190) : 'Keine Alarme';
    }
    case 'an':
    case 'aus': {
      const st = findEntity(args, ['light', 'switch', 'fan', 'input_boolean', 'climate']);
      if (!st) return `Nicht gefunden: ${args}`;
      await ha.callService('homeassistant', cmd === 'an' ? 'turn_on' : 'turn_off', { entity_id: st.entity_id });
      return `${st.attributes.friendly_name || st.entity_id}: ${cmd}`;
    }
    case 'wert': {
      const st = findEntity(args, ['sensor', 'binary_sensor', 'climate', 'weather', 'light', 'switch', 'lock', 'cover', 'person']);
      if (!st) return `Nicht gefunden: ${args}`;
      return `${st.attributes.friendly_name || st.entity_id}: ${st.state}${st.attributes.unit_of_measurement ? ' ' + st.attributes.unit_of_measurement : ''}`;
    }
  }
  return 'Unbekannt – !hilfe';
}

mesh.on('text', async (m) => {
  const text = String(m.text || '').trim();
  if (!text.startsWith('!') || m.own || !allowed(m.from)) return;
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  let reply;
  try { reply = await handle(cmd.toLowerCase(), rest.join(' ')); } catch (e) { reply = 'Fehler: ' + e.message; }
  chronik.add({ source: 'mesh', kind: 'befehl', title: `Mesh-Befehl ${text}`, detail: reply, ref: m.from, icon: 'console' });
  try { mesh.send(reply.slice(0, 200), m.from); } catch (e) { console.error('Mesh-Antwort:', e.message); }
});
