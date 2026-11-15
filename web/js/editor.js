// Auswahl-Dialoge und Kachel-Editor.
import { S, h, icon, modal, field, friendly, entityIcon, stateText, domainOf, uid } from './core.js';
import { TILE_TYPES, nodeName } from './tiles.js';

/** Entität(en) aus Home Assistant auswählen. */
export function pickEntity({ multiple = false, selected = [], domains } = {}) {
  return new Promise((resolve) => {
    const sel = new Set(selected);
    const areaName = Object.fromEntries(S.areas.map((a) => [a.area_id, a.name]));
    const all = [...S.states.values()]
      .filter((s) => !domains || domains.includes(domainOf(s.entity_id)))
      .sort((a, b) => friendly(a).localeCompare(friendly(b)));
    const domainsPresent = [...new Set(all.map((s) => domainOf(s.entity_id)))].sort();
    const q = h('input', { class: 'input', placeholder: 'Suchen (Name, entity_id, Raum) …', autofocus: true });
    const dom = h('select', { class: 'input', style: { maxWidth: '170px' } }, h('option', { value: '' }, 'Alle Bereiche'), domainsPresent.map((d) => h('option', { value: d }, d)));
    const list = h('div', { class: 'picker-list' });
    const draw = () => {
      const t = q.value.toLowerCase();
      const rows = all.filter((s) => (!dom.value || domainOf(s.entity_id) === dom.value) &&
        (!t || s.entity_id.includes(t) || friendly(s).toLowerCase().includes(t) || (areaName[S.entityAreas[s.entity_id]] || '').toLowerCase().includes(t))).slice(0, 300);
      list.replaceChildren(...rows.map((s) => h('button', {
        type: 'button', class: 'picker-item' + (sel.has(s.entity_id) ? ' sel' : ''),
        onclick: () => {
          if (!multiple) { resolve(s.entity_id); return close(); }
          sel.has(s.entity_id) ? sel.delete(s.entity_id) : sel.add(s.entity_id);
          draw();
        },
      }, icon(entityIcon(s)), h('div', { class: 'grow' }, friendly(s), h('small', {}, s.entity_id + (areaName[S.entityAreas[s.entity_id]] ? ' · ' + areaName[S.entityAreas[s.entity_id]] : ''))),
      h('span', { class: 'val', style: { fontSize: '12px', color: 'var(--muted)' } }, stateText(s)))));
      if (!rows.length) list.append(h('div', { class: 'empty' }, S.ha.status === 'connected' ? 'Nichts gefunden' : 'Home Assistant ist nicht verbunden (Einstellungen)'));
    };
    q.oninput = draw;
    dom.onchange = draw;
    draw();
    const close = modal('Entität wählen', h('div', {}, h('div', { class: 'row' }, q, dom), list), {
      actions: multiple ? (c) => [h('button', { class: 'btn primary', onclick: () => { resolve([...sel]); c(); } }, `Übernehmen (${sel.size})`)] : null,
      onClose: () => resolve(null),
    });
  });
}

function pickFrom(title, items) {
  return new Promise((resolve) => {
    const close = modal(title, h('div', { class: 'picker-list' }, items.length ? items.map(([value, label, sub, ic]) =>
      h('button', { type: 'button', class: 'picker-item', onclick: () => { resolve(value); close(); } }, icon(ic || 'circle-small'), h('div', { class: 'grow' }, label, sub ? h('small', {}, sub) : null)))
      : h('div', { class: 'empty' }, 'Keine Einträge vorhanden')), { onClose: () => resolve(null) });
  });
}

export const pickMeshNode = () => pickFrom('Mesh-Node wählen', [...S.mesh.nodes.values()].map((n) => [n.id, nodeName(n), n.id, 'radio-tower']));

function sizeControl(tile) {
  const opts = [[1, 1], [2, 1], [2, 2], [3, 2], [4, 2], [4, 3], [1, 2], [6, 3]];
  const wrap = h('div', { class: 'tagline' });
  const draw = () => wrap.replaceChildren(...opts.map(([w, hh]) =>
    h('button', { type: 'button', class: 'btn sm' + (tile.w === w && tile.h === hh ? ' active' : ''), onclick: () => { tile.w = w; tile.h = hh; draw(); } }, `${w}×${hh}`)));
  draw();
  return wrap;
}

/** Editor für eine Kachel. Gibt die geänderte Kachel zurück (oder null). */
export function editTile(original) {
  return new Promise((resolve) => {
    const tile = structuredClone(original);
    const type = TILE_TYPES[tile.type];
    const form = h('div', {});
    for (const f of type.fields || []) {
      let input;
      const val = tile[f.key];
      switch (f.kind) {
        case 'textarea':
          input = h('textarea', { class: 'input', oninput: (e) => (tile[f.key] = e.target.value) }, val || '');
          break;
        case 'number':
          input = h('input', { class: 'input', type: 'number', value: val ?? '', oninput: (e) => (tile[f.key] = e.target.value ? Number(e.target.value) : undefined) });
          break;
        case 'color':
          input = h('div', { class: 'row' },
            h('input', { class: 'input', type: 'color', value: val || '#00d8ff', style: { height: '42px', padding: '4px', flex: '0 0 70px' }, oninput: (e) => (tile[f.key] = e.target.value) }),
            h('button', { type: 'button', class: 'btn', onclick: () => delete tile[f.key] }, 'Standard'));
          break;
        case 'select':
          input = h('select', { class: 'input', onchange: (e) => (tile[f.key] = e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value || undefined) },
            f.options.map(([v, l]) => h('option', { value: v, selected: String(val ?? '') === String(v) }, l)));
          break;
        case 'entity': {
          const lbl = h('span', {}, val ? friendly(S.states.get(val), val) : 'Keine gewählt');
          input = h('button', { type: 'button', class: 'btn', style: { justifyContent: 'flex-start' }, onclick: async () => {
            const id = await pickEntity();
            if (id) { tile[f.key] = id; lbl.textContent = friendly(S.states.get(id), id); }
          } }, icon('magnify'), lbl);
          break;
        }
        case 'entities': {
          const tags = h('div', { class: 'tagline' });
          const draw = () => tags.replaceChildren(...(tile[f.key] || []).map((id, i) => h('span', { class: 'tag' }, friendly(S.states.get(id), id),
            h('button', { type: 'button', onclick: () => { tile[f.key].splice(i, 1); draw(); } }, '×'))),
          h('button', { type: 'button', class: 'btn sm', onclick: async () => {
            const ids = await pickEntity({ multiple: true, selected: tile[f.key] || [] });
            if (ids) { tile[f.key] = ids; draw(); }
          } }, icon('plus'), 'Wählen'));
          draw();
          input = tags;
          break;
        }
        case 'meshnode': {
          const lbl = h('span', {}, val ? nodeName(S.mesh.nodes.get(val)) || val : 'Keiner gewählt');
          input = h('button', { type: 'button', class: 'btn', style: { justifyContent: 'flex-start' }, onclick: async () => {
            const id = await pickMeshNode();
            if (id) { tile[f.key] = id; lbl.textContent = nodeName(S.mesh.nodes.get(id)); }
          } }, icon('radio-tower'), lbl);
          break;
        }
        case 'site':
          input = h('select', { class: 'input', onchange: (e) => (tile[f.key] = e.target.value) }, h('option', { value: '' }, '– wählen –'),
            S.sites.map((s) => h('option', { value: s.id, selected: s.id === val }, s.name)));
          break;
        case 'resource': {
          const list = () => ((tile.kind === 'vm' ? S.unraid?.vms : S.unraid?.containers) || []).map((x) => x.name);
          input = h('select', { class: 'input', onchange: (e) => (tile[f.key] = e.target.value) }, h('option', { value: '' }, S.unraid ? '– wählen –' : 'Unraid-API nicht verbunden'),
            [...new Set([...list(), val].filter(Boolean))].map((n) => h('option', { value: n, selected: n === val }, n)));
          break;
        }
        case 'project':
          input = h('select', { class: 'input', onchange: (e) => (tile[f.key] = e.target.value) }, h('option', { value: '' }, '– wählen –'),
            S.projects.map((p) => h('option', { value: p.id, selected: p.id === val }, p.name)));
          break;
        default:
          input = h('input', { class: 'input', value: val ?? '', oninput: (e) => (tile[f.key] = e.target.value) });
      }
      form.append(field(f.label, input, f.hint));
    }
    form.append(field('Größe (Breite × Höhe)', sizeControl(tile)));
    // Bedingung: Kachel nur zeigen, wenn eine Entität einen bestimmten Zustand hat
    const condLbl = h('span', {}, tile.condEntity ? friendly(S.states.get(tile.condEntity), tile.condEntity) : 'immer zeigen');
    const condRow = h('div', { class: 'row', style: { display: tile.condEntity ? '' : 'none' } },
      h('select', { class: 'input', style: { flex: '0 0 80px' }, onchange: (e) => (tile.condOp = e.target.value) }, ['=', '!=', '>', '<'].map((o) => h('option', { value: o, selected: (tile.condOp || '=') === o }, o))),
      h('input', { class: 'input', value: tile.condValue ?? 'on', placeholder: 'on', oninput: (e) => (tile.condValue = e.target.value) }));
    form.append(field('Nur zeigen, wenn …', h('div', {},
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', style: { justifyContent: 'flex-start' }, onclick: async () => {
          const id = await pickEntity();
          if (!id) return;
          tile.condEntity = id;
          condLbl.textContent = friendly(S.states.get(id), id);
          condRow.style.display = '';
        } }, icon('eye-check-outline'), condLbl),
        h('button', { type: 'button', class: 'btn', style: { flex: '0 0 auto' }, onclick: () => { delete tile.condEntity; condLbl.textContent = 'immer zeigen'; condRow.style.display = 'none'; } }, icon('close'))),
      condRow), 'z. B. Waschmaschine = on, Temperatur > 25. Im Bearbeiten-Modus bleibt die Kachel sichtbar.'));
    let saved = false;
    modal([icon(type.icon), type.label], form, {
      actions: (close) => [h('button', { class: 'btn primary', onclick: () => { saved = true; close(); resolve(tile); } }, 'Speichern')],
      onClose: () => !saved && resolve(null),
    });
  });
}

/** Neue Kachel: Typ wählen, dann Editor. */
export function addTileDialog() {
  return new Promise((resolve) => {
    const close = modal('Kachel hinzufügen', h('div', { class: 'type-grid' }, Object.entries(TILE_TYPES).map(([key, t]) =>
      h('button', { class: 'type-card', onclick: async () => {
        close();
        const tile = { id: uid(), type: key, ...structuredClone(t.defaults || { w: 1, h: 1 }) };
        if (key === 'entity') {
          const id = await pickEntity();
          if (!id) return resolve(null);
          tile.entity = id;
          const d = domainOf(id);
          if (['camera', 'media_player', 'climate'].includes(d)) { tile.w = 2; tile.h = d === 'camera' ? 2 : 1; }
          if (['light', 'sensor'].includes(d)) tile.w = 2;
          return resolve(tile);
        }
        resolve(await editTile(tile));
      } }, icon(t.icon), h('b', {}, t.label), h('small', {}, t.desc)))), { onClose: () => {} });
  });
}
