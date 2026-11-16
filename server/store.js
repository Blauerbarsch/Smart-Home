// Persistenz: alles liegt als JSON im Datenordner (/data im Container).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRET_KEYS = ['haToken', 'anthropicKey', 'mqttPassword', 'meshKeys', 'githubToken', 'ntfyToken', 'inventreeToken', 'unraidApiKey', 'moonrakerKey'];
const URL_KEYS = { haUrl: 'http://', kopfUrl: 'http://', kopfOutputUrl: 'http://', kopfVisionUrl: 'http://', kopfBodyUrl: 'http://', esphomeUrl: 'http://', mqttUrl: 'mqtt://', inventreeUrl: 'http://', ntfyUrl: 'https://', unraidUrl: 'http://' };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, data) {
  const target = path.join(DATA_DIR, file);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

export const id = () => crypto.randomBytes(6).toString('hex');

const DEFAULT_CONFIG = {
  settings: {
    haUrl: '',
    haToken: '',
    anthropicKey: '',
    claudeModel: 'claude-sonnet-5-5',
    kopfUrl: '',
    kopfModel: 'head-memory',
    kopfOutputUrl: '',
    kopfVisionUrl: '',
    esphomeUrl: '',
    defaultAi: 'claude',
    kopfTools: true,
    agentToken: '',
    kopfBodyUrl: '',
    meshAlerts: 'offline',
    meshAlertTarget: 'all',
    meshCommandNodes: '',
    aiHomeControl: true,
    accent: '#00d8ff',
    title: 'Zuhause',
    mqttUrl: '',
    mqttUser: '',
    mqttPassword: '',
    meshTopic: 'msh/#',
    meshSendTopic: '',
    meshGatewayId: '',
    meshChannel: 0,
    meshKeys: '',
    githubUser: 'Blauerbarsch',
    githubToken: '',
    githubAutoProjects: true,
    notifyHaService: '',
    ntfyUrl: '',
    ntfyToken: '',
    notifyKopf: false,
    unraidUrl: '',
    unraidApiKey: '',
    inventreeUrl: '',
    inventreeToken: '',
  },
  sites: [],
  tabs: [
    {
      id: 'home',
      name: 'Übersicht',
      icon: 'home',
      tiles: [
        { id: 't-clock', type: 'clock', w: 2, h: 1 },
        { id: 't-note', type: 'note', w: 2, h: 1, title: 'Willkommen', text: 'Oben rechts auf ✎ tippen, um Kacheln hinzuzufügen, zu verschieben und anzupassen.' },
        { id: 't-kopf', type: 'kopf', w: 2, h: 2 },
        { id: 't-mesh', type: 'meshlist', w: 2, h: 2 },
      ],
    },
    { id: 'map', name: 'Standorte', icon: 'map-marker-radius', type: 'map' },
    { id: 'server', name: 'Server', icon: 'server', type: 'server' },
    { id: 'automations', name: 'Automationen', icon: 'robot', type: 'automations' },
    { id: 'chronik', name: 'Chronik', icon: 'timeline-text-outline', type: 'chronik' },
    { id: 'workshop', name: 'Werkstatt', icon: 'atom-variant', type: 'workshop' },
  ],
};

let config = readJson('config.json', DEFAULT_CONFIG);
config.settings = { ...DEFAULT_CONFIG.settings, ...config.settings };
if (!Array.isArray(config.tabs) || !config.tabs.length) config.tabs = structuredClone(DEFAULT_CONFIG.tabs);
if (!Array.isArray(config.sites)) config.sites = [];
// Schlüssel für die Agent-Schnittstelle (Kopf ruft darüber Werkzeuge auf)
if (!config.settings.agentToken) {
  config.settings.agentToken = crypto.randomBytes(18).toString('base64url');
  writeJson('config.json', config);
}
// Einmalige Ergänzungen für bestehende Installationen
config.migrations ||= [];
if (!config.migrations.includes('v2-server-tab')) {
  if (!config.tabs.some((t) => t.type === 'server')) {
    const i = config.tabs.findIndex((t) => t.type === 'workshop');
    config.tabs.splice(i < 0 ? config.tabs.length : i, 0, { id: 'server', name: 'Server', icon: 'server', type: 'server' });
  }
  config.migrations.push('v2-server-tab');
  writeJson('config.json', config);
}
if (!config.migrations.includes('v3-chronik-automations')) {
  const at = () => { const i = config.tabs.findIndex((t) => t.type === 'workshop'); return i < 0 ? config.tabs.length : i; };
  if (!config.tabs.some((t) => t.type === 'automations')) config.tabs.splice(at(), 0, { id: 'automations', name: 'Automationen', icon: 'robot', type: 'automations' });
  if (!config.tabs.some((t) => t.type === 'chronik')) config.tabs.splice(at(), 0, { id: 'chronik', name: 'Chronik', icon: 'timeline-text-outline', type: 'chronik' });
  config.migrations.push('v3-chronik-automations');
  writeJson('config.json', config);
}

// Umgebungsvariablen haben Vorrang (praktisch für Unraid-Template).
const ENV_MAP = {
  haUrl: 'HA_URL',
  haToken: 'HA_TOKEN',
  anthropicKey: 'ANTHROPIC_API_KEY',
  claudeModel: 'CLAUDE_MODEL',
  kopfUrl: 'KOPF_URL',
  kopfOutputUrl: 'KOPF_OUTPUT_URL',
  kopfVisionUrl: 'KOPF_VISION_URL',
  kopfBodyUrl: 'KOPF_BODY_URL',
  esphomeUrl: 'ESPHOME_URL',
  mqttUrl: 'MQTT_URL',
  mqttUser: 'MQTT_USER',
  mqttPassword: 'MQTT_PASSWORD',
  meshTopic: 'MESH_TOPIC',
  meshKeys: 'MESH_KEYS',
  githubUser: 'GITHUB_USER',
  githubToken: 'GITHUB_TOKEN',
  inventreeUrl: 'INVENTREE_URL',
  inventreeToken: 'INVENTREE_TOKEN',
  ntfyUrl: 'NTFY_URL',
  unraidUrl: 'UNRAID_URL',
  unraidApiKey: 'UNRAID_API_KEY',
};

export function settings() {
  const s = { ...config.settings };
  for (const [k, env] of Object.entries(ENV_MAP)) {
    if (process.env[env]) s[k] = process.env[env];
  }
  return s;
}

export function envLocked() {
  return Object.entries(ENV_MAP).filter(([, env]) => process.env[env]).map(([k]) => k);
}

/** Einstellungen für den Browser: Geheimnisse nur als „gesetzt ja/nein“. */
export function publicSettings() {
  const s = settings();
  for (const k of SECRET_KEYS) s[k] = s[k] ? '••••••••' : '';
  return s;
}

export function saveSettings(patch) {
  for (let [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_CONFIG.settings)) continue;
    if (SECRET_KEYS.includes(k) && (v === '••••••••' || v === undefined)) continue;
    if (typeof v === 'string') v = v.trim();
    // Adressen ohne Schema ergänzen: „192.168.1.10:8123“ → „http://192.168.1.10:8123“
    if (URL_KEYS[k] && v && !/^[a-z]+:\/\//i.test(v)) v = URL_KEYS[k] + v;
    config.settings[k] = v;
  }
  writeJson('config.json', config);
}

export function layout() {
  return { tabs: config.tabs, sites: config.sites || [] };
}

export function saveLayout({ tabs, sites }) {
  if (tabs !== undefined) {
    if (!Array.isArray(tabs)) throw new Error('tabs muss eine Liste sein');
    config.tabs = tabs;
  }
  if (sites !== undefined) {
    if (!Array.isArray(sites)) throw new Error('sites muss eine Liste sein');
    config.sites = sites;
  }
  writeJson('config.json', config);
}

export { readJson, writeJson };

export function exportConfig() {
  const c = structuredClone(config);
  for (const k of SECRET_KEYS) delete c.settings[k];
  return { ...c, projects: projects.list };
}

export function importConfig(data) {
  if (data.tabs) config.tabs = data.tabs;
  if (data.sites) config.sites = data.sites;
  if (data.settings) saveSettings(data.settings);
  writeJson('config.json', config);
  if (Array.isArray(data.projects)) {
    projects.list = data.projects;
    projects.save();
  }
}

// ---------- Projekte ----------
export const projects = {
  list: readJson('projects.json', [
    {
      id: id(),
      name: 'Kopf',
      status: 'active',
      progress: 40,
      color: '#00d8ff',
      description: 'Lokale KI mit Gedächtnis – Roboterkopf mit Sehen, Hören und Sprechen.',
      tags: ['KI', 'Bazzite', 'Podman'],
      links: [{ label: 'GitHub', url: 'https://github.com/Blauerbarsch/local-ai' }],
      tasks: [
        { id: id(), text: 'Erster echter Start der Quadlets', done: false },
        { id: id(), text: 'Grafikspeicher prüfen (nvidia-smi)', done: false },
        { id: id(), text: 'Servos für head-body anschließen', done: false },
      ],
      parts: [],
      entities: [],
      notes: '',
      log: [],
      chat: [],
      created: Date.now(),
      updated: Date.now(),
    },
  ]),
  save() {
    writeJson('projects.json', this.list);
  },
  get(pid) {
    return this.list.find((p) => p.id === pid);
  },
  create(data) {
    const p = {
      id: id(),
      name: 'Neues Projekt',
      status: 'idea',
      progress: 0,
      color: '#00d8ff',
      description: '',
      tags: [],
      links: [],
      tasks: [],
      parts: [],
      entities: [],
      resources: [],
      repo: '',
      notes: '',
      log: [],
      chat: [],
      created: Date.now(),
      ...data,
      updated: Date.now(),
    };
    this.list.unshift(p);
    this.save();
    return p;
  },
  update(pid, patch) {
    const p = this.get(pid);
    if (!p) return null;
    delete patch.id;
    Object.assign(p, patch, { updated: Date.now() });
    this.save();
    return p;
  },
  remove(pid) {
    this.list = this.list.filter((p) => p.id !== pid);
    this.save();
  },
};
