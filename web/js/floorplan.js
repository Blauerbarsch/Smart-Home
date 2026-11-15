// Grundriss: eigenes Bild (Plan, Foto, Skizze) mit platzierbaren Geräten.
import { S, h, icon, on, saveLayout, toast, ent, domainOf, entityIcon, stateText, isOn, friendly, callService, uid, hexToRgb } from './core.js';
import { pickEntity } from './editor.js';

const TOGGLE = ['light', 'switch', 'input_boolean', 'fan', 'cover', 'lock', 'scene', 'script', 'automation', 'button'];

export function renderFloorplan(tab, view, actions) {
  tab.markers ||= [];
  let editing = false;
  const stage = h('div', { class: 'fp-stage' });
  const img = h('img', { class: 'fp-img', alt: '' });
  const layer = h('div', { class: 'fp-layer' });
  const wrap = h('div', { class: 'fp-wrap' }, h('div', { class: 'fp-box' }, img, layer));
  stage.append(wrap);
  view.append(stage);

  const fileIn = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': f.type }, body: f });
    const j = await res.json();
    if (!res.ok) return toast(j.error, true);
    tab.image = j.url;
    saveLayout();
    draw();
  } });
  const editBtn = h('button', { class: 'btn icon', title: 'Bearbeiten', onclick: () => { editing = !editing; editBtn.classList.toggle('active', editing); editBtn.replaceChildren(icon(editing ? 'check' : 'pencil')); draw(); } }, icon('pencil'));
  const addBtn = h('button', { class: 'btn', onclick: async () => {
    const ids = await pickEntity({ multiple: true });
    if (!ids?.length) return;
    ids.forEach((id, i) => tab.markers.push({ id: uid(), entity: id, x: 45 + (i % 5) * 3, y: 45 + Math.floor(i / 5) * 4 }));
    saveLayout();
    draw();
  } }, icon('plus'), 'Gerät');
  const imgBtn = h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('image-outline'), 'Bild');
  actions.prepend(fileIn, editBtn);

  function draw() {
    addBtn.remove(); imgBtn.remove();
    if (editing) editBtn.before(imgBtn, addBtn);
    stage.classList.toggle('editing', editing);
    if (!tab.image) {
      img.removeAttribute('src');
      wrap.classList.add('noimg');
      layer.replaceChildren(h('div', { class: 'empty', style: { pointerEvents: 'auto' } }, 'Lade einen Grundriss hoch (Foto einer Skizze reicht) – ', h('button', { class: 'btn sm', onclick: () => fileIn.click() }, icon('upload'), 'Bild wählen')));
      return;
    }
    wrap.classList.remove('noimg');
    if (img.getAttribute('src') !== tab.image) img.src = tab.image;
    layer.replaceChildren(...tab.markers.map(marker));
  }

  function marker(m) {
    const st = ent(m.entity);
    const d = domainOf(m.entity);
    const onState = isOn(st);
    const numeric = st && Number.isFinite(Number(st.state)) && st.state !== '';
    const el = h('div', {
      class: 'fp-marker' + (onState ? ' on' : '') + (numeric ? ' value' : '') + (!st || st.state === 'unavailable' ? ' off' : ''),
      style: { left: m.x + '%', top: m.y + '%', '--tc-rgb': d === 'light' && st?.attributes?.rgb_color && onState ? st.attributes.rgb_color.join(',') : null },
      title: `${friendly(st, m.entity)}: ${stateText(st)}`,
    }, h('div', { class: 'fp-dot' }, icon(m.icon || entityIcon(st))),
    numeric || m.showLabel ? h('div', { class: 'fp-label' }, numeric ? stateText(st) : m.label || friendly(st, m.entity)) : null,
    editing ? h('button', { class: 'fp-del', title: 'Entfernen', onclick: (e) => { e.stopPropagation(); tab.markers.splice(tab.markers.indexOf(m), 1); saveLayout(); draw(); } }, '×') : null);
    if (editing) el.addEventListener('pointerdown', (e) => drag(e, m, el));
    else if (st && TOGGLE.includes(d)) el.addEventListener('click', () => {
      if (['scene', 'script'].includes(d)) return callService(d, 'turn_on', { entity_id: m.entity });
      if (d === 'button') return callService('button', 'press', { entity_id: m.entity });
      if (d === 'lock') return callService('lock', st.state === 'locked' ? 'unlock' : 'lock', { entity_id: m.entity });
      if (d === 'cover') return callService('cover', 'toggle', { entity_id: m.entity });
      callService('homeassistant', 'toggle', { entity_id: m.entity });
    });
    return el;
  }

  function drag(e, m, el) {
    if (e.target.closest('.fp-del')) return;
    e.preventDefault();
    const box = layer.getBoundingClientRect();
    const move = (ev) => {
      m.x = Math.max(0, Math.min(100, ((ev.clientX - box.left) / box.width) * 100));
      m.y = Math.max(0, Math.min(100, ((ev.clientY - box.top) / box.height) * 100));
      el.style.left = m.x + '%';
      el.style.top = m.y + '%';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); m.x = +m.x.toFixed(2); m.y = +m.y.toFixed(2); saveLayout(); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  draw();
  const offs = [on('state', ({ entity_id }) => { if (!editing && tab.markers.some((m) => m.entity === entity_id)) draw(); }), on('snapshot', draw)];
  return () => offs.forEach((o) => o());
}
