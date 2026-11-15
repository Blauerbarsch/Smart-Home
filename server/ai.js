// KI-Konsole: Claude (Anthropic API, mit Werkzeugen fürs Smart Home)
// und Kopf (lokale KI, OpenAI-kompatible API von head-brain).
import { settings, projects, id, layout } from './store.js';
import { ha } from './ha.js';
import { mesh } from './mesh.js';

async function* sseLines(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

function projectContext(projectId) {
  const p = projectId && projects.get(projectId);
  if (!p) return '';
  const tasks = p.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
  const parts = p.parts.map((x) => `- ${x.qty || 1}× ${x.name}${x.have ? ' (vorhanden)' : ''}`).join('\n');
  return [
    `Aktuelles Projekt: ${p.name} (id ${p.id}, Status ${p.status}, Fortschritt ${p.progress} %)`,
    p.description && `Beschreibung: ${p.description}`,
    tasks && `Aufgaben:\n${tasks}`,
    parts && `Teile:\n${parts}`,
    p.notes && `Notizen:\n${p.notes.slice(0, 3000)}`,
    p.entities?.length && `Verknüpfte Entitäten: ${p.entities.join(', ')}`,
  ].filter(Boolean).join('\n');
}

function systemPrompt(projectId, withHome) {
  const now = new Date().toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' });
  const sites = layout().sites.map((s) => s.name).join(', ');
  return [
    'Du bist die KI-Konsole im Smart-Home- und Werkstatt-Dashboard des Nutzers. Antworte auf Deutsch, knapp und praktisch.',
    'Der Nutzer bastelt viel (ESPHome, Home Assistant, Meshtastic, eigene KI „Kopf“).',
    `Jetzt: ${now}.`,
    sites && `Standorte: ${sites}.`,
    withHome && 'Du kannst Home Assistant über Werkzeuge abfragen und steuern. Schalte nur, was der Nutzer ausdrücklich will.',
    projectContext(projectId),
  ].filter(Boolean).join('\n\n');
}

// ---------- Werkzeuge ----------
const TOOLS = [
  {
    name: 'find_entities',
    description: 'Sucht Home-Assistant-Entitäten (Name oder entity_id enthält den Suchtext) und liefert Zustand, Einheit und Raum.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'call_service',
    description: 'Ruft einen Home-Assistant-Dienst auf, z. B. light.turn_on für light.kueche.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        service: { type: 'string' },
        entity_id: { type: 'string' },
        data: { type: 'object', description: 'Zusätzliche service_data, z. B. {"brightness_pct": 40}' },
      },
      required: ['domain', 'service'],
    },
  },
  {
    name: 'mesh_nodes',
    description: 'Liefert alle Meshtastic-Nodes mit Position, Akku, Telemetrie und letzter Meldung.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_project_task',
    description: 'Fügt dem aktuellen Projekt eine Aufgabe hinzu.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'append_project_notes',
    description: 'Hängt Text an die Notizen des aktuellen Projekts an (Markdown).',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

async function runTool(name, input, projectId) {
  switch (name) {
    case 'find_entities':
      return ha.summary(input.query || '').slice(0, 60);
    case 'call_service':
      await ha.callService(input.domain, input.service, input.data || {}, input.entity_id ? { entity_id: input.entity_id } : undefined);
      return { ok: true };
    case 'mesh_nodes':
      return mesh.list().map((n) => ({
        id: n.id, name: n.alias || n.longName, lat: n.lat, lon: n.lon, battery: n.battery,
        temperature: n.temperature, humidity: n.humidity, lastSeen: n.lastSeen && new Date(n.lastSeen).toISOString(),
      }));
    case 'add_project_task': {
      const p = projects.get(projectId);
      if (!p) return { error: 'kein Projekt gewählt' };
      p.tasks.push({ id: id(), text: input.text, done: false });
      projects.update(p.id, { tasks: p.tasks });
      return { ok: true };
    }
    case 'append_project_notes': {
      const p = projects.get(projectId);
      if (!p) return { error: 'kein Projekt gewählt' };
      projects.update(p.id, { notes: (p.notes ? p.notes + '\n\n' : '') + input.text });
      return { ok: true };
    }
    default:
      return { error: 'unbekanntes Werkzeug' };
  }
}

// ---------- Claude ----------
async function chatClaude({ messages, projectId }, emit, signal) {
  const s = settings();
  if (!s.anthropicKey) throw new Error('Kein Anthropic-API-Key eingetragen (Einstellungen)');
  const withHome = s.aiHomeControl && ha.status === 'connected';
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let round = 0; round < 6; round++) {
    const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': s.anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: s.claudeModel || 'claude-sonnet-5-5',
        max_tokens: 4096,
        stream: true,
        system: systemPrompt(projectId, withHome),
        messages: convo,
        tools: withHome ? TOOLS : TOOLS.filter((t) => !['find_entities', 'call_service'].includes(t.name)),
      }),
    });
    if (!res.ok) throw new Error(`Claude: ${res.status} ${(await res.text()).slice(0, 300)}`);

    const blocks = [];
    let stop = null;
    for await (const data of sseLines(res)) {
      const ev = JSON.parse(data);
      if (ev.type === 'content_block_start') {
        blocks[ev.index] = { ...ev.content_block, _json: '' };
      } else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index];
        if (ev.delta.type === 'text_delta') {
          b.text = (b.text || '') + ev.delta.text;
          emit('delta', { text: ev.delta.text });
        } else if (ev.delta.type === 'input_json_delta') {
          b._json += ev.delta.partial_json;
        }
      } else if (ev.type === 'message_delta') {
        stop = ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        throw new Error(ev.error?.message || 'Claude-Fehler');
      }
    }
    const content = blocks.filter(Boolean).map(({ _json, ...b }) => {
      if (b.type === 'tool_use') b.input = _json ? JSON.parse(_json) : {};
      return b;
    });
    convo.push({ role: 'assistant', content });
    if (stop !== 'tool_use') return;

    const results = [];
    for (const b of content.filter((c) => c.type === 'tool_use')) {
      let result;
      try {
        result = await runTool(b.name, b.input, projectId);
      } catch (e) {
        result = { error: e.message };
      }
      emit('tool', { name: b.name, input: b.input, result });
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result).slice(0, 20000) });
    }
    convo.push({ role: 'user', content: results });
    emit('delta', { text: '\n' });
  }
}

// ---------- Kopf (lokal) ----------
async function chatKopf({ messages, projectId }, emit, signal) {
  const s = settings();
  if (!s.kopfUrl) throw new Error('Kopf-Adresse fehlt (Einstellungen)');
  const res = await fetch(s.kopfUrl.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: s.kopfModel || 'head-memory',
      stream: true,
      messages: [{ role: 'system', content: systemPrompt(projectId, false) }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`Kopf: ${res.status} ${(await res.text()).slice(0, 300)}`);
  for await (const data of sseLines(res)) {
    if (data === '[DONE]') break;
    try {
      const text = JSON.parse(data).choices?.[0]?.delta?.content;
      if (text) emit('delta', { text });
    } catch {}
  }
}

export async function chat(req, emit, signal) {
  const provider = req.provider || settings().defaultAi;
  return provider === 'kopf' ? chatKopf(req, emit, signal) : chatClaude(req, emit, signal);
}

// ---------- Kopf-Dienste ----------
export async function kopfStatus() {
  const s = settings();
  const base = (u) => (u || '').replace(/\/$/, '');
  const targets = {
    brain: s.kopfUrl && base(s.kopfUrl) + '/health',
    output: s.kopfOutputUrl && base(s.kopfOutputUrl) + '/health',
    vision: s.kopfVisionUrl && base(s.kopfVisionUrl) + '/health',
  };
  const out = {};
  await Promise.all(
    Object.entries(targets).map(async ([k, url]) => {
      if (!url) return (out[k] = 'off');
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
        out[k] = r.ok ? 'ok' : 'error';
      } catch {
        out[k] = 'down';
      }
    }),
  );
  return out;
}

export async function kopfSpeak(text) {
  const s = settings();
  if (!s.kopfOutputUrl) throw new Error('Kopf-Sprachausgabe nicht eingerichtet');
  const r = await fetch(s.kopfOutputUrl.replace(/\/$/, '') + '/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error('Sprachausgabe: ' + r.status);
}
