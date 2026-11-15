// Kachel-Raster mit Bearbeiten-Modus (Ziehen, Größe, Bearbeiten, Löschen).
import { S, h, icon, on, saveLayout } from './core.js';
import { renderTile, tileDeps } from './tiles.js';
import { addTileDialog, editTile } from './editor.js';

export function renderGrid(tab, view) {
  const grid = h('div', { class: 'grid' + (S.editing ? ' editing' : '') });
  view.append(grid);
  const byId = () => new Map(tab.tiles.map((t) => [t.id, t]));

  const decorate = (tile, el) => {
    el.append(h('div', { class: 'edit-bar' },
      h('button', { title: 'Bearbeiten', onclick: async () => {
        const updated = await editTile(tile);
        if (!updated) return;
        Object.assign(tile, updated);
        saveLayout();
        replace(tile);
      } }, icon('pencil')),
      h('button', { title: 'Kopieren', onclick: () => {
        const copy = { ...structuredClone(tile), id: Math.random().toString(36).slice(2, 10) };
        tab.tiles.splice(tab.tiles.indexOf(tile) + 1, 0, copy);
        saveLayout();
        draw();
      } }, icon('content-copy')),
      h('button', { class: 'del', title: 'Entfernen', onclick: () => {
        tab.tiles.splice(tab.tiles.indexOf(tile), 1);
        saveLayout();
        draw();
      } }, icon('delete-outline'))));
    el.addEventListener('pointerdown', (e) => startDrag(e, el));
    return el;
  };

  const make = (tile) => decorate(tile, renderTile(tile));
  const replace = (tile) => {
    const old = grid.querySelector(`.tile[data-id="${tile.id}"]`);
    if (old && !old.dataset.busy) old.replaceWith(make(tile));
  };

  function draw() {
    grid.className = 'grid' + (S.editing ? ' editing' : '');
    grid.replaceChildren(...tab.tiles.map(make));
    if (S.editing) {
      grid.append(h('button', { class: 'add-tile', title: 'Kachel hinzufügen', onclick: async () => {
        const tile = await addTileDialog();
        if (!tile) return;
        tab.tiles.push(tile);
        saveLayout();
        draw();
      } }, icon('plus')));
    }
    if (!tab.tiles.length && !S.editing) {
      grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'Dieser Reiter ist leer – oben rechts auf ', icon('pencil'), ' tippen, um Kacheln hinzuzufügen.'));
    }
  }

  // ----- Ziehen & Ablegen (Maus und Touch) -----
  function startDrag(e, el) {
    if (!S.editing || e.button > 0 || e.target.closest('.edit-bar')) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null, ox = 0, oy = 0;
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        const r = el.getBoundingClientRect();
        ox = sx - r.left; oy = sy - r.top;
        ghost = el.cloneNode(true);
        ghost.classList.add('drag-ghost');
        Object.assign(ghost.style, { width: r.width + 'px', height: r.height + 'px' });
        document.body.append(ghost);
        el.classList.add('dragging');
      }
      ghost.style.left = ev.clientX - ox + 'px';
      ghost.style.top = ev.clientY - oy + 'px';
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tile');
      if (over && over !== el && over.parentElement === grid) {
        const r = over.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2 || ev.clientY > r.bottom - 10;
        over[after ? 'after' : 'before'](el);
      }
      // Am Rand automatisch scrollen
      const view = grid.closest('#view');
      if (ev.clientY < 80) view.scrollBy(0, -12);
      else if (ev.clientY > innerHeight - 80) view.scrollBy(0, 12);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (!ghost) return;
      ghost.remove();
      el.classList.remove('dragging');
      const map = byId();
      tab.tiles = [...grid.querySelectorAll('.tile')].map((x) => map.get(x.dataset.id)).filter(Boolean);
      saveLayout();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  draw();

  // Live-Aktualisierung nur der betroffenen Kacheln
  const offs = [
    on('state', ({ entity_id }) => tab.tiles.filter((t) => tileDeps(t).includes(entity_id)).forEach(replace)),
    on('mesh-node', (n) => tab.tiles.filter((t) => tileDeps(t).some((d) => d === 'mesh:*' || d === 'mesh:' + n.id)).forEach(replace)),
    on('projects', () => tab.tiles.filter((t) => tileDeps(t).includes('projects')).forEach(replace)),
    on('unraid', () => tab.tiles.filter((t) => tileDeps(t).includes('unraid')).forEach(replace)),
    on('services', () => tab.tiles.filter((t) => tileDeps(t).includes('services') || (t.type === 'app' && t.check)).forEach(replace)),
    on('notifications-changed', () => tab.tiles.filter((t) => tileDeps(t).includes('alerts')).forEach(replace)),
    on('snapshot', draw),
    on('edit', draw),
  ];
  return () => offs.forEach((off) => off());
}
