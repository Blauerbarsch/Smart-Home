// Kacheltypen: Darstellung, Bedienung und Felder für den Editor.
import {
  S, h, icon, api, toast, modal, field, ent, domainOf, friendly, callService, entityIcon, stateText, isOn,
  hexToRgb, sparkline, ago,
} from './core.js';
import { WEATHER_TILES } from './weather-ui.js';

const histCache = new Map();
async function history(entityId, hours = 24) {
  const key = entityId + hours;
  const c = histCache.get(key);
  if (c && Date.now() - c.t < 5 * 60e3) return c.data;
  const data = await api(`/ha/history/${encodeURIComponent(entityId)}?hours=${hours}`).catch(() => []);
  histCache.set(key, { t: Date.now(), data });
  return data;
}

const head = (ic, name, sub, extra) =>
  h('div', { class: 'tile-head' }, h('div', { class: 'tile-icon' }, icon(ic)),
    h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'tile-name' }, name), sub !== undefined ? h('div', { class: 'tile-sub' }, sub) : null),
    extra || null);

const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };

// ---------- Entitäten ----------
function toggleService(st) {
  const d = domainOf(st.entity_id);
  if (d === 'lock') return callService('lock', st.state === 'locked' ? 'unlock' : 'lock', { entity_id: st.entity_id });
  if (d === 'cover') return callService('cover', 'toggle', { entity_id: st.entity_id });
  if (['scene', 'script'].includes(d)) return callService(d, 'turn_on', { entity_id: st.entity_id });
  if (d === 'button' || d === 'input_button') return callService(d, 'press', { entity_id: st.entity_id });
  if (d === 'media_player') return callService(d, 'media_play_pause', { entity_id: st.entity_id });
  return callService('homeassistant', 'toggle', { entity_id: st.entity_id });
}

function lightDetail(id) {
  const st = ent(id);
  if (!st) return;
  const bri = h('input', { type: 'range', class: 'slider', min: 1, max: 100, value: Math.round(((st.attributes.brightness || 0) / 255) * 100),
    onchange: (e) => callService('light', 'turn_on', { entity_id: id, brightness_pct: Number(e.target.value) }) });
  const modes = st.attributes.supported_color_modes || [];
  const color = modes.some((m) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m))
    ? field('Farbe', h('input', { type: 'color', class: 'input', style: { height: '46px', padding: '4px' },
      value: st.attributes.rgb_color ? '#' + st.attributes.rgb_color.map((c) => c.toString(16).padStart(2, '0')).join('') : '#ffffff',
      onchange: (e) => { const n = parseInt(e.target.value.slice(1), 16); callService('light', 'turn_on', { entity_id: id, rgb_color: [(n >> 16) & 255, (n >> 8) & 255, n & 255] }); } }))
    : null;
  const ct = modes.includes('color_temp')
    ? field('Farbtemperatur', h('input', { type: 'range', class: 'slider', min: st.attributes.min_color_temp_kelvin || 2000, max: st.attributes.max_color_temp_kelvin || 6500,
      value: st.attributes.color_temp_kelvin || 4000, onchange: (e) => callService('light', 'turn_on', { entity_id: id, color_temp_kelvin: Number(e.target.value) }) }))
    : null;
  modal([icon(entityIcon(st)), friendly(st)], h('div', {}, field('Helligkeit', bri), color, ct),
    { actions: (close) => [h('button', { class: 'btn', onclick: () => { callService('light', 'turn_off', { entity_id: id }); close(); } }, 'Ausschalten')] });
}

function renderEntity(tile, el) {
  const st = ent(tile.entity);
  const name = tile.title || friendly(st, tile.entity);
  if (!st) {
    el.classList.add('unavailable');
    return el.append(head('help-circle-outline', name, S.ha.status === 'connected' ? 'Entität nicht gefunden' : 'Home Assistant getrennt'));
  }
  const d = domainOf(st.entity_id);
  const a = st.attributes;
  const ic = entityIcon(st, tile.icon);
  if (st.state === 'unavailable') el.classList.add('unavailable');
  const on = isOn(st);
  if (on) el.classList.add('on');
  if (d === 'light' && a.rgb_color && on) el.style.setProperty('--tc-rgb', a.rgb_color.join(','));

  const toggleable = ['light', 'switch', 'input_boolean', 'fan', 'automation', 'lock', 'siren', 'humidifier'].includes(d);
  const runnable = ['scene', 'script', 'button', 'input_button'].includes(d);

  if (toggleable || runnable) {
    el.classList.add('clickable');
    el.addEventListener('click', () => !S.editing && toggleService(st));
  }

  switch (d) {
    case 'light': {
      const pct = on && a.brightness ? Math.round((a.brightness / 255) * 100) : null;
      el.append(head(ic, name, on ? (pct ? `${pct} %` : 'An') : 'Aus',
        h('button', { class: 'btn icon sm', title: 'Details', onclick: stop(() => lightDetail(st.entity_id)) }, icon('tune-variant'))));
      if (tile.w > 1 && a.supported_color_modes?.some((m) => m !== 'onoff')) {
        el.append(h('div', { class: 'tile-body' }, h('input', {
          type: 'range', class: 'slider', min: 0, max: 100, value: pct || 0, onclick: (e) => e.stopPropagation(),
          onpointerdown: () => (el.dataset.busy = '1'), onpointerup: () => delete el.dataset.busy,
          onchange: (e) => callService('light', 'turn_on', { entity_id: st.entity_id, brightness_pct: Number(e.target.value) }),
        })));
      }
      return;
    }
    case 'climate': {
      const target = a.temperature;
      const step = a.target_temp_step || 0.5;
      const set = (delta) => callService('climate', 'set_temperature', { entity_id: st.entity_id, temperature: Math.round((target + delta) / step) * step });
      const small = tile.h < 2;
      el.append(head(ic, name, small ? `${a.current_temperature ?? '–'} °C · ${stateText(st)}` : `${stateText(st)}${a.hvac_action ? ' · ' + a.hvac_action : ''}`),
        h('div', { class: 'tile-body' },
          small ? null : h('div', { class: 'tile-value' }, a.current_temperature ?? '–', h('small', {}, '°C')),
          target !== undefined ? h('div', { class: 'tile-row' },
            h('button', { class: 'btn sm', onclick: stop(() => set(-step)) }, icon('minus')),
            h('div', { style: { textAlign: 'center', flex: 1, fontWeight: 600 } }, `${target} °C`),
            h('button', { class: 'btn sm', onclick: stop(() => set(step)) }, icon('plus'))) : null));
      return;
    }
    case 'cover':
      el.append(head(ic, name, a.current_position !== undefined ? `${stateText(st)} · ${a.current_position} %` : stateText(st)),
        h('div', { class: 'tile-body' }, h('div', { class: 'tile-row' },
          h('button', { class: 'btn sm', onclick: stop(() => callService('cover', 'open_cover', { entity_id: st.entity_id })) }, icon('arrow-up')),
          h('button', { class: 'btn sm', onclick: stop(() => callService('cover', 'stop_cover', { entity_id: st.entity_id })) }, icon('stop')),
          h('button', { class: 'btn sm', onclick: stop(() => callService('cover', 'close_cover', { entity_id: st.entity_id })) }, icon('arrow-down')))));
      return;
    case 'media_player': {
      const svc = (s) => stop(() => callService('media_player', s, { entity_id: st.entity_id }));
      el.append(head(ic, name, a.media_title ? `${a.media_title}${a.media_artist ? ' – ' + a.media_artist : ''}` : stateText(st)),
        h('div', { class: 'tile-body' }, h('div', { class: 'tile-row' },
          h('button', { class: 'btn sm', onclick: svc('media_previous_track') }, icon('skip-previous')),
          h('button', { class: 'btn sm', onclick: svc('media_play_pause') }, icon(st.state === 'playing' ? 'pause' : 'play')),
          h('button', { class: 'btn sm', onclick: svc('media_next_track') }, icon('skip-next'))),
          tile.w > 1 && a.volume_level !== undefined ? h('input', { type: 'range', class: 'slider', min: 0, max: 100, value: Math.round(a.volume_level * 100),
            onpointerdown: () => (el.dataset.busy = '1'), onpointerup: () => delete el.dataset.busy,
            onchange: (e) => callService('media_player', 'volume_set', { entity_id: st.entity_id, volume_level: e.target.value / 100 }) }) : null));
      return;
    }
    case 'camera': {
      const img = h('img', { class: 'cam', alt: '', src: `/api/ha/camera/${encodeURIComponent(st.entity_id)}?t=${Date.now()}` });
      el.append(head(ic, name), img);
      const t = setInterval(() => (img.isConnected ? (img.src = `/api/ha/camera/${encodeURIComponent(st.entity_id)}?t=${Date.now()}`) : clearInterval(t)), (tile.refresh || 10) * 1000);
      return;
    }
    case 'input_number':
    case 'number':
      el.append(head(ic, name, stateText(st)), h('div', { class: 'tile-body' }, h('input', {
        type: 'range', class: 'slider', min: a.min, max: a.max, step: a.step || 1, value: st.state,
        onpointerdown: () => (el.dataset.busy = '1'), onpointerup: () => delete el.dataset.busy,
        onchange: (e) => callService(d, 'set_value', { entity_id: st.entity_id, value: Number(e.target.value) }),
      })));
      return;
    case 'select':
    case 'input_select':
      el.append(head(ic, name), h('div', { class: 'tile-body' }, h('select', {
        class: 'input', onchange: (e) => callService(d, 'select_option', { entity_id: st.entity_id, option: e.target.value }),
      }, (a.options || []).map((o) => h('option', { value: o, selected: o === st.state }, o)))));
      return;
    case 'weather':
      el.append(head(ic, name, st.state), h('div', { class: 'tile-body' },
        h('div', { class: 'tile-value' }, a.temperature ?? '–', h('small', {}, a.temperature_unit || '°C')),
        h('div', { class: 'tile-sub' }, [a.humidity !== undefined && `${a.humidity} % Feuchte`, a.wind_speed !== undefined && `${a.wind_speed} ${a.wind_speed_unit || ''} Wind`].filter(Boolean).join(' · '))));
      return;
    case 'person':
    case 'device_tracker':
      el.append(head(ic, name, ago(Date.parse(st.last_changed))), h('div', { class: 'tile-body' }, h('div', { class: 'tile-value', style: { fontSize: '22px' } }, stateText(st))));
      return;
  }

  if (toggleable || runnable) {
    el.append(head(ic, name, runnable ? 'Ausführen' : stateText(st),
      toggleable ? h('button', { class: 'toggle' + (on ? ' on' : ''), onclick: stop(() => toggleService(st)) }) : null));
    return;
  }

  // Sensor & Co.
  const numeric = Number.isFinite(Number(st.state)) && st.state !== '';
  const showGraph = numeric && (tile.graph ?? (tile.w > 1 || tile.h > 1));
  const val = numeric ? Math.round(Number(st.state) * 100) / 100 : stateText(st);
  el.append(head(ic, name, ago(Date.parse(st.last_changed))),
    h('div', { class: 'tile-body' }, h('div', { class: 'tile-value', style: numeric ? null : { fontSize: '22px' } }, val, numeric && a.unit_of_measurement ? h('small', {}, a.unit_of_measurement) : null)));
  if (showGraph) {
    // Bei einer Zeile Höhe liegt der Verlauf dezent hinter dem Wert, sonst darüber
    const flat = tile.h < 2;
    const box = h('div', { class: flat ? 'spark-bg' : '' });
    if (flat) el.append(box);
    else el.querySelector('.tile-body').prepend(box);
    history(st.entity_id, tile.hours || 24).then((pts) => box.replaceChildren(sparkline([...pts, [Date.now(), st.state]], { height: flat ? 40 : Math.max(30, tile.h * 50 - 70) })));
  }
}

// ---------- Mesh-Hilfen ----------
export function nodeName(n) {
  return n?.alias || n?.longName || n?.shortName || n?.id || '?';
}
export function freshColor(ts) {
  const age = Date.now() - (ts || 0);
  if (age < 2 * 3600e3) return 'var(--ok)';
  if (age < 24 * 3600e3) return 'var(--warn)';
  return 'var(--bad)';
}
const fmt = (v, unit, digits = 1) => (typeof v === 'number' ? `${v.toFixed(digits)}${unit}` : null);
export function nodeMeta(n) {
  return [
    fmt(n.battery, ' %', 0) && h('span', {}, icon('battery'), ' ', n.battery > 100 ? 'Netz' : fmt(n.battery, ' %', 0)),
    fmt(n.temperature, ' °C') && h('span', {}, icon('thermometer'), ' ', fmt(n.temperature, ' °C')),
    fmt(n.humidity, ' %', 0) && h('span', {}, icon('water-percent'), ' ', fmt(n.humidity, ' %', 0)),
    fmt(n.pressure, ' hPa', 0) && h('span', {}, icon('gauge'), ' ', fmt(n.pressure, ' hPa', 0)),
    fmt(n.snr, ' dB') && h('span', {}, 'SNR ', fmt(n.snr, ' dB')),
    n.hops !== undefined && h('span', {}, `${n.hops} Hop${n.hops === 1 ? '' : 's'}`),
  ].filter(Boolean);
}

// ---------- Kacheltypen ----------
export const TILE_TYPES = {
  entity: {
    label: 'Gerät / Sensor', icon: 'lightbulb-on-outline', desc: 'Licht, Schalter, Sensor, Klima, Rollo, Medien, Kamera …',
    defaults: { w: 1, h: 1 },
    deps: (t) => [t.entity],
    fields: [
      { key: 'entity', label: 'Entität', kind: 'entity' },
      { key: 'title', label: 'Eigener Name', kind: 'text' },
      { key: 'icon', label: 'Icon (mdi-Name, optional)', kind: 'text', hint: 'z. B. lamp, sofa, desk – Liste: pictogrammers.com/library/mdi' },
      { key: 'graph', label: 'Verlauf anzeigen', kind: 'select', options: [['', 'Automatisch'], ['true', 'Ja'], ['false', 'Nein']] },
      { key: 'hours', label: 'Verlauf (Stunden)', kind: 'number' },
      { key: 'color', label: 'Akzentfarbe', kind: 'color' },
    ],
    render: renderEntity,
  },
  entities: {
    label: 'Liste', icon: 'format-list-checks', desc: 'Mehrere Entitäten kompakt, z. B. alle Fenster eines Raums',
    defaults: { w: 2, h: 2, entities: [] },
    deps: (t) => t.entities || [],
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }, { key: 'entities', label: 'Entitäten', kind: 'entities' }],
    render(tile, el) {
      el.append(head('format-list-checks', tile.title || 'Liste'));
      const list = h('div', { class: 'list', style: { marginTop: '10px' } });
      for (const id of tile.entities || []) {
        const st = ent(id);
        const d = domainOf(id);
        const tog = st && ['light', 'switch', 'input_boolean', 'fan', 'automation'].includes(d);
        list.append(h('div', { class: 'list-item' }, icon(entityIcon(st)), h('span', { class: 'grow' }, friendly(st, id)),
          tog ? h('button', { class: 'toggle' + (isOn(st) ? ' on' : ''), onclick: stop(() => toggleService(st)) }) : h('span', { class: 'val' }, stateText(st))));
      }
      if (!tile.entities?.length) list.append(h('div', { class: 'empty' }, 'Noch keine Entitäten gewählt'));
      el.append(list);
    },
  },
  ...WEATHER_TILES,
  clock: {
    label: 'Uhr & Begrüßung', icon: 'clock-outline', desc: 'Uhrzeit, Datum und Gruß',
    defaults: { w: 2, h: 1 },
    fields: [{ key: 'name', label: 'Dein Name (optional)', kind: 'text' }],
    render(tile, el) {
      const t = h('div', { class: 'clock-time' });
      const d = h('div', { class: 'tile-sub' });
      const tick = () => {
        const now = new Date();
        t.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const hr = now.getHours();
        const greet = hr < 5 ? 'Gute Nacht' : hr < 11 ? 'Guten Morgen' : hr < 18 ? 'Hallo' : 'Guten Abend';
        d.textContent = `${greet}${tile.name ? ', ' + tile.name : ''} · ${now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}`;
      };
      tick();
      const iv = setInterval(() => (t.isConnected ? tick() : clearInterval(iv)), 10000);
      el.append(h('div', { class: 'tile-body', style: { justifyContent: 'center' } }, t, d));
    },
  },
  note: {
    label: 'Notiz', icon: 'note-text-outline', desc: 'Freier Text, Merkzettel',
    defaults: { w: 2, h: 1, title: 'Notiz', text: '' },
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }, { key: 'text', label: 'Text', kind: 'textarea' }],
    render(tile, el) {
      el.append(head('note-text-outline', tile.title || 'Notiz'), h('div', { class: 'note-text', style: { marginTop: '8px' } }, tile.text || ''));
    },
  },
  app: {
    label: 'App / Link', icon: 'apps', desc: 'Andere Dienste öffnen oder einbetten (Unraid, Grafana, Frigate …)',
    defaults: { w: 1, h: 1, title: 'App', url: 'http://', mode: 'link', icon: 'web' },
    fields: [
      { key: 'title', label: 'Name', kind: 'text' },
      { key: 'url', label: 'Adresse', kind: 'text' },
      { key: 'icon', label: 'Icon (mdi-Name)', kind: 'text', hint: 'z. B. server, chart-line, cctv, home-assistant, docker' },
      { key: 'mode', label: 'Öffnen als', kind: 'select', options: [['link', 'Neuer Tab'], ['modal', 'Fenster im Dashboard'], ['inline', 'Direkt in der Kachel']] },
      { key: 'check', label: 'Erreichbarkeit prüfen', kind: 'select', options: [['', 'Nein'], ['true', 'Ja (Punkt + Alarm möglich)']] },
      { key: 'color', label: 'Farbe', kind: 'color' },
    ],
    render(tile, el) {
      if (tile.mode === 'inline') {
        el.append(head(tile.icon, tile.title), h('iframe', { src: tile.url, loading: 'lazy', allow: 'fullscreen' }));
        return;
      }
      el.classList.add('clickable', 'on');
      const sv = tile.check && S.services?.[tile.url];
      el.append(head(tile.icon, tile.title, tile.url.replace(/^https?:\/\//, ''),
        sv ? h('span', { class: 'fresh', title: sv.ok ? `erreichbar (${sv.ms} ms)` : 'nicht erreichbar', style: { background: sv.ok ? 'var(--ok)' : 'var(--bad)' } }) : null));
      el.addEventListener('click', () => {
        if (S.editing) return;
        if (tile.mode === 'modal') {
          modal([icon(tile.icon), tile.title], h('iframe', { src: tile.url, allow: 'fullscreen' }), {
            wide: true, actions: () => [h('a', { class: 'btn', href: tile.url, target: '_blank', rel: 'noopener' }, icon('open-in-new'), 'In neuem Tab')],
          });
        } else window.open(tile.url, '_blank', 'noopener');
      });
    },
  },
  meshnode: {
    label: 'Mesh-Node', icon: 'radio-tower', desc: 'Ein Meshtastic-Node mit Telemetrie und Verlauf',
    defaults: { w: 2, h: 2 },
    deps: (t) => ['mesh:' + t.node],
    fields: [{ key: 'node', label: 'Node', kind: 'meshnode' }, { key: 'title', label: 'Eigener Name', kind: 'text' },
      { key: 'metric', label: 'Verlauf', kind: 'select', options: [['temperature', 'Temperatur'], ['battery', 'Akku'], ['humidity', 'Feuchte'], ['voltage', 'Spannung'], ['pressure', 'Luftdruck'], ['chUtil', 'Kanalauslastung'], ['', 'Keiner']] }],
    render(tile, el) {
      const n = S.mesh.nodes.get(tile.node);
      if (!n) return el.append(head('radio-tower', tile.title || tile.node || 'Mesh-Node', 'Noch keine Daten'));
      el.append(head('radio-tower', tile.title || nodeName(n), ago(n.lastSeen),
        h('span', { class: 'fresh', style: { background: freshColor(n.lastSeen) } })));
      const body = h('div', { class: 'tile-body' });
      if (tile.metric && tile.h > 1) {
        const box = h('div', {});
        body.append(box);
        api(`/mesh/history/${encodeURIComponent(n.id)}`).then((hst) => box.replaceChildren(sparkline(hst[tile.metric] || [], { height: Math.max(30, tile.h * 50 - 90) })));
      }
      body.append(h('div', { class: 'node-card', style: { padding: 0, background: 'none', border: 0, cursor: 'default' } }, h('div', { class: 'meta' }, nodeMeta(n))));
      el.append(body);
    },
  },
  meshlist: {
    label: 'Mesh-Übersicht', icon: 'access-point-network', desc: 'Alle Meshtastic-Nodes auf einen Blick',
    defaults: { w: 2, h: 2 },
    deps: () => ['mesh:*'],
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }],
    render(tile, el) {
      const nodes = [...S.mesh.nodes.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      const online = nodes.filter((n) => Date.now() - (n.lastSeen || 0) < 2 * 3600e3).length;
      el.append(head('access-point-network', tile.title || 'Meshtastic', S.mesh.configured ? `${online}/${nodes.length} aktiv (2 h)` : 'MQTT nicht eingerichtet'));
      const list = h('div', { class: 'list', style: { marginTop: '10px' } });
      for (const n of nodes) {
        list.append(h('div', { class: 'list-item' }, h('span', { class: 'fresh', style: { background: freshColor(n.lastSeen) } }),
          h('span', { class: 'grow' }, nodeName(n)),
          h('span', { class: 'val' }, [typeof n.battery === 'number' ? (n.battery > 100 ? '⚡' : n.battery + '%') : '', typeof n.temperature === 'number' ? n.temperature.toFixed(1) + '°' : ''].filter(Boolean).join(' · ') || ago(n.lastSeen))));
      }
      if (!nodes.length) list.append(h('div', { class: 'empty' }, 'Noch keine Nodes empfangen'));
      el.append(list);
    },
  },
  site: {
    label: 'Standort', icon: 'map-marker-radius', desc: 'Sensoren und Nodes eines Standorts',
    defaults: { w: 2, h: 2 },
    deps: (t) => {
      const s = S.sites.find((x) => x.id === t.site);
      return [...(s?.entities || []), 'mesh:*'];
    },
    fields: [{ key: 'site', label: 'Standort', kind: 'site' }],
    render(tile, el) {
      const s = S.sites.find((x) => x.id === tile.site);
      if (!s) return el.append(head('map-marker-radius', 'Standort', 'Im Reiter „Standorte“ anlegen'));
      el.style.setProperty('--tc-rgb', hexToRgb(s.color) || 'var(--accent-rgb)');
      el.append(head(s.icon || 'map-marker-radius', s.name, s.note || ''));
      el.append(siteList(s));
    },
  },
  project: {
    label: 'Projekt', icon: 'hammer-wrench', desc: 'Fortschritt eines Bastelprojekts',
    defaults: { w: 2, h: 1 },
    deps: () => ['projects'],
    fields: [{ key: 'project', label: 'Projekt', kind: 'project' }],
    render(tile, el) {
      const p = S.projects.find((x) => x.id === tile.project);
      if (!p) return el.append(head('hammer-wrench', 'Projekt', 'Kein Projekt gewählt'));
      const open = p.tasks.filter((t) => !t.done).length;
      el.style.setProperty('--tc-rgb', hexToRgb(p.color) || 'var(--accent-rgb)');
      el.classList.add('clickable');
      el.addEventListener('click', () => !S.editing && (location.hash = `#workshop/${p.id}`));
      el.append(head('hammer-wrench', p.name, `${open} offene Aufgaben`),
        h('div', { class: 'tile-body' }, h('div', { style: { height: '6px', borderRadius: '6px', background: 'rgba(255,255,255,.08)', overflow: 'hidden' } },
          h('div', { style: { width: p.progress + '%', height: '100%', background: `rgb(${hexToRgb(p.color) || 'var(--accent-rgb)'})` } }))));
    },
  },
  kopf: {
    label: 'Kopf (lokale KI)', icon: 'robot-outline', desc: 'Status, Kamerabild und Sprachausgabe deiner lokalen KI',
    defaults: { w: 2, h: 2 },
    fields: [{ key: 'camera', label: 'Kamerabild', kind: 'select', options: [['true', 'Anzeigen'], ['false', 'Aus']] }],
    render(tile, el) {
      const sub = h('span', {}, 'lokale KI');
      const chips = h('div', { class: 'tile-row', style: { flexWrap: 'wrap', marginTop: '8px' } });
      el.append(head('robot-outline', 'Kopf', sub));
      if (tile.h > 1) el.append(chips);
      api('/kopf/status').then((st) => {
        const ok = Object.values(st).filter((v) => v === 'ok').length;
        const used = Object.values(st).filter((v) => v !== 'off').length;
        sub.textContent = used ? `${ok}/${used} Dienste erreichbar` : 'nicht eingerichtet';
        chips.replaceChildren(...Object.entries(st).map(([k, v]) =>
          h('span', { class: 'chip ' + (v === 'ok' ? 'ok' : v === 'off' ? '' : 'bad') }, h('span', { class: 'dot' }), k)));
      }).catch(() => {});
      const body = h('div', { class: 'tile-body' });
      if (tile.camera !== 'false' && tile.h > 1 && S.settings.kopfVisionUrl) {
        const img = h('img', { class: 'cam', src: '/api/kopf/snapshot?t=' + Date.now(), onerror: (e) => e.target.remove() });
        body.append(img);
        const iv = setInterval(() => (img.isConnected ? (img.src = '/api/kopf/snapshot?t=' + Date.now()) : clearInterval(iv)), 15000);
      }
      const input = h('input', { class: 'input', placeholder: 'Kopf etwas sagen lassen …', onclick: (e) => e.stopPropagation(),
        onkeydown: (e) => {
          if (e.key !== 'Enter' || !e.target.value) return;
          api('/kopf/speak', { body: { text: e.target.value } }).then(() => toast('Gesprochen')).catch((er) => toast(er.message, true));
          e.target.value = '';
        } });
      body.append(input);
      el.append(body);
    },
  },
  iframe: {
    label: 'Webseite einbetten', icon: 'application-outline', desc: 'Beliebige Seite direkt im Dashboard (z. B. Grafana-Panel)',
    defaults: { w: 3, h: 2, url: '' },
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }, { key: 'url', label: 'Adresse', kind: 'text', hint: 'Manche Seiten verbieten das Einbetten (X-Frame-Options).' }],
    render(tile, el) {
      if (tile.title) el.append(head('application-outline', tile.title));
      el.append(h('iframe', { src: tile.url, loading: 'lazy' }));
    },
  },
  server: {
    label: 'Unraid-Server', icon: 'server', desc: 'CPU, RAM, Array, laufende Container und VMs',
    defaults: { w: 2, h: 1 },
    deps: () => ['unraid'],
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }],
    render(tile, el) {
      el.classList.add('clickable');
      el.addEventListener('click', () => !S.editing && (location.hash = '#server'));
      const u = S.unraid;
      if (!u) {
        el.append(head('server', tile.title || 'Server', S.settings.unraidUrl ? 'Lade …' : 'Unraid-API in den Einstellungen eintragen'));
        return;
      }
      const run = (l) => l.filter((x) => ['RUNNING', 'IDLE'].includes(String(x.state).toUpperCase())).length;
      const cap = u.array?.capacity ? Math.round((Number(u.array.capacity.used) / Number(u.array.capacity.total)) * 100) : null;
      const upd = u.containers.filter((c) => c.update).length;
      const info = `${run(u.containers)}/${u.containers.length} Container · ${run(u.vms)}/${u.vms.length} VMs${upd ? ` · ${upd} Updates` : ''}`;
      if (tile.h < 2) {
        el.append(head('server', tile.title || u.hostname || 'Server', info),
          h('div', { class: 'tile-body' }, h('div', { class: 'mini-nums' },
            h('span', {}, 'CPU ', h('b', {}, Math.round(u.cpu || 0) + ' %')), h('span', {}, 'RAM ', h('b', {}, Math.round(u.mem?.pct || 0) + ' %')), cap != null ? h('span', {}, 'Array ', h('b', {}, cap + ' %')) : null)));
        return;
      }
      el.append(head('server', tile.title || u.hostname || 'Server', info),
        h('div', { class: 'tile-body' }, h('div', { class: 'mini-bars' },
          miniBar('CPU', u.cpu), miniBar('RAM', u.mem?.pct), cap != null ? miniBar('Array', cap) : null)));
    },
  },
  resource: {
    label: 'Container / VM', icon: 'docker', desc: 'Einzelnen Container oder eine VM schalten (z. B. Minecraft-VM)',
    defaults: { w: 1, h: 1, kind: 'container' },
    deps: () => ['unraid'],
    fields: [{ key: 'kind', label: 'Art', kind: 'select', options: [['container', 'Docker-Container'], ['vm', 'VM']] }, { key: 'name', label: 'Name', kind: 'resource' }, { key: 'title', label: 'Eigener Name', kind: 'text' }],
    render(tile, el) {
      const list = tile.kind === 'vm' ? S.unraid?.vms : S.unraid?.containers;
      const item = list?.find((x) => x.name === tile.name);
      const ic = tile.kind === 'vm' ? 'monitor' : 'docker';
      if (!item) return el.append(head(ic, tile.title || tile.name || 'Container/VM', !tile.name ? 'Bearbeiten → Name wählen' : S.unraid ? 'nicht gefunden' : 'Lade …'));
      const onState = ['RUNNING', 'IDLE'].includes(String(item.state).toUpperCase());
      if (onState) el.classList.add('on');
      el.classList.add('clickable');
      el.addEventListener('click', async () => {
        if (S.editing) return;
        const { act } = await import('./server.js');
        if (await act(tile.kind, item, onState ? 'stop' : 'start', onState ? `${item.name} stoppen?` : null)) setTimeout(() => emitUnraidRefresh(), 1500);
      });
      el.append(head(ic, tile.title || item.name, onState ? 'läuft' : 'aus', h('span', { class: 'toggle' + (onState ? ' on' : '') })));
    },
  },
  service: {
    label: 'Dienst-Status', icon: 'lan-check', desc: 'Ist eine Webseite/ein Dienst erreichbar? Mit Verfügbarkeit (24 h)',
    defaults: { w: 1, h: 1, url: 'http://' },
    deps: () => ['services'],
    fields: [{ key: 'title', label: 'Name', kind: 'text' }, { key: 'url', label: 'Adresse', kind: 'text' }, { key: 'icon', label: 'Icon (mdi)', kind: 'text' }],
    render(tile, el) {
      const sv = S.services?.[tile.url];
      if (sv?.ok) el.classList.add('on');
      el.style.setProperty('--tc-rgb', sv && !sv.ok ? '255, 93, 108' : null);
      el.append(head(tile.icon || 'lan-check', tile.title || tile.url, !sv ? 'wird geprüft …' : sv.ok ? `erreichbar · ${sv.ms} ms` : `nicht erreichbar${sv.error ? ' · ' + sv.error : ''}`),
        tile.h > 1 || tile.w > 1 ? h('div', { class: 'tile-body' }, h('div', { class: 'tile-sub' }, sv?.uptime24h != null ? `Verfügbarkeit 24 h: ${sv.uptime24h} %` : '')) : null);
    },
  },
  json: {
    label: 'JSON-API', icon: 'code-json', desc: 'Beliebigen Wert aus einer JSON-Schnittstelle anzeigen (Pi-hole, Plex, eigene APIs …)',
    defaults: { w: 1, h: 1, url: 'http://', path: '', refresh: 60 },
    fields: [
      { key: 'title', label: 'Titel', kind: 'text' }, { key: 'url', label: 'Adresse', kind: 'text' },
      { key: 'path', label: 'Pfad zum Wert', kind: 'text', hint: 'z. B. data.temperature oder items.0.name – mehrere mit Komma' },
      { key: 'unit', label: 'Einheit', kind: 'text' }, { key: 'icon', label: 'Icon (mdi)', kind: 'text' },
      { key: 'headers', label: 'Header (optional)', kind: 'textarea', hint: 'Eine Zeile pro Header, z. B. Authorization: Bearer abc' },
      { key: 'refresh', label: 'Aktualisieren (Sekunden)', kind: 'number' },
    ],
    render(tile, el) {
      const val = h('div', { class: 'tile-value', style: { fontSize: '24px' } }, '…');
      el.append(head(tile.icon || 'code-json', tile.title || 'JSON'), h('div', { class: 'tile-body' }, val));
      const load = () => api('/tile-json/' + tile.id).then((data) => {
        const paths = String(tile.path || '').split(',').map((x) => x.trim()).filter(Boolean);
        const get = (p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
        const vals = paths.length ? paths.map(get) : [data];
        val.replaceChildren(...vals.map((v, i) => h('div', { style: i ? { fontSize: '14px', color: 'var(--muted)' } : null },
          typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v ?? '–'), i === 0 && tile.unit ? h('small', {}, tile.unit) : null)));
      }).catch((e) => { val.textContent = '⚠'; val.title = e.message; });
      load();
      const iv = setInterval(() => (el.isConnected ? load() : clearInterval(iv)), Math.max(10, tile.refresh || 60) * 1000);
    },
  },
  printer: {
    label: '3D-Drucker', icon: 'printer-3d-nozzle', desc: 'Klipper/Moonraker: Fortschritt, Temperaturen, Kamera',
    defaults: { w: 2, h: 2, url: 'http://' },
    fields: [{ key: 'title', label: 'Name', kind: 'text' }, { key: 'url', label: 'Moonraker-Adresse', kind: 'text', hint: 'z. B. http://192.168.188.50:7125' },
      { key: 'camera', label: 'Kamera-Snapshot-URL (optional)', kind: 'text' }, { key: 'apiKey', label: 'API-Key (optional)', kind: 'text' }],
    render(tile, el) {
      const sub = h('span', {}, 'Lade …');
      const body = h('div', { class: 'tile-body' });
      el.append(head('printer-3d-nozzle', tile.title || '3D-Drucker', sub), body);
      const STATES = { printing: 'druckt', standby: 'bereit', paused: 'pausiert', complete: 'fertig', cancelled: 'abgebrochen', error: 'Fehler' };
      const load = () => api('/printer/' + tile.id).then((p) => {
        const pct = Math.round((p.progress || 0) * 100);
        sub.textContent = `${STATES[p.state] || p.state}${p.state === 'printing' ? ` · ${pct} %` : ''}`;
        el.classList.toggle('on', p.state === 'printing');
        const rem = p.remaining ? `${Math.floor(p.remaining / 3600)} h ${Math.round((p.remaining % 3600) / 60)} min` : '';
        body.replaceChildren(
          tile.h > 1 ? h('img', { class: 'cam', src: `/api/printer/${tile.id}/snapshot?t=${Date.now()}`, onerror: (e) => e.target.remove() }) : null,
          p.state === 'printing' ? h('div', { class: 'bar-mini' }, h('div', { style: { width: pct + '%' } })) : null,
          h('div', { class: 'tile-sub' }, [p.file, rem && `noch ${rem}`].filter(Boolean).join(' · ')),
          h('div', { class: 'tile-row', style: { fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--muted)' } },
            `Düse ${p.extruder.temp?.toFixed(0) ?? '–'}/${p.extruder.target?.toFixed(0) ?? '–'} °C · Bett ${p.bed.temp?.toFixed(0) ?? '–'}/${p.bed.target?.toFixed(0) ?? '–'} °C`));
      }).catch((e) => { sub.textContent = e.message; });
      load();
      const iv = setInterval(() => (el.isConnected ? load() : clearInterval(iv)), 15000);
    },
  },
  github: {
    label: 'GitHub', icon: 'github', desc: 'Deine Repos: letzte Änderungen, offene Issues, Projekt dazu',
    defaults: { w: 2, h: 2 },
    deps: () => ['projects'],
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }, { key: 'limit', label: 'Anzahl', kind: 'number' }],
    render(tile, el) {
      const list = h('div', { class: 'list', style: { marginTop: '10px' } }, h('div', { class: 'empty' }, 'Lade …'));
      el.append(head('github', tile.title || 'GitHub'), list);
      api('/github/repos').then(({ repos, error }) => {
        if (!repos.length) return list.replaceChildren(h('div', { class: 'empty' }, error || 'GitHub-Benutzer in den Einstellungen eintragen'));
        list.replaceChildren(...repos.slice(0, tile.limit || 12).map((r) => {
          const p = S.projects.find((x) => x.repo?.toLowerCase() === r.full_name.toLowerCase());
          return h('a', { class: 'list-item', href: p ? `#workshop/${p.id}` : r.html_url, target: p ? null : '_blank', style: { color: 'inherit', textDecoration: 'none' }, onclick: (e) => e.stopPropagation() },
            icon(r.private ? 'lock-outline' : 'source-repository'), h('span', { class: 'grow' }, p?.name || r.name),
            r.open_issues ? h('span', { class: 'chip' }, r.open_issues) : null, h('span', { class: 'val' }, ago(Date.parse(r.pushed_at))));
        }));
      }).catch((e) => list.replaceChildren(h('div', { class: 'empty' }, e.message)));
    },
  },
  alerts: {
    label: 'Alarme', icon: 'bell-alert-outline', desc: 'Aktive Alarme und letzte Meldungen',
    defaults: { w: 2, h: 2 },
    deps: () => ['alerts'],
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }],
    render(tile, el) {
      const list = h('div', { class: 'list', style: { marginTop: '10px' } });
      el.append(head('bell-alert-outline', tile.title || 'Alarme', S.activeAlerts?.length ? `${S.activeAlerts.length} aktiv` : 'alles ruhig'), list);
      if (S.activeAlerts?.length) el.style.setProperty('--tc-rgb', '255, 181, 71'), el.classList.add('on');
      api('/alerts').then((a) => list.replaceChildren(...(a.history.length ? a.history.slice(0, 15).map((x) => h('div', { class: 'list-item' },
        icon(x.level === 'ok' ? 'check-circle-outline' : 'alert-outline'), h('span', { class: 'grow', title: x.text }, x.title), h('span', { class: 'val' }, ago(x.ts))))
        : [h('div', { class: 'empty' }, 'Noch keine Meldungen')])));
    },
  },
  plc: {
    label: 'SPS / Modbus', icon: 'expansion-card', desc: 'Werte einer SPS (S7-1200/1500 via MB_SERVER, LOGO! 8) oder eines Modbus-Geräts, Spulen schaltbar',
    defaults: { w: 2, h: 2, port: 502, unit: 1, signals: [] },
    fields: [
      { key: 'title', label: 'Name', kind: 'text' }, { key: 'host', label: 'IP-Adresse', kind: 'text' },
      { key: 'port', label: 'Port', kind: 'number' }, { key: 'unit', label: 'Unit-ID', kind: 'number' },
      { key: 'signals', label: 'Signale', kind: 'signals', hint: 'Eine Zeile pro Signal: Name; Funktion (1 Spule, 2 Eingang, 3 Holding, 4 Input); Adresse; Typ (u16/i16/u32/i32/f32); Faktor; Einheit; schreibbar (ja/nein)' },
      { key: 'refresh', label: 'Aktualisieren (s)', kind: 'number' },
    ],
    render(tile, el) {
      const list = h('div', { class: 'list', style: { marginTop: '8px' } });
      el.append(head('expansion-card', tile.title || 'SPS', tile.host || 'IP eintragen'), list);
      if (!tile.host || !tile.signals?.length) return list.append(h('div', { class: 'empty' }, 'Bearbeiten → IP und Signale eintragen'));
      const load = () => api('/tile-modbus/' + tile.id).then(({ values }) => {
        list.replaceChildren(...tile.signals.map((sg, i) => {
          const v = values[i];
          const err = v && typeof v === 'object' ? v.error : null;
          const bool = [1, 2].includes(Number(sg.fn));
          return h('div', { class: 'list-item', title: err || '' }, icon(bool ? 'electric-switch' : 'numeric'), h('span', { class: 'grow' }, sg.label),
            err ? h('span', { class: 'val', style: { color: 'var(--bad)' } }, '⚠')
              : bool && sg.writable ? h('button', { class: 'toggle' + (v ? ' on' : ''), onclick: stop(async () => { await api(`/tile-modbus/${tile.id}/write`, { body: { index: i, value: v ? 0 : 1 } }).catch((e) => toast(e.message, true)); load(); }) })
              : h('span', { class: 'val' }, bool ? (v ? 'EIN' : 'AUS') : `${v}${sg.unit ? ' ' + sg.unit : ''}`));
        }));
      }).catch((e) => list.replaceChildren(h('div', { class: 'empty' }, e.message)));
      load();
      const iv = setInterval(() => (el.isConnected ? load() : clearInterval(iv)), Math.max(2, tile.refresh || 5) * 1000);
    },
  },
  chronik: {
    label: 'Chronik', icon: 'timeline-text-outline', desc: 'Die letzten Ereignisse aus Haus, Mesh, Server und Werkstatt',
    defaults: { w: 2, h: 2 },
    deps: () => ['chronik'],
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }, { key: 'source', label: 'Nur', kind: 'select', options: [['', 'Alles'], ['haus', 'Haus'], ['mesh', 'Mesh'], ['server', 'Server'], ['werkstatt', 'Werkstatt'], ['github', 'GitHub'], ['alarm', 'Alarme']] }],
    render(tile, el) {
      el.classList.add('clickable');
      el.addEventListener('click', () => !S.editing && (location.hash = '#chronik'));
      const list = h('div', { class: 'list', style: { marginTop: '10px' } });
      el.append(head('timeline-text-outline', tile.title || 'Chronik'), list);
      api(`/chronik?days=7&limit=20&source=${tile.source || ''}`).then((d) => list.replaceChildren(...(d.entries.length ? d.entries.map((e) =>
        h('div', { class: 'list-item' }, icon(e.icon || 'circle-small'), h('span', { class: 'grow', title: e.detail || '' }, e.title), h('span', { class: 'val' }, new Date(e.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }))))
        : [h('div', { class: 'empty' }, 'Noch nichts passiert')])));
    },
  },
  esphome: {
    label: 'ESPHome-Geräte', icon: 'chip', desc: 'Geräte aus deinem ESPHome-Dashboard',
    defaults: { w: 2, h: 2 },
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }],
    render(tile, el) {
      const list = h('div', { class: 'list', style: { marginTop: '10px' } }, h('div', { class: 'empty' }, 'Lade …'));
      el.append(head('chip', tile.title || 'ESPHome', S.settings.esphomeUrl ? '' : 'Adresse in den Einstellungen eintragen',
        S.settings.esphomeUrl ? h('a', { class: 'btn icon sm', href: S.settings.esphomeUrl, target: '_blank', onclick: (e) => e.stopPropagation() }, icon('open-in-new')) : null), list);
      api('/esphome/devices').then((d) => {
        const devs = d.configured || [];
        list.replaceChildren(...(devs.length ? devs.map((x) => h('div', { class: 'list-item' }, icon('chip'), h('span', { class: 'grow' }, x.friendly),
          x.outdated ? h('span', { class: 'chip warn', title: `installiert ${x.deployed}, aktuell ${x.current}` }, 'Update') : h('span', { class: 'val' }, x.deployed || ''),
          h('span', { class: 'fresh', title: x.online ? 'online' : 'offline', style: { background: x.online ? 'var(--ok)' : x.online === false ? 'var(--bad)' : 'var(--muted)' } })))
          : [h('div', { class: 'empty' }, 'Keine Geräte gefunden')]));
      }).catch((e) => list.replaceChildren(h('div', { class: 'empty' }, e.message)));
    },
  },
};

function miniBar(label, pct) {
  const v = Math.round(pct || 0);
  const c = v >= 90 ? 'var(--bad)' : v >= 75 ? 'var(--warn)' : 'var(--accent)';
  return h('div', { class: 'mini-bar' }, h('span', {}, label), h('div', { class: 'bar-mini' }, h('div', { style: { width: v + '%', background: c } })), h('b', {}, v + ' %'));
}
const emitUnraidRefresh = () => import('./core.js').then((m) => m.emit('unraid-refresh'));

/** Sensorliste eines Standorts (HA-Entitäten + Mesh-Nodes). */
export function siteList(s) {
  const list = h('div', { class: 'list', style: { marginTop: '8px' } });
  for (const id of s.entities || []) {
    const st = ent(id);
    list.append(h('div', { class: 'list-item' }, icon(entityIcon(st)), h('span', { class: 'grow' }, friendly(st, id)), h('span', { class: 'val' }, stateText(st))));
  }
  for (const n of siteNodes(s)) {
    list.append(h('div', { class: 'list-item' }, h('span', { class: 'fresh', style: { background: freshColor(n.lastSeen) } }), h('span', { class: 'grow' }, nodeName(n)),
      h('span', { class: 'val' }, [typeof n.temperature === 'number' && n.temperature.toFixed(1) + ' °C', typeof n.battery === 'number' && (n.battery > 100 ? '⚡' : n.battery + ' %'), ago(n.lastSeen)].filter(Boolean).join(' · '))));
  }
  if (!list.children.length) list.append(h('div', { class: 'empty' }, 'Keine Sensoren zugeordnet'));
  return list;
}

/** Nodes eines Standorts: fest zugeordnet oder innerhalb des Radius. */
export function siteNodes(s) {
  const nodes = [...S.mesh.nodes.values()];
  return nodes.filter((n) => (s.nodes || []).includes(n.id) ||
    (s.autoNodes !== false && n.lat && s.lat && distance(s.lat, s.lon, n.lat, n.lon) <= (s.radius || 200)));
}

export function distance(lat1, lon1, lat2, lon2) {
  const R = 6371e3, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const OPS = { '=': (a, b) => String(a) === String(b), '!=': (a, b) => String(a) !== String(b), '>': (a, b) => Number(a) > Number(b), '<': (a, b) => Number(a) < Number(b) };
/** Bedingung erfüllt? (z. B. „nur zeigen, wenn Waschmaschine = on“) */
export function conditionMet(tile) {
  if (!tile.condEntity) return true;
  const st = ent(tile.condEntity);
  if (!st) return false;
  return (OPS[tile.condOp || '='] || OPS['='])(st.state, tile.condValue ?? 'on');
}

export function renderTile(tile) {
  const type = TILE_TYPES[tile.type] || TILE_TYPES.note;
  const el = h('div', { class: `tile size-${tile.w}x${tile.h}`, 'data-id': tile.id, 'data-w': tile.w, style: { '--w': tile.w, '--h': tile.h } });
  if (tile.color) el.style.setProperty('--tc-rgb', hexToRgb(tile.color));
  if (!conditionMet(tile)) el.classList.add(S.editing ? 'cond-off' : 'cond-hidden');
  try {
    type.render(tile, el);
  } catch (e) {
    console.error(e);
    el.append(head('alert', 'Fehler', e.message));
  }
  return el;
}

export function tileDeps(tile) {
  return [...(TILE_TYPES[tile.type]?.deps?.(tile) || []), ...(tile.condEntity ? [tile.condEntity] : [])];
}
