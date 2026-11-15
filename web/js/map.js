// Karte: Standorte, HA-Zonen/Tracker und Meshtastic-Nodes.
import { S, h, icon, api, on, toast, modal, field, seg, saveLayout, uid, ago, friendly, sparkline, hexToRgb } from './core.js';
import { siteList, siteNodes, nodeName, nodeMeta, freshColor } from './tiles.js';
import { pickEntity, pickMeshNode } from './editor.js';

let leafletReady;
function loadLeaflet() {
  return (leafletReady ||= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css' }));
    const s = h('script', { src: '/vendor/leaflet/leaflet.js' });
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error('Kartenbibliothek konnte nicht geladen werden'));
    document.head.append(s);
  }));
}

const METRIC_LABELS = { temperature: ['Temperatur', '°C'], humidity: ['Feuchte', '%'], pressure: ['Luftdruck', 'hPa'], battery: ['Akku', '%'],
  voltage: ['Spannung', 'V'], chUtil: ['Kanal', '%'], airUtil: ['Airtime', '%'], iaq: ['IAQ', ''], lux: ['Licht', 'lx'], windSpeed: ['Wind', 'm/s'], pm25: ['PM2.5', 'µg'] };

export function renderMap(view, actions) {
  let L, map, layers, pickMode = null, panel = S.mapPanel || 'sites';
  const offs = [];
  const mapEl = h('div', { id: 'map', class: 'dark-tiles' });
  const side = h('div', { class: 'map-side' });
  const fab = h('div', { class: 'map-fab' },
    h('button', { class: 'btn icon', title: 'Alles zeigen', onclick: () => fitAll() }, icon('fit-to-screen-outline')),
    h('button', { class: 'btn icon', title: 'Mein Standort', onclick: () => locate((lat, lon) => map.setView([lat, lon], 15)) }, icon('crosshairs-gps')));
  const wrap = h('div', { class: 'map-wrap' }, h('div', { style: { position: 'relative', flex: 1, display: 'flex' } }, mapEl, fab), side);
  view.append(wrap);
  actions.append(h('button', { class: 'btn', onclick: () => editSite() }, icon('plus'), 'Standort'));

  loadLeaflet().then((lib) => {
    if (!mapEl.isConnected) return;
    L = lib;
    map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([51.16, 10.45], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    layers = { sites: L.layerGroup().addTo(map), ha: L.layerGroup().addTo(map), mesh: L.layerGroup().addTo(map), links: L.layerGroup().addTo(map), track: L.layerGroup().addTo(map) };
    L.control.layers(null, { Standorte: layers.sites, 'HA-Zonen & Personen': layers.ha, 'Mesh-Nodes': layers.mesh, 'Mesh-Verbindungen': layers.links }, { position: 'topright' }).addTo(map);
    map.on('click', (e) => { if (pickMode) { pickMode(e.latlng.lat, e.latlng.lng); pickMode = null; hint.remove(); } });
    drawAll();
    fitAll();
    setTimeout(() => map.invalidateSize(), 50);
  }).catch((e) => mapEl.replaceChildren(h('div', { class: 'empty' }, e.message)));

  const hint = h('div', { class: 'pick-hint chip ok' }, h('span', { class: 'dot' }), 'In die Karte tippen, um die Position zu setzen');

  // ---------- Zeichnen ----------
  function drawAll() {
    if (!map) return;
    drawSites();
    drawHa();
    drawMesh();
  }

  function drawSites() {
    layers.sites.clearLayers();
    for (const s of S.sites) {
      if (!s.lat) continue;
      const c = s.color || '#00d8ff';
      L.circle([s.lat, s.lon], { radius: s.radius || 200, color: c, weight: 1.5, fillOpacity: 0.08, dashArray: '4 4' }).addTo(layers.sites);
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', iconSize: null, iconAnchor: [12, 30],
        html: `<div class="mesh-pin" style="--c:${c}"><div class="b"><i class="mdi mdi-${s.icon || 'home-map-marker'}"></i> ${escape(s.name)}</div><div class="p"></div><div class="d"></div></div>` }) })
        .addTo(layers.sites).bindPopup(() => sitePopup(s));
    }
  }

  function drawHa() {
    layers.ha.clearLayers();
    for (const st of S.states.values()) {
      const a = st.attributes;
      if (typeof a.latitude !== 'number') continue;
      const d = st.entity_id.split('.')[0];
      if (d === 'zone') {
        if (a.passive) continue;
        L.circle([a.latitude, a.longitude], { radius: a.radius || 100, color: '#8a7dff', weight: 1, fillOpacity: 0.06 }).addTo(layers.ha).bindTooltip(friendly(st));
      } else if (['person', 'device_tracker'].includes(d)) {
        L.marker([a.latitude, a.longitude], { icon: L.divIcon({ className: '', iconSize: null, iconAnchor: [12, 30],
          html: `<div class="mesh-pin" style="--c:#ffb547"><div class="b"><i class="mdi mdi-${d === 'person' ? 'account' : 'cellphone'}"></i> ${escape(friendly(st))}</div><div class="p"></div><div class="d"></div></div>` }) })
          .addTo(layers.ha).bindPopup(`<b>${escape(friendly(st))}</b><br>${escape(st.state)} · ${ago(Date.parse(st.last_updated))}${a.gps_accuracy ? `<br>Genauigkeit ${a.gps_accuracy} m` : ''}`);
      }
    }
  }

  const nodeMarkers = new Map();
  function drawMesh() {
    layers.mesh.clearLayers();
    layers.links.clearLayers();
    nodeMarkers.clear();
    for (const n of S.mesh.nodes.values()) {
      if (!n.lat) continue;
      const c = freshColor(n.lastSeen).replace('var(--ok)', '#3ddc97').replace('var(--warn)', '#ffb547').replace('var(--bad)', '#ff5d6c');
      const m = L.marker([n.lat, n.lon], { icon: L.divIcon({ className: '', iconSize: null, iconAnchor: [14, 30],
        html: `<div class="mesh-pin" style="--c:${c}"><div class="b">${escape(n.shortName || n.id.slice(-4))}</div><div class="p"></div><div class="d"></div></div>` }) })
        .addTo(layers.mesh).bindPopup(() => nodePopup(n.id));
      nodeMarkers.set(n.id, m);
    }
    for (const n of S.mesh.nodes.values()) {
      for (const nb of n.neighbors || []) {
        const o = S.mesh.nodes.get(nb.id);
        if (!n.lat || !o?.lat || n.id > nb.id) continue;
        const col = nb.snr > 5 ? '#3ddc97' : nb.snr > -5 ? '#ffb547' : '#ff5d6c';
        L.polyline([[n.lat, n.lon], [o.lat, o.lon]], { color: col, weight: 1.5, opacity: 0.7, dashArray: '6 6' }).addTo(layers.links).bindTooltip(`SNR ${nb.snr} dB`);
      }
    }
  }

  function fitAll() {
    if (!map) return;
    const pts = [...S.sites.filter((s) => s.lat).map((s) => [s.lat, s.lon]), ...[...S.mesh.nodes.values()].filter((n) => n.lat).map((n) => [n.lat, n.lon]),
      ...[...S.states.values()].filter((s) => typeof s.attributes.latitude === 'number' && !s.attributes.passive).map((s) => [s.attributes.latitude, s.attributes.longitude])];
    if (pts.length === 1) map.setView(pts[0], 14);
    else if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }

  // ---------- Popups ----------
  function sitePopup(s) {
    return h('div', {}, h('b', {}, s.name), s.note ? h('div', { class: 'tile-sub' }, s.note) : null, siteList(s),
      h('div', { class: 'tile-row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: () => editSite(s) }, icon('pencil'), 'Bearbeiten')));
  }

  function nodePopup(id) {
    const n = S.mesh.nodes.get(id);
    return h('div', {}, h('b', {}, nodeName(n)), h('div', { class: 'tile-sub' }, `${n.id}${n.shortName ? ' · ' + n.shortName : ''} · ${ago(n.lastSeen)}`),
      h('div', { class: 'node-card', style: { padding: 0, background: 'none', border: 0 } }, h('div', { class: 'meta' }, nodeMeta(n))),
      h('div', { class: 'tile-row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: () => nodeDetail(id) }, icon('chart-line'), 'Details')));
  }

  async function nodeDetail(id) {
    const n = S.mesh.nodes.get(id);
    const hist = await api(`/mesh/history/${encodeURIComponent(id)}`).catch(() => ({}));
    const charts = h('div', { class: 'charts' }, Object.entries(hist).filter(([k, v]) => k !== 'track' && v.length > 1).map(([k, v]) => {
      const [label, unit] = METRIC_LABELS[k] || [k, ''];
      return h('div', { class: 'chart-box' }, h('div', { class: 'lbl' }, label, h('b', {}, `${Math.round(v.at(-1)[1] * 10) / 10} ${unit}`)), sparkline(v, { height: 50 }));
    }));
    const alias = h('input', { class: 'input', value: n.alias || '', placeholder: n.longName || '' });
    const track = hist.track?.length > 1;
    modal([icon('radio-tower'), nodeName(n)], h('div', {},
      h('div', { class: 'tile-sub', style: { marginBottom: '10px' } }, [n.id, n.hw !== undefined && `HW ${n.hw}`, n.via && `über ${n.via}`, `zuletzt ${ago(n.lastSeen)}`, n.lat && `${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}`, n.alt !== undefined && `${n.alt} m`].filter(Boolean).join(' · ')),
      field('Eigener Name', alias),
      h('div', { class: 'node-card', style: { background: 'none', border: 0, padding: 0 } }, h('div', { class: 'meta' }, nodeMeta(n))),
      charts.children.length ? charts : h('div', { class: 'empty' }, 'Noch kein Verlauf – kommt mit der nächsten Telemetrie.')), {
      actions: (close) => [
        h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Node vergessen?')) return; await api(`/mesh/node/${encodeURIComponent(id)}`, { method: 'DELETE' }); S.mesh.nodes.delete(id); close(); drawMesh(); drawSide(); } }, icon('delete-outline')),
        track ? h('button', { class: 'btn', onclick: () => { close(); showTrack(hist.track); } }, icon('map-marker-path'), 'Spur') : null,
        h('button', { class: 'btn primary', onclick: async () => {
          await api(`/mesh/node/${encodeURIComponent(id)}`, { method: 'PUT', body: { alias: alias.value } });
          n.alias = alias.value; close(); drawSide(); drawMesh();
        } }, 'Speichern')],
    });
  }

  function showTrack(track) {
    layers.track.clearLayers();
    const pts = track.map(([, p]) => p);
    L.polyline(pts, { color: '#00d8ff', weight: 2 }).addTo(layers.track);
    map.fitBounds(pts, { padding: [40, 40] });
  }

  // ---------- Standort-Editor ----------
  function locate(cb) {
    if (!navigator.geolocation) return toast('Standort im Browser nicht verfügbar', true);
    navigator.geolocation.getCurrentPosition((p) => cb(p.coords.latitude, p.coords.longitude),
      (e) => toast('Standort nicht verfügbar: ' + e.message + (location.protocol !== 'https:' ? ' (HTTPS nötig)' : ''), true), { enableHighAccuracy: true, timeout: 10000 });
  }

  function editSite(orig) {
    const s = structuredClone(orig || { id: uid(), name: '', color: '#00d8ff', icon: 'home-map-marker', radius: 200, entities: [], nodes: [], autoNodes: true });
    const lat = h('input', { class: 'input', type: 'number', step: 'any', value: s.lat ?? '', oninput: (e) => (s.lat = Number(e.target.value)) });
    const lon = h('input', { class: 'input', type: 'number', step: 'any', value: s.lon ?? '', oninput: (e) => (s.lon = Number(e.target.value)) });
    const setPos = (a, b) => { s.lat = +a.toFixed(6); s.lon = +b.toFixed(6); lat.value = s.lat; lon.value = s.lon; };
    const ents = h('div', { class: 'tagline' });
    const drawEnts = () => ents.replaceChildren(...s.entities.map((id, i) => h('span', { class: 'tag' }, friendly(S.states.get(id), id), h('button', { type: 'button', onclick: () => { s.entities.splice(i, 1); drawEnts(); } }, '×'))),
      h('button', { type: 'button', class: 'btn sm', onclick: async () => { const r = await pickEntity({ multiple: true, selected: s.entities }); if (r) { s.entities = r; drawEnts(); } } }, icon('plus'), 'Entitäten'));
    const nodes = h('div', { class: 'tagline' });
    const drawNodes = () => nodes.replaceChildren(...s.nodes.map((id, i) => h('span', { class: 'tag' }, nodeName(S.mesh.nodes.get(id)) || id, h('button', { type: 'button', onclick: () => { s.nodes.splice(i, 1); drawNodes(); } }, '×'))),
      h('button', { type: 'button', class: 'btn sm', onclick: async () => { const r = await pickMeshNode(); if (r && !s.nodes.includes(r)) { s.nodes.push(r); drawNodes(); } } }, icon('plus'), 'Node'));
    drawEnts();
    drawNodes();
    let saved = false;
    const close = modal([icon('map-marker-radius'), orig ? 'Standort bearbeiten' : 'Neuer Standort'], h('div', {},
      h('div', { class: 'row' }, field('Name', h('input', { class: 'input', value: s.name, placeholder: 'z. B. Gartenhaus, Werkstatt, Eltern', oninput: (e) => (s.name = e.target.value) })),
        field('Farbe', h('input', { class: 'input', type: 'color', value: s.color, style: { height: '42px', padding: '4px' }, oninput: (e) => (s.color = e.target.value) }))),
      h('div', { class: 'row' }, field('Icon (mdi)', h('input', { class: 'input', value: s.icon, oninput: (e) => (s.icon = e.target.value) })),
        field('Radius (m)', h('input', { class: 'input', type: 'number', value: s.radius, oninput: (e) => (s.radius = Number(e.target.value)) }))),
      field('Notiz', h('input', { class: 'input', value: s.note || '', oninput: (e) => (s.note = e.target.value) })),
      h('div', { class: 'row' }, field('Breitengrad', lat), field('Längengrad', lon)),
      h('div', { class: 'row', style: { marginBottom: '12px' } },
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); pickMode = (a, b) => { setPos(a, b); reopen(); }; mapEl.parentElement.append(hint); } }, icon('map-marker-plus'), 'Auf Karte wählen'),
        h('button', { type: 'button', class: 'btn', onclick: () => locate(setPos) }, icon('crosshairs-gps'), 'Mein Standort')),
      field('Home-Assistant-Sensoren', ents),
      field('Mesh-Nodes', nodes, 'Nodes im Radius werden automatisch zugeordnet.'),
      h('label', { class: 'row', style: { alignItems: 'center', gap: '8px' } }, h('input', { type: 'checkbox', checked: s.autoNodes !== false, onchange: (e) => (s.autoNodes = e.target.checked), style: { flex: 'none' } }), 'Nodes im Radius automatisch zuordnen')), {
      actions: (c) => [
        orig ? h('button', { class: 'btn danger', onclick: () => { if (!confirm('Standort löschen?')) return; S.sites = S.sites.filter((x) => x.id !== s.id); saveLayout(); saved = true; c(); drawAll(); drawSide(); } }, icon('delete-outline')) : null,
        h('button', { class: 'btn primary', onclick: () => {
          if (!s.name) return toast('Bitte einen Namen eingeben', true);
          const i = S.sites.findIndex((x) => x.id === s.id);
          i >= 0 ? (S.sites[i] = s) : S.sites.push(s);
          saveLayout(); saved = true; c(); drawAll(); drawSide();
          if (s.lat && map) map.setView([s.lat, s.lon], 15);
        } }, 'Speichern')],
    });
    function reopen() { editSite(Object.assign(orig ? structuredClone(orig) : {}, s)); }
  }

  // ---------- Seitenleiste ----------
  function drawSide() {
    const body = h('div', { class: 'side-body' });
    let footer = null;
    if (panel === 'sites') {
      if (!S.sites.length) body.append(h('div', { class: 'empty' }, 'Noch keine Standorte. Lege z. B. Zuhause, Garten oder andere Orte an, von denen du Daten empfängst.'));
      for (const s of S.sites) {
        const nodes = siteNodes(s);
        const online = nodes.filter((n) => Date.now() - (n.lastSeen || 0) < 2 * 3600e3).length;
        body.append(h('div', { class: 'site-card', style: { '--tc-rgb': hexToRgb(s.color) } },
          h('h4', {}, h('span', { class: 'sw', style: { background: s.color } }), s.name, h('span', { class: 'spacer' }),
            nodes.length ? h('span', { class: 'chip' }, `${online}/${nodes.length} Nodes`) : null,
            h('button', { class: 'btn icon sm', title: 'Zeigen', onclick: () => s.lat && map?.setView([s.lat, s.lon], 16) }, icon('crosshairs')),
            h('button', { class: 'btn icon sm', title: 'Bearbeiten', onclick: () => editSite(s) }, icon('pencil'))),
          s.note ? h('div', { class: 'tile-sub' }, s.note) : null, siteList(s)));
      }
    } else if (panel === 'mesh') {
      const nodes = [...S.mesh.nodes.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      if (!S.mesh.configured) body.append(h('div', { class: 'empty' }, 'MQTT-Broker in den Einstellungen eintragen, damit Meshtastic-Daten ankommen.'));
      else if (!nodes.length) body.append(h('div', { class: 'empty' }, 'Verbunden – warte auf erste Pakete. JSON-Ausgabe im MQTT-Modul des Nodes aktiviert?'));
      for (const n of nodes) {
        body.append(h('div', { class: 'node-card', onclick: () => {
          const m = nodeMarkers.get(n.id);
          if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 14)); m.openPopup(); } else nodeDetail(n.id);
        } }, h('div', { class: 'top' }, h('span', { class: 'fresh', style: { background: freshColor(n.lastSeen) } }),
          h('b', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, nodeName(n)),
          n.shortName ? h('span', { class: 'short' }, n.shortName) : null, h('span', { class: 'tile-sub' }, ago(n.lastSeen))),
        h('div', { class: 'meta' }, nodeMeta(n), n.lat ? null : h('span', {}, icon('map-marker-off'), ' keine Position'))));
      }
    } else {
      const msgs = h('div', { class: 'msgs' });
      for (const m of S.mesh.messages.slice(-150)) {
        const from = S.mesh.nodes.get(m.from);
        msgs.append(h('div', { class: 'msg' }, h('div', { class: 'from' }, h('span', {}, nodeName(from) || m.from), m.to !== 'all' ? h('span', {}, '→ ' + (nodeName(S.mesh.nodes.get(m.to)) || m.to)) : null,
          h('span', {}, new Date(m.time).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))), m.text));
      }
      if (!S.mesh.messages.length) msgs.append(h('div', { class: 'empty' }, 'Noch keine Nachrichten'));
      body.append(msgs);
      setTimeout(() => (msgs.scrollTop = msgs.scrollHeight));
      const to = h('select', { class: 'input', style: { flex: '0 0 110px' } }, h('option', { value: 'all' }, 'Alle'),
        [...S.mesh.nodes.values()].map((n) => h('option', { value: n.id }, nodeName(n))));
      const text = h('input', { class: 'input', placeholder: 'Nachricht ins Mesh …', maxlength: 200 });
      const send = async () => {
        if (!text.value) return;
        try { await api('/mesh/send', { body: { text: text.value, to: to.value } }); toast('Gesendet'); text.value = ''; } catch (e) { toast(e.message, true); }
      };
      text.onkeydown = (e) => e.key === 'Enter' && send();
      footer = h('div', { class: 'send-row' }, to, text, h('button', { class: 'btn primary icon', onclick: send }, icon('send')));
    }
    side.replaceChildren(...[seg([['sites', 'Standorte'], ['mesh', 'Mesh'], ['msgs', 'Nachrichten']], panel, (v) => { panel = S.mapPanel = v; drawSide(); }), body, footer].filter(Boolean));
  }
  drawSide();

  let t;
  const later = (fn) => { clearTimeout(t); t = setTimeout(fn, 400); };
  offs.push(
    on('mesh-node', () => later(() => { drawMesh(); drawSide(); })),
    on('mesh-text', () => panel === 'msgs' && drawSide()),
    on('state', ({ entity_id }) => {
      if (S.sites.some((s) => s.entities?.includes(entity_id)) && panel === 'sites') later(drawSide);
      if (/^(person|device_tracker|zone)\./.test(entity_id)) later(drawHa);
    }),
  );
  return () => { offs.forEach((o) => o()); map?.remove(); };
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
