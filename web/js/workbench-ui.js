// Werkbank-Oberfläche: Bauteil erkennen, Timer, Messreihen, 3D-Druck + Gehäuse, Datenblätter + KiCad,
// Filament-Lager, Release-Center, Kopfs Bewegungs-Editor.
import { S, h, icon, api, toast, modal, ago, friendly, sparkline, emit } from './core.js';
import { pickEntity, pickMeshNode } from './editor.js';
import { nodeName } from './tiles.js';
import { parseStl, viewer, enclosure, stlBinary, trisToPos, bounds } from './stl.js';

const sub = (t) => h('div', { class: 'hud-h', style: { padding: '14px 0 6px', border: 0 } }, t);
const hudBtn = (ic, label, onclick, extra = {}) => h('button', { class: 'hud-btn', onclick, ...extra }, icon(ic), label);

async function upload(file, name) {
  const r = await fetch('/api/upload?name=' + encodeURIComponent(name || file.name || ''), { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.url;
}

// ---------- Bauteil erkennen ----------
export function identifyDialog(p, save, redraw) {
  const result = h('div', {}, h('div', { class: 'tile-sub' }, 'Foto aufnehmen/wählen oder das Teil vor Kopfs Kamera halten.'));
  const show = (part) => {
    result.replaceChildren(
      part.image ? h('img', { src: part.image, style: { maxWidth: '100%', maxHeight: '200px', borderRadius: '10px', marginBottom: '8px' } }) : null,
      h('h3', { style: { margin: '4px 0' } }, part.name || 'Unbekannt'),
      h('div', { class: 'tile-sub' }, [part.category, part.marking && `Aufdruck: ${part.marking}`, part.confidence != null && `Sicherheit ${Math.round(part.confidence * 100)} %`].filter(Boolean).join(' · ')),
      h('p', {}, part.description || ''),
      part.specs && Object.keys(part.specs).length ? h('div', { class: 'list' }, Object.entries(part.specs).map(([k, v]) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, k), h('span', { class: 'val' }, String(v))))) : null,
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } },
        p ? h('button', { class: 'btn primary', onclick: () => { p.parts.push({ id: Math.random().toString(36).slice(2, 9), name: part.name, qty: 1, have: true, note: part.marking }); save(); redraw?.(); toast('Zur Stückliste'); } }, icon('playlist-plus'), 'Zur Stückliste') : null,
        part.datasheet ? h('a', { class: 'btn', target: '_blank', href: 'https://www.google.com/search?q=' + encodeURIComponent(part.datasheet + ' datasheet pdf') }, icon('file-document-outline'), 'Datenblatt suchen') : null,
        S.settings.inventreeUrl ? h('a', { class: 'btn', target: '_blank', href: S.settings.inventreeUrl.replace(/\/$/, '') + '/platform/part/?search=' + encodeURIComponent(part.name) }, icon('package-variant-closed'), 'Im Lager') : null));
  };
  const run = async (fn) => {
    result.replaceChildren(h('div', { class: 'empty' }, 'Erkenne …'));
    try { show(await fn()); } catch (e) { result.replaceChildren(h('div', { class: 'empty' }, e.message)); }
  };
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' }, onchange: (e) => {
    const f = e.target.files[0];
    if (!f) return;
    run(async () => {
      const r = await fetch('/api/workbench/identify', { method: 'POST', headers: { 'content-type': f.type || 'image/jpeg' }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      return { ...j, image: URL.createObjectURL(f) };
    });
  } });
  modal([icon('magnify-scan'), 'Bauteil erkennen'], result, {
    actions: () => [file,
      S.settings.kopfVisionUrl ? h('button', { class: 'btn', onclick: () => run(() => api('/workbench/identify?kopf=1', { body: {} })) }, icon('robot-outline'), 'Kopf-Kamera') : null,
      h('button', { class: 'btn primary', onclick: () => file.click() }, icon('camera'), 'Foto')],
  });
}

// ---------- Timer (HUD-Kopfzeile) ----------
export function timerWidget() {
  const box = h('div', { class: 'hud-timers' });
  let timers = [];
  const draw = () => {
    box.replaceChildren(...timers.map((t) => {
      const left = Math.max(0, t.due - Date.now());
      const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
      return h('span', { class: 'hud-stat ok', title: t.text }, h('i'), `${t.text.slice(0, 14)} ${mm}:${String(ss).padStart(2, '0')}`,
        h('button', { class: 'x', onclick: async () => { await api('/workbench/timer/' + t.id, { method: 'DELETE' }); load(); } }, '×'));
    }), h('button', { class: 'hud-btn icon', title: 'Timer stellen', onclick: newTimer }, icon('timer-outline')));
  };
  const load = () => api('/workbench').then((w) => { timers = w.timers; draw(); }).catch(() => {});
  const newTimer = () => {
    const min = h('input', { class: 'input', type: 'number', value: 15, style: { flex: '0 0 90px' } });
    const text = h('input', { class: 'input', placeholder: 'Wofür? (z. B. Kleber trocken)' });
    modal([icon('timer-outline'), 'Timer'], h('div', { class: 'row' }, min, text), {
      actions: (c) => [5, 15, 30, 60].map((m) => h('button', { class: 'btn', onclick: () => (min.value = m) }, m + ' min')).concat(
        h('button', { class: 'btn primary', onclick: async () => { await api('/workbench/timer', { body: { minutes: Number(min.value), text: text.value || 'Timer abgelaufen' } }); c(); load(); } }, 'Starten')),
    });
  };
  load();
  const iv = setInterval(() => (box.isConnected ? (timers.some((t) => t.due < Date.now() - 2000) ? load() : draw()) : clearInterval(iv)), 1000);
  return box;
}

// ---------- Messreihen ----------
const KINDS = [['', 'Wert'], ['V', 'Spannung (V)'], ['mA', 'Strom (mA)'], ['A', 'Strom (A)'], ['W', 'Leistung (W)'], ['°C', 'Temperatur (°C)']];
export function measureTab(p, add) {
  const box = h('div', {}, h('div', { class: 'ai-empty' }, 'Lade …'));
  add(box, sub('Neue Messung'), newMeasureForm(p, () => load()));
  const load = async () => {
    const list = (await api('/measure?project=' + p.id)).reverse();
    if (!list.length) return box.replaceChildren(h('div', { class: 'ai-empty' }, 'Noch keine Messungen. Quelle wählen (HA-Sensor, Mesh-Node, Modbus- oder SCPI-Gerät) und starten – z. B. um den Stromverbrauch eines Nodes zu messen.'));
    box.replaceChildren(...list.map((s) => sessionCard(s, load)));
  };
  load();
}

function sessionCard(s, reload) {
  const body = h('div', {}, h('div', { class: 'gh-meta' }, '…'));
  const card = h('div', { class: 'esp-dev' },
    h('div', { class: 'task' }, h('span', { class: 'dot-live', style: { background: s.end ? '#8193a8' : '#3ddc97' } }), h('span', { class: 't' }, s.name, h('span', { class: 'gh-meta' }, ` · ${new Date(s.start).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · alle ${s.interval} s`)),
      !s.end ? hudBtn('stop', 'Stopp', async () => { await api(`/measure/${s.id}/stop`, { body: {} }); reload(); }) : null,
      h('button', { class: 'x', onclick: async () => { if (confirm('Messung löschen?')) { await api('/measure/' + s.id, { method: 'DELETE' }); reload(); } } }, '×')),
    body);
  api('/measure/' + s.id).then((d) => {
    body.replaceChildren(...Object.entries(d.series).map(([key, pts]) => {
      const st = d.stats[key];
      const src = s.sources.find((x, i) => (x.label || `${x.type}${i}`) === key) || {};
      const unit = src.unit || '';
      const mAh = unit === 'mA' ? st.integral : unit === 'A' ? st.integral * 1000 : null;
      const avg_mA = unit === 'mA' ? st.avg : unit === 'A' ? st.avg * 1000 : null;
      const runtime = avg_mA && s.battery_mAh ? s.battery_mAh / avg_mA : null;
      return h('div', { class: 'measure' }, h('div', { class: 'gh-meta' }, `${key}${unit ? ' (' + unit + ')' : ''} · ${st.n} Werte · ${st.hours.toFixed(2)} h`),
        sparkline(pts, { height: 60, color: '#00d8ff' }),
        h('div', { class: 'readouts' },
          rd('Aktuell', fmt(st.last, unit)), rd('Mittel', fmt(st.avg, unit)), rd('Min / Max', `${fmt(st.min, '')} / ${fmt(st.max, unit)}`),
          mAh != null ? rd('Verbraucht', `${mAh.toFixed(1)} mAh`) : unit === 'W' ? rd('Energie', `${st.integral.toFixed(2)} Wh`) : null,
          runtime ? rd(`Laufzeit (${s.battery_mAh} mAh)`, runtime > 48 ? `${(runtime / 24).toFixed(1)} Tage` : `${runtime.toFixed(1)} h`) : null));
    }), d.session.lastError ? h('div', { class: 'gh-meta', style: { color: '#ff5d6c' } }, 'Letzter Fehler: ' + d.session.lastError) : null,
    !Object.keys(d.series).length ? h('div', { class: 'gh-meta' }, d.running ? 'Warte auf erste Werte …' : 'Keine Werte') : null);
  });
  return card;
}
const rd = (k, v) => h('div', { class: 'readout' }, h('div', { class: 'k' }, k), h('div', { class: 'v', style: { fontSize: '16px' } }, v));
const fmt = (v, unit) => (typeof v === 'number' ? `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) >= 10 ? 1 : 3)}${unit ? ' ' + unit : ''}` : '–');

function newMeasureForm(p, onStart) {
  const sources = [];
  const list = h('div', {});
  const name = h('input', { class: 'hud-input', placeholder: 'Name, z. B. Ruhestrom Garten-Node' });
  const interval = h('input', { class: 'hud-input', type: 'number', value: 5, style: { width: '80px' }, title: 'Sekunden' });
  const battery = h('input', { class: 'hud-input', type: 'number', placeholder: 'Akku mAh (optional)', style: { width: '160px' } });
  const draw = () => list.replaceChildren(...sources.map((s, i) => h('div', { class: 'task' }, icon({ ha: 'home-assistant', mesh: 'radio-tower', modbus: 'lan', scpi: 'sine-wave' }[s.type]),
    h('span', { class: 't' }, `${s.label} – ${s.desc}`),
    h('select', { class: 'hud-input', style: { width: 'auto' }, onchange: (e) => (s.unit = e.target.value) }, KINDS.map(([v, l]) => h('option', { value: v, selected: s.unit === v }, l))),
    h('button', { class: 'x', onclick: () => { sources.splice(i, 1); draw(); } }, '×'))));
  const addSrc = async (type) => {
    if (type === 'ha') {
      const ids = await pickEntity({ multiple: true, domains: ['sensor', 'number', 'input_number'] });
      ids?.forEach((id) => { const st = S.states.get(id); sources.push({ type, entity: id, label: friendly(st, id).slice(0, 24), desc: id, unit: st?.attributes?.unit_of_measurement || '' }); });
    } else if (type === 'mesh') {
      const node = await pickMeshNode();
      if (!node) return;
      const metric = prompt('Messwert: battery, voltage, temperature, humidity, current, chUtil', 'voltage');
      if (metric) sources.push({ type, node, metric, label: `${nodeName(S.mesh.nodes.get(node))} ${metric}`.slice(0, 24), desc: node, unit: metric === 'voltage' ? 'V' : metric === 'current' ? 'mA' : '' });
    } else {
      return deviceSourceDialog(type, (src) => { sources.push(src); draw(); });
    }
    draw();
  };
  return h('div', { class: 'measure-new' }, list,
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '6px 0' } },
      hudBtn('home-assistant', 'HA-Sensor', () => addSrc('ha')), hudBtn('radio-tower', 'Mesh-Node', () => addSrc('mesh')),
      hudBtn('lan', 'Modbus', () => addSrc('modbus')), hudBtn('sine-wave', 'SCPI', () => addSrc('scpi'))),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, name, interval, battery,
      hudBtn('record-circle-outline', 'Start', async () => {
        if (!sources.length) return toast('Erst eine Quelle hinzufügen', true);
        try {
          await api('/measure', { body: { project: p.id, name: name.value || 'Messung', sources, interval: Number(interval.value) || 5, battery_mAh: Number(battery.value) || null } });
          sources.length = 0; draw(); name.value = ''; onStart();
        } catch (e) { toast(e.message, true); }
      })));
}

function deviceSourceDialog(type, done) {
  const f = type === 'modbus'
    ? { label: 'Netzteil Strom', host: '', port: 502, unit: 1, fn: 3, address: 0, dtype: 'u16', scale: 1, wordSwap: false, unitOfMeasure: 'mA' }
    : { label: 'Multimeter', host: '', port: 5025, command: 'MEAS:CURR?', unitOfMeasure: 'A' };
  const inp = (k, ph, w) => h('label', { class: 'field', style: w ? { flex: `0 0 ${w}` } : null }, h('span', {}, ph),
    h('input', { class: 'input', value: f[k], oninput: (e) => (f[k] = e.target.value) }));
  const testOut = h('div', { class: 'tile-sub' });
  const src = () => ({ type, ...f, port: Number(f.port), unit: Number(f.unit), fn: Number(f.fn), address: Number(f.address), scale: Number(f.scale), wordSwap: f.wordSwap === true || f.wordSwap === 'true' });
  modal([icon(type === 'modbus' ? 'lan' : 'sine-wave'), type === 'modbus' ? 'Modbus-TCP-Quelle' : 'SCPI-Gerät'], h('div', {},
    h('div', { class: 'row' }, inp('label', 'Bezeichnung'), inp('host', 'IP-Adresse'), inp('port', 'Port', '90px')),
    type === 'modbus'
      ? h('div', {}, h('div', { class: 'row' }, inp('unit', 'Unit-ID', '80px'), inp('address', 'Register (ab 0)', '120px'),
          h('label', { class: 'field' }, h('span', {}, 'Funktion'), h('select', { class: 'input', onchange: (e) => (f.fn = e.target.value) }, [[3, 'Holding (3)'], [4, 'Input (4)'], [1, 'Spule (1)'], [2, 'Eingang (2)']].map(([v, l]) => h('option', { value: v }, l)))),
          h('label', { class: 'field' }, h('span', {}, 'Typ'), h('select', { class: 'input', onchange: (e) => (f.dtype = e.target.value) }, ['u16', 'i16', 'u32', 'i32', 'f32'].map((v) => h('option', { value: v }, v))))),
        h('div', { class: 'row' }, inp('scale', 'Faktor (z. B. 0.01)', '160px'), h('label', { class: 'chip', style: { alignSelf: 'center', flex: '0 0 auto' } }, h('input', { type: 'checkbox', onchange: (e) => (f.wordSwap = e.target.checked) }), ' Wörter tauschen')),
        h('div', { class: 'hint', style: { fontSize: '12px', color: 'var(--muted)' } }, 'Riden RD60xx: Register 10 = Spannung ×0,01, 11 = Strom ×0,001 (über Modbus-TCP-Bridge). S7-1200/1500: MB_SERVER-Baustein, LOGO! 8: Modbus-Server einschalten.'))
      : h('div', {}, inp('command', 'Befehl'), h('div', { class: 'hint', style: { fontSize: '12px', color: 'var(--muted)' } }, 'Übliche Befehle: MEAS:VOLT?  MEAS:CURR?  MEAS:POW?  (Rigol, Siglent, Keysight …)')),
    h('label', { class: 'field' }, h('span', {}, 'Einheit'), h('select', { class: 'input', onchange: (e) => (f.unitOfMeasure = e.target.value) }, KINDS.map(([v, l]) => h('option', { value: v, selected: f.unitOfMeasure === v }, l)))),
    testOut), {
    actions: (c) => [
      h('button', { class: 'btn', onclick: async () => { testOut.textContent = 'Lese …'; try { testOut.textContent = 'Wert: ' + (await api('/fieldbus/read', { body: src() })).value; } catch (e) { testOut.textContent = e.message; } } }, icon('play'), 'Testen'),
      h('button', { class: 'btn primary', onclick: () => { const s = src(); done({ ...s, unit: f.unitOfMeasure, modbusUnit: s.unit, desc: `${f.host}`, label: f.label }); c(); } }, 'Übernehmen')],
  });
}

// ---------- 3D-Druck ----------
export function printTab(p, add, save, redraw) {
  p.prints ||= [];
  const list = h('div', {});
  const file = h('input', { type: 'file', accept: '.stl,.3mf,.gcode,.step,.stp', multiple: true, style: { display: 'none' }, onchange: async (e) => {
    for (const f of e.target.files) {
      try { p.prints.push({ id: Math.random().toString(36).slice(2, 9), name: f.name, url: await upload(f), size: f.size, status: 'offen', count: 1, done: 0, added: Date.now() }); } catch (er) { toast(er.message, true); }
    }
    save(); redraw();
  } });
  const STATUS = ['offen', 'druckt', 'fertig', 'Fehldruck'];
  list.append(...(p.prints.length ? p.prints.map((x, i) => h('div', { class: 'task' + (x.status === 'fertig' ? ' done' : '') },
    icon(/\.gcode$/i.test(x.name) ? 'printer-3d' : 'cube-outline'),
    h('span', { class: 't' }, x.name, h('span', { class: 'gh-meta' }, ` · ${x.done || 0}/${x.count || 1} Stück`)),
    h('select', { class: 'hud-input', style: { width: 'auto' }, onchange: (e) => { x.status = e.target.value; if (x.status === 'fertig') x.done = x.count; save(); redraw(); } }, STATUS.map((st) => h('option', { selected: x.status === st }, st))),
    /\.stl$/i.test(x.name) ? h('button', { class: 'hud-btn icon', title: 'Ansehen', onclick: () => stlPreview(x.url, x.name) }, icon('rotate-3d-variant')) : null,
    /\.gcode$/i.test(x.name) ? h('button', { class: 'hud-btn icon', title: 'An Drucker senden', onclick: () => sendToPrinter(x, save, redraw) }, icon('send')) : null,
    h('a', { class: 'hud-btn icon', href: x.url, download: x.name, title: 'Herunterladen' }, icon('download')),
    h('button', { class: 'x', onclick: () => { p.prints.splice(i, 1); save(); redraw(); } }, '×')))
    : [h('div', { class: 'ai-empty' }, 'Noch keine Dateien. STL/3MF zum Ansehen und Verwalten, G-Code kann direkt an einen Klipper-Drucker gehen.')]));
  add(list, h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
    hudBtn('upload', 'Dateien', () => file.click()), file,
    hudBtn('package-variant', 'Gehäuse erzeugen', () => enclosureDialog(p, save, redraw)),
    hudBtn('printer-3d-nozzle-outline', 'Filament', filamentDialog)));
}

async function stlPreview(url, name) {
  const canvas = h('canvas', { class: 'stl-canvas' });
  const info = h('div', { class: 'tile-sub' }, 'Lade …');
  let stop = () => {};
  modal([icon('rotate-3d-variant'), name], h('div', {}, canvas, info), { wide: true, onClose: () => stop() });
  const buf = await (await fetch(url)).arrayBuffer();
  const pos = parseStl(buf);
  const b = bounds(pos);
  info.textContent = `${(pos.length / 9).toLocaleString('de-DE')} Dreiecke · ${b.size.map((x) => x.toFixed(1)).join(' × ')} mm · ziehen = drehen, Mausrad = zoomen`;
  stop = viewer(canvas, pos);
}

async function sendToPrinter(x, save, redraw) {
  const printers = await api('/printers');
  if (!printers.length) return toast('Erst eine 3D-Drucker-Kachel mit Moonraker-Adresse anlegen', true);
  const sel = h('select', { class: 'input' }, printers.map((pr) => h('option', { value: pr.id }, pr.title)));
  const start = h('input', { type: 'checkbox', checked: true });
  modal([icon('printer-3d'), 'An Drucker senden'], h('div', {}, sel, h('label', { class: 'row', style: { marginTop: '10px', alignItems: 'center', gap: '8px' } }, start, 'Druck sofort starten')), {
    actions: (c) => [h('button', { class: 'btn primary', onclick: async () => {
      try { await api(`/printer/${sel.value}/print`, { body: { file: x.url, start: start.checked } }); x.status = start.checked ? 'druckt' : x.status; save(); redraw(); toast('Gesendet'); c(); } catch (e) { toast(e.message, true); }
    } }, icon('send'), 'Senden')],
  });
}

function enclosureDialog(p, save, redraw) {
  const o = { l: 60, w: 40, h: 25, wall: 2, floor: 2, sh: 5, sd: 6, shole: 2.5, sins: 3.5, side: '', hw: 12, hh: 7, hpos: 30, hz: 6, lip: 3, tol: 0.3 };
  const canvas = h('canvas', { class: 'stl-canvas', style: { height: '320px' } });
  let stop = () => {};
  const num = (k, label, w = '86px') => h('label', { class: 'field', style: { flex: `0 0 ${w}` } }, h('span', {}, label), h('input', { class: 'input', type: 'number', step: 'any', value: o[k], oninput: (e) => { o[k] = Number(e.target.value); render(); } }));
  let parts;
  const render = () => {
    parts = enclosure({ l: o.l, w: o.w, h: o.h, wall: o.wall, floor: o.floor, standoff: o.sh > 0 ? { h: o.sh, d: o.sd, hole: o.shole, inset: o.sins } : null, hole: o.side ? { side: o.side, w: o.hw, h: o.hh, pos: o.hpos, z: o.hz } : null, lip: o.lip, tol: o.tol });
    stop();
    stop = viewer(canvas, trisToPos([...parts.base, ...parts.lid]), [0.24, 0.86, 0.6]);
  };
  const dl = (tris, name) => { const a = h('a', { href: URL.createObjectURL(new Blob([stlBinary(tris)], { type: 'model/stl' })), download: name }); a.click(); };
  modal([icon('package-variant'), 'Gehäuse-Generator'], h('div', {}, canvas,
    h('div', { class: 'tile-sub', style: { margin: '6px 0' } }, 'Innenmaße in mm (Platine + Luft). Abstandshalter mit Loch für M2,5/M3-Schrauben. Aussparung z. B. für USB.'),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, num('l', 'Länge'), num('w', 'Breite'), num('h', 'Höhe'), num('wall', 'Wand'), num('floor', 'Boden')),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, num('sh', 'Abstandsh. Höhe', '120px'), num('sd', 'Ø außen'), num('shole', 'Ø Loch'), num('sins', 'Abstand Ecke', '110px')),
    h('div', { class: 'row', style: { flexWrap: 'wrap', alignItems: 'flex-end' } },
      h('label', { class: 'field', style: { flex: '0 0 130px' } }, h('span', {}, 'Aussparung'), h('select', { class: 'input', onchange: (e) => { o.side = e.target.value; render(); } },
        [['', 'keine'], ['front', 'vorne'], ['back', 'hinten'], ['left', 'links'], ['right', 'rechts']].map(([v, l]) => h('option', { value: v }, l)))),
      num('hw', 'Breite'), num('hh', 'Höhe'), num('hpos', 'Mitte bei'), num('hz', 'über Boden', '96px'))), {
    wide: true,
    onClose: () => stop(),
    actions: (c) => [
      h('button', { class: 'btn', onclick: () => dl(parts.base, `gehaeuse-${o.l}x${o.w}x${o.h}.stl`) }, icon('download'), 'Unterteil'),
      h('button', { class: 'btn', onclick: () => dl(parts.lid, `deckel-${o.l}x${o.w}.stl`) }, icon('download'), 'Deckel'),
      p ? h('button', { class: 'btn primary', onclick: async () => {
        for (const [tris, name] of [[parts.base, `gehaeuse-${o.l}x${o.w}x${o.h}.stl`], [parts.lid, `deckel-${o.l}x${o.w}.stl`]]) {
          const url = await upload(new Blob([stlBinary(tris)], { type: 'model/stl' }), name);
          p.prints.push({ id: Math.random().toString(36).slice(2, 9), name, url, status: 'offen', count: 1, done: 0, added: Date.now() });
        }
        save(); redraw(); c(); toast('Zum Projekt hinzugefügt');
      } }, icon('playlist-plus'), 'Ins Projekt') : null],
  });
  setTimeout(render, 30);
}

// ---------- Filament-Lager ----------
export async function filamentDialog() {
  const wb = await api('/workbench');
  const list = wb.filament;
  const box = h('div', {});
  const draw = () => box.replaceChildren(...list.map((f, i) => {
    const st = f.scale ? S.states.get(f.scale) : null;
    const scaleG = st ? Number(st.state) - Number(f.spoolG || 0) : null;
    const rest = scaleG != null && Number.isFinite(scaleG) ? Math.max(0, scaleG) : Number(f.restG);
    const pct = f.fullG ? Math.round((rest / f.fullG) * 100) : null;
    return h('div', { class: 'list-item', style: { flexWrap: 'wrap' } },
      h('input', { type: 'color', value: f.color || '#888888', style: { width: '30px', height: '26px', border: 0, background: 'none' }, oninput: (e) => (f.color = e.target.value) }),
      h('input', { class: 'input', value: f.material || '', placeholder: 'PLA', style: { flex: '0 0 80px' }, oninput: (e) => (f.material = e.target.value) }),
      h('input', { class: 'input', value: f.name || '', placeholder: 'Hersteller / Farbe', style: { flex: 1, minWidth: '120px' }, oninput: (e) => (f.name = e.target.value) }),
      h('input', { class: 'input', type: 'number', value: f.restG ?? '', placeholder: 'Rest g', style: { flex: '0 0 80px' }, title: 'Rest in g (ohne Waage)', oninput: (e) => (f.restG = Number(e.target.value)) }),
      h('button', { class: 'btn sm', title: 'Waage (HA-Sensor in g) zuordnen', onclick: async () => { const id = await pickEntity({ domains: ['sensor'] }); if (id) { f.scale = id; f.spoolG = Number(prompt('Gewicht der leeren Spule in g', f.spoolG || 200)) || 0; draw(); } } }, icon('scale'), st ? `${Math.round(rest)} g` : ''),
      pct != null ? h('span', { class: 'val', style: { color: pct < 15 ? 'var(--bad)' : 'var(--muted)' } }, pct + ' %') : null,
      h('button', { class: 'btn icon sm danger', onclick: () => { list.splice(i, 1); draw(); } }, icon('delete-outline')));
  }), list.length ? null : h('div', { class: 'empty' }, 'Noch keine Spulen.'));
  draw();
  modal([icon('printer-3d-nozzle-outline'), 'Filament-Lager'], box, {
    actions: (c) => [
      h('button', { class: 'btn', onclick: () => { list.push({ material: 'PLA', name: '', color: '#00d8ff', fullG: 1000, restG: 1000 }); draw(); } }, icon('plus'), 'Spule'),
      h('button', { class: 'btn primary', onclick: async () => { await api('/workbench/filament', { method: 'PUT', body: { filament: list } }); toast('Gespeichert'); c(); } }, 'Speichern')],
  });
}

// ---------- Datenblätter + KiCad ----------
export function docsTab(p, add, save, redraw, chatState) {
  p.docs ||= [];
  const file = h('input', { type: 'file', accept: 'application/pdf', multiple: true, style: { display: 'none' }, onchange: async (e) => {
    for (const f of e.target.files) {
      if (f.size > 30e6) { toast(`${f.name}: zu groß (max. 30 MB)`, true); continue; }
      try { p.docs.push({ name: f.name, url: await upload(f), size: f.size }); } catch (er) { toast(er.message, true); }
    }
    save(); redraw();
  } });
  add(p.docs.length ? p.docs.map((d, i) => h('div', { class: 'task' }, icon('file-pdf-box'),
    h('a', { class: 't', href: d.url, target: '_blank', style: { color: 'inherit' } }, d.name), h('span', { class: 'gh-meta' }, `${Math.round((d.size || 0) / 1024)} kB`),
    h('button', { class: 'x', onclick: () => { p.docs.splice(i, 1); save(); redraw(); } }, '×')))
    : h('div', { class: 'ai-empty' }, 'Datenblätter als PDF hochladen. Mit „Datenblätter einbeziehen“ in der KI-Konsole liest Claude sie mit, z. B. „Welchen Pull-up braucht der Sensor?“'),
  h('div', { style: { display: 'flex', gap: '6px', margin: '8px 0', flexWrap: 'wrap' } }, hudBtn('upload', 'PDF hochladen', () => file.click()), file,
    h('label', { class: 'hud-btn' + (chatState.includeDocs ? ' on' : '') }, h('input', { type: 'checkbox', checked: chatState.includeDocs, style: { margin: 0 }, onchange: (e) => { chatState.includeDocs = e.target.checked; redraw(); } }), 'In der KI-Konsole einbeziehen')));
  if (p.repo) {
    const out = h('div', {});
    add(sub('KiCad-Stückliste aus ' + p.repo), out, hudBtn('chip', 'Aus Schaltplan lesen', async () => {
      out.replaceChildren(h('div', { class: 'gh-meta' }, 'Lese Schaltpläne …'));
      try {
        const bom = await api(`/github/kicad/${p.repo}`);
        const have = new Set(p.parts.map((x) => x.name.toLowerCase()));
        out.replaceChildren(h('div', { class: 'gh-meta' }, `${bom.files.length} Schaltplan-Datei(en), ${bom.parts.length} Positionen`),
          ...bom.parts.map((x) => h('div', { class: 'task' }, h('span', { class: 't' }, `${x.qty}× ${x.value}`, h('span', { class: 'gh-meta' }, ` · ${x.footprint || x.lib} · ${x.refs.join(', ')}`)))),
          hudBtn('playlist-plus', 'In die Stückliste übernehmen', () => {
            let n = 0;
            for (const x of bom.parts) {
              const name = `${x.value} (${x.footprint || x.lib.split(':').pop()})`;
              if (have.has(name.toLowerCase())) continue;
              p.parts.push({ id: Math.random().toString(36).slice(2, 9), name, qty: x.qty, have: false, note: x.refs.join(', ') });
              n++;
            }
            save(); redraw(); toast(`${n} Positionen übernommen`);
          }));
      } catch (e) { out.replaceChildren(h('div', { class: 'ai-empty' }, e.message)); }
    }));
  }
}

// ---------- Release-Center ----------
export function releasesPanel() {
  const body = h('div', { class: 'hud-body' }, h('div', { class: 'ai-empty' }, 'Lade Releases …'));
  api('/github/releases').then((rels) => {
    if (!rels.length) return body.replaceChildren(h('div', { class: 'ai-empty' }, 'Noch keine Releases in deinen Repos. Tipp: eine GitHub Action, die bei einem Tag die APK baut und anhängt.'));
    body.replaceChildren(...rels.map((r) => h('div', { class: 'proj', style: { cursor: 'default' } },
      h('div', { class: 'nm', style: { fontSize: '14px' } }, r.repo.split('/')[1], ' ', h('span', { class: 'gh-meta' }, r.tag + (r.prerelease ? ' · Vorabversion' : ''))),
      h('div', { class: 'st' }, h('span', {}, r.name), h('span', {}, ago(Date.parse(r.date)))),
      ...r.assets.map((a) => h('a', { class: 'task', href: a.url, style: { color: 'inherit', textDecoration: 'none', padding: '5px 2px' } },
        icon(/\.apk$/i.test(a.name) ? 'android' : /\.bin$/i.test(a.name) ? 'chip' : 'download'), h('span', { class: 't', style: { fontSize: '12px' } }, a.name), h('span', { class: 'gh-meta' }, `${(a.size / 1048576).toFixed(1)} MB`))),
      r.assets.length ? null : h('a', { class: 'gh-meta', href: r.url, target: '_blank' }, 'auf GitHub ansehen'))));
  }).catch((e) => body.replaceChildren(h('div', { class: 'ai-empty' }, e.message)));
  return body;
}

// ---------- Kopfs Bewegungs-Editor ----------
export async function bodyEditor() {
  let data;
  try { data = await api('/kopf/body'); } catch (e) { return toast(e.message, true); }
  const parts = data.parts || {};
  const cur = { ...data.state };
  let poses = data.poses, sequences = data.sequences;
  const live = h('img', { class: 'kopf-live', src: '/api/kopf/live', alt: '', onerror: (e) => { e.target.src = '/api/kopf/snapshot?debug=1&t=' + Date.now(); } });
  let sendT;
  const send = () => { clearTimeout(sendT); sendT = setTimeout(() => api('/kopf/body/pose', { body: { parts: cur } }).catch((e) => toast(e.message, true)), 60); };
  const LBL = { neck_yaw: 'Hals drehen', neck_pitch: 'Hals neigen', eye_yaw: 'Augen links/rechts', eye_pitch: 'Augen hoch/runter', eyelid_left: 'Lid links', eyelid_right: 'Lid rechts' };
  const sliders = h('div', { class: 'body-sliders' });
  const drawSliders = () => sliders.replaceChildren(...Object.entries(parts).map(([k, c]) => h('label', { class: 'field' },
    h('span', {}, `${LBL[k] || k}: `, h('b', {}, `${Math.round(cur[k] ?? c.neutral)} ${c.unit === 'percent' ? '%' : '°'}`)),
    h('input', { type: 'range', class: 'slider', min: c.min, max: c.max, step: 1, value: cur[k] ?? c.neutral, oninput: (e) => { cur[k] = Number(e.target.value); e.target.previousSibling.lastChild.textContent = `${cur[k]} ${c.unit === 'percent' ? '%' : '°'}`; send(); } }))));
  drawSliders();
  const posesBox = h('div', { class: 'tagline' });
  const drawPoses = () => posesBox.replaceChildren(...Object.keys(poses).map((n) => h('span', { class: 'tag' },
    h('button', { type: 'button', style: { color: 'inherit' }, onclick: () => { Object.assign(cur, poses[n]); drawSliders(); send(); } }, n),
    h('button', { type: 'button', onclick: () => { if (confirm(`Pose „${n}“ löschen?`)) { delete poses[n]; persist(); drawPoses(); } } }, '×'))),
  h('button', { class: 'btn sm', onclick: () => { const n = prompt('Name der Pose'); if (n) { poses[n] = { ...cur }; persist(); drawPoses(); drawSeq(); } } }, icon('content-save'), 'Aktuelle Pose speichern'));
  const persist = () => api('/kopf/poses', { method: 'PUT', body: { poses, sequences } }).catch((e) => toast(e.message, true));
  // Abläufe: Liste von Schlüsselbildern (Zeit in ms + Pose oder einzelne Werte)
  const seqBox = h('div', {});
  let seqName = Object.keys(sequences)[0] || '';
  const drawSeq = () => {
    const frames = sequences[seqName] || [];
    seqBox.replaceChildren(
      h('div', { class: 'row', style: { alignItems: 'center', flexWrap: 'wrap' } },
        h('select', { class: 'input', style: { flex: '0 0 170px' }, onchange: (e) => { seqName = e.target.value; drawSeq(); } }, Object.keys(sequences).map((n) => h('option', { selected: n === seqName }, n))),
        h('button', { class: 'btn sm primary', onclick: () => api('/kopf/body/play', { body: { name: seqName } }).catch((e) => toast(e.message, true)) }, icon('play'), 'Abspielen'),
        h('button', { class: 'btn sm', onclick: () => { const n = prompt('Name des Ablaufs'); if (n) { sequences[n] = [{ t: 0, pose: 'Neutral' }]; seqName = n; persist(); drawSeq(); } } }, icon('plus'), 'Neu'),
        h('button', { class: 'btn sm danger', onclick: () => { if (seqName && confirm(`Ablauf „${seqName}“ löschen?`)) { delete sequences[seqName]; seqName = Object.keys(sequences)[0] || ''; persist(); drawSeq(); } } }, icon('delete-outline'))),
      h('div', { class: 'timeline' }, frames.map((f, i) => h('div', { class: 'tl-frame' },
        h('input', { class: 'input', type: 'number', value: f.t, step: 50, title: 'Zeit (ms)', style: { width: '80px' }, onchange: (e) => { f.t = Number(e.target.value); frames.sort((a, b) => a.t - b.t); persist(); drawSeq(); } }),
        h('span', { class: 'tile-sub' }, f.pose ? `Pose ${f.pose}` : Object.entries(f.set || {}).map(([k, v]) => `${LBL[k] || k} ${v}`).join(', ')),
        h('button', { class: 'btn icon sm', title: 'Entfernen', onclick: () => { frames.splice(i, 1); persist(); drawSeq(); } }, icon('close'))))),
      seqName ? h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        h('button', { class: 'btn sm', onclick: () => { const t = (frames.at(-1)?.t || 0) + 500; frames.push({ t, set: { ...cur } }); persist(); drawSeq(); } }, icon('plus'), 'Aktuelle Stellung +500 ms'),
        h('select', { class: 'input', style: { flex: '0 0 160px' }, onchange: (e) => { if (!e.target.value) return; frames.push({ t: (frames.at(-1)?.t || 0) + 500, pose: e.target.value }); persist(); drawSeq(); } }, h('option', { value: '' }, '+ Pose …'), Object.keys(poses).map((n) => h('option', { value: n }, n)))) : null,
      h('div', { class: 'tile-sub' }, 'Kopf kann Abläufe auch auf Zuruf spielen: „Kopf, nick mal“.'));
  };
  drawPoses();
  drawSeq();
  modal([icon('robot-outline'), 'Kopf bewegen'], h('div', { class: 'body-editor' },
    h('div', { class: 'body-left' }, live, h('div', { class: 'tile-sub' }, 'Live-Bild mit Erkennung (head-vision)')),
    h('div', { class: 'body-right' }, sliders,
      h('div', { class: 'row', style: { margin: '6px 0 12px' } }, h('button', { class: 'btn sm', onclick: async () => { await api('/kopf/body/reset', { body: {} }); Object.assign(cur, Object.fromEntries(Object.entries(parts).map(([k, c]) => [k, c.neutral]))); drawSliders(); } }, icon('restore'), 'Neutral')),
      h('h4', { style: { margin: '8px 0' } }, 'Posen'), posesBox, h('h4', { style: { margin: '14px 0 8px' } }, 'Abläufe'), seqBox)), {
    wide: true,
    onClose: () => { live.src = ''; },
  });
}
