// Werkstatt: Bastelprojekte + KI-Konsole im animierten HUD-Stil.
import { S, h, icon, api, apiStream, on, emit, toast, hexToRgb, friendly, stateText, ent, ago } from './core.js';
import { pickEntity, pickMeshNode } from './editor.js';
import { nodeName } from './tiles.js';
import { startBackground } from './hud-bg.js';
import { githubTab, diaryTab, resourcesTab, esphomeTab, partsStock, linkPart, reposPanel, repoSummary, resourceStatus } from './workshop-extra.js';
import { identifyDialog, timerWidget, measureTab, printTab, docsTab, releasesPanel, bodyEditor, filamentDialog } from './workbench-ui.js';

const STATUS = { idea: 'Idee', active: 'In Arbeit', paused: 'Pausiert', done: 'Fertig' };
const TABS = [['overview', 'Übersicht'], ['tasks', 'Aufgaben'], ['diary', 'Tagebuch'], ['parts', 'Teile'], ['notes', 'Notizen'], ['docs', 'Doku'], ['esphome', 'ESPHome'], ['measure', 'Messen'], ['print', '3D-Druck'], ['github', 'GitHub'], ['server', 'Server'], ['sensors', 'Sensoren'], ['links', 'Links']];
const chatState = { includeDocs: false };
const general = { chat: [] };

// ---------- Mini-Markdown (sicher: erst escapen) ----------
function md(src) {
  const e = String(src || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const blocks = [];
  let out = e.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, l, code) => `\u0000${blocks.push(`<pre><code>${code}</code></pre>`) - 1}\u0000`);
  out = out
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/(?:^[-*] .*(?:\n|$))+/gm, (m) => `<ul>${m.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')}</ul>`)
    .split(/\n{2,}/).map((p) => (/^\s*<(h\d|ul|pre)|\u0000/.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

export function renderWorkshop(view, initialId) {
  const offs = [];
  let sel = S.projects.find((p) => p.id === initialId) || S.projects.find((p) => p.id === S.workshopSel) || S.projects[0] || null;
  let leftMode = 'projects';
  let ptab = 'overview', filter = 'all', provider = S.settings.defaultAi || 'claude', speak = false, busy = null, mobile = 'center';

  const root = h('div', { class: 'hud' });
  const canvas = h('canvas', { class: 'hud-bg' });
  root.append(canvas);
  const stopBg = startBackground(canvas, () => sel?.color || S.settings.accent);

  // ---------- Kopfzeile ----------
  const clock = h('span', { class: 'clock' });
  const stats = h('div', { class: 'hud-stats' });
  const tick = () => (clock.textContent = new Date().toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).toUpperCase());
  tick();
  const iv = setInterval(tick, 1000);
  let kopf = {};
  const drawStats = () => {
    const meshOnline = [...S.mesh.nodes.values()].filter((n) => Date.now() - (n.lastSeen || 0) < 2 * 3600e3).length;
    stats.replaceChildren(
      h('span', { class: 'hud-stat' + (S.ha.status === 'connected' ? ' ok' : '') }, h('i'), `HA ${S.states.size}`),
      h('span', { class: 'hud-stat' + (S.mesh.status?.connected ? ' ok' : '') }, h('i'), `MESH ${meshOnline}/${S.mesh.nodes.size}`),
      h('span', { class: 'hud-stat' + (kopf.brain === 'ok' ? ' ok' : '') }, h('i'), 'KOPF'),
      h('span', { class: 'hud-stat' + (S.settings.anthropicKey ? ' ok' : '') }, h('i'), 'CLAUDE'));
  };
  const refreshKopf = () => api('/kopf/status').then((k) => { kopf = k; drawStats(); }).catch(() => {});
  refreshKopf();
  const kiv = setInterval(refreshKopf, 30000);
  drawStats();

  const mtabs = h('div', { class: 'hud-mobile-tabs' });
  const drawMtabs = () => mtabs.replaceChildren(...[['left', 'Projekte'], ['center', 'Projekt'], ['right', 'KI']].map(([k, l]) =>
    h('button', { class: 'hud-btn' + (mobile === k ? ' on' : ''), onclick: () => { mobile = k; drawMtabs(); applyMobile(); } }, l)));
  drawMtabs();

  const left = h('div', { class: 'hud-panel' });
  const center = h('div', { class: 'hud-panel' });
  const right = h('div', { class: 'hud-panel' });
  const applyMobile = () => [['left', left], ['center', center], ['right', right]].forEach(([k, el]) => el.classList.toggle('m-on', k === mobile));
  applyMobile();

  root.append(h('div', { class: 'hud-inner' },
    h('div', { class: 'hud-top' }, h('span', { class: 'title' }, h('span', { class: 'blink' }), 'Werkstatt'), stats,
      h('div', { class: 'hud-tools' }, timerWidget(),
        h('button', { class: 'hud-btn icon', title: 'Bauteil erkennen', onclick: () => identifyDialog(sel, () => save(), () => drawCenter()) }, icon('magnify-scan')),
        h('button', { class: 'hud-btn icon', title: 'Serieller Monitor', onclick: () => import('./esptools.js').then((m) => m.serialMonitor()) }, icon('console')),
        h('button', { class: 'hud-btn icon', title: 'Filament-Lager', onclick: filamentDialog }, icon('printer-3d-nozzle-outline')),
        S.settings.kopfBodyUrl ? h('button', { class: 'hud-btn icon', title: 'Kopf bewegen', onclick: bodyEditor }, icon('robot-outline')) : null),
      clock),
    mtabs,
    h('div', { class: 'hud-grid' }, left, center, right)));
  view.append(root);

  // ---------- Bootsequenz (einmal pro Sitzung) ----------
  if (!sessionStorage.getItem('hud-booted') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sessionStorage.setItem('hud-booted', '1');
    const lines = [
      ['Initialisiere Werkstatt-Interface', true],
      ['Home Assistant · ' + S.states.size + ' Entitäten', S.ha.status === 'connected'],
      ['Meshtastic · ' + S.mesh.nodes.size + ' Nodes', S.mesh.status?.connected],
      ['Projektdatenbank · ' + S.projects.length + ' Projekte', true],
      ['KI-Kern Claude', Boolean(S.settings.anthropicKey)],
      ['KI-Kern Kopf (lokal)', Boolean(S.settings.kopfUrl)],
      ['Alle Systeme bereit', true],
    ];
    const boot = h('div', { class: 'boot' }, h('div', {}, h('div', { class: 'ring' }), h('div', { class: 'lines' },
      lines.map(([t, ok], i) => h('div', { style: { animationDelay: `${0.15 + i * 0.18}s` } }, '> ' + t, h('span', { class: ok ? 'ok' : 'no' }, ok ? '[ OK ]' : '[ -- ]'))))));
    root.append(boot);
    setTimeout(() => (boot.style.opacity = 0), 0.15e3 + lines.length * 180 + 500);
    setTimeout(() => boot.remove(), 0.15e3 + lines.length * 180 + 1100);
  }

  // ---------- Speichern ----------
  let saveT;
  const save = (p = sel) => {
    if (!p) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => api('/projects/' + p.id, { method: 'PUT', body: p }).catch((e) => toast(e.message, true)), 400);
    emit('projects');
  };
  const autoProgress = (p) => {
    if (p.autoProgress === false || !p.tasks.length) return;
    p.progress = Math.round((p.tasks.filter((t) => t.done).length / p.tasks.length) * 100);
  };

  // ---------- Links: Projektliste ----------
  function drawLeft() {
    const modeSwitch = h('div', { style: { display: 'flex', gap: '4px' } }, [['projects', 'Projekte'], ['repos', 'Repos'], ['releases', 'Releases']].map(([k, l]) =>
      h('button', { class: 'hud-btn' + (leftMode === k ? ' on' : ''), onclick: () => { leftMode = k; drawLeft(); } }, l)));
    if (leftMode === 'releases') {
      left.replaceChildren(h('div', { class: 'hud-h' }, modeSwitch), releasesPanel());
      return;
    }
    if (leftMode === 'repos') {
      const { body, syncBtn } = reposPanel((p) => { leftMode = 'projects'; select(p); mobile = 'center'; drawMtabs(); applyMobile(); });
      left.replaceChildren(h('div', { class: 'hud-h' }, modeSwitch, h('span', { class: 'spacer' }), syncBtn), body);
      return;
    }
    const list = S.projects.filter((p) => filter === 'all' || p.status === filter);
    left.replaceChildren(
      h('div', { class: 'hud-h' }, modeSwitch, h('span', { class: 'n' }, String(S.projects.length).padStart(2, '0')), h('span', { class: 'spacer' }),
        h('button', { class: 'hud-btn icon', title: 'Neues Projekt', onclick: async () => {
          const p = await api('/projects', { body: { name: 'Neues Projekt', status: 'idea', color: S.settings.accent } });
          S.projects.unshift(p);
          select(p);
          setTimeout(() => center.querySelector('.pname')?.focus(), 50);
        } }, icon('plus'))),
      h('div', { class: 'filters' }, [['all', 'Alle'], ...Object.entries(STATUS)].map(([k, l]) =>
        h('button', { class: 'hud-btn' + (filter === k ? ' on' : ''), onclick: () => { filter = k; drawLeft(); } }, l))),
      h('div', { class: 'hud-body' }, list.length ? list.map((p) => h('div', {
        class: 'proj' + (p === sel ? ' sel' : ''), style: { '--pc': hexToRgb(p.color) }, onclick: () => { select(p); mobile = 'center'; drawMtabs(); applyMobile(); },
      }, h('div', { class: 'nm' }, p.name, p.repo ? h('span', { class: 'proj-ic', title: p.repo }, icon('github')) : null,
        (p.resources || []).some((r) => ['RUNNING', 'IDLE'].includes(String(resourceStatus(r)?.state).toUpperCase())) ? h('span', { class: 'proj-ic live', title: 'läuft' }, icon('circle')) : null),
      h('div', { class: 'st' }, h('span', {}, STATUS[p.status] || p.status), h('span', {}, p.progress + '%')),
      h('div', { class: 'bar' }, h('div', { style: { width: p.progress + '%' } })))) : h('div', { class: 'ai-empty' }, 'Keine Projekte')));
  }

  function select(p) {
    sel = p;
    S.workshopSel = p?.id;
    api('/workbench/active', { body: { project: p?.id || null } }).catch(() => {});
    history.replaceState(null, '', p ? `#workshop/${p.id}` : '#workshop');
    drawLeft();
    drawCenter();
    drawRight();
  }

  // ---------- Mitte: Projekt ----------
  function reactor(p) {
    const r = 70, C = 2 * Math.PI * r;
    const ticks = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2, r1 = 92, r2 = i % 5 ? 88 : 84;
      return `<line x1="${100 + r1 * Math.cos(a)}" y1="${100 + r1 * Math.sin(a)}" x2="${100 + r2 * Math.cos(a)}" y2="${100 + r2 * Math.sin(a)}" stroke="currentColor" stroke-width="1" opacity="${i % 5 ? 0.35 : 0.8}"/>`;
    }).join('');
    return h('div', { class: 'reactor', style: { color: `rgb(${hexToRgb(p.color) || 'var(--c-rgb)'})` }, html: `
      <svg viewBox="0 0 200 200">
        <g class="r3">${ticks}</g>
        <g class="r1"><circle cx="100" cy="100" r="80" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="40 12 4 12" opacity=".7"/></g>
        <g class="r2"><circle cx="100" cy="100" r="58" fill="none" stroke="currentColor" stroke-width="5" stroke-dasharray="2 6" opacity=".45"/></g>
        <circle cx="100" cy="100" r="${r}" fill="none" stroke="currentColor" stroke-width="3" opacity=".12"/>
        <circle cx="100" cy="100" r="${r}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
          stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - p.progress / 100)}" transform="rotate(-90 100 100)" style="filter:drop-shadow(0 0 6px currentColor);transition:stroke-dashoffset .8s"/>
        <circle class="pulse" cx="100" cy="100" r="40" fill="currentColor" opacity=".08"/>
      </svg>` }, h('div', { class: 'pct' }, h('div', {}, `${p.progress}%`, h('small', {}, 'Fortschritt'))));
  }

  function drawCenter() {
    if (!sel) return center.replaceChildren(h('div', { class: 'ai-empty' }, 'Lege links ein Projekt an.'));
    const p = sel;
    root.style.setProperty('--pc', hexToRgb(p.color));
    const name = h('div', { class: 'pname', contentEditable: 'plaintext-only', spellcheck: false, oninput: (e) => { p.name = e.target.textContent.trim() || 'Ohne Namen'; save(); drawLeftSoon(); } }, p.name);
    const desc = h('div', { class: 'pdesc', contentEditable: 'plaintext-only', 'data-ph': 'Beschreibung …', oninput: (e) => { p.description = e.target.textContent; save(); } }, p.description || '');
    const body = h('div', { class: 'hud-body' });
    const add = (...xs) => body.append(...xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    center.replaceChildren(
      h('div', { class: 'core' }, reactor(p), h('div', { class: 'core-info' }, name, desc, h('div', { class: 'meta-row' },
        h('select', { class: 'hud-input', onchange: (e) => { p.status = e.target.value; save(); drawLeft(); } }, Object.entries(STATUS).map(([k, l]) => h('option', { value: k, selected: k === p.status }, l))),
        h('input', { type: 'color', value: p.color || '#00d8ff', title: 'Projektfarbe', style: { width: '34px', height: '28px', border: 0, background: 'none', padding: 0 }, oninput: (e) => { p.color = e.target.value; save(); drawLeft(); drawCenter(); } }),
        h('input', { type: 'range', min: 0, max: 100, value: p.progress, title: 'Fortschritt manuell', style: { width: '110px' }, onchange: (e) => { p.progress = Number(e.target.value); p.autoProgress = false; save(); drawLeft(); drawCenter(); } }),
        h('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px', opacity: 0.6 } }, 'geändert ' + ago(p.updated)),
        h('button', { class: 'hud-btn icon danger', title: 'Projekt löschen', onclick: async () => {
          if (!confirm(`Projekt „${p.name}“ löschen?`)) return;
          await api('/projects/' + p.id, { method: 'DELETE' });
          S.projects = S.projects.filter((x) => x !== p);
          emit('projects');
          select(S.projects[0] || null);
        } }, icon('delete-outline'))))),
      h('div', { class: 'ptabs' }, TABS.map(([k, l]) => h('button', { class: ptab === k ? 'on' : '', onclick: () => { ptab = k; drawCenter(); } }, l))),
      body);

    if (ptab === 'overview') {
      const open = p.tasks.filter((t) => !t.done);
      add(
        h('div', { class: 'readouts' },
          readout('Aufgaben offen', `${open.length}/${p.tasks.length}`),
          readout('Teile fehlen', String(p.parts.filter((x) => !x.have).length)),
          readout('Sensoren', String(p.entities.length)),
          readout('Erstellt', new Date(p.created).toLocaleDateString('de-DE'))),
        h('div', { class: 'hud-h', style: { padding: '14px 0 6px', border: 0 } }, 'Nächste Schritte'),
        open.slice(0, 5).map((t) => taskRow(p, t)),
        !open.length ? h('div', { class: 'ai-empty' }, p.tasks.length ? 'Alles erledigt ✓' : 'Noch keine Aufgaben') : null,
        p.entities.length ? [h('div', { class: 'hud-h', style: { padding: '14px 0 6px', border: 0 } }, 'Live-Werte'), sensorReadouts(p, false)] : null,
        p.resources?.length ? [h('div', { class: 'hud-h', style: { padding: '14px 0 6px', border: 0 } }, 'Läuft auf'), h('div', { class: 'readouts' }, p.resources.map((r) => {
          const it = resourceStatus(r);
          return readout(r.name, it ? (['RUNNING', 'IDLE'].includes(String(it.state).toUpperCase()) ? '● läuft' : '○ aus') : r.type === 'host' ? 'Rechner' : '–');
        }))] : null,
        p.repo ? repoSummary(p) : null,
        p.notes ? [h('div', { class: 'hud-h', style: { padding: '14px 0 6px', border: 0 } }, 'Notizen'), h('div', { class: 'md', html: md(p.notes.slice(0, 1200)) })] : null);
    } else if (ptab === 'measure') {
      measureTab(p, add);
    } else if (ptab === 'print') {
      printTab(p, add, save, drawCenter);
    } else if (ptab === 'docs') {
      docsTab(p, add, save, drawCenter, chatState);
    } else if (ptab === 'github') {
      githubTab(p, add, md, save, drawCenter);
    } else if (ptab === 'diary') {
      diaryTab(p, add);
    } else if (ptab === 'server') {
      resourcesTab(p, add, save, drawCenter);
    } else if (ptab === 'esphome') {
      esphomeTab(p, add, save, drawCenter);
    } else if (ptab === 'tasks') {
      const input = h('input', { class: 'hud-input', placeholder: 'Neue Aufgabe + Enter', onkeydown: (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        p.tasks.push({ id: Math.random().toString(36).slice(2, 9), text: e.target.value.trim(), done: false });
        autoProgress(p); save(); drawCenter(); drawLeft();
        center.querySelector('.hud-body input')?.focus();
      } });
      add(input, h('div', { style: { marginTop: '8px' } }, p.tasks.map((t) => taskRow(p, t, true))));
    } else if (ptab === 'parts') {
      let partsBox;
      const name = h('input', { class: 'hud-input', placeholder: 'Bauteil (z. B. ESP32-C3, BME280)' });
      const qty = h('input', { class: 'hud-input', type: 'number', value: 1, style: { width: '70px' } });
      const addPart = () => { if (!name.value.trim()) return; p.parts.push({ id: Math.random().toString(36).slice(2, 9), name: name.value.trim(), qty: Number(qty.value) || 1, have: false }); save(); drawCenter(); };
      name.onkeydown = (e) => e.key === 'Enter' && addPart();
      add(h('div', { style: { display: 'flex', gap: '6px' } }, name, qty, h('button', { class: 'hud-btn', onclick: addPart }, icon('plus')),
          h('button', { class: 'hud-btn', title: 'Bauteil per Foto erkennen', onclick: () => identifyDialog(p, save, drawCenter) }, icon('magnify-scan'))),
        (partsBox = h('div', { style: { marginTop: '8px' } }, p.parts.map((x, i) => h('div', { class: 'task' + (x.have ? ' done' : '') },
          h('button', { class: 'chk', title: 'vorhanden', onclick: () => { x.have = !x.have; save(); drawCenter(); } }, x.have ? '✓' : ''),
          h('span', { class: 't' }, `${x.qty}× ${x.name}`),
          x.inventree ? h('span', { class: 'gh-meta', 'data-pk': x.inventree }, 'Lager …') : null,
          S.settings.inventreeUrl ? h('button', { class: 'hud-btn icon', title: 'Mit Teilelager verknüpfen', onclick: () => linkPart(x, save, drawCenter) }, icon('package-variant-closed')) : null,
          h('button', { class: 'x', onclick: () => { p.parts.splice(i, 1); save(); drawCenter(); } }, '×'))))),
        !p.parts.length ? h('div', { class: 'ai-empty' }, 'Stückliste leer – frag die KI nach einer Teileliste.') : null);
      partsStock(p, partsBox, save, drawCenter);
    } else if (ptab === 'notes') {
      let editing = !p.notes;
      const box = h('div', {});
      const drawNotes = () => box.replaceChildren(editing
        ? h('textarea', { class: 'hud-input', style: { minHeight: '320px' }, placeholder: 'Markdown: Pinbelegung, YAML, Ideen …', oninput: (e) => { p.notes = e.target.value; save(); } }, p.notes || '')
        : h('div', { class: 'md', html: md(p.notes) }));
      add(h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' } },
        h('button', { class: 'hud-btn', onclick: () => { editing = !editing; drawNotes(); } }, icon('pencil'), 'Bearbeiten / Vorschau')), box);
      drawNotes();
    } else if (ptab === 'sensors') {
      add(h('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
        h('button', { class: 'hud-btn', onclick: async () => { const ids = await pickEntity({ multiple: true, selected: p.entities.filter((x) => !x.startsWith('mesh:')) }); if (ids) { p.entities = [...p.entities.filter((x) => x.startsWith('mesh:')), ...ids]; save(); drawCenter(); } } }, icon('home-assistant'), 'HA-Entitäten'),
        h('button', { class: 'hud-btn', onclick: async () => { const id = await pickMeshNode(); if (id && !p.entities.includes('mesh:' + id)) { p.entities.push('mesh:' + id); save(); drawCenter(); } } }, icon('radio-tower'), 'Mesh-Node')),
        p.entities.length ? sensorReadouts(p, true) : h('div', { class: 'ai-empty' }, 'Verknüpfe ESPHome-Sensoren oder Mesh-Nodes, die zu diesem Projekt gehören. Die KI sieht sie als Kontext.'));
    } else if (ptab === 'links') {
      const label = h('input', { class: 'hud-input', placeholder: 'Titel' });
      const url = h('input', { class: 'hud-input', placeholder: 'https://…' });
      add(h('div', { style: { display: 'flex', gap: '6px' } }, label, url, h('button', { class: 'hud-btn', onclick: () => { if (!url.value) return; p.links.push({ label: label.value || url.value, url: url.value }); save(); drawCenter(); } }, icon('plus'))),
        h('div', { style: { marginTop: '8px' } }, p.links.map((l, i) => h('div', { class: 'task' }, icon('link-variant'),
          h('a', { class: 't', href: l.url, target: '_blank', rel: 'noopener', style: { color: 'rgb(var(--c-rgb))' } }, l.label),
          h('button', { class: 'x', onclick: () => { p.links.splice(i, 1); save(); drawCenter(); } }, '×')))));
    }
  }

  const readout = (k, v, onRemove) => h('div', { class: 'readout' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), onRemove ? h('button', { class: 'x', onclick: onRemove }, '×') : null);
  function sensorReadouts(p, removable) {
    return h('div', { class: 'readouts' }, p.entities.map((id, i) => {
      const rm = removable ? () => { p.entities.splice(i, 1); save(); drawCenter(); } : null;
      if (id.startsWith('mesh:')) {
        const n = S.mesh.nodes.get(id.slice(5));
        const v = n ? [typeof n.temperature === 'number' && n.temperature.toFixed(1) + '°', typeof n.battery === 'number' && n.battery + '%'].filter(Boolean).join(' ') || ago(n.lastSeen) : '–';
        return readout('⌁ ' + (nodeName(n) || id.slice(5)), v, rm);
      }
      return readout(friendly(ent(id), id), stateText(ent(id)), rm);
    }));
  }

  function taskRow(p, t, removable) {
    return h('div', { class: 'task' + (t.done ? ' done' : '') },
      h('button', { class: 'chk', onclick: () => { t.done = !t.done; autoProgress(p); save(); drawCenter(); drawLeft(); } }, t.done ? '✓' : ''),
      h('span', { class: 't', contentEditable: removable ? 'plaintext-only' : 'false', oninput: (e) => { t.text = e.target.textContent; save(); } }, t.text),
      removable ? h('button', { class: 'x', onclick: () => { p.tasks.splice(p.tasks.indexOf(t), 1); autoProgress(p); save(); drawCenter(); drawLeft(); } }, '×') : null);
  }

  let leftT;
  const drawLeftSoon = () => { clearTimeout(leftT); leftT = setTimeout(drawLeft, 300); };

  // ---------- Rechts: KI-Konsole ----------
  const log = h('div', { class: 'ai-log' });
  const logBox = h('div', { class: 'hud-body' }, log);
  const input = h('textarea', { class: 'hud-input', rows: 1, placeholder: 'Frag Claude oder Kopf …',
    oninput: (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  const sendBtn = h('button', { class: 'hud-btn icon', title: 'Senden', onclick: () => (busy ? busy.abort() : send()) }, icon('send'));
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = SR ? h('button', { class: 'hud-btn icon', title: 'Spracheingabe', onclick: () => listen() }, icon('microphone')) : null;

  const chat = () => (sel ? (sel.chat ||= []) : general.chat);

  function drawRight() {
    const provSeg = h('div', { style: { display: 'flex', gap: '4px' } }, [['claude', 'Claude'], ['kopf', 'Kopf']].map(([k, l]) =>
      h('button', { class: 'hud-btn' + (provider === k ? ' on' : ''), onclick: () => { provider = k; drawRight(); } }, l)));
    right.replaceChildren(
      h('div', { class: 'hud-h' }, 'KI-Konsole', h('span', { class: 'spacer' }), provSeg),
      logBox,
      h('div', { class: 'ai-input' }, micBtn,
        h('button', { class: 'hud-btn icon' + (speak ? ' on' : ''), title: 'Antworten über Kopf vorlesen', onclick: (e) => { speak = !speak; e.currentTarget.classList.toggle('on', speak); } }, icon('account-voice')),
        input, sendBtn,
        h('button', { class: 'hud-btn icon', title: 'Verlauf leeren', onclick: () => { chat().length = 0; save(); drawLog(); } }, icon('broom'))));
    drawLog();
  }

  function drawLog() {
    const c = chat();
    log.replaceChildren(...c.map(msgEl));
    if (!c.length) {
      const ideas = sel
        ? (sel.repo ? [`Was hat sich zuletzt in ${sel.repo} getan?`, 'Was sind die nächsten sinnvollen Schritte?', 'Läuft der Build gerade?'] : [`Erstelle eine Teileliste für ${sel.name}`, 'Was sind die nächsten sinnvollen Schritte?', 'Schreib mir eine ESPHome-YAML dafür'])
        : ['Welche Mesh-Nodes sind gerade offline?', 'Mach im Wohnzimmer das Licht auf 30 %'];
      log.append(h('div', { class: 'ai-empty' }, `${provider === 'claude' ? 'CLAUDE' : 'KOPF'} BEREIT`, h('br'), sel ? `Kontext: ${sel.name}` : 'Kein Projekt gewählt',
        h('div', { class: 'suggest' }, ideas.map((t) => h('button', { class: 'hud-btn', onclick: () => { input.value = t; send(); } }, t)))));
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function msgEl(m) {
    const who = m.role === 'user' ? 'Du' : (m.provider === 'kopf' ? 'Kopf' : 'Claude');
    return h('div', { class: `ai-msg ${m.role}` }, h('div', { class: 'who' }, who),
      (m.tools || []).map((t) => h('div', { class: 'ai-tool' }, `▸ ${t}`)),
      m.role === 'user' ? h('div', {}, m.content) : h('div', { class: 'md', html: md(m.content) }));
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    input.style.height = 'auto';
    const c = chat();
    const project = sel;
    c.push({ role: 'user', content: text });
    const reply = { role: 'assistant', content: '', provider, tools: [] };
    c.push(reply);
    drawLog();
    const el = log.lastChild;
    el.classList.add('streaming');
    const mdBox = el.querySelector('.md');
    busy = new AbortController();
    sendBtn.replaceChildren(icon('stop'));
    let raf = 0;
    const paint = () => { raf = 0; mdBox.innerHTML = md(reply.content) || '<p></p>'; logBox.scrollTop = logBox.scrollHeight; };
    let touchedProject = false;
    try {
      const history = c.slice(0, -1).slice(-20).map(({ role, content }) => ({ role, content }));
      await apiStream('/ai/chat', { provider, messages: history, projectId: project?.id, includeDocs: chatState.includeDocs && provider === 'claude' }, (ev, data) => {
        if (ev === 'delta') { reply.content += data.text; raf ||= requestAnimationFrame(paint); }
        else if (ev === 'tool') {
          const label = data.name === 'call_service' ? `${data.input.domain}.${data.input.service} ${data.input.entity_id || ''}` : data.name.replace(/_/g, ' ');
          reply.tools.push(label + (data.result?.error ? ` ✗ ${data.result.error}` : ' ✓'));
          el.insertBefore(h('div', { class: 'ai-tool' }, '▸ ' + reply.tools.at(-1)), mdBox);
          if (data.name.includes('project')) touchedProject = true;
        } else if (ev === 'error') reply.content += `\n\n**Fehler:** ${data.message}`;
      }, busy.signal);
    } catch (e) {
      if (e.name !== 'AbortError') reply.content += `\n\n**Fehler:** ${e.message}`;
    }
    busy = null;
    sendBtn.replaceChildren(icon('send'));
    reply.content = reply.content.trim() || '(keine Antwort)';
    paint();
    el.classList.remove('streaming');
    if (c.length > 60) c.splice(0, c.length - 60);
    if (touchedProject && project) {
      const fresh = (await api('/projects')).find((x) => x.id === project.id);
      if (fresh) { fresh.chat = project.chat; Object.assign(project, fresh); drawCenter(); drawLeft(); }
    }
    if (project) save(project);
    if (speak && reply.content) {
      const plain = reply.content.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>_\[\]()]/g, '').slice(0, 600);
      api('/kopf/speak', { body: { text: plain } }).catch((e) => toast(e.message, true));
    }
  }

  let rec = null;
  function listen() {
    if (rec) return rec.stop();
    rec = new SR();
    rec.lang = 'de-DE';
    rec.interimResults = true;
    micBtn.classList.add('rec');
    rec.onresult = (e) => { input.value = [...e.results].map((r) => r[0].transcript).join(''); };
    rec.onend = () => { micBtn.classList.remove('rec'); rec = null; if (input.value.trim()) send(); };
    rec.onerror = (e) => toast('Spracheingabe: ' + e.error, true);
    rec.start();
  }

  drawLeft();
  drawCenter();
  drawRight();

  let liveT;
  offs.push(
    on('state', ({ entity_id }) => { if (sel?.entities.includes(entity_id) && ['overview', 'sensors'].includes(ptab)) { clearTimeout(liveT); liveT = setTimeout(drawCenterKeepFocus, 500); } }),
    on('mesh-node', () => drawStats()),
    on('unraid', () => { if (['overview', 'server'].includes(ptab)) drawCenterKeepFocus(); drawLeftSoon(); }),
    on('projects', () => drawLeftSoon()),
    on('ha', drawStats),
  );
  function drawCenterKeepFocus() { if (!center.contains(document.activeElement)) drawCenter(); }

  return () => { offs.forEach((o) => o()); clearInterval(iv); clearInterval(kiv); stopBg(); busy?.abort(); };
}
