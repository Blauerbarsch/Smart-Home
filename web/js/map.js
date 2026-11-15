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
  let L, map, layers, pickMode = null, panel = S.mapPanel || 'sites', dmTo = 'all', anaHours = 24;
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
    api('/mesh/links?days=3').then((links) => {
      layers.links.clearLayers();
      const best = new Map();
      for (const l of links) { const k = l.a + l.b; if (!best.has(k) || (l.snr ?? -99) > (best.get(k).snr ?? -99)) best.set(k, l); }
      for (const l of best.values()) {
        const A = S.mesh.nodes.get(l.a), B = S.mesh.nodes.get(l.b);
        if (!A?.lat || !B?.lat) continue;
        const col = l.snr == null ? '#8193a8' : l.snr > 5 ? '#3ddc97' : l.snr > -5 ? '#ffb547' : '#ff5d6c';
        const km = (distKm(A.lat, A.lon, B.lat, B.lon)).toFixed(1);
        L.polyline([[A.lat, A.lon], [B.lat, B.lon]], { color: col, weight: 2, opacity: 0.75, dashArray: l.source === 'trace' ? '2 6' : '6 6' })
          .addTo(layers.links).bindTooltip(`${nodeName(A)} ↔ ${nodeName(B)} · ${km} km${l.snr != null ? ` · SNR ${l.snr} dB` : ''} · ${({ neighbor: 'Nachbar-Info', heard: 'direkt gehört', trace: 'Traceroute' })[l.source] || l.source}`);
      }
    }).catch(() => {});
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
    return h('div', {}, h('b', {}, nodeName(n)), h('div', { class: 'tile-sub' }, [n.id, n.shortName, n.hwName, n.role, ago(n.lastSeen)].filter(Boolean).join(' · ')),
      h('div', { class: 'node-card', style: { padding: 0, background: 'none', border: 0 } }, h('div', { class: 'meta' }, nodeMeta(n))),
      h('div', { class: 'tile-row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: () => nodeDetail(id) }, icon('chart-line'), 'Details'),
        h('button', { class: 'btn sm', onclick: () => { dmTo = id; panel = S.mapPanel = 'msgs'; drawSide(); } }, icon('message-text-outline'), 'Nachricht')));
  }

  async function nodeDetail(id) {
    const n = S.mesh.nodes.get(id);
    const hist = await api(`/mesh/history/${encodeURIComponent(id)}?days=7`).catch(() => ({}));
    const charts = h('div', { class: 'charts' }, Object.entries(hist).filter(([k, v]) => k !== 'track' && v.length > 1).map(([k, v]) => {
      const [label, unit] = METRIC_LABELS[k] || [k, ''];
      return h('div', { class: 'chart-box' }, h('div', { class: 'lbl' }, label, h('b', {}, `${Math.round(v.at(-1)[1] * 10) / 10} ${unit}`)), sparkline(v, { height: 50 }));
    }));
    const alias = h('input', { class: 'input', value: n.alias || '', placeholder: n.longName || '' });
    const track = hist.track?.length > 1;
    modal([icon('radio-tower'), nodeName(n)], h('div', {},
      h('div', { class: 'tile-sub', style: { marginBottom: '10px' } }, [n.id, n.hwName || (n.hw !== undefined && `HW ${n.hw}`), n.role, n.firmware && `FW ${n.firmware}`, n.source === 'mqtt' ? 'über MQTT' : 'per Funk', n.via && `Gateway ${nodeName(S.mesh.nodes.get(n.via)) || n.via}`, `zuletzt ${ago(n.lastSeen)}`, n.lat && `${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}`, n.alt !== undefined && `${n.alt} m`].filter(Boolean).join(' · ')),
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

  // ---------- Netz-Analyse ----------
  async function drawAnalysis(body) {
    body.append(h('div', { class: 'empty' }, 'Lade Statistik …'));
    let a;
    try { a = await api('/mesh/analysis?hours=' + anaHours); } catch (e) { return body.replaceChildren(h('div', { class: 'empty' }, e.message)); }
    const nn = (id) => nodeName(S.mesh.nodes.get(id)) || id;
    const barList = (entries, fmt = (v) => v) => {
      const max = Math.max(1, ...entries.map(([, v]) => v));
      return h('div', { class: 'ana-bars' }, entries.map(([k, v]) => h('div', { class: 'ana-bar' }, h('span', {}, k), h('div', { class: 'bar-mini' }, h('div', { style: { width: (v / max) * 100 + '%' } })), h('b', {}, fmt(v)))));
    };
    const rf = a.source.rf || 0, mq = a.source.mqtt || 0;
    body.replaceChildren(
      seg([[24, '24 h'], [168, '7 Tage'], [720, '30 Tage']], anaHours, (v) => { anaHours = v; drawSide(); }),
      h('div', { class: 'ana-kpis' },
        kpi('Pakete', a.total), kpi('Aktive Nodes', `${a.active}/${a.nodes}`),
        kpi('per Funk empfangen', `${rf ? Math.round((rf / (rf + mq)) * 100) : 0} %`), kpi('Entschlüsselt', a.counters.packets ? `${Math.round(((a.counters.decoded + a.counters.json) / a.counters.packets) * 100)} %` : '–')),
      a.perTime.length > 1 ? h('div', { class: 'site-card' }, h('h4', {}, 'Pakete pro ' + (anaHours <= 24 ? 'Stunde' : '6 Stunden')), sparkline(a.perTime, { height: 60 })) : null,
      h('div', { class: 'site-card' }, h('h4', {}, 'Pakettypen'), barList(Object.entries(a.byPort).map(([k, v]) => [PORT_DE[k] || k, v]))),
      Object.keys(a.hops).length ? h('div', { class: 'site-card' }, h('h4', {}, 'Hops bis zum Gateway'), barList(Object.entries(a.hops).map(([k, v]) => [k === '0' ? 'direkt' : k + ' Hop' + (k === '1' ? '' : 's'), v]))) : null,
      a.chUtil.length ? h('div', { class: 'site-card' }, h('h4', {}, 'Kanalauslastung (Ø / max)'), barList(a.chUtil.map((c) => [nn(c.node), c.avg]), (v) => v.toFixed(1) + ' %')) : null,
      a.byNode.length ? h('div', { class: 'site-card' }, h('h4', {}, 'Gesprächigste Nodes'), barList(a.byNode.map((x) => [nn(x.node), x.n]))) : null,
      a.gateways.length ? h('div', { class: 'site-card' }, h('h4', {}, 'Gateways'), barList(a.gateways.map((g) => [nn(g.gateway), g.n]))) : null,
      a.longestLinks.length ? h('div', { class: 'site-card' }, h('h4', {}, 'Längste Verbindungen'), h('div', { class: 'list' }, a.longestLinks.map((l) => h('div', { class: 'list-item', style: { cursor: 'pointer' }, onclick: () => {
        const A = S.mesh.nodes.get(l.a), B = S.mesh.nodes.get(l.b);
        if (A?.lat && B?.lat) map.fitBounds([[A.lat, A.lon], [B.lat, B.lon]], { padding: [60, 60] });
      } }, h('span', { class: 'grow' }, `${nn(l.a)} ↔ ${nn(l.b)}`), h('span', { class: 'val' }, `${(l.dist / 1000).toFixed(1)} km${l.snr != null ? ' · ' + l.snr + ' dB' : ''}`))))) : null,
      h('div', { class: 'site-card' }, h('h4', {}, 'Traceroutes'), h('div', { class: 'list', id: 'traces' }, h('div', { class: 'empty' }, '…'))),
    );
    api('/mesh/traces').then((ts) => {
      const box = body.querySelector('#traces');
      if (!box) return;
      box.replaceChildren(...(ts.length ? ts.slice(0, 15).map((t) => h('div', { class: 'list-item', style: { flexDirection: 'column', alignItems: 'flex-start', cursor: 'pointer' }, onclick: () => {
        const pts = [t.from, ...t.route, t.to].map((id) => S.mesh.nodes.get(id)).filter((n) => n?.lat).map((n) => [n.lat, n.lon]);
        layers.track.clearLayers();
        if (pts.length > 1) { L.polyline(pts, { color: '#a78bfa', weight: 3 }).addTo(layers.track); map.fitBounds(pts, { padding: [50, 50] }); }
      } }, h('div', {}, [t.from, ...t.route, t.to].map(nn).join(' → ')), h('small', { class: 'tile-sub' }, `${ago(t.ts)} · SNR ${t.snr.join(' / ')} dB`)))
        : [h('div', { class: 'empty' }, 'Noch keine. Starte in der Meshtastic-App einen Traceroute – das Ergebnis erscheint hier.')]));
    });
  }
  const kpi = (k, v) => h('div', { class: 'ana-kpi' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));

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
    } else if (panel === 'analysis') {
      drawAnalysis(body);
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
      const to = h('select', { class: 'input', style: { flex: '0 0 110px' }, onchange: (e) => (dmTo = e.target.value) }, h('option', { value: 'all' }, 'Alle'),
        [...S.mesh.nodes.values()].map((n) => h('option', { value: n.id, selected: dmTo === n.id }, nodeName(n))));
      const text = h('input', { class: 'input', placeholder: 'Nachricht ins Mesh …', maxlength: 200 });
      const send = async () => {
        if (!text.value) return;
        try { await api('/mesh/send', { body: { text: text.value, to: to.value } }); toast('Gesendet'); text.value = ''; } catch (e) { toast(e.message, true); }
      };
      text.onkeydown = (e) => e.key === 'Enter' && send();
      footer = h('div', { class: 'send-row' }, to, text, h('button', { class: 'btn primary icon', onclick: send }, icon('send')));
    }
    side.replaceChildren(...[seg([['sites', 'Orte'], ['mesh', 'Mesh'], ['msgs', 'Chat'], ['analysis', 'Analyse']], panel, (v) => { panel = S.mapPanel = v; drawSide(); }), body, footer].filter(Boolean));
  }
  drawSide();

  let t;
  const later = (fn) => { clearTimeout(t); t = setTimeout(fn, 400); };
  offs.push(
    on('mesh-node', () => later(() => { drawMesh(); drawSide(); })),
    on('mesh-text', () => panel === 'msgs' && drawSide()),
    on('mesh-trace', () => panel === 'analysis' && drawSide()),
    on('state', ({ entity_id }) => {
      if (S.sites.some((s) => s.entities?.includes(entity_id)) && panel === 'sites') later(drawSide);
      if (/^(person|device_tracker|zone)\./.test(entity_id)) later(drawHa);
    }),
  );
  return () => { offs.forEach((o) => o()); map?.remove(); };
}

function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
const PORT_DE = { telemetry: 'Telemetrie', position: 'Position', nodeinfo: 'Node-Info', text: 'Nachrichten', traceroute: 'Traceroute', neighborinfo: 'Nachbarn', mapreport: 'Map-Report', routing: 'Routing', encrypted: 'verschlüsselt', waypoint: 'Wegpunkt', rangetest: 'Reichweitentest', storeforward: 'Store&Forward', paxcounter: 'Paxcounter' };

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
