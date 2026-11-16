// KI-Konsole: Claude (Anthropic API, mit Werkzeugen fürs Smart Home)
// und Kopf (lokale KI, OpenAI-kompatible API von head-brain).
import { settings, projects, id, layout } from './store.js';
import { ha } from './ha.js';
import { mesh } from './mesh.js';
import * as unraid from './unraid.js';
import { github } from './github.js';
import { inventreeSearch, uploadPath } from './maker.js';
import fs from 'node:fs';
import * as wbench from './workbench.js';
import * as chronik from './chronik.js';
import * as autom from './automations.js';
import { pdfBlock } from './llm.js';

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
    p.repo && `GitHub-Repo: ${p.repo}`,
    p.resources?.length && `Läuft auf: ${p.resources.map((r) => `${r.type} ${r.name}`).join(', ')}`,
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
    withHome && 'Du kannst Home Assistant, den Unraid-Server (Container, VMs), GitHub-Repos, das Teilelager und das Meshtastic-Netz über Werkzeuge abfragen. Schalte, starte oder stoppe nur, was der Nutzer ausdrücklich will.',
    'Werkstatt-Werkzeuge: Tagebuch (auch mit Foto von Kopfs Kamera), Bauteil vor der Kamera erkennen, Timer, Chronik durchsuchen, Automationen entwerfen.',
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
    name: 'server_status',
    description: 'Status des Unraid-Servers: CPU, RAM, Array, alle Docker-Container und VMs mit Zustand.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'manage_server',
    description: 'Startet, stoppt oder startet einen Docker-Container bzw. eine VM auf dem Unraid-Server neu. Nur auf ausdrücklichen Wunsch.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['container', 'vm'] }, name: { type: 'string' }, action: { type: 'string', enum: ['start', 'stop', 'restart'] } },
      required: ['kind', 'name', 'action'],
    },
  },
  {
    name: 'repo_info',
    description: 'Infos zu einem GitHub-Repo des Nutzers: letzte Commits, offene Issues/PRs, Release, Build-Status. Ohne Angabe: Repo des aktuellen Projekts.',
    input_schema: { type: 'object', properties: { repo: { type: 'string', description: 'z. B. Blauerbarsch/local-ai' } } },
  },
  {
    name: 'parts_search',
    description: 'Sucht Bauteile im Teilelager (InvenTree) und liefert den Bestand.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'diary_add',
    description: 'Schreibt einen Eintrag ins Werkstatt-Tagebuch des aktuellen (oder genannten) Projekts, optional mit Foto von Kopfs Kamera. Für „notier …“, „schreib auf …“, „mach ein Foto“.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, photo: { type: 'boolean' }, project: { type: 'string', description: 'Projektname, leer = aktuelles' } } },
  },
  {
    name: 'identify_part',
    description: 'Erkennt das Bauteil, das gerade vor Kopfs Kamera gehalten wird (Name, Beschriftung, Daten).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_timer',
    description: 'Stellt einen Timer/eine Erinnerung; nach Ablauf sagt Kopf Bescheid und das Handy bekommt eine Nachricht.',
    input_schema: { type: 'object', properties: { minutes: { type: 'number' }, text: { type: 'string' } }, required: ['minutes'] },
  },
  {
    name: 'list_timers',
    description: 'Listet laufende Timer.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'chronik_search',
    description: 'Durchsucht die Chronik (Zeitleiste: Schaltvorgänge, Personen, Mesh, Alarme, Server, Commits, Tagebuch, Timer). Für Fragen wie „wann war …“, „was habe ich … gemacht“.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, days: { type: 'number' }, source: { type: 'string', enum: ['', 'haus', 'mesh', 'server', 'github', 'werkstatt', 'alarm'] } } },
  },
  {
    name: 'kopf_move',
    description: 'Bewegt Kopfs eigenen Körper: gespeicherte Pose oder Ablauf abspielen (z. B. Nicken, Kopfschütteln, Zwinkern, Umschauen).',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'automation_draft',
    description: 'Entwirft eine Home-Assistant-Automation aus einer Beschreibung. Sie wird NICHT direkt aktiv, sondern muss im Dashboard (Reiter Automationen) bestätigt werden.',
    input_schema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
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

export async function runTool(name, input, projectId) {
  projectId ||= wbench.wb.activeProject;
  switch (name) {
    case 'diary_add':
      return wbench.diaryAdd(input);
    case 'identify_part':
      return wbench.identifyPart({ fromKopf: true });
    case 'set_timer': {
      const t = wbench.addTimer(input);
      return { ok: true, due: new Date(t.due).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), text: t.text };
    }
    case 'list_timers':
      return wbench.wb.timers.map((t) => ({ text: t.text, inMinutes: Math.round((t.due - Date.now()) / 60e3) }));
    case 'chronik_search':
      return chronik.search({ text: input.text || '', source: input.source || '', days: input.days || 30, limit: 40 }).map((e) => ({ when: new Date(e.ts).toLocaleString('de-DE'), what: e.title, detail: e.detail || undefined }));
    case 'kopf_move': {
      const n = String(input.name || '');
      const seq = Object.keys(wbench.wb.sequences).find((k) => k.toLowerCase() === n.toLowerCase());
      if (seq) return wbench.playSequence(seq);
      const pose = Object.keys(wbench.wb.poses).find((k) => k.toLowerCase() === n.toLowerCase());
      if (pose) return wbench.setPose(wbench.wb.poses[pose]);
      return { error: 'unbekannt', available: [...Object.keys(wbench.wb.sequences), ...Object.keys(wbench.wb.poses)] };
    }
    case 'automation_draft': {
      const d = await autom.draft(input.description, settings().notifyHaService);
      autom.addPending(d);
      return { explanation: d.explanation, warnings: d.warnings, hint: 'Entwurf liegt im Dashboard unter „Automationen“ zur Bestätigung bereit.' };
    }
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
    case 'server_status': {
      const o = await unraid.overview();
      return { cpu: o.cpu, mem: o.mem, array: o.array && { state: o.array.state, capacity: o.array.capacity }, containers: o.containers.map((c) => ({ name: c.name, state: c.state, update: c.update })), vms: o.vms };
    }
    case 'manage_server': {
      const o = await unraid.overview(true);
      const list = input.kind === 'vm' ? o.vms : o.containers;
      const item = list.find((x) => x.name.toLowerCase() === String(input.name).toLowerCase());
      if (!item) return { error: `${input.name} nicht gefunden`, available: list.map((x) => x.name) };
      const action = input.kind === 'vm' && input.action === 'restart' ? 'reboot' : input.action;
      if (input.kind === 'vm') await unraid.vmAction(item.id, action);
      else await unraid.containerAction(item.id, action);
      return { ok: true, name: item.name, action };
    }
    case 'repo_info': {
      const repo = input.repo || projects.get(projectId)?.repo;
      if (!repo) return { error: 'kein Repo angegeben' };
      const d = await github.details(repo);
      return { ...d, readme: d.readme.slice(0, 3000) };
    }
    case 'parts_search':
      return inventreeSearch(input.query);
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

const CONTROL_TOOLS = ['find_entities', 'call_service', 'manage_server', 'kopf_move'];
export const toolsFor = (withHome) => (withHome ? TOOLS : TOOLS.filter((t) => !CONTROL_TOOLS.includes(t.name)));

// ---------- Claude ----------
async function chatClaude(req, emit, signal) {
  const { messages, projectId } = req;
  const s = settings();
  if (!s.anthropicKey) throw new Error('Kein Anthropic-API-Key eingetragen (Einstellungen)');
  const withHome = Boolean(s.aiHomeControl);
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  // Datenblätter des Projekts (PDF) an die letzte Frage hängen
  const proj = projectId && projects.get(projectId);
  if (req.includeDocs && proj?.docs?.length && convo.at(-1)?.role === 'user') {
    let total = 0;
    const blocks = [];
    for (const d of proj.docs) {
      const f = uploadPath(String(d.url).split('/').pop());
      if (!f || !f.endsWith('.pdf')) continue;
      const buf = fs.readFileSync(f);
      if (total + buf.length > 20e6) break;
      total += buf.length;
      blocks.push(pdfBlock(buf));
    }
    if (blocks.length) convo[convo.length - 1] = { role: 'user', content: [...blocks, { type: 'text', text: String(convo.at(-1).content) }] };
  }

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
        tools: toolsFor(withHome),
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
  const url = s.kopfUrl.replace(/\/$/, '') + '/v1/chat/completions';
  const convo = [{ role: 'system', content: systemPrompt(projectId, s.kopfTools) }, ...messages];

  // Mit Werkzeugen: ohne Streaming, Schleife über tool_calls (OpenAI-Format, Ollama versteht das).
  if (s.kopfTools) {
    const tools = toolsFor(Boolean(s.aiHomeControl)).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    try {
      for (let round = 0; round < 5; round++) {
        const res = await fetch(url, {
          method: 'POST', signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: s.kopfModel || 'head-memory', stream: false, messages: convo, tools }),
        });
        if (!res.ok) throw new Error(`Kopf: ${res.status} ${(await res.text()).slice(0, 200)}`);
        const msg = (await res.json()).choices?.[0]?.message || {};
        const calls = msg.tool_calls || [];
        if (!calls.length) {
          if (msg.content) emit('delta', { text: msg.content });
          return;
        }
        convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        for (const c of calls) {
          let input = {};
          try { input = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function.arguments || {}; } catch {}
          let result;
          try { result = await runTool(c.function.name, input, projectId); } catch (e) { result = { error: e.message }; }
          emit('tool', { name: c.function.name, input, result });
          convo.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(result).slice(0, 12000) });
        }
      }
      return;
    } catch (e) {
      if (signal?.aborted) throw e;
      emit('delta', { text: `_(Werkzeuge nicht verfügbar: ${e.message} – antworte ohne)_\n\n` });
      convo[0] = { role: 'system', content: systemPrompt(projectId, false) };
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: s.kopfModel || 'head-memory', stream: true, messages: convo.filter((m) => !m.tool_calls && m.role !== 'tool') }),
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
