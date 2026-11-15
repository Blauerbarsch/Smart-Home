import { S, h, icon, api, on, emit, toast, setAccent, saveLayout } from './core.js';
import { renderGrid } from './grid.js';
import { renderSettings } from './settings.js';

const view = document.getElementById('view');
let cleanup = null;

// ---------- Start ----------
async function boot() {
  try {
    const auth = await fetch('/api/auth').then((r) => r.json());
    if (auth.required && !auth.ok) return showLogin();
    const data = await api('/bootstrap');
    load(data);
    connectEvents();
    renderNav();
    route();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch (e) {
    view.replaceChildren(h('div', { class: 'empty' }, 'Server nicht erreichbar: ' + e.message));
  }
}

function load(d) {
  S.settings = d.settings;
  S.envLocked = d.envLocked || [];
  S.tabs = d.tabs;
  S.sites = d.sites || [];
  S.projects = d.projects;
  S.states = new Map(d.states.map((s) => [s.entity_id, s]));
  S.areas = d.areas || [];
  S.entityAreas = d.entityAreas || {};
  S.ha = d.ha;
  S.mesh.status = d.mesh.status;
  S.mesh.configured = d.mesh.configured;
  S.mesh.nodes = new Map(d.mesh.nodes.map((n) => [n.id, n]));
  S.mesh.messages = d.mesh.messages;
  S.authRequired = d.auth;
  setAccent(S.settings.accent);
  document.title = S.settings.title || 'Zuhause';
  document.getElementById('brand-title').textContent = S.settings.title || 'Zuhause';
}
on('reload', async () => {
  load(await api('/bootstrap'));
  renderNav();
  route();
});

function showLogin() {
  document.getElementById('app').style.display = 'none';
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Passwort', autofocus: true });
  const box = h('div', { class: 'login' }, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('/login', { body: { password: pw.value } });
        box.remove();
        document.getElementById('app').style.display = '';
        boot();
      } catch (er) { toast(er.message, true); }
    },
  }, h('div', { class: 'brand' }, h('span', { class: 'brand-dot' }), 'Zuhause'), pw, h('button', { class: 'btn primary' }, 'Anmelden')));
  document.body.append(box);
}
on('unauthorized', () => location.reload());

// ---------- Live-Verbindung ----------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    const { entity_id, state } = JSON.parse(e.data);
    state ? S.states.set(entity_id, state) : S.states.delete(entity_id);
    emit('state', { entity_id, state });
  });
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    S.states = new Map(d.states.map((s) => [s.entity_id, s]));
    S.areas = d.areas;
    S.entityAreas = d.entityAreas;
    emit('snapshot');
  });
  es.addEventListener('ha', (e) => { S.ha = JSON.parse(e.data); renderStatus(); emit('ha'); });
  es.addEventListener('mesh', (e) => { S.mesh.status = JSON.parse(e.data); renderStatus(); });
  es.addEventListener('mesh-node', (e) => {
    const n = JSON.parse(e.data);
    S.mesh.nodes.set(n.id, { ...S.mesh.nodes.get(n.id), ...n });
    emit('mesh-node', n);
  });
  es.addEventListener('mesh-text', (e) => {
    const m = JSON.parse(e.data);
    S.mesh.messages.push(m);
    emit('mesh-text', m);
  });
  es.onerror = () => { S.ha = { ...S.ha, status: 'offline' }; renderStatus(); };
  es.addEventListener('hello', () => renderStatus());
}

// ---------- Navigation ----------
function renderNav() {
  const tabs = document.getElementById('tabs');
  tabs.replaceChildren(...S.tabs.filter((t) => !t.hidden).map((t) =>
    h('button', { class: 'nav-btn', 'data-tab': t.id, onclick: () => (location.hash = '#' + t.id) }, icon(t.icon || 'view-dashboard'), h('span', {}, t.name))));
  document.querySelector('.nav-bottom .nav-btn').onclick = () => (location.hash = '#settings');
}

function renderStatus() {
  const box = document.getElementById('top-status');
  const ha = S.ha.status;
  const chips = [
    h('span', { class: 'chip ' + (ha === 'connected' ? 'ok' : ha === 'unconfigured' ? '' : 'bad'), title: S.ha.error || '' },
      h('span', { class: 'dot' }), 'Home Assistant'),
  ];
  if (S.mesh.configured || S.mesh.status?.connected) {
    const online = [...S.mesh.nodes.values()].filter((n) => Date.now() - (n.lastSeen || 0) < 2 * 3600e3).length;
    chips.push(h('span', { class: 'chip ' + (S.mesh.status?.connected ? 'ok' : 'bad'), title: S.mesh.status?.error || '' }, h('span', { class: 'dot' }), `Mesh · ${online}`));
  }
  box.replaceChildren(...chips);
}

function route() {
  const [id, sub] = location.hash.slice(1).split('/');
  const tab = S.tabs.find((t) => t.id === id) || (id === 'settings' ? { id: 'settings', name: 'Einstellungen', type: 'settings' } : S.tabs.find((t) => !t.hidden));
  S.current = tab;
  cleanup?.();
  cleanup = null;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab.id));
  document.getElementById('page-title').textContent = tab.name;
  document.getElementById('topbar').style.display = tab.type === 'workshop' ? 'none' : '';
  const actions = document.getElementById('top-actions');
  actions.replaceChildren();
  view.replaceChildren();
  view.className = '';
  renderStatus();

  const type = tab.type || 'grid';
  if (type === 'grid') {
    tab.tiles ||= [];
    const btn = h('button', { class: 'btn icon' + (S.editing ? ' active' : ''), title: 'Bearbeiten', onclick: () => {
      S.editing = !S.editing;
      btn.classList.toggle('active', S.editing);
      btn.replaceChildren(icon(S.editing ? 'check' : 'pencil'));
      emit('edit');
    } }, icon(S.editing ? 'check' : 'pencil'));
    actions.append(btn);
    cleanup = renderGrid(tab, view);
  } else if (type === 'map') {
    view.className = 'full';
    import('./map.js').then((m) => { if (S.current === tab) cleanup = m.renderMap(view, actions); });
  } else if (type === 'workshop') {
    view.className = 'full';
    import('./workshop.js').then((m) => { if (S.current === tab) cleanup = m.renderWorkshop(view, sub); });
  } else if (type === 'settings') {
    cleanup = renderSettings(view, () => { renderNav(); route(); });
  }
}

addEventListener('hashchange', route);
// Mesh-Status-Chip regelmäßig auffrischen (Zeit läuft ab)
setInterval(renderStatus, 60000);
export { saveLayout };
boot();
