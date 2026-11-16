// Home-Assistant-Automationen per Chat: Beschreibung → KI-Entwurf → Vorschau → in HA speichern.
import { ha } from './ha.js';
import { ask, parseJson } from './llm.js';
import * as chronik from './chronik.js';
import { readJson, writeJson } from './store.js';

const SYSTEM = `Du schreibst Home-Assistant-Automationen (aktuelles Format ab 2024.10) als JSON.
Regeln:
- Felder: alias, description, mode ("single"|"restart"|"queued"|"parallel"), triggers, conditions, actions.
- Trigger mit "trigger": z. B. {"trigger": "state", "entity_id": "binary_sensor.x", "to": "on", "for": {"minutes": 5}},
  {"trigger": "numeric_state", "entity_id": "sensor.t", "below": 3}, {"trigger": "time", "at": "07:00:00"},
  {"trigger": "sun", "event": "sunset", "offset": "-00:30:00"}, {"trigger": "zone", "entity_id": "person.x", "zone": "zone.home", "event": "leave"}.
- Bedingungen mit "condition": state, numeric_state, time ({"condition": "time", "after": "22:00:00", "before": "06:00:00", "weekday": ["mon"]}), sun, template.
- Aktionen mit "action": z. B. {"action": "light.turn_on", "target": {"entity_id": "light.x"}, "data": {"brightness_pct": 40}},
  {"action": "notify.mobile_app_x", "data": {"title": "…", "message": "…"}}, {"delay": {"minutes": 5}}.
- Verwende NUR entity_ids aus der Liste. Fehlt etwas, schreibe es in "warnings".
Antworte nur mit JSON: {"automation": {...}, "explanation": "2–3 Sätze auf Deutsch, was sie tut", "warnings": ["…"]}`;

function entityList() {
  const keep = /^(light|switch|sensor|binary_sensor|climate|cover|lock|person|device_tracker|media_player|fan|input_boolean|input_number|scene|script|zone|sun|weather|button|vacuum|alarm_control_panel|select)\./;
  const notify = [];
  return [...ha.states.values()]
    .filter((s) => keep.test(s.entity_id))
    .slice(0, 600)
    .map((s) => `${s.entity_id} | ${s.attributes.friendly_name || ''} | ${s.state}${s.attributes.unit_of_measurement ? ' ' + s.attributes.unit_of_measurement : ''}`)
    .join('\n') + (notify.length ? '\n' + notify.join('\n') : '');
}

// Entwürfe, die per Sprache/Chat entstanden sind und im Dashboard bestätigt werden
export const pending = readJson('automation-drafts.json', []);
const persist = () => writeJson('automation-drafts.json', pending);
export function addPending(d) {
  pending.unshift({ id: String(Date.now()), created: Date.now(), ...d });
  pending.splice(10);
  persist();
}
export function dropPending(pid) {
  const i = pending.findIndex((x) => x.id === pid);
  if (i >= 0) pending.splice(i, 1);
  persist();
}

export function list() {
  return [...ha.states.values()].filter((s) => s.entity_id.startsWith('automation.')).map((s) => ({
    entity_id: s.entity_id, id: s.attributes.id, name: s.attributes.friendly_name, on: s.state === 'on',
    last: s.attributes.last_triggered, mode: s.attributes.mode,
  })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function draft(text, notifyService) {
  if (ha.status !== 'connected') throw new Error('Home Assistant ist nicht verbunden');
  const answer = await ask({
    system: SYSTEM,
    maxTokens: 2500,
    content: `Gewünschte Automation:\n${text}\n\n${notifyService ? `Benachrichtigungsdienst des Nutzers: ${notifyService}\n` : ''}Entitäten (entity_id | Name | Zustand):\n${entityList()}`,
  });
  const out = parseJson(answer);
  if (!out.automation) throw new Error('Die KI hat keine Automation geliefert');
  // Unbekannte Entitäten markieren (nur echte entity_id-Felder, keine Dienstnamen)
  const ids = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'entity_id') [].concat(v).forEach((x) => typeof x === 'string' && ids.add(x));
      else walk(v);
    }
  };
  walk(out.automation);
  const unknown = [...ids].filter((x) => !ha.states.has(x));
  if (unknown.length) (out.warnings ||= []).push('Unbekannte Entitäten: ' + unknown.join(', '));
  return out;
}

export async function save(automation, existingId) {
  const aid = existingId || String(Date.now());
  const r = await ha.rest(`/api/config/automation/config/${aid}`, { method: 'POST', body: JSON.stringify(automation) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Home Assistant lehnt ab (${r.status})`);
  chronik.add({ source: 'haus', kind: 'automation', title: `Automation gespeichert: ${automation.alias}`, icon: 'robot' });
  return { id: aid };
}

export async function get(aid) {
  const r = await ha.rest(`/api/config/automation/config/${aid}`);
  if (!r.ok) throw new Error('Automation nicht gefunden (nur in der Oberfläche angelegte sind bearbeitbar)');
  return r.json();
}

export async function remove(aid) {
  const r = await ha.rest(`/api/config/automation/config/${aid}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Löschen fehlgeschlagen');
  return { ok: true };
}
