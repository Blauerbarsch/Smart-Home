// Reiter „Chronik“ (Zeitleiste) und „Automationen“ (HA-Automationen per Chat).
import { S, h, icon, api, on, toast, modal, ago, seg, callService } from './core.js';

const SOURCES = [['', 'Alles'], ['haus', 'Haus'], ['mesh', 'Mesh'], ['server', 'Server'], ['github', 'GitHub'], ['werkstatt', 'Werkstatt'], ['alarm', 'Alarme'], ['ki', 'KI']];
const SRC_ICON = { haus: 'home-outline', mesh: 'radio-tower', server: 'server', github: 'github', werkstatt: 'hammer-wrench', alarm: 'alert-outline', ki: 'robot-outline' };

export function renderChronik(view, actions) {
  let source = '', text = '', days = 7;
  const list = h('div', { class: 'chronik' });
  const q = h('input', { class: 'input', placeholder: 'Suchen … (z. B. Hütte, Lötstation, Minecraft)', style: { maxWidth: '320px' } });
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { text = q.value; load(); }, 300); };
  const daySel = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { days = Number(e.target.value); load(); } }, [[1, 'Heute'], [7, '7 Tage'], [30, '30 Tage'], [365, 'Jahr']].map(([v, l]) => h('option', { value: v, selected: v === days }, l)));
  const filters = h('div', {});
  const drawFilters = () => filters.replaceChildren(seg(SOURCES, source, (v) => { source = v; load(); }));
  drawFilters();
  view.append(h('div', { class: 'chronik-bar' }, filters, q, daySel), list);
  actions.prepend(h('button', { class: 'btn', title: 'Eigenen Eintrag', onclick: () => {
    const ti = h('input', { class: 'input', placeholder: 'Was ist passiert?' });
    modal([icon('pencil'), 'Eintrag'], ti, { actions: (c) => [h('button', { class: 'btn primary', onclick: async () => { if (ti.value) await api('/chronik', { body: { title: ti.value } }); c(); load(); } }, 'Speichern')] });
  } }, icon('plus'), h('span', { class: 'lbl' }, 'Eintrag')));

  async function load() {
    const d = await api(`/chronik?days=${days}&source=${source}&text=${encodeURIComponent(text)}&limit=600`);
    if (!d.entries.length) return list.replaceChildren(h('div', { class: 'empty' }, text ? 'Nichts gefunden.' : 'Noch keine Einträge – die Chronik füllt sich ab jetzt automatisch.'));
    const groups = new Map();
    for (const e of d.entries) {
      const day = new Date(e.ts).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
      (groups.get(day) || groups.set(day, []).get(day)).push(e);
    }
    list.replaceChildren(...[...groups].map(([day, es]) => h('div', { class: 'chr-day' }, h('div', { class: 'chr-date' }, day),
      ...es.map((e) => h('div', { class: 'chr-item src-' + e.source },
        h('span', { class: 'chr-time' }, new Date(e.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })),
        h('span', { class: 'chr-ic' }, icon(e.icon || SRC_ICON[e.source] || 'circle-small')),
        h('div', { class: 'grow' }, h('div', {}, e.title), e.detail ? h('div', { class: 'tile-sub', style: { whiteSpace: 'normal' } }, e.detail) : null))))));
  }
  load();
  const off = on('chronik', (e) => { if ((!source || e.source === source) && !text) load(); });
  return off;
}

// ---------- Automationen ----------
export function renderAutomations(view, actions) {
  const box = h('div', { class: 'settings', style: { maxWidth: '980px' } });
  view.append(box);
  actions.prepend(h('button', { class: 'btn primary', onclick: () => newAutomation() }, icon('robot-outline'), h('span', { class: 'lbl' }, 'Neu per Chat')));

  async function load() {
    const d = await api('/automations');
    box.replaceChildren(
      d.pending.length ? h('div', { class: 'card' }, h('h3', {}, icon('clipboard-clock-outline'), 'Entwürfe zum Bestätigen'),
        ...d.pending.map((p) => h('div', { class: 'list-item' }, icon('robot-outline'), h('span', { class: 'grow', style: { whiteSpace: 'normal' } }, p.automation.alias, h('div', { class: 'tile-sub', style: { whiteSpace: 'normal' } }, p.explanation)),
          h('button', { class: 'btn sm', onclick: () => preview(p, p.id) }, 'Ansehen'),
          h('button', { class: 'btn icon sm danger', onclick: async () => { await api('/automations/pending/' + p.id, { method: 'DELETE' }); load(); } }, icon('close'))))) : null,
      h('div', { class: 'card' }, h('h3', {}, icon('robot'), `Automationen in Home Assistant (${d.list.length})`),
        d.list.length ? h('div', { class: 'list' }, d.list.map((a) => h('div', { class: 'list-item' },
          h('button', { class: 'toggle' + (a.on ? ' on' : ''), onclick: async () => { await callService('automation', a.on ? 'turn_off' : 'turn_on', { entity_id: a.entity_id }); setTimeout(load, 600); } }),
          h('span', { class: 'grow' }, a.name || a.entity_id, h('div', { class: 'tile-sub' }, a.last ? `zuletzt ${ago(Date.parse(a.last))}` : 'noch nie ausgelöst')),
          h('button', { class: 'btn icon sm', title: 'Jetzt ausführen', onclick: () => callService('automation', 'trigger', { entity_id: a.entity_id }).then(() => toast('Ausgeführt')) }, icon('play')),
          a.id ? h('button', { class: 'btn icon sm', title: 'Per Chat ändern', onclick: async () => { try { const cfg = await api('/automations/' + a.id); newAutomation(cfg, a.id); } catch (e) { toast(e.message, true); } } }, icon('pencil')) : null,
          a.id ? h('button', { class: 'btn icon sm danger', title: 'Löschen', onclick: async () => { if (!confirm(`„${a.name}“ löschen?`)) return; await api('/automations/' + a.id, { method: 'DELETE' }); setTimeout(load, 800); } }, icon('delete-outline')) : null)))
          : h('div', { class: 'empty' }, S.ha.status === 'connected' ? 'Keine Automationen.' : 'Home Assistant ist nicht verbunden.')));
  }

  function newAutomation(existing, existingId) {
    const ta = h('textarea', { class: 'input', placeholder: 'z. B. „Wenn es in der Waldhütte unter 3 °C hat, schalte die Heizung ein und schick mir eine Nachricht. Wieder aus bei 8 °C.“', style: { minHeight: '110px' } });
    const out = h('div', {});
    modal([icon('robot-outline'), existing ? `„${existing.alias}“ ändern` : 'Automation per Chat'], h('div', {}, ta,
      existing ? h('div', { class: 'tile-sub', style: { marginTop: '6px' } }, 'Beschreibe, was sich ändern soll – die bestehende Automation wird mitgeschickt.') : null, out), {
      actions: (c) => [h('button', { class: 'btn primary', onclick: async (e) => {
        if (!ta.value.trim()) return;
        e.target.disabled = true;
        out.replaceChildren(h('div', { class: 'empty' }, 'Entwerfe …'));
        try {
          const text = existing ? `Bestehende Automation:\n${JSON.stringify(existing)}\n\nÄnderung: ${ta.value}` : ta.value;
          const d = await api('/automations/draft', { body: { text } });
          c();
          preview(d, null, existingId);
        } catch (er) { out.replaceChildren(h('div', { class: 'empty' }, er.message)); }
        e.target.disabled = false;
      } }, icon('creation'), 'Entwerfen')],
    });
  }

  function preview(d, pendingId, existingId) {
    const json = h('textarea', { class: 'input mono', style: { minHeight: '300px', fontFamily: 'var(--mono)', fontSize: '12px' } }, JSON.stringify(d.automation, null, 2));
    modal([icon('robot'), d.automation.alias || 'Entwurf'], h('div', {},
      h('p', {}, d.explanation || ''),
      d.warnings?.length ? h('div', { class: 'list' }, d.warnings.map((w) => h('div', { class: 'list-item' }, h('span', { class: 'fresh', style: { background: 'var(--warn)' } }), h('span', { class: 'grow', style: { whiteSpace: 'normal' } }, w)))) : null,
      h('div', { class: 'tile-sub', style: { margin: '8px 0 4px' } }, 'Automation (bearbeitbar):'), json), {
      wide: false,
      actions: (c) => [h('button', { class: 'btn primary', onclick: async () => {
        try {
          const automation = JSON.parse(json.value);
          await api('/automations/save', { body: { automation, id: existingId, pendingId } });
          toast('In Home Assistant gespeichert');
          c();
          setTimeout(load, 900);
        } catch (e) { toast(e.message, true); }
      } }, icon('content-save'), existingId ? 'Änderung speichern' : 'In HA speichern')],
    });
  }

  load();
  const off = on('state', ({ entity_id }) => entity_id.startsWith('automation.') && load());
  return off;
}
